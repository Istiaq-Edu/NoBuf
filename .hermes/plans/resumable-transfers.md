# Plan sketch: Universal Resumable Transfers (`feature/resumable-transfers`)

Status: DECISIONS LOCKED 2026-08-26 (interview with user); implementation starts
in a FRESH SESSION on its own branch off the merged split-upload work.
Predecessor: `large-video-split-upload.md` (Phases A–E, all shipped by fea2e93).

## Locked product decisions

1. **Scope: uploads AND downloads, all file types** — resume-after-interruption
   generalized from the split-job pattern into one checkpoint store.
2. **Stop semantics (user chose "ask on stop"):** pressing stop/× mid-transfer
   opens a choice — **Keep progress** vs **Delete**. No silent deletion of
   hours of transfer. A separate Discard/Delete always exists for rows that are
   already paused/interrupted.
3. **Sequencing:** close split-upload Phase E → merge → THEN this branch.
   Stacking was rejected (tangled review); skipping Phase E was rejected
   (two competing resume models).

## The three legs (different mechanisms, one UI)

| Leg | Resume mechanism | Open risk |
|---|---|---|
| Downloads (first leg) | Byte-offset resume via grammers `iter_download(offset)`; persist msg-id + offset + partial file path | Low. Biggest everyday win |
| Big single-file uploads (>cap? no — normal uploads) | Part-index resume: `saveBigFilePart` idempotent per part; persist file_id + next-unconfirmed index; resend last part on resume | **SPIKE REQUIRED**: how long Telegram retains orphaned big-file parts between sessions. Do NOT guess a number; measure or find authoritative statement |
| Split jobs | Already persistent (`split_upload_jobs`) | None — becomes a special case of the general store |
| Remote URL downloads | Composite: HTTP Range for fetch phase + download leg after | Low once legs exist |

## Reuse map (what exists to build on)

- `commands/split_upload.rs`: job DB pattern (`nobuf_jobs.db`, sync-scope SQLite),
  queued→promotion runner, size+mtime+duration source validation, orphan-temp sweep
  (`normalize_stale_jobs` at boot), retry-cleanup thread for Windows locks.
- Frontend: `TransferPanel.tsx` row language incl. Resume/Delete actions
  (Phase E), `useSplitUpload.ts` module-store + hydration + startup notice
  pattern (`selectResumableJobs`), Dashboard wiring shape.
- Cancel-tokens: `cancelled_transfers` set (fs.rs) for cooperative cancel.

## Known UX debt this branch should absorb

- Today's plain upload/download Cancel deletes partial work silently — replaced
  by keep-or-delete choice above.
- Native `<video>` fallback tier has no audio switching (separate issue, NOT
  this branch).

## First slices (proposed order)

1. Downloads leg backend: offset persistence + `iter_download(offset)` resume +
   crash-safe partial-file handling (mutation-test the offset math).
2. Stop→choice dialog + Pause state in TransferPanel rows.
3. Uploads leg behind the retention spike (block slice 3 until spike answers).
