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
 *       ├─ Fully cached (small): return Response from memory (0ms latency)
 *       ├─ Not cached / large range: forward to server, siphon chunks to cache
 *       └─ (NO partial-chained mode — it causes abort crashes & DTS corruption)
 *
 * CRITICAL DESIGN NOTES:
 *
 *   1. Range header extraction: mpegts.js uses `new Headers()` for fetch
 *      init, so `init.headers` is a Headers object, NOT a plain object.
 *      Must use `headers.get('Range')`, NOT `headers['Range']`.
 *
 *   2. NO `tee()`: response.body.tee() keeps the HTTP connection alive
 *      after mpegts.js aborts (because the cache branch is still reading).
 *      This causes data to keep flowing into the demuxer after abort,
 *      corrupting DTS values and producing duration = 2^32/1000 overflow.
 *
 *   3. NO `createChainedResponse` (partial hit + server chain):
 *      Using ReadableStream `start()` eagerly reads ALL server data even
 *      after the player aborts. Using `pull()` fixes the abort issue but
 *      creates a new problem: the cached portion has already been processed
 *      by the demuxer on the previous fetch, so re-serving it causes the
 *      demuxer to re-process data it already transmuxed → DTS frame drops
 *      ("Dropping 1 audio frame ... dtsCorrection overlap" flood).
 *
 *      The CORRECT approach: let mpegts.js fetch from the server as normal
 *      (the server's CACHE-PREFIX feature serves cached bytes from disk),
 *      and only siphon the server's response chunks into the shadow cache
 *      for future HIT scenarios. For HIT scenarios, only serve the exact
 *      byte range mpegts.js requests — which is typically lazyLoadMaxDuration
 *      worth of data (~30s ≈ 15MB), well within SourceBuffer quota.
 *
 *   4. SourceBuffer quota: NEVER serve more than ~30MB in a single HIT.
 *      Large PARTIAL hits (156MB+) overflow SourceBuffer → crash.
 *      If the requested range exceeds the cap, fall through to server.
 */

export interface ByteRange {
  start: number;   // byte offset in file
  end: number;     // byte offset of last byte (inclusive)
  data: Uint8Array;
  dataOffset?: number;  // byte offset within `data` where valid bytes start (0 = full entry)
  dataLength?: number;  // number of valid bytes (data.length if omitted)
}

/** Max bytes to serve in a single HIT response. Matches the largest resume chunk. */
const MAX_HIT_SERVE_BYTES = alignChunkSize(10 * 1024 * 1024);

/** Max bytes to request from the server in one fetch. mpegts.js's native loader
 *  opens with an open-ended (or full-file) range, but our backend serves streaming
 *  responses via chunked transfer. Without a finite range, the loader treats the
 *  first chunk (512KB) as the whole response and completes early. Capping the
 *  request to an aligned 5MB for the first chunk and aligned 10MB for later chunks
 *  gives the player a real block of data per HTTP response while keeping chunk
 *  boundaries on 188-byte TS packet boundaries so the shadow cache stays contiguous
 *  and mpegts.js does not drop partial packets at the end of each chunk. */
const FIRST_CHUNK_MAX_BYTES = alignChunkSize(5 * 1024 * 1024);   // ~5MB, aligned to 188-byte TS packet
const SUBSEQUENT_CHUNK_MAX_BYTES = alignChunkSize(10 * 1024 * 1024); // ~10MB, aligned to 188-byte TS packet

/** Round a byte budget down to a multiple of the TS packet size (188). */
function alignChunkSize(size: number): number {
  return Math.floor(size / 188) * 188;
}

/** No hard siphon cap: the 300MB maxBytes limit is enforced by the cache itself. */

export class StreamShadowCache {
  private entries: ByteRange[] = [];  // sorted by start, non-overlapping, merged
  private _totalBytes: number = 0;
  readonly maxBytes: number;
  private _fileLength: number = 0;
  private _urlKey: string = '';   // substring to match stream URLs, e.g. "/stream/3574767635/3"
  /** Current total bytes stored in cache. */
  get totalBytes(): number { return this._totalBytes; }

  /** Read-only access to entry ranges for UI rendering. */
  get entryRanges(): { start: number; end: number }[] {
    return this.entries.map(e => ({ start: e.start, end: e.end }));
  }

  constructor(maxBytes = 300 * 1024 * 1024) {  // 300MB default
    this.maxBytes = maxBytes;
  }

  get fileLength(): number { return this._fileLength; }
  get urlKey(): string { return this._urlKey; }
  get entryCount(): number { return this.entries.length; }

  /** Reset cache for a new video. */
  reset(urlKey: string, fileLength: number) {
    this.entries = [];
    this._totalBytes = 0;
    this._urlKey = urlKey;
    this._fileLength = fileLength;
  }

  /** Check if a specific byte offset is covered by cached entries. */
  hasByte(offset: number): boolean {
    for (const entry of this.entries) {
      if (offset >= entry.start && offset <= entry.end) return true;
      if (entry.start > offset) break;  // entries are sorted
    }
    return false;
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
    for (const r of allRanges) {
      // Respect dataOffset/dataLength for trimmed entries
      const baseOffset = r.dataOffset ?? 0;
      const baseLength = r.dataLength ?? r.data.length;
      const validData = (baseOffset === 0 && baseLength === r.data.length)
        ? r.data
        : r.data.subarray(baseOffset, baseOffset + baseLength);
      if (r.start === start && r.data === data) {
        mergedData.set(validData, r.start - mergedStart);
      } else {
        mergedData.set(validData, r.start - mergedStart);
      }
    }

    // Remove old entries and insert merged
    const removedBytes = toMerge.reduce((s, e) => s + (e.dataLength ?? e.data.length), 0);
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
   * Return the contiguous cached byte range that covers `from`, or null if
   * `from` is not cached. Used by the cold-start overlay to report real progress.
   */
  cachedRunFrom(from: number): { start: number; end: number } | null {
    for (const entry of this.entries) {
      if (entry.start <= from && entry.end >= from) {
        return { start: entry.start, end: entry.end };
      }
      if (entry.start > from) break;
    }
    return null;
  }

  /**
   * Return the end of the last cached range that ends strictly before `byte`.
   * Useful for resuming downloads so we can keep the on-disk cache contiguous
   * instead of jumping ahead and leaving a fragmented white-bar gap.
   */
  rangeEndBefore(byte: number): number | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.end < byte) {
        return entry.end;
      }
    }
    return null;
  }

  /**
   * Get cached bytes for range [from, to].
   * Returns null if the range is not fully cached in a single contiguous entry.
   */
  getRange(from: number, to: number): Uint8Array | null {
    for (const entry of this.entries) {
      if (entry.start <= from && entry.end >= to) {
        const baseOffset = entry.dataOffset ?? 0;
        const offset = from - entry.start;
        const length = to - from + 1;
        return entry.data.subarray(baseOffset + offset, baseOffset + offset + length);
      }
    }
    return null;
  }

  /** Evict entries to stay under maxBytes. Evicts oldest (lowest byte offset) first.
   *  Also trims oversized entries from the start — NEVER clears everything. */
  private evict(): void {
    // Trim entries from the start (lowest byte offset = oldest data) until under budget.
    // We trim rather than clear to preserve data at higher byte offsets (which is
    // what the player needs after eviction resume).
    while (this._totalBytes > this.maxBytes && this.entries.length > 0) {
      const entry = this.entries[0];
      const baseLength = entry.dataLength ?? entry.data.length;
      const excess = this._totalBytes - this.maxBytes;
      const trimBytes = Math.min(excess, baseLength);
      if (trimBytes >= baseLength) {
        // Remove entire first entry
        this.entries.shift();
        this._totalBytes -= baseLength;
      } else {
        // Trim from the start (drop oldest bytes) — zero-copy via dataOffset
        const baseOffset = entry.dataOffset ?? 0;
        this.entries[0] = {
          start: entry.start + trimBytes,
          end: entry.end,
          data: entry.data,
          dataOffset: baseOffset + trimBytes,
          dataLength: baseLength - trimBytes,
        };
        this._totalBytes -= trimBytes;
        break;  // trimmed enough
      }
    }
  }

  /** Trim cache to keep only bytes within ±windowBytes around centerByte. */
  trimAround(centerByte: number, windowBytes: number): void {
    const minByte = Math.max(0, Math.floor(centerByte - windowBytes));
    const maxByte = Math.floor(centerByte + windowBytes);
    const newEntries: ByteRange[] = [];
    for (const entry of this.entries) {
      if (entry.end < minByte || entry.start > maxByte) {
        // Entire entry is outside the window — drop it
        const len = entry.dataLength ?? entry.data.length;
        this._totalBytes -= len;
        continue;
      }
      // Entry partially overlaps the window — trim via dataOffset/dataLength (zero-copy)
      const baseOffset = entry.dataOffset ?? 0;
      const baseLength = entry.dataLength ?? entry.data.length;
      let newStart = entry.start;
      let newEnd = entry.end;
      let newDataOffset = baseOffset;
      let newDataLength = baseLength;

      if (entry.start < minByte) {
        // Trim leading portion: [entry.start, minByte) is outside
        const trimBytes = minByte - entry.start;
        newDataOffset = baseOffset + trimBytes;
        newDataLength = baseLength - trimBytes;
        newStart = minByte;
      }
      if (entry.end > maxByte) {
        // Trim trailing portion: (maxByte, entry.end] is outside
        const trimBytes = entry.end - maxByte;
        newDataLength = (newDataLength ?? baseLength) - trimBytes;
        newEnd = maxByte;
      }
      const oldLen = baseLength;
      this._totalBytes -= oldLen - newDataLength;
      newEntries.push({
        start: newStart,
        end: newEnd,
        data: entry.data,
        dataOffset: newDataOffset,
        dataLength: newDataLength,
      });
    }
    this.entries = newEntries;
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
 * Extract Range header from various header formats.
 * mpegts.js uses `new Headers()` objects, not plain `{key: value}` objects.
 */
function extractRangeHeader(headers: HeadersInit | undefined): { from: number; toStr: string | null } | null {
  if (!headers) return null;

  // Try Headers object first (has .get() method)
  if (typeof (headers as any).get === 'function') {
    const rangeVal = (headers as any).get('Range');
    if (rangeVal) {
      const m = rangeVal.match(/^bytes=(\d+)-(\d*)$/);
      if (m) return { from: parseInt(m[1]), toStr: m[2] || null };
    }
    return null;
  }

  // Plain object
  if (typeof headers === 'object' && !Array.isArray(headers)) {
    const h = headers as Record<string, string>;
    for (const key in h) {
      if (key.toLowerCase() === 'range' && h[key]) {
        const m = h[key].match(/^bytes=(\d+)-(\d*)$/);
        if (m) return { from: parseInt(m[1]), toStr: m[2] || null };
      }
    }
  }

  // Array of [key, value] pairs
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      const [key, value] = pair;
      if (key.toLowerCase() === 'range' && value) {
        const m = value.match(/^bytes=(\d+)-(\d*)$/);
        if (m) return { from: parseInt(m[1]), toStr: m[2] || null };
      }
    }
  }

  return null;
}

/**
 * Install the fetch interceptor. All HTTP requests for the stream URL
 * will be checked against the shadow cache before hitting the server.
 *
 * Strategy:
 *   - FULL HIT (range ≤ 30MB): serve from memory — 0ms latency
 *   - FULL HIT (range > 30MB): fall through to server (too large for SourceBuffer)
 *   - PARTIAL / MISS: forward to server, siphon chunks to cache for future hits
 *   - NO "chained" responses (serving cached + server data in one stream) —
 *     that causes abort crashes and DTS corruption
 */
/**
 * Rewrite an open-ended Range header (e.g. "bytes=0-" or no Range header) into a
 * finite range so the server returns a real Content-Length response. mpegts.js
 * opens with an open-ended range, and our backend's chunked subscriber responses
 * otherwise look like an EOF to the loader.
 *
 * Returns a new init object with the capped Range header, and the effective
 * [from, to] range. If the original request was already finite, it is returned
 * unchanged.
 */
function capRequestRange(
  init: RequestInit | undefined,
  from: number,
  toStr: string | null,
  fileLength: number
): { init: RequestInit | undefined; to: number } {
  if (toStr !== null && toStr !== '') {
    return { init, to: parseInt(toStr, 10) };
  }

  const chunkSize = from === 0 ? FIRST_CHUNK_MAX_BYTES : SUBSEQUENT_CHUNK_MAX_BYTES;
  const to = Math.min(fileLength - 1, from + chunkSize - 1);
  const rangeValue = `bytes=${from}-${to}`;

  // Build new headers preserving everything else.
  let headers: Headers;
  if (init?.headers) {
    if (typeof (init.headers as any).get === 'function') {
      headers = new Headers(init.headers as Headers);
      headers.set('Range', rangeValue);
    } else if (Array.isArray(init.headers)) {
      headers = new Headers(init.headers);
      headers.set('Range', rangeValue);
    } else {
      headers = new Headers(init.headers as Record<string, string>);
      headers.set('Range', rangeValue);
    }
  } else {
    headers = new Headers({ Range: rangeValue });
  }

  return { init: { ...init, headers }, to };
}

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
    if (url.indexOf(shadowCache.urlKey) === -1) {
      return originalFetch!.call(window, input, init);
    }

    // ── Extract Range header BEFORE interceptor pause check ──
    // CRITICAL: forwardAndSiphon uses startByte to position siphoned data
    // in the cache. If startByte is wrong (e.g., 0 when the Range is
    // bytes=52428800-...), the cached data is stored at the WRONG offset.
    // Later HIT responses serve corrupt data → sync_byte errors in mpegts.js.
    const rangeInfo = extractRangeHeader(init?.headers);
    const from = rangeInfo ? rangeInfo.from : 0;
    const toStr = rangeInfo ? rangeInfo.toStr : null;
    let to = toStr ? parseInt(toStr) : shadowCache.fileLength - 1;

    // ── Cap open-ended ranges so the server returns a finite response ──
    // mpegts.js opens with an open-ended range (e.g. "bytes=0-"). Our backend
    // serves these via chunked transfer, and mpegts.js interprets the first 512KB
    // chunk as the complete response, calling endOfStream prematurely. Capping
    // to a finite range forces a real Content-Length response and lets the
    // endOfStream guard resume for the next chunk.
    let effectiveInit = init;
    let effectiveTo = to;
    if (toStr === null || toStr === '') {
      const capped = capRequestRange(init, from, toStr, shadowCache.fileLength);
      effectiveInit = capped.init;
      effectiveTo = capped.to;
    }
    const effectiveRangeSize = effectiveTo - from + 1;

    // ── Check cache for FULL HIT only ──
    // Only serve from cache if:
    //   1. The entire requested range is cached contiguously
    //   2. The range size is ≤ 30MB (safe for SourceBuffer)
    // Otherwise, let the server handle it (server has CACHE-PREFIX for disk-cached data).
    if (effectiveRangeSize <= MAX_HIT_SERVE_BYTES) {
      const cachedEnd = shadowCache.cachedUpTo(from);
      if (cachedEnd >= effectiveTo) {
        const cachedData = shadowCache.getRange(from, effectiveTo);
        if (cachedData) {
          console.log(`[SHADOW-CACHE] HIT: bytes ${from}-${effectiveTo} (${(effectiveRangeSize / 1048576).toFixed(1)}MB) served from memory`);
          return createCacheResponse(from, effectiveTo, cachedData, shadowCache.fileLength);
        }
      }
    } else if (shadowCache.cachedUpTo(from) >= effectiveTo) {
      // Large range fully cached but too big for SourceBuffer — log and skip
      console.log(`[SHADOW-CACHE] SKIP-HIT: bytes ${from}-${effectiveTo} (${(effectiveRangeSize / 1048576).toFixed(1)}MB) fully cached but exceeds ${MAX_HIT_SERVE_BYTES / 1048576}MB cap — server will serve with CACHE-PREFIX`);
    }

    // ── Forward to server and siphon chunks to cache ──
    return forwardAndSiphon(input, effectiveInit, from);
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

function createCacheResponse(
  from: number, to: number, data: Uint8Array, fileLength: number
): Response {
  return new Response(data.slice(), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': 'video/mp2t',
      'Content-Range': `bytes ${from}-${to}/${fileLength}`,
      'Content-Length': String(data.length),
    }
  });
}

/**
 * Forward request to server and siphon chunks to cache.
 *
 * Uses pull-based ReadableStream so that when mpegts.js aborts the fetch
 * (lazyLoad suspend), the pull() callback stops being called, the server
 * response is dropped, and the HTTP connection closes immediately.
 *
 * This avoids both:
 *   - tee() keeping the connection alive after abort (DTS corruption)
 *   - start() eagerly reading all data after the stream is closed (enqueue crash)
 */
function forwardAndSiphon(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  startByte: number
): Promise<Response> {
  return originalFetch!.call(window, input, init).then((response) => {
    if (!response.body || !shadowCache) return response;

    const serverReader = response.body.getReader();
    let bytePos = startByte;
    let serverDone = false;

    const playerStream = new ReadableStream({
      async pull(controller) {
        if (serverDone) {
          controller.close();
          return;
        }

        try {
          const result = await serverReader.read();
          if (result.done) {
            serverDone = true;
            controller.close();
            return;
          }

          const chunk = result.value instanceof Uint8Array
            ? result.value
            : new Uint8Array(result.value);

          // Forward to player immediately at full speed.
          controller.enqueue(chunk.slice());

          // Siphon the same chunk to the shadow cache for future HITs.
          try {
            if (shadowCache) {
              shadowCache.put(bytePos, chunk.slice());
            }
          } catch { /* cache errors are non-fatal */ }
          bytePos += chunk.length;

        } catch (e) {
          serverDone = true;
          controller.error(e);
        }
      },

      cancel() {
        // Player cancelled (abort) — release the server reader
        serverReader.cancel().catch(() => {});
        serverDone = true;
      }
    });

    return new Response(playerStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });
}
