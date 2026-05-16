export const DefaultPlayerEvents = {
  PLAY: 'play',
  PAUSE: 'pause',
  SEEKED: 'seeked',
  TIME_UPDATE: 'timeupdate',
  LOADED_METADATA: 'loadedmetadata',
  CAN_PLAY: 'canplay',
  WAITING: 'waiting',
  ENDED: 'ended',
  ERROR: 'error',
  VOLUME_CHANGE: 'volumechange',
  RATE_CHANGE: 'ratechange',
  DESTROYED: 'destroyed',
  BUFFER_UPDATE: 'bufferupdate',
} as const;

export type DefaultPlayerEvent = (typeof DefaultPlayerEvents)[keyof typeof DefaultPlayerEvents];
