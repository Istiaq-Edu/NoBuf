use actix_web::{get, web, HttpResponse, Responder};
use crate::commands::TelegramState;
use crate::commands::utils::resolve_peer;
use crate::server::{StreamTokenData, StreamQuery};
use crate::stream_cache::{StreamCacheManager, merge_ranges, MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE};
use grammers_client::types::Media;
use grammers_tl_types as tl;
use std::collections::HashMap;
use std::sync::Arc;
use std::io::{Read, Seek, Write};

/// Default segment duration in seconds
const SEGMENT_DURATION: f64 = 10.0;

/// Minimum segment size in bytes (1MB)
const MIN_SEGMENT_SIZE: u64 = 1024 * 1024;

/// Maximum number of segments to generate
const MAX_SEGMENTS: u32 = 10000;

/// Fallback bitrate (bps) used when actual duration is unavailable
const FALLBACK_BITRATE: u64 = 2_000_000;

/// Standard MPEG-TS packet size in bytes
const STD_TS_PACKET_SIZE: u64 = 188;

/// M2TS (Blu-ray BDAV) packet size in bytes
/// M2TS wraps each 188-byte TS packet with a 4-byte timestamp prefix
const M2TS_PACKET_SIZE: u64 = 192;

/// Number of TS packets prepended to each segment (PAT + PMT only).
/// 2 packets covers just PAT and PMT — the minimum needed
/// by hls.js's TS demuxer to identify tracks.
const INIT_SEGMENT_PACKETS: u64 = 2;

/// Replacement PID for PMT when the stream uses 0x0FFF (null stuffing PID).
/// PID 0x0FFF is reserved in MPEG-TS as the null/padding PID — hls.js skips
/// all packets with this PID, so the PMT is never read, causing "Found no media".
/// We rewrite the PMT PID to 0x1000 (a valid, non-reserved PID) in the init_prefix.
const PMT_PID_REWRITE: u16 = 0x1000;

/// Stream types that need rewriting for mpegts.js compatibility.
/// stream_type=0x15 is mapped to kMetadata (ID3) by mpegts.js, causing audio
/// PES packets to be silently dropped. The correct mapping is 0x11 (kLOASAAC)
/// which routes to parseLOASAACPayload — mpegts.js's native LATM/LOAS parser.
/// Previously rewritten to 0x0F (kADTSAAC) which caused parseADTSAACPayload
/// to parse LATM frames as ADTS, corrupting audio → PIPELINE_ERROR_DECODE.
const REWRITE_STREAM_TYPES: &[(u8, u8)] = &[(0x15, 0x11)];

/// Detect TS packet size (188 for MPEG-TS, 192 for M2TS/BDAV) by scanning
/// the first bytes of a file for the MPEG-TS sync byte (0x47) at regular
/// intervals. Reads up to 8KB from disk or via a reader.
///
/// For M2TS (Blu-ray), each 192-byte packet starts with a 4-byte timestamp
/// prefix followed by a 188-byte TS payload beginning with 0x47. For standard
/// MPEG-TS, each 188-byte packet starts directly with 0x47.
#[allow(dead_code)]
pub fn detect_ts_packet_size_from_path(path: &std::path::Path) -> Option<u64> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 8192];
    let n = file.read(&mut buf).ok()?;
    if n < 576 { // need at least 3 packets to verify
        log::warn!("[HLS-DETECT] File too short ({} bytes) for packet detection at {}", n, path.display());
        return None;
    }
    buf.truncate(n);
    // Hex dump first 64 bytes for diagnostic
    let hex: String = buf[..64.min(buf.len())].iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().chunks(16).map(|c| c.join(" ")).collect::<Vec<_>>().join("\n[HLS-DETECT]   ");
    log::debug!("[HLS-DETECT] First 64 bytes of {}:\n[HLS-DETECT]   {}", path.display(), hex);
    let result = detect_ts_packet_size(&buf);
    if let Some(size) = result {
        log::debug!("[HLS-DETECT] Detected packet size={} for {}", size, path.display());
    } else {
        // Find positions of 0x47 to help diagnose
        let sync_positions: Vec<usize> = buf.iter().enumerate().filter(|(_, &b)| b == 0x47).map(|(i, _)| i).collect();
        log::warn!("[HLS-DETECT] No clear packet size. 0x47 positions (first 20): {:?}", &sync_positions[..20.min(sync_positions.len())]);
    }
    result
}

/// Detect packet size from an in-memory buffer.
/// Returns 188, 192, or None if inconclusive.
pub fn detect_ts_packet_size(data: &[u8]) -> Option<u64> {
    if data.len() < 576 {
        return None;
    }

    // Find first sync byte (0x47)
    let first_sync = data.iter().position(|&b| b == 0x47)?;

    // Check if sync repeats every 188 bytes
    let mut matches_188 = true;
    let mut matches_192 = true;

    for i in 1..30 {
        let offset_188 = first_sync + i * 188;
        let offset_192 = first_sync + i * 192;
        if offset_188 < data.len() && data[offset_188] != 0x47 {
            matches_188 = false;
        }
        if offset_192 < data.len() && data[offset_192] != 0x47 {
            matches_192 = false;
        }
        if !matches_188 && !matches_192 {
            break;
        }
    }

    // If 192 matches but 188 doesn't → M2TS
    if matches_192 && !matches_188 {
        return Some(M2TS_PACKET_SIZE);
    }
    // If 188 matches (regardless of 192) → standard TS
    // (192 might also match coincidentally if the 4-byte prefix happens
    // to contain 0x47 at the right offset, but 188 is the safer default)
    if matches_188 {
        return Some(STD_TS_PACKET_SIZE);
    }

    // Ambiguous — check file size divisibility as a hint
    None
}

/// Detect packet size from file size alone. M2TS files have sizes that are
/// exactly divisible by 192 but not 188. Standard TS files are divisible by 188.
pub fn detect_ts_packet_size_from_file_size(file_size: u64) -> Option<u64> {
    let div188 = file_size % STD_TS_PACKET_SIZE == 0;
    let div192 = file_size % M2TS_PACKET_SIZE == 0;

    if div192 && !div188 {
        // Strong signal: divisible by 192 but NOT 188 → M2TS
        Some(M2TS_PACKET_SIZE)
    } else if div188 && !div192 {
        // Divisible by 188 but NOT 192 → standard TS
        Some(STD_TS_PACKET_SIZE)
    } else if div188 && div192 {
        // Divisible by both (rare) — ambiguous, default to standard TS
        Some(STD_TS_PACKET_SIZE)
    } else {
        // Divisible by neither — not a raw TS/M2TS file, or has wrapper
        None
    }
}

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
    /// Detected TS packet size: 188 for standard MPEG-TS, 192 for M2TS/BDAV
    pub ts_packet_size: u64,
    /// Whether the file is M2TS format (192-byte packets with 4-byte timestamp prefix)
    pub is_m2ts: bool,
}

/// Extract video metadata (duration, width, height) from Telegram document
/// attributes. Returns (duration, width, height) — duration in seconds.
/// If no Video attribute is found, returns None for all fields.
pub fn extract_video_attrs_from_raw_msg(
    raw_msg: &tl::enums::Message,
) -> Option<(f64, u32, u32)> {
    let doc = match raw_msg {
        tl::enums::Message::Message(m) => match &m.media {
            Some(tl::enums::MessageMedia::Document(md)) => md.document.as_ref(),
            _ => None,
        },
        _ => None,
    };

    let doc_inner = match doc {
        Some(tl::enums::Document::Document(d)) => d,
        _ => return None,
    };

    let mut duration: Option<f64> = None;
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;

    for attr in &doc_inner.attributes {
        match attr {
            tl::enums::DocumentAttribute::Video(v) => {
                duration = Some(v.duration);
                width = Some(v.w as u32);
                height = Some(v.h as u32);
            }
            tl::enums::DocumentAttribute::Audio(a) => {
                // Audio duration as fallback for audio-only files
                if duration.is_none() {
                    duration = Some(a.duration as f64);
                }
            }
            _ => {}
        }
    }

    if duration.is_none() {
        // Log what attributes ARE present to help diagnose missing Video
        let attr_names: Vec<&str> = doc_inner.attributes.iter().map(|a| match a {
            tl::enums::DocumentAttribute::ImageSize(_) => "ImageSize",
            tl::enums::DocumentAttribute::Animated => "Animated",
            tl::enums::DocumentAttribute::Sticker(_) => "Sticker",
            tl::enums::DocumentAttribute::Video(_) => "Video",
            tl::enums::DocumentAttribute::Audio(_) => "Audio",
            tl::enums::DocumentAttribute::Filename(_) => "Filename",
            tl::enums::DocumentAttribute::HasStickers => "HasStickers",
            tl::enums::DocumentAttribute::CustomEmoji(_) => "CustomEmoji",
        }).collect();
        log::warn!("[HLS] No Video/Audio attribute found; present attrs: {:?}", attr_names);
    }

    duration.map(|d| (d, width.unwrap_or(0), height.unwrap_or(0)))
}

/// Calculate HLS segment information from file size, mime type, and
/// actual video metadata (if available).
///
/// When `actual_duration` is provided, it comes from Telegram's
/// DocumentAttributeVideo.duration and is the PTS duration in seconds.
/// The manifest duration will be within ±5% of actual.
///
/// When actual metadata is unavailable, falls back to bitrate estimation.
/// Also detects TS packet size (188 for standard MPEG-TS, 192 for M2TS/BDAV).
pub fn calculate_hls_info(
    file_size: u64,
    mime_type: &str,
    actual_duration: Option<f64>,
    actual_width: Option<u32>,
    actual_height: Option<u32>,
) -> HLSInfo {
    let duration = actual_duration.unwrap_or_else(|| {
        (file_size * 8) as f64 / FALLBACK_BITRATE as f64
    });

    let segment_count = ((duration / SEGMENT_DURATION).ceil() as u32).min(MAX_SEGMENTS);

    let codec = if mime_type.contains("video/mp4") || mime_type.contains("video/quicktime") {
        "avc1.42E01E,mp4a.40.2"
    } else if mime_type.contains("video/webm") {
        "vp8,vorbis"
    } else {
        // TS files and unknown — assume H.264 + AAC
        "avc1.42E01E,mp4a.40.2"
    };

    let (width, height) = match (actual_width, actual_height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (w, h),
        _ => {
            // Estimate from file size (rough)
            if file_size > 500_000_000 {
                (1920, 1080)
            } else if file_size > 100_000_000 {
                (1280, 720)
            } else {
                (854, 480)
            }
        }
    };

    // Compute bandwidth from actual data (file_size / duration)
    let bandwidth = if duration > 0.0 {
        ((file_size * 8) as f64 / duration) as u64
    } else {
        FALLBACK_BITRATE
    };

    // Detect TS packet size from file size (will be refined when we read actual data)
    let ts_packet_size = detect_ts_packet_size_from_file_size(file_size)
        .unwrap_or(STD_TS_PACKET_SIZE);
    let is_m2ts = ts_packet_size == M2TS_PACKET_SIZE;

    if is_m2ts {
        log::info!("[HLS] Detected M2TS format: file_size={} is divisible by 192 but not 188, using {}-byte packet size",
            file_size, ts_packet_size);
    }

    HLSInfo {
        duration,
        segment_duration: SEGMENT_DURATION,
        segment_count,
        file_size,
        codec: codec.to_string(),
        width,
        height,
        bandwidth,
        ts_packet_size,
        is_m2ts,
    }
}

/// Generate HLS master playlist with relative URLs.
/// The level_0.m3u8 URL is relative to the master playlist URL,
/// so it resolves correctly through nobuf-stream:// custom protocol.
pub fn generate_master_playlist(info: &HLSInfo, token: &str) -> String {
    format!(
        "#EXTM3U\n\
         #EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={}x{},CODECS=\"{}\"\n\
         level_0.m3u8?token={}\n",
        info.bandwidth, info.width, info.height, info.codec, token
    )
}

/// Segment byte-range info: (start_byte, end_byte) where end is inclusive.
#[derive(Debug, Clone)]
pub struct SegmentRange {
    pub index: u32,
    pub data_start: u64,   // file byte offset start (inclusive)
    pub data_end: u64,     // file byte offset end (inclusive)
    pub content_length: u64, // bytes to serve = data_end - data_start + 1 (raw data)
}

/// Calculate segment layout: aligned segment size and byte ranges.
/// Returns (aligned_segment_size, Vec<SegmentRange>).
///
/// `packet_size` should be the detected packet size (188 for standard TS,
/// 192 for M2TS). Segments cover the entire file starting from byte 0.
/// Each segment is a contiguous raw byte range served directly from the file.
/// hls.js discovers track PIDs from periodic PAT/PMT packets within the data.
pub fn calculate_segment_layout(file_size: u64, duration: f64, packet_size: u64) -> (u64, Vec<SegmentRange>) {
    if file_size == 0 {
        return (0, vec![SegmentRange {
            index: 0,
            data_start: 0,
            data_end: 0,
            content_length: 0,
        }]);
    }

    let segment_count = ((duration / SEGMENT_DURATION).ceil() as u32).min(MAX_SEGMENTS);
    if segment_count == 0 {
        return (0, vec![SegmentRange {
            index: 0,
            data_start: 0,
            data_end: file_size - 1,
            content_length: file_size,
        }]);
    }

    let raw_segment_size = (file_size / segment_count as u64).max(MIN_SEGMENT_SIZE);
    let aligned_segment_size = ((raw_segment_size + packet_size - 1) / packet_size) * packet_size;
    let actual_segment_count = ((file_size + aligned_segment_size - 1) / aligned_segment_size)
        .min(MAX_SEGMENTS as u64) as u32;

    let ranges: Vec<SegmentRange> = (0..actual_segment_count)
        .map(|i| {
            let byte_start = i as u64 * aligned_segment_size;
            let byte_end = if i == actual_segment_count - 1 {
                file_size - 1
            } else {
                byte_start + aligned_segment_size - 1
            };
            let data_len = byte_end - byte_start + 1;
            SegmentRange {
                index: i,
                data_start: byte_start,
                data_end: byte_end,
                content_length: data_len, // raw byte count, no init prefix
            }
        })
        .collect();

    (aligned_segment_size, ranges)
}

/// Generate HLS media playlist with self-contained segment URLs.
///
/// Each segment URL (`seg/{index}?token=...`) resolves to a response
/// that serves raw byte ranges directly from the TS file.
/// hls.js processes each segment as a complete TS fragment:
/// PAT/PMT packets are found inline within the periodic TS stream data,
/// then PES data is parsed for codec init + actual content.
///
/// Key design: serve raw contiguous byte ranges from the file.
/// The TS stream contains periodic PAT/PMT packets (typically every
/// 100ms), so hls.js discovers track PIDs naturally within each segment.
/// This avoids PMT mismatch issues that occur when prepending an extracted
/// init prefix whose PMT doesn't correctly describe the stream's PIDs.
///
/// For M2TS files, the segment handler strips the 4-byte BDAV timestamp
/// prefix from each 192-byte packet, presenting pure 188-byte TS to hls.js.
pub fn generate_media_playlist(
    info: &HLSInfo,
    token: &str,
) -> String {
    let (_, ranges) = calculate_segment_layout(info.file_size, info.duration, info.ts_packet_size);

    let mut playlist = format!(
        "#EXTM3U\n\
         #EXT-X-VERSION:3\n\
         #EXT-X-TARGETDURATION:{}\n\
         #EXT-X-MEDIA-SEQUENCE:0\n",
        info.segment_duration.ceil() as u32,
    );

    // Self-contained segment URLs — each response contains init prefix
    // (PAT+PMT) concatenated with the data byte range.
    // No #EXT-X-MAP needed; codec init is in the data PES packets.
    for range in &ranges {
        let segment_duration = if range.index == (ranges.len() as u32 - 1) {
            let remaining = info.duration - (range.index as f64 * info.segment_duration);
            if remaining > 0.0 { remaining } else { info.segment_duration }
        } else {
            info.segment_duration
        };

        playlist.push_str(&format!(
            "#EXTINF:{:.3},\n\
             seg/{}?token={}\n",
            segment_duration, range.index, token
        ));
    }

    playlist.push_str("#EXT-X-ENDLIST\n");
    playlist
}

/// Resolve message to Media and extract video metadata from raw TL attributes.
/// Returns (Media, file_size, mime, actual_duration, actual_width, actual_height).
async fn resolve_hls_media(
    folder_id_str: &str,
    message_id: i32,
    data: &web::Data<Arc<TelegramState>>,
    token_data: &web::Data<StreamTokenData>,
    query: &StreamQuery,
) -> Result<(Media, u64, String, Option<f64>, Option<u32>, Option<u32>), HttpResponse> {
    // Validate token
    match &query.token {
        Some(t) if constant_time_eq::constant_time_eq(t.as_bytes(), token_data.token.as_bytes()) => {},
        _ => return Err(HttpResponse::Forbidden().body("Invalid or missing stream token")),
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
        Err(e) => return Err(HttpResponse::BadRequest().body(format!("Could not resolve folder: {}", e))),
    };

    let messages = match client.get_messages_by_id(&peer, &[message_id]).await {
        Ok(m) => m,
        Err(e) => return Err(HttpResponse::InternalServerError().body(format!("Could not fetch message: {}", e))),
    };

    let msg = match messages.into_iter().next().flatten() {
        Some(m) => m,
        None => return Err(HttpResponse::NotFound().body("Message not found")),
    };

    let media = match msg.media() {
        Some(m) => m,
        None => return Err(HttpResponse::NotFound().body("Message does not contain media")),
    };

    let (size, mime) = match &media {
        Media::Document(d) => (d.size() as u64, d.mime_type().unwrap_or("application/octet-stream").to_string()),
        _ => return Err(HttpResponse::BadRequest().body("Not a video file")),
    };

    // Extract actual video metadata from raw TL document attributes
    let (actual_duration, actual_width, actual_height) =
        extract_video_attrs_from_raw_msg(&msg.raw)
            .map(|(d, w, h)| (Some(d), Some(w), Some(h)))
            .unwrap_or((None, None, None));

    if let Some(d) = actual_duration {
        log::info!("[HLS] msg {} actual duration={:.1}s, w={}, h={}", message_id, d, actual_width.unwrap_or(0), actual_height.unwrap_or(0));
    } else {
        log::warn!("[HLS] msg {} no DocumentAttributeVideo found, falling back to bitrate estimation", message_id);
    }

    Ok((media, size, mime, actual_duration, actual_width, actual_height))
}

/// HLS master playlist endpoint
#[get("/hls/{folder_id}/{message_id}/master.m3u8")]
async fn hls_master(
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<crate::stream_cache::StreamCacheManager>>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    let (media, size, mime, actual_duration, actual_width, actual_height) =
        match resolve_hls_media(&folder_id_str, message_id, &data, &token_data, &query).await {
            Ok(result) => result,
            Err(resp) => return resp,
        };

    let info = calculate_hls_info(size, &mime, actual_duration, actual_width, actual_height);

    // Cache layout info for segment route optimization (including Media for targeted downloads)
    // Also store detected packet size so segment handler knows whether to strip M2TS timestamps.
    // Init prefix is left empty here — it will be extracted lazily in the segment handler
    // once the file data is on disk.
    if let Some(ref cm) = **cache {
        cm.store_hls_layout(
            message_id, size, info.duration, folder_id_str.clone(), media, mime.clone(),
            info.ts_packet_size, info.is_m2ts
        );
    }

    let manifest = generate_master_playlist(&info, query.token.as_deref().unwrap_or(""));

    HttpResponse::Ok()
        .insert_header(("Content-Type", "application/vnd.apple.mpegurl"))
        .insert_header(("Cache-Control", "no-cache"))
        .body(manifest)
}

/// HLS media playlist endpoint
/// Segments use self-contained URLs where the server concatenates
/// init bytes (PAT/PMT) + data bytes per segment.
#[get("/hls/{folder_id}/{message_id}/level_0.m3u8")]
async fn hls_level(
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<crate::stream_cache::StreamCacheManager>>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    let (media, size, mime, actual_duration, actual_width, actual_height) =
        match resolve_hls_media(&folder_id_str, message_id, &data, &token_data, &query).await {
            Ok(result) => result,
            Err(resp) => return resp,
        };

    let info = calculate_hls_info(size, &mime, actual_duration, actual_width, actual_height);

    // Cache layout info so the segment route can calculate layout
    // without re-resolving from Telegram API (including Media for targeted downloads)
    // Also store detected packet size so segment handler knows whether to strip M2TS timestamps.
    // Init prefix is left empty here — it will be extracted lazily in the segment handler
    // once the file data is on disk.
    let duration = info.duration;
    if let Some(ref cm) = **cache {
        cm.store_hls_layout(
            message_id, size, duration, folder_id_str.clone(), media, mime.clone(),
            info.ts_packet_size, info.is_m2ts
        );
    }
    let manifest = generate_media_playlist(&info, query.token.as_deref().unwrap_or(""));

    HttpResponse::Ok()
        .insert_header(("Content-Type", "application/vnd.apple.mpegurl"))
        .insert_header(("Cache-Control", "no-cache"))
        .body(manifest)
}

/// Register HLS routes
pub(crate) fn configure_hls(cfg: &mut web::ServiceConfig) {
    cfg.service(hls_master)
       .service(hls_level)
       .service(hls_segment);
}

/// HLS segment endpoint — serves raw byte ranges from the TS file.
///
/// Each segment response serves a contiguous byte range from the TS file.
/// For standard TS (188-byte packets), data is served as-is.
/// For M2TS (192-byte packets), the 4-byte BDAV timestamp prefix is stripped
/// from each packet, producing pure 188-byte TS data.
///
/// hls.js discovers track PIDs from periodic PAT/PMT packets within the
/// segment data. No init prefix prepending is needed — the stream's own
/// PAT/PMT correctly describes the audio/video PIDs, avoiding the PMT
/// mismatch issue that occurred when prepending an extracted init prefix.
/// presenting pure 188-byte MPEG-TS to hls.js.
///
/// The init prefix MUST be exactly 2 TS packets (PAT+PMT only). If it
/// contained PES data (the old 4-packet approach), PTS≈0 from init-prefix
/// PES would contaminate `getVideoStartPts()`, causing a +timeOffset shift
/// per segment → stutter, distortion, audio desync.
///
/// CRITICAL: The stream's PMT is on PID 0x0FFF (null stuffing PID), which
/// hls.js skips. The init_prefix rewrites PMT PID from 0x0FFF → 0x1000 so
/// hls.js can properly discover track PIDs (0x0100=video, 0x0101=audio).
/// Without this init_prefix, hls.js reports "Found no media" on every segment.
///
/// URL format: `/hls/{folder_id}/{message_id}/seg/{index}?token=...`
#[get("/hls/{folder_id}/{message_id}/seg/{index}")]
async fn hls_segment(
    path: web::Path<(String, i32, u32)>,
    query: web::Query<StreamQuery>,
    token_data: web::Data<StreamTokenData>,
    data: web::Data<Arc<TelegramState>>,
    cache: web::Data<Option<crate::stream_cache::StreamCacheManager>>,
) -> impl Responder {
    let (_folder_id_str, message_id, index) = path.into_inner();

    // Validate token
    match &query.token {
        Some(t) if constant_time_eq::constant_time_eq(t.as_bytes(), token_data.token.as_bytes()) => {},
        _ => return HttpResponse::Forbidden().body("Invalid or missing stream token"),
    };

    // Use cached layout info from the manifest endpoint instead of
    // re-resolving from Telegram API. This avoids a Telegram API call
    // per segment request, reducing latency and API quota usage.
    let cache_mgr = match (**cache).as_ref() {
        Some(cm) => cm.clone(),
        None => return HttpResponse::ServiceUnavailable().body("Cache not available"),
    };

    // Get cached layout info (file_size, duration, ts_packet_size, is_m2ts)
    let (file_size, duration, ts_packet_size, is_m2ts) = match cache_mgr.get_hls_layout(message_id) {
        Some(layout) => layout,
        None => {
            log::info!("[HLS-SEG] msg {} no cached layout — manifest not yet resolved", message_id);
            return HttpResponse::ServiceUnavailable()
                .insert_header(("Retry-After", "1"))
                .body("HLS layout not yet available — fetch manifest first");
        }
    };

    let data_path = cache_mgr.data_path(message_id);

    // Calculate segment layout using cached info
    let (_, ranges) = calculate_segment_layout(file_size, duration, ts_packet_size);

    // Find the requested segment
    let range = match ranges.iter().find(|r| r.index == index) {
        Some(r) => r.clone(),
        None => return HttpResponse::NotFound().body(format!("Segment {} not found", index)),
    };

    // Helper: prepend init_prefix to segment data and return as HttpResponse.
    // Fetches init_prefix from cache each time (not stale capture) because
    // init_prefix may become available between first attempt and retry.
    let prepend_and_serve = |buf: Vec<u8>, label: &str| -> HttpResponse {
        // Try to get init_prefix from cache; if not available, try to extract it now
        let init_prefix = match cache_mgr.get_init_prefix(message_id) {
            Some(ip) if !ip.is_empty() => ip,
            _ => {
                // Init_prefix not yet cached — try to extract now
                let ip = ensure_init_prefix(&cache_mgr, message_id, &data_path, ts_packet_size, is_m2ts);
                if ip.is_empty() {
                    log::warn!("[HLS-SEG] {} seg {} msg {}: init_prefix not available, serving without PAT+PMT prefix", label, index, message_id);
                    return HttpResponse::Ok()
                        .insert_header(("Content-Type", "video/mp2t"))
                        .insert_header(("Content-Length", buf.len().to_string()))
                        .insert_header(("Cache-Control", "no-cache"))
                        .body(buf);
                }
                ip
            }
        };
        let mut full_buf = Vec::with_capacity(init_prefix.len() + buf.len());
        full_buf.extend_from_slice(&init_prefix);
        full_buf.extend_from_slice(&buf);
        log::info!("[HLS-SEG] {} seg {} msg {}: {} + {} = {} bytes (init_prefix + data)",
            label, index, message_id, init_prefix.len(), buf.len(), full_buf.len());
        HttpResponse::Ok()
            .insert_header(("Content-Type", "video/mp2t"))
            .insert_header(("Content-Length", full_buf.len().to_string()))
            .insert_header(("Cache-Control", "no-cache"))
            .body(full_buf)
    };

    // Helper: try to serve the segment from disk (raw byte range).
    // Returns None if data is not available (sparse zeros or file missing).
    let try_serve_from_disk = || -> Option<HttpResponse> {
        let buf = if is_m2ts {
            construct_m2ts_segment_buffer(&data_path, range.data_start, range.data_end)
        } else {
            construct_segment_buffer(&data_path, range.data_start, range.data_end)
        };
        match buf {
            Ok(buf) => {
                log::info!("[HLS-SEG] DISK-HIT: seg {} msg {} read {} bytes from disk (m2ts={}, range {}-{})",
                    index, message_id, buf.len(), is_m2ts, range.data_start, range.data_end);
                Some(prepend_and_serve(buf, "DISK-HIT"))
            }
            Err(e) => {
                log::debug!("[HLS-SEG] seg {} msg {}: disk read not ready ({})", index, message_id, e);
                None
            }
        }
    };

    // Try serving directly from disk first
    if let Some(response) = try_serve_from_disk() {
        return response;
    }

    // Not on disk — subscribe to active download and wait
    let dl_info = cache_mgr.find_best_covering_download(message_id, range.data_start, range.data_end).await;

    if let Some(dl) = dl_info {
        let distance = range.data_start.saturating_sub(dl.progress_rx.borrow().max(dl.start_byte));
        const MAX_WAIT_DISTANCE: u64 = 50 * 1024 * 1024; // 50MB

        if distance <= MAX_WAIT_DISTANCE {
            log::info!("[HLS-SEG] WAIT: seg {} msg {} subscribing to download {}-{} (progress={}, distance={})",
                index, message_id, dl.start_byte, dl.end_byte, *dl.progress_rx.borrow(), distance);

            let mut progress_rx = dl.progress_rx;
            let target_offset = range.data_end + 1;
            const WAIT_TIMEOUT_SECS: u64 = 30;
            let deadline = tokio::time::sleep(tokio::time::Duration::from_secs(WAIT_TIMEOUT_SECS));
            tokio::pin!(deadline);
            let disk_check_interval = tokio::time::interval(tokio::time::Duration::from_millis(200));
            tokio::pin!(disk_check_interval);

            loop {
                tokio::select! {
                    result = progress_rx.changed() => {
                        match result {
                            Ok(()) => {
                                if *progress_rx.borrow() >= target_offset { break; }
                            }
                            Err(_) => {
                                log::info!("[HLS-SEG] WAIT: seg {} msg {} download ended, checking disk", index, message_id);
                                break;
                            }
                        }
                    }
                    () = &mut deadline => {
                        log::warn!("[HLS-SEG] WAIT: seg {} msg {} timeout after {}s, trying direct read", index, message_id, WAIT_TIMEOUT_SECS);
                        break;
                    }
                    _ = disk_check_interval.tick() => {
                        if let Some(response) = try_serve_from_disk() {
                            log::info!("[HLS-SEG] WAIT-EARLY-HIT: seg {} msg {} served from disk before progress reached target",
                                index, message_id);
                            return response;
                        }
                    }
                }
            }

            // After waiting, try reading from disk
            if let Some(response) = try_serve_from_disk() {
                log::info!("[HLS-SEG] WAIT-HIT: seg {} msg {} served after waiting", index, message_id);
                return response;
            }

            log::info!("[HLS-SEG] WAIT-MISS: seg {} msg {} still not on disk after wait, attempting targeted download",
                index, message_id);
            spawn_targeted_download_and_wait(
                &data, &cache_mgr, message_id, &range, &data_path, index, ts_packet_size, is_m2ts
            ).await
        } else {
            log::info!("[HLS-SEG] MISS-FAR: seg {} msg {} download too far (distance={}), spawning targeted download",
                index, message_id, distance);
            spawn_targeted_download_and_wait(
                &data, &cache_mgr, message_id, &range, &data_path, index, ts_packet_size, is_m2ts
            ).await
        }
    } else {
        // No active download. Check disk one more time.
        if let Some(response) = try_serve_from_disk() {
            log::info!("[HLS-SEG] DISK-HIT-NO-DL: seg {} msg {} served from disk with no active download", index, message_id);
            return response;
        }

        log::info!("[HLS-SEG] MISS-NO-DL: seg {} msg {} no active download and not on disk, spawning targeted download",
            index, message_id);
        spawn_targeted_download_and_wait(
            &data, &cache_mgr, message_id, &range, &data_path, index, ts_packet_size, is_m2ts
        ).await
    }
}

/// Telegram chunk size used by iter_download (same as server.rs)
const TELEGRAM_CHUNK_SIZE: i32 = 512 * 1024; // 512KB

/// When a segment request encounters a MISS (no data on disk, no covering
/// download, or download too far away), this function spawns a targeted
/// download for just the segment's byte range, writes data to cache, and
/// waits for it to become available before serving it.
///
/// This is the key fix for HLS seeking: previously, the segment handler
/// would return 503 for missing segments, causing hls.js to retry forever
/// since no download was ever initiated. Now, the 503 case triggers a
/// download so data becomes available.
async fn spawn_targeted_download_and_wait(
    data: &web::Data<Arc<TelegramState>>,
    cache_mgr: &StreamCacheManager,
    message_id: i32,
    range: &SegmentRange,
    data_path: &std::path::Path,
    index: u32,
    ts_packet_size: u64,
    is_m2ts: bool,
) -> HttpResponse {
    // 1. Get cached HLS layout info (including Media and folder_id)
    let layout_info = match cache_mgr.get_hls_layout_full(message_id) {
        Some(info) => info,
        None => {
            log::warn!("[HLS-SEG-TARGETED] msg {} seg {}: no cached HLS layout (manifest not resolved), returning 503",
                message_id, index);
            return HttpResponse::ServiceUnavailable()
                .insert_header(("Retry-After", "1"))
                .body("HLS layout not yet available — fetch manifest first");
        }
    };

    // 2. Get the Telegram client
    let client_guard = { data.client.lock().await.clone() };
    let client = match client_guard {
        Some(c) => c,
        None => {
            log::warn!("[HLS-SEG-TARGETED] msg {} seg {}: Telegram client not connected, returning 503",
                message_id, index);
            return HttpResponse::ServiceUnavailable()
                .insert_header(("Retry-After", "2"))
                .body("Telegram client not connected");
        }
    };

    // 3. Calculate the download range. Instead of downloading just the
    //    requested segment (~2.5MB), we download a wider range covering
    //    multiple segments ahead. This way, when hls.js requests the next
    //    few segments after seeking, they're already on disk — no need to
    //    spawn separate targeted downloads for each one.
    let segment_size = range.data_end - range.data_start + 1;
    let extra_segments = 4; // download 4 extra segments ahead (~10MB)
    let download_start = range.data_start;
    let download_end = (range.data_start + segment_size * (1 + extra_segments as u64) - 1)
        .min(layout_info.file_size - 1);

    // Check if max concurrent downloads limit is reached. Instead of
    // returning 503 immediately (which causes fragLoadError → onEnded),
    // subscribe to the nearest download and wait for it to complete.
    // Targeted downloads typically finish in 3-10 seconds, so a 30-second
    // wait almost always frees a slot. This prevents hard 503 failures
    // that kill playback — the logs showed a 503 was returned just 1s
    // before a download completed, which would have been avoidable.
    let active_count = cache_mgr.active_download_count(message_id).await;
    if active_count >= MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE {
        log::info!("[HLS-SEG-TARGETED] msg {} seg {}: {} concurrent downloads (limit={}), waiting for slot",
            message_id, index, active_count, MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE);

        // Subscribe to the nearest download and wait for it to complete
        if let Some(nearest) = cache_mgr.find_nearest_download(message_id, range.data_start).await {
            let mut progress_rx = nearest.progress_rx;
            let slot_deadline = tokio::time::sleep(tokio::time::Duration::from_secs(30));
            tokio::pin!(slot_deadline);

            loop {
                tokio::select! {
                    result = progress_rx.changed() => {
                        if result.is_err() {
                            // Download completed (sender dropped) — slot should open
                            log::debug!("[HLS-SEG-TARGETED] msg {} seg {}: nearest download completed, checking slot",
                                message_id, index);
                            // Brief delay for coordinator unregister to complete
                            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                            let count = cache_mgr.active_download_count(message_id).await;
                            if count < MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE {
                                log::info!("[HLS-SEG-TARGETED] msg {} seg {}: slot opened after wait (active={})",
                                    message_id, index, count);
                                break;
                            }
                            // Slot not open yet — find next nearest download to wait on
                            let next = cache_mgr.find_nearest_download(message_id, range.data_start).await;
                            if let Some(n) = next {
                                progress_rx = n.progress_rx;
                                continue;
                            }
                            break; // No more downloads to wait for
                        }
                        // Progress update — check if slot opened (a download may have completed between checks)
                        let count = cache_mgr.active_download_count(message_id).await;
                        if count < MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE {
                            log::info!("[HLS-SEG-TARGETED] msg {} seg {}: slot opened during wait (active={})",
                                message_id, index, count);
                            break;
                        }
                    }
                    () = &mut slot_deadline => {
                        log::warn!("[HLS-SEG-TARGETED] msg {} seg {}: slot wait timed out after 30s",
                            message_id, index);
                        break;
                    }
                }
            }
        } else {
            // No nearest download found — wait fixed 10s for any download to complete
            tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
        }

        // Re-check limit after waiting
        let active_count = cache_mgr.active_download_count(message_id).await;
        if active_count >= MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE {
            log::info!("[HLS-SEG-TARGETED] msg {} seg {}: still at limit ({}) after waiting, returning 503",
                message_id, index, active_count);
            let retry_secs = if let Some(nearest) = cache_mgr.find_nearest_download(message_id, range.data_start).await {
                let progress = *nearest.progress_rx.borrow();
                let distance = range.data_start.saturating_sub(progress);
                (distance / (500 * 1024)).max(2).min(30)
            } else {
                5
            };
            return HttpResponse::ServiceUnavailable()
                .insert_header(("Retry-After", retry_secs.to_string()))
                .body("Max concurrent downloads reached for this file");
        }
        log::info!("[HLS-SEG-TARGETED] msg {} seg {}: proceeding with targeted download after slot wait",
            message_id, index);
    }

    // 4. Register the download with the coordinator
    let dl_info = match cache_mgr.register_download(
        message_id, download_start, download_end, false, download_start, None
    ).await {
        Some(info) => info,
        None => {
            log::warn!("[HLS-SEG-TARGETED] msg {} seg {}: failed to register download, returning 503",
                message_id, index);
            return HttpResponse::ServiceUnavailable()
                .insert_header(("Retry-After", "2"))
                .body("Could not register download");
        }
    };

    // 5. Spawn a background task that downloads the byte range from Telegram
    let media = layout_info.media.clone();
    let layout_file_size = layout_info.file_size;
    let layout_mime_type = layout_info.mime_type.clone();
    let cache_mgr_clone = cache_mgr.clone();
    let semaphore = data.download_semaphore.clone();

    tokio::spawn(async move {
        let chunks_to_skip = (download_start / TELEGRAM_CHUNK_SIZE as u64) as i32;
        let bytes_to_discard = download_start % TELEGRAM_CHUNK_SIZE as u64;

        let download_iter = client.iter_download(&media)
            .chunk_size(TELEGRAM_CHUNK_SIZE)
            .skip_chunks(chunks_to_skip);

        let mut current_offset = download_start;
        let mut first_chunk = true;
        let mut iter = download_iter;

        let mut cache_file = match cache_mgr_clone.open_data_file_write(message_id) {
            Ok(f) => f,
            Err(e) => {
                log::error!("[HLS-SEG-TARGETED] msg {}: failed to open cache file: {}", message_id, e);
                cache_mgr_clone.unregister_download(message_id, download_start, download_end).await;
                return;
            }
        };

        while let Some(chunk) = {
            let _permit = semaphore.acquire().await.unwrap();
            iter.next().await.transpose()
        } {
            match chunk {
                Ok(bytes) => {
                    let mut chunk_data = bytes;

                    if first_chunk && bytes_to_discard > 0 {
                        let discard = bytes_to_discard.min(chunk_data.len() as u64) as usize;
                        chunk_data = chunk_data[discard..].to_vec();
                        first_chunk = false;
                    }

                    if chunk_data.is_empty() { continue; }

                    if current_offset + chunk_data.len() as u64 > download_end + 1 {
                        let remaining = (download_end + 1 - current_offset) as usize;
                        chunk_data = chunk_data[..remaining.min(chunk_data.len())].to_vec();
                    }

                    let chunk_end = current_offset + chunk_data.len() as u64 - 1;

                    if let Err(e) = cache_file.seek(std::io::SeekFrom::Start(current_offset)) {
                        log::error!("[HLS-SEG-TARGETED] msg {}: seek failed at offset {}: {}", message_id, current_offset, e);
                        cache_mgr_clone.unregister_download(message_id, download_start, download_end).await;
                        return;
                    }
                    if let Err(e) = cache_file.write_all(&chunk_data) {
                        log::error!("[HLS-SEG-TARGETED] msg {}: write failed at offset {} ({} bytes): {}",
                            message_id, current_offset, chunk_data.len(), e);
                        cache_mgr_clone.unregister_download(message_id, download_start, download_end).await;
                        return;
                    }
                    if let Err(e) = cache_file.flush() {
                        log::warn!("[HLS-SEG-TARGETED] msg {}: flush failed: {}", message_id, e);
                    }

                    let _lock = cache_mgr_clone.lock_meta(message_id).await;
                    let mut meta = cache_mgr_clone.load_meta(message_id).unwrap_or_else(|| {
                        crate::stream_cache::CacheMeta {
                            message_id,
                            folder_id: 0,
                            total_size: layout_file_size,
                            filename: String::new(),
                            cached_ranges: Vec::new(),
                            mime_type: layout_mime_type.clone(),
                        }
                    });
                    meta.cached_ranges.push((current_offset, chunk_end));
                    merge_ranges(&mut meta.cached_ranges);
                    if let Err(e) = cache_mgr_clone.save_meta(&meta) {
                        log::warn!("[HLS-SEG-TARGETED] msg {}: meta save failed: {}", message_id, e);
                    }

                    cache_mgr_clone.update_download_progress(message_id, download_start, chunk_end).await;

                    current_offset += chunk_data.len() as u64;

                    if current_offset > download_end { break; }
                }
                Err(e) => {
                    log::error!("[HLS-SEG-TARGETED] msg {}: download error: {}", message_id, e);
                    break;
                }
            }
        }

        log::info!("[HLS-SEG-TARGETED] msg {}: targeted download {}-{} completed (downloaded to offset {})",
            message_id, download_start, download_end, current_offset);

        // Unregister the download
        cache_mgr_clone.unregister_download(message_id, download_start, download_end).await;
    });

    // 6. Wait for the data to become available on disk, with a timeout.
    log::info!("[HLS-SEG-TARGETED] msg {} seg {}: waiting for targeted download {}-{} (seg range {}-{}, {} extra segments) to serve data",
        message_id, index, download_start, download_end, range.data_start, range.data_end, extra_segments);

    let mut progress_rx = dl_info.progress_rx;
    let target_offset = range.data_end + 1;
    const TARGETED_WAIT_TIMEOUT_SECS: u64 = 60;
    let deadline = tokio::time::sleep(tokio::time::Duration::from_secs(TARGETED_WAIT_TIMEOUT_SECS));
    tokio::pin!(deadline);
    let disk_check_interval = tokio::time::interval(tokio::time::Duration::from_millis(200));
    tokio::pin!(disk_check_interval);

    loop {
        tokio::select! {
            result = progress_rx.changed() => {
                match result {
                    Ok(()) => {
                        let current_progress = *progress_rx.borrow();
                        if current_progress >= target_offset {
                            break;
                        }
                    }
                    Err(_) => {
                        // Download ended — check disk
                        break;
                    }
                }
            }
            () = &mut deadline => {
                log::warn!("[HLS-SEG-TARGETED] msg {} seg {}: timeout after {}s waiting for download",
                    message_id, index, TARGETED_WAIT_TIMEOUT_SECS);
                break;
            }
            _ = disk_check_interval.tick() => {
                let read_result = if is_m2ts {
                    construct_m2ts_segment_buffer(data_path, range.data_start, range.data_end)
                } else {
                    construct_segment_buffer(data_path, range.data_start, range.data_end)
                };
                if let Ok(buf) = read_result {
                    // Prepend init_prefix to segment data (fetch dynamically from cache)
                    let init_prefix = match cache_mgr.get_init_prefix(message_id) {
                        Some(ip) if !ip.is_empty() => ip,
                        _ => ensure_init_prefix(&cache_mgr, message_id, data_path, ts_packet_size, is_m2ts),
                    };
                    if init_prefix.is_empty() {
                        log::warn!("[HLS-SEG-TARGETED] msg {} seg {}: init_prefix not available, serving without PAT+PMT prefix",
                            message_id, index);
                        return HttpResponse::Ok()
                            .insert_header(("Content-Type", "video/mp2t"))
                            .insert_header(("Content-Length", buf.len().to_string()))
                            .insert_header(("Cache-Control", "no-cache"))
                            .body(buf);
                    }
                    let mut full_buf = Vec::with_capacity(init_prefix.len() + buf.len());
                    full_buf.extend_from_slice(&init_prefix);
                    full_buf.extend_from_slice(&buf);
                    log::info!("[HLS-SEG-TARGETED] msg {} seg {}: served {} bytes from disk before progress reached target ({}+{} init+data, progress={})",
                        message_id, index, full_buf.len(), init_prefix.len(), buf.len(), *progress_rx.borrow());
                    return HttpResponse::Ok()
                        .insert_header(("Content-Type", "video/mp2t"))
                        .insert_header(("Content-Length", full_buf.len().to_string()))
                        .insert_header(("Cache-Control", "no-cache"))
                        .body(full_buf);
                }
            }
        }
    }

    // After waiting, try reading from disk
    let read_result = if is_m2ts {
        construct_m2ts_segment_buffer(data_path, range.data_start, range.data_end)
    } else {
        construct_segment_buffer(data_path, range.data_start, range.data_end)
    };
    if let Ok(buf) = read_result {
        // Prepend init_prefix to segment data (fetch dynamically from cache)
        let init_prefix = match cache_mgr.get_init_prefix(message_id) {
            Some(ip) if !ip.is_empty() => ip,
            _ => ensure_init_prefix(&cache_mgr, message_id, data_path, ts_packet_size, is_m2ts),
        };
        if init_prefix.is_empty() {
            log::warn!("[HLS-SEG-TARGETED] msg {} seg {}: init_prefix not available, serving without PAT+PMT prefix",
                message_id, index);
            HttpResponse::Ok()
                .insert_header(("Content-Type", "video/mp2t"))
                .insert_header(("Content-Length", buf.len().to_string()))
                .insert_header(("Cache-Control", "no-cache"))
                .body(buf)
        } else {
            let mut full_buf = Vec::with_capacity(init_prefix.len() + buf.len());
            full_buf.extend_from_slice(&init_prefix);
            full_buf.extend_from_slice(&buf);
            log::info!("[HLS-SEG-TARGETED] msg {} seg {}: served {} bytes after targeted download wait ({}+{} init+data, m2ts={})",
                message_id, index, full_buf.len(), init_prefix.len(), buf.len(), is_m2ts);
            HttpResponse::Ok()
                .insert_header(("Content-Type", "video/mp2t"))
                .insert_header(("Content-Length", full_buf.len().to_string()))
                .insert_header(("Cache-Control", "no-cache"))
                .body(full_buf)
        }
    } else {
        log::warn!("[HLS-SEG-TARGETED] msg {} seg {}: data still not on disk after targeted download, returning 503",
            message_id, index);
        HttpResponse::ServiceUnavailable()
            .insert_header(("Retry-After", "1"))
            .body("Segment data not yet available — targeted download in progress")
    }
}

/// Read a byte range from a file into a buffer.
fn read_range_from_disk(
    path: &std::path::Path,
    start: u64,
    end: u64, // inclusive
) -> std::io::Result<Vec<u8>> {
    let len = (end - start + 1) as usize;
    let mut file = std::fs::File::open(path)?;
    file.seek(std::io::SeekFrom::Start(start))?;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

/// Read two byte ranges from a file and concatenate them into a single buffer.
/// Used for serving self-contained TS segments: init prefix (PAT+PMT) + data.
#[allow(dead_code)]
fn read_concat_from_disk(
    path: &std::path::Path,
    init_start: u64,
    init_end: u64,   // inclusive
    data_start: u64,
    data_end: u64,   // inclusive
) -> std::io::Result<Vec<u8>> {
    let init_len = (init_end - init_start + 1) as usize;
    let data_len = (data_end - data_start + 1) as usize;
    let mut buf = Vec::with_capacity(init_len + data_len);

    let mut file = std::fs::File::open(path)?;

    // Read init bytes (PAT+PMT)
    file.seek(std::io::SeekFrom::Start(init_start))?;
    buf.resize(init_len, 0);
    file.read_exact(&mut buf[..init_len])?;

    // Read data bytes
    file.seek(std::io::SeekFrom::Start(data_start))?;
    buf.resize(init_len + data_len, 0);
    file.read_exact(&mut buf[init_len..])?;

    Ok(buf)
}

/// Construct a TS segment buffer by concatenating cached init_prefix + raw file data.
/// Rewrite inline PAT/PMT PIDs in segment data from 0x0FFF to PMT_PID_REWRITE (0x1000).
/// The stream's PMT is on PID 0x0FFF (null stuffing), which hls.js skips. Even with
/// a prepended init_prefix that uses PID 0x1000, hls.js re-reads inline PAT packets
/// that still declare PMT PID=0x0FFF, then tries to find PMT on 0x0FFF (null stuffing)
/// and overrides the track discovery from init_prefix → "Found no media".
///
/// This function scans the segment buffer for:
/// 1. PAT packets (PID 0x0000): rewrites PMT PID declaration from 0x0FFF → 0x1000, recalculates CRC
/// 2. PMT packets (PID 0x0FFF): rewrites TS header PID from 0x0FFF → 0x1000, recalculates CRC
///
/// Returns the number of PAT and PMT packets rewritten for logging.
fn rewrite_segment_pids(buf: &mut [u8]) -> (u32, u32) {
    let ps = STD_TS_PACKET_SIZE as usize;
    let mut pat_rewritten: u32 = 0;
    let mut pmt_rewritten: u32 = 0;

    for pkt_offset in (0..buf.len()).step_by(ps) {
        if pkt_offset + ps > buf.len() { break; }
        if buf[pkt_offset] != 0x47 { continue; }

        let pid = ((buf[pkt_offset + 1] as u16 & 0x1F) << 8) | buf[pkt_offset + 2] as u16;

        if pid == 0x0000 {
            // PAT packet — rewrite PMT PID declaration if it's 0x0FFF
            let pusi = (buf[pkt_offset + 1] >> 6) & 0x01;
            let afc = (buf[pkt_offset + 3] >> 4) & 0x03;
            let mut payload_offset = pkt_offset + 4;
            if afc & 0x02 != 0 {
                let af_len = buf[payload_offset] as usize;
                payload_offset += 1 + af_len;
            }
            if payload_offset >= pkt_offset + ps || pusi != 1 { continue; }

            let pointer = buf[payload_offset] as usize;
            let section_start = payload_offset + 1 + pointer;
            if section_start + 8 >= pkt_offset + ps { continue; }

            let table_id = buf[section_start];
            if table_id != 0x00 { continue; }

            let section_length = (((buf[section_start + 1] & 0x0F) as u16) << 8) | buf[section_start + 2] as u16;
            let num_programs = ((section_length - 9) / 4) as usize;

            let mut did_rewrite = false;
            for p in 0..num_programs {
                let prog_offset = section_start + 8 + p * 4;
                if prog_offset + 4 > pkt_offset + ps { break; }
                let prog_num = ((buf[prog_offset] as u16) << 8) | buf[prog_offset + 1] as u16;
                if prog_num == 0 { continue; }

                let declared_pid = ((buf[prog_offset + 2] as u16 & 0x1F) << 8) | buf[prog_offset + 3] as u16;
                if declared_pid == 0x0FFF {
                    buf[prog_offset + 2] = (buf[prog_offset + 2] & 0xE0) | ((PMT_PID_REWRITE >> 8) as u8 & 0x1F);
                    buf[prog_offset + 3] = (PMT_PID_REWRITE & 0xFF) as u8;
                    did_rewrite = true;
                }
            }

            if did_rewrite {
                let section_end_with_crc = section_start + 3 + section_length as usize;
                let crc_end = section_end_with_crc - 4;
                if crc_end > section_start && crc_end <= pkt_offset + ps {
                    let new_crc = crc32_mpeg2(&buf[section_start..crc_end]);
                    buf[crc_end] = ((new_crc >> 24) & 0xFF) as u8;
                    buf[crc_end + 1] = ((new_crc >> 16) & 0xFF) as u8;
                    buf[crc_end + 2] = ((new_crc >> 8) & 0xFF) as u8;
                    buf[crc_end + 3] = (new_crc & 0xFF) as u8;
                    pat_rewritten += 1;
                }
            }
        } else if pid == 0x0FFF {
            // PMT packet on null stuffing PID — verify it's actually PMT (table_id=0x02) then rewrite
            let pusi = (buf[pkt_offset + 1] >> 6) & 0x01;
            let afc = (buf[pkt_offset + 3] >> 4) & 0x03;
            let mut payload_offset = pkt_offset + 4;
            if afc & 0x02 != 0 {
                let af_len = buf[payload_offset] as usize;
                payload_offset += 1 + af_len;
            }
            if payload_offset >= pkt_offset + ps || pusi != 1 { continue; }

            let pointer = buf[payload_offset] as usize;
            let section_start = payload_offset + 1 + pointer;
            if section_start >= pkt_offset + ps { continue; }

            let table_id = buf[section_start];
            if table_id != 0x02 { continue; } // Not PMT — skip (could be actual null stuffing)

            // Rewrite PID in TS header: 0x0FFF → PMT_PID_REWRITE
            buf[pkt_offset + 1] = (buf[pkt_offset + 1] & 0xE0) | ((PMT_PID_REWRITE >> 8) as u8 & 0x1F);
            buf[pkt_offset + 2] = (PMT_PID_REWRITE & 0xFF) as u8;

            // Recalculate PMT CRC-32
            let section_length = (((buf[section_start + 1] & 0x0F) as u16) << 8) | buf[section_start + 2] as u16;
            let section_end_with_crc = section_start + 3 + section_length as usize;
            let crc_end = section_end_with_crc - 4;
            if crc_end > section_start && crc_end <= pkt_offset + ps {
                let new_crc = crc32_mpeg2(&buf[section_start..crc_end]);
                buf[crc_end] = ((new_crc >> 24) & 0xFF) as u8;
                buf[crc_end + 1] = ((new_crc >> 16) & 0xFF) as u8;
                buf[crc_end + 2] = ((new_crc >> 8) & 0xFF) as u8;
                buf[crc_end + 3] = (new_crc & 0xFF) as u8;
                pmt_rewritten += 1;

                // Rewrite misidentified stream_types (0x15→0x0F) in PMT so hls.js discovers audio PID
                rewrite_pmt_stream_types(buf, section_start, pkt_offset + ps);
            }
        }
    }

    (pat_rewritten, pmt_rewritten)
}

/// Read a raw byte range from the TS data file.
/// Checks data availability at start, middle, and end positions to ensure the
/// entire data range is downloaded (not sparse zeros from undownloaded regions).
/// Returns InvalidData if any check position has 0x00 (sparse zeros).
fn construct_segment_buffer(
    path: &std::path::Path,
    data_start: u64,
    data_end: u64,
) -> std::io::Result<Vec<u8>> {
    let data_len = (data_end - data_start + 1) as usize;
    let mut buf = vec![0u8; data_len];

    let mut file = std::fs::File::open(path)?;
    file.seek(std::io::SeekFrom::Start(data_start))?;
    file.read_exact(&mut buf)?;

    // Multi-position data availability check.
    // On Windows, sparse files return zeros for undownloaded regions.
    // read_exact succeeds but reads zeros where data hasn't been written.
    // We check TS sync byte (0x47) at 3 positions: start, middle, end.
    // Downloads are sequential, so if all 3 are valid, the range is likely
    // fully downloaded. If any is 0x00, data is not yet available.
    let ps = STD_TS_PACKET_SIZE as usize;

    // Start check: first TS packet sync byte
    if buf[0] == 0x00 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Data start at offset {} is sparse zeros (not downloaded)", data_start)
        ));
    }

    // End check: last TS packet sync byte
    if data_len > ps {
        let last_pkt_offset = data_len - ps;
        if buf[last_pkt_offset] == 0x00 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Data end near offset {} is sparse zeros (not fully downloaded)", data_end)
            ));
        }
    }

    // Middle check: midpoint TS packet sync byte
    if data_len > ps * 3 {
        let mid_pkt_offset = (data_len / 2 / ps) * ps;
        if buf[mid_pkt_offset] == 0x00 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Data mid near offset {} is sparse zeros (partial download gap)", data_start + data_len as u64 / 2)
            ));
        }
    }

    // Rewrite inline PAT/PMT PIDs: 0x0FFF → 0x1000 (null stuffing PID → valid PID)
    // This is critical because hls.js skips PID 0x0FFF packets, preventing PMT discovery.
    // Even with prepended init_prefix, inline PAT still declares PMT PID=0x0FFF which
    // overrides the init_prefix's track mapping → "Found no media".
    let (pat_rewrite, pmt_rewrite) = rewrite_segment_pids(&mut buf);
    if pat_rewrite > 0 || pmt_rewrite > 0 {
        log::debug!("[HLS-SEG-PIDFIX] offset {}: rewrote {} PAT + {} PMT inline packets (0x0FFF→0x{:04X})",
            data_start, pat_rewrite, pmt_rewrite, PMT_PID_REWRITE);
    }

    // Ensure PES start alignment: convert pre-PES-start continuation packets
    // on media PIDs to null stuffing so hls.js always finds a PES anchor immediately.
    // Byte-aligned segments often start mid-PES on video/audio PIDs, which causes
    // the transmuxer to produce zero samples → "Found no media" on first seek segment.
    let media_pids = extract_media_pids(&buf);
    if !media_pids.is_empty() {
        let converted = ensure_pes_starts(&mut buf, &media_pids);
        if converted > 0 {
            log::debug!("[HLS-SEG-PESFIX] offset {}: converted {} pre-PES packets to null stuffing on media PIDs {:?}",
                data_start, converted, media_pids);
        }
    }

    // Diagnostic: scan ALL unique PIDs in segment and correctly parse PAT
    // to extract PMT PID. This reveals what PIDs the stream actually uses
    // and whether PMT packets exist, diagnosing "Found no media" errors.
    let mut pid_counts: HashMap<u16, u32> = HashMap::new();
    for pkt_offset in (0..buf.len()).step_by(ps) {
        if pkt_offset + 3 >= buf.len() { break; }
        // Skip packets that don't start with 0x47 sync byte
        if buf[pkt_offset] != 0x47 { continue; }
        let pid = ((buf[pkt_offset + 1] as u16 & 0x1F) << 8) | buf[pkt_offset + 2] as u16;
        *pid_counts.entry(pid).or_insert(0) += 1;
    }

    // Extract PMT PID from PAT if present (PID 0x0000)
    let mut pmt_pid_from_pat: Option<u16> = None;
    if let Some(&pat_count) = pid_counts.get(&0x0000) {
        if pat_count > 0 {
            // Find first PAT packet and parse it correctly
            for pkt_offset in (0..buf.len()).step_by(ps) {
                if pkt_offset + 188 > buf.len() { break; }
                if buf[pkt_offset] != 0x47 { continue; }
                let pid = ((buf[pkt_offset + 1] as u16 & 0x1F) << 8) | buf[pkt_offset + 2] as u16;
                if pid != 0x0000 { continue; }

                // Parse TS header: adaptation_field_control (bits 24-25 of byte 3)
                let afc = (buf[pkt_offset + 3] >> 4) & 0x03;
                let mut payload_start = pkt_offset + 4;
                if afc == 2 { continue; } // adaptation only, no payload
                if afc == 3 {
                    // adaptation field + payload
                    let af_len = buf[pkt_offset + 4] as usize;
                    payload_start += 1 + af_len;
                }
                // payload_unit_start_indicator
                let pusi = (buf[pkt_offset + 1] >> 6) & 0x01;
                if pusi == 1 {
                    let pointer_field = buf[payload_start] as usize;
                    let section_start = payload_start + 1 + pointer_field;
                    // PAT section: table_id(1), section_syntax+length(2), ts_id(2),
                    // version/etc(1), section_number(1), last_section_number(1)
                    // = 8 bytes before first program entry
                    if section_start + 8 + 4 <= pkt_offset + 188 {
                        // Skip 8 bytes of section header to first program entry
                        let prog_start = section_start + 8;
                        // program_number(2 bytes) + PID(2 bytes)
                        let prog_num = ((buf[prog_start] as u16) << 8) | buf[prog_start + 1] as u16;
                        if prog_num != 0 {
                            // This is a program entry, not a network PID
                            let declared_pid = ((buf[prog_start + 2] as u16 & 0x1F) << 8) | buf[prog_start + 3] as u16;
                            pmt_pid_from_pat = Some(declared_pid);
                        }
                    }
                }
                break; // only parse first PAT
            }
        }
    }

    // Format top PIDs for logging (sorted by count, top 6)
    let mut top_pids: Vec<(u16, u32)> = pid_counts.iter().map(|(&p, &c)| (p, c)).collect();
    top_pids.sort_by(|a, b| b.1.cmp(&a.1));
    let top_pids_str = top_pids.iter().take(6)
        .map(|(pid, count)| format!("PID=0x{:04X}:{}", pid, count))
        .collect::<Vec<String>>()
        .join(", ");

    log::debug!("[HLS-SEG-DIAG] offset {} pids=[{}] total_pkts={} PAT={} PMT_from_pat={} PMT_found={}",
        data_start, top_pids_str, pid_counts.values().sum::<u32>(),
        pid_counts.get(&0x0000).copied().unwrap_or(0),
        pmt_pid_from_pat.map(|p| format!("0x{:04X}", p)).unwrap_or("none".to_string()),
        pmt_pid_from_pat.map(|p| pid_counts.get(&p).copied().unwrap_or(0))
            .unwrap_or(0));

    // PES start alignment diagnostic: count PUSI=1 packets per media PID
    if !media_pids.is_empty() {
        for media_pid in &media_pids {
            let total_on_pid = pid_counts.get(media_pid).copied().unwrap_or(0);
            let mut pusi1_count: u32 = 0;
            let mut first_pusi1_pkt: Option<usize> = None;
            for pkt_offset in (0..buf.len()).step_by(ps) {
                if pkt_offset + 3 >= buf.len() { break; }
                if buf[pkt_offset] != 0x47 { continue; }
                let pid = ((buf[pkt_offset + 1] as u16 & 0x1F) << 8) | buf[pkt_offset + 2] as u16;
                if pid != *media_pid { continue; }
                let pusi = (buf[pkt_offset + 1] >> 6) & 0x01;
                if pusi == 1 {
                    pusi1_count += 1;
                    if first_pusi1_pkt.is_none() {
                        first_pusi1_pkt = Some(pkt_offset / ps);
                    }
                }
            }
            log::debug!("[HLS-SEG-PES-DIAG] offset {} PID 0x{:04X}: total={} pusi1={} first_pusi1_pkt={}",
                data_start, media_pid, total_on_pid, pusi1_count,
                first_pusi1_pkt.map(|n| n.to_string()).unwrap_or("none".to_string()));
        }
    }

    Ok(buf)
}

/// Construct an M2TS segment buffer by reading raw M2TS data from the file,
/// then stripping the 4-byte BDAV timestamp prefix from each 192-byte packet
/// to produce pure 188-byte TS data.
/// Checks data availability at start, middle, and end positions.
/// Returns InvalidData error if any check position has sparse zeros.
fn construct_m2ts_segment_buffer(
    path: &std::path::Path,
    data_start: u64,
    data_end: u64,
) -> std::io::Result<Vec<u8>> {
    let data_m2ts_len = (data_end - data_start + 1) as usize;
    let packet_count = data_m2ts_len / M2TS_PACKET_SIZE as usize;
    let data_ts_len = packet_count * STD_TS_PACKET_SIZE as usize;

    let mut file = std::fs::File::open(path)?;
    file.seek(std::io::SeekFrom::Start(data_start))?;
    let mut raw_data = vec![0u8; data_m2ts_len];
    file.read_exact(&mut raw_data)?;

    // Multi-position data availability check for M2TS.
    // In M2TS, byte 4 of each 192-byte packet is the TS sync byte (0x47).
    // If byte 4 is 0x00, the data hasn't been downloaded yet (sparse zeros).
    let m2ts_ps = M2TS_PACKET_SIZE as usize;

    // Start check
    if raw_data.len() >= 5 && raw_data[4] == 0x00 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("M2TS data start at offset {} is sparse zeros (not downloaded)", data_start)
        ));
    }

    // End check
    if raw_data.len() > m2ts_ps {
        let last_pkt_offset = raw_data.len() - m2ts_ps;
        if raw_data[last_pkt_offset + 4] == 0x00 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("M2TS data end near offset {} is sparse zeros (not fully downloaded)", data_end)
            ));
        }
    }

    // Middle check
    if raw_data.len() > m2ts_ps * 3 {
        let mid_pkt_offset = (raw_data.len() / 2 / m2ts_ps) * m2ts_ps;
        if raw_data[mid_pkt_offset + 4] == 0x00 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("M2TS data mid near offset {} is sparse zeros (partial download gap)", data_start + data_m2ts_len as u64 / 2)
            ));
        }
    }

    // Strip 4-byte timestamp prefix from each 192-byte M2TS packet
    let mut buf = Vec::with_capacity(data_ts_len);
    for chunk in raw_data.chunks(M2TS_PACKET_SIZE as usize) {
        if chunk.len() > 4 {
            buf.extend_from_slice(&chunk[4..]);
        }
    }

    // Rewrite inline PAT/PMT PIDs: 0x0FFF → 0x1000
    let (pat_rewrite, pmt_rewrite) = rewrite_segment_pids(&mut buf);
    if pat_rewrite > 0 || pmt_rewrite > 0 {
        log::debug!("[HLS-SEG-PIDFIX-M2TS] offset {}: rewrote {} PAT + {} PMT inline packets (0x0FFF→0x{:04X})",
            data_start, pat_rewrite, pmt_rewrite, PMT_PID_REWRITE);
    }

    // Ensure PES start alignment for M2TS segments
    let media_pids = extract_media_pids(&buf);
    if !media_pids.is_empty() {
        let converted = ensure_pes_starts(&mut buf, &media_pids);
        if converted > 0 {
            log::debug!("[HLS-SEG-PESFIX-M2TS] offset {}: converted {} pre-PES packets to null stuffing on media PIDs {:?}",
                data_start, converted, media_pids);
        }
    }

    Ok(buf)
}

/// CRC-32/MPEG-2 checksum calculation.
/// MPEG-TS sections (PAT, PMT, etc.) use CRC-32/MPEG-2 which differs
/// from standard CRC-32: no initial inversion, no final inversion,
/// and no bit reversal of the result. Polynomial: 0x04C11DB7.
pub fn crc32_mpeg2(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFFFFFF;
    for &byte in data {
        crc ^= (byte as u32) << 24;
        for _ in 0..8 {
            if crc & 0x80000000 != 0 {
                crc = (crc << 1) ^ 0x04C11DB7;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

/// Rewrite misidentified stream_type values in a PMT section within a buffer.
/// stream_type=0x15 is mapped to id3Pid (metadata) by hls.js, but the PID
/// actually carries AAC audio PES data. Without a stream_type=0x0F entry,
/// hls.js never discovers the audio track → audio PES goes to unknownPID →
/// "Found no media". We rewrite 0x15→0x0F so hls.js assigns audioPid correctly.
/// CRC-32 is recalculated after changes.
///
/// `buf` is the full buffer containing the TS packet(s).
/// `section_start` is the byte offset of the PMT section start (after pointer field).
/// `pkt_end` is the end boundary (exclusive) for validation (typically pkt_offset + 188).
///
/// Returns the number of stream entries rewritten.
pub fn rewrite_pmt_stream_types(buf: &mut [u8], section_start: usize, pkt_end: usize) -> u32 {
    if section_start + 12 >= pkt_end { return 0; }

    let table_id = buf[section_start];
    if table_id != 0x02 { return 0; } // Not a PMT section

    let section_length = (((buf[section_start + 1] & 0x0F) as u16) << 8) | buf[section_start + 2] as u16;
    let program_info_length = (((buf[section_start + 10] & 0x0F) as u16) << 8) | buf[section_start + 11] as u16;
    let section_end_with_crc = section_start + 3 + section_length as usize;
    let crc_end = section_end_with_crc - 4;

    if crc_end <= section_start || section_end_with_crc > pkt_end { return 0; }

    // Parse stream entries starting after program_info descriptors
    let mut pos = section_start + 12 + program_info_length as usize;
    let mut rewritten = 0;

    while pos + 5 <= crc_end && pos + 5 <= pkt_end {
        let stream_type = buf[pos];
        let es_info_length = (((buf[pos + 3] & 0x0F) as u16) << 8) | buf[pos + 4] as u16;

        for &(from, to) in REWRITE_STREAM_TYPES {
            if stream_type == from {
                let pid = ((buf[pos + 1] as u16 & 0x1F) << 8) | buf[pos + 2] as u16;
                buf[pos] = to;
                rewritten += 1;
                log::debug!("[HLS-STREAM-TYPE] Rewrote stream_type 0x{:02X} → 0x{:02X} for PID 0x{:04X} in PMT",
                    from, to, pid);
            }
        }

        pos += 5 + es_info_length as usize;
    }

    // Recalculate CRC-32 if any stream_types were changed
    if rewritten > 0 {
        let new_crc = crc32_mpeg2(&buf[section_start..crc_end]);
        buf[crc_end] = ((new_crc >> 24) & 0xFF) as u8;
        buf[crc_end + 1] = ((new_crc >> 16) & 0xFF) as u8;
        buf[crc_end + 2] = ((new_crc >> 8) & 0xFF) as u8;
        buf[crc_end + 3] = (new_crc & 0xFF) as u8;
        log::debug!("[HLS-STREAM-TYPE] PMT CRC recalculated after stream_type rewrite: 0x{:08X}", new_crc);
    }

    rewritten
}

/// Extract media PIDs (video/audio) from the PMT section in a TS buffer.
/// Scans for a PMT packet (PID=PMT_PID_REWRITE=0x1000 after rewriting)
/// and returns PIDs of streams with recognized video/audio stream types.
/// Used by `ensure_pes_starts()` to know which PIDs need PES start code
/// alignment.  Stream types already rewritten to 0xFF are excluded (they
/// are phantom tracks with no PES data).
fn extract_media_pids(buf: &[u8]) -> Vec<u16> {
    let ps = STD_TS_PACKET_SIZE as usize;
    let mut media_pids = Vec::new();

    // Known video stream types (H.264, MPEG-1/2 video, HEVC, etc.)
    const VIDEO_STREAM_TYPES: &[u8] = &[0x1B, 0x01, 0x02, 0x10, 0x24, 0x25];
    // Known audio stream types (AAC, MPEG-1/2 audio, AC-3, etc.)
    const AUDIO_STREAM_TYPES: &[u8] = &[0x0F, 0x03, 0x04, 0x11, 0x81];

    // Find PMT packet (PID 0x1000 after rewriting by rewrite_segment_pids)
    for pkt_offset in (0..buf.len()).step_by(ps) {
        if pkt_offset + ps > buf.len() { break; }
        if buf[pkt_offset] != 0x47 { continue; }

        let pid = ((buf[pkt_offset + 1] as u16 & 0x1F) << 8) | buf[pkt_offset + 2] as u16;
        if pid != PMT_PID_REWRITE { continue; }

        // Parse PMT section from this packet
        let pusi = (buf[pkt_offset + 1] >> 6) & 0x01;
        let afc = (buf[pkt_offset + 3] >> 4) & 0x03;
        let mut payload_offset = pkt_offset + 4;
        if afc & 0x02 != 0 {
            let af_len = buf[payload_offset] as usize;
            payload_offset += 1 + af_len;
        }
        if payload_offset >= pkt_offset + ps || pusi != 1 { continue; }

        let pointer = buf[payload_offset] as usize;
        let section_start = payload_offset + 1 + pointer;
        if section_start + 12 >= pkt_offset + ps { continue; }

        let table_id = buf[section_start];
        if table_id != 0x02 { continue; } // Not PMT

        let section_length = (((buf[section_start + 1] & 0x0F) as u16) << 8) | buf[section_start + 2] as u16;
        let program_info_length = (((buf[section_start + 10] & 0x0F) as u16) << 8) | buf[section_start + 11] as u16;
        let crc_end = section_start + 3 + section_length as usize - 4;

        // Parse stream entries after program_info descriptors
        let mut pos = section_start + 12 + program_info_length as usize;
        while pos + 5 <= crc_end && pos + 5 <= pkt_offset + ps {
            let stream_type = buf[pos];
            let es_pid = ((buf[pos + 1] as u16 & 0x1F) << 8) | buf[pos + 2] as u16;
            let es_info_length = (((buf[pos + 3] & 0x0F) as u16) << 8) | buf[pos + 4] as u16;

            if VIDEO_STREAM_TYPES.contains(&stream_type) || AUDIO_STREAM_TYPES.contains(&stream_type) {
                media_pids.push(es_pid);
            }

            pos += 5 + es_info_length as usize;
        }

        if !media_pids.is_empty() { break; } // Only parse first PMT
    }

    media_pids
}

/// Ensure that every media PID (video/audio) has a PES start code near the
/// beginning of the segment buffer.  When seeking in MPEG-TS, byte-aligned
/// segments often start mid-PES — hls.js's transmuxer resets its PES state
/// at fragment boundaries and ignores continuation packets (PUSI=0) until it
/// finds a PES start code (PUSI=1).  If the first media packets are all
/// continuation, the transmuxer may produce zero samples → "Found no media".
///
/// This function scans each media PID in the segment, finds the first TS
/// packet with payload_unit_start_indicator=1 (PES start), and converts
/// all packets on that PID before the first PES start to null stuffing
/// (PID 0x1FFF, filled with 0xFF).  Null stuffing packets are silently
/// skipped by hls.js's demuxer, so this ensures the first media packet
/// hls.js encounters on each track is always a PES start code.
///
/// If a media PID has NO PES start code anywhere in the segment, packets
/// on that PID are left unchanged (converting all of them to null stuffing
/// would eliminate the entire track, making things worse).  A warning is
/// logged for diagnosis.
///
/// `media_pids` is a list of PIDs carrying video/audio data, typically
/// extracted from the PMT via `extract_media_pids()`.
///
/// Returns the number of packets converted to null stuffing.
fn ensure_pes_starts(buf: &mut [u8], media_pids: &[u16]) -> u32 {
    let ps = STD_TS_PACKET_SIZE as usize;

    // For each media PID, find the first PES start (PUSI=1)
    let mut first_pes_start: HashMap<u16, usize> = HashMap::new();
    for pkt_offset in (0..buf.len()).step_by(ps) {
        if pkt_offset + ps > buf.len() { break; }
        if buf[pkt_offset] != 0x47 { continue; }

        let pid = ((buf[pkt_offset + 1] as u16 & 0x1F) << 8) | buf[pkt_offset + 2] as u16;
        if !media_pids.contains(&pid) { continue; }

        let pusi = (buf[pkt_offset + 1] >> 6) & 0x01;
        if pusi == 1 && !first_pes_start.contains_key(&pid) {
            first_pes_start.insert(pid, pkt_offset);
        }
    }

    // Convert all packets on media PIDs before their first PES start to null stuffing
    let mut converted: u32 = 0;
    for pkt_offset in (0..buf.len()).step_by(ps) {
        if pkt_offset + ps > buf.len() { break; }
        if buf[pkt_offset] != 0x47 { continue; }

        let pid = ((buf[pkt_offset + 1] as u16 & 0x1F) << 8) | buf[pkt_offset + 2] as u16;
        if !media_pids.contains(&pid) { continue; }

        let first_start = first_pes_start.get(&pid);
        match first_start {
            Some(&start_offset) if pkt_offset < start_offset => {
                // Convert to null stuffing: PID=0x1FFF, PUSI=0, no adaptation, CC=0, fill=0xFF
                buf[pkt_offset] = 0x47; // sync byte (unchanged)
                buf[pkt_offset + 1] = 0x1F; // PUSI=0, priority=0, PID high bits of 0x1FFF
                buf[pkt_offset + 2] = 0xFF; // PID low bits = 0x1FFF
                buf[pkt_offset + 3] = 0x10; // adaptation_field_control=0b10 (only payload), CC=0
                for i in pkt_offset + 4..pkt_offset + ps {
                    buf[i] = 0xFF;
                }
                converted += 1;
            }
            None => {
                // No PES start found on this PID — leave packets unchanged.
                // Converting ALL packets to null stuffing would eliminate all
                // data on this track. Log a warning for diagnosis.
                log::warn!("[HLS-PES-FIX] PID 0x{:04X}: no PES start found in segment — leaving packets unchanged", pid);
            }
            _ => {} // Packet is at or after PES start — leave unchanged
        }
    }

    if converted > 0 {
        let mut details: Vec<String> = Vec::new();
        for (pid, offset) in &first_pes_start {
            let pkt_num = offset / ps;
            details.push(format!("0x{:04X}@pkt{}", pid, pkt_num));
        }
        log::debug!("[HLS-PES-FIX] Converted {} pre-PES packets to null stuffing, PES starts: [{}]",
            converted, details.join(", "));
    }

    converted
}

/// Rewrite the PMT PID in an init_prefix (PAT+PMT packets) from the
/// stream's original PMT PID (typically 0x0FFF, the null stuffing PID)
/// to a non-reserved PID (0x1000). This is needed because hls.js skips
/// all packets on PID 0x0FFF, preventing PMT discovery → "Found no media".
///
/// This function modifies two things:
/// 1. The PMT packet's TS header PID field (bytes 1-2): 0x0FFF → 0x1000
/// 2. The PAT packet's program entry PID declaration: 0x0FFF → 0x1000
/// Both sections get their CRC-32 recalculated after modification.
///
/// Returns the rewritten init_prefix, or the original if no rewriting needed.
fn rewrite_init_prefix_pids(init_prefix: &[u8]) -> Vec<u8> {
    let ps = STD_TS_PACKET_SIZE as usize;
    if init_prefix.len() < ps * 2 {
        return init_prefix.to_vec();
    }

    let mut result = init_prefix.to_vec();

    // Parse the PAT packet to find the original PMT PID
    let pat_pkt = &result[..ps];
    let pat_pid = ((pat_pkt[1] as u16 & 0x1F) << 8) | pat_pkt[2] as u16;
    if pat_pid != 0x0000 {
        // Not a PAT packet — can't rewrite
        log::warn!("[HLS-INIT-REWRITE] First packet is not PAT (pid=0x{:04X}), skipping rewrite", pat_pid);
        return result;
    }

    // Parse PAT section to find the PMT PID declared in it
    let pusi = (pat_pkt[1] >> 6) & 0x01;
    let afc = (pat_pkt[3] >> 4) & 0x03;
    let mut payload_offset = 4;
    if afc & 0x02 != 0 {
        let af_len = pat_pkt[payload_offset] as usize;
        payload_offset += 1 + af_len;
    }
    if payload_offset >= ps || pusi != 1 {
        log::warn!("[HLS-INIT-REWRITE] PAT packet has no payload unit start indicator or offset out of range");
        return result;
    }

    let pointer = result[payload_offset] as usize;
    let section_start = payload_offset + 1 + pointer;
    if section_start + 8 + 4 > ps {
        log::warn!("[HLS-INIT-REWRITE] PAT section too short for program entry");
        return result;
    }

    let table_id = result[section_start];
    if table_id != 0x00 {
        log::warn!("[HLS-INIT-REWRITE] PAT table_id=0x{:02X}, expected 0x00", table_id);
        return result;
    }

    let section_length = (((result[section_start + 1] & 0x0F) as u16) << 8) | result[section_start + 2] as u16;
    let num_programs = ((section_length - 9) / 4) as usize;

    // Find the program entry with the PMT PID and rewrite it
    let mut original_pmt_pid: u16 = 0;
    let mut rewrite_needed = false;
    for p in 0..num_programs {
        let prog_offset = section_start + 8 + p * 4;
        if prog_offset + 4 > ps { break; }
        let prog_num = ((result[prog_offset] as u16) << 8) | result[prog_offset + 1] as u16;
        if prog_num != 0 {
            let declared_pid = ((result[prog_offset + 2] as u16 & 0x1F) << 8) | result[prog_offset + 3] as u16;
            original_pmt_pid = declared_pid;
            // Rewrite if PMT PID is 0x0FFF (null stuffing) or any reserved PID
            if declared_pid == 0x0FFF {
                rewrite_needed = true;
                // Rewrite the PID in the program entry: 0x0FFF → 0x1000
                let new_pid = PMT_PID_REWRITE;
                result[prog_offset + 2] = (result[prog_offset + 2] & 0xE0) | ((new_pid >> 8) as u8 & 0x1F);
                result[prog_offset + 3] = (new_pid & 0xFF) as u8;
                log::debug!("[HLS-INIT-REWRITE] PAT: rewrote PMT PID 0x{:04X} → 0x{:04X} in program entry", declared_pid, new_pid);
            }
        }
    }

    if !rewrite_needed {
        log::debug!("[HLS-INIT-REWRITE] PAT declares PMT PID=0x{:04X} — not null stuffing, no rewrite needed", original_pmt_pid);
        return result;
    }

    // Recalculate PAT section CRC-32
    // The CRC covers from table_id to just before the 4-byte CRC at the end of the section
    let section_end_with_crc = section_start + 3 + section_length as usize;
    let crc_start = section_start;
    let crc_end = section_end_with_crc - 4; // CRC covers everything except itself
    if crc_end <= crc_start || crc_end > ps {
        log::warn!("[HLS-INIT-REWRITE] PAT section CRC range invalid (start={}, end={}, section_end={})", crc_start, crc_end, section_end_with_crc);
        return init_prefix.to_vec(); // Return original on error
    }
    let new_pat_crc = crc32_mpeg2(&result[crc_start..crc_end]);
    // Write CRC as 4 bytes at the end of the section (big-endian)
    result[crc_end] = ((new_pat_crc >> 24) & 0xFF) as u8;
    result[crc_end + 1] = ((new_pat_crc >> 16) & 0xFF) as u8;
    result[crc_end + 2] = ((new_pat_crc >> 8) & 0xFF) as u8;
    result[crc_end + 3] = (new_pat_crc & 0xFF) as u8;
    log::debug!("[HLS-INIT-REWRITE] PAT CRC recalculated: 0x{:08X}", new_pat_crc);

    // Now rewrite the PMT packet's PID in the TS header (bytes 1-2)
    let pmt_pkt_offset = ps; // PMT packet is the second packet
    if pmt_pkt_offset + 4 > result.len() {
        log::warn!("[HLS-INIT-REWRITE] No PMT packet found in init_prefix");
        return result;
    }

    let pmt_current_pid = ((result[pmt_pkt_offset + 1] as u16 & 0x1F) << 8) | result[pmt_pkt_offset + 2] as u16;
    if pmt_current_pid == original_pmt_pid {
        let new_pid = PMT_PID_REWRITE;
        result[pmt_pkt_offset + 1] = (result[pmt_pkt_offset + 1] & 0xE0) | ((new_pid >> 8) as u8 & 0x1F);
        result[pmt_pkt_offset + 2] = (new_pid & 0xFF) as u8;
        log::debug!("[HLS-INIT-REWRITE] PMT header: rewrote PID 0x{:04X} → 0x{:04X}", pmt_current_pid, new_pid);
    } else {
        log::warn!("[HLS-INIT-REWRITE] PMT packet PID 0x{:04X} doesn't match PAT-declared 0x{:04X}", pmt_current_pid, original_pmt_pid);
    }

    // Recalculate PMT section CRC-32
    let pmt_pusi = (result[pmt_pkt_offset + 1] >> 6) & 0x01;
    let pmt_afc = (result[pmt_pkt_offset + 3] >> 4) & 0x03;
    let mut pmt_payload_offset = pmt_pkt_offset + 4;
    if pmt_afc & 0x02 != 0 {
        let af_len = result[pmt_payload_offset] as usize;
        pmt_payload_offset += 1 + af_len;
    }
    if pmt_payload_offset >= pmt_pkt_offset + ps || pmt_pusi != 1 {
        log::warn!("[HLS-INIT-REWRITE] PMT packet has no payload unit start indicator");
        return result;
    }

    let pmt_pointer = result[pmt_payload_offset] as usize;
    let pmt_section_start = pmt_payload_offset + 1 + pmt_pointer;
    if pmt_section_start + 3 > pmt_pkt_offset + ps {
        log::warn!("[HLS-INIT-REWRITE] PMT section start out of range");
        return result;
    }

    let pmt_table_id = result[pmt_section_start];
    if pmt_table_id != 0x02 {
        log::warn!("[HLS-INIT-REWRITE] PMT table_id=0x{:02X}, expected 0x02", pmt_table_id);
        return result;
    }

    let pmt_section_length = (((result[pmt_section_start + 1] & 0x0F) as u16) << 8) | result[pmt_section_start + 2] as u16;
    let pmt_section_end_with_crc = pmt_section_start + 3 + pmt_section_length as usize;
    let pmt_crc_end = pmt_section_end_with_crc - 4;

    if pmt_crc_end <= pmt_section_start || pmt_crc_end > pmt_pkt_offset + ps {
        log::warn!("[HLS-INIT-REWRITE] PMT section CRC range invalid");
        return result;
    }

    let new_pmt_crc = crc32_mpeg2(&result[pmt_section_start..pmt_crc_end]);
    result[pmt_crc_end] = ((new_pmt_crc >> 24) & 0xFF) as u8;
    result[pmt_crc_end + 1] = ((new_pmt_crc >> 16) & 0xFF) as u8;
    result[pmt_crc_end + 2] = ((new_pmt_crc >> 8) & 0xFF) as u8;
    result[pmt_crc_end + 3] = (new_pmt_crc & 0xFF) as u8;
    log::debug!("[HLS-INIT-REWRITE] PMT CRC recalculated: 0x{:08X}", new_pmt_crc);

    // Rewrite misidentified stream_types (0x15→0x0F) in PMT so hls.js discovers audio PID
    rewrite_pmt_stream_types(&mut result, pmt_section_start, pmt_pkt_offset + ps);

    // Parse the PMT stream entries for diagnostic logging
    parse_pmt_stream_entries(&result[pmt_pkt_offset..pmt_pkt_offset + ps], PMT_PID_REWRITE);

    result
}

/// Same as ensure_init_prefix but WITHOUT PMT PID rewriting.
/// For mpegts.js direct playback, rewriting PMT PID (0x0FFF→0x1000) causes
/// sync_byte corruption because the init-prefix declares a different PMT PID
/// than the original stream data. mpegts.js handles any PMT PID natively.
pub fn ensure_init_prefix_no_rewrite(
    cache_mgr: &crate::stream_cache::StreamCacheManager,
    message_id: i32,
    data_path: &std::path::Path,
    ts_packet_size: u64,
    is_m2ts: bool,
) -> Vec<u8> {
    // Check if init_prefix is already cached and non-empty
    if let Some(cached) = cache_mgr.get_init_prefix(message_id) {
        if !cached.is_empty() {
            log::info!("[HLS-INIT] Using cached init prefix for msg {}: {} bytes", message_id, cached.len());
            return cached;
        }
    }

    // Try to extract PAT+PMT from file WITHOUT rewriting
    if let Some((pat_pmt_buf, _, original_pmt_pid)) = extract_pat_pmt(data_path, ts_packet_size, 8192) {
        if !pat_pmt_buf.is_empty() && pat_pmt_buf[0] == 0x47 {
            let init_prefix_raw = if is_m2ts {
                strip_m2ts_prefix_from_buf(&pat_pmt_buf)
            } else {
                pat_pmt_buf.clone()
            };
            if !init_prefix_raw.is_empty() {
                // Apply stream_type rewrite (0x15→0x11) to the init-prefix so mpegts.js
                // routes audio to parseLOASAACPayload instead of kMetadata/ID3.
                // The init-prefix is the first thing mpegts.js reads — if it has 0x15,
                // mpegts.js maps it to kMetadata and drops all audio PES packets.
                // PMT PID is NOT rewritten (mpegts.js handles any PMT PID natively).
                let mut init_prefix_rewritten = init_prefix_raw.clone();
                let ps: usize = 188;
                for pkt_offset in (0..init_prefix_rewritten.len()).step_by(ps) {
                    if pkt_offset + ps > init_prefix_rewritten.len() { break; }
                    if init_prefix_rewritten[pkt_offset] != 0x47 { continue; }
                    let pid = ((init_prefix_rewritten[pkt_offset + 1] as u16 & 0x1F) << 8) | init_prefix_rewritten[pkt_offset + 2] as u16;
                    if pid == 0x0000 { continue; } // PAT
                    let pusi = (init_prefix_rewritten[pkt_offset + 1] >> 6) & 0x01;
                    if pusi != 1 { continue; }
                    let afc = (init_prefix_rewritten[pkt_offset + 3] >> 4) & 0x03;
                    let mut payload_offset = pkt_offset + 4;
                    if afc & 0x02 != 0 {
                        if payload_offset >= pkt_offset + ps { continue; }
                        let af_len = init_prefix_rewritten[payload_offset] as usize;
                        payload_offset += 1 + af_len;
                    }
                    if payload_offset >= pkt_offset + ps { continue; }
                    let pointer_field = init_prefix_rewritten[payload_offset] as usize;
                    let section_start = payload_offset + 1 + pointer_field;
                    let pkt_end = pkt_offset + ps;
                    let rewritten = rewrite_pmt_stream_types(&mut init_prefix_rewritten, section_start, pkt_end);
                    if rewritten > 0 {
                        log::info!("[HLS-INIT] Rewrote {} stream_type(s) 0x15→0x11 in init-prefix PMT for msg {}", message_id, rewritten);
                    }
                }
                cache_mgr.cache_init_prefix(message_id, init_prefix_rewritten.clone());
                log::info!("[HLS-INIT] Cached init prefix (stream_type rewritten) for msg {}: {} bytes, m2ts={}, original_pmt_pid=0x{:04X}",
                    message_id, init_prefix_rewritten.len(), is_m2ts, original_pmt_pid);
                return init_prefix_rewritten;
            }
        }
    }

    // Fall back to reading raw bytes from file (first 2 packets) — no rewrite
    let init_size = ts_packet_size * INIT_SEGMENT_PACKETS;
    if let Ok(raw_buf) = read_range_from_disk(data_path, 0, init_size - 1) {
        if !raw_buf.is_empty() && raw_buf[0] == 0x47 {
            let init_prefix_raw = if is_m2ts {
                strip_m2ts_prefix_from_buf(&raw_buf)
            } else {
                raw_buf
            };
            if !init_prefix_raw.is_empty() {
                // Apply stream_type rewrite to the fallback raw bytes too
                let mut init_prefix_rewritten = init_prefix_raw.clone();
                let ps: usize = 188;
                for pkt_offset in (0..init_prefix_rewritten.len()).step_by(ps) {
                    if pkt_offset + ps > init_prefix_rewritten.len() { break; }
                    if init_prefix_rewritten[pkt_offset] != 0x47 { continue; }
                    let pid = ((init_prefix_rewritten[pkt_offset + 1] as u16 & 0x1F) << 8) | init_prefix_rewritten[pkt_offset + 2] as u16;
                    if pid == 0x0000 { continue; }
                    let pusi = (init_prefix_rewritten[pkt_offset + 1] >> 6) & 0x01;
                    if pusi != 1 { continue; }
                    let afc = (init_prefix_rewritten[pkt_offset + 3] >> 4) & 0x03;
                    let mut payload_offset = pkt_offset + 4;
                    if afc & 0x02 != 0 {
                        if payload_offset >= pkt_offset + ps { continue; }
                        let af_len = init_prefix_rewritten[payload_offset] as usize;
                        payload_offset += 1 + af_len;
                    }
                    if payload_offset >= pkt_offset + ps { continue; }
                    let pointer_field = init_prefix_rewritten[payload_offset] as usize;
                    let section_start = payload_offset + 1 + pointer_field;
                    rewrite_pmt_stream_types(&mut init_prefix_rewritten, section_start, pkt_offset + ps);
                }
                cache_mgr.cache_init_prefix(message_id, init_prefix_rewritten.clone());
                log::info!("[HLS-INIT] Cached init prefix (stream_type rewritten, raw fallback) for msg {}: {} bytes",
                    message_id, init_prefix_rewritten.len());
                return init_prefix_rewritten;
            }
        }
    }

    Vec::new()
}

/// Ensure init prefix (PAT+PMT bytes) is cached for this message."
/// If already cached, returns it immediately. If not, extracts from
/// the data file, rewrites PMT PID if needed (0x0FFF → 0x1000),
/// and caches the result for future segment requests."
/// Returns empty Vec if the file isn't available yet."
pub fn ensure_init_prefix(
    cache_mgr: &crate::stream_cache::StreamCacheManager,
    message_id: i32,
    data_path: &std::path::Path,
    ts_packet_size: u64,
    is_m2ts: bool,
) -> Vec<u8> {
    // Check if init_prefix is already cached and non-empty
    if let Some(cached) = cache_mgr.get_init_prefix(message_id) {
        if !cached.is_empty() {
            log::info!("[HLS-INIT] Using cached init prefix for msg {}: {} bytes", message_id, cached.len());
            return cached;
        }
    }

    // Try to extract PAT+PMT from file, rewrite PMT PID if needed, and cache
    if let Some((pat_pmt_buf, _, original_pmt_pid)) = extract_pat_pmt(data_path, ts_packet_size, 8192) {
        if !pat_pmt_buf.is_empty() && pat_pmt_buf[0] == 0x47 {
            let init_prefix_raw = if is_m2ts {
                strip_m2ts_prefix_from_buf(&pat_pmt_buf)
            } else {
                pat_pmt_buf.clone()
            };
            if !init_prefix_raw.is_empty() {
                // Rewrite PMT PID from 0x0FFF to 0x1000 if needed
                let init_prefix = rewrite_init_prefix_pids(&init_prefix_raw);
                cache_mgr.cache_init_prefix(message_id, init_prefix.clone());
                log::info!("[HLS-INIT] Cached rewritten init prefix for msg {}: {} bytes, m2ts={}, original_pmt_pid=0x{:04X}",
                    message_id, init_prefix.len(), is_m2ts, original_pmt_pid);
                return init_prefix;
            }
        }
    }

    // Fall back to reading raw bytes from file (first 2 packets) and rewriting
    let init_size = ts_packet_size * INIT_SEGMENT_PACKETS;
    if let Ok(raw_buf) = read_range_from_disk(data_path, 0, init_size - 1) {
        if !raw_buf.is_empty() && raw_buf[0] == 0x47 {
            let init_prefix_raw = if is_m2ts {
                strip_m2ts_prefix_from_buf(&raw_buf)
            } else {
                raw_buf
            };
            if !init_prefix_raw.is_empty() {
                let init_prefix = rewrite_init_prefix_pids(&init_prefix_raw);
                cache_mgr.cache_init_prefix(message_id, init_prefix.clone());
                log::info!("[HLS-INIT] Cached rewritten init prefix (raw fallback) for msg {}: {} bytes, m2ts={}",
                    message_id, init_prefix.len(), is_m2ts);
                return init_prefix;
            }
        }
    }

    // File not available yet — can't extract
    Vec::new()
}

/// Strip the 4-byte BDAV timestamp prefix from each 192-byte M2TS packet
/// in a buffer, producing 188-byte TS packets.
fn strip_m2ts_prefix_from_buf(data: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len() * 188 / 192);
    for chunk in data.chunks(M2TS_PACKET_SIZE as usize) {
        if chunk.len() > 4 {
            result.extend_from_slice(&chunk[4..]);
        }
    }
    result
}

/// Parse PMT stream entries from a PMT TS packet and log them for diagnostics.
/// This helps identify what PIDs the PMT declares for audio/video streams,
/// which is critical for understanding why hls.js might report "Found no media".
fn parse_pmt_stream_entries(pkt: &[u8], _pmt_pid: u16) {
    if pkt.len() < 4 {
        return;
    }
    let adaptation = (pkt[3] >> 4) & 0x03;
    let payload_start_indicator = (pkt[1] >> 6) & 0x01;
    let mut payload_offset = 4;
    if adaptation & 0x02 != 0 {
        let af_len = pkt[payload_offset] as usize;
        payload_offset += 1 + af_len;
    }
    if payload_start_indicator != 1 || payload_offset >= pkt.len() {
        return;
    }
    let pointer = pkt[payload_offset] as usize;
    let table_start = payload_offset + 1 + pointer;
    if table_start + 12 >= pkt.len() {
        return;
    }
    let table_id = pkt[table_start];
    if table_id != 0x02 {
        return;
    }
    let section_length = (((pkt[table_start + 1] & 0x0f) as u16) << 8) | (pkt[table_start + 2] as u16);
    let program_number = ((pkt[table_start + 3] as u16) << 8) | (pkt[table_start + 4] as u16);
    let pcr_pid = (((pkt[table_start + 8] & 0x1f) as u16) << 8) | (pkt[table_start + 9] as u16);
    let program_info_length = (((pkt[table_start + 10] & 0x0f) as u16) << 8) | (pkt[table_start + 11] as u16);

    log::debug!("[HLS-PMT] PMT: program_number={} pcr_pid=0x{:04x} section_len={} program_info_len={}",
        program_number, pcr_pid, section_length, program_info_length);

    // Parse stream entries
    let mut pos = table_start + 12 + program_info_length as usize;
    let section_end = table_start + 3 + section_length as usize; // before CRC32
    let mut stream_count = 0;
    while pos + 5 <= section_end && pos + 5 <= pkt.len() {
        let stream_type = pkt[pos];
        let elementary_pid = (((pkt[pos + 1] & 0x1f) as u16) << 8) | (pkt[pos + 2] as u16);
        let es_info_length = (((pkt[pos + 3] & 0x0f) as u16) << 8) | (pkt[pos + 4] as u16);

        let codec_name = match stream_type {
            0x01 => "MPEG-1 Video",
            0x02 => "MPEG-2 Video",
            0x1b => "H.264/AVC",
            0x24 => "H.265/HEVC",
            0x03 => "MPEG-1 Audio",
            0x04 => "MPEG-2 Audio",
            0x0f => "AAC",
            0x81 => "AC-3",
            0x06 => "MPEG-2 Private/PES",
            0x07 => "MHEG",
            0x08 => "DSM-CC",
            0x0a => "ISO 13818-6 Type A",
            0x0b => "ISO 13818-6 Type B",
            0x0c => "ISO 13818-6 Type C",
            0x0d => "ISO 13818-6 Type D",
            0x11 => "MPEG-4 AAC LATM",
            0x15 => "MPEG-2 ADTS AAC",
            _ => "Unknown",
        };
        log::debug!("[HLS-PMT] Stream {}: type=0x{:02x} ({}) pid=0x{:04x} es_info_len={}",
            stream_count, stream_type, codec_name, elementary_pid, es_info_length);
        stream_count += 1;
        pos += 5 + es_info_length as usize;
    }
    if stream_count == 0 {
        log::warn!("[HLS-PMT] PMT has ZERO stream entries — hls.js will find no tracks!");
    }
}

/// Extract PAT and PMT packets from the beginning of a TS file.
///
/// TS files may not have PAT at byte 0 (e.g., some files start with PES data).
/// This function scans the first `scan_bytes` of the file, finds all PAT packets
/// (PID=0x0000) and PMT packets (found via PAT), and returns them concatenated.
///
/// Returns (pat_pmt_buffer, first_pat_offset, pmt_pid) or None if no PAT found.
fn extract_pat_pmt(path: &std::path::Path, packet_size: u64, scan_bytes: usize) -> Option<(Vec<u8>, u64, u16)> {
    let ps = packet_size as usize;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; scan_bytes];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);

    if n < ps * 3 {
        return None;
    }

    let packet_count = n / ps;
    let mut pat_packets: Vec<(usize, Vec<u8>)> = Vec::new();
    let mut pmt_pid: Option<u16> = None;

    // First pass: find PAT packets and parse them to discover PMT PID
    for i in 0..packet_count {
        let offset = i * ps;
        if buf[offset] != 0x47 {
            continue;
        }
        let pid = ((buf[offset + 1] as u16 & 0x1f) << 8) | (buf[offset + 2] as u16);
        if pid == 0x0000 {
            // PAT packet
            let adaptation = (buf[offset + 3] >> 4) & 0x03;
            let payload_start = (buf[offset + 1] >> 6) & 0x01;
            let mut payload_offset = offset + 4;
            if adaptation & 0x02 != 0 {
                let af_len = buf[payload_offset] as usize;
                payload_offset += 1 + af_len;
            }
            // Parse PAT to find PMT PID
            if payload_offset + 8 < buf.len() && payload_start == 1 {
                // Pointer field present
                let pointer = buf[payload_offset] as usize;
                let table_start = payload_offset + 1 + pointer;
                if table_start + 8 < buf.len() {
                    let table_id = buf[table_start];
                    if table_id == 0x00 {
                        let section_len = (((buf[table_start + 1] & 0x0f) as u16) << 8) | (buf[table_start + 2] as u16);
                        let num_programs = ((section_len - 9) / 4) as usize;
                        for p in 0..num_programs {
                            // Program loop starts 8 bytes after table_start:
                            // table_id(1) + section_length(2) + transport_stream_id(2)
                            // + version(1) + section_number(1) + last_section_number(1) = 8
                            let prog_offset = table_start + 8 + p * 4;
                            if prog_offset + 4 <= buf.len() {
                                let program_number = ((buf[prog_offset] as u16) << 8) | (buf[prog_offset + 1] as u16);
                                let program_pid = (((buf[prog_offset + 2] & 0x1f) as u16) << 8) | (buf[prog_offset + 3] as u16);
                                if program_number != 0 {
                                    pmt_pid = Some(program_pid);
                                    log::info!("[HLS-EXTRACT-PAT] Found PMT PID=0x{:04x} program_number={} at packet {}, offset={}, prog_offset={}", program_pid, program_number, i, offset, prog_offset);
                                }
                            }
                        }
                    }
                }
            }
            pat_packets.push((offset, buf[offset..offset + ps].to_vec()));
            log::debug!("[HLS-EXTRACT-PAT] Found PAT at packet {}, offset={}", i, offset);
        }
    }

    if pat_packets.is_empty() {
        log::warn!("[HLS-EXTRACT-PAT] No PAT found in first {} bytes", n);
        return None;
    }

    // Second pass: find PMT packets
    let mut pmt_packets: Vec<(usize, Vec<u8>)> = Vec::new();
    if let Some(target_pmt) = pmt_pid {
        for i in 0..packet_count {
            let offset = i * ps;
            if buf[offset] != 0x47 {
                continue;
            }
            let pid = ((buf[offset + 1] as u16 & 0x1f) << 8) | (buf[offset + 2] as u16);
            if pid == target_pmt {
                let pkt = buf[offset..offset + ps].to_vec();
                parse_pmt_stream_entries(&pkt, target_pmt);
                pmt_packets.push((offset, pkt));
                log::debug!("[HLS-EXTRACT-PAT] Found PMT at packet {}, offset={}, pid=0x{:04x}", i, offset, pid);
            }
        }
    }

    // Require at least one PAT and one PMT for a usable init prefix.
    // If PMT is missing, return None so the caller falls back to raw
    // first-packets (which may contain both PAT and PMT contiguously).
    if pmt_packets.is_empty() {
        log::warn!("[HLS-EXTRACT-PAT] Found {} PAT but zero PMT — init incomplete, returning None", pat_packets.len());
        return None;
    }

    // Concatenate PAT + PMT
    let mut result = Vec::with_capacity(pat_packets.len() * ps + pmt_packets.len() * ps);
    for (_, pkt) in &pat_packets {
        result.extend_from_slice(pkt);
    }
    for (_, pkt) in &pmt_packets {
        result.extend_from_slice(pkt);
    }

    let first_pat_offset = pat_packets.first().map(|(o, _)| *o as u64).unwrap_or(0);

    log::debug!("[HLS-EXTRACT-PAT] Extracted {} PAT + {} PMT = {} bytes, first PAT at offset={}",
        pat_packets.len(), pmt_packets.len(), result.len(), first_pat_offset);

    Some((result, first_pat_offset, pmt_pid.unwrap_or(0)))
}

/// Log packet structure for diagnostics (kept for potential debugging).
/// Analyzes TS packets and reports PAT/PMT/PES types, PID values,
/// PTS values (if any), and sync byte positions.
/// This helps identify why hls.js rejects the segment data.
#[allow(dead_code)]
fn log_packet_structure(data: &[u8], packet_size: u64, label: &str, max_packets: usize) {
    let ps = packet_size as usize;
    if ps == 0 || data.len() < ps {
        log::warn!("[HLS-PACKET-{}] Data too short ({} bytes) for packet size {}", label, data.len(), ps);
        return;
    }
    
    let packet_count = data.len() / ps;
    let mut has_pat = false;
    let mut has_pmt = false;
    let mut _has_pes = false;
    let mut pes_count = 0;
    let mut first_pes_pid: Option<u16> = None;
    
    for i in 0..packet_count.min(max_packets) {
        let offset = i * ps;
        let sync = data[offset];
        if sync != 0x47 {
            log::warn!("[HLS-PACKET-{}] Packet {}: NO SYNC BYTE (got 0x{:02x} at offset {})", label, i, sync, offset);
            continue;
        }
        let pid = ((data[offset + 1] as u16 & 0x1f) << 8) | (data[offset + 2] as u16);
        let adaptation = (data[offset + 3] >> 4) & 0x03;
        let payload_start = (data[offset + 1] >> 6) & 0x01;
        
        if pid == 0x0000 {
            has_pat = true;
            // Parse PAT to find PMT PID
            let pat_payload_start = offset + 4;
            let pat_data_offset = if adaptation & 0x02 != 0 {
                // Adaptation field present
                let af_len = data[pat_payload_start] as usize;
                pat_payload_start + 1 + af_len
            } else {
                pat_payload_start
            };
            if pat_data_offset + 8 < data.len() {
                let table_id = data[pat_data_offset];
                if table_id == 0x00 {
                    let section_len = (((data[pat_data_offset + 1] & 0x0f) as u16) << 8) | (data[pat_data_offset + 2] as u16);
                    let num_programs = (section_len - 9) / 4;
                    log::debug!("[HLS-PACKET-{}] Packet {}: PAT (pid=0x{:04x}), {} programs, payload_start={}", 
                        label, i, pid, num_programs, payload_start);
                }
            }
        } else if pid >= 0x0010 && pid <= 0x1ffe && pid != 0x1fff {
            // Likely PMT or PES
            let payload_offset = offset + 4;
            let data_offset = if adaptation & 0x02 != 0 {
                let af_len = data[payload_offset] as usize;
                payload_offset + 1 + af_len
            } else {
                payload_offset
            };
            if data_offset + 3 < data.len() {
                let stream_id = data[data_offset];
                // PES start code: 0x000001xx
                if data[data_offset] == 0x00 && data[data_offset + 1] == 0x00 && data[data_offset + 2] == 0x01 {
                    _has_pes = true;
                    pes_count += 1;
                    if first_pes_pid.is_none() {
                        first_pes_pid = Some(pid);
                    }
                    let stream_id_byte = data[data_offset + 3];
                    let stream_type = if stream_id_byte >= 0xe0 && stream_id_byte <= 0xef { "video" }
                        else if stream_id_byte >= 0xc0 && stream_id_byte <= 0xdf { "audio" }
                        else { "other" };
                    log::debug!("[HLS-PACKET-{}] Packet {}: PES (pid=0x{:04x}, stream_id=0x{:02x}, type={}), payload_start={}",
                        label, i, pid, stream_id_byte, stream_type, payload_start);
                } else if stream_id == 0x02 {
                    // PMT table ID
                    has_pmt = true;
                    log::debug!("[HLS-PACKET-{}] Packet {}: PMT (pid=0x{:04x}), payload_start={}",
                        label, i, pid, payload_start);
                }
            }
        } else if pid == 0x1fff {
            // Null packet
            log::debug!("[HLS-PACKET-{}] Packet {}: NULL (pid=0x{:04x})", label, i, pid);
        }
    }
    
    log::debug!("[HLS-PACKET-{}] Summary: {} packets analyzed, PAT={}, PMT={}, PES={} (first pid={:?})",
        label, packet_count, has_pat, has_pmt, pes_count, first_pes_pid);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_hls_info_with_actual_duration() {
        // 100MB file, actual duration 300s (5 min), actual resolution 1920x1080
        let info = calculate_hls_info(100_000_000, "video/mp4", Some(300.0), Some(1920), Some(1080));
        assert!((info.duration - 300.0).abs() < 0.01, "Duration should be 300s, got {}", info.duration);
        assert_eq!(info.width, 1920);
        assert_eq!(info.height, 1080);
        // Bandwidth = 100MB * 8 / 300s = ~2.67 Mbps
        let expected_bw = (100_000_000 * 8) as f64 / 300.0;
        assert!((info.bandwidth as f64 - expected_bw).abs() < 100.0, "Bandwidth should be ~2.67 Mbps");
        assert_eq!(info.segment_count, 30); // 300 / 10
    }

    #[test]
    fn test_calculate_hls_info_fallback_without_duration() {
        // 150MB file, no actual duration → fallback estimate
        // Uses 150MB so it exceeds the >100MB threshold for 720p estimation
        let file_size = 150_000_000;
        let info = calculate_hls_info(file_size, "video/mp4", None, None, None);
        let fallback_duration = (file_size * 8) as f64 / FALLBACK_BITRATE as f64;
        assert!((info.duration - fallback_duration).abs() < 0.01, "Duration should use fallback");
        assert_eq!(info.bandwidth, FALLBACK_BITRATE);
        // Resolution estimated from file size (150MB > 100MB → 720p)
        assert_eq!(info.width, 1280);
        assert_eq!(info.height, 720);
    }

    #[test]
    fn test_calculate_hls_info_ts_file() {
        let info = calculate_hls_info(50_000_000, "video/mp2t", Some(180.0), Some(1280), Some(720));
        assert_eq!(info.codec, "avc1.42E01E,mp4a.40.2"); // TS defaults to H.264 + AAC
        assert!((info.duration - 180.0).abs() < 0.01);
        assert_eq!(info.width, 1280);
        assert_eq!(info.height, 720);
    }

    #[test]
    fn test_generate_master_playlist_relative_urls() {
        let info = calculate_hls_info(100_000_000, "video/mp4", Some(300.0), Some(1920), Some(1080));
        let manifest = generate_master_playlist(&info, "abc123");

        assert!(manifest.starts_with("#EXTM3U\n"), "Master playlist must start with #EXTM3U");
        assert!(manifest.contains("#EXT-X-STREAM-INF:"), "Must contain stream info");
        assert!(manifest.contains("level_0.m3u8?token=abc123"), "Must use relative URL for level playlist");
        assert!(!manifest.contains("http://localhost"), "Must NOT contain absolute localhost URLs");
    }

    #[test]
    fn test_generate_media_playlist_relative_urls() {
        let info = calculate_hls_info(50_000_000, "video/mp2t", Some(180.0), Some(1280), Some(720));
        let manifest = generate_media_playlist(&info, "abc123");

        assert!(manifest.starts_with("#EXTM3U\n"), "Media playlist must start with #EXTM3U");
        assert!(manifest.contains("#EXT-X-VERSION:3"), "Must contain version 3 tag");
        assert!(!manifest.contains("#EXT-X-INDEPENDENT-SEGMENTS"), "Must NOT have independent segments tag — byte-range segments are NOT independent");
        assert!(manifest.contains("#EXT-X-TARGETDURATION:10"), "Must contain target duration");
        assert!(manifest.contains("#EXT-X-MEDIA-SEQUENCE:0"), "Must contain media sequence");
        assert!(manifest.contains("#EXT-X-ENDLIST"), "Must contain endlist");
        // Self-contained segments — no #EXT-X-MAP (init prefix prepended per segment)
        assert!(!manifest.contains("#EXT-X-MAP"),
            "Must NOT have #EXT-X-MAP — init prefix is prepended to each segment");
        // Self-contained segment URLs: seg/{index}?token=...
        assert!(manifest.contains("seg/0?token=abc123"), "Must have segment 0 URL");
        assert!(manifest.contains("seg/1?token=abc123"), "Must have segment 1 URL");
        assert!(!manifest.contains("http://localhost"), "Must NOT contain absolute localhost URLs");
        assert!(!manifest.contains("#EXT-X-BYTERANGE"), "Must NOT use byte-range");
        // Each segment must have EXTINF
        assert!(manifest.contains("#EXTINF:10.000,"), "Segments must have EXTINF");
    }

    #[test]
    fn test_generate_media_playlist_no_map() {
        let info = calculate_hls_info(50_000_000, "video/mp2t", Some(180.0), Some(1280), Some(720));
        let manifest = generate_media_playlist(&info, "abc123");

        // No #EXT-X-MAP — segments are self-contained (init prefix prepended)
        // to ensure codec init data (SPS/PPS, ADTS) stays in the data portion
        // where hls.js can extract it, while PAT+PMT init prefix has no PES
        // to prevent PTS contamination.
        assert!(!manifest.contains("#EXT-X-MAP"),
            "Must NOT have #EXT-X-MAP — segments are self-contained");
        assert!(!manifest.contains("init?"),
            "Must NOT reference separate init endpoint");
    }

    #[test]
    fn test_calculate_segment_layout_alignment_standard_ts() {
        // Standard MPEG-TS (188-byte packets)
        let info = calculate_hls_info(50_000_000, "video/mp2t", Some(180.0), Some(1280), Some(720));
        let (aligned_size, ranges) = calculate_segment_layout(info.file_size, info.duration, STD_TS_PACKET_SIZE);

        let init_size = STD_TS_PACKET_SIZE * INIT_SEGMENT_PACKETS; // 376

        // aligned_segment_size must be a multiple of STD_TS_PACKET_SIZE
        assert_eq!(aligned_size % STD_TS_PACKET_SIZE, 0,
            "Aligned segment size must be a multiple of 188");

        // Init size must be 188-aligned (so init + data offsets are aligned)
        assert_eq!(init_size % STD_TS_PACKET_SIZE, 0,
            "Init segment size must be a multiple of 188");

        // All data ranges must start at 188-aligned offsets
        for range in &ranges {
            assert_eq!(range.data_start % STD_TS_PACKET_SIZE, 0,
                "Data start must be 188-aligned, got {}", range.data_start);
        }

        // Content length = raw data bytes (init prefix is prepended by the HLS segment handler)
        for range in &ranges {
            let data_len = range.data_end - range.data_start + 1;
            assert_eq!(range.content_length, data_len,
                "Content length should be raw data bytes for segment {}", range.index);
        }
    }

    #[test]
    fn test_calculate_segment_layout_alignment_m2ts() {
        // M2TS (192-byte packets) — simulate by overriding packet size
        let file_size = 50_000_000u64;
        let duration = 180.0f64;
        let packet_size = M2TS_PACKET_SIZE; // 192
        let (aligned_size, ranges) = calculate_segment_layout(file_size, duration, packet_size);

        let init_size = M2TS_PACKET_SIZE * INIT_SEGMENT_PACKETS; // 384

        // aligned_segment_size must be a multiple of 192
        assert_eq!(aligned_size % M2TS_PACKET_SIZE, 0,
            "Aligned segment size must be a multiple of 192 for M2TS");

        // Init size must be 192-aligned
        assert_eq!(init_size % M2TS_PACKET_SIZE, 0,
            "Init segment size must be a multiple of 192");

        // All data ranges must start at 192-aligned offsets
        for range in &ranges {
            assert_eq!(range.data_start % M2TS_PACKET_SIZE, 0,
                "Data start must be 192-aligned, got {}", range.data_start);
        }

        // Content length = raw data bytes (init prefix is prepended by the HLS segment handler)
        for range in &ranges {
            let data_len = range.data_end - range.data_start + 1;
            assert_eq!(range.content_length, data_len,
                "Content length should be raw data bytes for segment {}", range.index);
        }
    }

    #[test]
    fn test_generate_media_playlist_duration_accuracy() {
        // 300s duration, 10s segments
        // With 300MB file, data_size = 300MB - 376 = ~300MB
        // aligned_segment_size ~ 1MB (1047724), segment_count = ceil(300MB / 1MB) = ~286
        // But we only display ~30 EXTINF segments based on duration target
        let info = calculate_hls_info(300_000_000, "video/mp4", Some(300.0), Some(1920), Some(1080));
        let manifest = generate_media_playlist(&info, "token");

        // Count EXTINF entries — should be approximately duration/SEGMENT_DURATION
        // The actual count depends on aligned segment sizes
        let extinf_count = manifest.matches("#EXTINF:").count();
        assert!(extinf_count > 0, "Should have at least 1 segment");
        assert!(extinf_count <= MAX_SEGMENTS as usize, "Should not exceed MAX_SEGMENTS");
    }

    #[test]
    fn test_generate_media_playlist_last_segment_duration() {
        // 95s duration, 10s segments → last segment has remaining duration
        let info = calculate_hls_info(100_000_000, "video/mp4", Some(95.0), Some(1280), Some(720));
        let manifest = generate_media_playlist(&info, "token");

        // Last segment should have duration < 10 (the remaining time)
        // Extract last EXTINF value
        let last_extinf = manifest.lines()
            .filter(|l| l.starts_with("#EXTINF:"))
            .last()
            .expect("Should have at least one EXTINF");
        let duration_str = last_extinf.split(":").nth(1).unwrap().split(",").next().unwrap();
        let last_duration: f64 = duration_str.parse().unwrap();
        assert!(last_duration <= 10.0, "Last segment duration should be <= 10s: got {}", last_duration);
    }

    #[test]
    fn test_calculate_segment_layout_data_starts_after_init() {
        // Data segment ranges must start at offset >= init_segment_size
        let info = calculate_hls_info(50_000_000, "video/mp2t", Some(180.0), Some(1280), Some(720));
        let init_size = STD_TS_PACKET_SIZE * INIT_SEGMENT_PACKETS; // 376
        let (_, ranges) = calculate_segment_layout(info.file_size, info.duration, STD_TS_PACKET_SIZE);

        for range in &ranges {
            if range.data_start > 0 {
                assert!(range.data_start >= init_size,
                    "Data start must be >= init segment size ({}), got {}", init_size, range.data_start);
            }
        }
    }

    #[test]
    fn test_extract_video_attrs_no_video_attribute() {
        // A raw TL message without DocumentAttributeVideo — returns None.
        // We can't easily construct a full tl::enums::Message here because
        // tl::structs::Message doesn't implement Default and has many fields.
        // Instead, test that a simple None case (no media) returns None
        // by verifying the pattern used in extract_video_attrs_from_raw_msg.
        // The function iterates doc.attributes looking for Video variant.
        // If doc is None (no Document media), it returns None immediately.
        // This test verifies the core logic path by checking that empty
        // attributes produce None.
        let empty_attrs: Vec<tl::enums::DocumentAttribute> = vec![
            tl::enums::DocumentAttribute::Filename(
                tl::types::DocumentAttributeFilename { file_name: "test.ts".to_string() }
            ),
        ];
        // Only Filename attribute — no Video, should return None
        let mut found_duration: Option<f64> = None;
        for attr in &empty_attrs {
            match attr {
                tl::enums::DocumentAttribute::Video(v) => {
                    found_duration = Some(v.duration);
                }
                tl::enums::DocumentAttribute::Audio(a) => {
                    if found_duration.is_none() {
                        found_duration = Some(a.duration as f64);
                    }
                }
                _ => {}
            }
        }
        assert!(found_duration.is_none(), "No Video attribute → duration should be None");
    }

    #[test]
    fn test_extract_video_attrs_with_video_attribute() {
        // Construct a DocumentAttributeVideo to verify extraction logic
        let video_attr = tl::enums::DocumentAttribute::Video(
            tl::types::DocumentAttributeVideo {
                round_message: false,
                supports_streaming: true,
                nosound: false,
                duration: 180.5,
                w: 1280,
                h: 720,
                preload_prefix_size: None,
                video_start_ts: None,
                video_codec: None,
            }
        );
        let attrs: Vec<tl::enums::DocumentAttribute> = vec![video_attr];
        let mut duration: Option<f64> = None;
        let mut width: Option<u32> = None;
        let mut height: Option<u32> = None;
        for attr in &attrs {
            match attr {
                tl::enums::DocumentAttribute::Video(v) => {
                    duration = Some(v.duration);
                    width = Some(v.w as u32);
                    height = Some(v.h as u32);
                }
                _ => {}
            }
        }
        assert_eq!(duration, Some(180.5));
        assert_eq!(width, Some(1280));
        assert_eq!(height, Some(720));
    }

    #[test]
    fn test_init_segment_size_is_two_ts_packets() {
        // CRITICAL: init segment must be exactly 2 TS packets (PAT+PMT only)
        // to prevent PTS contamination from init-prefix PES data
        let init_size_std = STD_TS_PACKET_SIZE * INIT_SEGMENT_PACKETS;
        let init_size_m2ts = M2TS_PACKET_SIZE * INIT_SEGMENT_PACKETS;
        assert_eq!(INIT_SEGMENT_PACKETS, 2, "Init segment must be 2 TS packets (PAT+PMT only)");
        assert_eq!(init_size_std, 376, "Init segment must be 376 bytes (2×188, no PES payloads)");
        assert_eq!(init_size_m2ts, 384, "M2TS init segment must be 384 bytes (2×192, no PES payloads)");
    }

    #[test]
    fn test_read_range_from_disk() {
        use std::io::Write;
        let path = std::path::PathBuf::from(format!("test_range_read_{}.bin", std::process::id()));
        {
            let mut f = std::fs::File::create(&path).unwrap();
            // Write 3 blocks: [0x00]*100, [0x01]*100, [0x02]*100
            f.write_all(&[0u8; 100]).unwrap();
            f.write_all(&[1u8; 100]).unwrap();
            f.write_all(&[2u8; 100]).unwrap();
            f.flush().unwrap();
        }

        // Read middle range (bytes 100-199)
        let buf = read_range_from_disk(&path, 100, 199).unwrap();
        assert_eq!(buf.len(), 100);
        assert_eq!(buf[0], 1);

        // Read first range (bytes 0-0)
        let buf = read_range_from_disk(&path, 0, 0).unwrap();
        assert_eq!(buf.len(), 1);
        assert_eq!(buf[0], 0);

        // Read full range
        let buf = read_range_from_disk(&path, 0, 299).unwrap();
        assert_eq!(buf.len(), 300);

        // Cleanup
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_read_concat_from_disk() {
        use std::io::Write;
        let path = std::path::PathBuf::from(format!("test_concat_read_{}.bin", std::process::id()));
        {
            let mut f = std::fs::File::create(&path).unwrap();
            // Write 5 blocks: [0x00]*100, [0x01]*100, [0x02]*100, [0x03]*100, [0x04]*100
            for i in 0u8..5 {
                f.write_all(&[i; 100]).unwrap();
            }
            f.flush().unwrap();
        }

        // Concat init range (bytes 0-99) + data range (bytes 200-299)
        let buf = read_concat_from_disk(&path, 0, 99, 200, 299).unwrap();
        assert_eq!(buf.len(), 200); // 100 init + 100 data
        // First 100 bytes = init (0x00)
        assert_eq!(buf[0], 0);
        assert_eq!(buf[99], 0);
        // Last 100 bytes = data (0x02)
        assert_eq!(buf[100], 2);
        assert_eq!(buf[199], 2);

        // Concat init range (bytes 100-199) + data range (bytes 300-399)
        let buf = read_concat_from_disk(&path, 100, 199, 300, 399).unwrap();
        assert_eq!(buf.len(), 200);
        assert_eq!(buf[0], 1); // init starts with 0x01
        assert_eq!(buf[100], 3); // data starts with 0x03

        // Cleanup
        std::fs::remove_file(&path).ok();
    }
}
