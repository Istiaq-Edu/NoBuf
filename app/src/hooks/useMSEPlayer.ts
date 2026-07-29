import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TelegramFile } from '../types';
import { SourceBufferWrapper } from '../lib/faststream/players/SourceBufferWrapper';
import { detectFormat, type DetectedFormat } from '../lib/faststream/utils/FormatDetector';
import { Input, BufferSource, MATROSKA } from 'mediabunny';
import { MediabunnyTransmuxer } from '../lib/faststream/players/MediabunnyTransmuxer';
import { MuxJsTsTransmuxer } from '../lib/faststream/players/MuxJsTsTransmuxer';

// Diagnostic logging helper — routes to both console and Rust backend terminal.
// Critical for debugging MSE/transmuxer issues where browser console isn't visible.
function diagLog(msg: string) {
  console.log(msg);
  invoke('cmd_log', { message: msg }).catch(() => {});
}
// Expose diagLog so lower-level modules (e.g. MpegtsChunkLoader) can route to the
// same dual-channel (console + Rust terminal) sink without importing this hook.
if (typeof window !== 'undefined') (window as any).__nobuf_diagLog = diagLog;
import { type TSKeyframeEntry } from '../lib/faststream/utils/TSByteOffsetScanner';
import { StreamShadowCache } from '../lib/faststream/StreamShadowCache';
import { createChunkedFetchLoader } from '../lib/faststream/MpegtsChunkLoader';

/**
 * Align a byte position to a TS-packet boundary that starts with the 0x47 sync byte.
 *
 * After rounding to a 188-byte boundary, the byte at that position may NOT be 0x47
 * (e.g. the TS stream has a different packet alignment, or the file has headers
 * before the first TS packet). If we feed the TSDemuxer a byte that isn't 0x47,
 * it reports "sync_byte=198, not 0x47" and tries to resync, producing 25+ repeated
 * sync errors, garbage frames, and large audio timestamp gaps (46293ms observed).
 *
 * This function:
 *   1. Rounds `bytePos` DOWN to the nearest 188-byte boundary
 *   2. Reads 1 byte from the shadow cache at that position (if cache available)
 *   3. If it's 0x47, returns that position
 *   4. If not, scans forward by 188 bytes up to 5 times looking for 0x47
 *   5. If no 0x47 found in cache, returns the 188-aligned position (best effort)
 *
 * @param bytePos - The candidate byte position (already approximately 188-aligned)
 * @param cache - The StreamShadowCache instance (may be null)
 * @returns The best TS-sync-byte-aligned position
 */
/**
 * Clamp a requested seek time into the valid [0, duration - tailMargin] range.
 * A remux (/remux?ss=) seek to exactly `duration` produces an empty ffmpeg
 * stream (no frames after the last one), so we leave a small tail margin. Also
 * defends against NaN/Infinity from the seek UI (→ 0). Used by the remux-seek
 * path; kept pure + exported for testing.
 */
export function clampSeekTime(requested: number, duration: number, tailMargin = 0.5): number {
  if (!Number.isFinite(requested) || requested < 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const upper = Math.max(0, duration - tailMargin);
  return Math.min(requested, upper);
}

/**
 * Build a /remux?ss=<time> seek URL from the base remux URL (which already
 * carries ?token=…). Appends with & or ? as appropriate and formats the seek
 * time to millisecond precision (matches the backend's {:.3} parse). Returns
 * null for a missing/blank base so callers can bail cleanly. Pure + exported
 * for testing.
 */
export function buildRemuxSeekUrl(
  baseUrl: string | null,
  seekTime: number,
  startByte?: number,
): string | null {
  if (!baseUrl) return null;
  const sep = baseUrl.includes('?') ? '&' : '?';
  // BYTE-FORWARD seek (preferred for timed_id3 TS over uncached Telegram data):
  // pass start_byte so the backend feeds ffmpeg [init_prefix + /stream bytes from
  // that offset] via stdin — no ffmpeg `-ss`, which fails to timestamp-seek an
  // undownloaded HTTP stream ("could not seek to position", empty output → the
  // player loads forever; proven logs 4-t/5-t). When a valid byte offset is given
  // we use it; otherwise fall back to the time `-ss` form (cached files / MKV).
  const t = Number.isFinite(seekTime) && seekTime > 0 ? seekTime : 0;
  if (typeof startByte === 'number' && Number.isFinite(startByte) && startByte > 0) {
    // Send BOTH: start_byte selects the input mechanism (stdin feeder, no ffmpeg
    // -ss), and ss carries the seek TIME the backend uses for -output_ts_offset so
    // the output timeline is ABSOLUTE (video.currentTime ≈ seek time). Without ss
    // here the output rebases to ~0 and the scrubber/green/white bars read wrong
    // (proven logs 6/7/8). The backend does NOT apply ffmpeg -ss when start_byte
    // is present, so ss is used ONLY as the output offset, not an input seek.
    return `${baseUrl}${sep}start_byte=${Math.floor(startByte)}&ss=${t.toFixed(3)}`;
  }
  return `${baseUrl}${sep}ss=${t.toFixed(3)}`;
}

/**
 * Decide whether an unbuffered seek should be routed through the ffmpeg-driven
 * /remux?ss= path (frame-accurate, audio-preserving, one recreation) rather than
 * the raw /stream byte-seek video-only path (linear estimate, muted audio,
 * scattered prebuffer). True IFF the source is served via /remux AND we captured
 * a base remux URL to seek against.
 *
 * This encodes the guard at the top of _mpegtsUnbufferedSeek. It is set for BOTH
 * transcoded MKV/HEVC (whose /stream is un-byte-seekable Matroska) AND timed_id3
 * TS (whose /stream IS real TS, but for which /remux?ss= is still strictly better:
 * ffmpeg -ss is frame-accurate and the seek-safe audio filter keeps sound, vs the
 * byte path which muted audio + guessed the byte offset on VBR content). Pure +
 * exported for testing.
 */
export function shouldUseRemuxSeek(
  needsRemuxSeek: boolean,
  remuxSeekBaseUrl: string | null,
): boolean {
  return needsRemuxSeek && !!remuxSeekBaseUrl;
}

/**
 * Is this MP4 codec string a member of the HEVC family? Covers plain HEVC
 * (hvc1/hev1) AND Dolby Vision HEVC (dvh1/dvhe) — DV profiles 5/8 are HEVC
 * bitstreams with DV RPU metadata, so the same /remux transcode path applies.
 * Pure + exported for testing.
 */
export function isHevcFamilyCodec(codec: string | null | undefined): boolean {
  if (!codec) return false;
  const c = codec.toLowerCase();
  return c.startsWith('hvc1') || c.startsWith('hev1') || c.startsWith('dvh1') || c.startsWith('dvhe');
}

/**
 * Compute the BYTE-FORWARD (start_byte) estimate for a /remux seek, or
 * undefined when byte-forward must NOT be used.
 *
 * Byte-forward feeds ffmpeg [TS init_prefix + raw /stream bytes from the
 * offset] via stdin — that is ONLY valid when the underlying /stream content
 * is real MPEG-TS (timed_id3 files). For MKV and MP4 sources the /stream
 * bytes are Matroska/ISOBMFF: feeding a mid-file slice to ffmpeg's stdin
 * dies instantly with "Invalid data found" (execution-proven), so those
 * sources must always seek with ffmpeg `-ss` over the seekable HTTP input.
 * Pure + exported for testing.
 */
export function computeRemuxSeekStartByte(
  sourceIsTs: boolean,
  timeSeconds: number,
  durationSeconds: number,
  fileSizeBytes: number,
): number | undefined {
  if (!sourceIsTs) return undefined;
  if (!Number.isFinite(timeSeconds) || timeSeconds <= 0) return undefined;
  if (!(durationSeconds > 0) || !(fileSizeBytes > 0)) return undefined;
  return Math.round((timeSeconds / durationSeconds) * fileSizeBytes);
}

/**
 * Can this runtime's MSE actually decode HEVC? True only when the HEVC Video
 * Extensions are installed (WebView2 uses Edge's Media Foundation path —
 * verified: stock machines return false even with PlatformHEVCDecoderSupport).
 * Sent to /remux as `hevc_ok` so 8-bit HEVC can be `-c:v copy`'d instead of
 * transcoded for the users who CAN decode it. Probe string = Main profile
 * L4.1 — the common 8-bit case (10-bit is always transcoded server-side
 * regardless of this hint). Pure-ish (reads MediaSource) + exported for testing.
 */
export function hevcMseSupported(
  isTypeSupported: (mime: string) => boolean = (m) =>
    typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(m),
): boolean {
  try {
    return isTypeSupported('video/mp4; codecs="hvc1.1.6.L123.B0"');
  } catch {
    return false;
  }
}

/**
 * Should the 10s proactive-position reporter SKIP this tick for a /remux stream?
 * For remux, `video.currentTime` is source-ABSOLUTE (ffmpeg emits absolute PTS,
 * _dtsBase pinned to 0), so the linear byte estimate is normally valid and MUST
 * keep flowing — cmd_report_playback_position is the ONLY trigger that starts the
 * proactive prebuffer. Skip ONLY the transient where a report would be bogus:
 *   - a seek recreation is in flight (video detached), or
 *   - the first ss-frame hasn't decoded yet so currentTime is still ≈0,
 * either of which would stomp the proactive target to byte 0. Non-remux (native
 * TS / timed_id3) never sets needsRemuxSeek, so this is inert there. Pure + exported
 * for testing.
 */
export function shouldSkipRemuxPositionReport(
  needsRemuxSeek: boolean,
  userSeekInProgress: boolean,
  currentTime: number,
): boolean {
  return needsRemuxSeek && (userSeekInProgress === true || currentTime < 1);
}

/**
 * Decide how to dispatch an unbuffered transmuxer seek: run it now ('execute')
 * or hold it for the debounce timer ('defer').
 *
 * ROOT CAUSE THIS FIXES (trace 21, cross-validated): the old logic fired a seek
 * immediately whenever the debounce window had elapsed since the last seek —
 * EVEN when a previous transmuxer seek was still in flight. During a rapid burst
 * of spaced-out seeks (each >debounce apart) that spawned TWO concurrent seeks
 * sharing source_id=playback on the persistent MKV Input; one got orphaned, its
 * backend read returned empty 206s, and the frontend empty-retried ~32s → "video
 * doesn't play / prebuffer never starts". The single decisive change: while a
 * seek is in flight, ALWAYS defer — never start a second concurrent seek. The
 * deferred timer re-checks this flag and re-arms until the in-flight seek clears,
 * then fires the LATEST target (last-target-wins coalescing preserved).
 *
 * Pure + exported for testing. Callers still handle the buffered-range instant
 * seek BEFORE reaching here (that path is untouched).
 */
export function decideSeekDispatch(
  now: number,
  lastSeekTime: number,
  debounceMs: number,
  seekInProgress: boolean,
  firstSeekEver: boolean,
): 'execute' | 'defer' {
  // A seek already running → never race a second one. Defer and let the timer
  // re-arm until it clears. This is the line that fixes the trace-21 freeze.
  if (seekInProgress) return 'defer';
  // Idle: the very first seek (or one spaced beyond the debounce window) runs now.
  if (firstSeekEver) return 'execute';
  return (now - lastSeekTime) >= debounceMs ? 'execute' : 'defer';
}

/**
 * True when a transmuxer seek's async completion is STALE and must NOT commit
 * its result (video.currentTime, startStreamingChain, refill). A seek captures
 * its generation at start; if a newer user seek has since bumped the live
 * generation, the older seek — which may take 5-8s on a cold far jump — has been
 * superseded and committing it would plant playback on a PREVIOUS position
 * (trace-22 "backward seek goes to previous point"). Pure + exported for testing.
 */
export function isSeekSuperseded(capturedGen: number, liveGen: number): boolean {
  return capturedGen !== liveGen;
}

/**
 * Decide whether the seek drain should INTERRUPT an in-flight seek so a newer
 * (superseding) target can run without waiting for the in-flight seek's full
 * lifecycle — cold getKeyPacket search + the multi-second transmux iteration,
 * up to ~13-16s in trace-29/30 for a position the user already abandoned.
 *
 * Two conditions, both required:
 *   - seekInProgress: a seek is genuinely running. If false we're in a pure
 *     debounce-window defer (rapid drag where the prior seek already completed)
 *     — there is nothing to interrupt, and firing interruptSeek() would set a
 *     stale seekAbortFlag that the NEXT seek would have to reset. So: never
 *     interrupt when idle.
 *   - !interruptSent: we haven't already interrupted during THIS drain. The
 *     interrupt is idempotent in effect (seekAbortFlag stays set, abortInFlight
 *     is a no-op once nothing is fetching, and the gen bump only needs to happen
 *     once), so re-firing every 120ms poll is wasted work and noise. Latch it.
 *
 * Pure + exported for testing. The caller (maybeInterrupt in the drain) owns the
 * side effects: bumping the frontend seek generation (so the interrupted seek's
 * completion is caught by isSeekSuperseded and never commits its abandoned
 * position) and calling transmuxer.interruptSeek().
 */
export function shouldInterruptInflightSeek(
  interruptSent: boolean,
  seekInProgress: boolean,
): boolean {
  return !interruptSent && seekInProgress;
}

/**
 * Decide whether the MKV disk warmer should YIELD (sleep) this iteration instead
 * of fetching a chunk. The warmer is best-effort background work that fills the
 * green bar; it must never compete with the player's own reads for the throttled
 * Telegram pipe.
 *
 * Yields when ANY of:
 *   - downloading: the player's cold-start / refill fetch is active.
 *   - bufferingForSeek: a seek is buffering segments (set true at seek start,
 *     false the instant the keyframe resolves — BEFORE the transmux iteration).
 *   - seekInProgress: a transmuxer seek is running. THIS is the term that was
 *     missing (trace-31 root cause): bufferingForSeek flips false when the
 *     keyframe resolves, but the multi-second transmux ITERATION runs after that
 *     — so without this term the warmer fetched at full rate for the whole 10-17s
 *     iteration, starving the seek's own reads. transmuxerSeekInProgressRef stays
 *     true from seek entry through completion, covering the entire window.
 *
 * Pure + exported for testing.
 */
export function shouldWarmerYield(
  downloading: boolean,
  bufferingForSeek: boolean,
  seekInProgress: boolean,
): boolean {
  return downloading || bufferingForSeek || seekInProgress;
}

/**
 * Decide where to place video.currentTime after a transmuxer seek resolves.
 *
 * WHY: a seek snaps to the cue keyframe AT/BELOW the requested time, so the
 * keyframe is typically 3-9s BEFORE the target (sparse VBR keyframes, ~8.5s
 * apart). Setting currentTime to the keyframe makes playback start early — the
 * trace-24 "backward seek to 875s starts at 872s" undershoot. The seek buffers
 * [keyframe, target + SEEK_START_DURATION], so the requested target sits INSIDE
 * the decoded range: setting currentTime to the target lets the decoder
 * decode-and-discard from the keyframe up to it (standard MSE), landing exactly.
 *
 * Guards:
 * - Prefer the requested `target` when it's within the buffered span
 *   [keyframe, bufferedEnd]. The decoder needs the keyframe ≤ target (always
 *   true here since keyframe is at/below target) and coverage up to target.
 * - If target > bufferedEnd (window too short / short tail), clamp to
 *   bufferedEnd so we never seek into an unbuffered hole (would re-stall).
 * - If target < keyframe (shouldn't happen — keyframe is at/below target), fall
 *   back to the keyframe.
 *
 * Pure + exported for testing.
 */
export function computeSeekLandingTime(
  target: number,
  keyframe: number,
  bufferedEnd: number,
): number {
  if (target < keyframe) return keyframe;        // defensive: never before the keyframe
  if (target > bufferedEnd) return bufferedEnd;  // never into an unbuffered hole
  return target;                                  // land exactly on the requested time
}

/**
 * Pin a freshly-created mpegts.js MP4Remuxer to an ABSOLUTE timeline (_dtsBase=0).
 *
 * WHY: /remux?ss=T emits MPEG-TS whose first sample PTS/DTS is ABSOLUTE (≈T·90000),
 * verified by execution. By default MP4Remuxer._calculateDtsBase() (called lazily on
 * the first remux()) sets _dtsBase to that first DTS, normalizing output to start at
 * 0 — so the SourceBuffer would land at 0 and the whole absolute-time UI (seek bar,
 * green/disk bar, byte↔time map, align poll) would read wrong. Pinning _dtsBase=0
 * makes output DTS = rawDTS/timescale = absolute seconds, so video.currentTime ≈ T.
 *
 * WHEN: call this the instant the remuxer is created from a REAL probe (i.e. from a
 * wrapper around _setupTSDemuxerRemuxer), BEFORE the first parseChunks→remux() runs
 * _calculateDtsBase. Setting _dtsBaseInited=true blocks that recompute
 * (mp4-remuxer.js:136/185). CRITICAL: do NOT pre-create the remuxer from FAKE probe
 * data before load()'s byte-0 prober runs — _setupTSDemuxerRemuxer ends with
 * demuxer.bindDataSource(ioctl) which overwrites ioctl.onDataArrival (the prober)
 * with parseChunks, so real ffmpeg bytes bypass TSDemuxer.probe() and never sync
 * (buffered stays EMPTY, MEDIA_INFO never fires). Let the real probe build the
 * demuxer/remuxer; only pin here.
 *
 * Idempotent and null-safe. Returns true if a remuxer was pinned. Pure-ish (only
 * mutates the passed object) + exported for testing.
 */
export function pinRemuxerDtsBase(remuxer: any): boolean {
  if (!remuxer) return false;
  remuxer._dtsBase = 0;
  remuxer._dtsBaseInited = true;
  // Reset per-track base accumulators so _calculateDtsBase (if ever reached) can't
  // lower the base below 0, and clear any stale segment/stash state from a prior use.
  remuxer._audioDtsBase = Infinity;
  remuxer._videoDtsBase = Infinity;
  remuxer._audioStashedLastSample = null;
  remuxer._videoStashedLastSample = null;
  remuxer._videoSegmentInfoList?.clear?.();
  remuxer._audioSegmentInfoList?.clear?.();
  try { remuxer.insertDiscontinuity?.(); } catch (_) { /* older builds lack this */ }
  return true;
}

export function alignToTSSyncByte(bytePos: number, cache: StreamShadowCache | null): number {
  // Step 1: Round down to 188-byte boundary
  let aligned = Math.floor(bytePos / 188) * 188;
  if (aligned < 0) aligned = 0;

  // Step 2: If no cache, can't verify — return 188-aligned position (best effort)
  if (!cache) {
    diagLog(`[TS-SYNC-ALIGN] No shadow cache available — using 188-aligned byte ${aligned} (cannot verify 0x47)`);
    return aligned;
  }

  // Step 2b: If cache exists but has no entries, skip forward/backward scan.
  // The cache was fully evicted — we can't verify 0x47 but also can't find
  // evidence of a problem. Return the 188-aligned position directly.
  if (cache.entryCount === 0) {
    diagLog(`[TS-SYNC-ALIGN] INFO: Cache empty — using 188-aligned byte ${aligned} (cannot verify 0x47, no cache data available)`);
    return aligned;
  }

  // Step 3: Scan forward at 188-byte boundaries looking for 0x47 sync byte
  const MAX_SCAN = 5; // Scan up to 5 packets forward (~940 bytes)
  for (let i = 0; i <= MAX_SCAN; i++) {
    const candidate = aligned + i * 188;
    // Read 1 byte at candidate position from cache
    const byteData = cache.getRange(candidate, candidate);
    if (byteData && byteData[0] === 0x47) {
      if (i > 0) {
        diagLog(`[TS-SYNC-ALIGN] 0x47 sync byte found at offset ${candidate} (scanned ${i} packets forward from ${aligned})`);
      }
      return candidate;
    }
  }

  // Step 4: Cache-gap fallback — forward scan all returned null.
  // This happens when the cache ends just before the target position
  // (e.g. cache covers [0, X] and target is X+1). Since TS packets are
  // periodic with 0x47 every 188 bytes, if we can verify 0x47 at a
  // cache-covered 188-boundary, we can extrapolate forward to the target.
  // Scan backward up to 5 packets from the aligned position.
  const MAX_BACK_SCAN = 5;
  const cacheEndByte = cache.cachedUpTo(aligned); // furthest contiguous cached byte from aligned
  let hadCacheDataInScan = false;
  for (let i = 1; i <= MAX_BACK_SCAN; i++) {
    const backCandidate = aligned - i * 188;
    if (backCandidate < 0) break;
    // Only check positions that are within the cache's coverage
    if (backCandidate > cacheEndByte) continue;
    const byteData = cache.getRange(backCandidate, backCandidate);
    if (byteData) {
      hadCacheDataInScan = true;
      if (byteData[0] === 0x47) {
        // Verified 0x47 at a cache-covered boundary. Since TS packets are
        // periodic (0x47 every 188 bytes), the target boundary also has 0x47.
        diagLog(`[TS-SYNC-ALIGN] INFO: Cache-gap extrapolation — verified 0x47 at cache-covered byte ${backCandidate}, extrapolating forward ${i} packets to ${aligned} (cache ends at ${cacheEndByte})`);
        return aligned;
      }
    }
  }

  // Step 5: No 0x47 found in the cache-covered part of the scan range.
  // If we had cache data but none of the scanned boundaries were 0x47, the
  // cache is misaligned or the packet size is not 188 bytes — that's a real
  // problem. If the cache simply didn't cover the scan range, we can't verify
  // and the aligned position is still the best guess; log as INFO, not WARNING.
  if (hadCacheDataInScan) {
    diagLog(`[TS-SYNC-ALIGN] WARNING: No 0x47 sync byte found at 188-byte boundaries ${aligned - MAX_BACK_SCAN * 188}..${aligned + MAX_SCAN * 188} (cache ends at ${cacheEndByte}) — using ${aligned} (may cause sync errors)`);
  } else {
    diagLog(`[TS-SYNC-ALIGN] INFO: No cache data in backward scan range ${aligned - MAX_BACK_SCAN * 188}..${aligned - 188} (cache ends at ${cacheEndByte}) — using 188-aligned byte ${aligned} (cannot verify 0x47)`);
  }
  return aligned;
}

/**
 * Compute the correct byte position where the IOController should resume downloading.
 *
 * ROOT CAUSE: mpegts.js IOController.pause() sets _resumeFrom = _currentRange.to + 1.
 * But _currentRange.to is ONLY updated when the loader's response stream completes
 * _dispatchChunks(). When pause() fires via abort(), the in-flight response is killed,
 * and _currentRange.to reflects only the bytes that were transmuxed BEFORE abort —
 * NOT the total bytes that the SourceBuffer has already processed.
 *
 * This means _resumeFrom is always stale (behind the actual buffer end) after a
 * lazyLoad suspend. The IOController then seeks to the stale byte, producing
 * overlapping DTS data that the SourceBuffer silently discards → player stalls.
 *
 * FIX: The SourceBuffer's bufferEnd time IS the ground truth for what data has
 * been processed. Compute the resume byte from bufferEnd, not from the IOController's
 * stale _currentRange.to.
 *
 * @returns The correct byte position to resume from, or -1 if computation fails
 */
export function computeResumeByte(
  bufEnd: number,
  duration: number,
  fileLength: number,
  cache: StreamShadowCache | null,
  undershoot?: boolean,
  samples?: ByteTimeSample[],
  keyframes?: TSKeyframeEntry[],
): number {
  if (bufEnd <= 0 || duration <= 0 || fileLength <= 0) return -1;

  // Step 1: Convert bufferEnd time → approximate byte position.
  // Prefer the authoritative backend keyframe index (VBR-accurate), then legacy
  // samples, then global linear bitrate.
  let byte: number;
  if (keyframes && keyframes.length >= 2) {
    byte = byteOffsetAtOrBeforeTime(keyframes, bufEnd, duration, fileLength);
  } else if (samples && samples.length >= 2) {
    byte = findByteForTime(bufEnd, samples, duration, fileLength);
  } else {
    byte = Math.floor((bufEnd / duration) * fileLength);
  }

  // Step 1b: Undershoot for lazyLoad resume.
  // Due to VBR, the actual PTS at the computed byte position can be 3-5s
  // AHEAD of bufEnd. Without undershoot, this creates a SourceBuffer gap
  // (white bar) between the existing data ending at bufEnd and the new
  // data starting at the PTS of the resume byte.
  //
  // By undershooting ~5s, the new data starts BEFORE bufEnd, creating an
  // OVERLAP with existing SourceBuffer data. Chrome merges overlapping
  // appends into one continuous range → no white bar gap.
  //
  // This is SAFE because:
  //   - insertDiscontinuity() resets _nextDts=undefined → dtsCorrection=0
  //     for the first frame → accepted (not dropped)
  //   - Demuxer FULL RESET clears stale PES queues, PCR state → no corruption
  //
  // History: v1 used 10s undershoot WITHOUT insertDiscontinuity → stale
  // _nextDts caused dtsCorrection=-3s → ALL frames dropped. That failure
  // was NOT caused by undershoot itself, but by the missing insertDiscontinuity.
  // With insertDiscontinuity, undershoot works correctly.
  if (undershoot) {
    const bytesPerSecond = fileLength / duration;
    const UNDERSHOOT_SECONDS = 5;
    byte = Math.max(0, byte - Math.floor(UNDERSHOOT_SECONDS * bytesPerSecond));
  }

  byte = Math.floor(byte / 188) * 188;  // TS packet alignment

  // DO NOT bump byte to cacheEnd. The shadow cache may have prebuffered
  // data far ahead of bufEnd (e.g., bufEnd=158s but cache goes to 317s).
  // Starting from cacheEnd would skip 160s of content that the SourceBuffer
  // needs, producing a massive DTS gap → decode error → player death.
  // The /stream endpoint already uses CACHE-PREFIX to serve cached data
  // fast, so there's no benefit to jumping ahead.

  // Step 2: Verify 0x47 TS sync byte at the aligned position
  byte = alignToTSSyncByte(byte, cache);

  // Step 3: return verified byte
  return byte;
}

export interface ByteTimeSample {
  time: number;
  byte: number;
}

/**
 * Decide how a TS seek should be handled while prefetch may be paused.
 *
 * Single source of truth for the pause/seek policy (mirrors the branches in
 * seekTo): a seek only needs the network when its target is neither in the
 * in-memory SourceBuffer nor on local disk. "Paused means paused" — while
 * paused we allow buffered/cache-hit seeks (they read memory/disk, never
 * Telegram) but block unbuffered seeks (which would fetch from Telegram).
 *
 * @param isPaused    Whether prefetch is currently paused by the user.
 * @param isBuffered  Target time is inside the in-memory SourceBuffer.
 * @param isCacheHit  Target's forward window is fully on local disk cache.
 * @returns 'buffered' | 'cache' | 'network' | 'blocked-paused'
 */
export type TsSeekAction = 'buffered' | 'cache' | 'network' | 'blocked-paused';
export function decideTsSeekAction(
  isPaused: boolean,
  isBuffered: boolean,
  isCacheHit: boolean
): TsSeekAction {
  if (isBuffered) return 'buffered';   // memory — always allowed, no network
  if (isCacheHit) return 'cache';      // local disk — always allowed, no network
  if (isPaused) return 'blocked-paused'; // would hit Telegram → honor pause
  return 'network';                    // not paused → fetch from Telegram
}


/**
 * Find the byte position for a target media time using observed byte-to-time samples.
 * Falls back to global linear bitrate mapping if there are not enough samples.
 * This is necessary for VBR TS streams where the average bitrate is not accurate
 * enough to resume from the correct byte after SourceBuffer eviction.
 *
 * @param targetTime Target media time in seconds
 * @param samples Observed (time, byte) pairs from the IOController
 * @param fallbackDuration Total duration (for linear fallback)
 * @param fallbackFileLength Total file length (for linear fallback)
 * @returns Byte position, or -1 if it cannot be determined
 */
export function findByteForTime(
  targetTime: number,
  samples: ByteTimeSample[],
  fallbackDuration: number,
  fallbackFileLength: number
): number {
  if (!Number.isFinite(targetTime) || targetTime <= 0) return 0;
  if (!Array.isArray(samples) || samples.length < 2) {
    if (fallbackDuration > 0 && fallbackFileLength > 0) {
      return Math.min(fallbackFileLength, Math.floor((targetTime / fallbackDuration) * fallbackFileLength));
    }
    return -1;
  }
  // find bracketing samples
  let lower = samples[0];
  let upper = samples[samples.length - 1];
  for (let i = 0; i < samples.length - 1; i++) {
    if (samples[i].time <= targetTime && samples[i + 1].time >= targetTime) {
      lower = samples[i];
      upper = samples[i + 1];
      break;
    }
  }
  if (!lower || !upper) {
    if (fallbackDuration > 0 && fallbackFileLength > 0) {
      return Math.min(fallbackFileLength, Math.floor((targetTime / fallbackDuration) * fallbackFileLength));
    }
    return -1;
  }
  // Detect corrupted samples: NaN/negative bytes, bytes beyond the file, or a flat
  // region where time advanced but byte barely moved (IOController paused at EOF).
  const timeSpan = upper.time - lower.time;
  const byteSpan = Math.abs(upper.byte - lower.byte);
  const isCorrupted =
    !Number.isFinite(lower.byte) || !Number.isFinite(upper.byte) ||
    !Number.isFinite(byteSpan) ||
    lower.byte < 0 || upper.byte < 0 ||
    lower.byte > fallbackFileLength || upper.byte > fallbackFileLength ||
    (timeSpan > 5 && byteSpan < 1024);
  if (isCorrupted) {
    if (fallbackDuration > 0 && fallbackFileLength > 0) {
      return Math.min(fallbackFileLength, Math.floor((targetTime / fallbackDuration) * fallbackFileLength));
    }
    return -1;
  }
  const localBitrate = upper.time > lower.time
    ? (upper.byte - lower.byte) / (upper.time - lower.time)
    : 0;
  let byte: number;
  if (targetTime <= lower.time) {
    byte = Math.max(0, lower.byte + Math.floor((targetTime - lower.time) * (localBitrate || 0)));
  } else if (targetTime >= upper.time) {
    byte = Math.max(0, upper.byte + Math.floor((targetTime - upper.time) * (localBitrate || 0)));
  } else {
    const tDiff = upper.time - lower.time;
    if (tDiff <= 0) return lower.byte;
    const ratio = (targetTime - lower.time) / tDiff;
    byte = Math.floor(lower.byte + ratio * (upper.byte - lower.byte));
  }
  // Clamp or fall back if the computed byte is outside the file or non-finite.
  if (!Number.isFinite(byte) || byte < 0 || byte > fallbackFileLength) {
    if (fallbackDuration > 0 && fallbackFileLength > 0) {
      return Math.min(fallbackFileLength, Math.floor((targetTime / fallbackDuration) * fallbackFileLength));
    }
    return -1;
  }
  return byte;
}

const SLIDING_WINDOW_BACKWARD_SECONDS = 30;      // keep 30s behind playhead
const SLIDING_WINDOW_FORWARD_SECONDS = 180;      // target 180s ahead of playhead
const SLIDING_WINDOW_MIN_FORWARD_SECONDS = 60;   // never go below this
const SAFE_SOURCE_BUFFER_BUDGET_BYTES = 250 * 1024 * 1024; // 250 MB per SourceBuffer

export function computeSlidingWindowSeconds(
  bitrateBps: number,
  _playbackRate: number
): { backward: number; forward: number } {
  if (!isFinite(bitrateBps) || bitrateBps <= 0) {
    return {
      backward: SLIDING_WINDOW_BACKWARD_SECONDS,
      forward: SLIDING_WINDOW_MIN_FORWARD_SECONDS,
    };
  }

  const targetForward = SLIDING_WINDOW_FORWARD_SECONDS;
  const targetBackward = SLIDING_WINDOW_BACKWARD_SECONDS;
  const maxBytes = SAFE_SOURCE_BUFFER_BUDGET_BYTES;
  const maxTotalSeconds = maxBytes / bitrateBps;

  if (targetForward + targetBackward <= maxTotalSeconds) {
    return { backward: targetBackward, forward: targetForward };
  }

  // Shrink backward first, then forward, but never below minimums.
  let backward = Math.min(
    targetBackward,
    Math.max(5, maxTotalSeconds - SLIDING_WINDOW_MIN_FORWARD_SECONDS)
  );
  let forward = Math.max(
    SLIDING_WINDOW_MIN_FORWARD_SECONDS,
    maxTotalSeconds - backward
  );

  // If even minimums don't fit, clamp both to the budget.
  if (backward + forward > maxTotalSeconds) {
    forward = Math.max(0, maxTotalSeconds - backward);
    if (backward + forward > maxTotalSeconds) {
      backward = Math.max(0, maxTotalSeconds - forward);
    }
  }

  return { backward: Math.floor(backward), forward: Math.floor(forward) };
}

/** A simple {start,end} time range, decoupled from the browser TimeRanges API
 *  so the buffered-ahead math is pure and unit-testable. */
export interface SimpleTimeRange {
  start: number;
  end: number;
}

/** Max gap (seconds) between two buffered ranges that we still treat as
 *  "contiguous" for playback. Mirrors hls.js `maxBufferHole` (0.1–0.5s): MP4
 *  segment boundaries can leave sub-frame rounding gaps that are not real holes.
 *  Kept small so genuine gaps (a forward region we still need to fetch) are NOT
 *  bridged — the download loop must see those as "need more data". */
export const MAX_BUFFER_HOLE_SECONDS = 0.5;

/**
 * Contiguous buffered seconds AHEAD of `pos`, tolerating holes smaller than
 * `maxHoleDuration`. This is the correct measure for download backpressure:
 * only the buffer that is actually reachable from the playhead by continuous
 * playback counts. A far-away buffered island (e.g. leftover data from a
 * previous seek near EOF, 5000s away from the current position) is UNPLAYABLE
 * from `pos` and must NOT be counted — otherwise the download loop believes the
 * buffer is full and stops fetching, deadlocking playback after a seek.
 *
 * Algorithm mirrors hls.js `BufferHelper.bufferedInfo`
 * (src/utils/buffer-helper.ts): sort ranges, merge sub-`maxHoleDuration` holes
 * and overlaps, then walk forward from the range containing `pos` and return
 * `end - pos`. Stops at the first real gap.
 *
 * Edge cases handled explicitly (see tests):
 *  - empty ranges → 0
 *  - non-finite / negative pos → treated as 0
 *  - unsorted or overlapping input ranges (browsers don't guarantee order)
 *  - pos before all ranges (far island ahead) → 0
 *  - pos at/after the last range end → 0
 *  - pos just before a range within tolerance → bridges the tiny gap
 *  - big forward gap → counts only up to the gap, not past it
 */
export function contiguousBufferedAhead(
  ranges: SimpleTimeRange[],
  pos: number,
  maxHoleDuration: number = MAX_BUFFER_HOLE_SECONDS
): number {
  if (!ranges || ranges.length === 0) return 0;
  if (!Number.isFinite(pos)) return 0;
  pos = Math.max(0, pos);
  const hole = Number.isFinite(maxHoleDuration) && maxHoleDuration > 0 ? maxHoleDuration : 0;

  // Copy + sort by start (then wider range first) — browsers do not guarantee
  // buffered ranges are sorted, and we must not mutate the caller's array.
  const sorted = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .slice()
    .sort((a, b) => a.start - b.start || b.end - a.end);
  if (sorted.length === 0) return 0;

  // Merge overlaps and holes smaller than maxHoleDuration into contiguous spans.
  const merged: SimpleTimeRange[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (merged.length) {
      const last = merged[merged.length - 1];
      if (r.start - last.end < hole) {
        if (r.end > last.end) last.end = r.end;
        continue;
      }
    }
    merged.push({ start: r.start, end: r.end });
  }

  // Walk forward from the merged span that contains (or nearly contains) pos.
  let bufferEnd = pos;
  for (let i = 0; i < merged.length; i++) {
    const { start, end } = merged[i];
    if (pos + hole >= start && pos < end) {
      // pos is inside this span (within tolerance) — its end is our reachable edge
      bufferEnd = end;
    } else if (pos + hole < start) {
      // next span starts beyond a real gap — unreachable from pos, stop
      break;
    }
  }
  return Math.max(0, bufferEnd - pos);
}

export function findTimeForByte(
  targetByte: number,
  samples: ByteTimeSample[],
  fallbackDuration: number,
  fallbackFileLength: number
): number {
  if (targetByte <= 0) return 0;
  if (!Array.isArray(samples) || samples.length < 2) {
    if (fallbackDuration > 0 && fallbackFileLength > 0) {
      return Math.floor((targetByte / fallbackFileLength) * fallbackDuration);
    }
    return 0;
  }
  let lower = samples[0];
  let upper = samples[samples.length - 1];
  for (let i = 0; i < samples.length - 1; i++) {
    if (samples[i].byte <= targetByte && samples[i + 1].byte >= targetByte) {
      lower = samples[i];
      upper = samples[i + 1];
      break;
    }
  }
  if (!lower || !upper) {
    if (fallbackDuration > 0 && fallbackFileLength > 0) {
      return Math.floor((targetByte / fallbackFileLength) * fallbackDuration);
    }
    return 0;
  }
  const localBitrate = upper.byte > lower.byte
    ? (upper.time - lower.time) / (upper.byte - lower.byte)
    : 0;
  if (targetByte <= lower.byte) {
    return Math.max(0, lower.time + Math.floor((targetByte - lower.byte) * (localBitrate || 0)));
  }
  if (targetByte >= upper.byte) {
    return Math.max(0, upper.time + Math.floor((targetByte - upper.byte) * (localBitrate || 0)));
  }
  const bDiff = upper.byte - lower.byte;
  if (bDiff <= 0) return lower.time;
  const ratio = (targetByte - lower.byte) / bDiff;
  return Math.floor(lower.time + ratio * (upper.time - lower.time));
}

/**
 * MSE (MediaSource Extensions) player hook using FastStream's approach.
 * Falls back to native video if MSE fails (non-MP4 format, etc.)
 */

/** mp4box.js info object from onReady callback */
interface MP4BoxInfo {
  hasMoov: boolean;
  duration: number;
  timescale: number;
  isFragmented: boolean;
  isProgressive: boolean;
  tracks?: MP4BoxTrack[];
  videoTracks?: MP4BoxTrack[];
  audioTracks?: MP4BoxTrack[];
}

/** mp4box.js track info */
interface MP4BoxTrack {
  id: number;
  codec: string;
  width?: number;
  height?: number;
  duration: number;
  timescale: number;
}

/** mp4box.js instance interface (minimal typing) */
interface MP4BoxFile {
  onReady: (info: MP4BoxInfo) => void;
  onError: (e: any) => void;
  onSegment: (trackId: number, user: any, buffer: ArrayBuffer, sampleNum: number, isLast: boolean) => void;
  appendBuffer: (buffer: any) => void;
  flush: () => void;
  seek: (time: number, sync: boolean) => any; // Returns { offset, sync_sample_time }
  setSegmentOptions: (trackId: number, user: any, options: { nbSamples: number }) => void;
  initializeSegmentation: () => Array<{ id: number; buffer: ArrayBuffer; user: any }>;
  getTrackSamplesInfo: (trackId: number) => Array<{ offset: number; size: number }> | undefined;
  start: () => void;
  stop: () => void;
}

/** Getters for MSE thumbnail mini-pipeline data — passed from useMSEPlayer to useThumbnailExtractor */
export interface MSEGetters {
  getMoovBuffer: () => { buffer: ArrayBuffer; fileStart: number } | null;
  getFirstChunk: () => ArrayBuffer | null;
  getInitSegments: () => Array<{ id: number; buffer: ArrayBuffer }>;
  getVideoTrackInfo: () => { trackId: number; codec: string } | null;
  getMP4BoxClass: () => any;
  getFileLength: () => number;
  isTransmuxer: () => boolean;
  getFormat: () => string; // 'mp4' | 'mkv' | 'ts' | 'unknown'
  getKnownDuration: () => number; // Probed/metadata duration (s) — lets the thumbnail pipeline skip mediabunny's EOF-scanning computeDuration() for headerless MKV
  isTransmuxerActive: boolean; // State that triggers re-render when transmuxer initializes
  keyframeIndexReady: boolean; // State that triggers re-render when keyframe index is built
  getKeyframeTimestamps: () => number[]; // Cached keyframe timestamps for thumbnail pipeline
  getKeyframeByteOffsets: () => TSKeyframeEntry[]; // Byte-offset index for OffsetCustomSource
  getTsHeaderData: () => Uint8Array | null; // TS header (PAT/PMT) for OffsetCustomSource
  getTransmuxerSourceConfig: () => { url: string; fileSize: number; headers?: Record<string, string> } | null;
  // TS→fMP4 backend pipeline — when active, thumbnails use backend segment endpoints
  isFmp4Stream: () => boolean;
  getFmp4Config: () => {
    baseUrl: string; // e.g. "http://host/fmp4"
    folderId: string;
    messageId: string;
    queryParams: string; // e.g. "token=abc"
    mimeType: string; // e.g. 'video/mp4; codecs="avc1.64001f,mp4a.40.2"'
    duration: number;
    fileSize: number;
  } | null;
  // MP4-HEVC→/remux reroute — when set, hover thumbnails come from the
  // backend /thumb endpoint (server-side ffmpeg single-frame JPEG grab).
  getRemuxThumbConfig: () => {
    baseUrl: string;
    folderId: string;
    messageId: string;
    token: string;
    duration: number;
  } | null;
}

const FRAGMENT_SIZES = [
  512 * 1024,   // 512KB — fast first frame after seek (MP4 moov discovery)
  1024 * 1024,  // 1MB
  2 * 1024 * 1024,  // 2MB
  4 * 1024 * 1024,  // 4MB
  8 * 1024 * 1024,  // 8MB — steady state, saturates bandwidth
];

// TS format needs a larger initial prefetch because mediabunny's MpegTsDemuxer.readMetadata()
// scans sequentially from byte 0 in 188-byte strides until ALL elementary streams are
// initialized (PAT found, PMT found, video IDR keyframe with SPS data extracted). The seed
// data serves reads within [0, seedLength] from memory (zero latency), bypassing HTTP
// round-trip delays through the Tauri/WebView2 bridge (~0.5-1s per request). If the scan
// goes beyond the seed boundary, each 188-byte read becomes a separate HTTP request through
// the bridge, making the scan extremely slow (~64KB/s). 20MB ensures readMetadata() completes
// within the seed for virtually all TS files (covers PAT/PMT, audio stream init, first video
// IDR/SPS, plus ~30s of playback data). 5MB was insufficient — the first video IDR with SPS
// data lay beyond 5MB on test files, forcing the demuxer into slow HTTP reads that hung init.
// MKV/WebM initial header prefetch. Sized to cover BOTH codec detection (EBML
// header + Tracks, near byte 0) AND the first playback cluster/GOP — so the
// blocking startup cost is a SINGLE sequential cold read instead of two (the
// header prefetch, then a second cold fetch inside seekTo(0) for the cluster).
// The transmuxer reads everything past this via the TauriStreamSource (cached
// range requests); the Cues live at the file tail and are fetched separately.
// Why 6MB: every byte from Telegram is gated by a single ~300ms rate limiter
// (~1.14 MB/s, parallelism forbidden — FLOOD_PREMIUM_WAIT), so the goal is to
// minimise the NUMBER of cold round-trips, not fetch "more". 2MB covered the
// header but stopped before the first cluster (→ a separate ~7s seekTo fetch on
// a cold 1080p file); 6MB brackets the first GOP so seekTo(0) serves from the
// in-memory seed and playback starts as soon as this one fetch lands (~5s cold,
// vs the old 20MB/~13s). If a log ever shows the first seekTo still doing a long
// cold read, the first cluster exceeded 6MB — bump this (never back to 20MB).
const MKV_INITIAL_PREFETCH = 6 * 1024 * 1024; // 6MB

/**
 * Detect the primary video codec of an MKV/WebM file from already-fetched header
 * bytes, using mediabunny's Matroska demuxer (same lib already used for the TS
 * seed path). Returns the mediabunny VideoCodec string ('avc' | 'hevc' | 'vp9' |
 * 'av1' | 'vp8') or null if it can't be determined from the given bytes.
 *
 * Why: the /remux ffmpeg pipeline copies the video stream into MPEG-TS
 * (`-c:v copy -f mpegts`), which mpegts.js then plays with full seek + progress
 * bar. MPEG-TS can only carry H.264 (avc) and H.265 (hevc) via stream copy —
 * VP8/VP9/AV1 cannot be muxed into TS and must fall back to native <video>
 * (WebM/VP9 plays natively in WebView2 anyway). We therefore route MKV by codec:
 * avc/hevc → /remux → mpegts.js; everything else → native.
 *
 * The backend's custom Rust fMP4 demuxer cannot parse Matroska, so this
 * detection is done client-side from the prefetched header bytes.
 */
async function detectMkvVideoCodec(data: ArrayBuffer): Promise<string | null> {
  try {
    const input = new Input({ source: new BufferSource(data), formats: [MATROSKA] });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return null;
    const codec = await videoTrack.getCodec();
    return codec ?? null;
  } catch (e: any) {
    diagLog(`[MSE] detectMkvVideoCodec failed: ${e?.message ?? e}`);
    return null;
  }
}


const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20MB max buffer before eviction
const BUFFER_KEEP_BEHIND = 30; // Keep 30s behind current playback position
const MAX_BUFFER_AHEAD_SECONDS = 30; // Backpressure — stop downloading when >30s buffered ahead (data NOT yet on disk)
// Dynamic backpressure: when the data just ahead of the buffer is ALREADY on
// local disk, appending it is a near-free disk read (no Telegram round-trip),
// so we let the playback buffer run much further ahead — the user asked for the
// playback buffer to drain the prebuffer instead of stalling at a hardcoded cap.
// The network cap above still applies whenever the next bytes must be fetched,
// which is what prevents QuotaExceededError on huge uncached forward runs.
const MAX_BUFFER_AHEAD_LOCAL_SECONDS = 120;

// Cold-start overlay thresholds: show the overlay while the first chunk is being
// pulled into the shadow cache, then fade it out once the player can start.
// Align to the 188-byte TS packet size so the cache stays contiguous.
const MIN_COLD_START_BUFFER_BYTES = alignChunkSize(5 * 1024 * 1024); // ~5 MB fallback
const COLD_START_TIMEOUT_MS = 10000;                   // never wait longer than 10 s

/** Cold-start overlay phases — tells the UI what's happening and why. */
export type ColdStartPhase = 'none' | 'fetching_metadata' | 'buffering' | 'initializing_player';

/**
 * Compute a dynamic cold-start buffer threshold based on available video metadata.
 *
 * Strategy:
 * - If duration + file size are known → estimate bitrate, buffer ~3s of video
 *   (clamped between 2 MB and 30 MB)
 * - If only file size is known → scale logarithmically (bigger files = higher bitrate)
 * - Fallback → 5 MB (the old hardcoded default)
 *
 * TS files always align to 188-byte packet boundaries.
 */
function computeColdStartThreshold(
  fileSize: number,
  duration: number | undefined,
  format: string,
  isPublicChannel: boolean,
): number {
  const MIN_THRESHOLD = 2 * 1024 * 1024;   // 2 MB floor
  const MAX_THRESHOLD = 30 * 1024 * 1024;  // 30 MB ceiling
  const PUBLIC_MULTIPLIER = 2;              // public channels get 2x buffer
  const BUFFER_SECONDS = 3;                 // target 3s of video data

  let threshold: number;

  if (duration && duration > 0 && fileSize > 0) {
    // Best case: we know bitrate → buffer BUFFER_SECONDS of video
    const bytesPerSecond = fileSize / duration;
    threshold = Math.floor(bytesPerSecond * BUFFER_SECONDS);
  } else if (fileSize > 0) {
    // No duration → scale by file size (log curve: 10MB→3MB, 100MB→5MB, 1GB→8MB, 5GB→12MB)
    const sizeMB = fileSize / (1024 * 1024);
    threshold = Math.floor((2 + Math.log10(Math.max(1, sizeMB)) * 2.5) * 1024 * 1024);
  } else {
    threshold = MIN_COLD_START_BUFFER_BYTES;
  }

  if (isPublicChannel) threshold *= PUBLIC_MULTIPLIER;
  threshold = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, threshold));

  // TS format: align to 188-byte packet boundaries
  if (format === 'ts') threshold = alignChunkSize(threshold);

  return threshold;
}

/** Round a byte budget down to a multiple of the TS packet size (188). */
function alignChunkSize(size: number): number {
  return Math.floor(size / 188) * 188;
}

/** Get chunk size based on how many chunks have been fetched since last seek */
function getChunkSize(chunksAfterSeek: number): number {
  const idx = Math.min(chunksAfterSeek, FRAGMENT_SIZES.length - 1);
  return FRAGMENT_SIZES[idx];
}

/** Merge overlapping or adjacent [start,end] byte ranges into a minimal set */
function mergeByteRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1] + 1) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

/** Find the byte offset of the last keyframe at or before targetTime.
 *  Uses the backend keyframe index for VBR-accurate byte-time mapping.
 *  Falls back to linear mapping if the index is empty or the target is outside it. */
export function byteOffsetAtOrBeforeTime(
  keyframes: TSKeyframeEntry[],
  targetTime: number,
  fallbackDuration: number,
  fallbackFileLength: number
): number {
  if (targetTime <= 0) return 0;
  if (!Array.isArray(keyframes) || keyframes.length < 2) {
    if (fallbackDuration > 0 && fallbackFileLength > 0) {
      return Math.floor((targetTime / fallbackDuration) * fallbackFileLength);
    }
    return -1;
  }
  let lo = 0;
  let hi = keyframes.length - 1;
  if (keyframes[lo].timestamp > targetTime) {
    if (fallbackDuration > 0 && fallbackFileLength > 0) {
      return Math.floor((targetTime / fallbackDuration) * fallbackFileLength);
    }
    return -1;
  }
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keyframes[mid].timestamp <= targetTime) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const kf = keyframes[lo];
  // The keyframe index may have sparse coverage — e.g., entries at 0-60s
  // (from initial playback demuxing) and ~2073s (from PTS tail download),
  // with nothing in between. The binary search finds the last keyframe at
  // or before targetTime, but if that keyframe is far from the target
  // (e.g., 12s when seeking to 707s), the index doesn't cover the seek
  // position and the keyframe's byte offset is useless.
  // Fall back to linear interpolation when the gap is >30s — keyframes in
  // TS streams are typically 2-5s apart, so >30s means clearly uncovered.
  if (kf && fallbackDuration > 0 && fallbackFileLength > 0) {
    const timeGap = targetTime - kf.timestamp;
    if (timeGap > 30) {
      return Math.floor((targetTime / fallbackDuration) * fallbackFileLength);
    }
  }
  return kf && Number.isFinite(kf.byteOffset) ? kf.byteOffset : Math.floor((targetTime / fallbackDuration) * fallbackFileLength);
}

async function fetchMpegtsKeyframeIndex(
  baseUrl: string,
  folderId: string,
  messageId: string,
  token: string
): Promise<{ keyframes: TSKeyframeEntry[]; partial: boolean }> {
  try {
    const response = await fetch(`${baseUrl}/fmp4/keyframes/${folderId}/${messageId}?token=${encodeURIComponent(token)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { keyframes: [], partial: true };
    const data = await response.json() as { keyframes?: Array<{ timestamp_s?: number; timestamp?: number; byte_offset: number }>; partial?: boolean };
    if (!Array.isArray(data?.keyframes)) return { keyframes: [], partial: true };
    const keyframes = data.keyframes
      .map(kf => {
        const timestamp = Number(kf.timestamp_s ?? kf.timestamp ?? 0);
        const byteOffset = Number(kf.byte_offset);
        return { timestamp, byteOffset };
      })
      .filter(kf => Number.isFinite(kf.timestamp) && Number.isFinite(kf.byteOffset))
      .sort((a, b) => a.timestamp - b.timestamp);
    return { keyframes, partial: data.partial ?? false };
  } catch (e) {
    return { keyframes: [], partial: true };
  }
}

/** Ask the backend for the exact byte offset of the nearest keyframe at or before `time`. */
async function fetchMpegtsKeyframeAt(
  baseUrl: string,
  folderId: string,
  messageId: string,
  token: string,
  time: number,
  duration: number,
  abortSignal?: AbortSignal
): Promise<{ timestamp: number; byteOffset: number; fallback: boolean } | null> {
  try {
    const url = `${baseUrl}/fmp4/keyframe-at/${folderId}/${messageId}?time=${encodeURIComponent(time.toFixed(3))}&duration=${encodeURIComponent(duration.toFixed(3))}&token=${encodeURIComponent(token)}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: abortSignal });
    if (!response.ok) return null;
    const data = await response.json() as { timestamp_s?: number; byte_offset?: number; fallback?: boolean };
    const timestamp = Number(data.timestamp_s ?? 0);
    const byteOffset = Number(data.byte_offset ?? 0);
    if (!Number.isFinite(timestamp) || !Number.isFinite(byteOffset) || byteOffset < 0) return null;
    return { timestamp, byteOffset, fallback: !!data.fallback };
  } catch (e: any) {
    if (e?.name === 'AbortError') return null; // expected on rapid seek
    return null;
  }
}

interface MSEState {
  mediaSource: MediaSource | null;
  videoSourceBuffer: SourceBufferWrapper | null;
  audioSourceBuffer: SourceBufferWrapper | null;
  mp4box: MP4BoxFile | null;
  fileLength: number;
  duration: number;
  bitrate: number;
  videoTracks: MP4BoxTrack[];
  audioTracks: MP4BoxTrack[];
  videoTrackId: number;
  audioTrackId: number;
  initialized: boolean;
  downloading: boolean;
  currentOffset: number;
  pendingSeek: number;
}

export function useMSEPlayer(streamUrl: string | null, file: TelegramFile | null, activeFolderId: number | null, isPublicChannel?: boolean) {
  // Public channels get larger buffers to reduce buffering on large 1080p MP4s.
  // Telegram download speed (~400KB/s) is below 1080p bitrate (~1MB/s), so
  // a bigger buffer builds a larger cushion during speed spikes.
  // Dynamic cold-start threshold is computed after format detection; this is
  // the initial fallback used until we know the format.
  const fallbackColdStartBytes = isPublicChannel ? alignChunkSize(20 * 1024 * 1024) : MIN_COLD_START_BUFFER_BYTES;
  const [minColdStartBytes, setMinColdStartBytes] = useState(fallbackColdStartBytes);
  const maxBufferAhead = isPublicChannel ? 120 : MAX_BUFFER_AHEAD_SECONDS;
  const maxBufferBytes = isPublicChannel ? 80 * 1024 * 1024 : MAX_BUFFER_BYTES;
  // Phase tracking for cold-start overlay — tells UI what is happening and why
  const [coldStartPhase, setColdStartPhase] = useState<ColdStartPhase>('none');
  // Detected format state — exposed to UI for format-aware overlay messaging
  const [detectedFormat, setDetectedFormat] = useState<string>('unknown');

  const [mseUrl, setMseUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useNative, setUseNative] = useState(false); // Fallback flag
  const [unsupportedCodec, setUnsupportedCodec] = useState<string | null>(null); // Codec neither MSE nor native supports
  const [prefetchedBytes, setPrefetchedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [isPrefetching, setIsPrefetching] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(false); // Ref so seekTo can check without React state delay
  const [isComplete, setIsComplete] = useState(false);
  // Thumbnail pipeline data ready — set after onReady fires and all refs are populated
  const [thumbnailDataReady, setThumbnailDataReady] = useState(false);
  // Tracks when moovBufferRef.current is set — needed for pipeline re-trigger
  // when moov is set AFTER thumbnailDataReady (faststarted files with moov beyond first chunk)
  const [moovBufferReady, setMoovBufferReady] = useState(false);
  // State that becomes true when the transmuxer initializes — used as a
  // dependency trigger so effects in useThumbnailExtractor re-run after
  // transmuxer init (refs don't cause re-renders, but state does).
  const [isTransmuxerActive, setIsTransmuxerActive] = useState(false);
  // State that becomes true when the keyframe index finishes building —
  // triggers a re-render so thumbnail pipeline can pick up the index.
  const [keyframeIndexReady, setKeyframeIndexReady] = useState(false);
  // Cold-start overlay state: true while the first chunk is being pulled into
  // the shadow cache. Playback now waits until the first 5MB are cached (or a
  // timeout fires), and the overlay is hidden exactly when playback begins.
  const [isColdStartBuffering, setIsColdStartBuffering] = useState(false);
  const [coldStartProgress, setColdStartProgress] = useState<{ bytes: number; targetBytes: number }>({
    bytes: 0,
    targetBytes: minColdStartBytes,
  });
  // Deferred promise resolved when the first 5MB is in the shadow cache (or timeout).
  const coldStartDeferredRef = useRef<{ resolve: () => void; promise: Promise<void> } | null>(null);
  const isCompleteRef = useRef(false);
  // Once the download loop reaches fileLength, the backend has all data cached.
  // This ref never resets — even if a backward seek resets isComplete=false,
  // the near-end guard still works because hasEverCompleted stays true.
  const hasEverCompletedRef = useRef(false);
  // Downloaded byte-range → time-range for green buffer bar
  const [downloadedTimeRanges, setDownloadedTimeRanges] = useState<[number, number][]>([]);
  // Ground-truth time ranges accumulated directly from transmuxer segment
  // timestamps (VBR MKV seek path). Bypasses the byte→time round-trip that
  // mislocates the green bar for VBR content — see trackTransmuxerTimeRange.
  const downloadedTimeRangesRef = useRef<[number, number][]>([]);

  const downloadLoopRef = useRef<((url: string) => void) | null>(null);
  // MP4 green-bar-to-EOF prebuffer reporter — assigned once downloadLoop is defined.
  const startMp4ProactiveReporterRef = useRef<(() => void) | null>(null);
  // True when the downloadLoop's most recent /stream chunk was served from disk
  // cache (X-Cache: HIT) rather than fetched from Telegram. When PROACTIVE has
  // raced ahead, refills topping the MSE buffer are disk HITs — they are NOT
  // competing for the Telegram rate limiter, so PROACTIVE must NOT yield for them
  // (that yield is what made the green bar pulse/stall). Only a genuine MISS
  // (cold seek into unwarmed data) should make the reporter flag the player as
  // actively downloading. Starts true: an idle loop isn't pulling from Telegram.
  const lastDownloadWasCacheHitRef = useRef(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loopGeneration = useRef(0); // Prevents stale loops from running after seek
  const chunksAfterSeek = useRef(0); // For progressive chunk sizing
  // Seek debouncing: for unbuffered positions, delay seek execution by SEEK_DEBOUNCE_MS
  // so rapid clicks/arrow-key skips only trigger the LAST position, reducing wasteful
  // overlapping downloads on unbuffered parts
  const seekDebounceTimerRef = useRef<number | null>(null);
  const mpegtsUnbufferedSeekGenerationRef = useRef<number>(0);
  // Per-effect generation counter — every useEffect run bumps this. Async
  // callbacks captured by an effect run compare their captured generation
  // against the live value to detect that a newer effect run has started
  // (e.g. user switched files mid-init). This is more reliable than
  // cancelledRef alone, which gets reset to false at line 1017 every time
  // the effect re-runs — defeating cleanup-based cancellation under React
  // StrictMode and rapid file switches.
  const effectGenerationRef = useRef<number>(0);
  // Authoritative current stream URL for the *latest* effect run. Async
  // callbacks must use this ref (not a closed-over `url` argument) when
  // they need to build a URL for the file the user is currently watching
  // — e.g. the remux fallback that previously built `/remux/5` for msg 2
  // because it parsed a stale closure-captured URL from a prior effect run.
  const streamUrlRef = useRef<string | null>(null);
  // Timer for the delayed background keyframe fetch — cancelled on new seek
  // so rapid seeks don't spawn multiple concurrent fetchMpegtsKeyframeAt calls.
  const bgKeyframeTimerRef = useRef<number | null>(null);
  // Debounce timer for rapid mpegts.js unbuffered seeks (scrubbing). Only the
  // last seek within the debounce window executes. If a seek is already in
  // progress when the debounce fires, the target is stored in pendingSeekTargetRef
  // and executed after the in-progress seek completes.
  const mpegtsSeekDebounceRef = useRef<number | null>(null);
  const mpegtsLastExecutedSeekRef = useRef<number>(-1); // dedup: last seekTo target time
  const pendingSeekTargetRef = useRef<{ time: number; dur: number } | null>(null);
  // Max depth for recursive pending-seek chain. Each seek can queue 1 pending
  // seek in its finally block. Without a limit, continuous scrubbing creates
  // unbounded recursion accumulating orphaned timers. 3 is sufficient — the
  // debounce coalesces rapid scrubbing, so at most 1 pending per 400ms.
  const pendingSeekDepthRef = useRef<number>(0);
  // AbortController for the background keyframe fetch — aborted on new seek
  // so the old HTTP request doesn't hold the backend semaphore.
  const bgKeyframeAbortRef = useRef<AbortController | null>(null);
  const SEEK_DEBOUNCE_MS = 500; // MP4/MKV — 500ms debounce for unbuffered seeks
  const SEEK_DEBOUNCE_MS_TS = 2000; // DEPRECATED: Only used by mux.js fallback. The fMP4 pipeline uses SEEK_DEBOUNCE_MS (500ms). // TS format — longer debounce because getKeyPacket is slow (prevent concurrent seeks during drag)
  // Track when the last unbuffered seek was actually executed (instant or debounce expired).
  // The FIRST seek is instant; subsequent seeks within SEEK_DEBOUNCE_MS are debounced.
  const lastSeekTimeRef = useRef<number>(0);
  // Whether a transmuxer seek (seekTo + resetForSeek) is currently in progress.
  // Prevents starting a new seek while the previous one is still running getKeyPacket
  // (8-18s for TS). Without this, the debounce resets when the seek STARTS, so
  // subsequent seeks during a long-running getKeyPacket pass the debounce check
  // and start concurrently — wasting bandwidth and coordinator slots.
  const transmuxerSeekInProgressRef = useRef(false); // DEPRECATED: Only used by mux.js fallback seeking. The fMP4 pipeline uses keyframe index.
  // Monotonic generation for MKV transmuxer USER seeks. Bumped at the start of
  // every executeTransmuxerSeek; the async completion handler captures its value
  // and bails if a newer seek has since been requested — so a slow (5-8s cold)
  // stale seek can't hijack video.currentTime / startStreamingChain / the refill
  // and plant playback on a PREVIOUS seek's position (trace-22 "backward seek
  // goes to previous point"). Distinct from the transmuxer's internal
  // seekGeneration (which guards packet callbacks, not this frontend commit).
  const transmuxerSeekGenRef = useRef(0);
  // PROBE (seek-to-play): wall-clock (performance.now) captured when an unbuffered
  // transmuxer seek is ISSUED, plus its target time. The video's 'seeked' event
  // (fires after the new currentTime is decodable and playback can resume) reads
  // it to log the TRUE click→first-frame window — which spans reset + getKeyPacket
  // + transmux iteration + append + decode, not just the transmux 'total=' number.
  const seekToPlayStartRef = useRef<number>(0);
  const seekToPlayTargetRef = useRef<number>(-1);
  // Downloaded byte ranges — merged and converted to time for green buffer bar
  const downloadedRangesRef = useRef<[number, number][]>([]);
  // Transmuxer for TS/MKV format playback (null when not active)
  const transmuxerInitInProgressRef = useRef(false);
  const transmuxerRef = useRef<MediabunnyTransmuxer | MuxJsTsTransmuxer | null>(null);
  const mpegtsPlayerRef = useRef<any>(null); // mpegts.js player instance for TS files
  const shadowCacheRef = useRef<StreamShadowCache | null>(null); // JS-side byte cache for instant seeks
  const byteTimeSamplesRef = useRef<Array<ByteTimeSample>>([]); // legacy fallback for findByteForTime consumers
  const tsKeyframeIndexRef = useRef<TSKeyframeEntry[]>([]); // authoritative backend keyframe index for TS resume/seek

  const suppressLoadingSpinnerRef = useRef(false); // suppress spinner for cache-hit seeks
  const quotaGuardIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null); // 100ms quota guard
  const mpegtsFailedRef = useRef(false);     // Set true if mpegts.js fails, skip retry
  const mpegtsDurationRef = useRef<number>(0); // Duration from metadata for mpegts.js
  const proactivePrebufferMsgIdRef = useRef<number>(0); // msg_id being proactively prebuffered
  const proactiveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null); // 10s position reporting interval
  const independentPrebufferRef = useRef<{
    abortController: AbortController | null;
    active: boolean;
    startByte: number;
    downloadedBytes: number;
    lastCacheFullTime: number;  // timestamp when prebuffer last stopped due to cache full — cooldown
  }>({ abortController: null, active: false, startByte: 0, downloadedBytes: 0, lastCacheFullTime: 0 });
  // Refs for cleanup — store handler function references so effect cleanup
  // can removeEventListener even though the functions are defined later in the effect body
  const quotaGuardHandlerRef = useRef<(() => void) | null>(null);
  const trimShadowCacheHandlerRef = useRef<(() => void) | null>(null);
  // MSE initialization timeout ref — stored so we can clear it when init
  // succeeds (prevents the timeout from triggering fallback after a slow
  // but successful transmuxer init). For TS/MKV files, transmuxer init
  // can take 20+ seconds (downloading + parsing), so the timeout checks
  // transmuxerInitInProgressRef and extends itself if still initializing.
  const initTimeoutRef = useRef<number | null>(null);
  // Tracks the currently active blob URL so the effect cleanup can revoke the
  // CORRECT URL even when the TS fallback path creates a fresh MediaSource.
  // Without this, the cleanup closure revokes the original URL and the fresh
  // one leaks, or (worse) a stale URL is used after a MediaSource swap.
  const blobUrlRef = useRef<string | null>(null);
  // Seek offset for transmuxer progress tracking: 0 during initial playback,
  // seekTime after a seek. Transmuxer timestamps are relative (start from 0)
  // after trim, so we add this offset to get the absolute file position.
  const seekOffsetRef = useRef(0);
  // When true, onInitSegment/onMediaSegment buffer data instead of appending.
  // Used during transmuxer seek — segments must be buffered until
  // setTimestampOffset() is called (which clears the SB queue).
  const bufferingForSeekRef = useRef(false);
  const seekBufferRef = useRef<Array<{ type: 'init' | 'media'; data: ArrayBuffer; timestamp?: number; trackType?: 'video' | 'audio' | 'combined' }>>([]);
  // Burst buffer: accumulate transmuxed TS segments in JS memory instead of
  // appending to SourceBuffer during active playback. Chrome's appendBuffer
  // takes 10-24s per segment during active playback (decode pipeline blocks
  // SourceBuffer operations). When the video is paused/stalled, appends are
  // instant (0-1ms). The burst drain loop pauses the video briefly, appends
  // all accumulated segments, then resumes playback.
  const burstBufferRef = useRef<Array<{ data: ArrayBuffer; timestamp: number }>>([]); // DEPRECATED: Only used by mux.js fallback. The fMP4 pipeline appends segments directly.
  const drainInProgressRef = useRef(false); // DEPRECATED: Only used by mux.js fallback burst/drain loop.
  const drainTimerRef = useRef<number | null>(null); // DEPRECATED: Only used by mux.js fallback burst/drain loop.
  // Refill mechanism: after a limited seek (30s of data), monitor the buffer
  // and trigger refill seeks when buffer ahead drops below threshold.
  const refillTimerRef = useRef<number | null>(null);
  const refillInProgressRef = useRef(false);
  // Streaming chain generation — incremented when chain is stopped/started
  // so ongoing async refills can bail out if superseded by a new seek.
  const streamingChainGenRef = useRef(0);
  // MKV disk-cache warmer (mirrors MP4's downloadLoop for the GREEN BAR only):
  // a sequential 0→EOF Range walk over /stream that warms the SAME disk cache
  // mediabunny reads from, so the prebuffer bar fills contiguously to EOF.
  // Generation ref lets an in-flight warmer bail when a new file/teardown starts.
  const mkvWarmerGenRef = useRef(0);
  const mkvWarmerActiveRef = useRef(false);
  // Tracks the keyframe timestamp of the last refill seekTo. When a refill
  // finds the same keyframe as the previous refill (no new data progress),
  // it means we've reached EOF — the chain should stop and call endOfStream.
  const lastRefillKeyframeRef = useRef<number | null>(null);
  // Counter for consecutive noProgress detections. Requires 2+ consecutive
  // same-keyframe refills before declaring EOF — prevents cutting off the
  // last few seconds when a large keyframe interval near EOF causes the
  // refill position to map back to the same keyframe (e.g., last keyframe
  // at 2066.66s but duration is 2073.2s — one noProgress is normal, two
  // means we're truly stuck at the last keyframe).
  const consecutiveNoProgressRef = useRef(0);
  // Detected file format (stored for MSEGetters — thumbnail pipeline needs it)
  const formatRef = useRef<DetectedFormat>('unknown');
  // Cached init segments (codec config) — re-appended after each SourceBuffer clear
  const initSegmentsRef = useRef<Array<{ id: number; buffer: ArrayBuffer }>>([]);
  // Cached moov buffer + fileStart for thumbnail mini-MSE pipeline
  const moovBufferRef = useRef<{ buffer: ArrayBuffer; fileStart: number } | null>(null);
  // Cached first chunk for thumbnail mini-MSE pipeline (3-step append)
  const firstChunkRef = useRef<ArrayBuffer | null>(null);
  // Cached video track info for thumbnail mini-MSE pipeline
  const videoTrackInfoRef = useRef<{ trackId: number; codec: string } | null>(null);
  // Cached MP4Box class constructor for thumbnail mini-MSE pipeline
  const mp4BoxClassRef = useRef<any>(null);
  // Audio data byte range that was prefetched in parallel. Used by the
  // download loop to skip already-fetched audio data and avoid double-fetching.
  const audioPrefetchedRangeRef = useRef<[number, number] | null>(null);
  const state = useRef<MSEState>({
    mediaSource: null,
    videoSourceBuffer: null,
    audioSourceBuffer: null,
    mp4box: null,
    fileLength: 0,
    duration: 0,
    bitrate: 1000000,
    videoTracks: [],
    audioTracks: [],
    videoTrackId: -1,
    audioTrackId: -1,
    initialized: false,
    downloading: false,
    currentOffset: 0,
    pendingSeek: -1,
  });

  const lastThrottleRef = useRef(0); // For throttling state updates
  const prevUrlRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  // When true, log the first trackDownloadedRange call after a seek reset
  const justSeekedRef = useRef(false);

  // Byte-to-time lookup table for accurate VBR conversion.
  // Built from mp4box.seek() calibration points during initialization.
  // Each entry is [byteOffset, timeSeconds], sorted by byteOffset.
  const byteToTimeTableRef = useRef<[number, number][]>([]);

  /** Parse streamUrl to extract base_url, folder_id, message_id, and token for fMP4 endpoints */
  const parseStreamUrl = useCallback((url: string): { baseUrl: string; folderId: string; messageId: string; token: string } | null => {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/'); // ['', 'stream', folderId, messageId]
      if (pathParts.length < 4 || pathParts[1] !== 'stream') return null;
      return {
        baseUrl: `${urlObj.protocol}//${urlObj.host}`,
        folderId: pathParts[2],
        messageId: pathParts[3],
        token: urlObj.searchParams.get('token') || '',
      };
    } catch {
      return null;
    }
  }, []);

  /** Fetch the backend's keyframe index for this TS stream and store it as the
   *  authoritative byte-time map for resume / seek / cache trim. */
  const refreshTsKeyframeIndex = useCallback(async (): Promise<boolean> => {
    if (!streamUrl) return false;
    const parsed = parseStreamUrl(streamUrl);
    if (!parsed) return false;
    const { keyframes, partial } = await fetchMpegtsKeyframeIndex(parsed.baseUrl, parsed.folderId, parsed.messageId, parsed.token);
    if (keyframes.length > 0) {
      tsKeyframeIndexRef.current = keyframes;
      // Keep the legacy sample array in sync so findByteForTime consumers still work.
      byteTimeSamplesRef.current = keyframes.map(kf => ({ time: kf.timestamp, byte: kf.byteOffset }));
      // ALSO populate byteToTimeTableRef from backend keyframes so the green bar
      // renders at accurate VBR positions. Without this, byteToTime falls back
      // to linear mapping (wrong for VBR video).
      byteToTimeTableRef.current = keyframes
        .map(kf => [kf.byteOffset, kf.timestamp] as [number, number])
        .sort((a, b) => a[0] - b[0]);
    }
    // Return true when index is complete (not partial).
        // For non-TS files (MP4), the backend returns partial:false + empty keyframes.
        // That means "index is complete, file is not TS" — stop polling.
        // For TS files, partial:false + keyframes.length>0 means "full index ready".
        return !partial;
  }, [parseStreamUrl, streamUrl]);

  // Ref to track whether the TS→fMP4 backend pipeline is active (not mux.js transmuxer)
  const fmp4PipelineActiveRef = useRef(false);
  // Remux URL for TS files — when set, native <video> uses this instead of raw /stream/
  const remuxUrlRef = useRef<string | null>(null);
  const mpegtsVideoOnlyRef = useRef(false);
  // Seek strategy gate. When true, the source is served via /remux (ffmpeg
  // transcode → MPEG-TS), so its raw /stream/ bytes are NOT TS-parseable
  // (HEVC MKV = Matroska container). Byte-seeking /stream/ feeds Matroska to
  // mpegts.js's TS demuxer → `sync_byte != 0x47` flood, no video. For these
  // sources the seek must instead recreate the player from /remux?ss=<time>
  // and let ffmpeg do the (frame-accurate) seek. Native .ts / timed_id3 whose
  // /stream/ IS real MPEG-TS keep byte-seeking (this stays false for them).
  const needsRemuxSeekRef = useRef(false);
  // Base remux URL (no ss) used to build seek URLs; set alongside needsRemuxSeek.
  const remuxSeekBaseUrlRef = useRef<string | null>(null);
  // TRUE only when the underlying /stream bytes are real MPEG-TS (timed_id3):
  // gates BYTE-FORWARD (start_byte) remux seeks. MKV/MP4 sources leave this
  // false and always seek via ffmpeg -ss (mid-file Matroska/ISOBMFF bytes fed
  // to ffmpeg stdin die with "Invalid data found" — execution-proven).
  const remuxSourceIsTsRef = useRef(false);
  // Set synchronously when onMP4BoxReady reroutes an MP4-HEVC file to /remux.
  // The MP4 init callers (fetchMoovFromTail / forward scan / faststart path)
  // check `state.current.initialized` after appendBuffer and fall back to
  // NATIVE when it's false — this flag tells them the pipeline was handed to
  // mpegts.js instead, so they must not touch anything.
  const reroutedToRemuxRef = useRef(false);
  const mpegtsRecreationGenRef = useRef(0);
  // Ref to store fMP4 config for thumbnail pipeline — set during initTsFmp4Pipeline
  const fmp4ConfigRef = useRef<{
    baseUrl: string; // e.g. "http://host/fmp4"
    folderId: string;
    messageId: string;
    queryParams: string; // e.g. "token=abc"
    mimeType: string; // e.g. 'video/mp4; codecs="avc1.64001f,mp4a.40.2"'
    duration: number;
    fileSize: number;
  } | null>(null);
  // Server-side hover thumbnail config for the MP4-HEVC→/remux reroute tier.
  // When set, useThumbnailExtractor fetches JPEGs from the backend /thumb
  // endpoint (ffmpeg single-frame grab) instead of decoding client-side —
  // stock WebView2 has no HEVC decode (same reason the reroute exists).
  const remuxThumbConfigRef = useRef<{
    baseUrl: string;
    folderId: string;
    messageId: string;
    token: string;
    duration: number;
  } | null>(null);
  // Current byte offset for the fMP4 download loop — stored as a ref so the
  // seek handler can update it and restart the loop from the new position.
  const fmp4CurrentByteOffsetRef = useRef(0);
  // Current playback time for the fMP4 download loop — used for time-based
  // sequential playback (replaces byte_offset for smoother gap-free segments).
  const fmp4CurrentTimeRef = useRef(0);
  // Expected start time for the next segment in the SourceBuffer timeline.
  // Used with timestampOffset to force contiguous placement (eliminates gaps).
  const fmp4ExpectedStartTimeRef = useRef(0);
  /** Convert a byte position to a time position using the VBR lookup table.
   *  Falls back to linear formula if table is empty. */
  const byteToTime = useCallback((bytePos: number): number => {
    const table = byteToTimeTableRef.current;
    if (table.length === 0 || state.current.fileLength <= 0) {
      return (bytePos / state.current.fileLength) * state.current.duration;
    }
    // Binary search for the two nearest calibration points
    let lo = 0, hi = table.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (table[mid][0] <= bytePos) lo = mid;
      else hi = mid;
    }
    const [byteLo, timeLo] = table[lo];
    const [byteHi, timeHi] = table[hi];
    if (byteHi === byteLo) return timeLo;
    return timeLo + (timeHi - timeLo) * (bytePos - byteLo) / (byteHi - byteLo);
  }, []);

  /** Record a real (byteOffset, time) calibration anchor from a transmuxer seek
   *  and keep byteToTimeTableRef sorted + deduped. This replaces the linear VBR
   *  estimate with ground-truth anchors — same idea as the TS keyframe byte-index
   *  (byteOffsetAtOrBeforeTime), but sourced from mediabunny's own seek reads so
   *  the green prebuffer bar lands at the correct spot for VBR MKV. */
  const recordByteTimeAnchor = useCallback((byteOffset: number, time: number) => {
    if (!Number.isFinite(byteOffset) || byteOffset < 0 || !Number.isFinite(time) || time < 0) return;
    const table = byteToTimeTableRef.current;
    // Skip if an anchor at (nearly) this byte position already exists.
    if (table.some(([b]) => Math.abs(b - byteOffset) < 65536)) return;
    // MONOTONICITY GUARD: byteToTime interpolates assuming the table is strictly
    // increasing in BOTH byte and time (larger byte ⇒ later time). A bad anchor
    // (e.g. a stray Cues/tail read paired with a mid-file time) would violate
    // this, producing wrong or zero/negative-width ranges → the green bar jumps
    // far away or vanishes. Reject any anchor that breaks monotonicity with its
    // would-be neighbours instead of corrupting the whole mapping.
    let lo = 0, hi = table.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (table[m][0] < byteOffset) lo = m + 1; else hi = m; }
    const prev = table[lo - 1]; // largest byte < byteOffset
    const next = table[lo];     // smallest byte > byteOffset
    if (prev && time <= prev[1]) return; // time must exceed earlier-byte anchor
    if (next && time >= next[1]) return; // and precede later-byte anchor
    table.splice(lo, 0, [byteOffset, time]);
  }, []);

  // (Range reporting to the backend was removed: the backend command
  // cmd_report_cached_ranges no longer exists — the Rust server records
  // cached ranges itself at every download site, so the old debounced
  // reportRangesToBackend/flushRangeReport IPC was rejected on every call.)

  // Track downloaded byte ranges for the green buffer bar.
  // Converts byte ranges to time ranges using the duration/fileLength ratio.
  const trackDownloadedRange = useCallback((byteStart: number, byteEnd: number) => {
    if (state.current.fileLength <= 0 || state.current.duration <= 0) return;
    downloadedRangesRef.current.push([byteStart, byteEnd]);
    const merged = mergeByteRanges(downloadedRangesRef.current);
    downloadedRangesRef.current = merged;
    // Convert byte ranges → time ranges for progress bar rendering
    const timeRanges: [number, number][] = merged.map(([bs, be]) => {
      const ts = byteToTime(bs);
 const te = byteToTime(be);
      return [ts, te];
    });
    // Don't update downloadedTimeRanges during seek/VBR correction — the initial
    // /stream download at the linear estimate shows briefly, then VBR correction
    // resets the shadow cache → the green bar disappears → confusing flash.
    if ((window as any).__nobuf_userSeekInProgress !== true) {
      setDownloadedTimeRanges(timeRanges);
    }
    // Log first range after a seek reset for debugging
    if (justSeekedRef.current) {
      justSeekedRef.current = false;
      // const [ts, te] = timeRanges[timeRanges.length - 1];
      // console.log(`[BUFFER-BAR] First range after seek: bytes ${byteStart}-${byteEnd} → time ${ts.toFixed(1)}-${te.toFixed(1)}s`);
    }
  }, []);

  // Clear downloaded ranges (on seek / cleanup)
  const clearDownloadedRanges = useCallback(() => {
    downloadedRangesRef.current = [];
    downloadedTimeRangesRef.current = [];
    // Don't clear the visual bar during seek — it causes a flash.
    // The bar updates with new data when the seek completes.
    // Only clear when NOT in a seek (e.g. player cleanup, file change).
    if ((window as any).__nobuf_userSeekInProgress !== true) {
      setDownloadedTimeRanges([]);
    }
  }, []);

  // Initialize MSE when streamUrl changes
  useEffect(() => {
    if (!streamUrl) return;

    // Cleanup previous
    if (prevUrlRef.current && prevUrlRef.current !== streamUrl) {
      cleanup();
    }
    prevUrlRef.current = streamUrl;
    cancelledRef.current = false;
    transmuxerInitInProgressRef.current = false;
    // Bump effect-generation: any async callback captured by a prior effect
    // run will now see its captured generation != current, and bail out.
    // Also update streamUrlRef so any callback that needs the *current*
    // URL (not the one captured at the start of the prior effect) can read it.
    effectGenerationRef.current += 1;
    streamUrlRef.current = streamUrl;
    const currentGeneration = effectGenerationRef.current;

    // Swallow the known-benign promise rejections that mediabunny's source
    // worker (source.js _runWorker) surfaces as "Uncaught (in promise)" when a
    // seek supersedes an in-flight read. Our TauriStreamSource intentionally
    // throws on abort/dispose so mediabunny abandons the stale read — correct
    // behaviour, but mediabunny doesn't catch it, so it hits window as an
    // unhandled rejection. We filter ONLY these exact benign messages (and the
    // native AbortError) so real errors still surface normally.
    const onUnhandledRejection = (ev: PromiseRejectionEvent) => {
      const r = ev.reason;
      const msg = typeof r === 'string' ? r : r?.message ?? '';
      if (
        r?.name === 'AbortError' ||
        msg.includes('[TauriStreamSource] read aborted') ||
        msg.includes('[TauriStreamSource] disposed during')
      ) {
        ev.preventDefault(); // benign: seek superseded / source disposed
      }
    };
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    setUseNative(false);
    // Clear stale PTS duration from a previous file so it doesn't clamp the
    // duration floor for the next file (e.g., switching from a 5471s file to
    // a 30-min file would otherwise show 5471s until the new fetch resolves).
    (window as any).__nobuf_ptsDuration = 0;
    (window as any).__nobuf_seekTargetTime = 0;
    setUnsupportedCodec(null);

    // Reset state
    state.current = {
      mediaSource: null,
      videoSourceBuffer: null,
      audioSourceBuffer: null,
      mp4box: null,
      fileLength: 0,
      duration: 0,
      bitrate: 1000000,
      videoTracks: [],
      audioTracks: [],
      videoTrackId: -1,
      audioTrackId: -1,
      initialized: false,
      downloading: false,
      currentOffset: 0,
      pendingSeek: -1,
    };
    initSegmentsRef.current = [];
    moovBufferRef.current = null;
    firstChunkRef.current = null;
    videoTrackInfoRef.current = null;
    mp4BoxClassRef.current = null;
    audioPrefetchedRangeRef.current = null;
    clearDownloadedRanges();
    setPrefetchedBytes(0);
    setTotalBytes(0);
    setIsPrefetching(false);
    setIsComplete(false);
    isCompleteRef.current = false;
    setThumbnailDataReady(false);
    setMoovBufferReady(false);
    setError(null);
    setMseUrl(null);

    // Try MSE first
    diagLog(`[MSE] Initializing MSE player for streamUrl=${streamUrl}, file=${file?.name}`);
    let blobUrl: string | null = null;
    try {
      const mediaSource = new MediaSource();
      blobUrl = URL.createObjectURL(mediaSource);
      // Keep ref in sync so cleanup revokes the currently active URL, even if
      // the TS fallback path swaps in a fresh MediaSource later.
      blobUrlRef.current = blobUrl;
      // Set blob URL immediately so video element loads it and triggers sourceopen
      setMseUrl(blobUrl);
      state.current.mediaSource = mediaSource;

      const onSourceOpen = () => {
        // Guard against stale firings from a prior effect run. Three checks:
        //   1. cancelledRef — covers same-effect cleanup
        //   2. effectGenerationRef !== captured — covers React StrictMode
        //      double-invoke and rapid file switches where cancelledRef gets
        //      reset to false at line ~1031 before the prior sourceopen fires
        //   3. state.current.mediaSource !== mediaSource — covers the case
        //      where the *same* effect run has swapped in a new MediaSource
        //      (e.g. TS fallback path creates a fresh one)
        if (cancelledRef.current) return;
        if (effectGenerationRef.current !== currentGeneration) {
          diagLog(`[MSE] sourceopen ignored — stale generation (captured=${currentGeneration}, current=${effectGenerationRef.current})`);
          return;
        }
        if (state.current.mediaSource !== mediaSource) {
          diagLog('[MSE] sourceopen ignored — MediaSource was swapped (stale instance)');
          return;
        }
        diagLog('[MSE] sourceopen event fired — starting format detection and player init');
        initMP4Box(streamUrl, mediaSource, blobUrl!);
      };

      mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true });

      // Timeout for MSE initialization. For MP4 files, 20s is enough to
      // fetch the moov atom. For TS/MKV files, transmuxer init can take
      // 20+ seconds (downloading + parsing), so the timeout checks
      // transmuxerInitInProgressRef and extends itself by 20s if the
      // transmuxer is still initializing, up to a maximum of 60s total.
      const MSE_INIT_TIMEOUT_MS = 20000;
      const MSE_INIT_MAX_TIMEOUT_MS = 120000;
      let timeoutElapsed = 0;
      const checkInitTimeout = () => {
        if (state.current.initialized || cancelledRef.current) {
          // Init succeeded or cancelled — no need for timeout
          initTimeoutRef.current = null;
          return;
        }
        timeoutElapsed += MSE_INIT_TIMEOUT_MS;
        if (transmuxerInitInProgressRef.current && timeoutElapsed < MSE_INIT_MAX_TIMEOUT_MS) {
          // Transmuxer still initializing — extend timeout instead of
          // triggering fallback (changing v.src closes MediaSource before
          // addSourceBuffer completes, causing InvalidStateError)
          console.log(`[MSE] Init timeout check: transmuxer still initializing (${timeoutElapsed / 1000}s elapsed) — extending timeout`);
          initTimeoutRef.current = window.setTimeout(checkInitTimeout, MSE_INIT_TIMEOUT_MS);
          return;
        }
        // Truly timed out — no transmuxer init in progress or max timeout reached
        console.error(`[MSE] Initialization timeout (${timeoutElapsed / 1000}s) — falling back to native playback`);
        setError('MSE initialization timeout');
        setUseNative(true);
        initTimeoutRef.current = null;
      };
      initTimeoutRef.current = window.setTimeout(checkInitTimeout, MSE_INIT_TIMEOUT_MS);
    } catch (e) {
      setError('MediaSource not supported');
      setUseNative(true);
    }

    return () => {
      cancelledRef.current = true;
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      // Clear MSE init timeout
      if (initTimeoutRef.current !== null) {
        clearTimeout(initTimeoutRef.current);
        initTimeoutRef.current = null;
      }
      // Clear seek debounce timer
      if (seekDebounceTimerRef.current !== null) {
        clearTimeout(seekDebounceTimerRef.current);
        seekDebounceTimerRef.current = null;
      }
      if (bgKeyframeTimerRef.current !== null) {
        clearTimeout(bgKeyframeTimerRef.current);
        bgKeyframeTimerRef.current = null;
      }
      if (mpegtsSeekDebounceRef.current !== null) {
        clearTimeout(mpegtsSeekDebounceRef.current);
        mpegtsSeekDebounceRef.current = null;
      }
      pendingSeekTargetRef.current = null;
      pendingSeekDepthRef.current = 0;
      if (bgKeyframeAbortRef.current) {
        bgKeyframeAbortRef.current.abort();
        bgKeyframeAbortRef.current = null;
      }
      // Invalidate all generation-guarded callbacks (checkPipeline timeouts,
      // alignInterval) so they stop firing after unmount. Also clear the
      // seek-in-progress flag so future seeks aren't blocked.
      mpegtsUnbufferedSeekGenerationRef.current++;
      (window as any).__nobuf_userSeekInProgress = false;
      (window as any).__nobuf_seekRequestedAt = 0;
      // Stop streaming chain
      stopStreamingChain();
      refillInProgressRef.current = false;
      transmuxerSeekInProgressRef.current = false;
      // Stop burst drain loop
      burstBufferRef.current = [];
      drainInProgressRef.current = false;
      if (drainTimerRef.current !== null) {
        clearInterval(drainTimerRef.current);
        drainTimerRef.current = null;
      }
      // ── React.StrictMode full cleanup ──
      // In dev, React double-invokes effects. The first mount's cleanup
      // must FULLY destroy the mpegts player, quota guard, and video
      // listeners — otherwise the second mount gets orphaned timers
      // operating on stale player references.
      // ── Quota guard interval ──
      if (quotaGuardIntervalRef.current) {
        clearInterval(quotaGuardIntervalRef.current);
        quotaGuardIntervalRef.current = null;
      }
      // ── Video event listeners (quota guard + shadow cache trim) ──
      const vid = videoRef.current;
      if (vid) {
        if (quotaGuardHandlerRef.current) {
          try { vid.removeEventListener('timeupdate', quotaGuardHandlerRef.current as EventListener); } catch (_) {}
        }
        if (trimShadowCacheHandlerRef.current) {
          try { vid.removeEventListener('timeupdate', trimShadowCacheHandlerRef.current as EventListener); } catch (_) {}
        }
      }
      // ── mpegts.js player ──
      if (mpegtsPlayerRef.current) {
        try {
          mpegtsPlayerRef.current.detachMediaElement();
          mpegtsPlayerRef.current.unload();
          mpegtsPlayerRef.current.destroy();
        } catch (_) {}
        mpegtsPlayerRef.current = null;
      }
      // ── Shadow cache cleanup ──
      shadowCacheRef.current = null;
      tsKeyframeIndexRef.current = [];
      byteTimeSamplesRef.current = [];
      // ── Independent prebuffer ──
      if (independentPrebufferRef.current.active && independentPrebufferRef.current.abortController) {
        independentPrebufferRef.current.abortController.abort();
        independentPrebufferRef.current.active = false;
        independentPrebufferRef.current.abortController = null;
      }
      // ── SourceBuffer wrappers ──
      state.current.videoSourceBuffer?.destroy();
      state.current.audioSourceBuffer?.destroy();
      state.current.videoSourceBuffer = null;
      state.current.audioSourceBuffer = null;
      // ── Transmuxer ──
      if (transmuxerRef.current) {
        transmuxerRef.current.dispose();
        transmuxerRef.current = null;
      }
      // ── State reset ──
      state.current.mp4box = null;
      state.current.initialized = false;
      fmp4PipelineActiveRef.current = false;
      fmp4CurrentByteOffsetRef.current = 0;
      fmp4CurrentTimeRef.current = 0;
      fmp4ExpectedStartTimeRef.current = 0;
      fmp4ConfigRef.current = null;
      remuxThumbConfigRef.current = null;
      setIsTransmuxerActive(false);
      clearDownloadedRanges();
      seekOffsetRef.current = 0;
      bufferingForSeekRef.current = false;
      seekBufferRef.current = [];
      // ── Clear persistent window flags ──
      // These survive React unmount/remount and can block future evictions
      // or resume paths if left stale from a previous component lifecycle.
      (window as any).__nobuf_bufferFullDetected = false;
      (window as any).__nobuf_removeInProgress = false;
      (window as any).__nobuf_evictionResumePending = false;
      (window as any).__nobuf_evictionResumeByte = 0;
      (window as any).__nobuf_nuclearRecoveryInProgress = false;
      (window as any).__nobuf_userSeekInProgress = false;
      (window as any).__nobuf_seekRequestedAt = 0;
      (window as any).__nobuf_mpegtsFatalAbort = false;
      // Stop proactive disk prebuffer for this file
      const _ppMsgId = proactivePrebufferMsgIdRef.current;
      if (_ppMsgId) {
        invoke('cmd_stop_proactive_prebuffer', { messageId: _ppMsgId }).catch(() => {});
        proactivePrebufferMsgIdRef.current = 0;
      }
      if (proactiveIntervalRef.current) {
        clearInterval(proactiveIntervalRef.current);
        proactiveIntervalRef.current = null;
      }
      // Stop the MKV disk warmer (bump generation → in-flight loop bails).
      mkvWarmerGenRef.current++;
      mkvWarmerActiveRef.current = false;
      // Revoke blob URL on cleanup (always the currently active one)
      const currentBlobUrl = blobUrlRef.current;
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
      blobUrlRef.current = null;
    };
  }, [streamUrl]);

  const cleanup = () => {
    abortRef.current?.abort();
    // Cancel independent prebuffer
    if (independentPrebufferRef.current.active && independentPrebufferRef.current.abortController) {
      independentPrebufferRef.current.abortController.abort();
      independentPrebufferRef.current.active = false;
      independentPrebufferRef.current.abortController = null;
    }
    if (seekDebounceTimerRef.current !== null) {
      clearTimeout(seekDebounceTimerRef.current);
      seekDebounceTimerRef.current = null;
    }
    state.current.videoSourceBuffer?.destroy();
    state.current.audioSourceBuffer?.destroy();
    state.current.videoSourceBuffer = null;
    state.current.audioSourceBuffer = null;
    if (transmuxerRef.current) {
      transmuxerRef.current.dispose();
      transmuxerRef.current = null;
    }
    // Cleanup mpegts.js player if active
    if (quotaGuardIntervalRef.current) {
      clearInterval(quotaGuardIntervalRef.current);
      quotaGuardIntervalRef.current = null;
    }
    if (mpegtsPlayerRef.current) {
      try {
        mpegtsPlayerRef.current.detachMediaElement();
        mpegtsPlayerRef.current.unload();
        mpegtsPlayerRef.current.destroy();
      } catch (_) {}
      mpegtsPlayerRef.current = null;
    }
    // Cleanup shadow cache
    if (shadowCacheRef.current) {
      shadowCacheRef.current = null;
    }
    tsKeyframeIndexRef.current = [];
    mpegtsVideoOnlyRef.current = false;
    needsRemuxSeekRef.current = false;
    remuxSeekBaseUrlRef.current = null;
    remuxSourceIsTsRef.current = false;
    reroutedToRemuxRef.current = false;
    mpegtsRecreationGenRef.current++; // invalidate any in-flight recreations
    byteTimeSamplesRef.current = [];
    seekOffsetRef.current = 0;
    bufferingForSeekRef.current = false;
    seekBufferRef.current = [];
    burstBufferRef.current = [];
    drainInProgressRef.current = false;
    if (drainTimerRef.current !== null) {
      clearInterval(drainTimerRef.current);
      drainTimerRef.current = null;
    }
    stopStreamingChain();
    refillInProgressRef.current = false;
    state.current.mp4box = null;
    state.current.initialized = false;
    fmp4PipelineActiveRef.current = false;
    fmp4CurrentByteOffsetRef.current = 0;
    fmp4CurrentTimeRef.current = 0;
    fmp4ExpectedStartTimeRef.current = 0;
    fmp4ConfigRef.current = null;
    remuxThumbConfigRef.current = null;
    setIsTransmuxerActive(false);
    clearDownloadedRanges();
    // ── Clear persistent window flags ──
    // These survive React unmount/remount and can block future evictions
    // or resume paths if left stale from a previous component lifecycle.
    (window as any).__nobuf_bufferFullDetected = false;
    (window as any).__nobuf_removeInProgress = false;
    (window as any).__nobuf_evictionResumePending = false;
    (window as any).__nobuf_evictionResumeByte = 0;
    (window as any).__nobuf_nuclearRecoveryInProgress = false;
    (window as any).__nobuf_userSeekInProgress = false;
    (window as any).__nobuf_seekRequestedAt = 0;
    (window as any).__nobuf_mpegtsFatalAbort = false;
    // Stop proactive disk prebuffer
    const _ppMsgId2 = proactivePrebufferMsgIdRef.current;
    if (_ppMsgId2) {
      invoke('cmd_stop_proactive_prebuffer', { messageId: _ppMsgId2 }).catch(() => {});
      proactivePrebufferMsgIdRef.current = 0;
    }
    if (proactiveIntervalRef.current) {
      clearInterval(proactiveIntervalRef.current);
      proactiveIntervalRef.current = null;
    }
    // Stop the MKV disk warmer (bump generation → in-flight loop bails).
    mkvWarmerGenRef.current++;
    mkvWarmerActiveRef.current = false;
  };

  /** Calculate how many seconds of video are buffered ahead of current playback.
   *  Used for backpressure — stop downloading when enough data is buffered ahead. */
  const getBufferedAheadSeconds = (): number => {
    const video = videoRef.current;
    if (!video) return 0;
    // CONTIGUOUS buffer ahead only. The previous implementation summed EVERY
    // range with end > currentTime, so a stale far-away island (e.g. leftover
    // data from a prior seek near EOF, thousands of seconds away) inflated the
    // measure. That made the download-loop backpressure gate believe the buffer
    // was full (>30s) and sleep forever, while the PROACTIVE reporter believed
    // the player was idle — a deadlock that stranded backward seeks after a
    // near-EOF seek (see SEEK-STRAND-CROSSVALIDATION.md). Only buffer reachable
    // from the playhead by continuous playback should count toward backpressure.
    const buffered = video.buffered;
    const ranges: SimpleTimeRange[] = [];
    for (let i = 0; i < buffered.length; i++) {
      ranges.push({ start: buffered.start(i), end: buffered.end(i) });
    }
    return contiguousBufferedAhead(ranges, video.currentTime);
  };

  /** True if `byterPos` falls inside a byte range we've already pulled to local
   *  disk (warmer + refills + stream reads all feed downloadedRangesRef, which is
   *  kept merged+sorted). Conservative: a byte that IS on disk but wasn't tracked
   *  here reads as false → we simply keep the tighter network cap, never wrong in
   *  the unsafe direction. Binary search over the merged ranges. */
  const isByteLocal = (bytePos: number): boolean => {
    const ranges = downloadedRangesRef.current;
    if (!Number.isFinite(bytePos) || ranges.length === 0) return false;
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [s, e] = ranges[mid];
      if (bytePos < s) hi = mid - 1;
      else if (bytePos > e) lo = mid + 1;
      else return true;
    }
    return false;
  };

  /** Dynamic backpressure cap. When the data just past the current buffer end is
   *  already on local disk (free append), allow the playback buffer to run far
   *  ahead (drains the prebuffer, as the user asked). Otherwise keep the tight
   *  network cap that prevents QuotaExceededError on huge uncached forward runs.
   *  Falls back to the network cap whenever we can't resolve the byte (no cue
   *  index, e.g. TS) — no assumption that unknown == local. */
  const getBufferAheadCap = (): number => {
    const video = videoRef.current;
    const transmuxer = transmuxerRef.current;
    if (!video || !transmuxer) return MAX_BUFFER_AHEAD_SECONDS;
    const bufEndTime = video.currentTime + getBufferedAheadSeconds();
    const byteAtEnd = (transmuxer as any).getByteOffsetForTime?.(bufEndTime) ?? -1;
    if (byteAtEnd < 0) return MAX_BUFFER_AHEAD_SECONDS; // can't resolve → safe cap
    if (!isByteLocal(byteAtEnd)) return MAX_BUFFER_AHEAD_SECONDS; // next data is remote
    // Local (free append): allow a larger window, but bound it by a byte ceiling
    // so a high-bitrate file can't push the SourceBuffer toward QuotaExceededError.
    // 62 MB ceiling (matches ~120s at this file's ~0.5MB/s; fewer seconds for a
    // higher-bitrate file). bitrate is bytes/sec; guard against 0/unknown.
    const LOCAL_BUFFER_BYTE_CEILING = 64 * 1024 * 1024;
    const bps = state.current.bitrate;
    if (!bps || bps <= 0) return MAX_BUFFER_AHEAD_LOCAL_SECONDS;
    const secondsForCeiling = LOCAL_BUFFER_BYTE_CEILING / bps;
    return Math.max(MAX_BUFFER_AHEAD_SECONDS, Math.min(MAX_BUFFER_AHEAD_LOCAL_SECONDS, secondsForCeiling));
  };

  /** Refill mechanism for transmuxer playback.
   *  After a limited seek, continuously stream data until buffer is sufficient.
   *  The streaming chain triggers the first refill immediately after the initial
   *  seek completes (no timer delay), then chains subsequent refills as needed
   *  until buffer ahead >= REFILL_THRESHOLD_SECONDS. */
  // immediately after the initial seek (no timer delay), then chains
  // subsequent refills as needed until buffer ahead >= threshold.
  const REFILL_THRESHOLD_SECONDS = 20;
  // 5s chunks: each refill produces ~17s of data (5+12 keyframe gap). Smaller
  // chunks were reinstated because 15s chunks (27s per refill) triggered
  // PIPELINE_ERROR_DECODE at ~51s — the larger iteration crossed something the
  // decoder couldn't handle. The stutter fix comes from INITIAL_SEEK_DURATION=30
  // (more runway), not from the chunk size. With 30s initial buffer, even 5s
  // chunks don't stutter because the cold iteration (5-14s) leaves 16-25s.
  const REFILL_CHUNK_DURATION = 5;
  // Initial user seek produces enough data for smooth playback start.
  // 25s provides sufficient runway for the first cold refill iteration
  // (which takes 10-14s downloading new clusters from Telegram at ~1.14MB/s).
  // 25 - 14 = 11s remaining → no stutter. Must stay BELOW MAX_BUFFER_AHEAD_SECONDS
  // (30): if initial buffer == cap, any playback advancement triggers an immediate
  // refill whose keyframe is ~7s before the buffer end, creating a 7s overlap
  // between initial prime and first refill → duplicate frames → PIPELINE_ERROR_DECODE
  // at ~51s. With 25s initial, overlap is ~2s (same as original 15s) → no corruption.
  const INITIAL_SEEK_DURATION = 25;
  // Time-to-first-frame optimization for USER seeks to unbuffered positions.
  // The initial seek fill above (25s) has to fully download from Telegram before
  // playback starts — on a cold seek that's the ~10s "iteration" stall the user
  // feels. Playback only needs the FIRST GOP to start; the refill chain (which
  // fires immediately and abuts on keyframe boundaries — see Fix #1) extends to
  // the full runway in the background. So seed just a small window (~2 GOPs) to
  // start playing fast, then let refills catch up. Safe because abutting refills
  // no longer overlap (the old PIPELINE_ERROR_DECODE risk that justified 25s is
  // gone). Kept ≥ one refill chunk so the first refill has runway to iterate.
  const SEEK_START_DURATION = 8;
  // Maximum maxDuration for refill seeks. Capped to prevent excessive
  // iteration when video plays far past seekOffsetRef.current. When
  // (video.currentTime - seekOffset) + ahead + REFILL_CHUNK_DURATION
  // exceeds this cap, the Output only produces data up to seekOffset + cap,
  // which may be insufficient — but the chain will immediately trigger
  // another refill. This prevents single refill iterations from taking
  // 10+ seconds on cold data far from the cached region.
  const REFILL_MAX_DURATION_CAP = 25;

  /** Start the streaming chain: triggers first refill immediately, then chains
   *  subsequent refills until buffer ahead >= REFILL_THRESHOLD_SECONDS.
   *  Replaces the old refill timer (1s interval polling). */
  const startStreamingChain = () => {
    stopStreamingChain(); // Clear any existing chain
    streamingChainGenRef.current++;
    // Reset EOF tracking — new chain starts fresh
    lastRefillKeyframeRef.current = null;
    consecutiveNoProgressRef.current = 0;
    console.log('[MSE] Starting streaming chain for transmuxer playback');
    // Trigger first refill immediately — no timer delay
    executeStreamingRefill();
  };

  const stopStreamingChain = () => {
    streamingChainGenRef.current++;
    refillTimerRef.current = null;
    refillInProgressRef.current = false;
    // Abort ongoing refill iteration in MediabunnyTransmuxer
    transmuxerRef.current?.abortSeek();
    console.log('[MSE] Streaming chain stopped', new Error('STACK').stack?.split('\n').slice(1, 5).join('\n'));
  };

  /** Execute a streaming refill — continuation or discontinuity mode.
   *  Continuation: keyframeTimestamp matches seekOffsetRef.current → skip init segment
   *    and setTimestampOffset, append media segments directly. Faster because:
   *    - No init segment production (Output callbacks skip ftyp+moov)
   *    - No setTimestampOffset call (SourceBuffer queue stays intact)
   *    - No SourceBuffer abort/reset (data flows directly)
   *  Discontinuity: keyframeTimestamp differs → full approach (init segment +
   *    setTimestampOffset + flush all buffered segments).
   *
   *  After each refill completes, checks if buffer ahead is still below threshold
   *  and chains another refill immediately (no timer delay). This creates a
   *  continuous streaming loop until buffer is sufficient. */
  const executeStreamingRefill = async () => {
    if (refillInProgressRef.current) return;
    refillInProgressRef.current = true;
    const chainGeneration = streamingChainGenRef.current;

    try {
      const video = videoRef.current;
      const transmuxer = transmuxerRef.current;
      const sb = state.current.videoSourceBuffer;
      if (!video || !transmuxer || !sb || video.ended || sb.hasFatalError) {
        refillInProgressRef.current = false;
        return;
      }

      // Backpressure guard: if we already have >= the dynamic cap buffered
      // ahead of the playhead, do NOT fetch more. The finally block reschedules
      // a re-check. Without this guard, a frozen playhead (paused, or stalled on
      // a cold seek) makes `ahead` grow unbounded every cycle (30s → 271s),
      // eventually throwing QuotaExceededError and killing playback. The
      // reschedule-side cap alone is decorative — it still calls this function,
      // which fetched forward regardless. This is the real cap.
      // Dynamic: cap is larger when the next data is already on local disk (free
      // append drains the prebuffer) and tight when it must come from Telegram.
      if (getBufferedAheadSeconds() >= getBufferAheadCap()) {
        refillInProgressRef.current = false;
        return;
      }

      // Always seek from buffer end (discontinuity mode).
      // Previous approach (continuation from seekOffsetRef.current) re-iterated
      // the same data range, causing the overlap filter to skip more data each
      // cycle while the buffer shrunk instead of growing. Discontinuity mode
      // always produces fresh data beyond the buffer end, guaranteeing net
      // positive buffer growth per cycle.
      //
      // Discontinuity mode: seek to buffer end, find nearest keyframe, produce
      // data from keyframe onward with setTimestampOffset. The SourceBuffer
      // merges the new data with existing buffer. getKeyPacket for cached data
      // is fast (~1-2ms), making the setTimestampOffset overhead negligible.
      const ahead = getBufferedAheadSeconds();
      const rawRefillPosition = video.currentTime + ahead;

      // Snap the refill start to the cue keyframe the PREVIOUS refill stopped on.
      // A refill stops by breaking at `packet.timestamp >= stopKf`, so it appends
      // every sample strictly BELOW the stop keyframe; SourceBuffer.buffered.end
      // then reports ~1ms below that keyframe (last muxed sample end — a different
      // float clock than the MKV cue time). Left unsnapped, seekTo →
      // nearestCueKeyframeAtOrBefore(bufEnd) rounds DOWN a full GOP (the stop
      // keyframe sits 1ms above bufEnd) and re-transmuxes ~10s already buffered
      // (observed: bufEnd=1515.336 → re-seek 1505.327, overlap=10.009s). Snapping
      // up to the cue keyframe within a 0.25s tolerance (≫ 1ms skew, ≪ GOP) makes
      // the next refill abut cleanly. No-op for TS/indexless (returns input).
      const refillPosition = transmuxer.snapToCueKeyframe(rawRefillPosition);

      // maxDuration is the FALLBACK cutoff used only when no cue index exists
      // (TS / pre-parse). For MKV we stop on a keyframe boundary instead (below).
      const maxDuration = Math.min(REFILL_CHUNK_DURATION + 12, REFILL_MAX_DURATION_CAP);

      // Fix #1 (abutting refills — kills the ~51s PIPELINE_ERROR_DECODE):
      // Stop this refill EXACTLY on the first cue keyframe past
      // (refillPosition + REFILL_CHUNK_DURATION). Because the refill ends on a
      // keyframe, the buffer end lands ON a keyframe, so the NEXT refill seeks
      // to refillPosition == that keyframe and abuts with ZERO overlap (no
      // coded-frame replacement → no stranded P-frame → no decode crash) and
      // ZERO gap (the next GOP starts exactly where this one stopped). Returns
      // Infinity when the cue index is unavailable → falls back to maxDuration,
      // preserving the original behavior for TS/indexless streams.
      const stopTime = transmuxer.nextKeyframeAtOrAfter(refillPosition + REFILL_CHUNK_DURATION) ?? Infinity;

      // Always skip init segment for refills — SourceBuffer already has it from
      // the initial seek. Producing a new init segment is wasteful and causes
      // MSE codec re-initialization overhead.
      const skipInit = true;

      // Enable buffering mode for the refill seek
      bufferingForSeekRef.current = true;
      seekBufferRef.current = [];

      // seekTo creates a fresh Input with the persistent TauriStreamSource,
      // guaranteeing a clean demuxer state that can iterate from any position.
      const keyframeTimestamp = await transmuxer.seekTo(refillPosition, maxDuration, { skipInitSegment: skipInit, stopTime });

      if (Number.isFinite(stopTime) && keyframeTimestamp !== null) {
        console.log(`[MSE] Abutting refill: seekKf=${keyframeTimestamp.toFixed(3)}s bufEnd=${refillPosition.toFixed(3)}s stopKf=${stopTime.toFixed(3)}s overlap=${(refillPosition - keyframeTimestamp).toFixed(3)}s`);
      }

      // Bail out if chain was stopped while we were waiting for seekTo.
      // CRITICAL: do NOT clear bufferingForSeekRef or seekBufferRef when the
      // generation is stale — a new seek handler may have already set these
      // refs for its own use. Clearing them would cause the new seek's
      // segments to be appended directly with wrong timestampOffset (the
      // refill's async abort undoes the new seek's synchronous setup).
      if (chainGeneration !== streamingChainGenRef.current) {
        refillInProgressRef.current = false;
        return;
      }

      // Disable buffering mode
      bufferingForSeekRef.current = false;

      // EOF detection: when a refill finds the same keyframe as the previous
      // refill (no new data progress), or when refillPosition is close to the
      // end of the file, we've reached EOF. Stop the chain and signal
      // endOfStream to the browser so it fires the 'ended' event and shows
      // the replay overlay. Without this, the refill loops infinitely at EOF
      // producing the same tiny data while buffer shrinks, and video.ended
      // never becomes true.
      //
      // noProgress requires 2+ consecutive same-keyframe detections to avoid
      // cutting off the last few seconds when a large keyframe interval near
      // EOF causes the refill position to map back to the same keyframe once
      // (normal behavior — the next refill should progress past it). Only
      // after 2+ consecutive same-keyframes do we declare true EOF.
      //
      // nearEOF uses a dynamic threshold based on keyframe index when available:
      // duration - (estimated keyframe interval). If no index, falls back to
      // duration - 5 (conservative default). This prevents triggering too early
      // when the last keyframe is several seconds before duration end.
      const duration = state.current.duration;
      const keyframeIndex = transmuxerRef.current?.getKeyframeTimestamps();
      // Estimate keyframe interval from index (average gap between last 5 keyframes)
      let estimatedKeyframeInterval = 5; // conservative default
      if (keyframeIndex && keyframeIndex.length >= 6) {
        const last5 = keyframeIndex.slice(-6);
        const avgGap = (last5[last5.length - 1] - last5[0]) / (last5.length - 1);
        estimatedKeyframeInterval = Math.max(avgGap, 2); // at least 2s
      }
      const isNearEOF = refillPosition >= duration - estimatedKeyframeInterval;
      const isNoProgress = keyframeTimestamp !== null &&
        lastRefillKeyframeRef.current !== null &&
        Math.abs(keyframeTimestamp - lastRefillKeyframeRef.current) < 0.1;
      if (isNoProgress) {
        consecutiveNoProgressRef.current++;
      } else {
        consecutiveNoProgressRef.current = 0;
      }
      // Require 2+ consecutive noProgress OR nearEOF with at least 1 noProgress
      const isConfirmedEOF = (consecutiveNoProgressRef.current >= 2) ||
        (isNearEOF && consecutiveNoProgressRef.current >= 1);
      if (isConfirmedEOF && keyframeTimestamp !== null) {
        console.log(`[MSE] EOF detected: nearEOF=${isNearEOF} (pos=${refillPosition.toFixed(1)}s, dur=${duration.toFixed(1)}s, keyframeInterval=${estimatedKeyframeInterval.toFixed(1)}s), noProgress=${isNoProgress} (consecutive=${consecutiveNoProgressRef.current}, keyframe=${keyframeTimestamp.toFixed(2)}s, last=${lastRefillKeyframeRef.current?.toFixed(2)}s) — ending stream`);
        // Mark completion so the near-end seek guard works
        hasEverCompletedRef.current = true;
        // Process the last refill's segments before ending stream
        evictOldBuffer();
        const tsOffset = keyframeTimestamp;
        seekOffsetRef.current = tsOffset;
        await sb.setTimestampOffset(tsOffset);
        const sbA = state.current.audioSourceBuffer;
        if (sbA) await sbA.setTimestampOffset(tsOffset);
        const buffer = seekBufferRef.current;
        seekBufferRef.current = [];
        let segmentCount = 0;
        for (const item of buffer) {
          if (item.type === 'media') {
            if (item.trackType === 'audio' && sbA) {
              sbA.appendBuffer(item.data);
            } else {
              sb.appendBuffer(item.data);
            }
            segmentCount++;
          }
        }
        console.log(`[MSE] EOF final refill: keyframe=${keyframeTimestamp.toFixed(2)}s, flushed ${segmentCount} segments`);
        await sb.waitForQueueDrain();
        if (sbA) await sbA.waitForQueueDrain();
        // Signal end of stream to the browser
        const ms = state.current.mediaSource;
        if (ms && ms.readyState === 'open') {
          try { ms.endOfStream(); console.log('[MSE] endOfStream called at EOF'); } catch (e) { console.warn('[MSE] endOfStream failed:', e); }
        }
        setIsComplete(true);
        isCompleteRef.current = true;
        refillInProgressRef.current = false;
        // Don't chain any more refills — the stream is ended
        return;
      }
      // Update last refill keyframe for progress tracking
      if (keyframeTimestamp !== null) {
        lastRefillKeyframeRef.current = keyframeTimestamp;
      }

      if (keyframeTimestamp !== null) {
        evictOldBuffer();
        const tsOffset = keyframeTimestamp;
        seekOffsetRef.current = tsOffset;
        await sb.setTimestampOffset(tsOffset);
        const sbA = state.current.audioSourceBuffer;
        if (sbA) await sbA.setTimestampOffset(tsOffset);

        const buffer = seekBufferRef.current;
        seekBufferRef.current = [];
        let segmentCount = 0;
        for (const item of buffer) {
          if (item.type === 'media') {
            if (item.trackType === 'audio' && sbA) {
              sbA.appendBuffer(item.data);
            } else {
              sb.appendBuffer(item.data);
            }
            segmentCount++;
            const absoluteTimestamp = item.timestamp! + seekOffsetRef.current;
            if (absoluteTimestamp > 0 && state.current.duration > 0 && state.current.fileLength > 0) {
              const estimatedBytes = Math.floor((absoluteTimestamp / state.current.duration) * state.current.fileLength);
              setPrefetchedBytes(estimatedBytes);
              trackDownloadedRange(estimatedBytes, estimatedBytes + item.data.byteLength);
            }
          }
        }

        console.log(`[MSE] Discontinuity refill: keyframe=${keyframeTimestamp.toFixed(2)}s, flushed ${segmentCount} segments`);
        await sb.waitForQueueDrain();
        if (sbA) await sbA.waitForQueueDrain();

        // Update keyframeIndexReady if the transmuxer's partial index became available
        // during this seek (incremental timestamps from refill seeks). This triggers
        // the thumbnail pipeline to use the index.
        if (!keyframeIndexReady && transmuxer.isKeyframeIndexReady()) {
          setKeyframeIndexReady(true);
        }
      } else {
        // Refill failed — discard buffered segments
        seekBufferRef.current = [];
        console.warn('[MSE] Streaming refill failed');
      }
    } catch (e) {
      // Only clear bufferingForSeekRef if this refill's generation is still
      // the active one. If the generation is stale (a new seek started),
      // the new seek handler owns these refs and we must not interfere.
      if (chainGeneration === streamingChainGenRef.current) {
        bufferingForSeekRef.current = false;
        seekBufferRef.current = [];
      }
      console.error('[MSE] Streaming refill error:', e);
    } finally {
      refillInProgressRef.current = false;

      // Don't chain if this refill's generation is stale (chain was stopped/restarted)
      if (chainGeneration !== streamingChainGenRef.current) return;

      // Continuous buffer monitoring: always schedule a re-check after this refill.
      // When buffer is low (< threshold), re-check immediately (0ms delay).
      // When buffer is sufficient (>= threshold), use adaptive delay:
      //   delay = min(5000, max(2000, (ahead - threshold) * 200))
      //   This gives 2s at threshold, 4.5s at 25s ahead, 5s at 40s+ ahead.
      //   Prevents buffer growing beyond 30-40s by reducing refill frequency
      //   when buffer is large.
      // This ensures the chain never fully stops — it continuously monitors
      // buffer health and refills when the video consumes enough data.
      // Without this, the chain stops when buffer reaches threshold, and
      // the video stalls when the initial buffer runs out (no re-trigger).
      const video = videoRef.current;
      const transmuxer = transmuxerRef.current;
      const sb = state.current.videoSourceBuffer;
      if (video && transmuxer && sb && !video.ended && !sb.hasFatalError && !isCompleteRef.current) {
        const ahead = getBufferedAheadSeconds();
        // Hard cap on buffer ahead: skip refills entirely when > cap seconds ahead.
        // Prevents buffer from growing excessively (e.g., 62.9s ahead for TS)
        // which wastes bandwidth, risks QuotaExceededError, and slows seeks
        // because more data needs to be evicted. Same dynamic cap enforced at the
        // top of executeStreamingRefill (the entry guard is what actually caps;
        // this just picks a longer re-check delay when already full).
        const aheadCap = getBufferAheadCap();
        if (ahead >= aheadCap) {
          console.log(`[MSE] Buffer ahead ${ahead.toFixed(1)}s exceeds cap ${aheadCap}s — sleeping 2000ms before re-check`);
          setTimeout(() => {
            if (streamingChainGenRef.current === chainGeneration) {
              executeStreamingRefill();
            }
          }, 2000);
        } else {
          const delay = ahead < REFILL_THRESHOLD_SECONDS ? 0 : Math.min(5000, Math.max(2000, Math.floor((ahead - REFILL_THRESHOLD_SECONDS) * 200)));
          if (delay === 0) {
            console.log(`[MSE] Buffer ahead ${ahead.toFixed(1)}s below threshold ${REFILL_THRESHOLD_SECONDS}s — chaining next refill immediately`);
          } else {
            console.log(`[MSE] Buffer ahead ${ahead.toFixed(1)}s sufficient — sleeping ${delay}ms before re-check`);
          }
          setTimeout(() => {
            // Re-check generation before executing — chain may have been stopped
            if (streamingChainGenRef.current === chainGeneration) {
              executeStreamingRefill();
            }
          }, delay);
        }
      }
    }
  };

  /** Remove buffered data older than (currentTime - BUFFER_KEEP_BEHIND) when buffer is too large.
   *  Bug #16 fix: also evict when currentTime is 0 (initial buffering case).
   *  In that case, evict data that's far ahead of position 0. */
  const evictOldBuffer = () => {
    const video = videoRef.current;
    const sbVideo = state.current.videoSourceBuffer;
    const sbAudio = state.current.audioSourceBuffer;
    if (!sbVideo && !sbAudio) return;
    if (!video) return;

    // Check total buffered bytes
    let totalBuffered = 0;
    const checkBuffered = (sb: SourceBufferWrapper) => {
      const ranges = sb.buffered;
      for (let i = 0; i < ranges.length; i++) {
        totalBuffered += ranges.end(i) - ranges.start(i);
      }
    };
    if (sbVideo) checkBuffered(sbVideo);
    if (sbAudio) checkBuffered(sbAudio);

    // Only evict if buffer exceeds threshold (rough estimate: seconds * bitrate)
    if (totalBuffered * state.current.bitrate < maxBufferBytes) return;

    const currentTime = video.currentTime;
    const evictBefore = currentTime > 0
      ? Math.max(0, currentTime - BUFFER_KEEP_BEHIND)
      : 0;

    if (evictBefore <= 0) return;

    const evictRange = (sb: SourceBufferWrapper) => {
      const ranges = sb.buffered;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.end(i) < evictBefore) {
          sb.remove(ranges.start(i), ranges.end(i));
        }
      }
    };
    if (sbVideo) evictRange(sbVideo);
    if (sbAudio) evictRange(sbAudio);
  };

  const initMP4Box = async (url: string, mediaSource: MediaSource, blobUrl: string) => {
    try {
      const MP4Box = await loadMP4Box();
      if (cancelledRef.current) return;

      // Store MP4Box class for thumbnail mini-MSE pipeline
      mp4BoxClassRef.current = MP4Box;

      const mp4box = MP4Box.createFile(false);
      state.current.mp4box = mp4box;

      mp4box.onReady = (info: any) => {
        if (cancelledRef.current) return;
        onMP4BoxReady(info, url, mediaSource, mp4box, blobUrl);
      };

      mp4box.onError = (e: any) => {
        console.error('[MSE] mp4box error:', e);
        if (!cancelledRef.current) {
          setUseNative(true);
        }
      };

      // Get file size via HEAD request first
      const headResp = await fetch(url, { method: 'HEAD' });
      if (cancelledRef.current) return;

      const headLen = headResp.headers.get('Content-Length');
      if (headLen) {
        state.current.fileLength = parseInt(headLen, 10);
        setTotalBytes(state.current.fileLength);
      }

      // Fetch first fragment (smallest size for fast moov discovery)
      const firstChunkSize = FRAGMENT_SIZES[0]; // 512KB
      const response = await fetch(url, {
        headers: { Range: `bytes=0-${firstChunkSize - 1}` },
      });

      if (cancelledRef.current) return;

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Fallback: get file length from Content-Range if HEAD didn't provide it
      if (state.current.fileLength === 0) {
        const contentRange = response.headers.get('Content-Range');
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)/);
          if (match) {
            state.current.fileLength = parseInt(match[1], 10);
            setTotalBytes(state.current.fileLength);
          }
        }
      }

      let data = await response.arrayBuffer();
      if (cancelledRef.current) return;

      // Diagnostic: dump first 16 bytes to help debug format detection
      const firstBytes = new Uint8Array(data.slice(0, 16));
      const hexDump = Array.from(firstBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      diagLog(`[MSE] First 16 bytes: ${hexDump} (format detection input)`);
      diagLog(`[MSE] Filename for format detection: ${file?.name ?? 'null'}`);

      // Detect file format from first bytes
      const format = detectFormat(data, file?.name);
      formatRef.current = format;
      setDetectedFormat(format);
      diagLog(`[MSE] detectFormat result: ${format}`);

      // Compute dynamic cold-start threshold now that we know the format + file size
      const dynamicThreshold = computeColdStartThreshold(
        state.current.fileLength,
        file?.duration,
        format,
        !!isPublicChannel,
      );
      setMinColdStartBytes(dynamicThreshold);
      diagLog(`[MSE] Dynamic cold-start threshold: ${formatBytes(dynamicThreshold)} (file=${formatBytes(state.current.fileLength)}, duration=${file?.duration != null ? `${file.duration}s` : 'unknown'}, format=${format})`);

      if (format === 'unknown') {
        diagLog('[MSE] Unknown format — falling back to native playback');
        setUseNative(true);
        return;
      }

      if (format === 'mkv' || format === 'webm') {
        // Mark transmuxer init in-progress BEFORE the (potentially slow) cold
        // prefetch below. On a cold network the 20MB prefetch can exceed the 20s
        // MSE_INIT_TIMEOUT, and without this flag the timeout handler (checkInitTimeout)
        // fires native fallback → closes the MediaSource → the transmuxer's later
        // addSourceBuffer throws InvalidStateError ("readyState is not 'open'") and
        // the whole MKV path collapses to the broken /remux fallback. Setting it
        // here makes the timeout EXTEND (up to MSE_INIT_MAX_TIMEOUT) instead. It is
        // reset to false on every failure/fallback path below.
        transmuxerInitInProgressRef.current = true;
        // MKV/WebM only need header+Tracks for codec detection (the transmuxer
        // reads everything else via cached range requests); TS needs the full
        // 20MB packet-scan seed. Using the smaller MKV target here is the bulk of
        // the startup win — it removes ~18MB of blocking cold-network prefetch.
        const prefetchTarget = MKV_INITIAL_PREFETCH;
        if (data.byteLength < prefetchTarget && state.current.fileLength > prefetchTarget) {
          diagLog(`[MSE] ${format}: fetching additional prefetch data (${data.byteLength} → ${prefetchTarget} bytes)`);
          try {
            const extraResponse = await fetch(url, {
              headers: { Range: `bytes=${data.byteLength}-${prefetchTarget - 1}` },
            });
            if (extraResponse.ok || extraResponse.status === 206) {
              const extraData = await extraResponse.arrayBuffer();
              if (!cancelledRef.current) {
                const merged = new Uint8Array(data.byteLength + extraData.byteLength);
                merged.set(new Uint8Array(data), 0);
                merged.set(new Uint8Array(extraData), data.byteLength);
                data = merged.buffer;
                diagLog(`[MSE] ${format}: prefetch complete, ${data.byteLength} bytes cached`);
              }
            }
          } catch (e: any) {
            diagLog(`[MSE] ${format}: extra prefetch failed (${e.message}), proceeding with ${data.byteLength} bytes`);
          }
        }
      }

      if (format === 'ts') {
        // timed_id3 metadata streams (stream_type=0x15 alongside real audio) are
        // incompatible with mpegts.js — they cause AAC PTS drift → PIPELINE_ERROR_DECODE.
        // The backend detects these during init-prefix creation and exposes
        // `has_timed_id3` in the /fmp4/metadata response. We fetch metadata early
        // and route to ffmpeg remux if flagged.
        // NOTE: we can't detect timed_id3 from the stream data here because the
        // backend already strips the 0x15 entry from the PMT before serving it.
        const fallbackUrl = streamUrlRef.current ?? url;
        const parsed = parseStreamUrl(fallbackUrl);

        // Fire metadata fetch — needed for duration AND timed_id3 detection
        let metaPromise: Promise<any> | null = null;
        if (parsed && !(window as any).__nobuf_ptsDuration) {
          const metaUrl = `${parsed.baseUrl}/fmp4/metadata/${parsed.folderId}/${parsed.messageId}?token=${encodeURIComponent(parsed.token)}&file_size=${state.current.fileLength}`;
          const fetchGen = effectGenerationRef.current;
          metaPromise = fetch(metaUrl)
            .then(resp => resp.ok ? resp.json() : null)
            .then(json => {
              if (effectGenerationRef.current !== fetchGen) return null;
              if (json?.duration_s && json.duration_s > 0) {
                (window as any).__nobuf_ptsDuration = json.duration_s;
                diagLog(`[MSE] Got accurate duration from backend: ${json.duration_s.toFixed(1)}s`);
              }
              return json;
            })
            .catch(e => { diagLog(`[MSE] Metadata fetch failed: ${e}`); return null; });
        }

        // Check for timed_id3 flag from metadata (async — resolve before proceeding)
        if (metaPromise) {
          const meta = await metaPromise;
          if (meta?.has_timed_id3 && parsed) {
            diagLog('[MSE] Backend reports timed_id3 metadata stream — using ffmpeg remux (mpegts output) via mpegts.js');
            const remuxUrl = `${parsed.baseUrl}/remux/${parsed.folderId}/${parsed.messageId}?token=${encodeURIComponent(parsed.token)}&hevc_ok=${hevcMseSupported()}`;
            diagLog(`[MSE] Routing to remux: ${remuxUrl}`);
            remuxUrlRef.current = remuxUrl;
            // Route SEEKS through the /remux endpoint using BYTE-FORWARD seeking
            // (start_byte), NOT the raw /stream byte-seek recreation. This fixes
            // all three byte-seek bugs (muted audio, VBR-inaccurate landing,
            // scattered prebuffer) because ffmpeg does the remux (clean AAC-LC
            // audio) — while AVOIDING the /remux?ss= regression (ffmpeg `-ss`
            // can't timestamp-seek uncached /stream data → empty output →
            // infinite load; logs 4-t/5-t). Byte-forward feeds ffmpeg
            // [init_prefix + /stream bytes from the offset] via stdin, so ffmpeg
            // reads sequentially from its own byte 0 and never seeks. The
            // buildRemuxSeekUrl call in _mpegtsRecreatePlayerForRemuxSeek emits
            // &start_byte= (see that fn + seek-issues-findings.md "Option 2").
            needsRemuxSeekRef.current = true;
            remuxSeekBaseUrlRef.current = remuxUrl;
            // timed_id3 /stream IS real MPEG-TS → byte-forward seeks are valid.
            remuxSourceIsTsRef.current = true;
            // Don't use native fallback — the /remux endpoint now outputs MPEG-TS
            // which mpegts.js can play directly with full features (seeking, progress bar).
            // Fall through to the mpegts.js init path below with the remux URL.
            if (!shadowCacheRef.current) {
              shadowCacheRef.current = new StreamShadowCache(300 * 1024 * 1024);
            }
            const urlKey2 = new URL(remuxUrl).pathname;
            shadowCacheRef.current.reset(urlKey2, 0);
            // Mark transmuxer init in progress so the MSE init timeout extends
            // instead of firing at 20s (remux needs: download + ffprobe + ffmpeg startup).
            transmuxerInitInProgressRef.current = true;
            // Clear mseUrl BEFORE mpegts.js init — mpegts.js creates its own
            // MediaSource and sets video.src internally. If we leave mseUrl set
            // to our empty blob URL, FastStreamPlayer will overwrite video.src
            // on the next render, causing ERR_FILE_NOT_FOUND on the data-less blob.
            setMseUrl(null);
            // Show the cold-start overlay during remux startup (download + ffprobe + ffmpeg
            // spawn + first fragments). The MEDIA_INFO handler resolves the deferred and
            // dismisses the overlay once the player is ready.
            let remuxColdStartResolve: () => void = () => {};
            const remuxColdStartPromise = new Promise<void>((resolve) => { remuxColdStartResolve = resolve; });
            coldStartDeferredRef.current = { resolve: remuxColdStartResolve, promise: remuxColdStartPromise };
            setIsColdStartBuffering(true);
            setColdStartPhase('initializing_player');
            setColdStartProgress({ bytes: 0, targetBytes: 0 }); // indeterminate for remux
            // Start mpegts.js with the remux URL
            await _initMpegtsPlayer(remuxUrl, mediaSource, blobUrl, parsed);
            return;
          }
        }

        diagLog(`[MSE] Detected ${format} format — starting cold-start buffer + mpegts.js init in parallel, fileLength=${state.current.fileLength}`);
        // Create the shadow cache once here so both parallel tasks share the same instance
        // and the interceptor is installed before any /stream fetches are issued.
        const urlKey = new URL(url).pathname;
        if (!shadowCacheRef.current) {
          shadowCacheRef.current = new StreamShadowCache(300 * 1024 * 1024);
        }
        shadowCacheRef.current.reset(urlKey, state.current.fileLength);
        // Create a deferred promise that resolves when the first 5MB is in the shadow cache.
        // Playback will not start until this promise resolves (or the timeout fires).
        let coldStartResolve: () => void = () => {};
        const coldStartPromise = new Promise<void>((resolve) => { coldStartResolve = resolve; });
        coldStartDeferredRef.current = { resolve: coldStartResolve, promise: coldStartPromise };
        // Clear mseUrl BEFORE mpegts.js init — mpegts.js creates its own
        // MediaSource and sets video.src internally. If we leave mseUrl set
        // to our empty blob URL, FastStreamPlayer will overwrite video.src
        // on the next render, causing ERR_FILE_NOT_FOUND on the data-less blob.
        setMseUrl(null);
        // Show the cold-start overlay while the first chunk is being pulled into the shadow cache.
        setIsColdStartBuffering(true);
        setColdStartPhase('buffering');
        setColdStartProgress({ bytes: 0, targetBytes: dynamicThreshold });
        // Start mpegts.js immediately, but playback is gated on the first 5MB.
        const initPromise = initTransmuxerPlayer(url, mediaSource, blobUrl!, format);
        await initPromise;
        return;
      }

      if (format === 'mkv' || format === 'webm') {
        // WebM (VP8/VP9/Opus) plays natively in WebView2 — no remux needed.
        // MKV routing depends on the video codec: mpegts.js (via the /remux
        // ffmpeg pipeline) can play H.264/H.265 with full seek + progress bar,
        // but VP8/VP9/AV1 cannot be `-c:v copy`'d into MPEG-TS and must use the
        // native <video> element instead.
        if (format === 'webm') {
          diagLog('[MSE] webm — using native playback (WebView2 plays VP8/VP9/Opus natively)');
          setUseNative(true);
          return;
        }

        // MKV: detect the video codec from the prefetched header bytes.
        const mkvCodec = await detectMkvVideoCodec(data);
        diagLog(`[MSE] mkv video codec detected: ${mkvCodec ?? 'unknown'}`);
        if (cancelledRef.current) return;

        const parsed = parseStreamUrl(streamUrlRef.current ?? url);

        // H.264 MKV → client-side MediabunnyTransmuxer (fMP4). This is the
        // preferred path: it demuxes the MKV in-browser and seeks natively by
        // keyframe, so the progress bar/seek work correctly (the /remux →
        // mpegts.js path plays but its byte-seek can't parse raw Matroska).
        // `data` is the 20MB header prefetch, reused as the transmuxer seed.
        if (mkvCodec === 'avc') {
          diagLog('[MSE] mkv (avc) — using client-side MediabunnyTransmuxer (fMP4, native seek)');
          const ok = await _initMkvTransmuxerPlayer(url, mediaSource, blobUrl, data);
          if (ok || cancelledRef.current) return;
          // Transmuxer init failed — fall through to the /remux path below as a
          // last resort (playback works there even if seek is limited).
          diagLog('[MSE] mkv (avc) transmuxer init failed — falling back to /remux → mpegts.js');
        }

        // H.265 MKV (transmuxer marks hevc unsupported for MSE), or avc
        // transmuxer fallback → ffmpeg /remux endpoint (outputs MPEG-TS) played
        // with mpegts.js. Same pipeline as the timed_id3 TS path.
        if ((mkvCodec === 'hevc' || mkvCodec === 'avc') && parsed) {
          // hevc_ok tells the backend this runtime CAN decode HEVC via MSE
          // (HEVC Video Extensions installed) → 8-bit HEVC gets -c:v copy
          // instead of a transcode. Stock WebView2 sends false.
          const hevcOk = hevcMseSupported();
          const remuxUrl = `${parsed.baseUrl}/remux/${parsed.folderId}/${parsed.messageId}?token=${encodeURIComponent(parsed.token)}&hevc_ok=${hevcOk}`;
          diagLog(`[MSE] mkv (${mkvCodec}) — routing to ffmpeg remux → mpegts.js: ${remuxUrl}`);
          remuxUrlRef.current = remuxUrl;
          // MKV /stream/ is Matroska, NOT MPEG-TS — byte-seeking it feeds the TS
          // demuxer garbage. Route seeks through /remux?ss= instead (ffmpeg seek).
          // (timed_id3 does NOT set this: its /stream/ is real TS, byte-seek works.)
          needsRemuxSeekRef.current = true;
          remuxSeekBaseUrlRef.current = remuxUrl;
          remuxSourceIsTsRef.current = false; // Matroska: ss-only seeks

          if (!shadowCacheRef.current) {
            shadowCacheRef.current = new StreamShadowCache(300 * 1024 * 1024);
          }
          const mkvUrlKey = new URL(remuxUrl).pathname;
          shadowCacheRef.current.reset(mkvUrlKey, 0);

          // Mark transmuxer init in progress so the MSE init timeout extends
          // instead of firing at 20s (remux needs: download + ffprobe + ffmpeg startup).
          transmuxerInitInProgressRef.current = true;

          // Clear mseUrl BEFORE mpegts.js init — mpegts.js creates its own
          // MediaSource and sets video.src internally. Leaving mseUrl set to our
          // empty blob URL would make FastStreamPlayer overwrite video.src on the
          // next render, causing ERR_FILE_NOT_FOUND on the data-less blob.
          setMseUrl(null);

          // Show the cold-start overlay during remux startup (download + ffprobe +
          // ffmpeg spawn + first fragments). The MEDIA_INFO handler resolves the
          // deferred and dismisses the overlay once the player is ready.
          let mkvColdStartResolve: () => void = () => {};
          const mkvColdStartPromise = new Promise<void>((resolve) => { mkvColdStartResolve = resolve; });
          coldStartDeferredRef.current = { resolve: mkvColdStartResolve, promise: mkvColdStartPromise };
          setIsColdStartBuffering(true);
          setColdStartPhase('initializing_player');
          setColdStartProgress({ bytes: 0, targetBytes: 0 }); // indeterminate for remux

          await _initMpegtsPlayer(remuxUrl, mediaSource, blobUrl, parsed);
          return;
        }

        // VP8/VP9/AV1 in MKV, codec undetectable, or unparseable URL → native
        // fallback. WebView2 can play VP9/AV1 MKV natively; H.264 MKV would fail
        // natively, but if detection failed we have no better option.
        diagLog(`[MSE] mkv (${mkvCodec ?? 'unknown'}) — not transmuxable/remuxable, using native playback`);
        setUseNative(true);
        return;
      }

      // MP4 format — proceed with MP4Box.js
      console.log('[MSE] Detected MP4 format — proceeding with MP4Box.js');

      // Show cold-start overlay during MP4 initialization (moov fetch + mp4box setup).
      // For MP4 files, the overlay covers the initial metadata parsing phase.
      setIsColdStartBuffering(true);
      setColdStartPhase('fetching_metadata');
      setColdStartProgress({ bytes: 0, targetBytes: 0 }); // indeterminate for MP4 metadata

      // Store first chunk for thumbnail mini-MSE pipeline
      firstChunkRef.current = data.slice(0);

      // Scan the first chunk for moov atom. In MP4 format, each box has:
      // [4 bytes size][4 bytes type][payload]. We scan for boxes with type "moov".
      const moovInFirstChunk = scanForMoovBox(data);

      if (moovInFirstChunk) {
        // Faststarted MP4: moov is near the beginning. Feed the first chunk
        // to mp4box — moov will be found and onReady will fire immediately.
        console.log('[MSE] moov found in first chunk — faststarted MP4');

        // Try to extract the moov box bytes for the thumbnail mini-MSE pipeline.
        // If the moov extends beyond the first chunk, we'll fetch it after
        // onMP4BoxReady fires (when we know the exact moov offset/size from mp4box).
        const moovExtract = extractMoovFromForwardScan(data);
        if (moovExtract) {
          moovBufferRef.current = { buffer: moovExtract!.data, fileStart: moovExtract!.fileStart };
          setMoovBufferReady(true);
          console.log('[MSE] Moov extracted from first chunk for thumbnail pipeline');
        } else {
          console.log('[MSE] Moov extends beyond first chunk — will extract after onMP4BoxReady');
        }

        const buffer = data as any;
        buffer.fileStart = 0;
        mp4box.appendBuffer(buffer);

        state.current.currentOffset = firstChunkSize;
        setPrefetchedBytes(firstChunkSize);

        // If onReady hasn't fired yet (moov box might extend beyond 512KB),
        // forward scan up to 10MB to find the complete moov atom.
        if (!state.current.initialized && state.current.fileLength > 0) {
          await fetchMoreDataForwardScan(url, mp4box);
        }

        // If moov wasn't fully in the first chunk and we still haven't set
        // moovBufferRef (moov might span multiple forward-scan chunks that
        // were fed to mp4box separately), fetch the complete moov bytes now.
        // onMP4BoxReady has already fired (otherwise we'd have fallen back
        // to native), so we can use mp4box's track info to determine the
        // moov location. For simplicity, we re-scan the data range that
        // contains the moov.
        if (!moovBufferRef.current && state.current.initialized) {
          await fetchMoovForFaststarted(url);
        }
      } else {
        // Non-faststarted MP4: moov is at the END of the file. Instead of
        // falling back to native playback (which can't play moov-at-end files
        // well — the native player makes short-lived range requests that
        // cascade endlessly), we fetch the moov atom from the tail, append
        // it to mp4box.js, then start the download loop from the beginning.
        // mp4box.js CAN handle moov-at-end files if the moov is appended
        // with its correct fileStart offset before the mdat data.
        console.log('[MSE] moov NOT in first chunk — non-faststarted MP4, fetching moov from tail');
        await fetchMoovFromTail(url, mp4box, data);
      }
    } catch (e: any) {
      console.error('[MSE] Setup failed:', e);
      if (!cancelledRef.current) {
        diagLog(`[MSE] Setup failed: ${e.message} — falling back to native`);
        setIsColdStartBuffering(false);
        setColdStartPhase('none');
        setUseNative(true);
      }
    }
  };

  /** mpegts.js TS player: client-side TS demuxing via mpegts.js library.
   *  mpegts.js reads TS bytes from the /stream/ URL, demuxes in JS,
   *  and appends fMP4 to its own MSE SourceBuffer. It handles:
   *  - Duration (from TS PAT/PMT + PCR timestamps)
   *  - Seeking (via HTTP Range headers)
   *  - Buffering & backpressure (built-in IO stash buffer)
   *  - ID3 streams (correctly ignores them, unlike ffmpeg)
   *  No backend segment generation needed — just the existing /stream/ endpoint.
   */
  const _initMpegtsPlayer = async (
    _url: string,
    _mediaSource: MediaSource,
    _blobUrl: string,
    parsed: { baseUrl: string; folderId: string; messageId: string; token: string }
  ): Promise<boolean> => {
    const video = videoRef.current;
    if (!video) {
      diagLog('[MPEGTS] No video element — cannot attach player');
      return false;
    }

    let mpegts: any = null;
    try {
      mpegts = await import('mpegts.js');
    } catch (e: any) {
      diagLog(`[MPEGTS] Failed to import mpegts.js: ${e.message}`);
      return false;
    }

    if (!mpegts.default?.isSupported?.()) {
      diagLog('[MPEGTS] mpegts.js not supported in this browser/WebView');
      return false;
    }

    const MpegtsPlayer = mpegts.default || mpegts;

    // ── PATCH: Fix FetchStreamLoader.abort() on Chrome/WebView2 ──
    // mpegts.js FetchStreamLoader.abort() (line 177) SKIPS abortController.abort()
    // when _status === kBuffering on Chrome, to avoid exceptions. But this leaves
    // the ReadableStream reader pumping data via _pump()'s Promise.then chain.
    // When IOController.seek() → _internalSeek() → abort() + destroy() + new loader.open(),
    // the old pump is still running, feeding stale data to TSDemuxer alongside the
    // new Range request. This causes "sync_byte != 0x47" errors and playback failure.
    // Fix: Always abort the fetch controller, even on Chrome. The exception is
    // harmless (DOMException AbortError) and caught by the .catch() in _pump().
    try {
      const FetchStreamLoader = mpegts.FetchStreamLoader || (mpegts.default?.FetchStreamLoader);
      if (FetchStreamLoader?.prototype?.abort) {
        FetchStreamLoader.prototype.abort = function() {
          // Always abort the fetch, even on Chrome when buffering
          if (this._abortController) {
            try { this._abortController.abort(); } catch (_) {}
          }
          // Also set the flag so _pump() checks on next read resolve
          this._requestAbort = true;
          this._status = 0; // kIdle — prevents _pump from re-entering
        };
        diagLog('[MPEGTS] Patched FetchStreamLoader.abort() to always abort fetch on Chrome/WebView2');
      }
    } catch (e: any) {
      diagLog(`[MPEGTS] Could not patch FetchStreamLoader: ${e.message}`);
    }

    const ChunkedFetchLoader = createChunkedFetchLoader(MpegtsPlayer);

    // ── NOTE: IOController is NOT exported from mpegts.js ──
    // IOController cannot be patched via mpegts.IOController (undefined).
    // With continuous download (lazyLoad OFF), the FetchStreamLoader.abort() patch
    // "Pipeline initialized" block below via LoadingController.resumeTransmuxer().
    // Do NOT try to patch IOController.pause() to preserve the stash —
    // _stashByteStart + _stashUsed is NOT TS-packet-aligned, causing
    // sync_byte != 0x47 errors on resume.

    // ── Reduce mpegts.js console noise ──
    // mpegts.js logs are very chatty at default levels. The "Dropping audio frame"
    // warnings from MP4Remuxer (during DTS misalignment) can flood the console.
    // After the IOController pause/resume fix above, these should be eliminated.
    // But we still reduce verbose/info/debug noise to keep the console readable.
    try {
      const LoggingControl = mpegts.LoggingControl || (mpegts.default?.LoggingControl);
      if (LoggingControl) {
        LoggingControl.enableDebug = false;
        LoggingControl.enableVerbose = false;
        LoggingControl.enableInfo = false;
        // Keep warnings and errors enabled — they indicate real issues
      }
    } catch (_) {}

    // Construct the stream URL that mpegts.js will fetch from.
    // It reads TS bytes via HTTP Range requests from our /stream/ endpoint.
    // For timed_id3 files, the caller passes a remux URL (/remux/) which
    // outputs clean MPEG-TS (re-encoded audio, no metadata stream).
    const streamUrl = _url || `${parsed.baseUrl}/stream/${parsed.folderId}/${parsed.messageId}?token=${encodeURIComponent(parsed.token)}`;

    // ── PROACTIVE PREBUFFER DISABLED for TS files ──
    // The PROACTIVE prebuffer downloads the ENTIRE file to disk on every
    // playback. For non-premium Telegram accounts, this causes FLOOD_PREMIUM_WAIT
    // (Telegram speed-throttles non-premium accounts after tens of GB downloaded).
    //
    // /stream already handles on-demand downloads from Telegram — it downloads
    // chunks as mpegts.js requests them, writes to cache, and serves from cache
    // on subsequent requests. The cache naturally grows as the player advances.
    // This is exactly how MP4 files work, and they never hit FLOOD_PREMIUM_WAIT.
    //
    // The PROACTIVE prebuffer is kept for MP4 files (where it's useful for
    // seeking to uncached positions without a Telegram download). For TS,
    // mpegts.js's lazyLoad (180s ahead, 60s behind) provides sufficient buffering.
    const knownFilesize = state.current.fileLength > 0 ? state.current.fileLength : undefined;
    const estimatedDurationS = knownFilesize ? (knownFilesize / 4_000_000) * 8 : 0;
    if (knownFilesize && parseInt(parsed.messageId) > 0) {
      // PROACTIVE prebuffer disabled for TS — see comment above.
      // Only /stream downloads data, exactly like MP4 files.
    }

    // Get known duration. For TS files, Telegram doesn't provide video duration
    // in the document attributes, so file?.duration is typically undefined.
    // Previously we awaited /fmp4/metadata (~9s) before creating the player.
    // Now: create the player IMMEDIATELY with estimated duration, then update
    // when /fmp4/metadata returns. This lets mpegts.js start buffering data
    // while the metadata endpoint is still downloading the tail for PTS.
    let knownDuration: number | undefined = file?.duration ? file.duration : undefined;

    // MP4-HEVC reroute: the moov atom already gave the EXACT duration
    // (state.current.duration, set in onMP4BoxReady BEFORE the codec check
    // failed and rerouted here). Use it instead of the 4Mbps estimate — it
    // also suppresses the /fmp4/metadata retry loop below (log 1-c: player
    // created with 2926.0s estimate while moov said 6267.712s, UI flashed
    // 6267 → 2926 → 6267).
    const durationFromMoov = reroutedToRemuxRef.current && state.current.duration > 0;
    if (!knownDuration && durationFromMoov) {
      knownDuration = state.current.duration;
      (window as any).__nobuf_ptsDuration = knownDuration;
      (window as any).__nobuf_durationIsEstimate = false;
      diagLog(`[MPEGTS] Using exact moov duration: ${knownDuration.toFixed(3)}s (MP4 reroute — skipping 4Mbps estimate)`);
    }

    // Estimate duration from bitrate+filesize so the player can start immediately.
    // ~4Mbps is typical for Telegram video. This estimate is close enough for
    // lazyLoadMaxDuration and seek bar. The real duration from /fmp4/metadata
    // will overwrite this within a few seconds.
    if (!knownDuration && knownFilesize && knownFilesize > 0) {
      const ESTIMATED_BITRATE = 4_000_000; // 4 Mbps
      const fileSize = knownFilesize; // capture for type safety
      knownDuration = fileSize * 8 / ESTIMATED_BITRATE;
      diagLog(`[MPEGTS] Estimated duration: ${knownDuration.toFixed(1)}s (from filesize ${fileSize} / 4Mbps)`);
    }

    // Create player IMMEDIATELY — don't wait for /fmp4/metadata
    diagLog(`[MPEGTS] Creating player: url=${streamUrl}, duration=${knownDuration}s, filesize=${knownFilesize}`);

    const player = MpegtsPlayer.createPlayer({
      type: 'mpegts',
      isLive: false,
      url: streamUrl,
      duration: knownDuration,
      filesize: knownFilesize,
      hasAudio: true,
      hasVideo: true,
      cors: true,
    }, {
      enableWorker: false,           // Workers may not work in Tauri WebView2
      enableStashBuffer: true,       // Buffer for smooth playback
      stashInitialSize: 2048 * 1024, // 2MB initial stash — faster ramp-up for VOD startup
      fixAudioTimestampGap: false,   // CRITICAL: disable PTS gap "fixing" for TS files with
                                      // timed_id3 metadata. mpegts.js miscounts AAC frames when
                                      // the audio PTS has a fixed offset from its frame counter,
                                      // inserting silence that causes cumulative drift →
                                      // PIPELINE_ERROR_DECODE after ~100 PES packets.
      lazyLoad: true,                // ENABLED: let mpegts.js native timeupdate listener auto-resume.
                                      // Fixed 180s ahead target (not scaled by playbackRate).
                                      // SourceBuffer behind-window cleanup is handled by autoCleanupSourceBuffer.
      lazyLoadMaxDuration: 180,      // 180s ahead, fixed media time.
      lazyLoadRecoverDuration: 120,  // Resume when buffer drops to 120s ahead (60s safety margin).
      seekType: 'range',             // Use HTTP Range for seeking (our server supports it)
      autoCleanupSourceBuffer: true,  // Let mpegts.js native cleanup handle the behind-window
      autoCleanupMaxBackwardDuration: 60,
      autoCleanupMinBackwardDuration: 30,
      accurateSeek: false,           // Let mpegts.js seek to nearest keyframe for speed
      customLoader: ChunkedFetchLoader,
      shadowCache: shadowCacheRef.current,
      firstChunkSize: alignChunkSize(5 * 1024 * 1024),
      chunkSize: alignChunkSize(10 * 1024 * 1024),
      postSeekFirstChunkSize: alignChunkSize(12 * 1024 * 1024),
    });


    mpegtsPlayerRef.current = player;
    // Reset fatal abort flag and failed flag for the new player instance
    (window as any).__nobuf_mpegtsFatalAbort = false;
    mpegtsFailedRef.current = false;

    // ── Shadow cache: JS-side byte cache for instant seeks ──
    // Caches raw TS bytes in JS memory (no SourceBuffer quota limit).
    // When mpegts.js seeks back to already-fetched positions, the fetch
    // interceptor serves bytes from memory — 0ms HTTP round-trip.
    // urlKey MUST match the URL mpegts.js actually fetches:
    //  - remux tiers (timed_id3 / MKV-HEVC / MP4-HEVC reroute): the calling
    //    branch already reset the cache to the /remux pathname with
    //    fileLength=0 (remux output length is unknown — the interceptor
    //    stays inert). Do NOT stomp it here with a /stream key + the
    //    SOURCE file's length (log 1-c:42: urlKey=/stream/null/84 while
    //    the player fetched /remux/home/84).
    //  - plain TS: key on parsed.folderId — activeFolderId is null for
    //    named folders ("home"), which built "/stream/null/84" and silently
    //    disabled the cache for every named-folder TS play.
    const isRemuxSource = new URL(streamUrl).pathname.startsWith('/remux/');
    if (!shadowCacheRef.current) {
      shadowCacheRef.current = new StreamShadowCache(300 * 1024 * 1024); // 300MB budget
    }
    const fileLen = state.current.fileLength || knownFilesize || 0;
    if (!isRemuxSource) {
      const urlKey = `/stream/${parsed.folderId}/${parsed.messageId}`;
      shadowCacheRef.current.reset(urlKey, fileLen);
      diagLog(`[MPEGTS] Shadow cache initialized: urlKey=${urlKey}, fileLength=${fileLen}`);
    } else {
      diagLog(`[MPEGTS] Shadow cache: keeping remux key ${shadowCacheRef.current.urlKey} (interceptor inert — remux length unknown)`);
    }

    // Seed byteToTimeTableRef with baseline anchors (0,0) and (fileLength, duration)
    // so byteToTime() uses monotonic interpolation instead of raw linear mapping.
    // This prevents the green bar from rendering /stream's ranges at the wrong
    // position on the first seek (before VBR-corrected keyframes populate the table).
    // For TS files, the table is empty until VBR corrections add entries.
    if (fileLen > 0 && state.current.duration > 0 && byteToTimeTableRef.current.length === 0) {
      byteToTimeTableRef.current = [
        [0, 0],
        [fileLen, state.current.duration],
      ];
    }

    try {
      // Attach to the video element — mpegts.js creates its own MediaSource
      player.attachMediaElement(video);

      // Event handlers
      // Cooldown for BUFFER_FULL log spam — only log once per 5 seconds
      // _lastBufferFullLog removed — no longer needed after ERROR handler simplification
      player.on(MpegtsPlayer.Events.ERROR, (errorType: string, errorDetail: string, _errorInfo: any) => {
        // BUFFER_FULL (MediaMSEError) is NOT fatal — mpegts.js handles it
        // by suspending the transmuxer. Our quota guard will evict backward
        // data and resume. Do NOT abort the loader — it breaks the internal
        // state and the fetch never restarts.
        if (errorDetail === 'MediaMSEError') {
          // CRITICAL: In WebView2, mse-controller.js error.code===22 FAILS
          // (error.code=0, error.name=undefined). The error falls to the ELSE
          // branch which emits MSEvents.ERROR instead of BUFFER_FULL.
          // Our BUFFER_FULL handler never fires. So we handle it HERE.
          diagLog(`[MPEGTS] MediaMSEError: _errorInfo=${JSON.stringify(_errorInfo)} (code=${_errorInfo?.code}, name=${_errorInfo?.name})`);

          // Re-entry guard: if we already detected a fatal error, don't process again.
          // mpegts.js keeps emitting ERROR events as buffered data tries to appendBuffer.
          // Without this guard, we'd schedule 6+ setTimeout destroys.
          if (mpegtsFailedRef.current) {
            return;
          }

          // Check if video.error is already set — if so, this is a FATAL decode
          // error, NOT a SourceBuffer quota issue. appendBuffer fails because
          // the media element is in an error state. Recovery is impossible.
          if (video.error) {
            diagLog(`[MPEGTS] FATAL: video.error is set (code=${video.error.code}), aborting — not a quota issue`);
            (window as any).__nobuf_bufferFullDetected = false;
            mpegtsFailedRef.current = true;
            mpegtsPlayerRef.current = null;

            // Hard-stop the chunk loader: set a global flag that _fetchRange checks
            // before each _onDataArrival call. This stops the data flow immediately.
            (window as any).__nobuf_mpegtsFatalAbort = true;

            // Abort the chunk loader's current fetch to stop new data from arriving.
            try {
              const engine = (player as any)?._player_engine;
              const ioctl = engine?._transmuxer?._controller?._ioctl;
              if (ioctl) {
                ioctl._requestAbort = true;
                if (ioctl._abortController) {
                  ioctl._abortController.abort();
                }
              }
            } catch (_) {}

            // Destroy asynchronously on the next tick — not synchronously here.
            // mpegts.js has pending Promise chains in transmuxer.js that fire
            // after the current event handler returns. If we destroy now, those
            // promises access null player/engine/transmuxer objects and crash
            // with "Cannot read properties of null (reading 'emit')".
            // setTimeout(0) lets the current Promise chain drain before we destroy.
            setTimeout(() => {
              try {
                player.detachMediaElement();
                player.unload();
                player.destroy();
              } catch (_) {}
              (window as any).__nobuf_mpegtsFatalAbort = false;
              diagLog('[MPEGTS] FATAL cleanup complete — player destroyed');

              // Fall back to /remux/ (ffmpeg TS→MP4) since mpegts.js can't handle
              // this file (e.g., AAC-LATM/LOAS parser bugs produce corrupted audio).
              // The /remux/ endpoint uses ffmpeg which handles all audio formats correctly.
              const video2 = videoRef.current;
              if (video2) {
                try {
                  video2.src = '';
                  video2.removeAttribute('src');
                  video2.load();
                } catch (_) {}
              }
              // Defence-in-depth: prefer the live streamUrlRef over the
              // closure-captured `parsed` if the user has switched files since
              // this FATAL handler was registered. Falls back to `parsed` if
              // streamUrlRef is somehow null or unparseable.
              const liveUrl = streamUrlRef.current;
              const liveParsed = liveUrl ? parseStreamUrl(liveUrl) : null;
              const useParsed = liveParsed ?? parsed;
              const remuxUrl = `${useParsed.baseUrl}/remux/${useParsed.folderId}/${useParsed.messageId}?token=${encodeURIComponent(useParsed.token)}`;
              if (liveParsed && liveParsed.messageId !== parsed.messageId) {
                diagLog(`[MPEGTS] FATAL: file switched mid-handler — using live URL (msg ${liveParsed.messageId}, not stale msg ${parsed.messageId})`);
              }
              diagLog(`[MPEGTS] FATAL: falling back to ffmpeg remux: ${remuxUrl}`);
              remuxUrlRef.current = remuxUrl;
              setUseNative(true);
            }, 0);
            return;
          }

          // Set our flag — the quota guard (100ms tick) will detect it,
          // evict, and resume. Do NOT schedule separate eviction here.
          (window as any).__nobuf_bufferFullDetected = true;
          // Suspend the transmuxer to stop new appends while we evict.
          // The quota guard will call resumeTransmuxer after eviction.
          const engine2 = (player as any)?._player_engine;
          const lc2 = engine2?._loading_controller;
          if (lc2 && !lc2._paused) {
            lc2.suspendTransmuxer();
            diagLog('[MPEGTS] SourceBuffer full — suspended, quota guard will evict and resume');
          } else {
            diagLog('[MPEGTS] SourceBuffer full — already suspended, quota guard will evict and resume');
          }
          return; // Don't destroy — this is recoverable
        }
        diagLog(`[MPEGTS] Error: type=${errorType}, detail=${errorDetail}`);
        // Codec unsupported or other media errors ARE fatal — fall back
        if (errorDetail === 'CodecUnsupported') {
          diagLog('[MPEGTS] Codec unsupported — detaching and falling back');
          try {
            player.detachMediaElement();
            player.unload();
            player.destroy();
          } catch (_) {}
          mpegtsPlayerRef.current = null;
          mpegtsFailedRef.current = true;
        }
      });

      player.on(MpegtsPlayer.Events.LOADING_COMPLETE, () => {
        diagLog('[MPEGTS] Loading complete — entire file loaded');
      });

      player.on(MpegtsPlayer.Events.STATISTICS_INFO, (stats: any) => {
        // Log speed info periodically (only every 10th event to avoid spam)
        if (stats.decodedFrames && stats.decodedFrames % 300 === 0) {
          diagLog(`[MPEGTS] Stats: speed=${stats.speed?.toFixed(1)}x, decoded=${stats.decodedFrames}`);
        }

        // (Speed tracking removed — the meter now reads the backend's
        // session_downloaded_bytes counter via cmd_get_cache_status, which
        // measures real Telegram arrivals instead of this proxy of ffmpeg's
        // remuxed output bytes. See lib/faststream/speedMeter.ts.)

        // ── Track downloaded byte ranges (green buffer bar) ──
        // mpegts.js fetches data internally via FetchStreamLoader — the front-end
        // never sees the raw HTTP responses. But we can read the IOController's
        // internal _currentRange to track what's been fetched.
        // _currentRange is {from, to} where 'from' is the start of the current
        // fetch range and 'to' is the furthest byte received so far in this range.
        try {
          const ioctl = (player as any)?._player_engine?._transmuxer?._controller?._ioctl;
          if (ioctl?._currentRange && ioctl._currentRange.to >= 0) {
            const from = ioctl._currentRange.from;
            const to = ioctl._currentRange.to;
            // Track in front-end for green bar rendering
            trackDownloadedRange(from, to);
          }
        } catch { /* ignore — internal property access may break across versions */ }
      });

      // Mark that MSE pipeline is initialized (prevents MSE timeout)
      transmuxerInitInProgressRef.current = true;

      // Start fetching data. FastStreamPlayer sets v.autoplay and can call
      // v.play() on loadedmetadata/canplay. mpegts.js will fire MEDIA_INFO once
      // it has parsed the PAT/PMT, and playback starts immediately after that.
      player.load();
      diagLog('[MPEGTS] Player loaded, playback starts at MEDIA_INFO');
      // ── Fetch ACTUAL duration from /fmp4/metadata ──
      // The player was created with an estimated duration. Now fetch the
      // real PTS-based duration from the backend (which downloads the file's
      // tail to extract final PTS). This takes ~9s but runs concurrently —
      // the player is already buffering and playing with the estimate.
      // When the real duration arrives, we update mediaSource.duration.
      // With Semaphore(1), the tail download naturally alternates with
      // /stream and PROACTIVE — no FLOOD_PREMIUM_WAIT, no defer needed.
      // Skip when the moov atom already provided the exact duration (MP4
      // reroute) — the estimate/probe dance is pointless and its "estimate →
      // probed" updates would overwrite the exact value with ffprobe's less
      // precise one, flashing the seek bar.
      if (!file?.duration && !durationFromMoov) {
        const metaUrl = `${parsed.baseUrl}/fmp4/metadata/${parsed.folderId}/${parsed.messageId}?token=${parsed.token}&file_size=${state.current.fileLength}`;
        // The backend derives duration from the /remux ffprobe pass, which finishes
        // ~2s AFTER this first fetch — so the first response is often a bitrate
        // ESTIMATE (meta.duration_is_estimate=true). For HEVC MKV that estimate is
        // wrong (e.g. 1904s vs real 2317s) and truncates the seek bar. Retry a few
        // times (backing off) until the probe lands and we get the exact duration.
        const fetchMetaOnce = async (): Promise<{ dur: number; isEstimate: boolean } | null> => {
          const metaResp = await fetch(metaUrl);
          if (!metaResp.ok) return null;
          const meta = await metaResp.json();
          const dur = meta.duration_s || meta.duration;
          if (!dur || dur <= 0) return null;
          return { dur, isEstimate: meta.duration_is_estimate === true };
        };
        (async () => {
          let metaDur = 0;
          // Up to 6 attempts over ~12s: prefer the probed (non-estimate) value.
          for (let attempt = 0; attempt < 6; attempt++) {
            let res: { dur: number; isEstimate: boolean } | null = null;
            try { res = await fetchMetaOnce(); } catch { /* transient — retry */ }
            if (res) {
              metaDur = res.dur;
              if (!res.isEstimate) break; // exact ffprobe duration — done
              diagLog(`[MPEGTS] metadata duration ${res.dur.toFixed(1)}s is an estimate — retrying for probed value (attempt ${attempt + 1})`);
            }
            await new Promise((r) => setTimeout(r, 2000));
          }
          try {
            if (metaDur && metaDur > 0) {
              diagLog(`[MPEGTS] Got real duration from metadata: ${metaDur.toFixed(1)}s — updating (was estimated ${knownDuration?.toFixed(1)}s)`);
              (window as any).__nobuf_ptsDuration = metaDur;
              (window as any).__nobuf_durationIsEstimate = false; // real PTS available, no longer an estimate

              // Re-seed byteToTimeTableRef with the real duration now that it's known.
              // The initial seed at shadow cache init used state.current.duration
              // which may have been 0 (not yet known). Update with real values.
              const fl = state.current.fileLength;
              if (fl > 0 && metaDur > 0) {
                // Only re-seed if table is still just the baseline (2 entries)
                // or empty — don't overwrite VBR-corrected keyframe entries.
                const table = byteToTimeTableRef.current;
                if (table.length <= 2) {
                  byteToTimeTableRef.current = [
                    [0, 0],
                    [fl, metaDur],
                  ];
                }
              }

              // Update mediaSource.duration to the real PTS-based value
              const engine = (player as any)?._player_engine;
              const mseCtrl = engine?._mse_controller;
              const ms = mseCtrl?.getObject?.();
              if (ms && ms.readyState === 'open') {
                const trySetDuration = () => {
                  try {
                    const oldDur = ms.duration;
                    ms.duration = metaDur;
                    diagLog(`[MPEGTS] Updated mediaSource.duration: ${oldDur} → ${metaDur}s (from PTS)`);
                    return true;
                  } catch (e: any) {
                    diagLog(`[MPEGTS] Could not update duration: ${e.message}`);
                    return false;
                  }
                };
                if (!trySetDuration()) {
                  const sbVideo = ms.sourceBuffers?.[0];
                  if (sbVideo) sbVideo.addEventListener('updateend', () => setTimeout(trySetDuration, 100), { once: true });
                }
              }

              // Update all duration refs so the UI shows the correct value
              state.current.duration = metaDur;
              mpegtsDurationRef.current = metaDur;
              knownDuration = metaDur;

              // THUMBNAIL PIPELINE DURATION FIX. The fMP4 thumbnail config
              // (fmp4ConfigRef) is built at MEDIA_INFO time with `duration:
              // knownDuration || estimatedDurationS` — at that moment the real PTS
              // duration is NOT yet known, so it bakes in the 4Mbps ESTIMATE
              // (e.g. 2627.9s vs the real 2073.1s). Every hover then computes its
              // byte offset as `time/duration*fileSize`, landing ~21% too far into
              // the file, so the preview shows a frame 170-280s AWAY from the hover
              // point (proven logs 12-c: hover 799s → thumbnail 633s). Correct the
              // config ref here so any pipeline (re)created later is accurate; the
              // ALREADY-running pipeline is corrected via the durationchange
              // listener in useThumbnailExtractor.ts (it reads video.duration, which
              // we just updated on the mediaSource above).
              if (fmp4ConfigRef.current) {
                fmp4ConfigRef.current.duration = metaDur;
              }

              // PROACTIVE prebuffer disabled for TS — it downloads the entire
              // file and causes FLOOD_PREMIUM_WAIT on non-premium accounts.
              // /stream alone handles on-demand downloads like MP4 files.
            }
          } catch (_e: any) { /* parse error — keep estimated duration */ }
        })().catch((_e: any) => {
          diagLog(`[MPEGTS] Metadata fetch failed (using estimate): ${_e.message}`);
        });
      }

      // Wait for mpegts.js to identify the media streams (codec, duration).
      // NOTE: MpegtsPlayer.Events.METADATA_PARSED does NOT exist in mpegts.js
      // (it's undefined). The only reliable init signal is MEDIA_INFO, which
      // fires when TSDemuxer has parsed PAT+PMT and identified video/audio
      // codecs. For TS files with stream_type=0x15 (AAC-LATM), the backend
      // must rewrite stream_type 0x15→0x0F in PMT packets, otherwise mpegts.js
      // maps 0x15 to kMetadata (ID3), drops audio PES, and MEDIA_INFO never fires.
      let mediaInfo: any = null;
      await new Promise<void>((resolve, reject) => {
        // 60s timeout: for /remux URLs (timed_id3 files), the backend must
        // download the full file + ffprobe + start ffmpeg before producing
        // the first TS packet. Large files (1.3GB+) can take 30+ seconds.
        // The outer MSE init timeout extends up to 120s; this inner timeout
        // must be long enough to not fire before the remux pipeline starts.
        const timeout = setTimeout(() => {
          reject(new Error('mpegts.js initialization timeout (60s)'));
        }, 60000);

        player.on(MpegtsPlayer.Events.MEDIA_INFO, (info: any) => {
          clearTimeout(timeout);
          mediaInfo = info;
          diagLog(`[MPEGTS] Media info: duration=${info.duration}s, codec=${info.videoCodec},${info.audioCodec}`);
          resolve();
        });
      });

      // Activate the fMP4 thumbnail pipeline for TS files.
      // The Fmp4ThumbnailPipeline uses backend /fmp4/init + /fmp4/segment
      // endpoints for thumbnail extraction — no second mpegts.js player,
      // no /stream rate limiter competition. The backend handles TS demuxing
      // and keyframe alignment server-side.
      // Activate the thumbnail pipeline. Two mutually-exclusive routes:
      //  - TS (native / timed_id3): backend fMP4 pipeline (/fmp4/init + /segment).
      //    The backend demuxes TS server-side — no second mpegts.js, no /stream
      //    rate-limiter competition.
      //  - MKV-via-/remux: the backend fMP4 demuxer CANNOT parse Matroska
      //    (/fmp4/init 500s), so instead use the client-side
      //    TransmuxerThumbnailPipeline, which reads the raw /stream MKV directly
      //    via mediabunny + WebCodecs (independent of the mpegts.js player).
      //    It is triggered by isTransmuxerActive (see useThumbnailExtractor.ts).
      if (mediaInfo && mediaInfo.videoCodec) {
        if (formatRef.current === 'mkv') {
          diagLog('[MPEGTS] MKV — activating client-side transmuxer thumbnail pipeline (mediabunny)');
          setIsTransmuxerActive(true);
          setThumbnailDataReady(true);
        } else if (reroutedToRemuxRef.current) {
          // MP4-HEVC reroute: the /fmp4 thumbnail endpoints parse the /stream
          // cache as MPEG-TS, but this file's cache is ISOBMFF → guaranteed
          // 500 ("Failed to extract stream info", log 1-t:145). And hover
          // thumbnails would need WebCodecs HEVC decode, which stock WebView2
          // lacks — same reason we rerouted. Instead, use the backend /thumb
          // endpoint: ffmpeg decodes ONE frame server-side (`-ss t` over the
          // Range-seekable /stream input — works on unbuffered regions, exact
          // frame, VBR-proof) and returns a JPEG. See remux_hover_thumb.
          remuxThumbConfigRef.current = {
            baseUrl: parsed.baseUrl,
            folderId: parsed.folderId,
            messageId: parsed.messageId,
            token: parsed.token,
            duration: knownDuration || estimatedDurationS,
          };
          diagLog('[MPEGTS] MP4 reroute — server-side /thumb hover thumbnails activated');
          setThumbnailDataReady(true);
        } else {
          fmp4ConfigRef.current = {
            baseUrl: `${parsed.baseUrl}/fmp4`,
            folderId: parsed.folderId,
            messageId: parsed.messageId,
            queryParams: `token=${encodeURIComponent(parsed.token)}`,
            mimeType: `video/mp4; codecs="${mediaInfo.videoCodec},${mediaInfo.audioCodec}"`,
            duration: knownDuration || estimatedDurationS,
            fileSize: knownFilesize || 0,
          };
          fmp4PipelineActiveRef.current = true;
          diagLog('[MPEGTS] fMP4 thumbnail pipeline activated');
          // Signal that thumbnail pipeline data is ready for TS files.
          // For MP4, this is set in the mp4box.js onReady callback. For TS,
          // the fMP4 backend pipeline doesn't need moov/firstChunk — it fetches
          // init segments from the backend. Setting this here triggers the
          // Fmp4ThumbnailPipeline effect in useThumbnailExtractor.ts.
          setThumbnailDataReady(true);
        }
      }

      // Start playback as soon as mpegts.js has identified the media streams AND
      // the first 5MB is in the shadow cache (or the cold-start timeout fired).
      // The overlay is hidden exactly when playback begins.

      // Safety net: pause the video immediately after MEDIA_INFO to prevent
      // any auto-play (browser autoplay, StartupStallJumper, or mpegts.js
      // internals) from starting playback before the cold-start gate resolves.
      // player.play() below is the sole entry point for playback start.
      if (!video.paused) {
        video.pause();
        diagLog('[MPEGTS] Paused video after MEDIA_INFO — waiting for cold-start gate');
      }

      const coldStartDeferred = coldStartDeferredRef.current;
      if (coldStartDeferred) {
        // For buffering phase the progress poller already resolved;
        // for initializing_player (remux), MEDIA_INFO IS the ready signal.
        coldStartDeferred.resolve();
        await coldStartDeferred.promise;
        setIsColdStartBuffering(false);
        setColdStartPhase('none');
      }
      await player.play();

      // Override duration: mpegts.js reports Infinity for TS files because
      // TS has no global duration header. We must set mediaSource.duration
      // so the video bar works (seeking, progress, duration display).
      if (knownDuration && knownDuration > 0 && isFinite(knownDuration)) {
        // Access mpegts.js internal MSEController → MediaSource
        // Path: Player → _player_engine → _mse_controller → getObject()
        const engine = (player as any)?._player_engine;
        const mseCtrl = engine?._mse_controller;
        const ms = mseCtrl?.getObject?.();
        if (ms && ms.readyState === 'open') {
          // Must wait for SourceBuffers to finish updating before setting duration.
          // If updating=true, setting duration throws: "The 'updating' attribute is true"
          const trySetDuration = () => {
            try {
              const oldDur = ms.duration;
              ms.duration = knownDuration;
              diagLog(`[MPEGTS] Set mediaSource.duration: ${oldDur} → ${knownDuration}s`);
              return true;
            } catch (e: any) {
              diagLog(`[MPEGTS] Could not set mediaSource.duration: ${e.message}`);
              return false;
            }
          };
          // Try immediately
          if (!trySetDuration()) {
            // SourceBuffers still updating — retry after updateend
            const sbVideo = ms.sourceBuffers?.[0];
            const sbAudio = ms.sourceBuffers?.[1];
            const retryOnUpdateEnd = () => {
              setTimeout(() => trySetDuration(), 100);
            };
            if (sbVideo) sbVideo.addEventListener('updateend', retryOnUpdateEnd, { once: true });
            if (sbAudio) sbAudio.addEventListener('updateend', retryOnUpdateEnd, { once: true });
            diagLog(`[MPEGTS] Scheduled mediaSource.duration set after SourceBuffer updateend`);
          }
        } else {
          diagLog(`[MPEGTS] Could not access MediaSource (ms=${!!ms}, readyState=${ms?.readyState})`);
        }
        // Always update MSE state duration for the UI
        state.current.duration = knownDuration;
        mpegtsDurationRef.current = knownDuration;
        diagLog(`[MPEGTS] Duration override: video.duration=${video.duration}, known=${knownDuration}s`);
      }

      // ── Guard mediaSource.duration against DTS overflow ──
      // When data flows into the demuxer after a seek, mpegts.js's DTS
      // computation can produce garbage values (~2^32/1000 ≈ 4294967s). MSE then
      // sets mediaSource.duration to that value. We watch for this and override.
      const guardDuration = () => {
        const known = mpegtsDurationRef.current || state.current.duration;
        if (known > 0) {
          const ms = (video as any)._mediaSource || (player as any)?._player_engine?._mse_controller?.getObject?.();
          if (ms && ms.readyState === 'open') {
            // DTS overflow guard — nuclear recovery
            // When duration > known * 2, the SourceBuffer has corrupted timestamps.
            // Simply setting ms.duration fails (sbuf.updating=true) and MSE recalculates
            // from SB content on next append. The ONLY fix is to clear the corrupted data.
            if (video.duration > known * 2) {
              const oldDur = ms.duration;
              diagLog(`[MPEGTS] DTS OVERFLOW DETECTED: duration=${oldDur}s > 2*known=${known}s — NUCLEAR RECOVERY`);
              // Set nuclear-in-progress guard to prevent quota guard from
              // triggering eviction+resume cycles during this recovery
              (window as any).__nobuf_nuclearRecoveryInProgress = true;
              // Generation counter to invalidate restartAfterClear if the user
              // seeks while nuclear recovery is still pending SB updateend.
              const nuclearGen = ((window as any).__nobuf_nuclearGeneration = ((window as any).__nobuf_nuclearGeneration || 0) + 1);
              // 1. Suspend download to stop new appends
              const lcDts = (player as any)?._player_engine?._loading_controller;
              if (lcDts && !lcDts._paused) {
                try { lcDts.suspendTransmuxer(); } catch (_) {}
              }
              // 2. Abort + clear ALL SourceBuffers
              const sbs = ms.sourceBuffers;
              if (sbs && sbs.length > 0) {
                for (let i = 0; i < sbs.length; i++) {
                  const sb = sbs[i];
                  try {
                    if (sb.updating) sb.abort();  // cancel pending appendBuffer
                    if (sb.buffered.length > 0) {
                      sb.remove(0, sb.buffered.end(sb.buffered.length - 1));
                    }
                  } catch (e: any) {
                    diagLog(`[MPEGTS] DTS overflow SB clear failed: ${e.message}`);
                  }
                }
              }
              // NOTE: ms.duration is NOT set here — sb.remove() is async and
              // SourceBuffer.updating stays true until 'updateend' fires.
              // Setting ms.duration while updating=true throws InvalidStateError.
              // We set it inside restartAfterClear after waiting for updateend.
              // 3. Schedule restart from current playhead after SB clears
              const restartAfterClear = () => {
                // Guard: if user seeked during nuclear recovery, the generation
                // counter will have changed — don't resume from stale byte offset.
                if ((window as any).__nobuf_nuclearGeneration !== nuclearGen) {
                  diagLog(`[MPEGTS] DTS overflow recovery ABORTED — generation mismatch (nuclearGen=${nuclearGen}, current=${(window as any).__nobuf_nuclearGeneration}), user likely seeked`);
                  (window as any).__nobuf_nuclearRecoveryInProgress = false;
                  return;
                }
                // ── Set correct duration — but only when ALL SBs are done ──
                // We may have been called from the LAST SB's updateend, but other
                // SBs might still be updating. Must wait for ALL to finish.
                let allSbsDone = true;
                for (let i = 0; i < (ms.sourceBuffers?.length ?? 0); i++) {
                  const sb = ms.sourceBuffers![i] as SourceBuffer;
                  if (sb && sb.updating) { allSbsDone = false; break; }
                }
                if (!allSbsDone) {
                  diagLog('[MPEGTS] DTS overflow recovery: not all SBs done removing, waiting...');
                  // Re-attach listeners to any SB still updating
                  for (let i = 0; i < (ms.sourceBuffers?.length ?? 0); i++) {
                    const sb = ms.sourceBuffers![i];
                    if (sb && sb.updating) {
                      sb.addEventListener('updateend', () => {
                        // Check again when this SB finishes
                        let nowDone = true;
                        for (let j = 0; j < (ms.sourceBuffers?.length ?? 0); j++) {
                          if (ms.sourceBuffers![j] && (ms.sourceBuffers![j] as SourceBuffer).updating) {
                            nowDone = false;
                            break;
                          }
                        }
                        if (nowDone) {
                          try {
                            ms.duration = known;
                            diagLog(`[MPEGTS] DTS overflow recovery (deferred): ms.duration ${oldDur} → ${known}s`);
                          } catch (e: any) {
                            diagLog(`[MPEGTS] DTS overflow duration set failed (deferred): ${e.message}`);
                          }
                        }
                      }, { once: true });
                    }
                  }
                } else {
                  try {
                    ms.duration = known;
                    diagLog(`[MPEGTS] DTS overflow recovery: ms.duration ${oldDur} → ${known}s`);
                  } catch (e: any) {
                    diagLog(`[MPEGTS] DTS overflow duration set failed (after updateend): ${e.message}`);
                  }
                }
                // ── Remuxer reset for nuclear recovery ──
                // After nuclear recovery, ALL SourceBuffers are cleared and we resume
                // from a byte offset near currentTime.  We must NOT reset _dtsBaseInited
                // or the _dtsBase values: the existing _dtsBase (≈0 from initial playback)
                // maps rawDTS → outputDTS correctly so outputDTS ≈ rawDTS ≈ media time,
                // which is continuous with where the SourceBuffer needs data.  If we reset
                // _dtsBaseInited=false, the remuxer recalculates _dtsBase from the first
                // sample at the resumed byte position, producing outputDTS≈0 while the
                // video is at currentTime=104.6s → ahead≈−104.6s → permanent stall.
                // insertDiscontinuity() resets _videoNextDts/_audioNextDts and
                // _isInitialMetadataDispatched so the remuxer starts a new segment,
                // while preserving the existing _dtsBase for correct DTS mapping.
                const tController = (player as any)?._player_engine?._transmuxer?._controller;
                const remuxer = tController?._remuxer as any;
                if (remuxer) {
                  try {
                    // DO NOT call remuxer.seek() — it breaks the pipeline
                    // DO NOT reset _dtsBaseInited / _dtsBase — see comment above
                    remuxer.insertDiscontinuity?.();
                    // Clear stashed samples + segment info lists — same as remuxer.seek()
                    // but without destroying codec metadata (which seek() does)
                    // and without resetting _dtsBase (which would cause outputDTS≈0 stall).
                    remuxer._audioStashedLastSample = null;
                    remuxer._videoStashedLastSample = null;
                    remuxer._videoSegmentInfoList?.clear?.();
                    remuxer._audioSegmentInfoList?.clear?.();
                    diagLog('[MPEGTS] DTS overflow recovery: insertDiscontinuity (NO _dtsBase reset, NO seek)');
                  } catch (e: any) {
                    diagLog(`[MPEGTS] DTS overflow recovery remuxer reset failed: ${e.message}`);
                  }
                }
                // ── Demuxer reset (same as eviction resume) ──
                if (tController?._demuxer) {
                  const demuxer = tController._demuxer as any;
                  try {
                    if (demuxer.pes_slice_queues_) {
                      for (const pid of Object.keys(demuxer.pes_slice_queues_)) {
                        delete demuxer.pes_slice_queues_[pid];
                      }
                    }
                    if (demuxer.video_track_?.samples) demuxer.video_track_.samples = [];
                    if (demuxer.audio_track_?.samples) demuxer.audio_track_.samples = [];
                    demuxer.audio_last_sample_pts_ = undefined;
                    demuxer.aac_last_incomplete_data_ = null;
                    if ('loas_previous_frame' in demuxer) demuxer.loas_previous_frame = null;
                    if ('timestamp_offset_' in demuxer) demuxer.timestamp_offset_ = 0;
                    if ('last_pcr_base_' in demuxer) demuxer.last_pcr_base_ = -1;
                    diagLog('[MPEGTS] DTS overflow recovery: demuxer FULL RESET');
                  } catch (e: any) {
                    diagLog(`[MPEGTS] DTS overflow recovery demuxer reset failed: ${e.message}`);
                  }
                }
                const ioCtrlRestart = (player as any)?._player_engine?._transmuxer?._controller?._ioctl;
                if (ioCtrlRestart) {
                  const curTime = video.currentTime || 0;
                  const durForByte = mpegtsDurationRef.current || known || 1;
                  const fLenForByte = state.current.fileLength || 0;
                  if (durForByte > 0 && fLenForByte > 0) {
                    // Start 6s before currentTime to ensure audio overlap coverage
                    // (audio is interleaved 3-5s ahead of video in TS streams).
                    const safetyTime = Math.max(0, curTime - 6);
                    const rawRestartByte = Math.floor(((safetyTime / durForByte) * fLenForByte) / 188) * 188;
                    const restartByte = alignToTSSyncByte(rawRestartByte, shadowCacheRef.current);
                    ioCtrlRestart._resumeFrom = Math.max(0, restartByte);
                  }
                }
                // Clear flags and resume
                (window as any).__nobuf_bufferFullDetected = false;
                (window as any).__nobuf_nuclearRecoveryInProgress = false;
                // Set evictionResumePending so the patched resumeTransmuxer takes the
                // eviction path (insertDiscontinuity + demuxer reset). We already did
                // the resets directly above, but the patched resume will see the flag
                // and apply insertDiscontinuity again — idempotent and ensures consistency.
                (window as any).__nobuf_evictionResumePending = true;
                if (lcDts) {
                  try { lcDts.resumeTransmuxer(); } catch (_) {}
                }
              };
              // Wait for SB removal to complete
              const lastSb = sbs?.[sbs.length - 1];
              let safetyFired = false;
              const onClearDone = () => {
                if (safetyFired) return;  // guard against double-fire from safety timeout
                safetyFired = true;
                restartAfterClear();
              };
              if (lastSb) {
                lastSb.addEventListener('updateend', onClearDone, { once: true });
                // Safety timeout in case updateend never fires
                setTimeout(() => {
                  if (!safetyFired) {
                    safetyFired = true;
                    restartAfterClear();
                  }
                }, 1000);
              } else {
                restartAfterClear();
              }
              // Override video.duration display in the meantime
              (window as any).__nobuf_ptsDuration = known;
              (window as any).__nobuf_durationIsEstimate = false; // real duration from recovery
              return;  // don't process shrink guard during recovery
            }
            // ── Duration shrink guard ──
            // After resumeTransmuxer patch (seek + insertDiscontinuity), mpegts.js's
            // MSEController recalculates mediaSource.duration based on current buffer
            // content only. E.g., buffer has 0-153s → duration becomes 153s instead
            // of the real 2627s. Force it back to the known metadata duration.
            if (video.duration < known && isFinite(video.duration) && video.duration > 0) {
              const oldDur = ms.duration;
              try {
                ms.duration = known;
                diagLog(`[MPEGTS] Duration shrink guard: mediaSource.duration ${oldDur} → ${known}s (video.duration was ${video.duration})`);
              } catch (e: any) {
                // SourceBuffer updating — retry after updateend
                const sbVideo = ms.sourceBuffers?.[0];
                if (sbVideo && sbVideo.updating) {
                  const retry = () => {
                    try { ms.duration = known; diagLog(`[MPEGTS] Duration shrink guard (retry): ${oldDur} → ${known}s`); } catch (_) {}
                  };
                  sbVideo.addEventListener('updateend', retry, { once: true });
                }
              }
            }
          }
        }
      };
      video.addEventListener('durationchange', guardDuration);

      // Mark pipeline as fully initialized
      state.current.initialized = true;
      transmuxerInitInProgressRef.current = false;
      diagLog('[MPEGTS] Pipeline initialized successfully');

      // ── Patch IOController._onLoaderError to handle Early-EOF ──
      // When Early-EOF occurs (server closed connection or fetch was aborted),
      // the remuxer still holds stale _nextDts. Without calling insertDiscontinuity(),
      // _nextDts retains its old value, dtsCorrection is wrong, and output timestamps
      // explode to ~4.3M seconds. Fix: ALWAYS call insertDiscontinuity() on Early-EOF
      // to reset _nextDts, then also reset demuxer stale state.
      const ioCtrlInit = (player as any)?._player_engine?._transmuxer?._controller?._ioctl;
      if (ioCtrlInit && ioCtrlInit._onLoaderError) {
        const origLoaderError = ioCtrlInit._onLoaderError.bind(ioCtrlInit);
        ioCtrlInit._onLoaderError = function(type: number, data: any) {
          if (type === 1) {  // EARLY_EOF = 1
            // Early-EOF: server closed connection or fetch was aborted.
            // ROOT FIX: Always call insertDiscontinuity() to tell the remuxer
            // there's a discontinuity. Without this, _nextDts retains its old value,
            // dtsCorrection is wrong, and output timestamps explode to ~4.3M seconds.
            const engine = (player as any)?._player_engine;
            const remuxer = engine?._transmuxer?._controller?._remuxer;
            if (remuxer?.insertDiscontinuity) {
              remuxer.insertDiscontinuity();
              diagLog('[MPEGTS] Early-EOF: called insertDiscontinuity() to prevent DTS corruption');
            }
            // Also reset demuxer stale state to prevent extrapolation from old position
            const demuxer = engine?._transmuxer?._controller?._demuxer as any;
            if (demuxer) {
              if (demuxer.audio_last_sample_pts_ !== undefined) {
                demuxer.audio_last_sample_pts_ = undefined;
              }
              if (demuxer.aac_last_incomplete_data_ != null) {
                demuxer.aac_last_incomplete_data_ = null;
              }
            }
          }
          origLoaderError(type, data);
        };
      }

      // ── SourceBuffer config — 180s ahead / 60s behind memory window ──
      // User's architecture: 180s ahead / 60s behind playhead.
      // Playback speed does NOT change this.
      // Disk cache holds the rest. SourceBuffer eviction handles quota.
      const adjustBufferForSpeed = () => {
        const lc = (player as any)?._player_engine?._loading_controller;
        if (lc?._config) {
          // Fixed 180s ahead / 120s recover. Playback speed does NOT change this window.
          lc._config.lazyLoad = true;
          lc._config.lazyLoadMaxDuration = 180;
          lc._config.lazyLoadRecoverDuration = 120;
          // Keep native SourceBuffer cleanup enabled so the behind-window is evicted automatically.
          lc._config.autoCleanupSourceBuffer = true;
          lc._config.autoCleanupMaxBackwardDuration = 60;
          lc._config.autoCleanupMinBackwardDuration = 30;

          diagLog(`[MPEGTS] Buffer window: 180s ahead, 60s behind, lazyLoad=ON (maxDuration=180, recoverDuration=120, rate=${video.playbackRate || 1}x, autoCleanupSourceBuffer=ON)`);
        }
      };
      adjustBufferForSpeed(); // set initial values


      // ── Shadow cache trim: keep a sliding window of raw bytes around the playhead ──
      // The 300MB absolute limit is also enforced by the cache's own evict().
      let lastTrimByte = -1;
      const trimShadowCache = () => {
        const cache = shadowCacheRef.current;
        if (!cache || cache.fileLength === 0) return;
        const curTime = video.currentTime || 0;
        const dur = mpegtsDurationRef.current || state.current.duration || 1;
        // Estimate byte position from time (linear interpolation)
        const curByte = Math.round((curTime / dur) * cache.fileLength);
        // Only trim when playhead moved >5MB since last trim (was 10MB — too slow)
        if (Math.abs(curByte - lastTrimByte) < 5 * 1024 * 1024) return;
        lastTrimByte = curByte;
        // ±150MB window (≈5 min ahead + 5 min behind at 4Mbps).
        // The cache's 300MB budget means we only need to keep ~150MB ahead
        // and the trim will free far-behind data proactively before the
        // cache fills up and blocks new downloads.
        const windowBytes = 150 * 1024 * 1024; // ±150MB
        cache.trimAround(curByte, windowBytes);
      };
      trimShadowCacheHandlerRef.current = trimShadowCache;
      video.addEventListener('timeupdate', trimShadowCache);

      // ── Native lazy-load + autoCleanupSourceBuffer ──
      // The custom loader handles chunking, so we just let mpegts.js manage
      // pause/resume via lazyLoad and SourceBuffer cleanup via autoCleanup.
      diagLog('[MPEGTS] Pipeline initialized: custom chunk loader, lazyLoad max=180s recover=120s, autoCleanup behind=60s');

      // Start periodic position reporting for proactive prebuffer (TS files).
      // Reports every 10s so the backend prebuffer slides its window ahead
      // of the playhead. is_player_downloading is set based on whether the
      // IOController is actively fetching (buffer not full).
      const _fileIdForProactive = file?.id;
      const _folderIdForProactive = activeFolderId; // null = "home" (Saved Messages) — backend accepts Option
      const _fileSizeForProactive = state.current.fileLength;
      if (_fileIdForProactive && _fileSizeForProactive && !isPausedRef.current) {
        proactivePrebufferMsgIdRef.current = _fileIdForProactive;
        const proactiveInterval = setInterval(async () => {
          const v = videoRef.current;
          if (!v || v.paused || v.ended) return;
          // Remux transient guard (see shouldSkipRemuxPositionReport): skip only the
          // recreation / pre-first-frame window where a report would stomp the proactive
          // target to byte 0. Normal remux playback still reports so prebuffer keeps running.
          if (shouldSkipRemuxPositionReport(
                needsRemuxSeekRef.current, (window as any).__nobuf_userSeekInProgress === true, v.currentTime)) return;
          const eng = (mpegtsPlayerRef.current as any)?._player_engine;
          // is_player_downloading: true when IOController is actively fetching
          // (buffer not full, player needs more data). This tells the prebuffer
          // to yield so /stream gets 100% of the rate limiter budget.
          const ioctl = eng?._ioctl;
          const isDownloading = ioctl ? !ioctl.paused : false;
          try {
            await invoke('cmd_report_playback_position', {
              messageId: _fileIdForProactive,
              folderId: _folderIdForProactive,
              currentTimeS: v.currentTime,
              durationS: mpegtsDurationRef.current || v.duration || 0,
              fileSize: _fileSizeForProactive,
              isPlayerDownloading: isDownloading,
              playbackRate: v.playbackRate || 1.0,
              byteOffset: null, // periodic reports use linear estimate
            });
          } catch { /* ignore */ }
        }, 10000); // 10s interval
        // Store interval ID for cleanup
        proactiveIntervalRef.current = proactiveInterval;
      }

      return true;

    } catch (e: any) {
      diagLog(`[MPEGTS] Init failed: ${e.message}`);
      try {
        player.detachMediaElement();
        player.unload();
        player.destroy();
      } catch (_) {}
      mpegtsPlayerRef.current = null;
      transmuxerInitInProgressRef.current = false;
      return false;
    }
  };

  /** Unbuffered seek for mpegts.js TS files.
   *  Since the FetchStreamLoader.abort() patch is now in place, IOController.seek()
   *  will properly kill the old fetch stream before starting a new one.
   *
   *  Steps:
   *  1. Flush SourceBuffers (remove all buffered ranges) — gives TSDemuxer clean slate
   *  2. Reset demuxer state (resetMediaInfo, timestampBase=0) — TSDemuxer starts fresh
   *  3. Reset remuxer (seek + insertDiscontinuity) — marks timestamp discontinuity
   *  4. Call IOController.seek(byteOffset) — aborts old fetch, opens new Range request
   *     from byte offset. RangeSeekHandler adds "Range: bytes=N-" header.
   *     Server responds with 206 + data from that offset.
   *  5. Set video.currentTime = target — video element seeks to the new position
   *
   *  TSDemuxer resync: After landing at byte offset N (likely mid-TS-packet),
   *  TSDemuxer._parse() scans forward for 0x47 sync byte at 188-byte intervals.
   *  Once it finds two consecutive 0x47 bytes at 188-byte offset, it locks on
   *  and starts parsing normally. This takes ~1-2 chunks of data.
   *
   *  Byte offset calculation: (timeSeconds / duration) * filesize
   *  This is approximate (CBR assumption), but TSDemuxer resync + nearest-keyframe
   *  decode makes it work well enough. The video will show the nearest keyframe
   *  after the target time.
   */
  const _mpegtsUnbufferedSeek = async (timeSeconds: number, duration: number, correctedByteOffset?: number, vbrDepth?: number) => {
    // Set the seek-in-progress flag IMMEDIATELY — before any await — so that
    // concurrent seekTo() calls see it as true and skip. Without this, the
    // SourceBuffer await below creates a window where the flag is still false,
    // allowing rapid seeks to bypass the guard and start overlapping
    // IOController.seek() calls that overwrite each other.
    mpegtsUnbufferedSeekGenerationRef.current = (mpegtsUnbufferedSeekGenerationRef.current || 0) + 1;
    const seekGen = mpegtsUnbufferedSeekGenerationRef.current;
    (window as any).__nobuf_userSeekInProgress = true;
    mpegtsLastExecutedSeekRef.current = timeSeconds;
    // Store the seek target so the UI can show the correct position
    // while waiting for buffer data (prevents progress bar flashing to 0%).
    (window as any).__nobuf_seekTargetTime = timeSeconds;
    // Refresh the seek-requested timestamp so it covers the entire seek
    // duration (execution + align poll). The finally block does NOT clear
    // this timestamp — it's cleared when the align poll completes.
    (window as any).__nobuf_seekRequestedAt = Date.now();

    // Clear cachedTimeRanges immediately to prevent flicker when suppression ends.
    // Without this, the old ranges flash for 1-2 frames before the new poll data arrives.
    setDownloadedTimeRanges([]);

    // Cancel independent prebuffer — seek changes the download position
    if (independentPrebufferRef.current.active && independentPrebufferRef.current.abortController) {
      diagLog('[INDEPENDENT-PREBUFFER] Cancelling seek prebuffer');
      independentPrebufferRef.current.abortController.abort();
      independentPrebufferRef.current.active = false;
      independentPrebufferRef.current.abortController = null;
    }

    // Guard: don't seek until the transmuxer pipeline (demuxer + remuxer) is ready.
    // Before MEDIA_INFO, the TSDemuxer/MP4Remuxer don't exist yet. Seeking during
    // this phase causes _onInitChunkArrival to call _demuxer.bindDataSource(null)
    // and our reset code to hit null._remuxer.insertDiscontinuity().
    if (transmuxerInitInProgressRef.current) {
      diagLog(`[MPEGTS] Seek to ${timeSeconds.toFixed(1)}s deferred — pipeline not initialized yet`);
      pendingSeekTargetRef.current = { time: timeSeconds, dur: duration };
      (window as any).__nobuf_userSeekInProgress = false;
      return;
    }

    // Serialize on any pending MSE remove/append. mpegts.js MSEController.flush()
    // calls sb.abort(), which throws if the SourceBuffer is running an asynchronous
    // remove() (e.g. from the quota guard). Skipping the flush leaves the old buffer
    // behind the seek point, which then collides with new data and causes the
    // "SourceBuffer full, cannot free space" QuotaExceededError seen in 69-c.md.
    const enginePre = (mpegtsPlayerRef.current as any)?._player_engine;
    const mseCtrl = enginePre?._mse_controller;
    const ms = mseCtrl?.getObject?.();
    const sbs = ms?.sourceBuffers;
    if (sbs && sbs.length > 0) {
      const waiters: Promise<void>[] = [];
      for (let i = 0; i < sbs.length; i++) {
        const sb = sbs[i];
        if (sb.updating) {
          waiters.push(new Promise<void>(resolve => {
            const onDone = () => {
              sb.removeEventListener('updateend', onDone);
              sb.removeEventListener('error', onDone);
              sb.removeEventListener('abort', onDone);
              resolve();
            };
            sb.addEventListener('updateend', onDone);
            sb.addEventListener('error', onDone);
            sb.addEventListener('abort', onDone);
          }));
        }
      }
      if (waiters.length > 0) {
        diagLog(`[MPEGTS] Unbuffered seek: waiting for ${waiters.length} SourceBuffer update(s) before flush`);
        await Promise.all(waiters.map(p => Promise.race([
          p,
          new Promise<void>(resolve => setTimeout(() => {
            diagLog('[MPEGTS] Unbuffered seek: SourceBuffer update wait timed out (500ms) — proceeding with flush');
            resolve();
          }, 500))])));
      }
    }

    // Generation/flag already set at the top of the function (before the
    // SourceBuffer await) so concurrent seekTo() calls are blocked during
    // the entire seek including the await.
    try {
    const video = videoRef.current;
    if (!video) {
      diagLog('[MPEGTS] Unbuffered seek: no video element');
      return;
    }

    // Clear downloaded ranges — after seek, the byte range tracking starts fresh
    clearDownloadedRanges();

    const filesize = state.current.fileLength || 0;
    if (filesize <= 0 || duration <= 0) {
      diagLog(`[MPEGTS] Cannot unbuffered seek — filesize=${filesize}, duration=${duration}`);
      return;
    }

    // ── REMUX-SEEK PATH (transcoded HEVC MKV etc.) ──
    // For sources served via /remux (ffmpeg transcode → MPEG-TS), the raw
    // /stream/ bytes are NOT TS (they're the Matroska container), so byte-
    // seeking /stream/ feeds garbage to the TS demuxer (`sync_byte != 0x47`).
    // Instead, ask ffmpeg to seek: recreate the player from /remux?ss=<time>.
    // ffmpeg's -ss is frame-accurate and emits absolute-PTS TS (verified: a
    // seek to 580s yields first video PTS ≈581.4s), which the recreate path's
    // _dtsBase=0 logic maps straight to video.currentTime. This skips ALL the
    // byte-offset machinery below (keyframe index, VBR align, linear estimate)
    // because none of it applies when ffmpeg owns the seek.
    if (shouldUseRemuxSeek(needsRemuxSeekRef.current, remuxSeekBaseUrlRef.current)) {
      // E4: clamp to the valid range. Leave headroom before EOF so ffmpeg has
      // frames to emit (a seek to exactly duration produces an empty stream).
      const clampedTime = clampSeekTime(timeSeconds, duration);

      // E3: if the target is already inside a buffered range, this is a cheap
      // in-buffer seek — just move currentTime, do NOT respawn ffmpeg. Respawn
      // is expensive (ffprobe + GPU decode init, ~1-3s) and pointless here.
      for (let i = 0; i < video.buffered.length; i++) {
        // 0.25s margin so we don't land in a gap right at a range edge.
        if (clampedTime >= video.buffered.start(i) + 0.25 &&
            clampedTime <= video.buffered.end(i) - 0.25) {
          diagLog(`[MPEGTS] Remux seek to ${clampedTime.toFixed(1)}s is in-buffer — moving currentTime, no ffmpeg respawn`);
          video.currentTime = clampedTime;
          (window as any).__nobuf_userSeekInProgress = false;
          return;
        }
      }

      diagLog(`[MPEGTS] Remux seek: recreating player from /remux?ss=${clampedTime.toFixed(3)} (ffmpeg-driven seek)`);
      _mpegtsRecreatePlayerForRemuxSeek(clampedTime, duration);
      return;
    }

    // TS packets are 188 bytes. The byte offset MUST be aligned to a 188-byte
    // boundary, otherwise TSDemuxer lands mid-packet and sees garbage instead
    // of 0x47 sync bytes (e.g. sync_byte=170/0xAA), causing a flood of
    // "sync_byte != 0x47" errors and playback failure.
    // We also step back ~10 packets (~1880 bytes) so TSDemuxer has room to
    // find PAT/PMT + the nearest keyframe before the target time.
    const TS_PACKET_SIZE = 188;
    let seekByteFromIndex = -1;
    let seekTime = timeSeconds;
    let seekKeyframeExact = false;

    // 1. Try the local keyframe index first (instant — populated from /fmp4/keyframes polling)
    //    Only use it if the index has enough entries to be meaningful. A sparse index
    //    with only 1-2 entries (e.g. from initial playback + tail scan) will return
    //    a keyframe far from the target, which byteOffsetAtOrBeforeTime already
    //    detects via its 30s gap threshold — but we also need to handle the case
    //    where the function returns a linear estimate (which is NOT a real keyframe
    //    and must not be treated as one).
    const localKfs = tsKeyframeIndexRef.current;
    if (localKfs.length >= 2) {
      const candidateByte = byteOffsetAtOrBeforeTime(localKfs, timeSeconds, duration, filesize);
      if (candidateByte >= 0) {
        // Find the actual keyframe entry for this byte — byteOffsetAtOrBeforeTime
        // may return a linear estimate (not a real keyframe) when the gap is >30s,
        // which won't match any entry in the array.
        const idx = localKfs.findIndex(k => k.byteOffset === candidateByte);
        if (idx >= 0) {
          seekTime = localKfs[idx].timestamp;
          if (Math.abs(timeSeconds - seekTime) <= 30) {
            seekByteFromIndex = candidateByte;
            seekKeyframeExact = true;
            diagLog(`[MPEGTS] Local keyframe index: ${timeSeconds.toFixed(1)}s -> ${seekTime.toFixed(1)}s, byte ${seekByteFromIndex}`);
          } else {
            diagLog(`[MPEGTS] Local keyframe too far (${seekTime.toFixed(1)}s vs target ${timeSeconds.toFixed(1)}s) — using linear estimate`);
          }
        }
      }
    }

    // 2. Fire backend keyframe fetch in the background (NON-BLOCKING)
    //    Delay by 5 seconds so the player's first /stream chunk download
    //    gets priority. Use debounce: clear previous timer, set new one.
    //    DON'T abort a running fetch — the backend needs 10-60s per search,
    //    and aborting before completion means the keyframe is NEVER cached.
    //    Instead: skip starting a new fetch if one is already running.
    //    This ensures only 1 backend search at a time (no rate limiter
    //    contention) while allowing the running search to complete and
    //    cache its result for future seeks.
    if (bgKeyframeTimerRef.current !== null) {
      clearTimeout(bgKeyframeTimerRef.current);
      bgKeyframeTimerRef.current = null;
    }
    // Do NOT abort a running fetch — let it complete and cache the keyframe
    const parsed = streamUrl ? parseStreamUrl(streamUrl) : null;
    if (parsed && duration > 0 && filesize > 0) {
      bgKeyframeTimerRef.current = window.setTimeout(() => {
        bgKeyframeTimerRef.current = null;
        // Skip if a fetch is already running — only 1 concurrent search
        if (bgKeyframeAbortRef.current) {
          return;
        }
        const abortCtl = new AbortController();
        bgKeyframeAbortRef.current = abortCtl;
        fetchMpegtsKeyframeAt(parsed.baseUrl, parsed.folderId, parsed.messageId, parsed.token, timeSeconds, duration, abortCtl.signal).then(kfAt => {
          bgKeyframeAbortRef.current = null; // Clear so next fetch can start
          if (kfAt && !kfAt.fallback) {
            const gap = Math.abs(timeSeconds - kfAt.timestamp);
            if (gap <= 30) {
              const existing = tsKeyframeIndexRef.current;
              const newEntry = { timestamp: kfAt.timestamp, byteOffset: kfAt.byteOffset };
              const filtered = existing.filter(k => k.byteOffset !== newEntry.byteOffset);
              filtered.push(newEntry);
              filtered.sort((a, b) => a.timestamp - b.timestamp);
              tsKeyframeIndexRef.current = filtered;
              diagLog(`[MPEGTS] Background keyframe cached: ${timeSeconds.toFixed(1)}s -> ${kfAt.timestamp.toFixed(1)}s, byte ${kfAt.byteOffset} (for future seeks)`);
            }
          }
        }).catch(() => {
          bgKeyframeAbortRef.current = null; // Clear on error too
        });
      }, 5000);
    }

    // 2b. VBR correction: if a corrected byte offset was provided (from align poll),
    //     use it directly instead of the linear estimate. This is the key fix for
    //     VBR seek accuracy — the align poll detects the actual time at the estimated
    //     byte and calculates the correct byte position.
    if (correctedByteOffset !== undefined && correctedByteOffset >= 0) {
      seekByteFromIndex = Math.floor(correctedByteOffset / TS_PACKET_SIZE) * TS_PACKET_SIZE;
      seekTime = timeSeconds;
      seekKeyframeExact = true; // treat as exact — no step-back needed
      diagLog(`[MPEGTS] VBR corrected byte: ${timeSeconds.toFixed(1)}s -> byte ${seekByteFromIndex} (${(seekByteFromIndex / 1024 / 1024).toFixed(1)}MB)`);
    } else
    // 3. Fall back to linear byte estimate if no usable keyframe was found
    if (seekByteFromIndex < 0) {
      const linearByte = Math.floor((timeSeconds / duration) * filesize);
      seekByteFromIndex = linearByte;
      seekTime = timeSeconds;
      diagLog(`[MPEGTS] Using linear byte estimate: ${timeSeconds.toFixed(1)}s -> byte ${linearByte} (${(linearByte / 1024 / 1024).toFixed(1)}MB)`);
    }
    const RAW_BYTE_OFFSET = seekByteFromIndex >= 0
      ? seekByteFromIndex
      : Math.floor((timeSeconds / duration) * filesize);
    // Adaptive step-back: for non-exact seeks (linear estimate), step back
    // enough data to cover a typical GOP + VBR offset. For exact keyframe
    // index hits, step back 10 TS packets (1880 bytes) so TSDemuxer can find
    // PAT/PMT before the keyframe — without this, the demuxer may skip the
    // keyframe and land on the NEXT IDR frame (up to 12s later in large GOPs).
    // Step-back: 2MB for linear estimates, 10 packets for keyframe-index hits.
    // 2MB = 3.3s backward at 619 KB/s — covers the previous keyframe for
    // large-gap seeks (18-49s gaps → previous KF is ~1-2s before estimate).
    // For small-gap seeks (7-9s → previous KF is 7-12s back), the gap is
    // small enough that the align poll's forward jump is acceptable.
    // This uses only 17% of the first chunk for backward coverage vs 67% for 8MB.
    const stepBackBytes = seekKeyframeExact
      ? 10 * TS_PACKET_SIZE  // 1880 bytes for exact keyframe hits
      : Math.floor(2 * 1024 * 1024 / TS_PACKET_SIZE) * TS_PACKET_SIZE;  // 2MB for linear estimates
    const ALIGNED_BYTE_OFFSET = Math.max(0,
      Math.floor(RAW_BYTE_OFFSET / TS_PACKET_SIZE) * TS_PACKET_SIZE
      - stepBackBytes
    );
    const byteOffset = ALIGNED_BYTE_OFFSET;
    diagLog(`[MPEGTS] Unbuffered seek to ${timeSeconds.toFixed(1)}s (target ${seekTime.toFixed(1)}s, raw byte ${RAW_BYTE_OFFSET}, aligned ${ALIGNED_BYTE_OFFSET} [${RAW_BYTE_OFFSET % TS_PACKET_SIZE} off → ${ALIGNED_BYTE_OFFSET % TS_PACKET_SIZE}], ${(byteOffset/1024/1024).toFixed(1)}MB of ${(filesize/1024/1024).toFixed(1)}MB${seekKeyframeExact ? ', keyframe-index' : ', linear-estimate'})`);

    try {
      // ── REMUX / VIDEO-ONLY SEEK GUARD ──
      // Must be checked BEFORE the player null-check below. During rapid seeks,
      // a concurrent recreation may have already destroyed the player (set ref
      // to null). If we check player first, we'd bail with just video.currentTime
      // instead of recreating — leaving the user with a stalled player.
      //
      // The /remux/ endpoint is a non-seekable ffmpeg pipe — IOController.seek()
      // can't work against it. For timed_id3 files, the raw /stream/ audio has
      // PTS drift + different AAC config that causes decode errors.
      // Fix: recreate the player entirely from /stream/ URL in video-only mode.
      //
      // Once in video-only mode, ALL subsequent seeks must also recreate.
      // IOController.seek() reuses the existing demuxer/remuxer whose DTS base
      // was set during the previous recreation — samples land at stale DTS
      // positions (e.g. 410s) while currentTime is at 1508s, causing a stall
      // with sbV.buffered=0.
      if ((remuxUrlRef.current || mpegtsVideoOnlyRef.current) && streamUrl) {
        diagLog(`[MPEGTS] Seek to ${seekTime.toFixed(1)}s: recreating player from /stream/ (video-only)`);
        remuxUrlRef.current = null;
        mpegtsVideoOnlyRef.current = true;
        video.muted = true;
        _mpegtsRecreatePlayerForSeek(byteOffset, seekTime, true);
        return;
      }

      // Re-read the player ref — though there's no long await before this
      // point anymore, the player may have been destroyed by React cleanup.
      const player = mpegtsPlayerRef.current;
      const engine = (player as any)?._player_engine;
      if (!player || !engine) {
        diagLog(`[MPEGTS] No player/engine for seek — falling back to video.currentTime (player=${!!player}, engine=${!!engine})`);
        video.currentTime = seekTime;
        return;
      }

      // Clear the shadow cache before seeking. The cache may have data ahead of
      // the seek target (from the sequential download). If we don't clear it,
      // _pumpChunks() serves cached chunks in a synchronous tight loop through
      // the full transmuxer pipeline, blocking the main thread and freezing the
      // app. With an empty cache, the loader hits await _fetchRange() which
      // yields properly, and the backend serves from disk (seek-back) or
      // Telegram (seek-forward). The disk cache survives — only in-memory data
      // is cleared.
      if (shadowCacheRef.current) {
        const cache = shadowCacheRef.current;
        const hadEntries = cache.entryCount;
        cache.reset(cache.urlKey, cache.fileLength);
        if (hadEntries > 0) {
          diagLog(`[MPEGTS] Shadow cache cleared for seek (was ${hadEntries} entries)`);
        }
      }

      // Move the video element's playhead to the target time so the UI and the
      // browser's seeking behavior align with the new stream position. This must
      // happen before the IOController seek so mpegts.js can pick up the new time.
      video.currentTime = seekTime;
      // 1. Flush SourceBuffers — remove all buffered ranges for clean slate
      const mseCtrl = engine._mse_controller;
      if (mseCtrl) {
        try { mseCtrl.flush(); } catch (_) {}
      }

      // 1b. Reset quota guard aggressive mode — after flush, totalBuffered=0
      //     so the guard will clear aggressive on next tick.
      (window as any).__nobuf_bufferFullDetected = false;
      (window as any).__nobuf_removeInProgress = false;
      (window as any).__nobuf_evictionResumePending = false;
      (window as any).__nobuf_evictionResumeByte = 0;
      (window as any).__nobuf_nuclearRecoveryInProgress = false;
      // Invalidate any pending nuclear recovery's restartAfterClear
      // so it won't resume from the old byte offset after this seek.
      (window as any).__nobuf_nuclearGeneration = ((window as any).__nobuf_nuclearGeneration || 0) + 1;
      // Frontend byte-time samples are tied to the old byte stream and get stale
      // after a seek. The backend keyframe index is global and survives seeks,
      // so we only reset the legacy sample fallback.
      byteTimeSamplesRef.current = [];

      // 2. Reset demuxer and remuxer for clean state after flush
      const tController = engine._transmuxer?._controller;
      if (!tController) {
        diagLog('[MPEGTS] No transmuxing controller — falling back');
        video.currentTime = seekTime;
        return;
      }

      try {
        // --- TSDemuxer reset ---
        // resetMediaInfo() only resets the MediaInfo object, NOT the demuxer's
        // timestamp tracking or leftover audio data. We must reset these manually.
        if (tController._demuxer) {
          tController._demuxer.resetMediaInfo?.();

          // TSDemuxer does NOT have a timestampBase property (only FlvDemuxer does).
          // Remove stale reference — setting it was a no-op for TS format.

          // CRITICAL: Reset audio_last_sample_pts_ — when a PES packet at the seek
          // position lacks PTS (we landed mid-PES), the TSDemuxer extrapolates from
          // this stale value, producing audio frames with DTS ~40s instead of ~1028s.
          // This causes the MP4Remuxer to drop every frame (DTS overlap) and the
          // console floods with "Dropping 1 audio frame" messages.
          const demuxer = tController._demuxer as any;
          if (demuxer.audio_last_sample_pts_ !== undefined) {
            demuxer.audio_last_sample_pts_ = undefined;
          }
          // Reset leftover AAC data from previous parse — prevents corrupt audio
          // frames where old tail data is prepended to new seek data.
          if (demuxer.aac_last_incomplete_data_ != null) {
            demuxer.aac_last_incomplete_data_ = null;
          }
          // Clear stale PES slice queues — video PID queues with expected_length===0
          // get EMITTED on next payload_unit_start_indicator, producing stale DTS.
          if (demuxer.pes_slice_queues_) {
            for (const pid of Object.keys(demuxer.pes_slice_queues_)) {
              delete demuxer.pes_slice_queues_[pid];
            }
          }
          // Clear stale track sample buffers
          if (demuxer.video_track_?.samples) demuxer.video_track_.samples = [];
          if (demuxer.audio_track_?.samples) demuxer.audio_track_.samples = [];
          // Clear LOAS AAC continuation frame
          if ('loas_previous_frame' in demuxer) demuxer.loas_previous_frame = null;
          // Reset MPEG-TS timestamp wraparound state — stale last_pcr_base_
          // causes false wraparound detection adding extra 0x200000000 (95M ms).
          if ('timestamp_offset_' in demuxer) demuxer.timestamp_offset_ = 0;
          if ('last_pcr_base_' in demuxer) demuxer.last_pcr_base_ = -1;
        }

        // --- MP4Remuxer reset ---
        if (tController._remuxer) {
          const remuxer = tController._remuxer as any;

          // seek() clears stashed samples and segment info lists (but NOT _dtsBaseInited)
          remuxer.seek?.();

          // Explicit clears as safety net (in case seek() is undefined or doesn't clear these)
          remuxer._audioStashedLastSample = null;
          remuxer._videoStashedLastSample = null;
          remuxer._videoSegmentInfoList?.clear?.();
          remuxer._audioSegmentInfoList?.clear?.();

          // DO NOT reset _dtsBaseInited / _dtsBase. The original DTS base was
          // computed from the initial load (~0ms) and is valid across the entire
          // TS file because the stream's PTS is absolute (monotonically increasing
          // from 0 to duration). Keeping the base means samples at the seek position
          // produce absolute DTS values (e.g., ~850s), so the MSE SourceBuffer places
          // segments at the seek time on the media timeline. If we reset the base,
          // segments start at relative DTS 0 and end up at 0s on the timeline while
          // video.currentTime is at 850s, causing playback to stall.
          // We still clear stashed samples and reset the next-DTS trackers so the
          // first post-seek batch is treated as a clean discontinuity.
          remuxer.insertDiscontinuity?.();
        }
      } catch (e: any) {
        diagLog(`[MPEGTS] Demuxer/remuxer reset warning: ${e.message}`);
      }

      // 3. Call IOController.seek(byteOffset) — the key step.
      //    With the FetchStreamLoader.abort() patch in place, this properly:
      //    a) Aborts the current fetch (abortController.abort() is now called)
      //    b) Destroys the old FetchStreamLoader
      //    c) Creates a new FetchStreamLoader with Range: bytes=byteOffset-
      //    d) Opens the new Range request to the server
      const ioctl = tController._ioctl;
      if (ioctl) {
        diagLog(`[MPEGTS] IOController.seek(${byteOffset})`);
        ioctl.seek(byteOffset);

        // 4. Resume LoadingController if paused (BUFFER_FULL or initial load).
        //    After seek, LoadingController may still think it's paused.
        //    Fix: resume so it resets _paused = false and can monitor the buffer.
        const loadingCtrl = engine?._loading_controller;
        if (loadingCtrl && loadingCtrl._paused) {
          diagLog('[MPEGTS] Resuming LoadingController after seek (was paused)');
          loadingCtrl.resumeTransmuxer();
        }
      } else {
        // IOController may be null if LoadingController destroyed it.
        // Handle gracefully — attempt transmuxer resume.
        diagLog('[MPEGTS] IOController null — attempting transmuxer resume');
        try {
          engine._transmuxer?.resume?.();
        } catch (_) {}
        // Retry after a short delay for IOController to be recreated
        setTimeout(() => {
          const ioctl2 = engine._transmuxer?._controller?._ioctl;
          if (ioctl2) {
            diagLog(`[MPEGTS] IOController retry seek(${byteOffset})`);
            ioctl2.seek(byteOffset);
          } else {
            diagLog('[MPEGTS] IOController still null — full player recreate needed');
            // Last resort: destroy and recreate the entire player
            _mpegtsRecreatePlayerForSeek(byteOffset, seekTime);
          }
        }, 200);
        return; // Don't set currentTime yet — wait for IOController
      }

      // 4. Set video.currentTime — video element seeks to the target position
      video.currentTime = seekTime;
      diagLog(`[MPEGTS] Seek initiated — video.currentTime set to ${seekTime.toFixed(1)}s`);

      // ── DIAGNOSTIC: check pipeline state at intervals after seek ──
      // Helps pinpoint where data flow stops: loader → IOController → demuxer → remuxer → MSE
      const seekDiagGen = seekGen;
      let seekKeyframeAdjusted = false;
      const getVideoBufferStart = (): number | null => {
        const eng = (player as any)?._player_engine;
        const mc = eng?._mse_controller;
        const ms = mc?.getObject?.();
        const sbV = ms?.sourceBuffers?.[0];
        if (sbV && sbV.buffered && sbV.buffered.length > 0) {
          return sbV.buffered.start(0);
        }
        return null;
      };
      const checkPipeline = (label: string) => {
        if (mpegtsUnbufferedSeekGenerationRef.current !== seekDiagGen) return; // superseded
        const eng = (player as any)?._player_engine;
        if (!eng) { diagLog(`[SEEK-DIAG] ${label}: no engine`); return; }
        const ic = eng._transmuxer?._controller?._ioctl;
        const mc = eng._mse_controller;
        const ms = mc?.getObject?.();
        const sbV = ms?.sourceBuffers?.[0];
        const sbA = ms?.sourceBuffers?.[1];
        const dem = eng._transmuxer?._controller?._demuxer;
        const rem = eng._transmuxer?._controller?._remuxer;

        // The seek byte is approximate and may land in the middle of a GOP.
        // For small gaps (≤5s forward or backward), jump to the keyframe.
        // For large gaps (>5s), let the align poll handle VBR correction.
        // CRITICAL: backward gaps > 5s must NOT set seekKeyframeAdjusted —
        // the align poll needs to run to trigger backward VBR correction.
        // Also: only jump if buffer has ≥2s of data (prevents mpegts.js
        // from clearing SourceBuffers when jumping with too little data).
        const v = videoRef.current;
        const videoBufferStart = getVideoBufferStart();
        const audioBufferStart = (sbA?.buffered && sbA.buffered.length > 0) ? sbA.buffered.start(0) : null;
        if (!seekKeyframeAdjusted && v && videoBufferStart !== null) {
          const bufEnd = sbV?.buffered && sbV.buffered.length > 0 ? sbV.buffered.end(0) : videoBufferStart;
          const bufLen = bufEnd - videoBufferStart;
          if (videoBufferStart > v.currentTime + 0.5 && videoBufferStart <= v.currentTime + 5 && bufLen >= 2.0) {
            diagLog(`[MPEGTS] Seek target ${v.currentTime.toFixed(1)}s landed before first video keyframe; jumping to video buffer start ${videoBufferStart.toFixed(1)}s (buffer ${bufLen.toFixed(1)}s)`);
            v.currentTime = videoBufferStart;
            v.play().catch(() => {}); // Resume playback after jump
            seekKeyframeAdjusted = true;
            // Cache for future seeks (if VBR correction was used)
            if (vbrCorrectionDepth > 0) {
              const existing = tsKeyframeIndexRef.current;
              const newEntry = { timestamp: videoBufferStart, byteOffset: byteOffset };
              const filtered = existing.filter(k => k.byteOffset !== newEntry.byteOffset);
              filtered.push(newEntry);
              filtered.sort((a, b) => a.timestamp - b.timestamp);
              tsKeyframeIndexRef.current = filtered;
              // ALSO update byteToTimeTableRef so byteToTime() uses accurate
              // VBR mapping instead of falling back to linear. Without this,
              // the green prebuffer bar renders at the wrong time position
              // (linear mapping says the byte is behind the playhead, but the
              // actual VBR time is ahead).
              const btTable = byteToTimeTableRef.current;
              const btEntry: [number, number] = [byteOffset, videoBufferStart];
              const btFiltered = btTable.filter(([b]) => b !== byteOffset);
              btFiltered.push(btEntry);
              btFiltered.sort((a, b) => a[0] - b[0]);
              byteToTimeTableRef.current = btFiltered;
              diagLog(`[MPEGTS] VBR-corrected keyframe cached: ${videoBufferStart.toFixed(1)}s -> byte ${byteOffset} (for future seeks)`);
            }
          } else if (videoBufferStart >= v.currentTime - 5 && videoBufferStart <= v.currentTime + (v.muted ? 30 : 15)) {
            // Backward gap within 5s or at currentTime — jump to videoBufferStart
            // so video plays immediately from the keyframe. Also handle small
            // forward gaps (≤0.5s) — without this, currentTime stays just before
            // the buffer start and the video can't play.
            if (videoBufferStart < v.currentTime - 0.5 && bufLen >= 2.0) {
              diagLog(`[MPEGTS] Seek target ${v.currentTime.toFixed(1)}s; video buffer starts ${videoBufferStart.toFixed(1)}s (${(v.currentTime - videoBufferStart).toFixed(1)}s before) — jumping back to keyframe (buffer ${bufLen.toFixed(1)}s)`);
              v.currentTime = videoBufferStart;
              v.play().catch(() => {}); // Resume playback after backward jump
            } else if (videoBufferStart > v.currentTime + 0.05 && bufLen >= 2.0) {
              diagLog(`[MPEGTS] Seek target ${v.currentTime.toFixed(1)}s; video buffer starts ${videoBufferStart.toFixed(1)}s (${(videoBufferStart - v.currentTime).toFixed(1)}s after) — jumping forward to keyframe (buffer ${bufLen.toFixed(1)}s)`);
              v.currentTime = videoBufferStart;
              v.play().catch(() => {}); // Resume playback after forward jump
            }
            seekKeyframeAdjusted = true;
            if (vbrCorrectionDepth > 0) {
              const existing = tsKeyframeIndexRef.current;
              const newEntry = { timestamp: videoBufferStart, byteOffset: byteOffset };
              const filtered = existing.filter(k => k.byteOffset !== newEntry.byteOffset);
              filtered.push(newEntry);
              filtered.sort((a, b) => a.timestamp - b.timestamp);
              tsKeyframeIndexRef.current = filtered;
              // Also update byteToTimeTableRef for accurate VBR mapping
              const btTable = byteToTimeTableRef.current;
              const btFiltered = btTable.filter(([b]) => b !== byteOffset);
              btFiltered.push([byteOffset, videoBufferStart]);
              btFiltered.sort((a, b) => a[0] - b[0]);
              byteToTimeTableRef.current = btFiltered;
              diagLog(`[MPEGTS] VBR-corrected keyframe cached: ${videoBufferStart.toFixed(1)}s -> byte ${byteOffset} (for future seeks)`);
            }
          }
          // For gaps > 5s (forward OR backward): don't set seekKeyframeAdjusted
          // — let align poll handle VBR correction
          // For buffer < 2s: don't jump — let align poll wait for more data
        }

        diagLog(`[SEEK-DIAG] ${label}: currentTime=${v?.currentTime?.toFixed(1)} videoBufferStart=${videoBufferStart?.toFixed(1)} audioBufferStart=${audioBufferStart?.toFixed(1)}`);
        diagLog(`[SEEK-DIAG] ${label}: ioctl.paused=${ic?._paused} range=${JSON.stringify(ic?._currentRange)}`);
        diagLog(`[SEEK-DIAG] ${label}: sbV.updating=${sbV?.updating} sbV.buffered=${sbV?.buffered?.length} sbA.updating=${sbA?.updating} sbA.buffered=${sbA?.buffered?.length}`);
        diagLog(`[SEEK-DIAG] ${label}: pendingRemove V=${mc?._pendingRemoveRanges?.video?.length} A=${mc?._pendingRemoveRanges?.audio?.length} pendingSeg V=${mc?._pendingSegments?.video?.length} A=${mc?._pendingSegments?.audio?.length}`);
        diagLog(`[SEEK-DIAG] ${label}: remuxer.dtsBaseInited=${rem?._dtsBaseInited} videoMeta=${!!rem?._videoMeta} audioMeta=${!!rem?._audioMeta} videoNextDts=${rem?._videoNextDts} audioNextDts=${rem?._audioNextDts}`);
        if (dem) {
          diagLog(`[SEEK-DIAG] ${label}: demuxer.pmt=${!!dem.pmt_} videoTrack.samples=${dem.video_track_?.samples?.length} audioTrack.samples=${dem.audio_track_?.samples?.length}`);
        }
      };
      setTimeout(() => checkPipeline('1s'), 1000);
      setTimeout(() => checkPipeline('3s'), 3000);
      setTimeout(() => checkPipeline('5s'), 5000);

      // Also run a frequent, longer alignment poll for the case where the first
      // video keyframe takes many seconds to arrive (large GOP + slow download).
      // VBR correction: when the buffer starts >5s ahead of the target, the linear
      // estimate was wrong (VBR offset). Instead of jumping to the wrong scene,
      // calculate the CORRECT byte position and re-seek through the full pipeline.
      // Use audioBufferStart for VBR CORRECTION ONLY (>5s gap) — audio arrives
      // early and detects the VBR offset before video appears.
      // Use videoBufferStart for FINAL ALIGNMENT (≤5s gap) — video determines
      // if playback can proceed. Using audio for alignment is WRONG because
      // audio can start before the target while video starts after it.
      let alignAttempts = 0;
      let vbrCorrectionDepth = vbrDepth ?? 0;
      const MAX_VBR_CORRECTIONS = 2;
      const alignInterval = setInterval(() => {
        alignAttempts++;
        if (mpegtsUnbufferedSeekGenerationRef.current !== seekDiagGen || seekKeyframeAdjusted) {
          clearInterval(alignInterval);
          return;
        }
        const v = videoRef.current;
        const videoBufferStart = getVideoBufferStart();
        const eng = (mpegtsPlayerRef.current as any)?._player_engine;
        const mc = eng?._mse_controller;
        const ms = mc?.getObject?.();
        const sbA = ms?.sourceBuffers?.[1];
        const audioBufferStart = (sbA?.buffered && sbA.buffered.length > 0) ? sbA.buffered.start(0) : null;

        // VBR CORRECTION: use audio OR video, whichever appears first (>5s gap only)
        // Forward: audio > target + 5 → download too far BACK → re-seek backward
        // Backward: audio < target - 5 → download too far FORWARD → re-seek forward
        // Cap: gaps >120s are physically impossible from VBR — they indicate stale
        // pre-seek buffer data (from byte-0 load before ioctl.seek took effect).
        const MAX_VBR_GAP = 120;
        if (v && audioBufferStart !== null) {
          if (audioBufferStart > v.currentTime + 5) {
            // Audio arrived early with large forward gap → VBR correction before video shows
            const gap = audioBufferStart - v.currentTime;
            if (gap > MAX_VBR_GAP) {
              // Stale pre-seek buffer — ignore and wait for real data
              clearInterval(alignInterval);
              seekKeyframeAdjusted = true;
              return;
            }
            if (vbrCorrectionDepth < MAX_VBR_CORRECTIONS && duration > 0 && filesize > 0) {
              vbrCorrectionDepth++;
              const bitrate = filesize / duration;
              const correctionBytes = gap * bitrate;
              const correctedByte = Math.max(0, byteOffset - correctionBytes);
              diagLog(`[MPEGTS] VBR correction #${vbrCorrectionDepth}: gap ${gap.toFixed(1)}s (audio) → re-seek from ${(byteOffset/1024/1024).toFixed(1)}MB to ${(correctedByte/1024/1024).toFixed(1)}MB (${(correctionBytes/1024/1024).toFixed(1)}MB back)`);
              clearInterval(alignInterval);
              (window as any).__nobuf_seekRequestedAt = 0;
              seekKeyframeAdjusted = true;
              _mpegtsUnbufferedSeek(timeSeconds, duration, correctedByte, vbrCorrectionDepth);
              return;
            }
          } else if (audioBufferStart < v.currentTime - 5) {
            // Audio arrived with large backward gap → download too far FORWARD
            // → re-seek forward so data arrives closer to target
            const gap = v.currentTime - audioBufferStart;
            if (gap > MAX_VBR_GAP) {
              // Stale pre-seek buffer — ignore and wait for real data
              clearInterval(alignInterval);
              seekKeyframeAdjusted = true;
              return;
            }
            if (vbrCorrectionDepth < MAX_VBR_CORRECTIONS && duration > 0 && filesize > 0) {
              vbrCorrectionDepth++;
              const bitrate = filesize / duration;
              const correctionBytes = gap * bitrate;
              const correctedByte = Math.min(filesize - 1, byteOffset + correctionBytes);
              diagLog(`[MPEGTS] VBR correction #${vbrCorrectionDepth}: backward gap ${gap.toFixed(1)}s (audio) → re-seek from ${(byteOffset/1024/1024).toFixed(1)}MB to ${(correctedByte/1024/1024).toFixed(1)}MB (${(correctionBytes/1024/1024).toFixed(1)}MB forward)`);
              clearInterval(alignInterval);
              (window as any).__nobuf_seekRequestedAt = 0;
              seekKeyframeAdjusted = true;
              _mpegtsUnbufferedSeek(timeSeconds, duration, correctedByte, vbrCorrectionDepth);
              return;
            }
          }
        }

        // FINAL ALIGNMENT: use VIDEO buffer only — video determines playability
        if (v && videoBufferStart !== null) {
          if (videoBufferStart > v.currentTime + 0.5) {
            const gap = videoBufferStart - v.currentTime;
            if (gap > MAX_VBR_GAP) {
              // Stale pre-seek buffer — ignore and wait for real data
              clearInterval(alignInterval);
              seekKeyframeAdjusted = true;
              return;
            }
            if (gap > 5 && vbrCorrectionDepth < MAX_VBR_CORRECTIONS && duration > 0 && filesize > 0) {
              // Video gap > 5s → VBR correction (re-seek to corrected byte)
              vbrCorrectionDepth++;
              const bitrate = filesize / duration;
              const correctionBytes = gap * bitrate;
              const correctedByte = Math.max(0, byteOffset - correctionBytes);
              diagLog(`[MPEGTS] VBR correction #${vbrCorrectionDepth}: gap ${gap.toFixed(1)}s (video) → re-seek from ${(byteOffset/1024/1024).toFixed(1)}MB to ${(correctedByte/1024/1024).toFixed(1)}MB (${(correctionBytes/1024/1024).toFixed(1)}MB back)`);
              clearInterval(alignInterval);
              (window as any).__nobuf_seekRequestedAt = 0;
              seekKeyframeAdjusted = true;
              _mpegtsUnbufferedSeek(timeSeconds, duration, correctedByte, vbrCorrectionDepth);
              return;
            }
            // Gap 0.5-5s or max corrections: wait for buffer to have enough data
            // before jumping currentTime. Jumping too early (with <2s of buffer)
            // can trigger mpegts.js internal seek/cleanup which CLEARS the
            // SourceBuffers — leaving the video stuck with no data.
            const eng2 = (mpegtsPlayerRef.current as any)?._player_engine;
            const mc2 = eng2?._mse_controller;
            const ms2 = mc2?.getObject?.();
            const sbV2 = ms2?.sourceBuffers?.[0];
            if (sbV2 && sbV2.buffered && sbV2.buffered.length > 0) {
              const bufferEnd = sbV2.buffered.end(0);
              const bufferLength = bufferEnd - videoBufferStart;
              if (bufferLength >= 2.0) {
                diagLog(`[MPEGTS] Align poll: currentTime ${v.currentTime.toFixed(1)}s → video buffer start ${videoBufferStart.toFixed(1)}s (gap ${gap.toFixed(1)}s, buffer ${bufferLength.toFixed(1)}s)${vbrCorrectionDepth > 0 ? ` after ${vbrCorrectionDepth} correction(s)` : ''}`);
                v.currentTime = videoBufferStart;
                v.play().catch(() => {}); // Resume playback after forward jump
                seekKeyframeAdjusted = true;
                // Cache this keyframe position for future seeks — the VBR correction
                // found the ACTUAL byte-to-time mapping. Without caching, the next
                // seek to this region repeats the entire correction process (10s+).
                if (vbrCorrectionDepth > 0) {
                  const existing = tsKeyframeIndexRef.current;
                  const newEntry = { timestamp: videoBufferStart, byteOffset: byteOffset };
                  const filtered = existing.filter(k => k.byteOffset !== newEntry.byteOffset);
                  filtered.push(newEntry);
                  filtered.sort((a, b) => a.timestamp - b.timestamp);
                  tsKeyframeIndexRef.current = filtered;
                  diagLog(`[MPEGTS] VBR-corrected keyframe cached: ${videoBufferStart.toFixed(1)}s -> byte ${byteOffset} (for future seeks)`);
                }
              } else {
                // Buffer < 2s — not enough data to jump yet. Keep polling.
                // The align poll will retry on the next 200ms tick.
              }
            }
          } else if (videoBufferStart < v.currentTime - 5) {
            // BACKWARD VBR correction: buffer starts >5s BEFORE target.
            // The linear estimate was too far FORWARD in the file (local bitrate
            // higher than average). Move the download FORWARD so data arrives
            // closer to the target. Without this, the user waits 10-20s for
            // the buffer to expand forward to the target.
            const gap = v.currentTime - videoBufferStart;
            if (gap > MAX_VBR_GAP) {
              // Stale pre-seek buffer — ignore and wait for real data
              clearInterval(alignInterval);
              seekKeyframeAdjusted = true;
              return;
            }
            if (vbrCorrectionDepth < MAX_VBR_CORRECTIONS && duration > 0 && filesize > 0) {
              vbrCorrectionDepth++;
              const bitrate = filesize / duration;
              const correctionBytes = gap * bitrate;
              const correctedByte = Math.min(filesize - 1, byteOffset + correctionBytes);
              diagLog(`[MPEGTS] VBR correction #${vbrCorrectionDepth}: backward gap ${gap.toFixed(1)}s (video) → re-seek from ${(byteOffset/1024/1024).toFixed(1)}MB to ${(correctedByte/1024/1024).toFixed(1)}MB (${(correctionBytes/1024/1024).toFixed(1)}MB forward)`);
              clearInterval(alignInterval);
              (window as any).__nobuf_seekRequestedAt = 0;
              seekKeyframeAdjusted = true;
              _mpegtsUnbufferedSeek(timeSeconds, duration, correctedByte, vbrCorrectionDepth);
              return;
            }
            // Max corrections reached: let video buffer expand to target
            seekKeyframeAdjusted = true;
          } else {
            // Video buffer at or before currentTime (within 5s) — jump to keyframe
            // if gap > 0.1s in EITHER direction. Without this, a small forward gap
            // (e.g. 0.1s) leaves currentTime just BEFORE the buffer start — the
            // video can't play because there's no data at currentTime.
            if (videoBufferStart < v.currentTime - 0.5) {
              diagLog(`[MPEGTS] Align poll: currentTime ${v.currentTime.toFixed(1)}s → video buffer start ${videoBufferStart.toFixed(1)}s (gap -${(v.currentTime - videoBufferStart).toFixed(1)}s) — jumping back to keyframe`);
              v.currentTime = videoBufferStart;
              v.play().catch(() => {}); // Resume playback after backward jump
            } else if (videoBufferStart > v.currentTime + 0.05) {
              diagLog(`[MPEGTS] Align poll: currentTime ${v.currentTime.toFixed(1)}s → video buffer start ${videoBufferStart.toFixed(1)}s (gap +${(videoBufferStart - v.currentTime).toFixed(1)}s) — jumping forward to keyframe`);
              v.currentTime = videoBufferStart;
              v.play().catch(() => {}); // Resume playback after forward jump
            }
            seekKeyframeAdjusted = true;
            // Cache this keyframe position for future seeks
            if (vbrCorrectionDepth > 0) {
              const existing = tsKeyframeIndexRef.current;
              const newEntry = { timestamp: videoBufferStart, byteOffset: byteOffset };
              const filtered = existing.filter(k => k.byteOffset !== newEntry.byteOffset);
              filtered.push(newEntry);
              filtered.sort((a, b) => a.timestamp - b.timestamp);
              tsKeyframeIndexRef.current = filtered;
              // Also update byteToTimeTableRef for accurate VBR mapping
              const btTable = byteToTimeTableRef.current;
              const btFiltered = btTable.filter(([b]) => b !== byteOffset);
              btFiltered.push([byteOffset, videoBufferStart]);
              btFiltered.sort((a, b) => a[0] - b[0]);
              byteToTimeTableRef.current = btFiltered;
              diagLog(`[MPEGTS] VBR-corrected keyframe cached: ${videoBufferStart.toFixed(1)}s -> byte ${byteOffset} (for future seeks)`);
            }
          }
          if (seekKeyframeAdjusted) {
            clearInterval(alignInterval);
            (window as any).__nobuf_seekRequestedAt = 0;
          }
        }
        if (alignAttempts > 150) { // 30s
          clearInterval(alignInterval);
          (window as any).__nobuf_seekRequestedAt = 0;
          diagLog(`[MPEGTS] Keyframe alignment poll timed out after 30s`);
        }
      }, 200);

      // 5. Report the new playback position to the backend so the proactive
      //    prebuffer adjusts its sliding window to start from the seek byte.
      //    The prebuffer uses try_acquire + player_actively_downloading to yield
      //    to /stream, so it won't compete for the rate limiter budget.
      const _fileId = file?.id;
      const _folderId = activeFolderId; // null = "home" — backend accepts Option
      const _fileSize = state.current.fileLength;
      if (_fileId && _fileSize && mpegtsDurationRef.current > 0) {
        invoke('cmd_report_playback_position', {
          messageId: _fileId,
          folderId: _folderId,
          currentTimeS: timeSeconds,
          durationS: mpegtsDurationRef.current,
          fileSize: _fileSize,
          isPlayerDownloading: true,
          playbackRate: 1.0,
          byteOffset: byteOffset,
        }).catch(() => {});
        if (proactivePrebufferMsgIdRef.current !== _fileId) {
          proactivePrebufferMsgIdRef.current = _fileId;
        }
        diagLog(`[MPEGTS] Reported seek position to proactive prebuffer: byte ${byteOffset} (${(byteOffset/1024/1024).toFixed(1)}MB)`);
      }

    } catch (e: any) {
      diagLog(`[MPEGTS] Unbuffered seek failed: ${e.message}`);
      (window as any).__nobuf_seekRequestedAt = 0;
      video.currentTime = seekTime;
    }
    } finally {
      // Clear user seek flag — after this point, _onIOSeeked should NOT
      // fire insertDiscontinuity (lazyLoad resume and Early-EOF reconnect
      // have continuous DTS, not a discontinuity). Only clear if this is still
      // the most recent seek generation, otherwise a later seek needs the flag.
      if (mpegtsUnbufferedSeekGenerationRef.current === seekGen) {
        (window as any).__nobuf_userSeekInProgress = false;
        // NOTE: __nobuf_seekRequestedAt is NOT cleared here — it survives
        // the function return to cover the align poll phase. It's cleared
        // when the align poll completes (clearInterval sites below).

        // If a new seek target was queued during this seek (user scrubbed
        // while this seek was executing), execute it now. The pending ref
        // always holds the LAST target, so only the final scrub position
        // gets executed — intermediate positions are discarded.
        const pending = pendingSeekTargetRef.current;
        if (pending) {
          pendingSeekTargetRef.current = null;
          if (pendingSeekDepthRef.current >= 3) {
            diagLog(`[MPEGTS] Pending seek to ${pending.time.toFixed(1)}s dropped — max depth 3 reached`);
            pendingSeekDepthRef.current = 0;
          } else {
            pendingSeekDepthRef.current++;
            diagLog(`[MPEGTS] Executing pending seek to ${pending.time.toFixed(1)}s (depth ${pendingSeekDepthRef.current}) after seek gen ${seekGen} completed`);
            _mpegtsUnbufferedSeek(pending.time, pending.dur);
          }
        } else {
          // No pending seek — reset depth
          pendingSeekDepthRef.current = 0;
        }
      }
    }
  };

  /** Last-resort: recreate mpegts.js player for seek when IOController is null.
   *  Destroys the current player and creates a new one that starts from byteOffset.
   *
   *  Concurrency: uses a generation counter — if a newer recreation starts while
   *  this one is awaiting, we bail early instead of operating on stale state.
   */
  const _mpegtsRecreatePlayerForSeek = async (byteOffset: number, timeSeconds: number, videoOnly?: boolean, vbrDepth?: number) => {
    const video = videoRef.current;
    if (!video) return;

    // Bump generation — any concurrent recreation with an older gen will bail
    const gen = ++mpegtsRecreationGenRef.current;

    diagLog(`[MPEGTS] Recreating player for seek to byte ${byteOffset}`);

    // 1. Destroy current player (may be null if a concurrent recreation already destroyed it)
    const oldPlayer = mpegtsPlayerRef.current;
    if (oldPlayer) {
      try {
        // Pause video before detach — cancels mpegts.js SeekingHandler's
        // _pollAndApplyUnbufferedSeek setTimeout, which would otherwise fire
        // after detachMediaElement nulls _mediaElement → TypeError on .currentTime
        if (video && !video.paused) video.pause();
        oldPlayer.detachMediaElement();
        oldPlayer.unload();
        oldPlayer.destroy();
      } catch (_) {}
      mpegtsPlayerRef.current = null;
    }

    // Yield to let GC reclaim old player's ArrayBuffers/SourceBuffers
    // before allocating new ones — prevents OOM on rapid recreations
    await new Promise<void>(r => setTimeout(r, 0));
    if (gen !== mpegtsRecreationGenRef.current) return;

    // 2. Create new player
    //    We use mpegts.js's built-in Range seek: after load(), we immediately
    //    call IOController.open(byteOffset) to start from the target offset.
    try {
      const mpegts = await import('mpegts.js');
      const MpegtsPlayer = mpegts.default || mpegts;

      // Apply the abort patch again (module-level, already patched)
      const dur = mpegtsDurationRef.current || state.current.duration;
      const fs = state.current.fileLength;

      const newPlayer = MpegtsPlayer.createPlayer({
        type: 'mpegts',
        isLive: false,
        url: streamUrl!,
        duration: dur,
        filesize: fs > 0 ? fs : undefined,
        hasAudio: true,
        hasVideo: true,
        cors: true,
      }, {
        enableWorker: false,
        enableStashBuffer: true,
        stashInitialSize: 1024 * 1024,
        fixAudioTimestampGap: false,
        lazyLoad: true,
        lazyLoadMaxDuration: 180,
        lazyLoadRecoverDuration: 120,
        seekType: 'range',
        customLoader: createChunkedFetchLoader(MpegtsPlayer),
        shadowCache: shadowCacheRef.current,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 60,
        autoCleanupMinBackwardDuration: 30,
        accurateSeek: false,
        // Force synchronous transmuxer creation so ioctl.seek() works
        // immediately after load(). Without this, deferLoadAfterSourceOpen
        // (default true) defers load until sourceopen fires async, leaving
        // _transmuxer null and the seek offset is lost — player loads from byte 0.
        deferLoadAfterSourceOpen: false,
        // M5/M6 fix: match initial player's chunk config (10MB regular,
        // 12MB post-seek first chunk for faster keyframe discovery)
        firstChunkSize: alignChunkSize(5 * 1024 * 1024),
        chunkSize: alignChunkSize(10 * 1024 * 1024),
        postSeekFirstChunkSize: alignChunkSize(12 * 1024 * 1024),
        } as any);

      newPlayer.attachMediaElement(video);
      mpegtsPlayerRef.current = newPlayer;

      // Video-only mode: patch MSE controller BEFORE load() to prevent audio
      // SourceBuffer creation. appendInitSegment creates SBs — blocking audio
      // init means _sourceBuffers['audio'] stays null, and _doAppendSegments
      // silently skips audio media segments (it checks `if (!sb) continue`).
      if (videoOnly) {
        const engine = (newPlayer as any)?._player_engine;
        const mseCtrl = engine?._mse_controller;
        if (mseCtrl) {
          const origInitSeg = mseCtrl.appendInitSegment.bind(mseCtrl);
          mseCtrl.appendInitSegment = (seg: any, deferred?: any) => {
            if (seg.type === 'audio') return;
            origInitSeg(seg, deferred);
          };
          const origMediaSeg = mseCtrl.appendMediaSegment.bind(mseCtrl);
          mseCtrl.appendMediaSegment = (seg: any) => {
            if (seg.type === 'audio') return;
            origMediaSeg(seg);
          };
        }
      }

      // The seek-recreated player uses the same custom loader as the initial player,
      // so native lazyLoad and autoCleanupSourceBuffer manage the buffer window.

      // Video-only mode: suppress mpegts.js warn-level logging. The TSDemuxer still
      // parses orphaned audio PID packets (even though PMT strips them) and logs
      // thousands of "AAC: Detected pts overlapped" warnings. These are harmless in
      // video-only mode since audio never reaches a SourceBuffer.
      if (videoOnly) {
        try {
          const LoggingControl = (mpegts as any).LoggingControl || (mpegts as any).default?.LoggingControl;
          if (LoggingControl) {
            LoggingControl.enableWarn = false;
          }
        } catch (_) {}
      }

      let oomRecoveryScheduled = false;
      newPlayer.on(MpegtsPlayer.Events.ERROR, (_type: string, detail: string) => {
        diagLog(`[MPEGTS] Recreated player error: ${detail}`);
        // OOM recovery: when ArrayBuffer allocation fails (memory pressure from
        // rapid player recreations), wait for GC then retry seek to same position
        if (!oomRecoveryScheduled && detail && detail.indexOf('Array buffer allocation failed') !== -1) {
          oomRecoveryScheduled = true;
          const v = videoRef.current;
          const ct = v ? v.currentTime : timeSeconds;
          const d = mpegtsDurationRef.current || state.current.duration || 0;
          diagLog(`[MPEGTS] OOM detected — scheduling recovery seek to ${ct.toFixed(1)}s`);
          setTimeout(() => {
            if (mpegtsPlayerRef.current) {
              _mpegtsUnbufferedSeek(ct, d);
            }
          }, 500);
        }
      });

      if (shadowCacheRef.current) {
        const cache = shadowCacheRef.current;
        cache.reset(cache.urlKey, cache.fileLength);
      }

      newPlayer.load();

      // load() creates IOController synchronously — no poll needed. Access it
      // immediately to seek before the loader downloads from byte 0.
      // The only await is the dynamic import above, so check gen right away.
      if (gen !== mpegtsRecreationGenRef.current) {
        diagLog(`[MPEGTS] Recreation superseded (gen ${gen} vs ${mpegtsRecreationGenRef.current}) — bailing`);
        if (mpegtsPlayerRef.current !== newPlayer) {
          try { newPlayer.detachMediaElement(); newPlayer.unload(); newPlayer.destroy(); } catch (_) {}
        }
        return;
      }

      // Seek via internal IOController
      const engine = (newPlayer as any)?._player_engine;
      const tCtrl = engine?._transmuxer?._controller;

      // Bootstrap demuxer/remuxer if not yet created. On a fresh player,
      // _demuxer is null — it's normally created when the first byte-0
      // chunk arrives via _onInitChunkArrival. But we seek before any data
      // arrives, so _onInitChunkArrival would crash on this._demuxer.bindDataSource()
      // when byteStart > 0. Pre-creating the demuxer with a synthetic probe
      // result lets ioctl.seek() work immediately.
      if (tCtrl && !tCtrl._demuxer) {
        try {
          tCtrl._setupTSDemuxerRemuxer({ match: true, consumed: 0, ts_packet_size: 188, sync_offset: 0 });
        } catch (e: any) {
          diagLog(`[MPEGTS] Failed to bootstrap demuxer: ${e.message}`);
        }
      }

      if (tCtrl) {
        const demuxer = tCtrl._demuxer as any;
        if (demuxer) {
          demuxer.audio_last_sample_pts_ = undefined;
          demuxer.aac_last_incomplete_data_ = null;
        }
        const remuxer = tCtrl._remuxer as any;
        if (remuxer) {
          // Pre-set _dtsBase=0 so raw PTS/DTS values pass through as absolute
          // timestamps. Without this, _calculateDtsBase() sets _dtsBase to the
          // first sample's DTS (e.g. 104,580,000 at 1162s) — normalizing all
          // output to start from ~0. MSE buffers at 0, video.currentTime=0,
          // and the progress bar jumps to 0% instead of showing the seek position.
          // With _dtsBase=0: output DTS = raw_DTS / timescale = absolute seconds,
          // so video.currentTime ≈ seekTime and the progress bar is correct.
          remuxer._dtsBase = 0;
          remuxer._dtsBaseInited = true;
          remuxer._audioDtsBase = Infinity;
          remuxer._videoDtsBase = Infinity;
          remuxer._audioStashedLastSample = null;
          remuxer._videoStashedLastSample = null;
          remuxer._videoSegmentInfoList?.clear?.();
          remuxer._audioSegmentInfoList?.clear?.();
          try { remuxer.insertDiscontinuity?.(); } catch (_) {}
        }
      }
      const ioctl = tCtrl?._ioctl;
      if (ioctl) {
        try { ioctl.seek(byteOffset); } catch (e: any) {
          diagLog(`[MPEGTS] ioctl.seek() failed (${e.message}) — non-fatal, continuing`);
        }
        // Resume LoadingController if paused (BUFFER_FULL or initial load pause)
        const loadingCtrl = engine?._loading_controller;
        if (loadingCtrl && loadingCtrl._paused) {
          loadingCtrl.resumeTransmuxer();
        }
        video.currentTime = timeSeconds;
        diagLog(`[MPEGTS] Recreated player — seeked to byte ${byteOffset}`);

        // For video-only seek: set up an align poll that jumps currentTime
        // to the first video buffer start AND performs VBR correction if the
        // landing position is >10s from the target (linear estimate is wrong
        // for VBR content).
        if (videoOnly) {
          const alignGen = gen; // capture for closure
          let alignTicks = 0;
          const vbrAttempts = vbrDepth ?? 0;
          const MAX_VBR_ATTEMPTS = 1;
          const alignIv = setInterval(() => {
            alignTicks++;
            // Bail if superseded or unmounted
            if (alignGen !== mpegtsRecreationGenRef.current || alignTicks > 30 || !videoRef.current) {
              clearInterval(alignIv); return;
            }
            const v = videoRef.current;
            if (v.buffered.length > 0) {
              const bufStart = v.buffered.start(0);
              const gap = bufStart - timeSeconds;

              // VBR correction: buffer landed >20s from target (15s would
              // false-trigger on legitimate GOP keyframe distance in large-GOP files)
              if (Math.abs(gap) > 20 && vbrAttempts < MAX_VBR_ATTEMPTS && dur > 0 && fs > 0) {
                // Use LOCAL bitrate from actual data: byteOffset → bufStart gives
                // the real byte-per-second ratio at this file position. This is far
                // more accurate than average bitrate for VBR content.
                const localBytesPerSec = byteOffset / bufStart;
                const correctedByte = Math.max(0, Math.min(fs - 1,
                  Math.floor((timeSeconds * localBytesPerSec) / 188) * 188
                ));
                // Skip if correction is too small to justify a full recreation
                if (Math.abs(correctedByte - byteOffset) < 1024 * 1024) {
                  if (Math.abs(bufStart - v.currentTime) > 0.05) v.currentTime = bufStart;
                  clearInterval(alignIv);
                  (window as any).__nobuf_seekTargetTime = 0;
                  return;
                }
                diagLog(`[MPEGTS] Recreate VBR correction #${vbrAttempts + 1}: target ${timeSeconds.toFixed(1)}s, buffer at ${bufStart.toFixed(1)}s (gap ${gap.toFixed(1)}s) → re-seek byte ${(correctedByte/1024/1024).toFixed(1)}MB`);
                clearInterval(alignIv);
                // Update seekTarget for UI
                (window as any).__nobuf_seekTargetTime = timeSeconds;
                _mpegtsRecreatePlayerForSeek(correctedByte, timeSeconds, true, vbrAttempts + 1);
                return;
              }

              // Normal alignment: jump to buffer start
              if (Math.abs(bufStart - v.currentTime) > 0.05) {
                diagLog(`[MPEGTS] Align (recreated): target ${timeSeconds.toFixed(1)}s → buffer start ${bufStart.toFixed(1)}s (delta ${(bufStart - timeSeconds).toFixed(1)}s)`);
                v.currentTime = bufStart;
              }
              // Cache VBR-corrected position for future seeks
              if (vbrAttempts > 0) {
                const existing = tsKeyframeIndexRef.current;
                const newEntry = { timestamp: bufStart, byteOffset: byteOffset };
                const filtered = existing.filter(k => Math.abs(k.timestamp - bufStart) > 5);
                filtered.push(newEntry);
                filtered.sort((a, b) => a.timestamp - b.timestamp);
                tsKeyframeIndexRef.current = filtered;
                diagLog(`[MPEGTS] Recreate VBR keyframe cached: ${bufStart.toFixed(1)}s -> byte ${byteOffset}`);
              }
              clearInterval(alignIv);
              // DON'T clear seekTargetTime here — let onTime handler clear it
              // when currentTime catches up within 2s. Clearing it here would
              // cause a visible bar jump if bufStart differs from the target.

              // PREFETCH-PAUSE handling: a disk-cache-hit seek is allowed while
              // paused because it reads LOCAL cached data, not Telegram. Stop the
              // proactive prebuffer immediately (a separate Telegram downloader) —
              // but do NOT pause the loader on this first align tick. The cached
              // window (up to 180s) has only partially drained into the
              // SourceBuffer here; pausing now truncates delivery mid-segment and
              // the video never plays (the reported bug). Instead let the loader
              // finish delivering the on-disk cached data, then pause it at the
              // cache boundary — detected as buffered.end no longer advancing
              // (loader stalled waiting on uncached bytes → about to hit the
              // backend's 5s STREAM-CACHE-WAIT → Telegram fallback). Pausing at a
              // 750ms stall (<< 5s) aborts that boundary request before Telegram
              // starts, honoring "paused = no Telegram" while still playing all
              // cached data. (See video-streaming skill rev6-FINAL.)
              if (isPausedRef.current) {
                const ppMsgId = proactivePrebufferMsgIdRef.current;
                if (ppMsgId) invoke('cmd_stop_proactive_prebuffer', { messageId: ppMsgId }).catch(() => {});
                if (proactiveIntervalRef.current) {
                  clearInterval(proactiveIntervalRef.current);
                  proactiveIntervalRef.current = null;
                }
                let lastBufEnd = -1, stalledTicks = 0, bpTicks = 0;
                const boundaryIv = setInterval(() => {
                  bpTicks++;
                  const io = (mpegtsPlayerRef.current as any)?._player_engine?._transmuxer?._controller?._ioctl;
                  // Bail if superseded, resumed, timed out (30s), or loader gone.
                  if (alignGen !== mpegtsRecreationGenRef.current || !isPausedRef.current || bpTicks > 120 || !io) {
                    clearInterval(boundaryIv); return;
                  }
                  if (io._paused) { clearInterval(boundaryIv); return; } // lazyLoad already paused it at 180s
                  const vNow = videoRef.current;
                  const bufEnd = vNow && vNow.buffered.length > 0 ? vNow.buffered.end(vNow.buffered.length - 1) : 0;
                  if (bufEnd <= lastBufEnd + 0.01) {
                    // No new data this tick — loader stalled at the cache boundary.
                    if (++stalledTicks >= 3) { // 3 × 250ms = 750ms
                      try { io.pause(); } catch (_) {}
                      clearInterval(boundaryIv);
                      diagLog('[MPEGTS] Paused loader at cache boundary (prefetch paused) — cached data played, no Telegram fetch');
                    }
                  } else {
                    stalledTicks = 0;
                    lastBufEnd = bufEnd;
                  }
                }, 250);
              }

              // If play was deferred (depth=0 first attempt), start playback now
              if (v && v.paused) v.play().catch(() => {});
            }
          }, 500);
        }
      } else {
        diagLog('[MPEGTS] Recreated player — IOController still null');
      }

      // Set duration override
      if (dur && dur > 0 && isFinite(dur)) {
        const ms = engine?._mse_controller?.getObject?.();
        if (ms && ms.readyState === 'open') {
          try { ms.duration = dur; } catch (_) {}
        }
        state.current.duration = dur;
        mpegtsDurationRef.current = dur;
      }

      // Fire-and-forget play — but DEFER on first attempt to avoid VBR flicker.
      // On depth=0 (first try, VBR error unknown), we pause and let the align poll
      // decide: if VBR correction fires, the user never sees wrong content. If no
      // correction needed, the align poll calls play() after aligning.
      // On depth>=1 (VBR-corrected), play immediately — the position is already close.
      const deferPlay = (vbrDepth ?? 0) === 0;
      if (!deferPlay) {
        const playResult = newPlayer.play();
        if (playResult && typeof playResult.catch === 'function') {
          playResult.catch((_: any) => {});
        }
        diagLog(`[MPEGTS] Recreated player — play() fired for ${timeSeconds.toFixed(1)}s`);
      } else {
        // Pause to prevent showing wrong content; align poll will play() after check
        if (video && !video.paused) video.pause();
        diagLog(`[MPEGTS] Recreated player — deferred play for VBR check at ${timeSeconds.toFixed(1)}s`);
      }

    } catch (e: any) {
      diagLog(`[MPEGTS] Player recreation failed: ${e.message}`);
    }
  };

  /**
   * Recreate the mpegts.js player for a seek on a REMUX-transcoded source
   * (HEVC MKV etc. — see needsRemuxSeekRef). Unlike _mpegtsRecreatePlayerForSeek,
   * this does NOT byte-seek /stream/ (which is a non-TS Matroska container).
   * Instead it points the player at /remux?ss=<time> and loads from byte 0 of
   * that stream — ffmpeg performs the (frame-accurate) seek server-side and
   * emits fresh MPEG-TS whose video PTS is ABSOLUTE (≈ seek target). We pre-set
   * the remuxer _dtsBase=0 so those absolute PTS pass straight through to
   * video.currentTime (verified: ss=580 → first video PTS ≈581.4s).
   *
   * Concurrency (E2): bumps mpegtsRecreationGenRef; a newer seek supersedes this
   * one and its destroyed player's fetch abort triggers the backend's
   * kill_on_drop → the orphaned ffmpeg is reaped, so only one ffmpeg is ever live.
   *
   * Paused-aware (E5): if the player is paused ("paused means paused"), we do NOT
   * autoplay after recreation — we set currentTime and leave it paused.
   */
  const _mpegtsRecreatePlayerForRemuxSeek = async (timeSeconds: number, durationOverride: number) => {
    const video = videoRef.current;
    if (!video) return;
    const baseUrl = remuxSeekBaseUrlRef.current;
    if (!baseUrl) {
      diagLog('[MPEGTS] Remux seek: no base remux URL — cannot recreate');
      return;
    }

    // E2: supersede any in-flight recreation. A newer seek wins; older bails.
    const gen = ++mpegtsRecreationGenRef.current;
    const wasPaused = isPausedRef.current || video.paused;

    // Build the seek URL. BYTE-FORWARD (start_byte) is used ONLY when the
    // underlying /stream bytes are real MPEG-TS (timed_id3) — the backend
    // feeds ffmpeg [init_prefix + /stream bytes] via stdin, which avoids the
    // `-ss`-over-uncached-HTTP failure (logs 4-t/5-t). For MKV/MP4 sources the
    // /stream bytes are Matroska/ISOBMFF and a mid-file slice on stdin dies
    // with "Invalid data found" (execution-proven), so those ALWAYS seek with
    // ffmpeg -ss over the seekable HTTP input. The byte offset uses the same
    // linear time→byte estimate the proactive reporter uses below; the backend
    // TS-aligns it and ffmpeg resyncs to the first keyframe.
    const _seekDur = mpegtsDurationRef.current || state.current.duration || 0;
    const _seekFileSize = state.current.fileLength;
    const startByteEstimate = computeRemuxSeekStartByte(
      remuxSourceIsTsRef.current, timeSeconds, _seekDur, _seekFileSize);
    const seekUrl = buildRemuxSeekUrl(baseUrl, timeSeconds, startByteEstimate);
    if (!seekUrl) {
      diagLog('[MPEGTS] Remux seek: could not build seek URL — bailing');
      return;
    }
    diagLog(`[MPEGTS] Remux seek: recreating from ${seekUrl} (paused=${wasPaused})`);

    // 1. Destroy the current player. Pausing first cancels mpegts.js's pending
    //    SeekingHandler timeout (see _mpegtsRecreatePlayerForSeek). Destroying
    //    aborts the ChunkedFetchLoader fetch → server stream drops → the old
    //    /remux ffmpeg is reaped by kill_on_drop.
    const oldPlayer = mpegtsPlayerRef.current;
    if (oldPlayer) {
      try {
        if (!video.paused) video.pause();
        oldPlayer.detachMediaElement();
        oldPlayer.unload();
        oldPlayer.destroy();
      } catch (_) {}
      mpegtsPlayerRef.current = null;
    }

    // Yield so GC can reclaim the old player's buffers before we allocate new.
    await new Promise<void>(r => setTimeout(r, 0));
    if (gen !== mpegtsRecreationGenRef.current) {
      diagLog(`[MPEGTS] Remux seek superseded during teardown (gen ${gen}) — bailing`);
      return;
    }

    try {
      const mpegts = await import('mpegts.js');
      const MpegtsPlayer = mpegts.default || mpegts;
      if (gen !== mpegtsRecreationGenRef.current) return;

      const dur = durationOverride || mpegtsDurationRef.current || state.current.duration;

      // E1: filesize MUST be undefined. The /remux?ss= body is a fresh ffmpeg
      // pipe whose byte 0 is NOT file byte 0, and its length is unknown. If we
      // passed the source filesize, the loader would treat `from >= filesize`
      // as completion and stop early. undefined → read continuously to EOF.
      const newPlayer = MpegtsPlayer.createPlayer({
        type: 'mpegts',
        isLive: false,
        url: seekUrl,
        duration: dur,
        filesize: undefined, // E1 — see above
        hasAudio: true,
        hasVideo: true,
        cors: true,
      }, {
        enableWorker: false,
        enableStashBuffer: true,
        stashInitialSize: 1024 * 1024,
        fixAudioTimestampGap: false,
        // lazyLoad MUST be OFF for the /remux pipe. mpegts.js lazyLoad throttles
        // by aborting the loader and resuming via a byte-seek (io.resume() →
        // _internalSeek(byte)). On the non-seekable ffmpeg pipe that resume
        // re-opens the URL → a SECOND ffmpeg QSV transcode from the same ss point,
        // which re-emits overlapping absolute-PTS bytes the remuxer drops →
        // playback starves ~3s after the seek (proven: trace 17-c/17-t, stack:
        // loading-controller._resumeTransmuxerIfNeeded → io-controller.resume →
        // _internalSeek(779824) → new /remux GET). It suspends spuriously too:
        // notifyBufferedPositionChanged uses the segment's ABSOLUTE endDts (~718s)
        // vs currentTime=0 (pre-align) → 718 >= 0+180 → suspend on the very first
        // segment. With lazyLoad OFF the transmuxer never suspends/resume-seeks;
        // the loader reads the pipe continuously to EOF (matches the E1 intent).
        // Transcode-ahead is instead throttled by read backpressure in the loader
        // (getBufferedAheadSeconds below) so the SourceBuffer never overfills.
        lazyLoad: false,
        seekType: 'range',
        customLoader: createChunkedFetchLoader(MpegtsPlayer),
        shadowCache: null, // ss-stream bytes aren't file-addressable — no shadow cache
        // Pipe backpressure: throttle ffmpeg by stalling reads when the buffer is
        // far ahead of the playhead. Returns 0 (no throttle) until currentTime is
        // inside a buffered range, so pre-align warmup at ct=0 is never throttled.
        getBufferedAheadSeconds: () => {
          const vEl = videoRef.current;
          if (!vEl) return 0;
          const ct = vEl.currentTime;
          const b = vEl.buffered;
          for (let i = 0; i < b.length; i++) {
            if (ct >= b.start(i) && ct < b.end(i)) return b.end(i) - ct;
          }
          return 0;
        },
        pipeBackpressureMaxAhead: 60,
        pipeBackpressureHysteresis: 15,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 60,
        autoCleanupMinBackwardDuration: 30,
        accurateSeek: false,
        // Load from byte 0 immediately (default defer is fine — we do NOT
        // ioctl.seek here; ffmpeg already did the seek). Keep it synchronous
        // so we can pre-set _dtsBase before the first chunk is transmuxed.
        deferLoadAfterSourceOpen: false,
        firstChunkSize: alignChunkSize(5 * 1024 * 1024),
        chunkSize: alignChunkSize(10 * 1024 * 1024),
        postSeekFirstChunkSize: alignChunkSize(12 * 1024 * 1024),
      } as any);

      newPlayer.attachMediaElement(video);
      mpegtsPlayerRef.current = newPlayer;

      newPlayer.on(MpegtsPlayer.Events.ERROR, (_type: string, detail: string) => {
        diagLog(`[MPEGTS] Remux-seek player error: ${detail}`);
      });
      // DIAG (remove once remux-seek append is confirmed): the initial player
      // waits on MEDIA_INFO to know the demuxer probed the stream. The recreate
      // path never hooked it, so we can't tell if the demuxer ever initializes.
      // If MEDIA_INFO never fires here, the TS demuxer never probed the ss-stream
      // → nothing is ever appended → buffered stays EMPTY (the reported bug).
      newPlayer.on(MpegtsPlayer.Events.MEDIA_INFO, (info: any) => {
        diagLog(`[MPEGTS] Remux-seek MEDIA_INFO fired: video=${info?.videoCodec} audio=${info?.audioCodec} (demuxer probed OK)`);
      });
      newPlayer.on(MpegtsPlayer.Events.STATISTICS_INFO, (stats: any) => {
        if ((stats?.decodedFrames ?? 0) > 0 && (stats.decodedFrames % 60 === 0)) {
          diagLog(`[MPEGTS] Remux-seek stats: decodedFrames=${stats.decodedFrames} speed=${stats.speed?.toFixed?.(1)}`);
        }
      });

      newPlayer.load();
      if (gen !== mpegtsRecreationGenRef.current) {
        diagLog(`[MPEGTS] Remux seek superseded after load (gen ${gen}) — tearing down`);
        if (mpegtsPlayerRef.current !== newPlayer) {
          try { newPlayer.detachMediaElement(); newPlayer.unload(); newPlayer.destroy(); } catch (_) {}
        }
        return;
      }

      // ── ABSOLUTE-TIMELINE PIN (robust design, replaces the old pre-bootstrap) ──
      // /remux?ss=T emits MPEG-TS with ABSOLUTE first PTS (≈T). We want the output
      // timeline absolute (video.currentTime ≈ T) so the seek bar / green bar /
      // byte↔time map — all of which read currentTime as source-absolute — stay
      // correct. mpegts.js normally normalizes to 0 via MP4Remuxer._calculateDtsBase
      // on the first remux(); pinning _dtsBase=0 keeps it absolute.
      //
      // We must NOT pre-create the demuxer/remuxer before load()'s byte-0 prober
      // runs: _setupTSDemuxerRemuxer ends with demuxer.bindDataSource(ioctl), which
      // overwrites ioctl.onDataArrival (the prober installed by _loadSegment) with
      // parseChunks. On the ss-stream (byteStart 0) that makes real ffmpeg bytes
      // bypass TSDemuxer.probe() → demuxer never syncs → MEDIA_INFO never fires →
      // buffered stays EMPTY forever (root cause proven across logs 7/8/9).
      //
      // Instead: let the LIBRARY'S real byte-0 probe build the demuxer+remuxer, and
      // wrap _setupTSDemuxerRemuxer so the pin lands the instant the remuxer exists —
      // BEFORE the following parseChunks→remux() runs _calculateDtsBase. This touches
      // the probe path zero times. Idempotent + null-safe via pinRemuxerDtsBase.
      const engine = (newPlayer as any)?._player_engine;
      const tCtrl = engine?._transmuxer?._controller;
      if (tCtrl && typeof tCtrl._setupTSDemuxerRemuxer === 'function') {
        const originalSetup = tCtrl._setupTSDemuxerRemuxer.bind(tCtrl);
        tCtrl._setupTSDemuxerRemuxer = (probeData: any) => {
          originalSetup(probeData);              // real probe builds demuxer + remuxer
          const pinned = pinRemuxerDtsBase(tCtrl._remuxer);  // pin BEFORE first remux()
          diagLog(`[MPEGTS] Remux-seek: real probe built demuxer, _dtsBase pinned=${pinned} for ss=${timeSeconds.toFixed(1)}s probe=${JSON.stringify(probeData)}`);

          // DIAG (remove once remux-seek append confirmed): the pin fires but
          // MEDIA_INFO never does and buffered stays EMPTY — so the demuxer is built
          // yet emits no track metadata. Instrument the demuxer itself to state
          // plainly whether parseChunks keeps consuming bytes and whether the
          // codec/metadata callbacks ever fire. This is the ONE datapoint that
          // separates "loader stops feeding" from "demuxer rejects the TS".
          // NOTE: originalSetup already ran demuxer.bindDataSource(ioctl), which sets
          // ioctl.onDataArrival = demuxer.parseChunks.bind(demuxer) — a captured copy.
          // So we must wrap ioctl.onDataArrival (what the loader actually invokes),
          // NOT dmx.parseChunks (which the loader no longer references).
          const dmx: any = tCtrl._demuxer;
          const ioctl: any = tCtrl._ioctl;
          if (dmx && ioctl && typeof ioctl.onDataArrival === 'function') {
            let parseN = 0, fedBytes = 0, lastConsumed = -1;
            const boundParse = ioctl.onDataArrival;   // demuxer.parseChunks (bound)
            ioctl.onDataArrival = (data: ArrayBuffer, byteStart: number) => {
              parseN++;
              const c = boundParse(data, byteStart);
              fedBytes += (data as any).byteLength;
              lastConsumed = c;
              if (parseN <= 30 || parseN % 20 === 0) {
                const head = new Uint8Array((data as any).slice(0, 4));
                diagLog(`[MPEGTS] Remux-seek parseChunks #${parseN}: byteStart=${byteStart} len=${(data as any).byteLength} consumed=${c} totalFed=${fedBytes} head0=0x${head[0].toString(16)} sync0x47=${head[0] === 0x47}`);
              }
              return c;
            };
            const origMI = dmx.onMediaInfo;
            dmx.onMediaInfo = (info: any) => {
              diagLog(`[MPEGTS] Remux-seek demuxer.onMediaInfo: v=${info?.videoCodec} a=${info?.audioCodec} (parses so far=${parseN}, lastConsumed=${lastConsumed})`);
              if (typeof origMI === 'function') return origMI.call(dmx, info);
            };
            // DIAG (remove once remux-seek append confirmed): onMediaInfo only fires
            // when MediaInfo.isComplete() — which needs BOTH video AND audio metadata
            // (player created with hasAudio:true, hasVideo:true). Data flows and
            // parseChunks consumes, yet onMediaInfo never fires → exactly ONE track's
            // init segment is never dispatched. Wrap onTrackMetadata to name which
            // track (video/audio) resolves and which is missing — the decisive datapoint.
            const origTM = dmx.onTrackMetadata;
            dmx.onTrackMetadata = (type: string, meta: any) => {
              diagLog(`[MPEGTS] Remux-seek onTrackMetadata: type=${type} codec=${meta?.codec} ${type === 'video' ? `${meta?.codecWidth}x${meta?.codecHeight}` : `sr=${meta?.audioSampleRate} ch=${meta?.channelCount}`} (parse #${parseN})`);
              if (typeof origTM === 'function') return origTM.call(dmx, type, meta);
            };
          } else {
            diagLog(`[MPEGTS] Remux-seek: cannot instrument parse path (dmx=${!!dmx} ioctl=${!!ioctl} onDataArrival=${typeof ioctl?.onDataArrival})`);
          }
        };
        // If the remuxer somehow already exists (defensive; shouldn't for a fresh
        // player), pin it now so we never miss the window.
        if (tCtrl._remuxer) pinRemuxerDtsBase(tCtrl._remuxer);
      } else {
        diagLog(`[MPEGTS] Remux seek: no transmux controller to wrap (tCtrl=${!!tCtrl}) — timeline may normalize to 0`);
      }

      // Duration override so the seek bar range stays correct.
      if (dur && dur > 0 && isFinite(dur)) {
        const ms = engine?._mse_controller?.getObject?.();
        if (ms && ms.readyState === 'open') {
          try { ms.duration = dur; } catch (_) {}
        }
        state.current.duration = dur;
        mpegtsDurationRef.current = dur;
      }

      // Show the seek target on the bar until currentTime catches up.
      (window as any).__nobuf_seekTargetTime = timeSeconds;

      // E5: honor pause. Only autoplay if we were playing before the seek.
      // DEFERRED PLAY (stutter fix): do NOT call play() here. The buffer is still
      // EMPTY at this point (the align-poll below waits ~6 ticks / ~3s for the
      // first ss-stream frames to append). Calling play() now parks the freshly
      // recreated <video> element "playing at currentTime=0 with an empty buffer",
      // which (a) shows a frozen frame at 0, (b) trips faststream's StartupStallJumper
      // watchdog ("stuck at 0, seek to X") which issues its OWN competing seek, and
      // (c) then visibly JUMPS 0 → ~seekTarget when the buffer finally appears — the
      // "split-second back-and-forth stutter" the user reported (proven logs 9-c:
      // L98 "stuck at 0, seek to 944.331" fired before the L105 buffer at 944.3).
      // Instead: leave it effectively paused during the align window; the align-poll
      // starts playback (v.play()) exactly once, AFTER it snaps currentTime into the
      // populated buffer. wasPaused is captured above and consumed there.
      if (wasPaused) {
        if (!video.paused) video.pause();
        diagLog(`[MPEGTS] Remux seek: stayed paused at ${timeSeconds.toFixed(1)}s (paused means paused)`);
      } else {
        // Keep the element paused until the align-poll has real content to show, so
        // it never sits "playing" over an empty buffer at ct=0.
        if (!video.paused) video.pause();
        diagLog(`[MPEGTS] Remux seek: play() DEFERRED until buffer populated (align-poll) for ${timeSeconds.toFixed(1)}s`);
      }

      // ── ALIGN POLL (the fix for "prebuffer starts but video won't play") ──
      // ffmpeg's /remux?ss= emits ABSOLUTE-PTS TS (verified by execution: a seek
      // to 60s yields first video PTS ≈59.4s), and _dtsBase=0 passes that through
      // unchanged — so the SourceBuffer lands at ~timeSeconds while the freshly
      // recreated <video> element sits at currentTime=0. Nothing bridges that gap
      // (unlike _mpegtsRecreatePlayerForSeek, which sets currentTime + aligns), so
      // the element stalls at 0 forever waiting for data at t=0 that never comes.
      // Poll until the first buffered range appears, then snap currentTime to its
      // start (± a small margin) so playback begins at the seeked content.
      {
        const alignGen = gen; // capture for supersede check
        let alignTicks = 0;
        const alignIv = setInterval(() => {
          alignTicks++;
          // Bail if superseded, timed out (30 × 500ms = 15s), or unmounted.
          if (alignGen !== mpegtsRecreationGenRef.current || alignTicks > 30 || !videoRef.current) {
            // DIAG (remove once remux-seek append is confirmed): name the bail
            // reason so a stuck seek is never silent again.
            const reason = alignGen !== mpegtsRecreationGenRef.current ? 'superseded'
              : alignTicks > 30 ? 'timeout-15s(buffer never populated)' : 'unmounted';
            diagLog(`[MPEGTS] Remux seek align: BAIL (${reason}) after ${alignTicks} ticks, gen=${gen}`);
            clearInterval(alignIv);
            // DEFERRED-PLAY safety net: we withheld play() at seek time (stutter fix).
            // If we bail on TIMEOUT (buffer genuinely never populated) but we were
            // supposed to be playing, resume so the element isn't left paused forever
            // on a legit slow seek — the native waiting/canplay will take over. Do NOT
            // resume on 'superseded' (a newer seek now owns playback) or 'unmounted'.
            if (reason.startsWith('timeout') && !wasPaused) {
              const bv = videoRef.current;
              if (bv && bv.paused) { const pr = bv.play(); if (pr && typeof pr.catch === 'function') pr.catch(() => {}); }
            }
            return;
          }
          const v = videoRef.current;
          // DIAG (remove once confirmed): dump the append pipeline state every
          // tick. If buffered stays empty while ffmpeg emits frames, the recreated
          // mpegts.js player isn't appending — the fault is upstream of this poll.
          const eng: any = (mpegtsPlayerRef.current as any)?._player_engine;
          const ms = eng?._mse_controller?.getObject?.();
          const nBuf = v.buffered.length;
          const bufDump = nBuf > 0
            ? Array.from({ length: nBuf }, (_, i) => `${v.buffered.start(i).toFixed(1)}-${v.buffered.end(i).toFixed(1)}`).join(',')
            : 'EMPTY';
          diagLog(`[MPEGTS] Remux seek align tick ${alignTicks}: buffered=[${bufDump}] ct=${v.currentTime.toFixed(2)} rs=${v.readyState} err=${v.error?.code ?? '-'} msRS=${ms?.readyState ?? '-'} paused=${v.paused}`);
          if (v.buffered.length > 0) {
            const bufStart = v.buffered.start(0);
            // Only jump if currentTime hasn't already landed inside the buffer.
            // A fresh recreation leaves currentTime≈0 while bufStart≈timeSeconds;
            // the >0.05s guard avoids a redundant re-seek once aligned.
            if (Math.abs(bufStart - v.currentTime) > 0.05) {
              // Land just INSIDE the buffered range and route the set through
              // mpegts.js's own SeekingHandler.directSeek, which sets
              // _request_set_current_time so the resulting native `seeking` event
              // is SUPPRESSED. A raw `v.currentTime = bufStart` is read by mpegts.js
              // as a user seek: _isPositionBuffered() is `t >= from && t < to`, and
              // the <video> element can clamp the set a hair BELOW buffered.start(0)
              // → currentTime < from → unbuffered → seeking-handler.seek() →
              // _on_unbuffered_seek → transmuxer.seek() → ioctl.seek() → a fresh
              // /remux GET (an extra transcode). directSeek avoids that; +0.05s
              // keeps even a clamped value inside the range.
              // NOTE: this is NOT what caused the trace-17 double-transcode — that
              // was lazyLoad's resume-by-byte-seek (now fixed via lazyLoad:false +
              // read backpressure above). This suppression is defense for the
              // separate align-set path and is cheap to keep.
              const snapTarget = bufStart + 0.05;
              diagLog(`[MPEGTS] Remux seek align: target ${timeSeconds.toFixed(1)}s → buffer start ${bufStart.toFixed(1)}s (delta ${(bufStart - timeSeconds).toFixed(1)}s), snapping to ${snapTarget.toFixed(2)}s (suppressed)`);
              const alignEng: any = (mpegtsPlayerRef.current as any)?._player_engine;
              const alignSeekHandler: any = alignEng?._seeking_handler;
              if (alignSeekHandler && typeof alignSeekHandler.directSeek === 'function') {
                alignSeekHandler.directSeek(snapTarget);
              } else {
                v.currentTime = snapTarget;
              }
            }
            clearInterval(alignIv);
            // DON'T clear __nobuf_seekTargetTime here — the onTime handler clears
            // it when currentTime catches up within 2s, avoiding a bar jump if
            // bufStart differs slightly from the target.
            // DEFERRED-PLAY resume: play() was intentionally NOT called at seek time
            // (see above) to avoid the "playing over an empty buffer at ct=0" stutter
            // + StartupStallJumper race. Now that currentTime is snapped INTO the
            // populated buffer, start playback exactly once (only if we were playing
            // before the seek — "paused means paused"). Guard on v.paused is dropped:
            // the directSeek above can leave it paused, and we always paused up-front.
            if (!wasPaused) {
              const pr = v.play();
              if (pr && typeof pr.catch === 'function') pr.catch(() => {});
              diagLog(`[MPEGTS] Remux seek: play() started after align snap (ct=${v.currentTime.toFixed(2)}s)`);
            }
          }
        }, 500);
      }

      // Clear the seek-in-progress flag now that the new player is wired.
      (window as any).__nobuf_userSeekInProgress = false;

      // Reposition the backend proactive prebuffer to the seek target. This is
      // the ONLY trigger that starts/slides the proactive task; without it the
      // task keeps filling the disk cache from wherever the initial bootstrap
      // left off (front of file) instead of racing ahead of the new seek point.
      // Use a linear byte estimate: VBR correction isn't available here, but
      // it's close enough to steer the downloader to the right region.
      if (!isPausedRef.current) {
        const _fileId = file?.id;
        const _folderId = activeFolderId; // null = "home" — backend accepts Option
        const _fileSize = state.current.fileLength;
        const _dur = mpegtsDurationRef.current || state.current.duration || 0;
        if (_fileId && _fileSize > 0 && _dur > 0) {
          proactivePrebufferMsgIdRef.current = _fileId;
          const seekByte = Math.round((timeSeconds / _dur) * _fileSize);
          invoke('cmd_report_playback_position', {
            messageId: _fileId,
            folderId: _folderId,
            currentTimeS: timeSeconds,
            durationS: _dur,
            fileSize: _fileSize,
            isPlayerDownloading: true,
            playbackRate: 1.0,
            byteOffset: seekByte,
          }).catch(() => {});
          diagLog(`[MPEGTS] Remux seek: reported position to proactive (byte ${seekByte}, t=${timeSeconds.toFixed(1)}s)`);
        }
      }
    } catch (e: any) {
      diagLog(`[MPEGTS] Remux-seek recreation failed: ${e.message}`);
      (window as any).__nobuf_userSeekInProgress = false;
    }
  };

  /**
   * Initialize the client-side MediabunnyTransmuxer player for an H.264 MKV.
   *
   * WHY (not /remux → mpegts.js): the ffmpeg-remux path plays MKV but its
   * seek engine byte-seeks the raw /stream (Matroska) bytes, which the TS
   * demuxer can't parse (`sync_byte != 0x47`) — seek is structurally broken.
   * mediabunny instead demuxes the MKV in-browser and transmuxes to fMP4,
   * with native keyframe/cluster seeking (MediabunnyTransmuxer.seekTo). Same
   * engine already proven for MKV hover-thumbnails on this exact content.
   *
   * This restores the previously-working transmuxer player wiring (git
   * d6630a4), adapted to the current architecture and MKV-gated. Returns true
   * on success; false → caller should fall back (native / remux).
   *
   * @param seedData in-memory header bytes (the 20MB MKV prefetch) — reads
   *   within [0, seedData.byteLength] bypass HTTP, eliminating per-request
   *   Tauri/WebView2 round-trips that otherwise make init take 30s+.
   */
  /**
   * MKV disk-cache warmer — the green-bar counterpart to MP4's downloadLoop.
   *
   * WHY THIS EXISTS (and why it's separate from the transmuxer):
   * MP4's green bar reaches EOF because its downloadLoop issues SEQUENTIAL Range
   * requests 0→fileLength against /stream, and every /stream fetch is written to
   * the backend disk cache (cached_ranges). The MKV path never does a sequential
   * walk: mediabunny only PULLS scattered cluster bytes for decode, so the disk
   * cache fills as sparse islands and the bar never marches to EOF.
   * We CANNOT fix this by widening the transmuxer window — mediabunny's
   * Conversion.execute() cannot be paused (confirmed: it exposes only
   * init/execute/cancel + trim{start,end}), so running it far ahead races the
   * playhead and the eviction backpressure punches permanent holes → stall
   * (documented at the startStreamingChain prime comment).
   *
   * So we mirror MP4 at the layer that actually fills the bar: a sequential
   * 0→EOF Range walk over /stream that warms the SAME disk cache mediabunny
   * later reads from (cache hits — no double download). It is fully decoupled
   * from the transmuxer/Conversion and from the 30s MSE playback buffer.
   *
   * COORDINATOR SAFETY: uses a distinct source_id ("warmer") so the backend's
   * zombie-cancel logic never cross-cancels it against the player's scattered
   * "playback" seek reads (TauriStreamSource uses source_id "playback"). The
   * warmer yields (throttles) while the player is actively fetching so playback
   * always wins the rate-limiter budget.
   */
  const startMkvDiskWarmer = (baseStreamUrl: string, startByte: number = 0) => {
    const gen = ++mkvWarmerGenRef.current;  // supersedes any prior warmer (e.g. after a seek)
    const fileLen = state.current.fileLength;
    if (!fileLen || fileLen <= 0) return;
    // Distinct source_id so the coordinator treats this as its own sequential
    // download, isolated from the player's "playback" reads.
    const sep = baseStreamUrl.includes('?') ? '&' : '?';
    const warmerUrl = `${baseStreamUrl}${sep}source_id=warmer`;

    mkvWarmerActiveRef.current = true;
    const WARMER_CHUNK = 4 * 1024 * 1024; // 4 MiB sequential chunks
    // Align start to a chunk boundary so warmed ranges stay chunk-aligned with
    // the coordinator's download granularity. Arithmetic (not bitwise) — byte
    // offsets exceed 2^31 (file is 1.76GB), so & would overflow 32-bit ints.
    const clampedStart = Math.max(0, Math.min(startByte, fileLen - 1));
    const alignedStart = clampedStart - (clampedStart % WARMER_CHUNK);

    (async () => {
      let offset = alignedStart;
      try {
        while (
          !cancelledRef.current &&
          gen === mkvWarmerGenRef.current &&
          offset < fileLen
        ) {
          // Yield to playback: if the player is actively downloading (cold
          // start / seek / refill fetching), sleep so /stream gets the full
          // rate-limiter budget. The disk warm is best-effort background work.
          // Includes transmuxerSeekInProgressRef so the warmer stays throttled
          // for the ENTIRE seek — including the multi-second transmux iteration
          // that runs after bufferingForSeekRef flips false (trace-31 fix).
          if (shouldWarmerYield(
            state.current.downloading,
            bufferingForSeekRef.current,
            transmuxerSeekInProgressRef.current,
          )) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }

          const end = Math.min(offset + WARMER_CHUNK - 1, fileLen - 1);

          // Skip ranges already on disk so we don't re-request cached bytes.
          // trackDownloadedRange below still records the range for the bar;
          // the backend serves cached hits instantly.
          let resp: Response | null = null;
          try {
            resp = await fetch(warmerUrl, { headers: { Range: `bytes=${offset}-${end}` } });
          } catch {
            // Transient network/HTTP error — back off and retry same offset.
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          if (cancelledRef.current || gen !== mkvWarmerGenRef.current) break;

          if (resp.status === 503) {
            // Backend at max concurrent downloads — retry this offset later.
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          if (!resp.ok && resp.status !== 206) {
            // Non-recoverable for this range — stop warming (don't spin).
            break;
          }

          const buf = await resp.arrayBuffer();
          if (cancelledRef.current || gen !== mkvWarmerGenRef.current) break;
          const got = buf.byteLength;
          if (got <= 0) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }

          // Warm the green bar with the REAL fetched range (contiguous,
          // unlike the transmuxer's estimated islands). Disk-cache accounting
          // happens in the backend at the download site itself.
          trackDownloadedRange(offset, offset + got - 1);

          offset += got;
        }
        if (!cancelledRef.current && gen === mkvWarmerGenRef.current) {
          diagLog(`[MSE] MKV disk warmer finished at byte ${offset}/${fileLen}`);
        }
      } catch (e: any) {
        if (!cancelledRef.current) diagLog(`[MSE] MKV disk warmer error: ${e?.message ?? String(e)}`);
      } finally {
        if (gen === mkvWarmerGenRef.current) mkvWarmerActiveRef.current = false;
      }
    })();
  };

  const _initMkvTransmuxerPlayer = async (
    url: string,
    mediaSource: MediaSource,
    blobUrl: string,
    seedData: ArrayBuffer,
  ): Promise<boolean> => {
    const transmuxer = new MediabunnyTransmuxer({
      format: 'mkv',
      sourceConfig: {
        url,
        fileSize: state.current.fileLength,
        maxCacheSize: 32 * 1024 * 1024, // 32 MiB — avoids duplicate range requests during concurrent video+audio iteration (default 8 MiB too small)
        prefetchProfile: 'network',     // 3 workers, aggressive random prefetch — fast random access for seek
        seedData,                       // header bytes served from memory (zero-latency init)
        sourceId: 'playback',           // isolates player reads from the thumbnail pipeline in the backend coordinator (source_ids_match)
      },
      onInitSegment: (segData: ArrayBuffer) => {
        if (cancelledRef.current) return;
        diagLog(`[MSE] MKV transmuxer init segment: ${segData.byteLength} bytes`);
        // During seek: buffer until setTimestampOffset() runs (it clears the SB
        // queue, so segments queued before the offset is set would be lost).
        if (bufferingForSeekRef.current) {
          seekBufferRef.current.push({ type: 'init', data: segData.slice(0) });
          initSegmentsRef.current = [{ id: 1, buffer: segData.slice(0) }];
          return;
        }
        state.current.videoSourceBuffer?.appendBuffer(segData);
        initSegmentsRef.current = [{ id: 1, buffer: segData.slice(0) }];
      },
      onMediaSegment: (segData: ArrayBuffer, timestamp: number) => {
        if (cancelledRef.current) return;
        if (bufferingForSeekRef.current) {
          seekBufferRef.current.push({ type: 'media', data: segData.slice(0), timestamp });
          return;
        }
        // Non-buffering append (defensive — in the refill model segments normally
        // flow through bufferingForSeekRef and are flushed by executeStreamingRefill).
        // Evict only data BEHIND the playhead (evictOldBuffer). Do NOT evict
        // ahead-of-playhead data here: the bounded refill chain already caps
        // lookahead, and evicting ahead-data from a sequential producer that
        // won't re-emit it punches a permanent hole that stalls playback.
        evictOldBuffer();
        state.current.videoSourceBuffer?.appendBuffer(segData);
        // Progress: transmuxer timestamps are relative after a seek trim, so
        // add seekOffsetRef to recover the absolute position.
        const absoluteTimestamp = timestamp + seekOffsetRef.current;
        if (absoluteTimestamp > 0 && state.current.duration > 0 && state.current.duration !== Infinity && state.current.fileLength > 0) {
          const estimatedBytes = Math.floor((absoluteTimestamp / state.current.duration) * state.current.fileLength);
          setPrefetchedBytes(estimatedBytes);
          trackDownloadedRange(estimatedBytes, estimatedBytes + segData.byteLength);
        }
      },
      onDurationKnown: (duration: number) => {
        if (cancelledRef.current) return;
        diagLog(`[MSE] MKV transmuxer duration known: ${duration}s`);
        state.current.duration = duration;
        if (state.current.fileLength > 0 && duration > 0 && duration !== Infinity) {
          state.current.bitrate = state.current.fileLength / duration;
        }
        // Seed byteToTimeTableRef with baseline anchors (0,0) and (fileLength,
        // duration) — same as the TS/mpegts path — so byteToTime() has a valid
        // monotonic mapping from the FIRST seek. Without this the MKV table is
        // empty and the green prebuffer bar either renders far off or vanishes
        // until real seek anchors populate it. Real anchors refine between these.
        if (state.current.fileLength > 0 && duration > 0 && duration !== Infinity
            && byteToTimeTableRef.current.length === 0) {
          byteToTimeTableRef.current = [[0, 0], [state.current.fileLength, duration]];
        }
        try {
          mediaSource.duration = duration;
        } catch (_e) {
          setTimeout(() => { try { mediaSource.duration = duration; } catch (_) {} }, 100);
        }
      },
      onProgressUpdate: (_t: number, estimatedBytes: number) => { if (!cancelledRef.current) setPrefetchedBytes(estimatedBytes); },
      onCodecUnsupported: (codec: string) => {
        if (cancelledRef.current) return;
        diagLog(`[MSE] MKV transmuxer codec unsupported: ${codec}`);
        setError(`Codec not supported for MSE playback: ${codec}`);
        setUseNative(true);
      },
      onError: (error: Error) => {
        if (cancelledRef.current) return;
        diagLog(`[MSE] MKV transmuxer ERROR: ${error.message}`);
        setError(error.message);
        setUseNative(true);
      },
    });

    // Mark init in progress so the fatal-video-error handler doesn't trip
    // fallback during init (the empty blob URL fires error code 4 until data
    // arrives — expected, not fatal).
    transmuxerInitInProgressRef.current = true;

    // Cold-start overlay (parity with MP4/TS): the transmuxer path was silent
    // during its slow startup — metadata probe (~2s) + the initial-prime
    // iteration that transmuxes the first window from Telegram (observed ~18s
    // cold). Show the overlay so the user sees progress instead of a black
    // frame. Phases are advanced inline; dismissed once the buffer is primed.
    setIsColdStartBuffering(true);
    setColdStartPhase('fetching_metadata');
    setColdStartProgress({ bytes: 0, targetBytes: 0 }); // indeterminate — probe/transmux, not a byte target

    const result = await transmuxer.init();
    if (!result || cancelledRef.current) {
      transmuxerInitInProgressRef.current = false;
      setIsColdStartBuffering(false);
      setColdStartPhase('none');
      diagLog('[MSE] MKV transmuxer init FAILED or cancelled');
      try { transmuxer.dispose(); } catch (_) {}
      return false;
    }
    diagLog(`[MSE] MKV transmuxer init success: decision=${result.mseDecision}, mimeType=${result.mimeType}`);
    // Init parsed (duration + cues + Conversion ready); next phase is the
    // initial-prime transmux/download of the first playable window.
    setColdStartPhase('initializing_player');

    // Seed the byte↔time table with the REAL VBR cue anchors mediabunny parsed
    // (time→exact cluster byte). This replaces the linear 2-point baseline so the
    // green prebuffer bar is VBR-accurate from the FIRST frame of any seek —
    // rather than rendering off and self-correcting only after a seek records its
    // own single anchor. Endpoints (0,0)+(fileLength,duration) bracket the cues.
    try {
      const cueIndex = (transmuxer as any).getMkvCueIndex?.() as { time: number; byteOffset: number }[] | undefined;
      const dur = state.current.duration;
      if (cueIndex && cueIndex.length > 0 && state.current.fileLength > 0 && dur > 0 && dur !== Infinity) {
        const table: [number, number][] = [[0, 0]];
        for (const c of cueIndex) {
          if (c.byteOffset > 0 && c.time > 0 && c.byteOffset < state.current.fileLength && c.time < dur) {
            table.push([c.byteOffset, c.time]);
          }
        }
        table.push([state.current.fileLength, dur]);
        table.sort((a, b) => a[0] - b[0]);
        // Dedupe by byte and drop any non-monotonic time (byteToTime needs both strictly increasing).
        const seeded: [number, number][] = [];
        for (const [b, t] of table) {
          const last = seeded[seeded.length - 1];
          if (last && (b - last[0] < 65536 || t <= last[1])) continue;
          seeded.push([b, t]);
        }
        byteToTimeTableRef.current = seeded;
        diagLog(`[MSE] MKV byte↔time table seeded with ${seeded.length} real VBR cue anchors`);
      }
    } catch (_e) { /* non-fatal — keep the linear baseline */ }

    try {
      const sb = mediaSource.addSourceBuffer(result.mimeType);
      state.current.videoSourceBuffer = new SourceBufferWrapper(sb);
      state.current.videoSourceBuffer.setTimestampOffset(0);
      diagLog(`[MSE] MKV: created combined SourceBuffer (${result.mimeType})`);
    } catch (e: any) {
      console.error(`[MSE] MKV: addSourceBuffer failed for "${result.mimeType}":`, e);
      const fallbackMimes = ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4; codecs="avc1.42E01E"', 'video/mp4'];
      for (const mime of fallbackMimes) {
        try {
          if (MediaSource.isTypeSupported(mime)) {
            const sb = mediaSource.addSourceBuffer(mime);
            state.current.videoSourceBuffer = new SourceBufferWrapper(sb);
            state.current.videoSourceBuffer.setTimestampOffset(0);
            console.log(`[MSE] MKV: created SourceBuffer with fallback mime: ${mime}`);
            break;
          }
        } catch (_) { continue; }
      }
      if (!state.current.videoSourceBuffer) {
        transmuxerInitInProgressRef.current = false;
        diagLog('[MSE] MKV: SourceBuffer creation failed — falling back');
        try { transmuxer.dispose(); } catch (_) {}
        return false;
      }
    }

    transmuxerInitInProgressRef.current = false;
    state.current.initialized = true;
    if (initTimeoutRef.current !== null) {
      clearTimeout(initTimeoutRef.current);
      initTimeoutRef.current = null;
    }
    transmuxerRef.current = transmuxer;
    setIsTransmuxerActive(true);
    void blobUrl; // blob URL already set as video.src by the caller

    setIsPrefetching(true);

    // Prime the initial buffer with a BOUNDED window, then hand off to the
    // refill-loop streaming chain — the SAME on-demand mechanism the TS seek
    // path uses. We must NOT call the unbounded transmuxer.startTransmuxing()
    // (Conversion.execute() start→end): it races far ahead of the playhead as
    // fast as it can download, and since mediabunny's Conversion can't be
    // paused, the onMediaSegment backpressure evicts the far-ahead data — which
    // the sequential Conversion never re-emits, leaving a permanent hole at the
    // eviction boundary that stalls playback forever (observed: buffer frozen at
    // [0-37s] while islands appended at 52s+). seekTo(0, INITIAL_SEEK_DURATION)
    // produces a bounded window via Output trim; startStreamingChain() then tops
    // the buffer up on demand, capping how far ahead the Conversion ever runs.
    const sbVideo = state.current.videoSourceBuffer;
    if (!sbVideo) return true;
    bufferingForSeekRef.current = true;
    seekBufferRef.current = [];
    try {
      // Fix #1: stop the initial prime on a keyframe boundary so the buffer end
      // lands ON a keyframe; refill #1 then abuts it with zero overlap/gap.
      const primeStop = transmuxer.nextKeyframeAtOrAfter(INITIAL_SEEK_DURATION) ?? Infinity;
      const keyframeTimestamp = await transmuxer.seekTo(0, INITIAL_SEEK_DURATION, { stopTime: primeStop });
      bufferingForSeekRef.current = false;
      if (cancelledRef.current) return true;

      const tsOffset = keyframeTimestamp ?? 0;
      seekOffsetRef.current = tsOffset;
      await sbVideo.setTimestampOffset(tsOffset);
      const sbAudio = state.current.audioSourceBuffer;
      if (sbAudio) await sbAudio.setTimestampOffset(tsOffset);

      const buffered = seekBufferRef.current;
      seekBufferRef.current = [];
      for (const item of buffered) {
        if (item.trackType === 'audio' && sbAudio) {
          sbAudio.appendBuffer(item.data);
        } else {
          sbVideo.appendBuffer(item.data);
        }
        if (item.type === 'media') {
          const absoluteTimestamp = (item.timestamp ?? 0) + seekOffsetRef.current;
          if (absoluteTimestamp > 0 && state.current.duration > 0 && state.current.fileLength > 0) {
            const estimatedBytes = Math.floor((absoluteTimestamp / state.current.duration) * state.current.fileLength);
            setPrefetchedBytes(estimatedBytes);
            trackDownloadedRange(estimatedBytes, estimatedBytes + item.data.byteLength);
          }
        }
      }
      await sbVideo.waitForQueueDrain();
      if (sbAudio) await sbAudio.waitForQueueDrain();
      diagLog(`[MSE] MKV initial buffer primed at keyframe ${tsOffset.toFixed(2)}s — starting refill chain`);

      // First playable window is in the SourceBuffer — dismiss the cold-start
      // overlay so playback becomes visible (parity with MP4/TS handoff).
      coldStartDeferredRef.current?.resolve();
      coldStartDeferredRef.current = null;
      setIsColdStartBuffering(false);
      setColdStartPhase('none');

      // On-demand refill loop keeps the buffer topped up (bounded lookahead).
      startStreamingChain();

      // Green-bar parity with MP4: warm the disk cache sequentially to EOF in
      // the background (separate source_id, yields to playback). This is what
      // makes the MKV prebuffer bar march to EOF like MP4's, without touching
      // the bounded MSE playback buffer or the unpausable transmuxer Conversion.
      if (url) startMkvDiskWarmer(url);
    } catch (e: any) {
      bufferingForSeekRef.current = false;
      // Dismiss the overlay on prime failure too — otherwise it hangs until the
      // 45s safety timeout.
      coldStartDeferredRef.current?.resolve();
      coldStartDeferredRef.current = null;
      setIsColdStartBuffering(false);
      setColdStartPhase('none');
      const isExpected = e?.message?.includes('has been canceled') ||
        e?.name === 'ConversionCanceledError' ||
        e?.message?.includes('Input has been disposed') ||
        e?.name === 'InputDisposedError';
      if (!isExpected && !cancelledRef.current) {
        console.error('[MSE] MKV initial prime failed:', e);
        setError(e?.message ?? String(e));
      }
    }

    return true;
  };

  /**
   * Initialize the transmuxer player for TS content via mpegts.js.
   * Non-TS formats are routed to native playback in the main setup flow.
   */
  const initTransmuxerPlayer = async (url: string, mediaSource: MediaSource, blobUrl: string, format: DetectedFormat) => {
    if (format !== 'ts') {
      diagLog(`[MSE] initTransmuxerPlayer called for non-TS format ${format} — native fallback`);
      setUseNative(true);
      return;
    }
    // ── mpegts.js: client-side TS demuxing + MSE ──
    // mpegts.js reads TS bytes from the stream URL, demuxes in JS,
    // and appends fMP4 to its own MSE SourceBuffer. This avoids all
    // backend segment generation issues (503, cache wait, zero-duration
    // segments). It handles duration, seeking, and buffering natively.

    const parsed = parseStreamUrl(url);
    if (parsed) {
      diagLog(`[MSE] TS format — using mpegts.js player`);
      const mpegtsSuccess = await _initMpegtsPlayer(url, mediaSource, blobUrl, parsed);
      if (mpegtsSuccess) return;
      diagLog('[MSE] mpegts.js failed — switching to native remux playback');

      // mpegts.js took over the video element with its own internal MediaSource.
      // Fully detach it and reset the element so the native <video> can load
      // the remux URL cleanly. Creating a fresh MediaSource here repeatedly fails
      // with ERR_FILE_NOT_FOUND in WebView2/Chromium, so we skip the fMP4
      // fallback entirely and use the backend ffmpeg remux pipeline instead.
      const mpegtsPlayer = mpegtsPlayerRef.current;
      if (mpegtsPlayer) {
        try {
          mpegtsPlayer.detachMediaElement();
          mpegtsPlayer.unload();
          mpegtsPlayer.destroy();
        } catch (_) {}
        mpegtsPlayerRef.current = null;
      }
      const video = videoRef.current;
      if (video) {
        try {
          video.src = '';
          video.removeAttribute('src');
          video.load();
        } catch (_) {}
      }
      // Revoke the now-closed original blob URL so it doesn't leak.
      try { URL.revokeObjectURL(blobUrl); } catch (_) {}

      // BUGFIX: was `parseStreamUrl(url)` — `url` is closure-captured from
      // when this callback was originally registered, which can be a prior
      // file when the user switches mid-init. Use streamUrlRef for the live
      // URL so we build /remux/<currentMsgId>, not /remux/<staleMsgId>.
      const fallbackUrl = streamUrlRef.current ?? url;
      const parsedFallback = parseStreamUrl(fallbackUrl);
      if (parsedFallback) {
        const remuxUrl = `${parsedFallback.baseUrl}/remux/${parsedFallback.folderId}/${parsedFallback.messageId}?token=${encodeURIComponent(parsedFallback.token)}`;
        if (fallbackUrl !== url) {
          diagLog(`[MSE] fallback: file switched mid-init — using live URL for /remux (was ${url}, now ${fallbackUrl})`);
        }
        diagLog(`[MSE] Using ffmpeg remux fallback: ${remuxUrl}`);
        remuxUrlRef.current = remuxUrl;
        setUseNative(true);
        return;
      }
      setError('All TS playback pipelines failed');
      setUseNative(true);
      return;
    }
    setError('All TS playback pipelines failed');
    setUseNative(true);
  };


  /** Extract the moov box from a buffer by forward-scanning MP4 box headers.
   *  Used for faststarted MP4s where the moov is near the beginning of the file
   *  (inside the first chunk). Returns the moov data and its file offset, or null
   *  if the moov box isn't fully contained in the buffer. */
  const extractMoovFromForwardScan = (data: ArrayBuffer): { data: ArrayBuffer; fileStart: number } | null => {
    const view = new DataView(data);
    const len = data.byteLength;
    let offset = 0;

    while (offset + 8 <= len) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7),
      );

      if (type === 'moov') {
        // Calculate actual size (handle 64-bit extended size and size=0)
        let actualSize = size;
        if (size === 1) {
          if (offset + 16 > len) return null; // can't read extended size
          const hi = view.getUint32(offset + 8);
          const lo = view.getUint32(offset + 12);
          actualSize = hi * 0x100000000 + lo;
        } else if (size === 0) {
          actualSize = state.current.fileLength - offset;
        }

        // Check if the entire moov box is contained in this buffer
        if (offset + actualSize <= len) {
          const moovData = data.slice(offset, offset + actualSize);
          console.log(`[MSE] Extracted moov from first chunk: fileStart=${offset}, size=${actualSize}`);
          return { data: moovData, fileStart: offset };
        }
        // moov extends beyond the first chunk — can't extract it here
        console.log(`[MSE] moov found at offset=${offset} but extends beyond first chunk (declaredSize=${actualSize}, available=${len - offset})`);
        return null;
      }

      // Advance to next box
      if (size === 0) break;
      if (size === 1) {
        if (offset + 16 > len) break;
        offset += 16;
      } else {
        offset += size;
      }

      if (offset > len) break;
    }

    return null;
  };

  /** Scan an ArrayBuffer for an MP4 box with type "moov".
   *  MP4 boxes are: [4 bytes size][4 bytes type][payload].
   *  Returns true if a moov box is found in the data. */
  const scanForMoovBox = (data: ArrayBuffer): boolean => {
    const view = new DataView(data);
    const len = data.byteLength;
    let offset = 0;

    while (offset + 8 <= len) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7),
      );

      if (type === 'moov') return true;

      // Advance to next box. Size=0 means box extends to end of file.
      // Size=1 means 64-bit extended size (next 8 bytes are the real size).
      if (size === 0) break;
      if (size === 1) {
        if (offset + 16 > len) break;
        offset += 16; // Skip extended size header (approximate — large boxes)
      } else {
        offset += size;
      }

      if (offset > len) break;
    }

    return false;
  };

  /** Extract the moov atom from a buffer by scanning backwards from the end.
   *  In moov-at-end MP4s, the tail data starts mid-mdat, so forward box
   *  scanning fails (it reads mdat payload bytes as box headers and jumps
   *  past the moov). Backward scanning finds `moov` type bytes (0x6D6F6F76)
   *  and validates the preceding 4-byte size field, ensuring we find the
   *  real moov atom even when the buffer starts mid-mdat.
   *  Returns the moov data and its absolute file offset, or null. */
  const extractMoovFromBuffer = (buffer: ArrayBuffer, tailStartOffset: number): { data: ArrayBuffer; fileStart: number } | null => {
    const view = new DataView(buffer);
    const len = buffer.byteLength;
    const fileLength = state.current.fileLength;

    // Search backward from the end for 'moov' type bytes (0x6D 0x6F 0x6F 0x76).
    // The moov atom is always at or near the end of moov-at-end files.
    // We search backward to avoid misinterpreting mdat payload bytes as box headers.
    for (let i = len - 4; i >= 0; i--) {
      // Check for 'moov' type at offset i
      if (view.getUint8(i) === 0x6D && // 'm'
          view.getUint8(i + 1) === 0x6F && // 'o'
          view.getUint8(i + 2) === 0x6F && // 'o'
          view.getUint8(i + 3) === 0x76) { // 'v'

        // The box header is [4-byte size][4-byte type], so size is at i-4.
        // Verify we have enough room for the full 8-byte box header.
        if (i < 4) continue;

        const headerOffset = i - 4; // offset where the box size field starts
        const boxSize = view.getUint32(headerOffset);

        // Validate: moov box size must be reasonable (> 8 minimum for header + minimal content)
        // and the moov should end at or near the end of the file.
        let actualSize = boxSize;

        // Handle 64-bit extended size (size field = 1)
        if (boxSize === 1) {
          if (headerOffset + 16 > len) continue; // not enough data for extended size
          const hi = view.getUint32(headerOffset + 8);
          const lo = view.getUint32(headerOffset + 12);
          actualSize = hi * 0x100000000 + lo;
        } else if (boxSize === 0) {
          // Box extends to end of file
          actualSize = fileLength - (tailStartOffset + headerOffset);
        }

        // Sanity checks:
        // 1. actualSize must be >= 8 (minimum valid box size)
        // 2. moov end (tailStartOffset + headerOffset + actualSize) should be <= fileLength
        // 3. actualSize should be reasonable (not absurdly large)
        if (actualSize < 8) continue;
        if (tailStartOffset + headerOffset + actualSize > fileLength + 1) continue; // +1 for rounding
        if (actualSize > 100 * 1024 * 1024) continue; // moov atoms are typically <50MB

        // Additional validation: check that bytes before the moov header look like
        // the end of a valid box (mdat). The byte at headerOffset-1 could be any
        // mdat payload byte, so we can't validate the preceding box. But we CAN
        // verify that the moov internal structure starts correctly — a moov should
        // contain child boxes like mvhd, trak, etc.
        // Read the first child box type after the moov header (8 or 16 bytes).
        let childHeaderStart = headerOffset + 8;
        if (boxSize === 1) childHeaderStart = headerOffset + 16; // extended size header
        if (childHeaderStart + 8 <= len) {
          const childType = String.fromCharCode(
            view.getUint8(childHeaderStart + 4),
            view.getUint8(childHeaderStart + 5),
            view.getUint8(childHeaderStart + 6),
            view.getUint8(childHeaderStart + 7),
          );
          // Known moov child box types: mvhd, trak, udta, meta, mvex, moof
          const knownMoovChildren = ['mvhd', 'trak', 'udta', 'meta', 'mvex', 'moof'];
          if (!knownMoovChildren.includes(childType)) continue;
        }

        // Found a valid moov atom!
        const moovStart = tailStartOffset + headerOffset;
        const availableMoovBytes = Math.min(actualSize, len - headerOffset);
        const moovData = buffer.slice(headerOffset, headerOffset + availableMoovBytes);

        console.log(`[MSE] Found moov at file offset ${moovStart}, size=${actualSize}, fetched=${availableMoovBytes} bytes`);
        return { data: moovData, fileStart: moovStart };
      }
    }

    return null;
  };

  /** Fetch moov atom from the tail of the file for non-faststarted MP4s.
   *  Strategy: progressively fetch larger portions of the file tail (5MB → 10MB → 20MB),
   *  scanning backwards for the moov atom. If the moov is partially fetched
   *  (declared size > fetched bytes), fetch the remaining data.
   *  Then append moov + first chunk to mp4box.js and start the download loop. */
  const fetchMoovFromTail = async (url: string, mp4box: MP4BoxFile, firstChunkData: ArrayBuffer) => {
    const fileLength = state.current.fileLength;
    if (fileLength === 0) {
      console.error('[MSE] Cannot fetch moov from tail — file length unknown');
      setUseNative(true);
      return;
    }

    // Progressive tail fetch: start with 5MB, increase to 10MB, then 20MB.
    // moov atoms for long videos with many tracks can exceed 5MB.
    const TAIL_FETCH_SIZES = [
      5 * 1024 * 1024,   // 5MB
      10 * 1024 * 1024,  // 10MB
      20 * 1024 * 1024,  // 20MB
    ];

    let moovInfo: { data: ArrayBuffer; fileStart: number } | null = null;

    for (const tailFetchSize of TAIL_FETCH_SIZES) {
      if (cancelledRef.current) return;
      if (moovInfo) break;

      // For small files, start after the first chunk. For large files, start from end - tailFetchSize.
      const tailStart = Math.max(firstChunkData.byteLength, fileLength - tailFetchSize);
      const tailEnd = fileLength - 1;

      console.log(`[MSE] Fetching tail (${tailFetchSize / 1024 / 1024}MB): bytes=${tailStart}-${tailEnd} (${tailEnd - tailStart + 1} bytes)`);

      const response = await fetch(url, {
        headers: { Range: `bytes=${tailStart}-${tailEnd}` },
      });

      if (cancelledRef.current) return;

      if (!response.ok && response.status !== 206) {
        console.error(`[MSE] Tail fetch failed: HTTP ${response.status}`);
        // Don't retry with larger size on HTTP error — likely a server issue
        setUseNative(true);
        return;
      }

      const tailData = await response.arrayBuffer();
      if (cancelledRef.current) return;

      trackDownloadedRange(tailStart, tailStart + tailData.byteLength - 1);

      // Scan the tail data for moov atom (backward scan)
      moovInfo = extractMoovFromBuffer(tailData, tailStart);

      if (!moovInfo) {
        console.log(`[MSE] No moov found in ${tailFetchSize / 1024 / 1024}MB tail, trying larger fetch...`);
        continue;
      }
    }

    if (!moovInfo) {
      console.error('[MSE] No moov found in any tail fetch — falling back to native playback');
      setUseNative(true);
      return;
    }

    // Check if we only fetched part of the moov atom (declared size > fetched bytes).
    // The moov declared size comes from the moov box header in the tail data.
    const moovDeclaredSize = (() => {
      // Read from moovInfo.data which starts at the moov box header.
      const dv = new DataView(moovInfo.data);
      const rawSize = dv.getUint32(0);
      if (rawSize === 1) {
        // 64-bit extended size
        if (moovInfo.data.byteLength >= 16) {
          return dv.getUint32(8) * 0x100000000 + dv.getUint32(12);
        }
      } else if (rawSize === 0) {
        return fileLength - moovInfo.fileStart;
      }
      return rawSize;
    })();

    // If moov is larger than what we fetched, get the complete moov.
    let completeMoovData = moovInfo.data;
    let completeMoovStart = moovInfo.fileStart;

    // Store moov buffer for thumbnail mini-MSE pipeline (always set from moovInfo;
    // updated later if the moov extends beyond the tail and we fetch more data).
    moovBufferRef.current = { buffer: moovInfo.data.slice(0), fileStart: moovInfo.fileStart };
    setMoovBufferReady(true);

    if (moovDeclaredSize > moovInfo.data.byteLength) {
      console.log(`[MSE] moov extends beyond fetched tail (declared=${moovDeclaredSize}, fetched=${moovInfo.data.byteLength}), fetching complete moov`);

      const moovFetchEnd = Math.min(fileLength - 1, moovInfo.fileStart + moovDeclaredSize - 1);
      const moovFetchStart = moovInfo.fileStart;

      const moovResp = await fetch(url, {
        headers: { Range: `bytes=${moovFetchStart}-${moovFetchEnd}` },
      });

      if (cancelledRef.current) return;

      if (moovResp.ok || moovResp.status === 206) {
        const completeData = await moovResp.arrayBuffer();
        if (cancelledRef.current) return;

        completeMoovData = completeData;
        completeMoovStart = moovFetchStart;

        // Store moov buffer for thumbnail mini-MSE pipeline
        moovBufferRef.current = { buffer: completeData.slice(0), fileStart: moovFetchStart };
        setMoovBufferReady(true);

        trackDownloadedRange(moovFetchStart, moovFetchStart + completeData.byteLength - 1);

        console.log(`[MSE] Fetched complete moov: ${completeData.byteLength} bytes (declared=${moovDeclaredSize})`);
      } else {
        console.warn(`[MSE] Complete moov fetch failed (HTTP ${moovResp.status}), using partial moov`);
      }
    }

    try {
      // CRITICAL: Append order matters for mp4box.js!
      // mp4box.js's initialized() gate requires the first buffer in its
      // internal list to have fileStart === 0 before parsing can start.
      // If we append moov first (fileStart=287MB), initialized() fails
      // and the moov sits unprocessed. Only when we later append the
      // first chunk (fileStart=0) does initialized() succeed, but by
      // then the moov may not be parsed correctly.
      //
      // The fix: append the first chunk (fileStart=0) FIRST, so
      // initialized() succeeds immediately. parse() then reads ftyp,
      // encounters the huge mdat box, and tries to seek past it to
      // find the next box. At that point, we append the moov (at its
      // real fileStart offset) — parse() restores to the mdat end
      // position, finds the moov buffer, parses it, and fires onReady.
      //
      // This is the correct flow for moov-at-end files with mp4box.js.

      // CRITICAL: Set currentOffset BEFORE any appendBuffer calls, because
      // onReady fires synchronously during appendBuffer → onMP4BoxReady →
      // downloadLoop. The download loop uses currentOffset to determine
      // where to start fetching, so it must be set before the loop starts.
      state.current.currentOffset = firstChunkData.byteLength;
      setPrefetchedBytes(firstChunkData.byteLength);

      // Clone first chunk BEFORE appending Step 1 — mp4box's discardMdatData
      // marks all mdat bytes as used when seeking past the incomplete mdat.
      // At the end of appendBuffer(), cleanBuffers() removes buffers whose
      // usedBytes === byteLength, destroying the data at offset 0–524287.
      // We need this clone for Step 3 so processSamples can read sample 0
      // at offset 48 and generate the first segment.
      const firstChunkClone = firstChunkData.slice(0);

      // 1. Append first chunk (ftyp + mdat start) with fileStart=0 FIRST.
      //    This satisfies initialized() and lets parse() start.
      const firstBuffer = firstChunkData as any;
      firstBuffer.fileStart = 0;

      console.log('[MSE] Appending first chunk (fileStart=0, size=' + firstChunkData.byteLength + ') to mp4box');
      const firstResult = mp4box.appendBuffer(firstBuffer);
      console.log('[MSE] First chunk append result: nextFileStart=' + firstResult);

      // 2. Now append moov at its real fileStart offset.
      //    parse() will find it by seeking past the incomplete mdat.
      const moovBuffer = completeMoovData as any;
      moovBuffer.fileStart = completeMoovStart;

      console.log('[MSE] Appending moov (fileStart=' + completeMoovStart + ', size=' + completeMoovData.byteLength + ') to mp4box');
      const moovResult = mp4box.appendBuffer(moovBuffer);
      console.log('[MSE] Moov append result: nextFileStart=' + moovResult);

      // If onReady hasn't fired yet, try forward scan as fallback.
      // (Skip everything if onReady DID fire but rerouted to /remux — the
      // MP4 pipeline is dead and mpegts.js owns the video element now.)
      if (reroutedToRemuxRef.current) return;
      if (!state.current.initialized && !cancelledRef.current) {
        console.log('[MSE] onReady did not fire after first chunk + moov, trying forward scan');
        await fetchMoreDataForwardScan(url, mp4box);
        if (reroutedToRemuxRef.current) return;
      }

      // 3. CRITICAL: Re-append the first chunk clone. After Step 1,
      //    cleanBuffers() removed the original buffer (discardMdatData=true
      //    marked all its bytes as used). processSamples needs data at
      //    offset 48 (sample 0) to generate the first segment. Without
      //    this re-append, onSegment never fires and the video never plays.
      if (state.current.initialized && !cancelledRef.current) {
        const reBuffer = firstChunkClone as any;
        reBuffer.fileStart = 0;
        console.log('[MSE] Re-appending first chunk (fileStart=0) for sample processing');
        const reResult = mp4box.appendBuffer(reBuffer);
        console.log('[MSE] Re-append result: nextFileStart=' + reResult);
        // flush() forces processSamples(true) to emit the first segment
        // even if fewer than nbSamples samples fit in the 512KB chunk.
        mp4box.flush();
      }

      if (!state.current.initialized && !cancelledRef.current && !reroutedToRemuxRef.current) {
        console.error('[MSE] onReady did not fire after moov-from-tail — falling back to native playback');
        setUseNative(true);
      }
    } catch (e: any) {
      console.error('[MSE] moov append failed:', e);
      if (!cancelledRef.current) {
        setUseNative(true);
      }
    }
  };

  /** Fetch the complete moov box bytes for faststarted MP4s where the moov
   *  extends beyond the first 512KB chunk. Called after onMP4BoxReady fires,
   *  so we know the moov was successfully parsed. Strategy: fetch bytes
   *  from 0 up to currentOffset (which has advanced past the moov during
   *  forward scanning) and extract the moov box via forward scan. */
  const fetchMoovForFaststarted = async (url: string) => {
    if (cancelledRef.current) return;

    // For faststarted files, the moov is somewhere between byte 0 and the
    // currentOffset (which advanced through forward scanning past the moov).
    // Fetch the entire range and extract the moov box.
    const end = Math.min(state.current.currentOffset - 1, state.current.fileLength - 1);

    console.log(`[MSE] Fetching moov data for faststarted file: bytes=0-${end}`);

    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=0-${end}` },
      });
      if (cancelledRef.current) return;
      if (!response.ok && response.status !== 206) {
        console.warn('[MSE] Could not fetch moov data for thumbnail pipeline');
        return;
      }

      const data = await response.arrayBuffer();
      if (cancelledRef.current) return;

      const moovExtract = extractMoovFromForwardScan(data);
      if (moovExtract) {
        moovBufferRef.current = { buffer: moovExtract.data, fileStart: moovExtract.fileStart };
        setMoovBufferReady(true);
        console.log('[MSE] Moov extracted for thumbnail pipeline from faststarted file: fileStart=' + moovExtract.fileStart + ', size=' + moovExtract.data.byteLength);
      } else {
        console.warn('[MSE] Could not extract moov from fetched data — thumbnail pipeline may not work');
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      console.warn('[MSE] Failed to fetch moov for thumbnail pipeline:', e.message);
    }
  };

  /** Forward scan from currentOffset up to MAX_PREFETCH to find moov.
   *  Used when moov extends beyond the first 512KB chunk (faststarted MP4s
   *  where moov is near the beginning but larger than 512KB). */
  const fetchMoreDataForwardScan = async (url: string, mp4box: MP4BoxFile) => {
    const MAX_PREFETCH = 10 * 1024 * 1024;

    while (!cancelledRef.current && !state.current.initialized &&
           !reroutedToRemuxRef.current &&
           state.current.currentOffset < state.current.fileLength &&
           state.current.currentOffset < MAX_PREFETCH) {

      const offset = state.current.currentOffset;
      const chunkSize = FRAGMENT_SIZES[0];
      const end = Math.min(offset + chunkSize - 1, state.current.fileLength - 1);

      try {
        const response = await fetch(url, {
          headers: { Range: `bytes=${offset}-${end}` },
        });

        if (cancelledRef.current) return;
        if (!response.ok && response.status !== 206) break;

        const data = await response.arrayBuffer();
        if (cancelledRef.current) return;

        const buffer = data as any;
        buffer.fileStart = offset;
        mp4box.appendBuffer(buffer);

        state.current.currentOffset = offset + data.byteLength;
        setPrefetchedBytes(state.current.currentOffset);
        trackDownloadedRange(offset, offset + data.byteLength - 1);
      } catch (e) {
        break;
      }
    }

    if (!state.current.initialized && !cancelledRef.current && !reroutedToRemuxRef.current) {
      console.error('[MSE] moov not found after forward scan — falling back to native playback');
      setUseNative(true);
    }
  };

  /** Prefetch audio data for moov-at-end files where audio samples are far
   *  from the file start (e.g. sequential layout: video data first, then audio
   *  data at 257MB+). Without this prefetch, the sequential download loop would
   *  take minutes to reach audio data, and mp4box.js would never generate audio
   *  segments. This function runs in parallel with the download loop, fetching
   *  the audio sample range in chunks and appending to mp4box so audio segments
   *  can be generated immediately.
   *  Also called after seeks to re-provide audio data that may have been cleaned
   *  from mp4box's internal buffer list. */
  const prefetchAudioData = async (url: string, mp4box: MP4BoxFile, audioTrackId: number) => {
    if (cancelledRef.current || audioTrackId < 0) return;

    // Get audio sample info to determine the byte range
    const samples = mp4box.getTrackSamplesInfo(audioTrackId);
    if (!samples || samples.length === 0) {
      console.log('[MSE] Audio prefetch: no audio samples found');
      return;
    }

    const firstSample = samples[0];
    const lastSample = samples[samples.length - 1];
    const audioStart = firstSample.offset;
    const audioEnd = lastSample.offset + lastSample.size;

    console.log(`[MSE] Audio prefetch: range=${audioStart}-${audioEnd} (${((audioEnd - audioStart) / 1024 / 1024).toFixed(1)}MB), ${samples.length} samples`);

    // Only prefetch if audio data is far from the current download position.
    // For interleaved files (audio near start), the download loop encounters
    // audio naturally and no prefetch is needed.
    const currentPos = state.current.currentOffset;
    const AUDIO_PREFETCH_THRESHOLD = 10 * 1024 * 1024; // 10MB
    if (audioStart - currentPos < AUDIO_PREFETCH_THRESHOLD) {
      console.log('[MSE] Audio data is near current position — no prefetch needed');
      return;
    }

    // Track the audio range so the download loop can skip it later
    audioPrefetchedRangeRef.current = [audioStart, audioEnd];

    // Fetch audio data in chunks (2MB per chunk for responsive segment generation)
    const AUDIO_CHUNK_SIZE = 2 * 1024 * 1024;
    let offset = audioStart;

    while (!cancelledRef.current && offset < audioEnd) {
      const chunkEnd = Math.min(offset + AUDIO_CHUNK_SIZE - 1, audioEnd - 1);

      try {
        const response = await fetch(url, {
          headers: { Range: `bytes=${offset}-${chunkEnd}` },
        });

        if (cancelledRef.current) return;
        if (!response.ok && response.status !== 206) {
          console.warn(`[MSE] Audio prefetch: HTTP ${response.status} at offset=${offset}, stopping`);
          break;
        }

        const data = await response.arrayBuffer();
        if (cancelledRef.current) return;

        // Append to mp4box with correct fileStart for sample processing
        const buffer = data as any;
        buffer.fileStart = offset;
        mp4box.appendBuffer(buffer);

        // Track ranges for the green bar
        trackDownloadedRange(offset, offset + data.byteLength - 1);

        offset += data.byteLength;
      } catch (e: any) {
        if (e.name === 'AbortError') break;
        console.warn('[MSE] Audio prefetch fetch error:', e.message);
        break;
      }
    }

    console.log('[MSE] Audio prefetch complete — fetched up to offset=' + offset);
  };

  /** Reroute an MP4 whose video codec MSE can't decode (HEVC family on stock
   *  WebView2) to the ffmpeg /remux → mpegts.js tier — the same battle-tested
   *  pipeline MKV-HEVC uses. Called from onMP4BoxReady AFTER MP4Box/MediaSource
   *  are live, so it must quiesce the whole MP4 pipeline first:
   *  streaming chain → mp4box → SourceBuffers → progress counters → blob URL.
   *  The /stream bytes for MP4 are ISOBMFF (NOT MPEG-TS), so seeks use
   *  ffmpeg `-ss` only (remuxSourceIsTs=false) — never byte-forward. */
  const rerouteMp4ToRemux = async (url: string, mediaSource: MediaSource, mp4box: MP4BoxFile, videoCodec: string) => {
    const parsed = parseStreamUrl(streamUrlRef.current ?? url);
    if (!parsed) {
      diagLog('[MSE] MP4-HEVC reroute: could not parse stream URL — cannot reroute');
      return false;
    }
    // Mark the reroute SYNCHRONOUSLY so the MP4 init callers (fetchMoovFromTail
    // / forward scan) that resume after onMP4BoxReady returns see it and skip
    // their "onReady did not fire → native fallback" paths.
    reroutedToRemuxRef.current = true;

    // ── Quiesce the MP4 pipeline ──
    stopStreamingChain();
    try { mp4box.stop(); } catch { /* not started yet — fine */ }
    try { (mp4box as any).onSegment = null; (mp4box as any).onReady = null; (mp4box as any).onError = null; } catch { /* defensive */ }
    state.current.mp4box = null;
    state.current.videoSourceBuffer?.destroy();
    state.current.audioSourceBuffer?.destroy();
    state.current.videoSourceBuffer = null;
    state.current.audioSourceBuffer = null;
    // Reset progress/prefetch counters seeded by the MP4 path (first chunk +
    // moov tail fetch) so the green bar starts clean on the remux timeline.
    clearDownloadedRanges();
    setPrefetchedBytes(0);
    state.current.currentOffset = 0;

    const hevcOk = hevcMseSupported();
    const remuxUrl = `${parsed.baseUrl}/remux/${parsed.folderId}/${parsed.messageId}?token=${encodeURIComponent(parsed.token)}&hevc_ok=${hevcOk}`;
    diagLog(`[MSE] mp4 (${videoCodec}) — MSE can't decode, rerouting to ffmpeg remux → mpegts.js: ${remuxUrl}`);
    remuxUrlRef.current = remuxUrl;
    // MP4 /stream/ is ISOBMFF, NOT MPEG-TS — byte-forward would feed ffmpeg
    // stdin mid-file MP4 bytes ("Invalid data found", execution-proven).
    needsRemuxSeekRef.current = true;
    remuxSeekBaseUrlRef.current = remuxUrl;
    remuxSourceIsTsRef.current = false; // ISOBMFF: ss-only seeks

    if (!shadowCacheRef.current) {
      shadowCacheRef.current = new StreamShadowCache(300 * 1024 * 1024);
    }
    shadowCacheRef.current.reset(new URL(remuxUrl).pathname, 0);

    // Extend the MSE init timeout — remux needs download + ffprobe + ffmpeg startup.
    transmuxerInitInProgressRef.current = true;

    // Clear mseUrl BEFORE mpegts.js init — mpegts.js sets video.src to its own
    // MediaSource blob; leaving mseUrl set would make FastStreamPlayer overwrite
    // video.src back to our (now dead) blob on the next render.
    setMseUrl(null);

    // Cold-start overlay stays up through remux startup; MEDIA_INFO resolves it.
    let coldResolve: () => void = () => {};
    const coldPromise = new Promise<void>((resolve) => { coldResolve = resolve; });
    coldStartDeferredRef.current = { resolve: coldResolve, promise: coldPromise };
    setIsColdStartBuffering(true);
    setColdStartPhase('initializing_player');
    setColdStartProgress({ bytes: 0, targetBytes: 0 }); // indeterminate for remux

    await _initMpegtsPlayer(remuxUrl, mediaSource, '', parsed);
    return true;
  };

  const onMP4BoxReady = (info: MP4BoxInfo, url: string, mediaSource: MediaSource, mp4box: MP4BoxFile, _blobUrl: string) => {
    if (!mediaSource || cancelledRef.current) return;
    // Guard: mp4box.js onReady can fire multiple times (e.g. after flush() or
    // re-append). Each invocation adds a new SourceBuffer to the same MediaSource.
    // Chrome limits SourceBuffers to 2 per MediaSource, so duplicate calls exhaust
    // the quota and prevent the audio SourceBuffer from ever being created.
    if (state.current.initialized) {
      console.log('[MSE] onMP4BoxReady duplicate — already initialized, skipping');
      return;
    }

    console.log(`[MSE] onMP4BoxReady: duration=${info.duration / info.timescale}s, videoTracks=${info.videoTracks?.length ?? 0}, audioTracks=${info.audioTracks?.length ?? 0}`);

    state.current.duration = info.duration / info.timescale;

    if (mediaSource.readyState === 'open') {
      mediaSource.duration = state.current.duration;
    }

    // Extract tracks
    for (const track of info.videoTracks ?? []) {
      state.current.videoTracks.push({
        id: track.id,
        codec: track.codec,
        width: track.width,
        height: track.height,
        duration: track.duration,
        timescale: track.timescale,
      });
    }

    for (const track of info.audioTracks ?? []) {
      state.current.audioTracks.push({
        id: track.id,
        codec: track.codec,
        duration: track.duration,
        timescale: track.timescale,
      });
    }

    // Calculate bitrate
    if (state.current.fileLength > 0 && state.current.duration > 0) {
      state.current.bitrate = state.current.fileLength / state.current.duration;
    }

    // Build byte-to-time VBR lookup table (200 calibration points)
    // mp4box.seek(time, true) → { offset: bytePos } gives exact byte for each time.
    // We store [bytePos, time] pairs and interpolate for any byte position.
    if (state.current.fileLength > 0 && state.current.duration > 0) {
      const CALIBRATION_POINTS = 200;
      const table: [number, number][] = [];
      for (let i = 0; i <= CALIBRATION_POINTS; i++) {
        const t = (i / CALIBRATION_POINTS) * state.current.duration;
        const seekResult = mp4box.seek(t, true) as any;
        const byteOffset = (seekResult && typeof seekResult.offset === 'number')
          ? seekResult.offset
          : (t / state.current.duration) * state.current.fileLength;
        table.push([byteOffset, t]);
      }
      byteToTimeTableRef.current = table;
      // console.log(`[BUFFER-BAR] VBR lookup table built: ${table.length} points, video duration=${state.current.duration.toFixed(1)}s`);
    }

    // Create SourceBuffers — separate video and audio SourceBuffers.
    // Audio SourceBuffer is created upfront in onMP4BoxReady (before
    // thumbnail pipeline starts) to avoid QuotaExceededError from lazy
    // creation inside onSegment. Creating upfront means video.buffered
    // returns the intersection of video+audio buffered ranges. Since audio
    // has no media data yet (only init segment), audioSourceBuffer.buffered
    // is empty, so video stays at HAVE_METADATA briefly (~1-2s) until the
    // audio prefetch delivers first audio data. This brief delay is the
    // trade-off for having working audio.
    try {
      // Track IDs for mapping segments
      const videoTrackId = state.current.videoTracks.length > 0 ? state.current.videoTracks[0].id : -1;
      const audioTrackId = state.current.audioTracks.length > 0 ? state.current.audioTracks[0].id : -1;
      state.current.videoTrackId = videoTrackId;
      state.current.audioTrackId = audioTrackId;

      const videoCodec = state.current.videoTracks.length > 0 ? state.current.videoTracks[0].codec : null;
      const audioCodec = state.current.audioTracks.length > 0 ? state.current.audioTracks[0].codec : null;

      // Create video SourceBuffer
      if (videoCodec) {
        const mimeType = `video/mp4; codecs="${videoCodec}"`;
        if (MediaSource.isTypeSupported(mimeType)) {
          console.log(`[MSE] Creating video SourceBuffer: ${mimeType}, sourceBuffers.length=${mediaSource.sourceBuffers.length}`);
          const sb = mediaSource.addSourceBuffer(mimeType);
          state.current.videoSourceBuffer = new SourceBufferWrapper(sb);
          console.log(`[MSE] Video SourceBuffer created, sourceBuffers.length=${mediaSource.sourceBuffers.length}`);
        } else {
          // MSE doesn't support this codec. HEVC family (incl. Dolby Vision
          // dvh1/dvhe) → reroute to the ffmpeg /remux → mpegts.js tier, the
          // same pipeline MKV-HEVC already uses. ffmpeg transcodes to H.264
          // (HW-accelerated when available) so playback is free for everyone.
          const canPlay = videoRef.current?.canPlayType(mimeType) ?? '';
          console.warn(`[MSE] Video codec NOT supported by MSE: ${mimeType}`);
          console.log(`[MSE] Native canPlayType("${mimeType}") = "${canPlay}"`);
          if (isHevcFamilyCodec(videoCodec)) {
            // onMP4BoxReady is sync (called from mp4box.appendBuffer) — fire
            // the async reroute and let it own the pipeline from here. Bail
            // out of the MP4 path entirely: initialized stays false, and
            // reroutedToRemuxRef stops the callers' native fallback.
            rerouteMp4ToRemux(url, mediaSource, mp4box, videoCodec).catch((e: any) => {
              console.error('[MSE] MP4-HEVC reroute failed:', e);
              if (!cancelledRef.current) {
                const msg = 'This HEVC video could not be played. You can download it and use an external player.';
                setUnsupportedCodec(msg);
                setError(msg);
              }
            });
            return;
          }
          if (canPlay === 'probably' || canPlay === 'maybe') {
            // Native <video> can handle this codec — fall back to native playback.
            // Native <video> handles moov-at-end files via Range requests naturally.
            console.log(`[MSE] Falling back to native playback — codec "${videoCodec}" is natively supported (${canPlay})`);
            setUseNative(true);
          } else {
            // Neither MSE, /remux, nor native <video> supports this codec.
            const codecName = videoCodec.startsWith('av01') ? 'AV1' : videoCodec;
            const msg = `This video uses ${codecName} codec which is not supported by the built-in player.` +
              ' You can download the video and play it with your preferred video player.';
            console.error(`[MSE] Codec completely unsupported: ${videoCodec}`);
            setUnsupportedCodec(msg);
            setError(msg);
            return;
          }
        }
      }

      // Create audio SourceBuffer upfront — before thumbnail pipeline starts
      // so we don't compete for SourceBuffer quota with the pipeline's MediaSource.
      // Debug: log sourceBuffers count to diagnose QuotaExceededError if it happens.
      if (audioCodec) {
        const mimeType = `audio/mp4; codecs="${audioCodec}"`;
        if (MediaSource.isTypeSupported(mimeType)) {
          console.log(`[MSE] Creating audio SourceBuffer: ${mimeType}, sourceBuffers.length=${mediaSource.sourceBuffers.length}`);
          try {
            const sb = mediaSource.addSourceBuffer(mimeType);
            state.current.audioSourceBuffer = new SourceBufferWrapper(sb);
            console.log(`[MSE] Audio SourceBuffer created, sourceBuffers.length=${mediaSource.sourceBuffers.length}`);
          } catch (audioErr: any) {
            // QuotaExceededError: Chrome limits SourceBuffers per MediaSource.
            // Continue with video-only playback if audio SB can't be created.
            console.warn(`[MSE] Failed to create audio SourceBuffer (${audioErr.name}: ${audioErr.message}), sourceBuffers.length=${mediaSource.sourceBuffers.length}. Continuing video-only.`);
            state.current.audioSourceBuffer = null;
          }
        } else {
          console.warn('[MSE] Audio codec NOT supported: ' + mimeType + ' — video-only playback');
        }
      }

      // Store video track info for thumbnail mini-MSE pipeline
      if (videoTrackId >= 0) {
        videoTrackInfoRef.current = { trackId: videoTrackId, codec: state.current.videoTracks[0].codec };
      }

      // Signal that all thumbnail pipeline data is ready
      setThumbnailDataReady(true);

      // Set up mp4box segmentation — pass user objects so onSegment/initSegs can identify tracks
      // nbSamples=25: smaller segments flush sooner, critical for moov-at-end files where
      // we need the first segment to reach the SourceBuffer ASAP. 100 samples would require
      // ~3.3s of video data (~500KB+) before the first onSegment fires, causing long buffering.
      // 25 samples ≈ 0.8s of video, ~125KB — flushes in the first 512KB chunk.
      if (videoTrackId >= 0) {
        mp4box.setSegmentOptions(videoTrackId, { type: 'video' }, { nbSamples: 25 });
      }
      if (audioTrackId >= 0) {
        mp4box.setSegmentOptions(audioTrackId, { type: 'audio' }, { nbSamples: 25 });
      }

      // Get and append init segment
      const initSegs = mp4box.initializeSegmentation();
      if (initSegs && initSegs.length > 0) {
        // Cache for re-append after seek clears buffers
        initSegmentsRef.current = initSegs.map(s => ({
          id: s.id,
          buffer: s.buffer.slice(0), // Clone since buffer may be transferred
        }));
        for (const seg of initSegs) {
          const isVideo = seg.id === videoTrackId;
          const isAudio = seg.id === audioTrackId;
          if (isVideo && state.current.videoSourceBuffer) {
            state.current.videoSourceBuffer.appendBuffer(seg.buffer);
          }
          if (isAudio && state.current.audioSourceBuffer) {
            state.current.audioSourceBuffer.appendBuffer(seg.buffer);
            console.log('[MSE] Audio init segment appended immediately (' + seg.buffer.byteLength + ' bytes)');
          }
        }
      }

      state.current.initialized = true;
      // Clear init timeout — MSE init succeeded, no need for fallback
      if (initTimeoutRef.current !== null) {
        clearTimeout(initTimeoutRef.current);
        initTimeoutRef.current = null;
      }
      // Dismiss cold-start overlay now that MP4 metadata is parsed and player is ready
      setIsColdStartBuffering(false);
      setColdStartPhase('none');
      setIsPrefetching(true);

      // Set up mp4box callback for segments
      mp4box.onSegment = (trackId: number, _user: any, buffer: ArrayBuffer, _sampleNum: number, _isLast: boolean) => {
        if (cancelledRef.current) return;

        console.log(`[MSE] onSegment: trackId=${trackId}, bufferSize=${buffer.byteLength}, sampleNum=${_sampleNum}, isLast=${_isLast}`);

        // Bug #4 fix: stop appending if SourceBuffer is fatally broken
        if (state.current.videoSourceBuffer && state.current.videoSourceBuffer.hasFatalError) {
          return;
        }
        if (state.current.audioSourceBuffer && state.current.audioSourceBuffer.hasFatalError) {
          return;
        }

        // Bug #16 fix: evict BEFORE appending to prevent QuotaExceededError.
        evictOldBuffer();

        const isVideo = trackId === videoTrackId;
        const isAudio = trackId === audioTrackId;

        if (isVideo && state.current.videoSourceBuffer) {
          state.current.videoSourceBuffer.appendBuffer(buffer);
        }
        if (isAudio && state.current.audioSourceBuffer) {
          state.current.audioSourceBuffer.appendBuffer(buffer);
        }
      };

      // Start mp4box segment generation
      console.log('[MSE] Calling mp4box.start() — sampleProcessingStarted will be set to true');
      mp4box.start();

      // Debug: log sample counts for each track
      try {
        for (const vt of state.current.videoTracks) {
          const samples = mp4box.getTrackSamplesInfo(vt.id);
          console.log(`[MSE] Video track ${vt.id}: totalSamples=${samples?.length ?? 'N/A'}, codec=${vt.codec}`);
          if (samples && samples.length > 0) {
            console.log(`[MSE] Video track ${vt.id} sample 0: offset=${samples[0].offset}, size=${samples[0].size}`);
          }
        }
        for (const at of state.current.audioTracks) {
          const samples = mp4box.getTrackSamplesInfo(at.id);
          console.log(`[MSE] Audio track ${at.id}: totalSamples=${samples?.length ?? 'N/A'}, codec=${at.codec}`);
          if (samples && samples.length > 0) {
            console.log(`[MSE] Audio track ${at.id} sample 0: offset=${samples[0].offset}, size=${samples[0].size}`);
          }
        }
      } catch (e) {
        console.log('[MSE] Could not log sample info:', e);
      }

      // Start downloading and appending (faststarted MP4 — normal path)
      downloadLoop(url);
      // Drive the backend PROACTIVE prebuffer so the disk cache (green bar)
      // marches 0→EOF, independent of the bounded MSE playback buffer above.
      // MP4-only: this callback only fires for the mp4box path.
      startMp4ProactiveReporterRef.current?.();
      // Prefetch audio data in parallel if audio samples are far from the start
      // (moov-at-end files with sequential video→audio layout). Without this,
      // mp4box.js never generates audio segments because the download loop
      // takes minutes to reach audio data at offset ~257MB.
      if (audioTrackId >= 0) {
        prefetchAudioData(url, mp4box, audioTrackId);
      }
    } catch (e: any) {
      if (!cancelledRef.current) {
        setUseNative(true);
      }
    }
  };

  const downloadLoop = async (url: string) => {
    if (cancelledRef.current || !state.current.initialized) return;

    const gen = ++loopGeneration.current; // Capture generation for this loop instance
    state.current.downloading = true;

    while (!cancelledRef.current && state.current.downloading && gen === loopGeneration.current &&
           state.current.currentOffset < state.current.fileLength) {
      // Bug #4 fix: check if SourceBuffer is fatally broken (HTMLMediaElement.error
      // set after CHUNK_DEMUXER_ERROR_APPEND_FAILED). No more data can be appended,
      // so stop downloading immediately to prevent infinite InvalidStateError cascade.
      if ((state.current.videoSourceBuffer && state.current.videoSourceBuffer.hasFatalError) ||
          (state.current.audioSourceBuffer && state.current.audioSourceBuffer.hasFatalError)) {
        console.warn('[Player] SourceBuffer fatal error detected — stopping download loop');
        break;
      }

      // Bug #16 fix: backpressure — if buffer ahead exceeds threshold,
      // pause downloading until playback consumes enough data.
      // This prevents SourceBuffer from filling up past Chrome's quota
      // and triggering QuotaExceededError.
      while (!cancelledRef.current && state.current.downloading && gen === loopGeneration.current) {
        // A queued seek must ALWAYS win over backpressure: the pendingSeek
        // handler below clears the (now stale) buffer, so continuing to wait on
        // a "full" buffer for a position we're about to discard would strand the
        // seek. Break immediately so the handler runs this iteration.
        if (state.current.pendingSeek >= 0) break;
        const ahead = getBufferedAheadSeconds();
        if (ahead <= maxBufferAhead) break;
        // Sleep 2s — let playback consume buffered data before downloading more
        await new Promise(r => setTimeout(r, 2000));
        // Proactively evict during the wait to free space
        evictOldBuffer();
      }
      if (cancelledRef.current || !state.current.downloading || gen !== loopGeneration.current) {
        // TRIPWIRE (permanent): if the loop bails here with a pendingSeek still
        // queued, the seek target was stranded — executeSeek set it but the loop
        // broke on the generation/cancel/downloading guard BEFORE reaching the
        // pendingSeek handler below, so the target is never fetched ("seeked,
        // frame+thumbnail showed the new position, but playback never resumed").
        // Root cause of the historical case was a backpressure deadlock from a
        // stale far buffer island inflating getBufferedAheadSeconds() — fixed via
        // contiguousBufferedAhead() + the pendingSeek-first break above. This warn
        // stays as a regression tripwire: it should never fire in normal use, only
        // on a genuine teardown (cancelled=true) which is expected.
        if (state.current.pendingSeek >= 0) {
          const strandedByte = state.current.pendingSeek;
          const strandedTime = (strandedByte / state.current.fileLength) * state.current.duration;
          console.warn(
            `[SEEK-DIAG] downloadLoop bailed with STRANDED pendingSeek=${strandedByte} (${strandedTime.toFixed(1)}s) — ` +
            `reason: cancelled=${cancelledRef.current} downloading=${state.current.downloading} ` +
            `genStale=${gen !== loopGeneration.current} (gen=${gen}, loopGen=${loopGeneration.current}) ` +
            `currentOffset=${state.current.currentOffset}`
          );
        }
        break;
      }

      // Check for pending seek (set by seekTo when user clicks progress bar
      // on an unbuffered position)
      if (state.current.pendingSeek >= 0) {
        const seekByte = state.current.pendingSeek;
        const seekTime = (seekByte / state.current.fileLength) * state.current.duration;
        state.current.pendingSeek = -1;

        const oldRangeCount = downloadedRangesRef.current.length;
        console.log(`[BUFFER-BAR] SEEK: target=${seekTime.toFixed(1)}s (${formatBytes(seekByte)}), clearing ${oldRangeCount} stale downloaded ranges`);

        // 1. Clear old buffered data from SourceBuffers
        if (state.current.videoSourceBuffer) {
          state.current.videoSourceBuffer.resetForSeek();
        }
        if (state.current.audioSourceBuffer) {
          state.current.audioSourceBuffer.resetForSeek();
        }

        // 2. Clear stale downloaded ranges so green bar resets with grey bar
        clearDownloadedRanges();
        justSeekedRef.current = true;

        // 3. Seek mp4box BEFORE flushing (sample table is intact).
        const seekInfo = state.current.mp4box!.seek(seekTime, true) as any;
        state.current.mp4box!.flush();

        // Use mp4box's exact sync-sample offset, falling back to ratio
        const syncOffset = (seekInfo && typeof seekInfo.offset === 'number')
          ? seekInfo.offset
          : seekByte;

        // If mp4box says the nearest sync sample is at/past fileLength,
        // the seek target is at the very end of the file — no data to download.
        // Set isComplete and trigger the video 'ended' event by setting
        // currentTime to duration and calling play() (which immediately ends).
        if (syncOffset >= state.current.fileLength) {
          console.log(`[MSE] Seek at end: syncOffset=${syncOffset} >= fileLength=${state.current.fileLength} — marking complete`);
          state.current.currentOffset = state.current.fileLength;
          setIsComplete(true);
          isCompleteRef.current = true;
          hasEverCompletedRef.current = true;
          // Do NOT set currentTime=duration or call play() here — that jumps
          // backward seeks near the end to duration and triggers 'ended',
          // creating infinite cycles. The video will reach the end naturally
          // during playback and fire 'ended' on its own.
          break; // Exit download loop — no more data to fetch
        }

        state.current.currentOffset = syncOffset;
        chunksAfterSeek.current = 1;

        // Bug #17 debug: seek-after-completion re-entered loop with new offset
        console.log(`[MSE] Seek processed: seekByte=${seekByte}, syncOffset=${syncOffset}, seekTime=${seekTime.toFixed(1)}s`);

        if (videoRef.current) {
          videoRef.current.currentTime = seekTime;
        }

        // After seek: re-append init segments (codec configuration is needed
        // for new media segments to decode). Both video and audio init
        // segments are re-appended immediately to their respective
        // SourceBuffers.
        const initSegs = initSegmentsRef.current;
        if (initSegs && initSegs.length > 0) {
          for (const seg of initSegs) {
            if (seg.id === state.current.videoTrackId && state.current.videoSourceBuffer) {
              state.current.videoSourceBuffer.appendBuffer(seg.buffer.slice(0));
            }
            if (seg.id === state.current.audioTrackId && state.current.audioSourceBuffer) {
              state.current.audioSourceBuffer.appendBuffer(seg.buffer.slice(0));
            }
          }
        }
        // Re-prefetch audio data after seek so audio segments can resume
        if (state.current.audioTrackId >= 0) {
          prefetchAudioData(url, state.current.mp4box!, state.current.audioTrackId);
        }
      }

      // Skip byte ranges already fetched by the audio prefetch to avoid
      // double-fetching and duplicate buffers in mp4box's internal list.
      const audioRange = audioPrefetchedRangeRef.current;
      if (audioRange && state.current.currentOffset >= audioRange[0] && state.current.currentOffset < audioRange[1]) {
        console.log(`[MSE] Skipping audio prefetched range: ${audioRange[0]}-${audioRange[1]}`);
        state.current.currentOffset = audioRange[1];
      }

      const offset = state.current.currentOffset;
      const chunkSize = getChunkSize(chunksAfterSeek.current);
      const end = Math.min(offset + chunkSize - 1, state.current.fileLength - 1);
      chunksAfterSeek.current++;

      // Create a new AbortController for this fetch
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        let response: Response | null = null;
        let retries = 3;
        while (retries > 0) {
          try {
            response = await fetch(url, {
              headers: { Range: `bytes=${offset}-${end}` },
              signal: controller.signal,
            });
            break; // Success
          } catch (fetchErr: any) {
            if (fetchErr.name === 'AbortError') throw fetchErr;
            retries--;
            if (retries === 0) throw fetchErr;
            await new Promise(r => setTimeout(r, (4 - retries) * 1000)); // 1s, 2s backoff
          }
        }

        if (cancelledRef.current || !response) break;

        if (!response.ok && response.status !== 206) {
          break;
        }

        // Track whether this chunk came from disk cache (HIT) or Telegram (MISS).
        // Drives the PROACTIVE reporter: disk HITs must NOT make PROACTIVE yield.
        lastDownloadWasCacheHitRef.current = response.headers.get('X-Cache') === 'HIT';

        const data = await response.arrayBuffer();
        if (cancelledRef.current) break;

        // Feed to mp4box for segmentation
        const buffer = data as any;
        buffer.fileStart = offset;
        const appendResult = state.current.mp4box!.appendBuffer(buffer);
        state.current.mp4box!.flush();

        // Debug: log append result (mp4box returns next needed position)
        if (chunksAfterSeek.current <= 5) {
          console.log(`[MSE] downloadLoop: appended ${data.byteLength} bytes at offset=${offset}, nextFileStart=${appendResult}`);
        }

        // Update tracking
        state.current.currentOffset = offset + data.byteLength;

        // Track for green buffer bar
        trackDownloadedRange(offset, offset + data.byteLength - 1);

        // Throttle React state updates to every 250ms
        const now = Date.now();
        if (now - lastThrottleRef.current > 250) {
          lastThrottleRef.current = now;
          setPrefetchedBytes(state.current.currentOffset);
        }
      } catch (e: any) {
        if (cancelledRef.current) break;
        if (e.name === 'AbortError') {
          if (state.current.pendingSeek >= 0) {
            continue;
          }
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    state.current.downloading = false;

    // Only set isComplete if we reached the end (not interrupted by seek)
    const reachedEnd = state.current.currentOffset >= state.current.fileLength;
    console.log(`[MSE] Download loop exited: offset=${state.current.currentOffset}, fileLength=${state.current.fileLength}, reachedEnd=${reachedEnd}, pendingSeek=${state.current.pendingSeek}`);
    // TRIPWIRE + SELF-HEAL: a pendingSeek still set at loop exit means the seek
    // target was never fetched/appended — stranded regardless of which exit route
    // (mid-body guard or top-level while condition) the loop took.
    if (state.current.pendingSeek >= 0) {
      const strandedByte = state.current.pendingSeek;
      const strandedTime = (strandedByte / state.current.fileLength) * state.current.duration;
      // Self-heal: if this exit was NOT a teardown (cancelled), NOT a user pause,
      // and this is still the current loop generation (no newer loop already
      // running), respawn the loop so the stranded seek gets served. This is the
      // final safety net beneath contiguousBufferedAhead() + the pendingSeek-first
      // break; those prevent the deadlock, this recovers from any unforeseen exit.
      const loopFn = downloadLoopRef.current;
      const canSelfHeal =
        !cancelledRef.current &&
        !isPausedRef.current &&
        gen === loopGeneration.current &&
        !!loopFn &&
        // Guard against a tight respawn loop: the target must be fetchable (a
        // real seek sets currentOffset = seekByte < fileLength; the "Seek at
        // end" branch already clears pendingSeek, so this is belt-and-braces).
        state.current.currentOffset < state.current.fileLength;
      if (canSelfHeal && loopFn) {
        console.warn(`[SEEK-DIAG] downloadLoop EXITED with STRANDED pendingSeek=${strandedByte} (${strandedTime.toFixed(1)}s) — respawning loop to serve it`);
        state.current.downloading = true;
        setIsPrefetching(true);
        loopFn(url);
        return; // new loop instance owns completion/state from here
      }
      console.warn(`[SEEK-DIAG] downloadLoop EXITED with STRANDED pendingSeek=${strandedByte} (${strandedTime.toFixed(1)}s) — not served (cancelled=${cancelledRef.current} paused=${isPausedRef.current} genStale=${gen !== loopGeneration.current})`);
    }
    if (!cancelledRef.current) {
      if (reachedEnd) {
        console.log('[MSE] isComplete=true — video reached end');
        setIsComplete(true);
        isCompleteRef.current = true;
          hasEverCompletedRef.current = true;
      }
      setIsPrefetching(false);
    }
  };
  downloadLoopRef.current = downloadLoop;

  /**
   * MP4 green-bar-to-EOF prebuffer driver.
   *
   * The frontend downloadLoop only fills the bounded MSE playback buffer
   * (capped at `maxBufferAhead` seconds to avoid QuotaExceededError), so on its
   * own the disk cache — and therefore the green bar — never marches past ~30s
   * ahead of the playhead. The backend PROACTIVE prebuffer
   * (proactive_prebuffer_download) DOES fill disk 0→EOF and already handles the
   * initial forward march, the +40s-ahead seek offset, and rate-limiter yielding
   * to /stream. It is triggered purely by cmd_report_playback_position — which
   * every path EXCEPT MP4 already calls. This reporter wires MP4 up to it.
   *
   * COORDINATION: is_player_downloading is reported TRUE only while the
   * downloadLoop is actively pulling its bounded window (buffer below the cap).
   * When the window is full the loop sleeps → we report FALSE → the backend
   * PROACTIVE fills disk ahead to EOF during those gaps. This preserves the
   * "never two Telegram downloads at once" (FLOOD_PREMIUM_WAIT) invariant: the
   * player always wins the budget while it needs data; PROACTIVE fills the rest
   * during idle. Once PROACTIVE races ahead, the loop's /stream reads become
   * disk cache HITs (no Telegram), so there is no real contention.
   *
   * PAUSE: honored via pausePrefetch(), which already calls
   * cmd_stop_proactive_prebuffer and clears proactiveIntervalRef using the refs
   * this function sets. Paused stays paused across seeks (the seek reposition
   * report is gated on !isPausedRef).
   */
  const startMp4ProactiveReporter = () => {
    const fileId = file?.id;
    const folderId = activeFolderId; // null = "home" (Saved Messages) — backend accepts Option
    const fileSize = state.current.fileLength;
    // Only MP4 (mp4box) playback; never TS (mpegts) or MKV (transmuxer).
    if (!fileId || !fileSize || fileSize <= 0) return;
    if (isPausedRef.current) return;
    // Don't stack intervals — one reporter per file.
    if (proactiveIntervalRef.current) return;

    proactivePrebufferMsgIdRef.current = fileId;
    const tick = async () => {
      const v = videoRef.current;
      if (!v) return;
      const dur = state.current.duration || 0;
      if (dur <= 0) return;
      // Report TRUE only when the player is genuinely pulling from Telegram and
      // thus competing with PROACTIVE for the rate limiter. Three gates:
      //   1. loop is filling its bounded window (buffer below cap), AND
      //   2. not complete, AND
      //   3. the last chunk was a real Telegram fetch (cache MISS) — NOT a disk
      //      HIT. Once PROACTIVE races ahead, refills are disk HITs; flagging
      //      those as "downloading" made PROACTIVE needlessly yield → the green
      //      bar pulsed/stalled. Disk refills cost no Telegram budget, so we let
      //      PROACTIVE keep marching. Only a cold seek into unwarmed data (MISS)
      //      makes the player win the budget again.
      const isDownloading =
        state.current.downloading &&
        !isCompleteRef.current &&
        !lastDownloadWasCacheHitRef.current &&
        getBufferedAheadSeconds() < maxBufferAhead;
      try {
        await invoke('cmd_report_playback_position', {
          messageId: fileId,
          folderId: folderId,
          currentTimeS: v.currentTime,
          durationS: dur,
          fileSize: fileSize,
          isPlayerDownloading: isDownloading,
          playbackRate: v.playbackRate || 1.0,
          byteOffset: null, // periodic reports use linear estimate; seek reports pass an explicit byte
        });
      } catch { /* ignore */ }
    };
    // 2s cadence: fine enough to track the loop's backpressure cycle and slide
    // the backend window smoothly, cheap enough to be negligible.
    const id = setInterval(tick, 2000);
    proactiveIntervalRef.current = id;
    // Fire one immediately so PROACTIVE can start without a 2s delay.
    tick();
  };
  startMp4ProactiveReporterRef.current = startMp4ProactiveReporter;

  // Direct seek function — avoids hard-restarting the download loop.
  // For already-buffered positions: just set currentTime, no download restart.
  // For unbuffered positions: the FIRST seek is instant (responsive feel),
  // then subsequent rapid seeks within SEEK_DEBOUNCE_MS are debounced so
  // only the LAST position in the rapid-fire window actually executes.
  // This prevents overlapping downloads from arrow-key spam while keeping
  // deliberate single-clicks feeling instant.
  const seekTo = useCallback(async (timeSeconds: number) => {
    if (!streamUrl || useNative) return;
    if (state.current.fileLength <= 0 || !isFinite(timeSeconds) || timeSeconds < 0) return;

    const clampedTime = Math.min(timeSeconds, state.current.duration - 0.001);

    // mpegts.js seek: use player.currentTime for buffered seeks.
    // For unbuffered seeks, use _mpegtsUnbufferedSeek (IOController.seek + flush).
    // WHY NOT destroy+recreate: The FetchStreamLoader.abort() patch (above) now
    // properly calls abortController.abort() on Chrome/WebView2, making
    // IOController.seek() reliable — the old fetch stream is cleanly killed before
    // the new Range request opens. With lazyLoad enabled, the new Range request
    // is also self-limiting: mpegts.js pauses the download after buffering
    // lazyLoadMaxDuration seconds (recoverDuration) before the buffer end.
    // entire file tail from seek point to EOF.
    // mpegts.js seek path — engages whenever mpegts.js is the active player,
    // regardless of container. This covers native TS, timed_id3 TS remux, AND
    // MKV-via-/remux (all feed mpegts.js an MPEG-TS stream). Gating on the live
    // `mpegtsPlayerRef` — not on formatRef — is what routes MKV seeks here
    // instead of falling through to the MP4Box download loop ("moov not
    // received"). MP4 has no mpegtsPlayerRef; the backend-fMP4 seek below is a
    // separate `formatRef==='ts' && fmp4PipelineActiveRef` block, unaffected.
    if (mpegtsPlayerRef.current) {
      const dur = mpegtsDurationRef.current || state.current.duration;
      if (!dur || dur <= 0 || !isFinite(dur)) return;
      const video = videoRef.current;
      if (!video) return;

      const clamped = Math.max(0, Math.min(timeSeconds, dur - 0.1));

      // Check if the target position is buffered (SourceBuffer) or cached (disk/shadow cache)
      const isBuffered = (() => {
        const sb = video.buffered;
        for (let i = 0; i < sb.length; i++) {
          if (clamped >= sb.start(i) && clamped < sb.end(i)) return true;
        }
        return false;
      })();

      // Disk-cached range check: is `forwardSec` seconds from the seek target
      // cached on disk? Uses the VBR byte/time index for accurate byte offsets.
      // The required forward window differs by context (see call site below).
      const isSeekToCachedRange = (targetTime: number, forwardSec: number) => {
        const fileLen = state.current.fileLength || 0;
        const duration = mpegtsDurationRef.current || state.current.duration || 0;
        if (!shadowCacheRef.current || fileLen === 0 || duration === 0) return false;
        const startByte = byteOffsetAtOrBeforeTime(tsKeyframeIndexRef.current, targetTime, duration, fileLen);
        const endByte = byteOffsetAtOrBeforeTime(
          tsKeyframeIndexRef.current,
          Math.min(targetTime + forwardSec, duration),
          duration,
          fileLen
        );
        const endByteClamped = Math.min(endByte, fileLen - 1);
        if (endByteClamped <= startByte || endByteClamped <= 0) return false;
        const run = shadowCacheRef.current.cachedRunFrom(startByte);
        return run !== null && run.end >= endByteClamped;
      };

      // Forward-window requirement differs by pause state:
      //  - Running (180s): the interceptor can burst a full lookahead window
      //    instantly, so require it cached for smooth uninterrupted playback.
      //  - Paused (8s): "paused = no Telegram", so we can't fetch a 180s window
      //    anyway. We only need enough cached data AT the target to start
      //    playing; the recreate align-poll's boundary-stall detector then pauses
      //    the loader exactly at the cache edge. Without this relaxation, a paused
      //    seek into a partially-cached region (e.g. 50s cached, 180s required)
      //    is wrongly classified blocked-paused and the video never plays — the
      //    reported bug.
      const CACHE_FORWARD_BURST_SEC = 180;
      const CACHE_FORWARD_PAUSED_MIN_SEC = 8;
      const isCacheHit = !isBuffered && isSeekToCachedRange(
        clamped,
        isPausedRef.current ? CACHE_FORWARD_PAUSED_MIN_SEC : CACHE_FORWARD_BURST_SEC
      );

      // Single source of truth for the pause/seek policy (unit-tested via
      // decideTsSeekAction). buffered→memory, cache→disk, network→Telegram,
      // blocked-paused→honor pause (no Telegram).
      const seekAction = decideTsSeekAction(isPausedRef.current, isBuffered, isCacheHit);

      if (seekAction === 'buffered') {
        // Buffered seek — just set currentTime (mpegts.js handles it).
        // Reads from the in-memory SourceBuffer; allowed even while paused.
        diagLog(`[MPEGTS] Buffered seek to ${clamped.toFixed(1)}s`);
        video.currentTime = clamped;
      } else if (seekAction === 'cache') {
        // Cached seek — data is on disk, server will serve instantly.
        // Still need unbuffered seek (mpegts must re-transmux), but the
        // loading latency will be minimal (~0.5-1s for transmux).
        // Suppress loading spinner for cache-hit seeks.
        diagLog(`[MPEGTS] Cache-hit seek to ${clamped.toFixed(1)}s (disk cached, suppressing spinner)`);
        suppressLoadingSpinnerRef.current = true;
        // M7 fix: check seek-in-progress flag instead of calling directly.
        // If a seek is already running, queue this as pending to prevent
        // concurrent _mpegtsUnbufferedSeek calls without adding debounce latency.
        if ((window as any).__nobuf_userSeekInProgress === true) {
          pendingSeekTargetRef.current = { time: clamped, dur };
          diagLog(`[MPEGTS] Cache-hit seek to ${clamped.toFixed(1)}s queued as pending (seek in progress)`);
        } else {
          await _mpegtsUnbufferedSeek(clamped, dur);
        }
        // Auto-clear suppress after 3s (safety net)
        setTimeout(() => { suppressLoadingSpinnerRef.current = false; }, 3000);
      } else if (seekAction === 'blocked-paused') {
        // PREFETCH-PAUSE GUARD: target is unbuffered (would fetch from Telegram)
        // AND prefetch is paused. "Paused means paused" — the only thing that
        // resumes downloading is the explicit resume button. Instead of
        // recreating the player (which opens a fresh IOController and pulls from
        // Telegram), record the desired position and update the UI. On resume,
        // resumePrefetch() calls _mpegtsUnbufferedSeek(video.currentTime), which
        // fetches from exactly this position.
        diagLog(`[MPEGTS] Unbuffered seek to ${clamped.toFixed(1)}s while PAUSED — staying paused, no Telegram fetch (resume will fetch from here)`);
        const v = videoRef.current;
        if (v) {
          // Reposition the playhead for UI/resume without triggering mpegts.js's
          // SeekingHandler → IOController resume. The IOController is already
          // paused (ioctl.pause() in pausePrefetch); setting currentTime to an
          // unbuffered region leaves the frame frozen until resume, which is the
          // intended "no internet" behavior.
          try { v.currentTime = clamped; } catch (_) {}
        }
        // Do NOT set __nobuf_seekTargetTime here. That flag is the deferred-play
        // suppressor for an IN-FLIGHT unbuffered load — it holds the progress bar
        // and gates onCanPlay/onMeta auto-play until the align poll clears it.
        // A blocked-paused seek has NO in-flight load (nothing is fetching), so
        // the flag would never clear: it would pin the bar at a position we're
        // not at and block auto-play on the next buffered seek / resume. The
        // currentTime set above moves the bar honestly via the native seeked event.
        // Cancel any queued unbuffered seek so a stale one can't fire post-resume.
        if (mpegtsSeekDebounceRef.current !== null) {
          clearTimeout(mpegtsSeekDebounceRef.current);
          mpegtsSeekDebounceRef.current = null;
        }
        pendingSeekTargetRef.current = null;
        return;
      } else {
        // seekAction === 'network' — not paused and target is unbuffered, so
        // fetch from Telegram. Use a 400ms debounce so rapid scrubbing only
        // triggers one seek (the LAST one wins). If a seek is already in
        // progress when the debounce fires, store the target as pending and
        // execute it after the in-progress seek completes.
        const TS_SEEK_DEBOUNCE_MS = 400;

        // Cancel any previous debounce timer — only the last seek in a
        // rapid-fire series should execute.
        if (mpegtsSeekDebounceRef.current !== null) {
          clearTimeout(mpegtsSeekDebounceRef.current);
          mpegtsSeekDebounceRef.current = null;
        }

        // Record seek-request timestamp for thumbnail suppression.
        // __nobuf_userSeekInProgress is NOT set here — it's only set inside
        // _mpegtsUnbufferedSeek() and cleared in its finally block. Setting
        // it here would deadlock the debounce callback (which checks the flag
        // to decide whether to queue or execute).
        (window as any).__nobuf_seekRequestedAt = Date.now();
        // Immediately store the seek target so the UI shows the correct
        // progress bar position during the debounce wait + recreation.
        (window as any).__nobuf_seekTargetTime = clamped;

        mpegtsSeekDebounceRef.current = window.setTimeout(() => {
          mpegtsSeekDebounceRef.current = null;
          // Dedup: skip if we'd re-execute the exact same seek position
          if (Math.abs(clamped - mpegtsLastExecutedSeekRef.current) < 0.1) {
            return;
          }
          const seekInProgressNow = (window as any).__nobuf_userSeekInProgress === true;
          if (seekInProgressNow) {
            // A seek is still executing — queue this target as pending.
            // The in-progress seek's finally block will check pendingSeekTargetRef
            // and execute it after clearing the flag.
            pendingSeekTargetRef.current = { time: clamped, dur };
            diagLog(`[MPEGTS] Seek to ${clamped.toFixed(1)}s queued — will execute after current seek completes`);
          } else {
            diagLog(`[MPEGTS] Seek debounce fired for ${clamped.toFixed(1)}s — executing`);
            _mpegtsUnbufferedSeek(clamped, dur);
          }
        }, TS_SEEK_DEBOUNCE_MS);
      }
      return;
    }

    if (!state.current.initialized) return;

    // fMP4 pipeline seek: TS files using backend /fmp4/ endpoints.
    // Uses keyframe index for fast byte-offset lookup (like MP4 path),
    // avoiding mux.js's slow getKeyPacket (8-18s). Falls back to mux.js
    // if the fMP4 pipeline fails mid-seek.
    if (formatRef.current === 'ts' && fmp4PipelineActiveRef.current && !transmuxerRef.current) {
      const video = videoRef.current;
      if (!video) return;

      // Near-end FORWARD seek guard (same logic as other paths)
      if (hasEverCompletedRef.current && clampedTime >= state.current.duration - 5.1) {
        if (video.ended) return;
        const isForwardSeek = clampedTime > video.currentTime;
        if (isForwardSeek) {
          if (seekDebounceTimerRef.current !== null) {
            clearTimeout(seekDebounceTimerRef.current);
            seekDebounceTimerRef.current = null;
          }
          diagLog(`[MSE-TS-FMP4] Near-end FORWARD seek after completion: ${clampedTime.toFixed(1)}s — forcing video end`);
          video.pause();
          const sb = video.buffered;
          const nearEndThreshold = state.current.duration - 5.1;
          let nearEndTime: number | null = null;
          for (let i = 0; i < sb.length; i++) {
            if (sb.end(i) >= nearEndThreshold) {
              nearEndTime = Math.min(sb.end(i) - 0.05, state.current.duration);
              break;
            }
          }
          if (nearEndTime !== null) {
            video.currentTime = nearEndTime;
          }
          video.dispatchEvent(new Event('ended'));
          return;
        }
      }

      // Check if already buffered — instant seek
      const buffered = video.buffered;
      for (let i = 0; i < buffered.length; i++) {
        if (clampedTime >= buffered.start(i) && clampedTime <= buffered.end(i)) {
          diagLog(`[MSE-TS-FMP4] Seek buffered: ${clampedTime.toFixed(1)}s — instant`);
          video.currentTime = clampedTime;
          if (seekDebounceTimerRef.current !== null) {
            clearTimeout(seekDebounceTimerRef.current);
            seekDebounceTimerRef.current = null;
          }
          return;
        }
      }

      // Unbuffered seek — use MP4-style debounce (500ms, not 2000ms)
      const debounceMs = SEEK_DEBOUNCE_MS;
      const isFirstSeek = lastSeekTimeRef.current === 0 || (Date.now() - lastSeekTimeRef.current) >= debounceMs;
      diagLog(`[MSE-TS-FMP4] Seek unbuffered: ${clampedTime.toFixed(1)}s — ${isFirstSeek ? 'instant' : 'debounced'} (debounce=${debounceMs}ms)`);

      // Set currentTime for visual feedback
      video.currentTime = clampedTime;

      const executeFmp4Seek = async () => {
        setIsComplete(false);
        isCompleteRef.current = false;
        lastSeekTimeRef.current = Date.now();
        clearDownloadedRanges();

        // Stop current download loop via generation counter
        loopGeneration.current++;

        try {
          const parsed = parseStreamUrl(streamUrl);
          if (!parsed) {
            diagLog('[MSE-TS-FMP4] Seek failed: could not parse stream URL');
            return;
          }

          const { baseUrl, folderId, messageId, token } = parsed;
          const fmp4BaseUrl = `${baseUrl}/fmp4`;
          const queryParams = `token=${encodeURIComponent(token)}`;

          // Binary search keyframe index for nearest keyframe <= seekTime
          const kfIndex = byteToTimeTableRef.current; // [byte_offset, timestamp_s][]
          let seekByteOffset = 0;
          if (kfIndex.length > 0) {
            let lo = 0, hi = kfIndex.length - 1;
            while (lo <= hi) {
              const mid = (lo + hi) >> 1;
              if (kfIndex[mid][1] <= clampedTime) {
                seekByteOffset = kfIndex[mid][0];
                lo = mid + 1;
              } else {
                hi = mid - 1;
              }
            }
          } else {
            // No keyframe index — fall back to linear byte offset estimate
            seekByteOffset = Math.floor((clampedTime / state.current.duration) * state.current.fileLength);
          }

          diagLog(`[MSE-TS-FMP4] Seeking to byte_offset=${seekByteOffset} (keyframe for t=${clampedTime.toFixed(1)}s)`);

          // Clear SourceBuffer
          const sb = state.current.videoSourceBuffer;
          if (sb) {
            try {
              await sb.resetForSeek();
            } catch (e) {
              diagLog(`[MSE-TS-FMP4] SourceBuffer resetForSeek error: ${e}`);
            }
          }

          // Re-append init segments (codec config needed after SB clear)
          const initSegs = initSegmentsRef.current;
          if (initSegs && initSegs.length > 0 && sb) {
            for (const seg of initSegs) {
              sb.appendBuffer(seg.buffer.slice(0));
            }
            await sb.waitForQueueDrain();
          }

          // Fetch segment at seek position from backend
          // Use align=keyframe for seeks to ensure we start at a keyframe
          // (required for correct decoding after a seek)
          const segResp = await fetch(
            `${fmp4BaseUrl}/segment/${folderId}/${messageId}?${queryParams}&byte_offset=${seekByteOffset}&duration=5&align=keyframe`
          );

          if (!segResp.ok) {
            diagLog(`[MSE-TS-FMP4] Seek segment fetch failed: ${segResp.status}`);
            return;
          }

          const segData = await segResp.arrayBuffer();
          const actualStartTime = parseFloat(segResp.headers.get('X-Segment-Start-Time') || segResp.headers.get('X-Actual-Start-Time') || '0');
          const nextOffset = parseInt(segResp.headers.get('X-Next-Byte-Offset') || '0', 10);

          if (segData.byteLength === 0) {
            diagLog('[MSE-TS-FMP4] Seek segment empty — possibly at end of file');
            return;
          }

          // Set timestampOffset and append seek segment
          if (sb) {
            sb.setTimestampOffset(actualStartTime);
            sb.appendBuffer(segData);
            await sb.waitForQueueDrain();
          }

          // Set video.currentTime to actual keyframe position
          video.currentTime = actualStartTime;

          // Update byte offset and restart download loop from seek position
          fmp4CurrentByteOffsetRef.current = nextOffset || (seekByteOffset + segData.byteLength);
          state.current.currentOffset = fmp4CurrentByteOffsetRef.current;

          // Update time tracking so the download loop's overlap filtering
          // knows the current position (byte_offset is primary, time is for
          // PTS overlap filtering in align=none mode).
          const seekEndTime = parseFloat(segResp.headers.get('X-Segment-End-Time') || '0');
          if (seekEndTime > 0) {
            fmp4CurrentTimeRef.current = seekEndTime;
          } else {
            fmp4CurrentTimeRef.current = actualStartTime;
          }

          // Track downloaded range for buffer bar
          trackDownloadedRange(seekByteOffset, fmp4CurrentByteOffsetRef.current - 1);

          diagLog(`[MSE-TS-FMP4] Seek complete: actualStart=${actualStartTime.toFixed(2)}s, nextOffset=${fmp4CurrentByteOffsetRef.current}`);

          // After seek, the expected start time should be the actual start of
          // the seek segment in the SourceBuffer timeline
          fmp4ExpectedStartTimeRef.current = actualStartTime;

          // Restart download loop from new offset
          state.current.downloading = true;
          setIsPrefetching(true);
          if (downloadLoopRef.current) {
            downloadLoopRef.current('');
          }
        } catch (e) {
          diagLog(`[MSE-TS-FMP4] Seek failed: ${e}`);
        }
      };

      // Debounce logic (same pattern as other paths)
      const timeSinceLastSeek = Date.now() - lastSeekTimeRef.current;
      if (timeSinceLastSeek >= debounceMs || lastSeekTimeRef.current === 0) {
        if (seekDebounceTimerRef.current !== null) {
          clearTimeout(seekDebounceTimerRef.current);
          seekDebounceTimerRef.current = null;
        }
        executeFmp4Seek();
      } else {
        if (seekDebounceTimerRef.current !== null) {
          clearTimeout(seekDebounceTimerRef.current);
        }
        const remainingDebounce = debounceMs - timeSinceLastSeek;
        seekDebounceTimerRef.current = window.setTimeout(() => {
          seekDebounceTimerRef.current = null;
          executeFmp4Seek();
        }, remainingDebounce);
      }
      return; // Skip transmuxer and MP4 seek paths
    }

    // Transmuxer seek: TS/MKV files use time-based seeking, not byte-range
    if (transmuxerRef.current) {
      const video = videoRef.current;
      if (!video) return;

      // Near-end FORWARD seek guard (same logic as MP4 path):
      // After completion, forward seeks near the end → force video end.
      // Backward seeks must fall through to normal flow to avoid infinite cycles.
      if (hasEverCompletedRef.current && clampedTime >= state.current.duration - 5.1) {
        if (video.ended) return;
        const isForwardSeek = clampedTime > video.currentTime;
        if (isForwardSeek) {
          if (seekDebounceTimerRef.current !== null) {
            clearTimeout(seekDebounceTimerRef.current);
            seekDebounceTimerRef.current = null;
          }
          console.log(`[MSE] Transmuxer near-end FORWARD seek after completion: ${clampedTime.toFixed(1)}s — forcing video end`);
          video.pause();
          const sb = video.buffered;
          const nearEndThreshold = state.current.duration - 5.1;
          let nearEndTime: number | null = null;
          for (let i = 0; i < sb.length; i++) {
            if (sb.end(i) >= nearEndThreshold) {
              nearEndTime = Math.min(sb.end(i) - 0.05, state.current.duration);
              break;
            }
          }
          if (nearEndTime !== null) {
            video.currentTime = nearEndTime;
          }
          video.dispatchEvent(new Event('ended'));
          return;
        } else {
          console.log(`[MSE] Transmuxer near-end BACKWARD seek after completion: ${clampedTime.toFixed(1)}s — allowing normal seek`);
        }
      }

      // Check if already buffered — instant seek, no debounce needed
      const buffered = video.buffered;
      for (let i = 0; i < buffered.length; i++) {
        if (clampedTime >= buffered.start(i) && clampedTime <= buffered.end(i)) {
          console.log(`[MSE] Transmuxer seek buffered: ${clampedTime.toFixed(1)}s — instant`);
          video.currentTime = clampedTime;
          // Clear any pending debounce timer
          if (seekDebounceTimerRef.current !== null) {
            clearTimeout(seekDebounceTimerRef.current);
            seekDebounceTimerRef.current = null;
          }
          return;
        }
      }

      // Unbuffered — apply debounce logic with format-aware timing.
      // TS format uses longer debounce (2000ms) because getKeyPacket takes 8-12s
      // and rapid progress bar dragging wastes multiple canceled getKeyPacket calls.
      // MP4/MKV uses shorter debounce (500ms) since their seeks are faster.
      // Also: if a previous seek is still in progress (transmuxerSeekInProgressRef),
      // force debouncing regardless of timing — prevents concurrent seeks during
      // a long-running getKeyPacket (8-18s for TS).
      const debounceMs = formatRef.current === 'ts' ? SEEK_DEBOUNCE_MS_TS : SEEK_DEBOUNCE_MS;
      const isSeekInProgress = transmuxerSeekInProgressRef.current;
      const isFirstSeek = !isSeekInProgress && (lastSeekTimeRef.current === 0 || (Date.now() - lastSeekTimeRef.current) >= debounceMs);
      console.log(`[MSE] Transmuxer seek unbuffered: ${clampedTime.toFixed(1)}s — ${isFirstSeek ? 'instant' : 'debounced'} (debounce=${debounceMs}ms, format=${formatRef.current}, seekInProgress=${isSeekInProgress})`);

      // Set currentTime for visual feedback
      video.currentTime = clampedTime;

      const executeTransmuxerSeek = () => {
        setIsComplete(false);
        isCompleteRef.current = false;
        lastSeekTimeRef.current = Date.now();
        transmuxerSeekInProgressRef.current = true; // Prevent concurrent seeks
        // PROBE (seek-to-play): mark the true start of this executed seek. The
        // 'seeked' handler logs the delta to first decodable frame. Captured per
        // executed seek; a superseded seek bails before its commit, so the value
        // is overwritten by the winning seek's execute — measuring the winner.
        seekToPlayStartRef.current = performance.now();
        seekToPlayTargetRef.current = clampedTime;
        // Bump + capture the seek generation. The async completion below checks
        // this via isSeekSuperseded() and bails if a newer seek arrived while
        // this one was resolving (5-8s on a cold far jump) — preventing a stale
        // seek from committing currentTime/chain/refill on a PREVIOUS position.
        const seekGen = ++transmuxerSeekGenRef.current;
        clearDownloadedRanges();

        // Cancel the stale MKV disk warmer NOW, at seek START. WHY HERE (not at
        // completion): the warmer is repositioned in the seek's .then() block
        // AFTER the 10-17s transmux iteration — so without this, the pre-seek
        // warmer (e.g. warming 0-68MB) keeps competing for the throttled pipe
        // during the ENTIRE iteration, starving the seek's own reads and
        // inflating iteration to 10-17s (trace-31 root cause). Bumping the gen
        // makes the in-flight warmer loop bail at its next gen check; the
        // completion handler starts a fresh warmer at the resolved target. A
        // superseded seek bails before that reposition (isSeekSuperseded guard),
        // so no orphan warmer is left at an abandoned position.
        mkvWarmerGenRef.current++;
        mkvWarmerActiveRef.current = false;

        // Re-target the backend proactive download to the seek position. Without
        // this, the Rust prebuffer keeps downloading SEQUENTIALLY from the OLD
        // playhead while mediabunny's getKeyPacket blocks on cold seek-target
        // cluster bytes → the 5-29s "prebuffers from wrong place / won't play"
        // stall. cmd_report_playback_position with an explicit byteOffset makes
        // the backend detect the playhead jump and re-prioritize (see
        // [PROACTIVE] "playhead jumped forward … re-evaluating gaps"). We pass the
        // linear byte estimate for the target time; the backend refines from its
        // own reads. MKV-only — TS uses its periodic reporter + byte-offset index.
        {
          const _fid = file?.id, _folder = activeFolderId, _fsz = state.current.fileLength; // _folder null = "home"
          if (_fid && _fsz > 0 && state.current.duration > 0) {
            // Prefer the REAL VBR cluster byte from mediabunny's parsed Cues; fall
            // back to the linear estimate only if the cue index is unavailable.
            const realByte = (transmuxerRef.current as any)?.getByteOffsetForTime?.(clampedTime) ?? -1;
            const rawTargetByte = realByte >= 0
              ? realByte
              : Math.floor((clampedTime / state.current.duration) * _fsz);
            // SEEK-BACKOFF: the proactive download starts forward FROM the byte we
            // report, and the backend only treats a download as "covering" a read
            // when download.start_byte <= read.start_byte (stream_cache.rs
            // find_best_covering_download). But mediabunny's actual first cluster
            // read lands SLIGHTLY BEFORE the cue's clusterPosition (it parses the
            // EBML cluster header / element IDs that precede the cue byte — observed
            // ~88KB earlier: cue=628973912 vs real read=628883456). Reporting the
            // exact cue byte leaves that prefix permanently uncached: the read falls
            // through to the cache-poll, the proactive fill never writes those bytes,
            // and TauriStreamSource empty-retries until the 30s fallback — the seek
            // hangs with no playback and no prebuffer (proven: trace 19, seek 1256.9s).
            // Back off 2MB so the download always starts before mediabunny's real
            // read. Cost is a one-time ~2MB pre-roll that's parsed through to the
            // keyframe; playback is unaffected.
            const SEEK_BYTE_BACKOFF = 2 * 1024 * 1024;
            const targetByte = Math.max(0, rawTargetByte - SEEK_BYTE_BACKOFF);
            invoke('cmd_report_playback_position', {
              messageId: _fid,
              folderId: _folder,
              currentTimeS: clampedTime,
              durationS: state.current.duration,
              fileSize: _fsz,
              isPlayerDownloading: true,
              playbackRate: 1.0,
              byteOffset: targetByte,
            }).catch(() => {});
          }
        }

        // Stop streaming chain — new seek will start its own chain after completion
        stopStreamingChain();
        refillInProgressRef.current = false;
        // Clear burst buffer on seek
        burstBufferRef.current = [];

        const sbVideo = state.current.videoSourceBuffer;
        if (sbVideo) {
          // Enable buffering mode: segments produced during seekTo will be
          // buffered in seekBufferRef instead of appended to the SourceBuffer.
          // This is necessary because setTimestampOffset() clears the SB queue,
          // and we can't set timestampOffset until we know the keyframe timestamp.
          bufferingForSeekRef.current = true;
          seekBufferRef.current = [];

          // Reset SourceBuffers for seek
          const sbAudio = state.current.audioSourceBuffer;
          const resetPromises = [sbVideo.resetForSeek()];
          if (sbAudio) resetPromises.push(sbAudio.resetForSeek());

          Promise.all(resetPromises).then(async () => {
            // Fix #1: stop the post-seek initial fill on a keyframe boundary so
            // the buffer end lands ON a keyframe and refill #1 abuts it cleanly.
            // Use the SMALL SEEK_START_DURATION window (not 25s) so playback
            // starts after ~1-2s of download instead of waiting for the full
            // runway; the refill chain extends it in the background.
            const seekStop = transmuxerRef.current!.nextKeyframeAtOrAfter(clampedTime + SEEK_START_DURATION) ?? Infinity;
            const keyframeTimestamp = await transmuxerRef.current!.seekTo(clampedTime, SEEK_START_DURATION, { stopTime: seekStop });

            bufferingForSeekRef.current = false;

            // SUPERSESSION GUARD: a newer user seek was requested while this one
            // was resolving (cold far seeks take 5-8s). Committing this stale
            // result would set currentTime/startStreamingChain/refill on a
            // PREVIOUS position — the trace-22 "backward seek jumps to previous
            // point". Bail: drop the buffered segments, leave transmuxerSeek-
            // InProgress true is WRONG (the drain waits on it), so clear it so
            // the pending latest target can run. The transmuxer's own seekGen
            // already discarded this seek's packets on the next seekTo().
            if (isSeekSuperseded(seekGen, transmuxerSeekGenRef.current)) {
              seekBufferRef.current = [];
              transmuxerSeekInProgressRef.current = false;
              console.log(`[MSE] Transmuxer seek superseded (gen ${seekGen} vs ${transmuxerSeekGenRef.current}) — discarding stale commit`);
              return;
            }

            if (keyframeTimestamp !== null) {
              const tsOffset = keyframeTimestamp;
              seekOffsetRef.current = tsOffset;
              await sbVideo.setTimestampOffset(tsOffset);
              if (sbAudio) await sbAudio.setTimestampOffset(tsOffset);

              const buffer = seekBufferRef.current;
              seekBufferRef.current = [];
              for (const item of buffer) {
                if (item.type === 'init') {
                  if (item.trackType === 'audio' && sbAudio) {
                    sbAudio.appendBuffer(item.data);
                  } else {
                    sbVideo.appendBuffer(item.data);
                  }
                } else if (item.type === 'media') {
                  if (item.trackType === 'audio' && sbAudio) {
                    sbAudio.appendBuffer(item.data);
                  } else {
                    sbVideo.appendBuffer(item.data);
                  }
                  const absoluteTimestamp = item.timestamp! + seekOffsetRef.current;
                  if (absoluteTimestamp > 0 && state.current.duration > 0 && state.current.fileLength > 0) {
                    // prefetchedBytes drives the download %; a coarse linear
                    // estimate is fine for a percentage. The GREEN BAR position is
                    // set from the SourceBuffer's real .buffered ranges after the
                    // queue drains (below) — ground-truth VBR times, not this
                    // estimate that mislocated the bar for VBR MKV.
                    setPrefetchedBytes(Math.floor((absoluteTimestamp / state.current.duration) * state.current.fileLength));
                  }
                }
              }

              console.log(`[MSE] Transmuxer seek complete: keyframe=${keyframeTimestamp.toFixed(2)}s, flushed ${buffer.length} buffered segments`);

              // Record a REAL VBR calibration anchor: the cluster byte the seek's
              // forward iteration reads from, paired with its resolved keyframe
              // time. Ground-truth beats the linear time/duration estimate (way
              // off for VBR MKV). The anchor is monotonicity-guarded (see
              // recordByteTimeAnchor) so a stray byte can't distort the bar.
              const seekAnchor = (transmuxerRef.current as any)?.getLastSeekAnchor?.() ?? null;
              if (seekAnchor) recordByteTimeAnchor(seekAnchor.byteOffset, seekAnchor.time);

              await sbVideo.waitForQueueDrain();
              if (sbAudio) await sbAudio.waitForQueueDrain();

              // Green bar (VBR-accurate): set it from the SourceBuffer's REAL
              // .buffered ranges — the actual decoded time spans — instead of the
              // linear byte→time estimate that mislocated the bar for VBR MKV.
              try {
                const b = sbVideo.buffered;
                const realRanges: [number, number][] = [];
                for (let i = 0; i < b.length; i++) realRanges.push([b.start(i), b.end(i)]);
                if (realRanges.length > 0) {
                  downloadedTimeRangesRef.current = realRanges;
                  setDownloadedTimeRanges(realRanges);
                }
              } catch { /* buffered may throw if SB detached mid-seek — ignore */ }

              // Land playback on the REQUESTED target, not the keyframe. The seek
              // snaps to the cue keyframe at/below the target (3-9s earlier for
              // sparse VBR keyframes); setting currentTime to the keyframe caused
              // the trace-24 undershoot ("seek to 875s starts at 872s"). The seek
              // buffered [keyframe, target + SEEK_START_DURATION], so the target
              // sits inside the decoded range — the decoder decode-and-discards
              // from the keyframe up to it. computeSeekLandingTime clamps to the
              // buffered end so we never seek into an unbuffered hole.
              const bufferedEnd = (() => {
                try {
                  const b = sbVideo.buffered;
                  for (let i = 0; i < b.length; i++) {
                    if (b.start(i) <= keyframeTimestamp + 0.001 && b.end(i) >= keyframeTimestamp) return b.end(i);
                  }
                  return b.length > 0 ? b.end(b.length - 1) : keyframeTimestamp;
                } catch { return keyframeTimestamp; }
              })();
              video.currentTime = computeSeekLandingTime(clampedTime, keyframeTimestamp, bufferedEnd);

              // PROBE (seek-to-play): the 'seeked' event fires once the browser
              // has decoded the target position and playback can resume — the true
              // end of the click→first-frame window. One-shot listener logs the
              // delta from executeTransmuxerSeek entry, capturing reset +
              // getKeyPacket + transmux + append + decode (not just transmux 'total=').
              if (seekToPlayStartRef.current > 0) {
                const startedAt = seekToPlayStartRef.current;
                const tgt = seekToPlayTargetRef.current;
                seekToPlayStartRef.current = 0;
                const onSeeked = () => {
                  video.removeEventListener('seeked', onSeeked);
                  console.log(`[MSE] SEEK-TO-PLAY: ${(performance.now() - startedAt).toFixed(0)}ms (click→first frame) for target ${tgt.toFixed(1)}s`);
                };
                video.addEventListener('seeked', onSeeked, { once: true });
              }

              // Start streaming chain for continuous playback after limited seek
              startStreamingChain();

              // Reposition the MKV disk warmer to the seek target so the green
              // bar warms forward from HERE, not from the pre-seek position.
              // Bumping the generation inside startMkvDiskWarmer supersedes the
              // previous warmer (fixes "previous prebuffer not paused → multiple
              // positioned prebuffers running at once"). Prefer the real VBR
              // cluster byte for the resolved keyframe; fall back to linear.
              if (streamUrl && state.current.fileLength > 0 && state.current.duration > 0) {
                const realByte = (transmuxerRef.current as any)?.getByteOffsetForTime?.(keyframeTimestamp) ?? -1;
                const warmFrom = realByte >= 0
                  ? realByte
                  : Math.floor((keyframeTimestamp / state.current.duration) * state.current.fileLength);
                startMkvDiskWarmer(streamUrl, warmFrom);
              }
              transmuxerSeekInProgressRef.current = false; // Seek complete — allow new seeks

              // Update keyframeIndexReady if the transmuxer's partial index became available
              // during this seek (incremental timestamps). This triggers the thumbnail pipeline.
              if (!keyframeIndexReady && transmuxerRef.current?.isKeyframeIndexReady()) {
                setKeyframeIndexReady(true);
              }
            } else {
              // Seek failed — discard buffered segments
              seekBufferRef.current = [];
              transmuxerSeekInProgressRef.current = false; // Seek failed — allow new seeks
            }
          }).catch((e: Error) => {
            bufferingForSeekRef.current = false;
            seekBufferRef.current = [];
            transmuxerSeekInProgressRef.current = false; // Seek failed — allow new seeks
            console.error('[MSE] Transmuxer seek failed:', e);
            setError(`Seek failed: ${e.message}`);
          });
        } else {
          transmuxerSeekInProgressRef.current = true;
          transmuxerRef.current?.seekTo(clampedTime, INITIAL_SEEK_DURATION).then((result) => {
            transmuxerSeekInProgressRef.current = false;
            return result;
          }).catch((e: Error) => {
            transmuxerSeekInProgressRef.current = false;
            console.error('[MSE] Transmuxer seek failed:', e);
            setError(`Seek failed: ${e.message}`);
          });
        }
      };

      // Dispatch decision (decideSeekDispatch, pure + tested): run now only when
      // idle AND (first seek OR debounce window elapsed). CRITICAL fix (trace 21):
      // while a transmuxer seek is IN FLIGHT we always defer — never start a
      // second concurrent seek, which previously spawned two source_id=playback
      // reads on the shared MKV Input, orphaned one, and froze playback ~32s.
      const decision = decideSeekDispatch(
        Date.now(),
        lastSeekTimeRef.current,
        debounceMs,
        transmuxerSeekInProgressRef.current,
        lastSeekTimeRef.current === 0,
      );
      if (decision === 'execute') {
        if (seekDebounceTimerRef.current !== null) {
          clearTimeout(seekDebounceTimerRef.current);
          seekDebounceTimerRef.current = null;
        }
        executeTransmuxerSeek();
      } else {
        // Defer. Two defer reasons — within the debounce window (rapid drag) OR a
        // seek is in flight. A self-rescheduling drain re-checks each fire and
        // fires the LATEST captured target once idle AND the window has elapsed.
        // Re-arm is bounded (belt-and-braces against a stuck in-flight flag never
        // clearing → we'd rather force the seek than hang silently forever).
        if (seekDebounceTimerRef.current !== null) {
          clearTimeout(seekDebounceTimerRef.current);
        }
        const SEEK_INFLIGHT_POLL_MS = 120;
        const MAX_REARM_ATTEMPTS = 250; // ~30s hard cap on waiting for in-flight
        let rearmAttempts = 0;

        // INTERRUPT-ON-SUPERSEDE: if a seek is ALREADY in flight when a newer
        // target arrives, don't passively wait for its full lifecycle to finish
        // (cold getKeyPacket search + the multi-second transmux iteration — up to
        // ~13s in trace-29 for a position the user already abandoned). Actively
        // interrupt it so it returns null within ~1 poll and the drain fires the
        // LATEST target near-immediately. We do NOT execute the pending target
        // here — we still poll until transmuxerSeekInProgressRef clears, so there
        // is never more than one seek running at a time (preserves the trace-21
        // no-concurrent-seek invariant). interruptSeek() sets seekAbortFlag (cuts
        // the iteration loop) AND aborts the in-flight fetch (cuts a getKeyPacket
        // network wait). The aborted seek's generation is discarded by its own
        // supersession guard; its .then() null-branch clears seekBufferRef and
        // transmuxerSeekInProgressRef, leaving a clean slate.
        //
        // GUARDED so it only fires for a genuine in-flight seek, never for a
        // pure debounce-window defer (rapid drag where the prior seek already
        // completed — busy=false — and we're just inside the 500ms window). One
        // interrupt is enough (seekAbortFlag stays set; a second abortInFlight is
        // a no-op), but the flag also lets a later poll interrupt a seek that is
        // still busy without spamming every 120ms.
        let interruptSent = false;
        const maybeInterrupt = () => {
          if (shouldInterruptInflightSeek(interruptSent, transmuxerSeekInProgressRef.current)) {
            interruptSent = true;
            // Bump the FRONTEND seek generation so the interrupted seek's
            // completion handler sees itself as superseded and bails at the
            // supersession guard (does NOT commit its abandoned position). This
            // is REQUIRED for the edge case where interruptSeek() stops the
            // iteration AFTER packets were already fetched/buffered: with nothing
            // in flight, abortInFlight() is a no-op and the packet loop exits
            // WITHOUT throwing, so seekTo returns a NON-NULL keyframeTimestamp
            // instead of null. Without this bump the guard (isSeekSuperseded)
            // would pass and the stale result would setTimestampOffset +
            // startStreamingChain on the position the user already left — a
            // visible glitch before the real target runs. The bump makes the
            // guard catch it every time, regardless of null-vs-non-null return.
            const supersededGen = ++transmuxerSeekGenRef.current;
            console.log(`[MSE] Superseding in-flight seek (gen→${supersededGen}) — interrupting so the latest target runs now`);
            transmuxerRef.current?.interruptSeek();
          }
        };
        maybeInterrupt(); // interrupt at entry if a seek is already running

        const scheduleDrain = () => {
          const sinceLast = Date.now() - lastSeekTimeRef.current;
          const busy = transmuxerSeekInProgressRef.current;
          const delay = busy ? SEEK_INFLIGHT_POLL_MS : Math.max(0, debounceMs - sinceLast);
          seekDebounceTimerRef.current = window.setTimeout(() => {
            seekDebounceTimerRef.current = null;
            // Defensive: if a seek is somehow still in flight, ensure it has been
            // interrupted (no-op once interruptSent). Cannot go false→true within
            // one drain — a seek only starts via executeTransmuxerSeek, which is
            // only reached on d==='execute' (which stops draining) — but this
            // keeps the interrupt correct even if that invariant ever changes.
            maybeInterrupt();
            const d = decideSeekDispatch(
              Date.now(),
              lastSeekTimeRef.current,
              debounceMs,
              transmuxerSeekInProgressRef.current,
              lastSeekTimeRef.current === 0,
            );
            if (d === 'execute') {
              executeTransmuxerSeek();
            } else if (++rearmAttempts <= MAX_REARM_ATTEMPTS) {
              scheduleDrain();
            } else {
              // In-flight flag stuck past the cap — force the seek rather than
              // leave the user's final target stranded (seekTo bumps generation,
              // so the stale in-flight seek bails and this one wins).
              console.warn(`[MSE] Seek drain re-arm cap hit (${MAX_REARM_ATTEMPTS}) — forcing seek`);
              executeTransmuxerSeek();
            }
          }, delay);
        };
        scheduleDrain();
      }
      return;
    }

    // Near-end FORWARD seek after completion — directly end the video.
    // Only force the replay overlay for FORWARD seeks near the end (user
    // holding right arrow to reach the end). BACKWARD seeks (user pressing
    // left arrow to re-watch content) must fall through to normal seek flow —
    // otherwise an infinite cycle occurs: guard→ended→seekBwd clears→backward
    // seek target still within threshold→guard→ended→cycle repeats forever.
    // A backward seek from duration lands at duration-5, which is STILL above
    // the threshold (duration-5.1), so the guard would catch it again.
    if (hasEverCompletedRef.current && clampedTime >= state.current.duration - 5.1) {
      if (videoRef.current) {
        if (videoRef.current.ended) return;
        const isForwardSeek = clampedTime > videoRef.current.currentTime;
        if (isForwardSeek) {
          // Clear any pending debounce timer — prevents a previously scheduled
          // executeSeek() from firing after the guard has already ended the video,
          // which would restart the download loop and undo the guard's work.
          if (seekDebounceTimerRef.current !== null) {
            clearTimeout(seekDebounceTimerRef.current);
            seekDebounceTimerRef.current = null;
          }
          console.log(`[MSE] Near-end FORWARD seek after completion: ${clampedTime.toFixed(1)}s — forcing video end`);
          // Must pause BEFORE changing currentTime — otherwise the browser may
          // fire 'play'/'playing' events from the seek, causing onPlay to fire
          // while videoEnded=true and the overlay logic gets confused.
          videoRef.current.pause();
          // Move currentTime to a buffered position near the end, NOT to the
          // global last buffered end (which could be far from duration after
          // backward seeks that evict near-end data). Find the buffered range
          // that actually overlaps with the near-end threshold. If no such
          // range exists, don't change currentTime at all — the replay overlay
          // covers the video regardless of what frame is displayed underneath.
          const sb = videoRef.current.buffered;
          const nearEndThreshold = state.current.duration - 5.1;
          let nearEndTime: number | null = null;
          for (let i = 0; i < sb.length; i++) {
            // Find a buffered range that extends past the near-end threshold
            if (sb.end(i) >= nearEndThreshold) {
              // Use the end of this range (slightly inward to avoid edge)
              nearEndTime = Math.min(sb.end(i) - 0.05, state.current.duration);
              break;
            }
          }
          if (nearEndTime !== null) {
            videoRef.current.currentTime = nearEndTime;
            console.log(`[MSE] Forward guard: moved currentTime to near-end buffered position ${nearEndTime.toFixed(1)}s`);
          } else {
            console.log(`[MSE] Forward guard: no buffered data near the end — leaving currentTime at ${videoRef.current.currentTime.toFixed(1)}s`);
          }
          videoRef.current.dispatchEvent(new Event('ended'));
          return;
        } else {
          // Backward seek near the end — allow normal seek flow. The SourceBuffer
          // likely has data from the previous download near the end. The user
          // wants to re-watch content, not see the replay overlay.
          console.log(`[MSE] Near-end BACKWARD seek after completion: ${clampedTime.toFixed(1)}s — allowing normal seek`);
          // Fall through to buffered check and executeSeek below
        }
      } else {
        // No videoRef — can't determine direction, force video end for safety
        return;
      }
    }

    // 1. Check if the target position is already buffered in the SourceBuffer
    if (videoRef.current && videoRef.current.buffered.length > 0) {
      for (let i = 0; i < videoRef.current.buffered.length; i++) {
        if (clampedTime >= videoRef.current.buffered.start(i) &&
            clampedTime <= videoRef.current.buffered.end(i)) {
          // Already buffered — just set currentTime, browser seeks within buffer
          // No debounce needed for buffered positions
          console.log(`[MSE] Seek buffered: ${clampedTime.toFixed(1)}s — instant, no download`);
          if (seekDebounceTimerRef.current !== null) {
            clearTimeout(seekDebounceTimerRef.current);
            seekDebounceTimerRef.current = null;
          }
          videoRef.current.currentTime = clampedTime;
          return;
        }
      }
    }

    // 2. Position is NOT buffered
    // Set video currentTime immediately for visual feedback (scrubber jumps)
    const isFirstSeek = lastSeekTimeRef.current === 0 || (Date.now() - lastSeekTimeRef.current) >= SEEK_DEBOUNCE_MS;
    console.log(`[MSE] Seek unbuffered: ${clampedTime.toFixed(1)}s — ${isFirstSeek ? 'instant (first)' : 'debounced'}`);
    if (videoRef.current) {
      videoRef.current.currentTime = clampedTime;
    }

    // Helper: actually execute the unbuffered seek
    const executeSeek = () => {
      const seekByte = Math.min(
        Math.floor((clampedTime / state.current.duration) * state.current.fileLength),
        state.current.fileLength - 1  // Clamp: clampedTime ≈ duration can produce seekByte ≈ fileLength
      );
      state.current.pendingSeek = seekByte;
      // Cold seek: assume the target is unwarmed (MISS) until a chunk proves
      // otherwise, so the PROACTIVE reporter yields to the player during the
      // seek bootstrap instead of trusting a stale pre-seek HIT.
      lastDownloadWasCacheHitRef.current = false;
      // Bug fix: reset currentOffset so the download loop can re-enter after
      // completion. When the video finishes, currentOffset >= fileLength,
      // which makes the while condition (currentOffset < fileLength) false,
      // preventing the loop from entering and processing pendingSeek.
      // Resetting to seekByte allows the loop to enter, where the pendingSeek
      // handler will set currentOffset to the correct mp4box sync offset.
      state.current.currentOffset = seekByte;
      chunksAfterSeek.current = 0;
      setIsComplete(false);
      isCompleteRef.current = false;
      lastSeekTimeRef.current = Date.now();

      // Abort the in-flight fetch so the download loop processes the pending seek
      abortRef.current?.abort();

      // Restart download loop if it was stopped at completion (not user-paused).
      // If prebuffer is paused, respect that — the seek just repositions the
      // offset so resumePrefetch() picks up from the right place later.
      if (!state.current.downloading && downloadLoopRef.current && !isPausedRef.current) {
        console.log('[MSE] Restarting download loop after seek (offset was at completion)');
        state.current.downloading = true;
        setIsPrefetching(true);
        downloadLoopRef.current(streamUrl);
      }

      // Reposition the backend PROACTIVE prebuffer to the seek target. Passing an
      // explicit byteOffset makes the backend detect the playhead jump and apply
      // its +40s-ahead offset (proactive_start_byte) so it warms disk AHEAD of
      // where the downloadLoop's fresh window lands — no double-download of the
      // ~30s the loop pulls at the seek point. Gated on !isPausedRef so a seek
      // never silently un-pauses a user-paused prebuffer ("paused means paused").
      if (!isPausedRef.current) {
        const fileId = file?.id;
        const folderId = activeFolderId; // null = "home" — backend accepts Option
        const fileSize = state.current.fileLength;
        const dur = state.current.duration || 0;
        if (fileId && fileSize > 0 && dur > 0) {
          proactivePrebufferMsgIdRef.current = fileId;
          invoke('cmd_report_playback_position', {
            messageId: fileId,
            folderId: folderId,
            currentTimeS: clampedTime,
            durationS: dur,
            fileSize: fileSize,
            isPlayerDownloading: true, // player is about to fetch its window at the seek point
            playbackRate: 1.0,
            byteOffset: seekByte,
          }).catch(() => {});
          // Ensure the periodic reporter is running so the window keeps sliding
          // to EOF after this seek (it may have been cleared on a prior pause).
          if (!proactiveIntervalRef.current) startMp4ProactiveReporterRef.current?.();
        }
      }
    };

    // First seek is instant; subsequent seeks within SEEK_DEBOUNCE_MS are debounced
    const timeSinceLastSeek = Date.now() - lastSeekTimeRef.current;
    if (timeSinceLastSeek >= SEEK_DEBOUNCE_MS || lastSeekTimeRef.current === 0) {
      // First seek or debounce window has expired — execute immediately
      if (seekDebounceTimerRef.current !== null) {
        clearTimeout(seekDebounceTimerRef.current);
        seekDebounceTimerRef.current = null;
      }
      executeSeek();
    } else {
      // Within debounce window — delay execution, only the last position in
      // this rapid-fire window will actually execute
      if (seekDebounceTimerRef.current !== null) {
        clearTimeout(seekDebounceTimerRef.current);
      }
      const remainingDebounce = SEEK_DEBOUNCE_MS - timeSinceLastSeek;
      seekDebounceTimerRef.current = window.setTimeout(() => {
        seekDebounceTimerRef.current = null;
        executeSeek();
      }, remainingDebounce);
    }
  }, [streamUrl, useNative]);

  const pausePrefetch = () => {
    state.current.downloading = false;
    isPausedRef.current = true;
    loopGeneration.current++;
    abortRef.current?.abort();
    // Clear any pending seek debounce timer on pause
    if (seekDebounceTimerRef.current !== null) {
      clearTimeout(seekDebounceTimerRef.current);
      seekDebounceTimerRef.current = null;
    }
    // TS files: "pause" = stop ALL Telegram downloads. This means BOTH:
    //   (1) mpegts.js's own ChunkedFetchLoader (via IOController), AND
    //   (2) the Rust proactive prebuffer.
    // Stopping only the proactive prebuffer is USELESS: mpegts.js has its own
    // fetch pipeline (ChunkedFetchLoader → IOController → /stream/), and /stream/
    // falls back to Telegram on cache miss. So the loader keeps pulling from
    // Telegram independently of the Rust prebuffer. Must kill the IOController.
    // NEVER call ioctl.resume() on resume — it triggers _internalSeek → a new
    // /remux/ request from byte 0 → DTS catastrophe. Resume recreates the player
    // via _mpegtsUnbufferedSeek instead. (See video-streaming skill rev6-FINAL.)
    const player = mpegtsPlayerRef.current as any;
    if (player) {
      const ioctl = player._player_engine?._transmuxer?._controller?._ioctl;
      if (ioctl && !ioctl._paused) {
        try { ioctl.pause(); } catch (_) {}
      }
    }
    // Stop proactive prebuffer (Rust backend)
    const ppMsgId = proactivePrebufferMsgIdRef.current;
    if (ppMsgId) {
      invoke('cmd_stop_proactive_prebuffer', { messageId: ppMsgId }).catch(() => {});
    }
    if (proactiveIntervalRef.current) {
      clearInterval(proactiveIntervalRef.current);
      proactiveIntervalRef.current = null;
    }
    setIsPaused(true);
    setIsPrefetching(false);
  };

  const resumePrefetch = () => {
    isPausedRef.current = false;
    setIsPaused(false);
    setIsPrefetching(true);

    // TS files: pause killed the IOController (loader + HTTP connection) via
    // ioctl.pause(). To resume downloading we must RECREATE the player at the
    // current playhead using _mpegtsUnbufferedSeek — NEVER ioctl.resume(), which
    // triggers _internalSeek → a new /remux/ request from byte 0 → DTS overflow.
    // _mpegtsUnbufferedSeek destroys the paused player and creates a fresh one
    // starting from the correct byte offset. Playback of already-buffered data
    // (the in-memory SourceBuffer) is preserved — recreation seeks to
    // video.currentTime, so the user resumes exactly where they paused.
    const player = mpegtsPlayerRef.current as any;
    if (player) {
      const video = videoRef.current;
      const dur = mpegtsDurationRef.current || state.current.duration || 0;
      if (video && dur > 0) {
        // Recreate the player at the current position to restart the loader.
        // isPausedRef is already false (set above), so the align poll will NOT
        // re-pause the new IOController — downloading resumes normally.
        _mpegtsUnbufferedSeek(video.currentTime, dur);
      }
      // Restart proactive prebuffer reporting interval
      const _fileId = file?.id;
      const _folderId = activeFolderId; // null = "home" — backend accepts Option
      const _fileSize = state.current.fileLength;
      if (_fileId && _fileSize && !proactiveIntervalRef.current) {
        proactivePrebufferMsgIdRef.current = _fileId;
        const proactiveInterval = setInterval(async () => {
          const v = videoRef.current;
          if (!v || v.paused || v.ended) return;
          // Remux transient guard (see shouldSkipRemuxPositionReport): skip only the
          // recreation / pre-first-frame window; normal remux playback still reports.
          if (shouldSkipRemuxPositionReport(
                needsRemuxSeekRef.current, (window as any).__nobuf_userSeekInProgress === true, v.currentTime)) return;
          const eng = (mpegtsPlayerRef.current as any)?._player_engine;
          const ic = eng?._ioctl;
          const isDownloading = ic ? !ic._paused : false;
          try {
            await invoke('cmd_report_playback_position', {
              messageId: _fileId,
              folderId: _folderId,
              currentTimeS: v.currentTime,
              durationS: mpegtsDurationRef.current || v.duration || 0,
              fileSize: _fileSize,
              isPlayerDownloading: isDownloading,
              playbackRate: v.playbackRate || 1.0,
              byteOffset: null,
            });
          } catch { /* ignore */ }
        }, 10000);
        proactiveIntervalRef.current = proactiveInterval;
      }
      return; // TS path handled — don't run downloadLoop
    }

    // MP4/MKV/WebM: restart download loop
    if (!state.current.downloading && streamUrl && downloadLoopRef.current) {
      downloadLoopRef.current(streamUrl);
    }
    // MP4: restart the backend PROACTIVE reporter so the green bar resumes its
    // march to EOF. pausePrefetch stopped the backend task and cleared the
    // interval; the reporter's first tick re-triggers cmd_report_playback_position.
    // No-op for MKV/WebM (proactiveIntervalRef stays null unless MP4 set it).
    if (state.current.mp4box && !proactiveIntervalRef.current) {
      startMp4ProactiveReporterRef.current?.();
    }
  };

  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    // Bug #4 fix: when the video element encounters a fatal decoder error
    // (CHUNK_DEMUXER_ERROR_APPEND_FAILED), fall back to native playback.

    // data can be appended to the SourceBuffer, so MSE is irrecoverable.
    //
    // IMPORTANT: During transmuxer initialization, the video element fires
    // error code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) because the blob URL has
    // no data yet. This is expected — NOT fatal. Don't trigger fallback
    // during init, because setting useNative=true changes v.src which
    // closes the MediaSource before addSourceBuffer completes.
    if (el) {
      el.addEventListener('error', () => {
        const err = el.error;
        if (err && (err.code === MediaError.MEDIA_ERR_DECODE ||
                    err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)) {
          if (transmuxerInitInProgressRef.current) {
            console.warn('[MSE] Video error (code', err.code, ') during transmuxer init — ignoring (expected, blob URL has no data yet)');
            return;
          }
          if (!cancelledRef.current && !useNative) {
            // Fall back to native for MP4/MSE errors AND mpegts.js fatal errors.
            // For mpegts.js, the FATAL handler in the ERROR event already destroyed
            // the player and set mpegtsPlayerRef.current = null. Falling back to
            // native playback uses the /remux/ endpoint to convert TS→MP4 server-side.
            if (mpegtsPlayerRef.current) {
              // mpegts.js player still active — the FATAL handler hasn't run yet.
              // This is a non-fatal error during mpegts.js playback (e.g., quota).
              // Let mpegts.js handle it internally (suspend/resume).
            } else {
              console.warn('[MSE] Fatal video error (code', err.code, ') — falling back to native playback');
              setUseNative(true);
            }
          }
        }
      });
    }
    videoRef.current = el;
  }, []);

  // Stable getter callbacks for MSE thumbnail mini-pipeline.
  // These read from refs so their values change without re-creating the function,
  // which prevents downstream useMemo/useEffect from re-triggering every render.
  const getMoovBufferCb = useCallback(() => moovBufferRef.current, []);
  const getFirstChunkCb = useCallback(() => firstChunkRef.current, []);
  const getInitSegmentsCb = useCallback(() => initSegmentsRef.current, []);
  const getVideoTrackInfoCb = useCallback(() => videoTrackInfoRef.current, []);
  const getMP4BoxClassCb = useCallback(() => mp4BoxClassRef.current, []);
  const getFileLengthCb = useCallback(() => state.current.fileLength, []);
  const isTransmuxerCb = useCallback(() => !!transmuxerRef.current, []);
  const getFormatCb = useCallback(() => formatRef.current, []);
  const isFmp4StreamCb = useCallback(() => fmp4PipelineActiveRef.current, []);
  const getFmp4ConfigCb = useCallback(() => fmp4ConfigRef.current, []);
  const getRemuxThumbConfigCb = useCallback(() => remuxThumbConfigRef.current, []);

  // Fetch the backend's TS keyframe index so resume/seek/trim use authoritative
  // byte-time positions instead of noisy frontend samples.
  // Fast-retry at 2s until the backend returns a complete (non-partial) index,
  // then back off to 15s. The backend returns empty/partial at cold start
  // because the data file isn't ready yet. With 10s retry, the table stayed
  // at the linear 2-point baseline for the entire session → green bar was
  // a "random fill" for VBR video.
  useEffect(() => {
    if (!streamUrl) return;
    tsKeyframeIndexRef.current = [];
    byteTimeSamplesRef.current = [];
    // Skip the TS keyframe poll for MKV: mediabunny already parses the MKV Cues
    // into a 419-point VBR byte↔time index (seeded into byteToTimeTableRef at
    // transmuxer init), so this endpoint has nothing to offer — for MKV the
    // backend only ever answers "not a TS stream" after 2-3 dead round-trips
    // (`Data file not ready` → `not a TS stream`). Gate on the resolved format;
    // 'unknown' (pre-detection) and TS/MP4 still poll as before.
    if (detectedFormat === 'mkv') return;
    let timer: number;
    let cancelled = false;
    const tick = async () => {
          const complete = await refreshTsKeyframeIndex();
          if (cancelled) return;
          // Stop polling once the index is complete.
          // For TS files: complete means full keyframe index is built.
          // For non-TS files (MP4/MKV): complete means backend confirmed it's not TS.
          // In both cases, no further polling is needed.
          if (complete) return;
          // Only retry if incomplete (data file not ready yet)
          timer = window.setTimeout(tick, 2000);
        };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [streamUrl, detectedFormat, refreshTsKeyframeIndex]);

  // Cold-start overlay progress poller: keep the overlay visible until the first
  // aligned chunk is fully in the shadow cache, or until a timeout fires.
  // Resolves coldStartDeferredRef when the gate is satisfied; playback is started
  // by initTransmuxerPlayer after awaiting the same promise.
  useEffect(() => {
    if (!isColdStartBuffering) return;
    if (coldStartPhase === 'none') return;

    // For buffering phase: poll shadow cache progress
    if (coldStartPhase === 'buffering') {
      const startTime = Date.now();
      const target = minColdStartBytes;
      const interval = setInterval(() => {
        const cache = shadowCacheRef.current;
        const run = cache?.cachedRunFrom(0);
        const bytes = run ? Math.min(run.end + 1, target) : 0;
        setColdStartProgress({ bytes, targetBytes: target });
        const ready = bytes >= target || Date.now() - startTime >= COLD_START_TIMEOUT_MS;
        if (ready) {
          coldStartDeferredRef.current?.resolve();
        }
      }, 250);
      return () => clearInterval(interval);
    }

    // For initializing_player / fetching_metadata: safety timeout only.
    // MEDIA_INFO or onMP4BoxReady resolves the deferred normally;
    // this is a fallback if those never fire (e.g. remux ffmpeg errors).
    const INIT_OVERLAY_TIMEOUT_MS = 45000;
    const timer = setTimeout(() => {
      diagLog(`[MSE] Cold-start overlay safety timeout (${INIT_OVERLAY_TIMEOUT_MS / 1000}s) for phase=${coldStartPhase} — dismissing`);
      coldStartDeferredRef.current?.resolve();
      coldStartDeferredRef.current = null;
      setIsColdStartBuffering(false);
      setColdStartPhase('none');
    }, INIT_OVERLAY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isColdStartBuffering, coldStartPhase, minColdStartBytes]);

  // Reset cold-start overlay state when the stream changes or hook unmounts.
  useEffect(() => {
    return () => {
      coldStartDeferredRef.current?.resolve();
      coldStartDeferredRef.current = null;
      setIsColdStartBuffering(false);
      setColdStartPhase('none');
      setColdStartProgress({ bytes: 0, targetBytes: 0 });
    };
  }, [streamUrl]);

  return {
    mseUrl: (useNative || !!mpegtsPlayerRef.current) ? null : mseUrl,
    remuxUrl: remuxUrlRef.current,
    error: useNative ? null : error,
    useNative,

    unsupportedCodec,
    prefetchedBytes,
    totalBytes,
    isPrefetching,
    isPaused,
    isComplete,
    pausePrefetch,
    resumePrefetch,
    seekTo,
    suppressLoadingSpinnerRef,
    setVideoRef,
    downloadedTimeRanges,
    byteToTime,
    recordByteTimeAnchor,
    getMp4Box: () => state.current.mp4box,
    getFileLength: getFileLengthCb,
    getMoovBuffer: getMoovBufferCb,
    getFirstChunk: getFirstChunkCb,
    getInitSegments: getInitSegmentsCb,
    getVideoTrackInfo: getVideoTrackInfoCb,
    getMP4BoxClass: getMP4BoxClassCb,
    isTransmuxer: isTransmuxerCb,
    getFormat: getFormatCb,
    getKnownDuration: () => mpegtsDurationRef.current || state.current.duration || 0,
    isTransmuxerActive,
    getKeyframeTimestamps: () => {
      if (mpegtsPlayerRef.current && tsKeyframeIndexRef.current.length > 0) {
        return tsKeyframeIndexRef.current.map(kf => kf.timestamp);
      }
      return transmuxerRef.current?.getKeyframeTimestamps() ?? [];
    },
    getKeyframeByteOffsets: () => {
      if (mpegtsPlayerRef.current && tsKeyframeIndexRef.current.length > 0) {
        return tsKeyframeIndexRef.current;
      }
      return transmuxerRef.current?.getKeyframeByteOffsets() ?? [];
    },
    getTsHeaderData: () => transmuxerRef.current?.getTsHeaderData() ?? null,
    getTransmuxerSourceConfig: () => transmuxerRef.current?.getSourceConfig() ?? null,
    isFmp4Stream: isFmp4StreamCb,
    getFmp4Config: getFmp4ConfigCb,
    getRemuxThumbConfig: getRemuxThumbConfigCb,
    isColdStartBuffering,
    coldStartProgress,
    coldStartPhase,
    detectedFormat,
    keyframeIndexReady,
    thumbnailDataReady,
    moovBufferReady,
    getShadowCache: () => shadowCacheRef.current,
    mpegtsDuration: mpegtsDurationRef.current,
  };
}

async function loadMP4Box(): Promise<any> {
  if (typeof (window as any).MP4Box !== 'undefined') {
    return (window as any).MP4Box;
  }

  try {
    const mod = await import('mp4box');
    return mod.default || mod;
  } catch (e) {
    console.error('[MSE] Failed to import mp4box:', e);
    throw new Error('mp4box not available');
  }
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)}MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
