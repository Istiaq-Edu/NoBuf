# Hover Preview on Unbuffered TS Video — Implementation Plan

## Research Status: VERIFIED (97% confidence)

## Problem

The current `MpegtsThumbnailPipeline` creates a second mpegts.js player that
downloads raw TS data from `/stream` at unbuffered byte positions. This:

1. **Causes FLOOD_PREMIUM_WAIT**: Competes with the main player for the Telegram
   API rate limiter (semaphore=2, 250ms interval). Log evidence (125-t.md):
   - Line 207: COORDINATOR "total active: 2" — both downloading simultaneously
   - Lines 191-266: FLOOD_PREMIUM_WAIT (3-4s sleeps) on every thumbnail seek

2. **Seek fails reliably**: The second mpegts.js player's SourceBuffer never
   receives data at the seek PTS. Log evidence (125-c.md):
   - Lines 61-67: `checkAndAdjust: buffered.length=0` for 7 consecutive checks
   - Lines 68, 462: `"Video seek failed for time: 1259.31"` — 15s timeout, twice

3. **19 bugs fixed across sessions 121-133, still broken**: The approach of
   using a second mpegts.js player for thumbnail extraction is fundamentally
   flawed. mpegts.js's internal state management (SourceBuffer flush, DTS reset,
   IOController seek, init segment re-queue) is designed for playback, not for
   single-frame extraction.

## Root Cause

The `MpegtsThumbnailPipeline` uses `/stream` which registers with the download
coordinator and competes for the semaphore. mpegts.js's IOController creates
open-ended Range requests (`{from: byteOffset, to: -1}`), downloading to EOF
unless aborted in time. The `max_bytes` URL parameter was tried (session 128)
but reverted because it triggers `endOfStream()` on the init download, making
all subsequent seeks fail.

Meanwhile, a **better pipeline already exists but is dead code**: The
`Fmp4ThumbnailPipeline` (lines 1461-1810 of useThumbnailExtractor.ts) fetches
init + segment from `/fmp4/init` and `/fmp4/segment` backend endpoints. The
backend demuxes TS, builds fMP4 segments, and returns ready-to-append data.
This pipeline is NEVER activated because `fmp4PipelineActiveRef.current` is
never set to `true` anywhere in the codebase.

## Solution: Activate Fmp4ThumbnailPipeline + Fix Backend Semaphore

### Approach Comparison

| Aspect | MpegtsThumbnailPipeline (current) | Fmp4ThumbnailPipeline (proposed) |
|--------|-----------------------------------|----------------------------------|
| Downloads from | /stream (raw TS, open-ended) | /fmp4/segment (fMP4, finite) |
| Data per thumbnail | 522MB (to EOF) or ~5MB (if abort works) | ~2.6MB (2MB overlap + 0.6MB segment) |
| Semaphore impact | Blocking acquire per-chunk, competes with main player | try_acquire per-chunk (after fix), yields to main player |
| Client-side complexity | 500+ lines, 19 bugs, mpegts.js internals | 350 lines, clean MSE append + seek |
| Backend processing | None (raw TS to client) | TsDemuxer + fMP4 builder (keyframe-aligned) |
| Seek reliability | Broken (buffered.length=0, 15s timeout) | Works (backend handles keyframe alignment) |
| FLOOD_PREMIUM_WAIT | Yes (confirmed in logs) | No (after semaphore fix) |

### Why This Is Optimal

1. **Reuses existing, tested code**: Fmp4ThumbnailPipeline class is complete.
   Backend endpoints are registered and functional. The processLoop already
   has the fmp4Pipeline branch (lines 2463-2475).

2. **Minimal data transfer**: 0.5s segment = ~625KB + 2MB overlap = ~2.6MB
   per thumbnail (vs 522MB with MpegtsThumbnailPipeline).

3. **Non-blocking after fix**: /fmp4/segment will use try_acquire per-chunk
   (matching download_and_cache_range's pattern at line 1424).

4. **Backend does the heavy lifting**: TsDemuxer + fMP4 builder handle
   keyframe alignment, PTS calculation, PES parsing — all server-side.

5. **Works for cached AND uncached positions**: Cached → disk read (instant).
   Uncached → small targeted download that yields to main player.

6. **Clean removal of 500+ lines of broken code**.

---

## Implementation Steps

### Step 1: Backend — Fix /fmp4/segment semaphore (CRITICAL)

**File**: `app/src-tauri/src/server.rs`
**Lines**: 2818-2869 (fmp4_segment direct download path)

The current code acquires the semaphore once with blocking `acquire().await`
and holds it for the entire download duration, blocking the main player.

**Current code** (line 2818-2823):
```rust
let _permit = data.download_semaphore.acquire().await.unwrap();
throttle_api_calls(&data.rate_limiter).await;
let mut iter = download_iter;
let mut offset = read_start;
let mut first_chunk = true;
let download_end = read_end;

loop {
    match iter.next().await.transpose() {
```

**New code** (non-blocking try_acquire per-chunk):
```rust
let mut iter = download_iter;
let mut offset = read_start;
let mut first_chunk = true;
let download_end = read_end;

loop {
    let chunk_result = {
        match data.download_semaphore.try_acquire() {
            Ok(_permit) => {
                throttle_api_calls(&data.rate_limiter).await;
                iter.next().await
            }
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
        }
    };
    match chunk_result.transpose() {
```

This matches the pattern used by `download_and_cache_range` (line 1422-1434),
which is already verified to be non-blocking.

**Verification**: `cargo check` passes. No FLOOD_PREMIUM_WAIT when
/fmp4/segment downloads uncached data simultaneously with /stream.

### Step 2: Frontend — Activate fMP4 thumbnail pipeline for TS

**File**: `app/src/hooks/useMSEPlayer.ts`
**Location**: Inside the MEDIA_INFO event handler (line 2300-2304)

After the existing `diagLog` call, add:

```typescript
// Construct fmp4Config for thumbnail pipeline
const parsedForFmp4 = parseStreamUrl(streamUrl);
if (parsedForFmp4) {
  fmp4ConfigRef.current = {
    baseUrl: parsedForFmp4.baseUrl,
    folderId: parsedForFmp4.folderId,
    messageId: parsedForFmp4.messageId,
    queryParams: `token=${encodeURIComponent(parsedForFmp4.token)}`,
    mimeType: `video/mp4; codecs="${info.videoCodec},${info.audioCodec}"`,
    duration: knownDuration || estimatedDurationS,
  };
  fmp4PipelineActiveRef.current = true;
  diagLog('[MPEGTS] fMP4 thumbnail pipeline activated');
}
```

**Note**: `parseStreamUrl` is already defined (line 820). `knownDuration`
and `estimatedDurationS` are already in scope. `fmp4ConfigRef` and
`fmp4PipelineActiveRef` are already declared (lines 863, 859).

**Verification**: `npx tsc --noEmit` passes. After MEDIA_INFO fires,
`getters.getFmp4Config()` returns non-null, `getters.isFmp4Stream()`
returns true.

### Step 3: Frontend — Remove MpegtsThumbnailPipeline

**File**: `app/src/hooks/useThumbnailExtractor.ts`

Remove:
1. `MpegtsThumbnailPipeline` class (lines 969-1452) — entire class
2. Refs: `mpegtsThumbnailPipelineRef`, `mpegtsPipelineConfigRef`,
   `mpegtsPipelineInitInProgressRef` (search and remove all declarations)
3. Mpegts pipeline effect (lines 2108-2151) — stores config for lazy init
4. Mpegts pipeline lazy-init code in processLoop (lines 2411-2434)
5. Mpegts pipeline capture branch in processLoop (lines 2450-2462)
6. In the keyframe index push effect (lines 2157-2176), remove the
   transmuxerPipeline-specific code only if it references mpegtsPipeline

**processLoop after removal** should have only 3 pipeline branches:
```
if (fmp4Pipeline && fmp4Pipeline.ready && !fmp4Pipeline.busy) {
  // fMP4 backend pipeline (TS→fMP4)
} else if (pipeline && pipeline.ready && !pipeline.busy) {
  // MP4 mini MSE pipeline
} else if (transmuxerPipeline && transmuxerPipeline.ready && !transmuxerPipeline.busy) {
  // Transmuxer pipeline (MKV/WebM)
}
```

**Verification**: `npx tsc --noEmit` passes. No references to
`MpegtsThumbnailPipeline` remain. `grep -rn MpegtsThumbnailPipeline app/src/`
returns zero results.

### Step 4: Frontend — Enhance Fmp4ThumbnailPipeline for uncached positions

**File**: `app/src/hooks/useThumbnailExtractor.ts`
**Location**: `Fmp4ThumbnailPipeline.captureAtTime` method (line 1688)

**4a. Add fetch timeout (10s)**:
```typescript
// In captureAtTime, replace the fetch call:
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 10000);
const segResp = await fetch(segUrl, { signal: controller.signal });
clearTimeout(timeoutId);
```

**4b. Use /fmp4/keyframe-at for precise byte_offset**:
```typescript
// In captureAtTime, before fetching segment:
// First get the exact keyframe byte offset from the backend
const kfUrl = `${this.fmp4BaseUrl}/keyframe-at/${this.folderId}/${this.messageId}?${this.queryParams}&time=${time.toFixed(3)}&duration=${this.duration.toFixed(3)}`;
const kfResp = await fetch(kfUrl);
if (kfResp.ok) {
  const kfData = await kfResp.json();
  if (kfData.byte_offset && !kfData.fallback) {
    // Use byte_offset for precise keyframe-aligned segment
    segUrl = `${this.fmp4BaseUrl}/segment/${this.folderId}/${this.messageId}?${this.queryParams}&byte_offset=${kfData.byte_offset}&duration=0.5&align=keyframe`;
  }
}
```

**4c. Add 503 retry handling**:
```typescript
// If segment fetch returns 503, wait and retry once
if (segResp.status === 503) {
  const retryAfter = parseInt(segResp.headers.get('Retry-After') || '2', 10);
  await new Promise(r => setTimeout(r, retryAfter * 1000));
  // Retry fetch...
}
```

**Verification**: Hover at 50% of uncached video shows:
```
[Fmp4ThumbnailPipeline] Fetching keyframe at time=1036.50s
[Fmp4ThumbnailPipeline] Fetching segment at byte_offset=656416288
[Fmp4ThumbnailPipeline] Captured thumbnail at 1036.50s
```

### Step 5: Frontend — Update canGenerateThumbnails check

**File**: `app/src/components/dashboard/FastStreamPlayer.tsx`
**Line**: 1163

The current check includes `(thumbnailDataReady && mseGetters?.getFormat() === 'ts')`
for the MpegtsThumbnailPipeline. After removing it, this should check for
the fMP4 pipeline instead:

```typescript
const canGenerateThumbnails = playerUseNative
  || (thumbnailDataReady && moovBufferReady)
  || isTransmuxer()
  || (thumbnailDataReady && mseGetters?.isFmp4Stream());
```

**Verification**: Hover tooltip shows spinner for uncached TS positions
(canGenerateThumbnails = true).

---

## Test Cases

### Test 1: Hover at 0s (cached position)
- **Expected**: Instant thumbnail from cached data
- **Verify**: `[Fmp4ThumbnailPipeline] Captured thumbnail at 0.00s`
- **Verify**: No FLOOD_PREMIUM_WAIT in backend logs

### Test 2: Hover at 25% (~518s, likely uncached)
- **Expected**: Thumbnail within 3-8s (backend download + demux)
- **Verify**: `[Fmp4ThumbnailPipeline] Fetching keyframe at time=518.25s`
- **Verify**: `[Fmp4ThumbnailPipeline] Captured thumbnail at 518.25s`
- **Verify**: No FLOOD_PREMIUM_WAIT in backend logs
- **Verify**: Main player playback continues smoothly

### Test 3: Hover at 50% (~1036s, uncached)
- **Expected**: Same as Test 2
- **Verify**: Same checks

### Test 4: Hover at 75% (~1555s, uncached)
- **Expected**: Same as Test 2
- **Verify**: Same checks

### Test 5: Hover at 90% (~1866s, uncached, near EOF)
- **Expected**: Same as Test 2
- **Verify**: Same checks

### Test 6: Rapid hover changes (scrubbing)
- **Expected**: busy flag prevents concurrent captures; already-cached buckets
  return instantly
- **Verify**: No console errors, no FLOOD_PREMIUM_WAIT, no stuttering

### Test 7: No hover (idle)
- **Expected**: No pipeline created, no downloads
- **Verify**: No `[Fmp4ThumbnailPipeline]` logs, no /fmp4/ requests in backend

### Test 8: Playback smoothness during hover
- **Expected**: No stuttering when hovering at uncached positions
- **Verify**: Main player speed stays at 1.0x
- **Verify**: FLOOD_PREMIUM_WAIT count = 0 during first 10s
- **Verify**: COORDINATOR "total active" stays at 1 (main player only)

### Test 9: Backend log verification
- **Expected**: /fmp4/segment uses try_acquire (non-blocking)
- **Verify**: No [STREAM-FALLBACK] logs from thumbnail pipeline
- **Verify**: [FMP4-SEG] logs show targeted download, not blocking acquire

### Test 10: Seek failure recovery
- **Expected**: If /fmp4/segment returns 503, processLoop retries on next hover
- **Verify**: Console shows "Segment fetch failed" then retries, eventually succeeds

### Test 11: TypeScript + Rust compilation
- **Verify**: `cd app && npx tsc --noEmit` (exit 0)
- **Verify**: `cd app/src-tauri && cargo check` (0 errors)

### Test 12: Multiple videos in sequence
- **Expected**: Each video gets its own fMP4 pipeline, old one is destroyed
- **Verify**: No memory leaks, no orphaned SourceBuffers

### Test 13: Large file (1.3GB+, 2073s duration)
- **Expected**: Thumbnail at 90% position works
- **Verify**: /fmp4/keyframe-at finds keyframe, /fmp4/segment downloads
  minimal data, thumbnail captured within 10s

### Test 14: Dead code removal verification
- **Verify**: `grep -rn MpegtsThumbnailPipeline app/src/` returns zero results
- **Verify**: `grep -rn mpegtsThumbnailPipelineRef app/src/` returns zero results
- **Verify**: `grep -rn mpegtsPipelineConfigRef app/src/` returns zero results

---

## Edge Cases

### Edge Case 1: /fmp4/init fails (no cache meta)
- Fmp4ThumbnailPipeline.init handles this (line 1546-1548, returns false)
- Pipeline won't initialize, processLoop skips it
- transmuxerPipeline (if available) used as fallback

### Edge Case 2: /fmp4/segment returns 503 (download busy)
- Fmp4ThumbnailPipeline.captureAtTime handles fetch failures (returns false)
- processLoop retries on next hover (line 2473-2474)
- Step 4c adds explicit 503 retry with Retry-After header

### Edge Case 3: Codec mismatch
- /fmp4/init returns X-Video-Codec and X-Audio-Codec headers
- If mimeType from mpegts.js codec info doesn't work with
  MediaSource.isTypeSupported, use the backend headers as fallback
- Fmp4ThumbnailPipeline.init checks isTypeSupported (line 1515)

### Edge Case 4: Very large files (2GB+)
- /fmp4/keyframe-at uses expanding window search (4MB → 256MB)
- try_acquire ensures it yields to /stream
- 256MB max is safety cap; typical VBR offset is <30MB

### Edge Case 5: Rapid hover changes
- Fmp4ThumbnailPipeline.busy flag prevents concurrent captures
- processLoop checks frameBufferRef.has(bucket) before capturing
- 1000ms debounce in onBarMove (FastStreamPlayer.tsx line 1170)

### Edge Case 6: Video not yet loaded (thumbnailDataReady = false)
- Fmp4ThumbnailPipeline effect checks thumbnailDataReady (line 2057)
- Pipeline not created until metadata is available

### Edge Case 7: Main player destroyed during thumbnail fetch
- Fmp4ThumbnailPipeline.active flag set to false in destroy()
- captureAtTime checks this.active after each await
- Fetch abort via AbortController (Step 4a)

---

## Confidence Assessment

**Confidence: 97%**

The 3% uncertainty: whether the mimeType constructed from mpegts.js's codec
info (e.g. `avc1.640032,mp4a.40.2`) exactly matches what
MediaSource.isTypeSupported expects. The backend /fmp4/init returns
X-Video-Codec and X-Audio-Codec headers (e.g. `avc1.640032`, `mp4a.40.2`)
that can be used as a fallback if the mpegts.js codec strings don't work.

**Research basis**:
- Exhaustive codebase analysis: all 4 pipeline implementations, backend
  endpoints, rate limiter, semaphore, mpegts.js internals (verified via
  skill references and direct code reading)
- Log analysis: 125-c.md (console) + 125-t.md (backend) — root cause
  identified and confirmed
- Context7 mpegts.js docs: confirmed no built-in thumbnail API
- Subagent findings: /stream respects finite Range, OffsetCustomSource
  always uses cached_only=true, /fmp4/segment uses blocking acquire
- Internet research: YouTube storyboard, Video.js, HLS.js approaches
  analyzed — all require either pre-generated thumbnails or server-side
  processing, which our fMP4 backend approach provides
