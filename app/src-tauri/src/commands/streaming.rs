use tauri::State;
use std::sync::Arc;
use std::io::{Write, Seek, SeekFrom};

use crate::commands::TelegramState;
use crate::server::throttle_api_calls;
use crate::commands::resolve_peer;
use crate::stream_cache::{self, StreamCacheManager, CacheMeta, merge_ranges, find_gaps};
use grammers_client::types::Media;
use grammers_tl_types as tl;

/// Minimum byte delta before a VBR-corrected proactive target is treated as a
/// genuinely new target. The frontend re-derives the seek byte from its
/// keyframe/VBR table on every position report, which routinely produces ±1-byte
/// (and other sub-chunk) jitter around a stable target (observed in logs:
/// `1353514972 -> 1353514971`, `703432598 -> 703432597`, etc). Acting on that
/// jitter re-evaluates gaps and tears down the download iterator for no benefit,
/// since the proactive downloader fetches in 512KB chunks anyway — a sub-chunk
/// move lands in the same chunk.
///
/// Round-15 R-10: the original 64KiB value was sized against that ±1-byte jitter
/// and is ~50,000x too small for the noise source that actually dominates. The
/// playhead byte is derived from a CONSTANT-BITRATE estimate
/// (`(currentTime / duration) * fileSize`) on a VBR file with zero Cues, so the
/// per-report error is MINUTES of video wide, not bytes. Measured from log 15-t,
/// every "VBR correction" cleared the old dead-band by 300x-12,600x:
///
///   15-t:476    42 MB   238.7s     642x
///   15-t:501   451 MB  2561.3s   6,889x
///   15-t:535   827 MB  4693.2s  12,623x
///   15-t:557    20 MB   115.9s     312x
///   15-t:558   510 MB  2895.9s   7,789x
///
/// So the guard never blocked anything: 21 re-evaluations in one session, each
/// discarding the in-flight Telegram iterator (see the `break` in the gap loop),
/// for a total of ~13 MB actually downloaded across two whole sessions.
///
/// Sized now against the real error source: ~30 seconds of video at the file's
/// MEAN bitrate. It is a hysteresis threshold, not a seek target, so the VBR
/// spread around that mean (a 5 MiB window is ~15-60s depending on the local
/// bitrate) is acceptable — it only has to be far above the estimator's noise
/// and far below a deliberate user seek. The smallest genuine retarget observed
/// was 116s, so real seeks still cross it comfortably.
pub const PROACTIVE_TARGET_EPSILON_BYTES: u64 = 5 * 1024 * 1024;

/// Round-26: where the proactive sweep resumes after a seek — the first byte
/// NOBODY has cached at or after the viewer.
///
/// Replaces a fixed `playhead + 26 MiB` hand-off whose premise ("/stream has
/// already covered the playhead region via 2-3 chunks of 12.5MB each") was false
/// twice over: no 12.5 MB chunk exists anywhere (real Telegram granularity is
/// 512 KiB, observed /stream spans are 4/6/8 MiB), and the band was measurably
/// unfetched. From 25-t's first re-anchor: playhead 470,697,938, sweep resumed
/// 497,960,914, and /stream's nearest byte was 482,679,264 — leaving
/// 470,697,938..482,679,263 (11.43 MiB, ~68 s of video) fetched by NOBODY.
///
/// Coverage-derived resume has no direction, which retires the `jumped_backward`
/// flag and the two defects that came from keeping it correct (round-22 F3,
/// round-23 G1a).
///
/// **The `max(start_byte)` clamp is load-bearing.** `load_meta` returns None for
/// a missing / zero-byte / unparseable meta file, collapsing `cached_ranges` to
/// empty; the first gap is then `(0, total-1)`, whose end is >= any playhead.
/// Without the clamp the sweep would restart the whole file from byte 0 and
/// fight /stream's bootstrap for the 2-permit download semaphore.
///
/// A fully cached file has no gap at or after the playhead: returns `start_byte`
/// so the caller's `ahead_gaps` filter finds nothing and idles out cleanly.
pub fn proactive_resume_byte(
    cached_ranges: &[(u64, u64)],
    total_size: u64,
    start_byte: u64,
) -> u64 {
    crate::stream_cache::find_gaps(cached_ranges, total_size)
        .into_iter()
        .find(|(_, gap_end)| *gap_end >= start_byte)
        .map(|(gap_start, _)| gap_start.max(start_byte))
        .unwrap_or(start_byte)
}

/// Choose the next gap for a whole-file warmer. Prefer the viewer's forward
/// supply line, then backfill the earliest remaining hole behind it.
pub fn proactive_whole_file_resume(
    cached_ranges: &[(u64, u64)],
    total_size: u64,
    playhead_byte: u64,
) -> Option<(u64, bool)> {
    let gaps = crate::stream_cache::find_gaps(cached_ranges, total_size);
    if let Some((start, _)) = gaps.iter().find(|(_, end)| *end >= playhead_byte) {
        return Some(((*start).max(playhead_byte), false));
    }
    gaps.first().map(|(start, _)| (*start, true))
}


pub fn proactive_candidate_gaps(
    cached_ranges: &[(u64, u64)],
    total_size: u64,
    resume_byte: u64,
    max_byte: u64,
    backfilling: bool,
) -> Vec<(u64, u64)> {
    find_gaps(cached_ranges, total_size)
        .into_iter()
        .filter(|(start, end)| (backfilling || *end >= resume_byte) && *start < max_byte)
        .map(|(start, end)| (start.max(resume_byte), end.min(max_byte)))
        .filter(|(start, end)| *start <= *end)
        .collect()
}

/// Round-26: merge gaps separated by less than one Telegram chunk.
///
/// Each gap becomes its own download iterator, and the smallest unit Telegram
/// serves is `chunk_size` (512 KiB) — `skip_bytes` discards the leading
/// remainder, but the CHUNK is still fetched and still costs a slot on the
/// 2-permit semaphore. A 1-byte hole therefore costs the same round trip as a
/// 512 KiB one.
///
/// Before round-26 this could not bite: the fixed +26 MiB hand-off skipped the
/// fragmented neighbourhood around the playhead entirely. Deriving the resume
/// point from coverage deliberately aims the sweep INTO that region, where
/// /stream's 4/6/8 MiB reads and the bisect probes leave many small holes.
/// Without coalescing, N holes = N fetches = N limiter slots taken from the seek
/// the viewer is waiting on.
///
/// Both endpoints are inclusive, so the CACHED RUN between two gaps is
/// `start - prev_end - 1`. Merging re-fetches at most one sub-chunk run per join,
/// which the disk cache absorbs, and turns N round trips into one.
pub fn coalesce_sub_chunk_gaps(gaps: Vec<(u64, u64)>, chunk_size: u64) -> Vec<(u64, u64)> {
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(gaps.len());
    for (start, end) in gaps {
        match merged.last_mut() {
            Some((_, prev_end))
                if start.saturating_sub(*prev_end).saturating_sub(1) < chunk_size =>
            {
                *prev_end = end;
            }
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// Round-21: how far the reported playhead must move BACKWARD before the
/// prebuffer abandons its current position and re-anchors to the new one.
///
/// This exists because two different backward tests disagreed, and the
/// disagreement is exactly the "old prebuffer keeps growing after I seek back"
/// bug. The inner chunk loop broke out of the download on `target + 10MB <
/// prev_target`, but the outer loop only moved `start_byte` on
/// `target + 50MB < start_byte`. A backward seek landing in the 10-50MB band
/// therefore tore down the in-flight iterator and then re-derived its gaps from
/// the STALE forward `start_byte` — so it resumed downloading ahead of where the
/// user had just seeked to. From 21-t:
///
/// ```text
///   17:54:56  target 213,932,125 -> 189,378,154  (back 23.4MB)
///             next gap: 220,982,653-1,566,572,543   <- 31MB PAST the new target
///   17:55:27  target 784,741,192 -> 764,739,913  (back 19.1MB)
///             next gap: 791,791,720-1,566,572,543   <- 27MB PAST the new target
///   17:58:42  target 630,183,660 -> 591,166,600  (back 37.2MB)
///             next gap:   760,217,600-766,509,055   <- 161MB PAST the new target
/// ```
///
/// Only the 17:57:03 seek (59.5MB back) crossed the 50MB bar and re-anchored
/// correctly, which is why the behaviour looked intermittent.
///
/// Both sites now use this one constant, so "big enough to stop the download"
/// and "big enough to move the anchor" cannot drift apart again. It is set to
/// the epsilon so any retarget the estimator considers real also re-anchors the
/// prebuffer — the two decisions answer the same question and must agree.
///
/// This does NOT narrow the prebuffer window: `max_ahead_byte` stays at
/// `total_size` (EOF). Re-anchoring only changes WHERE the sweep resumes from,
/// never how far it runs.
pub const PROACTIVE_BACKWARD_REANCHOR_BYTES: u64 = PROACTIVE_TARGET_EPSILON_BYTES;

/// True when a newly reported target sits far enough BEHIND the current anchor
/// that the prebuffer should abandon its position and restart from the target.
/// Saturating, pure, unit-tested.
pub fn is_backward_reanchor(anchor: u64, new_target: u64) -> bool {
    anchor.saturating_sub(new_target) >= PROACTIVE_BACKWARD_REANCHOR_BYTES
}

/// Round-26: whether a large gap should yield the download semaphore to /stream
/// before fetching, and the pending-flag state to carry to the next gap.
///
/// Returns `(should_yield, still_pending)`.
///
/// Extracted from the sweep loop because the decision was previously inline in a
/// ~400-line async fn, unreachable from any test — and it was WRONG there: the
/// flag was cleared before the loop that read it, so the yield never once ran.
/// See the call site for the full history. Keeping this pure means a test binds
/// to the shipped rule instead of re-implementing it.
///
/// Contract:
/// - `pending && large_gap && stream_is_near` → yield, and clear
/// - `pending && large_gap && !stream_is_near` → DO NOT yield, and clear:
///   the sweep is the viewer's only supply line, so sleeping starves playback
/// - `pending && !large_gap` → no yield, stay armed for the next large gap
/// - `!pending` → never yield, regardless of gap size
pub fn seek_yield_decision(pending: bool, gap_size: u64, stream_is_near: bool) -> (bool, bool) {
    let large_gap = gap_size > PROACTIVE_YIELD_MIN_GAP_BYTES;
    if pending && large_gap {
        (stream_is_near, false)
    } else {
        (false, pending)
    }
}

/// Round-28: how close `/stream`'s in-flight read must be to the sweep's target
/// for the post-seek yield to be worth paying.
///
/// The yield hands the 2-permit download semaphore to `/stream` for 5 s. That is
/// right when `/stream` is serving the seek target — it gets there faster
/// without the sweep competing. It is actively harmful when `/stream` is
/// somewhere else entirely.
///
/// 28-t:187-195, seek to 876.9s: the bisect re-anchored the sweep to the true
/// cluster byte 146,228,823, but `/stream`'s readahead was still marching
/// forward from the pre-seek estimate at 160,825,344 — 13.92 MiB ahead, ~83 s of
/// content away. The sweep yielded to it anyway and slept 5 s, so for those 5 s
/// NOBODY was fetching the bytes under the playhead. The viewer got the ~9 s the
/// keyframe walk had already pulled, played about a second, and stalled into the
/// hole.
///
/// 12 MiB is bounded on both sides by measurement, not taste:
///   - ABOVE `/stream`'s readahead (8 MiB chunk, `TauriStreamSource.ts:25`), plus
///     4 MiB slack, so a `/stream` genuinely serving the target stays NEAR and
///     keeps the round-24 yield.
///   - BELOW the 13.92 MiB actually observed in 28-t, so that stall is classed
///     FAR and the sweep keeps feeding the viewer.
/// A first draft used 16 MiB, which is ABOVE the observed distance and would
/// have shipped a no-op. `near_limit_is_bracketed_by_measurement` pins both ends.
pub const PROACTIVE_YIELD_STREAM_NEAR_BYTES: u64 = 12 * 1024 * 1024;

/// Round-26: minimum gap size that triggers the post-seek yield to /stream.
///
/// The yield costs up to 5 s, so it is only worth paying before a gap large
/// enough that the sweep would otherwise hold the download semaphore for a long
/// time. Small gaps finish fast and are not worth delaying. This is the same
/// 1 MiB threshold the sweep already used to decide "sequential download",
/// named rather than repeated as a literal.
pub const PROACTIVE_YIELD_MIN_GAP_BYTES: u64 = 1024 * 1024;

/// Round-9 I-2b: freshness window for the player_actively_downloading timestamp.
/// Must exceed the TS resume reporter's 10s interval and the MP4 reporter's 2s
/// cadence (so an actively-reporting player never falsely decays) AND cover the
/// longest observed MKV gap between the seek report and the completion re-report
/// (the cold getKeyPacket walk: 14.9s max in 9-c). 20s covers all with margin;
/// after decay the download-semaphore try_acquire remains the fine-grained yield
/// against genuinely active /stream reads.
pub const PLAYER_DOWNLOAD_FRESH_WINDOW_MS: u64 = 20_000;

/// True while a "player is downloading" report is fresh enough to make the
/// proactive prebuffer yield. `stored_ms == 0` means idle (explicit false or
/// never reported). Saturating: a wall-clock step backwards reads as fresh for
/// one window instead of panicking/overflowing. Pure + unit-tested.
pub fn player_download_flag_fresh(now_ms: u64, stored_ms: u64) -> bool {
    stored_ms != 0 && now_ms.saturating_sub(stored_ms) < PLAYER_DOWNLOAD_FRESH_WINDOW_MS
}

pub fn should_defer_proactive_spawn(is_player_downloading: bool) -> bool {
    is_player_downloading
}

/// Should the proactive downloader flush `cached_ranges` metadata after writing
/// up to `offset`?
///
/// The `/remux` poll loop (`server.rs`) discovers downloaded bytes ONLY by
/// re-reading this metadata, so a chunk that is written but not yet *published*
/// is invisible to the player — it keeps sleeping `POLL_INTERVAL_MS` even though
/// the bytes are already on disk. Publishing on a coarse quantum trades that
/// visibility latency for fewer meta writes.
///
/// The steady-state quantum is 1 MiB (2 × 512 KiB chunks) — cheap and frequent
/// enough for a warm sequential fill. But the FIRST chunk of every gap is
/// special: right after open the player has just drained the 6 MiB prefix and is
/// blocked at the frontier, and right after a seek it is blocked at the new
/// anchor. In both cases the very first freshly-downloaded chunk is the one the
/// player is actively waiting on, so publishing it immediately (instead of after
/// a whole MiB) removes ~one 512 KiB/300 ms limiter step — the bulk of the
/// ~1500 ms first-wait seen at open — without adding a single API call. `first`
/// is the per-gap first-write flag, NOT a whole-task flag, so every post-seek
/// gap gets the same fast first reveal.
///
/// `at_gap_end` forces a final flush so the gap's tail range is always recorded.
/// Pure + unit-tested.
pub fn should_publish_proactive_meta(
    offset: u64,
    chunk_size: u64,
    first: bool,
    at_gap_end: bool,
) -> bool {
    first || at_gap_end || offset % (1024 * 1024) < chunk_size
}

/// Round-14 F1: how long a `seek-bisect` probe suppresses the PROACTIVE spawn.
///
/// A cue-less MKV seek runs a byte-range bisect (3-7 probes) and then a forward
/// cluster walk; the user sees no frame until BOTH finish. Log 14-t timed the
/// whole resolve at ~23.9 s (10.5 s bisect + 13.2 s walk), and every probe and
/// walk read is queued behind the same 300 ms-spaced Telegram limiter as any
/// background download.
///
/// 8s is deliberately SHORTER than PLAYER_DOWNLOAD_FRESH_WINDOW_MS (20s): this
/// suppression fires per PROBE and each probe re-arms it, so the effective hold
/// tracks the bisect's real duration instead of a fixed ceiling. Probes landed
/// 3-4 s apart in 14-t, so 8 s spans the gap between consecutive probes with
/// margin while still expiring quickly once the bisect stops.
pub const SEEK_CRITICAL_SUPPRESS_MS: u64 = 8_000;

/// True while a seek-critical read (bisect probe / post-bisect walk) is recent
/// enough that spawning a background prefetch would steal limiter slots from it.
///
/// **Self-expiring by mandate, never a boolean.** Round-9 I-2b is the standing
/// proof: `player_actively_downloading` used to be an `AtomicBool` whose only
/// writer was `cmd_report_playback_position`, so one MKV seek stored `true`,
/// nothing ever cleared it, and PROACTIVE starved to **0 bytes in 70 s** (9-t)
/// with the offset frozen. A timestamp that decays cannot wedge: if the seek is
/// abandoned, the player closes, or the writer dies, suppression lifts on its
/// own. Saturating, so a wall-clock step backwards reads as fresh for one
/// window instead of overflowing. Pure + unit-tested.
pub fn seek_critical_read_fresh(now_ms: u64, stored_ms: u64) -> bool {
    stored_ms != 0 && now_ms.saturating_sub(stored_ms) < SEEK_CRITICAL_SUPPRESS_MS
}

/// True when a `/stream` request is one the user is actively BLOCKED on, and so
/// should suppress background prefetch while it runs.
///
/// Only `seek-bisect` qualifies. Deliberately narrow, and that narrowness is a
/// design constraint rather than caution (round-14 review): the seek call site
/// (`useMSEPlayer.ts`, `cmd_report_playback_position`) hardcodes
/// `isPlayerDownloading: true` and `byteOffset: Some(..)` for EVERY seek, so a
/// seek report cannot distinguish
///   - a seek into an already-cached region (no bisect runs — F1.5), or
///   - an MP4/TS seek (real index, never bisects — F1.6)
/// from a cue-less MKV bisect. Keying on the probe's own `source_id` means
/// suppression happens exactly when a bisect is really in flight.
///
/// `playback` is excluded on purpose: it is user-blocking near the playhead but
/// is also the stale forward-walk left behind by a seek, and telling those apart
/// needs distance-to-playhead (round-14 F2.3, still undesigned).
pub fn is_seek_critical_source(source_id: Option<&str>) -> bool {
    matches!(source_id, Some("seek-bisect"))
}

/// Current UNIX-epoch milliseconds for the freshness timestamp.
pub(crate) fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// True if a newly reported proactive target is far enough from the current
/// target to be worth acting on (re-evaluating gaps / sliding the window).
/// Pure + saturating so it can be unit-tested and never panics on unordered
/// operands. A move of exactly the epsilon counts as significant.
pub fn is_significant_target_change(current: u64, new_target: u64) -> bool {
    new_target.abs_diff(current) >= PROACTIVE_TARGET_EPSILON_BYTES
}

pub fn should_retarget_proactive(
    backfilling: bool,
    offset: u64,
    previous_target: Option<u64>,
    target: u64,
) -> bool {
    if backfilling {
        return previous_target.is_some_and(|previous| is_backward_reanchor(previous, target));
    }
    target > offset + 10 * 1024 * 1024 ||
        previous_target.is_some_and(|previous| is_backward_reanchor(previous, target))
}

/// Holds the per-session streaming config (token + port)
pub struct StreamConfig {
    pub token: String,
    pub port: u16,
}

/// Per-download-task keyframe-indexing context. Carries the lazily-resolved
/// TsStreamInfo and the cross-chunk KeyframeScanState so that keyframes whose
/// PES straddles a 512KB chunk boundary are still detected (scan_keyframes_chunked
/// assembles partial PES across calls when handed the same state). `is_m2ts` is
/// auto-detected from the cached head during the first successful resolve.
struct KeyframeIndexer {
    stream_info: Option<crate::ts_demux::TsStreamInfo>,
    scan_state: crate::ts_demux::KeyframeScanState,
    is_m2ts: bool,
    /// Number of times we've tried (and failed) to resolve stream_info from the
    /// cached head, so we can log the first attempt/failure at info level once
    /// instead of spamming per chunk.
    resolve_attempts: u32,
    /// Absolute byte offset the NEXT contiguous chunk is expected to start at
    /// (i.e. end+1 of the last scanned chunk). The proactive/bg download feed is
    /// contiguous WITHIN a gap but JUMPS on seeks; the cross-chunk PES assembler
    /// (KeyframeScanState) is only valid across a contiguous run, so on a jump we
    /// flush + reset it. None = no chunk scanned yet.
    expected_next_offset: Option<u64>,
    /// Total bytes scanned + last byte-count at which we logged depth, so we can
    /// report index growth by byte interval (the old %256 throttle hid 1..255).
    scanned_bytes: u64,
    last_logged_bytes: u64,
}

impl KeyframeIndexer {
    fn new() -> Self {
        Self {
            stream_info: None,
            scan_state: crate::ts_demux::KeyframeScanState::default(),
            is_m2ts: false,
            resolve_attempts: 0,
            expected_next_offset: None,
            scanned_bytes: 0,
            last_logged_bytes: 0,
        }
    }
}

/// Scan a just-written chunk for video keyframes and merge them into the shared
/// progressive index on TelegramState. Best-effort: any failure logs at debug
/// and returns without disturbing the download. MUST be called OUTSIDE any
/// cache_mgr.lock_meta() critical section (it takes the index write lock, and we
/// never want to nest those two locks).
///
/// `abs_offset` is the file byte position of `chunk` (the bytes just written).
/// stream_info + m2ts flag are resolved lazily from the cached head the first
/// time it's available; until then chunks are skipped (and re-tried as the head
/// fills).
async fn index_keyframes_from_chunk(
    indexer: &mut KeyframeIndexer,
    chunk: &[u8],
    abs_offset: u64,
    message_id: i32,
    total_size: u64,
    cache_mgr: &StreamCacheManager,
    state: &Arc<TelegramState>,
) {
    // Resolve stream_info once from the cached head (PAT/PMT live in the first
    // packets). If not yet available, skip — a later cycle will retry.
    if indexer.stream_info.is_none() {
        let data_path = cache_mgr.data_path(message_id);
        let head_len = (5 * 1024 * 1024).min(total_size as usize);
        if head_len > 0 {
            if let Ok(mut f) = std::fs::File::open(&data_path) {
                let mut head = vec![0u8; head_len];
                use std::io::Read;
                if f.read_exact(&mut head).is_ok() {
                    // Detect packet layout from sync-byte stride. Regular TS has
                    // 0x47 at 0/188/376; M2TS/BDAV has a 4-byte prefix so 0x47 is
                    // at 4/196/388. Prefer the plain-TS interpretation; only treat
                    // as M2TS when the 188-stride check fails AND the 192+4 does.
                    let plain_ts = head.len() >= 377
                        && head[0] == 0x47 && head[188] == 0x47 && head[376] == 0x47;
                    let is_m2ts = !plain_ts
                        && head.len() >= 389
                        && head[4] == 0x47 && head[196] == 0x47 && head[388] == 0x47;
                    let head_ts = crate::ts_demux::strip_m2ts_prefix(&head, is_m2ts);
                    if let Some(si) = crate::ts_demux::extract_stream_info(&head_ts) {
                        log::info!("[KF-INDEX] msg {}: stream_info resolved (video_pid={}, m2ts={}) — indexing enabled",
                            message_id, si.video_pid, is_m2ts);
                        indexer.is_m2ts = is_m2ts;
                        indexer.stream_info = Some(si);
                    }
                }
            }
        }
        if indexer.stream_info.is_none() {
            indexer.resolve_attempts += 1;
            // Log the first failure at info (once) so a never-indexing run is
            // diagnosable without debug logging.
            if indexer.resolve_attempts == 1 {
                log::info!("[KF-INDEX] msg {}: stream_info not resolvable from cached head yet (will retry as head fills)", message_id);
            }
            return; // head not ready yet; retry on a later chunk
        }
    }

    // DISCONTINUITY HANDLING: the cross-chunk PES assembler in KeyframeScanState
    // is only valid across a CONTIGUOUS byte run. The proactive/bg feed is
    // contiguous within a download gap but JUMPS on seeks (playhead jumps to a
    // far byte). When this chunk doesn't continue the previous one, flush the old
    // state (emit its final buffered keyframe) and start fresh — otherwise the
    // assembler corrupts a partial PES with bytes from an unrelated region and
    // stops emitting keyframes entirely (observed: 63MB downloaded, 1 indexed).
    let is_discontinuous = match indexer.expected_next_offset {
        Some(expected) => abs_offset != expected,
        None => false,
    };

    // Take stream_info by clone so we don't hold an immutable borrow of `indexer`
    // while we also mutate its scan_state below.
    let si = match indexer.stream_info.clone() {
        Some(si) => si,
        None => return,
    };

    if is_discontinuous {
        // Flush the pre-jump run's trailing PES, merge it, then reset the state.
        let tail = crate::ts_demux::scan_keyframes_flush(0, &si, &mut indexer.scan_state);
        if !tail.is_empty() {
            let mut index = state.proactive_keyframe_index.write().await;
            let entry = index.entry(message_id).or_default();
            crate::ts_demux::merge_keyframe_samples(entry, total_size, &tail, (0, 0));
            drop(index);
        }
        indexer.scan_state = crate::ts_demux::KeyframeScanState::default();
    }

    // M2TS chunks carry a 4-byte prefix per packet; strip so PID parsing aligns.
    let scan_buf: std::borrow::Cow<[u8]> = if indexer.is_m2ts {
        std::borrow::Cow::Owned(crate::ts_demux::strip_m2ts_prefix(chunk, true))
    } else {
        std::borrow::Cow::Borrowed(chunk)
    };

    let kfs = crate::ts_demux::scan_keyframes_chunked(
        &scan_buf, abs_offset, &si, &mut indexer.scan_state,
    );
    indexer.expected_next_offset = Some(abs_offset + chunk.len() as u64);
    indexer.scanned_bytes += chunk.len() as u64;

    if !kfs.is_empty() {
        let scanned_range = (abs_offset, abs_offset + chunk.len() as u64 - 1);
        let mut index = state.proactive_keyframe_index.write().await;
        let entry = index.entry(message_id).or_default();
        crate::ts_demux::merge_keyframe_samples(entry, total_size, &kfs, scanned_range);
        let n = entry.samples.len();
        drop(index);
        // Depth-visible log: report total every ~5MB scanned (not per-256-count,
        // which hid growth below 256). Shows the index climbing on a live run.
        if indexer.scanned_bytes - indexer.last_logged_bytes >= 5 * 1024 * 1024
            || indexer.last_logged_bytes == 0
        {
            indexer.last_logged_bytes = indexer.scanned_bytes;
            log::info!(
                "[KF-INDEX] msg {}: {} keyframes indexed ({} MB scanned, latest @byte {})",
                message_id, n, indexer.scanned_bytes / 1024 / 1024, abs_offset
            );
        }
    }
}

/// Returned to the frontend so it can construct stream URLs dynamically
#[derive(serde::Serialize)]
pub struct StreamInfo {
    pub token: String,
    /// HTTP base URL for fetch-based streaming (MSE pipeline, thumbnail extraction).
    /// Also used for native <video> src on all platforms since PNA CORS headers
    /// allow cross-port localhost media loading.
    /// Example: http://localhost:14201
    pub base_url: String,
    /// Custom protocol base URL for <video> element src attribute.
    /// DEPRECATED: no longer used for native video on any platform.
    /// The direct HTTP base_url with CORS + PNA headers works reliably on
    /// all platforms, bypassing WebView2 URL safety checks and LNA/PNA
    /// restrictions. Kept for backward compatibility with older frontend code
    /// that may still reference this field.
    /// Example (Windows): http://nobuf-stream.localhost
    /// Example (macOS/Linux): nobuf-stream://localhost
    pub video_base_url: String,
}

/// Returns the streaming server's session token and base URL to the frontend.
/// The frontend must use the returned base_url to construct stream URLs,
/// never hardcoding the port.
///
/// Both base_url and video_base_url are provided, but the frontend should
/// prefer base_url (direct HTTP) for all purposes including native <video>
/// src. The Actix streaming server now includes CORS headers with
/// Access-Control-Allow-Private-Network: true, which allows cross-port
/// localhost requests even under Chromium's LNA/PNA restrictions.
#[tauri::command]
pub fn cmd_get_stream_info(config: State<'_, StreamConfig>) -> StreamInfo {
    // On Windows, WebView2 requires custom protocol URLs in http://SCHEME.localhost format.
    // See: wry src/webview2/mod.rs `attach_custom_protocol_handler`, `work_around_uri_prefix`,
    // and `is_work_around_uri`. The `AddWebResourceRequestedFilter` only intercepts
    // `http://nobuf-stream.localhost/*` — `nobuf-stream://localhost/*` is never matched.
    let video_base_url = if cfg!(windows) {
        "http://nobuf-stream.localhost".to_string()
    } else {
        "nobuf-stream://localhost".to_string()
    };

    StreamInfo {
        token: config.token.clone(),
        base_url: format!("http://localhost:{}", config.port),
        video_base_url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Round-9 1b: player_actively_downloading freshness decay (I-2b) ---
    // The MKV seek report stores `true` and nothing ever cleared it (the flag's
    // ONLY writer is cmd_report_playback_position; MKV has no periodic
    // reporter), so PROACTIVE's secondary throttle yielded forever — 9-t shows
    // 0 bytes downloaded in 70s with the offset frozen. The flag becomes a
    // timestamp that decays after PLAYER_DOWNLOAD_FRESH_WINDOW_MS.

    #[test]
    fn download_flag_zero_means_idle() {
        assert!(!player_download_flag_fresh(1_000_000, 0));
        assert!(!should_defer_proactive_spawn(false));
        assert!(should_defer_proactive_spawn(true));
    }

    // --- Meta publish granularity: the initial-open fetch "drop" fix ---
    // The /remux poll loop only SEES downloaded bytes when the proactive task
    // publishes cached_ranges. Publishing on a 1 MiB quantum meant that after
    // draining the 6 MiB prefix the player waited ~one extra MiB (~1500ms) for
    // the first reveal. The fix flushes the first write of EVERY gap immediately.
    const CS: u64 = 512 * 1024; // TELEGRAM_CHUNK_SIZE

    #[test]
    fn publish_first_chunk_of_a_gap_immediately() {
        // The very first 512 KiB write of a gap (offset just past a non-MiB
        // gap_start) must publish even though it is NOT on a 1 MiB boundary —
        // this is the byte the player is blocked on at open / after a seek.
        let gap_start = 6 * 1024 * 1024; // the 6 MiB prefix frontier
        let offset = gap_start + CS; // one chunk in; 6.5 MiB, not a MiB boundary
        assert_ne!(offset % (1024 * 1024), 0, "test byte must be off the MiB grid");
        assert!(
            should_publish_proactive_meta(offset, CS, true, false),
            "first write of a gap must publish immediately regardless of MiB alignment",
        );
    }

    #[test]
    fn steady_state_still_publishes_only_on_mib_boundaries() {
        // After the first chunk (first=false), a mid-MiB offset must NOT publish
        // — otherwise we'd double the meta-write rate for a warm sequential fill.
        let offset = 8 * 1024 * 1024 + CS; // 8.5 MiB, mid-MiB, not first
        assert!(
            !should_publish_proactive_meta(offset, CS, false, false),
            "a mid-MiB steady write must not publish (keeps the 1 MiB quantum)",
        );
        // …but the MiB boundary itself still publishes.
        assert!(should_publish_proactive_meta(9 * 1024 * 1024, CS, false, false));
    }

    #[test]
    fn gap_end_always_publishes_even_mid_mib() {
        // The tail of a gap must be recorded even if it lands off the MiB grid,
        // or the last sub-MiB range would stay invisible until the next gap.
        let offset = 3 * 1024 * 1024 + 7 * CS; // 3.5 MiB, mid-MiB, not first
        assert!(
            should_publish_proactive_meta(offset, CS, false, true),
            "at_gap_end must force a final flush regardless of alignment",
        );
    }

    #[test]
    fn first_chunk_landing_on_mib_boundary_is_not_double_counted() {
        // Sanity: when the first write happens to land exactly on a MiB boundary
        // both terms are true; the OR still yields a single publish (idempotent).
        assert!(should_publish_proactive_meta(1024 * 1024, CS, true, false));
    }

    // --- Round-14 F1: seek-critical suppression of the PROACTIVE spawn ---
    // 14-t:184-187 — an 893MB prefetch spawned in the SAME SECOND as bisect
    // probe 1, then probes landed 3-4s apart against a 1.2s uncontended floor.
    // The cold-start guard that would have deferred it is gated on
    // `byte_offset.is_none()`, and a seek always carries Some(..) — so the one
    // guard that could help is disabled precisely on the seek path.

    #[test]
    fn seek_critical_zero_means_no_bisect_in_flight() {
        // Never stamped => never suppress. A fresh process must not start life
        // holding PROACTIVE off.
        assert!(!seek_critical_read_fresh(1_000_000, 0));
    }

    #[test]
    fn seek_critical_fresh_within_window() {
        let now = 1_000_000u64;
        assert!(seek_critical_read_fresh(now, now));
        assert!(seek_critical_read_fresh(now, now - (SEEK_CRITICAL_SUPPRESS_MS - 1)));
    }

    /// F1.1 — the suppression MUST self-expire. Round-9 I-2b: a sticky
    /// `AtomicBool` here starved PROACTIVE to 0 bytes in 70s because the only
    /// writer never cleared it. A timestamp cannot wedge.
    #[test]
    fn seek_critical_expires_without_any_explicit_clear() {
        let stamped = 1_000_000u64;
        assert!(
            !seek_critical_read_fresh(stamped + SEEK_CRITICAL_SUPPRESS_MS, stamped),
            "suppression must lapse at exactly the window edge"
        );
        assert!(
            !seek_critical_read_fresh(stamped + 70_000, stamped),
            "70s is the round-9 I-2b starvation duration — must be long expired"
        );
    }

    /// F1.3 — sustained scrubbing keeps re-arming (correct: the user is actively
    /// seeking), but PROACTIVE resumes within one window after it stops.
    #[test]
    fn seek_critical_rearms_while_scrubbing_then_resumes() {
        let mut now = 1_000_000u64;
        let mut stamped = now;
        // Five probes, each 3s apart (the 14-t spacing). Suppressed throughout.
        for _ in 0..5 {
            now += 3_000;
            stamped = now; // a probe re-arms
            assert!(seek_critical_read_fresh(now, stamped), "still bisecting");
        }
        // Scrubbing stops; no further probes.
        assert!(
            !seek_critical_read_fresh(stamped + SEEK_CRITICAL_SUPPRESS_MS, stamped),
            "PROACTIVE must resume within one window of the last probe"
        );
    }

    /// A wall-clock step backwards must not overflow or wedge suppression on.
    #[test]
    fn seek_critical_survives_backwards_clock() {
        let stamped = 2_000_000u64;
        assert!(seek_critical_read_fresh(1_000_000, stamped));
    }

    /// F1.5 / F1.6 — suppression keys on the PROBE's source_id, so a seek into a
    /// cached region (no bisect) and an MP4/TS seek (real index, never bisects)
    /// do NOT suppress. This is why the trigger cannot live on the seek report:
    /// that call site hardcodes isPlayerDownloading:true + byteOffset:Some(..)
    /// for every seek, making all three cases identical from there.
    #[test]
    fn only_seek_bisect_is_seek_critical() {
        assert!(is_seek_critical_source(Some("seek-bisect")));

        for other in [
            "playback",      // F2.3: P0 near playhead, P2 as stale walk — undecidable here
            "playback-tail",
            "warmer",
            "thumbnail",
            "thumbnail-tail",
            "subs",
            "tracks",
        ] {
            assert!(
                !is_seek_critical_source(Some(other)),
                "'{other}' must not suppress background prefetch"
            );
        }
        assert!(!is_seek_critical_source(None), "unlabelled reads never suppress");
    }

    #[test]
    fn download_flag_fresh_within_window() {
        let now = 10_000_000u64;
        assert!(player_download_flag_fresh(now, now)); // just stored
        assert!(player_download_flag_fresh(now, now - (PLAYER_DOWNLOAD_FRESH_WINDOW_MS - 1)));
    }

    #[test]
    fn download_flag_decays_at_window() {
        let now = 10_000_000u64;
        assert!(!player_download_flag_fresh(now, now - PLAYER_DOWNLOAD_FRESH_WINDOW_MS));
        assert!(!player_download_flag_fresh(now, now - (PLAYER_DOWNLOAD_FRESH_WINDOW_MS + 5_000)));
    }

    #[test]
    fn download_flag_window_covers_reporters_and_max_walk() {
        // MP4 reporter: 2s cadence; TS resume reporter: 10s; longest observed
        // MKV cold walk between seek report and completion re-report: 14.9s.
        assert!(PLAYER_DOWNLOAD_FRESH_WINDOW_MS > 15_000);
    }

    #[test]
    fn download_flag_clock_jump_is_fresh_not_panic() {
        // stored > now (wall clock stepped back): saturating_sub → 0 → fresh.
        // Worst case is one mis-timed yield window — documented, never a panic.
        assert!(player_download_flag_fresh(1_000, 2_000));
    }

    // --- VBR proactive-target dead-band (issue #4) ---

    #[test]
    fn dead_band_ignores_plus_minus_one_byte_jitter() {
        // The exact jitter observed in the logs must NOT count as a retarget.
        assert!(!is_significant_target_change(1353514972, 1353514971));
        assert!(!is_significant_target_change(703432598, 703432597));
        assert!(!is_significant_target_change(472248289, 472248288));
        // Symmetric: order of operands must not matter.
        assert!(!is_significant_target_change(1353514971, 1353514972));
    }

    // --- Round-26 T2: coverage-derived sweep resume point ---
    //
    // These replace the round-22 F3 / round-23 G1a hand-off tests. Those asserted
    // a fixed `+PROACTIVE_STREAM_HANDOFF_BYTES` offset through a test-LOCAL copy
    // of the production rule (`fn resume_byte`). Once production derives the
    // resume point from coverage, that mirrored helper still compiled and still
    // passed while testing a rule the binary no longer contains — vacuously green.
    // Deleted rather than adapted, and re-expressed against the real `find_gaps`.

    /// Binds directly to the SHIPPED function. An earlier revision of this block
    /// re-implemented the rule locally; mutation testing then showed the tests
    /// stayed green while production was reverted to the old +26 MiB hand-off —
    /// vacuous, and exactly the failure the deleted F3 tests had.
    fn resume_byte(ranges: &[(u64, u64)], total_size: u64, start_byte: u64) -> u64 {
        super::proactive_resume_byte(ranges, total_size, start_byte)
    }

    /// The 25-t defect, byte-exact: an 11.43 MiB band in front of the viewer that
    /// NEITHER reader fetched, because the sweep skipped a fixed 26 MiB ahead.
    #[test]
    fn resume_covers_the_band_nobody_fetched_in_round25() {
        const TOTAL: u64 = 1_566_651_347;
        let playhead = 470_697_938_u64;
        // Coverage at the re-anchor: a 0-prefix, plus what /stream had pulled
        // around the seek target. The hole in between is the unfetched band.
        let ranges = vec![(0, 33_554_432_u64), (482_679_264, 490_000_000)];

        let resume = resume_byte(&ranges, TOTAL, playhead);
        assert_eq!(
            resume, playhead,
            "the sweep must resume AT the viewer when the byte under the \
             playhead is uncached, not 26 MiB past it",
        );

        // The old rule's resume point, and the hole it left. 26 MiB is spelled
        // out rather than referenced: the constant is deleted, and this test
        // documents the historical behaviour it produced.
        const OLD_HANDOFF: u64 = 26 * 1024 * 1024;
        let old = playhead + OLD_HANDOFF;
        assert_eq!(old, 497_960_914, "the exact resume point logged in 25-t");
        assert_eq!(
            482_679_264_u64 - playhead, 11_981_326,
            "the band between the playhead and /stream's first byte",
        );
        assert!(resume < 482_679_264, "resume must fall inside the unfetched band");
    }

    /// When /stream HAS covered the playhead region, the sweep must skip past it
    /// instead of re-downloading it. This is the property the hand-off constant
    /// was reaching for; deriving it from coverage gets it exactly right.
    #[test]
    fn resume_skips_bytes_stream_already_holds() {
        const TOTAL: u64 = 1_566_651_347;
        let playhead = 470_697_938_u64;
        // /stream covers the playhead and 8 MiB beyond it.
        let covered_to = playhead + 8 * 1024 * 1024;
        let ranges = vec![(0, 33_554_432_u64), (playhead - 1_000, covered_to)];

        let resume = resume_byte(&ranges, TOTAL, playhead);
        assert_eq!(
            resume, covered_to + 1,
            "must resume at the first byte after existing coverage, never inside it",
        );
        // And it is derived, not a constant: it tracks the coverage edge.
        let ranges2 = vec![(0, 33_554_432_u64), (playhead - 1_000, covered_to + 4 * 1024 * 1024)];
        assert_eq!(resume_byte(&ranges2, TOTAL, playhead), covered_to + 4 * 1024 * 1024 + 1);
    }

    /// Direction-agnostic by construction. The old rule needed a `jumped_backward`
    /// flag threaded through the loop precisely because a fixed offset is applied
    /// blindly; two rounds of bugs (F3, G1a) came from that flag being wrong.
    /// Coverage has no direction, so those bug classes cannot recur.
    #[test]
    fn resume_needs_no_direction_flag() {
        const TOTAL: u64 = 1_566_651_347;
        let ranges = vec![(0, 33_554_432_u64), (600_000_000, 700_000_000)];
        // Backward re-anchors from 23-t: uncached playhead → resume at the viewer.
        for anchor in [466_844_450_u64, 814_611_884, 949_183_548] {
            assert_eq!(
                resume_byte(&ranges, TOTAL, anchor), anchor,
                "uncached playhead {anchor} must be swept, whichever way the seek went",
            );
        }
        // A playhead inside cached coverage resumes after it — again regardless
        // of the seek direction that put the viewer there.
        assert_eq!(resume_byte(&ranges, TOTAL, 650_000_000), 700_000_001);
    }

    /// Cold open: byte 0 with nothing cached must sweep from 0, never be offset
    /// past the head of the file.
    #[test]
    fn resume_at_cold_open_starts_at_zero() {
        assert_eq!(resume_byte(&[], 1_566_651_347, 0), 0);
    }

    /// `load_meta` returns None for a missing / empty / corrupt meta file, which
    /// collapses `current_ranges` to empty. The first gap is then (0, total-1),
    /// whose end is >= any playhead — so without the `.max(start_byte)` clamp the
    /// sweep would restart the entire file from byte 0 behind the viewer.
    #[test]
    fn resume_never_walks_backward_when_meta_is_missing() {
        const TOTAL: u64 = 1_566_651_347;
        let playhead = 800_000_000_u64;
        assert_eq!(
            resume_byte(&[], TOTAL, playhead), playhead,
            "empty coverage must not send the sweep back to byte 0",
        );
        // Same guarantee for a playhead beyond all recorded coverage.
        assert_eq!(resume_byte(&[(0, 1_000_u64)], TOTAL, playhead), playhead);
    }

    /// A fully cached file has no gap at or after the playhead: fall back to the
    /// playhead itself and let the caller's `ahead_gaps` filter find nothing and
    /// idle out, rather than panicking or resuming at 0.
    #[test]
    fn resume_falls_back_to_playhead_when_fully_cached() {
        const TOTAL: u64 = 100_000;
        let full = vec![(0, TOTAL - 1)];
        assert_eq!(resume_byte(&full, TOTAL, 50_000), 50_000);
        assert!(find_gaps(&full, TOTAL).is_empty(), "fixture must really be complete");
    }

    /// The resume point must never exceed the end of the file, at the last byte.
    #[test]
    fn resume_stays_in_bounds_at_eof() {
        const TOTAL: u64 = 1_566_651_347;
        let last = TOTAL - 1;
        let ranges = vec![(0, 33_554_432_u64)];
        let resume = resume_byte(&ranges, TOTAL, last);
        assert!(resume <= last, "resume {resume} past EOF {last}");
        assert_eq!(resume, last);
    }

    #[test]
    fn whole_file_warmer_prioritizes_forward_gap() {
        let ranges = [(0, 99), (200, 299), (400, 999)];
        assert_eq!(super::proactive_whole_file_resume(&ranges, 1_000, 150), Some((150, false)));
    }

    #[test]
    fn whole_file_warmer_backfills_after_forward_path_reaches_eof() {
        assert_eq!(
            super::proactive_whole_file_resume(&[(100, 999)], 1_000, 500),
            Some((0, true)),
        );
    }

    #[test]
    fn whole_file_warmer_stops_only_when_globally_complete() {
        assert_eq!(super::proactive_whole_file_resume(&[(0, 999)], 1_000, 500), None);
    }

    #[test]
    fn backfill_candidates_include_holes_before_playhead() {
        let ranges = [(100, 999)];
        assert_eq!(
            super::proactive_candidate_gaps(&ranges, 1_000, 0, 1_000, true),
            vec![(0, 99)],
        );
        assert!(super::proactive_candidate_gaps(&ranges, 1_000, 500, 1_000, false).is_empty());
    }

    #[test]
    fn stable_playhead_does_not_interrupt_backfill_behind_it() {
        assert!(!super::should_retarget_proactive(true, 0, None, 500 * 1024 * 1024));
        assert!(!super::should_retarget_proactive(
            true, 8 * 1024 * 1024, Some(500 * 1024 * 1024), 500 * 1024 * 1024,
        ));
    }

    #[test]
    fn backward_seek_interrupts_backfill_to_reprioritize_viewer() {
        assert!(super::should_retarget_proactive(
            true, 8 * 1024 * 1024, Some(500 * 1024 * 1024), 480 * 1024 * 1024,
        ));
    }

    #[test]
    fn forward_playback_does_not_interrupt_backfill() {
        assert!(!super::should_retarget_proactive(
            true, 8 * 1024 * 1024, Some(500 * 1024 * 1024), 540 * 1024 * 1024,
        ));
    }

    #[test]
    fn forward_mode_keeps_existing_jump_rules() {
        assert!(super::should_retarget_proactive(false, 100, None, 20 * 1024 * 1024));
        assert!(super::should_retarget_proactive(
            false, 500 * 1024 * 1024, Some(500 * 1024 * 1024), 480 * 1024 * 1024,
        ));
    }

    // --- Round-26 T6: the post-seek yield that had never executed ---
    //
    // `jumped` was cleared unconditionally at the top of every outer iteration,
    // while the only read sat inside the gap loop below it. Every arming site
    // reached the read through that clear, so `if jumped` was ALWAYS false and
    // the 5s hand-off to /stream never once ran — rustc reported all three
    // assignments as "never read" and the warning was tolerated for rounds.
    //
    // These bind to the shipped `seek_yield_decision`.

    const BIG: u64 = super::PROACTIVE_YIELD_MIN_GAP_BYTES + 1;
    const SMALL: u64 = 4096;
    /// Most pre-round-28 cases assumed /stream was sitting on the seek target.
    const NEAR: bool = true;
    const FAR: bool = false;

    #[test]
    fn armed_jump_yields_on_the_first_large_gap() {
        let (should_yield, pending) = super::seek_yield_decision(true, BIG, NEAR);
        assert!(should_yield, "an armed jump MUST yield — this is the bug that shipped");
        assert!(!pending, "and the flag must be consumed");
    }

    /// The regression itself: a jump must survive from the outer loop into the
    /// gap that reads it. Simulates one outer iteration over several gaps.
    #[test]
    fn jump_survives_into_the_gap_loop() {
        let mut pending = true; // set by a backward re-anchor / playhead jump
        let mut yields = 0;
        for gap in [BIG, BIG, BIG] {
            let (y, next) = super::seek_yield_decision(pending, gap, NEAR);
            pending = next;
            if y { yields += 1; }
        }
        assert_eq!(yields, 1, "exactly one yield per jump, not one per gap");
    }

    /// A jump arriving before a run of small gaps must stay armed, not be
    /// silently discarded — otherwise the hand-off is lost again, just later.
    #[test]
    fn small_gaps_do_not_consume_the_jump() {
        let mut pending = true;
        for gap in [SMALL, SMALL, SMALL] {
            let (y, next) = super::seek_yield_decision(pending, gap, NEAR);
            assert!(!y, "small gaps are not worth a 5s yield");
            pending = next;
        }
        assert!(pending, "the jump must still be armed for the next large gap");
        let (y, next) = super::seek_yield_decision(pending, BIG, NEAR);
        assert!(y, "and it must fire when a large gap finally arrives");
        assert!(!next);
    }

    /// Steady sequential prebuffering must never yield: that would add 5s per
    /// gap to normal playback, which is why the flag exists at all.
    #[test]
    fn unarmed_sweep_never_yields() {
        for gap in [SMALL, BIG, u64::MAX] {
            for near in [NEAR, FAR] {
                let (y, pending) = super::seek_yield_decision(false, gap, near);
                assert!(!y, "no jump means no yield (gap {gap}, near {near})");
                assert!(!pending);
            }
        }
    }

    /// The threshold is a strict `>`, matching the sequential-download branch it
    /// guards. Pinned so the two cannot silently drift apart.
    #[test]
    fn yield_threshold_boundary_is_exact() {
        let at = super::PROACTIVE_YIELD_MIN_GAP_BYTES;
        assert_eq!(super::seek_yield_decision(true, at, NEAR), (false, true), "exactly at the threshold is not 'large'");
        assert_eq!(super::seek_yield_decision(true, at + 1, NEAR), (true, false));
        assert_eq!(super::seek_yield_decision(true, 0, NEAR), (false, true));
    }

    // --- Round-28: the yield must not starve the viewer ---

    /// THE 28-t STALL. The bisect re-anchored the sweep to the true cluster
    /// byte, but /stream's readahead was still 14.6 MiB away at the pre-seek
    /// estimate. Yielding to it meant nobody fetched the playhead's bytes for
    /// 5s: the viewer played ~1s and stalled.
    #[test]
    fn far_stream_does_not_win_the_yield() {
        let (should_yield, pending) = super::seek_yield_decision(true, BIG, FAR);
        assert!(
            !should_yield,
            "yielding to a /stream that is nowhere near the gap starves playback",
        );
        assert!(
            !pending,
            "and the jump must still be consumed — otherwise every later gap re-tests it",
        );
    }

    /// The round-24 win is kept for the case it was written for: /stream really
    /// is serving the seek target, so standing aside gets the viewer data sooner.
    #[test]
    fn near_stream_still_wins_the_yield() {
        assert_eq!(super::seek_yield_decision(true, BIG, NEAR), (true, false));
    }

    /// The near/far test is only consulted for gaps large enough to matter, and
    /// a small gap must still leave the jump armed regardless of distance.
    #[test]
    fn distance_is_irrelevant_for_small_gaps() {
        assert_eq!(super::seek_yield_decision(true, SMALL, NEAR), (false, true));
        assert_eq!(super::seek_yield_decision(true, SMALL, FAR), (false, true));
    }

    /// The limit is bracketed by measurement on BOTH sides. A first draft used
    /// 16 MiB, which sits ABOVE the 13.92 MiB distance actually observed in
    /// 28-t — the fix would have compiled, passed every other test here, and
    /// changed nothing on the exact stall it was written for.
    #[test]
    fn near_limit_is_bracketed_by_measurement() {
        // 28-t geometry: /stream at 160,825,344, sweep re-anchored to 146,228,823.
        const OBSERVED_28T: u64 = 160_825_344 - 146_228_823;
        assert_eq!(OBSERVED_28T, 14_596_521, "re-derived from 28-t:188/191");

        // UPPER BOUND — the observed stall must be classed FAR, or this is a no-op.
        assert!(
            super::PROACTIVE_YIELD_STREAM_NEAR_BYTES < OBSERVED_28T,
            "near limit {} B >= the {} B observed in 28-t: that stall would still \
             yield and still starve the viewer",
            super::PROACTIVE_YIELD_STREAM_NEAR_BYTES,
            OBSERVED_28T,
        );
        let (should_yield, _) = super::seek_yield_decision(
            true, BIG, OBSERVED_28T <= super::PROACTIVE_YIELD_STREAM_NEAR_BYTES,
        );
        assert!(!should_yield, "the 28-t seek must not yield under the shipped limit");

        // LOWER BOUND — /stream's own readahead must still count as NEAR, or the
        // round-24 yield never fires again. TauriStreamSource.ts:25 = 8 MiB.
        const STREAM_READAHEAD_BYTES: u64 = 8 * 1024 * 1024;
        assert!(
            super::PROACTIVE_YIELD_STREAM_NEAR_BYTES > STREAM_READAHEAD_BYTES,
            "near limit {} B is at or below /stream's {} B readahead — a /stream \
             genuinely working the seek target would be classed far",
            super::PROACTIVE_YIELD_STREAM_NEAR_BYTES,
            STREAM_READAHEAD_BYTES,
        );
        let (yields_when_serving, _) = super::seek_yield_decision(
            true, BIG, STREAM_READAHEAD_BYTES <= super::PROACTIVE_YIELD_STREAM_NEAR_BYTES,
        );
        assert!(yields_when_serving, "a /stream one readahead away must still win the yield");
    }


    // --- Round-26 T4: coalescing sub-chunk holes ---

    const CHUNK: u64 = 512 * 1024;

    /// Binds to the SHIPPED coalescer, for the same reason as `resume_byte`
    /// above: a mirrored copy passed while production coalescing was disabled.
    fn coalesce(gaps: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
        super::coalesce_sub_chunk_gaps(gaps, CHUNK)
    }

    /// The bound that matters: one download iterator per merged gap, and each
    /// iterator's smallest unit is a 512 KiB chunk holding a semaphore permit.
    /// Fifty 1-byte holes must not cost fifty round trips.
    #[test]
    fn tiny_holes_coalesce_into_few_requests() {
        // 50 one-byte holes spread through a 10 MB span, 200 KB apart — i.e. much
        // closer together than one chunk.
        let base = 100_000_000_u64;
        let gaps: Vec<(u64, u64)> = (0..50).map(|i| {
            let at = base + i * 200_000;
            (at, at)
        }).collect();
        assert_eq!(gaps.len(), 50, "fixture must really have 50 holes");

        let merged = coalesce(gaps);
        assert!(
            merged.len() <= 25,
            "coalescing is mandatory: {} holes still cost {} requests",
            50, merged.len(),
        );
        // In fact they are all within one chunk of each other, so this collapses
        // to a single fetch.
        assert_eq!(merged.len(), 1, "200KB spacing is sub-chunk — expect one merged gap");
        assert_eq!(merged[0].0, base);
        assert_eq!(merged[0].1, base + 49 * 200_000);
    }

    /// Gaps genuinely far apart must NOT be merged — that would make the sweep
    /// re-download large cached regions between them.
    #[test]
    fn distant_gaps_are_not_merged() {
        let gaps = vec![
            (100_000_000_u64, 100_100_000),
            (200_000_000, 200_100_000),   // 100 MB of cached data in between
            (300_000_000, 300_100_000),
        ];
        let merged = coalesce(gaps.clone());
        assert_eq!(merged, gaps, "gaps separated by >= one chunk must stay separate");
    }

    /// The exact boundary: a cached run of one whole chunk is worth preserving; a
    /// run one byte short of a chunk is not. Both gaps are inclusive, so a cached
    /// run of R bytes after a gap ending at `prev_end` starts the next gap at
    /// `prev_end + R + 1`.
    #[test]
    fn coalesce_boundary_is_one_chunk() {
        let prev_end = 999_u64;
        let with_cached_run = |run: u64| {
            let next = prev_end + run + 1;
            vec![(0_u64, prev_end), (next, next + 1_000)]
        };

        // Exactly one chunk cached between the gaps -> keep separate.
        assert_eq!(
            coalesce(with_cached_run(CHUNK)).len(),
            2,
            "a full cached chunk must not be re-fetched",
        );

        // One byte short of a chunk -> merge.
        assert_eq!(
            coalesce(with_cached_run(CHUNK - 1)).len(),
            1,
            "a sub-chunk cached run is cheaper to refetch than to skip",
        );
    }

    /// Merging must never lose coverage or invert a range.
    #[test]
    fn coalesce_preserves_span_and_order() {
        let gaps = vec![
            (1_000_u64, 2_000),
            (2_100, 3_000),          // sub-chunk apart -> merges
            (50_000_000, 50_000_100), // far -> separate
        ];
        let merged = coalesce(gaps.clone());
        // Every original gap must still be inside some merged gap.
        for (s, e) in &gaps {
            assert!(
                merged.iter().any(|(ms, me)| ms <= s && e <= me),
                "gap {s}-{e} lost by coalescing",
            );
        }
        for w in merged.windows(2) {
            assert!(w[0].1 < w[1].0, "merged gaps must stay ordered and disjoint");
        }
        for (s, e) in &merged {
            assert!(s <= e, "inverted merged gap {s}-{e}");
        }
    }

    #[test]
    fn dead_band_ignores_sub_epsilon_moves() {
        // Anything below the epsilon is jitter. Base must exceed the epsilon so
        // the downward case stays in range (round-15: epsilon is now 5 MiB).
        const BASE: u64 = 100 * 1024 * 1024;
        assert!(!is_significant_target_change(BASE, BASE + (PROACTIVE_TARGET_EPSILON_BYTES - 1)));
        assert!(!is_significant_target_change(BASE, BASE - (PROACTIVE_TARGET_EPSILON_BYTES - 1)));
        // Zero move.
        assert!(!is_significant_target_change(500, 500));
    }

    /// Round-15 R-10: the dead band must be sized against CBR ESTIMATION ERROR,
    /// not against sub-chunk byte jitter.
    ///
    /// The tests above are all epsilon-RELATIVE, so they pass for any value —
    /// including the original 64KiB, which was ~50,000x too small and let all 21
    /// re-evaluations in log 15-t through. This test pins the MAGNITUDE, so
    /// shrinking the constant back toward jitter scale fails here.
    ///
    /// Reference file: 1566651347 B / 8888.136 s => 176264.9 B/s mean bitrate.
    #[test]
    fn dead_band_is_sized_for_cbr_error_not_byte_jitter() {
        const MEAN_BYTES_PER_SEC: u64 = 176_264;

        // At least ~20s of video: below this the estimator's own error re-triggers
        // constantly (the round-15 thrash: 21 re-evals, ~13MB downloaded total).
        assert!(
            PROACTIVE_TARGET_EPSILON_BYTES >= 20 * MEAN_BYTES_PER_SEC,
            "epsilon {} B is only {:.1}s of video — jitter-scale, will thrash",
            PROACTIVE_TARGET_EPSILON_BYTES,
            PROACTIVE_TARGET_EPSILON_BYTES as f64 / MEAN_BYTES_PER_SEC as f64,
        );

        // At most ~90s: a real seek must still cross it. The smallest genuine
        // retarget observed in 15-t was 116s (15-t:557).
        assert!(
            PROACTIVE_TARGET_EPSILON_BYTES <= 90 * MEAN_BYTES_PER_SEC,
            "epsilon {} B is {:.1}s of video — a real seek could fail to cross it",
            PROACTIVE_TARGET_EPSILON_BYTES,
            PROACTIVE_TARGET_EPSILON_BYTES as f64 / MEAN_BYTES_PER_SEC as f64,
        );
    }

    /// Round-15 R-10: every target move recorded in log 15-t must still be
    /// treated as significant — widening the dead band must not start swallowing
    /// real retargets.
    #[test]
    fn dead_band_still_accepts_every_real_retarget_from_round15_logs() {
        // (line, from, to) — the five "VBR correction" moves in 15-t.
        let moves = [
            (476u32, 911_197_355u64, 869_129_967u64),   // 238.7s
            (501, 869_129_967, 417_667_054),            // 2561.3s
            (535, 417_667_054, 1_244_901_117),          // 4693.2s
            (557, 1_244_901_117, 1_265_325_661),        // 115.9s — the smallest
            (558, 1_265_325_661, 754_883_487),          // 2895.9s
        ];
        for (line, from, to) in moves {
            assert!(
                is_significant_target_change(from, to),
                "15-t:{} move {} -> {} ({} B) must stay significant",
                line, from, to, from.abs_diff(to),
            );
        }
    }

    // --- Round-21: backward re-anchor threshold ---

    /// The bug this fixes: two different backward tests with two different
    /// thresholds. The inner chunk loop stopped the download at 10MB, but the
    /// outer loop only moved `start_byte` at 50MB — so a backward seek in the
    /// 10-50MB band tore down the in-flight iterator and then resumed from the
    /// STALE forward anchor, downloading AHEAD of where the user seeked back to.
    #[test]
    fn backward_reanchor_catches_the_seeks_the_50mb_bar_missed() {
        // (log time, previous target, new target) from 21-t.
        let seeks = [
            ("17:54:56", 213_932_125u64, 189_378_154u64), // back 23.4MB
            ("17:55:27", 784_741_192, 764_739_913),       // back 19.1MB
            ("17:58:42", 630_183_660, 591_166_600),       // back 37.2MB
        ];
        for (when, prev, new) in seeks {
            let back = prev - new;
            // All three were BELOW the old 50MB bar — that is why they leaked.
            assert!(back < 50 * 1024 * 1024, "{}: {}B", when, back);
            // ...and all three must now re-anchor.
            assert!(
                is_backward_reanchor(prev, new),
                "{}: backward seek of {:.1}MB must re-anchor the prebuffer",
                when, back as f64 / (1024.0 * 1024.0),
            );
        }
    }

    #[test]
    fn backward_reanchor_still_fires_for_the_seek_that_already_worked() {
        // 17:57:03 — 59.5MB back. Crossed the old bar, must keep crossing.
        assert!(is_backward_reanchor(991_988_792, 929_589_941));
    }

    #[test]
    fn backward_reanchor_ignores_forward_movement() {
        // Normal forward playback must never re-anchor, at any distance —
        // that was the round-9 thrash (iterator torn down ~1/s).
        assert!(!is_backward_reanchor(100_000_000, 100_000_001));
        assert!(!is_backward_reanchor(100_000_000, 900_000_000));
        assert!(!is_backward_reanchor(0, 1_566_651_347));
        // Zero move.
        assert!(!is_backward_reanchor(500_000_000, 500_000_000));
    }

    #[test]
    fn backward_reanchor_ignores_sub_threshold_jitter() {
        const BASE: u64 = 500 * 1024 * 1024;
        assert!(!is_backward_reanchor(BASE, BASE - (PROACTIVE_BACKWARD_REANCHOR_BYTES - 1)));
        // Exactly the threshold counts (>= boundary).
        assert!(is_backward_reanchor(BASE, BASE - PROACTIVE_BACKWARD_REANCHOR_BYTES));
        // The ±1 byte VBR jitter from the round-15 logs must stay ignored.
        assert!(!is_backward_reanchor(1_353_514_972, 1_353_514_971));
    }

    #[test]
    fn backward_reanchor_saturates_instead_of_underflowing() {
        // new_target > anchor must not wrap around u64.
        assert!(!is_backward_reanchor(0, 500_000_000));
        assert!(!is_backward_reanchor(1, u64::MAX));
    }

    /// The two decisions — "stop the in-flight download" and "move the anchor" —
    /// answer the same question, so they must use the same threshold. If someone
    /// re-introduces a separate constant for one of them, this fails.
    #[test]
    fn backward_reanchor_agrees_with_the_retarget_epsilon() {
        assert_eq!(PROACTIVE_BACKWARD_REANCHOR_BYTES, PROACTIVE_TARGET_EPSILON_BYTES);
        // Anything the estimator calls a real backward retarget must also
        // re-anchor the prebuffer — no band where one fires without the other.
        const BASE: u64 = 800 * 1024 * 1024;
        for back_mb in [5u64, 10, 19, 23, 37, 50, 60, 200] {
            let new = BASE - back_mb * 1024 * 1024;
            assert_eq!(
                is_significant_target_change(BASE, new),
                is_backward_reanchor(BASE, new),
                "{}MB backward: the two thresholds disagree",
                back_mb,
            );
        }
    }

    /// Re-anchoring must not narrow the prebuffer window: the sweep still runs
    /// to EOF, it only restarts from a different place.
    #[test]
    fn backward_reanchor_does_not_shrink_the_window_to_eof() {
        const TOTAL: u64 = 1_566_651_347;
        // `computed_max_ahead_byte = total_size` unconditionally (line ~1392),
        // and `max_ahead_byte` only ever grows. Pin that invariant: the window
        // end is the file end regardless of which way the playhead moved.
        let mut max_ahead_byte = 0u64;
        for _ in 0..5 {
            let computed = TOTAL; // what the loop assigns every iteration
            if computed > max_ahead_byte {
                max_ahead_byte = computed;
            }
        }
        assert_eq!(max_ahead_byte, TOTAL, "prebuffer window must stay EOF");
    }

    #[test]
    fn dead_band_accepts_epsilon_and_real_seeks() {
        // Exactly epsilon counts (>= boundary).
        assert!(is_significant_target_change(1_000_000, 1_000_000 + PROACTIVE_TARGET_EPSILON_BYTES));
        // Real seeks from the log (hundreds of MB) always cross.
        assert!(is_significant_target_change(1353514972, 703432598));
        assert!(is_significant_target_change(472248289, 260823323));
        // From byte 0 (cold start) to a real target.
        assert!(is_significant_target_change(0, 59278028));
    }

    #[test]
    fn dead_band_saturating_never_panics_at_extremes() {
        // abs_diff is saturating/safe at the numeric extremes.
        assert!(is_significant_target_change(0, u64::MAX));
        assert!(is_significant_target_change(u64::MAX, 0));
        assert!(!is_significant_target_change(u64::MAX, u64::MAX));
    }

    // --- Actix streaming worker-count clamp (issue #d) ---

    #[test]
    fn worker_count_clamps_high_core_machines() {
        use crate::server::{streaming_worker_count, MAX_STREAMING_WORKERS};
        // 20-core machine (the observed case): clamped to the max.
        assert_eq!(streaming_worker_count(20), MAX_STREAMING_WORKERS);
        assert_eq!(streaming_worker_count(128), MAX_STREAMING_WORKERS);
    }

    #[test]
    fn worker_count_floors_low_core_machines() {
        use crate::server::{streaming_worker_count, MIN_STREAMING_WORKERS};
        // Single-core / zero (unavailable) never drops below the floor.
        assert_eq!(streaming_worker_count(1), MIN_STREAMING_WORKERS);
        assert_eq!(streaming_worker_count(0), MIN_STREAMING_WORKERS);
    }

    #[test]
    fn worker_count_passes_through_mid_range() {
        use crate::server::{streaming_worker_count, MIN_STREAMING_WORKERS, MAX_STREAMING_WORKERS};
        // Core counts inside the band are returned unchanged.
        for cores in MIN_STREAMING_WORKERS..=MAX_STREAMING_WORKERS {
            assert_eq!(streaming_worker_count(cores), cores);
        }
    }

    /// Verify base_url uses direct HTTP format (http://localhost:PORT).
    /// This is the URL used for native <video> src with PNA CORS headers.
    #[test]
    fn stream_info_base_url_format() {
        let config = StreamConfig {
            token: "test-token-123".to_string(),
            port: 14201,
        };

        // Simulate what cmd_get_stream_info returns (without Tauri State wrapper)
        let base_url = format!("http://localhost:{}", config.port);
        assert_eq!(base_url, "http://localhost:14201");
        assert!(base_url.starts_with("http://localhost:"));
        // Port must be present — no trailing slash
        assert!(base_url.matches(':').count() == 2, "base_url must include port number");
    }

    /// Verify video_base_url is platform-specific custom protocol format.
    /// On Windows: http://nobuf-stream.localhost
    /// On macOS/Linux: nobuf-stream://localhost
    #[test]
    fn stream_info_video_base_url_platform_specific() {
        let video_base_url = if cfg!(windows) {
            "http://nobuf-stream.localhost".to_string()
        } else {
            "nobuf-stream://localhost".to_string()
        };

        if cfg!(windows) {
            assert_eq!(video_base_url, "http://nobuf-stream.localhost");
            // Windows WebView2 maps custom schemes to http://SCHEME.localhost format
            assert!(video_base_url.starts_with("http://"));
            assert!(video_base_url.contains("nobuf-stream.localhost"));
        } else {
            assert_eq!(video_base_url, "nobuf-stream://localhost");
            assert!(video_base_url.starts_with("nobuf-stream://"));
        }
    }

    /// Verify base_url uses the configured port, not a hardcoded value.
    #[test]
    fn stream_info_base_url_uses_config_port() {
        let config_port_1 = StreamConfig {
            token: "test".to_string(),
            port: 14201,
        };
        let config_port_2 = StreamConfig {
            token: "test".to_string(),
            port: 8080,
        };

        let base_url_1 = format!("http://localhost:{}", config_port_1.port);
        let base_url_2 = format!("http://localhost:{}", config_port_2.port);

        assert_eq!(base_url_1, "http://localhost:14201");
        assert_eq!(base_url_2, "http://localhost:8080");
        assert_ne!(base_url_1, base_url_2, "Different ports must produce different base_urls");
    }

    /// Verify the StreamInfo struct has all required fields for serialization.
    #[test]
    fn stream_info_has_required_fields() {
        let info = StreamInfo {
            token: "abc".to_string(),
            base_url: "http://localhost:14201".to_string(),
            video_base_url: "http://nobuf-stream.localhost".to_string(),
        };

        assert_eq!(info.token, "abc");
        assert_eq!(info.base_url, "http://localhost:14201");
        assert_eq!(info.video_base_url, "http://nobuf-stream.localhost");
    }
}

/// Get cache status for a specific message
#[tauri::command]
pub async fn cmd_get_cache_status(
    message_id: i32,
    state: State<'_, TelegramState>,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<Option<stream_cache::CacheStatus>, String> {
    let mut status = cache_state.get_status(message_id);
    if let (Some(status), Some((seek_s, estimated, actual))) = (
        status.as_mut(),
        state.remux_seek_anchors.read().await.get(&message_id).copied(),
    ) {
        status.remux_seek_time_s = Some(seek_s);
        status.remux_seek_estimated_byte = Some(estimated);
        status.remux_seek_actual_byte = Some(actual);
    }
    Ok(status)
}

/// Delete cache for a specific message
#[tauri::command]
pub async fn cmd_delete_cache(
    message_id: i32,
    reason: Option<String>,
    state: State<'_, TelegramState>,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    let reason_str = reason.unwrap_or_else(|| "unknown".to_string());
    let has_active_dl = cache_state.has_active_download(message_id).await;
    let is_streaming = cache_state.is_streaming(message_id);
    log::info!(
        "[CACHE] cmd_delete_cache called for msg {} reason={} active_dl={} streaming={}",
        message_id, reason_str, has_active_dl, is_streaming
    );

    // Round-9 I-3: cancel the proactive prebuffer (and the bg-cache task belt)
    // BEFORE deleting. These tasks hold the .dat open via open_data_file_write
    // (no FILE_SHARE_DELETE on Windows) yet are invisible to BOTH guards below
    // (tracked via track_proactive/track_task, not the download coordinator) —
    // 9-t: a starved-alive proactive task kept 109.dat os-32 locked for the
    // rest of the session after a cache-dialog discard. Cancelling first means
    // the task exits at its next cancellation check (≤ ~500ms in every state,
    // including the throttle-yield loop), drops the handle, and its spawn
    // wrapper retries the deferred deletion. Also closes the meta-resurrection
    // race (I-3b): the tasks re-check this key before their periodic meta save.
    // NOT untracking here — the wrapper owns untrack; untracking early would
    // let a racing position report spawn a second task while the old one drains.
    {
        let mut cancelled = state.cancelled_transfers.write().await;
        cancelled.insert(format!("proactive-{}", message_id));
        cancelled.insert(format!("bg-cache-{}", message_id));
    }

    // Check for active downloads BEFORE attempting deletion.
    // The download coordinator uses async mutex, so we check here
    // (in the async Tauri command) rather than in the sync delete_cache method.
    if has_active_dl {
        return Err("Cache has active download — retry later".to_string());
    }

    let deleted_folder = cache_state.load_meta(message_id).map(|meta| meta.folder_id);
    let deleted = cache_state
        .delete_cache(message_id)
        .map_err(|e| format!("Failed to delete cache: {}", e))?;
    if !deleted {
        return Err("Cache is still streaming — retry later".to_string());
    }
    if let Some(folder_id) = deleted_folder {
        crate::server::invalidate_durable_subtitles(cache_state.inner(), folder_id, message_id);
    }
    log::info!("[CACHE] cmd_delete_cache succeeded for msg {} reason={}", message_id, reason_str);
    Ok(true)
}

/// Start background caching for a video — continues downloading to cache after player closes
#[tauri::command]
pub async fn cmd_start_background_cache(
    message_id: i32,
    folder_id: i64,
    _app_handle: tauri::AppHandle,
    state: State<'_, TelegramState>,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    // Don't start if already running
    if cache_state.has_active_task(message_id).await {
        return Ok(false);
    }

    // Don't start if already complete
    if let Some(meta) = cache_state.load_meta(message_id) {
        if meta.is_complete() {
            return Ok(false);
        }
    }

    let client = { state.client.lock().await.clone() }
        .ok_or("Not connected")?;

    let cache_mgr = cache_state.inner().clone();
    let tg_state = Arc::new(state.inner().clone());

    // Round-9 I-3: clear a stale cancel key left by cmd_delete_cache (same
    // pattern as the proactive spawn) so this fresh task isn't insta-cancelled.
    {
        let bg_key = format!("bg-cache-{}", message_id);
        let mut cancelled = state.cancelled_transfers.write().await;
        cancelled.remove(&bg_key);
    }

    cache_mgr.track_task(message_id).await;

    tokio::spawn(async move {
        let result = background_cache_download(
            message_id, folder_id, client, tg_state, cache_mgr.clone(),
        )
        .await;

        cache_mgr.untrack_task(message_id).await;
        // Round-9 I-3: handle dropped — retry any deferred deletion (parity
        // with the proactive spawn wrapper).
        cache_mgr.retry_deferred_deletions(message_id);

        if let Err(e) = result {
            log::error!("Background cache failed for {}: {}", message_id, e);
        } else {
            log::info!("Background cache completed for {}", message_id);
            crate::server::maybe_spawn_complete_subtitle_promotion(cache_mgr.clone(), message_id);
        }
    });

    Ok(true)
}

/// Stop background caching for a video
#[tauri::command]
pub async fn cmd_stop_background_cache(
    message_id: i32,
    state: State<'_, TelegramState>,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    // Use the cancelled_transfers mechanism with a bg-cache prefix
    let transfer_id = format!("bg-cache-{}", message_id);
    state.cancelled_transfers.write().await.insert(transfer_id);
    cache_state.untrack_task(message_id).await;
    Ok(true)
}

/// Background download task that caches a full video to disk
async fn background_cache_download(
    message_id: i32,
    folder_id: i64,
    client: grammers_client::Client,
    state: Arc<TelegramState>,
    cache_mgr: StreamCacheManager,
) -> Result<(), String> {
    let peer = resolve_peer(&client, Some(folder_id), &state.peer_cache).await?;
    let messages = client
        .get_messages_by_id(&peer, &[message_id])
        .await
        .map_err(|e| format!("Failed to fetch message: {}", e))?;
    let message = messages
        .into_iter()
        .next()
        .ok_or("Message not found")?
        .ok_or("Message is empty")?;

    let media = message.media().ok_or("No media on message")?;

    // Extract total size using raw TL (grammers-client high-level wrapper returns 0)
    let total_size: u64 = match &message.raw {
        tl::enums::Message::Message(m) => match &m.media {
            Some(tl::enums::MessageMedia::Document(md)) => md
                .document
                .as_ref()
                .and_then(|d| match d {
                    tl::enums::Document::Document(doc) => Some(doc.size as u64),
                    _ => None,
                })
                .unwrap_or(0),
            _ => 0,
        },
        _ => 0,
    };

    if total_size == 0 {
        return Err("Could not determine file size".into());
    }

    // Check what's already cached
    let existing_meta = cache_mgr.load_meta(message_id);
    let cached_ranges = existing_meta
        .as_ref()
        .map(|m| m.cached_ranges.clone())
        .unwrap_or_default();
    let gaps = find_gaps(&cached_ranges, total_size);

    if gaps.is_empty() {
        return Ok(()); // Already fully cached
    }

    // Get filename
    let filename = match &media {
        Media::Document(d) => d.name().to_string(),
        _ => format!("{}.mp4", message_id),
    };

    // Get MIME type (same pattern as server.rs)
    let mime_type = crate::server::mime_type_from_media(&media);

    // Download gaps to cache file
    let mut cache_file = cache_mgr.open_data_file_write(message_id)
        .map_err(|e| format!("Failed to open cache file: {}", e))?;

    // Gammers-client chunk size cap (512KB). See fs.rs TELEGRAM_CHUNK_SIZE.
    let chunk_size: i32 = 512 * 1024;
    let transfer_id = format!("bg-cache-{}", message_id);

    // Progressive keyframe indexer (feeds the hover-thumbnail index as we cache).
    let mut kf_indexer = KeyframeIndexer::new();

    // Always use sequential iter_download — Telegram triggers FLOOD_PREMIUM_WAIT
    // on parallel connections (same approach as .mp4 streaming).
    let _pool_clone = { state.download_pool.lock().await.clone() }; // kept for future non-streaming use

    for (gap_start, gap_end) in gaps {
        let _gap_size = gap_end - gap_start + 1;

        // Check cancellation
        if state.cancelled_transfers.read().await.contains(&transfer_id) {
            log::info!("Background cache cancelled for {}", message_id);
            return Ok(());
        }

        // Sequential iter_download for all gaps (no parallel pool)
        let skip_chunks = gap_start / chunk_size as u64;
        let skip_bytes = gap_start % chunk_size as u64;

        let mut iter = client
            .iter_download(&media)
            .chunk_size(chunk_size)
            .skip_chunks(skip_chunks as i32);

        let mut offset = gap_start;
        let mut first_chunk = true;

        while let Ok(Some(chunk_result)) = {
            let _permit = state.download_semaphore.acquire().await.unwrap();
            throttle_api_calls(&state.rate_limiter).await;
            iter.next().await
        } {
            // Check cancellation
            if state
                .cancelled_transfers
                .read()
                .await
                .contains(&transfer_id)
            {
                log::info!("Background cache cancelled for {}", message_id);
                return Ok(());
            }

            let chunk = chunk_result;

            // On first chunk of this gap, discard leading bytes to align with gap_start
            let chunk_slice: &[u8] = if first_chunk && skip_bytes > 0 {
                let discard = skip_bytes.min(chunk.len() as u64) as usize;
                first_chunk = false;
                &chunk[discard..]
            } else {
                first_chunk = false;
                &chunk
            };

            let remaining_in_gap = (gap_end - offset + 1) as usize;
            let to_write = chunk_slice.len().min(remaining_in_gap);

            let write_offset = offset; // absolute pos of these bytes

            // Record Telegram network bytes for the speed meter
            cache_mgr.add_downloaded_bytes(message_id, to_write as u64);

            cache_file
                .seek(SeekFrom::Start(offset))
                .map_err(|e| format!("Seek error: {}", e))?;
            cache_file
                .write_all(&chunk_slice[..to_write])
                .map_err(|e| format!("Write error: {}", e))?;

            offset += to_write as u64;

            // Update meta (serialized via per-message lock). Scoped so the lock
            // drops BEFORE the keyframe-index update below (never nest the two).
            {
                // Round-9 I-3b: same meta-resurrection guard as the proactive
                // task — a discard cancels bg-cache-{id} before deleting meta;
                // saving after that would resurrect the discarded cache.
                if state.cancelled_transfers.read().await.contains(&transfer_id) {
                    log::info!("Background cache cancelled for {} — skipping meta save", message_id);
                    return Ok(());
                }
                let _lock = cache_mgr.lock_meta(message_id).await;
                let mut meta = cache_mgr.load_meta(message_id).unwrap_or_else(|| CacheMeta {
                    message_id,
                    folder_id,
                    total_size,
                    filename: filename.clone(),
                    cached_ranges: Vec::new(),
                    mime_type: mime_type.clone(),
                });
                meta.cached_ranges.push((gap_start, offset - 1));
                merge_ranges(&mut meta.cached_ranges);
                let _ = cache_mgr.save_meta(&meta);
            }

            // Progressive keyframe indexing (outside lock_meta). Best-effort.
            index_keyframes_from_chunk(
                &mut kf_indexer, &chunk_slice[..to_write], write_offset,
                message_id, total_size, &cache_mgr, &state,
            ).await;

            // Throttle: sleep to enforce download speed limit for background cache.
            // Semaphore is released after chunk fetch, so other tasks can use
            // the connection during this sleep window.
            let dl_limit_kb = state.download_speed_limit_kb.load(std::sync::atomic::Ordering::Relaxed);
            if dl_limit_kb > 0 {
                let sleep_ms = (to_write as u64 * 1000) / (dl_limit_kb * 1024);
                let sleep_ms = sleep_ms.min(2000);
                // log::info!("[THROTTLE-DBG][BG-CACHE] msg={}, chunk_bytes={}, limit_kb={}/s, sleep_ms={}, offset={}", 
                //     message_id, to_write, dl_limit_kb, sleep_ms, offset);
                tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
            } else {
                // log::info!("[THROTTLE-DBG][BG-CACHE] msg={}, unlimited, no throttle sleep, offset={}", 
                //     message_id, offset);
            }

            if offset > gap_end {
                break;
            }
        }
    }

    Ok(())
}

/// Get total cache size on disk (in bytes). Scans all files in the
/// stream-cache directory including remux/ subdirectory.
#[tauri::command]
pub async fn cmd_get_cache_total_size(
    cache_state: State<'_, StreamCacheManager>,
) -> Result<u64, String> {
    let cache_dir = cache_state.cache_dir().clone();
    let mut total: u64 = 0;

    fn scan_dir(dir: &std::path::Path, total: &mut u64) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan_dir(&path, total);
                } else if let Ok(meta) = std::fs::metadata(&path) {
                    *total += meta.len();
                }
            }
        }
    }

    scan_dir(&cache_dir, &mut total);
    Ok(total)
}

/// Report the current playback position so the backend can proactively
/// download ahead to disk cache. This ensures that when the MSE player
/// resumes (lazyLoad or after eviction), data is already on disk and can
/// be served instantly via CACHE-PREFIX without Telegram network latency.
///
/// The frontend calls this every 10s during playback. The backend:
///   1. Approximates the current byte position from playback time
///   2. Checks what's already cached on disk
///   3. Spawns a proactive download task for gaps ahead of the playhead
///   4. Skips if a download is already running for this message
#[tauri::command]
pub async fn cmd_report_playback_position(
    message_id: i32,
    // Option: None = Saved Messages / "home" (activeFolderId is null in the
    // frontend for home files — resolve_peer maps None → get_me()). A non-Option
    // i64 here silently disabled the proactive prebuffer for every home file:
    // the frontend gated the call on folderId !== null and never reported.
    folder_id: Option<i64>,
    current_time_s: f64,
    duration_s: f64,
    file_size: u64,
    is_player_downloading: bool,
    playback_rate: f64,
    byte_offset: Option<u64>,
    state: State<'_, TelegramState>,
    cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    if file_size == 0 {
        return Ok(false);
    }

    // Store the player download state so the proactive prebuffer can
    // throttle itself when the IOController is actively downloading.
    // Round-9 I-2b: timestamp with freshness decay, not a raw bool — the MKV
    // seek path reports true and has no periodic reporter to clear it.
    let stamp = if is_player_downloading { now_epoch_ms() } else { 0 };
    state.player_actively_downloading.store(stamp, std::sync::atomic::Ordering::Relaxed);

    // Use the exact byte offset if provided (from VBR correction — the linear
    // estimate is wrong for VBR video). Fall back to linear estimate otherwise.
    let estimated_byte = if let Some(byte) = byte_offset {
        byte.min(file_size)
    } else if duration_s > 0.0 {
        let ratio = (current_time_s / duration_s).clamp(0.0, 1.0);
        (ratio * file_size as f64) as u64
    } else {
        0u64
    };
    // Keep later reports on the same measured container offset. Without this,
    // the next periodic report overwrites ffmpeg's authoritative target with
    // the original bad estimate. A distant seek falls outside the time window
    // and uses its new estimate until ffmpeg publishes the replacement anchor.
    let remux_anchor = state.remux_seek_anchors.read().await.get(&message_id).copied();
    let current_byte = crate::server::corrected_playback_report_byte(
        estimated_byte,
        byte_offset.is_some(),
        current_time_s,
        remux_anchor,
        file_size,
    );

    // Store the latest target so a running proactive task can slide its window.
    state.proactive_targets.write().await.insert(
        message_id,
        (current_byte, duration_s, playback_rate, file_size)
    );

    // Record the playhead byte for the coordinator's playhead-aware zombie-cancel
    // (trace-23 fix): register_download uses it to keep the read nearest the
    // playhead alive and cancel only the stale forward-walk left behind by a seek.
    cache_state.set_playhead_byte(message_id, current_byte);

    // A fresh report can arrive after the previous worker was stopped but
    // before foreground playback has finished its post-seek refill. Do not
    // admit a replacement worker during that window; the frontend retry will
    // re-report once the foreground read is no longer active.
    if should_defer_proactive_spawn(is_player_downloading) {
        log::info!("[PROACTIVE] msg {}: foreground playback downloading — deferring proactive spawn", message_id);
        return Ok(false);
    }

    // Don't start if a proactive prebuffer is already running for this message.
    // NOTE: We do NOT check has_active_task() here because the /stream endpoint's
    // download is tracked there too — it would always return true during playback,
    // preventing the proactive prebuffer from ever starting.
    if cache_state.has_proactive_task(message_id).await {
        return Ok(true);
    }

    // Clear any previous cancellation so a new task can start after stop.
    let proactive_key = format!("proactive-{}", message_id);
    if state.cancelled_transfers.read().await.contains(&proactive_key) {
        state.cancelled_transfers.write().await.remove(&proactive_key);
    }

    // COLD-START GUARD: Only defer PROACTIVE on initial cold start (no byte offset).
    // On explicit seeks (byte_offset provided), start PROACTIVE immediately —
    // the 40s ahead offset ensures it won't compete with /stream's bootstrap.
    //
    // Round-14 F1: that justification is SPATIAL ("40s ahead in the file") but
    // the contended resource is TEMPORAL and GLOBAL — one 300ms-spaced Telegram
    // limiter shared by every reader. Being 40s ahead in the file says nothing
    // about queue position, so this guard being skipped on the seek path is
    // exactly why 14-t:184-187 shows an 893MB prefetch spawning in the same
    // second as bisect probe 1. The SEEK-CRITICAL GUARD below covers that case.
    if byte_offset.is_none() {
        if let Some(meta) = cache_state.load_meta(message_id) {
            if meta.cached_ranges.is_empty() {
                log::info!("[PROACTIVE] msg {}: cache meta exists but no ranges yet — /stream bootstrap still running, deferring proactive", message_id);
                return Ok(false);
            }
        } else {
            log::info!("[PROACTIVE] msg {}: no cache meta — /stream bootstrap not started yet, deferring proactive", message_id);
            return Ok(false);
        }
    }

    // SEEK-CRITICAL GUARD (round-14 F1): a cue-less MKV bisect is in flight and
    // the user is blocked on it. Do not spawn a background prefetch that will
    // contend for the same limiter slots.
    //
    // Keyed on the PROBE's own source_id (stamped in /stream), not on this
    // command's arguments: the seek call site hardcodes
    // `isPlayerDownloading: true` + `byteOffset: Some(..)` for EVERY seek, so
    // from here a cached-region seek (F1.5) and an MP4/TS seek (F1.6) are
    // indistinguishable from a real bisect. Only an actual probe suppresses.
    //
    // Self-expiring: `seek_critical_read_fresh` decays after
    // SEEK_CRITICAL_SUPPRESS_MS, so an abandoned seek, a closed player, or a
    // crashed writer all lift suppression on their own. Round-9 I-2b is why
    // this must never be a sticky boolean (PROACTIVE starved 0 bytes in 70s).
    {
        let stamped = state.seek_critical_read_at.load(std::sync::atomic::Ordering::Relaxed);
        if seek_critical_read_fresh(now_epoch_ms(), stamped) {
            log::info!(
                "[PROACTIVE] msg {}: seek-critical read in flight ({}ms ago) — deferring proactive spawn so bisect probes get the limiter",
                message_id,
                now_epoch_ms().saturating_sub(stamped)
            );
            return Ok(false);
        }
    }

    // Don't start if already fully cached
    if let Some(meta) = cache_state.load_meta(message_id) {
        if meta.is_complete() {
            return Ok(true); // terminal success; do not schedule a retry
        }
    }

    // Check if there are uncached gaps ahead of current position
    let cached_ranges = cache_state.load_meta(message_id)
        .map(|m| m.cached_ranges.clone())
        .unwrap_or_default();

    // Proactive prebuffer downloads the entire remaining file to disk cache (EOF),
    // decoupled from the in-memory sliding window. It fills gaps from the playhead
    // all the way to the end of the file, so lazyLoad / resume never stalls waiting
    // for Telegram after the initial seek.
    let max_ahead_byte = file_size;

    // Prefer the forward supply line, but if it is already complete, restart
    // against remaining earlier holes so the warmer can reach global EOF.
    let all_gaps = find_gaps(&cached_ranges, file_size);
    let ahead_gaps: Vec<(u64, u64)> = all_gaps.iter().copied()
        .filter(|(_start, end)| *end >= current_byte)
        .map(|(start, end)| (start.max(current_byte), end.min(max_ahead_byte)))
        .filter(|(start, end)| *start <= *end)
        .collect();
    let candidate_gaps = if ahead_gaps.is_empty() { &all_gaps } else { &ahead_gaps };
    if candidate_gaps.is_empty() { return Ok(true); }
    let total_ahead_bytes: u64 = candidate_gaps.iter().map(|(s, e)| e - s + 1).sum();

    log::info!(
        "[PROACTIVE] msg {}: playhead={}s (byte {}), {} uncached bytes ahead ({} gaps) — window to EOF (byte {}) — spawning proactive download",
        message_id, current_time_s as i64, current_byte, total_ahead_bytes, candidate_gaps.len(), max_ahead_byte
    );

    let client = { state.client.lock().await.clone() }
        .ok_or("Not connected")?;

    let cache_mgr = cache_state.inner().clone();
    let tg_state = Arc::new(state.inner().clone());

    if !cache_mgr.try_track_proactive(message_id).await {
        return Ok(true);
    }

    let proactive_generation = {
        let mut generations = state.proactive_generations.write().await;
        let next = generations.get(&message_id).copied().unwrap_or(0).wrapping_add(1);
        generations.insert(message_id, next);
        next
    };

    tokio::spawn(async move {
        let _claim_guard = ProactiveClaimGuard { cache: cache_mgr.clone(), message_id };
        let result = proactive_prebuffer_download(
            message_id, folder_id, current_byte, max_ahead_byte, proactive_generation,
            client, tg_state.clone(), cache_mgr.clone(),
        ).await;

        // The claim guard releases the slot after this future exits.
        // Round-9 I-3: the task's open_data_file_write handle is dropped now —
        // retry any deferred deletion queued by a discard during the prebuffer
        // (previously nothing retried on proactive exit; 109.dat stayed locked
        // until app exit).
        cache_mgr.retry_deferred_deletions(message_id);

        match result {
            Ok(downloaded) => {
                if downloaded > 0 {
                    log::info!("[PROACTIVE] msg {}: downloaded {} bytes to disk cache", message_id, downloaded);
                }
            }
            Err(e) => log::warn!("[PROACTIVE] msg {}: download failed: {}", message_id, e),
        }
        crate::server::maybe_spawn_complete_subtitle_promotion(cache_mgr.clone(), message_id);
    });

    Ok(true)
}

/// Stop any proactive prebuffer download for a message (called when
/// playback stops or switches to a different file).
#[tauri::command]
pub async fn cmd_stop_proactive_prebuffer(
    message_id: i32,
    state: State<'_, TelegramState>,
    _cache_state: State<'_, StreamCacheManager>,
) -> Result<bool, String> {
    let transfer_id = format!("proactive-{}", message_id);
    {
        let mut generations = state.proactive_generations.write().await;
        let next = generations.get(&message_id).copied().unwrap_or(0).wrapping_add(1);
        generations.insert(message_id, next);
    }
    state.cancelled_transfers.write().await.insert(transfer_id);
    log::info!("[PROACTIVE] msg {}: stopped", message_id);
    Ok(true)
}

struct ProactiveClaimGuard {
    cache: StreamCacheManager,
    message_id: i32,
}

impl Drop for ProactiveClaimGuard {
    fn drop(&mut self) {
        let cache = self.cache.clone();
        let message_id = self.message_id;
        let _ = tokio::spawn(async move { cache.untrack_proactive(message_id).await; });
    }
}

/// Proactive prebuffer download task — downloads from `start_byte` to
/// `file_end` to disk cache, filling gaps ahead of the playhead.
/// Modelled after `background_cache_download` but starts from a specific
/// byte position (not the beginning of the file).
async fn proactive_prebuffer_download(
    message_id: i32,
    folder_id: Option<i64>,
    start_byte: u64,
    max_ahead_byte: u64,
    proactive_generation: u64,
    client: grammers_client::Client,
    state: Arc<TelegramState>,
    cache_mgr: StreamCacheManager,
) -> Result<u64, String> {
    let transfer_id = format!("proactive-{}", message_id);

    // Retry initial setup (resolve_peer + get_messages) for transient network errors.
    // Genuine errors like "message not found" or "no media" are not retried.
    let (_peer, message, media) = {
        let mut setup_attempt = 0u32;
        const MAX_SETUP_RETRIES: u32 = 3;
        loop {
            match (async {
                let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
                let messages = client
                    .get_messages_by_id(&peer, &[message_id])
                    .await
                    .map_err(|e| format!("Failed to fetch message: {}", e))?;
                let message = messages
                    .into_iter()
                    .next()
                    .ok_or("Message not found")?
                    .ok_or("Message is empty")?;
                let media = message.media().ok_or("No media on message")?;
                Ok::<_, String>((peer, message, media))
            })
            .await
            {
                Ok(result) => break result,
                Err(e) => {
                    // Don't retry genuine errors that won't fix themselves
                    if e.contains("Message not found")
                        || e.contains("No media")
                        || e.contains("Message is empty")
                    {
                        return Err(e);
                    }
                    setup_attempt += 1;
                    if setup_attempt >= MAX_SETUP_RETRIES {
                        return Err(e);
                    }
                    let delay = crate::commands::utils::backoff_with_jitter(setup_attempt, 5000, 60_000);
                    log::warn!(
                        "[PROACTIVE] msg {}: setup attempt {}/{} failed: {}. Retry in {}ms",
                        message_id, setup_attempt, MAX_SETUP_RETRIES, e, delay
                    );
                    // Check cancellation during retry wait
                    if state
                        .cancelled_transfers
                        .read()
                        .await
                        .contains(&transfer_id)
                    {
                        return Ok(0);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
        }
    };

    // Extract total size
    let total_size: u64 = match &message.raw {
        tl::enums::Message::Message(m) => match &m.media {
            Some(tl::enums::MessageMedia::Document(md)) => md
                .document
                .as_ref()
                .and_then(|d| match d {
                    tl::enums::Document::Document(doc) => Some(doc.size as u64),
                    _ => None,
                })
                .unwrap_or(0),
            _ => 0,
        },
        _ => 0,
    };

    if total_size == 0 {
        return Err("Could not determine file size".into());
    }

    // Check what's already cached
    let existing_meta = cache_mgr.load_meta(message_id);
    let _cached_ranges = existing_meta
        .as_ref()
        .map(|m| m.cached_ranges.clone())
        .unwrap_or_default();

    // Allow the window to slide as the playhead advances while the task runs.
    let mut start_byte = start_byte;
    let mut max_ahead_byte = max_ahead_byte;

    let filename = match &media {
        Media::Document(d) => d.name().to_string(),
        _ => format!("{}.ts", message_id),
    };
    let mime_type = crate::server::mime_type_from_media(&media);

    let mut cache_file = cache_mgr.open_data_file_write(message_id)
        .map_err(|e| format!("Failed to open cache file: {}", e))?;

    let chunk_size: i32 = 512 * 1024;
    let mut total_downloaded: u64 = 0;

    // Progressive keyframe indexer: scans each downloaded chunk for keyframes and
    // feeds the shared hover-thumbnail index (see index_keyframes_from_chunk).
    // One per task so PES spanning chunk boundaries is assembled correctly.
    let mut kf_indexer = KeyframeIndexer::new();

    // NEVER use DownloadPool for streaming — Telegram triggers FLOOD_PREMIUM_WAIT
    // on ANY parallel downloads from the same account. Always use sequential
    // iter_download via the main client (same approach as .mp4 streaming).
    // The pool exists for non-streaming downloads only.
    let _pool_clone = { state.download_pool.lock().await.clone() }; // kept for future non-streaming use

    // Download all gaps sequentially (one Telegram connection).
    // Re-check gaps periodically as the cache grows from /stream too.
    // The window slides forward as the frontend reports new playhead positions.
    let mut idle_cycles: u32 = 0;
    const MAX_IDLE_CYCLES: u32 = 30; // ~60s idle before exiting (was 15/30s)
    let mut jumped = false; // Set by inner loop on playhead jump, checked by outer loop
    let mut last_target_byte: Option<u64> = None; // Track last target across ALL gaps (prevents loop)
    let mut backfill_entry_target: Option<u64> = None;
    loop {
        // Check cancellation
        if state.cancelled_transfers.read().await.contains(&transfer_id)
            || state.proactive_generations.read().await.get(&message_id).copied() != Some(proactive_generation) {
            log::info!("[PROACTIVE] msg {}: cancelled", message_id);
            return Ok(total_downloaded);
        }

        // Re-read latest target from frontend position reports so the window
        // slides as the playhead advances, instead of being a one-shot fixed window.
        let (latest_current_byte, _latest_duration_s, _latest_rate, _latest_file_size) = {
            let targets = state.proactive_targets.read().await;
            targets.get(&message_id).copied().unwrap_or((start_byte, 0.0, 1.0, total_size))
        };

        // Proactive prebuffer downloads the whole file to disk cache; the window is EOF.
        // It is intentionally decoupled from the in-memory sliding window.
        let computed_max_ahead_byte = total_size;

        // Only slide the window forward, never backward — EXCEPT when the user
        // seeked backward (target changed significantly). In that case, update
        // start_byte so gap evaluation uses the new (backward) position.
        // Without this, PROACTIVE keeps prebuffering from the old (forward)
        // position after a backward seek — the user sees "old prebuffers still growing."
        if latest_current_byte > start_byte {
            start_byte = latest_current_byte;
        } else if is_backward_reanchor(start_byte, latest_current_byte) {
            // Backward seek: the viewer is now BEHIND where the sweep is working.
            // Re-anchor so gap evaluation restarts from the new position instead
            // of resuming ahead of it.
            //
            // Round-21: this used to require a 50MB move while the inner chunk
            // loop broke out at 10MB. Backward seeks in that 10-50MB band killed
            // the in-flight download and then recomputed gaps from the STALE
            // forward start_byte — the "old prebuffer keeps growing" report.
            // Both sites now share PROACTIVE_BACKWARD_REANCHOR_BYTES.
            //
            // `jumped = true` makes the 5s yield run so /stream gets the rate
            // limiter to itself at the new position before the sweep resumes.
            log::info!("[PROACTIVE] msg {}: backward seek detected: start_byte {} -> {} (back {:.1}MB)",
                message_id, start_byte, latest_current_byte,
                start_byte.saturating_sub(latest_current_byte) as f64 / (1024.0 * 1024.0));
            start_byte = latest_current_byte;
            backfill_entry_target = None;
            jumped = true;
        }
        if computed_max_ahead_byte > max_ahead_byte {
            max_ahead_byte = computed_max_ahead_byte;
        }

        let current_meta = cache_mgr.load_meta(message_id);
        let current_ranges = current_meta.as_ref().map(|m| m.cached_ranges.clone()).unwrap_or_default();

        let Some((proactive_start_byte, backfilling)) =
            proactive_whole_file_resume(&current_ranges, total_size, start_byte)
        else {
            log::info!("[PROACTIVE] msg {}: whole file cached, exiting", message_id);
            break;
        };

        if backfilling {
            let anchor = backfill_entry_target.get_or_insert(latest_current_byte);
            log::info!(
                "[PROACTIVE] msg {}: forward path cached — backfilling earlier hole at byte {} (entry target {})",
                message_id, proactive_start_byte, anchor,
            );
        } else {
            backfill_entry_target = None;
        }

        if proactive_start_byte != start_byte {
            log::info!(
                "[PROACTIVE] msg {}: resume at first uncached byte {} (playhead {}, +{}B)",
                message_id, proactive_start_byte, start_byte,
                proactive_start_byte.saturating_sub(start_byte)
            );
        }

        let raw_ahead_gaps = proactive_candidate_gaps(
            &current_ranges, total_size, proactive_start_byte, max_ahead_byte, backfilling,
        );

        // Round-26 T4: merge gaps separated by less than one Telegram chunk, so
        // the fragmented neighbourhood the sweep now aims into does not cost one
        // round trip (and one semaphore slot) per tiny hole. See the function.
        let ahead_gaps = coalesce_sub_chunk_gaps(raw_ahead_gaps, chunk_size as u64);

        if ahead_gaps.is_empty() {
            idle_cycles += 1;
            if idle_cycles >= MAX_IDLE_CYCLES {
                log::info!("[PROACTIVE] msg {}: no gaps ahead for {} cycles, exiting", message_id, idle_cycles);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
            continue;
        }
        idle_cycles = 0;

        // Round-26: CONSUME the jump flag into a per-iteration local instead of
        // clearing it before the loop that reads it.
        //
        // This was `jumped = false;` here, while the only read (`if jumped`) sits
        // INSIDE the `for` below. Every assignment — the backward re-anchor at
        // :1861 and both inner-loop playhead jumps — reaches that read only by
        // passing through this line first, so the condition was ALWAYS false and
        // the 5s hand-off yield had never once executed. rustc said so directly:
        // three `value assigned to 'jumped' is never read` warnings.
        //
        // Consequence: after a seek the sweep went straight back to competing
        // with /stream for the 2-permit download semaphore, which is exactly the
        // post-seek contention this yield exists to prevent.
        //
        // Taking the value here keeps the "yield once per jump, not once per gap"
        // semantics the comment below describes: `seek_yield_pending` is cleared
        // by the first large gap that uses it, and the flag itself is already
        // false for the next outer iteration unless something re-arms it.
        let mut seek_yield_pending = std::mem::replace(&mut jumped, false);

        for (gap_start, gap_end) in ahead_gaps {
            let gap_size = gap_end - gap_start + 1;

            // Round-26: single source of truth for the post-seek yield decision.
            // `seek_yield_pending` is consumed here so exactly ONE gap per jump
            // pays the 5s hand-off, and a jump arriving before a run of small
            // gaps stays armed until a large one actually needs it.
            // Round-28: only yield when /stream is actually working near this
            // gap. After a bisect re-anchor its readahead is often still at the
            // pre-seek estimate (28-t: 14.6 MiB / ~83s of content away), and
            // sleeping 5s for it left NOBODY fetching the bytes under the
            // playhead — the viewer played ~1s and stalled.
            let stream_distance = cache_mgr
                .distance_to_nearest_download(message_id, gap_start)
                .await;
            let stream_is_near = stream_distance
                .is_some_and(|d| d <= PROACTIVE_YIELD_STREAM_NEAR_BYTES);
            let (should_yield, next_pending) =
                seek_yield_decision(seek_yield_pending, gap_size, stream_is_near);
            if seek_yield_pending && gap_size > PROACTIVE_YIELD_MIN_GAP_BYTES && !should_yield {
                log::info!(
                    "[PROACTIVE] msg {}: skipping post-seek yield — /stream is {} from gap start {} (limit {}B); sweep is the viewer's supply line",
                    message_id,
                    stream_distance.map_or_else(|| "absent".to_string(), |d| format!("{}B away", d)),
                    gap_start,
                    PROACTIVE_YIELD_STREAM_NEAR_BYTES,
                );
            }
            seek_yield_pending = next_pending;

            if state.cancelled_transfers.read().await.contains(&transfer_id)
            || state.proactive_generations.read().await.get(&message_id).copied() != Some(proactive_generation) {
                log::info!("[PROACTIVE] msg {}: cancelled", message_id);
                return Ok(total_downloaded);
            }

            // Always use sequential iter_download — same approach as .mp4 streaming.
            // Telegram triggers FLOOD_PREMIUM_WAIT on parallel connections.
            if gap_size > PROACTIVE_YIELD_MIN_GAP_BYTES {
                log::info!(
                    "[PROACTIVE] msg {}: SEQUENTIAL download gap {}-{} ({:.1}MB)",
                    message_id, gap_start, gap_end, gap_size as f64 / (1024.0 * 1024.0)
                );
                // Yield to /stream for 5 seconds before starting a new gap download,
                // but ONLY after a seek jump — not on initial startup or sequential
                // gap completion. Without this check, the 5s yield would delay the
                // initial prebuffer and slow sequential prebuffering by 5s per gap.
                //
                // INTERRUPTIBLE YIELD: Instead of a flat 5s sleep, check every 500ms
                // if the target byte has changed (VBR correction reported a new byte).
                // If so, update start_byte immediately so the next gap evaluation uses
                // the corrected byte — not the linear estimate. This fixes:
                //   - Concern 1: prebuffer starting points off (PROACTIVE gets corrected byte during yield)
                //   - Concern 2: seeks not using prebuffer (PROACTIVE prebuffers from correct position)
                if should_yield {
                    let yield_start = std::time::Instant::now();
                    let yield_duration = std::time::Duration::from_secs(5);
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        if yield_start.elapsed() >= yield_duration {
                            break;
                        }
                        // Check if VBR correction reported a new target byte
                        let (current_target, _, _, _) = {
                            let targets = state.proactive_targets.read().await;
                            targets.get(&message_id).copied().unwrap_or((start_byte, 0.0, 1.0, total_size))
                        };
                        // Dead-band: ignore sub-chunk VBR jitter (±1 byte etc).
                        // Only a move of >= PROACTIVE_TARGET_EPSILON_BYTES is a
                        // real retarget worth re-evaluating gaps for.
                        if is_significant_target_change(start_byte, current_target) {
                            log::info!("[PROACTIVE] msg {}: target updated during yield: {} -> {} (VBR correction)", 
                                message_id, start_byte, current_target);
                            start_byte = current_target;
                        }
                    }
                    // Round-26: the seek-direction flag is gone. It existed only to
                    // decide whether to add the fixed forward hand-off, and keeping
                    // it correct across this re-evaluation caused two successive
                    // defects (round-22 F3, round-23 G1a). The resume point is now
                    // derived from actual coverage, which has no direction, so there
                    // is nothing left to preserve or clear here.
                    //
                    // `seek_yield_pending` was already consumed on entry to this
                    // block, so there is nothing to clear either.
                    let retarget_needs_reeval = start_byte != gap_start;
                    // If start_byte was updated during the yield (VBR correction),
                    // the gap was evaluated from the OLD start_byte. Re-evaluate
                    // by continuing to the next outer loop iteration. Re-arm the
                    // OUTER flag so that iteration yields again at the corrected
                    // position — this is the one write that must outlive the loop.
                    if retarget_needs_reeval {
                        log::info!("[PROACTIVE] msg {}: start_byte changed during yield ({} -> {}), re-evaluating gaps",
                            message_id, gap_start, start_byte);
                        jumped = true; // consumed by the next outer iteration
                        break; // break out of the gap loop → outer loop re-evaluates
                    }
                }
            }
            let skip_bytes = gap_start % chunk_size as u64;
            let mut offset = gap_start;
            let mut first_chunk = true;
            // Distinct from `first_chunk` (which resets on every iterator
            // recreation, e.g. after a network retry): this is armed ONCE per gap
            // and cleared after the first meta publish, so a mid-gap retry can't
            // re-trigger the immediate-flush fast path. See should_publish_proactive_meta.
            let mut first_chunk_published = true;
            let mut seq_retries = 0u32;
            const MAX_SEQ_RETRIES: u32 = 5;
            let mut need_new_iter = true;
            let mut iter = client
                .iter_download(&media)
                .chunk_size(chunk_size)
                .skip_chunks(0); // placeholder; recreated below

            loop {
                // (Re)create iterator from current offset when needed (initial or after error)
                if need_new_iter {
                    let skip_chunks = offset / chunk_size as u64;
                    iter = client
                        .iter_download(&media)
                        .chunk_size(chunk_size)
                        .skip_chunks(skip_chunks as i32);
                    need_new_iter = false;
                    first_chunk = true;
                }

                // Check cancellation before each chunk
                if state.cancelled_transfers.read().await.contains(&transfer_id)
            || state.proactive_generations.read().await.get(&message_id).copied() != Some(proactive_generation) {
                    log::info!("[PROACTIVE] msg {}: cancelled", message_id);
                    return Ok(total_downloaded);
                }

                // Check if the playhead has jumped (user seeked) — in EITHER direction.
                // Forward: target_byte > offset + 10MB (seek ahead)
                // Backward: target_byte + 10MB < offset AND target changed (new seek, not prebuffering ahead)
                //
                // CRITICAL: The backward check must verify the target ACTUALLY CHANGED.
                // Without this, PROACTIVE creates an infinite loop: it downloads ahead of
                // the seek target, then the backward check fires (target < offset), jumps
                // back, yields, re-evaluates, downloads ahead again, jumps back again...
                // The target only changes on NEW seeks or VBR corrections — not as playback
                // progresses. So we track last_target_byte and only trigger if it's different.
                {
                    let targets = state.proactive_targets.read().await;
                    if let Some(&(target_byte, _, _, _)) = targets.get(&message_id) {
                        // Capture the PREVIOUS observed target, then update. The
                        // update must happen before any break so the next iteration
                        // never sees a stale value.
                        let prev_target = last_target_byte;
                        last_target_byte = Some(target_byte);

                        if (!backfilling && target_byte > offset + 10 * 1024 * 1024)
                            || (backfilling && should_retarget_proactive(
                                true, offset, backfill_entry_target, target_byte,
                            )) {
                            log::info!(
                                "[PROACTIVE] msg {}: playhead jumped forward to byte {} (current offset {}), re-evaluating gaps",
                                message_id, target_byte, offset
                            );
                            jumped = true;
                            break;
                        } else if let Some(prev) = prev_target {
                            // Backward seek: the reported playhead target moved
                            // BACKWARD from the previously observed target by a
                            // meaningful margin (>10MB). During normal forward
                            // playback the target (derived from currentTime)
                            // increases monotonically — MP4's periodic position
                            // reporter sends an advancing playhead every 2s — so the
                            // old "target_changed" test fired on EVERY tick once
                            // PROACTIVE raced >50MB ahead, tearing down the download
                            // iterator ~1/s and forcing 5s yields (the green-bar
                            // pulsing). Requiring an actual backward delta fires only
                            // on a real backward seek / VBR correction, never on
                            // forward playback advancement.
                            if is_backward_reanchor(prev, target_byte) {
                                log::info!(
                                    "[PROACTIVE] msg {}: playhead jumped backward to byte {} (prev target {}, current offset {}), re-evaluating gaps",
                                    message_id, target_byte, prev, offset
                                );
                                jumped = true;
                                break;
                            }
                        }
                    }
                }

                // Yield to /stream: use try_acquire instead of blocking acquire.
                // When /stream is actively downloading (holding a permit or
                // player_actively_downloading is true), the prebuffer yields
                // instead of competing for the rate limiter budget. This gives
                // /stream 100% of the API call budget during seeks and active
                // playback, while the prebuffer fills disk only during idle time.
                let chunk_result = {
                    // Secondary throttle: check if the player's IOController is
                    // actively downloading. This flag is set by the frontend via
                    // cmd_report_playback_position(is_player_downloading=true).
                    // Round-9 I-2b: freshness-decayed timestamp — a stale report
                    // (MKV seek with no follow-up) stops starving the prebuffer
                    // after PLAYER_DOWNLOAD_FRESH_WINDOW_MS.
                    let stored = state.player_actively_downloading.load(std::sync::atomic::Ordering::Relaxed);
                    if player_download_flag_fresh(now_epoch_ms(), stored) {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        continue;
                    }
                    let _permit = match state.download_semaphore.try_acquire() {
                        Ok(permit) => permit,
                        Err(_) => {
                            // /stream is holding all permits — yield
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            continue;
                        }
                    };
                    throttle_api_calls(&state.rate_limiter).await;
                    iter.next().await
                };

                match chunk_result {
                    Ok(Some(chunk)) => {
                        // Reset retry counter on successful chunk
                        seq_retries = 0;

                        let chunk_slice: &[u8] = if first_chunk && skip_bytes > 0 && offset == gap_start {
                            let discard = skip_bytes.min(chunk.len() as u64) as usize;
                            first_chunk = false;
                            &chunk[discard..]
                        } else {
                            first_chunk = false;
                            &chunk
                        };

                        let remaining_in_gap = (gap_end - offset + 1) as usize;
                        let to_write = chunk_slice.len().min(remaining_in_gap);

                        let write_offset = offset; // absolute pos of these bytes

                        // Record Telegram network bytes for the speed meter
                        cache_mgr.add_downloaded_bytes(message_id, to_write as u64);

                        cache_file
                            .seek(SeekFrom::Start(offset))
                            .map_err(|e| format!("Seek error: {}", e))?;
                        cache_file
                            .write_all(&chunk_slice[..to_write])
                            .map_err(|e| format!("Write error: {}", e))?;

                        offset += to_write as u64;
                        total_downloaded += to_write as u64;

                        // Publish cached_ranges so /stream's poll loop can see
                        // the new bytes. Steady quantum is 1 MiB, but the FIRST
                        // write of every gap flushes immediately — that first
                        // chunk is the byte the player is blocked on at open (just
                        // drained the prefix) or after a seek (blocked at the new
                        // anchor), so revealing it now removes ~one 512KB/300ms
                        // limiter step from the wait. See should_publish_proactive_meta.
                        if should_publish_proactive_meta(offset, chunk_size as u64, first_chunk_published, offset > gap_end) {
                            first_chunk_published = false;
                            // Round-9 I-3b (meta resurrection): a cache discard
                            // deletes .meta.json while this task drains toward its
                            // next cancellation check; load_meta → None here would
                            // CREATE a fresh meta and resurrect the discarded cache
                            // with bogus ranges. cmd_delete_cache cancels BEFORE
                            // deleting, so re-checking the key just before the save
                            // closes the race to a µs-scale in-flight save (residual
                            // cleaned by the frontend's retry ladder).
                            if state.cancelled_transfers.read().await.contains(&transfer_id)
            || state.proactive_generations.read().await.get(&message_id).copied() != Some(proactive_generation) {
                                log::info!("[PROACTIVE] msg {}: cancelled — skipping meta save", message_id);
                                return Ok(total_downloaded);
                            }
                            let _lock = cache_mgr.lock_meta(message_id).await;
                            let mut meta = cache_mgr.load_meta(message_id).unwrap_or_else(|| CacheMeta {
                                message_id,
                                folder_id: folder_id.unwrap_or(i64::MIN),
                                total_size,
                                filename: filename.clone(),
                                cached_ranges: Vec::new(),
                                mime_type: mime_type.clone(),
                            });
                            meta.cached_ranges.push((gap_start, offset - 1));
                            merge_ranges(&mut meta.cached_ranges);
                            let _ = cache_mgr.save_meta(&meta);
                        }

                        // Progressive keyframe indexing (OUTSIDE the lock_meta scope
                        // above — never nest the index lock inside lock_meta).
                        // Best-effort; failures never disturb the download.
                        index_keyframes_from_chunk(
                            &mut kf_indexer, &chunk_slice[..to_write], write_offset,
                            message_id, total_size, &cache_mgr, &state,
                        ).await;

                        if offset > gap_end {
                            break;
                        }
                    }
                    Ok(None) => break, // End of stream
                    Err(e) => {
                        // Network/error — retry with backoff and recreate iterator
                        seq_retries += 1;
                        if seq_retries >= MAX_SEQ_RETRIES {
                            log::warn!(
                                "[PROACTIVE] msg {}: download at offset {} failed after {} retries: {}. Stopping gap.",
                                message_id, offset, MAX_SEQ_RETRIES, e
                            );
                            break; // Move to next gap
                        }
                        let delay = crate::commands::utils::backoff_with_jitter(seq_retries, 2000, 60_000);
                        log::warn!(
                            "[PROACTIVE] msg {}: download error at offset {} (attempt {}/{}): {}. Retry in {}ms",
                            message_id, offset, seq_retries, MAX_SEQ_RETRIES, e, delay
                        );
                        // Check cancellation during retry wait
                        if state.cancelled_transfers.read().await.contains(&transfer_id)
            || state.proactive_generations.read().await.get(&message_id).copied() != Some(proactive_generation) {
                            return Ok(total_downloaded);
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                        need_new_iter = true; // Recreate iterator from current offset
                    }
                }
            }
        }
    }

    Ok(total_downloaded)
}
