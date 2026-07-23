# Implementation Plan — Universal Transcode Tier (VERIFIED)

Supersedes the original draft. Every step here is grounded in the cross-validation
report (`.hermes/plans/cross-validation-report.md`) — source-verified, execution-verified
on the real Panchayat file, and internet-verified. Line anchors confirmed current.

Target file: `Panchayat.S02E01.1080p.10bit.AMZN.WEBRip.HIN.DDP5.1.x265.HEVC.ESub-LSSJBroly.mkv`
(idx0 hevc Main10 bt709 SDR, idx1 eac3 5.1(side), idx2 ass subs, idx3 mjpeg cover art).

## Core insight (why blast radius is small)
The frontend ALREADY routes HEVC MKV → `/remux` (useMSEPlayer.ts:2391). The production
crash was the backend doing `-c:v copy` → feeding hvc1 10-bit to mpegts.js → MSE rejects it.
**Fix = backend transcodes HEVC→H.264 inside `/remux`.** mpegts.js then gets avc1 and plays.
The eac3 EINVAL also vanishes because transcoding video re-times the muxer (proven). So the
Panchayat fix is **backend-only**; frontend changes are limited to the OPTIONAL HDR carve-out
(Phase 6) which is for OTHER files, not this one.

## Verified encoder commands (from Probe 3, real file over HTTP)
- **Primary — full-HW QSV** (8.29x realtime, 2.1s cold-start, decode-clean):
  `-hwaccel qsv -hwaccel_output_format qsv -c:v hevc_qsv -i IN -map 0:V -map 0:a -sn -vf vpp_qsv=format=nv12 -c:v h264_qsv -c:a aac -b:a 192k -f mpegts ...`
- **Fallback — libx264** (5.87x, decode-clean):
  `-i IN -map 0:Vidx -map 0:aidx -sn -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 192k -f mpegts ...`
- NOT the `hwupload,vpp_qsv` chain — errors 80070057 (E_INVALIDARG) on this GPU.

---

## DECISION LOCKED: Option B — capability-based gating (not a bit-depth heuristic)
`needs_transcode` answers "can the player actually decode this?", NOT "is it 10-bit?".
Decision table (evaluated in REMUX-PROBE, Phase 2):
  - codec h264/avc                              → copy / client transmuxer (NEVER transcode)
  - codec vp8/vp9/av1                           → native <video> (NEVER transcode)
  - codec hevc, pix_fmt > 8-bit (10le/12le)     → TRANSCODE (MSE rejects Main10 always)
  - codec hevc, 8-bit, HEVC extension ABSENT    → TRANSCODE (addSourceBuffer(hvc1) would fail)
  - codec hevc, 8-bit, HEVC extension PRESENT   → copy (cheap path; player can decode)
  - true HDR (HDR10/HLG)                        → native (Phase 6); DV P5 → transcode
Rationale: Probe 1 proved THIS machine has no HEVC extension, so 8-bit HEVC would ALSO fail
MSE — a bit-depth-only gate would leave 8-bit HEVC rips silently broken. HEVC-extension state
is read once (cached) via a precheck alongside the QSV precheck (Phase 1).
GUARANTEE: anything that plays today without transcode keeps `-c:v copy` byte-for-byte.
Transcode only ever REPLACES what is already unplayable; it never touches a working cheap path.

NOTE on where the HEVC-extension check lives: the backend can't easily query the Windows
AppX HEVC extension. The RELIABLE signal is the frontend's `video.canPlayType('video/mp4;
codecs=hvc1...')` (already read at useMSEPlayer.ts:5796). So for 8-bit HEVC the capability
decision is frontend-assisted: the frontend passes a `&hevc_ok=0|1` hint to /remux based on
canPlayType, and the backend gates copy-vs-transcode on it. 10-bit HEVC ALWAYS transcodes
regardless (MSE rejects Main10 even with the extension, per E2 table: extension enables
DECODE via native/WebCodecs, but mpegts.js MSE path still can't take hvc1.2). This keeps the
"only transcode what can't play" guarantee honest across machines.

---

## PHASE 0 — Green baseline (gate before any edit)
- [ ] 0.1 `cd app/src-tauri && cargo build --no-default-features` → must succeed.
- [ ] 0.2 `cd app && npx tsc --noEmit` → must succeed (authoritative; ignore per-file lint noise).
- [ ] 0.3 `git status` clean except plan docs + the .mkv. Record baseline compile OK.
VALIDATION: both builds green BEFORE touching code, so any later break is attributable.

## PHASE 1 — Backend: QSV capability precheck (server.rs)
Reason: piped Strategy B streams bytes immediately; can't fall back mid-stream. Must know
BEFORE spawning whether QSV works, else libx264. Decide once, cache.
- [ ] 1.1 Add a `static` (OnceCell / lazy) `qsv_h264_available: bool`, computed by spawning
      `ffmpeg -hide_banner -f lavfi -i color=black:s=64x64 -vframes 1 -c:v h264_qsv -f null -`
      and checking exit 0. Log the result once.
- [ ] 1.2 Helper `fn build_video_encoder_args(needs_transcode, qsv_ok) -> Vec<String>` returning
      either `["-c:v","copy"]` (h264 input), the QSV arg set, or the libx264 arg set.
VALIDATION: unit-log the chosen path; `cargo build`. Manual: confirm precheck logs true on this box.

## PHASE 2 — Backend: extend REMUX-PROBE to classify (server.rs ~2113-2163)
- [ ] 2.1 In the existing `-show_streams` loop, also capture for the chosen video stream:
      `codec_name`, `pix_fmt`, `profile`. Derive `needs_transcode = video_codec_name != "h264"
      || pix_fmt contains "10le"/"12le"`. (h264 8-bit → copy; hevc/anything/10-bit → transcode.)
- [ ] 2.2 Add a SECOND, frame-level ffprobe call (only when video needs classifying):
      `ffprobe -show_frames -read_intervals "%+#1" -select_streams v:0 -show_entries
      frame=color_transfer,color_primaries,color_space`. Derive `is_hdr = transfer in
      {smpte2084, arib-std-b67} || primaries == bt2020`. (Frame-level is MANDATORY — stream-level
      misses transfer; proven C3/C4.) Cache alongside stream indices.
- [ ] 2.3 Log `[REMUX-PROBE] needs_transcode={} is_hdr={} vcodec={} pix_fmt={}`.
VALIDATION: `cargo build`. Manual (tauri dev) on real file → log must show
`needs_transcode=true is_hdr=false vcodec=hevc pix_fmt=yuv420p10le`.

## PHASE 3 — Backend: transcode in Strategy B / piped (server.rs ~2301-2341)
- [ ] 3.1 Replace hardcoded `-c:v copy` (line 2322) with `build_video_encoder_args(...)`.
- [ ] 3.2 Ensure explicit `-map 0:<video_idx> -map 0:<audio_idx> -sn` (keep existing explicit
      maps; ADD `-sn` to drop the ass subs; explicit maps already exclude the idx3 mjpeg cover art).
- [ ] 3.3 For QSV full-HW, prepend `-hwaccel qsv -hwaccel_output_format qsv -c:v hevc_qsv` BEFORE
      `-i` and append `-vf vpp_qsv=format=nv12`. For libx264 append `-pix_fmt yuv420p`. Keep
      `-c:a aac -b:a 192k`. Keep existing `-fflags/-avoid_negative_ts/asetpts/max_interleave_delta`
      (harmless with transcode; leave as-is to minimize diff).
- [ ] 3.4 Keep `-mpegts_flags resend_headers`.
VALIDATION: `cargo build`. Manual: tauri dev → Panchayat plays via mpegts.js (avc1), no
addSourceBuffer error, no aac muxer EINVAL. This is THE hand-test.

## PHASE 4 — Backend: mirror transcode in Strategy A (disk) + background remux
Reason: 2nd play serves from disk cache (Strategy A ~2187-2206) and background disk remux
(~2431+). If those still `-c:v copy`, replay re-breaks. Must transcode identically.
- [ ] 4.1 Apply `build_video_encoder_args` to Strategy A remux command (~2202).
- [ ] 4.2 Apply to the background disk remux command (~2431+).
- [ ] 4.3 Also add the eac3 timestamp flags to Strategy A (it lacks them — cheap insurance).
VALIDATION: `cargo build`. Manual: play Panchayat, stop, replay from cache → still plays;
check disk remux cache produces H.264 (`ffprobe` the cached .mp4).

## PHASE 5 — cmd_ensure_ffmpeg permission (capabilities/default.json)
- [ ] 5.1 Add `"allow-cmd-ensure-ffmpeg"` to the permissions array (verified MISSING; matches
      the `cmd_ensure_ffmpeg not allowed` log). One line, independent, low-risk.
VALIDATION: `cargo build` (regenerates ACL); confirm the App.tsx:37 FFMPEG error is gone at runtime.

## PHASE 6 — (OPTIONAL, other files) HDR→native carve-out
NOT needed for Panchayat (SDR). Build only after Phases 0-5 verified on the real file.
- [ ] 6.1 New endpoint `/remux/probe/{folder}/{msg}` returning JSON
      `{needs_transcode, is_hdr, is_dovi_p5, video_codec}` from the Phase-2 classification.
- [ ] 6.2 Frontend (useMSEPlayer.ts ~2372, before the hevc→remux gate): for MKV, fetch the
      probe; if `is_hdr && !is_dovi_p5` → `setUseNative(true)` (HDR10/HLG render natively per E3);
      else → existing /remux path (now transcoding). DV P5 → transcode (native can't render it).
- [ ] 6.3 Keep the 20s timeout only as a true last resort (deterministic routing now decides).
VALIDATION: needs an actual HDR file + a DV P5 file to hand-test; defer until such files exist.
Do NOT claim HDR path works without a real HDR file.

## PHASE 7 — Final verification & cleanup
- [ ] 7.1 `cargo build --no-default-features` + `npx tsc --noEmit` both green.
- [ ] 7.2 Hand-test matrix (tauri dev), report REAL results:
      (a) Panchayat plays, seek works, audio in sync; (b) cold-start seconds measured;
      (c) replay-from-cache plays; (d) an H.264 MKV still uses client transmuxer (no regression);
      (e) an MP4 and a TS file still play (cross-format no-regression per skill).
- [ ] 7.3 Remove any test artifacts; confirm `git status` shows only intended source changes.
- [ ] 7.4 Update skill video-streaming refs with the transcode-tier findings + QSV gotcha.

## Risks / watch-items (honest)
- **Seek on transcoded piped stream**: mpegts.js byte-seek on a live-transcoded TS may be
  weaker than copy (no precomputed index). Watch at 7.2(a). The background disk remux (Phase 4)
  gives a seekable file on 2nd play. If 1st-play seek is bad, that's a known tradeoff to tune.
- **QSV under real GUI process** (release, cached logon PATH) vs dev: ffmpeg path resolution
  already handled (ffmpeg_util.rs). QSV precheck will simply fall to libx264 if the GUI process
  can't init the GPU. Verify in a release build later.
- **CPU load if libx264 fallback triggers** on weak machines: 5.87x on the 13900H; slower CPUs
  may drop below realtime. Acceptable for now; note for future adaptive-preset work.

## No-regression contract (per user standing rule)
Surgical changes only. Do NOT touch MP4/TS routing, the client transmuxer (avc path), the
thumbnail pipelines, or any UI. All edits confined to: server.rs `/remux` + probe, one
capabilities line, and (Phase 6 only) a scoped frontend routing addition.
