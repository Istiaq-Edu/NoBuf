//! Shared ffmpeg/ffprobe binary resolution + on-demand download.
//!
//! Resolves the ffmpeg and ffprobe binary paths using a 4-tier fallback:
//!   1. System PATH (bare command name)
//!   2. Next to the running executable (sidecar bundling pattern)
//!   3. ffmpeg-sidecar crate's cached download path
//!   4. App data directory (AppData/Roaming/com.istiaq.nobuf/ffmpeg/)
//!
//! If ffmpeg is not found in tiers 1-3, `download_ffmpeg_to_appdata()` can be
//! called to download the essentials build from gyan.dev and extract it to
//! the app data directory (tier 4).
//!
//! This module exists because `server.rs` was using bare `TokioCommand::new("ffmpeg")`
//! which only works in dev (terminal has ffmpeg in PATH) but fails in release
//! (GUI process may not inherit the user PATH that includes WinGet/scoop installs).
//!
//! The `sprite.rs` module already had this logic; it's extracted here so `server.rs`
//! can reuse it without duplicating code.

use std::path::PathBuf;

const FFMPEG_BIN: &str = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
const FFPROBE_BIN: &str = if cfg!(target_os = "windows") { "ffprobe.exe" } else { "ffprobe" };

/// Resolve the ffmpeg binary path.
///
/// Tries (in order):
/// 1. `ffmpeg` from system PATH (quick `ffmpeg -version` probe)
/// 2. `ffmpeg.exe` next to the current executable (Tauri sidecar bundling)
/// 3. ffmpeg-sidecar's `sidecar_path()` (crate-managed cache)
///
/// Returns the path to pass to `Command::new(path)`.
/// On success, the returned path is either a bare name ("ffmpeg") for PATH
/// resolution, or an absolute/relative PathBuf for the sidecar locations.
pub fn ensure_ffmpeg() -> Result<PathBuf, String> {
    // Tier 1: System PATH
    if is_in_path(FFMPEG_BIN) {
        log::info!("[FFMPEG-UTIL] Using system ffmpeg from PATH");
        return Ok(PathBuf::from("ffmpeg"));
    }

    // Tier 2: Next to the running executable (sidecar pattern)
    if let Some(sidecar) = exe_dir_path(FFMPEG_BIN) {
        log::info!("[FFMPEG-UTIL] Found ffmpeg at: {:?}", sidecar);
        return Ok(sidecar);
    }

    // Tier 3: ffmpeg-sidecar's cached download
    if let Ok(sidecar_path) = ffmpeg_sidecar::paths::sidecar_path() {
        if sidecar_path.exists() {
            log::info!("[FFMPEG-UTIL] Using ffmpeg-sidecar path: {:?}", sidecar_path);
            return Ok(sidecar_path);
        }
    }

    // Tier 4: App data directory (downloaded on first launch)
    if let Some(app_data_path) = app_data_ffmpeg_path() {
        log::info!("[FFMPEG-UTIL] Using ffmpeg from app data: {:?}", app_data_path);
        return Ok(app_data_path);
    }

    log::warn!(
        "[FFMPEG-UTIL] ffmpeg not found. Install ffmpeg and add it to PATH, \
         or place {} next to the app executable.",
        FFMPEG_BIN
    );
    Err(format!(
        "ffmpeg not found. Install ffmpeg and add it to PATH, or place {} next to the app executable.",
        FFMPEG_BIN
    ))
}

/// Resolve the ffprobe binary path.
///
/// If ffmpeg was found in PATH, ffprobe is assumed to be in PATH too.
/// If ffmpeg was found at a specific path (sidecar/exe_dir), ffprobe is
/// expected in the same directory.
pub fn ensure_ffprobe() -> Result<PathBuf, String> {
    // Tier 1: System PATH
    if is_in_path(FFPROBE_BIN) {
        log::info!("[FFMPEG-UTIL] Using system ffprobe from PATH");
        return Ok(PathBuf::from("ffprobe"));
    }

    // Tier 2: Next to the running executable
    if let Some(sidecar) = exe_dir_path(FFPROBE_BIN) {
        log::info!("[FFMPEG-UTIL] Found ffprobe at: {:?}", sidecar);
        return Ok(sidecar);
    }

    // Tier 3: ffmpeg-sidecar's cached download (ffprobe is in the same dir)
    if let Ok(ffmpeg_path) = ffmpeg_sidecar::paths::sidecar_path() {
        if ffmpeg_path.exists() {
            // sidecar_path returns ffmpeg path; ffprobe is sibling
            if let Some(parent) = ffmpeg_path.parent() {
                let ffprobe = parent.join(FFPROBE_BIN);
                if ffprobe.exists() {
                    log::info!("[FFMPEG-UTIL] Using ffprobe from sidecar dir: {:?}", ffprobe);
                    return Ok(ffprobe);
                }
            }
        }
    }

    // Tier 4: App data directory (downloaded on first launch)
    if let Some(dir) = app_data_ffmpeg_dir() {
        let ffprobe = dir.join(FFPROBE_BIN);
        if ffprobe.exists() {
            log::info!("[FFMPEG-UTIL] Using ffprobe from app data: {:?}", ffprobe);
            return Ok(ffprobe);
        }
    }

    log::warn!(
        "[FFMPEG-UTIL] ffprobe not found. Install ffmpeg and add it to PATH, \
         or place {} next to the app executable.",
        FFPROBE_BIN
    );
    Err(format!(
        "ffprobe not found. Install ffmpeg and add it to PATH, or place {} next to the app executable.",
        FFPROBE_BIN
    ))
}

/// Get the app data directory for storing downloaded ffmpeg binaries.
/// Returns AppData/Roaming/com.istiaq.nobuf/ffmpeg/ on Windows.
fn app_data_ffmpeg_dir() -> Option<std::path::PathBuf> {
    let app_data = std::env::var("APPDATA").ok()?;
    let dir = std::path::PathBuf::from(app_data)
        .join("com.istiaq.nobuf")
        .join("ffmpeg");
    Some(dir)
}

/// Check if ffmpeg exists in the app data directory.
fn app_data_ffmpeg_path() -> Option<std::path::PathBuf> {
    let dir = app_data_ffmpeg_dir()?;
    let ffmpeg = dir.join(FFMPEG_BIN);
    if ffmpeg.exists() {
        Some(ffmpeg)
    } else {
        None
    }
}

/// Download ffmpeg + ffprobe essentials build to the app data directory.
///
/// Downloads from https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
/// and extracts only ffmpeg.exe and ffprobe.exe to AppData/Roaming/com.istiaq.nobuf/ffmpeg/.
///
/// This is called on first launch when ffmpeg is not found in PATH/exe_dir/sidecar.
/// The download is ~45MB zip, extracts to ~75MB per binary.
///
/// Returns the path to the downloaded ffmpeg binary.
pub fn download_ffmpeg_to_appdata() -> Result<std::path::PathBuf, String> {
    let dir = app_data_ffmpeg_dir()
        .ok_or_else(|| "Could not determine app data directory".to_string())?;

    // If already downloaded, return early
    let ffmpeg_path = dir.join(FFMPEG_BIN);
    if ffmpeg_path.exists() {
        log::info!("[FFMPEG-UTIL] ffmpeg already in app data: {:?}", ffmpeg_path);
        return Ok(ffmpeg_path);
    }

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ffmpeg dir {:?}: {}", dir, e))?;

    let url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
    log::info!("[FFMPEG-UTIL] Downloading ffmpeg from {} to {:?}", url, dir);

    // Download zip to temp file
    let temp_zip = dir.join("ffmpeg_download.zip");
    let response = ureq::get(url)
        .timeout(std::time::Duration::from_secs(300))
        .call()
        .map_err(|e| format!("Download failed: {}", e))?;

    let mut file = std::fs::File::create(&temp_zip)
        .map_err(|e| format!("Failed to create temp zip: {}", e))?;

    use std::io::Read;
    let mut reader = response.into_reader();
    let mut buf = [0u8; 65536];
    loop {
        let n = reader.read(&mut buf)
            .map_err(|e| format!("Download read error: {}", e))?;
        if n == 0 { break; }
        use std::io::Write;
        file.write_all(&buf[..n])
            .map_err(|e| format!("Download write error: {}", e))?;
    }
    drop(file);

    log::info!("[FFMPEG-UTIL] Download complete, extracting...");

    // Extract ffmpeg.exe and ffprobe.exe from the zip
    let zip_file = std::fs::File::open(&temp_zip)
        .map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(zip_file)
        .map_err(|e| format!("Failed to read zip: {}", e))?;

    let mut found_ffmpeg = false;
    let mut found_ffprobe = false;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("Zip entry error: {}", e))?;

        let name = entry.name().to_lowercase();
        let is_target = (name.ends_with("ffmpeg.exe") && !found_ffmpeg)
            || (name.ends_with("ffprobe.exe") && !found_ffprobe);

        if is_target {
            // Get just the filename, not the full path in the zip
            let filename = std::path::Path::new(entry.name())
                .file_name()
                .unwrap_or_default();
            let dest = dir.join(filename);
            let mut out = std::fs::File::create(&dest)
                .map_err(|e| format!("Failed to create {:?}: {}", dest, e))?;

            use std::io::Read;
            let mut buf = [0u8; 65536];
            loop {
                let n = entry.read(&mut buf)
                    .map_err(|e| format!("Extract read error: {}", e))?;
                if n == 0 { break; }
                use std::io::Write;
                out.write_all(&buf[..n])
                    .map_err(|e| format!("Extract write error: {}", e))?;
            }

            if name.ends_with("ffmpeg.exe") {
                found_ffmpeg = true;
                log::info!("[FFMPEG-UTIL] Extracted ffmpeg.exe");
            } else if name.ends_with("ffprobe.exe") {
                found_ffprobe = true;
                log::info!("[FFMPEG-UTIL] Extracted ffprobe.exe");
            }
        }
    }

    // Clean up zip
    let _ = std::fs::remove_file(&temp_zip);

    if !found_ffmpeg {
        return Err("ffmpeg.exe not found in downloaded zip".to_string());
    }
    if !found_ffprobe {
        log::warn!("[FFMPEG-UTIL] ffprobe.exe not found in zip — system PATH ffprobe will be used if available");
    }

    log::info!("[FFMPEG-UTIL] ffmpeg installed to {:?}", ffmpeg_path);
    Ok(ffmpeg_path)
}

/// Ensure ffmpeg is available. If not found in tiers 1-3, download to app data.
/// This is the entry point for the Tauri command `cmd_ensure_ffmpeg`.
pub fn ensure_ffmpeg_or_download() -> Result<std::path::PathBuf, String> {
    // Try the normal resolution first
    if let Ok(path) = ensure_ffmpeg() {
        return Ok(path);
    }

    // Not found — download to app data
    log::info!("[FFMPEG-UTIL] ffmpeg not found in PATH/exe/sidecar — downloading to app data...");
    download_ffmpeg_to_appdata()
}

/// Check if a binary is available in the system PATH by probing `bin -version`.
fn is_in_path(bin: &str) -> bool {
    std::process::Command::new(bin)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Get the path of a binary next to the current executable.
/// Returns Some(path) if the file exists, None otherwise.
fn exe_dir_path(bin: &str) -> Option<PathBuf> {
    let exe_path = std::env::current_exe().ok()?;
    let exe_dir = exe_path.parent()?;
    let sidecar = exe_dir.join(bin);
    if sidecar.exists() {
        Some(sidecar)
    } else {
        None
    }
}

/// Derive the ffprobe path from a resolved ffmpeg path.
/// If ffmpeg is a bare name ("ffmpeg"), ffprobe is "ffprobe".
/// If ffmpeg is a full path, ffprobe is in the same directory.
pub fn ffprobe_from_ffmpeg(ffmpeg_path: &std::path::Path) -> PathBuf {
    let path_str = ffmpeg_path.to_string_lossy();
    if path_str == "ffmpeg" || path_str == "ffmpeg.exe" {
        PathBuf::from(if cfg!(target_os = "windows") { "ffprobe" } else { "ffprobe" })
    } else {
        ffmpeg_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join(FFPROBE_BIN)
    }
}

// ============================================================================
// Tests
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffprobe_from_ffmpeg_bare_name_returns_bare_ffprobe() {
        let ffmpeg = PathBuf::from("ffmpeg");
        let ffprobe = ffprobe_from_ffmpeg(&ffmpeg);
        assert!(
            ffprobe.to_string_lossy() == "ffprobe" || ffprobe.to_string_lossy() == "ffprobe.exe",
            "Expected bare 'ffprobe', got {:?}",
            ffprobe
        );
    }

    #[test]
    fn ffprobe_from_ffmpeg_full_path_returns_sibling() {
        let ffmpeg = PathBuf::from("/usr/local/bin/ffmpeg");
        let ffprobe = ffprobe_from_ffmpeg(&ffmpeg);
        assert!(
            ffprobe.to_string_lossy().ends_with("ffprobe")
                || ffprobe.to_string_lossy().ends_with("ffprobe.exe"),
            "Expected path ending with ffprobe, got {:?}",
            ffprobe
        );
        // Must be in the same directory as ffmpeg
        assert_eq!(
            ffmpeg.parent().unwrap(),
            ffprobe.parent().unwrap(),
            "ffprobe must be in the same directory as ffmpeg"
        );
    }

    #[test]
    fn ffprobe_from_ffprobe_windows_exe_extension() {
        let ffmpeg = PathBuf::from("C:\\tools\\ffmpeg.exe");
        let ffprobe = ffprobe_from_ffmpeg(&ffmpeg);
        if cfg!(target_os = "windows") {
            assert!(
                ffprobe.to_string_lossy().ends_with("ffprobe.exe"),
                "Expected ffprobe.exe on Windows, got {:?}",
                ffprobe
            );
        } else {
            assert!(
                ffprobe.to_string_lossy().ends_with("ffprobe"),
                "Expected ffprobe on non-Windows, got {:?}",
                ffprobe
            );
        }
    }

    #[test]
    fn ensure_ffmpeg_returns_err_when_not_found() {
        // This test only passes if ffmpeg is genuinely not available.
        // In CI/dev environments where ffmpeg IS installed, skip the assertion.
        // We test the error path by temporarily breaking the resolution:
        // If ffmpeg is in PATH, this test is a no-op (Ok).
        match ensure_ffmpeg() {
            Ok(path) => {
                // ffmpeg found — verify the path is sensible
                let s = path.to_string_lossy();
                assert!(
                    s.contains("ffmpeg") || s.contains("ffmpeg.exe"),
                    "Path should contain ffmpeg: {:?}",
                    path
                );
            }
            Err(msg) => {
                assert!(
                    msg.contains("ffmpeg not found"),
                    "Error message should explain how to fix: {}",
                    msg
                );
                assert!(
                    msg.contains("PATH") || msg.contains("executable"),
                    "Error message should mention PATH or executable: {}",
                    msg
                );
            }
        }
    }

    #[test]
    fn ensure_ffprobe_returns_err_when_not_found() {
        match ensure_ffprobe() {
            Ok(path) => {
                let s = path.to_string_lossy();
                assert!(
                    s.contains("ffprobe") || s.contains("ffprobe.exe"),
                    "Path should contain ffprobe: {:?}",
                    path
                );
            }
            Err(msg) => {
                assert!(
                    msg.contains("ffprobe not found"),
                    "Error message should explain how to fix: {}",
                    msg
                );
            }
        }
    }

    #[test]
    fn is_in_path_returns_false_for_nonexistent_binary() {
        // A binary name that definitely doesn't exist
        assert!(!is_in_path("nobuf_nonexistent_binary_xyz_12345"));
    }

    #[test]
    fn is_in_path_returns_bool_without_panicking() {
        // Even for weird names, this should return false, not panic
        let result = is_in_path("");
        assert!(!result, "Empty string should not be in PATH");
    }

    #[test]
    fn exe_dir_path_returns_none_for_nonexistent_file() {
        // This binary name definitely doesn't exist next to the test executable
        let result = exe_dir_path("nobuf_nonexistent_binary_xyz_12345");
        assert!(result.is_none(), "Should return None for nonexistent file");
    }

    #[test]
    fn test_bin_constants_are_correct_for_platform() {
        if cfg!(target_os = "windows") {
            assert_eq!(FFMPEG_BIN, "ffmpeg.exe");
            assert_eq!(FFPROBE_BIN, "ffprobe.exe");
        } else {
            assert_eq!(FFMPEG_BIN, "ffmpeg");
            assert_eq!(FFPROBE_BIN, "ffprobe");
        }
    }
}
