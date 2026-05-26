// faststart.rs — On-the-fly MP4 moov-atom relocation for streaming
//
// When an MP4 has its moov atom at the end (non-faststarted), the browser
// must download the entire file before it can start playback. This module
// creates a virtual "faststarted" view where the moov appears at the front,
// enabling immediate playback for any codec the browser's native decoder supports.
//
// Virtual layout:  [ftyp/prefix][patched moov][mdat]
// Real layout:     [ftyp/prefix][mdat][moov]

use actix_web::{get, head, web, HttpRequest, HttpResponse, Responder, http::header};
use crate::commands::TelegramState;
use crate::server::{self, StreamTokenData, StreamQuery};
use grammers_client::Client;
use grammers_client::types::Media;
use std::sync::Arc;
use tokio::sync::Mutex;
use std::collections::HashMap;

const TELEGRAM_CHUNK_SIZE: i32 = 512 * 1024;

// ── Data Structures ────────────────────────────────────────────

/// Describes the real file layout and how to build the virtual layout.
#[derive(Clone)]
struct MoovLayout {
    /// Byte offset where mdat starts in the real file (= prefix size).
    mdat_real_offset: u64,
    /// Size of the moov atom in bytes.
    moov_size: u64,
    /// Size of the mdat atom in bytes.
    mdat_size: u64,
}

impl MoovLayout {
    /// Total size of the virtual (faststarted) file.
    fn virtual_size(&self) -> u64 {
        self.mdat_real_offset + self.moov_size + self.mdat_size
    }

    /// Map a virtual byte range `[vstart, vend]` (inclusive) into real file ranges.
    /// Returns `Vec<(real_start, real_end, source)>` where source is:
    /// - `"moov"` → serve from patched moov cache
    /// - `"file"` → download from Telegram at real_start..real_end
    fn map_range(&self, vstart: u64, vend: u64) -> Vec<(u64, u64, &'static str)> {
        let prefix_end = self.mdat_real_offset;
        let moov_virtual_start = prefix_end;
        let moov_virtual_end = prefix_end + self.moov_size.saturating_sub(1);
        let mdat_virtual_start = prefix_end + self.moov_size;

        let mut ranges = Vec::new();
        let mut pos = vstart;

        while pos <= vend {
            if pos < prefix_end {
                // In prefix region (ftyp etc.) — direct mapping to real file
                let seg_end = vend.min(prefix_end.saturating_sub(1));
                ranges.push((pos, seg_end, "file"));
                pos = seg_end.saturating_add(1);
            } else if pos <= moov_virtual_end {
                // In virtual moov region — serve from patched moov cache
                let seg_start = pos - moov_virtual_start;
                let seg_end = (vend - moov_virtual_start).min(self.moov_size.saturating_sub(1));
                ranges.push((seg_start, seg_end, "moov"));
                pos = moov_virtual_start + seg_end + 1;
            } else if pos < self.virtual_size() {
                // In virtual mdat region — map to real mdat position
                let mdat_internal_start = pos.saturating_sub(mdat_virtual_start);
                let mdat_internal_end = vend.saturating_sub(mdat_virtual_start)
                    .min(self.mdat_size.saturating_sub(1));
                let real_start = self.mdat_real_offset + mdat_internal_start;
                let real_end = self.mdat_real_offset + mdat_internal_end;
                ranges.push((real_start, real_end, "file"));
                pos = mdat_virtual_start + mdat_internal_end + 1;
            } else {
                break;
            }
        }

        ranges
    }
}

/// Cached faststart data for a message — the patched moov and layout info.
struct CachedFaststart {
    patched_moov: Vec<u8>,
    layout: MoovLayout,
}

/// Thread-safe cache keyed by message_id.
type FaststartCache = Arc<Mutex<HashMap<i32, Arc<CachedFaststart>>>>;

// ── MP4 Atom Parsing ──────────────────────────────────────────

/// Read a big-endian u32 from bytes at the given offset.
fn read_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap())
}

/// Read a big-endian u64 from bytes at the given offset.
fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes(data[offset..offset + 8].try_into().unwrap())
}

/// Parse an MP4 atom header at `offset`.
/// Returns `(atom_total_size, atom_type_str, data_start_offset)`.
/// `atom_total_size` includes the size/type header fields.
fn parse_atom_header(data: &[u8], offset: usize) -> Option<(u64, &str, usize)> {
    if offset + 8 > data.len() {
        return None;
    }

    let raw_size = read_u32(data, offset) as u64;
    let type_str = std::str::from_utf8(&data[offset + 4..offset + 8]).ok()?;

    match raw_size {
        0 => {
            // Atom extends to end of file/data
            Some(((data.len() - offset) as u64, type_str, offset + 8))
        }
        1 => {
            // 64-bit extended size follows the type
            if offset + 16 > data.len() {
                return None;
            }
            let extended_size = read_u64(data, offset + 8);
            Some((extended_size, type_str, offset + 16))
        }
        _ => Some((raw_size, type_str, offset + 8)),
    }
}

/// Scan the beginning of an MP4 file to find the atom layout.
/// Returns `Some(mdat_start, mdat_size, prefix_size)` if the file has
/// mdat following the prefix (i.e., moov is NOT at the front).
/// Returns `None` if moov is at the front (already faststarted) or
/// the layout can't be determined.
fn scan_atom_layout(data: &[u8]) -> Option<(u64, u64, u64)> {
    let mut offset: usize = 0;

    while offset + 8 <= data.len() {
        let (atom_size, atom_type, _data_start) = parse_atom_header(data, offset)?;

        if atom_type == "mdat" {
            // mdat found — prefix is everything before it
            return Some((offset as u64, atom_size, offset as u64));
        }

        if atom_type == "moov" {
            // moov at the front — already faststarted, no conversion needed
            return None;
        }

        if atom_size < 8 {
            break;
        }
        offset += atom_size as usize;
    }

    None
}

/// Recursively scan a moov atom's child boxes to find stco/co64 tables
/// and add `adjustment` to every chunk offset.
fn patch_moov_chunk_offsets(moov: &mut [u8], adjustment: u64) {
    let mut offset: usize = 0;

    while offset + 8 <= moov.len() {
        let (atom_size, atom_type, data_start) = match parse_atom_header(moov, offset) {
            Some(a) => a,
            None => break,
        };

        match atom_type {
            "stco" => patch_stco_table(moov, data_start, adjustment),
            "co64" => patch_co64_table(moov, data_start, adjustment),
            "moov" | "trak" | "mdia" | "minf" | "stbl" | "udta" | "meta"
            | "dinf" | "edts" | "mvex" | "moof" | "tref" => {
                // Recurse into container atoms
                let end = (offset + atom_size as usize).min(moov.len());
                if data_start < end {
                    patch_moov_chunk_offsets(&mut moov[data_start..end], adjustment);
                }
            }
            _ => { /* Leaf atom — nothing to recurse into */ }
        }

        if atom_size < 8 {
            break;
        }
        let next = offset + atom_size as usize;
        if next <= offset {
            break; // Prevent infinite loop on malformed data
        }
        offset = next;
    }
}

/// Patch a 32-bit stco (chunk offset) table.
fn patch_stco_table(data: &mut [u8], data_start: usize, adjustment: u64) {
    // stco layout: version(1) + flags(3) + entry_count(4) + entries(4 × N)
    if data_start + 8 > data.len() {
        return;
    }
    let entry_count = read_u32(data, data_start + 4) as usize;
    let entries_start = data_start + 8;
    let entries_end = entries_start + entry_count * 4;
    if entries_end > data.len() {
        return;
    }

    let adjustment_u32 = adjustment as u32;
    for i in 0..entry_count {
        let pos = entries_start + i * 4;
        let old_offset = read_u32(data, pos);
        let new_offset = old_offset.wrapping_add(adjustment_u32);
        data[pos..pos + 4].copy_from_slice(&new_offset.to_be_bytes());
    }
}

/// Patch a 64-bit co64 (large chunk offset) table.
fn patch_co64_table(data: &mut [u8], data_start: usize, adjustment: u64) {
    // co64 layout: version(1) + flags(3) + entry_count(4) + entries(8 × N)
    if data_start + 8 > data.len() {
        return;
    }
    let entry_count = read_u32(data, data_start + 4) as usize;
    let entries_start = data_start + 8;
    let entries_end = entries_start + entry_count * 8;
    if entries_end > data.len() {
        return;
    }

    for i in 0..entry_count {
        let pos = entries_start + i * 8;
        let old_offset = read_u64(data, pos);
        let new_offset = old_offset.wrapping_add(adjustment);
        data[pos..pos + 8].copy_from_slice(&new_offset.to_be_bytes());
    }
}

// ── Telegram Download Helpers ─────────────────────────────────

/// Download a specific byte range `[start, end]` (inclusive) from a Telegram media file.
async fn download_range(
    client: &Client,
    media: &Media,
    start: u64,
    end: u64,
    semaphore: &Arc<tokio::sync::Semaphore>,
) -> Result<Vec<u8>, String> {
    let chunks_to_skip = (start / TELEGRAM_CHUNK_SIZE as u64) as i32;
    let bytes_to_discard = start % TELEGRAM_CHUNK_SIZE as u64;
    let total_needed = (end - start + 1) as usize;

    let mut result = Vec::with_capacity(total_needed);
    let mut first_chunk = true;
    let mut downloaded: u64 = 0;

    let download_iter = client
        .iter_download(media)
        .chunk_size(TELEGRAM_CHUNK_SIZE)
        .skip_chunks(chunks_to_skip);

    let mut iter = download_iter;

    while downloaded < total_needed as u64 {
        let _permit = semaphore.acquire().await.map_err(|e| e.to_string())?;

        match iter.next().await.transpose() {
            Some(Ok(bytes)) => {
                let mut chunk = bytes;

                if first_chunk && bytes_to_discard > 0 {
                    let discard = bytes_to_discard.min(chunk.len() as u64) as usize;
                    chunk = chunk[discard..].to_vec();
                    first_chunk = false;
                }

                let remaining = total_needed.saturating_sub(downloaded as usize);
                if chunk.len() > remaining {
                    chunk.truncate(remaining);
                }

                downloaded += chunk.len() as u64;
                result.extend_from_slice(&chunk);
            }
            None => break,
            Some(Err(e)) => return Err(format!("Telegram download error: {}", e)),
        }
    }

    if downloaded < total_needed as u64 {
        return Err(format!(
            "Incomplete download: got {} of {} bytes",
            downloaded, total_needed
        ));
    }

    Ok(result)
}

/// Download the moov atom from near the end of the file.
///
/// Strategy: download the last 512 KB, scan backwards for the moov header,
/// then download more if the moov extends beyond the fetched tail.
/// Returns `(moov_bytes, moov_real_offset)`.
async fn download_moov(
    client: &Client,
    media: &Media,
    file_size: u64,
    semaphore: &Arc<tokio::sync::Semaphore>,
) -> Result<(Vec<u8>, u64), String> {
    // Start with last 512 KB — typical moov is 200-500 KB
    let initial_fetch: u64 = 512 * 1024;
    let fetch_start = file_size.saturating_sub(initial_fetch);
    let fetch_end = file_size.saturating_sub(1);

    let tail_data = download_range(client, media, fetch_start, fetch_end, semaphore).await?;

    // Find moov atom header in the tail data
    let mut moov_offset_in_tail: Option<usize> = None;
    let mut moov_size: u64 = 0;
    let mut offset: usize = 0;

    while offset + 8 <= tail_data.len() {
        if let Some((size, atom_type, _)) = parse_atom_header(&tail_data, offset) {
            if atom_type == "moov" {
                moov_offset_in_tail = Some(offset);
                moov_size = size;
                break;
            }
            if size < 8 {
                break;
            }
            offset += size as usize;
        } else {
            break;
        }
    }

    let moov_offset_in_tail =
        moov_offset_in_tail.ok_or_else(|| "Could not find moov atom in file tail".to_string())?;

    let moov_real_offset = fetch_start + moov_offset_in_tail as u64;
    let moov_end = moov_real_offset + moov_size;

    if moov_end > file_size {
        return Err("Moov atom extends beyond declared file size".to_string());
    }

    // Check if the complete moov is within the already-downloaded tail
    let moov_in_tail_end = moov_offset_in_tail as u64 + moov_size;
    if moov_in_tail_end <= tail_data.len() as u64 {
        let start = moov_offset_in_tail;
        let end = moov_in_tail_end as usize;
        return Ok((tail_data[start..end].to_vec(), moov_real_offset));
    }

    // Need to download the full moov from its real offset
    let moov_data =
        download_range(client, media, moov_real_offset, moov_end - 1, semaphore).await?;
    Ok((moov_data, moov_real_offset))
}

// ── Entry Point: Analyze and Prepare ──────────────────────────

/// Analyze the file and prepare faststart data if needed.
///
/// Returns:
/// - `Ok(Some(cached))` — faststart conversion was performed
/// - `Ok(None)` — file is already faststarted, no conversion needed
/// - `Err(...)` — something went wrong
async fn prepare_faststart(
    client: &Client,
    media: &Media,
    file_size: u64,
    msg_id: i32,
    semaphore: &Arc<tokio::sync::Semaphore>,
    cache: &FaststartCache,
) -> Result<Option<Arc<CachedFaststart>>, String> {
    // Check in-memory cache first
    {
        let cache_guard = cache.lock().await;
        if let Some(cached) = cache_guard.get(&msg_id) {
            log::info!(
                "[FASTSTART] Cache HIT for msg {} (moov {} bytes, virtual size {})",
                msg_id,
                cached.patched_moov.len(),
                cached.layout.virtual_size()
            );
            return Ok(Some(cached.clone()));
        }
    }

    // Download first 16 KB to inspect atom layout
    let head_end = 16383u64.min(file_size.saturating_sub(1));
    let head_data = download_range(client, media, 0, head_end, semaphore).await?;

    // Scan for ftyp → mdat (non-faststarted) or ftyp → moov (already faststarted)
    let (mdat_real_offset, mdat_size, _prefix_size) = scan_atom_layout(&head_data)
        .ok_or_else(|| {
            log::info!(
                "[FASTSTART] msg {} is already faststarted or has unsupported layout",
                msg_id
            );
            "Already faststarted".to_string()
        })?;

    log::info!(
        "[FASTSTART] msg {} needs conversion: mdat at offset {} ({} bytes), file_size={}",
        msg_id,
        mdat_real_offset,
        mdat_size,
        file_size
    );

    // Download and extract moov atom from end of file
    let (moov_data, moov_real_offset) =
        download_moov(client, media, file_size, semaphore).await?;

    let moov_size = moov_data.len() as u64;

    log::info!(
        "[FASTSTART] msg {} moov at real offset {} ({} bytes)",
        msg_id,
        moov_real_offset,
        moov_size
    );

    // Build layout
    let layout = MoovLayout {
        mdat_real_offset,
        moov_size,
        mdat_size,
    };

    // Patch moov chunk offsets: in the virtual layout the mdat is shifted
    // forward by moov_size bytes, so every stco/co64 entry must increase by moov_size.
    let mut patched_moov = moov_data;
    patch_moov_chunk_offsets(&mut patched_moov, moov_size);

    let cached = Arc::new(CachedFaststart {
        patched_moov,
        layout,
    });

    // Store in cache for subsequent requests
    {
        let mut cache_guard = cache.lock().await;
        cache_guard.insert(msg_id, cached.clone());
    }

    log::info!(
        "[FASTSTART] Prepared msg {}: virtual_size={}, moov_patched=true",
        msg_id,
        cached.layout.virtual_size()
    );

    Ok(Some(cached))
}

// ── Actix Endpoints ───────────────────────────────────────────

/// HEAD endpoint — returns Content-Length of the virtual faststarted file.
#[head("/stream-faststart/{folder_id}/{message_id}")]
async fn stream_faststart_head(
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    faststart_cache: web::Data<FaststartCache>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    let (media, file_size) = match server::resolve_media_from_path(
        &folder_id_str,
        message_id,
        &data,
        &token_data,
        &query,
    )
    .await
    {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let mime = server::mime_type_from_media(&media);

    let client = {
        let guard = data.client.lock().await;
        match guard.as_ref() {
            Some(c) => c.clone(),
            None => {
                return HttpResponse::ServiceUnavailable()
                    .body("Telegram client not connected");
            }
        }
    };

    match prepare_faststart(
        &client,
        &media,
        file_size,
        message_id,
        &data.download_semaphore,
        &faststart_cache,
    )
    .await
    {
        Ok(Some(cached)) => {
            let virtual_size = cached.layout.virtual_size();
            HttpResponse::Ok()
                .insert_header(("Content-Type", mime))
                .insert_header(("Content-Length", virtual_size.to_string()))
                .insert_header(("Accept-Ranges", "bytes"))
                .insert_header(("X-Faststart", "true"))
                .finish()
        }
        Ok(None) => {
            // Already faststarted — redirect to normal stream endpoint
            let token = query.token.as_deref().unwrap_or("");
            HttpResponse::Found()
                .insert_header((
                    header::LOCATION,
                    format!("/stream/{}?token={}", folder_id_str, token),
                ))
                .finish()
        }
        Err(e) => {
            log::error!(
                "[FASTSTART] HEAD prepare error for msg {}: {}",
                message_id,
                e
            );
            HttpResponse::InternalServerError()
                .body(format!("Faststart preparation error: {}", e))
        }
    }
}

/// GET endpoint — serves the virtual faststarted file.
///
/// Range requests are mapped from virtual offsets to real file offsets.
/// The moov portion is served from the cached patched moov;
/// everything else is streamed from Telegram on demand.
#[get("/stream-faststart/{folder_id}/{message_id}")]
async fn stream_faststart(
    req: HttpRequest,
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    faststart_cache: web::Data<FaststartCache>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    let (media, file_size) = match server::resolve_media_from_path(
        &folder_id_str,
        message_id,
        &data,
        &token_data,
        &query,
    )
    .await
    {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let mime = server::mime_type_from_media(&media);

    let client = {
        let guard = data.client.lock().await;
        match guard.as_ref() {
            Some(c) => c.clone(),
            None => {
                return HttpResponse::ServiceUnavailable()
                    .body("Telegram client not connected");
            }
        }
    };

    let cached = match prepare_faststart(
        &client,
        &media,
        file_size,
        message_id,
        &data.download_semaphore,
        &faststart_cache,
    )
    .await
    {
        Ok(Some(c)) => c,
        Ok(None) => {
            // Already faststarted — redirect to normal stream endpoint
            let token = query.token.as_deref().unwrap_or("");
            return HttpResponse::Found()
                .insert_header((
                    header::LOCATION,
                    format!("/stream/{}?token={}", folder_id_str, token),
                ))
                .finish();
        }
        Err(e) => {
            log::error!(
                "[FASTSTART] GET prepare error for msg {}: {}",
                message_id,
                e
            );
            return HttpResponse::InternalServerError()
                .body(format!("Faststart preparation error: {}", e));
        }
    };

    let virtual_size = cached.layout.virtual_size();

    // Parse Range header (same logic as /stream/ endpoint)
    let range_header = req
        .headers()
        .get("Range")
        .and_then(|v| v.to_str().ok());

    let (start_byte, end_byte) = if let Some(range_str) = range_header {
        match server::parse_range_header(range_str, virtual_size) {
            Some((s, e)) => (s, e),
            None => {
                return HttpResponse::build(
                    actix_web::http::StatusCode::RANGE_NOT_SATISFIABLE,
                )
                .insert_header(("Content-Range", format!("bytes */{}", virtual_size)))
                .body("Invalid Range header");
            }
        }
    } else {
        (0, virtual_size.saturating_sub(1))
    };

    let content_length = end_byte - start_byte + 1;
    let is_partial =
        range_header.is_some() && (start_byte > 0 || end_byte < virtual_size.saturating_sub(1));

    // Map virtual range(s) to real ranges
    let ranges = cached.layout.map_range(start_byte, end_byte);

    log::info!(
        "[FASTSTART] Serving msg {}: virtual {}-{} ({} bytes), {} real segments",
        message_id,
        start_byte,
        end_byte,
        content_length,
        ranges.len()
    );

    // Clone data needed inside the async stream
    let patched_moov = cached.patched_moov.clone();
    let media_owned = media.clone();
    let client_owned = client.clone();
    let semaphore = data.download_semaphore.clone();

    let stream = async_stream::stream! {
        for (real_start, real_end, source) in ranges {
            let chunk: Vec<u8> = if source == "moov" {
                // Serve from in-memory patched moov
                let s = real_start as usize;
                let e = (real_end as usize + 1).min(patched_moov.len());
                if s < e {
                    patched_moov[s..e].to_vec()
                } else {
                    Vec::new()
                }
            } else {
                // Download from Telegram at real offsets
                match download_range(
                    &client_owned,
                    &media_owned,
                    real_start,
                    real_end,
                    &semaphore,
                )
                .await
                {
                    Ok(data) => data,
                    Err(e) => {
                        log::error!(
                            "[FASTSTART] Download error for msg {} range {}-{}: {}",
                            message_id,
                            real_start,
                            real_end,
                            e
                        );
                        break;
                    }
                }
            };

            if !chunk.is_empty() {
                yield Ok::<_, actix_web::Error>(web::Bytes::from(chunk));
            }
        }
    };

    if is_partial {
        HttpResponse::PartialContent()
            .insert_header(("Content-Type", mime))
            .insert_header(("Content-Length", content_length.to_string()))
            .insert_header((
                "Content-Range",
                format!("bytes {}-{}/{}", start_byte, end_byte, virtual_size),
            ))
            .insert_header(("Accept-Ranges", "bytes"))
            .insert_header(("X-Faststart", "true"))
            .streaming(stream)
    } else {
        HttpResponse::Ok()
            .insert_header(("Content-Type", mime))
            .insert_header(("Content-Length", content_length.to_string()))
            .insert_header(("Accept-Ranges", "bytes"))
            .insert_header(("X-Faststart", "true"))
            .streaming(stream)
    }
}

// ── Actix Service Configuration ───────────────────────────────

/// Register the faststart endpoints and shared cache with the Actix app.
pub fn configure_faststart(cfg: &mut web::ServiceConfig) {
    let cache: FaststartCache = Arc::new(Mutex::new(HashMap::new()));
    cfg.app_data(web::Data::new(cache));
    cfg.service(stream_faststart_head);
    cfg.service(stream_faststart);

    log::info!("Faststart streaming endpoints registered");
}
