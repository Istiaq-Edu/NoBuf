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

#[tauri::command]
pub async fn cmd_upload_file(
    path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    bw_state: State<'_, BandwidthManager>,
) -> Result<String, String> {
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
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
    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

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
    let message = InputMessage::new().text("").file(uploaded_file);

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
                                folder_id: folder_id.unwrap_or(0),
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
    // Gammers-client caps chunk_size at 512KB — use TELEGRAM_CHUNK_SIZE.
    let mut download_iter = client.iter_download(&media)
        .chunk_size(TELEGRAM_CHUNK_SIZE);
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

        // Write to cache file and update meta incrementally so the green bar
        // tracks download progress in real-time via cmd_get_cache_status
        if let Some(ref mut cf) = cache_file {
            let _ = cf.seek(SeekFrom::Start(chunk_start));
            let _ = cf.write_all(&bytes);

            let _lock = cache_state.lock_meta(message_id).await;
            let mut meta = cache_state.load_meta(message_id).unwrap_or_else(|| CacheMeta {
                message_id,
                folder_id: folder_id.unwrap_or(0),
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
            let (name, size, mime, ext) = match doc {
                Media::Document(d) => {
                    let n = d.name().to_string();
                    let s = d.size();
                    let m = d.mime_type().map(|s| s.to_string());
                    let e = std::path::Path::new(&n).extension().map(|os| os.to_str().unwrap_or("").to_string());
                    (n, s, m, e)
                },
                Media::Photo(_) => ("Photo.jpg".to_string(), 0, Some("image/jpeg".into()), Some("jpg".into())),
                _ => ("Unknown".to_string(), 0, None, None),
            };
            files.push(FileMetadata {
                id: msg.id() as i64, folder_id, name, size: size as u64, mime_type: mime, file_ext: ext, created_at: msg.date().to_string(), icon_type: "file".into()
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
                        let folder_id = match m.peer_id {
                            tl::enums::Peer::Channel(c) => Some(c.channel_id),
                            tl::enums::Peer::User(u) => Some(u.user_id),
                            tl::enums::Peer::Chat(c) => Some(c.chat_id),
                        };
                        files.push(FileMetadata {
                            id: m.id as i64, folder_id, name, size,
                            mime_type: Some(mime), file_ext: ext,
                            created_at: m.date.to_string(), icon_type: "file".into()
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
                        let folder_id = match m.peer_id {
                            tl::enums::Peer::Channel(c) => Some(c.channel_id),
                            tl::enums::Peer::User(u) => Some(u.user_id),
                            tl::enums::Peer::Chat(c) => Some(c.chat_id),
                        };
                        files.push(FileMetadata {
                            id: m.id as i64, folder_id, name, size,
                            mime_type: Some(mime), file_ext: ext,
                            created_at: m.date.to_string(), icon_type: "file".into()
                        });
                    }
                }
            }
        }
    }

    Ok(files)
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
                if title.to_lowercase().contains("[nb]") {
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
