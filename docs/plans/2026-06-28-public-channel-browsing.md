# Public Channel Browsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow NoBuf users to browse, download, stream, preview, and forward files from public Telegram channels they don't own, with cross-device sync via a hidden [NB-PUB] channel.

**Architecture:** New `public_channels` SQLite table + new `commands/public_channels.rs` Rust module with 12 Tauri commands. Frontend gets a new `ActiveView` discriminated union replacing `activeFolderId`, a separate "Public Channels" sidebar section, an `AddChannelModal` with link-paste and browse-joined tabs, paginated file browsing (50 files/page), read-only restrictions, and a "Forward to [NB] folder" context-menu action. Cross-device sync via a hidden `[NB-PUB]` Telegram channel storing a JSON file.

**Tech Stack:** Rust + Tauri 2.x + grammers-client (MTProto) + SQLite (sqlite crate v0.37) + React 19 + TypeScript + @tanstack/react-query + sonner (toasts) + framer-motion

**Design Spec:** `docs/specs/2026-06-28-public-channel-browsing-design.md`

---

## File Structure

### New Files — Backend (Rust)

| File | Responsibility |
|---|---|
| `app/src-tauri/src/commands/public_channels.rs` | All public channel Tauri commands: resolve, join, list, browse, forward, remove, sync |

### New Files — Frontend (React/TypeScript)

| File | Responsibility |
|---|---|
| `app/src/components/dashboard/AddChannelModal.tsx` | Tabbed modal: "Paste Link" tab + "Browse Joined" tab |
| `app/src/components/dashboard/ChannelPreviewCard.tsx` | Channel info preview before joining (name, about, subscribers) |
| `app/src/components/dashboard/PublicChannelSidebarSection.tsx` | Sidebar section below [NB] folders with public channel list + "+" button |
| `app/src/components/dashboard/PublicChannelItem.tsx` | Sidebar item for a public channel (distinct icon, red badge if not-a-member) |
| `app/src/components/dashboard/ForwardToFolderModal.tsx` | Modal for selecting target [NB] folder when forwarding files |
| `app/src/hooks/usePublicChannels.ts` | React Query hooks for public channels: list, add, remove, files, sync |

### Modified Files — Backend

| File | Changes |
|---|---|
| `app/src-tauri/src/commands/mod.rs` | Add `pub mod public_channels;` + `pub use public_channels::*;` |
| `app/src-tauri/src/lib.rs` | Register 12 new commands in `invoke_handler` |
| `app/src-tauri/src/commands/fs.rs` | Add [NB-PUB] exclusion to `cmd_scan_folders` (line ~1448) |
| `app/src-tauri/src/models.rs` | Add `PublicChannel` and `ChannelPreview` structs |

### Modified Files — Frontend

| File | Changes |
|---|---|
| `app/src/types.ts` | Add `PublicChannel`, `ChannelInfo`, `JoinedChannel` interfaces |
| `app/src/components/Dashboard.tsx` | Replace `activeFolderId` with `ActiveView` union; branch file fetching; render PublicChannelSidebarSection; pass readOnly flag to FileExplorer |
| `app/src/components/dashboard/Sidebar.tsx` | Render `PublicChannelSidebarSection` below [NB] folder list |
| `app/src/components/dashboard/FileExplorer.tsx` | Show read-only banner when `readOnly=true`; disable drag-drop upload |
| `app/src/components/dashboard/ContextMenu.tsx` | Add "Forward to folder…" option (visible only for public channels) |
| `app/src/hooks/useTelegramConnection.ts` | Call `cmd_sync_public_channels` on startup after auto-sync |

---

## Phase 1: Backend Foundation — Rust Commands + SQLite

### Task 1: Create `public_channels.rs` module skeleton + models

**Files:**
- Create: `app/src-tauri/src/commands/public_channels.rs`
- Modify: `app/src-tauri/src/commands/mod.rs`
- Modify: `app/src-tauri/src/models.rs`

- [ ] **Step 1: Add models to `models.rs`**

Open `app/src-tauri/src/models.rs` and append after the `Drive` struct (line 61):

```rust
/// A public Telegram channel added to NoBuf for read-only browsing.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PublicChannel {
    pub channel_id: i64,
    pub name: String,
    pub username: Option<String>,
    pub access_hash: i64,
    pub is_private: bool,
    pub added_at: i64,
    pub is_member: bool,
}

/// Preview info for a channel before joining (from ResolveUsername or CheckChatInvite).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChannelPreview {
    pub title: String,
    pub about: Option<String>,
    pub participants_count: i32,
    pub is_channel: bool,
    pub is_private: bool,
    pub already_joined: bool,
    pub channel_id: Option<i64>,
    pub access_hash: Option<i64>,
    pub username: Option<String>,
}

/// A joined channel entry for the browse-joined modal.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JoinedChannel {
    pub channel_id: i64,
    pub name: String,
    pub username: Option<String>,
    pub access_hash: i64,
    pub already_added: bool,
    pub is_nb_folder: bool,
}

/// Result of forwarding files to a [NB] folder.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ForwardResult {
    pub success: bool,
    pub forwarded_count: i32,
    pub errors: Vec<String>,
}
```

- [ ] **Step 2: Create `public_channels.rs` with SQLite setup**

Create `app/src-tauri/src/commands/public_channels.rs`:

```rust
use grammers_client::Client;
use grammers_client::types::Peer;
use tauri::{State, AppHandle, Manager};
use serde::{Deserialize, Serialize};
use sqlite::{Connection, Value};
use std::path::PathBuf;
use crate::commands::TelegramState;
use crate::commands::utils::map_error;
use crate::models::{PublicChannel, ChannelPreview, JoinedChannel, ForwardResult, FileMetadata};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

// ─── SQLite helpers ──────────────────────────────────────────────

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("nobuf_groups.db"))
}

fn get_connection(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute("CREATE TABLE IF NOT EXISTS public_channels (
        channel_id   INTEGER PRIMARY KEY,
        name         TEXT NOT NULL,
        username     TEXT,
        access_hash  INTEGER NOT NULL,
        is_private   INTEGER NOT NULL DEFAULT 0,
        added_at     INTEGER NOT NULL,
        is_member    INTEGER NOT NULL DEFAULT 1
    )").map_err(|e| e.to_string())?;
    conn.execute("CREATE TABLE IF NOT EXISTS nb_pub_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )").map_err(|e| e.to_string())?;
    Ok(conn)
}

fn vi(v: &Value) -> i64 {
    match v { Value::Integer(i) => *i, _ => 0 }
}

fn vs(v: &Value) -> String {
    match v { Value::String(s) => s.clone(), _ => String::new() }
}

fn vb(v: &Value) -> bool {
    match v { Value::Integer(i) => *i != 0, _ => false }
}

fn row_to_public_channel(row: &[Value]) -> PublicChannel {
    PublicChannel {
        channel_id: vi(&row[0]),
        name: vs(&row[1]),
        username: if vs(&row[2]).is_empty() { None } else { Some(vs(&row[2])) },
        access_hash: vi(&row[3]),
        is_private: vb(&row[4]),
        added_at: vi(&row[5]),
        is_member: vb(&row[6]),
    }
}

// ─── Link parsing ────────────────────────────────────────────────

/// Parse a Telegram link into a normalized form.
/// Returns Ok((kind, value)) where kind is "username" or "invite_hash".
/// Returns Err for invalid links.
pub fn parse_channel_link(link: &str) -> Result<(String, String), String> {
    let link = link.trim();
    
    // Handle @username format
    if link.starts_with('@') {
        let username = link[1..].to_string();
        if username.is_empty() {
            return Err("Empty username".to_string());
        }
        return Ok(("username".to_string(), username));
    }
    
    // Handle t.me/ links
    let stripped = if link.starts_with("https://t.me/") {
        &link["https://t.me/".len()..]
    } else if link.starts_with("http://t.me/") {
        &link["http://t.me/".len()..]
    } else if link.starts_with("t.me/") {
        &link["t.me/".len()..]
    } else {
        return Err("Invalid Telegram link. Use t.me/channelname, t.me/+invitehash, or @channelname".to_string());
    };
    
    // Remove query params and fragments
    let path = stripped.split('?').next().unwrap_or(stripped).split('#').next().unwrap_or(stripped);
    
    if path.starts_with('+') {
        // Private invite link: t.me/+abc123
        let hash = path[1..].to_string();
        if hash.is_empty() {
            return Err("Empty invite hash".to_string());
        }
        return Ok(("invite_hash".to_string(), hash));
    }
    
    if path.starts_with("c/") {
        // Private channel link: t.me/c/1234567 — not joinable via link
        return Err("Private channel links (t.me/c/...) require an invite link to join. Ask the channel admin for a t.me/+... invite link.".to_string());
    }
    
    if path.starts_with("s/") {
        // t.me/s/channelname — public channel preview, strip the s/
        let username = path["s/".len()..].to_string();
        if username.is_empty() {
            return Err("Empty username".to_string());
        }
        return Ok(("username".to_string(), username));
    }
    
    // Public channel: t.me/channelname
    let username = path.to_string();
    if username.is_empty() {
        return Err("Empty username".to_string());
    }
    // Validate: usernames are 5-32 chars, alphanumeric + underscores
    if !username.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err("Invalid username format".to_string());
    }
    Ok(("username".to_string(), username))
}

// ─── Peer construction from stored access_hash ───────────────────

/// Build an InputPeer::Channel from stored channel_id + access_hash.
/// This bypasses resolve_peer (which scans dialogs) for O(1) peer access.
fn build_input_peer(channel_id: i64, access_hash: i64) -> grammers_tl_types::enums::InputPeer {
    grammers_tl_types::enums::InputPeer::Channel(
        grammers_tl_types::types::InputPeerChannel {
            channel_id,
            access_hash,
        }
    )
}

fn build_input_channel(channel_id: i64, access_hash: i64) -> grammers_tl_types::enums::InputChannel {
    grammers_tl_types::enums::InputChannel::Channel(
        grammers_tl_types::types::InputChannel {
            channel_id,
            access_hash,
        }
    )
}

// ─── Duration extraction (shared with fs.rs) ─────────────────────

fn extract_duration_from_doc(doc: &grammers_tl_types::enums::Document) -> Option<f64> {
    if let grammers_tl_types::enums::Document::Document(d) = doc {
        for attr in &d.attributes {
            match attr {
                grammers_tl_types::enums::DocumentAttribute::Video(v) => return Some(v.duration),
                grammers_tl_types::enums::DocumentAttribute::Audio(a) => return Some(a.duration as f64),
                _ => {}
            }
        }
    }
    None
}

// Placeholder — commands will be added in subsequent tasks
```

- [ ] **Step 3: Register module in `mod.rs`**

Open `app/src-tauri/src/commands/mod.rs`. After line 92 (`pub mod folder_groups;`), add:

```rust
pub mod public_channels;
```

After line 102 (`pub use folder_groups::*;`), add:

```rust
pub use public_channels::*;
```

- [ ] **Step 4: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -5`
Expected: `Finished` with no errors. Warnings about unused functions are OK.

- [ ] **Step 5: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs app/src-tauri/src/commands/mod.rs app/src-tauri/src/models.rs
git commit -m "feat: add public_channels module skeleton + models"
```

---

### Task 2: `cmd_resolve_channel_link` — preview a channel before joining

**Files:**
- Modify: `app/src-tauri/src/commands/public_channels.rs`

This command takes a link, parses it, resolves it via `ResolveUsername` or `CheckChatInvite`, and returns a `ChannelPreview` without joining.

- [ ] **Step 1: Add the command to `public_channels.rs`**

Append to `public_channels.rs` (replace the placeholder comment at the end):

```rust
#[tauri::command]
pub async fn cmd_resolve_channel_link(
    link: String,
    state: State<'_, TelegramState>,
) -> Result<ChannelPreview, String> {
    let (kind, value) = parse_channel_link(&link)?;
    
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;
    
    match kind.as_str() {
        "username" => {
            // Resolve public channel by username
            let result = client.invoke(&grammers_tl_types::functions::contacts::ResolveUsername {
                username: value.clone(),
                referer: None,
            }).await.map_err(map_error)?;
            
            // Find the channel in the chats list
            let mut found_channel: Option<(i64, i64, String)> = None;
            for chat in &result.chats {
                if let grammers_tl_types::enums::Chat::Channel(c) = chat {
                    // Verify it's a channel (broadcast), not a megagroup
                    if c.broadcast {
                        found_channel = Some((
                            c.id,
                            c.access_hash.unwrap_or(0),
                            c.title.clone(),
                        ));
                    }
                }
            }
            
            let (channel_id, access_hash, title) = found_channel
                .ok_or("No channel found with this username. It may be a group, not a channel.")?;
            
            // Check if already joined by looking at the peer
            let already_joined = result.peer == grammers_tl_types::enums::Peer::Channel(
                grammers_tl_types::types::PeerChannel { channel_id }
            ) || result.peer == grammers_tl_types::enums::Peer::Empty;
            
            Ok(ChannelPreview {
                title,
                about: None, // ResolveUsername doesn't return about
                participants_count: 0, // Not available from ResolveUsername
                is_channel: true,
                is_private: false,
                already_joined,
                channel_id: Some(channel_id),
                access_hash: Some(access_hash),
                username: Some(value),
            })
        }
        "invite_hash" => {
            // Check private channel invite
            let result = client.invoke(&grammers_tl_types::functions::messages::CheckChatInvite {
                hash: value,
            }).await.map_err(map_error)?;
            
            match result {
                grammers_tl_types::enums::ChatInvite::ChatInvite(invite) => {
                    Ok(ChannelPreview {
                        title: invite.title,
                        about: invite.about,
                        participants_count: invite.participants_count,
                        is_channel: invite.channel,
                        is_private: true,
                        already_joined: false,
                        channel_id: None,
                        access_hash: None,
                        username: None,
                    })
                }
                grammers_tl_types::enums::ChatInvite::ChatInviteAlready(already) => {
                    // Already joined — extract channel info
                    if let grammers_tl_types::enums::Chat::Channel(c) = &already.chat {
                        Ok(ChannelPreview {
                            title: c.title.clone(),
                            about: None,
                            participants_count: 0,
                            is_channel: c.broadcast,
                            is_private: true,
                            already_joined: true,
                            channel_id: Some(c.id),
                            access_hash: c.access_hash,
                            username: None,
                        })
                    } else {
                        Err("Already joined but not a channel".to_string())
                    }
                }
            }
        }
        _ => Err("Unknown link type".to_string()),
    }
}
```

- [ ] **Step 2: Register in `lib.rs`**

Open `app/src-tauri/src/lib.rs`. In the `generate_handler!` list, after `commands::cmd_open_url,` (line 448), add:

```rust
            commands::cmd_resolve_channel_link,
```

- [ ] **Step 3: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -5`
Expected: `Finished` with no errors.

- [ ] **Step 4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs app/src-tauri/src/lib.rs
git commit -m "feat: add cmd_resolve_channel_link for channel preview"
```

---

### Task 3: `cmd_join_channel_by_link` — join + add to DB

**Files:**
- Modify: `app/src-tauri/src/commands/public_channels.rs`
- Modify: `app/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the join command**

Append to `public_channels.rs`:

```rust
#[tauri::command]
pub async fn cmd_join_channel_by_link(
    link: String,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<PublicChannel, String> {
    let (kind, value) = parse_channel_link(&link)?;
    
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;
    
    let (channel_id, access_hash, title, username, is_private) = match kind.as_str() {
        "username" => {
            // Join public channel via channels::JoinChannel
            // First resolve to get access_hash
            let resolved = client.invoke(&grammers_tl_types::functions::contacts::ResolveUsername {
                username: value.clone(),
                referer: None,
            }).await.map_err(map_error)?;
            
            let mut found: Option<(i64, i64, String)> = None;
            for chat in &resolved.chats {
                if let grammers_tl_types::enums::Chat::Channel(c) = chat {
                    if c.broadcast {
                        found = Some((c.id, c.access_hash.unwrap_or(0), c.title.clone()));
                    }
                }
            }
            let (cid, ah, t) = found.ok_or("No channel found with this username")?;
            
            // Join the channel
            client.invoke(&grammers_tl_types::functions::channels::JoinChannel {
                channel: build_input_channel(cid, ah),
            }).await.map_err(map_error)?;
            
            (cid, ah, t, Some(value), false)
        }
        "invite_hash" => {
            // Join private channel via messages::ImportChatInvite
            let result = client.invoke(&grammers_tl_types::functions::messages::ImportChatInvite {
                hash: value,
            }).await.map_err(map_error)?;
            
            // Extract channel from Updates
            let mut found: Option<(i64, i64, String)> = None;
            if let grammers_tl_types::enums::Updates::Updates(u) = result {
                for chat in &u.chats {
                    if let grammers_tl_types::enums::Chat::Channel(c) = chat {
                        if c.broadcast {
                            found = Some((c.id, c.access_hash.unwrap_or(0), c.title.clone()));
                        }
                    }
                }
            }
            let (cid, ah, t) = found.ok_or("Joined but could not identify channel")?;
            (cid, ah, t, None, true)
        }
        _ => return Err("Unknown link type".to_string()),
    };
    
    // Check if already in DB (deduplication)
    {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT channel_id FROM public_channels WHERE channel_id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
        if stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
            return Err("ALREADY_ADDED: This channel is already added to NoBuf".to_string());
        }
    }
    
    // Insert into DB
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    
    let conn = get_connection(&app)?;
    conn.execute(format!(
        "INSERT INTO public_channels (channel_id, name, username, access_hash, is_private, added_at, is_member) VALUES ({}, '{}', {}, {}, {}, {}, 1)",
        channel_id,
        title.replace("'", "''"),
        username.as_ref().map(|s| format!("'{}'", s.replace("'", "''"))).unwrap_or("NULL".to_string()),
        access_hash,
        if is_private { 1 } else { 0 },
        now,
    )).map_err(|e| e.to_string())?;
    
    // Also populate peer cache
    // Channel struct has only { raw: tl::types::Channel }, and Channel::from_raw
    // takes a tl::enums::Chat. Construct from the Chat::Channel enum variant.
    // We already have the channel data from the join response, but the simplest
    // approach is to construct the Peer from the dialog scan that happens on next
    // resolve_peer call. For now, insert a minimal entry so the cache has the ID.
    // The access_hash is stored in the public_channels DB table for O(1) access.
    // Peer cache insertion will happen naturally on the first file listing call
    // (cmd_get_public_channel_files uses raw GetHistory with stored access_hash,
    // bypassing resolve_peer entirely).
    
    Ok(PublicChannel {
        channel_id,
        name: title,
        username,
        access_hash,
        is_private,
        added_at: now,
        is_member: true,
    })
}
```

- [ ] **Step 2: Register in `lib.rs`**

After `commands::cmd_resolve_channel_link,` add:

```rust
            commands::cmd_join_channel_by_link,
```

- [ ] **Step 3: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -10`
Expected: `Finished` with no errors. If there are struct field errors for `Channel`, check the generated types and adjust — the `..Default::default()` should handle missing fields.

- [ ] **Step 4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs app/src-tauri/src/lib.rs
git commit -m "feat: add cmd_join_channel_by_link for joining + DB insert"
```

---

### Task 4: `cmd_list_joined_channels` — browse joined channels for modal

**Files:**
- Modify: `app/src-tauri/src/commands/public_channels.rs`
- Modify: `app/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the list-joined command**

Append to `public_channels.rs`:

```rust
#[tauri::command]
pub async fn cmd_list_joined_channels(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<Vec<JoinedChannel>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok(Vec::new());
    }
    let client = client_opt.unwrap();
    
    // Get already-added public channel IDs from DB
    let added_ids: std::collections::HashSet<i64> = {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT channel_id FROM public_channels")
            .map_err(|e| e.to_string())?;
        let mut ids = std::collections::HashSet::new();
        while stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
            ids.insert(vi(stmt.read(0).map_err(|e| e.to_string())?));
        }
        ids
    };
    
    let mut channels = Vec::new();
    let mut dialogs = client.iter_dialogs();
    
    while let Some(dialog) = dialogs.next().await.map_err(map_error)? {
        if let Peer::Channel(c) = &dialog.peer {
            // Only channels (broadcast=true), not megagroups
            if !c.raw.broadcast {
                continue;
            }
            
            let id = c.raw.id;
            let is_nb = c.raw.title.to_lowercase().contains("[nb]");
            
            channels.push(JoinedChannel {
                channel_id: id,
                name: c.raw.title.clone(),
                username: c.raw.username.clone(),
                access_hash: c.raw.access_hash.unwrap_or(0),
                already_added: added_ids.contains(&id),
                is_nb_folder: is_nb,
            });
        }
    }
    
    // Sort: non-NB, non-already-added first, then by name
    channels.sort_by(|a, b| {
        // NB folders go last
        match (a.is_nb_folder, b.is_nb_folder) {
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    
    Ok(channels)
}
```

- [ ] **Step 2: Register in `lib.rs`**

After `commands::cmd_join_channel_by_link,` add:

```rust
            commands::cmd_list_joined_channels,
```

- [ ] **Step 3: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -5`
Expected: `Finished` with no errors.

- [ ] **Step 4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs app/src-tauri/src/lib.rs
git commit -m "feat: add cmd_list_joined_channels for browse modal"
```

---

### Task 5: `cmd_add_joined_channel` — add an already-joined channel

**Files:**
- Modify: `app/src-tauri/src/commands/public_channels.rs`
- Modify: `app/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the add-joined command**

Append to `public_channels.rs`:

```rust
#[tauri::command]
pub async fn cmd_add_joined_channel(
    channel_id: i64,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<PublicChannel, String> {
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;
    
    // Check deduplication
    {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT channel_id FROM public_channels WHERE channel_id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
        if stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
            return Err("ALREADY_ADDED: This channel is already added to NoBuf".to_string());
        }
    }
    
    // Resolve the channel from peer cache or dialog scan
    let peer = {
        let cache = state.peer_cache.read().await;
        cache.get(&channel_id).cloned()
    };
    
    let (name, username, access_hash) = if let Some(Peer::Channel(c)) = peer {
        (c.raw.title.clone(), c.raw.username.clone(), c.raw.access_hash.unwrap_or(0))
    } else {
        // Fallback: scan dialogs
        let mut dialogs = client.iter_dialogs();
        let mut found = None;
        while let Some(dialog) = dialogs.next().await.map_err(map_error)? {
            if let Peer::Channel(c) = &dialog.peer {
                if c.raw.id == channel_id {
                    found = Some((c.raw.title.clone(), c.raw.username.clone(), c.raw.access_hash.unwrap_or(0)));
                    break;
                }
            }
        }
        found.ok_or("Channel not found in your dialogs")?
    };
    
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    
    let is_private = username.is_none();
    
    // Insert into DB
    let conn = get_connection(&app)?;
    conn.execute(format!(
        "INSERT INTO public_channels (channel_id, name, username, access_hash, is_private, added_at, is_member) VALUES ({}, '{}', {}, {}, {}, {}, 1)",
        channel_id,
        name.replace("'", "''"),
        username.as_ref().map(|s| format!("'{}'", s.replace("'", "''"))).unwrap_or("NULL".to_string()),
        access_hash,
        if is_private { 1 } else { 0 },
        now,
    )).map_err(|e| e.to_string())?;
    
    Ok(PublicChannel {
        channel_id,
        name,
        username,
        access_hash,
        is_private,
        added_at: now,
        is_member: true,
    })
}
```

- [ ] **Step 2: Register in `lib.rs`**

After `commands::cmd_list_joined_channels,` add:

```rust
            commands::cmd_add_joined_channel,
```

- [ ] **Step 3: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -5`
Expected: `Finished` with no errors.

- [ ] **Step 4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs app/src-tauri/src/lib.rs
git commit -m "feat: add cmd_add_joined_channel for already-joined channels"
```

---

### Task 6: `cmd_get_public_channels` — list added channels from DB

**Files:**
- Modify: `app/src-tauri/src/commands/public_channels.rs`
- Modify: `app/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the get-public-channels command**

Append to `public_channels.rs`:

```rust
#[tauri::command]
pub fn cmd_get_public_channels(
    app: AppHandle,
) -> Result<Vec<PublicChannel>, String> {
    let conn = get_connection(&app)?;
    let mut stmt = conn.prepare(
        "SELECT channel_id, name, username, access_hash, is_private, added_at, is_member FROM public_channels ORDER BY added_at"
    ).map_err(|e| e.to_string())?;
    
    let mut channels = Vec::new();
    while stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
        let row: Vec<Value> = (0..7).map(|i| stmt.read(i).unwrap_or(Value::Null)).collect();
        channels.push(row_to_public_channel(&row));
    }
    Ok(channels)
}
```

- [ ] **Step 2: Register in `lib.rs`**

After `commands::cmd_add_joined_channel,` add:

```rust
            commands::cmd_get_public_channels,
```

- [ ] **Step 3: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -5`
Expected: `Finished` with no errors.

- [ ] **Step 4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs app/src-tauri/src/lib.rs
git commit -m "feat: add cmd_get_public_channels for sidebar list"
```

---

### Task 7: `cmd_get_public_channel_files` — paginated file listing

**Files:**
- Modify: `app/src-tauri/src/commands/public_channels.rs`
- Modify: `app/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the paginated file listing command**

Append to `public_channels.rs`:

```rust
#[tauri::command]
pub async fn cmd_get_public_channel_files(
    channel_id: i64,
    offset_id: Option<i32>,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<(Vec<FileMetadata>, bool), String> {
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;
    
    // Get access_hash from DB
    let access_hash = {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT access_hash, is_member FROM public_channels WHERE channel_id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
        if stmt.next().map_err(|e| e.to_string())? != sqlite::State::Row {
            return Err("Channel not found in NoBuf database".to_string());
        }
        let ah = vi(stmt.read(0).map_err(|e| e.to_string())?);
        let is_member = vb(stmt.read(1).map_err(|e| e.to_string())?);
        if !is_member {
            return Err("NOT_A_MEMBER: You are no longer a member of this channel".to_string());
        }
        ah
    };
    
    // Build peer from stored access_hash
    let input_peer = build_input_peer(channel_id, access_hash);
    let peer: Peer = client.iter_dialogs().next().await.map_or(
        Peer::User(client.get_me().await.map_err(|e| e.to_string())?),
        |_| {
            // Use the InputPeer to construct a messages query directly
            // We need to use iter_messages with the InputPeer
            // grammers-client accepts Into<PeerRef> for iter_messages
            // InputPeer implements Into<PeerRef>
            // But we need to convert InputPeer to a type iter_messages accepts
            unreachable!("placeholder — see fix below")
        }
    );
    
    // Actually, use the raw API to get messages with pagination
    let result = client.invoke(&grammers_tl_types::functions::messages::GetHistory {
        peer: input_peer,
        offset_id: offset_id.unwrap_or(0),
        offset_date: 0,
        add_offset: 0,
        limit: 51, // Fetch 51 to know if there are more
        max_id: 0,
        min_id: 0,
        hash: 0,
    }).await.map_err(|e| {
        let err = e.to_string();
        if err.contains("CHANNEL_PRIVATE") || err.contains("CHANNEL_INVALID") {
            "NOT_A_MEMBER: You are no longer a member of this channel".to_string()
        } else {
            map_error(e)
        }
    })?;
    
    let (messages, has_more) = match result {
        grammers_tl_types::enums::messages::Messages::Messages(msgs) => {
            (msgs.messages, false)
        }
        grammers_tl_types::enums::messages::Messages::Slice(msgs) => {
            (msgs.messages, true)
        }
        _ => (Vec::new(), false),
    };
    
    // Filter to 50 and check if there are more
    let mut files = Vec::new();
    let limit = 50;
    let mut count = 0;
    let has_more_final = messages.len() > limit;
    
    for msg in messages {
        if count >= limit {
            break;
        }
        if let grammers_tl_types::enums::Message::Message(m) = msg {
            if let Some(media) = &m.media {
                let (name, size, mime, ext, duration) = match media {
                    grammers_tl_types::enums::MessageMedia::Document(d) => {
                        if let Some(grammers_tl_types::enums::Document::Document(doc)) = &d.document {
                            let n = doc.attributes.iter().find_map(|a| match a {
                                grammers_tl_types::enums::DocumentAttribute::Filename(f) => Some(f.file_name.clone()),
                                _ => None,
                            }).unwrap_or_else(|| "Unknown".to_string());
                            let s = doc.size as u64;
                            let mi = doc.mime_type.clone();
                            let e = std::path::Path::new(&n).extension().map(|os| os.to_str().unwrap_or("").to_string());
                            (n, s, Some(mi), e, extract_duration_from_doc(&grammers_tl_types::enums::Document::Document(doc.clone())))
                        } else {
                            continue;
                        }
                    }
                    grammers_tl_types::enums::MessageMedia::Photo(_) => {
                        ("Photo.jpg".to_string(), 0, Some("image/jpeg".to_string()), Some("jpg".to_string()), None)
                    }
                    _ => continue, // Skip text-only, polls, etc.
                };
                files.push(FileMetadata {
                    id: m.id as i64,
                    folder_id: Some(channel_id),
                    name,
                    size,
                    mime_type: mime,
                    file_ext: ext,
                    created_at: m.date.to_string(),
                    icon_type: "file".to_string(),
                    duration,
                });
                count += 1;
            }
        }
    }
    
    Ok((files, has_more_final))
}
```

- [ ] **Step 2: Register in `lib.rs`**

After `commands::cmd_get_public_channels,` add:

```rust
            commands::cmd_get_public_channel_files,
```

- [ ] **Step 3: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -10`
Expected: May have errors — the `unreachable!` placeholder needs to be removed. Let's fix the function to remove the unused peer construction:

Replace the block from `// Build peer from stored access_hash` through the `unreachable!` line with just a comment:

```rust
    // Use raw GetHistory API directly with the stored InputPeer
    // (bypasses resolve_peer which scans all dialogs — O(1) with stored access_hash)
```

Then remove the `let peer = ...` block entirely and keep only the `client.invoke(&GetHistory{...})` call.

- [ ] **Step 4: Fix and verify**

After removing the unreachable block, run: `cd app/src-tauri && cargo check 2>&1 | tail -5`
Expected: `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs app/src-tauri/src/lib.rs
git commit -m "feat: add cmd_get_public_channel_files with pagination (50/page)"
```

---

### Task 8: `cmd_remove_public_channel` — remove from NoBuf + optional leave

**Files:**
- Modify: `app/src-tauri/src/commands/public_channels.rs`
- Modify: `app/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the remove command**

Append to `public_channels.rs`:

```rust
#[tauri::command]
pub async fn cmd_remove_public_channel(
    channel_id: i64,
    leave_on_telegram: bool,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    // Get access_hash before deleting from DB
    let access_hash = {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT access_hash FROM public_channels WHERE channel_id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
        if stmt.next().map_err(|e| e.to_string())? != sqlite::State::Row {
            return Err("Channel not found in NoBuf database".to_string());
        }
        vi(stmt.read(0).map_err(|e| e.to_string())?)
    };
    
    // Optionally leave the channel on Telegram
    if leave_on_telegram {
        let client_opt = { state.client.lock().await.clone() };
        if let Some(client) = client_opt {
            client.invoke(&grammers_tl_types::functions::channels::LeaveChannel {
                channel: build_input_channel(channel_id, access_hash),
            }).await.map_err(map_error)?;
        }
    }
    
    // Delete from DB
    let conn = get_connection(&app)?;
    conn.execute(format!("DELETE FROM public_channels WHERE channel_id = {}", channel_id))
        .map_err(|e| e.to_string())?;
    
    // Remove from peer cache
    state.peer_cache.write().await.remove(&channel_id);
    
    Ok(true)
}
```

- [ ] **Step 2: Register in `lib.rs`**

After `commands::cmd_get_public_channel_files,` add:

```rust
            commands::cmd_remove_public_channel,
```

- [ ] **Step 3: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -5`
Expected: `Finished` with no errors.

- [ ] **Step 4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs app/src-tauri/src/lib.rs
git commit -m "feat: add cmd_remove_public_channel with optional LeaveChannel"
```

---

### Task 9: `cmd_forward_to_folder` — forward files to [NB] folder

**Files:**
- Modify: `app/src-tauri/src/commands/public_channels.rs`
- Modify: `app/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the forward command**

Append to `public_channels.rs`:

```rust
#[tauri::command]
pub async fn cmd_forward_to_folder(
    source_channel_id: i64,
    message_ids: Vec<i32>,
    target_folder_id: i64,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<ForwardResult, String> {
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;
    
    // Get source channel access_hash from DB
    let source_access_hash = {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT access_hash FROM public_channels WHERE channel_id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, source_channel_id)).map_err(|e| e.to_string())?;
        if stmt.next().map_err(|e| e.to_string())? != sqlite::State::Row {
            return Err("Source channel not found".to_string());
        }
        vi(stmt.read(0).map_err(|e| e.to_string())?)
    };
    
    // Resolve target [NB] folder peer
    let target_peer = crate::commands::utils::resolve_peer(&client, Some(target_folder_id), &state.peer_cache).await?;
    
    // Build source peer from stored access_hash
    let source_input_peer = build_input_peer(source_channel_id, source_access_hash);
    
    // Forward messages (no delete — this is a copy, not a move)
    let mut errors = Vec::new();
    let mut forwarded = 0;
    
    // forward_messages accepts Into<PeerRef> — InputPeer works
    match client.forward_messages(&target_peer, &message_ids, &source_input_peer).await {
        Ok(_) => {
            forwarded = message_ids.len() as i32;
        }
        Err(e) => {
            let err_str = e.to_string();
            if err_str.contains("FLOOD_WAIT") {
                errors.push(map_error(e));
            } else {
                errors.push(format!("Forward failed: {}", err_str));
            }
        }
    }
    
    Ok(ForwardResult {
        success: errors.is_empty(),
        forwarded_count: forwarded,
        errors,
    })
}
```

- [ ] **Step 2: Register in `lib.rs`**

After `commands::cmd_remove_public_channel,` add:

```rust
            commands::cmd_forward_to_folder,
```

- [ ] **Step 3: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -5`
Expected: `Finished` with no errors. If `forward_messages` signature doesn't accept `InputPeer` directly, convert it to a `Peer` first via `resolve_peer` or dialog scan.

- [ ] **Step 4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs app/src-tauri/src/lib.rs
git commit -m "feat: add cmd_forward_to_folder for server-side forwarding"
```

---

## Phase 2: [NB-PUB] Sync System

### Task 10: `cmd_update_nb_pub_sync` — create/update sync message

**Files:**
- Modify: `app/src-tauri/src/commands/public_channels.rs`
- Modify: `app/src-tauri/src/lib.rs`

This command creates the [NB-PUB] channel (if needed), serializes the current public channel list as JSON, uploads it as a file, and deletes the old sync message.

- [ ] **Step 1: Add the sync update command**

Append to `public_channels.rs`:

```rust
#[tauri::command]
pub async fn cmd_update_nb_pub_sync(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;
    
    // Get current channel list from DB
    let channels: Vec<PublicChannel> = {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare(
            "SELECT channel_id, name, username, access_hash, is_private, added_at, is_member FROM public_channels WHERE is_member = 1"
        ).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        while stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
            let row: Vec<Value> = (0..7).map(|i| stmt.read(i).unwrap_or(Value::Null)).collect();
            result.push(row_to_public_channel(&row));
        }
        result
    };
    
    // Serialize to JSON
    let json_data = serde_json::to_string(&channels).map_err(|e| e.to_string())?;
    let json_bytes = json_data.as_bytes().to_vec();
    
    // Find or create [NB-PUB] channel
    let nb_pub_id = find_or_create_nb_pub_channel(&client, &app, &state).await?;
    
    // Find and delete old sync message
    let old_msg_id = get_setting(&app, "nb_pub_message_id");
    if let Some(msg_id) = old_msg_id {
        let id_int: i32 = msg_id.parse().unwrap_or(0);
        if id_int > 0 {
            let input_peer = build_input_peer(nb_pub_id, 0); // access_hash will be resolved
            // Actually need real access_hash — get from peer cache or dialog
            let ah = get_nb_pub_access_hash(&client, nb_pub_id, &state).await?;
            let real_peer = build_input_peer(nb_pub_id, ah);
            let _ = client.invoke(&grammers_tl_types::functions::channels::DeleteMessages {
                channel: build_input_channel(nb_pub_id, ah),
                id: vec![id_int],
            }).await;
        }
    }
    
    // Upload new JSON file to [NB-PUB]
    let ah = get_nb_pub_access_hash(&client, nb_pub_id, &state).await?;
    let input_peer = build_input_peer(nb_pub_id, ah);
    
    // Write JSON to temp file and upload
    let temp_dir = std::env::temp_dir();
    let temp_path = temp_dir.join("nb_pub_sync.json");
    std::fs::write(&temp_path, &json_bytes).map_err(|e| e.to_string())?;
    
    let uploaded = client.upload_file(&temp_path).await.map_err(|e| e.to_string())?;
    
    use grammers_client::InputMessage;
    let message = InputMessage::new().text("").document(uploaded);
    let sent = client.send_message(&input_peer, message).await.map_err(map_error)?;
    
    // Store new message ID
    set_setting(&app, "nb_pub_message_id", &sent.id().to_string());
    
    Ok(true)
}

// ─── [NB-PUB] helper functions ───────────────────────────────────

fn get_setting(app: &AppHandle, key: &str) -> Option<String> {
    let conn = get_connection(app).ok()?;
    let mut stmt = conn.prepare("SELECT value FROM nb_pub_settings WHERE key = ?").ok()?;
    stmt.bind((1, key)).ok()?;
    if stmt.next().ok()? == sqlite::State::Row {
        Some(vs(stmt.read(0).ok()?))
    } else {
        None
    }
}

fn set_setting(app: &AppHandle, key: &str, value: &str) {
    if let Ok(conn) = get_connection(app) {
        let _ = conn.execute(format!(
            "INSERT INTO nb_pub_settings (key, value) VALUES ('{}', '{}') ON CONFLICT(key) DO UPDATE SET value = '{}'",
            key.replace("'", "''"), value.replace("'", "''"), value.replace("'", "''")
        ));
    }
}

async fn find_or_create_nb_pub_channel(
    client: &Client,
    app: &AppHandle,
    state: &TelegramState,
) -> Result<i64, String> {
    // Check if we already know the [NB-PUB] channel ID
    if let Some(id_str) = get_setting(app, "nb_pub_channel_id") {
        if let Ok(id) = id_str.parse::<i64>() {
            return Ok(id);
        }
    }
    
    // Scan dialogs for [NB-PUB] channel
    let mut dialogs = client.iter_dialogs();
    while let Some(dialog) = dialogs.next().await.map_err(map_error)? {
        if let Peer::Channel(c) = &dialog.peer {
            if c.raw.title.eq_ignore_ascii_case("[NB-PUB]") {
                set_setting(app, "nb_pub_channel_id", &c.raw.id.to_string());
                // Populate peer cache
                state.peer_cache.write().await.insert(c.raw.id, dialog.peer.clone());
                return Ok(c.raw.id);
            }
        }
    }
    
    // Create [NB-PUB] channel
    let result = client.invoke(&grammers_tl_types::functions::channels::CreateChannel {
        broadcast: true,
        megagroup: false,
        title: "[NB-PUB]".to_string(),
        about: "NoBuf sync data — do not delete".to_string(),
        geo_point: None,
        address: None,
        for_import: false,
        forum: false,
        ttl_period: None,
    }).await.map_err(map_error)?;
    
    let chat_id = match result {
        grammers_tl_types::enums::Updates::Updates(u) => {
            let chat = u.chats.first().ok_or("No chat in CreateChannel response")?;
            if let grammers_tl_types::enums::Chat::Channel(c) = chat {
                c.id
            } else {
                return Err("Created chat is not a channel".to_string());
            }
        }
        _ => return Err("Unexpected CreateChannel response".to_string()),
    };
    
    set_setting(app, "nb_pub_channel_id", &chat_id.to_string());
    Ok(chat_id)
}

async fn get_nb_pub_access_hash(
    client: &Client,
    channel_id: i64,
    state: &TelegramState,
) -> Result<i64, String> {
    // Check peer cache first
    {
        let cache = state.peer_cache.read().await;
        if let Some(Peer::Channel(c)) = cache.get(&channel_id) {
            return Ok(c.raw.access_hash.unwrap_or(0));
        }
    }
    
    // Scan dialogs
    let mut dialogs = client.iter_dialogs();
    while let Some(dialog) = dialogs.next().await.map_err(map_error)? {
        if let Peer::Channel(c) = &dialog.peer {
            if c.raw.id == channel_id {
                let ah = c.raw.access_hash.unwrap_or(0);
                state.peer_cache.write().await.insert(channel_id, dialog.peer.clone());
                return Ok(ah);
            }
        }
    }
    
    Err("Could not find [NB-PUB] channel access hash".to_string())
}
```

- [ ] **Step 2: Add `serde_json` dependency**

Run: `cd app/src-tauri && cargo add serde_json`
Expected: `serde_json` added to Cargo.toml.

- [ ] **Step 3: Register in `lib.rs`**

After `commands::cmd_forward_to_folder,` add:

```rust
            commands::cmd_update_nb_pub_sync,
```

- [ ] **Step 4: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -10`
Expected: `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs app/src-tauri/src/lib.rs app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "feat: add [NB-PUB] sync system — create channel + upload JSON"
```

---

### Task 11: `cmd_sync_public_channels` — sync from [NB-PUB] on startup

**Files:**
- Modify: `app/src-tauri/src/commands/public_channels.rs`
- Modify: `app/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the sync command**

Append to `public_channels.rs`:

```rust
#[tauri::command]
pub async fn cmd_sync_public_channels(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<Vec<PublicChannel>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        // Not connected — return local DB state
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare(
            "SELECT channel_id, name, username, access_hash, is_private, added_at, is_member FROM public_channels ORDER BY added_at"
        ).map_err(|e| e.to_string())?;
        let mut channels = Vec::new();
        while stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
            let row: Vec<Value> = (0..7).map(|i| stmt.read(i).unwrap_or(Value::Null)).collect();
            channels.push(row_to_public_channel(&row));
        }
        return Ok(channels);
    }
    let client = client_opt.unwrap();
    
    // Try to find [NB-PUB] channel
    let nb_pub_id = {
        if let Some(id_str) = get_setting(&app, "nb_pub_channel_id") {
            id_str.parse::<i64>().ok()
        } else {
            None
        }
    };
    
    let nb_pub_id = match nb_pub_id {
        Some(id) => id,
        None => {
            // Scan dialogs for [NB-PUB]
            let mut found = None;
            let mut dialogs = client.iter_dialogs();
            while let Some(dialog) = dialogs.next().await.map_err(map_error)? {
                if let Peer::Channel(c) = &dialog.peer {
                    if c.raw.title.eq_ignore_ascii_case("[NB-PUB]") {
                        found = Some(c.raw.id);
                        state.peer_cache.write().await.insert(c.raw.id, dialog.peer.clone());
                        break;
                    }
                }
            }
            match found {
                Some(id) => {
                    set_setting(&app, "nb_pub_channel_id", &id.to_string());
                    id
                }
                None => {
                    // [NB-PUB] doesn't exist yet — return local DB state
                    return cmd_get_public_channels(app);
                }
            }
        }
    };
    
    // Get access_hash for [NB-PUB]
    let ah = get_nb_pub_access_hash(&client, nb_pub_id, &state).await?;
    let input_peer = build_input_peer(nb_pub_id, ah);
    
    // Get the latest message from [NB-PUB] (the sync JSON)
    let result = client.invoke(&grammers_tl_types::functions::messages::GetHistory {
        peer: input_peer,
        offset_id: 0,
        offset_date: 0,
        add_offset: 0,
        limit: 1,
        max_id: 0,
        min_id: 0,
        hash: 0,
    }).await.map_err(map_error)?;
    
    let messages = match result {
        grammers_tl_types::enums::messages::Messages::Messages(m) => m.messages,
        grammers_tl_types::enums::messages::Messages::Slice(m) => m.messages,
        _ => Vec::new(),
    };
    
    if messages.is_empty() {
        // [NB-PUB] exists but empty — return local state
        return cmd_get_public_channels(app);
    }
    
    // Download the JSON file from the message
    let msg = match &messages[0] {
        grammers_tl_types::enums::Message::Message(m) => m,
        _ => return cmd_get_public_channels(app),
    };
    
    let media = match &msg.media {
        Some(grammers_tl_types::enums::MessageMedia::Document(d)) => d,
        _ => return cmd_get_public_channels(app), // Not a file — return local
    };
    
    let doc = match &media.document {
        Some(grammers_tl_types::enums::Document::Document(d)) => d,
        _ => return cmd_get_public_channels(app),
    };
    
    // Download the file content
    let temp_path = std::env::temp_dir().join("nb_pub_sync_download.json");
    
    // Use iter_download with the document media
    // Media::from_raw returns Option<Media> from a MessageMedia enum
    let media_enum = grammers_tl_types::enums::MessageMedia::Document(media.clone());
    let media_obj = grammers_client::types::Media::from_raw(media_enum)
        .ok_or("Failed to construct Media from sync document")?;
    
    let mut iter = client.iter_download(&media_obj).chunk_size(64 * 1024);
    let mut file_data = Vec::new();
    loop {
        let chunk_result = {
            let _permit = state.download_semaphore.acquire().await.unwrap();
            iter.next().await
        };
        let chunk = match chunk_result {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => return Err(format!("Download error: {}", e)),
        };
        file_data.extend_from_slice(&chunk);
        tokio::task::yield_now().await;
    }
    
    // Parse JSON
    let remote_channels: Vec<PublicChannel> = serde_json::from_slice(&file_data)
        .map_err(|e| format!("Failed to parse sync JSON: {}", e))?;
    
    // Reconcile with local DB
    let conn = get_connection(&app)?;
    
    // Get local IDs
    let mut local_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    {
        let mut stmt = conn.prepare("SELECT channel_id FROM public_channels").map_err(|e| e.to_string())?;
        while stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
            local_ids.insert(vi(stmt.read(0).map_err(|e| e.to_string())?));
        }
    }
    
    let remote_ids: std::collections::HashSet<i64> = remote_channels.iter().map(|c| c.channel_id).collect();
    
    // Add remote channels not in local
    for ch in &remote_channels {
        if !local_ids.contains(&ch.channel_id) {
            conn.execute(format!(
                "INSERT INTO public_channels (channel_id, name, username, access_hash, is_private, added_at, is_member) VALUES ({}, '{}', {}, {}, {}, {}, 1)",
                ch.channel_id,
                ch.name.replace("'", "''"),
                ch.username.as_ref().map(|s| format!("'{}'", s.replace("'", "''"))).unwrap_or("NULL".to_string()),
                ch.access_hash,
                if ch.is_private { 1 } else { 0 },
                ch.added_at,
            )).map_err(|e| e.to_string())?;
        }
    }
    
    // Remove local channels not in remote (another device removed them)
    for local_id in &local_ids {
        if !remote_ids.contains(local_id) {
            conn.execute(format!("DELETE FROM public_channels WHERE channel_id = {}", local_id))
                .map_err(|e| e.to_string())?;
        }
    }
    
    // Store sync message ID
    set_setting(&app, "nb_pub_message_id", &msg.id.to_string());
    
    // Return the reconciled list
    let mut stmt = conn.prepare(
        "SELECT channel_id, name, username, access_hash, is_private, added_at, is_member FROM public_channels ORDER BY added_at"
    ).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    while stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
        let row: Vec<Value> = (0..7).map(|i| stmt.read(i).unwrap_or(Value::Null)).collect();
        result.push(row_to_public_channel(&row));
    }
    Ok(result)
}
```

- [ ] **Step 2: Register in `lib.rs`**

After `commands::cmd_update_nb_pub_sync,` add:

```rust
            commands::cmd_sync_public_channels,
```

- [ ] **Step 3: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -10`
Expected: `Finished` with no errors.

- [ ] **Step 4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs app/src-tauri/src/lib.rs
git commit -m "feat: add cmd_sync_public_channels for startup cross-device sync"
```

---

### Task 12: Add [NB-PUB] exclusion to `cmd_scan_folders`

**Files:**
- Modify: `app/src-tauri/src/commands/fs.rs`

- [ ] **Step 1: Add exclusion filter**

Open `app/src-tauri/src/commands/fs.rs`. Find line ~1448 which reads:

```rust
                if title.to_lowercase().contains("[nb]") {
```

Replace with:

```rust
                if title.to_lowercase().contains("[nb]") && !title.to_lowercase().contains("[nb-pub]") {
```

- [ ] **Step 2: Verify compilation**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -5`
Expected: `Finished` with no errors.

- [ ] **Step 3: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/fs.rs
git commit -m "fix: exclude [NB-PUB] from cmd_scan_folders folder detection"
```

---

## Phase 3: Frontend — Types, Sidebar + Add Modal

### Task 13: Add frontend types

**Files:**
- Modify: `app/src/types.ts`

- [ ] **Step 1: Add types**

Open `app/src/types.ts` and append at the end:

```typescript
export interface PublicChannel {
    channel_id: number;
    name: string;
    username: string | null;
    access_hash: number;
    is_private: boolean;
    added_at: number;
    is_member: boolean;
}

export interface ChannelPreview {
    title: string;
    about: string | null;
    participants_count: number;
    is_channel: boolean;
    is_private: boolean;
    already_joined: boolean;
    channel_id: number | null;
    access_hash: number | null;
    username: string | null;
}

export interface JoinedChannel {
    channel_id: number;
    name: string;
    username: string | null;
    access_hash: number;
    already_added: boolean;
    is_nb_folder: boolean;
}

export interface ForwardResult {
    success: boolean;
    forwarded_count: number;
    errors: string[];
}

export type ActiveView =
    | { type: 'saved' }
    | { type: 'folder'; folderId: number }
    | { type: 'public'; channelId: number };
```

- [ ] **Step 2: Verify types**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src/types.ts
git commit -m "feat: add PublicChannel, ChannelPreview, JoinedChannel, ActiveView types"
```

---

### Task 14: Create `usePublicChannels` hook

**Files:**
- Create: `app/src/hooks/usePublicChannels.ts`

- [ ] **Step 1: Create the hook**

Create `app/src/hooks/usePublicChannels.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { PublicChannel, ChannelPreview, JoinedChannel, ForwardResult } from '../types';

export function usePublicChannels() {
    const queryClient = useQueryClient();

    const { data: publicChannels = [], isLoading } = useQuery<PublicChannel[]>({
        queryKey: ['publicChannels'],
        queryFn: () => invoke<PublicChannel[]>('cmd_get_public_channels'),
    });

    const resolveLink = useMutation({
        mutationFn: (link: string) => invoke<ChannelPreview>('cmd_resolve_channel_link', { link }),
        onError: (e: string) => toast.error(e),
    });

    const joinByLink = useMutation({
        mutationFn: (link: string) => invoke<PublicChannel>('cmd_join_channel_by_link', { link }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['publicChannels'] });
            // Also trigger sync update
            invoke('cmd_update_nb_pub_sync').catch(() => {});
        },
        onError: (e: string) => {
            if (e.startsWith('ALREADY_ADDED')) {
                toast.info('This channel is already added to NoBuf.');
            } else {
                toast.error(e);
            }
        },
    });

    const addJoined = useMutation({
        mutationFn: (channelId: number) => invoke<PublicChannel>('cmd_add_joined_channel', { channelId }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['publicChannels'] });
            invoke('cmd_update_nb_pub_sync').catch(() => {});
        },
        onError: (e: string) => {
            if (e.startsWith('ALREADY_ADDED')) {
                toast.info('This channel is already added to NoBuf.');
            } else {
                toast.error(e);
            }
        },
    });

    const removeChannel = useMutation({
        mutationFn: ({ channelId, leaveOnTelegram }: { channelId: number; leaveOnTelegram: boolean }) =>
            invoke<boolean>('cmd_remove_public_channel', { channelId, leaveOnTelegram }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['publicChannels'] });
            invoke('cmd_update_nb_pub_sync').catch(() => {});
        },
        onError: (e: string) => toast.error(e),
    });

    const syncFromRemote = useMutation({
        mutationFn: () => invoke<PublicChannel[]>('cmd_sync_public_channels'),
        onSuccess: (data) => {
            queryClient.setQueryData(['publicChannels'], data);
        },
    });

    return {
        publicChannels,
        isLoading,
        resolveLink,
        joinByLink,
        addJoined,
        removeChannel,
        syncFromRemote,
    };
}

export function usePublicChannelFiles(channelId: number | null) {
    const queryClient = useQueryClient();

    const { data, isLoading, error } = useQuery({
        queryKey: ['publicChannelFiles', channelId, 0],
        queryFn: async () => {
            if (!channelId) return { files: [], hasMore: false };
            const [files, hasMore] = await invoke<[any[], boolean]>('cmd_get_public_channel_files', {
                channelId,
                offsetId: null,
            });
            return {
                files: files.map(f => ({ ...f, sizeStr: formatBytesLocal(f.size) })),
                hasMore,
                lastOffsetId: files.length > 0 ? files[files.length - 1].id : null,
            };
        },
        enabled: channelId !== null,
    });

    const loadMore = useMutation({
        mutationFn: async (offsetId: number) => {
            const [files, hasMore] = await invoke<[any[], boolean]>('cmd_get_public_channel_files', {
                channelId: channelId!,
                offsetId,
            });
            return {
                files: files.map(f => ({ ...f, sizeStr: formatBytesLocal(f.size) })),
                hasMore,
                lastOffsetId: files.length > 0 ? files[files.length - 1].id : null,
            };
        },
        onSuccess: (newData) => {
            queryClient.setQueryData(['publicChannelFiles', channelId, 0], (prev: any) => ({
                files: [...(prev?.files || []), ...newData.files],
                hasMore: newData.hasMore,
                lastOffsetId: newData.lastOffsetId,
            }));
        },
    });

    return {
        files: data?.files || [],
        hasMore: data?.hasMore || false,
        lastOffsetId: data?.lastOffsetId || null,
        isLoading,
        error,
        loadMore,
    };
}

function formatBytesLocal(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
```

- [ ] **Step 2: Verify types**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors (or minor unused-import warnings).

- [ ] **Step 3: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src/hooks/usePublicChannels.ts
git commit -m "feat: add usePublicChannels + usePublicChannelFiles hooks"
```

---

### Task 15: Create `AddChannelModal` component

**Files:**
- Create: `app/src/components/dashboard/AddChannelModal.tsx`
- Create: `app/src/components/dashboard/ChannelPreviewCard.tsx`

- [ ] **Step 1: Create `ChannelPreviewCard`**

Create `app/src/components/dashboard/ChannelPreviewCard.tsx`:

```tsx
import { ChannelPreview } from '../../types';

interface Props {
    preview: ChannelPreview;
    onJoin: () => void;
    onAddExisting: () => void;
    loading: boolean;
}

export function ChannelPreviewCard({ preview, onJoin, onAddExisting, loading }: Props) {
    return (
        <div className="bg-nobuf-hover rounded-xl border border-nobuf-border p-4 space-y-3">
            <div className="flex items-start gap-3">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-nobuf-primary to-blue-500 flex items-center justify-center shrink-0">
                    <span className="text-white font-bold text-lg">
                        {preview.title.charAt(0).toUpperCase()}
                    </span>
                </div>
                <div className="flex-1 min-w-0">
                    <h4 className="font-semibold text-nobuf-text truncate">{preview.title}</h4>
                    {preview.about && (
                        <p className="text-sm text-nobuf-subtext line-clamp-2 mt-1">{preview.about}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-xs text-nobuf-subtext">
                        {preview.participants_count > 0 && (
                            <span>{preview.participants_count.toLocaleString()} subscribers</span>
                        )}
                        {preview.is_private && (
                            <span className="flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                Private
                            </span>
                        )}
                        {preview.is_channel && (
                            <span className="flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                                Channel
                            </span>
                        )}
                    </div>
                </div>
            </div>
            <button
                onClick={preview.already_joined ? onAddExisting : onJoin}
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-nobuf-primary text-white font-medium text-sm hover:bg-nobuf-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {loading ? 'Joining...' : preview.already_joined ? 'Add to NoBuf' : 'Join & Add'}
            </button>
        </div>
    );
}
```

- [ ] **Step 2: Create `AddChannelModal`**

Create `app/src/components/dashboard/AddChannelModal.tsx`:

```tsx
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { ChannelPreview, JoinedChannel, PublicChannel } from '../../types';
import { ChannelPreviewCard } from './ChannelPreviewCard';

interface Props {
    open: boolean;
    onClose: () => void;
    onAdded: () => void;
}

export function AddChannelModal({ open, onClose, onAdded }: Props) {
    const [tab, setTab] = useState<'link' | 'browse'>('link');
    const [linkInput, setLinkInput] = useState('');
    const [preview, setPreview] = useState<ChannelPreview | null>(null);
    const [resolving, setResolving] = useState(false);
    const [joining, setJoining] = useState(false);
    const [joinedChannels, setJoinedChannels] = useState<JoinedChannel[]>([]);
    const [browseSearch, setBrowseSearch] = useState('');
    const [browseLoading, setBrowseLoading] = useState(false);

    if (!open) return null;

    const handleResolve = async () => {
        if (!linkInput.trim()) return;
        setResolving(true);
        setPreview(null);
        try {
            const result = await invoke<ChannelPreview>('cmd_resolve_channel_link', { link: linkInput });
            setPreview(result);
        } catch (e: any) {
            toast.error(String(e));
        } finally {
            setResolving(false);
        }
    };

    const handleJoin = async () => {
        if (!linkInput.trim()) return;
        setJoining(true);
        try {
            await invoke<PublicChannel>('cmd_join_channel_by_link', { link: linkInput });
            toast.success('Channel added to NoBuf.');
            onAdded();
            handleClose();
        } catch (e: any) {
            const err = String(e);
            if (err.startsWith('ALREADY_ADDED')) {
                toast.info('This channel is already added to NoBuf.');
            } else {
                toast.error(err);
            }
        } finally {
            setJoining(false);
        }
    };

    const handleAddExisting = async () => {
        if (!preview?.channel_id) return;
        setJoining(true);
        try {
            await invoke<PublicChannel>('cmd_add_joined_channel', { channelId: preview.channel_id });
            toast.success('Channel added to NoBuf.');
            onAdded();
            handleClose();
        } catch (e: any) {
            const err = String(e);
            if (err.startsWith('ALREADY_ADDED')) {
                toast.info('This channel is already added to NoBuf.');
            } else {
                toast.error(err);
            }
        } finally {
            setJoining(false);
        }
    };

    const loadJoinedChannels = async () => {
        setBrowseLoading(true);
        try {
            const channels = await invoke<JoinedChannel[]>('cmd_list_joined_channels');
            setJoinedChannels(channels);
        } catch (e: any) {
            toast.error(String(e));
        } finally {
            setBrowseLoading(false);
        }
    };

    const handleAddFromBrowse = async (channel: JoinedChannel) => {
        try {
            await invoke<PublicChannel>('cmd_add_joined_channel', { channelId: channel.channel_id });
            toast.success(`${channel.name} added to NoBuf.`);
            onAdded();
            // Update the list to mark as already_added
            setJoinedChannels(prev => prev.map(c =>
                c.channel_id === channel.channel_id ? { ...c, already_added: true } : c
            ));
        } catch (e: any) {
            const err = String(e);
            if (err.startsWith('ALREADY_ADDED')) {
                toast.info('Already added.');
            } else {
                toast.error(err);
            }
        }
    };

    const handleClose = () => {
        setLinkInput('');
        setPreview(null);
        setBrowseSearch('');
        setJoinedChannels([]);
        onClose();
    };

    const filteredJoined = browseSearch
        ? joinedChannels.filter(c => c.name.toLowerCase().includes(browseSearch.toLowerCase()))
        : joinedChannels;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={handleClose}>
            <div
                className="bg-nobuf-bg rounded-2xl border border-nobuf-border w-full max-w-lg max-h-[80vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-nobuf-border shrink-0">
                    <h3 className="font-semibold text-nobuf-text">Add Public Channel</h3>
                    <button onClick={handleClose} className="text-nobuf-subtext hover:text-nobuf-text transition-colors">
                        ✕
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 p-3 border-b border-nobuf-border shrink-0">
                    <button
                        onClick={() => setTab('link')}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            tab === 'link'
                                ? 'bg-nobuf-primary text-white'
                                : 'text-nobuf-subtext hover:bg-nobuf-hover'
                        }`}
                    >
                        Paste Link
                    </button>
                    <button
                        onClick={() => { setTab('browse'); if (joinedChannels.length === 0) loadJoinedChannels(); }}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            tab === 'browse'
                                ? 'bg-nobuf-primary text-white'
                                : 'text-nobuf-subtext hover:bg-nobuf-hover'
                        }`}
                    >
                        Browse Joined
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 sidebar-scroll">
                    {tab === 'link' && (
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs text-nobuf-subtext mb-1.5 block">Telegram channel link or @username</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        autoFocus
                                        className="flex-1 bg-nobuf-hover rounded-lg px-3 py-2.5 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 border border-nobuf-border"
                                        placeholder="t.me/channelname, t.me/+invite, or @username"
                                        value={linkInput}
                                        onChange={e => setLinkInput(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') handleResolve(); }}
                                    />
                                    <button
                                        onClick={handleResolve}
                                        disabled={resolving || !linkInput.trim()}
                                        className="px-4 py-2.5 rounded-lg bg-nobuf-primary text-white text-sm font-medium hover:bg-nobuf-primary/90 transition-colors disabled:opacity-50"
                                    >
                                        {resolving ? '...' : 'Preview'}
                                    </button>
                                </div>
                                <p className="text-xs text-nobuf-subtext mt-1.5">
                                    Paste a public channel link (t.me/name) or private invite (t.me/+abc).
                                </p>
                            </div>
                            {preview && (
                                <ChannelPreviewCard
                                    preview={preview}
                                    onJoin={handleJoin}
                                    onAddExisting={handleAddExisting}
                                    loading={joining}
                                />
                            )}
                        </div>
                    )}

                    {tab === 'browse' && (
                        <div className="space-y-3">
                            <input
                                type="text"
                                className="w-full bg-nobuf-hover rounded-lg px-3 py-2.5 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 border border-nobuf-border"
                                placeholder="Search joined channels..."
                                value={browseSearch}
                                onChange={e => setBrowseSearch(e.target.value)}
                            />
                            {browseLoading && (
                                <div className="text-center py-8 text-nobuf-subtext text-sm">Loading channels...</div>
                            )}
                            {!browseLoading && filteredJoined.length === 0 && (
                                <div className="text-center py-8 text-nobuf-subtext text-sm">
                                    {joinedChannels.length === 0 ? 'No joined channels found.' : 'No channels match your search.'}
                                </div>
                            )}
                            <div className="space-y-1.5">
                                {filteredJoined.map(channel => (
                                    <div
                                        key={channel.channel_id}
                                        className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                                            channel.already_added || channel.is_nb_folder
                                                ? 'border-nobuf-border bg-nobuf-hover/50 opacity-60'
                                                : 'border-nobuf-border hover:bg-nobuf-hover cursor-pointer'
                                        }`}
                                        onClick={() => {
                                            if (!channel.already_added && !channel.is_nb_folder) {
                                                handleAddFromBrowse(channel);
                                            }
                                        }}
                                    >
                                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-nobuf-primary to-blue-500 flex items-center justify-center shrink-0">
                                            <span className="text-white font-bold text-xs">
                                                {channel.name.charAt(0).toUpperCase()}
                                            </span>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <span className="text-sm font-medium text-nobuf-text block truncate">{channel.name}</span>
                                            {channel.username && (
                                                <span className="text-xs text-nobuf-subtext">@{channel.username}</span>
                                            )}
                                        </div>
                                        {channel.is_nb_folder && (
                                            <span className="text-xs text-nobuf-subtext px-2 py-0.5 rounded bg-nobuf-bg">NoBuf folder</span>
                                        )}
                                        {channel.already_added && !channel.is_nb_folder && (
                                            <span className="text-xs text-nobuf-subtext px-2 py-0.5 rounded bg-nobuf-bg">Added</span>
                                        )}
                                        {!channel.already_added && !channel.is_nb_folder && (
                                            <span className="text-xs text-nobuf-primary font-medium">+ Add</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Verify types**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src/components/dashboard/AddChannelModal.tsx app/src/components/dashboard/ChannelPreviewCard.tsx
git commit -m "feat: add AddChannelModal with Paste Link + Browse Joined tabs"
```

---

### Task 16: Create `PublicChannelSidebarSection` + `PublicChannelItem`

**Files:**
- Create: `app/src/components/dashboard/PublicChannelSidebarSection.tsx`
- Create: `app/src/components/dashboard/PublicChannelItem.tsx`

- [ ] **Step 1: Create `PublicChannelItem`**

Create `app/src/components/dashboard/PublicChannelItem.tsx`:

```tsx
import { Radio, AlertCircle } from 'lucide-react';
import { PublicChannel } from '../../types';

interface Props {
    channel: PublicChannel;
    active: boolean;
    collapsed: boolean;
    onClick: () => void;
    onRemove: () => void;
}

export function PublicChannelItem({ channel, active, collapsed, onClick, onRemove }: Props) {
    return (
        <div
            className={`group flex items-center gap-2.5 rounded-lg transition-all cursor-pointer ${
                collapsed ? 'px-4 justify-start' : 'px-3'
            } py-2 ${
                active
                    ? 'bg-nobuf-primary/15 text-nobuf-primary'
                    : 'text-nobuf-text hover:bg-nobuf-hover'
            }`}
            onClick={onClick}
            title={collapsed ? channel.name : undefined}
        >
            <div className="relative shrink-0">
                <Radio className="w-4 h-4" />
                {!channel.is_member && (
                    <AlertCircle className="absolute -top-1 -right-1 w-2.5 h-2.5 text-red-500" />
                )}
            </div>
            {!collapsed && (
                <>
                    <span className="flex-1 text-sm truncate">{channel.name}</span>
                    <button
                        onClick={(e) => { e.stopPropagation(); onRemove(); }}
                        className="opacity-0 group-hover:opacity-100 text-nobuf-subtext hover:text-red-500 transition-all text-xs shrink-0"
                    >
                        ✕
                    </button>
                </>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Create `PublicChannelSidebarSection`**

Create `app/src/components/dashboard/PublicChannelSidebarSection.tsx`:

```tsx
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PublicChannel, ActiveView } from '../../types';
import { PublicChannelItem } from './PublicChannelItem';
import { AddChannelModal } from './AddChannelModal';

interface Props {
    channels: PublicChannel[];
    activeView: ActiveView;
    collapsed: boolean;
    onSelect: (channelId: number) => void;
    onRemoved: () => void;
}

export function PublicChannelSidebarSection({ channels, activeView, collapsed, onSelect, onRemoved }: Props) {
    const [showAddModal, setShowAddModal] = useState(false);

    const activeChannelId = activeView.type === 'public' ? activeView.channelId : null;

    return (
        <>
            {/* Section header */}
            {!collapsed && (
                <div className="flex items-center justify-between px-3 pt-3 pb-1 shrink-0">
                    <span className="text-xs font-semibold text-nobuf-subtext uppercase tracking-wider">
                        Public Channels
                    </span>
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="text-nobuf-subtext hover:text-nobuf-primary transition-colors"
                        title="Add public channel"
                    >
                        <Plus className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}
            {collapsed && (
                <div className="px-4 pt-3 pb-1 shrink-0">
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="text-nobuf-subtext hover:text-nobuf-primary transition-colors"
                        title="Add public channel"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>
            )}

            {/* Channel list */}
            <div className={`flex flex-col gap-0.5 ${collapsed ? 'px-0' : 'px-3'} pb-2`}>
                {channels.map(channel => (
                    <PublicChannelItem
                        key={channel.channel_id}
                        channel={channel}
                        active={activeChannelId === channel.channel_id}
                        collapsed={collapsed}
                        onClick={() => onSelect(channel.channel_id)}
                        onRemove={() => {
                            // Remove handled by parent (Dashboard) for the confirm dialog
                            onSelect(channel.channel_id);
                        }}
                    />
                ))}
                {!collapsed && channels.length === 0 && (
                    <div className="px-3 py-2 text-xs text-nobuf-subtext">
                        No public channels added.
                    </div>
                )}
            </div>

            <AddChannelModal
                open={showAddModal}
                onClose={() => setShowAddModal(false)}
                onAdded={onRemoved}
            />
        </>
    );
}
```

- [ ] **Step 3: Verify types**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src/components/dashboard/PublicChannelSidebarSection.tsx app/src/components/dashboard/PublicChannelItem.tsx
git commit -m "feat: add PublicChannelSidebarSection + PublicChannelItem"
```

---

### Task 17: Wire up sidebar section + Dashboard state changes

**Files:**
- Modify: `app/src/components/dashboard/Sidebar.tsx`
- Modify: `app/src/components/Dashboard.tsx`
- Modify: `app/src/hooks/useTelegramConnection.ts`

This is the integration task that connects everything together.

- [ ] **Step 1: Modify `Dashboard.tsx` — add ActiveView state + public channels**

Open `app/src/components/Dashboard.tsx`. After the imports (line ~34), add:

```typescript
import { PublicChannelSidebarSection } from './dashboard/PublicChannelSidebarSection';
import { AddChannelModal } from './dashboard/AddChannelModal';
import { ForwardToFolderModal } from './dashboard/ForwardToFolderModal';
import { usePublicChannels, usePublicChannelFiles } from '../hooks/usePublicChannels';
import { ActiveView, PublicChannel } from '../types';
```

Find the line `const [activeFolderId, setActiveFolderId] = useState<number | null>(null);` — this is in `useTelegramConnection.ts`. We need to add `activeView` state in `Dashboard.tsx` and map between them.

Inside the `Dashboard` component (after line ~40, after the `useTelegramConnection` destructure), add:

```typescript
    const [activeView, setActiveView] = useState<ActiveView>({ type: 'saved' });
    const { publicChannels, isLoading: pubChannelsLoading, removeChannel, syncFromRemote } = usePublicChannels();

    // Sync activeFolderId with activeView for backward compat
    useEffect(() => {
        if (activeView.type === 'saved') {
            setActiveFolderId(null);
        } else if (activeView.type === 'folder') {
            setActiveFolderId(activeView.folderId);
        }
    }, [activeView, setActiveFolderId]);
```

Replace the files query (lines ~89-97) with a conditional:

```typescript
    const isPublicView = activeView.type === 'public';
    const { data: pubChannelData, isLoading: pubFilesLoading } = usePublicChannelFiles(
        isPublicView ? activeView.channelId : null
    );

    const { data: nbFiles = [], isLoading: nbFilesLoading } = useQuery({
        queryKey: ['files', activeFolderId],
        queryFn: () => invoke<any[]>('cmd_get_files', { folderId: activeFolderId }).then(res => res.map(f => ({
            ...f,
            sizeStr: formatBytes(f.size),
            type: f.icon_type || (f.name.endsWith('/') ? 'folder' : 'file')
        }))),
        enabled: !!store && !isPublicView,
    });

    const allFiles = isPublicView ? (pubChannelData?.files || []) : nbFiles;
    const isLoading = isPublicView ? pubFilesLoading : nbFilesLoading;
    const isReadOnly = isPublicView;
```

- [ ] **Step 2: Modify `Sidebar.tsx` — render PublicChannelSidebarSection**

Open `app/src/components/dashboard/Sidebar.tsx`. Add import at top:

```typescript
import { PublicChannelSidebarSection } from './PublicChannelSidebarSection';
import { ActiveView, PublicChannel } from '../../types';
```

Update the component props to accept `activeView`, `publicChannels`, and callbacks. Find the `SidebarProps` interface and add:

```typescript
    activeView: ActiveView;
    publicChannels: PublicChannel[];
    onSelectPublicChannel: (channelId: number) => void;
    onPublicChannelsChanged: () => void;
```

After the folder list `</nav>` (around line 258), before the "Create Folder" section, add:

```tsx
            {/* Public Channels section */}
            <PublicChannelSidebarSection
                channels={publicChannels}
                activeView={activeView}
                collapsed={collapsed}
                onSelect={onSelectPublicChannel}
                onRemoved={onPublicChannelsChanged}
            />
```

- [ ] **Step 3: Add startup sync to `useTelegramConnection.ts`**

Open `app/src/hooks/useTelegramConnection.ts`. Inside the `doAutoSync` function (after line ~58, after `applySyncResult(result);`), add:

```typescript
                // Sync public channels from [NB-PUB]
                try {
                    await invoke('cmd_sync_public_channels');
                } catch (e) {
                    console.warn('[Public Channels] Sync failed:', e);
                }
```

- [ ] **Step 4: Verify types**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -10`
Expected: May have errors about missing props or `ForwardToFolderModal` not existing yet. Comment out the `ForwardToFolderModal` import for now — it'll be created in Phase 5. Fix any other prop mismatch errors.

- [ ] **Step 5: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src/components/Dashboard.tsx app/src/components/dashboard/Sidebar.tsx app/src/hooks/useTelegramConnection.ts
git commit -m "feat: wire up ActiveView state + public channel sidebar section"
```

---

## Phase 4: File Browsing + Read-Only Mode

### Task 18: Read-only banner + disabled actions in FileExplorer

**Files:**
- Modify: `app/src/components/dashboard/FileExplorer.tsx`

- [ ] **Step 1: Add read-only banner**

Open `app/src/components/dashboard/FileExplorer.tsx`. Add a `readOnly` prop to the component interface:

```typescript
    readOnly?: boolean;
```

At the top of the file explorer content area (before the file grid/list), add:

```tsx
            {readOnly && (
                <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20">
                    <Lock className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="text-xs text-amber-400">
                        Read-only channel — upload, move, rename, and delete are disabled
                    </span>
                </div>
            )}
```

Add `Lock` to the lucide-react imports at the top of the file.

- [ ] **Step 2: Disable drag-drop upload when readOnly**

Find the drag-drop handler or upload button in `FileExplorer.tsx` and add an early return when `readOnly`:

```typescript
    // In the onDrop or upload handler:
    if (readOnly) return;
```

Also disable the upload button when readOnly:

```tsx
            <button
                onClick={handleManualUpload}
                disabled={readOnly}
                className={`... ${readOnly ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
```

- [ ] **Step 3: Pass readOnly from Dashboard**

In `Dashboard.tsx`, where `FileExplorer` is rendered, add the `readOnly` prop:

```tsx
                    <FileExplorer
                        ...
                        readOnly={isReadOnly}
                    />
```

- [ ] **Step 4: Verify types**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src/components/dashboard/FileExplorer.tsx app/src/components/Dashboard.tsx
git commit -m "feat: read-only banner + disabled actions for public channels"
```

---

### Task 19: Infinite scroll for public channel files

**Files:**
- Modify: `app/src/hooks/usePublicChannels.ts`
- Modify: `app/src/components/dashboard/FileExplorer.tsx`

- [ ] **Step 1: Add scroll detection to FileExplorer**

In `FileExplorer.tsx`, add a ref for the scroll container and an intersection observer:

```typescript
    const loadMoreRef = useRef<HTMLDivElement>(null);
    
    useEffect(() => {
        if (!loadMoreRef.current || !hasMore || !onLoadMore) return;
        
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore) {
                    onLoadMore();
                }
            },
            { rootMargin: '100px' }
        );
        observer.observe(loadMoreRef.current);
        return () => observer.disconnect();
    }, [hasMore, onLoadMore]);
```

Add `hasMore`, `onLoadMore` to the props interface:

```typescript
    hasMore?: boolean;
    onLoadMore?: () => void;
```

At the end of the file list (after all files are rendered), add:

```tsx
            {hasMore && (
                <div ref={loadMoreRef} className="flex justify-center py-4">
                    <span className="text-sm text-nobuf-subtext">Loading more...</span>
                </div>
            )}
```

- [ ] **Step 2: Wire up from Dashboard**

In `Dashboard.tsx`, pass the pagination props when in public view:

```tsx
                    <FileExplorer
                        ...
                        hasMore={isPublicView ? (pubChannelData?.hasMore || false) : false}
                        onLoadMore={isPublicView && pubChannelData?.lastOffsetId
                            ? () => loadMore.mutate(pubChannelData.lastOffsetId)
                            : undefined}
                    />
```

- [ ] **Step 3: Verify types**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src/components/dashboard/FileExplorer.tsx app/src/components/Dashboard.tsx
git commit -m "feat: infinite scroll for public channel files (50/page)"
```

---

## Phase 5: Forward to [NB] + Remove Flow

### Task 20: Create `ForwardToFolderModal`

**Files:**
- Create: `app/src/components/dashboard/ForwardToFolderModal.tsx`

- [ ] **Step 1: Create the modal**

Create `app/src/components/dashboard/ForwardToFolderModal.tsx`:

```tsx
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TelegramFolder, ForwardResult } from '../../types';

interface Props {
    open: boolean;
    onClose: () => void;
    sourceChannelId: number;
    selectedFileIds: number[];
    folders: TelegramFolder[];
    onForwarded: () => void;
}

export function ForwardToFolderModal({ open, onClose, sourceChannelId, selectedFileIds, folders, onForwarded }: Props) {
    const [selectedFolder, setSelectedFolder] = useState<TelegramFolder | null>(null);
    const [forwarding, setForwarding] = useState(false);
    const [progress, setProgress] = useState(0);

    if (!open) return null;

    const handleForward = async () => {
        if (!selectedFolder) return;
        setForwarding(true);
        setProgress(10);
        try {
            // Convert file IDs (i64) to message IDs (i32) for Telegram API
            const messageIds = selectedFileIds.map(id => {
                const id32 = id as any as i32;
                return id32;
            });
            
            setProgress(30);
            const result = await invoke<ForwardResult>('cmd_forward_to_folder', {
                sourceChannelId,
                messageIds,
                targetFolderId: selectedFolder.id,
            });
            
            setProgress(100);
            if (result.success) {
                toast.success(`Forwarded ${result.forwarded_count} file(s) to ${selectedFolder.name}.`);
            } else {
                toast.warning(`Forwarded ${result.forwarded_count} file(s) with ${result.errors.length} error(s).`);
                result.errors.forEach(e => toast.error(e));
            }
            onForwarded();
            handleClose();
        } catch (e: any) {
            toast.error(String(e));
        } finally {
            setForwarding(false);
            setProgress(0);
        }
    };

    const handleClose = () => {
        setSelectedFolder(null);
        setProgress(0);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={handleClose}>
            <div
                className="bg-nobuf-bg rounded-2xl border border-nobuf-border w-full max-w-md"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-nobuf-border">
                    <h3 className="font-semibold text-nobuf-text">
                        Forward to Folder
                        <span className="block text-xs font-normal text-nobuf-subtext mt-0.5">
                            {selectedFileIds.length} file(s) selected
                        </span>
                    </h3>
                    <button onClick={handleClose} className="text-nobuf-subtext hover:text-nobuf-text">✕</button>
                </div>

                <div className="p-4 space-y-2 max-h-80 overflow-y-auto sidebar-scroll">
                    {folders.length === 0 && (
                        <div className="text-center py-6 text-sm text-nobuf-subtext">
                            No NoBuf folders available. Create a folder first.
                        </div>
                    )}
                    {folders.map(folder => (
                        <div
                            key={folder.id}
                            onClick={() => setSelectedFolder(folder)}
                            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                                selectedFolder?.id === folder.id
                                    ? 'border-nobuf-primary bg-nobuf-primary/10'
                                    : 'border-nobuf-border hover:bg-nobuf-hover'
                            }`}
                        >
                            <div className="w-8 h-8 rounded-lg bg-nobuf-primary/20 flex items-center justify-center shrink-0">
                                <span className="text-nobuf-primary text-xs font-bold">📁</span>
                            </div>
                            <span className="text-sm font-medium text-nobuf-text truncate">{folder.name}</span>
                            {selectedFolder?.id === folder.id && (
                                <span className="ml-auto text-nobuf-primary text-sm">✓</span>
                            )}
                        </div>
                    ))}
                </div>

                {progress > 0 && (
                    <div className="px-4 pb-2">
                        <div className="w-full h-1.5 bg-nobuf-hover rounded-full overflow-hidden">
                            <div
                                className="h-full bg-nobuf-primary transition-all duration-300"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                    </div>
                )}

                <div className="flex gap-2 p-4 border-t border-nobuf-border">
                    <button
                        onClick={handleClose}
                        disabled={forwarding}
                        className="flex-1 py-2.5 rounded-lg border border-nobuf-border text-nobuf-text text-sm font-medium hover:bg-nobuf-hover transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleForward}
                        disabled={!selectedFolder || forwarding}
                        className="flex-1 py-2.5 rounded-lg bg-nobuf-primary text-white text-sm font-medium hover:bg-nobuf-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {forwarding ? 'Forwarding...' : `Forward ${selectedFileIds.length} file(s)`}
                    </button>
                </div>
            </div>
        </div>
    );
}

type i32 = number; // TypeScript doesn't have i32, this is just for documentation
```

- [ ] **Step 2: Verify types**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src/components/dashboard/ForwardToFolderModal.tsx
git commit -m "feat: add ForwardToFolderModal with progress bar"
```

---

### Task 21: Add "Forward to folder" to ContextMenu + wire up remove flow

**Files:**
- Modify: `app/src/components/dashboard/ContextMenu.tsx`
- Modify: `app/src/components/Dashboard.tsx`

- [ ] **Step 1: Add forward option to ContextMenu**

Open `app/src/components/dashboard/ContextMenu.tsx`. Add `onForwardToFolder` and `showForwardOption` to the props:

```typescript
    onForwardToFolder?: () => void;
    showForwardOption?: boolean;
```

In the menu items, add the forward option (only visible when `showForwardOption` is true):

```tsx
            {showForwardOption && (
                <button
                    onClick={onForwardToFolder}
                    className="flex items-center gap-2 w-full px-3 py-2 text-sm text-nobuf-text hover:bg-nobuf-hover rounded-lg transition-colors"
                >
                    <ArrowRightLeft className="w-4 h-4" />
                    Forward to folder...
                </button>
            )}
```

Add `ArrowRightLeft` to lucide-react imports.

- [ ] **Step 2: Wire up in Dashboard**

In `Dashboard.tsx`, add state for the forward modal:

```typescript
    const [showForwardModal, setShowForwardModal] = useState(false);
```

Pass to ContextMenu:

```tsx
                    <ContextMenu
                        ...
                        showForwardOption={isReadOnly}
                        onForwardToFolder={() => setShowForwardModal(true)}
                    />
```

Render the modal:

```tsx
            <ForwardToFolderModal
                open={showForwardModal}
                onClose={() => setShowForwardModal(false)}
                sourceChannelId={activeView.type === 'public' ? activeView.channelId : 0}
                selectedFileIds={selectedIds}
                folders={folders}
                onForwarded={() => {
                    queryClient.invalidateQueries({ queryKey: ['files'] });
                }}
            />
```

- [ ] **Step 3: Wire up remove flow with "Also leave?" prompt**

In `Dashboard.tsx`, add the remove handler:

```typescript
    const { confirm } = useConfirm();

    const handleRemovePublicChannel = async (channelId: number) => {
        const channel = publicChannels.find(c => c.channel_id === channelId);
        if (!channel) return;
        
        const shouldLeave = await confirm(
            `Remove "${channel.name}" from NoBuf?`,
            'Also leave this channel on Telegram?',
            'Leave & Remove',
            'Remove Only'
        );
        
        // confirm returns true for first button, false for second
        // If user cancels, both are false — we need to distinguish
        // For now: true = leave + remove, false = remove only (but could be cancel)
        // The confirm dialog should have a third "Cancel" option
    };
```

Note: The existing `useConfirm` from `ConfirmContext` needs to support a 3-way choice (leave / remove only / cancel). Check how `ConfirmContext` works and adapt. If it only supports yes/no, use two sequential prompts:

```typescript
    const handleRemovePublicChannel = async (channelId: number) => {
        const channel = publicChannels.find(c => c.channel_id === channelId);
        if (!channel) return;

        const shouldRemove = await confirm(
            `Remove "${channel.name}" from NoBuf?`,
            'This will remove the channel from your NoBuf sidebar.',
            'Remove',
            'Cancel'
        );
        
        if (!shouldRemove) return;
        
        const shouldLeave = await confirm(
            'Also leave on Telegram?',
            'You will no longer receive messages from this channel on Telegram.',
            'Leave Channel',
            'Keep Subscribed'
        );
        
        removeChannel.mutate({ channelId, leaveOnTelegram: shouldLeave });
        toast.success(`Removed "${channel.name}" from NoBuf.`);
        
        // Switch to Saved Messages if we were viewing this channel
        if (activeView.type === 'public' && activeView.channelId === channelId) {
            setActiveView({ type: 'saved' });
        }
    };
```

- [ ] **Step 4: Verify types**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src/components/dashboard/ContextMenu.tsx app/src/components/Dashboard.tsx
git commit -m "feat: add forward-to-folder context menu + remove flow with leave prompt"
```

---

## Phase 6: Edge Cases + Polish

### Task 22: Handle "not a member" state in file browsing

**Files:**
- Modify: `app/src/components/Dashboard.tsx`
- Modify: `app/src/components/dashboard/FileExplorer.tsx`

- [ ] **Step 1: Catch NOT_A_MEMBER errors in file fetching**

In `usePublicChannels.ts`, update the `usePublicChannelFiles` hook to detect the `NOT_A_MEMBER` error:

```typescript
    const { data, isLoading, error } = useQuery({
        queryKey: ['publicChannelFiles', channelId, 0],
        queryFn: async () => {
            if (!channelId) return { files: [], hasMore: false };
            try {
                const [files, hasMore] = await invoke<[any[], boolean]>('cmd_get_public_channel_files', {
                    channelId,
                    offsetId: null,
                });
                return {
                    files: files.map(f => ({ ...f, sizeStr: formatBytesLocal(f.size) })),
                    hasMore,
                    lastOffsetId: files.length > 0 ? files[files.length - 1].id : null,
                    notAMember: false,
                };
            } catch (e: any) {
                if (String(e).includes('NOT_A_MEMBER')) {
                    return { files: [], hasMore: false, notAMember: true };
                }
                throw e;
            }
        },
        enabled: channelId !== null,
    });
```

- [ ] **Step 2: Show empty state for not-a-member**

In `FileExplorer.tsx`, add a `notAMember` prop and show a custom empty state:

```tsx
            {notAMember && (
                <div className="flex flex-col items-center justify-center h-full gap-3 py-12">
                    <AlertCircle className="w-12 h-12 text-red-500/50" />
                    <p className="text-sm text-nobuf-subtext">
                        You're no longer a member of this channel.
                    </p>
                    <button
                        onClick={onRemoveChannel}
                        className="px-4 py-2 rounded-lg bg-nobuf-primary text-white text-sm font-medium hover:bg-nobuf-primary/90 transition-colors"
                    >
                        Remove from NoBuf
                    </button>
                </div>
            )}
```

- [ ] **Step 3: Wire up from Dashboard**

Pass `notAMember` and `onRemoveChannel` from Dashboard to FileExplorer.

- [ ] **Step 4: Verify + commit**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -5`

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src/components/dashboard/FileExplorer.tsx app/src/components/Dashboard.tsx app/src/hooks/usePublicChannels.ts
git commit -m "feat: handle not-a-member state with empty state + remove button"
```

---

### Task 23: FLOOD_WAIT handling on all new API calls

**Files:**
- Modify: `app/src-tauri/src/commands/public_channels.rs`

- [ ] **Step 1: Add FLOOD_WAIT retry to join and sync commands**

The `map_error` function already extracts FLOOD_WAIT seconds. Add user-friendly error messages:

In `cmd_join_channel_by_link`, wrap the join calls with FLOOD_WAIT detection:

```rust
    // After the join call, check for FLOOD_WAIT
    // map_error already converts to "FLOOD_WAIT_N" format
    // The frontend will display it as a toast
```

The existing `map_error` in `utils.rs` already handles FLOOD_WAIT → `FLOOD_WAIT_N` conversion. All commands that use `.map_err(map_error)` will return the right format. Ensure all new commands use `map_err(map_error)` consistently.

Audit: Check that every `.await` call in `public_channels.rs` uses `.map_err(map_error)` instead of `.map_err(|e| e.to_string())`. Replace any `.map_err(|e| e.to_string())` on Telegram API calls with `.map_err(map_error)`.

- [ ] **Step 2: Verify + commit**

Run: `cd app/src-tauri && cargo check 2>&1 | tail -5`

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add app/src-tauri/src/commands/public_channels.rs
git commit -m "fix: ensure FLOOD_WAIT handling on all public channel API calls"
```

---

### Task 24: Full validation + integration test

**Files:** None (testing only)

- [ ] **Step 1: Run TypeScript check**

Run: `cd app && npx tsc --noEmit 2>&1`
Expected: No errors.

- [ ] **Step 2: Run vitest**

Run: `cd app && npx vitest run 2>&1`
Expected: All existing tests pass (96 tests).

- [ ] **Step 3: Run cargo check**

Run: `cd app/src-tauri && cargo check 2>&1`
Expected: `Finished` with no errors.

- [ ] **Step 4: Run cargo clippy**

Run: `cd app/src-tauri && cargo clippy 2>&1 | tail -20`
Expected: No new warnings from the new code.

- [ ] **Step 5: Manual integration test**

Run: `cd app && npm run tauri dev`

Test the following:
1. App starts, [NB-PUB] sync runs on startup (check terminal logs).
2. Click "+" in Public Channels sidebar section → AddChannelModal opens.
3. Paste a public channel link (e.g., `t.me/telegram`) → preview shows.
4. Click "Join & Add" → channel joins and appears in sidebar.
5. Click the channel in sidebar → files load (50 per page).
6. Read-only banner is visible.
7. Upload button is disabled.
8. Scroll down → more files load (infinite scroll).
9. Select multiple files → right-click → "Forward to folder..." appears.
10. Pick a [NB] folder → progress bar shows → success toast.
11. Click ✕ on a public channel → "Remove from NoBuf?" prompt.
12. "Also leave on Telegram?" prompt → choose "Keep Subscribed".
13. Channel removed from sidebar.
14. Restart app → channels persist (synced from [NB-PUB] or local DB).

- [ ] **Step 6: Final commit**

```bash
cd /d/DEVELOPMENT/Telegram-Drive
git add -A
git commit -m "test: full validation pass — tsc, vitest, cargo check, cargo clippy, manual integration"
```

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `ResolveUsername` rate limited | Medium — affects add-by-link | `map_error` returns FLOOD_WAIT_N; frontend shows wait time |
| [NB-PUB] channel visible in user's Telegram chat list | Low — user sees [NB-PUB] | Documented in About page. Channel title is distinctive. Excluded from NoBuf sidebar. |
| `iter_download` for sync JSON doesn't use semaphore | Low — file is tiny | JSON file is <100KB. Add semaphore for consistency if needed. |
| `forward_messages` doesn't accept `InputPeer` directly | Medium — compile error | Task 9 handles this — may need to convert InputPeer to grammers `Peer` type |
| `Channel` struct construction in peer cache | Medium — missing fields | Use `..Default::default()` for the raw TL Channel struct |
| Large channels slow first load | Medium — UX lag | Paginated 50/page with loading indicator |
| `serde_json` dependency added | Low | Standard crate, minimal compile time impact |

## Out of Scope

- Browsing groups (supergroups) — channels only
- Browsing without joining — all channels require membership
- Download + re-upload for forwarding — only server-side forwardMessages
- Global public channel search/discovery — user must know the link or pick from joined
- Re-encoding or transformation during forward
- Public channel file caching on local disk
- Notifications for new messages in public channels
- Public channel analytics/statistics
- Managing public channel settings (notifications, mute, etc.)
