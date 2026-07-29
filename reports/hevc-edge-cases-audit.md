# HEVC MP4 → /remux — Edge-Case Audit (self-verified, file:line cited)

Date: 2026-07-28. Complements: `hevc-codebase-research.md`, `hevc-webview2-verification.md`.

## 1. State teardown at the late-failure point (RISKIEST)

The MKV-HEVC decision (useMSEPlayer.ts:2644) happens **before** MP4Box init — nothing to tear down.
The MP4-HEVC failure (useMSEPlayer.ts:6520-6544, inside `onMP4BoxReady`) happens **after**:
- MediaSource is open on our blob URL (`video.src = blob:`), duration already set (6445-6447)
- mp4box instance live, moov parsed, tracks extracted (6450-6468), VBR calibration table maybe built (6478+)
- streaming chain started (first-chunk fetches ran; user log shows `[MSE] Streaming chain stopped` firing later via cleanup)
- cold-start state active (`isColdStartBuffering`, progress counters)

**Required teardown before rerouting to mpegts.js** (mirror what the timed_id3 branch at 2531-2564 sets up, plus cleanup the MP4 path already owns):
1. `stopStreamingChain()` (defined ~998)
2. mp4box: `flush()`/stop + null the ref (prevent further onReady/onSegment callbacks)
3. `setMseUrl(null)` **before** mpegts init (2560-2564 pattern — else FastStreamPlayer overwrites video.src → ERR_FILE_NOT_FOUND)
4. Detach our MediaSource: mpegts.js attaches its own; revoke old blob URL
5. Keep: `state.current.duration` (mp4box's is accurate — better than remux ffprobe estimate), `fileLength`
6. Set: `remuxUrlRef`, `needsRemuxSeekRef=true`, `remuxSeekBaseUrlRef` (2645-2652 pattern), `shadowCacheRef.reset`, `transmuxerInitInProgressRef=true` (extends the 20s MSE init timeout — remux needs download+ffprobe+ffmpeg)
7. Cold-start overlay: reuse the MKV pattern (2670-2678) — new deferred, `setColdStartPhase('initializing_player')`, indeterminate progress
8. Guard `effectGenerationRef` so a stale reroute from a previous file can't fire

## 2. `hevc_ok` flag — **dead parameter today**

- Backend: `query.hevc_ok.unwrap_or(false)` (server.rs:2725) gates 8-bit-HEVC copy-vs-transcode (2728).
- Frontend: `grep -rn hevc_ok app/src` → **0 hits**. Never sent → always false → 8-bit HEVC always transcodes even for users who own the HEVC extension.
- Fix opportunity: send `hevc_ok = MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')` on the remux URL. NOTE: `-c:v copy` of HEVC into MPEG-TS then requires mpegts.js to demux HEVC-in-TS — verify mpegts.js supports it before enabling copy for MP4-HEVC 8-bit (it may not; if not, keep transcode).
- For MP4-HEVC arrivals at 6530 we KNOW isTypeSupported=false (that's why we're there) → `hevc_ok=false` correct by construction. But when isTypeSupported=true, we never reach 6530 — direct MSE play. Consistent.

## 3. HDR: `is_hdr` computed but **NEVER consumed** — washed-out colors bug

- server.rs:2736-2762: frame-probe extracts color_transfer/primaries; `is_hdr = smpte2084 || arib-std-b67 || bt2020` (2757). Only logged (2764) — `grep tonemap|zscale` → **0 hits**.
- All three encoder variants (server.rs:2362-2403) convert to nv12/yuv420p with NO tone mapping → HDR10/HLG 10-bit content (the majority of 10-bit x265 rips) transcodes with PQ gamma interpreted as SDR → gray/washed-out output.
- **Plan item**: when `is_hdr`, insert tonemap into the -vf chain:
  - libx264/variant B: `zscale=t=linear:npl=100,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709,format=yuv420p` (or `libplacebo` if built in)
  - QSV variant A: `vpp_qsv` has no tonemap → either force variant B for HDR, or `tonemap_qsv` if the ffmpeg build has it (probe needed). Simplest robust: HDR → SW decode + zscale tonemap + h264_qsv encode (variant B chain keeps encode on GPU).
- This bug ALREADY affects MKV-HEVC-HDR today — fixing it benefits the existing tier too.

## 4. Dolby Vision (dvh1/dvhe sample entries)

- mp4box reports `dvh1.08.xx` codec strings for DV profile 8. The branch at 6532/6537 checks only `hvc1`/`hev1` → dvh1 falls to generic "codec not supported" with no HEVC hint, and would MISS the new remux reroute if we only match hvc1/hev1.
- **Plan item**: match `dvh1`/`dvhe` too → route to remux (ffmpeg decodes the DV P8 base layer as plain HEVC; P8 is HDR10-compatible → tonemap per §3). DV P5 (IPTPQc2) will look purple/green through a plain HEVC decode — rare in the wild for MP4; accept as known limitation, document.

## 5. Audio edge cases

- /remux always: `-map 0:{audio_stream_idx}` (ffprobe-chosen single stream, server.rs:2981-2982), `-c:a aac -b:a 192k` + seek-aware `-af` filter (3004-3005), subtitles dropped (`-sn`, 2985).
- Multi-audio MP4 → only the ffprobe-selected track survives; no track-switch UI on the remux tier (same as MKV-HEVC today). Document, don't fix now.
- eac3/dts/opus/truehd in MP4 → AAC transcode handles all (decoders present in gyan.dev/system builds).
- Audio-less MP4: probe `found_audio=false` → guarded fallback re-probe (2656+); verify `-map 0:a` absence path — the MKV tier already handles this (existing behavior).

## 6. Seek plumbing for MP4 input

- Remux-tier seeks: in-buffer → plain `currentTime` (3891-3900, no respawn); out-of-buffer → `_mpegtsRecreatePlayerForRemuxSeek` (5003+): destroy player → new player at `buildRemuxSeekUrl(base, t, startByteEstimate)` (5029) → old ffmpeg reaped via kill_on_drop (4997-4998).
- `buildRemuxSeekUrl` (64-88): if `startByte>0` → `start_byte=&ss=` (byte-forward stdin feeder); else `ss=` only.
- **CRITICAL for MP4**: byte-forward mode feeds `[TS init_prefix + raw /stream bytes]` to ffmpeg stdin (server.rs:2921-2933, init_prefix = TS PAT/PMT packets, server.rs:73-101). That is **TS-only semantics**. Feeding raw mid-file MP4 bytes to stdin = garbage (no moov). MKV avoids it… but `_mpegtsRecreatePlayerForRemuxSeek` computes `startByteEstimate` whenever fileLength+duration are known (5023-5028) — which is TRUE for MKV/MP4. ⚠️ Verify how MKV seeks actually behave today (if MKV sends start_byte, there may be a latent bug or a backend guard I didn't find). **For MP4 the reroute MUST force ss=-only** (pass `startByte=undefined`, e.g. gate byte-forward on a `remuxInputIsTs` flag next to `needsRemuxSeekRef`).
- `-ss` over HTTP for MP4: **verified locally** — ffmpeg issued Range `bytes=0-` → `bytes=<moov_off>-` (moov@tail) → `bytes=44-` → `bytes=<mdat_target>-` against a Range server and produced a correct 5s segment from t=20 (9.19x realtime, QSV). The /stream endpoint serves arbitrary Range from Telegram → works uncached. 4 sequential requests ≈ the same pattern MP4Box cold-start already does.
- 'paused means paused': preserved by E5 (5000-5001, 5014) — wasPaused respected after recreation. Inherited for free.

## 7. Feature parity on the remux tier (same as MKV-HEVC today — no NEW losses)

| Feature | MP4 tier | Remux tier |
|---|---|---|
| Hover scrub thumbnails | yes (on-demand byte fetch) | **no** — gated on `isTransmuxerActive` (useThumbnailExtractor.ts:1775; transmuxerRef null on remux) |
| Prebuffer pause/threshold logic | MP4-specific impl | mpegts.js autoCleanup + shadowCache variant (existing) |
| Resume position | works (seek on start) | works via remux ss= seek |
| Player-close cache delete | `cmd_delete_cache` FastStreamPlayer.tsx:416 — tier-agnostic | works |
| Speed counter (e908313 backend cumulative) | works — backend counts /stream bytes; ffmpeg reads via /stream internally → still counted | works (verify double-count vs direct: ffmpeg is the only /stream consumer on this tier) |
| Duration accuracy | moov exact | pass mp4box duration → mpegts player `duration` option (MKV path does this via /fmp4/metadata) |

## 8. Skip-ffprobe feasibility: **partial — pass hints, keep probe as fallback**

Frontend already has (6450-6468): codec string (`hvc1.2.4.L120.90` → profile_idc 2 = Main10 = 10-bit!), width/height, exact duration, audio codec. Missing vs ffprobe (StreamProbeResult, 2408-2419): ffmpeg **stream indices** (≠ mp4 track ids when cover-art/multiple streams present), exact `pix_fmt`, `audio_channel_layout`, HDR color info (separate frame-probe, only when needs_transcode, 2737).
Verdict: send `&vcodec=hevc&profile=main10&duration=` as hints → backend can skip the **stream probe** only when it trusts hints AND pick indices as first-video/first-audio; keep fast-probe fallback. Saves ~1-2s. Do in phase 2 — not required for correctness.

## 9. Encoder probe extension (NVENC/AMF)

`qsv_h264_available()` (server.rs:2225-2245): OnceLock-cached one-shot: `ffmpeg -f lavfi -i color=black:s=64x64:d=1 -frames:v 1 -c:v h264_qsv -f null -`. Replicate for `h264_nvenc`, `h264_amf` → `fn best_h264_encoder() -> &'static str` trying qsv→nvenc→amf→(libx264). Probes run once per process (~200ms each, only on first /remux). Decoder side: keep hevc_qsv HW decode only for QSV variant A; NVENC/AMF variants use SW decode + HW encode (variant B pattern) — simplest verified-safe combo.

## 10. Early detection (can we know HEVC before MP4Box init?)

No reliable pre-moov source: `detectFormat` sniffs container magic only; filename `x265/HEVC` hints unreliable; backend would need its own moov parse (it has no MP4 demuxer — only TS tooling). The late-reroute (§1) is unavoidable for MP4. Cost: one wasted first-chunk + moov fetch (~5.5MB, reused by ffmpeg's own probe via OS cache? NO — separate HTTP reads, but /stream serves moov range from Telegram cache once downloaded → second read is cache-hit and fast). Acceptable.

## Local verifications backing this audit (run 2026-07-28 on Iris Xe)

- 10-bit HEVC → h264_qsv full pipeline (Variant A + mpegts out): **14.2×** realtime; SW-decode Variant B: **8.0×**; libx264 veryfast: **8.3×** (1080p24 synthetic).
- Non-faststart MP4 over Range-HTTP into ffmpeg: works; `-ss 20` input-seek over HTTP: works (Range pattern: 0- → moov@tail → 44- → mdat-target).
- WebView2 138 + flag `PlatformHEVCDecoderSupport`: MSE/canPlayType/MediaCapabilities/WebCodecs ALL false → remux is the only universal path (see hevc-webview2-verification.md).

## Cross-validation round (2026-07-28, second pass — each ⚠️ re-derived by execution)

| Claim | Method | Verdict |
|---|---|---|
| mpegts.js can demux HEVC-in-TS (§2/§5 copy-path question) | grep dist bundle: `HEVCDecoderConfigurationRecord`, `HEVCVideoData`, `HEVCPacketType` present | **VERIFIED capability exists** in bundled mpegts.js build — BUT playback still needs MSE `hev1` SourceBuffer support, which is false on stock WebView2 (hevc-webview2-verification.md) → `-c:v copy` for HEVC remains OFF by default; only viable when `hevc_ok=true`. |
| HDR tonemap chain works with this ffmpeg build (§3) | Generated real HDR10 clip (smpte2084/bt2020 + master-display SEI, verified via ffprobe frame probe); ran `zscale=t=linear:npl=100,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709,format=nv12` → h264_qsv | **VERIFIED**: output h264/yuv420p, **2.55× realtime** 1080p24 (SW decode+tonemap is the bottleneck; still above realtime). `tonemap`, `zscale`, `tonemap_opencl`, `tonemap_vaapi`, `libplacebo` all present in build. No `tonemap_qsv` → HDR must use the SW-decode variant. |
| Byte-forward stdin feeder is TS-only (§6) | server.rs:3071-3119 read: feeder = `[get_init_prefix (TS PAT/PMT; empty for non-TS) + raw /stream bytes from aligned offset]`. Simulated: piped mid-file MKV bytes to `ffmpeg -i pipe:0` | **VERIFIED — and worse than audited**: ffmpeg exits immediately, "Invalid data found when processing input", no output. |
| MKV-HEVC remux seeks hit the same latent bug TODAY (§6 ⚠️) | useMSEPlayer.ts:5023-5028: `startByteEstimate` computed whenever `fileLength>0 && duration>0` — TRUE for MKV (fileLength always set from HEAD/Content-Range at 2403/2425). No `remuxInputIsTs`-style guard exists (grep: 0 hits). The 5022 comment "Falls back to ss= ... MKV" is WRONG — the fallback only triggers when fileLength/duration are UNKNOWN, which never happens | **FALSIFIED the code comment / VERIFIED latent bug**: uncached out-of-buffer MKV-HEVC remux seeks send `start_byte=` → backend feeds mid-file Matroska to stdin → ffmpeg dies → seek hangs (matches the known 'backward-seek starves ~10s' symptom class? NO — that's the Mediabunny tier; this is the remux tier and needs a live repro to grade severity). Phase 1 MUST add the TS-only guard and it also FIXES MKV. |
| `-ss` over HTTP works for MP4 moov-at-tail (§6) | Live Range-server test, logged requests | **VERIFIED** (pattern: 0- → moov@tail → 44- → mdat target; correct 5s output from t=20). |
| ffprobe fast-probe budget for MP4 moov@tail (§ risk 4) | ffprobe (5MB budget) demuxes MP4 by seeking to moov first (same as ffmpeg input open — observed in Range log) — moov read is a direct seek, not a linear 5MB scan | **VERIFIED by the same Range logs** (input open fetched moov via tail Range immediately). Fast-probe suffices. |
| `hevc_ok` never sent by frontend (§2) | `grep -rn hevc_ok app/src` → 0 hits; backend `unwrap_or(false)` | **VERIFIED dead param.** |
| dvh1 misses the HEVC branch (§4) | Read 6532-6537: `startsWith('hvc1')||startsWith('hev1')` only | **VERIFIED by inspection** (dvh1 → generic unsupported message). |

## Top 5 risks, ranked

1. **Late teardown correctness** (§1) — half-initialized MP4 MSE state must be fully quiesced; risk of zombie streaming chain / double video.src writes. Mitigate: follow timed_id3 branch ordering exactly; effect-generation guard.
2. **Byte-forward seek is TS-only** (§6) — MP4 must force ss=-mode; also audit existing MKV behavior for the same latent issue.
3. **HDR washout** (§3) — pre-existing bug that will be much more visible once MP4-HEVC (mostly HDR-ish 10-bit rips) flows through; needs tonemap work + QSV filter probe.
4. **ffprobe over uncached /stream cold-start** — fast-probe 1-3s typical, but moov@tail means ffprobe ALSO range-seeks to tail; verify fast-probe budget suffices for MP4 (it reads moov, not 5MB linear). If slow: skip-ffprobe hints (§8).
5. **mpegts.js HEVC-in-TS copy path** (§2) — don't enable `-c:v copy` for HEVC without verifying mpegts.js demux support; transcode-always is the safe default.
