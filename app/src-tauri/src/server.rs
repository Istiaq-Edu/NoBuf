use actix_web::{get, head, web, App, HttpServer, HttpRequest, HttpResponse, Responder};
use actix_cors::Cors;
use crate::commands::TelegramState;
use crate::commands::utils::resolve_peer;
use crate::hls;
use crate::hls::manifest::extract_video_attrs_from_raw_msg;
use crate::ts_demux::{TsDemuxer, extract_stream_info, scan_keyframes_chunked, scan_keyframes_flush, scan_keyframes, KeyframeScanState, VideoCodec, PesFrame, TsStreamInfo};
use crate::fmp4::{build_init_segment, build_media_segment};
use grammers_client::types::Media;
use grammers_tl_types as tl;
use tokio::process::Command as TokioCommand;

use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::collections::HashMap;
use crate::stream_cache::{StreamCacheManager, CacheMeta, merge_ranges, is_range_cached};
use std::io::{Write, Seek, SeekFrom, Read};

/// Choose the Actix worker-thread count for the localhost streaming server.
///
/// Actix's `HttpServer` defaults to one worker per physical CPU core (verified
/// against the actix-web docs). On a 20-core machine that spins up 20 worker
/// threads, each with its own copy of every route handler — wasteful for a
/// server that only ever serves a single local WebView client streaming one
/// file at a time. A handful of workers is plenty to overlap the concurrent
/// range requests the MSE pipeline issues (video loop + audio prefetch +
/// keyframe/index fetches), while keeping thread and memory overhead low.
///
/// Policy: clamp to `[MIN_STREAMING_WORKERS, MAX_STREAMING_WORKERS]`, defaulting
/// to the available core count when it falls inside that band. Pure function so
/// it can be unit-tested without spinning up a server.
pub const MIN_STREAMING_WORKERS: usize = 2;
pub const MAX_STREAMING_WORKERS: usize = 4;

pub fn streaming_worker_count(available_cores: usize) -> usize {
    available_cores
        .clamp(MIN_STREAMING_WORKERS, MAX_STREAMING_WORKERS)
}

/// Resolve the worker count from the live machine, falling back to MIN when the
/// core count is unavailable (per `std::thread::available_parallelism` docs).
pub fn resolve_streaming_worker_count() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(MIN_STREAMING_WORKERS);
    streaming_worker_count(cores)
}

/// Detect TS packet size from cached file data.
/// Standard TS = 188 bytes per packet, M2TS = 192 bytes per packet.
/// Detection: check if byte at offset 192 is 0x47 (M2TS) or byte at offset 188 is 0x47 (standard TS).
/// Returns (ts_packet_size, is_m2ts) or None if detection fails.
fn detect_ts_packet_size(data_path: &std::path::Path) -> Option<(u64, bool)> {
    use std::io::Read;
    let mut file = std::fs::File::open(data_path).ok()?;
    let mut buf = vec![0u8; 193];
    let n = file.read(&mut buf).ok()?;
    if n < 1 || buf[0] != 0x47 {
        return None;
    }
    if n >= 193 && buf[192] == 0x47 {
        return Some((192, true)); // M2TS
    }
    if n >= 189 && buf[188] == 0x47 {
        return Some((188, false)); // Standard TS
    }
    // Default to standard TS if first byte is 0x47 but can't confirm packet size
    Some((188, false))
}

/// Rewrite TS stream data in a buffer for mediabunny compatibility.
/// Two types of rewriting:
/// 1. Init-prefix overlap (bytes 0-375): replace with cached rewritten init_prefix
///    (PMT PID 0x0FFF→0x1000, stream_type 0x15→0x11)
/// 2. Inline PAT/PMT packets beyond the init_prefix: rewrite PID 0x0FFF→0x1000
///    and stream_type 0x15→0x11. Mediabunny may re-read inline PAT packets and
///    would fail to find PMT on PID 0x0FFF (which is null stuffing in TS).
///
/// If init_prefix is not cached yet, attempts on-the-fly extraction from the
/// data file, rewriting, and caching. This ensures init_prefix is available
/// even without hls.js (MSE transmuxer mode).
///
/// Returns whether any rewriting was done.
fn rewrite_ts_stream_in_buf(
    buf: &mut [u8],
    buf_start: u64,
    cache_mgr: &StreamCacheManager,
    message_id: i32,
    data_path: Option<&std::path::Path>,
) -> bool {
    let mut did_rewrite = false;

    // Step 1: Ensure init_prefix is cached and available
    let init_prefix = cache_mgr.get_init_prefix(message_id);
    let prefix: Vec<u8> = match init_prefix {
        Some(ref p) if !p.is_empty() => p.clone(),
        _ => {
            // Init_prefix not cached — try on-the-fly extraction from data file
            if let Some(path) = data_path {
                if let Some((ts_packet_size, is_m2ts)) = detect_ts_packet_size(path) {
                    let extracted = hls::manifest::ensure_init_prefix_no_rewrite(cache_mgr, message_id, path, ts_packet_size, is_m2ts);
                    if !extracted.is_empty() {
                        log::info!("[PREBUFFER] On-the-fly init_prefix extraction for msg {}: {} bytes, ts_packet_size={}, is_m2ts={}",
                            message_id, extracted.len(), ts_packet_size, is_m2ts);
                        extracted
                    } else {
                        return false;
                    }
                } else {
                    return false; // Can't detect TS packet size
                }
            } else {
                return false; // No data path available
            }
        }
    };

    // Step 2: Rewrite init_prefix overlap (bytes 0-375)
    let prefix_len = prefix.len() as u64;
    if buf_start < prefix_len {
        let overlap_start = buf_start as usize;
        let overlap_end = (prefix_len.min(buf_start + buf.len() as u64)) as usize;
        let copy_len = overlap_end - overlap_start;
        if copy_len > 0 {
            buf[0..copy_len].copy_from_slice(&prefix[overlap_start..overlap_start + copy_len]);
            did_rewrite = true;
        }
    }

    // Step 3: Rewrite PMT stream_type entries in inline PMT packets.
    // stream_type 0x15 (AAC-LATM) is mapped to kMetadata by mpegts.js, which
    // drops audio PES. We rewrite 0x15→0x11 (kLOASAAC) so mpegts.js uses
    // parseLOASAACPayload for native LATM/LOAS audio parsing.
    // Previous rewrite to 0x0F (kADTSAAC) caused ADTS parser to parse LATM
    // frames as ADTS → audio corruption → PIPELINE_ERROR_DECODE crashes.
    //
    // Extract PMT PID from the init_prefix (contains PAT+PMT from file start).
    // The PAT declares the PMT PID — scan the prefix for the PAT packet.
    let pmt_pid: Option<u16> = {
        let ps: usize = 188; // standard TS packet size
        let mut found_pid = None;
        for pkt_off in (0..prefix.len()).step_by(ps) {
            if pkt_off + ps > prefix.len() { break; }
            if prefix[pkt_off] != 0x47 { continue; }
            let pid = ((prefix[pkt_off + 1] as u16 & 0x1F) << 8) | prefix[pkt_off + 2] as u16;
            // PAT is always on PID 0x0000
            if pid != 0x0000 { continue; }
            let pusi = (prefix[pkt_off + 1] >> 6) & 0x01;
            if pusi != 1 { continue; }
            let afc = (prefix[pkt_off + 3] >> 4) & 0x03;
            let mut payload_off = pkt_off + 4;
            if afc & 0x02 != 0 {
                if payload_off >= pkt_off + ps { continue; }
                let af_len = prefix[payload_off] as usize;
                payload_off += 1 + af_len;
            }
            if payload_off >= pkt_off + ps { continue; }
            // Pointer field
            let pointer = prefix[payload_off] as usize;
            let section_start = payload_off + 1 + pointer;
            // PAT section: table_id=0x00, section_syntax=1
            if section_start + 8 > pkt_off + ps { continue; }
            if prefix[section_start] != 0x00 { continue; } // table_id for PAT
            let section_length = (((prefix[section_start + 1] & 0x0F) as u16) << 8) | prefix[section_start + 2] as u16;
            // PAT entries start at section_start + 8, each 4 bytes
            let entries_start = section_start + 8;
            let entries_end = section_start + 3 + section_length as usize - 4; // -4 for CRC
            let mut pos = entries_start;
            while pos + 4 <= entries_end && pos + 4 <= pkt_off + ps {
                let program_number = ((prefix[pos] as u16) << 8) | prefix[pos + 1] as u16;
                let declared_pid = ((prefix[pos + 2] as u16 & 0x1F) << 8) | prefix[pos + 3] as u16;
                if program_number != 0 && declared_pid != 0 {
                    // First non-zero program → this is the PMT PID
                    found_pid = Some(declared_pid);
                    break;
                }
                pos += 4;
            }
            if found_pid.is_some() { break; }
        }
        found_pid
    };

    if let Some(pmt_pid_val) = pmt_pid {
        let ps: usize = 188; // standard TS packet size (m2ts=192 handled by init_prefix)
        // buf_start may not be 188-byte aligned (e.g. 524288/188 is not an
        // integer). Calculate where the first TS packet boundary falls within
        // the buffer so we scan at correct offsets.
        let align_offset = (buf_start % ps as u64) as usize;
        for pkt_offset in (align_offset..buf.len()).step_by(ps) {
            if pkt_offset + ps > buf.len() { break; }
            if buf[pkt_offset] != 0x47 { continue; }

            let pid = ((buf[pkt_offset + 1] as u16 & 0x1F) << 8) | buf[pkt_offset + 2] as u16;
            if pid != pmt_pid_val { continue; }

            // PUSI (payload unit start indicator)
            let pusi = (buf[pkt_offset + 1] >> 6) & 0x01;
            if pusi != 1 { continue; } // Only first PMT packet has PUSI=1

            // Parse adaptation field + payload offset
            let afc = (buf[pkt_offset + 3] >> 4) & 0x03;
            let mut payload_offset = pkt_offset + 4;
            if afc & 0x02 != 0 {
                if payload_offset >= pkt_offset + ps { continue; }
                let af_len = buf[payload_offset] as usize;
                payload_offset += 1 + af_len;
            }
            if payload_offset >= pkt_offset + ps { continue; }

            // Pointer field for PUSI=1 packets
            let pointer_field = buf[payload_offset] as usize;
            let section_start = payload_offset + 1 + pointer_field;
            let pkt_end = pkt_offset + ps;

            let (rewritten, stripped_inline) = hls::manifest::rewrite_pmt_stream_types(buf, section_start, pkt_end);
            if rewritten > 0 {
                log::info!("[STREAM-TS] Rewrote/stripped {} stream entry(s) in PMT at buf_offset={} (file_offset={}, stripped_pids={:?})",
                    rewritten, pkt_offset, buf_start + pkt_offset as u64, stripped_inline);
                did_rewrite = true;
            }
        }
    }

    // Step 4: Null out TS packets from stripped PIDs (timed_id3 metadata streams).
    // Even after stripping the entry from the PMT, the raw TS stream still
    // contains PES packets for the stripped PID. mpegts.js will skip them
    // (PID not in PMT) but only if it parsed the STRIPPED PMT first. If any
    // code path serves raw data before the PMT rewrite takes effect, or if
    // mpegts.js re-parses an inline unrewritten PMT, the metadata PES packets
    // cause AAC PTS drift. Belt-and-suspenders: null the PID at transport level.
    let stripped_pids = cache_mgr.get_stripped_pids(message_id);
    if !stripped_pids.is_empty() {
        let ps: usize = 188;
        let align_offset = (buf_start % ps as u64) as usize;
        for pkt_offset in (align_offset..buf.len()).step_by(ps) {
            if pkt_offset + ps > buf.len() { break; }
            if buf[pkt_offset] != 0x47 { continue; }
            let pid = ((buf[pkt_offset + 1] as u16 & 0x1F) << 8) | buf[pkt_offset + 2] as u16;
            if stripped_pids.contains(&pid) {
                // Overwrite PID to 0x1FFF (null packet) — mpegts.js skips null PIDs
                buf[pkt_offset + 1] = (buf[pkt_offset + 1] & 0xE0) | 0x1F;
                buf[pkt_offset + 2] = 0xFF;
                did_rewrite = true;
            }
        }
    }

    did_rewrite
}


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

// ContinuationGuard removed — the proactive prebuffer is now the ONLY path
// that downloads from Telegram. /stream reads exclusively from disk cache
// and polls when data isn't available yet. See the disk-cache poll loop below.

/// Holds the per-session streaming token for Actix validation
pub(crate) struct StreamTokenData {
    pub(crate) token: String,
}

#[derive(serde::Deserialize)]
#[allow(dead_code)]
pub(crate) struct StreamQuery {
    pub(crate) token: Option<String>,
    /// When true, only serve data that is already cached on disk.
    /// If the requested range is NOT cached, return 503 immediately —
    /// no subscription to active downloads, no targeted download spawn.
    /// Used by the TS keyframe scanner to avoid triggering scattered
    /// targeted downloads at far-ahead byte offsets.
    pub(crate) cached_only: Option<bool>,
    /// Expected duration in seconds (for remux endpoint).
    /// Passed to ffmpeg via -t so the fMP4 moov box contains the correct
    /// total duration — without this, the browser can't show the video length.
    pub(crate) duration: Option<f64>,
    /// Identifies the source of this stream request (e.g. "player", "thumbnail").
    /// Passed to register_download() so the coordinator only cancels zombie
    /// downloads from the SAME source_id. This prevents the thumbnail pipeline's
    /// seek from cancelling the main player's active download (and vice versa).
    /// None = backward compatible (cancel any same-message download with
    /// different start_byte, same as the original behaviour).
    pub(crate) source_id: Option<String>,
    /// Maximum bytes to serve for this stream request. When set, clamps
    /// end_byte to min(end_byte, start_byte + max_bytes - 1). Used by the
    /// thumbnail pipeline to limit downloads to ~5MB instead of fetching
    /// to EOF (hundreds of MB) — only needs enough data to find one keyframe.
    pub(crate) max_bytes: Option<u64>,
    /// Seek start time in seconds (for remux endpoint). When set, ffmpeg
    /// uses `-ss` to start remuxing from this position instead of the
    /// beginning, enabling byte-range-like seeking through the remux pipe.
    pub(crate) ss: Option<f64>,
}

/// Telegram download chunk size. Gammers-client enforces a hard cap of
/// 512 KB (MAX_CHUNK_SIZE in files.rs) and requires divisibility by 4 KB
/// (MIN_CHUNK_SIZE). We use the maximum allowed value to minimize round-trips.
const TELEGRAM_CHUNK_SIZE: i32 = 512 * 1024;

/// Minimum interval between upload.GetFile API calls on the main client.
/// Telegram's FLOOD_PREMIUM_WAIT triggers at ~5-6 req/s sustained. The rate
/// limiter serializes ALL API calls (regardless of Semaphore count), so the
/// effective rate is 1/interval = 1/300ms = 3.33 req/s — safely under the
/// 5-6 req/s FLOOD threshold. Throughput: 512KB / 450ms = 1.14 MB/s.
/// 250ms gave 4 req/s — still triggered FLOOD_PREMIUM_WAIT (25 occurrences
/// in 4 min). 300ms gives more headroom at the cost of ~10% throughput.
const MIN_API_CALL_INTERVAL_MS: u64 = 300;

/// Rate limiter: ensures at least MIN_API_CALL_INTERVAL_MS has passed since
/// the last upload.GetFile call. Uses a tokio Mutex to make the check-sleep-store
/// sequence atomic across concurrent callers (needed with Semaphore::new(2)).
/// The download happens AFTER the mutex is released, so downloads overlap
/// while API calls are perfectly spaced.
pub async fn throttle_api_calls(rate_limiter: &tokio::sync::Mutex<u64>) {
    let mut last = rate_limiter.lock().await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let elapsed = now.saturating_sub(*last);
    if *last > 0 && elapsed < MIN_API_CALL_INTERVAL_MS {
        tokio::time::sleep(std::time::Duration::from_millis(
            MIN_API_CALL_INTERVAL_MS - elapsed,
        )).await;
    }
    let now_after = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    *last = now_after;
    // Mutex guard dropped here — next caller can enter
}

/// Parse a Range header value (e.g., "bytes=0-1023") into (start, end) where end is inclusive.
/// Returns None if the header is missing or malformed.
pub(crate) fn parse_range_header(range: &str, total_size: u64) -> Option<(u64, u64)> {
    // Fix #9: guard zero-size media (photos / undetermined size). Every branch
    // below computes `total_size - 1`, which underflows (u64) when size is 0 —
    // panicking in debug and wrapping to u64::MAX in release. No range is
    // satisfiable against an empty representation, so bail early.
    if total_size == 0 {
        return None;
    }
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
        Some(t) if constant_time_eq::constant_time_eq(t.as_bytes(), token_data.token.as_bytes()) => {},
        _ => {
            log::error!("Stream request failed: Invalid or missing stream token for msg {}", message_id);
            return Err(HttpResponse::Forbidden().body("Invalid or missing stream token"));
        }
    }

    // Fix #2: resolve folder BEFORE the media cache lookup and key the cache by
    // (folder_id, message_id). Telegram message_id is unique only within a peer,
    // so keying by message_id alone made channel A's msg 18 poison channel B's
    // msg 18 (wrong file/size served). folder_key uses i64::MIN as the sentinel
    // for the None/me/home/null folder so the key is total.
    let folder_id = if folder_id_str == "me" || folder_id_str == "home" || folder_id_str == "null" {
        None
    } else {
        match folder_id_str.parse::<i64>() {
            Ok(id) => Some(id),
            Err(_) => return Err(HttpResponse::BadRequest().body("Invalid folder ID")),
        }
    };
    let folder_key = folder_id.unwrap_or(i64::MIN);

    // Fast path: check media cache — eliminates unthrottled get_messages_by_id
    // calls that contribute to FLOOD_PREMIUM_WAIT.
    {
        let cache = data.media_cache.read().await;
        if let Some((media, total_size)) = cache.get(&(folder_key, message_id)) {
            return Ok((media.clone(), *total_size));
        }
    }

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

    // Cache the media object — eliminates unthrottled get_messages_by_id
    // calls on subsequent /stream requests for the same message.
    {
        let mut cache = data.media_cache.write().await;
        cache.insert((folder_key, message_id), (media.clone(), size));
    }

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

    // cache_mgr_opt was here — now replaced by cache_mgr_for_stream created
    // inside the streaming path (no longer needed at function scope).

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

    // Clamp end_byte if max_bytes is set (thumbnail pipeline limits download size)
    let end_byte = if let Some(max_bytes) = query.max_bytes {
        let clamped_end = start_byte.saturating_add(max_bytes).saturating_sub(1).min(end_byte);
        if clamped_end != end_byte {
            log::info!("[PREBUFFER] max_bytes={} clamped range for msg {} from {}-{} to {}-{}",
                max_bytes, message_id, start_byte, end_byte, start_byte, clamped_end);
        }
        clamped_end
    } else {
        end_byte
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
                    Ok(mut slice) => {
                        // Rewrite init_prefix in the response if this range covers the
                        // first bytes of a TS file. The init_prefix contains rewritten
                        // PAT+PMT packets (PMT PID 0x0FFF→0x1000, stream_type 0x15→0x11)
                        // that mediabunny's TS demuxer needs. Without rewriting, the raw
                        // TS data has PMT PID 0x0FFF (null PID) which prevents demuxing.
                        if let Some(ref cache_mgr) = **cache {
                            let data_path = cache_mgr.data_path(message_id);
                            rewrite_ts_stream_in_buf(&mut slice, start_byte, cache_mgr, message_id, Some(&data_path));
                        }

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
                log::debug!("[PREBUFFER] MISS: msg {} range {}-{} not cached",
                    message_id, start_byte, end_byte);
            }
        } else {
            log::info!("[PREBUFFER] MISS: msg {} no meta found", message_id);
        }
    }

    // === cached_only: Return 503 immediately for uncached ranges ===
    // When the TS keyframe scanner sends cached_only=true, we skip all
    // coordinator logic (subscription + targeted download spawn) and just
    // tell the scanner "this range isn't cached yet, try later."
    if query.cached_only.unwrap_or(false) {
        log::info!("[PREBUFFER] CACHED_ONLY: msg {} range {}-{} not cached, returning 503",
            message_id, start_byte, end_byte);
        return HttpResponse::ServiceUnavailable()
            .insert_header(("Retry-After", "5"))
            .insert_header(("X-Reason", "cached-only-miss"))
            .insert_header(("X-Cache", "MISS"))
            .body("Range not cached — cached_only mode");
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
                                                // Rewrite init_prefix if this chunk covers the first bytes of a TS file
                                                let data_path = cache_mgr_clone.data_path(subscriber_msg);
                                                rewrite_ts_stream_in_buf(&mut buf, read_offset, &cache_mgr_clone, subscriber_msg, Some(&data_path));
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
                                        // Fix #6c: this fires on NORMAL chunk-boundary handoff, not a real
                                        // error — downgrade from warn to debug. Fix #6b: read_offset can be 0
                                        // (download died before writing byte 0), so read_offset - 1 underflows;
                                        // use saturating_sub.
                                        log::debug!("[PREBUFFER] COORDINATOR: chunk boundary reached before full range for msg {} (need {}-{}, progress reached {}, delivered up to {}); subscriber will continue",
                                            subscriber_msg, read_offset, subscriber_end, current_progress, read_offset.saturating_sub(1));
                                    }
                                } else {
                                    log::debug!("[PREBUFFER] COORDINATOR: chunk boundary reached before full range for msg {} (need {}-{}, progress reached {}); subscriber will continue",
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
                            // Rewrite init_prefix if this chunk covers the first bytes of a TS file
                            let data_path = cache_mgr_clone.data_path(subscriber_msg);
                            rewrite_ts_stream_in_buf(&mut buf, read_offset, &cache_mgr_clone, subscriber_msg, Some(&data_path));
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

                    // No throttle needed — subscriber reads from disk cache,
                    // not from Telegram (the proactive prebuffer handles downloads).

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
                // Fall through to disk-cache poll loop below (no Telegram
                // download needed — the proactive prebuffer handles that).
                log::info!("[PREBUFFER] COORDINATOR: msg {} range {}-{} skipping subscription to {}-{} (progress={}, distance={} > 10MB), falling through to cache-poll",
                    message_id, start_byte, end_byte, dl.start_byte, dl.end_byte, current_progress, distance);
            }
        }
    }

    // No active download covers our range — proceed with disk-cache poll.
    // Unlike the old architecture, we do NOT start a Telegram download here.
    // The proactive prebuffer is the ONLY path that downloads from Telegram.
    // /stream reads exclusively from disk cache, polling when data isn't
    // available yet (with a 30s Telegram fallback as a safety net).

    let client_guard = { data.client.lock().await.clone() };
    let client = match client_guard {
        Some(c) => c,
        None => return HttpResponse::ServiceUnavailable().body("Telegram client not connected"),
    };

    // === DISK-CACHE POLL STREAMING PATH ===
    // /stream reads ONLY from disk cache. When data isn't cached yet,
    // it polls every 100ms waiting for the proactive prebuffer to download
    // it. After 30s timeout without cache data, falls back to Telegram
    // download as a safety net (prevents player from hanging forever
    // if the proactive prebuffer fails or isn't running).

    log::debug!("[PREBUFFER] CACHE-POLL: msg {} range {}-{} ({} bytes) polling disk cache",
        message_id, start_byte, end_byte, content_length);

    // Clone cache_mgr for use inside the async_stream block.
    let cache_mgr_for_stream = (**cache).as_ref().map(|cm| cm.clone());

    // Prepare data needed for the Telegram fallback (30s timeout safety net).
    // Only used if the proactive prebuffer fails to deliver data in time.
    let client_clone = client.clone();
    let media_clone = media.clone();
    let semaphore_clone = data.download_semaphore.clone();

    let stream = async_stream::stream! {
        // ── CACHE PREFIX: Serve already-cached bytes instantly from disk ──
        // mpegts.js always requests range X-EOF, so the full range is rarely cached.
        // But there's often a contiguous cached prefix from a previous lazyLoad cycle.
        // Yield those bytes immediately before starting the poll loop.
        let mut effective_start_byte = start_byte;
        if let Some(ref cm) = cache_mgr_for_stream {
            let _lock = cm.lock_meta(message_id).await;
            let meta = cm.load_meta(message_id);
            drop(_lock);
            if let Some(meta) = meta {
                // Find the contiguous cached prefix from start_byte
                let cached_end = meta.cached_ranges.iter()
                    .filter(|(s, _)| *s <= start_byte)
                    .map(|(_, e)| *e)
                    .max()
                    .unwrap_or(0);
                if cached_end >= start_byte {
                    let prefix_end = cached_end.min(end_byte);
                    let prefix_len = prefix_end - start_byte + 1;
                    if prefix_len > 0 && prefix_len < (end_byte - start_byte + 1) {
                        // Partial cache hit: serve prefix from disk, then poll for remainder
                        let cache_path = cm.data_path(message_id);
                        match (|| -> std::io::Result<Vec<u8>> {
                            let mut file = std::fs::File::open(&cache_path)?;
                            use std::io::Read;
                            file.seek(SeekFrom::Start(start_byte))?;
                            let mut buf = vec![0u8; prefix_len as usize];
                            file.read_exact(&mut buf)?;
                            Ok(buf)
                        })() {
                            Ok(mut buf) => {
                                rewrite_ts_stream_in_buf(&mut buf, start_byte, cm, message_id, Some(&cache_path));
                                log::info!("[PREBUFFER] CACHE-PREFIX: msg {} served {}-{} ({}B from disk cache), remainder {}-{} from poll",
                                    message_id, start_byte, prefix_end, prefix_len, prefix_end + 1, end_byte);
                                yield Ok::<_, actix_web::Error>(web::Bytes::from(buf));
                                effective_start_byte = prefix_end + 1;
                            }
                            Err(e) => {
                                log::warn!("[PREBUFFER] CACHE-PREFIX read failed for msg {}: {}, polling for data", message_id, e);
                            }
                        }
                    }
                }
            }
        }

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

        // ── DISK-CACHE POLL LOOP ──
        // Poll disk cache every 100ms waiting for proactive prebuffer to
        // download data. If data doesn't appear within 30s, fall back to
        // Telegram download as a safety net (prevents player from hanging
        // forever if the proactive prebuffer fails or isn't running).
        //
        // ARCHITECTURE: /stream reads ONLY from disk cache. The proactive
        // prebuffer is the ONLY path that downloads from Telegram. This
        // eliminates FLOOD_PREMIUM_WAIT caused by the white bar (player's
        // IOController) competing with the green bar (proactive prebuffer)
        // for Telegram bandwidth.
        let mut read_offset = effective_start_byte;
        let mut bytes_sent: u64 = effective_start_byte - start_byte;
        let mut wait_elapsed_ms: u64 = 0;
        const POLL_INTERVAL_MS: u64 = 100;
        const FALLBACK_TIMEOUT_MS: u64 = 15000;

        // If there's no cache manager at all, skip the poll loop entirely
        // and go directly to the Telegram fallback.
        //
        // COLD-START FIX: If no cache META file exists for this message,
        // always use bootstrap (download directly) even if a proactive
        // prebuffer is registered. The proactive just started — it hasn't
        // written any bytes yet. If /stream enters poll-wait mode here,
        // mpegts.js starves for 10+ seconds → initialization timeout.
        //
        // Only use poll-wait when the proactive has already written some
        // data to disk (meta file exists with cached ranges). This means
        // the proactive is actively downloading and will fill more data soon.
        let skip_poll = cache_mgr_for_stream.is_none() || {
            if let Some(ref cache_mgr) = cache_mgr_for_stream {
                let _lock = cache_mgr.lock_meta(message_id).await;
                let meta = cache_mgr.load_meta(message_id);
                drop(_lock);
                if meta.is_none() {
                    // No meta at all → truly cold start, must bootstrap directly
                    true
                } else if meta.as_ref().map_or(true, |m| m.cached_ranges.is_empty()) {
                    // Meta exists but no cached ranges → proactive just started, still cold
                    true
                } else {
                    // Meta exists with cached ranges, but only trust poll-wait if the
                    // contiguous run from start_byte is already large enough for the
                    // player to initialize without starving. mpegts.js needs a few MB
                    // of contiguous TS data to parse PAT/PMT/IDR; if we enter poll-wait
                    // while only a tiny prefix is cached, the player times out before
                    // the proactive prebuffer fills the gap.
                    const MIN_BOOTSTRAP_CACHED_BYTES: u64 = 5 * 1024 * 1024; // 5MB
                    let cached_end = meta.as_ref().unwrap().cached_ranges.iter()
                        .filter(|(s, _)| *s <= start_byte)
                        .map(|(_, e)| *e)
                        .max()
                        .unwrap_or(0);
                    if cached_end < start_byte {
                        // Nothing cached at or after start_byte
                        true
                    } else {
                        let cached_run = cached_end - start_byte + 1;
                        if cached_run < MIN_BOOTSTRAP_CACHED_BYTES {
                            log::info!("[STREAM-CACHE-POLL] msg {}: cached run {}-{} = {} bytes (< {}MB bootstrap threshold) — using Telegram bootstrap",
                                message_id, start_byte, cached_end, cached_run, MIN_BOOTSTRAP_CACHED_BYTES / (1024 * 1024));
                            true
                        } else {
                            false
                        }
                    }
                }
            } else {
                true
            }
        };

        if skip_poll {
            log::debug!("[STREAM-CACHE-POLL] msg {}: no disk cache exists — using Telegram download directly (bootstrap)", message_id);
        }

        while !skip_poll && bytes_sent < content_length {
            // Check disk cache for current offset
            if let Some(ref cache_mgr) = cache_mgr_for_stream {
                let _lock = cache_mgr.lock_meta(message_id).await;
                let meta = cache_mgr.load_meta(message_id);
                drop(_lock);

                if let Some(meta) = meta {
                    // Find cached range that covers read_offset
                    if let Some(&(_, range_end)) = meta.cached_ranges.iter()
                        .find(|(s, e)| *s <= read_offset && *e >= read_offset)
                    {
                        // Read from disk: read_offset to min(range_end, end_byte)
                        let read_end = range_end.min(end_byte);
                        let read_len = (read_end - read_offset + 1) as usize;
                        let data_path = cache_mgr.data_path(message_id);
                        match std::fs::File::open(&data_path) {
                            Ok(mut f) => {
                                use std::io::Read;
                                if f.seek(SeekFrom::Start(read_offset)).is_ok() {
                                    let mut buf = vec![0u8; read_len];
                                    match f.read_exact(&mut buf) {
                                        Ok(()) => {
                                            rewrite_ts_stream_in_buf(&mut buf, read_offset, cache_mgr, message_id, Some(&data_path));
                                            if wait_elapsed_ms > 0 {
                                                log::info!("[STREAM-CACHE-WAIT] cache-ready at offset {} for msg {}, waited {}ms",
                                                    read_offset, message_id, wait_elapsed_ms);
                                                wait_elapsed_ms = 0;
                                            }
                                            yield Ok::<_, actix_web::Error>(web::Bytes::from(buf));
                                            bytes_sent += read_len as u64;
                                            read_offset = read_end + 1;
                                            continue;
                                        }
                                        Err(_) => {} // Fall through to poll wait
                                    }
                                }
                            }
                            Err(_) => {} // Fall through to poll wait
                        }
                    }
                }
            }

            // Data not cached yet — wait for proactive prebuffer to download it
            tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
            wait_elapsed_ms += POLL_INTERVAL_MS;

            // Log waiting status periodically (every 2 seconds)
            if wait_elapsed_ms > 0 && wait_elapsed_ms % 2000 == 0 {
                log::info!("[STREAM-CACHE-WAIT] waiting for cache at offset {} for msg {}, elapsed {}ms",
                    read_offset, message_id, wait_elapsed_ms);
            }

            // Check if a player-facing /stream download is actually running.
            // Only count coordinator-registered downloads; do NOT wait for the
            // proactive prebuffer task, because the prebuffer may be slow or
            // far behind the current playhead. Waiting for it can deadlock the
            // player when the user seeks.
            let has_active_download = if let Some(ref cache_mgr) = cache_mgr_for_stream {
                cache_mgr.active_download_count(message_id).await > 0
            } else {
                false
            };
            if !has_active_download && wait_elapsed_ms >= 5000 {
                log::warn!("[STREAM-CACHE-WAIT] msg {}: no proactive prebuffer running and 5s elapsed, falling back to Telegram",
                    message_id);
                break;
            }

            // Safety timeout: if data doesn't appear in 30s, fall back to Telegram
            if wait_elapsed_ms >= FALLBACK_TIMEOUT_MS {
                log::warn!("[STREAM-CACHE-WAIT] msg {}: 10s timeout waiting for cache at offset {}, falling back to Telegram",
                    message_id, read_offset);
                break; // Exit poll loop, enter Telegram fallback below
            }
        }

        // ── TELEGRAM FALLBACK ──
        // If the poll loop timed out (30s without cache data) OR there's no
        // cache manager at all, download remaining data directly from Telegram.
        // This is a safety net for when the proactive prebuffer fails or
        // isn't running — prevents the player from hanging forever.
        if bytes_sent < content_length {
            let fallback_start = read_offset;
            let fallback_remaining = content_length - bytes_sent;
            log::debug!("[STREAM-FALLBACK] msg {} falling back to Telegram download from offset {}, {} bytes remaining",
                message_id, fallback_start, fallback_remaining);

            let chunks_to_skip = (fallback_start / TELEGRAM_CHUNK_SIZE as u64) as i32;
            let bytes_to_discard_from_chunk = fallback_start % TELEGRAM_CHUNK_SIZE as u64;

            // Acquire the global semaphore per-chunk — serializes with
            // cmd_download_file to prevent FLOOD_WAIT. 2 permits allow
            // /stream and proactive to run concurrently (1 each).
            let download_iter = client_clone.iter_download(&media_clone)
                .chunk_size(TELEGRAM_CHUNK_SIZE)
                .skip_chunks(chunks_to_skip);

            // Register this fallback download with the coordinator so
            // overlapping requests can subscribe instead of duplicating.
            // Also get the cancel_flag — set by register_download when a NEW
            // /stream request arrives for the same message with a different range.
            // The while loop checks this flag and breaks immediately, preventing
            // zombie downloads from competing for the rate limiter.
            let mut _registered = false;
            let stream_cancel_flag: Arc<std::sync::atomic::AtomicBool> = if let Some(ref cm) = cache_mgr_for_stream {
                match cm.register_download(message_id, fallback_start, end_byte, false, fallback_start, query.source_id.clone()).await {
                    Some(info) => {
                        _registered = true;
                        info.cancel_flag
                    }
                    None => Arc::new(std::sync::atomic::AtomicBool::new(false)),
                }
            } else {
                Arc::new(std::sync::atomic::AtomicBool::new(false))
            };

            // Drop-guard that unregisters the download from the coordinator
            // when the stream ends (Bug #10, #13, #15 fixes).
            let _download_guard = if _registered {
                Some(DownloadGuard {
                    cache_mgr: cache_mgr_for_stream.clone(),
                    message_id,
                    start_byte: fallback_start,
                    end_byte,
                })
            } else {
                None
            };

            let mut cache_file_mut = cache_file_opt;
            let mut first_chunk = true;
            let mut current_offset = fallback_start;
            let mut iter = download_iter;
            let mut pending_ranges: Vec<(u64, u64)> = Vec::new();
            let mut stream_retries = 0u32;

            while let Some(chunk) = {
                // Acquire the global semaphore — serializes all iter_download calls
                let _permit = semaphore_clone.acquire().await.unwrap();
                // Global rate limiter: ensures ≥200ms between upload.GetFile calls
                throttle_api_calls(&data.rate_limiter).await;
                iter.next().await.transpose()
            } {
                // Check cancellation flag — a NEW /stream request for the same
                // message with a different range has arrived. Break immediately
                // to stop this zombie download from competing for the rate limiter.
                if stream_cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    log::debug!("[STREAM-FALLBACK] Cancelled zombie download for msg {} at offset {}", message_id, current_offset);
                    break;
                }
                match chunk {
                    Ok(bytes) => {
                        let remaining = content_length - bytes_sent;
                        if remaining == 0 { break; }

                        let mut chunk_data = bytes;

                        // On first chunk, discard leading bytes to align with fallback_start
                        if first_chunk && bytes_to_discard_from_chunk > 0 {
                            let discard = bytes_to_discard_from_chunk.min(chunk_data.len() as u64) as usize;
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

                        // 1) Write data to cache file
                        if let Some(ref mut cache_file) = cache_file_mut {
                            let _ = cache_file.seek(SeekFrom::Start(current_offset));
                            let _ = cache_file.write_all(&final_data);
                        }

                        // 2) Update meta with per-message lock (batched for efficiency)
                        if let Some(ref cache_mgr) = cache_mgr_for_stream {
                            pending_ranges.push((current_offset, chunk_range_end));
                            // Flush meta every 1MB (2 chunks) instead of 4MB (8 chunks).
                            // The green prebuffer bar polls cmd_get_cache_status every 500ms.
                            // With 4MB batching, the first seek's data isn't visible until
                            // 4MB is downloaded (~8s at 500KB/s) → bar appears empty on
                            // first seek. With 1MB batching, data is visible after ~2s.
                            if pending_ranges.len() >= 2 || is_last || chunk_range_end >= end_byte {
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
                                meta.cached_ranges.extend(pending_ranges.drain(..));
                                merge_ranges(&mut meta.cached_ranges);
                                if let Err(e) = cache_mgr.save_meta(&meta) {
                                    log::warn!("[STREAM-FALLBACK] Failed to save meta for msg {}: {}", message_id, e);
                                }
                                drop(_lock);
                            }
                            // Broadcast progress to coordinator subscribers
                            if _registered {
                                cache_mgr.update_download_progress(message_id, fallback_start, chunk_range_end).await;
                            }
                        }

                        current_offset += bytes_in_chunk;
                        bytes_sent += bytes_in_chunk;

                        // Rewrite TS data before yielding (same as HIT path)
                        let chunk_start_byte = current_offset - bytes_in_chunk;
                        let mut yield_data = final_data;
                        if let Some(ref cache_mgr) = cache_mgr_for_stream {
                            let data_path = cache_mgr.data_path(message_id);
                            rewrite_ts_stream_in_buf(&mut yield_data, chunk_start_byte, cache_mgr, message_id, Some(&data_path));
                        }

                        yield Ok::<_, actix_web::Error>(web::Bytes::from(yield_data));

                        if is_last { break; }

                        // Self-throttle: enforce download speed limit to prevent FLOOD_PREMIUM_WAIT.
                        // 0 = unlimited (default). When set, sleep to stay under configured KB/s.
                        let dl_limit_kb = data.download_speed_limit_kb.load(std::sync::atomic::Ordering::Relaxed);
                        if dl_limit_kb > 0 {
                            let sleep_ms = (bytes_in_chunk * 1000) / (dl_limit_kb * 1024);
                            let sleep_ms = sleep_ms.min(2000);
                            if sleep_ms > 0 {
                                tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[STREAM-FALLBACK] Download error for msg {} at offset {}: {}", message_id, current_offset, e);
                        stream_retries += 1;
                        if stream_retries > 3 {
                            log::error!("[STREAM-FALLBACK] Max retries exceeded for msg {}, breaking", message_id);
                            break;
                        }
                        let backoff = 3 * (1u64 << (stream_retries - 1));
                        log::info!("[STREAM-FALLBACK] Retrying in {}s (attempt {}/3)", backoff, stream_retries);
                        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                        if stream_cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                            log::info!("[STREAM-FALLBACK] Cancelled during backoff for msg {}", message_id);
                            break;
                        }
                        let skip_chunks = (current_offset / TELEGRAM_CHUNK_SIZE as u64) as i32;
                        iter = client_clone.iter_download(&media_clone)
                            .chunk_size(TELEGRAM_CHUNK_SIZE)
                            .skip_chunks(skip_chunks);
                        continue;
                    }
                }
            }

            // Flush any remaining pending meta ranges
            if !pending_ranges.is_empty() {
                if let Some(ref cache_mgr) = cache_mgr_for_stream {
                    let _lock = cache_mgr.lock_meta(message_id).await;
                    if let Some(mut meta) = cache_mgr.load_meta(message_id) {
                        meta.cached_ranges.extend(pending_ranges);
                        merge_ranges(&mut meta.cached_ranges);
                        if let Err(e) = cache_mgr.save_meta(&meta) {
                            log::warn!("[STREAM-FALLBACK] Final meta flush failed for msg {}: {}", message_id, e);
                        }
                    }
                    drop(_lock);
                }
            }
        }
    };

    if is_partial {
        HttpResponse::PartialContent()
            .insert_header(("Content-Type", mime))
            .insert_header(("Content-Range", format!("bytes {}-{}/{}", start_byte, end_byte, size)))
            .insert_header(("Accept-Ranges", "bytes"))
            .insert_header(("Connection", "keep-alive"))
            .insert_header(("X-Download-Mode", "cache-poll"))
            .streaming(stream)
    } else {
        HttpResponse::Ok()
            .insert_header(("Content-Type", mime))
            .insert_header(("Accept-Ranges", "bytes"))
            .insert_header(("X-Download-Mode", "cache-poll"))
            .streaming(stream)
    }
}

struct Fmp4InitCache {
    cache: HashMap<i32, Vec<u8>>,
}

struct Fmp4InitCacheData(StdMutex<Fmp4InitCache>);

struct Fmp4MetadataCache {
    cache: HashMap<i32, Vec<u8>>,
}

struct Fmp4MetadataCacheData(StdMutex<Fmp4MetadataCache>);

struct Fmp4KeyframeCache {
    cache: HashMap<i32, Vec<u8>>,
}

struct Fmp4KeyframeCacheData(StdMutex<Fmp4KeyframeCache>);

/// Caches sorted (timestamp_s, byte_offset) samples per message_id for
/// time→byte_offset lookup. Holds partial results while the disk cache is still
/// filling, so re-polling does not re-scan already-cached ranges. Once the file
/// is fully cached the entry is marked complete.
struct ByteTimeCacheEntry {
    samples: Vec<(f64, u64)>,
    /// Byte ranges that have already been scanned. Kept merged and sorted.
    covered_ranges: Vec<(u64, u64)>,
    total_size: u64,
    complete: bool,
}

struct Fmp4ByteTimeCache {
    cache: HashMap<i32, ByteTimeCacheEntry>,
}

struct Fmp4ByteTimeCacheData(StdMutex<Fmp4ByteTimeCache>);

/// Caches a stateful TsDemuxer per message_id so that PES assembly continues
/// seamlessly across segment boundaries. Without this, each segment request
/// creates a fresh demuxer that drops partial PES packets at the boundary,
/// causing 0.5-2s gaps in the PTS timeline.
#[allow(dead_code)]
struct Fmp4DemuxerCache {
    /// (demuxer, last_end_byte_offset) — the offset where the demuxer
    /// stopped processing.  If the next request's byte_offset doesn't match,
    /// the cache entry is stale (seek happened) and we create a fresh demuxer.
    entries: HashMap<i32, (TsDemuxer, u64)>,
}
#[allow(dead_code)]
struct Fmp4DemuxerCacheData(StdMutex<Fmp4DemuxerCache>);

/// Caches TsStreamInfo per message_id so fmp4_segment doesn't need to
/// call extract_stream_info() on mid-stream data (which has no PAT/PMT).
struct Fmp4StreamInfoCache {
    cache: HashMap<i32, TsStreamInfo>,
}

struct Fmp4StreamInfoCacheData(StdMutex<Fmp4StreamInfoCache>);

#[derive(serde::Deserialize)]
struct Fmp4Query {
    token: Option<String>,
    time: Option<f64>,
    byte_offset: Option<u64>,
    duration: Option<f64>,
    segment_sequence: Option<u32>,
    /// Keyframe alignment mode: "keyframe" (default, for seeks — discard P-frames
    /// before first keyframe) or "none" (for sequential playback — include all
    /// frames to avoid SourceBuffer gaps).
    align: Option<String>,
    /// Minimum PTS time for frame filtering (sequential playback).
    /// Frames with PTS before this time are dropped to avoid duplicates
    /// from the overlap region. Sent by the frontend as min_time.
    min_time: Option<f64>,
    /// File size in bytes (used as fallback when cache meta isn't available).
    file_size: Option<u64>,
}

#[derive(serde::Serialize)]
struct Fmp4MetadataResponse {
    duration_s: f64,
    video_codec: String,
    width: u32,
    height: u32,
    mime_type: String,
    video_codec_string: String,
    audio_codec_string: String,
    total_size: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    has_timed_id3: bool,
}

#[derive(serde::Serialize)]
struct Fmp4KeyframeEntry {
    timestamp_s: f64,
    byte_offset: u64,
}

#[derive(serde::Serialize)]
struct Fmp4KeyframeResponse {
    keyframes: Vec<Fmp4KeyframeEntry>,
    total_size: u64,
    partial: bool,
}

#[derive(serde::Serialize)]
struct Fmp4KeyframeAtResponse {
    timestamp_s: f64,
    byte_offset: u64,
    cached: bool,
    fallback: bool,
}

/// Download a byte range from Telegram and save it to the disk cache.
/// Returns the downloaded bytes on success.
/// Uses the MAIN CLIENT with the session-level semaphore, NOT the DownloadPool.
/// The DownloadPool has 3 separate TCP connections that bypass the main
/// semaphore and cause FLOOD_PREMIUM_WAIT when combined with /stream requests.
async fn download_and_cache_range(
    message_id: i32,
    start: u64,
    end: u64,
    total_size: u64,
    media: &grammers_client::types::Media,
    cache_mgr: &StreamCacheManager,
    data: &web::Data<Arc<TelegramState>>,
) -> Result<Vec<u8>, String> {
    // Use the main client with session-level semaphore — same as /stream and
    // FMP4-META tail download. This serializes all Telegram iter_download calls
    // on the main client, preventing FLOOD_PREMIUM_WAIT.
    let client = {
        let guard = data.client.lock().await;
        guard.clone()
    };
    let client = client.ok_or("Telegram client not available")?;

    // Per-chunk try_acquire + rate limiter. The keyframe search is a BACKGROUND
    // task — try_acquire ensures it doesn't block /stream. When /stream is
    // actively downloading (holding a permit), the keyframe search yields
    // instead of competing for the rate limiter budget. This gives /stream
    // priority and prevents FLOOD_PREMIUM_WAIT from the keyframe search
    // stealing bandwidth from playback.
    let chunk_size: i32 = 512 * 1024;
    let skip_chunks = (start / chunk_size as u64) as i32;
    let bytes_to_discard = start % chunk_size as u64;
    let content_length = end - start + 1;

    let download_iter = client.iter_download(media)
        .chunk_size(chunk_size)
        .skip_chunks(skip_chunks);

    let mut iter = download_iter;
    let mut downloaded = Vec::new();
    let mut first_chunk = true;
    let mut dac_retries = 0u32;
    let mut yield_count = 0u32;

    loop {
        let chunk_result = {
            // try_acquire: if /stream is using all permits, yield instead of
            // blocking. This gives /stream priority for the rate limiter budget.
            let _permit = match data.download_semaphore.try_acquire() {
                Ok(permit) => permit,
                Err(_) => {
                    yield_count += 1;
                    // After 100 yields (~50s at 500ms each), give up and block
                    // to ensure the keyframe search eventually completes.
                    if yield_count > 100 {
                        log::info!("[DAC] Keyframe search yielded {} times, now blocking for permit", yield_count);
                        data.download_semaphore.acquire().await.unwrap()
                    } else {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        continue;
                    }
                }
            };
            throttle_api_calls(&data.rate_limiter).await;
            iter.next().await
        };
        match chunk_result {
            Ok(Some(chunk)) => {
                let slice: &[u8] = if first_chunk && bytes_to_discard > 0 {
                    first_chunk = false;
                    &chunk[bytes_to_discard.min(chunk.len() as u64) as usize..]
                } else {
                    first_chunk = false;
                    &chunk
                };
                downloaded.extend_from_slice(slice);
                if downloaded.len() as u64 >= content_length {
                    downloaded.truncate(content_length as usize);
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => {
                dac_retries += 1;
                if dac_retries > 3 {
                    return Err(format!("iter_download error after 3 retries: {}", e));
                }
                let backoff = 3 * (1u64 << (dac_retries - 1));
                log::warn!("[DAC] Retrying in {}s (attempt {}/3): {}", backoff, dac_retries, e);
                tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                let resume_byte = start + downloaded.len() as u64;
                let skip_chunks = (resume_byte / chunk_size as u64) as i32;
                let bytes_already = resume_byte % chunk_size as u64;
                iter = client.iter_download(media)
                    .chunk_size(chunk_size)
                    .skip_chunks(skip_chunks);
                if bytes_already > 0 {
                    first_chunk = true;
                    // Adjust bytes_to_discard for the retry — discard bytes already in `downloaded`
                    // We can't modify the original bytes_to_discard (it's immutable), so use a local
                    let _ = bytes_already; // bytes_to_discard is used via first_chunk flag
                }
                continue;
            }
        }
    }

    // Write to cache file
    let mut file = cache_mgr.open_data_file_write(message_id).map_err(|e| format!("open data file: {}", e))?;
    file.seek(SeekFrom::Start(start)).map_err(|e| format!("seek data file: {}", e))?;
    file.write_all(&downloaded).map_err(|e| format!("write data file: {}", e))?;

    // Update meta
    let _lock = cache_mgr.lock_meta(message_id).await;
    let mut meta = cache_mgr.load_meta(message_id).unwrap_or_else(|| CacheMeta {
        message_id,
        folder_id: 0,
        total_size,
        filename: String::new(),
        cached_ranges: Vec::new(),
        mime_type: String::new(),
    });
    meta.cached_ranges.push((start, end));
    merge_ranges(&mut meta.cached_ranges);
    let _ = cache_mgr.save_meta(&meta);
    drop(_lock);

    Ok(downloaded)
}

/// Find the byte offset of the nearest video keyframe at or before `target_time_s`.
/// First checks the cached keyframe index; if not covered, downloads a window
/// from Telegram and scans it. Returns (timestamp_s, byte_offset, cached).
async fn find_keyframe_at_or_before_time(
    message_id: i32,
    target_time_s: f64,
    total_size: u64,
    duration_s: f64,
    is_m2ts: bool,
    cache_mgr: &StreamCacheManager,
    byte_time_cache: &Fmp4ByteTimeCacheData,
    stream_info: &TsStreamInfo,
    media: &grammers_client::types::Media,
    data: &web::Data<Arc<TelegramState>>,
) -> Option<(f64, u64, bool)> {
    // Compute approximate byte first
    let approx_byte = if duration_s > 0.0 && total_size > 0 {
        ((target_time_s / duration_s).clamp(0.0, 1.0) * total_size as f64) as u64
    } else {
        0
    }.min(total_size.saturating_sub(1));

    // Only trust the cached keyframe index if the disk cache covers the region
    // around the approximate target byte. Otherwise a sparse index (e.g. keyframes
    // from the first 60s and the tail) could return a stale keyframe far from the
    // seek target.
    let cached_ranges = {
        let _lock = cache_mgr.lock_meta(message_id).await;
        cache_mgr.load_meta(message_id).map(|m| m.cached_ranges).unwrap_or_default()
    };
    let coverage_window = 2 * 1024 * 1024; // 2MB
    let cover_start = approx_byte.saturating_sub(coverage_window);
    let cover_end = (approx_byte + coverage_window).min(total_size - 1);
    let region_covered = cached_ranges.iter().any(|(s, e)| *s <= cover_start && *e >= cover_end);

    if region_covered {
        let cache_lock = byte_time_cache.0.lock().ok();
        if let Some(ref c) = cache_lock {
            if let Some(entry) = c.cache.get(&message_id) {
                if entry.total_size == total_size {
                    let idx = entry.samples.partition_point(|(ts, _)| *ts <= target_time_s);
                    if idx > 0 {
                        let (ts, off) = entry.samples[idx - 1];
                        // Reject cached keyframes that are too far from the target.
                        // The coverage guard only checks that the disk cache covers
                        // the approximate byte region — it doesn't check that the
                        // keyframe itself is close to the target time. A stale
                        // keyframe from a previous seek's scan (e.g. 898s when
                        // seeking to 1392s) can be returned if the disk cache
                        // happens to cover the target region from the player's
                        // own /stream download.
                        if target_time_s - ts <= 30.0 {
                            return Some((ts, off, true));
                        }
                        // Keyframe too far — fall through to download/scan
                    }
                }
            }
        }
    }

    // 2. Download/scan expanding windows. Use BACKWARD-BIASED windows:
    //    search from the approximate byte backward, not symmetric. For VBR
    //    video, the actual keyframe is almost always BEFORE the linear
    //    estimate (higher bitrate early in the file), so the forward half
    //    of a symmetric window is wasted.
    let mut window_size: u64 = 4 * 1024 * 1024; // 4MB initial
    let max_window: u64 = 256 * 1024 * 1024; // 256MB max (for extreme VBR offsets up to ~128MB forward)
    let search_start = std::time::Instant::now();
    let search_deadline = std::time::Duration::from_secs(15);

    while window_size <= max_window {
        // Symmetric search: 50% backward, 50% forward.
        let back = window_size / 2;
        let forward = window_size / 2;
        let alignment: u64 = if is_m2ts { 192 } else { 188 };
        let start = (approx_byte.saturating_sub(back) / alignment) * alignment;
        let end = (approx_byte + forward).min(total_size - 1);

        // Try reading from disk cache FIRST — the proactive prebuffer may have
        // already downloaded this region. Disk reads are instant (no Telegram
        // API call, no rate limiting). Only download from Telegram if the disk
        // cache doesn't have the data.
        let chunk_data = {
            let data_path = cache_mgr.data_path(message_id);
            let _lock = cache_mgr.lock_meta(message_id).await;
            let meta = cache_mgr.load_meta(message_id);
            let cached = meta.as_ref().map(|m| m.cached_ranges.clone()).unwrap_or_default();
            let is_cached = cached.iter().any(|(s, e)| *s <= start && *e >= end);
            drop(_lock);
            if is_cached {
                // Read from disk — instant, no API call
                match std::fs::File::open(&data_path) {
                    Ok(mut f) => {
                        use std::io::{Read, Seek, SeekFrom};
                        let len = (end - start + 1) as usize;
                        let mut buf = vec![0u8; len];
                        if f.seek(SeekFrom::Start(start)).is_ok() && f.read_exact(&mut buf).is_ok() {
                            buf
                        } else {
                            // Disk read failed — fall back to Telegram download
                            match download_and_cache_range(message_id, start, end, total_size, media, cache_mgr, data).await {
                                Ok(d) => d,
                                Err(_) => { window_size *= 2; continue; }
                            }
                        }
                    }
                    Err(_) => {
                        match download_and_cache_range(message_id, start, end, total_size, media, cache_mgr, data).await {
                            Ok(d) => d,
                            Err(_) => { window_size *= 2; continue; }
                        }
                    }
                }
            } else {
                // Not on disk — download from Telegram
                match download_and_cache_range(message_id, start, end, total_size, media, cache_mgr, data).await {
                    Ok(d) => d,
                    Err(_) => { window_size *= 2; continue; }
                }
            }
        };
        {
            let ts_data = if is_m2ts { strip_m2ts_prefix(&chunk_data, true) } else { chunk_data };
            let kfs = scan_keyframes(&ts_data, start, stream_info);

                // Update the byte_time_cache with newly discovered keyframes
                // so subsequent calls for nearby times hit the cache instead
                // of downloading again (or returning stale sparse-index results).
                if !kfs.is_empty() {
                    if let Ok(mut cache) = byte_time_cache.0.lock() {
                        let entry = cache.cache.entry(message_id).or_insert_with(|| ByteTimeCacheEntry {
                            samples: Vec::new(),
                            covered_ranges: Vec::new(),
                            total_size,
                            complete: false,
                        });
                        if entry.total_size == total_size {
                            for &(ts, off) in &kfs {
                                // Insert sorted, skip duplicates
                                let pos = entry.samples.partition_point(|(t, _)| *t < ts);
                                if pos < entry.samples.len() && entry.samples[pos].0 == ts {
                                    continue;
                                }
                                entry.samples.insert(pos, (ts, off));
                            }
                            // M2 fix: update covered_ranges so /fmp4/keyframes
                            // doesn't re-download already-scanned ranges.
                            entry.covered_ranges.push((start, end));
                            merge_ranges(&mut entry.covered_ranges);
                        }
                    }
                }

                let idx = kfs.partition_point(|(ts, _)| *ts <= target_time_s);
                if idx > 0 {
                    let (ts, off) = kfs[idx - 1];
                    log::info!("[FMP4-KF-AT] Found keyframe for msg {} at {}s -> byte {} (window {}-{}, size {}MB)",
                        message_id, ts, off, start, end, window_size / 1024 / 1024);
                    return Some((ts, off, false));
                }

                log::info!("[FMP4-KF-AT] No keyframe <= {}s in window {}-{} for msg {}, expanding",
                    target_time_s, start, end, message_id);
        }

        window_size *= 2;

        // Search deadline: if the search has been running for >15s (due to
        // FLOOD_PREMIUM_WAIT on each download), stop expanding and return None.
        // The caller returns a linear byte estimate fallback. The frontend's
        // 5s AbortController has already fired by this point, but the backend
        // keeps running and caches the result for future seeks.
        if search_start.elapsed() >= search_deadline {
            log::warn!("[FMP4-KF-AT] Search deadline (15s) exceeded for msg {} at {}s, returning fallback",
                message_id, target_time_s);
            return None;
        }
    }

    None
}

/// Endpoint: GET /fmp4/keyframe-at/{folder_id}/{message_id}?time=...&duration=...&token=...
/// Returns the byte offset of the nearest video keyframe at or before the requested time.
/// If the keyframe is not already cached, the endpoint downloads a window from Telegram
/// and scans it.
#[get("/fmp4/keyframe-at/{folder_id}/{message_id}")]
async fn fmp4_keyframe_at(
    path: web::Path<(String, i32)>,
    query: web::Query<Fmp4Query>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
    byte_time_cache: web::Data<Fmp4ByteTimeCacheData>,
    stream_info_cache: web::Data<Fmp4StreamInfoCacheData>,
) -> impl Responder {
    let (_folder_id_str, message_id) = path.into_inner();

    match &query.token {
        Some(t) if constant_time_eq::constant_time_eq(t.as_bytes(), token_data.token.as_bytes()) => {},
        _ => {
            log::error!("[FMP4-KF-AT] Invalid or missing stream token for msg {}", message_id);
            return HttpResponse::Forbidden().body("Invalid or missing stream token");
        }
    }

    let target_time_s = query.time.unwrap_or(0.0).max(0.0);

    let cache_mgr = match (**cache).as_ref() {
        Some(cm) => cm.clone(),
        None => {
            log::error!("[FMP4-KF-AT] No cache manager for msg {}", message_id);
            return HttpResponse::ServiceUnavailable().body("No cache manager");
        }
    };

    let data_path = cache_mgr.data_path(message_id);
    let (_ts_packet_size, is_m2ts) = match detect_ts_packet_size(&data_path) {
        Some(result) => result,
        None => (188, false),
    };

    let _lock = cache_mgr.lock_meta(message_id).await;
    let meta = cache_mgr.load_meta(message_id);
    drop(_lock);

    let total_size = match meta.as_ref() {
        Some(m) => m.total_size,
        None => {
            log::error!("[FMP4-KF-AT] No cache meta for msg {}", message_id);
            return HttpResponse::NotFound().body("No cache meta");
        }
    };

    // Guard against total_size == 0 — would cause u64 underflow in
    // total_size - 1 calculations below, leading to OOM/crash.
    if total_size == 0 {
        log::error!("[FMP4-KF-AT] total_size is 0 for msg {}", message_id);
        return HttpResponse::NotFound().body("Invalid total_size");
    }

    // Resolve media for potential Telegram download
    let (media, _) = match resolve_media_from_path(&_folder_id_str, message_id, &data, &token_data, &StreamQuery { token: query.token.clone(), cached_only: Some(false), duration: None, source_id: None, max_bytes: None, ss: None }).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    // Duration: prefer query.duration, else fall back to 4Mbps estimate
    let duration_s = query.duration.unwrap_or_else(|| {
        if total_size > 0 {
            (total_size as f64 * 8.0) / (4_000_000.0) // 4 Mbps in bits/s
        } else {
            0.0
        }
    });

    // Get stream info (try cache first, then extract from first portion of file)
    let stream_info = {
        let cache_lock = stream_info_cache.0.lock().ok();
        if let Some(ref c) = cache_lock {
            if let Some(si) = c.cache.get(&message_id) {
                Some(si.clone())
            } else {
                None
            }
        } else {
            None
        }
    };

    let stream_info = match stream_info {
        Some(si) => si,
        None => {
            // Read first 5MB from disk or Telegram
            let first_end = (5 * 1024 * 1024).min(total_size as usize);
            let first_data = if std::fs::metadata(&data_path).is_ok() {
                let mut buf = vec![0u8; first_end];
                if let Ok(mut f) = std::fs::File::open(&data_path) {
                    let _ = f.read_exact(&mut buf);
                    buf
                } else {
                    Vec::new()
                }
            } else {
                match download_and_cache_range(message_id, 0, (first_end as u64 - 1).min(total_size - 1), total_size, &media, &cache_mgr, &data).await {
                    Ok(d) => d,
                    Err(e) => {
                        log::warn!("[FMP4-KF-AT] Failed to download stream info for msg {}: {}", message_id, e);
                        Vec::new()
                    }
                }
            };

            if first_data.is_empty() {
                log::error!("[FMP4-KF-AT] No stream data available for msg {}", message_id);
                return HttpResponse::NotFound().body("No stream data available");
            }

            let first_ts = if is_m2ts { strip_m2ts_prefix(&first_data, true) } else { first_data };
            match extract_stream_info(&first_ts) {
                Some(si) => {
                    if let Ok(mut c) = stream_info_cache.0.lock() {
                        c.cache.insert(message_id, si.clone());
                    }
                    si
                }
                None => {
                    log::error!("[FMP4-KF-AT] Failed to extract stream info for msg {}", message_id);
                    return HttpResponse::InternalServerError().body("Failed to extract stream info");
                }
            }
        }
    };

    // Find the keyframe
    match find_keyframe_at_or_before_time(message_id, target_time_s, total_size, duration_s, is_m2ts, &cache_mgr, &byte_time_cache, &stream_info, &media, &data).await {
        Some((ts, off, cached)) => {
            let response = Fmp4KeyframeAtResponse {
                timestamp_s: ts,
                byte_offset: off,
                cached,
                fallback: false,
            };
            HttpResponse::Ok().content_type("application/json").body(match serde_json::to_vec(&response) {
                Ok(b) => b,
                Err(e) => return HttpResponse::InternalServerError().body(format!("Failed to serialize: {}", e)),
            })
        }
        None => {
            // Fallback to linear estimate
            let fallback_byte = if duration_s > 0.0 && total_size > 0 {
                ((target_time_s / duration_s).clamp(0.0, 1.0) * total_size as f64) as u64
            } else {
                0
            };
            log::warn!("[FMP4-KF-AT] No keyframe found for msg {} at {}s, returning fallback byte {}",
                message_id, target_time_s, fallback_byte);
            let response = Fmp4KeyframeAtResponse {
                timestamp_s: target_time_s,
                byte_offset: fallback_byte,
                cached: false,
                fallback: true,
            };
            HttpResponse::Ok().content_type("application/json").body(match serde_json::to_vec(&response) {
                Ok(b) => b,
                Err(e) => return HttpResponse::InternalServerError().body(format!("Failed to serialize: {}", e)),
            })
        }
    }
}

/// If is_m2ts is false, returns the data unchanged (as a new Vec).
/// If is_m2ts is true, extracts bytes [4..192] from every 192-byte packet.
fn strip_m2ts_prefix(data: &[u8], is_m2ts: bool) -> Vec<u8> {
    if !is_m2ts {
        return data.to_vec();
    }
    let mut out = Vec::with_capacity(data.len() / 192 * 188);
    let mut offset = 0;
    while offset + 192 <= data.len() {
        // Verify sync byte (0x47) is at position 4 (after 4-byte BDAV prefix)
        if data[offset + 4] == 0x47 {
            out.extend_from_slice(&data[offset + 4..offset + 192]);
        }
        offset += 192;
    }
    out
}

/// FFmpeg-based TS→MPEG-TS remux endpoint.
///
/// Spawns `ffmpeg -i INPUT -c:v copy -c:a aac -b:a 192k -f mpegts -mpegts_flags resend_headers pipe:1`
/// and streams the MPEG-TS output to the client. The output is consumed by
/// mpegts.js (client-side TS demuxer → MSE fMP4), NOT by native `<video>`.
///
/// Supports Range header via ffmpeg `-ss` (seek) and `-t` (duration) flags.
#[get("/remux/{folder_id}/{message_id}")]
async fn remux_ts_to_mp4(
    req: HttpRequest,
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();
    let (_media, size) = match resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &query).await {
        Ok(result) => result,
        Err(resp) => return resp,
    };

    // Remux cache dir
    let remux_dir = if let Some(ref cache_mgr) = **cache {
        cache_mgr.cache_dir().join("remux")
    } else {
        std::path::PathBuf::from(std::env::var("TEMP").unwrap_or_else(|_| "/tmp".into())).join("nobuf_remux")
    };
    let _ = std::fs::create_dir_all(&remux_dir);
    let remux_path = remux_dir.join(format!("{}_{}.mp4", folder_id_str, message_id));
    let remux_tmp = remux_dir.join(format!("{}_{}.mp4.tmp", folder_id_str, message_id));

    // ── Phase 1: If remuxed MP4 already cached, serve it with byte-range ──
    if remux_path.exists() {
        let file_size = match std::fs::metadata(&remux_path) {
            Ok(m) => m.len(),
            Err(_) => return HttpResponse::InternalServerError().body("Failed to read remux cache"),
        };
        log::info!("[REMUX] msg {}: serving cached remux ({:.1} MB)", message_id, file_size as f64 / 1e6);
        return serve_local_file(&req, &remux_path, file_size, "video/mp2t");
    }

    // ── Check stream cache availability ──
    let cache_path = if let Some(ref cache_mgr) = **cache {
        cache_mgr.data_path(message_id)
    } else {
        std::path::PathBuf::new()
    };
    let cache_available = if let Some(ref cache_mgr) = **cache {
        let _lock = cache_mgr.lock_meta(message_id).await;
        let meta = cache_mgr.load_meta(message_id);
        drop(_lock);
        match meta {
            Some(m) => {
                let total_cached: u64 = m.cached_ranges.iter().map(|r| r.1 - r.0 + 1).sum();
                total_cached >= size.saturating_sub(1)
            }
            None => false,
        }
    } else {
        false
    };

    // Resolve input source (shared between ffprobe and ffmpeg)
    let input_source: String;
    if cache_available && cache_path.exists() {
        log::info!("[REMUX] msg {}: using cached file {:?}", message_id, cache_path);
        input_source = cache_path.to_string_lossy().to_string();
    } else {
        let token = query.token.as_deref().unwrap_or("");
        input_source = format!("http://127.0.0.1:{}/stream/{}/{}?token={}", crate::STREAM_PORT, folder_id_str, message_id, token);
        log::info!("[REMUX] msg {}: using stream URL", message_id);
    }

    // ── Phase 2a: ffprobe for stream indices + duration ──
    // Identify real video/audio streams (skip ID3 fake audio in Telegram TS).
    // Use small probesize for fast detection (~2-3s).

    let probe_output = TokioCommand::new("ffprobe")
        .args([
            "-hide_banner", "-loglevel", "error",
            "-print_format", "json",
            "-show_streams", "-show_format",
            // Use LARGE probesize (matching ffmpeg's 50MB) to discover ALL streams
            // including sparse ID3 streams. Small probesize misses late streams,
            // causing index mismatch between ffprobe and ffmpeg.
            "-probesize", "50000000", "-analyzeduration", "50000000",
            &input_source,
        ])
        .output()
        .await;

    let mut video_stream_idx: i32 = 0;
    let mut audio_stream_idx: i32 = 1;
    let mut probed_duration: f64 = 0.0;

    match probe_output {
        Ok(output) if output.status.success() => {
            let json_str = String::from_utf8_lossy(&output.stdout);
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                if let Some(streams) = val.get("streams").and_then(|s| s.as_array()) {
                    let mut found_video = false;
                    let mut found_audio = false;
                    for stream in streams {
                        let idx = stream.get("index").and_then(|i| i.as_i64()).unwrap_or(-1);
                        let codec_type = stream.get("codec_type").and_then(|t| t.as_str()).unwrap_or("");
                        let codec_name = stream.get("codec_name").and_then(|n| n.as_str()).unwrap_or("");
                        let channels = stream.get("channels").and_then(|c| c.as_i64()).unwrap_or(0);

                        if codec_type == "video" && !found_video {
                            video_stream_idx = idx as i32;
                            found_video = true;
                            log::info!("[REMUX-PROBE] msg {}: video stream idx={}", message_id, idx);
                        }
                        if codec_type == "audio" && !found_audio && channels > 0 && codec_name != "id3" {
                            audio_stream_idx = idx as i32;
                            found_audio = true;
                            log::info!("[REMUX-PROBE] msg {}: audio stream idx={} (codec={}, ch={})", message_id, idx, codec_name, channels);
                        }
                    }
                    if !found_audio {
                        log::warn!("[REMUX-PROBE] msg {}: no real audio stream found, using idx={}", message_id, audio_stream_idx);
                    }
                }
                // Get duration from format
                if let Some(dur_str) = val.get("format").and_then(|f| f.get("duration")).and_then(|d| d.as_str()) {
                    if let Ok(dur) = dur_str.parse::<f64>() {
                        if dur > 0.0 {
                            probed_duration = dur;
                            log::info!("[REMUX-PROBE] msg {}: ffprobe duration={:.1}s", message_id, dur);
                        }
                    }
                }
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!("[REMUX-PROBE] msg {}: ffprobe failed: {}", message_id, stderr.trim());
        }
        Err(e) => {
            log::warn!("[REMUX-PROBE] msg {}: ffprobe spawn failed: {}", message_id, e);
        }
    }

    // ── Phase 2b: Choose strategy based on cache availability ──

    if cache_available {
        // ══════════════════════════════════════════════════════════════════
        // STRATEGY A: File is fully cached locally → remux to disk with faststart
        // This gives: correct moov duration, byte-range seeking, instant serve
        // Wait time: ~10-15s for remux, but PERFECT result.
        // ══════════════════════════════════════════════════════════════════

        log::info!("[REMUX] msg {}: file cached — remuxing to disk with faststart (video_idx={}, audio_idx={})...",
            message_id, video_stream_idx, audio_stream_idx);

        let mut cmd = TokioCommand::new("ffmpeg");
        cmd.args([
            "-hide_banner",
            "-loglevel", "warning",
            "-i", &input_source,
            "-map", "0:v:0", "-map", "0:a:0",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-f", "mpegts",
            "-mpegts_flags", "resend_headers",
        ]);
        cmd.arg(&remux_tmp);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());

        let t0 = std::time::Instant::now();
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                log::error!("[REMUX] msg {}: failed to spawn ffmpeg: {}", message_id, e);
                return HttpResponse::InternalServerError().body(format!("Failed to spawn ffmpeg: {}", e));
            }
        };

        // Read stderr in background
        let stderr = child.stderr.take();
        let msg_id_log = message_id;
        tokio::spawn(async move {
            if let Some(stderr) = stderr {
                use tokio::io::AsyncReadExt;
                let mut buf = [0u8; 4096];
                let mut stderr_reader = stderr;
                loop {
                    match stderr_reader.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let s = String::from_utf8_lossy(&buf[..n]);
                            for line in s.lines() {
                                if !line.is_empty() {
                                    log::warn!("[REMUX] ffmpeg (msg {}): {}", msg_id_log, line);
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        });

        // Wait for ffmpeg to complete
        match child.wait().await {
            Ok(status) if status.success() => {
                let elapsed = t0.elapsed();
                if let Err(e) = std::fs::rename(&remux_tmp, &remux_path) {
                    if std::fs::copy(&remux_tmp, &remux_path).is_ok() {
                        let _ = std::fs::remove_file(&remux_tmp);
                    } else {
                        let _ = std::fs::remove_file(&remux_tmp);
                        log::error!("[REMUX] msg {}: failed to save cache: {}", message_id, e);
                        return HttpResponse::InternalServerError().body("Failed to save remuxed file");
                    }
                }
                let file_size = match std::fs::metadata(&remux_path) {
                    Ok(m) => m.len(),
                    Err(_) => 0,
                };
                log::info!("[REMUX] msg {}: faststart remux complete in {:.1}s ({:.1} MB), serving with byte-range",
                    message_id, elapsed.as_secs_f64(), file_size as f64 / 1e6);
                serve_local_file(&req, &remux_path, file_size, "video/mp2t")
            }
            Ok(status) => {
                let _ = std::fs::remove_file(&remux_tmp);
                log::error!("[REMUX] msg {}: ffmpeg failed: {}", message_id, status);
                HttpResponse::InternalServerError().body(format!("ffmpeg remux failed: {}", status))
            }
            Err(e) => {
                let _ = std::fs::remove_file(&remux_tmp);
                log::error!("[REMUX] msg {}: ffmpeg wait error: {}", message_id, e);
                HttpResponse::InternalServerError().body(format!("ffmpeg error: {}", e))
            }
        }
    } else {
        // ══════════════════════════════════════════════════════════════════
        // STRATEGY B: File NOT fully cached → stream piped fMP4 immediately
        // + start background disk remux for next play
        //
        // Piped fMP4 starts playing instantly but has limitations:
        //   - moov has duration=0 (empty_moov) → Chrome shows "live" duration
        //   - No Content-Length → no byte-range seeking
        // The frontend MUST override the player UI duration from metadata.
        // Next play uses the background disk cache (faststart = correct moov).
        // ══════════════════════════════════════════════════════════════════

        log::info!("[REMUX] msg {}: file NOT cached — streaming fMP4 immediately + background disk remux (video_idx={}, audio_idx={}, duration={:.1}s)",
            message_id, video_stream_idx, audio_stream_idx, probed_duration);

        let mut cmd = TokioCommand::new("ffmpeg");
        cmd.args(["-hide_banner", "-loglevel", "warning"]);
        // If ss (seek start) is provided, add -ss BEFORE -i for fast input seeking
        let ss_secs = query.ss.unwrap_or(0.0);
        if ss_secs > 0.0 {
            let ss_str = format!("{:.3}", ss_secs);
            log::info!("[REMUX] msg {}: seeking to {}s before remux", message_id, ss_str);
            cmd.args(["-ss", &ss_str]);
        }
        // +genpts: regenerate PTS from DTS (fixes non-monotonic audio timestamps)
        // +discardcorrupt: drop damaged packets before they reach the filter chain
        cmd.args([
            "-fflags", "+genpts+discardcorrupt",
            "-i", &input_source,
            "-map", "0:v:0", "-map", "0:a:0",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            // asetpts=N/SR/TB: force monotonically increasing audio PTS by construction.
            // The source TS has AAC frames with overlapping PTS that crash the mpegts
            // output muxer. This filter rewrites PTS from sample count, guaranteeing
            // forward progression regardless of source corruption.
            "-af", "asetpts=N/SR/TB",
        ]);
        // Preserve original timestamps so MSE timeline matches video.currentTime
        if ss_secs > 0.0 {
            cmd.args(["-copyts", "-start_at_zero"]);
        }
        cmd.args([
            // Disable interleave check: prevent muxer from rejecting audio packets
            // that arrive slightly out-of-order relative to video DTS
            "-max_interleave_delta", "0",
            "-f", "mpegts",
            "-mpegts_flags", "resend_headers",
            "-",
        ]);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                log::error!("[REMUX] msg {}: failed to spawn ffmpeg: {}", message_id, e);
                return HttpResponse::InternalServerError().body(format!("Failed to spawn ffmpeg: {}", e));
            }
        };

        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                log::error!("[REMUX] msg {}: ffmpeg stdout not captured", message_id);
                let _ = child.kill().await;
                return HttpResponse::InternalServerError().body("ffmpeg stdout not captured");
            }
        };

        // Read stderr in background
        let stderr = child.stderr.take();
        let msg_id_log = message_id;
        tokio::spawn(async move {
            if let Some(stderr) = stderr {
                use tokio::io::AsyncReadExt;
                let mut buf = [0u8; 4096];
                let mut stderr_reader = stderr;
                loop {
                    match stderr_reader.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let s = String::from_utf8_lossy(&buf[..n]);
                            for line in s.lines() {
                                if !line.is_empty() {
                                    log::warn!("[REMUX] ffmpeg (msg {}): {}", msg_id_log, line);
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        });

        // Stream ffmpeg stdout as HTTP response
        use tokio::io::AsyncReadExt;
        let mut reader = stdout;
        let message_id_stream = message_id;

        let stream = async_stream::stream! {
            let mut buf = vec![0u8; 65536];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => {
                        log::info!("[REMUX] msg {}: fMP4 stream complete", message_id_stream);
                        break;
                    }
                    Ok(n) => {
                        yield Ok::<web::Bytes, std::io::Error>(web::Bytes::from(buf[..n].to_vec()));
                    }
                    Err(e) => {
                        log::error!("[REMUX] msg {}: ffmpeg read error: {}", message_id_stream, e);
                        yield Err(e);
                        break;
                    }
                }
            }
            // After piped stream completes, start background disk remux with faststart
            // for next play (correct duration + byte-range seeking).
            match child.wait().await {
                Ok(status) if status.success() => {
                    log::info!("[REMUX] msg {}: piped stream done, starting background faststart remux", message_id_stream);
                    let bg_input = input_source.clone();
                    let bg_remux_path = remux_path.clone();
                    let bg_remux_tmp = remux_tmp.clone();
                    let bg_vid_idx = video_stream_idx;
                    let bg_aud_idx = audio_stream_idx;
                    tokio::spawn(async move {
                        // Small delay to let stream cache cool down
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        let mut bg_cmd = TokioCommand::new("ffmpeg");
                        bg_cmd.args([
                            "-hide_banner", "-loglevel", "warning",
                            "-ignore_unknown",
                            "-fflags", "+genpts+discardcorrupt",
                            "-probesize", "50000000", "-analyzeduration", "50000000",
                            "-i", &bg_input,
                        ]);
                        bg_cmd.args(["-map", &format!("0:{}", bg_vid_idx)]);
                        bg_cmd.args(["-map", &format!("0:{}", bg_aud_idx)]);
                        bg_cmd.args([
                            "-sn",
                            "-c:v", "copy", "-c:a", "copy",
                            "-bsf:a", "aac_adtstoasc",
                            "-f", "mp4",
                            "-movflags", "+faststart",
                        ]);
                        bg_cmd.arg(&bg_remux_tmp);
                        bg_cmd.stdout(std::process::Stdio::null());
                        bg_cmd.stderr(std::process::Stdio::null());
                        match bg_cmd.status().await {
                            Ok(status) if status.success() => {
                                if let Err(e) = std::fs::rename(&bg_remux_tmp, &bg_remux_path) {
                                    if std::fs::copy(&bg_remux_tmp, &bg_remux_path).is_ok() {
                                        let _ = std::fs::remove_file(&bg_remux_tmp);
                                    } else {
                                        let _ = std::fs::remove_file(&bg_remux_tmp);
                                        log::error!("[REMUX-BG] failed to save cache: {}", e);
                                    }
                                }
                                log::info!("[REMUX-BG] faststart disk cache ready for next play");
                            }
                            Ok(status) => {
                                log::error!("[REMUX-BG] ffmpeg failed: {}", status);
                                let _ = std::fs::remove_file(&bg_remux_tmp);
                            }
                            Err(e) => {
                                log::error!("[REMUX-BG] spawn failed: {}", e);
                            }
                        }
                    });
                }
                Ok(status) => {
                    log::warn!("[REMUX] msg {}: ffmpeg exited with error: {}, skipping background remux", message_id_stream, status);
                }
                Err(e) => {
                    log::warn!("[REMUX] msg {}: ffmpeg wait error: {}, skipping background remux", message_id_stream, e);
                }
            }
        };

        // Build response — include duration header for frontend override.
        // Content-Type is video/mp2t (MPEG-TS) because ffmpeg outputs -f mpegts.
        // mpegts.js parses raw bytes and ignores Content-Type, so this is
        // technically cosmetic — but correct labeling prevents confusion and
        // makes the native <video> fallback fail fast instead of silently.
        let mut response = HttpResponse::Ok();
        response.insert_header(("Content-Type", "video/mp2t"));
        response.insert_header(("Cache-Control", "no-cache"));
        response.insert_header(("X-Remuxed", "true"));
        if probed_duration > 0.0 {
            response.insert_header(("X-Video-Duration", format!("{:.3}", probed_duration)));
        }
        response.streaming(stream)
    }
}

/// Serve a local file with HTTP byte-range support.
/// This gives the browser the same experience as a local video file:
/// - Content-Length header → browser knows total size
/// - Accept-Ranges + Range handling → seeking works
/// - moov at the beginning (faststart) → duration shows immediately
fn serve_local_file(req: &HttpRequest, path: &std::path::Path, file_size: u64, content_type: &str) -> HttpResponse {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let range_header = req.headers().get("Range").and_then(|v| v.to_str().ok());

    if let Some(range_str) = range_header {
        if let Some((start, end)) = parse_range_header(range_str, file_size) {
            let content_length = end - start + 1;
            let file = match std::fs::File::open(path) {
                Ok(f) => f,
                Err(e) => return HttpResponse::InternalServerError().body(format!("Failed to open file: {}", e)),
            };

            let stream = async_stream::stream! {
                let mut reader = tokio::fs::File::from_std(file);
                // Seek to start position
                if let Err(e) = reader.seek(std::io::SeekFrom::Start(start)).await {
                    yield Err(std::io::Error::new(std::io::ErrorKind::Other, e));
                    return;
                }
                let mut remaining = content_length;
                let mut buf = vec![0u8; 65536];
                while remaining > 0 {
                    let to_read = std::cmp::min(remaining, buf.len() as u64) as usize;
                    match reader.read(&mut buf[..to_read]).await {
                        Ok(0) => break,
                        Ok(n) => {
                            remaining -= n as u64;
                            yield Ok::<web::Bytes, std::io::Error>(web::Bytes::from(buf[..n].to_vec()));
                        }
                        Err(e) => {
                            yield Err(e);
                            break;
                        }
                    }
                }
            };

            return HttpResponse::PartialContent()
                .insert_header(("Content-Type", content_type))
                .insert_header(("Content-Length", content_length))
                .insert_header(("Content-Range", format!("bytes {}-{}/{}", start, end, file_size)))
                .insert_header(("Accept-Ranges", "bytes"))
                .insert_header(("Cache-Control", "max-age=86400"))
                .streaming(stream);
        }
    }

    // Full file request — stream entire file
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return HttpResponse::InternalServerError().body(format!("Failed to open file: {}", e)),
    };

    let stream = async_stream::stream! {
        let mut reader = tokio::fs::File::from_std(file);
        let mut buf = vec![0u8; 65536];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    yield Ok::<web::Bytes, std::io::Error>(web::Bytes::from(buf[..n].to_vec()));
                }
                Err(e) => {
                    yield Err(e);
                    break;
                }
            }
        }
    };

    HttpResponse::Ok()
        .insert_header(("Content-Type", content_type))
        .insert_header(("Content-Length", file_size))
        .insert_header(("Accept-Ranges", "bytes"))
        .insert_header(("Cache-Control", "max-age=86400"))
        .streaming(stream)
}

#[get("/fmp4/init/{folder_id}/{message_id}")]
async fn fmp4_init(
    path: web::Path<(String, i32)>,
    query: web::Query<Fmp4Query>,
    _data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
    fmp4_cache: web::Data<Fmp4InitCacheData>,
    stream_info_cache: web::Data<Fmp4StreamInfoCacheData>,
) -> impl Responder {
    let (_folder_id_str, message_id) = path.into_inner();

    match &query.token {
        Some(t) if constant_time_eq::constant_time_eq(t.as_bytes(), token_data.token.as_bytes()) => {},
        _ => {
            log::error!("[FMP4-INIT] Invalid or missing stream token for msg {}", message_id);
            return HttpResponse::Forbidden().body("Invalid or missing stream token");
        }
    }

    {
        let cache_lock = fmp4_cache.0.lock().ok();
        if let Some(ref cache) = cache_lock {
            if let Some(cached) = cache.cache.get(&message_id) {
                log::info!("[FMP4-INIT] Cache HIT for msg {}", message_id);
                return HttpResponse::Ok()
                    .insert_header(("Content-Type", "video/mp4"))
                    .insert_header(("X-Cache", "HIT"))
                    .body(cached.clone());
            }
        }
    }

    let cache_mgr = match (**cache).as_ref() {
        Some(cm) => cm.clone(),
        None => {
            log::error!("[FMP4-INIT] No cache manager for msg {}", message_id);
            return HttpResponse::ServiceUnavailable().body("No cache manager");
        }
    };

    let data_path = cache_mgr.data_path(message_id);
    let mut ts_data = {
        let _lock = cache_mgr.lock_meta(message_id).await;
        let meta = cache_mgr.load_meta(message_id);
        drop(_lock);

        match meta {
            Some(m) => {
                let scan_end = 5 * 1024 * 1024;
                let read_end = scan_end.min(m.total_size as usize);
                let mut file = match std::fs::File::open(&data_path) {
                    Ok(f) => f,
                    Err(e) => {
                        log::error!("[FMP4-INIT] Failed to open data file for msg {}: {}", message_id, e);
                        return HttpResponse::NotFound().body("Data file not found");
                    }
                };
                let mut buf = vec![0u8; read_end];
                match file.read_exact(&mut buf) {
                    Ok(()) => buf,
                    Err(e) => {
                        log::warn!("[FMP4-INIT] Partial read for msg {} ({}): {}", message_id, read_end, e);
                        let actual = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
                        let actual_end = actual.min(read_end);
                        buf.truncate(actual_end);
                        if buf.is_empty() {
                            return HttpResponse::NotFound().body("No TS data available");
                        }
                        buf
                    }
                }
            }
            None => {
                return HttpResponse::NotFound().body("No cache meta found");
            }
        }
    };

    // Detect and handle M2TS format
    let (_, is_m2ts) = detect_ts_packet_size(&data_path)
        .unwrap_or((188, false));
    if is_m2ts {
        ts_data = strip_m2ts_prefix(&ts_data, true);
    }

    let stream_info = match extract_stream_info(&ts_data) {
        Some(si) => si,
        None => {
            log::error!("[FMP4-INIT] Failed to extract stream info from first 5MB for msg {}", message_id);
            return HttpResponse::InternalServerError().body("Failed to extract stream info");
        }
    };

    // Cache stream info for use by fmp4_segment (which reads mid-stream data without PAT/PMT)
    if let Ok(mut c) = stream_info_cache.0.lock() {
        c.cache.insert(message_id, stream_info.clone());
    }

    let mut demuxer = TsDemuxer::new().with_stream_info(stream_info.clone());
    demuxer.feed(&ts_data);
    demuxer.flush();

    let mut video_config = demuxer.video_codec_config().cloned();
    let mut audio_config = demuxer.audio_codec_config().cloned();

    if video_config.is_none() || audio_config.is_none() {
        let meta = cache_mgr.load_meta(message_id);
        let total_size = meta.as_ref().map(|m| m.total_size).unwrap_or(0);
        let max_scan = 25 * 1024 * 1024;
        let mut scan_offset = 5 * 1024 * 1024;

        while (video_config.is_none() || audio_config.is_none()) && scan_offset < max_scan as u64 && scan_offset < total_size {
            let chunk_size = 2 * 1024 * 1024;
            let read_end = (scan_offset as usize + chunk_size).min(total_size as usize);

            let _lock = cache_mgr.lock_meta(message_id).await;
            let m = cache_mgr.load_meta(message_id);
            drop(_lock);

            if let Some(m) = &m {
                if !is_range_cached(&m.cached_ranges, scan_offset, read_end as u64 - 1) {
                    scan_offset += chunk_size as u64;
                    continue;
                }
            }

            let mut file = match std::fs::File::open(&data_path) {
                Ok(f) => f,
                Err(_) => break,
            };
            let mut chunk = vec![0u8; read_end - scan_offset as usize];
            if file.seek(SeekFrom::Start(scan_offset)).is_err() { break; }
            if file.read_exact(&mut chunk).is_err() { break; }

            let stripped_chunk = strip_m2ts_prefix(&chunk, is_m2ts);
            ts_data.extend_from_slice(&stripped_chunk);
            demuxer.feed(&stripped_chunk);

            if video_config.is_none() {
                video_config = demuxer.video_codec_config().cloned();
            }
            if audio_config.is_none() {
                audio_config = demuxer.audio_codec_config().cloned();
            }

            scan_offset += chunk_size as u64;
        }
    }

    let video = match video_config {
        Some(v) => v,
        None => {
            log::error!("[FMP4-INIT] Video codec config not found for msg {}", message_id);
            return HttpResponse::InternalServerError().body("Video codec config not found");
        }
    };
    let audio = match audio_config {
        Some(a) => a,
        None => {
            log::error!("[FMP4-INIT] Audio codec config not found for msg {}", message_id);
            return HttpResponse::InternalServerError().body("Audio codec config not found");
        }
    };

    let init_seg = build_init_segment(&video, &audio);

    if let Ok(mut c) = fmp4_cache.0.lock() {
        c.cache.insert(message_id, init_seg.data.clone());
    }

    let meta = cache_mgr.load_meta(message_id);
    let total_size = meta.as_ref().map(|m| m.total_size).unwrap_or(0);

    HttpResponse::Ok()
        .insert_header(("Content-Type", "video/mp4"))
        .insert_header(("X-Mime-Type", init_seg.mime_type.as_str()))
        .insert_header(("X-Video-Codec", init_seg.video_codec_string.as_str()))
        .insert_header(("X-Audio-Codec", init_seg.audio_codec_string.as_str()))
        .insert_header(("X-Total-File-Size", total_size.to_string()))
        .insert_header(("X-Cache", "MISS"))
        .body(init_seg.data)
}

#[get("/fmp4/segment/{folder_id}/{message_id}")]
async fn fmp4_segment(
    path: web::Path<(String, i32)>,
    query: web::Query<Fmp4Query>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
    _fmp4_cache: web::Data<Fmp4InitCacheData>,
    stream_info_cache: web::Data<Fmp4StreamInfoCacheData>,
    byte_time_cache: web::Data<Fmp4ByteTimeCacheData>,
    _demuxer_cache: web::Data<Fmp4DemuxerCacheData>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    match &query.token {
        Some(t) if constant_time_eq::constant_time_eq(t.as_bytes(), token_data.token.as_bytes()) => {},
        _ => {
            log::error!("[FMP4-SEG] Invalid or missing stream token for msg {}", message_id);
            return HttpResponse::Forbidden().body("Invalid or missing stream token");
        }
    }

    let cache_mgr = match (**cache).as_ref() {
        Some(cm) => cm.clone(),
        None => {
            log::error!("[FMP4-SEG] No cache manager for msg {}", message_id);
            return HttpResponse::ServiceUnavailable().body("No cache manager");
        }
    };

    let target_duration = query.duration.unwrap_or(5.0).min(30.0).max(0.5);

    let _lock = cache_mgr.lock_meta(message_id).await;
    let meta = cache_mgr.load_meta(message_id);
    drop(_lock);

    let meta = match meta {
        Some(m) => m,
        None => {
            log::error!("[FMP4-SEG] No cache meta for msg {}", message_id);
            return HttpResponse::NotFound().body("No cache meta");
        }
    };
    let total_size = meta.total_size;

    // Determine start_offset: either from byte_offset (for seeks) or from
    // time→byte_offset lookup using the keyframe scan infrastructure.
    // When `time` is provided without `byte_offset`, we use the Fmp4ByteTimeCache
    // to find the correct byte position, rather than the old imprecise
    // time*bitrate formula.
    let start_offset = match query.byte_offset {
        Some(off) => off,
        None => {
            let time_s = query.time.unwrap_or(0.0);

            // Check Fmp4ByteTimeCache for this message_id
            let kf_entries: Option<Vec<(f64, u64)>> = {
                let cache_lock = byte_time_cache.0.lock().ok();
                if let Some(ref cache) = cache_lock {
                    cache.cache.get(&message_id).map(|e| e.samples.clone())
                } else {
                    None
                }
            };

            let entries = match kf_entries {
                Some(e) if !e.is_empty() => e,
                _ => {
                    // No cached entries — trigger a keyframe scan of cached data
                    // (same logic as fmp4_keyframes endpoint)
                    let data_path = cache_mgr.data_path(message_id);
                    let (_ts_packet_size, is_m2ts) = match detect_ts_packet_size(&data_path) {
                        Some(result) => result,
                        None => (188, false),
                    };

                    let _lock2 = cache_mgr.lock_meta(message_id).await;
                    let m = cache_mgr.load_meta(message_id);
                    drop(_lock2);

                    let scan_ranges: Vec<(u64, u64)> = match &m {
                        Some(m) if m.cached_bytes() >= m.total_size => {
                            vec![(0, m.total_size.saturating_sub(1))]
                        }
                        Some(m) => m.cached_ranges.clone(),
                        None => Vec::new(),
                    };

                    let mut all_kfs: Vec<(f64, u64)> = Vec::new();

                    // Read first portion to extract stream info
                    let first_read_end = (5 * 1024 * 1024).min(total_size as usize);
                    if first_read_end > 0 {
                        let mut first_buf = vec![0u8; first_read_end];
                        if let Ok(mut file) = std::fs::File::open(&data_path) {
                            if file.read_exact(&mut first_buf).is_ok() {
                                let first_ts = if is_m2ts {
                                    strip_m2ts_prefix(&first_buf, true)
                                } else {
                                    first_buf
                                };

                                if let Some(si) = extract_stream_info(&first_ts) {
                                    let chunk_read_size = 2 * 1024 * 1024;
                                    let mut scan_state = KeyframeScanState::default();

                                    for (range_start, range_end) in &scan_ranges {
                                        let mut offset = *range_start;
                                        while offset <= *range_end {
                                            let read_end = (offset as usize + chunk_read_size).min(*range_end as usize + 1);
                                            let read_len = read_end.saturating_sub(offset as usize);
                                            if read_len == 0 { break; }
                                            let mut file2 = match std::fs::File::open(&data_path) {
                                                Ok(f) => f,
                                                Err(_) => break,
                                            };
                                            if file2.seek(SeekFrom::Start(offset)).is_err() { break; }
                                            let mut chunk = vec![0u8; read_len];
                                            if file2.read_exact(&mut chunk).is_err() { break; }

                                            let chunk_ts = if is_m2ts {
                                                strip_m2ts_prefix(&chunk, true)
                                            } else {
                                                chunk
                                            };

                                            let kfs = scan_keyframes_chunked(&chunk_ts, offset, &si, &mut scan_state);
                                            all_kfs.extend_from_slice(&kfs);
                                            offset = read_end as u64;
                                        }
                                    }

                                    // Flush remaining PES buffers
                                    let flush_kfs = scan_keyframes_flush(0, &si, &mut scan_state);
                                    all_kfs.extend_from_slice(&flush_kfs);

                                    // Sort and dedup
                                    all_kfs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
                                    all_kfs.dedup_by(|a, b| (a.0 - b.0).abs() < 0.001 && a.1 == b.1);
                                }
                            }
                        }
                    }

                    // Cache the results for future time→byte lookups
                    if !all_kfs.is_empty() {
                        if let Ok(mut c) = byte_time_cache.0.lock() {
                            let fully_cached = m.as_ref().map(|mm| mm.cached_bytes() >= mm.total_size).unwrap_or(false);
                            let entry = ByteTimeCacheEntry {
                                samples: all_kfs.clone(),
                                covered_ranges: scan_ranges.clone(),
                                total_size,
                                complete: fully_cached,
                            };
                            c.cache.insert(message_id, entry);
                        }
                    }

                    all_kfs
                }
            };

            // Binary search for the nearest keyframe with timestamp <= time_s
            if entries.is_empty() {
                // No keyframes found — fall back to byte 0 for time=0,
                // or proportional estimate for other times
                if time_s <= 0.0 {
                    0u64
                } else if total_size > 0 {
                    // Proportional estimate using file size.
                    // Without duration in CacheMeta, use a reasonable default
                    // bitrate of 500KB/s (typical for 4Mbps video).
                    // This is only used when no keyframes are found in cached data.
                    let bitrate_bytes = 500_000.0; // ~500KB/s default
                    (time_s * bitrate_bytes) as u64
                } else {
                    0u64
                }
            } else {
                // Binary search: find last entry with timestamp <= time_s
                let mut lo = 0usize;
                let mut hi = entries.len();
                while lo < hi {
                    let mid = lo + (hi - lo) / 2;
                    if entries[mid].0 <= time_s {
                        lo = mid + 1;
                    } else {
                        hi = mid;
                    }
                }
                if lo > 0 {
                    entries[lo - 1].1
                } else {
                    0u64
                }
            }
        }
    };

    // The requested time for PTS filtering (used when align=none for
    // sequential playback to avoid overlaps with previous segment).
    // When byte_offset is provided with align=none, we still use the
    // time param (if provided) for overlap filtering — byte_offset
    // determines WHERE to read, time determines WHICH frames to keep.
    // When byte_offset is provided with align=keyframe (seek), no
    // time-based filtering is needed — keyframe alignment handles it.
    let align_keyframe = query.align.as_deref() != Some("none");
    let _requested_time_s = match (query.byte_offset, query.time, align_keyframe) {
        // No byte_offset: use time for PTS filtering (original behavior)
        (None, Some(t), _) => t,
        (None, None, _) => 0.0,
        // byte_offset + keyframe alignment (seek): no time-based filtering
        (Some(_), _, true) => 0.0,
        // byte_offset + align=none (sequential playback): use time for
        // overlap filtering if provided; otherwise no filtering
        (Some(_), Some(t), false) => t,
        (Some(_), None, false) => 0.0,
    };

    if start_offset >= total_size {
        return HttpResponse::RangeNotSatisfiable()
            .insert_header(("Content-Range", format!("bytes */{}", total_size)))
            .body("Offset beyond file");
    }

    let overlap = 2 * 1024 * 1024; // 2MB: enough to cover one GOP at ~500KB/s
    let read_start = start_offset.saturating_sub(overlap);

    let estimated_bytes = (target_duration * 500_000.0 * 2.5) as u64; // 2.5x for initial I-frame overhead
    let read_end = (start_offset + estimated_bytes).min(total_size - 1);

    if !is_range_cached(&meta.cached_ranges, read_start, read_end) {
        let dl_info = cache_mgr.find_best_covering_download(message_id, read_start, read_end).await;
        let mut need_own_download = false;

        if let Some(dl) = &dl_info {
            let mut progress_rx = dl.progress_rx.clone();
            let cancel_flag = dl.cancel_flag.clone();
            let timeout = tokio::time::Instant::now() + std::time::Duration::from_secs(20);

            loop {
                let progress = *progress_rx.borrow();

                // Check if the range is now fully cached
                if is_range_cached(
                    &cache_mgr.load_meta(message_id).map(|m| m.cached_ranges).unwrap_or_default(),
                    read_start, read_end
                ) {
                    break;
                }

                // Download has progressed past our range end — data should be cached
                if progress >= read_end {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    break;
                }

                // Timeout — if download hasn't reached read_start yet, fall through
                // to own-download. If it has reached read_start but range isn't cached,
                // return 503 (same as original behavior).
                if tokio::time::Instant::now() >= timeout {
                    if progress < read_start {
                        log::warn!("[FMP4-SEG] Timeout waiting for download to reach read_start {} (progress={}) for msg {}", read_start, progress, message_id);
                        need_own_download = true;
                    } else {
                        log::warn!("[FMP4-SEG] Timeout waiting for cache fill for msg {}", message_id);
                        return HttpResponse::ServiceUnavailable()
                            .insert_header(("Retry-After", "2"))
                            .body("Waiting for download");
                    }
                    break;
                }

                // Download was cancelled — fall through to own-download
                if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    log::info!("[FMP4-SEG] Active download cancelled for msg {}, falling through to own-download", message_id);
                    need_own_download = true;
                    break;
                }

                // Wait for progress update
                match progress_rx.changed().await {
                    Ok(()) => {},
                    Err(_) => {
                        // Download ended (sender dropped). Check if range is cached
                        // before falling through.
                        if is_range_cached(
                            &cache_mgr.load_meta(message_id).map(|m| m.cached_ranges).unwrap_or_default(),
                            read_start, read_end
                        ) {
                            break;
                        }
                        log::info!("[FMP4-SEG] Active download ended for msg {}, falling through to own-download", message_id);
                        need_own_download = true;
                        break;
                    }
                }
            }
        }

        if need_own_download || dl_info.is_none() {
            let client_guard = { data.client.lock().await.clone() };
            if let Some(client) = client_guard {
                let (media, _) = match resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &StreamQuery { token: query.token.clone(), cached_only: Some(false), duration: None, source_id: None, max_bytes: None, ss: None }).await {
                    Ok(result) => result,
                    Err(resp) => return resp,
                };

                let chunks_to_skip = (read_start / TELEGRAM_CHUNK_SIZE as u64) as i32;
                let bytes_to_discard = read_start % TELEGRAM_CHUNK_SIZE as u64;
                let download_iter = client.iter_download(&media)
                    .chunk_size(TELEGRAM_CHUNK_SIZE)
                    .skip_chunks(chunks_to_skip);

                let mut cache_file = match cache_mgr.open_data_file_write(message_id) {
                    Ok(f) => f,
                    Err(e) => {
                        log::error!("[FMP4-SEG] Failed to open cache file for msg {}: {}", message_id, e);
                        return HttpResponse::InternalServerError().body("Cache file error");
                    }
                };

                // Blocking acquire — with Semaphore(2), /stream and fMP4 segment
                // downloads can run concurrently. The 250ms rate limiter spaces API calls.
                // Thumbnail downloads briefly pause /stream (400ms per chunk),
                // but the 180s buffer ahead absorbs this.
                let mut iter = download_iter;
                let mut offset = read_start;
                let mut first_chunk = true;
                let download_end = read_end;
                let mut fmp4_retries = 0u32;

                loop {
                    let chunk_result = {
                        let _permit = data.download_semaphore.acquire().await.unwrap();
                        throttle_api_calls(&data.rate_limiter).await;
                        iter.next().await
                    };
                    match chunk_result.transpose() {
                        Some(Ok(bytes)) => {
                            let mut chunk_data = bytes;
                            if first_chunk && bytes_to_discard > 0 {
                                let discard = bytes_to_discard.min(chunk_data.len() as u64) as usize;
                                chunk_data = chunk_data[discard..].to_vec();
                                first_chunk = false;
                            }
                            let remaining = download_end - offset + 1;
                            let final_data = if chunk_data.len() as u64 > remaining {
                                chunk_data[..remaining as usize].to_vec()
                            } else {
                                chunk_data
                            };
                            let bytes_in_chunk = final_data.len() as u64;
                            let chunk_range_end = offset + bytes_in_chunk - 1;

                            let _ = cache_file.seek(SeekFrom::Start(offset));
                            let _ = cache_file.write_all(&final_data);

                            let _lock = cache_mgr.lock_meta(message_id).await;
                            let mut m = cache_mgr.load_meta(message_id).unwrap_or(CacheMeta {
                                message_id,
                                folder_id: folder_id_str.parse::<i64>().unwrap_or(0),
                                total_size,
                                filename: format!("{}.ts", message_id),
                                cached_ranges: Vec::new(),
                                mime_type: "video/mp2t".to_string(),
                            });
                            m.cached_ranges.push((offset, chunk_range_end));
                            merge_ranges(&mut m.cached_ranges);
                            let _ = cache_mgr.save_meta(&m);
                            drop(_lock);

                            offset += bytes_in_chunk;
                            if chunk_range_end >= download_end { break; }
                        }
                        None => break,
                        Some(Err(e)) => {
                            log::warn!("[FMP4-SEG] Download error for msg {} at offset {}: {}", message_id, offset, e);
                            fmp4_retries += 1;
                            if fmp4_retries > 3 {
                                log::error!("[FMP4-SEG] Max retries exceeded for msg {}", message_id);
                                break;
                            }
                            let backoff = 3 * (1u64 << (fmp4_retries - 1));
                            log::info!("[FMP4-SEG] Retrying in {}s (attempt {}/3)", backoff, fmp4_retries);
                            tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                            let skip_chunks = (offset / TELEGRAM_CHUNK_SIZE as u64) as i32;
                            iter = client.iter_download(&media)
                                .chunk_size(TELEGRAM_CHUNK_SIZE)
                                .skip_chunks(skip_chunks);
                            continue;
                        }
                    }
                }
            } else {
                return HttpResponse::ServiceUnavailable().body("Telegram client not connected");
            }
        }
    }

    let data_path = cache_mgr.data_path(message_id);
    let mut file = match std::fs::File::open(&data_path) {
        Ok(f) => f,
        Err(e) => {
            log::error!("[FMP4-SEG] Failed to open data file for msg {}: {}", message_id, e);
            return HttpResponse::InternalServerError().body("Data file error");
        }
    };

    let actual_read_start = read_start;
    let actual_read_end = {
        let _lock = cache_mgr.lock_meta(message_id).await;
        let m = cache_mgr.load_meta(message_id);
        drop(_lock);
        match m {
            Some(m) => {
                let mut furthest = read_end;
                for &(s, e) in &m.cached_ranges {
                    if s <= actual_read_start && e >= actual_read_start {
                        furthest = furthest.max(e);
                    } else if s > actual_read_start && s <= read_end + estimated_bytes {
                        furthest = furthest.max(e);
                    }
                }
                furthest.min(total_size - 1)
            }
            None => read_end,
        }
    };

    let capped_read_end = (start_offset + estimated_bytes).min(actual_read_end);

    // If not enough data is cached (less than 512KB past start_offset),
    // return 503 so the frontend waits for the download to progress.
    // Without this guard, we'd produce tiny zero-duration segments
    // that flood the SourceBuffer and stall playback.
    let min_required_bytes = 512 * 1024; // 512KB minimum for a useful segment
    if capped_read_end.saturating_sub(start_offset) < min_required_bytes {
        log::info!("[FMP4-SEG] Insufficient cached data for msg {} at offset {} (cached up to {}, need {} past start_offset)",
            message_id, start_offset, actual_read_end, min_required_bytes);
        return HttpResponse::ServiceUnavailable()
            .insert_header(("Retry-After", "2"))
            .body("Waiting for more data to be cached");
    }

    let read_len = (capped_read_end - actual_read_start + 1) as usize;
    let mut ts_buf = vec![0u8; read_len];
    if file.seek(SeekFrom::Start(actual_read_start)).is_err() {
        return HttpResponse::InternalServerError().body("Seek failed");
    }
    match file.read_exact(&mut ts_buf) {
        Ok(()) => {},
        Err(e) => {
            log::error!("[FMP4-SEG] Read failed for msg {}: {}", message_id, e);
            return HttpResponse::InternalServerError().body("Read failed");
        }
    }

    // Detect and handle M2TS format
    let (_, is_m2ts) = detect_ts_packet_size(&data_path)
        .unwrap_or((188, false));
    if is_m2ts {
        ts_buf = strip_m2ts_prefix(&ts_buf, true);
    }

    let stream_info = {
        let cache_lock = stream_info_cache.0.lock().ok();
        if let Some(ref cache) = cache_lock {
            if let Some(si) = cache.cache.get(&message_id) {
                si.clone()
            } else {
                // No cached stream info — try extracting from this chunk as fallback
                match extract_stream_info(&ts_buf) {
                    Some(si) => si,
                    None => {
                        log::error!("[FMP4-SEG] Failed to extract stream info for msg {} (no cache, no PAT/PMT in chunk)", message_id);
                        return HttpResponse::InternalServerError().body("Stream info extraction failed");
                    }
                }
            }
        } else {
            match extract_stream_info(&ts_buf) {
                Some(si) => si,
                None => {
                    log::error!("[FMP4-SEG] Failed to extract stream info for msg {}", message_id);
                    return HttpResponse::InternalServerError().body("Stream info extraction failed");
                }
            }
        }
    };

    // Compute overlap position in buffer (used by fresh demuxer for PES-start scan)
    let overlap_bytes_in_buf = start_offset.saturating_sub(actual_read_start) as usize;
    let feed_start_in_buf = if overlap_bytes_in_buf > 0 {
        let video_pid = stream_info.video_pid;
        let audio_pid = stream_info.audio_pid;
        let mut last_video_pes_start: Option<usize> = None;
        let mut last_audio_pes_start: Option<usize> = None;
        let mut pkt_pos = 0usize;
        while pkt_pos + 188 <= overlap_bytes_in_buf && pkt_pos + 188 <= ts_buf.len() {
            if ts_buf[pkt_pos] == 0x47 {
                let pid = ((ts_buf[pkt_pos + 1] as u16 & 0x1F) << 8) | ts_buf[pkt_pos + 2] as u16;
                let pusi = (ts_buf[pkt_pos + 1] >> 6) & 0x01;
                if pusi == 1 {
                    if pid == video_pid { last_video_pes_start = Some(pkt_pos); }
                    else if pid == audio_pid { last_audio_pes_start = Some(pkt_pos); }
                }
            }
            pkt_pos += 188;
        }
        match (last_video_pes_start, last_audio_pes_start) {
            (Some(v), Some(a)) => v.min(a),
            (Some(v), None) => v,
            (None, Some(a)) => a,
            (None, None) => 0,
        }
    } else {
        0
    };

    // FRESH DEMUXER with overlap for ALL requests.
    // Why not stateful cache (take_frames)? Because many TS streams set pusi=1
    // only at keyframes — a single video PES can span an entire GOP (4-10s).
    // take_frames() leaves this partial PES in pes_buffers; when completed
    // by the next segment, it produces ONE giant frame spanning seconds,
    // which creates a broken fMP4 sample. flush() + overlap is the only
    // reliable approach: force-complete all PES and use overlap + PES-start
    // scan to recover boundary data.
    let mut demuxer = TsDemuxer::new().with_stream_info(stream_info);
    let feed_start_in_buf_local = feed_start_in_buf;

    // Feed data to demuxer — ALWAYS flush + overlap + PES-start scan
    demuxer.feed(&ts_buf[feed_start_in_buf_local..]);
    demuxer.flush(); // Complete all PES → emit all frames

    let frames = demuxer.take_frames();
    let audio_config = demuxer.audio_codec_config().cloned();

    // Compute PTS stats from ALL frames before alignment/duration filtering.
    // These are used to calculate the actual bitrate for next_byte_offset.
    let first_all_pts = frames.first().map(|f| f.pts).unwrap_or(0);
    let last_all_pts = frames.last().map(|f| f.pts).unwrap_or(first_all_pts);
    let all_pts_span_s = (last_all_pts.saturating_sub(first_all_pts)) as f64 / 90000.0;

    // No stateful cache — always fresh demuxer with flush + overlap.
    // Overlap-region frames are filtered by min_time below.

    if frames.is_empty() {
        return HttpResponse::NoContent().body("No frames found");
    }

    // KEYFRAME ALIGNMENT: When align=keyframe (the default, used for seeks),
    // find the first video keyframe and discard all frames before it. The
    // overlap region before start_offset may contain P-frames from the previous
    // segment — including them causes duplicate timestamps and gaps in the
    // SourceBuffer timeline.
    //
    // When align=none (used for sequential playback), include frames starting
    // from the requested time T, filtering out frames from the overlap region
    // that have PTS < T (with a small tolerance of -0.5s for B-frames that
    // may reference earlier data). This prevents overlaps with the previous
    // segment while keeping the stream contiguous.
    // (align_keyframe is defined earlier, alongside requested_time_s)

    let aligned_frames: Vec<PesFrame> = if align_keyframe {
        let first_keyframe_idx = frames.iter().position(|f| {
            (f.stream_type == 0x1B || f.stream_type == 0x24) && f.is_keyframe
        });

        if let Some(idx) = first_keyframe_idx {
            // If there are audio frames before the first video keyframe, keep them
            // only if they are after the keyframe's PTS (audio after video start).
            // Audio before the video keyframe is from the overlap region and would
            // cause timeline overlaps.
            let kf_pts = frames[idx].pts;
            frames.into_iter().filter(|f| f.pts >= kf_pts).collect()
        } else {
            // No keyframe found — this chunk is mid-GOP. Return all frames
            // (the frontend will use the byte offset to skip forward).
            frames
        }
    } else {
        // Sequential (align=none): fresh demuxer with flush + overlap may produce
        // overlap-region frames before the requested time. Filter with min_time
        // to remove overlap duplicates.
        if let Some(min_t) = query.min_time {
            if min_t > 0.0 {
                let min_pts = ((min_t - 0.05) * 90000.0).max(0.0) as u64;
                frames.into_iter().filter(|f| f.pts >= min_pts).collect()
            } else {
                frames
            }
        } else {
            frames
        }
    };

    if aligned_frames.is_empty() {
        return HttpResponse::NoContent().body("No frames after keyframe alignment");
    }

    // Filter frames to the target duration, starting from the first frame
    let first_frame_pts = aligned_frames.first().map(|f| f.pts).unwrap_or(0);
    let max_end_pts = first_frame_pts + (target_duration * 90000.0) as u64;
    let kept_frames: Vec<PesFrame> = aligned_frames.into_iter().filter(|f| {
        f.pts < max_end_pts
    }).collect();

    if kept_frames.is_empty() {
        return HttpResponse::NoContent().body("No frames in time range");
    }

    // Compute the actual start time from the first video frame's PTS
    let first_video_pts = kept_frames.iter()
        .find(|f| f.stream_type == 0x1B || f.stream_type == 0x24)
        .map(|f| f.pts as f64 / 90000.0)
        .unwrap_or_else(|| kept_frames.first().map(|f| f.pts as f64 / 90000.0).unwrap_or(0.0));

    let last_frame_pts = kept_frames.last().map(|f| f.pts).unwrap_or(first_frame_pts);

    let video_timescale = 90000u32;
    let audio_timescale = audio_config.map(|c| c.sampling_freq).unwrap_or(48000);

    let segment_seq = query.segment_sequence.unwrap_or(1);

    let media_seg = match build_media_segment(&kept_frames, 1, 2, video_timescale, audio_timescale, segment_seq) {
        Some(seg) => seg,
        None => {
            return HttpResponse::NoContent().body("Failed to build media segment");
        }
    };

    let _actual_duration = media_seg.duration_s;

    // ACCURATE next_byte_offset: Based on the actual content consumed, NOT the
    // raw byte range read. The old formula used capped_read_end which advances
    // by estimated_bytes (6.25MB ≈ 12.5s at 500KB/s) even though the duration
    // filter keeps only ~5s. This caused the byte offset to overshoot by ~7.5s
    // per segment, creating growing gaps in the SourceBuffer timeline.
    //
    // Instead, compute the actual bitrate from the frames produced, then
    // advance next_byte_offset by only the bytes corresponding to the content
    // we actually kept (last_kept_pts - first_frame_pts).
    let ts_packet_size: u64 = 188;
    let next_byte_offset = {
        let bytes_fed = capped_read_end.saturating_sub(start_offset);

        if all_pts_span_s > 0.1 && bytes_fed > 0 {
            // Compute actual bitrate from this segment's data
            let bytes_per_second = bytes_fed as f64 / all_pts_span_s;
            // Advance by the bytes corresponding to the content we KEPT
            let kept_pts_span_s = (last_frame_pts.saturating_sub(first_frame_pts)) as f64 / 90000.0;
            let next_off = start_offset + (kept_pts_span_s * bytes_per_second) as u64;
            // Round up to TS packet boundary
            ((next_off + ts_packet_size - 1) / ts_packet_size * ts_packet_size).min(total_size)
        } else {
            // Fallback: use capped_read_end (shouldn't happen with real data)
            ((capped_read_end + 1 + ts_packet_size - 1) / ts_packet_size * ts_packet_size).min(total_size)
        }
    };

    let segment_end_time = last_frame_pts as f64 / 90000.0;

    HttpResponse::Ok()
        .insert_header(("Content-Type", "video/mp4"))
        .insert_header(("X-Segment-Start-Time", media_seg.start_time_s.to_string()))
        .insert_header(("X-Segment-Duration", media_seg.duration_s.to_string()))
        .insert_header(("X-Segment-End-Time", segment_end_time.to_string()))
        .insert_header(("X-Next-Byte-Offset", next_byte_offset.to_string()))
        .insert_header(("X-Total-File-Size", total_size.to_string()))
        .insert_header(("X-Actual-Start-Time", first_video_pts.to_string()))
        .body(media_seg.data)
}

#[get("/fmp4/metadata/{folder_id}/{message_id}")]
async fn fmp4_metadata(
    path: web::Path<(String, i32)>,
    query: web::Query<Fmp4Query>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
    metadata_cache: web::Data<Fmp4MetadataCacheData>,
    _fmp4_cache: web::Data<Fmp4InitCacheData>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    match &query.token {
        Some(t) if constant_time_eq::constant_time_eq(t.as_bytes(), token_data.token.as_bytes()) => {},
        _ => {
            log::error!("[FMP4-META] Invalid or missing stream token for msg {}", message_id);
            return HttpResponse::Forbidden().body("Invalid or missing stream token");
        }
    }

    // Check metadata cache
    {
        let cache_lock = metadata_cache.0.lock().ok();
        if let Some(ref cache) = cache_lock {
            if let Some(cached) = cache.cache.get(&message_id) {
                log::info!("[FMP4-META] Cache HIT for msg {}", message_id);
                return HttpResponse::Ok()
                    .content_type("application/json")
                    .insert_header(("X-Cache", "HIT"))
                    .body(cached.clone());
            }
        }
    }

    let cache_mgr = match (**cache).as_ref() {
        Some(cm) => cm.clone(),
        None => {
            log::error!("[FMP4-META] No cache manager for msg {}", message_id);
            return HttpResponse::ServiceUnavailable().body("No cache manager");
        }
    };

    let data_path = cache_mgr.data_path(message_id);

    // Try to detect TS packet size from cache file. If the file doesn't
    // exist yet (cold-start: /stream doesn't write cache, proactive prebuffer
    // hasn't started), skip local codec detection and use defaults.
    // Duration will still be computed from Telegram API + PTS tail download.
    let cache_file_available = data_path.exists();
    let (_ts_packet_size, is_m2ts) = if cache_file_available {
        match detect_ts_packet_size(&data_path) {
            Some(result) => result,
            None => {
                log::warn!("[FMP4-META] msg {} cache file exists but TS packet size detection failed — using defaults", message_id);
                (188, false) // Assume standard 188-byte TS
            }
        }
    } else {
        log::info!("[FMP4-META] msg {} cache file not available yet — using defaults for codec, duration from Telegram/PTS", message_id);
        (188, false) // Standard 188-byte TS
    };

    // Read first 5MB of cached data — if cache file isn't available yet
    // (cold-start), skip local processing and rely on Telegram API for duration.
    let mut ts_data: Vec<u8> = Vec::new();
    let mut total_size_from_meta: u64 = 0;
    if cache_file_available {
        let _lock = cache_mgr.lock_meta(message_id).await;
        let meta = cache_mgr.load_meta(message_id);
        drop(_lock);

        if let Some(m) = &meta {
            total_size_from_meta = m.total_size;
            let scan_end = 5 * 1024 * 1024;
            let read_end = scan_end.min(m.total_size as usize);
            if let Ok(mut file) = std::fs::File::open(&data_path) {
                let mut buf = vec![0u8; read_end];
                match file.read_exact(&mut buf) {
                    Ok(()) => ts_data = buf,
                    Err(e) => {
                        log::warn!("[FMP4-META] Partial read for msg {} ({}): {}", message_id, read_end, e);
                        let actual = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
                        let actual_end = actual.min(read_end);
                        buf.truncate(actual_end);
                        ts_data = buf;
                    }
                }
            }
        }
    }

    // If we have no local cache data, get total_size from query param
    if total_size_from_meta == 0 {
        total_size_from_meta = query.file_size.unwrap_or(0);
    }

    // Strip M2TS prefix if needed
    if is_m2ts && !ts_data.is_empty() {
        ts_data = strip_m2ts_prefix(&ts_data, true);
    }

    // Extract stream info and codec configs from local cache data.
    // When cache data isn't available, use defaults — mpegts.js will
    // detect the actual codecs from the stream data itself.
    let stream_info = if !ts_data.is_empty() {
        extract_stream_info(&ts_data)
    } else {
        None
    };

    let mut demuxer = TsDemuxer::new();
    if let Some(ref si) = stream_info {
        demuxer = TsDemuxer::new().with_stream_info(si.clone());
    }
    if !ts_data.is_empty() {
        demuxer.feed(&ts_data);
        demuxer.flush();
    }

    let mut video_config = demuxer.video_codec_config().cloned();
    let mut audio_config = demuxer.audio_codec_config().cloned();

    // If codec configs not found, scan further up to 25MB (same pattern as fmp4_init)
    if (video_config.is_none() || audio_config.is_none()) && !ts_data.is_empty() {
        let max_scan = 25 * 1024 * 1024;
        let mut scan_offset = 5 * 1024 * 1024;

        while (video_config.is_none() || audio_config.is_none()) && scan_offset < max_scan as u64 && scan_offset < total_size_from_meta {
            let chunk_size = 2 * 1024 * 1024;
            let read_end = (scan_offset as usize + chunk_size).min(total_size_from_meta as usize);

            let _lock = cache_mgr.lock_meta(message_id).await;
            let m = cache_mgr.load_meta(message_id);
            drop(_lock);

            if let Some(m) = &m {
                if !is_range_cached(&m.cached_ranges, scan_offset, read_end as u64 - 1) {
                    scan_offset += chunk_size as u64;
                    continue;
                }
            }

            let mut file = match std::fs::File::open(&data_path) {
                Ok(f) => f,
                Err(_) => break,
            };
            let mut chunk = vec![0u8; read_end - scan_offset as usize];
            if file.seek(SeekFrom::Start(scan_offset)).is_err() { break; }
            if file.read_exact(&mut chunk).is_err() { break; }

            let chunk_ts = if is_m2ts {
                strip_m2ts_prefix(&chunk, true)
            } else {
                chunk
            };
            ts_data.extend_from_slice(&chunk_ts);
            demuxer.feed(&chunk_ts);
            if video_config.is_none() {
                video_config = demuxer.video_codec_config().cloned();
            }
            if audio_config.is_none() {
                audio_config = demuxer.audio_codec_config().cloned();
            }

            scan_offset += chunk_size as u64;
        }
    }

    // Use defaults when codec detection failed (cache file missing or too small)
    let video = match video_config {
        Some(v) => v,
        None => {
            log::warn!("[FMP4-META] msg {} video codec config not found — using AVC default", message_id);
            crate::ts_demux::VideoCodecConfig {
                codec: crate::ts_demux::VideoCodec::Avc,
                sps: vec![0x67, 0x42, 0xC0, 0x1E, 0xD9, 0x00, 0xA0, 0x47, 0xFE, 0x88],
                pps: vec![0x68, 0xCE, 0x38, 0x80],
                vps: None,
                width: 1920,
                height: 1080,
            }
        }
    };
    let audio = match audio_config {
        Some(a) => a,
        None => {
            log::warn!("[FMP4-META] msg {} audio codec config not found — using AAC default", message_id);
            crate::ts_demux::AudioCodecConfig {
                audio_object_type: 2,
                sampling_freq_index: 4, // 44100 Hz
                channel_config: 2,
                sampling_freq: 44100,
            }
        }
    };

    // Build codec strings (same logic as build_init_segment)
    let video_codec_str = match video.codec {
        VideoCodec::Avc => "avc",
        VideoCodec::Hevc => "hevc",
    };
    let video_codec_string = match video.codec {
        VideoCodec::Avc => {
            let profile = video.sps.get(1).copied().unwrap_or(66);
            let constraint_flags = video.sps.get(2).copied().unwrap_or(0xC0);
            let level = video.sps.get(3).copied().unwrap_or(30);
            format!("avc1.{:02X}{:02X}{:02X}", profile, constraint_flags, level)
        }
        VideoCodec::Hevc => {
            format!("hvc1.1.6.L{}.B0", video.sps.get(3).copied().unwrap_or(93) >> 1)
        }
    };
    let audio_object_type = if audio.audio_object_type == 5 || audio.audio_object_type == 29 { 5 } else { 2 };
    let audio_codec_string = format!("mp4a.40.{}", audio_object_type);
    let mime_type = format!("video/mp4; codecs=\"{},{}\"", video_codec_string, audio_codec_string);

    // Get total_size and duration from Telegram metadata
    // Get total_size (already computed above from meta or query param)
    let total_size = total_size_from_meta;

    // Try to get actual duration from Telegram's DocumentAttributeVideo.
    // This is far more accurate than bitrate estimation (which assumes ~500KB/s
    // and is wildly wrong for high-bitrate or low-bitrate files).
    let mut telegram_duration: Option<f64> = None;
    {
        let folder_id = if folder_id_str == "me" || folder_id_str == "home" || folder_id_str == "null" {
            None
        } else {
            folder_id_str.parse::<i64>().ok()
        };
        let client_guard = { data.client.lock().await.clone() };
        if let Some(client) = client_guard {
            if let Ok(peer) = resolve_peer(&client, folder_id, &data.peer_cache).await {
                if let Ok(messages) = client.get_messages_by_id(&peer, &[message_id]).await {
                    if let Some(msg) = messages.into_iter().next().flatten() {
                        // Diagnostic: log the raw TL message variant to help
                        // diagnose why DocumentAttributeVideo may not be found.
                        match &msg.raw {
                            tl::enums::Message::Message(m) => {
                                log::warn!("[FMP4-META] msg {} is Message, media={:?}", message_id, m.media.as_ref().map(|mm| match mm {
                                    tl::enums::MessageMedia::Document(_) => "Document",
                                    tl::enums::MessageMedia::Photo(_) => "Photo",
                                    _ => "Other",
                                }));
                            }
                            tl::enums::Message::Service(s) => {
                                log::warn!("[FMP4-META] msg {} is MessageService (not Message) — no DocumentAttributeVideo available", message_id);
                                let _ = s; // suppress unused warning
                            }
                            tl::enums::Message::Empty(_) => {
                                log::warn!("[FMP4-META] msg {} is MessageEmpty — message was deleted or inaccessible", message_id);
                            }
                        }
                        if let Some((dur, _w, _h)) = extract_video_attrs_from_raw_msg(&msg.raw) {
                            telegram_duration = Some(dur);
                            log::info!("[FMP4-META] msg {} Telegram duration={:.1}s", message_id, dur);
                        } else {
                            log::warn!("[FMP4-META] msg {} extract_video_attrs_from_raw_msg returned None — message type or document attributes don't contain Video", message_id);
                        }
                    } else {
                        log::warn!("[FMP4-META] msg {} not found in messages result", message_id);
                    }
                } else {
                    log::warn!("[FMP4-META] msg {} failed to fetch messages by ID", message_id);
                }
            } else {
                log::warn!("[FMP4-META] msg {} failed to resolve peer for folder_id={:?}", message_id, folder_id);
            }
        } else {
            log::warn!("[FMP4-META] msg {} no Telegram client connected", message_id);
        }
    }

    // Estimate duration: prefer Telegram metadata, fall back to PTS-based
    // calculation from demuxer, then bitrate estimation as last resort.
    let pts_duration: Option<f64> = if telegram_duration.is_none() {
        // Try to compute duration from PTS values in the TS stream.
        // Progressive approach: use whatever data IS currently cached to
        // estimate the average bitrate, then compute duration from that.
        // The old approach required the tail 10MB to be cached, which
        // fails at startup before the download reaches the end.
        let mut demux2 = TsDemuxer::new().with_stream_info(stream_info.clone().unwrap_or_else(|| crate::ts_demux::TsStreamInfo {
                    video_pid: 0,
                    audio_pid: 0,
                    video_stream_type: 0,
                    audio_stream_type: 0,
                    pmt_pid: 0,
                }));
        demux2.feed(&ts_data);
        demux2.flush();
        let frames2 = demux2.take_frames();
        let video_frames: Vec<&PesFrame> = frames2.iter()
            .filter(|f| f.stream_type == 0x1B || f.stream_type == 0x24)
            .collect();

        let initial_pts = video_frames.first().map(|f| f.pts);
        // Also get the last PTS from the initial scan data — if the initial
        // scan covers enough time (e.g., >2s), we can estimate bitrate from
        // it alone without needing additional cached ranges.
        let last_init_pts = video_frames.last().map(|f| f.pts);

        if let Some(init_pts) = initial_pts {
            let _lock3 = cache_mgr.lock_meta(message_id).await;
            let m = cache_mgr.load_meta(message_id);
            drop(_lock3);

            if let Some(m) = m {
                // Strategy 1: if the tail 10MB is cached, use exact PTS duration
                let tail_scan_start = m.total_size.saturating_sub(10 * 1024 * 1024);
                let tail_scan_end = m.total_size.saturating_sub(1);

                if is_range_cached(&m.cached_ranges, tail_scan_start, tail_scan_end) {
                    let mut tail_buf = vec![0u8; (tail_scan_end - tail_scan_start + 1) as usize];
                    if let Ok(mut file) = std::fs::File::open(&data_path) {
                        if file.seek(SeekFrom::Start(tail_scan_start)).is_ok() && file.read_exact(&mut tail_buf).is_ok() {
                            let tail_ts = if is_m2ts {
                                strip_m2ts_prefix(&tail_buf, true)
                            } else {
                                tail_buf
                            };

                            let mut tail_demux = TsDemuxer::new().with_stream_info(stream_info.clone().unwrap_or_else(|| crate::ts_demux::TsStreamInfo {
                    video_pid: 0,
                    audio_pid: 0,
                    video_stream_type: 0,
                    audio_stream_type: 0,
                    pmt_pid: 0,
                }));
                            tail_demux.feed(&tail_ts);
                            tail_demux.flush();
                            let tail_frames = tail_demux.take_frames();

                            if let Some(final_pts) = tail_frames.iter()
                                .filter(|f| f.stream_type == 0x1B || f.stream_type == 0x24)
                                .map(|f| f.pts)
                                .max()
                            {
                                if final_pts > init_pts {
                                    let dur = (final_pts - init_pts) as f64 / 90000.0;
                                    log::info!("[FMP4-META] msg {} PTS-based duration={:.1}s (init_pts={}, final_pts={})", message_id, dur, init_pts, final_pts);
                                    Some(dur)
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    // Strategy 1.5: Download the tail of the file from Telegram
                    // to compute accurate PTS-based duration. FFmpeg does this
                    // (reads last ~250KB for final PTS). Caches result for reuse.
                    const TAIL_SCAN_SIZE: u64 = 512 * 1024; // 512KB (enough for final PTS)
                    let tail_start = m.total_size.saturating_sub(TAIL_SCAN_SIZE);
                    let tail_end = m.total_size.saturating_sub(1);
                    let tail_size = tail_end - tail_start + 1;

                    log::info!("[FMP4-META] msg {} tail not cached — downloading last {}KB from Telegram for PTS duration", message_id, tail_size / 1024);

                    // Try to get the Telegram client and media for this message
                    let mut tail_pts_duration: Option<f64> = None;

                    let folder_id_val = if folder_id_str == "me" || folder_id_str == "home" || folder_id_str == "null" {
                        None
                    } else {
                        folder_id_str.parse::<i64>().ok()
                    };

                    let client_guard = { data.client.lock().await.clone() };
                    if let Some(client) = client_guard {
                        if let Ok(peer) = resolve_peer(&client, folder_id_val, &data.peer_cache).await {
                            if let Ok(messages) = client.get_messages_by_id(&peer, &[message_id]).await {
                                if let Some(msg) = messages.into_iter().next().flatten() {
                                    if let Some(media) = msg.media() {
                                        // Use main client iter_download (sequential, session-level semaphore-gated)
                                        // NOT DownloadPool — parallel connections trigger FLOOD_PREMIUM_WAIT.
                                        let chunk_size: i32 = 512 * 1024;
                                        let skip_chunks = (tail_start / chunk_size as u64) as i32;
                                        let bytes_to_discard = tail_start % chunk_size as u64;
                                        // Per-chunk acquire + rate limiter (same as /stream).
                                        // The tail is critical for PTS duration — use blocking acquire.
                                        let download_iter = client.iter_download(&media)
                                            .chunk_size(chunk_size)
                                            .skip_chunks(skip_chunks);
                                        let mut iter = download_iter;
                                        let mut tail_buf = Vec::new();
                                        let mut first_chunk = true;
                                        let mut tail_retries = 0u32;
                                        loop {
                                            let chunk_result = {
                                                let _permit = data.download_semaphore.acquire().await.unwrap();
                                                throttle_api_calls(&data.rate_limiter).await;
                                                iter.next().await
                                            };
                                            match chunk_result {
                                                Ok(Some(chunk)) => {
                                                    let slice: &[u8] = if first_chunk && bytes_to_discard > 0 {
                                                        first_chunk = false;
                                                        &chunk[bytes_to_discard.min(chunk.len() as u64) as usize..]
                                                    } else {
                                                        first_chunk = false;
                                                        &chunk
                                                    };
                                                    tail_buf.extend_from_slice(slice);
                                                    if tail_buf.len() as u64 >= tail_size { break; }
                                                }
                                                Ok(None) => break,
                                                Err(e) => {
                                                    log::warn!("[FMP4-META] msg {} tail download error: {}", message_id, e);
                                                    tail_retries += 1;
                                                    if tail_retries > 3 {
                                                        log::warn!("[FMP4-META] msg {} tail max retries exceeded, using partial", message_id);
                                                        break;
                                                    }
                                                    let backoff = 3 * (1u64 << (tail_retries - 1));
                                                    log::info!("[FMP4-META] Retrying tail in {}s (attempt {}/3)", backoff, tail_retries);
                                                    tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                                                    let resume_byte = tail_start + tail_buf.len() as u64;
                                                    let skip_chunks = (resume_byte / chunk_size as u64) as i32;
                                                    iter = client.iter_download(&media)
                                                        .chunk_size(chunk_size)
                                                        .skip_chunks(skip_chunks);
                                                    continue;
                                                }
                                            }
                                        }
                                        let tail_data = tail_buf;

                                        if tail_data.len() > 188 * 10 {
                                            // Need a separate copy for caching since tail_ts may own tail_data
                                            let tail_data_for_cache = tail_data.clone();
                                            let tail_ts = if is_m2ts {
                                                strip_m2ts_prefix(&tail_data, true)
                                            } else {
                                                tail_data
                                            };
                                            let mut tail_demux = TsDemuxer::new().with_stream_info(stream_info.clone().unwrap_or_else(|| crate::ts_demux::TsStreamInfo {
                    video_pid: 0,
                    audio_pid: 0,
                    video_stream_type: 0,
                    audio_stream_type: 0,
                    pmt_pid: 0,
                }));
                                            tail_demux.feed(&tail_ts);
                                            tail_demux.flush();
                                            let tail_frames = tail_demux.take_frames();

                                            if let Some(final_pts) = tail_frames.iter()
                                                .filter(|f| f.stream_type == 0x1B || f.stream_type == 0x24)
                                                .map(|f| f.pts)
                                                .max()
                                            {
                                                if final_pts > init_pts {
                                                    let dur = (final_pts - init_pts) as f64 / 90000.0;
                                                    log::info!("[FMP4-META] msg {} Tail-download PTS duration={:.1}s (init_pts={}, final_pts={})", message_id, dur, init_pts, final_pts);
                                                    tail_pts_duration = Some(dur);

                                                    // Also cache the tail data for reuse by streaming
                                                    {
                                                        let _lock4 = cache_mgr.lock_meta(message_id).await;
                                                        let mut meta2 = cache_mgr.load_meta(message_id).unwrap_or_else(|| CacheMeta {
                                                            message_id,
                                                            folder_id: 0,
                                                            total_size: m.total_size,
                                                            filename: String::new(),
                                                            cached_ranges: vec![],
                                                            mime_type: String::new(),
                                                        });
                                                        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(&data_path) {
                                                            if f.seek(SeekFrom::Start(tail_start)).is_ok() {
                                                                let _ = f.write_all(&tail_data_for_cache);
                                                                // Update cached_ranges
                                                                meta2.cached_ranges.push((tail_start, tail_end));
                                                                meta2.cached_ranges.sort_by_key(|r| r.0);
                                                                merge_ranges(&mut meta2.cached_ranges);
                                                                let _ = cache_mgr.save_meta(&meta2);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if tail_pts_duration.is_some() {
                        tail_pts_duration
                    } else {
                    // Strategy 2: progressive bitrate estimation from cached data.
                    // Scan whatever data IS currently cached (beyond the initial
                    // ~25MB) to estimate average bitrate, then compute
                    // duration = total_size / estimated_bitrate.
                    let mut best_duration: Option<f64> = None;

                    // First, try using bitrate from the initial data itself.
                    // Only use this if the PTS span is large enough (>10s) to be
                    // representative of the whole file. Short spans (2-5s) are
                    // biased by the high-bitrate initial keyframes.
                    if let Some(last_pts) = last_init_pts {
                        if last_pts > init_pts {
                            let pts_span = last_pts - init_pts;
                            if pts_span > 10 * 90000 {
                                let ts_data_len = ts_data.len() as u64;
                                let bytes_per_sec = ts_data_len as f64 * 90000.0 / pts_span as f64;
                                let estimated_dur = m.total_size as f64 / bytes_per_sec;
                                log::warn!("[FMP4-META] msg {} initial-data PTS bitrate estimation: bytes_per_sec={:.0}, estimated duration={:.1}s (pts_span={:.1}s over {}MB)",
                                    message_id, bytes_per_sec, estimated_dur,
                                    pts_span as f64 / 90000.0,
                                    ts_data_len / (1024*1024));
                                best_duration = Some(estimated_dur);
                            }
                        }
                    }

                    // Then try scanning the most recently cached range for a
                    // more accurate estimate (further into the file)
                    if best_duration.is_none() {
                        for &(range_start, range_end) in m.cached_ranges.iter().rev() {
                            let range_size = range_end.saturating_sub(range_start) + 1;
                            if range_size < 188 * 10 { continue; }
                            // Skip ranges that overlap with ts_data (already scanned)
                            if range_start < ts_data.len() as u64 { continue; }

                            let mut range_buf = vec![0u8; range_size as usize];
                            if let Ok(mut file) = std::fs::File::open(&data_path) {
                                if file.seek(SeekFrom::Start(range_start)).is_ok()
                                    && file.read_exact(&mut range_buf).is_ok()
                                {
                                    let range_ts = if is_m2ts {
                                        strip_m2ts_prefix(&range_buf, true)
                                    } else {
                                        range_buf
                                    };
                                    let mut range_demux = TsDemuxer::new().with_stream_info(stream_info.clone().unwrap_or_else(|| crate::ts_demux::TsStreamInfo {
                    video_pid: 0,
                    audio_pid: 0,
                    video_stream_type: 0,
                    audio_stream_type: 0,
                    pmt_pid: 0,
                }));
                                    range_demux.feed(&range_ts);
                                    range_demux.flush();
                                    let range_frames = range_demux.take_frames();

                                    if let Some(latest_pts) = range_frames.iter()
                                        .filter(|f| f.stream_type == 0x1B || f.stream_type == 0x24)
                                        .map(|f| f.pts)
                                        .max()
                                    {
                                        if latest_pts > init_pts {
                                            let pts_diff = latest_pts - init_pts;
                                            // Use range_end as the byte offset for latest_pts
                                            let bytes_per_sec = range_end as f64 * 90000.0 / pts_diff as f64;
                                            let estimated_dur = m.total_size as f64 / bytes_per_sec;
                                            log::warn!("[FMP4-META] msg {} progressive PTS bitrate from cached range [{}, {}]: bytes_per_sec={:.0}, estimated duration={:.1}s",
                                                message_id, range_start, range_end, bytes_per_sec, estimated_dur);
                                            best_duration = Some(estimated_dur);
                                            break; // Use the most recent range we can
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Last resort: conservative bitrate estimate
                    if best_duration.is_none() {
                        // Conservative 4 Mbps estimate for Telegram video
                        let conservative_bytes_per_sec = 4_000_000.0 / 8.0; // 500KB/s
                        let estimated_dur = m.total_size as f64 / conservative_bytes_per_sec;
                        log::warn!("[FMP4-META] msg {} no PTS bitrate data available, using conservative 4Mbps estimate, duration={:.1}s", message_id, estimated_dur);
                        best_duration = Some(estimated_dur);
                    }

                    best_duration
                    } // closes Strategy 1.5 else block (tail_pts_duration was None)
                }
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    let duration_s = if let Some(d) = telegram_duration {
        d
    } else if let Some(d) = pts_duration {
        d
    } else if total_size > 0 {
        log::warn!("[FMP4-META] msg {} no DocumentAttributeVideo found, falling back to bitrate estimation", message_id);
        total_size as f64 / 500_000.0
    } else {
        0.0
    };

    let has_timed_id3 = !cache_mgr.get_stripped_pids(message_id).is_empty();

    let response = Fmp4MetadataResponse {
        duration_s,
        video_codec: video_codec_str.to_string(),
        width: video.width,
        height: video.height,
        mime_type,
        video_codec_string,
        audio_codec_string,
        total_size,
        has_timed_id3,
    };

    let body = match serde_json::to_vec(&response) {
        Ok(b) => b,
        Err(e) => {
            log::error!("[FMP4-META] Failed to serialize metadata for msg {}: {}", message_id, e);
            return HttpResponse::InternalServerError().body("Failed to serialize metadata");
        }
    };

    // Cache the result
    if let Ok(mut c) = metadata_cache.0.lock() {
        c.cache.insert(message_id, body.clone());
    }

    HttpResponse::Ok()
        .content_type("application/json")
        .insert_header(("X-Cache", "MISS"))
        .body(body)
}

/// Merge a list of [start, end] byte ranges into a sorted, non-overlapping set.
fn merge_byte_ranges(ranges: &[(u64, u64)]) -> Vec<(u64, u64)> {
    if ranges.is_empty() { return Vec::new(); }
    let mut sorted = ranges.to_vec();
    sorted.sort_by_key(|r| r.0);
    let mut merged: Vec<(u64, u64)> = Vec::new();
    let mut current = sorted[0];
    for (start, end) in sorted.iter().skip(1) {
        if *start <= current.1.saturating_add(1) {
            current.1 = current.1.max(*end);
        } else {
            merged.push(current);
            current = (*start, *end);
        }
    }
    merged.push(current);
    merged
}

/// Subtract `covered` ranges from `target` ranges, returning the uncovered gaps.
fn subtract_byte_ranges(target: &[(u64, u64)], covered: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut result = target.to_vec();
    for (c_start, c_end) in covered {
        let mut new_result = Vec::new();
        for (t_start, t_end) in result {
            if t_end < *c_start || t_start > *c_end {
                new_result.push((t_start, t_end));
            } else {
                if t_start < *c_start {
                    new_result.push((t_start, c_start.saturating_sub(1)));
                }
                if t_end > *c_end {
                    new_result.push((c_end.saturating_add(1), t_end));
                }
            }
        }
        result = new_result;
    }
    result
}

#[get("/fmp4/keyframes/{folder_id}/{message_id}")]
async fn fmp4_keyframes(
    path: web::Path<(String, i32)>,
    query: web::Query<Fmp4Query>,
    _data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
    keyframe_cache: web::Data<Fmp4KeyframeCacheData>,
    byte_time_cache: web::Data<Fmp4ByteTimeCacheData>,
) -> impl Responder {
    let (_folder_id_str, message_id) = path.into_inner();

    match &query.token {
        Some(t) if constant_time_eq::constant_time_eq(t.as_bytes(), token_data.token.as_bytes()) => {},
        _ => {
            log::error!("[FMP4-KF] Invalid or missing stream token for msg {}", message_id);
            return HttpResponse::Forbidden().body("Invalid or missing stream token");
        }
    }

    // Check keyframe cache
    {
        let cache_lock = keyframe_cache.0.lock().ok();
        if let Some(ref cache) = cache_lock {
            if let Some(cached) = cache.cache.get(&message_id) {
                log::info!("[FMP4-KF] Cache HIT for msg {}", message_id);
                return HttpResponse::Ok()
                    .content_type("application/json")
                    .insert_header(("X-Cache", "HIT"))
                    .body(cached.clone());
            }
        }
    }

    let cache_mgr = match (**cache).as_ref() {
        Some(cm) => cm.clone(),
        None => {
            log::error!("[FMP4-KF] No cache manager for msg {}", message_id);
            return HttpResponse::ServiceUnavailable().body("No cache manager");
        }
    };

    let data_path = cache_mgr.data_path(message_id);
        let (_ts_packet_size, is_m2ts) = match detect_ts_packet_size(&data_path) {
            Some(result) => result,
            None => {
                // detect_ts_packet_size returns None when:
                // 1. File doesn't exist yet (cold start) → partial: true, retry later
                // 2. File exists but isn't TS (MP4/MKV/etc) → partial: false, stop retrying
                if data_path.exists() {
                    let file_size = std::fs::metadata(&data_path).map(|m| m.len()).unwrap_or(0);
                    if file_size >= 193 {
                        // File exists and has enough data — it's simply not a TS file.
                        // Return partial: false so the frontend stops polling and uses
                        // linear byte mapping for seeking.
                        log::info!("[FMP4-KF] msg {} is not a TS stream ({} bytes) — returning empty final index", message_id, file_size);
                        let response = Fmp4KeyframeResponse {
                            keyframes: vec![],
                            total_size: file_size,
                            partial: false,
                        };
                        return match serde_json::to_vec(&response) {
                            Ok(body) => HttpResponse::Ok()
                                .content_type("application/json")
                                .insert_header(("X-Cache", "HIT"))
                                .insert_header(("X-Partial", "false"))
                                .insert_header(("X-Reason", "not-ts-format"))
                                .body(body),
                            Err(e) => {
                                log::error!("[FMP4-KF] Failed to serialize empty final response for msg {}: {}", message_id, e);
                                HttpResponse::InternalServerError().body("Failed to serialize keyframes")
                            }
                        };
                    }
                }
                // File doesn't exist or is too small — genuinely not ready
                log::info!("[FMP4-KF] Data file not ready for msg {} — returning empty partial index", message_id);
                let response = Fmp4KeyframeResponse {
                    keyframes: vec![],
                    total_size: 0,
                    partial: true,
                };
                return match serde_json::to_vec(&response) {
                    Ok(body) => HttpResponse::Ok()
                        .content_type("application/json")
                        .insert_header(("X-Cache", "MISS"))
                        .insert_header(("X-Partial", "true"))
                        .insert_header(("X-Reason", "data-not-ready"))
                        .body(body),
                    Err(e) => {
                        log::error!("[FMP4-KF] Failed to serialize empty partial response for msg {}: {}", message_id, e);
                        HttpResponse::InternalServerError().body("Failed to serialize keyframes")
                    }
                };
            }
        };

    // Load meta to know what's cached
    let _lock = cache_mgr.lock_meta(message_id).await;
    let meta = cache_mgr.load_meta(message_id);
    drop(_lock);

    let meta = match meta {
        Some(m) => m,
        None => {
            log::error!("[FMP4-KF] No cache meta for msg {}", message_id);
            return HttpResponse::NotFound().body("No cache meta");
        }
    };

    let total_size = meta.total_size;
    let fully_cached = meta.cached_bytes() >= total_size;

    // Merge target cached ranges so subtraction is reliable.
    let target_ranges: Vec<(u64, u64)> = merge_byte_ranges(&if fully_cached {
        vec![(0, total_size.saturating_sub(1))]
    } else {
        meta.cached_ranges.clone()
    });

    // Load any previously cached partial/complete index entry.
    let (mut all_keyframes, mut covered_ranges) = {
        let cache_lock = byte_time_cache.0.lock().ok();
        if let Some(ref cache) = cache_lock {
            if let Some(e) = cache.cache.get(&message_id) {
                if e.total_size == total_size && e.complete {
                    // Already fully scanned — return cached JSON if possible, otherwise build it.
                    let entries: Vec<Fmp4KeyframeEntry> = e.samples.iter().map(|(ts, off)| Fmp4KeyframeEntry {
                        timestamp_s: *ts,
                        byte_offset: *off,
                    }).collect();
                    let response = Fmp4KeyframeResponse { keyframes: entries, total_size, partial: false };
                    let body = match serde_json::to_vec(&response) {
                        Ok(b) => b,
                        Err(e) => {
                            log::error!("[FMP4-KF] Failed to serialize cached keyframes for msg {}: {}", message_id, e);
                            return HttpResponse::InternalServerError().body("Failed to serialize keyframes");
                        }
                    };
                    return HttpResponse::Ok()
                        .content_type("application/json")
                        .insert_header(("X-Cache", "HIT"))
                        .insert_header(("X-Partial", "false"))
                        .body(body);
                }
                (e.samples.clone(), e.covered_ranges.clone())
            } else {
                (Vec::new(), Vec::new())
            }
        } else {
            (Vec::new(), Vec::new())
        }
    };

    // Only scan byte ranges that are not already covered by a previous partial scan.
    let uncovered_ranges = subtract_byte_ranges(&target_ranges, &covered_ranges);

    // Read the first portion to extract stream info (needed even if we only scan later ranges).
    let first_read_end = (5 * 1024 * 1024).min(total_size as usize);
    let mut file = match std::fs::File::open(&data_path) {
        Ok(f) => f,
        Err(e) => {
            log::error!("[FMP4-KF] Failed to open data file for msg {}: {}", message_id, e);
            return HttpResponse::NotFound().body("Data file not found");
        }
    };

    let mut first_buf = vec![0u8; first_read_end];
    match file.read_exact(&mut first_buf) {
        Ok(()) => {},
        Err(e) => {
            log::warn!("[FMP4-KF] Partial first read for msg {}: {}", message_id, e);
            let actual = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
            first_buf.truncate(actual.min(first_read_end));
            if first_buf.is_empty() {
                return HttpResponse::NotFound().body("No TS data available");
            }
        }
    };

    let first_ts = if is_m2ts {
        strip_m2ts_prefix(&first_buf, true)
    } else {
        first_buf
    };

    let stream_info = match extract_stream_info(&first_ts) {
        Some(si) => si,
        None => {
            log::error!("[FMP4-KF] Failed to extract stream info for msg {}", message_id);
            return HttpResponse::InternalServerError().body("Failed to extract stream info");
        }
    };

    // If nothing new is cached, return the existing partial index without rescanning.
    if uncovered_ranges.is_empty() && !all_keyframes.is_empty() {
        // fall through to serialize below
    } else if !uncovered_ranges.is_empty() {
        // Scan keyframes across the newly cached ranges, carrying PES state across
        // chunk boundaries so keyframes spanning chunks are detected. We reuse the
        // existing partial scan state where ranges are contiguous.
        let chunk_read_size = 2 * 1024 * 1024;
        let mut scan_state = KeyframeScanState::default();

        for (range_start, range_end) in &uncovered_ranges {
            let mut offset = *range_start;
            while offset <= *range_end {
                let read_end = (offset as usize + chunk_read_size).min(*range_end as usize + 1);
                let read_len = read_end.saturating_sub(offset as usize);

                if read_len == 0 { break; }
                let mut file = match std::fs::File::open(&data_path) {
                    Ok(f) => f,
                    Err(_) => break,
                };
                if file.seek(SeekFrom::Start(offset)).is_err() { break; }
                let mut chunk = vec![0u8; read_len];
                match file.read_exact(&mut chunk) {
                    Ok(()) => {},
                    Err(_) => break,
                }

                let chunk_ts = if is_m2ts {
                    strip_m2ts_prefix(&chunk, true)
                } else {
                    chunk
                };

                let kfs = scan_keyframes_chunked(&chunk_ts, offset, &stream_info, &mut scan_state);
                all_keyframes.extend_from_slice(&kfs);

                offset = read_end as u64;
            }
        }

        // Flush any remaining PES buffers from the scan state
        let flush_kfs = scan_keyframes_flush(0, &stream_info, &mut scan_state);
        all_keyframes.extend_from_slice(&flush_kfs);

        // Deduplicate and sort keyframes by timestamp
        all_keyframes.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
        all_keyframes.dedup_by(|a, b| (a.0 - b.0).abs() < 0.001 && a.1 == b.1);

        // Merge newly covered ranges with the prior ones.
        covered_ranges = merge_byte_ranges(&[covered_ranges, uncovered_ranges.clone()].concat());

        // Store the updated partial/complete index in Fmp4ByteTimeCache.
        let entry = ByteTimeCacheEntry {
            samples: all_keyframes.clone(),
            covered_ranges: covered_ranges.clone(),
            total_size,
            complete: fully_cached,
        };
        if let Ok(mut c) = byte_time_cache.0.lock() {
            c.cache.insert(message_id, entry);
        }
    }

    let keyframe_entries: Vec<Fmp4KeyframeEntry> = all_keyframes.into_iter().map(|(ts, off)| {
        Fmp4KeyframeEntry {
            timestamp_s: ts,
            byte_offset: off,
        }
    }).collect();

    let response = Fmp4KeyframeResponse {
        keyframes: keyframe_entries,
        total_size,
        partial: !fully_cached,
    };

    let body = match serde_json::to_vec(&response) {
        Ok(b) => b,
        Err(e) => {
            log::error!("[FMP4-KF] Failed to serialize keyframes for msg {}: {}", message_id, e);
            return HttpResponse::InternalServerError().body("Failed to serialize keyframes");
        }
    };

    // Cache only if fully scanned
    if fully_cached {
        if let Ok(mut c) = keyframe_cache.0.lock() {
            c.cache.insert(message_id, body.clone());
        }
    }

    HttpResponse::Ok()
        .content_type("application/json")
        .insert_header(("X-Cache", "MISS"))
        .insert_header(("X-Partial", if fully_cached { "false" } else { "true" }))
        .body(body)
}

fn configure_fmp4(
    cfg: &mut web::ServiceConfig,
    fmp4_cache: web::Data<Fmp4InitCacheData>,
    metadata_cache: web::Data<Fmp4MetadataCacheData>,
    keyframe_cache: web::Data<Fmp4KeyframeCacheData>,
    byte_time_cache: web::Data<Fmp4ByteTimeCacheData>,
    stream_info_cache: web::Data<Fmp4StreamInfoCacheData>,
    demuxer_cache: web::Data<Fmp4DemuxerCacheData>,
) {
    cfg.app_data(fmp4_cache);
    cfg.app_data(metadata_cache);
    cfg.app_data(keyframe_cache);
    cfg.app_data(byte_time_cache);
    cfg.app_data(stream_info_cache);
    cfg.app_data(demuxer_cache);
    cfg.service(fmp4_init);
    cfg.service(fmp4_segment);
    cfg.service(fmp4_metadata);
    cfg.service(fmp4_keyframes);
    cfg.service(fmp4_keyframe_at);
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

    // Create fMP4 caches OUTSIDE the HttpServer::new closure so they are
    // shared across all Actix worker threads (web::Data wraps in Arc,
    // .clone() inside the closure shares the same underlying data).
    // Previously these were created inside configure_fmp4(), which ran
    // per-worker — causing stream_info_cache misses when fmp4_init and
    // fmp4_segment were handled by different workers.
    let fmp4_cache_data = web::Data::new(Fmp4InitCacheData(StdMutex::new(Fmp4InitCache {
        cache: HashMap::new(),
    })));
    let metadata_cache_data = web::Data::new(Fmp4MetadataCacheData(StdMutex::new(Fmp4MetadataCache {
        cache: HashMap::new(),
    })));
    let keyframe_cache_data = web::Data::new(Fmp4KeyframeCacheData(StdMutex::new(Fmp4KeyframeCache {
        cache: HashMap::new(),
    })));
    let byte_time_cache_data = web::Data::new(Fmp4ByteTimeCacheData(StdMutex::new(Fmp4ByteTimeCache {
        cache: HashMap::new(),
    })));
    let stream_info_cache_data = web::Data::new(Fmp4StreamInfoCacheData(StdMutex::new(Fmp4StreamInfoCache {
        cache: HashMap::new(),
    })));
    let demuxer_cache_data = web::Data::new(Fmp4DemuxerCacheData(StdMutex::new(Fmp4DemuxerCache {
        entries: HashMap::new(),
    })));

    let server = HttpServer::new(move || {
        let cors = Cors::default()
            .allowed_origin("http://localhost:1420")
            .allowed_origin("http://localhost:14200")
            .allowed_origin("http://nobuf-stream.localhost")
            .allow_any_method()
            .allow_any_header()
            .expose_headers(["Content-Range", "Content-Length", "Accept-Ranges", "X-Cache", "X-Reason", "X-Mime-Type", "X-Video-Codec", "X-Audio-Codec", "X-Segment-Start-Time", "X-Segment-Duration", "X-Segment-End-Time", "X-Next-Byte-Offset", "X-Total-File-Size", "X-Actual-Start-Time", "X-Partial", "X-Video-Duration", "X-Remuxed"])
            .max_age(3600);

        App::new()
            .wrap(cors)
            .app_data(token_data.clone())
            .app_data(tg_data.clone())
            .app_data(cache_data.clone())
            .service(stream_media)
            .service(stream_media_head)
            .service(remux_ts_to_mp4)
            .configure(hls::configure_hls)
            .configure(crate::faststart::configure_faststart)
            .configure(|cfg| {
                configure_fmp4(
                    cfg,
                    fmp4_cache_data.clone(),
                    metadata_cache_data.clone(),
                    keyframe_cache_data.clone(),
                    byte_time_cache_data.clone(),
                    stream_info_cache_data.clone(),
                    demuxer_cache_data.clone(),
                );
            })
    })
    .workers(resolve_streaming_worker_count())
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

#[cfg(test)]
mod tests {
    use actix_cors::Cors;
    use actix_web::{test, web, App, HttpResponse, http::Method, http::header as actix_header};

    async fn test_handler() -> HttpResponse {
        HttpResponse::Ok().body("test")
    }

    /// Verify CORS middleware includes Access-Control-Allow-Private-Network: true
    /// when a preflight request contains Access-Control-Request-Private-Network: true.
    /// This is the core fix for the WebView2 "Media load rejected by URL safety check"
    /// error — Chromium's LNA/PNA restriction blocks cross-port localhost media
    /// unless the server sends this header.
    #[actix_rt::test]
    async fn cors_preflight_includes_private_network_access() {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .expose_headers(["Content-Range", "Content-Length", "Accept-Ranges", "X-Cache", "X-Reason"])
            .allow_private_network_access()
            .max_age(3600);

        let app = test::init_service(
            App::new()
                .wrap(cors)
                .route("/test", web::get().to(test_handler))
        ).await;

        let req = test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri("/test")
            .insert_header((actix_header::ORIGIN, "http://localhost:14200"))
            .insert_header((actix_header::ACCESS_CONTROL_REQUEST_METHOD, "GET"))
            .insert_header(("Access-Control-Request-Private-Network", "true"))
            .to_request();

        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());

        // The critical header: Access-Control-Allow-Private-Network: true
        let pna_header = resp.headers().get("Access-Control-Allow-Private-Network");
        assert!(pna_header.is_some(), "Access-Control-Allow-Private-Network header must be present");
        assert_eq!(
            pna_header.unwrap().to_str().unwrap(),
            "true",
            "Access-Control-Allow-Private-Network must be 'true'"
        );

        // Also verify standard CORS headers (use string names to avoid http crate version conflict)
        assert!(resp.headers().get("Access-Control-Allow-Origin").is_some());
        assert!(resp.headers().get("Access-Control-Allow-Methods").is_some());
        assert!(resp.headers().get("Access-Control-Max-Age").is_some());
    }

    /// Verify CORS preflight WITHOUT PNA request header does NOT include
    /// Access-Control-Allow-Private-Network (only sent when requested).
    #[actix_rt::test]
    async fn cors_preflight_without_pna_request_no_pna_response() {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .expose_headers(["Content-Range", "Content-Length", "Accept-Ranges", "X-Cache", "X-Reason"])
            .allow_private_network_access()
            .max_age(3600);

        let app = test::init_service(
            App::new()
                .wrap(cors)
                .route("/test", web::get().to(test_handler))
        ).await;

        let req = test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri("/test")
            .insert_header((actix_header::ORIGIN, "http://localhost:14200"))
            .insert_header((actix_header::ACCESS_CONTROL_REQUEST_METHOD, "GET"))
            .to_request();

        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());

        // PNA header should NOT be present when not requested
        let pna_header = resp.headers().get("Access-Control-Allow-Private-Network");
        assert!(pna_header.is_none(), "PNA header should not be sent when not requested");
    }

    /// Verify CORS exposes Content-Range header in actual responses (not preflight).
    /// Access-Control-Expose-Headers is only present in actual responses, not preflight.
    /// Needed for Range request video streaming — the browser must be able to read
    /// Content-Range from the response.
    #[actix_rt::test]
    async fn cors_exposes_content_range_header() {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .expose_headers(["Content-Range", "Content-Length", "Accept-Ranges", "X-Cache", "X-Reason"])
            .allow_private_network_access()
            .max_age(3600);

        let app = test::init_service(
            App::new()
                .wrap(cors)
                .route("/test", web::get().to(test_handler))
        ).await;

        // Use a regular GET request (not OPTIONS) — Expose-Headers only appears in actual responses
        let req = test::TestRequest::default()
            .method(Method::GET)
            .uri("/test")
            .insert_header((actix_header::ORIGIN, "http://localhost:14200"))
            .to_request();

        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());

        let expose_headers = resp.headers().get("Access-Control-Expose-Headers");
        assert!(expose_headers.is_some(), "Access-Control-Expose-Headers must be present in actual response");
        let expose_str = expose_headers.unwrap().to_str().unwrap();
        // actix-cors lowercases header values — use case-insensitive checks
        let lower = expose_str.to_lowercase();
        assert!(lower.contains("content-range"), "Content-Range must be exposed");
        assert!(lower.contains("content-length"), "Content-Length must be exposed");
        assert!(lower.contains("accept-ranges"), "Accept-Ranges must be exposed");
        assert!(lower.contains("x-reason"), "X-Reason must be exposed");
    }
}

// Continuation tests removed — ContinuationGuard and continuation_should_run
// have been removed. The proactive prebuffer is now the ONLY path that
// downloads from Telegram; /stream reads exclusively from disk cache.









