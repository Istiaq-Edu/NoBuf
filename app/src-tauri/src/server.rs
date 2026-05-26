use actix_web::{get, head, web, App, HttpServer, HttpRequest, HttpResponse, Responder};
use actix_cors::Cors;
use crate::commands::TelegramState;
use crate::commands::utils::resolve_peer;
use crate::download_pool::StreamChunk;
use crate::hls;
use grammers_client::types::Media;
use grammers_client::Client;
use grammers_tl_types as tl;
use tokio::sync::Semaphore;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use crate::stream_cache::{StreamCacheManager, CacheMeta, merge_ranges, is_range_cached};
use std::io::{Write, Seek, SeekFrom};

/// Drop-guard that untracks streaming when the Actix response ends
/// (including client disconnect). Prevents cmd_delete_cache from
/// deleting files while the stream is still active.
struct StreamingGuard {
    cache_mgr: Option<StreamCacheManager>,
    message_id: i32,
}

impl Drop for StreamingGuard {
    fn drop(&mut self) {
        if let Some(ref cm) = self.cache_mgr {
            cm.untrack_streaming(self.message_id);
        }
    }
}

/// Drop-guard that unregisters a download from the coordinator when
/// the Actix response ends (including client disconnect). This ensures
/// the download is always deregistered even if the client disconnects
/// mid-stream, preventing stale entries in active_downloads.
/// Bug #13 fix: stores start_byte and end_byte so unregister_download
/// can remove the specific download from the Vec, not the entire entry.
struct DownloadGuard {
    cache_mgr: Option<StreamCacheManager>,
    message_id: i32,
    start_byte: u64,
    end_byte: u64,
}

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        if let Some(ref cm) = self.cache_mgr {
            // Spawn an async task to unregister — Drop::drop can't be async,
            // but unregister_download is async (uses Mutex).
            let cm_clone = cm.clone();
            let msg_id = self.message_id;
            let start = self.start_byte;
            let end = self.end_byte;
            tokio::spawn(async move {
                cm_clone.unregister_download(msg_id, start, end).await;
            });
        }
    }
}

/// Drop-guard that spawns a background continuation task when the Actix response
/// ends due to client disconnect. This keeps the Telegram download going so
/// subsequent overlapping range requests find cached data instead of starting
/// new downloads (fixes native video player backend overload).
///
/// Key design: continuation tasks are NOT registered with the coordinator.
/// They write to cache silently — new requests find their data via the
/// fast-path cache check, not via coordinator subscription. This prevents
/// the "subscribing to slow background task" problem where new requests
/// wait for continuations that are throttled and slow.
struct ContinuationGuard {
    cache_mgr: Option<StreamCacheManager>,
    message_id: i32,
    start_byte: u64,
    end_byte: u64,
    bytes_sent: Arc<AtomicU64>,
    /// Data needed to create a new iter_download for the continuation
    client: Option<Client>,
    media: Media,
    cache_folder_id: i64,
    cache_filename: String,
    mime_stream: String,
    download_semaphore: Arc<Semaphore>,
    speed_limit_kb: u64,
}

impl Drop for ContinuationGuard {
    fn drop(&mut self) {
        if let Some(ref cm) = self.cache_mgr {
            let sent = self.bytes_sent.load(Ordering::Relaxed);
            let remaining = (self.end_byte - self.start_byte + 1) - sent;
            // Only continue if there's meaningful data left (>2MB) and
            // the download wasn't complete. Small remaining data (<2MB)
            // doesn't warrant a background task — it will be requested
            // again quickly if needed, and spawning a task for <2MB
            // creates coordinator noise without meaningful benefit.
            if remaining < 2 * 1024 * 1024 || sent == 0 {
                return;
            }

            let current_offset = self.start_byte + sent;
            let end_byte = self.end_byte;
            let msg_id = self.message_id;
            let cache_mgr_clone = cm.clone();
            let client_opt = self.client.take();
            let media_clone = self.media.clone();
            let folder_id = self.cache_folder_id;
            let filename = self.cache_filename.clone();
            let mime = self.mime_stream.clone();
            let semaphore = self.download_semaphore.clone();
            let limit_kb = self.speed_limit_kb;
            let total_size = self.end_byte + 1;

            log::info!(
                "[CONTINUATION] Evaluating background download for msg {} range {}-{} (sent {}, remaining {})",
                msg_id, current_offset, end_byte, sent, remaining
            );

            tokio::spawn(async move {
                // CRITICAL: Check if there's a covering download already active.
                // If another SEQUENTIAL download covers our remaining range, it
                // will cache the data anyway — no need for a wasteful duplicate.
                if cache_mgr_clone.find_best_covering_download(msg_id, current_offset, end_byte).await.is_some() {
                    log::info!(
                        "[CONTINUATION] Skipping for msg {} — covering download exists, it will cache the data",
                        msg_id
                    );
                    return;
                }

                let client = match client_opt {
                    Some(c) => c,
                    None => {
                        log::warn!("[CONTINUATION] No client available for msg {}", msg_id);
                        return;
                    }
                };

                // Continuation is NOT registered with the coordinator.
                // It writes to cache silently — new requests find data via
                // fast-path cache check, not coordinator subscription.
                // This prevents "subscribing to slow background task" problem.

                let chunks_to_skip = (current_offset / TELEGRAM_CHUNK_SIZE as u64) as i32;
                let bytes_to_discard = current_offset % TELEGRAM_CHUNK_SIZE as u64;

                let download_iter = client.iter_download(&media_clone)
                    .chunk_size(TELEGRAM_CHUNK_SIZE)
                    .skip_chunks(chunks_to_skip);

                // Open cache file for writing
                let mut cache_file = match cache_mgr_clone.open_data_file_write(msg_id) {
                    Ok(f) => f,
                    Err(e) => {
                        log::error!("[CONTINUATION] Failed to open cache file for msg {}: {}", msg_id, e);
                        return;
                    }
                };

                let mut offset = current_offset;
                let mut first_chunk = true;
                let mut bytes_total: u64 = 0;
                let timeout = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
                let mut iter = download_iter;

                loop {
                    // Check timeout — stop after 120 seconds regardless
                    if tokio::time::Instant::now() >= timeout {
                        log::info!("[CONTINUATION] Timeout reached for msg {}, stopping at offset {}", msg_id, offset);
                        break;
                    }

                    // Re-check covering download periodically — if a player-facing
                    // SEQUENTIAL download started and covers our range, stop the
                    // continuation (the player download will cache data faster).
                    if bytes_total > 0 && bytes_total % (4 * 1024 * 1024) == 0 {
                        if cache_mgr_clone.find_best_covering_download(msg_id, offset, end_byte).await.is_some() {
                            log::info!(
                                "[CONTINUATION] Stopping for msg {} — covering download appeared at offset {}",
                                msg_id, offset
                            );
                            break;
                        }
                    }

                    // Acquire semaphore before hitting Telegram API
                    let _permit = semaphore.acquire().await.unwrap();
                    match iter.next().await.transpose() {
                        Some(Ok(bytes)) => {
                            let mut chunk_data = bytes;
                            if first_chunk && bytes_to_discard > 0 {
                                let discard = bytes_to_discard.min(chunk_data.len() as u64) as usize;
                                chunk_data = chunk_data[discard..].to_vec();
                                first_chunk = false;
                            }

                            let remaining_bytes = end_byte - offset + 1;
                            let final_data = if chunk_data.len() as u64 > remaining_bytes {
                                chunk_data[..remaining_bytes as usize].to_vec()
                            } else {
                                chunk_data
                            };

                            let bytes_in_chunk = final_data.len() as u64;
                            let chunk_range_end = offset + bytes_in_chunk - 1;

                            // Cache-skip optimization: check if this range is already
                            // cached (from a previous download or another continuation).
                            // If cached, skip writing to avoid duplicate meta entries.
                            let _lock = cache_mgr_clone.lock_meta(msg_id).await;
                            let meta = cache_mgr_clone.load_meta(msg_id);
                            let already_cached = meta.as_ref()
                                .map(|m| is_range_cached(&m.cached_ranges, offset, chunk_range_end))
                                .unwrap_or(false);
                            drop(_lock);

                            if !already_cached {
                                // Write to cache file
                                let _ = cache_file.seek(SeekFrom::Start(offset));
                                let _ = cache_file.write_all(&final_data);

                                // Update meta
                                let _lock = cache_mgr_clone.lock_meta(msg_id).await;
                                let mut meta = match cache_mgr_clone.load_meta(msg_id) {
                                    Some(m) => m,
                                    None => {
                                        log::warn!("[CONTINUATION] Meta missing for msg {}, creating recovery", msg_id);
                                        CacheMeta {
                                            message_id: msg_id,
                                            folder_id,
                                            total_size,
                                            filename: filename.clone(),
                                            cached_ranges: Vec::new(),
                                            mime_type: mime.clone(),
                                        }
                                    }
                                };
                                meta.cached_ranges.push((offset, chunk_range_end));
                                merge_ranges(&mut meta.cached_ranges);
                                if let Err(e) = cache_mgr_clone.save_meta(&meta) {
                                    log::warn!("[CONTINUATION] Failed to save meta for msg {}: {}", msg_id, e);
                                }
                                drop(_lock);
                            } else {
                                log::debug!("[CONTINUATION] Skipping cached range {}-{} for msg {}", offset, chunk_range_end, msg_id);
                            }

                            offset += bytes_in_chunk;
                            bytes_total += bytes_in_chunk;

                            // Throttle
                            if limit_kb > 0 {
                                let sleep_ms = (bytes_in_chunk * 1000) / (limit_kb * 1024);
                                let sleep_ms = sleep_ms.min(2000);
                                tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                            }

                            if chunk_range_end >= end_byte {
                                log::info!("[CONTINUATION] Completed background download for msg {} up to offset {}", msg_id, offset);
                                break;
                            }
                        }
                        None => {
                            log::info!("[CONTINUATION] Download iterator exhausted for msg {}", msg_id);
                            break;
                        }
                        Some(Err(e)) => {
                            log::error!("[CONTINUATION] Download error for msg {}: {}", msg_id, e);
                            break;
                        }
                    }
                }
                log::info!("[CONTINUATION] Background task ended for msg {}, downloaded {} bytes, final offset {}", msg_id, bytes_total, offset);
            });
        }
    }
}

/// Holds the per-session streaming token for Actix validation
pub(crate) struct StreamTokenData {
    pub(crate) token: String,
}

#[derive(serde::Deserialize)]
pub(crate) struct StreamQuery {
    pub(crate) token: Option<String>,
}

/// Telegram download chunk size. Gammers-client enforces a hard cap of
/// 512 KB (MAX_CHUNK_SIZE in files.rs) and requires divisibility by 4 KB
/// (MIN_CHUNK_SIZE). We use the maximum allowed value to minimize round-trips.
const TELEGRAM_CHUNK_SIZE: i32 = 512 * 1024;
const MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE: usize = 3;

/// Parse a Range header value (e.g., "bytes=0-1023") into (start, end) where end is inclusive.
/// Returns None if the header is missing or malformed.
pub(crate) fn parse_range_header(range: &str, total_size: u64) -> Option<(u64, u64)> {
    let range = range.trim().strip_prefix("bytes=")?;
    let parts: Vec<&str> = range.split('-').collect();
    if parts.len() != 2 {
        return None;
    }

    let start = if parts[0].is_empty() {
        // Suffix range: "-500" means last 500 bytes
        let suffix: u64 = parts[1].parse().ok()?;
        total_size.saturating_sub(suffix)
    } else {
        parts[0].parse::<u64>().ok()?
    };

    let end = if parts[1].is_empty() {
        total_size - 1
    } else {
        parts[1].parse::<u64>().ok()?.min(total_size - 1)
    };

    if start > end || start >= total_size {
        return None;
    }

    Some((start, end))
}

/// Resolve the message ID to the actual Media object, handling folder routing.
pub(crate) async fn resolve_media_from_path(
    folder_id_str: &str,
    message_id: i32,
    data: &web::Data<Arc<TelegramState>>,
    token_data: &web::Data<StreamTokenData>,
    query: &StreamQuery,
) -> Result<(Media, u64), HttpResponse> {
    // Validate session token
    match &query.token {
        Some(t) if t == &token_data.token => {},
        _ => {
            log::error!("Stream request failed: Invalid or missing stream token for msg {}", message_id);
            return Err(HttpResponse::Forbidden().body("Invalid or missing stream token"));
        }
    }

    let folder_id = if folder_id_str == "me" || folder_id_str == "home" || folder_id_str == "null" {
        None
    } else {
        match folder_id_str.parse::<i64>() {
            Ok(id) => Some(id),
            Err(_) => return Err(HttpResponse::BadRequest().body("Invalid folder ID")),
        }
    };

    let client_guard = { data.client.lock().await.clone() };
    let client = match client_guard {
        Some(c) => c,
        None => return Err(HttpResponse::ServiceUnavailable().body("Telegram client not connected")),
    };

    let peer = match resolve_peer(&client, folder_id, &data.peer_cache).await {
        Ok(p) => p,
        Err(e) => {
            log::error!("Stream request failed: Could not resolve peer for folder {:?}: {}", folder_id, e);
            return Err(HttpResponse::BadRequest().body(format!("Could not resolve folder: {}", e)));
        }
    };

    let messages = match client.get_messages_by_id(&peer, &[message_id]).await {
        Ok(m) => m,
        Err(e) => {
            log::error!("Stream request failed: Could not fetch message {}: {}", message_id, e);
            return Err(HttpResponse::InternalServerError().body(format!("Could not fetch message: {}", e)));
        }
    };

    let msg = match messages.into_iter().next().flatten() {
        Some(m) => m,
        None => {
            log::error!("Stream request failed: Message {} not found", message_id);
            return Err(HttpResponse::NotFound().body("Message not found"));
        }
    };

    let media = match msg.media() {
        Some(m) => m,
        None => {
            log::error!("Stream request failed: Message {} has no media", message_id);
            return Err(HttpResponse::NotFound().body("Message does not contain media"));
        }
    };

    // Get file size from raw TL message (grammers-client high-level wrapper returns 0)
    let size = match &msg.raw {
        tl::enums::Message::Message(m) => {
            match &m.media {
                Some(tl::enums::MessageMedia::Document(md)) => {
                    md.document.as_ref().and_then(|d| match d {
                        tl::enums::Document::Document(doc) => Some(doc.size as u64),
                        _ => None,
                    }).unwrap_or(0)
                }
                Some(tl::enums::MessageMedia::Photo(_)) => 0,
                _ => 0,
            }
        }
        _ => 0,
    };

    Ok((media, size))
}

pub fn mime_type_from_media(media: &Media) -> String {
    match media {
        Media::Document(d) => {
            d.mime_type().unwrap_or("application/octet-stream").to_string()
        }
        Media::Photo(_) => "image/jpeg".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

/// HEAD endpoint for content-length discovery (no body download)
#[head("/stream/{folder_id}/{message_id}")]
async fn stream_media_head(
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    match resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &query).await {
        Ok((media, size)) => {
            let mime = mime_type_from_media(&media);
            HttpResponse::Ok()
                .insert_header(("Content-Type", mime))
                .insert_header(("Content-Length", size.to_string()))
                .insert_header(("Accept-Ranges", "bytes"))
                .finish()
        }
        Err(resp) => {
            resp
        },
    }
}

#[get("/stream/{folder_id}/{message_id}")]
async fn stream_media(
    req: HttpRequest,
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();
    let (media, size) = match resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &query).await {
        Ok(result) => result,
        Err(resp) => return resp,
    };

    let mime = mime_type_from_media(&media);
    let mime_stream = mime.clone(); // Clone for use inside the async stream

    // Extract cache-related variables BEFORE the stream to avoid
    // partial-borrow issues inside async_stream::stream! and to
    // use the per-message lock for serialized meta updates.
    let cache_file_opt: Option<std::fs::File> =
        if let Some(ref cache_mgr) = **cache {
            match cache_mgr.open_data_file_write(message_id) {
                Ok(f) => Some(f),
                Err(e) => {
                    log::warn!("[PREBUFFER] Failed to open cache file for {}: {}", message_id, e);
                    None
                }
            }
        } else {
            None
        };

    let cache_mgr_opt: Option<StreamCacheManager> =
        (**cache).as_ref().map(|cm| cm.clone());

    

    let cache_folder_id = folder_id_str.parse::<i64>().unwrap_or(0);
    let cache_filename = match &media {
        Media::Document(d) => d.name().to_string(),
        _ => format!("{}.mp4", message_id),
    };

    // Parse Range header if present
    let range_header = req.headers().get("Range").and_then(|v| v.to_str().ok());

    let (start_byte, end_byte, is_partial) = if let Some(range_str) = range_header {
        match parse_range_header(range_str, size) {
            Some((start, end)) => {
                (start, end, true)
            }
            None => {
                log::warn!("[PREBUFFER] Invalid Range header '{}' for msg {}", range_str, message_id);
                return HttpResponse::build(actix_web::http::StatusCode::RANGE_NOT_SATISFIABLE)
                    .insert_header(("Content-Range", format!("bytes */{}", size)))
                    .body("Invalid Range header");
            }
        }
    } else {
        (0, size.saturating_sub(1), false)
    };

    let content_length = end_byte - start_byte + 1;

    // FAST PATH: if the requested range is fully cached, serve from disk immediately
    // Acquire lock_meta before load_meta to prevent concurrent save_meta from
    // truncating the file mid-read (which caused meta corruption in test round 4).
    if let Some(ref cache_mgr) = **cache {
        let _fast_lock = cache_mgr.lock_meta(message_id).await;
        let fast_meta = cache_mgr.load_meta(message_id);
        drop(_fast_lock); // Release immediately — meta data is in memory now

        if let Some(meta) = fast_meta {
            if is_range_cached(&meta.cached_ranges, start_byte, end_byte) {
                let cache_path = cache_mgr.data_path(message_id);
                match (|| -> std::io::Result<Vec<u8>> {
                    let mut file = std::fs::File::open(&cache_path)?;
                    use std::io::Read;
                    file.seek(SeekFrom::Start(start_byte))?;
                    let mut buf = vec![0u8; (end_byte - start_byte + 1) as usize];
                    file.read_exact(&mut buf)?;
                    Ok(buf)
                })() {
                    Ok(slice) => {
                        log::info!("[PREBUFFER] HIT: msg {} range {}-{} served from disk cache",
                            message_id, start_byte, end_byte);

                        let response = if is_partial {
                            HttpResponse::PartialContent()
                                .insert_header(("Content-Type", mime))
                                .insert_header(("Content-Length", slice.len().to_string()))
                                .insert_header(("Content-Range", format!("bytes {}-{}/{}", start_byte, end_byte, size)))
                                .insert_header(("Accept-Ranges", "bytes"))
                                .insert_header(("X-Cache", "HIT"))
                                .body(slice)
                        } else {
                            HttpResponse::Ok()
                                .insert_header(("Content-Type", mime))
                                .insert_header(("Content-Length", slice.len().to_string()))
                                .insert_header(("Accept-Ranges", "bytes"))
                                .insert_header(("X-Cache", "HIT"))
                                .body(slice)
                        };
                        return response;
                    }
                    Err(e) => {
                        log::warn!("[PREBUFFER] Cache read failed for msg {}, falling back to Telegram: {}", message_id, e);
                    }
                }
            } else {
                log::info!("[PREBUFFER] MISS: msg {} range {}-{} not cached",
                    message_id, start_byte, end_byte);
            }
        } else {
            log::info!("[PREBUFFER] MISS: msg {} no meta found", message_id);
        }
    }

    // === COORDINATOR: Check if an active SEQUENTIAL download already covers our range ===
    // Bug #6 fix: overlapping range requests subscribe to existing downloads instead of
    // spawning duplicates.
    //
    // Strategy: Subscribe if the active download's progress is CLOSE to our
    // needed offset. If far away (>2MB distance), we have two options:
    // 1. If max concurrent downloads NOT reached → start a new targeted SEQUENTIAL download
    // 2. If max concurrent downloads reached → return HTTP 503 Retry-After, forcing the
    //    browser to retry later (by then the data should be cached or closer to our offset).
    //    This eliminates the "proceed unregistered" cascade that wastes bandwidth.
    if let Some(ref cache_mgr) = **cache {
        let dl_info = cache_mgr.find_best_covering_download(message_id, start_byte, end_byte).await;
        if let Some(dl) = dl_info {
            let current_progress = *dl.progress_rx.borrow();
            let distance = start_byte.saturating_sub(current_progress.max(dl.start_byte));
            const MAX_SUBSCRIBE_DISTANCE: u64 = 10 * 1024 * 1024; // 10MB — subscribe if download will reach our offset within ~5 seconds at 2MB/s

            if distance <= MAX_SUBSCRIBE_DISTANCE {
                log::info!("[PREBUFFER] COORDINATOR: msg {} range {}-{} subscribing to active download {}-{} (progress={}, distance={})",
                    message_id, start_byte, end_byte, dl.start_byte, dl.end_byte, current_progress, distance);

                let cache_mgr_clone = cache_mgr.clone();
                let data_path = cache_mgr.data_path(message_id);
                let subscriber_content_length = content_length;
                let subscriber_start = start_byte;
                let subscriber_end = end_byte;
                let subscriber_mime = mime.clone();
                let subscriber_size = size;
                let subscriber_msg = message_id;
                let limit_kb = data.prebuffer_speed_limit_kb.load(std::sync::atomic::Ordering::Relaxed);

                let subscriber_stream = async_stream::stream! {
                // Track streaming activity so cmd_delete_cache refuses to delete
                // files while this stream is active (Bug #11 fix — same pattern as
                // Bug #10: guard must live inside stream block to persist for the
                // entire streaming lifetime, not just the function scope).
                let _subscriber_stream_guard = {
                    cache_mgr_clone.track_streaming(subscriber_msg);
                    StreamingGuard {
                        cache_mgr: Some(cache_mgr_clone.clone()),
                        message_id: subscriber_msg,
                    }
                };

                let mut progress_rx = dl.progress_rx;
                let mut read_offset = subscriber_start;
                let mut bytes_remaining = subscriber_content_length;

                // Open cache data file for reading (share modes allow concurrent read+write)
                let mut read_file = match std::fs::File::open(&data_path) {
                    Ok(f) => f,
                    Err(e) => {
                        log::error!("[PREBUFFER] COORDINATOR: Failed to open cache file for reading msg {}: {}", subscriber_msg, e);
                        return;
                    }
                };

                loop {
                    // Check current progress — how much data has the active download cached?
                    let current_progress = *progress_rx.borrow();

                    if current_progress >= read_offset {
                        // Data is available at our read_offset — read from cache
                    } else {
                        // Wait for the active download to advance past our read_offset
                        match progress_rx.changed().await {
                            Ok(()) => {
                                let new_progress = *progress_rx.borrow();
                                if new_progress < read_offset {
                                    // Progress advanced but hasn't reached our offset yet
                                    continue;
                                }
                                // Data is now available
                            }
                            Err(_) => {
                                // Download ended (progress_tx dropped by unregister_download)
                                // Bug #12 + #14 fix: Instead of just logging and breaking,
                                // deliver ALL available cached data from disk. Even if the
                                // full range isn't cached, deliver whatever we have — this
                                // prevents ERR_CONTENT_LENGTH_MISMATCH (since we use
                                // chunked transfer encoding without Content-Length, the
                                // browser won't reject partial delivery).
                                let _lock = cache_mgr_clone.lock_meta(subscriber_msg).await;
                                let meta = cache_mgr_clone.load_meta(subscriber_msg);
                                drop(_lock);

                                if let Some(meta) = meta {
                                    // Find the furthest contiguous cached byte from read_offset
                                    let max_cached_end = meta.cached_ranges.iter()
                                        .filter(|&(s, _)| *s <= read_offset)
                                        .map(|&(_, e)| e)
                                        .max()
                                        .unwrap_or(0);

                                    if max_cached_end >= read_offset {
                                        // There's cached data starting at or before read_offset
                                        let available_end = max_cached_end.min(subscriber_end);
                                        let read_len = (available_end - read_offset + 1) as usize;
                                        use std::io::Read;
                                        read_file.seek(SeekFrom::Start(read_offset)).ok();
                                        let mut buf = vec![0u8; read_len];
                                        match read_file.read_exact(&mut buf) {
                                            Ok(()) => {
                                                bytes_remaining -= read_len as u64;
                                                read_offset += read_len as u64;
                                                yield Ok::<_, actix_web::Error>(web::Bytes::from(buf));
                                            }
                                            Err(e) => {
                                                log::error!("[PREBUFFER] COORDINATOR: Final cache read failed for msg {}: {}", subscriber_msg, e);
                                            }
                                        }
                                    }

                                    if bytes_remaining > 0 {
                                        log::warn!("[PREBUFFER] COORDINATOR: Active download ended before covering full range for msg {} (need {}-{}, progress reached {}, delivered up to {})",
                                            subscriber_msg, read_offset, subscriber_end, current_progress, read_offset - 1);
                                    }
                                } else {
                                    log::warn!("[PREBUFFER] COORDINATOR: Active download ended before covering full range for msg {} (need {}-{}, progress reached {})",
                                        subscriber_msg, read_offset, subscriber_end, current_progress);
                                }
                                break;
                            }
                        }
                    }

                    // Calculate how many bytes we can read right now
                    let progress = *progress_rx.borrow();
                    let available_end = progress.min(subscriber_end);
                    let readable = (available_end - read_offset + 1) as usize;
                    let chunk_size = readable
                        .min(TELEGRAM_CHUNK_SIZE as usize)
                        .min(bytes_remaining as usize);

                    if chunk_size == 0 {
                        // No more data to read at this offset
                        if bytes_remaining == 0 {
                            break; // All data served
                        }
                        // Need more data but progress hasn't advanced — wait
                        continue;
                    }

                    // Read chunk from cache file
                    use std::io::Read;
                    read_file.seek(SeekFrom::Start(read_offset)).ok();
                    let mut buf = vec![0u8; chunk_size];
                    match read_file.read_exact(&mut buf) {
                        Ok(()) => {
                            bytes_remaining -= chunk_size as u64;
                            read_offset += chunk_size as u64;
                            yield Ok::<_, actix_web::Error>(web::Bytes::from(buf));
                        }
                        Err(e) => {
                            log::error!("[PREBUFFER] COORDINATOR: Cache read failed for msg {} at offset {}: {}",
                                subscriber_msg, read_offset, e);
                            break;
                        }
                    }

                    // Throttle (same logic as SEQUENTIAL download)
                    if limit_kb > 0 {
                        let sleep_ms = (chunk_size as u64 * 1000) / (limit_kb * 1024);
                        let sleep_ms = sleep_ms.min(2000);
                        tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                    }

                    if bytes_remaining == 0 {
                        break;
                    }
                }

                log::info!("[PREBUFFER] COORDINATOR: Subscriber for msg {} range {}-{} completed (bytes_remaining={})",
                    subscriber_msg, subscriber_start, subscriber_end, bytes_remaining);
            };

            if is_partial {
                // Bug #14 fix: Use chunked transfer encoding (no Content-Length)
                // for subscriber responses. This eliminates ERR_CONTENT_LENGTH_MISMATCH
                // because the browser doesn't expect a specific byte count. The
                // subscriber stream may deliver fewer bytes than originally requested
                // if the active download ends before covering the full range.
                // Content-Range is still included so the MSE player knows what
                // byte offsets the data corresponds to.
                return HttpResponse::PartialContent()
                    .insert_header(("Content-Type", subscriber_mime))
                    .insert_header(("Content-Range", format!("bytes {}-{}/{}", subscriber_start, subscriber_end, subscriber_size)))
                    .insert_header(("Accept-Ranges", "bytes"))
                    .insert_header(("Connection", "keep-alive"))
                    .insert_header(("X-Download-Mode", "subscriber"))
                    .streaming(subscriber_stream);
            } else {
                return HttpResponse::Ok()
                    .insert_header(("Content-Type", subscriber_mime))
                    .insert_header(("Accept-Ranges", "bytes"))
                    .insert_header(("X-Download-Mode", "subscriber"))
                    .streaming(subscriber_stream);
            }
            } else {
                // Progress too far from needed offset — skip subscription.
                // Check if we can start a new targeted download. If max concurrent
                // is already reached, return 503 Retry-After instead of "proceeding
                // unregistered" — this prevents the download cascade where unregistered
                // downloads waste bandwidth without coordinator visibility.
                let active_count = cache_mgr.active_download_count(message_id).await;
                if active_count >= MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE {
                    let retry_seconds = (distance / (500 * 1024)).max(2).min(30); // Estimate: 500KB/s download speed
                    log::info!("[PREBUFFER] COORDINATOR: msg {} range {}-{} skipping subscription (distance={} > 10MB), max concurrent ({}) reached, returning 503 Retry-After:{}s",
                        message_id, start_byte, end_byte, distance, active_count, retry_seconds);
                    return HttpResponse::ServiceUnavailable()
                        .insert_header(("Retry-After", retry_seconds.to_string()))
                        .insert_header(("X-Reason", "download-busy"))
                        .body("Max concurrent downloads reached for this file — retry after data is cached");
                }
                log::info!("[PREBUFFER] COORDINATOR: msg {} range {}-{} skipping subscription to {}-{} (progress={}, distance={} > 10MB), starting targeted SEQUENTIAL download",
                    message_id, start_byte, end_byte, dl.start_byte, dl.end_byte, current_progress, distance);
                // Fall through to SEQUENTIAL download section below
            }
        }
    }

    // No covering download found AND max concurrent downloads reached —
    // return HTTP 503 Retry-After. This eliminates the "proceed unregistered"
    // cascade where downloads waste bandwidth without coordinator visibility.
    // The browser will retry the request after the specified delay, and by then
    // the data should be cached (the active downloads will have progressed).
    if let Some(ref cache_mgr) = **cache {
        let active_count = cache_mgr.active_download_count(message_id).await;
        if active_count >= MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE {
            // Estimate retry time based on download progress distance.
            // If a covering/nearest download exists, calculate how long until it reaches our offset.
            // Conservative estimate: 500KB/s Telegram download speed.
            let retry_seconds = if let Some(nearest) = cache_mgr.find_nearest_download(message_id, start_byte).await {
                let progress = *nearest.progress_rx.borrow();
                let distance = start_byte.saturating_sub(progress);
                (distance / (500 * 1024)).max(2).min(30)
            } else {
                5 // No download found — give it 5 seconds for one to start
            };

            log::info!("[PREBUFFER] COORDINATOR_LIMIT: msg {} range {}-{} max concurrent ({}) reached, returning 503 Retry-After:{}s",
                message_id, start_byte, end_byte, active_count, retry_seconds);
            return HttpResponse::ServiceUnavailable()
                .insert_header(("Retry-After", retry_seconds.to_string()))
                .insert_header(("X-Reason", "download-busy"))
                .body("Max concurrent downloads reached — retry after data is cached");
        }
    }

    // No active download covers our range — proceed with new SEQUENTIAL download
                // No active download covers our range — proceed with new SEQUENTIAL download

    let client_guard = { data.client.lock().await.clone() };
    let client = match client_guard {
        Some(c) => c,
        None => return HttpResponse::ServiceUnavailable().body("Telegram client not connected"),
    };

    // === STREAMING PATH ===
    // NOTE: Parallel streaming via DownloadPool is disabled for the player-facing
    // HTTP response because out-of-order/corrupted chunk delivery causes
    // CHUNK_DEMUXER_ERROR in the MSE player. Sequential single-connection
    // streaming is used instead, which guarantees in-order, correct data.
    // The DownloadPool is still available for background cache gap filling
    // (streaming.rs) where data correctness can be validated independently.
    let use_parallel = false; // Disabled until parallel stream data correctness is verified
    let _pool_guard = { data.download_pool.lock().await.clone() }; // Available when parallel is re-enabled

    if use_parallel {
        let pool = _pool_guard.unwrap();
        log::info!("[PREBUFFER] PARALLEL: msg {} range {}-{} ({} bytes) using {} workers",
            message_id, start_byte, end_byte, content_length, 3);

        let mut rx = pool.stream_range(
            &media, start_byte, end_byte, size, data.download_semaphore.clone(),
        );

        let stream = async_stream::stream! {
            // Track streaming activity so cmd_delete_cache refuses to delete
            // files while this stream is active (Bug #11 fix).
            let _stream_guard = if let Some(ref cache_mgr) = cache_mgr_opt {
                cache_mgr.track_streaming(message_id);
                StreamingGuard {
                    cache_mgr: Some(cache_mgr.clone()),
                    message_id,
                }
            } else {
                StreamingGuard { cache_mgr: None, message_id }
            };

            let mut bytes_sent: u64 = 0;
            #[allow(unused_assignments)]
            let mut current_offset = start_byte; // Set from chunk offsets in parallel mode
            let mut cache_file_mut = cache_file_opt;

            while let Some(msg) = rx.recv().await {
                match msg {
                    Ok(StreamChunk { offset, data: chunk_data }) => {
                        // Use the offset from the chunk (reorder buffer guarantees
                        // in-order delivery, but offset field provides correctness)
                        current_offset = offset;
                        let remaining = content_length - bytes_sent;
                        if remaining == 0 { break; }

                        // The chunk might be larger than remaining (last chunk)
                        let final_data = if chunk_data.len() as u64 > remaining {
                            chunk_data[..remaining as usize].to_vec()
                        } else {
                            chunk_data
                        };

                        let bytes_in_chunk = final_data.len() as u64;
                        let chunk_range_end = current_offset + bytes_in_chunk - 1;

                        // 1) Write to cache file at the correct offset
                        if let Some(ref mut cache_file) = cache_file_mut {
                            let _ = cache_file.seek(SeekFrom::Start(current_offset));
                            let _ = cache_file.write_all(&final_data);
                        }

                        // 2) Update meta
                        if let Some(ref cache_mgr) = cache_mgr_opt {
                            let _lock = cache_mgr.lock_meta(message_id).await;
                            let mut meta = match cache_mgr.load_meta(message_id) {
                                Some(m) => m,
                                None => {
                                    CacheMeta {
                                        message_id,
                                        folder_id: cache_folder_id,
                                        total_size: size,
                                        filename: cache_filename.clone(),
                                        cached_ranges: Vec::new(),
                                        mime_type: mime_stream.clone(),
                                    }
                                }
                            };
                            meta.cached_ranges.push((current_offset, chunk_range_end));
                            merge_ranges(&mut meta.cached_ranges);
                            if let Err(e) = cache_mgr.save_meta(&meta) {
                                log::warn!("[PREBUFFER] Failed to save meta for msg {}: {}", message_id, e);
                            }
                        }

                        bytes_sent += bytes_in_chunk;
                        yield Ok::<_, actix_web::Error>(web::Bytes::from(final_data));

                        // Throttle
                        let limit_kb = data.prebuffer_speed_limit_kb.load(std::sync::atomic::Ordering::Relaxed);
                        if limit_kb > 0 {
                            let sleep_ms = (bytes_in_chunk * 1000) / (limit_kb * 1024);
                            let sleep_ms = sleep_ms.min(2000);
                            tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                        }

                        if bytes_sent >= content_length { break; }
                    }
                    Err(e) => {
                        log::error!("[PREBUFFER] Parallel stream error for msg {}: {}", message_id, e);
                        break;
                    }
                }
            }
        };

        if is_partial {
            HttpResponse::PartialContent()
                .insert_header(("Content-Type", mime))
                .insert_header(("Content-Length", content_length.to_string()))
                .insert_header(("Content-Range", format!("bytes {}-{}/{}", start_byte, end_byte, size)))
                .insert_header(("Accept-Ranges", "bytes"))
                .insert_header(("Connection", "keep-alive"))
                .insert_header(("X-Download-Mode", "parallel"))
                .streaming(stream)
        } else {
            HttpResponse::Ok()
                .insert_header(("Content-Type", mime))
                .insert_header(("Content-Length", size.to_string()))
                .insert_header(("Accept-Ranges", "bytes"))
                .insert_header(("X-Download-Mode", "parallel"))
                .streaming(stream)
        }
    } else {
        // === FALLBACK: Single-connection streaming via iter_download ===
        // Used for small ranges (<1MB) or when DownloadPool is not available.
        log::info!("[PREBUFFER] SEQUENTIAL: msg {} range {}-{} using single connection",
            message_id, start_byte, end_byte);

        // Clone cache_mgr for use inside the async_stream block —
        // register_download and guards must live inside the stream
        // so they're only dropped when the stream itself is dropped (Bug #10 fix).
        let cache_mgr_for_stream = (**cache).as_ref().map(|cm| cm.clone());

        let chunks_to_skip = (start_byte / TELEGRAM_CHUNK_SIZE as u64) as i32;
        let bytes_to_discard = start_byte % TELEGRAM_CHUNK_SIZE as u64;

        let download_iter = client.iter_download(&media)
            .chunk_size(TELEGRAM_CHUNK_SIZE)
            .skip_chunks(chunks_to_skip);

        // Track bytes_sent across the stream boundary so ContinuationGuard
        // can determine how far the download got and whether to continue.
        let bytes_sent_atomic = Arc::new(AtomicU64::new(0));

    let stream = async_stream::stream! {
        // Track streaming activity so cmd_delete_cache refuses to delete
        // files while this stream is active (Bug #11 fix — same pattern as
        // Bug #10: guard must live inside stream block to persist for the
        // entire streaming lifetime, not just the function scope).
        let _stream_guard = if let Some(ref cm) = cache_mgr_for_stream {
            cm.track_streaming(message_id);
            StreamingGuard {
                cache_mgr: Some(cm.clone()),
                message_id,
            }
        } else {
            StreamingGuard { cache_mgr: None, message_id }
        };

        // Register this download with the coordinator so overlapping requests
        // can subscribe instead of spawning duplicates (Bug #6 fix).
        // MUST be inside the stream block so the registration persists for
        // the entire streaming lifetime — not just the function scope.
        // Bug #15 fix: register_download now returns Option — if the
        // MAX_CONCURRENT_DOWNLOADS limit is reached (shouldn't happen since
        // we checked above), just proceed without registration.
        let _registered = if let Some(ref cm) = cache_mgr_for_stream {
            cm.register_download(message_id, start_byte, end_byte).await.is_some()
        } else {
            false
        };

        // Drop-guard that unregisters the download from the coordinator when
        // the Actix response ends. Only created if the download was actually
        // registered (Bug #15: may not be registered if limit was reached).
        // Lives inside the stream so it's dropped when the stream is dropped,
        // not when stream_media() returns (Bug #10 fix).
        // Bug #13 fix: stores start_byte and end_byte so the specific download
        // can be removed from Vec<ActiveDownload> without affecting other
        // concurrent downloads for the same message.
        let _download_guard = if _registered {
            Some(DownloadGuard {
                cache_mgr: cache_mgr_for_stream.clone(),
                message_id,
                start_byte,
                end_byte,
            })
        } else {
            None
        };

        // Drop-guard that spawns a background continuation task when the
        // Actix response ends (client disconnect). This keeps downloading
        // data to the cache so subsequent overlapping range requests find
        // cached data instead of starting new Telegram downloads.
        // Only created if we have a cache_mgr, a client, and the range is
        // large enough (>1MB) to warrant background continuation.
        let _continuation_guard = if cache_mgr_for_stream.is_some() && content_length > 1024 * 1024 {
            Some(ContinuationGuard {
                cache_mgr: cache_mgr_for_stream.clone(),
                message_id,
                start_byte,
                end_byte,
                bytes_sent: bytes_sent_atomic.clone(),
                client: Some(client.clone()),
                media: media.clone(),
                cache_folder_id,
                cache_filename: cache_filename.clone(),
                mime_stream: mime_stream.clone(),
                download_semaphore: data.download_semaphore.clone(),
                speed_limit_kb: data.prebuffer_speed_limit_kb.load(Ordering::Relaxed),
            })
        } else {
            None
        };

        let mut bytes_sent: u64 = 0;
        let mut first_chunk = true;
        let mut iter = download_iter;
        let mut current_offset = start_byte;
        let mut cache_file_mut = cache_file_opt;

        while let Some(chunk) = {
            // Acquire the global semaphore before hitting Telegram's API —
            // serializes with cmd_download_file to prevent FLOOD_WAIT
            let _permit = data.download_semaphore.acquire().await.unwrap();
            iter.next().await.transpose()
        } {
            match chunk {
                Ok(bytes) => {
                    let remaining = content_length - bytes_sent;
                    if remaining == 0 {
                        break;
                    }

                    let mut chunk_data = bytes;

                    // On first chunk, discard leading bytes to align with start_byte
                    if first_chunk && bytes_to_discard > 0 {
                        let discard = bytes_to_discard.min(chunk_data.len() as u64) as usize;
                        chunk_data = chunk_data[discard..].to_vec();
                        first_chunk = false;
                    }

                    let is_last = chunk_data.len() as u64 > remaining;
                    let final_data = if is_last {
                        chunk_data[..remaining as usize].to_vec()
                    } else {
                        chunk_data
                    };

                    let bytes_in_chunk = final_data.len() as u64;
                    let chunk_range_end = current_offset + bytes_in_chunk - 1;

                    // 1) Write data to cache file (seek+write is atomic, no lock needed)
                    if let Some(ref mut cache_file) = cache_file_mut {
                        let _ = cache_file.seek(SeekFrom::Start(current_offset));
                        let _ = cache_file.write_all(&final_data);
                    }

                    // 2) Update meta with per-message lock (serialized with
                    //    cmd_report_cached_ranges and other streaming requests)
                    if let Some(ref cache_mgr) = cache_mgr_opt {
                        let _lock = cache_mgr.lock_meta(message_id).await;
                        let mut meta = match cache_mgr.load_meta(message_id) {
                            Some(m) => m,
                            None => {
                                // Meta file temporarily unreadable (filesystem cache,
                                // antivirus scan, save_meta race). Retry 3 times
                                // with increasing delays before creating recovery meta.
                                // NEVER lose all existing ranges by creating empty
                                // cached_ranges — always try to recover from data file.
                                log::warn!("[PREBUFFER] Meta load returned None for msg {}, retrying", message_id);
                                let mut recovered = None;
                                for (attempt, delay_ms) in [(1, 20), (2, 50), (3, 100)] {
                                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                                    if let Some(m) = cache_mgr.load_meta(message_id) {
                                        log::info!("[PREBUFFER] Meta recovered for msg {} on attempt {}", message_id, attempt);
                                        recovered = Some(m);
                                        break;
                                    }
                                }
                                match recovered {
                                    Some(m) => m,
                                    None => {
                                        // All retries failed. Create recovery meta that
                                        // preserves as much info as possible. On Windows,
                                        // files can enter "pending delete" state where
                                        // the directory entry is gone but open handles
                                        // remain valid — use the open cache file handle
                                        // as a fallback for file size detection.
                                        let data_path = cache_mgr.data_path(message_id);
                                        let data_exists = data_path.exists();
                                        let fs_data_size = if data_exists {
                                            std::fs::metadata(&data_path)
                                                .map(|m| m.len()).unwrap_or(0)
                                        } else { 0 };
                                        // Fallback: open handle metadata (handles
                                        // Windows "pending delete" where directory
                                        // entry is gone but handle is still valid)
                                        let handle_data_size = cache_file_mut
                                            .as_ref()
                                            .and_then(|f| f.metadata().ok())
                                            .map(|m| m.len())
                                            .unwrap_or(0);
                                        let _data_size = fs_data_size.max(handle_data_size);
                                        log::warn!("[PREBUFFER] Meta recovery for msg {}: data_file_exists={}, fs_data_size={}, handle_data_size={}, total_size={}", 
                                            message_id, data_exists, fs_data_size, handle_data_size, size);
                                        // Bug #8 fix: DO NOT claim (0, data_size-1) is cached.
                                        // The .dat file may be sparse (only partially downloaded
                                        // from previous sessions). Over-claiming causes the
                                        // player to read zero-filled data from uncached regions,
                                        // which corrupts MSE playback.
                                        // Instead, start with empty cached_ranges and let the
                                        // normal chunk writes populate the correct ranges.
                                        let recovery_ranges = Vec::new();
                                        CacheMeta {
                                            message_id,
                                            folder_id: cache_folder_id,
                                            total_size: size,
                                            filename: cache_filename.clone(),
                                            cached_ranges: recovery_ranges,
                                            mime_type: mime_stream.clone(),
                                        }
                                    }
                                }
                            }
                        };
                        meta.cached_ranges.push((current_offset, chunk_range_end));
                        merge_ranges(&mut meta.cached_ranges);
                        if let Err(e) = cache_mgr.save_meta(&meta) {
                            log::warn!("[PREBUFFER] Failed to save meta for msg {}: {}", message_id, e);
                        }
                        // Per-chunk ADD log is too verbose for large videos — commented out
                        // log::info!("[PREBUFFER] ADD: msg {} range {}-{} written to cache, meta ranges: {:?}",
                        //     message_id, current_offset, chunk_range_end, meta.cached_ranges);
                        // Broadcast progress to subscribers (Bug #6 coordinator)
                        // Bug #13 fix: pass start_byte so update_download_progress
                        // can find the correct download in Vec<ActiveDownload>
                        // Bug #15 fix: only update progress if registered
                        if _registered {
                            cache_mgr.update_download_progress(message_id, start_byte, chunk_range_end).await;
                        }
                    }

                    current_offset += bytes_in_chunk;
                    bytes_sent += bytes_in_chunk;
                    bytes_sent_atomic.store(bytes_sent, Ordering::Relaxed);
                    yield Ok::<_, actix_web::Error>(web::Bytes::from(final_data));

                    // Throttle: sleep after chunk release to enforce prebuffer speed limit
                    // Semaphore is already released (yield point), so download task can
                    // use the connection during this sleep window.
                    let limit_kb = data.prebuffer_speed_limit_kb.load(std::sync::atomic::Ordering::Relaxed);
                    if limit_kb > 0 {
                        // 512KB chunk at limit_kb KB/s → sleep_ms = bytes * 1000 / (limit_kb * 1024)
                        let sleep_ms = (bytes_in_chunk * 1000) / (limit_kb * 1024);
                        let sleep_ms = sleep_ms.min(2000); // Cap to prevent excessive delays on tiny chunks
                        // log::info!("[THROTTLE-DBG][PREBUFFER] msg={}, chunk_bytes={}, limit_kb={}/s, sleep_ms={}, offset={}", 
                        //     message_id, bytes_in_chunk, limit_kb, sleep_ms, current_offset);
                        tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                    } else {
                        // log::info!("[THROTTLE-DBG][PREBUFFER] msg={}, unlimited (limit_kb=0), no throttle sleep, offset={}", 
                        //     message_id, current_offset);
                    }

                    if is_last {
                        break;
                    }
                }
                Err(e) => {
                    log::error!("[PREBUFFER] Stream error for msg {}: {}", message_id, e);
                    break;
                }
            }
        }
    };

        if is_partial {
            HttpResponse::PartialContent()
                .insert_header(("Content-Type", mime))
                .insert_header(("Content-Length", content_length.to_string()))
                .insert_header(("Content-Range", format!("bytes {}-{}/{}", start_byte, end_byte, size)))
                .insert_header(("Accept-Ranges", "bytes"))
                .insert_header(("Connection", "keep-alive"))
                .insert_header(("X-Download-Mode", "sequential"))
                .streaming(stream)
        } else {
            HttpResponse::Ok()
                .insert_header(("Content-Type", mime))
                .insert_header(("Content-Length", size.to_string()))
                .insert_header(("Accept-Ranges", "bytes"))
                .insert_header(("X-Download-Mode", "sequential"))
                .streaming(stream)
        }
    }
}

pub async fn start_streaming_server(
    port: u16,
    tg_state: Arc<TelegramState>,
    token: String,
    cache_mgr: Option<StreamCacheManager>,
) -> std::io::Result<actix_web::dev::Server> {
    let token_data = web::Data::new(StreamTokenData { token });
    let tg_data = web::Data::new(tg_state);
    let cache_data = web::Data::new(cache_mgr);

    let server = HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .expose_headers(["Content-Range", "Content-Length", "Accept-Ranges", "X-Cache"])
            .max_age(3600);

        App::new()
            .wrap(cors)
            .app_data(token_data.clone())
            .app_data(tg_data.clone())
            .app_data(cache_data.clone())
            .service(stream_media)
            .service(stream_media_head)
            .configure(hls::configure_hls)
            .configure(crate::faststart::configure_faststart)
    })
    .bind(("127.0.0.1", port))?
    .run();

    Ok(server)
}

/// Legacy entry point called from lib.rs — delegates to start_streaming_server.
/// Returns a single Server (lib.rs only uses the first element anyway).
pub async fn start_server(
    tg_state: Arc<TelegramState>,
    port: u16,
    token: String,
    cache_mgr: Option<StreamCacheManager>,
    _api_port: u16,
) -> std::io::Result<actix_web::dev::Server> {
    start_streaming_server(port, tg_state, token, cache_mgr).await
}
