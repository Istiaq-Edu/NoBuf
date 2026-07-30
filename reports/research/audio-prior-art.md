# Prior art: mid-stream audio track switching (hls.js, shaka-player, MSE/Chromium)

Written 2026-07-29 from primary sources downloaded to reports/research/_tmp/ (hls.js
master src, shaka-player main+v4.15.0 src, W3C MSE spec, Chromium source_buffer_state.cc,
MDN/Chrome-blog HTML). Sources verified locally; URLs cited per claim.

## 1. hls.js — audio switch = flush AUDIO SourceBuffer only, then refill

- Trigger flow (src/controller/audio-stream-controller.ts, raw.githubusercontent.com/
  video-dev/hls.js/master/src/controller/audio-stream-controller.ts):
  `AUDIO_TRACK_SWITCHING` → `flushAudioIfNeeded()` (asc.ts:508 → :1091-1112) → state IDLE →
  fragment reload → `completeAudioSwitch` fires `AUDIO_TRACK_SWITCHED` (:1115-1120).
- Flush semantics (:1102-1105): when the new track differs (audioCodec/lang/channels
  mismatch via `audioMatchPredicate`) and alternate audio is in use:
  `super.flushMainBuffer(0, Number.POSITIVE_INFINITY, 'audio')` — i.e. **remove
  [0, ∞) on the AUDIO SourceBuffer only; video buffer untouched**.
- Cross-codec switches: buffer-controller.ts `appendChangeType(type, container, codec)`
  (bc.ts:726-737) queues a `changeType(mimeType)` operation on that SourceBuffer whenever
  the pending codec differs (bc.ts:680-685). Same-codec switches skip changeType.
- Config `nextAudioTrackBufferFlushForwardOffset`-style tuning exists in the API doc for
  when flushing starts relative to playhead (docs/API.md).

## 2. shaka-player — selectAudioLanguage → switchInternal_ → clearBuffer_

- `player.selectAudioLanguage(language, role, channelsCount, safeMargin, codec, ...)`
  (lib/player.js v4.15.0 :6190-6215) reconfigures the adaptation criteria then switches
  variant; the media-source path ends in streaming_engine.js `switchInternal_(stream,
  clearBuffer, safeMargin, force)` (se.js :623+).
- `clearBuffer_(mediaState, flush, safeMargin)` (se.js :3109+): with safeMargin>0 it
  removes **from (presentationTime + safeMargin) to duration** — keeps a protective
  window ahead of the playhead so playback never stalls during the swap (gapless-ish);
  with safeMargin=0 it clears the whole buffer for that content type and re-fetches.
  Only the switched type's SourceBuffer is cleared (mediaState is per-type).
- Cross-codec: media_source_engine.js uses `changeType` guarded by the configured
  `codecSwitchingStrategy` (SMOOTH vs RELOAD — RELOAD tears down and re-inits MediaSource
  when changeType isn't safe/supported).
- Docs: https://shaka-player-demo.appspot.com/docs/api/shaka.Player.html#selectAudioLanguage

## 3. MSE spec + Chromium facts

- **Init-segment-received algorithm** (W3C media-source-2, w3.org/TR/media-source-2/
  §"initialization segment received", verified in downloaded spec text): a subsequent
  init segment appended to an existing SourceBuffer must satisfy:
  1. "The number of audio, video, and text tracks match what was in the FIRST
     initialization segment";
  2. multi-track case: "the Track IDs match the ones in the first initialization segment";
  3. codecs supported — and codecs NOT in the last successful `changeType()`/`addSourceBuffer()`
     type MAY be treated as unsupported → append error.
  ⇒ Swapping to a DIFFERENT muxed audio track in-place is spec-legal only if the new init
  segment presents the same track count — a single-audio-track init segment whose track id
  differs from the first one violates (2) for multi-track buffers; for single-track
  buffers Chromium tolerates id changes via TrackIdChanges remapping (below).
- **Chromium enforcement** (media/filters/source_buffer_state.cc, chromium.googlesource.com):
  `OnNewConfigs` (sbs.cc:~576+) rejects duplicate bytestream track ids, allows codec
  changes only in `PENDING_PARSER_RECONFIG` (i.e. after `changeType()` — "MSE spec allows
  new configs to be emitted only during RunSegmentParserLoop"), and maintains
  `FrameProcessor::TrackIdChanges` to remap a changed track id when track COUNT is stable.
- **SourceBuffer.changeType() support**: shipped Chrome 70 (chromestatus feature
  5719220952236032; developer.chrome.com/blog/new-in-chrome-70; MDN "SourceBuffer:
  changeType() — Chrome ≥70"). WebView2 = Edge Chromium ⇒ available. Needed only for
  cross-codec swaps; same-codec re-init-segment appends don't require it.

## 4. Implications for NoBuf (WebView2 player that rebuilds on seek anyway)

- The hls.js/shaka pattern (flush audio SB + refill from a separately-fetchable audio
  rendition) presumes DEMUXED audio delivered as its own stream. NoBuf's tiers deliver
  MUXED containers (fMP4 from mp4box/mediabunny re-segmentation, TS from ffmpeg): there
  is no independent audio-only fetch path, so an in-place audio-SB swap would still
  require re-demuxing the container from the playhead — the expensive part is identical
  to a seek-rebuild.
- Chromium's constraints (track-count stability, changeType-gated codec changes,
  WebView2's already-observed DOMException quirks) make the in-place path the FRAGILE
  option here, for zero latency win over the existing, battle-tested rebuild machinery.
- **Verdict: rebuild-from-playhead per tier is the correct engineering choice.** It
  matches shaka's own RELOAD strategy fallback, reuses each tier's proven seek path
  (flush + re-init + resume, pause-preserving), and confines new code to (a) track
  enumeration/labeling and (b) a desired-track parameter threaded into each tier's
  existing rebuild entry point. The in-place swap should be revisited only if
  measured switch latency is unacceptable (unlikely: seeks are already ~1-3s and the
  audio switch reuses warmed caches).
