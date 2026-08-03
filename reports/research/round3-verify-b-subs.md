# Round-3 Verify B — subtitle bounded-partial extraction (H-B1a–d, H-B3a–b)

**Provenance:** the V-B subagent (deleg_31e0877c task-1) completed ALL experiments but was
killed before writing this doc (owner exit). Reconstructed by the parent session from the live
transcript (`cache/delegation/live/deleg_31e0877c/task-1.log`, timestamps below) + parent
re-reads of every cited source region. Experiment fixtures ran in `.tmp-subs-exp/` (cleaned).

Setup verified by subagent: ffmpeg 8.1.1 (winget), cargo 1.95.0, actix-web app pins 4.13.0
(Cargo.lock:150-151), actix-http 3.12.1/3.13.1. Fixture: 21.9MB MKV, 240 SRT cues over 1200s,
cues interleaved 6.8KB→21.8MB (ffprobe-verified, transcript 01:27:36). Frontier servers
(python) simulated 4 death shapes at 40% (8,769,202B; 96/240 cues in prefix).

## H-B1a — cues survive mid-stream input death — VERIFIED (experiment)

| Shape | Server behavior | ffmpeg exit | stderr signature | out.srt |
|---|---|---|---|---|
| TRUNC (local 40% file) | n/a | **0** | `File ended prematurely` | **96/96 prefix cues** |
| CUT (01:30:46) | closes mid-body at frontier | **0** | `Stream ends prematurely at 8769202, should be 21923005` + `Error during demuxing: I/O error` (one reopen retry, cut again) | **96 cues** |
| CLEAN (01:30:59) | TCP reset at frontier | **0** | `Error number -10053` + `Read error` + I/O error | **96 cues** |
| LIE (01:33:29) | 200 w/ full Content-Length, body ends at frontier | **0** | `File ended prematurely` | **96 cues** |
| DENY (01:30:59) | 503 on FIRST request | **8** | `Server returned 5XX Server Error reply` | **no file** |

⇒ ffmpeg's srt muxer finalizes output on ANY mid-demux input death, exit **0** — the existing
success path (server.rs:6131-6132 `if out.status.success() break`) already accepts it, and the
`partial = !fully_cached || stderr.contains("ended prematurely")` line (:6169) already marks it
partial → `X-Subs-Partial: 1` (:6187-6188), not disk-cached (:6170-6171). **No salvage-on-
nonzero-exit change needed.** Only a file with ZERO cached bytes at the start hits the DENY
shape (exit 8 → 502) — acceptable; the moov/header region is effectively always cached before
the subs menu is usable (transmuxer init reads it).

## H-B1b — 'ended prematurely' + exit code — VERIFIED

Truncated/cut input ⇒ exit 0 (not non-zero) with premature-EOF stderr. The existing :6169
partial branch is the right hook; salvage = extend nothing, the bounded input rides the happy
path.

## H-B1c — cached_only plumbing — VERIFIED with CRITICAL CAVEAT (superseded by R1)

[CORRECTED per cross-validation R1: the :753-764 check fires whenever the range is not FULLY
cached (`is_range_cached` = contiguous full coverage, stream_cache.rs:1294-1306) — NOT "range
start not cached". It is a whole-request 503 BEFORE the stream body; with cached_only appended,
ffmpeg's 0-EOF first request would 503 instantly (DENY shape, exit 8, no output). cached_only
is therefore UNUSABLE for the subs fix as-is — a dedicated `cached_prefix` param must bypass
this check + the coordinator and gate the body instead. Remainder of this section's plumbing
facts stand.]

- `StreamQuery.cached_only: Option<bool>` (server.rs:328); serde untagged query bool — the TS
  scanner already sends `cached_only=true` (TauriStreamSource.ts:155 consumes the 503), so
  string parsing is proven in production.
- 503-at-request-check exists at server.rs:753-765 — fires on ANY not-fully-cached range.
- URL built exclusively in `subs_input_source` (server.rs:5855-5872) — BUT it is shared by
  `probe_sub_tracks` (:5909) and the font endpoint (:6248) as well as extract (:6099).
  **Appending a bounded-read param inside subs_input_source would gate probe+font too — probe
  needs the file TAIL (SeekHead at EOF; 3-t shows tail reads during probe) which may not always
  be cached. The param must be appended ONLY at the extract call site (:6099) or via a flag arg.**

## H-B1d — mid-body behavior — VERIFIED for the NO-PARAM case (fix shape corrected by R1)

[CORRECTION per R1: the paragraph below describes what the body does WITHOUT cached_only (the
param never reaches the body because :753-764 returns first). The conclusion stands in
amended form: the body's poll-wait and Telegram fallback are exactly what the new
`cached_prefix` param must gate so the body ends at the frontier.]

The initial 503 does NOT bound the body — and with cached_only set, the body is never even
entered. For a prefix-cached request WITHOUT the param, the handler enters the
`async_stream::stream!` body (server.rs:1011+): serves cached bytes (:1148-1190 poll loop
serving from disk), then when it hits the frontier it does NOT end — it **sleep-polls**
(:1192-1223, `STREAM-CACHE-WAIT`, 3-t:127-137 shows exactly this) and after 5s/15s **falls
back to Telegram download** (:1226-1334; note R4: FALLBACK_TIMEOUT_MS=15000, comments say 30s,
warn log says 10s — all stale). ⇒ **Minimal server change: `cached_prefix=1` bypasses the
:753-764 503 AND the coordinator (:768-1005), then gates the poll-wait and the Telegram
fallback so the body ENDS at the cache frontier** (producing exactly the CUT shape ffmpeg
salvages from, per H-B1a). Gate points: the poll loop (:1148) and the fallback entry (:1231-1233).

## Bonus finding — `-flush_packets 1` (01:43:44)

Without it, out.srt stays 0B until ffmpeg closes (SIGKILL at t=45s → 0 cues, 01:37:24). With
`-flush_packets 1`, output grows incrementally (8KB@5s → 40KB@25s; SIGKILL at t=25s → **90
cues on disk**). Cheap resilience for the 120s-timeout path (:6125-6129 currently deletes tmp
on timeout — could salvage instead). Belt, not load-bearing once the input is bounded.

## H-B3a — actix does NOT drop handler futures on client disconnect — VERIFIED (experiment, decisive)

Purpose-built actix-web 4.14 harness (`.tmp-subs-exp/actix-disc`): `/await_child` spawns a 60s
child with `kill_on_drop(true)` and awaits `.output()`. Client disconnected at t=2s
(`curl --max-time 2`, exit 28). Handler log: **`await_child child finished after 60.6s:
Ok(ExitStatus(0))`** then guard drop (transcript 01:44:27). ⇒ For non-streaming handlers,
**actix-web runs the future to completion after disconnect**. A frontend AbortController alone
CANNOT kill a running extraction; the only bound is the handler's own 120s tokio timeout
(server.rs:6118), whose expiry drops `cmd` → kill_on_drop kills ffmpeg.

## H-B3b — chain after ffmpeg death — VERIFIED (source)

`StreamingGuard` (server.rs:256-266) untracks streaming in Drop; the /stream body holds it, and
streaming-response futures ARE dropped when their client (ffmpeg) disconnects — actix pushes
chunks and gets the write error, or the fallback loop's cancel/DownloadGuard (:1266-1277)
unregisters. `delete_cache` refusal is `is_streaming` (stream_cache.rs:964-965, :1179/:1199).
⇒ ffmpeg dies → subs /stream drops → guard untracks → deletion unblocks. Round-3's locked
files existed only because ffmpeg lived the full session.

## Consequence for the fix design

1. **Bounded input is the fix.** Extract call site appends `cached_only=true` when
   `!fully_cached`; stream body ends at frontier when cached_only ⇒ extraction reads the disk
   prefix at local speed (seconds), exits 0, cues served with the EXISTING X-Subs-Partial
   machinery. B3's 16-min bandwidth theft + delete-block + locked-files all collapse to a
   seconds-long window. No AbortController needed (and per H-B3a it wouldn't work anyway).
2. Optional belt: `-flush_packets 1` in `build_sub_extract_args` (+ salvage-on-timeout later if
   ever needed).
3. Frontend (B2): show partial cues immediately (already happens via normal success path);
   remember partial tracks; re-extract on menu re-open (server won't disk-cache partials, so a
   re-request re-runs against the bigger prefix — self-improving).

## Minimal server-change surface (amended per R1 — THREE server elements)

| Function | Change |
|---|---|
| `StreamQuery` (server.rs:328 area) | new `cached_prefix: Option<bool>` param |
| stream handler pre-body (server.rs:753-764 + :768-1005) | when `cached_prefix`: skip the initial 503 AND the coordinator subscribe/spawn — fall straight into the stream body |
| /stream body (`stream!` :1011+) | capture `cached_prefix` before stream!; gate poll-wait (:1148-1223) and Telegram fallback (:1231-1233) — end body at frontier |
| `subtitles_extract_track` (server.rs:6099 area) | append `&cached_prefix=1` to the input URL when `!fully_cached` (NOT inside shared `subs_input_source`) |
| `build_sub_extract_args` (server.rs:2698-2731) | optional `-flush_packets 1` |
| Frontend `fetchEmbeddedSubText` / `toggleEmbeddedSub` | surface `partial` in return; re-extract partial tracks on menu re-open (replace cached track, R5) |
