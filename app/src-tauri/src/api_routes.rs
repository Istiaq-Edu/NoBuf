use actix_web::{get, head, web, HttpRequest, HttpResponse, Responder};
use crate::commands::TelegramState;
use crate::commands::utils::resolve_peer;
use grammers_client::types::Media;
use serde::Serialize;
use std::sync::Arc;

/// Shared state for the API server — holds the key hash for auth checks
pub struct ApiState {
    pub key_hash: Option<String>,
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: String,
    message: String,
}

fn json_error(code: &str, message: &str, status: u16) -> HttpResponse {
    let body = ErrorBody {
        error: ErrorDetail {
            code: code.to_string(),
            message: message.to_string(),
        },
    };
    HttpResponse::build(actix_web::http::StatusCode::from_u16(status).unwrap())
        .json(body)
}

/// Validate X-API-Key header against stored hash
fn check_auth(req: &HttpRequest, api_state: &web::Data<ApiState>) -> Result<(), HttpResponse> {
    let key_hash = match &api_state.key_hash {
        Some(h) => h,
        None => return Err(json_error("NO_KEY_CONFIGURED", "No API key has been configured. Generate one in Settings.", 401)),
    };

    let provided = req
        .headers()
        .get("X-API-Key")
        .and_then(|v| v.to_str().ok());

    match provided {
        Some(key) if crate::commands::api_settings::verify_key(key, key_hash) => Ok(()),
        Some(_) => Err(json_error("UNAUTHORIZED", "Invalid API key", 401)),
        None => Err(json_error("UNAUTHORIZED", "Missing X-API-Key header", 401)),
    }
}

/// Parse a Range header value (e.g., "bytes=0-1023") into (start, end) where end is inclusive.
fn parse_range_header(range: &str, total_size: u64) -> Option<(u64, u64)> {
    let range = range.trim().strip_prefix("bytes=")?;
    let parts: Vec<&str> = range.split('-').collect();
    if parts.len() != 2 {
        return None;
    }

    let start = if parts[0].is_empty() {
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

// ──────────────────────────────── Endpoints ────────────────────────────────

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    version: String,
}

#[get("/api/v1/health")]
async fn api_health() -> impl Responder {
    HttpResponse::Ok().json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[derive(serde::Deserialize)]
struct FilesQuery {
    folder_id: Option<i64>,
    page: Option<u32>,
    limit: Option<u32>,
    search: Option<String>,
}

#[derive(Serialize)]
struct FilesResponse {
    files: Vec<ApiFile>,
    page: u32,
    limit: u32,
    total: usize,
}

#[derive(Serialize)]
struct ApiFile {
    id: i64,
    folder_id: Option<i64>,
    name: String,
    size: u64,
    mime_type: Option<String>,
    created_at: String,
}

#[get("/api/v1/files")]
async fn api_list_files(
    req: HttpRequest,
    query: web::Query<FilesQuery>,
    tg_state: web::Data<Arc<TelegramState>>,
    api_state: web::Data<ApiState>,
) -> impl Responder {
    if let Err(e) = check_auth(&req, &api_state) {
        return e;
    }

    let client_opt = { tg_state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return json_error("NOT_CONNECTED", "Telegram client is not connected", 503),
    };

    let peer = match resolve_peer(&client, query.folder_id, &tg_state.peer_cache).await {
        Ok(p) => p,
        Err(e) => return json_error("PEER_ERROR", &e, 400),
    };

    let mut all_files: Vec<ApiFile> = Vec::new();
    let mut msgs = client.iter_messages(&peer);

    while let Some(msg) = msgs.next().await.ok().flatten() {
        if let Some(doc) = msg.media() {
            let (name, size, mime) = match doc {
                Media::Document(d) => {
                    (d.name().to_string(), d.size(), d.mime_type().map(|s| s.to_string()))
                }
                Media::Photo(_) => ("Photo.jpg".to_string(), 0, Some("image/jpeg".into())),
                _ => ("Unknown".to_string(), 0, None),
            };

            // Apply search filter if provided
            if let Some(ref search) = query.search {
                if !name.to_lowercase().contains(&search.to_lowercase()) {
                    continue;
                }
            }

            all_files.push(ApiFile {
                id: msg.id() as i64,
                folder_id: query.folder_id,
                name,
                size: size as u64,
                mime_type: mime,
                created_at: msg.date().to_string(),
            });
        }
    }

    let total = all_files.len();
    let page = query.page.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(50).min(200).max(1);
    let start = ((page - 1) * limit) as usize;
    let paginated: Vec<ApiFile> = all_files.into_iter().skip(start).take(limit as usize).collect();

    HttpResponse::Ok().json(FilesResponse {
        files: paginated,
        page,
        limit,
        total,
    })
}

#[derive(serde::Deserialize)]
struct FolderQuery {
    folder_id: Option<i64>,
}

#[get("/api/v1/files/{message_id}")]
async fn api_get_file(
    req: HttpRequest,
    path: web::Path<i64>,
    query: web::Query<FolderQuery>,
    tg_state: web::Data<Arc<TelegramState>>,
    api_state: web::Data<ApiState>,
) -> impl Responder {
    if let Err(e) = check_auth(&req, &api_state) {
        return e;
    }

    let message_id = path.into_inner() as i32;
    let client_opt = { tg_state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return json_error("NOT_CONNECTED", "Telegram client is not connected", 503),
    };

    let peer = match resolve_peer(&client, query.folder_id, &tg_state.peer_cache).await {
        Ok(p) => p,
        Err(e) => return json_error("PEER_ERROR", &e, 400),
    };

    match client.get_messages_by_id(peer, &[message_id]).await {
        Ok(messages) => {
            if let Some(Some(msg)) = messages.first() {
                if let Some(doc) = msg.media() {
                    let (name, size, mime) = match doc {
                        Media::Document(d) => {
                            (d.name().to_string(), d.size(), d.mime_type().map(|s| s.to_string()))
                        }
                        Media::Photo(_) => ("Photo.jpg".to_string(), 0, Some("image/jpeg".into())),
                        _ => ("Unknown".to_string(), 0, None),
                    };
                    return HttpResponse::Ok().json(ApiFile {
                        id: msg.id() as i64,
                        folder_id: query.folder_id,
                        name,
                        size: size as u64,
                        mime_type: mime,
                        created_at: msg.date().to_string(),
                    });
                }
            }
            json_error("NOT_FOUND", "File not found", 404)
        }
        Err(e) => json_error("FETCH_ERROR", &format!("Failed to fetch file: {}", e), 500),
    }
}

/// HEAD endpoint for file metadata discovery
#[head("/api/v1/files/{message_id}/download")]
async fn api_download_file_head(
    req: HttpRequest,
    path: web::Path<i64>,
    query: web::Query<FolderQuery>,
    tg_state: web::Data<Arc<TelegramState>>,
    api_state: web::Data<ApiState>,
) -> impl Responder {
    if let Err(e) = check_auth(&req, &api_state) {
        return e;
    }

    let message_id = path.into_inner() as i32;
    let client_opt = { tg_state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return json_error("NOT_CONNECTED", "Telegram client is not connected", 503),
    };

    let peer = match resolve_peer(&client, query.folder_id, &tg_state.peer_cache).await {
        Ok(p) => p,
        Err(e) => return json_error("PEER_ERROR", &e, 400),
    };

    match client.get_messages_by_id(peer, &[message_id]).await {
        Ok(messages) => {
            if let Some(Some(msg)) = messages.first() {
                if let Some(media) = msg.media() {
                    let size = match &media {
                        Media::Document(d) => d.size(),
                        _ => 0,
                    };
                    let mime = match &media {
                        Media::Document(d) => d.mime_type().unwrap_or("application/octet-stream").to_string(),
                        _ => "application/octet-stream".to_string(),
                    };
                    return HttpResponse::Ok()
                        .insert_header(("Content-Type", mime))
                        .insert_header(("Content-Length", size.to_string()))
                        .insert_header(("Accept-Ranges", "bytes"))
                        .finish();
                }
            }
            json_error("NOT_FOUND", "File not found", 404)
        }
        Err(e) => json_error("FETCH_ERROR", &format!("Failed to fetch file: {}", e), 500),
    }
}

#[get("/api/v1/files/{message_id}/download")]
async fn api_download_file(
    req: HttpRequest,
    path: web::Path<i64>,
    query: web::Query<FolderQuery>,
    tg_state: web::Data<Arc<TelegramState>>,
    api_state: web::Data<ApiState>,
) -> impl Responder {
    if let Err(e) = check_auth(&req, &api_state) {
        return e;
    }

    let message_id = path.into_inner() as i32;
    let client_opt = { tg_state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return json_error("NOT_CONNECTED", "Telegram client is not connected", 503),
    };

    let peer = match resolve_peer(&client, query.folder_id, &tg_state.peer_cache).await {
        Ok(p) => p,
        Err(e) => return json_error("PEER_ERROR", &e, 400),
    };

    match client.get_messages_by_id(peer, &[message_id]).await {
        Ok(messages) => {
            if let Some(Some(msg)) = messages.first() {
                if let Some(media) = msg.media() {
                    let size = match &media {
                        Media::Document(d) => d.size() as u64,
                        _ => 0,
                    };
                    let mime = match &media {
                        Media::Document(d) => d.mime_type().unwrap_or("application/octet-stream").to_string(),
                        _ => "application/octet-stream".to_string(),
                    };
                    let filename = match &media {
                        Media::Document(d) => d.name().to_string(),
                        Media::Photo(_) => "Photo.jpg".to_string(),
                        _ => "download".to_string(),
                    };

                    // Parse Range header if present
                    let range_header = req.headers().get("Range").and_then(|v| v.to_str().ok());

                    let (start_byte, end_byte, is_partial) = if let Some(range_str) = range_header {
                        match parse_range_header(range_str, size) {
                            Some((start, end)) => (start, end, true),
                            None => {
                                return HttpResponse::build(actix_web::http::StatusCode::RANGE_NOT_SATISFIABLE)
                                    .insert_header(("Content-Range", format!("bytes */{}", size)))
                                    .body("Invalid Range header");
                            }
                        }
                    } else {
                        (0, size.saturating_sub(1), false)
                    };

                    let content_length = end_byte - start_byte + 1;

                    // Calculate chunk skip count for the requested byte offset
                    let chunk_size: u64 = 512 * 1024; // 512 KB
                    let chunks_to_skip = start_byte / chunk_size;
                    let bytes_to_discard = start_byte % chunk_size;

                    // Build the download iterator with proper offset via skip_chunks
                    let download_iter = client.iter_download(&media)
                        .chunk_size(chunk_size as i32)
                        .skip_chunks(chunks_to_skip as i32);

                    let stream = async_stream::stream! {
                        let mut bytes_sent: u64 = 0;
                        let mut first_chunk = true;
                        let mut iter = download_iter;
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

                                    if data.len() as u64 > remaining {
                                        yield Ok::<_, actix_web::Error>(web::Bytes::from(data[..remaining as usize].to_vec()));
                                        break;
                                    }
                                    bytes_sent += data.len() as u64;
                                    yield Ok::<_, actix_web::Error>(web::Bytes::from(data));
                                }
                                Err(e) => {
                                    log::error!("API download stream error: {}", e);
                                    break;
                                }
                            }
                        }
                    };

                    if is_partial {
                        return HttpResponse::PartialContent()
                            .insert_header(("Content-Type", mime))
                            .insert_header(("Content-Length", content_length.to_string()))
                            .insert_header(("Content-Range", format!("bytes {}-{}/{}", start_byte, end_byte, size)))
                            .insert_header(("Accept-Ranges", "bytes"))
                            .insert_header(("Content-Disposition", format!("attachment; filename=\"{}\"", filename)))
                            .streaming(stream);
                    } else {
                        return HttpResponse::Ok()
                            .insert_header(("Content-Type", mime))
                            .insert_header(("Content-Length", size.to_string()))
                            .insert_header(("Content-Disposition", format!("attachment; filename=\"{}\"", filename)))
                            .insert_header(("Accept-Ranges", "bytes"))
                            .streaming(stream);
                    }
                }
            }
            json_error("NOT_FOUND", "File not found", 404)
        }
        Err(e) => json_error("FETCH_ERROR", &format!("Failed to fetch file: {}", e), 500),
    }
}

/// Register all API routes on the Actix App
pub fn configure_api(cfg: &mut web::ServiceConfig) {
    cfg.service(api_health)
       .service(api_list_files)
       .service(api_get_file)
       .service(api_download_file)
       .service(api_download_file_head);
}
