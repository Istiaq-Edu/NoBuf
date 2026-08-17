# Regression review — MKV seek and subtitle changes

## Verdict

**Request changes was correct for the reviewed implementation.** The review found two concrete cross-format backend regressions and two ASS failure-path defects. They have been removed or fixed in the current worktree.

## Findings and disposition

### 1. Unconditional `source_id=remux` cache-poll bypass — FIXED

The reviewed patch attached `source_id=remux` to the shared `/stream` URL used by ffprobe, ffmpeg, the TS stdin feeder, and background remux. `should_skip_cache_poll` then bypassed the cache coordinator for every remux-routed format.

Impact included timed-ID3/plain TS recovery, MP4 HEVC, MKV AVC/HEVC, and audio-track remux—not only the affected MKV.

**Resolution:** removed `source_id=remux` and restored the original two-input cache-poll decision. Partially cached remux reads again consume cached islands and retain the existing fallback policy.

### 2. Shared remux coordinator identity / cross-cancellation — FIXED

All remux readers shared one coordinator identity, allowing unrelated ffprobe, foreground ffmpeg, feeder, and background readers to cancel or contend with each other.

**Resolution:** removing `source_id=remux` restores the pre-change coordinator behavior. No new cross-format identity class remains.

### 3. JASSUB failed boot leaked a worker and rejected cleanup — FIXED

Vendored JASSUB 2.5.1 `destroy()` awaits `ready` before terminating the worker. If `ready` rejects, cleanup throws before termination.

**Resolution:** the overlay handles rejected startup and explicitly terminates the worker/removes its canvas on cleanup. A mutation that removed worker termination made the regression test fail.

### 4. Synchronous JASSUB constructor failure could leave an orphan canvas — FIXED

JASSUB inserts its canvas before creating the Worker. A Worker constructor failure can therefore throw after DOM insertion but before the instance is returned.

**Resolution:** the catch path removes an adjacent `canvas.JASSUB` orphan. The test models the real constructor ordering.

### 5. Thumbnail test changed `cueless=true` to `false` — NARROWED, COVERAGE RESTORED

This was not a production regression: the old HEAD assertion was already inconsistent with shipped behavior (`cueless=true` intentionally returns `skip`).

**Resolution:** retain the valid non-cueless binary-search assertion and add an explicit cue-less `skip` assertion.

### 6. Production-only subtitle diagnostics — FIXED BY REMOVAL

The added revision diagnostic performed an O(n) cue scan and raw `console.log`. The existing `dropConsole` property was not a valid Vite option.

**Resolution:** removed the diagnostic scan and success log rather than changing global console behavior. Error reporting remains.

### 7. JASSUB worker entry and ES worker format — VERIFIED

The old URL targeted Emscripten wasm glue, not the JASSUB controller worker. The new `dist/worker/worker.js?worker&url` entry and `worker.format='es'` are correct.

Production build emitted the controller worker, pthread worker, both WASM assets, fonts chunk, and the unrelated PDF worker.

### 8. Format routing — VERIFIED STATICALLY

- MKV AVC/HEVC: remain ffmpeg `-ss` HTTP input; no byte-forward stdin.
- MP4 HEVC: remains `-ss` only.
- Timed-ID3/plain TS recovery: retains TS-only `start_byte` feeder and PAT/PMT init prefix.
- Native/direct playback: unchanged.
- SRT/VTT: DOM cue path unchanged except the required `revision` invalidation.
- ASS/SSA: worker URL corrected; cleanup hardened.
- Bitmap subtitles: still disabled/labelled as image-based; no rendering behavior changed.
- Pause/seek state: route predicates and paused-state machinery were not changed by this patch.

## Verification

- Frontend full suite: **66 files / 731 tests passed**
- Rust full library suite: **272 passed**
- TypeScript: `npx tsc --noEmit -p tsconfig.json` passed
- Rust: `cargo check --message-format short` passed
- Production build: `npx vite build` passed
- `git diff --check` passed
- Mutation: removing failed-worker termination caused the ASS cleanup test to fail
- Mutation: forcing cache-poll decision false caused the Rust cache policy test to fail

## Runtime-unproven

No live GUI playback was run against the user's large HEVC MKV or representative MP4/TS files. Static routing and automated regression coverage are green, but real WebView2 playback must still confirm:

1. Cold restart Tauri (Rust changed).
2. HEVC MKV: seek to several distant positions and verify playback resumes without a front-of-file wait.
3. Embedded ASS and SRT: verify text appears before and after each seek.
4. Previously working MKV AVC, MP4 HEVC, timed-ID3/plain TS, and native MP4: open, seek, pause-seek, resume, and switch audio/subtitle tracks.
