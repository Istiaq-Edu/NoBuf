use tauri::{State, Emitter};
use grammers_client::types::{Media, Peer};
use grammers_client::InputMessage;
use grammers_tl_types as tl;
use std::collections::HashMap;
use crate::TelegramState;
use crate::models::{FolderMetadata, FileMetadata, ScanResult};
use crate::bandwidth::BandwidthManager;
use crate::commands::utils::{resolve_peer, map_error};
use crate::stream_cache::{self, StreamCacheManager, CacheMeta};
use crate::download_pool::StreamChunk;
use std::io::{Read, Seek, SeekFrom, Write};

/// Telegram download chunk size. Gammers-client enforces a hard cap of
/// 512 KB (MAX_CHUNK_SIZE in files.rs) and requires divisibility by 4 KB
/// (MIN_CHUNK_SIZE). We use the maximum allowed value to minimize round-trips.
const TELEGRAM_CHUNK_SIZE: i32 = 512 * 1024;

/// Get the configurable chunk size from TelegramState (in bytes).
/// Falls back to 512KB if state is unavailable (e.g. in tests).
fn get_chunk_size_bytes(state: &TelegramState) -> i32 {
    let kb = state.chunk_size_kb.load(std::sync::atomic::Ordering::Relaxed);
    (kb as i32) * 1024
}

fn extract_duration(doc: &tl::enums::Document) -> Option<f64> {
    if let tl::enums::Document::Document(d) = doc {
        for attr in &d.attributes {
            match attr {
                tl::enums::DocumentAttribute::Video(v) => return Some(v.duration),
                tl::enums::DocumentAttribute::Audio(a) => return Some(a.duration as f64),
                _ => {}
            }
        }
    }
    None
}

fn extract_duration_from_media(d: &Media) -> Option<f64> {
    match d {
        Media::Document(doc) => doc.raw.document.as_ref().and_then(extract_duration),
        _ => None,
    }
}

/// Rename a NoBuf folder (channel). Updates the Telegram channel title
/// and appends the [NB] tag if missing. Updates peer cache.
#[tauri::command]
pub async fn cmd_rename_folder(
    folder_id: i64,
    new_name: String,
    state: State<'_, TelegramState>,
) -> Result<FolderMetadata, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        log::info!("[MOCK] Renamed folder {} to '{}'", folder_id, new_name);
        return Ok(FolderMetadata { id: folder_id, name: new_name, parent_id: None });
    }
    let client = client_opt.unwrap();

    let peer = resolve_peer(&client, Some(folder_id), &state.peer_cache).await?;

    let input_channel = match peer {
        Peer::Channel(c) => {
            tl::enums::InputChannel::Channel(tl::types::InputChannel {
                channel_id: c.raw.id,
                access_hash: c.raw.access_hash.ok_or("No access hash for channel")?,
            })
        },
        _ => return Err("Only channels (folders) can be renamed.".to_string()),
    };

    // Ensure [NB] tag is present in the new title
    let tagged_name = if new_name.to_lowercase().contains("[nb]") {
        new_name.clone()
    } else {
        format!("{} [NB]", new_name)
    };

    client.invoke(&tl::functions::channels::EditTitle {
        channel: input_channel,
        title: tagged_name.clone(),
    }).await.map_err(|e| format!("Failed to rename channel: {}", e))?;

    // Update peer cache with the new name
    {
        let mut cache = state.peer_cache.write().await;
        if let Some(existing_peer) = cache.get(&folder_id).cloned() {
            if let Peer::Channel(mut c) = existing_peer {
                c.raw.title = tagged_name.clone();
                cache.insert(folder_id, Peer::Channel(c));
            }
        }
    }

    Ok(FolderMetadata { id: folder_id, name: new_name, parent_id: None })
}

/// Trigger an automatic sync on startup. This runs the same reconciliation
/// as cmd_scan_folders but is triggered programmatically after the dashboard loads.
#[tauri::command]
pub async fn cmd_start_auto_sync(
    local_folders: Vec<FolderMetadata>,
    state: State<'_, TelegramState>,
) -> Result<ScanResult, String> {
    cmd_scan_folders(local_folders, state).await
}

#[tauri::command]
pub async fn cmd_create_folder(
    name: String,
    state: State<'_, TelegramState>,
) -> Result<FolderMetadata, String> {
    let client_opt = {
        state.client.lock().await.clone()
    };
    
    // --- MOCK ---
    if client_opt.is_none() {
        let mock_id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        log::info!("[MOCK] Created folder '{}' with ID {}", name, mock_id);
        return Ok(FolderMetadata {
            id: mock_id,
            name,
            parent_id: None,
        });
    }
    // -----------
    let client = client_opt.unwrap();
    log::info!("Creating Telegram Channel: {}", name);
    
    let result = client.invoke(&tl::functions::channels::CreateChannel {
        broadcast: true,
        megagroup: false,
        title: format!("{} [NB]", name),
        about: "".to_string(),
        geo_point: None,
        address: None,
        for_import: false,
        forum: false,
        ttl_period: None,
    }).await.map_err(map_error)?;
    
    let (chat_id, access_hash) = match result {
        tl::enums::Updates::Updates(u) => {
             let chat = u.chats.first().ok_or("No chat in updates")?;
             match chat {
                 tl::enums::Chat::Channel(c) => (c.id, c.access_hash.unwrap_or(0)),
                 _ => return Err("Created chat is not a channel".to_string()),
             }
        },
        _ => return Err("Unexpected response (not Updates::Updates)".to_string()), 
    };

    // Explicitly Disable TTL
    let _input_channel = tl::enums::InputChannel::Channel(tl::types::InputChannel {
         channel_id: chat_id,
         access_hash,
    });

    let _ = client.invoke(&tl::functions::messages::SetHistoryTtl {
        peer: tl::enums::InputPeer::Channel(tl::types::InputPeerChannel { channel_id: chat_id, access_hash }),
        period: 0, 
    }).await;

    Ok(FolderMetadata {
        id: chat_id,
        name,
        parent_id: None,
    })
}

/// Delete a NoBuf folder (channel) from Telegram. Also cleans peer cache.
#[tauri::command]
pub async fn cmd_delete_folder(
    folder_id: i64,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    let client_opt = {
        state.client.lock().await.clone()
    };
    
    if client_opt.is_none() {
        log::info!("[MOCK] Deleted folder ID {}", folder_id);
        // Clean peer cache
        state.peer_cache.write().await.remove(&folder_id);
        return Ok(true);
    }
    let client = client_opt.unwrap();
    log::info!("Deleting folder/channel: {}", folder_id);

    let peer = resolve_peer(&client, Some(folder_id), &state.peer_cache).await?;
    
    let input_channel = match peer {
        Peer::Channel(c) => {
             let chan = &c.raw;
             tl::enums::InputChannel::Channel(tl::types::InputChannel {
                 channel_id: chan.id,
                 access_hash: chan.access_hash.ok_or("No access hash for channel")?,
             })
        },
        _ => return Err("Only channels (folders) can be deleted.".to_string()),
    };
    
    client.invoke(&tl::functions::channels::DeleteChannel {
        channel: input_channel,
    }).await.map_err(|e| format!("Failed to delete channel: {}", e))?;

    // Clean peer cache
    state.peer_cache.write().await.remove(&folder_id);
    
    Ok(true)
}


#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    id: String,
    percent: u8,
    uploaded_bytes: u64,
    total_bytes: u64,
    speed_bytes_per_sec: u64,
}

/// Async reader wrapper that tracks bytes read for progress reporting.
/// Wraps a tokio File and counts how many bytes have been consumed.
struct ProgressReader {
    inner: tokio::io::BufReader<tokio::fs::File>,
    bytes_read: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl ProgressReader {
    async fn new(path: &str) -> Result<(Self, u64, std::sync::Arc<std::sync::atomic::AtomicU64>), String> {
        let file = tokio::fs::File::open(path).await.map_err(|e| e.to_string())?;
        let metadata = file.metadata().await.map_err(|e| e.to_string())?;
        let size = metadata.len();
        let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let reader = Self {
            inner: tokio::io::BufReader::new(file),
            bytes_read: counter.clone(),
        };
        Ok((reader, size, counter))
    }
}

impl tokio::io::AsyncRead for ProgressReader {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
        if let std::task::Poll::Ready(Ok(())) = &result {
            let after = buf.filled().len();
            let delta = (after - before) as u64;
            self.bytes_read.fetch_add(delta, std::sync::atomic::Ordering::Relaxed);
        }
        result
    }
}

/// Delete a partial file with retries (best-effort cleanup)
fn cleanup_partial_file(path: &str) {
    let path = path.to_string();
    std::thread::spawn(move || {
        for attempt in 0..5 {
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    log::info!("Cleaned up partial file: {}", path);
                    return;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
                Err(e) => {
                    log::warn!("Cleanup attempt {}/5 failed for {}: {}", attempt + 1, path, e);
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
            }
        }
    });
}

#[tauri::command]
pub async fn cmd_cancel_transfer(
    transfer_id: String,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    log::info!("Cancelling transfer: {}", transfer_id);
    state.cancelled_transfers.write().await.insert(transfer_id);
    Ok(true)
}

/// Returns the current account's per-file upload limit in bytes (Premium-aware).
/// Frontend caches this to pre-validate drops/picks instantly without a round-trip per file.
#[tauri::command]
pub async fn cmd_upload_limit(state: State<'_, TelegramState>) -> Result<u64, String> {
    let client_opt = { state.client.lock().await.clone() };
    match client_opt {
        Some(client) => crate::commands::utils::upload_limit_bytes(&client).await,
        None => Ok(2_000_000_000), // not connected → conservative free-tier default
    }
}

/// Returns a local file's size in bytes. Used for client-side pre-validation of picker uploads.
#[tauri::command]
pub async fn cmd_file_size(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(meta.len())
}

/// Free bytes available on the drive hosting the staging dir (%TEMP%\nobuf_dropped).
/// Lets the frontend reject a drop BEFORE copying GBs into a full disk.
#[tauri::command]
pub async fn cmd_staging_free_space() -> Result<u64, String> {
    let dir = std::env::temp_dir().join("nobuf_dropped");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs4::free_space(&dir).map_err(|e| e.to_string())
}

/// Stage bytes of a dropped browser File into a temp file, chunk by chunk.
/// upload_id: collision-safe id from the frontend (the QueueItem id).
/// file_name: original name (sanitized here); chunk_index 0 truncates, others append.
/// bytes_b64: base64-encoded chunk. A named Tauri arg is serialized through
/// JSON.stringify, which turns a raw Uint8Array into a ~30-40 MB number array
/// per 8 MB chunk; base64 keeps it at ~10.7 MB of plain text.
/// Returns the temp file's absolute path on the final chunk, else "".
/// Stage bytes of a dropped browser File into a temp file, chunk by chunk.
/// upload_id: collision-safe id from the frontend (the QueueItem id).
/// file_name: original name (sanitized here); chunk_index 0 truncates, others append.
/// Returns the temp file's absolute path on the final chunk, else "".
/// NOTE: `std::io::Write` is already imported at the top of this file (write_all in scope).
#[tauri::command]
pub async fn cmd_stage_dropped_file(
    upload_id: String,
    file_name: String,
    chunk_index: u64,
    is_last: bool,
    bytes_b64: String,
) -> Result<String, String> {
    use base64::Engine as _;

    // Sanitize: strip any path components — keep the bare filename only.
    let safe_name = std::path::Path::new(&file_name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "dropped".to_string());
    // Windows caps a single filename component at 255 UTF-16 units; the temp name
    // also carries "<id>-" and lives under %TEMP%\nobuf_dropped. Truncate the STEM
    // (never the extension) so the file stays recognizable and openable.
    let max_name_units = 200u16 as usize;
    let safe_name = {
        let units: usize = safe_name.chars().map(|c| c.len_utf16()).sum();
        if units > max_name_units {
            let stem = std::path::Path::new(&safe_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("file");
            let ext = std::path::Path::new(&safe_name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            // Budget: keep extension + separator, truncate stem to fit.
            let stem_budget = max_name_units.saturating_sub(ext.chars().map(|c| c.len_utf16()).sum::<usize>() + 1);
            let mut truncated: String = String::new();
            for c in stem.chars() {
                if truncated.chars().map(|x| x.len_utf16()).sum::<usize>() + c.len_utf16() > stem_budget { break; }
                truncated.push(c);
            }
            if truncated.is_empty() { truncated.push('f'); }
            if ext.is_empty() { truncated } else { format!("{}.{}", truncated, ext) }
        } else {
            safe_name
        }
    };
    let safe_id: String = upload_id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if safe_id.is_empty() {
        return Err("Invalid upload id".to_string());
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_b64.as_bytes())
        .map_err(|e| format!("Invalid chunk encoding: {}", e))?;

    let dir = std::env::temp_dir().join("nobuf_dropped");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-{}", safe_id, safe_name));

    // Multi-MB blocking writes run on a worker thread so the async runtime
    // isn't stalled while a large drop is being staged.
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(chunk_index != 0)  // first chunk: overwrite; later: append
            .truncate(chunk_index == 0)
            .open(&p)
            .map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Staging task failed: {}", e))??;

    if is_last {
        Ok(path.to_string_lossy().to_string())
    } else {
        Ok(String::new())
    }
}

/// Delete a staged dropped-file temp file. Invoked by the frontend when a
/// staged queue item reaches a terminal state (success / cancel / abandoned).
/// Guard: only paths directly inside the staging dir are accepted, so this can
/// never become a generic delete-any-file primitive.
#[tauri::command]
pub async fn cmd_delete_staged_file(path: String) -> Result<(), String> {
    let dir = std::env::temp_dir().join("nobuf_dropped");
    let p = std::path::PathBuf::from(&path);
    if p.parent() != Some(dir.as_path()) {
        return Err("Refusing to delete outside staging dir".to_string());
    }
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), // already gone
        Err(e) => Err(e.to_string()),
    }
}

/// Best-effort delete of a PARTIALLY staged dropped file (stage aborted mid-stream,
/// e.g. the source vanished or a chunk failed). Derives the same path as
/// cmd_stage_dropped_file so the frontend never constructs filesystem paths.
#[tauri::command]
pub async fn cmd_discard_staged_upload(upload_id: String, file_name: String) -> Result<(), String> {
    // Mirrors cmd_stage_dropped_file's exact naming so the derived path matches.
    let safe_name = std::path::Path::new(&file_name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "dropped".to_string());
    let safe_id: String = upload_id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if safe_id.is_empty() {
        return Err("Invalid upload id".to_string());
    }
    let dir = std::env::temp_dir().join("nobuf_dropped");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-{}", safe_id, safe_name));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Resolve the document name an uploaded file gets in Telegram.
/// Staged dropped files pass their ORIGINAL name here (the temp path carries a
/// random `<id>-` prefix that must never leak into Telegram). Falls back to the
/// path basename for picker/zip uploads. Pure - unit-tested below.
pub fn effective_document_name(display_name: &Option<String>, path: &str) -> String {
    if let Some(n) = display_name.as_deref().map(str::trim) {
        if !n.is_empty() {
            // Path::new("..") / "." / "/" yield file_name()==None, which would pass
            // the raw name through — fall back to the source path's basename instead.
            if let Some(base) = std::path::Path::new(n).file_name() {
                return base.to_string_lossy().to_string();
            }
        }
    }
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string())
}

#[tauri::command]
pub async fn cmd_upload_file(
    path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    display_name: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, BandwidthManager>,
) -> Result<String, String> {
    // Security: validate path exists and is a regular file (not a symlink to sensitive data)
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("Invalid path: {}", e))?;
    if !canonical.is_file() {
        return Err("Path does not point to a regular file".to_string());
    }
    let size = std::fs::metadata(&canonical).map_err(|e| e.to_string())?.len();
    bw_state.can_transfer(size)?;

    let tid = transfer_id.unwrap_or_default();

    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        log::info!("[MOCK] Uploaded file {} to {:?}", path, folder_id);
        bw_state.add_up(size);
        return Ok("Mock upload successful".to_string());
    }
    let client = client_opt.unwrap();

    // Emit start progress
    if !tid.is_empty() {
        let _ = app_handle.emit("upload-progress", ProgressPayload {
            id: tid.clone(), percent: 0, uploaded_bytes: 0, total_bytes: size, speed_bytes_per_sec: 0,
        });
    }

    // Create progress-tracking reader
    let (mut reader, file_size, bytes_counter) = ProgressReader::new(&path).await?;
    let file_name = effective_document_name(&display_name, &path);

    // Spawn a progress reporter task that emits events every 250ms
    let cancelled = state.cancelled_transfers.clone();
    let progress_tid = tid.clone();
    let progress_handle = app_handle.clone();
    let progress_counter = bytes_counter.clone();
    let progress_task = if !tid.is_empty() {
        Some(tokio::spawn(async move {
            let mut last_bytes: u64 = 0;
            let mut last_time = std::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let current = progress_counter.load(std::sync::atomic::Ordering::Relaxed);
                let now = std::time::Instant::now();
                let dt = now.duration_since(last_time).as_secs_f64();
                let speed = if dt > 0.0 { ((current - last_bytes) as f64 / dt) as u64 } else { 0 };
                let percent = if file_size > 0 { ((current as f64 / file_size as f64) * 100.0).min(99.0) as u8 } else { 0 };

                let _ = progress_handle.emit("upload-progress", ProgressPayload {
                    id: progress_tid.clone(), percent, uploaded_bytes: current, total_bytes: file_size, speed_bytes_per_sec: speed,
                });

                last_bytes = current;
                last_time = now;

                if current >= file_size { break; }
                // Check cancellation
                if cancelled.read().await.contains(&progress_tid) { break; }
            }
        }))
    } else {
        None
    };

    // Check cancellation before starting
    if state.cancelled_transfers.read().await.contains(&tid) {
        state.cancelled_transfers.write().await.remove(&tid);
        if let Some(t) = progress_task { t.abort(); }
        return Err("Transfer cancelled".to_string());
    }

    let client_clone = client.clone();
    let upload_result = tokio::spawn(async move {
        client_clone.upload_stream(&mut reader, file_size as usize, file_name).await
    }).await.map_err(|e| format!("Task join error: {}", e))?;

    // Stop progress reporter
    if let Some(t) = progress_task { t.abort(); }

    // Check cancellation after upload
    if state.cancelled_transfers.read().await.contains(&tid) {
        state.cancelled_transfers.write().await.remove(&tid);
        return Err("Transfer cancelled".to_string());
    }

    let uploaded_file = upload_result.map_err(map_error)?;
    // Use .document() instead of .file() — .file() sets force_file:true
    // which causes Telegram to strip DocumentAttributeVideo, losing the
    // duration metadata needed for HLS/fMP4 playback.  .document() sets
    // force_file:false so Telegram preserves video attributes.
    let message = InputMessage::new().text("").document(uploaded_file);

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    client.send_message(&peer, message).await.map_err(map_error)?;

    bw_state.add_up(size);

    // Emit completion
    if !tid.is_empty() {
        let _ = app_handle.emit("upload-progress", ProgressPayload {
            id: tid, percent: 100, uploaded_bytes: size, total_bytes: size, speed_bytes_per_sec: 0,
        });
    }

    Ok("File uploaded successfully".to_string())
}

/// Upload a file from a remote URL. Downloads to a temp file first, then
/// uploads to Telegram. Emits dual-phase progress: "downloading" then "uploading".

/// Validate that a URL is safe to fetch (no SSRF, no internal IPs)
fn validate_url(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    match parsed.scheme() {
        "http" | "https" => {},
        _ => return Err("Only HTTP(S) URLs are allowed".to_string()),
    }
    let host = parsed.host_str().ok_or("URL has no host")?;
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        let is_internal = match ip {
            std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified(),
            std::net::IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified() || (v6.segments()[0] & 0xfe00) == 0xfc00,
        };
        if is_internal {
            return Err("URLs pointing to internal addresses are not allowed".to_string());
        }
    }
    let blocked = ["localhost", "169.254.169.254", "metadata.google.internal"];
    if blocked.contains(&host) {
        return Err("URLs pointing to internal addresses are not allowed".to_string());
    }
    Ok(parsed.to_string())
}

/// Sanitize a filename to prevent path traversal and special character injection
fn sanitise_filename(raw: &str) -> String {
    let cleaned = std::path::Path::new(raw)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let cleaned: String = cleaned.chars()
        .filter(|c| !c.is_control() && *c != '\0' && *c != ':' && *c != '<' && *c != '>' && *c != '"' && *c != '|' && *c != '?' && *c != '*')
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "file".to_string()
    } else {
        cleaned
    }
}

#[tauri::command]
pub async fn cmd_upload_from_url(
    url: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, BandwidthManager>,
) -> Result<String, String> {
    let tid = transfer_id.unwrap_or_default();
    let temp_dir = std::env::temp_dir().join("nobuf_remote_upload");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    // Phase 1: Download from URL to temp file
    let url = validate_url(&url)?;
    log::info!("[REMOTE-UPLOAD] Downloading from {}", url);

    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    // Reject HTML responses (likely an error page, not a file)
    let content_type = resp.header("Content-Type").unwrap_or("").to_string();
    if content_type.starts_with("text/html") {
        return Err("URL returned an HTML page, not a file. Please check the URL.".to_string());
    }

    // Extract filename from Content-Disposition header, fallback to URL path
    let filename = {
        let cd = resp.header("Content-Disposition");
        if let Some(cd) = cd {
            // Parse filename*=UTF-8''... or filename="..."
            if let Some(pos) = cd.find("filename*=UTF-8''") {
                cd[pos + 17..].split(';').next().unwrap_or("file").to_string()
            } else if let Some(pos) = cd.find("filename=\"") {
                cd[pos + 10..].split('"').next().unwrap_or("file").to_string()
            } else if let Some(pos) = cd.find("filename=") {
                cd[pos + 9..].split(';').next().unwrap_or("file").to_string()
            } else {
                url.split('/').last().filter(|s| !s.is_empty()).unwrap_or("file").to_string()
            }
        } else {
            url.split('/').last().filter(|s| !s.is_empty()).unwrap_or("file").to_string()
        }
    };

    let filename = sanitise_filename(&filename);

    let content_length: u64 = resp.header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // Check 2GB Telegram limit
    if content_length > 2 * 1024 * 1024 * 1024 {
        return Err(format!("File exceeds Telegram's 2GB limit ({} bytes)", content_length));
    }

    // Check disk space (rough check — temp dir)
    // We skip sysinfo crate to avoid adding another dependency.
    // The OS will return a write error if disk is full, which we handle below.

    let temp_path = temp_dir.join(format!("remote_{}_{}", tid, filename));
    let mut file = std::fs::File::create(&temp_path).map_err(|e| format!("Failed to create temp file: {}", e))?;

    // Download with progress
    let mut downloaded: u64 = 0;
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 64 * 1024]; // 64KB read buffer
    let mut last_emit = std::time::Instant::now();
    let mut last_bytes: u64 = 0;

    if !tid.is_empty() {
        let _ = app_handle.emit("remote-upload-progress", ProgressPayload {
            id: tid.clone(), percent: 0, uploaded_bytes: 0, total_bytes: content_length, speed_bytes_per_sec: 0,
        });
    }

    loop {
        // Check cancellation
        if state.cancelled_transfers.read().await.contains(&tid) {
            state.cancelled_transfers.write().await.remove(&tid);
            drop(file);
            let _ = std::fs::remove_file(&temp_path);
            return Err("Transfer cancelled".to_string());
        }

        let n = reader.read(&mut buf).map_err(|e| format!("Download read error: {}", e))?;
        if n == 0 { break; }

        file.write_all(&buf[..n]).map_err(|e| format!("Temp file write error: {}", e))?;
        downloaded += n as u64;

        // Emit progress every 250ms
        if !tid.is_empty() {
            let now = std::time::Instant::now();
            let dt = now.duration_since(last_emit).as_secs_f64();
            if dt >= 0.25 || (content_length > 0 && downloaded >= content_length) {
                let speed = if dt > 0.0 { ((downloaded - last_bytes) as f64 / dt) as u64 } else { 0 };
                let percent = if content_length > 0 {
                    ((downloaded as f64 / content_length as f64) * 100.0).min(100.0) as u8
                } else { 0 };
                let _ = app_handle.emit("remote-upload-progress", ProgressPayload {
                    id: tid.clone(), percent, uploaded_bytes: downloaded, total_bytes: content_length, speed_bytes_per_sec: speed,
                });
                last_emit = now;
                last_bytes = downloaded;
            }
        }
    }

    // Flush and sync the temp file
    file.flush().map_err(|e| format!("Flush error: {}", e))?;
    file.sync_all().map_err(|e| format!("Sync error: {}", e))?;
    drop(file);

    let actual_size = std::fs::metadata(&temp_path).map(|m| m.len()).unwrap_or(0);
    if actual_size == 0 {
        let _ = std::fs::remove_file(&temp_path);
        return Err("Downloaded file was empty".to_string());
    }

    log::info!("[REMOTE-UPLOAD] Downloaded {} bytes, starting upload to Telegram", actual_size);

    // Phase 2: Upload to Telegram (same as cmd_upload_file)
    bw_state.can_transfer(actual_size)?;

    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        let _ = std::fs::remove_file(&temp_path);
        return Err("Not connected to Telegram".to_string());
    }
    let client = client_opt.unwrap();

    // Emit upload phase start
    if !tid.is_empty() {
        let _ = app_handle.emit("upload-progress", ProgressPayload {
            id: tid.clone(), percent: 0, uploaded_bytes: 0, total_bytes: actual_size, speed_bytes_per_sec: 0,
        });
    }

    let (mut reader_upload, _file_size, bytes_counter) = ProgressReader::new(temp_path.to_str().unwrap()).await?;

    // Spawn progress reporter for upload phase
    let cancelled = state.cancelled_transfers.clone();
    let progress_tid = tid.clone();
    let progress_handle = app_handle.clone();
    let progress_counter = bytes_counter.clone();
    let progress_task = if !tid.is_empty() {
        Some(tokio::spawn(async move {
            let mut last_bytes: u64 = 0;
            let mut last_time = std::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                let current = progress_counter.load(std::sync::atomic::Ordering::Relaxed);
                let now = std::time::Instant::now();
                let dt = now.duration_since(last_time).as_secs_f64();
                let speed = if dt > 0.0 { ((current - last_bytes) as f64 / dt) as u64 } else { 0 };
                let percent = if actual_size > 0 { ((current as f64 / actual_size as f64) * 100.0).min(99.0) as u8 } else { 0 };

                let _ = progress_handle.emit("upload-progress", ProgressPayload {
                    id: progress_tid.clone(), percent, uploaded_bytes: current, total_bytes: actual_size, speed_bytes_per_sec: speed,
                });

                last_bytes = current;
                last_time = now;

                if current >= actual_size { break; }
                if cancelled.read().await.contains(&progress_tid) { break; }
            }
        }))
    } else {
        None
    };

    // Check cancellation before upload
    if state.cancelled_transfers.read().await.contains(&tid) {
        state.cancelled_transfers.write().await.remove(&tid);
        if let Some(t) = progress_task { t.abort(); }
        let _ = std::fs::remove_file(&temp_path);
        return Err("Transfer cancelled".to_string());
    }

    let client_clone = client.clone();
    let upload_result = tokio::spawn(async move {
        client_clone.upload_stream(&mut reader_upload, actual_size as usize, filename.clone()).await
    }).await.map_err(|e| format!("Task join error: {}", e))?;

    if let Some(t) = progress_task { t.abort(); }

    // Check cancellation after upload
    if state.cancelled_transfers.read().await.contains(&tid) {
        state.cancelled_transfers.write().await.remove(&tid);
        let _ = std::fs::remove_file(&temp_path);
        return Err("Transfer cancelled".to_string());
    }

    let uploaded_file = upload_result.map_err(map_error)?;
    let message = InputMessage::new().text("").document(uploaded_file);

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    client.send_message(&peer, message).await.map_err(map_error)?;

    bw_state.add_up(actual_size);

    // Cleanup temp file
    let _ = std::fs::remove_file(&temp_path);

    // Emit completion
    if !tid.is_empty() {
        let _ = app_handle.emit("upload-progress", ProgressPayload {
            id: tid, percent: 100, uploaded_bytes: actual_size, total_bytes: actual_size, speed_bytes_per_sec: 0,
        });
    }

    log::info!("[REMOTE-UPLOAD] Upload complete ({} bytes)", actual_size);
    Ok("Remote file uploaded successfully".to_string())
}

#[tauri::command]
pub async fn cmd_delete_file(
    message_id: i32,
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() { 
         log::info!("[MOCK] Deleted message {} from folder {:?}", message_id, folder_id);
        return Ok(true); 
    }
    let client = client_opt.unwrap();

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    client.delete_messages(&peer, &[message_id]).await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn cmd_download_file(
    message_id: i32,
    save_path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, BandwidthManager>,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<String, String> {
    let tid = transfer_id.unwrap_or_default();

    // Canonicalize the parent directory of save_path to detect path traversal.
    // We canonicalize the parent (not the file) because the target file may not exist yet.
    if let Some(parent) = std::path::Path::new(&save_path).parent() {
        match std::fs::canonicalize(parent) {
            Ok(canon_parent) => {
                let canon_save = canon_parent.join(
                    std::path::Path::new(&save_path).file_name().unwrap_or_default()
                );
                if canon_save.to_string_lossy() != save_path {
                    log::warn!("Path canonicalization changed: {} → {}", save_path, canon_save.display());
                }
            }
            Err(e) => {
                log::warn!("Cannot canonicalize parent of save_path {}: {}", save_path, e);
            }
        }
    }

    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() { 
        log::info!("[MOCK] Downloaded message {} from {:?} to {}", message_id, folder_id, save_path);
        if let Err(e) = std::fs::write(&save_path, b"Mock Content") { return Err(e.to_string()); }
        return Ok("Download successful".to_string());
    }
    let client = client_opt.unwrap();
    
    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    // Use get_messages_by_id for efficient message lookup (same as server.rs)
    let messages = client.get_messages_by_id(&peer, &[message_id]).await.map_err(|e| e.to_string())?;
    
    let msg = messages.into_iter()
        .flatten()
        .next()
        .ok_or_else(|| "Message not found".to_string())?;

    let media = msg.media()
        .ok_or_else(|| "No media in message".to_string())?;

    let total_size = match &media {
        Media::Document(d) => d.size() as u64,
        Media::Photo(_) => 1024 * 1024,
        _ => 0,
    };
    
    bw_state.can_transfer(total_size)?;

    // Emit 0% start — percentage will rapidly jump to cached% once prebuffered
    // data is processed, then climb gradually as gaps are filled from Telegram
    if !tid.is_empty() {
        let _ = app_handle.emit("download-progress", ProgressPayload {
            id: tid.clone(), percent: 0, uploaded_bytes: 0, total_bytes: total_size, speed_bytes_per_sec: 0,
        });
    }

    // === CACHE-AWARE DOWNLOAD ===
    let cache_meta = cache_state.load_meta(message_id);
    let cache_path = cache_state.data_path(message_id);

    if let Some(ref meta) = cache_meta {
        if meta.is_complete() {
            // FULL CACHE HIT: Copy cache file to save path
            log::info!("Download {} fully cached, copying to save path", message_id);
            std::fs::copy(&cache_path, &save_path)
                .map_err(|e| format!("Failed to copy cached file: {}", e))?;

            bw_state.add_down(total_size);

            if !tid.is_empty() {
                let _ = app_handle.emit("download-progress", ProgressPayload {
                    id: tid.clone(), percent: 100, uploaded_bytes: total_size, total_bytes: total_size, speed_bytes_per_sec: 0,
                });
            }

            return Ok("Downloaded from cache".to_string());
        }

        // PARTIAL CACHE HIT
        log::info!("Download {} partially cached ({}%), using cache + Telegram",
                   message_id, meta.cached_percentage());

        let mut output_file = std::fs::File::create(&save_path)
            .map_err(|e| format!("Failed to create output file: {}", e))?;

        // Write cached ranges to output file
        for &(range_start, range_end) in &meta.cached_ranges {
            let range_len = range_end - range_start + 1;
            let mut cache_file = std::fs::File::open(&cache_path)
                .map_err(|e| format!("Failed to open cache file: {}", e))?;

            cache_file.seek(SeekFrom::Start(range_start))
                .map_err(|e| format!("Cache seek error: {}", e))?;
            output_file.seek(SeekFrom::Start(range_start))
                .map_err(|e| format!("Output seek error: {}", e))?;

            let mut remaining = range_len;
            let mut buf = vec![0u8; 512 * 1024]; // 512KB buffer
            while remaining > 0 {
                let to_read = remaining.min(buf.len() as u64) as usize;
                let n = cache_file.read(&mut buf[..to_read])
                    .map_err(|e| format!("Cache read error: {}", e))?;
                if n == 0 { break; }
                output_file.write_all(&buf[..n])
                    .map_err(|e| format!("Write error: {}", e))?;
                remaining -= n as u64;
            }
        }

        // Download gaps from Telegram, writing to both output file and disk cache
        let gaps = stream_cache::find_gaps(&meta.cached_ranges, total_size);
        let base_bytes: u64 = meta.cached_bytes(); // already in output file
        let mut gap_bytes: u64 = 0; // new bytes written this session
        let mut last_emit_time = std::time::Instant::now();
        let mut last_emit_bytes: u64 = base_bytes;

        // Emit initial progress reflecting cached bytes already written to output
        if !tid.is_empty() {
            let percent = if total_size > 0 {
                ((base_bytes as f64 / total_size as f64) * 100.0).min(100.0) as u8
            } else { 0 };
            let _ = app_handle.emit("download-progress", ProgressPayload {
                id: tid.clone(), percent, uploaded_bytes: base_bytes, total_bytes: total_size, speed_bytes_per_sec: 0,
            });
        }

        let mut cache_file = cache_state.open_data_file_write(message_id).ok();

        log::info!("Download {} filling {} gap(s)", message_id, gaps.len());

        for (gap_idx, &(gap_start, gap_end)) in gaps.iter().enumerate() {
            if state.cancelled_transfers.read().await.contains(&tid) {
                state.cancelled_transfers.write().await.remove(&tid);
                drop(output_file);
                cleanup_partial_file(&save_path);
                return Err("Transfer cancelled".to_string());
            }

            let skip_chunks = gap_start / TELEGRAM_CHUNK_SIZE as u64;
            let skip_bytes = gap_start % TELEGRAM_CHUNK_SIZE as u64;

            let mut iter = client.iter_download(&media)
                .chunk_size(TELEGRAM_CHUNK_SIZE)
                .skip_chunks(skip_chunks as i32);

            output_file.seek(SeekFrom::Start(gap_start))
                .map_err(|e| format!("Seek error: {}", e))?;
            let mut offset = gap_start;
            let mut first_chunk = true;

            while let Some(chunk_result) = {
                let _permit = state.download_semaphore.acquire().await.unwrap();
                iter.next().await.transpose()
            } {
                if state.cancelled_transfers.read().await.contains(&tid) {
                    state.cancelled_transfers.write().await.remove(&tid);
                    drop(output_file);
                    cleanup_partial_file(&save_path);
                    return Err("Transfer cancelled".to_string());
                }

                let chunk = chunk_result.map_err(|e| format!("Download error: {}", e))?;

                let chunk_slice: &[u8] = if first_chunk && skip_bytes > 0 {
                    let discard = (skip_bytes as usize).min(chunk.len());
                    first_chunk = false;
                    &chunk[discard..]
                } else {
                    first_chunk = false;
                    &chunk
                };

                let remaining_in_gap = (gap_end + 1 - offset) as usize;
                let to_write = chunk_slice.len().min(remaining_in_gap);
                let slice = &chunk_slice[..to_write];

                // Record Telegram network bytes for the speed meter
                cache_state.add_downloaded_bytes(message_id, to_write as u64);

                output_file.seek(SeekFrom::Start(offset))
                    .map_err(|e| format!("Seek error: {}", e))?;
                output_file.write_all(slice)
                    .map_err(|e| format!("Write error: {}", e))?;

                if let Some(ref mut cf) = cache_file {
                    let _ = cf.seek(SeekFrom::Start(offset));
                    let _ = cf.write_all(slice);

                    // Update cache meta incrementally (per-chunk) so the green bar
                    // tracks download progress in real-time via cmd_get_cache_status
                    let _lock = cache_state.lock_meta(message_id).await;
                    if let Some(mut m) = cache_state.load_meta(message_id) {
                        let chunk_end = offset + to_write as u64;
                        m.cached_ranges.push((offset, chunk_end - 1));
                        stream_cache::merge_ranges(&mut m.cached_ranges);
                        let _ = cache_state.save_meta(&m);
                    }
                }

                offset += to_write as u64;
                gap_bytes += to_write as u64;

                if !tid.is_empty() {
                    let now = std::time::Instant::now();
                    let dt = now.duration_since(last_emit_time).as_secs_f64();
                    if dt >= 0.25 {
                        let total_progress = base_bytes + gap_bytes;
                        let speed = if dt > 0.0 { ((total_progress - last_emit_bytes) as f64 / dt) as u64 } else { 0 };
                        let percent = if total_size > 0 { ((total_progress as f64 / total_size as f64) * 100.0).min(100.0) as u8 } else { 0 };
                        let _ = app_handle.emit("download-progress", ProgressPayload {
                            id: tid.clone(), percent, uploaded_bytes: total_progress, total_bytes: total_size, speed_bytes_per_sec: speed,
                        });
                        last_emit_time = now;
                        last_emit_bytes = total_progress;
                    }
                }

                if offset > gap_end {
                    log::info!("Gap {} filled: {}-{}", gap_idx, gap_start, gap_end);
                    break;
                }

                // Throttle: sleep to enforce download speed limit.
                // Semaphore is released after chunk fetch, so prebuffer can use
                // the connection during this sleep window. Also yield cooperatively.
                let dl_limit_kb = state.download_speed_limit_kb.load(std::sync::atomic::Ordering::Relaxed);
                if dl_limit_kb > 0 {
                    let sleep_ms = (to_write as u64 * 1000) / (dl_limit_kb * 1024);
                    let sleep_ms = sleep_ms.min(2000);
                    // log::info!("[THROTTLE-DBG][DOWNLOAD-GAP] msg={}, chunk_bytes={}, limit_kb={}/s, sleep_ms={}, offset={}", 
                    //     message_id, to_write, dl_limit_kb, sleep_ms, offset);
                    tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                } else {
                    // log::info!("[THROTTLE-DBG][DOWNLOAD-GAP] msg={}, unlimited, no throttle sleep, offset={}", 
                    //     message_id, offset);
                }
                tokio::task::yield_now().await;
            }
        }

        bw_state.add_down(total_size);

        if !tid.is_empty() {
            let _ = app_handle.emit("download-progress", ProgressPayload {
                id: tid.clone(), percent: 100, uploaded_bytes: total_size, total_bytes: total_size, speed_bytes_per_sec: 0,
            });
        }
        return Ok("Downloaded with cache assist".to_string());
    }

    // No cache available — fall through to standard download
    // Stream download with per-chunk progress -- also cache to disk so download
    // chunks serve as buffers. The green bar polls cmd_get_cache_status to track
    // download progress in real-time, and future downloads benefit from cached data.
    let mut cache_file = cache_state.open_data_file_write(message_id).ok();
    let dl_filename = match &media {
        Media::Document(d) => d.name().to_string(),
        _ => format!("{}.mp4", message_id),
    };
    let dl_mime = match &media {
        Media::Document(d) => d.mime_type().unwrap_or("application/octet-stream").to_string(),
        Media::Photo(_) => "image/jpeg".to_string(),
        _ => "application/octet-stream".to_string(),
    };

    // === PARALLEL DOWNLOAD PATH (DownloadPool) ===
    // Use 3 workers with separate TCP connections for large files (>1MB).
    // Gives ~3x bandwidth improvement per Telegram's official recommendation.
    let pool_clone = { state.download_pool.lock().await.clone() };
    if let Some(pool) = pool_clone {
        if total_size > 1024 * 1024 {
            log::info!("Download {} using parallel pool ({} bytes)", message_id, total_size);
            let mut rx = pool.stream_range(
                &media, 0, total_size - 1, total_size, state.download_semaphore.clone(),
            );

            let mut file = std::fs::File::create(&save_path).map_err(|e| e.to_string())?;
            let mut downloaded: u64 = 0;
            let mut last_emit_time = std::time::Instant::now();
            let mut last_emit_bytes: u64 = 0;

            if !tid.is_empty() {
                let _ = app_handle.emit("download-progress", ProgressPayload {
                    id: tid.clone(), percent: 0, uploaded_bytes: 0, total_bytes: total_size, speed_bytes_per_sec: 0,
                });
            }

            while let Some(msg) = rx.recv().await {
                // Check cancellation
                if state.cancelled_transfers.read().await.contains(&tid) {
                    state.cancelled_transfers.write().await.remove(&tid);
                    drop(file);
                    cleanup_partial_file(&save_path);
                    return Err("Transfer cancelled".to_string());
                }

                match msg {
                    Ok(StreamChunk { offset, data: chunk_data }) => {
                        let remaining = total_size - downloaded;
                        if remaining == 0 { break; }

                        let final_data = if chunk_data.len() as u64 > remaining {
                            chunk_data[..remaining as usize].to_vec()
                        } else {
                            chunk_data
                        };

                        let bytes_in_chunk = final_data.len() as u64;
                        let chunk_range_end = offset + bytes_in_chunk - 1;

                        // Record Telegram network bytes for the speed meter
                        cache_state.add_downloaded_bytes(message_id, bytes_in_chunk);

                        // Write to output file at correct offset
                        file.seek(SeekFrom::Start(offset))
                            .map_err(|e| format!("Seek error: {}", e))?;
                        std::io::Write::write_all(&mut file, &final_data)
                            .map_err(|e| format!("Write error: {}", e))?;

                        // Write to cache file and update meta incrementally
                        if let Some(ref mut cf) = cache_file {
                            let _ = cf.seek(SeekFrom::Start(offset));
                            let _ = cf.write_all(&final_data);

                            let _lock = cache_state.lock_meta(message_id).await;
                            let mut meta = cache_state.load_meta(message_id).unwrap_or_else(|| CacheMeta {
                                message_id,
                                folder_id: folder_id.unwrap_or(i64::MIN),
                                total_size,
                                filename: dl_filename.clone(),
                                cached_ranges: Vec::new(),
                                mime_type: dl_mime.clone(),
                            });
                            meta.cached_ranges.push((offset, chunk_range_end));
                            stream_cache::merge_ranges(&mut meta.cached_ranges);
                            let _ = cache_state.save_meta(&meta);
                        }

                        downloaded += bytes_in_chunk;

                        // Time-based progress emission (every 250ms)
                        if !tid.is_empty() {
                            let now = std::time::Instant::now();
                            let dt = now.duration_since(last_emit_time).as_secs_f64();
                            if dt >= 0.25 || downloaded >= total_size {
                                let speed = if dt > 0.0 { ((downloaded - last_emit_bytes) as f64 / dt) as u64 } else { 0 };
                                let percent = if total_size > 0 { ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as u8 } else { 0 };
                                let _ = app_handle.emit("download-progress", ProgressPayload {
                                    id: tid.clone(), percent, uploaded_bytes: downloaded, total_bytes: total_size, speed_bytes_per_sec: speed,
                                });
                                last_emit_time = now;
                                last_emit_bytes = downloaded;
                            }
                        }

                        // Throttle: sleep to enforce download speed limit.
                        let dl_limit_kb = state.download_speed_limit_kb.load(std::sync::atomic::Ordering::Relaxed);
                        if dl_limit_kb > 0 {
                            let sleep_ms = (bytes_in_chunk * 1000) / (dl_limit_kb * 1024);
                            let sleep_ms = sleep_ms.min(2000);
                            tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                        }

                        if downloaded >= total_size { break; }
                    }
                    Err(e) => {
                        log::error!("Parallel download error for {}: {}", message_id, e);
                        drop(file);
                        cleanup_partial_file(&save_path);
                        return Err(format!("Parallel download error: {}", e));
                    }
                }
            }

            // Flush + sync to ensure data is on disk before verification
            file.flush().map_err(|e| format!("Flush error: {}", e))?;
            file.sync_all().map_err(|e| format!("Sync error: {}", e))?;
            drop(file);

            // Verify download integrity (skip for photos where size is unknown)
            if total_size > 0 {
                if downloaded == 0 {
                    cleanup_partial_file(&save_path);
                    return Err("Downloaded file was empty".to_string());
                }
                if downloaded != total_size {
                    cleanup_partial_file(&save_path);
                    return Err(format!(
                        "Incomplete download: expected {} bytes, received {} bytes",
                        total_size, downloaded
                    ));
                }
                let actual_size = std::fs::metadata(&save_path)
                    .map(|m| m.len())
                    .unwrap_or(0);
                if actual_size != total_size {
                    cleanup_partial_file(&save_path);
                    return Err(format!(
                        "File size mismatch: expected {} bytes on disk, found {} bytes",
                        total_size, actual_size
                    ));
                }
            }

            bw_state.add_down(total_size);

            if !tid.is_empty() {
                let _ = app_handle.emit("download-progress", ProgressPayload {
                    id: tid, percent: 100, uploaded_bytes: downloaded, total_bytes: total_size, speed_bytes_per_sec: 0,
                });
            }

            return Ok("Download successful (parallel)".to_string());
        }
    }

    // === SEQUENTIAL FALLBACK ===
    // Progressive chunk sizing for fresh downloads.
    // Configurable chunk size (default 512KB, can be set to 128/256 via cmd_set_chunk_size)
    let chunk_size = get_chunk_size_bytes(&state);
    let mut download_iter = client.iter_download(&media)
        .chunk_size(chunk_size);
    let mut file = std::fs::File::create(&save_path).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_emit_time = std::time::Instant::now();
    let mut last_emit_bytes: u64 = 0;

    // Emit initial progress for fresh (non-cached) download
    if !tid.is_empty() {
        let _ = app_handle.emit("download-progress", ProgressPayload {
            id: tid.clone(), percent: 0, uploaded_bytes: 0, total_bytes: total_size, speed_bytes_per_sec: 0,
        });
    }

    while let Some(chunk) = {
        let _permit = state.download_semaphore.acquire().await.unwrap();
        download_iter.next().await.transpose()
    } {
        // Check cancellation
        if state.cancelled_transfers.read().await.contains(&tid) {
            state.cancelled_transfers.write().await.remove(&tid);
            drop(file);
            cleanup_partial_file(&save_path);
            return Err("Transfer cancelled".to_string());
        }

        let bytes = chunk.map_err(|e| format!("Download chunk error: {}", e))?;
        std::io::Write::write_all(&mut file, &bytes).map_err(|e| e.to_string())?;
        let chunk_start = downloaded;
        downloaded += bytes.len() as u64;

        // Record Telegram network bytes for the speed meter
        cache_state.add_downloaded_bytes(message_id, bytes.len() as u64);

        // Write to cache file and update meta incrementally so the green bar
        // tracks download progress in real-time via cmd_get_cache_status
        if let Some(ref mut cf) = cache_file {
            let _ = cf.seek(SeekFrom::Start(chunk_start));
            let _ = cf.write_all(&bytes);

            let _lock = cache_state.lock_meta(message_id).await;
            let mut meta = cache_state.load_meta(message_id).unwrap_or_else(|| CacheMeta {
                message_id,
                folder_id: folder_id.unwrap_or(i64::MIN),
                total_size,
                filename: dl_filename.clone(),
                cached_ranges: Vec::new(),
                mime_type: dl_mime.clone(),
            });
            meta.cached_ranges.push((chunk_start, downloaded - 1));
            stream_cache::merge_ranges(&mut meta.cached_ranges);
            let _ = cache_state.save_meta(&meta);
        }
        
        // Time-based progress emission (every 250ms)
        if !tid.is_empty() {
            let now = std::time::Instant::now();
            let dt = now.duration_since(last_emit_time).as_secs_f64();
            if dt >= 0.25 || downloaded >= total_size {
                let speed = if dt > 0.0 { ((downloaded - last_emit_bytes) as f64 / dt) as u64 } else { 0 };
                let percent = if total_size > 0 { ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as u8 } else { 0 };
                let _ = app_handle.emit("download-progress", ProgressPayload {
                    id: tid.clone(), percent, uploaded_bytes: downloaded, total_bytes: total_size, speed_bytes_per_sec: speed,
                });
                last_emit_time = now;
                last_emit_bytes = downloaded;
            }
        }

        // Throttle: sleep to enforce download speed limit.
        let dl_limit_kb = state.download_speed_limit_kb.load(std::sync::atomic::Ordering::Relaxed);
        if dl_limit_kb > 0 {
            let sleep_ms = (bytes.len() as u64 * 1000) / (dl_limit_kb * 1024);
            let sleep_ms = sleep_ms.min(2000);
            tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
        }
        // Yield so player prebuffer gets a fair share of the semaphore
        tokio::task::yield_now().await;
    }

    // Flush + sync to ensure data is on disk before verification
    file.flush().map_err(|e| format!("Flush error: {}", e))?;
    file.sync_all().map_err(|e| format!("Sync error: {}", e))?;
    drop(file);

    // Verify download integrity (skip for photos where size is unknown)
    if total_size > 0 {
        if downloaded == 0 {
            cleanup_partial_file(&save_path);
            return Err("Downloaded file was empty".to_string());
        }
        if downloaded != total_size {
            cleanup_partial_file(&save_path);
            return Err(format!(
                "Incomplete download: expected {} bytes, received {} bytes",
                total_size, downloaded
            ));
        }
        let actual_size = std::fs::metadata(&save_path)
            .map(|m| m.len())
            .unwrap_or(0);
        if actual_size != total_size {
            cleanup_partial_file(&save_path);
            return Err(format!(
                "File size mismatch: expected {} bytes on disk, found {} bytes",
                total_size, actual_size
            ));
        }
    }

    bw_state.add_down(total_size);

    // Emit completion
    if !tid.is_empty() {
        let _ = app_handle.emit("download-progress", ProgressPayload {
            id: tid, percent: 100, uploaded_bytes: downloaded, total_bytes: total_size, speed_bytes_per_sec: 0,
        });
    }

    Ok("Download successful".to_string())
}

#[tauri::command]
pub async fn cmd_move_files(
    message_ids: Vec<i32>,
    source_folder_id: Option<i64>,
    target_folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<bool, String> {
    if source_folder_id == target_folder_id { return Ok(true); }
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() { 
        log::info!("[MOCK] Moved msgs {:?} from {:?} to {:?}", message_ids, source_folder_id, target_folder_id);
        return Ok(true); 
    }
    let client = client_opt.unwrap();

    let source_peer = resolve_peer(&client, source_folder_id, &state.peer_cache).await?;
    let target_peer = resolve_peer(&client, target_folder_id, &state.peer_cache).await?;

    match client.forward_messages(&target_peer, &message_ids, &source_peer).await {
        Ok(_) => {},
        Err(e) => return Err(format!("Forward failed: {}", e)),
    }
    
    match client.delete_messages(&source_peer, &message_ids).await {
        Ok(_) => {},
        Err(e) => return Err(format!("Delete original failed: {}", e)),
    }

    Ok(true)
}

#[tauri::command]
pub async fn cmd_get_files(
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<Vec<FileMetadata>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() { 
        log::info!("[MOCK] Returning mock files for folder {:?}", folder_id);
        return Ok(Vec::new()); // No mock files for now
    }
    let client = client_opt.unwrap();
    let mut files = Vec::new();
    
    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    let mut msgs = client.iter_messages(&peer);
    while let Some(msg) = msgs.next().await.map_err(|e| e.to_string())? {
    if let Some(doc) = msg.media() {
            let (name, size, mime, ext, duration) = match &doc {
                Media::Document(d) => {
                    let n = d.name().to_string();
                    let s = d.size();
                    let m = d.mime_type().map(|s| s.to_string());
                    let e = std::path::Path::new(&n).extension().map(|os| os.to_str().unwrap_or("").to_string());
                    (n, s, m, e, extract_duration_from_media(&doc))
                },
                Media::Photo(_) => ("Photo.jpg".to_string(), 0, Some("image/jpeg".into()), Some("jpg".into()), None),
                _ => ("Unknown".to_string(), 0, None, None, None),
            };
            files.push(FileMetadata {
                id: msg.id() as i64, folder_id, name, size: size as u64, mime_type: mime, file_ext: ext, created_at: msg.date().to_string(), icon_type: "file".into(), duration
            });
        }
    }

    Ok(files)
}

#[tauri::command]
pub async fn cmd_search_global(
    query: String,
    state: State<'_, TelegramState>,
) -> Result<Vec<FileMetadata>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() { 
        return Ok(Vec::new());
    }
    let client = client_opt.unwrap();
    let mut files = Vec::new();
    
    log::info!("Searching global for: {}", query);

    let result = client.invoke(&tl::functions::messages::SearchGlobal {
        q: query,
        filter: tl::enums::MessagesFilter::InputMessagesFilterDocument,
        min_date: 0,
        max_date: 0,
        offset_rate: 0,
        offset_peer: tl::enums::InputPeer::Empty,
        offset_id: 0,
        limit: 50,
        folder_id: None,
        broadcasts_only: false,
        groups_only: false,
        users_only: false,
    }).await.map_err(map_error)?;

    if let tl::enums::messages::Messages::Messages(msgs) = result {
        for msg in msgs.messages {
            if let tl::enums::Message::Message(m) = msg {
                if let Some(tl::enums::MessageMedia::Document(d)) = m.media {
                    if let tl::enums::Document::Document(doc) = d.document.unwrap() {
                        let name = doc.attributes.iter().find_map(|a| match a {
                            tl::enums::DocumentAttribute::Filename(f) => Some(f.file_name.clone()),
                            _ => None
                        }).unwrap_or("Unknown".to_string());
                        let size = doc.size as u64;
                        let mime = doc.mime_type.clone();
                        let ext = std::path::Path::new(&name).extension().map(|os| os.to_str().unwrap_or("").to_string());
                        let duration = extract_duration(&tl::enums::Document::Document(doc.clone()));
                        let folder_id = match m.peer_id {
                            tl::enums::Peer::Channel(c) => Some(c.channel_id),
                            tl::enums::Peer::User(u) => Some(u.user_id),
                            tl::enums::Peer::Chat(c) => Some(c.chat_id),
                        };
                        files.push(FileMetadata {
                            id: m.id as i64, folder_id, name, size,
                            mime_type: Some(mime), file_ext: ext,
                            created_at: m.date.to_string(), icon_type: "file".into(), duration
                        });
                    }
                }
            }
        }
    } else if let tl::enums::messages::Messages::Slice(msgs) = result {
        for msg in msgs.messages {
            if let tl::enums::Message::Message(m) = msg {
                if let Some(tl::enums::MessageMedia::Document(d)) = m.media {
                    if let tl::enums::Document::Document(doc) = d.document.unwrap() {
                        let name = doc.attributes.iter().find_map(|a| match a {
                            tl::enums::DocumentAttribute::Filename(f) => Some(f.file_name.clone()),
                            _ => None
                        }).unwrap_or("Unknown".to_string());
                        let size = doc.size as u64;
                        let mime = doc.mime_type.clone();
                        let ext = std::path::Path::new(&name).extension().map(|os| os.to_str().unwrap_or("").to_string());
                        let duration = extract_duration(&tl::enums::Document::Document(doc.clone()));
                        let folder_id = match m.peer_id {
                            tl::enums::Peer::Channel(c) => Some(c.channel_id),
                            tl::enums::Peer::User(u) => Some(u.user_id),
                            tl::enums::Peer::Chat(c) => Some(c.chat_id),
                        };
                        files.push(FileMetadata {
                            id: m.id as i64, folder_id, name, size,
                            mime_type: Some(mime), file_ext: ext,
                            created_at: m.date.to_string(), icon_type: "file".into(), duration
                        });
                    }
                }
            }
        }
    }

    Ok(files)
}

/// Get the username of a channel (for copy-link feature).
/// Returns None if the channel is private (no username).
#[tauri::command]
pub async fn cmd_get_channel_username(
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<Option<String>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok(None);
    }
    let client = client_opt.unwrap();

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    match peer {
        Peer::Channel(c) => {
            Ok(c.raw.username.as_deref().map(|s| s.to_string()))
        }
        _ => Ok(None),
    }
}

/// Full reconciliation sync: scans all Telegram dialogs for NoBuf-tagged channels,
/// computes diff against the local folder list, and returns added/updated/removed.
///
/// Matching strategy: [NB] in channel title only. No about/description check.
/// Display name strips the [NB] tag for clean UI.
#[tauri::command]
pub async fn cmd_scan_folders(
    local_folders: Vec<FolderMetadata>,
    state: State<'_, TelegramState>,
) -> Result<ScanResult, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok(ScanResult { added: Vec::new(), updated: Vec::new(), removed: Vec::new(), current: Vec::new() });
    }
    let client = client_opt.unwrap();

    let mut found_folders: Vec<FolderMetadata> = Vec::new();
    let mut dialogs = client.iter_dialogs();

    log::info!("Starting Folder Scan (full reconciliation)...");

    // Acquire write lock once for the entire scan to populate the peer cache
    let mut peer_cache = state.peer_cache.write().await;

    while let Some(dialog) = dialogs.next().await.map_err(|e| e.to_string())? {
        match &dialog.peer {
            Peer::Channel(c) => {
                let id = c.raw.id;
                peer_cache.insert(id, dialog.peer.clone());

                let title = c.raw.title.clone();
                // Match only by [NB] in title (case-insensitive)
                if title.to_lowercase().contains("[nb]") && !title.to_lowercase().contains("[nb-pub]") {
                    let display_name = title
                        .replace(" [NB]", "").replace(" [nb]", "")
                        .replace("[NB]", "").replace("[nb]", "")
                        .trim()
                        .to_string();
                    log::info!(" -> MATCH: '{}' (ID: {})", display_name, id);
                    found_folders.push(FolderMetadata { id, name: display_name, parent_id: None });
                }
            },
            Peer::User(u) => {
                peer_cache.insert(u.raw.id(), dialog.peer.clone());
            },
            _peer => {}
        }
    }

    log::info!("Scan found {} NoBuf folders. Peer cache size: {}.", found_folders.len(), peer_cache.len());

    // Build lookup: found folder ID -> FolderMetadata
    let found_map: HashMap<i64, &FolderMetadata> = found_folders.iter().map(|f| (f.id, f)).collect();
    let local_map: HashMap<i64, &FolderMetadata> = local_folders.iter().map(|f| (f.id, f)).collect();

    let mut added: Vec<FolderMetadata> = Vec::new();
    let mut updated: Vec<FolderMetadata> = Vec::new();
    let mut removed: Vec<i64> = Vec::new();
    let current: Vec<FolderMetadata> = found_folders.clone();

    // New folders: in Telegram but not in local
    for f in &found_folders {
        if !local_map.contains_key(&f.id) {
            added.push(f.clone());
        }
    }

    // Updated folders: in both but name differs
    for f in &found_folders {
        if let Some(local) = local_map.get(&f.id) {
            if local.name != f.name {
                updated.push(f.clone());
            }
        }
    }

    // Removed folders: in local but not in Telegram scan results
    // (deleted, left, kicked, or [NB] tag removed from title)
    for f in &local_folders {
        if !found_map.contains_key(&f.id) {
            removed.push(f.id);
        }
    }

    log::info!("Reconciliation: +{} ~{} -{}", added.len(), updated.len(), removed.len());

    Ok(ScanResult { added, updated, removed, current })
}



#[cfg(test)]
mod staged_drop_tests {
    use base64::Engine as _;
    use super::*;

    #[test]
    fn display_name_wins_when_present_and_non_empty() {
        let dn = Some("রিপোর্ট.pdf".to_string());
        assert_eq!(
            effective_document_name(&dn, "C:\\tmp\\ab12cd34-রিপোর্ট.pdf"),
            "রিপোর্ট.pdf"
        );
    }

    #[test]
    fn blank_display_name_falls_back_to_path_basename() {
        // Fallback = the PATH's basename verbatim (picker/zip uploads keep their real
        // names; only staged drops pass displayName). The <id>- prefix belongs to the
        // fallback too - stripping it here would corrupt picker filenames.
        for blank in [Some("".to_string()), Some("   ".to_string()), None] {
            assert_eq!(effective_document_name(&blank, "C:\\tmp\\k3j2h9x7p-report.pdf"), "k3j2h9x7p-report.pdf");
        }
    }

    #[test]
    fn display_name_is_stripped_to_bare_filename() {
        let dn = Some("..\\evil\\report.pdf".to_string());
        assert_eq!(effective_document_name(&dn, "C:\\tmp\\x-report.pdf"), "report.pdf");
    }

    #[tokio::test]
    async fn stage_roundtrip_write_then_guarded_delete() {
        let id = format!("t{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos());
        let payload = b"hello staged drop";
        let b64 = base64::engine::general_purpose::STANDARD.encode(payload);
        let p1 = cmd_stage_dropped_file(id.clone(), "রিপোর্ট.txt".to_string(), 0, false, b64.clone()).await.unwrap();
        assert_eq!(p1, "");
        let full = cmd_stage_dropped_file(id.clone(), "রিপোর্ট.txt".to_string(), 1, true, b64).await.unwrap();
        assert!(full.contains("nobuf_dropped"));
        // Two chunks APPEND: final file = chunk0 ++ chunk1.
        let mut expected = payload.to_vec();
        expected.extend_from_slice(payload);
        assert_eq!(std::fs::read(&full).unwrap(), expected);
        cmd_delete_staged_file(full.clone()).await.unwrap();
        assert!(!std::path::Path::new(&full).exists());
    }

    #[tokio::test]
    async fn stage_rejects_non_base64_payload_without_touching_disk() {
        let err = cmd_stage_dropped_file("tid".to_string(), "a.bin".to_string(), 0, true, "!!!not-base64!!!".to_string()).await;
        assert!(err.unwrap_err().contains("Invalid chunk encoding"));
    }

    #[tokio::test]
    async fn delete_refuses_paths_outside_staging_dir() {
        let outside = std::env::temp_dir().join("definitely_not_nobuf_dropped.txt");
        std::fs::write(&outside, b"x").unwrap();
        let err = cmd_delete_staged_file(outside.to_string_lossy().to_string()).await;
        assert!(err.unwrap_err().contains("Refusing to delete outside staging dir"));
        let _ = std::fs::remove_file(&outside);
    }

    #[tokio::test]
    async fn delete_inside_staging_dir_is_ok_even_when_already_gone() {
        let ghost = std::env::temp_dir().join("nobuf_dropped").join("ghost-never-existed.bin");
        cmd_delete_staged_file(ghost.to_string_lossy().to_string()).await.unwrap();
    }

    #[tokio::test]
    async fn discard_removes_partially_staged_file_and_matches_staging_path() {
        // The discard command must derive EXACTLY the path cmd_stage_dropped_file
        // writes, or it would silently delete the wrong file (drift hazard).
        let id = format!("d{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos());
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"partial bytes");
        cmd_stage_dropped_file(id.clone(), "partial.bin".to_string(), 0, false, b64.clone()).await.unwrap();
        let full = cmd_stage_dropped_file(id.clone(), "partial.bin".to_string(), 1, true, b64).await.unwrap();
        assert!(std::path::Path::new(&full).exists());
        cmd_discard_staged_upload(id.clone(), "partial.bin".to_string()).await.unwrap();
        assert!(!std::path::Path::new(&full).exists());
        // Idempotent: discarding again is Ok (NotFound tolerated).
        cmd_discard_staged_upload(id, "partial.bin".to_string()).await.unwrap();
    }

    #[tokio::test]
    async fn discard_rejects_empty_upload_id() {
        let err = cmd_discard_staged_upload("".to_string(), "a.txt".to_string()).await;
        assert!(err.unwrap_err().contains("Invalid upload id"));
    }

    #[test]
    fn display_name_dot_dot_falls_back_to_path_basename() {
        // Path::new("..").file_name() == None — the raw ".." must NOT become the
        // Telegram document name; fall back to the source path's FULL basename
        // (same rule as the blank-display-name case above).
        let dn = Some("..".to_string());
        assert_eq!(effective_document_name(&dn, "C:\\tmp\\ab12cd34-real.pdf"), "ab12cd34-real.pdf");
        let dn2 = Some(".".to_string());
        assert_eq!(effective_document_name(&dn2, "C:\\tmp\\xy-file.bin"), "xy-file.bin");
    }

    #[tokio::test]
    async fn stage_truncates_overlong_filenames_but_keeps_extension() {
        // Windows caps a filename component at 255 UTF-16 units; without truncation
        // a 300-char name fails CreateFileW with a cryptic Os error mid-drop.
        let long_stem = "x".repeat(300);
        let name = format!("{}.pdf", long_stem);
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"z");
        let full = cmd_stage_dropped_file(
            format!("t{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()),
            name, 0, true, b64,
        ).await.expect("staging with an overlong name must succeed");
        let base = std::path::Path::new(&full)
            .file_name()
            .unwrap()
            .to_string_lossy().to_string();
        assert!(base.ends_with(".pdf"), "extension preserved: {}", base);
        assert!(base.chars().map(|c| c.len_utf16()).sum::<usize>() <= 255, "component <= 255 units: {}", base.len());
        let _ = std::fs::remove_file(&full);
    }
}
