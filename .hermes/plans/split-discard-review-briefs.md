# Split-discard ghost-upload fix — review briefs (fresh-eyes, 2026-09-03)

Diff under review: `%LOCALAPPDATA%/Temp/split-discard-review/full.diff` (+ new test file `SplitDiscardGhostRow.test.tsx` beside it)
Live tree: `D:/DEVELOPMENT/Telegram-Drive` (branch dev, uncommitted)

## Change inventory (what the diff does)

1. `app/src-tauri/src/commands/fs.rs` — `cmd_cancel_transfer`: `mark_part_cancelled` failure now logged best-effort instead of `?`-propagated (ghost-part cancel must not toast "no job found").
2. `app/src-tauri/src/commands/split_upload.rs`:
   - NEW `discard_must_stop_worker(status)` — true for queued/running/interrupted.
   - `cmd_discard_split_job` — reads `status` + all part idxs; row-already-gone + `delete_parts=false` → `Ok(())`; after DELETE it INSERTS stop tokens (`split-cancel:<id>` + `split:<id>:<idx>` for every part) instead of purging, gated on `discard_must_stop_worker`.
   - `run_job_supervised` — after worker finishes, if DB row is gone → `purge_job_cancel_tokens` (bounded memory).
   - `run_job_impl` upload site — `load_folder_id` Err `"job row vanished"` → delete temp, spawn promote, clean exit (was: early `?` return leaking the temp).
   - `run_job_impl` retry-reload — row gone → clean exit (was: Err).
   - NEW Rust test `discard_stops_worker_for_every_non_terminal_status`.
3. `app/src/hooks/useSplitUpload.ts` — module-level `discardedJobIds` tombstone; `removeSplitRow` records it; `upsertSplitRow` drops events for tombstoned ids (ghost-row resurrection kill).
4. NEW vitest `app/src/__tests__/SplitDiscardGhostRow.test.tsx`.

## Controller-seeded suspects (leads to verify or falsify, NOT conclusions)

- **S1** Between-parts cooperative-cancel arm in `run_job_impl` (the `split-cancel:<job_id>` check near the top of the while-loop, ~line 1685 in new file) returns `Err("cancelled")` WITHOUT spawning `promote_queued_jobs` — while every other exit path (upload Err arm, row-vanish exits, run_job skipped) does spawn it. If real: a queued job stalls after a cancel/discard that lands between parts. Check whether the promote chain is broken and whether anything else re-triggers promotion.
- **S2** Discard reads `job_status` BEFORE the DELETE and uses it after — stale-status race (worker finished, row still says running) inserts tokens nobody consumes; supervisor already exited → tokens leak in-memory. Quantify how bounded this is (job_id embeds epoch_secs → no future collision?).
- **S3** `run_job_impl` upload site matches on the exact string `"job row vanished"` from `load_folder_id` — fragile string-coupling between two functions; if the message drifts, silently reverts to the old leaking path. Is there a better contract?
- **S4** Discard's temp sweep (read_dir + delete matching `.<jobid8>.`) races the worker's in-flight ffmpeg split: the temp file is locked by ffmpeg → discard's delete retries 5×400ms then gives up. Verify the worker's later row-vanish exit actually re-deletes that temp (does EVERY worker exit path after a discard delete the current part's temp? trace between-parts exit, backoff exit, upload Err exit).
- **S5** `fs.rs` log line says "(job row gone?)" but `mark_part_cancelled` errors also include "Completed parts cannot be cancelled" and "No such part index" — misleading diagnostics.
- **S6** Row-gone + `delete_parts=true` returns Err("Job not found") — verify this is correct (message ids unrecoverable after row deletion → silent success would LIE about deleting Telegram parts).
- **S7** Frontend tombstone never cleared: verify no path can re-insert a job id that was tombstoned (hydration? new confirm same file? job id uniqueness — `derive_job_id` embeds epoch_secs).
- **S8** `upload-progress` listener path vs tombstone: it early-returns when `splitRows.get(jobId)` is undefined — confirm it can't resurrect (only `applySplitProgress` → `upsertSplitRow` inserts new rows).
- **S9** Supervisor purge condition `current_job_status(...).is_none()` — DB open failure returns None → purge fires on transient DB error while row EXISTS and a future resume could... wait, resume purges anyway. Falsify or confirm harmless.
- **S10** Test binds to shipped exports? Rust test pins `discard_must_stop_worker` directly (shipped fn). Vitest test drives the REAL hook + captured Tauri listeners. Check both tests would catch the original bug (mutation check was run for the vitest one — RED confirmed).

## Angles

- **Angle A — Backend concurrency & lifecycle** (split_upload.rs): token lifecycle insert/purge/consume across all owners; worker exit paths vs promote chain; DB row-vanish races; temp-file cleanup on every exit; supervisor semantics.
- **Angle B — Backend contracts & error semantics** (fs.rs + cmd_discard_split_job): error-contract changes visible to the frontend; delete_parts correctness; log messages; partial-failure behavior.
- **Angle C — Frontend state & test quality** (useSplitUpload.ts + new test): tombstone lifecycle, listener paths, hydration interaction, StrictMode, test adequacy + mutation-worthiness.

## Findings ledger

(controller fills on absorption)

## Controller pre-absorption findings (2026-09-03, before reviewer return)

- **C1 (Required, controller-verified):** S1 CONFIRMED. split_upload.rs:1702-1711 — between-parts cooperative-cancel arm returns Err("cancelled") WITHOUT spawning promote_queued_jobs. Every other exit path spawns it. Pre-existing bug, but the discard fix (stop tokens now INSERTed instead of purged) routes discards of between-parts workers into this arm → queued jobs stall until an unrelated promotion trigger. Fix candidate: run_job_supervised always spawns promote after worker exit (the ownership boundary; double-promote is safe — PIPELINE_CLAIM_SQL is atomic + 250ms coalescing).
- **S2 falsified as harmless:** stale-status token insert with no worker = bounded inert strings (job id embeds epoch_secs + SipHash → no future collision); no consumer, no functional impact. Consider-level at most.
- **S4 mostly falsified:** every worker exit path after discard re-deletes the current part's temp (upload-site row-vanish exit is the new coverage; between-parts exit has no temp to leak; split Err arm deletes). Residual: split phase doesn't poll cancel tokens — ffmpeg runs to completion (bounded by run_ffmpeg_with_timeout) before the worker notices at the upload site. Delayed stop, not a leak. FYI.
- **S9 falsified:** supervisor purge on DB-open failure (row may exist) is harmless — no worker exists at that point, and resume/retry purge tokens themselves at their own boundaries.
- **S6 verified correct:** row-gone + delete_parts=true → Err is right (message ids unrecoverable from a deleted row; silent Ok would lie about deleting Telegram parts). Frontend modal is single-shot (unmounts on click).
- Static scan of added lines: clean (no secrets/eval/unwrap-in-new-code).

## Late-echo absorption — Angle A (post-review fixes, 2026-09-03 05:3x)

Angle A's full report landed after the fix batch (it had flushed findings at the interrupt).
Cross-checked against the already-shipped fixes:
- S1 (Required, 7 unchained exit paths incl. source-missing/ffmpeg-fail/replan-cap/persist-?): ALREADY covered — my supervisor-tail promote fires for every worker exit, since all pass through run_job_supervised.
- Finding 3 ('preparing' omitted from predicate): ALREADY covered — fail-safe inverted predicate returns true for 'preparing' and all unknowns.
- A1 (consolidate promotion at supervisor): that IS the C1 fix.
- Finding 4 (fs.rs swallow + stray marker): ALREADY narrowed to "Job not found".
- S2(a) TOCTOU (resume/retry flips row to running while discard decides on stale terminal status): NEW — fixed by re-reading status immediately before the token decision (fall back to stale value on read failure; fail-safe predicate covers the gap).
- S9 Nit (current_job_status None-conflation): NEW — documented on the fn.
- A2 Nit (insert_stop_tokens helper extraction), behavioral AppHandle test: accepted-with-rationale (AGENTS.md surgical rule; test needs live harness — noted for a future phase).
Gates after these two fixes: cargo 471/0. Vitest/tsc unchanged since (frontend untouched in this round).
