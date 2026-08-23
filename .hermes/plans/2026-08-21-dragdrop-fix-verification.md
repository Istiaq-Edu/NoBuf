# Deep Verification Review — drag-drop upload defect fixes

**Scope:** branch `fix/dragdrop-upload-defects` vs `dev` (3ef0fb7). Commits reviewed: 69e94a4 (fix set) + f6acc33 (EOL normalize); fixes landed during review: b795c9b (discard wiring) + final review-fixes commit.
**Method:** 5 parallel read-only subagent reviewers (spec re-compliance / Rust backend / frontend / adversarial edge cases / test-quality) + parent cross-validation by execution (rustc roundtrip binary, MDN primary sources, gate runs).

## Parent-executed cross-validations

| # | Claim | Method | Verdict |
|---|-------|--------|---------|
| P1 | delete-guard accepts the exact path string staging returns on Windows | Standalone rustc binary; real `temp_dir()` roundtrip (8.3 shortname present) | **VERIFIED** |
| P2 | tokio::test availability | Cargo.toml:27 `features=["full"]`; no [dev-dependencies] section exists | **VERIFIED** |
| P3 | Discard command was dead code (my own gap) | grep: zero frontend callers, unregistered backend | **FALSIFIED my wiring claim** → fixed in b795c9b |
| P5 | Watchdog vs motionless drag-hold | MDN DragEvent: dragover fires ~50ms when mouse not moving; issue #36689 cross-browser data confirms Chrome-family | **VERIFIED** (static) + WebView2 hand-test advisory |

## Reviewer verdicts (consolidated)

| Area | Verdicts |
|------|----------|
| Spec re-compliance | **8/8 claims VERIFIED**; found cancelAll pending-strip leak (fixed), legacy-store one-relaunch self-heal (accepted), picker oversized toast w/o names (cosmetic, out of §3.3 scope) |
| Rust backend | chunk ordering safe (sequential await ⇒ strict IPC order); guard round-trip component-wise equal, no verbatim prefixes from GetTempPathW; no new panics. **P1 falsified:** single-instance closure empty + registered 9th (docs require focus-in-callback + FIRST) → **fixed** |
| Frontend | persist/dangling-path SAFE (terminal statuses never persisted); timer-throttling hypothesis FALSIFIED (clamp hits only hidden pages — wrong direction to harm an active drag); Esc co-fire complementary not conflicting; dedupe fails OPEN (duplicate allowed, never lost); bytesToBase64 exact. Found cancelled-retry dead-end → **fixed** (temp kept on cancel) |
| Adversarial edge cases | #1 error→retry FIXED; #7 watchdog spec-backed (HTML DnD processing model pumps dragover regardless of movement); hostile displayName safe end-to-end (`"` illegal on NTFS → graceful per-file toast; Telegram name = TL UTF-8 string, no injection context); same-name-diff-folder distinct paths |
| Test quality | vi.mock interception VERIFIED (hoisting + matching import path); suite SHIP-WORTHY; gaps closed this round: discard-command Rust roundtrip+guard tests added, `..`/`.` display-name test added |

## Defects found BY the verification round and their fixes

1. **Retry after cancelling a dropped upload always failed** (frontend reviewer): cancel paths deleted the temp the Retry needs → policy changed: temp lives as long as its item is retryable (deleted on success/pending-removal/cancelAll-bulk; kept on error/cancel).
2. **Single-instance callback was a no-op with a lying comment** (Rust reviewer): plugin does NOT auto-focus; closure now unminimizes+focuses "main"; moved to FIRST plugin per docs.
3. **cancelAll leaked staged temps of bulk-cancelled pending items** (spec reviewer): mirror-read cleanup added outside the setState updater (updaters must stay pure).
4. **effective_document_name could return ".."/"." verbatim** (Rust reviewer, rustc-proven): file_name()==None now falls through to source-path basename.
5. **cmd_discard_staged_upload shipped unwired AND unregistered** (parent P3): wired into stageOne catch + registered build.rs/capabilities/lib.rs + behavioral test.
6. **Discard command had zero Rust tests while duplicating staging's derivation** (test auditor): roundtrip + idempotency + empty-id-guard tests added; drift now caught.

## Accepted residuals (documented, not defects)

- Legacy pre-fix store may contain staged items once → one self-healing bad relaunch (errored items never re-persisted).
- Dedupe window during multi-second staging can admit a deliberate rapid double-drop of the SAME file → duplicate upload, never data loss.
- Locked temp at success-cleanup (AV scan) leaks until next sweep — bounded, best-effort by design.
- SidebarItem duplicates Dashboard's isExternal literals — maintainability note for a future shared-constants pass.
- Watchdog runtime cadence in WebView2 needs one hand-test (static analysis says ≥2× margin).

## Post-review hardening (same round)

- Picker oversized toast now names files (spec §3.3 style, ≤3 names + "+N more") — was listed as cosmetic residual, fixed instead.
- Mutation battery v2 on the round's own fixes: **4/4 killed RED** (cancelAll cleanup removal, dot-dot pass-through revert, discard derivation drift, single-instance focus removal), all restores hash-verified byte-identical.

## Final gates (post-fixes)

cargo test **374/374** · cargo build clean · tsc --noEmit clean · vitest **1099/1099** (92 files)

---

# Addendum (2026-08-23): stream-direct uploads — the staging era ends

Follow-on arc on the same branch: dropped files now upload DIRECTLY to
Telegram via `POST /upload-drop` on the local actix server (:14201),
pumping raw webview bytes into grammers' `upload_stream`. No %TEMP%
copy, no preparing phase. The staging path from this document is retained
solely as an automatic fallback when the availability probe fails.

## Architecture

- Frontend `useDropStreamUpload.ts`: validate → dedupe (folderId::name,
  pre-XHR) → two-step probe (HEAD / liveness + HEAD /upload-drop route,
  cross-checked against cmd_get_stream_info().alive) → sequential FIFO gate
  (MAX_PARALLEL_DROPS=1, matching picker/zip) → XHR POST of the File with
  session token in query.
- Backend `upload_drop.rs`: token auth → bandwidth gate → 250ms progress
  events → BodyReader (AsyncRead over actix Payload, bounded ≤3MB steady
  state per upload) → integrity gate (consumed != size refuses to send) →
  add_up(consumed) on EVERY terminal path → resolve_peer + send_message.

## Root cause found late (worth remembering)

actix-web matches a HEAD request ONLY against GET routes. A POST-only
resource answers HEAD with **404, not 405**. Every availability probe used
HEAD against the POST-only route and reported "missing" while the route was
live. Diagnosed via a PID-stamped /__whoami GET endpoint proving same-
process 200/GET vs 404/HEAD. Fix: method-agnostic registration (web::to)
with POST enforced inside the handler; probes now truthful for any verb.

## Defects fixed in this arc (all confirmed, most mutation-proven)

1. Retry dead for failed drops (forgetLiveDrop ran on all terminal states).
2. Cancel All leaked drop XHRs; completed rows resurrected to success.
3. Dedupe TOCTOU: skipped duplicates still started invisible XHRs.
4. Probe accepted 404 as healthy; old-binary sessions stuck failing.
5. Bandwidth counted only full successes (consumed bytes now always).
6. Truncated-send window (grammers tolerates short final part) — gated.
7. Double-retry race duplicating Telegram documents.
8. Queued-cancel resurrection through the FIFO gate.
9. Plain-text server errors swallowed by JSON.parse fallback.
10. Sequential queue adopted after live evidence that parallel drops
    cascade os-error-10053 across transfers on cancel.

## Accepted residuals

- Bandwidth can_transfer is check-then-act: N near-simultaneous drops can
  overshoot the daily cap by in-flight sizes (low vs 250GB cap).
- Token travels in query string (proportionate; Authorization header is
  cheap follow-up hardening).
- /__whoami and [drop] probe logging are permanent diagnostics, kept.

## Final gates (end of arc)

cargo test **378/378** · cargo build clean (0 warnings) · tsc clean ·
vitest **1128/1128** (95 files) · tree clean at c82dca1.

## Final-sweep addendum (4-reviewer panel, pre-merge)

SHIP verdict, zero release blockers. Key confirmations: integrity gate
cannot false-positive (grammers flush-chain proof); no actix body-limit
blocker (streamed Payload bypasses extractor defaults; MAX_DROP_BYTES is
the ceiling); prod CORS/CSP verified at HEAD; token never logged.

Pre-merge fixes applied from the sweep:
- P1 zombie resurrection (cancel->retry->cancel duplicate pendingDrops
  entry) — fixed in retryDropStream.
- F1 retry-after-send-failure duplicates Telegram docs — handler now
  returns 208-style distinct body "already stored"; frontend marks such
  rows 'sent-unconfirmed' and refuses blind re-upload.

Known unguarded (documented, post-merge): integrity gate + bandwidth
accounting need a grammers seam; staging-fallback trigger; FIFO order by
name. The attempted actix route-presence test remains blocked by the
lib-test-binary load failure (STATUS_ENTRYPOINT_NOT_FOUND when actix_test
links into app_lib tests — reproducible, cause unresolved); runtime
REGISTERED logging + frontend probe remain the guards.
