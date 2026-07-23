# HEVC remux-seek "loads forever" — cross-validation

Prior diagnosis is a HYPOTHESIS. Re-derive every claim against source + the runtime log.
Mark each VERIFIED / FALSIFIED / INCONCLUSIVE. Verify by execution where possible.

## Claims under test (from my previous message)
- C1: Seek routing fires correctly (`/remux?ss=580.6` → backend `-ss 580.600`). [frontend/backend]
- C2: `ffmpeg -ss 580 -i /stream/<mkv>` issues source-file Range reads around the
  seek point (~238–316 MB), not near byte 0.
- C3: Proactive downloader is the ONLY Telegram downloader; `/stream` reads only cache.
- C4: Frontend reports playhead as an OUTPUT-relative byte ≈0 for the recreated remux
  player, and this stomps `proactive_targets[msg]` back to ~0 every ~2s.
- C5: Because the target is ~0, the downloader never JUMPS to the seek region; it marches
  sequentially from a low frontier → ffmpeg's source read at the seek offset starves.
- C6: `stream_media` (server.rs:579) captures `data: web::Data<Arc<TelegramState>>` which
  owns `proactive_targets` → backend CAN retarget from the poll loop.
- C7: Net effect: ffmpeg starves → no TS output → mpegts.js "loads forever"; the
  download/prebuffer indicator tracks the sequential fill → "prebuffer far from seek point".
- C8: Duration mismatch — frontend est=1904s vs ffprobe real=2317s — is present and may
  compound the byte-offset error.

## Findings

### C1 — Seek routing fires correctly — **VERIFIED**
Log: `[MPEGTS] Remux seek: recreating from …&ss=580.600` → backend
`[REMUX] msg 19: seeking to 580.600s before remux`. `build_ss_seek_args` emitted `-ss`
before `-i`. My shipped frontend routing + backend arg builders WORK. Not the bug.

### C2 — ffmpeg reads the SEEK REGION of the source, not just byte 0 — **VERIFIED (by runtime log)**
`/remux` passes `-i http://127.0.0.1/stream/<msg>` (server.rs:2221) — ffmpeg's INPUT is
the raw MKV over HTTP. For the 606s seek (19:28:48) the /stream handler served TWO
disjoint regions to ffmpeg: `served 0-106954751` (header/cues) AND
`served 267551792-316145663`, then blocked: `STREAM-CACHE-WAIT waiting for cache at
offset 316145664 … 10000ms`. So the matroska demuxer seeks via Cues to source byte
~267–316 MB for the 606s point. Source-side seek is real.

### C3 — proactive is the ONLY Telegram downloader; /stream reads cache then falls back — **VERIFIED**
server.rs:1043-1047 comment + poll loop (1113-1189): /stream reads disk cache, waits for
proactive to fill, and only self-downloads from Telegram in the FALLBACK branch (1196+)
after the 5s-no-active-download break or 15s timeout.

### C4 — frontend stomps target to ~byte 0 — **PARTIALLY VERIFIED / trigger INCONCLUSIVE**
My `_mpegtsRecreatePlayerForRemuxSeek` does NOT report position (verified: no
`cmd_report_playback_position` call in it, lines 4772-4932). The reporter that DOES fire
for this path is the periodic mpegts interval (useMSEPlayer.ts:3480-3503, **10s** cadence,
`currentTimeS=v.currentTime`, `byteOffset=null`, gated `!v.paused && !v.ended`). The log's
`[PROACTIVE] playhead jumped backward to byte 0` (19:27:36) is consistent with this
reporter ticking while the freshly-recreated `<video>` momentarily reads
`currentTime≈0` (new media load before first frame decodes). Exact trigger is
INCONCLUSIVE and does not change the fix.

### C5 + C7 — downloader never reaches the seek region → ffmpeg starves → loads forever — **VERIFIED (core root cause)**
After the 580s seek, proactive downloaded `SEQUENTIAL download gap 49283072-951558937`
— marching from ~49 MB. ffmpeg's input, meanwhile, blocked at 316 MB
(`STREAM-CACHE-WAIT … 10000ms`). They never met inside the timeout → ffmpeg gets no
source bytes at the seek offset → emits no TS → mpegts.js "keeps loading." The
download/prebuffer indicator tracks the sequential-from-~49 MB fill, which is why the
"prebuffer starts way too far from the seek point." **This is the actionable bug.**

### THE DEADLOCK (sharper than the original claim)
The mpegts reporter derives the source byte from `v.currentTime`. But `currentTime`
only advances once ffmpeg emits decoded frames — which it can't, because it's starved at
the seek offset. So: currentTime stays low → reporter reports a low byte → proactive
stays low → ffmpeg stays starved → currentTime never advances. Self-reinforcing.
Even the 10s reporter cadence can't break it because the reported byte is wrong by
construction (output-relative currentTime, not the source offset ffmpeg is blocked on).

### C6 — backend CAN retarget from the /stream poll loop — **VERIFIED**
`stream_media` (server.rs:579) captures `data: web::Data<Arc<TelegramState>>`;
`TelegramState.proactive_targets: Arc<RwLock<HashMap<i32,(u64,f64,f64,u64)>>>`
(commands/mod.rs:75). The poll loop knows the EXACT uncached `read_offset`. Writing that
into `proactive_targets[msg].0` makes the running proactive loop re-evaluate
(streaming.rs:1038 forward-jump / 1058 backward-jump) and slide to it. Fix is feasible
exactly where I proposed.

### C8 — duration mismatch (est 1904s vs ffprobe 2317s) — **VERIFIED, and it WORSENS the estimate**
Frontend estimates `duration = filesize*8/4Mbps = 952013174*8/4e6 ≈ 1904s`
(useMSEPlayer.ts:2668/2687). Real ffprobe duration = 2317s (log 19:28:48). The reporter
uses the 1904s estimate, so a linear time→byte mapping is off by ~18%. This is a
SECONDARY error stacked on the primary output-vs-source mismatch — even if currentTime
were right, the byte estimate would still miss. Reinforces that the ONLY reliable source
byte is the one /stream itself is blocked on (backend-side).

## VERDICT
Root cause CONFIRMED and it is NOT the shipped seek routing (that works). The failure is
that the proactive downloader is aimed by an output-relative / mis-scaled frontend
playhead, so it never fetches the SOURCE bytes ffmpeg's `-ss` demuxer-seek requires →
starvation deadlock. Correct fix = make /stream publish the exact uncached read_offset as
the proactive target (backend, authoritative) + stop the remux path from reporting a
meaningless source byte (frontend). Both parts justified by evidence above.

## Corrections to my prior message
- "overwrites … every ~2s" was WRONG — the 2s reporter is MP4-only (6540-6546). The
  mpegts/remux reporter is **10s** (3501). The stomp is real but slower; the deadlock
  (currentTime can't advance) is the stronger explanation, not cadence.
- Byte region "~238–316 MB": the 316 MB blocking offset is VERIFIED from the log; the
  238 MB figure was my (ratio*filesize) estimate — the demuxer-chosen Cue offset is what
  matters and the log shows 267–316 MB.

### Why the existing Telegram FALLBACK didn't save it — **PARTIALLY FALSIFIED / INCONCLUSIVE**
CORRECTION (2nd pass, from code trace): my earlier claim that "proactive keeps
`has_active_download` true → fast-break resets" is **FALSIFIED**. `register_download` is
called ONLY from `hls/manifest.rs` and the `/stream` Telegram-fallback branch
(server.rs:1220). The proactive prebuffer NEVER registers (grep proof: no
`register_download`/`active_downloads` in `proactive_prebuffer_download` body 701-1173).
So `active_download_count(message_id)` does NOT count proactive.

Therefore the fast-break condition `!has_active_download && elapsed>=5000` (server.rs:1177)
is only held true by ANOTHER *registered* download for the same msg — i.e. a concurrent
/stream request already in its own Telegram-fallback phase (e.g. ffmpeg's header read of
0-107MB). Whether that actually happened in the failing run is **INCONCLUSIVE**: the raw
runtime logs (N-t.md/N-c.md) were cleaned up after the first pass and cannot be re-read.

### Consequence for the fix — Part 1 mechanism was WRONG
- Original Part 1 ("retarget `proactive_targets` to read_offset") is **WRONG**: on a forward
  target jump the proactive loop applies a **+40s-ahead offset** (streaming.rs:880-895),
  so it would download from `read_offset + ~40s` and SKIP the exact bytes ffmpeg is blocked
  on — perpetuating the starvation.
- "Offset-aware fast-break" (break when no *registered* download covers read_offset) is ALSO
  **UNSAFE**: since proactive never registers, that check would make /stream fall back to
  Telegram on EVERY uncached byte during NORMAL playback too — breaking the core
  "proactive is the only downloader" architecture (C3) and reintroducing FLOOD_PREMIUM_WAIT.

### THIRD PASS — two more corrections (both from source)

CORRECTION B — **Part 2 gate was TOO BROAD (self-caught regression).**
`cmd_report_playback_position` (streaming.rs:544-660) is the SOLE trigger that STARTS a
proactive task (only `track_proactive`/spawn caller). My first Part 2 edit gated BOTH 10s
reporters with a blanket `if (needsRemuxSeekRef.current) return;` → proactive would NEVER
start for ANY remux playback, not just seeks. Regression. FIXED: narrowed the guard to the
bogus-transient window only:
    if (needsRemuxSeekRef.current &&
        (__nobuf_userSeekInProgress === true || v.currentTime < 1)) return;

CORRECTION C — **"currentTime is output-relative garbage for remux" was FALSIFIED.**
In `_mpegtsRecreatePlayerForRemuxSeek`, `_dtsBase` is pinned to 0, so the /remux?ss= stream's
ABSOLUTE PTS (~581s for ss=580) flow straight to `video.currentTime`; initial remux emits PTS
from ~0. So currentTime is source-ABSOLUTE time and the linear estimate
`(currentTime/duration)*filesize` is an approximately-valid CBR source byte — normally fine to
report. The REAL defect is a TRANSIENT: during player recreation the <video> momentarily reads
currentTime≈0 before the first ss-frame decodes; a 10s tick landing there reports byte 0 and
stomps the proactive target to file start (the "playhead jumped backward to byte 0" line).
The narrowed guard suppresses ONLY that window.

CORRECTION D (secondary) — the duration estimate (1904s vs real ~2317s) SELF-HEALS: the
`/fmp4/metadata` (ffprobe-tail) fetch updates `mpegtsDurationRef` + sets
`__nobuf_durationIsEstimate=false` ~9s in (useMSEPlayer.ts:3007). So the byte estimate converges;
not a persistent bug.

### Edge cases handled by the narrowed guard (verified against source)
- Normal mid-file remux playback (currentTime>1, not seeking): reports normally → proactive
  runs/slides. NO regression.
- Seek recreation window: `__nobuf_userSeekInProgress` true (set 3560 → cleared 4935) → suppressed.
- Residual post-clear window (first frame not decoded, currentTime≈0): `currentTime<1` → suppressed.
- Genuine seek to t<1s: suppressed, but byte 0 is correct & covered by bootstrap → harmless.
- Paused: outer `v.paused` guard returns first → "paused means paused" respected.
- Native TS / timed_id3: `needsRemuxSeekRef` never set → guard inert → byte-seek path untouched.
- MP4 path: `startMp4ProactiveReporter` is MP4-only (comment L6555) → not on remux path, unaffected.

### Honest status
Part 2 (frontend, NARROWED guard on both 10s reporters) — SHIPPED. tsc --noEmit clean.
Part 1 (backend) — NOT shipped. Original "retarget proactive" mechanism is WRONG (40s-ahead
offset would skip the needed bytes) and there is no evidence for a specific alternative. The
raw failing-run logs were cleaned up and cannot be re-read. Correct next step: add targeted
instrumentation to the /stream poll loop + fallback (log read_offset, fast-break timing,
fallback first-byte latency, any ffmpeg re-seek), reproduce ONE HEVC seek in `tauri dev`, then
fix from evidence. Do NOT ship speculative coordinator changes.
