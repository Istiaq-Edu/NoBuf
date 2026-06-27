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

pub fn parse_channel_link(link: &str) -> Result<(String, String), String> {
    let link = link.trim();
    
    if link.starts_with('@') {
        let username = link[1..].to_string();
        if username.is_empty() {
            return Err("Empty username".to_string());
        }
        return Ok(("username".to_string(), username));
    }
    
    let stripped = if link.starts_with("https://t.me/") {
        &link["https://t.me/".len()..]
    } else if link.starts_with("http://t.me/") {
        &link["http://t.me/".len()..]
    } else if link.starts_with("t.me/") {
        &link["t.me/".len()..]
    } else {
        return Err("Invalid Telegram link. Use t.me/channelname, t.me/+invitehash, or @channelname".to_string());
    };
    
    let path = stripped.split('?').next().unwrap_or(stripped).split('#').next().unwrap_or(stripped);
    
    if path.starts_with('+') {
        let hash = path[1..].to_string();
        if hash.is_empty() {
            return Err("Empty invite hash".to_string());
        }
        return Ok(("invite_hash".to_string(), hash));
    }
    
    if path.starts_with("c/") {
        return Err("Private channel links (t.me/c/...) require an invite link to join. Ask the channel admin for a t.me/+... invite link.".to_string());
    }
    
    if path.starts_with("s/") {
        let username = path["s/".len()..].to_string();
        if username.is_empty() {
            return Err("Empty username".to_string());
        }
        return Ok(("username".to_string(), username));
    }
    
    let username = path.to_string();
    if username.is_empty() {
        return Err("Empty username".to_string());
    }
    if !username.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err("Invalid username format".to_string());
    }
    Ok(("username".to_string(), username))
}

// ─── Peer construction from stored access_hash ───────────────────

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

// ─── Duration extraction ─────────────────────────────────────────

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

// ─── Channel link resolution (preview before join) ───────────────

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
            let raw_result = client.invoke(&grammers_tl_types::functions::contacts::ResolveUsername {
                username: value.clone(),
                referer: None,
            }).await.map_err(map_error)?;

            // ResolveUsername returns contacts::ResolvedPeer enum — unwrap to struct
            let result = grammers_tl_types::types::contacts::ResolvedPeer::from(raw_result);

            let mut found_channel: Option<(i64, i64, String)> = None;
            for chat in &result.chats {
                if let grammers_tl_types::enums::Chat::Channel(c) = chat {
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

            // Check if already joined: the resolved peer matches the channel
            let already_joined = if let grammers_tl_types::enums::Peer::Channel(pc) = &result.peer {
                pc.channel_id == channel_id
            } else {
                false
            };

            Ok(ChannelPreview {
                title,
                about: None,
                participants_count: 0,
                is_channel: true,
                is_private: false,
                already_joined,
                channel_id: Some(channel_id),
                access_hash: Some(access_hash),
                username: Some(value),
            })
        }
        "invite_hash" => {
            let result = client.invoke(&grammers_tl_types::functions::messages::CheckChatInvite {
                hash: value,
            }).await.map_err(map_error)?;

            match result {
                grammers_tl_types::enums::ChatInvite::Invite(invite) => {
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
                grammers_tl_types::enums::ChatInvite::Already(already) => {
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
                grammers_tl_types::enums::ChatInvite::Peek(_) => {
                    Err("This channel allows peeking but NoBuf does not support peek-only access. Please join the channel first.".to_string())
                }
            }
        }
        _ => Err("Unknown link type".to_string()),
    }
}

// ─── Join channel by link + DB insert ─────────────────────────────

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
            let raw_result = client.invoke(&grammers_tl_types::functions::contacts::ResolveUsername {
                username: value.clone(),
                referer: None,
            }).await.map_err(map_error)?;
            let result = grammers_tl_types::types::contacts::ResolvedPeer::from(raw_result);

            let mut found: Option<(i64, i64, String)> = None;
            for chat in &result.chats {
                if let grammers_tl_types::enums::Chat::Channel(c) = chat {
                    if c.broadcast {
                        found = Some((c.id, c.access_hash.unwrap_or(0), c.title.clone()));
                    }
                }
            }
            let (cid, ah, t) = found.ok_or("No channel found with this username")?;

            client.invoke(&grammers_tl_types::functions::channels::JoinChannel {
                channel: build_input_channel(cid, ah),
            }).await.map_err(map_error)?;

            (cid, ah, t, Some(value), false)
        }
        "invite_hash" => {
            let result = client.invoke(&grammers_tl_types::functions::messages::ImportChatInvite {
                hash: value,
            }).await.map_err(map_error)?;

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

    // Deduplication check
    {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT channel_id FROM public_channels WHERE channel_id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
        if stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
            return Err("ALREADY_ADDED: This channel is already added to NoBuf".to_string());
        }
    }

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

// ─── List joined channels from dialogs ───────────────────────────

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
            ids.insert(vi(&stmt.read(0).map_err(|e| e.to_string())?));
        }
        ids
    };

    let mut channels = Vec::new();
    let mut dialogs = client.iter_dialogs();

    while let Some(dialog) = dialogs.next().await.map_err(map_error)? {
        if let Peer::Channel(c) = &dialog.peer {
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

    channels.sort_by(|a, b| {
        match (a.is_nb_folder, b.is_nb_folder) {
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(channels)
}

// ─── Add a joined channel to NoBuf ───────────────────────────────

#[tauri::command]
pub async fn cmd_add_joined_channel(
    channel_id: i64,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<PublicChannel, String> {
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;

    // Deduplication check
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

// ─── Get all public channels from DB ─────────────────────────────

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

// ─── Get files from a public channel (paginated, 50 per page) ───

#[tauri::command]
pub async fn cmd_get_public_channel_files(
    channel_id: i64,
    offset_id: Option<i32>,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<(Vec<FileMetadata>, bool), String> {
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;

    let access_hash = {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT access_hash, is_member FROM public_channels WHERE channel_id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
        if stmt.next().map_err(|e| e.to_string())? != sqlite::State::Row {
            return Err("Channel not found in NoBuf database".to_string());
        }
        let ah = vi(&stmt.read(0).map_err(|e| e.to_string())?);
        let is_member = vb(&stmt.read(1).map_err(|e| e.to_string())?);
        if !is_member {
            return Err("NOT_A_MEMBER: You are no longer a member of this channel".to_string());
        }
        ah
    };

    let input_peer = build_input_peer(channel_id, access_hash);

    let result = client.invoke(&grammers_tl_types::functions::messages::GetHistory {
        peer: input_peer,
        offset_id: offset_id.unwrap_or(0),
        offset_date: 0,
        add_offset: 0,
        limit: 51,
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

    let (messages, _) = match result {
        grammers_tl_types::enums::messages::Messages::Messages(msgs) => (msgs.messages, false),
        grammers_tl_types::enums::messages::Messages::Slice(msgs) => (msgs.messages, true),
        _ => (Vec::new(), false),
    };

    let mut files = Vec::new();
    let limit = 50;
    let mut count = 0;
    let has_more = messages.len() > limit;

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
                    _ => continue,
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

    Ok((files, has_more))
}

// ─── Remove a public channel from NoBuf (+ optionally leave on Telegram) ───

#[tauri::command]
pub async fn cmd_remove_public_channel(
    channel_id: i64,
    leave_on_telegram: bool,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    let access_hash = {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT access_hash FROM public_channels WHERE channel_id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
        if stmt.next().map_err(|e| e.to_string())? != sqlite::State::Row {
            return Err("Channel not found in NoBuf database".to_string());
        }
        vi(&stmt.read(0).map_err(|e| e.to_string())?)
    };

    if leave_on_telegram {
        let client_opt = { state.client.lock().await.clone() };
        if let Some(client) = client_opt {
            client.invoke(&grammers_tl_types::functions::channels::LeaveChannel {
                channel: build_input_channel(channel_id, access_hash),
            }).await.map_err(map_error)?;
        }
    }

    let conn = get_connection(&app)?;
    conn.execute(format!("DELETE FROM public_channels WHERE channel_id = {}", channel_id))
        .map_err(|e| e.to_string())?;

    state.peer_cache.write().await.remove(&channel_id);

    Ok(true)
}

// ─── Forward files from a public channel to a [NB] folder ───

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

    let source_access_hash = {
        let conn = get_connection(&app)?;
        let mut stmt = conn.prepare("SELECT access_hash FROM public_channels WHERE channel_id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, source_channel_id)).map_err(|e| e.to_string())?;
        if stmt.next().map_err(|e| e.to_string())? != sqlite::State::Row {
            return Err("Source channel not found".to_string());
        }
        vi(&stmt.read(0).map_err(|e| e.to_string())?)
    };

    let target_peer = crate::commands::utils::resolve_peer(&client, Some(target_folder_id), &state.peer_cache).await?;
    let source_input_peer = build_input_peer(source_channel_id, source_access_hash);

    let mut errors = Vec::new();
    let mut forwarded = 0;

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

// ─── [NB-PUB] helper functions ───────────────────────────────────

fn get_setting(app: &AppHandle, key: &str) -> Option<String> {
    let conn = get_connection(app).ok()?;
    let mut stmt = conn.prepare("SELECT value FROM nb_pub_settings WHERE key = ?").ok()?;
    stmt.bind((1, key)).ok()?;
    if stmt.next().ok()? == sqlite::State::Row {
        Some(vs(&stmt.read(0).ok()?))
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
    if let Some(id_str) = get_setting(app, "nb_pub_channel_id") {
        if let Ok(id) = id_str.parse::<i64>() {
            return Ok(id);
        }
    }

    let mut dialogs = client.iter_dialogs();
    while let Some(dialog) = dialogs.next().await.map_err(map_error)? {
        if let Peer::Channel(c) = &dialog.peer {
            if c.raw.title.eq_ignore_ascii_case("[NB-PUB]") {
                set_setting(app, "nb_pub_channel_id", &c.raw.id.to_string());
                state.peer_cache.write().await.insert(c.raw.id, dialog.peer.clone());
                return Ok(c.raw.id);
            }
        }
    }

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
    {
        let cache = state.peer_cache.read().await;
        if let Some(Peer::Channel(c)) = cache.get(&channel_id) {
            return Ok(c.raw.access_hash.unwrap_or(0));
        }
    }

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

// ─── Update [NB-PUB] sync (upload current public_channels to NB-PUB channel) ───

#[tauri::command]
pub async fn cmd_update_nb_pub_sync(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    let client_opt = { state.client.lock().await.clone() };
    let client = client_opt.ok_or("Not connected to Telegram")?;

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

    let json_data = serde_json::to_string(&channels).map_err(|e| e.to_string())?;
    let json_bytes = json_data.as_bytes().to_vec();

    let nb_pub_id = find_or_create_nb_pub_channel(&client, &app, &state).await?;
    let ah = get_nb_pub_access_hash(&client, nb_pub_id, &state).await?;

    // Delete old sync message if exists
    if let Some(old_msg_id_str) = get_setting(&app, "nb_pub_message_id") {
        if let Ok(old_id) = old_msg_id_str.parse::<i32>() {
            if old_id > 0 {
                let _ = client.invoke(&grammers_tl_types::functions::channels::DeleteMessages {
                    channel: build_input_channel(nb_pub_id, ah),
                    id: vec![old_id],
                }).await;
            }
        }
    }

    // Upload new JSON file
    let temp_path = std::env::temp_dir().join("nb_pub_sync.json");
    std::fs::write(&temp_path, &json_bytes).map_err(|e| e.to_string())?;

    let uploaded = client.upload_file(&temp_path).await.map_err(|e| e.to_string())?;

    use grammers_client::InputMessage;
    let input_peer = build_input_peer(nb_pub_id, ah);
    let message = InputMessage::new().text("").document(uploaded);
    let sent = client.send_message(&input_peer, message).await.map_err(map_error)?;

    set_setting(&app, "nb_pub_message_id", &sent.id().to_string());

    Ok(true)
}

// ─── Sync public channels (download from NB-PUB and reconcile with local DB) ───

#[tauri::command]
pub async fn cmd_sync_public_channels(
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<Vec<PublicChannel>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return cmd_get_public_channels(app);
    }
    let client = client_opt.unwrap();

    // Try to find [NB-PUB] channel
    let nb_pub_id = if let Some(id_str) = get_setting(&app, "nb_pub_channel_id") {
        id_str.parse::<i64>().ok()
    } else {
        None
    };

    let nb_pub_id = match nb_pub_id {
        Some(id) => id,
        None => {
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
                None => return cmd_get_public_channels(app),
            }
        }
    };

    let ah = get_nb_pub_access_hash(&client, nb_pub_id, &state).await?;
    let input_peer = build_input_peer(nb_pub_id, ah);

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
        return cmd_get_public_channels(app);
    }

    let msg = match &messages[0] {
        grammers_tl_types::enums::Message::Message(m) => m,
        _ => return cmd_get_public_channels(app),
    };

    let media = match &msg.media {
        Some(grammers_tl_types::enums::MessageMedia::Document(d)) => d,
        _ => return cmd_get_public_channels(app),
    };

    let _doc = match &media.document {
        Some(grammers_tl_types::enums::Document::Document(d)) => d,
        _ => return cmd_get_public_channels(app),
    };

    // Download the JSON file content
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

    let remote_channels: Vec<PublicChannel> = serde_json::from_slice(&file_data)
        .map_err(|e| format!("Failed to parse sync JSON: {}", e))?;

    // Reconcile with local DB
    let conn = get_connection(&app)?;

    let mut local_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    {
        let mut stmt = conn.prepare("SELECT channel_id FROM public_channels").map_err(|e| e.to_string())?;
        while stmt.next().map_err(|e| e.to_string())? == sqlite::State::Row {
            local_ids.insert(vi(&stmt.read(0).map_err(|e| e.to_string())?));
        }
    }

    let remote_ids: std::collections::HashSet<i64> = remote_channels.iter().map(|c| c.channel_id).collect();

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

    for local_id in &local_ids {
        if !remote_ids.contains(local_id) {
            conn.execute(format!("DELETE FROM public_channels WHERE channel_id = {}", local_id))
                .map_err(|e| e.to_string())?;
        }
    }

    set_setting(&app, "nb_pub_message_id", &msg.id.to_string());

    // Return reconciled list
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
