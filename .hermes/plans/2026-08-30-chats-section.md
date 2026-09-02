# Chats Section — Design Spec + Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development (or execute inline).
> Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status: v3 — two adversarial review passes absorbed (30 + 23 findings; review 2 verdict "yes-with-fixes", all top findings re-verified from source and folded in). Do NOT implement until user approves.**

**Goal:** Add a collapsible "Chats" sidebar section (between Private Channels and Public Channels) where the user can add any non-broadcast Telegram dialog (1:1 DMs with people/bots, basic groups, supergroups/megagroups) as a full-drive peer — browse files, upload, download, delete — with vault-hide, colored-group assignment, drag-reorder, and full move/forward participation.

**Architecture (v3 — mirrored-id design):** New backend module `commands/normal_chats.rs` (SQLite `normal_chats` table storing peer_kind + access_hash per row) with 7 new commands. The frontend mirrors `chatId` into the existing `activeFolderId` seam exactly like public views mirror `channelId` (Dashboard.tsx:280-282), so downloads, streaming, preview, thumbnails, PDF, archives, delete, move, dropped-file uploads, and split uploads all flow through existing commands via the peer cache — which is (a) widened to cache `Peer::Group` (utils.rs:38-41) and (b) seeded from the `normal_chats` table at startup (the `seed_peer_cache` pattern, adopted_folders.rs:161-238) so archived chats resolve too.

**Tech Stack:** Tauri 2 (Rust), grammers rev d07f96f, `sqlite` crate 0.37 (`nobuf_groups.db`), React 19 + TanStack Query, Tailwind (`nobuf-*` tokens), Vitest, lucide icons, sonner toasts.

**Review provenance:** two adversarial passes — review 1 (30 findings on v1; `.hermes/plans/2026-08-30-chats-section-REVIEW.md`) drove the mirrored-id redesign; review 2 (23 findings on v2: 1 BLOCKER, 5 MAJOR, 9 MINOR, 8 NIT; `.hermes/plans/2026-08-30-chats-section-REVIEW2.md`, verdict "yes-with-fixes") is absorbed into this v3 — all top findings re-verified from source by the parent. Verified-sound by review 2: goBack restores the view (setActiveView at Dashboard.tsx:118); cmd_move_files source==target guarded (fs.rs:1846); Saved-Messages null-checks don't invert; reset effect fires on chat switches; DragDropOverlay label inherits currentFolderName; mobile needs no new work; no v1 artifacts survive.

---

## 0. Interview decisions (all settled, no assumptions)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Capabilities | Full parity with private channels: browse, upload, download, delete |
| D2 | Chat types | All non-broadcast dialogs: people, bots, basic groups, supergroups/megagroups |
| D3 | Add flow | Manual picker: '+' → modal lists eligible dialogs with search; already-added shown disabled |
| D4 | Section name/placement | "Chats", between Private Channels and Public Channels |
| D5 | Upload safety | Silent send, full parity — no confirmation dialogs (Telegram's own rules are the only gate) |
| D6 | Delete semantics | Telegram-native: delete offered on any listed file; refusal = error toast |
| D7 | Rename | None — real Telegram name always (satisfied by omission: file-level Rename is permanently-disabled dead UI, ContextMenu.tsx:129-134; sidebar rename is SidebarItem double-click which ChatItem doesn't inherit) |
| D8 | Vault | Yes — chats hideable in Vault (third `chat` kind) |
| D9 | Folder groups | Yes — chats assignable to colored groups (via ChatItem context-menu group submenu, F20) |
| D10 | Empty section | Always visible with header + '+' (like Private Channels) |
| D11 | Removal | Unlist only — no Telegram-side action |
| D12 | Ordering | Manual drag reorder, persisted locally (frontend store array, folders pattern) |
| D13 | Dead-chat policy | Auto-remove from section + toast, lazy detection on open |
| D14 | Self-chat | Excluded from picker (Saved Messages has its own entry) |
| D15 | Unread badges / online status | None — plain items like folders |
| D16 | File view | Same FileExplorer grid as folders (media from history) |
| D17 | Move/forward | Full web: chats are move/forward sources AND targets |
| D18 | Vault order | Chats listed in Vault view under their own section, unhide from there |

## 0.1 Hazards and design responses (v2)

| Hazard | Response |
|---|---|
| ID namespace collision (user-id / basic-chat-id / channel-id are separate counters) | Chat-specific commands (list/add/remove/pick) resolve kind-checked from the stored `peer_kind` + `access_hash`. Generic seam ops (upload/download/stream via the cache) accept the same cross-namespace exposure the codebase already has: User peers are cached today (utils.rs:40) and `cmd_search_global` already returns User/Chat results keyed by bare id (fs.rs:1959-1963). Cache policy stays last-wins per dialog scan (current behavior, utils.rs:43-44); the startup seed runs AFTER adopted-folder seeding so a seeded chat peer wins its own id (wrong-kind hits require a numeric collision between a chat peer and a folder channel peer in one account — accepted, documented; kind-qualified cache keys are the §3.5 non-goal). |
| `resolve_peer` caches only Channel+User (utils.rs:38-41); basic groups AND megagroups (both `Peer::Group`) never cached | Widen the cache-population arm to `Peer::Group` (keyed by raw chat id). |
| Archived chats invisible to the dialog scan (grammers DialogIter hardcodes `folder_id: None`, dialogs.rs:26; the repo documents this failure mode at public_channels.rs:561-566) | Seed the peer cache from the `normal_chats` table at startup/login: user chats → synthetic `tl::types::User` with stored access_hash; basic groups → synthetic `Chat::Chat`; megagroups → synthetic `Chat::Channel` (exact pattern of `seed_peer_cache`, adopted_folders.rs:161-238 incl. the Group-for-megagroup shape at 232-236). |
| Chat file listings must refresh after uploads | The `documents-changed` listener (Dashboard.tsx:400-405) invalidates the whole `['files']` prefix but knows nothing of `['chatFiles']`. Extend the existing listener: when the payload's `folder_id` is a chat id (chats list in memory), also invalidate `['chatFiles']`. Covers ALL upload paths (queue `cmd_upload_file`, stream-direct `/upload-drop` at upload_drop.rs:298, split parts via `upload_file_inner`, URL uploads). Capture the `UnlistenFn` properly (the existing effect leaks its listener — don't clone the leak, F24). |
| Megagroup identity overlap (an adopted megagroup folder is `Peer::Group` exactly like a candidate chat; public channels are broadcast-only so no triple overlap — verified public_channels.rs:477-480, 263, 283) | Picker excludes adopted megagroups by extracting the raw channel id from `Chat::Channel` inside `Peer::Group` and checking `adopted_ids` (same extraction the kind-derivation uses); also excludes `[NB]`-titled Group chats. Failure if missed: duplicate sidebar entries with divergent vault/group state. |
| Dead dialogs (left/kicked basic groups arrive as `Chat::Forbidden`/`Chat::Empty`) | Picker excludes `Chat::Forbidden`/`Chat::Empty` (only `Chat::Chat` with real data is a valid basic group) — instant-CHAT_GONE rows never enter the list (F23). Liveness signals for chats, if needed beyond error mapping: `USER_IS_BLOCKED`/`PEER_ID_INVALID` (DMs), `USER_NOT_PARTICIPANT`/`CHAT_ID_INVALID` (groups) — none mapped today, the CHAT_GONE map covers them (backend recon §6d). |
| `hidden_ids_if_locked` is a 2-tuple (vault.rs:215-224) with a source-scan test pinning the shape (vault.rs:647-661) | Becomes a 3-tuple; update the pinned test. `search_result_keeps` (vault.rs:228-241) gains per-kind match arms. |
| Vault reset/wipe/prune know only folder+public ids (vault.rs:445-446, 462-463, 478-481) | All three gain chat arms (else: reset strands chat ids hidden forever; logout leaks account A's chat concealment into account B). Source-scan tests at vault.rs:685-716 keep passing but new chat-clear lines belong in both bodies (F18). |
| 3-site command registration | The generic tests in TauriCommandPermissions.test.ts:65-91 ALREADY assert every `generate_handler!` command appears in build.rs + capabilities/default.json (F26) — no new test needed; just register all 7 commands in all 3 sites. |
| `cmd_delete_group` orphans chat assignments | Add parallel `UPDATE normal_chats SET group_id = NULL` in cmd_delete_group (folder_groups.rs:102-104 pattern, F21). |
| Delete refusal in basic groups (48h revoke window) | Accepted per D6 — but note the move-failure mode: `cmd_move_files` forwards THEN deletes (fs.rs:1857-1865), so on delete-refusal the file exists in both places and the toast says "Delete original failed". QA row 13 wording updated accordingly (F6). |
| Basic-group "kicked" errors | `CHAT_GONE` mapping must include `USER_NOT_PARTICIPANT` (typical getHistory error on an InputPeerChat you left), plus `CHANNEL_PRIVATE`/`USER_ID_INVALID`/`CHAT_ID_INVALID`/`PEER_ID_INVALID` (F27). |
| Mixed-fleet vault sync | Old builds push blobs without `chat_ids` (serde default = empty) that temporarily overwrite the cloud blob; union-merge restores locally on next pull. Identical semantics to the adopted-wrapper fleet issue (public_channels.rs:1247-1249). Note only (F19). |

## 0.2 Test/QA strategy

- Vitest: existing 101 files / 1191 tests stay green (baseline verified 2026-08-30 20:14); the generic 3-site registration tests auto-cover new commands.
- Rust: `cargo check` + `cargo test` (existing source-scan tests updated where pinned shapes change — vault 2-tuple).
- `npx tsc --noEmit` green at every task.
- Manual QA matrix (§5) executed at the end, results to qa-results/.

---

## 1. Backend design (v2 — minimal surface)

### 1.1 New module: `commands/normal_chats.rs`

Table in `nobuf_groups.db` (lazy create, public_channels.rs:30-38 pattern):

```sql
CREATE TABLE IF NOT EXISTS normal_chats (
    chat_id INTEGER PRIMARY KEY,      -- bare Telegram id (user id / basic chat id / channel id)
    peer_kind TEXT NOT NULL,          -- 'user' | 'basic_group' | 'group' (supergroup)
    access_hash INTEGER,              -- NULL for basic_group; Some for user/group
    title TEXT NOT NULL,              -- display name at add time
    added_at INTEGER NOT NULL,
    group_id INTEGER                  -- colored-group assignment (D9)
);
```

7 commands (all registered in lib.rs generate_handler! + build.rs manifest + capabilities/default.json; the generic tests enforce the 3 sites):

1. `cmd_list_chats() -> Vec<ChatInfo>` — SELECT *; the frontend store owns ordering (D12 merge rule in §2.2).
2. `cmd_pick_chats() -> Vec<PickableChat>` — dialog scan (main list via `iter_dialogs`; NOTE: archived-only dialogs won't appear — acceptable for the picker, matches cmd_list_owned_channels' main-list-only behavior), filter: exclude self (`get_me().id`), all `Peer::Channel`, `Chat::Forbidden`/`Chat::Empty` inside `Peer::Group`, adopted megagroups (raw channel id from `Chat::Channel` ∈ `adopted_ids`), `[NB]`-titled Group chats, [NB-PUB]; already-added chats INCLUDED with `already_added: true`. Include `Peer::User` (non-self, bots too) and `Peer::Group` (`Chat::Chat` → basic_group, `Chat::Channel` → group). Search is frontend-side (AddChannelModal browseSearch pattern).
3. `cmd_add_chat(chat_id, peer_kind, access_hash, title) -> ChatInfo` — INSERT OR IGNORE + re-SELECT; also seeds the peer cache entry immediately.
4. `cmd_remove_chat(chat_id) -> bool` — DELETE row + remove cache entry. No Telegram action (D11).
5. `cmd_get_chat_files(chat_id, offset_id) -> (Vec<FileMetadata>, bool)` — `resolve_chat_peer` (kind-checked, from the stored row) → GetHistory (mirror cmd_get_public_channel_files, public_channels.rs:642-746: limit 100 fetch / 50 files cap / has_more ≥ 100; error mapping adds `USER_NOT_PARTICIPANT`, `CHANNEL_PRIVATE`, `USER_ID_INVALID`, `CHAT_ID_INVALID`, `PEER_ID_INVALID` → `CHAT_GONE: …`). FileMetadata.folder_id = Some(chat_id).
6. `cmd_assign_chat_to_group(chat_id, group_id)` — UPDATE normal_chats (folder_groups.rs pattern).
7. `cmd_get_enriched_chats() -> Vec<EnrichedChat>` — SELECT with group join (mirror cmd_get_enriched_folders, folder_groups.rs:141-154 pattern).

Also in this module (not commands):
- `resolve_chat_peer(client, row) -> Result<InputPeer, String>` — kind-checked construction: `user` → `InputPeerUser{id, access_hash}` (hash required); `basic_group` → `InputPeerChat{chat_id}` (hash-free); `group` → `InputPeerChannel{channel_id, access_hash}` (hash required).
- `seed_chat_peer_cache(client/state, rows)` — startup seeding from the table; call site = `cmd_scan_folders` (where adopted seeding runs, fs.rs:2089 — the frontend auto-sync lands there) OR the login/connect success path; implementation picks the connect path if scan's timing proves awkward. **Semantics (review2 V2-16, resolving the v2 contradiction): UNCONDITIONAL overwrite** — the stored `normal_chats` row is the authority for that dialog's id (unlike `seed_peer_cache`'s only-if-absent, adopted_folders.rs:169-177, which defers to live-scan data; the chat row has no other authority). Chat seeding runs AFTER adopted-folder seeding.
- `refresh_chat_peer` — **scoped to `cmd_get_chat_files` only (review2 V2-17):** on hash-type errors during listing, re-scan dialogs + archive (GetDialogs folder_id=1 pagination, adopted_folders.rs:383-425 pattern), update stored hash + cache, retry once; else CHAT_GONE. Seam ops (upload/stream/preview/move via `resolve_peer`) do NOT route through it — they fail with the generic "Folder/Chat {id} not found" until the next listing refreshes the hash. Rare (startup seed + session-persisted hashes make staleness uncommon); accepted, recorded.

**What needs NO new commands (the mirrored-id payoff):**
- **Upload**: `cmd_upload_file` / `upload_file_inner` (fs.rs:686-867) resolve via `resolve_peer(folder_id = chat_id)` → seeded cache → chat peer. Stream-direct drops (`/upload-drop`, upload_drop.rs:142,261) same. Split parts (split_upload.rs:1769 via `load_folder_id`) same. Split discard delete-parts (split_upload.rs:1430) same. **No `cmd_chat_upload_file`, no split `chat_id` column.**
- **Delete**: `cmd_delete_file` (fs.rs:1268-1283) → `resolve_peer` → kind-aware `delete_messages` (grammers messages.rs:804-827). **No `cmd_chat_delete_file`.**
- **Move (chat→folder, folder→chat, chat→chat, chat→Saved, Saved→chat)**: `cmd_move_files` (fs.rs:1840-1868) is already fully kind-agnostic forward+delete with no InputChannel casts (verified F5). **No new move commands.**
- **Forward public→chat**: `cmd_forward_to_folder` (public_channels.rs:803-849) resolves its TARGET via `resolve_peer` → works with `target_folder_id = chat_id` under seeding. **No new forward commands.** (D17 full web = cmd_move_files + cmd_forward_to_folder + modal target lists gaining chats.)

### 1.2 Vault: third kind (mechanical, verified F17)
- `VaultKind::Chat` + `"chat"` in `parse_kind` (vault.rs:243-255; error string updated).
- `VaultStore.vaulted_chat_ids: Vec<i64>` with `#[serde(default)]` (all store fields already default, vault.rs:29-51).
- `VaultStateResponse` gains `chat_count` + `chat_ids: Option<Vec<i64>>` (mirror vault.rs:71-81).
- `hidden_ids_if_locked` → 3-tuple; `search_result_keeps` per-kind arms (vault.rs:215-241); update the pinned source-scan test (vault.rs:647-661).
- `cmd_vault_reset` (vault.rs:445-446), wipe-on-logout (vault.rs:462-463), `cmd_vault_prune` (vault.rs:478-481) gain chat arms.
- `VaultSyncBlob.chat_ids: Vec<i64>` with `#[serde(default)]` (vault_sync.rs:20-45) + union-merge arm in `LocalVaultFields`/`merge_remote_into_local` (vault_sync.rs:73-110) + `blob_from_store` (117-129) + `apply_remote_blob` (134-184). 4000-char headroom is ample.

### 1.3 Models (models.rs)
```rust
pub struct ChatInfo { pub chat_id: i64, pub peer_kind: String, pub access_hash: Option<i64>, pub title: String, pub added_at: i64, pub group_id: Option<i64> }
pub struct PickableChat { pub chat_id: i64, pub peer_kind: String, pub access_hash: Option<i64>, pub title: String, pub already_added: bool, pub kind_label: String } // 'Direct message' | 'Bot' | 'Group' | 'Supergroup'
pub struct EnrichedChat { pub chat_id: i64, pub group_id: Option<i64>, pub group_color: Option<String> }
```

### 1.4 Peer-cache widening (utils.rs:38-41)
Add the `Peer::Group` arm to `resolve_peer`'s cache-population, keyed by the raw chat id extracted from `g.raw` (matching adopted-megagroup handling fs.rs:111-129). **Trap (verified grammers-client/src/types/peer/group.rs:61-71): the cache key must be the raw chat id from `Chat::Chat`/`Chat::Empty`/`Chat::Forbidden` — NOT `Group::id()`, which returns a packed `PeerId`, not the bare id.** Megagroups (`Peer::Group` wrapping `Chat::Channel`) are keyed by the raw channel id. Keep last-wins (current behavior). Note in a comment: cross-namespace numeric collisions resolve to whichever peer the scan saw last; kind-qualified keys are a deliberate non-goal (§3.5). Resolution de-risk note: grammers rev d07f96f persists peer access hashes (users and channels) into the session automatically, so cached peers survive restarts.

## 2. Frontend design (v2 — mirrored ids)

### 2.1 Core decision: `activeFolderId` mirrors `chatId`
The public-channel precedent: `activeView.type === 'public'` sets `activeFolderId = channelId` (Dashboard.tsx:280-282). Chat views do the same: `activeView.type === 'chat'` → `setActiveFolderId(activeView.chatId)` in the sync effect (Dashboard.tsx:275-283 gains the chat arm). This single decision makes MediaPlayer (`folderIdParam`, MediaPlayer.tsx:32-35), PdfViewer, PreviewModal, FileCard thumbnails, ArchiveViewerModal, FastStreamPlayer prebuffer, useFileDownload, useFileOperations (all five ops), the selection/preview/mobile reset effect (Dashboard.tsx:616-627 — keys on activeFolderId, now fires on chat switches), and the subtitle/audio-track cache keys (`${activeFolderId}:${id}`, FastStreamPlayer.tsx:436, useMSEPlayer.ts:3198 — now distinct per chat) all work unchanged. Upload routing (queue, stream-direct, split) needs NO branch: the queue item's folderId IS the chat id and `cmd_upload_file` resolves it.

The ONLY places that branch on `activeView.type === 'chat'`:
- **Files query**: chat views use `useChatFiles(chatId)` (paginated `cmd_get_chat_files`), not the unpaginated `cmd_get_files` (which has no cap — exactly why public channels got their own command). Dashboard's `nbFiles` query `enabled` flag gains `&& activeView.type !== 'chat'` (F13); `allFiles`/`isLoading` ternaries gain the chat branch (Dashboard.tsx:417-418).
- **documents-changed listener**: when payload `folder_id` ∈ chat ids → also invalidate `['chatFiles']` (§0.1). Plus capture the UnlistenFn (F24).
- **isReadOnly = false** for chats (full parity, unlike public views).
- **ContextMenu shape**: today a binary derived from `showForwardOption` (public: Forward+Download; folder: Rename(disabled)+Delete+Download; ContextMenu.tsx:101-145, Dashboard.tsx:1171). Chats need Forward + Delete, no Rename → introduce granular flags (`canRename`/`canDelete`/`canForward`) or a `menuMode` union; chat = {canDelete: true, canForward: true, canRename: false}. Copy-Link auto-disables for chats already (`cmd_get_channel_username` returns None for non-channels, fs.rs:1995-2000 — no work, F28).

### 2.2 Components

**Internal file drops on chat sidebar items (review2 V2-13):** folders move-on-drop (internal file drag → `handleDropOnFolder` → `cmd_move_files`, Dashboard.tsx:772-803); PublicChannelItem has NO drop handlers and the document-level capture ignores internal drags (Dashboard.tsx:902) — so a file dropped on a chat item would silently do nothing. Decision: **ChatItem gains the SidebarItem-style internal-file-drop arm routing to `cmd_move_files`** (`cmd_move_files` is already kind-agnostic — review 1 F5). This makes D17 true for the drag gesture, not just the modal. External OS-file drops remain view-routed (upload to the open chat), unchanged.

**Sub-render transition window (review2 V2-12, accepted):** a drop in the ~sub-100ms window between `navigateTo` and the sync-effect commit can land in the previous view's target — a pre-existing class (folder→folder today) that chats widen in stakes. Accepted at parity; recorded here so nobody "fixes" it half-way later.

**ChatItem visual spec (review2 V2-09/V2-10):** clone PublicChannelItem with these deltas: (a) NO is_member red dot (chats have no membership flag — field dropped, never rendered); (b) group-color dot rendered as a small ring/badge on the letter avatar's bottom-right corner; (c) reorder drag plumbing = the five folder-reorder callbacks + reorderIndicator passed as props (Sidebar.tsx:348-353 shape), rendered as insert-above/below indicators exactly like folders; (d) kind icon (User/Bot/Group lucide icon) at 12px in the avatar's top-right, tooltip = kind_label; (e) collapsed rail renders letter avatars (NOT icons — matches the public section's rail, V2-10 wording fix).

**New files:**
- `components/dashboard/ChatSidebarSection.tsx` — clone of PublicChannelSidebarSection (header/chevron/count pill/collapsed-rail '+', empty state "No chats added."); mounts AddChatModal.
- `components/dashboard/ChatItem.tsx` — clone of PublicChannelItem (letter avatar, active/hover classes, hover-reveal Lock/Trash, context menu Hide-in-Vault + Remove) + drag MIMes (CHAT_DRAG_MIME for vault-hide, CHAT_REORDER_MIME for reorder) + group-color dot + **the SidebarItem-style "Move to Group" submenu** (cmd_get_groups → cmd_assign_chat_to_group; SidebarItem.tsx:328-377 pattern — F20: without this there is no UI to satisfy D9) + kind icon/label (user/bot/group).
- `components/dashboard/AddChatModal.tsx` — single-view picker: search input + eligible dialog list (avatar letter, title, kind_label, already-added disabled rows); fetch `cmd_pick_chats` on open; click → `cmd_add_chat` → invalidate `['chats']` + toast.
- `hooks/useChats.ts` — `useChats()` (['chats'] → cmd_list_chats) + `useChatFiles(chatId)` (['chatFiles', chatId, offset], offset pagination via `cmd_get_chat_files`; CHAT_GONE → **chatGone flag, NOT navigation — review2 V2-19: hooks can't navigate (no router; activeView is Dashboard-local state). Mirror the `notAMember` pattern (usePublicChannels.ts:90-95 → Dashboard.tsx:1169): the hook exposes a flag; a Dashboard effect performs the auto-remove + toast + `navigateTo({type:'saved'})` (D13).**).

**Modified files:**
- `types.ts` — ChatInfo, PickableChat, ActiveView `{ type: 'chat'; chatId: number }`, CHAT_DRAG_MIME, CHAT_REORDER_MIME. (QueueItem/DownloadItem unchanged — folderId carries the chat id.)
- `Sidebar.tsx` — `chatsExpanded` state; divider + ChatSidebarSection between Private and Public; SidebarProps gains chats/onSelectChat/onChatsChanged/onRemoveChat; `onHideInVault` kind union + 'chat'; `filteredChats` (group-chip filter against chatGroupMap from cmd_get_enriched_chats — parallel to filteredFolders Sidebar.tsx:112-115); chat drag-reorder (clone of folder reorder Sidebar.tsx:143-219 within the section).
- `Dashboard.tsx` — chat arms in: navigateTo changed-detection (`type !== type || chatId mismatch`, else chat→chat records no history, F14), goBack concealed-skip (`candidate.type === 'chat' && hiddenChatIds.has(candidate.chatId)`, F14) + restore branch (`type === 'chat'` → setActiveFolderId(chatId), Dashboard.tsx:116-117), restore gate (219-234 checks hiddenChatIds for chat), activeFolderId sync (275-283 chat arm — THE core change), documents-changed listener extension + unlisten capture (394-415), files-query enabled flag + allFiles ternary (380-388, 417-418), `visibleChats = filterHidden(chats, ...)` memo, currentFolderName chat lookup (839-845), Sidebar props (1075-1103), FileExplorer hasMore/onLoadMore chat wiring (1167-1171), ContextMenu flags, **handleHideInVault viewingIt chat arm (review2 V2-04: `activeView.type === 'chat' && kind === 'chat' && activeView.chatId === id` → jump to Saved + chat-aware toast copy — without it, hiding the open chat leaves a live ghost chat view, defeating the vault)**, **boot-restore guard (review2 V2-02: activeView starts 'saved' (Dashboard.tsx:61) while a persisted activeFolderId=chatId restores from the store (useTelegramConnection.ts:41-42) and the sync effect doesn't re-run (deps [activeView] only, Dashboard.tsx:283) → ghost 'Folder'-titled view with unpaginated cmd_get_files listing and drops silently routed to the chat. Fix: on chats load, map a restored chat id → `navigateTo({type:'chat'})` once; if it matches no chat/folder/public id, null it out)**.
- `useTelegramConnection.ts` — chats state + persistence ('chats' store key); handleAddChat/handleRemoveChat/handleChatReorder; dead-chat auto-remove (cmd_remove_chat + toast on CHAT_GONE from useChatFiles). **Order-merge rule (F25, D12):** the store array owns order; on load, `cmd_list_chats` rows are merged — new DB rows append, missing rows pruned, order preserved from the store array. (Folders work this way: store-backed list, DB is a scan source.) **Logout hygiene (review2 V2-06):** handleLogout/forceLogout currently delete only api_id/api_hash/folders (useTelegramConnection.ts:223-247) while `useFileUpload` revives persisted 'uploadQueue' rows unconditionally on mount (useFileUpload.ts:254-269, no account filtering) — add `store.delete('uploadQueue')` + `store.delete('chats')` (+ null the persisted activeFolderId) to both logout paths, closing the cross-account silent-send surface (account B reviving account A's chat uploads).
- `useFileOperations.ts` — one addition: chat-view invalidation also hits `['chatFiles']` (delete/bulk ops currently invalidate `['files', activeFolderId]` which is a no-op key in chat views). Delete/download/bulk pass activeFolderId through unchanged — correct under mirroring.
- `context/VaultContext.tsx` — VaultKind 'chat', chat_count/chat_ids/hiddenChatIds, applyState purges ['chatFiles'].
- `components/dashboard/VaultView.tsx` — third section (D18), HiddenRow + vault.unhide('chat', id).
- `components/dashboard/ContextMenu.tsx` — granular per-view flags (§2.1).
- `components/dashboard/EmptyState.tsx` — add optional `title`/`subtitle` props (copy is hardcoded today, EmptyState.tsx:51-56 — F29); FileExplorer passes chat-specific copy for chat views.
- `components/dashboard/MoveToFolderModal.tsx` + `ForwardToFolderModal.tsx` — target lists gain chats (with kind icons); dispatch: move → `cmd_move_files {sourceFolderId: activeFolderId (= chatId), targetFolderId}` (works for chat→folder/chat→chat/Saved targets — the Saved Messages target shows because activeFolderId ≠ null under mirroring, F15); forward (public source) → `cmd_forward_to_folder {sourceChannelId, targetFolderId: chatId}`.
- `components/dashboard/TransferPanel.tsx` — ~~target-name chat fallback~~ **cut (review2 V2-03):** rows render filename only (TransferPanel.tsx:345-348); no destination-name mechanism exists to extend. No TransferPanel changes; QA row 5 reworded accordingly.
- `components/dashboard/SidebarItem.tsx` — **v3 change (review2 V2-01):** the vault item's Priority-0 drop arms recognize only FOLDER_REORDER_MIME and PUBLIC_CHANNEL_DRAG_MIME (SidebarItem.tsx:218-231, plumbed via onVaultDropFolder/onVaultDropPublicChannel at Sidebar.tsx:280-281). Add an `onVaultDropChat` prop + a CHAT_DRAG_MIME Priority-0 arm (same pattern), and pass it from Sidebar (`onHideInVault('chat', id)`). Without this, drag-a-chat-to-Vault silently does nothing (D8 + QA row 10 fail).
- `components/dashboard/FileExplorer.tsx`, `components/dashboard/FolderGroupTabs.tsx` — no changes (FileExplorer is data-props-only; group tabs are group-generic, FolderGroupTabs.tsx:86-93).
- `folder_groups.rs` (backend) — cmd_delete_group gains `UPDATE normal_chats SET group_id = NULL` (F21).

**Search-result seam note (F30, no fix in scope):** `cmd_search_global` already returns User/Chat results keyed by bare id (fs.rs:1959-1963); clicking such a result previews with the current view's activeFolderId — a pre-existing latent bug for cross-folder results that this feature widens. Record as known-issue; the vault 3-tuple filter (§1.2) is in scope, the preview seam is not.

## 3. Edge cases addressed

| Edge case | Handling |
|---|---|
| User deleted account / removed from group / chat deleted | `cmd_get_chat_files` CHAT_GONE mapping (incl. USER_NOT_PARTICIPANT) → useChatFiles auto-removes + toast + navigate home (D13 lazy) |
| Same chat added twice | INSERT OR IGNORE + disabled "Added" row in picker |
| Upload to a chat you were just removed from | send error → toast (D5 posture) |
| Basic group without access_hash | peer_kind 'basic_group' resolves id-only (InputPeerChat) |
| Stale access_hash | refresh_chat_peer: dialog+archive re-scan → update stored hash → retry once → else CHAT_GONE |
| Upload size limit | is_premium-aware limit (utils.rs:96-99); oversize VIDEO → split flow with folder_id = chatId (works unchanged) |
| Live-drop uploads (drag into app while in chat view) | `/upload-drop` carries folder_id = chatId (useDropStreamUpload.ts:228) → resolves via seeded cache → lands in the chat; documents-changed payload match refreshes the listing |
| Name change on Telegram | Title stored at add time, shown until re-add. ~~Refreshed lazily when the picker re-opens~~ **(review2 V2-18: no implementing write path — INSERT OR IGNORE never updates the row; strike the refresh claim). If title freshness matters later, add an UPDATE-on-pick path; not in v1.** No live refresh (§3.5). |
| Remove/logout mid-upload | Upload resolves the peer AFTER streaming bytes (fs.rs:780-820) — removing a chat mid-upload may still complete the send if the cache entry is warm (cmd_remove_chat evicts it, unordered vs the in-flight send); logout clears the cache so the send errors after a full upload. Accepted, like delete-refusal (review2 V2-15). |
| Group chip filter active | filteredChats against chatGroupMap (Sidebar.tsx:112-115 pattern) |
| Vault locked while viewing chat | goBack concealed-skip + restore gate extended to chat kind |
| Empty section | always visible, "No chats added." (D10) |
| Self-chat | excluded from picker (D14) |
| Chat archived on Telegram | invisible to the dialog scan but resolvable via the startup cache seed (§0.1) |
| Move with delete-refusal (basic group 48h window) | forward succeeds, delete fails → file in both places, "Delete original failed" toast (accepted per D6, F6) |
| Multi-device | vault chat ids sync via [NB-PUB] blob (chat_ids field); the chats LIST itself is per-device DB rows (same posture as public channels) |
| Mixed fleet (old build pushes blob without chat_ids) | union-merge restores locally; cloud blob lacks them until next new-build push (note only, F19) |

## 3.5 Non-goals (v1) — explicitly out
- Kind-qualified peer-cache keys (accepted exposure documented in §0.1)
- Local chat rename/alias (D7 — satisfied by omission)
- Unread badges / online status (D15)
- Text-message view (D16)
- Cross-device sync of the chats list (vault ids sync; the list doesn't)
- Live title refresh (lazy via picker re-open)
- Search-result preview seam fix (pre-existing latent bug, F30 — recorded, not fixed)

## 4. Tasks

### Task R1: Rust — normal_chats table + CRUD + picker
**Files:** Create `app/src-tauri/src/commands/normal_chats.rs`; Modify `commands/mod.rs`, `models.rs`, `lib.rs` (handler), `build.rs` (manifest), `capabilities/default.json`.
- [ ] Schema (lazy create), models, cmd_list_chats, cmd_pick_chats (filters per §1.1 — incl. adopted-megagroup exclusion via raw-channel-id extraction `if let tl::enums::Chat::Channel(c) = &g.raw { c.id }`, Chat::Forbidden/Empty exclusion), cmd_add_chat (+ immediate cache seed), cmd_remove_chat (+ cache evict).
- [ ] Register **R1's four commands** in 3 sites (review2 V2-07: registering all 7 now would fail cargo check — commands 6-7 don't exist until R3; generic TauriCommandPermissions tests enforce 3-site agreement at every stage).
- [ ] **Tests (V2-05):** `#[cfg(test)]` in normal_chats.rs — picker-filter unit tests with synthetic `tl::types::Chat`/`tl::types::User` objects: (a) self-excluded, (b) Peer::Channel excluded, (c) Chat::Forbidden/Empty excluded, (d) adopted-megagroup (Group wrapping Chat::Channel with id ∈ adopted_ids) excluded, (e) [NB]-titled Group excluded, (f) basic Chat::Chat included as 'basic_group', (g) already-added flagged not excluded.
- [ ] cargo check + cargo test green.

### Task R2: Rust — resolution + cache seeding + listing
**Files:** Modify `normal_chats.rs`, `utils.rs`.
- [ ] resolve_chat_peer + refresh_chat_peer (scoped to cmd_get_chat_files per §1.1; dialog+archive scan, stored-hash update, single retry, CHAT_GONE).
- [ ] cmd_get_chat_files (mirror public_channels.rs:642-746; error map incl. USER_NOT_PARTICIPANT).
- [ ] resolve_peer Group-arm widening (utils.rs:38-41, last-wins policy, collision comment; key = raw chat id from g.raw, NOT Group::id()).
- [ ] seed_chat_peer_cache (unconditional overwrite per §1.1) at the connect/scan path.
- [ ] **Tests (V2-05):** resolve_chat_peer construction tests (user→InputPeerUser with hash, basic_group→InputPeerChat hash-free, group→InputPeerChannel with hash, missing-hash errors); CHAT_GONE error-mapping test feeding mapped error strings.
- [ ] cargo check + cargo test green.

### Task R3: Rust — vault third kind + groups
**Files:** Modify `vault.rs`, `vault_sync.rs`, `folder_groups.rs`, `normal_chats.rs`, `lib.rs`/`build.rs`/`capabilities/default.json` (register commands 6-7).
- [ ] VaultKind::Chat + parse_kind + store field + state response + hide/unhide arms + hidden_ids_if_locked 3-tuple + search_result_keeps arms + reset/wipe/prune chat arms + pinned source-scan test update (vault.rs:647-661).
- [ ] VaultSyncBlob.chat_ids (#[serde(default)]) + merge arms (vault_sync.rs:73-184).
- [ ] cmd_assign_chat_to_group + cmd_get_enriched_chats; cmd_delete_group nulls normal_chats.group_id (F21). Register commands 6-7 in 3 sites.
- [ ] **Tests (V2-05):** hidden_ids_if_locked 3-tuple shape test; search_result_keeps per-kind test (chat id hidden → User/Chat result dropped, channel result kept); vault_sync round-trip test with/without chat_ids field (old-blob compat).
- [ ] cargo check + cargo test green.

### Task F1: types + hooks
**Files:** Modify `types.ts`; Create `hooks/useChats.ts`.
- [ ] ChatInfo/PickableChat/ActiveView chat variant/CHAT_DRAG_MIME/CHAT_REORDER_MIME.
- [ ] useChats + useChatFiles (offset pagination, CHAT_GONE → chatGone flag per §2.2 — Dashboard effect navigates, V2-19).
- [ ] useTelegramConnection: chats state + 'chats' store key + order-merge rule (§2.2) + handleAddChat/handleRemoveChat/handleChatReorder + logout hygiene (uploadQueue + chats + activeFolderId clears, V2-06).
- [ ] **Tests (V2-05):** Vitest for the order-merge rule (pure function: append-new DB rows, prune missing, preserve stored order) — extract to a testable pure helper.
- [ ] npx tsc --noEmit green.

### Task F2: sidebar section + picker modal
**Files:** Create `ChatSidebarSection.tsx`, `ChatItem.tsx`, `AddChatModal.tsx` in `components/dashboard/`; Modify `Sidebar.tsx`, `SidebarItem.tsx`.
- [ ] Three components per §2.2 (ChatItem MUST include the Move-to-Group submenu — D9's only UI entry point; visual spec per §2.2 ChatItem deltas).
- [ ] Sidebar: chatsExpanded, divider placement between Private/Public, filteredChats, hide-kind union, chat drag-reorder.
- [ ] SidebarItem: onVaultDropChat prop + CHAT_DRAG_MIME Priority-0 arm (V2-01 — without it drag-to-Vault is dead).
- [ ] **Tests (V2-05):** Vitest for filteredChats group-chip filtering logic (pure filter function — chats with group_id matching active chip pass, others hidden, null group shows under "All" only).
- [ ] Manual QA: add/list/collapse/chip-filter/vault-hide (drag AND context menu).
- [ ] npx tsc --noEmit green.

### Task F3: Dashboard view wiring (the mirrored-id core)
**Files:** Modify `Dashboard.tsx`, `useFileOperations.ts`, `ContextMenu.tsx`, `EmptyState.tsx`.
- [ ] activeFolderId sync chat arm (275-283) — THE change that makes ~10 files work unchanged.
- [ ] navigateTo comparator, goBack concealed-skip + restore arm, restore gate, files-query enabled flag + allFiles ternary, currentFolderName, visibleChats memo, Sidebar props, FileExplorer hasMore/onLoadMore, ContextMenu granular flags (chat: forward+delete, no rename), EmptyState props.
- [ ] documents-changed listener: chat-id payload → invalidate ['chatFiles']; capture UnlistenFn.
- [ ] handleHideInVault viewingIt chat arm + chat toast copy (V2-04).
- [ ] Boot-restore guard: restored chat id → navigateTo({type:'chat'}) once chats load; unknown ids nulled (V2-02).
- [ ] chatGone flag → Dashboard effect: auto-remove + toast + navigateTo saved (V2-19 shape).
- [ ] useFileOperations: chat-view invalidation hits ['chatFiles'].
- [ ] **Tests (V2-05):** Vitest for the documents-changed chat-id branch (mock invoke/listener: payload folder_id ∈ chatIds → ['chatFiles'] invalidated; folder id → ['files'] only); boot-restore guard logic (restored id matching a chat → chat view; matching nothing → null).
- [ ] Manual QA: open chat → grid + pagination; upload button + drop → lands in chat; delete; move chat→folder; stream a video from a chat; restart app while in a chat view → chat view restores correctly (V2-02 acceptance).
- [ ] npx tsc --noEmit green.

### Task F4: transfer web UI
**Files:** Modify `MoveToFolderModal.tsx`, `ForwardToFolderModal.tsx`.
- [ ] Target lists gain chats (kind icons); **exclude the SOURCE chat from the target list (review2 V2-08: fs.rs:1846's source==target guard returns Ok(true) with no action, so selecting the source would toast "Moved N files." while nothing moved — the modal must hide it structurally, like it hides the active folder today, MoveToFolderModal.tsx:33)**.
- [ ] Dispatch via cmd_move_files / cmd_forward_to_folder with chat ids (zero new backend).
- [ ] **Tests (V2-05):** Vitest for the modal target-list builder (folders + chats, source chat excluded, Saved target present when activeFolderId ≠ null).
- [ ] Manual QA: chat→folder move, folder→chat move, public→chat forward, chat→chat move.
- [ ] npx tsc --noEmit green.

### Task F5: vault UI
**Files:** Modify `VaultContext.tsx`, `VaultView.tsx`.
- [ ] VaultKind 'chat', hiddenChatIds, chat counts/ids in state, applyState purge ['chatFiles'].
- [ ] VaultView third section (D18) + unhide.
- [ ] **Tests (V2-05):** Vitest for VaultContext state mapping (cmd_vault_get_state response with chat fields → hiddenChatIds set, chatCount computed, ['chatFiles'] purged on lock).
- [ ] Manual QA: hide/unhide chat (drag + context menu), locked-global-search concealment, hide-while-viewing jumps to Saved (V2-04 acceptance).
- [ ] npx tsc --noEmit + npx vitest run green.

### Task F6: final gates + manual QA matrix
- [ ] Full gates: npx tsc --noEmit, npx vitest run, cargo check, cargo test.
- [ ] Manual QA matrix (§5) executed; results recorded in qa-results/.

## 5. Manual QA matrix

| # | Do | Expect |
|---|---|---|
| 1 | Open '+' in Chats header | Picker lists eligible dialogs only (no channels/self/[NB]/adopted/forbidden; already-added disabled) |
| 2 | Search picker | Live filter |
| 3 | Add a DM | Row appears; toast; picker row disabled on reopen |
| 4 | Open a chat | FileExplorer grid from history; pagination; empty chat → chat-specific empty state |
| 5 | Upload button in chat view | Uploads to chat (message lands in the Telegram chat; transfer row shows filename as today) |
| 6 | Drag an OS file into the app while in a chat view | Streams direct to the chat (NOT Saved Messages) |
| 7 | Delete a file in chat view | Telegram-native: own message deletes; others' where allowed; refusal = error toast |
| 8 | Stream a video from a chat | Player works (folderId seam mirrors chat id) |
| 9 | Remove chat (hover-X) | Unlist only; Telegram chat untouched |
| 10 | Drag chat to Vault | Hidden; VaultView lists it; unhide restores; locked global search conceals its files |
| 11 | Assign chat to colored group (ChatItem context menu) | Group dot; chip filter shows it under that group; deleting the group clears the assignment |
| 12 | Drag-reorder chats | Order persists across restart |
| 13 | Open dead chat (deleted account / left group) | Auto-remove + toast; navigate home |
| 14 | Move file chat→folder | Forward+delete; file appears in folder; on delete-refusal file remains in source with "Delete original failed" toast |
| 15 | Move file folder→chat and chat→chat | File lands in target |
| 16 | Forward from public channel to chat | File lands in chat |
| 17 | Drop oversize video in chat view | Split flow works (folder_id = chatId end-to-end); discard-job delete-parts works |
| 18 | Collapse sidebar (rail) | Chats '+' renders centered; items render as letter avatars (public-section rail pattern) |
| 19 | Restart app | Chats, order, group assignments, vault state persist; archived chat still opens; app open in a chat view restores THAT view correctly (not a ghost "Folder" view) |
| 20 | Global search while vault locked | No results leak from vaulted chats |
| 21 | Sign out → sign in as another account | No revived chat uploads from the previous account; chat list empty for the new account |
| 22 | Section placement | Chats section sits between Private Channels and Public Channels, with divider (D4) |
| 23 | Never added any chat | Chats section still visible with header + '+' + "No chats added." (D10) |

## 6. Cross-validation ledger

| Item | Original claim | Verified result | Source | Fixed? |
|---|---|---|---|---|
| grammers delete_messages peer-kind routing | Kind-aware | CONFIRMED — Channel→channels::DeleteMessages; User/Chat→messages::DeleteMessages revoke:true | grammers messages.rs:804-827 | — |
| resolve_peer cache arms | Channel+User only | CONFIRMED — Group falls to `_ => None` | utils.rs:38-41 | — |
| upload path seam | resolve_peer → send_message | CONFIRMED | fs.rs:818-820 | — |
| download path seam | resolve_peer(folder_id) | CONFIRMED; works for public channel ids via activeFolderId mirroring | fs.rs:1324, Dashboard.tsx:280-282 | — |
| `cmd_upload_file` shape (v1 plan) | ~500-line monolith needing a clone | FALSIFIED — 12-line wrapper over `upload_file_inner` (fs.rs:686-867) shared with split orchestrator (split_upload.rs:27,1769) | fs.rs:686-694,871-882, split_upload.rs:1769-1777 | v2: no clones; reuse via mirrored ids |
| activeFolderId=null design (v1 plan) | Safe; seam consumers unaffected | FALSIFIED — MediaPlayer/PdfViewer/PreviewModal/FileCard/ArchiveViewer/FastStreamPlayer/useFileDownload all derive the id from activeFolderId ('home' fallback → Saved Messages) | MediaPlayer.tsx:32-35, Dashboard.tsx:1156, useFileOperations.ts:19-93 | v2: mirrored chatId (review F1/F10) |
| dropped-file upload path (v1 plan) | flows through useFileUpload queue | FALSIFIED — stream-direct `/upload-drop` bypasses the queue (useFileUpload.ts:624-639, useDropStreamUpload.ts:228-235) | useFileUpload.ts:633, upload_drop.rs:142,261 | v2: mirrored ids route it correctly (review F8) |
| split_upload.rs:1430 (v1 plan) | part-upload resolve | MISCITE — it's cmd_discard_split_job's delete-parts resolve; part upload is 1769-1777 | split_upload.rs:1398-1475,1769-1777 | v2: no chat_id column needed (review F9) |
| cmd_move_files coverage (v1 plan) | folder→folder only | UNDERSTATED — fully kind-agnostic forward+delete, no InputChannel casts; covers the whole D17 matrix via the seam | fs.rs:1840-1868 | v2: zero new transfer commands (review F5) |
| documents-changed hazard (v1 plan) | payload ambiguity could miss queries | PARTLY FALSE — listener ignores payload, invalidates whole ['files'] prefix (Dashboard.tsx:400-405); real gap is only ['chatFiles'] not being covered | Dashboard.tsx:400-405 | v2: extend listener with payload chat-id check (review F2) |
| TauriCommandPermissions coverage (v1 plan) | only OpenSubtitles commands tested | FALSE — generic tests assert 3-site registration for EVERY command (test:65-91) | TauriCommandPermissions.test.ts:65-91 | v2: no new test (review F26) |
| DialogIter archive coverage | full dialog list | CONFIRMED GAP — hardcoded folder_id: None (main list only); archived chats need cache seeding | grammers dialogs.rs:26, public_channels.rs:561-566 | v2: startup seed (review F4) |
| hidden_ids_if_locked shape | 2-tuple | CONFIRMED + source-scan test pins it | vault.rs:215-241, 647-661 | v2: 3-tuple + test update (review F17) |
| vault reset/wipe/prune | — | CONFIRMED MISSING chat arms | vault.rs:445-446, 462-463, 478-481 | v2: added (review F18) |
| Group assignment UI (v1 plan) | implicit via ChatItem clone | GAP — assignment submenu is SidebarItem-only; PublicChannelItem (the clone source) lacks it | SidebarItem.tsx:328-377, PublicChannelItem.tsx:100-118 | v2: ChatItem gains the submenu (review F20) |
| Adopted-megagroup picker overlap | 'adopted rows' excluded | CONFIRMED + needs raw-channel-id extraction named (megagroups arrive as Peer::Group) | adopted_folders.rs:464-507, 232-236 | v2: named in §0.1 (review F22) |
| Public channels broadcast-only | assumed possible megagroup leak | CONFIRMED STRICT | public_channels.rs:477-480, 263, 283 | — |
| Chat::Forbidden/Empty in picker | not considered | GAP — instant-CHAT_GONE rows | review F23 | v2: excluded |
| cmd_delete_group orphaning | not considered | GAP | folder_groups.rs:102-104 | v2: parallel UPDATE (review F21) |
| EmptyState copy | hardcoded | CONFIRMED — needs title/subtitle props | EmptyState.tsx:51-56 | v2: added (review F29) |
| Listener unsubscribe leak | — | CONFIRMED existing leak; don't clone it | Dashboard.tsx:394-415 | v2: capture unlisten (review F24) |
| Order-merge rule (D12) | unstated | GAP — store array owns order, DB owns membership | useTelegramConnection.ts:359-365 | v2: rule stated (review F25) |
| USER_NOT_PARTICIPANT mapping | not listed | GAP — kicked-from-basic-group error | review F27 | v2: added to CHAT_GONE map |
| vault_sync blob extension | inspect at impl time | CONFIRMED mechanical — all fields #[serde(default)] | vault_sync.rs:20-45 | v2: exact shape specified |
| Baseline gates green | tsc + vitest | CONFIRMED — 1191/1191 | run 2026-08-30 20:14 | — |
| Group::id() returns packed PeerId, not bare id | — | CONFIRMED — cache key must use the raw chat id from `g.raw` | grammers-client/src/types/peer/group.rs:61-71 | §1.4 trap note added |
| grammers d07f96f persists peer hashes to session | — | CONFIRMED — "Cache all PeerMap to Session" commit in the pinned rev; DM resolution survives restarts | Cargo.toml:23-26, git log d07f96f | de-risk note in §1.4 |
| Upload path has NO rights checks | assumed generic | CONFIRMED — no [NB] check, no admin check, no channel-type check on the upload path | fs.rs:686-867, 818-820 | — |
| SidebarItem "no changes" (v2 claim) | assumed vault-drop generic | FALSIFIED — vault Priority-0 arms recognize only folder-reorder + public-channel MIMEs (SidebarItem.tsx:218-231); CHAT_DRAG_MIME needs a new arm + onVaultDropChat prop | SidebarItem.tsx:218-231, Sidebar.tsx:280-281 | v3: SidebarItem added to modified files (review2 V2-01) |
| Boot-restore of chat ids (v2 gap) | unhandled | CONFIRMED GAP — activeView starts 'saved' (Dashboard.tsx:61), persisted activeFolderId restores (useTelegramConnection.ts:41-42), sync effect deps exclude it (Dashboard.tsx:283) → ghost view | Dashboard.tsx:61,283; useTelegramConnection.ts:41-42 | v3: boot-restore guard in F3 (review2 V2-02) |
| TransferPanel target names (v2 task) | assumed extendable | FALSIFIED — rows render filename only (TransferPanel.tsx:345-348); no destination-name mechanism exists | TransferPanel.tsx:345-348 | v3: task cut (review2 V2-03) |
| handleHideInVault chat coverage (v2 gap) | unhandled | CONFIRMED GAP — viewingIt has folder+public arms only | Dashboard.tsx:150-174 | v3: chat arm added (review2 V2-04) |
| Logout hygiene (v2 gap) | unhandled | CONFIRMED GAP — logout deletes api_id/api_hash/folders only; uploadQueue revives unconditionally | useTelegramConnection.ts:223-247, useFileUpload.ts:254-269 | v3: uploadQueue+chats+activeFolderId clears (review2 V2-06) |
| Seeding semantics (v2 contradiction) | "exact pattern" vs "wins its id" | CONTRADICTION RESOLVED — seed_peer_cache is only-if-absent (adopted_folders.rs:169-177); chats seed UNCONDITIONALLY (stored row is the authority) | adopted_folders.rs:169-177 | v3: §1.1 explicit (review2 V2-16) |
| refresh_chat_peer scope (v2 claim) | implied general recovery | OVERSTATED — seam ops bypass it; only cmd_get_chat_files uses it | fs.rs:818,1324,1854-1855 | v3: scope stated (review2 V2-17) |
| Title refresh (v2 claim) | "refreshed lazily on picker re-open" | FALSIFIED — no write path (INSERT OR IGNORE never updates) | §1.1 #3 | v3: claim struck (review2 V2-18) |
| useChatFiles navigation (v2 spec) | "navigate home" from hook | WRONG LAYER — hooks can't navigate; notAMember flag pattern is the established shape | usePublicChannels.ts:90-95 | v3: flag + Dashboard effect (review2 V2-19) |
| Drop on chat items (parent suspicion) | undefined | CONFIRMED undefined — PublicChannelItem has no drop handlers; internal drags ignored document-level | PublicChannelItem.tsx:31-56, Dashboard.tsx:902 | v3: ChatItem gains move-on-drop arm (review2 V2-13) |
| Registration timing (v2 task) | "R1 registers all 7" | BROKEN — commands 6-7 exist only at R3; R1's cargo check would fail | plan §4 R1 | v3: per-task registration (review2 V2-07) |

## 7. Non-goals
See §3.5.

## 8. Review provenance

**Three independent passes over this plan:**

1. **Review 1** (`.hermes/plans/2026-08-30-chats-section-REVIEW.md`): 30 findings on v1 (3 BLOCKER / 8 MAJOR / 13 MINOR / 5 NIT). Its central finding killed v1's `activeFolderId=null` design and recommended the mirrored-id architecture v2 adopted. All BLOCKER/MAJOR claims re-verified from source by the parent (MediaPlayer.tsx:32-35, useFileUpload.ts:633, useDropStreamUpload.ts:228, useFileOperations.ts:19-93, Dashboard.tsx:616-627, grammers dialogs.rs:26, vault.rs:215-241, split_upload.rs:1425-1440/1765-1780).

2. **Review 2** (`.hermes/plans/2026-08-30-chats-section-REVIEW2.md`): 23 findings on v2 (1 BLOCKER / 5 MAJOR / 9 MINOR / 8 NIT), verdict "yes-with-fixes". All six top findings re-verified from source by the parent (SidebarItem.tsx:218-231, useTelegramConnection.ts:41-42/223-247, Dashboard.tsx:61/283/150-174, TransferPanel.tsx:345-348, useFileUpload.ts:254-269). v3 absorbs every finding: V2-01 SidebarItem contradiction, V2-02 boot-restore ghost, V2-03 phantom TransferPanel task (cut), V2-04 hide-in-vault ghost, V2-05 test code per task, V2-06 logout hygiene, plus V2-07/08/09/10/12/13/16/17/18/19/20. Verified-sound by review 2: goBack view restoration, source==target guard, null-check inversion, reset effect, DragDropOverlay label, mobile parity, command-count consistency, zero surviving v1 artifacts.

3. **Backend recon** (full report in delegation cache): independently corroborates the backend section — no hard blockers, user DMs resolve today, Group-arm widening is the single shared-seam fix, grammers d07f96f auto-persists peer hashes, upload path has no rights checks. Contributed: Group::id() packed-PeerId trap (§1.4), chat liveness error signals, session-persistence de-risk note.
