# Round-2 verification — H2a / H2c (cue-less MKV thumbnail guard)

Verifies hypotheses from `reports/research/seek-interrupt-rootcause.md` (Issue 2, fix B).
All line numbers live-read 2026-08-02 on branch `Embedded-subtitle-extraction`.
Vendored mediabunny 1.45.4 (`app/node_modules/mediabunny`, git-IGNORED — src/ ships in the
npm package; runtime imports `dist/modules/src/index.js`, whose demuxer JS mirrors src/
1:1 — verified `internalTrack.cuePoints` + `clusterPositionCache` exist in dist too
(dist .../matroska-demuxer.js:1945, :420). No patch-package layer; the only postinstall
patch is `scripts/patch-muxjs.mjs` (mux.js, unrelated). mediabunny internals are reached
by convention (`_backing`), not by repo patch.

---

## H2a — pipeline can self-detect cue-lessness at init(), zero extra network — **VERIFIED**

### Producer of `mkvCueIndex`

- `MediabunnyTransmuxer.extractMkvCueIndex(videoTrack)` — MediabunnyTransmuxer.ts:195-215,
  called once from init at :448, right after `getPrimaryVideoTrack()` (:444).
- It reaches mediabunny INTERNALS — **no public cue API exists** (grep `cue` in
  `input-track.ts`: zero hits):
  - `(videoTrack as any)?._backing?.internalTrack` (:198) — `_backing` is a real field
    (input-track.ts:71); matroska backing exposes `internalTrack` as a public ctor property
    (matroska-demuxer.ts:1897-1903).
  - `internal.segment.timestampFactor` (:199), `internal.cuePoints` (:200) —
    `InternalTrack.cuePoints: CuePoint[]` (matroska-demuxer.ts:187),
    `CuePoint = { time, trackId, clusterPosition }` (:143-147).
  - Sets `this.mkvCueIndex` at :209 (sorted), `[]` on any failure (:213, guarded try/catch).
- Where mediabunny fills `cuePoints`: `readMetadata()` (matroska-demuxer.ts:320-593),
  memoized via `readMetadataPromise ??=` (:241, :321). It scans top-level elements from
  byte 0, **stops at the first Cluster** (:482-484), then follows SeekHead entries to fetch
  missing `METADATA_ELEMENTS` — which include Cues (:230-235: SeekHead/Info/Tracks/Cues) —
  via targeted tail reads (:497-531). CuePoint parsing: :1409-1446. Distribution to tracks:
  :547-590 — tracks with 0 cues inherit the cue-richest track's list (:586-590), so
  **video-track `cuePoints.length === 0` ⇔ the whole file has no usable Cues**. This matches
  the transmuxer's own cue-less definition (`mkvCueIndex.length === 0`, MediabunnyTransmuxer.ts:1645).

### Zero-extra-network from the pipeline's init()

- `TransmuxerThumbnailPipeline.init()` (useThumbnailExtractor.ts:725-811) creates its OWN
  Input (:738-742) and already calls `getPrimaryVideoTrack()` (:762).
- Call chain: `getPrimaryVideoTrack` → `getTracks` (input.ts:398) → `_getTrackBackings`
  (:474-476) → `demuxer.getTrackBackings()` → **`await this.readMetadata()`**
  (matroska-demuxer.ts:273-276). So by the time init() holds `videoTrack`, the Cues are
  ALREADY parsed in memory (or definitively absent). Reading
  `videoTrack._backing.internalTrack.cuePoints` is a pure in-memory property access —
  **zero additional reads**. The metadata-tail fetch cost is paid by init() as it exists
  today; TauriStreamSource even routes those reads through a dedicated tail sourceId
  (`sourceId-tail`, TauriStreamSource.ts:42-55, tail zone = last 32MB :46).

### Conclusion

H2a **VERIFIED**. Same reach-in the transmuxer uses works from the pipeline's own Input at
init(), free. H2b (mseGetters plumbing) is unnecessary.

---

## H2c — harvested-timestamp capture on cold Input is bounded — **VERIFIED (with caveat)**

### Mechanics (read from source)

- Indexed branch useThumbnailExtractor.ts:863:
  `videoSink.getKeyPacket(kfTs, {verifyKeyPackets:false})` →
  `verifyKeyPackets:false` short-circuits straight to the backing (media-sink.ts:243-244) —
  it only skips the post-hoc bitstream type check (:247-257); **it does NOT change the
  cluster-walk mechanics**.
- `MatroskaTrackBacking.getKeyPacket` (matroska-demuxer.ts:2087-2112) →
  `performClusterLookup(null, match, T, T, opts)` (:2090) with BOTH searchTimestamp and
  **latestTimestamp = T** (:2108-2109).
- `performClusterLookup` (:2201-2383):
  - cue binary search (:2233-2240) → cue-less ⇒ null;
  - **position-cache** binary search (:2243-2250) → highest cached cluster with
    startTimestamp ≤ T;
  - start pos = `max(cue, cacheEntry) || null` ?? `segment.clusterSeekStartPos`
    (:2252-2260) — i.e. cache frontier, else **first cluster of the file** (byte ~0);
  - walk: read whole cluster (`readCluster` :595-728 loads the full cluster body, :629),
    advance `currentPos = endPos` (:2363);
  - **hard stop**: first cluster whose `startTimestamp > latestTimestamp` breaks the loop
    (:2274-2277) — the walk can never run past T's own cluster (unlike issue-3's
    verify:true playback seeks where latestTimestamp is also T, but T = hover far point).
  - every visited cluster is inserted into `clusterPositionCache` (:709-723) + a
    `lastReadCluster` memo (:596-598) ⇒ **the walk warms the Input**; capture #2 resumes
    from the nearest cached cluster ≤ its target.

### Cost bound for harvested T (e.g. 600s ≈ byte ~100MB)

- Cold thumbnail Input's cache holds at most cluster #1 (`getDecoderConfig` reads the first
  packet only for avc/hevc-Annex-B / vp9 / av1, matroska-demuxer.ts:2436-2451; readMetadata
  never reads a cluster, :482-484). So the FIRST harvested-far capture walks
  **[first cluster → T's cluster] ≈ O(T_byte)** — not small-constant bounded.
- Practical mitigation, from the harvest invariant: `keyframeTimestamps` only contains
  timestamps playback has ALREADY iterated this session (pushed via
  updateKeyframeTimestamps :707-709 / effect :1888-1911). Cue-less playback can only reach
  T by linearly walking there itself ⇒ the backend disk cache is warm for [0, T_byte]
  (thumbnail reads hit localhost/disk, not Telegram). `keyframeTimestamps` dies with the JS
  session, so a "harvested T + cold backend cache" combo requires mid-session cache
  eviction of the prefix — possible but pathological.
- **No regression vs today**: this exact branch + cost already ships (:859-863); fix B
  changes nothing about it.
- Worst case even when degenerate: capped at playback's own frontier byte (harvested
  T ≤ frontier) — at most the cost playback already paid, serialized by `busy` (:823, :838).

### Verdict

H2c **VERIFIED**: bounded by T's cluster byte with a hard in-demuxer stop, warms after the
first capture, typically disk-speed due to the harvest invariant. **Caveat to document in
fix B**: the first harvested-far capture is O(T_byte) cluster parsing, and Telegram-speed
if the backend prefix cache was evicted. Recommendation: **accept-and-document** (do NOT
add a byte-anchor bound to the indexed branch) — the cost ceiling equals playback's own
frontier, `busy` prevents pile-ups, and an extra bound would touch the warm/common path for
zero observed benefit. Revisit only if round-3 logs show indexed-branch walks.

---

## State isolation (task item 5) — **CONFIRMED, no leak channel**

- Pipeline: own source `createTauriStreamSource(this.sourceConfig)`
  (useThumbnailExtractor.ts:738), `sourceId:'thumbnail'` (:698), own `Input` (:742), own
  `EncodedPacketSink` (:798).
- Playback: own source (MediabunnyTransmuxer.ts:316), `sourceId:'playback'`
  (useMSEPlayer.ts:7074), own Input (:416).
- All mediabunny state involved here (`readMetadataPromise`, `cuePoints`,
  `clusterPositionCache`, `lastReadCluster`) hangs off each Input's demuxer/internalTrack —
  per-Input. `abortInFlight()`/condemn (fix A1) applies to the playback source instance
  only; the pipeline's source is never touched.
- Only shared artifacts: backend HTTP cache (intended; sourceId isolates cancellation) and
  the `keyframeTimestamps` ARRAY passed **by reference** (`getKeyframeTimestamps()` returns
  `this.keyframeTimestamps`, MediabunnyTransmuxer.ts:929-931; pipeline stores it :708).
  Read-only on the pipeline side — benign, but the fix must not mutate it in place there.

---

## Proposed detection API (fix B)

Shared helper (new, e.g. `app/src/lib/faststream/utils/mkvCues.ts`) so transmuxer +
pipeline share ONE reach-in point:

```ts
/** Cue-point count from mediabunny's already-parsed metadata (in-memory; zero I/O).
 *  null = internals not in the expected shape (vendored-version drift). */
export function readMkvCuePointCount(videoTrack: unknown): number | null {
  try {
    const cues = (videoTrack as any)?._backing?.internalTrack?.cuePoints;
    return Array.isArray(cues) ? cues.length : null;
  } catch { return null; }
}
```

Pipeline `init()`, immediately after `getPrimaryVideoTrack()` (useThumbnailExtractor.ts:762):

```ts
if (this.format === 'mkv') {
  const cueCount = readMkvCuePointCount(this.videoTrack);
  // null (layout drift) ⇒ treat as cue-less: matches extractMkvCueIndex's catch⇒[] degradation
  // (MediabunnyTransmuxer.ts:211-214); a skipped thumbnail beats a 100s busy-locked walk.
  // Cannot fire on the pinned vendored 1.45.4 (transmuxer proves the shape in prod).
  this.isCuelessMkv = (cueCount ?? 0) === 0;
  if (this.isCuelessMkv) console.warn('[TransmuxerThumbnailPipeline] MKV has no Cues — native-scan captures disabled (index-or-skip)');
}
```

`captureAtTime` strategy via the H3a pure helper (replaces the branch tangle at :847-875;
keeps the indexed branch, blocks BOTH native fallbacks :870 and :874 for cue-less):

```ts
export function decideMkvCaptureStrategy(
  keyframeTimestamps: number[], time: number, maxGap: number, isCuelessMkv: boolean,
): 'index' | 'native' | 'skip' {
  const kf = nearestAtOrBefore(keyframeTimestamps, time); // binary search, null if none ≤ time
  if (kf !== null && time - kf <= maxGap) return 'index';  // harvested hit → :863 path
  return isCuelessMkv ? 'skip' : 'native';                 // skip = warn-once + return false (TS precedent :830-836)
}
```

Cue-INDEXED MKV: `cueCount > 0` ⇒ `isCuelessMkv=false` ⇒ 'native' fallback preserved
verbatim — tier provably untouched. TS/MP4/remux paths: untouched (guard is `format==='mkv'`).

## Footnote

- `init()` still calls `computeDuration()` when the player didn't provide a duration
  (:757-759) — for a headerless MKV that is itself an EOF walk (known, documented at
  :754-756). Out of scope for fix B but worth keeping the knownDuration plumbing intact.
