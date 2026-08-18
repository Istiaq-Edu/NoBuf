# Cue-less MKV Refill Stall — Solution (post-review, amendments applied)

**Status: RESEARCH COMPLETE — APPROVED DESIGN, awaiting build go-ahead.**
2026-08-02. This document consolidates 5 research docs + the cross-validation review.
Every claim herein survived source-level verification (see provenance table at the end).

---

## 1. The bug (verified root cause)

A cue-less MKV (`extracted 0 cue points`) primes [0–25.02s] and plays, then **every**
streaming refill fails: `transmuxer.seekTo(25.024)` → mediabunny `getKeyPacket(25.024)`
→ **null** in 0.5–2ms with zero HTTP reads — 3,413 consecutive times at ~130Hz until the
user gives up. A keyframe at 20.81s ≤ target provably exists and its cluster was read
during the prime.

**Mechanism (H1, VERIFIED at vendored mediabunny 1.45.4 source):**
`performClusterLookup` (matroska-demuxer.ts:2214-2382) starts its **forward-only**
cluster walk at `max(cuePoint≤T, positionCacheEntry≤T)` (:2252-2260). With 0 cues, the
position cache alone picks the start. `readCluster` caches **every** cluster it parses
(:709-723) — so after the prime, the highest entry ≤ 25.024 is the **last prime cluster
(~24.9x s, mid-GOP)**, past the 20.81 keyframe's cluster. That cluster has no keyframe
≤ T (match −1); the next cluster starts > 25.024 → break (:2271-2276) → `bestCluster ===
null` → **return null** (:2382). The 20.81 cluster is *behind* the walk start —
structurally unreachable. The from-start fallback (`?? clusterSeekStartPos` :2260) is
dead code whenever any cache entry ≤ T exists.

**The asymmetry at the heart of it:** the cue path has a "the cue point lied to us"
retry (:2367-2375); the position-cache path has none — yet a cache entry, unlike a cue
point, carries **no keyframe guarantee** (it's just "some cluster starting ≤ T").

**The invariant:** on a cue-less file, `getKeyPacket(T)` succeeds iff the highest cache
entry ≤ T sits at-or-before the cluster containing the last keyframe ≤ T. Linear
playback densely populates the cache, so once the buffer end crosses ≥1 cluster past a
GOP's keyframe cluster, every mid-GOP lookup in the played span violates the invariant —
**permanently** (the persistent MKV Input keeps the cache; retries are deterministic).

**Upstream:** genuine, unreported contract violation (media-sink.ts:224-229 promises
"last key packet ≤ timestamp"). Structure-verified present in upstream `main` (v1.52.2)
via fetched source — upgrading does NOT fix. → **File an upstream issue/PR** (the
correct library fix is mirroring the cue retry for the cache path).

**Why never seen before:** pre-audioskip-fix, cue-less MKVs died at init with the code-4
fatal — this refill path was unreachable for them. The audio fix opened the road; this
is the next pothole on it.

### Sibling bugs (same mechanism, found during research — both TODAY bugs)

- **User seek** to a target in the ≤1-GOP shadow past the iterated frontier (e.g. 28s
  with buffer [0,25], keyframes 20.81/31.2): same null → seek handler (:9319-9323)
  discards, restarts nothing (chain was stopped at :9156; `video.currentTime` already
  moved to 28 at :9075) → **spinner forever, dead player**.
- **Audio track switch** at a mid-GOP playhead ≥12s: rebuild `seekTo(currentTime)` nulls
  the same way → revert branch (:6248-6251) — but the SB was already flushed (:6222) and
  the chain stopped (:6217), and `false` never restarts it → **dead video AND audio**.
- **EOF**: today's EOF detection requires `keyframeTimestamp !== null` (:2808; null even
  RESETS the no-progress counter :2814) → a cue-less file that somehow buffered to the
  end would null-loop at EOF forever — `endOfStream()` unreachable, no replay overlay.

### Not fixed here (out of scope, pre-existing)

- **Cue-less far seeks are slow, not broken**: seek 25→3600s forward-walks and *reads
  every cluster body* in between (~616MB, ~62s @10MB/s; no timeout) before succeeding
  via bestCluster. Pre-existing UX item; candidates later: user-seek ladder or the
  upstream fix.
- Entry-guard blind spot: paused user with ahead ≥ cap (30s) — nulls aren't attempted at
  all (:2673 returns pre-seekTo), so the breaker starts counting only after resume
  drains below cap. Bounded (30s runway at count start). Documented, not fixed.

---

## 2. The fix stack: A (root) + B (belt) + C (suspenders) + guards

Rejected alternatives (full analysis in fixdesign.md): **D** cut-packet
`getNextKeyPacket` resume (gap-stall at the returned NEXT keyframe; clone-identity
footgun — clones throw 'Packet was not created from this track' :2115; fixes only the
refill class), **E** horizon ladder (retry stays null — the walk caches nothing ≤ T;
a ladder hit creates the same gap-stall; N× HTTP), **F** vendored demuxer patch
(upstream-correct but O(file-start→target) re-walk cost over HTTP + vendored-lib
divergence; **goes upstream instead**).

### A — Iteration keyframe harvest (root fix)

Every video packet already flows through `iterateVideoPackets` (:1584-1633). Harvest
key-packet timestamps into the existing partial keyframe index, plus a contiguous
watermark that lets `findNearestKeyframe` trust the index inside fully-iterated spans.
The refill then resolves 20.81 **from memory** → `getKeyPacket(20.81)` lands on the
keyframe's own cached cluster → immediate hit, zero forward walk, zero HTTP (S6 crux,
verified both directions: same cache explains the 25.024 failure AND the 20.81 success).

- **Gate** (hoisted before the loop, :1595):
  `const harvest = this.config.format === 'mkv' && !this.keyframeIndexBuilt && this.mkvCueIndex.length === 0;`
- **Loop body** (:1597-1600 — AFTER the generation/abort check, BEFORE the stop-checks
  at :1614-1618 so the break-triggering packet is also observed, and BEFORE the clone —
  harvest MUST use ORIGINAL `packet.timestamp`, never the rebased clone):
  ```ts
  if (harvest) {
    if (packet.type === 'key') this.addKeyframeTimestamp(packet.timestamp);
    this.noteIterated(packet.timestamp); // watermark, O(1)
  }
  ```
- **Watermark** (2 new fields, `harvestSpanStart/End = -1`): merge rule
  `if (end >= 0 && ts <= end + 0.25) { if (ts > end) end = ts; } else if (ts > end) { start = ts; end = ts; }`
  (else-if guard is dead-but-harmless for negative ts — comment it). Cue-less refill
  windows overlap by construction (next window resolves the PRIOR keyframe behind the
  mid-GOP cut), so the merge branch always runs with negative gap; the 0.25s tolerance
  is belt. Span claims are monotone facts — review's falsification attempts failed;
  worst case is a benign one-GOP overlap re-transmux. Single-span model accepted
  (GOP>12s residue after a far seek degrades to G1/B, disclosed). Reset in dispose().
- **findNearestKeyframe** (:837, one term):
  ```ts
  const inWatermark = this.harvestSpanEnd >= 0
    && seekTime >= this.harvestSpanStart && seekTime <= this.harvestSpanEnd + 0.25;
  if (!this.keyframeIndexBuilt && !inWatermark && seekTime - ts[lo] > 12) return null;
  ```
  Inside a fully-iterated span the nearest indexed keyframe IS the true nearest —
  trusting any distance is sound; GOP>12s cue-less files now work too. Outside: 12s rule
  byte-identical.
- **Dedup redesign** (addKeyframeTimestamp :786): drop the O(n) `ts.some`; after the
  existing binary search, neighbor-check `ts[lo]`/`ts[lo-1]` within 0.01s → skip.
  O(log n) + splice. (Old cost was only per-KEY-packet — insurance, not prerequisite.)
- **Memory**: ≤ duration/GOP floats — 9h @10.4s GOP ≈ 25KB; degenerate all-intra 9h
  ≈ 6.2MB worst conceivable. No cap needed. Zero added HTTP.
- **What A fixes**: refill stall (root), track-switch rebuilds, backward seeks into
  played regions, near-forward-seek shadow nulls, and it un-breaks the EOF machinery
  (keyframeTimestamp non-null again → noProgress×2 → endOfStream). Bonus: the EOF
  estimator (:2801-2806) becomes accurate (true GOP vs sparse seek-gaps) — strictly
  more correct; thumbnails unaffected (no consumer assumes sparseness).
- **What A cannot fix**: seeks into never-iterated regions (slow-but-correct walk,
  §1 out-of-scope), non-H1 null mechanisms → B.

### B — Null-refill circuit breaker (belt) + EOF classification

Pure rule function (exported beside `shouldTriggerZeroAudioReroute`, tested like
MkvFatalReroute.test.ts). **Amended signature** (review Adj 1: split N, dynamic EOF
threshold — the 30s constant is REJECTED, it could truncate up to ~3 GOPs of tail):

```ts
export function classifyNullRefill(
  consecutiveNullRefills: number,  // incl. current failure
  refillPosition: number,
  duration: number,                // state.current.duration (same clock as :2798)
  isMkv: boolean,
  nearEofThresholdS: number,       // caller passes Math.max(estimatedKeyframeInterval, 5)
): 'continue' | 'eof' | 'reroute' {
  if (!isMkv) return 'continue';
  const nearEof = duration > 0 && Number.isFinite(duration)
    && refillPosition >= duration - nearEofThresholdS;
  if (nearEof) return consecutiveNullRefills >= 2 ? 'eof' : 'continue';
  return consecutiveNullRefills >= 5 ? 'reroute' : 'continue';
}
```

- `'eof'` at N≥2 mirrors the shipped indexed-EOF precedent (nearEOF + noProgress≥1 = two
  observations). `estimatedKeyframeInterval` (:2801-2806) is in scope at the null
  branch; post-A it reflects the true GOP in the only scenario that reaches it.
  Unknown/Infinity duration → never 'eof'.
- `'reroute'` at N≥5 → `_recoverMkvToRemuxTier('refill cannot advance (null keyframe)')`
  — ffmpeg reads linearly, cue-less-proof. L7 proved retries are deterministic (frozen
  cache, zero I/O during the loop) — 3,413 retries were arithmetic-guaranteed pointless;
  N=5 is generous.
- **Wiring** (null branch :2900-2904): increment `nullRefillCountRef` (gated
  `formatRef.current === 'mkv'` — N5 hygiene), classify:
  - `'eof'` (checked FIRST): reduced completion — `hasEverCompletedRef.current = true`;
    `ms.endOfStream()` if readyState 'open'; `setIsComplete(true)`;
    `isCompleteRef.current = true`; return (finally's :2941 `!isCompleteRef` gate kills
    the chain cleanly). NO flush (seekBuffer already discarded). Reroute must NOT fire
    near EOF.
  - `'reroute'`: mirror the zero-audio call site (:2771-2777) — gate
    `!mkvRerouteInFlightRef.current`, diagLog, `void recoverMkvRerouteRef.current?.(…)`.
    Double-fire impossible: the reroute latches `mkvRerouteInFlightRef` and bumps the
    chain gen synchronously before its first await (:4658-4672 → :2618), so the finally
    hits the stale-gen return (:2918) — no orphan reschedule. Second recovery this load
    → `remuxRecoveryAttemptedRef` → native tier (shipped semantics).
- Stale-generation safety is structural: the null branch (:2900) is downstream of the
  :2742-2745 early return — a refill from a dead chain can never count.
- **Counter/flag reset sites (canonical 8, review Adj 9):**
  1. `startStreamingChain` :2610-2611 (beside lastRefillKeyframeRef — **load-bearing**;
     covers post-seek :9297, post-switch :6262, replay, StrictMode mount#2)
  2. success commit block :2862
  3. user seek :9158 (beside zeroAudioWindowsRef)
  4. track switch :6218 region
  5. reroute producer-stop :4677
  6. per-file cleanup :2352-2355 (+ **`hasEverCompletedRef.current = false` here — 
     pre-existing latent bug, zero reset sites exist today; becomes load-bearing once
     'eof' writes it**)
  7. unmount cleanup twin :2465-2467
  8. transmuxer init :7109

### C — Null-failure backoff (suspenders)

Flat **1000ms** (review Adj 2 — ladder rejected; its "7.5s" was an arithmetic error
[real: 5.5s vs flat 4s], and L7's determinism makes a fast first retry worthless).
`lastRefillNullRef` set true in the null branch, cleared at the top of the try (before
the entry guards — N4 anchor correction); delay expression swap at :2958 **inside the
existing gen-gated setTimeout** (:2964-2969 — G5 satisfied; comment: do not relocate):

```ts
const delay = lastRefillNullRef.current
  ? 1000
  : (ahead < REFILL_THRESHOLD_SECONDS ? 0 : Math.min(5000, Math.max(2000, Math.floor((ahead - REFILL_THRESHOLD_SECONDS) * 200))));
```

130Hz → ≤1Hz below cap. Known accepted side effect (N2): in the 20-30s-ahead band the
null path now retries at 1000ms vs today's 2000ms — breaker just fires sooner with ≥20s
runway. Cue-indexed/TS refills always resolve → flag never true → delay byte-identical.
Extract as pure `computeRefillChainDelay(lastWasNull, ahead, threshold)` for the
regression-pin test.

**Timelines (flat, N=5/N=2):** stall at prime end (runway ~23s): fire at ~4s — user sees
nothing. Worst case (discovered at ahead 0.1s): waiting-spinner ~0.1s → fire 4s → +2-4s
tier-2 spin-up under the cold/seek overlay ≈ **6-8s total visible**, once, then playback
resumes with audio on tier 2.

### Guards (ship with the stack)

| # | Where | What |
|---|---|---|
| G1 | user-seek null branch :9319-9323 | If `formatRef.current==='mkv' && !mkvRerouteInFlightRef.current`: diagLog + `void recoverMkvRerouteRef.current?.('user seek keyframe unresolvable')`. NO currentTime revert (review traced both variants: they converge on the same reroute — revert just adds 4-5s of spinner), no chain restart, no counting. resumeT = the user's target (captured at :4667) — the reroute lands where they wanted. Non-MKV unchanged. |
| G2 | track-switch null branch :6248-6251 | Map trackId→ffprobe idx FIRST (reuse the :6184-6195 fetch + `mapAudioTrackToRemuxIdx`; extract small helper — **trackId is a Matroska TrackNumber, NOT an ffprobe index**; naive assignment = wrong audio on tier 2 [review Adj 4 spec gap]); `remuxAudioIdxRef.current = mappedIdx ?? null`; then reroute and return its result. Drop the setDesiredAudioTrack(null) revert on this path (transmuxer gets disposed anyway). |
| L1 | 'eof' verdict | Shape per §B — near-EOF check BEFORE mid-file escalation; reduced completion; no flush; no reroute near EOF. |
| L3 | `_recoverMkvToRemuxTier` | **Mandatory, ships with B** (N6): capture `wasPausedAtReroute = (videoRef.current?.paused ?? false) || isPausedRef.current` at the TOP (before :4672 teardown — teardown pauses the element, reading later always yields true); after successful `_recoverToRemuxTier` (:4703): `if (wasPausedAtReroute) try { videoRef.current?.pause(); } catch {}`. Root: the cold plan (<8s) force-plays at :4105 and :4636 only checks the PREFETCH pause ref (verified: isPausedRef written only by pausePrefetch/resumePrefetch :9635/:9674) — 'paused means paused' would break. Do NOT widen :4636 (shared with TS tier). Covers breaker, G1, and G2 reroutes alike. |
| L6 | per-file cleanup | Reset sites 6-7 above + `hasEverCompletedRef` fix. |

### Pause/eviction/replay/watchdog interplay (verified SAFE, no action)

Breaker counts while paused — correct ('paused means paused' governs playback, not
buffer maintenance; the seek-plan reroute preserves pause at :6390/:6641/:6735).
Eviction never touches transmuxer/demuxer state (index describes the FILE, SB the
buffer). Replay reuses the same transmuxer instance → harvested index survives; new
instance only after dispose (which clears it). Zero-audio watchdog and null-breaker are
branch-exclusive per refill (:2763 vs :2900) and share the reroute latch — double-fire
impossible. `contiguousBufferedAhead` clamps all NaN/negative paths to 0. StrictMode
mount#1 residue dies at the gen gates; reset site 1 covers the ref carryover.

---

## 3. Validation design

**Unit (vitest, TDD RED→GREEN per piece):**
- `HarvestedKeyframeIndex.test.ts`: harvests ORIGINAL ts of key packets (fake sink
  async-generator, AudioStartChain pattern); dedup (±0.01s twins, out-of-order inserts
  stay sorted); watermark transitions (merge / disjoint-higher reset / **disjoint-lower
  no-extension = no-over-claim pin** [review Amendment 10]); findNearestKeyframe trusts
  inside watermark at any distance, keeps 12s rule outside; cue-indexed transmuxer never
  harvests (byte-identical index ⇒ EOF-estimator/thumbnail inputs provably unchanged);
  keyframeIndexBuilt disables harvest.
- `NullRefillBreaker.test.ts` (pure): mid-file 1-4 → 'continue', 5+ → 'reroute';
  near-EOF 1 → 'continue', 2 → 'eof'; boundary at `duration − max(gop,5)`; duration
  0/Infinity/NaN → never 'eof'; isMkv=false → 'continue' at 99.
- `RefillBackoff.test.ts` (pure): (true,\*) → 1000; (false,5) → 0; (false,25) → 2000;
  formula values pin today's expression byte-for-byte.
- G1/G2: branch-level tests with mocked refs (MkvFatalReroute pattern) — null → reroute
  called with right reason; G2 maps track idx before reroute; non-MKV untouched.

**Integration fixture (attempt, timeboxed; mock-sink fallback):**
`CuelessMkvFixture.test.ts` — mux a real MKV in-memory with mediabunny's own muxer
(`appendOnly` skips SeekHead :208-210 but finalize() writes trailing Cues
UNCONDITIONALLY :1309-1330 — so **truncate the buffer at the trailing `1C 53 BB 6B`**;
unknown-size segment (size -1 :668) makes the truncated buffer demuxer-walkable
[verified :2271/:2283]). Then: iterate 0→25 (populates the position cache like the
prime) → assert `getKeyPacket(25.024)` → **null** (pins H1 in-tree — if a mediabunny
upgrade ever fixes it, this test fails loud and we can retire A) → harvest during the
same iteration → resolve 20.81 → `getKeyPacket(20.81)` → packet.timestamp ≈ 20.81.

**Gates:** `npx tsc --noEmit` clean · vitest 382 baseline + new suites green ·
`cargo test --no-default-features` 178/178 untouched (no Rust diffs) · then **user
e2e** (`npm run tauri dev`, Inception MKV).

**E2E checklist (user, this file):**
1. Prime unchanged: `extracted 0 cue points`, `fallback getFirstKeyPacket → 0.029s`,
   `audioSkipped=false`, SB [0-25.02], audio plays.
2. First refill: `seekTo: using keyframe index — seekTargetTs=20.810s` +
   `usedIndex=true`; overlap ≈ 4.2s; buffer advances past 37s.
3. Chain marches to 20s-ahead steady state; **zero** `No keyframe found at or before`;
   zero `Streaming refill failed`; no reroute lines; audio SB grows in lockstep.
4. Seek forward +30s (shadow test): lands, no strand. Seek far (e.g. +1h): slow but
   lands (pre-existing slowness).
5. Audio track switch mid-playback: works (no dead player).
6. Pause during playback → stays paused through refills.
7. Let it run to EOF (or seek near end): clean ended + replay overlay, no null-loop.

---

## 4. Implementation order (TDD, one commit per piece)

1. **C** backoff (pure fn + expression swap + flag) — kills the spin even before A/B.
2. **B** breaker + L1 EOF + L3 pause guard + canonical resets (+ hasEverCompletedRef).
3. **A** harvest + watermark + dedup + findNearestKeyframe term.
4. **G1 + G2** seek/track-switch guards (G2 includes the idx-mapping helper).
5. Fixture test (timeboxed) + e2e handoff.

Diff surface: MediabunnyTransmuxer.ts (+2 fields, harvest block, dedup swap, watermark
term, dispose reset) · useMSEPlayer.ts (2 pure exports, 2 refs, null-branch block,
delay swap, 8 reset sites, G1/G2 branches, L3 capture/re-pause) · **no Rust, no
vendored-lib edits, no TS/MP4/remux-tier lines.**

Upstream follow-up (post-ship): file mediabunny issue with the H1 mechanism + minimal
repro; offer the cache-retry patch (mirror :2367-2375 for position-cache walks).

---

## 5. Provenance

| Doc | Role | Verdict |
|---|---|---|
| research/refill-stall-rootcause.md | parent hypothesis (F1-F7, C1-C5, candidates) | facts VERIFIED by review |
| research/refill-stall-verify-h1.md | H1 mechanism + upstream check (Q1-Q6) | VERIFIED (upstream full-diff softened to structure-verified) |
| research/refill-stall-fixdesign.md | candidates A-F analysis + stack spec + tests | VERIFIED with amendments 1,2,4,8 |
| research/refill-stall-edges-lifecycle.md | L1-L10 lifecycle edges | VERIFIED (L4 arithmetic corrected: ladder 5.5s not 7.5s; flat 4s) |
| research/refill-stall-edges-seek.md | S1-S8 seek edges + G1-G5 | VERIFIED (G2 spec gap fixed: trackId≠ffprobe idx) |
| research/refill-stall-review.md | fresh-eyes cross-validation, 10 adjudications, N1-N7 | all 10 amendments applied above |
