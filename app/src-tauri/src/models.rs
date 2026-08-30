use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "status", content = "data")]
pub enum AuthState {
    LoggedOut,
    AwaitingCode { phone: String, phone_code_hash: String },
    AwaitingPassword { phone: String },
    LoggedIn,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthResult {
    pub success: bool,
    pub next_step: Option<String>, // "code", "password", "dashboard"
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileMetadata {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub name: String,
    pub size: u64,
    pub mime_type: Option<String>,
    pub file_ext: Option<String>,
    pub created_at: String, 
    pub icon_type: String, 
    pub duration: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FolderMetadata {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    /// True when this folder is an adopted owned/administered channel (not a
    /// [NB]-tagged channel). Rides through ScanResult so the frontend can gate
    /// menu actions (unadopt vs delete). serde default keeps old persisted
    /// folder lists (frontend store) and legacy NB-PUB payloads parsing.
    #[serde(default)]
    pub is_adopted: bool,
}

/// Result of a full reconciliation sync between local state and Telegram.
/// The backend scans all Telegram dialogs, finds NoBuf-tagged channels,
/// and computes the diff against the local folder list passed from the frontend.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScanResult {
    /// New folders found on Telegram that aren't in the local list.
    pub added: Vec<FolderMetadata>,
    /// Existing folders whose name changed on Telegram.
    pub updated: Vec<FolderMetadata>,
    /// Local folder IDs that no longer appear as NoBuf channels on Telegram
    /// (deleted, left, kicked, or tag removed from title).
    pub removed: Vec<i64>,
    /// All currently-valid NoBuf folders found on Telegram (for full state replacement).
    pub current: Vec<FolderMetadata>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Drive {
    pub chat_id: i64,
    pub name: String,
    pub icon: Option<String>,
}

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
    /// True when the logged-in account created this channel.
    #[serde(default)]
    pub is_creator: bool,
    /// True when the logged-in account administers this channel with
    /// post_messages rights (creators get this too, via synthetic rights).
    #[serde(default)]
    pub is_admin_post: bool,
}

/// An owned/administered channel adopted as a full NoBuf folder (no [NB] tag).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AdoptedFolder {
    pub channel_id: i64,
    pub access_hash: i64,
    pub title: String,
    pub adopted_at: i64,
}

/// Result of forwarding files to a [NB] folder.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ForwardResult {
    pub success: bool,
    pub forwarded_count: i32,
    pub errors: Vec<String>,
}
