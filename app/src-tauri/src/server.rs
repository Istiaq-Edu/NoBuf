use actix_web::{get, web, App, HttpServer, HttpResponse, Responder};
use actix_cors::Cors;
use crate::commands::TelegramState;
use crate::commands::utils::resolve_peer;
use grammers_client::types::Media;

use std::sync::Arc;

/// Holds the per-session streaming token for Actix validation
pub struct StreamTokenData {
    pub token: String,
}

#[derive(serde::Deserialize)]
struct StreamQuery {
    token: Option<String>,
}

#[get("/stream/{folder_id}/{message_id}")]
async fn stream_media(
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    // Validate session token
    match &query.token {
        Some(t) if t == &token_data.token => {
            log::debug!("Stream request: Token validated successfully for msg {}", message_id);
        },
        _ => {
            log::error!("Stream request failed: Invalid or missing stream token for msg {}", message_id);
            return HttpResponse::Forbidden().body("Invalid or missing stream token")
        },
    }
    
    // Parse folder ID
    let folder_id = if folder_id_str == "me" || folder_id_str == "home" || folder_id_str == "null" {
        log::debug!("Stream request: Using root folder for msg {}", message_id);
        None
    } else {
        match folder_id_str.parse::<i64>() {
            Ok(id) => {
                log::debug!("Stream request: Parsed folder ID {} for msg {}", id, message_id);
                Some(id)
            },
            Err(_) => {
                log::error!("Stream request failed: Invalid folder ID format '{}' for msg {}", folder_id_str, message_id);
                return HttpResponse::BadRequest().body("Invalid folder ID")
            },
        }
    };

    let client_opt = {
        data.client.lock().await.clone()
    };

    if let Some(client) = client_opt {
        log::debug!("Stream request: Client acquired, resolving peer for msg {}...", message_id);
        match resolve_peer(&client, folder_id).await {
            Ok(peer) => {
                log::debug!("Stream request: Peer resolved, fetching message {}...", message_id);
                // Try to fetch message efficiently
                 match client.get_messages_by_id(peer, &[message_id]).await {
                    Ok(messages) => {
                        if let Some(Some(msg)) = messages.first() {
                            if let Some(media) = msg.media() {
                                log::debug!("Stream request: Message and media found for msg {}", message_id);
                                let size = match &media {
                                    Media::Document(d) => d.size(),
                                    Media::Photo(_) => 0, 
                                    _ => 0,
                                };
                                
                                let mime = mime_type_from_media(&media);
                                log::debug!("Stream request: Starting download for msg {} (mime: {}, size: {})", message_id, mime, size);
                                
                                // Create chunk-streaming response
                                let mut download_iter = client.iter_download(&media);
                                let stream = async_stream::stream! {
                                    let mut chunk_count = 0;
                                    while let Some(chunk) = download_iter.next().await.transpose() {
                                        match chunk {
                                            Ok(bytes) => {
                                                chunk_count += 1;
                                                if chunk_count % 100 == 0 {
                                                    log::debug!("Stream request: Streamed {} chunks for msg {}", chunk_count, message_id);
                                                }
                                                yield Ok::<_, actix_web::Error>(web::Bytes::from(bytes))
                                            },
                                            Err(e) => {
                                                log::error!("Stream error on msg {}: {}", message_id, e);
                                                break;
                                            }
                                        }
                                    }
                                    log::debug!("Stream request: Stream completed for msg {} (total chunks: {})", message_id, chunk_count);
                                };
                                
                                return HttpResponse::Ok()
                                    .insert_header(("Content-Type", mime)) 
                                    .insert_header(("Content-Length", size.to_string()))
                                    .insert_header(("Cache-Control", "private, max-age=120"))
                                    .streaming(stream);
                            } else {
                                log::error!("Stream request failed: Media not found in message {}", message_id);
                            }
                        } else {
                            log::error!("Stream request failed: Message {} not found", message_id);
                        }
                        HttpResponse::NotFound().body("Message or media not found")
                    },
                    Err(e) => {
                        log::error!("Stream request failed: Error fetching message {}: {}", message_id, e);
                        HttpResponse::InternalServerError().body(format!("Failed to fetch message: {}", e))
                    },
                 }
            },
            Err(e) => {
                log::error!("Stream request failed: Peer resolution error for msg {}: {}", message_id, e);
                HttpResponse::BadRequest().body(format!("Peer resolution failed: {}", e))
            },
        }
    } else {
        log::error!("Stream request failed: Telegram client not connected for msg {}", message_id);
        HttpResponse::ServiceUnavailable().body("Telegram client not connected")
    }
}

fn mime_type_from_media(media: &Media) -> String {
    match media {
        Media::Document(d) => d.mime_type().unwrap_or("application/octet-stream").to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

pub async fn start_server(state: Arc<TelegramState>, port: u16, token: String) -> std::io::Result<actix_web::dev::Server> {
    let state_data = web::Data::new(state);
    let token_data = web::Data::new(StreamTokenData { token });
    
    log::info!("Starting Streaming Server on port {}", port);
    
    let server = HttpServer::new(move || {
        let cors = Cors::default()
            .allowed_origin("tauri://localhost")
            .allowed_origin("http://localhost:1420")
            .allowed_origin("https://tauri.localhost")
            .allow_any_method()
            .allow_any_header();

        App::new()
            .wrap(cors)
            .app_data(state_data.clone())
            .app_data(token_data.clone())
            .service(stream_media)
    })
    .bind(("127.0.0.1", port))?
    .run();

    log::info!("Streaming Server started successfully on http://127.0.0.1:{}", port);

    Ok(server)
}
