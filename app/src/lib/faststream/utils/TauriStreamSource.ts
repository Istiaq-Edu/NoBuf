import { CustomSource } from 'mediabunny';

export interface TauriStreamSourceConfig {
  url: string;
  fileSize: number;
  headers?: Record<string, string>;
  maxCacheSize?: number;
  prefetchProfile?: 'none' | 'fileSystem' | 'network';
  seedData?: ArrayBuffer;
}

const MAX_503_RETRIES = 8;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15000;
const MAX_EMPTY_RETRIES = 60;
const EMPTY_RETRY_DELAY_MS = 500;
const PARTIAL_RETRY_DELAY_MS = 100;
const READAHEAD_CHUNK_SIZE = 8 * 1024 * 1024;

export function createTauriStreamSource(config: TauriStreamSourceConfig): CustomSource {
  const { url, fileSize, headers = {}, maxCacheSize, prefetchProfile = 'network', seedData } = config;
  const seedBytes = seedData ? new Uint8Array(seedData) : null;
  const seedLength = seedBytes ? seedBytes.byteLength : 0;
  const allHeaders = { ...headers };
  let disposed = false;

  let readaheadBuf: Uint8Array | null = null;
  let readaheadStart = 0;
  let readaheadEnd = 0;
  let prefetchPromise: Promise<{ data: Uint8Array; start: number } | null> | null = null;
  let prefetchOffset = 0;

  async function fetchRange(start: number, end: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    let pos = start;
    let emptyRetries = 0;

    while (pos <= end) {
      if (disposed) throw new Error('[TauriStreamSource] disposed during fetch');

      const rangeEnd = Math.min(end, fileSize - 1);
      if (pos > rangeEnd) break;

      const requestedSize = rangeEnd - pos + 1;
      let chunk: Uint8Array | null = null;

      for (let attempt = 0; attempt <= MAX_503_RETRIES; attempt++) {
        if (disposed) throw new Error('[TauriStreamSource] disposed during fetch');

        const response = await fetch(url, {
          headers: { ...allHeaders, Range: `bytes=${pos}-${rangeEnd}` },
        });

        if (response.ok || response.status === 206) {
          chunk = new Uint8Array(await response.arrayBuffer());
          break;
        }

        if (response.status === 503) {
          const reason = response.headers.get('X-Reason') || '';
          if (reason === 'cached-only-miss') {
            throw new Error(`[TauriStreamSource] Range ${pos}-${rangeEnd} not cached (cached_only=503)`);
          }
          if (attempt < MAX_503_RETRIES) {
            const retryAfter = parseInt(response.headers.get('Retry-After') || '30', 10);
            const delay = Math.min(retryAfter * 1000, RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS);
            console.warn(`[TauriStreamSource] HTTP 503 for range ${pos}-${rangeEnd}, retry ${attempt + 1}/${MAX_503_RETRIES} in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
        }

        throw new Error(`[TauriStreamSource] HTTP ${response.status} for range ${pos}-${rangeEnd}`);
      }

      if (!chunk) throw new Error(`[TauriStreamSource] HTTP 503 max retries exceeded for range ${pos}-${rangeEnd}`);

      if (chunk.length === 0) {
        emptyRetries++;
        if (emptyRetries >= MAX_EMPTY_RETRIES) {
          throw new Error(`[TauriStreamSource] No data available after ${MAX_EMPTY_RETRIES} retries for range ${pos}-${rangeEnd}`);
        }
        await new Promise(r => setTimeout(r, EMPTY_RETRY_DELAY_MS));
        continue;
      }

      chunks.push(chunk);
      totalLen += chunk.length;
      pos += chunk.length;
      emptyRetries = 0;

      if (chunk.length < requestedSize) {
        await new Promise(r => setTimeout(r, PARTIAL_RETRY_DELAY_MS));
      }
    }

    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    return result;
  }

  function startPrefetch(afterEnd: number) {
    if (disposed || afterEnd >= fileSize || prefetchPromise) return;
    const start = afterEnd;
    const end = Math.min(start + READAHEAD_CHUNK_SIZE - 1, fileSize - 1);
    prefetchOffset = start;
    prefetchPromise = fetchRange(start, end)
      .then(data => ({ data, start }))
      .catch(() => {
        prefetchPromise = null;
        return null;
      });
  }

  async function ensureBufferCovers(neededStart: number): Promise<void> {
    if (readaheadBuf && neededStart >= readaheadStart && neededStart < readaheadEnd) return;

    if (prefetchPromise && neededStart >= prefetchOffset && neededStart < prefetchOffset + READAHEAD_CHUNK_SIZE) {
      const result = await prefetchPromise;
      prefetchPromise = null;
      if (result && !disposed) {
        readaheadBuf = result.data;
        readaheadStart = result.start;
        readaheadEnd = result.start + result.data.length;
        startPrefetch(readaheadEnd);
      }
      if (readaheadBuf && neededStart >= readaheadStart && neededStart < readaheadEnd) return;
    }

    const fetchStart = neededStart;
    const fetchEnd = Math.min(fetchStart + READAHEAD_CHUNK_SIZE - 1, fileSize - 1);
    const chunk = await fetchRange(fetchStart, fetchEnd);
    readaheadBuf = chunk;
    readaheadStart = fetchStart;
    readaheadEnd = fetchStart + chunk.length;
    startPrefetch(readaheadEnd);
  }

  return new CustomSource({
    getSize: async () => fileSize,
    read: async (start: number, end: number) => {
      const totalRequested = end - start;
      const result = new Uint8Array(totalRequested);
      let filled = 0;

      if (seedLength > 0 && !prefetchPromise && !readaheadBuf) {
        startPrefetch(seedLength);
      }

      if (seedBytes && start < seedLength) {
        const seedEnd = Math.min(end, seedLength);
        filled = seedEnd - start;
        result.set(seedBytes.subarray(start, seedEnd), 0);
        if (filled >= totalRequested) return result;
      }

      let currentStart = start + filled;

      if (readaheadBuf && currentStart >= readaheadStart && currentStart < readaheadEnd) {
        const bufOffset = currentStart - readaheadStart;
        const available = Math.min(readaheadEnd - currentStart, totalRequested - filled);
        result.set(readaheadBuf.subarray(bufOffset, bufOffset + available), filled);
        filled += available;
        currentStart += available;
        if (filled >= totalRequested) return result;
      }

      if (filled < totalRequested) {
        await ensureBufferCovers(currentStart);
        if (readaheadBuf && currentStart >= readaheadStart && currentStart < readaheadEnd) {
          const bufOffset = currentStart - readaheadStart;
          const available = Math.min(readaheadEnd - currentStart, totalRequested - filled);
          result.set(readaheadBuf.subarray(bufOffset, bufOffset + available), filled);
          filled += available;
          currentStart += available;
          if (filled >= totalRequested) return result;
        }
      }

      while (filled < totalRequested) {
        if (disposed) throw new Error('[TauriStreamSource] disposed during read');

        const remaining = totalRequested - filled;
        const rangeEnd = Math.min(currentStart + remaining - 1, fileSize - 1);
        if (currentStart > rangeEnd) break;

        const chunk = await fetchRange(currentStart, rangeEnd);
        const copyLen = Math.min(chunk.length, remaining);
        result.set(chunk.subarray(0, copyLen), filled);
        filled += copyLen;
        currentStart += copyLen;

        if (chunk.length < remaining) {
          await new Promise(r => setTimeout(r, PARTIAL_RETRY_DELAY_MS));
        }
      }

      if (filled < totalRequested) {
        throw new Error(`[TauriStreamSource] Could not fill requested range: got ${filled}/${totalRequested} bytes for range ${start}-${end - 1}`);
      }

      return result;
    },
    dispose: () => {
      disposed = true;
      readaheadBuf = null;
      prefetchPromise = null;
      console.log('[TauriStreamSource] disposed');
    },
    maxCacheSize,
    prefetchProfile,
  });
}
