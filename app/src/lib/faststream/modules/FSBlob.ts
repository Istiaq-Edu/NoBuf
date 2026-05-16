const DB_NAME = 'faststream-blobs';
const STORE_NAME = 'blobs';

export class FSBlob {
  private blobStore: Map<string, ArrayBuffer> = new Map();
  private db: IDBDatabase | null = null;
  private setupPromise: Promise<void> | null = null;

  constructor() {
    this.setupPromise = this.setup();
  }

  private async setup(): Promise<void> {
    try {
      if (typeof indexedDB === 'undefined') {
        this.setupPromise = null;
        return;
      }
      this.db = await this.openDB();
    } catch (e) {
      console.warn('FSBlob IndexedDB setup failed, falling back to memory', e);
      this.db = null;
      this.setupPromise = null;
    }
  }

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async saveBlobAsync(data: ArrayBuffer | null, identifier: string): Promise<void> {
    if (!data) return;
    this.blobStore.set(identifier, data);

    if (this.db) {
      try {
        await this.setupPromise;
        await this.saveToIDB(identifier, data);
      } catch (e) {
        console.warn('Failed to save blob to IndexedDB:', e);
      }
    }
  }

  private saveToIDB(identifier: string, data: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) { resolve(); return; }
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(data, identifier);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  getBlob(identifier: string): ArrayBuffer | null {
    const cached = this.blobStore.get(identifier);
    if (cached) return cached;
    return null;
  }

  async getBlobAsync(identifier: string): Promise<ArrayBuffer | null> {
    const cached = this.blobStore.get(identifier);
    if (cached) return cached;

    if (this.db) {
      try {
        const data = await this.getFromIDB(identifier);
        if (data) {
          this.blobStore.set(identifier, data);
          return data;
        }
      } catch (e) {
        console.warn('Failed to read blob from IndexedDB:', e);
      }
    }
    return null;
  }

  private getFromIDB(identifier: string): Promise<ArrayBuffer | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) { resolve(null); return; }
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(identifier);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  removeBlob(identifier: string): void {
    this.blobStore.delete(identifier);
    if (this.db) {
      try {
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(identifier);
      } catch (e) {
        // Ignore
      }
    }
  }

  clear(): void {
    this.blobStore.clear();
    if (this.db) {
      try {
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
      } catch (e) {
        // Ignore
      }
    }
  }
}
