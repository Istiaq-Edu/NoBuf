# NoBuf — Future Work Overview

Source-audited 2026-07-29 (branch `dev` @ `a6e3ce9` + working tree). Three known gaps in the
media experience, ranked by user impact. Codec/container engine itself is mature — see
`reports/format-codec-support-matrix.html`.

---

## 1. Embedded subtitle extraction — LARGE

**Gap:** Only sidecar files (.srt/.vtt/.ass/.ssa) work today, loaded manually by the user.
Subtitle tracks INSIDE the container are never extracted; the `/remux` tier actively strips
them (`-sn`, server.rs). The MKV/anime crowd hits this immediately.

**Approach sketch:**
- Backend: new endpoint pair — `GET /subs/{folder}/{msg}/list` (ffprobe `-show_streams
  -select_streams s` → track index/language/codec JSON) and `GET /subs/{folder}/{msg}/{idx}`
  (ffmpeg `-map 0:s:<idx>` → SRT for text codecs, raw .ass for ASS/SSA). Both read the
  Range-seekable `/stream` input — works on uncached files (only the moov/head + subtitle
  packets are fetched; text subs are tiny).
- Frontend: track list in the existing subtitle menu; feed extracted SRT through the existing
  `SubtitleTrack` parser, ASS through the existing jassub path. No new rendering code.
- Remux tier: keep `-sn` (subs can't live in MPEG-TS here) — extraction is a separate
  endpoint, so no conflict.

**Edge cases to plan for:** image-based subs (PGS/VobSub — WebVTT can't render; either
skip with a message or rasterize later), multi-language menus, subtitle packets scattered to
EOF on uncached files (ffmpeg must read far — acceptable for text-size data), ASS embedded
fonts (jassub supports attachments — phase 2).

**Est. effort:** backend endpoint + frontend menu + parser glue; the largest of the three.

---

## 2. Audio track selection — MEDIUM-LARGE

**Gap:** Every tier plays the first/primary audio track only. Dual-audio MKVs (JP+EN etc.)
always play track 1 with no way to switch.

**Approach sketch (per tier — this is why it's not small):**
- **/remux tier** (MP4-HEVC, MKV-HEVC, timed_id3): easiest — add `&audio_idx=N` query param,
  backend maps `-map 0:<idx>` (the map plumbing already exists; today it uses the ffprobe-
  resolved primary). Seek recreation already rebuilds the URL, so switching = recreate player.
- **MKV transmuxer tier:** mediabunny `getAudioTracks()` → pick track, rebuild Conversion.
  Requires transmuxer re-init on switch (same cost as a seek).
- **MP4 MSE tier:** mp4box exposes all audio tracks; switch = new audio SourceBuffer +
  re-segment from current position.
- **TS mpegts.js tier:** hardest — mpegts.js has no track selection; would need backend PID
  remapping in the TS stream (or accept single-track for TS, which covers broadcast reality).
- UI: audio menu next to the subtitle menu; persist per-file choice.

**Recommended scope cut:** ship /remux + MKV + MP4 tiers, explicitly skip TS (single-track
TS is the norm). Cuts the effort near-half.

---

## 3. TS-HEVC fallback lands on a broken player — SMALL  ★ **DONE 2026-07-29**

**Gap (as found — worse than first sized):** HEVC inside MPEG-TS on a machine WITHOUT the
"HEVC Video Extensions" had FOUR broken endings, not two:
- `addSourceBuffer('…hvc1…')` fails with `video.error` unset → misclassified as SourceBuffer
  **quota** → suspend + wait for eviction that can never help → **infinite hang** (worst case).
- `CodecUnsupported` → player destroyed, **no fallback at all** → 60s dead wait → then ↓.
- FATAL handler + mpegts-init-failure path → `/remux` URL (built **without hevc_ok**) handed
  to native `<video>` — which cannot demux MPEG-TS → black screen.

**Fix (shipped):** all four paths now recover to the e2e-proven timed_id3 tier — mpegts.js
recreated on `/remux?hevc_ok=<probe>` with byte-forward seeks, prebuffer, duration override
and server-side `/thumb` hover thumbnails. Loop guard (never re-recover a /remux failure),
one-shot guard, playhead resume (≥8s), paused-stays-paused, 60s dead wait removed
(immediate reject). Plan + edge cases: `reports/ts-hevc-fallback-fix-plan.md`; tests:
`src/__tests__/TsHevcRecovery.test.ts` (17 new, 321 total passing). Needs a real-machine
`tauri dev` e2e pass with an HEVC-TS file to close.

---

## Suggested order

3 (small, closes a *broken* path) → 1 (highest user value) → 2 (scope-cut version).
