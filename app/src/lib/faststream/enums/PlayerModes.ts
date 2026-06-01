export const PlayerModes = {
  AUTO: 'auto',
  DIRECT: 'direct',
  ACCELERATED_MP4: 'accelerated_mp4',
  ACCELERATED_HLS: 'accelerated_hls',
  ACCELERATED_DASH: 'accelerated_dash',
  ACCELERATED_TS: 'accelerated_ts',
  ACCELERATED_MKV: 'accelerated_mkv',
  IFRAME: 'iframe',
} as const;

export type PlayerMode = (typeof PlayerModes)[keyof typeof PlayerModes];
