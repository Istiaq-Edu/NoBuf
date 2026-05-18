use actix_web::{get, head, web, App, HttpServer, HttpRequest, HttpResponse, Responder};
use actix_cors::Cors;
use crate::commands::TelegramState;
use crate::commands::utils::resolve_peer;
use crate::hls;
use grammers_client::types::Media;
use grammers_tl_types as tl;

use std::sync::Arc;
use crate::stream_cache::{StreamCacheManager, CacheMeta, merge_ranges, is_range_cached};
use std::io::{Write, Seek, SeekFrom};

/// Holds the per-session streaming token for Actix validation
pub(crate) struct StreamTokenData {
    pub(crate) token: String,
}

#[derive(serde::Deserialize)]
pub(crate) struct StreamQuery {
    pub(crate) token: Option<String>,
}

/// Chunk size for downloads (512 KB) — balances between request overhead and memory
const DOWNLOAD_CHUNK_SIZE: i32 = 512 * 1024;

/// Parse a Range header value (e.g., "bytes=0-1023") into (start, end) where end is inclusive.
/// Returns None if the header is missing or malformed.
fn parse_range_header(range: &str, total_size: u64) -> Option<(u64, u64)> {
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
async fn resolve_media_from_path(
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

    log::info!("Document size for msg {}: {} bytes", message_id, size);

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
            log::info!("HEAD response for msg {}: size={}, mime={}", message_id, size, mime);
            HttpResponse::Ok()
                .insert_header(("Content-Type", mime))
                .insert_header(("Content-Length", size.to_string()))
                .insert_header(("Accept-Ranges", "bytes"))
                .finish()
        }
        Err(resp) => {
            log::error!("HEAD request failed for msg {}", message_id);
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
    log::debug!("Stream request: Received request for message {} in folder '{}'", message_id, folder_id_str);

    let (media, size) = match resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &query).await {
        Ok(result) => result,
        Err(resp) => return resp,
    };

    let mime = mime_type_from_media(&media);
    log::debug!("Stream request: Starting download for msg {} (mime: {}, size: {})", message_id, mime, size);

    // Set up cache file if cache manager is available — every range request
    // caches its bytes independently (no write-lock needed, seek+write is atomic).
    let mut cache_setup: Option<(std::fs::File, StreamCacheManager, i32, i64, String, String)> =
        if let Some(ref cache_mgr) = **cache {
            let data_path = cache_mgr.data_path(message_id);
            match std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .open(&data_path)
            {
                Ok(f) => Some((
                    f,
                    cache_mgr.clone(),
                    message_id,
                    folder_id_str.parse::<i64>().unwrap_or(0),
                    match &media {
                        Media::Document(d) => d.name().to_string(),
                        _ => format!("{}.mp4", message_id),
                    },
                    mime.clone(),
                )),
                Err(e) => {
                    log::warn!("Failed to open cache file for {}: {}", message_id, e);
                    None
                }
            }
        } else {
            None
        };

    // Parse Range header if present
    let range_header = req.headers().get("Range").and_then(|v| v.to_str().ok());

    let (start_byte, end_byte, is_partial) = if let Some(range_str) = range_header {
        match parse_range_header(range_str, size) {
            Some((start, end)) => {
                log::debug!("Stream request: Range request bytes={}-{} for msg {}", start, end, message_id);
                (start, end, true)
            }
            None => {
                log::warn!("Stream request: Invalid Range header '{}' for msg {}", range_str, message_id);
                return HttpResponse::build(actix_web::http::StatusCode::RANGE_NOT_SATISFIABLE)
                    .insert_header(("Content-Range", format!("bytes */{}", size)))
                    .body("Invalid Range header");
            }
        }
    } else {
        (0, size.saturating_sub(1), false)
    };

    let content_length = end_byte - start_byte + 1;

    // FAST PATH: If the requested range is fully cached, serve from disk immediately
    if let Some(ref cache_mgr) = **cache {
        if let Some(meta) = cache_mgr.load_meta(message_id) {
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
                        log::info!("Cache HIT for msg {} range {}-{} ({} bytes served from disk)",
                            message_id, start_byte, end_byte, slice.len());

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
                        log::warn!("Cache read failed for msg {}, falling back to Telegram: {}", message_id, e);
                    }
                }
            }
        }
    }

    let client_guard = { data.client.lock().await.clone() };
    let client = match client_guard {
        Some(c) => c,
        None => return HttpResponse::ServiceUnavailable().body("Telegram client not connected"),
    };

    // Calculate chunk skip count for the requested byte offset
    let chunk_size = DOWNLOAD_CHUNK_SIZE as u64;
    let chunks_to_skip = start_byte / chunk_size;
    let bytes_to_discard = start_byte % chunk_size;

    // Build the download iterator with proper offset via skip_chunks
    let download_iter = client.iter_download(&media)
        .chunk_size(DOWNLOAD_CHUNK_SIZE)
        .skip_chunks(chunks_to_skip as i32);

    let stream = async_stream::stream! {
        let mut bytes_sent: u64 = 0;
        let mut first_chunk = true;
        let mut iter = download_iter;
        let mut current_offset = start_byte;

        while let Some(chunk) = iter.next().await.transpose() {
            match chunk {
                Ok(bytes) => {
                    let remaining = content_length - bytes_sent;
                    if remaining == 0 {
                        break;
                    }

                    let mut data = bytes;

                    // On first chunk, discard leading bytes to align with start_byte
                    if first_chunk && bytes_to_discard > 0 {
                        let discard = bytes_to_discard.min(data.len() as u64) as usize;
                        data = data[discard..].to_vec();
                        first_chunk = false;
                    }

                    let is_last = data.len() as u64 > remaining;
                    let final_data = if is_last {
                        data[..remaining as usize].to_vec()
                    } else {
                        data
                    };

                    let bytes_in_chunk = final_data.len() as u64;

                    // Write to disk cache if available
                    if let Some((ref mut cache_file, ref cache_mgr, mid, fid, ref fname, ref mime)) = cache_setup {
                        let _ = cache_file.seek(SeekFrom::Start(current_offset));
                        let _ = cache_file.write_all(&final_data);

                        let mut meta = cache_mgr.load_meta(mid).unwrap_or_else(|| CacheMeta {
                            message_id: mid,
                            folder_id: fid,
                            total_size: size,
                            filename: fname.clone(),
                            cached_ranges: Vec::new(),
                            mime_type: mime.clone(),
                        });
                        meta.cached_ranges.push((current_offset, current_offset + bytes_in_chunk - 1));
                        merge_ranges(&mut meta.cached_ranges);
                        let _ = cache_mgr.save_meta(&meta);
                    }

                    current_offset += bytes_in_chunk;
                    bytes_sent += bytes_in_chunk;
                    yield Ok::<_, actix_web::Error>(web::Bytes::from(final_data));

                    if is_last {
                        break;
                    }
                }
                Err(e) => {
                    log::error!("Stream error for msg {}: {}", message_id, e);
                    break;
                }
            }
        }
        log::debug!("Stream complete for msg {}: sent {} bytes", message_id, bytes_sent);
    };

    if is_partial {
        HttpResponse::PartialContent()
            .insert_header(("Content-Type", mime))
            .insert_header(("Content-Length", content_length.to_string()))
            .insert_header(("Content-Range", format!("bytes {}-{}/{}", start_byte, end_byte, size)))
            .insert_header(("Accept-Ranges", "bytes"))
            .insert_header(("Connection", "keep-alive"))
            .streaming(stream)
    } else {
        HttpResponse::Ok()
            .insert_header(("Content-Type", mime))
            .insert_header(("Content-Length", size.to_string()))
            .insert_header(("Accept-Ranges", "bytes"))
            .streaming(stream)
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
            .expose_headers(["Content-Range", "Content-Length", "Accept-Ranges"])
            .max_age(3600);

        App::new()
            .wrap(cors)
            .app_data(token_data.clone())
            .app_data(tg_data.clone())
            .app_data(cache_data.clone())
            .service(stream_media)
            .service(stream_media_head)
            .configure(hls::configure_hls)
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
