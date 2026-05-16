use actix_web::{get, web, HttpResponse, Responder};
use crate::commands::TelegramState;
use crate::commands::utils::resolve_peer;
use crate::server::{StreamTokenData, StreamQuery};
use grammers_client::types::Media;
use std::sync::Arc;

/// Default segment duration in seconds
const SEGMENT_DURATION: f64 = 10.0;

/// Minimum segment size in bytes (1MB)
const MIN_SEGMENT_SIZE: u64 = 1024 * 1024;

/// Maximum number of segments to generate
const MAX_SEGMENTS: u32 = 10000;

#[derive(Debug, Clone)]
pub struct HLSInfo {
    pub duration: f64,
    pub segment_duration: f64,
    pub segment_count: u32,
    pub file_size: u64,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub bandwidth: u64,
}

/// Calculate HLS segment information from file size and estimated duration
pub fn calculate_hls_info(file_size: u64, mime_type: &str) -> HLSInfo {
    // Estimate duration based on bitrate
    // Typical video bitrates: 1-8 Mbps
    // We'll use a conservative estimate of 2 Mbps for unknown files
    let estimated_bitrate = 2_000_000u64; // 2 Mbps in bits
    let estimated_duration = (file_size * 8) as f64 / estimated_bitrate as f64;

    // Calculate segment count
    let segment_count = ((estimated_duration / SEGMENT_DURATION).ceil() as u32).min(MAX_SEGMENTS);

    // Detect codec from mime type
    let codec = if mime_type.contains("video/mp4") {
        "avc1.42E01E,mp4a.40.2".to_string() // H.264 Baseline + AAC
    } else if mime_type.contains("video/webm") {
        "vp8,vorbis".to_string()
    } else {
        "avc1.42E01E,mp4a.40.2".to_string() // Default to H.264
    };

    // Estimate resolution from file size (very rough)
    let (width, height) = if file_size > 500_000_000 {
        (1920, 1080) // Large files likely 1080p
    } else if file_size > 100_000_000 {
        (1280, 720) // Medium files likely 720p
    } else {
        (854, 480) // Small files likely 480p
    };

    let bandwidth = estimated_bitrate;

    HLSInfo {
        duration: estimated_duration,
        segment_duration: SEGMENT_DURATION,
        segment_count,
        file_size,
        codec,
        width,
        height,
        bandwidth,
    }
}

/// Generate HLS master playlist
pub fn generate_master_playlist(info: &HLSInfo, base_url: &str, token: &str) -> String {
    format!(
        "#EXTM3U\n\
         #EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={}x{},CODECS=\"{}\"\n\
         {}/level_0.m3u8?token={}\n",
        info.bandwidth, info.width, info.height, info.codec, base_url, token
    )
}

/// Generate HLS media playlist with byte-range segments
/// Segments point to the main /stream/ endpoint which supports Range requests.
pub fn generate_media_playlist(info: &HLSInfo, stream_url: &str, token: &str) -> String {
    let segment_size = (info.file_size / info.segment_count as u64).max(MIN_SEGMENT_SIZE);

    let mut playlist = format!(
        "#EXTM3U\n\
         #EXT-X-VERSION:7\n\
         #EXT-X-TARGETDURATION:{}\n\
         #EXT-X-MEDIA-SEQUENCE:0\n",
        info.segment_duration.ceil() as u32
    );

    // Use byte-range segments pointing to the main stream endpoint
    for i in 0..info.segment_count {
        let byte_start = i as u64 * segment_size;
        let byte_end = if i == info.segment_count - 1 {
            info.file_size - 1
        } else {
            (byte_start + segment_size - 1).min(info.file_size - 1)
        };

        let segment_duration = if i == info.segment_count - 1 {
            let remaining = info.duration - (i as f64 * info.segment_duration);
            if remaining > 0.0 { remaining } else { info.segment_duration }
        } else {
            info.segment_duration
        };

        let byte_length = byte_end - byte_start + 1;

        playlist.push_str(&format!(
            "#EXTINF:{:.3},\n\
             #EXT-X-BYTERANGE:{}@{}\n\
             {}?token={}\n",
            segment_duration, byte_length, byte_start, stream_url, token
        ));
    }

    playlist.push_str("#EXT-X-ENDLIST\n");
    playlist
}

/// HLS master playlist endpoint
#[get("/hls/{folder_id}/{message_id}/master.m3u8")]
async fn hls_master(
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    // Validate token
    match &query.token {
        Some(t) if t == &token_data.token => {},
        _ => return HttpResponse::Forbidden().body("Invalid or missing stream token"),
    }

    // Resolve folder
    let folder_id = if folder_id_str == "me" || folder_id_str == "home" || folder_id_str == "null" {
        None
    } else {
        match folder_id_str.parse::<i64>() {
            Ok(id) => Some(id),
            Err(_) => return HttpResponse::BadRequest().body("Invalid folder ID"),
        }
    };

    // Get client
    let client_guard = { data.client.lock().await.clone() };
    let client = match client_guard {
        Some(c) => c,
        None => return HttpResponse::ServiceUnavailable().body("Telegram client not connected"),
    };

    // Resolve peer
    let peer = match resolve_peer(&client, folder_id, &data.peer_cache).await {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().body(format!("Could not resolve folder: {}", e)),
    };

    // Fetch message
    let messages = match client.get_messages_by_id(&peer, &[message_id]).await {
        Ok(m) => m,
        Err(e) => return HttpResponse::InternalServerError().body(format!("Could not fetch message: {}", e)),
    };

    let msg = match messages.into_iter().next().flatten() {
        Some(m) => m,
        None => return HttpResponse::NotFound().body("Message not found"),
    };

    let media = match msg.media() {
        Some(m) => m,
        None => return HttpResponse::NotFound().body("Message does not contain media"),
    };

    let (size, mime) = match &media {
        Media::Document(d) => (d.size() as u64, d.mime_type().unwrap_or("application/octet-stream").to_string()),
        _ => return HttpResponse::BadRequest().body("Not a video file"),
    };

    let info = calculate_hls_info(size, &mime);
    let hls_base_url = format!("http://localhost:{}/hls/{}/{}", 14201, folder_id_str, message_id);
    let manifest = generate_master_playlist(&info, &hls_base_url, query.token.as_deref().unwrap_or(""));

    HttpResponse::Ok()
        .insert_header(("Content-Type", "application/vnd.apple.mpegurl"))
        .insert_header(("Cache-Control", "no-cache"))
        .body(manifest)
}

/// HLS media playlist endpoint
/// Segments use byte-range requests to the main /stream/ endpoint.
#[get("/hls/{folder_id}/{message_id}/level_0.m3u8")]
async fn hls_level(
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    // Validate token
    match &query.token {
        Some(t) if t == &token_data.token => {},
        _ => return HttpResponse::Forbidden().body("Invalid or missing stream token"),
    }

    // Resolve folder
    let folder_id = if folder_id_str == "me" || folder_id_str == "home" || folder_id_str == "null" {
        None
    } else {
        match folder_id_str.parse::<i64>() {
            Ok(id) => Some(id),
            Err(_) => return HttpResponse::BadRequest().body("Invalid folder ID"),
        }
    };

    // Get client
    let client_guard = { data.client.lock().await.clone() };
    let client = match client_guard {
        Some(c) => c,
        None => return HttpResponse::ServiceUnavailable().body("Telegram client not connected"),
    };

    // Resolve peer
    let peer = match resolve_peer(&client, folder_id, &data.peer_cache).await {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().body(format!("Could not resolve folder: {}", e)),
    };

    // Fetch message
    let messages = match client.get_messages_by_id(&peer, &[message_id]).await {
        Ok(m) => m,
        Err(e) => return HttpResponse::InternalServerError().body(format!("Could not fetch message: {}", e)),
    };

    let msg = match messages.into_iter().next().flatten() {
        Some(m) => m,
        None => return HttpResponse::NotFound().body("Message not found"),
    };

    let media = match msg.media() {
        Some(m) => m,
        None => return HttpResponse::NotFound().body("Message does not contain media"),
    };

    let (size, mime) = match &media {
        Media::Document(d) => (d.size() as u64, d.mime_type().unwrap_or("application/octet-stream").to_string()),
        _ => return HttpResponse::BadRequest().body("Not a video file"),
    };

    // Use the main /stream/ endpoint as segment source (it supports Range requests)
    let stream_url = format!("http://localhost:{}/stream/{}/{}", 14201, folder_id_str, message_id);
    let info = calculate_hls_info(size, &mime);
    let manifest = generate_media_playlist(&info, &stream_url, query.token.as_deref().unwrap_or(""));

    HttpResponse::Ok()
        .insert_header(("Content-Type", "application/vnd.apple.mpegurl"))
        .insert_header(("Cache-Control", "no-cache"))
        .body(manifest)
}

/// Register HLS routes
pub(crate) fn configure_hls(cfg: &mut web::ServiceConfig) {
    cfg.service(hls_master)
       .service(hls_level);
}
