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
