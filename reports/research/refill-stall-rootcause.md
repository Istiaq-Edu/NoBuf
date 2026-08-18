# MKV Cue-less Refill Stall — Root-Cause Assessment (parent agent, pre-research)

**Status: HYPOTHESIS DOC.** Claims are labeled VERIFIED (opened at source, file:line) or
HYPOTHESIS (needs subagent verification). Written 2026-08-02 after line-level analysis of
test logs `1-c.md` (463k lines, deduped) + `1-t.md` (180 lines, read fully).

## Observed facts (log-arithmetic, VERIFIED)

- F1. Audio fix works: `fallback getFirstKeyPacket → 0.029s` at init-probe AND prime
  (1-c.md:34,46); 2-codec SB created; `audioSkipped=false` (1-c.md:52); primed
  [0–25.02s]; played. Zero CHUNK_DEMUXER / code-4 / useNative in 463k lines.
- F2. Stall: 3,414 seekTo calls = 1 prime + 3,413 refill failures, ALL
  `No keyframe found at or before 25.024009s` (single unique target — `sort -u` = 1).
- F3. Each failure: 0.4–2ms, `usedIndex=false, byteOffsetSeek=false`, and ZERO
  `[STREAM-REQ]` rows in 1-t.md during the failure window (12:25:19→12:25:50 shows only
  warmer traffic) ⇒ every lookup served entirely from memory, no cluster fetched.
- F4. Fragment boundaries during prime: SB appends [0-10.40], [0-20.81], [0-24.99]
  (1-c.md:56-58) ⇒ video keyframes at ≈0, 10.40, 20.81 ⇒ GOP ≈ 10.4s ⇒ **a keyframe at
  20.81 ≤ 25.024 EXISTS and its cluster was read during the prime**. getKeyPacket
  violated its ≤-contract from the caller's perspective.
- F5. `MKV cue index: extracted 0 cue points` (1-c.md:31) — file has no Cues at all
  (not even borrowable; matroska-demuxer.ts:587-588 borrows the biggest track's cues
  into cue-less tracks, so 0 ⇒ segment-wide 0).
- F6. Loop rate ≈ 130 Hz (3,413 failures / ~26s). Backoff exists only on the
  buffer-sufficient path (2000ms sleeps at 25.0/23.5/21.5s ahead — 1-c.md:79,102,122);
  once ahead < 20s: `chaining next refill immediately` every time.
- F7. Layer-3 never fired — correctly per its own gates (no SB fatal, no video error,
  wasLastWindowAudioStarved requires a COMPLETED window; the null-return aborts before
  any window runs). This failure class has NO counter today.

## Code-path facts (VERIFIED at source 2026-08-02)

- C1. Refill computes `refillPosition = snapToCueKeyframe(currentTime + ahead)` — no-op
  without cue index (useMSEPlayer.ts:2702, MediabunnyTransmuxer.ts:285-…).
  `stopTime = nextKeyframeAtOrAfter(...) ?? Infinity` — Infinity without cue index
  (useMSEPlayer.ts:2717, transmuxer :240). `maxDuration = min(5+12, 25) = 17`
  (useMSEPlayer.ts:2706). So cue-less refills cut at maxDuration mid-GOP.
- C2. seekTo resolves the video start via `findNearestKeyframe(seekTime)` (partial
  index; 12s sparse-distance rule at transmuxer :837 correctly rejects [0] for 25.02)
  then falls back to native `videoSink.getKeyPacket(seekTime, {verifyKeyPackets:false})`;
  null ⇒ `console.warn('No keyframe found…'); return null` (:1433-1438). Caller treats
  null as failure: discards seekBuffer, `console.warn('Streaming refill failed')`
  (useMSEPlayer.ts:2900-2904), finally-block reschedules (:2914+).
- C3. The ONLY writer of the partial keyframe index during playback is
  `addKeyframeTimestamp(keyframeTimestamp)` in seekTo itself (:1454-1457) — one entry
  per SUCCESSFUL seek. **The iteration pump (iterateVideoPackets) sees every keyframe
  packet fly by and harvests NOTHING.** After the prime the index is `[0]`.
- C4. mediabunny `getKeyPacket` → `performClusterLookup(null, match, t, t, opts)`
  (matroska-demuxer.ts:2087-2112). Walk start:
  `max(cuePoint?.clusterPosition ?? 0, positionCacheEntry?.elementStartPos ?? 0) || null
   ?? segment.clusterSeekStartPos` (:2233-2260). Walk is FORWARD-ONLY and breaks when
  `trackData.startTimestamp > latestTimestamp` (:2271-2277).
- C5. EOF machinery (noProgress×2, nearEOF) and my new zero-audio watchdog are all gated
  on `keyframeTimestamp !== null` (useMSEPlayer.ts:2750+ region) ⇒ null-keyframe
  refills bypass EVERY terminal detector. This includes EOF: a cue-less file that
  somehow buffered to duration-end would ALSO null-loop forever at EOF (no cues ⇒
  getKeyPacket(duration) has the same failure surface).

## Root-cause hypothesis (H1 — for verification)

getKeyPacket(25.024)'s forward-only walk does not start at the segment's first cluster;
it starts at the highest `clusterPositionCache` entry with startTimestamp ≤ 25.024.
After the prime read clusters covering [0, 25.02], that cache points INSIDE the final
GOP (cluster starting ~24.9x < 25.024, past the 20.81 keyframe's cluster). That cluster
contains no keyframe (mid-GOP), match returns -1; the next cluster starts > 25.024 ⇒
immediate break ⇒ null. The 20.81 keyframe lies BEHIND the walk start and is
unreachable by a forward-only walk. This explains F3's 0.5-2ms/no-HTTP fingerprint
(cache-adjacent cluster headers are in the read-ahead buffer) and F4's contract
violation.

OPEN QUESTIONS for the verifier (must be pinned at mediabunny source, vendored at
app/node_modules/mediabunny/src/matroska/matroska-demuxer.ts):
- Q1. Where exactly are clusterPositionCache entries inserted, and what do they contain
  after a linear iteration 0→25s? (grep insertion sites; simulate walk arithmetic.)
- Q2. Why does the walk not fall back to `segment.clusterSeekStartPos` when the
  position-cache start yields nothing? (Read :2252-2260 precedence exactly.)
- Q3. Confirm `getMatchInCluster` for the video track in a mid-GOP cluster returns
  {-1,false} (`findLastIndex(...isKeyFrame && ts<=t)` :2098-2104).
- Q4. Is this an upstream mediabunny bug (getKeyPacket contract) or intended
  ("position cache is an optimization that assumes cues exist")? Check upstream repo
  issues/changelog for cue-less fixes in versions > vendored 1.45.4 (check installed
  version in node_modules/mediabunny/package.json).
- Q5. Track-switch path: `_switchMkvAudioTrack` rebuild does its own
  seekTo(currentTime) — does the same null failure hit mid-GOP playheads on cue-less
  files? (Arithmetic: playhead 15s, position cache ≤15 …)
- Q6. Confirm the prime DID populate the position cache (readCluster → cache insert?)
  — otherwise H1 falls and an alternative (H2: ???) must be found. DO NOT accept H1
  without insertion-site proof.

## Candidate fixes (for the fix-design agent — evaluate ALL, pick optimal, spec exactly)

- A. **Harvest keyframes during iteration (leading candidate, root fix).**
  iterateVideoPackets (and the S1/S2 phase pumps) call `addKeyframeTimestamp(...)` for
  every `packet.type === 'key'` (on the ORIGINAL packet timestamps, pre-clone-adjust).
  After the prime the index = [0, 10.40, 20.81]; refill findNearestKeyframe(25.024) →
  20.81 (4.2s < 12s rule) → `usedIndex=true` → getKeyPacket(20.81) starts its walk in
  a cluster AT/BEFORE the keyframe ⇒ found. Refill overlap-re-transmuxes 20.81→25.02
  (~4.2s coded-frame replacement, the pre-abutting-era shipped behavior) and advances.
  Also fixes track-switch rebuilds and backward seeks into played regions for free.
  MUST design: (i) a `contiguousHarvestWatermark` so the 12s sparse rule can be
  bypassed within fully-iterated spans (GOP > 12s files would otherwise still die);
  (ii) memory bound for the timestamps array on 9-hour files (~3,100 floats — fine, but
  state it); (iii) interplay with `keyframeIndexBuilt` full-scan flag and the 0.01s
  dedup in addKeyframeTimestamp (:786) at 130Hz call rates (perf: it's a linear
  `ts.some()` — O(n) per packet! consider binary-search dedup or only-insert-if-new).
- B. **Refill null-keyframe circuit-breaker (belt; ships regardless of A).**
  Count consecutive null-keyframe refills; at N (propose 5) on format==='mkv' →
  `_recoverMkvToRemuxTier('refill cannot advance')` (Layer-3 tier-2 exists precisely
  for cue-less pathology: ffmpeg reads linearly). MUST be EOF-guarded: when
  `refillPosition >= duration - nearEofThreshold` treat null as EOF (endOfStream via
  the existing completion path), NOT reroute. Reset counter on: successful refill,
  user seek, track switch, file change.
- C. **Failure backoff (suspenders).** Failed refill takes a sleep (500ms–2s) before
  rechain instead of `immediately`. Kills the 130Hz spin even while B counts.
- D. (Evaluate, likely reject) cut-packet retention + `getNextKeyPacket(cutPacket)`
  forward resume: precise but stateful (packet identity across seekTo requires
  reuseMkvInput; clones are NOT in packetToClusterLocation — matroska-demuxer.ts:2115
  throws 'Packet was not created from this track'); invalidation on user seek; does
  NOT fix track-switch/backward-seek class. Compare honestly vs A.
- E. (Evaluate, likely reject) horizon-ladder getKeyPacket(pos+15/+30/+60): reads
  forward clusters over HTTP that the subsequent iteration would read anyway, but
  N× walk restarts; doesn't fix track-switch class; magic numbers.

## Validation design (fix must ship with these)

- V1. Unit: harvested-index semantics (insertion from iteration, watermark trust,
  12s rule outside watermark) — pure functions where possible.
- V2. Unit: breaker rule + EOF-null rule as exported pure functions
  (mirror shouldTriggerZeroAudioReroute pattern).
- V3. Fixture: cue-less MKV generated IN-TEST via mediabunny's own muxer with
  `appendOnly`/StreamTarget mode (streaming outputs cannot write Cues — verify this
  claim at mediabunny/src/matroska/matroska-muxer.ts; if true we get a perfect
  in-memory repro: mux H.264-less synthetic or copy tiny real samples). Assert:
  (a) old path: getKeyPacket(bufEnd) → null repro; (b) new path: harvest → resolve.
  If muxer fixture infeasible, fall back to a mocked-sink seekTo harness.
- V4. e2e expectations for THIS file (user runs tauri dev): prime harvests ≥3 kfs;
  first refill logs `usedIndex=true` keyframe≈20.81 overlap≈4.2s; chain advances past
  37s; zero `No keyframe found` lines; watchdogs silent; audio still on.

## Constraints (non-negotiable, from project memory/rules)

- Surgical diffs only; no drive-by refactors; match existing style.
- TS tier, MP4 tier, remux tier, VBR-anchor seeks, abutting refills (cue-indexed
  files), HEVC recovery, blocked-paused seek rule (fwd window 180s running/8s paused;
  never set __nobuf_seekTargetTime) must be provably untouched.
- 'Paused means paused': any reroute/recovery path preserves pause state.
- All gates: tsc clean, vitest (382 baseline) green + new tests, cargo 178/178
  untouched, then USER runs the e2e — agent never claims done before that.
