# Round-3 Verify C — Cluster-Position-Cache Injection + Byte-Bisection (H-C1a–e)

Verified against vendored **mediabunny 1.45.4** source (`app/node_modules/mediabunny/src/`).
All paths below relative to that root unless prefixed `app/src`. No code modified.

**Headline: the design is FEASIBLE and is in fact *pre-built* into mediabunny.** The demuxer
already maintains exactly the structure the design proposes to inject into —
`InternalTrack.clusterPositionCache: { elementStartPos, startTimestamp }[]` — and
`performClusterLookup` already consults it via binary search to pick its walk start. A synthetic
entry with a correct cluster element-start byte and correct start timestamp (in raw timescale
ticks) makes `getKeyPacket(T)` start its walk at that cluster and terminate within ~1 cluster.

---

## H-C1a — cluster-position structure + walk-start selection — **VERIFIED (load-bearing)**

**Structure.** `matroska/matroska-demuxer.ts:175-187` — `InternalTrack` owns:

```ts
clusterPositionCache: {
    elementStartPos: number;   // abs file byte of the 0x1F43B675 ID's FIRST byte
    startTimestamp: number;    // first block PTS for THIS track in that cluster, raw ticks
}[];
```
Doc comment (:179-182): "List of all encountered cluster offsets alongside their timestamps.
This list never gets truncated." Initialized `[]` per track at :992. It is **per-track**, not
per-segment.

**Organic insertion site.** `readCluster` → :709-723: after parsing a cluster, for each track
in it, `binarySearchLessOrEqual(track.clusterPositionCache, trackData.startTimestamp, x => x.startTimestamp)`
finds the insertion index and `splice(insertionIndex + 1, 0, {elementStartPos: cluster.elementStartPos, startTimestamp})`
keeps the array **sorted by startTimestamp**. Dedup is only `[insertionIndex].elementStartPos !== elementStartPos`
(:715-718). No adjacency/contiguity assumption anywhere — sparse entries are the design.
(Generic `insertSorted` at `misc.ts:271-274` shows the same idiom; `binarySearchLessOrEqual`
at `misc.ts:250-268` returns the last index with value ≤ key, −1 if none.)

**Walk-start selection.** `performClusterLookup` (`matroska-demuxer.ts:2201-2383`):
- :2233-2240 — binary-search `cuePoints` for last cue with `time <= searchTimestamp` (cue-less: empty → null).
- :2243-2250 — binary-search `clusterPositionCache` for last entry with `startTimestamp <= searchTimestamp`.
- :2252-2255 — `lookupEntryPosition = Math.max(cuePoint?.clusterPosition ?? 0, positionCacheEntry?.elementStartPos ?? 0) || null`.
- :2259-2260 — `getKeyPacket` passes `startCluster = null` (:2090-2091), so
  `currentPos = lookupEntryPosition ?? segment.clusterSeekStartPos` — **the walk starts at the
  cache entry's byte**; only with no cache hit does it fall back to the first cluster
  (`clusterSeekStartPos`, set at :413/:483), which is the observed 184MB/103s linear walk.
- :2271-2364 — forward walk: `requestSliceRange(currentPos, MIN_HEADER_SIZE, MAX_HEADER_SIZE)`,
  `readElementHeader` (:2286); **the header at the injected byte IS parsed and validated** —
  id must be in `LEVEL_1_EBML_IDS` (`ebml.ts:178-187`: SeekHead/Info/Cluster/Tracks/Cues/
  Attachments/Chapters/Tags) or Void, else resync (:2288-2307). On Cluster: `readCluster`
  parses it fully, `getMatchInCluster` checks for the target block (:2313-2321); walk breaks
  once a cluster's `trackData.startTimestamp > latestTimestamp` (:2272-2278).

**Termination for a target inside the injected cluster.** `getKeyPacket(T)` (:2087-2112) uses
`searchTimestamp = latestTimestamp = intoTimescale(T)`. If the injected entry is the cluster
containing T: first iteration parses it, `findLastIndex(...isKeyFrame && ts <= T)` (:2098-2101)
finds the keyframe; `correctBlockFound` requires `T < trackData.endTimestamp` (:2104) — true
inside the cluster → immediate return (:2319-2321). If the keyframe for T actually lives in an
earlier cluster (T before this cluster's first keyframe but ≥ startTimestamp — GOP spanning a
cluster boundary), `blockIndex` may be −1 and the walk continues **forward**, breaking at the
next cluster whose startTimestamp > T, then returns `bestCluster` or null (:2377-2382). ⇒ Inject
the cluster **at-or-before** T (bisection naturally yields "last cluster with time ≤ T"); walk
cost is then ~1-2 clusters. Note the faulty-cue-point retry (:2367-2375) checks `cuePoint` only —
a cache-driven lookup that finds nothing just returns null, no restart-from-zero.

**Invariants a synthetic entry must satisfy** (all cheap):
1. `elementStartPos` = absolute file offset of the **first byte of the `1F 43 B6 75` ID**
   (element start, NOT data start) — matches organic `cluster.elementStartPos` (:634, :604)
   and the walk reads a header at exactly that byte (:2281-2286).
2. `startTimestamp` in **raw timescale ticks** (see H-C1c), ideally the first *video-track*
   block's PTS. The cluster Timestamp (0xE7) value is ≤ the track's real startTimestamp
   (block PTS = cluster ts + relative ts, :659; relative can be negative in theory but is ≥ 0 in
   practice for the first block). Using the 0xE7 value is safe: a slightly-low startTimestamp only
   shifts the binary-search boundary marginally earlier → at most one extra cluster walked.
3. Insert **sorted by startTimestamp** (splice at `binarySearchLessOrEqual` index + 1) and skip
   if the neighbor already has the same `elementStartPos` — mirrors :710-723. Wrong order breaks
   binary search silently.
4. There is no separate 'loadedClusters' registry to reconcile — clusters are parsed on demand
   (`readCluster` :595-728, single-entry `segment.lastReadCluster` cache :596-598, :726).

---

## H-C1b — reach-in path from app code — **VERIFIED**

Chain (identical to the two shipped reach-ins):
`videoTrack._backing` → `InputTrack._backing: InputTrackBacking` (`input-track.ts:67-75`;
populated for MKV with `MatroskaVideoTrackBacking`, `matroska-demuxer.ts:1082`).
`._backing.internalTrack` → `MatroskaTrackBacking.constructor(public internalTrack: InternalTrack)`
(`matroska-demuxer.ts:1897-1903`, video subclass :2386-2393).
From `internalTrack` (type :175-198): `.clusterPositionCache` (:183-186) ← **injection target**;
`.segment` (:178) → `Segment` (:71-98) with `.timestampFactor` (:80) and `.dataStartPos` (:86);
`.demuxer` (:177) also available. So: **`(videoTrack as any)._backing.internalTrack.clusterPositionCache`**.

Precedent in app code: `extractMkvCueIndex` reads `_backing.internalTrack.cuePoints` +
`.segment.timestampFactor` (`app/src/lib/faststream/players/MediabunnyTransmuxer.ts:205-215`);
`readMkvCuePointCount` (`app/src/hooks/useThumbnailExtractor.ts:190-192`).

Thumbnail pipeline's own Input: it constructs its own `new Input({source, formats})` from
`createTauriStreamSource(this.sourceConfig)` and calls `this.input.getPrimaryVideoTrack()`
(`useThumbnailExtractor.ts:778-803`). `getPrimaryVideoTrack` → `_getTracks()` → per-backing
`new InputVideoTrack(this, backing)` (`input.ts:411-412, :430, :476, :488`), backing is the
Matroska one whenever format resolves to MKV ⇒ **same chain works on the pipeline's videoTrack**
(already proven at :817 via `readMkvCuePointCount(this.videoTrack)`). Per-Input caveat: each
Input has its own demuxer/InternalTrack — injecting into the thumbnail Input does not (and must
not) affect the playback Input.

---

## H-C1c — timestamp semantics — **VERIFIED**

- Parse site for cluster time: `case EBMLId.Timestamp (0xE7): this.currentCluster.timestamp = readUnsignedInt(slice, size)`
  (`matroska-demuxer.ts:1448-1452`; ID constants `ebml.ts:124-125`). Raw unsigned int, **no scaling at parse**.
- Block PTS: SimpleBlock stores i16 `relativeTimestamp` (:1463, :1481); `readCluster` adds the
  cluster timestamp: `block.timestamp += cluster.timestamp` (:659). `trackData.startTimestamp = firstBlock.timestamp`
  (:706) — the value cached at :719-722. ⇒ cache timestamps are **ABSOLUTE, in ticks**.
- Tick↔seconds: `timestampFactor = 1e9 / timestampScale` from segment `TimestampScale`
  (:972-976; default scale 1e6 ⇒ factor 1000, i.e. ticks are milliseconds, :533-537).
  seconds→ticks: `intoTimescale(t) = round(t * timestampFactor)` (:2013-2018); ticks→seconds:
  `block.timestamp / timestampFactor` (:2176). **Synthetic entry: `startTimestamp = Math.round(seconds * factor)`**
  with `factor = internalTrack.segment.timestampFactor` (read it, don't assume 1000).
- Unknown-size clusters (0xFF / 0x00FFFFFFFFFFFFFF vlen → `undefined`, `ebml.ts:596-625`):
  fully tolerated. `readCluster` :614-626 determines the real size by scanning for the next
  level-0/1 element (`searchForNextElementId`, `ebml.ts:680-709`) and additionally trims via
  `readContiguousElements(..., LEVEL_0_AND_1_EBML_IDS)` (:642-647). `performClusterLookup`
  advances `currentPos = cluster.elementEndPos` computed by readCluster, not the raw header size
  (:2313-2316, :2346, :2363). It reads the header at the injected byte itself (:2281-2286) —
  we never need to know the size beforehand.

---

## H-C1d — mid-file probe read path — **VERIFIED**

Bisection probes don't need mediabunny. Existing precedent for raw ranged reads in the same file:
- **Plain `fetch` with Range header against `/stream`**: the MP4 hover path already does exactly
  this — `fetch(this.streamUrl, { headers: { Range: \`bytes=${seekOffset}-${fetchEnd}\` } })`
  (`useThumbnailExtractor.ts:561-564`). Simplest option; append `source_id=thumbnail-bisect`
  (or reuse `thumbnail`) so the backend coordinator doesn't cross-cancel playback
  (source_ids_match; see `TauriStreamSource.ts:10-15, :42-55` — the tail-zone reads already use
  the `-tail` suffix precedent for exactly this isolation).
- Alternatively the pipeline's `CustomSource.read` seam (`TauriStreamSource.ts:248-250`,
  `fetchRange` :106+) — but it's closure-private per source instance; plain fetch is cleaner.
- Pipeline URL/source construction: `this.sourceConfig = { url: streamUrl, fileSize, prefetchProfile: 'none', sourceId: 'thumbnail' }`
  (`useThumbnailExtractor.ts:736-741`), Input built at :778-783. `streamUrl` is in scope for
  direct fetches (the class stores it; MP4 pipeline at :237 shows the pattern).
- Probe window: 1-2MB is the right order; typical cluster spacing ≲ 5s of video, and clusters for
  1080p content are usually ≪ 1MB apart in the tick range we bisect. If no `1F 43 B6 75` found in
  a window, widen or step — bounded by design.

---

## H-C1e — sync-scan false positives + validation — **VERIFIED (design constraint)**

mediabunny's own resync (`ebml.ts:712-736`, used by performClusterLookup :2294-2299 with
`MAX_RESYNC_LENGTH = 10MiB` :236) is a naive byte-wise scan that accepts the **first position
whose leading bytes parse as a var-int ID contained in the given ID set** (`readElementId`
`ebml.ts:581-593`) — it does NOT validate the size or the following element. So mediabunny
tolerates our injected byte being header-valid only in the shallow sense; but a false positive
would send the walk into garbage (worst case: resync loop or a wrong cluster). Real cluster
starts are also what the init scan trusts (stop at first Cluster, :483).

`readCluster` asserts `id === EBMLId.Cluster` at the given byte (:608-609) and asserts the
header slice exists (:602) — **a bad injected byte throws an assertion**, it doesn't corrupt
state silently. First-child check: the demuxer itself doesn't require Timestamp-first; it just
parses children and keeps `timestamp: -1` if 0xE7 never appears (:637, :1448-1452) — but muxers
in practice emit Timestamp first (mediabunny's own muxer does).

**Recommended scanner validation** (stricter than mediabunny's resync, all within the fetched window):
1. Find `1F 43 B6 75`; parse the following EBML vlen size (`readElementSize` semantics,
   `ebml.ts:596-625`): accept defined sizes < ~256MB, or the unknown-size markers.
2. Parse the first child header at data-start: require a known Cluster child — Timestamp `0xE7`
   (expected first), CRC-32 `0xBF`, SilentTracks `0x5854`, Position `0xA7`, PrevSize `0xAB`,
   SimpleBlock `0xA3`, BlockGroup `0xA0` (demuxer's handled set: :1448, :1454, :1491).
3. Read the 0xE7 value (uint, :1451) and require monotonic plausibility vs. the bisection
   bracket (ticks in [lo, hi]) — this kills essentially all remaining false positives.
4. On failure, continue scanning the window past the match.
The 4-byte pattern occurs ~1/4GB in uniform data; with checks 1-3 the effective false-accept
rate is negligible. (1A 45 DF A3 is the file-level EBML header — irrelevant mid-file.)

---

## Concrete synthetic-entry shape

```ts
// target: (videoTrack as any)._backing.internalTrack.clusterPositionCache  (sorted array)
type ClusterPositionCacheEntry = {
  elementStartPos: number; // ABSOLUTE file byte of the first byte of the Cluster ID 1F 43 B6 75
  startTimestamp: number;  // ABSOLUTE ticks: use the cluster's 0xE7 Timestamp value (uint), or
                           // better, first video SimpleBlock PTS = 0xE7 value + relative i16.
                           // ticks = Math.round(seconds * internalTrack.segment.timestampFactor)
};
// insertion (mirror matroska-demuxer.ts:709-723):
const cache = internalTrack.clusterPositionCache;
const i = binarySearchLessOrEqual(cache, entry.startTimestamp, x => x.startTimestamp); // or local re-impl
if (i === -1 || cache[i].elementStartPos !== entry.elementStartPos) cache.splice(i + 1, 0, entry);
```
Then call `videoSink.getKeyPacket(T)` / `videoTrack.getKeyPacket(T)` normally — lookup finds the
entry (`:2243-2255`), starts at `elementStartPos` (`:2260`), returns within ~1-2 clusters.

## Residual risks

1. **Private-API drift** — `clusterPositionCache` shape/name is internal; pin 1.45.4 and guard
   every hop (existing `readMkvCuePointCount` guard style), degrading to current skip behavior.
2. **0xE7 vs first-video-block timestamp skew** — cluster ts can precede the video track's first
   block PTS in that cluster (interleaved audio). Using 0xE7 keeps order-correctness of the
   sorted array (value ≤ real startTimestamp) but can start the walk one cluster early — cost ≈ 1
   extra cluster parse, correctness unaffected. Don't inject a timestamp HIGHER than the real one
   (could hide the right cluster from the binary search for targets in the gap).
3. **Keyframe in an earlier cluster than the bisected one** (open-GOP / sparse keyframes): walk
   only goes forward; `getKeyPacket` may return null or a later keyframe. Mitigation: on null,
   re-bisect for an earlier cluster (back off by one probe step) and retry — still bounded.
4. **False-positive cluster ID** despite validation (pathological bytes): `readCluster` assert
   throws → catch around getKeyPacket, drop the entry (splice it back out), fall back to skip.
5. **Injecting the byte of a mid-cluster position** (e.g. data start instead of ID start) breaks
   the header parse at :2286 → resync path (≤10MiB scan) or assert; the ID-start byte is mandatory.
6. **Track-id mismatch** — cache is per-track; inject into the *video* track's internalTrack
   (the one behind `getPrimaryVideoTrack()`), not audio.
7. **Multi-segment files** (rare): `elementStartPos` must belong to the same `segment`; entries
   never carry a segment ref, so a byte from another segment would confuse the walk. Guard:
   require `dataStartPos ≤ byte < segment.elementEndPos` when known (Segment fields :86-88).
8. **Unknown-size cluster at the injected byte**: handled (H-C1c), but the size discovery does a
   forward element scan (`searchForNextElementId`) — bounded by the next cluster, typically small.
