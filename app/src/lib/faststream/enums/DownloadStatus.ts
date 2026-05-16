export const DownloadStatus = {
  WAITING: 0,
  ENQUEUED: 1,
  DOWNLOAD_INITIATED: 2,
  DOWNLOAD_COMPLETE: 3,
  DOWNLOAD_FAILED: 4,
} as const;

export type DownloadStatusType = (typeof DownloadStatus)[keyof typeof DownloadStatus];
