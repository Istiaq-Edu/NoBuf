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
    pub size: u64, // Updated to u64
    pub mime_type: Option<String>,
    pub file_ext: Option<String>, // Added field
    pub created_at: String, 
    pub icon_type: String, 
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FolderMetadata {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
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
