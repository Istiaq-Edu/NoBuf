# Cross-validation: audio-track-selection research (7 docs)

2026-07-29. Every load-bearing claim re-derived from source AFTER the research docs were
written. Method: direct reads/greps of server.rs, useMSEPlayer.ts, MediabunnyTransmuxer.ts,
vendored mediabunny/mp4box/mpegts.js. Verdicts: VERIFIED / FALSIFIED / INCONCLUSIVE.

## Backend (audio-backend-remux.md — author: orchestrator, self-verified at write time)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| B1 | probe keeps ONE audio stream, first real (channels>0, !=id3), no language tags | VERIFIED | parse_probe_json server.rs:2499-2535 read directly |
| B2 | StreamQuery params: token/cached_only/duration/source_id/max_bytes/ss/start_byte/hevc_ok | VERIFIED | :319-367 read directly |
| B3 | remux cache keyed `{folder}_{msg}.mp4` — NOT by track; Phase-1 serve happens BEFORE probe | VERIFIED | :2617-2634 (cache check) vs :2698 (probe) |
| B4 | all ffmpeg sites consume the one `audio_stream_idx` local | VERIFIED | `-map 0:{}` at :2870, :3051; bg job :3272; builders :5789-5833 |
| B5 | no track-list endpoint exists | VERIFIED | handler grep; /fmp4/metadata is duration-only |

## MKV tier (audio-frontend-mkv-state.md — subagent)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| K1 | 5th getPrimaryAudioTrack site INSIDE seekTo (hot path) | VERIFIED | MediabunnyTransmuxer.ts:1321 |
| K2 | seekTo: abortFlag :1219, seekGeneration++ :1230, persistent MKV Input reuse :1249 | VERIFIED | [C1] sed check |
| K3 | addAudioTrack(audioSource) bare — no metadata/options | VERIFIED | :1424-1431 [C2] |
| K4 | Conversion.execute never used for MKV playback (vestigial) — all via seekTo | VERIFIED | useMSEPlayer.ts:6118-6128 comment [C3] |
| K5 | hook return object :8798+, no audio surface | VERIFIED | [C4] |
| K6 | isPausedRef written ONLY at :8550 (pause) / :8589 (resume) | VERIFIED | [C5] grep — exactly 2 writes |
| K7 | MKV = ONE combined SourceBuffer (audio rides in same fMP4) | VERIFIED | :6080-6083 [C6] "created combined SourceBuffer" |

## MP4 tier (audio-frontend-mp4box.md — subagent)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| M1 | selection hardcoded audioTracks[0] | VERIFIED | :6982-6987 [C7] |
| M2 | MP4BoxTrack iface lacks language/name/channel_count | VERIFIED | :887-894 [C8] |
| M3 | copy loop drops metadata mp4box provides | VERIFIED | :6938-6945 [C10]; mp4box getInfo provides language/name/audio.* (L1 below) |
| M4 | onSegment routes by closure-captured trackIds | VERIFIED | :7129-7130 [C9] |
| M5 | seek path = mp4box.seek+flush, never unset/re-init segmentation | VERIFIED | :7265-7266 [C11]; grep unsetSegmentOptions in src = 0 hits |
| M6 | verdict: fresh-instance re-init from playhead is the safe switch path | VERIFIED (by L2-L4) | — |

## mediabunny lib (audio-lib-mediabunny.md — subagent)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| L1a | ConversionOptions: tracks 'all'\|'primary' + per-track audio callback | VERIFIED | mediabunny.d.ts:1007, :1031 [C13] |
| L1b | ConversionAudioOptions.discard for per-track exclusion | VERIFIED | d.ts:929-931 (spot-checked earlier) |
| L1c | InputTrack: getLanguageCode/getName/getDisposition | VERIFIED | d.ts:2327/2334/2357 [C14] |
| L1d | Output.addAudioTrack(source, metadata?: AudioTrackMetadata{languageCode,name,disposition}) | VERIFIED | d.ts:3265 [C15] |
| L1e | mpegts.js: first audio PID wins, no selection | VERIFIED | ts-demuxer.ts:779-794 [C18] |

## mp4box lib (audio-lib-mp4box.md — subagent)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| L2 | vendored version is 0.5.4 (not 0.5.2) | VERIFIED | package.json [C16] |
| L3 | seek() is GLOBAL — iterates all moov.traks (video cursor rewinds too) | VERIFIED | isofile.js:628-632 [C17] |
| L4 | setSegmentOptions forces trak.nextSample=0 | VERIFIED | isofile.js:64 [C17] |
| L5 | getInfo exposes language (elng→mdhd), name, codec, audio.channel_count | VERIFIED | isofile.js getInfo (quoted in doc, spot-matched) |

## Prior art (audio-prior-art.md — orchestrator, from downloaded primary sources)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| P1 | hls.js flushes AUDIO SB only: flushMainBuffer(0,∞,'audio') | VERIFIED | asc.ts:1102-1105 (downloaded master) |
| P2 | shaka clearBuffer_ + safeMargin removes (playhead+margin, duration) | VERIFIED | se.js:3109+ |
| P3 | MSE spec: subsequent init segment must match FIRST init segment's track count; multi-track needs matching Track IDs; codec changes gated on changeType | VERIFIED | w3.org/TR/media-source-2 text @ downloaded spec (offsets 99607/101293) |
| P4 | changeType shipped Chrome 70 | VERIFIED | chromestatus feature 5719220952236032 + Chrome 70 blog |
| P5 | Chromium remaps changed track ids when count stable (TrackIdChanges) | VERIFIED | source_buffer_state.cc OnNewConfigs |

## UI/UX (audio-ui-ux.md — orchestrator, self-verified at write time)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| U1 | chip registry chipButton(id) :1734; captions case :1744-1762; verbatim classNames | VERIFIED | FastStreamPlayer.tsx read directly |
| U2 | no per-file persistence anywhere (only sidebar/theme keys) | VERIFIED | localStorage grep — 8 hits, all sidebar/theme |
| U3 | MediaPlayer.tsx has no subtitle/controls UI | VERIFIED | grep = imports only |

## NEW HAZARDS found by cross-validation (not in any single research doc)

1. **H1 — MKV combined-SB codec change**: K7 + P3 interact. The MKV tier's single
   SourceBuffer was created with `mimeType` including the CURRENT audio codec (:6080).
   Switching to a track with a different codec (AAC→AC3/Opus/FLAC) produces init segments
   whose audio codec is not in the SB's declared type → MSE spec allows append-error.
   Plan must: derive the new combined mimeType; if it differs, `changeType()` (Chrome 70+,
   WebView2 OK) before appending the new init segment; if `isTypeSupported` fails for the
   new mime entirely (codec MSE can't play at all) → do NOT offer in-place switch; route
   that file to /remux with audio_idx (ffmpeg → AAC) instead.
2. **H2 — Phase-1 cache-serve ordering (B3)**: /remux serves the cached file BEFORE
   probing. With audio_idx in the cache key this stays correct only if the key uses the
   RAW query param (not the probe-validated idx). An out-of-range param would create a
   junk-keyed cache entry for a stream that actually contains the primary track. Fix:
   validate audio_idx BEFORE the Phase-1 check when the param is present (validation
   needs the probe → param requests skip the pre-probe fast path; acceptable, or
   cheaper: cache key uses raw param, and the ffmpeg map falls back to primary on
   invalid → the junk key simply aliases primary-track output; still correct audio,
   wastes one cache file. Choose in plan: validate-first for correctness).
3. **H3 — mediabunny audio codec support on switch (MKV)**: the manual packet-copy path
   is copy-only (EncodedAudioPacketSource). A track whose codec fails
   `decideMseCodec`/`isTypeSupported` (:436-450 in MediabunnyTransmuxer) can't be
   in-place-switched — same fallback as H1: offer via /remux tier only, or hide with a
   tooltip. Plan carries a per-track `playable: boolean` flag.

## INCONCLUSIVE items (must be resolved during implementation, not assumed)

- I1: whether mediabunny's `getAudioTracks()` on the persistent MKV Input is cheap
  (metadata already parsed) — expected yes (SeekHead/Cues cached per K2), verify with a
  timing log during impl.
- I2: exact behavior of mp4box fresh-instance-from-cached-moov path — the moov buffer IS
  retained (getMoovBuffer exists in hook return [C4]), but the re-init flow must be
  exercised by a test/e2e before the MP4 switch ships.
- I3: mpegts.js on /remux output after a track switch mid-play: the recreate path is
  proven (timed_id3/seek), but the FIRST switch of a file whose Phase-1 cached remux
  exists for the OLD track only — the new-track request must bypass/miss that cache
  cleanly (covered by H2 fix; verify in e2e).
