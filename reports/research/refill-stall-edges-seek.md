# Cue-less MKV — Seek / Track-switch / Reroute Edge Cases for the Fix Stack (A harvest + B breaker + C backoff)

**Status: VERIFIED AT SOURCE 2026-08-02.** All line refs opened. File under test:
`Inception…mkv` = 1,566,651,347 B / 8888.1 s → avg **176.3 KB/s (1.41 Mbps)**; GOP ≈ 10.4 s;
0 cue points (1-c.md:31). Companion: `refill-stall-rootcause.md`.

Key shared facts used below:
- Prime = seekTo(0, 25) → iterateVideoPackets pumps packets 0→25.02 s. Every cluster the pump
  touches goes through `readCluster` (matroska-demuxer.ts:595) which **inserts a
  clusterPositionCache entry per track per cluster** (:709-723, keyed by that cluster's first
  block timestamp for the track). So after the prime the cache covers **every cluster in
  [0, 25.02]** at cluster granularity (~5 s cadence typical → ~5-13 entries), NOT just keyframes.
- `performClusterLookup` start precedence (:2233-2260): max(cuePoint, positionCacheEntry) —
  cue-less ⇒ position cache alone picks the start; walk is forward-only; breaks when a cluster's
  trackData.startTimestamp > latestTimestamp (:2271-2277); `bestCluster` fallback returns the
  best keyframe found DURING the walk (:2377-2380) — never anything behind the start.
- `findNearestKeyframe` partial-index 12 s rule: MediabunnyTransmuxer.ts:837.
- Harvest insert site today: only successful seekTo (:1454-1457). Fix A adds pump-side inserts.

---

## S1. User seek FORWARD into never-iterated region (25 s → 3600 s)

Path: useMSEPlayer.ts:9011 transmuxer branch → buffered check :9048-9059 (3600 unbuffered) →
`video.currentTime = 3600` for feedback :9075 → executeTransmuxerSeek :9077 →
stopStreamingChain :9156 → `seekTo(3600, SEEK_START_DURATION=8, {stopTime: nextKeyframeAtOrAfter(3608) ?? Infinity})` :9182-9183.

Resolution inside seekTo (:1374-1414): cue index null; `findNearestKeyframe(3600)` → best ≤ is
20.81 (harvested) or 0 (today) — either way gap ≫ 12 s → **null** (:837) → native
`getKeyPacket(3600, {verifyKeyPackets:true})`.

Walk arithmetic: position cache last-≤3600 = the ~24.9x cluster. Walk start there; every
subsequent Cluster element is **fully read** — `readCluster` fetches the whole cluster body
(:629 `requestSlice(dataStartPos, size)`), not just headers. It does NOT break early: clusters
starting at 25.03…3599 are all ≤ 3600, so break only fires past 3600.
- Bytes: 3575 s × 176.3 KB/s ≈ **616 MB** of cluster bodies.
- Requests: ~715 clusters (≈5 s each) → ~715 header slices + ~715 body slices, coalesced by the
  source read-ahead to roughly **80-300 HTTP range fetches**.
- Wall time: ≈ **62 s @ 10 MB/s, ~5 min @ 2 MB/s**. There is **no seek timeout** — the 60 s init
  timeout doesn't apply post-init; the only cap is the *drain* re-arm cap (:9372, 250×120 ms =
  30 s) which merely FORCES a competing seek, and interruptSeek from a newer user seek
  (:9396-9414). Left alone, the walk runs to completion.
- Outcome: match finds keyframes ≤3600 along the way; `bestCluster` returns the last one
  (≈3595 s) → **succeeds, but download-bound slow**. NOT a null.

Where null CAN hit a user seek: target just past bufEnd inside/near the un-walked GOP — e.g.
seek 28 s (buffer [0,25], keyframes 20.81/31.2): today index=[0] → 12s rule null → native walk
start 24.9x, clusters 25.03…31.19 have no keyframe ≤28 in range… next cluster starts 31.2 > 28 →
break → **null**. UI on null (:9319-9323): seekBuffer discarded, transmuxerSeekInProgress
cleared, **no error, no chain restart** (startStreamingChain only in the non-null branch :9297;
chain was stopped at :9156) → video sits at 28 s unbuffered → **spinner forever until the user
seeks again**. Dead player. Same for the exception path :9324-9330 (that one at least setError's).

- TODAY: far-seek slow-succeeds; near-forward seek past bufEnd can null → silent dead stall.
- WITH FIX: harvest makes 25.03-32.8-class targets resolve via 20.81 (≤12 s) — the null window
  closes wherever harvested coverage is ≤12 s behind the target. Far seeks unchanged (slow walk).
  Breaker (B) as spec'd counts REFILL nulls only — it does NOT cover this user-seek null.
- **REQUIRED GUARD (G1)**: user-seek null branch (:9319) must not strand the player. Minimum:
  restart the streaming chain at the old position; better: route through the same
  null-breaker → `_recoverMkvToRemuxTier('user seek cannot resolve keyframe')` immediately
  (a user-seek null is definitionally the pathology — no need to count to 5).

## S2. User seek BACKWARD into evicted region (seek 10 s while buffered [20-45])

Decision tree: buffered instant check :9048-9059 — 10 ∉ [20,45] → NOT instant (if it were still
buffered, instant path moves currentTime and returns; no transmuxer involvement, no counter
effects). → executeTransmuxerSeek → SBs resetForSeek (flush ALL, :9173) → seekTo(10, 8).

Resolution: cue null → `findNearestKeyframe(10)`: rightmost ≤10 in [0, 10.40, 20.81] = **0**
(10.40 > 10 is not eligible); 10−0 = 10 ≤ 12 → **returns 0** (today's index=[0] gives the same).
→ getKeyPacket(0, verify:false): cache lookup ≤0 → cluster 0 → match instant, no HTTP.
Window: stopTime = Infinity (cue-less) → maxDuration = 8 s cutoff (:1614-1618) → transmux
**[0, ~8]**. Landing (:9269-9278): computeSeekLandingTime(10, 0, bufEnd≈8) → target 10 >
bufferedEnd 8 → **lands at ~8 s**, refill chain (:9297) extends 8→10+ within one refill.
Overlap math: re-transmuxes ~10 s already-watched content (~1.8 MB, ~1-3 s work). Acceptable;
SB was flushed so there's no coded-frame-replacement hazard.
- TODAY == WITH-FIX here (both resolve 0). Slightly WRONG-ish (2 s undershoot on landing) but
  self-heals; no guard required. Note: target 14 (gap 14 > 12) → null → native walk from cache
  ≤14 (cluster ~10.4 or ~13.x) → finds 10.40 in-cache → fine. Backward seeks into played
  regions always succeed because the position cache covers them.

## S3. Track-switch rebuild at mid-GOP playhead (cue-less, t=15.7)

Path: `_switchMkvAudioTrack` :6152 → plan in-place → **stopStreamingChain :6217** →
resetForSeek (SB FLUSHED :6222 — rebuild replaces, never appends over; no overlap hazard) →
`seekTo(15.7, 8, {skipInitSegment:false, stopTime: nextKeyframeAtOrAfter(23.7) ?? undefined→Infinity})` :6237-6241.

- WITH harvest: findNearestKeyframe(15.7) → 10.40 (5.3 ≤ 12 ✓) → getKeyPacket(10.40,
  verify:false) → cache lookup ≤10.40 lands on 10.40's own cluster (prime cached it) → match
  immediate. Window [10.40, 18.40] (maxDuration 8). setTimestampOffset(10.40), append, chain
  restart :6262. Playhead untouched (15.7 inside window ✓). Decoder decode-discards 10.40→15.7
  (5.3 s — same class as pre-abutting-era refills). **Covered.**
- TODAY (index=[0]): 15.7−0 > 12 → null → native getKeyPacket(15.7): cache ≤15.7 → mid-GOP
  cluster (~15.6, no keyframe — keyframes 10.40/20.81) → match −1 → next cluster starts >15.7 →
  break → **null** (identical mechanism to the refill bug; confirms rootcause Q5). Handler
  :6248-6251: revert setDesiredAudioTrack, return false. **BUT** the SB was already flushed and
  the chain stopped — the false path never restarts the chain → **frozen video + spinner, dead
  audio AND video** at 15.7. TODAY BUG, worse than "revert".
- **REQUIRED GUARD (G2)**: on rebuild-seekTo null, don't just revert: re-seek/rebuild would null
  again (same walk), so escalate to `_recoverMkvToRemuxTier('audio switch keyframe unresolvable')`
  — and set `remuxAudioIdxRef` from the requested track BEFORE the reroute so the user's chosen
  track survives onto tier 2 (today that ref is only set on the plan==='reroute-remux' branch
  :6196). Harvest makes this near-unreachable (playhead is always inside harvested coverage
  unless GOP > 12 s — see G4 watermark), but the guard is 5 lines and closes it for GOP>12 files.

## S4. Breaker ↔ user-seek races

Reset placement (breaker doesn't exist yet — this is the spec):
- Model: `zeroAudioWindowsRef.current = 0` sits inside executeTransmuxerSeek at :9158, AFTER
  stopStreamingChain :9156 (which bumps streamingChainGenRef :2618 and abortSeek()s the
  transmuxer :2622). **Put `mkvNullRefillsRef.current = 0` on the same line block** (:9158
  region), plus in `_switchMkvAudioTrack` next to :6218, and in `_recoverMkvToRemuxTier`'s
  producer-stop block next to :4677 (mirrors zeroAudio there).
- Stale-count race (seek resets → old refill lands late and increments): CANNOT happen if the
  increment lives where it must anyway — **after** the chain-generation stale check at
  :2742-2745. A refill whose seekTo resolved null after the user seek bumped the chain gen
  early-returns at :2742 and never reaches the counter. (The null branch today is :2900-2904 —
  already downstream of :2742. Put the increment there.) Increment must also be EOF-guarded per
  rootcause B.
- Reverse race (breaker fires → reroute in flight → user seeks during teardown): teardown sets
  `transmuxerRef.current = null` :4681 and `state.current.initialized = false` :4687 (comment
  "also blocks the MKV seek path (R2)"). A seek in that ~1-3 s window: mpegts gate :8643 false
  (player not created yet), transmuxer gate :9011 false → falls through to the MP4/download-loop
  tail of seekTo, which no-ops for MKV (no moov/download loop state) — the seek is **silently
  dropped**; user sees the reroute overlay/recreate and their scrub does nothing. AFTER recovery:
  `needsRemuxSeekRef=true` :4587 + `remuxSeekBaseUrlRef` :4588 → every seek routes via :8643 →
  `shouldUseRemuxSeek` :4848 → `_mpegtsRecreatePlayerForRemuxSeek(ss=T)` → lands correctly on
  the mpegts tier. Verified end-to-end.
- **SOFT GUARD (G3)**: early-return (or queue-latest) in the hook `seekTo` when
  `mkvRerouteInFlightRef.current` — drop-with-log instead of dead fall-through. Cosmetic; the
  drop is currently harmless but undocumented.

## S5. Reroute-resume position on cue-less (playhead ~24.9 s)

Chain verified: `_recoverMkvToRemuxTier` captures `resumeT = video.currentTime` **before** any
teardown (:4667 — src='' zeroes currentTime, comment :4664) → `_recoverToRemuxTier(url, reason,
resumeT, sourceIsTs=false)` :4703 → `planRemuxRecovery` :239-254: 24.9 ≥ 8 ∧ duration ∧
fileLength → `{action:'seek', time:24.9}` → :4595-4599 `_mpegtsRecreatePlayerForRemuxSeek(
clampSeekTime(24.9), dur)` against `remuxUrl = …/remux/...&hevc_ok=…` **with
`withAudioIdx(..., remuxAudioIdxRef.current)`** :4583 → server :3357-3372: no start_byte →
`build_ss_seek_args(24.9)` = `["-ss","24.900"]` placed **BEFORE `-i`** (:2293-2304 — input-side
fast seek; no `-accurate_seek` flag needed, default; decodes from nearest keyframe at/behind).
- Does ffmpeg -ss need cues? **No.** Input-side -ss uses ffmpeg's own matroska demuxer seek: with
  no Cues it linear-skims cluster headers over the seekable HTTP input (the /stream endpoint
  serves 206 ranges; input_source may even be the local cache file when complete :6363-6368).
  Header-skim cost ≪ mediabunny's full-cluster reads; 24.9 s target is trivial (~4.4 MB region).
- `audio_idx` survives: query param validated server-side (`validate_audio_idx_override` :3043,
  falls back to primary if bogus); the SAME url (with audio_idx) is pinned as
  `remuxSeekBaseUrlRef` :4588, so all later seeks keep the track.
- Post-reroute seekability: `remuxSourceIsTsRef=false` :4593 → `computeRemuxSeekStartByte`
  returns undefined (:135-145) → byte-forward never used → **ss-only recreate for every
  unbuffered seek** (D0 holds); in-buffer seeks skip the respawn (E3 check). Fully seekable. ✓
- No guard needed. One note: pause state preserved (:4634-4638 'paused means paused'). ✓

## S6. VBR-anchor + byteOffsetSeek interplay — THE CRUX

Separation first: `keyframeByteOffsets` / byteOffsetSeek is **TS-only** — gated
`config.format === 'ts'` at :1326-1328; MKV never consults it. Harvest writes only
`keyframeTimestamps[]` (:781-800). VBR anchors: `getLastSeekAnchor` (:884-888) pairs
`lastSeekKeyframeTime` (set :1449 from the RESOLVED packet's timestamp) with the cluster byte
the source captured at `markSeekResolved` (:1448) — both come from the SAME successful resolve,
so a harvested-index refill emits a self-consistent (byte, time) anchor. **No mismatch channel
exists.** Float roundtrip is safe: harvested ts = packet.timestamp (raw/timestampFactor);
`intoTimescale` (:2013-2018) multiplies back through `roundIfAlmostInteger` → exact integer
timescale value.

Harvest must store the **pre-clone** timestamp: the pump clones packets with rebased timestamps
(:1605, :1620-1622); insert `packet.timestamp` (source-absolute), never `adjusted.timestamp`.

Now the load-bearing question — does getKeyPacket(20.81) dodge the forward-only walk?
**YES — enumerate the cache:** the prime's pump read every cluster in [0, 25.02] via readCluster,
and readCluster inserts a positionCache entry for EVERY cluster read (:709-723) — not only
keyframe clusters. So entries exist at ≈ 0, ~5, 10.40, ~15.4, 20.81, ~24.9x (cluster cadence;
exact values are each cluster's first video-block ts).
- Lookup for searchTimestamp=20.81: `binarySearchLessOrEqual(cache, 20.81)` → last entry ≤20.81
  = **the entry of the cluster that CONTAINS the 20.81 keyframe** (that cluster's startTimestamp
  ≤ 20.81 by definition — its first block is ≤ the keyframe it contains; the next entry starts
  > 20.81). Walk starts AT that cluster → `getMatchInCluster`: findLastIndex(isKeyFrame ∧
  ts ≤ 20.81) hits the 20.81 keyframe; correctBlockFound = 20.81 < trackData.endTimestamp — true
  always (endTimestamp = lastBlock.ts + duration > 20.81 even if the keyframe is the last block)
  → `fetchPacketInCluster` returns the packet **immediately, zero forward walking, zero HTTP**
  (cluster re-read served from reader cache; readCluster also short-circuits via
  lastReadCluster :596-598).
- Why 25.024 failed with the very same cache (consistency check): last entry ≤ 25.024 = the
  ~24.9x cluster — a MID-GOP cluster whose blocks are all deltas → match −1, correctBlockFound
  false → walk forward: next cluster starts ≥ ~25.03… wait — 25.03 ≤ 25.024? No: the next
  cluster's first block is the first packet past the prime's cut (≥ 25.024009) → startTimestamp
  > latestTimestamp → **break on the first forward step** → bestCluster null → null in 0.4-2 ms
  with no HTTP (header in read-ahead). The 20.81 keyframe sits BEHIND the walk start —
  unreachable. Both observations (F2/F3 null-loop AND the harvest fix working) are explained by
  the same cache with the same arithmetic. **H1 CONFIRMED; harvest design is sound.**
- Residual hazard: `verifyKeyPackets:false` on the usedIndex path (:1409-1410) skips bitstream
  re-typing (media-sink.ts:115-133) — harmless: harvested entries came from packets the demuxer
  itself typed 'key' during a real iteration; they are exactly as trustworthy as seek-resolved
  entries (same provenance as today's :1456 inserts).
- **REQUIRED GUARD (G4)** (from rootcause A(i), re-affirmed here): the 12 s sparse rule caps
  harvest utility — a GOP > 12 s cue-less file still nulls (findNearestKeyframe rejects, native
  walk breaks). Ship the `contiguousHarvestWatermark` (trust any harvested kf ≤ watermark
  regardless of distance); without it the fix silently doesn't cover long-GOP files and the
  breaker reroutes them instead (functional but tier-2, transcode cost).

## S7. Rapid seek spam (5 seeks in 2 s)

Machinery: dispatch `decideSeekDispatch` :590-602 — in-flight ⇒ defer; deferred path interrupts
the in-flight seek (gen bump :9411 + interruptSeek → seekAbortFlag + abortInFlight) and drains
every 120 ms until idle, then executes the LATEST target. Each execute: chain-gen bump (:9156 →
:2618), transmuxer seekGeneration bump (:1268), zeroAudio reset :9158 (+ breaker reset, G-spec
S4). Interleave audit:
- Harvest inserts during aborted seeks: addKeyframeTimestamp runs at :1456 AFTER getKeyPacket
  resolves but BEFORE iteration; an interrupt mid-iteration has already inserted a REAL,
  correctly-typed keyframe — benign (index gains a true entry). An interrupt during getKeyPacket
  (abortInFlight) → null/throw → no insert. Never inserts garbage. ✓
- Counter wedge: breaker increments are downstream of the :2742 chain-gen stale check (S4), so a
  refill from a pre-spam chain can never count into the post-spam chain. Reset is idempotent per
  execute. The BUFFERED instant-seek path (:9048-9059) resets nothing — benign: the chain keeps
  running, refillPosition is recomputed from live currentTime each cycle (:2690), and
  reset-on-success clears any stale count; if the new position ALSO nulls 5×, the reroute is
  correct, not spurious.
- One quirk (pre-existing): each deferred seek writes `video.currentTime = clampedTime` :9075
  immediately, so spam scrubs the playhead visually while only the last target executes —
  unchanged by the fix stack. No guard.
- Backoff (C) interplay: the failure-backoff sleep must be **generation-gated** like every other
  reschedule (`streamingChainGenRef` check in the setTimeout — same pattern as :2952-2954), or a
  slept callback from a pre-seek chain could double-fire a refill into the new chain.
  **GUARD (G5)** — trivial but mandatory.

## S8. getNextKeyPacket(cutPacket) harvest-alternative (evaluate for refill only)

- `packetToClusterLocation` IS a `WeakMap<EncodedPacket, {cluster, blockIndex}>`
  (matroska-demuxer.ts:1898-1901), populated at :2195 for every packet fetched.
- Memory: holding ONE cut packet per refill keeps its map VALUE alive → the value strongly
  references the whole Cluster (all tracks' block data) ≈ one cluster ≈ ≤~2 MB at this bitrate
  (5 s × 176 KB/s + laces). Replaced each refill → previous cluster becomes collectable. Bounded,
  not a leak — but it pins ~1 cluster forever during playback.
- Identity across seekTo: MKV never disposes the Input (`reuseMkvInput` :1289-1293) → same
  MatroskaTrackBacking → same WeakMap. The ORIGINAL packet yielded by `videoSink.packets(...)`
  survives and stays a valid key. The transmuxer's CLONES (:1620) are NOT in the map —
  `getNextKeyPacket(clone)` throws 'Packet was not created from this track.' (:2115-2117),
  matching the audioskip research. So the implementation must retain the raw loop packet, not
  `adjusted` — an easy footgun.
- Correctness for the refill: walk starts AT the cut packet's cluster with search=-∞/latest=∞
  (:2154-2155 — skips cues entirely), scans forward for the next keyframe — reads clusters the
  refill was about to read anyway. Works. But: stateful (invalidate on user seek/track switch/
  file change), fixes ONLY the refill class (not S1-near/S3), and the clone-throw hazard.
  **Verdict: viable but strictly dominated by A(harvest); keep rootcause's "likely reject".**

---

## Summary of required guards

| # | Where | What |
|---|-------|------|
| G1 | useMSEPlayer.ts:9319 null branch | User-seek null must restart chain or (better) immediately `_recoverMkvToRemuxTier` — today it silently strands playback (no chain, spinner forever). |
| G2 | _switchMkvAudioTrack :6248 | Rebuild null → set remuxAudioIdxRef from requested track, then reroute; never bare revert (SB already flushed + chain stopped = dead player today). |
| G3 | hook seekTo entry | Soft: drop/queue seeks while mkvRerouteInFlightRef (today they dead-fall-through silently). |
| G4 | Transmuxer harvest | contiguousHarvestWatermark to bypass the 12 s rule inside fully-iterated spans (GOP>12 s files). |
| G5 | Backoff sleep (C) | Generation-gate the backoff reschedule on streamingChainGenRef (pattern :2952-2954). |
| B-reset | :9158 region, :6218 region, :4677 region | Breaker counter reset co-located with zeroAudioWindowsRef resets; increment placed AFTER the :2742 stale-generation check. |

## Arithmetic quick-reference
- S1 far walk 25→3600 s: ~616 MB full-cluster reads, ~715 clusters, ~80-300 coalesced HTTP
  ranges, 62 s @10 MB/s / ~5 min @2 MB/s; no timeout; succeeds via bestCluster (≈3595 s kf).
- S2 seek 10 s: resolves kf 0 (10−0 ≤ 12), window [0,8], lands at 8 s (computeSeekLandingTime
  clamps to bufferedEnd), refill covers the last 2 s.
- S3 switch at 15.7: harvest resolves 10.40 (5.3 ≤ 12), window [10.40,18.40]; SB flush means
  no overlap-append hazard.
- S6: 20.81 lookup → 20.81's own cluster (cache has EVERY primed cluster) → immediate hit;
  25.024 lookup → 24.9x mid-GOP cluster → −1 → first forward cluster >25.024 → break → null.
  Same cache, both behaviors explained.
