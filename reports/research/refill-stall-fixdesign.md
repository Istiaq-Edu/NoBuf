# Cue-less MKV Refill Stall — Fix-Stack Design

DESIGN (2026-08-02). Inputs: refill-stall-rootcause.md (H1, F1-F7, C1-C5) + line-level
re-verification of MediabunnyTransmuxer.ts, useMSEPlayer.ts, vendored matroska demuxer/muxer.
Verified geometry recap: getKeyPacket(t) = performClusterLookup, walk start = max(cuePoint≤t,
positionCache≤t) (matroska-demuxer.ts:2252-2260), forward-only, breaks when cluster start > t
(:2271-2277). Post-prime, the highest cache entry ≤25.024 is the final mid-GOP cluster
(~24.9x): no video keyframe (match −1), next cluster >25.024 → break → null. The 20.81
keyframe is BEHIND every possible walk start → unreachable by retries. Design is robust to H1
being wrong in detail: A hands getKeyPacket an exact harvested timestamp (no search), B
catches ANY null-return mechanism.

MKV pump-path fact: prime, refills, user seeks, AND track-switch rebuilds ALL run through
seekTo → iterateVideoPackets (:1584-1633). produceSegmentsFromInitInput (:917 → :965) and
sequentialContinue (:996) are TS-only (startTransmuxing gates :1155/:1181). F2 confirms.

## Candidate A — iteration keyframe harvest (ROOT FIX — chosen)
Mechanism: every video packet flying through iterateVideoPackets is inspected pre-clone; key
packets' ORIGINAL timestamps go into keyframeTimestamps via addKeyframeTimestamp. A contiguous
watermark records the span fully iterated so findNearestKeyframe can trust the partial index
inside it (bypassing the 12s sparse rule). Refill lookup then resolves 20.81 from memory →
getKeyPacket(20.81, verify:false) walks a cluster AT/BEFORE the keyframe → found.

Insertion points (exact):
1. MediabunnyTransmuxer.ts:1595 (iterateVideoPackets, before the for-await): hoist gate
   `const harvest = this.config.format === 'mkv' && !this.keyframeIndexBuilt && this.mkvCueIndex.length === 0;`
2. :1597-1600 loop body, AFTER the generation/abort check, BEFORE adjustedTimestamp (:1605) and
   BEFORE the stop-checks (:1614-1618) so the break-triggering packet is also observed:
   ```ts
   if (harvest) {
     if (packet.type === 'key') this.addKeyframeTimestamp(packet.timestamp); // ORIGINAL ts
     this.noteIterated(packet.timestamp); // watermark merge, O(1)
   }
   ```
   ORIGINAL-vs-adjusted: `packet.timestamp` is absolute file time; the clone at :1620-1622
   carries `adjustedTimestamp = packet.timestamp − keyframeTimestamp` for muxing only. Harvest
   MUST read the pre-clone packet (it does — clone happens after). packet.type==='key' is
   mediabunny's isKeyFrame surface (same field the demuxer sets).
3. produceSegmentsFromInitInput / sequentialContinue: NO edits. The former delegates to
   iterateVideoPackets (:965) where the format gate makes harvest inert for TS; the latter is
   TS-only inline loops. Zero diff = trivially provable TS-tier untouched.
4. seekTo :1454-1457 unchanged (still adds the resolved keyframe; dedup absorbs the duplicate).

contiguousWatermark design:
- Fields (next to keyframeTimestamps decl): `private harvestSpanStart = -1; private harvestSpanEnd = -1;`
- Update rule (noteIterated(ts), inlined or tiny private method):
  `if (this.harvestSpanEnd >= 0 && ts <= this.harvestSpanEnd + 0.25) { if (ts > this.harvestSpanEnd) this.harvestSpanEnd = ts; } else if (ts > this.harvestSpanEnd) { this.harvestSpanStart = ts; this.harvestSpanEnd = ts; }`
  Semantics: one span [start,end] such that EVERY packet in it has been iterated ⇒ every
  keyframe ≤ end within the span is in the index. Merge tolerance 0.25s (matches
  snapToCueKeyframe precedent; abutting windows gap ≤ 1 frame ≈ 0.042s at 24fps; a refill
  overlap window starts INSIDE the span so it merges by definition). A disjoint HIGHER window
  (far user seek) resets the span to the new region (single-span model — the only consumer is
  the refill, which always queries the current playback span). A disjoint LOWER window
  (backward seek to virgin region) takes the merge branch harmlessly (ts < end → no extension;
  its keyframes still enter the index and the 12s rule covers local queries). Conservative
  by construction: the span can under-claim, never over-claim; the sub-0.25s merge sliver
  cannot hide an unharvested keyframe that breaks correctness — worst case findNearestKeyframe
  returns the previous keyframe → one-GOP overlap re-transmux (shipped pre-abutting behavior).
- Reset sites: dispose() (:1874-1895) add `harvestSpanStart = harvestSpanEnd = -1`. No reset on
  user seek needed — the rule self-resets on the first disjoint-higher window.
- findNearestKeyframe change (:837 only):
  ```ts
  const inWatermark = this.harvestSpanEnd >= 0
    && seekTime >= this.harvestSpanStart && seekTime <= this.harvestSpanEnd + 0.25;
  if (!this.keyframeIndexBuilt && !inWatermark && seekTime - ts[lo] > 12) return null;
  ```
  Soundness: if seekTime ∈ span, the span's first window keyframe (≤ seekTime, harvested as the
  window's first packet) bounds ts[lo] from below inside the span ⇒ ts[lo] is the TRUE nearest
  keyframe ⇒ trusting it at any distance is correct. GOP>12s cue-less files now survive.
  Outside the watermark the 12s rule is byte-identical.

Dedup redesign (addKeyframeTimestamp :781-800): delete the O(n) `ts.some` (:786); keep the
existing binary search (:789-797); insert-if-absent via neighbor check:
```ts
// after binary search yields lo:
if ((lo < ts.length && Math.abs(ts[lo] - timestamp) < 0.01)
 || (lo > 0 && Math.abs(ts[lo - 1] - timestamp) < 0.01)) return;
ts.splice(lo, 0, timestamp);
```
O(log n) compare + O(n) splice memmove (forward-iteration appends hit lo===length → no move).
Cost at 24fps × 9000s (9h): 216k packets pay 1 type-compare each; ~3,115 keyframes (GOP 10.4s)
pay the insert. OLD some(): Σn ≈ 3,115²/2 ≈ 4.9M float compares over the file (only per KEY
packet — the scary 216k×3,115 ≈ 673M only occurs if someone harvests per-packet; design
forbids). NEW: 3,115 × log2 ≈ 36k. Redesign is insurance, not a prerequisite.

Memory bound: floats = keyframes inside iterated spans ≤ duration/GOP. 9h @10.4s GOP ≈ 3,115 ×
8B ≈ 25 KB; pathological 1s GOP 9h = 32,400 × 8B = 259 KB; degenerate all-intra 24fps 9h =
778k × 8B ≈ 6.2 MB worst conceivable — still fine, no cap needed. Watermark: 2 floats. HTTP
reads: ZERO added (harvest observes packets already being read).

Failure classes: FIXES refill stall (root), track-switch rebuild (playhead is always inside the
buffered=iterated span → indexed), backward seek into played regions, and un-bypasses the EOF
machinery (C5: keyframeTimestamp becomes non-null again → noProgress×2 → endOfStream works).
LEAVES: user seek into never-iterated regions (see §5), any non-H1 null mechanism (B covers).

Risk / regression proof:
- Cue-INDEXED files: seekTo consults nearestCueKeyframeAtOrBefore FIRST (:1374-1387); non-empty
  cue index ⇒ cachedKeyframeTs !== null ⇒ the `if (cachedKeyframeTs === null)` gate (:1388-1390)
  never reaches findNearestKeyframe ⇒ usedIndex path unchanged. Harvest itself is gated on
  `mkvCueIndex.length === 0` ⇒ keyframeTimestamps content is byte-identical for cue-indexed
  files ⇒ the EOF interval estimator (useMSEPlayer :2799-2806, reads getKeyframeTimestamps) and
  thumbnail consumers are provably unchanged. Abutting refills (stopTime from cue index) touched
  nowhere.
- 12s sparse rule: unchanged outside watermark (term is additive-permissive only inside spans).
- keyframeIndexBuilt: harvest gate + addKeyframeTimestamp:782 both no-op when the full scan
  finished; MKV playback never calls buildKeyframeIndex today (only TS :1170) so the gate is
  belt only.
- 0.029s audio fallback: audio path (resolveAudioStartPacket :1652-1667) untouched; audio
  getKeyPacket(20.81) succeeds anyway (every audio block is key ⇒ the matched cluster always
  yields a block ≤ t — the mid-GOP-no-keyframe geometry cannot occur for audio).
- Perf: 1-2 compares per video packet inside an already-async demux loop — unmeasurable.

Testability: high — addKeyframeTimestamp/findNearestKeyframe are methods on a constructible
transmuxer (snapToCueKeyframe.test.ts pattern); iterateVideoPackets drivable with a fake sink
whose packets() is an async generator (AudioStartChain.test.ts mock-sink pattern).

## Candidate B — null-refill circuit breaker → Layer-3 reroute (BELT — chosen)

Mechanism: count consecutive refill attempts that end in the :2900-2904 null branch; classify
at each failure; at N=5 mid-file → _recoverMkvToRemuxTier('refill cannot advance (null
keyframe)') — ffmpeg reads linearly, cue-less-proof (F1-proven tier). Near EOF → endOfStream.

Pure rule (exported next to shouldTriggerZeroAudioReroute, useMSEPlayer.ts:617-630 pattern):
```ts
export function classifyNullRefill(
  consecutiveNullRefills: number,   // incl. the current failure
  refillPosition: number,           // the position this refill targeted
  duration: number,                 // state.current.duration — see below
  isMkv: boolean,
  nearEofThresholdS = 30,
): 'continue' | 'eof' | 'reroute' {
  if (!isMkv || consecutiveNullRefills < 5) return 'continue';
  const nearEof = duration > 0 && Number.isFinite(duration)
    && refillPosition >= duration - nearEofThresholdS;
  return nearEof ? 'eof' : 'reroute';
}
```
- N=5 why: 1 tolerates nothing (a single transient null during a track-switch/Input race would
  nuke a healthy pipeline); 3 mirrors zero-audio but those are full windows (seconds each) —
  null refills are ms-cheap, so a bit more evidence is free; with C's 1s backoff, 5 ⇒ stall→
  reroute ≈ 4-5s, well inside the ~20s buffered runway (REFILL_THRESHOLD_SECONDS=20, :2567) ⇒
  the user never sees a visible stall before the reroute lands. >5 buys nothing.
- EOF-vs-mid-file: duration ref = `state.current.duration` — the SAME ref the adjacent EOF
  machinery (:2798) and nearEofHole guard (:2760-2762) already use (NOT video.duration, which
  can be Infinity early; NOT transmuxer.getDuration(), to keep one clock). Threshold 30s reuses
  nearEofHole's constant. Unknown/Infinity duration ⇒ nearEof undecidable ⇒ 'reroute' (ffmpeg
  tier handles true EOF gracefully; endOfStream on a guess would kill mid-file playback).
- Wiring: new `nullRefillCountRef = useRef(0)` beside lastRefillKeyframeRef (~:2600s). In the
  null branch (:2900-2904): increment, classify; 'eof' → hasEverCompletedRef=true,
  ms.endOfStream() (guarded readyState==='open'), setIsComplete(true), isCompleteRef=true,
  refillInProgressRef=false, return (isCompleteRef gates chain-continue :2941 — chain dies
  cleanly; no segment flush needed, seekBuffer was just discarded); 'reroute' → mirror the
  zero-audio call site (:2771-2777): gate `!mkvRerouteInFlightRef.current`, diagLog, `void
  recoverMkvRerouteRef.current?.(…)`, refillInProgressRef=false, return.
- Counter resets: (a) success — in the `keyframeTimestamp !== null` commit block (:2862) set 0;
  (b) user seek — beside zeroAudioWindowsRef reset (:9158); (c) track switch — where
  _switchMkvAudioTrack resets refill state (:6152+, beside its chain restart); (d) file change /
  transmuxer init — beside :7109 (`zeroAudioWindowsRef.current = 0`); (e) inside the 'reroute'
  branch before firing (hygiene; pipeline is torn down anyway).
- One-shot interplay: _recoverMkvToRemuxTier's R1 latch (mkvRerouteInFlightRef, :4658) makes
  concurrent triggers (breaker + zero-audio + SB-fatal) collapse to one reroute; the shared
  _recoverToRemuxTier one-shot (remuxRecoveryAttemptedRef :4550/:4567) means a second recovery
  this load → false → native last resort — identical to the shipped zero-audio semantics, no
  new states introduced.
- Paused means paused: inherited, not re-implemented — reroute seek path goes through
  _mpegtsRecreatePlayerForRemuxSeek (pause preservation built in, :4595-4600), cold path pauses
  explicitly (:4634-4638). Breaker adds no play() calls.

Fixes: refill stall (as failsafe, ~5s latency), EOF null-loop (the 'eof' verdict — today
null-EOF bypasses every detector, C5), ANY unknown null mechanism. Leaves: user-seek nulls
(different code path — but see §5: post-A that geometry is gone), slow-but-successful far
seeks. Cost: one ref, one pure call per FAILED refill only — zero on healthy paths. Risk:
premature reroute on a transient — bounded by N=5 + resets; cue-indexed files never enter the
null branch in practice and the mkv+N gate keeps even a freak single null harmless.
Testability: perfect — pure function, MkvFatalReroute.test.ts pattern.

## Candidate C — failure backoff (SUSPENDERS — chosen)

Mechanism: a failed (null) refill must not rechain at 0ms. New ref `lastRefillNullRef`
(useRef(false)): set false at top of try (:2643, after the early-return guards), set true in
the :2900 null branch. In the finally chain-continue (:2958), replace the delay expression:
```ts
const delay = lastRefillNullRef.current
  ? 1000
  : (ahead < REFILL_THRESHOLD_SECONDS ? 0 : Math.min(5000, Math.max(2000, Math.floor((ahead - REFILL_THRESHOLD_SECONDS) * 200))));
```
Value 1000ms: kills the 130Hz spin (→1Hz), makes B's window 4-5s, still fast enough that a
recoverable hiccup resumes invisibly inside the 20s runway. Cannot starve legitimate immediate
rechains: the flag is true ONLY when keyframeTimestamp===null — cue-indexed refills always
resolve (usedIndex fast path) ⇒ flag stays false ⇒ delay formula byte-identical; a cue-less
SUCCESS (post-A) also resets the flag at the next attempt's top-of-try ⇒ healthy low-buffer
chains keep delay=0. Fixes: spin only (no advancement). Cost/risk: nil. Testability: extract
`computeRefillChainDelay(lastWasNull, ahead, threshold)` as an exported pure fn and have the
finally block call it (surgical: expression swap), test like decideSeekDispatch.

## Candidate D — cut-packet retention + getNextKeyPacket resume (REJECTED)

Mechanism would be: retain the ORIGINAL (pre-clone) packet that triggered the maxDuration break
in iterateVideoPackets; next refill calls videoSink.getNextKeyPacket(cutPacket) to resume.
Rejections, each independently fatal:
1. GAP: getNextKeyPacket returns the keyframe AFTER the cut (e.g. 31.2s), but the SB is buffered
   to 25.02 — a discontinuity-mode window starting at 31.2 leaves [25.02,31.2) unbuffered ⇒
   playback stalls at 25.02 anyway. Making it gapless requires continuation-mode muxing (resume
   P-frames into the prior fragment run) — the exact architecture the codebase deliberately
   abandoned (:2678-2688 discontinuity-mode rationale). Not a surgical diff; a re-architecture.
2. Identity: packetToClusterLocation is keyed by the exact EncodedPacket object
   (matroska-demuxer.ts:2115 throws 'Packet was not created from this track'); clones don't
   qualify, so we must pin the original packet (data buffer included) across windows, valid only
   while reuseMkvInput holds and invalidated by user seek/track switch/file change — stateful
   and fragile against the same internals H1 lives in.
3. Class coverage: does nothing for track-switch rebuilds, backward seeks, user seeks — A fixes
   those for free. Strictly dominated by A on every axis except theoretical exactness.

## Candidate E — horizon ladder getKeyPacket(pos+15/+30/+60) (REJECTED)

Mechanism: on null, retry with escalating targets. Proof it cannot work: (i) retrying the
ORIGINAL target after a ladder walk stays null — the forward walk from ~24.9x caches clusters
ABOVE 25.02 only; the walk start for a repeat getKeyPacket(25.024) is still the same mid-GOP
shadow entry; nothing ≤25.024 was added. (ii) A ladder HIT returns a keyframe > bufEnd (e.g.
getKeyPacket(40) → 31.2) ⇒ same GAP stall as D-1. (iii) N× walk restarts re-read cluster
headers over HTTP that plain iteration reads once. (iv) Fixes neither track-switch nor
backward-seek classes. Magic numbers on top. Reject.

## Candidate F (invented) — vendored-demuxer walk-start fallback (REJECTED, file upstream)

Patch matroska-demuxer.ts:2252-2260: when the position-cache walk ends matchless and the track
has zero cuePoints, restart from segment.clusterSeekStartPos. Fixes the ≤-contract at the true
source — but re-walk cost is O(bytes file-start→target) per failing lookup (GBs over HTTP at
t=5000s), it diverges the vendored lib (update-clobber risk; constraint is surgical APP diffs),
and cue-indexed guarantees would rest on library internals instead of our gated code. A gets
the same resolution from bytes ALREADY read, in-app, O(log n). Keep: file upstream (Q4) —
null-while-prior-keyframe-exists is a library contract bug regardless.

## THE STACK: A (root) + B (belt) + C (suspenders)

Why this beats alternatives: A alone resolves the stall with ZERO extra I/O and also fixes the
sibling classes (track-switch, backward seek, EOF-detector bypass); D/E fail the gap analysis
outright, F fails cost+divergence. A alone isn't shippable — it presumes "keyframe was seen
during iteration"; B converts any residual/unknown null mechanism into the proven ffmpeg tier
instead of an infinite silent loop, and adds the missing EOF-null terminal state. C is two
lines turning 130Hz grind into calm 1Hz while B accumulates evidence. Each lands as its own
commit+tests; B+C stay useful even if A were reverted.

## Validation design

Unit tests (vitest, jsdom; all follow existing patterns — constructor from
snapToCueKeyframe.test.ts / AudioStartChain.test.ts, pure fns from MkvFatalReroute.test.ts):

HarvestedKeyframeIndex.test.ts (new)
1. 'harvests ORIGINAL timestamps of key packets during iteration' — arrange: transmuxer (mkv,
   empty mkvCueIndex), fake videoSink `{ packets: async function*(){ yield {timestamp:10.4,
   type:'key', clone(){return this}}, … } }`, fake source `{ add: vi.fn(), close(){} }`; act:
   `(t as any).iterateVideoPackets(sink, firstKey, src, meta, /*kf*/10.4, t.seekGeneration,
   17, false)`; assert getKeyframeTimestamps() contains 10.4 AND 20.81 (absolute, NOT 0/10.41
   adjusted).
2. 'dedup: re-iteration and ±0.01s twins insert nothing' — call addKeyframeTimestamp twice with
   20.81/20.815; assert length 1; assert sortedness after out-of-order inserts.
3. 'watermark merges abutting windows, resets on disjoint-higher, ignores disjoint-lower' —
   drive noteIterated sequences; assert (spanStart, spanEnd) transitions per §A rule.
4. 'findNearestKeyframe trusts any distance inside watermark, keeps 12s rule outside' —
   arrange index [0, 15, 30], span [0,41]; assert query 41 → 30 (11s ok), then widen: index
   [0,20], span [0,45], query 45 → 20 (25s gap, inside span → trusted); same query with span
   reset → null.
5. 'cue-indexed transmuxer never harvests' — set (t as any).mkvCueIndex = [{time:0,…}]; iterate;
   assert getKeyframeTimestamps() unchanged ⇒ usedIndex/EOF-estimator inputs provably identical.
6. 'keyframeIndexBuilt disables harvest and insertion' — flag true; iterate; unchanged.

NullRefillBreaker.test.ts (new, pure)
- 1-4 nulls → 'continue' (mkv, mid-file); 5 & 6 → 'reroute'.
- pos ≥ dur−30 at 5 → 'eof'; pos = dur−31 → 'reroute' (boundary).
- duration 0 / Infinity / NaN → 'reroute' never 'eof'.
- isMkv=false → 'continue' at 99.

RefillBackoff.test.ts (new, pure) — computeRefillChainDelay:
- (true, any, 20) → 1000; (false, 5, 20) → 0; (false, 25, 20) → 2000..5000 formula values
  byte-match the current expression (regression pin).

Fixture question (V3) — checked matroska-muxer.ts: `appendOnly` skips the SeekHead (:208-212)
and back-patching (:1332+), BUT finalize() still writes a trailing Cues element unconditionally
(assert(this.cues); writeEBML(this.cues)). So the muxed file is only cue-less if the demuxer
can't DISCOVER trailing Cues without a SeekHead pointer — likely, and exactly how real streamed
files get 0 cues. Integration sketch (CuelessMkvFixture.test.ts, sequential/slow):
1. Build: `new Output({ format: new MkvOutputFormat({ appendOnly: true }), target: new
   BufferTarget() })`; addVideoTrack(EncodedVideoPacketSource('vp8')); feed ~60 synthetic
   EncodedPackets (fabricated payload bytes; keyframes every 10.4s at 0/10.4/20.81/31.2, deltas
   between; muxer copies bytes, never parses the bitstream); finalize.
2. De-cue hard guarantee: scan the output Uint8Array from the END for the top-level Cues ID
   `1C 53 BB 6B` and truncate there (streaming MKVs are legally truncatable; unknown-size
   segment tolerates it). This makes the fixture cue-less REGARDLESS of demuxer discovery
   behavior.
3. Repro assert (old path): `Input({source new BufferSource(bytes), formats:[MATROSKA]})`;
   iterate packets 0→25 via sink.packets() (populates the position cache like the prime); then
   `getKeyPacket(25.024, {verifyKeyPackets:false})` → expect null (pins H1 in-tree; if
   mediabunny is later upgraded and this returns 20.81, the test FAILS LOUD → we can retire A).
4. Recovery assert (new path): harvest timestamps during step-3 iteration into a transmuxer
   index (or plain array + findNearestKeyframe logic) → resolve 20.81 → `getKeyPacket(20.81,
   {verifyKeyPackets:false})` → expect packet.timestamp ≈ 20.81.
Fallback if the muxer path fights back (codec registration / metadata validation in node):
mock-sink harness — same asserts against a scripted EncodedPacketSink whose getKeyPacket
returns null for t∈(20.81+ε, 31.2) and the packet for t=20.81, driven through the REAL seekTo
via `as any` (AudioStartChain pattern). Unit value is lower (mechanism mocked) but still pins
OUR resolution order (index-before-native, usedIndex=true).

E2E checklist (user runs `npm run tauri dev`, THIS Inception MKV):
- Prime unchanged: `extracted 0 cue points`; `fallback getFirstKeyPacket → 0.029s`;
  `audioSkipped=false`; SB [0-25.02]. After prime: index holds ≥3 harvested kfs (0, 10.40,
  20.81) — keyframeIndexReady flips true; add a one-line diagLog of harvest count at window close.
- First refill: `[Transmuxer] seekTo: using keyframe index — seekTargetTs=20.810s,
  seekTime=25.02s` and `… usedIndex=true, byteOffsetSeek=false`; `[Transmuxer] Seek to
  25.024…s: keyframe at 20.81…s`; `[MSE] Discontinuity refill: keyframe=20.81s` — overlap
  25.024−20.81 ≈ 4.2s re-append then net growth to ~37.8s (maxDuration 17 window).
- Chain advances: subsequent refills at ~37.8 → usedIndex=true keyframe≈31.2, buffer marches to
  the 20s-ahead steady state with 2000-5000ms sleeps.
- ZERO occurrences of `No keyframe found at or before`; zero `Streaming refill failed`; no
  `ZERO audio packets` lines; no reroute lines; audio SB ranges grow in lockstep.
- Pause test: pause mid-refill → remains paused through refills (and through a forced reroute
  if B is exercised via a doctored build).
- EOF test (long soak or seek near end): clean `endOfStream called at EOF`, no null-loop.
- Gates: `npx tsc --noEmit` clean; vitest 382 baseline + new suites green; cargo 178/178
  untouched (no Rust diffs in this stack).

## §5 Explicit coverage answer (harvest vs never-iterated regions)

Does A cover user seeks into never-iterated cue-less regions? NO — harvest only knows demuxed
packets: jump 25s→2000s → findNearestKeyframe(2000) → 20.81 is >12s away AND outside watermark
→ null → native getKeyPacket(2000). That walk (from :2233-2277 mechanics) starts at the prime
frontier (~24.9x) and reads every cluster header 25s→2000s over HTTP. It does NOT fail
identically — it terminates CORRECTLY (break needs cluster.start > 2000; hundreds of keyframes
≤2000 update bestCluster first → true last kf ≤2000 returned) but costs O(distance): a
minutes-slow far seek. Exactly today's pre-fix cue-less user-seek behavior — A neither fixes
nor regresses it. The only NULL geometry is a target in the ≤1-GOP shadow above an iterated
frontier — post-A every frontier is index-covered, so user seeks can't reach the null geometry
through seekTo's index-first order. Backward seeks into virgin holes: walk start = highest
cache entry ≤ target (lower span tail or file start) → forward walk O(hole) → correct.
Does B+reroute cover what A leaves? Refill-side residue yes: any null, any mechanism → count →
reroute/EOF. User-seek residue is SLOWNESS not null — B (refill counter) correctly silent;
slow cue-less far seeks stay a pre-existing out-of-scope UX item (later: user-seek-path ladder
or upstream F). No silent stall remains: refill nulls → B; user-seek nulls → geometry removed
by A; EOF nulls → B 'eof'; unknown → B reroute.

## Diff surface summary (for the plan writer)

MediabunnyTransmuxer.ts: +2 fields; +harvest gate & 4-line loop block (iterateVideoPackets
:1595/:1600); addKeyframeTimestamp dedup swap (:786); findNearestKeyframe watermark term
(:837); dispose reset (:1878 region). useMSEPlayer.ts: +classifyNullRefill +
computeRefillChainDelay pure exports (~:630); +nullRefillCountRef +lastRefillNullRef; null
branch (:2900-2904) breaker block; success reset (:2862); delay expression swap (:2958);
resets at :9158 / :7109 / track-switch. No Rust, no vendored-lib, no TS/MP4/remux-tier lines.
Tests: 3 new unit files + 1 integration fixture (stretch). TDD order: fixture/unit repro RED →
A → green; breaker tests RED → B; backoff pin RED → C.
