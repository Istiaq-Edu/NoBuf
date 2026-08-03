# MKV audio-skip — mediabunny v1.45.4 library semantics (verified against vendored source)

> Angle doc for the audio-skip research fan-out. The original subagent's final message
> was lost to a provider infra error, but its investigation trail survived; every fact
> below was INDEPENDENTLY re-verified by reading the vendored bundle/sources at the
> cited lines before this doc was written. Paths: `app/node_modules/mediabunny/`
> (`dist/bundles/mediabunny.cjs` = readable bundle; `src/**.ts` = TS source).

## 1. Why `audioSink.getKeyPacket(0)` returns null on the repro file

`EncodedPacketSink.getKeyPacket(timestamp)` for MKV (bundle :10563-10575) runs
`performClusterLookup` with predicate:

```js
findLastIndex(trackData.presentationTimestamps, (x) => {
  const block = trackData.blocks[x.blockIndex];
  return block.isKeyFrame && x.timestamp <= timestampInTimescale;   // :10572-10575
});
```

The repro file (`Inception...HDHub4u.Tv.mkv`, ffprobe-verified) has:

| stream | codec | start_time | default |
|---|---|---|---|
| 0 video | h264 | 0.000 | yes |
| **1 audio (Hindi)** | **aac** | **0.029** | **yes** ← transmuxer picks this |
| 2 audio (English) | aac | 0.000 | no |

Seek at t=0 → predicate needs an audio block with `timestamp <= 0` → the first Hindi
block is at 0.029 → **no block qualifies in any cluster → null**. A 29 ms audio delay
(ubiquitous in scene remuxes) is the entire trigger.

## 2. `isKeyFrame` is NOT the blocker for audio

The matroska demuxer **forces every audio block to be a key frame** at parse time
(bundle :9956-9959):

```js
let isKeyFrame = !!(flags & 128);
if (trackData.track.info?.type === "audio" && trackData.track.info.codec) {
  isKeyFrame = true;
}
```

Consequences:
- `getPacket(t)` (same cluster walk, binary-search `<= t` WITHOUT the isKeyFrame
  filter, :10504-10525) fails for the exact same reason at t=0 — **`getPacket` is NOT
  a sufficient fallback for the audio-delay case** (still requires `ts <= 0`).
- Any audio packet mediabunny returns IS a key packet — safe to start the muxer with.

## 3. The library's own sanctioned fallback idiom

mediabunny's internal conversion/decode pipeline uses exactly this chain
(bundle :21772):

```js
const keyPacket = await packetSink.getKeyPacket(startTimestamp, opts)
               ?? await packetSink.getFirstKeyPacket(opts);
```

`getFirstKeyPacket` (bundle :21519; MKV backing :10480-10499) does a cluster lookup
with search timestamp **-Infinity** and predicate "first cluster containing ANY
trackData for this track" — deliberately **bypasses cues entirely** (comment at
:10496: "Use -Infinity as a search timestamp to avoid using the cues"). For the repro
file it returns the 0.029 s packet. Cost: walks clusters from segment start — cheap at
seek≈0 (first clusters are already prefetched/warm), potentially expensive mid-file
(would scan from cluster 1) → **must be gated to near-zero seeks or bounded**.

## 4. Why mid-file audio nulls happen (the second failure mode)

`performClusterLookup` (matroska-demuxer.js :1844-1935 region): cue binary-search
picks a start cluster (audio tracks usually have NO cue points — MKV Cues convention
indexes only video), then a forward cluster walk; returns null when no visited cluster
yields a matching block (`bestCluster` never set) — e.g. the walk starts in a cluster
PAST the target after a video-cue-derived start, one internal retry with the previous
cue point, then gives up. Timing/cache dependent → explains intermittent repros
(refills with warm position cache carry audio; cold far-seeks may not).

## 5. Zero-packet closed track ⇒ track absent from moov (the fatal's mechanism)

ISOBMFF muxer (src/isobmff/isobmff-muxer.ts):
- `trackDatas` entries are created lazily on a track's FIRST sample (:176/:258).
- The `moov` is built from `trackDatas` when fragment #1 finalizes (:804-816).
- Fragment finalization waits for all OPEN tracks (`allTracksAreKnown` :145-152, gate
  :779) — but a source **closed before its first sample** counts as known and simply
  never appears in the moov.

⇒ `audioSource.close()` in the skip path yields a **672-byte single-trak (video-only)
init segment** while `buildMimeType` still declares 2 codecs from the INPUT file's
tracks. The transmuxer comment claiming "init segment still includes the audio track
definition" (MediabunnyTransmuxer.ts :1449-1454) is **factually wrong** for v1.45.4.

`output.getMimeType()` (isobmff-muxer :153) awaits `allTracksKnown` and reflects the
ACTUAL emitted track set — a ready-made consistency check source.

## 6. Muxer constraints a fix must respect

- `First packet must be a key packet.` — muxer.ts :53 throws otherwise. Audio: always
  satisfied (§2). Video: already handled (video getKeyPacket path).
- `EncodedPacket` can be constructed manually (packet.ts :55+) — silence-injection
  would be possible for AAC, but requires codec-correct silent frames per
  sample-rate/channel-config (hls.js/mux.js maintain pregenerated tables for AAC only;
  our MKV audio may be AC3/EAC3/Opus → non-trivial to generalize).
- All sink methods throw `InputDisposedError` mid-await on dispose — seekTo's catch
  already treats it as expected (MediabunnyTransmuxer.ts :1517-1522).

## 7. Upstream state

Vendored version: 1.45.4 (package.json). The audio-delay-vs-`<=` behavior is inherent
to the documented `getKeyPacket` contract ("last key packet with start ≤ timestamp;
null when the timestamp is before the first key packet"), not a bug fixed upstream —
the conversion-pipeline fallback idiom (§3) is how the library itself copes.
