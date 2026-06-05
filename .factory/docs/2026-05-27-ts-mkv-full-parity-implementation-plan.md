## Implementation Plan: TS/MKV Full Parity with MP4

### Phase 1: Fix Immediate Bugs (Critical)

**1. Fix negative audio timestamp in seekTo()**
- In `MediabunnyTransmuxer.ts`, both `iterateAudioPackets()` and `iterateAudioPacketsFromStart()` adjust timestamps via `packet.timestamp - keyframeTimestamp`. When audio key packet is slightly before video keyframe (e.g., 1227.8706 vs 1227.883), the result is negative → `IsobmffMuxer.validateTimestamp` rejects it.
- **Fix**: Change both methods to use `Math.max(0, packet.timestamp - keyframeTimestamp)` instead of raw subtraction. Also in `iterateAudioPacketsFromStart`, skip audio packets with `packet.timestamp < keyframeTimestamp - 0.5` (0.5s tolerance window) to avoid small sync drift.

**2. Fix `onProgress` callback for time-based progress tracking**
- Currently `Conversion.onProgress` receives `(progress, processedTime)` but this isn't used to update `prefetchedBytes` or `speed` during initial transmuxing. The `onMediaSegment` callback updates `prefetchedBytes` using a rough `timestamp/duration * fileLength` estimate — this is inaccurate for VBR content.
- **Fix**: Use `lastProcessedTime` from `onProgress` to update `prefetchedBytes` more accurately in `initTransmuxerPlayer`'s `onMediaSegment` callback.

### Phase 2: Progress Bar / Caching Bar Parity

**3. Add byte→time conversion for transmuxer path**
- MP4 path builds a VBR lookup table from `mp4box.seek()` calibration points. Transmuxer has no equivalent.
- **Approach**: Since transmuxer reads sequentially via `Conversion.execute()`, we can build a time→byte mapping from `TauriStreamSource.read()` calls. Track which byte ranges were read and which timestamps were produced. Build a simpler calibration table: after init, use `Input` to probe 20-50 timestamp positions → get byte offsets via `EncodedPacketSink.getKeyPacket()` → record approximate byte positions. Store in `byteToTimeTableRef` alongside MP4's table.
- **Simpler alternative**: Use the existing `byteToTime()` linear fallback formula (`bytePos / fileLength * duration`). For TS/MKV, this is less accurate than VBR lookup, but it's sufficient for green bar display. The green bar will use `video.buffered` ranges + `cachedTimeRanges` from backend (which does get data from the HTTP byte-range server).
- **Decision**: Use linear fallback for now. The backend `cmd_get_cache_status` already reports `cached_ranges` in bytes, and `byteToTime()` with linear formula converts them to time ranges for the green bar. This matches what happens when the MP4 VBR table is empty.

**4. Add backend cache range reporting for transmuxer**
- Currently transmuxer never calls `reportRangesToBackend()`. The backend doesn't know which byte ranges are cached during TS/MKV playback.
- **Fix**: In `initTransmuxerPlayer`, add a periodic (2s interval) `reportRangesToBackend` call using the TauriStreamSource's known byte ranges. The HTTP byte-range server (`localhost:14201/stream`) already caches data as it serves it — we just need to tell the frontend about those ranges.
- **Better approach**: Call `invoke('cmd_get_cache_status', { messageId })` periodically (every 2-3s) to poll the backend's cache status, then convert `cached_ranges` bytes to time via `byteToTime()` → set `cachedTimeRanges` state. This is already how the green bar works for MP4 (`FastStreamPlayer.tsx` lines 300-313). The same polling mechanism works for TS/MKV since the backend caches all byte-range responses regardless of format.

### Phase 3: Speed Tracking

**5. Add download speed tracking for transmuxer**
- Currently `speed` stays at 0 for transmuxer path.
- **Fix**: In `MediabunnyTransmuxer.startTransmuxing()`, the `onProgress` callback receives `processedTime`. Track time advancement per throttle interval (250ms). Calculate speed as: `(processedTimeDelta / 250ms) * (fileLength / duration)` → approximate bytes/second. Expose via a new `onSpeedUpdate` callback in `TransmuxerConfig`.
- In `initTransmuxerPlayer`, add `onSpeedUpdate: (speed: number) => { setSpeed(speed); }` callback. In `MediabunnyTransmuxer.startTransmuxing()`, throttle speed updates to 250ms and call `this.config.onSpeedUpdate(calculatedSpeed)`.

### Phase 4: Seek Parity

**6. Add seek debouncing for transmuxer path**
- Currently transmuxer seeks execute immediately — no 500ms debounce for rapid arrow-key spam.
- **Fix**: Add the same debounce mechanism as MP4: in `seekTo()`'s transmuxer branch, use `seekDebounceTimerRef` and `lastSeekTimeRef`. First seek instant, subsequent within 500ms debounced. Use `isFirstSeek` logic (same as MP4's `executeSeek`).
- Implementation: Move the transmuxer seek logic into a helper `executeTransmuxerSeek()` and wrap it with the same debounce pattern used for MP4.

**7. Add near-end seek guard for transmuxer path**
- MP4 path checks `hasEverCompletedRef.current && clampedTime >= duration - 5.1` for forward seeks after completion. Transmuxer branch doesn't have this guard.
- **Fix**: Add the same near-end forward seek guard before the transmuxer buffered/unbuffered check. If `hasEverCompletedRef.current && clampedTime >= duration - 5.1 && isForwardSeek`, force video end (same logic as MP4 path).

### Phase 5: Backpressure & Buffer Management

**8. Add backpressure mechanism for transmuxer**
- Transmuxer reads entire file via `Conversion.execute()` without pausing when buffer is full. Risk of QuotaExceededError for large files.
- **Fix**: Convert `startTransmuxing()` from a simple `await conversion.execute()` to a chunked iteration approach. Instead of letting Conversion run to completion, periodically check `getBufferedAheadSeconds()` and pause/resume the conversion when `bufferedAhead > MAX_BUFFER_AHEAD_SECONDS (120s)`.
- **Challenge**: `Conversion.execute()` is a monolithic call — no built-in pause/resume. We need to either:
  a) Use `Conversion.cancel()` + recreate when we want to resume (expensive — re-reads from beginning)
  b) Add a `Conversion.pause()/resume()` API if mediabunny supports it (check library)
  c) Use the `onProgress` callback to track how much has been processed, and only start conversion for limited time ranges (chunked approach)
- **Pragmatic approach**: For now, keep the monolithic `Conversion.execute()` but add aggressive `evictOldBuffer()` calls in `onMediaSegment` (evict when buffer > 50MB). The 60s-behind eviction already helps. Add byte-level eviction threshold check (same as MP4's `MAX_BUFFER_BYTES = 50MB`).

**9. Improve SourceBuffer eviction for transmuxer**
- Currently inline eviction in `onMediaSegment` only evicts 60s behind. No byte-level threshold check.
- **Fix**: Replace inline eviction with the existing `evictOldBuffer()` function from `useMSEPlayer.ts`. Call it before each segment append in `onMediaSegment` (same pattern as MP4's `onSegment`). This adds the 50MB byte-level threshold check and proper `BUFFER_KEEP_BEHIND = 30s` eviction.

### Phase 6: Thumbnail Pipeline

**10. Add thumbnail preview for transmuxer path**
- MP4 path uses `useThumbnailExtractor` with a mini-MSE pipeline (MP4Box + moov buffer + init segments + first chunk). TS/MKV files don't have moov atoms or MP4Box-compatible structure.
- **Approach**: For transmuxer files, we can't use the MP4Box mini-MSE pipeline. Instead:
  a) **Option A**: Use `MediabunnyTransmuxer` to create a mini transmuxer instance that produces a single frame at a specific timestamp, then capture it via canvas. This is complex and slow.
  b) **Option B**: Use the native `<video>` element with a temporary URL to capture thumbnails. Create a second hidden video element, seek to the desired time, draw to canvas. This works if the server supports Range requests (which it does for TS/MKV).
  c) **Option C**: Skip thumbnails entirely for TS/MKV — show time-only tooltip (current behavior). This is the simplest and matches what many video players do for non-MP4 formats.
- **Decision**: Option B — use a hidden native `<video>` element for thumbnail capture. The backend already supports Range requests for all formats. Create a temporary video element, set `src` to `streamUrl`, seek to desired time, capture frame via canvas. This requires minimal new code and works for both .ts and .mkv.
- **Implementation**: In `useThumbnailExtractor`, add a `useNativeThumbnails` flag for transmuxer files. When `!thumbnailDataReady && !moovBufferReady` (transmuxer path), use native video element thumbnail capture instead of MP4Box mini-MSE pipeline. The `onBarMove` handler would then allow `canGenerateThumbnails = true` for transmuxer path when this flag is set.

### Phase 7: Test .ts Format

**11. Test MPEG-TS format playback**
- Haven't tested .ts files yet. The same transmuxer path handles both .ts and .mkv (format detection routes them both to `initTransmuxerPlayer`).
- Need to verify: format detection, demuxing, codec detection, duration, seek, progress bar, speed display, thumbnails.

### Implementation Order (Priority)

1. **Fix negative audio timestamp** (Phase 1) — seek is currently broken
2. **Add backend cache polling for progress bar** (Phase 2) — reuse existing `cmd_get_cache_status` mechanism
3. **Add speed tracking** (Phase 3) — `onSpeedUpdate` callback
4. **Add seek debouncing + near-end guard** (Phase 4) — reuse MP4 debounce logic
5. **Improve SourceBuffer eviction** (Phase 5) — use existing `evictOldBuffer()`
6. **Add native video thumbnail capture** (Phase 6) — hidden `<video>` element approach
7. **Add backpressure** (Phase 5) — chunked conversion or aggressive eviction
8. **Test .ts format** (Phase 7)

### Files to Modify

1. `MediabunnyTransmuxer.ts` — Fix negative timestamps, add `onSpeedUpdate` callback, add `onProgress` throttled speed calculation
2. `useMSEPlayer.ts` — Add cache polling for transmuxer, seek debounce for transmuxer, near-end guard for transmuxer, use `evictOldBuffer()` instead of inline eviction, add `nativeThumbnailUrl` for thumbnail pipeline
3. `FastStreamPlayer.tsx` — Enable thumbnail hover for transmuxer path, update `canGenerateThumbnails` logic
4. `useThumbnailExtractor.ts` — Add native video thumbnail capture mode (if Phase 6 is pursued)