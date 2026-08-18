# Round-3 plan — audio-switch stutter + bounded subs extraction + far-hover bisection

> **For agentic workers:** execute task-by-task with TDD. Steps use checkboxes. Read
> `reports/round3-solution.md` first (authoritative design; MUST R1 + adopted SHOULDs folded in).
> Anchors are GREP STRINGS, not line numbers (file drifts). Windows git-bash: terminal paths
> `/d/DEVELOPMENT/...`; write_file/patch use `D:/DEVELOPMENT/...`. search_files is broken in
> this repo — use `grep -n` via terminal. NoBuf tsconfig has noUnusedLocals ON: declare refs in
> the task that first READS them.

**Goal:** kill the audio-switch stutter (Fix A), make embedded-subtitle selection work on
partially-cached files (Fix B), give far hovers real thumbnail frames on cue-less MKVs (Fix C).

**Architecture:** A = reorder `_switchMkvAudioTrack` (transmux-before-flush) + harvested-index
boundary fallback in the transmuxer helpers. B = new `cached_prefix` /stream param that serves
the cached prefix then ENDS the body (ffmpeg exits 0 with prefix cues, existing X-Subs-Partial
path serves them) + frontend partial-track re-extract. C = byte-space cluster bisection +
synthetic `clusterPositionCache` entry injection so `getKeyPacket` walks ≤1-2 clusters.

**Gates baseline (recorded):** tsc 0 · vitest 415/415 (31 files) · cargo 178/178.

---

## Task 0: prep commit — pre-existing in-flight work

The tree has UNCOMMITTED pre-round-3 work: `app/src/hooks/useMSEPlayer.ts` (+~450 ln:
planAudioSwitch sbHasAudio/B4, mapAudioTrackToRemuxIdx, _switchMkvAudioTrack refinements) and
`app/src/__tests__/AudioTrackSelection.test.ts` (+37). Round-3 edits touch the same files —
commit it AS-IS first so round-3 diffs stay surgical.

- [ ] `cd /d/DEVELOPMENT/Telegram-Drive && git add app/src/hooks/useMSEPlayer.ts app/src/__tests__/AudioTrackSelection.test.ts && git commit -m "Audio-switch B4 reroute mapping + sbHasAudio planning (pre-round-3 in-flight work, committed as-is)"`
- [ ] Verify clean slate for those files: `git status --short | grep -v '^??'` → empty.
- [ ] Baseline: `cd app && npx tsc --noEmit` (expect 0) `&& npx vitest run 2>&1 | tail -3` (expect 415 passed).

## Task 1: Fix A-2 — harvested boundary fallback (TDD)

**Files:** Modify `app/src/lib/faststream/players/MediabunnyTransmuxer.ts`.
Create `app/src/__tests__/HarvestedBoundaryFallback.test.ts`.

- [ ] **Step 1 — write the failing test.** Mirror the construction pattern of
  `app/src/__tests__/HarvestedKeyframeIndex.test.ts` (read it first; direct
  `new MediabunnyTransmuxer` with `format: 'mkv'`, Tauri invoke mocked the same way). Cases:
  1. cue index empty + harvest `[10.4, 20.8, 31.2]` → `nextKeyframeAtOrAfter(12)` === 20.8
     (STRICTLY greater — mirrors cue-path semantics).
  2. `nextKeyframeAtOrAfter(20.8)` === 31.2 (exact-hit returns NEXT).
  3. Clamp: harvest `[10, 600]` → `nextKeyframeAtOrAfter(12)` === null (600 > 12+25 —
     gappy-harvest guard, HARVEST_BOUNDARY_CLAMP_S=25).
  4. `snapToCueKeyframe(20.799, 0.25)` === 20.8 via harvest fallback; `snapToCueKeyframe(15, 0.25)`
     === 15 (no neighbor within tolerance).
  5. Format gate: same harvest but `format: 'ts'` → `nextKeyframeAtOrAfter(12)` === null,
     `snapToCueKeyframe(20.799)` === 20.799 (identity).
  6. Cue index NON-empty → fallback never consulted (cue result wins even when harvest disagrees).
  Seed harvest via `(t as any).keyframeTimestamps = [...]` (private field; test precedent exists).
- [ ] **Step 2 — run, confirm FAIL:** `cd /d/DEVELOPMENT/Telegram-Drive/app && npx vitest run src/__tests__/HarvestedBoundaryFallback.test.ts` → cases 1-4 fail (today: null/identity).
- [ ] **Step 3 — implement.** In `MediabunnyTransmuxer.ts`:
  - Module const near the top (grep `const diagLog` or the import block):
    `const HARVEST_BOUNDARY_CLAMP_S = 25; // mirrors REFILL_MAX_DURATION_CAP (useMSEPlayer)`
  - `nextKeyframeAtOrAfter` (grep `nextKeyframeAtOrAfter(time: number)`): replace the
    `if (idx.length === 0 || !Number.isFinite(time)) return null;` early-out with: finite check
    first; then `if (idx.length === 0)` → fallback block: `if (this.config.format !== 'mkv') return null;`
    binary-search `this.keyframeTimestamps` for first ts STRICTLY > time; return
    `ts[lo] - time <= HARVEST_BOUNDARY_CLAMP_S ? ts[lo] : null`. Cue branch below unchanged.
  - `snapToCueKeyframe` (grep `snapToCueKeyframe(time: number`): same shape — when cue index
    empty and `format==='mkv'` and `keyframeTimestamps.length>0`, run the identical
    insertion-point + neighbor-compare loop over the numeric array (inline; it's 10 lines);
    else return `time` unchanged.
  - Comment on both: round-3 Fix A-2, cue-less switch/refill boundaries from harvest, clamp
    rationale (stopTime bypasses maxDuration in iterateVideoPackets — a gappy boundary would
    transmux minutes).
- [ ] **Step 4 — green + regression:** `npx vitest run src/__tests__/HarvestedBoundaryFallback.test.ts src/__tests__/HarvestedKeyframeIndex.test.ts src/__tests__/snapToCueKeyframe.test.ts src/__tests__/AudioStartChain.test.ts` → all pass (R7: the 3 direct-instantiation suites must stay green). `npx tsc --noEmit` → 0.
- [ ] **Step 5 — commit:** `git add app/src/lib/faststream/players/MediabunnyTransmuxer.ts app/src/__tests__/HarvestedBoundaryFallback.test.ts && git commit -m "Cue-less MKV: fall back to harvested keyframe index for refill/switch boundaries"`

## Task 2: Fix A-1 — reorder `_switchMkvAudioTrack` (transmux before flush)

**Files:** Modify `app/src/hooks/useMSEPlayer.ts` (grep `_switchMkvAudioTrack = async`).
No new unit test (hook-internal ordering; guarded by tsc + existing suites + e2e — the pure
pieces planAudioSwitch/mapAudioTrackToRemuxIdx already have suites).

- [ ] **Step 1 — read the current block** end-to-end: from `// 2. Hard rebuild from playhead`
  through `startStreamingChain();` + the trailing diagLog/return.
- [ ] **Step 2 — apply the reorder** (one patch; preserve every existing comment that still
  applies, update the ones describing order). Target state, annotated:
  ```ts
  // 2. Hard rebuild from playhead — mirrors the user-seek chain (§K).
  // Round-3 Fix A-1: transmux FIRST (old buffer keeps playing — segments land in
  // seekBufferRef), THEN changeType → flush → append. The playhead's no-data window
  // shrinks from flush+transmux+append to flush+append (~ms). Superseded/failed
  // switches now bail with the old buffer INTACT.
  const seekGen = ++transmuxerSeekGenRef.current;
  stopStreamingChain();
  refillInProgressRef.current = false;
  nullRefillCountRef.current = 0; // breaker: rebuild = fresh chain
  burstBufferRef.current = [];
  bufferingForSeekRef.current = true;
  seekBufferRef.current = [];

  // skipInitSegment:false — the new track needs a fresh ftyp+moov (its codec
  // config differs even when the codec string doesn't).
  const stopTime = transmuxer.nextKeyframeAtOrAfter?.(t + SEEK_START_DURATION) ?? undefined;
  const keyframeTimestamp = await transmuxer.seekTo(t, SEEK_START_DURATION, {
    skipInitSegment: false,
    ...(stopTime !== undefined ? { stopTime } : {}),
  });
  bufferingForSeekRef.current = false;
  if (isSeekSuperseded(seekGen, transmuxerSeekGenRef.current)) {
    seekBufferRef.current = [];
    diagLog('[AUDIO] mkv switch superseded by a newer seek — discarding (buffer intact)');
    return false;
  }
  if (keyframeTimestamp === null) {
    // G2 (cue-less MKV): rebuild seekTo nulled. Escalate to the ffmpeg tier carrying
    // the user's chosen track. Round-3: the SB was NOT flushed yet — the reroute
    // captures currentTime on live data (strictly better than the old post-flush path).
    seekBufferRef.current = [];
    diagLog(`[AUDIO] mkv switch: seekTo returned null — escalating to /remux tier (track ${trackId})`);
    remuxAudioIdxRef.current = await mapTrackToFfprobeIdx();
    return (await recoverMkvRerouteRef.current?.(`audio switch keyframe unresolvable (track ${trackId})`)) ?? false;
  }

  // changeType BEFORE the flush (review R6): on failure, revert IN PLACE — the old
  // buffer is still there and still playing; restart the chain and walk away.
  if (plan === 'rebuild-changetype') {
    try {
      await sbVideo.changeType(newMime);
      diagLog(`[AUDIO] mkv switch: SourceBuffer.changeType(${newMime}) applied (H1)`);
    } catch (e: any) {
      diagLog(`[AUDIO] mkv switch: changeType failed (${e?.message}) — reverting in place`);
      seekBufferRef.current = [];
      const revertMime = await transmuxer.setDesiredAudioTrack(null);
      if (!revertMime) {
        // Revert itself failed — same terminal shape as the null-keyframe path.
        remuxAudioIdxRef.current = await mapTrackToFfprobeIdx();
        return (await recoverMkvRerouteRef.current?.(`audio switch changeType+revert failed (track ${trackId})`)) ?? false;
      }
      startStreamingChain();
      return false;
    }
  }

  await sbVideo.resetForSeek();
  seekOffsetRef.current = keyframeTimestamp;
  await sbVideo.setTimestampOffset(keyframeTimestamp);
  const buffered = seekBufferRef.current;
  seekBufferRef.current = [];
  for (const item of buffered) {
    sbVideo.appendBuffer(item.data);
  }
  // Refill chain tops the buffer up from here (same as post-seek).
  startStreamingChain();
  diagLog(`[AUDIO] mkv switch → track ${trackId} complete at kf=${keyframeTimestamp.toFixed(2)}s (paused=${isPausedRef.current})`);
  return true;
  ```
  Ordering invariants (verify against verify-a H-A1c table while editing): seekGen capture and
  stopStreamingChain STAY before seekTo (abortSeek must not condemn the switch's own iteration;
  seekTo clears the flag on entry); bufferingForSeek+seekBuffer set BEFORE seekTo (callbacks
  route on the flag); supersession check IMMEDIATELY after seekTo; setTimestampOffset BEFORE
  the append loop; append loop uses the CAPTURED array.
- [ ] **Step 3 — gates:** `npx tsc --noEmit` → 0. `npx vitest run` → all green (415+6).
- [ ] **Step 4 — commit:** `git add app/src/hooks/useMSEPlayer.ts && git commit -m "Audio switch: transmux before flush + in-place changeType revert (kills switch stutter window)"`

## Task 3: Fix B server — `cached_prefix` bounded prefix reads (Rust)

**Files:** Modify `app/src-tauri/src/server.rs` only.

- [ ] **Step 1 — unit test first (args builder):** in the `#[cfg(test)]` module (grep
  `fn subtitle_kind_classification`), add:
  ```rust
  #[test]
  fn sub_extract_args_include_flush_packets() {
      let args = build_sub_extract_args("http://x/stream/home/1?token=t&source_id=subs", 2, false, false, "out.srt");
      let joined = args.join(" ");
      assert!(joined.contains("-flush_packets 1"), "srt: {}", joined);
      let args_ass = build_sub_extract_args("in.mkv", 3, true, false, "out.ass");
      assert!(args_ass.join(" ").contains("-flush_packets 1"), "ass path too");
  }
  ```
  Run: `cd /d/DEVELOPMENT/Telegram-Drive/app/src-tauri && cargo test --no-default-features sub_extract_args_include_flush_packets` → FAILS (assert).
- [ ] **Step 2 — `StreamQuery` field** (grep `pub(crate) cached_only: Option<bool>`): add below it:
  ```rust
  /// Round-3 subs fix: serve ONLY the already-cached prefix of the range, then
  /// END the body cleanly at the cache frontier — no poll-wait, no Telegram
  /// fallback, no coordinator subscribe/spawn. Unlike `cached_only` this never
  /// 503s a partially-cached range (that check is pre-body and whole-request).
  /// ffmpeg salvages every cue parsed before the close (exit 0, verified).
  /// Used exclusively by subtitles_extract_track for not-fully-cached files.
  pub(crate) cached_prefix: Option<bool>,
  ```
- [ ] **Step 3 — exhaustive struct literals (Rust!):** `grep -n 'cached_only: None\|cached_only: Some' src/server.rs` and add `cached_prefix: None,` to EVERY `StreamQuery { ... }` literal (5 known: remux ~:2113, fmp4 ~:4318, subs list ~:6020, track ~:6210 area, font ~:6313 area — trust the grep, not this list).
- [ ] **Step 4 — pre-body: skip the coordinator.** Locate the coordinator entry AFTER the
  cached_only 503 (grep `COORDINATOR: Check if an active SEQUENTIAL`). Capture
  `let cached_prefix_mode = query.cached_prefix.unwrap_or(false);` right before the cached_only
  check (grep `CACHED_ONLY: msg`), and wrap the ENTIRE coordinator section (subscribe/spawn,
  through the last pre-`stream!` targeted-download spawn — read the region to find its exact
  extent, it ends where the `async_stream::stream!` assignment begins) in
  `if !cached_prefix_mode { ... }`. A subs prefix read must NEVER subscribe to or spawn a
  Telegram download. (The initial FAST PATH fully-cached branch above stays — harmless.)
- [ ] **Step 5 — body gates.** Before the `stream!` block (grep `let stream = async_stream::stream!`)
  the flag must be moved in (it's Copy: `let cached_prefix_stream = cached_prefix_mode;`).
  Gate 1 — poll-wait: inside the poll loop's not-cached branch, BEFORE the sleep (grep
  `Data not cached yet — wait for proactive prebuffer`):
  ```rust
  if cached_prefix_stream {
      log::info!("[STREAM-PREFIX-END] msg {} ended at cache frontier offset {} ({}B of {} sent — cached_prefix mode)",
          message_id, read_offset, bytes_sent, content_length);
      break;
  }
  ```
  Gate 2 — Telegram fallback entry (grep `── TELEGRAM FALLBACK ──`, condition
  `if bytes_sent < content_length`): change to `if bytes_sent < content_length && !cached_prefix_stream`,
  and in a new `else if cached_prefix_stream && bytes_sent < content_length` arm emit the same
  `[STREAM-PREFIX-END]` log — this arm is the normal exit when the cached run from start_byte
  is < 5MB: `skip_poll` (grep `let skip_poll`) computes TRUE for small/absent prefixes
  (MIN_BOOTSTRAP_CACHED_BYTES=5MB) and the poll loop `while !skip_poll && ...` never runs, so
  Gate 1 never fires. Flow per request shape in cached_prefix mode:
  - big prefix at start_byte → CACHE-PREFIX serves it → skip_poll=false → poll loop serves
    disk until frontier → Gate 1 breaks → body ends.
  - small/no prefix at start_byte (e.g. ffmpeg's EOF SeekHead probe) → CACHE-PREFIX serves
    what exists (possibly 0B) → skip_poll=true → poll loop skipped → Gate 2 blocks fallback →
    body ends (empty/short). ffmpeg tolerates the failed tail probe and demuxes linearly —
    exactly the fixture's CUT shape (it denied EOF probes too; exit 0, 96/96 cues).
  R4 drive-by (same region): the poll-loop timeout warn says "10s timeout" (grep
  `10s timeout waiting for cache`) but FALLBACK_TIMEOUT_MS is 15000 — reword to use the
  constant.
- [ ] **Step 6 — extract call site** (grep `let input_source = subs_input_source` INSIDE
  `subtitles_extract_track` — the one near `let tmp_path`, NOT the probe/font ones):
  ```rust
  let mut input_source = subs_input_source(&folder_id_str, message_id, token, &cache);
  if !fully_cached && input_source.starts_with("http") {
      input_source.push_str("&cached_prefix=1"); // bounded prefix read (round-3 fix)
  }
  ```
  Do NOT touch `subs_input_source` itself (probe needs EOF tail reads; font shares it).
- [ ] **Step 7 — `-flush_packets 1`** in `build_sub_extract_args` (grep `fn build_sub_extract_args`):
  after the map/codec args, before `args.push(out_path.into())`:
  ```rust
  // Flush each muxed cue to disk immediately: the output survives even a
  // kill_on_drop mid-extraction (timeout), enabling future salvage (round-3).
  args.push("-flush_packets".into());
  args.push("1".into());
  ```
- [ ] **Step 8 — 204 partial signal** (grep `track has no cues (204)`): when `!fully_cached`,
  add `X-Subs-Partial: 1` header to the NoContent response (build via
  `HttpResponse::NoContent()` builder + `.insert_header(...)` + `.finish()`).
- [ ] **Step 9 — gates:** `cargo test --no-default-features` → 178+1 green.
  `cargo build --no-default-features` → success (Tauri codegen; cache may not update mtime —
  check output text, not timestamps).
- [ ] **Step 10 — commit:** `git add src-tauri/src/server.rs` (from app/) `&& git commit -m "Subs: cached_prefix bounded extraction — body ends at cache frontier (16min→seconds)"`

## Task 4: Fix B — ffmpeg end-shape fixture re-run (R1 verification bundle)

Transient script, NOT committed. Validates the NEW end-shape (prefix bytes → clean close;
ffmpeg reopen → short/empty body) that Task 3 produces.

- [ ] **Step 1:** create `/d/DEVELOPMENT/Telegram-Drive/.tmp-r3-fixture/` with: gen.srt (240 cues
  over 1200s, 5s cadence — python one-liner), fixture MKV
  (`ffmpeg -f lavfi -i testsrc2=size=320x180:rate=5:duration=1200 -i gen.srt -map 0:v -map 1 -c:v libx264 -preset ultrafast -crf 28 -c:s srt fix.mkv`),
  count sub packets fully below the 40% byte frontier via
  `ffprobe -select_streams s:0 -show_packets` (expected ≈96).
- [ ] **Step 2:** python frontier server (http.server): serves Range requests but CLOSES the
  connection at byte frontier F=40% (send fewer bytes than Content-Length, then close);
  requests STARTING ≥ F get an immediate empty-body close (the Task-3 body yields nothing and
  ends). This is the Task-3 contract exactly.
- [ ] **Step 3:** run the REAL extraction arg shape (mirror build_sub_extract_args incl.
  `-flush_packets 1`): `ffmpeg -hide_banner -loglevel error -nostdin -y -i http://127.0.0.1:PORT/fix.mkv -map 0:2 -flush_packets 1 -f srt out.srt`
  (stream idx per ffprobe). PASS = exit 0 AND cue count == prefix count AND stderr contains a
  premature-end/IO signature. Record the transcript into the task summary.
- [ ] **Step 4:** `rm -rf /d/DEVELOPMENT/Telegram-Drive/.tmp-r3-fixture` — verify gone.

## Task 5: Fix B-4 — frontend partial-track handling

**Files:** Modify `app/src/hooks/useMSEPlayer.ts` (fetchEmbeddedSubText),
`app/src/components/dashboard/FastStreamPlayer.tsx` (toggleEmbeddedSub).

- [ ] **Step 1 — verify SubtitleTrack.loadText semantics** (replace vs append): grep
  `class SubtitleTrack` (likely app/src/lib/subtitles/), read `loadText`. If it REPLACES cues →
  in-place refresh path below. If it APPENDS → fall back to remove/re-add (grep `removeTrack`
  on the subs manager; read `subs.` API surface in FastStreamPlayer). Record which in the commit.
- [ ] **Step 2 — `fetchEmbeddedSubText`** (grep `const fetchEmbeddedSubText`): return type gains
  `partial: boolean` on success (`resp.headers.get('X-Subs-Partial') === '1'`) and the 204
  branch returns `{ error: resp.headers.get('X-Subs-Partial') === '1' ? 'empty-partial' : 'empty' }`
  (extend the union type; tsc will chase the call sites — that's the point).
- [ ] **Step 3 — `toggleEmbeddedSub`** (grep `const toggleEmbeddedSub`): map value becomes
  `{ track: SubtitleTrack; partial: boolean }` (update the `.get(idx)` early-return uses).
  Behavior:
  - existing && wasActive → toggle OFF exactly as today (UX unchanged).
  - existing && !wasActive && !existing.partial → toggle ON as today.
  - existing && !wasActive && existing.partial → toggle ON with old cues IMMEDIATELY, then
    background re-fetch; on success `{text, partial}`: refresh cues (loadText-in-place or
    remove/re-add per Step 1) and update `existing.partial = partial` (self-improving until a
    full extraction flips it false, which the server then disk-caches).
  - 'empty-partial' error → `toast.info('No cues in the downloaded portion yet')`; do NOT
    memoize (unchanged — re-click re-fetches).
  NO other UI changes (no menu badges, no restyling — surgical rule).
- [ ] **Step 4 — gates:** `npx tsc --noEmit` → 0; `npx vitest run` → green.
- [ ] **Step 5 — commit:** `git add app/src/hooks/useMSEPlayer.ts app/src/components/dashboard/FastStreamPlayer.tsx && git commit -m "Subs: surface partial extractions and re-extract on re-select"`

## Task 6: Fix C-1/C-2 — cluster scan + injection helpers (TDD, pure)

**Files:** Modify `app/src/hooks/useThumbnailExtractor.ts` (co-located exports beside
`decideMkvCaptureStrategy` / `readMkvCuePointCount`). Create
`app/src/__tests__/MkvClusterBisect.test.ts`.

- [ ] **Step 1 — failing tests** (handcrafted Uint8Array fixtures — verify byte geometry by
  writing a tiny builder in the test file: vint-encode helper for sizes; cluster =
  `1F 43 B6 75` + vlen size + children `[BF CRC(skip)] [E7 <uint ticks>] [A3 SimpleBlock...]`):
  1. `scanForMkvClusterInWindow(buf, fileOffset, brackets)` finds the cluster, returns
     `{ elementStartPos: fileOffset + idx, timestampTicks }` with 0xE7 SECOND child (CRC first —
     child-walk required, R11).
  2. False positive: `1F 43 B6 75` followed by implausible vlen size and garbage children →
     rejected, scan continues to a later REAL cluster in the same window.
  3. Unknown-size cluster (size vlen `01 FF FF FF FF FF FF FF`) → accepted.
  4. Ticks outside bracket [loTicks,hiTicks]+slack → rejected.
  5. `injectMkvClusterPosition(fakeTrack, entry)`: sorted-splice into a pre-seeded
     `clusterPositionCache` (insert middle, keeps ascending startTimestamp); dedup by
     elementStartPos at the insertion neighbor → no double insert; missing
     `_backing.internalTrack` → returns false (shape-drift degrade).
  6. `findClusterCacheEntryNear(fakeTrack, targetTicks, windowTicks)` → returns the entry with
     `startTimestamp ∈ [target-window, target]`, null otherwise (R10 consult).
- [ ] **Step 2 — confirm FAIL** (imports don't exist).
- [ ] **Step 3 — implement in useThumbnailExtractor.ts** (exports, pure, no I/O):
  `scanForMkvClusterInWindow(buf: Uint8Array, windowFileOffset: number, loTicks: number, hiTicks: number): { elementStartPos: number; timestampTicks: number } | null` —
  indexOf-scan for `1F 43 B6 75`; parse EBML vlen size (reject len>8; accept unknown-size
  markers; reject defined sizes > 256MB); child-walk data start (parse child ID vlen 1-4B +
  size vlen; accept only IDs in {0xE7, 0xBF, 0x5854, 0xA7, 0xAB, 0xA3, 0xA0}; stop at 0xE7 or
  after 8 children/window end); read 0xE7 big-endian uint; bracket check ±(35s worth of ticks —
  pass slackTicks param); on any reject, continue scanning past the match. Also
  `readMkvTimestampFactor(videoTrack): number | null` and
  `readMkvClusterSeekStart(videoTrack): number | null`
  (`_backing.internalTrack.segment.{timestampFactor, clusterSeekStartPos ?? dataStartPos}` —
  guarded, readMkvCuePointCount style) and the two functions from Step 1 cases 5-6
  (binarySearchLessOrEqual by startTimestamp; splice(idx+1,0,entry); neighbor dedup —
  mirrors vendored matroska-demuxer insert semantics).
- [ ] **Step 4 — green:** targeted vitest + `npx tsc --noEmit`.
- [ ] **Step 5 — commit:** `git add app/src/hooks/useThumbnailExtractor.ts app/src/__tests__/MkvClusterBisect.test.ts && git commit -m "MKV cluster scan/injection helpers for cue-less bisection (pure, tested)"`

## Task 7: Fix C-3/C-4 — bisection driver + captureAtTime wiring + memoization

**Files:** Modify `app/src/hooks/useThumbnailExtractor.ts` (TransmuxerThumbnailPipeline class).

- [ ] **Step 1 — read** `captureAtTime` fully (grep `decideMkvCaptureStrategy(` call) + the
  native-capture path below it (find the `getKeyPacket` call the 'native' strategy uses) + the
  class fields around `isCuelessMkv`.
- [ ] **Step 2 — bisection driver** (private async method on the pipeline):
  `private async bisectClusterAtOrBefore(targetSeconds: number): Promise<{ elementStartPos: number; timestampTicks: number } | null>`:
  - factor = `readMkvTimestampFactor(this.videoTrack)`; null → return null (degrade).
  - lo = `readMkvClusterSeekStart(this.videoTrack) ?? 0`; hi = fileSize (this.sourceConfig /
    stored fileSize — read how the class stores it, grep `fileSize` in the pipeline).
  - targetTicks = round(targetSeconds * factor); slackTicks = round(35 * factor).
  - loop ≤ 18 iters while (hi - lo) > WINDOW (start 1MB): mid = (lo+hi)/2; fetch
    `[mid, mid+WINDOW)` via `fetch(this.streamUrl + '&source_id=thumbnail', { headers: { Range: 'bytes=...' } })`
    — NOTE the streamUrl already has ?token → append with `&`; explicit source_id per R11
    (plain fetch bypasses TauriStreamSource's builder); scan window (Task 6); no cluster found
    → double WINDOW (cap 8MB) and retry same bracket; found with ticks ≤ targetTicks →
    bestBelow = probe, lo = probe.elementStartPos + 1; ticks > targetTicks → hi = mid.
  - return bestBelow (may be null → caller skips).
- [ ] **Step 3 — memo + skip-branch wiring.** Class fields:
  `private bisectMemo = new Map<number, { state: 'inflight' | 'done' | 'failed'; at: number }>()`
  (key = bucket). In `captureAtTime`, replace the `strategy === 'skip'` early-return body with:
  1. R10 consult first: `findClusterCacheEntryNear(this.videoTrack, targetTicks, 35s-ticks)` →
     hit ⇒ treat as 'done' (organic or previously-injected entry already bounds the walk) and
     fall through to the native capture path (bounded now) — do NOT return false.
  2. memo 'done' ⇒ fall through to native capture likewise.
  3. memo 'inflight' ⇒ return false (cheap; processLoop keeps polling; busy NOT taken — near
     hovers stay serviceable).
  4. memo 'failed' within cooldown (60s) ⇒ return false; past cooldown ⇒ delete entry, continue to 5.
  5. else: memo 'inflight'; fire-and-forget
     `this.bisectClusterAtOrBefore(time).then(probe => { if probe && injectMkvClusterPosition(this.videoTrack, { elementStartPos: probe.elementStartPos, startTimestamp: probe.timestampTicks }) → memo 'done'; else memo 'failed' }).catch(() => memo 'failed')`;
     return false.
  On the native-capture path for a bisected bucket: wrap `getKeyPacket` so a null result backs
  off ONE probe step once (re-bisect targeting `targetSeconds - 35`, verify-c risk 3) and a
  throw splices the injected entry back out (find it by elementStartPos) + memo 'failed'
  (risk 4). Keep the once-per-file `warnedCuelessSkip` log but reword: bisection now active.
- [ ] **Step 4 — gates:** `npx tsc --noEmit` → 0; full `npx vitest run` → green (the round-2
  suite `decideMkvCaptureStrategy.test.ts` must be untouched and green — the decision function
  itself doesn't change, only what the pipeline DOES with 'skip').
- [ ] **Step 5 — commit:** `git add app/src/hooks/useThumbnailExtractor.ts && git commit -m "Cue-less MKV far-hover: cluster bisection + position-cache injection (bounded, memoized)"`

## Task 8: final gates + handoff

- [ ] `cd /d/DEVELOPMENT/Telegram-Drive/app && npx tsc --noEmit; echo TSC=$?` → 0
- [ ] `npx vitest run 2>&1 | tail -3` → all green (record count; baseline 415/31 + new files)
- [ ] `cd src-tauri && cargo test --no-default-features 2>&1 | grep 'test result'` → 179 ok
- [ ] `git log --oneline -8 | cat` — verify the commit chain (prep + 6 round-3 commits)
- [ ] Hand back for tauri-dev e2e (user): Inception MKV — (1) 4× audio switch mid-play: no
  stutter; (2) select embedded subtitle at ~2min cache: cues appear in seconds, toast only if
  zero cues in prefix; re-select later → more cues; close player mid-extract → cache deletable;
  (3) far hover ~30min: real frame after bounded bisection (~seconds cold, instant warm), near
  hover unaffected while bisecting; (4) sanity: cue-indexed MKV seek/hover, TS play, MP4 play.

## Cross-validation ledger

| # | Claim | Verified | Source |
|---|---|---|---|
| 1 | resetForSeek touches only wrapper state (queue/processing/abort/remove) | ✔ | SourceBufferWrapper.ts:282-328 |
| 2 | changeType waits queue-idle+!updating, no buffered-ranges precondition | ✔ | SourceBufferWrapper.ts:257-278 |
| 3 | seekTo reads no SB state; emission via bufferingForSeek-gated callbacks | ✔ | verify-a H-A1c (:7081/:7091), re-derived by reviewer |
| 4 | keyframeTimestamps sorted+deduped at all 4 write sites | ✔ | MediabunnyTransmuxer.ts:708/:784/:798-820/:1960 |
| 5 | Only MKV(avc) instantiates MediabunnyTransmuxer (TS→mpegts.js) | ✔ | useMSEPlayer.ts:7066-7067; :3262/:3368/:7406-7421 |
| 6 | stopTime bypasses maxDuration in video iteration (clamp needed) | ✔ | MediabunnyTransmuxer.ts iterateVideoPackets stopTime branch |
| 7 | cached_only 503 = whole-request, pre-body, fires on any partial range | ✔ | server.rs:753-764 + stream_cache.rs:1294-1306 (R1, double-derived) |
| 8 | ffmpeg exit 0 + prefix cues on mid-stream input death (4 shapes) | ✔ | verify-b experiments (fixture re-run in Task 4 re-proves vs NEW shape) |
| 9 | actix runs handler futures to completion post-disconnect | ✔ | verify-b actix 4.14 harness (await_child 60.6s after 2s disconnect) |
| 10 | clusterPositionCache {elementStartPos, startTimestamp-ticks}, sorted, sparse-ok; lookup binary-searches it for walk start | ✔ | vendored matroska-demuxer.ts:175-187/:709-723/:2233-2260 |
| 11 | readCluster asserts on bad injected byte (throws, no silent corruption) | ✔ | matroska-demuxer.ts:602/:608-609 |
| 12 | Thumbnail pipeline's videoSink is built on this.videoTrack (injection target = query target) | ✔ | useThumbnailExtractor.ts:849 |
| 13 | StreamQuery literals are exhaustive → every construction needs the new field | ✔ | Rust struct-literal rule; 5 sites grepped |
| 14 | tsconfig noUnusedLocals ON — no speculative declarations | ✔ | memory note; declare-on-first-read enforced per task |
