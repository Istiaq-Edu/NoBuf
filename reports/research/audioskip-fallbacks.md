# MKV audio-skip — fallback tiers beyond the transmuxer (verified against source)

> Angle doc for the audio-skip fan-out. The dispatched subagent died before starting
> (provider HTTP 405, 60s, zero output); this doc was researched directly instead.
> Every claim cites live source.

## 1. What exists today, tier by tier (AVC-MKV)

| Tier | Trigger today | Mechanism | State |
|---|---|---|---|
| 1. MediabunnyTransmuxer (client fMP4) | `mkvCodec === 'avc'` (useMSEPlayer.ts:3171) | mediabunny cluster demux → fMP4 into combined SB | Default; the failing tier |
| 2. `/remux` → mpegts.js | **transmuxer INIT failure only** (:3175-3177 fall-through) | server ffmpeg: `-c:v copy` (AVC 8-bit, :2428) + **`-c:a aac -b:a 192k -af AAC_LAYOUT_FILTER`** (:3228-3231), `-f mpegts` → mpegts.js MSE | Wired, proven (HEVC-MKV route + TS-HEVC recovery use it) |
| 3. native `<video>` on raw MKV | video `error` event → `setUseNative(true)` (:9497-9520) | `<video src=stream URL>` | **Dead end** — WebView2 has no MKV demuxer; black screen. This is what the user hit AFTER the SB fatal |

Key asymmetry: tier 2 catches **init-time** failures; the audio-skip fatal is
**post-init** (first append), and post-init fatals route to tier 3 (dead), not tier 2.
`audioskip-codebase.md §4c/§6.5` documents the same gap from the code side.

## 2. Does `/remux` handle the repro class? — yes, by construction

- ffmpeg reads the MKV **linearly on stdin** (pipe:0; server.rs:352-354 comment: no
  `-ss` on pipe input) — cue-less-ness is irrelevant to it.
- Audio is **re-encoded to AAC** with explicit stream mapping by ffprobe-resolved
  index (:3223-3224) and channel-layout normalization (:3229-3231) — the 29 ms
  audio-delay start is preserved by ffmpeg's muxer; mpegts.js gets a fully
  spec-compliant TS. Audio play out of tier 2 is guaranteed for anything ffmpeg
  decodes (AAC/AC3/EAC3/DTS/Opus/FLAC…).
- `?audio_idx=N` override already validated server-side
  (`validate_audio_idx_override`, :2534-2545) and threaded through all 6 frontend
  /remux URL builders (`withAudioIdx`, useMSEPlayer.ts:378) — the user's audio pick
  survives a tier-2 reroute.
- Costs: server CPU (AAC encode ~realtime×many for one stream; video is copy),
  disk cache one .ts per (file, audio_idx), and mpegts.js-tier UX (ss-only seeks via
  `needsRemuxSeekRef`, hover thumbs go through /thumb) — all already accepted on the
  HEVC-MKV route (:3184-3224).

## 3. What each candidate escape hatch costs

| Option | Audio? | Latency to first frame | Seek UX | New machinery |
|---|---|---|---|---|
| Stay tier 1 + fix lookup (mediabunny fallback chain) | yes (real) | none (same tier) | native fMP4 | ~15 lines transmuxer |
| Tier 1 video-only (declare-what-you-emit) | **no** | none | native | mime consistency + UI "no audio" affordance |
| Full MediaSource rebuild w/ audio re-probe | yes if probe succeeds on retry | ~1-3 s (re-init) | native | rebuild orchestration (Shaka reset shape; §4a codebase doc) |
| **Tier 2 reroute post-init (MKV variant of `_recoverToRemuxTier`)** | **yes (AAC re-encode)** | ~2-4 s (ffmpeg spin-up + mpegts.js init) | ss-only | recombination of existing pieces (codebase doc §4c: dispose transmuxer, `remuxSourceIsTsRef=false`, `needsRemuxSeekRef=true`, resume at playhead) |
| Native `<video>` (today's post-init route) | — | — | — | **produces a dead player for MKV; must stop being the MKV fatal route** |

## 4. Product verdict on "silent video" compromises

The app's own precedents (TS-HEVC fatal recovery, HEVC-MKV reroute) chose
**"working playback on a lesser tier" over "broken playback on the best tier"** every
time. A silent movie is a support ticket, not a fallback: any path that knowingly
ships video-only MUST be at most a transient state (e.g. while a rebuild retries),
never the terminal state, and the terminal state for un-fixable client audio is
tier 2 (server AAC), which always has audio.

## 5. Implication for the fix ladder

1. Fix the lookup in tier 1 (root cause; keeps the best tier).
2. If audio still unresolvable → **do not close the audio source into a 2-codec SB**
   (Chromium hard-fails; standards doc §2). Either declare video-only or go tier 2.
3. Post-init SB fatal on AVC-MKV → tier-2 reroute at playhead (NOT `useNative`).
4. Native `<video>` stays reserved for MP4/faststart cases where it actually works.
