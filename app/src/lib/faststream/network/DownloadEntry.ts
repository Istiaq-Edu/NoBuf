import { DownloadStatus, DownloadStatusType } from '../enums/DownloadStatus';

export class DownloadEntry {
  identifier: string;
  url: string;
  rangeStart: number;
  rangeEnd: number;
  headers: Record<string, string>;
  responseType: string;
  priority: number;
  status: DownloadStatusType;
  data: ArrayBuffer | null;
  transferCallback: ((entry: DownloadEntry) => Promise<void>) | null;

  constructor(options: {
    identifier: string;
    url: string;
    rangeStart: number;
    rangeEnd: number;
    headers?: Record<string, string>;
    responseType?: string;
    priority?: number;
  }) {
    this.identifier = options.identifier;
    this.url = options.url;
    this.rangeStart = options.rangeStart;
    this.rangeEnd = options.rangeEnd;
    this.headers = options.headers || {};
    this.responseType = options.responseType || 'arraybuffer';
    this.priority = options.priority || 0;
    this.status = DownloadStatus.WAITING;
    this.data = null;
    this.transferCallback = null;
  }

  setTransferFunction(fn: (entry: DownloadEntry) => Promise<void>): void {
    this.transferCallback = fn;
  }

  async transfer(): Promise<void> {
    if (this.transferCallback) {
      await this.transferCallback(this);
    }
  }
}
