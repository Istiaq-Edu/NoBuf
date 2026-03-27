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
    // Validate session token
    match &query.token {
        Some(t) if t == &token_data.token => {},
        _ => return HttpResponse::Forbidden().body("Invalid or missing stream token"),
    }

    let (folder_id_str, message_id) = path.into_inner();
    
    // Parse folder ID
    let folder_id = if folder_id_str == "me" || folder_id_str == "home" || folder_id_str == "null" {
        None
    } else {
        match folder_id_str.parse::<i64>() {
            Ok(id) => Some(id),
            Err(_) => return HttpResponse::BadRequest().body("Invalid folder ID"),
        }
    };

    let client_opt = {
        data.client.lock().await.clone()
    };

    if let Some(client) = client_opt {
        match resolve_peer(&client, folder_id).await {
            Ok(peer) => {
                // Try to fetch message efficiently
                 match client.get_messages_by_id(peer, &[message_id]).await {
                    Ok(messages) => {
                        if let Some(Some(msg)) = messages.first() {
                            if let Some(media) = msg.media() {
                                let size = match &media {
                                    Media::Document(d) => d.size(),
                                    Media::Photo(_) => 0, 
                                    _ => 0,
                                };
                                
                                let mime = mime_type_from_media(&media);
                                
                                // Create chunk-streaming response
                                let mut download_iter = client.iter_download(&media);
                                let stream = async_stream::stream! {
                                    while let Some(chunk) = download_iter.next().await.transpose() {
                                        match chunk {
                                            Ok(bytes) => yield Ok::<_, actix_web::Error>(web::Bytes::from(bytes)),
                                            Err(e) => {
                                                log::error!("Stream error: {}", e);
                                                break;
                                            }
                                        }
                                    }
                                };
                                
                                return HttpResponse::Ok()
                                    .insert_header(("Content-Type", mime)) 
                                    .insert_header(("Content-Length", size.to_string()))
                                    .insert_header(("Cache-Control", "private, max-age=120"))
                                    .streaming(stream);
                            }
                        }
                        HttpResponse::NotFound().body("Message or media not found")
                    },
                    Err(e) => HttpResponse::InternalServerError().body(format!("Failed to fetch message: {}", e)),
                 }
            },
            Err(e) => HttpResponse::BadRequest().body(format!("Peer resolution failed: {}", e)),
        }
    } else {
        HttpResponse::ServiceUnavailable().body("Telegram client not connected")
    }
}

fn mime_type_from_media(media: &Media) -> String {
    match media {
        Media::Document(d) => d.mime_type().unwrap_or("application/octet-stream").to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

pub async fn start_server(state: Arc<TelegramState>, port: u16, token: String) -> std::io::Result<()> {
    let state_data = web::Data::new(state);
    let token_data = web::Data::new(StreamTokenData { token });
    
    log::info!("Starting Streaming Server on port {}", port);
    
    HttpServer::new(move || {
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
    .run()
    .await
}
