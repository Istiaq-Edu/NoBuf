# Round-9 r2 Research — live-source re-derivation of I-1..I-7

Companion to `round9-log-forensics.md` (issue list + log evidence). This doc pins each
issue's mechanism to live source (branch `Embedded-subtitle-extraction` @ 5a35831) and
records fix directions + edge-case seeds for the r3 plan. All anchors re-read from disk
this session; grep patterns given so line drift doesn't matter.

---

## I-2 — PROACTIVE anchors at the linear estimate (front+back mechanism)

**Frontend report site** — `useMSEPlayer.ts` `executeSeek` MKV branch
(grep `SEEK_BYTE_BACKOFF`): `getByteOffsetForTime(clampedTime)` consults the **cue
index only** (`MediabunnyTransmuxer.ts:254`) — empty for a cue-less file → returns −1 →
falls back to `(clampedTime/duration)*fileSize`; minus `SEEK_BYTE_BACKOFF = 2 MiB`;
sent as `cmd_report_playback_position({ byteOffset, isPlayerDownloading: true })`.
This fires **before** `stopStreamingChain()`/`seekTo()` — the bisect result does not
exist yet, and **no later call ever corrects it** (verified: the only other report
sites are the MP4 periodic reporter (grep `startMp4ProactiveReporter`, format-gated by
its call sites), the MP4 executeSeek branch, and the TS resume interval).

**The true byte exists ~2.6 s later**: `bisectSeekTarget` (`MediabunnyTransmuxer.ts`
grep `seekTo bisect: cluster for`) injects `result.entry.elementStartPos` into the
demuxer cache. It is also exposed post-seek as `getLastSeekAnchor()` (grep) — already
consumed by the seek-completion handler for the green bar (grep
`recordByteTimeAnchor(seekAnchor`). **Seek #2 numbers:** injected 738,217,347; reported
753,127,152 (= linear−2MiB, Δ verified ±1 B); walk 738M→753M = 14.2 MiB serial cold.

**Backend consumption** — `streaming.rs cmd_report_playback_position`:
- stores `proactive_targets[msg] = (current_byte, …)` and `set_playhead_byte` (also
  feeds the coordinator's playhead-aware zombie-cancel — a *second* consumer of the
  wrong byte).
- If a task runs: early-return `Ok(false)` ("target updated; existing task will use it").
- Running task (grep `playhead jumped forward`): forward jump = `target > offset+10MB` →
  `jumped=true` → re-eval; `proactive_start_byte = start + 40s×(size/dur)` (grep
  `PROACTIVE should start 40s AHEAD`) = the observed +7,050,528 B; gaps clamped to it.

### NEW FINDING I-2b — PROACTIVE was starved ALL SESSION (flag never cleared)
`player_actively_downloading` is stored **only** by `cmd_report_playback_position`
(grep confirms: mod.rs decl, streaming.rs:744 store, :1272 load — no other writer).
The MKV seek report always passes `true`; MKV has **no periodic reporter** to ever set
it back to `false`. The proactive chunk loop yields on the flag (grep
`player_actively_downloading.load` → sleep 500 ms → `continue`) — so after the first
MKV seek the task **never downloads a byte**. 9-t proof: spawn 16:13:50 at offset
582,762,599; jump log 16:15:00 says `current offset 582762599` (0 bytes in 70 s); jump
16:16:21 says `current offset 654797544` = exactly gap-2's start (0 bytes again).
All "prebuffer" progress this session came from /stream refills + hover/bisect probes +
prior-session cache. Consequences:
- Re-anchoring alone (I-2 fix) changes nothing while the task is permanently yielding.
- The starved-but-alive task holds resources → **root-cause candidate for I-3** (below).

### Fix direction (I-2 + I-2b, coupled with I-1)
1. **Report the real byte at seek completion**: in the seek-completion handler, right
   where `getLastSeekAnchor()` is already read, re-invoke `cmd_report_playback_position`
   with `byteOffset = anchor.byteOffset − SEEK_BYTE_BACKOFF` (backoff still needed:
   `find_best_covering_download` requires `download.start ≤ read.start`, and mediabunny
   header reads land slightly before the cluster byte).
2. **Give MKV a downloading-lifecycle**: clear the flag when the seek's initial fill
   lands (or run a light MKV periodic reporter reporting
   `refill-active && buffer<cap && !complete`). Backend alternative (more robust, no
   frontend lifecycle): yield when `player_actively_downloading || has_active_download
   (coordinator-registered /stream reads)` and let the frontend flag decay (e.g.
   timestamped store, stale after N s). Choose in r3.
3. Warm-seek caveat: `getLastSeekAnchor` byte can be up to 32 MiB late for warm seeks
   (Input cache absorbs the read). Harmless: PROACTIVE clamps to *uncached gaps*, and a
   warm region is by definition cached. Note in edge matrix.

---

## I-1 — cold-seek walk cost (13.0–15.2 s click→frame)

Measured split (9-c): seek #1 bisect 7.3 s (3 probes, 6 MB) + `getKeyPacket` 14.9 s;
seek #2 bisect 2.6 s (2 probes, 4 MB) + walk 12.8 s (17.7 MB serial cold ≈ 1.4 MB/s —
same effective rate as the probes, so the walk is **network-byte-bound**, not
per-request-bound; warm control 36 MiB in 280.8 ms).

Stop rule: `BISECT_WALKABLE_GAP_BYTES = 16 MiB` (`MkvClusterBisect.ts:23`), applied in
`bisectShouldStop` (:188) and the search loop (:379). Seek #2 stopped at a 14.2 MiB
bracket → walk paid it all at Telegram rate.

**Fix directions (evaluate in r3):**
- (a) **Deeper bisect**: lower the stop gap (e.g. 4 MiB). Cost model at 176 KB/s
  content bitrate / 1.4 MB/s fetch: 14.2 MiB gap → ~2 extra probes (2 MB windows,
  interpolation splits proportionally) ≈ +4 MB fetched to cut ~10 MB of walk ⇒ net
  ≈ −4–5 s on a seek-#2-shaped seek. Bounded by the existing 18-iter/64 KiB guards;
  round-5 spin fix (`hi=mid`) unaffected. Probe windows already pre-warm the walk's
  first bytes (they cache through /stream).
- (b) I-2 fix makes **repeat** far seeks warm (PROACTIVE actually fills once unstalled).
- (c) Rejected: fetch-parallelization of the walk — the walk's serial reads already ride
  coordinator subscriptions (grep `MAX_SUBSCRIBE_DISTANCE`); rate is Telegram-bound.

---

## I-3 — Windows cache-delete lock leak (discard → 109.dat os-32 forever)

Source chain (`stream_cache.rs`): `delete_cache` (grep `queued for deferred deletion`)
deletes meta first, then `.dat`; os-32 → `pending_deletions`. Retries fire **only** from
`untrack_streaming` and `unregister_download` (grep `try_deferred_deletions`) —
**`untrack_proactive` does NOT retry**, and nothing retries on a timer.

**Holder identification (new):** `proactive_prebuffer_download` opens `cache_file` via
`open_data_file_write` (no `FILE_SHARE_DELETE`) and holds it across the entire gap loop
— including the I-2b starvation yield loop, which in this session **never exits** (9-t
has zero `[PROACTIVE] … cancelled/stopped/exiting` lines after the discard at 16:16:36).
A starved-alive PROACTIVE task is exactly a backend-side holder that survives frontend
stream disposal (observed 34 s gap) until process exit. The dialog's `cmd_delete_cache`
guard checks `has_active_download` (coordinator) — **PROACTIVE is tracked separately**
(`track_proactive`) and passes the guard.

### NEW FINDING I-3b — meta-resurrection race (all platforms)
`delete_cache` removes `.meta.json` while PROACTIVE keeps running; PROACTIVE's periodic
meta update (grep `meta.cached_ranges.push((gap_start, offset - 1))` in the chunk loop)
does `load_meta → None → creates a fresh CacheMeta` and saves it → a *discarded* cache
reappears with bogus ranges. Today it's masked by I-2b (task never writes); the moment
I-2b is fixed, discard-during-prebuffer would resurrect metas. Must fix together.

**Fix direction:** on `cmd_delete_cache`: cancel proactive first
(`cmd_stop_proactive_prebuffer` semantics: insert cancel key + `untrack_proactive`),
wait bounded for task exit (it polls cancellation every ≤500 ms even when starved),
then delete; add `try_deferred_deletions` to the proactive spawn-exit path (or to
`untrack_proactive`); PROACTIVE re-checks "am I cancelled" before each meta save (or
skips save when meta absent → prevents resurrection). Frontend dialog paths already
retry 5× (grep `cache-dialog-discard`), which then succeed.

---

## I-4 — audio-switch double transmux + stale-append stragglers

`_switchMkvAudioTrack` (grep `mkv switch: plan=`) tail: append loop → **immediately**
`startStreamingChain()` → success log. **Missing: `waitForQueueDrain()` between appends
and chain restart.** The user-seek path drains (grep `await sbVideo.waitForQueueDrain()`
in the seek-completion handler) before its chain restart; the switch does not.

Trace consequence (9-c :212-231): switch appends #21-27 enqueue async; the restarted
chain's first refill enters while `sb.buffered` still ends at the *pre-switch* playhead
(3326.710) → `refillPosition=3326.710` → cue-snap resolves kf **3324.488** (behind!) →
"Abutting refill … overlap=2.222s" → re-transmuxes the exact window the switch just
produced → byte-identical re-appends #28-30 (213832/312767/96397 B; SB range does not
grow — pure coded-frame replacement). Same mechanism double-appends the tiny audio-tail
stragglers (1429/775 B). The 4768 ms/8574 ms `updateend`s into an emptied SB (#9, #20)
are in-flight appends surviving `resetForSeek`'s abort (SBW aborts the *current* op and
clears the queue, but an op that already entered `updating` completes late).

**Fix direction:** drain video+audio queues before `startStreamingChain()` in the
switch (mirrors seek path); optionally guard refill entry against
`refillPosition < seekOffsetRef.current` (belt). Keep `shouldRejectAudioSwitch` (R8)
untouched.

---

## I-5 — subs re-extraction frozen at a 32 MiB frontier

Server (grep `cached_prefix=true` / `STREAM-PREFIX-END`): partial file → extraction
input is /stream in `cached_prefix` mode → body ends at the **contiguous-from-0
frontier**, not "total cached bytes". This session: bytes 0–32 MiB cached by init
(mediabunny's 32 MB Input seed), playhead cached 561 M+ far ranges → prefix stays
32 MiB forever → every re-extraction reads identical input → identical `647 chars
(srt, partial)`. Frontend (grep `empty-partial` in FastStreamPlayer) just toasts
"try again as more downloads" — no growth gate.

**Fix direction:** cheap frontier gate — before re-running ffmpeg, compare the current
contiguous prefix end (`cmd_get_cache_status` → `cached_ranges[0]` end when range
starts at 0) against the frontier at last extraction (per msg+stream memo); if
unchanged, short-circuit with the cached partial result / clearer toast ("cache front
hasn't advanced"). Optional: auto re-extract once `is_complete`. Do NOT attempt
non-contiguous-range extraction (MKV sub demux needs sequential clusters from 0).

---

## I-6 — hover captureAtTime poll spam (115 false vs 6 true)

`TransmuxerThumbnailPipeline.captureAtTime` (grep `bisectMemo`): bucket memo state
`inflight` → **instant `return false` without taking `busy`** ("near hovers stay
serviceable"). The caller's retry loop (`useThumbnailExtractor` grep
`transmuxer captureAtTime for time`) treats `false` as "try again shortly" → 20–48
polls per bucket while one bisect runs. Memo dedups *work* (held ✓) but not *polls*.

**Fix direction:** store the in-flight **promise** in the memo; a poll hitting
`inflight` awaits that promise (bounded) and then returns the memoized outcome — 1
await instead of N polls. Alternatively return a distinct `'pending'` sentinel and make
the caller suspend polling for that bucket until settle. Keep busy-flag semantics for
*different* buckets untouched (serviceability of near hovers is by design, r2-fix-B).

---

## I-7 — cosmetics

- `FastStreamPlayer.tsx` (grep `MSE URL is null (mpegts.js mode)`): fires for the MKV
  transmuxer too (blob URL not yet set at that render) — reword to format-aware text.
- No-Cues warn pinned: `useThumbnailExtractor.ts` grep `MKV has no Cues — native-scan`
  (:869) — `console.warn` inside a React effect chain drags the dev stack. Downgrade to
  `console.log`/diag (it's an expected state for cue-less files, not a fault).
- 67× `Buffer ahead … exceeds cap` (useMSEPlayer grep `exceeds cap`): log only on
  transition into/out of capped state, not every 2 s cycle.
- `stopStreamingChain` prints a 4-line stack on every call (grep
  `Streaming chain stopped', new Error`) — intentional diagnostics; keep (or gate
  behind diag flag) — decide in r3.

---

## Edge-case seeds for the r3 matrix (user mandate: ALL edge cases enumerated)

Per-fix, at minimum:
- **I-2 report-after-bisect:** seek superseded during bisect (gen guard — do NOT report
  a condemned seek's byte); warm seek (anchor up to 32 MiB late — acceptable, gaps
  clamp); anchor null (no bisect ran / shape drift) → keep original estimate, no second
  report; report failure (`invoke` rejects) → playback unaffected; byte 0 / near-EOF
  clamps; audio-switch rebuild seeks (same handler?) must not spam reports.
- **I-2b lifecycle:** pause during walk; seek chains (A→B before A's walk ends); flag
  decay vs explicit clear ordering vs `cmd_stop_proactive_prebuffer` on dispose;
  MP4/TS paths unchanged (their reporters already manage the flag).
- **I-1 stop-gap:** tiny files (gap floor > file size); bracket floor 64 KiB & 18-iter
  cap still bound probes; cue-ful MKV unaffected (bisect gated on empty cue index);
  supersession mid-probe (existing `shouldContinue`).
- **I-3:** discard while PROACTIVE mid-chunk-write (cancel poll ≤500 ms, bounded wait,
  frontend retry ladder as final belt); discard while /stream still registered
  (existing has_active_download guard); app-exit while pending (existing clear_all
  fallback); meta-resurrection (I-3b) on ALL platforms; deferred-retry trigger coverage
  for proactive-exit path.
- **I-4:** switch superseded mid-drain; changeType-revert path (drain before revert
  restart too); paused switch (`paused=true` — drain must not await playback); fatal SB
  during drain (reroute wins).
- **I-5:** file completes between extractions (gate must not block the
  now-full-extraction); frontier grows but still 0 cues (X-Subs-Partial 204 path);
  multiple sub tracks with independent memos; cache discarded between retries (memo
  reset).
- **I-6:** hover leaves bucket while awaiting (abort/ignore result); bisect promise
  rejects (memo → failed, poller returns false once); rapid re-hover same bucket after
  'failed' (existing failed-state cooldown semantics); TS/fMP4 pipelines untouched.

## Gate/verification notes for r5-r7
- Existing suites: `MkvClusterBisect.test.ts`, `AudioSwitchGuard.test.ts` — extend, don't
  fork. New pure-function targets: stop-gap parameterization, report-byte selection
  (anchor vs estimate incl. backoff/clamps), frontier-gate predicate, memo-promise
  transitions. Rust: meta-resurrection guard unit (delete → save skip), proactive
  cancel-exit retry hook.
- serde reminder: `Option<bool>` query params accept only `"true"/"false"`.
- tsc gate: NoBuf tsconfig has `noUnusedLocals` — declare refs in the task that first
  reads them.
