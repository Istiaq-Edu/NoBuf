# Sequential TS Cold-Start Design

## Goal

Make Telegram-Drive TS video playback cold-start reliable: an overlay fetches the first 5 MB into **both** the disk prebuffer and the in-memory shadow cache, then the mpegts.js player starts on that warm cache and continues the same continuous download without pausing.

## Current problem

The TS path uses two parallel tasks:

1. `waitForColdStartBuffer` fetches 5 MB via `/stream` into the shadow cache.
2. `initTransmuxerPlayer` creates the mpegts.js player and calls `player.load()` immediately.

Both hit the same shadow cache and `/stream` URL before the cache is warm. The player starts its own fetch from byte 0 while the overlay is still downloading, and the lazyLoad/pacing/quota-guard machinery activates on a tiny buffer. The result is a hand-off stall: the shadow cache grows, but the SourceBuffer does not, and the buffer ahead shrinks.

## Proposed change

Make the cold-start **sequential**:

1. Show the overlay immediately.
2. Spawn the Rust proactive disk prebuffer right away so the disk cache is also warming.
3. The overlay fetches the first 5 MB via `/stream` `Range: bytes=0-5242879` into the shadow cache. The same `/stream` call also writes to disk via the existing cache pipeline.
4. Only after 5 MB is cached, create the mpegts.js player, attach media, and call `player.load()`.
5. The player’s first range request hits the shadow-cache interceptor, which serves 0–5 MB instantly from memory, then continues fetching from byte 5 MB onward.
6. Wait for `MEDIA_INFO` and at least 5 s of SourceBuffer before hiding the overlay.
7. Call `player.play()`. The download flow continues.

## Files affected

- `app/src/hooks/useMSEPlayer.ts` — change the TS init path from parallel to sequential; move proactive prebuffer spawn earlier; keep overlay active until the player is ready to play.
- `app/src/components/dashboard/FastStreamPlayer.tsx` — no change expected; overlay visibility is already driven by `isColdStartBuffering`.
- `app/src/lib/faststream/StreamShadowCache.ts` — no structural change; ensure the interceptor is installed before the 5 MB fetch and remains installed when the player starts.

## Detailed flow

```
Open TS video
├── show overlay
├── spawn proactive disk prebuffer (cmd_report_playback_position, ct=0)
├── waitForColdStartBuffer()
│   ├── create shadow cache
│   ├── install interceptor
│   └── fetch 5 MB via /stream Range request
│       └── bytes are siphoned into shadow cache AND written to disk by /stream
├── initTransmuxerPlayer()  [only after 5 MB is ready]
│   ├── create mpegts.js player (lazyLoad=true, 120/60)
│   ├── attachMediaElement
│   ├── player.load()
│   ├── wait for MEDIA_INFO
│   └── wait for SourceBuffer >= 5 s
├── hide overlay
└── player.play() — continues same download flow from byte 5 MB
```

## Key implementation points

1. **Remove `Promise.all([initPromise, coldStartPromise])` and the `coldStartDeferred`/`coldStartResolve` mechanism.** Replace with:
   ```ts
   const coldStartReady = await waitForColdStartBuffer(format, url);
   if (cancelledRef.current) return;
   await initTransmuxerPlayer(url, mediaSource, blobUrl!, format);
   ```
   `initTransmuxerPlayer` no longer takes any cold-start promise because the bootstrap is already complete when it is called.

2. **Move proactive prebuffer spawn out of `initTransmuxerPlayer`.** It should run as soon as the video is opened, not after the 5 MB bootstrap. The prebuffer already interleaves with the overlay fetch via the backend Semaphore(1), so there is no race.

3. **Overlay hide condition.** `waitForColdStartBuffer` currently resolves the deferred and sets `isColdStartBuffering(false)` at the 5 MB byte target. Keep that logic, but make `initTransmuxerPlayer` wait for `MEDIA_INFO` and the 5 s SourceBuffer gate before calling `play()`. The overlay will still be visible during player init because `isColdStartBuffering` remains true until the byte target is reached. We must ensure the overlay is not hidden until `player.play()` is actually ready — so we should not call `coldStartResolve()` until just before `initTransmuxerPlayer` starts, or keep `isColdStartBuffering` true inside `initTransmuxerPlayer` until the buffer gate passes.

   Chosen approach: `waitForColdStartBuffer` resolves `coldStartResolve` only when 5 MB is ready and then returns. It does **not** set `isColdStartBuffering(false)` inside itself. `initTransmuxerPlayer` sets `isColdStartBuffering(false)` after the startup buffer gate passes and just before `player.play()`. This guarantees the overlay is visible while the player is initializing and only disappears when the video can actually play without buffering.

4. **Quota guard / pacing / serve limit.** The quota guard, interceptor serve limit, and pacing logic should only be configured after the player is running. Do not set `_interceptorServeLimitByte` or `_pacingBps` during the 5 MB bootstrap. The bootstrap fetch should run at full speed.

5. **No mpegts.js player creation before bootstrap.** The current code creates the player in parallel. We delay it until the shadow cache has 5 MB. This removes the race.

6. **Keep existing patches.** The `FetchStreamLoader.abort()` patch, `endOfStream` guard, `resumeTransmuxer` patch, `suspendTransmuxer` patch, and quota guard remain. They only activate after the player is initialized.

## Edge cases

- **Timeout:** If the 5 MB fetch takes longer than `COLD_START_TIMEOUT_MS`, play with whatever is buffered.
- **Warm cache:** If the shadow cache already has ≥5 MB contiguous from byte 0, skip the overlay and start the player immediately.
- **Player init failure:** If mpegts.js fails to initialize, fall back to native playback as today.
- **User close:** If the user closes the video while the bootstrap is in progress, `cancelledRef` must stop the bootstrap fetch and the player init.

## Verification

- `npm run build` passes.
- `npm run test` passes.
- `cargo check` passes.
- Manual run on the same TS file:
  - Overlay shows immediately.
  - Overlay shows progress to 5 MB.
  - Overlay hides only when video is ready to play.
  - `[MPEGTS-STATE]` logs show `ahead` staying at or above ~5 s after playback starts, not shrinking to 2–3 s.
  - Green bar (disk cache) and white bar (SourceBuffer) keep growing.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Sequential startup feels slower | The overlay is already shown during the 5 MB fetch; we are not adding new waiting time, only preventing the player from starting on a cold cache. |
| Proactive prebuffer spawn before player may duplicate work | Backend serializes Telegram downloads via Semaphore(1); the disk cache is shared, so duplicate requests are harmless. |
| Overlay stays too long if player init is slow | We keep the 5 s SourceBuffer gate and a timeout so the overlay never blocks indefinitely. |
