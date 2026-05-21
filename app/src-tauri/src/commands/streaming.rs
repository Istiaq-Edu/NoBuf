use tauri::State;
use std::sync::Arc;
use std::io::{Write, Seek, SeekFrom};

use crate::commands::TelegramState;
use crate::commands::resolve_peer;
use crate::stream_cache::{self, StreamCacheManager, CacheMeta, merge_ranges, find_gaps};
use grammers_client::types::Media;
use grammers_tl_types as tl;

/// Holds the per-session streaming config (token + port)
pub struct StreamConfig {
    pub token: String,
    pub port: u16,
}

/// Returned to the frontend so it can construct stream URLs dynamically
#[derive(serde::Serialize)]
pub struct StreamInfo {
    pub token: String,
    pub base_url: String,
}

/// Returns the streaming server's session token and base URL to the frontend.
/// The frontend must use the returned base_url to construct stream URLs,
/// never hardcoding the port.
#[tauri::command]
pub fn cmd_get_stream_info(config: State<'_, StreamConfig>) -> StreamInfo {
    StreamInfo {
        token: config.token.clone(),
        base_url: format!("http://localhost:{}", config.port),
    }
}

/// Get cache status for a specific message
#[tauri::command]
pub async fn cmd_get_cache_status(
    message_id: i32,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<Option<stream_cache::CacheStatus>, String> {
    Ok(cache_state.get_status(message_id))
}

/// Report byte ranges that the MSE player has fetched — updates cache metadata
/// so that subsequent downloads can use cached data. The MSE player fetches
/// bytes through the Actix server which writes them to .dat, but we need to
/// ensure the meta sidecar accurately tracks which ranges are present.
#[tauri::command]
pub async fn cmd_report_cached_ranges(
    message_id: i32,
    folder_id: i64,
    total_size: u64,
    filename: String,
    mime_type: String,
    ranges: Vec<(u64, u64)>,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    // Verify the .dat file actually has data at the reported ranges
    let data_path = cache_state.data_path(message_id);
    if !data_path.exists() {
        // No cache file yet — ranges can't be present
        log::warn!("[PREBUFFER] REPORT: no .dat file for msg {}", message_id);
        return Ok(false);
    }

    let file_size = std::fs::metadata(&data_path)
        .map(|m| m.len())
        .map_err(|e| format!("Failed to read .dat metadata: {}", e))?;

    // Filter ranges: only include those where the .dat file actually covers the bytes
    let verified_ranges: Vec<(u64, u64)> = ranges
        .into_iter()
        .filter(|(_start, end)| *end < file_size)
        .collect();

    if verified_ranges.is_empty() {
        return Ok(false);
    }

    // Load existing meta or create new one (serialized via per-message lock)
    let _lock = cache_state.lock_meta(message_id).await;
    let mut meta = cache_state.load_meta(message_id).unwrap_or_else(|| CacheMeta {
        message_id,
        folder_id,
        total_size,
        filename,
        cached_ranges: Vec::new(),
        mime_type,
    });

    // Add verified ranges and merge
    meta.cached_ranges.extend(verified_ranges.clone());
    merge_ranges(&mut meta.cached_ranges);

    cache_state.save_meta(&meta)
        .map_err(|e| format!("Failed to save meta: {}", e))?;

    log::info!("[PREBUFFER] REPORT: msg {} adding verified_ranges {:?}, meta now has {} ranges ({:.1}% complete)",
        message_id, verified_ranges, meta.cached_ranges.len(), meta.cached_percentage());

    Ok(true)
}

/// Delete cache for a specific message
#[tauri::command]
pub async fn cmd_delete_cache(
    message_id: i32,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    let deleted = cache_state
        .delete_cache(message_id)
        .map_err(|e| format!("Failed to delete cache: {}", e))?;
    if !deleted {
        return Err("Cache is still streaming — retry later".to_string());
    }
    Ok(true)
}

/// Start background caching for a video — continues downloading to cache after player closes
#[tauri::command]
pub async fn cmd_start_background_cache(
    message_id: i32,
    folder_id: i64,
    _app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    // Don't start if already running
    if cache_state.has_active_task(message_id).await {
        return Ok(false);
    }

    // Don't start if already complete
    if let Some(meta) = cache_state.load_meta(message_id) {
        if meta.is_complete() {
            return Ok(false);
        }
    }

    let client = { state.client.lock().await.clone() }
        .ok_or("Not connected")?;

    let cache_mgr = cache_state.inner().clone();
    let tg_state = Arc::new(state.inner().clone());

    cache_mgr.track_task(message_id).await;

    tokio::spawn(async move {
        let result = background_cache_download(
            message_id, folder_id, client, tg_state, cache_mgr.clone(),
        )
        .await;

        cache_mgr.untrack_task(message_id).await;

        if let Err(e) = result {
            log::error!("Background cache failed for {}: {}", message_id, e);
        } else {
            log::info!("Background cache completed for {}", message_id);
        }
    });

    Ok(true)
}

/// Stop background caching for a video
#[tauri::command]
pub async fn cmd_stop_background_cache(
    message_id: i32,
    state: State<'_, TelegramState>,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    // Use the cancelled_transfers mechanism with a bg-cache prefix
    let transfer_id = format!("bg-cache-{}", message_id);
    state.cancelled_transfers.write().await.insert(transfer_id);
    cache_state.untrack_task(message_id).await;
    Ok(true)
}

/// Background download task that caches a full video to disk
async fn background_cache_download(
    message_id: i32,
    folder_id: i64,
    client: grammers_client::Client,
    state: Arc<TelegramState>,
    cache_mgr: StreamCacheManager,
) -> Result<(), String> {
    let peer = resolve_peer(&client, Some(folder_id), &state.peer_cache).await?;
    let messages = client
        .get_messages_by_id(&peer, &[message_id])
        .await
        .map_err(|e| format!("Failed to fetch message: {}", e))?;
    let message = messages
        .into_iter()
        .next()
        .ok_or("Message not found")?
        .ok_or("Message is empty")?;

    let media = message.media().ok_or("No media on message")?;

    // Extract total size using raw TL (grammers-client high-level wrapper returns 0)
    let total_size: u64 = match &message.raw {
        tl::enums::Message::Message(m) => match &m.media {
            Some(tl::enums::MessageMedia::Document(md)) => md
                .document
                .as_ref()
                .and_then(|d| match d {
                    tl::enums::Document::Document(doc) => Some(doc.size as u64),
                    _ => None,
                })
                .unwrap_or(0),
            _ => 0,
        },
        _ => 0,
    };

    if total_size == 0 {
        return Err("Could not determine file size".into());
    }

    // Check what's already cached
    let existing_meta = cache_mgr.load_meta(message_id);
    let cached_ranges = existing_meta
        .as_ref()
        .map(|m| m.cached_ranges.clone())
        .unwrap_or_default();
    let gaps = find_gaps(&cached_ranges, total_size);

    if gaps.is_empty() {
        return Ok(()); // Already fully cached
    }

    // Get filename
    let filename = match &media {
        Media::Document(d) => d.name().to_string(),
        _ => format!("{}.mp4", message_id),
    };

    // Get MIME type (same pattern as server.rs)
    let mime_type = crate::server::mime_type_from_media(&media);

    // Download gaps to cache file
    let mut cache_file = cache_mgr.open_data_file_write(message_id)
        .map_err(|e| format!("Failed to open cache file: {}", e))?;

    let chunk_size: i32 = 512 * 1024;
    let transfer_id = format!("bg-cache-{}", message_id);

    for (gap_start, gap_end) in gaps {
        let skip_chunks = gap_start / chunk_size as u64;
        let skip_bytes = gap_start % chunk_size as u64;

        let mut iter = client
            .iter_download(&media)
            .chunk_size(chunk_size)
            .skip_chunks(skip_chunks as i32);

        let mut offset = gap_start;
        let mut first_chunk = true;

        while let Ok(Some(chunk_result)) = {
            let _permit = state.download_semaphore.acquire().await.unwrap();
            iter.next().await
        } {
            // Check cancellation
            if state
                .cancelled_transfers
                .read()
                .await
                .contains(&transfer_id)
            {
                log::info!("Background cache cancelled for {}", message_id);
                return Ok(());
            }

            let chunk = chunk_result;

            // On first chunk of this gap, discard leading bytes to align with gap_start
            let chunk_slice: &[u8] = if first_chunk && skip_bytes > 0 {
                let discard = skip_bytes.min(chunk.len() as u64) as usize;
                first_chunk = false;
                &chunk[discard..]
            } else {
                first_chunk = false;
                &chunk
            };

            let remaining_in_gap = (gap_end - offset + 1) as usize;
            let to_write = chunk_slice.len().min(remaining_in_gap);

            cache_file
                .seek(SeekFrom::Start(offset))
                .map_err(|e| format!("Seek error: {}", e))?;
            cache_file
                .write_all(&chunk_slice[..to_write])
                .map_err(|e| format!("Write error: {}", e))?;

            offset += to_write as u64;

            // Update meta (serialized via per-message lock)
            let _lock = cache_mgr.lock_meta(message_id).await;
            let mut meta = cache_mgr.load_meta(message_id).unwrap_or_else(|| CacheMeta {
                message_id,
                folder_id,
                total_size,
                filename: filename.clone(),
                cached_ranges: Vec::new(),
                mime_type: mime_type.clone(),
            });
            meta.cached_ranges.push((gap_start, offset - 1));
            merge_ranges(&mut meta.cached_ranges);
            let _ = cache_mgr.save_meta(&meta);

            // Throttle: sleep to enforce download speed limit for background cache.
            // Semaphore is released after chunk fetch, so other tasks can use
            // the connection during this sleep window.
            let dl_limit_kb = state.download_speed_limit_kb.load(std::sync::atomic::Ordering::Relaxed);
            if dl_limit_kb > 0 {
                let sleep_ms = (to_write as u64 * 1000) / (dl_limit_kb * 1024);
                let sleep_ms = sleep_ms.min(2000);
                // log::info!("[THROTTLE-DBG][BG-CACHE] msg={}, chunk_bytes={}, limit_kb={}/s, sleep_ms={}, offset={}", 
                //     message_id, to_write, dl_limit_kb, sleep_ms, offset);
                tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
            } else {
                // log::info!("[THROTTLE-DBG][BG-CACHE] msg={}, unlimited, no throttle sleep, offset={}", 
                //     message_id, offset);
            }

            if offset > gap_end {
                break;
            }
        }
    }

    Ok(())
}
