/**
 * StreamShadowCache — JS-side byte cache for instant seeks
 *
 * Stores raw TS bytes that have already been fetched from the server.
 * When mpegts.js needs those bytes again (lazyLoad resume, seek-backward),
 * the cache serves them from memory — no HTTP round-trip needed.
 *
 * This bypasses Chromium's SourceBuffer quota limit (~150-300MB) because
 * raw bytes in ArrayBuffer are NOT counted toward that quota.
 *
 * Architecture:
 *   mpegts.js FetchStreamLoader → self.fetch(url, {Range: bytes=X-})
 *       ↓
 *   fetch interceptor (installed on window.fetch)
 *       ├─ Fully cached:     return Response from memory (0ms latency)
 *       ├─ Partially cached: return cached bytes + chain server for remainder
 *       └─ Not cached:       forward to server, tee stream to cache + mpegts.js
 *
 * Bar color mapping:
 *   Gray/White = SourceBuffer (video.buffered) — instant seeks
 *   Green      = Disk cache (cmd_get_cache_status) — fast seeks
 *   + ShadowCache feeds into both: cached bytes → faster lazyLoad resume → more
 *     SourceBuffer data stays current; server CACHE-PREFIX is bypassed entirely
 *     for fully-cached ranges.
 */

export interface ByteRange {
  start: number;   // byte offset in file
  end: number;     // byte offset of last byte (inclusive)
  data: Uint8Array;
}

export class StreamShadowCache {
  private entries: ByteRange[] = [];  // sorted by start, non-overlapping, merged
  private _totalBytes: number = 0;
  private maxBytes: number;
  private _fileLength: number = 0;
  private _urlKey: string = '';   // substring to match stream URLs, e.g. "/stream/3574767635/3"

  constructor(maxBytes = 300 * 1024 * 1024) {  // 300MB default
    this.maxBytes = maxBytes;
  }

  get fileLength(): number { return this._fileLength; }
  get urlKey(): string { return this._urlKey; }
  get totalBytes(): number { return this._totalBytes; }
  get entryCount(): number { return this.entries.length; }

  /** Reset cache for a new video. */
  reset(urlKey: string, fileLength: number) {
    this.entries = [];
    this._totalBytes = 0;
    this._urlKey = urlKey;
    this._fileLength = fileLength;
  }

  /** Store bytes in the cache. Merges with adjacent/overlapping entries. */
  put(start: number, data: Uint8Array): void {
    if (data.length === 0) return;
    const end = start + data.length - 1;

    // Find insertion point
    let i = 0;
    while (i < this.entries.length && this.entries[i].end < start - 1) {
      i++;
    }

    // Determine merge range: all entries that overlap or are adjacent to [start, end]
    const toMerge: ByteRange[] = [];
    let j = i;
    while (j < this.entries.length && this.entries[j].start <= end + 1) {
      toMerge.push(this.entries[j]);
      j++;
    }

    // Build merged entry
    const allRanges = [...toMerge, { start, end, data }];
    const mergedStart = Math.min(...allRanges.map(r => r.start));
    const mergedEnd = Math.max(...allRanges.map(r => r.end));
    const mergedLen = mergedEnd - mergedStart + 1;

    const mergedData = new Uint8Array(mergedLen);
    // First, zero-fill (shouldn't be needed if ranges are contiguous, but safety)
    // Then copy each range's data
    for (const r of allRanges) {
      if (r.start === start && r.data === data) {
        // This is the new data being inserted
        mergedData.set(data, r.start - mergedStart);
      } else {
        // This is an existing entry — copy from its data
        const offset = r.start - mergedStart;
        mergedData.set(r.data, offset);
      }
    }

    // Remove old entries and insert merged
    const removedBytes = toMerge.reduce((s, e) => s + e.data.length, 0);
    this.entries.splice(i, j - i, { start: mergedStart, end: mergedEnd, data: mergedData });
    this._totalBytes += mergedData.length - removedBytes;

    // Evict if over budget
    this.evict();
  }

  /**
   * Get the furthest byte offset that is contiguously cached from `from`.
   * Returns `from - 1` if nothing is cached at `from`.
   */
  cachedUpTo(from: number): number {
    for (const entry of this.entries) {
      if (entry.start <= from && entry.end >= from) {
        return entry.end;
      }
      if (entry.start > from) break;
    }
    return from - 1;
  }

  /**
   * Get cached bytes for range [from, to].
   * Returns null if the range is not fully cached in a single contiguous entry.
   */
  getRange(from: number, to: number): Uint8Array | null {
    for (const entry of this.entries) {
      if (entry.start <= from && entry.end >= to) {
        const offset = from - entry.start;
        const length = to - from + 1;
        return entry.data.subarray(offset, offset + length);
      }
    }
    return null;
  }

  /** Evict oldest (lowest byte offset) entries to stay under maxBytes. */
  private evict(): void {
    while (this._totalBytes > this.maxBytes && this.entries.length > 1) {
      const removed = this.entries.shift()!;
      this._totalBytes -= removed.data.length;
    }
  }

  /** Trim cache to keep only bytes within ±windowBytes around centerByte. */
  trimAround(centerByte: number, windowBytes: number): void {
    const minByte = Math.max(0, centerByte - windowBytes);
    const maxByte = centerByte + windowBytes;
    this.entries = this.entries.filter(entry => {
      if (entry.end < minByte || entry.start > maxByte) {
        this._totalBytes -= entry.data.length;
        return false;
      }
      return true;
    });
  }

  /** Stats for debugging. */
  getStats(): { entries: number; totalMB: number; maxMB: number; ranges: string } {
    const ranges = this.entries.length <= 5
      ? this.entries.map(e => `${e.start}-${e.end}`).join(', ')
      : `${this.entries[0].start}-${this.entries[0].end}, ... ${this.entries.length - 2} more ... , ${this.entries[this.entries.length - 1].start}-${this.entries[this.entries.length - 1].end}`;
    return {
      entries: this.entries.length,
      totalMB: Math.round(this._totalBytes / (1024 * 1024)),
      maxMB: Math.round(this.maxBytes / (1024 * 1024)),
      ranges,
    };
  }
}

// ─── Fetch Interceptor ────────────────────────────────────────────────────

let shadowCache: StreamShadowCache | null = null;
let originalFetch: typeof window.fetch | null = null;
let statsLogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Install the fetch interceptor. All HTTP requests for the stream URL
 * will be checked against the shadow cache before hitting the server.
 */
export function installStreamCacheInterceptor(cache: StreamShadowCache): void {
  if (originalFetch) return;  // already installed
  shadowCache = cache;
  originalFetch = window.fetch;

  // Periodic stats log (every 30s)
  statsLogTimer = setInterval(() => {
    if (shadowCache) {
      const s = shadowCache.getStats();
      console.log(`[SHADOW-CACHE] entries=${s.entries}, ${s.totalMB}/${s.maxMB}MB, ranges=[${s.ranges}]`);
    }
  }, 30_000);

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Fast path: skip if cache is inactive
    if (!shadowCache || shadowCache.fileLength === 0) {
      return originalFetch!.call(window, input, init);
    }

    // Extract URL
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url;

    // Only intercept our stream URLs
    if (!url.includes(shadowCache.urlKey)) {
      return originalFetch!.call(window, input, init);
    }

    // Extract Range header
    let rangeFrom: number | null = null;
    let rangeToStr: string | null = null;

    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      if (h['Range']) {
        const m = h['Range'].match(/^bytes=(\d+)-(\d*)$/);
        if (m) {
          rangeFrom = parseInt(m[1]);
          rangeToStr = m[2] || null;
        }
      }
    }

    // No Range header → forward and cache from byte 0
    if (rangeFrom === null) {
      return forwardAndCache(input, init, 0);
    }

    const from = rangeFrom;
    const to = rangeToStr ? parseInt(rangeToStr) : shadowCache.fileLength - 1;

    // ── Check cache ──
    const cachedEnd = shadowCache.cachedUpTo(from);

    // Case 1: Fully cached
    if (cachedEnd >= to) {
      const cachedData = shadowCache.getRange(from, to);
      if (cachedData) {
        console.log(`[SHADOW-CACHE] HIT: bytes ${from}-${to} (${((to - from) / 1048576).toFixed(1)}MB) served from memory`);
        return createCacheResponse(from, to, cachedData, shadowCache.fileLength);
      }
    }

    // Case 2: Partially cached — serve what we have, then chain server for remainder
    if (cachedEnd >= from) {
      const cacheTo = cachedEnd;
      const cachedData = shadowCache.getRange(from, cacheTo);
      if (cachedData && cachedData.length > 0) {
        console.log(`[SHADOW-CACHE] PARTIAL: bytes ${from}-${cacheTo} from memory (${((cacheTo - from) / 1048576).toFixed(1)}MB), ${cacheTo + 1}-${to} from server`);
        // Modify Range header to request only the uncached portion
        const newHeaders = { ...(init?.headers as Record<string, string> || {}),
          Range: `bytes=${cacheTo + 1}-${rangeToStr || ''}` };
        const newInit = { ...init, headers: newHeaders };
        const serverResponse = await originalFetch!.call(window, input, newInit);
        return createChainedResponse(from, to, cachedData, serverResponse);
      }
    }

    // Case 3: Not cached — forward to server and cache the response
    return forwardAndCache(input, init, from);
  };

  console.log('[SHADOW-CACHE] Fetch interceptor installed');
}

/** Uninstall the fetch interceptor and clear state. */
export function uninstallStreamCacheInterceptor(): void {
  if (originalFetch) {
    window.fetch = originalFetch;
    originalFetch = null;
  }
  if (statsLogTimer) {
    clearInterval(statsLogTimer);
    statsLogTimer = null;
  }
  shadowCache = null;
  console.log('[SHADOW-CACHE] Fetch interceptor removed');
}

/** Get the current cache instance (for external stats queries). */
export function getShadowCache(): StreamShadowCache | null {
  return shadowCache;
}

// ─── Response Construction ────────────────────────────────────────────────

function createCacheResponse(from: number, to: number, data: Uint8Array, fileLength: number): Response {
  // Yield cached bytes as a single ReadableStream chunk, then close.
  // mpegts.js FetchStreamLoader._pump reads chunks from response.body.getReader().
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });

  return new Response(stream, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': 'video/mp2t',
      'Content-Range': `bytes ${from}-${to}/${fileLength}`,
      'Content-Length': String(data.length),
    }
  });
}

function createChainedResponse(
  from: number, to: number,
  cachedData: Uint8Array,
  serverResponse: Response
): Response {
  let bytePos = from + cachedData.length;

  const stream = new ReadableStream({
    async start(controller) {
      // 1. Yield cached bytes first (instant — no network wait)
      controller.enqueue(cachedData);

      // 2. Chain server response for the remainder, caching each chunk
      if (serverResponse.body) {
        const reader = serverResponse.body.getReader();
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            const chunk = result.value instanceof Uint8Array
              ? result.value
              : new Uint8Array(result.value);
            controller.enqueue(chunk);
            // Cache the server bytes
            shadowCache?.put(bytePos, chunk.slice());  // .slice() to detach from underlying buffer
            bytePos += chunk.length;
          }
        } catch (e) {
          // Server error during streaming — just end the stream
          console.warn('[SHADOW-CACHE] Server stream error during chain:', e);
        }
      }

      controller.close();
    }
  });

  return new Response(stream, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': 'video/mp2t',
      'Content-Range': `bytes ${from}-${to}/${shadowCache!.fileLength}`,
      'Content-Length': String(to - from + 1),
    }
  });
}

async function forwardAndCache(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  startByte: number
): Promise<Response> {
  const response = await originalFetch!.call(window, input, init);

  if (!response.body || !shadowCache) return response;

  // Tee the stream: one branch for mpegts.js, one for caching.
  // tee() internally buffers until both readers consume, but since both
  // read at similar rates (chunk-by-chunk), memory overhead is minimal.
  const [playerStream, cacheStream] = response.body.tee();

  let bytePos = startByte;
  const cacheReader = cacheStream.getReader();
  // Fire-and-forget: read cacheStream and store bytes
  (async () => {
    try {
      while (true) {
        const result = await cacheReader.read();
        if (result.done) break;
        const chunk = result.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result.value);
        shadowCache?.put(bytePos, chunk.slice());
        bytePos += chunk.length;
      }
    } catch { /* ignore — cache errors shouldn't affect playback */ }
  })();

  // Return playerStream to mpegts.js with original response metadata
  return new Response(playerStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
