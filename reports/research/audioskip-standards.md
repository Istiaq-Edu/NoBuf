# MSE 1-track-init vs 2-codec-mimeType — standards & engine research

> Angle doc for the audio-skip fan-out (subagent-researched from engine sources:
> Chromium source_buffer_state.cc / chunk_demuxer.cc / Blink source_buffer.cc +
> media_source.cc, WebKit SourceBuffer.cpp, Gecko TrackBuffersManager.cpp, W3C MSE
> spec + ISOBMFF byte-stream spec, and hls.js / Shaka / mux.js / mpegts.js sources.)

## 1. W3C MSE spec (§5.5.7 "Initialization Segment Received")

- **Step 2**: init segment with **zero** tracks → append error.
- **Step 3.1** (every init segment after the first): number of audio/video/text tracks
  must **match the first initialization segment** — else append error. This baseline is
  **NOT reset by `changeType()`** (changeType only sets a pending-init flag; it never
  touches the track-set baseline). **Track-set changes on a live SourceBuffer are
  illegal in the spec itself.**
- **Step 5.1 note**: the UA **MAY** reject codecs "not specified in the `type`
  parameter passed to addSourceBuffer()/most recent changeType()". This MAY is the
  entire cross-browser divergence.
- `SourceBuffer.buffered` = **intersection** of per-track buffered ranges. A declared
  audio track with no data ⇒ empty intersection ⇒ player sees nothing buffered ⇒ stall.

## 2. Chromium / Edge / WebView2 (our runtime) — the strictest engine

- String-based `addSourceBuffer(type)` arms **strict codec expectations**:
  `ChunkDemuxer::AddId` → `AddIdInternal(..., ExpectedCodecs(type, codecs))`
  (chunk_demuxer.cc:692-718) → `SourceBufferState::InitializeParser` sets
  `strict_codec_expectations_ = true` (source_buffer_state.cc:539). Chromium exercises
  the spec's MAY as a hard MUST — **on every init segment, not just the first**.
- In `OnNewConfigs` each init-segment track consumes one expected codec:
  - Declared codec **missing** from init segment →
    `"Initialization segment misses expected <codec> track."` → append failure
    (source_buffer_state.cc:760-769). **Exactly our failure.**
  - Track present but not declared → `"…doesn't match SourceBuffer codecs."` (:617-627).
  - Track type that didn't exist in the FIRST init segment →
    `"Got unexpected audio track track_id=…"` (:659) — demuxer streams are created
    only on the first init segment (:630).
- Blink duplicates spec step 3.1: track-count mismatch vs first init →
  `"tracks mismatch the first init segment."` (source_buffer.cc:1567-1600).
- Failure surfaces as append error → `endOfStream("decode")` (source_buffer.cc:
  2196-2228) → `CHUNK_DEMUXER_ERROR_APPEND_FAILED`; MediaError **code 4**
  (SRC_NOT_SUPPORTED) when it was the FIRST append, code 3 (DECODE) mid-stream.
- `changeType()` re-arms the expected-codec list (SourceBufferState::ChangeType →
  InitializeParser, :157-171) and allows CODEC changes on EXISTING streams
  (`allow_codec_changes = state_ == PENDING_PARSER_RECONFIG`, :605). But it **cannot
  add or remove a track type** — the stream set stays pinned to the first init segment.
- Non-fatal detail: a 2-track init segment followed by media segments with **no audio
  frames** is only a DEBUG log ("Media segment did not contain any coded frames for
  track", OnEndOfMediaSegment :831) — legal per engine, but the buffered-range
  intersection still starves playback (§1).

## 3. WebKit & Gecko — lenient on codecs, strict on track count

- **WebKit**: validates **track counts vs the first init segment only**
  (SourceBuffer.cpp:1075-1086); mimeType codecs are never compared to init content.
  Video-only init on a 2-codec SB **works in Safari** — why this bug class ships and
  then explodes only on Chromium.
- **Gecko**: same shape — count check present, spec step 5.1 codec check is literally
  a `// TODO` (TrackBuffersManager.cpp:1440-1483).

## 4. Production-player prior art for this exact class

- **hls.js** (buffer-controller.ts): (a) **defers addSourceBuffer until all expected
  tracks are parsed** (bufferCodecEventsTotal/checkPendingTracks :1743-1770) — mime is
  built from ACTUAL parsed tracks, never manifest promises; (b) muxed↔split transitions
  are "Unsupported transition" → deliberate BUFFER_APPEND_ERROR → app-level
  `recoverMediaError()` = **full MediaSource rebuild** (:626-642); (c) changeType used
  ONLY for codec swaps within the same track set (:680-685); (d) remuxer **fills
  missing audio with silent AAC frames** (AAC.getSilentFrame, mp4-remuxer.ts:1017-1100)
  so the audio track never disappears from segments.
- **mux.js**: same idea — `prefixWithSilence` + pregenerated `coneOfSilence` frames per
  sample rate (audio-frame-utils.js).
- **Shaka** (media_source_engine.js:2745-2872): explicit decision — same codecs ⇒
  nothing; codec change w/ platform smooth-switch support ⇒ changeType; **anything
  else (incl. track-set changes) ⇒ full MediaSource RESET** (reset_() tears down and
  re-creates MediaSource + SourceBuffers). Shaka issue **#5946** is our exact symptom
  (CHUNK_DEMUXER_ERROR_APPEND_FAILED on mixed-codec HLS), fixed in 4.6.3 by correcting
  the reset-vs-changeType decision.
- **mpegts.js/flv.js** (mse-controller.js:225-255): builds the mime string **from the
  init segment the transmuxer actually emitted**, only then addSourceBuffer —
  declaration can never diverge from content.

## 5. mediabunny 1.45.4 (cross-confirmed with audioskip-mediabunny.md)

- moov built from `muxer.trackDatas` (isobmff-boxes.js:286), written at fragment-#1
  finalize (isobmff-muxer.js:804-816); trackDatas entries created only on a track's
  FIRST sample (:176/:258); a source closed before its first sample counts as "known"
  (allTracksAreKnown :145-152) and **never appears in the moov**.
- ⇒ audioSkipped path emits a video-only ftyp+moov while `buildMimeType`
  (MediabunnyTransmuxer.ts:516) still declares 2 codecs → Chromium hard-fails.
  The comment at :1449-1454 claiming otherwise is **wrong for v1.45.4**.
- `output.getMimeType()` (isobmff-muxer.js:153) reflects the ACTUAL emitted track set.

## 6. Engine-law-compliant fix matrix

1. **Match declaration to emission (minimum)**: when audioSkipped, the SB must be
   created (or changeType'd BEFORE the append) as video-only. But the FIRST init
   segment pins the SB's track set forever — audio can never be added to that SB later.
2. **Restore audio later ⇒ full MediaSource rebuild** (Shaka RESET / hls.js
   recoverMediaError pattern). changeType is NOT capable of 1-track→2-track in any
   engine (spec step 3.1 + Chromium "Got unexpected audio track").
3. **Best UX (hls.js/mux.js precedent): never drop the audio track — inject silence**
   across the gap until real audio resumes. One packet unblocks mediabunny's
   fragment-1 gate; continued silent frames keep the buffered intersection non-empty.
   (AAC-only tables in prior art; generalizing to AC3/Opus is non-trivial.)
4. The existing rebuild-changetype audio-track-switch path (useMSEPlayer.ts:5997) stays
   valid — same track set, codec change only (PENDING_PARSER_RECONFIG).
5. Cheap guard: before appending any init segment, verify actual track count (count
   `trak` boxes or consult muxer state) against the SB's declared codec count; route
   mismatches to rebuild instead of letting Chromium throw.
6. Grep-able Chromium diagnostics: "Initialization segment misses expected",
   "doesn't match SourceBuffer codecs", "Got unexpected audio track",
   "tracks mismatch the first init segment", CHUNK_DEMUXER_ERROR_APPEND_FAILED.
