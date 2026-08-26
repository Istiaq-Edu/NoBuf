# Plan: Parts-First Uploads — real-time parts, grouped transfer rows, chain removal

Branch: `feature/large-video-split-upload` (extends it) · Status: VALIDATED — deep-review + adversarial cross-validation folded in (F1-F8); pending user approval
Interview basis: 17 locked decisions (2026-08-26, no assumptions). Evidence base: 3 parallel
investigations + independent deep review + adversarial validator (deleg_cc15ed90, deleg_1033cc72).

## 0. Summary

Make every split part a first-class file: parts appear in the folder progressively
(the moment each lands), play standalone from their own 0:00, and are individually
cancel/retry/download/play-able. The Transfers window groups an active job under one
collapsible header (combined % + MB/s) expanding to per-part rows with live progress.
The Phase-D chain model (collapse-into-one-card, joined-movie playback, virtual
timeline, part-k/N badge, gap notices) is DELETED per explicit user decision — parts
render as ordinary separate cards everywhere, including older uploaded chains.

## 1. Locked requirements (interview 2026-08-26)

| # | Decision |
|---|---|
| Q1 | Parts appear in folder PROGRESSIVELY — each the moment its upload lands |
| Q2 | Transfers: ONE collapsible group row per job → expands to per-part rows |
| Q3 | Per-part actions: Cancel, Retry-if-failed, Download to PC, Open/Play |
| Q4 | (superseded by Q12 — see below) |
| Q5 | Playing a part opens ONLY that part from its own 0:00 |
| Q6 | Single-part deletion from Telegram: yes, same as any normal file |
| Q7 | Finished job entry lifecycle identical to normal finished uploads |
| Q8 | Per-part live % + MB/s like normal uploads; group header shows combined |
| Q9 | Downloads side: NO grouping — parts are ordinary files |
| Q10 | Failed part auto-retries a few times before job goes to manual Resume |
| Q11/Q12 | CHAINS KILLED: no collapse, no joined playback, no gap notices. Every part always a separate card, everywhere |
| Q13 | Older uploaded chains flatten into separate cards too (consistent) |
| Q14 | Any action on one part affects ONLY that part; the group is visual |
| Q15 | Job-level Resume SKIPS deliberately-cancelled parts; retries crashed/failed |
| Q16 | Chain machinery is DELETED, not hidden (virtual timeline, collapse, badges, gap UX) |
| Q17 | Collapsed group header shows combined % and MB/s |

Naming convention (`[jobid8-]Stem.partNN.ext`) is UNCHANGED — grouping in Transfers
comes from jobId, never from name parsing.

## 2. Verified evidence base

- Listing owner: react-query `['files', activeFolderId]` → `cmd_get_files` (Dashboard.tsx:363-371); backend reads live messages (fs.rs:1526-1561). Root cause of staleness: NOTHING in the split path invalidates this cache; single uploads do (useFileUpload.ts:269). No documents-changed event exists anywhere.
- Chain collapse = pure frontend transform (utils/splitChain.ts; applied FileExplorer.tsx:236-251). Once docs reach the cache, cards form automatically — no backend listing change needed.
- Per-part byte progress ALREADY EMITTED under tids `split:<jobId>:<idx>` (split_upload.rs:1340→fs.rs:558/585/636) and silently dropped by the frontend (zero consumers; useFileUpload.ts:159 matches QueueItem ids only).
- `SplitProgressPayload` carries no byte counts; persisted part status is only `waiting|done`; `SplitJobInfo` discards the parts array except counts (row_to_info :343-357).
- Per-part Cancel needs NO new backend: `cmd_cancel_transfer(tid)` inserts into `cancelled_transfers` (fs.rs:284-291) — the same mechanism `cmd_cancel_split_job` uses (split_upload.rs:992-999). BUT the run loop currently treats ANY tid cancel as job-cancel → must distinguish (see §3-E2).
- Per-part Retry: no command today (resume is job-level, run loop skips only `done` :1233-1235).
- Solo playback path EXISTS: gap orphans play standalone via Dashboard.tsx:662-669; zero name special-casing downstream (players treat parts as ordinary documents). Known bugs dying with the chain: right-click ▸ Play on a chain card plays part 1 solo by accident (`'ts'` ⊂ "parts" in endsWithAny, utils.ts:17-23); `navigatePreview` leaks stale `playingChain`.
- Chain card has NO expander today; `__chainParts` marker is read nowhere.
- Pre-existing mislabel: `TransferPanel.tsx:159` renders a `'preparing'` phase the backend never emits; `doneParts = partIdx` mapping misreads during `splitting` (partIdx = in-progress index there).

## 3. Design

### A. Real-time progressive listing (seam: emit at upload-success + listener)
- Rust: emit `"documents-changed"` payload `{ folder_id: Option<i64> }` after successful `send_message` in ALL THREE folder-upload pipelines (adversarial F6 falsified the single-point claim): `upload_file_inner` (fs.rs:631/642 — picker singles + split parts), remote-URL pipeline's own send path (~fs.rs:904 region, fully duplicated implementation), browser-drop actix handler (upload_drop.rs:253). Vault-sync JSON writes to the control channel are correctly excluded.
- Frontend: ONE listener → `queryClient.invalidateQueries({ queryKey: ['files'] })`, debounced 300 ms (cmd_get_files re-paginates the whole peer per fetch; bursts of parts coalesce). Prefix-key invalidation is correct for react-query v5: `['files']` matches all parametrized children (`['files', folderId]`); default refetchType 'active' refetches only the mounted Dashboard query (:363-371) and merely marks inactive ones stale. Payload folder_id currently unused — kept for future targeted invalidation.
- Placement: hook-level via `useQueryClient` inside an existing always-mounted component (Dashboard), mirroring useFileUpload.ts's pattern (:144/:236).
- Acceptance: part visible in folder ≤ ~1 s after its upload resolves, without focus change or restart.

### B. Chain removal (deletion, per Q16)
- Deletion surface VERIFIED by direct grep (deep-review pass): exactly 5 files reference chain machinery — `Dashboard.tsx` (state :305/:308, intercept :640-669, props :1008-1010), `FileExplorer.tsx` (collapse at :236-251, virtualizer integration), `MediaPlayer.tsx` (chain/startAtT props, globalTimeToDoc import, partIdx/chainFile/displayFile logic :26-85), `FastStreamPlayer.tsx` (onPartEnded/initialSeekS/chainInfo props :281-290, tail-stall watchdog :1092-1119, seam seek :1291-1295, ended-handoff :1401-1408, badge :3839-3841), `utils/splitChain.ts` + its test.
- Delete: all of the above chain-only code. MediaPlayer/FastStreamPlayer keep their non-chain signatures (`file`, `onNext/onPrev`, etc.) — strip optional chain props.
- KEEP: double-nested naming (slice 6), SplitUploadModal, split backend, queue plumbing. Tail-stall watchdog (FastStreamPlayer.tsx:1092-1119): DELETE — its only trigger is `if (!chainInfo) return` (:1098), zero standalone value (deep-review A3 + adversarial F7 agree).
- Deletion prop inventory (adversarial F8, complete): FastStreamPlayer loses `onPartEnded`/`initialSeekS`/`chainInfo` props (:281-290, :389), `chainEndedFiredRef` (:398, :1101, :1404-1407), chain initialSeek branch (:1291-1296), chain ended branch (:1401-1410), badge (:3839-3841); MediaPlayer loses `splitChain` import (:5), `chain`/`startAtT` props (:25-31), chain block (:40-90); Dashboard loses state (:305/:308), intercept (:639-669), props (:1008-1009), onClose reset; plus utils/splitChain.ts and __tests__/splitChain.test.ts (the only chain test file).
- Result: every part renders as an ordinary card; clicking plays solo (the former Dashboard.tsx:662-669 branch becomes the only path). Old chains flatten automatically (no transform). Right-click Play anomaly and navigatePreview leak die with the state they depend on.

### C. Transfers group UI (data plumbing first)
Backend:
- `JobPartState` gains `size_bytes: u64` (stat'd when the orchestrator already stats the temp for the cap check; persisted via parts_json — JSON field add, no migration).
- `SplitJobInfo` gains `parts: Vec<PartInfo{ idx, name, status, messageId, sizeBytes }>` (hydration seam; row_to_info stops discarding).
- `SplitProgressPayload` gains `part_status: Option<String>` so per-part terminal flips (done/cancelled/failed) ride the existing event.
Frontend store (useSplitUpload rework):
- Store shape: `Map<jobId, { header…, parts: Map<idx, { name, status, pct, speedBps }> }>`.
- NEW `upload-progress` consumer: ids matching /^split:(.+):(\d+)$/ patch that part's pct/speed (mirror of useFileUpload.ts:159). Terminal byte state still comes from `split-progress` (error/cancel emit no terminal upload-progress — investigator-verified caveat).
- `split-progress` consumer: updates part statuses via `part_status`/phase; fixes the `doneParts` misread (use completed-count from parts map, not partIdx, during splitting).
UI (TransferPanel):
- Group row: chevron, name, combined % bar (Σ done bytes / Σ sizes; unknown sizes fall back to done-parts ratio), aggregated MB/s, "k/N done", job-level Cancel/Resume/Discard unchanged.
- Part rows: status word + own % + MB/s while active; actions gated by status — uploading→Cancel(part); failed→Retry; done→Play + Download; cancelled→Re-include (Retry); waiting→none.
- Remove the phantom `'preparing'` label or wire it for real (choose: remove; backend never emits it).
- Virtualization: TransferPanel lists are PLAIN `.map()` renders (TransferPanel.tsx:154/242/276 — no virtualizer), so expanded part rows are just more mapped rows; no height constraints. Contrast: FileExplorer IS virtualized (@tanstack/react-virtual :274/:287) — but chain removal means no synthetic rows are spliced there at all.

### D. Per-part actions
- **Cancel(part)**: invoke existing `cmd_cancel_transfer("split:<job>:<idx>")` — no new backend for the trigger; run-loop semantics change required (§E2).
- **Play(part)** — CORRECTED MECHANISM (deep-review A1): do NOT construct stream URLs. Render `<MediaPlayer file={{ id: messageId, name, size } as TelegramFile} activeFolderId={jobFolderId} …/>` directly. MediaPlayer already self-serves everything: it fetches `cmd_get_stream_info()` (baseUrl+token, port-agnostic per lib.rs:30) and builds `/stream/{folderId}/{messageId}` itself (MediaPlayer.tsx:35, :59-60). Duration unknown for transfers-opened parts — optional field. Hidden until `messageId` exists.
- **Download(part)**: existing `queueDownload(messageId, name, folderId)` (useFileDownload.ts:128) — hidden until done.
- **Delete(part)**: ordinary file deletion on the folder card (already works for any doc; nothing new). Not offered in Transfers rows (folder is the deletion surface) — keeps Q6 satisfied without duplicating destructive flows.
- **Retry(part)**: new `cmd_retry_split_part(job_id, idx)`: validates job is `interrupted`; flips that part `waiting` (and any `failed` siblings? NO — only the requested one); sets job `running` and spawns `run_job`, which now skips `done` AND `cancelled` parts (skip-set change) — so retry naturally continues remaining eligible parts too, consistent with Resume semantics.

### E. Orchestrator semantic changes
1. **Skip-set**: run loop skips `done` + `cancelled` (was `done` only). Job reaches `done` when no eligible parts remain; if ≥1 part was user-cancelled, `error` field records "skipped N cancelled parts" (informational, job still `done`).
2. **Per-part cancel ≠ job cancel — REDESIGNED per adversarial F1**: `upload_file_inner` currently CONSUMES the tid (`cancelled_transfers.remove`) before returning "Transfer cancelled" (fs.rs:601-606, :615-620), so the orchestrator can never observe a part-cancel. Fix: for `split:`-prefixed tids ONLY, skip the `remove()` (leave the evidence); the orchestrator's Err branch then classifies: `tid ∈ set AND split-cancel:<job> ∉ set` → part CANCELLED (orchestrator removes the tid itself, marks part, emits part_status, continues) · otherwise genuine failure / job-cancel (current interrupt path byte-identical). Companion lifecycle steps (F1a/F1b): `cmd_retry_split_part` and resume REMOVE stale part-tids for parts they re-attempt and PURGE any stale `split-cancel:<job>` token before spawning run_job — without this, retried parts insta-cancel forever (masked today by the consumption bug).
   ⚠️ Known latency (documented, not fixed here): cancellation is checked pre-start and post-upload; the upload task itself is joined, not aborted (fs.rs:608-613) — cancelling a mid-flight part lets its remaining bytes upload first. Same behavior as today's job-cancel.
3. **Auto-retry**: up to `SPLIT_PART_MAX_ATTEMPTS=3` attempts, backoff 2 s / 8 s / 30 s (const, test-pinned budget = 40 s max per part). Genuine failures only — user-cancel exits the loop immediately. Exhausted → part `failed`, job `interrupted`. Backoff sleeps are cancellation-aware: sliced into 500 ms chunks checking the part tid AND job token between slices (adversarial F5: bare sleeps would ignore cancels for up to 30 s; verified cancel-poll points exist only at fs.rs:601/:615 and split_upload.rs:1237-1247).
4. **Resume**: eligibility = `waiting|failed` (cancelled skipped per Q15); entry purges stale `split-cancel:<job>` + stale part tids for eligible parts (F3: token persistence would otherwise re-interrupt the resumed job instantly — VERIFIED latent bug on the current branch: `split-cancel:` has zero removal sites).
5. **Retry admission (adversarial F4)**: `cmd_retry_split_part` reuses resume's single-pipeline admission block verbatim (has_active_split_job check → self-`queued` + promote via promotion runner, pattern at split_upload.rs:1068-1079) — the naive "spawn run_job directly" would run two concurrent pipelines (run_job_impl rejects only still-queued rows, :1177-1195).

### F. Edge cases (each → test)
| # | Case | Behavior / test |
|---|---|---|
| 1 | Restart mid-job | Hydration rebuilds part rows from extended parts_json incl. sizes; live % only for the actively-uploading part. Vitest on store rebuild. |
| 2 | Cancel part while it is SPLITTING (pre-upload) | Cancel lands at the next checkpoint (upload start) — documented; killing ffmpeg mid-split is out of scope. Integration assert. |
| 3 | ALL parts user-cancelled → run loop finds zero eligible | Job → `done` with "skipped N cancelled" note. Unit test on completion predicate. |
| 4 | Retry on a fully-done job | Command rejects ("nothing to retry"). Guard test. |
| 5 | Parts land <300 ms apart | Debounce coalesces to one refetch. Timer test. |
| 6 | Vault-hidden / public-channel folders | Invalidation by `['files']` prefix marks stale + refetches only the mounted query; vault gating unchanged (enabled flag). Existing suite green. |
| 7 | Old double-nested chain names | Render as plain cards (raw name shown). Snapshot/manual QA. |
| 8 | Crash between send_message success and parts_json persist | Tiny known window → duplicate upload on resume. Documented limitation, order already optimal (persist immediately after upload). |
| 9 | Discard job whose parts are in the folder | Parts remain (real docs) — copy already corrected in f5b7f97. Manual QA. |
| 10 | Play part from Transfers with messageId=null (not yet uploaded) | Action hidden (status gate). Component test. |
| 11 | Combined % with unknown sizes | Fallback to done-parts fraction. Pure fn + test. |
| 12 | Retry burst vs single-pipeline rule | `cmd_retry_split_part` reuses resume's admission block (queued + promotion). Test. (F4) |
| 13 | Part-cancel mid-upload | upload_file_inner skips tid-removal for `split:` tids; orchestrator classifies cancelled vs failure; siblings continue. Integration test. (F1) |
| 14 | Resume AFTER job-level cancel (stale tokens) | Resume purges `split-cancel:<job>` + part tids before spawn; job completes remaining parts. Integration test — pins the F3 latent bug fix. |
| 15 | Cancel lands during auto-retry backoff sleep | 500 ms-sliced sleep observes it ≤500 ms; part classified per E2, no ghost retry attempt. Timer-driven unit test. (F5) |
| 16 | Remote-URL / browser-drop upload completes | documents-changed fires from their own send paths; folder refreshes without restart. Manual QA per pipeline. (F6) |

## 4. Phases & acceptance criteria

**Phase A — backend truth & events** (cargo-tested)
sizes persisted · `SplitJobInfo.parts` · `part_status` in payload · skip-set + per-part-cancel semantics · auto-retry · `cmd_retry_split_part` · documents-changed emit.
✅ unit tests: skip-set truth table, retry budget const, completion predicate, retry-command guards; integration: cancel part 2 of 3 mid-upload → job continues → parts 1,3 done, 2 cancelled, job done-with-note.

**Phase B — Transfers group UI** (vitest)
store rework + two listeners + group/part rows + actions wiring + hydration rebuild.
✅ component tests: expand/collapse render, per-status action gating, combined-% fallback, upload-progress tid routing, hydration rebuild; mutation-test the tid regex.

**Phase C — chain removal + solo playback** (vitest + manual)
delete collapse/intercept/timeline/badge/gap code + their tests; solo becomes the only path.
✅ tsc proves no dangling refs; targeted tests: handlePreview routes EVERY media doc to solo; manual QA: play part 1/2/3 of a fresh job + an OLD chain, seek/subtitle/audio-switch sanity on a part.

**Phase D — progressive listing** (e2e)
listener + debounce.
✅ live e2e over CDP (fake-cap rig from qa-phaseE): part k appears in folder ≤ ~2 s after upload resolves, without focus/restart; burst coalescing observed once.

**Phase E — gates + QA report**
`tsc --noEmit` · `vitest run` · `cargo test --no-default-features` · mutation checks on new decision points · qa-results report update.

## 5. Out of scope

Downloads-side grouping (Q9: none) · renaming/re-splitting parts · remote bulk-delete of a whole chain (single-file delete suffices per Q6) · killing ffmpeg mid-split · cross-device anything.

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Chain removal touches Dashboard/FastStreamPlayer hot paths | Medium | Deletion is mostly subtractive; targeted preview-routing tests + manual player QA matrix |
| Invalidations could loop (event → refetch → …) | Low | Listener is passive; react-query dedupes; no fetch-side emits |
| parts_json shape growth breaks old rows | Low | serde defaults for missing `sizeBytes`/new statuses; JSON column, no migration |
| Per-part continue-on-cancel masks real failures | Medium | Distinguish STRICTLY on job-token absence; job-level cancel path byte-identical to today; integration test #A |
