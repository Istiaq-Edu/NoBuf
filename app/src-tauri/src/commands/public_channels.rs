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
