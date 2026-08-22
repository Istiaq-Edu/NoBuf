# Vault — Hide Channels & Folders Behind a Passcode

**Date:** 2026-08-22 · **Branch:** `feature/vault-hide-channels` (cut from `fix/dragdrop-upload-defects`, which is 8 ahead / 0 behind `origin/dev`)

---

## 1. Purpose

A passcode-gated space in the NoBuf sidebar. The user hides private `[NB]` folders and public channels there; hidden items disappear from all normal UI and appear **only inside the unlocked vault view**.

Security stance (user-confirmed): **soft security at the app-UI level.** All content lives on the user's Telegram account and is untouched by this feature. The passcode gates what NoBuf *reveals*; recovery is always available; nothing is destroyed by a forgotten passcode.

## 2. Verified codebase facts this design rests on

| Fact | Evidence |
|---|---|
| Folders = Telegram channels tagged `[NB]`; folder list reconciled against Telegram at startup | `models.rs:39-53` (ScanResult), `fs.rs:101-107` |
| Folder reorder is **frontend-local state persisted via store plugin**, no backend command | `useTelegramConnection.ts:279-285` |
| Public channel list persists locally in SQLite (`db_path()` in app-data dir) | `public_channels.rs:12-13` |
| JSON-config pattern with hashed secret already exists: salted SHA-256, mutex lock, never exposes hash to frontend | `api_settings.rs` (ConfigLock, ApiSettingsResponse.key_set) |
| Crypto deps present: `sha2 = "0.10"`, `rand = "0.8"` | `Cargo.toml:46-47` |
| SidebarItem context menu exists (Delete/Rename/Assign group) | `SidebarItem.tsx:41-109` |
| ActiveView = `{type:'saved'} \| {type:'folder',folderId} \| {type:'public',channelId}` | `types.ts:96-99` |
| Settings page has established toggle patterns (`settings-toggle-switch on/off`) | `SettingsPage.tsx:583-587` |
| No global search exists in the app | searched, zero hits |

## 3. Decisions (all user-confirmed during interview)

| # | Decision | Choice |
|---|---|---|
| D1 | Hideable items | Private `[NB]` folders + public channels |
| D2 | Threat model | Soft security, recoverable; NoBuf-app-level only |
| D3 | Entry point | Vault item pinned below Saved Messages; Settings toggle shows/hides the entry itself |
| D4 | Re-lock | On app reopen only; tray minimize does NOT re-lock |
| D5 | Unlocked UX | Dedicated vault view listing only hidden items |
| D6 | Passcode format | Numeric, 4–12 digits |
| D7 | Storage | App-data `vault.json`; passcode as salted PBKDF2-SHA256 hash, never plaintext |
| D8 | Wrong passcode | No lockout. "Reset Vault" link → one confirm → passcode cleared, ALL hidden items return to normal sections |
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

State lives in `vault.json` inside `app_data_dir()`, guarded by its own `ConfigLock`-style mutex, written atomically (temp file + rename), following `api_settings.rs`.

```rust
#[derive(Serialize, Deserialize)]
pub struct VaultStore {
    passcode_hash: Option<String>,   // PBKDF2-HMAC-SHA256 hex
    salt: Option<String>,            // random hex, regenerated per set/change
    iterations: u32,                 // stored for forward compat
    vaulted_folder_ids: Vec<i64>,
    vaulted_public_channel_ids: Vec<i64>,
    #[serde(default = "default_true")]
    entry_visible: bool,             // sidebar entry shown? Default true.
}
```

In-memory `VaultState` (not persisted): `unlocked: bool` (always starts `false` each launch).

Commands:

| Command | Behavior |
|---|---|
| `cmd_vault_get_state` | Returns `{ has_passcode, is_unlocked, folder_count, public_count }`. Counts always returned (D15). Never returns IDs unless unlocked. |
| `vault_hide(kind, id)` | Appends ID if absent. If no passcode set → error `passcode_required` so frontend opens the create dialog first. Idempotent. |
| `vault_unhide(kind, id)` | Removes ID if present. Idempotent. Requires unlocked. |
| `vault_list` | Returns both ID lists. Requires unlocked; error otherwise. |
| `vault_verify(passcode)` | Constant-time-ish verify vs PBKDF2 hash; sets `unlocked=true` on success. Rate-limit-free (D8). |
| `vault_set_passcode(passcode)` | Validates 4–12 digits; generates salt; stores PBKDF2 hash (100k iters). Overwrites existing only from unlocked state. |
| `vault_change_passcode(new)` | Same as set but requires unlocked (already authenticated inside vault). |
| `vault_lock` | Sets `unlocked=false`. |
| `vault_reset` | Wipes passcode+salt, clears both ID lists. Available when locked (it IS the recovery path). One-time destructive action on the hiding metadata only. |
| `vault_set_entry_visible(bool)` | Persists `entry_visible` flag in same file. |

Validation: passcode regex `^\d{4,12}$` enforced backend-side too.

### 4.2 Frontend

- **Types:** add `ActiveView` variant `{ type: 'vault' }`.
- **VaultContext** (`context/VaultContext.tsx`): holds `isUnlocked`, `hasPasscode`, `counts`, `hiddenFolderIds`, `hiddenPublicIds`; exposes `unlock/lock/hide/unhide/reset/setPasscode/setEntryVisible`. Loads state once at mount.
- **Filtering rule (load-bearing):** Dashboard derives `visibleFolders = folders.filter(not vaulted)` and `visiblePublicChannels = publicChannels.filter(not vaulted)` in ONE memo, and passes those to `<Sidebar>`, pickers, everywhere. The raw arrays are used ONLY for: reorder persistence, reconciliation payloads (`cmd_start_auto_sync` local_folders), and inside the vault view.
- **Sidebar:** new pinned `SidebarItem` under Saved Messages (lock icon; badge = total hidden count). Accepts drops: private-folder reorder MIME → hide that folder; public-channel drag MIME → hide that channel; external file-drop MIME → toast "Only channels can be hidden". Collapsed mode: icon-only, same behavior.
- **VaultView:** rendered when `activeView.type === 'vault'`. If locked → lock screen modal (passcode input, Reset link). If unlocked → grid of hidden items with actions per D12; change-passcode modal; Lock-now button; empty state.
- **ContextMenu:** "Hide in Vault" action on folder items and public channel items (SidebarItem + PublicChannelItem).
- **Settings:** toggle switch "Show Vault in sidebar" (`vault_set_entry_visible`); "Open Vault" button; section follows existing settings-toggle styling.
- **Hotkey:** `Ctrl+Shift+V` in `useKeyboardShortcuts` → navigate to vault view (opens lock screen if locked).
- **Modals:** create-passcode (first-hide, D16), unlock screen, change-passcode — styled like existing modals.

### 4.3 Edge cases

| Case | Behavior |
|---|---|
| Vaulted folder deleted/kicked on Telegram | Startup reconciliation prunes dead IDs from vault.json silently |
| Different Telegram account logs in | Stale IDs never render (absent from live lists); pruned on next sync |
| File-drop onto vault item | Toast "Only channels can be hidden"; no state change |
| Folder reorder while items hidden | Reorder handler receives the FULL unfiltered array (see 4.2 filtering rule) — hidden folders keep their positions |
| Settings hides vault entry while viewing vault | Navigate to Saved Messages immediately |
| In-flight transfers from just-hidden channel | Keep showing (real work in progress) — documented, not a leak fix |
| Reset with both scopes populated | Both lists cleared + passcode cleared; entry visibility unchanged |
| Change passcode | From inside unlocked vault only; new + confirm fields; no current-passcode prompt |
| Corrupt/unreadable vault.json | Treated as empty vault (fresh state), never crashes; logged |
| Vault empty | Empty-state hint in vault view; badge hidden when count 0 |
| First hide with no passcode | Create-passcode dialog gates the hide (D16) |
| Hide currently-viewing channel | activeView jumps to Saved + warning toast (D14) |
| Pickers (Move/Forward) | Filter hidden IDs out unless vault unlocked (D13) |

## 5. Out of scope

Content encryption (content lives on Telegram), per-item passcodes, biometrics, auto-lock timers, cross-device vault sync, hiding individual FILES (channels/folders only).

## 6. Test plan

- Rust unit tests in vault.rs: hash/verify round-trip; wrong passcode rejected; 3-digit and 13-digit rejected; reset wipes everything; hide/unhide idempotent; corrupt-file recovery; counts returned when locked but IDs not.
- Vitest: VaultContext filtering memo excludes hidden IDs; first-hide gating flow; reorder-with-hidden-items passes FULL array to persistence; pickers include/exclude by lock state; Ctrl+Shift+V binding. Bound to shipped exported functions, mutation-tested (revert fix → tests fail).
- Gates before merge: `npx tsc --noEmit`, `npx vitest run`, `cargo test --no-default-features`.

## 7. Implementation phases

1. **Backend vault store** — vault.rs, commands registered, unit tests green.
2. **Frontend state** — types, VaultContext, filtering memo wired into Dashboard/Sidebar props.
3. **Sidebar entry + hide flows** — pinned item, context-menu action, drag-drop hide, first-hide passcode dialog.
4. **Vault view + lock screens** — ActiveView 'vault', lock/unlock/create/change modals, interior actions.
5. **Settings + hotkey + polish** — visibility toggle, Open Vault button, Ctrl+Shift+V, edge-case sweep.
