use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use tauri::{AppHandle, Manager};
use std::path::PathBuf;
use std::sync::Mutex;

/// Lock to serialize config file access (prevents TOCTOU race between update + regenerate)
pub struct ConfigLock(pub Mutex<()>);

/// Persisted API settings (written to api_settings.json in the app data dir)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApiSettingsFile {
    pub enabled: bool,
    pub port: u16,
    pub key_hash: Option<String>,
}

impl Default for ApiSettingsFile {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 8550,
            key_hash: None,
        }
    }
}

/// What the frontend sees (never exposes the hash)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApiSettingsResponse {
    pub enabled: bool,
    pub port: u16,
    pub key_set: bool,
    pub running: bool,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("api_settings.json"))
}

pub fn load_settings(app: &AppHandle) -> ApiSettingsFile {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return ApiSettingsFile::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => ApiSettingsFile::default(),
    }
}

fn save_settings(app: &AppHandle, settings: &ApiSettingsFile) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // Atomic write: write to .tmp, sync, then rename
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

    Ok(())
}

fn hash_key(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Verify a plaintext key against a stored hash using constant-time comparison
/// to prevent timing side-channel attacks.
pub fn verify_key(plaintext: &str, stored_hash: &str) -> bool {
    let computed = hash_key(plaintext);
    constant_time_eq::constant_time_eq(computed.as_bytes(), stored_hash.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verify_key_correct() {
        let hash = hash_key("my-secret-key-123");
        assert!(verify_key("my-secret-key-123", &hash));
    }

    #[test]
    fn test_verify_key_wrong() {
        let hash = hash_key("my-secret-key-123");
        assert!(!verify_key("wrong-key", &hash));
    }

    #[test]
    fn test_verify_key_empty() {
        let hash = hash_key("");
        assert!(verify_key("", &hash));
        assert!(!verify_key("a", &hash));
    }

    #[test]
    fn test_verify_key_different_lengths() {
        let hash = hash_key("key1");
        assert!(!verify_key("key1extra", &hash));
        assert!(!verify_key("ke", &hash));
    }
}

#[tauri::command]
pub async fn cmd_get_api_settings(
    app: AppHandle,
) -> Result<ApiSettingsResponse, String> {
    let settings = load_settings(&app);
    let running = {
        let state = app.try_state::<crate::ApiServerRunning>();
        state.map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed)).unwrap_or(false)
    };
    Ok(ApiSettingsResponse {
        enabled: settings.enabled,
        port: settings.port,
        key_set: settings.key_hash.is_some(),
        running,
    })
}

#[tauri::command]
pub async fn cmd_update_api_settings(
    enabled: bool,
    port: u16,
    app: AppHandle,
) -> Result<ApiSettingsResponse, String> {
    // Validate port range
    if port < 1024 {
        return Err("Port must be 1024 or higher".to_string());
    }

    // Prevent collision with streaming server
    if port == crate::STREAM_PORT {
        return Err(format!("Port {} is used by the media streaming server", port));
    }

    // Acquire config lock to prevent TOCTOU race with cmd_regenerate_api_key
    let config_lock = app.state::<ConfigLock>();
    let _config_guard = config_lock.0.lock().map_err(|e| format!("Config lock error: {}", e))?;

    let mut settings = load_settings(&app);
    let port_changed = settings.port != port;
    let enabled_changed = settings.enabled != enabled;

    settings.enabled = enabled;
    settings.port = port;
    save_settings(&app, &settings)?;

    // Restart server if anything changed
    if port_changed || enabled_changed {
        crate::restart_api_server(&app);
    }

    let running = {
        let state = app.try_state::<crate::ApiServerRunning>();
        state.map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed)).unwrap_or(false)
    };

    Ok(ApiSettingsResponse {
        enabled: settings.enabled,
        port: settings.port,
        key_set: settings.key_hash.is_some(),
        running,
    })
}

#[tauri::command]
pub async fn cmd_regenerate_api_key(
    app: AppHandle,
) -> Result<String, String> {
    // Acquire config lock to prevent TOCTOU race with cmd_update_api_settings
    let config_lock = app.state::<ConfigLock>();
    let _config_guard = config_lock.0.lock().map_err(|e| format!("Config lock error: {}", e))?;

    let mut settings = load_settings(&app);

    // Generate a secure 32-byte random key as hex
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..32).map(|_| rand::Rng::gen(&mut rng)).collect();
    let plaintext_key: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();

    // Store only the hash
    settings.key_hash = Some(hash_key(&plaintext_key));
    save_settings(&app, &settings)?;

    // Restart server so middleware picks up the new hash
    crate::restart_api_server(&app);

    // Return the plaintext key ONCE — it is never stored or retrievable again
    Ok(plaintext_key)
}
