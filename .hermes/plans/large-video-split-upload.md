# Plan: Large Video Split Upload (>2GB)

Branch: `feature/large-video-split-upload`
Status: VALIDATED — feasibility audit green (E1–E12 citations verified in-tree); requirements audit pass; validator risks folded in below

## 0. Summary

When a user uploads a video larger than their account's Telegram per-file cap
(2GB free / 4GB premium, auto-detected), a WhatsApp-style split screen opens:
filmstrip preview + info + auto-proposed draggable cut handles. On confirm, a
lossless split-and-upload pipeline runs in one go (`split K → upload K →
delete temp K`), naming parts `Movie.part01.mkv`. Jobs persist; interruption
(power loss, network death, app close) leaves finished parts uploaded and
offers resume if the source file is still present and unmodified. Parts play
back seamlessly as one continuous movie.

## 1. Evidence base (all verified in-tree or sourced)

| # | Fact | Evidence |
|---|---|---|
| E1 | Cap = 2_000_000_000 free / 4_000_000_000 premium | `commands/utils.rs:81-83` `upload_limit_bytes()` |
| E2 | Premium detection works | `is_premium()` reads `get_me().raw.premium`; TL field verified at generated_types.rs:57654 |
| E3 | Oversize rejection seam exists today | `useFileUpload.ts:194-206` — manual picker pre-validates size vs `limitBytes`, rejects with toast.error |
| E4 | Upload engine: path-based, takes `display_name` override | `cmd_upload_file` `fs.rs:475`; naming = zero backend work |
| E5 | Progress events standardized | `upload-progress {id, percent, uploaded_bytes, total_bytes, speed_bytes_per_sec}` @250ms cadence, both paths |
| E6 | Cancellation standardized | `cancelled_transfers` set + `cmd_cancel_transfer` (fs.rs:285) |
| E7 | Bandwidth gate standardized | `BandwidthManager.can_transfer / add_up`, daily cap |
| E8 | ffmpeg available, NOT bundled | `ffmpeg_util.rs`: 4-tier resolve + `ensure_ffmpeg_or_download` (~45MB gyan.dev on first need); `ffmpeg-sidecar = "2.5"` Cargo.toml:51 |
| E9 | Sprite/thumbnail + duration-probe precedents exist | `cmd_generate_sprite_sheet` (sprite.rs:66), `cmd_probe_duration` (sprite.rs:215). Nuance: both probe HTTP stream URLs and sprite uses fps-filter — precedent is COMMAND SHAPE only; filmstrip uses E15 fast-seek instead |
| E10 | Drop path is stream-direct (no file path available) | `useDropStreamUpload.ts` POSTs raw File to actix :14201; `stageDroppedFiles` = temp-copy fallback |
| E11 | Drop ceiling already u32 max (premium-ready) | `MAX_DROP_BYTES = 4_294_967_295` (upload_drop.rs:44) |
| E12 | grammers `upload_stream(reader, size, name)` needs declared size up front | fs.rs:555, upload_drop.rs:217 — why a finished part file must exist before its upload begins |
| E13 | Oversize rejection happens server-side during upload negotiation | MTProto error is `FILE_PARTS_INVALID` at saveBigFilePart (total parts declared on every call); `FILE_TOO_BIG` is Bot-API-only. Client-side check routes; server enforces |
| E14 | Lossless `-c copy` cuts snap to preceding keyframes; movie-rip GOPs typically ≤10s | ffmpeg wiki / research agent — accepted tradeoff per user |
| E15 | Per-thumb fast-seek ≈3.8x faster than fps-filter filmstrips | research agent (sebi.io benchmark) |
| E16 | Splitting precedent: mirror-leech-telegram-bot et al. split oversize files into parts for TG | research agent (GitHub) |
| E17 | TRUE caps are binary: 2_097_152_000 / 4_194_304_000 B (= 4000/8000 appConfig parts × 512KiB) | core.telegram.org/api/config; app's `upload_limit_bytes()` decimals are ~97MB CONSERVATIVE → rare unnecessary split for files in that band; accepted (consistency + safety), FILE_PARTS_INVALID triggers replan |
| E18 | Albums/media groups cap at 10 items (MULTI_MEDIA_TOO_LONG); nothing server-side links N>10 documents | core.telegram.org sendMultiMedia error table — validates naming-based grouping, albums rejected |
| E19 | ffmpeg guaranteed early: App.tsx:36 invokes cmd_ensure_ffmpeg on mount | split modal can assume ffmpeg or surface the deps panel state |
| E20 | `get_video_duration` (sprite.rs:31) shells ffprobe against any URL — local paths included; local-only gap is duration/resolution extraction, which prepare adds | recon agent; no new probing machinery needed |

## 2. Locked product decisions (interview, round 1-3)

| Decision | Locked value |
|---|---|
| Trigger | Any VIDEO whose size exceeds `upload_limit_bytes()` (dynamic 2GB/4GB) |
| Slider semantics | Divide into parts; NOTHING discarded (no trim/crop-out) |
| Non-video over cap | Rejected with clear message (unchanged behavior) |
| Cut mode | 100% lossless stream-copy, no re-encode |
| Boundary UX | Auto-proposed equal cuts + draggable handles (my delegated call) |
| Naming | `<stem>.part<zero-padded-index>.<ext>` e.g. `Movie.part01.mkv` |
| Execution | One go, sequential parts, no further interaction |
| Failure mid-run | Stop queue; finished parts stay; rest resumable later |
| Resume | Offered on relaunch IF source unchanged + same target channel |
| Playback | Seamless chaining Part1..N as ONE movie in v1 |
| Gaps (missing middle/end parts) | Play contiguous prefix; stop at first gap with "Upload remaining parts" action |
| Preview depth | Filmstrip (12 thumbs) + size/duration/parts readout; no scrub-preview in v1 |
| Interrupted visibility | Upload/transfers window (user: "on upload window") |
| Source file | NEVER modified or deleted — read-only always |

## 3. Architecture

### 3.1 Data model

ONE new SQLite table (jobs/resume only). Part GROUPING for playback uses the
naming convention itself (regex `^(.*)\.part(\d+)\.(ext)$`, contiguous indexes
from 01, same stem) — works cross-device with zero sync, no second table.
Resume is inherently local-machine-only (it needs the source file), so the
jobs table never needs to sync either.

Lives in its OWN database file `nobuf_jobs.db` (same `db_path`/`get_connection`
helper pattern as `nobuf_groups.db`, folder_groups.rs:25-38; SQLite work stays
in sync scopes — open→operate→drop before any `.await`).

```sql
CREATE TABLE IF NOT EXISTS split_upload_jobs (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  source_mtime INTEGER NOT NULL,   -- resume validity check
  temp_dir TEXT NOT NULL,          -- where this job's .nobuf-tmp files live
  display_name TEXT NOT NULL,
  folder_id INTEGER,               -- None = Saved Messages
  cap_bytes INTEGER NOT NULL,
  boundaries_json TEXT NOT NULL,   -- [cut timestamps in seconds]
  parts_json TEXT NOT NULL,        -- [{idx,name,startSec,endSec,status,messageId}]
  status TEXT NOT NULL,            -- pending|running|interrupted|done|failed|source_missing
  created_at INTEGER, updated_at INTEGER
);
```

Temp parts are written NEXT TO THE SOURCE:
`<dir>/<stem>.partNN.<jobid8>.<ext>.nobuf-tmp` — same drive as the source
(fast I/O), invisible to %TEMP% cleaners, jobId-suffixed so concurrent jobs
on the same source never collide, deleted immediately after each part
uploads. Because ffmpeg infers its muxer from the final extension, the
orchestrator ALWAYS passes `-f matroska|mp4` explicitly (container detected
once at prepare). CONTAINER POLICY: input `.mp4/.m4v/.mov` → `-f mp4`, part
extension `.mp4`; ALL other inputs (mkv/ts/avi/wmv/webm…) → `-f matroska`,
part extension `.mkv` (normalization beats preserving legacy containers, and
matroska accepts virtually every codec incl. VP9/AV1). STREAM-DROP POLICY at
prepare: ffprobe stream list decides the map — plain video+audio(+subs) gets
full `-map 0`; presence of data streams (KLV etc.) or exotic codecs switches
to `-map 0:v -map 0:a` and the modal shows "subtitles/attachments will be
dropped" BEFORE confirm. TEMP-DIR FALLBACK: if the source directory is not
writable (read-only share/optical), temps go to
AppData/com.istiaq.nobuf/split-tmp/<jobid8>/ instead (recorded in temp_dir;
resume penalty already documented and accepted). Startup sweep removes
orphans under every known temp_dir whose job row is gone.

### 3.2 New backend module: `commands/split_upload.rs`

| Command | Role |
|---|---|
| `cmd_prepare_split(path, folder_id) -> SplitPlan` | ffprobe duration; cap via `upload_limit_bytes`; propose `ceil(size/(cap−MARGIN))` equal-time cuts; snap internal cuts to nearest preceding keyframe (`ffprobe -read_intervals`); filmstrip ≈12 thumbs via fast-seek-per-thumb (sprite.rs precedent); returns boundaries + thumb data URLs + per-part name/size estimates |
| `cmd_start_split_job(plan)` | Verify source size+mtime; insert job; spawn orchestrator |
| `cmd_cancel_split_job(id)` | Cooperative cancel token (mirrors `cancelled_transfers` pattern) |
| `cmd_resume_split_job(id)` | Re-verify size+mtime AND re-probe duration — mismatch on either → refuse (`source_changed`, exFAT/network drives have coarse mtimes, see edge 9); respawn from first non-done part; any replan here or mid-run is TAIL-ONLY (edge 22) |
| `cmd_list_split_jobs()` / `cmd_discard_split_job(id)` | Transfers window + banner; discard cleans temps |

Orchestrator loop (one tokio task), per waiting part K:

1. Emit phase → ffmpeg `-ss <start> -i src -t <dur> -map 0 -c copy` with
   explicit `-f` (container policy §3.1) to the job's temp_dir.
2. Stat output; if part > cap (VBR pile-up edge case): auto-insert ONE extra
   cut inside that part, replan TAIL-ONLY (never touches already-uploaded
   parts or their names/indexes), redo — bounded at 2 replans, then fail loudly.
3. Upload via shared `upload_file_inner()` extracted from `cmd_upload_file`
   (fs.rs refactor, existing command delegates — no behavior change;
   `cmd_upload_from_url` keeps its own copy, dedup explicitly out of scope)
   with tid `split:<jobId>:<K>`.
4. Delete temp → persist row → next part. Any failure after retries →
   status=interrupted, loop exits, finished parts stay.

**CHAINED SNAP INVARIANT:** boundaries are stored POST-SNAP and part K+1
starts at part K's exact snapped end — seams never gap or overlap by up to a
GOP (asserted in Phase A tests: Σ part durations ≈ source duration).

**Naming padding:** zero-pad index to max(2, digits(N)) — `part01`…`part07`,
`part100`+ sorts fine past 99 parts.

**Test cap override:** split-module cap reads `NOBUF_FAKE_UPLOAD_CAP_BYTES`
env BEFORE consulting `upload_limit_bytes()` — injection point for Phase A/E
integration tests; production behavior untouched.

MARGIN = 64MB under the cap for estimation drift; the hard guarantee is the
post-split byte check, not the margin.
Pre-flight BEFORE the loop: free disk space ≥ largest estimated part (+256MB
slack) on the source drive, else refuse with clear reason (today only a
mid-run failure would catch it). Temp deletes use the retry-cleanup thread
pattern already in fs.rs:265-281 (Windows AV/indexer locks).

### 3.3 Seamless playback (biggest work item)

- Listing: consecutive `stem.partNN.ext` documents collapse into ONE card
  ("Movie.mkv · 3 parts") — pure listing-layer transform.
- Player: virtual timeline = Σ part durations (probe per part, cached).
  Global time ⇄ (part, offset) mapping; natural end-of-part rolls into the
  next part's `/fmp4` stream without touching the visible timeline; seeks
  translate global→(part, offset). Server needs NO changes — every part is
  already an ordinary streamable document.
- PHASE D GATE (spike first): FastStreamPlayer seek machinery is byte-offset-
  centric per single document (linear byteToTime, VBR anchors, player
  recreation on remux seek — FastStreamPlayer.tsx:805-912,1087-1130), so the
  real cost is wiring the mapping INTO that machinery, not the math. Before any
  Phase D estimate: decide MSE lifecycle — fresh MediaSource per part (clean
  codec/params boundary, brief black-frame handoff) vs timestampOffset surgery
  into one buffer (fragile across parameter changes, forbidden mimeType
  switches). Spike = 1-day prototype switching two synthetic parts both ways.
- Gap rule: chain plays to the FIRST missing index, stops cleanly, shows
  notice. "Upload remaining parts" button renders ONLY when a matching local
  job exists (otherwise a device without the source cannot split — show
  informational state instead).

### 3.4 Frontend integration points (all verified seams)

| Seam | Change |
|---|---|
| `handleManualUpload` (useFileUpload.ts:194) | Today: rejects oversize with toast.error. New: video+oversize → open `SplitUploadModal` instead; non-video oversize keeps the rejection toast |
| Drag-drop of oversize video | WebView2 gives no path (stream-direct). Route to a one-off stage-to-temp copy WITH progress, then treat temp copy as source (documented tradeoff: resume of a drop-originated job dies gracefully at source-missing if %TEMP% was cleaned) |
| `SplitUploadModal.tsx` (new) | Filmstrip strip + draggable handles + readout + Confirm/Cancel; nobuf theme tokens |
| Transfers window | Job items: overall "K of N", phase label (Splitting/Uploading part k), per-part bar via existing `upload-progress` (id `split:<job>:<k>`), cancel/resume/discard |
| Startup | `cmd_list_split_jobs` → pending/interrupted → resume banner in transfers window |

## 4. Edge cases (each maps to a test)

| # | Case | Handling |
|---|---|---|
| 1 | Video ≤ cap | Splitter never triggers; flow byte-identical to today |
| 2 | Non-video > cap | Rejected with message naming the limit and that only video can split |
| 3 | Video whose extension lies (.mkv that isn't) / corrupt | ffprobe fails → modal shows "not a readable video" |
| 4 | Audio-only or image file mislabeled as video | ffprobe reports no video stream → rejected |
| 5 | Duration missing/lying in header (MKV no-cues, moov-at-end MP4) | ffprobe duration fallback chain; if unresolvable, estimate from bitrate then verify during split; boundaries re-derivable at resume |
| 6 | Part exceeds cap after lossless cut (VBR pile-up around a high-bitrate stretch) | Post-split stat check → auto-insert one extra cut inside that part → redo; loop bounded (max 2 replans per part, then fail loudly) |
| 7 | Source modified/deleted before start | size+mtime verify at `cmd_start_split_job` → error |
| 8 | Source deleted mid-run | Next ffmpeg spawn fails → status=interrupted(source_missing); parts stay; resume offers discard |
| 9 | Source changed but same size (touch) | mtime check catches; resume refuses with source_changed |
| 10 | App killed mid-ffmpeg (orphan .nobuf-tmp on disk) | Startup sweep deletes .nobuf-tmp files lacking an active/waiting job row |
| 11 | Disk full while writing temp part | ffmpeg write error → interrupted; user frees space; resume redoes ONLY that part |
| 12 | Telegram FLOOD_WAIT mid multi-part run | Existing backoff patterns apply per-part upload; between-parts pacing via existing bandwidth manager; failure after retries → interrupted (never kills app-wide transfers) |
| 13 | Bandwidth daily cap hit mid-job | `can_transfer` pre-check per part → paused-interrupted state with clear reason; resumes next day/user action |
| 14 | User uploads same movie twice / two jobs same source | Allowed — independent jobs; jobId suffix in temp names prevents collisions (§3.1) |
| 15 | Cancel during split phase vs upload phase | Cooperative token checked at both boundaries; upload cancel routes through existing cancelled_transfers tid |
| 16 | Part N uploaded but send_message fails (ALREADY_STORED class) | Bytes stored server-side; mark part done-if-message-found else retry-safe pending; never blind-reupload (duplicate prevention mirrors upload_drop.rs logic) |
| 17 | Parts uploaded to folder later deleted from app | Job keeps folder_id; resolve_peer failure → interrupted with reason |
| 18 | Two devices see the same part group; other device lacks source | Gap button renders informational state (3.3); listing/playback unaffected cross-device |
| 19 | Filename already contains ".part2." | Regex requires contiguous index run STARTING at 1 for grouping; stray `.partN.` in stem doesn't group alone; splitter output always regenerates clean indexes |
| 20 | Unicode/spaces/emoji filenames | Temp names preserve stem (same-dir rule), Rust std handles unicode paths; display_name passthrough already proven (E4) |
| 21 | 20GB file = ~7-15 parts ≈ hours of upload | Sequential by design (FLOOD safety); queue shows honest ETA from rolling speed; cancel-anytime |
| 22 | Premium expires between prepare and part K upload | Cap was captured at prepare; if a later part exceeds CURRENT cap, server answers FILE_PARTS_INVALID → interrupted with reason; resume re-reads cap and replans (tail-only, see §3.2) |
| 23 | Source drive nearly full when job starts | Pre-flight free-space gate (§3.2) refuses before burning hours; error names needed vs available |

## 5. Phases & acceptance criteria

Phase A — Backend split core
- `upload_file_inner()` extraction (fs.rs refactor, zero behavior change)
- `split_upload.rs`: prepare/start/cancel/resume/list/discard + orchestrator + SQLite table
- Command registration via the 3-file pattern (commands/mod.rs, lib.rs generate_handler, autogenerated permissions committed)
- ✅ Acceptance: cargo test unit tests for boundary math (cap margin, ceil parts, keyframe snap stubs); SEAM-CONTIGUITY test (part K+1 start == part K snapped end; Σ part durations ≈ source duration within tolerance); integration test splits a generated 3-min synthetic video into 2 parts under `NOBUF_FAKE_UPLOAD_CAP_BYTES`, byte-sizes < cap, each plays (ffprobe duration ≈ half), source untouched (hash compare)

Phase B — Upload orchestration
- Per-part progress events, cancel token, retry/backoff, interruption persistence
- ✅ Acceptance: kill -9 mid-part-2 of 3 → relaunch lists interrupted job → resume uploads only parts 2-3; cancel mid-part leaves finished parts; mutation-test the resume path (revert → RED, restore → GREEN)

Phase C — Split screen UI
- Modal: filmstrip (12 fast-seek thumbs), draggable handles w/ min-part guard, readout, confirm/cancel
- ✅ Acceptance: vitest for handle-drag math (no overlap, ≥1min parts, clamp); manual QA on a 2.5GB real MKV is MODAL-ONLY (prepare/filmstrip/handles/confirm→job creation — no hours-long upload burn during QA)

Phase D — Seamless playback
- D0 spike (gating): prototype both MSE strategies on synthetic parts; pick one; record decision in this file
- Listing collapse into one card; virtual timeline + part-switching in FastStreamPlayer; gap notice + remaining-parts action
- ✅ Acceptance: vitest timeline-mapping property tests (random seek t → part+offset → back == t, bounds respected); manual QA: play across seam completes with NO user-visible error/stuck state (stall measured + logged; ≤1 buffer cycle is the target, not a hard gate — dual-video preload is the fallback if missed); seek into part 3 directly works; delete part 2 → plays part 1 then stops with notice

Phase E — Transfers window & resume UX
- Job rows, phase labels, resume banner, startup sweep
- ✅ Acceptance: full gates (`npx tsc --noEmit`, `npx vitest run`, `cargo test --no-default-features`); QA suite per qa/qa-app skills; E2E: 2.2GB file end-to-end free-cap simulation via fake cap env override

## 6. Out of scope (explicit)

- Trim/exclude segments (nothing is ever discarded)
- Frame-exact cuts / smart-cut re-encode
- Non-video binary splitting (zip.001 style)
- Cross-device resume (needs source file; grouping itself IS cross-device)
- mkvmerge; WASM ffmpeg; bundling ffmpeg into installer (on-demand download stays)
- Subtitle/attachment-chapter preservation guarantees beyond `-map 0` best effort
- Caption-embedded machine-readable part manifests (research suggestion; naming convention already groups cross-device — revisit if a future sync feature needs it)

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Seam glitch at part boundary during seamless playback (audio pop / frame jump) | Medium — inherent to separate documents | Same-codec same-params sources make discontinuity minimal; accept minor imperfection v1, log seam metrics for tuning |
| Keyframe snapping shifts boundaries up to ~10s from proposal | Low — cosmetic | Show snapped times in readout so user sees reality before confirm |
| fs.rs refactor touches the hottest file in the repo | Medium | Pure extraction, cmd_upload_file delegates; full gate run + existing upload QA before proceeding |
| Long sequential runs hit daily bandwidth cap | Medium | Pre-check per part → clean paused state (edge 13) |
| Rate-limit on research left GOP/precision numbers partially sourced | Low | Phase A acceptance test measures REAL keyframe behavior on synthetic + real media before UI ships |

---
*End of plan. Validation next.*
