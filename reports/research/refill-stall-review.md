# Cross-Validation Review — Refill-Stall Research Docs

REVIEW COMPLETE 2026-08-02. Fresh-eyes re-derivation of every load-bearing claim.
Files: MSE = app/src/hooks/useMSEPlayer.ts, TX = MediabunnyTransmuxer.ts,
MKD = vendored matroska-demuxer.ts, MKM = vendored matroska-muxer.ts.
Verdicts: VERIFIED / FALSIFIED / INCONCLUSIVE with file:line evidence.

## Per-doc verdicts

| Doc | Verdict | Notes |
|---|---|---|
| rootcause.md | VERIFIED | F2 count re-verified (`grep -c "No keyframe found at or before 25.024" 1-c.md` = 3413 exactly); F6 cadence lines re-read (1-c.md:79,102,122,142 = 2000ms sleeps at 25.0/23.5/21.5 then "immediately" at 19.5); C1-C5 anchors all re-opened and correct (MSE:2702/:2706/:2717/:2730/:2900-2904; TX:1433-1438/:1454-1457/:837). |
| verify-h1.md | VERIFIED | Walk mechanics re-derived at MKD source: cue search :2233-2240, cache search :2243-2250, `Math.max(...)||null` :2252-2255, `?? clusterSeekStartPos` :2260 (dead once cache has entry ≤ t), break :2271-2276, cue-only "lied to us" retry :2367-2375, bestCluster :2377-2380, `return null` :2382. Upstream-identical claim: downgraded, see Adjudication 8. |
| fixdesign.md | VERIFIED with amendments | A/B/C mechanics and all anchors check out; EOF threshold + eof-N need amendment (Adj 1); G2 wiring needs the track-mapping step (Adj 4); backoff numbers corrected (Adj 2). |
| edges-lifecycle.md | VERIFIED with 1 arithmetic error | L1/L3/L5/L6/L9 fully re-verified. L4's "fire ≤7.5s" is WRONG arithmetic (classification fires ON the 5th null; the 5th delay never runs → ladder fires at 5.5s, flat-1000 at 4s). L1's threshold wins Adj 1. |
| edges-seek.md | VERIFIED with 1 spec gap | S1/S3/S6 re-derived and sound. G2 as written ("set remuxAudioIdxRef from the requested track") is under-specified: trackId is a Matroska TrackNumber, NOT an ffprobe stream index — naive assignment selects the wrong stream on tier 2 (Adj 4). G5 is moot (Adj 2). |

## Adjudication 1 — EOF-null threshold (30s fixed vs one-GOP)

Evidence:
- `nearEofHole` EXISTS at MSE:2760-2762: `refillPosition >= durForHoleGuard - 30`. VERIFIED — but
  its semantics is zero-audio-watchdog SUPPRESSION (comment :2756-2759: "audio tracks commonly end
  slightly before video"). Laxity is safe there (it only prevents a reroute). Reusing 30s to
  DECLARE EOF is a materially stronger use: a null at duration−25 with real content untransmuxed
  would truncate the tail. fixdesign's "reuses nearEofHole's constant" borrows the number, not the
  safety argument. FALSIFIED as a justification; the number itself is merely risky.
- `estimatedKeyframeInterval` EXISTS at MSE:2801-2806: default 5; if index ≥ 6 entries,
  `max(avg last-5 gaps, 2)`. Declared inside the same try block, BEFORE the :2862/:2900 if/else ⇒
  IN SCOPE at the null branch. VERIFIED. Existing isNearEOF (:2807) uses it raw (no 5s floor);
  L1 adds `max(...,5)` — a mild strengthening, fine.
- Scenario check: post-A, a refill-chain null near duration only occurs when playback actually ran
  to the end ⇒ index is dense ⇒ estimator ≈ real GOP (10.4s). A COLD near-EOF user seek cannot
  null (S1 mechanics: forward walk finds keyframes → bestCluster → slow success), so the sparse-
  estimator case never feeds the eof verdict in practice.
- eof-N: OLD indexed EOF requires noProgress≥2, or nearEOF + noProgress≥1 (:2816-2818) — i.e. TWO
  refills observing the same result near the end. fixdesign's N=5-even-for-eof waits ~4-5s of dead
  time at file end (worse than shipped behavior); L1's fire-on-FIRST-null is stronger than any
  shipped precedent (single-observation terminal state).

**RULING: threshold = `duration - Math.max(estimatedKeyframeInterval, 5)` (L1), passed into the
pure fn as a parameter; 'eof' requires `consecutiveNulls >= 2` (mirrors nearEOF+noProgress≥1 =
2 consecutive observations); 'reroute' stays at >= 5.** One pure fn, two thresholds. 30s is
rejected: it can truncate up to ~3 GOPs of tail; one-GOP+floor is exactly "inside the final GOP"
and its dependency (harvested entries) provably holds in the only scenario that reaches it.

## Adjudication 2 — Backoff shape (flat 1000ms vs ladder 0.5/1/2/2/2)

Code-path facts re-verified:
- Finally-block: ahead ≥ cap(30) → 2000ms (:2950-2956); else `ahead < 20 ? 0 :
  min(5000, max(2000, (ahead-20)*200))` (:2958). At ahead 25 → 2000ms; at 15 → 0ms. The claimed
  130Hz below 20s: VERIFIED (F6: 3413 failures/~26s ≈ 131Hz; log line "chaining next refill
  immediately" at ahead 19.5).
- During a null loop while PLAYING, ahead SHRINKS (bufEnd frozen, playhead advances — log shows
  25.0→23.5→21.5 at ~2s/cycle). While PAUSED, ahead is constant. At ahead ≥ 30 paused, the ENTRY
  guard (:2673) returns before seekTo — zero nulls counted (L4 already notes this; runway at count
  start is 30s, bound holds).
- C's swap sits in the ELSE branch only: at ahead ≥ 30 the :2950 branch overrides (2000ms,
  null-flag ignored) — correct. At ahead 20-30 the flag branch gives 1000ms — FASTER than today's
  2000ms (2× attempt rate in that band). Harmless: breaker fires sooner with ≥20s runway.
- Time-to-fire, corrected (classification runs ON the Nth failure; no delay after it):
  flat-1000: nulls at t=0,1,2,3,4 → fire at 4s. Ladder: 0,0.5,1.5,3.5,5.5 → fire at 5.5s.
  **L4's "7.5s" is FALSIFIED** (it summed a 5th delay that never runs).
- Worked timelines (flat-1000, N=5 reroute / N=2 eof):
  (a) Stall at prime end, playhead 2s, ahead≈23: null#1 → 1s → … → fire at 4s; reroute spin-up
  2-4s; buffer runway 23s → user sees NOTHING (playback continues on buffer throughout).
  (b) Stall discovered at ahead 0.1s: waiting-spinner at ~0.1s; fire at 4s; + spin-up ⇒ total
  visible stall ≈ 6-8s, cold overlay covers the spin-up. Ladder: 7.5-9.5s total. Flat wins.
- G5 (generation-gate the backoff sleep): MOOT AS A NEW REQUIREMENT — C is an expression swap
  inside the EXISTING setTimeout whose callback already checks `streamingChainGenRef.current ===
  chainGeneration` (:2964-2969, :2952-2954 both verified). Keep G5 only as a "don't move it out
  of that wrapper" note.

**RULING: flat 1000ms (fixdesign C).** Simpler, fires 1.5s sooner in the worst case, same
invisibility in the common case; the ladder's only edge (0.5s first retry on a transient) is
worth nothing because L7 proves retries against a frozen cache are deterministic.
Correct L4's numbers to 5.5s/4s wherever quoted.

## Adjudication 3 — Guard G1 (user-seek null)

Verified at source:
- MSE:9075 `video.currentTime = clampedTime` runs BEFORE executeTransmuxerSeek — CONFIRMED: on a
  null the element already sits at the unbuffered target.
- Null branch :9319-9323: discards seekBuffer, clears transmuxerSeekInProgressRef, NO setError, NO
  chain restart. Chain stopped at :9156; startStreamingChain exists only in the success branch
  :9297. Dead player CONFIRMED (spinner forever; only another user seek recovers).
- Alternative remedy traced ("restart chain at old position + revert currentTime"): the refill
  chain computes refillPosition = video.currentTime + getBufferedAheadSeconds() (:2689-2690).
  Reverting currentTime to 24 → chain refills at bufEnd 25.02 → SAME null geometry → breaker
  counts → reroute at ~4s with resumeT=24 (loses the user's target). NOT reverting (leave 28) →
  ahead=0 (contiguousBufferedAhead returns 0 for pos outside ranges) → refill at 28 → same null →
  breaker → reroute resumeT=28. Both converge on the reroute; the chain-restart variant just adds
  4-5s of spinner and complexity.
- Immediate reroute lands BETTER: _recoverMkvToRemuxTier captures resumeT = video.currentTime
  (:4667) = the user's TARGET (28) → planRemuxRecovery ≥8s → 'seek' plan →
  _mpegtsRecreatePlayerForRemuxSeek, whose wasPaused (:6390) captures `isPausedRef.current ||
  video.paused` — pause preserved. Target <8s → cold plan → L3's force-play hole applies ⇒ L3
  guard is REQUIRED for G1 too (though a <8s user-seek null is unreachable today and post-A).
- Post-A reachability: the only null geometry is a target in the ≤1-GOP shadow past an iterated
  frontier; harvest+watermark closes it. G1 is a belt for unknown mechanisms.

**RULING: G1 = immediate `_recoverMkvToRemuxTier('user seek keyframe unresolvable')` in the
:9319 null branch, gated on `formatRef.current==='mkv' && !mkvRerouteInFlightRef.current`; no
counting (one-shot event, refill counter never sees it); no currentTime revert. Non-MKV formats
in that branch keep today's behavior.** Seek-edges' recommendation confirmed; "restart chain"
alternative rejected with the trace above.

## Adjudication 4 — Guard G2 (track-switch null)

Verified: :6217 stopStreamingChain → :6222 resetForSeek (SB FLUSHED) → :6238 seekTo → null branch
:6248-6251 reverts selection and returns false — nothing restarts the chain (restart only at
:6262 in the success path) ⇒ dead player today. CONFIRMED.
remuxAudioIdxRef writes: :6196 is the ONLY set inside _switchMkvAudioTrack (the 'reroute-remux'
plan branch); :6132 belongs to _switchRemuxAudioTrack (different function). CONFIRMED.

**SPEC GAP FOUND (falsifies G2-as-written): `remuxAudioIdxRef` holds an ffprobe stream index
(consumed by withAudioIdx at :4583 → server-side validate_audio_idx_override), while `trackId` is
a Matroska TrackNumber.** The mapping requires the /audio_tracks fetch + mapAudioTrackToRemuxIdx
(:6184-6195). The guard must reuse that mapping (extract it or duplicate the ~10 lines); on fetch
failure set null (server default track) — same degradation the plan branch accepts. Order: set
remuxAudioIdxRef BEFORE `recoverMkvRerouteRef.current?.(...)` (the reroute reads it synchronously
at :4583). Skip the setDesiredAudioTrack(null) revert on the reroute path — the transmuxer is
disposed at :4680 anyway.

## Adjudication 5 — Watermark update rule

Re-derived line by line (rule text from fixdesign §A):
- Initial state (end=-1): first packet takes the else-if (`ts > -1`) → span=[ts,ts] where ts is
  the resolved keyframe (iteration starts AT keyPacket, TX:1596 yields it first). VERIFIED.
- The else-if condition `ts > this.harvestSpanEnd` is reachable-false only for ts ≤ -1 (degenerate
  negative timestamps) — it is a harmless guard, not a logic hole. VERIFIED (cosmetic: a comment
  should say so).
- Disjoint-LOWER (backward seek to virgin region below the span): ts < end ⇒ first condition TRUE
  (ts ≤ end+0.25) ⇒ merge branch ⇒ inner `ts > end` false ⇒ NO extension. Span unchanged. KEY
  INSIGHT confirming soundness: span claims are MONOTONE FACTS — once [start,end] was fully
  iterated and its keyframes inserted, that stays true forever (index entries are never removed
  except dispose). A stale span never over-claims. The new lower region under-claims
  (conservative). VERIFIED — no over-claim sequence found.
- Abutting/overlap geometry vs iterateVideoPackets :1614-1618: with stopTime=Infinity and
  maxDuration=17, the cut fires at the first packet with adjustedTimestamp > 17 (that packet is
  NOT emitted but IS observed — harvest sits BEFORE the stop-checks, so noteIterated extends the
  span to the break packet's ts). Next refill: refillPosition = bufEnd (last EMITTED sample end)
  < span end; findNearestKeyframe resolves the PRIOR keyframe (inside span) ⇒ next window STARTS
  BEHIND the previous cut ⇒ windows OVERLAP by construction on cue-less files — the merge branch
  is exercised with negative gap, the 0.25s tolerance is never even needed for refills. The
  tolerance only matters for exact-abut geometries (cue-indexed files — where harvest is gated
  OFF). VERIFIED, reasoning in fixdesign confirmed.
- Sliver hazard (falsification attempt): can a keyframe hide inside a bridged ≤0.25s gap
  (end, newStart)? Only if two keyframes sit < 0.25s apart AND the window resolution skipped the
  earlier one. Consequence when it happens: findNearestKeyframe(q) for q in the sliver returns a
  harvested kf EARLIER than the true nearest → getKeyPacket(exact harvested ts) still succeeds →
  one-GOP overlap re-transmux (shipped pre-abutting behavior). NO null path, NO wrong packet.
  Attempted falsification FAILED — rule is sound; worst case is a benign overlap.
- 'span start is always a keyframe': DISJOINT-HIGHER reset sets start = first packet ts = resolved
  keyframe ts. VERIFIED. (Audio pump never calls noteIterated — video-only, consistent.)
- Residual (disclosed in fixdesign, confirmed real but bounded): a far-forward seek resets the
  single span; for GOP>12s files, later USER seeks back into the old region can fall to the 12s
  rule → null → G1 reroute. Bounded degradation, guarded. Accept single-span model.

## Adjudication 6 — classifyNullRefill wiring

- Gen-check order: :2730 seekTo → :2742-2745 stale-gen EARLY RETURN → … → :2900 null branch. A
  stale-gen refill CANNOT reach the counter. VERIFIED by direct read.
- 'eof' wiring: setting isCompleteRef=true before return works because the finally's
  chain-continue is gated `!isCompleteRef.current` at :2941. VERIFIED. bufferingForSeekRef is
  already cleared at :2748 (before the branch) — no leak. hasEverCompletedRef consumers confirmed
  at :8815/:9018/:9463.
- 'reroute' double-fire: `void recoverMkvRerouteRef.current?.(...)` executes synchronously
  through :4658-4672 up to the first await (:4703) — i.e. mkvRerouteInFlightRef latch (:4662) AND
  stopStreamingChain (:4672 → gen bump :2618) both land BEFORE control returns to the null
  branch. The finally then hits `chainGeneration !== streamingChainGenRef.current` (:2918) →
  return → no reschedule. VERIFIED — no double-fire, no orphan setTimeout.
- Counter-increment placement claim (after :2742): VERIFIED as automatic — :2900 is downstream of
  :2742 in the same try.

## Adjudication 7 — Fixture viability (V3)

- MKM finalize() (:1309-1330): `assert(this.cues); this.ebmlWriter.writeEBML(this.cues);` runs
  UNCONDITIONALLY; the `if (!appendOnly)` gate (:1332) covers only the segment-size back-patch
  AFTER the Cues write. VERIFIED — trailing Cues always written, even appendOnly.
- maybeCreateSeekHead: `if (appendOnly) return;` (:208-210). VERIFIED — no SeekHead pointer.
  Whether the demuxer would DISCOVER trailing Cues in a small in-memory file is UNRESOLVED (lazy
  metadata scan may or may not reach them) — IRRELEVANT because fixdesign step 2 truncates at the
  trailing `1C 53 BB 6B` regardless (scanning from the END finds the true element; payload
  false-positives all lie before it).
- Truncation tolerance: appendOnly segment size = -1 (:668) → unknown-size → elementEndPos null →
  walk loop condition `segment.elementEndPos === null || …` (MKD:2271) handles it; header read
  returns null slice at buffer end → `if (!slice) break;`. VERIFIED — truncated cue-less buffer
  is demuxer-walkable.
- Residual risk is only the muxer FEED path in node (codec registration/metadata validation for
  synthetic vp8 packets). **RULING: fixture design is robust; attempt it, timebox, mock-sink
  harness as fallback exactly as fixdesign specifies. No amendment.**

## Adjudication 8 — Upstream-check soundness (verify-h1 Q4)

- Vendored performClusterLookup matches the doc at every cited anchor (re-read: :2233-2260
  precedence, :2271-2276 break, :2367-2375 cue-only retry, :2377-2380 bestCluster, :2382 null).
  VERIFIED.
- Upstream fetch: transcript task-0.log:61 shows `curl raw.githubusercontent.com/Vanilagy/
  mediabunny/main/src/matroska/matroska-demuxer.ts` (2598 lines — matches doc); log:66 shows the
  master function head identical in structure; log:77's grep of master :2330-2445 shows the SAME
  cue-only "lied to us" retry, bestCluster fallback, return null, and NO position-cache retry.
- Verdict: the specific load-bearing structures (walk-start precedence, missing cache retry) are
  VERIFIED-in-master via transcript evidence; the stronger "byte/logic-identical over the full
  function" phrasing is INCONCLUSIVE-but-plausible (no full diff output preserved in the log).
  The conclusion that matters — upgrading does not fix the bug — STANDS.

## Adjudication 9 — Canonical reset-site union

All anchors re-verified by direct read. Breaker counter (`nullRefillCountRef`) + null-flag
(`lastRefillNullRef`) reset sites, canonical list:

1. **startStreamingChain MSE:2610-2611** (beside lastRefillKeyframeRef/consecutiveNoProgressRef —
   verified present). LOAD-BEARING site: covers post-seek (:9297), post-switch (:6262), replay,
   StrictMode mount#2. All others below are belt.
2. Success commit :2862 block (counter→0; flag self-clears at next top-of-try).
3. User seek :9158 (beside zeroAudioWindowsRef reset — verified).
4. Track switch :6218 region (verified stopStreamingChain/:6217 + refillInProgressRef/:6218).
5. Reroute producer-stop :4677 (beside zeroAudioWindowsRef=0 — verified).
6. Per-file cleanup :2352-2355 (verified block: mkvRerouteInFlightRef=false, mkvSbHasAudioRef=
   true, zeroAudioWindowsRef=0) — append counter+flag here.
7. Unmount cleanup twin :2465-2467 (verified same trio).
8. Transmuxer init :7109 (verified zeroAudioWindowsRef=0 there).
Plus: `hasEverCompletedRef.current = false` in per-file cleanup (grep confirms NO reset site
exists today: only decl :1640, set-true :2822/:8366/:8528, reads :8815/:9018/:9463 — L6's latent
bug VERIFIED; it becomes load-bearing once L1 writes the ref).
No dedicated backoff timer exists (C rides the existing finally setTimeout) → nothing to clear.

## Adjudication 10 + New flaws found

(a) Harvest gate vs extractMkvCueIndex order: extract runs in init() (TX:441); iterateVideoPackets
    only runs inside seekTo, and the hook's prime (:7189) runs after init resolves. Gate never
    reads a pre-extraction mkvCueIndex. NO FLAW.
(b) seekTo's own addKeyframeTimestamp (:1454-1457) vs watermark: insert happens pre-iteration;
    the first iterated packet IS that keyframe → span start = it. No concurrent consumer exists
    (chain stopped during user seek/track switch). NO FLAW; dedup absorbs the duplicate.
(c) Thumbnail consumers: useThumbnailExtractor:1888-1895 pushes getKeyframeTimestamps() into the
    thumbnail pipeline when keyframeIndexReady flips (:2897/:9316 — flips on first refill/seek
    SUCCESS; note today, in the bug scenario, it never flips at all). A dense index only improves
    thumbnail seek resolution — no consumer assumes sparseness. NO FLAW.
(d) EOF estimator (:2801-2806) with a dense index: avg last-5 gaps becomes the TRUE GOP instead
    of today's sparse seek-derived gaps (which with ≥6 scattered entries could inflate
    estimatedKeyframeInterval to hundreds of seconds → isNearEOF fires absurdly early with
    noProgress≥1). Harvest SHRINKS the nearEOF window to one GOP — strictly more correct.
    IMPROVEMENT, no regression. State it in the solution doc.
(e) NEW FLAWS the docs missed:
  N1. **L4 time-to-fire arithmetic error** (5.5s not 7.5s; flat = 4s) — see Adj 2.
  N2. **fixdesign C accelerates the 20-30s band**: flag→1000ms replaces 2000ms there (2× null
      attempts). Harmless but undocumented; the "→1Hz" claim should say "≤1Hz below cap".
  N3. **G2 trackId≠ffprobe-idx mapping gap** — see Adj 4. Naive assignment = wrong audio track
      on tier 2.
  N4. **fixdesign's flag-clear anchor is misdescribed**: ":2643, after the early-return guards"
      — :2643 is BEFORE the guards (:2647-2676). Behavior is still correct wherever it sits in
      the try-prologue (entry-guard returns skip the null branch, and the :2950 cap branch
      ignores the flag), but the spec text should anchor it accurately (top of try, before the
      entry guards).
  N5. **TS refills share executeStreamingRefill**: a hypothetical TS null would grow the counter
      forever under 'continue' (isMkv=false). Harmless (bounded int, no fire) — gate the
      increment on formatRef==='mkv' for hygiene.
  N6. **L3's cold-path force-play hole applies to G1/G2 reroutes too** (any reroute with
      resumeT<8s hits :4621→:4105 `await player.play()`; :4636 only re-pauses for
      isPausedRef = PREFETCH pause — verified: isPausedRef is written ONLY by
      pausePrefetch/resumePrefetch :9635/:9674, never by the video 'pause' event). The
      wasPausedAtReroute guard must ship WITH the breaker, not as an optional extra.
  N7. **Entry-guard blind spot while ahead ≥ cap** (paused user, ahead ≥ 30): nulls aren't even
      attempted (:2673 returns pre-seekTo) → breaker silent until buffer drains below cap on
      resume. Bounded (30s runway at count start, per L4's own note) — document, don't fix.

## Required Amendments (apply verbatim to the solution doc)

1. **classifyNullRefill**: replace `nearEofThresholdS = 30` with a caller-supplied
   `nearEofThresholdS = Math.max(estimatedKeyframeInterval, 5)` computed at the call site
   (MSE:2801-2806 value, in scope at :2900). Split the N gate: `'eof'` requires
   `consecutiveNullRefills >= 2` AND nearEof; `'reroute'` requires `>= 5` AND !nearEof AND isMkv;
   below the applicable threshold → `'continue'`. Unknown/Infinity duration ⇒ never 'eof'
   (unchanged). Update NullRefillBreaker.test.ts cases accordingly (2 nulls near end → 'eof';
   4 nulls mid-file → 'continue'; 5 → 'reroute'; boundary at duration−max(gop,5)).
2. **Backoff**: ship flat 1000ms exactly as fixdesign C (expression swap inside the existing
   :2964-2969 gen-gated setTimeout — G5 thereby satisfied, add a comment forbidding relocation).
   Replace L4's ladder and correct all time-to-fire quotes: reroute fires ~4s after the first
   counted null; worst-case visible stall ≈ 4s + 2-4s spin-up under the cold/seek overlay.
3. **G1**: in the :9319-9323 null branch add — if `formatRef.current === 'mkv' &&
   !mkvRerouteInFlightRef.current`: diagLog + `void recoverMkvRerouteRef.current?.('user seek
   keyframe unresolvable')`. No currentTime revert, no chain restart, no counting. Keep existing
   cleanup lines. Non-MKV: unchanged.
4. **G2**: in the :6248-6251 null branch — perform the trackId→ffprobe-idx mapping (reuse the
   :6184-6195 fetch + mapAudioTrackToRemuxIdx logic; extract to a small helper), set
   `remuxAudioIdxRef.current = mappedIdx ?? null`, then `return (await
   recoverMkvRerouteRef.current?.('audio switch keyframe unresolvable')) ?? false`. Drop the
   setDesiredAudioTrack(null) revert on this path (transmuxer is disposed by the reroute).
5. **L3 pause guard ships with the breaker (not optional)**: capture `wasPausedAtReroute =
   (videoRef.current?.paused ?? false) || isPausedRef.current` at the TOP of
   _recoverMkvToRemuxTier (before :4672 teardown); after a successful _recoverToRemuxTier
   (:4703), `if (wasPausedAtReroute) try { videoRef.current?.pause(); } catch {}`. Do NOT widen
   :4636 (shared with the TS tier).
6. **Reset sites**: implement the canonical list of Adjudication 9 (8 sites + hasEverCompletedRef
   per-file reset at :2355 region). Note in code that startStreamingChain (:2610) is the
   load-bearing reset; the rest are belts.
7. **'eof' branch order**: keep L1's shape — near-EOF classification BEFORE the mid-file counter
   escalation, reduced completion (hasEverCompletedRef=true, endOfStream if open, setIsComplete,
   isCompleteRef=true, NO flush — seekBuffer already discarded), return without rechain.
8. **Increment hygiene**: gate the counter increment on `formatRef.current === 'mkv'` (N5) and
   anchor the lastRefillNullRef clear at the top of the try, before the entry guards (N4 — fix
   the anchor text, behavior unchanged).
9. **Docs corrections**: (i) strike "reuses nearEofHole's constant" as a safety justification
   (the constant suppresses a watchdog; different risk profile); (ii) correct L4's 7.5s → 5.5s
   (ladder) and add flat = 4s; (iii) note the 20-30s band speedup under C (N2); (iv) add N7's
   entry-guard blind-spot note; (v) state the estimator-accuracy improvement (10d) and thumbnail
   neutrality (10c); (vi) verify-h1's "byte-identical to upstream" softened to
   "structure-verified via fetched main; full-diff evidence not preserved".
10. **Watermark**: adopt fixdesign §A rule as written (review found no logic bug; the else-if
    guard is dead-but-harmless — add a one-line comment). Keep the single-span model with its
    disclosed GOP>12s-after-far-seek degradation (G1 covers the residue). Add unit case: merge
    branch with ts < end (backward window) leaves span unchanged (no over-claim).
