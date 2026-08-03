# EDGE-CASE ANGLE A — Layer-1 audio-start fallback chain (getKeyPacket ?? getPacket ?? getFirstKeyPacket / nextAfterVideoKey)

Status: IN PROGRESS (incremental findings; written as verified)
Scope: the proposed chain from reports/mkv-audioskip-solution.md §Layer 1, to be installed at 3 sites in
`app/src/lib/faststream/players/MediabunnyTransmuxer.ts`:
- S1 `produceSegmentsFromInitInput` (TS Phase 1, in-memory initInput) :916-924
- S2 `sequentialContinue` (TS Phase 2, streamSource) :1026-1037
- S3 `seekTo` (MKV + TS seek path) :1455-1476

Ground truth: vendored mediabunny **1.45.4** at `app/node_modules/mediabunny/` (TS source in `src/`).

## Verification log
(appended as verified — each edge case gets: scenario, what the chain does, verdict, evidence)

### F1. Library ground truth (mediabunny 1.45.4, `src/media-sink.ts`)
- `getPacket(t)` / `getKeyPacket(t)`: "last packet (presentation order) with startTs <= t"; **null if t is before the first (key) packet** (doc comments :188-196, :224-235). Both `validateTimestamp` first.
- `getFirstKeyPacket()` = `getFirstPacket()` then, if it's a delta, `getNextKeyPacket(firstPacket)` (:172-186). No timestamp argument — always segment-start scan.
- `getNextKeyPacket(packet)` / `getNextPacket(packet)` **require the packet to have been minted by the SAME track backing**: MKV backing does `packetToClusterLocation.get(packet)` and **throws `Error('Packet was not created from this track.')`** otherwise (matroska-demuxer.ts :2049-2052, :2115-2118). ⇒ **the video keyPacket can NEVER be fed to `audioSink.getNextKeyPacket()`** — the "nextAfterVideoKey" leg cannot be literally "getNextKeyPacket from video key packet" (solution doc line 40 wording is unimplementable as written). Must be re-specified (see F-impl below).
- `verifyKeyPackets:true` on getKeyPacket recurses BACKWARD on mismatch (`packet.timestamp - 1/timeResolution`) (:253-257) — irrelevant for audio (chain uses false) but relevant to cost if someone flips it.
- `packets(startPacket)` throws `TypeError` if `startPacket.isMetadataOnly` and `options.metadataOnly` not set (:312-314). ⇒ chain implementations must fetch the audio start packet **without** `metadataOnly:true` (the keyframe-index scan idiom at transmuxer :724 uses metadataOnly — do not copy it).
- Every sink method throws `InputDisposedError` if `input._disposed` (:164-166, :200-202, :239-241) — the chain lengthens the window in which a concurrent `dispose()` turns the audio lookup into a THROW rather than a null (today a single getKeyPacket; with the chain, up to 3-4 sequential scans). Call sites S1/S2/S3 have **no try/catch around the audio lookup** today.
- Library's own internal idiom (`media-sink.ts` :526-527, inside sample-sink init): `await getKeyPacket(t, opts) ?? await getFirstKeyPacket(opts)` — i.e. upstream falls back to full-scan getFirstKeyPacket UNCONDITIONALLY, even mid-file. Confirms doc §mediabunny claim; our gate (near-zero only) is a deliberate cost restriction, not the library default.

### F2. MKV demuxer lookup mechanics (`src/matroska/matroska-demuxer.ts`)
- `getPacket(t)`: `performClusterLookup(searchTs=t, latestTs=t)`, per-cluster `binarySearchLessOrEqual(presentationTimestamps, t)`; `correctBlockFound` additionally requires `t < trackData.endTimestamp` (:2020-2046).
- `getKeyPacket(t)`: same walk + `block.isKeyFrame` filter (:2087-2112).
- `getFirstPacket()`: `performClusterLookup(searchTs=-Infinity)` ⇒ **cues deliberately bypassed** (comment :2007), scan starts at `segment.clusterSeekStartPos` — segment start (or VIRTUAL segment start on the OffsetCustomSource path).
- `performClusterLookup` (:2201-2383):
  - Entry position = max(cuePoint ≤ searchTs, clusterPositionCache ≤ searchTs) else `clusterSeekStartPos` (:2233-2260). Cue-less MKV + no cache ⇒ scan from segment start.
  - Loop break condition: only when a cluster CONTAINING this track's blocks has `startTimestamp > latestTimestamp` (:2272-2278). **Clusters with no audio trackData never trigger the break** ⇒ if the audio track ends early (audio shorter than video), a lookup at a later t scans **every remaining cluster to segment end** (readCluster on each, :2313-2316) before returning.
  - `bestCluster` fallback (:2377-2380): if no block satisfied `correctBlockFound` but SOME block with ts <= t was seen, the LAST such block is returned anyway. ⇒ `getKeyPacket/getPacket` mid-file can return a packet **arbitrarily far BEHIND** the requested t (e.g. audio ends at 50min, seek 60min ⇒ returns the ~50min last audio packet, after a scan-to-EOF). **The chain's link 1 then succeeds with a uselessly-old packet — fallbacks never fire, and the failure mode is cost + a far-behind audio start, not null.**
  - Faulty-cue recursion (:2367-2375) retries with the previous cue point — bounded, but doubles scan cost when triggered.
- Block `isKeyFrame`: SimpleBlock reads flag 0x80 (:1468), **but for non-video tracks it is forced true** (:1470-1474 context confirmed below); BlockGroup blocks default `isKeyFrame:true` and are demoted only by ReferenceBlock (:1519, :1569). ⇒ for MKV audio, `getPacket(t)` ≡ `getKeyPacket(t)` — **link 2 of the chain is a no-op on MKV** (returns exactly what link 1 returned = null). It only has value on formats where audio packets can be non-key from the demuxer's POV (TS/ADTS? verified below).

---
## A-tail (absorbed after subagent loss — verified directly from source)

### F3. Laced audio blocks — non-issue beyond cost
mediabunny EXPANDS laced blocks (Xiph/Fixed/EBML) into individual per-frame blocks
before packets are minted: per-frame timestamps distributed evenly across the block
duration, `isKeyFrame` inherited (matroska-demuxer.ts:755-864 `expandLacedBlocks`,
splice at :842-864). The chain therefore sees per-frame packets; `ts <= t` comparisons
are unaffected. AAC in MKV is typically unlaced anyway; Vorbis/FLAC laced blocks just
cost one decode+expand pass per touched cluster.

### F4. Opus pre-skip — no NEW exposure
preSkip is a container-level field carried in the init segment's dOps box, written
from codec private data (isobmff-boxes.ts:968-998; parse at codec-data.ts:2174-2186).
It is not per-packet state, so starting audio from a fallback-resolved packet changes
nothing vs today: ANY seek already starts audio at an arbitrary packet without
pre-roll. Opus 80ms pre-roll convention = pre-existing (in)accuracy, not a chain
regression.

### F5. Window-end boundary — the chain's null is NOT the only zero-audio case
`iterateAudioPackets` cuts at `packet.timestamp >= stopTime` BEFORE adding (:1611-1621
region, Fix #7 A/V aligned cut). If the resolved audio start packet is already ≥
stopTime (mid-file audio hole spanning the window), the loop breaks on iteration 1 →
ZERO audio packets added → seekTo's cleanup closes the source (:1494-1496). In a
skipInitSegment refill no init segment is emitted (onFtyp/onMoov gated :544-560), so
no Chromium fatal — but the window is video-only ⇒ B3 starvation (buffered
intersection stops growing). ⇒ THE SURFACED SIGNAL MUST BE "zero audio packets added
this window" (count in iterateAudioPackets), NOT merely "start packet was null". The
null-start case is a subset.

### F6. Supersession between chain links
Each fallback link is an await; a user seek can bump `seekGeneration` between links.
iterateAudioPackets already aborts per-packet on generation mismatch (:1606-1609).
The chain must check `currentGeneration === this.seekGeneration` after EACH link and
bail to skip (not throw) — otherwise a superseded seek burns a full getFirstKeyPacket
cluster scan for a window nobody wants. Same InputDisposedError note as F1: wrap the
chain in the existing expected-error filter (:1506-1531) semantics.

### F7. Dead comment / removed helper
An orphaned doc comment "Iterate audio packets from the beginning (no key packet
found near keyframe)…" sits above `getMseDecision()` (:1640-1649) — the described
`iterateAudioPacketsFromStart` helper no longer exists. Evidence a from-start audio
fallback existed and was removed. Plan should delete the stale comment when touching
the file (surgical-changes rule: it's in the edited region's immediate vicinity and
describes the exact feature being reintroduced properly).
