use grammers_client::Client;
use grammers_client::types::Peer;
use grammers_tl_types as tl;
use tauri::{State, Manager};
use serde::{Deserialize, Serialize};
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

// --- Upload size limit (Premium-aware) ---
// grammers exposes no premium() accessor; read the raw TL flag.
// VERIFIED: `pub premium: bool` at generated_types.rs:57654 (grammers rev d07f96f);
// `me.raw` is a public field (peer/user.rs:66) of type `tl::enums::User` with
// variants `User(u)` | `Empty(_)` — premium only on the `User` variant.
// Telegram enforces the true limit server-side; this is client-side pre-validation only.
pub async fn is_premium(client: &Client) -> Result<bool, String> {
    let me = client.get_me().await.map_err(|e| e.to_string())?;
    Ok(match &me.raw {
        tl::enums::User::User(u) => u.premium,
        tl::enums::User::Empty(_) => false,
    })
}

/// Per-file upload limit in bytes: 4 GB Premium, 2 GB free (documentation-based decimal GB).
pub async fn upload_limit_bytes(client: &Client) -> Result<u64, String> {
    Ok(if is_premium(client).await? { 4_000_000_000 } else { 2_000_000_000 })
}

#[tauri::command]
pub fn cmd_log(message: String) {
    log::info!("[FRONTEND] {}", message);
}

/// Ensure ffmpeg is available. If not found in PATH/exe_dir/sidecar, downloads
/// ffmpeg + ffprobe essentials to AppData. Called on app startup.
#[tauri::command]
pub async fn cmd_ensure_ffmpeg() -> Result<String, String> {
    let path = crate::ffmpeg_util::ensure_ffmpeg_or_download()?;
    Ok(path.to_string_lossy().to_string())
}

/// Open a URL in the system's default browser. Only HTTP(S) URLs are allowed.
#[tauri::command]
pub async fn cmd_open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only HTTP(S) URLs can be opened".to_string());
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
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

/// Calculate exponential backoff delay with ~25% random jitter.
/// Prevents thundering herd effects when multiple clients retry simultaneously.
/// - `attempt`: 1-based retry attempt number
/// - `base_ms`: base delay for first attempt
/// - `max_ms`: maximum delay cap
pub fn backoff_with_jitter(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    let shift = attempt.saturating_sub(1).min(10);
    let exp = base_ms.saturating_mul(1u64 << shift);
    let capped = exp.min(max_ms);
    let jitter = (capped as f64 * 0.25 * rand::random::<f64>()) as u64;
    capped + jitter
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backoff_grows_exponentially() {
        let b1 = backoff_with_jitter(1, 5000, 60_000);
        let b2 = backoff_with_jitter(2, 5000, 60_000);
        let b3 = backoff_with_jitter(3, 5000, 60_000);
        // attempt=1: 5000 * 2^0 = 5000, jitter 0-1250 → [5000, 6250]
        // attempt=2: 5000 * 2^1 = 10000, jitter 0-2500 → [10000, 12500]
        // attempt=3: 5000 * 2^2 = 20000, jitter 0-5000 → [20000, 25000]
        assert!(b1 >= 5000 && b1 <= 6250, "b1 should be 5000-6250, got {}", b1);
        assert!(b2 >= 10000 && b2 <= 12500, "b2 should be 10000-12500, got {}", b2);
        assert!(b3 >= 20000 && b3 <= 25000, "b3 should be 20000-25000, got {}", b3);
    }

    #[test]
    fn test_backoff_capped_at_max() {
        // attempt=10: 5000 * 2^9 = 2,560,000 — way over 60,000 cap
        let delay = backoff_with_jitter(10, 5000, 60_000);
        assert!(delay >= 60000 && delay <= 75000, "should be capped at 60000+jitter, got {}", delay);
    }

    #[test]
    fn test_backoff_attempt_zero() {
        let delay = backoff_with_jitter(0, 5000, 60_000);
        // attempt=0: saturating_sub(1)=0, 5000 * 2^0 = 5000, jitter 0-1250
        assert!(delay >= 5000 && delay <= 6250, "attempt 0 should be 5000-6250, got {}", delay);
    }
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
    Ok(true)
}

/// Set the download chunk size in KB. Valid values: 128, 256, 512.
/// Grammers-client caps at 512KB. Smaller chunks improve stability on
/// high-packet-loss networks at the cost of more API round-trips.
#[tauri::command]
pub fn cmd_set_chunk_size(
    chunk_size_kb: u64,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    // Validate: must be 128, 256, or 512
    match chunk_size_kb {
        128 | 256 | 512 => {
            state.chunk_size_kb.store(chunk_size_kb, Ordering::Relaxed);
            log::info!("Chunk size set to {} KB", chunk_size_kb);
            Ok(true)
        }
        _ => Err(format!("Invalid chunk size: {} KB. Must be 128, 256, or 512.", chunk_size_kb)),
    }
}

/// Set TCP keep-alive interval in seconds (0 = disabled, 30-120 typical).
/// Prevents idle disconnections through strict VPN tunnels.
#[tauri::command]
pub fn cmd_set_keep_alive(
    interval_sec: u64,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    // 0 = disabled, otherwise must be 30-120
    if interval_sec != 0 && (interval_sec < 30 || interval_sec > 120) {
        return Err(format!("Keep-alive interval must be 0 (disabled) or 30-120 seconds, got {}", interval_sec));
    }
    state.keep_alive_interval_sec.store(interval_sec, Ordering::Relaxed);
    log::info!("Keep-alive interval set to {} seconds", if interval_sec == 0 { "disabled" } else { "enabled" });
    Ok(true)
}

/// Network settings persisted to network_settings.json in the app data dir.
/// Stores chunk size, keep-alive interval, speed limits, and VPN detection flag.
/// Loaded on startup, saved on change.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NetworkSettings {
    pub chunk_size_kb: u64,
    pub keep_alive_interval_sec: u64,
    pub prebuffer_speed_limit_kb: u64,
    pub download_speed_limit_kb: u64,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            chunk_size_kb: 512,
            keep_alive_interval_sec: 0,
            prebuffer_speed_limit_kb: 0,
            download_speed_limit_kb: 0,
        }
    }
}

fn network_settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("network_settings.json"))
}

/// Load network settings from disk and apply to TelegramState atomics.
pub fn load_and_apply_network_settings(app: &tauri::AppHandle, state: &TelegramState) {
    let path = match network_settings_path(app) {
        Ok(p) => p,
        Err(_) => return,
    };
    let settings: NetworkSettings = match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => NetworkSettings::default(),
    };
    state.chunk_size_kb.store(settings.chunk_size_kb, Ordering::Relaxed);
    state.keep_alive_interval_sec.store(settings.keep_alive_interval_sec, Ordering::Relaxed);
    state.prebuffer_speed_limit_kb.store(settings.prebuffer_speed_limit_kb, Ordering::Relaxed);
    state.download_speed_limit_kb.store(settings.download_speed_limit_kb, Ordering::Relaxed);
    log::info!("Network settings loaded: chunk={}KB keepalive={}s prebuf={}KB/s dl={}KB/s",
        settings.chunk_size_kb, settings.keep_alive_interval_sec,
        settings.prebuffer_speed_limit_kb, settings.download_speed_limit_kb);
}

/// Save current network settings to disk.
#[tauri::command]
pub fn cmd_save_network_settings(
    chunk_size_kb: u64,
    keep_alive_interval_sec: u64,
    prebuffer_speed_limit_kb: u64,
    download_speed_limit_kb: u64,
    app: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    let settings = NetworkSettings {
        chunk_size_kb,
        keep_alive_interval_sec,
        prebuffer_speed_limit_kb,
        download_speed_limit_kb,
    };
    // Apply to state atomics
    state.chunk_size_kb.store(chunk_size_kb, Ordering::Relaxed);
    state.keep_alive_interval_sec.store(keep_alive_interval_sec, Ordering::Relaxed);
    state.prebuffer_speed_limit_kb.store(prebuffer_speed_limit_kb, Ordering::Relaxed);
    state.download_speed_limit_kb.store(download_speed_limit_kb, Ordering::Relaxed);
    // Persist to disk (atomic write: temp + sync + rename)
    let path = network_settings_path(&app)?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut tmp_file = std::fs::File::create(&tmp_path).map_err(|e| format!("Failed to create temp file: {}", e))?;
        tmp_file.write_all(json.as_bytes()).map_err(|e| format!("Failed to write temp file: {}", e))?;
        tmp_file.sync_all().map_err(|e| format!("Failed to sync temp file: {}", e))?;
    }
    std::fs::rename(&tmp_path, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("Failed to rename config file: {}", e)
    })?;

    // Security: Restrict config file permissions to current user only (Unix)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    log::info!("Network settings saved to disk");
    Ok(true)
}

/// Load network settings from disk (for frontend display).
#[tauri::command]
pub fn cmd_get_network_settings(
    app: tauri::AppHandle,
) -> Result<NetworkSettings, String> {
    let path = network_settings_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(serde_json::from_str(&contents).unwrap_or_default()),
        Err(_) => Ok(NetworkSettings::default()),
    }
}


