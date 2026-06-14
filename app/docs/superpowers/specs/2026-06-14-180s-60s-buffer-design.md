---
date: 2026-06-14
topic: 180s ahead / 60s behind in-memory buffer policy
status: draft
---

# 180s Ahead / 60s Behind In-Memory Buffer Policy

## Overview

Change the mpegts.js TS player so that the in-memory (SourceBuffer) white bar always represents a fixed **180 seconds ahead and 60 seconds behind** the current playhead, whenever data is available. The download speed should be dynamic to playback speed: fill as fast as possible until the 180s target is reached, then pace at playback speed to maintain it. When the user seeks to a position whose forward 180s window is already cached on disk, the player should load that 180s instantly from the disk cache.

## Goals

- Fixed media-time buffer window: **180s ahead, 60s behind** at all playback speeds.
- Fill speed is dynamic: burst to the target when below it, then match consumption rate (`playbackRate × content bitrate`).
- Seeks into disk-cached ranges resume playback instantly with a full 180s ahead buffer.
- Do not change the existing disk prebuffer policy; reuse it as-is.
- Keep the existing cold-start overlay gate (5 MB / 10 s real buffered time).

## Non-goals

- Change the disk prebuffer size or strategy.
- Change the 5 MB / 10 s cold-start gate.
- Support buffer sizes that exceed the browser SourceBuffer quota without fallback.

## Current State

| Element | Current Value | Where |
|---|---|---|
| Ahead target | 120s at 1×, scaled to 150s cap | `useMSEPlayer.ts` lazyLoad / quota guard |
| Behind target | 300–600s (5–10 min) | `autoCleanupMin/MaxBackwardDuration` in mpegts.js config |
| Quota-guard eviction | `[curTime, curTime + QUOTA_KEEP_AHEAD]` | `sourceBufferQuotaGuard` in `useMSEPlayer.ts` |
| Seek byte offset | Linear CBR estimate | `_mpegtsUnbufferedSeek` in `useMSEPlayer.ts` |
| Interceptor pacing | `_pacingBps` set by quota guard | `StreamShadowCache.ts` |
| Memory hit cap | 30 MB | `MAX_HIT_SERVE_BYTES` in `StreamShadowCache.ts` |

Key constraints found:

1. Setting `autoCleanupMaxBackwardDuration = 60` directly crashes mpegts.js during the first minute because it computes `remove(0, currentTime - 60)` (negative end).
2. The current quota guard evicts **all** data behind the playhead on quota pressure, so the 60s behind target must be enforced by our own code.
3. mpegts.js uses open-ended `Range: bytes=X-` requests, which are never fully served from the 30 MB JS shadow-cache hit cap. The “instant from disk” path therefore relies on the backend `/stream` endpoint reading from its disk cache.

## Proposed Design

### 1. In-memory buffer target (fixed)

- **Ahead target:** 180 s of media time, fixed regardless of `playbackRate`.
- **Behind target:** 60 s of media time, fixed regardless of `playbackRate`.
- **Total window:** 240 s of media time around the playhead, clamped at file start/end.

### 2. Fill speed strategy

- **When buffered ahead < 180 s:** download as fast as possible. `_pacingBps = 0`.
- **When buffered ahead ≥ 180 s:** pace at `playbackRate × global average bitrate` so the buffer stays at 180 s.
- **When paused:** continue filling at full speed to 180 s (consumption is zero, so the buffer naturally stabilizes at 180 s once reached).
- **Bitrate fallback:** use `mpegtsDurationRef.current` and `fileLength` for the global average bitrate; fall back to `state.current.duration` if the real duration is not yet known.

### 3. Behind-window handling (Approach B)

- Disable mpegts.js native cleanup: `autoCleanupSourceBuffer: false` in the player config.
- Extend the custom `sourceBufferQuotaGuard` to evict to `[curTime - 60, curTime + 180]` instead of `[curTime, curTime + targetAhead]`.
- Clamp the behind edge to `0` when `curTime < 60`.
- On `BUFFER_FULL` / `QuotaExceededError`, run the same eviction window immediately.

### 4. High-bitrate fallback

If the total 240 s window cannot fit in the browser SourceBuffer (e.g., high-bitrate files), preserve the **180 s ahead** target and **shrink the behind window** first:

1. Try 180/60.
2. If quota error or tight pressure, try 180/30.
3. If still tight, try 180/15.
4. Ahead is never reduced below 180 s while data is available.

The fallback thresholds are measured in bytes, computed as `targetSeconds × globalAverageBitrate` and compared against an empirical safe budget (default 250 MB, configurable).

### 5. Seek into disk cache (instant 180s)

When the user seeks to `seekTime`:

1. Check whether the disk cache covers `[seekTime, seekTime + 180]` (or to EOF if near end). Use the existing `cachedRunFrom` / `rangeEndBefore` helpers.
2. Compute the seek byte using the VBR backend byte-time index (`byteTimeSamplesRef.current`) when available; otherwise fall back to the linear CBR estimate.
3. In `_mpegtsUnbufferedSeek`:
   - Clear the old SourceBuffer ranges.
   - Reset demuxer/remuxer state (same as today).
   - Set the shadow-cache `_interceptorServeLimitByte` to the byte for `seekTime + 180` (VBR-aware if samples exist).
   - Temporarily disable pacing: `capSc._pacingBps = 0` for the duration of the seek burst.
   - Restore pacing once the buffer reaches 180 s ahead (handled by the quota guard on the next tick).
4. The IOController fetches from the seek byte; the backend `/stream` endpoint serves from disk cache via `CACHE-PREFIX` if the data is present, so the 180 s fill is effectively instant from the user’s perspective.

### 6. lazyLoad / IOController settings

- `lazyLoad: true` remains enabled.
- `lazyLoadMaxDuration`: fixed **180 s** (not scaled by playbackRate).
- `lazyLoadRecoverDuration`: fixed **120 s** so the IOController resumes when the buffer drops to 120 s ahead, giving a 60 s safety margin before underrun.
- On playback-rate change, do **not** scale these values; only scale the pacing bitrate multiplier.

### 7. Quota guard updates

- `BASE_QUOTA_KEEP_AHEAD`: 180 s (fixed).
- `BASE_QUOTA_DANGER_DURATION`: 240 s (or 220 s; used only to clear aggressive mode).
- Cap `QUOTA_KEEP_AHEAD` at 180 s (no higher cap needed because the new base is 180 s).
- Remove the current `playbackRate` scaling of the ahead target; keep scaling only for the pacing bitrate.
- Replace hard-coded `MAX_SERVE_AHEAD_SECONDS = 150` with 180 in all resume paths (normal lazyLoad, progressive, emergency, safe).

### 8. Edge cases

| Scenario | Behavior |
|---|---|
| Near start (`curTime < 60`) | Behind window clamps to `0`. Ahead still targets 180 s. |
| Near end (`curTime + 180 > duration`) | Ahead window clamps to `duration`. Buffer is whatever remains. |
| High bitrate / quota error | Shrink behind window (60 → 30 → 15) while keeping 180 s ahead. |
| Slow network | Play with whatever is available; keep filling as fast as possible. No artificial stall waiting for 180 s. |
| Seek to uncached position | Use linear byte estimate, fall back to network download; no instant guarantee. |
| Paused | Fill to 180 s ahead if not already there; once there, stay there. |

## Components to Change

1. **`src/hooks/useMSEPlayer.ts`**
   - Player config: set `lazyLoadMaxDuration: 180`, `lazyLoadRecoverDuration: 120`, `autoCleanupSourceBuffer: false`.
   - `adjustBufferForSpeed`: stop scaling the ahead/behind target by `playbackRate`; only scale pacing.
   - `sourceBufferQuotaGuard`: change eviction window to `[curTime - 60, curTime + 180]`; implement high-bitrate fallback; remove `Math.min(150, …)` cap on ahead target.
   - Resume paths (normal, progressive, emergency, safe): change `MAX_SERVE_AHEAD_SECONDS` from 150 to 180.
   - `_mpegtsUnbufferedSeek`: use VBR byte-time index for seek byte; disable pacing; set serve limit to `seekTime + 180`.

2. **`src/lib/faststream/StreamShadowCache.ts`** (minor)
   - Consider raising `MAX_HIT_SERVE_BYTES` if bounded 180 s requests should be served purely from the JS memory cache. For now, leave unchanged because the backend `/stream` cache handles the disk fill.

3. **`src-tauri/src/commands/streaming.rs` / `src-tauri/src/server.rs`**
   - No changes required; the existing disk prebuffer and `/stream` cache already support the design.

## Testing Plan

1. **Unit tests**
   - Update `TsResumeUtils.test.ts` for `computeResumeByte` with 180 s target and 60 s undershoot.
   - Add tests for `findByteForTime` / `findTimeForByte` at seek boundaries.

2. **Static validation**
   - `npx tsc --noEmit`
   - `npm run test`
   - `npm run build`
   - `cargo check`

3. **Runtime tests**
   - Long playback at 1×: verify buffer stays at ~180 s ahead and 60 s behind without white-bar flicker.
   - Seek forward into a cached region: verify the 180 s ahead buffer fills instantly and playback resumes immediately.
   - Seek backward: verify behavior when the 60 s behind window is not cached.
   - Playback at 2×/4×: verify buffer stays at 180 s/60 s and does not underrun.
   - High-bitrate file (if available): verify fallback to 180/30 or 180/15 on quota pressure.

## Risks

- Disabling mpegts.js `autoCleanupSourceBuffer` puts all behind-window eviction responsibility on the custom quota guard. A bug could leak memory or trigger browser quota errors.
- A fixed 180 s ahead window increases average memory usage compared to the current 120 s cap. Low-memory devices may hit the quota fallback more often.
- The “instant from disk” seek depends on the backend `/stream` endpoint having the data in its cache. If the disk cache window is smaller than 180 s ahead, the seek will still be network-bound.
