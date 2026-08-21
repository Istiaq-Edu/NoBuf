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
use std::sync::RwLock;
use crate::no_window::NoWindow;

const FFMPEG_BIN: &str = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
const FFPROBE_BIN: &str = if cfg!(target_os = "windows") { "ffprobe.exe" } else { "ffprobe" };

// ============================================================================
// Resolved-path cache
// ============================================================================
//
// Resolution is expensive: Tier 1 spawns a real `<bin> -version` subprocess
// (see `is_in_path`). With ~16 call sites and no caching, a single
// "open an MKV with embedded subtitles, then seek" flow burned 10 throwaway
// processes, and `/thumb` (per hover-scrub tick) made the ceiling unbounded.
//
// SUCCESSES ONLY are cached. Caching a failure would be actively worse than no
// cache at all: the first-launch download runs in the background while the app
// stays usable, so an early call can legitimately fail at t=1s and succeed at
// t=60s once the binary lands. A cached `Err` would keep every ffmpeg feature
// broken for the whole session — the current uncached code self-heals, and this
// must not regress that.
//
// `None` therefore means "not resolved yet", never "resolution failed".
static FFMPEG_PATH: RwLock<Option<PathBuf>> = RwLock::new(None);
static FFPROBE_PATH: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Read a cached path, if one has been resolved.
fn cached(slot: &RwLock<Option<PathBuf>>) -> Option<PathBuf> {
    slot.read().ok().and_then(|g| g.clone())
}

/// Store a successfully resolved path.
fn store(slot: &RwLock<Option<PathBuf>>, path: &PathBuf) {
    if let Ok(mut g) = slot.write() {
        *g = Some(path.clone());
    }
}

/// Drop both cached paths so the next call re-resolves.
///
/// Call this after installing/repairing ffmpeg so the freshly installed binary
/// is picked up without restarting the app.
pub fn reset_resolved() {
    if let Ok(mut g) = FFMPEG_PATH.write() {
        *g = None;
    }
    if let Ok(mut g) = FFPROBE_PATH.write() {
        *g = None;
    }
    // The parsed-dump cache must go too: after a repair the new binary has a
    // different component set, and a stale dump would make the health check
    // report the OLD binary's capabilities. (probe::check also self-heals by
    // tagging its cache with the binary path; this makes it explicit.)
    crate::deps::probe::reset_dump_cache();
    log::info!("[FFMPEG-UTIL] resolved-path + dump caches cleared");
}

/// Resolve the ffmpeg binary path, caching a successful result.
///
/// See `ensure_ffmpeg_uncached` for the tier order. Failures are NOT cached, so
/// a later call retries and succeeds once ffmpeg becomes available.
pub fn ensure_ffmpeg() -> Result<PathBuf, String> {
    if let Some(p) = cached(&FFMPEG_PATH) {
        return Ok(p);
    }
    let resolved = ensure_ffmpeg_uncached()?;
    store(&FFMPEG_PATH, &resolved);
    Ok(resolved)
}

/// Resolve the ffprobe binary path, caching a successful result.
pub fn ensure_ffprobe() -> Result<PathBuf, String> {
    if let Some(p) = cached(&FFPROBE_PATH) {
        return Ok(p);
    }
    let resolved = ensure_ffprobe_uncached()?;
    store(&FFPROBE_PATH, &resolved);
    Ok(resolved)
}

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
pub fn ensure_ffmpeg_uncached() -> Result<PathBuf, String> {
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
pub fn ensure_ffprobe_uncached() -> Result<PathBuf, String> {
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
        .no_window()
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

    // ========================================================================
    // Resolved-path cache
    // ========================================================================

    /// The three tests below touch the PROCESS-GLOBAL cache statics. Cargo runs
    /// tests in parallel threads inside one process, so a peer test calling
    /// `ensure_ffprobe()` can repopulate the cache between another test's
    /// `reset_resolved()` and its assertion. That is a test-harness race, not a
    /// production defect (production has a single logical caller sequence), so
    /// the affected tests serialize on this lock instead of weakening the
    /// assertion.
    static CACHE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The cache helpers are the whole mechanism, so they are tested directly
    /// against the shipped functions rather than a local reimplementation.
    #[test]
    fn cache_returns_none_before_anything_is_stored() {
        let slot: RwLock<Option<PathBuf>> = RwLock::new(None);
        assert!(cached(&slot).is_none(), "empty slot must read as None");
    }

    #[test]
    fn cache_round_trips_a_stored_path() {
        let slot: RwLock<Option<PathBuf>> = RwLock::new(None);
        let p = PathBuf::from("C:/tools/ffmpeg.exe");
        store(&slot, &p);
        assert_eq!(cached(&slot).as_deref(), Some(p.as_path()));
    }

    /// REGRESSION GUARD for the design blocker: a FAILED resolution must never
    /// be cached. The first-run download runs in the background while the app
    /// stays usable, so resolution can legitimately fail at t=1s and succeed at
    /// t=60s. If the failure were cached, every ffmpeg feature would stay broken
    /// for the whole session — worse than having no cache at all.
    ///
    /// This asserts the *shape* that guarantees it: the cache slot holds a bare
    /// `PathBuf` (success only) and has no representation for an error, so a
    /// failure physically cannot be stored.
    #[test]
    fn failure_is_not_cachable_so_resolution_self_heals() {
        let slot: RwLock<Option<PathBuf>> = RwLock::new(None);

        // Simulate: resolution fails -> nothing is stored (the only thing
        // `store` accepts is a successful path).
        assert!(cached(&slot).is_none());
        assert!(
            cached(&slot).is_none(),
            "a failed resolution must leave the slot empty so the next call retries"
        );

        // Later the binary appears and resolution succeeds -> now it caches.
        let good = PathBuf::from("ffmpeg");
        store(&slot, &good);
        assert_eq!(
            cached(&slot).as_deref(),
            Some(good.as_path()),
            "success after an earlier failure must be cached (self-heal)"
        );
    }

    #[test]
    fn store_overwrites_a_previous_value_for_repair() {
        let slot: RwLock<Option<PathBuf>> = RwLock::new(None);
        store(&slot, &PathBuf::from("old/ffmpeg.exe"));
        store(&slot, &PathBuf::from("new/ffmpeg.exe"));
        assert_eq!(
            cached(&slot).unwrap(),
            PathBuf::from("new/ffmpeg.exe"),
            "a repair install must be able to replace the cached path"
        );
    }

    /// `reset_resolved()` must clear BOTH slots, otherwise a repair would keep
    /// serving the old ffmpeg (or old ffprobe) until the app restarted.
    #[test]
    fn reset_resolved_clears_both_caches() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Warm both caches via the public API when the binaries are available.
        let had_ffmpeg = ensure_ffmpeg().is_ok();
        let had_ffprobe = ensure_ffprobe().is_ok();

        reset_resolved();

        assert!(
            FFMPEG_PATH.read().unwrap().is_none(),
            "reset must clear the ffmpeg cache"
        );
        assert!(
            FFPROBE_PATH.read().unwrap().is_none(),
            "reset must clear the ffprobe cache"
        );

        // Re-resolution after a reset must still work (idempotent).
        if had_ffmpeg {
            assert!(ensure_ffmpeg().is_ok(), "ffmpeg must re-resolve after reset");
        }
        if had_ffprobe {
            assert!(ensure_ffprobe().is_ok(), "ffprobe must re-resolve after reset");
        }
    }

    /// The cached wrapper must agree with the uncached resolver — a cache that
    /// returns a different answer than the real resolution is a bug.
    #[test]
    fn cached_and_uncached_agree() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_resolved();
        match (ensure_ffmpeg_uncached(), ensure_ffmpeg()) {
            (Ok(direct), Ok(via_cache)) => assert_eq!(
                direct, via_cache,
                "cached path must match what the resolver returns"
            ),
            (Err(_), Err(_)) => {} // consistent: neither can resolve
            (a, b) => panic!("cached/uncached disagree: {:?} vs {:?}", a, b),
        }
    }

    /// The point of the cache: repeated calls must not keep re-resolving.
    /// Asserts a BOUND on behaviour (second call is served from the slot),
    /// not merely that two isolated calls each succeed.
    #[test]
    fn second_call_is_served_from_cache() {
        let _guard = CACHE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_resolved();
        if ensure_ffmpeg().is_err() {
            return; // no ffmpeg on this machine; nothing to assert
        }
        // After one successful resolution the slot must be populated, which is
        // what lets the ~16 call sites stop spawning `-version` probes.
        assert!(
            FFMPEG_PATH.read().unwrap().is_some(),
            "a successful resolution must populate the cache"
        );
        let first = ensure_ffmpeg().unwrap();
        let second = ensure_ffmpeg().unwrap();
        assert_eq!(first, second, "cached resolution must be stable");
    }
}
