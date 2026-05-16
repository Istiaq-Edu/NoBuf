import { EmitterRelay, EventEmitter } from '../modules/eventemitter';

export class VideoUtils {
  static addPassthroughEventListenersToVideo(
    video: HTMLVideoElement | HTMLAudioElement,
    emitter: EventEmitter | EmitterRelay
  ): void {
    const events = [
      'play', 'pause', 'seeked', 'timeupdate', 'loadedmetadata',
      'canplay', 'waiting', 'ended', 'error', 'volumechange', 'ratechange',
      'progress', 'loadeddata', 'stalled', 'suspend', 'emptied',
    ];

    for (const event of events) {
      video.addEventListener(event, () => {
        emitter.emit(event);
      });
    }
  }

  static destroyVideo(video: HTMLVideoElement | HTMLAudioElement | null): void {
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  static isVideoSupported(video: HTMLVideoElement | null): boolean {
    if (!video) return false;
    return typeof MediaSource !== 'undefined';
  }

  static canPlayType(type: string): boolean {
    const video = document.createElement('video');
    return video.canPlayType(type) !== '';
  }
}
