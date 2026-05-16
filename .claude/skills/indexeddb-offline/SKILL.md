---
name: indexeddb-offline
description: IndexedDB patterns for offline-first storage — fragment caching, data persistence, and sync strategies
user-invocable: true
---

## IndexedDB & Offline Storage Guide

Expert guidance for using IndexedDB as a persistent fragment store and offline cache in desktop apps.

### Why IndexedDB Over localStorage
| Feature | localStorage | IndexedDB |
|---------|-------------|-----------|
| Storage limit | ~5-10MB | Hundreds of MB+ |
| Data types | Strings only | Blobs, ArrayBuffers, structured clones |
| Async | Synchronous (blocks) | Async (non-blocking) |
| Indexing | No | Yes (query by key ranges) |
| Transactions | No | Yes (ACID) |

### IndexedDB Basics
```typescript
// Open/create database
const request = indexedDB.open('my-db', 1);
request.onupgradeneeded = (event) => {
    const db = request.result;
    if (!db.objectStoreNames.contains('fragments')) {
        db.createObjectStore('fragments', { keyPath: 'id' });
    }
};
```

### Fragment Store Pattern
```typescript
interface Fragment {
    id: string;        // e.g., "fileId-0", "fileId-1"
    fileId: string;
    chunkIndex: number;
    data: ArrayBuffer;
    byteStart: number;
    byteEnd: number;
    timestamp: number;
}

// Store fragment
async function storeFragment(db: IDBDatabase, fragment: Fragment) {
    const tx = db.transaction('fragments', 'readwrite');
    tx.objectStore('fragments').put(fragment);
    await tx.complete;
}

// Get fragments for a file
async function getFragments(db: IDBDatabase, fileId: string): Promise<Fragment[]> {
    const tx = db.transaction('fragments', 'readonly');
    const index = tx.objectStore('fragments').index('fileId');
    return await index.getAll(fileId);
}
```

### Hybrid Memory + IndexedDB
- **Memory** — hot cache for active playback (current + next few fragments)
- **IndexedDB** — cold storage for seek persistence (all downloaded fragments)
- On seek: check memory first → fall back to IndexedDB → fetch from network if missing

### Fragment Merging
```typescript
// When adjacent fragments exist, merge them
function mergeAdjacent(fragments: Fragment[]): Fragment[] {
    const sorted = fragments.sort((a, b) => a.byteStart - b.byteStart);
    const merged: Fragment[] = [sorted[0]];
    
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        if (last.byteEnd + 1 === sorted[i].byteStart) {
            // Adjacent — merge
            last.byteEnd = sorted[i].byteEnd;
            last.data = concatenate(last.data, sorted[i].data);
        } else {
            merged.push(sorted[i]);
        }
    }
    return merged;
}
```

### IndexedDB Wrapper Pattern
```typescript
class FragmentStore {
    private db: IDBDatabase | null = null;
    
    async init(): Promise<void> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('FragmentStore', 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                const store = db.createObjectStore('fragments', { keyPath: 'id' });
                store.createIndex('fileId', 'fileId', { unique: false });
            };
            req.onsuccess = () => { this.db = req.result; resolve(); };
            req.onerror = () => reject(req.error);
        });
    }
    
    // ... CRUD methods using this.db
}
```

### Storage Management
```typescript
// Check available storage
if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    console.log(`Using ${estimate.usage} of ${estimate.quota} bytes`);
}

// Request persistent storage (prevents browser eviction)
if (navigator.storage && navigator.storage.persist) {
    const persisted = await navigator.storage.persist();
    console.log('Persistent:', persisted);
}
```

### Common Pitfalls
- **Version changes** — `onupgradeneeded` only fires on version bump
- **Transaction scope** — Transactions auto-commit; don't hold them open
- **Large blobs** — Storing >100MB blobs can be slow; chunk them
- **Safari/iOS** — May evict IndexedDB data; request persistent storage
- **Error handling** — Always handle `onerror` on requests and transactions

### Debug Tips
- Chrome DevTools → Application tab → IndexedDB section
- Can view, edit, and delete entries manually
- Use `DB_NAME.onsuccess` to confirm database opened
- Log transaction errors: `tx.onerror = (e) => console.error(e)`
