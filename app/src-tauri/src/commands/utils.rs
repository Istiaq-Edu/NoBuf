use grammers_client::Client;
use grammers_client::types::Peer;
use tauri::State;
use crate::bandwidth::BandwidthManager;
use crate::commands::TelegramState;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::sync::RwLock;

/// Resolve a folder_id to a Telegram Peer, using the cache for O(1) lookups.
///
/// - `folder_id == None` → returns the user's own peer (Saved Messages)
/// - Cache hit → returns immediately without any network call
/// - Cache miss → scans all dialogs, populates the cache, and returns
pub async fn resolve_peer(
    client: &Client,
    folder_id: Option<i64>,
    peer_cache: &Arc<RwLock<HashMap<i64, Peer>>>,
) -> Result<Peer, String> {
    if let Some(fid) = folder_id {
        // Fast path: check cache
        {
            let cache = peer_cache.read().await;
            if let Some(peer) = cache.get(&fid) {
                return Ok(peer.clone());
            }
        }

        // Slow path: scan dialogs and populate cache
        // log::debug!("Peer cache miss for folder_id={}, scanning dialogs...", fid);
        let mut found: Option<Peer> = None;
        let mut dialogs = client.iter_dialogs();
        let mut cache = peer_cache.write().await;
        while let Some(dialog) = dialogs.next().await.map_err(|e| e.to_string())? {
            let peer_id = match &dialog.peer {
                Peer::Channel(c) => Some(c.raw.id),
                Peer::User(u) => Some(u.raw.id()),
                _ => None,
            };
            if let Some(id) = peer_id {
                cache.insert(id, dialog.peer.clone());
                if id == fid {
                    found = Some(dialog.peer.clone());
                    // Don't break — keep scanning to warm the cache
                }
            }
        }

        found.ok_or_else(|| format!("Folder/Chat {} not found", fid))
    } else {
        match client.get_me().await {
            Ok(me) => Ok(Peer::User(me)),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Clear the peer cache (called on logout)
pub async fn clear_peer_cache(peer_cache: &Arc<RwLock<HashMap<i64, Peer>>>) {
    peer_cache.write().await.clear();
}

#[tauri::command]
pub fn cmd_log(message: String) {
    log::info!("[FRONTEND] {}", message);
}

#[tauri::command]
pub fn cmd_get_bandwidth(bw_state: State<'_, BandwidthManager>) -> crate::bandwidth::BandwidthStats {
    bw_state.get_stats()
}

pub fn map_error(e: impl std::fmt::Display) -> String {
    let err_str = e.to_string();
    if err_str.contains("FLOOD_WAIT") {
        // Expected format: ... (value: 1234)
        if let Some(start) = err_str.find("(value: ") {
             let rest = &err_str[start + 8..];
             if let Some(end) = rest.find(')') {
                 if let Ok(seconds) = rest[..end].parse::<i64>() {
                     return format!("FLOOD_WAIT_{}", seconds);
                 }
             }
        }
        // Fallback if parsing fails but we know it's a flood wait
        return "FLOOD_WAIT_60".to_string();
    }
    err_str
}

/// Set speed limits for prebuffer (streaming) and download (file download panel).
/// Values in KB/s. 0 = unlimited. Stored atomically so the Actix server
/// and download loops can read them without async locks.
#[tauri::command]
pub fn cmd_set_speed_limits(
    prebuffer_limit_kb: u64,
    download_limit_kb: u64,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    state.prebuffer_speed_limit_kb.store(prebuffer_limit_kb, Ordering::Relaxed);
    state.download_speed_limit_kb.store(download_limit_kb, Ordering::Relaxed);
    // let prebuf_str = if prebuffer_limit_kb == 0 { "unlimited" } else { &prebuffer_limit_kb.to_string() };
    // let dl_str = if download_limit_kb == 0 { "unlimited" } else { &download_limit_kb.to_string() };
    // log::info!("[THROTTLE-DBG] cmd_set_speed_limits called: prebuffer={} KB/s, download={} KB/s", prebuf_str, dl_str);
    Ok(true)
}
