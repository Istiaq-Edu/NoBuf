# Vault Design Review — Consolidated Adversarial Report

**Spec reviewed:** `docs/specs/2026-08-22-vault-design.md` @ `feature/vault-hide-channels`
**Date:** 2026-08-22 · **Method:** 4-domain adversarial fan-out (security / state-consistency / frontend-integration / robustness-implementability). Fresh-eyes subagents ran the security domain end-to-end and opened the other three before provider flakes cut them off; the controller completed those domains by direct verification against live source. Every claim below carries file:line evidence re-checked against the repo.
**Outcome:** all Required findings folded into **spec revision 2** (same file). Verdict after fixes: **Approve**.

---

## The one fact the design is safe because of

The vault never touches Telegram and never claims to bound HTTP disclosure — its security claim is exactly "what the NoBuf GUI renders." That claim is now TRUE by construction because filtering happens at ONE memo feeding ALL FOUR consumers (`Dashboard.tsx:661,721,736,856`), raw arrays reach only persistence/sync/vault-view paths, and the REST/stream boundary is documented instead of implied. Status: verified by enumeration (step 2–3 of blast-radius); runtime proof lands with the vitest suite in Phase 2 (mutation-tested).

---

## Findings & dispositions

### R1 · Required — REST/stream servers bypass the vault entirely *(security agent, confirmed)*
Both localhost servers serve any folder/channel by id with no vault awareness:
- `GET /api/v1/files?folder_id=` (+ metadata/download/HEAD) — X-API-Key auth, `api_routes.rs:125-433`, auth gate `:37-53`, 401 `NO_KEY_CONFIGURED` when unset.
- `/stream/{folder}/{msg}?token=…` family — per-launch random token, constant-time compared, `server.rs:887-903`.
Loopback-only binds; CORS origin-pinned (`lib.rs:100-103`, `server.rs:7798-7802`), so random web pages can't read responses cross-origin. Within the stated threat model this does NOT escalate (same-machine attacker can read `%APPDATA%` anyway), but the spec's "passcode gates what NoBuf reveals" was false at the HTTP layer.
**Disposition:** §1 hard-boundary paragraph added ("vault gates the GUI only"); server-side 404-for-vaulted-ids listed as optional future hardening, out of scope v1.

### R2 · Consider — hidden names persist in plaintext stores *(security agent, confirmed)*
Tauri store `config.json` folders array carries `{id,name}` for vaulted folders (`useTelegramConnection.ts:25-43,279-285`; types.ts:11-15); `nobuf_groups.db` public_channels table holds names/usernames (`public_channels.rs:16-27`). Cleared surfaces: peer cache (in-memory only), stream-cache sidecars (filenames only), sprites/thumbnails (message-id keyed), logs (ids only, no titles found), window title (no dynamic writes).
**Disposition:** documented in §1 + §4.3. Consistent with D2; changing it would be scope creep.

### R3 · Required — reconciliation must actively prune vaulted dead IDs *(state domain)*
Startup sync computes `removed` folder IDs (`models.rs:39-53`); without pruning, deleted/kicked channels would sit in vault.json forever and count-badge totals would rot. Pruning ownership resolved: Dashboard calls new `cmd_vault_prune_folders(result.removed)` AFTER store update — frontend orchestrates because ScanResult is consumed there today; backend stays passive. Failure worst case: one stale ID visible in unlocked vault until next launch (logged, acceptable).
**Disposition:** §4.4 sequence added; command added to surface.

### R4 · Required — six store writers, not one *(state domain, verified by enumeration)*
Writers of store key `folders`: sync apply (:106), create (:196), rename (:214), delete (:237), delete-from-modal (:261), reorder (:282). The original spec's rule mentioned only reorder; ANY writer receiving a filtered array silently deletes vaulted folders from persistence.
**Disposition:** rule generalized — visibility filtering exists only at render props; every persistence path uses raw arrays. Test plan extended to cover all six paths.

### R5 · Consider — account-switch asymmetry *(state domain, verified)*
forceLogout wipes `api_id/api_hash/folders` from store but NOT the SQLite public-channels DB (`useTelegramConnection.ts:139-149`). So account #2 gets: fresh private folders (no stale vaulted-folder risk), stale public channels whose names still render until sync's `is_member` refresh. Vaulted IDs that don't exist in live lists never render anywhere (filtering is intersection-based), so no cross-account name leak through the vault itself.
**Disposition:** edge-case row sharpened in §4.3.

### R6 · Required — lock-state ownership was ambiguous *(state domain)*
Spec had both a backend `unlocked` flag and a frontend context without naming which is truth. Window reload / dev hot-reload would otherwise desync (frontend assumes locked or unlocked across a reload while the process lives).
**Disposition:** backend flag = single source of truth; VaultContext mirrors via `cmd_vault_get_state` on mount; D4 semantics unchanged (flag dies with process).

### R7 · Required — react-query cache leak on hide *(state domain)*
`['files', activeFolderId]` queries survive navigation; hiding channel X while cached would leave its listing reachable via back-navigation.
**Disposition:** `queryClient.removeQueries` on hide for both private and public file caches; picker gating (D13) covers modal-time access.

### R8 · Required — drag-drop collision map *(frontend domain)*
Vault item sits inside Sidebar where three MIME flows already collide: reorder (`application/x-nobuf-folder-reorder`, Sidebar.tsx:37), file upload (`application/x-telegram-file-id`), global overlay (DragDropOverlay). Without priority ordering a folder-drop could trigger BOTH hide and reorder; an external drop could fire the global upload overlay from the vault item.
**Disposition:** handler order specified — reorder MIME checked first, vault branch consumes with stopPropagation; explicit ignore+toast for external drops; dragenter/dragleave counting per webview2-html5-drag-pitfalls so nested zones don't double-fire the overlay.

### R9 · Minor — Ctrl+Shift+V needs preventDefault *(frontend domain, verified)*
Existing bindings are Ctrl+A/Ctrl+F/Delete/Escape only (`useKeyboardShortcuts.ts:31-60`) — no conflict — but WebView2 reserves Ctrl+Shift+V for paste-plain-text, and the hook's input-focus guard must not swallow the hotkey when focus is in the passcode field... which it would (INPUT guard returns early).
**Disposition:** binding added outside the input-guard path (or vault-modal-scoped listener), preventDefault always. Gated on authenticated state via existing `enabled` prop.

### R10 · Minor — PublicChannelItem has no context menu today *(frontend domain, verified)*
Adding a full menu for one action is scope creep; skipping it makes hiding inconsistent between scopes.
**Disposition:** minimal new menu — single "Hide in Vault" entry, existing ContextMenu primitives. Flagged as deliberate smallest-surface choice.

### R11 · Required — four activeView ternaries need 'vault' arms *(frontend domain)*
`isPublicView` (:122), `currentFolderName` (:525), TopBar onRemoveChannel conditional (:796), ForwardToFolderModal sourceChannelId ternary (:854). Missing any produces wrong title text, a stray remove-channel action, or sourceChannelId=0 forwarding from the vault view.
**Disposition:** enumerated in §4.2; TopBar shows "Vault" + count, no channel actions.

### R12 · Cleared — atomicity claim matches reality *(robustness domain, verified)*
`api_settings.rs:57-68` really does tmp-write → sync_all → rename-over-target (Windows-safe as shipped), with unix 0600 hardening (:71-75) and corrupt-read→Default (:43-52). Spec now says "copy the proven pattern" rather than inventing wording.

### R13 · Cleared with upgrade — KDF parameters *(robustness domain)*
Original: PBKDF2-SHA256 100k. Numeric keyspace reality: ~10⁴–10⁸ practical; offline guesses bounded by hash cost. OWASP recommends 600k for PBKDF2-SHA256; unlock cost tens of ms — imperceptible, 6× attacker cost.
**Disposition:** 600k adopted; salt 16 bytes random; verify via `constant_time_eq` (already in tree, `api_settings.rs:90`) — no timing sidechannel worth exploiting given local attacker reads disk anyway, but constant-time costs nothing.

### R14 · Cleared — deps & test hooks *(robustness domain, verified)*
Adding `pbkdf2` + `hex` (tiny, pure-Rust, audited) beats hand-rolled iterated-SHA256 (non-standard, easy to get subtly wrong, no review benefit). Headless testing precedent exists (`api_settings.rs:93-122` tests pure fns, no Tauri State) — vault.rs copies it: pure core fns + thin command wrappers. Error convention stays `Result<_, String>` with stable prefixes (`passcode_required`, `vault_locked`) matching `api_settings.rs:148-155` style.

### R15 · Cleared — i64 kind confusion *(robustness domain)*
Folder IDs and channel IDs are disjoint Telegram spaces but both i64; storing them in separate arrays addressed by a `kind` enum parameter means hide(folder X)/unhide(public_channel X) can never interact. Cross-kind isolation test added.

### R16 · Nit — command surface trimmed
10 commands → 9: `vault_list` merged into `cmd_vault_get_state` (IDs included only when unlocked — same info-leak rule, fewer round-trips at mount).

---

## What was verified vs assumed

**Verified (live source):** all file:line citations above; six store writers; four prop sites; four view ternaries; hotkey inventory; forceLogout wipe set; SQLite survival; api_settings atomic-write/verify/test patterns; REST auth gates; stream token gate; CORS pinning; absence of global search; absence of PCItem context menu; peer cache in-memory only; log/title non-leaks.
**Assumed (bounded):** `pbkdf2` crate API stability (`pbkdf2_hmac::<Sha256>`) — checked at implementation time; WebView2 nested-drag counting details — validated in Phase 3 against the pitfalls skill; exact ms cost of 600k iterations on user hardware — timing-sanity test asserts a lower bound instead of a number.

## Before you merge

Cheapest catches for the two risks that matter most:
1. Reorder-vs-hide interaction: vitest that hides folder X, fires the reorder path with a filtered array, asserts store still contains X (mutation: revert filter rule → test fails).
2. Locked-state info leak: Rust test asserting `cmd_vault_get_state` serialized JSON contains no `vaulted_` arrays while locked.
