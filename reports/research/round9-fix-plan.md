# Round-9 fix plan

Inputs: `round9-log-forensics.md` (evidence) + `round9-research.md` (mechanisms, incl. new
root causes I-2b starved PROACTIVE and I-3b meta resurrection). Priority (user-approved):
**Fix 1 (I-2+I-2b) + Fix 2 (I-1) → Fix 3 (I-3+I-3b) → Fix 4-7 (I-4..I-7)**. One commit at r7.
All anchors are grep patterns (line drift immune). R8's deferred split-cache I2 stays deferred
(didn't bite in 9-*).

---

## Fix 1 — I-2 + I-2b: anchor PROACTIVE at the bisected byte AND unstarve it

### 1a. Report the real cluster byte at seek completion (frontend)

- `MediabunnyTransmuxer.ts` — capture the bisect result:
  - Add field `lastBisectAnchor: { byteOffset: number; time: number } | null = null`.
  - `seekTo` entry (anchor: `seekTo: reusing persistent MKV Input` decision block — set at
    the top of seekTo before any path): `this.lastBisectAnchor = null`.
  - `bisectSeekTarget` success (anchor: `injectMkvClusterPosition(videoTrack, result.entry)`):
    set `{ byteOffset: result.entry.elementStartPos, time: result.entry.startTimestamp / factor }`.
  - Expose `getLastBisectAnchor()` next to `getLastSeekAnchor()`.
  - Deliberately NOT reusing `getLastSeekAnchor`: its byte comes from captureNextReadStart
    (first UNCACHED read) — stale/mismatched on warm seeks. `lastBisectAnchor` is non-null
    ⇔ this seek actually bisected (cold, cue-less) ⇔ exactly the case worth re-reporting.
- `useMSEPlayer.ts`:
  - Hoist `SEEK_BYTE_BACKOFF` from the executeSeek block (anchor:
    `const SEEK_BYTE_BACKOFF = 2 * 1024 * 1024`) to module scope beside the other seek consts;
    add exported pure `computeSeekReportByte(rawByte: number, backoff = SEEK_BYTE_BACKOFF)` =
    `Math.max(0, Math.floor(rawByte) - backoff)`; use it in the existing initial-report site.
  - In the transmuxer-seek completion handler, immediately after the existing
    `recordByteTimeAnchor(seekAnchor.byteOffset, seekAnchor.time)` block (anchor): read
    `getLastBisectAnchor()`; if non-null, re-invoke `cmd_report_playback_position` with
    `byteOffset: computeSeekReportByte(anchor.byteOffset)`, same messageId/folderId/fileSize,
    `currentTimeS: clampedTime`, `isPlayerDownloading: true`, `.catch(() => {})`.
    Placement is AFTER the supersession guard → a condemned seek can never re-report.
    Backoff kept: `find_best_covering_download` needs `download.start ≤ read.start` and
    mediabunny parses EBML header bytes slightly before the cluster byte.

Backend consequences (no backend change needed for 1a; r4-verified against the loop):
- **Idle task / fresh spawn** (seek #1 shape): corrected report spawns/anchors at the TRUE
  byte (cold-start guard skipped, byteOffset present) — full win.
- **Running task, linear UNDERSHOT** (true > linear): forward jump fires (>10 MiB), outer
  loop advances `start_byte` (forward updates have no dead-band) → retargets exactly.
- **Running task, linear OVERSHOT** (this session, 15–22 MiB): chunk-loop backward check
  fires (>10 MiB vs prev target) → break + re-eval, BUT the outer loop's backward
  `start_byte` update has a 50 MiB dead-band (anchor `latest_current_byte + 50 * 1024 *
  1024 < start_byte`) → anchor stays at the linear byte; cost = one iterator recreate +
  a ≤22 MiB-wider /stream-owned band after a cold seek (refills fill it at their normal
  rate). Accepted — NOT worth shrinking the dead-band this round (it exists to prevent
  backward-churn; the correction is one-shot per seek). Documented in matrix #10a/#10b.
- `set_playhead_byte` (coordinator zombie-cancel) is corrected in ALL cases — the walk's
  own reads can no longer be judged against a byte 15–22 MiB away.
- Implementation note: `_fid/_folder/_fsz` from the initial-report block are block-scoped —
  re-derive `file?.id / activeFolderId / state.current.fileLength` at the completion site.

### 1b. Decay the `player_actively_downloading` flag (backend — unstarve)

Mechanism recap: MKV stores `true` on every seek report and NOTHING ever clears it (grep
confirms single store site) → PROACTIVE's secondary throttle yields forever (9-t: 0 bytes in
70 s, offset frozen). Same latent bug for any path that stops reporting after a `true`.

- `commands/mod.rs` (anchor `player_actively_downloading: Arc<AtomicBool>`): change to
  `Arc<AtomicU64>` — wall-clock millis of the last `true` store; `0` = idle.
- `lib.rs` init (anchor `player_actively_downloading: Arc::new`): `AtomicU64::new(0)`.
- `streaming.rs` store site (anchor `player_actively_downloading.store`):
  `true` → now-millis (`SystemTime::now().duration_since(UNIX_EPOCH)`), `false` → 0.
- `streaming.rs` load site in the chunk loop (anchor `player_actively_downloading.load`):
  yield only when `player_download_flag_fresh(now_ms, stored_ms)`.
- New pure fn + unit tests (beside `is_significant_target_change`):
  `pub fn player_download_flag_fresh(now_ms: u64, stored_ms: u64) -> bool` =
  `stored_ms != 0 && now_ms.saturating_sub(stored_ms) < PLAYER_DOWNLOAD_FRESH_WINDOW_MS`.
  `PLAYER_DOWNLOAD_FRESH_WINDOW_MS = 20_000` — r4 sizing: must exceed the TS reporter's
  10 s interval and the MP4 reporter's 2 s cadence (both refresh well inside the window ⇒
  MP4/TS semantics unchanged) AND cover the longest observed cold-walk gap between MKV
  reports (seek report → completion re-report spans the walk: 14.9 s observed max; 15 s
  would decay mid-walk on the tail case, waking PROACTIVE to contend for semaphore slots
  between the walk's chunk fetches). 20 s covers it with margin; after decay, the download
  semaphore `try_acquire` remains the fine-grained yield against active /stream reads.
  Wall clock chosen over Instant for a plain atomic; a clock jump at worst causes one
  mis-timed yield/resume window — harmless (documented).

---

## Fix 2 — I-1: deepen the bisect (stop-gap 16 MiB → 4 MiB)

Walk is network-byte-bound (~1.4 MB/s cold, disk-warm control 36 MiB/281 ms). Probes fetch
at the same rate AND cache through /stream (pre-warming the walk), so trading walk bytes for
probe bytes is strictly ≥ break-even; bracket halves per probe ⇒ 16→4 MiB costs ≤ 2 extra
probes (~2 MB windows) and cuts up to ~10 MiB of serial walk (seek #2 shape: −7 s).

- `MkvClusterBisect.ts` (anchor `BISECT_WALKABLE_GAP_BYTES = 16 * 1024 * 1024`):
  `4 * 1024 * 1024`, EXPORT the const, update the comment's numbers (a 4 MiB gap ≈ 23 s of
  content ≈ ~3 s cold walk at session rates).
- Stale-comment sweep: `≤16MB residual` in `MediabunnyTransmuxer.ts` (2 sites, grep `16MB`).
- Loop guards unchanged: 18 iters, 64 KiB bracket floor, window grow 2→8 MiB, round-5
  `hi = mid` spin fix untouched.

---

## Fix 3 — I-3 + I-3b: release the Windows lock on discard; kill meta resurrection

Holder identified: the starved-alive PROACTIVE task's `open_data_file_write` handle (no
FILE_SHARE_DELETE); `try_deferred_deletions` only ever fires from untrack_streaming /
unregister_download — never on proactive exit. Resurrection: proactive's periodic meta save
does `load_meta().unwrap_or_else(create)` — recreates a discarded meta.

- `streaming.rs cmd_delete_cache` (anchor `cmd_delete_cache called for msg`): FIRST insert
  `proactive-{id}` AND `bg-cache-{id}` into `cancelled_transfers` — THEN the existing
  has_active_download / is_streaming guards + delete. Do NOT `untrack_proactive` here: the
  spawn wrapper owns untrack on exit; untracking early would let a racing report spawn a
  SECOND task while the old one drains (double download window). New reports meanwhile
  early-return `Ok(false)` ("target updated") — correct. Cancel is observed ≤ ~500 ms in all
  task states incl. the starvation yield (r4-verified: the flag-yield `continue` re-enters
  the chunk-loop top, which re-runs the cancellation check before anything else). Stale
  cancel keys are cleared on next spawn (anchor
  `cancelled_transfers.write().await.remove(&proactive_key)`); `bg-cache-{id}` is a belt —
  `cmd_start_background_cache` has NO frontend call site (dead code, r4-verified) but is
  tracked via `track_task`, invisible to BOTH delete guards, and shares the meta-
  resurrection class; the key costs one line and `cmd_stop_background_cache` already clears
  it on restart.
- `stream_cache.rs`: expose the retry hook — `pub(crate) fn retry_deferred_deletions(&self,
  message_id: i32)` delegating to `try_deferred_deletions` (or make it pub(crate) directly).
- `streaming.rs` proactive spawn wrapper (anchor `cache_mgr.untrack_proactive(message_id).await;`
  inside `tokio::spawn`): after untrack, call `cache_mgr.retry_deferred_deletions(message_id)`
  — the file handle is dropped when `proactive_prebuffer_download` returns, so this retry is
  the one that actually deletes `109.dat` seconds after a discard (frontend 5×2 s ladder = belt).
- Resurrection guard — the periodic meta-save in `proactive_prebuffer_download` (anchor:
  `meta.cached_ranges.push((gap_start, offset - 1))` — r4 correction: proactive has ONE
  save site, in the chunk loop; its `offset % 1MiB || offset > gap_end` condition already
  covers the gap-end save. The OTHER grep hit for the same pattern is
  `background_cache_download`'s site — give it the SAME guard since delete now cancels
  `bg-cache-{id}` too): immediately before `lock_meta`, re-check
  `state.cancelled_transfers…contains(&transfer_id)`; if cancelled → return early
  (skip save). Combined with cancel-BEFORE-delete ordering, the resurrection window shrinks
  to a µs-scale in-flight save; residual is cleaned by the frontend retry ladder (documented
  accepted residual). (The bg-cache open item from r3 is RESOLVED above: cancel `bg-cache-{id}`
  in cmd_delete_cache + same pre-save guard — bg-cache tasks are tracked via `track_task`,
  invisible to both delete guards.)
- `remux\subs` os-5 at app exit: startup cleanup already handles it; explicitly NO code
  change this round (log-noise only, holder is process-exit teardown order).

---

## Fix 4 — I-4: drain SB queues before restarting the chain after an audio switch

Missing `waitForQueueDrain` lets the restarted chain read a STALE `sb.buffered` end →
refill seeks behind the switch keyframe → full re-transmux + byte-identical re-appends
(#28-30) — the seek path already drains; mirror it.

- `useMSEPlayer.ts _switchMkvAudioTrack` (anchor
  `// Refill chain tops the buffer up from here (same as post-seek).`): before
  `startStreamingChain()`:
  1. `await sbVideo.waitForQueueDrain();` (MKV = single combined SB; no audio SB).
  2. Post-drain supersession re-check: `if (isSeekSuperseded(seekGen, transmuxerSeekGenRef.current))`
     → skip `startStreamingChain()` + return false (the newer seek owns the chain) — the
     drain await opens a real supersession window that didn't exist before.
- changeType-revert and null-keyframe paths need NO drain (nothing appended there —
  documented, not changed). Quota-stall during drain inherits the seek path's existing
  semantics (drain resolves when eviction resumes the queue). The late `updateend` 4768/8574 ms
  lines are abort-completions logged by SBW — cosmetic, untouched.
- R8 `shouldRejectAudioSwitch` untouched.

## Fix 5 — I-5: subs partial-extraction frontier gate (backend memo)

Frontier frozen at 32 MiB (mediabunny seed) while far ranges grow ⇒ identical re-extractions.
Gate on contiguous-prefix growth; replay the previous partial result when unchanged. This is
NOT the forbidden "cache partial to disk forever": memo is frontier-keyed (same input ⇒ same
output) and in-memory only.

- `stream_cache.rs`: new pure `pub fn contiguous_prefix_end(ranges: &[(u64, u64)]) -> u64`
  (first range starts at 0 → `end + 1`, else 0) + unit tests.
- `StreamCacheManager`: field `subs_partial_memo: Arc<Mutex<HashMap<(i32, usize, bool),
  (u64, Vec<u8>, Option<String>)>>>` — (msg, stream_idx, ass) → (frontier, body, format hdr).
  Clear entries for a msg in `delete_cache` (anchor `init_prefix_cache.lock()` cleanup block).
- `server.rs` subs handler, partial path only (anchor `src.push_str("&cached_prefix=true")`
  — gate goes just before spawning ffmpeg; result-store goes where the partial response is
  built, anchors `X-Subs-Partial", "1"` [204 site] and the 200-partial site):
  - Before ffmpeg: `frontier = contiguous_prefix_end(&meta.cached_ranges)`; if memo has the
    key with the SAME frontier → replay stored body/headers + `X-Subs-Unchanged: 1`, skip
    ffmpeg entirely.
  - After a partial extraction (200 or 204): store (frontier, body, format).
  - `fully_cached` branch: memo never consulted; optionally purge the key.
- Frontend (`FastStreamPlayer.tsx`, anchor `No cues in the downloaded portion yet`): if the
  response carried `X-Subs-Unchanged: 1`, adjust toast to "cache front hasn't advanced —
  more of the file must download first" (also expose the header in the CORS list, anchor
  `X-Subs-Partial"])`).

## Fix 6 — I-6: hover polls await the in-flight bisect instead of spinning

115 false polls = ONE processLoop re-calling captureAtTime every ~250 ms while a bisect runs.
Keep captureAtTime non-blocking (near-hover serviceability is by design); make the caller
wait on the bisect, bounded so hover-moves stay responsive.

- `useThumbnailExtractor.ts TransmuxerThumbnailPipeline`:
  - `bisectMemo` inflight entries additionally store `promise: Promise<void>` — in the
    fire-and-forget site (anchor `void this._bisectAndInject(time, targetTicks, bucketKey)`):
    `const p = this._bisectAndInject(...); this.bisectMemo.set(bucketKey, { state: 'inflight',
    at: …, promise: p }); void p;` (`_bisectAndInject` already never rejects — it writes
    done/failed internally; the promise resolves after the memo transition).
  - New method `getInflightBisect(time: number): Promise<void> | null` — bucket the time,
    return the memo promise when state is 'inflight'.
- processLoop transmuxer branch (anchor `Hover: calling transmuxer captureAtTime`): on
  `!captured && active`, `const w = transmuxerPipeline.getInflightBisect?.(desiredTime);
  await (w ? Promise.race([w, sleep(1000)]) : sleep(200));` — 1 s race preserves hover-move
  and dispose responsiveness; on resolve the next iteration captures immediately.
- The two per-poll `console.log` lines in that branch (call + result) ARE the 115-line spam.
  r4 note: `useThumbnailExtractor.ts` has NO local `diagLog` (that helper is per-file:
  MediabunnyTransmuxer/MuxJsTsTransmuxer/useMSEPlayer). Change: log the call/result pair only
  when `captured === true` OR when this bucket wasn't the previously-logged bucket
  (`lastHoverLogBucketRef`) — first attempt + success stay visible for debugging, repeat
  polls of the same bucket go silent. No new diag machinery.

## Fix 7 — I-7 cosmetics

- `FastStreamPlayer.tsx` (anchor `MSE URL is null (mpegts.js mode)`): reword to
  `MSE URL not set yet — active tier (mpegts.js/transmuxer) attaches its own src`.
- `useThumbnailExtractor.ts` (anchor `MKV has no Cues — native-scan`): `console.warn` →
  `console.log` (expected state on cue-less files, not a fault; kills the React stack drag).
- `useMSEPlayer.ts` buffer-cap spam (anchor `exceeds cap ${aheadCap}s — sleeping`): log only
  on transition — `aboveCapLoggedRef` set on first exceed, cleared when back under (log
  "back under cap" once); reset the ref in `startStreamingChain`.
- `stopStreamingChain` 4-line stack log: KEPT deliberately (forensics workhorse every round).

---

## Tests (r5 — failing first)

Vitest (`app/src/__tests__/`):
- `MkvClusterBisect.test.ts` (extend): export + assert `BISECT_WALKABLE_GAP_BYTES === 4 MiB`;
  `bisectShouldStop(738217347, 753127152, 4 MiB) === false` (the 14.2 MiB round-9 gap now
  keeps probing — pinned to seek #2's real bytes); `bisectShouldStop(x, x + 4 MiB, 4 MiB) === true`;
  null cases unchanged at the new threshold.
- NEW `SeekReportByte.test.ts`: `computeSeekReportByte` — anchor − 2 MiB; clamp at 0 for
  bytes < backoff; identity floor on fractional input; custom backoff arg.
- `AudioSwitchGuard.test.ts`: unchanged (guard untouched) — re-run green.

Rust (`cargo test --no-default-features`, src-tauri):
- `player_download_flag_fresh`: 0 → false; now → true; now − 19 999 → true; now − 20 000 →
  false; stored > now (clock jump) → true via saturating_sub — documented.
- `contiguous_prefix_end`: `[] → 0`; `[(0, 33554431)] → 33554432` (the session's frozen
  frontier); `[(5, 10)] → 0`; `[(0, 9), (20, 30)] → 10`.

Not unit-testable without invasive seams (verified via e2e instead — honest listing):
switch-drain ordering (dupe appends #28-30 vanish), delete-cache cancel ordering (`109.dat`
gone ≤ ~2 s after discard), hover await (poll lines collapse to ≤2 per bucket), memo replay
(`X-Subs-Unchanged` on second retry), PROACTIVE unstarve (9-t-equivalent offsets advance).

## Edge-case matrix (ALL cases — per-fix, explicit handling)

| # | Fix | Case | Handling |
|---|-----|------|----------|
| 1 | 1a | Seek superseded during bisect/walk | completion handler's existing supersession guard exits BEFORE the re-report — condemned seeks never report |
| 2 | 1a | Warm seek (no bisect ran) | `lastBisectAnchor` null (cleared at seekTo entry) → no re-report; initial linear report stands; PROACTIVE gaps clamp into cached ranges so a ±14 MiB target error inside a warm region is harmless |
| 3 | 1a | Bisect failed/aborted (`result` null) | anchor stays null → no re-report → exact pre-fix behavior |
| 4 | 1a | Anchor < 2 MiB (near byte 0) | `computeSeekReportByte` clamps to 0 |
| 5 | 1a | Anchor near EOF | backend clamps `byte.min(file_size)`; empty ahead-gaps → no-op/task exit (existing) |
| 6 | 1a | `invoke` rejects | `.catch(() => {})` — playback unaffected, old target persists |
| 7 | 1a | Rapid seeks A→B | A suppressed by gen guard (case 1); B reports linear-then-corrected — backend handles as two jumps, idempotent |
| 8 | 1a | Audio-switch rebuild / refill seeks | neither runs the executeSeek completion handler → no re-report. If one DOES bisect (cue-less position outside harvested index — rare; refills/switches resolve from the harvested index by construction), it sets `lastBisectAnchor` unread; the clear-at-seekTo-entry invariant guarantees the next user seek's completion only ever reads its OWN seek's anchor |
| 9 | 1a | MP4/TS seeks | re-report lives in the transmuxer branch only; MP4/TS reporters untouched |
| 10a | 1a | Running task, corrected byte AHEAD of linear (undershot) | forward-jump branch (>10 MiB) → `start_byte` advances (no dead-band forward) → exact retarget |
| 10b | 1a | Running task, corrected byte BEHIND linear (this session's shape, 15–22 MiB) | backward-jump branch breaks the gap download; outer-loop backward update needs >50 MiB (dead-band) → anchor keeps the linear byte; residual = ≤ ~24 MiB /stream-owned band, self-healed by playback refills (which cache through /stream); zombie-cancel playhead still corrected. Accepted, no dead-band change this round |
| 11 | 1b | MP4 periodic reporter semantics | refresh every 2 s ≪ 20 s window; explicit `false` stores 0 → immediate — behavior identical |
| 12 | 1b | TS resume reporter (10 s interval) | 10 s < 20 s window → never falsely decays mid-playback |
| 13 | 1b | Pause | MP4/TS pause paths stop the task via `cmd_stop_proactive_prebuffer` anyway; a lingering `true` now decays in ≤20 s instead of starving forever (fixes the latent MP4-pause variant of I-2b) |
| 14 | 1b | MKV long cold walk (> window) after one report | 1a's completion re-report refreshes the flag; observed max walk 14.9 s < 20 s window; between reports the download semaphore try_acquire still yields to active /stream reads |
| 15 | 1b | Wall-clock jump | saturating_sub → worst case one mis-timed yield/resume window; documented, no panic |
| 16 | 2 | Tiny file (< 4 MiB) | `fileSize > startLo` entry guard + bracket floor 64 KiB unchanged; stop rule fires as soon as bracketed |
| 17 | 2 | Cue-ful MKV | bisect gated on `mkvCueIndex.length === 0` — never runs |
| 18 | 2 | Extra probes vs supersession | existing `shouldContinue` checked between probes — abort unchanged |
| 19 | 2 | Probe cost bound | bracket halves per probe: 16→4 MiB ≤ 2 extra probes, iter cap 18 unchanged; probe bytes cache to disk and pre-warm the walk |
| 20 | 2 | Zombie-cancel interference | probes keep dedicated `source_id=seek-bisect` — coordinator ignores them |
| 21 | 3 | Discard while task mid-chunk | cancel key observed at next loop-top (≤ ~1 chunk); handle drops at return; wrapper retry deletes |
| 22 | 3 | Discard while task starvation-yielding | yield `continue` re-enters loop-top cancel check ≤ 500 ms (verified loop structure) |
| 23 | 3 | Discard while /stream coordinator download active | existing `has_active_download` guard → Err → frontend ladder retries |
| 24 | 3 | Discard while Actix stream open | existing `is_streaming` guard → false → ladder retries |
| 25 | 3 | App exit with pending deletion | existing `clear_all` exit/startup belts unchanged |
| 26 | 3 | Meta save racing the delete | cancel-BEFORE-delete ordering + pre-save cancel check → window ~µs; residual resurrected meta deleted by the ladder ≤ 2 s later (accepted residual, documented) |
| 27 | 3 | Task exits normally (EOF/idle) with deletion pending | NEW wrapper retry hook fires on every exit path (spawn wrapper runs after return) |
| 28 | 3 | Delete for msg with no task | stale cancel key harmless — cleared on next spawn (existing anchor) |
| 29 | 3 | Double discard | `pending_deletions` contains-check dedups (existing) |
| 29b | 3 | Delete while the SAME file is playing (download-panel cancel of a continuation for a currently-playing msg) | is_streaming guard still refuses the delete; the cancel key kills PROACTIVE for the playing file — self-heals: next seek/periodic report re-spawns it (spawn clears stale cancel keys, existing anchor) |
| 29c | 1a | Failed seek (keyframe null → reroute) | completion handler's `keyframeTimestamp !== null` gate skips the re-report — linear report stands; reroute disposes the transmuxer anyway |
| 30 | 3 | `remux\subs` os-5 at exit | accepted: startup cleanup handles it; no code change |
| 31 | 4 | Switch superseded during drain | NEW post-drain gen re-check → skip chain restart; newer seek owns the chain |
| 32 | 4 | Switch while paused | drain awaits SB updateend only (not playback); no play() call — "paused means paused" preserved |
| 33 | 4 | Quota stall during drain | inherits seek-path drain semantics (resolves when eviction resumes queue); SBW fatal clears queue+processing → drain resolves, entry-check reroute handles fatal |
| 34 | 4 | changeType-revert / null-keyframe paths | nothing was appended there → no drain added (documented) |
| 35 | 5 | File completes between retries | `fully_cached` branch bypasses the memo → full extraction runs, disk-cacheable as today |
| 36 | 5 | Frontier grew but still 0 cues | ffmpeg runs, 204+partial stored at new frontier → next retry gated until further growth |
| 37 | 5 | Cache discarded between retries | meta None → frontier 0 ≠ memoed 32 MiB → re-runs (fast 204); memo also purged in `delete_cache` |
| 38 | 5 | Nothing cached from byte 0 | frontier 0; first call runs (memo miss) → stores at 0 → repeats skipped until a 0-based range appears |
| 39 | 5 | Multiple tracks / srt-vs-ass | memo keyed (msg, stream_idx, ass) |
| 40 | 5 | Concurrent identical requests | memo read/write under mutex; a double ffmpeg run is idempotent (same input) — no single-flight added |
| 41 | 6 | Hover moves away during await | `Promise.race([bisect, 1 s])` → loop re-reads desiredTime ≤ 1 s |
| 42 | 6 | Bisect fails | `_bisectAndInject` resolves after writing memo 'failed' → next capture returns false, 60 s cooldown (existing) — no spin (no inflight promise anymore) |
| 43 | 6 | Extractor effect teardown mid-await | race ≤ 1 s → `active` false → loop exits |
| 44 | 6 | TS/fMP4/MP4 pipelines | `getInflightBisect?.` optional-chained → undefined → existing 200 ms path |
| 45 | 6 | Near-bucket hover while another bucket bisects | captureAtTime stays non-blocking; near entries / done memos capture immediately (unchanged by design) |
| 46 | 7 | Cap-log ref staleness across seeks | `aboveCapLoggedRef` reset in `startStreamingChain` — first exceed after every (re)start logs once |

## Gates & verification (r7)

1. `npx tsc --noEmit` exit 0 (`noUnusedLocals` — declare refs in the task that first reads them).
2. `npx vitest run` — 477 existing + new all green.
3. `cd src-tauri && cargo test --no-default-features` green; `cargo build --no-default-features` clean.
4. serde reminder: any new query param stays `"true"/"false"` (none planned).
5. Commit (incl. round9-log-forensics.md, round9-research.md, this plan); hermes-verify
   script (mktemp inside bash, self-deleting); delete `9-c.md`/`9-t.md`.
6. Hand back for tauri dev e2e: cold far seek latency + repeat-seek warmness, audio-switch
   dupes gone (carried-over audio e2e), discard deletes `.dat` ≤ ~2 s, subs retry gated,
   hover spam gone, PROACTIVE offsets advancing in terminal log.
