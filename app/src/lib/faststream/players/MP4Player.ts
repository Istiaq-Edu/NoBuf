import { DefaultPlayerEvents } from '../enums/DefaultPlayerEvents';
import { EventEmitter, EmitterRelay } from '../modules/eventemitter';
import { VideoUtils } from '../utils/VideoUtils';
import { SourceBufferWrapper } from './SourceBufferWrapper';
import { DownloadManager } from '../network/DownloadManager';
import { VideoSource } from '../VideoSource';

const FRAGMENT_SIZE = 1000000; // 1MB per fragment

interface MP4Track {
  id: number;
  codec: string;
  width?: number;
  height?: number;
  duration: number;
  timescale: number;
}

export class MP4Player extends EventEmitter {
  private client: { options: any; downloadManager: DownloadManager };
  private isAudioOnly: boolean;
  video: HTMLVideoElement | HTMLAudioElement;
  private mediaSource: MediaSource | null = null;
  private videoSourceBuffer: SourceBufferWrapper | null = null;
  private audioSourceBuffer: SourceBufferWrapper | null = null;
  private source: VideoSource | null = null;
  private mp4box: any = null;
  private running = false;
  private videoTracks: MP4Track[] = [];
  private audioTracks: MP4Track[] = [];
  private currentVideoTrack = 0;
  private currentAudioTrack = 0;
  private _duration = 0;
  private fileLength = 0;
  private mainLoopTimer: number | null = null;

  constructor(client: { options: any; downloadManager: DownloadManager }, config?: { isPreview?: boolean; isAudioOnly?: boolean }) {
    super();
    this.client = client;
    this.isAudioOnly = config?.isAudioOnly || false;
    this.video = document.createElement(this.isAudioOnly ? 'audio' : 'video');
  }

  load(): void {}

  getClient() {
    return this.client;
  }

  async setup(): Promise<void> {
    const preEvents = new EventEmitter();
    const emitterRelay = new EmitterRelay([preEvents, this]);
    VideoUtils.addPassthroughEventListenersToVideo(this.video, emitterRelay);
  }

  getVideo(): HTMLVideoElement | HTMLAudioElement {
    return this.video;
  }

  async setSource(source: VideoSource): Promise<void> {
    this.source = source;
    this.running = true;

    // Create MediaSource
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
  }

  private async onSourceOpen(): Promise<void> {
    if (!this.source || !this.mediaSource) return;

    try {
      // Dynamically import mp4box
      const MP4Box = await this.loadMP4Box();
      this.mp4box = MP4Box.createFile(false);

      this.mp4box.onReady = (info: any) => {
        this.onMP4BoxReady(info);
      };

      this.mp4box.onError = (e: any) => {
        console.error('mp4box error:', e);
        this.emit(DefaultPlayerEvents.ERROR, e);
      };

      // Fetch the first fragment to parse metadata
      await this.fetchFirstFragment();
    } catch (e) {
      console.error('MP4Player setup failed:', e);
      this.emit(DefaultPlayerEvents.ERROR, e);
    }
  }

  private async loadMP4Box(): Promise<any> {
    // Try to load mp4box from global scope
    if (typeof (window as any).MP4Box !== 'undefined') {
      return (window as any).MP4Box;
    }

    // Dynamic import
    try {
      const mod = await import(/* webpackIgnore: true */ 'mp4box');
      return mod.default || mod;
    } catch {
      // If import fails, try loading from CDN
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/mp4box@0.5.2/dist/mp4box.all.js';
        script.onload = () => resolve((window as any).MP4Box);
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
  }

  private async fetchFirstFragment(): Promise<void> {
    if (!this.source) return;

    const url = this.source.url;
    const headers: Record<string, string> = { ...this.source.headers };

    try {
      const response = await fetch(url, {
        headers: { ...headers, 'Range': `bytes=0-${FRAGMENT_SIZE - 1}` },
      });

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Get file length from Content-Range header
      const contentRange = response.headers.get('Content-Range');
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)/);
        if (match) {
          this.fileLength = parseInt(match[1], 10);
        }
      }

      const data = await response.arrayBuffer();

      // Feed to mp4box
      const buffer = data as any;
      buffer.fileStart = 0;
      this.mp4box.appendBuffer(buffer);
    } catch (e) {
      console.error('Failed to fetch first fragment:', e);
      this.emit(DefaultPlayerEvents.ERROR, e);
    }
  }

  private onMP4BoxReady(info: any): void {
    if (!this.mediaSource) return;

    this._duration = info.duration / info.timescale;

    // Extract tracks
    for (const track of info.videoTracks) {
      this.videoTracks.push({
        id: track.id,
        codec: track.codec,
        width: track.width,
        height: track.height,
        duration: track.duration,
        timescale: track.timescale,
      });
    }

    for (const track of info.audioTracks) {
      this.audioTracks.push({
        id: track.id,
        codec: track.codec,
        duration: track.duration,
        timescale: track.timescale,
      });
    }

    // Set up MSE SourceBuffers
    try {
      if (this.videoTracks.length > 0) {
        const track = this.videoTracks[this.currentVideoTrack];
        const mimeType = `video/mp4; codecs="${track.codec}"`;
        if (MediaSource.isTypeSupported(mimeType)) {
          const sb = this.mediaSource.addSourceBuffer(mimeType);
          this.videoSourceBuffer = new SourceBufferWrapper(sb);
        }
      }

      if (this.audioTracks.length > 0) {
        const track = this.audioTracks[this.currentAudioTrack];
        const mimeType = `audio/mp4; codecs="${track.codec}"`;
        if (MediaSource.isTypeSupported(mimeType)) {
          const sb = this.mediaSource.addSourceBuffer(mimeType);
          this.audioSourceBuffer = new SourceBufferWrapper(sb);
        }
      }

      // Start main loop
      this.startMainLoop();
    } catch (e) {
      console.error('Failed to set up SourceBuffers:', e);
      this.emit(DefaultPlayerEvents.ERROR, e);
    }
  }

  private startMainLoop(): void {
    if (this.mainLoopTimer) return;

    const loop = () => {
      if (!this.running) return;
      this.mainLoop();
      this.mainLoopTimer = window.setTimeout(loop, 100);
    };
    loop();
  }

  private mainLoop(): void {
    if (!this.video || !this.source) return;

    const currentTime = this.video.currentTime;
    const bufferAhead = this.client.options.bufferAhead || 30;

    // Calculate which fragment we need based on current time
    const currentFragmentIndex = Math.floor(currentTime * this.getBitrate() / FRAGMENT_SIZE);
    const fragmentsAhead = Math.ceil(bufferAhead * this.getBitrate() / FRAGMENT_SIZE);

    // Request fragments ahead of playback
    for (let i = currentFragmentIndex; i < currentFragmentIndex + fragmentsAhead; i++) {
      this.requestFragment(i);
    }
  }

  private getBitrate(): number {
    if (this.fileLength > 0 && this._duration > 0) {
      return this.fileLength / this._duration;
    }
    return 1000000; // Default 1Mbps
  }

  private requestFragment(index: number): void {
    if (!this.source) return;

    const start = index * FRAGMENT_SIZE;
    const end = Math.min(start + FRAGMENT_SIZE - 1, this.fileLength - 1);

    if (start >= this.fileLength) return;

    // Check if already downloaded
    if (this.client.downloadManager.canGetFile({ url: this.source.url, rangeStart: start, rangeEnd: end })) {
      return;
    }

    // Request download
    this.client.downloadManager.requestFile({
      url: this.source.url,
      rangeStart: start,
      rangeEnd: end,
      headers: this.source.headers,
      priority: 1000 - Math.abs(index - Math.floor(this.video!.currentTime * this.getBitrate() / FRAGMENT_SIZE)),
    });
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

  get levels(): null {
    return null; // Single quality for MP4
  }

  get currentFragment(): null {
    return null;
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
    this.videoSourceBuffer?.destroy();
    this.audioSourceBuffer?.destroy();
    VideoUtils.destroyVideo(this.video);
    this.video = null as any;
    this.mediaSource = null;
    this.emit(DefaultPlayerEvents.DESTROYED);
  }
}
