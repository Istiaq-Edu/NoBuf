# MPEG-TS Format Optimization Plan

Based on log analysis and code review, 4 critical TS-specific issues were identified. Here is the prioritized optimization plan:

---

## 1. Keyframe Index Cache (HIGHEST PRIORITY — eliminates 8-12s seek delays)

**Problem**: `getKeyPacket()` for TS takes 8-12s (vs 0.5-2s for MKV). TS has no Cue/index entries like MKV — Mediabunny must scan packets linearly from file start to find keyframes at arbitrary timestamps. Each seek creates a fresh `Input` that re-scans from scratch.

**Solution**: Build a keyframe timestamp → byte-offset index at init time, then use it for all subsequent seeks.

**Implementation**:
- In `MediabunnyTransmuxer.init()`, after `computeDuration()`, run a background index-building pass:
  ```ts
  // Use getNextKeyPacket to walk all keyframes efficiently
  let packet = await videoSink.getFirstPacket({ verifyKeyPackets: true });
  while (packet) {
    keyframeIndex.push({ timestamp: packet.timestamp, byteOffset: packet.byteOffset });
    packet = await videoSink.getNextKeyPacket(packet, { verifyKeyPackets: true });
  }
  ```
- Store `keyframeIndex: { timestamp: number, byteOffset: number }[]` as a class member
- In `seekTo()`, instead of letting `getKeyPacket()` scan the entire file linearly, pre-seed the CustomSource cache with the byte range around the target keyframe before calling `getKeyPacket()`. This way `getKeyPacket` only needs to scan a small region, not the entire file.
- Alternative simpler approach: Instead of `getKeyPacket(seekTime)` which scans linearly, use `getPacket(seekTime)` which may use a different internal strategy, then verify it's a keyframe or walk backward with `getNextKeyPacket` in reverse.
- **Estimated improvement**: 8-12s → <1s for cached positions, ~2-3s for uncached

**Caveat**: The full index-building pass itself takes time (scanning all keyframes). For a 2073s file with ~2s GOP, that's ~1000 keyframes. Two strategies:
  - **A) Lazy partial index**: Build index only for the first ~60s on init. Extend on each refill seek (cache keyframes encountered during iteration). Use binary search on cached portion, fall back to `getKeyPacket` for positions beyond cached range.
  - **B) Full background index**: Build complete index in background (non-blocking). Until complete, use `getKeyPacket` as fallback. Once complete, all seeks use the index.
  
  **Recommendation**: Strategy A (lazy partial index) — no upfront delay, index grows organically with usage.

---

## 2. EOF Detection Accuracy (MEDIUM PRIORITY — 5s cut-off fix)

**Problem**: `noProgress` triggers too early. At EOF, refill position (2068.2s) maps back to the same keyframe (2066.66s) as the previous refill. The actual last keyframe is at 2066.66s but there's still 6.5s of video remaining (to 2073.2s). noProgress declares EOF because the keyframe hasn't advanced, but there are still delta frames after it.

**Solution**: Replace `noProgress` detection with a smarter "tail frames remaining" check.

**Implementation**:
- Instead of checking if `keyframeTimestamp === lastRefillKeyframeRef.current`, check if the refill actually produced NEW segments. If `seekBufferRef.current.length > 0` after a refill where keyframe didn't advance, there are still delta frames — NOT EOF.
- Add a `noNewData` counter: only declare EOF after N consecutive refills (N=2-3) that produce zero new segments with the same keyframe.
- Additionally, adjust `nearEOF` threshold from `duration - 1` to `duration - (keyframe_interval_estimate)`:
  ```ts
  // Estimate keyframe interval from observed keyframe timestamps
  const keyframeInterval = lastRefillKeyframeRef.current && previousKeyframeRef.current
    ? Math.abs(lastRefillKeyframeRef.current - previousKeyframeRef.current) : 12;
  const isNearEOF = refillPosition >= duration - keyframeInterval;
  ```
- **Estimated improvement**: No 5s cut-off — video plays to true end

---

## 3. Buffer Size Management (MEDIUM PRIORITY — reduce 62.9s ahead)

**Problem**: Buffer grows to 62.9s ahead. The adaptive delay formula `min(5000, max(2000, (ahead-15)*200))` only reaches 5s at 40s ahead — not enough to cap growth for TS format where refills are fast once cached.

**Solution**: More aggressive buffer capping with early eviction.

**Implementation**:
- Cap max buffer ahead at 30s with hard eviction:
  ```ts
  const MAX_BUFFER_AHEAD = 30;
  if (ahead > MAX_BUFFER_AHEAD) {
    // Don't refill — evict data behind currentTime instead
    evictOldBuffer();
    // Sleep longer: 5000ms
    scheduleRecheck(5000);
    return;
  }
  ```
- Increase minimum refill delay when buffer is healthy: `min(5000, max(3000, (ahead-15)*300))`
- More aggressive `evictOldBuffer()` — reduce `BUFFER_KEEP_BEHIND` from 30s to 15s for TS
- Reduce `REFILL_CHUNK_DURATION` from 5 to 4 for TS format (less data per cycle)
- **Estimated improvement**: Buffer capped at 30s, faster eviction, less memory pressure

---

## 4. Seek Responsiveness — Concurrent Seek Cancellation (MEDIUM PRIORITY)

**Problem**: When user drags progress bar, multiple concurrent seeks fire. Each calls `getKeyPacket` (8-12s) before being canceled by the next seek. Three simultaneous `getKeyPacket` calls waste 24-36s of network/CPU before the final seek resolves.

**Solution**: Abort getKeyPacket early + tighter debounce.

**Implementation**:
- In `seekTo()`, the `seekAbortFlag = true` + `conversion.cancel()` + `input.dispose()` should immediately kill the previous `getKeyPacket` iteration. Verify this is working — if `getKeyPacket` holds a reference to a disposed Input, it should throw `InputDisposedError` and exit. The logs show "Seek canceled/disposed (expected during seek)" which confirms it IS working, but the 8-12s `getKeyPacket` times suggest the Input isn't actually disposed until `getKeyPacket` completes.
- **Root cause**: `seekTo()` is `async` — when a new `seekTo()` call enters, it sets `seekAbortFlag=true` and calls `conversion.cancel()` + `input.dispose()`, but these are async operations. The previous `seekTo()` is still running its `getKeyPacket` on the old Input. The `input.dispose()` call may not immediately interrupt `getKeyPacket` — it depends on whether Mediabunny checks disposed state during packet iteration.
- **Fix**: Add `await` on `input.dispose()` before proceeding, and add a microtask yield after `seekAbortFlag=true` so the previous iteration can check the flag:
  ```ts
  this.seekAbortFlag = true;
  this.seekGeneration++;
  // Force immediate cancellation of ongoing operations
  if (this.conversion) await this.conversion.cancel();
  if (this.input) { this.input.dispose(); this.input = null; }
  ```
- Additionally, increase debounce for transmuxer seeks from `SEEK_DEBOUNCE_MS` (currently whatever it is) to 300ms for TS format, so rapid progress-bar dragging only triggers one seek:
  ```ts
  const SEEK_DEBOUNCE_MS_TS = 300; // Higher debounce for slow getKeyPacket formats
  ```
- **Estimated improvement**: Previous seeks abort within ~100ms instead of 8-12s

---

## 5. Secondary Optimizations

- **TauriStreamSource maxCacheSize**: Currently 32 MiB. For a 1.3 GiB TS file, 32 MiB covers ~2% of the file. Increase to 64 MiB to cache more keyframe data for faster refill seeks.
- **prefetchProfile**: Already set to `'network'` — correct for HTTP byte-range. Keep this.
- **verifyKeyPackets**: Currently `true` on every `getKeyPacket` call. This adds verification overhead. Consider setting `verifyKeyPackets: false` for refill seeks (where we trust the demuxer) and only `true` for initial user-initiated seeks.
- **Thumbnail getKeyPacket**: Same slow 8-12s problem. Once keyframe index is built, thumbnails should use it too. The `TransmuxerThumbnailPipeline` has its own Input/Sink — share the index or pre-seed cache.

---

## Implementation Order

1. **Keyframe Index Cache** (highest impact, most complex) — Lazy partial index approach
2. **EOF Detection Fix** (quick fix, high user impact)
3. **Buffer Size Capping** (moderate change, improves memory)
4. **Seek Responsiveness** (abort + debounce improvements)
5. **Secondary Optimizations** (cache size, verifyKeyPackets tuning)

Total estimated seek improvement: 8-12s → 1-3s (with keyframe index), EOF cut-off eliminated, buffer capped at 30s.