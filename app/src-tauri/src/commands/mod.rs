use std::sync::Arc;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicU64;
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
    /// Serializes all Telegram iter_download calls across player prebuffer and
    /// file download. Increased from 1 to 4 to allow concurrent streaming +
    /// background cache + file downloads via the DownloadPool.
    pub download_semaphore: Arc<Semaphore>,
    /// Speed limit for prebuffer/streaming in KB/s. 0 = unlimited.
    /// Read by Actix server.rs after each chunk to inject sleep.
    pub prebuffer_speed_limit_kb: Arc<AtomicU64>,
    /// Speed limit for file downloads in KB/s. 0 = unlimited.
    /// Read by cmd_download_file after each chunk to inject sleep.
    pub download_speed_limit_kb: Arc<AtomicU64>,
    /// Multi-connection download pool for parallel file transfers.
    /// Each worker has its own TCP connection to the Telegram media DC,
    /// following Telegram's official recommendation for parallel downloads.
    /// Initialized on first successful connection; None until then.
    pub download_pool: Arc<Mutex<Option<DownloadPool>>>,
}

pub mod auth;
pub mod fs;
pub mod preview;
pub mod utils;
pub mod network;
pub mod streaming;
pub mod api_settings;
pub mod sprite;

pub use auth::*;
pub use fs::*;
pub use preview::*;
pub use utils::*;
pub use network::*;
pub use streaming::*;
pub use api_settings::*;
pub use sprite::*;
