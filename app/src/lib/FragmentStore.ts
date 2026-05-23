/**
 * Fragment storage - hybrid memory + IndexedDB.
 * Memory Map for fast access, IndexedDB as write-behind.
 * Cleared on video change. IndexedDB cleared on app start.
 */

const DB_NAME = 'nobuff-fragments';
const DB_VERSION = 1;
const STORE_NAME = 'fragments';

export interface ByteRange {
  start: number;
  end: number;
}

interface FragmentEntry {
  key: string;
  url: string;
  start: number;
  end: number;
  data: ArrayBuffer;
}

class FragmentStore {
  private cache = new Map<string, ArrayBuffer>();
  private ranges = new Map<string, ByteRange[]>();
  private db: IDBDatabase | null = null;
  private dbReady: Promise<void>;

  constructor() {
    this.dbReady = this.initDB();
  }

  private async initDB(): Promise<void> {
    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.warn('[FragmentStore] IndexedDB not available, memory-only mode');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        // Clear old data from previous sessions
        this.clearAllDB();
        resolve();
      };
    });
  }

  private getKey(url: string, start: number, end: number): string {
    return `${url}::${start}-${end}`;
  }

  // Fast memory lookup
  get(url: string, start: number, end: number): ArrayBuffer | null {
    return this.cache.get(this.getKey(url, start, end)) ?? null;
  }

  // Store in memory + async write to IndexedDB
  put(url: string, start: number, end: number, data: ArrayBuffer): void {
    const key = this.getKey(url, start, end);

    // Memory cache (fast)
    this.cache.set(key, data);

    // Track range
    const ranges = this.ranges.get(url) ?? [];
    ranges.push({ start, end });
    this.ranges.set(url, this.mergeRanges(ranges));

    // Async write to IndexedDB (browser can offload if needed)
    this.writeToDB(key, url, start, end, data);
  }

  has(url: string, start: number, end: number): boolean {
    return this.cache.has(this.getKey(url, start, end));
  }

  getRanges(url: string): ByteRange[] {
    return this.ranges.get(url) ?? [];
  }

  // Clear fragments for a specific URL (called on video change)
  clear(url: string): void {
    const prefix = url + '::';

    // Clear memory
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
    this.ranges.delete(url);

    // Clear IndexedDB entries for this URL
    this.clearDBByUrl(url);
  }

  // Merge adjacent/overlapping ranges
  mergeRanges(ranges: ByteRange[]): ByteRange[] {
    if (ranges.length === 0) return [];

    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const merged: ByteRange[] = [{ ...sorted[0] }];

    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      const current = sorted[i];
      if (current.start <= last.end + 1024) {
        last.end = Math.max(last.end, current.end);
      } else {
        merged.push({ ...current });
      }
    }

    return merged;
  }

  // Private IndexedDB methods

  private async writeToDB(key: string, url: string, start: number, end: number, data: ArrayBuffer): Promise<void> {
    await this.dbReady;
    if (!this.db) return;

    try {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ key, url, start, end, data } as FragmentEntry);
    } catch (e) {
      // Silent fail - memory cache still works
    }
  }

  private async clearDBByUrl(url: string): Promise<void> {
    await this.dbReady;
    if (!this.db) return;

    try {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const entry = cursor.value as FragmentEntry;
          if (entry.url === url) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
    } catch (e) {
      // Silent fail
    }
  }

  private async clearAllDB(): Promise<void> {
    await this.dbReady;
    if (!this.db) return;

    try {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
    } catch (e) {
      // Silent fail
    }
  }
}

// Singleton instance
export const fragmentStore = new FragmentStore();
