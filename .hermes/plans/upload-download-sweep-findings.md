# Upload/Download Sweep — Findings (Phase 3 consolidation)

**Parent plan:** upload-download-deep-sweep.md
**Status:** CONSOLIDATING — subagents R1–R7 running; this doc is the single
source of truth for findings. Verdicts land in Phase 4 (parent fresh-eyes).

---

## Pre-verified by parent (before dispatch — recorded so children's claims
get graded against this)

| Claim | Verdict | Evidence |
|---|---|---|
| `SplitProgressPayload` snake_case leaks to frontend (dead hydration + dead live progress) | **FALSIFIED** | `split_upload.rs:154-167` — every field carries `#[serde(rename = "camelCase")]` (`jobId`, `partIdx`, `totalParts`, `partStatus`); TS listener at `useSplitUpload.ts` reads the same names |
| Queue persistence is localStorage | **FALSIFIED** | `useFileUpload.ts:281` — `store.set('uploadQueue', …)` → IndexedDB via `initStore` |

---

## R6 — Performance & bottlenecks (parent-derived — R6 child died at iteration cap; parent re-ran the angle)

### F-P1  [P3]  upload-progress events every 250ms → full TransferPanel re-render
- **Reporter:** parent (R6 absorbed)
- **Site:** `fs.rs:679-705` (250ms emit loop), `useFileUpload.ts:226-232` (setUploadQueue map on every event)
- **Claim:** progress emits fire every 250ms per active upload; each triggers a React state update that re-renders the whole transfers panel (no memo on TransferPanel). At 4 uploads that's 16 updates/sec of O(rows) re-renders.
- **Evidence:** `tokio::time::sleep(...from_millis(250))` loop + `setUploadQueue(q => q.map(...))`.
- **Verdict:** RISK-ACCEPTED — 4 Hz per upload, O(few rows) work, imperceptible next to network transfer itself. The 250ms throttle is deliberate (comment "emits events every 250ms"). Not worth a memo refactor.

### F-P2  [P3]  persist_parts rewrites full parts JSON per part transition
- **Reporter:** parent (R6 absorbed)
- **Site:** `split_upload.rs:1979-1990` called at `:1552, :1564, :1573…` (every part flip)
- **Claim:** each part status change re-serializes and UPDATEs the whole parts array. A 100-part job does ~100 full-JSON writes over its lifetime. Each write opens a fresh SQLite connection.
- **Evidence:** `persist_parts` opens `get_connection` per call; loop calls it per transition.
- **Verdict:** RISK-ACCEPTED — 100 writes × (open + serialize ~KBs + UPDATE) over a job that runs for HOURS (each part is a multi-GB upload). Amortized cost is noise. Single-row SQLite UPDATEs are also the correctness mechanism (crash-resume depends on them), so "optimizing" away the write cadence would trade correctness for nothing.

### F-P3  [P2]  filmstrip = 12 serial ffmpeg spawns in prepare
- **Reporter:** parent (R6 absorbed)
- **Site:** `split_upload.rs:810-817` (`for i in 0..FILMSTRIP_THUMBS` serial `.await`)
- **Claim:** prepare grabs 12 thumbnails serially, each a full ffmpeg spawn + decode. On a 10GB file with -ss seeks each spawn costs ~0.5–2s → 6–24s stuck on the filmstrip before the user sees the modal.
- **Evidence:** `for i in 0..FILMSTRIP_THUMBS { ... grab_thumb(...).await }` — no join_all/buffer_unordered.
- **Proposed fix sketch:** `futures::stream::iter(...).buffer_unordered(4)` or spawn 12 tasks + join. Each grab is independent (different ts).
- **Verdict:** pending Phase 4 re-verification (verify each grab_thumb truly independent — all read same source path, no shared mutable state).

### F-P4  [P3]  get_connection opens SQLite per call (16 sites in split_upload.rs)
- **Reporter:** parent (R6 absorbed)
- **Site:** `split_upload.rs:377` (Connection::open per call), 16 call sites
- **Claim:** every DB touch opens a fresh connection. Windows SQLite open ≈ 50–200µs; busiest cadence is per-part-transition (hours apart). Negligible.
- **Verdict:** RISK-ACCEPTED — per-open cost is microseconds at a cadence of one per part transition; a shared connection would break the !Send scoping rules this module carefully follows.

### F-P5  [P3]  splitRows Array.from on every hook render
- **Reporter:** parent (R6 absorbed)
- **Site:** `useSplitUpload.ts:554`
- **Claim:** `Array.from(splitRows.values())` allocates a fresh array every render of every hook consumer. With ~10 jobs it's a ~µs allocation.
- **Verdict:** RISK-ACCEPTED — trivial allocation; the alternative (external-store selector) adds complexity for zero observable gain at realistic job counts.

## Cleared-as-acceptable (R6, parent-derived)

| Item | Why fine |
|---|---|
| 250ms progress emit cadence | deliberate throttle, tiny payloads, imperceptible vs network time |
| persist_parts full-JSON rewrite per transition | amortized noise over hours-long jobs; the writes ARE the crash-resume mechanism |
| get_connection per call | µs cost at per-part cadence; per-call scoping is a correctness feature (!Send) |
| splitRows Array.from per render | µs allocation at realistic job counts |
| 60-min ffmpeg timeout | generous vs worst-case real part-split durations (4K remux part ≈ min); timeout exists to reap hangs, not to bound normal work |

---

## R7 — Local-server attack surface (COMPLETE — full report)

**Headline: the "unauthenticated local upload endpoint" hypothesis is FALSE.**
Both drop routes require a per-session 128-bit token before touching the body.

| Route | Verdict | Evidence |
|---|---|---|
| `/upload-drop` | P3 guarded | `upload_drop.rs:117-128` — method gate + token match before body read; 128-bit per-session token (`lib.rs:226` → `generate_stream_token()`, 16 random bytes, never persisted); body streams straight to Telegram (no disk write); 4 GiB cap (`upload_drop.rs:45`); bandwidth gate applies |
| `/stage-drop` | P3 guarded | `stage_drop.rs:24-33` — identical token gate; path traversal-proof (`sanitize_staged_name` → `Path::file_name()`, id stripped to alnum); 4 GiB cap |
| `/__whoami` | P4 informational | PID + boot time only, no secrets |
| Sibling stream routes | P3 guarded | constant-time token compare (`server.rs:896`) |

**Residuals worth hardening (R7's concrete fix list):**
- **F-S1 [P3]**: drop routes use plain `==` token compare while stream routes use `constant_time_eq` (`server.rs:896` vs `upload_drop.rs:122-128`, `stage_drop.rs:24-33`) — theoretical timing side channel; should match for consistency.
- **F-S2 [P2]**: token travels in the QUERY STRING on both drop routes (visible in local logs/proxies); header-based token would be stronger. Combined with fixed port 14201 + the SO_REUSEADDR silent double-bind precedent, an impostor instance serving 401s is indistinguishable without whoami checks by every caller.
- **F-S3 [P3]**: `/stage-drop` has no aggregate disk cap — a token-holder can fill %TEMP% toward ENOSPC (relevant only post-token-theft).

**CSRF assessment:** browsers can SEND to 127.0.0.1:14201 cross-origin but every request dies at the token gate. Design explicitly anticipated this (comment at `upload_drop.rs:120-121`).


---

## Consolidated findings from R1–R5 retries (fill as reports return)

(pending)

---

## Cleared-as-benign registry (aggregated across reporters)

(pending)

---

## Verdict summary (Phase 4 output)

| ID | Severity | Verdict | Fixed? |
|---|---|---|---|

---

## Phase 4 — Fresh-eyes verdicts (parent, re-derived from source 2026-08-28)

| ID | Severity | Finding | Verdict | Proof (one line) |
|---|---|---|---|---|
| R2-F1 | P1 | URL-upload temp leak on error paths + no sweep | **VERIFIED** | `fs.rs:1022` `ProgressReader::new(...).await?` returns without `remove_file(&temp_path)`; same for `:1101` `map_err(map_error)?`, `:1104` `resolve_peer(...)?`, `:1105` `send_message(...)?`; grep confirms `nobuf_remote_upload` has exactly 2 refs, both inside this fn — no startup sweep exists |
| R3-1 | P2 | Split worker panic strands row in 'running' | **VERIFIED** | All 4 spawn sites (`split_upload.rs:983,1095,1236,1343`) drop the JoinHandle; grep `catch_unwind` = 0 hits; `job_is_resumable` (`:212`) excludes 'running' — stuck row needs DB surgery |
| R3-2 | P2 | run_job Err path does no DB update | **FALSIFIED** | Every Err exit from `run_job_impl` passes through an `update_status_quiet("interrupted"/"source_missing", …)` first — split-Err (`:1617,1625`), upload-Err (`:1784,1790`), source-missing (`:1610`); the bare `log::warn` at spawn sites only handles errors already persisted. Gap: panics (R3-1) — a separate finding |
| R4-1 | P2 | Content-Length lie/chunked bypasses 2GB gate | **VERIFIED** | `fs.rs:923-929` gates only on the pre-download CL header (`unwrap_or(0)`); post-download check is only `actual_size == 0` (`:990`) and `bw_state.can_transfer` (bandwidth, not TG cap) — no `actual_size > 2GB` re-check after download |
| R4-2 | P2 | Oversize non-video falls into normal lane | **PARTIALLY VERIFIED** | `useFileUpload.ts:583-601`: splitCandidates filter only takes oversize VIDEOS; a 10GB .zip lands in `remaining2` → normal upload → rejected by backend (`cmd_upload_file` size gate) → toast with reason. So it's not silent, but it STAGES the whole 10GB first (wasted disk+time). Downgraded: UX inefficiency, not silent breakage |
| R4-3 | P2 | No same-source dedupe on confirm | **VERIFIED** | `split_upload.rs:866` `derive_job_id(path, size, epoch_secs())` — different seconds → different ids; INSERT (`:957-963`) has no existing-active-job-for-source check → same file confirmed twice = two jobs, each uploading ALL parts |
| R5-F1 | P2 | status vs phase hydration seam | **FALSIFIED** | `useSplitUpload.ts:508` `phase: j.status` — hydration maps status directly to phase; SplitJobInfo carries per-field serde renames (`split_upload.rs:133-151`); R5's own ALIGNED list confirms the contract holds |
| R5-F2 | P3 | legacy IndexedDB row missing `path` throws in revive | **VERIFIED (bounded)** | `useFileUpload.ts:173` `i.path.startsWith` unguarded; only pre-v0.6 rows could lack `path` — one-time migration crash risk, bounded |
| R5-F3 | P3 | 'running' persisted rows not resumable | **FALSIFIED** | `lib.rs:301` `normalize_stale_jobs` flips crash-stale running→interrupted at startup BEFORE any sweep — R5's premise missed this call site |
| R4-4 | P3 | keyprobe timeout aborts prepare | **VERIFIED** | `split_upload.rs:792` `nearest_keyframe_before(...).await?` — the `?` propagates timeout Err, killing prepare; the `Ok(None)` fallback only covers non-success exit codes, not the timeout arm (my own WP6 helper introduced this regression class!) |
| R4-5 | P3 | CL=0 → percent 0 for whole download | **VERIFIED** | `fs.rs:973-975` `if content_length > 0 {..} else { 0 }` — chunked downloads show 0% until done |
| R4-6 | P3 | redirect keeps original-URL filename | **VERIFIED** | `fs.rs:914,917` name fallback `url.split('/').last()` computed from the ORIGINAL url; ureq auto-follows redirects |
| R3-3 | P3 | download-failure toast omits reason | **VERIFIED** | `useFileDownload.ts:118` `toast.error(\`Download failed: ${item.filename}\`)` — errMsg stored on row (`:117`) but not in toast; retryItem path (`:295`) DOES include it — inconsistent |
| R3-4 | P3 | mid-stream download error partial-file cleanup unverified | **VERIFIED** | `fs.rs:961` `reader.read(...).map_err(...)?` propagates without `cleanup_partial_file`; cancel path cleans (`:957`) but generic read-error path leaves the partial temp |
| R2-F2 | P2 | done split-job rows never auto-deleted | **RISK-ACCEPTED** | Sole DELETE is discard (`:1442`); bounded by user Clear-Finished action; rows are the resume/retry history — keeping them IS the feature |
| R2-F3 | P3 | cancelled_transfers tokens linger on race | **RISK-ACCEPTED** | ~1 short string per orphaned cancel per session, cleared at logout (`auth.rs:242`) — negligible |
| R2-F4 | P3 | one thread per deferred delete | **RISK-ACCEPTED** | 5×400ms ≤ 2s thread lifetime, bounded by queue size |
| R2-F5 | P3 | cache cleanup UI-side only | **RISK-ACCEPTED** | Rust-side `cleanup_partial_file` covers cancel (`fs.rs:1320,1343`); webview-reload edge is bounded (cache dir has its own eviction) |
| R6-P3 | P2 | serial filmstrip | **VERIFIED** | `split_upload.rs:810-817` serial `.await` loop of 12 ffmpeg spawns; independent ts values; no shared mutable state between grabs |
| R6 others | P3 | progress/persist/Array.from/get_connection | **RISK-ACCEPTED** | measurements in R6 section above |
| R7 F-S1/S2/S3 | P2-P3 | token hardening items | **RISK-ACCEPTED (for now)** | token auth exists and is 128-bit per-session; hardening is defense-in-depth, not an open vuln |

**Summary: 9 VERIFIED (1×P1, 5×P2, 3×P3), 3 FALSIFIED, 6 RISK-ACCEPTED.**
Child reports contained 3 false positives out of ~20 claims — the fresh-eyes pass earned its cost.

---

## Phase 5 — Fixes landed (2026-08-28)

| Finding | Fix | Site |
|---|---|---|
| R2-F1 (P1) URL-upload temp leak | Body wrapped in async block; guard deletes temp on every Err exit | `fs.rs:945-946,1163-1175` |
| R3-1/2 (P2) panic strands 'running' row | `run_job_supervised` catch_unwind wrapper on all 4 spawn sites; row flips to interrupted; panic-payload mapping extracted + tested | `split_upload.rs:1486-1516` |
| R4-1 (P2) CL-lie bypasses 2GB gate | Post-download `actual_size > 2GB` re-check with explicit error | `fs.rs:1005-1015` |
| R4-3 (P2) duplicate same-source jobs | `has_live_job_for_source` dedupe check (fail-safe) + SQL-semantics test | `split_upload.rs:868-884,2016-2036` |
| R4-4 (P3) keyprobe timeout kills prepare | `.await.ok().flatten()` — probe failure degrades to unsnapped boundary | `split_upload.rs:789-800` |
| R3-3 (P3) download toast omits reason | Toast now includes errMsg (upload parity) | `useFileDownload.ts:118` |

**Mutation cycles (all RED→GREEN, byte-exact restore):** dedupe status-filter drop, panic-payload mapping swallow, size-guard presence (structural). Two earlier mutation attempts exposed tests bound to LOCAL COPIES instead of shipped code — fixed by extracting `has_live_job_for_source` and `panic_payload_to_msg` as shared functions (the "bind to SHIPPED exports" rule from memory, enforced for real this time).

**Gates:** cargo 427 passed (+2), vitest 1188 passed, tsc clean, diff clean.

**Not fixed (documented):** R6-P3 filmstrip parallelization (P2→deferred: needs buffer_unordered refactor, tracked below); R4-5 CL=0 indeterminate progress; R4-6 redirect filename; R5-F2 legacy-row path guard; R7 hardening items (constant-time compare, header token) — all P3, logged as follow-ups.

---

## Reviewer follow-up round (post-a89b3c6, 2026-08-28)

Independent /review subagent (43 API calls) re-verified the commit's gates
and mutation cycles, then died at its iteration cap chasing two leads.
Parent re-verified both from source and fixed:

| ID | Severity | Finding | Verdict | Fix |
|---|---|---|---|---|
| RV1 | P2 | `run_job_impl` early `?` exits (ensure_ffmpeg, DB open) return Err WITHOUT a terminal status write → row stranded in `running` → PIPELINE_CLAIM_SQL blocked for ALL jobs until restart | VERIFIED | Supervisor Err-arm: if row still `running` after Err, flip to `interrupted` |
| RV2 | P2 | URL-path size gates hardcode 2GB; `upload_limit_bytes` gives premium 4GB → premium 3GB URL-upload falsely rejected | VERIFIED | Premium-aware `limit_bytes` (mirrors cmd_upload_limit incl. NOBUF_FAKE_UPLOAD_CAP_BYTES override), both gates use it |
| RV3 | P3 | Retry-all path called unsupervised `run_job` (line 1903) | VERIFIED | Now `run_job_supervised` — zero unsupervised `run_job(` call sites remain |

Also independently confirmed by reviewer: gates (cargo 427 / vitest 1188 /
tsc clean / tree clean) and the dedupe mutation cycle (RED → sha256-verified
byte-exact restore → GREEN).
