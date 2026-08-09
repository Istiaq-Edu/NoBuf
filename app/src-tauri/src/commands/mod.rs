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
    /// Millisecond wall-clock timestamp (UNIX epoch) of the last report that said
    /// the player's IOController is actively downloading; 0 = idle. Set by
    /// cmd_report_playback_position. The proactive prebuffer yields while the
    /// timestamp is FRESH (see player_download_flag_fresh) and resumes once it
    /// decays. Round-9 I-2b: this was an AtomicBool that only that command ever
    /// wrote — the MKV seek path stores `true` and has no periodic reporter to
    /// clear it, so one MKV seek starved PROACTIVE for the rest of the session
    /// (9-t: 0 bytes downloaded in 70s, offset frozen). Freshness-decay makes a
    /// stale `true` self-heal while keeping MP4 (2s cadence) and TS (10s cadence)
    /// semantics identical.
    pub player_actively_downloading: Arc<AtomicU64>,
    /// Round-14 F1: epoch-ms of the last `seek-bisect` probe seen by /stream;
    /// 0 = none. PROACTIVE declines to spawn while this is FRESH (see
    /// `seek_critical_read_fresh`), so a cue-less MKV bisect does not race an
    /// 893 MB background prefetch for the 300ms-spaced Telegram limiter
    /// (observed 14-t:184-187 — the prefetch spawned in the same second as the
    /// first probe). A TIMESTAMP, never a bool: round-9 I-2b proved a sticky
    /// flag here starves the prefetch permanently (0 bytes in 70s).
    pub seek_critical_read_at: Arc<AtomicU64>,
    /// Latest proactive prebuffer target for each message. Updated by
    /// cmd_report_playback_position so the prebuffer task can slide its window
    /// as the playhead advances instead of being a one-shot fixed-window download.
    /// (current_byte, duration_s, playback_rate, file_size)
    pub proactive_targets: Arc<tokio::sync::RwLock<HashMap<i32, (u64, f64, f64, u64)>>>,
    pub proactive_generations: Arc<tokio::sync::RwLock<HashMap<i32, u64>>>,
    /// Exact media duration (seconds) as resolved by the /remux ffprobe pass,
    /// keyed by message_id. The /fmp4/metadata endpoint (which the seek bar reads)
    /// otherwise derives duration from Telegram DocumentAttributeVideo → PTS-tail →
    /// bitrate estimate, and for HEVC MKV that estimate is wrong (e.g. 1904s vs a
    /// real 2317s), truncating the seek bar and mis-mapping every seek. When /remux
    /// has probed the file we cache the true value here so /fmp4/metadata can prefer
    /// it. Only populated for files that went through the remux probe.
    pub probed_durations: Arc<tokio::sync::RwLock<HashMap<i32, f64>>>,
    /// Memoized /audio_tracks probe result (serialized JSON) keyed by
    /// message_id. A file's stream layout is immutable, and each probe costs an
    /// ffprobe pass over the (possibly uncached, rate-limited) stream — memoize
    /// so menu re-opens and player re-inits don't re-probe.
    pub audio_tracks_json: Arc<tokio::sync::RwLock<HashMap<i32, String>>>,
    /// Memoized /subtitles list probe result (serialized JSON) keyed by
    /// message_id. Same rationale as `audio_tracks_json`: stream layout is
    /// immutable per file and each probe costs an ffprobe pass over the
    /// (possibly uncached, rate-limited) stream.
    pub sub_tracks_json: Arc<tokio::sync::RwLock<HashMap<(i64, i32), String>>>,
    /// PTS-tail-derived duration (seconds) keyed by message_id. Computing this
    /// requires downloading the last 512KB of the file from Telegram to read the
    /// final video PTS. That value never changes for a given file, but the
    /// /fmp4/metadata endpoint previously re-downloaded the tail on EVERY call
    /// (the frontend retries up to 6× waiting for the ffprobe duration): the
    /// tail-reuse gate checks for the last 10MB cached, while the tail path only
    /// writes back 512KB, so the reuse check could never hit. Memoize the
    /// computed value here so repeat calls short-circuit instead of re-downloading
    /// over the rate-limited Telegram pipe during cold start.
    pub tail_pts_durations: Arc<tokio::sync::RwLock<HashMap<i32, f64>>>,
    /// Memoized outcome of the Telegram DocumentAttributeVideo duration lookup,
    /// keyed by message_id. Resolving it calls `get_messages_by_id` (an UNCACHED,
    /// unthrottled API call that contributes to FLOOD_PREMIUM_WAIT). The frontend
    /// retries /fmp4/metadata up to 6× waiting for the ffprobe duration, and each
    /// retry previously re-hit that API call — even for files with no video attrs
    /// (which return the same None every time). The raw message attributes are
    /// immutable per file, so cache the result: `Some(Some(d))` = duration found,
    /// `Some(None)` = checked, no video attrs; absent = not yet checked.
    pub telegram_durations: Arc<tokio::sync::RwLock<HashMap<i32, Option<f64>>>>,
    /// Cache of resolved media objects per message_id. Eliminates repeated
    /// `get_messages_by_id` API calls (which are unthrottled and contribute
    /// to FLOOD_PREMIUM_WAIT). The media object doesn't change between requests
    /// for the same message, so caching is safe.
    pub media_cache: Arc<tokio::sync::RwLock<HashMap<(i64, i32), (grammers_client::types::Media, u64)>>>,
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
    /// Progressive hover-thumbnail keyframe index, keyed by message_id. Built
    /// incrementally by the background/proactive download loops as they sweep
    /// bytes to disk (they scan each written chunk with scan_keyframes_chunked
    /// and merge here), and READ by the Actix /fmp4 keyframe-at hover lookup.
    /// This is the ONLY meeting point between the Tauri-spawned download task and
    /// the Actix HTTP handlers (the fmp4 byte_time_cache is Actix web::Data and
    /// unreachable from the download task). In-memory only — rebuilt per session,
    /// so there is no cross-restart staleness. Lets warm hovers resolve instantly
    /// from bytes already downloaded instead of triggering an 8s on-demand scan.
    pub proactive_keyframe_index:
        Arc<tokio::sync::RwLock<HashMap<i32, crate::ts_demux::KeyframeIndex>>>,
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
