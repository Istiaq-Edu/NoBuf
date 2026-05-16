import { DefaultPlayerEvents } from '../enums/DefaultPlayerEvents';
import { EventEmitter, EmitterRelay } from '../modules/eventemitter';
import { VideoUtils } from '../utils/VideoUtils';
import { VideoSource } from '../VideoSource';

/**
 * Fallback player that uses native HTML5 video element directly.
 * Used for formats not supported by MSE-based players (MKV, AVI, WebM, etc.)
 */
export class DirectVideoPlayer extends EventEmitter {
  video: HTMLVideoElement | HTMLAudioElement;
  private source: VideoSource | null = null;
  private isAudioOnly: boolean;

  constructor(_client: any, config?: { isAudioOnly?: boolean }) {
    super();
    this.isAudioOnly = config?.isAudioOnly || false;
    this.video = document.createElement(this.isAudioOnly ? 'audio' : 'video');
  }

  load(): void {}

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
    this.video.src = source.url;
  }

  getSource(): VideoSource | null {
    return this.source;
  }

  get buffered(): TimeRanges {
    return this.video.buffered;
  }

  async play(): Promise<void> {
    return this.video.play();
  }

  async pause(): Promise<void> {
    this.video.pause();
  }

  destroy(): void {
    VideoUtils.destroyVideo(this.video);
    this.video = null as any;
    this.emit(DefaultPlayerEvents.DESTROYED);
  }

  get currentTime(): number {
    return this.video?.currentTime || 0;
  }

  set currentTime(value: number) {
    if (this.video) {
      this.video.currentTime = value;
    }
  }

  get readyState(): number {
    return this.video?.readyState || 0;
  }

  get paused(): boolean {
    return this.video?.paused ?? true;
  }

  get levels(): null {
    return null;
  }

  get duration(): number {
    return this.video?.duration || 0;
  }

  get currentFragment(): null {
    return null;
  }

  canSave() {
    return { cantSave: true, canSave: false, isComplete: true };
  }
}
