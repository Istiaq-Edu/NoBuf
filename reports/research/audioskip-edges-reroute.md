# EDGE-CASE ANGLE C — Layer-3 post-init fatal reroute: AVC-MKV → /remux → mpegts.js

Status: IN PROGRESS (incremental; edges appended as verified)
Date: 2026-08-01. Branch `dev` @ `fb18253`.
Scope: the Layer-3 safety net from `reports/mkv-audioskip-solution.md` §Layer 3 — on a
post-init SourceBuffer/decoder fatal for an AVC-MKV on the MediabunnyTransmuxer tier,
reroute to `/remux?audio_idx=N` (ffmpeg video-copy + AAC re-encode) → mpegts.js,
resuming at the playhead — instead of today's dead `useNative` on raw MKV.

Ground truth files:
- `app/src/hooks/useMSEPlayer.ts` (9715 ln)
- `app/src-tauri/src/server.rs` (7602 ln)
- `app/src/components/dashboard/FastStreamPlayer.tsx` (2753 ln)
- `app/src/lib/faststream/players/MediabunnyTransmuxer.ts`
- `app/src/lib/faststream/players/SourceBufferWrapper.ts`

Edge inventory sections:
1. Detection edges (what fires, what must not fire)
2. Decision/guard edges (planRemuxRecovery + loop/one-shot guards)
3. Teardown edges (transmuxer/MSE/chain state unique to the MKV tier)
4. Video-element & resume-time edges
5. /remux URL construction edges (audio_idx id-space, hevc_ok, token)
6. Server-side /remux edges (ffprobe, cache, ss-seeks, process lifecycle)
7. mpegts.js re-init edges (cold start vs seek-resume)
8. Post-reroute UX/feature continuity edges (seeks, tracks menu, subs, thumbs, persistence)
9. Race/re-entrancy edges
10. Verdict matrix

## Verification log
(appended as verified — each edge: scenario, behavior on the reroute path, verdict, evidence file:line)

---

## §1 Detection edges — what can fire "post-init fatal" on the AVC-MKV transmuxer tier

The reroute must be triggered from every place today's dead `useNative` is reached
post-init, and from NO place that is transient/recoverable.

**D1. video `error` event, code 3 (MEDIA_ERR_DECODE) — the audio-skip fatal itself.**
`setVideoRef` listener `useMSEPlayer.ts:9497-9520`. Filter conditions already present:
- `transmuxerInitInProgressRef.current` → ignore (:9501-9504) — blob URL fires code 4
  during init, expected. EDGE: the reroute itself sets
  `transmuxerInitInProgressRef.current = true` (cold path :4495 / MKV route :3205) —
  any error the DYING transmuxer pipeline fires after the reroute began is thereby
  swallowed. Good for re-entrancy, but means the flag MUST be cleared on
  reroute-failure paths or future real fatals are ignored forever
  (cold-start failure path clears overlay but NOT the flag — see §9 R4).
- `mpegtsPlayerRef.current` non-null → defer to mpegts FATAL handler (:9510-9513).
  EDGE: on the MKV transmuxer tier this ref is null (no mpegts player yet), so the
  branch correctly falls to the fatal case; but AFTER a successful reroute the ref
  becomes non-null, so a SECOND code-3 on the remux tier routes to mpegts.js's own
  FATAL handler (:3652) — which calls `_recoverToRemuxTier` → planRemuxRecovery →
  `isAlreadyRemuxUrl(failedUrl)`. CRITICAL EDGE: that handler passes `streamUrl`
  (the /stream URL captured at mpegts-init time), NOT the /remux URL — see §2 G3.
- `cancelledRef.current || useNative` → skip. EDGE: `useNative` is React STATE
  captured by the `useCallback([], ...)` closure at :9485-9523 — the deps array is
  EMPTY (:9523), so the listener sees the INITIAL value (false) forever. Once
  useNative flips true, a later error event still enters the else-branch and calls
  `setUseNative(true)` again (no-op re-render, harmless today). If the reroute
  replaces the setUseNative call, the same staleness applies to ANY state read here —
  gate re-entry on refs, not state.

**D2. video `error` code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) post-init.**
Same listener (:9499-9500 catches both codes). The audio-skip repro fires code 4 via
`CHUNK_DEMUXER_ERROR_APPEND_FAILED: Initialization segment misses expected aac track`
(solution doc :5-7). So BOTH codes must reroute for MKV. EDGE: code 4 also fires when
FastStreamPlayer stomps `video.src` to a dead blob URL during teardown races
(:3207-3211 comment) — reroute must therefore clear `mseUrl` BEFORE resetting the
video element (cold path does: :4497), or the reroute's own video reset triggers a
second code-4 from the stale blob src re-applied by a re-render (FastStreamPlayer
effect :869-879 re-sets `v.src = playerMseUrl` whenever mseUrl is non-null).

**D3. SourceBufferWrapper fatal flag — silent, no event.**
`SourceBufferWrapper.ts` sets `fatalError` on `InvalidStateError` with
"error attribute is not null" (:167-173) or "removed from the parent media source"
(:177-184); exposed passively as `hasFatalError` (:79). The refill chain checks it at
`useMSEPlayer.ts:2588` (entry) and :2833 (chain-continue) and SILENTLY returns.
EDGE: there exist fatal sequences where the SB dies but the video element never
surfaces MEDIA_ERR_DECODE (e.g. appendBuffer throws InvalidStateError while
`video.error` is set only later, or remove() during eviction races the error) —
today those stall forever with no event at all. A complete Layer 3 needs the refill
chain's `hasFatalError` check to ALSO trigger the reroute (with resumeTime from
`video.currentTime`), not just the video-error listener. Otherwise the reroute only
covers the decoder-surfaced subset.

**D4. Transmuxer `onError` callback (post-init exceptions inside seekTo).**
MKV construction site `useMSEPlayer.ts:6770-6775`: `onError` → `setError` +
`setUseNative(true)` — fires for real (non-superseded) seekTo failures
(MediabunnyTransmuxer seekTo catch :1506-1531 filters expected/aborted). This is a
post-init fatal for the tier and currently ALSO lands on dead useNative. EDGE: it
fires while the video element is still healthy (`video.error` null) — a reroute from
here must not assume the element needs reset, but resetting is idempotent/safe
(:4457-4467 comment). Both `onError` and `onCodecUnsupported` (:6764-6769) must be
included in the reroute or an audio-decode exception path stays a dead end.

**D5. What must NOT trigger the reroute (false-positive edges):**
- code-4 during transmuxer init — already filtered (:9501); init failures have their
  OWN fall-through to /remux (`_initMkvTransmuxerPlayer` returns false →
  :3172-3177 falls into the :3182 remux branch). Reroute here would double-init.
- QuotaExceededError — recoverable, separate flag (`quotaExceeded`,
  SourceBufferWrapper.ts:19, :191-196); never sets fatalError.
- A lone `error` EVENT on the SB without a failed op (SourceBufferWrapper.ts:130-141)
  — explicitly not fatal; next failed op confirms.
- Transient code-4 from the empty blob while `bufferingForSeekRef` flushes — covered
  only by the init flag today; a seek-time decode error with
  `transmuxerInitInProgressRef=false` WILL reroute. That is correct-by-intent (a
  mid-seek decode fatal is real), but note the user-seek path (:8753+) does not set
  the init flag, so there is no suppression window during seeks.

## §2 Decision/guard edges — planRemuxRecovery reuse

**G1. `planRemuxRecovery` (pure, :239-254) inputs on the MKV tier:**
- `failedUrl`: MUST be the /stream URL (or anything non-/remux) for the loop guard
  `isAlreadyRemuxUrl` (:193-200) to pass. On the MKV transmuxer tier the natural
  argument is `streamUrlRef.current` — fine. EDGE: `isAlreadyRemuxUrl` checks
  `pathname.startsWith('/remux/')` — our constructed remux URLs are
  `${baseUrl}/remux/...` (:4470) so the guard holds; but if a future base path ever
  nests (`/api/remux/...`) the guard silently stops matching (string fallback :198
  uses `includes('/remux/')` only when URL parsing THROWS, not when parse succeeds
  with a nested path). Keep base URL origin-rooted.
- `alreadyAttempted`: `remuxRecoveryAttemptedRef` is currently reset ONLY in
  `cleanup()` (:2384) which runs per file load — one-shot per file. EDGE: the MKV
  audio-track-switch rebuild (`_switchMkvAudioTrack` :5957) does NOT reset it —
  correct (same file). But the MP4 track switch tears down and re-inits via
  `mp4ReinitNonce` WITHOUT running the per-file reset (:2032-2034 keeps refs on
  nonce re-init) — if the reroute ever fires on a file that later re-inits same-URL,
  the one-shot stays consumed. Acceptable, but document: one-shot is per
  file-URL-change, not per pipeline instance.
- `currentTime`: caller must pass `resumeTime` captured BEFORE video reset (:4427-4428
  doc). EDGE: in D3 (silent SB fatal) and D4 (transmuxer onError) the video element
  still has a live currentTime — capture at detection point. In D1/D2 the element
  has `video.error` set but currentTime is STILL readable (error does not zero it);
  only `src=''` zeroes it (:3641-3643 comment proves the ordering matters).
- `duration`: `mpegtsDurationRef.current || state.current.duration || 0` (:4439).
  EDGE: on the MKV transmuxer tier `mpegtsDurationRef` is 0 (never an mpegts player);
  `state.current.duration` is set by `onDurationKnown` (:6744) — available post-init.
  A fatal BEFORE onDurationKnown (first prime window) → duration=0 → plan returns
  'init' (cold start from 0) even if currentTime≥8 — impossible in practice since
  currentTime≥8 requires playback, which requires duration known. Consistent.
- `fileLength`: `state.current.fileLength` — set from file metadata at stream init;
  nonzero for MKVs. The `action:'seek'` branch (:247-251) requires ALL of
  currentTime≥8 && duration>0 && fileLength>0.

**G2. The `<8s` policy edge.** plan 'init' (cold start at 0) for any fatal in the
first 8 seconds — for the audio-skip repro (fatal at t≈0 on FIRST append, before
playback even starts) this is the NORMAL path: cold /remux start, playhead loss
irrelevant (was ~0). Correct behavior, but note the fatal fires when currentTime is
still 0 because playback never started — `resumeTime ?? 0` → 'init'. ✔

**G3. Loop-guard blind spot (pre-existing, inherited by Layer 3).** The mpegts FATAL
handler calls `_recoverToRemuxTier(streamUrl, …)` (:3652) where `streamUrl` is the
closure-captured /stream URL — NOT the /remux URL the failing player was actually
playing. So `isAlreadyRemuxUrl(failedUrl)` is FALSE even when the fatal occurred ON
the remux tier; the loop is prevented ONLY by the `alreadyAttempted` one-shot. For
the MKV Layer-3 case the same shape applies: after reroute, a second fatal enters
:3652 with the /stream URL → guard passes → but `remuxRecoveryAttemptedRef` (set true
by the Layer-3 reroute if it goes through `_recoverToRemuxTier`) → 'skip' → native
last resort. CONCLUSION: Layer 3 MUST set `remuxRecoveryAttemptedRef.current = true`
(i.e. reuse `_recoverToRemuxTier`, not a parallel copy) or a remux-tier fatal after
an MKV reroute loops: reroute → fatal → reroute → …

**G4. `parseStreamUrl` failure edge.** `_recoverToRemuxTier` re-parses
`streamUrlRef.current ?? failedUrl` (:4448-4453); unparseable → false → caller falls
to native. For MKV the caller after a failed reroute should still setUseNative(true)
(today's behavior) — dead, but nothing better exists. Note `parseStreamUrl` handles
the `folderId=null` "home" case via the URL shape — same parser the init path used,
so a URL that initialized a player always re-parses. ✔

---
## §3-§10 (absorbed after subagent final-message loss — verified directly from source)

## §3 Teardown edges — what the MKV tier must stop that the mpegts tier doesn't have

`_recoverToRemuxTier` was written for the mpegts tier: it resets the video element +
`setMseUrl(null)` but does NOT touch transmuxer machinery. On the MKV tier the caller
must FIRST do the local teardown or the dying pipeline keeps writing:
- `stopStreamingChain()` (:2558; the switch path does exactly this before rebuild :5991)
- `transmuxerRef.current?.dispose()` + null the ref (cleanup idiom :2288/:2359 —
  dispose aborts in-flight seekTo via InputDisposedError; the expected-error filter
  :1506-1531 swallows it)
- bump `mkvWarmerGenRef` + `mkvWarmerActiveRef=false` (cleanup idiom :2326-2327,
  :2432-2433 — otherwise the warmer keeps prefetching /stream bytes for a dead tier)
- clear `refillInProgressRef`, `burstBufferRef`, `seekBufferRef`,
  `bufferingForSeekRef` (switch-path idiom :5992-5995)
- revoke the MSE blob URL (:2331/:7045 idiom) AFTER `setMseUrl(null)` propagates —
  FastStreamPlayer re-sets `v.src = playerMseUrl` whenever mseUrl non-null (§1 D2).
Order matters: teardown → video reset → `_recoverToRemuxTier` (which re-resets the
element harmlessly — reset is idempotent per :4457-4459).

## §4 Video element & resume-time edges
- Capture `video.currentTime` BEFORE any reset — the mpegts FATAL handler does this
  (:3643 `resumeT` before `src=''`); D3/D4 detection points must copy it.
- `video.error` non-null does NOT zero currentTime (only `src=''` does) — capture is
  safe even post-fatal (§2 G1 evidence).
- Paused-means-paused: `_recoverToRemuxTier` already re-pauses after recovery init
  when `isPausedRef` (:4516-4518). Seek-resume path preserves pause via
  `_mpegtsRecreatePlayerForRemuxSeek` (gen counter + pause preservation built in,
  :4480-4485 comment). No new work.

## §5 audio_idx id-space edge — CONFIRMED cross-namespace, degradation benign
- Track ids are tier-native (:259-260): MKV audio menu ids = mediabunny `track.id`
  (Matroska TrackNumber, typically 1-based incl. video); /remux expects ffprobe
  stream index (0-based across all streams).
- `remuxAudioIdxRef` is seeded from per-file persistence (:2044-2051) in the tier the
  file last played on. An MKV-namespace id sent as `audio_idx` hits server
  `validate_audio_idx_override` (server.rs:2534, applied :3043) → invalid ids fall
  back to the default track. NEVER breaks playback; MAY lose the user's specific
  track choice across the reroute (e.g. Matroska id 3 = 2nd audio, but ffprobe idx 3
  may not exist → default).
- v1 verdict: acceptable (documented, graceful). Enhancement (plan-optional): map by
  POSITION among audio tracks — MKV enumeration order → /audio_tracks (ffprobe
  namespace, memoized) order — before building the reroute URL.
- B4 interplay (switch INTO audio on video-only SB → reroute w/ audio_idx): same
  mapping need; v1 sends position-mapped idx when the /audio_tracks list is already
  loaded; fetch the list if absent (menu source on video-only MKV is
  transmuxer-enumerated).

## §6 Server-side /remux edges (all pre-existing, none blocking)
- Cache keyed by audio_idx (`remux_cache_filename` :2524-2531); cached file reused
  only on the DEFAULT path (`requested_audio_idx.is_none() && remux_path.exists()`
  :2924) — an audio_idx reroute always re-probes+re-encodes. Cost noted, correct.
- Cue-less MKV irrelevant server-side: ffmpeg builds its own index from the
  container; `-ss` seeks on MKV input are keyframe-snapped by ffmpeg (existing
  behavior for HEVC-MKV files routed here at init).
- AVC-MKV + AAC/AC3/DTS input → video copy + AAC re-encode → TS: the exact pipeline
  HEVC-MKV files already exercise e2e (fallbacks doc §2). No new server work.

## §7 mpegts.js re-init edges
- Cold path: `_initMpegtsPlayer(remuxUrl, undefined as unknown as MediaSource, '',
  parsed)` (:4506) — the undefined-MediaSource shape is the established cold-start
  idiom; player builds its own MSE. Init failure → `return false` → caller falls to
  native (dead, but no worse than today; §2 G4).
- Seek-resume path: `needsRemuxSeekRef`/`remuxSeekBaseUrlRef`/`remuxSourceIsTsRef`
  set BEFORE `_mpegtsRecreatePlayerForRemuxSeek(clampSeekTime(...))` (:4474-4484) —
  remux output length unknown → byte-forward seek machinery stays inert until
  MEDIA_INFO (established timed_id3 behavior).
- `transmuxerInitInProgressRef=true` during cold reroute (:4495) extends the MSE init
  timeout AND swallows dying-pipeline error events (§1 D1). MUST be cleared on BOTH
  outcomes — verify _initMpegtsPlayer's MEDIA_INFO handler clears it (plan
  verification item; §1 D1 flags the failure path as suspect).

## §8 Post-reroute UX/feature continuity
- Audio menu: repopulated in the /remux tier's namespace via /audio_tracks fetch
  (:5873-5919, stale-response-guarded). Selection persists per-file (:2044) — same
  key, new namespace (see §5 caveat).
- Embedded subs: inventory + fonts are per-FILE, container-level, reset only on
  streamUrl change (:2054-2060) — SURVIVE the reroute untouched. Extraction endpoints
  are tier-independent (/subtitles/...). In-flight extraction during teardown: the
  subs feature's generation guard prevents stale attach.
- Thumbnails: MKV thumbnail pipeline owns a SEPARATE mediabunny Input/transmuxer —
  disposing the MAIN transmuxer doesn't kill it; /stream stays valid for the raw MKV.
  Continues working post-reroute (same file bytes).
- Progress bar: remux tier renders via mpegts machinery (duration from MEDIA_INFO /
  duration override) — established timed_id3 behavior, nothing MKV-specific.

## §9 Race / re-entrancy edges
- R1 double-fatal (code-3 then code-4 from the same corpse): first fatal starts
  reroute → sets `transmuxerInitInProgressRef=true` (cold) → second event swallowed
  (§1 D1). Seek-resume reroute does NOT set that flag — second event enters listener,
  `mpegtsPlayerRef` now non-null → routes to mpegts FATAL handler → `alreadyAttempted`
  one-shot → 'skip' → native. Net: bounded, no loop (G3 holds — reroute must go
  through `_recoverToRemuxTier` to consume the one-shot).
- R2 user seeks DURING reroute: seek handler hits `transmuxerRef.current === null`
  (torn down) — must no-op gracefully rather than throw; the mpegts recreate path has
  its own gen counter for post-init seeks. Plan: guard the MKV seek path on a null
  transmuxer (it currently assumes non-null after init).
- R3 file switch DURING reroute: cleanup() runs (streamUrl change) → cancelledRef +
  per-file resets; `_recoverToRemuxTier` re-parses `streamUrlRef.current` (live, §2
  G4) — a mid-reroute switch reroutes the NEW file's URL. The mpegts FATAL handler's
  live-URL defence (:3655-3663) is precedent. Reroute must re-check
  `cancelledRef`/generation after its await points before touching refs.
- R4 cache-discard dialog racing reroute (`cmd_delete_cache` in user's repro log):
  server-side remux process lifecycle already handles client disconnect; cache
  deletion re-spawns ffmpeg on next request. Client-side: reroute fetch simply sees a
  fresh (slower) remux start. No special handling.

## §10 Verdict matrix
| Edge | Verdict |
|---|---|
| D1/D2 video-error codes 3+4 | reroute both, post-init only (init flag filter) |
| D3 silent SB fatal | refill-chain hasFatalError check must ALSO reroute |
| D4 transmuxer onError | include; element reset idempotent |
| False positives (quota, lone SB error event, init-phase code-4) | excluded by existing flags |
| Loop guard | MUST reuse `_recoverToRemuxTier` (one-shot ref) — no parallel copy |
| Teardown | chain/transmuxer/warmer/blob teardown BEFORE recovery call (§3 order) |
| Resume | capture currentTime at detection; <8s → cold 'init' (repro case) |
| audio_idx namespace | benign server fallback v1; position-mapping enhancement |
| Server | zero new endpoints; audio_idx cache/validation pre-existing |
| Races R1-R4 | bounded by existing one-shot + gen counters + live-URL re-parse; add null-transmuxer seek guard + init-flag clear verification |
