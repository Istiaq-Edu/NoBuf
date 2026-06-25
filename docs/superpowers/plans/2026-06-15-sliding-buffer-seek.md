# Sliding In-Memory Buffer Window & Seek Prebuffer Pivot Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-architect the MSE player's in-memory buffer management so that every seek slides a 30 s behind / 180 s ahead window around the new playhead, and the proactive disk prebuffer only restarts when the seek lands forward of the current prebuffer window.

**Architecture:** Add a single buffer-window calculator used by all three pipelines (mpegts.js, fMP4, transmuxer). On buffered seeks, trim data behind the playhead instead of clearing the whole buffer. On unbuffered seeks, clear the buffer and reposition the active downloader. Track the approximate disk prebuffer window and only stop+restart it when the new playhead is ahead of it.

**Tech Stack:** React + TypeScript + mpegts.js + MSE + Tauri Rust backend.

**Baseline validation:** `npm run test -- --run` passes (72 tests). `npm run build` passes.

---

## Research Summary

### 1. mpegts.js lazyLoad
From `app/node_modules/mpegts.js/src/player/loading-controller.ts`:

- `_suspendTransmuxerIfBufferedPositionExceeded` pauses when `buffered_end >= current_time + lazyLoadMaxDuration`.
- `_resumeTransmuxerIfNeeded` resumes when `current_time >= to - lazyLoadRecoverDuration`.
- Default: `lazyLoadMaxDuration = 180 s`, `lazyLoadRecoverDuration = 30 s`.

With `lazyLoadMaxDuration = 180 s` and `lazyLoadRecoverDuration = 60 s` the in-memory buffer will oscillate between **60 s and 180 s ahead** of the playhead while the video plays. This matches the "fill 180 s ahead" requirement.

### 2. hls.js buffer management
From `C:/Users/Mr-N0N4M3/hlsjs-research/docs/API.md`:

- `maxBufferSize = 60 MB` (default byte cap).
- `maxMaxBufferLength = 600 s` (hard cap in seconds).
- `backBufferLength = Infinity` by default.
- hls.js limits by **bytes**, not seconds, because fixed-second windows are dangerous at high bitrates.

### 3. MSE quota reality
- Chromium per-SourceBuffer ceiling is roughly 150–240 MB.
- Current code uses `SAFE_SOURCE_BUFFER_BUDGET_BYTES = 250 MB` (`useMSEPlayer.ts:3168`).
- 180 s + 30 s = 210 s total. At 8 Mbps this is ~210 MB; at 12 Mbps it is ~315 MB and will exceed the quota.
- **Conclusion:** the 180 s / 30 s targets must be **dynamic** and shrink under high-bitrate pressure.

### 4. Current code state
- `app/src/hooks/useMSEPlayer.ts:403-405`: `MAX_BUFFER_BYTES = 20 MB`, `BUFFER_KEEP_BEHIND = 30 s`, `MAX_BUFFER_AHEAD_SECONDS = 30 s`.
- `app/src/hooks/useMSEPlayer.ts:3112-3116`: mpegts.js quota guard uses `BASE_QUOTA_KEEP_AHEAD = 120 s`, `BASE_QUOTA_KEEP_BEHIND = 60 s`, capped at 150 s.
- `app/src/hooks/useMSEPlayer.ts:5520-6043`: three seek paths (mpegts.js, fMP4, transmuxer).
- `app/src/hooks/useMSEPlayer.ts:3274-3308`: proactive prebuffer is reported every 10 s via `cmd_report_playback_position`.
- `app/src-tauri/src/commands/streaming.rs:510-660`: backend proactive prebuffer only slides its start forward, never backward.
- `SourceBufferWrapper.ts`: `remove(start, end)` queues remove operations safely; `resetForSeek()` removes all data.
- `StreamShadowCache.ts`: `trimAround(centerByte, windowBytes)` can trim the JS-side cache to a window around the playhead.

### 5. Internet research (MCP / browser)
- **MDN `SourceBuffer.appendBuffer()`**: throws `InvalidStateError` if `updating` is `true`, and throws `QuotaExceededError` when the browser-defined buffer limit is reached. (https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/appendBuffer)
- **MDN `SourceBuffer.remove()`**: throws `InvalidStateError` if `updating` is `true`; must wait for `updateend` or call `abort()`. (https://developer.mozilla.org/en-US/docs/Web/API/SourceBuffer/remove)
- **mpegts.js docs (Context7)**: `lazyLoadMaxDuration` defaults to `180 s`, `lazyLoadRecoverDuration` defaults to `30 s`; `autoCleanupSourceBuffer` defaults to `false` and its internal `removeEnd = currentTime - autoCleanupMaxBackwardDuration` can be negative near the start, which is why the existing code avoids it. (https://github.com/xqq/mpegts.js/blob/master/docs/api.md)
- **hls.js docs (local clone)**: uses `maxBufferSize = 60 MB` and `maxMaxBufferLength = 600 s` as a byte-first, time-capped buffer strategy. (`C:/Users/Mr-N0N4M3/hlsjs-research/docs/API.md`)

---

## Requirements

### A. In-memory buffer window
1. Target: **30 s behind** the playhead, **180 s ahead** of the playhead.
2. The window must be **dynamic**: at high bitrates, shrink the forward and/or backward window so the total in-memory bytes never exceed `SAFE_SOURCE_BUFFER_BUDGET_BYTES` (250 MB).
3. The window must be maintained continuously, not only on seek.

### B. Seek behavior
1. **Buffered seek** (target is inside `video.buffered`):
   - Remove `[0, targetTime - 30 s)` from the SourceBuffer.
   - Keep `[targetTime - 30 s, currentBufferEnd]`.
   - Set `video.currentTime = targetTime` immediately.
   - Do **not** stop the active downloader.
   - Do **not** clear the burst / seek / shadow caches.
   - For mpegts.js, also trim the shadow cache around the new playhead.
2. **Unbuffered seek**:
   - Clear the entire SourceBuffer.
   - Reposition the active downloader to start from the seek position.
   - Refill from the seek position onward.
   - Apply the existing debounce/serialization already implemented for the TS mpegts.js path.

### C. Proactive disk prebuffer
1. Track the approximate current prebuffer window (start time, end time).
2. If the seek is inside or behind the current prebuffer window, do **nothing**.
3. If the seek is **forward of** the current prebuffer window end, stop the old prebuffer and start a new one from the new playhead.
4. The backend `proactive_prebuffer_download` only slides its start forward, so backward data in the old window is still useful and must not be discarded.

---

## File Structure

### Files to modify
- `app/src/hooks/useMSEPlayer.ts` — add helpers, update three seek paths, update quota guard, update refill scheduling, update prebuffer tracking.
- `app/src/__tests__/TsResumeUtils.test.ts` — add tests for the new pure helper `computeSlidingWindowSeconds`.

### No new files
The change fits within the existing hook. If helpers become large, extract later in a separate refactor.

---

## Tasks

### Task 1: Add buffer-window constants and pure helper

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts:403-405`

- [ ] **Step 1.1: Replace fixed constants with window targets and a dynamic calculator**

Replace:
```typescript
const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20MB max buffer before eviction
const BUFFER_KEEP_BEHIND = 30; // Keep 30s behind current playback position
const MAX_BUFFER_AHEAD_SECONDS = 30; // Backpressure — stop downloading when >30s buffered ahead
```

With:
```typescript
const SLIDING_WINDOW_BACKWARD_SECONDS = 30;      // keep 30s behind playhead
const SLIDING_WINDOW_FORWARD_SECONDS = 180;      // target 180s ahead of playhead
const SLIDING_WINDOW_MIN_FORWARD_SECONDS = 60;   // never go below this
const SAFE_SOURCE_BUFFER_BUDGET_BYTES = 250 * 1024 * 1024; // 250 MB per SourceBuffer

function getAverageBitrateBps(fileLength: number, duration: number): number {
  if (fileLength > 0 && duration > 0 && isFinite(duration)) {
    return fileLength / duration;
  }
  return 0;
}

// Compute allowed forward/backward seconds from bitrate so the total in-memory bytes
// never exceed the MSE budget. The target is 180s/30s; high-bitrate files shrink.
// Returns { backward, forward } in seconds.
function computeSlidingWindowSeconds(
  bitrateBps: number,
  _playbackRate: number
): { backward: number; forward: number } {
  if (!isFinite(bitrateBps) || bitrateBps <= 0) {
    return {
      backward: SLIDING_WINDOW_BACKWARD_SECONDS,
      forward: SLIDING_WINDOW_MIN_FORWARD_SECONDS,
    };
  }

  const targetForward = SLIDING_WINDOW_FORWARD_SECONDS;
  const targetBackward = SLIDING_WINDOW_BACKWARD_SECONDS;
  const maxBytes = SAFE_SOURCE_BUFFER_BUDGET_BYTES;
  const maxTotalSeconds = (maxBytes * 8) / bitrateBps; // bytes * 8 = bits; divide by bits/sec

  if (targetForward + targetBackward <= maxTotalSeconds) {
    return { backward: targetBackward, forward: targetForward };
  }

  // Shrink backward first, then forward, but never below minimums.
  let backward = Math.min(
    targetBackward,
    Math.max(5, maxTotalSeconds - SLIDING_WINDOW_MIN_FORWARD_SECONDS)
  );
  let forward = Math.max(
    SLIDING_WINDOW_MIN_FORWARD_SECONDS,
    maxTotalSeconds - backward
  );

  // If even minimums don't fit, clamp both to the budget.
  if (backward + forward > maxTotalSeconds) {
    forward = Math.max(0, maxTotalSeconds - backward);
    if (backward + forward > maxTotalSeconds) {
      backward = Math.max(0, maxTotalSeconds - forward);
    }
  }

  return { backward: Math.floor(backward), forward: Math.floor(forward) };
}
```

- [ ] **Step 1.2: Add a test for the helper**

In `app/src/__tests__/TsResumeUtils.test.ts` add:

```typescript
describe('computeSlidingWindowSeconds', () => {
  it('returns target 180s/30s when budget is not exceeded', () => {
    // 2 Mbps → 52.5 MB for 210s, well under 250 MB
    const result = computeSlidingWindowSeconds(2_000_000, 1);
    expect(result.forward).toBe(180);
    expect(result.backward).toBe(30);
  });

  it('shrinks forward and backward when budget is exceeded', () => {
    // 12 Mbps → 210s = 315 MB, over 250 MB
    const result = computeSlidingWindowSeconds(12_000_000, 1);
    expect(result.forward).toBeLessThan(180);
    expect(result.backward).toBeLessThanOrEqual(30);
    expect(result.forward).toBeGreaterThanOrEqual(60);
    expect(result.backward).toBeGreaterThanOrEqual(5);
  });

  it('falls back to safe defaults when bitrate is unknown', () => {
    const result = computeSlidingWindowSeconds(0, 1);
    expect(result.forward).toBe(60);
    expect(result.backward).toBe(30);
  });

  it('caps forward at the budget and never drops below 0', () => {
    // 50 Mbps — budget can only hold ~42s total, so forward is clamped down hard
    const result = computeSlidingWindowSeconds(50_000_000, 1);
    expect(result.forward).toBeGreaterThanOrEqual(0);
    expect(result.backward).toBeGreaterThanOrEqual(0);
    expect(result.forward + result.backward).toBeLessThanOrEqual(
      Math.floor((250 * 1024 * 1024 * 8) / 50_000_000)
    );
  });
});
```

- [ ] **Step 1.3: Run the new test to verify it fails**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run test -- --run TsResumeUtils
```

Expected: FAIL — `computeSlidingWindowSeconds is not defined`.

- [ ] **Step 1.4: Export the helper so tests can import it**

Add `export` keyword to the function definition in `useMSEPlayer.ts`.

```typescript
export function computeSlidingWindowSeconds(
  bitrateBps: number,
  playbackRate: number
): { backward: number; forward: number } {
```

- [ ] **Step 1.5: Run the test again to verify it passes**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run test -- --run TsResumeUtils
```

Expected: PASS.

- [ ] **Step 1.6: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
git add src/hooks/useMSEPlayer.ts src/__tests__/TsResumeUtils.test.ts
git commit -m "feat: add computeSlidingWindowSeconds helper with tests"
```

---

### Task 2: Add generic `trimBufferBehind` helper

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts` after `computeSlidingWindowSeconds`

- [ ] **Step 2.1: Add the helper interface and function**

```typescript
interface TrimableBuffer {
  buffered: TimeRanges;
  remove(start: number, end: number): void;
  updating?: boolean;
}

function trimBufferBehind(
  buffers: (TrimableBuffer | null)[],
  targetTime: number,
  keepBehindSeconds: number,
  logPrefix: string
): void {
  const keepStart = Math.max(0, targetTime - keepBehindSeconds);
  if (keepStart <= 0) return;

  for (const buf of buffers) {
    if (!buf) continue;
    const ranges = buf.buffered;
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges.start(i);
      const end = ranges.end(i);
      if (end <= keepStart) {
        // Entire range is behind the keep window.
        try {
          if (!buf.updating) buf.remove(start, end);
        } catch (e: any) {
          console.warn(`${logPrefix} trimBufferBehind remove failed:`, e);
        }
      } else if (start < keepStart) {
        // Range straddles the keep boundary.
        try {
          if (!buf.updating) buf.remove(start, keepStart);
        } catch (e: any) {
          console.warn(`${logPrefix} trimBufferBehind remove failed:`, e);
        }
      }
    }
  }
}
```

- [ ] **Step 2.2: Verify the project still builds**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run build
```

Expected: PASS.

- [ ] **Step 2.3: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
git add src/hooks/useMSEPlayer.ts
git commit -m "feat: add trimBufferBehind helper"
```

---

### Task 3: Update mpegts.js path

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts:1858-1864` (player config)
- Modify: `app/src/hooks/useMSEPlayer.ts:3108-3180` (quota guard constants)
- Modify: `app/src/hooks/useMSEPlayer.ts:5578-5586` (buffered seek)
- Modify: `app/src/hooks/useMSEPlayer.ts:1886` (shadow cache lazyLoadMax)

- [ ] **Step 3.1: Raise mpegts.js lazyLoad target to 180 s / 60 s**

Change:
```typescript
lazyLoadMaxDuration: 120,
lazyLoadRecoverDuration: 60,
```

To:
```typescript
lazyLoadMaxDuration: 180,
lazyLoadRecoverDuration: 60,
```

- [ ] **Step 3.2: Update shadow cache lazyLoadMax reference**

Change:
```typescript
shadowCacheRef.current._lazyLoadMax = 120;
```

To:
```typescript
shadowCacheRef.current._lazyLoadMax = 180;
```

- [ ] **Step 3.3: Replace quota guard fixed constants with dynamic helper**

In the mpegts.js quota guard (`sourceBufferQuotaGuard`), first move the `globalBitrateBps` calculation (currently around line 3169) to just before the constant declarations. Then replace:
```typescript
const BASE_QUOTA_DANGER_DURATION = 150;
const BASE_QUOTA_KEEP_AHEAD = 120;
const BASE_QUOTA_KEEP_BEHIND = 60;
```

With:
```typescript
const { backward: QUOTA_KEEP_BEHIND, forward: QUOTA_KEEP_AHEAD } =
  computeSlidingWindowSeconds(globalBitrateBps, currentRate);
const QUOTA_DANGER_DURATION = QUOTA_KEEP_AHEAD + 10; // 10s safety margin
```

Also remove the hard-coded `150` cap in:
```typescript
const QUOTA_KEEP_AHEAD = Math.min(BASE_QUOTA_KEEP_AHEAD * currentRate, 150);
```

And update the lazyLoad config assignment to a constant 180 s target:
```typescript
const targetMax = SLIDING_WINDOW_FORWARD_SECONDS; // 180s video-time ahead
const targetRecover = Math.max(30, targetMax - 120); // resume when buffer drops to 60s ahead
```

- [ ] **Step 3.3b: Simplify the high-bitrate fallback block**

The old high-bitrate fallback (around line 3339) manually shrinks the behind window. The new `computeSlidingWindowSeconds` already does this. Replace the fallback initialization:

```typescript
let effectiveKeepBehind = fallbackBehindRef.current;
if (globalBitrateBps > 0) {
  const totalWindowSeconds = QUOTA_KEEP_AHEAD + QUOTA_KEEP_BEHIND;
  const totalWindowBytes = totalWindowSeconds * globalBitrateBps;
  if (totalWindowBytes > SAFE_SOURCE_BUFFER_BUDGET_BYTES) {
    const aheadBytes = QUOTA_KEEP_AHEAD * globalBitrateBps;
    const remainingBudget = Math.max(0, SAFE_SOURCE_BUFFER_BUDGET_BYTES - aheadBytes);
    const maxBehindSeconds = Math.floor(remainingBudget / globalBitrateBps);
    if (maxBehindSeconds < 60) {
      effectiveKeepBehind = Math.max(15, Math.min(30, maxBehindSeconds));
    }
    if (effectiveKeepBehind !== fallbackBehindRef.current) {
      diagLog(`[MPEGTS] High-bitrate fallback: behind window ${fallbackBehindRef.current}s → ${effectiveKeepBehind}s (bitrate ${(globalBitrateBps/8/1024).toFixed(1)} KB/s)`);
    }
  }
}
fallbackBehindRef.current = effectiveKeepBehind;
```

With:
```typescript
let effectiveKeepBehind = QUOTA_KEEP_BEHIND;
fallbackBehindRef.current = QUOTA_KEEP_BEHIND;
```

Keep the emergency shrink at the end of the eviction block (the `if (isBufferFull) { ... }` code) because it is a last-resort QuotaExceededError handler.

- [ ] **Step 3.4: Trim buffer behind on mpegts.js buffered seek**

In the mpegts.js `seekTo` buffered path, replace:
```typescript
if (isBuffered) {
  diagLog(`[MPEGTS] Buffered seek to ${clamped.toFixed(1)}s`);
  video.currentTime = clamped;
  lastSeekTimeRef.current = 0;
  return;
}
```

With:
```typescript
if (isBuffered) {
  // Compute average bitrate locally; globalBitrateBps is only defined inside the quota guard closure.
  const avgBitrate = getAverageBitrateBps(
    state.current.fileLength,
    dur || mpegtsDurationRef.current || state.current.duration
  );
  const { backward } = computeSlidingWindowSeconds(avgBitrate, video.playbackRate || 1);
  const engine = (player as any)?._player_engine;
  const mseCtrl = engine?._mse_controller;
  const ms = mseCtrl?.getObject?.();
  const sbs: SourceBuffer[] = [];
  if (ms?.sourceBuffers) {
    const list = ms.sourceBuffers;
    for (let i = 0; i < list.length; i++) sbs.push(list[i]);
  }
  trimBufferBehind(sbs, clamped, backward, '[MPEGTS]');
  // Also trim the JS-side shadow cache to the same window so it does not hold stale far-behind data.
  const fileLen = state.current.fileLength || 0;
  const duration = mpegtsDurationRef.current || state.current.duration || 0;
  if (shadowCacheRef.current && fileLen > 0 && duration > 0) {
    const centerByte = Math.floor((clamped / duration) * fileLen);
    const { forward } = computeSlidingWindowSeconds(avgBitrate, video.playbackRate || 1);
    const windowBytes = Math.floor(((backward + forward) / duration) * fileLen);
    shadowCacheRef.current.trimAround(centerByte, windowBytes);
  }
  // Prebuffer pivot: only restart if this buffered seek is forward of the current prebuffer end.
  const parsed = parseStreamUrl(streamUrl);
  handlePrebufferAfterSeek(clamped, dur, video.playbackRate || 1, parsed);
  diagLog(`[MPEGTS] Buffered seek to ${clamped.toFixed(1)}s (trimmed behind ${backward}s)`);
  video.currentTime = clamped;
  lastSeekTimeRef.current = 0;
  return;
}
```

- [ ] **Step 3.5: Verify build passes**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run build
```

Expected: PASS.

- [ ] **Step 3.6: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
git add src/hooks/useMSEPlayer.ts
git commit -m "feat: mpegts.js sliding window (180s/30s) and buffered-seek trim"
```

---

### Task 3.5: Update shared `evictOldBuffer` helper

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts:1459-1500`

`evictOldBuffer` is shared by the fMP4 download loop and the transmuxer refill chain. It currently uses the old `MAX_BUFFER_BYTES` (20 MB) and `BUFFER_KEEP_BEHIND` (30 s) constants. It must be updated to use the dynamic sliding window before the fMP4 and transmuxer builds are run.

- [ ] **Step 3.5.1: Replace the function body**

Replace:
```typescript
const evictOldBuffer = () => {
  const video = videoRef.current;
  const sbVideo = state.current.videoSourceBuffer;
  const sbAudio = state.current.audioSourceBuffer;
  if (!sbVideo && !sbAudio) return;
  if (!video) return;

  // Check total buffered bytes
  let totalBuffered = 0;
  const checkBuffered = (sb: SourceBufferWrapper) => {
    const ranges = sb.buffered;
    for (let i = 0; i < ranges.length; i++) {
      totalBuffered += ranges.end(i) - ranges.start(i);
    }
  };
  if (sbVideo) checkBuffered(sbVideo);
  if (sbAudio) checkBuffered(sbAudio);

  // Only evict if buffer exceeds threshold (rough estimate: seconds * bitrate)
  if (totalBuffered * state.current.bitrate < MAX_BUFFER_BYTES) return;

  const currentTime = video.currentTime;
  const evictBefore = currentTime > 0
    ? Math.max(0, currentTime - BUFFER_KEEP_BEHIND)
    : 0;

  if (evictBefore <= 0) return;

  const evictRange = (sb: SourceBufferWrapper) => {
    const ranges = sb.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.end(i) < evictBefore) {
        sb.remove(ranges.start(i), ranges.end(i));
      }
    }
  };
  if (sbVideo) evictRange(sbVideo);
  if (sbAudio) evictRange(sbAudio);
};
```

With:
```typescript
const evictOldBuffer = () => {
  const video = videoRef.current;
  const sbVideo = state.current.videoSourceBuffer;
  const sbAudio = state.current.audioSourceBuffer;
  if (!video || (!sbVideo && !sbAudio)) return;

  // Continuously maintain the backward window: remove anything older than the dynamic behind target.
  const avgBitrate = getAverageBitrateBps(state.current.fileLength, state.current.duration);
  const { backward } = computeSlidingWindowSeconds(avgBitrate, video.playbackRate || 1);
  trimBufferBehind([sbVideo, sbAudio], video.currentTime, backward, '[EVICT]');
};
```

- [ ] **Step 3.5.2: Verify build passes**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run build
```

Expected: PASS.

- [ ] **Step 3.5.3: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
git add src/hooks/useMSEPlayer.ts
git commit -m "feat: evictOldBuffer uses dynamic sliding window"
```

---

### Task 4: Update fMP4 path

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts:403-405` (constants already changed in Task 1)
- Modify: `app/src/hooks/useMSEPlayer.ts:5293-5321` (download loop backpressure)
- Modify: `app/src/hooks/useMSEPlayer.ts:5687-5698` (buffered seek)

- [ ] **Step 4.1: Make fMP4 download loop use dynamic forward window**

In `downloadLoop`, replace the fixed `MAX_BUFFER_AHEAD_SECONDS` check:
```typescript
while (!cancelledRef.current && state.current.downloading && gen === loopGeneration.current) {
  const ahead = getBufferedAheadSeconds();
  if (ahead <= MAX_BUFFER_AHEAD_SECONDS) break;
  await new Promise(r => setTimeout(r, 2000));
  evictOldBuffer();
}
```

With:
```typescript
while (!cancelledRef.current && state.current.downloading && gen === loopGeneration.current) {
  const ahead = getBufferedAheadSeconds();
  const avgBitrate = getAverageBitrateBps(state.current.fileLength, state.current.duration);
  const { forward } = computeSlidingWindowSeconds(avgBitrate, videoRef.current?.playbackRate || 1);
  if (ahead <= forward) break;
  await new Promise(r => setTimeout(r, 2000));
  evictOldBuffer();
}
if (cancelledRef.current || !state.current.downloading || gen !== loopGeneration.current) break;

// Continuously trim the backward window on every iteration (even while fetching)
evictOldBuffer();
```

- [ ] **Step 4.2: Trim buffer behind on fMP4 buffered seek**

In the fMP4 `seekTo` buffered path, replace:
```typescript
if (clampedTime >= buffered.start(i) && clampedTime <= buffered.end(i)) {
  diagLog(`[MSE-TS-FMP4] Seek buffered: ${clampedTime.toFixed(1)}s — instant`);
  video.currentTime = clampedTime;
  if (seekDebounceTimerRef.current !== null) {
    clearTimeout(seekDebounceTimerRef.current);
    seekDebounceTimerRef.current = null;
  }
  return;
}
```

With:
```typescript
if (clampedTime >= buffered.start(i) && clampedTime <= buffered.end(i)) {
  diagLog(`[MSE-TS-FMP4] Seek buffered: ${clampedTime.toFixed(1)}s — instant`);
  const avgBitrate = getAverageBitrateBps(state.current.fileLength, state.current.duration);
  const { backward } = computeSlidingWindowSeconds(avgBitrate, video.playbackRate || 1);
  const sbVideo = state.current.videoSourceBuffer;
  const sbAudio = state.current.audioSourceBuffer;
  trimBufferBehind([sbVideo, sbAudio], clampedTime, backward, '[MSE-TS-FMP4]');
  // Prebuffer pivot: only restart if this buffered seek is forward of the current prebuffer end.
  const parsed = parseStreamUrl(streamUrl);
  handlePrebufferAfterSeek(clampedTime, state.current.duration, video.playbackRate || 1, parsed);
  video.currentTime = clampedTime;
  if (seekDebounceTimerRef.current !== null) {
    clearTimeout(seekDebounceTimerRef.current);
    seekDebounceTimerRef.current = null;
  }
  return;
}
```

- [ ] **Step 4.3: Verify build passes**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run build
```

Expected: PASS.

- [ ] **Step 4.4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
git add src/hooks/useMSEPlayer.ts
git commit -m "feat: fMP4 sliding window and buffered-seek trim"
```

---

### Task 5: Update transmuxer path

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts:1156-1176` (refill constants)
- Modify: `app/src/hooks/useMSEPlayer.ts:1428-1455` (refill scheduling)
- Modify: `app/src/hooks/useMSEPlayer.ts:5892-5905` (buffered seek)

- [ ] **Step 5.1: Make transmuxer refill target dynamic**

In the `finally` block of `executeStreamingRefill`, replace:
```typescript
const MAX_BUFFER_AHEAD = 30;
if (ahead >= MAX_BUFFER_AHEAD) {
```

With:
```typescript
const avgBitrate = getAverageBitrateBps(state.current.fileLength, state.current.duration);
const { forward: MAX_BUFFER_AHEAD } = computeSlidingWindowSeconds(avgBitrate, video.playbackRate || 1);
if (ahead >= MAX_BUFFER_AHEAD) {
```

Also, at the top of the `finally` block (after `refillInProgressRef.current = false;`), add a continuous backward eviction call:
```typescript
refillInProgressRef.current = false;

// Continuously trim the backward window after each refill
const evictVideo = videoRef.current;
if (evictVideo && !evictVideo.ended) {
  evictOldBuffer();
}
```

- [ ] **Step 5.2: Trim buffer behind on transmuxer buffered seek**

In the transmuxer `seekTo` buffered path, replace:
```typescript
if (clampedTime >= buffered.start(i) && clampedTime <= buffered.end(i)) {
  console.log(`[MSE] Transmuxer seek buffered: ${clampedTime.toFixed(1)}s — instant`);
  video.currentTime = clampedTime;
  if (seekDebounceTimerRef.current !== null) {
    clearTimeout(seekDebounceTimerRef.current);
    seekDebounceTimerRef.current = null;
  }
  return;
}
```

With:
```typescript
if (clampedTime >= buffered.start(i) && clampedTime <= buffered.end(i)) {
  console.log(`[MSE] Transmuxer seek buffered: ${clampedTime.toFixed(1)}s — instant`);
  const avgBitrate = getAverageBitrateBps(state.current.fileLength, state.current.duration);
  const { backward } = computeSlidingWindowSeconds(avgBitrate, video.playbackRate || 1);
  const sbVideo = state.current.videoSourceBuffer;
  const sbAudio = state.current.audioSourceBuffer;
  trimBufferBehind([sbVideo, sbAudio], clampedTime, backward, '[MSE-TRANS]');
  // Prebuffer pivot: only restart if this buffered seek is forward of the current prebuffer end.
  const parsed = parseStreamUrl(streamUrl);
  handlePrebufferAfterSeek(clampedTime, state.current.duration, video.playbackRate || 1, parsed);
  video.currentTime = clampedTime;
  if (seekDebounceTimerRef.current !== null) {
    clearTimeout(seekDebounceTimerRef.current);
    seekDebounceTimerRef.current = null;
  }
  return;
}
```

- [ ] **Step 5.3: Verify build passes**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run build
```

Expected: PASS.

- [ ] **Step 5.4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
git add src/hooks/useMSEPlayer.ts
git commit -m "feat: transmuxer sliding window and buffered-seek trim"
```

---

### Task 6: Implement proactive disk prebuffer pivot

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts:586` (add ref)
- Modify: `app/src/hooks/useMSEPlayer.ts:1600-1625` (initial spawn)
- Modify: `app/src/hooks/useMSEPlayer.ts:3274-3308` (position report)
- Modify: `app/src/hooks/useMSEPlayer.ts:5578-5586` (mpegts buffered seek)
- Modify: `app/src/hooks/useMSEPlayer.ts:5687-5698` (fMP4 buffered seek)
- Modify: `app/src/hooks/useMSEPlayer.ts:5892-5905` (transmuxer buffered seek)
- Modify: `app/src/hooks/useMSEPlayer.ts:5596` and surrounding (mpegts unbuffered seek)
- Modify: `app/src/hooks/useMSEPlayer.ts:5709` and surrounding (fMP4 unbuffered seek)
- Modify: `app/src/hooks/useMSEPlayer.ts:5922` and surrounding (transmuxer unbuffered seek)

- [ ] **Step 6.1: Add prebuffer window ref**

Near `proactivePrebufferMsgIdRef` add:
```typescript
const proactivePrebufferWindowRef = useRef<{ startTime: number; endTime: number } | null>(null);
```

- [ ] **Step 6.2: Add helper to compute and record prebuffer window**

```typescript
function recordProactiveWindow(startTime: number, duration: number, playbackRate: number) {
  const forwardSeconds = Math.min(SLIDING_WINDOW_FORWARD_SECONDS * playbackRate, 240);
  const endTime = Math.min(startTime + forwardSeconds, duration);
  proactivePrebufferWindowRef.current = { startTime, endTime };
}
```

- [ ] **Step 6.3: Add helper to handle prebuffer after seek**

Define this as a closure inside `useMSEPlayer` so it can access `state`, `proactivePrebufferMsgIdRef`, `proactivePrebufferWindowRef`, `invoke`, and `diagLog`:

```typescript
function handlePrebufferAfterSeek(
  targetTime: number,
  duration: number,
  playbackRate: number,
  parsed: { messageId: string; folderId: string } | null
) {
  if (!parsed || duration <= 0) return;
  const window = proactivePrebufferWindowRef.current;
  if (window && targetTime <= window.endTime) {
    // Inside or behind the current window — keep prebuffer running.
    return;
  }
  // Forward outside the window — restart.
  const _ppMsgId = proactivePrebufferMsgIdRef.current;
  if (_ppMsgId) {
    invoke('cmd_stop_proactive_prebuffer', { messageId: _ppMsgId }).catch(() => {});
    proactivePrebufferMsgIdRef.current = 0;
  }
  proactivePrebufferWindowRef.current = null;
  // Report new position to start a fresh prebuffer.
  invoke('cmd_report_playback_position', {
    messageId: parseInt(parsed.messageId),
    folderId: parseInt(parsed.folderId),
    currentTimeS: targetTime,
    durationS: duration,
    fileSize: state.current.fileLength,
    isPlayerDownloading: false,
    playbackRate,
  }).then((spawned: any) => {
    if (spawned) {
      proactivePrebufferMsgIdRef.current = parseInt(parsed.messageId);
      recordProactiveWindow(targetTime, duration, playbackRate);
      diagLog(`[PROACTIVE] Restarted from ${targetTime.toFixed(1)}s (forward outside old window)`);
    }
  }).catch((e: any) => console.error('[PROACTIVE] Restart failed:', e));
}
```

- [ ] **Step 6.4: Record window when initial prebuffer spawns**

In the initial proactive spawn (around `cmd_report_playback_position` success), add:
```typescript
recordProactiveWindow(0, estimatedDurationS, 1);
```

- [ ] **Step 6.5: Record window when periodic position report spawns a new prebuffer**

In the quota guard periodic position report, in the `.then((spawned: any) => { ... })` block, add:
```typescript
if (spawned) {
  proactivePrebufferMsgIdRef.current = parseInt(parsed.messageId);
  recordProactiveWindow(curTime, knownDuration, video.playbackRate || 1);
  diagLog(`[PROACTIVE] Spawned disk prebuffer for msg ${parsed.messageId} at ct=${curTime.toFixed(1)}s`);
}
```

- [ ] **Step 6.6: Call helper from all three seek paths**

**Buffered seeks** (already added in Tasks 3, 4, 5): call immediately after trimming, before setting `video.currentTime`.

**Unbuffered seeks** must call inside the function that actually executes the seek:

- **mpegts.js:** In `runTsSeek`, before `_mpegtsUnbufferedSeek(target, dur, isCacheHit)`:
```typescript
const parsed = parseStreamUrl(streamUrl);
handlePrebufferAfterSeek(target, dur, video.playbackRate || 1, parsed);
await _mpegtsUnbufferedSeek(target, dur, isCacheHit);
```

- **fMP4:** At the top of `executeFmp4Seek`, after `clearDownloadedRanges()` and before fetching the seek segment:
```typescript
const parsed = parseStreamUrl(streamUrl);
handlePrebufferAfterSeek(clampedTime, state.current.duration, video.playbackRate || 1, parsed);
```

- **transmuxer:** At the top of `executeTransmuxerSeek`, after `transmuxerSeekInProgressRef.current = true` and before `stopStreamingChain()`:
```typescript
const parsed = parseStreamUrl(streamUrl);
handlePrebufferAfterSeek(clampedTime, state.current.duration, video.playbackRate || 1, parsed);
```

- [ ] **Step 6.7: Clear prebuffer window on cleanup**

The prebuffer is stopped in at least two cleanup sites (around `app/src/hooks/useMSEPlayer.ts:1041-1044` and `1125-1128`). In each, after `proactivePrebufferMsgIdRef.current = 0;` add:
```typescript
proactivePrebufferWindowRef.current = null;
```

- [ ] **Step 6.8: Verify build passes**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run build
```

Expected: PASS.

- [ ] **Step 6.9: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
git add src/hooks/useMSEPlayer.ts
git commit -m "feat: proactive prebuffer pivot on forward-outside seek"
```

---

### Task 7: Edge-case hardening

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts`

- [ ] **Step 7.1: Guard against removing past currentTime in trimBufferBehind**

Ensure `trimBufferBehind` never removes data that would erase the current playhead. The helper already computes `keepStart = targetTime - keepBehindSeconds`, so the playhead remains inside the kept window. Add an explicit guard:

```typescript
if (keepStart <= 0) return; // keepStart is at 0, nothing behind to remove
```

- [ ] **Step 7.2: Handle seek near end of file**

`computeSlidingWindowSeconds` returns a target in seconds; consumers must clamp it to the remaining media duration so the player does not request data past EOF.

In `downloadLoop` (fMP4):
```typescript
const { forward } = computeSlidingWindowSeconds(avgBitrate, videoRef.current?.playbackRate || 1);
const clampedForward = Math.min(forward, state.current.duration - (videoRef.current?.currentTime || 0));
if (ahead <= clampedForward) break;
```

In `executeStreamingRefill` (transmuxer):
```typescript
const { forward: MAX_BUFFER_AHEAD } = computeSlidingWindowSeconds(avgBitrate, video.playbackRate || 1);
const clampedForward = Math.min(MAX_BUFFER_AHEAD, state.current.duration - video.currentTime);
if (ahead >= clampedForward) {
  // ... existing sleep path
}
```

In the mpegts.js quota guard, `capTargetTime = curTime + QUOTA_KEEP_AHEAD` is already clamped to `duration` via `findByteForTime`, so no extra change is needed.

- [ ] **Step 7.3: Verify tests still pass**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run test -- --run
```

Expected: 72 tests pass.

- [ ] **Step 7.4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
git add src/hooks/useMSEPlayer.ts
git commit -m "fix: edge-case guards for sliding window and seek end"
```

---

### Task 8: Final verification

- [ ] **Step 8.1: Full test suite**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run test -- --run
```

Expected: `Test Files 3 passed, Tests 72 passed`.

- [ ] **Step 8.2: Production build**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run build
```

Expected: `✓ built in ...s`.

- [ ] **Step 8.3: Runtime checks (manual or with dev build)**

Start the dev build and verify:
1. Buffered seek in mpegts.js path: SourceBuffer behind the playhead is removed within 1 s (check `video.buffered` ranges).
2. Unbuffered seek: downloader restarts from the new position (white/green buffer bars reset).
3. Prebuffer: only restarts on forward-outside seek. No `cmd_stop_proactive_prebuffer` calls on buffered arrow-key seeks.
4. High-bitrate test file (> 8 Mbps): no `QuotaExceededError` in console.

- [ ] **Step 8.4: Final commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
git add -A
git commit -m "feat: sliding in-memory buffer window + seek prebuffer pivot"
```

---

## Edge Cases Handled

1. **Seek to beginning (< 30 s):** `keepStart = 0`; nothing is removed behind. Extend ahead to 180 s (or dynamic cap).
2. **Seek near end (< 180 s from end):** forward extension is clamped to `duration - targetTime`.
3. **High-bitrate video:** `computeSlidingWindowSeconds` shrinks forward/backward to stay under 250 MB.
4. **SourceBuffer updating during buffered seek:** `trimBufferBehind` skips updating buffers; the queued operation or the next quota guard tick completes the trim.
5. **Multiple rapid buffered seeks:** each seek re-trims; removes are queued by `SourceBufferWrapper` or the browser.
6. **Unbuffered seek while prebuffer is starting:** `cmd_stop_proactive_prebuffer` is idempotent; backend cancellation via `cancelled_transfers` handles races.
7. **Backward seek outside prebuffer:** prebuffer is kept because it is still ahead of the new playhead.
8. **Forward seek exactly at prebuffer end:** `targetTime <= endTime` is treated as inside; no restart.
9. **Playback rate changes:** `computeSlidingWindowSeconds` is called on every seek and every quota guard tick (it ignores playback rate for the time window, relying on lazyLoad/recover for drain-rate changes).
10. **Unknown bitrate:** helper falls back to `60 s / 30 s` so the buffer never grows unbounded.
11. **mpegts.js shadow cache bloat:** `StreamShadowCache.trimAround` is called after buffered seek to keep JS cache near the playhead.
12. **Continuous backward eviction:** `evictOldBuffer` is called every fMP4/transmuxer iteration and after each transmuxer refill, so the 30 s behind window is maintained even without explicit seeks.
13. **Emergency QuotaExceededError:** the mpegts.js quota guard keeps its last-resort behind-window shrink (15 s, then 0 s) as a safety net.

---

## Self-Review Checklist

- **Spec coverage:** Every requirement (A1-A3, B1-B2, C1-C4) maps to a task.
- **Placeholder scan:** No `TBD`, `TODO`, or "handle edge cases" without concrete code.
- **Type consistency:** `computeSlidingWindowSeconds` returns `{ backward, forward }` everywhere; `TrimableBuffer` interface matches `SourceBuffer` and `SourceBufferWrapper`.
- **Cross-boundary API check:** `cmd_report_playback_position` and `cmd_stop_proactive_prebuffer` call sites are unchanged except for new `handlePrebufferAfterSeek` helper; no new required arguments are added to existing commands.
- **Helper signature reality check:** `SourceBufferWrapper.remove(start, end)` exists. `StreamShadowCache.trimAround(centerByte, windowBytes)` exists. `video.buffered` is a `TimeRanges`. `mseCtrl.getObject().sourceBuffers` is a `SourceBufferList`. `evictOldBuffer` is updated to use the dynamic window before fMP4/transmuxer builds. `fallbackBehindRef` is still used for the mpegts.js emergency QuotaExceededError shrink.
