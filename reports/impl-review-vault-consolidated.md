# Vault Implementation Review — Consolidated (post-merge deep sweep)

**Scope:** the shipped vault implementation at `b324cfc` (vault feature + dev merge), reviewed from 3 adversarial angles with fresh-eyes subagents + controller verification.
**Method:** code-review-methodology fan-out (frontend-state / merge-seam / long-run-bottleneck domains), write-as-you-go reports in `reports/impl-review-vault-*.md`, controller spot-checks in parallel. Two reviewers were killed by provider 524s mid-run; their domains were completed by the controller using their partial evidence plus direct source verification.
**Outcome:** 2 fixes applied (`73232ef`), rest dispositioned. Verdict after fixes: **Approve**.

---

## Domain verdicts

| Domain | Verdict | Key results |
|---|---|---|
| Merge seam (vault × dev's upload overhaul) | **Approve, zero blockers** | Vault rejection path byte-identical post-merge; 11/11 vault commands present in all three registration surfaces (96=96=96 set-diff, zero missing/duplicate); search-filter guards proven by live `cargo test --lib vault::` run on merged tree; dev's sequential queue/zombie-purge share zero state with vault paths |
| Frontend state | 2 Consider-grade issues → both fixed | See F1/F2 below |
| Long-run & bottlenecks | No ship-blockers | See L1–L4 dispositions |

## Fixes applied

### F1 · Required — unstable context identity churned consumers
`VaultContext` built a fresh `value` object + fresh `hiddenFolderIds`/`hiddenPublicIds` Sets on every render. Every Dashboard state change — including bandwidth ticks every 5s (`refetchInterval: 5000`, Dashboard.tsx:306) and each selection click — re-firing the restore-gate effect and recomputing both filter passes.
**Fix:** `useMemo` on both Sets (keyed on the underlying arrays) + `useMemo` on the context value. Consumers' dep arrays now stable across unrelated renders.

### F2 · Consider — `window.confirm` vs project ConfirmContext
VaultView's reset used WebView2's synchronous native dialog while the entire app standardizes on `ConfirmContext`/`useConfirm` styled dialogs (SettingsPage API-key regen, theme delete).
**Fix:** swapped to `confirm({ title, message, confirmText: 'Reset Vault', variant: 'danger' })`. Consistent theming, no JS-thread-blocking native quirk.

## Checked and cleared (highlights)

- **Drop rejection survives merge:** document-capture drop handler is byte-identical to pre-merge; vault hit-test runs before any staging work; repo-wide there is exactly ONE production consumer of dropped OS files — no second ingestion path can bypass the "Only channels can be hidden" toast.
- **No new HTTP leak surface:** `/upload-drop`, `/__whoami`, `cmd_probe_upload_route` enumerated parameter-by-parameter — all ingest/probe only, no read/list path for vaulted content. (INFO: `/upload-drop` accepts any `folder_id` behind loopback+session-token — same trust class as the documented REST/stream boundary, spec §1.)
- **Registration parity:** build.rs ↔ lib.rs ↔ capabilities set-diff clean in both directions; dev added exactly one command line per surface.
- **In-flight transfers:** hiding a channel cancels nothing — `cancelled_transfers` has exactly one writer (`cmd_cancel_transfer`), no vault command among writers; queued items keep their captured folderId. Spec assumption intact.
- **KDF cost bounded:** PBKDF2 600k ≈ 148ms single-thread measured on this box (20 cores, tauri default multi-thread runtime) — unlock attempts are serialized frontend-side by modal busy-state; no starvation vector for streaming/downloads.
- **Unicode-digit hole closed by construction:** backend accepts `\d` (unicode digits) but both frontend inputs strip non-ASCII-digits before submit — mismatched acceptance is unreachable through the UI, and backend-side it's harmless (any accepted string still hashes consistently).
- **Restore-gate false-positive window:** a user click landing during the ~50–150ms pre-ready window gets treated as "restored" and clears the persisted key unnecessarily — worst case costs one extra store write; navigation intent is unaffected. Accepted (Nit).
- **Double IPC on hide:** hide() does hide + get_state round-trips though the response carries fresh state — kept deliberately: refresh() also drives cache-nuke-on-lock via applyState, single code path. Defense-in-depth, ~1ms local IPC. Accepted.

## Long-run dispositions

| Concern | Disposition |
|---|---|
| Listener leaks | All new listeners (hotkey, drag watchdogs) registered with symmetric cleanup in effects; SidebarItem's capture listeners exist only while `isOver` and clear unconditionally. Clean bill. |
| Lock/unlock cache thrash | Blanket `removeQueries` on lock is provably the only correct option (locked state cannot know which ids to selectively purge); refetch-on-demand cost is one query per visited view. Pathological rapid lock/unlock loops just re-fetch — bounded, no growth. |
| Sleep/resume desync | Backend owns lock truth; every mount re-hydrates via get_state. forceLogout path wipes IDs server-side. No frontend-only unlocked state persists across resume paths that matter (D4: process-lifetime unlock). |
| Growth bounds | vault.json holds id arrays only; no accumulation found in toasts/queues/caches beyond react-query's own LRU gcTime. Clean bill. |
| Dead-end UX | Entry hidden + forgot hotkey → Settings > Vault > Open Vault recovers. Escape on first-hide modal clears pendingHideRef via cancelPendingHide. Reset with foreign-account ghosts → lists cleared wholesale, no partial state. |

## What was verified vs assumed

**Verified:** merge byte-comparisons, registration set-diffs, live cargo/vitest runs on merged tree, param surfaces of all new HTTP routes, listener cleanup symmetry, KDF timing measurement (148ms @600k), bandwidth poll interval, ConfirmContext precedent.
**Assumed:** static analysis only — no runtime drag-drop exercise in the webview (that's the cold-restart e2e); WebView2 OS-drop delivery semantics taken from consistent cross-side code comments.

## Before you merge upstream

The cold-restart e2e remains the final gate: restart `tauri dev` (Rust changed), then walk: right-click hide → passcode create → gone from sidebar → reopen app → still hidden → Ctrl+Shift+V → wrong passcode rejected → correct unlocks → Open/Unhide/Lock-now → Settings toggle hides entry while viewing vault → drops onto vault item show the reject toast.
