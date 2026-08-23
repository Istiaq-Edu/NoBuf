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
use crate::no_window::NoWindow;

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
const STREAMING_CORS_EXPOSED_HEADERS: [&str; 24] = [
    "Content-Range", "Content-Length", "Accept-Ranges", "X-Cache", "X-Reason",
    "X-Mime-Type", "X-Video-Codec", "X-Audio-Codec", "X-Segment-Start-Time",
    "X-Segment-Duration", "X-Segment-End-Time", "X-Next-Byte-Offset",
    "X-Total-File-Size", "X-Actual-Start-Time", "X-Partial", "X-Video-Duration",
    "X-Remuxed", "X-Subs-Format", "X-Subs-Partial", "X-Subs-Unchanged",
    "X-Subs-Coverage", "X-Subs-Frontier", "X-Subs-Island-Bytes", "X-Subs-Island-Filling",
];

pub fn streaming_worker_count(available_cores: usize) -> usize {
    available_cores
        .clamp(MIN_STREAMING_WORKERS, MAX_STREAMING_WORKERS)
}

fn canonical_folder_key(folder_id: &str) -> i64 {
    match folder_id {
        "me" | "home" | "null" => i64::MIN,
        s => s.parse::<i64>().unwrap_or(i64::MIN),
    }
}

fn canonical_stored_folder_key(folder_id: i64) -> i64 {
    if folder_id == 0 { i64::MIN } else { folder_id }
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
            // At app shutdown this Drop can run on the actix arbiter thread AFTER
            // the Tokio runtime is gone → tokio::spawn panics ("there is no reactor
            // running"). Only spawn when a runtime is actually present; on shutdown
            // the in-memory active_downloads map is torn down anyway, so skipping
            // the unregister is harmless.
            match tokio::runtime::Handle::try_current() {
                Ok(handle) => {
                    handle.spawn(async move {
                        cm_clone.unregister_download(msg_id, start, end).await;
                    });
                }
                Err(_) => {
                    log::debug!("[DownloadGuard] no Tokio runtime (shutdown) — skipping unregister for msg {}", msg_id);
                }
            }
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
    /// Round-3 subs fix: serve ONLY the already-cached prefix of the range, then
    /// END the body cleanly at the cache frontier — no poll-wait, no Telegram
    /// fallback, no coordinator subscribe/spawn. Unlike `cached_only` this never
    /// 503s a partially-cached range (that check is pre-body and whole-request —
    /// review R1). ffmpeg salvages every cue parsed before the close (exit 0,
    /// fixture-verified). Used exclusively by subtitles_extract_track for
    /// not-fully-cached files.
    pub(crate) cached_prefix: Option<bool>,
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
    /// Timestamp of the /remux?ss= ffmpeg input. Only that final input URL
    /// carries this marker; probe requests remain unmarked.
    pub(crate) remux_seek: Option<f64>,
    /// Maximum bytes to serve for this stream request. When set, clamps
    /// end_byte to min(end_byte, start_byte + max_bytes - 1). Used by the
    /// thumbnail pipeline to limit downloads to ~5MB instead of fetching
    /// to EOF (hundreds of MB) — only needs enough data to find one keyframe.
    pub(crate) max_bytes: Option<u64>,
    /// Seek start time in seconds (for remux endpoint). When set, ffmpeg
    /// uses `-ss` to start remuxing from this position instead of the
    /// beginning, enabling byte-range-like seeking through the remux pipe.
    pub(crate) ss: Option<f64>,
    /// Byte-forward seek offset for the remux endpoint (alternative to `ss`).
    /// When set, the backend prepends the cached init-prefix (PAT/PMT, 376B)
    /// and then streams /stream bytes from this TS-aligned offset forward into
    /// ffmpeg's stdin (pipe:0). No ffmpeg `-ss` is used — ffmpeg reads
    /// sequentially from its own byte 0, which works on uncached Telegram
    /// streams where `-ss` fails with `read_timestamp() failed in the middle`.
    /// Takes precedence over `ss` when both are present.
    pub(crate) start_byte: Option<u64>,
    /// Frontend capability hint for the /remux endpoint: does THIS WebView
    /// runtime's MSE/native pipeline accept 8-bit HEVC (hvc1)? Derived from
    /// `video.canPlayType('video/mp4;codecs=hvc1...')` on the client (which
    /// reflects whether the Windows "HEVC Video Extensions" is installed).
    /// - Some(true)  → 8-bit HEVC can be `-c:v copy`'d (player decodes it).
    /// - Some(false) / None → 8-bit HEVC must be transcoded to H.264.
    /// NOTE: 10-bit HEVC (Main 10) is ALWAYS transcoded regardless of this
    /// hint — the mpegts.js MSE path rejects hvc1.2 (Main10) even when the
    /// extension is present. This flag only governs the 8-bit HEVC case.
    pub(crate) hevc_ok: Option<bool>,
    /// User-selected audio stream index for the /remux endpoint (absolute
    /// ffprobe stream index, from /audio_tracks). Validated against the probed
    /// audio streams; invalid/absent values fall back to the probe-resolved
    /// primary (never a 500). Also keys the remux disk cache so outputs made
    /// with different tracks can never be served interchangeably.
    pub(crate) audio_idx: Option<i32>,
    /// Round-10b: the viewer's current byte position, sent by the FRONTEND to
    /// `/subtitles/...`. The extractor uses it to build a stitched header+island
    /// TEMP FILE and hands ffmpeg a local path — it is NOT forwarded to
    /// `/stream`. Serving a stitched body over HTTP violated the Range contract
    /// (a request for `bytes=N-` returned bytes from offset 0), which sent
    /// ffmpeg's matroska demuxer into a +660 B/step resync loop: 444 requests,
    /// 4.34 GiB re-read, zero cues. A real file has real offsets, so the temp
    /// file makes that failure structurally impossible.
    /// Absent → the legacy contiguous-prefix behaviour.
    pub(crate) playhead_byte: Option<u64>,
    /// Exact remux seek timestamp whose authoritative byte has already been
    /// folded into the frontend's VBR table. A stale timestamp cannot suppress
    /// correction for a newer seek.
    pub(crate) subs_seek_anchor: Option<f64>,
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

/// Audio filter that constrains the AAC encoder to standard channel
/// configurations. A source layout AAC can't express as a standard config
/// (notably "5.1(side)", common in AMZN WEB-DL) forces the encoder to emit a
/// PCE (Program Config Element). Chromium's MSE fMP4 parser rejects PCE-based
/// AAC with CHUNK_DEMUXER_ERROR_APPEND_FAILED, which tears down the /remux
/// output pipe and kills ffmpeg with exit -22 on the trailer write.
/// `aformat` remaps non-standard layouts to the matching standard one WITHOUT
/// downmixing (5.1(side) → 5.1, still 6ch) and is a no-op for layouts already
/// in the list. Verified via ffprobe: emits no PCE, preserves channel count.
/// Chained BEFORE asetpts (ffmpeg allows only one -af per stream).
const AAC_LAYOUT_FILTER: &str = "aformat=channel_layouts=mono|stereo|3.0|4.0|5.0|5.1|7.1";

/// Round-10 P1-1: byte offset of the first MKV `Cluster` element (EBML ID
/// `1F 43 B6 75`) within `head`, i.e. the end of the header region that carries
/// EBML/Info/**Tracks**/CodecPrivate. Returns None when no cluster ID appears in
/// the searched window (non-MKV container, or a header longer than the window).
///
/// Used to build the stitched subtitle-extraction input: everything before the
/// first cluster is the header ffmpeg needs to interpret ANY later cluster, and
/// MKV cluster timestamps are absolute, so a mid-file island still self-locates.
pub(crate) fn find_first_mkv_cluster(head: &[u8]) -> Option<usize> {
    const CLUSTER_ID: [u8; 4] = [0x1F, 0x43, 0xB6, 0x75];
    head.windows(4).position(|w| w == CLUSTER_ID)
}

/// Count MKV `Cluster` element markers (EBML ID `1F 43 B6 75`) in `window`.
///
/// Used as the admission test for a subtitle-extraction island: **two** cluster
/// markers prove at least one FULLY-BOUNDED cluster lies between them, which is
/// exactly the condition under which ffmpeg emits cues (a lone partial cluster
/// is discarded on resync — see `SUBS_ISLAND_MIN_BYTES`). This is the direct
/// measurement the fixed byte floor only approximated.
pub(crate) fn count_mkv_clusters(window: &[u8]) -> usize {
    const CLUSTER_ID: [u8; 4] = [0x1F, 0x43, 0xB6, 0x75];
    window.windows(4).filter(|w| *w == CLUSTER_ID).count()
}

/// Round-10 P1-1: choose the cached range to stitch after the header for a
/// subtitle extraction targeting `playhead_byte`.
///
/// Picks the cached range CONTAINING the playhead; if none contains it, the
/// nearest range that starts at or after it (a forward island still yields the
/// cues just ahead of the viewer, which is what a just-completed seek produces).
/// Ranges at or before the header end are skipped — they are already covered by
/// the header prefix and stitching them would duplicate bytes.
///
/// Returns None when nothing usable is cached, in which case the caller must
/// fall back to the plain contiguous-prefix behaviour rather than serve a
/// header-only body (which would yield zero cues and look like "no subtitles").
/// Round-17: how far from the playhead a cached range may sit and still be a
/// sane subtitle-extraction input, in EITHER direction.
///
/// Derived, not chosen for roundness. The MKV transmuxer path keeps
/// `MAX_BUFFER_AHEAD_SECONDS = 30` (useMSEPlayer.ts:1735) of buffer, and the
/// sliding window keeps `SLIDING_WINDOW_BACKWARD_SECONDS = 30` behind. At the
/// logged file's measured rate (1,566,651,347 B / 8888.136 s = 176,263 B/s):
///
/// ```text
///   30 s x 176,263 B/s = 5,287,890 B = 5.04 MiB  ->  8 MiB (next power of two)
///   8 MiB back at that rate = 47.6 s of runtime
/// ```
///
/// It must also exceed SUBS_ISLAND_MIN_BYTES (2 MiB), or every admitted island
/// would be rejected by the size floor immediately after.
///
/// **Why BOTH directions, not just forward.** Capping only the forward rule
/// looks sufficient — it stops the EOF-tail pick — but it makes things worse.
/// The prefix-coverage gate at the call site is guarded by `island.is_none()`,
/// so ANY `Some(..)` skips it. With only a forward cap the search falls through
/// to the backward rule, which returns the 32 MiB prefix (565 MB BEHIND the
/// playhead) as `Some(..)`, bypasses the gate, and serves opening-credits cues
/// to a viewer 56 minutes in — exactly the defect round-16 added that gate to
/// prevent. Bounding both directions is what lets the picker return `None` and
/// hand the decision to the gate.
pub(crate) const SUBS_ISLAND_MAX_DISTANCE_BYTES: u64 = 8 * 1024 * 1024;

/// Round-26: hard ceiling on the byte span handed to ffmpeg as an extraction
/// input, applied to EVERY arm of `pick_subs_island`.
///
/// **Why this has to exist before the prebuffer sweep changes.** Arm 1 returns a
/// range that straddles the playhead with no length test at all — the distance
/// constant above bounds only how FAR an island may sit, never how BIG it may
/// be, and `SUBS_ISLAND_MIN_BYTES` is a floor. `build_subs_island_file` then
/// allocates `vec![0u8; isl_len]`, reads the whole span, and copies it into a
/// temp `.mkv` on every extraction. The only thing keeping that cheap today is
/// cache FRAGMENTATION: the straddling range is a small sliver because nobody
/// fills the hole around the playhead.
///
/// Round-26 makes the sweep resume at the first uncached byte, which fills that
/// hole by design and coalesces the playhead range with everything swept toward
/// EOF. Without a ceiling the straddling island therefore grows with sweep
/// progress — measured projection on the logged 1.46 GB file: 4 MiB sliver today
/// -> 26 MiB once the hand-off band fills -> ~400 MiB after ten minutes of sweep
/// -> 1,494 MiB at full coverage. `subs_memo_key` hashes `(start, end)`, so each
/// extension also invalidates the memo and re-runs a full-island ffmpeg pass per
/// poll. That is the "16 min -> seconds" regression (commit 7b1946a) returning
/// through a new door.
///
/// 24 MiB = 8 MiB (SUBS_ISLAND_MAX_DISTANCE_BYTES, the furthest an island may
/// legitimately start from the playhead) + 16 MiB of body. Round-14(B2): raised
/// from 12→24 MiB so a straddling island carries ~100 s of runtime instead of
/// ~50 s (at the logged 176 KB/s: 24 MiB ≈ 143 s of bytes, ~100 s of dialogue
/// after cluster overhead), roughly halving the "subs run out mid-playback"
/// gap. Still bounded well below the round-26 regression projection (the
/// unbounded straddle grew to 400+ MiB); the per-poll `vec![0u8; isl_len]`
/// allocation is at most 24 MB, and `subs_memo_key` still memoizes each
/// `(start,end)` so a stable playhead does not re-run ffmpeg. It must stay
/// comfortably above SUBS_ISLAND_MIN_BYTES or every clamped island would be
/// rejected by the floor immediately afterwards; the ratio is asserted in tests
/// rather than left to inspection.
pub(crate) const SUBS_ISLAND_MAX_BYTES: u64 = 24 * 1024 * 1024;

/// Round-26: clamp an admitted island to `SUBS_ISLAND_MAX_BYTES`, keeping the
/// playhead inside the returned window.
///
/// Pure so the bound is unit-testable without a filesystem. Rules:
///
/// * A span already within the cap is returned unchanged — no behaviour change
///   for the fragmented shapes that exist today.
/// * When the playhead lies inside the span, the window is backward-biased:
///   three quarters preroll and one quarter look-ahead. A subtitle visible at a
///   seek target commonly started before that target, so a forward-only window
///   loses the exact cue the viewer expects to see.
/// * The biased window is clamped at either source edge and never escapes the
///   cached range.
/// * When the playhead is outside the span (arms 2 and 3), the window is taken
///   from the edge nearest the playhead.
fn clamp_subs_island(start: u64, end: u64, playhead: u64, max_bytes: u64) -> (u64, u64) {
    debug_assert!(end >= start, "clamp_subs_island called with an inverted span");
    if end.saturating_sub(start).saturating_add(1) <= max_bytes {
        return (start, end);
    }
    let span = max_bytes.saturating_sub(1);
    if playhead >= start && playhead <= end {
        // Subtitle preroll is asymmetric: the cue visible at the seek target may
        // have started earlier. Keep 3/4 of the bounded window behind the
        // playhead and 1/4 ahead, clamped to the cached source span.
        let backward = span.saturating_mul(3) / 4;
        let anchor = playhead.saturating_sub(backward).max(start)
            .min(end.saturating_sub(span));
        (anchor, anchor.saturating_add(span).min(end))
    } else if playhead < start {
        // Forward island: nearest edge is its start.
        (start, start.saturating_add(span).min(end))
    } else {
        // Backward island: nearest edge is its end.
        (end.saturating_sub(span).max(start), end)
    }
}

pub(crate) fn pick_subs_island(
    cached_ranges: &[(u64, u64)],
    playhead_byte: u64,
    header_end: u64,
) -> Option<(u64, u64)> {
    let usable = |&(s, e): &(u64, u64)| e > header_end && e > s;
    // Round-26: every arm returns a span clamped to SUBS_ISLAND_MAX_BYTES. The
    // distance constant bounds how FAR an island may sit; this bounds how BIG the
    // ffmpeg input may get, which cache coalescing would otherwise grow without
    // limit. See `clamp_subs_island` for the projection that forced it.
    let clamp = |s: u64, e: u64| {
        let (cs, ce) = clamp_subs_island(s.max(header_end), e, playhead_byte, SUBS_ISLAND_MAX_BYTES);
        Some((cs, ce))
    };
    // 1. A range that straddles the playhead is ideal. No distance test applies:
    //    the viewer is literally inside it.
    if let Some(&(s, e)) = cached_ranges.iter().filter(|r| usable(r)).find(|&&(s, e)| s <= playhead_byte && playhead_byte <= e) {
        return clamp(s, e);
    }
    // 2. Otherwise the nearest range starting after the playhead — but only if
    //    playback could plausibly reach it soon. The logged bug picked a 78 KB
    //    EOF tail 967 MB (91.5 min of runtime) ahead, which the player's
    //    tail-probe reads leave cached on EVERY file.
    let fwd_limit = playhead_byte.saturating_add(SUBS_ISLAND_MAX_DISTANCE_BYTES);
    if let Some(&(s, e)) = cached_ranges.iter().filter(|r| usable(r))
        .filter(|&&(s, _)| s > playhead_byte && s <= fwd_limit)
        .min_by_key(|&&(s, _)| s)
    {
        return clamp(s, e);
    }
    // 3. Last resort: the LAST usable range before the playhead, bounded the same
    //    way. Unbounded, this arm returns the 0-prefix for a late-film playhead —
    //    confidently the wrong region.
    let back_limit = playhead_byte.saturating_sub(SUBS_ISLAND_MAX_DISTANCE_BYTES);
    cached_ranges
        .iter()
        .filter(|r| usable(r))
        .filter(|&&(_, e)| e < playhead_byte && e >= back_limit)
        .max_by_key(|&&(s, _)| s)
        .and_then(|&(s, e)| clamp(s, e))
}

/// Round-14 F5: snap an island start DOWN to the first MKV Cluster boundary at
/// or after `raw_start`, searching at most `ALIGN_SCAN` bytes and never past
/// `isl_end`.
///
/// **This is load-bearing — do not delete it.** Round-10b shipped a comment
/// claiming alignment was "free tidiness" that yielded "identical cue sets".
/// Round-14 measured that claim and falsified it: cutting an island mid-cluster
/// costs cues, because ffmpeg discards the partial leading cluster rather than
/// resyncing into it.
///
/// ```text
/// fixture 300s / 1s GOP / 300 cues / 300 clusters, same island start
///   aligned   (snapped to cluster) -> 148 cues
///   unaligned (mid-cluster)        -> 147 cues   (-0.7%)
/// ```
///
/// An independent fixture measured ~5%. The magnitude is content- and
/// GOP-dependent; the DIRECTION is not.
///
/// Returns `raw_start` unchanged when no Cluster ID is found in the window —
/// the snap must DEGRADE to the caller's start, never invent an offset, and
/// never push the start below `raw_start` (that would re-include bytes the
/// caller deliberately excluded).
pub(crate) fn snap_island_start_to_cluster(window: &[u8], raw_start: u64) -> u64 {
    match find_first_mkv_cluster(window) {
        Some(off) => raw_start.saturating_add(off as u64),
        None => raw_start,
    }
}

/// Round-16: should a `/stream` read bootstrap from Telegram instead of waiting
/// on the disk cache?
///
/// A player needs a few contiguous MB before it can parse PAT/PMT/IDR, so when
/// only a tiny prefix is cached it must bootstrap or it times out waiting.
///
/// A `cached_prefix` reader is NOT a player. It is the subtitle extractor: it
/// serves whatever prefix exists, ends at the frontier (`STREAM-PREFIX-END`),
/// and never falls back to Telegram. Bootstrapping it queues it behind a
/// whole-file download it will never consume — and because the extractor asks
/// for `0-<eof>`, that is a 1.5 GB queue on a cold cache.
///
/// Measured (16-t): the FIRST open of a cold file issued
/// `range 0-1566651346 source_id=subs`, hit the 512 KB `< 5MB bootstrap
/// threshold` arm, and the request was still unanswered 35 s later — long past
/// the `[MSE] Init timeout check` at 20 s. The SECOND open of the same file
/// issued the SAME whole-file range against a 7 MB cache and returned
/// immediately via `STREAM-PREFIX-END`. Same range, same code, opposite outcome:
/// the bootstrap arm was the whole difference.
///
/// Pure + exported for testing.
pub(crate) fn should_bootstrap_from_telegram(
    cached_end: u64,
    start_byte: u64,
    cached_prefix_mode: bool,
    min_bootstrap_bytes: u64,
) -> bool {
    if cached_end < start_byte {
        return true; // nothing cached at or after start_byte
    }
    if cached_prefix_mode {
        return false; // prefix readers end at the frontier; they never starve
    }
    (cached_end - start_byte + 1) < min_bootstrap_bytes
}

pub(crate) fn should_skip_cache_poll(cached_prefix: bool, cache_missing_or_cold: bool) -> bool {
    !cached_prefix && cache_missing_or_cold
}

const REMUX_SEEK_MIN_RANGE_BYTES: u64 = 1024 * 1024;

pub(crate) fn is_authoritative_remux_seek_range(estimated_byte: u64, range_start: u64, range_len: u64, file_size: u64) -> bool {
    // ffmpeg opens a marked timestamp-seek input with a header/full-file request
    // at byte zero before issuing the demuxer-resolved seek Range. That bootstrap
    // request is never evidence for the seek anchor, even for an early seek.
    // The marked MKV input's first non-zero request starts inside the container
    // header. The island builder already uses 1 MiB as a conservative MKV-header
    // scan bound; such a range is bootstrap traffic, never the resolved seek.
    if file_size == 0 || range_start < REMUX_SEEK_MIN_RANGE_BYTES || range_len < REMUX_SEEK_MIN_RANGE_BYTES { return false; }
    let tolerance = (file_size / 10).max(64 * 1024 * 1024);
    range_start.abs_diff(estimated_byte) <= tolerance
}

pub(crate) fn marked_remux_input_source(source: &str, ss_secs: f64, byte_seek: bool) -> String {
    if byte_seek || !source.starts_with("http") || !ss_secs.is_finite() || ss_secs <= 0.0 { return source.to_owned(); }
    format!("{}&remux_seek={}", source, ss_secs)
}

pub(crate) fn apply_remux_seek_correction(requested: u64, estimated_anchor: u64, actual_anchor: u64, file_size: u64) -> u64 {
    let corrected = if actual_anchor >= estimated_anchor {
        requested.saturating_add(actual_anchor - estimated_anchor)
    } else {
        requested.saturating_sub(estimated_anchor - actual_anchor)
    };
    corrected.min(file_size.saturating_sub(1))
}

pub(crate) fn corrected_playback_report_byte(
    estimated_byte: u64,
    has_explicit_byte_offset: bool,
    current_time_s: f64,
    anchor: Option<(f64, u64, u64)>,
    file_size: u64,
) -> u64 {
    // Explicit offsets already come from the frontend's VBR-aware timeToByte
    // table. Applying the stored estimate->actual delta again double-corrects
    // every periodic MKV report after the authoritative anchor is learned.
    if has_explicit_byte_offset { return estimated_byte; }
    match anchor {
        Some((seek_s, estimated_anchor, actual_anchor))
            if (current_time_s - seek_s).abs() <= 120.0 =>
            apply_remux_seek_correction(estimated_byte, estimated_anchor, actual_anchor, file_size),
        _ => estimated_byte,
    }
}

pub(crate) fn authoritative_subs_playhead_byte(requested: Option<u64>, anchor: Option<(u64, u64)>, file_size: u64) -> Option<u64> {
    match (requested, anchor) {
        (Some(requested), Some((estimated, actual))) if is_authoritative_remux_seek_range(requested, actual, REMUX_SEEK_MIN_RANGE_BYTES, file_size) => {
            // timeToByte learns the actual ffmpeg anchor after the first poll.
            // Do not add the same correction twice once the frontend request is
            // already closer to the actual anchor than to the old estimate.
            if requested.abs_diff(actual) <= requested.abs_diff(estimated) {
                Some(requested)
            } else {
                Some(apply_remux_seek_correction(requested, estimated, actual, file_size))
            }
        }
        (requested, _) => requested,
    }
}

pub(crate) fn resolve_authoritative_subs_playhead_byte(
    requested: Option<u64>,
    anchor: Option<(f64, u64, u64)>,
    calibrated_seek_s: Option<f64>,
    file_size: u64,
) -> Option<u64> {
    let Some((seek_s, estimated, actual)) = anchor else { return requested; };
    let already_calibrated = calibrated_seek_s
        .filter(|value| value.is_finite())
        .is_some_and(|value| (value - seek_s).abs() <= 0.001);
    if already_calibrated {
        requested
    } else {
        authoritative_subs_playhead_byte(requested, Some((estimated, actual)), file_size)
    }
}

fn subs_island_progress_bytes(
    cache: &Option<StreamCacheManager>,
    message_id: i32,
    playhead_byte: Option<u64>,
) -> Option<u64> {
    let meta = cache.as_ref()?.load_meta(message_id)?;
    let playhead = playhead_byte?;
    let (start, end) = pick_subs_island(&meta.cached_ranges, playhead, 0)?;
    Some(end.saturating_sub(start).saturating_add(1))
}

/// Round-16: when island mode declines, is the cached PREFIX an acceptable
/// substitute input for subtitle extraction?
///
/// It is acceptable only when the viewer is actually inside it. The prefix is
/// the opening of the film; feeding it to the extractor while the viewer is an
/// hour in returns the opening credits' cues, which is not "partial coverage",
/// it is the wrong region entirely.
///
/// Measured (16-t:388-401, msg 108 @ 250,114 B/s):
///   viewer   byte 503,761,549 = 2014 s (33.6 min)
///   island   1.43 MB — under the 2 MB floor, so declined (correct: a
///            sub-cluster island yields zero cues)
///   prefix   0-16,777,216     = the first 67 s
///   → extractor handed the first 67 s while the viewer was 2014 s in,
///     off by 32.5 minutes, and it duly returned 957 B of opening-credit ASS.
///
/// The floor is right. The FALLBACK is what was wrong: "no usable island" was
/// being read as "the opening will do".
///
/// `grace_bytes` covers the viewer sitting just past the frontier — cues run a
/// little ahead of the playhead, so an exact comparison would reject a prefix
/// that genuinely still covers them.
///
/// Pure + exported for testing.
pub(crate) fn prefix_covers_playhead(
    playhead_byte: Option<u64>,
    prefix_end: u64,
    grace_bytes: u64,
) -> bool {
    match playhead_byte {
        // No playhead reported (e.g. extraction at open, before playback starts):
        // the prefix IS where the viewer is about to be, so it is correct.
        None => true,
        Some(pb) => pb <= prefix_end.saturating_add(grace_bytes),
    }
}

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

    let cache_folder_id = canonical_folder_key(&folder_id_str);
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

    // SEEK DIAGNOSTIC (temporary): log every incoming /stream Range so we can see
    // exactly which bytes the remux ffmpeg input requests after a seek. If a seek
    // to T only ever produces front-of-file ranges (and never the target cluster
    // byte), that confirms ffmpeg is linear-reading instead of Cue-jumping. Remove
    // with the [REMUX-SEEK-DIAG] block once the front-read root cause is confirmed.
    log::info!("[STREAM-REQ] msg {} incoming range {}-{} ({:.1}MB start, len {}B, partial={}, source_id={})",
        message_id, start_byte, end_byte, start_byte as f64 / 1_048_576.0, content_length, is_partial,
        query.source_id.as_deref().unwrap_or("-"));

    // Only the final ffmpeg input of /remux?ss= carries remux_seek. Accept a
    // substantial Range near the frontend estimate, rejecting ffprobe tail and
    // header reads. This is the container demuxer's actual seek byte.
    if let Some(seek_s) = query.remux_seek.filter(|v| v.is_finite() && *v > 0.0) {
        let estimate = data.proactive_targets.read().await.get(&message_id).map(|v| v.0);
        if let Some(estimate) = estimate.filter(|estimate| is_authoritative_remux_seek_range(*estimate, start_byte, content_length, size)) {
            data.remux_seek_anchors.write().await.insert(message_id, (seek_s, estimate, start_byte));
            if let Some(target) = data.proactive_targets.write().await.get_mut(&message_id) { target.0 = start_byte; }
            if let Some(ref cache_mgr) = **cache { cache_mgr.set_playhead_byte(message_id, start_byte); }
            log::info!("[REMUX-SEEK-AUTH] msg {} ss={:.3}s estimate={} -> authoritative source byte={}", message_id, seek_s, estimate, start_byte);
        }
    }

    // Round-14 F1: a bisect probe means the user is staring at a spinner. Stamp
    // the clock so PROACTIVE declines to spawn an 893 MB prefetch into the same
    // 300ms-spaced limiter (14-t:184-187: the prefetch spawned in the SAME
    // SECOND as probe 1, and probes then landed 3-4s apart against a 1.2s
    // uncontended floor). Each probe re-arms it, so the hold tracks the bisect's
    // real duration and expires on its own once probing stops — never sticky
    // (round-9 I-2b: a sticky flag starved PROACTIVE to 0 bytes in 70s).
    if crate::commands::streaming::is_seek_critical_source(query.source_id.as_deref()) {
        data.seek_critical_read_at.store(
            crate::commands::streaming::now_epoch_ms(),
            std::sync::atomic::Ordering::Relaxed,
        );
    }

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

    // === cached_prefix (round-3 subs fix): bounded prefix read ===
    // Serve whatever contiguous prefix of the range is on disk, then END the
    // body at the cache frontier. Never subscribe to or spawn a Telegram
    // download (the whole point: a subs extraction must not compete for
    // bandwidth or run for minutes). The stream body's CACHE-PREFIX + poll
    // loop handle the serving; the gates inside the body (see
    // cached_prefix_mode) handle the ending. NOTE deliberately NOT the
    // cached_only 503 above: that check is whole-request (fires for any
    // not-fully-cached range — review R1) and would kill ffmpeg's 0-EOF
    // request instantly.
    let cached_prefix_mode = query.cached_prefix.unwrap_or(false);

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
        // cached_prefix (round-3): never subscribe — a subscriber stream rides an
        // ACTIVE Telegram download and delivers at Telegram speed (unbounded time).
        // Prefix reads must serve disk bytes and end. Fall through to the poll path.
        let dl_info = if cached_prefix_mode {
            None
        } else {
            cache_mgr.find_best_covering_download(message_id, start_byte, end_byte).await
        };
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
    // cached_prefix (round-3): moved into the stream body; gates the frontier
    // poll-wait and the Telegram fallback so the body ENDS at the cache frontier.
    let cached_prefix_stream = cached_prefix_mode;

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
        let cache_missing_or_cold = cache_mgr_for_stream.is_none() || {
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
                    let bootstrap = should_bootstrap_from_telegram(
                        cached_end, start_byte, cached_prefix_mode, MIN_BOOTSTRAP_CACHED_BYTES,
                    );
                    if bootstrap && cached_end >= start_byte {
                        log::info!("[STREAM-CACHE-POLL] msg {}: cached run {}-{} = {} bytes (< {}MB bootstrap threshold) — using Telegram bootstrap",
                            message_id, start_byte, cached_end, cached_end - start_byte + 1,
                            MIN_BOOTSTRAP_CACHED_BYTES / (1024 * 1024));
                    }
                    bootstrap
                }
            } else {
                true
            }
        };
        let skip_poll = should_skip_cache_poll(cached_prefix_stream, cache_missing_or_cold);

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
            // cached_prefix (round-3): NO waiting — the prefix is exhausted, end
            // the body cleanly at the frontier. ffmpeg finalizes the cues parsed
            // so far (exit 0; CUT shape, fixture-verified).
            if cached_prefix_stream {
                // Round-16: no log here. Breaking out of the poll loop falls
                // straight into the `cached_prefix_stream && bytes_sent <
                // content_length` guard below, which announces the same fact with
                // more detail — so logging here produced an exact duplicate on
                // every prefix read (16-t:391/392, :545/546, :551/552, :557/558).
                break;
            }
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
                log::warn!("[STREAM-CACHE-WAIT] msg {}: {}ms timeout waiting for cache at offset {}, falling back to Telegram",
                    message_id, FALLBACK_TIMEOUT_MS, read_offset);
                break; // Exit poll loop, enter Telegram fallback below
            }
        }

        // ── TELEGRAM FALLBACK ──
        // If the poll loop timed out (30s without cache data) OR there's no
        // cache manager at all, download remaining data directly from Telegram.
        // This is a safety net for when the proactive prebuffer fails or
        // isn't running — prevents the player from hanging forever.
        // cached_prefix (round-3): NEVER fall back to Telegram — this arm is the
        // normal exit when the cached run at start_byte was too small for the
        // poll loop (skip_poll bootstrap heuristic) or absent entirely (e.g.
        // ffmpeg's EOF SeekHead probe on an uncached tail): end the body short.
        if cached_prefix_stream && bytes_sent < content_length {
            log::info!("[STREAM-PREFIX-END] msg {} ended at cache frontier offset {} ({}B of {} sent — cached_prefix mode, no fallback)",
                message_id, read_offset, bytes_sent, content_length);
        } else if bytes_sent < content_length {
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
                    // Trace-21 diagnostic: promoted debug→info. If this fires with
                    // bytes_sent==0 it is the "orphaned read returns empty 206"
                    // branch — a sibling seek's register_download cancelled THIS
                    // read before it yielded a single byte. Confirms whether the
                    // backend single-flight fix (FIX 2) is needed.
                    log::info!("[STREAM-FALLBACK] msg {} cancelled at offset {} (bytes_sent={} of {}) — {}",
                        message_id, current_offset, bytes_sent, content_length,
                        if bytes_sent == 0 { "EMPTY-BODY orphaned read" } else { "partial, superseded" });
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

                        // 0) Record Telegram network bytes for the speed meter
                        if let Some(ref cache_mgr) = cache_mgr_for_stream {
                            cache_mgr.add_downloaded_bytes(message_id, bytes_in_chunk);
                        }

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
                                let complete_now = meta.is_complete();
                                drop(_lock);
                                if complete_now {
                                    if let Some(ref mut file) = cache_file_mut { let _ = file.flush(); }
                                    crate::server::maybe_spawn_complete_subtitle_promotion(cache_mgr.clone(), message_id);
                                }
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
                        let complete_now = meta.is_complete();
                        drop(_lock);
                        if complete_now {
                            if let Some(ref mut file) = cache_file_mut { let _ = file.flush(); }
                            crate::server::maybe_spawn_complete_subtitle_promotion(cache_mgr.clone(), message_id);
                        }
                    }
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
    /// True when duration_s is a bitrate/PTS ESTIMATE, not the exact /remux ffprobe
    /// value. The frontend uses this to retry the fetch until the probe lands (the
    /// probe finishes ~2s after the first metadata fetch), avoiding a permanently
    /// wrong seek-bar length for HEVC MKV. Omitted (false) once probed.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    duration_is_estimate: bool,
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
                        match data.download_semaphore.acquire().await {
                            Ok(p) => p,
                            Err(_) => {
                                log::error!("[DAC] msg {}: download semaphore closed during keyframe search", message_id);
                                return Err("Download semaphore closed".to_string());
                            }
                        }
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
                // Record Telegram network bytes for the speed meter (per-chunk,
                // so the meter ticks during long keyframe-window downloads).
                cache_mgr.add_downloaded_bytes(message_id, slice.len() as u64);
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
        folder_id: i64::MIN,
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

/// Compute the [start, end] byte window to download+scan for a keyframe, given
/// the linear-estimate `approx_byte`, the current `window_size`, the file
/// `total_size`, and the TS packet `alignment` (188 or 192 for m2ts).
///
/// BACKWARD-BIASED: 75% of the window is placed before `approx_byte` and 25%
/// after. For VBR video the real keyframe is almost always earlier than the
/// linear estimate, so this reaches it in fewer expansions than a symmetric
/// split. `start` is rounded DOWN to a packet boundary; `end` is clamped to the
/// last byte of the file. Pure + deterministic so it can be unit-tested.
fn keyframe_search_window(
    approx_byte: u64,
    window_size: u64,
    total_size: u64,
    alignment: u64,
) -> (u64, u64) {
    let alignment = alignment.max(1);
    let back = window_size / 4 * 3; // 75% backward
    let forward = window_size / 4; // 25% forward
    let start = (approx_byte.saturating_sub(back) / alignment) * alignment;
    let end = if total_size == 0 {
        0
    } else {
        approx_byte.saturating_add(forward).min(total_size - 1)
    };
    (start, end)
}

/// Deadline-first budget decision for the keyframe-search loop. Given how much
/// time has `elapsed` since the search began and the total `deadline`, return
/// `Some(remaining)` if there's enough budget left to plausibly start another
/// window download, or `None` to stop and fall back to the linear byte estimate.
///
/// `min_slice` is the smallest remaining budget worth starting a download with
/// (a download needing at least one rate-limited round trip). Pure so the
/// deadline logic is unit-tested without a live Telegram stream.
fn keyframe_search_remaining_budget(
    elapsed: std::time::Duration,
    deadline: std::time::Duration,
    min_slice: std::time::Duration,
) -> Option<std::time::Duration> {
    match deadline.checked_sub(elapsed) {
        Some(r) if r >= min_slice => Some(r),
        _ => None,
    }
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

    // 1b. GROUND-TRUTH FAST PATH for the UNCACHED region (no disk data near target).
    //     A prior playback/seek scan may have left a real (ts,byte) keyframe sample
    //     in byte_time_cache. If one sits within ONE GOP (~4MB) of the target byte
    //     AND within 30s of the target time, it's exact + instant — return it
    //     without any download. This is a pure WIN (no downside): when present it
    //     saves the whole scan; when absent we fall through to the full scan below.
    //
    //     NOTE: an earlier "fast-fail" here (return None when no covering download
    //     was near) was REVERTED. It looked free — "the 8s scan times out and
    //     returns the linear byte anyway" — but logs 14-c/14-t proved it REGRESSED
    //     thumbnail GENERATION: the scan's expanding backward-window DOWNLOADS were
    //     load-bearing. They warm ~6-12MB of bytes BEFORE the target, which is
    //     exactly what /fmp4/segment's demuxer needs to reach the GOP keyframe on a
    //     cold VBR region. Skipping the scan left the segment with a narrow ~4.5MB
    //     cold window that missed the keyframe for high-skew timestamps (316s, 1805s
    //     in log 14) → P-frames only → undecodable → empty SourceBuffer → no
    //     thumbnail. So we KEEP the full scan for the uncached case; only the
    //     genuinely-free cache hit short-circuits it.
    if !region_covered {
        // 1b-i. PROGRESSIVE INDEX (the real win): the background/proactive download
        //       loops scan every chunk they sweep to disk and record keyframes in
        //       TelegramState.proactive_keyframe_index. If the playhead has already
        //       swept past this region, the exact keyframe is in the index →
        //       instant, no download, no 8s scan. Guards (30s behind + 4MB byte
        //       distance) live in lookup_keyframe and stop a sparse index returning
        //       a far/stale sample. This is what makes warm hovers instant.
        {
            let index = data.proactive_keyframe_index.read().await;
            if let Some(entry) = index.get(&message_id) {
                if let Some((ts, off)) = crate::ts_demux::lookup_keyframe(
                    entry, total_size, target_time_s, approx_byte, 30.0, 4 * 1024 * 1024,
                ) {
                    log::info!("[FMP4-KF-AT] proactive_keyframe_index hit near byte {} for msg {} at {}s -> {}s/byte {} (instant, no download)",
                        approx_byte, message_id, target_time_s, ts, off);
                    return Some((ts, off, true));
                }
            }
        }

        let cache_lock = byte_time_cache.0.lock().ok();
        if let Some(ref c) = cache_lock {
            if let Some(entry) = c.cache.get(&message_id) {
                if entry.total_size == total_size {
                    let idx = entry.samples.partition_point(|(ts, _)| *ts <= target_time_s);
                    if idx > 0 {
                        let (ts, off) = entry.samples[idx - 1];
                        if target_time_s - ts <= 30.0 && approx_byte.abs_diff(off) <= 4 * 1024 * 1024 {
                            log::info!("[FMP4-KF-AT] byte_time_cache hit near byte {} for msg {} at {}s -> {}s/byte {} (instant, no download)",
                                approx_byte, message_id, target_time_s, ts, off);
                            return Some((ts, off, true));
                        }
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
    let mut window_size: u64 = 6 * 1024 * 1024; // 6MB initial (was 4MB)
    let max_window: u64 = 256 * 1024 * 1024; // 256MB max (for extreme VBR offsets up to ~128MB forward)
    let search_start = std::time::Instant::now();
    // 8s (was 15s). The search STARTS at approx_byte — the linear time→byte
    // estimate — which is exactly the byte the frontend falls back to on
    // timeout. So a long deadline just delays the inevitable linear fallback
    // under playback contention (the keyframe download yields to /stream and
    // trickles in at ~800KB/s). 8s finds the real keyframe in the common,
    // uncontended case (~2 window iterations) yet bails to the proven linear
    // path ~7s sooner when /stream is saturating the pipe. Frontend
    // KEYFRAME_AT_TIMEOUT_MS is paired at 9s (deadline + 1s margin).
    let search_deadline = std::time::Duration::from_secs(8);

    while window_size <= max_window {
        // DEADLINE-FIRST: check the budget at loop TOP, before starting another
        // download. Cross-validation (2-t lines 212→217) proved a bug: the old
        // end-of-loop check let a single in-flight 12MB window download run ~15s
        // under playback contention, sailing 7s past the 8s budget — the deadline
        // was cosmetic. Now: if the remaining budget is too small to plausibly
        // finish another window, bail immediately to the linear fallback; and the
        // download itself (below) is wrapped in tokio::time::timeout(remaining) so
        // even a started download is interrupted at the deadline. On cancel the
        // download's in-memory buffer is dropped BEFORE its single post-loop disk
        // write (server.rs ~1673), so a timed-out window writes nothing — no
        // partial/corrupt cache range. Verified against download_and_cache_range.
        let remaining = match keyframe_search_remaining_budget(
            search_start.elapsed(),
            search_deadline,
            std::time::Duration::from_millis(500),
        ) {
            Some(r) => r,
            None => {
                log::warn!("[FMP4-KF-AT] Search deadline ({}s) reached for msg {} at {}s before next window, returning fallback",
                    search_deadline.as_secs(), message_id, target_time_s);
                return None;
            }
        };
        // BACKWARD-BIASED search: 75% backward, 25% forward. For VBR video the
        // real keyframe is almost always BEFORE the linear byte estimate (higher
        // bitrate early in the file pushes the true cluster earlier), so a 50/50
        // split wasted half of every window on the forward side and repeatedly
        // failed to reach the keyframe before the 15s deadline ("No keyframe <= T"
        // looping in the logs). A small forward slice is retained as a guard for
        // the occasional case where the keyframe sits just past the estimate.
        let alignment: u64 = if is_m2ts { 192 } else { 188 };
        let (start, end) = keyframe_search_window(approx_byte, window_size, total_size, alignment);

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
                            // Disk read failed — fall back to Telegram download (deadline-bounded)
                            match tokio::time::timeout(remaining, download_and_cache_range(message_id, start, end, total_size, media, cache_mgr, data)).await {
                                Ok(Ok(d)) => d,
                                Ok(Err(_)) => { window_size *= 2; continue; }
                                Err(_) => {
                                    log::warn!("[FMP4-KF-AT] Window download exceeded deadline ({}s) for msg {} at {}s, returning fallback",
                                        search_deadline.as_secs(), message_id, target_time_s);
                                    return None;
                                }
                            }
                        }
                    }
                    Err(_) => {
                        match tokio::time::timeout(remaining, download_and_cache_range(message_id, start, end, total_size, media, cache_mgr, data)).await {
                            Ok(Ok(d)) => d,
                            Ok(Err(_)) => { window_size *= 2; continue; }
                            Err(_) => {
                                log::warn!("[FMP4-KF-AT] Window download exceeded deadline ({}s) for msg {} at {}s, returning fallback",
                                    search_deadline.as_secs(), message_id, target_time_s);
                                return None;
                            }
                        }
                    }
                }
            } else {
                // Not on disk — download from Telegram (deadline-bounded so a slow
                // window can't blow past the search budget; partial bytes stay cached)
                match tokio::time::timeout(remaining, download_and_cache_range(message_id, start, end, total_size, media, cache_mgr, data)).await {
                    Ok(Ok(d)) => d,
                    Ok(Err(_)) => { window_size *= 2; continue; }
                    Err(_) => {
                        log::warn!("[FMP4-KF-AT] Window download exceeded deadline ({}s) for msg {} at {}s, returning fallback",
                            search_deadline.as_secs(), message_id, target_time_s);
                        return None;
                    }
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

        // Backstop deadline check (defensive — the loop-TOP deadline-first check
        // and the per-download tokio::time::timeout are the primary guards). Kept
        // so any future code path that reaches here without a download still can't
        // loop past the budget. Returns None → caller uses linear byte fallback.
        if search_start.elapsed() >= search_deadline {
            log::warn!("[FMP4-KF-AT] Search deadline ({}s) exceeded for msg {} at {}s, returning fallback",
                search_deadline.as_secs(), message_id, target_time_s);
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
    let (media, _) = match resolve_media_from_path(&_folder_id_str, message_id, &data, &token_data, &StreamQuery { token: query.token.clone(), cached_only: Some(false), cached_prefix: None, duration: None, source_id: None, remux_seek: None, max_bytes: None, ss: None, start_byte: None, hevc_ok: None, audio_idx: None, playhead_byte: None, subs_seek_anchor: None }).await {
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

// M2TS prefix stripping moved to ts_demux (shared with the download loops).
use crate::ts_demux::strip_m2ts_prefix;

/// Probe whether a specific ffmpeg h264 hardware encoder can actually
/// initialize on this machine (drivers + GPU present). Same one-shot pattern
/// as the original QSV-only probe: encode 1 black frame to null.
/// IMPORTANT: production args must stay a superset of these probe args plus
/// only format conversion — unprobed tuning flags could fail on some drivers.
fn h264_encoder_probe(ffmpeg_path: &std::path::Path, encoder: &str) -> bool {
    let output = std::process::Command::new(ffmpeg_path)
        .no_window()
        .args([
            "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=black:s=64x64:d=1",
            "-frames:v", "1",
            "-c:v", encoder,
            "-f", "null", "-",
        ])
        .output();
    matches!(output, Ok(o) if o.status.success())
}

/// Pure encoder ladder selection — separated from the probe so it can be
/// unit-tested. Order: QSV (Intel iGPU, most common) → NVENC → AMF → libx264.
fn select_h264_encoder(probe: impl Fn(&str) -> bool) -> &'static str {
    for enc in ["h264_qsv", "h264_nvenc", "h264_amf"] {
        if probe(enc) {
            return enc;
        }
    }
    "libx264"
}

/// One-shot cached: the best available h264 encoder on this machine.
/// QSV → NVENC → AMF → libx264 (universal software floor, ~6-8x realtime
/// 1080p on a modern laptop CPU at veryfast).
fn best_h264_encoder() -> &'static str {
    static BEST: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    *BEST.get_or_init(|| {
        let ffmpeg_path = match crate::ffmpeg_util::ensure_ffmpeg() {
            Ok(p) => p,
            Err(_) => return "libx264",
        };
        let enc = select_h264_encoder(|e| h264_encoder_probe(&ffmpeg_path, e));
        log::info!("[REMUX-CAP] best h264 encoder: {}", enc);
        enc
    })
}

/// Build the `-c:v` argument set for the remux/transcode command.
///
/// Capability-based gating (Option B): only transcode video that the player
/// genuinely cannot decode; everything else stays `-c:v copy` (zero CPU,
/// no quality loss).
/// - `needs_transcode == false` → `["-c:v","copy"]` (h264 8-bit, or 8-bit HEVC
///   on a machine whose HEVC extension is present).
/// - `needs_transcode == true`  → h264_qsv (if available) else libx264 veryfast.
///
/// QSV uses the verified `vpp_qsv=format=nv12` / `format=nv12` scalers (NOT
/// `hwupload`, which errors 80070057 on this GPU). Returns (pre_input_args,
/// output_args) so the caller places hwaccel/decoder flags BEFORE `-i` and
/// encoder flags AFTER the stream maps.
///
/// Every emitted combination is one that was execution-verified on the real
/// Panchayat file over HTTP (Probe 3):
///  - HEVC + QSV  → variant A, full-HW: `-hwaccel qsv -hwaccel_output_format qsv
///    -c:v hevc_qsv` (pre-input) + `-vf vpp_qsv=format=nv12 -c:v h264_qsv`
///    (8.29x realtime, ~2.1s cold-start, decode-clean).
///  - other codec + QSV → variant B, sw-decode→GPU-encode: `-vf format=nv12
///    -c:v h264_qsv` (5.86x, decode-clean). Used when the input decoder isn't
///    a QSV-accelerated one we verified (only hevc_qsv decode was verified).
///  - QSV unavailable → libx264 veryfast (5.87x, decode-clean).
/// Pre-input `-ss` seek args for the /remux pipe. Returns empty when no seek is
/// requested (ss <= 0 or non-finite). `-ss` BEFORE `-i` = fast input seeking;
/// ffmpeg decodes from the nearest keyframe at/behind the target. Frame-accurate
/// enough for a scrub. NaN/negative are treated as "no seek" (defensive: the
/// value comes from a query string).
fn build_ss_seek_args(ss_secs: f64) -> Vec<String> {
    if ss_secs.is_finite() && ss_secs > 0.0 {
        vec!["-ss".to_string(), format!("{:.3}", ss_secs)]
    } else {
        vec![]
    }
}

/// Output timestamp offset args for the BYTE-FORWARD seek path.
///
/// The byte-forward pipe feeds ffmpeg a fresh TS substream from the aligned
/// offset; with `-copyts -start_at_zero` the OUTPUT timeline comes out rebased
/// to ~0 (empirically proven: buffer lands at ~1.7-3.5s regardless of the seek
/// target — logs 6/7/8). That makes `video.currentTime` ≈ 2s while the user
/// seeked to e.g. 840s, so the scrubber / green (buffered) / white (loaded) bars
/// all read the wrong position (and StartupStallJumper keeps firing "stuck at 0").
///
/// `-output_ts_offset <seek>` shifts the whole output timeline (video AND audio,
/// uniformly, so A/V stay in sync) up by the seek time, restoring the ABSOLUTE
/// timeline the frontend's align-poll + `_dtsBase=0` pin were designed for (same
/// as the old `-ss` path produced). Returns [] for non-positive/non-finite seek.
fn build_output_ts_offset_args(seek_secs: f64) -> Vec<String> {
    if seek_secs.is_finite() && seek_secs > 0.0 {
        vec!["-output_ts_offset".to_string(), format!("{:.3}", seek_secs)]
    } else {
        vec![]
    }
}

/// Align a byte offset DOWN to a 188-byte MPEG-TS packet boundary.
///
/// The byte-forward seek path (stdin feeder) streams file bytes from an
/// estimated offset into ffmpeg. That offset comes from a linear time→byte
/// estimate on the frontend and can land mid-packet. Feeding ffmpeg a stream
/// that starts mid-TS-packet makes the demuxer resync-scan for the next 0x47
/// sync byte anyway, but aligning down to the packet boundary hands it a clean
/// packet start immediately (fewer discarded bytes, faster first-keyframe lock).
///
/// Always rounds DOWN (never past the target) so we never skip the keyframe the
/// estimate was aiming at. `0` stays `0` (front of file → init prefix covers it).
/// Standard TS is 188; M2TS (192-byte) callers pass `packet_size = 192`.
fn ts_align_byte(byte: u64, packet_size: u64) -> u64 {
    let ps = if packet_size == 0 { 188 } else { packet_size };
    byte - (byte % ps)
}

/// Post-input timestamp args that MUST accompany a `-ss` seek so the output PTS
/// stay ABSOLUTE (e.g. seek to 580s → output PTS ≈580s), which the frontend's
/// _dtsBase=0 mapping relies on to place video.currentTime correctly. Empty when
/// not seeking (a from-zero remux needs neither).
fn build_ss_timestamp_args(ss_secs: f64) -> Vec<String> {
    if ss_secs.is_finite() && ss_secs > 0.0 {
        vec!["-copyts".to_string(), "-start_at_zero".to_string()]
    } else {
        vec![]
    }
}

/// Audio `-af` chain for the piped remux. The tail filter DEPENDS on whether we
/// seek, because it must stay consistent with the video timeline:
///
/// - Non-seek: `asetpts=N/SR/TB` rebuilds audio PTS from sample count (starts at
///   0). Video also starts at 0 → aligned. Guards against overlapping-PTS AAC
///   frames that crash the mpegts muxer. AAC_LAYOUT_FILTER leads (strips the PCE).
/// - Seek (with `-copyts -start_at_zero`): `asetpts=N/SR/TB` is FATAL — it resets
///   audio to ~0 while video stays absolute (seek 721s → video ~721s, audio 0s).
///   The ~700s A/V desync stops mpegts.js from ever completing MediaInfo, so the
///   seek never plays. `aresample=async=1` keeps audio absolute AND monotonic
///   (source-bound QSV proof: seek 10s → audio 9.978667s vs video 10.000000s,
///   with monotonic audio DTS).
///
/// FILTER ORDER MATTERS on the seek path: `aresample` MUST come BEFORE the
/// AAC_LAYOUT_FILTER, not after. Real files carry layouts like `5.1(side)` that
/// are NOT in the allow-list; with `aformat` first, `aresample` re-emits a layout
/// `format_out` then rejects → "Cannot select channel layout / Error reinitializing
/// filters" → audio filtergraph dies with -22 → muxer gets no packets → empty
/// output → frontend refetches → ffmpeg spawn storm (proven from 13-t.md, eac3
/// 5.1(side)). Putting `aresample` first normalizes `(side)`/`(back)` variants to
/// a canonical layout the allow-list accepts, and passes stereo/5.1 through
/// unchanged (no upmix — verified by execution, so a bare `ochl=5.1` was rejected).
fn build_remux_audio_filter(is_seek: bool) -> String {
    if is_seek {
        format!("aresample=async=1,{}", AAC_LAYOUT_FILTER)
    } else {
        format!("{},asetpts=N/SR/TB", AAC_LAYOUT_FILTER)
    }
}

/// MPEG-TS output options shared by every `/remux` producer.
///
/// FFmpeg's MPEG-TS muxer defaults add a 1.4-second timestamp preload. That is
/// normally hidden when a player rebases the first DTS to zero, but the remux
/// seek path deliberately pins mpegts.js `_dtsBase=0` to preserve source-
/// absolute time. The preload then becomes a real clock error: a seek to 10.0s
/// presents source frame 10.0 at media time 11.4 while embedded subtitles remain
/// at their source timestamps. `-muxdelay 0` removes that offset without
/// changing A/V relative timing (execution-verified with FFmpeg 8.1.1: video
/// 11.400000 -> 10.000000, audio 11.378667 -> 9.978667). A factorial check
/// proved `-muxpreload 0` alone leaves both starts unchanged, so it is omitted.
fn build_mpegts_muxer_args() -> [&'static str; 6] {
    [
        "-muxdelay", "0",
        "-f", "mpegts",
        "-mpegts_flags", "resend_headers",
    ]
}

/// Per-encoder codec args + the pixel format each encoder wants fed to it.
/// Rate-control flags kept minimal/universal per encoder family so the probe
/// (default args) stays representative of production.
fn h264_encoder_output_args(encoder: &str) -> (Vec<String>, &'static str) {
    match encoder {
        "h264_qsv" => (
            vec!["-c:v".into(), "h264_qsv".into(), "-global_quality".into(), "23".into()],
            "nv12",
        ),
        "h264_nvenc" => (
            vec!["-c:v".into(), "h264_nvenc".into(), "-cq".into(), "23".into(), "-b:v".into(), "0".into()],
            "nv12",
        ),
        "h264_amf" => (
            vec!["-c:v".into(), "h264_amf".into()],
            "nv12",
        ),
        _ => (
            vec!["-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into()],
            "yuv420p",
        ),
    }
}

/// HDR→SDR tonemap chain (VERIFIED by execution on a real HDR10 clip:
/// smpte2084 + bt2020 → hable → bt709, 2.55x realtime with SW decode +
/// h264_qsv encode). zscale/tonemap need system-memory frames, so HDR always
/// uses SOFTWARE decode regardless of the encoder (no tonemap_qsv in the
/// bundled ffmpeg build — verified).
fn build_hdr_tonemap_vf(pix_fmt: &str) -> String {
    format!(
        "zscale=t=linear:npl=100,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709,format={}",
        pix_fmt
    )
}

fn build_video_encoder_args(
    needs_transcode: bool,
    encoder: &str,
    video_codec: &str,
    is_hdr: bool,
) -> (Vec<String>, Vec<String>) {
    if !needs_transcode {
        return (vec![], vec!["-c:v".into(), "copy".into()]);
    }
    let (enc_args, pix_fmt) = h264_encoder_output_args(encoder);
    if is_hdr {
        // HDR (VERIFIED): SW decode → linearize → hable tonemap → bt709 → encode.
        // Without this, HDR10/HLG output washes out gray (is_hdr was previously
        // detected but never consumed).
        let mut out = vec!["-vf".into(), build_hdr_tonemap_vf(pix_fmt)];
        out.extend(enc_args);
        return (vec![], out);
    }
    if encoder == "h264_qsv" && (video_codec == "hevc" || video_codec == "h265") {
        // Variant A (VERIFIED): full-HW HEVC decode → VPP nv12 → h264_qsv encode.
        (
            vec![
                "-hwaccel".into(), "qsv".into(),
                "-hwaccel_output_format".into(), "qsv".into(),
                "-c:v".into(), "hevc_qsv".into(),
            ],
            vec![
                "-vf".into(), "vpp_qsv=format=nv12".into(),
                "-c:v".into(), "h264_qsv".into(),
                "-global_quality".into(), "23".into(),
            ],
        )
    } else {
        // Variant B (VERIFIED for QSV; NVENC/AMF use the same shape): software
        // decode → format convert → HW/SW encode. No -hwaccel: only the QSV HW
        // decoder was execution-verified; SW decode is ~8x realtime for 1080p10
        // and the encoder is the bottleneck anyway.
        let mut out = vec!["-vf".into(), format!("format={}", pix_fmt)];
        out.extend(enc_args);
        (vec![], out)
    }
}

/// Parsed result of an ffprobe `-show_streams -show_format` JSON pass.
/// Pure data — extracted so the JSON→indices logic can be unit-tested without
/// spawning ffprobe.
#[derive(Debug, Clone)]
struct StreamProbeResult {
    video_stream_idx: i32,
    audio_stream_idx: i32,
    found_video: bool,
    found_audio: bool,
    video_codec_name: String,
    video_pix_fmt: String,
    audio_codec_name: String,
    audio_channel_layout: String,
    probed_duration: f64,
    /// ALL real audio streams (channels > 0, codec != "id3"), in file order.
    /// Used by the audio-track menu (/audio_tracks) and to validate a client
    /// `audio_idx` override. The legacy single-pick fields above are unchanged.
    audio_streams: Vec<AudioStreamInfo>,
}

/// One real audio stream from an ffprobe pass (for track selection).
#[derive(Debug, Clone, serde::Serialize)]
struct AudioStreamInfo {
    /// Absolute ffprobe stream index (usable directly in `-map 0:<index>`).
    index: i32,
    codec: String,
    channels: i32,
    channel_layout: String,
    /// ISO 639-2 language tag ("" when untagged).
    language: String,
    /// Human title tag ("" when absent).
    title: String,
    /// disposition.default == 1
    is_default: bool,
}

impl Default for StreamProbeResult {
    fn default() -> Self {
        // Defaults preserve the historical fallback indices (video 0:v, audio 1)
        // used when ffprobe fails entirely, so behavior on TOTAL probe failure is
        // byte-for-byte unchanged from before this refactor.
        Self {
            video_stream_idx: 0,
            audio_stream_idx: 1,
            found_video: false,
            found_audio: false,
            video_codec_name: String::new(),
            video_pix_fmt: String::new(),
            audio_codec_name: String::new(),
            audio_channel_layout: String::new(),
            probed_duration: 0.0,
            audio_streams: Vec::new(),
        }
    }
}

/// Remux disk-cache filename, keyed by audio track when a non-default track is
/// selected. Default (None) keeps the legacy un-suffixed name so existing cache
/// files remain valid. Suffixed names ensure outputs remuxed with different
/// audio tracks can NEVER be served interchangeably.
fn remux_cache_filename(folder_id: &str, message_id: i32, audio_idx: Option<i32>) -> String {
    match audio_idx {
        Some(idx) => format!("{}_{}_a{}.mp4", folder_id, message_id, idx),
        None => format!("{}_{}.mp4", folder_id, message_id),
    }
}

/// Validate a client-requested audio stream index against the probed real
/// audio streams. Returns the validated index, or `None` when the request is
/// absent/invalid (caller keeps the probe-resolved primary — never a 500).
fn validate_audio_idx_override(
    requested: Option<i32>,
    audio_streams: &[AudioStreamInfo],
) -> Option<i32> {
    let req = requested?;

    if audio_streams.iter().any(|s| s.index == req) {
        Some(req)
    } else {
        None
    }
}

// ══════════════════ Embedded subtitle extraction (pure helpers) ══════════════════

/// One subtitle stream from an ffprobe pass (for the embedded-subtitle menu).
/// `kind` decides extractability: "text" → extractable; "bitmap" → listed but
/// never extractable (OCR out of scope); "unsupported" → rare XML-ish formats.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct SubTrackInfo {
    /// Absolute ffprobe stream index (usable directly in `-map 0:<index>`).
    index: i32,
    codec: String,
    kind: String,
    /// ISO 639-2 language tag ("" when untagged).
    language: String,
    /// Human title ("" when absent). MKV stores it in tags.title, MP4 mov_text
    /// in tags.name — both are read (verified: E2 in subs-ffmpeg-extraction).
    title: String,
    is_default: bool,
    forced: bool,
    hearing_impaired: bool,
}

/// One font attachment stream (MKV) usable by the ASS renderer.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct FontAttachmentInfo {
    index: i32,
    filename: String,
    mimetype: String,
}

/// Parsed subtitle/font inventory of one media file.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
struct SubProbeResult {
    tracks: Vec<SubTrackInfo>,
    fonts: Vec<FontAttachmentInfo>,
}

/// Classify an ffprobe subtitle codec_name for extractability.
/// Text→text conversion is verified for every "text" codec here; bitmap→text
/// is impossible in ffmpeg ("Subtitle encoding currently only possible from
/// text to text or bitmap to bitmap").
fn subtitle_kind(codec_name: &str) -> &'static str {
    match codec_name {
        "subrip" | "srt" | "ass" | "ssa" | "webvtt" | "mov_text" | "text" => "text",
        "hdmv_pgs_subtitle" | "dvd_subtitle" | "dvb_subtitle" | "xsub" => "bitmap",
        _ => "unsupported",
    }
}

/// True when an MKV attachment stream is a usable font (by mimetype, with a
/// filename-extension fallback for sloppily tagged files).
fn is_font_attachment(filename: &str, mimetype: &str) -> bool {
    let mt = mimetype.to_ascii_lowercase();
    if mt.contains("font") || mt.contains("truetype") || mt.contains("opentype") {
        return true;
    }
    let fl = filename.to_ascii_lowercase();
    [".ttf", ".otf", ".ttc", ".woff", ".woff2"]
        .iter()
        .any(|e| fl.ends_with(e))
}

/// Parse ffprobe JSON (`-show_streams -print_format json`) into the subtitle/
/// font inventory. Separate from [`parse_probe_json`] on purpose: zero blast
/// radius on the /remux probe path. Returns an empty inventory on malformed
/// JSON (the caller distinguishes probe FAILURE from a real empty result).
fn parse_subtitle_probe_json(json_str: &str) -> SubProbeResult {
    let mut result = SubProbeResult::default();
    let val: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return result,
    };
    if let Some(streams) = val.get("streams").and_then(|s| s.as_array()) {
        for stream in streams {
            let idx = stream.get("index").and_then(|i| i.as_i64()).unwrap_or(-1);
            if idx < 0 {
                continue;
            }
            let codec_type = stream.get("codec_type").and_then(|t| t.as_str()).unwrap_or("");
            let codec_name = stream.get("codec_name").and_then(|n| n.as_str()).unwrap_or("");
            let tags = stream.get("tags");
            let get_tag = |key: &str| -> String {
                tags.and_then(|t| t.get(key))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let get_disp = |key: &str| -> bool {
                stream
                    .get("disposition")
                    .and_then(|d| d.get(key))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
                    == 1
            };
            if codec_type == "subtitle" {
                // MKV: tags.title; MP4 mov_text: tags.name (E2).
                let mut title = get_tag("title");
                if title.is_empty() {
                    title = get_tag("name");
                }
                result.tracks.push(SubTrackInfo {
                    index: idx as i32,
                    codec: codec_name.to_string(),
                    kind: subtitle_kind(codec_name).to_string(),
                    language: get_tag("language"),
                    title,
                    is_default: get_disp("default"),
                    forced: get_disp("forced"),
                    hearing_impaired: get_disp("hearing_impaired"),
                });
            } else if codec_type == "attachment" {
                let filename = get_tag("filename");
                let mimetype = get_tag("mimetype");
                if is_font_attachment(&filename, &mimetype) {
                    result.fonts.push(FontAttachmentInfo {
                        index: idx as i32,
                        filename,
                        mimetype,
                    });
                }
            }
        }
    }
    result
}

/// Subtitle extraction disk-cache filename (under `{remux_dir}/subs/`).
/// Keyed by stream index; the extension IS the served format, so the handler
/// can infer X-Subs-Format from a cache hit alone.
fn sub_cache_filename(folder_id: &str, message_id: i32, stream_idx: i32, ass: bool) -> String {
    format!(
        "{}_{}_s{}.{}",
        folder_id,
        message_id,
        stream_idx,
        if ass { "ass" } else { "srt" }
    )
}

/// Font attachment disk-cache filename (under `{remux_dir}/subs/`).
fn durable_subs_root(cache: &Option<StreamCacheManager>) -> std::path::PathBuf {
    if let Some(cache_mgr) = cache.as_ref() {
        return cache_mgr.cache_dir().parent()
            .unwrap_or(cache_mgr.cache_dir())
            .join("subtitle-cache");
    }
    std::env::temp_dir().join("nobuf-subtitle-cache")
}

fn durable_sub_cache_path(
    cache: &Option<StreamCacheManager>,
    folder_key: i64,
    message_id: i32,
    stream_idx: i32,
    source_size: u64,
    ass: bool,
) -> std::path::PathBuf {
    durable_subs_root(cache)
        .join(folder_key.to_string())
        .join(message_id.to_string())
        .join(format!("s{}_{}.{}", stream_idx, source_size, if ass { "ass" } else { "srt" }))
}

fn should_promote_complete_subtitles(media_complete: bool, promotion_running: bool) -> bool {
    media_complete && !promotion_running
}

fn should_publish_complete_subtitles(current_generation: u64, job_generation: u64) -> bool {
    current_generation == job_generation
}

fn build_all_sub_extract_args(
    input: &str,
    tracks: &[(i32, bool, String)],
) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".into(), "-loglevel".into(), "error".into(),
        "-nostdin".into(), "-y".into(), "-i".into(), input.into(),
    ];
    for (stream_idx, ass, output) in tracks {
        args.extend(["-map".into(), format!("0:{}", stream_idx), "-an".into(), "-vn".into(), "-copyts".into()]);
        if *ass {
            args.extend(["-c:s".into(), "copy".into(), "-f".into(), "ass".into()]);
        } else {
            args.extend(["-f".into(), "srt".into()]);
        }
        args.extend(["-flush_packets".into(), "1".into(), output.clone()]);
    }
    args
}

fn sub_font_cache_filename(folder_id: &str, message_id: i32, att_idx: i32) -> String {
    format!("{}_{}_f{}.bin", folder_id, message_id, att_idx)
}

/// ffmpeg args for extracting ONE text subtitle track to a file.
/// ASS/SSA sources are codec-copied to .ass (byte-faithful header + styles);
/// every other text codec transcodes to SRT. `latin1_retry` inserts
/// `-sub_charenc latin1` BEFORE `-i` (input option) for the mislabeled-charset
/// retry (verified E9b/E9c). The `-map` uses the ABSOLUTE stream index —
/// never `0:s:N` relative maps and never trailing-`?` maps (F1/C11: a `?` map
/// was observed emitting the WRONG track's cues).
fn build_sub_extract_args(
    input: &str,
    stream_idx: i32,
    ass: bool,
    latin1_retry: bool,
    out_path: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-y".into(),
    ];
    if latin1_retry {
        args.push("-sub_charenc".into());
        args.push("latin1".into());
    }
    args.push("-i".into());
    args.push(input.into());
    args.push("-map".into());
    args.push(format!("0:{}", stream_idx));
    // Round-10 P0-1: keep cue timestamps ABSOLUTE. ffmpeg's output stage
    // subtracts the first demuxed packet's timestamp, so when the served byte
    // region excludes cluster 0 (any scattered/post-seek cache — exactly what
    // the playhead-island input produces) every cue is silently rebased toward
    // zero: verified 559.9s desync at exit 0, well-formed SRT, correct cue
    // count. Nothing in exit status, stderr, cue count or byte length reveals
    // it. Verified byte-identical on fully-cached input, so it is unconditional.
    // NEVER pair with -start_at_zero (see build_ss_timestamp_args): that combo
    // re-rebases the output timeline and reintroduces the exact bug.
    args.push("-copyts".into());
    if ass {
        args.push("-c:s".into());
        args.push("copy".into());
        args.push("-f".into());
        args.push("ass".into());
    } else {
        args.push("-f".into());
        args.push("srt".into());
    }
    // Round-3: flush each muxed cue to disk immediately — the output survives
    // even a kill_on_drop mid-extraction (120s timeout), enabling salvage
    // (fixture: 90 cues on disk at SIGKILL t=25s vs 0 without).
    args.push("-flush_packets".into());
    args.push("1".into());
    args.push(out_path.into());
    args
}

/// ffmpeg args for dumping ONE font attachment to `out_path`.
/// `-dump_attachment` is an INPUT option that writes the file at input-open
/// time (attachments live in the MKV header); `-t 0.01 -f null -` bounds the
/// rest of the run and satisfies "at least one output" with a clean exit 0
/// (verified X4/X5/F1 in subs research).
fn build_font_dump_args(input: &str, att_idx: i32, out_path: &str) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-y".into(),
        format!("-dump_attachment:{}", att_idx),
        out_path.into(),
        "-i".into(),
        input.into(),
        "-t".into(),
        "0.01".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]
}

/// Parse ffprobe JSON (`-show_streams -show_format -print_format json`) into a
/// [`StreamProbeResult`]. Selects the FIRST video stream and the FIRST *real*
/// audio stream (channels > 0 AND codec != "id3" — skips Telegram's sparse
/// timed-ID3 track). A 2nd video stream (e.g. mjpeg cover art) is ignored.
/// Returns [`StreamProbeResult::default`] (found_video = found_audio = false) on
/// malformed/empty JSON so the caller can decide whether to re-probe.
fn parse_probe_json(json_str: &str) -> StreamProbeResult {
    let mut result = StreamProbeResult::default();
    let val: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return result,
    };
    if let Some(streams) = val.get("streams").and_then(|s| s.as_array()) {
        for stream in streams {
            let idx = stream.get("index").and_then(|i| i.as_i64()).unwrap_or(-1);
            if idx < 0 {
                continue;
            }
            let codec_type = stream.get("codec_type").and_then(|t| t.as_str()).unwrap_or("");
            let codec_name = stream.get("codec_name").and_then(|n| n.as_str()).unwrap_or("");
            let channels = stream.get("channels").and_then(|c| c.as_i64()).unwrap_or(0);

            if codec_type == "video" && !result.found_video {
                result.video_stream_idx = idx as i32;
                result.found_video = true;
                result.video_codec_name = codec_name.to_string();
                result.video_pix_fmt = stream
                    .get("pix_fmt")
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .to_string();
            }
            if codec_type == "audio" && channels > 0 && codec_name != "id3" {
                // Collect EVERY real audio stream for track selection.
                let tags = stream.get("tags");
                let get_tag = |key: &str| -> String {
                    tags.and_then(|t| t.get(key))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                };
                result.audio_streams.push(AudioStreamInfo {
                    index: idx as i32,
                    codec: codec_name.to_string(),
                    channels: channels as i32,
                    channel_layout: stream
                        .get("channel_layout")
                        .and_then(|l| l.as_str())
                        .unwrap_or("")
                        .to_string(),
                    language: get_tag("language"),
                    title: get_tag("title"),
                    is_default: stream
                        .get("disposition")
                        .and_then(|d| d.get("default"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0) == 1,
                });
                // Legacy primary pick: FIRST real audio stream (unchanged behavior).
                if !result.found_audio {
                    result.audio_stream_idx = idx as i32;
                    result.found_audio = true;
                    result.audio_codec_name = codec_name.to_string();
                    result.audio_channel_layout = stream
                        .get("channel_layout")
                        .and_then(|l| l.as_str())
                        .unwrap_or("")
                        .to_string();
                }
            }
        }
    }
    if let Some(dur_str) = val
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
    {
        if let Ok(dur) = dur_str.parse::<f64>() {
            if dur > 0.0 {
                result.probed_duration = dur;
            }
        }
    }
    result
}

/// Run ONE ffprobe `-show_streams -show_format` pass over `input_source` with the
/// given probe budget, returning parsed streams/duration. Logs failures and
/// returns [`StreamProbeResult::default`] on spawn error / non-zero exit /
/// malformed output (never panics — the caller decides how to degrade).
async fn run_stream_probe(
    ffprobe_path: &std::path::Path,
    input_source: &str,
    probesize: &str,
    analyzeduration: &str,
    message_id: i32,
) -> StreamProbeResult {
    let probe_output = TokioCommand::new(ffprobe_path)
        .no_window()
        .args([
            "-hide_banner", "-loglevel", "error",
            "-print_format", "json",
            "-show_streams", "-show_format",
            "-probesize", probesize, "-analyzeduration", analyzeduration,
            input_source,
        ])
        .output()
        .await;
    match probe_output {
        Ok(output) if output.status.success() => {
            parse_probe_json(&String::from_utf8_lossy(&output.stdout))
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!(
                "[REMUX-PROBE] msg {}: ffprobe failed (probesize={}): {}",
                message_id, probesize, stderr.trim()
            );
            StreamProbeResult::default()
        }
        Err(e) => {
            log::warn!(
                "[REMUX-PROBE] msg {}: ffprobe spawn failed (probesize={}): {}",
                message_id, probesize, e
            );
            StreamProbeResult::default()
        }
    }
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
    // Requested audio-track override (validated against the probe below).
    let requested_audio_idx: Option<i32> = query.audio_idx;
    let mut remux_path = remux_dir.join(remux_cache_filename(&folder_id_str, message_id, None));
    let mut remux_tmp = remux_dir.join(format!("{}.tmp", remux_cache_filename(&folder_id_str, message_id, None)));

    // ── Phase 1: If remuxed MP4 already cached, serve it with byte-range ──
    // ONLY on the default (no audio_idx) path: an override must be validated
    // against the probe FIRST, otherwise a junk/mismatched key could serve the
    // wrong track's audio. Overridden requests re-run this check post-probe.
    if requested_audio_idx.is_none() && remux_path.exists() {
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

    // Resolve ffprobe path (PATH → exe_dir → sidecar) so release builds work
    // even when ffprobe isn't in the GUI process's PATH.
    let ffprobe_path = match crate::ffmpeg_util::ensure_ffprobe() {
        Ok(p) => p,
        Err(e) => {
            log::error!("[REMUX] msg {}: ffprobe not found: {}", message_id, e);
            // Use defaults — ffprobe is best-effort for stream indices
            return HttpResponse::InternalServerError()
                .body(format!("ffprobe not found: {}", e));
        }
    };
    // ── FAST PROBE (Change 1): 5MB / 5s budget ──
    // The old budget was 50MB / 50s. On the Telegram-backed /stream input the
    // analyzeduration=50s limit was the binding constraint: ffprobe pulled ~50
    // seconds-of-video worth of bytes (11–37 MB depending on bitrate) before
    // returning, at the ~1.8 MB/s single-stream ceiling → 6–21s blocking wait
    // before ffmpeg (and thus playback) could start (verified against logs
    // 2-t.md: served-byte ranges == 50s-of-video for all three files). A 5s
    // window still covers standard TS A/V interleaving and cuts the wait to
    // ~1–3s. The rare file whose real audio starts later than 5s is handled by
    // the guarded fallback below.
    const FAST_PROBESIZE: &str = "5000000";        // 5 MB
    const FAST_ANALYZEDURATION: &str = "5000000";  // 5 s (µs units)
    const FULL_PROBESIZE: &str = "50000000";       // 50 MB
    const FULL_ANALYZEDURATION: &str = "50000000"; // 50 s (µs units)

    let mut probe = run_stream_probe(
        &ffprobe_path, &input_source, FAST_PROBESIZE, FAST_ANALYZEDURATION, message_id,
    ).await;

    // ── GUARDED FALLBACK (Change 2): re-probe at the old 50MB/50s budget ──
    // ONLY when the fast probe failed to find a real video OR audio stream. A
    // successful fast probe (both found) never pays this cost. This preserves
    // the original "large probesize discovers late/sparse streams" guarantee for
    // the pathological files while keeping the common case fast. Duration alone
    // does NOT trigger a re-probe (it's best-effort and also filled from the
    // /remux ffprobe estimate elsewhere).
    if !probe.found_video || !probe.found_audio {
        log::warn!(
            "[REMUX-PROBE] msg {}: fast probe incomplete (video={}, audio={}) — re-probing at {}B/{}µs",
            message_id, probe.found_video, probe.found_audio, FULL_PROBESIZE, FULL_ANALYZEDURATION
        );
        let full = run_stream_probe(
            &ffprobe_path, &input_source, FULL_PROBESIZE, FULL_ANALYZEDURATION, message_id,
        ).await;
        // Merge: prefer any stream the full probe found that the fast one missed,
        // so a fast-found video isn't lost if the full probe somehow regresses.
        if full.found_video && !probe.found_video {
            probe.video_stream_idx = full.video_stream_idx;
            probe.found_video = true;
            probe.video_codec_name = full.video_codec_name.clone();
            probe.video_pix_fmt = full.video_pix_fmt.clone();
        }
        if full.found_audio && !probe.found_audio {
            probe.audio_stream_idx = full.audio_stream_idx;
            probe.found_audio = true;
            probe.audio_codec_name = full.audio_codec_name.clone();
            probe.audio_channel_layout = full.audio_channel_layout.clone();
        }
        // Track list: the full probe sees strictly more of the file — prefer
        // its stream inventory when it found more audio streams.
        if full.audio_streams.len() > probe.audio_streams.len() {
            probe.audio_streams = full.audio_streams.clone();
        }
        if probe.probed_duration <= 0.0 && full.probed_duration > 0.0 {
            probe.probed_duration = full.probed_duration;
        }
    }

    // ── Audio-track override (validate-first, see remux_cache_filename) ──
    // A client-requested audio_idx is honored only if the probe confirms it is
    // a real audio stream; otherwise keep the probe-resolved primary (never a
    // 500 — the stream must always play). The validated idx re-keys the disk
    // cache and re-runs the Phase-1 cached-serve check that was skipped above.
    let validated_audio_idx = validate_audio_idx_override(requested_audio_idx, &probe.audio_streams);
    if let Some(requested) = requested_audio_idx {
        match validated_audio_idx {
            Some(idx) => {
                if idx != probe.audio_stream_idx {
                    // Update the codec/layout metadata to the SELECTED stream so
                    // downstream logging + AAC layout handling reflect reality.
                    if let Some(s) = probe.audio_streams.iter().find(|s| s.index == idx) {
                        probe.audio_codec_name = s.codec.clone();
                        probe.audio_channel_layout = s.channel_layout.clone();
                    }
                    probe.audio_stream_idx = idx;
                    log::info!("[REMUX] msg {}: audio track override → stream idx={}", message_id, idx);
                }
                remux_path = remux_dir.join(remux_cache_filename(&folder_id_str, message_id, Some(idx)));
                remux_tmp = remux_dir.join(format!("{}.tmp", remux_cache_filename(&folder_id_str, message_id, Some(idx))));
                if remux_path.exists() {
                    let file_size = match std::fs::metadata(&remux_path) {
                        Ok(m) => m.len(),
                        Err(_) => return HttpResponse::InternalServerError().body("Failed to read remux cache"),
                    };
                    log::info!("[REMUX] msg {}: serving cached remux for audio_idx={} ({:.1} MB)",
                        message_id, idx, file_size as f64 / 1e6);
                    return serve_local_file(&req, &remux_path, file_size, "video/mp2t");
                }
            }
            None => {
                log::warn!(
                    "[REMUX] msg {}: requested audio_idx={} is not a real audio stream (available: {:?}) — using primary idx={}",
                    message_id, requested,
                    probe.audio_streams.iter().map(|s| s.index).collect::<Vec<_>>(),
                    probe.audio_stream_idx
                );
                // Fall back to the legacy default cache key (primary track).
                remux_path = remux_dir.join(remux_cache_filename(&folder_id_str, message_id, None));
                remux_tmp = remux_dir.join(format!("{}.tmp", remux_cache_filename(&folder_id_str, message_id, None)));
                if remux_path.exists() {
                    let file_size = match std::fs::metadata(&remux_path) {
                        Ok(m) => m.len(),
                        Err(_) => return HttpResponse::InternalServerError().body("Failed to read remux cache"),
                    };
                    return serve_local_file(&req, &remux_path, file_size, "video/mp2t");
                }
            }
        }
    }

    // Unpack into the downstream variable names (unchanged below this point).
    // NOTE: non-standard audio layouts (e.g. "5.1(side)") make the AAC encoder
    // emit a PCE (Program Config Element), which Chromium's MSE fMP4 parser
    // rejects → CHUNK_DEMUXER_ERROR_APPEND_FAILED, tearing down the /remux pipe
    // and killing ffmpeg with -22 on the trailer write. Fixed by
    // AAC_LAYOUT_FILTER at all three encode sites; layout is logged below.
    let video_stream_idx: i32 = probe.video_stream_idx;
    let audio_stream_idx: i32 = probe.audio_stream_idx;
    let probed_duration: f64 = probe.probed_duration;
    let video_codec_name: String = probe.video_codec_name.clone();
    let video_pix_fmt: String = probe.video_pix_fmt.clone();

    if probe.found_video {
        log::info!("[REMUX-PROBE] msg {}: video stream idx={} (codec={}, pix_fmt={})",
            message_id, video_stream_idx, video_codec_name, video_pix_fmt);
    }
    if probe.found_audio {
        log::info!("[REMUX-PROBE] msg {}: audio stream idx={} (codec={}, layout={})",
            message_id, audio_stream_idx, probe.audio_codec_name, probe.audio_channel_layout);
    } else {
        log::warn!("[REMUX-PROBE] msg {}: no real audio stream found (after fallback), using idx={}",
            message_id, audio_stream_idx);
    }
    if probed_duration > 0.0 {
        log::info!("[REMUX-PROBE] msg {}: ffprobe duration={:.1}s", message_id, probed_duration);
        // Cache the exact duration so /fmp4/metadata (which the seek bar reads)
        // can return it instead of the bitrate estimate.
        data.probed_durations.write().await.insert(message_id, probed_duration);
    }

    // ── Phase 2: classify — needs_transcode (capability-based) + is_hdr ──
    // Decision (Option B): only transcode video the player genuinely can't decode.
    //   h264            → copy (client transmuxer / mpegts.js both accept avc1)
    //   hevc 10/12-bit  → transcode ALWAYS (mpegts.js MSE rejects hvc1.2 Main10,
    //                     even with the Windows HEVC extension installed)
    //   hevc 8-bit      → copy IFF the frontend says the runtime can decode hvc1
    //                     (hevc_ok hint from canPlayType); else transcode
    //   anything else muxable into TS as-is is rare — default to transcode to be safe,
    //   EXCEPT vp8/vp9/av1 which never reach /remux (frontend routes them native).
    let is_10bit_plus = video_pix_fmt.contains("10le") || video_pix_fmt.contains("12le")
        || video_pix_fmt.contains("10be") || video_pix_fmt.contains("12be")
        || video_pix_fmt.contains("p010") || video_pix_fmt.contains("p012");
    let hevc_ok = query.hevc_ok.unwrap_or(false);
    let needs_transcode = match video_codec_name.as_str() {
        "h264" => false,                       // always cheap-path
        "hevc" | "h265" => is_10bit_plus || !hevc_ok, // 10-bit always; 8-bit only if runtime can't decode
        "" => false,                           // probe failed — preserve old behavior (copy)
        _ => true,                             // unknown/other → transcode to be safe
    };

    // HDR detection MUST be frame-level: stream-level ffprobe misses color_transfer
    // (proven — see cross-validation report C3/C4). Only probe when the video will
    // be handled by us (needs_transcode) — a cheap-path h264 copy doesn't need it.
    let mut is_hdr = false;
    if needs_transcode {
        let frame_probe = TokioCommand::new(&ffprobe_path)
            .no_window()
            .args([
                "-hide_banner", "-loglevel", "error",
                "-print_format", "json",
                "-select_streams", &format!("{}", video_stream_idx),
                "-show_frames", "-read_intervals", "%+#1",
                "-show_entries", "frame=color_transfer,color_primaries,color_space",
                "-probesize", "50000000", "-analyzeduration", "50000000",
                &input_source,
            ])
            .output()
            .await;
        if let Ok(fout) = frame_probe {
            if fout.status.success() {
                let fjson = String::from_utf8_lossy(&fout.stdout);
                if let Ok(fval) = serde_json::from_str::<serde_json::Value>(&fjson) {
                    if let Some(frame) = fval.get("frames").and_then(|f| f.as_array()).and_then(|a| a.first()) {
                        let transfer = frame.get("color_transfer").and_then(|t| t.as_str()).unwrap_or("");
                        let primaries = frame.get("color_primaries").and_then(|p| p.as_str()).unwrap_or("");
                        is_hdr = transfer == "smpte2084" || transfer == "arib-std-b67" || primaries == "bt2020";
                        log::info!("[REMUX-PROBE] msg {}: frame color transfer={} primaries={}", message_id, transfer, primaries);
                    }
                }
            }
        }
    }
    log::info!("[REMUX-PROBE] msg {}: needs_transcode={} is_hdr={} vcodec={} pix_fmt={} hevc_ok={}",
        message_id, needs_transcode, is_hdr, video_codec_name, video_pix_fmt, hevc_ok);

    // Stash is_hdr for the /thumb endpoint (single-frame hover grabs need the
    // tonemap decision but must not pay for their own ffprobe HDR probe).
    if let Ok(mut m) = thumb_hdr_map().lock() {
        m.insert(message_id, is_hdr);
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

        // Resolve ffmpeg path (PATH → exe_dir → sidecar) for release builds.
        let ffmpeg_path = match crate::ffmpeg_util::ensure_ffmpeg() {
            Ok(p) => p,
            Err(e) => {
                log::error!("[REMUX] msg {}: ffmpeg not found: {}", message_id, e);
                return HttpResponse::InternalServerError()
                    .body(format!("ffmpeg not found: {}", e));
            }
        };
        let mut cmd = TokioCommand::new(&ffmpeg_path);
        cmd.no_window();
        // Same capability gate as Strategy B: copy what the player can decode,
        // transcode what it can't (HEVC on stock WebView2). Without this, a
        // fully-cached HEVC file would remux to an HEVC TS that MSE rejects.
        let (a_pre_input_args, a_video_enc_args) =
            build_video_encoder_args(needs_transcode, best_h264_encoder(), &video_codec_name, is_hdr);
        cmd.args([
            "-hide_banner",
            "-loglevel", "warning",
            // +genpts: regenerate PTS from DTS (fixes non-monotonic audio timestamps)
            // +discardcorrupt: drop damaged packets before they reach the filter chain
            "-fflags", "+genpts+discardcorrupt",
            // Shift all timestamps to start at zero — prevents negative DTS that
            // the MPEG-TS muxer rejects with EINVAL.
            "-avoid_negative_ts", "make_zero",
        ]);
        cmd.args(&a_pre_input_args);
        cmd.args([
            "-i", &input_source,
            // Use ffprobe-resolved stream indices, NOT hardcoded 0:v:0/0:a:0.
            // Files with timed_id3 metadata may have the id3 stream as the first
            // audio stream; 0:a:0 would map the wrong stream → AAC muxing error.
            "-map", &format!("0:{}", video_stream_idx),
            "-map", &format!("0:{}", audio_stream_idx),
        ]);
        cmd.args(&a_video_enc_args);
        cmd.args([
            "-c:a", "aac", "-b:a", "192k",
            // Remap non-standard layouts (e.g. 5.1(side)) so AAC avoids a PCE
            // that Chromium MSE can't parse. See AAC_LAYOUT_FILTER.
            "-af", AAC_LAYOUT_FILTER,
        ]);
        cmd.args(build_mpegts_muxer_args());
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

        // Resolve ffmpeg path (PATH → exe_dir → sidecar) for release builds.
        let ffmpeg_path = match crate::ffmpeg_util::ensure_ffmpeg() {
            Ok(p) => p,
            Err(e) => {
                log::error!("[REMUX] msg {}: ffmpeg not found: {}", message_id, e);
                return HttpResponse::InternalServerError()
                    .body(format!("ffmpeg not found: {}", e));
            }
        };
        // Capability-based encoder selection: ladder QSV→NVENC→AMF→libx264,
        // decided BEFORE spawning — the piped stream can't fall back mid-flight.
        let (pre_input_args, video_enc_args) =
            build_video_encoder_args(needs_transcode, best_h264_encoder(), &video_codec_name, is_hdr);
        log::info!("[REMUX] msg {}: piped stream — needs_transcode={} video_enc={:?}",
            message_id, needs_transcode, video_enc_args);

        let mut cmd = TokioCommand::new(&ffmpeg_path);
        cmd.no_window();
        // SEEK DIAGNOSTIC (temporary): when this is a seek (ss>0) over the live
        // /stream HTTP input, bump ffmpeg to debug so it logs the protocol/demuxer
        // seek path — we need to see whether it issues an HTTP Range at the target
        // cluster byte or falls back to a linear read from the front. Remove once
        // the front-read root cause is confirmed. Non-seek remux stays at warning.
        // ── SEEK MODE SELECTION ──
        // Two mutually-exclusive seek mechanisms:
        //   (A) BYTE-FORWARD (start_byte set): the robust path for uncached
        //       Telegram streams. We feed ffmpeg [init_prefix + /stream bytes
        //       from a TS-aligned offset] via stdin (pipe:0). ffmpeg reads
        //       SEQUENTIALLY from its own byte 0 — it never issues a timestamp
        //       seek, so it cannot fail with "read_timestamp() failed in the
        //       middle / could not seek" the way `-ss` over the HTTP input does
        //       when the target region isn't downloaded (proven: logs 4-t/5-t).
        //       Output PTS stay ABSOLUTE (input TS carries real PTS), so the
        //       frontend _dtsBase=0 pin + align poll land the playhead correctly,
        //       same as the -ss path did when it worked on cached files.
        //   (B) TIME `-ss` (ss set, no start_byte): legacy path, kept for cached
        //       files / MKV where the input is seekable.
        // start_byte takes precedence when both are present.
        let ss_secs = query.ss.unwrap_or(0.0);
        let byte_seek = query.start_byte.filter(|&b| b > 0);
        let final_input_source = marked_remux_input_source(&input_source, ss_secs, byte_seek.is_some());
        // is_seek drives the audio filter choice (aresample=async=1 vs asetpts):
        // BOTH seek modes need the seek-variant filter (absolute audio PTS), so
        // is_seek is true for a byte-forward seek too.
        let is_seek = byte_seek.is_some() || (ss_secs.is_finite() && ss_secs > 0.0);
        cmd.args(["-hide_banner", "-loglevel", "warning"]);
        // Mode A: NO -ss (we seek by feeding bytes). Mode B: -ss before -i.
        // build_ss_seek_args returns [] for ss<=0 / NaN (see helper + tests).
        if byte_seek.is_none() {
            let ss_seek_args = build_ss_seek_args(ss_secs);
            if !ss_seek_args.is_empty() {
                log::info!("[REMUX] msg {}: seeking to {:.3}s before remux", message_id, ss_secs);
                for a in &ss_seek_args { cmd.arg(a); }
            }
        }
        // Pre-input args: QSV hwaccel + hardware decoder (empty for copy/libx264).
        // MUST come before -i so ffmpeg initializes the GPU decode session.
        for a in &pre_input_args { cmd.arg(a); }
        // +genpts: regenerate PTS from DTS (fixes non-monotonic audio timestamps)
        // +discardcorrupt: drop damaged packets before they reach the filter chain
        cmd.args([
            "-fflags", "+genpts+discardcorrupt",
            // NOTE: a 50MB probesize was tried here and REVERTED — on a stalling
            // live /stream pipe it made ffmpeg block ~15s trying to fill the probe
            // buffer (chasing the cover-art "stream 3") without fixing the real
            // fault. FFREPORT diagnosis proved the transcode itself is FINE (0
            // decode errors, 64 frames encoded); the "PPS out of range" lines are
            // harmless probe-time noise. The actual fault: ffmpeg hit input EOF
            // after ~1.7MB / 2.5s because /stream signals EOF instead of blocking
            // for the progressively-downloaded remainder, then failed the trailer
            // write to the (already torn-down) output pipe with -22.
            // Shift all timestamps to start at zero — prevents negative DTS that
            // the MPEG-TS muxer rejects with EINVAL ("Error submitting a packet
            // to the muxer: Invalid argument", exit code -22).
            "-avoid_negative_ts", "make_zero",
        ]);
        // Input: Mode A (byte-forward) reads from stdin pipe:0 (fed below with
        // init_prefix + /stream bytes from the aligned offset). Mode B reads the
        // /stream HTTP URL (or cached file) directly.
        if byte_seek.is_some() {
            cmd.arg("-i").arg("pipe:0");
        } else {
            cmd.arg("-i").arg(&final_input_source);
        }
        cmd.args([
            // Use ffprobe-resolved stream indices, NOT hardcoded 0:v:0/0:a:0.
            "-map", &format!("0:{}", video_stream_idx),
            "-map", &format!("0:{}", audio_stream_idx),
            // Drop subtitles (e.g. ass) — they aren't muxable into MPEG-TS here and
            // the explicit maps already exclude any 2nd video stream (mjpeg cover art).
            "-sn",
        ]);
        // Video encoder: copy / h264_qsv / libx264 (from build_video_encoder_args).
        for a in &video_enc_args { cmd.arg(a); }
        // Audio monotonicity fix — filter choice DEPENDS on whether we're seeking:
        //
        //   Non-seek (ss=0): asetpts=N/SR/TB rewrites audio PTS from sample count,
        //   starting at 0. Video also starts at 0, so A/V stay aligned. This guards
        //   against source AAC frames with overlapping PTS that crash the mpegts muxer.
        //
        //   Seek (ss>0): asetpts=N/SR/TB is FATAL. It resets audio to ~0 while
        //   -copyts keeps video ABSOLUTE (seek 721s → video PTS 721s, audio PTS 0s).
        //   The ~700s A/V desync floods ffmpeg's sync queue ("queue head -1 ts N/A")
        //   and mpegts.js can never complete MediaInfo (needs both tracks' DTS close),
        //   so MEDIA_INFO never fires and nothing appends → seek never plays.
        //   Proven by execution: seek 30s → asetpts gives audio near 0 while video
        //   stays near 30s. aresample=async=1 instead keeps audio ABSOLUTE and
        //   monotonic (source-bound QSV proof: seek 10s → audio 9.978667s vs video
        //   10.000000s) — the correct fix for the seek path.
        //   AAC_LAYOUT_FILTER is chained first (single -af only) to avoid the MSE PCE.
        let audio_filter = build_remux_audio_filter(is_seek);
        cmd.args(["-c:a", "aac", "-b:a", "192k", "-af", &audio_filter]);
        // Preserve original timestamps so MSE timeline matches video.currentTime.
        // Output PTS stay absolute (seek 580s → PTS ≈580s) — verified by execution;
        // the frontend _dtsBase=0 mapping depends on it. Empty when not seeking.
        // Byte-forward mode also needs -copyts -start_at_zero (normalizes the
        // fed substream's timestamps to start at 0); pass a non-zero sentinel so
        // build_ss_timestamp_args emits them on that path too.
        let ts_arg_ss = if byte_seek.is_some() && ss_secs <= 0.0 { 1.0 } else { ss_secs };
        for a in &build_ss_timestamp_args(ts_arg_ss) { cmd.arg(a); }
        // BYTE-FORWARD absolute-timeline fix: -start_at_zero rebased the output to
        // ~0, so video.currentTime landed at ~2s while the user seeked to e.g. 840s
        // → scrubber/green/white bars all wrong (proven logs 6/7/8: "buffer start
        // 1.7s (delta -839.1s)"). Shift the whole output up to the seek time so the
        // timeline is ABSOLUTE (what the frontend align-poll + _dtsBase=0 expect).
        // ss_secs carries the seek time (frontend sends BOTH start_byte and ss).
        // Only on byte-forward — the -ss path is already absolute via input seek.
        if byte_seek.is_some() {
            for a in &build_output_ts_offset_args(ss_secs) { cmd.arg(a); }
        }
        cmd.args([
            // Disable interleave check: prevent muxer from rejecting audio packets
            // that arrive slightly out-of-order relative to video DTS
            "-max_interleave_delta", "0",
        ]);
        cmd.args(build_mpegts_muxer_args());
        cmd.arg("-");
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        // Byte-forward mode feeds the input through stdin; open the pipe.
        if byte_seek.is_some() {
            cmd.stdin(std::process::Stdio::piped());
        }
        // Reap this ffmpeg if the response stream is dropped before EOF. A seek
        // aborts the HTTP connection → actix drops the async_stream → the owned
        // `child` drops. tokio does NOT kill a child on drop by default
        // (kill_on_drop=false), so without this each seek would orphan a live
        // ffmpeg still transcoding into a dead pipe (QSV/CPU pileup under
        // scrubbing). kill_on_drop(true) makes the drop reap the process.
        cmd.kill_on_drop(true);

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

        // ── BYTE-FORWARD STDIN FEEDER (Mode A) ──
        // Feed ffmpeg's stdin with [init_prefix (rewritten PAT/PMT)] + [/stream
        // bytes from the TS-aligned offset forward]. ffmpeg then demuxes a valid
        // TS stream starting at a packet boundary, sees the PMT immediately, and
        // reads sequentially to EOF — no timestamp seek, so no "could not seek"
        // failure on uncached Telegram data. The /stream GET handler is reused
        // UNCHANGED (it already downloads-on-demand + rewrites TS PIDs), so the
        // whole tuned range/coordinator/prebuffer path is untouched.
        if let Some(raw_offset) = byte_seek {
            // Align down to a TS packet boundary (188, or 192 for M2TS).
            let (ps, _is_m2ts) = if let Some(ref cm) = **cache {
                cm.get_hls_layout(message_id)
                    .map(|(_, _, pkt, m2ts)| (pkt, m2ts))
                    .unwrap_or((188, false))
            } else {
                (188, false)
            };
            let aligned = ts_align_byte(raw_offset, ps);
            // Cached rewritten init-prefix (PAT/PMT). If absent we still proceed —
            // ffmpeg will resync at the first inline PAT/PMT in the byte stream.
            let init_prefix: Vec<u8> = (**cache)
                .as_ref()
                .and_then(|cm| cm.get_init_prefix(message_id))
                .unwrap_or_default();
            log::info!(
                "[REMUX] msg {}: BYTE-FORWARD seek — raw offset {} → TS-aligned {} (packet {}B), init_prefix {}B, feeding stdin",
                message_id, raw_offset, aligned, ps, init_prefix.len()
            );
            let feeder_url = input_source.clone();
            let stdin = child.stdin.take();
            let msg_id_feed = message_id;
            if let Some(mut stdin) = stdin {
                tokio::spawn(async move {
                    use tokio::io::AsyncWriteExt;
                    // 1) init prefix first
                    if !init_prefix.is_empty() {
                        if let Err(e) = stdin.write_all(&init_prefix).await {
                            log::warn!("[REMUX] msg {}: feeder init_prefix write failed: {}", msg_id_feed, e);
                            return;
                        }
                    }
                    // 2) stream body from `aligned` forward, fetched via the
                    //    unchanged /stream GET (Range). ureq is blocking, so the
                    //    HTTP read runs on a blocking thread and hands chunks back
                    //    over a bounded channel; we write them to stdin async.
                    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
                    let range_val = format!("bytes={}-", aligned);
                    std::thread::spawn(move || {
                        match ureq::get(&feeder_url).set("Range", &range_val).call() {
                            Ok(resp) => {
                                let mut reader = resp.into_reader();
                                let mut buf = vec![0u8; 256 * 1024];
                                loop {
                                    match std::io::Read::read(&mut reader, &mut buf) {
                                        Ok(0) => break,
                                        Ok(n) => {
                                            if tx.blocking_send(buf[..n].to_vec()).is_err() {
                                                break; // receiver gone (ffmpeg died / seek superseded)
                                            }
                                        }
                                        Err(_) => break,
                                    }
                                }
                            }
                            Err(e) => {
                                log::warn!("[REMUX] msg {}: feeder /stream GET failed: {}", msg_id_feed, e);
                            }
                        }
                    });
                    while let Some(chunk) = rx.recv().await {
                        if let Err(_e) = stdin.write_all(&chunk).await {
                            // ffmpeg closed stdin (EOF reached / process reaped) —
                            // normal on seek supersede; stop feeding.
                            break;
                        }
                    }
                    let _ = stdin.shutdown().await;
                });
            } else {
                log::warn!("[REMUX] msg {}: BYTE-FORWARD requested but ffmpeg stdin not captured", message_id);
            }
        }

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
                        // Resolve ffmpeg path for the background task too.
                        let bg_ffmpeg_path = match crate::ffmpeg_util::ensure_ffmpeg() {
                            Ok(p) => p,
                            Err(e) => {
                                log::error!("[REMUX-BG] ffmpeg not found: {}", e);
                                return;
                            }
                        };
                        let mut bg_cmd = TokioCommand::new(&bg_ffmpeg_path);
                        bg_cmd.no_window();
                        let bg_audio_filter = format!("{},asetpts=N/SR/TB", AAC_LAYOUT_FILTER);
                        bg_cmd.args([
                            "-hide_banner", "-loglevel", "warning",
                            "-ignore_unknown",
                            "-fflags", "+genpts+discardcorrupt",
                            "-avoid_negative_ts", "make_zero",
                            "-probesize", "50000000", "-analyzeduration", "50000000",
                            "-i", &bg_input,
                        ]);
                        bg_cmd.args(["-map", &format!("0:{}", bg_vid_idx)]);
                        bg_cmd.args(["-map", &format!("0:{}", bg_aud_idx)]);
                        bg_cmd.args([
                            "-sn",
                            "-c:v", "copy",
                            // Re-encode audio to AAC (not copy) — the source TS may have
                            // overlapping PTS that corrupt stream copy. Re-encoding + asetpts
                            // guarantees monotonically increasing timestamps.
                            "-c:a", "aac", "-b:a", "192k",
                            // AAC_LAYOUT_FILTER chained before asetpts (single -af)
                            // to avoid the MSE-breaking PCE on non-standard layouts.
                            "-af", &bg_audio_filter,
                            // Output MPEG-TS (NOT MP4) to match the serving Content-Type
                            // (video/mp2t) and the Strategy A output format. The previous
                            // -f mp4 + -movflags +faststart produced an MP4 file served as
                            // video/mp2t → mpegts.js parse failure on second play.
                        ]);
                        bg_cmd.args(build_mpegts_muxer_args());
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

            // PROXIMITY GUARD (random-access hover thumbnails): a covering
            // download whose CURRENT progress is far behind read_start — e.g. a
            // sequential PROACTIVE fill sitting at ~72MB while this thumbnail
            // needs ~534MB — cannot crawl to our range before the client's 10s
            // abort. Subscribing to it just guarantees the observed
            // "[FMP4-SEG] Timeout waiting for download to reach read_start"
            // and the hover thumbnail never renders. find_best_covering_download
            // matches on the download's DECLARED start/end (which for PROACTIVE
            // is ~EOF), not its live progress, so it happily returns that
            // far-behind download. Do a targeted own-download of just this GOP
            // instead. (Only fmp4-seg needs this — the /stream sequential path
            // genuinely benefits from riding a covering download.)
            // Binding constraint is the FRONTEND's 10s segment-fetch abort (not
            // the 20s backend wait). A targeted own-download starts AT read_start
            // and fetches a gap-independent ~read_len (~2.7MB), so riding a
            // covering download only wins when it's about to reach us anyway
            // (gap of a chunk or two). 4MB ≈ 8s @ 500KB/s leaves margin under 10s.
            const MAX_CATCHUP_DISTANCE: u64 = 4 * 1024 * 1024;
            let initial_progress = *progress_rx.borrow();
            if read_start > initial_progress
                && read_start - initial_progress > MAX_CATCHUP_DISTANCE
            {
                log::info!(
                    "[FMP4-SEG] covering download too far behind for msg {} (progress={} read_start={}, gap={}MB) — targeted own-download",
                    message_id, initial_progress, read_start,
                    (read_start - initial_progress) / 1024 / 1024
                );
                need_own_download = true;
            }

            while !need_own_download {
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
                let (media, _) = match resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &StreamQuery { token: query.token.clone(), cached_only: Some(false), cached_prefix: None, duration: None, source_id: None, remux_seek: None, max_bytes: None, ss: None, start_byte: None, hevc_ok: None, audio_idx: None, playhead_byte: None, subs_seek_anchor: None }).await {
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
                        let _permit = match data.download_semaphore.acquire().await { Ok(p) => p, Err(_) => { log::error!("[FMP4] download semaphore closed"); break; } };
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

                            // Record Telegram network bytes for the speed meter
                            cache_mgr.add_downloaded_bytes(message_id, bytes_in_chunk);

                            let _ = cache_file.seek(SeekFrom::Start(offset));
                            let _ = cache_file.write_all(&final_data);

                            let _lock = cache_mgr.lock_meta(message_id).await;
                            let mut m = cache_mgr.load_meta(message_id).unwrap_or(CacheMeta {
                                message_id,
                                folder_id: canonical_folder_key(&folder_id_str),
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
    // MEMO: the DocumentAttributeVideo lookup below calls get_messages_by_id (an
    // uncached, unthrottled API call). The frontend retries /fmp4/metadata up to
    // 6× waiting for the ffprobe duration, so this fired 6× per cold start — even
    // for files with no video attrs (returns the same result every time). The raw
    // message attributes are immutable per file; reuse the memoized outcome.
    let telegram_dur_memo = data.telegram_durations.read().await.get(&message_id).copied();
    if let Some(memo) = telegram_dur_memo {
        telegram_duration = memo;
        if memo.is_some() {
            log::info!("[FMP4-META] msg {} reusing memoized Telegram duration={:.1}s (skipping get_messages_by_id)", message_id, memo.unwrap());
        }
    } else {
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
                            // MEMO a GENUINE outcome (message fetched + attrs read).
                            data.telegram_durations.write().await.insert(message_id, Some(dur));
                        } else {
                            log::warn!("[FMP4-META] msg {} extract_video_attrs_from_raw_msg returned None — message type or document attributes don't contain Video", message_id);
                            // MEMO the genuine "no video attrs" outcome so retries stop
                            // re-calling get_messages_by_id. NOT cached for transient
                            // failures (no client / peer / fetch error) below — those must
                            // stay retryable so a later-connected client can resolve them.
                            data.telegram_durations.write().await.insert(message_id, None);
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
    //
    // MEMO SHORT-CIRCUIT: the tail-PTS path below downloads the last 512KB from
    // Telegram to read the final video PTS. That value is immutable for a given
    // file, but the frontend retries /fmp4/metadata up to 6× (waiting for the
    // ffprobe duration), and the tail-reuse gate checks for the last 10MB cached
    // while the tail path only writes back 512KB — so every retry re-downloaded
    // the tail over the rate-limited pipe during cold start. If we already
    // computed the tail PTS once, reuse it and skip the download entirely.
    let memoized_tail_pts = data.tail_pts_durations.read().await.get(&message_id).copied();
    let pts_duration: Option<f64> = if telegram_duration.is_some() {
        None
    } else if let Some(memo) = memoized_tail_pts.filter(|d| *d > 0.0) {
        log::info!("[FMP4-META] msg {} reusing memoized tail PTS duration={:.1}s (skipping tail download)", message_id, memo);
        Some(memo)
    } else {
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
                                                let _permit = match data.download_semaphore.acquire().await { Ok(p) => p, Err(_) => { log::error!("[FMP4] download semaphore closed"); break; } };
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
                                                    // Record Telegram network bytes for the speed meter
                                                    cache_mgr.add_downloaded_bytes(message_id, slice.len() as u64);
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

                                                    // MEMO: store the tail-derived PTS duration so
                                                    // subsequent /fmp4/metadata calls (the frontend
                                                    // retries up to 6×) short-circuit at the block
                                                    // head above instead of re-downloading the tail
                                                    // over the rate-limited Telegram pipe.
                                                    data.tail_pts_durations.write().await.insert(message_id, dur);

                                                    // Also cache the tail data for reuse by streaming
                                                    {
                                                        let _lock4 = cache_mgr.lock_meta(message_id).await;
                                                        let mut meta2 = cache_mgr.load_meta(message_id).unwrap_or_else(|| CacheMeta {
                                                            message_id,
                                                            folder_id: i64::MIN,
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
    };

    // Prefer the exact duration resolved by the /remux ffprobe pass if available.
    // For HEVC MKV the Telegram/PTS/bitrate estimates below are wrong (e.g. 1904s
    // vs a real 2317s), which truncates the seek bar and mis-maps every seek. The
    // probe writes state.probed_durations; when present it is authoritative.
    let probed_duration_opt = data.probed_durations.read().await.get(&message_id).copied();

    let duration_s = if let Some(d) = probed_duration_opt.filter(|d| *d > 0.0) {
        log::info!("[FMP4-META] msg {} using ffprobe duration={:.1}s (from /remux probe)", message_id, d);
        d
    } else if let Some(d) = telegram_duration {
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
    let duration_is_probed = probed_duration_opt.filter(|d| *d > 0.0).is_some();

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
        duration_is_estimate: !duration_is_probed,
    };

    let body = match serde_json::to_vec(&response) {
        Ok(b) => b,
        Err(e) => {
            log::error!("[FMP4-META] Failed to serialize metadata for msg {}: {}", message_id, e);
            return HttpResponse::InternalServerError().body("Failed to serialize metadata");
        }
    };

    // Cache the result — but ONLY when the duration is authoritative (from the
    // /remux ffprobe). Caching an early bitrate ESTIMATE would lock the seek bar
    // to a wrong length: the metadata fetch fires ~2s before the probe completes,
    // so an estimate cached here is served forever on subsequent HITs. When we
    // only have an estimate, skip the cache so a later fetch (after the probe) can
    // return the real value. (duration_is_probed computed above.)
    if duration_is_probed {
        if let Ok(mut c) = metadata_cache.0.lock() {
            c.cache.insert(message_id, body.clone());
        }
    } else {
        log::info!("[FMP4-META] msg {} duration is an estimate ({:.1}s) — NOT caching so a post-probe fetch can correct it", message_id, duration_s);
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

/// Shared HDR flags for the hover-thumbnail endpoint, keyed by message_id.
/// Populated by the /remux probe (which already ffprobes color metadata);
/// read by /thumb so single-frame grabs know whether to tonemap without
/// paying for their own HDR probe. Missing entry = assume SDR (worst case:
/// washed-out 228px preview, never a failure).
fn thumb_hdr_map() -> &'static StdMutex<HashMap<i32, bool>> {
    static MAP: std::sync::OnceLock<StdMutex<HashMap<i32, bool>>> = std::sync::OnceLock::new();
    MAP.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// Per-message hover-thumbnail serialization + in-flight time markers.
/// One ffmpeg per message at a time; a second hover while one is running
/// returns 429 so the frontend retry loop (which polls desiredHoverTimeRef)
/// naturally coalesces to the LATEST hover position.
fn thumb_inflight() -> &'static StdMutex<std::collections::HashSet<i32>> {
    static SET: std::sync::OnceLock<StdMutex<std::collections::HashSet<i32>>> = std::sync::OnceLock::new();
    SET.get_or_init(|| StdMutex::new(std::collections::HashSet::new()))
}

/// Server-side hover thumbnail for /remux-tier files (HEVC and anything else
/// the client can't decode: no WebCodecs/MSE HEVC in stock WebView2).
///
/// `GET /thumb/{folder}/{message}?token=..&t=SECONDS[&w=228]`
///
/// Decodes exactly ONE frame with ffmpeg `-ss T` BEFORE `-i`:
///   - Input is the local cache file when the byte region for T is already
///     cached (fast path, no network), otherwise the local /stream HTTP
///     endpoint — ffmpeg Range-requests only the moov + the GOP around T,
///     so UNBUFFERED parts of the video work without downloading the file.
///   - `-ss` before `-i` uses the demuxer index (verified 9-14x realtime over
///     HTTP tail-moov during research) and decodes from the previous keyframe,
///     so the frame is exact, VBR-proof, and needs no byte↔time mapping.
///   - HDR sources get the same verified tonemap chain as /remux (is_hdr is
///     stashed by the /remux probe; missing = SDR).
///
/// Edge cases handled: concurrent hovers (429 + per-message serialization),
/// t clamped to [0, duration), zero-size/unprobed files (400), ffmpeg failure
/// or empty output (502 with stderr tail logged), 15s hard timeout (504),
/// dead-client cleanup via kill_on_drop.

/// List the real audio streams of a media file for the track-selection menu.
///
/// Runs the same fast ffprobe pass as /remux (5MB/5s budget, guarded full
/// re-probe when nothing is found) over the cached file or the local /stream
/// endpoint, and returns JSON:
///   `{ "tracks": [AudioStreamInfo...], "primary_idx": <i32> }`
/// Results are memoized per message_id (stream layout is immutable), so only
/// the first call pays the probe cost.
#[get("/audio_tracks/{folder_id}/{message_id}")]
async fn audio_tracks_list(
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();
    if let Err(resp) = resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &query).await {
        return resp;
    }

    // Memo hit → serve without probing.
    if let Some(json) = data.audio_tracks_json.read().await.get(&message_id) {
        return HttpResponse::Ok().content_type("application/json").body(json.clone());
    }

    // Input source: whole-file cache when complete, else local /stream URL
    // (same resolution logic as /remux).
    let mut input_source = format!(
        "http://127.0.0.1:{}/stream/{}/{}?token={}&source_id=tracks",
        crate::STREAM_PORT, folder_id_str, message_id,
        query.token.as_deref().unwrap_or("")
    );
    if let Some(ref cache_mgr) = **cache {
        let data_path = cache_mgr.data_path(message_id);
        let fully_cached = {
            let _lock = cache_mgr.lock_meta(message_id).await;
            cache_mgr.load_meta(message_id).map(|m| {
                let total: u64 = m.cached_ranges.iter().map(|r| r.1 - r.0 + 1).sum();
                total >= m.total_size.saturating_sub(1)
            }).unwrap_or(false)
        };
        if fully_cached && data_path.exists() {
            input_source = data_path.to_string_lossy().to_string();
        }
    }

    let ffprobe_path = match crate::ffmpeg_util::ensure_ffprobe() {
        Ok(p) => p,
        Err(e) => return HttpResponse::InternalServerError().body(format!("ffprobe not found: {}", e)),
    };

    // Fast probe first; full re-probe only when no audio found (mirrors /remux).
    let mut probe = run_stream_probe(&ffprobe_path, &input_source, "5000000", "5000000", message_id).await;
    if probe.audio_streams.is_empty() {
        let full = run_stream_probe(&ffprobe_path, &input_source, "50000000", "50000000", message_id).await;
        if full.audio_streams.len() > probe.audio_streams.len() {
            probe = full;
        }
    }

    let body = match serde_json::to_string(&serde_json::json!({
        "tracks": probe.audio_streams,
        "primary_idx": if probe.found_audio { probe.audio_stream_idx } else { -1 },
    })) {
        Ok(b) => b,
        Err(e) => return HttpResponse::InternalServerError().body(format!("serialize failed: {}", e)),
    };
    // Memoize only non-empty inventories: an early/partial probe of a barely
    // cached file could legitimately see no audio yet.
    if !probe.audio_streams.is_empty() {
        data.audio_tracks_json.write().await.insert(message_id, body.clone());
    }
    HttpResponse::Ok().content_type("application/json").body(body)
}

// ══════════════════ Embedded subtitle endpoints ══════════════════

/// Per-message subtitle-extraction serialization. One ffmpeg per message at a
/// time (two tracks extracting concurrently would each pull the whole file
/// over /stream); a duplicate request gets 429 + Retry-After and the client
/// retries briefly.
/// Round-10 P2-2: keyed by (folder, message, stream_idx) — NOT message alone.
/// A message-only key made requesting track 3 while track 2 extracted return 429,
/// so a multi-track file could dead-end in the UI (the frontend drops the click
/// while a fetch is live, so the user just saw nothing happen). Per-TRACK
/// serialisation still prevents duplicate work on the same track, which is the
/// only case that actually wastes an ffmpeg run.
fn subs_inflight() -> &'static StdMutex<std::collections::HashSet<(i64, i32, i32)>> {
    static SET: std::sync::OnceLock<StdMutex<std::collections::HashSet<(i64, i32, i32)>>> = std::sync::OnceLock::new();
    SET.get_or_init(|| StdMutex::new(std::collections::HashSet::new()))
}

fn subs_promotion_inflight() -> &'static StdMutex<std::collections::HashSet<(i64, i32)>> {
    static SET: std::sync::OnceLock<StdMutex<std::collections::HashSet<(i64, i32)>>> = std::sync::OnceLock::new();
    SET.get_or_init(|| StdMutex::new(std::collections::HashSet::new()))
}

fn subs_promotion_generations() -> &'static StdMutex<HashMap<(i64, i32), u64>> {
    static MAP: std::sync::OnceLock<StdMutex<HashMap<(i64, i32), u64>>> = std::sync::OnceLock::new();
    MAP.get_or_init(|| StdMutex::new(HashMap::new()))
}

struct SubtitlePromotionGuard { key: (i64, i32) }

impl Drop for SubtitlePromotionGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = subs_promotion_inflight().lock() {
            active.remove(&self.key);
        }
    }
}

pub(crate) fn maybe_spawn_complete_subtitle_promotion(
    cache_mgr: StreamCacheManager,
    message_id: i32,
) -> bool {
    let meta = match cache_mgr.load_meta(message_id) {
        Some(meta) if meta.is_complete() => meta,
        _ => return false,
    };
    let canonical_folder = canonical_stored_folder_key(meta.folder_id);
    let key = (canonical_folder, message_id);
    let promotion_generation = subs_promotion_generations().lock().ok()
        .and_then(|generations| generations.get(&key).copied()).unwrap_or(0);
    {
        let mut active = match subs_promotion_inflight().lock() {
            Ok(active) => active,
            Err(_) => return false,
        };
        if !should_promote_complete_subtitles(true, active.contains(&key)) {
            return false;
        }
        active.insert(key);
    }
    tokio::spawn(async move {
        let _promotion_guard = SubtitlePromotionGuard { key };
        let result = promote_complete_subtitles(
            cache_mgr.clone(), meta, canonical_folder, promotion_generation,
        ).await;
        match result {
            Ok(count) => log::info!("[SUBS-FINALIZE] msg {}: published {} complete text track(s)", message_id, count),
            Err(e) => log::warn!("[SUBS-FINALIZE] msg {}: {}", message_id, e),
        }
    });
    true
}

async fn promote_complete_subtitles(
    cache_mgr: StreamCacheManager,
    meta: CacheMeta,
    canonical_folder: i64,
    promotion_generation: u64,
) -> Result<usize, String> {
    if !meta.is_complete() {
        return Err("media cache is not complete".into());
    }
    let input = cache_mgr.data_path(meta.message_id);
    let input_str = input.to_string_lossy().to_string();
    let ffprobe = crate::ffmpeg_util::ensure_ffprobe().map_err(|e| e.to_string())?;
    let probe = TokioCommand::new(ffprobe)
        .no_window()
        .args(["-hide_banner", "-loglevel", "error", "-print_format", "json", "-show_streams", &input_str])
        .output().await.map_err(|e| format!("ffprobe spawn failed: {}", e))?;
    if !probe.status.success() {
        return Err("ffprobe failed on complete local media".into());
    }
    let inv = parse_subtitle_probe_json(&String::from_utf8_lossy(&probe.stdout));
    let text_tracks: Vec<_> = inv.tracks.into_iter().filter(|t| t.kind == "text").collect();
    if text_tracks.is_empty() {
        return Ok(0);
    }
    let cache_opt = Some(cache_mgr.clone());
    let mut outputs = Vec::new();
    for track in text_tracks {
        let ass = track.codec == "ass" || track.codec == "ssa";
        let final_path = durable_sub_cache_path(
            &cache_opt, canonical_folder, meta.message_id, track.index, meta.total_size, ass,
        );
        if std::fs::metadata(&final_path).map(|m| m.len() > 0).unwrap_or(false) {
            continue;
        }
        if let Some(parent) = final_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("subtitle cache mkdir failed: {}", e))?;
        }
        let ext = if ass { "ass" } else { "srt" };
        let tmp = final_path.with_extension(format!("tmp.{}", ext));
        outputs.push((track.index, ass, tmp, final_path));
    }
    if outputs.is_empty() {
        return Ok(0);
    }
    let args_tracks: Vec<_> = outputs.iter().map(|(idx, ass, tmp, _)| {
        (*idx, *ass, tmp.to_string_lossy().to_string())
    }).collect();
    let ffmpeg = crate::ffmpeg_util::ensure_ffmpeg().map_err(|e| e.to_string())?;
    let mut command = TokioCommand::new(ffmpeg);
    command.no_window();
    command.args(build_all_sub_extract_args(&input_str, &args_tracks))
        .kill_on_drop(true);
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(30 * 60), command.output(),
    ).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("ffmpeg spawn failed: {}", e)),
        Err(_) => {
            for (_, _, tmp, _) in &outputs { let _ = std::fs::remove_file(tmp); }
            return Err("ffmpeg timed out after 30 minutes".into());
        }
    };
    if !output.status.success() {
        for (_, _, tmp, _) in &outputs { let _ = std::fs::remove_file(tmp); }
        return Err(format!("ffmpeg failed with status {:?}", output.status.code()));
    }
    if !cache_mgr.load_meta(meta.message_id).is_some_and(|current| current.is_complete() && current.total_size == meta.total_size) {
        for (_, _, tmp, _) in &outputs { let _ = std::fs::remove_file(tmp); }
        return Err("media cache was discarded or changed during finalization".into());
    }
    let key = (canonical_folder, meta.message_id);
    let generations = subs_promotion_generations().lock()
        .map_err(|_| "subtitle promotion generation lock poisoned".to_string())?;
    if !should_publish_complete_subtitles(
        generations.get(&key).copied().unwrap_or(0), promotion_generation,
    ) {
        drop(generations);
        for (_, _, tmp, _) in &outputs { let _ = std::fs::remove_file(tmp); }
        return Err("subtitle promotion superseded by cache deletion".into());
    }
    let mut published = 0;
    for (_, _, tmp, final_path) in outputs {
        if std::fs::metadata(&tmp).map(|m| m.len() > 0).unwrap_or(false) {
            std::fs::rename(&tmp, &final_path)
                .map_err(|e| format!("subtitle publish failed: {}", e))?;
            published += 1;
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    }
    drop(generations);
    Ok(published)
}

pub(crate) fn invalidate_durable_subtitles(
    cache_mgr: &StreamCacheManager,
    folder_key: i64,
    message_id: i32,
) {
    let folder_key = canonical_stored_folder_key(folder_key);
    let key = (folder_key, message_id);
    if let Ok(mut generations) = subs_promotion_generations().lock() {
        let next = generations.get(&key).copied().unwrap_or(0).wrapping_add(1);
        generations.insert(key, next);
        let path = durable_subs_root(&Some(cache_mgr.clone()))
            .join(folder_key.to_string())
            .join(message_id.to_string());
        if path.exists() { let _ = std::fs::remove_dir_all(path); }
    }
}

/// Resolve the ffmpeg/ffprobe input for a subtitle operation: the local cache
/// file when the WHOLE file is cached (fastest: no HTTP, no Telegram), else
/// our own /stream endpoint with `source_id=subs` so the download coordinator
/// never confuses subtitle reads with the player's stream.
fn subs_input_source(
    folder_id: &str,
    message_id: i32,
    token: &str,
    cache: &Option<StreamCacheManager>,
) -> String {
    if let Some(ref cache_mgr) = *cache {
        if let Some(meta) = cache_mgr.load_meta(message_id) {
            if meta.is_complete() {
                return cache_mgr.data_path(message_id).to_string_lossy().to_string();
            }
        }
    }
    format!(
        "http://127.0.0.1:{}/stream/{}/{}?token={}&source_id=subs",
        crate::STREAM_PORT, folder_id, message_id, token
    )
}

/// Round-13 R-3: memo key for a partial subtitle extraction — it must describe
/// WHAT THE EXTRACTION READS.
///
/// The key used to be `contiguous_prefix_end` alone: the contiguous run from byte
/// 0. That is the quantity round-10 already proved is the wrong bound for island
/// extraction, and it barely moves during playback (the downloader fetches around
/// the playhead, not from byte 0). Observed in 13-t, the key sat at 48,234,496 B
/// = 274 s while the viewer was at 5171 s, so the second extraction hit the memo
/// and replayed a stale 263-byte body —
///
/// ```text
/// [SUBS] msg 109 s3: cache frontier unchanged at 48234496B
///        — replaying memoized partial result (263B)
/// ```
///
/// — even though the island for playhead 3598 s (byte 628,163,769) and the one
/// for 5171 s (byte ~911,457,038) are completely different reads. The island fix
/// was being silently cancelled by a round-9 cache.
///
/// Island mode therefore keys on the span. Hashed rather than XOR-folded because
/// `s ^ (e << 1)` collides for distinct spans, and a collision here replays cues
/// from the wrong region of the file — precisely the bug being fixed. The prefix
/// path keeps the original frontier-only semantics.
pub(crate) fn subs_memo_key(island: Option<(u64, u64)>, frontier: u64) -> u64 {
    match island {
        Some((s, e)) => {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            (s, e).hash(&mut h);
            h.finish()
        }
        None => frontier,
    }
}

/// Round-10b: minimum island size. An island smaller than one MKV cluster
/// yields ZERO cues — ffmpeg logs `Truncating packet of size N to M` and emits
/// nothing (verified: a 100 KB island of a file whose clusters are ~1 MB).
/// 2 MiB comfortably exceeds a cluster in every real release profile.
pub(crate) const SUBS_ISLAND_MIN_BYTES: u64 = 2 * 1024 * 1024;

/// Round-10b: build a stitched `header ++ island` MKV on disk and return its
/// path, for extracting subtitles near the playhead from a partially-cached file.
///
/// WHY A FILE AND NOT AN HTTP BODY: round-10 served the stitched bytes from
/// `/stream`, which broke the Range contract — a request for `bytes=N-` returned
/// the bytes at offset 0, so ffmpeg's matroska demuxer resynced forward 660 B at
/// a time, 444 times, re-reading ~10 MiB each pass (4.34 GiB total) and produced
/// zero cues. A real file has real offsets, so that failure mode cannot occur:
/// verified 1 open / 0 seeks / 100 % read once.
///
/// Cluster timestamps in MKV are ABSOLUTE, so a mid-file island still self-locates
/// once the header supplies EBML/Info/Tracks/CodecPrivate. Requires `-copyts` on
/// the ffmpeg side or the output stage rebases every cue toward zero.
///
/// Returns `Some((path, island_start, island_end))` when island mode applies —
/// the span is returned so the caller can key the partial-result memo on WHAT WAS
/// READ (round-13 R-3). `None` means island mode declined and the caller must
/// fall back to the existing prefix-bounded HTTP path.
fn build_subs_island_file(
    cache: &Option<StreamCacheManager>,
    folder_id: &str,
    message_id: i32,
    stream_idx: i32,
    playhead_byte: u64,
) -> Option<(std::path::PathBuf, u64, u64)> {
    let cache_mgr = cache.as_ref()?;
    let meta = cache_mgr.load_meta(message_id)?;
    let data_path = cache_mgr.data_path(message_id);

    // The header must be cached from byte 0 or there is nothing to anchor the
    // island to. 1 MiB is far more than any real MKV header (5,827 B observed).
    const HEADER_SCAN: u64 = 1024 * 1024;
    let prefix_end = crate::stream_cache::contiguous_prefix_end(&meta.cached_ranges);
    let scan_len = prefix_end.min(HEADER_SCAN);
    if scan_len == 0 {
        return None;
    }
    let header = {
        let mut f = std::fs::File::open(&data_path).ok()?;
        use std::io::Read;
        let mut buf = vec![0u8; scan_len as usize];
        f.read_exact(&mut buf).ok()?;
        buf
    };
    // Non-MKV containers (TS/MP4) never match the Cluster ID, so they fall back.
    let cluster_off = find_first_mkv_cluster(&header)? as u64;

    let (isl_start_raw, isl_end) = pick_subs_island(&meta.cached_ranges, playhead_byte, cluster_off)?;
    if isl_end <= isl_start_raw {
        return None;
    }
    // An island must contain at least one FULLY-BOUNDED MKV cluster or ffmpeg
    // emits zero cues (it discards a lone partial cluster on resync). The 2 MiB
    // byte floor is a cheap PROXY for that — but it is only a proxy, and it was
    // rejecting near-miss islands that plainly hold whole clusters (observed:
    // 1.81 MB and 1.998 MB islands declined, leaving the viewer with NO
    // subtitles after those seeks). When the span is under the byte floor, fall
    // back to measuring the real invariant: count cluster markers in the island
    // window. Two markers bracket at least one complete cluster. The extra read
    // happens ONLY on the sub-floor branch (rare, and by definition < 2 MiB), so
    // the main path keeps its zero-I/O fast admit and cannot regress.
    let span = isl_end - isl_start_raw + 1;
    if span < SUBS_ISLAND_MIN_BYTES {
        let probe = {
            let mut f = std::fs::File::open(&data_path).ok()?;
            f.seek(SeekFrom::Start(isl_start_raw)).ok()?;
            use std::io::Read;
            let mut buf = vec![0u8; span as usize];
            f.read_exact(&mut buf).ok()?;
            buf
        };
        let clusters = count_mkv_clusters(&probe);
        if clusters < 2 {
            log::info!(
                "[SUBS-ISLAND] msg {} s{}: island {}-{} is {}B < {}B floor and holds {} cluster marker(s) (<2, no whole cluster) — falling back to prefix",
                message_id, stream_idx, isl_start_raw, isl_end,
                span, SUBS_ISLAND_MIN_BYTES, clusters
            );
            return None;
        }
        log::info!(
            "[SUBS-ISLAND] msg {} s{}: island {}-{} is {}B < {}B floor but holds {} cluster markers — admitting on the cluster invariant",
            message_id, stream_idx, isl_start_raw, isl_end,
            span, SUBS_ISLAND_MIN_BYTES, clusters
        );
    }

    // Snap the island start DOWN to a cluster boundary when one is nearby.
    // The WHY, the measurement that proves it, and the degrade contract all live
    // on `snap_island_start_to_cluster` — which is pure and unit-tested, so a
    // future cleanup that deletes it breaks a test instead of silently losing
    // cues (round-14 F5).
    let isl_start = {
        const ALIGN_SCAN: u64 = 512 * 1024;
        let scan_from = isl_start_raw;
        let scan_to = (isl_start_raw + ALIGN_SCAN).min(isl_end);
        let mut buf = vec![0u8; (scan_to - scan_from) as usize];
        let read_ok = (|| -> std::io::Result<()> {
            let mut f = std::fs::File::open(&data_path)?;
            f.seek(SeekFrom::Start(scan_from))?;
            use std::io::Read;
            f.read_exact(&mut buf)?;
            Ok(())
        })().is_ok();
        if read_ok {
            snap_island_start_to_cluster(&buf, scan_from)
        } else {
            isl_start_raw
        }
    };

    let isl_len = isl_end - isl_start + 1;
    let island = {
        let mut f = std::fs::File::open(&data_path).ok()?;
        f.seek(SeekFrom::Start(isl_start)).ok()?;
        use std::io::Read;
        let mut buf = vec![0u8; isl_len as usize];
        f.read_exact(&mut buf).ok()?;
        buf
    };

    // Unique per (folder, message, track, island) + a nonce, so concurrent
    // extractions for different tracks can never collide on the same path.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = subs_cache_dir(cache).join(format!(
        "island_{}_{}_s{}_{}_{}.mkv",
        folder_id.replace(['/', '\\', ':'], "_"),
        message_id, stream_idx, isl_start, nonce
    ));
    {
        use std::io::Write;
        let mut out = std::fs::File::create(&path).ok()?;
        out.write_all(&header[..cluster_off as usize]).ok()?;
        out.write_all(&island).ok()?;
        out.flush().ok()?;
    } // handle closed HERE, before ffmpeg opens it — no os-32 overlap window.

    log::info!(
        "[SUBS-ISLAND] msg {} s{}: temp file {} = header 0-{} ({}B) + island {}-{} ({}B) for playhead byte {}",
        message_id, stream_idx, path.display(), cluster_off, cluster_off,
        isl_start, isl_end, isl_len, playhead_byte
    );
    Some((path, isl_start, isl_end))
}

/// Subtitle disk-cache dir (`{remux_dir}/subs`), created on demand.
fn subs_cache_dir(cache: &Option<StreamCacheManager>) -> std::path::PathBuf {
    let base = if let Some(ref cache_mgr) = *cache {
        cache_mgr.cache_dir().join("remux")
    } else {
        std::path::PathBuf::from(std::env::var("TEMP").unwrap_or_else(|_| "/tmp".into()))
            .join("nobuf_remux")
    };
    let dir = base.join("subs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Run the memoized subtitle/font inventory probe for one file.
/// Returns the parsed inventory (memo hit skips the ffprobe entirely).
async fn probe_sub_tracks(
    folder_id: &str,
    message_id: i32,
    token: &str,
    data: &web::Data<Arc<TelegramState>>,
    cache: &web::Data<Option<StreamCacheManager>>,
) -> Result<SubProbeResult, HttpResponse> {
    // Round-10 P0-3: key the memo by (folder, message). Telegram message_id is
    // unique only within a peer, so keying by message_id alone served folder A's
    // TRACK LISTING for folder B's same-id message — the media cache already
    // fixed this class ("channel A's msg 18 poison channel B's msg 18").
    // i64::MIN is the established sentinel for the me/home/null folder.
    let folder_key = canonical_folder_key(folder_id);
    if let Some(json) = data.sub_tracks_json.read().await.get(&(folder_key, message_id)) {
        // Memo stores the serialized SubProbeResult verbatim.
        if let Ok(parsed) = serde_json::from_str::<SubProbeResult>(json) {
            return Ok(parsed);
        }
    }

    let ffprobe_path = match crate::ffmpeg_util::ensure_ffprobe() {
        Ok(p) => p,
        Err(e) => {
            return Err(HttpResponse::InternalServerError().body(format!("ffprobe not found: {}", e)))
        }
    };
    let input_source = {
        let source = subs_input_source(folder_id, message_id, token, cache);
        if source.starts_with("http") {
            format!("{}&cached_prefix=true", source)
        } else {
            source
        }
    };

    // Header-only probe: stream declarations (incl. subs + attachments) live in
    // the MKV Track header / MP4 moov — 5MB budget is enough even on partially
    // cached files (verified P11 in subs-execution-bytecost).
    let probe_output = TokioCommand::new(&ffprobe_path)
        .no_window()
        .args([
            "-hide_banner", "-loglevel", "error",
            "-print_format", "json",
            "-show_streams",
            "-probesize", "5000000", "-analyzeduration", "5000000",
            &input_source,
        ])
        .output()
        .await;

    let result = match probe_output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Reviewer advisory: distinguish "ffprobe genuinely saw zero
            // subtitle streams" from "exit 0 but unusable output" — memoizing
            // the latter would hide subtitles for the whole app session.
            let has_streams = serde_json::from_str::<serde_json::Value>(&stdout)
                .ok()
                .map(|v| v.get("streams").and_then(|s| s.as_array()).map(|a| !a.is_empty()).unwrap_or(false))
                .unwrap_or(false);
            if !has_streams {
                log::warn!("[SUBS] msg {}: ffprobe exit 0 but no parseable streams — not memoizing", message_id);
                return Err(HttpResponse::BadGateway().body("subtitle probe returned no streams"));
            }
            parse_subtitle_probe_json(&stdout)
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!(
                "[SUBS] msg {}: ffprobe failed: {}",
                message_id, stderr.trim()
            );
            return Err(HttpResponse::BadGateway().body("subtitle probe failed"));
        }
        Err(e) => {
            log::warn!("[SUBS] msg {}: ffprobe spawn failed: {}", message_id, e);
            return Err(HttpResponse::InternalServerError().body(format!("ffprobe spawn failed: {}", e)));
        }
    };

    // Memoize (including empty inventories: "no subs" is the common permanent
    // case, and the header probe sees stream declarations even on partially
    // cached files — unlike the audio partial-probe race).
    if let Ok(json) = serde_json::to_string(&result) {
        data.sub_tracks_json.write().await.insert((folder_key, message_id), json);
    }
    Ok(result)
}

/// List the embedded subtitle tracks + font attachments of a media file.
///
/// `GET /subtitles/{folder}/{message}/list?token=..`
/// → `{ "tracks": [SubTrackInfo...], "fonts": [FontAttachmentInfo...] }`
///
/// One header-only ffprobe per file (memoized on TelegramState like
/// /audio_tracks). Bitmap tracks (PGS/VobSub/DVB) are listed with
/// kind="bitmap" so the UI can grey them out; only kind="text" tracks are
/// extractable via the /track endpoint.
#[get("/subtitles/{folder_id}/{message_id}/list")]
async fn subtitles_list(
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();
    if let Err(resp) = resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &query).await {
        return resp;
    }
    let token = query.token.as_deref().unwrap_or("");
    match probe_sub_tracks(&folder_id_str, message_id, token, &data, &cache).await {
        Ok(inv) => match serde_json::to_string(&inv) {
            Ok(body) => HttpResponse::Ok().content_type("application/json").body(body),
            Err(e) => HttpResponse::InternalServerError().body(format!("serialize failed: {}", e)),
        },
        Err(resp) => resp,
    }
}

/// OpenSubtitles "moviehash" of a Telegram-hosted file.
///
/// `GET /subtitles/{folder}/{message}/moviehash?token=..`
/// → `{ "hash": "aadb7fe9e2ac6a4f", "size": 9465305 }`
/// → 422 when the file is empty (nothing to identify)
///
/// Why this exists: OpenSubtitles matches releases by the bytes of the file, not its
/// name, and Telegram filenames are frequently `video_2024-01-15_12-34-56.mp4` — a
/// text search on that returns nothing useful. The hash needs only the FIRST and
/// LAST 64 KiB.
///
/// Cost: it goes through `download_and_cache_range`, which serves from the disk
/// cache when the bytes are already present. The head 64 KiB is the init segment
/// every playback tier reads first, so on a file that has started playing this is
/// usually free; the 64 KiB tail may be a real fetch on tiers that never read it.
/// Either way it is ~128 KiB worst case, and the ranges land in the shared cache
/// where playback can reuse them.
#[get("/subtitles/{folder_id}/{message_id}/moviehash")]
async fn subtitles_moviehash(
    path: web::Path<(String, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();
    let (media, total_size) =
        match resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &query).await {
            Ok(v) => v,
            Err(resp) => return resp,
        };

    let Some((head_off, tail_off, len)) =
        crate::commands::opensubtitles::movie_hash_ranges(total_size)
    else {
        return HttpResponse::UnprocessableEntity().body("empty file has no moviehash");
    };

    let Some(cache_mgr) = cache.get_ref().as_ref() else {
        return HttpResponse::ServiceUnavailable().body("stream cache unavailable");
    };

    // Two ranges, sequential rather than concurrent: download_and_cache_range holds
    // the session semaphore, and issuing both at once would contend with playback.
    let mut chunks: Vec<Vec<u8>> = Vec::with_capacity(2);
    for offset in [head_off, tail_off] {
        let end = offset + len as u64 - 1;
        match download_and_cache_range(
            message_id,
            offset,
            end,
            total_size,
            &media,
            cache_mgr,
            &data,
        )
        .await
        {
            Ok(bytes) => chunks.push(bytes),
            Err(e) => {
                log::warn!(
                    "[MOVIEHASH] msg {} range {}..{} failed: {}",
                    message_id,
                    offset,
                    end,
                    e
                );
                return HttpResponse::BadGateway().body(format!("range fetch failed: {}", e));
            }
        }
    }

    let hash = crate::commands::opensubtitles::movie_hash(total_size, &chunks[0], &chunks[1]);
    log::info!(
        "[MOVIEHASH] msg {} size={} hash={} (head {} B + tail {} B)",
        message_id,
        total_size,
        hash,
        chunks[0].len(),
        chunks[1].len()
    );
    HttpResponse::Ok()
        .content_type("application/json")
        .body(format!("{{\"hash\":\"{}\",\"size\":{}}}", hash, total_size))
}

/// Extract ONE embedded text subtitle track as SRT (or byte-faithful ASS).
///
/// `GET /subtitles/{folder}/{message}/track/{stream_idx}?token=..`
/// → 200 `text/plain; charset=utf-8` + `X-Subs-Format: ass|srt`
///   (+ `X-Subs-Partial: 1` when extracted from a partially-cached file)
/// → 204 when the track legitimately has zero cues
/// → 404 for a non-text/absent stream_idx; 429 while another extraction for
///   the same message runs; 502/504 on ffmpeg failure/timeout.
///
/// Edge cases handled (subs research): absolute-index -map (never `?` maps —
/// F1: a trailing-? map emitted the WRONG track), one `-sub_charenc latin1`
/// retry on the mislabeled-UTF8 signature (E9c), whole-track policy (mid-file
/// -ss over HTTP is pathological — P6: 2.16x file size), partial-cache
/// extraction serves-but-doesn't-cache (P8), deterministic disk cache under
/// {remux_dir}/subs keyed by stream index.
#[get("/subtitles/{folder_id}/{message_id}/track/{stream_idx}")]
async fn subtitles_extract_track(
    path: web::Path<(String, i32, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
) -> impl Responder {
    let (folder_id_str, message_id, stream_idx) = path.into_inner();
    // Round-10 P0-3: total folder key for the in-memory subs caches. Same
    // sentinel convention as the media cache (see resolve_media_from_path):
    // i64::MIN stands in for the me/home/null folder so the key is total.
    let folder_key = canonical_folder_key(&folder_id_str);
    let sq = StreamQuery {
        token: query.token.clone(), cached_only: None, cached_prefix: None, duration: None,
        source_id: None, remux_seek: None, max_bytes: None, ss: None, start_byte: None, hevc_ok: None,
        audio_idx: None, playhead_byte: None, subs_seek_anchor: None,
    };
    let resolved_total_size = match resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &sq).await {
        Ok((_, total_size)) => total_size,
        Err(resp) => return resp,
    };
    let token = query.token.as_deref().unwrap_or("");

    // Complete artifacts are source-sized and identity-keyed, so they can be
    // served before ffprobe. This keeps reopen/cache-hit playback local even
    // though the disposable stream-cache and in-memory inventory were cleared.
    for (ass, format_hdr) in [(false, "srt"), (true, "ass")] {
        let durable = durable_sub_cache_path(
            &cache, folder_key, message_id, stream_idx, resolved_total_size, ass,
        );
        if let Ok(bytes) = tokio::fs::read(&durable).await {
            if !bytes.is_empty() {
                return HttpResponse::Ok()
                    .content_type("text/plain; charset=utf-8")
                    .insert_header(("X-Subs-Format", format_hdr))
                    .insert_header(("X-Subs-Coverage", "full"))
                    .insert_header(("Cache-Control", "max-age=86400"))
                    .body(bytes);
            }
        }
    }

    // Validate against the (memoized) probe: must be a TEXT subtitle stream.
    let inv = match probe_sub_tracks(&folder_id_str, message_id, token, &data, &cache).await {
        Ok(inv) => inv,
        Err(resp) => return resp,
    };
    let track = match inv.tracks.iter().find(|t| t.index == stream_idx) {
        Some(t) if t.kind == "text" => t.clone(),
        Some(_) => {
            return HttpResponse::NotFound()
                .content_type("application/json")
                .body(r#"{"error":"not a text subtitle stream"}"#)
        }
        None => {
            return HttpResponse::NotFound()
                .content_type("application/json")
                .body(r#"{"error":"no such subtitle stream"}"#)
        }
    };
    let ass = track.codec == "ass" || track.codec == "ssa";
    let format_hdr = if ass { "ass" } else { "srt" };

    let durable_path = durable_sub_cache_path(
        &cache, folder_key, message_id, stream_idx, resolved_total_size, ass,
    );

    // Per-TRACK serialization (round-10 P2-2: was per-message, which 429'd a
    // second track and dead-ended the UI).
    let inflight_key = (folder_key, message_id, stream_idx);
    {
        let mut set = match subs_inflight().lock() {
            Ok(s) => s,
            Err(_) => return HttpResponse::InternalServerError().body("lock poisoned"),
        };
        if !set.insert(inflight_key) {
            return HttpResponse::TooManyRequests()
                .insert_header(("Retry-After", "2"))
                .body("Subtitle extraction already in progress");
        }
    }
    struct SubsInflightGuard((i64, i32, i32));
    impl Drop for SubsInflightGuard {
        fn drop(&mut self) {
            if let Ok(mut s) = subs_inflight().lock() {
                s.remove(&self.0);
            }
        }
    }
    let _guard = SubsInflightGuard(inflight_key);

    let ffmpeg_path = match crate::ffmpeg_util::ensure_ffmpeg() {
        Ok(p) => p,
        Err(e) => return HttpResponse::InternalServerError().body(format!("ffmpeg unavailable: {}", e)),
    };

    // Whether the file is fully cached decides input AND cacheability of the
    // result: a partial extraction must NOT be cached (more cues may appear
    // as the cache fills).
    let fully_cached = cache
        .as_ref()
        .as_ref()
        .and_then(|m| m.load_meta(message_id))
        .map(|m| m.is_complete())
        .unwrap_or(false);

    // Round-9 I-5: frontier gate for partial extraction. The bounded input ends
    // at the contiguous-from-0 frontier, so with the SAME frontier ffmpeg reads
    // identical bytes and produces an identical result — replay the memo instead
    // (9-*: frontier frozen at 32MiB by the mediabunny seed while playback
    // cached 561M+ far ranges; both retries produced the same "647 chars
    // partial"). X-Subs-Unchanged tells the frontend the cache front hasn't
    // advanced. Fully-cached files never consult the memo.
    let current_frontier = if fully_cached {
        0
    } else {
        cache
            .as_ref()
            .as_ref()
            .and_then(|m| m.load_meta(message_id))
            .map(|m| crate::stream_cache::contiguous_prefix_end(&m.cached_ranges))
            .unwrap_or(0)
    };
    // Round-10b: island TEMP FILE, built BEFORE the memo gate (round-13 R-3) so
    // the memo can be keyed on the island actually read. A stitched local file
    // has real byte offsets, so it cannot violate the Range contract the way
    // round-10's sparse HTTP body did (444 resync requests, 4.34 GiB, zero cues).
    //
    // ONLY the extractor gets this. The ffprobe track listing and the font dump
    // share subs_input_source and MUST stay unbounded: stream declarations and
    // attachments live in the header region, so an island would hide subtitle
    // tracks from the picker and break font extraction outright.
    let remux_anchor = data.remux_seek_anchors.read().await.get(&message_id).copied();
    let effective_playhead_byte = resolve_authoritative_subs_playhead_byte(
        query.playhead_byte, remux_anchor, query.subs_seek_anchor, resolved_total_size,
    );
    if effective_playhead_byte != query.playhead_byte {
        log::info!("[SUBS-ISLAND] msg {} s{}: frontend byte {:?} -> authoritative remux byte {:?}", message_id, stream_idx, query.playhead_byte, effective_playhead_byte);
    }
    let island: Option<(std::path::PathBuf, u64, u64)> = if fully_cached {
        None
    } else {
        effective_playhead_byte.and_then(|pb| {
            build_subs_island_file(&cache, &folder_id_str, message_id, stream_idx, pb)
        })
    };
    let island_tmp: Option<std::path::PathBuf> = island.as_ref().map(|(p, _, _)| p.clone());

    // Round-16: island mode declined and we are about to fall back to the cached
    // PREFIX — but the prefix is the opening of the film. Handing it to the
    // extractor while the viewer is 33 minutes in returns the opening credits'
    // cues (16-t:388-401: first 67 s served for a viewer at 2014 s, 957 B of
    // useless ASS). Report "nothing yet for this region" instead of confidently
    // returning the wrong one; the repair loop retries as the cache fills.
    //
    // `X-Subs-Partial` keeps the frontend on its existing partial path, so this
    // reuses the shipped retry/backoff behaviour rather than inventing an error.
    if island.is_none() && !fully_cached {
        // One cluster of grace: cues legitimately run slightly ahead of the playhead.
        const PREFIX_COVERAGE_GRACE_BYTES: u64 = SUBS_ISLAND_MIN_BYTES;
        if !prefix_covers_playhead(effective_playhead_byte, current_frontier, PREFIX_COVERAGE_GRACE_BYTES) {
            let island_progress = subs_island_progress_bytes(&cache, message_id, effective_playhead_byte);
            log::info!(
                "[SUBS-ISLAND] msg {} s{}: no usable island and prefix ends at {}B while playhead is {}B \
                 — declining rather than extracting the wrong region",
                message_id, stream_idx, current_frontier,
                effective_playhead_byte.unwrap_or(0)
            );
            let mut response = HttpResponse::NoContent();
            response.insert_header(("X-Subs-Partial", "1"));
            if let Some(bytes) = island_progress {
                response.insert_header(("X-Subs-Island-Bytes", bytes.to_string()));
            }
            if let Some(cache_mgr) = cache.as_ref().as_ref() {
                if cache_mgr.has_proactive_task(message_id).await {
                    response.insert_header(("X-Subs-Island-Filling", "1"));
                }
            }
                // Round-17: the frontend's breaker has a growth-reset arm
                // (useMSEPlayer.ts:912) that was dead code because the call site
                // passed `null` — it had no byte-accurate frontier to pass. The
                // server computes exactly that number and used to discard it.
                // Emitting it turns "declined" into "declined, and here is how far
                // the cache had actually got", which is what lets the client tell
                // "bytes are still arriving" from "genuinely broken".
            response.insert_header(("X-Subs-Frontier", current_frontier.to_string()));
            return response.finish();
        }
    }

    // Round-10b: RAII cleanup. The extractor has six return arms below; a Drop
    // guard covers every one of them (and a panic) without six easy-to-miss
    // remove_file calls. Deletion happens after ffmpeg's child has exited, so
    // there is no writer/reader overlap and no os-32 SHARING_VIOLATION window.
    // A failed delete is non-fatal — the recursive startup purge sweeps orphans.
    struct IslandTmpGuard(Option<std::path::PathBuf>);
    impl Drop for IslandTmpGuard {
        fn drop(&mut self) {
            if let Some(ref p) = self.0 {
                if let Err(e) = std::fs::remove_file(p) {
                    log::debug!("[SUBS-ISLAND] temp cleanup skipped for {}: {}", p.display(), e);
                }
            }
        }
    }
    let _island_guard = IslandTmpGuard(island_tmp.clone());

    // Round-13 R-3: the memo key must describe WHAT THE EXTRACTION READS.
    //
    // It used to be `contiguous_prefix_end` alone — the contiguous run from byte
    // 0. That is exactly the quantity round-10 proved is the wrong bound for
    // island extraction, and it barely moves during playback (the downloader
    // fetches around the playhead, not from byte 0). Observed in 13-t: the key
    // sat at 48,234,496 B = 274s while the viewer was at 5171s, so the second
    // extraction hit the memo and replayed a stale 263-byte body —
    //
    //   [SUBS] msg 109 s3: cache frontier unchanged at 48234496B
    //          — replaying memoized partial result (263B)
    //
    // — even though the island for playhead 3598s (byte 628163769) and the one
    // for 5171s (byte ~911457038) are completely different reads. The island fix
    // was being silently cancelled by a round-9 cache.
    //
    // Keying on (island_start, island_end) when island mode is active means a
    // different island is always a different key, so it always re-extracts. The
    // prefix path keeps the original frontier-only semantics unchanged.
    let memo_key = subs_memo_key(island.as_ref().map(|(_, s, e)| (*s, *e)), current_frontier);
    if !fully_cached {
        if let Some(mgr) = cache.as_ref().as_ref() {
            if let Some((body, fmt)) = mgr.subs_partial_memo_get(folder_key, message_id, stream_idx, ass, memo_key) {
                log::info!(
                    "[SUBS] msg {} s{}: identical input (memo key {}) — replaying memoized partial result ({}B)",
                    message_id, stream_idx, memo_key, body.len()
                );
                if body.is_empty() {
                    let mut resp = HttpResponse::NoContent();
                    resp.insert_header(("X-Subs-Partial", "1"));
                    resp.insert_header(("X-Subs-Unchanged", "1"));
                    resp.insert_header(("X-Subs-Frontier", current_frontier.to_string()));
                    return resp.finish();
                }
                return HttpResponse::Ok()
                    .content_type("text/plain; charset=utf-8")
                    .insert_header(("X-Subs-Format", fmt))
                    .insert_header(("X-Subs-Partial", "1"))
                    .insert_header(("X-Subs-Unchanged", "1"))
                    .insert_header(("X-Subs-Frontier", current_frontier.to_string()))
                    .body(body);
            }
        }
    }
    let input_source = if let Some(ref p) = island_tmp {
        p.to_string_lossy().to_string()
    } else {
        let mut src = subs_input_source(&folder_id_str, message_id, token, &cache);
        // Round-3 (review R1): bound the extraction input to the cached prefix.
        // The body serves disk bytes and ENDS at the frontier — ffmpeg finalizes
        // every cue parsed so far (exit 0) and the response rides the existing
        // X-Subs-Partial path below. Only the extract call site gets this param:
        // probe (EOF SeekHead) and font reads share subs_input_source and must
        // stay unbounded.
        if !fully_cached && src.starts_with("http") {
            // serde Option<bool> parses "true"/"false" ONLY — "=1" 400s the whole
            // query (round-4 regression, 4-t.md:239).
            src.push_str("&cached_prefix=true");
        }
        src
    };
    // Round-10 P0-2: partial-ness is a property of WHAT WE SERVED, decided here
    // and BEFORE ffmpeg runs — never sniffed from ffmpeg's stderr prose.
    //
    // The old guard was `!fully_cached || stderr.contains("ended prematurely")`.
    // That substring only appears for the SIMPLE TRUNCATION shape. Verified by
    // execution on three fixtures: truncated-at-frontier emits "File ended
    // prematurely" (matches), but a cluster-0-less region and a header+tail
    // stitch both emit "... invalid as first byte of an EBML number" (NO match).
    // So any sparse/islanded input whose file happens to be fully cached would
    // be judged COMPLETE and its incomplete body renamed into the permanent
    // on-disk cache — and the disk-hit at the top of this handler returns that
    // body forever with no validation. Permanently wrong subtitles.
    //
    // `served_whole_file` is the ONLY promotion authority. The stderr check stays
    // as a belt-and-braces OR-term (it still catches a truncated response on a
    // file we believed was complete) but is no longer load-bearing.
    let served_whole_file = fully_cached;
    let subs_dir = subs_cache_dir(&cache);
    let tmp_path = subs_dir.join(format!(
        "{}.tmp",
        sub_cache_filename(&folder_id_str, message_id, stream_idx, ass)
    ));
    let tmp_str = tmp_path.to_string_lossy().to_string();

    // Extraction with one latin1 retry on the mislabeled-charset signature.
    let started = std::time::Instant::now();
    let mut attempt_latin1 = false;
    let output = loop {
        let args = build_sub_extract_args(&input_source, stream_idx, ass, attempt_latin1, &tmp_str);
        let mut cmd = TokioCommand::new(&ffmpeg_path);
        cmd.no_window();
        cmd.args(args.iter().map(|s| s.as_str()));
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());
        cmd.stdin(std::process::Stdio::null());
        cmd.kill_on_drop(true);

        let out = match tokio::time::timeout(std::time::Duration::from_secs(120), cmd.output()).await {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => {
                let _ = tokio::fs::remove_file(&tmp_path).await;
                log::error!("[SUBS] msg {} s{}: ffmpeg spawn failed: {}", message_id, stream_idx, e);
                return HttpResponse::InternalServerError().body(format!("ffmpeg spawn failed: {}", e));
            }
            Err(_) => {
                let _ = tokio::fs::remove_file(&tmp_path).await;
                log::warn!("[SUBS] msg {} s{}: extraction timed out after 120s", message_id, stream_idx);
                return HttpResponse::GatewayTimeout().body("Subtitle extraction timed out");
            }
        };
        if out.status.success() {
            break out;
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !attempt_latin1 && stderr.contains("Invalid UTF-8") {
            // Mislabeled legacy charset (E9b) — retry once with -sub_charenc.
            log::info!("[SUBS] msg {} s{}: invalid UTF-8, retrying with latin1", message_id, stream_idx);
            attempt_latin1 = true;
            continue;
        }
        let tail: String = stderr.chars().rev().take(300).collect::<String>().chars().rev().collect();
        log::warn!(
            "[SUBS] msg {} s{}: ffmpeg failed (status={:?}): {}",
            message_id, stream_idx, out.status.code(), tail.trim()
        );
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return HttpResponse::BadGateway().body("Subtitle extraction failed");
    };

    let text = match tokio::fs::read(&tmp_path).await {
        Ok(t) => t,
        Err(e) => {
            log::warn!("[SUBS] msg {} s{}: output read failed: {}", message_id, stream_idx, e);
            return HttpResponse::BadGateway().body("Subtitle extraction produced no output");
        }
    };

    // exit 0 + empty output = legitimate zero-cue track (E14-redo): 204, and
    // do NOT cache (a partially-cached file may yield cues later). Round-3:
    // when the input was prefix-bounded, tag the 204 as partial so the frontend
    // can say "no cues in the downloaded portion YET" and allow a later retry.
    if text.is_empty() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        log::info!("[SUBS] msg {} s{}: track has no cues (204{})", message_id, stream_idx,
            if fully_cached { "" } else { ", partial input" });
        let mut resp = HttpResponse::NoContent();
        if !fully_cached {
            resp.insert_header(("X-Subs-Partial", "1"));
            resp.insert_header(("X-Subs-Frontier", current_frontier.to_string()));
            // Round-9 I-5: memoize the empty partial result at this frontier so
            // identical retries replay instead of re-running ffmpeg.
            if let Some(mgr) = cache.as_ref().as_ref() {
                mgr.subs_partial_memo_store(folder_key, message_id, stream_idx, ass, memo_key, Vec::new(), format_hdr.to_string());
            }
        }
        return resp.finish();
    }

    // Round-10 P0-2: promotion authority is `served_whole_file` (decided from the
    // byte set we served, above), NOT ffmpeg's stderr prose. The stderr term is
    // retained only as a belt-and-braces extra reason to withhold promotion —
    // it can add `partial`, never remove it. See the comment at served_whole_file
    // for the three-fixture evidence that stderr sniffing is blind to sparse and
    // stitched inputs.
    let stderr = String::from_utf8_lossy(&output.stderr);
    let partial = !served_whole_file || stderr.contains("ended prematurely");
    // Round-10 P2-3: resurrection guard. Mirrors the round-9 I-3b prior art in
    // commands/streaming.rs:736-742 — a discard cancels the transfer BEFORE
    // deleting meta, so any write that lands afterwards resurrects a cache the
    // user just discarded. The subs path had no equivalent: a completing
    // extraction would create_dir_all the subs dir back, rename into it, and
    // re-store a memo that delete_cache had already cleared. If the .dat is gone,
    // the bytes this body was derived from are gone too — serve it once, persist
    // nothing.
    let cache_vanished = cache
        .as_ref()
        .as_ref()
        .map(|m| m.load_meta(message_id).is_none())
        .unwrap_or(false);
    if cache_vanished {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        log::info!(
            "[SUBS] msg {} s{}: cache discarded during extraction — serving without persisting (no resurrection)",
            message_id, stream_idx
        );
        let mut resp = HttpResponse::Ok();
        resp.content_type("text/plain; charset=utf-8")
            .insert_header(("X-Subs-Format", format_hdr))
            .insert_header(("X-Subs-Partial", "1"))
            .insert_header(("X-Subs-Frontier", current_frontier.to_string()));
        return resp.body(text);
    }
    if partial {
        let _ = tokio::fs::remove_file(&tmp_path).await;
    } else {
        if let Some(parent) = durable_path.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                log::warn!("[SUBS] msg {} s{}: durable cache mkdir failed: {}", message_id, stream_idx, e);
            }
        }
        if let Err(e) = tokio::fs::rename(&tmp_path, &durable_path).await {
            log::warn!("[SUBS] msg {} s{}: durable cache publish failed: {}", message_id, stream_idx, e);
            let _ = tokio::fs::remove_file(&tmp_path).await;
        }
    }

    log::info!(
        "[SUBS] msg {} s{} ({}): {}B in {:.1}s (src={}, cached={})",
        message_id, stream_idx, format_hdr, text.len(), started.elapsed().as_secs_f32(),
        if input_source.starts_with("http") { "stream" } else { "cache" },
        !partial
    );

    let mut resp = HttpResponse::Ok();
    resp.content_type("text/plain; charset=utf-8")
        .insert_header(("X-Subs-Format", format_hdr));
    if partial {
        resp.insert_header(("X-Subs-Partial", "1"));
        // Round-9 I-5: memoize the partial body at this frontier so identical
        // retries replay instead of re-running ffmpeg on identical input.
        if let Some(mgr) = cache.as_ref().as_ref() {
            mgr.subs_partial_memo_store(folder_key, message_id, stream_idx, ass, memo_key, text.clone(), format_hdr.to_string());
        }
    } else {
        resp.insert_header(("Cache-Control", "max-age=86400"));
    }
    resp.body(text)
}

/// Serve ONE font attachment (for jassub) from an MKV.
///
/// `GET /subtitles/{folder}/{message}/font/{att_idx}?token=..`
/// → 200 with the font bytes (probed mimetype, font/ttf fallback)
/// → 404 when att_idx is not a known font attachment.
#[get("/subtitles/{folder_id}/{message_id}/font/{att_idx}")]
async fn subtitles_font(
    path: web::Path<(String, i32, i32)>,
    query: web::Query<StreamQuery>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
) -> impl Responder {
    let (folder_id_str, message_id, att_idx) = path.into_inner();
    let sq = StreamQuery {
        token: query.token.clone(), cached_only: None, cached_prefix: None, duration: None,
        source_id: None, remux_seek: None, max_bytes: None, ss: None, start_byte: None, hevc_ok: None,
        audio_idx: None, playhead_byte: None, subs_seek_anchor: None,
    };
    if let Err(resp) = resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &sq).await {
        return resp;
    }
    let token = query.token.as_deref().unwrap_or("");

    let inv = match probe_sub_tracks(&folder_id_str, message_id, token, &data, &cache).await {
        Ok(inv) => inv,
        Err(resp) => return resp,
    };
    let font = match inv.fonts.iter().find(|f| f.index == att_idx) {
        Some(f) => f.clone(),
        None => {
            return HttpResponse::NotFound()
                .content_type("application/json")
                .body(r#"{"error":"no such font attachment"}"#)
        }
    };
    let mime = if font.mimetype.is_empty() { "font/ttf".to_string() } else { font.mimetype.clone() };

    let subs_dir = subs_cache_dir(&cache);
    let cache_path = subs_dir.join(sub_font_cache_filename(&folder_id_str, message_id, att_idx));
    if let Ok(bytes) = tokio::fs::read(&cache_path).await {
        if !bytes.is_empty() {
            return HttpResponse::Ok()
                .content_type(mime)
                .insert_header(("Cache-Control", "max-age=86400"))
                .body(bytes);
        }
    }

    let ffmpeg_path = match crate::ffmpeg_util::ensure_ffmpeg() {
        Ok(p) => p,
        Err(e) => return HttpResponse::InternalServerError().body(format!("ffmpeg unavailable: {}", e)),
    };
    let input_source = subs_input_source(&folder_id_str, message_id, token, &cache);
    let tmp_path = subs_dir.join(format!(
        "{}.tmp",
        sub_font_cache_filename(&folder_id_str, message_id, att_idx)
    ));
    let tmp_str = tmp_path.to_string_lossy().to_string();

    // Attachments live in the MKV header — this is a cheap header read even
    // over /stream (verified E12/X5). 60s cap covers slow uncached headers.
    let args = build_font_dump_args(&input_source, att_idx, &tmp_str);
    let mut cmd = TokioCommand::new(&ffmpeg_path);
    cmd.no_window();
    cmd.args(args.iter().map(|s| s.as_str()));
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());
    cmd.kill_on_drop(true);

    let output = match tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return HttpResponse::InternalServerError().body(format!("ffmpeg spawn failed: {}", e));
        }
        Err(_) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return HttpResponse::GatewayTimeout().body("Font extraction timed out");
        }
    };

    let bytes = match tokio::fs::read(&tmp_path).await {
        Ok(b) if !b.is_empty() => b,
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!(
                "[SUBS] msg {} font f{}: dump failed (status={:?}): {}",
                message_id, att_idx, output.status.code(), stderr.trim()
            );
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return HttpResponse::BadGateway().body("Font extraction failed");
        }
    };
    if let Err(e) = tokio::fs::rename(&tmp_path, &cache_path).await {
        log::warn!("[SUBS] msg {} font f{}: cache rename failed: {}", message_id, att_idx, e);
        let _ = tokio::fs::remove_file(&tmp_path).await;
    }

    log::info!("[SUBS] msg {} font f{} ({}): {}B served", message_id, att_idx, font.filename, bytes.len());
    HttpResponse::Ok()
        .content_type(mime)
        .insert_header(("Cache-Control", "max-age=86400"))
        .body(bytes)
}

#[get("/thumb/{folder_id}/{message_id}")]
async fn remux_hover_thumb(
    path: web::Path<(String, i32)>,
    query: web::Query<Fmp4Query>,
    data: web::Data<Arc<TelegramState>>,
    token_data: web::Data<StreamTokenData>,
    cache: web::Data<Option<StreamCacheManager>>,
) -> impl Responder {
    let (folder_id_str, message_id) = path.into_inner();

    // Token check + media resolve (also gives us total_size).
    let sq = StreamQuery {
        token: query.token.clone(), cached_only: None, cached_prefix: None, duration: None,
        source_id: None, remux_seek: None, max_bytes: None, ss: None, start_byte: None, hevc_ok: None,
        audio_idx: None, playhead_byte: None, subs_seek_anchor: None,
    };
    let (_media, total_size) = match resolve_media_from_path(&folder_id_str, message_id, &data, &token_data, &sq).await {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    if total_size == 0 {
        return HttpResponse::BadRequest().body("Unknown file size");
    }

    let t = query.time.unwrap_or(0.0).max(0.0);
    // Clamp to just inside the known duration (if the frontend sent one) so a
    // hover at the very end doesn't make ffmpeg seek past EOF and emit nothing.
    let t = match query.duration {
        Some(d) if d > 1.0 => t.min(d - 0.5),
        _ => t,
    };

    // Per-message serialization: one decode at a time. The hover loop retries,
    // so dropping this request loses nothing.
    {
        let mut set = match thumb_inflight().lock() {
            Ok(s) => s,
            Err(_) => return HttpResponse::InternalServerError().body("lock poisoned"),
        };
        if !set.insert(message_id) {
            return HttpResponse::TooManyRequests()
                .insert_header(("Retry-After", "1"))
                .body("Thumbnail extraction already in progress");
        }
    }
    // Remove the in-flight marker on every exit path.
    struct InflightGuard(i32);
    impl Drop for InflightGuard {
        fn drop(&mut self) {
            if let Ok(mut s) = thumb_inflight().lock() { s.remove(&self.0); }
        }
    }
    let _guard = InflightGuard(message_id);

    // Input: local cache file when the whole file is cached (cheapest),
    // otherwise our own /stream endpoint (Range-seekable; ffmpeg fetches only
    // moov + the GOP around t — works on completely unbuffered regions).
    let mut input_source = format!(
        "http://127.0.0.1:{}/stream/{}/{}?token={}&source_id=thumbnail",
        crate::STREAM_PORT, folder_id_str, message_id,
        query.token.as_deref().unwrap_or("")
    );
    if let Some(ref cache_mgr) = **cache {
        if let Some(meta) = cache_mgr.load_meta(message_id) {
            if meta.is_complete() {
                input_source = cache_mgr.data_path(message_id).to_string_lossy().to_string();
            }
        }
    }

    let is_hdr = thumb_hdr_map().lock().ok()
        .and_then(|m| m.get(&message_id).copied())
        .unwrap_or(false);

    let ffmpeg_path = match crate::ffmpeg_util::ensure_ffmpeg() {
        Ok(p) => p,
        Err(e) => return HttpResponse::InternalServerError().body(format!("ffmpeg unavailable: {}", e)),
    };

    let width = 228u32; // matches THUMBNAIL_WIDTH in useThumbnailExtractor.ts
    let vf = if is_hdr {
        // Same verified chain as /remux transcode, then scale for the preview.
        format!("{},scale={}:-2", build_hdr_tonemap_vf("yuv420p"), width)
    } else {
        format!("scale={}:-2", width)
    };

    let mut cmd = TokioCommand::new(&ffmpeg_path);
    cmd.no_window();
    cmd.args([
        "-hide_banner", "-loglevel", "error",
        "-ss", &format!("{:.3}", t),
        "-i", &input_source,
        "-frames:v", "1",
        "-vf", &vf,
        "-f", "mjpeg", "-q:v", "6",
        "-",
    ]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());
    cmd.kill_on_drop(true);

    let started = std::time::Instant::now();
    let output = match tokio::time::timeout(std::time::Duration::from_secs(15), async {
        cmd.output().await
    }).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            log::error!("[THUMB] msg {}: ffmpeg spawn failed: {}", message_id, e);
            return HttpResponse::InternalServerError().body(format!("ffmpeg spawn failed: {}", e));
        }
        Err(_) => {
            log::warn!("[THUMB] msg {} t={:.1}: ffmpeg timed out after 15s (uncached region on slow network)", message_id, t);
            return HttpResponse::GatewayTimeout().body("Thumbnail extraction timed out");
        }
    };

    if !output.status.success() || output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.chars().rev().take(300).collect::<String>().chars().rev().collect();
        log::warn!("[THUMB] msg {} t={:.1}: ffmpeg produced no frame (status={:?}): {}",
            message_id, t, output.status.code(), tail.trim());
        return HttpResponse::BadGateway().body("Failed to extract frame");
    }

    log::info!("[THUMB] msg {} t={:.1}: {}B JPEG in {:.1}s (hdr={} src={})",
        message_id, t, output.stdout.len(), started.elapsed().as_secs_f32(), is_hdr,
        if input_source.starts_with("http") { "stream" } else { "cache" });

    HttpResponse::Ok()
        .insert_header(("Content-Type", "image/jpeg"))
        .insert_header(("Cache-Control", "max-age=3600"))
        .body(output.stdout)
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
            .expose_headers(STREAMING_CORS_EXPOSED_HEADERS)
            .max_age(3600);

        App::new()
            .wrap(cors)
            .app_data(token_data.clone())
            .app_data(tg_data.clone())
            .app_data(cache_data.clone())
            .configure(|cfg: &mut web::ServiceConfig| {
                // Identity endpoint: returns THIS process's PID. If a probe of
                // 127.0.0.1:port/__whoami shows a different PID than the app the
                // user is running, an impostor process owns the port — that was
                // the only theory left after route registration proved correct.
                cfg.route("/__whoami", web::to(|| async {
                    HttpResponse::Ok().body(format!(
                        "pid={} boot={}",
                        std::process::id(),
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0)
                    ))
                }));
                // Drop-upload route registers UNCONDITIONALLY — its dependencies
                // (AppHandle/BandwidthManager) live in the upload_drop OnceLock,
                // set by lib.rs before this server starts. The previous
                // conditional registration silently skipped in one live session
                // (healthy server + 404), which is exactly what globals prevent.
                cfg.service(crate::commands::upload_drop::upload_drop);
                log::info!("Drop-upload route /upload-drop REGISTERED");
            })
            .service(stream_media)
            .service(stream_media_head)
            .service(remux_ts_to_mp4)
            .service(remux_hover_thumb)
            .service(audio_tracks_list)
            .service(subtitles_list)
            .service(subtitles_moviehash)
            .service(subtitles_extract_track)
            .service(subtitles_font)
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
    // Round-16: actix's DEFAULT client_request_timeout is 5s — the deadline for a
    // client to finish sending its request head. ffmpeg opens /stream as an HTTP
    // client for the background disk remux, and when a seek arrives mid-remux the
    // old process is torn down while the new one (`-ss 2000.153`) is connecting.
    // Under that contention ffmpeg's head lands past the 5s default and actix
    // answers 408 — a status the app never emits itself (16-t:310-316):
    //
    //   [REMUX] ffmpeg (msg 108): HTTP error 408 Request Timeout
    //   [REMUX] msg 108: ffmpeg exited with error ... skipping background remux
    //
    // The user-visible seek still completed, so this looked harmless — but the
    // background remux was skipped, so every later seek on that file re-runs the
    // full transcode instead of hitting the disk cache.
    //
    // 60s is generous for a request HEAD (not the body, which streams for
    // minutes) and does not weaken any real timeout: a stalled client still
    // disconnects, and the handlers keep their own extraction timeouts.
    .client_request_timeout(std::time::Duration::from_secs(60))
    .client_disconnect_timeout(std::time::Duration::from_secs(30))
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
    use actix_web::{test as actix_test, web, App, HttpResponse, http::Method, http::header as actix_header};

    const MIN_BOOTSTRAP: u64 = 5 * 1024 * 1024;

    /// Round-16: the cold-open stall. A subtitle read (`cached_prefix=true`) asks
    /// for the whole file; on a cold cache only 512 KB is present, so the old
    /// code took the `< 5MB bootstrap threshold` arm and queued the request
    /// behind a 1.5 GB Telegram download it would never consume. The request was
    /// still unanswered 35 s later (16-t:79-84).
    #[test]
    fn cold_open_subs_read_does_not_bootstrap() {
        // Exact numbers from 16-t:79-81.
        assert!(
            !super::should_bootstrap_from_telegram(524_287, 0, true, MIN_BOOTSTRAP),
            "a cached_prefix read must serve the prefix and end at the frontier, never bootstrap"
        );
    }

    /// The same request on a warm cache already worked (16-t:543-546). Behaviour
    /// must be identical in both states — that is what proves the prefix reader
    /// never depended on the bootstrap.
    #[test]
    fn warm_open_subs_read_also_does_not_bootstrap() {
        assert!(!super::should_bootstrap_from_telegram(7_340_031, 0, true, MIN_BOOTSTRAP));
    }

    /// A PLAYER with a tiny prefix still bootstraps — it genuinely starves
    /// without contiguous data, and removing that would reintroduce the stall
    /// the threshold was added to prevent.
    #[test]
    fn player_with_tiny_prefix_still_bootstraps() {
        assert!(super::should_bootstrap_from_telegram(524_287, 0, false, MIN_BOOTSTRAP));
    }

    // NOTE: an actix integration test pinning /upload-drop route presence was
    // attempted here and REMOVED: merely referencing commands::upload_drop from
    // server.rs's test module made the whole test binary fail to load
    // (STATUS_ENTRYPOINT_NOT_FOUND, reproducible, cause unresolved). Route
    // presence is guarded at runtime instead: start_streaming_server logs
    // "Drop-upload route REGISTERED" or "SKIPPED (app_handle=…, bandwidth=…)"
    // per worker, and the frontend classifier surfaces a 404 as an explicit
    // "direct-upload route missing" toast.

    #[test]
    fn player_with_enough_prefix_waits_on_cache() {
        assert!(!super::should_bootstrap_from_telegram(7_340_031, 0, false, MIN_BOOTSTRAP));
    }

    /// Nothing cached at/after the offset bootstraps regardless of mode —
    /// there is no prefix to serve, so the prefix reader would return empty.
    #[test]
    fn nothing_cached_bootstraps_in_both_modes() {
        assert!(super::should_bootstrap_from_telegram(0, 1_000_000, true, MIN_BOOTSTRAP));
        assert!(super::should_bootstrap_from_telegram(0, 1_000_000, false, MIN_BOOTSTRAP));
    }

    /// Boundary: exactly the threshold is enough for a player (>= not >).
    #[test]
    fn player_at_exact_threshold_does_not_bootstrap() {
        assert!(!super::should_bootstrap_from_telegram(MIN_BOOTSTRAP - 1, 0, false, MIN_BOOTSTRAP));
        assert!(super::should_bootstrap_from_telegram(MIN_BOOTSTRAP - 2, 0, false, MIN_BOOTSTRAP));
    }

    // ── Round-16: prefix fallback must not serve the wrong region ──────────
    //
    // 16-t:388-401 (msg 108, 250,114 B/s): the island was 1.43 MB — under the
    // 2 MB floor, so declined, correctly. The code then fell back to the cached
    // prefix (0-16,777,216 = the first 67 s) while the viewer sat at byte
    // 503,761,549 = 2014 s. Off by 32.5 minutes; the extractor returned 957 B of
    // opening-credit ASS and the repair loop scored it as real coverage.

    const GRACE: u64 = 2 * 1024 * 1024;

    #[test]
    fn prefix_rejected_when_viewer_is_far_past_it() {
        // The exact numbers from the log.
        assert!(
            !super::prefix_covers_playhead(Some(503_761_549), 16_777_216, GRACE),
            "the first 67s must not be used as subtitle input for a viewer 33 minutes in"
        );
    }

    #[test]
    fn prefix_accepted_when_viewer_is_inside_it() {
        // Same file, viewer 40 s in (byte ~10 MB) with the same 16 MB prefix.
        assert!(super::prefix_covers_playhead(Some(10_000_000), 16_777_216, GRACE));
    }

    #[test]
    fn prefix_accepted_at_open_when_no_playhead_reported() {
        // Extraction fires before playback starts: the prefix is exactly where
        // the viewer is about to be. Rejecting here would break the open path.
        assert!(super::prefix_covers_playhead(None, 16_777_216, GRACE));
    }

    #[test]
    fn prefix_accepted_just_past_frontier_within_grace() {
        // Cues legitimately run slightly ahead of the playhead.
        assert!(super::prefix_covers_playhead(Some(16_777_216 + GRACE), 16_777_216, GRACE));
        assert!(!super::prefix_covers_playhead(Some(16_777_216 + GRACE + 1), 16_777_216, GRACE));
    }

    #[test]
    fn prefix_grace_cannot_overflow() {
        // A saturating add guards a bogus u64::MAX frontier.
        assert!(super::prefix_covers_playhead(Some(u64::MAX), u64::MAX, GRACE));
    }

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

        let app = actix_test::init_service(
            App::new()
                .wrap(cors)
                .route("/test", web::get().to(test_handler))
        ).await;

        let req = actix_test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri("/test")
            .insert_header((actix_header::ORIGIN, "http://localhost:14200"))
            .insert_header((actix_header::ACCESS_CONTROL_REQUEST_METHOD, "GET"))
            .insert_header(("Access-Control-Request-Private-Network", "true"))
            .to_request();

        let resp = actix_test::call_service(&app, req).await;
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

        let app = actix_test::init_service(
            App::new()
                .wrap(cors)
                .route("/test", web::get().to(test_handler))
        ).await;

        let req = actix_test::TestRequest::default()
            .method(Method::OPTIONS)
            .uri("/test")
            .insert_header((actix_header::ORIGIN, "http://localhost:14200"))
            .insert_header((actix_header::ACCESS_CONTROL_REQUEST_METHOD, "GET"))
            .to_request();

        let resp = actix_test::call_service(&app, req).await;
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
            .expose_headers(super::STREAMING_CORS_EXPOSED_HEADERS)
            .allow_private_network_access()
            .max_age(3600);

        let app = actix_test::init_service(
            App::new()
                .wrap(cors)
                .route("/test", web::get().to(test_handler))
        ).await;

        // Use a regular GET request (not OPTIONS) — Expose-Headers only appears in actual responses
        let req = actix_test::TestRequest::default()
            .method(Method::GET)
            .uri("/test")
            .insert_header((actix_header::ORIGIN, "http://localhost:14200"))
            .to_request();

        let resp = actix_test::call_service(&app, req).await;
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
        assert!(lower.contains("x-subs-frontier"), "X-Subs-Frontier must be exposed");
        assert!(lower.contains("x-subs-island-bytes"), "X-Subs-Island-Bytes must be exposed");
        assert!(lower.contains("x-subs-island-filling"), "X-Subs-Island-Filling must be exposed");
    }

    // ========================================================================
    // Remux command construction tests
    // ========================================================================

    /// Build the ffmpeg argument list for Strategy A (cached file → disk remux).
    /// Extracted as a pure function so tests can verify correctness without
    /// spawning ffmpeg or needing a real TS file.
    fn build_strategy_a_args(
        input_source: &str,
        video_stream_idx: i32,
        audio_stream_idx: i32,
    ) -> Vec<String> {
        vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(), "warning".to_string(),
            "-fflags".to_string(), "+genpts+discardcorrupt".to_string(),
            "-avoid_negative_ts".to_string(), "make_zero".to_string(),
            "-i".to_string(), input_source.to_string(),
            "-map".to_string(), format!("0:{}", video_stream_idx),
            "-map".to_string(), format!("0:{}", audio_stream_idx),
            "-c:v".to_string(), "copy".to_string(),
            "-c:a".to_string(), "aac".to_string(), "-b:a".to_string(), "192k".to_string(),
            "-f".to_string(), "mpegts".to_string(),
            "-mpegts_flags".to_string(), "resend_headers".to_string(),
        ]
    }

    /// Build the ffmpeg argument list for the background disk remux.
    /// MUST output MPEG-TS (not MP4) to match the serving Content-Type (video/mp2t).
    fn build_background_remux_args(
        input_source: &str,
        video_stream_idx: i32,
        audio_stream_idx: i32,
    ) -> Vec<String> {
        vec![
            "-hide_banner".to_string(), "-loglevel".to_string(), "warning".to_string(),
            "-ignore_unknown".to_string(),
            "-fflags".to_string(), "+genpts+discardcorrupt".to_string(),
            "-avoid_negative_ts".to_string(), "make_zero".to_string(),
            "-probesize".to_string(), "50000000".to_string(),
            "-analyzeduration".to_string(), "50000000".to_string(),
            "-i".to_string(), input_source.to_string(),
            "-map".to_string(), format!("0:{}", video_stream_idx),
            "-map".to_string(), format!("0:{}", audio_stream_idx),
            "-sn".to_string(),
            "-c:v".to_string(), "copy".to_string(),
            "-c:a".to_string(), "aac".to_string(), "-b:a".to_string(), "192k".to_string(),
            "-af".to_string(), "asetpts=N/SR/TB".to_string(),
            "-f".to_string(), "mpegts".to_string(),
            "-mpegts_flags".to_string(), "resend_headers".to_string(),
        ]
    }

    /// Strategy A must use ffprobe-resolved stream indices, not hardcoded 0:v:0/0:a:0.
    #[test]
    fn strategy_a_uses_ffprobe_stream_indices() {
        let args = build_strategy_a_args("input.ts", 0, 1);
        let map_args: Vec<&String> = args.iter().filter(|a| a.as_str() == "-map").collect();
        assert_eq!(map_args.len(), 2, "Should have exactly 2 -map args");

        // Find the values after -map
        let mut map_values = Vec::new();
        for (i, arg) in args.iter().enumerate() {
            if arg == "-map" {
                map_values.push(args[i + 1].as_str());
            }
        }
        assert!(map_values.contains(&"0:0"), "Should map video stream 0:0");
        assert!(map_values.contains(&"0:1"), "Should map audio stream 0:1");

        // Must NOT contain the old hardcoded values
        assert!(
            !args.iter().any(|a| a == "0:v:0"),
            "Must not use hardcoded 0:v:0"
        );
        assert!(
            !args.iter().any(|a| a == "0:a:0"),
            "Must not use hardcoded 0:a:0"
        );
    }

    /// Strategy A must handle files where audio is at index 2 (id3 stream at index 1).
    #[test]
    fn strategy_a_maps_correct_audio_when_id3_is_first_audio() {
        // File layout: stream 0=video, stream 1=id3(metadata), stream 2=aac(audio)
        // ffprobe should return video_stream_idx=0, audio_stream_idx=2
        let args = build_strategy_a_args("input.ts", 0, 2);
        let mut map_values = Vec::new();
        for (i, arg) in args.iter().enumerate() {
            if arg == "-map" {
                map_values.push(args[i + 1].as_str());
            }
        }
        assert!(map_values.contains(&"0:0"), "Should map video at 0:0");
        assert!(map_values.contains(&"0:2"), "Should map audio at 0:2 (not 0:1 where id3 is)");
    }

    /// Strategy A must output MPEG-TS format (not MP4).
    #[test]
    fn strategy_a_outputs_mpegts_not_mp4() {
        let args = build_strategy_a_args("input.ts", 0, 1);
        let has_mpegts = args.iter().any(|a| a == "mpegts");
        let has_mp4 = args.iter().any(|a| a == "mp4");
        assert!(has_mpegts, "Must output mpegts format");
        assert!(!has_mp4, "Must NOT output mp4 format");
    }

    /// Strategy A must include -avoid_negative_ts make_zero to prevent EINVAL.
    #[test]
    fn strategy_a_includes_avoid_negative_ts() {
        let args = build_strategy_a_args("input.ts", 0, 1);
        let has_avoid = args.iter().any(|a| a == "-avoid_negative_ts");
        assert!(has_avoid, "Must include -avoid_negative_ts to prevent EINVAL muxer error");
        let has_make_zero = args.iter().any(|a| a == "make_zero");
        assert!(has_make_zero, "Must use make_zero mode");
    }

    /// Strategy A must include -fflags +genpts+discardcorrupt.
    #[test]
    fn strategy_a_includes_genpts_discardcorrupt() {
        let args = build_strategy_a_args("input.ts", 0, 1);
        let has_fflags = args.iter().any(|a| a == "-fflags");
        assert!(has_fflags, "Must include -fflags");
        let fflags_val = args.iter()
            .skip_while(|a| a.as_str() != "-fflags")
            .nth(1);
        if let Some(val) = fflags_val {
            assert!(val.contains("genpts"), "Must include +genpts");
            assert!(val.contains("discardcorrupt"), "Must include +discardcorrupt");
        } else {
            panic!("-fflags value not found");
        }
    }

    /// Background remux MUST output MPEG-TS (not MP4) to match serving Content-Type.
    /// This was the root cause of second-play failures: MP4 file served as video/mp2t.
    #[test]
    fn background_remux_outputs_mpegts_not_mp4() {
        let args = build_background_remux_args("input.ts", 0, 1);
        let has_mpegts = args.iter().any(|a| a == "mpegts");
        let has_mp4 = args.iter().any(|a| a == "mp4");
        let has_faststart = args.iter().any(|a| a == "+faststart");
        assert!(has_mpegts, "Background remux MUST output mpegts to match serving Content-Type");
        assert!(!has_mp4, "Background remux must NOT output mp4 — causes format mismatch on second play");
        assert!(!has_faststart, "Background remux must NOT use +faststart (that's MP4-only)");
    }

    /// Background remux must use ffprobe stream indices.
    #[test]
    fn background_remux_uses_ffprobe_indices() {
        let args = build_background_remux_args("input.ts", 0, 2);
        let mut map_values = Vec::new();
        for (i, arg) in args.iter().enumerate() {
            if arg == "-map" {
                map_values.push(args[i + 1].as_str());
            }
        }
        assert!(map_values.contains(&"0:2"), "Should map audio at 0:2");
    }

    /// Background remux must include asetpts filter for timestamp normalization.
    #[test]
    fn background_remux_includes_asetpts() {
        let args = build_background_remux_args("input.ts", 0, 1);
        let has_asetpts = args.iter().any(|a| a == "asetpts=N/SR/TB");
        assert!(has_asetpts, "Background remux must include asetpts filter");
    }

    /// All strategies must NOT use -bsf:a aac_adtstoasc (that's MP4-only, not for MPEG-TS).
    #[test]
    fn background_remux_does_not_use_aac_adtstoasc() {
        let args = build_background_remux_args("input.ts", 0, 1);
        let has_bsf = args.iter().any(|a| a == "aac_adtstoasc");
        assert!(!has_bsf, "aac_adtstoasc is MP4-only; MPEG-TS doesn't need it");
    }

    // ── /remux?ss= seek-arg builders (HEVC/MKV remux-seek path) ──

    #[test]
    fn ss_seek_args_absent_when_no_seek() {
        // ss=0 / negative / NaN → no -ss (initial from-zero remux).
        assert!(super::build_ss_seek_args(0.0).is_empty(), "ss=0 must not emit -ss");
        assert!(super::build_ss_seek_args(-5.0).is_empty(), "negative ss must not emit -ss");
        assert!(super::build_ss_seek_args(f64::NAN).is_empty(), "NaN ss must not emit -ss");
        assert!(super::build_ss_seek_args(f64::INFINITY).is_empty(), "inf ss must not emit -ss");
    }

    #[test]
    fn ss_seek_args_emit_ss_before_input_when_seeking() {
        let args = super::build_ss_seek_args(580.6);
        assert_eq!(args, vec!["-ss".to_string(), "580.600".to_string()],
            "-ss must be emitted with 3-decimal seconds");
    }

    #[test]
    fn ss_seek_args_format_is_three_decimals() {
        // Millisecond precision is enough for a scrub; assert stable formatting.
        assert_eq!(super::build_ss_seek_args(12.0), vec!["-ss".to_string(), "12.000".to_string()]);
        assert_eq!(super::build_ss_seek_args(0.001), vec!["-ss".to_string(), "0.001".to_string()]);
    }

    #[test]
    fn ss_timestamp_args_present_only_when_seeking() {
        // A seek MUST carry -copyts -start_at_zero so output PTS stay absolute
        // (verified: ss=580 → PTS ≈580s with the zero-preload muxer args), which
        // the frontend _dtsBase=0 relies on.
        assert_eq!(
            super::build_ss_timestamp_args(580.0),
            vec!["-copyts".to_string(), "-start_at_zero".to_string()],
            "seek must preserve absolute timestamps"
        );
        // From-zero remux needs neither.
        assert!(super::build_ss_timestamp_args(0.0).is_empty(), "no seek → no -copyts");
        assert!(super::build_ss_timestamp_args(f64::NAN).is_empty(), "NaN → no -copyts");
    }

    #[test]
    fn ss_seek_and_timestamp_args_agree_on_when_to_fire() {
        // Invariant: the two builders must both fire, or both stay silent, for a
        // given ss — otherwise we'd emit -ss without -copyts (PTS rebased to 0,
        // breaking the seek-position mapping) or vice versa.
        for ss in [-1.0, 0.0, 0.001, 12.0, 580.6, f64::NAN, f64::INFINITY] {
            let seek = !super::build_ss_seek_args(ss).is_empty();
            let ts = !super::build_ss_timestamp_args(ss).is_empty();
            assert_eq!(seek, ts, "seek/timestamp arg emission disagree for ss={ss}");
        }
    }

    /// ts_align_byte underpins the BYTE-FORWARD seek: the frontend's linear
    /// time→byte estimate can land mid-packet, and feeding ffmpeg a stream that
    /// begins mid-TS-packet costs it a resync scan. Aligning DOWN to the packet
    /// boundary hands ffmpeg a clean packet start. Must never round UP (that could
    /// skip past the keyframe the estimate targeted).
    #[test]
    fn ts_align_byte_rounds_down_to_packet_boundary() {
        // Standard 188-byte TS.
        assert_eq!(super::ts_align_byte(0, 188), 0, "0 stays 0 (front of file)");
        assert_eq!(super::ts_align_byte(187, 188), 0, "mid first packet → 0");
        assert_eq!(super::ts_align_byte(188, 188), 188, "exact boundary unchanged");
        assert_eq!(super::ts_align_byte(189, 188), 188, "just past boundary → down");
        assert_eq!(super::ts_align_byte(425_710_346, 188), 425_710_346 / 188 * 188);
        // Result is always <= input (never overshoots the target keyframe).
        for b in [1u64, 375, 500_000, 1_000_003, 1_313_957_191] {
            assert!(super::ts_align_byte(b, 188) <= b, "must not round up (b={b})");
            assert_eq!(super::ts_align_byte(b, 188) % 188, 0, "must be 188-aligned (b={b})");
        }
    }

    /// build_output_ts_offset_args shifts the byte-forward output timeline up to
    /// the seek time (fixes the "bars land at ~2s" bug from logs 6/7/8).
    #[test]
    fn output_ts_offset_emits_only_for_positive_finite_seek() {
        assert_eq!(
            super::build_output_ts_offset_args(840.782),
            vec!["-output_ts_offset".to_string(), "840.782".to_string()],
            "positive seek must emit the offset with 3-decimal seconds"
        );
        assert_eq!(super::build_output_ts_offset_args(12.0), vec!["-output_ts_offset".to_string(), "12.000".to_string()]);
        // Non-positive / non-finite → no offset (initial from-zero remux, or the
        // -ss path which is already absolute).
        assert!(super::build_output_ts_offset_args(0.0).is_empty(), "0 → no offset");
        assert!(super::build_output_ts_offset_args(-5.0).is_empty(), "negative → no offset");
        assert!(super::build_output_ts_offset_args(f64::NAN).is_empty(), "NaN → no offset");
        assert!(super::build_output_ts_offset_args(f64::INFINITY).is_empty(), "inf → no offset");
    }

    #[test]
    fn ts_align_byte_supports_m2ts_and_zero_packet() {
        // M2TS = 192-byte packets.
        assert_eq!(super::ts_align_byte(500, 192), 384, "192-aligned");
        assert_eq!(super::ts_align_byte(500, 192) % 192, 0);
        // Defensive: packet_size 0 falls back to 188 (never divide-by-zero).
        assert_eq!(super::ts_align_byte(500, 0), 500 / 188 * 188);
    }

    #[test]
    fn remux_audio_filter_never_uses_asetpts_on_seek() {
        // THE regression guard for the "seek never plays" bug: asetpts=N/SR/TB
        // rebuilds audio PTS from 0, but a seek keeps video absolute via -copyts.
        // The resulting A/V desync stops mpegts.js completing MediaInfo → no play.
        // A seek MUST use aresample (absolute + monotonic), NEVER asetpts.
        let seek = super::build_remux_audio_filter(true);
        assert!(!seek.contains("asetpts"), "seek filter must not reset PTS: {seek}");
        assert!(seek.contains("aresample=async=1"), "seek needs aresample: {seek}");
    }

    #[test]
    fn mpegts_muxer_preserves_source_absolute_timestamps() {
        let args = super::build_mpegts_muxer_args();
        assert_eq!(
            args,
            [
                "-muxdelay", "0",
                "-f", "mpegts",
                "-mpegts_flags", "resend_headers",
            ],
            "the MPEG-TS muxer must not add its default 1.4s preload",
        );
    }

    #[test]
    fn every_remux_producer_uses_the_zero_preload_muxer_args() {
        let source = include_str!("server.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        assert_eq!(
            production.matches(".args(build_mpegts_muxer_args())").count(),
            3,
            "live, fully-cached, and background remux producers must share the timestamp invariant",
        );
        assert_eq!(
            production.matches("\"-f\", \"mpegts\"").count(),
            1,
            "production MPEG-TS format flags must live only in build_mpegts_muxer_args",
        );
    }

    #[test]
    fn remux_seek_filter_puts_aresample_before_layout() {
        // Regression guard for the eac3 5.1(side) spawn-storm: if AAC_LAYOUT_FILTER
        // (aformat) runs BEFORE aresample, a non-allow-listed layout like 5.1(side)
        // makes aresample re-emit a layout aformat rejects → filtergraph dies -22 →
        // empty output → frontend refetch storm. aresample MUST come first so it
        // normalizes (side)/(back) variants into a layout the allow-list accepts.
        let seek = super::build_remux_audio_filter(true);
        let ares = seek.find("aresample").expect("seek needs aresample");
        let afmt = seek.find("aformat").expect("seek needs aformat layout guard");
        assert!(ares < afmt, "aresample must precede aformat on seek: {seek}");
    }

    #[test]
    fn remux_audio_filter_uses_asetpts_when_not_seeking() {
        // From-zero remux: video also starts at 0, so asetpts is correct and
        // guards against overlapping-PTS AAC frames crashing the mpegts muxer.
        let no_seek = super::build_remux_audio_filter(false);
        assert!(no_seek.contains("asetpts=N/SR/TB"), "non-seek needs asetpts: {no_seek}");
        assert!(!no_seek.contains("aresample"), "non-seek must not aresample: {no_seek}");
    }

    #[test]
    fn remux_audio_filter_always_includes_pce_layout_guard() {
        // Both variants MUST include AAC_LAYOUT_FILTER (single -af only) so the
        // PCE channel layout Chromium MSE can't parse is stripped in every case.
        // Non-seek leads with it; seek runs aresample first (see ordering test).
        for is_seek in [true, false] {
            let f = super::build_remux_audio_filter(is_seek);
            assert!(f.contains(super::AAC_LAYOUT_FILTER), "layout guard must be present: {f}");
        }
        assert!(super::build_remux_audio_filter(false).starts_with(super::AAC_LAYOUT_FILTER),
            "non-seek must lead with the layout guard");
    }

    // ── keyframe_search_window (C1: backward-biased VBR keyframe search) ──

    #[test]
    fn keyframe_window_is_backward_biased() {
        // For a mid-file target the window must place the MAJORITY of its bytes
        // BEFORE approx_byte (VBR keyframes sit earlier than the linear estimate).
        let approx = 500_000_000u64;
        let window = 4 * 1024 * 1024u64;
        let total = 1_313_957_192u64;
        let (start, end) = super::keyframe_search_window(approx, window, total, 188);
        assert!(start < approx, "start must be before approx_byte");
        assert!(end >= approx, "end must reach approx_byte");
        let back = approx - start;
        let forward = end - approx;
        assert!(back > forward, "window must be backward-biased: back={back} forward={forward}");
        // 75/25 split (allowing for alignment rounding on the back edge).
        assert!(back >= forward * 2, "back should be ~3x forward: back={back} forward={forward}");
    }

    #[test]
    fn keyframe_window_is_packet_aligned() {
        // start must round DOWN to a TS packet boundary for both 188 and 192 (m2ts).
        for alignment in [188u64, 192u64] {
            let (start, _end) = super::keyframe_search_window(500_000_123, 4 * 1024 * 1024, 1_000_000_000, alignment);
            assert_eq!(start % alignment, 0, "start must be {alignment}-aligned, got {start}");
        }
    }

    #[test]
    fn keyframe_window_clamps_to_end_of_file() {
        // A target near EOF must clamp `end` to total_size-1, never past it.
        let total = 100_000_000u64;
        let (_start, end) = super::keyframe_search_window(total - 100, 4 * 1024 * 1024, total, 188);
        assert!(end <= total - 1, "end must clamp to total_size-1: end={end} total={total}");
    }

    #[test]
    fn keyframe_window_handles_start_of_file() {
        // approx_byte=0 must not underflow; start stays 0.
        let (start, end) = super::keyframe_search_window(0, 4 * 1024 * 1024, 1_000_000_000, 188);
        assert_eq!(start, 0, "start must be 0 at file head, got {start}");
        assert!(end > 0, "end must extend forward from file head, got {end}");
    }

    #[test]
    fn keyframe_window_total_size_zero_guard() {
        // Degenerate total_size==0 must not panic (underflow on total_size-1).
        let (start, end) = super::keyframe_search_window(0, 4 * 1024 * 1024, 0, 188);
        assert_eq!(start, 0);
        assert_eq!(end, 0, "end must be 0 when total_size is 0");
    }

    #[test]
    fn keyframe_window_zero_alignment_guard() {
        // alignment=0 must be treated as 1 (no divide-by-zero).
        let (start, _end) = super::keyframe_search_window(1000, 512, 1_000_000, 0);
        assert!(start <= 1000);
    }

    // ── keyframe_search_remaining_budget (deadline-first: the bug 2-t exposed) ──
    use std::time::Duration;

    #[test]
    fn budget_returns_remaining_when_ample() {
        // 2s elapsed of an 8s deadline → 6s left, well above the 500ms floor.
        let r = super::keyframe_search_remaining_budget(
            Duration::from_secs(2), Duration::from_secs(8), Duration::from_millis(500));
        assert_eq!(r, Some(Duration::from_secs(6)));
    }

    #[test]
    fn budget_stops_when_past_deadline() {
        // Elapsed beyond the deadline → None (checked_sub underflow guarded).
        let r = super::keyframe_search_remaining_budget(
            Duration::from_secs(9), Duration::from_secs(8), Duration::from_millis(500));
        assert_eq!(r, None, "must not loop once the budget is spent");
    }

    #[test]
    fn budget_stops_when_slice_too_small() {
        // 7.8s elapsed → 200ms left, below the 500ms floor: not worth a round trip.
        let r = super::keyframe_search_remaining_budget(
            Duration::from_millis(7800), Duration::from_secs(8), Duration::from_millis(500));
        assert_eq!(r, None, "sub-min_slice budget must bail to linear fallback");
    }

    #[test]
    fn budget_floor_is_inclusive() {
        // Exactly min_slice remaining is still usable (>= comparison).
        let r = super::keyframe_search_remaining_budget(
            Duration::from_millis(7500), Duration::from_secs(8), Duration::from_millis(500));
        assert_eq!(r, Some(Duration::from_millis(500)));
    }

    // ── parse_probe_json tests (fast-probe / guarded-fallback change) ──
    // These lock the JSON→stream-index contract the fast/full probe both rely on.

    /// Standard Telegram TS: video idx 0, real AAC audio idx 1, sparse id3 idx 2.
    /// Must pick video 0 + audio 1, skip the id3 stream, and read format duration.
    #[test]
    fn probe_json_standard_ts_video0_audio1_id3_skipped() {
        let json = r#"{
            "streams": [
                {"index":0,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p"},
                {"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"channel_layout":"stereo"},
                {"index":2,"codec_type":"data","codec_name":"id3"}
            ],
            "format": {"duration":"2073.019000"}
        }"#;
        let r = super::parse_probe_json(json);
        assert!(r.found_video && r.found_audio);
        assert_eq!(r.video_stream_idx, 0);
        assert_eq!(r.audio_stream_idx, 1);
        assert_eq!(r.video_codec_name, "h264");
        assert_eq!(r.video_pix_fmt, "yuv420p");
        assert_eq!(r.audio_codec_name, "aac");
        assert!((r.probed_duration - 2073.019).abs() < 0.01);
    }

    /// An `audio` stream literally named codec "id3" with 0 channels must NOT be
    /// selected as the audio track (the exact bug the channels>0 && !=id3 guard
    /// prevents — a wrong -map here yields no audio).
    #[test]
    fn probe_json_id3_as_audio_codec_is_skipped() {
        let json = r#"{
            "streams": [
                {"index":0,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p"},
                {"index":1,"codec_type":"audio","codec_name":"id3","channels":0},
                {"index":2,"codec_type":"audio","codec_name":"aac","channels":2,"channel_layout":"stereo"}
            ],
            "format": {"duration":"100.0"}
        }"#;
        let r = super::parse_probe_json(json);
        assert!(r.found_audio, "real aac audio must be found");
        assert_eq!(r.audio_stream_idx, 2, "must skip id3-codec audio and pick the aac at idx 2");
        assert_eq!(r.audio_codec_name, "aac");
    }

    // ── Audio track selection tests (multi-audio + audio_idx override) ──

    /// Dual-audio MKV: ALL real audio streams collected with language/title/
    /// disposition metadata; primary pick unchanged (first real audio).
    #[test]
    fn probe_json_collects_all_audio_streams_with_tags() {
        let json = r#"{
            "streams": [
                {"index":0,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p"},
                {"index":1,"codec_type":"audio","codec_name":"aac","channels":2,"channel_layout":"stereo",
                 "tags":{"language":"jpn","title":"Japanese"},"disposition":{"default":1}},
                {"index":2,"codec_type":"audio","codec_name":"ac3","channels":6,"channel_layout":"5.1",
                 "tags":{"language":"eng"},"disposition":{"default":0}},
                {"index":3,"codec_type":"data","codec_name":"id3"}
            ],
            "format": {"duration":"1200.0"}
        }"#;
        let r = super::parse_probe_json(json);
        assert_eq!(r.audio_streams.len(), 2, "id3/data streams must not be collected");
        assert_eq!(r.audio_stream_idx, 1, "primary pick stays first real audio");
        let a = &r.audio_streams[0];
        assert_eq!((a.index, a.codec.as_str(), a.channels), (1, "aac", 2));
        assert_eq!((a.language.as_str(), a.title.as_str(), a.is_default), ("jpn", "Japanese", true));
        let b = &r.audio_streams[1];
        assert_eq!((b.index, b.codec.as_str(), b.channels), (2, "ac3", 6));
        assert_eq!((b.language.as_str(), b.title.as_str(), b.is_default), ("eng", "", false));
    }

    /// Untagged streams: language/title default to "" and is_default to false.
    #[test]
    fn probe_json_untagged_audio_defaults() {
        let json = r#"{
            "streams": [
                {"index":0,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p"},
                {"index":1,"codec_type":"audio","codec_name":"aac","channels":2}
            ],
            "format": {}
        }"#;
        let r = super::parse_probe_json(json);
        assert_eq!(r.audio_streams.len(), 1);
        let a = &r.audio_streams[0];
        assert_eq!((a.language.as_str(), a.title.as_str(), a.is_default), ("", "", false));
        assert_eq!(a.channel_layout, "");
    }

    /// Override validation: in-list index accepted; out-of-range, non-audio, and
    /// id3 indexes rejected (caller falls back to primary — never a 500).
    #[test]
    fn audio_idx_override_validation() {
        let streams = vec![
            super::AudioStreamInfo {
                index: 1, codec: "aac".into(), channels: 2, channel_layout: "stereo".into(),
                language: "jpn".into(), title: String::new(), is_default: true,
            },
            super::AudioStreamInfo {
                index: 2, codec: "ac3".into(), channels: 6, channel_layout: "5.1".into(),
                language: "eng".into(), title: String::new(), is_default: false,
            },
        ];
        assert_eq!(super::validate_audio_idx_override(Some(2), &streams), Some(2));
        assert_eq!(super::validate_audio_idx_override(Some(1), &streams), Some(1));
        assert_eq!(super::validate_audio_idx_override(Some(0), &streams), None, "video idx must be rejected");
        assert_eq!(super::validate_audio_idx_override(Some(99), &streams), None, "out of range must be rejected");
        assert_eq!(super::validate_audio_idx_override(Some(-1), &streams), None);
        assert_eq!(super::validate_audio_idx_override(None, &streams), None);
        assert_eq!(super::validate_audio_idx_override(Some(1), &[]), None, "empty inventory rejects everything");
    }

    /// Cache keying: default requests keep the LEGACY un-suffixed filename
    /// (existing cache files stay valid); overridden requests get a per-track
    /// suffix so different tracks can never serve each other's output.
    #[test]
    fn remux_cache_filename_keyed_by_audio_track() {
        assert_eq!(super::remux_cache_filename("home", 84, None), "home_84.mp4");
        assert_eq!(super::remux_cache_filename("home", 84, Some(2)), "home_84_a2.mp4");
        assert_eq!(super::remux_cache_filename("123", 7, Some(1)), "123_7_a1.mp4");
        // Distinct tracks → distinct keys; track vs default → distinct keys.
        assert_ne!(
            super::remux_cache_filename("home", 84, Some(1)),
            super::remux_cache_filename("home", 84, Some(2)),
        );
        assert_ne!(
            super::remux_cache_filename("home", 84, Some(1)),
            super::remux_cache_filename("home", 84, None),
        );
    }

    // ══════════════ Embedded subtitle extraction (plan §1.4) ══════════════

    /// Probe JSON → track/font classification: text vs bitmap vs unsupported,
    /// tags, dispositions, and the MP4 mov_text `tags.name` title fallback (E2).
    #[test]
    fn subtitle_probe_classifies_tracks_and_fonts() {
        let json = r#"{
            "streams": [
                {"index":0,"codec_type":"video","codec_name":"h264"},
                {"index":1,"codec_type":"audio","codec_name":"aac","channels":2},
                {"index":2,"codec_type":"subtitle","codec_name":"subrip",
                 "tags":{"language":"eng","title":"English"},
                 "disposition":{"default":1,"forced":0,"hearing_impaired":0}},
                {"index":3,"codec_type":"subtitle","codec_name":"ass",
                 "tags":{"language":"jpn"},
                 "disposition":{"default":0,"forced":1,"hearing_impaired":0}},
                {"index":4,"codec_type":"subtitle","codec_name":"hdmv_pgs_subtitle",
                 "tags":{"language":"ger"},
                 "disposition":{"default":0,"forced":0,"hearing_impaired":1}},
                {"index":5,"codec_type":"subtitle","codec_name":"mov_text",
                 "tags":{"language":"eng","name":"English (from name tag)"},
                 "disposition":{"default":0,"forced":0,"hearing_impaired":0}},
                {"index":6,"codec_type":"attachment","codec_name":"ttf",
                 "tags":{"filename":"font.ttf","mimetype":"application/x-truetype-font"}},
                {"index":7,"codec_type":"attachment","codec_name":"bin",
                 "tags":{"filename":"cover.jpg","mimetype":"image/jpeg"}}
            ]
        }"#;
        let inv = super::parse_subtitle_probe_json(json);

        assert_eq!(inv.tracks.len(), 4, "video/audio/non-font attachments excluded");
        let t2 = &inv.tracks[0];
        assert_eq!((t2.index, t2.codec.as_str(), t2.kind.as_str()), (2, "subrip", "text"));
        assert_eq!((t2.language.as_str(), t2.title.as_str()), ("eng", "English"));
        assert!(t2.is_default && !t2.forced && !t2.hearing_impaired);

        let t3 = &inv.tracks[1];
        assert_eq!((t3.index, t3.kind.as_str()), (3, "text"));
        assert!(t3.forced, "forced disposition must survive");
        assert_eq!(t3.title, "", "absent title stays empty");

        let t4 = &inv.tracks[2];
        assert_eq!(t4.kind, "bitmap", "PGS is listed but marked bitmap");
        assert!(t4.hearing_impaired);

        let t5 = &inv.tracks[3];
        assert_eq!(t5.title, "English (from name tag)", "mov_text falls back to tags.name");

        assert_eq!(inv.fonts.len(), 1, "jpeg attachment is NOT a font");
        assert_eq!(inv.fonts[0].index, 6);
        assert_eq!(inv.fonts[0].filename, "font.ttf");
    }

    /// Malformed / empty probe JSON → empty inventory (never a panic).
    #[test]
    fn subtitle_probe_handles_malformed_json() {
        assert_eq!(super::parse_subtitle_probe_json("not json").tracks.len(), 0);
        assert_eq!(super::parse_subtitle_probe_json("{}").tracks.len(), 0);
        let no_subs = r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"h264"}]}"#;
        let inv = super::parse_subtitle_probe_json(no_subs);
        assert!(inv.tracks.is_empty() && inv.fonts.is_empty());
    }

    /// Kind classification table (E2/E15): every verified text codec extracts,
    /// every bitmap codec is refused, unknown codecs are "unsupported".
    #[test]
    fn subtitle_kind_classification() {
        for c in ["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"] {
            assert_eq!(super::subtitle_kind(c), "text", "{c}");
        }
        for c in ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"] {
            assert_eq!(super::subtitle_kind(c), "bitmap", "{c}");
        }
        assert_eq!(super::subtitle_kind("kate"), "unsupported");
        assert_eq!(super::subtitle_kind(""), "unsupported");
    }

    #[test]
    fn saved_messages_folder_key_is_consistent_across_routes_and_cache_meta() {
        for alias in ["home", "me", "null"] {
            assert_eq!(super::canonical_folder_key(alias), i64::MIN);
        }
        assert_eq!(super::canonical_folder_key("-100123"), -100123);
        assert_eq!(super::canonical_folder_key("invalid"), i64::MIN);
        assert_eq!(super::canonical_stored_folder_key(0), i64::MIN);
        assert_eq!(super::canonical_stored_folder_key(-100123), -100123);
    }

    #[test]
    fn complete_subtitle_publish_requires_current_generation() {
        assert!(super::should_publish_complete_subtitles(7, 7));
        assert!(!super::should_publish_complete_subtitles(8, 7));
    }

    #[test]
    fn cache_deletion_advances_subtitle_promotion_generation() {
        let root = std::env::temp_dir().join(format!("nobuf-sub-gen-{}", std::process::id())).join("stream-cache");
        let mgr = crate::stream_cache::StreamCacheManager::new(root.clone()).unwrap();
        let key = (i64::MIN, 987654321);
        let before = super::subs_promotion_generations().lock().unwrap()
            .get(&key).copied().unwrap_or(0);
        super::invalidate_durable_subtitles(&mgr, key.0, key.1);
        let after = super::subs_promotion_generations().lock().unwrap()
            .get(&key).copied().unwrap_or(0);
        assert_eq!(after, before.wrapping_add(1));
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn complete_subtitle_promotion_requires_whole_media_and_single_flight() {
        assert!(super::should_promote_complete_subtitles(true, false));
        assert!(!super::should_promote_complete_subtitles(false, false));
        assert!(!super::should_promote_complete_subtitles(true, true));
    }

    #[test]
    fn complete_subtitle_promotion_publication_generation_rejects_discarded_job() {
        assert!(super::should_publish_complete_subtitles(7, 7));
        assert!(!super::should_publish_complete_subtitles(8, 7));
    }

    #[test]
    fn batch_subtitle_extract_maps_every_text_track_once() {
        let args = super::build_all_sub_extract_args("complete.mkv", &[
            (2, false, "two.tmp.srt".into()),
            (3, true, "three.tmp.ass".into()),
        ]);
        let joined = args.join(" ");
        assert!(joined.contains("-map 0:2 -an -vn -copyts -f srt -flush_packets 1 two.tmp.srt"));
        assert!(joined.contains("-map 0:3 -an -vn -copyts -c:s copy -f ass -flush_packets 1 three.tmp.ass"));
        assert_eq!(args.iter().filter(|a| a.as_str() == "-i").count(), 1);
    }

    #[test]
    fn durable_subtitle_path_is_outside_disposable_stream_cache_and_source_sized() {
        let root = std::env::temp_dir().join("nobuf-sub-path-test").join("stream-cache");
        let mgr = crate::stream_cache::StreamCacheManager::new(root.clone()).unwrap();
        let path = super::durable_sub_cache_path(&Some(mgr), i64::MIN, 109, 3, 1_566_651_347, false);
        assert!(!path.starts_with(&root));
        assert!(path.to_string_lossy().contains("subtitle-cache"));
        assert!(path.to_string_lossy().contains("s3_1566651347.srt"));
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// Round-3 subs fix: every extraction flushes cues to disk per-packet so the
    /// output survives a kill_on_drop mid-extraction (timeout salvage belt).
    #[test]
    fn sub_extract_args_include_flush_packets() {
        let args = super::build_sub_extract_args(
            "http://x/stream/home/1?token=t&source_id=subs", 2, false, false, "out.srt",
        );
        let joined = args.join(" ");
        assert!(joined.contains("-flush_packets 1"), "srt args: {}", joined);
        let args_ass = super::build_sub_extract_args("in.mkv", 3, true, false, "out.ass");
        assert!(args_ass.join(" ").contains("-flush_packets 1"), "ass path too");
    }

    /// Round-4 regression (4-t.md:239-241): serde bools in query strings parse
    /// from "true"/"false" ONLY — `cached_prefix=1` made actix 400 the ENTIRE
    /// StreamQuery, killing every bounded extraction at ffmpeg's first request.
    /// Pins the contract for both bool params and the exact literal the extract
    /// call site appends.
    #[test]
    fn stream_query_bool_params_parse_from_true_literal() {
        use actix_web::web::Query;
        let q = Query::<super::StreamQuery>::from_query("cached_prefix=true").unwrap();
        assert_eq!(q.cached_prefix, Some(true));
        let q = Query::<super::StreamQuery>::from_query("cached_only=true&cached_prefix=true").unwrap();
        assert_eq!(q.cached_only, Some(true));
        assert_eq!(q.cached_prefix, Some(true));
        assert!(!super::should_skip_cache_poll(true, true));
        assert!(super::should_skip_cache_poll(false, true));
        // Numeric shorthand must keep failing loudly, not silently coerce.
        assert!(Query::<super::StreamQuery>::from_query("cached_prefix=1").is_err());
    }

    #[test]
    fn timestamp_seek_marks_only_the_final_http_ffmpeg_input() {
        let source = "http://127.0.0.1:14201/stream/home/108?token=t";
        assert_eq!(super::marked_remux_input_source(source, 1322.469, false), format!("{source}&remux_seek=1322.469"));
        assert_eq!(super::marked_remux_input_source(source, 1322.469, true), source);
        assert_eq!(super::marked_remux_input_source(source, 0.0, false), source);
        assert_eq!(super::marked_remux_input_source("C:/cached.mkv", 1322.469, false), "C:/cached.mkv");
        let source = include_str!("server.rs");
        let remux_fn = source.split("async fn remux_ts_to_mp4").nth(1).unwrap();
        assert!(remux_fn.contains("cmd.arg(\"-i\").arg(&final_input_source)"));
    }

    #[test]
    fn remux_seek_range_filter_accepts_real_demux_ranges_not_probe_noise() {
        let size = 1_467_894_377;
        assert!(super::is_authoritative_remux_seek_range(330_769_921, 343_265_633, 1_124_628_744, size));
        // A marked ffmpeg input first asks from byte zero for container headers.
        // Even near the opening that is not the demuxer-resolved seek Range.
        assert!(!super::is_authoritative_remux_seek_range(20_000_000, 0, size, size));
        assert!(!super::is_authoritative_remux_seek_range(330_769_921, 1_467_863_021, 31_356, size));
        assert!(!super::is_authoritative_remux_seek_range(330_769_921, 787_299, 1_467_107_078, size));
        assert!(super::is_authoritative_remux_seek_range(1_059_780_245, 1_112_709_729, 355_184_648, size));
    }

    #[test]
    fn remux_seek_range_filter_rejects_front_header_read_for_early_seek() {
        let size = 1_467_894_377;
        // 20-t:279-283: ffmpeg's container bootstrap at 787,299 was latched
        // for a 559.253s seek before the real demux range arrived.
        assert!(!super::is_authoritative_remux_seek_range(
            139_877_827, 787_299, 1_467_107_078, size,
        ));
        assert!(super::is_authoritative_remux_seek_range(
            139_877_827, 143_174_033, 1_324_720_344, size,
        ));
    }

    #[test]
    fn explicit_vbr_playback_report_is_not_corrected_twice() {
        let size = 1_467_894_377;
        let anchor = Some((1329.0, 332_415_542, 345_368_082));
        assert_eq!(
            super::corrected_playback_report_byte(345_900_000, true, 1331.0, anchor, size),
            345_900_000,
        );
        assert_eq!(
            super::corrected_playback_report_byte(332_947_460, false, 1331.0, anchor, size),
            345_900_000,
        );
    }

    #[test]
    fn subtitle_island_prefers_near_authoritative_remux_anchor_only() {
        let size = 1_467_894_377;
        assert_eq!(super::authoritative_subs_playhead_byte(Some(331_124_494), Some((330_769_921, 343_265_633)), size), Some(343_620_206));
        // 5-t: the frontend has already learned the actual anchor. Applying the
        // +2,042,560 correction again produced the wrong 241,522,694 byte.
        assert_eq!(super::authoritative_subs_playhead_byte(Some(239_480_134), Some((236_969_495, 239_012_055)), size), Some(239_480_134));
        assert_eq!(super::authoritative_subs_playhead_byte(Some(237_320_974), Some((236_969_495, 239_012_055)), size), Some(239_363_534));
        assert_eq!(super::authoritative_subs_playhead_byte(Some(1_060_136_781), Some((330_769_921, 343_265_633)), size), Some(1_060_136_781));
        assert_eq!(super::authoritative_subs_playhead_byte(None, Some((330_769_921, 343_265_633)), size), None);
    }

    #[test]
    fn subtitle_anchor_correction_does_not_reapply_after_frontend_converges() {
        let size = 1_467_894_377;
        let anchor = Some((3_895.034, 1_031_257_671, 1_029_253_987));
        // 21-t:1816: the first post-seek request still followed the old estimate.
        assert_eq!(
            super::resolve_authoritative_subs_playhead_byte(
                Some(1_031_263_638), anchor, None, size,
            ),
            Some(1_029_259_954),
        );
        // 21-t:1839: the frontend learned the authoritative anchor.
        assert_eq!(
            super::resolve_authoritative_subs_playhead_byte(
                Some(1_029_616_769), anchor, Some(3_895.034), size,
            ),
            Some(1_029_616_769),
        );
        // 21-t:1890: forward playback must not make the stale delta active again.
        assert_eq!(
            super::resolve_authoritative_subs_playhead_byte(
                Some(1_030_470_002), anchor, Some(3_895.034), size,
            ),
            Some(1_030_470_002),
        );
        assert_eq!(
            super::resolve_authoritative_subs_playhead_byte(
                Some(1_031_263_638), anchor, Some(3_710.810), size,
            ),
            Some(1_029_259_954),
        );
    }

    /// Font attachment detection: mimetype first, extension fallback for
    /// sloppily tagged files, and non-fonts rejected.
    #[test]
    fn font_attachment_detection() {
        assert!(super::is_font_attachment("a.ttf", "application/x-truetype-font"));
        assert!(super::is_font_attachment("a.otf", "application/vnd.ms-opentype"));
        assert!(super::is_font_attachment("a.ttf", "font/ttf"));
        assert!(super::is_font_attachment("weird.TTF", ""), "extension fallback, case-insensitive");
        assert!(super::is_font_attachment("x.woff2", "application/octet-stream"));
        assert!(!super::is_font_attachment("cover.jpg", "image/jpeg"));
        assert!(!super::is_font_attachment("notes.txt", "text/plain"));
    }

    /// Subtitle cache filenames: keyed by stream index, extension = format,
    /// fonts keyed separately — no cross-track/cross-kind collisions.
    #[test]
    fn sub_cache_filenames_keyed_by_stream() {
        assert_eq!(super::sub_cache_filename("home", 84, 2, false), "home_84_s2.srt");
        assert_eq!(super::sub_cache_filename("home", 84, 3, true), "home_84_s3.ass");
        assert_eq!(super::sub_font_cache_filename("home", 84, 6), "home_84_f6.bin");
        assert_ne!(
            super::sub_cache_filename("home", 84, 2, false),
            super::sub_cache_filename("home", 84, 3, false),
        );
        assert_ne!(
            super::sub_cache_filename("home", 84, 2, true),
            super::sub_cache_filename("home", 84, 2, false),
            "ass vs srt of the same stream never collide"
        );
    }

    /// Extraction arg builder: ABSOLUTE-index -map (never 0:s:N, never `?` —
    /// F1: a trailing-? map emitted the WRONG track), ass=copy vs srt
    /// transcode, and -sub_charenc BEFORE -i on the latin1 retry (E9c).
    #[test]
    fn sub_extract_args_shape() {
        let srt = super::build_sub_extract_args("http://in", 2, false, false, "out.tmp");
        let m = srt.iter().position(|s| s == "-map").unwrap();
        assert_eq!(srt[m + 1], "0:2", "absolute stream index");
        assert!(!srt[m + 1].contains('?'), "no ? maps ever");
        assert!(srt.windows(2).any(|w| w[0] == "-f" && w[1] == "srt"));
        assert!(!srt.iter().any(|s| s == "copy"), "srt path transcodes");
        assert!(!srt.iter().any(|s| s == "-sub_charenc"));
        assert_eq!(srt.last().unwrap(), "out.tmp");

        let ass = super::build_sub_extract_args("C:\\cache\\file.mkv", 3, true, false, "out.tmp");
        assert!(ass.windows(2).any(|w| w[0] == "-c:s" && w[1] == "copy"), "ass is codec-copied");
        assert!(ass.windows(2).any(|w| w[0] == "-f" && w[1] == "ass"));

        let retry = super::build_sub_extract_args("http://in", 2, false, true, "out.tmp");
        let enc = retry.iter().position(|s| s == "-sub_charenc").unwrap();
        let inp = retry.iter().position(|s| s == "-i").unwrap();
        assert!(enc < inp, "-sub_charenc must be an INPUT option (before -i)");
        assert_eq!(retry[enc + 1], "latin1");
    }

    /// Round-10 P0-1: `-copyts` keeps cue timestamps ABSOLUTE, and must NEVER be
    /// paired with `-start_at_zero`.
    ///
    /// ffmpeg's output stage subtracts the first DEMUXED packet's timestamp. When
    /// the served byte region excludes cluster 0 — every scattered/post-seek
    /// cache, i.e. exactly the playhead-island input — cues are silently rebased
    /// toward zero. Measured on a 900s fixture whose surviving cue sits at 800s:
    /// emitted 00:04:00,074 without the flag vs 00:13:20,000 with it = 559.9s
    /// desync, at exit 0, with well-formed SRT, plausible cue count and correct
    /// inter-cue deltas. Nothing observable reveals it.
    ///
    /// The `-start_at_zero` half of the trap: build_ss_timestamp_args pairs
    /// `-copyts -start_at_zero` for /remux seeks, and that combo REBASES the
    /// output timeline (see its doc comment). Copying that pattern here would
    /// silently reintroduce the desync, so the absence is asserted, not assumed.
    #[test]
    fn sub_extract_args_keep_absolute_timestamps() {
        for (input, idx, ass) in [
            ("http://in", 2, false),
            ("C:\\cache\\file.mkv", 3, true),
        ] {
            let args = super::build_sub_extract_args(input, idx, ass, false, "out.tmp");
            assert!(
                args.iter().any(|s| s == "-copyts"),
                "-copyts required or a cluster-0-less region desyncs every cue: {:?}",
                args
            );
            assert!(
                !args.iter().any(|s| s == "-start_at_zero"),
                "-start_at_zero re-rebases the output timeline — never pair it here: {:?}",
                args
            );
            // Must be an OUTPUT-stage option: after -i, or ffmpeg applies it to
            // the input and the rebase returns.
            let copyts = args.iter().position(|s| s == "-copyts").unwrap();
            let inp = args.iter().position(|s| s == "-i").unwrap();
            assert!(copyts > inp, "-copyts belongs after -i: {:?}", args);
        }
        // The latin1 retry path must carry the same guarantee.
        let retry = super::build_sub_extract_args("http://in", 2, false, true, "out.tmp");
        assert!(retry.iter().any(|s| s == "-copyts"), "retry keeps -copyts: {:?}", retry);
        assert!(!retry.iter().any(|s| s == "-start_at_zero"));
    }

    /// Round-13 R-3: the memo key must describe WHAT THE EXTRACTION READS.
    ///
    /// 13-t:220 — two DIFFERENT island reads (playhead 3598s at byte 628,163,769
    /// and 5171s at ~911,457,038) shared one memo key, because the key was the
    /// 0-contiguous prefix (48,234,496 B = 274 s) which barely moves during
    /// playback. The second extraction therefore replayed a stale 263-byte body
    /// and subtitles never advanced past 3844 s.
    ///
    /// This pins the invariant that makes the island fix effective at all:
    /// distinct island spans MUST key distinctly, or a stale replay silently
    /// cancels the re-extraction.
    #[test]
    fn subs_memo_key_distinguishes_islands_the_prefix_could_not() {
        let prefix = 48_234_496; // the frozen 0-prefix from 13-t
        let isl_3598s = Some((628_163_769u64, 641_728_511u64));
        let isl_5171s = Some((911_457_038u64, 924_021_780u64));

        // The bug: the OLD key was `prefix` for both — identical, hence the replay.
        assert_eq!(
            super::subs_memo_key(None, prefix),
            super::subs_memo_key(None, prefix),
            "prefix-only keying is what collided in 13-t"
        );

        // The fix: distinct islands ⇒ distinct keys ⇒ always re-extracts.
        assert_ne!(
            super::subs_memo_key(isl_3598s, prefix),
            super::subs_memo_key(isl_5171s, prefix),
            "distinct island spans must not share a memo key"
        );

        // An identical island at an unchanged frontier still replays — the
        // round-9 behaviour worth keeping (avoids a redundant ffmpeg run).
        assert_eq!(
            super::subs_memo_key(isl_3598s, prefix),
            super::subs_memo_key(isl_3598s, prefix),
        );

        // Island mode must not alias the prefix path.
        assert_ne!(super::subs_memo_key(isl_3598s, prefix), super::subs_memo_key(None, prefix));

        // Adjacent/overlapping spans differ (an XOR fold would collide here).
        assert_ne!(super::subs_memo_key(Some((0, 1)), 0), super::subs_memo_key(Some((2, 0)), 0));
    }

    /// Round-14 F5: the island-start cluster SNAP is load-bearing, and a comment
    /// cannot enforce that. Round-10b shipped a comment claiming alignment was
    /// "free tidiness" that yielded "identical cue sets"; round-14 MEASURED that
    /// claim and falsified it:
    ///
    ///   fixture 300s / 1s GOP / 300 cues / 300 clusters, same island start
    ///     aligned   (snapped to cluster) -> 148 cues
    ///     unaligned (mid-cluster)        -> 147 cues   (-0.7%)
    ///
    /// An independent fixture measured ~5%. Magnitude is content-dependent; the
    /// direction is not. This exercises the PRODUCTION function the extractor
    /// calls, so deleting the snap breaks a test instead of silently losing cues.
    #[test]
    fn island_start_snap_finds_cluster_boundary_in_scan_window() {
        const CLUSTER_ID: [u8; 4] = [0x1F, 0x43, 0xB6, 0x75];

        // A window whose only Cluster ID sits at a non-zero offset — exactly the
        // mid-cluster case the snap exists to correct. The absolute island start
        // must move forward by that offset.
        let mut buf = vec![0xAAu8; 4096];
        buf[1234..1238].copy_from_slice(&CLUSTER_ID);
        assert_eq!(
            super::snap_island_start_to_cluster(&buf, 600_000_000),
            600_001_234,
            "snap must advance the start to the cluster boundary; without it the \
             island begins mid-cluster and ffmpeg discards the partial leading \
             cluster (measured -0.7% to -5% cues)"
        );

        // Cluster already at offset 0 => start is unchanged (idempotent).
        let mut at_zero = vec![0xAAu8; 64];
        at_zero[0..4].copy_from_slice(&CLUSTER_ID);
        assert_eq!(
            super::snap_island_start_to_cluster(&at_zero, 42),
            42,
            "an already-aligned start must not move"
        );

        // No Cluster ID in range => DEGRADE to the caller's start. The snap must
        // never invent an offset, and never push the start backwards.
        assert_eq!(
            super::snap_island_start_to_cluster(&vec![0xAAu8; 4096], 12_345),
            12_345,
            "with no cluster in the window the snap must return the raw start"
        );

        // Empty window (scan_to == scan_from) must not panic.
        assert_eq!(super::snap_island_start_to_cluster(&[], 7), 7);
    }

    /// Round-10b: an island smaller than one MKV cluster yields ZERO cues —
    /// ffmpeg logs `Truncating packet of size N to M` and emits nothing
    /// (verified against a real fixture: a ~100 KB island of a file whose
    /// clusters are ~1 MB produced 0 cues, while a 20 % island produced 9).
    /// The extractor must therefore DECLINE island mode below the minimum and
    /// fall back to the prefix path, rather than emit a body that cannot work.
    #[test]
    fn subs_island_minimum_size_is_above_a_real_cluster() {
        // The guard must exceed a realistic cluster. The failing fixture had a
        // single cluster of 1,093,994 B (from ffmpeg's own truncation message).
        assert!(
            super::SUBS_ISLAND_MIN_BYTES > 1_093_994,
            "minimum island must exceed the 1,093,994 B cluster that produced 0 cues"
        );
    }

    /// The near-miss admission test: an island under the 2 MiB byte floor is now
    /// admitted when it demonstrably holds a whole cluster (≥2 cluster markers).
    /// `count_mkv_clusters` is the pure measurement that replaces the byte proxy.
    #[test]
    fn count_mkv_clusters_counts_markers() {
        const CID: [u8; 4] = [0x1F, 0x43, 0xB6, 0x75];
        assert_eq!(super::count_mkv_clusters(&[0xAAu8; 4096]), 0);
        let mut one = vec![0u8; 1024];
        one[100..104].copy_from_slice(&CID);
        assert_eq!(super::count_mkv_clusters(&one), 1);
        let mut two = vec![0u8; 4096];
        two[100..104].copy_from_slice(&CID);
        two[2000..2004].copy_from_slice(&CID);
        assert_eq!(super::count_mkv_clusters(&two), 2);
    }

    #[test]
    fn count_mkv_clusters_handles_tiny_and_empty_windows() {
        assert_eq!(super::count_mkv_clusters(&[]), 0);
        assert_eq!(super::count_mkv_clusters(&[0x1F, 0x43, 0xB6]), 0);
        assert_eq!(super::count_mkv_clusters(&[0x1F, 0x43, 0xB6, 0x75]), 1);
    }

    /// The admission RULE the fix encodes: <2 markers declines (a lone partial
    /// cluster yields zero cues), ≥2 markers admits — independent of byte size.
    /// This is the invariant the observed 1.998 MB decline violated.
    #[test]
    fn sub_floor_island_admits_only_with_a_whole_cluster() {
        const CID: [u8; 4] = [0x1F, 0x43, 0xB6, 0x75];
        let admit = |markers: usize| {
            let mut buf = vec![0u8; markers.max(1) * 8];
            for i in 0..markers {
                buf[i * 8..i * 8 + 4].copy_from_slice(&CID);
            }
            super::count_mkv_clusters(&buf) >= 2
        };
        assert!(!admit(0), "no clusters must decline");
        assert!(!admit(1), "a lone partial cluster must decline");
        assert!(admit(2), "one whole cluster (2 markers) must admit");
        assert!(admit(5), "several clusters must admit");
    }

    /// Round-10b: island selection must still prefer the range containing the
    /// playhead — the whole point of the fix. Guards against a regression where
    /// the minimum-size check accidentally reorders the tiers.
    #[test]
    fn subs_island_prefers_playhead_range_over_zero_prefix() {
        const HDR: u64 = 1000;
        // Real shape: a small 0-prefix plus a far island around the seek target.
        let ranges = vec![(0u64, 34_603_007u64), (700_000_000, 800_000_000)];
        let picked = super::pick_subs_island(&ranges, 793_000_000, HDR);
        let (s, e) = picked.expect("the straddling range must still win over the 0-prefix");
        // Round-26: this used to assert the raw span (700_000_000, 800_000_000).
        // That equality incidentally pinned the UNBOUNDED size of a straddling
        // island — the exact property that would have let cache coalescing grow
        // the ffmpeg input to file size. The assertion the test NAMES is tier
        // ordering, so assert that directly: the pick comes from the playhead's
        // own range, not the 0-prefix.
        assert!(
            s >= 700_000_000 && e <= 800_000_000,
            "must be a window of the playhead's range, got {s}-{e}",
        );
        assert!(s <= 793_000_000 && 793_000_000 <= e, "playhead must stay inside the window");
        // And that island clears the minimum, so it is actually usable.
        assert!(e - s + 1 >= super::SUBS_ISLAND_MIN_BYTES);
        // ...while never exceeding the round-26 ceiling.
        assert!(e - s + 1 <= super::SUBS_ISLAND_MAX_BYTES);
    }

    /// Round-26 T1: the ceiling that makes coverage-derived prebuffering safe.
    ///
    /// These assert a BOUND, not a happy path. The regression they prevent is
    /// silent: cue output stays correct while the ffmpeg input grows toward file
    /// size, so only a size assertion can catch it.
    #[test]
    fn island_never_exceeds_the_ceiling_for_any_arm() {
        const HDR: u64 = 1000;
        const MAX: u64 = super::SUBS_ISLAND_MAX_BYTES;
        let huge = 900 * 1024 * 1024u64;

        // arm 1: straddling
        let straddle = vec![(HDR, huge)];
        let (s, e) = super::pick_subs_island(&straddle, huge / 2, HDR).unwrap();
        assert!(e - s + 1 <= MAX, "arm 1 unbounded: {}B", e - s + 1);

        // arm 2: forward island within the distance limit
        let playhead = 100_000_000u64;
        let fwd = vec![(playhead + 1_000_000, playhead + 1_000_000 + huge)];
        let (s, e) = super::pick_subs_island(&fwd, playhead, HDR).unwrap();
        assert!(e - s + 1 <= MAX, "arm 2 unbounded: {}B", e - s + 1);

        // arm 3: backward island within the distance limit. The playhead must sit
        // far enough into the file for a `huge` span to fit behind it.
        let back_playhead = huge + 100_000_000u64;
        let back = vec![(back_playhead - 4 * 1024 * 1024 - huge, back_playhead - 4 * 1024 * 1024)];
        let (s, e) = super::pick_subs_island(&back, back_playhead, HDR).unwrap();
        assert!(e - s + 1 <= MAX, "arm 3 unbounded: {}B", e - s + 1);
    }

    /// The exact failure mode the sweep change would otherwise introduce: as the
    /// prebuffer fills forward, the straddling range coalesces and grows. Island
    /// size must NOT track that growth.
    #[test]
    fn island_size_does_not_grow_with_sweep_progress() {
        const HDR: u64 = 1000;
        let playhead = 50_000_000u64;
        let chunk = 8 * 1024 * 1024u64;

        let after = |chunks: u64| {
            let ranges = vec![(HDR, playhead + chunks * chunk)];
            let (s, e) = super::pick_subs_island(&ranges, playhead, HDR).unwrap();
            e - s + 1
        };

        let one = after(1);
        let hundred = after(100);
        assert!(
            hundred <= 4 * one,
            "island grew with sweep progress: 1 chunk -> {one}B, 100 chunks -> {hundred}B",
        );
        assert!(hundred <= super::SUBS_ISLAND_MAX_BYTES);
    }

    /// A clamped island must still be usable: above the floor, and containing the
    /// viewer. A ceiling that starved the extractor would trade one bug for another.
    #[test]
    fn clamped_island_stays_usable() {
        assert!(
            super::SUBS_ISLAND_MAX_BYTES > super::SUBS_ISLAND_MIN_BYTES,
            "ceiling {} must exceed floor {} or every clamped island is rejected",
            super::SUBS_ISLAND_MAX_BYTES, super::SUBS_ISLAND_MIN_BYTES,
        );
        assert!(
            super::SUBS_ISLAND_MAX_BYTES >= super::SUBS_ISLAND_MAX_DISTANCE_BYTES,
            "an island admitted at max distance must still fit a usable body",
        );

        const HDR: u64 = 1000;
        let ranges = vec![(HDR, 900 * 1024 * 1024u64)];
        for playhead in [HDR + 1, 10_000_000, 450_000_000, 900 * 1024 * 1024 - 1] {
            let (s, e) = super::pick_subs_island(&ranges, playhead, HDR).unwrap();
            assert!(s <= playhead && playhead <= e, "playhead {playhead} outside {s}-{e}");
            assert!(e - s + 1 >= super::SUBS_ISLAND_MIN_BYTES, "below floor at {playhead}");
            assert!(e - s + 1 <= super::SUBS_ISLAND_MAX_BYTES, "above ceiling at {playhead}");
        }
    }

    /// Spans already within the ceiling must pass through byte-identical — the
    /// clamp must not perturb the fragmented shapes that exist today.
    #[test]
    fn subtitle_island_reserves_three_quarters_for_preroll() {
        let max = 12 * 1024 * 1024;
        let playhead = 100 * 1024 * 1024;
        let (start, end) = super::clamp_subs_island(0, 200 * 1024 * 1024, playhead, max);
        let behind = playhead - start;
        let ahead = end - playhead;
        assert!(behind > ahead * 2, "expected backward bias, got behind={behind} ahead={ahead}");
        assert!(start <= playhead && playhead <= end);
        assert_eq!(end - start + 1, max);
    }

    #[test]
    fn clamp_is_identity_below_the_ceiling() {
        const MAX: u64 = super::SUBS_ISLAND_MAX_BYTES;
        for (s, e, ph) in [
            (1000u64, 1000 + 2 * 1024 * 1024u64, 1_500_000u64),
            (500_000_000, 500_000_000 + MAX - 1, 500_000_100),
        ] {
            assert_eq!(super::clamp_subs_island(s, e, ph, MAX), (s, e));
        }
    }

    /// The clamp must never invent a range outside its input, at either edge.
    #[test]
    fn clamp_never_escapes_the_source_span() {
        const MAX: u64 = 12 * 1024 * 1024;
        let (s, e) = (1_000u64, 500_000_000u64);
        for ph in [s, s + 1, 250_000_000, e - 1, e] {
            let (cs, ce) = super::clamp_subs_island(s, e, ph, MAX);
            assert!(cs >= s && ce <= e, "escaped {s}-{e} with playhead {ph}: got {cs}-{ce}");
            assert!(ce >= cs, "inverted window at {ph}");
            assert!(ce - cs + 1 <= MAX, "over cap at {ph}");
            assert!(cs <= ph && ph <= ce, "playhead {ph} dropped out of {cs}-{ce}");
        }
    }

    /// Round-10 P1-1: locating the first MKV Cluster bounds the header region
    /// (EBML/Info/Tracks/CodecPrivate) that must precede any islanded cluster.
    #[test]
    fn finds_first_mkv_cluster() {
        let mut buf = vec![0xAAu8; 900];
        buf.extend_from_slice(&[0x1F, 0x43, 0xB6, 0x75]);
        buf.extend_from_slice(&[0xBBu8; 100]);
        assert_eq!(super::find_first_mkv_cluster(&buf), Some(900));
        // Only the FIRST occurrence matters — a later cluster must not win.
        let mut two = buf.clone();
        two.extend_from_slice(&[0x1F, 0x43, 0xB6, 0x75]);
        assert_eq!(super::find_first_mkv_cluster(&two), Some(900));
        // No cluster in window → None (caller falls back to prefix mode).
        assert_eq!(super::find_first_mkv_cluster(&[0u8; 64]), None);
        // Shorter than the ID must not panic.
        assert_eq!(super::find_first_mkv_cluster(&[0x1F, 0x43]), None);
    }

    /// Round-17, the PRODUCTION failure, with the real numbers from 17-t.md:212-213.
    ///
    /// ```text
    /// [SUBS-ISLAND] island 1566572544-1566651346 is 78803B < 2097152B minimum
    /// [SUBS-ISLAND] no usable island and prefix ends at 33554432B while
    ///               playhead is 572016605B — declining
    /// ```
    ///
    /// The player's `playback-tail` / `thumbnail-tail` probes leave a ~78 KB
    /// cached range at EOF on EVERY file. The old unbounded forward rule picked
    /// it — 967 MB (91.5 min of runtime) past the playhead.
    #[test]
    fn rejects_eof_tail_probe_artifact_from_production_log() {
        const HDR: u64 = 5_827; // "header 0-5827" from the same log line
        let playhead = 572_016_605u64;
        let ranges = vec![
            (0u64, 33_554_432u64),                    // cached prefix, 32 MB
            (1_566_572_544u64, 1_566_651_346u64),     // EOF tail probe, 78,803 B
        ];

        // Both candidates are ~half a gigabyte away in opposite directions, so
        // NEITHER may be served. `None` lets the caller's coverage gate decline.
        assert_eq!(
            super::pick_subs_island(&ranges, playhead, HDR), None,
            "EOF tail is 967 MB ahead and the prefix 538 MB behind — both must be rejected",
        );

        // Distances, stated so a future reader does not have to recompute them.
        assert_eq!(1_566_572_544u64 - playhead, 994_555_939);
        assert_eq!(playhead - 33_554_432u64, 538_462_173);
    }

    /// The recovery from the SAME session, 7 seconds later (17-t.md:217):
    /// island 547,814,419-580,386,815 served for playhead 573,250,145.
    /// That island CONTAINS the playhead declined at :213, so rule 1 admits it
    /// and the distance bound is never consulted. This is the case the fix must
    /// not break.
    #[test]
    fn admits_the_straddling_island_that_actually_recovered() {
        const HDR: u64 = 5_827;
        let ranges = vec![(0u64, 33_554_432u64), (547_814_419u64, 580_386_815u64)];

        // Round-26: these were `assert_eq!` against the full 31.1 MiB span. The
        // property the test NAMES is admission ("must still be admitted"); the
        // exact span was incidental, and pinning it also pinned the unbounded
        // island size. Assert admission from the right range instead.
        for (playhead, why) in [
            (573_250_145u64, "the island that recovered at 12:02:58 must still be admitted"),
            (572_016_605u64, "same island contains the earlier declined playhead"),
        ] {
            let (s, e) = super::pick_subs_island(&ranges, playhead, HDR).expect(why);
            assert!(s >= 547_814_419 && e <= 580_386_815, "{why}: got {s}-{e}");
            assert!(s <= playhead && playhead <= e, "{why}: playhead outside {s}-{e}");
            assert!(e - s + 1 >= super::SUBS_ISLAND_MIN_BYTES, "{why}: below floor");
            assert!(e - s + 1 <= super::SUBS_ISLAND_MAX_BYTES, "{why}: above ceiling");
        }
    }

    /// The bound must exceed the size floor, or every admitted island would be
    /// rejected by `build_subs_island_file` moments later.
    #[test]
    fn island_distance_bound_exceeds_size_floor() {
        assert!(
            super::SUBS_ISLAND_MAX_DISTANCE_BYTES > super::SUBS_ISLAND_MIN_BYTES,
            "distance bound {} must exceed the {}B island minimum",
            super::SUBS_ISLAND_MAX_DISTANCE_BYTES, super::SUBS_ISLAND_MIN_BYTES,
        );
    }

    /// Boundary arithmetic: exactly-at-the-bound is admitted, one byte past is not.
    #[test]
    fn island_distance_bound_is_inclusive() {
        const HDR: u64 = 1_000;
        const D: u64 = super::SUBS_ISLAND_MAX_DISTANCE_BYTES;
        let playhead = 500_000_000u64;

        // Forward: a range starting exactly D ahead is IN.
        let at = vec![(playhead + D, playhead + D + 10_000_000)];
        assert!(super::pick_subs_island(&at, playhead, HDR).is_some());
        // One byte further out is OUT.
        let past = vec![(playhead + D + 1, playhead + D + 10_000_000)];
        assert_eq!(super::pick_subs_island(&past, playhead, HDR), None);

        // Backward: a range ENDING exactly D behind is IN.
        let back_at = vec![(playhead - D - 10_000_000, playhead - D)];
        assert!(super::pick_subs_island(&back_at, playhead, HDR).is_some());
        // One byte further back is OUT.
        let back_past = vec![(playhead - D - 10_000_000, playhead - D - 1)];
        assert_eq!(super::pick_subs_island(&back_past, playhead, HDR), None);
    }

    /// Degenerate inputs must not panic (saturating arithmetic near 0 / u64::MAX).
    #[test]
    fn island_distance_bound_handles_edges() {
        const HDR: u64 = 1_000;
        assert_eq!(super::pick_subs_island(&[], 500_000, HDR), None);
        // Playhead at 0: the backward limit saturates instead of underflowing.
        assert_eq!(super::pick_subs_island(&[(0, 500)], 0, HDR), None); // e <= header_end → unusable
        // Playhead at u64::MAX: the forward limit saturates instead of overflowing.
        let far = vec![(10_000u64, 20_000u64)];
        assert_eq!(super::pick_subs_island(&far, u64::MAX, HDR), None);
    }

    /// Round-10 P1-1: island selection. The whole point is to serve bytes NEAR
    /// THE PLAYHEAD instead of the contiguous-from-0 prefix, which froze at 196s
    /// of an 8888s film while the viewer sat at 4500s.
    #[test]
    fn picks_island_covering_playhead() {
        const HDR: u64 = 1000;
        // Real shape from the failing session: a 0-prefix plus a far island the
        // player downloaded around the seek target.
        let ranges = vec![(0u64, 34_603_007u64), (700_000_000, 800_000_000)];

        // Playhead inside the far island → that island wins, NOT the 0-prefix.
        // Round-26: was `assert_eq!(.., Some((700_000_000, 800_000_000)))`. The
        // named property is "the far island wins over the 0-prefix"; asserting
        // the exact 95 MiB span also froze the island size, which is what let
        // cache coalescing grow the ffmpeg input without limit.
        let (s, e) = super::pick_subs_island(&ranges, 793_000_000, HDR)
            .expect("far island must win over the 0-prefix");
        assert!(s >= 700_000_000 && e <= 800_000_000, "came from the 0-prefix: {s}-{e}");
        assert!(s <= 793_000_000 && 793_000_000 <= e, "playhead outside {s}-{e}");
        assert!(e - s + 1 <= super::SUBS_ISLAND_MAX_BYTES);
        // Playhead in a gap, 200 MB (~19 min of runtime) short of the island.
        // Round-17: this used to return the far island. It is now REJECTED — a
        // range that distant is not what the viewer is watching, and returning
        // `Some` here bypasses the caller's prefix-coverage gate. `None` hands
        // the decision to that gate, which declines with 204 + X-Subs-Partial.
        assert_eq!(super::pick_subs_island(&ranges, 500_000_000, HDR), None);
        // Playhead 100 MB PAST every range: likewise too far behind to be the
        // region on screen. Previously returned the far island.
        assert_eq!(super::pick_subs_island(&ranges, 900_000_000, HDR), None);
        // ...but just inside the bound, the same range is still admitted, in
        // both directions. (8 MiB = 8,388,608 B.) Round-26: assert ADMISSION and
        // provenance, not the raw span — the span is now capped.
        for (playhead, why) in [
            (700_000_000u64 - 8_000_000, "range 8 MB ahead is within the 8 MiB bound"),
            (800_000_000u64 + 8_000_000, "range 8 MB behind is within the 8 MiB bound"),
        ] {
            let (s, e) = super::pick_subs_island(&ranges, playhead, HDR).expect(why);
            assert!(s >= 700_000_000 && e <= 800_000_000, "{why}: got {s}-{e}");
            assert!(e - s + 1 <= super::SUBS_ISLAND_MAX_BYTES, "{why}: above ceiling");
            assert!(e - s + 1 >= super::SUBS_ISLAND_MIN_BYTES, "{why}: below floor");
        }
        // Playhead inside the 0-prefix → clamped to start at the header end so
        // the stitched body never duplicates header bytes. Round-26: the 33 MiB
        // prefix now also clamps to the ceiling, so assert the header-end rule
        // (the property this case exists for) rather than the whole span.
        let (s, e) = super::pick_subs_island(&ranges, 10_000, HDR).expect("0-prefix is admitted");
        assert!(s >= HDR, "island must not duplicate header bytes: starts at {s} < {HDR}");
        assert!(s <= 10_000 && 10_000 <= e, "playhead outside {s}-{e}");
        assert!(e <= 34_603_007, "must stay inside the 0-prefix: {s}-{e}");
        assert!(e - s + 1 <= super::SUBS_ISLAND_MAX_BYTES);
        // Nothing cached → None → caller keeps the old prefix behaviour.
        assert_eq!(super::pick_subs_island(&[], 123, HDR), None);
        // A range entirely inside the header contributes nothing.
        assert_eq!(super::pick_subs_island(&[(0, 500)], 200, HDR), None);
    }

    /// Font dump arg builder: -dump_attachment:<idx> BEFORE -i (input option),
    /// endpoint-controlled output path, and the `-t 0.01 -f null -` bound that
    /// makes ffmpeg exit 0 without reading the whole file (X4/X5/F1).
    #[test]
    fn font_dump_args_shape() {
        let args = super::build_font_dump_args("http://in", 6, "font.tmp");
        let dump = args.iter().position(|s| s == "-dump_attachment:6").unwrap();
        assert_eq!(args[dump + 1], "font.tmp", "endpoint-controlled filename");
        let inp = args.iter().position(|s| s == "-i").unwrap();
        assert!(dump < inp, "-dump_attachment is an INPUT option");
        assert!(args.windows(2).any(|w| w[0] == "-f" && w[1] == "null"));
        assert_eq!(args.last().unwrap(), "-", "null muxer needs a sink arg");
    }

    /// SubProbeResult memo round-trip: what the endpoint memoizes is exactly
    /// what a later validation call deserializes (serde stability guard).
    #[test]
    fn sub_probe_result_serde_round_trip() {
        let inv = super::SubProbeResult {
            tracks: vec![super::SubTrackInfo {
                index: 2, codec: "ass".into(), kind: "text".into(),
                language: "jpn".into(), title: "Signs".into(),
                is_default: false, forced: true, hearing_impaired: false,
            }],
            fonts: vec![super::FontAttachmentInfo {
                index: 6, filename: "f.ttf".into(),
                mimetype: "font/ttf".into(),
            }],
        };
        let json = serde_json::to_string(&inv).unwrap();
        let back: super::SubProbeResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back, inv);
    }

    /// Arg builders must map the OVERRIDDEN audio index (regression guard for
    /// the audio-track feature: one handler local feeds every ffmpeg site).
    #[test]
    fn arg_builders_map_overridden_audio_idx() {
        let a = build_strategy_a_args("input.ts", 0, 2);
        let maps_a: Vec<&str> = a.iter().enumerate()
            .filter(|(_, s)| s.as_str() == "-map")
            .map(|(i, _)| a[i + 1].as_str()).collect();
        assert_eq!(maps_a, vec!["0:0", "0:2"]);

        let b = build_background_remux_args("input.ts", 0, 3);
        let maps_b: Vec<&str> = b.iter().enumerate()
            .filter(|(_, s)| s.as_str() == "-map")
            .map(|(i, _)| b[i + 1].as_str()).collect();
        assert_eq!(maps_b, vec!["0:0", "0:3"]);
    }

    /// Cover-art: a 2nd video stream (mjpeg) must be ignored — the FIRST video wins.
    #[test]
    fn probe_json_second_video_is_cover_art_ignored() {
        let json = r#"{
            "streams": [
                {"index":0,"codec_type":"video","codec_name":"hevc","pix_fmt":"yuv420p10le"},
                {"index":1,"codec_type":"audio","codec_name":"aac","channels":6,"channel_layout":"5.1(side)"},
                {"index":2,"codec_type":"video","codec_name":"mjpeg","pix_fmt":"yuvj420p"}
            ],
            "format": {"duration":"5471.0"}
        }"#;
        let r = super::parse_probe_json(json);
        assert_eq!(r.video_stream_idx, 0);
        assert_eq!(r.video_codec_name, "hevc");
        assert_eq!(r.video_pix_fmt, "yuv420p10le");
        assert_eq!(r.audio_stream_idx, 1);
        assert_eq!(r.audio_channel_layout, "5.1(side)");
    }

    /// Late-audio miss: fast probe window sees ONLY video (audio not yet appeared).
    /// found_audio must be false → this is exactly what triggers the guarded
    /// fallback re-probe in remux_ts_to_mp4.
    #[test]
    fn probe_json_video_only_triggers_fallback_signal() {
        let json = r#"{
            "streams": [
                {"index":0,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p"}
            ],
            "format": {"duration":"600.0"}
        }"#;
        let r = super::parse_probe_json(json);
        assert!(r.found_video);
        assert!(!r.found_audio, "no audio in window → fallback must be signalled");
        // Falls back to the historical default audio index.
        assert_eq!(r.audio_stream_idx, 1);
    }

    /// Malformed / empty / non-JSON input must degrade to defaults (found=false,
    /// idx 0/1) and never panic — this is the ffprobe-garbage-output edge case.
    #[test]
    fn probe_json_malformed_degrades_to_defaults() {
        for bad in ["", "not json", "{", "{\"streams\": \"oops\"}", "null", "[]"] {
            let r = super::parse_probe_json(bad);
            assert!(!r.found_video, "malformed {:?} must not report video", bad);
            assert!(!r.found_audio, "malformed {:?} must not report audio", bad);
            assert_eq!(r.video_stream_idx, 0);
            assert_eq!(r.audio_stream_idx, 1);
            assert_eq!(r.probed_duration, 0.0);
        }
    }

    /// Zero / negative / unparseable duration must NOT be accepted (stays 0.0 so
    /// the caller keeps the bitrate estimate instead of caching a bad value).
    #[test]
    fn probe_json_bad_duration_stays_zero() {
        for dur in ["0", "0.0", "-5.0", "N/A", ""] {
            let json = format!(
                r#"{{"streams":[{{"index":0,"codec_type":"video","codec_name":"h264"}}],"format":{{"duration":"{}"}}}}"#,
                dur
            );
            let r = super::parse_probe_json(&json);
            assert_eq!(r.probed_duration, 0.0, "duration {:?} must be rejected", dur);
        }
    }

    /// Streams with a negative/missing index are skipped (defensive — a bad index
    /// cast to i32 must never become a -map target).
    #[test]
    fn probe_json_negative_index_skipped() {
        let json = r#"{
            "streams": [
                {"index":-1,"codec_type":"video","codec_name":"h264"},
                {"index":3,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p"},
                {"index":4,"codec_type":"audio","codec_name":"aac","channels":2}
            ]
        }"#;
        let r = super::parse_probe_json(json);
        assert_eq!(r.video_stream_idx, 3, "must skip the index=-1 stream and pick idx 3");
        assert_eq!(r.audio_stream_idx, 4);
    }

    // ── Encoder ladder (Phase 2: QSV → NVENC → AMF → libx264) ──

    #[test]
    fn encoder_ladder_prefers_qsv_when_available() {
        assert_eq!(super::select_h264_encoder(|_| true), "h264_qsv");
    }

    #[test]
    fn encoder_ladder_falls_to_nvenc_then_amf() {
        assert_eq!(super::select_h264_encoder(|e| e == "h264_nvenc"), "h264_nvenc");
        assert_eq!(super::select_h264_encoder(|e| e == "h264_amf"), "h264_amf");
        // NVIDIA machine where QSV probe fails but NVENC works:
        assert_eq!(super::select_h264_encoder(|e| e != "h264_qsv"), "h264_nvenc");
    }

    #[test]
    fn encoder_ladder_floor_is_libx264() {
        // No hardware encoder at all → universal software floor. NEVER panics,
        // NEVER returns an empty encoder (graceful-degradation guarantee).
        assert_eq!(super::select_h264_encoder(|_| false), "libx264");
    }

    #[test]
    fn encoder_output_args_carry_rate_control() {
        let (qsv, pf) = super::h264_encoder_output_args("h264_qsv");
        assert!(qsv.iter().any(|a| a == "h264_qsv"));
        assert!(qsv.iter().any(|a| a == "-global_quality"), "QSV needs -global_quality (verified flags)");
        assert_eq!(pf, "nv12");

        let (nv, _) = super::h264_encoder_output_args("h264_nvenc");
        assert!(nv.iter().any(|a| a == "-cq"), "NVENC constant-quality mode");

        let (x264, pf) = super::h264_encoder_output_args("libx264");
        assert!(x264.iter().any(|a| a == "veryfast"), "libx264 must use veryfast (8x realtime verified)");
        assert_eq!(pf, "yuv420p");
    }

    // ── build_video_encoder_args: copy vs transcode vs HDR (Phase 3) ──

    #[test]
    fn no_transcode_is_pure_copy() {
        let (pre, out) = super::build_video_encoder_args(false, "h264_qsv", "h264", false);
        assert!(pre.is_empty(), "copy path must not add pre-input args");
        assert_eq!(out, vec!["-c:v".to_string(), "copy".to_string()]);
        // Even if is_hdr is true: no transcode → no tonemap (we never touch the stream).
        let (_, out) = super::build_video_encoder_args(false, "h264_qsv", "hevc", true);
        assert_eq!(out, vec!["-c:v".to_string(), "copy".to_string()]);
    }

    #[test]
    fn hevc_qsv_sdr_uses_full_hw_variant_a() {
        let (pre, out) = super::build_video_encoder_args(true, "h264_qsv", "hevc", false);
        // Pre-input: HW decode session (verified: 12-14x realtime).
        assert!(pre.iter().any(|a| a == "-hwaccel"), "variant A needs -hwaccel qsv before -i");
        assert!(pre.iter().any(|a| a == "hevc_qsv"), "variant A uses the QSV HEVC decoder");
        assert!(out.iter().any(|a| a == "vpp_qsv=format=nv12"), "GPU-side format convert (NOT hwupload)");
        assert!(out.iter().any(|a| a == "h264_qsv"));
    }

    #[test]
    fn hdr_always_software_decodes_and_tonemaps() {
        // HDR10 → hable tonemap chain (execution-verified). zscale needs
        // system-memory frames, so NO -hwaccel even on a QSV machine.
        let (pre, out) = super::build_video_encoder_args(true, "h264_qsv", "hevc", true);
        assert!(pre.is_empty(), "HDR must NOT use HW decode (zscale needs SW frames)");
        let vf = out.iter().position(|a| a == "-vf").map(|i| out[i + 1].clone()).unwrap();
        assert!(vf.contains("zscale=t=linear:npl=100"), "linearize before tonemap");
        assert!(vf.contains("tonemap=hable"), "hable operator (verified chain)");
        assert!(vf.contains("p=bt709:t=bt709:m=bt709"), "must land in bt709 SDR");
        assert!(vf.ends_with("format=nv12"), "QSV encoder wants nv12, got: {}", vf);
        assert!(out.iter().any(|a| a == "h264_qsv"), "still HW ENCODE (only decode is SW)");
    }

    #[test]
    fn hdr_tonemap_matches_encoder_pix_fmt() {
        // libx264 floor takes yuv420p, not nv12.
        let (_, out) = super::build_video_encoder_args(true, "libx264", "hevc", true);
        let vf = out.iter().position(|a| a == "-vf").map(|i| out[i + 1].clone()).unwrap();
        assert!(vf.ends_with("format=yuv420p"));
        assert!(out.iter().any(|a| a == "libx264"));
    }

    #[test]
    fn non_qsv_transcode_uses_sw_decode_variant_b() {
        // NVENC/AMF/libx264 machines: SW decode → format convert → encode.
        for enc in ["h264_nvenc", "h264_amf", "libx264"] {
            let (pre, out) = super::build_video_encoder_args(true, enc, "hevc", false);
            assert!(pre.is_empty(), "{}: no pre-input hwaccel (only QSV decode verified)", enc);
            assert!(out.iter().any(|a| a == enc), "{}: encoder present", enc);
            assert!(out.iter().any(|a| a.starts_with("format=") || a == "-vf"), "{}: format convert present", enc);
        }
    }

    #[test]
    fn av1_and_unknown_codecs_transcode_but_via_variant_b() {
        // AV1 in an MKV routed to /remux must not try hevc_qsv decode.
        let (pre, out) = super::build_video_encoder_args(true, "h264_qsv", "av1", false);
        assert!(pre.is_empty(), "non-HEVC input must not use the hevc_qsv decoder");
        assert!(out.iter().any(|a| a == "h264_qsv"));
    }
}

// Continuation tests removed — ContinuationGuard and continuation_should_run
// have been removed. The proactive prebuffer is now the ONLY path that
// downloads from Telegram; /stream reads exclusively from disk cache.









