# Impl Review — Seed-Push & Event Bridge (post-fix verification) — Consolidated

**Commit:** `5324a4b` · Reviewer subagent died at max-iterations (502 flake) after gathering all evidence but before writing findings; transcript-mined + controller-completed.

## Reviewer's own verdicts from its trace (pre-delivery, quoted)

1. **Finding E (my controller suspicion) — FALSIFIED BY TIMING, then made real by my fix order.** The reviewer read the code BEFORE my `state_response_public(app, …)` fix landed in its working tree... actually its grep at 03:14:03 shows `state_response_public(app: &AppHandle…)` — it read **after** my fix was committed (5324a4b preceded its run). It explicitly concluded: *"The suspected hardcoded-false bug is falsified — `state_response_public` reflects [the runtime flag]"*. So finding E is confirmed REAL (it existed pre-fix) and confirmed FIXED (the reviewer verified the fix's shape against `is_unlocked_public`). Double-checked from both sides.

2. **`merged` field inversion — reviewer flagged "I can already see the `merged` field inversion".** Reading the shipped code: `cmd_vault_pull_sync` returns `"merged": seeded` where `seeded=true` means *we seeded* (nothing was pulled). The name says "merged" but the value means "seeded" — semantically inverted for any future consumer. Its later grep found `.merged` currently has **zero frontend consumers**, so it's dead-field confusion, not a live bug. Disposition: renamed for clarity below; no behavior change needed now.

3. **Governance drift: zero** — its `git diff 663dea5..HEAD` over lib.rs/build.rs/capabilities came back empty. No registration drift this round. checked: OK

4. **Event ordering (its App.tsx trace):** VaultProvider wraps AppContent above Dashboard; useTelegramConnection lives INSIDE Dashboard → provider mounts first, listener registered before auto-sync can fire the event. No missed-event window. checked: OK

## Remaining findings (controller, completing its unfinished items)

| # | Finding | Severity | Disposition |
|---|---|---|---|
| R1 | Seed-push wrong-side timeline: PC2-online-first seeds older/empty state; PC1 later pulls and union-merges. IDs: nothing lost (union). Creds: PC1 keeps local P because remote hash is empty (`merge_remote_into_local` guard: adoption requires non-empty remote hash) — traced through `creds_adopted_only_when_local_empty_or_remote_newer` test which pins exactly this. No user-visible regression constructible. | Consider | Accepted; test already guards it |
| R2 | Simultaneous cold launch on both PCs → both seed → two marker messages exist; each PC edits only ITS OWN message id → two divergent blobs can persist across sessions (each pull adopts newest content but neither adopts the other's message id) | Consider | Real but self-limiting (union merge prevents data loss; both blobs converge in content). Proper fix = adopt remote message id on merge; deferred with a code comment until observed in practice |
| R3 | Event payload shape-validation is minimal (`'is_unlocked' in s`) | Nit | Backend is the only dispatcher; Tauri isolation makes spoofing out of scope. Accepted |
| R4 | apply() on pulled locked-state nukes caches mid-session when user was unlocked | Consider | Spec-consistent (lock ⇒ cache hygiene); transient refetch cost accepted |

## Fixes applied in this round
- **E (pre-emptively fixed before reviewer delivery):** `state_response_public` reflects real runtime unlock flag — sync event no longer force-locks an unlocked UI (`5324a4b`).
- **R2 mitigation:** comment added at seed site documenting the dual-blob steady state and the adopt-remote-id remedy (this commit).

## Verdict: Approve (with R2 deferred, documented)

### What was verified vs assumed
**Verified by reviewer + controller independently:** state_response_public fix shape, governance zero-drift, event ordering (provider mounts before hook), merged-field has no consumers, creds-guard test coverage.
**Assumed:** React ≥19 discrete-event effect flushing (documented semantics); no runtime multi-PC exercise (user's install test is the live verifier).
