# Cross-validation: HEVC/MKV seek fix diagnosis

Every claim I made last turn, re-derived from source/execution. Status: VERIFIED / FALSIFIED / INCONCLUSIVE.

## Claims under test
1. Playback is fixed (audio PCE fix worked).
2. HEVC/MKV seek recreates player from `/stream/`, feeding MKV into a TS demuxer → `sync_byte != 0x47`.
3. The `/stream/` byte-seek is correct ONLY for native-TS/timed_id3 sources.
4. `/remux` supports `-ss` seeking.
5. `/remux?ss=580` emits output video PTS at ~581s absolute (not 0).
6. The existing `_dtsBase=0` logic would map that absolute PTS → currentTime≈seekTime on a remux-seek player.
7. `kill_on_drop` is used nowhere → aborted remux orphans its ffmpeg.
8. The piped ffmpeg `Child` is owned inside the `async_stream` block; client abort drops it without killing.
9. The `-22` at seek time is the orphaned ffmpeg dying on a broken pipe (EPIPE).
10. HEVC cannot use the mediabunny (client transmux) path, so `/remux` transcode is architecturally required.

## Findings

1. Playback fixed — VERIFIED (log: `codec=avc1.640028,mp4a.40.2`, no append-fail).
2. HEVC seek recreates from `/stream/` feeding MKV to TS demuxer — VERIFIED. Recreate uses
   `url: streamUrl!` (line 4356); `streamUrl` is the hook param (line 828); runtime log shows
   its value = `/stream/3574767635/19` (raw Matroska). Hence `sync_byte != 0x47` flood.
3. `/stream/` byte-seek correct ONLY for TS-formatted sources (native .ts + timed_id3) —
   VERIFIED. MKV `/stream/` is Matroska, not TS. Comment at 3728-3731 confirms intent.
4. `/remux` supports `-ss` — VERIFIED (server.rs:2500-2506, `-ss` before `-i` + `-copyts`).
5. `/remux?ss=580` → video PTS ~581s absolute — VERIFIED BY EXECUTION (ffprobe: 581.42s).
6. Existing `_dtsBase=0` maps absolute PTS → currentTime≈seekTime — VERIFIED (code 4492-4499).
7. `kill_on_drop` used nowhere — VERIFIED (grep: NONE).
8. Piped ffmpeg `Child` moved into `async_stream`; client abort drops it w/o killing —
   VERIFIED. tokio docs (authoritative): "a spawned process will continue to execute even
   after the Child handle has been dropped"; default kill_on_drop=false.
9. The `-22` = orphaned ffmpeg dying on BROKEN PIPE (EPIPE) — **FALSIFIED / CORRECTED.**
   The log says `-22 (Invalid argument)` = EINVAL, from "Error submitting a packet to the
   muxer" (h264_qsv → mpegts muxer), NOT EPIPE (-32). It's a muxer-level error on the
   already-running original ffmpeg, surfacing when the seek tore down the pipeline. I cannot
   prove from the log alone whether the closed stdout pipe triggered it or it's an independent
   timestamp/muxer fault. Mechanism INCONCLUSIVE; my EPIPE wording was wrong. Does NOT change
   the fix: kill_on_drop is still needed so an aborted/superseded seek reaps its ffmpeg
   regardless of how it would otherwise die.
10. HEVC can't use client mediabunny transmux → `/remux` required — VERIFIED (2388: "H.265
    MKV (transmuxer marks hevc unsupported for MSE)"; only `avc` takes the mediabunny path).

## Additional facts established during validation
- Test frameworks EXIST: vitest (package.json `"test": "vitest run"`) + Rust `mod tests`
  already in server.rs:4748 with `#[test]`. Tests are feasible on both sides.
- Loader behavior (MpegtsChunkLoader): for a streaming `/remux` body, `_fetchRange` reads
  until `done` — ONE continuous read to EOF, ignoring `to`. That's why the initial remux
  load doesn't re-spawn ffmpeg per range. A `/remux?ss=` seek behaves identically. VERIFIED
  by reasoning from loader code + working initial playback.
- Abort path: destroying the old player → ChunkedFetchLoader.destroy() → abort() → aborts
  fetch → server stream dropped → child dropped. So kill_on_drop WILL fire on seek supersede.

## EDGE CASES to handle in implementation
- E1: filesize/completion. Loader completes when `from >= _fileLength`. For ss-stream, byte 0
  != file byte 0. Pass filesize=undefined (or don't set) to remux-seek player so it reads to
  EOF instead of false-completing. MUST verify.
- E2: rapid scrubbing. Each remux seek spawns ffmpeg. Reuse mpegtsRecreationGenRef supersede
  + debounce so only ONE live ffmpeg. Old fetch abort → kill_on_drop reaps it.
- E3: seek within already-buffered window — should NOT respawn ffmpeg (cheap in-buffer seek).
- E4: seek past EOF / ss > duration — clamp.
- E5: paused-seek ("paused means paused") — remux seek must respect isPausedRef, not autoplay.
- E6: VBR align-poll + keyframe-index + green-bar byte mapping are byte-based → skip for
  remux seeks (ffmpeg -ss is frame-accurate; no corrected-byte recreation).
- E7: native-TS/timed_id3 path MUST stay byte-seek (untouched). Gate on a new
  needsRemuxSeekRef set only when routing HEVC-transcode → /remux.
- E8: cold-start deferred/overlay interplay — remux seek re-triggers ffmpeg startup latency
  (~1-3s). Don't fire the 20s init-timeout; reuse transmuxerInitInProgress extension.

## TEST PLAN
Rust (server.rs mod tests):
- ss query parse: `?ss=580.6` → Some(580.6); absent → None.
- remux arg builder emits `-ss` before `-i` and `-copyts -start_at_zero` only when ss>0.
Frontend (vitest):
- gate: needsRemuxSeek true→ remux-seek path; false→ byte-seek path (native TS untouched).
- URL builder: `/remux/.../..?token=..&ss=<t>` well-formed, ss clamped to [0,duration).
- supersede: 2nd seek bumps gen → 1st bails.
Manual (user hand-test): scrub HEVC MKV fwd/back; verify no zombie ffmpeg (Task Mgr),
video decodes at target, paused-seek stays paused.

## VERDICT
Core diagnosis stands (claims 1-8,10 verified). Claim 9 mechanism corrected (EINVAL not
EPIPE, mechanism inconclusive) — no impact on fix design. Robust fix = FE remux-seek path +
BE kill_on_drop + supersede/debounce, with E1-E8 handled and tests above.
