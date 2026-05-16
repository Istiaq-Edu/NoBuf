import { EventEmitter } from './modules/eventemitter';
import { DownloadManager } from './network/DownloadManager';
import { MP4Player } from './players/MP4Player';
import { HLSPlayer } from './players/HLSPlayer';
import { DirectVideoPlayer } from './players/DirectVideoPlayer';
import { VideoSource } from './VideoSource';
import { PlayerModes, PlayerMode } from './enums/PlayerModes';
import { DefaultPlayerEvents } from './enums/DefaultPlayerEvents';

export interface FastStreamOptions {
  bufferAhead: number;
  bufferBehind: number;
  maxPlaybackRate: number;
  downloadAll: boolean;
  maxVideoSize: number;
  autoPlay: boolean;
  defaultQuality: string;
  maximumDownloaders: number;
  maxSpeed: number;
}

const DEFAULT_OPTIONS: FastStreamOptions = {
  bufferAhead: 60,       // 60 seconds ahead (tuned for Telegram)
  bufferBehind: 10,      // 10 seconds behind
  maxPlaybackRate: 16,
  downloadAll: false,
  maxVideoSize: 5 * 1024 * 1024 * 1024, // 5GB
  autoPlay: true,
  defaultQuality: 'Auto',
  maximumDownloaders: 3, // 3 concurrent (tuned for Telegram rate limits)
  maxSpeed: 0,           // unlimited
};

export class FastStreamClient extends EventEmitter {
  options: FastStreamOptions;
  downloadManager: DownloadManager;
  player: MP4Player | HLSPlayer | DirectVideoPlayer | null = null;
  private container: HTMLElement | null = null;
  private destroyed = false;

  constructor(options: Partial<FastStreamOptions> = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.downloadManager = new DownloadManager();
    this.downloadManager.setMaximumDownloaders(this.options.maximumDownloaders);
  }

  async setup(container: HTMLElement): Promise<void> {
    this.container = container;
  }

  async addSource(source: VideoSource, autoPlay: boolean = true): Promise<void> {
    if (this.destroyed) return;

    // Clean up existing player
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }

    // Determine player mode
    const mode = this.resolvePlayerMode(source);

    // Create player
    this.player = await this.createPlayer(mode);
    this.player.load();
    await this.player.setup();

    // Mount video element
    if (this.container) {
      this.container.innerHTML = '';
      const video = this.player.getVideo();
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'contain';
      if (autoPlay) {
        (video as HTMLVideoElement).autoplay = true;
      }
      this.container.appendChild(video);
    }

    // Set source
    await this.player.setSource(source);

    // Wire up events
    this.player.on(DefaultPlayerEvents.ERROR, (e: any) => {
      this.emit(DefaultPlayerEvents.ERROR, e);
    });

    this.player.on(DefaultPlayerEvents.LOADED_METADATA, () => {
      this.emit(DefaultPlayerEvents.LOADED_METADATA);
    });

    this.player.on(DefaultPlayerEvents.CAN_PLAY, () => {
      this.emit(DefaultPlayerEvents.CAN_PLAY);
      if (autoPlay) {
        this.player?.play().catch(() => {});
      }
    });

    // Start download manager loop
    this.startDownloadLoop();

    this.emit('sourceSet', source);
  }

  private resolvePlayerMode(source: VideoSource): PlayerMode {
    if (source.mode !== PlayerModes.AUTO) {
      return source.mode;
    }

    // For local Telegram stream URLs, always use DIRECT mode.
    // The backend supports Range requests for seeking, so MSE is not needed.
    // This avoids mp4box/MSE complexity and works reliably.
    const url = source.url.toLowerCase();
    if (url.includes('/stream/') || url.includes('localhost')) {
      return PlayerModes.DIRECT;
    }

    if (url.endsWith('.mp4')) {
      return PlayerModes.ACCELERATED_MP4;
    }
    if (url.endsWith('.m3u8')) {
      return PlayerModes.ACCELERATED_HLS;
    }
    if (url.endsWith('.mpd')) {
      return PlayerModes.ACCELERATED_DASH;
    }

    return PlayerModes.DIRECT;
  }

  private async createPlayer(mode: PlayerMode): Promise<MP4Player | HLSPlayer | DirectVideoPlayer> {
    switch (mode) {
      case PlayerModes.ACCELERATED_MP4:
        try {
          return new MP4Player(this, { isPreview: false });
        } catch (e) {
          console.warn('MP4Player not available, falling back to DirectVideoPlayer:', e);
          return new DirectVideoPlayer(this);
        }
      case PlayerModes.ACCELERATED_HLS:
        try {
          return new HLSPlayer(this);
        } catch (e) {
          console.warn('HLSPlayer not available, falling back to DirectVideoPlayer:', e);
          return new DirectVideoPlayer(this);
        }
      case PlayerModes.DIRECT:
      default:
        return new DirectVideoPlayer(this);
    }
  }

  private downloadLoopTimer: number | null = null;

  private startDownloadLoop(): void {
    if (this.downloadLoopTimer) return;

    const loop = () => {
      if (this.destroyed) return;
      this.downloadManager.update();
      this.downloadLoopTimer = window.setTimeout(loop, 50);
    };
    loop();
  }

  get currentTime(): number {
    return this.player?.currentTime || 0;
  }

  set currentTime(value: number) {
    if (this.player) {
      this.player.currentTime = value;
    }
  }

  get duration(): number {
    return this.player?.duration || 0;
  }

  get paused(): boolean {
    return this.player?.paused ?? true;
  }

  async play(): Promise<void> {
    await this.player?.play();
  }

  async pause(): Promise<void> {
    this.player?.pause();
  }

  getVideoElement(): HTMLVideoElement | HTMLAudioElement | null {
    return this.player?.getVideo() || null;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.downloadLoopTimer) {
      clearTimeout(this.downloadLoopTimer);
      this.downloadLoopTimer = null;
    }
    this.player?.destroy();
    this.player = null;
    this.downloadManager.destroy();
    this.removeAllListeners();
  }
}
