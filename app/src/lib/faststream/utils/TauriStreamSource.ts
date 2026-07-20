import { CustomSource } from 'mediabunny';

export interface TauriStreamSourceConfig {
  url: string;
  fileSize: number;
  headers?: Record<string, string>;
  maxCacheSize?: number;
  prefetchProfile?: 'none' | 'fileSystem' | 'network';
  seedData?: ArrayBuffer;
  /** Stable id tagged onto every /stream request as `&source_id=`. The backend
   *  coordinator only zombie-cancels concurrent downloads that share a source_id
   *  (source_ids_match), so distinct ids (e.g. 'playback' vs 'thumbnail') stop
   *  the thumbnail pipeline and the player from cancelling each other. Tail-zone
   *  reads (MKV Cues at file end) are additionally suffixed '-tail' so the
   *  one-time metadata read doesn't cross-cancel the forward playback walk. */
  sourceId?: string;
}

const MAX_503_RETRIES = 8;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15000;
const MAX_EMPTY_RETRIES = 60;
const EMPTY_RETRY_DELAY_MS = 500;
const PARTIAL_RETRY_DELAY_MS = 100;
const READAHEAD_CHUNK_SIZE = 8 * 1024 * 1024;
// Scattered (seek-search) reads fetch a SMALLER window than sequential playback.
// A cold seek's getKeyPacket walks from the cue cluster to the target keyframe;
// trace-28 measured it CONSUMING only ~2-3MB (max 3.10MB) while we FETCHED the
// full 8MB — ~5MB of pure over-fetch that the seek blocks on at contended
// bandwidth. 4MB covers the observed max with margin in a single fetch (1MB
// failed before because <the ~3MB need forced a 2nd blocking read). Sequential
// playback keeps the full 8MB so throughput/prefetch-ahead is unchanged.
const SCATTERED_READAHEAD_SIZE = 4 * 1024 * 1024;

export function createTauriStreamSource(config: TauriStreamSourceConfig): CustomSource {
  const { url, fileSize, headers = {}, maxCacheSize, prefetchProfile = 'network', seedData, sourceId } = config;
  const seedBytes = seedData ? new Uint8Array(seedData) : null;
  const seedLength = seedBytes ? seedBytes.byteLength : 0;
  const allHeaders = { ...headers };
  let disposed = false;

  // Build source_id-tagged URLs once. Body reads use `sourceId`; reads landing in
  // the file-tail zone (MKV Cues/SeekHead) use `sourceId-tail` so the one-time
  // metadata read isn't cross-cancelled by the forward playback walk in the
  // backend coordinator (which only cancels downloads sharing a source_id).
  const TAIL_ZONE_START = fileSize > 32 * 1024 * 1024 ? fileSize - 32 * 1024 * 1024 : fileSize;
  const buildUrl = (sid: string | undefined): string => {
    if (!sid) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}source_id=${encodeURIComponent(sid)}`;
  };
  const bodyUrl = buildUrl(sourceId);
  const tailUrl = buildUrl(sourceId ? `${sourceId}-tail` : undefined);
  const urlForPos = (pos: number): string =>
    (sourceId && pos >= TAIL_ZONE_START) ? tailUrl : bodyUrl;

  let readaheadBuf: Uint8Array | null = null;
  let readaheadStart = 0;
  let readaheadEnd = 0;
  let prefetchPromise: Promise<{ data: Uint8Array; start: number } | null> | null = null;
  let prefetchOffset = 0;

  // Tracks the end of the last SEQUENTIAL read so we can distinguish steady
  // playback (which benefits from read-ahead prefetch) from scattered seek
  // reads. mediabunny's getKeyPacket() binary-searches a large MKV — dozens of
  // far-apart reads (tail Cues → mid clusters). Firing a sequential prefetch
  // after each scattered jump registers a far-away download that the backend
  // coordinator then cancels as a "zombie" when the next jump lands >8MB away,
  // producing an endless cancel loop (588MB↔447MB↔79MB) where getKeyPacket
  // never completes and the unbuffered seek hangs forever. Only prefetch when
  // the read continues near where the last one ended (true sequential playback).
  let lastSeqReadEnd = -1;
  const SEQ_GAP_TOLERANCE = 4 * 1024 * 1024; // 4 MB — within one read-ahead window

  // AbortController for the CURRENT in-flight fetch. abortInFlight() (called by
  // MediabunnyTransmuxer.seekTo when a new seek supersedes a running refill)
  // aborts it so the stale read stops IMMEDIATELY instead of running to
  // completion and keeping its backend download registered — which otherwise
  // ping-pongs with the new seek's download in the coordinator's zombie-cancel
  // logic (both share source_id=None), and neither ever finishes → seek hangs.
  // Set (not a single var) because TWO fetches can be in flight at once: the
  // main read AND the background prefetch (startPrefetch). A shared scalar would
  // let the later fetch overwrite the earlier's controller, so abortInFlight()
  // would silently orphan one — the stale read keeps its backend slot and the
  // zombie-cancel ping-pong returns. Tracking every live controller makes abort
  // airtight: it cancels the read AND the prefetch together.
  const inFlightAborts = new Set<AbortController>();
  // Byte position of the cluster where the last seek's forward fMP4 iteration
  // began — the REAL (byte, keyframeTime) pair for VBR byte↔time calibration.
  // NOT the Cues/SeekHead tail read (~fileLength) that getKeyPacket does to
  // LOCATE the keyframe: anchoring on that maps ~99%-of-file bytes to ~39%-of-
  // duration time, wrecking the green prebuffer bar. markSeekResolved() arms a
  // capture so the NEXT read's start (the cluster) is recorded instead.
  let clusterByteOfLastSeek = -1;
  let captureNextReadStart = false;

  // PROBE (trace-27): byte-accounting to split a cold seek's cost into SEARCH
  // (bytes getKeyPacket reads walking from the cue cluster to the target
  // keyframe) vs PLAYBACK (bytes the forward fMP4 iteration reads after the
  // keyframe resolves). markSeekStart() arms the counter at seekTo entry;
  // fetchRange adds every network byte while armed; markSeekResolved() logs the
  // SEARCH total. Only THIS source's own fetches are counted, so interleaved
  // warmer / stale-playback streams don't pollute the number. Remove once the
  // search-vs-playback split is confirmed and the fix lever is chosen.
  let seekSearchActive = false;
  let seekSearchBytes = 0;    // bytes FETCHED over the network (8MB readahead units)
  let seekSearchConsumed = 0; // bytes mediabunny actually REQUESTED (the real need)

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

        const abort = new AbortController();
        inFlightAborts.add(abort);
        // finally removes THIS controller from the live set at every exit
        // (break/continue/throw) so a settled fetch is never abort-able and the
        // set holds only genuinely in-flight controllers.
        try {
          let response: Response;
          try {
            response = await fetch(urlForPos(pos), {
              headers: { ...allHeaders, Range: `bytes=${pos}-${rangeEnd}` },
              signal: abort.signal,
            });
          } catch (e: any) {
            if (e?.name === 'AbortError') {
              // Superseded by a newer seek — stop cleanly so the backend download
              // slot is freed immediately for the new seek (no zombie ping-pong).
              throw new Error('[TauriStreamSource] read aborted (superseded by seek)');
            }
            throw e;
          }

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
        } finally {
          inFlightAborts.delete(abort);
        }
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
      if (seekSearchActive) seekSearchBytes += chunk.length; // PROBE: count search bytes

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

  // Only prefetch-ahead for SEQUENTIAL reads. Scattered seek reads (getKeyPacket
  // binary search) must NOT prefetch — see lastSeqReadEnd comment above.
  function maybePrefetch(afterEnd: number, sequential: boolean) {
    if (sequential) startPrefetch(afterEnd);
  }

  async function ensureBufferCovers(neededStart: number, sequential: boolean): Promise<void> {
    if (readaheadBuf && neededStart >= readaheadStart && neededStart < readaheadEnd) return;

    if (prefetchPromise && neededStart >= prefetchOffset && neededStart < prefetchOffset + READAHEAD_CHUNK_SIZE) {
      const result = await prefetchPromise;
      prefetchPromise = null;
      if (result && !disposed) {
        readaheadBuf = result.data;
        readaheadStart = result.start;
        readaheadEnd = result.start + result.data.length;
        maybePrefetch(readaheadEnd, sequential);
      }
      if (readaheadBuf && neededStart >= readaheadStart && neededStart < readaheadEnd) return;
    }

    // Scattered seek reads fetch the smaller 4MB window (trace-28: getKeyPacket
    // consumes ≤3.1MB); sequential playback fetches the full 8MB for throughput.
    const readaheadSize = sequential ? READAHEAD_CHUNK_SIZE : SCATTERED_READAHEAD_SIZE;
    const fetchStart = neededStart;
    const fetchEnd = Math.min(fetchStart + readaheadSize - 1, fileSize - 1);
    const chunk = await fetchRange(fetchStart, fetchEnd);
    readaheadBuf = chunk;
    readaheadStart = fetchStart;
    readaheadEnd = fetchStart + chunk.length;
    maybePrefetch(readaheadEnd, sequential);
  }

  const source = new CustomSource({
    getSize: async () => fileSize,
    read: async (start: number, end: number) => {
      const totalRequested = end - start;
      // PROBE (trace-28): count bytes mediabunny actually REQUESTS during the
      // seek search (vs the 8MB readahead we fetch). If consumed << 8MB, the
      // search is reducible: a smaller readahead for scattered reads (or
      // metadataOnly) would cut it. If consumed ≈ 8MB, the search genuinely
      // needs the data and the only lever is bandwidth (kill stale streams).
      if (seekSearchActive) seekSearchConsumed += totalRequested;
      const result = new Uint8Array(totalRequested);
      let filled = 0;

      // Sequential = this read continues at (or very near) where the last read
      // ended. Playback reads march forward and are sequential; getKeyPacket
      // seek-search reads jump far and are not. Only sequential reads trigger
      // read-ahead prefetch (see lastSeqReadEnd comment). The very first read
      // (lastSeqReadEnd < 0) counts as sequential to prime the initial buffer.
      const sequential = lastSeqReadEnd < 0 || Math.abs(start - lastSeqReadEnd) <= SEQ_GAP_TOLERANCE;
      lastSeqReadEnd = end;
      // If a seek just resolved (markSeekResolved), the NEXT read starts the
      // forward fMP4 iteration at the real cluster byte — capture it as the
      // VBR calibration anchor's byte (paired with the seek's keyframe time).
      if (captureNextReadStart) {
        clusterByteOfLastSeek = start;
        captureNextReadStart = false;
      }

      if (seedLength > 0 && !prefetchPromise && !readaheadBuf) {
        maybePrefetch(seedLength, sequential);
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
        try {
          await ensureBufferCovers(currentStart, sequential);
        } catch (e) {
          if (disposed) return result.subarray(0, filled); // teardown mid-read
          throw e;
        }
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
        if (disposed) {
          // Teardown mid-read: the player was disposed while this read awaited
          // an HTTP range. Returning the partially-filled buffer (instead of
          // throwing) avoids an uncaught promise rejection in mediabunny's
          // worker (observed: "[TauriStreamSource] disposed during fetch" at
          // source.js _runWorker). The result is discarded on dispose anyway.
          return result.subarray(0, filled);
        }

        const remaining = totalRequested - filled;
        const rangeEnd = Math.min(currentStart + remaining - 1, fileSize - 1);
        if (currentStart > rangeEnd) break;

        let chunk: Uint8Array;
        try {
          chunk = await fetchRange(currentStart, rangeEnd);
        } catch (e) {
          // fetchRange throws "[TauriStreamSource] disposed during fetch" if the
          // player is torn down mid-await. Swallow ONLY that case (return what
          // we have); re-throw genuine errors so real failures still surface.
          if (disposed) return result.subarray(0, filled);
          throw e;
        }
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

  // Expose an in-flight abort so a superseding seek can free the backend
  // download slot immediately (see inFlightAbort comment). Attached to the
  // instance because CustomSource's options don't include a control channel.
  (source as any).abortInFlight = () => {
    // Abort EVERY live fetch (read + prefetch), not just the last one, so no
    // stale request survives to keep its backend slot. Each fetch's finally
    // removes itself from the set; abort() on an already-settled controller is
    // a no-op, so iterating a snapshot is safe.
    for (const abort of inFlightAborts) abort.abort();
    inFlightAborts.clear();
  };
  // PROBE (trace-27): arm search byte-accounting at seekTo entry.
  (source as any).markSeekStart = () => { seekSearchActive = true; seekSearchBytes = 0; seekSearchConsumed = 0; };
  // Arm cluster-byte capture: call right after getKeyPacket resolves so the
  // next read (the forward fMP4 iteration) records the real cluster byte.
  // PROBE: also stop + log the SEARCH byte total (bytes read from cue cluster
  // to the resolved keyframe) — the reducible portion, vs playback bytes after.
  (source as any).markSeekResolved = () => {
    captureNextReadStart = true;
    if (seekSearchActive) {
      console.log(`[TauriStreamSource] SEEK SEARCH fetched=${(seekSearchBytes / 1048576).toFixed(2)}MB consumed=${(seekSearchConsumed / 1048576).toFixed(2)}MB (${seekSearchConsumed}B) — consumed<<fetched ⇒ reducible; consumed≈fetched ⇒ bandwidth-bound`);
      seekSearchActive = false;
    }
  };
  // Real cluster byte of the last resolved seek — pair with the seek's keyframe
  // time to add a VBR byte↔time anchor. -1 if not captured yet.
  (source as any).getClusterByteOfLastSeek = () => clusterByteOfLastSeek;
  return source;
}
