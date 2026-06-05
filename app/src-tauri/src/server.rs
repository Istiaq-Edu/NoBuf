use actix_web::{get, head, web, App, HttpServer, HttpRequest, HttpResponse, Responder};
use actix_cors::Cors;
use crate::commands::TelegramState;
use crate::commands::utils::resolve_peer;
use crate::download_pool::StreamChunk;
use crate::hls;
use crate::hls::manifest::extract_video_attrs_from_raw_msg;
use crate::ts_demux::{TsDemuxer, extract_stream_info, scan_keyframes_chunked, scan_keyframes_flush, KeyframeScanState, VideoCodec, PesFrame, TsStreamInfo};
use crate::fmp4::{build_init_segment, build_media_segment};
use grammers_client::types::Media;
use grammers_client::Client;
use grammers_tl_types as tl;
use tokio::sync::Semaphore;
use tokio::process::Command as TokioCommand;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;
use std::collections::HashMap;
use crate::stream_cache::{StreamCacheManager, CacheMeta, merge_ranges, is_range_cached, MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE};
use std::io::{Write, Seek, SeekFrom, Read};

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
                let timeout = tokio::time::Instant::now() + std::time::Duration::from_secs(3600);
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
    /// Expected duration in seconds (for remux endpoint).
    /// Passed to ffmpeg via -t so the fMP4 moov box contains the correct
    /// total duration — without this, the browser can't show the video length.
    pub(crate) duration: Option<f64>,
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
        // ── CACHE PREFIX: Serve already-cached bytes instantly from disk ──
        // mpegts.js always requests range X-EOF, so the full range is rarely cached.
        // But there's often a contiguous cached prefix from a previous lazyLoad cycle.
        // Yield those bytes immediately (no Telegram download needed) before
        // starting the Telegram download for the uncached remainder.
        // This makes the green buffer bar meaningful — cached data is actually reused.
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
                        // Partial cache hit: serve prefix from disk, then Telegram for remainder
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
                                log::info!("[PREBUFFER] CACHE-PREFIX: msg {} served {}-{} ({}B from disk cache), remainder {}-{} from Telegram",
                                    message_id, start_byte, prefix_end, prefix_len, prefix_end + 1, end_byte);
                                yield Ok::<_, actix_web::Error>(web::Bytes::from(buf));
                                effective_start_byte = prefix_end + 1;
                            }
                            Err(e) => {
                                log::warn!("[PREBUFFER] CACHE-PREFIX read failed for msg {}: {}, serving full range from Telegram", message_id, e);
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
        // If we served a cache prefix above, we must skip that many bytes
        // from the Telegram download to avoid sending duplicate data.
        let bytes_to_skip_from_dl = (effective_start_byte - start_byte) as usize;
        let mut bytes_skipped = 0usize;

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

                    // If we served a cache prefix above, skip those bytes from
                    // the Telegram download to avoid sending duplicate data to the client.
                    // The Telegram download starts from start_byte (the original request),
                    // but we've already sent bytes [start_byte, effective_start_byte) from disk.
                    if bytes_skipped < bytes_to_skip_from_dl {
                        let skip_remaining = bytes_to_skip_from_dl - bytes_skipped;
                        if chunk_data.len() <= skip_remaining {
                            // Entire chunk is in the already-sent prefix — skip it entirely
                            bytes_skipped += chunk_data.len();
                            current_offset += chunk_data.len() as u64;
                            continue;
                        } else {
                            // Partial skip — discard the prefix portion of this chunk
                            chunk_data = chunk_data[skip_remaining..].to_vec();
                            bytes_skipped += skip_remaining;
                            // Adjust current_offset: it tracks what we've sent to client,
                            // but the prefix bytes were already yielded from cache.
                            // current_offset should reflect the Telegram download position
                            // minus what we've already sent from cache.
                        }
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

/// Caches sorted (timestamp_s, byte_offset) keyframe entries per message_id
/// for time→byte_offset lookup. This is different from Fmp4KeyframeCache which
/// stores the serialized JSON response; this stores the parsed tuples for
/// efficient binary search when the backend receives a time-based segment request.
struct Fmp4ByteTimeCache {
    cache: HashMap<i32, Vec<(f64, u64)>>,
}

struct Fmp4ByteTimeCacheData(StdMutex<Fmp4ByteTimeCache>);

/// Caches a stateful TsDemuxer per message_id so that PES assembly continues
/// seamlessly across segment boundaries. Without this, each segment request
/// creates a fresh demuxer that drops partial PES packets at the boundary,
/// causing 0.5-2s gaps in the PTS timeline.
struct Fmp4DemuxerCache {
    /// (demuxer, last_end_byte_offset) — the offset where the demuxer
    /// stopped processing.  If the next request's byte_offset doesn't match,
    /// the cache entry is stale (seek happened) and we create a fresh demuxer.
    entries: HashMap<i32, (TsDemuxer, u64)>,
}
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

/// Strip 4-byte BDAV timestamp prefix from M2TS packets to produce standard 188-byte TS data.
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

/// FFmpeg-based TS→MP4 remux endpoint.
///
/// Spawns `ffmpeg -i INPUT -c copy -f mp4 -movflags frag_keyframe+empty_moov pipe:1`
/// and streams the output to the client. This replaces the broken custom Rust
/// TS demuxer + fMP4 builder pipeline (14 rounds of failed patches).
///
/// The browser's native `<video>` element plays the resulting MP4 perfectly —
/// same path as the working MP4 playback, no MSE/SourceBuffer needed.
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
        return serve_local_file(&req, &remux_path, file_size, "video/mp4");
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
        let host = req.headers().get("host")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("127.0.0.1:14201");
        let token = query.token.as_deref().unwrap_or("");
        input_source = format!("http://{}/stream/{}/{}?token={}", host, folder_id_str, message_id, token);
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
            "-ignore_unknown",
            "-probesize", "50000000",
            "-analyzeduration", "50000000",
            "-i", &input_source,
        ]);
        cmd.args(["-map", &format!("0:{}", video_stream_idx)]);
        cmd.args(["-map", &format!("0:{}", audio_stream_idx)]);
        cmd.args([
            "-c:v", "copy",
            "-c:a", "copy",
            "-bsf:a", "aac_adtstoasc",
            "-f", "mp4",
            "-movflags", "+faststart",
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
                serve_local_file(&req, &remux_path, file_size, "video/mp4")
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
        cmd.args([
            "-hide_banner",
            "-loglevel", "warning",
            "-ignore_unknown",
            "-probesize", "50000000",
            "-analyzeduration", "50000000",
            "-i", &input_source,
        ]);
        cmd.args(["-map", &format!("0:{}", video_stream_idx)]);
        cmd.args(["-map", &format!("0:{}", audio_stream_idx)]);
        cmd.args([
            "-c:v", "copy",
            "-c:a", "copy",
            "-bsf:a", "aac_adtstoasc",
            "-f", "mp4",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
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
                            "-probesize", "50000000", "-analyzeduration", "50000000",
                            "-i", &bg_input,
                        ]);
                        bg_cmd.args(["-map", &format!("0:{}", bg_vid_idx)]);
                        bg_cmd.args(["-map", &format!("0:{}", bg_aud_idx)]);
                        bg_cmd.args([
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

        // Build response — include duration header for frontend override
        let mut response = HttpResponse::Ok();
        response.insert_header(("Content-Type", "video/mp4"));
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
        Some(t) if t == &token_data.token => {},
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
    demuxer_cache: web::Data<Fmp4DemuxerCacheData>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    match &query.token {
        Some(t) if t == &token_data.token => {},
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
                    cache.cache.get(&message_id).cloned()
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
                            c.cache.insert(message_id, all_kfs.clone());
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
                    // Crude fallback: proportional estimate
                    let bitrate_bytes = (total_size as f64 * 8.0) / 3600.0 / 8.0;
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
        if let Some(dl) = dl_info {
            let current_progress = *dl.progress_rx.borrow();
            if current_progress >= read_start {
                let mut progress_rx = dl.progress_rx.clone();
                let timeout = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
                loop {
                    let progress = *progress_rx.borrow();
                    if is_range_cached(
                        &cache_mgr.load_meta(message_id).map(|m| m.cached_ranges).unwrap_or_default(),
                        read_start, read_end
                    ) {
                        break;
                    }
                    if progress >= read_end {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        break;
                    }
                    if tokio::time::Instant::now() >= timeout {
                        log::warn!("[FMP4-SEG] Timeout waiting for download for msg {}", message_id);
                        return HttpResponse::ServiceUnavailable()
                            .insert_header(("Retry-After", "2"))
                            .body("Waiting for download");
                    }
                    match progress_rx.changed().await {
                        Ok(()) => {},
                        Err(_) => break,
                    }
                }
            } else {
                log::info!("[FMP4-SEG] Active download progress {} < read_start {} for msg {}", current_progress, read_start, message_id);
                return HttpResponse::ServiceUnavailable()
                    .insert_header(("Retry-After", "3"))
                    .body("Download not yet at requested offset");
            }
        } else {
            let client_guard = { data.client.lock().await.clone() };
            if let Some(client) = client_guard {
                let (media, _) = match resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &StreamQuery { token: query.token.clone(), cached_only: Some(false), duration: None }).await {
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

                let _permit = data.download_semaphore.acquire().await.unwrap();
                let mut iter = download_iter;
                let mut offset = read_start;
                let mut first_chunk = true;
                let download_end = read_end;

                loop {
                    match iter.next().await.transpose() {
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
                            log::error!("[FMP4-SEG] Targeted download error for msg {}: {}", message_id, e);
                            break;
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
        Some(t) if t == &token_data.token => {},
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
    let (_ts_packet_size, is_m2ts) = match detect_ts_packet_size(&data_path) {
        Some(result) => result,
        None => {
            log::error!("[FMP4-META] Failed to detect TS packet size for msg {}", message_id);
            return HttpResponse::InternalServerError().body("Failed to detect TS packet size");
        }
    };

    // Read first 5MB of cached data (same pattern as fmp4_init)
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
                        log::error!("[FMP4-META] Failed to open data file for msg {}: {}", message_id, e);
                        return HttpResponse::NotFound().body("Data file not found");
                    }
                };
                let mut buf = vec![0u8; read_end];
                match file.read_exact(&mut buf) {
                    Ok(()) => buf,
                    Err(e) => {
                        log::warn!("[FMP4-META] Partial read for msg {} ({}): {}", message_id, read_end, e);
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

    // Strip M2TS prefix if needed
    if is_m2ts {
        ts_data = strip_m2ts_prefix(&ts_data, true);
    }

    let stream_info = match extract_stream_info(&ts_data) {
        Some(si) => si,
        None => {
            log::error!("[FMP4-META] Failed to extract stream info from first 5MB for msg {}", message_id);
            return HttpResponse::InternalServerError().body("Failed to extract stream info");
        }
    };

    let mut demuxer = TsDemuxer::new().with_stream_info(stream_info.clone());
    demuxer.feed(&ts_data);
    demuxer.flush();

    let mut video_config = demuxer.video_codec_config().cloned();
    let mut audio_config = demuxer.audio_codec_config().cloned();

    // If codec configs not found, scan further up to 25MB (same pattern as fmp4_init)
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

    let video = match video_config {
        Some(v) => v,
        None => {
            log::error!("[FMP4-META] Video codec config not found for msg {}", message_id);
            return HttpResponse::InternalServerError().body("Video codec config not found");
        }
    };
    let audio = match audio_config {
        Some(a) => a,
        None => {
            log::error!("[FMP4-META] Audio codec config not found for msg {}", message_id);
            return HttpResponse::InternalServerError().body("Audio codec config not found");
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
    let _lock = cache_mgr.lock_meta(message_id).await;
    let meta = cache_mgr.load_meta(message_id);
    drop(_lock);
    let total_size = meta.as_ref().map(|m| m.total_size).unwrap_or(0);

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
        let mut demux2 = TsDemuxer::new().with_stream_info(stream_info.clone());
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

                            let mut tail_demux = TsDemuxer::new().with_stream_info(stream_info.clone());
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
                                    let mut range_demux = TsDemuxer::new().with_stream_info(stream_info.clone());
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

    let response = Fmp4MetadataResponse {
        duration_s,
        video_codec: video_codec_str.to_string(),
        width: video.width,
        height: video.height,
        mime_type,
        video_codec_string,
        audio_codec_string,
        total_size,
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
        Some(t) if t == &token_data.token => {},
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
            log::error!("[FMP4-KF] Failed to detect TS packet size for msg {}", message_id);
            return HttpResponse::InternalServerError().body("Failed to detect TS packet size");
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

    // Determine which ranges we can scan
    let scan_ranges: Vec<(u64, u64)> = if fully_cached {
        vec![(0, total_size.saturating_sub(1))]
    } else {
        meta.cached_ranges.clone()
    };

    // Read the first portion to extract stream info
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

    // Now scan keyframes across all cached ranges, carrying PES state
    // across chunk boundaries so keyframes spanning chunks are detected.
    let mut all_keyframes: Vec<(f64, u64)> = Vec::new();
    let chunk_read_size = 2 * 1024 * 1024;
    let mut scan_state = KeyframeScanState::default();

    for (range_start, range_end) in &scan_ranges {
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

            // Use chunked scanning with state carried across calls
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

    // Store the sorted (timestamp_s, byte_offset) tuples in Fmp4ByteTimeCache
    // for efficient time→byte_offset lookup in fmp4_segment.
    if !all_keyframes.is_empty() {
        if let Ok(mut c) = byte_time_cache.0.lock() {
            c.cache.insert(message_id, all_keyframes.clone());
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
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .expose_headers(["Content-Range", "Content-Length", "Accept-Ranges", "X-Cache", "X-Reason", "X-Mime-Type", "X-Video-Codec", "X-Audio-Codec", "X-Segment-Start-Time", "X-Segment-Duration", "X-Segment-End-Time", "X-Next-Byte-Offset", "X-Total-File-Size", "X-Actual-Start-Time", "X-Partial", "X-Video-Duration", "X-Remuxed"])
            .allow_private_network_access()
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
