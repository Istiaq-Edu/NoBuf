# Cross-Validation Review — Vault Spec Rev 2

**Inputs:** docs/specs/2026-08-22-vault-design.md (rev 2) · reports/review-vault-design.md (consolidated) · reports/review-vault-security.md (full late delivery)
**Method:** crossvalidation-review protocol — every load-bearing claim re-derived from live source; doc-vs-doc conflicts adjudicated; fresh edge-case hunt. Write-as-you-go.
**Date:** 2026-08-22 · Branch feature/vault-hide-channels

---

## Per-claim verdicts

| # | Claim (source doc) | Verdict | Evidence |
|---|---|---|---|
| C1 | Startup restores `activeFolderId` unconditionally (security F6) | VERIFIED | `useTelegramConnection.ts:37-39`: `get('activeFolderId')` → `setActiveFolderId(saved)` with no vault check |
| C2 | File pane queries off `activeFolderId`, not activeView (security F6) | VERIFIED | `Dashboard.tsx:156-162`: `queryKey:['files', activeFolderId]`, `enabled: !!store && !isPublicView` |
| C3 | Hidden folder's listing RENDERS at startup before unlock (security F6 conclusion) | **FALSIFIED** (narrowed) | `Dashboard.tsx:51` activeView initializes `'saved'` and is never persisted; sync-effect `Dashboard.tsx:70-78` re-runs whenever `setActiveFolderId` identity changes — and it is an unstable plain fn (`useTelegramConnection.ts:287-293`, no useCallback) → effect fires post-store-load and clobbers restored id back to `null`. Net: one transient `cmd_get_files` fetch for the hidden id into query cache; nothing renders. |
| C4 | Rev 2 hard-boundary paragraph matches server reality (consolidated R1) | VERIFIED | REST auth `api_routes.rs:36-53`; loopback binds; stream token gate `server.rs:887-903`; CORS pins `lib.rs:100-103` |
| C5 | Six store writers enumerated (consolidated R4) | VERIFIED | grep `store.set('folders'`: `useTelegramConnection.ts:106,196,214,237,261,282` — six, exactly as listed |
| C6 | Four consumers of folders/publicChannels (consolidated R11 sites) | REVISED | `:661` MoveToFolderModal, `:721` is `<Sidebar folders=>` (NOT group tabs — mislabeled in consolidated report), `:736` Sidebar publicChannels, `:856` ForwardToFolderModal. FolderGroupTabs takes no folder props (fetches groups itself, `FolderGroupTabs.tsx:88`). Count still four; label corrected. |
| C7 | Four activeView ternaries need 'vault' arms (R11) | VERIFIED | `:122` isPublicView, `:525` currentFolderName, `:796` onRemoveChannel conditional, `:854` sourceChannelId ternary — re-read all four |
| C8 | `constant_time_eq` already a dep (rev 2 §4.1, security F4) | VERIFIED | `Cargo.toml:53` `constant_time_eq = "0.3"`; established idiom `api_settings.rs:88-91` |
| C9 | pbkdf2/hex NOT yet deps; sha2+rand present | VERIFIED | `Cargo.toml:46-47,53` — no pbkdf2/hex lines |
| C10 | 600k iterations, 16-byte salt, verify via constant_time_eq all specified (security F3a/F3b/F4 adoptions) | VERIFIED in rev 2 text | spec §4.1 hashing paragraph |
| C11 | At-keyboard-adversary corollary stated (security F5 Consider) | MISSING in rev 2 | §1 hard-boundary paragraph lacks the "no protection against keyboard access" sentence → Amendment 1 |
| C12 | Command table consistency | **INCONSISTENT** | Prose says "Commands (9 …)" but table lists 10 rows (incl. `cmd_vault_prune_folders`, `cmd_vault_set_entry_visible`) → Amendment 5 |
| C13 | Reset confirm dialog + scope (security F5 checked-OK parts) | VERIFIED | D8 + §4.3 reset rows |
| C14 | Locked get_state returns counts but no IDs | VERIFIED (spec) + test pinned | §4.1 command table; §6 Rust test asserts serialized JSON has no ID arrays while locked |

## Adjudications

**A1 — Security Finding 6 (startup restore leak): NARROWED.**
The mechanism chain (C1+C2) is genuine and the prescribed fix direction is right, but the shipped-today behavior does not render hidden content: the `'saved'`-initial sync-effect clobbers the restore (C3). However, that guard is **incidental** — it exists only because `handleSetActiveFolderId` lacks `useCallback`. Any routine memoization refactor silently converts the latent hazard into a live leak, and our own react-performance conventions push toward exactly that refactor. RULING: keep a Required-grade amendment, reframed from "fixes live leak" to "pins behavioral guarantee + kills the transient hidden-folder fetch"; implementation must NOT rely on the accidental clobber.

**A2 — Consolidated R6/R7 (lock ownership, cache removal): re-derived, STAND as written.** No conflict with security report; both survive re-derivation.

**A3 — Command count: spec text wins over consolidation prose.** 10 commands is the deliberate surface (prune + entry_visible earn their keep); fix the "(9…)" typo rather than merging — merging `set_entry_visible` into another command saves nothing and muddies the leak rules.

**A4 — Security Considers 3a/3b/4/5:** 3a (600k), 3b (salt pin), 4 (constant_time_eq naming) were already adopted in rev 2 — verified C10; 5 (at-keyboard corollary) was missed → adopted as Amendment 1.

## New flaws found (fresh hunt)

| # | Severity | Flaw |
|---|---|---|
| N1 | Minor | **Hide/get_state race:** a fast drag-drop onto the vault item before `cmd_vault_get_state` resolves makes VaultContext decide create-dialog-vs-direct-hide from stale `hasPasscode`. Fix: `hide()` re-syncs state before branching (Amendment 4). |
| N2 | FYI | Second hide during open create-passcode dialog: modal backdrop swallows the drop by construction (covers viewport) — no queue needed; noted so nobody "fixes" it. |
| N3 | Minor | Hiding an id that reconciliation just removed (dead id) leaves a harmless dead entry in the unlocked vault view until prune; clicking it errors gracefully. Worth one §4.3 row so QA doesn't file it (Amendment 6). |
| N4 | Checked OK | Ctrl+Shift+V auth gating comes free: `useKeyboardShortcuts` is mounted inside Dashboard, which only mounts post-auth — no extra gate needed beyond `enabled`. |
| N5 | Checked OK | Reset-inside-unlocked-vault correctly absent (change-passcode only); reset lives solely on lock screen. |
| N6 | Checked OK | Pickers receiving filtered arrays mid-open (item hidden while modal open) simply lose the option via prop re-render — no selected-but-vanished hazard. |

## Required Amendments

1. **§1 (hard-boundary paragraph), append:** "Because reset must always work without the passcode (D8), the vault offers no protection against a person with access to the unlocked desktop — it delays and de-scopes disclosure, it does not conceal from keyboard access."
2. **§4.3, new row — Startup restore gating:** "On launch, persisted `activeFolderId` is applied ONLY after VaultContext state resolves; if the persisted selection references a vaulted item, reset to Saved Messages and clear the persisted value (locked OR unlocked). Rationale: current code contains only an INCIDENTAL guard — the `'saved'`-initial sync-effect clobbers the restore because `setActiveFolderId` is an unstable identity (`Dashboard.tsx:51,70-78`; `useTelegramConnection.ts:287`) — and any memoization refactor would silently expose the hidden folder's contents at startup. Also gate the files query `enabled` on vault-state resolution to kill the transient hidden-id fetch."
3. **§6, add tests:** "Restore-gating behavioral test: simulate persisted vaulted selection + cold start → assert navigation lands on Saved Messages and no `['files', <vaultedId>]` query fires. Mutation check: removing the gate must fail this test EVEN IF the incidental clobber is present (i.e., test asserts our gate, not React timing)."
4. **§4.2 VaultContext:** "`hide()` awaits a fresh `cmd_vault_get_state` before choosing create-dialog vs direct-hide (guards against stale `hasPasscode` during early startup)."
5. **§4.1 heading:** "Commands (9" → "Commands (10" — prune and set_entry_visible are deliberate members.
6. **§4.3, extend stale-ID row:** "Hiding an already-removed id is harmless: dead entry visible only inside the unlocked vault view, pruned per §4.4, clicking it surfaces a graceful error toast."

All six applied verbatim to spec → **rev 3**.
