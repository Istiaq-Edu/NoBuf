# H1 Verification — MKV Cue-less Refill Stall (getKeyPacket → null)

Verifies reports/research/refill-stall-rootcause.md H1 at source level. 2026-08-02.
Vendored demuxer: `app/node_modules/mediabunny/src/matroska/matroska-demuxer.ts` (2536 lines, v1.45.4).
All line numbers below are vendored-file lines unless prefixed.

## Verdict

**H1 VERIFIED (with two mechanism refinements — see Corrected mechanism).**
The forward-only cluster walk of `performClusterLookup` starts at the highest
`clusterPositionCache` entry with `startTimestamp <= target`. After the prime iterated
clusters covering [0, 25.02s], that entry is the LAST prime cluster (~24.9x s, mid-GOP,
past the 20.81 keyframe's cluster). The walk inspects that cluster (+ at most the next
one), finds no keyframe ≤ 25.024, breaks on the first cluster starting > 25.024, has
`bestCluster === null`, and returns null (:2382). The 20.81 keyframe's cluster is BEHIND
the walk start and structurally unreachable. `segment.clusterSeekStartPos` is never
consulted once the cache has any entry ≤ target (:2260 uses `??`, and
`lookupEntryPosition` is non-null). Bug confirmed present and unfixed in upstream
v1.52.2 (function byte-identical to vendored 1.45.4).

## Q1 — clusterPositionCache insertion sites

`grep -n clusterPositionCache` → 7 hits; exactly ONE insertion site:

- :183-186 — field on `InternalTrack`: `{elementStartPos, startTimestamp}[]`, comment:
  "List of all encountered cluster offsets alongside their timestamps. This list never
  gets truncated". Per-track array (video and audio each have their own).
- :992 — initialized `[]` at TrackEntry parse.
- :709-723 — **the only writer**, inside `readCluster(startPos, segment)` (:595-728).
  For EVERY track with ≥1 block in the just-parsed cluster (loop :649, assert :653),
  after computing `trackData.startTimestamp` = min presentation timestamp of that
  track's blocks in the cluster (:703-706), it does `binarySearchLessOrEqual` (:710-714)
  and splices `{elementStartPos: cluster.elementStartPos, startTimestamp:
  trackData.startTimestamp}` in sorted order (:719-722), deduped by elementStartPos
  (:715-718). Comment :709: "remember that a cluster with a given timestamp is here,
  speeding up future lookups if no cues exist."
- :2244, :2249 — the read side (see Q2). :711/:717 are part of the insert.

**All cluster parsing funnels through readCluster**: its only call site is
performClusterLookup :2314, and every packet API (getPacket :2023, getNextPacket :2054,
getKeyPacket :2090, getFirstPacket :1991) is a performClusterLookup wrapper. The
iteration pump (`EncodedPacketSink.packets()` → repeated `getNextPacket`,
media-sink.ts:304/:360) therefore walks cluster-by-cluster through :2314 → readCluster
→ insert. **After a linear iteration covering [0, 25.02s], the video track's cache holds
one entry per video-bearing cluster in that span** — including the 20.81 keyframe's
cluster AND the final mid-GOP cluster starting ~24.9x s — sorted by startTimestamp
(units: raw timescale ticks; block ts += cluster ts at :659, seconds conversion only at
packet creation :2176).

## Q2 — performClusterLookup walk arithmetic for getKeyPacket(25.024)

`getKeyPacket(t)` (:2087-2112) calls
`performClusterLookup(null, match, T, T, opts)` with `T = intoTimescale(25.024)` ≈ 25024
ticks (timestampFactor = 1e9/timestampScale, :976, :2013-2018; same unit as the cache).

Walk-start arithmetic (:2214-2269), failing case (0 cues, cache covers [0, ~25.02]):

1. `startCluster = null` → :2218-2229 skipped; `currentCluster = null`.
2. Cue search :2233-2240: `cuePoints = []` → `binarySearchLessOrEqual` returns -1
   (misc.ts:249-268: "largest i with val[i] <= key, or -1") → `cuePoint = null`.
3. Cache search :2243-2250: highest entry with `startTimestamp <= 25024` = the **last
   prime cluster** `{elementStartPos: P_last, startTimestamp ≈ 24.9xx ticks}` (mid-GOP;
   keyframes are at 0 / 10.40 / 20.81, next ≈ 31.2).
4. :2252-2255 `lookupEntryPosition = Math.max(cuePoint?.clusterPosition ?? 0,
   positionCacheEntry?.elementStartPos ?? 0) || null` = `Math.max(0, P_last) = P_last`
   (non-zero ⇒ not nulled by `|| null`).
5. :2259-2260 `!startCluster` → `currentPos = lookupEntryPosition ??
   segment.clusterSeekStartPos` = **P_last**. `clusterSeekStartPos` (first cluster of
   the segment, :88/:413/:483) is reached ONLY when `lookupEntryPosition === null`,
   i.e. only when BOTH cue and cache searches miss (`??` passes any non-null). **With
   any cache entry ≤ target, the from-start fallback is dead code.**

Loop walk by hand (:2271-2364):

- Iter 1: `currentCluster` null → break-check :2272-2277 skipped. Header at P_last is a
  Cluster → `readCluster(P_last)` (:2314; :596-598 returns `segment.lastReadCluster`
  without re-parse when positions match — true on every failed retry after the first).
  `getMatchInCluster` (Q3): cluster ~24.9x is mid-GOP → no block with
  `isKeyFrame && ts <= 25024` → `{blockIndex:-1, correctBlockFound:false}` →
  bestCluster stays null (:2323 guard). `currentPos = endPos` (:2363).
- Iter 2: `currentCluster` = cluster(24.9x); `startTimestamp 24.9x ≤ 25024` → no break.
  Reads the NEXT cluster (starts ~25.x, header already in the reader's slice cache from
  the prime's read-ahead → 0 HTTP). Match: still mid-GOP, and every block ts > 25024
  anyway → {-1,false}.
- Iter 3: `currentCluster.startTimestamp (~25.x·1000) > 25024` → **break** :2274-2276.

Exit path (:2366-2382): `cuePoint` null → faulty-cue retry :2367-2375 skipped (this
retry-with-earlier-entry mechanism exists ONLY for cue points, not for position-cache
entries — the asymmetry at the heart of the bug). `bestCluster === null` → fallback
:2377-2380 skipped → **`return null` :2382**.

Why 20.81 is unreachable: match requires a keyframe with `ts <= T` *inside a walked
cluster*; all keyframe-bearing clusters (0, 10.40, 20.81) lie at file positions
< P_last; the walk is strictly forward from P_last (currentPos only ever grows :2363).
Had the walk started at or before the 20.81 cluster, `blockIndex` would be set there,
`correctBlockFound` false (T ≥ that cluster's endTimestamp) → recorded as bestCluster →
walk continues → break past T → **bestCluster fallback returns 20.81** (:2377-2380).
So the loop exit path is fine; the start position is the entire defect. H1's walk-start
claim is exactly right; the doc's alternative candidates (trackData undefined, break on
first iteration) are ruled out: break can't fire on iter 1 (currentCluster null), and a
missing video trackData just yields {-1,false} without breaking (:2273 requires
trackData to break).

Fingerprint match: attempt cost = 1-2 header reads + cached cluster re-lookup, all
served from the reader slice cache + `lastReadCluster` short-circuit → 0.5-2ms, zero
`[STREAM-REQ]`, `usedIndex=false` — precisely F3.

## Q3 — getMatchInCluster for getKeyPacket

:2092-2107. Two {-1,false} paths, both confirmed:
- :2093-2096 — video trackData absent from cluster (e.g. audio-only cluster) →
  `{blockIndex:-1, correctBlockFound:false}`. (Such clusters also can't trigger the
  :2274 break — the break needs trackData for THIS track.)
- :2098-2106 — trackData present but `findLastIndex(presentationTimestamps, isKeyFrame
  && ts <= T)` = -1 (mid-GOP cluster: zero keyframes; or all keyframes > T) →
  blockIndex -1 (:2103), correctBlockFound false (:2104, requires index !== -1).
Also note :2104's second conjunct: even a FOUND keyframe only stops the walk when
`T < trackData.endTimestamp` (target inside the cluster's span); otherwise it is merely
recorded as bestCluster and the walk continues — correct behavior, irrelevant here
because no walked cluster produces any match at all.

## Q4 — upstream status

- Vendored: **mediabunny 1.45.4** (app/node_modules/mediabunny/package.json:4;
  app/package.json:29 `"mediabunny": "^1.45.4"`).
- Upstream (github.com/Vanilagy/mediabunny): latest tag **v1.52.2**, main package.json
  version 1.52.2 (checked 2026-08-02).
- Fetched `main`'s matroska-demuxer.ts (2598 lines): `performClusterLookup` body and
  the readCluster insertion block are **logic-identical** to vendored 1.45.4 (diff over
  the function ranges = only my sed-range boundary artifacts; same
  `Math.max(...) || null`, same `?? clusterSeekStartPos`, same missing position-cache
  retry). **Bug present and unfixed at v1.52.2 — upgrading does not help.**
- Issue/PR search (`getKeyPacket`, `clusterPositionCache`, `"position cache"`,
  `cueless`, `"no cues"`, `matroska seek keyframe`): zero relevant hits. Nearest
  matches all unrelated: #414 (MPEG-TS AUD/random_access), PR #342 (CanvasSink live
  seek), #333 (trim/transcode iOS), #323 (UrlSource mp4 moov), #443/#442 (subtitle
  muxing). Recent commits touching matroska-demuxer.ts: ProRes atoms, #415 logging,
  #335 defaults, #362 pasp, #309 non-square pixels, HLS work — none touch the lookup.
- Contract check: media-sink.ts:224-229 documents getKeyPacket as "returns the last key
  packet … with a start timestamp less than or equal to the given timestamp … returns
  null if the timestamp is before the first key packet in the track." 25.024 is not
  before the first keyframe (≈0) ⇒ this is a **genuine, unreported upstream contract
  violation**, not intended cache semantics. (`verifyKeyPackets` is irrelevant: the
  backing returns null before verification, media-sink.ts:247-250.)
- Fix routing: a targeted vendored patch is viable (and upstreamable); it lives in
  node_modules, so it needs patch-package/fork/vendor-copy plumbing — flag for the
  fix-design agent.

## Q5 — other callers of the same failure surface

Transmuxer seekTo resolution order (MediabunnyTransmuxer.ts): cue index first
(:1374-1387, no-op here), then partial index `findNearestKeyframe` with the 12s sparse
rule (:830-841 — after the prime the index is `[0]` (:1454-1457 only writer), so any
target > 12s → null), then **fallback `videoSink.getKeyPacket(seekTime)`**
(:1409-1414); null → warn + return null (:1433-1438). The persistent-MKV-Input reuse
(:1289-1293, :1344-1347) carries the SAME InternalTrack — and thus the same poisoned
position cache — across every seekTo.

1. **Refill** (observed): useMSEPlayer.ts:2702/:2706/:2717 → seekTo(25.024, 17,
   stopTime:Infinity) :2730 → null → discard + "Streaming refill failed" :2900-2904 →
   finally reschedules :2914+ → 130 Hz forever. No breaker (F7/C5 confirmed).
2. **_switchMkvAudioTrack** (useMSEPlayer.ts:6152): rebuild does
   `seekTo(t=currentTime, 8, …)` :6237-6241. Cue-less + playhead t ≥ 12s and mid-GOP
   past the keyframe's own cluster (e.g. 15s: cache nearest-≤15 = cluster ~14.9x, GOP
   keyframe 10.40 behind it; 20.81 fails the ≤15 filter) → same null → :6248-6252
   reverts the track selection. **Same failure surface; user-visible as "audio switch
   does nothing" whenever the playhead is mid-GOP** (i.e. almost always, GOP ≈ 10.4s and
   cluster spans are seconds). Playheads < 12s survive via the [0] partial-index entry.
3. **User seek** (executeTransmuxerSeek :9077, MKV branch :9182-9183 seekTo(clamped, 8)):
   - Backward/inside the cache-covered span [0, 25.02] with target > 12s and mid-GOP →
     same null → "Seek failed — discard buffered segments" :9319-9323 (silent stall at
     the old position; recoverable by another seek). Targets ≤ 12s succeed via the [0]
     index entry (:830-841 returns 0 when gap ≤ 12); targets landing inside a
     keyframe-bearing cluster succeed via :2104's inside-span match.
   - Forward into COLD territory (target > cache max, e.g. 100s): cache nearest-≤ =
     last cached cluster ~25.x → forward walk over HTTP reads every cluster 25→100s,
     recording each passed keyframe as bestCluster → breaks past target → returns the
     correct keyframe via :2377-2380. **Correct but O(distance) slow** — matches the
     observed 5-17s cold far seeks. So user forward seeks "work", masking the bug.
   - Non-MKV else-branch :9333 unaffected here.

## Corrected mechanism

H1 verified; two refinements to its wording:

1. The cache is not "an entry pointing inside the final GOP" in isolation — it contains
   entries for EVERY prime-read cluster including the 20.81 keyframe's own cluster. The
   defect is that the lookup consumes only the SINGLE nearest-≤-target entry as the
   walk start (:2243-2250) and has **no retry with an earlier entry and no fallback to
   clusterSeekStartPos** when the forward walk yields bestCluster === null. The cue
   path has exactly such a retry ("the cue point lied to us", :2367-2375); the
   position-cache path does not. One-sentence bug: *the position cache is trusted like
   a cue index but lacks the cue index's lie-detection retry, and unlike a cue point —
   which by construction references a keyframe-bearing cluster — a cache entry is just
   "some cluster that starts ≤ T" with no keyframe guarantee.*
2. The null is produced by the :2274 break on the 2nd-3rd iteration with bestCluster
   never set, then :2382 — not by trackData absence and not by a first-iteration break
   (impossible: currentCluster is null on iteration 1).

**The real invariant**: on a cue-less file, `getKeyPacket(T)` succeeds iff the highest
position-cache entry with startTimestamp ≤ T sits at-or-before (in file order) the
cluster containing the last keyframe ≤ T — or no such entry exists at all, forcing the
from-start walk. Linear iteration densely populates the cache (one entry per cluster),
so once playback crosses a GOP whose keyframe cluster has scrolled ≥ 1 cluster behind
the buffer end, EVERY subsequent lookup for a mid-GOP T in the played span violates the
invariant and returns null — permanently, because the persistent Input keeps the cache
(":never truncated", :180-182) and each failed lookup re-inserts nothing new. A cold
Input (empty cache) would be slow-but-correct; the freshness optimization is what
breaks correctness.

## Implications for fix design

- **Fix A (harvest keyframes during iteration) attacks the invariant directly** and is
  sufficient: getKeyPacket(20.81) has nearest-≤ cache entry = the 20.81 cluster itself
  (its startTimestamp ≤ kf ts ≤ T, binary search lands on it or earlier) → match found
  in the first walked cluster (or via bestCluster) → success, in-memory. Exact-ts
  lookups are stable thanks to roundIfAlmostInteger (:2013-2018). Also fixes track
  switch and backward seeks (surfaces 2 and 3 above) as the rootcause doc predicts.
- **Alternative/complementary: 3-line vendored demuxer patch** — after the loop, mirror
  the cue retry for the cache path: if `bestCluster === null && !cuePoint &&
  positionCacheEntry`, retry `performClusterLookup(null, match,
  positionCacheEntry.startTimestamp - 1, latestTimestamp, options)` (or restart from
  clusterSeekStartPos). Semantically the upstream-correct fix; candidate for an
  upstream PR (bug alive in 1.52.2). Cost: lives in node_modules → needs
  patch-package or a vendored fork; each retry step is one cache-binary-search + walk,
  worst case O(GOP/cluster-span) steps backward through cached (in-memory) clusters.
- Fix B (null-refill breaker) and C (backoff) remain valid belts: A/patch removes this
  failure class, but B also covers the EOF-null case (C5) which fix A does NOT (at
  T ≥ duration mid-GOP-tail the same invariant violation occurs against the LAST GOP's
  keyframe — harvesting fixes that too as long as the final GOP's keyframe was
  iterated… only true once playback reached it; breaker still wanted for cold EOF
  seeks).
- Upgrading mediabunny is NOT a fix (1.52.2 identical); do not spend a bump on this.
