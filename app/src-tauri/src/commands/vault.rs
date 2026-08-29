use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, Manager};
use std::path::PathBuf;
use std::sync::Mutex;

use pbkdf2::pbkdf2_hmac;

/// Lock to serialize vault.json access (same TOCTOU discipline as api_settings::ConfigLock).
pub struct VaultLock(pub Mutex<()>);

const VAULT_FILE: &str = "vault.json";
/// OWASP-recommended iteration count for PBKDF2-HMAC-SHA256 (2023+).
pub const PBKDF2_ITERATIONS: u32 = 600_000;
const SALT_BYTES: usize = 16; // 32 hex chars
const HASH_BYTES: usize = 32; // SHA-256 output

fn default_iterations() -> u32 {
    PBKDF2_ITERATIONS
}

fn default_true() -> bool {
    true
}

/// Persisted vault state. Every field carries #[serde(default)] so an older
/// file still loads after an app update and unknown future fields are ignored.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct VaultStore {
    #[serde(default)]
    pub passcode_hash: Option<String>,
    #[serde(default)]
    pub salt: Option<String>,
    #[serde(default = "default_iterations")]
    pub iterations: u32,
    #[serde(default)]
    pub vaulted_folder_ids: Vec<i64>,
    #[serde(default)]
    pub vaulted_public_channel_ids: Vec<i64>,
    #[serde(default = "default_true")]
    pub entry_visible: bool,
    /// Saved Messages message id carrying the sync blob (edit-in-place).
    #[serde(default)]
    pub sync_message_id: Option<i32>,
    /// Monotonic local revision, bumped on every save. Sync compares this
    /// against the revision embedded in the cloud blob to decide whether the
    /// other side has changed since our last sync — replaces mtime/message-
    /// date heuristics that break under edit-one-message pushes.
    #[serde(default)]
    pub rev: u64,
}

impl Default for VaultStore {
    fn default() -> Self {
        Self {
            passcode_hash: None,
            salt: None,
            iterations: PBKDF2_ITERATIONS,
            vaulted_folder_ids: Vec::new(),
            vaulted_public_channel_ids: Vec::new(),
            entry_visible: true,
            sync_message_id: None,
            rev: 0,
        }
    }
}

/// What the frontend sees. IDs are included ONLY when unlocked — locked
/// responses never carry the hidden lists (counts are always present, D15).
#[derive(Debug, Serialize, Clone)]
pub struct VaultStateResponse {
    pub has_passcode: bool,
    pub is_unlocked: bool,
    pub entry_visible: bool,
    pub folder_count: usize,
    pub public_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_ids: Option<Vec<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_ids: Option<Vec<i64>>,
}

// ---------------------------------------------------------------------------
// Pure core (headless-testable, no Tauri types) — command wrappers below.
// ---------------------------------------------------------------------------

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(VAULT_FILE))
}

/// Load vault.json. Corrupt/unreadable/missing → Default (empty vault),
/// matching api_settings::load_settings semantics. Never crashes.
pub fn load_store(app: &AppHandle) -> VaultStore {
    let path = match vault_path(app) {
        Ok(p) => p,
        Err(_) => return VaultStore::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => VaultStore::default(),
    }
}

/// Atomic write: .tmp → sync_all → rename over target (Windows-safe as shipped
/// in api_settings.rs:57-68). Caller must hold VaultLock.
pub(crate) fn save_store(app: &AppHandle, store: &mut VaultStore) -> Result<(), String> {
    // Monotonic local revision (sync review F1): every save stamps this so
    // vault_sync can compare "local changed since last sync" without relying
    // on file mtime (unreliable across machines/clock skew) or message date
    // (frozen by edit-one-message pushes).
    store.rev = store.rev.max(1) + 1;
    let path = vault_path(app)?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut tmp_file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temp file: {}", e))?;
        tmp_file
            .write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write temp file: {}", e))?;
        tmp_file
            .sync_all()
            .map_err(|e| format!("Failed to sync temp file: {}", e))?;
    }
    std::fs::rename(&tmp_path, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("Failed to rename vault file: {}", e)
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

/// PBKDF2-HMAC-SHA256 over `salt || passcode`, `iterations` rounds.
fn derive_hash(passcode: &str, salt_hex: &str, iterations: u32) -> Result<String, String> {
    let salt = hex::decode(salt_hex).map_err(|_| "Corrupt salt in vault store".to_string())?;
    let mut out = [0u8; HASH_BYTES];
    pbkdf2_hmac::<Sha256>(passcode.as_bytes(), &salt, iterations, &mut out);
    Ok(hex::encode(out))
}

fn generate_salt() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; SALT_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Passcode policy: numeric, 4–12 digits (D6). Enforced backend-side too.
fn validate_passcode(passcode: &str) -> Result<(), String> {
    let ok_len = (4..=12).contains(&passcode.chars().count());
    let ok_digits = passcode.chars().all(|c| c.is_ascii_digit());
    if ok_len && ok_digits {
        Ok(())
    } else {
        Err("Passcode must be 4-12 digits".to_string())
    }
}

/// Set (or overwrite) the passcode on an already-loaded store.
/// Returns a new store; caller persists.
pub fn store_set_passcode(mut store: VaultStore, passcode: &str) -> Result<VaultStore, String> {
    validate_passcode(passcode)?;
    let salt = generate_salt();
    // Always hash at current recommended strength regardless of what an old
    // file carried; verify() accepts the stored iterations for old hashes.
    store.iterations = PBKDF2_ITERATIONS;
    store.salt = Some(salt.clone());
    store.passcode_hash = Some(derive_hash(passcode, &salt, PBKDF2_ITERATIONS)?);
    Ok(store)
}

/// Verify a passcode against the stored hash using constant-time comparison
/// (same idiom as api_settings::verify_key).
pub fn store_verify(store: &VaultStore, passcode: &str) -> Result<bool, String> {
    match (&store.passcode_hash, &store.salt) {
        (Some(stored), Some(salt)) => {
            let computed = derive_hash(passcode, salt, store.iterations)?;
            Ok(constant_time_eq::constant_time_eq(
                computed.as_bytes(),
                stored.as_bytes(),
            ))
        }
        _ => Err("No passcode is set".to_string()),
    }
}

/// Remove every occurrence of `ids` from the folder list. Idempotent,
/// works while locked (intersection-only — reveals nothing).
pub fn prune_folder_ids(mut store: VaultStore, ids: &[i64]) -> VaultStore {
    store.vaulted_folder_ids.retain(|id| !ids.contains(id));
    store
}

/// Remove every occurrence of `ids` from the public-channel list. Idempotent.
pub fn prune_public_ids(mut store: VaultStore, ids: &[i64]) -> VaultStore {
    store
        .vaulted_public_channel_ids
        .retain(|id| !ids.contains(id));
    store
}

/// Hidden-ID sets when the vault is locked, None when unlocked. Used by
/// cmd_search_global (fs.rs): global Telegram search results carry their source
/// peer id, which would otherwise leak vaulted folders'/channels' filenames past
/// the lock. Load once per search call, not per result.
pub fn hidden_ids_if_locked(app: &AppHandle, unlocked: bool) -> Option<(Vec<i64>, Vec<i64>)> {
    if unlocked {
        return None;
    }
    let store = load_store(app);
    Some((
        store.vaulted_folder_ids.clone(),
        store.vaulted_public_channel_ids.clone(),
    ))
}

/// Pure predicate for the search filter: keep a result unless its source peer
/// id is hidden in EITHER scope while locked. Headless-testable.
pub fn search_result_keeps(
    hidden: &Option<(Vec<i64>, Vec<i64>)>,
    folder_id: Option<i64>,
) -> bool {
    let Some((folders, publics)) = hidden else {
        return true;
    };
    match folder_id {
        Some(id) => !folders.contains(&id) && !publics.contains(&id),
        // Results with no resolvable peer (shouldn't happen for channel docs)
        // cannot point into a vaulted scope — keep them.
        None => true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultKind {
    Folder,
    PublicChannel,
}

pub fn parse_kind(kind: &str) -> Result<VaultKind, String> {
    match kind {
        "folder" => Ok(VaultKind::Folder),
        "public_channel" => Ok(VaultKind::PublicChannel),
        _ => Err("kind must be 'folder' or 'public_channel'".to_string()),
    }
}

/// Public state response for cross-module callers (vault_sync pull result).
/// Reflects the REAL runtime unlock flag — a hardcoded false here would
/// force-lock the UI whenever a sync event fires while the user is inside
/// the unlocked vault (review finding E).
pub fn state_response_public(app: &AppHandle, store: &VaultStore) -> VaultStateResponse {
    state_response(store, is_unlocked_public(app))
}

fn state_response(store: &VaultStore, unlocked: bool) -> VaultStateResponse {
    // ID lists are ALWAYS included. Earlier revs withheld them while locked
    // as an "info-leak guard" — that design was wrong (spec §4.2 corrected):
    // the IDs gate which channels OUR OWN UI must conceal, so the frontend
    // needs them precisely while locked. vault.json sits in app-data where
    // any attacker who could exploit leaked ids can read it directly; hiding
    // them only broke the feature after every relaunch.
    VaultStateResponse {
        has_passcode: store.passcode_hash.is_some(),
        is_unlocked: unlocked,
        entry_visible: store.entry_visible,
        folder_count: store.vaulted_folder_ids.len(),
        public_count: store.vaulted_public_channel_ids.len(),
        folder_ids: Some(store.vaulted_folder_ids.clone()),
        public_ids: Some(store.vaulted_public_channel_ids.clone()),
    }
}

// ---------------------------------------------------------------------------
// In-memory unlocked flag. Single source of truth for lock state (the frontend
// context only mirrors it). Starts false every launch (D4: re-lock on reopen;
// tray minimize does not re-lock because the process keeps living).
// ---------------------------------------------------------------------------

pub struct VaultUnlocked(pub std::sync::atomic::AtomicBool);

fn is_unlocked(app: &AppHandle) -> bool {
    app.try_state::<VaultUnlocked>()
        .map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// Public reader for cross-module callers (cmd_search_global in fs.rs).
pub fn is_unlocked_public(app: &AppHandle) -> bool {
    is_unlocked(app)
}

fn set_unlocked(app: &AppHandle, v: bool) {
    if let Some(s) = app.try_state::<VaultUnlocked>() {
        s.0.store(v, std::sync::atomic::Ordering::Relaxed);
    }
}

fn require_unlocked(app: &AppHandle) -> Result<(), String> {
    if is_unlocked(app) {
        Ok(())
    } else {
        Err("vault_locked".to_string())
    }
}

// ---------------------------------------------------------------------------
// Commands (10)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cmd_vault_get_state(app: AppHandle) -> Result<VaultStateResponse, String> {
    let store = load_store(&app);
    Ok(state_response(&store, is_unlocked(&app)))
}

#[tauri::command]
pub async fn cmd_vault_hide(
    app: AppHandle,
    kind: String,
    id: i64,
) -> Result<VaultStateResponse, String> {
    let parsed_kind = parse_kind(&kind)?;
    let lock = app.state::<VaultLock>();
    let _guard = lock.0.lock().map_err(|e| format!("Vault lock error: {}", e))?;
    let store = load_store(&app);

    // First-hide gating (D16): creating the passcode is mandatory before the
    // first hide. Frontend opens the create dialog on this error.
    if store.passcode_hash.is_none() {
        return Err("passcode_required".to_string());
    }

    let mut store = store;
    match parsed_kind {
        VaultKind::Folder => {
            if !store.vaulted_folder_ids.contains(&id) {
                store.vaulted_folder_ids.push(id);
                save_store(&app, &mut store)?;
            }
        }
        VaultKind::PublicChannel => {
            if !store.vaulted_public_channel_ids.contains(&id) {
                store.vaulted_public_channel_ids.push(id);
                save_store(&app, &mut store)?;
            }
        }
    }
    Ok(state_response(&store, is_unlocked(&app)))
}

#[tauri::command]
pub async fn cmd_vault_unhide(
    app: AppHandle,
    kind: String,
    id: i64,
) -> Result<VaultStateResponse, String> {
    let parsed_kind = parse_kind(&kind)?;
    require_unlocked(&app)?;
    let lock = app.state::<VaultLock>();
    let _guard = lock.0.lock().map_err(|e| format!("Vault lock error: {}", e))?;
    let mut store = match parsed_kind {
        VaultKind::Folder => prune_folder_ids(load_store(&app), &[id]),
        VaultKind::PublicChannel => prune_public_ids(load_store(&app), &[id]),
    };
    save_store(&app, &mut store)?;
    Ok(state_response(&store, true))
}

#[tauri::command]
pub async fn cmd_vault_verify(
    app: AppHandle,
    passcode: String,
) -> Result<VaultStateResponse, String> {
    let store = load_store(&app);
    if store_verify(&store, &passcode)? {
        set_unlocked(&app, true);
        Ok(state_response(&store, true))
    } else {
        Err("wrong_passcode".to_string())
    }
}

#[tauri::command]
pub async fn cmd_vault_set_passcode(
    app: AppHandle,
    passcode: String,
) -> Result<VaultStateResponse, String> {
    validate_passcode(&passcode)?;
    let lock = app.state::<VaultLock>();
    let _guard = lock.0.lock().map_err(|e| format!("Vault lock error: {}", e))?;
    let existing = load_store(&app);

    // Overwriting an EXISTING passcode requires being inside the unlocked
    // vault. Setting it for the first time (D16 flow) is allowed while locked
    // by design — that IS the create-passcode dialog path.
    if existing.passcode_hash.is_some() && !is_unlocked(&app) {
        return Err("vault_locked".to_string());
    }

    let mut store = store_set_passcode(existing, &passcode)?;
    save_store(&app, &mut store)?;
    Ok(state_response(&store, is_unlocked(&app)))
}

#[tauri::command]
pub async fn cmd_vault_change_passcode(
    app: AppHandle,
    new_passcode: String,
) -> Result<VaultStateResponse, String> {
    require_unlocked(&app)?;
    let lock = app.state::<VaultLock>();
    let _guard = lock.0.lock().map_err(|e| format!("Vault lock error: {}", e))?;
    let mut store = store_set_passcode(load_store(&app), &new_passcode)?;
    save_store(&app, &mut store)?;
    Ok(state_response(&store, true))
}

#[tauri::command]
pub async fn cmd_vault_lock(app: AppHandle) -> Result<VaultStateResponse, String> {
    set_unlocked(&app, false);
    let store = load_store(&app);
    Ok(state_response(&store, false))
}

#[tauri::command]
pub async fn cmd_vault_reset(app: AppHandle) -> Result<VaultStateResponse, String> {
    // Recovery path (D8): works while locked BY DESIGN. One confirm dialog in
    // the UI. Wipes passcode + both ID lists; entry visibility survives.
    let lock = app.state::<VaultLock>();
    let _guard = lock.0.lock().map_err(|e| format!("Vault lock error: {}", e))?;
    let mut store = load_store(&app);
    store.passcode_hash = None;
    store.salt = None;
    store.iterations = PBKDF2_ITERATIONS;
    store.vaulted_folder_ids.clear();
    store.vaulted_public_channel_ids.clear();
    save_store(&app, &mut store)?;
    set_unlocked(&app, false);
    Ok(state_response(&store, false))
}

/// Logout hygiene (spec rev 4): clear BOTH hidden-ID lists but KEEP the
/// passcode, then re-lock. Needed because SQLite public channels survive
/// logout while `is_member` has no false-refresh path — stale cross-account
/// IDs could otherwise never be removed without account A's passcode.
/// Works while locked (reveals nothing; wipes only).
#[tauri::command]
pub async fn cmd_vault_wipe_ids(app: AppHandle) -> Result<VaultStateResponse, String> {
    let lock = app.state::<VaultLock>();
    let _guard = lock.0.lock().map_err(|e| format!("Vault lock error: {}", e))?;
    let mut store = load_store(&app);
    store.vaulted_folder_ids.clear();
    store.vaulted_public_channel_ids.clear();
    save_store(&app, &mut store)?;
    set_unlocked(&app, false);
    Ok(state_response(&store, false))
}

#[tauri::command]
pub async fn cmd_vault_prune(
    app: AppHandle,
    kind: String,
    ids: Vec<i64>,
) -> Result<VaultStateResponse, String> {
    let parsed_kind = parse_kind(&kind)?;
    let lock = app.state::<VaultLock>();
    let _guard = lock.0.lock().map_err(|e| format!("Vault lock error: {}", e))?;
    let mut store = match parsed_kind {
        VaultKind::Folder => prune_folder_ids(load_store(&app), &ids),
        VaultKind::PublicChannel => prune_public_ids(load_store(&app), &ids),
    };
    save_store(&app, &mut store)?;
    Ok(state_response(&store, is_unlocked(&app)))
}

#[tauri::command]
pub async fn cmd_vault_set_entry_visible(
    app: AppHandle,
    visible: bool,
) -> Result<VaultStateResponse, String> {
    let lock = app.state::<VaultLock>();
    let _guard = lock.0.lock().map_err(|e| format!("Vault lock error: {}", e))?;
    let mut store = load_store(&app);
    store.entry_visible = visible;
    save_store(&app, &mut store)?;
    Ok(state_response(&store, is_unlocked(&app)))
}

// ---------------------------------------------------------------------------
// Tests — headless pure-fn coverage (api_settings.rs pattern).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PASSCODE: &str = "4321";

    fn base_store() -> VaultStore {
        VaultStore::default()
    }

    fn with_passcode() -> VaultStore {
        store_set_passcode(base_store(), TEST_PASSCODE).unwrap()
    }

    #[test]
    fn hash_verify_roundtrip() {
        let store = with_passcode();
        assert!(store_verify(&store, TEST_PASSCODE).unwrap());
        assert!(!store_verify(&store, "1234").unwrap());
        assert!(!store_verify(&store, "43210").unwrap());
    }

    #[test]
    fn wrong_length_rejected_by_policy() {
        assert!(validate_passcode("123").is_err()); // 3 digits
        assert!(validate_passcode("1234567890123").is_err()); // 13 digits
        assert!(validate_passcode("12a4").is_err()); // non-digit
        assert!(validate_passcode("1234").is_ok());
        assert!(validate_passcode("123456789012").is_ok()); // 12 digits OK
    }

    #[test]
    fn iterations_actually_applied() {
        let store = with_passcode();
        assert_eq!(store.iterations, 600_000);
        // A single-round hash must NOT verify against the 600k-round hash:
        // proves the iteration count is really in the KDF, not just a field.
        let one_round = derive_hash(TEST_PASSCODE, store.salt.as_ref().unwrap(), 1).unwrap();
        assert_ne!(one_round, store.passcode_hash.as_deref().unwrap());
    }

    #[test]
    fn salt_is_random_per_set() {
        let a = with_passcode();
        let b = with_passcode();
        assert_ne!(a.salt, b.salt);
        assert_eq!(a.salt.as_ref().unwrap().len(), SALT_BYTES * 2); // hex
    }

    #[test]
    fn reset_wipes_everything_but_visibility() {
        let mut store = with_passcode();
        store.vaulted_folder_ids.push(111);
        store.vaulted_public_channel_ids.push(222);
        store.entry_visible = false;

        store.passcode_hash = None;
        store.salt = None;
        store.iterations = PBKDF2_ITERATIONS;
        store.vaulted_folder_ids.clear();
        store.vaulted_public_channel_ids.clear();

        assert!(store.passcode_hash.is_none());
        assert!(store.salt.is_none());
        assert!(store.vaulted_folder_ids.is_empty());
        assert!(store.vaulted_public_channel_ids.is_empty());
        assert!(!store.entry_visible); // visibility survives
    }

    #[test]
    fn hide_unhide_idempotent_and_cross_kind_isolated() {
        let mut store = with_passcode();
        store.vaulted_folder_ids.push(777);

        // Idempotent hide
        let once = prune_folder_ids(store.clone(), &[999]);
        assert_eq!(once.vaulted_folder_ids.len(), 1);

        // Cross-kind isolation: unhide(public, 777) must NOT touch folder 777
        let store = prune_public_ids(store, &[777]);
        assert!(store.vaulted_folder_ids.contains(&777));

        // And the real removal works
        let store = prune_folder_ids(store, &[777]);
        assert!(!store.vaulted_folder_ids.contains(&777));
    }

    #[test]
    fn corrupt_json_recovers_to_default() {
        let parsed: VaultStore = serde_json::from_str("{not json").unwrap_or_default();
        assert_eq!(parsed, VaultStore::default());
    }

    #[test]
    fn missing_fields_fill_forward_compat() {
        // An old file without entry_visible/iterations still loads.
        let parsed: VaultStore =
            serde_json::from_str("{\"vaulted_folder_ids\": [5]}").unwrap();
        assert_eq!(parsed.vaulted_folder_ids, vec![5]);
        assert!(parsed.entry_visible); // default_true
        assert_eq!(parsed.iterations, PBKDF2_ITERATIONS);
        assert!(parsed.passcode_hash.is_none());
    }

    #[test]
    fn state_response_always_carries_ids_for_ui_concealment() {
        // Spec §4.2 (corrected): the frontend needs hidden IDs WHILE LOCKED —
        // they are what the sidebar filters on. Withholding them while locked
        // made vaulted channels reappear after every relaunch. The lists are
        // not a secret from the UI; they are the UI's concealment map.
        let mut store = with_passcode();
        store.vaulted_folder_ids.push(1);
        store.vaulted_public_channel_ids.push(2);

        let locked = state_response(&store, false);
        assert_eq!(locked.folder_ids.as_ref().unwrap(), &vec![1]);
        assert_eq!(locked.public_ids.as_ref().unwrap(), &vec![2]);
        assert!(!locked.is_unlocked);

        let json = serde_json::to_string(&locked).unwrap();
        assert!(json.contains("\"folder_ids\":[1]"));
        assert!(json.contains("\"public_ids\":[2]"));

        let unlocked_resp = state_response(&store, true);
        assert_eq!(unlocked_resp.folder_ids.as_ref().unwrap(), &vec![1]);
        assert_eq!(unlocked_resp.public_ids.as_ref().unwrap(), &vec![2]);
    }

    #[test]
    fn kind_parsing_rejects_unknown() {
        assert!(parse_kind("folder").is_ok());
        assert!(parse_kind("public_channel").is_ok());
        assert!(parse_kind("channel").is_err()); // cross-kind confusion guard
    }

    #[test]
    fn prune_removes_only_listed_ids() {
        let mut store = with_passcode();
        store.vaulted_folder_ids = vec![1, 2, 3];
        let store = prune_folder_ids(store, &[2, 99]);
        assert_eq!(store.vaulted_folder_ids, vec![1, 3]);
    }

    #[test]
    fn search_filter_drops_vaulted_peers_only_while_locked() {
        let hidden_locked = Some((vec![100], vec![200]));
        let unlocked: Option<(Vec<i64>, Vec<i64>)> = None;

        // Locked: vaulted folder peer and vaulted public peer are dropped.
        assert!(!search_result_keeps(&hidden_locked, Some(100)));
        assert!(!search_result_keeps(&hidden_locked, Some(200)));
        // Locked: non-vaulted peers survive.
        assert!(search_result_keeps(&hidden_locked, Some(300)));
        assert!(search_result_keeps(&hidden_locked, None));
        // Unlocked (None): everything flows, including formerly hidden ids.
        assert!(search_result_keeps(&unlocked, Some(100)));
        assert!(search_result_keeps(&unlocked, Some(200)));
        assert!(search_result_keeps(&unlocked, None));
    }

    #[test]
    fn search_call_site_wraps_both_push_sites_in_fs_source() {
        // Guards the WIRING, not just the predicate: if the result push in
        // cmd_search_global loses its `search_result_keeps` guard, the locked
        // vault leaks via global search and this test fails. Source-level
        // because the loop bodies are Telegram-mocked and unreachable headless.
        // (Historically the Messages/Slice arms duplicated the body → 2 push
        // sites; the all-arms messages_from_history consolidation collapsed
        // them to 1. The invariant is "every push is guarded", not a count.)
        let src = include_str!("fs.rs");
        let start = src.find("pub async fn cmd_search_global").expect("cmd_search_global exists");
        let end = src[start..]
            .find("#[tauri::command]")
            .map(|i| start + i)
            .expect("a following command exists");
        let body = &src[start..end];
        let guards = body.matches("if !vault::search_result_keeps(&hidden, folder_id) {").count();
        let pushes = body.matches("files.push(FileMetadata {").count();
        assert_eq!(guards, pushes, "cmd_search_global must guard every result push with the vault filter");
        assert!(guards >= 1, "cmd_search_global must have at least one guarded push");
    }

    #[test]
    fn wipe_ids_command_body_does_not_touch_passcode_fields() {
        // Contract of cmd_vault_wipe_ids (spec rev 4): logout clears BOTH
        // hidden-ID lists but MUST keep the passcode — a flaky-network logout
        // must never silently destroy it. Source-level guard: the wipe body
        // must contain no passcode/salt mutation (reset is the ONLY command
        // allowed to clear them). Catches copy-paste of reset's body into wipe.
        let src = include_str!("vault.rs");
        let start = src.find("pub async fn cmd_vault_wipe_ids").expect("wipe_ids exists");
        let end = src[start..]
            .find("#[tauri::command]")
            .map(|i| start + i)
            .expect("a following command exists");
        let body = &src[start..end];
        assert!(!body.contains("passcode_hash"), "wipe_ids must not mutate passcode_hash");
        assert!(!body.contains("store.salt"), "wipe_ids must not mutate salt");
    }

    #[test]
    fn reset_is_still_allowed_to_clear_passcode() {
        // Sanity bound on the guard above: the RESET body DOES clear the
        // passcode (D8 recovery). Proves the source-scan test can detect
        // passcode mutations when they legitimately exist.
        let src = include_str!("vault.rs");
        let start = src.find("pub async fn cmd_vault_reset").expect("reset exists");
        let end = src[start..]
            .find("/// Logout hygiene")
            .map(|i| start + i)
            .expect("wipe docs follow reset");
        let body = &src[start..end];
        assert!(body.contains("passcode_hash = None"), "reset must clear passcode");
    }
}
