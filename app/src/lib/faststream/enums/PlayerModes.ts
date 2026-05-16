export const PlayerModes = {
  AUTO: 'auto',
  DIRECT: 'direct',
  ACCELERATED_MP4: 'accelerated_mp4',
  ACCELERATED_HLS: 'accelerated_hls',
  ACCELERATED_DASH: 'accelerated_dash',
  IFRAME: 'iframe',
} as const;

export type PlayerMode = (typeof PlayerModes)[keyof typeof PlayerModes];
