# Vault — Hide Channels & Folders Behind a Passcode

**Date:** 2026-08-22 · **Branch:** `feature/vault-hide-channels` (cut from `fix/dragdrop-upload-defects`, which is 8 ahead / 0 behind `origin/dev`)
**Revision:** 5 — implementation-start audit found LIVE global search (`cmd_search_global` → results carry source folder_id) that all four reviews missed; backend-side vault filtering specified. Plus state-review rev-4 changes (public-channel pruning, logout vault wipe, D14 handler duties). Reports: `reports/review-vault-state.md`, `reports/review-vault-crossval.md`, `reports/review-vault-design.md`, `reports/review-vault-security.md`.

---

## 1. Purpose

A passcode-gated space in the NoBuf sidebar. The user hides private `[NB]` folders and public channels there; hidden items disappear from all normal UI and appear **only inside the unlocked vault view**.

Security stance (user-confirmed): **soft security at the app-UI level.** All content lives on the user's Telegram account and is untouched by this feature. The passcode gates what NoBuf *reveals*; recovery is always available; nothing is destroyed by a forgotten passcode.

**Hard boundary (security-reviewed):** the vault gates the **GUI only**. It does NOT gate the localhost REST API (`/api/v1/files?folder_id=…`, X-API-Key auth, `api_routes.rs:125-433`) or the streaming server (`/stream/{folder}/{msg}?token=…`, per-launch random token, `server.rs:887-903`) — both serve any folder/channel by id regardless of vault state, for any process holding the API key or stream token. Vaulted names also remain in existing plaintext local stores (tauri store `config.json` folders array, `nobuf_groups.db` public_channels table). Consistent with the threat model — a same-machine attacker can already read the Telegram session and those stores — but stated here so nobody mistakes the passcode for a content boundary. Optional hardening (out of scope v1): REST/stream endpoints return 404 for vaulted ids while locked. Because reset must always work without the passcode (D8), the vault offers no protection against a person with access to the unlocked desktop — it delays and de-scopes disclosure, it does not conceal from keyboard access.

## 2. Verified codebase facts this design rests on

| Fact | Evidence |
|---|---|
| Folders = Telegram channels tagged `[NB]`; folder list reconciled against Telegram at startup | `models.rs:39-53` (ScanResult), `fs.rs:101-107` |
| Folder reorder persists the EXACT array passed via tauri store plugin; **six** writers of the store `folders` key exist (sync/create/rename/delete×2/reorder) | `useTelegramConnection.ts:106,196,214,237,261,282` |
| Public channel list persists locally in SQLite (`nobuf_groups.db`) | `public_channels.rs:12-27` |
| JSON-config pattern with hashed secret exists: temp+rename atomic write (`save_settings`), ConfigLock mutex, `constant_time_eq` compare, headless in-file tests | `api_settings.rs:54-78,88-91,93-122` |
| Crypto deps present: `sha2 0.10`, `rand 0.8`, `constant_time_eq`; adding `pbkdf2` + `hex` crates approved | `Cargo.toml:46-47` |
| SidebarItem context menu exists (Delete/Rename/Assign group); PublicChannelItem has NO context menu today | `SidebarItem.tsx:41-109`; grep of `PublicChannelItem.tsx` |
| ActiveView = `{type:'saved'} \| {type:'folder',folderId} \| {type:'public',channelId}`; view ternaries live at Dashboard.tsx:122,525,796,854 | `types.ts:96-99` |
| folders/publicChannels prop passes: MoveToFolderModal (:661), FolderGroupTabs area (:721), Sidebar (:736), ForwardToFolderModal (:856) | `Dashboard.tsx` |
| Settings page has established toggle patterns (`settings-toggle-switch on/off`) | `SettingsPage.tsx:583-587` |
| No global search exists in the app | **CORRECTED rev 5:** `cmd_search_global` DOES exist and is LIVE (TopBar input → debounced `handleGlobalSearch`, `Dashboard.tsx:322-337`; backend `fs.rs:1488`) and results carry source `folder_id` from `m.peer_id` (`fs.rs:1531-1537`). It MUST drop vaulted-peer results while locked — enforced backend-side (frontend can't, locked get_state carries no IDs); see §4.3 |
| Existing hotkeys are Ctrl+A/Ctrl+F/Delete/Escape only; Ctrl+Shift+V free but reserved by WebView2 paste-plain-text → needs preventDefault | `useKeyboardShortcuts.ts:31-60` |
| forceLogout wipes `api_id/api_hash/folders` from store; SQLite public-channels DB survives logout | `useTelegramConnection.ts:139-149` |

## 3. Decisions (all user-confirmed during interview)

| # | Decision | Choice |
|---|---|---|
| D1 | Hideable items | Private `[NB]` folders + public channels |
| D2 | Threat model | Soft security, recoverable; NoBuf-GUI-level only (see hard boundary, §1) |
| D3 | Entry point | Vault item pinned below Saved Messages; Settings toggle shows/hides the entry itself |
| D4 | Re-lock | On app reopen only; tray minimize does NOT re-lock |
| D5 | Unlocked UX | Dedicated vault view listing only hidden items |
| D6 | Passcode format | Numeric, 4–12 digits |
| D7 | Storage | App-data `vault.json`; passcode as salted PBKDF2-SHA256 hash, never plaintext |
| D8 | Wrong passcode | No lockout. "Reset Vault" link → one confirm dialog → passcode cleared, ALL hidden items return to normal sections |
| D9 | Hide entry points | Right-click menu AND drag-drop onto vault item |
| D10 | Drop while locked | Allowed; hides instantly, toast confirms, reveals nothing about contents |
| D11 | Entry when sidebar entry hidden | `Ctrl+Shift+V` hotkey + "Open Vault" button on Settings page |
| D12 | Inside unlocked vault | Unhide, open channel normally, change passcode, Lock now — all four actions |
| D13 | Move/Forward pickers | Include vaulted items only while vault is unlocked |
| D14 | Hiding currently-open channel | Jump to Saved Messages immediately + warning toast |
| D15 | Locked item look | Lock icon + count badge (count visible even when locked) |
| D16 | First hide ever | One-time "Create Vault passcode" dialog must complete before item hides |

## 4. Architecture

### 4.1 Backend — new file `app/src-tauri/src/commands/vault.rs`

State lives in `vault.json` inside `app_data_dir()`. Persistence copies the PROVEN `api_settings.rs` pattern exactly: own mutex lock, write `.tmp` → `sync_all()` → `rename` over target (Windows-safe rename-over-existing as shipped at `api_settings.rs:57-68`), `#[cfg(unix)]` 0600 perms, corrupt/unreadable file → `Default` (empty vault) never a crash (`load_settings` semantics, `api_settings.rs:43-52`).

```rust
#[derive(Serialize, Deserialize)]
pub struct VaultStore {
    #[serde(default)] passcode_hash: Option<String>, // None = no passcode yet
    #[serde(default)] salt: Option<String>,          // random 16-byte hex
    #[serde(default = "default_iterations")] iterations: u32, // read back so future versions can raise it
    #[serde(default)] vaulted_folder_ids: Vec<i64>,
    #[serde(default)] vaulted_public_channel_ids: Vec<i64>,
    #[serde(default = "default_true")] entry_visible: bool,
}
```

Every field carries `#[serde(default)]`: old files load after app updates, missing fields fill forward-compat values, unknown future fields are ignored by serde. In-memory `unlocked: bool` starts `false` every launch. **Single source of truth for lock state is the BACKEND flag**; the frontend VaultContext mirrors it via `cmd_vault_get_state` (window reload / dev hot-reload re-syncs from backend instead of assuming).

Passcode hashing: `pbkdf2` crate (pure-Rust, well-audited) with `pbkdf2::pbkdf2_hmac::<Sha256>()`, 600,000 iterations (OWASP-recommended for PBKDF2-SHA256; measured cost on unlock ≈ tens of ms — imperceptible, raises offline brute-force cost 6× over the originally specced 100k), 16-byte random salt per set/change. Verify uses `constant_time_eq` (already a dependency, `api_settings.rs:90`). Numeric-only keyspace acknowledged: 10⁴–10¹² real-world range; this is D2 soft security and the reset path always exists. Backend enforces `^\d{4,12}$` too. New deps: `pbkdf2`, `hex` (for encode/decode of salt+hash).

Commands (10):

| Command | Behavior |
|---|---|
| `cmd_vault_get_state` | `{ has_passcode, is_unlocked, entry_visible, folder_count, public_count }` +, **only when unlocked**, both ID lists. Locked responses NEVER contain IDs. Counts always present (D15). |
| `cmd_vault_hide(kind, id)` | kind ∈ {folder, public_channel} — separate arrays kill cross-kind confusion (hide folder X can never be undone by unhide public X). Appends if absent (idempotent). If no passcode set → Err `"passcode_required"` so frontend opens the create dialog first. |
| `cmd_vault_unhide(kind, id)` | Removes if present. Idempotent. Requires unlocked. |
| `cmd_vault_verify(passcode)` | PBKDF2 verify, constant-time compare; sets `unlocked=true`. Rate-limit-free (D8). |
| `cmd_vault_set_passcode(passcode)` | Validates format; generates salt; stores hash. Overwrites existing only from unlocked state. |
| `cmd_vault_change_passcode(new)` | Same, requires unlocked (already authenticated inside vault). |
| `cmd_vault_lock` | Sets `unlocked=false`. |
| `cmd_vault_reset` | Wipes passcode+salt+both lists. Works while locked — it IS the recovery path (one confirm dialog in UI, D8). |
| `cmd_vault_prune_folders(removed_ids)` | Called by Dashboard after reconciliation; intersects removed IDs out of `vaulted_folder_ids`. See §4.4. |
| `cmd_vault_set_entry_visible(bool)` | Persists `entry_visible`. |

Errors are `Result<_, String>` with stable machine-readable prefixes (`"passcode_required"`, `"vault_locked"`, …) matching the existing plain-string error convention (`api_settings.rs:127-155`). Pure logic (hash/verify/store load/save/prune) lives in plain fns above the `#[tauri::command]` wrappers so `cargo test --no-default-features` runs headless, mirroring `api_settings.rs:93-122`.

### 4.2 Frontend

- **Types:** add `ActiveView` variant `{ type: 'vault' }`.
- **VaultContext** (`context/VaultContext.tsx`): mirrors backend truth — `isUnlocked`, `hasPasscode`, `counts`, `entryVisible`, `hiddenFolderIds`, `hiddenPublicIds` (populated from `get_state` when unlocked). Exposes `unlock/lock/hide/unhide/reset/setPasscode/setEntryVisible`. `hide()` awaits a fresh `cmd_vault_get_state` before choosing create-dialog vs direct-hide (guards against stale `hasPasscode` during early startup).
- **Filtering rule (load-bearing):** ONE memo in Dashboard derives `visibleFolders` and `visiblePublicChannels`; these flow to ALL FOUR consumers — MoveToFolderModal (:661), `<Sidebar folders=>` (:721), `<Sidebar publicChannels=>` (:736), ForwardToFolderModal (:856) — plus pickers added later. RAW arrays are used ONLY by: reorder persistence, reconciliation payloads (`cmd_start_auto_sync` local_folders), sync diffing, and the vault view itself. React-query caches for hidden items are invalidated on hide (`queryClient.removeQueries({queryKey:['files', hiddenId]})`, and for public `['publicChannelFiles', hiddenId]` — exact shipped key shape incl. page index, `usePublicChannels.ts:83`) so navigating away never leaves stale data reachable via back-navigation; unhide does NOT need cache work (fresh fetch on next view). Vault view reads live vault state, never item caches. Lock-state truth: backend flag is single source of truth, VaultContext is a mirror-cache, localStorage-derived lock state is forbidden, every mutating command returns fresh lock state.
- **Reconciliation pruning (§4.4 detail):** after `ScanResult` lands, Dashboard calls `cmd_vault_prune_folders(result.removed)` — frontend owns orchestration because ScanResult is consumed there today; backend stays passive. Auto-sync runs ONCE per launch (`autoSyncDone` ref, `useTelegramConnection.ts:19,51-52`), so pruning MUST live inside the shared sync-result handler, not the startup call site. Public channels: `cmd_sync_public_channels` DELETEs dead rows from SQLite (`public_channels.rs:1013-1020`) but never tells vault.json — so after every successful public sync the frontend diffs previous vs new channel lists and calls `cmd_vault_prune` with kind=`public_channel` for the difference. Prune works while locked (backend-side intersection only). Filter memo derives from COMMITTED vault state only — never optimistic local adds.
- **Sidebar:** pinned vault `SidebarItem` under Saved Messages (lock icon; badge = total count, hidden at 0). Drag handling order: reorder MIME → vault-hide branch (consumes + stopPropagation, so a folder dropped on vault NEVER falls through to reorder); NEW `application/x-nobuf-public-channel` drag source on PublicChannelItem → hide branch; external file-drop MIME explicitly ignored with toast "Only channels can be hidden". Nested drop zones follow the WebView2 dragenter/dragleave counting discipline documented in `webview2-html5-drag-pitfalls` so the global upload overlay never fires from a vault drop. Collapsed mode: icon-only w-8 h-8 left-aligned px-4, badge dot preserved.
- **VaultView:** rendered when `activeView.type === 'vault'`. Locked → unlock screen (passcode input + Reset link w/ confirm dialog). Unlocked → grid/list of hidden items (unhide, open channel, drag-out optional later), change-passcode modal, Lock-now button, empty state.
- **View ternaries needing a `'vault'` arm:** `isPublicView` (:122), `currentFolderName` (:525), TopBar `onRemoveChannel` conditional (:796), ForwardToFolderModal `sourceChannelId` ternary (:854). TopBar shows "Vault" title + count; no channel actions.
- **Context menus:** "Hide in Vault" appended to existing SidebarItem menu; PublicChannelItem gets a minimal NEW right-click menu (Hide in Vault only — smallest consistent surface, flagged during review).
- **Settings:** toggle switch "Show Vault in sidebar" (`cmd_vault_set_entry_visible`), "Open Vault" button; existing toggle styling.
- **Hotkey:** `Ctrl+Shift+V` in `useKeyboardShortcuts` with `preventDefault()` (WebView2 reserves it for paste-plain-text); active only when authenticated (hook already gates on `enabled`).
- **Modals:** create-passcode (first-hide, D16), unlock screen, change-passcode — existing modal skeleton/backdrop/nobuf classes.

### 4.3 Edge cases

| Case | Behavior |
|---|---|
| REST/stream servers | Out of vault's reach by design — documented boundary, §1 |
| Global search vs vault | `cmd_search_global` skips results whose peer id is in either vaulted list while locked (helper `vault::id_vaulted_and_locked`, called from fs.rs result loops); when unlocked, vaulted results flow normally. Enforced backend because the frontend cannot know vaulted IDs while locked |
| Plaintext name persistence | Hidden names remain in store `config.json` + `nobuf_groups.db` (existing stores, unchanged by this feature) — documented, §1 |
| Vaulted folder deleted/kicked on Telegram | Pruned from vault.json via `cmd_vault_prune_folders` after next reconciliation (§4.4) |
| Different Telegram account logs in | Store `folders` wiped by forceLogout (verified :139-149); SQLite public channels survive. `is_member` is NEVER written to 0 (all inserts hardcode 1, `public_channels.rs:327,462`) — there is NO membership-refresh path, so cross-account stale IDs would be unfixable without account A's passcode (and D8 Reset would destroy that passcode). Therefore: logout ALSO clears both vault ID lists via a prune-style wipe (matching the folders precedent); the passcode hash SURVIVES so re-hiding after re-login uses the same code; reset remains available regardless |
| File-drop onto vault item | Toast "Only channels can be hidden"; global upload overlay suppressed by drop-zone ordering |
| Folder reorder while items hidden | ALL six store-writers receive raw arrays (create/sync/rename/delete/delete-from-modal/reorder) — visibility filtering happens only at render props |
| Settings hides vault entry while viewing vault | Navigate to Saved Messages immediately |
| In-flight transfers from just-hidden channel | Keep showing (real work in progress) — documented, not hidden |
| Reset with both scopes populated | Both lists cleared + passcode cleared; entry visibility unchanged; confirm dialog required |
| Change passcode | Inside unlocked vault only; new + confirm fields; no current-passcode prompt |
| Corrupt/unreadable vault.json | Treated as empty vault (fresh state), never crashes; matches api_settings load semantics |
| Vault empty | Empty-state hint in vault view; badge hidden when count 0 |
| First hide with no passcode | Create-passcode dialog gates the hide (D16) |
| Hide currently-viewing channel | activeView jumps to Saved + warning toast; query keys derived from activeView follow automatically; handler ALSO clears `selectedIds` and closes preview/player modals displaying the hidden channel's files (jump precedent: remove-channel flow `Dashboard.tsx:520-522`; TopBar name derives fresh at :525-529, no staleness) |
| Window reload / dev hot-reload | Frontend re-reads lock state from backend on mount — backend owns truth |
| Startup restore gating | Persisted `activeFolderId` applied ONLY after VaultContext state resolves; if the persisted selection references a vaulted item → reset to Saved Messages AND clear the persisted value (locked OR unlocked). Rationale: current code contains only an INCIDENTAL guard — the `'saved'`-initial sync-effect clobbers the restore because `setActiveFolderId` has unstable identity (`Dashboard.tsx:51,70-78`; `useTelegramConnection.ts:287`) — any memoization refactor would silently expose the hidden folder's contents at startup. Files query `enabled` is additionally gated on vault-state resolution, killing the transient hidden-id fetch |
| Hiding an already-removed id | Harmless: dead entry visible only inside the unlocked vault view, pruned per §4.4; clicking it surfaces a graceful error toast |
| Pickers (Move/Forward) | Filtered by lock state (D13); react-query cache for hidden items removed on hide |

### 4.4 Reconciliation & pruning sequence

1. Startup: `cmd_start_auto_sync(local_folders=RAW folders)` → `ScanResult{added,updated,removed,current}`.
2. Dashboard applies result to store (existing logic) AND calls `cmd_vault_prune_folders(result.removed)`; then refreshes VaultContext counts.
3. Ordering guarantee: prune runs AFTER store update, BEFORE vault view could render stale IDs; if prune fails, worst case is a dead ID shown inside the unlocked vault until next launch — acceptable, logged.

## 5. Out of scope

Content encryption (content lives on Telegram), gating REST/stream endpoints (documented boundary; optional future hardening), per-item passcodes, biometrics, auto-lock timers, cross-device vault sync, hiding individual FILES (channels/folders only), removing names from pre-existing plaintext stores.

## 6. Test plan

- Rust unit tests in `vault.rs` (headless, pure fns): hash/verify round-trip; wrong passcode rejected; 3-digit and 13-digit rejected; 600k iterations actually applied (timing sanity ≥ bound); reset wipes everything; hide/unhide idempotent; prune removes only listed IDs; cross-kind isolation (hide folder X ≠ vaulted public X); corrupt-file recovery; locked state response contains no ID arrays.
- Vitest: filtering memo excludes hidden IDs at all four consumer sites; first-hide gating; six writer paths unaffected by filtering (full arrays persisted); picker include/exclude by lock state; Ctrl+Shift+V binding + preventDefault; cache removal on hide. Bound to shipped exported functions; mutation-tested (revert → tests fail).
- Restore-gating behavioral test: simulate persisted vaulted selection + cold start → assert navigation lands on Saved Messages and no `['files', <vaultedId>]` query fires. Mutation check: removing our gate must fail this test EVEN IF the incidental clobber is present (the test asserts our gate, not React timing).
- Gates before merge: `npx tsc --noEmit`, `npx vitest run`, `cargo test --no-default-features`.

## 7. Implementation phases

1. **Backend vault store** — deps (`pbkdf2`, `hex`), vault.rs with pure-fn core + command wrappers, registered in lib.rs, unit tests green.
2. **Frontend state** — types, VaultContext (backend-owned truth), Dashboard filtering memo wired to all four consumers, cache invalidation on hide.
3. **Sidebar entry + hide flows** — pinned item w/ badge, SidebarItem menu action, PublicChannelItem mini-menu + drag source, vault-item drop zone (MIME priority + overlay suppression), first-hide passcode dialog.
4. **Vault view + lock screens** — `'vault'` ActiveView arm across the four ternaries, unlock/create/change modals, interior actions, prune wiring.
5. **Settings + hotkey + polish** — visibility toggle, Open Vault button, Ctrl+Shift+V, edge-case sweep against §4.3 table.
