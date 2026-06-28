# Public Channel Browsing — Design Spec

**Date:** 2026-06-28
**Author:** Hermes (via interview with user)
**Status:** Draft — pending user approval

---

## 1. Goal

Allow NoBuf users to browse, download, stream, preview, and forward files from **public Telegram channels** they don't own — alongside their existing [NB] folder system. The feature is **read-only** (no upload/move/rename/delete on public channels) but adds **forward-to-[NB]** as a bridge between public channels and personal storage.

### User Stories

1. **Add by link:** User pastes `t.me/channelname` or `t.me/+abc123` → sees a channel preview → confirms → NoBuf joins the channel → it appears in the sidebar.
2. **Add by browsing joined channels:** User opens the "Add Channel" modal → browses their already-joined channels (search + infinite scroll) → picks one → it appears in the sidebar.
3. **Browse files:** User clicks a public channel in the sidebar → sees the same grid/list file view as [NB] folders, paginated 50 files at a time.
4. **Download/stream/preview:** User downloads, streams video, or previews files exactly like [NB] folder files.
5. **Forward to [NB]:** User multi-selects files → right-click → "Forward to folder" → picks a [NB] folder → files are forwarded server-side via `messages.forwardMessages` → progress bar + success toast.
6. **Remove:** User removes a public channel from NoBuf → prompted "Also leave on Telegram?" → yes/no → channel removed from sidebar, optionally left on Telegram.
7. **Cross-device sync:** Added channels are stored in a hidden `[NB-PUB]` Telegram channel → synced on startup → same channels appear on all devices with the same Telegram account.

---

## 2. Current State (Architecture Baseline)

### Backend (Rust / grammers)

| Component | File | Role |
|---|---|---|
| `resolve_peer()` | `commands/utils.rs:17` | Resolves `folder_id: Option<i64>` → `Peer`. Cache miss → scans `iter_dialogs()`. `None` → Saved Messages (self). |
| `cmd_scan_folders()` | `commands/fs.rs:1422` | Scans all dialogs, finds channels with `[NB]` in title, reconciles with local list. Populates `peer_cache`. |
| `cmd_create_folder()` | `commands/fs.rs:110` | Creates a Telegram channel via `channels::CreateChannel` with `[NB]` suffix in title. |
| `cmd_get_files()` | `commands/fs.rs:1268` | Lists files from a peer via `iter_messages`. Filters for `Media::Document` and `Media::Photo`. No pagination. |
| `cmd_move_files()` | `commands/fs.rs:1238` | Forwards messages to target peer then deletes from source (move = forward + delete). |
| `TelegramState` | `lib.rs` (inferred) | Holds `client: Mutex<Option<Client>>`, `peer_cache: Arc<RwLock<HashMap<i64, Peer>>>`, `download_semaphore`, `rate_limiter`. |
| Folder groups | `commands/folder_groups.rs` | SQLite tables: `groups`, `folder_metadata`. Channel ID → group assignment. |
| Models | `models.rs` | `FolderMetadata { id, parent_id, name }`, `FileMetadata { id, folder_id, name, size, mime_type, file_ext, created_at, icon_type, duration }`, `ScanResult { added, updated, removed, current }`. |

### Frontend (React / TypeScript)

| Component | File | Role |
|---|---|---|
| `Dashboard.tsx` | `src/components/Dashboard.tsx` | Main layout. Manages `activeFolderId: Option<i64>` (null = Saved Messages). Renders Sidebar + FileExplorer. |
| `Sidebar.tsx` | `src/components/dashboard/Sidebar.tsx` | Renders Saved Messages item + [NB] folder list. Folder group tabs at top. Create folder input at bottom. |
| `FolderGroupTabs.tsx` | `src/components/dashboard/FolderGroupTabs.tsx` | Filter chips for folder groups (dnd-kit, wheel scroll). |
| `FileExplorer.tsx` | `src/components/dashboard/FileExplorer.tsx` | Grid/list file view. Receives `files` from parent. |
| `ContextMenu.tsx` | `src/components/dashboard/ContextMenu.tsx` | Right-click menu for files. |
| `MoveToFolderModal.tsx` | `src/components/dashboard/MoveToFolderModal.tsx` | Modal for moving files between [NB] folders. |
| `RemoteUploadModal.tsx` | `src/components/dashboard/RemoteUploadModal.tsx` | Modal for remote upload (URL → Telegram). Reference for modal patterns. |

### Key patterns

- **File filtering:** `cmd_get_files` shows messages where `msg.media()` is `Media::Document` or `Media::Photo`. Everything else is "Unknown" (size 0, no mime). This is the current "what counts as a file" definition.
- **Peer resolution:** All file operations call `resolve_peer(&client, folder_id, &peer_cache)`. `folder_id: None` = Saved Messages.
- **Forwarding:** `client.forward_messages(&target_peer, &message_ids, &source_peer)` — already used in `cmd_move_files`.
- **Semaphore:** ALL `iter_download` loops MUST use `state.download_semaphore.acquire().await` + `yield_now()` (see skill memory).

---

## 3. Decisions

### Decision 1: Public channels are a separate sidebar section, not mixed with [NB] folders

- **Options:** (A) Mixed flat list, (B) Separate section, (C) Separate tab/page, (D) Special group
- **Chosen:** B — Separate section below [NB] folders in the sidebar
- **Why:** User explicitly chose this. Prevents confusion between owned storage and browsable external content. Visually distinct.
- **Trade-off:** Slightly more sidebar complexity. `activeFolderId` needs to distinguish [NB] vs public channels.
- **Reversible?** Yes — UI layout change only.

### Decision 2: Adding a channel requires joining it first (link paste flow)

- **Options:** (A) Browse without joining, (B) Auto-join silently, (C) Confirm prompt then join, (D) Already-joined only
- **Chosen:** C — Show confirmation prompt with channel info preview, then join
- **Why:** User explicitly chose this. Transparent, user controls what they join. Preview reduces accidental joins.
- **Trade-off:** Extra click. But safer and more transparent.
- **Reversible?** Yes — flow can be changed.

### Decision 3: Public channel list is synced via a hidden [NB-PUB] Telegram channel

- **Options:** (A) Local SQLite only, (B) [NB-PUB] hidden channel, (C) Saved Messages
- **Chosen:** B — Auto-created hidden `[NB-PUB]` channel, single JSON message, delete+resend on changes
- **Why:** User wants cross-device sync. Saved Messages would pollute the file list. A hidden channel is clean and follows the existing [NB] pattern.
- **Trade-off:** Extra channel created on user's Telegram account. Must be excluded from `cmd_scan_folders` results.
- **Reversible?** Hard to reverse after deployment (users will have [NB-PUB] channels).

### Decision 4: Forward-to-[NB] uses Telegram's native forwardMessages API (server-side)

- **Options:** (A) Download + re-upload, (B) forwardMessages server-side, (C) Both options
- **Chosen:** B — Direct server-side forward, no local disk involved
- **Why:** Instant, no bandwidth waste, preserves original quality. Already used in `cmd_move_files`.
- **Trade-off:** Can't transform/rename during forward. But user doesn't need that.
- **Reversible?** Yes.

### Decision 5: File listing for public channels uses the same filter as [NB] folders

- **Options:** (A) Documents/videos/audio only, (B) All media, (C) Same as [NB]
- **Chosen:** C — Same `Media::Document` + `Media::Photo` filter as `cmd_get_files`
- **Why:** User chose "same as current NoBuf". Consistent experience.
- **Trade-off:** May show "Unknown" entries for unusual media types. Same as current behavior.
- **Reversible?** Yes.

### Decision 6: Pagination — 50 files per page with infinite scroll

- **Options:** (A) 50 per page, (B) All at once, (C) Auto-detect
- **Chosen:** A — Always paginated, 50 files at a time, infinite scroll
- **Why:** Public channels can have thousands of messages. User explicitly chose this.
- **Trade-off:** More API calls. But `iter_messages` supports `limit` and `offset_id` natively.
- **Reversible?** Yes.

### Decision 7: [NB-PUB] sync channel is created lazily (on first add), not on startup

- **Options:** (A) Create on startup, (B) Create on first add, (C) Create on first add but check on startup
- **Chosen:** B — Create only when user adds their first public channel. On startup, if [NB-PUB] exists, sync from it; if not, treat as empty.
- **Why:** User explicitly chose this. Avoids creating unnecessary channels for users who don't use the feature.
- **Trade-off:** First add is slightly slower (channel creation + sync message). Subsequent adds are fast.
- **Reversible?** Yes.

### Decision 8: Restricted-content channels are browsed anyway, errors shown per-file

- **Options:** (A) Skip restricted channels, (B) Browse + per-file errors, (C) Browse + warning badge
- **Chosen:** B — Browse anyway, show error per-file if download/stream fails
- **Why:** User chose this. Listing works even on restricted channels; only download/save is blocked.
- **Trade-off:** User might see files they can't download. But that's transparent.
- **Reversible?** Yes.

### Decision 9: Only channel-type dialogs, no groups/DMs/bots

- **Options:** (A) Channels only, (B) Channels + supergroups, (C) Any dialog
- **Chosen:** A — Strictly `Peer::Channel` with `broadcast: true` (not megagroup)
- **Why:** User explicitly chose channels only. Groups have different permission models.
- **Trade-off:** Users can't browse files from groups. But matches the feature name ("public channels").
- **Reversible?** Yes — can be relaxed later.

---

## 4. Architecture

### 4.1 Data Model

#### New SQLite table: `public_channels`

```sql
CREATE TABLE IF NOT EXISTS public_channels (
    channel_id   INTEGER PRIMARY KEY,    -- Telegram channel ID
    name         TEXT NOT NULL,          -- Display name (channel title)
    username     TEXT,                   -- @username (NULL for private)
    access_hash  INTEGER NOT NULL,       -- Required for InputPeer
    is_private   INTEGER NOT NULL DEFAULT 0,  -- 1 = joined via invite link
    added_at     INTEGER NOT NULL,       -- Unix timestamp
    last_synced  INTEGER,                -- Last successful sync timestamp
    is_member    INTEGER NOT NULL DEFAULT 1  -- 1 = still a member, 0 = kicked/left
);
```

This table is separate from `folder_metadata` to keep [NB] folders and public channels isolated.

#### [NB-PUB] sync channel message format

Single JSON text message in the [NB-PUB] channel:

```json
{
  "version": 1,
  "channels": [
    {
      "channel_id": 1234567890,
      "name": "Awesome Channel",
      "username": "awesome_channel",
      "access_hash": 9876543210,
      "is_private": false,
      "added_at": 1719600000
    }
  ]
}
```

**Critical: Message size limit.** Telegram text messages are limited to ~4096 characters. A JSON with 50+ channels will exceed this. **Solution:** Use `messages.sendMedia` to upload a JSON **file** (e.g., `nb_pub_sync.json`) to the [NB-PUB] channel instead of a text message. This allows up to 2GB. On sync: download the JSON file, parse it. On update: delete old file message, upload new JSON file.

On every add/remove: delete the old message, send a new one. The sync message ID is stored locally in SQLite (`nb_pub_message_id` in a `settings` table or similar) to find and delete it on next change.

### 4.2 Backend Commands (Rust)

New file: `app/src-tauri/src/commands/public_channels.rs`

| Command | Purpose | Key API Calls |
|---|---|---|
| `cmd_resolve_channel_link` | Parse link → resolve to channel info (preview before join) | `ResolveUsername` or `CheckChatInvite` |
| `cmd_join_channel_by_link` | Join channel from link, add to local DB + sync | `JoinChannel` or `ImportChatInvite` |
| `cmd_add_joined_channel` | Add an already-joined channel to NoBuf | DB insert + sync |
| `cmd_list_joined_channels` | List user's joined channels for browse modal | `iter_dialogs()` filtered to channels |
| `cmd_get_public_channels` | Get NoBuf's added public channels from local DB | SQLite SELECT |
| `cmd_get_public_channel_files` | List files from a public channel (paginated) | `iter_messages` with `limit` + `offset_id` |
| `cmd_remove_public_channel` | Remove from NoBuf (+ optionally leave on Telegram) | `LeaveChannel` + DB delete + sync |
| `cmd_forward_to_folder` | Forward files from public channel to [NB] folder | `forward_messages` (no delete source) |
| `cmd_sync_public_channels` | Sync from [NB-PUB] on startup | Read [NB-PUB] message, reconcile DB |
| `cmd_create_nb_pub_channel` | Create the [NB-PUB] sync channel | `CreateChannel` with title `[NB-PUB]` |
| `cmd_update_nb_pub_sync` | Update the sync message after add/remove | Delete old + send new JSON message |

#### Key API patterns (to be verified by subagent):

```rust
// 1. Resolve username → channel info
let result = client.invoke(&tl::functions::contacts::ResolveUsername {
    username: "channelname".to_string(),
}).await?;
// Returns ResolvedPeer with Peer::Channel

// 2. Join public channel
let result = client.invoke(&tl::functions::channels::JoinChannel {
    channel: tl::enums::InputChannel::Channel(tl::types::InputChannel {
        channel_id, access_hash,
    }),
}).await?;

// 3. Join via invite link (private channel)
let result = client.invoke(&tl::functions::messages::ImportChatInvite {
    hash: "abc123...".to_string(),  // extracted from t.me/+abc123
}).await?;

// 4. Check invite link (preview before joining private)
let result = client.invoke(&tl::functions::messages::CheckChatInvite {
    hash: "abc123...".to_string(),
}).await?;
// Returns ChatInvite::ChatInvite (preview) or ChatInvite::ChatInviteAlready (already joined)

// 5. Leave channel
let result = client.invoke(&tl::functions::channels::LeaveChannel {
    channel: tl::enums::InputChannel::Channel(tl::types::InputChannel {
        channel_id, access_hash,
    }),
}).await?;

// 6. Forward messages (no delete — unlike cmd_move_files)
client.forward_messages(&target_peer, &message_ids, &source_peer).await?;

// 7. Paginated file listing
let mut msgs = client.iter_messages(&peer)
    .limit(50);
// For next page: .add_offset(0).max_id(last_msg_id)
```

#### Peer resolution for public channels

`resolve_peer()` currently scans `iter_dialogs()` which only includes joined chats. For public channels that the user just joined, they'll be in the dialog list. But for the initial preview (before joining), we need `ResolveUsername`.

A new function `resolve_channel_by_link()` will handle:
- `t.me/channelname` → extract username → `ResolveUsername`
- `t.me/+abc123` → extract hash → `CheckChatInvite` (for preview)
- `t.me/c/1234567` → private channel link without invite → not joinable, show error

### 4.3 Frontend Components

#### New components:

| Component | Purpose |
|---|---|
| `AddChannelModal.tsx` | Tabbed modal: "Paste Link" tab + "Browse Joined" tab. Replace text "New Channel" with "New Public Channel" |
| `ChannelPreviewCard.tsx` | Shows channel name, description, subscriber count before joining |
| `PublicChannelSidebarSection.tsx` | Sidebar section below [NB] folders with public channel list + "+" button |
| `PublicChannelItem.tsx` | Sidebar item for a public channel (similar to SidebarItem but with distinct icon) |
| `ForwardToFolderModal.tsx` | Modal for selecting target [NB] folder when forwarding |

#### Modified components:

| Component | Changes |
|---|---|
| `Sidebar.tsx` | Add "Public Channels" section below [NB] folder list. New section has its own "+" button and scrollable list. |
| `Dashboard.tsx` | `activeFolderId` needs to distinguish [NB] vs public. New state: `activeChannelType: 'folder' \| 'public' \| 'saved'`. File fetching logic branches on this. |
| `ContextMenu.tsx` | Add "Forward to folder..." option. Only visible when `activeChannelType === 'public'`. |
| `FileExplorer.tsx` | Add read-only banner when viewing a public channel. Disable upload/drop for public channels. |
| `useTelegramConnection.ts` | Call `cmd_sync_public_channels` on startup after login. |

#### State management:

```typescript
// Dashboard.tsx
type ActiveView =
    | { type: 'saved' }                    // Saved Messages
    | { type: 'folder'; folderId: i64 }    // [NB] folder
    | { type: 'public'; channelId: i64 };  // Public channel

const [activeView, setActiveView] = useState<ActiveView>({ type: 'saved' });
```

This replaces the current `activeFolderId: Option<i64>` with a discriminated union that cleanly separates the three view types.

#### File fetching:

```typescript
// When activeView.type === 'public', use paginated public channel files
// When activeView.type === 'folder' or 'saved', use existing cmd_get_files
```

### 4.4 Error Handling

| Scenario | Error Message | UX |
|---|---|---|
| Invalid link format | "Invalid Telegram link. Use t.me/channelname or t.me/+invitehash" | Toast error |
| Channel not found | "Channel not found. It may have been deleted or the username changed." | Toast error |
| Private channel + invite expired | "This invite link has expired or been revoked." | Toast error |
| Already joined | "You're already a member of this channel." + offer to add to NoBuf | Toast info |
| Already added to NoBuf | "This channel is already added to NoBuf." | Toast info |
| Rate limited (FLOOD_WAIT) | "Telegram is rate limiting. Please wait {N} seconds." | Toast warning |
| Kicked/banned from channel | "You've been removed from this channel." + mark as not-a-member | Toast error + sidebar badge |
| Channel deleted | "This channel no longer exists." + mark as not-a-member | Toast error + sidebar badge |
| Restricted content download | "This channel restricts saving content. Download may fail." | Per-file error toast |
| [NB-PUB] sync conflict | Last-write-wins (highest message ID wins) | Silent reconciliation |
| Join channel fails (banned) | "Cannot join: you are banned from this channel." | Toast error |

### 4.5 [NB-PUB] Sync Protocol

1. **On startup** (`cmd_sync_public_channels`):
   - Scan dialogs for `[NB-PUB]` channel (by title match).
   - If found: read the latest message → parse JSON → reconcile with local SQLite.
   - If not found: do nothing (lazy creation on first add).
   - If found but empty (no messages): treat as empty list.
   - Exclude `[NB-PUB]` from `cmd_scan_folders` results (filter by title).

2. **On add** (`cmd_join_channel_by_link` / `cmd_add_joined_channel`):
   - Insert into local SQLite.
   - If [NB-PUB] doesn't exist yet: create it (`channels::CreateChannel` with title `[NB-PUB]`).
   - If [NB-PUB] exists but has no sync message: send initial JSON.
   - If [NB-PUB] exists with a sync message: delete old message, send new JSON with updated list.
   - Store the sync message ID locally for future deletions.

3. **On remove** (`cmd_remove_public_channel`):
   - Delete from local SQLite.
   - Update sync message (delete old + send new).
   - Optionally leave channel on Telegram (`LeaveChannel`).

4. **On startup reconciliation**:
   - Compare local DB with [NB-PUB] JSON.
   - Channels in JSON but not local → add to local.
   - Channels in local but not JSON → remove from local (another device removed them).
   - Last-write-wins: the [NB-PUB] message is the source of truth.

### 4.6 "No longer a member" state

When a user clicks a public channel in the sidebar that they've been kicked from, left, or that was deleted:

- `cmd_get_public_channel_files` will fail with a peer resolution error.
- The frontend should catch this and show an empty-state message: "You're no longer a member of this channel. Click to remove it from NoBuf."
- The sidebar item should show a red dot or "!" badge to indicate the channel is inaccessible.
- A "Remove" button should be offered in the empty state.

### 4.7 Access hash persistence

`resolve_peer()` caches peers in memory (`peer_cache`), which is cleared on logout/restart. Public channels need persistent `access_hash` in SQLite to reconstruct `InputPeer::Channel` without re-scanning all dialogs.

On every add/join: store `access_hash` in the `public_channels` table. On file operations: construct `InputPeer::Channel` from the stored `channel_id` + `access_hash`, bypassing `resolve_peer` for public channels. If the stored `access_hash` is stale (Telegram returns `CHANNEL_PRIVATE`), fall back to `iter_dialogs` to re-resolve, or `ResolveUsername` if a username is available.

### 4.8 Browse joined channels modal — deduplication

The "Browse Joined" tab in the AddChannelModal should:
- Exclude channels already tagged `[NB]` (they're already NoBuf folders).
- Exclude channels already added as public channels in NoBuf (show them greyed out with "Already added" label instead of hiding them, so the user knows they already have it).
- Show "Already added as NoBuf folder" label for [NB] channels (greyed out, not clickable).

### 4.9 [NB-PUB] Channel Exclusion

`cmd_scan_folders` currently matches `[NB]` in title (case-insensitive). `[NB-PUB]` contains `[NB]` so it would match. Fix:

```rust
// In cmd_scan_folders, add exclusion:
if title.to_lowercase().contains("[nb]") && !title.to_lowercase().contains("[nb-pub]") {
    // ... treat as [NB] folder
}
// OR: check exact tag
if title.trim_end().to_lowercase() == "[nb]" || title.to_lowercase().contains(" [nb]") {
    // ... but NOT [nb-pub]
}
```

The exact exclusion logic needs to be precise — `[NB-PUB]` must NOT match the folder scan, but `[NB]` and `My Folder [NB]` must still match.

---

## 5. Implementation Phases

### Phase 1: Backend Foundation (Rust)
**Independently testable — no UI changes.**

- Create `commands/public_channels.rs` with all Tauri commands.
- Add `public_channels` SQLite table to `folder_groups.rs` (or a new migration).
- Implement `cmd_resolve_channel_link` (parse link + ResolveUsername/CheckChatInvite).
- Implement `cmd_join_channel_by_link` (JoinChannel/ImportChatInvite + DB insert).
- Implement `cmd_list_joined_channels` (iter_dialogs filtered to channels).
- Implement `cmd_add_joined_channel` (DB insert for already-joined).
- Implement `cmd_get_public_channels` (SQLite SELECT).
- Implement `cmd_get_public_channel_files` (paginated iter_messages).
- Implement `cmd_remove_public_channel` (DB delete + optional LeaveChannel).
- Implement `cmd_forward_to_folder` (forward_messages without delete).
- Register all commands in `lib.rs` invoke_handler.
- **Test:** `cargo check` + `cargo test`. Manual test via Tauri console.

### Phase 2: [NB-PUB] Sync System (Rust)
**Depends on Phase 1.**

- Implement `cmd_create_nb_pub_channel` (CreateChannel with [NB-PUB] title).
- Implement `cmd_update_nb_pub_sync` (delete old message + send new JSON).
- Implement `cmd_sync_public_channels` (read [NB-PUB] message + reconcile).
- Add [NB-PUB] exclusion to `cmd_scan_folders`.
- Hook `cmd_sync_public_channels` into startup flow.
- **Test:** Add channel on instance A → verify [NB-PUB] message → start instance B → verify sync.

### Phase 3: Frontend — Sidebar + Add Modal
**Depends on Phase 1 + 2.**

- Create `AddChannelModal.tsx` (tabbed: Paste Link + Browse Joined).
- Create `ChannelPreviewCard.tsx`.
- Create `PublicChannelSidebarSection.tsx` + `PublicChannelItem.tsx`.
- Modify `Sidebar.tsx` to add Public Channels section.
- Modify `Dashboard.tsx` to use `ActiveView` discriminated union.
- Wire up `cmd_sync_public_channels` on startup.
- **Test:** `tsc --noEmit` + visual test. Add channel via link → appears in sidebar. Add via browse → appears in sidebar.

### Phase 4: Frontend — File Browsing + Read-Only Mode
**Depends on Phase 3.**

- Modify file fetching to use `cmd_get_public_channel_files` when `activeView.type === 'public'`.
- Implement infinite scroll pagination (50 files, load more on scroll).
- Add read-only banner to `FileExplorer.tsx`.
- Disable upload/drop/move/rename/delete for public channels.
- **Test:** Browse a public channel → see files → verify pagination → verify read-only restrictions.

### Phase 5: Frontend — Forward to [NB] + Remove
**Depends on Phase 4.**

- Create `ForwardToFolderModal.tsx`.
- Add "Forward to folder..." to `ContextMenu.tsx` (multi-select).
- Implement progress bar + success toast for forward operations.
- Implement remove flow with "Also leave on Telegram?" prompt.
- Implement "not a member" badge on sidebar items.
- **Test:** Select files → forward to [NB] folder → verify in [NB] folder. Remove channel → verify sidebar update.

### Phase 6: Edge Cases + Polish
**Depends on Phase 5.**

- Handle restricted-content channels (per-file errors).
- Handle kicked/banned/deleted channels (sidebar badge + toast).
- Handle deduplication (already added → show info).
- Handle link format variations (`t.me/c/123`, `t.me/s/channelname`, `@channelname`).
- Handle FLOOD_WAIT on all new API calls.
- Error-specific toast messages (Phase 4.4 table).
- **Test:** Full end-to-end testing of all error scenarios.

---

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `ResolveUsername` rate limited | Medium — affects add-by-link | Add retry + backoff. Cache resolved peers. |
| [NB-PUB] channel created on user's account without consent | Medium — user sees new channel in Telegram | Create lazily (only on first add). Channel title `[NB-PUB]` is distinctive. Document in About page. |
| `iter_messages` on large channels is slow | Medium — UX lag on first browse | Paginate 50 at a time. Show loading spinner. Use `InputMessagesFilterDocument` for faster media-only search. |
| Restricted content channels fail on download | Low — per-file error | Show per-file error toast. List still works. |
| [NB-PUB] sync message grows too large | Low — JSON is compact | Even 1000 channels = ~100KB JSON. Well within Telegram's 4096 char message limit... wait, this is a problem. |
| **[NB-PUB] message size limit** | **High** — Telegram text messages are limited to ~4096 chars. A JSON with many channels could exceed this. | Use `messages.sendMedia` with a JSON file attachment instead of text. Or split into multiple messages (chunks). Or use a JSON document upload. |
| `access_hash` becomes stale | Low — cached peers | Re-resolve via `ResolveUsername` or `iter_dialogs` on failure. |
| User leaves [NB-PUB] channel manually on Telegram | Low — sync stops working | Detect on startup (channel not found in dialog scan). Recreate if needed. |

### Critical: [NB-PUB] message size

Telegram text messages have a **~4096 character limit**. A JSON with 50 channels (each ~150 chars) = ~7500 chars → exceeds the limit.

**Solution:** Use `messages.sendMedia` to upload a JSON **file** (e.g., `nb_pub_sync.json`) to the [NB-PUB] channel instead of a text message. This allows up to 2GB. Delete the old file message + send a new one on each change.

This changes the sync protocol:
- Sync message is a **document message** (JSON file), not a text message.
- On sync: download the JSON file, parse it, reconcile.
- On update: delete old file message, upload new JSON file.

---

## 7. Out of Scope

- Browsing groups (supergroups) — channels only.
- Browsing without joining — all channels require membership.
- Download + re-upload for forwarding — only server-side forward.
- Global public channel search/discovery — user must know the link or pick from joined channels.
- Re-encoding or transformation during forward.
- Public channel file caching on local disk — same streaming/download as [NB] folders, no special caching.
- Notifications for new messages in public channels.
- Public channel analytics/statistics.
- Managing public channel settings (notifications, mute, etc.) from NoBuf.
