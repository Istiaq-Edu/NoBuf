use tauri::State;
use crate::commands::streaming::StreamConfig;
use base64::{Engine as _, engine::general_purpose};

const SPRITE_COLUMNS: u32 = 10;
const SPRITE_HEIGHT: u32 = 64;
const FRAME_INTERVAL: f64 = 2.0; // seconds between frames
const FFMPEG_TIMEOUT_SECS: u64 = 60;

#[derive(serde::Serialize, Clone)]
pub struct SpriteSheetResult {
    pub data_url: String,
    pub frame_width: u32,
    pub frame_height: u32,
    pub columns: u32,
    pub interval_seconds: f64,
    pub total_frames: u32,
    pub total_duration: f64,
}

/// Ensure ffmpeg binary is available.
/// Returns the path to the ffmpeg binary.
fn ensure_ffmpeg() -> Result<std::path::PathBuf, String> {
    // Try system ffmpeg first (most reliable)
    if let Ok(output) = std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
    {
        if output.success() {
            log::info!("Using system ffmpeg from PATH");
            return Ok(std::path::PathBuf::from("ffmpeg"));
        }
    }

    // Try next to the running executable (sidecar pattern)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let sidecar = exe_dir.join(if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" });
            log::info!("Checking exe dir: {:?}", sidecar);
            if sidecar.exists() {
                log::info!("Found ffmpeg at: {:?}", sidecar);
                return Ok(sidecar);
            }
        }
    }

    // Try ffmpeg-sidecar's sidecar_path
    if let Ok(sidecar_path) = ffmpeg_sidecar::paths::sidecar_path() {
        log::info!("Checking ffmpeg-sidecar path: {:?}", sidecar_path);
        if sidecar_path.exists() {
            return Ok(sidecar_path);
        }
    }

    // Try auto_download
    log::info!("Attempting ffmpeg auto_download...");
    if let Err(e) = ffmpeg_sidecar::download::auto_download() {
        log::warn!("ffmpeg auto_download failed: {}", e);
    }

    // Re-check after download
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let sidecar = exe_dir.join(if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" });
            if sidecar.exists() {
                return Ok(sidecar);
            }
        }
    }

    if let Ok(sidecar_path) = ffmpeg_sidecar::paths::sidecar_path() {
        if sidecar_path.exists() {
            return Ok(sidecar_path);
        }
    }

    Err("ffmpeg not found. Install ffmpeg and add it to PATH, or place ffmpeg.exe next to the app executable.".to_string())
}

/// Run ffprobe to get video duration in seconds
fn get_video_duration(ffmpeg_path: &std::path::Path, url: &str) -> Result<f64, String> {
    // Try ffprobe first
    let ffprobe_path = if ffmpeg_path.to_string_lossy() == "ffmpeg" {
        std::path::PathBuf::from("ffprobe")
    } else {
        ffmpeg_path.parent().unwrap_or(std::path::Path::new(".")).join("ffprobe")
    };

    let output = std::process::Command::new(&ffprobe_path)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            url,
        ])
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
            if let Some(duration) = json["format"]["duration"].as_str() {
                return duration.parse::<f64>().map_err(|e| format!("Invalid duration: {}", e));
            }
        }
    }

    // Fallback: use ffmpeg to probe duration from first few seconds
    log::warn!("ffprobe failed, falling back to ffmpeg probe");
    Err("Could not determine video duration".to_string())
}

#[tauri::command]
pub async fn cmd_generate_sprite_sheet(
    message_id: i32,
    folder_id: Option<i64>,
    stream_config: State<'_, StreamConfig>,
) -> Result<SpriteSheetResult, String> {
    // Construct stream URL — use 127.0.0.1 (not localhost) to avoid IPv6 issues with ffmpeg
    let folder_segment = match folder_id {
        Some(id) => id.to_string(),
        None => "home".to_string(),
    };
    let stream_url = format!(
        "http://127.0.0.1:{}/stream/{}/{}?token={}",
        stream_config.port, folder_segment, message_id, stream_config.token
    );

    log::info!(
        "Generating sprite sheet for msg_id={} url={}",
        message_id, stream_url
    );

    // Ensure ffmpeg is available
    let ffmpeg_path = ensure_ffmpeg()?;

    // Get video duration (ffprobe may fail, use default)
    let duration = get_video_duration(&ffmpeg_path, &stream_url).unwrap_or(300.0);

    if duration < 4.0 {
        return Err("Video too short for sprite sheet (<4s)".to_string());
    }

    let total_frames = (duration / FRAME_INTERVAL).ceil() as u32;

    // Calculate frame width based on common aspect ratios
    let frame_width = (SPRITE_HEIGHT as f64 * 16.0 / 9.0).round() as u32; // 114px for 64px height at 16:9

    // Calculate tile rows needed
    let tile_rows = (total_frames + SPRITE_COLUMNS - 1) / SPRITE_COLUMNS;

    // Run ffmpeg to generate sprite sheet
    // Force fixed frame dimensions with padding to handle any aspect ratio
    let vf_filter = format!(
        "fps=1/{},scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:color=black,tile={}x{}",
        FRAME_INTERVAL as u32, frame_width, SPRITE_HEIGHT, frame_width, SPRITE_HEIGHT, SPRITE_COLUMNS, tile_rows
    );
    let mut cmd = std::process::Command::new(&ffmpeg_path);
    cmd.args([
        "-user_agent", "TelegramDrive/1.0",
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-i", &stream_url,
        "-vf", &vf_filter,
        "-q:v", "5",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-y", // overwrite output
        "-",  // output to stdout
    ]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    log::info!("Running ffmpeg: {:?}", cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;

    // Read stdout in a thread with timeout
    let stdout = child.stdout.take().expect("stdout was piped");
    let read_handle = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        let mut reader = stdout;
        reader.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok::<Vec<u8>, String>(buf)
    });

    // Wait with timeout
    let start = std::time::Instant::now();
    let mut timed_out = false;
    loop {
        if let Some(status) = child.try_wait().unwrap_or(None) {
            if !status.success() {
                let stderr = child.stderr.take();
                let stderr_msg = if let Some(mut stderr) = stderr {
                    use std::io::Read;
                    let mut buf = String::new();
                    stderr.read_to_string(&mut buf).ok();
                    buf
                } else {
                    String::new()
                };
                // Extract the actual error line from ffmpeg output
                let error_line = stderr_msg
                    .lines()
                    .rev()
                    .find(|l| l.starts_with("Error") || l.starts_with("[") || l.contains("failed") || l.contains("Invalid"))
                    .unwrap_or("Unknown error");
                log::error!("ffmpeg exited with status {}: {}", status, stderr_msg);
                return Err(format!("ffmpeg failed (exit {}): {}", status.code().unwrap_or(-1), error_line));
            }
            break;
        }
        if start.elapsed().as_secs() > FFMPEG_TIMEOUT_SECS {
            timed_out = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    if timed_out {
        let _ = child.kill();
        return Err("ffmpeg timed out after 60 seconds".to_string());
    }

    // Get the output data
    let sprite_data = read_handle
        .join()
        .map_err(|_| "Failed to read ffmpeg output".to_string())?
        .map_err(|e| format!("Failed to read ffmpeg stdout: {}", e))?;

    if sprite_data.is_empty() {
        return Err("ffmpeg produced no output".to_string());
    }

    let data_url = format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(&sprite_data)
    );

    log::info!(
        "Sprite sheet generated: {} frames, {} bytes, duration={:.1}s",
        total_frames,
        sprite_data.len(),
        duration
    );

    Ok(SpriteSheetResult {
        data_url,
        frame_width,
        frame_height: SPRITE_HEIGHT,
        columns: SPRITE_COLUMNS,
        interval_seconds: FRAME_INTERVAL,
        total_frames,
        total_duration: duration,
    })
}
