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
    /// HTTP base URL for fetch-based streaming (MSE pipeline, thumbnail extraction).
    /// Also used for native <video> src on all platforms since PNA CORS headers
    /// allow cross-port localhost media loading.
    /// Example: http://localhost:14201
    pub base_url: String,
    /// Custom protocol base URL for <video> element src attribute.
    /// DEPRECATED: no longer used for native video on any platform.
    /// The direct HTTP base_url with CORS + PNA headers works reliably on
    /// all platforms, bypassing WebView2 URL safety checks and LNA/PNA
    /// restrictions. Kept for backward compatibility with older frontend code
    /// that may still reference this field.
    /// Example (Windows): http://nobuf-stream.localhost
    /// Example (macOS/Linux): nobuf-stream://localhost
    pub video_base_url: String,
}

/// Returns the streaming server's session token and base URL to the frontend.
/// The frontend must use the returned base_url to construct stream URLs,
/// never hardcoding the port.
///
/// Both base_url and video_base_url are provided, but the frontend should
/// prefer base_url (direct HTTP) for all purposes including native <video>
/// src. The Actix streaming server now includes CORS headers with
/// Access-Control-Allow-Private-Network: true, which allows cross-port
/// localhost requests even under Chromium's LNA/PNA restrictions.
#[tauri::command]
pub fn cmd_get_stream_info(config: State<'_, StreamConfig>) -> StreamInfo {
    // On Windows, WebView2 requires custom protocol URLs in http://SCHEME.localhost format.
    // See: wry src/webview2/mod.rs `attach_custom_protocol_handler`, `work_around_uri_prefix`,
    // and `is_work_around_uri`. The `AddWebResourceRequestedFilter` only intercepts
    // `http://nobuf-stream.localhost/*` — `nobuf-stream://localhost/*` is never matched.
    let video_base_url = if cfg!(windows) {
        "http://nobuf-stream.localhost".to_string()
    } else {
        "nobuf-stream://localhost".to_string()
    };

    StreamInfo {
        token: config.token.clone(),
        base_url: format!("http://localhost:{}", config.port),
        video_base_url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify base_url uses direct HTTP format (http://localhost:PORT).
    /// This is the URL used for native <video> src with PNA CORS headers.
    #[test]
    fn stream_info_base_url_format() {
        let config = StreamConfig {
            token: "test-token-123".to_string(),
            port: 14201,
        };

        // Simulate what cmd_get_stream_info returns (without Tauri State wrapper)
        let base_url = format!("http://localhost:{}", config.port);
        assert_eq!(base_url, "http://localhost:14201");
        assert!(base_url.starts_with("http://localhost:"));
        // Port must be present — no trailing slash
        assert!(base_url.matches(':').count() == 2, "base_url must include port number");
    }

    /// Verify video_base_url is platform-specific custom protocol format.
    /// On Windows: http://nobuf-stream.localhost
    /// On macOS/Linux: nobuf-stream://localhost
    #[test]
    fn stream_info_video_base_url_platform_specific() {
        let video_base_url = if cfg!(windows) {
            "http://nobuf-stream.localhost".to_string()
        } else {
            "nobuf-stream://localhost".to_string()
        };

        if cfg!(windows) {
            assert_eq!(video_base_url, "http://nobuf-stream.localhost");
            // Windows WebView2 maps custom schemes to http://SCHEME.localhost format
            assert!(video_base_url.starts_with("http://"));
            assert!(video_base_url.contains("nobuf-stream.localhost"));
        } else {
            assert_eq!(video_base_url, "nobuf-stream://localhost");
            assert!(video_base_url.starts_with("nobuf-stream://"));
        }
    }

    /// Verify base_url uses the configured port, not a hardcoded value.
    #[test]
    fn stream_info_base_url_uses_config_port() {
        let config_port_1 = StreamConfig {
            token: "test".to_string(),
            port: 14201,
        };
        let config_port_2 = StreamConfig {
            token: "test".to_string(),
            port: 8080,
        };

        let base_url_1 = format!("http://localhost:{}", config_port_1.port);
        let base_url_2 = format!("http://localhost:{}", config_port_2.port);

        assert_eq!(base_url_1, "http://localhost:14201");
        assert_eq!(base_url_2, "http://localhost:8080");
        assert_ne!(base_url_1, base_url_2, "Different ports must produce different base_urls");
    }

    /// Verify the StreamInfo struct has all required fields for serialization.
    #[test]
    fn stream_info_has_required_fields() {
        let info = StreamInfo {
            token: "abc".to_string(),
            base_url: "http://localhost:14201".to_string(),
            video_base_url: "http://nobuf-stream.localhost".to_string(),
        };

        assert_eq!(info.token, "abc");
        assert_eq!(info.base_url, "http://localhost:14201");
        assert_eq!(info.video_base_url, "http://nobuf-stream.localhost");
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

    // Per-chunk REPORT log is too verbose — commented out for testing
    // log::info!("[PREBUFFER] REPORT: msg {} adding verified_ranges {:?}, meta now has {} ranges ({:.1}% complete)",
    //     message_id, verified_ranges, meta.cached_ranges.len(), meta.cached_percentage());

    Ok(true)
}

/// Delete cache for a specific message
#[tauri::command]
pub async fn cmd_delete_cache(
    message_id: i32,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    // Check for active downloads BEFORE attempting deletion.
    // The download coordinator uses async mutex, so we check here
    // (in the async Tauri command) rather than in the sync delete_cache method.
    if cache_state.has_active_download(message_id).await {
        return Err("Cache has active download — retry later".to_string());
    }

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

    // Gammers-client chunk size cap (512KB). See fs.rs TELEGRAM_CHUNK_SIZE.
    let chunk_size: i32 = 512 * 1024;
    let transfer_id = format!("bg-cache-{}", message_id);

    // Get DownloadPool for parallel gap-filling of large gaps (>1MB)
    let pool_clone = { state.download_pool.lock().await.clone() };

    for (gap_start, gap_end) in gaps {
        let gap_size = gap_end - gap_start + 1;

        // Check cancellation
        if state.cancelled_transfers.read().await.contains(&transfer_id) {
            log::info!("Background cache cancelled for {}", message_id);
            return Ok(());
        }

        // Use parallel download for large gaps when DownloadPool is available
        if let Some(ref pool) = pool_clone {
            if gap_size > 1024 * 1024 {
                log::info!("Background cache {}: parallel download gap {}-{} ({:.1}MB)",
                    message_id, gap_start, gap_end, gap_size as f64 / (1024.0 * 1024.0));

                let data = pool.download_range(&media, gap_start, gap_end, total_size).await
                    .map_err(|e| format!("Parallel gap download error: {}", e))?;

                cache_file
                    .seek(SeekFrom::Start(gap_start))
                    .map_err(|e| format!("Seek error: {}", e))?;
                cache_file
                    .write_all(&data)
                    .map_err(|e| format!("Write error: {}", e))?;

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
                meta.cached_ranges.push((gap_start, gap_end));
                merge_ranges(&mut meta.cached_ranges);
                let _ = cache_mgr.save_meta(&meta);

                continue; // Skip sequential download for this gap
            }
        }

        // Sequential iter_download for small gaps or when pool unavailable
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

/// Get total cache size on disk (in bytes). Scans all files in the
/// stream-cache directory including remux/ subdirectory.
#[tauri::command]
pub async fn cmd_get_cache_total_size(
    cache_state: State<'_, StreamCacheManager>,
) -> Result<u64, String> {
    let cache_dir = cache_state.cache_dir().clone();
    let mut total: u64 = 0;

    fn scan_dir(dir: &std::path::Path, total: &mut u64) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan_dir(&path, total);
                } else if let Ok(meta) = std::fs::metadata(&path) {
                    *total += meta.len();
                }
            }
        }
    }

    scan_dir(&cache_dir, &mut total);
    Ok(total)
}

/// Report the current playback position so the backend can proactively
/// download ahead to disk cache. This ensures that when the MSE player
/// resumes (lazyLoad or after eviction), data is already on disk and can
/// be served instantly via CACHE-PREFIX without Telegram network latency.
///
/// The frontend calls this every 10s during playback. The backend:
///   1. Approximates the current byte position from playback time
///   2. Checks what's already cached on disk
///   3. Spawns a proactive download task for gaps ahead of the playhead
///   4. Skips if a download is already running for this message
#[tauri::command]
pub async fn cmd_report_playback_position(
    message_id: i32,
    folder_id: i64,
    current_time_s: f64,
    duration_s: f64,
    file_size: u64,
    state: State<'_, TelegramState>,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    if duration_s <= 0.0 || file_size == 0 {
        return Ok(false);
    }

    // Approximate current byte position (CBR assumption for TS files)
    let ratio = (current_time_s / duration_s).clamp(0.0, 1.0);
    let current_byte = (ratio * file_size as f64) as u64;

    // Don't start if a proactive prebuffer is already running for this message.
    // NOTE: We do NOT check has_active_task() here because the /stream endpoint's
    // download is tracked there too — it would always return true during playback,
    // preventing the proactive prebuffer from ever starting.
    let proactive_key = format!("proactive-{}", message_id);
    if state.cancelled_transfers.read().await.contains(&proactive_key) {
        // Was cancelled — clear the flag so we can try again
        state.cancelled_transfers.write().await.remove(&proactive_key);
    }
    // Use a separate tracker just for proactive tasks
    if cache_state.has_proactive_task(message_id).await {
        return Ok(false);
    }

    // Don't start if already fully cached
    if let Some(meta) = cache_state.load_meta(message_id) {
        if meta.is_complete() {
            return Ok(false);
        }
    }

    // Check if there are uncached gaps ahead of current position
    let cached_ranges = cache_state.load_meta(message_id)
        .map(|m| m.cached_ranges.clone())
        .unwrap_or_default();

    // Only care about gaps from current_byte onward
    let ahead_gaps: Vec<(u64, u64)> = find_gaps(&cached_ranges, file_size)
        .into_iter()
        .filter(|(start, end)| *end >= current_byte)
        .map(|(start, end)| (start.max(current_byte), end))
        .collect();

    if ahead_gaps.is_empty() {
        return Ok(false); // Nothing to download ahead
    }

    let total_ahead_bytes: u64 = ahead_gaps.iter()
        .map(|(s, e)| e - s + 1)
        .sum();

    // Only start if there's meaningful work (>2MB ahead)
    if total_ahead_bytes < 2 * 1024 * 1024 {
        return Ok(false);
    }

    log::info!(
        "[PROACTIVE] msg {}: playhead={}s (byte {}), {} uncached bytes ahead ({} gaps) — spawning proactive download",
        message_id, current_time_s as i64, current_byte, total_ahead_bytes, ahead_gaps.len()
    );

    let client = { state.client.lock().await.clone() }
        .ok_or("Not connected")?;

    let cache_mgr = cache_state.inner().clone();
    let tg_state = Arc::new(state.inner().clone());

    cache_mgr.track_proactive(message_id).await;

    tokio::spawn(async move {
        let result = proactive_prebuffer_download(
            message_id, folder_id, current_byte, client, tg_state, cache_mgr.clone(),
        ).await;

        cache_mgr.untrack_proactive(message_id).await;

        match result {
            Ok(downloaded) => {
                if downloaded > 0 {
                    log::info!("[PROACTIVE] msg {}: downloaded {} bytes to disk cache", message_id, downloaded);
                }
            }
            Err(e) => log::warn!("[PROACTIVE] msg {}: download failed: {}", message_id, e),
        }
    });

    Ok(true)
}

/// Stop any proactive prebuffer download for a message (called when
/// playback stops or switches to a different file).
#[tauri::command]
pub async fn cmd_stop_proactive_prebuffer(
    message_id: i32,
    state: State<'_, TelegramState>,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    let transfer_id = format!("proactive-{}", message_id);
    state.cancelled_transfers.write().await.insert(transfer_id);
    cache_state.untrack_proactive(message_id).await;
    log::info!("[PROACTIVE] msg {}: stopped", message_id);
    Ok(true)
}

/// Proactive prebuffer download task — downloads from `start_byte` to
/// `file_end` to disk cache, filling gaps ahead of the playhead.
/// Modelled after `background_cache_download` but starts from a specific
/// byte position (not the beginning of the file).
async fn proactive_prebuffer_download(
    message_id: i32,
    folder_id: i64,
    start_byte: u64,
    client: grammers_client::Client,
    state: Arc<TelegramState>,
    cache_mgr: StreamCacheManager,
) -> Result<u64, String> {
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

    // Extract total size
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

    // Find gaps from start_byte to file end
    let all_gaps = find_gaps(&cached_ranges, total_size);
    let ahead_gaps: Vec<(u64, u64)> = all_gaps
        .into_iter()
        .filter(|(gap_start, gap_end)| *gap_end >= start_byte)
        .map(|(gap_start, gap_end)| (gap_start.max(start_byte), gap_end))
        .collect();

    if ahead_gaps.is_empty() {
        return Ok(0); // Already cached ahead
    }

    let filename = match &media {
        Media::Document(d) => d.name().to_string(),
        _ => format!("{}.ts", message_id),
    };
    let mime_type = crate::server::mime_type_from_media(&media);

    let mut cache_file = cache_mgr.open_data_file_write(message_id)
        .map_err(|e| format!("Failed to open cache file: {}", e))?;

    let chunk_size: i32 = 512 * 1024;
    let transfer_id = format!("proactive-{}", message_id);
    let mut total_downloaded: u64 = 0;

    // Get DownloadPool for parallel gap-filling
    let pool_clone = { state.download_pool.lock().await.clone() };

    for (gap_start, gap_end) in ahead_gaps {
        let gap_size = gap_end - gap_start + 1;

        // Check cancellation
        if state.cancelled_transfers.read().await.contains(&transfer_id) {
            log::info!("[PROACTIVE] msg {}: cancelled", message_id);
            return Ok(total_downloaded);
        }

        // Use parallel download for large gaps when DownloadPool is available
        if let Some(ref pool) = pool_clone {
            if gap_size > 1024 * 1024 {
                log::info!(
                    "[PROACTIVE] msg {}: parallel download gap {}-{} ({:.1}MB)",
                    message_id, gap_start, gap_end, gap_size as f64 / (1024.0 * 1024.0)
                );

                let data = pool.download_range(&media, gap_start, gap_end, total_size).await
                    .map_err(|e| format!("Parallel gap download error: {}", e))?;

                cache_file
                    .seek(SeekFrom::Start(gap_start))
                    .map_err(|e| format!("Seek error: {}", e))?;
                cache_file
                    .write_all(&data)
                    .map_err(|e| format!("Write error: {}", e))?;

                total_downloaded += data.len() as u64;

                // Update meta
                let _lock = cache_mgr.lock_meta(message_id).await;
                let mut meta = cache_mgr.load_meta(message_id).unwrap_or_else(|| CacheMeta {
                    message_id,
                    folder_id,
                    total_size,
                    filename: filename.clone(),
                    cached_ranges: Vec::new(),
                    mime_type: mime_type.clone(),
                });
                meta.cached_ranges.push((gap_start, gap_end));
                merge_ranges(&mut meta.cached_ranges);
                let _ = cache_mgr.save_meta(&meta);

                continue;
            }
        }

        // Sequential iter_download for small gaps or when pool unavailable
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
            if state.cancelled_transfers.read().await.contains(&transfer_id) {
                log::info!("[PROACTIVE] msg {}: cancelled", message_id);
                return Ok(total_downloaded);
            }

            let chunk = chunk_result;

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
            total_downloaded += to_write as u64;

            // Update meta every 4MB (8 chunks × 512KB)
            if offset % (4 * 1024 * 1024) < chunk_size as u64 || offset > gap_end {
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
            }

            // Throttle: same as background_cache_download
            let dl_limit_kb = state.download_speed_limit_kb.load(std::sync::atomic::Ordering::Relaxed);
            if dl_limit_kb > 0 {
                let sleep_ms = (to_write as u64 * 1000) / (dl_limit_kb * 1024);
                let sleep_ms = sleep_ms.min(2000);
                tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
            }

            if offset > gap_end {
                break;
            }
        }
    }

    Ok(total_downloaded)
}
