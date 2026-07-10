use std::sync::Arc;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicBool};
use tokio::sync::{Mutex, Semaphore};
use grammers_client::{Client};
use grammers_client::types::{LoginToken, PasswordToken, Peer};
use crate::download_pool::DownloadPool;

/// Tracks the lifecycle of the Telegram connection
/// 
/// IMPORTANT: The `runner_shutdown` field is critical for preventing stack overflow.
/// When reconnecting, we MUST shutdown the old runner before spawning a new one.
/// Without this, runner tasks accumulate and exhaust the thread stack.
#[derive(Clone)]
pub struct TelegramState {
    pub client: Arc<Mutex<Option<Client>>>,
    pub login_token: Arc<Mutex<Option<LoginToken>>>,
    pub password_token: Arc<Mutex<Option<PasswordToken>>>,
    pub api_id: Arc<Mutex<Option<i32>>>,
    /// Send to this channel to request runner shutdown.
    /// Uses std::sync::Mutex (not tokio) so it can be locked from synchronous
    /// contexts like the RunEvent::Exit handler.
    pub runner_shutdown: Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    /// Counter for debugging runner lifecycle
    pub runner_count: Arc<std::sync::atomic::AtomicU32>,
    /// Cache of folder_id → Peer to avoid O(N) dialog scanning on every operation.
    /// Populated lazily on first resolve_peer call, eagerly during cmd_scan_folders.
    /// Cleared on logout.
    pub peer_cache: Arc<tokio::sync::RwLock<HashMap<i64, Peer>>>,
    /// Set of transfer IDs that have been cancelled. Checked cooperatively
    /// in upload/download chunk loops. Cleared on logout.
    pub cancelled_transfers: Arc<tokio::sync::RwLock<HashSet<String>>>,
    /// Paths of partial download files — cleaned up on app close.
    pub partial_downloads: Arc<tokio::sync::Mutex<Vec<String>>>,
    /// 2 permits: /stream and fMP4 segment download run concurrently. The global rate
    /// limiter (Mutex<u64>) ensures ≥250ms between ALL upload.GetFile calls
    /// across both paths, preventing FLOOD_PREMIUM_WAIT. Downloads overlap
    /// (while /stream downloads, fMP4 segment can throttle+download).
    pub download_semaphore: Arc<Semaphore>,
    /// Global rate limiter: Mutex-protected timestamp (ms since UNIX_EPOCH)
    /// of the last upload.GetFile call. The Mutex makes the check-sleep-store
    /// sequence atomic across concurrent callers, so 2 semaphore permits
    /// can coexist without races.
    pub rate_limiter: Arc<tokio::sync::Mutex<u64>>,
    /// Speed limit for prebuffer/streaming in KB/s. 0 = unlimited.
    /// Read by Actix server.rs after each chunk to inject sleep.
    pub prebuffer_speed_limit_kb: Arc<AtomicU64>,
    /// Speed limit for file downloads in KB/s. 0 = unlimited.
    /// Read by cmd_download_file after each chunk to inject sleep.
    pub download_speed_limit_kb: Arc<AtomicU64>,
    /// Configurable download chunk size in KB (128, 256, or 512).
    /// Default: 512 (max allowed by grammers-client). Read by download
    /// and streaming paths. Smaller chunks improve stability on
    /// high-packet-loss networks at the cost of more API round-trips.
    pub chunk_size_kb: Arc<AtomicU64>,
    /// TCP keep-alive interval in seconds (0 = disabled, 30-120 typical).
    /// Applied to the grammers connection to prevent idle disconnections
    /// through strict VPN tunnels.
    pub keep_alive_interval_sec: Arc<AtomicU64>,
    /// Multi-connection download pool for parallel file transfers.
    /// Each worker has its own TCP connection to the Telegram media DC,
    /// following Telegram's official recommendation for parallel downloads.
    /// Initialized on first successful connection; None until then.
    pub download_pool: Arc<Mutex<Option<DownloadPool>>>,
    /// Whether the player's IOController is actively downloading (NOT paused by lazyLoad).
    /// Set by cmd_report_playback_position from the frontend every ~10s.
    /// When true, the proactive prebuffer throttles itself (100ms delay between
    /// segments) to yield Telegram bandwidth and avoid FLOOD_PREMIUM_WAIT.
    /// When false (IOController paused), proactive prebuffer runs at full speed.
    pub player_actively_downloading: Arc<AtomicBool>,
    /// Latest proactive prebuffer target for each message. Updated by
    /// cmd_report_playback_position so the prebuffer task can slide its window
    /// as the playhead advances instead of being a one-shot fixed-window download.
    /// (current_byte, duration_s, playback_rate, file_size)
    pub proactive_targets: Arc<tokio::sync::RwLock<HashMap<i32, (u64, f64, f64, u64)>>>,
    /// Cache of resolved media objects per message_id. Eliminates repeated
    /// `get_messages_by_id` API calls (which are unthrottled and contribute
    /// to FLOOD_PREMIUM_WAIT). The media object doesn't change between requests
    /// for the same message, so caching is safe.
    pub media_cache: Arc<tokio::sync::RwLock<HashMap<i32, (grammers_client::types::Media, u64)>>>,
    /// QR login token bytes (from auth.exportLoginToken). Stored here so
    /// cmd_auth_qr_poll can call auth.importLoginToken with the same token
    /// to claim the authorization after the user scans the QR code.
    /// Without this, polling only checks is_authorized() which never
    /// transitions to true because the desktop client must explicitly
    /// import the login token to complete the QR handshake.
    pub qr_token: Arc<tokio::sync::Mutex<Option<Vec<u8>>>>,
    /// Stored API hash for QR poll finalization (exportLoginToken needs it)
    pub stored_api_hash: Arc<tokio::sync::Mutex<Option<String>>>,
    /// Stored API id for QR poll finalization
    pub stored_api_id: Arc<std::sync::atomic::AtomicI32>,
    /// Whether we've already called exportLoginToken to finalize QR login
        pub qr_finalized: Arc<std::sync::atomic::AtomicBool>,
        /// Timestamp (ms since epoch) of last exportLoginToken call in QR poll.
        /// Used to throttle calls to every ~15 seconds to avoid flood waits.
        pub last_qr_export_ts: Arc<std::sync::atomic::AtomicI64>,
}

pub mod auth;
pub mod fs;
pub mod preview;
pub mod utils;
pub mod network;
pub mod streaming;
pub mod api_settings;
pub mod sprite;
pub mod archive;
pub mod folder_groups;
pub mod public_channels;

pub use auth::*;
pub use fs::*;
pub use preview::*;
pub use utils::*;
pub use network::*;
pub use streaming::*;
pub use api_settings::*;
pub use archive::*;
pub use folder_groups::*;
pub use public_channels::*;
pub use sprite::*;
