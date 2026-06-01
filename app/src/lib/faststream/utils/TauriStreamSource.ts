/**
 * TauriStreamSource — Mediabunny CustomSource backed by HTTP byte-range requests.
 * Reads data progressively from any URL via fetch() with Range headers.
 * Used by MediabunnyTransmuxer to provide data to Mediabunny's Input for TS/MKV files.
 *
 * Handles partial HTTP responses: the backend may return fewer bytes than
 * requested when data is still being downloaded from Telegram. The read()
 * function fills the full requested range by making additional requests for
 * the remaining bytes, satisfying mediabunny's requirement that read() always
 * returns exactly (end - start) bytes.
 */

import { CustomSource } from 'mediabunny';

export interface TauriStreamSourceConfig {
  url: string;
  fileSize: number;
  headers?: Record<string, string>;
  maxCacheSize?: number;
  prefetchProfile?: 'none' | 'fileSystem' | 'network';
  /** In-memory seed data for reads within [0, seedData.byteLength].
   *  Served directly from memory (zero latency) — bypasses HTTP entirely.
   *  Used for the first ~20MB of TS files so mediabunny's readMetadata()
   *  (sequential 188-byte packet scan from byte 0) completes entirely
   *  within the seed, avoiding slow HTTP reads through the Tauri/WebView2
   *  bridge (~0.5-1s round-trip delay per request). */
  seedData?: ArrayBuffer;
}

const MAX_503_RETRIES = 8;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15000;
const MAX_EMPTY_RETRIES = 60; // Max retries when backend returns 0 bytes (data not downloaded yet)
const EMPTY_RETRY_DELAY_MS = 500; // Wait between empty retries
const PARTIAL_RETRY_DELAY_MS = 100; // Short wait between partial retries

export function createTauriStreamSource(config: TauriStreamSourceConfig): CustomSource {
  const { url, fileSize, headers = {}, maxCacheSize, prefetchProfile = 'network', seedData } = config;
  // Convert seedData to Uint8Array for fast subarray access on in-memory reads
  const seedBytes = seedData ? new Uint8Array(seedData) : null;
  const seedLength = seedBytes ? seedBytes.byteLength : 0;
  const allHeaders = { ...headers };
  let disposed = false;
  // Diagnostic counters — log summary after first 50 reads
  let seedReads = 0;
  let httpReads = 0;
  let seedBytesTotal = 0;
  let httpBytesTotal = 0;

  return new CustomSource({
    getSize: async () => fileSize,
    read: async (start: number, end: number) => {
      const totalRequested = end - start;

      const result = new Uint8Array(totalRequested);
      let filledFromSeed = 0;

      // Phase 1: Fill from seed data (in-memory, zero latency).
      // Reads within [0, seedLength] are served directly from the seed
      // ArrayBuffer — no HTTP round-trip through the Tauri/WebView2 bridge.
      // This eliminates the ~0.5-1s per-request latency that makes the
      // transmuxer init take 30+ seconds for seed-sized data.
      if (seedBytes && start < seedLength) {
        const seedEnd = Math.min(end, seedLength);
        filledFromSeed = seedEnd - start;
        result.set(seedBytes.subarray(start, seedEnd), 0);

        seedReads++;
        seedBytesTotal += filledFromSeed;

        if (filledFromSeed >= totalRequested) {
          // Entire range served from seed — instant return, no HTTP needed
          // Log summary after first 50 reads (during transmuxer init)
          if (seedReads + httpReads === 50 && seedLength > 0) {
            console.log(`[TauriStreamSource] seed summary after 50 reads: ${seedReads} from seed (${(seedBytesTotal/1024/1024).toFixed(1)}MB), ${httpReads} from HTTP (${(httpBytesTotal/1024).toFixed(0)}KB)`);
          }
          return result;
        }
      }

      // Phase 2: Fill remaining bytes from HTTP (existing retry logic).
      // For ranges fully beyond seedLength, or the HTTP portion of a
      // partial seed+HTTP read.
      if (filledFromSeed === 0) {
        httpReads++;
      }
      let filled = filledFromSeed;
      let currentStart = start + filledFromSeed;
      let emptyRetries = 0;

      while (filled < totalRequested) {
        if (disposed) throw new Error('[TauriStreamSource] disposed during read');

        const remaining = totalRequested - filled;
        const rangeEnd = Math.min(currentStart + remaining - 1, fileSize - 1);

        if (currentStart > rangeEnd) {
          // Beyond file end — shouldn't happen if fileSize is correct
          break;
        }

        let chunk: Uint8Array | null = null;

        // Fetch a chunk with 503 retry logic
        for (let attempt = 0; attempt <= MAX_503_RETRIES; attempt++) {
          if (disposed) throw new Error('[TauriStreamSource] disposed during read');

          const response = await fetch(url, {
            headers: {
              ...allHeaders,
              Range: `bytes=${currentStart}-${rangeEnd}`,
            },
          });

          if (response.ok || response.status === 206) {
            const data = await response.arrayBuffer();
            chunk = new Uint8Array(data);
            break; // Success — exit 503 retry loop
          }

          // 503 Service Unavailable — handle cached_only vs regular differently
          if (response.status === 503) {
            const reason = response.headers.get('X-Reason') || '';
            if (reason === 'cached-only-miss') {
              // cached_only=503: range not cached — fail immediately, don't retry.
              // The caller (thumbnail pipeline) should only read cached positions.
              throw new Error(`[TauriStreamSource] Range ${currentStart}-${rangeEnd} not cached (cached_only=503)`);
            }
            // Other 503 reasons (download-busy) — retry with exponential backoff
            if (attempt < MAX_503_RETRIES) {
              const retryAfter = parseInt(response.headers.get('Retry-After') || '30', 10);
              const delay = Math.min(retryAfter * 1000, RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS);
              console.warn(`[TauriStreamSource] HTTP 503 for range ${currentStart}-${rangeEnd}, retry ${attempt + 1}/${MAX_503_RETRIES} in ${delay}ms`);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
          }

          throw new Error(`[TauriStreamSource] HTTP ${response.status} for range ${currentStart}-${rangeEnd}`);
        }

        if (!chunk) {
          throw new Error(`[TauriStreamSource] HTTP 503 max retries exceeded for range ${currentStart}-${rangeEnd}`);
        }

        if (chunk.length === 0) {
          // Empty response — backend doesn't have this data yet
          emptyRetries++;
          if (emptyRetries >= MAX_EMPTY_RETRIES) {
            throw new Error(`[TauriStreamSource] No data available after ${MAX_EMPTY_RETRIES} retries for range ${currentStart}-${rangeEnd}`);
          }
          await new Promise(r => setTimeout(r, EMPTY_RETRY_DELAY_MS));
          continue;
        }

        // Copy chunk into result buffer (only take what we need)
        const copyLen = Math.min(chunk.length, remaining);
        result.set(chunk.subarray(0, copyLen), filled);
        filled += copyLen;
        currentStart += copyLen;
        emptyRetries = 0; // Reset on successful data

        if (chunk.length < remaining) {
          // Partial response — backend returned less than requested
          // Wait briefly for more data to become available from Telegram download
          await new Promise(r => setTimeout(r, PARTIAL_RETRY_DELAY_MS));
        }
      }

      if (filled < totalRequested) {
        throw new Error(`[TauriStreamSource] Could not fill requested range: got ${filled}/${totalRequested} bytes for range ${start}-${end - 1}`);
      }

      // Track HTTP bytes for diagnostic summary
      const httpBytesInRead = filled - filledFromSeed;
      if (httpBytesInRead > 0) {
        httpBytesTotal += httpBytesInRead;
        // Log summary after first 50 reads (during transmuxer init)
        if (seedReads + httpReads === 50 && seedLength > 0) {
          console.log(`[TauriStreamSource] seed summary after 50 reads: ${seedReads} from seed (${(seedBytesTotal/1024/1024).toFixed(1)}MB), ${httpReads} from HTTP (${(httpBytesTotal/1024).toFixed(0)}KB)`);
        }
      }

      return result;
    },
    dispose: () => {
      disposed = true;
      console.log('[TauriStreamSource] disposed');
    },
    maxCacheSize,
    prefetchProfile,
  });
}
