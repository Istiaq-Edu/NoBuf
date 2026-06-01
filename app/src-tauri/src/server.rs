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
use crate::stream_cache::{StreamCacheManager, CacheMeta, merge_ranges, is_range_cached, MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE};
use std::io::{Write, Seek, SeekFrom};

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
///    (PMT PID 0x0FFF→0x1000, stream_type 0x15→0x0F)
/// 2. Inline PAT/PMT packets beyond the init_prefix: rewrite PID 0x0FFF→0x1000
///    and stream_type 0x15→0x0F. Mediabunny may re-read inline PAT packets and
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
                    let extracted = hls::manifest::ensure_init_prefix(cache_mgr, message_id, path, ts_packet_size, is_m2ts);
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

    // Step 3: Rewrite inline PAT/PMT packets throughout the buffer (beyond init_prefix).
    // Scan for TS sync bytes (0x47) at 188-byte-aligned positions relative to the
    // file start. Skip packets within the init_prefix range (already rewritten in Step 2).
    // For each PAT packet (PID 0x0000), rewrite PMT PID declaration 0x0FFF→0x1000.
    // For each PMT packet (PID 0x0FFF), rewrite TS header PID 0x0FFF→0x1000 and
    // stream_type 0x15→0x0F.
    let ps: usize = 188;
    let file_offset_mod = buf_start % ps as u64;
    let first_pkt_offset = if file_offset_mod == 0 { 0 } else { ps - file_offset_mod as usize };
    let init_prefix_end_pkt = (prefix_len as usize + ps - 1) / ps; // Packet index of init_prefix end

    let mut pkt_offset = first_pkt_offset;
    while pkt_offset + ps <= buf.len() {
        if buf[pkt_offset] != 0x47 {
            pkt_offset += ps;
            
            continue;
        }

        // Skip packets within init_prefix range (already rewritten in Step 2)
        let file_pkt_idx = (buf_start as usize + pkt_offset) / ps;
        if file_pkt_idx < init_prefix_end_pkt {
            pkt_offset += ps;
            
            continue;
        }

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
            if payload_offset >= pkt_offset + ps || pusi != 1 {
                pkt_offset += ps;
                
                continue;
            }

            let pointer = buf[payload_offset] as usize;
            let section_start = payload_offset + 1 + pointer;
            if section_start + 8 >= pkt_offset + ps {
                pkt_offset += ps;
                
                continue;
            }

            let table_id = buf[section_start];
            if table_id != 0x00 {
                pkt_offset += ps;
                
                continue;
            }

            let section_length = (((buf[section_start + 1] & 0x0F) as u16) << 8) | buf[section_start + 2] as u16;
            let num_programs = ((section_length - 9) / 4) as usize;

            let mut pat_rewritten = false;
            for p in 0..num_programs {
                let prog_offset = section_start + 8 + p * 4;
                if prog_offset + 4 > pkt_offset + ps { break; }
                let prog_num = ((buf[prog_offset] as u16) << 8) | buf[prog_offset + 1] as u16;
                if prog_num == 0 { continue; }
                let declared_pid = ((buf[prog_offset + 2] as u16 & 0x1F) << 8) | buf[prog_offset + 3] as u16;
                if declared_pid == 0x0FFF {
                    buf[prog_offset + 2] = (buf[prog_offset + 2] & 0xE0) | ((0x1000 >> 8) as u8 & 0x1F);
                    buf[prog_offset + 3] = (0x1000 & 0xFF) as u8;
                    pat_rewritten = true;
                }
            }

            if pat_rewritten {
                let section_end_with_crc = section_start + 3 + section_length as usize;
                let crc_end = section_end_with_crc - 4;
                if crc_end > section_start && crc_end <= pkt_offset + ps {
                    let new_crc = hls::manifest::crc32_mpeg2(&buf[section_start..crc_end]);
                    buf[crc_end] = ((new_crc >> 24) & 0xFF) as u8;
                    buf[crc_end + 1] = ((new_crc >> 16) & 0xFF) as u8;
                    buf[crc_end + 2] = ((new_crc >> 8) & 0xFF) as u8;
                    buf[crc_end + 3] = (new_crc & 0xFF) as u8;
                    did_rewrite = true;
                }
            }
        } else if pid == 0x0FFF {
            // Potential PMT packet on null stuffing PID — check if it's actually PMT
            let pusi = (buf[pkt_offset + 1] >> 6) & 0x01;
            let afc = (buf[pkt_offset + 3] >> 4) & 0x03;
            let mut payload_offset = pkt_offset + 4;
            if afc & 0x02 != 0 {
                let af_len = buf[payload_offset] as usize;
                payload_offset += 1 + af_len;
            }
            if payload_offset >= pkt_offset + ps || pusi != 1 {
                pkt_offset += ps;
                
                continue;
            }

            let pointer = buf[payload_offset] as usize;
            let section_start = payload_offset + 1 + pointer;
            if section_start >= pkt_offset + ps {
                pkt_offset += ps;
                
                continue;
            }

            let table_id = buf[section_start];
            if table_id != 0x02 {
                // Not PMT — null stuffing or other section, skip
                pkt_offset += ps;
                
                continue;
            }

            // This is a PMT on PID 0x0FFF — rewrite TS header PID: 0x0FFF → 0x1000
            buf[pkt_offset + 1] = (buf[pkt_offset + 1] & 0xE0) | ((0x1000 >> 8) as u8 & 0x1F);
            buf[pkt_offset + 2] = (0x1000 & 0xFF) as u8;

            // Recalculate PMT CRC-32
            let section_length = (((buf[section_start + 1] & 0x0F) as u16) << 8) | buf[section_start + 2] as u16;
            let section_end_with_crc = section_start + 3 + section_length as usize;
            let crc_end = section_end_with_crc - 4;
            if crc_end > section_start && crc_end <= pkt_offset + ps {
                let new_crc = hls::manifest::crc32_mpeg2(&buf[section_start..crc_end]);
                buf[crc_end] = ((new_crc >> 24) & 0xFF) as u8;
                buf[crc_end + 1] = ((new_crc >> 16) & 0xFF) as u8;
                buf[crc_end + 2] = ((new_crc >> 8) & 0xFF) as u8;
                buf[crc_end + 3] = (new_crc & 0xFF) as u8;

                // Rewrite stream_types 0x15→0x0F in PMT
                hls::manifest::rewrite_pmt_stream_types(buf, section_start, pkt_offset + ps);
                did_rewrite = true;
            }
        }

        pkt_offset += ps;
        
    }

    if did_rewrite {
        log::debug!("[PREBUFFER] TS stream rewrite: msg {} buf range {}-{}, init_prefix + inline PAT/PMT",
            message_id, buf_start, buf_start + buf.len() as u64 - 1);
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

/// Drop-guard that spawns a background continuation task when the Actix response
/// ends due to client disconnect. This keeps the Telegram download going so
/// subsequent overlapping range requests find cached data instead of starting
/// new downloads (fixes native video player backend overload).
///
/// Key design: continuation tasks ARE registered with the coordinator so new
/// player requests can discover and subscribe to them. Progress is broadcast
/// via the coordinator's watch channel so subscribers know when data is
/// available in cache. This prevents duplicate downloads and allows the
/// continuation to skip throttling when a player is actively subscribed.
/// Decide whether a continuation background download should be spawned.
/// Returns (should_continue, remaining_bytes, continuation_start_offset, file_end_byte).
///
/// This is the pure logic extracted from ContinuationGuard::drop for testability.
/// The decision depends on:
/// - `total_file_size`: full file size (not just the request range end)
/// - `start_byte`: where the HTTP request range started
/// - `bytes_sent`: how many bytes were actually streamed before the response ended
///
/// The continuation downloads from `start_byte + bytes_sent` to `total_file_size - 1`,
/// not just to the request's `end_byte`. This is critical for pre-buffer requests:
/// after serving a 5MB range, we must continue downloading to the full file end
/// so segments beyond the pre-buffer range can be served from cache.
fn continuation_should_run(total_file_size: u64, start_byte: u64, bytes_sent: u64) -> (bool, u64, u64, u64) {
    // Defensive: bail out if we can't calculate remaining meaningfully.
    // total_file_size == 0 means unknown file size. If start_byte >=
    // total_file_size, the range was beyond the file — no continuation.
    if total_file_size == 0 || start_byte >= total_file_size {
        return (false, 0, 0, 0);
    }

    // Calculate remaining bytes in the FILE (not just the request range).
    // sent is always <= total_file_size - start_byte because we only
    // stream data within [start_byte, total_file_size-1], so no underflow.
    let remaining = (total_file_size - start_byte) - bytes_sent;

    // Only continue if there's meaningful data left (>2MB) and
    // the download wasn't trivially short. Small remaining data (<2MB)
    // doesn't warrant a background task — it will be requested
    // again quickly if needed, and spawning a task for <2MB
    // creates coordinator noise without meaningful benefit.
    if remaining < 2 * 1024 * 1024 || bytes_sent == 0 {
        return (false, remaining, start_byte + bytes_sent, total_file_size - 1);
    }

    let current_offset = start_byte + bytes_sent;
    let file_end = total_file_size - 1;
    (true, remaining, current_offset, file_end)
}

struct ContinuationGuard {
    cache_mgr: Option<StreamCacheManager>,
    message_id: i32,
    start_byte: u64,
    /// End byte of the HTTP request range (e.g., 5242880 for a 5MB pre-buffer).
    /// Used for coordinator registration matching.
    request_end_byte: u64,
    /// Total file size — the continuation downloads to this boundary,
    /// not just to the request's end_byte. This is critical for
    /// pre-buffer requests: after serving a 5MB range, we must
    /// continue downloading to the full file end so segments beyond
    /// the pre-buffer range can be served from cache.
    total_file_size: u64,
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
            let (should_continue, remaining, current_offset, file_end) =
                continuation_should_run(self.total_file_size, self.start_byte, sent);

            if !should_continue {
                return;
            }

            let msg_id = self.message_id;
            let cache_mgr_clone = cm.clone();
            let client_opt = self.client.take();
            let media_clone = self.media.clone();
            let folder_id = self.cache_folder_id;
            let filename = self.cache_filename.clone();
            let mime = self.mime_stream.clone();
            let semaphore = self.download_semaphore.clone();
            let limit_kb = self.speed_limit_kb;
            let total_size = self.total_file_size; // For CacheMeta recovery

            log::info!(
                "[CONTINUATION] Evaluating background download for msg {} range {}-{} (request was {}-{}, sent {}, remaining {})",
                msg_id, current_offset, file_end, self.start_byte, self.request_end_byte, sent, remaining
            );

            tokio::spawn(async move {
                // CRITICAL: Check if there's a covering download already active.
                // If another SEQUENTIAL download covers our continuation range,
                // it will cache the data anyway — no need for a wasteful duplicate.
                if cache_mgr_clone.find_best_covering_download(msg_id, current_offset, file_end).await.is_some() {
                    log::info!(
                        "[CONTINUATION] Skipping for msg {} — covering download exists, it will cache the data",
                        msg_id
                    );
                    return;
                }

                // Register continuation covering the ENTIRE file range (0→file_end),
                // not just current_offset→file_end. This ensures that requests for
                // segments that straddle the prebuffer→continuation boundary (e.g.
                // seg 2 at 4997040-7495183 where prebuffer ended at 5242880) will
                // find this download and subscribe to it. The continuation's
                // progress_rx will show progress >= current_offset immediately,
                // so subscribers will know bytes 0→current_offset are on disk.
                let cont_register_start = 0u64;
                // Register continuation with initial_progress=current_offset.
                // This initializes the watch channel to current_offset (not 0),
                // eliminating the race condition where subscribers read progress=0
                // before the update_download_progress call broadcasts current_offset.
                // Subscribers immediately see bytes 0→current_offset as on disk.
                let registered = cache_mgr_clone.register_download(msg_id, cont_register_start, file_end, true, current_offset).await;
                let cont_start_byte = if registered.is_some() { cont_register_start } else { current_offset };

                // Note: No need for a separate update_download_progress call —
                // the watch channel is already initialized with current_offset.
                // The separate broadcast was causing a race condition where
                // subscribers could read start_byte=0 before the update arrived.

                let client = match client_opt {
                    Some(c) => c,
                    None => {
                        log::warn!("[CONTINUATION] No client available for msg {}", msg_id);
                        return;
                    }
                };

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
                let mut pending_ranges: Vec<(u64, u64)> = Vec::new(); // Batched meta save
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
                    // Exclude continuation downloads (is_continuation flag) so we
                    // don't find ourselves and loop infinitely.
                    if bytes_total > 0 && bytes_total % (4 * 1024 * 1024) == 0 {
                        let covering = cache_mgr_clone.find_best_covering_download(msg_id, offset, file_end).await;
                        if covering.is_some() && !covering.unwrap().is_continuation {
                            log::info!(
                                "[CONTINUATION] Stopping for msg {} — player-facing covering download appeared at offset {}",
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

                            let remaining_bytes = file_end - offset + 1;
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

                                // Accumulate range for batched meta save.
                                // Instead of saving meta on every chunk (expensive
                                // sync_all + rename on Windows), accumulate ranges
                                // and flush every 4MB to reduce I/O overhead.
                                pending_ranges.push((offset, chunk_range_end));
                                if pending_ranges.len() >= 8 || chunk_range_end >= file_end {
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
                                    meta.cached_ranges.extend(pending_ranges.drain(..));
                                    merge_ranges(&mut meta.cached_ranges);
                                    if let Err(e) = cache_mgr_clone.save_meta(&meta) {
                                        log::warn!("[CONTINUATION] Failed to save meta for msg {}: {}", msg_id, e);
                                    }
                                    drop(_lock);
                                }
                            } else {
                                log::debug!("[CONTINUATION] Skipping cached range {}-{} for msg {}", offset, chunk_range_end, msg_id);
                            }

                            offset += bytes_in_chunk;
                            bytes_total += bytes_in_chunk;

                            // Broadcast progress to coordinator so subscribed
                            // player requests know data is available in cache.
                            cache_mgr_clone.update_download_progress(msg_id, cont_start_byte, chunk_range_end).await;

                            // Throttle only when no player is subscribed.
                            // If the coordinator has subscribers watching our
                            // progress channel, skip throttling — the player
                            // needs data fast and is actively waiting.
                            if limit_kb > 0 && registered.is_none() {
                                let sleep_ms = (bytes_in_chunk * 1000) / (limit_kb * 1024);
                                let sleep_ms = sleep_ms.min(2000);
                                tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                            }

                            if chunk_range_end >= file_end {
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

                // Flush any remaining pending meta ranges before unregister.
                if !pending_ranges.is_empty() {
                    let _lock = cache_mgr_clone.lock_meta(msg_id).await;
                    let mut meta = cache_mgr_clone.load_meta(msg_id);
                    if let Some(ref mut m) = meta {
                        m.cached_ranges.extend(pending_ranges);
                        merge_ranges(&mut m.cached_ranges);
                        if let Err(e) = cache_mgr_clone.save_meta(m) {
                            log::warn!("[CONTINUATION] Final meta flush failed for msg {}: {}", msg_id, e);
                        }
                    }
                    drop(_lock);
                }

                // Unregister from coordinator so it doesn't show stale entries.
                if registered.is_some() {
                    cache_mgr_clone.unregister_download(msg_id, cont_start_byte, file_end).await;
                }
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
    /// When true, only serve data that is already cached on disk.
    /// If the requested range is NOT cached, return 503 immediately —
    /// no subscription to active downloads, no targeted download spawn.
    /// Used by the TS keyframe scanner to avoid triggering scattered
    /// targeted downloads at far-ahead byte offsets.
    pub(crate) cached_only: Option<bool>,
}

/// Telegram download chunk size. Gammers-client enforces a hard cap of
/// 512 KB (MAX_CHUNK_SIZE in files.rs) and requires divisibility by 4 KB
/// (MIN_CHUNK_SIZE). We use the maximum allowed value to minimize round-trips.
const TELEGRAM_CHUNK_SIZE: i32 = 512 * 1024;

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
                    Ok(mut slice) => {
                        // Rewrite init_prefix in the response if this range covers the
                        // first bytes of a TS file. The init_prefix contains rewritten
                        // PAT+PMT packets (PMT PID 0x0FFF→0x1000, stream_type 0x15→0x0F)
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
                log::info!("[PREBUFFER] MISS: msg {} range {}-{} not cached",
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

                        // Rewrite PAT/PMT for TS files — same fix as SEQUENTIAL path
                        let chunk_start_byte = current_offset;
                        let mut yield_data = final_data;
                        if let Some(ref cache_mgr) = cache_mgr_opt {
                            let data_path = cache_mgr.data_path(message_id);
                            rewrite_ts_stream_in_buf(&mut yield_data, chunk_start_byte, cache_mgr, message_id, Some(&data_path));
                        }

                        yield Ok::<_, actix_web::Error>(web::Bytes::from(yield_data));

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
            cm.register_download(message_id, start_byte, end_byte, false, start_byte).await.is_some()
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
                request_end_byte: end_byte,
                total_file_size: size,
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

                    // Rewrite init_prefix and inline PAT/PMT if this chunk covers
                    // TS file data. The HIT path already applies rewriting when
                    // reading from cache, but the SEQUENTIAL (MISS) path downloads
                    // raw data from Telegram and writes it to cache WITHOUT rewriting.
                    // This means the raw data (with PMT PID 0x0FFF and stream_type 0x15)
                    // reaches the client. Mediabunny can't parse stream_type 0x15
                    // (AAC LATM), so the transmuxer fails to produce audio segments.
                    // The fix: rewrite the chunk data BEFORE yielding to the client.
                    // The cache file still stores raw data (for HIT path rewriting).
                    // Note: rewrite_ts_stream_in_buf is safe on already-rewritten data
                    // — it won't double-rewrite (patterns won't match on rewritten bytes).
                    let chunk_start_byte = current_offset - bytes_in_chunk;
                    let mut yield_data = final_data;
                    if let Some(ref cache_mgr) = cache_mgr_opt {
                        let data_path = cache_mgr.data_path(message_id);
                        rewrite_ts_stream_in_buf(&mut yield_data, chunk_start_byte, cache_mgr, message_id, Some(&data_path));
                    }

                    yield Ok::<_, actix_web::Error>(web::Bytes::from(yield_data));

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
            .expose_headers(["Content-Range", "Content-Length", "Accept-Ranges", "X-Cache", "X-Reason"])
            .allow_private_network_access()
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

#[cfg(test)]
mod continuation_tests {
    use super::continuation_should_run;

    // === continuation_should_run tests ===
    // These test the pure decision logic extracted from ContinuationGuard::drop.
    // The function decides whether a background continuation download should be
    // spawned after the HTTP response ends, based on how much data remains
    // in the file beyond what was already served.

    /// Pre-buffer scenario: 5MB served on a 1.3GB file.
    /// This is THE critical bug case — old logic used request end_byte (5242880)
    /// instead of total_file_size (1313957192), so remaining=0 after serving
    /// all 5MB, and no continuation was spawned. New logic correctly calculates
    /// remaining ≈ 1.3GB and spawns continuation from byte 5242881 to file end.
    #[test]
    fn continuation_prebuffer_5mb_on_large_file() {
        let total_file_size: u64 = 1_313_957_192; // 1.3GB .ts file
        let start_byte: u64 = 0;
        let bytes_sent: u64 = 5_242_881; // 5MB pre-buffer served completely

        let (should, remaining, offset, file_end) =
            continuation_should_run(total_file_size, start_byte, bytes_sent);

        assert!(should, "5MB pre-buffer on 1.3GB file MUST trigger continuation");
        assert_eq!(remaining, total_file_size - bytes_sent, "remaining = total - sent");
        assert_eq!(offset, bytes_sent, "continuation starts at sent boundary");
        assert_eq!(file_end, total_file_size - 1, "continuation downloads to file end");
    }

    /// Full file request completed: all bytes served, remaining=0, no continuation.
    #[test]
    fn continuation_full_file_completed() {
        let total_file_size: u64 = 10_000_000;
        let start_byte: u64 = 0;
        let bytes_sent: u64 = 10_000_000;

        let (should, remaining, _, _) =
            continuation_should_run(total_file_size, start_byte, bytes_sent);

        assert!(!should, "Full file served — no continuation needed");
        assert_eq!(remaining, 0);
    }

    /// Mid-stream disconnect: client disconnects at 3MB of 1.3GB file.
    /// Remaining ≈ 1.27GB > 2MB → continuation spawned from 3MB onwards.
    #[test]
    fn continuation_mid_stream_disconnect() {
        let total_file_size: u64 = 1_313_957_192;
        let start_byte: u64 = 0;
        let bytes_sent: u64 = 3_000_000;

        let (should, remaining, offset, file_end) =
            continuation_should_run(total_file_size, start_byte, bytes_sent);

        assert!(should, "Mid-stream disconnect must trigger continuation");
        assert_eq!(remaining, total_file_size - bytes_sent);
        assert_eq!(offset, bytes_sent);
        assert_eq!(file_end, total_file_size - 1);
    }

    /// Zero bytes sent: trivially short download, don't spawn continuation.
    #[test]
    fn continuation_zero_bytes_sent() {
        let (should, _, _, _) = continuation_should_run(1_000_000_000, 0, 0);
        assert!(!should, "Zero bytes sent — no continuation");
    }

    /// Small remaining (<2MB): not worth spawning a background task.
    #[test]
    fn continuation_small_remaining() {
        let total_file_size: u64 = 3_000_000; // 3MB file
        let start_byte: u64 = 0;
        let bytes_sent: u64 = 1_500_000; // 1.5MB sent, 1.5MB remaining

        let (should, remaining, _, _) =
            continuation_should_run(total_file_size, start_byte, bytes_sent);

        assert!(!should, "Remaining <2MB — no continuation");
        assert_eq!(remaining, 1_500_000);
    }

    /// Exactly 2MB remaining: boundary case — should continue (check is strict <).
    #[test]
    fn continuation_exactly_2mb_remaining() {
        let two_mb = 2 * 1024 * 1024;
        let total_file_size: u64 = two_mb + 5_000_000; // 7MB file
        let start_byte: u64 = 0;
        let bytes_sent: u64 = 5_000_000; // 5MB sent, exactly 2MB remaining

        let (should, remaining, _, _) =
            continuation_should_run(total_file_size, start_byte, bytes_sent);

        assert!(should, "Exactly 2MB remaining passes the >=2MB threshold, so continuation is spawned");
        assert_eq!(remaining, two_mb);
    }

    /// Just above 2MB remaining: should continue.
    #[test]
    fn continuation_just_above_2mb_remaining() {
        let two_mb = 2 * 1024 * 1024;
        let total_file_size: u64 = two_mb + 5_000_000 + 1;
        let start_byte: u64 = 0;
        let bytes_sent: u64 = 5_000_000;

        let (should, remaining, _, _) =
            continuation_should_run(total_file_size, start_byte, bytes_sent);

        assert!(should, "Remaining >2MB — should continue");
        assert_eq!(remaining, two_mb + 1);
    }

    /// total_file_size == 0: defensive bail out.
    #[test]
    fn continuation_zero_file_size() {
        let (should, remaining, _, _) = continuation_should_run(0, 0, 0);
        assert!(!should, "Zero file size — bail out");
        assert_eq!(remaining, 0);
    }

    /// start_byte >= total_file_size: range beyond file end, bail out.
    #[test]
    fn continuation_start_beyond_file() {
        let (should, _, _, _) = continuation_should_run(1_000_000, 1_500_000, 0);
        assert!(!should, "start_byte > total_file_size — bail out");
    }

    /// start_byte == total_file_size: exactly at end, bail out.
    #[test]
    fn continuation_start_at_file_end() {
        let (should, _, _, _) = continuation_should_run(1_000_000, 1_000_000, 0);
        assert!(!should, "start_byte == total_file_size — bail out");
    }

    /// Range request not starting at 0: pre-buffer was Range: bytes=1000000-6242880.
    /// After serving 5242881 bytes, continuation starts at 1000000+5242881=6242881
    /// and goes to file end.
    #[test]
    fn continuation_nonzero_start_byte() {
        let total_file_size: u64 = 1_313_957_192;
        let start_byte: u64 = 1_000_000;
        let bytes_sent: u64 = 5_242_881;

        let (should, remaining, offset, file_end) =
            continuation_should_run(total_file_size, start_byte, bytes_sent);

        assert!(should);
        assert_eq!(remaining, total_file_size - start_byte - bytes_sent);
        assert_eq!(offset, start_byte + bytes_sent);
        assert_eq!(file_end, total_file_size - 1);
    }

    /// Old bug regression test: request end_byte was used instead of total_file_size.
    /// Simulates the OLD behavior where remaining = (end_byte - start_byte + 1) - sent.
    /// For pre-buffer (0-5242880, 5242881 sent), old remaining = 0 → no continuation.
    /// New remaining = (total_file_size - start_byte) - sent ≈ 1.3GB → continuation.
    #[test]
    fn regression_old_remaining_vs_new_remaining() {
        let total_file_size: u64 = 1_313_957_192;
        let request_end_byte: u64 = 5_242_880;
        let start_byte: u64 = 0;
        let bytes_sent: u64 = request_end_byte + 1; // All 5MB served

        // OLD calculation (bug): remaining = (end_byte - start_byte + 1) - sent = 0
        let old_remaining = (request_end_byte - start_byte + 1) - bytes_sent;
        assert_eq!(old_remaining, 0, "OLD: remaining = 0 after serving all pre-buffer → no continuation (BUG)");

        // NEW calculation (fix): remaining = (total_file_size - start_byte) - sent ≈ 1.3GB
        let (_, new_remaining, _, _) = continuation_should_run(total_file_size, start_byte, bytes_sent);
        assert!(new_remaining > 2 * 1024 * 1024, "NEW: remaining >> 2MB → continuation spawned (FIXED)");
    }
}
