import { DefaultPlayerEvents } from '../enums/DefaultPlayerEvents';
import { EventEmitter, EmitterRelay } from '../modules/eventemitter';
import { VideoUtils } from '../utils/VideoUtils';
import { VideoSource } from '../VideoSource';

interface HLSFragment {
  url: string;
  duration: number;
  start: number;
  end: number;
}

interface HLSLevel {
  url: string;
  bandwidth: number;
  width: number;
  height: number;
  fragments: HLSFragment[];
}

/**
 * HLS player that fetches M3U8 manifests and uses byte-range requests
 * for fragment-based playback via MSE.
 */
export class HLSPlayer extends EventEmitter {
  video: HTMLVideoElement;
  private source: VideoSource | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private levels: HLSLevel[] = [];
  private currentLevel = 0;
  private running = false;
  private _duration = 0;
  private currentFragmentIndex = 0;
  private mainLoopTimer: number | null = null;

  constructor(_client: { options: any }) {
    super();
    this.video = document.createElement('video');
  }

  load(): void {}

  async setup(): Promise<void> {
    const preEvents = new EventEmitter();
    const emitterRelay = new EmitterRelay([preEvents, this]);
    VideoUtils.addPassthroughEventListenersToVideo(this.video, emitterRelay);
  }

  getVideo(): HTMLVideoElement {
    return this.video;
  }

  async setSource(source: VideoSource): Promise<void> {
    this.source = source;
    this.running = true;

    try {
      // Fetch master playlist
      const masterPlaylist = await this.fetchPlaylist(source.url);
      this.levels = this.parseMasterPlaylist(masterPlaylist, source.url);

      if (this.levels.length === 0) {
        throw new Error('No levels found in HLS manifest');
      }

      // Fetch media playlist for selected level
      const mediaPlaylist = await this.fetchPlaylist(this.levels[this.currentLevel].url);
      this.levels[this.currentLevel].fragments = this.parseMediaPlaylist(mediaPlaylist, this.levels[this.currentLevel].url);

      // Calculate duration
      this._duration = this.levels[this.currentLevel].fragments.reduce((sum, f) => sum + f.duration, 0);

      // Set up MSE
      this.mediaSource = new MediaSource();
      this.video.src = URL.createObjectURL(this.mediaSource);

      this.mediaSource.addEventListener('sourceopen', () => {
        this.onSourceOpen();
      });

      this.video.addEventListener('loadedmetadata', () => {
        this.emit(DefaultPlayerEvents.LOADED_METADATA);
      });

      this.video.addEventListener('canplay', () => {
        this.emit(DefaultPlayerEvents.CAN_PLAY);
      });
    } catch (e) {
      console.error('HLSPlayer setup failed:', e);
      this.emit(DefaultPlayerEvents.ERROR, e);
    }
  }

  private async fetchPlaylist(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch playlist: ${response.status}`);
    }
    return response.text();
  }

  private parseMasterPlaylist(content: string, baseUrl: string): HLSLevel[] {
    const levels: HLSLevel[] = [];
    const lines = content.split('\n');
    let currentBandwidth = 0;
    let currentWidth = 0;
    let currentHeight = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
        const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);

        if (bandwidthMatch) {
          currentBandwidth = parseInt(bandwidthMatch[1], 10);
        }
        if (resolutionMatch) {
          currentWidth = parseInt(resolutionMatch[1], 10);
          currentHeight = parseInt(resolutionMatch[2], 10);
        }
      } else if (line && !line.startsWith('#')) {
        // This is the URI for the level
        const url = new URL(line, baseUrl).href;
        levels.push({
          url,
          bandwidth: currentBandwidth,
          width: currentWidth,
          height: currentHeight,
          fragments: [],
        });
      }
    }

    return levels;
  }

  private parseMediaPlaylist(content: string, baseUrl: string): HLSFragment[] {
    const fragments: HLSFragment[] = [];
    const lines = content.split('\n');
    let currentDuration = 0;
    let currentTime = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('#EXTINF:')) {
        const match = trimmed.match(/#EXTINF:([\d.]+)/);
        if (match) {
          currentDuration = parseFloat(match[1]);
        }
      } else if (trimmed && !trimmed.startsWith('#')) {
        const url = new URL(trimmed, baseUrl).href;
        fragments.push({
          url,
          duration: currentDuration,
          start: currentTime,
          end: currentTime + currentDuration,
        });
        currentTime += currentDuration;
        currentDuration = 0;
      }
    }

    return fragments;
  }

  private onSourceOpen(): void {
    if (!this.mediaSource || !this.source) return;

    try {
      // Use a generic codec that most browsers support
      const mimeType = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
      if (MediaSource.isTypeSupported(mimeType)) {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
        this.sourceBuffer.addEventListener('updateend', () => {
          this.onSourceBufferUpdateEnd();
        });
      }

      // Start fetching fragments
      this.fetchNextFragment();
    } catch (e) {
      console.error('HLS SourceBuffer setup failed:', e);
      this.emit(DefaultPlayerEvents.ERROR, e);
    }
  }

  private async fetchNextFragment(): Promise<void> {
    if (!this.running || !this.source) return;

    const level = this.levels[this.currentLevel];
    if (!level || this.currentFragmentIndex >= level.fragments.length) {
      // All fragments loaded
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        this.mediaSource.endOfStream();
      }
      return;
    }

    const fragment = level.fragments[this.currentFragmentIndex];

    try {
      const response = await fetch(fragment.url);
      if (!response.ok) {
        throw new Error(`Failed to fetch fragment: ${response.status}`);
      }

      const data = await response.arrayBuffer();

      if (this.sourceBuffer && !this.sourceBuffer.updating) {
        this.sourceBuffer.appendBuffer(data);
      }
    } catch (e) {
      console.error('Fragment fetch failed:', e);
      // Try next fragment
      this.currentFragmentIndex++;
      this.fetchNextFragment();
    }
  }

  private onSourceBufferUpdateEnd(): void {
    this.currentFragmentIndex++;
    this.fetchNextFragment();
  }

  get duration(): number {
    return this._duration;
  }

  get currentTime(): number {
    return this.video?.currentTime || 0;
  }

  set currentTime(value: number) {
    if (this.video) {
      this.video.currentTime = value;
    }
  }

  get paused(): boolean {
    return this.video?.paused ?? true;
  }

  async play(): Promise<void> {
    return this.video?.play();
  }

  async pause(): Promise<void> {
    this.video?.pause();
  }

  getLevelCount(): number {
    return this.levels.length;
  }

  getCurrentLevel(): number {
    return this.currentLevel;
  }

  setLevel(index: number): void {
    if (index >= 0 && index < this.levels.length) {
      this.currentLevel = index;
    }
  }

  canSave() {
    return { canSave: true, cantSave: false, isComplete: false };
  }

  destroy(): void {
    this.running = false;
    if (this.mainLoopTimer) {
      clearTimeout(this.mainLoopTimer);
      this.mainLoopTimer = null;
    }
    VideoUtils.destroyVideo(this.video);
    this.video = null as any;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.emit(DefaultPlayerEvents.DESTROYED);
  }
}
