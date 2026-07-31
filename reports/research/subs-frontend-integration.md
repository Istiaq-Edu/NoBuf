# NoBuf frontend integration points for embedded subtitles

2026-07-31. Salvaged from the interrupted auditor's transcript (56 tool calls,
all evidence gathered; died before writing) + controller re-verification of
every load-bearing claim directly against source. All file:line references
checked against the working tree.

## 1. ★ Per-tier timing audit — do absolute cue times align with video.currentTime?

**Verdict: YES on all four tiers — cues need NO offset anywhere.** Evidence:

| Tier | Mechanism | Evidence |
|---|---|---|
| MP4 (mp4box MSE) | mp4box emits ABSOLUTE timestamps; SBs created without timestampOffset | SourceBufferWrapper.ts:281 "Does NOT set timestampOffset because mp4box produces absolute timestamps"; SB creation useMSEPlayer.ts:7571/7623 (no offset call) |
| MKV (MediabunnyTransmuxer) | per-seek fMP4 window is rebased; `setTimestampOffset(keyframeTimestamp)` maps it back to absolute | seek path useMSEPlayer.ts:~8570 region + audio-switch block (seekOffsetRef.current = keyframeTimestamp; sbVideo.setTimestampOffset(...)) |
| /remux (mpegts.js, timed_id3 + MKV/HEVC reroute) | ffmpeg `?ss=T` emits ABSOLUTE first PTS; `remuxer._dtsBase = 0` pin keeps mpegts.js from normalizing to 0 → currentTime ≈ T | ABSOLUTE-TIMELINE PIN comment block useMSEPlayer.ts:6059-6075; `_dtsBase = 0` at :577 and :5435. Byte-forward path (`start_byte`) rebases output to ~0 BUT the backend re-adds the base via output-ts-offset args (server.rs:2306-2311, :3226) — net absolute |
| TS (backend fMP4) | segment header `X-Segment-Start-Time` → `sb.setTimestampOffset(actualStartTime)`; `video.currentTime = actualStartTime` | useMSEPlayer.ts:8430/8440/8446; server.rs:4472 |

The overlay already reads the SAME clock as the progress bar: `time` state
(FastStreamPlayer.tsx:137) set by the `timeupdate` listener (:1072), passed as
`currentTime` to `<SubtitleOverlay>` (:2003). jassub binds the `<video>`
element directly (same clock). `SubtitleTrack.shift()` and jassub
`timeOffset` exist for manual user sync but are NOT needed for alignment.

## 2. Where embedded tracks plug in

- **Track state:** `useSubtitles()` at FastStreamPlayer.tsx:134 —
  `subs.addTrack(new SubtitleTrack(label, lang))` + `track.loadText(text)`
  exactly like the sidecar path (loadSubFile :1481-1494).
- **Lifecycle:** `subs.clearTracks()` on file change at :151 (useEffect on
  file.id). Embedded fetch must key on the same lifecycle.
- **Menu:** captions chip `case 'captions'` :1746-1764 — renders `subs.tracks`
  rows (toggleTrack) + "Load subtitle file…" (:1760). An "embedded" section
  slots between the track list and the load-file row; loading state = one
  disabled row. Chip already in ALL_CHIPS (:1532) AND defaultBarLayout
  (SettingsContext.tsx:86) — 3-place rule already satisfied; NO new chip needed.
- **Trigger point:** subtitle track ids are ffprobe stream indexes for ALL
  tiers (backend extraction), unlike audio (tier-native ids). So the list
  fetch is tier-independent → fire once per file from the main init effect
  region (same place the per-file audio reset lives, useMSEPlayer.ts:1897-1917)
  or from FastStreamPlayer's file-change effect (:151). The auditor's survey
  of tier-specific hooks (MEDIA_INFO :3777, onMP4BoxReady :7360+, MKV init
  IIFE :6620+) is NOT needed for subs — one container-agnostic call suffices.

## 3. Audio-track precedent to mirror (all verified shipped)

| Piece | Location | Reuse for subs |
|---|---|---|
| `AudioTrackInfo` + state | useMSEPlayer.ts:261, :1441-1443 | same shape: `{id,label,language,codec,isDefault,playable}` + `forced`/`sdh` badges |
| `buildAudioTrackLabel` | :302-325 | same title→language→codec→position fallback chain |
| `pickDefaultAudioTrack` | :327+ | persisted → default-disposition → first |
| localStorage LRU | :397-417 (`readPersistedAudioTrack`/`persistAudioTrack`, key `nobuf_audio_tracks`, cap ~200) | separate key `nobuf_sub_tracks`, store trackIdx or 'off' |
| `_loadRemuxAudioTracks` | :5627-5680 (fetch → stale-guard by messageId → normalize → setState) | template for `_loadEmbeddedSubTracks` |
| per-file reset | :1897-1917 (lastEffectStreamUrlRef guard) | reset sub list/selection in the SAME block |
| hook return surface | :9378+ (audioTracks/activeAudioTrackId/switchAudioTrack) | expose embeddedSubTracks + fetch state |

- Failure toasts: `toast.error(...)` from 'sonner' (FastStreamPlayer.tsx:5).

## 4. ASS/jassub specifics in place

- SubtitleOverlay.tsx:73-79 constructs `new JASSUB({video, subContent,
  workerUrl, wasmUrl, modernWasmUrl})` — **no fonts/availableFonts passed
  today**; embedded fonts = add `fonts: [urls...]` to this constructor (types
  verified in subs-lib-alternatives.md §5). Instance recreated on
  assContent change (:70-85) — fonts array can ride the same recreation.
- One ASS track active at a time (first-wins, :63); VTT multi-track stacks.
- `?url` asset imports (worker/wasm) proven under WebView2 (:18-20).

## 5. Coexistence / dedup risk

`SubtitleTrack.equals` (SubtitleTrack.ts:116-137): tracks are equal unless
BOTH label AND language differ… (`if (label !== && language !== ) return
false` — i.e. sharing either field keeps them candidates, then cue/content
comparison decides). Embedded tracks parsed from extracted text will have
different cues than a sidecar file in practice; collision risk is only for
IDENTICAL content, which is acceptable dedup. Give embedded tracks labels
prefixed from container metadata (title/language) — no "(embedded)" suffix
needed unless a label collision with a sidecar is detected at add time.

## 6. Overlay clock nuance (cosmetic, known)

`time` updates on `timeupdate` (~250 ms cadence). VTT cue boundaries can lag
up to one tick — matches FastStream behavior, already accepted for sidecar
subs. jassub is frame-accurate (rVFC). No work needed.
