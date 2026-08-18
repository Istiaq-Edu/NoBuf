# Embedded-subtitle extraction — BYTE-COST measurements (execution-verified)

2026-07-31. All numbers measured with a local Range-logging HTTP server
(`range_server.py`, logs ACTUAL bytes sent per transfer, including aborted
connections) serving a locally generated fixture. This answers the core
economics question for a backend ffmpeg extraction endpoint reading over the
app's Range-capable `/stream` endpoint.

## Fixture

- `big.mkv` — 401,554,342 bytes (383 MiB), 1220 s (20:20), 1280x720 H.264
  ~2.5 Mbps + AAC + **2 text subtitle tracks**: `0:2` subrip (eng, default,
  240 cues), `0:3` ass (jpn, 240 cues). Generated with ffmpeg testsrc2/sine +
  two .srt files muxed as `-c:s:0 srt -c:s:1 ass`.
- `big_faststart.mp4` / `big_tailmoov.mp4` — same content, subs as `mov_text`,
  with/without `-movflags +faststart`.
- `big_partial.mkv` — first 100,000,000 bytes of `big.mkv` (simulates a
  partially-cached file / contiguous cache prefix).

## Measurements (bytes = actually sent by server, not requested)

| # | Operation | Command shape | Result | Bytes over HTTP |
|---|---|---|---|---|
| P1 | **List** sub tracks | `ffprobe -show_streams -select_streams s -probesize 5M -analyzeduration 5M http://…/big.mkv` | both tracks + tags found, exit 0 | **4.6 MiB** |
| P2 | Whole SRT track | `ffmpeg -i http://…/big.mkv -map 0:s:0 -f srt pipe:1` | 240/240 cues, exit 0 | **383 MiB (full file, 1 sequential pass)** |
| P3 | Bounded from start | `-t 120` (input) + `-t 120` (output) | 25 cues (≤120 s), exit 0 | **40.7 MiB (proportional ✓)** |
| P4 | Whole mov_text track | faststart MP4, `-map 0:s:0 -f srt pipe:1` | 240 cues | 382 MiB (full) |
| P5 | mov_text + `-discard:v all -discard:a all` | faststart MP4 | 240 cues | **382 MiB — `-discard` does NOT reduce HTTP reads** |
| P6 | **Mid-file window** | `-ss 900 -t 60 -i http://…/big.mkv -map 0:s:0` | 63 cues, times **rebased to 0** (first cue 00:00:09) | **866 MiB = 2.16× file size — WORSE than whole-file** |
| P7 | Whole SRT track, **local path** (cached case) | `-i big.mkv` | 240 cues | n/a — **0.15 s wall time** |
| P8 | **Truncated prefix** (100 MB of 383 MB) | `-i http://…/big_partial.mkv` | **exit 0**, 60 valid cues, stderr `File ended prematurely` | prefix only |
| P9 | ASS track | `-map 0:s:1 -c:s copy -f ass pipe:1` | full `[Script Info]` + `[V4+ Styles]` + 240 `Dialogue:` — header reconstructed from track extradata | full read |
| P10 | Window w/ `-copyts -t 60` | `-ss 900 -i … -t 60 -copyts` | **0 cues** (`-t` counts from t=0, everything after 900 s exceeds it) + 772 MiB | broken — do not use |

Transfer-level evidence for P6 (the pathological case): server log shows TWO
essentially-full sequential reads (`0→EOF` and `1638→EOF`) for one 60-second
window — the matroska demuxer did not (or could not) use Cues to jump for a
subtitle-only stream selection over HTTP; it linear-scanned. Caveat: fixture
Cues placement is ffmpeg-muxer default; real-world MKVs may seek better, but
the measured floor here is the number to plan around.

## Conclusions that shape the design

1. **Listing is always cheap** (4.6 MiB, header-only) → safe to call once per
   file open, memoized server-side like `/audio_tracks`.
2. **Whole-track extraction = one sequential full-file read** over /stream.
   On a fully-cached file it is effectively free (0.15 s local). On an
   uncached file it costs a full Telegram download — BUT those bytes land in
   the app's disk cache via /stream, so it doubles as cache warming (the MKV
   tier already runs a full-file disk warmer anyway).
3. **Never window mid-file over HTTP** (P6: 2.16× full size; P10: silently
   empty with `-copyts`). Windowed extraction is only sane on local cached
   bytes, and cue times come out REBASED to the `-ss` point (client must
   re-offset).
4. **`-t N` from the start is proportional** (P3) → a cheap "first N minutes"
   progressive pass is viable while the cache fills.
5. **Partial-prefix extraction is safe and useful** (P8): ffmpeg exits 0 with
   all cues present in the prefix and a benign stderr warning. The backend can
   extract from the cache file's contiguous prefix at any time and re-extract
   later for the remainder (or simply re-run once fully cached — output is
   deterministic).
6. **ASS extraction reconstructs a complete, jassub-feedable script** (P9):
   `[Script Info]` + `[V4+ Styles]` + `[Events]` come from codec extradata —
   no manual header synthesis needed.
7. `-discard` does not save bytes over HTTP (P5) — don't bother.
8. Extraction output on stdout (`-f srt pipe:1` / `-f ass pipe:1`) works with
   `-nostdin -loglevel error`; SRT of a 240-cue track is 17.7 KB (text subs
   are ~KB-scale — response size is a non-issue; the INPUT bytes are the cost).

## Addendum: two extra probes

- **P11 — list on truncated 100 MB prefix: works** (exit 0, both tracks +
  tags). Track *listing* never needs more than the header even on a partial
  cache file. [VERIFIED-EXEC]
- **P12 — tail-moov MP4 listing over HTTP: INCONCLUSIVE on the toy server.**
  ffprobe issued `bytes=0-` then `bytes=789291-` and my Python test server
  mishandled keep-alive on the second transfer (WSAECONNABORTED →
  `moov atom not found`). NOT evidence against the approach: the app's real
  Rust /stream server serves exactly this pattern correctly — the existing
  `/thumb` endpoint work execution-verified ffmpeg `-ss` seeks over HTTP
  tail-moov MP4 at 9–14× realtime against it. Treat tail-moov listing as
  supported (re-verify once against the real server during implementation).

## Recommended extraction policy (input for the plan)

- `list`: always, on file open (cheap, memoized).
- `extract`: whole-track, one ffmpeg run per track, **input = local cache file
  when fully cached (fast path), else /stream** (accepting the sequential read
  = cache warm-up), extracted text cached on disk keyed
  `{folder}_{msg}_s{idx}.{srt|ass}` so the cost is paid at most once per track.
- Progressive option for big uncached files: first pass `-t <cached-prefix-secs>`
  or extract-from-prefix (P8) and re-extract when fully cached; cue times are
  absolute in both cases (no `-ss` used → no rebase).
