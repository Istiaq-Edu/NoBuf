# Cross-validation: HEVC remux seek reads from FRONT, not seek byte (msg 19 log, 07:47–07:48)

Every claim re-derived from source/log. Status: VERIFIED / FALSIFIED / INCONCLUSIVE.
File: Panchayat_S02E01 … x265 HEVC MKV. size=952,013,174 B (907MB). real dur=2317.0s (ffprobe).

## Claims under test
1. The video did NOT recover after the seeks (user discarded).
2. On a remux seek, ffmpeg reads its `/stream` input from the FRONT (~byte 0), not the seek byte.
3. The seek target byte for t=1092.894s is ~449MB; ffmpeg never requested that region.
4. Proactive prebuffer is spawned aimed FAR behind the seek (playhead byte ~4.8MB, sequential).
5. Duration is wrong end-to-end: estimate 1904s shown, real 2317s from ffprobe never reaches FE.
6. `input_source` for the piped remux is a bare http:// URL with no seekable/reconnect flags.
7. Shutdown panic at server.rs:291 = async unregister in Drop with no Tokio reactor at exit.
8. `cmd_ensure_ffmpeg not allowed` = missing Tauri capability; benign only because PATH ffmpeg exists.
9. The `PPS id out of range` / NALU / "stream 3 unspecified size" lines are benign probe noise.
10. My earlier Part-1 theories (proactive 40s-offset; fast-break timing) are NOT the cause here.

## Findings
1. VERIFIED. Log tail: `cmd_delete_cache ... reason=cache-dialog-discard` fired 5× at 07:48:33–41,
   ~40s after the first seek (07:47:55). Playback never reached the target; user discarded.
2. VERIFIED (by Range evidence). After seek to 1092.894s, /stream CACHE-PREFIX lines show input
   Range requests served `0-41943039`, `3855-41943039`, `1274288-51380223` — all near the FRONT,
   marching FORWARD. ffmpeg read the tail once (`HIT 951558938-952013173` = MKV Cues at EOF) but
   then did NOT byte-jump; subsequent reads continue from the front. No request near the target.
3. VERIFIED (math + absence). t/real_dur*filesize = 1092.894/2317*952013174 = 449,050,274 (449MB).
   The log has NO `STREAM-CACHE-WAIT` and NO CACHE-PREFIX/HIT for any offset near 449MB after the
   seek → ffmpeg never issued a Range there. (Uncached 449MB would have logged a wait/fallback.)
4. VERIFIED. `[PROACTIVE] msg 19: playhead=9s (byte 4794995) … spawning` then
   `SEQUENTIAL download gap 15728640-951558937` — prebuffer fills sequentially from ~15MB at
   ~1MB/s. To linearly reach 449MB ≈ 400s. Confirms "generation point far behind seek point."
5. VERIFIED. `[MPEGTS] Estimated duration: 1904.0s (from filesize/4Mbps)`; backend
   `extract_video_attrs_from_raw_msg returned None` → `No DocumentAttributeVideo` → bitrate est.
   `[REMUX-PROBE] ffprobe duration=2317.0s` is computed backend-side but the FE "real duration"
   fetch returned `Got real duration from metadata: 1904.0s` — i.e. the /fmp4/metadata path
   echoed the estimate, NOT the 2317s ffprobe value. So the seek bar maxes at 1904s; last ~413s
   unreachable and every seek maps to the wrong real time. (Est-bar byte for 1092s = 546MB, even
   further off.)
6. VERIFIED. server.rs:2221 `input_source = format!("http://127.0.0.1:{}/stream/{}/{}?token={}")`.
   Spawn (2523-2560) passes only `-ss` (pre-input), `+genpts+discardcorrupt`,
   `-avoid_negative_ts make_zero`, `-i input_source`. NO `-seekable 1`, NO `-reconnect*`,
   NO `-multiple_requests 1`, NO custom `-headers`. Plain HTTP protocol.
7. VERIFIED. server.rs:282-295 `impl Drop for DownloadGuard` calls `tokio::spawn(async move {…})`.
   At app exit the actix arbiter thread runs Drop without a Tokio 1.x reactor → panic
   "there is no reactor running". Matches `panicked at src\server.rs:291:13`.
8. VERIFIED (log). App.tsx:37 `[FFMPEG] Download failed: cmd_ensure_ffmpeg not allowed. Permissions
   … allow-cmd-ensure-ffmpeg`. Backend then logs `Using system ffmpeg from PATH` → works now;
   the auto-download fallback is dead if PATH ffmpeg is absent.
9. VERIFIED as noise. Code comment server.rs:2540-2548 documents these as harmless probe-time
   artifacts of the cover-art/attachment stream; FFREPORT proved 0 decode errors historically.
10. VERIFIED. The failure is present BEFORE any proactive competition matters: ffmpeg itself never
    seeks to 449MB. Fixing proactive targeting or fast-break timing cannot help while ffmpeg
    linearly demuxes from the front. Prior theories do not explain this log.

## Root cause (VERIFIED at the Range level; MECHANISM partially INCONCLUSIVE)
A Matroska `-ss` seek over the live `/stream` HTTP input degrades to a linear forward demux from
byte ~0 instead of a Cue-based byte jump to the target cluster (~449MB). PROVEN: ffmpeg's input
Range requests cluster at the front and never touch the target region. WHY it degrades is NOT yet
proven from the log alone (candidates, unranked, need `-loglevel debug`/`-report` on input open):
  (a) live /stream advertises Accept-Ranges+full Content-Length so ffmpeg treats input as
      seekable, but the seek still resolves to a front read — possibly Cues reference absolute
      cluster positions ffmpeg reaches by reading, or the demuxer falls back after the phantom
      "stream 3 (unspecified size)" fails codec-param probing;
  (b) `-avoid_negative_ts make_zero` / `+genpts` interaction (unlikely to affect input seek);
  (c) HTTP protocol seek not issued because the initial open reads sequentially before -ss applies.
MECHANISM = INCONCLUSIVE. Range-level behavior = VERIFIED.

## Fix options (unchanged by cross-val; A still needs the debug repro)
- A: make ffmpeg byte-seek the input (prove why Cue-jump degrades; add -loglevel debug on open).
- B: two-part input = cached MKV header prefix + /stream window starting at Cue-resolved cluster
     byte for T, so ffmpeg's linear read begins near the target.
- C: only allow remux seeks once fully cached; seek the on-disk file (ffmpeg Cue-jumps instantly).
Recommendation: A-with-B-fallback. Do NOT ship speculative; instrument input open, one repro.

## Additional signals found on completeness re-scan (were under-weighted)
11. VERIFIED. The /fmp4/metadata endpoint (server.rs:3699) is TS-oriented and structurally cannot
    handle MKV: log shows `TS packet size detection failed`, `video codec config not found —
    using AVC default`, `audio codec config not found — using AAC default`. For an MKV remux the
    FE receives AVC/AAC defaults + a bitrate-estimate duration. This is the SAME root as #5 and
    also means codec metadata shown for MKV is a default, not real.
12. VERIFIED. Each seek re-runs a FULL `[REMUX-PROBE]` (ffprobe duration=2317s, color transfer,
    needs_transcode) + the cover-art NALU probe noise — ~1s of redundant work per seek. Not the
    blocker, but wasteful under scrubbing.
13. NOTED. `kill_on_drop(true)` IS set (server.rs:2590) and this run shows NO `-22` muxer error
    and NO orphan pileup — the QSV 10-bit HEVC `-22` from prior memory did NOT reproduce here.
    The seek failure is the front-read, not a transcode crash.
14. VERIFIED benign: grammers `bad salt`/`future salts`, `FMP4-KF Data file not ready`,
    `PREBUFFER MISS no meta`, initial `STREAM-CACHE-WAIT … falling back to Telegram` — all normal
    cold-start / MTProto handshake noise.

## SEPARATE, independently shippable (verified, low-risk) — NOT yet shipped
- Shutdown panic (#7): guard `DownloadGuard::drop`'s `tokio::spawn` with
  `tokio::runtime::Handle::try_current()` — if no reactor (shutdown), do the unregister inline or
  skip it (process is exiting; the in-memory map dies anyway). Trivial, safe.
- Duration bug (#5/#11): plumb the ffprobe 2317s duration into the FE. The /remux handler already
  computes it (`[REMUX-PROBE] ffprobe duration=2317.0s`); either cache it and have /fmp4/metadata
  return it, or send it to the FE from the remux path. Fixes the truncated seek bar + wrong
  time→byte mapping. Medium (touches metadata contract) — verify no regression to TS/MP4 paths.

## Edge cases for each fix path (to handle when the chosen fix is built)
- Seek fix A/B: (i) seek before first Cue / t<first-keyframe → clamp to 0; (ii) seek past last
  Cue → clamp to last cluster; (iii) file with NO Cues (some MKVs) → B degrades to front-read, must
  detect and fall back to C; (iv) rapid scrubbing → supersede + kill_on_drop already handle orphans;
  (v) header prefix size: Cues live at EOF for these files, so B needs BOTH the front header AND the
  tail Cues, not just a prefix.
- Duration fix: (i) MP4/TS paths must keep their existing duration source (don't regress);
  (ii) live file not yet probed → fall back to estimate until ffprobe result exists;
  (iii) cache the probed duration keyed by message_id to avoid re-probe per seek (also fixes #12).
- Shutdown fix: (i) normal runtime drop (seek supersede) must STILL unregister async as today —
  only the no-reactor exit path changes.
