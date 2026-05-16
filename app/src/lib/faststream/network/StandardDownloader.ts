import { DownloadEntry } from './DownloadEntry';
import { DownloadStatus } from '../enums/DownloadStatus';

export class StandardDownloader {
  private entry: DownloadEntry | null = null;
  private abortController: AbortController | null = null;

  isIdle(): boolean {
    return this.entry === null;
  }

  getEntry(): DownloadEntry | null {
    return this.entry;
  }

  async download(entry: DownloadEntry): Promise<void> {
    this.entry = entry;
    entry.status = DownloadStatus.DOWNLOAD_INITIATED;

    try {
      this.abortController = new AbortController();

      const headers: Record<string, string> = { ...entry.headers };
      if (entry.rangeStart >= 0 && entry.rangeEnd >= 0) {
        headers['Range'] = `bytes=${entry.rangeStart}-${entry.rangeEnd}`;
      }

      const response = await fetch(entry.url, {
        method: 'GET',
        headers,
        signal: this.abortController.signal,
      });

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.arrayBuffer();
      entry.data = data;
      entry.status = DownloadStatus.DOWNLOAD_COMPLETE;
      await entry.transfer();
    } catch (e: any) {
      if (e.name === 'AbortError') {
        entry.status = DownloadStatus.WAITING;
      } else {
        console.error('Download failed:', e);
        entry.status = DownloadStatus.DOWNLOAD_FAILED;
      }
    } finally {
      this.abortController = null;
      this.entry = null;
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
