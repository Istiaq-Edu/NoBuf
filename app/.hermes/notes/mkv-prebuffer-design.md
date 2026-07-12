# MKV disk-prebuffer → mirror MP4, adapted for mediabunny

## Verified facts (code + mediabunny docs via context7)

### MP4 pipeline (WORKING, do NOT touch)
- `downloadLoop` (useMSEPlayer.ts:5646) issues SEQUENTIAL HTTP Range requests to /stream,
  offset 0→fileLength, chunk by chunk (5764-5803).
- Each fetched range: `reportRangesToBackend()` + `trackDownloadedRange()` (5814-5817) →
  populates disk `cached_ranges` = GREEN BAR, contiguous, marches to EOF.
- Backpressure (5667-5674) only pauses the loop vs the 30s PLAYBACK buffer; the DISK cache
  still fills sequentially. The green bar going to EOF = this loop, decoupled from decode.
- MP4 does NOT use backend PROACTIVE task. Its bar is fed purely by downloadLoop.

### MKV pipeline (current)
- mediabunny PULLS bytes via TauriStreamSource (scattered cluster reads for seek).
- `startStreamingChain()` (4743) = bounded on-demand refill; caps lookahead ~30s.
- trackDownloadedRange is called from ESTIMATED bytes (4567-4569, 4732-4734), not real
  sequential fetches → green bar is sparse/gappy islands, never marches to EOF.
- Author's constraint (4692-4702): mediabunny Conversion.execute() CANNOT be paused; running
  it unbounded races ahead → eviction punches permanent holes → stall. CONFIRMED by docs:
  Conversion has only init/execute/cancel + trim{start,end}; no pause/backpressure on execute.

### mediabunny API (context7, authoritative)
- Conversion: init({input,output,trim:{start,end}}), execute() runs to completion, cancel().
  Bounded window = `trim`. No pause.
- Lower level: EncodedPacketSink.packets() / getPacket(t) — on-demand packet pull, lazy source reads.
- Source 'read' event exposes byte ranges being read.

## DECISION
Do NOT try to make mediabunny's Conversion stream to EOF (unpausable → holes; the author
already hit this). Instead mirror MP4 EXACTLY at the layer that actually fills the green bar:

**Run a SEQUENTIAL disk-cache-warming loop for MKV — same as MP4's downloadLoop — issuing
Range requests 0→EOF against /stream, calling reportRangesToBackend + trackDownloadedRange
per real fetched range.** This warms the SAME disk cache mediabunny then pulls from (cache
hits, no double download). Decoupled from the transmuxer/Conversion entirely, so the
unpausable-Conversion hole problem never arises.

- The MSE playback buffer stays exactly as-is (bounded refill chain, 4743). UNCHANGED.
- Only ADD: a parallel byte-range warmer that fills disk to EOF, respecting the same
  cancel/seek/teardown lifecycle. Green bar becomes contiguous → EOF, like MP4.

## Open verification before coding — ALL RESOLVED
1. /stream writes fetched ranges to the disk cache mediabunny reads → YES (server.rs
   PREBUFFER HIT/COORDINATOR path; same message_id disk cache). Warmer + player share cache.
2. byteToTime bar geometry with REAL bytes → correct (419 VBR cue anchors seeded, 4647).
3. Rate-limiter/coordinator conflict → RESOLVED: source_id is free-form Option<String>
   (server.rs StreamQuery.source_id, stream_cache.rs source_ids_match). Warmer uses
   source_id="warmer", isolated from player's "playback" reads — no cross-cancel. Warmer
   also yields (throttles) while state.current.downloading || bufferingForSeekRef.

## IMPLEMENTED
- startMkvDiskWarmer(baseStreamUrl) added before _initMkvTransmuxerPlayer.
- Called after startStreamingChain() in the MKV init (green-bar warm to EOF).
- Stopped (generation bump) at both teardown sites.
- Verified: npx tsc --noEmit exit 0.
- Playback buffer + transmuxer Conversion UNCHANGED. MP4 path UNTOUCHED.


## Decode crash at 118.9s (PIPELINE_ERROR_DECODE) — root cause + fix
Symptom: sequential playback crashed at ts=118.9s (P-frame), after dynamic cap
let buffer grow to 52s (more refills = more exposure).
Root cause (proven from log + code): refill stopTime came from the CUE index
(nextKeyframeAtOrAfter), but seek keyframe RESOLUTION used the SPARSE index
(findNearestKeyframe) first. The stop-boundary keyframe isn't in the sparse
index (never a seek RESULT), so the next refill seeking to it resolved an
EARLIER keyframe within the 12s tolerance → re-emitted a buffered GOP →
coded-frame replacement → stranded P-frame → decode crash.
  Log proof: refill seekTime=114.07 → resolved 105.128, overlap=8.942s.
Fix: MediabunnyTransmuxer.seekTo resolves the keyframe from the CUE index FIRST
for MKV (same index that computes stopTime), sparse only as fallback. Guarantees
nearestCueAtOrBefore(nextKfAtOrAfter(t)) === t → zero-overlap abut.
Verified: tsc exit 0; structural-identity test over 200 VBR indices / 20k refills,
overlap always 0.
