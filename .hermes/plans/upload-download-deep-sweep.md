# Upload/Download Subsystem — Deep Multi-Phase Sweep & Review

**Date:** 2026-08-28
**Scope:** ALL upload/download functionality — not limited to WP1–6.
**Status:** ACTIVE PLAN — execute phases in order, no approval pauses between phases.

---

## 0. Objective & Success Criteria

Audit the entire upload/download subsystem with multiple independent review
angles, consolidate every finding into a review doc, then **re-verify every
finding with fresh eyes** (parent, not the finding's author) before any fix
ships.

**Acceptance criteria (all must hold to close this plan):**

- [ ] AC1: Every review angle dispatched and returned (≥7 subagents across 7 angles).
- [ ] AC2: Every finding written to `.hermes/plans/upload-download-sweep-findings.md`
      with file:line evidence — no findings live only in chat.
- [ ] AC3: Every finding re-derived from source by the parent and graded
      VERIFIED / FALSIFIED / INCONCLUSIVE / RISK-ACCEPTED with file:line.
- [ ] AC4: Every VERIFIED defect has a fix landed OR an explicit
      not-fixing rationale recorded in the findings doc.
- [ ] AC5: Full gates green after fixes: `cargo test --no-default-features`,
      `npx vitest run`, `npx tsc --noEmit`, `git diff --check`.
- [ ] AC6: Mutation-test every behavioral fix (revert → RED, restore → GREEN,
      byte-exact restore hash-verified).
- [ ] AC7: One commit per logical concern; commit message explains WHY.

---

## 1. Scope Map (Phase 1 — complete before dispatch)

### 1.1 Rust backend (D:/DEVELOPMENT/Telegram-Drive/app/src-tauri/src/)

| File | Lines | Role |
|---|---:|---|
| `commands/fs.rs` | 2181 | `cmd_upload_file`, `cmd_upload_from_url`, `cmd_download_file`, `cmd_cancel_transfer`, shared `upload_file_inner`, post-send reconciliation |
| `commands/split_upload.rs` | 2648 | Split pipeline: prepare → queue → promote → per-part split+upload → resume/retry/discard; SQLite jobs DB |
| `commands/upload_drop.rs` | 398 | Actix direct-stream upload handler (`upload_drop_handler`, registered server.rs:7835) |
| `commands/stage_drop.rs` | 129 | Actix staging route (`stage_drop_handler`, registered server.rs:7840) — chunked-IPC fallback is a separate Tauri command (`cmd_stage_dropped_file`) |
| `commands/streaming.rs`, `commands/archive.rs`, `commands/public_channels.rs` | — | Download-side consumers (semaphore-gated download loops; sprite/preview/opensubtitles do NOT gate on download_semaphore — verify whether they should) |
| `bandwidth.rs` | — | Bandwidth accounting (daily caps, up/down counters) |
| `api_routes.rs` | — | Actix route table incl. drop-stream endpoints |

### 1.2 Frontend (app/src/)

| File | Lines | Role |
|---|---:|---|
| `hooks/useFileUpload.ts` | 680 | Upload queue runner, retry/cancel generations, restart persistence (`reviveSavedUploads`), staged temp lifecycle |
| `hooks/useSplitUpload.ts` | 557 | Split rows store, hydration + retry, progress reducer, tid parsing |
| `hooks/useFileDownload.ts` | 310 | Download queue (cancels via `cmd_cancel_transfer`; deletes partial cache via `cmd_delete_cache` on cancel) |
| `hooks/useDropStreamUpload.ts` | 333 | XHR stream-direct path to local actix server |
| `hooks/useDroppedFileUpload.ts` | 166 | Chunked-IPC drop staging fallback |
| `hooks/useFileDrop.ts` | 10 | Drag-drop event plumbing |
| `components/dashboard/TransferPanel.tsx` | — | Unified transfers UI (uploads + downloads + split jobs + staging) |
| `components/dashboard/DownloadQueue.tsx` | — | Download rows |
| `components/Dashboard.tsx` | — | Wiring: handlers, toasts, persistence save/restore |
| `components/dashboard/RemoteUploadModal.tsx`, `OversizeDropChoiceModal.tsx` | — | URL upload + oversize-drop decision UI |

### 1.3 Cross-cutting seams

- `upload-progress` / `remote-upload-progress` / `split-progress` / `documents-changed` events (Rust emit ↔ TS listen)
- `cancelled_transfers` token set (insert/consume sites across 3 files)
- `nobuf_jobs.db` SQLite (split jobs) + IndexedDB `uploadQueue` store (normal uploads — `store.set('uploadQueue', …)` in `useFileUpload.ts:281`, NOT localStorage)
- `download_semaphore` (every `iter_download().next()` MUST hold a permit)
- Temp-file lifecycle (`%TEMP%` staged files, split part temps, `.nobuf-tmp` suffix, startup sweep)

---

## 2. Review Angles (Phase 2 — parallel dispatch)

Seven read-only subagents (R1–R7). Each gets: the scope map, its angle's checklist,
file paths, and the instruction to report findings as
`SEVERITY | file:line | claim | evidence (quoted code)` + a cleared-as-benign
list. Children NEVER edit the tree.

### R1 — Concurrency, races, stalls, deadlocks
Checklist: token insert/consume races; promotion vs cancel vs retry ordering;
lock-hold-across-await (RwLock/Statement); pipeline slot leak (running row
with no worker); semaphore starvation / priority inversion (background vs
foreground); FIFO violations; double-spawn of workers; queue-runner
serialization; event-listener double-attach; poll-loop timing (100ms cancel
poll); startup sweep racing hydration; generation-guard bypass paths.

### R2 — Resource leaks & bounds
Checklist: unbounded maps/sets/vecs (cancel tokens, splitRows, generations,
listeners); temp files orphaned on every failure path (enumerate exits!);
`.nobuf-tmp` cleanup reachability; localStorage growth; SQLite row growth
(done jobs kept forever?); disk-space guard before split; listener leaks on
remount; Promise/async leaks (fire-and-forget without catch).

### R3 — Error handling & silent failures
Checklist: every `let _ =` / `.ok()` / `catch {}` on a user-visible path —
is silence correct there?; fail-open vs fail-safe defaults (probe errors);
error text reaching users (does the toast name the cause?); partial-state
corruption on error (row says X, DB says Y); reconcile-delete failure
surfacing; bandwidth cap behavior on cancel mid-flight.

### R4 — Edge cases & input correctness
Checklist: empty/1-byte/0-duration files; filenames with `:`/unicode/very
long; path traversal in staged paths; size==cap boundary; part count 1;
duration missing in header; mtime/size re-verify tolerance; restart with
source file moved/deleted/modified; oversize non-video; concurrent app
instances; network death mid-send; disk full mid-split; duplicate drops of
same file (job id collision handling).

### R5 — Cross-layer contract consistency
Checklist: event payload field names (snake_case vs camelCase) Rust→TS;
status vocabularies (`running` vs `uploading` vs `splitting` — does every
TS consumer handle every Rust status?); `partIdx` semantics (index vs
count — the known mislabel class); `phase` values in split-progress vs
SplitJobRow.phase; invoke() arg casing (Tauri camelCase↔snake_case);
persistence schema vs reviveSavedUploads expectations; TransferPanel
action-button gating per phase.

### R7 — Local-server attack surface (upload/download endpoints)
The actix server bound on localhost serves `/upload` (upload_drop) and
`/stage-drop` (stage_drop) with NO auth token in the route registration
(server.rs:7835-7841). Any local process (or a webpage doing
localhost CSRF — the browser same-origin model does not block plain
HTTP POSTs to 127.0.0.1) could potentially stream arbitrary files into
the user's Telegram account or fill the disk via stage-drop. Verify:
bind address (127.0.0.1 vs 0.0.0.0), any Origin/Host header checks,
size caps on stage-drop, whether the port is predictable, and what a
successful unauthenticated POST can actually reach (the __whoami
impostor-discriminator precedent exists for multi-instance; is there a
per-session token?). This is upload/download-adjacent but the endpoints
ARE the upload path for drops — in scope.

### R6 — Performance & bottlenecks
Checklist: DB open per operation (get_connection frequency in hot loops);
per-part full-JSON parts rewrite (persist_parts on every part flip?);
progress event flooding (emit per chunk? per part?); redundant ffprobe
calls (duration probed repeatedly?); splitRows Array.from on every render;
queue mirror copies; download semaphore permit scope (held across
non-download work?); filmstrip thumbnail serial vs parallel; 60-min ffmpeg
timeout vs realistic part-split duration for huge files.

---

## 3. Findings Consolidation (Phase 3)

Parent merges all subagent reports into
`.hermes/plans/upload-download-sweep-findings.md`:
- Deduplicate overlapping findings (same root cause = one entry, note both
  reporters).
- Each finding: ID (F-01…), severity (P0 data-loss/corruption, P1
  user-visible breakage, P2 leak/degradation, P3 polish), file:line, claim,
  evidence quote, proposed fix sketch.
- Reporters' self-flagged uncertain items marked UNCONFIRMED pending Phase 4.

---

## 4. Fresh-Eyes Verification (Phase 4 — parent does this itself)

For EVERY finding, independently of the reporting child:
1. Re-read the cited file:line in the live tree (`git status` first — tree vs
   HEAD can disagree).
2. Re-derive the failure sequence concretely (inputs → interleaving →
   observable wrongness). If no concrete sequence exists → INCONCLUSIVE or
   FALSIFIED.
3. Grade: VERIFIED (sequence holds, it's reachable in practice) /
   FALSIFIED (guard exists / unreachable / misread) / INCONCLUSIVE (needs
   runtime) / RISK-ACCEPTED (real but bounded, fix costs more than risk).
4. Cross-validate contradicting findings between children myself.
5. Record the verdict + one-line proof in the findings doc.

**Rule: no fix ships off an unverified finding. No finding is dismissed
without a cited guard.**

---

## 5. Fixes (Phase 5)

- P0/P1 VERIFIED → fix now, root cause, sibling paths swept for the same
  class (fix the class, not the site).
- P2 VERIFIED → fix if <30 min, else record in findings doc as follow-up.
- P3 / RISK-ACCEPTED → document, don't touch.
- Each behavioral fix: test-first where a seam exists (pure helper
  extraction allowed), mutation-tested, gates re-run.
- Surgical changes only — no drive-by refactors of adjacent code.

## 6. Gates & Commit (Phase 6)

1. `cargo test --no-default-features` (app/src-tauri)
2. `npx vitest run` + `npx tsc --noEmit` (app)
3. `git diff --check`
4. Findings doc updated with final verdicts + fix references.
5. Commit(s): one per logical concern; message = WHY.
6. Report to user: findings table (fixed / accepted / follow-up), gate
   results, remaining runtime-QA items.

---

## Execution notes

- Subagents are READ-ONLY (they report, parent verifies + fixes).
- Child timeout: unlimited (`child_timeout=0` known config).
- If a child dies → re-dispatch it, don't skip its angle.
- Findings doc is the single source of truth; chat only summarizes.
