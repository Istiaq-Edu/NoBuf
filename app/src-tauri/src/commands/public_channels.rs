use grammers_client::Client;
use grammers_client::types::Peer;
use tauri::{State, AppHandle, Manager};
use sqlite::{Connection, Value};
use std::path::PathBuf;
use crate::commands::TelegramState;
use crate::commands::utils::map_error;
use crate::models::{PublicChannel, ChannelPreview, JoinedChannel, ForwardResult, FileMetadata};

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

    // Legacy invite format: t.me/joinchat/<hash> — same semantics as t.me/+<hash>.
    if path.starts_with("joinchat/") {
        let hash = path["joinchat/".len()..].to_string();
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
            // ResolveUsername returns the resolved peer, not membership status.
                        // JoinChannel is idempotent, so always use the join flow.
                        let already_joined = false;

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
                grammers_tl_types::enums::ChatInvite::Peek(peek) => {
                    // Peekable channel (previewable without joining): the
                    // response carries the full Chat, so we can still show a
                    // preview card — with the id/hash needed for a join.
                    if let grammers_tl_types::enums::Chat::Channel(c) = &peek.chat {
                        Ok(ChannelPreview {
                            title: c.title.clone(),
                            about: None,
                            participants_count: 0,
                            is_channel: c.broadcast,
                            is_private: true,
                            already_joined: false,
                            channel_id: Some(c.id),
                            access_hash: c.access_hash,
                            username: None,
                        })
                    } else {
                        Err("This invite points to a group (NoBuf only supports channels).".to_string())
                    }
                }
            }
        }
        _ => Err("Unknown link type".to_string()),
    }
}

// Chats carried by an Updates response. `messages.ImportChatInvite` can answer
// with either `updates` or `updatesCombined` (the server merges update batches
// when the join produces more updates than a single object carries); matching
// only one variant silently dropped the joined channel and made the add step
// fail AFTER the join had already happened.
fn chats_from_updates(updates: &grammers_tl_types::enums::Updates) -> &[grammers_tl_types::enums::Chat] {
    use grammers_tl_types::enums::Updates;
    match updates {
        Updates::Updates(u) => &u.chats,
        Updates::Combined(u) => &u.chats,
        _ => &[],
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
                hash: value.clone(),
            }).await;

            let mut found: Option<(i64, i64, String)> = None;
            match result {
                Ok(updates) => {
                    for chat in chats_from_updates(&updates) {
                        if let grammers_tl_types::enums::Chat::Channel(c) = chat {
                            if c.broadcast {
                                found = Some((c.id, c.access_hash.unwrap_or(0), c.title.clone()));
                            }
                        }
                    }
                }
                Err(e) => {
                    // A retry of an already-used invite link answers
                    // USER_ALREADY_PARTICIPANT — the join happened on an earlier
                    // attempt. Recover below instead of failing after the mutation.
                    let msg = e.to_string();
                    if !msg.contains("USER_ALREADY_PARTICIPANT") {
                        return Err(map_error(e));
                    }
                }
            }

            // The join happened (or we were already a member) but the response
            // carried no usable broadcast channel. Identify the exact chat via
            // the invite hash itself: as a member, CheckChatInvite answers
            // chatInviteAlready with the full Chat object.
            if found.is_none() {
                let check = client.invoke(&grammers_tl_types::functions::messages::CheckChatInvite {
                    hash: value,
                }).await.map_err(map_error)?;
                if let grammers_tl_types::enums::ChatInvite::Already(already) = check {
                    if let grammers_tl_types::enums::Chat::Channel(c) = already.chat {
                        if c.broadcast {
                            found = Some((c.id, c.access_hash.unwrap_or(0), c.title.clone()));
                        }
                    }
                }
            }

            let (cid, ah, t) = found.ok_or(
                "Joined, but NoBuf could not add it — it may be a group (NoBuf only supports \
                 channels). Leave it in Telegram if you joined it by accident."
            )?;
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
        let mut stmt = conn.prepare(
            "INSERT INTO public_channels (channel_id, name, username, access_hash, is_private, added_at, is_member) VALUES (?, ?, ?, ?, ?, ?, 1)"
        ).map_err(|e| e.to_string())?;
        stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
        stmt.bind((2, title.as_str())).map_err(|e| e.to_string())?;
        if let Some(ref un) = username {
            stmt.bind((3, un.as_str())).map_err(|e| e.to_string())?;
        } else {
            stmt.bind((3, Value::Null)).map_err(|e| e.to_string())?;
        }
        stmt.bind((4, access_hash)).map_err(|e| e.to_string())?;
        stmt.bind((5, if is_private { 1i64 } else { 0 })).map_err(|e| e.to_string())?;
        stmt.bind((6, now)).map_err(|e| e.to_string())?;
        stmt.next().map_err(|e| e.to_string())?;

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

// Fetch a channel by id + access_hash directly. Used when the caller already
// knows the access_hash (e.g. from a CheckChatInvite preview): deterministic,
// no dependency on the dialog list. Channels joined via invite link are
// auto-archived by Telegram and absent from the main dialog list, so a
// dialog scan cannot find them even for members.
async fn resolve_channel_by_hash(
    client: &Client,
    channel_id: i64,
    access_hash: i64,
) -> Result<(String, Option<String>, i64), String> {
    let result = client.invoke(&grammers_tl_types::functions::channels::GetChannels {
        id: vec![build_input_channel(channel_id, access_hash)],
    }).await.map_err(map_error)?;

    match result {
        grammers_tl_types::enums::messages::Chats::Chats(c) => c.chats.into_iter().next(),
        grammers_tl_types::enums::messages::Chats::Slice(c) => c.chats.into_iter().next(),
    }
    .and_then(|chat| match chat {
        grammers_tl_types::enums::Chat::Channel(c) => {
            // getChannels may answer with a min-channel whose access_hash was
            // stripped; trust the hash the caller passed over a None here.
            Some((c.title, c.username, c.access_hash.filter(|h| *h != 0).unwrap_or(access_hash)))
        }
        _ => None,
    })
    .ok_or_else(|| format!("Channel {} not found", channel_id))
}

#[tauri::command]
pub async fn cmd_add_joined_channel(
    channel_id: i64,
    access_hash: Option<i64>,
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

    // Resolve the channel: direct fetch by access_hash when the caller has one
    // (preview of an already-joined channel), else peer cache, else dialog scan.
    // The direct fetch matters because channels joined via invite link are
    // auto-archived by Telegram and never appear in the main dialog list the
    // scan walks (folder_id: None), so the scan alone errors
    // "Channel not found in your dialogs" even though we are a member.
    let (name, username, ah) = if let Some(ah) = access_hash {
        resolve_channel_by_hash(&client, channel_id, ah).await?
    } else {
        let peer = {
            let cache = state.peer_cache.read().await;
            cache.get(&channel_id).cloned()
        };
        if let Some(Peer::Channel(c)) = peer {
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
        }
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
        ah,
        if is_private { 1 } else { 0 },
        now,
    )).map_err(|e| e.to_string())?;

    Ok(PublicChannel {
        channel_id,
        name,
        username,
        access_hash: ah,
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
            limit: 100,
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

        let messages = match result {
            grammers_tl_types::enums::messages::Messages::Messages(msgs) => msgs.messages,
            grammers_tl_types::enums::messages::Messages::Slice(msgs) => msgs.messages,
            grammers_tl_types::enums::messages::Messages::ChannelMessages(msgs) => msgs.messages,
            _ => Vec::new(),
        };

        log::info!("[Public Channel] GetHistory returned {} messages for channel {}", messages.len(), channel_id);

    let mut files = Vec::new();
    let limit = 50;
    let mut count = 0;
    let has_more = messages.len() >= 100;

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

    log::info!("[Public Channel] Extracted {} files (has_more={}) for channel {}", files.len(), has_more, channel_id);

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
        {
            let mut stmt = conn.prepare("DELETE FROM public_channels WHERE channel_id = ?")
                .map_err(|e| e.to_string())?;
            stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
            stmt.next().map_err(|e| e.to_string())?;
        }

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
        log::debug!("[NB-PUB] get_setting: no row for key '{}'", key);
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

    let uploaded = client.upload_file(&temp_path).await.map_err(map_error)?;

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

    let mut file_data = Vec::new();
        let mut download_attempts = 0;
        let max_download_attempts = 3;
        loop {
            download_attempts += 1;
            let mut iter = client.iter_download(&media_obj).chunk_size(64 * 1024);
            let mut success = true;
            file_data.clear();
            loop {
                let chunk_result = {
                    let _permit = state.download_semaphore.acquire().await.unwrap();
                    iter.next().await
                };
                let chunk = match chunk_result {
                    Ok(Some(c)) => c,
                    Ok(None) => break,
                    Err(e) => {
                        log::warn!("[NB-PUB] Sync download error (attempt {}): {}", download_attempts, e);
                        success = false;
                        break;
                    }
                };
                file_data.extend_from_slice(&chunk);
                tokio::task::yield_now().await;
            }
            if success {
                break;
            }
            if download_attempts >= max_download_attempts {
                return Err(format!("Sync download failed after {} attempts", max_download_attempts));
            }
            let delay = std::time::Duration::from_secs(2u64.pow(download_attempts as u32));
            log::info!("[NB-PUB] Retrying sync download in {}s...", delay.as_secs());
            tokio::time::sleep(delay).await;
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
                let mut stmt = conn.prepare("DELETE FROM public_channels WHERE channel_id = ?")
                    .map_err(|e| e.to_string())?;
                stmt.bind((1, *local_id)).map_err(|e| e.to_string())?;
                stmt.next().map_err(|e| e.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_channel_link_accepts_legacy_joinchat_invite() {
        // t.me/joinchat/<hash> is Telegram's legacy invite format, equivalent
        // to t.me/+<hash>. It used to fall through to the username branch and
        // fail the charset check with "Invalid username format".
        assert_eq!(
            parse_channel_link("https://t.me/joinchat/cYEZsXNEvQ9mZGNl").unwrap(),
            ("invite_hash".to_string(), "cYEZsXNEvQ9mZGNl".to_string())
        );
        assert_eq!(
            parse_channel_link("t.me/joinchat/abc123").unwrap(),
            ("invite_hash".to_string(), "abc123".to_string())
        );
        // Plain https://t.me/joinchat (no hash) is username-shaped; it parses
        // as a username and the resolve call fails later with "No channel
        // found" — acceptable, not an invite misclassification.
        assert_eq!(
            parse_channel_link("https://t.me/joinchat").unwrap(),
            ("username".to_string(), "joinchat".to_string())
        );
        // Trailing slash with no hash is an empty invite — must error.
        assert!(parse_channel_link("https://t.me/joinchat/").is_err());
    }

    #[test]
    fn parse_channel_link_accepts_plus_invite_and_username() {
        assert_eq!(
            parse_channel_link("https://t.me/+JVFkVGMNwTdhY2Nh").unwrap(),
            ("invite_hash".to_string(), "JVFkVGMNwTdhY2Nh".to_string())
        );
        assert_eq!(
            parse_channel_link("t.me/+abc").unwrap(),
            ("invite_hash".to_string(), "abc".to_string())
        );
        assert_eq!(
            parse_channel_link("https://t.me/somechannel").unwrap(),
            ("username".to_string(), "somechannel".to_string())
        );
        assert_eq!(
            parse_channel_link("@somechannel").unwrap(),
            ("username".to_string(), "somechannel".to_string())
        );
        // Query strings must be stripped from usernames.
        assert_eq!(
            parse_channel_link("https://t.me/somechannel?foo=bar").unwrap(),
            ("username".to_string(), "somechannel".to_string())
        );
    }

    fn test_channel(id: i64, broadcast: bool) -> grammers_tl_types::enums::Chat {
        grammers_tl_types::enums::Chat::Channel(grammers_tl_types::types::Channel {
            creator: false,
            left: false,
            broadcast,
            verified: false,
            megagroup: false,
            restricted: false,
            signatures: false,
            min: false,
            scam: false,
            has_link: false,
            has_geo: false,
            slowmode_enabled: false,
            call_active: false,
            call_not_empty: false,
            fake: false,
            gigagroup: false,
            noforwards: false,
            join_to_send: false,
            join_request: false,
            forum: false,
            stories_hidden: false,
            stories_hidden_min: false,
            stories_unavailable: false,
            signature_profiles: false,
            autotranslation: false,
            broadcast_messages_allowed: false,
            monoforum: false,
            forum_tabs: false,
            id,
            access_hash: Some(id * 111),
            title: format!("Channel {}", id),
            username: None,
            photo: grammers_tl_types::enums::ChatPhoto::Empty,
            date: 0,
            restriction_reason: None,
            admin_rights: None,
            banned_rights: None,
            default_banned_rights: None,
            participants_count: None,
            usernames: None,
            stories_max_id: None,
            color: None,
            profile_color: None,
            emoji_status: None,
            level: None,
            subscription_until_date: None,
            bot_verification_icon: None,
            send_paid_messages_stars: None,
            linked_monoforum_id: None,
        })
    }

    #[test]
    fn chats_from_updates_extracts_from_updates_variant() {
        let chats = vec![test_channel(1, true)];
        let updates = grammers_tl_types::enums::Updates::Updates(
            grammers_tl_types::types::Updates {
                updates: vec![],
                users: vec![],
                chats,
                date: 0,
                seq: 0,
            },
        );
        assert_eq!(chats_from_updates(&updates).len(), 1);
        assert!(matches!(&chats_from_updates(&updates)[0],
            grammers_tl_types::enums::Chat::Channel(c) if c.id == 1));
    }

    #[test]
    fn chats_from_updates_extracts_from_combined_variant() {
        // The P0 bug: ImportChatInvite answered UpdatesCombined and the old
        // single-variant match dropped the joined channel entirely.
        let chats = vec![test_channel(2, true)];
        let updates = grammers_tl_types::enums::Updates::Combined(
            grammers_tl_types::types::UpdatesCombined {
                updates: vec![],
                users: vec![],
                chats,
                date: 0,
                seq_start: 0,
                seq: 0,
            },
        );
        assert_eq!(chats_from_updates(&updates).len(), 1);
        assert!(matches!(&chats_from_updates(&updates)[0],
            grammers_tl_types::enums::Chat::Channel(c) if c.id == 2));
    }

    #[test]
    fn chats_from_updates_empty_for_non_carrying_variants() {
        // Every other Updates variant carries no chats and must yield empty,
        // never panic, never unwrap None.
        let short_msg = grammers_tl_types::types::UpdateShortMessage {
            out: false, mentioned: false, media_unread: false, silent: false,
            id: 0, user_id: 0, message: String::new(), pts: 0, pts_count: 0,
            date: 0, fwd_from: None, via_bot_id: None, reply_to: None,
            entities: None, ttl_period: None,
        };
        let short_chat = grammers_tl_types::types::UpdateShortChatMessage {
            out: false, mentioned: false, media_unread: false, silent: false,
            id: 0, from_id: 0, chat_id: 0, message: String::new(), pts: 0, pts_count: 0,
            date: 0, fwd_from: None, via_bot_id: None, reply_to: None,
            entities: None, ttl_period: None,
        };
        let short = grammers_tl_types::types::UpdateShort {
            update: grammers_tl_types::enums::Update::MessageId(
                grammers_tl_types::types::UpdateMessageId { id: 0, random_id: 0 }),
            date: 0,
        };
        let short_sent = grammers_tl_types::types::UpdateShortSentMessage {
            out: false, id: 0, pts: 0, pts_count: 0, date: 0,
            media: None, entities: None, ttl_period: None,
        };
        let cases = vec![
            grammers_tl_types::enums::Updates::TooLong,
            grammers_tl_types::enums::Updates::UpdateShortMessage(short_msg),
            grammers_tl_types::enums::Updates::UpdateShortChatMessage(short_chat),
            grammers_tl_types::enums::Updates::UpdateShort(short),
            grammers_tl_types::enums::Updates::UpdateShortSentMessage(short_sent),
        ];
        for updates in &cases {
            assert!(chats_from_updates(updates).is_empty(),
                "expected empty chats for {:?}", updates);
        }
    }

    #[test]
    fn invite_join_broadcast_pick_prefers_broadcast_channel() {
        // Mirrors the extraction loop in cmd_join_channel_by_link: a megagroup
        // (broadcast=false) must not be picked as the joined channel.
        let chats = vec![test_channel(3, false), test_channel(4, true)];
        let updates = grammers_tl_types::enums::Updates::Combined(
            grammers_tl_types::types::UpdatesCombined {
                updates: vec![],
                users: vec![],
                chats,
                date: 0,
                seq_start: 0,
                seq: 0,
            },
        );
        let found = chats_from_updates(&updates).iter().find_map(|chat| {
            if let grammers_tl_types::enums::Chat::Channel(c) = chat {
                if c.broadcast { Some((c.id, c.access_hash.unwrap_or(0), c.title.clone())) } else { None }
            } else {
                None
            }
        });
        let (cid, _ah, _t) = found.expect("broadcast channel must be found");
        assert_eq!(cid, 4);
    }
}
