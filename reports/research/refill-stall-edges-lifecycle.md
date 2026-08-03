# Refill-Stall Fix Stack — Playback-Lifecycle Edge Cases

Verified at source 2026-08-02. Files: `useMSEPlayer.ts` (=MSE), `MediabunnyTransmuxer.ts` (=TX),
`FastStreamPlayer.tsx` (=FSP), vendored `mediabunny/src/matroska/matroska-demuxer.ts` (=MKD).
Fix stack under design: (A) harvest keyframes from iteration pumps, (B) consecutive-null breaker
→ `_recoverMkvToRemuxTier`, (C) failure backoff.

## L1. EOF on cue-less files — Verdict: NEEDS-GUARD

**Today.** EOF detection MSE:2807-2819: `isNoProgress` requires `keyframeTimestamp !== null`
(:2808); a null refill therefore sets `isNoProgress=false` → :2814 **RESETS
`consecutiveNoProgressRef` to 0**. The confirm gate `isConfirmedEOF && keyframeTimestamp !== null`
(:2819) is doubly unreachable. A cue-less file buffered to duration-end null-loops at EOF forever:
`endOfStream()` (:2849) never runs, `video.ended` never true (the :2647 chain-stop never trips),
replay overlay (FSP:2713) never shows.
**Old/indexed behavior at EOF**: refill near duration resolves the SAME last keyframe twice →
noProgress≥2 → :2819 path: `hasEverCompletedRef=true` (:2822), flush, `endOfStream` (:2849),
`setIsComplete(true)` (:2851) → finally-block stops chaining via `isCompleteRef` (:2941).

**With stack.** (A) harvest: at EOF `findNearestKeyframe(duration-ε)` hits the last harvested kf
(TX:811). Two refills resolve it identically → noProgress×2 → normal EOF path fires. BUT only when
the last GOP ≤ 12s — the sparse-index rule TX:837 returns null beyond 12s, falling back to native
`getKeyPacket` → same null → loop. So harvest alone fixes EOF **only for GOP≤12s** (10.4s here —
works, not general). (B)'s EOF-guard must cover the rest.

**Required guard (exact).** In the null branch (MSE:2900), BEFORE counting a breaker failure:
```
nullNearEof = duration > 0 && Number.isFinite(duration)
           && refillPosition >= duration - Math.max(estimatedKeyframeInterval, 5)
```
Reuse `estimatedKeyframeInterval` (:2801-2806, = avg of last-5 harvested gaps, min 2, default 5;
with harvest the index has ≥6 entries so it ≈ real GOP). "Near" = one GOP (floor 5s): a null with
refillPosition inside the final GOP means the last keyframe is behind us and fully transmuxed.
On `nullNearEof`: run a REDUCED completion — `hasEverCompletedRef.current=true`;
`ms.endOfStream()` if open (:2847-2850 idiom); `setIsComplete(true)`; `isCompleteRef=true`;
return without rechain. Do NOT run the :2825-2845 flush block (keyframeTimestamp is null;
seekBuffer is empty — the failed seekTo produced nothing). Setting `hasEverCompletedRef` is
load-bearing: the near-end seek guard (:9463, forward-seek → forced `ended`) and its FMP4 twin
(:8815) key off it. Without it, replay-overlay/near-end-seek semantics diverge from indexed files.
Reroute must NOT fire near EOF (restarting the whole file on tier-2 for the last 5s is strictly
worse than ending). Order: nullNearEof check FIRST, breaker count only in the else.

## L2. Eviction vs index/position-cache — Verdict: SAFE

**Confirmed no conflation.** `evictOldBuffer` (MSE:2978-3016) touches only SourceBuffer wrappers +
`video.currentTime`; threshold `totalBuffered*bitrate ≥ maxBufferBytes` (:2997), evicts ranges
ending before `currentTime-30` (BUFFER_KEEP_BEHIND, :1352). It never references transmuxerRef,
keyframeTimestamps, or mediabunny state. The harvest index (TX `keyframeTimestamps`, instance
field) and mediabunny's `clusterPositionCache` (MKD:183) describe the FILE; eviction describes the
SourceBuffer. Nothing to invalidate — correct by construction.

**Backward seek to 5s after evicting [0,20.81).** seekTo(5): harvest index [0,10.40,20.81,...] →
`findNearestKeyframe(5)`→0 (gap 5<12, TX:837 passes) → `getKeyPacket(0, verify:false)`. Walk start
MKD:2233-2260: `binarySearchLessOrEqual(clusterPositionCache, 0)` → first cluster (startTimestamp
0, cached during prime; insertion site MKD:710-723 in readCluster — cache grows on every cluster
READ regardless of SB eviction). Walk starts AT the cluster containing kf 0 → `getMatchInCluster`
(MKD:2092-2106) finds it, `correctBlockFound` (0 < cluster.endTimestamp) → success. Backward seeks
into previously-ITERATED spans always land on a cache entry ≤ target whose cluster holds the
resolved keyframe (harvest guarantees resolved kf = a real iterated kf). `bestCluster` fallback
(MKD:2318-2326: keyframe≤t found but t ≥ cluster end → walk continues, returns best at loop end)
covers the target-inside-next-uncached-cluster case. Today (index=[0]) the same call already works
— the pathology is exclusively forward-past-iterated-end. No change needed.

## L3. Pause/resume during the null-loop — Verdict: NEEDS-GUARD

**Breaker counts while paused: yes, and it should.** The refill chain has no pause gate (entry
checks MSE:2647-2676: video/transmuxer/sb/ended/fatal/backpressure only). Paused at 24s with
bufEnd 25.02: ahead≈1s < cap → refills run → nulls count → breaker fires while paused. Correct:
'paused means paused' governs PLAYBACK state, not buffer maintenance; fixing the tier under a
paused user is invisible if pause survives.

**Pause survival through the reroute — seek plan (resumeT ≥ 8s): PROVEN.**
`_recoverToRemuxTier` :4595-4599 → `_mpegtsRecreatePlayerForRemuxSeek`:
- :6391 `wasPaused = isPausedRef.current || video.paused` (captures BOTH pause kinds);
- :6641-6643 `if (wasPaused) { video.pause(); diag('stayed paused (paused means paused)') }`;
- align-poll :6735 `if (!wasPaused) v.play()` — never plays for a paused user;
- timeout safety-net :6678 `if (reason.startsWith('timeout') && !wasPaused)` — also gated.

**Cold plan (resumeT < 8s): HOLE.** planRemuxRecovery (:239-254) returns 'init' when
`currentTime < 8`. Cold path: `_initMpegtsPlayer` → MEDIA_INFO → :4091 pause → cold gate resolves
→ :4105 `await player.play()` — **unconditional**. The only re-pause is :4634-4638
`if (isPausedRef.current) video.pause()` — that is the PREFETCH pause ref (set by pausePrefetch
:9635), NOT the video-element pause. A user who paused the VIDEO (space) at t=3s while refills
fail (nulls occur at bufEnd=25 regardless of playhead) gets force-unpaused by :4105. The cold-start
overlay itself doesn't force play (FSP onCanPlay :985 returns while `coldStartBufferingRef`; and
:978-983 blocks play under the replay overlay) — the violation is exactly :4105 + the too-narrow
:4636 condition.
**Required guard (exact).** In `_recoverMkvToRemuxTier`, alongside resumeT capture (:4667):
`const wasPausedAtReroute = (videoRef.current?.paused ?? false) || isPausedRef.current;`
After `_recoverToRemuxTier` returns ok (:4703-4708): `if (wasPausedAtReroute) { try {
videoRef.current?.pause(); } catch {} }`. (Capture BEFORE teardown — src='' zeroes state, and
:6420 pauses the element as part of teardown, so reading `video.paused` later always yields true
→ would wrongly pause resumed users. Do not widen :4636 itself — shared with the TS tier.)

## L4. Backpressure interplay — time-to-fire arithmetic — Verdict: NEEDS-GUARD (parameter spec)

`__nobuf_bufferFullDetected` is **inert here**: set only in the mpegts.js error handler (:3782),
read by mpegts quota machinery (:3697/:4315/:5061); the transmuxer refill chain never reads it.
The real gates: entry cap `ahead ≥ getBufferAheadCap()` → silent return (:2673, cap=30s network /
120s local, :1353/:1360) and finally-block delay (:2958): `ahead<20 → 0ms; else
min(5000, max(2000, (ahead-20)*200))` = 2000ms for ahead 20-30s.

**Failure cadence** (log-verified 1-c.md:79,102,122,142): bufEnd frozen at 25.02;
ahead 25.0→23.5→21.5 → one null per ~2s (3 failures over first ~5.5s of playback), then ahead<20
→ `immediately` → ~130Hz. If the stall starts with ahead>30 (cap region), the entry guard skips
seekTo entirely (zero failures counted) at 2s/cycle until ahead<30 — the count start is delayed
but runway at count start is then 30s: same bound below holds.

**Worst case for "25s buffered, playhead 24.9s"** (i.e. stall began ~25s ago, user near bufEnd,
breaker just now counting — only possible with counting delayed, e.g. paused-then-resumed): runway
to `video.waiting` = 0.12s. User sees frozen frame + waiting spinner almost immediately; breaker
must bound the STARE time. With N failures at backoff b each: stare ≈ N×b + reroute-spin-up
(cold remux ≈ 2-4s: ffmpeg start + MEDIA_INFO).

**Recommended parameters.** N=5, backoff ladder 500ms, 1s, 2s, 2s, 2s (reset on success/seek/
track-switch/file-change). Time-to-fire from first counted failure: 0.5+1+2+2+2 = **7.5s** ≤ 8s
target; visible stall in the worst case ≈ 7.5s + spin-up where the cold overlay takes over
(indeterminate spinner :4617-4619 — perceived as loading, not freeze). In the COMMON case (stall
begins at prime end, playhead ~0-5s, runway ≈ 20-25s) the fire at ≤7.5s is fully invisible —
19+s of buffer still ahead. L7 proves retries can't succeed, so N>5 buys nothing; N=5 (not 3)
only hedges vs transient teardown nulls, which the gen-gate already filters (L5) — N=3..5 all
defensible, 5 chosen for zero false-fire margin. Backoff also kills the 130Hz spin (C's goal):
max 0.5 fail/s vs 130/s = 260× reduction.

## L5. StrictMode double-mount — Verdict: SAFE (with stated placement rules)

Log 1-c.md:4-12: mount#1 inits → cleanup runs `stopStreamingChain` (per-file cleanup :2284; also
logged "Streaming chain stopped" 1-c.md:8) → `streamingChainGenRef++` (:2618). Mount#1's refill
callbacks then die at every gate: post-await :2742, catch :2909, finally :2918, reschedule
:2953/:2966. **But StrictMode re-runs effects on the SAME component instance — all useRefs
PERSIST across the double-invoke.** The new counter refs would carry mount#1's residue into
mount#2 unless reset.
**Placement rules (both required):**
1. Reset `consecutiveNullRefillsRef.current = 0` (+ backoff-level ref) in `startStreamingChain`
   next to the existing EOF-tracker resets (:2610-2611 `lastRefillKeyframeRef`/
   `consecutiveNoProgressRef` — exact precedent). Every chain (re)start zeroes the breaker.
2. Count/fire the breaker AFTER the generation bail (:2742), mirroring the zero-audio block's
   position (:2750-2778). All teardown paths bump the gen in the same tick they dispose
   (cleanup :2284+:2340; reroute :4672+:4680; user seek :9156) — so a dispose/abort-induced null
   from a dying chain can never increment a live counter.
With both, mount#1 leakage into mount#2's breaker is structurally impossible.

## L6. File switch mid-null-loop — Verdict: NEEDS-GUARD (mirror resets)

Per-file cleanup (:2258-2390) on streamUrl change already: stops chain (:2284), disposes
transmuxer (:2339-2342, aborts in-flight seekTo), resets the audioskip-fix refs at :2352-2355
(`mkvRerouteInFlightRef=false; mkvSbHasAudioRef=true; zeroAudioWindowsRef=0`).
**Required:** add `consecutiveNullRefillsRef.current = 0` (+ backoff-level ref) immediately after
:2355, AND the same in the unmount `cleanup()` at the twin block :2465-2467. If backoff is
implemented as the finally-block reschedule delay (recommended — no new timer), there is no timer
to clear: the rescheduled `setTimeout` self-gates on generation (:2966) and dies. If instead a
dedicated timer ref is used, it must be cleared at both anchors (follow `drainTimerRef` :2290-2293
pattern). In-flight `_recoverMkvToRemuxTier` during a switch is already defended: live-URL
re-parse (:4561) targets the CURRENT file, `cancelledRef` checked at entry (:4659).
**Discovered while tracing:** `hasEverCompletedRef` is NEVER reset in per-file cleanup (grep: only
`useRef(false)` + set-true sites :2822/:8366/:8528). Pre-existing latent bug (near-end seek guard
:9463 can force `ended` on a NEW file if a previous file completed). The stack's L1 guard writes
this ref, so add `hasEverCompletedRef.current = false` to the per-file cleanup while there.

## L7. Warmer interaction — Verdict: SAFE (and proves low N)

The warmer is a plain `fetch(warmerUrl)` loop with `source_id=warmer` (:6825-6908) filling the
BACKEND disk cache + green-bar ranges. It never touches mediabunny: `clusterPositionCache` entries
are inserted ONLY in the demuxer's own `readCluster` path (MKD:710-723), fed by TauriStreamSource
reads from playback seeks/iteration. Different process layer — confirmed, no shared state.
**Persistence of the null:** the walk (MKD:2233-2277) is a pure function of (cues=∅,
clusterPositionCache, target). During a null-loop NO clusters are read (F3: zero STREAM-REQ rows
in 1-t.md:142+ during 12:25:19→50 except warmer; each failure 0.4-2ms) → cache is frozen → every
retry recomputes the identical null. Warmer progress can make a later retry FASTER (disk hit),
never DIFFERENT — reads don't fail here (a network failure throws, it doesn't return null;
`requestSliceRange`→null only at segment end, MKD:2283). 3,413 retries were arithmetic-guaranteed
pointless → breaker N small (5) is correct; large N is superstition.

## L8. Replay after ended — Verdict: SAFE

Replay path FSP:1365-1377: `setVideoEnded(false)` → `seekTo(0)` → `v.play()`. seekTo(0) enters
the MSE transmuxer seek path: `executeTransmuxerSeek` (:9077) clears completion (:9078-9079
`setIsComplete(false); isCompleteRef=false`), `stopStreamingChain` (:9156), then
`transmuxerRef.current.seekTo(0, INITIAL_SEEK_DURATION)` (:9333/:9160s region) — the **same
transmuxer instance**. No re-init: the per-file effect is keyed on `[streamUrl, mp4ReinitNonce]`
(:2395); replay changes neither. The harvest index is `private keyframeTimestamps` on the instance
(TX:158 region, written by `addKeyframeTimestamp` TX:781-800) → survives replay; refills after
replay benefit immediately. Stale-index-across-instances is impossible by construction: a NEW
transmuxer only exists after `dispose()` (which clears the arrays TX:1874-1881) + full re-init,
and the index is never serialized off-instance. Breaker/backoff reset on replay comes free via
`startStreamingChain` reset (L5 rule 1) — the post-seek chain restart (:9297) zeroes it.
MKV persistent-Input reuse (TX:1289-1293) keeps the same demuxer position cache across replay —
also correct (same file). Note `hasEverCompletedRef` stays true after replay by DESIGN (the
near-end guard :9463 needs it for the re-watch → re-end cycle).

## L9. Zero-audio watchdog vs null-breaker — Verdict: SAFE

Mutually exclusive per refill, by branch construction: the zero-audio block runs only under
`keyframeTimestamp !== null` (:2763); the null-breaker lives in the `else` at :2900. One refill
increments at most one counter. A null refill also cannot poison the audio counter indirectly:
`wasLastWindowAudioStarved` (TX:1727) reflects `lastWindowAudioStarved`, written only in the
iterate path (TX:1534-1537, gen-gated) — a null-returning seekTo exits at TX:1438 before any
window runs, and the hook never reads it on the null branch anyway. Conversely a null loop resets
nothing audio-related mid-loop (`zeroAudioWindowsRef` untouched in the else branch) — stale count
resumes if refills recover, which is correct (consecutive-window semantics span only successful
windows; acceptable and pre-existing).
**Double-reroute impossibility:** both fire `recoverMkvRerouteRef.current?.(...)` →
`_recoverMkvToRemuxTier` R1 latch `mkvRerouteInFlightRef` (:4658 early-false; :4662 set; :4710
finally-clear). Concurrent second caller returns false. Sequential re-fire is dead thrice over:
(i) reroute ran `stopStreamingChain` (:4672) — no chain exists to count; (ii) `transmuxerRef=null`
(:4681) fails the refill entry check (:2647); (iii) `remuxRecoveryAttemptedRef=true` (:4567) makes
`planRemuxRecovery` return 'skip' (:246) → native, never a loop. The breaker MUST mirror the
existing call-site gate `!mkvRerouteInFlightRef.current` (:2771-2772 precedent) before invoking.

## L10. Backpressure 'ahead' NaN/negative paths — Verdict: SAFE

`getBufferedAheadSeconds` (:2497-2514) → `contiguousBufferedAhead` (:1110-1155):
- buffered empty → 0 (:1115); non-finite pos → 0 (:1116); pos clamped ≥0 (:1117).
- **buffered.end < currentTime (post-eviction/stale ranges):** the forward walk (:1144-1153)
  finds no span containing pos (`pos < end` fails), spans behind fail `pos+hole < start` too →
  `bufferEnd` stays `pos` → returns `max(0, pos-pos) = 0` (:1154). Explicitly `Math.max(0,…)` —
  no negative escape.
Therefore `refillPosition = video.currentTime + ahead` (:2690) is always finite ≥ currentTime;
`snapToCueKeyframe` is an identity for cue-less (idx.length===0 → return time, TX:287) and
NaN-guarded anyway (`!Number.isFinite(time) → return time`); `nextKeyframeAtOrAfter` → null →
`stopTime=Infinity` (:2717) → TX:1645 falls to the finite maxDuration branch. seekTo receives an
ordinary in-range target. `getBufferAheadCap` (:2541-2558) degrades to the constant 30 on any
unresolvable byte (-1 sentinel :2546-2548). No arithmetic path feeds NaN/negative into
seekTo/snapToCueKeyframe. The fix stack adds no new arithmetic here.

## Summary of required guards

| Edge | Guard |
|---|---|
| L1 | Null-EOF branch: `refillPosition ≥ duration - max(estimatedKeyframeInterval,5)` → set `hasEverCompletedRef`+`isComplete`, `endOfStream()`, NO flush, NO reroute; checked BEFORE breaker count |
| L3 | Capture `wasPausedAtReroute = video.paused \|\| isPausedRef.current` pre-teardown in `_recoverMkvToRemuxTier`; re-pause after successful `_recoverToRemuxTier` (cold-plan :4105 force-play hole) |
| L4 | N=5, backoff 0.5/1/2/2/2s via finally-block delay → fire ≤7.5s; reset on success/user-seek/track-switch/file-change |
| L5 | Reset breaker refs in `startStreamingChain` (:2610 pattern); count/fire only after gen check :2742 (zero-audio block position) |
| L6 | Mirror resets at :2355 (per-file) and :2467 (unmount); also reset `hasEverCompletedRef` per-file (pre-existing latent bug, now load-bearing via L1) |
| L9 | Breaker fire gated on `!mkvRerouteInFlightRef.current` (:2772 precedent) |
