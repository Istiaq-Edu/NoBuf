import { DownloadEntry } from './DownloadEntry';
import { StandardDownloader } from './StandardDownloader';
import { DownloadStatus } from '../enums/DownloadStatus';
import { FSBlob } from '../modules/FSBlob';

export class DownloadManager {
  private queue: DownloadEntry[] = [];
  private storage: Map<string, DownloadEntry> = new Map();
  private downloaders: StandardDownloader[] = [];
  private paused = false;
  private speedTestCount = 0;
  private testing = true;
  private lastFailed = 0;
  private failed = 0;
  private blobStore: FSBlob;
  private maximumDownloaders = 6;

  constructor() {
    this.blobStore = new FSBlob();
    // Start with 1 downloader for speed testing
    this.downloaders.push(new StandardDownloader());
  }

  setMaximumDownloaders(max: number): void {
    this.maximumDownloaders = max;
  }

  getCompletedEntries(): DownloadEntry[] {
    const entries: DownloadEntry[] = [];
    this.storage.forEach((entry) => {
      if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
        entries.push(entry);
      }
    });
    return entries;
  }

  setEntries(entries: DownloadEntry[]): void {
    for (const entry of entries) {
      this.setEntry(entry);
    }
  }

  async archiveEntryData(entry: DownloadEntry): Promise<void> {
    if (entry.status !== DownloadStatus.DOWNLOAD_COMPLETE || typeof entry.data === 'function') {
      return;
    }
    const identifier = this.getIdentifier(entry);
    await this.blobStore.saveBlobAsync(entry.data, identifier);
    (entry as any).data = () => {
      return this.blobStore.getBlob(identifier);
    };
  }

  setEntry(entry: DownloadEntry): void {
    const identifier = this.getIdentifier(entry);
    if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      this.archiveEntryData(entry);
    } else {
      entry.setTransferFunction(this.archiveEntryData.bind(this));
    }
    this.storage.set(identifier, entry);
  }

  canGetFile(details: { url: string; rangeStart: number; rangeEnd: number }): boolean {
    const key = this.getIdentifierFromDetails(details);
    const storedEntry = this.storage.get(key);
    return !!storedEntry && storedEntry.status === DownloadStatus.DOWNLOAD_COMPLETE;
  }

  getFile(details: { url: string; rangeStart: number; rangeEnd: number; headers?: Record<string, string>; priority?: number }): DownloadEntry | null {
    const key = this.getIdentifierFromDetails(details);
    const storedEntry = this.storage.get(key);
    if (storedEntry && storedEntry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
      return storedEntry;
    }
    return null;
  }

  requestFile(details: {
    url: string;
    rangeStart: number;
    rangeEnd: number;
    headers?: Record<string, string>;
    priority?: number;
  }): DownloadEntry {
    const key = this.getIdentifierFromDetails(details);
    let entry = this.storage.get(key);

    if (entry) {
      if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
        return entry;
      }
      if (entry.status === DownloadStatus.WAITING) {
        entry.priority = details.priority || 0;
        this.enqueueEntry(entry);
      }
      return entry;
    }

    entry = new DownloadEntry({
      identifier: key,
      url: details.url,
      rangeStart: details.rangeStart,
      rangeEnd: details.rangeEnd,
      headers: details.headers,
      priority: details.priority,
    });
    this.setEntry(entry);
    this.enqueueEntry(entry);
    return entry;
  }

  private enqueueEntry(entry: DownloadEntry): void {
    entry.status = DownloadStatus.ENQUEUED;
    this.queue.push(entry);
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  private getIdentifierFromDetails(details: { url: string; rangeStart: number; rangeEnd: number }): string {
    return `${details.url}::${details.rangeStart}-${details.rangeEnd}`;
  }

  private getIdentifier(entry: DownloadEntry): string {
    return this.getIdentifierFromDetails(entry);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getActiveDownloads(): number {
    return this.downloaders.filter(d => !d.isIdle()).length;
  }

  async update(): Promise<void> {
    if (this.paused) return;

    const now = Date.now();

    // Clean up failed entries cooldown
    if (this.failed > 0 && now - this.lastFailed > 1000) {
      this.failed = 0;
    }

    // Fill idle downloaders
    for (const downloader of this.downloaders) {
      if (downloader.isIdle() && this.queue.length > 0) {
        const entry = this.queue.shift()!;
        if (entry.status === DownloadStatus.ENQUEUED) {
          this.downloadEntry(downloader, entry);
        }
      }
    }

    // Speed test: add more downloaders if speed is improving
    if (this.testing && this.downloaders.length < this.maximumDownloaders) {
      this.speedTestCount++;
      if (this.speedTestCount >= 10) {
        this.speedTestCount = 0;
        const activeCount = this.getActiveDownloads();
        if (activeCount >= this.downloaders.length) {
          // All downloaders busy, add one more
          this.downloaders.push(new StandardDownloader());
        }
      }
    }
  }

  private async downloadEntry(downloader: StandardDownloader, entry: DownloadEntry): Promise<void> {
    try {
      await downloader.download(entry);
      if (entry.status === DownloadStatus.DOWNLOAD_COMPLETE) {
        this.failed = 0;
      } else if (entry.status === DownloadStatus.DOWNLOAD_FAILED) {
        this.failed++;
        this.lastFailed = Date.now();
        // Re-enqueue if not too many failures
        if (this.failed < 3) {
          entry.status = DownloadStatus.WAITING;
          this.enqueueEntry(entry);
        }
      }
    } catch (e) {
      console.error('Download error:', e);
      entry.status = DownloadStatus.DOWNLOAD_FAILED;
    }
  }

  abortAll(): void {
    for (const downloader of this.downloaders) {
      downloader.abort();
    }
    this.queue = [];
  }

  destroy(): void {
    this.abortAll();
    this.storage.clear();
    this.downloaders = [];
  }
}
