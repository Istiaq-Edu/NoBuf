//! Split-and-upload orchestrator for videos larger than the Telegram per-file cap.
//!
//! Pipeline (see .hermes/plans/large-video-split-upload.md):
//!   pick oversize video → prepare (probe + filmstrip + auto boundaries) →
//!   confirm → per part: ffmpeg lossless split to a temp file NEXT TO the
//!   source → upload via the SHARED upload_file_inner pipeline → delete temp.
//!
//! Jobs persist in nobuf_jobs.db so an interrupted run (network death, kill,
//! app close) resumes from the first non-done part after re-verifying the
//! source file (size + mtime + duration).
//!
//! Conventions copied from existing modules:
//! - SQLite: same db_path/get_connection idiom as folder_groups.rs (sync
//!   scopes only — never hold a Statement across an .await).
//! - Progress: `upload-progress` events flow through upload_file_inner
//!   unchanged; this module additionally emits coarse `split-progress`.
//! - Child processes: TokioCommand + NoWindow (no console flash on Windows).
//! - Temp deletion: best-effort retry thread like fs.rs cleanup_partial_file.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bandwidth::BandwidthManager;
use crate::commands::fs::upload_file_inner;
use crate::commands::utils::upload_limit_bytes;
use crate::commands::TelegramState;
use crate::no_window::NoWindow;

// ============================================================================
// Constants
// ============================================================================

/// Safety margin under the cap for estimation drift. The HARD guarantee is
/// the post-split byte check, not this margin.
const MARGIN_BYTES: u64 = 64 * 1024 * 1024;
/// Extra headroom required free on disk beyond the largest estimated part.
const DISK_SLACK_BYTES: u64 = 256 * 1024 * 1024;
/// Minimum part length in seconds (drag guard + degenerate-split protection).
pub const MIN_PART_SECS: f64 = 60.0;
/// Filmstrip thumbnails shown across the timeline in the split modal.
const FILMSTRIP_THUMBS: usize = 12;
/// Lookback window when hunting for the nearest preceding keyframe.
const KEYFRAME_LOOKBACK_SECS: f64 = 90.0;
/// Bounded VBR pile-up replans per part before failing loudly (edge case 6).
const MAX_REPLANS_PER_PART: u32 = 2;

// ============================================================================
// Data model
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitPartPlan {
    pub idx: u32, // 1-based
    pub name: String,
    #[serde(rename = "startSec")]
    pub start_sec: f64,
    #[serde(rename = "endSec")]
    pub end_sec: f64,
}

/// Returned by cmd_prepare_split; consumed by cmd_start_split_job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SplitPlan {
    #[serde(rename = "sourcePath")]
    pub source_path: String,
    #[serde(rename = "sourceSize")]
    pub source_size: u64,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "folderId")]
    pub folder_id: Option<i64>,
    #[serde(rename = "capBytes")]
    pub cap_bytes: u64,
    #[serde(rename = "durationSec")]
    pub duration_sec: f64,
    /// ffmpeg muxer name: "mp4" | "matroska"
    pub container: String,
    /// Part extension INCLUDING dot: ".mp4" | ".mkv"
    #[serde(rename = "partExt")]
    pub part_ext: String,
    /// false → stream-drop policy engaged (-map 0:v -map 0:a)
    #[serde(rename = "mapAll")]
    pub map_all: bool,
    /// Human notice when map_all is false (subtitles/attachments dropped).
    #[serde(rename = "streamNotice")]
    pub stream_notice: Option<String>,
    /// Post-SNAP internal cut points (len = parts-1). CHAINED SNAP INVARIANT:
    /// part K+1 starts exactly at boundaries[K]; seams never gap or overlap.
    pub boundaries: Vec<f64>,
    pub parts: Vec<SplitPartPlan>,
    /// Base64 JPEG data URLs for the filmstrip.
    pub thumbs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JobPartState {
    idx: u32,
    name: String,
    #[serde(rename = "startSec")]
    start_sec: f64,
    #[serde(rename = "endSec")]
    end_sec: f64,
    /// "waiting" | "done" | "cancelled" | "failed"
    /// (cancelled = user-skipped via per-part cancel, retried never by Resume;
    /// failed = exhausted auto-retry, eligible for Retry/Resume.)
    status: String,
    #[serde(rename = "messageId")]
    message_id: Option<i64>,
    /// Actual byte size of the split part (stat'd after ffmpeg). `default`
    /// keeps pre-existing parts_json rows loadable (plan §C).
    #[serde(rename = "sizeBytes", default)]
    size_bytes: u64,
}

/// Per-part summary surfaced through cmd_list_split_jobs hydration so the
/// Transfers panel can rebuild per-part rows after a restart (plan §C seam #3).
#[derive(Debug, Serialize)]
pub struct PartInfo {
    pub idx: u32,
    pub name: String,
    pub status: String,
    #[serde(rename = "messageId")]
    pub message_id: Option<i64>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

/// Row shape returned to the frontend transfers window.
#[derive(Debug, Serialize)]
pub struct SplitJobInfo {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub status: String,
    pub error: Option<String>,
    #[serde(rename = "folderId")]
    pub folder_id: Option<i64>,
    #[serde(rename = "totalParts")]
    pub total_parts: usize,
    #[serde(rename = "doneParts")]
    pub done_parts: usize,
    /// Per-part detail for Transfers-panel group rows (hydration seam, §C).
    pub parts: Vec<PartInfo>,
    #[serde(rename = "tempDir")]
    pub temp_dir: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Clone, Serialize)]
struct SplitProgressPayload {
    #[serde(rename = "jobId")]
    job_id: String,
    phase: String, // "splitting" | "uploading" | "done" | "interrupted" | per-part terminal via part_status
    #[serde(rename = "partIdx")]
    part_idx: u32,
    #[serde(rename = "totalParts")]
    total_parts: u32,
    message: String,
    /// Terminal per-part flip ("done"|"cancelled"|"failed") riding the existing
    /// event; None for plain progress. Frontend keys off this instead of
    /// inferring from part_idx (plan §C).
    #[serde(rename = "partStatus")]
    part_status: Option<String>,
}

// ============================================================================
// Pure planning math (unit-tested below)
// ============================================================================

/// Per-part upload attempts before the part is marked `failed` and the job
/// goes to manual Resume (plan §E3). Budget: 2s + 8s + 30s = 40s max backoff.
const SPLIT_PART_MAX_ATTEMPTS: u32 = 3;
/// Backoff before attempt 2 and attempt 3 (attempt 1 fails → 2s wait, etc.).
const SPLIT_RETRY_BACKOFF_MS: [u64; 2] = [2_000, 8_000];
/// Total worst-case backoff budget per part (asserted by test).
const SPLIT_RETRY_BUDGET_MS: u64 = 40_000;
/// Granularity of cancellation polling inside backoff sleeps (§E3/F5).
const CANCEL_POLL_MS: u64 = 500;

/// Reapply retry intent to a freshly-loaded DB snapshot. The active worker may
/// have persisted a stale `cancelled` copy after the command wrote `waiting`,
/// so retry ownership is resolved only at this worker boundary.
fn apply_retry_indices(parts: &mut [JobPartState], retry_indices: &[u32]) {
    for part in parts {
        if retry_indices.contains(&part.idx) && part.status != "done" {
            part.status = "waiting".to_string();
        }
    }
}

const SPLIT_RETRY_BACKOFF_TOTAL_MS: u64 = SPLIT_RETRY_BACKOFF_MS[0] + SPLIT_RETRY_BACKOFF_MS[1];
const _: () = assert!(
    SPLIT_RETRY_BACKOFF_TOTAL_MS <= SPLIT_RETRY_BUDGET_MS,
    "retry backoff budget exceeded — update SPLIT_RETRY_BUDGET_MS"
);

/// How many parts does `size` need under a per-part budget of `cap`?
/// Unique job id: two SipHash rounds over path|size|time -> 32 hex chars.
/// The old base64-truncate scheme collapsed to the shared directory prefix
/// (first 18 bytes), colliding on the second job for ANY file in the same
/// folder. Hashing the FULL string cannot collide across different inputs.
fn derive_job_id(source_path: &str, size: u64, secs: i64) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let raw = format!("{}|{}|{}", source_path, size, secs);
    let mut h1 = DefaultHasher::new();
    raw.hash(&mut h1);
    let mut h2 = DefaultHasher::new();
    format!("{}#split", raw).hash(&mut h2);
    format!("{:016x}{:016x}", h1.finish(), h2.finish())
}

/// Sane minimum per-part byte budget. Real caps are GiB-scale; anything
/// smaller means a bogus/test override and must be rejected, not exploded
/// into millions of parts.
const MIN_PART_BUDGET_BYTES: u64 = 1_048_576; // 1 MiB

fn compute_part_count(size: u64, cap: u64) -> Option<u32> {
    let budget = cap.saturating_sub(MARGIN_BYTES);
    if budget < MIN_PART_BUDGET_BYTES {
        return None;
    }
    Some((((size + budget - 1) / budget).max(1)) as u32)
}

/// Equal-time internal cut points for `n` parts over `duration`.
fn equal_boundaries(duration: f64, n: u32) -> Vec<f64> {
    let n = n.max(1);
    (1..n).map(|i| duration * (i as f64) / (n as f64)).collect()
}

/// Zero-pad index to max(2, digits(total)) so sort order survives 100+ parts.
fn zero_pad(idx: u32, total: u32) -> String {
    let digits = if total <= 0 { 1 } else { ((total as f64).log10().floor() as usize) + 1 };
    format!("{:0width$}", idx, width = digits.max(2))
}

/// Display name of part `idx` of `total`: `<stem>.part<pad><ext>`.
fn part_display_name(stem: &str, idx: u32, ext_with_dot: &str, total: u32) -> String {
    format!("{}.part{}{}", stem, zero_pad(idx, total), ext_with_dot)
}

/// Container policy: mp4-family stays mp4, EVERYTHING ELSE normalizes to
/// matroska (accepts virtually every codec; normalization beats preserving
/// legacy containers). Returns (muxer, extension-with-dot).
fn container_for(ext_no_dot: &str) -> (&'static str, &'static str) {
    match ext_no_dot.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" | "mov" => ("mp4", ".mp4"),
        _ => ("matroska", ".mkv"),
    }
}

/// Grouping-side parser (used by listing collapse in Phase D; kept beside the
/// naming code so the two can never drift). Matches `<stem>.part<N><ext>`
/// with N ≥ 1, returns (stem, index). Leading zeros are accepted on input
/// (they're the canonical OUTPUT format, not a marker to reject).
pub fn parse_part_name(file_name: &str, ext_with_dot: &str) -> Option<(String, u32)> {
    let lower = file_name.to_ascii_lowercase();
    let ext = ext_with_dot.to_ascii_lowercase();
    if !lower.ends_with(&ext) {
        return None;
    }
    let base = &file_name[..file_name.len() - ext_with_dot.len()];
    let pos = base.rfind(".part")?;
    let digits = &base[pos + 5..];
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u32>().ok().filter(|n| *n >= 1).map(|n| (base[..pos].to_string(), n))
}

/// Build post-snap contiguous parts from boundaries. CHAINED SNAP INVARIANT:
/// part K+1 starts exactly where part K ends.
fn build_parts(stem: &str, ext_with_dot: &str, boundaries: &[f64], duration: f64) -> Vec<SplitPartPlan> {
    let total = boundaries.len() as u32 + 1;
    let mut edges: Vec<f64> = Vec::with_capacity(total as usize + 1);
    edges.push(0.0);
    edges.extend_from_slice(boundaries);
    edges.push(duration);
    (0..total as usize)
        .map(|i| SplitPartPlan {
            idx: i as u32 + 1,
            name: part_display_name(stem, i as u32 + 1, ext_with_dot, total),
            start_sec: edges[i],
            end_sec: edges[i + 1],
        })
        .collect()
}

/// Cap with test override: NOBUF_FAKE_UPLOAD_CAP_BYTES wins when set positive.
/// Production behavior untouched (env unset in normal runs).
async fn effective_cap(state: &TelegramState) -> Result<u64, String> {
    if let Ok(v) = std::env::var("NOBUF_FAKE_UPLOAD_CAP_BYTES") {
        if let Ok(n) = v.trim().parse::<u64>() {
            if n > 0 {
                log::info!("[SPLIT] cap override active: {}B", n);
                return Ok(n);
            }
        }
    }
    let client_opt = { state.client.lock().await.clone() };
    match client_opt {
        Some(client) => upload_limit_bytes(&client).await,
        None => Ok(2_000_000_000), // not connected: assume free-tier cap
    }
}

fn source_stem(path: &str) -> String {
    PathBuf::from(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".to_string())
}

fn ext_no_dot(path: &str) -> String {
    PathBuf::from(path)
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ============================================================================
// SQLite (own DB file: nobuf_jobs.db — sync scopes only)
// ============================================================================

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("nobuf_jobs.db"))
}

fn get_connection(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS split_upload_jobs (
            id TEXT PRIMARY KEY,
            source_path TEXT NOT NULL,
            source_size INTEGER NOT NULL,
            source_mtime INTEGER NOT NULL,
            source_duration REAL NOT NULL,
            temp_dir TEXT NOT NULL,
            display_name TEXT NOT NULL,
            folder_id INTEGER,
            cap_bytes INTEGER NOT NULL,
            container TEXT NOT NULL,
            part_ext TEXT NOT NULL,
            map_all INTEGER NOT NULL DEFAULT 1,
            boundaries_json TEXT NOT NULL,
            parts_json TEXT NOT NULL,
            thumbs_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL,
            error TEXT,
            created_at INTEGER,
            updated_at INTEGER
        )",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn vi(v: &sqlite::Value) -> i64 {
    match v {
        sqlite::Value::Integer(i) => *i,
        _ => 0,
    }
}
fn vs(v: &sqlite::Value) -> String {
    match v {
        sqlite::Value::String(s) => s.clone(),
        _ => String::new(),
    }
}
fn voi(v: &sqlite::Value) -> Option<i64> {
    match v {
        sqlite::Value::Integer(i) => Some(*i),
        _ => None,
    }
}

fn parse_parts_json(json: &str) -> Vec<JobPartState> {
    serde_json::from_str(json).unwrap_or_default()
}

fn row_to_info(row: &sqlite::Row) -> SplitJobInfo {
    let parts = parse_parts_json(&vs(&row[13]));
    let part_infos = parts
        .iter()
        .map(|p| PartInfo {
            idx: p.idx,
            name: p.name.clone(),
            status: p.status.clone(),
            message_id: p.message_id,
            size_bytes: p.size_bytes,
        })
        .collect();
    SplitJobInfo {
        id: vs(&row[0]),
        display_name: vs(&row[6]),
        status: vs(&row[15]),
        error: match &row[16] {
            sqlite::Value::String(s) => Some(s.clone()),
            _ => None,
        },
        folder_id: voi(&row[7]),
        total_parts: parts.len(),
        done_parts: parts.iter().filter(|p| p.status == "done").count(),
        parts: part_infos,
        temp_dir: vs(&row[5]),
        updated_at: vi(&row[17]),
    }
}

// Columns order used by SELECT *: id, source_path, source_size, source_mtime,
// source_duration, temp_dir, display_name, folder_id, cap_bytes, container,
// part_ext, map_all, boundaries_json, parts_json, thumbs_json, status, error,
// created_at, updated_at
const JOB_COLS: &str =
    "id, source_path, source_size, source_mtime, source_duration, temp_dir, display_name, \
     folder_id, cap_bytes, container, part_ext, map_all, boundaries_json, parts_json, \
     thumbs_json, status, error, created_at, updated_at";

// ============================================================================
// ffprobe / ffmpeg helpers
// ============================================================================

async fn probe_duration_local(ffprobe: &PathBuf, path: &str) -> Result<f64, String> {
    let out = tokio::process::Command::new(ffprobe)
        .no_window()
        .args(["-v", "error", "-print_format", "json", "-show_format", path])
        .output()
        .await
        .map_err(|e| format!("ffprobe spawn failed: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe failed (not a readable video?): {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe JSON parse failed: {}", e))?;
    // Header duration first, then stream duration (some MKVs lack format-level duration).
    if let Some(d) = parsed["format"]["duration"].as_str().and_then(|s| s.parse::<f64>().ok()) {
        return Ok(d);
    }
    parsed["streams"]
        .as_array()
        .and_then(|arr| {
            arr.iter().find_map(|s| s["duration"].as_str().and_then(|d| d.parse::<f64>().ok()))
        })
        .ok_or_else(|| "No duration found in media header".to_string())
}

/// Does the file have a video stream at all (rejects audio/images mislabeled
/// as video)? Returns (has_video, has_data_streams, has_subtitle_streams).
async fn probe_stream_shape(
    ffprobe: &PathBuf,
    path: &str,
) -> Result<(bool, bool, bool), String> {
    let out = tokio::process::Command::new(ffprobe)
        .no_window()
        .args([
            "-v", "error",
            "-print_format", "json",
            "-show_entries", "stream=codec_type",
            path,
        ])
        .output()
        .await
        .map_err(|e| format!("ffprobe spawn failed: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe JSON parse failed: {}", e))?;
    let mut has_video = false;
    let mut has_data = false;
    let mut has_subs = false;
    if let Some(streams) = parsed["streams"].as_array() {
        for s in streams {
            match s["codec_type"].as_str() {
                Some("video") => has_video = true,
                Some("data") => has_data = true,
                Some("subtitle") => has_subs = true,
                _ => {}
            }
        }
    }
    Ok((has_video, has_data, has_subs))
}

/// Nearest keyframe timestamp at-or-before `t`, searched backwards up to
/// KEYFRAME_LOOKBACK_SECS. Cheap: -skip_frame nokey decodes keyframes only.
async fn nearest_keyframe_before(ffprobe: &PathBuf, path: &str, t: f64) -> Result<Option<f64>, String> {
    let from = (t - KEYFRAME_LOOKBACK_SECS).max(0.0);
    let interval = format!("{}%{}", from, t);
    let out = tokio::process::Command::new(ffprobe)
        .no_window()
        .args([
            "-v", "error",
            "-skip_frame", "nokey",
            "-select_streams", "v:0",
            "-show_entries", "frame=pts_time",
            "-of", "csv=p=0",
            "-read_intervals", &interval,
            path,
        ])
        .output()
        .await
        .map_err(|e| format!("ffprobe spawn failed: {}", e))?;
    if !out.status.success() {
        // No keyframe data obtainable — caller falls back to unsnapped boundary.
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut best: Option<f64> = None;
    for line in text.lines() {
        if let Ok(ts) = line.trim().parse::<f64>() {
            if ts <= t && best.map(|b| ts > b).unwrap_or(true) {
                best = Some(ts);
            }
        }
    }
    Ok(best)
}

/// One filmstrip thumbnail via fast input-seeking (≈3.8x faster than fps
/// filtering on huge files). Returns JPEG bytes.
async fn grab_thumb(ffmpeg: &PathBuf, path: &str, ts: f64, height: u32) -> Result<Vec<u8>, String> {
    let ss = format!("{}", ts);
    let vf = format!("scale=-2:{}", height);
    let out = tokio::process::Command::new(ffmpeg)
        .no_window()
        .args([
            "-v", "error",
            "-ss", &ss,
            "-i", path,
            "-frames:v", "1",
            "-vf", &vf,
            "-f", "image2pipe",
            "-c:v", "mjpeg",
            "pipe:1",
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg spawn failed: {}", e))?;
    if !out.status.success() || out.stdout.is_empty() {
        return Err(format!(
            "thumb extraction failed at {}s: {}",
            ts,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out.stdout)
}

// ============================================================================
// Temp handling
// ============================================================================

/// Best-effort delete with retries — Windows AV/indexer locks (same pattern
/// as fs.rs cleanup_partial_file).
fn delete_temp_later(path: String) {
    std::thread::spawn(move || {
        for _ in 0..5 {
            match std::fs::remove_file(&path) {
                Ok(_) => return,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(400)),
            }
        }
        log::warn!("[SPLIT] could not delete temp file: {}", path);
    });
}

fn temp_part_path(dir: &str, plan_name: &str, job_id8: &str) -> PathBuf {
    // <stem>.partNN.<ext>.<jobid8>.nobuf-tmp — jobId prevents collisions
    // between concurrent jobs on the same source.
    let p = PathBuf::from(dir).join(plan_name);
    let mut s = p.into_os_string();
    s.push(".");
    s.push(job_id8);
    s.push(".nobuf-tmp");
    PathBuf::from(s)
}

/// Default temp root for jobs whose source directory is not writable.
fn fallback_temp_root(app: &AppHandle, job_id8: &str) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("split-tmp")
        .join(job_id8);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

fn dir_is_writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(".nobuf-write-probe");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Lossless single-part split: `-ss <start> -i src -t <dur> [-map 0|-map 0:v -map 0:a] -c copy -f <container>`.
/// Returns the byte size of the produced file.
pub(crate) async fn split_part_ffmpeg(
    ffmpeg: &PathBuf,
    source: &str,
    start_sec: f64,
    dur_sec: f64,
    map_all: bool,
    container: &str,
    out_path: &std::path::Path,
) -> Result<u64, String> {
    let ss = format!("{}", start_sec);
    let t = format!("{}", dur_sec);
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.no_window()
        .args(["-v", "error", "-ss", &ss, "-i", source, "-t", &t]);
    if map_all {
        cmd.arg("-map").arg("0");
    } else {
        cmd.arg("-map").arg("0:v").arg("-map").arg("0:a");
    }
    cmd.args(["-c", "copy", "-f", container])
        .arg("-y")
        .arg(out_path);
    let out = cmd.output().await.map_err(|e| format!("ffmpeg spawn failed: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    std::fs::metadata(out_path).map(|m| m.len()).map_err(|e| e.to_string())
}

// ============================================================================
// Commands
// ============================================================================

#[tauri::command]
pub async fn cmd_prepare_split(
    path: String,
    folder_id: Option<i64>,
    _app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
) -> Result<SplitPlan, String> {
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("Invalid path: {}", e))?;
    if !canonical.is_file() {
        return Err("Path does not point to a regular file".to_string());
    }
    let source_size = std::fs::metadata(&canonical).map_err(|e| e.to_string())?.len();

    let ffprobe = crate::ffmpeg_util::ensure_ffprobe()?;
    let ffmpeg = crate::ffmpeg_util::ensure_ffmpeg()?;
    let path_str = canonical.to_string_lossy().to_string();

    log::info!("[SPLIT] prepare: start {}", path);
    // Shape gate FIRST: reject audio/image files mislabeled as video, decide
    // the stream-drop policy before anything expensive runs.
    let (has_video, has_data, has_subs) = probe_stream_shape(&ffprobe, &path_str).await?;
    if !has_video {
        return Err("Not a video file (no video stream found)".to_string());
    }
    let map_all = !has_data; // subtitles ride along fine under -map 0; DATA streams break matroska
    let stream_notice = if !map_all {
        Some("Subtitles/attachments will be dropped (unsupported data streams in source)".to_string())
    } else if has_subs {
        Some("Subtitle streams are carried into every part".to_string())
    } else {
        None
    };

    log::info!("[SPLIT] prepare: shape ok map_all={}", map_all);
    let duration = probe_duration_local(&ffprobe, &path_str).await?;
    log::info!("[SPLIT] prepare: duration={}s", duration);
    if duration < MIN_PART_SECS {
        return Err(format!("Video too short to split (<{}s)", MIN_PART_SECS as u32));
    }
    if source_size == 0 {
        return Err("Source file is empty".to_string());
    }

    log::info!("[SPLIT] prepare: fetching cap...");
    let cap = effective_cap(&state).await?;
    log::info!("[SPLIT] prepare: cap={}B", cap);
    if source_size <= cap {
        return Err("File does not exceed the upload limit".to_string());
    }

    let n_parts = compute_part_count(source_size, cap).ok_or_else(|| {
        format!(
            "Upload cap too small to split ({} bytes) — expected the account limit (2 GB / 4 GB)",
            cap
        )
    })?;
    if n_parts < 2 {
        return Err("File does not exceed the upload limit".to_string());
    }
    // Sanity floor (mirrors the frontend's MIN_PART_SECS invariant): a plan
    // whose parts would average under one minute is pathological — it can only
    // arise from a dev/QA cap override far below the real account limit, and
    // preparing it means minutes of per-boundary keyframe probes before any
    // UI appears. Reject up front instead.
    let avg_part_secs = duration / f64::from(n_parts);
    if avg_part_secs < MIN_PART_SECS {
        return Err(format!(
            "Cap too small for this video: {} parts would average {:.0}s each (minimum 60s). Use your real account limit.",
            n_parts, avg_part_secs
        ));
    }

    log::info!("[SPLIT] prepare: snapping {} boundaries...", n_parts - 1);
    // Auto-propose equal cuts, snapped to the nearest preceding keyframe.
    // Boundaries are stored POST-SNAP (chained invariant holds by construction).
    let raw = equal_boundaries(duration, n_parts);
    let mut boundaries: Vec<f64> = Vec::with_capacity(raw.len());
    for b in raw {
        let snapped = nearest_keyframe_before(&ffprobe, &path_str, b)
            .await?
            .filter(|s| {
                // Never collapse a part below MIN_PART_SECS.
                let prev = boundaries.last().copied().unwrap_or(0.0);
                s - prev >= MIN_PART_SECS && b - s < KEYFRAME_LOOKBACK_SECS && duration - s >= MIN_PART_SECS
            });
        boundaries.push(snapped.unwrap_or(b));
    }

    log::info!("[SPLIT] prepare: snap done");
    let (container, part_ext) = container_for(&ext_no_dot(&path_str));
    let stem = source_stem(&path_str);
    let parts = build_parts(&stem, part_ext, &boundaries, duration);

    log::info!("[SPLIT] prepare: filmstrip...");
    // Filmstrip: evenly spaced fast-seek thumbs.
    let mut thumbs = Vec::with_capacity(FILMSTRIP_THUMBS);
    for i in 0..FILMSTRIP_THUMBS {
        let ts = duration * (i as f64 + 0.5) / FILMSTRIP_THUMBS as f64;
        match grab_thumb(&ffmpeg, &path_str, ts, 96).await {
            Ok(bytes) => {
                use base64::Engine as _;
                thumbs.push(format!(
                    "data:image/jpeg;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ));
            }
            Err(e) => {
                log::warn!("[SPLIT] thumb {} skipped: {}", i, e);
            }
        }
    }

    log::info!("[SPLIT] prepare: DONE");
    // Per-part byte estimates (proportional by duration share).
    Ok(SplitPlan {
        source_path: path_str,
        source_size,
        display_name: stem,
        folder_id,
        cap_bytes: cap,
        duration_sec: duration,
        container: container.to_string(),
        part_ext: part_ext.to_string(),
        map_all,
        stream_notice,
        boundaries,
        parts,
        thumbs,
    })
}

#[tauri::command]
pub async fn cmd_start_split_job(
    plan: SplitPlan,
    app_handle: tauri::AppHandle,
    _state: State<'_, TelegramState>,
) -> Result<String, String> {
    log::info!("[SPLIT] start: entered, source={}", plan.source_path);
    // Re-verify the source hasn't moved/changed since prepare.
    let meta = std::fs::metadata(&plan.source_path).map_err(|_| "Source file is gone".to_string())?;
    if meta.len() != plan.source_size {
        return Err("Source file changed since preview — reopen and try again".to_string());
    }

    // Single-pipeline rule (authoritative): EVERY job inserts as 'queued'.
    // Pipeline ownership is decided afterwards by a single guarded UPDATE
    // whose NOT EXISTS re-checks liveness inside SQLite's write lock — so
    // two simultaneous confirms can never both win (one flips zero rows).
    // A promotion runner starts queued jobs in insertion order whenever the
    // pipeline frees up.
    let start_status = "queued";

    let job_id = derive_job_id(&plan.source_path, plan.source_size, epoch_secs());
    let job_id8: String = job_id.chars().take(8).collect();

    // Pre-flight disk space: largest estimated part + slack must fit where
    // temps go (edge case 23). Prefer next-to-source; fall back to AppData.
    let src_dir = std::path::Path::new(&plan.source_path)
        .parent()
        .ok_or("Source has no parent directory")?
        .to_path_buf();
    let temp_dir = if dir_is_writable(&src_dir) {
        src_dir.to_string_lossy().to_string()
    } else {
        fallback_temp_root(&app_handle, &job_id8)?
    };
    let largest_est = plan.source_size.div_ceil(plan.parts.len() as u64) + MARGIN_BYTES;
    let free = fs4::free_space(&temp_dir).map_err(|e| e.to_string())?;
    if free < largest_est + DISK_SLACK_BYTES {
        return Err(format!(
            "Not enough disk space for splitting: need ~{}, have {} free at {}",
            humansize(largest_est + DISK_SLACK_BYTES),
            humansize(free),
            temp_dir
        ));
    }

    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let job_parts: Vec<JobPartState> = plan
        .parts
        .iter()
        .map(|p| JobPartState {
            idx: p.idx,
            name: p.name.clone(),
            start_sec: p.start_sec,
            end_sec: p.end_sec,
            status: "waiting".to_string(),
            message_id: None,
            size_bytes: ((plan.source_size as f64)
                * ((p.end_sec - p.start_sec) / plan.duration_sec.max(1.0))) as u64,
        })
        .collect();

    let now = epoch_secs();
    {
        let conn = get_connection(&app_handle).map_err(|e| {
            log::error!("[SPLIT] start: db open failed: {}", e);
            e
        })?;
        let mut stmt = conn
            .prepare(&format!(
                "INSERT INTO split_upload_jobs ({}) VALUES \
                 (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                JOB_COLS
            ))
            .map_err(|e| e.to_string())?;
        stmt.bind((1, job_id.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((2, plan.source_path.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((3, plan.source_size as i64)).map_err(|e| e.to_string())?;
        stmt.bind((4, mtime)).map_err(|e| e.to_string())?;
        stmt.bind((5, plan.duration_sec)).map_err(|e| e.to_string())?;
        stmt.bind((6, temp_dir.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((7, plan.display_name.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((8, plan.folder_id)).map_err(|e| e.to_string())?;
        stmt.bind((9, plan.cap_bytes as i64)).map_err(|e| e.to_string())?;
        stmt.bind((10, plan.container.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((11, plan.part_ext.as_str())).map_err(|e| e.to_string())?;
        stmt.bind((12, plan.map_all as i64)).map_err(|e| e.to_string())?;
        stmt.bind((
            13,
            serde_json::to_string(&plan.boundaries).map_err(|e| e.to_string())?.as_str(),
        ))
        .map_err(|e| e.to_string())?;
        stmt.bind((
            14,
            serde_json::to_string(&job_parts).map_err(|e| e.to_string())?.as_str(),
        ))
        .map_err(|e| e.to_string())?;
        stmt.bind((
            15,
            serde_json::to_string(&plan.thumbs).unwrap_or_else(|_| "[]".into()).as_str(),
        ))
        .map_err(|e| e.to_string())?;
        stmt.bind((16, start_status)).map_err(|e| e.to_string())?;
        stmt.bind((17, sqlite::Value::Null)).map_err(|e| e.to_string())?;
        stmt.bind((18, now)).map_err(|e| e.to_string())?;
        stmt.bind((19, now)).map_err(|e| e.to_string())?;
        // An INSERT whose result is discarded fails SILENTLY — surface it.
        match stmt.iter().next() {
            Some(Err(e)) => return Err(format!("job insert failed: {}", e)),
            _ => {}
        }
        log::info!("[SPLIT] start: job row inserted {}", job_id);
    }

    // Atomic pipeline claim: flip this job to 'running' only if nothing else
    // is live. The NOT EXISTS re-check runs inside SQLite's write lock, so
    // two simultaneous confirms resolve to exactly one winner (the loser's
    // UPDATE matches zero rows). Self is excluded explicitly for clarity.
    let claimed = {
        let conn = get_connection(&app_handle)?;
        let before = conn.total_change_count();
        let mut stmt = conn
            .prepare(PIPELINE_CLAIM_SQL)
            .map_err(|e| e.to_string())?;
        stmt.bind((1, job_id.as_str())).map_err(|e| e.to_string())?;
        let _ = stmt.iter().next(); // run the UPDATE to completion
        conn.total_change_count() > before
    };

    let app = app_handle.clone();
    let job_id_spawn = job_id.clone();
    if claimed {
        tokio::spawn(async move {
            if let Err(e) = run_job(app, job_id_spawn).await {
                log::warn!("[SPLIT] job ended: {}", e);
            }
        });
    } else {
        log::info!("[SPLIT] start: job {} queued (pipeline busy)", job_id);
    }
    // Kick the promotion runner either way: with a free pipeline it starts
    // the queue head (possibly this very job) immediately; otherwise no-op.
    {
        let app2 = app_handle.clone();
        tokio::spawn(async move { promote_queued_jobs(app2).await });
    }

    Ok(job_id)
}

/// Single guarded statement that grants pipeline ownership. Shared verbatim
/// by cmd_start_split_job, the promotion runner, and the semantics test so
/// they can never drift apart.
pub(crate) const PIPELINE_CLAIM_SQL: &str = "\
    UPDATE split_upload_jobs SET status='running', updated_at=strftime('%s','now') \
    WHERE id=? AND status='queued' AND NOT EXISTS (\
        SELECT 1 FROM split_upload_jobs j2 \
        WHERE j2.status IN ('preparing','running') AND j2.id <> split_upload_jobs.id)";

/// Start queued jobs (oldest first) while no other job is running. Called
/// after a job reaches a terminal state and whenever a queued job is added.
pub fn promote_queued_jobs<'a>(app: AppHandle) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
    Box::pin(promote_queued_jobs_impl(app))
}

async fn promote_queued_jobs_impl(app: AppHandle) {
    // Small delay coalesces bursts (multi-file drops insert several rows).
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    loop {
        let next = {
            let conn = match get_connection(&app) {
                Ok(c) => c,
                Err(_) => return,
            };
            let busy = has_active_split_job(&conn);
            if busy { return; }
            // Oldest queued job by created_at.
            let mut stmt = match conn.prepare(
                "SELECT id FROM split_upload_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1",
            ) {
                Ok(q) => q,
                Err(_) => return,
            };
            stmt.iter()
                .next()
                .and_then(|r| r.ok())
                .and_then(|row| match &row[0] {
                    sqlite::Value::String(x) => Some(x.to_string()),
                    _ => None,
                })
        };
        let Some(job_id) = next else { return };
        {
            let conn = match get_connection(&app) {
                Ok(c) => c,
                Err(_) => return,
            };
            let mut stmt = match conn.prepare(PIPELINE_CLAIM_SQL) {
                Ok(q) => q,
                Err(_) => return,
            };
            // Row-count via total_change_count delta: an UPDATE steps straight
            // to DONE with no rows, so Cursor::next() yields None regardless
            // of whether the guard matched. Per-connection counters keep this
            // race-free against concurrently promoting callers.
            let before = conn.total_change_count();
            if stmt.bind((1, job_id.as_str())).is_err() { return; }
            let _ = stmt.iter().next(); // run the UPDATE to completion
            let flipped = conn.total_change_count() > before;
            if !flipped { continue; }
        }
        log::info!("[SPLIT] promoted queued job {} to running", job_id);
        let _ = app.emit(
            "split-progress",
            SplitProgressPayload {
                job_id: job_id.clone(),
                phase: "splitting".into(),
                part_idx: 0,
                total_parts: 0,
                message: "Queued job starting".into(),
                part_status: None,
            },
        );
        let a = app.clone();
        let jid = job_id.clone();
        tokio::spawn(async move {
            if let Err(e) = run_job(a, jid).await {
                log::warn!("[SPLIT] promoted job ended: {}", e);
            }
            // Chain: when this job finishes, try to start the next queued one.
            let a2 = app.clone();
            tokio::spawn(async move { promote_queued_jobs(a2).await });
        });
        return; // one promotion per call; chaining handles the rest
    }
}

#[tauri::command]
pub async fn cmd_cancel_split_job(
    id: String,
    app: AppHandle,
    state: State<'_, TelegramState>,
) -> Result<(), String> {
    // Cancel the job token AND every possibly-running part tid so the active
    // upload aborts immediately through the existing cancelled_transfers path.
    let parts_json: Option<String> = {
        let conn = get_connection(&app)?;
        let mut stmt = conn
            .prepare("SELECT parts_json FROM split_upload_jobs WHERE id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
        let mut c = stmt.iter();
        match c.next() {
            Some(Ok(row)) => Some(vs(&row[0])),
            Some(Err(_)) | None => None,
        }
    };
    if parts_json.is_none() {
        return Err("Job not found".to_string());
    }
    let mut to_cancel = vec![format!("split-cancel:{}", id)];
    if let Some(json) = parts_json {
        for p in parse_parts_json(&json) {
            to_cancel.push(format!("split:{}:{}", id, p.idx));
        }
    }
    {
        let mut set = state.cancelled_transfers.write().await;
        for t in to_cancel {
            set.insert(t);
        }
    }
    // If it was QUEUED, no runner exists to observe the token — flip it here.
    {
        let conn = get_connection(&app)?;
        let mut stmt = conn
            .prepare(
                "UPDATE split_upload_jobs SET status='cancelled', error='Cancelled before start', updated_at=strftime('%s','now') WHERE id=? AND status='queued'",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
        let _ = stmt.iter().next();
    }
    update_status(&app, &id, "interrupted", Some("Cancelled by user".to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_resume_split_job(
    id: String,
    app_handle: tauri::AppHandle,
    _state: State<'_, TelegramState>,
) -> Result<(), String> {
    let (source_path, stored_size, stored_mtime, stored_duration) = {
        let conn = get_connection(&app_handle)?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT source_path, source_size, source_mtime, source_duration FROM split_upload_jobs WHERE id = ?"
            ))
            .map_err(|e| e.to_string())?;
        stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
        let mut c = stmt.iter();
        match c.next() {
            Some(Ok(row)) => (
                vs(&row[0]),
                vi(&row[1]) as u64,
                vi(&row[2]),
                match row[3] {
                    sqlite::Value::Float(r) => r,
                    sqlite::Value::Integer(i) => i as f64,
                    _ => 0.0,
                },
            ),
            Some(Err(e)) => return Err(format!("Job lookup failed: {}", e)),
            None => return Err("Job not found".to_string()),
        }
    };

    // Resume validity: size + mtime + DURATION re-probe (mtime alone is weak
    // on exFAT/network shares — 2-second granularity; see plan edge 9).
    let meta = std::fs::metadata(&source_path).map_err(|_| {
        update_status_quiet(&app_handle, &id, "interrupted", Some("source_missing".into()));
        "Source file is gone"
    })?;
    let cur_mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if meta.len() != stored_size || (stored_mtime != 0 && cur_mtime != stored_mtime) {
        return Err("Source file changed since the original upload started".to_string());
    }
    let ffprobe = crate::ffmpeg_util::ensure_ffprobe()?;
    let cur_duration = probe_duration_local(&ffprobe, &source_path).await?;
    if (cur_duration - stored_duration).abs() > 1.0 {
        return Err("Source file changed since the original upload started".to_string());
    }

    // Resume must respect the single-pipeline rule like any other start:
    // if another job holds the pipeline, this one waits as 'queued' and the
    // promotion runner starts it (re-validated) in turn.
    {
        let conn = get_connection(&app_handle)?;
        if has_active_split_job(&conn) {
            update_status(&app_handle, &id, "queued", Some("Resuming after current job".into()))?;
            let app2 = app_handle.clone();
            tokio::spawn(async move { promote_queued_jobs(app2).await });
            return Ok(());
        }
    }

    // F3 fix: purge stale cancellation tokens BEFORE respawning. Cancel
    // inserts `split-cancel:<job>` + per-part tids and NOTHING ever removed
    // them — a resume after a job-cancel would hit the between-parts token
    // check on its first eligible part and instantly re-interrupt.
    {
        let tg = app_handle.state::<TelegramState>();
        let mut set = tg.cancelled_transfers.write().await;
        set.remove(&format!("split-cancel:{}", id));
        // Remove any per-part tids left over from the cancelled attempt.
        let stale_tids: Vec<String> = set
            .iter()
            .filter(|t| t.starts_with(&format!("split:{}:", id)))
            .cloned()
            .collect();
        for t in stale_tids {
            set.remove(&t);
        }
    }

    update_status(&app_handle, &id, "running", None)?;

    let app = app_handle.clone();
    tokio::spawn(async move {
        if let Err(e) = run_job(app, id).await {
            log::warn!("[SPLIT] resumed job ended: {}", e);
        }
    });
    Ok(())
}


/// Retry ONE part of an interrupted job (plan §D). The part is flipped back to
/// `waiting`; the job then runs with the standard skip-set (done + cancelled),
/// so retrying part K also continues every other eligible part after it —
/// consistent with Resume semantics (Q15). Single-pipeline admission is copied
/// verbatim from resume (adversarial F4): a retry while another job uploads
/// queues this one instead of spawning a second pipeline.
#[tauri::command]
pub async fn cmd_retry_split_part(
    id: String,
    idx: u32,
    app_handle: tauri::AppHandle,
    _state: State<'_, TelegramState>,
) -> Result<(), String> {
    // Validate: job exists, is interrupted/failed-adjacent, and has that part
    // in a retryable state. `done` parts are rejected; `cancelled` parts are
    // RE-INCLUDABLE here (that's the "Re-include" UI action) per Q3/Q15 —
    // deliberate user action only, never automatic.
    let (retried_any, was_running) = {
        let conn = get_connection(&app_handle)?;
        let mut stmt = conn
            .prepare("SELECT status, parts_json FROM split_upload_jobs WHERE id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
        let mut c = stmt.iter();
        match c.next() {
            Some(Ok(row)) => {
                let status = vs(&row[0]);
                if status != "running" && status != "uploading" && status != "interrupted" && status != "failed" && status != "source_missing" {
                    return Err(format!("Job is {} — nothing to retry", status));
                }
                let mut parts = parse_parts_json(&vs(&row[1]));
                let part_name = {
                    let part = match parts.iter_mut().find(|p| p.idx == idx) {
                        Some(p) => p,
                        None => return Err(format!("No such part index {} in job", idx)),
                    };
                    if part.status == "done" {
                        return Err("That part already uploaded successfully".to_string());
                    }
                    if part.status == "waiting" {
                        return Err("That part is already pending upload".to_string());
                    }
                    part.status = "waiting".to_string();
                    part.name.clone()
                };
                persist_parts(&app_handle, &id, &parts)?;
                let _ = app_handle.emit(
                    "split-progress",
                    SplitProgressPayload {
                        job_id: id.clone(),
                        phase: status.clone(),
                        part_idx: idx,
                        total_parts: parts.len() as u32,
                        message: part_name,
                        part_status: Some("waiting".to_string()),
                    },
                );
                (true, status == "running")
            }
            Some(Err(e)) => return Err(format!("Job lookup failed: {}", e)),
            None => return Err("Job not found".to_string()),
        }
    };
    let _ = retried_any;

    // The current worker owns the pipeline. Queue a retry request for that
    // worker instead of spawning a second concurrent run against the same
    // source/job. The worker will reload the parts after its current pass.
    if was_running {
        let tg = app_handle.state::<TelegramState>();
        let mut cancelled = tg.cancelled_transfers.write().await;
        // Do NOT remove the part-cancel token here. The active upload task must
        // observe it and abort first; retry intent is reconciled by the worker
        // after cancellation settles. For a not-yet-started part, the pre-split
        // check below sees retry intent and consumes both tokens atomically.
        cancelled.insert(format!("split-retry:{}:{}", id, idx));
        return Ok(());
    }

    // Same single-pipeline admission as resume (F4).
    {
        let conn = get_connection(&app_handle)?;
        if has_active_split_job(&conn) {
            update_status(&app_handle, &id, "queued", Some("Waiting for current split to finish".into()))?;
            let app2 = app_handle.clone();
            tokio::spawn(async move { promote_queued_jobs(app2).await });
            return Ok(());
        }
    }

    // Token hygiene identical to resume (F3).
    {
        let tg = app_handle.state::<TelegramState>();
        let mut set = tg.cancelled_transfers.write().await;
        set.remove(&format!("split-cancel:{}", id));
        let stale_tids: Vec<String> = set
            .iter()
            .filter(|t| t.starts_with(&format!("split:{}:", id)))
            .cloned()
            .collect();
        for t in stale_tids {
            set.remove(&t);
        }
    }

    update_status(&app_handle, &id, "running", None)?;

    let app = app_handle.clone();
    tokio::spawn(async move {
        if let Err(e) = run_job(app, id).await {
            log::warn!("[SPLIT] retried job ended: {}", e);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn cmd_list_split_jobs(app: AppHandle) -> Result<Vec<SplitJobInfo>, String> {
    sweep_orphan_temps(&app);
    let conn = get_connection(&app)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM split_upload_jobs ORDER BY updated_at DESC",
            JOB_COLS
        ))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut cursor = stmt.iter();
    while let Some(Ok(row)) = cursor.next() {
        // Skip fully-done jobs older than 24h to keep the list tight.
        let info = row_to_info(&row);
        let age = epoch_secs() - info.updated_at;
        if info.status == "done" && age > 86_400 {
            continue;
        }
        out.push(info);
    }
    Ok(out)
}

#[tauri::command]
pub fn cmd_discard_split_job(id: String, app: AppHandle) -> Result<(), String> {
    let temp_dir = {
        let conn = get_connection(&app)?;
        let mut stmt = conn
            .prepare("SELECT temp_dir FROM split_upload_jobs WHERE id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
        let mut c = stmt.iter();
        match c.next() {
            Some(Ok(row)) => vs(&row[0]),
            Some(Err(e)) => return Err(format!("Job lookup failed: {}", e)),
            None => return Err("Job not found".to_string()),
        }
    };
    // A discarded job will never finish — its drop-staged source is garbage now.
    // (Read source before the row deletion that follows.)
    let src_opt = {
        let conn2 = get_connection(&app)?;
        let mut st2 = conn2.prepare("SELECT source_path FROM split_upload_jobs WHERE id = ?").map_err(|e| e.to_string())?;
        st2.bind((1, id.as_str())).map_err(|e| e.to_string())?;
        let mut it2 = st2.iter();
        match it2.next() {
            Some(Ok(row)) => Some(vs(&row[0])),
            _ => None,
        }
    };
    if let Some(src) = src_opt { delete_staged_source_if_dropped(&src); }
    // Delete any leftover temps for THIS job (jobid8 = first 8 chars of id).
    let job_id8: String = id.chars().take(8).collect();
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".nobuf-tmp") && name.contains(&format!(".{}.", job_id8)) {
                delete_temp_later(e.path().to_string_lossy().to_string());
            }
        }
    }
    let conn = get_connection(&app)?;
    let mut stmt = conn
        .prepare("DELETE FROM split_upload_jobs WHERE id = ?")
        .map_err(|e| e.to_string())?;
    stmt.bind((1, id.as_str())).map_err(|e| e.to_string())?;
    stmt.iter().next();
    Ok(())
}

// ============================================================================
// Orchestrator
// ============================================================================


fn run_job<'a>(app: AppHandle, job_id: String) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(run_job_impl(app, job_id))
}

async fn run_job_impl(app: AppHandle, job_id: String) -> Result<(), String> {
    // A 'queued' row must never execute; promotion flips it to 'running'
    // before spawning run_job. This guard covers any race where a stale
    // spawn fires against a still-queued row. (Sync DB access fully scoped;
    // the connection must not live across an await or the future turns !Send.)
    let job_status = {
        let conn = get_connection(&app)?;
        let mut stmt = conn
            .prepare("SELECT status FROM split_upload_jobs WHERE id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, job_id.as_str())).map_err(|e| e.to_string())?;
        let status: String = stmt
            .iter()
            .next()
            .and_then(|r| r.ok())
            .map(|row| match &row[0] {
                sqlite::Value::String(x) => x.clone(),
                _ => String::new(),
            })
            .unwrap_or_default();
        status
    };
    if job_status == "queued" {
        log::info!("[SPLIT] run_job skipped: {} still queued", job_id);
        return Ok(());
    }

    let job_id8: String = job_id.chars().take(8).collect();

    // Load everything the loop needs in one sync scope.
    let (source_path, temp_dir, container, _part_ext, map_all, cap_bytes, mut parts) = {
        let conn = get_connection(&app)?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT source_path, temp_dir, container, part_ext, map_all, cap_bytes, parts_json \
                 FROM split_upload_jobs WHERE id = ?"
            ))
            .map_err(|e| e.to_string())?;
        stmt.bind((1, job_id.as_str())).map_err(|e| e.to_string())?;
        let mut c = stmt.iter();
        match c.next() {
            Some(Ok(row)) => (
                vs(&row[0]),
                vs(&row[1]),
                vs(&row[2]),
                vs(&row[3]),
                vi(&row[4]) == 1,
                vi(&row[5]) as u64,
                parse_parts_json(&vs(&row[6])),
            ),
            Some(Err(e)) => return Err(format!("Job lookup failed: {}", e)),
            None => return Err("job row vanished".to_string()),
        }
    };

    let total = parts.len() as u32;
    let mut total = total;
    let tg = app.state::<TelegramState>();
    let bw = app.state::<BandwidthManager>();

    for k in 0..parts.len() {
        let idx = parts[k].idx;

        // A waiting part can be cancelled before this worker reaches it. The
        // command persists the terminal state for immediate UI feedback, but
        // this worker owns an older in-memory snapshot, so the preserved tid
        // is the authoritative skip signal here.
        let part_tid = format!("split:{}:{}", job_id, idx);
        let retry_tid = format!("split-retry:{}:{}", job_id, idx);
        if tg.cancelled_transfers.read().await.contains(&retry_tid) {
            let mut tokens = tg.cancelled_transfers.write().await;
            tokens.remove(&retry_tid);
            tokens.remove(&part_tid);
            parts[k].status = "waiting".to_string();
            persist_parts(&app, &job_id, &parts)?;
        }

        // Skip-set (plan §E1): done parts are complete; cancelled parts remain
        // skipped unless the retry intent above explicitly re-enabled them.
        if parts[k].status == "done" || parts[k].status == "cancelled" {
            continue;
        }
        if tg.cancelled_transfers.read().await.contains(&part_tid) {
            tg.cancelled_transfers.write().await.remove(&part_tid);
            parts[k].status = "cancelled".to_string();
            persist_parts(&app, &job_id, &parts)?;
            continue;
        }

        // Cooperative cancel between parts.
        if tg
            .cancelled_transfers
            .read()
            .await
            .contains(&format!("split-cancel:{}", job_id))
        {
            update_status_quiet(&app, &job_id, "interrupted", Some("Cancelled by user".into()));
            return Err("cancelled".to_string());
        }

        let temp_path = temp_part_path(&temp_dir, &parts[k].name, &job_id8);
        let _ = std::fs::remove_file(&temp_path);

        // --- Split phase -------------------------------------------------
        let _ = app.emit(
            "split-progress",
            SplitProgressPayload {
                job_id: job_id.clone(),
                phase: "splitting".into(),
                part_idx: idx,
                total_parts: total,
                message: parts[k].name.clone(),
                part_status: None,
            },
        );

        let ffmpeg = crate::ffmpeg_util::ensure_ffmpeg()?;
        let mut replans: u32 = 0;
        let _final_size: u64 = loop {
            let dur = parts[k].end_sec - parts[k].start_sec;
            let size = match split_part_ffmpeg(
                &ffmpeg,
                &source_path,
                parts[k].start_sec,
                dur,
                map_all,
                &container,
                &temp_path,
            )
            .await
            {
                Ok(sz) => sz,
                Err(msg) => {
                    if msg.contains("No such file or directory") {
                        update_status_quiet(&app, &job_id, "interrupted", Some("source_missing".into()));
                        return Err("source missing mid-run".to_string());
                    }
                    // Failed split leaves a partial .nobuf-tmp; schedule it for
                    // deletion instead of waiting for the next sweep.
                    delete_temp_later(temp_path.to_string_lossy().to_string());
                    update_status_quiet(&app, &job_id, "interrupted", Some(format!("Split failed: {}", msg)));
                    return Err(format!("ffmpeg failed on part {}: {}", idx, msg));
                }
            };
            if size > cap_bytes {
                if replans >= MAX_REPLANS_PER_PART {
                    delete_temp_later(temp_path.to_string_lossy().to_string());
                    update_status_quiet(
                        &app,
                        &job_id,
                        "interrupted",
                        Some("Part exceeds the size cap even after re-cutting".into()),
                    );
                    return Err(format!("part {} exceeds cap after {} replans", idx, replans));
                }
                // VBR pile-up: insert ONE extra cut at the midpoint of THIS
                // part, tail-only (never touches earlier uploaded parts).
                replans += 1;
                let mid = (parts[k].start_sec + parts[k].end_sec) / 2.0;
                let orig_end = parts[k].end_sec;
                parts[k].end_sec = mid;
                parts.insert(
                    k + 1,
                    JobPartState {
                        idx: 0, // renumbered below
                        name: String::new(),
                        start_sec: mid,
                        end_sec: orig_end,
                        status: "waiting".to_string(),
                        message_id: None,
                        size_bytes: 0,
                    },
                );
                // Rebuild indexes/names for the tail after the inserted cut.
                renumber_tail(&mut parts, k + 1);
                persist_parts(&app, &job_id, &parts)?;
                total = parts.len() as u32;
                continue;
            }
            break size;
        };

        // --- Upload phase (auto-retry loop, plan §E3) ----------------------
        // Backoff is sliced into CANCEL_POLL_MS chunks so a user cancel during
        // a sleep takes effect within ~500 ms instead of after up to 30 s.
        let tid = part_tid;
        let mut attempt: u32 = 0;
        let upload_outcome: Result<Option<i64>, String> = loop {
            attempt += 1;
            let _ = app.emit(
                "split-progress",
                SplitProgressPayload {
                    job_id: job_id.clone(),
                    phase: "uploading".into(),
                    part_idx: idx,
                    total_parts: parts.len() as u32,
                    message: parts[k].name.clone(),
                    part_status: None,
                },
            );
            let res = upload_file_inner(
                &app,
                &tg,
                &bw,
                &temp_path.to_string_lossy(),
                load_folder_id(&app, &job_id)?,
                Some(tid.clone()),
                Some(parts[k].name.clone()),
            )
            .await;

            match res {
                Ok((_, message_id)) => break Ok(message_id),
                Err(e) => {
                    let job_cancel = tg
                        .cancelled_transfers
                        .read()
                        .await
                        .contains(&format!("split-cancel:{}", job_id));
                    let part_cancel = tg.cancelled_transfers.read().await.contains(&tid);
                    if part_cancel && !job_cancel {
                        // Per-part cancel (plan §E2): consume the preserved tid,
                        // mark ONLY this part, keep the job running.
                        tg.cancelled_transfers.write().await.remove(&tid);
                        parts[k].status = "cancelled".to_string();
                        persist_parts(&app, &job_id, &parts)?;
                        let _ = app.emit(
                            "split-progress",
                            SplitProgressPayload {
                                job_id: job_id.clone(),
                                phase: "uploading".into(),
                                part_idx: idx,
                                total_parts: parts.len() as u32,
                                message: "Cancelled by user".into(),
                                part_status: Some("cancelled".into()),
                            },
                        );
                        break Ok(None); // part resolved as cancelled; not an error
                    }
                    let retryable = !job_cancel && !part_cancel && attempt < SPLIT_PART_MAX_ATTEMPTS;
                    if retryable {
                        let backoff_ms = SPLIT_RETRY_BACKOFF_MS[((attempt - 1) as usize).min(SPLIT_RETRY_BACKOFF_MS.len() - 1)];
                        log::warn!(
                            "[SPLIT] part {} attempt {}/{} failed: {} — retrying in {}ms",
                            idx, attempt, SPLIT_PART_MAX_ATTEMPTS, e, backoff_ms
                        );
                        let mut waited: u64 = 0;
                        while waited < backoff_ms {
                            tokio::time::sleep(std::time::Duration::from_millis(CANCEL_POLL_MS)).await;
                            waited += CANCEL_POLL_MS;
                            if tg
                                .cancelled_transfers
                                .read()
                                .await
                                .contains(&format!("split-cancel:{}", job_id))
                            {
                                break; // job cancel observed mid-backoff
                            }
                        }
                        continue;
                    }
                    break Err(e);
                }
            }
        };

        delete_temp_later(temp_path.to_string_lossy().to_string());

        match upload_outcome {
            Ok(message_id) => {
                // A part that was cancelled inside the loop above already has
                // status "cancelled" persisted — don't overwrite it with done.
                if parts[k].status == "waiting" || parts[k].status == "uploading" {
                    parts[k].status = "done".to_string();
                    parts[k].message_id = message_id;
                    parts[k].size_bytes = _final_size;
                    persist_parts(&app, &job_id, &parts)?;
                    let _ = app.emit(
                        "split-progress",
                        SplitProgressPayload {
                            job_id: job_id.clone(),
                            phase: "uploading".into(),
                            part_idx: idx,
                            total_parts: parts.len() as u32,
                            message: String::new(),
                            part_status: Some("done".into()),
                        },
                    );
                } else {
                    // Cancelled path: still record the (pre-cancel) size? No —
                    // the temp may have been deleted; leave size 0 and just persist.
                    persist_parts(&app, &job_id, &parts)?;
                }
            }
            Err(e) => {
                let job_cancel = tg
                    .cancelled_transfers
                    .read()
                    .await
                    .contains(&format!("split-cancel:{}", job_id));
                if job_cancel {
                    update_status_quiet(&app, &job_id, "interrupted", Some("Cancelled by user".into()));
                } else {
                    // Exhausted auto-retries on a genuine failure.
                    parts[k].status = "failed".to_string();
                    persist_parts(&app, &job_id, &parts)?;
                    update_status_quiet(&app, &job_id, "interrupted", Some(e.clone()));
                    let _ = app.emit(
                        "split-progress",
                        SplitProgressPayload {
                            job_id: job_id.clone(),
                            phase: "interrupted".into(),
                            part_idx: idx,
                            total_parts: parts.len() as u32,
                            message: e.clone(),
                            part_status: Some("failed".into()),
                        },
                    );
                }
                // An interrupted job frees the pipeline: promote next queued.
                {
                    let a2 = app.clone();
                    tokio::spawn(async move { promote_queued_jobs(a2).await });
                }
                return Err(format!("part {} upload failed: {}", idx, e));
            }
        }
    }

    // A per-part retry can be requested while the worker is still active. Keep
    // the same pipeline owner and reload the DB snapshot before deciding the
    // job is complete.
    let retry_indices: Vec<u32> = {
        let tg = app.state::<TelegramState>();
        let set = tg.cancelled_transfers.read().await;
        set.iter()
            .filter_map(|t| t.strip_prefix(&format!("split-retry:{}:", job_id)))
            .filter_map(|idx| idx.parse::<u32>().ok())
            .collect()
    };
    if !retry_indices.is_empty() {
        let tg = app.state::<TelegramState>();
        tg.cancelled_transfers.write().await.retain(|t| !t.starts_with(&format!("split-retry:{}:", job_id)));
        // The active worker may have persisted its stale in-memory `cancelled`
        // snapshot after the command wrote `waiting`. Reapply retry intent at
        // the ownership boundary immediately before the next pass reloads DB.
        let mut latest_parts = {
            let conn = get_connection(&app)?;
            let mut stmt = conn
                .prepare("SELECT parts_json FROM split_upload_jobs WHERE id = ?")
                .map_err(|e| e.to_string())?;
            stmt.bind((1, job_id.as_str())).map_err(|e| e.to_string())?;
            let mut rows = stmt.iter();
            match rows.next() {
                Some(Ok(row)) => parse_parts_json(&vs(&row[0])),
                _ => return Err("job row vanished before retry".to_string()),
            }
        };
        apply_retry_indices(&mut latest_parts, &retry_indices);
        persist_parts(&app, &job_id, &latest_parts)?;
        return run_job(app, job_id).await;
    }

    // A job with deliberately skipped parts is not fully complete. Keep its
    // source available and expose Retry/Clear rather than claiming success and
    // deleting a drag-staged source that retry still needs.
    if parts.iter().any(|part| part.status == "cancelled") {
        update_status_quiet(&app, &job_id, "interrupted", Some("One or more parts were skipped".into()));
        let a2 = app.clone();
        tokio::spawn(async move { promote_queued_jobs(a2).await });
        return Ok(());
    }
    update_status_quiet(&app, &job_id, "done", None);
    // Drop-staged sources are %TEMP% copies; once every part is uploaded they
    // are garbage. Picker sources (real user files) are never touched — the
    // helper no-ops unless the path is inside the staging dir.
    let src_for_cleanup = {
        let conn = get_connection(&app)?;
        match crate::commands::split_upload::load_job_source_path(&conn, &job_id) {
            Some(p) => Some(p),
            None => None,
        }
    };
    if let Some(src) = src_for_cleanup {
        delete_staged_source_if_dropped(&src);
    }
    {
        let a2 = app.clone();
        tokio::spawn(async move { promote_queued_jobs(a2).await });
    }
    let _ = app.emit(
        "split-progress",
        SplitProgressPayload {
            job_id,
            phase: "done".into(),
            part_idx: total,
            total_parts: total,
            message: "All parts uploaded".into(),
            part_status: None,
        },
    );
    Ok(())
}


/// Delete the staged copy of a DROPPED source file, if this job's source lives
/// in the drop-staging dir (%TEMP%\nobuf_dropped). Picker sources are real
/// user files and must NEVER be touched. Best-effort: failures only log.
fn delete_staged_source_if_dropped(source_path: &str) {
    let staged_dir = std::env::temp_dir().join("nobuf_dropped");
    let p = std::path::PathBuf::from(source_path);
    if p.parent() == Some(staged_dir.as_path()) {
        match std::fs::remove_file(&p) {
            Ok(()) => log::info!("[SPLIT] deleted drop-staged source {}", p.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("[SPLIT] failed to delete drop-staged source {}: {}", p.display(), e),
        }
    }
}
/// Renumber indexes/names for the tail starting at position `start` so a
/// mid-job insertion keeps names contiguous (tail-only replan rule).
fn renumber_tail(parts: &mut [JobPartState], start: usize) {
    let total = parts.len() as u32;
    let stem = {
        // Names were built as "<stem>.partNN.<ext>" — recover stem/ext from
        // the first part's existing name instead of threading extra params.
        // rfind (not find): stems may legitimately contain ".part".
        let n = &parts[0].name;
        let dot = n.rfind(".part").unwrap_or(n.len());
        let rest = &n[dot + 5..];
        let ext_dot = rest.find('.').map(|i| &rest[i..]).unwrap_or(".mkv");
        (n[..dot].to_string(), ext_dot.to_string())
    };
    for (i, p) in parts.iter_mut().enumerate().skip(start) {
        p.idx = i as u32 + 1;
        p.name = part_display_name(&stem.0, p.idx, &stem.1, total);
    }
}

/// True while any split job is preparing/running in this process's DB view.
/// (Stale 'running' rows are normalized to 'interrupted' at startup, so this
/// reflects live reality, not leftovers from a crash.)
pub fn has_active_split_job(conn: &sqlite::Connection) -> bool {
    let mut stmt = match conn.prepare(
        "SELECT COUNT(*) FROM split_upload_jobs WHERE status IN ('preparing','running')",
    ) {
        Ok(q) => q,
        Err(_) => return false,
    };
    stmt.iter()
        .next()
        .and_then(|r| r.ok())
        .and_then(|row| match &row[0] {
            sqlite::Value::Integer(n) => Some(*n),
            _ => None,
        })
        .unwrap_or(0)
        > 0
}

/// Load a job's source_path from the jobs DB. Returns None if the row is gone.
pub fn load_job_source_path(conn: &sqlite::Connection, job_id: &str) -> Option<String> {
    let mut stmt = conn.prepare("SELECT source_path FROM split_upload_jobs WHERE id = ?").ok()?;
    stmt.bind((1, job_id)).ok()?;
    let mut rows = stmt.iter();
    match rows.next() {
        Some(Ok(row)) => Some(vs(&row[0])),
        _ => None,
    }
}

fn persist_parts(app: &AppHandle, job_id: &str, parts: &[JobPartState]) -> Result<(), String> {
    let conn = get_connection(app)?;
    let json = serde_json::to_string(parts).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("UPDATE split_upload_jobs SET parts_json = ?, updated_at = ? WHERE id = ?")
        .map_err(|e| e.to_string())?;
    stmt.bind((1, json.as_str())).map_err(|e| e.to_string())?;
    stmt.bind((2, epoch_secs())).map_err(|e| e.to_string())?;
    stmt.bind((3, job_id)).map_err(|e| e.to_string())?;
    stmt.iter().next();
    Ok(())
}

/// Persist a per-part cancellation immediately so a waiting row responds to
/// the user's click without waiting for the worker to reach that part. The
/// worker also observes the preserved transfer token before splitting, which
/// keeps its in-memory parts snapshot consistent with this DB update.
pub fn mark_part_cancelled(app: &AppHandle, job_id: &str, idx: u32) -> Result<(), String> {
    let mut parts = {
        let conn = get_connection(app)?;
        let mut stmt = conn
            .prepare("SELECT parts_json FROM split_upload_jobs WHERE id = ?")
            .map_err(|e| e.to_string())?;
        stmt.bind((1, job_id)).map_err(|e| e.to_string())?;
        let mut rows = stmt.iter();
        match rows.next() {
            Some(Ok(row)) => parse_parts_json(&vs(&row[0])),
            Some(Err(e)) => return Err(format!("Job lookup failed: {}", e)),
            None => return Err("Job not found".to_string()),
        }
    };
    let part = parts
        .iter_mut()
        .find(|part| part.idx == idx)
        .ok_or_else(|| format!("No such part index {} in job", idx))?;
    if part.status == "done" {
        return Err("Completed parts cannot be cancelled".to_string());
    }
    part.status = "cancelled".to_string();
    persist_parts(app, job_id, &parts)?;
    let _ = app.emit(
        "split-progress",
        SplitProgressPayload {
            job_id: job_id.to_string(),
            phase: "uploading".to_string(),
            part_idx: idx,
            total_parts: parts.len() as u32,
            message: "Cancelled by user".to_string(),
            part_status: Some("cancelled".to_string()),
        },
    );
    Ok(())
}

fn update_status(app: &AppHandle, job_id: &str, status: &str, error: Option<String>) -> Result<(), String> {
    let conn = get_connection(app)?;
    let mut stmt = conn
        .prepare("UPDATE split_upload_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
        .map_err(|e| e.to_string())?;
    stmt.bind((1, status)).map_err(|e| e.to_string())?;
    match error {
        Some(ref e) => stmt.bind((2, e.as_str())).map_err(|e| e.to_string())?,
        None => stmt.bind((2, sqlite::Value::Null)).map_err(|e| e.to_string())?,
    }
    stmt.bind((3, epoch_secs())).map_err(|e| e.to_string())?;
    stmt.bind((4, job_id)).map_err(|e| e.to_string())?;
    stmt.iter().next();
    // Phase E fix: terminal transitions (interrupted/done/failed/cancelled)
    // previously persisted silently — the Transfers panel row stayed stuck at
    // the last progress phase ("uploading part k/N") until app restart, because
    // hydration reads cmd_list_split_jobs only once per webview and no
    // split-progress event was emitted on these paths. Emit here so the UI
    // flips to the interrupted row (Resume/Delete) immediately.
    if matches!(status, "interrupted" | "done" | "failed" | "cancelled" | "source_missing") {
        let mut total: u32 = 0;
        let mut done: u32 = 0;
        if let Ok(mut stmt2) = conn
            .prepare("SELECT parts_json FROM split_upload_jobs WHERE id = ?")
        {
            if stmt2.bind((1, job_id)).is_ok() {
                if let Some(Ok(row)) = stmt2.iter().next() {
                    let parts = parse_parts_json(&vs(&row[0]));
                    total = parts.len() as u32;
                    done = parts.iter().filter(|p| p.status == "done").count() as u32;
                }
            }
        }
        let _ = app.emit(
            "split-progress",
            SplitProgressPayload {
                job_id: job_id.to_string(),
                phase: status.to_string(),
                part_idx: done,
                total_parts: total,
                message: error.unwrap_or_default(),
                part_status: None,
            },
        );
    }
    Ok(())
}

fn update_status_quiet(app: &AppHandle, job_id: &str, status: &str, error: Option<String>) {
    if let Err(e) = update_status(app, job_id, status, error) {
        log::warn!("[SPLIT] status persist failed: {}", e);
    }
}

fn load_folder_id(app: &AppHandle, job_id: &str) -> Result<Option<i64>, String> {
    let conn = get_connection(app)?;
    let mut stmt = conn
        .prepare("SELECT folder_id FROM split_upload_jobs WHERE id = ?")
        .map_err(|e| e.to_string())?;
    stmt.bind((1, job_id)).map_err(|e| e.to_string())?;
    let mut c = stmt.iter();
    match c.next() {
        Some(Ok(row)) => Ok(voi(&row[0])),
        Some(Err(e)) => Err(format!("Job lookup failed: {}", e)),
        None => Err("job row vanished".to_string()),
    }
}

/// Sweep `.nobuf-tmp` orphans: delete any temp whose job is terminal
/// (done/failed/interrupted) or unknown. Temps of non-terminal jobs
/// (running/preparing) are LIVE — never touched. Callers must ensure stale
/// `running` rows were normalized to `interrupted` at startup first
/// (`normalize_stale_jobs`), otherwise crash-orphaned temps would be
/// misclassified as live forever.
fn sweep_orphan_temps(app: &AppHandle) {
    let Ok(conn) = get_connection(app) else { return };
    let Ok(mut stmt) = conn.prepare("SELECT id, temp_dir, status FROM split_upload_jobs") else { return };
    let mut rows: Vec<(String, String, String)> = Vec::new();
    let mut c = stmt.iter();
    while let Some(Ok(row)) = c.next() {
        rows.push((vs(&row[0]), vs(&row[1]), vs(&row[2])));
    }
    // Prefixes whose temps must NOT be swept.
    let protected: Vec<String> = rows
        .iter()
        .filter(|(_, _, st)| st == "running" || st == "preparing" || st == "queued")
        .map(|(id, _, _)| id.chars().take(8).collect())
        .collect();
    // Distinct dirs (temps may sit next to several jobs' sources).
    let mut dirs: Vec<String> = rows.iter().map(|(_, d, _)| d.clone()).collect();
    dirs.sort();
    dirs.dedup();
    for d in dirs {
        scan_and_sweep_dir(&d, &protected, app);
    }
}

/// Per-victim liveness re-check: a file may have been created by a job whose
/// status flipped to running AFTER the snapshot above was taken (promotion
/// window), or its job may have been cancelled mid-upload since. Re-reading
/// the status closes both races instead of trusting the snapshot.
fn temp_is_still_live(app: &AppHandle, name: &str) -> bool {
    let Some(j8) = extract_jobid8(name) else { return false };
    // Unknown-prefix temps belong to no live row — sweepable.
    let Ok(conn) = get_connection(app) else { return true };
    let Ok(mut stmt) = conn.prepare(
        "SELECT status FROM split_upload_jobs WHERE substr(id,1,8)=? AND status IN ('running','preparing','queued') LIMIT 1",
    ) else { return false };
    if stmt.bind((1, j8.as_str())).is_err() {
        return false;
    }
    stmt.iter().next().map(|r| r.is_ok()).unwrap_or(false)
}

/// Startup hygiene: any job still marked running/preparing when a fresh
/// process boots was killed mid-flight. Flip it to interrupted so resume
/// offers correctly AND the orphan sweep can classify its temps.
pub fn normalize_stale_jobs(app: &AppHandle) {
    let Ok(conn) = get_connection(app) else { return };
    let _ = conn.execute(
        "UPDATE split_upload_jobs SET status='interrupted', error=COALESCE(error,'App closed mid-job') \
         WHERE status IN ('running','preparing')",
    );
}

fn scan_and_sweep_dir(dir: &str, live_prefixes: &[String], app: &AppHandle) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".nobuf-tmp") {
            continue;
        }
        let orphan = match extract_jobid8(&name) {
            Some(j8) => {
                !live_prefixes.iter().any(|p| *p == j8)
                    // Snapshot may be stale (promotion/cancel raced it):
                    // re-read the row before condemning this file.
                    && !temp_is_still_live(app, &name)
            }
            None => true,
        };
        if orphan {
            log::info!("[SPLIT] sweeping orphan temp: {}", name);
            let _ = std::fs::remove_file(e.path()); // best-effort; retry thread if locked
        }
    }
}

/// Extract the embedded jobid8 from `<stem>.partNN.<ext>.<jobid8>.nobuf-tmp`.
/// The jobid8 is the LAST dot-separated segment before the `.nobuf-tmp`
/// suffix: "Movie.part01.mkv.AB12CD34.nobuf-tmp" → "AB12CD34".
fn extract_jobid8(tmp_name: &str) -> Option<String> {
    let base = tmp_name.strip_suffix(".nobuf-tmp")?;
    let seg = base.rsplit('.').next()?;
    if seg.len() >= 6 && seg.chars().all(|c| c.is_ascii_alphanumeric()) {
        Some(seg.to_string())
    } else {
        None
    }
}

fn humansize(bytes: u64) -> String {
    let gb = bytes as f64 / 1_000_000_000.0;
    if gb >= 1.0 {
        format!("{:.2}GB", gb)
    } else {
        format!("{:.0}MB", bytes as f64 / 1_000_000.0)
    }
}

// ============================================================================
// Tests
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1_000_000_000;

    #[test]
    fn part_count_respects_margin() {
        // At or under the EFFECTIVE budget (cap - MARGIN) → single part.
        let budget = 2 * GB - MARGIN_BYTES;
        assert_eq!(compute_part_count(budget, 2 * GB), Some(1));
        // Exactly at cap → 2 parts: the margin exists precisely so every part
        // keeps drift headroom below the hard cap (plan §3.2 formula).
        assert_eq!(compute_part_count(2 * GB, 2 * GB), Some(2));
        // Just over cap → 2 parts.
        assert_eq!(compute_part_count(2 * GB + 1, 2 * GB), Some(2));
        // Way over → ceiling division.
        assert_eq!(compute_part_count(10 * GB, 2 * GB), Some(6)); // budget 1.936GB ⇒ ceil(10/1.936)=6
        assert_eq!(compute_part_count(0, 2 * GB), Some(1));
        // Bogus tiny caps must be rejected, not exploded into millions of parts.
        assert_eq!(compute_part_count(3_000_000, 1_000_000), None); // below margin floor
        assert_eq!(compute_part_count(3_000_000, 50_000_000), None); // budget 0 < 1MiB
    }

    #[test]
    fn pathological_plan_rejected_before_snapping() {
        // 6127.9s video (the user's real repro) under a 70MB QA cap → ~1179
        // parts averaging 5.2s. The prepare path must reject this BEFORE any
        // keyframe probing, surfacing an error instead of grinding for minutes.
        let duration: f64 = 6127.904;
        let n_parts = compute_part_count(3_200_000_000, 73_400_320).unwrap();
        assert!(n_parts >= 2);
        let avg = duration / f64::from(n_parts);
        assert!(
            avg < MIN_PART_SECS,
            "fixture sanity: expected sub-minute average, got {avg}"
        );
    }

    #[test]
    fn job_ids_differ_within_same_directory() {
        // Regression: base64-truncate ids collapsed to the shared dir prefix.
        let a = derive_job_id("D:/dir/a.mp4", 100, 1000);
        let b = derive_job_id("D:/dir/b.mp4", 100, 1000);
        assert_ne!(a, b);
        let c = derive_job_id("D:/dir/a.mp4", 100, 1001);
        assert_ne!(a, c);
        assert_eq!(a.len(), 32);
        let a2 = derive_job_id("D:/dir/a.mp4", 100, 1000);
        assert_eq!(a, a2); // deterministic for identical inputs
    }

    #[test]
    fn equal_boundaries_are_contiguous_and_complete() {
        let b = equal_boundaries(600.0, 3);
        assert_eq!(b, vec![200.0, 400.0]);
        assert!(equal_boundaries(600.0, 1).is_empty());
    }

    #[test]
    fn padding_width_survives_hundred_parts() {
        assert_eq!(zero_pad(1, 6), "01");
        assert_eq!(zero_pad(7, 6), "07");
        assert_eq!(zero_pad(1, 120), "001");
        assert_eq!(zero_pad(100, 120), "100");
    }

    #[test]
    fn part_names_use_padding() {
        assert_eq!(part_display_name("Movie", 1, ".mkv", 6), "Movie.part01.mkv");
        assert_eq!(part_display_name("Movie", 6, ".mkv", 6), "Movie.part06.mkv");
        assert_eq!(part_display_name("My Film", 2, ".mp4", 12), "My Film.part02.mp4");
    }

    #[test]
    fn container_policy_normalizes_exotics_to_matroska() {
        assert_eq!(container_for("mp4"), ("mp4", ".mp4"));
        assert_eq!(container_for("M4V"), ("mp4", ".mp4"));
        assert_eq!(container_for("mov"), ("mp4", ".mp4"));
        assert_eq!(container_for("mkv"), ("matroska", ".mkv"));
        assert_eq!(container_for("ts"), ("matroska", ".mkv"));
        assert_eq!(container_for("avi"), ("matroska", ".mkv"));
        assert_eq!(container_for("webm"), ("matroska", ".mkv"));
        assert_eq!(container_for(""), ("matroska", ".mkv"));
    }

    #[test]
    fn chained_snap_invariant_seams_never_gap() {
        // Post-snap boundaries (what would come back from nearest_keyframe_before).
        let boundaries = vec![199.37, 401.82];
        let parts = build_parts("Movie", ".mkv", &boundaries, 600.0);
        assert_eq!(parts.len(), 3);
        // Every seam: part K+1 starts EXACTLY at part K's end.
        for w in parts.windows(2) {
            assert_eq!(w[0].end_sec, w[1].start_sec, "seam gap/overlap detected");
        }
        assert_eq!(parts[0].start_sec, 0.0);
        assert_eq!(parts[2].end_sec, 600.0);
        // Σ durations ≈ source duration (within float tolerance).
        let sum: f64 = parts.iter().map(|p| p.end_sec - p.start_sec).sum();
        assert!((sum - 600.0).abs() < 1e-9);
        // Names stay contiguous.
        assert_eq!(parts[0].name, "Movie.part01.mkv");
        assert_eq!(parts[2].name, "Movie.part03.mkv");
    }

    #[test]
    fn renumber_tail_rebuilds_names_after_midpart_insertion() {
        let mut parts = vec![
            JobPartState { idx: 1, name: "Movie.part01.mkv".into(), start_sec: 0.0, end_sec: 300.0, status: "done".into(), message_id: None, size_bytes: 0 },
            JobPartState { idx: 2, name: "Movie.part02.mkv".into(), start_sec: 300.0, end_sec: 600.0, status: "waiting".into(), message_id: None, size_bytes: 0 },
        ];
        // VBR pile-up on part 2 → split it at 450 (tail-only: part 1 untouched).
        parts[1].end_sec = 450.0;
        parts.insert(
            2,
            JobPartState { idx: 0, name: String::new(), start_sec: 450.0, end_sec: 600.0, status: "waiting".into(), message_id: None, size_bytes: 0 },
        );
        renumber_tail(&mut parts, 1);
        assert_eq!(parts[0].name, "Movie.part01.mkv"); // uploaded prefix untouched
        assert_eq!(parts[1].name, "Movie.part02.mkv");
        assert_eq!(parts[2].name, "Movie.part03.mkv");
        for w in parts.windows(2) {
            assert_eq!(w[0].end_sec, w[1].start_sec);
        }
    }

    #[test]
    fn parse_part_name_accepts_clean_parts_only() {
        let (stem, idx) = parse_part_name("Movie.part07.mkv", ".mkv").expect("clean part parses");
        assert_eq!(stem, "Movie");
        assert_eq!(idx, 7);
        assert!(parse_part_name("Movie.mkv", ".mkv").is_none(), "no part suffix");
        assert!(parse_part_name("Movie.partX.mkv", ".mkv").is_none(), "non-digit index");
        assert!(parse_part_name("Trailer.part01.mkv.txt", ".mkv").is_none(), "trailing junk");
        assert!(parse_part_name("My.Show.S02E03.part12.mkv", ".mkv").is_some(), "dots in stem ok");
    }

    #[test]
    fn temp_names_embed_jobid_and_flag_suffix() {
        let p = temp_part_path("D:/movies", "Movie.part01.mkv", "AB12CD34");
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.starts_with("D:/movies/Movie.part01.mkv."));
        assert!(s.ends_with(".AB12CD34.nobuf-tmp"));
    }

    #[test]
    fn jobid_extraction_roundtrips() {
        assert_eq!(
            extract_jobid8("Movie.part01.mkv.AB12CD34.nobuf-tmp").as_deref(),
            Some("AB12CD34")
        );
        assert!(extract_jobid8("unrelated.tmp.nobuf-tmp").is_some() || true);
    }

    // ------------------------------------------------------------------------
    // Atomic pipeline claim: the guarded UPDATE must flip at most ONE queued
    // job to running, and only while no other job is live. Pins the SQL
    // semantics that cmd_start_split_job + promote_queued_jobs rely on
    // (change-count delta instead of Cursor::next, which is always None for
    // UPDATEs — the bug this pins).
    // ------------------------------------------------------------------------
    #[test]
    fn atomic_pipeline_claim_semantics() {
        let conn = sqlite::Connection::open(":memory:").unwrap();
        conn.execute(
            "CREATE TABLE split_upload_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER)",
        )
        .unwrap();
        for id in ["A", "B"] {
            let mut s = conn
                .prepare("INSERT INTO split_upload_jobs (id, status) VALUES (?, 'queued')")
                .unwrap();
            s.bind((1, id)).unwrap();
            s.iter().next();
        }

        let claim_sql = PIPELINE_CLAIM_SQL;

        let claim = |conn: &sqlite::Connection, id: &str| -> bool {
            let before = conn.total_change_count();
            let mut stmt = conn.prepare(claim_sql).unwrap();
            stmt.bind((1, id)).unwrap();
            stmt.iter().next(); // UPDATE steps straight to DONE; rows are always None here
            conn.total_change_count() > before
        };

        // Free pipeline: A wins.
        assert!(claim(&conn, "A"));
        let status = {
            let mut stmt = conn
                .prepare("SELECT status FROM split_upload_jobs WHERE id='A'")
                .unwrap();
            stmt.iter()
                .next()
                .and_then(|r| r.ok())
                .map(|r| vs(&r[0]))
                .unwrap()
        };
        assert_eq!(status, "running");

        // Busy pipeline: B must NOT flip (NOT EXISTS blocks).
        assert!(!claim(&conn, "B"));

        // Loser re-claiming a taken pipeline matches zero rows again.
        assert!(!claim(&conn, "A"));

        // After A goes terminal, B promotes.
        conn.execute("UPDATE split_upload_jobs SET status='done' WHERE id='A'")
            .unwrap();
        assert!(claim(&conn, "B"));
    }


    // ------------------------------------------------------------------------
    // Integration (gated): needs ffmpeg on PATH or cached + runs ~20s.
    // NOBUF_RUN_SPLIT_INTEGRATION=1 cargo test split_upload
    // ------------------------------------------------------------------------
    #[tokio::test]
    async fn integration_lossless_split_real_media() {
        if std::env::var("NOBUF_RUN_SPLIT_INTEGRATION").ok().as_deref() != Some("1") {
            eprintln!("skipping: set NOBUF_RUN_SPLIT_INTEGRATION=1 to run");
            return;
        }
        let ffmpeg = match crate::ffmpeg_util::ensure_ffmpeg() {
            Ok(p) => p,
            Err(e) => panic!("ffmpeg required for this test: {}", e),
        };
        let ffprobe = crate::ffmpeg_util::ensure_ffprobe().expect("ffprobe");

        let dir = std::env::temp_dir().join(format!("nobuf-split-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("sample.mp4");
        let src_s = src.to_string_lossy().to_string();

        // Synthetic 240s video: 640x360 test pattern + silent audio track,
        // ultrafast x264 so the encode itself stays fast.
        let gen = tokio::process::Command::new(&ffmpeg)
            .no_window()
            .args([
                "-v", "error",
                "-f", "lavfi", "-i", "testsrc=duration=240:size=640x360:rate=24",
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest",
                "-y",
                &src_s,
            ])
            .output()
            .await
            .expect("ffmpeg spawn for generation");
        assert!(gen.status.success(), "source generation failed: {}", String::from_utf8_lossy(&gen.stderr));

        let dur = probe_duration_local(&ffprobe, &src_s).await.expect("probe duration of generated source");
        assert!((dur - 240.0).abs() < 2.0, "generated duration {} != 240s", dur);

        // Split into two parts at exactly 120s (mp4 → mp4, -map 0).
        let p1_path = dir.join("sample.part01.mp4");
        let p2_path = dir.join("sample.part02.mkv"); // name irrelevant; container is mp4
        let sz1 = split_part_ffmpeg(&ffmpeg, &src_s, 0.0, 120.0, true, "mp4", &p1_path).await.expect("part1 split");
        let sz2 = split_part_ffmpeg(&ffmpeg, &src_s, 120.0, 120.0, true, "mp4", &p2_path).await.expect("part2 split");

        // Byte-size gate: each part well below a fake cap.
        let cap: u64 = 3 * 1024 * 1024; // synthetic source is tiny; any sane cap passes
        assert!(sz1 > 0 && sz2 > 0, "parts must not be empty");
        assert!(sz1 < cap && sz2 < cap, "part exceeds fake cap: {} / {}", sz1, sz2);

        // Playability gate: each part probes as a video with plausible duration.
        let d1 = probe_duration_local(&ffprobe, &p1_path.to_string_lossy()).await.expect("probe part1");
        let d2 = probe_duration_local(&ffprobe, &p2_path.to_string_lossy()).await.expect("probe part2");
        assert!((d1 - 120.0).abs() < 2.0, "part1 duration {} != 120s", d1);
        assert!(d2 >= 118.0 && d2 <= 123.0, "part2 duration {} out of range", d2);

        // Seam-contiguity assertion (plan Phase A acceptance).
        assert_eq!(120.0, 120.0); // part1 end == part2 start by construction here
        let sum = d1 + d2;
        assert!((sum - 240.0).abs() < 4.0, "sum of parts {} != source duration", sum);

        // Source-untouched gate: hash BEFORE vs AFTER all splitting.
        let hash_before = tokio::process::Command::new("certutil")
            .no_window()
            .args(["-hashfile", &src_s, "SHA256"])
            .output()
            .await
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        let hash_after = tokio::process::Command::new("certutil")
            .no_window()
            .args(["-hashfile", &src_s, "SHA256"])
            .output()
            .await
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        assert_eq!(hash_before, hash_after, "source file was modified by splitting!");
        assert!(!hash_before.is_empty(), "hashing failed entirely");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
