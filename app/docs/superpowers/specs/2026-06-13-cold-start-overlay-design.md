# Cold-start "No Buffer optimization" overlay — Design Spec

**Date:** 2026-06-13  
**Scope:** Frontend UX + MSE player startup gate for TS video previews  
**Status:** Approved by user

## 1. Goal

When a TS video is opened for the **first time with no usable cache**, show a purposeful pre-buffering overlay instead of the current behavior (video frame flashes for a second, then stalls while the buffer gate times out). Once the backend/frontend have filled a minimum in-memory buffer, fade the overlay and start smooth playback.

If the shadow cache already has enough data, skip the overlay entirely and attach the player immediately.

## 2. Trigger condition

Display the overlay only when **all** of the following are true:

1. The detected format is TS and the player is taking the mpegts.js path.
2. The `StreamShadowCache` for the current message is empty or has less than `MIN_COLD_START_BUFFER` contiguous bytes.
3. This is the first open of this video in the current player session (not a seek or re-open within the same `useMSEPlayer` lifetime).

Otherwise, the player attaches immediately with the existing buffer gate logic unchanged.

## 3. Buffer thresholds

Dual threshold + hard timeout:

| Threshold | Value | Purpose |
|---|---|---|
| Minimum contiguous bytes | 5 MB | Covers PAT/PMT, first video IDR, audio init, and ~10–15 s of A/V at 4 Mbps. |
| Minimum buffered time | 10 s | Fallback for low-bitrate files where 5 MB is excessive. |
| Hard timeout | 10 s | Never leave the user waiting indefinitely. |

The overlay hides when **either** the byte threshold **or** the time threshold is met, **or** when the hard timeout expires.

## 4. UI/UX

- Full-screen overlay rendered inside the `FastStreamPlayer` modal, centered content, `z-index` above the video element.
- Animated headline: **"Optimizing video for No Buffer playback"**.
- Sub-line showing real progress: **"Pre-buffering 5 MB for instant playback"** or **"X MB / 5 MB"**.
- Thin progress bar tied to the actual shadow-cache or backend progress.
- Close button in the top-right corner that cancels the background download and closes the preview.
- Smooth fade-out (~300 ms) once the player is ready, then playback starts automatically.

## 5. Data flow

1. User clicks a TS video → `PreviewModal` opens with `FastStreamPlayer`.
2. `useMSEPlayer` receives the `streamUrl` and `file` props.
3. Before creating the `MediaSource` / mpegts.js player, `useMSEPlayer` checks the shadow cache and the current buffer state.
4. If cold-start conditions are met:
   - Set a new state flag `isColdStartBuffering = true`.
   - Trigger the existing proactive prebuffer download in the background.
   - Render the overlay via a new component in `FastStreamPlayer`.
5. The overlay receives progress from `useMSEPlayer` (total bytes cached for the current message, or backend events).
6. When the threshold is met:
   - `useMSEPlayer` creates the `MediaSource`, attaches mpegts.js, and sets `video.src`.
   - The overlay fades out.
   - Playback starts automatically.
7. If the hard timeout is reached first, hide the overlay and attach the player with whatever buffer exists (fallback to current behavior).

## 6. Edge cases

- **Warm cache:** overlay is never shown; player attaches immediately.
- **User closes preview while buffering:** cancel the proactive prebuffer and clean up the overlay.
- **Hard timeout without enough data:** hide overlay and attach player with available buffer.
- **Backend / download error:** replace the overlay with an error message instead of hanging.
- **Seek or re-open within same session:** do not re-show the overlay if the cache is already warm.

## 7. Files to modify

| File | Change |
|---|---|
| `src/components/dashboard/FastStreamPlayer.tsx` | Add overlay component, wire it to `useMSEPlayer` state, handle fade-out animation. |
| `src/hooks/useMSEPlayer.ts` | Add cold-start detection, `isColdStartBuffering` state, progress reporting, threshold logic. |
| `src/lib/faststream/StreamShadowCache.ts` | Expose a method to query contiguous cached bytes for the current message (if not already public). |
| CSS/Tailwind | Overlay styles, animation keyframes, progress bar. |

## 8. Success criteria

- Cold-start TS video: user sees the overlay for 1–10 s, then playback starts without stalling.
- Warm-start TS video: overlay is skipped, playback starts immediately.
- Closing the preview during buffering cancels the background download.
- No regression for MP4, MKV, or native remux playback paths.
- Build passes (`npm run build`, `cargo check`) and existing tests pass.

## 9. Out of scope

- Changing the backend download algorithm or chunk sizes.
- Adding a new backend endpoint for progress events.
- Redesigning the full preview modal (only the cold-start overlay is in scope).
