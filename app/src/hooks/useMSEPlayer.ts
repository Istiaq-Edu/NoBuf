import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TelegramFile } from '../types';
import { SourceBufferWrapper } from '../lib/faststream/players/SourceBufferWrapper';
import { detectFormat, type DetectedFormat } from '../lib/faststream/utils/FormatDetector';
import { MediabunnyTransmuxer } from '../lib/faststream/players/MediabunnyTransmuxer';
import { MuxJsTsTransmuxer } from '../lib/faststream/players/MuxJsTsTransmuxer';

// Diagnostic logging helper — routes to both console and Rust backend terminal.
// Critical for debugging MSE/transmuxer issues where browser console isn't visible.
function diagLog(msg: string) {
  console.log(msg);
  invoke('cmd_log', { message: msg }).catch(() => {});
}
import { type TSKeyframeEntry } from '../lib/faststream/utils/TSByteOffsetScanner';
import { StreamShadowCache, installStreamCacheInterceptor, uninstallStreamCacheInterceptor } from '../lib/faststream/StreamShadowCache';

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
  samples?: ByteTimeSample[]
): number {
  if (bufEnd <= 0 || duration <= 0 || fileLength <= 0) return -1;

  // Step 1: Convert bufferEnd time → approximate byte position.
  // Use VBR samples when available; otherwise fall back to global linear bitrate.
  let byte = (samples && samples.length >= 2)
    ? findByteForTime(bufEnd, samples, duration, fileLength)
    : Math.floor((bufEnd / duration) * fileLength);

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
  if (targetTime <= 0) return 0;
  if (!Array.isArray(samples) || samples.length < 2) {
    if (fallbackDuration > 0 && fallbackFileLength > 0) {
      return Math.floor((targetTime / fallbackDuration) * fallbackFileLength);
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
      return Math.floor((targetTime / fallbackDuration) * fallbackFileLength);
    }
    return -1;
  }
  const localBitrate = upper.time > lower.time
    ? (upper.byte - lower.byte) / (upper.time - lower.time)
    : 0;
  if (targetTime <= lower.time) {
    return Math.max(0, lower.byte + Math.floor((targetTime - lower.time) * (localBitrate || 0)));
  }
  if (targetTime >= upper.time) {
    return Math.max(0, upper.byte + Math.floor((targetTime - upper.time) * (localBitrate || 0)));
  }
  const tDiff = upper.time - lower.time;
  if (tDiff <= 0) return lower.byte;
  const ratio = (targetTime - lower.time) / tDiff;
  return Math.floor(lower.byte + ratio * (upper.byte - lower.byte));
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
const TS_INITIAL_PREFETCH = 20 * 1024 * 1024; // 20MB
const MAX_BUFFER_BYTES = 20 * 1024 * 1024; // 20MB max buffer before eviction
const BUFFER_KEEP_BEHIND = 30; // Keep 30s behind current playback position
const MAX_BUFFER_AHEAD_SECONDS = 30; // Backpressure — stop downloading when >30s buffered ahead
const PREBUFFER_CAP_BYTES = 250 * 1024 * 1024; // 250MB cap for independent prebuffer downloads (shadow cache is 300MB, no point exceeding)

// Cold-start overlay thresholds: show the overlay only when the shadow cache is empty
// and wait until this much contiguous data is in memory before attaching the player.
const MIN_COLD_START_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB
const MIN_COLD_START_BUFFER_SECONDS = 10;            // fallback: 10 s of playback
const COLD_START_TIMEOUT_MS = 10000;                   // never wait longer than 10 s

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

export function useMSEPlayer(streamUrl: string | null, file: TelegramFile | null, activeFolderId: number | null) {
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
  // Cold-start overlay state: true only when the shadow cache is empty and we are
  // waiting for the backend to fill enough in-memory buffer for smooth playback.
  const [isColdStartBuffering, setIsColdStartBuffering] = useState(false);
  const [coldStartProgress, setColdStartProgress] = useState<{ bytes: number; targetBytes: number }>({
    bytes: 0,
    targetBytes: MIN_COLD_START_BUFFER_BYTES,
  });
  const isCompleteRef = useRef(false);
  // Once the download loop reaches fileLength, the backend has all data cached.
  // This ref never resets — even if a backward seek resets isComplete=false,
  // the near-end guard still works because hasEverCompleted stays true.
  const hasEverCompletedRef = useRef(false);
  const [speed, setSpeed] = useState(0);
  // Downloaded byte-range → time-range for green buffer bar
  const [downloadedTimeRanges, setDownloadedTimeRanges] = useState<[number, number][]>([]);

  const downloadLoopRef = useRef<((url: string) => void) | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loopGeneration = useRef(0); // Prevents stale loops from running after seek
  const chunksAfterSeek = useRef(0); // For progressive chunk sizing
  const pendingRangesRef = useRef<[number, number][]>([]); // Accumulated ranges to report
  const rangeReportTimer = useRef<number | null>(null); // Debounce timer for range reporting
  // Seek debouncing: for unbuffered positions, delay seek execution by SEEK_DEBOUNCE_MS
  // so rapid clicks/arrow-key skips only trigger the LAST position, reducing wasteful
  // overlapping downloads on unbuffered parts
  const seekDebounceTimerRef = useRef<number | null>(null);
  const mpegtsUnbufferedSeekGenerationRef = useRef<number>(0);
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
  // Downloaded byte ranges — merged and converted to time for green buffer bar
  const downloadedRangesRef = useRef<[number, number][]>([]);
  // Transmuxer for TS/MKV format playback (null when not active)
  const transmuxerInitInProgressRef = useRef(false);
  const transmuxerRef = useRef<MediabunnyTransmuxer | MuxJsTsTransmuxer | null>(null);
  const mpegtsPlayerRef = useRef<any>(null); // mpegts.js player instance for TS files
  const shadowCacheRef = useRef<StreamShadowCache | null>(null); // JS-side byte cache for instant seeks
  const byteTimeSamplesRef = useRef<Array<ByteTimeSample>>([]); // accurate byte-to-time samples for VBR resume
  const fallbackBehindRef = useRef(60); // current effective behind window in seconds

  // Helper to record byte-to-time samples for accurate VBR resume.
  // Note: only (time, byte) is stored; pacing uses the global average bitrate
  // because the IOController download byte can run far ahead of the actual
  // SourceBuffer end, which would yield an inflated local bitrate.
  const recordByteTimeSample = useCallback((time: number, byte: number) => {
    if (time <= 0 || byte <= 0) return;
    const samples = byteTimeSamplesRef.current;
    // avoid duplicate samples for the same time
    if (samples.length > 0) {
      const last = samples[samples.length - 1];
      if (last.time === time && last.byte === byte) return;
      // only add if time or byte changed meaningfully
      if (Math.abs(last.time - time) < 0.5 && Math.abs(last.byte - byte) < 188 * 100) return;
    }
    samples.push({ time, byte });
    // keep last 120 samples (~2min of history)
    if (samples.length > 120) samples.splice(0, samples.length - 120);
  }, []);

  const suppressLoadingSpinnerRef = useRef(false); // suppress spinner for cache-hit seeks
  const quotaGuardIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null); // 100ms quota guard
  const mpegtsSpeedHistoryRef = useRef<{ time: number; byte: number }[]>([]); // download speed tracking for TS
  const mpegtsFailedRef = useRef(false);     // Set true if mpegts.js fails, skip retry
  const mpegtsDurationRef = useRef<number>(0); // Duration from metadata for mpegts.js
  const proactivePrebufferMsgIdRef = useRef<number>(0); // msg_id being proactively prebuffered
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

  const speedHistory = useRef<{ bytes: number; time: number }[]>([]);
  const lastThrottleRef = useRef(0); // For throttling state updates
  const prevUrlRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  // When true, suppress reports to backend cache (used during active download)
  const suppressBackendReportsRef = useRef(false);
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

  // Ref to track whether the TS→fMP4 backend pipeline is active (not mux.js transmuxer)
  const fmp4PipelineActiveRef = useRef(false);
  // Remux URL for TS files — when set, native <video> uses this instead of raw /stream/
  const remuxUrlRef = useRef<string | null>(null);
  // Ref to store fMP4 config for thumbnail pipeline — set during initTsFmp4Pipeline
  const fmp4ConfigRef = useRef<{
    baseUrl: string; // e.g. "http://host/fmp4"
    folderId: string;
    messageId: string;
    queryParams: string; // e.g. "token=abc"
    mimeType: string; // e.g. 'video/mp4; codecs="avc1.64001f,mp4a.40.2"'
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

  // Debounced range reporter — accumulates fetched byte ranges and
  // reports them to the Rust backend every 2 seconds (or on completion)
  const reportRangesToBackend = useCallback((start: number, end: number) => {
    if (!file || activeFolderId === null) return;
    if (suppressBackendReportsRef.current) return; // Suppress during active download
    pendingRangesRef.current.push([start, end]);

    // Debounce: send accumulated ranges every 2s
    if (rangeReportTimer.current === null) {
      rangeReportTimer.current = window.setTimeout(() => {
        const ranges = [...pendingRangesRef.current];
        pendingRangesRef.current = [];
        rangeReportTimer.current = null;

        if (ranges.length > 0 && state.current.fileLength > 0) {
          invoke('cmd_report_cached_ranges', {
            messageId: file.id,
            folderId: activeFolderId,
            totalSize: state.current.fileLength,
            filename: file.name,
            mimeType: 'video/mp4',
            ranges,
          }).catch(() => {});
        }
      }, 2000);
    }
  }, [file, activeFolderId]);

  // Flush remaining ranges on unmount or completion
  const flushRangeReport = useCallback(() => {
    if (rangeReportTimer.current !== null) {
      window.clearTimeout(rangeReportTimer.current);
      rangeReportTimer.current = null;
    }
    const ranges = [...pendingRangesRef.current];
    pendingRangesRef.current = [];

    if (ranges.length > 0 && file && activeFolderId !== null && state.current.fileLength > 0) {
      invoke('cmd_report_cached_ranges', {
        messageId: file.id,
        folderId: activeFolderId,
        totalSize: state.current.fileLength,
        filename: file.name,
        mimeType: 'video/mp4',
        ranges,
      }).catch(() => {});
    }
  }, [file, activeFolderId]);

  // Ref for flushRangeReport — prevents MSE effect from re-running when
  // file/activeFolderId change identity (which changes flushRangeReport's
  // useCallback identity). The MSE player must NOT restart mid-playback just
  // because the range report callback got a new reference. Using a ref ensures
  // cleanup always calls the latest function without triggering a re-init.
  const flushRangeReportRef = useRef(flushRangeReport);
  flushRangeReportRef.current = flushRangeReport;

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
    setDownloadedTimeRanges(timeRanges);
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
    setDownloadedTimeRanges([]);
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
    setUseNative(false);
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
    speedHistory.current = [];
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
    setSpeed(0);
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
        if (cancelledRef.current) return;
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
      const MSE_INIT_MAX_TIMEOUT_MS = 60000;
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
      // Flush remaining range reports before cleanup
      flushRangeReportRef.current();
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
      // ── Shadow cache interceptor ──
      uninstallStreamCacheInterceptor();
      shadowCacheRef.current = null;
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
      setIsTransmuxerActive(false);
      clearDownloadedRanges();
      seekOffsetRef.current = 0;
      bufferingForSeekRef.current = false;
      seekBufferRef.current = [];
      // ── Clear persistent window flags ──
      // These survive React unmount/remount and can block future evictions
      // or resume paths if left stale from a previous component lifecycle.
      (window as any).__nobuf_quotaGuardAggressive = false;
      (window as any).__nobuf_bufferFullDetected = false;
      (window as any).__nobuf_removeInProgress = false;
      (window as any).__nobuf_evictionResumePending = false;
      (window as any).__nobuf_evictionResumeByte = 0;
      (window as any).__nobuf_nuclearRecoveryInProgress = false;
      (window as any).__nobuf_userSeekInProgress = false;
      // Stop proactive disk prebuffer for this file
      const _ppMsgId = proactivePrebufferMsgIdRef.current;
      if (_ppMsgId) {
        invoke('cmd_stop_proactive_prebuffer', { messageId: _ppMsgId }).catch(() => {});
        proactivePrebufferMsgIdRef.current = 0;
      }
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
      uninstallStreamCacheInterceptor();
      shadowCacheRef.current = null;
    }
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
    setIsTransmuxerActive(false);
    clearDownloadedRanges();
    // ── Clear persistent window flags ──
    // These survive React unmount/remount and can block future evictions
    // or resume paths if left stale from a previous component lifecycle.
    (window as any).__nobuf_quotaGuardAggressive = false;
    (window as any).__nobuf_bufferFullDetected = false;
    (window as any).__nobuf_removeInProgress = false;
    (window as any).__nobuf_evictionResumePending = false;
    (window as any).__nobuf_evictionResumeByte = 0;
    (window as any).__nobuf_nuclearRecoveryInProgress = false;
    (window as any).__nobuf_userSeekInProgress = false;
    // Stop proactive disk prebuffer
    const _ppMsgId2 = proactivePrebufferMsgIdRef.current;
    if (_ppMsgId2) {
      invoke('cmd_stop_proactive_prebuffer', { messageId: _ppMsgId2 }).catch(() => {});
      proactivePrebufferMsgIdRef.current = 0;
    }
  };

  /** Calculate how many seconds of video are buffered ahead of current playback.
   *  Used for backpressure — stop downloading when enough data is buffered ahead. */
  const getBufferedAheadSeconds = (): number => {
    const video = videoRef.current;
    if (!video) return 0;
    const buffered = video.buffered;
    const currentTime = video.currentTime;
    let totalAhead = 0;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.end(i) > currentTime) {
        const start = Math.max(buffered.start(i), currentTime);
        totalAhead += buffered.end(i) - start;
      }
    }
    return totalAhead;
  };

  /** Refill mechanism for transmuxer playback.
   *  After a limited seek, continuously stream data until buffer is sufficient.
   *  The streaming chain triggers the first refill immediately after the initial
   *  seek completes (no timer delay), then chains subsequent refills as needed
   *  until buffer ahead >= REFILL_THRESHOLD_SECONDS. */
  // immediately after the initial seek (no timer delay), then chains
  // subsequent refills as needed until buffer ahead >= threshold.
  const REFILL_THRESHOLD_SECONDS = 15;
  // Smaller chunks (5s) produce faster refills: iteration covers less cold
  // data, and overlap filter skips less cached data. With minimumFragmentDuration=0.5,
  // each 5s chunk produces ~10 segments for smooth MSE streaming.
  const REFILL_CHUNK_DURATION = 5;
  // Initial user seek produces enough data for smooth playback start.
  // 10s provides sufficient runway for the first cold refill (which takes
  // 5-7s downloading new clusters), preventing playback stalls. The extra
  // iteration time (~2ms cached, ~1-2s cold) is negligible compared to
  // getKeyPacket time (5-12s). Also enables reaching 15s threshold in
  // just 1 refill cycle for cached scenarios (overlap filter skips fewer
  // segments relative to the larger initial buffer).
  const INITIAL_SEEK_DURATION = 15;
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
      const refillPosition = video.currentTime + ahead;

      // maxDuration covers from keyframeTimestamp to (refillPosition + REFILL_CHUNK_DURATION).
      // Since the keyframe can be up to ~12s before refillPosition (keyframe interval),
      // we add 12 as a conservative estimate. Capped at REFILL_MAX_DURATION_CAP.
      const maxDuration = Math.min(REFILL_CHUNK_DURATION + 12, REFILL_MAX_DURATION_CAP);

      // Always skip init segment for refills — SourceBuffer already has it from
      // the initial seek. Producing a new init segment is wasteful and causes
      // MSE codec re-initialization overhead.
      const skipInit = true;

      // Enable buffering mode for the refill seek
      bufferingForSeekRef.current = true;
      seekBufferRef.current = [];

      // seekTo creates a fresh Input with the persistent TauriStreamSource,
      // guaranteeing a clean demuxer state that can iterate from any position.
      const keyframeTimestamp = await transmuxer.seekTo(refillPosition, maxDuration, { skipInitSegment: skipInit });

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
        // Hard cap on buffer ahead: skip refills entirely when > 30s ahead.
        // Prevents buffer from growing excessively (e.g., 62.9s ahead for TS)
        // which wastes bandwidth, risks QuotaExceededError, and slows seeks
        // because more data needs to be evicted.
        const MAX_BUFFER_AHEAD = 30;
        if (ahead >= MAX_BUFFER_AHEAD) {
          console.log(`[MSE] Buffer ahead ${ahead.toFixed(1)}s exceeds hard cap ${MAX_BUFFER_AHEAD}s — sleeping 2000ms before re-check`);
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
    if (totalBuffered * state.current.bitrate < MAX_BUFFER_BYTES) return;

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
      diagLog(`[MSE] detectFormat result: ${format}`);

      if (format === 'unknown') {
        diagLog('[MSE] Unknown format — falling back to native playback');
        setUseNative(true);
        return;
      }

      if (format === 'mkv' || format === 'webm') {
        if (data.byteLength < TS_INITIAL_PREFETCH && state.current.fileLength > TS_INITIAL_PREFETCH) {
          diagLog(`[MSE] ${format}: fetching additional prefetch data (${data.byteLength} → ${TS_INITIAL_PREFETCH} bytes)`);
          try {
            const extraResponse = await fetch(url, {
              headers: { Range: `bytes=${data.byteLength}-${TS_INITIAL_PREFETCH - 1}` },
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
        diagLog(`[MSE] Detected ${format} format — waiting for cold-start buffer before initializing mpegts.js player, fileLength=${state.current.fileLength}`);
        await waitForColdStartBuffer(format, url);
        await initTransmuxerPlayer(url, mediaSource, blobUrl!, format);
        return;
      }

      if (format === 'mkv' || format === 'webm') {
        diagLog(`[MSE] ${format} — falling back to native playback`);
        setUseNative(true);
        return;
      }

      // MP4 format — proceed with MP4Box.js
      console.log('[MSE] Detected MP4 format — proceeding with MP4Box.js');

      // Report initial chunk range to cache backend (even if we don't feed to mp4box yet)
      reportRangesToBackend(0, firstChunkSize - 1);

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
    const streamUrl = `${parsed.baseUrl}/stream/${parsed.folderId}/${parsed.messageId}?token=${encodeURIComponent(parsed.token)}`;

    // ── SPAWN PROACTIVE PREBUFFER IMMEDIATELY ──
    // Start downloading to disk cache BEFORE anything else — before fetching
    // /fmp4/metadata/, before creating the mpegts.js player. This eliminates
    // the chicken-and-egg deadlock where /stream polls disk cache but the
    // prebuffer hasn't started yet. By the time mpegts.js makes its first
    // Range request to /stream, data is already on disk or being downloaded.
    const knownFilesize = state.current.fileLength > 0 ? state.current.fileLength : undefined;
    const estimatedDurationS = knownFilesize ? (knownFilesize / 4_000_000) * 8 : 0;
    if (knownFilesize && parseInt(parsed.messageId) > 0) {
      diagLog(`[PROACTIVE] IMMEDIATE spawn: msg=${parsed.messageId} folder=${parsed.folderId} size=${knownFilesize} (estimated duration=${estimatedDurationS.toFixed(1)}s)`);
      invoke('cmd_report_playback_position', {
        messageId: parseInt(parsed.messageId),
        folderId: parseInt(parsed.folderId),
        currentTimeS: 0,
        durationS: estimatedDurationS,
        fileSize: knownFilesize,
        isPlayerDownloading: false,
        playbackRate: 1,
      }).then((spawned: any) => {
        if (spawned) {
          proactivePrebufferMsgIdRef.current = parseInt(parsed.messageId);
          diagLog(`[PROACTIVE] Immediate spawn succeeded for msg ${parsed.messageId}`);
        }
      }).catch((e: any) => {
        console.error(`[PROACTIVE] Immediate spawn FAILED:`, e);
      });
    }

    // Get known duration. For TS files, Telegram doesn't provide video duration
    // in the document attributes, so file?.duration is typically undefined.
    // Previously we awaited /fmp4/metadata (~9s) before creating the player.
    // Now: create the player IMMEDIATELY with estimated duration, then update
    // when /fmp4/metadata returns. This lets mpegts.js start buffering data
    // while the metadata endpoint is still downloading the tail for PTS.
    let knownDuration: number | undefined = file?.duration ? file.duration : undefined;

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
      lazyLoad: true,                // ENABLED: registers timeupdate listener for auto-resume.
                                     // Fixed 180s ahead target (not scaled by playbackRate).
                                     // BUFFER_FULL (SourceBuffer quota) handled by our quota guard.
      lazyLoadMaxDuration: 180,      // 180s ahead, fixed media time.
      lazyLoadRecoverDuration: 120,  // Resume when buffer drops to 120s ahead (60s safety margin).
      seekType: 'range',             // Use HTTP Range for seeking (our server supports it)
      autoCleanupSourceBuffer: false, // Disable mpegts.js native cleanup; we manage the 60s behind window in quota guard.
      accurateSeek: false,           // Let mpegts.js seek to nearest keyframe for speed
    });


    mpegtsPlayerRef.current = player;

    // ── Shadow cache: JS-side byte cache for instant seeks ──
    // Caches raw TS bytes in JS memory (no SourceBuffer quota limit).
    // When mpegts.js seeks back to already-fetched positions, the fetch
    // interceptor serves bytes from memory — 0ms HTTP round-trip.
    const urlKey = `/stream/${activeFolderId}/${file?.id}`;
    const fileLen = state.current.fileLength || knownFilesize || 0;
    if (!shadowCacheRef.current) {
      shadowCacheRef.current = new StreamShadowCache(300 * 1024 * 1024); // 300MB budget
    }
    shadowCacheRef.current.reset(urlKey, fileLen);
    // Store player element and metadata for serve limit recomputation on Early EOF reconnect
    shadowCacheRef.current._playerElement = videoRef.current;
    shadowCacheRef.current._duration = fileLen / 500000; // bitrate estimate; updated when real duration known
    installStreamCacheInterceptor(shadowCacheRef.current);
    diagLog(`[MPEGTS] Shadow cache initialized: urlKey=${urlKey}, fileLength=${fileLen}`);

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

        // ── Track download speed from Telegram ──
        // _currentRange.to = furthest byte received so far.
        // Compute speed from byte delta over time.
        try {
          const ioctl = (player as any)?._player_engine?._transmuxer?._controller?._ioctl;
          if (ioctl?._currentRange && ioctl._currentRange.to >= 0) {
            const now = performance.now();
            const currentByte = ioctl._currentRange.to;
            const hist = mpegtsSpeedHistoryRef.current;
            hist.push({ time: now, byte: currentByte });
            // Keep last 5 seconds of history
            while (hist.length > 0 && hist[0].time < now - 5000) hist.shift();
            if (hist.length >= 2) {
              const first = hist[0];
              const last = hist[hist.length - 1];
              const dt = (last.time - first.time) / 1000;
              if (dt > 0.5) {
                const bytesPerSec = (last.byte - first.byte) / dt;
                setSpeed(bytesPerSec);
              }
            }
          }
        } catch { /* ignore */ }

        // ── Report downloaded byte ranges to backend (green buffer bar) ──
        // mpegts.js fetches data internally via FetchStreamLoader — the front-end
        // never sees the raw HTTP responses. But we can read the IOController's
        // internal _currentRange to track what's been fetched.
        // This mirrors what the MP4/fMP4 paths do with reportRangesToBackend().
        // _currentRange is {from, to} where 'from' is the start of the current
        // fetch range and 'to' is the furthest byte received so far in this range.
        try {
          const ioctl = (player as any)?._player_engine?._transmuxer?._controller?._ioctl;
          if (ioctl?._currentRange && ioctl._currentRange.to >= 0) {
            const from = ioctl._currentRange.from;
            const to = ioctl._currentRange.to;
            // Report the current fetch range to backend (debounced to 2s by reportRangesToBackend)
            reportRangesToBackend(from, to);
            // Track in front-end for green bar rendering
            trackDownloadedRange(from, to);
          }
        } catch { /* ignore — internal property access may break across versions */ }
      });

      // ── Guard endOfStream against premature LOADING_COMPLETE ──
      // mpegts.js emits LOADING_COMPLETE when the IOController finishes a range
      // request, even if the range doesn't cover the entire file (e.g., cache hit
      // serves bytes 0-N where N < fileLength). This triggers endOfStream() which
      // transitions MediaSource to "ended" — no more data can be appended.
      // Guard: only allow endOfStream when the IOController has actually loaded
      // to the end of the file.
      // CRITICAL: this must be applied BEFORE player.load(), otherwise the first
      // LOADING_COMPLETE/endOfStream can fire before the guard is in place.
      const guardEngine = (player as any)?._player_engine;
      const guardMseCtrl = guardEngine?._mse_controller;
      if (guardMseCtrl && typeof guardMseCtrl.endOfStream === 'function') {
        const guardOrigEndOfStream = guardMseCtrl.endOfStream.bind(guardMseCtrl);
        guardMseCtrl.endOfStream = function guardedEndOfStream() {
          const guardIoctl = guardEngine?._transmuxer?._controller?._ioctl;
          const guardTotalLen = guardIoctl?._totalLength || state.current.fileLength || 0;
          const guardLoadedTo = guardIoctl?._currentRange?.to ?? -1;
          if (guardTotalLen > 0 && guardLoadedTo >= 0 && guardLoadedTo + 1 < guardTotalLen) {
            // File NOT fully loaded — suppress endOfStream.
            // Put IOController back into paused state so the quota guard
            // can resume it when the buffer drains.
            if (guardIoctl && !guardIoctl.isPaused()) {
              guardIoctl._paused = true;
              guardIoctl._resumeFrom = guardLoadedTo + 1;
              diagLog(`[MPEGTS] endOfStream GUARDED: only ${guardLoadedTo}/${guardTotalLen} bytes loaded — IOController re-paused at byte ${guardLoadedTo + 1}`);
            } else {
              diagLog(`[MPEGTS] endOfStream GUARDED: only ${guardLoadedTo}/${guardTotalLen} bytes loaded — IOController already paused`);
            }
            return;
          }
          // File fully loaded — allow endOfStream
          diagLog(`[MPEGTS] endOfStream ALLOWED: ${guardLoadedTo + 1}/${guardTotalLen} bytes loaded (file complete)`);
          return guardOrigEndOfStream();
        };
      }

      // Mark that MSE pipeline is initialized (prevents MSE timeout)
      transmuxerInitInProgressRef.current = true;

      // Start fetching data. FastStreamPlayer sets v.autoplay and calls
      // v.play() on loadedmetadata/canplay — the video may start playing
      // before our gate checks. The startup buffer gate calls player.play()
      // as a safety net (idempotent — no-op if already playing). The gate
      // ensures at least 5s of buffer exists before we consider playback
      // "ready", which prevents early stalls if autoplay hasn't fired yet.
      player.load();
      diagLog('[MPEGTS] Player loaded, startup buffer gate will control play()');
      // ── Fetch ACTUAL duration from /fmp4/metadata in parallel ──
      // The player was created with an estimated duration. Now fetch the
      // real PTS-based duration from the backend (which downloads the file's
      // tail to extract final PTS). This takes ~9s but runs in parallel —
      // the player is already buffering and playing with the estimate.
      // When the real duration arrives, we update mediaSource.duration.
      if (!file?.duration) {
        const metaUrl = `${parsed.baseUrl}/fmp4/metadata/${parsed.folderId}/${parsed.messageId}?token=${parsed.token}&file_size=${state.current.fileLength}`;
        fetch(metaUrl).then(async (metaResp) => {
          if (!metaResp.ok) return;
          try {
            const meta = await metaResp.json();
            const metaDur = meta.duration_s || meta.duration;
            if (metaDur && metaDur > 0) {
              diagLog(`[MPEGTS] Got real duration from metadata: ${metaDur.toFixed(1)}s — updating (was estimated ${knownDuration?.toFixed(1)}s)`);
              (window as any).__nobuf_ptsDuration = metaDur;
              (window as any).__nobuf_durationIsEstimate = false; // real PTS available, no longer an estimate
              // Update shadow cache duration for serve limit recomputation
              if (shadowCacheRef.current) shadowCacheRef.current._duration = metaDur;

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

              // Report real duration to proactive prebuffer so it calculates
              // correct playhead byte position
              if (parsed.messageId && parsed.folderId) {
                try {
                  await (window as any).__TAURI_INTERNALS__.invoke('cmd_report_playback_position', {
                    messageId: parseInt(parsed.messageId),
                    folderId: parseInt(parsed.folderId),
                    currentTimeS: video.currentTime || 0,
                    durationS: metaDur,
                    fileSize: knownFilesize || 0,
                    isPlayerDownloading: false,
                    playbackRate: video.playbackRate || 1,
                  });
                } catch (_e: any) { /* non-critical */ }
              }
            }
          } catch (_e: any) { /* parse error — keep estimated duration */ }
        }).catch((_e: any) => {
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
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('mpegts.js initialization timeout (10s)'));
        }, 10000);

        player.on(MpegtsPlayer.Events.MEDIA_INFO, (info: any) => {
          clearTimeout(timeout);
          diagLog(`[MPEGTS] Media info: duration=${info.duration}s, codec=${info.videoCodec},${info.audioCodec}`);
          resolve();
        });
      });

      // ── Startup buffer gate ──
      // After MEDIA_INFO, the SourceBuffer may have only ~0.3s of data.
      // FastStreamPlayer auto-plays (v.autoplay + v.play on loadedmetadata),
      // so the video may already be playing when we get here. The gate is a
      // safety net — it ensures ≥5s of buffer exists. If autoplay already
      // started, player.play() is a no-op. If it didn't, we start playback
      // only when there's enough buffer for smooth startup.
      // 5s provides runway for download pipeline ramp-up at ~2x realtime.
      const STARTUP_BUFFER_GATE_SECONDS = 5;
      const STARTUP_BUFFER_GATE_TIMEOUT_MS = 15000; // Max wait before playing anyway
      const videoEl = videoRef.current || (player as any)?._media_element as HTMLVideoElement | undefined;
      if (videoEl) {
        const gateStart = Date.now();
        const checkBuffer = (): Promise<void> => {
          return new Promise<void>((resolveGate) => {
            const pollBuffer = () => {
              // Safety: don't wait forever — if timeout, play with whatever we have
              if (Date.now() - gateStart > STARTUP_BUFFER_GATE_TIMEOUT_MS) {
                diagLog(`[MPEGTS] Startup buffer gate TIMEOUT (${STARTUP_BUFFER_GATE_TIMEOUT_MS}ms) — playing with available buffer`);
                resolveGate();
                return;
              }
              const sb = videoEl.buffered;
              const bufEnd = sb?.length ? sb.end(sb.length - 1) : 0;
              const ct = videoEl.currentTime || 0;
              const ahead = bufEnd - ct;
              if (ahead >= STARTUP_BUFFER_GATE_SECONDS) {
                diagLog(`[MPEGTS] Startup buffer gate passed: ahead=${ahead.toFixed(1)}s ≥ ${STARTUP_BUFFER_GATE_SECONDS}s`);
                resolveGate();
              } else {
                // Not enough buffer yet — check again in 100ms
                setTimeout(pollBuffer, 100);
              }
            };
            pollBuffer();
          });
        };
        await checkBuffer();
      }

      // Gate passed — start playback now.
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
                  if (lcDts?._config) lcDts._config.__nobuf_resumeAuthorized = true;
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
          // Fixed 180s ahead / 60s behind. Only pacing bitrate scales with playbackRate.
          lc._config.lazyLoad = true;
          lc._config.lazyLoadMaxDuration = 180;
          lc._config.lazyLoadRecoverDuration = 120;
          lc._config.autoCleanupSourceBuffer = false;

          diagLog(`[MPEGTS] Buffer window: 180s ahead, 60s behind, lazyLoad=ON (maxDuration=180, recoverDuration=120, rate=${video.playbackRate || 1}x, quota-guard-managed), _onIOSeeked=no-op (prevent runaway loop)`);
        }
      };
      adjustBufferForSpeed(); // set initial values


      // ROOT CAUSE of "Dropping audio frame" spam + prebuffer pausing forever:
      // When lazyLoad resumes via _resumeTransmuxerIfNeeded, it calls
      // resumeTransmuxer() → resume() → _internalSeek(_resumeFrom).
      // The new fetch produces samples with DTS from the resume byte offset.
      // BUT the MP4Remuxer still has:
      //   1. _dtsBaseInited=true with OLD _dtsBase (from byte 0)
      //   2. _audioSegmentInfoList with OLD entries (originalDts in old DTS space)
      //   3. _audioStashedLastSample from before suspend
      // When _remuxAudio runs: firstSampleOriginalDts is in NEW DTS space,
      // getLastSampleBefore() returns an entry in OLD DTS space → dtsCorrection
      // is wildly negative → ALL audio frames dropped as overlap.
      // No audio in SourceBuffer → video.buffered intersection is empty →
      // _resumeTransmuxerIfNeeded never finds current_time in any range →
      // download never resumes again → prebuffer stays paused forever.
      // Fix: insertDiscontinuity (resets _audioNextDts/_videoNextDts → dtsCorrection=0)
      // + clear segment info lists + stashed samples BEFORE the resume logic runs.
      // Keep original _dtsBase so outputDTS ≈ rawDTS ≈ media time (continuous with SB tail).

      // AUDIO_SAFETY_MARGIN: When resuming after ahead-tail eviction, start the
      // download from a byte offset 6s BEFORE the SB-end time. In TS streams,
      // audio is interleaved 3-5s ahead of video. Starting from the exact SB-end
      // byte means the audio DTS there is ~4.5s ahead of the video PTS, creating
      // a large silence gap. Starting 6s earlier captures audio that matches the
      // SB-end time, eliminating the gap. The ~6s of re-transmuxed data creates
      // a harmless overlap in the SB.
      const AUDIO_SAFETY_MARGIN = 6;

      try {
        const engine = (player as any)?._player_engine;
        const loadingCtrl = engine?._loading_controller;
        if (loadingCtrl) {
          // ── Patch _onIOSeeked to prevent unwanted insertDiscontinuity ──
          // IOController.resume() → _internalSeek() → _onIOSeeked() → insertDiscontinuity()
          // This fires on EVERY resume, including lazyLoad resume where DTS is continuous.
          // insertDiscontinuity resets _audioNextDts/_videoNextDts to undefined, which
          // causes a runaway suspend/resume loop. Fix: replace _onIOSeeked to only fire
          // insertDiscontinuity on USER-INITIATED seek. Our patched resumeTransmuxer
          // calls insertDiscontinuity manually for eviction.
          const tCtrl = (player as any)?._player_engine?._transmuxer?._controller;
          if (tCtrl?._ioctl) {
            const origInsertDiscontOnSeeked = tCtrl._onIOSeeked?.bind(tCtrl);
            tCtrl._ioctl.onSeeked = function () {
              // Only fire insertDiscontinuity on user-initiated seek (our seek handler
              // sets __nobuf_userSeekInProgress=true). For lazyLoad resume and
              // Early-EOF reconnection, DTS is continuous — skip insertDiscontinuity.
              if ((window as any).__nobuf_userSeekInProgress === true) {
                origInsertDiscontOnSeeked?.();
              }
            };
          }

          const origResume = loadingCtrl.resumeTransmuxer.bind(loadingCtrl);
          loadingCtrl.resumeTransmuxer = function () {
            const isEvictionResume = (window as any).__nobuf_evictionResumePending === true;
            try {
              const tController = engine._transmuxer?._controller;
              if (tController?._remuxer) {
                const remuxer = tController._remuxer as any;

                if (isEvictionResume) {
                  // ── Eviction resume: insertDiscontinuity + demuxer reset (keep original _dtsBase) ──
                  // After eviction, download resumes from a different byte position with different
                  // raw PTS/DTS values. The original _dtsBase (~0, from the first sample of initial
                  // playback) makes outputDTS ≈ rawDTS ≈ media time, which is CONTINUOUS with the
                  // SB buffer tail. Resetting _dtsBaseInited=false would cause _calculateDtsBase()
                  // to set _dtsBase = rawDTS_of_new_first_sample (e.g. 205000ms), making
                  // outputDTS = rawDTS - 205000 ≈ 0ms — but the SB already has data up to ~211s,
                  // so MSE rejects the non-sequential append.
                  //
                  // Instead: insertDiscontinuity() resets _audioNextDts/_videoNextDts → dtsCorrection=0,
                  // so the remuxer accepts the new raw DTS values as-is (offset by the preserved _dtsBase≈0),
                  // producing outputDTS ≈ rawDTS ≈ continuous with the SB tail.
                  //
                  // remuxer.seek() must NOT be called — it clears codec metadata the demuxer won't
                  // re-emit after a non-zero byte seek, killing the pipeline.
                  remuxer.insertDiscontinuity?.();
                  // Clear stashed samples + segment info lists — same as remuxer.seek()
                  // but without destroying codec metadata (which seek() does).
                  remuxer._audioStashedLastSample = null;
                  remuxer._videoStashedLastSample = null;
                  remuxer._videoSegmentInfoList?.clear?.();
                  remuxer._audioSegmentInfoList?.clear?.();
                  (window as any).__nobuf_evictionResumePending = false;
                  // ── Trim shadow cache around new byte position ──
                  // After eviction resume, the player downloads from a new byte offset.
                  // Old cache data at low byte offsets is useless — trim it to make room
                  // for new data at the current byte position. Without this, the cache
                  // stays full of stale data and forwardAndSiphon stops caching at 300MB,
                  // meaning the cache can't serve future lazyLoad resumes.
                  try {
                    const cache = shadowCacheRef.current;
                    if (cache && cache.fileLength > 0) {
                      // Estimate resume byte from current playback position
                      const dur = mpegtsDurationRef.current || 1;
                      const resumeByte = Math.round(((videoRef.current?.currentTime || 0) / dur) * cache.fileLength);
                      const windowBytes = 150 * 1024 * 1024; // ±150MB ≈ ±5min
                      cache.trimAround(resumeByte, windowBytes);
                      diagLog(`[MPEGTS] Shadow cache trimmed around byte ${resumeByte} (totalBytes=${cache.totalBytes})`);
                    }
                  } catch { /* non-fatal */ }
                  diagLog('[MPEGTS] resumeTransmuxer: insertDiscontinuity + demuxer reset (eviction, keep _dtsBase) — NO seek');
                } else {
                  // ── Normal lazyLoad resume ──
                  // Call insertDiscontinuity() + demuxer reset + UNDERSHOOT.
                  //
                  // insertDiscontinuity() resets _nextDts to undefined, so the first
                  // sample gets dtsCorrection=0 (accepted, not dropped). Without it,
                  // the stale _nextDts causes massive dtsCorrection → ALL frames dropped.
                  //
                  // UNDERSHOOT: computeResumeByte places the resume point at the byte
                  // corresponding to bufEnd. But due to VBR, the actual PTS at that byte
                  // can be 3-5s AHEAD of bufEnd, creating a SourceBuffer gap (white bar).
                  // By undershooting by ~5s of bytes, the new data starts BEFORE bufEnd,
                  // creating an OVERLAP. Chrome's SourceBuffer merges overlapping appends
                  // into one continuous range → no white bar gap.
                  //
                  // The demuxer FULL RESET (below) clears the stale state that caused
                  // DTS corruption in the original v1 approach:
                  //   - PES queues cleared → no stale frames with old DTS
                  //   - PCR wraparound reset → no false wraparound detection
                  //   - timestamp_offset_ reset → no offset carryover
                  // With insertDiscontinuity (dtsCorrection=0 for first frame), the
                  // overlapping frames are accepted by the remuxer, not dropped.
                  //
                  // History of approaches:
                  //   v1: undershoot 10s + NO insertDiscontinuity → stale _nextDts causes
                  //       dtsCorrection=-3s → ALL frames dropped → nuclear DTS corruption
                  //   v2: insertDiscontinuity + demuxer reset + NO undershoot → first frame
                  //       accepted but DTS is 3-5s ahead of bufEnd → SourceBuffer gap (white bar)
                  //   v3: SET _nextDts to bufEnd×90k + dtsBase → WRONG UNITS (mpegts.js uses
                  //       ms, not 90kHz ticks) AND rawDts > bufEnd even with correct units →
                  //       ALL frames dropped (dtsCorrection still negative) ✓ CONFIRMED BROKEN
                  //   v4: insertDiscontinuity + demuxer reset + UNDERSHOOT 5s → overlap merges
                  //       into existing SourceBuffer range → no gap, no corruption ✓
                  //
                  // Runaway suspend/resume loop prevention: the one-shot
                  // __nobuf_skipNextLazySuspend flag (same as eviction path) prevents
                  // lazyLoad from immediately re-suspending when the transmuxer
                  // processes cached data quickly.
                  remuxer.insertDiscontinuity?.();
                  remuxer._audioStashedLastSample = null;
                  remuxer._videoStashedLastSample = null;
                  remuxer._videoSegmentInfoList?.clear?.();
                  remuxer._audioSegmentInfoList?.clear?.();
                      // One-shot: prevent lazyLoad from re-suspending immediately
                      (window as any).__nobuf_skipNextLazySuspend = true;
                      diagLog('[MPEGTS] resumeTransmuxer: lazyLoad resume — insertDiscontinuity + demuxer reset + undershoot (overlap merge)');
                    }
              }
              // ── Demuxer state reset (critical for eviction resume) ──
              // After eviction+seek, the TSDemuxer holds stale internal data from
              // the pre-eviction byte position. When new data arrives from the
              // seeked position, the demuxer's stale PES queues get EMITTED (for
              // video PID with expected_length===0), producing samples with OLD
              // DTS/PTS. These stale samples would hit the remuxer and produce
              // output with incorrect timestamps. We must clear ALL stale demuxer
              // state before origResume().
              if (tController?._demuxer) {
                const demuxer = tController._demuxer as any;
                // Both eviction and lazyLoad resume need demuxer state reset.
                // For lazyLoad: insertDiscontinuity() was called above, but stale
                // demuxer state (PES queues, PCR wraparound) still causes corruption.
                // For eviction: same issue after SourceBuffer clear + seek.
                {
                  // 1. Clear stale PES slice queues — the PRIMARY DTS corruption source.
                  //    Video PID queues with expected_length===0 get EMITTED on the next
                  //    payload_unit_start_indicator, producing stale samples.
                  if (demuxer.pes_slice_queues_) {
                    for (const pid of Object.keys(demuxer.pes_slice_queues_)) {
                      delete demuxer.pes_slice_queues_[pid];
                    }
                  }
                  // 2. Clear stale track sample buffers
                  if (demuxer.video_track_?.samples) demuxer.video_track_.samples = [];
                  if (demuxer.audio_track_?.samples) demuxer.audio_track_.samples = [];
                  // 3. Reset PTS interpolation state
                  demuxer.audio_last_sample_pts_ = undefined;
                  // 4. Clear incomplete AAC frame tail (prepended to new audio data)
                  demuxer.aac_last_incomplete_data_ = null;
                  // 5. Clear LOAS AAC continuation frame
                  if ('loas_previous_frame' in demuxer) demuxer.loas_previous_frame = null;
                  // 6. Reset MPEG-TS timestamp wraparound state — stale last_pcr_base_
                  //    causes FALSE wraparound detection, adding extra 0x200000000
                  //    (95 million ms) to timestamps. This happens when the resumed
                  //    byte position has a PCR lower than the stale last_pcr_base_.
                  if ('timestamp_offset_' in demuxer) demuxer.timestamp_offset_ = 0;
                  if ('last_pcr_base_' in demuxer) demuxer.last_pcr_base_ = -1;
                  diagLog('[MPEGTS] resumeTransmuxer: demuxer FULL RESET (pes_queues, tracks, wraparound)');
                }
              }
            } catch (e: any) {
              diagLog(`[MPEGTS] resumeTransmuxer patch warning: ${e.message}`);
            }
            if (isEvictionResume) {
              const resumeByte = (window as any).__nobuf_evictionResumeByte || 0;
              (window as any).__nobuf_evictionResumeByte = 0;
              // Set _resumeFrom on the IOController so origResume() fetches from the
              // correct byte position. origResume() → IOController.resume() →
              // _internalSeek(_resumeFrom) will use this value.
              const ioCtrl = loadingCtrl._ioctl || (player as any)?._player_engine?._transmuxer?._controller?._ioctl;
              const ioCtrlWasPaused = ioCtrl?._paused ?? false;
              if (resumeByte > 0 && ioCtrl) {
                ioCtrl._resumeFrom = resumeByte;
                diagLog(`[MPEGTS] Eviction resume: set ioCtrl._resumeFrom=${resumeByte}, ioCtrl._paused=${ioCtrlWasPaused}, calling origResume()`);
              } else {
                diagLog(`[MPEGTS] Eviction resume: resumeByte=${resumeByte}, ioCtrl=${ioCtrl ? 'available' : 'null'}, calling origResume()`);
              }
              // Set one-shot skip flag so the next lazyLoad suspend (NOT BUFFER_FULL)
              // is skipped after eviction resume. Without this, lazyLoad immediately
              // re-suspends because ahead ≈ 180s ≈ lazyLoadMax=180, creating an instant
              // suspend loop. The flag is checked in our patched suspendTransmuxer and
              // cleared after skipping exactly one lazyLoad suspend.
              const lc2 = (player as any)?._player_engine?._loading_controller;
              if (lc2?._config) {
                lc2._config.__nobuf_skipNextLazySuspend = true;
              }
              // ── Set interceptor serve limit BEFORE origResume (eviction resume) ──
              // Without this, the old lazyLoad serve limit (e.g. 155s) remains active,
              // so data downloaded after eviction (e.g. at 405s) is paced/throttled
              // instead of being served quickly from the shadow cache.
              {
                const _scEvict = shadowCacheRef.current;
                if (_scEvict) {
                  const durEvict = mpegtsDurationRef.current || (window as any).__nobuf_ptsDuration || 0;
                  const fLenEvict = state.current.fileLength || 0;
                  const lcEvict2 = (player as any)?._player_engine?._loading_controller;
                  const MAX_SERVE_AHEAD_SECONDS = 180;
                  const targetAheadEvict = Math.min(lcEvict2?._config?.lazyLoadMaxDuration ?? 120, MAX_SERVE_AHEAD_SECONDS);
                  const limitTimeEvict = (engine._media_element?.currentTime ?? 0) + targetAheadEvict;
                  const limitByteEvict = findByteForTime(limitTimeEvict, byteTimeSamplesRef.current, durEvict, fLenEvict)
                    || (durEvict > 0 && fLenEvict > 0 ? Math.floor((limitTimeEvict / durEvict) * fLenEvict) : 0);
                  if (limitByteEvict > 0) {
                    _scEvict._interceptorServeLimitByte = limitByteEvict;
                    _scEvict._lazyLoadMax = targetAheadEvict;
                    _scEvict._interceptorPauseUntil = 0;
                    diagLog(`[MPEGTS] Eviction resume: set interceptor serve limit byte=${limitByteEvict} (ct+${targetAheadEvict}s=${limitTimeEvict.toFixed(1)}s) BEFORE origResume`);
                  }
                }
              }
              origResume();
              // ── Post-resume verification (eviction path) ──
              // Only run if the IOController was actually paused and we just resumed it.
              // If the IOController was already running, the correction seek below can
              // fight the current download and create a resume loop.
              {
                const ioCtrlPost = engine._transmuxer?._controller?._ioctl;
                if (ioCtrlWasPaused && ioCtrlPost?._currentRange && resumeByte > 0) {
                  const dur = mpegtsDurationRef.current || (window as any).__nobuf_ptsDuration || 0;
                  const fLen = state.current.fileLength || 0;
                  const seekFromByte = ioCtrlPost._currentRange.from;
                  if (dur > 0 && fLen > 0 && seekFromByte >= 0) {
                    const seekFromTime = (seekFromByte / fLen) * dur;
                    const resumeTime = (resumeByte / fLen) * dur;
                    // If the IOController's current range is far behind the eviction
                    // resume target, correct it. A small gap is allowed because the
                    // IOController may align to the next 188-byte boundary.
                    if (seekFromTime < resumeTime - 10) {
                      ioCtrlPost.seek(resumeByte);
                      diagLog(`[MPEGTS] resumeTransmuxer (eviction): POST-RESUME correction from ${seekFromByte} (${seekFromTime.toFixed(1)}s) → ${resumeByte} (${resumeTime.toFixed(1)}s)`);
                    }
                  }
                }
              }
            } else {
              // ── Normal lazyLoad resume ──
              // ROOT CAUSE: IOController.pause() sets _resumeFrom from _currentRange.to + 1.
              // But _currentRange.to is stale because abort() kills the in-flight fetch
              // before all delivered data is transmuxed. _resumeFrom ends up BEHIND the
              // SourceBuffer's actual end → IOController seeks to stale byte → overlapping
              // DTS → SourceBuffer discards → no new data → player stalls.
              //
              // FIX: Override _resumeFrom with the correct byte computed from the
              // SourceBuffer's bufferEnd (ground truth), using computeResumeByte().
              {
                const ioCtrl = loadingCtrl._ioctl || (player as any)?._player_engine?._transmuxer?._controller?._ioctl;
                const videoEl = (player as any)?._media_element as HTMLVideoElement | undefined;
                const sb = videoEl?.buffered;
                const bufEnd = sb?.length ? sb.end(sb.length - 1) : 0;
                const dur = mpegtsDurationRef.current || (window as any).__nobuf_ptsDuration || 0;
                const fLen = state.current.fileLength || 0;
                let correctByte = computeResumeByte(bufEnd, dur, fLen, shadowCacheRef.current, !isEvictionResume, byteTimeSamplesRef.current);

                // VBR-safe disk-cache continuity: computeResumeByte uses global linear bitrate,
                // which is wrong for VBR. For TS files the actual byte at bufEnd can be far behind
                // the linear estimate. If we resume from the linear byte, we skip ahead of the
                // contiguous disk cache and leave a white-bar gap in the seek bar / shadow cache.
                // Instead, resume from the end of the cached range that precedes the linear byte,
                // minus a small overlap so the SourceBuffer still merges.
                if (correctByte > 0 && shadowCacheRef.current && !isEvictionResume) {
                  const diskCacheEnd = shadowCacheRef.current.rangeEndBefore(correctByte);
                  if (diskCacheEnd != null && diskCacheEnd < correctByte) {
                    const bytesPerSecond = fLen / (dur || 1);
                    const overlapBytes = Math.floor(5 * bytesPerSecond);
                    const candidate = Math.max(0, diskCacheEnd - overlapBytes);
                    const alignedCandidate = alignToTSSyncByte(candidate, shadowCacheRef.current);
                    if (alignedCandidate > 0 && alignedCandidate < correctByte) {
                      diagLog(`[MPEGTS] resumeTransmuxer: VBR cache-continuity override ${correctByte} \u2192 ${alignedCandidate} (diskCacheEnd=${diskCacheEnd}, overlap=${overlapBytes}B)`);
                      correctByte = alignedCandidate;
                    }
                  }
                }

                if (correctByte > 0 && ioCtrl) {
                  const staleResumeFrom = ioCtrl._resumeFrom ?? -1;
                  const dur2 = mpegtsDurationRef.current || (window as any).__nobuf_ptsDuration || 0;
                  const fLen2 = state.current.fileLength || 0;
                  const staleTime = dur2 > 0 && fLen2 > 0 && staleResumeFrom > 0
                    ? ((staleResumeFrom / fLen2) * dur2).toFixed(1) : '?';
                  const correctTime = dur2 > 0 && fLen2 > 0
                    ? ((correctByte / fLen2) * dur2).toFixed(1) : '?';
                  diagLog(`[MPEGTS] resumeTransmuxer: _resumeFrom=${staleResumeFrom} (${staleTime}s) \u2192 ${correctByte} (${correctTime}s) at bufEnd=${bufEnd.toFixed(1)}s`);
                  ioCtrl._resumeFrom = correctByte;
                }
              }
              // ── Set interceptor serve limit BEFORE origResume ──
              // CRITICAL: origResume() → IOController.resume() → _internalSeek()
              // → fetch() → interceptor runs synchronously. If the serve limit is
              // set AFTER origResume(), the interceptor sees _interceptorServeLimitByte=0
              // during the first fetch and serves ALL prebuffered data → bufEnd jumps 38+s.
              {
                const _scLazy = shadowCacheRef.current;
                if (_scLazy) {
                  const bytesPerSecond = (state.current.fileLength || 0) / (state.current.duration || 1);
                  const lcLazy2 = (player as any)?._player_engine?._loading_controller;
                  // Cap serve limit at SourceBuffer quota (~180s of content).
                  // lazyLoadMax may be 480s at 4x, but SourceBuffer can only hold ~180s.
                  const MAX_SERVE_AHEAD_SECONDS = 180;
                  const targetAhead = Math.min(lcLazy2?._config?.lazyLoadMaxDuration ?? 120, MAX_SERVE_AHEAD_SECONDS);
                  const limitTime = (engine._media_element?.currentTime ?? 0) + targetAhead;
                  const limitByte = Math.floor(limitTime * bytesPerSecond);
                  _scLazy._interceptorServeLimitByte = limitByte;
                  _scLazy._lazyLoadMax = targetAhead;
                  _scLazy._interceptorPauseUntil = 0; // clear old pause — serve limit replaces it
                  diagLog(`[MPEGTS] LazyLoad resume: set interceptor serve limit byte=${limitByte} (ct+${targetAhead}s=${limitTime.toFixed(1)}s) BEFORE origResume`);
                }
              }
              // origResume() → IOController.resume() → _internalSeek(_resumeFrom) → _onIOSeeked()
              // → remuxer.insertDiscontinuity() would be a DOUBLE call (we already did it above).
              // We patched _onIOSeeked to be a no-op to prevent this double insertDiscontinuity.
              origResume();
              // Set one-shot skip flag for lazyLoad re-suspend after resume.
              // After resume, data arrives fast from cache and ahead quickly exceeds lazyLoadMax,
              // causing immediate re-suspend and a thrash loop. The one-shot flag skips the FIRST
              // suspend attempt after resume.
              const lcLazy = (player as any)?._player_engine?._loading_controller;
              if (lcLazy?._config) {
                lcLazy._config.__nobuf_skipNextLazySuspend = true;
              }
            }
          };
          diagLog('[MPEGTS] Patched LoadingController.resumeTransmuxer: eviction=insertDiscontinuity+demuxer reset, lazyLoad=insertDiscontinuity+demuxer reset+5s undershoot (overlap merge)');

          // Also hook suspendTransmuxer for auto-recovery
          // CRITICAL BUG #1: _onMSEBufferFull calls suspendTransmuxer() but does NOT
          // register a timeupdate listener for auto-resume (only lazyLoad does).
          // Without our fix, the download never resumes after BUFFER_FULL.
          //
          // CRITICAL BUG #2: _isBufferFull is set AFTER emit(BUFFER_FULL) in
          // mse-controller.js (line 506-507), so checking it inside suspendTransmuxer
          // always finds false. We detect BUFFER_FULL by checking whether
          // bufferEnd - currentTime < lazyLoadMaxDuration.
          //
          // CRITICAL BUG #3: After BUFFER_FULL, _resumeFrom on the io-controller
          // points to the byte offset where the LOADER stopped (which may be well
          // past the SourceBuffer's content). This creates a TIMESTAMP GAP between
          // the SourceBuffer's end and the new data. The video stalls at the gap.
          // Fix: override _resumeFrom to the byte offset of the SourceBuffer's end.
          //
          // CRITICAL BUG #4: Waiting for SourceBuffer's updateend before resuming
          // causes a 30+ second delay (the event may never fire on the right SB).
          // Fix: resume IMMEDIATELY after calling remove() — mpegts.js handles
          // sbuf.updating internally by retrying appendBuffer later.
          const origSuspend = loadingCtrl.suspendTransmuxer.bind(loadingCtrl);
          loadingCtrl.suspendTransmuxer = function () {
            const video = (player as any)?._media_element as HTMLVideoElement | undefined;
            const ct = video?.currentTime ?? 0;
            const bufEnd = video?.buffered?.length ? video.buffered.end(video.buffered.length - 1) : 0;
            const ahead = bufEnd - ct;

            // ── PART A: Save IOController position BEFORE origSuspend() ──
            // When IOController.pause() fires (from suspend), it computes _resumeFrom
            // from _currentRange.to + 1. But _currentRange.to is only updated on loader
            // COMPLETE, not during chunk arrival. If the shadow cache serves data
            // instantly, the IOController may pause before the loader completes, leaving
            // _currentRange.to stale. This causes _resumeFrom to be a stale byte that
            // corresponds to a time BEFORE the current bufferEnd, so the next resume
            // seeks behind the already-buffered data and produces overlapping DTS that
            // the SourceBuffer discards.
            // Fix: compute the correct byte from the SourceBuffer's ACTUAL end time,
            // not from the IOController's stale _currentRange.to.
            const ioCtrlBefore = engine._transmuxer?._controller?._ioctl;
            const savedResumeFrom = ioCtrlBefore?._resumeFrom ?? -1;
            const savedCurrentRangeTo = ioCtrlBefore?._currentRange?.to ?? -1;
            const savedStashByteStart = ioCtrlBefore?._stashByteStart ?? 0;

            // ── One-shot lazyLoad suspend skip (after eviction/lazyLoad resume) ──
            // After any resume, ahead ≈ lazyLoadMax, so lazyLoad would
            // immediately re-suspend. The resume path sets the
            // __nobuf_skipNextLazySuspend flag to suppress exactly ONE lazyLoad suspend.
            // BUFFER_FULL suspends (mseCtrl._isBufferFull === true) are NEVER skipped.
            const mseCtrlPre = (player as any)?._player_engine?._msectrl;
            const lcConfig = loadingCtrl?._config;

            // ── PART C: Do NOT suppress lazyLoad when the interceptor is pacing ──
            // Previous versions suppressed lazyLoad whenever _pacingBps > 0, which
            // made the interceptor the sole authority for keeping the buffer ahead.
            // That is wrong on VBR files and while paused/stalled: the pacing rate
            // is only an estimate, and if the transmuxer has already buffered data,
            // the SourceBuffer keeps growing and the quota guard starts repeatedly
            // evicting the tail (the loop seen in 66-c.md). The eviction loop then
            // resets the demuxer every second, which can stall playback and makes
            // the white bar fluctuate.
            //
            // Fix: let lazyLoad do its job. The interceptor paces download, but
            // lazyLoad is the hard ceiling that actually pauses the IOController
            // when bufferedEnd >= currentTime + lazyLoadMaxDuration. We only
            // suppress the immediate re-suspend after an authorized resume via the
            // skip flag. BUFFER_FULL suspends are always honored.
            //
            // CRITICAL: mpegts.js's lazyLoad uses the internal transmuxer endDTS
            // for the buffered position, which can be tens of seconds ahead of what
            // has actually been appended to the SourceBuffer. If we suspend based
            // on endDTS alone, the IOController pauses while the video element only
            // has ~90-110 s of real buffer. The progressive resume then wakes it
            // immediately, and we get a tight resume/suspend fight (67-c/68-c).
            // Fix: only allow the actual pause when the *real* SourceBuffer ahead
            // has reached the lazyLoad ceiling (default 120 s). When the real
            // buffer is below that, keep the IOController running so it fills to the
            // real target before pausing.
            const isBufferFullSuspend = mseCtrlPre?._isBufferFull === true;
            const lazyLoadMax = lcConfig?.lazyLoadMaxDuration ?? 120;
            const isRealBufferBelowCeiling = ahead < lazyLoadMax;
            const isSkipFlag = lcConfig?.__nobuf_skipNextLazySuspend === true;
            if (!isBufferFullSuspend && (isRealBufferBelowCeiling || isSkipFlag)) {
              if (isSkipFlag) {
                delete lcConfig.__nobuf_skipNextLazySuspend;
              }
              return; // suppress the premature suspend (and/or the immediate re-suspend)
            }

            // Only log real suspends (BUFFER_FULL). LazyLoad suppression is expected
            // and happens hundreds of times per minute.
            diagLog(`[MPEGTS] suspendTransmuxer: currentTime=${ct.toFixed(1)}s, bufferEnd=${bufEnd.toFixed(1)}s, ahead=${ahead.toFixed(1)}s`);

            // Compute correct preSuspendByte from SourceBuffer's actual end time.
            // This is the byte position AFTER the last buffered frame, which is where
            // the next download should start. Using bufferEnd is more reliable than
            // _currentRange.to because the SourceBuffer knows the actual end of data.
            // NOTE: computed only when we are actually going to suspend — when pacing
            // or the one-shot skip suppresses the suspend, this work is unnecessary and
            // avoids spamming the TS sync-byte alignment logs.
            const dur = mpegtsDurationRef.current || (window as any).__nobuf_ptsDuration || 0;
            const fLen = state.current.fileLength || 0;
            let preSuspendByte = computeResumeByte(bufEnd, dur, fLen, shadowCacheRef.current, true, byteTimeSamplesRef.current);
            // Fallback: if we can't compute from bufferEnd, use IOController state
            if (preSuspendByte <= 0) {
              preSuspendByte = ioCtrlBefore?._stashUsed !== 0
                ? savedStashByteStart
                : (savedCurrentRangeTo >= 0 ? savedCurrentRangeTo + 1 : (savedResumeFrom > 0 ? savedResumeFrom : -1));
            }

            origSuspend();

            // ── Clear resume authorization and interceptor serve limit ──
            // The suspend means the download is paused. Clear the authorization
            // flag so mpegts.js internals can't call resumeTransmuxer without
            // the quota guard's explicit permission. Also clear the interceptor
            // serve limit — it was set to prevent cache burst on the previous resume,
            // ── DO NOT clear interceptor serve limit on suspend ──
              // The serve limit must persist through suspend to prevent Early EOF
              // reconnect from fetching unlimited data. When the IOController gets
              // Early EOF from a truncated cache response, it auto-reconnects via
              // _internalSeek(currentRange.to + 1). This new fetch goes through the
              // interceptor, which needs the serve limit to be active.
              // The next resume will overwrite the limit with a new value.
              // (Previously, clearing the limit here caused the Early EOF reconnect
              // to bypass the limit → bufEnd overshoot by 36+s.)
            if (lcConfig?.__nobuf_resumeAuthorized) {
              delete lcConfig.__nobuf_resumeAuthorized;
            }

            // ── PART A: AFTER origSuspend(), detect and fix _resumeFrom corruption ──
            // IOController.pause() may have set _resumeFrom = _currentRange.to + 1 = 0
            // when _currentRange.to = -1 (no loader COMPLETE yet). This causes the next
            // resume to fetch from byte 0, producing data at DTS≈0 while SourceBuffer has
            // content at ~191s, dropping all audio.
            // Grace period: ct > 30 — during initial download (ct < 30), _resumeFrom=0
            // is the normal initial state and should not be treated as corruption.
            const ioCtrlAfter = engine._transmuxer?._controller?._ioctl;
            const resumeFromAfter = ioCtrlAfter?._resumeFrom ?? -1;
            if (resumeFromAfter === 0 && ct > 30 && preSuspendByte > 0) {
              // _resumeFrom was corrupted to 0 — restore from pre-suspend position.
              // DO NOT bump to cacheEnd — same bug as computeResumeByte:
              // cache may have data far past bufEnd (from independent prebuffer),
              // and jumping there skips content → DTS gap → decode error.
              let correctedByte = preSuspendByte;
              const cache = shadowCacheRef.current;
              if (cache && cache.entryCount > 0) {
                // Align to 188-byte TS packet boundary and verify 0x47 sync byte
                correctedByte = alignToTSSyncByte(correctedByte, cache);
              } else {
                // Cache is empty (evicted) — can't verify 0x47 but preSuspendByte
                // is correct (saved before IOController paused). Just 188-align it.
                correctedByte = Math.floor(correctedByte / 188) * 188;
                diagLog(`[MPEGTS] suspendTransmuxer: Cache empty, using 188-aligned preSuspendByte ${correctedByte} (cannot verify 0x47)`);
              }
              if (correctedByte > 0 && ioCtrlAfter) {
                ioCtrlAfter._resumeFrom = correctedByte;
                diagLog(`[MPEGTS] suspendTransmuxer: _resumeFrom CORRUPTED to 0 (ct=${ct.toFixed(1)}s, preSuspendByte=${preSuspendByte}) — RESTORED to ${correctedByte}`);
              }
            }

            // Register timeupdate listener for auto-resume (BUFFER_FULL path needs this)
            if (loadingCtrl._media_element && loadingCtrl.e?.onMediaTimeUpdate) {
              loadingCtrl._media_element.addEventListener('timeupdate', loadingCtrl.e.onMediaTimeUpdate);
            }

            // Mark BUFFER_FULL if this is a quota suspension (not lazyLoad)
            // LazyLoad suspends when ahead >= lazyLoadMaxDuration (normal).
            // BUFFER_FULL occurs when SourceBuffer byte quota is hit (QuotaExceededError).
            // We detect BUFFER_FULL by checking the MSE controller's _isBufferFull flag.
            // The old heuristic (ahead < lazyLoadMax) was too aggressive — it marked
            // lazyLoad suspends at ahead ≈ lazyLoadMax as BUFFER_FULL, causing
            // infinite eviction loops.
            const mseCtrl = (player as any)?._player_engine?._msectrl;
            if (mseCtrl?._isBufferFull === true) {
              // This is a BUFFER_FULL suspension (not lazyLoad)
              (window as any).__nobuf_bufferFullDetected = true;
              diagLog('[MPEGTS] BUFFER_FULL detected (mseCtrl._isBufferFull=true) — flag set, quota guard will evict and resume');
            }
          };

          // Log resume context (resumeTransmuxer is already patched above via origResume)
          // We add logging by wrapping the ALREADY-patched version
          const alreadyPatchedResume = loadingCtrl.resumeTransmuxer.bind(loadingCtrl);
          const innerOrigResume = alreadyPatchedResume;
          loadingCtrl.resumeTransmuxer = function () {
            // Block ManagedMediaSource's auto-resume (startstreaming event) while
            // we're handling BUFFER_FULL. MSE fires startstreaming when it wants
            // more data, but the SourceBuffer is still full — resuming just causes
            // another appendBuffer → QuotaExceededError → BUFFER_FULL loop.
            if ((window as any).__nobuf_bufferFullDetected === true) {
              diagLog(`[MPEGTS] resumeTransmuxer BLOCKED — __nobuf_bufferFullDetected=true (ManagedMediaSource startstreaming ignored)`);
              return;
            }
            // ── Resume authorization gate ──
            // Only allow resume when explicitly authorized by the quota guard's
            // safe-resume or emergency-resume path. mpegts.js's internal
            // LoadingController may call resumeTransmuxer without authorization
            // (e.g., when it detects available data after a suspend), causing an
            // infinite resume→suspend→resume loop (Bug #2 in 50-t analysis).
            // The __nobuf_resumeAuthorized flag is set by our resume paths and
            // cleared by suspendTransmuxer after origSuspend().
            const lcConfigInner = loadingCtrl?._config;
            if (lcConfigInner && !lcConfigInner.__nobuf_resumeAuthorized) {
              // Unauthorized resume — block it
              const video = (player as any)?._media_element as HTMLVideoElement | undefined;
              const ctBlock = video?.currentTime?.toFixed(1) ?? '?';
              const aheadBlock = video?.buffered?.length
                ? (video.buffered.end(video.buffered.length - 1) - video.currentTime).toFixed(1) : '?';
              diagLog(`[MPEGTS] resumeTransmuxer BLOCKED — not authorized (ct=${ctBlock}s, ahead=${aheadBlock}s). Only quota guard can resume.`);
              return;
            }
            const video = (player as any)?._media_element as HTMLVideoElement | undefined;
            const ct = video?.currentTime?.toFixed(1) ?? '?';
            const bufEnd = video?.buffered?.length ? video.buffered.end(video.buffered.length - 1).toFixed(1) : '?';
            diagLog(`[MPEGTS] resumeTransmuxer CALL: currentTime=${ct}s, bufferEnd=${bufEnd}s`);
            innerOrigResume();
          };
        }
      } catch (e: any) {
        diagLog(`[MPEGTS] Could not patch resumeTransmuxer: ${e.message}`);
      }

      // ── SourceBuffer quota guard (primary BUFFER_FULL handler) ──
      // With lazyLoadMaxDuration=180, lazyLoad suspends when buffer >180s ahead,
      // but resumes 30s before buffer end. BUFFER_FULL (SourceBuffer quota) also
      // triggers suspendTransmuxer. This guard runs every 100ms and detects BUFFER_FULL via:
      //   1. mseCtrl._isBufferFull === true (set after BUFFER_FULL event)
      //   2. (window).__nobuf_bufferFullDetected === true
      // It then evicts old content and resumes download immediately.
      //
      // We do NOT modify autoCleanupMaxBackwardDuration — mpegts.js's internal
      // _doCleanupSourceBuffer computes removeEnd = currentTime - that_value,
      // which is NEGATIVE when ct < value, causing sb.remove(0, -239) crash.
      //
      // sb.remove() is ASYNC — space isn't freed until 'updateend'. We wait for
      // removal to complete before resuming, otherwise mpegts.js immediately
      // re-suspends on BUFFER_FULL.
      //
      // Uses setInterval(100ms) for fast response at high speed.
      // Scale quota guard thresholds by playbackRate: at 2x speed, buffer drains 2x faster,
      // so we need proportionally more ahead to prevent underruns. Base values are for 1x.
      // These are recomputed on every 100ms tick inside sourceBufferQuotaGuard for instant rate response.
      // Fixed 180s ahead / 60s behind in-memory buffer. Pacing bitrate scales with playbackRate,
      // but the media-time window does not.
      const BASE_QUOTA_DANGER_DURATION = 240;   // "quota pressure relieved" threshold
      const BASE_QUOTA_KEEP_AHEAD = 180;        // target ahead in seconds (fixed)
      const BASE_QUOTA_KEEP_BEHIND = 60;      // target behind in seconds (fixed)
      // NOTE: At high bitrates the 180s/60s window may exceed the browser SourceBuffer quota.
      // The guard below shrinks the behind window first (60 → 30 → 15) while preserving 180s ahead.
      let _aggressiveCleanupActive = false;
      let _removeInProgress = false;  // true while sb.remove() is pending
      (window as any).__nobuf_removeInProgress = false;
      // _bufferFullDetected is tracked via (window).__nobuf_bufferFullDetected
      // because the suspendTransmuxer patch (defined earlier) can't access this closure.
      (window as any).__nobuf_quotaGuardAggressive = false;
      (window as any).__nobuf_bufferFullDetected = false; // accessible from suspendTransmuxer patch
      (window as any).__nobuf_evictScheduled = false;     // accessible from ERROR handler eviction
      (window as any).__nobuf_evictionResumePending = false;  // clear eviction-resume DTS reset signal
      (window as any).__nobuf_evictionResumeByte = 0;           // clear eviction resume byte position
      (window as any).__nobuf_nuclearRecoveryInProgress = false;  // clear nuclear guard
      (window as any).__nobuf_ptsDuration = 0;             // clear PTS-based duration
      (window as any).__nobuf_durationIsEstimate = false;  // clear estimate flag
      (window as any).__nobuf_estimateDuration = 0;        // clear estimate duration

      // Helper: resume download AND register timeupdate listener for auto-recovery.
      // resumeWithAutoRecovery was REMOVED — the quota guard must NEVER auto-resume.
      // LazyLoad manages its own resume via timeupdate listener.
      // BUFFER_FULL eviction resumes via onEvictDone → resumeTransmuxer().
      // Auto-resuming from the quota guard creates a suspend/resume fight that
      // corrupts IOController._resumeFrom → fetch from byte 0 → all audio dropped.

      const sourceBufferQuotaGuard = () => {
        // Bail out if nuclear recovery is in progress — don't trigger eviction+resume cycles
        if ((window as any).__nobuf_nuclearRecoveryInProgress) return;
        const engine = (player as any)?._player_engine;
        if (!engine) return;
        const sb = video.buffered;
        if (!sb || sb.length === 0) return;

        const curTime = video.currentTime;
        const mseCtrl = engine._mse_controller;
        // Use OUR flag instead of mseCtrl._isBufferFull which gets cleared by
        // mse-controller's _onSourceBufferUpdateEnd before our 100ms tick can see it.
        const isBufferFull = (window as any).__nobuf_bufferFullDetected === true;
        const lc = engine._loading_controller;
        const isPaused = lc?._paused === true;
        const ioCtrl = engine._transmuxer?._controller?._ioctl;
        const resumeFrom = ioCtrl?._resumeFrom ?? -1;

        // Fixed 180s/60s window. Only the pacing bitrate scales with playbackRate.
        const currentRate = video.playbackRate || 1;
        const QUOTA_DANGER_DURATION = BASE_QUOTA_DANGER_DURATION; // no rate scaling for the window itself
        const QUOTA_KEEP_AHEAD = BASE_QUOTA_KEEP_AHEAD;           // fixed 180s
        const QUOTA_KEEP_BEHIND = BASE_QUOTA_KEEP_BEHIND;         // fixed 60s
        // Safe byte budget: empirical Chrome MSE ceiling for the combined source buffer.
        const SAFE_SOURCE_BUFFER_BUDGET_BYTES = 250 * 1024 * 1024; // 250 MB
        const globalBitrateBps = (state.current.fileLength && mpegtsDurationRef.current)
          ? state.current.fileLength / mpegtsDurationRef.current
          : (state.current.fileLength && state.current.duration)
            ? state.current.fileLength / state.current.duration
            : 0;
        if (lc?._config) {
          if (lc._config.lazyLoadMaxDuration !== 180) {
            lc._config.lazyLoadMaxDuration = 180;
            lc._config.lazyLoadRecoverDuration = 120;
            diagLog(`[MPEGTS] Buffer window enforced: lazyLoadMax=180, lazyLoadRecover=120, rate=${currentRate}x, quotaDanger=${QUOTA_DANGER_DURATION}s, quotaKeep=${QUOTA_KEEP_AHEAD}s, quotaBehind=${QUOTA_KEEP_BEHIND}s`);
          }
        }

        // ── PART B: _resumeFrom corruption guard ──
        // On every quota guard tick, check if _resumeFrom got corrupted to 0
        // while playback is well past the start (currentTime > 30) AND the
        // player is PAUSED. During initial download (ct < 30), _resumeFrom=0
        // is the NORMAL initial state. Only flag corruption when the player
        // has been running (ct > 30) with _resumeFrom=0 AND _paused===true.
        // Root cause: same as lazyLoad resume — _currentRange.to is stale
        // after abort, so pause() sets _resumeFrom from stale state.
        if (resumeFrom === 0 && curTime > 30 && (state.current.fileLength || 0) > 0 && ioCtrl?._paused) {
          const dur = mpegtsDurationRef.current || (window as any).__nobuf_ptsDuration || 0;
          const fLen = state.current.fileLength || 0;
          const sb = video?.buffered;
          const bufEnd = sb?.length ? sb.end(sb.length - 1) : 0;
          const correctedByte = computeResumeByte(
            bufEnd > 0 ? bufEnd : curTime,  // fallback to currentTime if no bufEnd
            dur, fLen, shadowCacheRef.current, true, byteTimeSamplesRef.current
          );
          if (correctedByte > 0 && ioCtrl) {
            // Only log once per corruption event (not every 100ms tick)
            const lastFixTs = (window as any).__nobuf_resumeFromFixTs || 0;
            const now = Date.now();
            if (now - lastFixTs > 2000) {
              diagLog(`[MPEGTS-QUOTA] _resumeFrom=0 CORRUPTION at ct=${curTime.toFixed(1)}s — restored to ${correctedByte} (bufEnd=${bufEnd.toFixed(1)}s)`);
              (window as any).__nobuf_resumeFromFixTs = now;
            }
            ioCtrl._resumeFrom = correctedByte;
          }
        }

        // Calculate total buffered duration
        let totalBuffered = 0;
        for (let i = 0; i < sb.length; i++) {
          totalBuffered += sb.end(i) - sb.start(i);
        }
        const bufEnd = sb.end(sb.length - 1);
        const ahead = bufEnd - curTime;

        // Record accurate byte-to-time sample for VBR resume (use stash byte if available, it corresponds to buffer end)
        if (ioCtrl && bufEnd > 0) {
          const sampleByte = ioCtrl._stashByteStart > 0 ? ioCtrl._stashByteStart : (ioCtrl._currentRange?.to ?? -1);
          if (sampleByte > 0) {
            recordByteTimeSample(bufEnd, sampleByte);
          }
        }

        // ── Continuous interceptor cap: keep IOController at QUOTA_KEEP_AHEAD ──
        // Without an updated serve limit, the IOController downloads far ahead after
        // the initial lazyLoad resume, the SourceBuffer fills, and the browser silently
        // evicts from the beginning — causing the white bar to shrink / fluctuate.
        const capSc = shadowCacheRef.current;
        const capDuration = mpegtsDurationRef.current || (window as any).__nobuf_ptsDuration || state.current.duration || 0;
        const capFileLength = state.current.fileLength || 0;
        if (capSc && capDuration > 0 && capFileLength > 0) {
          const capTargetTime = curTime + QUOTA_KEEP_AHEAD;
          const capLimitByte = findByteForTime(capTargetTime, byteTimeSamplesRef.current, capDuration, capFileLength);
          if (capLimitByte > 0) {
            capSc._interceptorServeLimitByte = capLimitByte;
            // Use the global average bitrate for pacing. The local-sample bitrate
            // was an attempt to handle VBR segments, but it was based on the
            // IOController download byte, which can be far ahead of the actual
            // SourceBuffer end. That produced absurd rates (e.g., 6 GB/s) and
            // let the buffer overshoot. The average bitrate is what the player
            // actually consumes over time, so pacing at this rate keeps the
            // buffer steady on average. lazyLoadMaxDuration still acts as the hard
            // ceiling above 120 s.
            const bitrate = capDuration > 0 && capFileLength > 0 ? capFileLength / capDuration : 0;
            // Pacing only applies beyond the serve limit. When ahead is below target,
            // requests are before the limit → full speed. When ahead is above target,
            // pace at or slightly below consumption to drain the excess.
            if (ahead > QUOTA_KEEP_AHEAD) {
              capSc._pacingBps = bitrate * currentRate * 0.95;
            } else if (ahead > QUOTA_KEEP_AHEAD * 0.75) {
              capSc._pacingBps = bitrate * currentRate * 1.0;
            } else {
              capSc._pacingBps = 0;
            }
          }
        }

        // ── HEAVY DEBUG: periodic state dump every ~5s ──
        // Logs download state, buffer state, shadow cache state
        const now = performance.now();
        if (!(sourceBufferQuotaGuard as any)._lastDump || now - (sourceBufferQuotaGuard as any)._lastDump > 5000) {
          (sourceBufferQuotaGuard as any)._lastDump = now;
          const cache = shadowCacheRef.current;
          const cacheRanges: Array<{start: number, end: number}> = cache ? cache.entryRanges ?? [] : [];
          const cacheBytes = cacheRanges.reduce((sum: number, r: {start: number, end: number}) => sum + (r.end - r.start), 0);
          diagLog(`[MPEGTS-STATE] ct=${curTime.toFixed(1)}s bufEnd=${bufEnd.toFixed(1)}s ahead=${ahead.toFixed(1)}s totalBuf=${totalBuffered.toFixed(1)}s paused=${isPaused} bufFull=${isBufferFull} _resumeFrom=${resumeFrom} cacheBytes=${(cacheBytes/1048576).toFixed(1)}MB cacheRanges=${cacheRanges.length} aggressive=${_aggressiveCleanupActive} removeInProgress=${_removeInProgress} indepPrebuf=${independentPrebufferRef.current.active ? `${(independentPrebufferRef.current.downloadedBytes/1048576).toFixed(1)}MB` : 'off'}`);
        }

        // ── Proactive disk prebuffer: report playback position to Rust backend ──
        // Every 10s, tell the backend where we're watching so it can proactively
        // download ahead to disk cache. When lazyLoad resumes, the /stream endpoint
        // serves from cache (CACHE-PREFIX) instead of fetching from Telegram.
        // NOTE: We do NOT gate on !video.paused — the green bar (disk cache) should
        // keep downloading to completion even when the video is paused. Only the
        // white bar (IOController) stops when paused; the proactive prebuffer runs
        // independently as a background task.
        if (knownDuration && knownFilesize) {
          const _now = Date.now();
          if (!(sourceBufferQuotaGuard as any)._lastProactiveReport || _now - (sourceBufferQuotaGuard as any)._lastProactiveReport > 10000) {
            (sourceBufferQuotaGuard as any)._lastProactiveReport = _now;
            // isPlayerDownloading: ALWAYS false now — the /stream endpoint only reads
            // from disk cache (never downloads from Telegram). The proactive prebuffer
            // is the sole Telegram downloader, so it always uses parallel pool.
            const isPlayerDownloading = false;
            diagLog(`[PROACTIVE] Reporting position: msg=${parsed.messageId} folder=${parsed.folderId} ct=${curTime.toFixed(1)}s dur=${knownDuration.toFixed(1)}s size=${knownFilesize} isPlayerDownloading=${isPlayerDownloading}`);
            invoke('cmd_report_playback_position', {
              messageId: parseInt(parsed.messageId),
              folderId: parseInt(parsed.folderId),
              currentTimeS: curTime,
              durationS: knownDuration,
              fileSize: knownFilesize,
              isPlayerDownloading,
              playbackRate: video.playbackRate || 1,
            }).then((spawned: any) => {
              if (spawned) {
                proactivePrebufferMsgIdRef.current = parseInt(parsed.messageId);
                diagLog(`[PROACTIVE] Spawned disk prebuffer for msg ${parsed.messageId} at ct=${curTime.toFixed(1)}s`);
              }
            }).catch((e: any) => {
              // Log errors — critical for debugging proactive prebuffer
              console.error(`[PROACTIVE] cmd_report_playback_position FAILED:`, e);
            });
          }
        }

        // ── Evict when SourceBuffer is full OR when the ahead cap is exceeded ──
        // If we only react to BUFFER_FULL, the browser silently evicts from the
        // beginning first, making the white bar shrink from the left. Evict the
        // ahead tail proactively before the browser has to.
        const needsEviction = isBufferFull || (ahead > QUOTA_KEEP_AHEAD + 10);

        if (needsEviction) {
          // ── Under quota pressure OR BUFFER_FULL ──
          _aggressiveCleanupActive = true;
          (window as any).__nobuf_quotaGuardAggressive = true;
          // Throttle eviction-needed log to once per 5s to avoid console spam
          const now = Date.now();
          if (!(sourceBufferQuotaGuard as any)._lastEvictionLog || now - (sourceBufferQuotaGuard as any)._lastEvictionLog > 5000) {
            (sourceBufferQuotaGuard as any)._lastEvictionLog = now;
            diagLog(`[MPEGTS-QUOTA] EVICTION NEEDED: ct=${curTime.toFixed(1)}s totalBuf=${totalBuffered.toFixed(1)}s ahead=${ahead.toFixed(1)}s isBufferFull=${isBufferFull} isPaused=${isPaused} _resumeFrom=${resumeFrom}`);
          }

          // Skip eviction if a remove is already in progress
          if (_removeInProgress) return;

          // Cancel independent prebuffer during BUFFER_FULL handling
          if (independentPrebufferRef.current.active && independentPrebufferRef.current.abortController) {
            independentPrebufferRef.current.abortController.abort();
            independentPrebufferRef.current.active = false;
          }

          // High-bitrate fallback: if the full 180s/60s window exceeds the browser's
          // likely MSE budget, keep 180s ahead and shrink the behind window first.
          let effectiveKeepBehind = fallbackBehindRef.current;
          if (globalBitrateBps > 0) {
            const totalWindowSeconds = QUOTA_KEEP_AHEAD + QUOTA_KEEP_BEHIND; // 240
            const totalWindowBytes = totalWindowSeconds * globalBitrateBps;
            if (totalWindowBytes > SAFE_SOURCE_BUFFER_BUDGET_BYTES) {
              const aheadBytes = QUOTA_KEEP_AHEAD * globalBitrateBps;
              const remainingBudget = Math.max(0, SAFE_SOURCE_BUFFER_BUDGET_BYTES - aheadBytes);
              const maxBehindSeconds = Math.floor(remainingBudget / globalBitrateBps);
              if (maxBehindSeconds < 60) {
                effectiveKeepBehind = Math.max(15, Math.min(30, maxBehindSeconds)); // 60 → 30 → 15
              }
              if (effectiveKeepBehind !== fallbackBehindRef.current) {
                diagLog(`[MPEGTS] High-bitrate fallback: behind window ${fallbackBehindRef.current}s → ${effectiveKeepBehind}s (bitrate ${(globalBitrateBps/8/1024).toFixed(1)} KB/s)`);
              }
            }
          }
          fallbackBehindRef.current = effectiveKeepBehind;

          // 1. Evict data outside the desired [curTime - effectiveKeepBehind, curTime + 180] window.
          //    Preserve 180s ahead and effectiveKeepBehind behind. Clamp behind edge to 0 at startup.
          const evictBefore = Math.max(0, curTime - effectiveKeepBehind);  // keep effective behind
          const evictAfter = curTime + QUOTA_KEEP_AHEAD;                  // keep 180s ahead
          // Get SourceBuffers via standard MSE API.
          // mpegts.js MSEController._sourceBuffers is {video: sb, audio: sb} object NOT array!
          // The correct path is getObject() → MediaSource → sourceBuffers (SourceBufferList).
          const ms = mseCtrl?.getObject?.();
          const sourceBuffers = ms?.sourceBuffers;
          let evicted = false;
          // If a previous sb.remove() is still in progress, DON'T start another one.
          // MSE only allows ONE remove() at a time — queuing multiple causes updating=true deadlock.
          if (_removeInProgress || (window as any).__nobuf_removeInProgress) {
            // Already evicting — skip this tick, wait for updateend callback
          } else if (sourceBuffers && sourceBuffers.length > 0) {
            // Log SourceBuffer state for debugging eviction failures
            const sbuf0 = sourceBuffers[0];
            const sbUpdating = sbuf0?.updating ?? false;
            const sbBufferedLen = sbuf0?.buffered?.length ?? 0;
            const sbStart = sbBufferedLen > 0 ? sbuf0.buffered.start(0).toFixed(1) : 'none';
            const sbEnd = sbBufferedLen > 0 ? sbuf0.buffered.end(sbBufferedLen - 1).toFixed(1) : 'none';
            // Log once per aggressive cycle
            if (!(sourceBufferQuotaGuard as any)._loggedSbState) {
              (sourceBufferQuotaGuard as any)._loggedSbState = true;
              diagLog(`[MPEGTS-QUOTA] SourceBuffer[0]: updating=${sbUpdating}, buffered=${sbBufferedLen}, range=${sbStart}-${sbEnd}`);
            }

          // _evictNewSbEnd: deterministic new SB-end after eviction completes.
          // Calculated at eviction time (before remove() call) so onEvictDone
          // doesn't rely on video.buffered which may be stale when the callback fires.
          let _evictNewSbEnd: number | null = null;
          for (let i = 0; i < sourceBuffers.length; i++) {
              const sbuf = sourceBuffers[i];
              if (!sbuf.updating && sbuf.buffered.length > 0) {
                // ── EVICT AHEAD TAIL FIRST ──
                // When BUFFER_FULL fires, the ahead tail is where almost ALL
                // the data lives (playhead near start of buffer, 274s ahead).
                // Backward eviction frees only ~2s (pointless). Ahead-tail
                // eviction frees 150s+ (actually makes room).
                // MSE only allows one remove() per SB at a time, so we must
                // choose: ahead-tail (big win) over backward (tiny win).
                if (sbuf.buffered.end(sbuf.buffered.length - 1) > evictAfter) {
                  try {
                    _removeInProgress = true;
                    (window as any).__nobuf_removeInProgress = true;
                    const aheadEnd = sbuf.buffered.end(sbuf.buffered.length - 1);
                    diagLog(`[MPEGTS-QUOTA] Evicting ahead tail: [${evictAfter.toFixed(1)}, ${aheadEnd.toFixed(1)})`);
                    // After remove(evictAfter, aheadEnd), the new SB end = evictAfter.
                    // Store this deterministically so onEvictDone doesn't read stale video.buffered.
                    _evictNewSbEnd = evictAfter;
                    sbuf.remove(evictAfter, aheadEnd);
                    evicted = true;
                    // After remove(), sbuf.updating=true — can't do another remove on this SB.
                    // Backward eviction will happen on the next guard tick after updateend.
                    continue;
                  } catch (e: any) { _removeInProgress = false; (window as any).__nobuf_removeInProgress = false; diagLog(`[MPEGTS-QUOTA] Ahead tail eviction FAILED: ${e.message}`); }
                }
                // ── Backward eviction (only if no ahead-tail was needed) ──
                // MSE remove(start, end) removes all data in [start, end) regardless of
                // how many individual buffered ranges exist — no need to iterate.
                if (evictBefore > 0 && sbuf.buffered.start(0) < evictBefore) {
                  try {
                    _removeInProgress = true;
                    (window as any).__nobuf_removeInProgress = true;
                    diagLog(`[MPEGTS-QUOTA] Evicting backward: [0, ${evictBefore.toFixed(1)})`);
                    // Backward eviction: SB end doesn't change. Store current SB end
                    // deterministically so onEvictDone doesn't read stale video.buffered.
                    _evictNewSbEnd = sbuf.buffered.end(sbuf.buffered.length - 1);
                    sbuf.remove(0, evictBefore);
                    evicted = true;
                    continue;
                  } catch (e: any) { _removeInProgress = false; (window as any).__nobuf_removeInProgress = false; diagLog(`[MPEGTS-QUOTA] Backward eviction FAILED: ${e.message}`); }
                }
              } else if (sbuf.updating) {
                // SourceBuffer stuck updating after BUFFER_FULL — can't evict yet.
                // Log this once per aggressive cycle to avoid spam.
                if (!(sourceBufferQuotaGuard as any)._loggedStuckUpdating) {
                  (sourceBufferQuotaGuard as any)._loggedStuckUpdating = true;
                  diagLog(`[MPEGTS-QUOTA] SourceBuffer STUCK updating=true (sbuf[${i}]: buffered=${sbuf.buffered?.length}, range=${sbStart}-${sbEnd}) — cannot evict, waiting for updateend`);
                }
              }
            }
            // After eviction, listen for the last SourceBuffer's updateend
            // to know when space is freed, then resume download.
            if (evicted && _removeInProgress) {
              const lastSbuf = sourceBuffers[sourceBuffers.length - 1];
              let evictSafetyFired = false;
              let evictSafetyTimer: ReturnType<typeof setTimeout> | null = null;
              const onEvictDone = () => {
                if (evictSafetyFired) return;  // guard against double-fire (updateend + safety timeout)
                evictSafetyFired = true;
                if (evictSafetyTimer) { clearTimeout(evictSafetyTimer); evictSafetyTimer = null; }
                lastSbuf.removeEventListener('updateend', onEvictDone);
                lastSbuf.removeEventListener('error', onEvictDone);
                _removeInProgress = false;
                (window as any).__nobuf_removeInProgress = false;
                if (mseCtrl?._isBufferFull) mseCtrl._isBufferFull = false;
                (window as any).__nobuf_bufferFullDetected = false;

                // Update _resumeFrom to the byte position corresponding to the new SB-end
                // after eviction, then call resumeTransmuxer() which triggers _internalSeek(_resumeFrom).
                // This ensures the reconnect goes through the proper mpegts.js flow,
                // which handles insertDiscontinuity() correctly.
                // Use _evictNewSbEnd (captured at eviction time) instead of video.buffered
                // because onEvictDone may fire from a safety timeout or wrong updateend
                // BEFORE the eviction remove() completes, at which point video.buffered
                // still shows the pre-eviction range.
                const sbEndNow = _evictNewSbEnd != null ? _evictNewSbEnd : (video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0);
                const lc2 = (player as any)?._player_engine?._loading_controller;
                const ioCtrl2 = (player as any)?._player_engine?._transmuxer?._controller?._ioctl;

                if (sbEndNow > 0 && ioCtrl2) {
                  const dur = mpegtsDurationRef.current || (window as any).__nobuf_ptsDuration || 0;
                  const fLen = state.current.fileLength || 0;
                  if (dur > 0 && fLen > 0) {
                    const targetTime = Math.max(0, sbEndNow - AUDIO_SAFETY_MARGIN);
                    // Use observed byte-to-time samples if available; global linear mapping is wrong for VBR
                    const rawByte = findByteForTime(targetTime, byteTimeSamplesRef.current, dur, fLen);
                    const alignedByte = alignToTSSyncByte(rawByte, shadowCacheRef.current);
                    if (alignedByte > 0) {
                      // Store the correct byte position for the patched resumeTransmuxer.
                      // The eviction resume path sets ioCtrl._resumeFrom = resumeByte
                      // and calls origResume(), which does _internalSeek(resumeByte).
                      ioCtrl2._resumeFrom = alignedByte;
                      (window as any).__nobuf_evictionResumeByte = alignedByte;
                      diagLog(`[MPEGTS-QUOTA] onEvictDone: _resumeFrom=${alignedByte} (target=${targetTime.toFixed(1)}s, SB-end=${sbEndNow.toFixed(1)}s, deterministic=${_evictNewSbEnd != null}, samples=${byteTimeSamplesRef.current.length}) — resumeTransmuxer will seek to this position`);
                    }
                  }
                }

                // Resume download via the patched resumeTransmuxer only if the loader is
                // actually paused. After a seek the IOController may already be running,
                // in which case calling resumeTransmuxer() is a no-op that still triggers
                // insertDiscontinuity() + demuxer reset and can corrupt the pipeline.
                if (lc2 && (lc2._paused || ioCtrl2?._paused)) {
                  try {
                    (window as any).__nobuf_evictionResumePending = true;
                    // Authorize resume (gate checked by outer resumeTransmuxer wrapper)
                    if (lc2?._config) lc2._config.__nobuf_resumeAuthorized = true;
                    lc2.resumeTransmuxer();
                  } catch (e: any) {
                    diagLog(`[MPEGTS-QUOTA] onEvictDone resumeTransmuxer failed: ${e.message}`);
                  }
                } else {
                  diagLog(`[MPEGTS-QUOTA] onEvictDone: loader not paused, skipping resume`);
                }

                // Clear aggressive flag if eviction brought us below danger threshold
                const sb2 = video.buffered;
                let totalBuf2 = 0;
                if (sb2 && sb2.length > 0) {
                  for (let j = 0; j < sb2.length; j++) {
                    totalBuf2 += sb2.end(j) - sb2.start(j);
                  }
                }
                const ahead2 = sb2 && sb2.length > 0 ? sb2.end(sb2.length - 1) - video.currentTime : 0;
                if (ahead2 < QUOTA_DANGER_DURATION || totalBuf2 < QUOTA_DANGER_DURATION) {
                  _aggressiveCleanupActive = false;
                  (window as any).__nobuf_quotaGuardAggressive = false;
                }
              };
              lastSbuf.addEventListener('updateend', onEvictDone);
              lastSbuf.addEventListener('error', onEvictDone);
              // Safety timeout: if updateend never fires (browser bug), clear flags
              // after 2s so _removeInProgress doesn't block all future evictions.
              evictSafetyTimer = setTimeout(() => {
                if (!evictSafetyFired) {
                  diagLog('[MPEGTS-QUOTA] onEvictDone SAFETY TIMEOUT — updateend never fired, clearing flags');
                  onEvictDone();
                }
              }, 2000);
            }
          }

          // If we still hit QuotaExceededError, aggressively shrink behind further.
          if (isBufferFull) {
            const nextBehind = effectiveKeepBehind > 30 ? 30 : (effectiveKeepBehind > 15 ? 15 : 0);
            if (nextBehind < effectiveKeepBehind) {
              diagLog(`[MPEGTS] QuotaExceededError fallback: shrink behind ${effectiveKeepBehind}s → ${nextBehind}s`);
              fallbackBehindRef.current = nextBehind;
            }
          }

          // 2. At t=0 (or early playback), there's nothing behind to evict.
          //    But we CAN evict the far-ahead tail (keep 120s ahead).
          //    If no eviction happened at all (nothing to evict), don't resume —
          //    mpegts.js will immediately re-suspend on BUFFER_FULL.
          //    The video continues playing from already-buffered data.

        } else {
          // ── Quota pressure relieved ──

          if (_aggressiveCleanupActive && !isBufferFull && ahead < QUOTA_DANGER_DURATION) {
            _aggressiveCleanupActive = false;
            (window as any).__nobuf_quotaGuardAggressive = false;
            (sourceBufferQuotaGuard as any)._loggedStuckUpdating = false;
            (sourceBufferQuotaGuard as any)._loggedSbState = false;
            diagLog(`[MPEGTS-QUOTA] Aggressive cleanup CLEARED: ahead=${ahead.toFixed(1)}s < ${QUOTA_DANGER_DURATION}s, bufFull=${isBufferFull}`);
          }

          // ── SAFE RESUME FROM QUOTA GUARD (lazyLoad pause) ──
          // The old auto-resume fought with lazyLoad: guard resumed → lazyLoad
          // immediately re-suspended → _resumeFrom corrupted → byte-0 fetch →
          // all audio dropped. That happened because the guard resumed when
          // ahead >= lazyLoadMaxDuration, so lazyLoad immediately re-suspended.
          //
          // SAFE condition: resume ONLY when ahead < lazyLoadMaxDuration.
          // At this point lazyLoad's own check (ahead >= lazyLoadMaxDuration)
          // is FALSE, so it won't re-suspend. The resume sticks.
          //
          // Why the guard resumes instead of waiting for lazyLoad's native
          // _resumeTransmuxerIfNeeded: lazyLoad's native resume fires when
          // ahead < lazyLoadRecoverDuration (60s). With suspend at ahead≈115s
          // and resume at ahead<60s, that's 55 seconds of frozen bars — the
          // user sees both download and buffer bars stuck. The guard resumes
          // earlier (ahead<90s) to reduce the gap to ~25s.
          if (isPaused && !isBufferFull) {
            const lazyLoadMax = lc?._config?.lazyLoadMaxDuration ?? 120;

            // ── PROGRESSIVE RESUME: resume immediately with pacing ──
            // When the download is paused by lazyLoad, we used to wait 30s for
            // ahead to drain below 90s before resuming. This caused the white bar
            // to freeze. Now, we resume IMMEDIATELY with pacing, which controls
            // data flow at ~1× consumption rate. The buffer stays at its current
            // level and the white bar never freezes.
            //
            // Pacing is computed in the interceptor from _pacingBps on the shadow
            // cache. We set _pacingBps here based on current buffer state:
            //   - ahead close to target: 1× rate (maintain)
            //   - ahead above target: 1× rate (consumption will bring it down)
            //   - ahead below target: faster rate (build buffer)
            const _scPacing = shadowCacheRef.current;
            if (_scPacing && _scPacing._playerElement && _scPacing._duration > 0 && (state.current.fileLength || 0) > 0) {
              // ── Pacing-aware guard: do not resume immediately at the ceiling ──
              // Without this guard, removing the lazyLoad suppression causes the
              // progressive resume to wake the IOController every tick while the
              // buffer is still above lazyLoadMax - 10s. lazyLoad then suspends
              // again, and we get a tight resume/suspend fight. Wait until the
              // buffer drains a small margin below the ceiling before resuming with
              // pacing. The continuous cap keeps the serve limit/pacing updated
              // while we wait.
              const resumeThreshold = Math.max(15, lazyLoadMax - 10);
              if (ahead >= resumeThreshold) {
                const now = Date.now();
                const lastNearCeilingLog = (sourceBufferQuotaGuard as any).__nobuf_lastNearCeilingLogTs || 0;
                if (now - lastNearCeilingLog > 5000) {
                  diagLog(`[MPEGTS-QUOTA] PROGRESSIVE-RESUME: deferring (ahead=${ahead.toFixed(1)}s >= ${resumeThreshold}s threshold) — let lazyLoad drain`);
                  (sourceBufferQuotaGuard as any).__nobuf_lastNearCeilingLogTs = now;
                }
              } else {
              const bitrate = (state.current.fileLength || 0) / _scPacing._duration;
              const rate = video.playbackRate || 1;
              // Pacing multiplier: 1× maintains current buffer, slightly above
              // to compensate for demuxing overhead and chunk alignment drift.
              // When ahead is well below target, use higher rate to build buffer.
              const targetAhead = lazyLoadMax * 0.9;  // 90% of lazyLoadMax
              let pacingMult = 1.05;  // default: slight surplus
              if (ahead < targetAhead * 0.5) {
                pacingMult = 3.0;  // far below target: fast fill
              } else if (ahead < targetAhead * 0.75) {
                pacingMult = 2.0;  // below target: moderate fill
              } else if (ahead < targetAhead) {
                pacingMult = 1.5;  // close to target: slow fill
              }
              _scPacing._pacingBps = bitrate * rate * pacingMult;

              // Cancel independent prebuffer — IOController is resuming
              if (independentPrebufferRef.current.active && independentPrebufferRef.current.abortController) {
                diagLog(`[INDEPENDENT-PREBUFFER] Cancelling (downloaded ${independentPrebufferRef.current.downloadedBytes} bytes) — progressive resume`);
                independentPrebufferRef.current.abortController.abort();
                independentPrebufferRef.current.active = false;
                independentPrebufferRef.current.abortController = null;
              }

              diagLog(`[MPEGTS-QUOTA] PROGRESSIVE-RESUME: ahead=${ahead.toFixed(1)}s, pacing=${(_scPacing._pacingBps/1048576).toFixed(2)}MB/s (${pacingMult}×) — continuous flow, no freeze`);

              // Authorize resume (gate checked by outer resumeTransmuxer wrapper)
              if (lc?._config) lc._config.__nobuf_resumeAuthorized = true;
              const ioCtrlPreResume = engine._transmuxer?._controller?._ioctl;
              const preResumeFrom = ioCtrlPreResume?._resumeFrom ?? -1;

              // Set interceptor serve limit BEFORE resumeTransmuxer
              const _scSafePre = shadowCacheRef.current;
              if (_scSafePre) {
                const bytesPerSecondPre = (state.current.fileLength || 0) / (state.current.duration || 1);
                const MAX_SERVE_AHEAD_SECONDS_SAFE = 180;
                const targetAheadPre = Math.min(lazyLoadMax, MAX_SERVE_AHEAD_SECONDS_SAFE);
                const limitTimePre = (engine._media_element?.currentTime ?? 0) + targetAheadPre;
                const limitBytePre = Math.floor(limitTimePre * bytesPerSecondPre);
                _scSafePre._interceptorServeLimitByte = limitBytePre;
                _scSafePre._lazyLoadMax = targetAheadPre;
                _scSafePre._interceptorPauseUntil = 0;
              }

              lc.resumeTransmuxer();

              // Defensive re-check: immediate re-suspend corruption guard
              if (lc._paused === true && preResumeFrom > 0) {
                const ioCtrlPostResume = engine._transmuxer?._controller?._ioctl;
                const corruptedResumeFrom = ioCtrlPostResume?._resumeFrom ?? -1;
                if (ioCtrlPostResume && (corruptedResumeFrom === 0 || corruptedResumeFrom === -1)) {
                  const correctedByte = alignToTSSyncByte(preResumeFrom, shadowCacheRef.current);
                  ioCtrlPostResume._resumeFrom = correctedByte;
                  diagLog(`[MPEGTS-QUOTA] PROGRESSIVE-RESUME: immediate re-suspend detected! _resumeFrom restored to ${correctedByte}`);
                }
              }
            }
            } else {
              // ── Fallback: no pacing available (missing player/duration data) ──
              // Use the old safe-resume logic with drain wait.
              const safeResumeAhead = Math.min(lazyLoadMax - 30, 90);
              const SAFE_RESUME_COOLDOWN_MS = 5000;
              const lastSafeResumeTime = (sourceBufferQuotaGuard as any)._lastSafeResumeTime || 0;
              const safeResumeOnCooldown = (Date.now() - lastSafeResumeTime) < SAFE_RESUME_COOLDOWN_MS;

              // Safety net: if buffer critically low, resume regardless.
              if (ahead < 15) {
                if (safeResumeOnCooldown) {
                diagLog(`[MPEGTS-QUOTA] CRITICAL: ahead=${ahead.toFixed(1)}s < 15s but safe-resume COOLDOWN active (${((SAFE_RESUME_COOLDOWN_MS - (Date.now() - lastSafeResumeTime)) / 1000).toFixed(1)}s remaining) — deferring to lazyLoad`);
              } else {
              // Cancel independent prebuffer — IOController is resuming
              if (independentPrebufferRef.current.active && independentPrebufferRef.current.abortController) {
                diagLog(`[INDEPENDENT-PREBUFFER] Cancelling (downloaded ${independentPrebufferRef.current.downloadedBytes} bytes) — IOController resuming (emergency)`);
                independentPrebufferRef.current.abortController.abort();
                independentPrebufferRef.current.active = false;
                independentPrebufferRef.current.abortController = null;
              }
              diagLog(`[MPEGTS-QUOTA] CRITICAL: ahead=${ahead.toFixed(1)}s < 15s — emergency resume`);
              // Authorize resume (gate checked by outer resumeTransmuxer wrapper)
              if (lc?._config) lc._config.__nobuf_resumeAuthorized = true;
              // ── Save _resumeFrom before resume, defend against immediate re-suspend ──
              const ioCtrlPreResume = engine._transmuxer?._controller?._ioctl;
              const preResumeFrom = ioCtrlPreResume?._resumeFrom ?? -1;
              (sourceBufferQuotaGuard as any)._lastSafeResumeTime = Date.now();
              // ── Set interceptor serve limit BEFORE resumeTransmuxer ──
              // Same race condition as safe-resume: fetch() is called synchronously
              // inside resumeTransmuxer(), so the limit must be set before.
              const _scEmergencyPre = shadowCacheRef.current;
              if (_scEmergencyPre) {
                const bytesPerSecondEmerg = (state.current.fileLength || 0) / (state.current.duration || 1);
                const MAX_SERVE_AHEAD_SECONDS_EMERG = 180;
                const targetAheadEmerg = Math.min(lc?._config?.lazyLoadMaxDuration ?? 120, MAX_SERVE_AHEAD_SECONDS_EMERG);
                const limitTimeEmerg = (engine._media_element?.currentTime ?? 0) + targetAheadEmerg;
                const limitByteEmerg = Math.floor(limitTimeEmerg * bytesPerSecondEmerg);
                _scEmergencyPre._interceptorServeLimitByte = limitByteEmerg;
                _scEmergencyPre._lazyLoadMax = targetAheadEmerg;
                _scEmergencyPre._interceptorPauseUntil = 0;
                diagLog(`[MPEGTS-QUOTA] EMERGENCY-RESUME: set interceptor serve limit byte=${limitByteEmerg} (ct+${targetAheadEmerg}s=${limitTimeEmerg.toFixed(1)}s) BEFORE resumeTransmuxer`);
              }
              lc.resumeTransmuxer();
              // Defensive re-check: cache-served data can push buffer past lazyLoadMax
              // within one tick, causing an immediate re-suspend. IOController.pause()
              // then computes _resumeFrom = _currentRange.to + 1 = 0 (corruption).
              if (lc._paused === true && preResumeFrom > 0) {
                const ioCtrlPostResume = engine._transmuxer?._controller?._ioctl;
                const corruptedResumeFrom = ioCtrlPostResume?._resumeFrom ?? -1;
                if (ioCtrlPostResume && (corruptedResumeFrom === 0 || corruptedResumeFrom === -1)) {
                  const correctedByte = alignToTSSyncByte(preResumeFrom, shadowCacheRef.current);
                  ioCtrlPostResume._resumeFrom = correctedByte;
                  diagLog(`[MPEGTS-QUOTA] EMERGENCY-RESUME: immediate re-suspend detected! _resumeFrom corrupted (${corruptedResumeFrom}) — RESTORED to ${correctedByte} (pre-resume value=${preResumeFrom})`);
                }
              }
              }
            } else if (ahead < safeResumeAhead) {
              if (safeResumeOnCooldown) {
                // On cooldown — don't resume. LazyLoad's natural mechanism will
                // handle the resume when the buffer drops below lazyLoadRecoverDuration.
                const lastLazyLog = (window as any).__nobuf_lastLazyLogTs || 0;
                const now = Date.now();
                if (now - lastLazyLog > 5000) {
                  diagLog(`[MPEGTS-QUOTA] SAFE-RESUME on COOLDOWN: ahead=${ahead.toFixed(1)}s < ${safeResumeAhead}s but cooldown active (${((SAFE_RESUME_COOLDOWN_MS - (now - lastSafeResumeTime)) / 1000).toFixed(1)}s remaining) — deferring to lazyLoad`);
                  (window as any).__nobuf_lastLazyLogTs = now;
                }
              } else {
              // SAFE: ahead < lazyLoadMaxDuration → lazyLoad won't re-suspend
              // Cancel independent prebuffer — IOController is resuming
              if (independentPrebufferRef.current.active && independentPrebufferRef.current.abortController) {
                diagLog(`[INDEPENDENT-PREBUFFER] Cancelling (downloaded ${independentPrebufferRef.current.downloadedBytes} bytes) — IOController resuming`);
                independentPrebufferRef.current.abortController.abort();
                independentPrebufferRef.current.active = false;
                independentPrebufferRef.current.abortController = null;
              }
              diagLog(`[MPEGTS-QUOTA] SAFE-RESUME: ahead=${ahead.toFixed(1)}s < ${safeResumeAhead}s threshold (lazyLoadMax=${lazyLoadMax}). Download resuming — lazyLoad won't re-suspend.`);
              // Authorize resume (gate checked by outer resumeTransmuxer wrapper)
              if (lc?._config) lc._config.__nobuf_resumeAuthorized = true;
              // ── Save _resumeFrom before resume, defend against immediate re-suspend ──
              // The log says "lazyLoad won't re-suspend" but that's WRONG when cache-served
              // data fills the buffer past lazyLoadMax within one tick. The shadow cache
              // interceptor can feed chunks synchronously during _internalSeek, pushing
              // ahead past lazyLoadMax before our tick ends.
              const ioCtrlPreResume = engine._transmuxer?._controller?._ioctl;
              const preResumeFrom = ioCtrlPreResume?._resumeFrom ?? -1;
              (sourceBufferQuotaGuard as any)._lastSafeResumeTime = Date.now();
              // ── Set interceptor serve limit BEFORE resumeTransmuxer ──
              // CRITICAL: resumeTransmuxer() synchronously calls IOController.resume()
              // → _internalSeek(_resumeFrom) → fetch(url, {headers: Range}) → interceptor
              // runs synchronously inside fetch(). If the serve limit is set AFTER
              // resumeTransmuxer(), the interceptor sees _interceptorServeLimitByte=0
              // during the first fetch and serves ALL prebuffered data at once → bufEnd
              // jumps 38+s → infinite loop.
              const _scSafePre = shadowCacheRef.current;
              if (_scSafePre) {
                const bytesPerSecondPre = (state.current.fileLength || 0) / (state.current.duration || 1);
                const MAX_SERVE_AHEAD_SECONDS_SAFE = 180;
                const targetAheadPre = Math.min(lazyLoadMax, MAX_SERVE_AHEAD_SECONDS_SAFE);
                const limitTimePre = (engine._media_element?.currentTime ?? 0) + targetAheadPre;
                const limitBytePre = Math.floor(limitTimePre * bytesPerSecondPre);
                _scSafePre._interceptorServeLimitByte = limitBytePre;
                _scSafePre._lazyLoadMax = targetAheadPre;
                _scSafePre._interceptorPauseUntil = 0; // clear old pause — serve limit replaces it
                diagLog(`[MPEGTS-QUOTA] SAFE-RESUME: set interceptor serve limit byte=${limitBytePre} (ct+${targetAheadPre}s=${limitTimePre.toFixed(1)}s) BEFORE resumeTransmuxer`);
              }
              lc.resumeTransmuxer();
              // ── Post-resume: re-verify serve limit (ct may have advanced slightly) ──
              // ct doesn't advance during synchronous resumeTransmuxer, so the limit
              // computed above is still correct. No need to update.
              // Defensive re-check: if the player is immediately paused again
              // (lc._paused becomes true), the correct _resumeFrom was the pre-resume
              // value. IOController.pause() will have corrupted it to 0.
              if (lc._paused === true && preResumeFrom > 0) {
                const ioCtrlPostResume = engine._transmuxer?._controller?._ioctl;
                const corruptedResumeFrom = ioCtrlPostResume?._resumeFrom ?? -1;
                if (ioCtrlPostResume && (corruptedResumeFrom === 0 || corruptedResumeFrom === -1)) {
                  const correctedByte = alignToTSSyncByte(preResumeFrom, shadowCacheRef.current);
                  ioCtrlPostResume._resumeFrom = correctedByte;
                  diagLog(`[MPEGTS-QUOTA] SAFE-RESUME: immediate re-suspend detected! _resumeFrom corrupted (${corruptedResumeFrom}) — RESTORED to ${correctedByte} (pre-resume value=${preResumeFrom})`);
                }
              }
              }
            } else {
              // Not safe to resume yet — lazyLoad would immediately re-suspend.
              // Throttle logging to once per 5s.
              const lastLazyLog = (window as any).__nobuf_lastLazyLogTs || 0;
              const now = Date.now();
              if (now - lastLazyLog > 5000) {
                diagLog(`[MPEGTS-QUOTA] Download PAUSED by lazyLoad (ahead=${ahead.toFixed(1)}s) — will safe-resume when ahead < ${safeResumeAhead}s (lazyLoadMax=${lazyLoadMax})`);
                (window as any).__nobuf_lastLazyLogTs = now;
              }

              // ── INDEPENDENT PREBUFFER: continue downloading to shadow cache ──
              // When lazyLoad pauses the IOController, the shadow cache stops growing
              // because it's a passive observer. Start an independent fetch to continue
              // filling the shadow cache — the green bar reflects cache growth.
              // The fetch interceptor (forwardAndSiphon) automatically stores chunks.
              // SKIP if shadow cache is already ≥90% full — starting would immediately
              // stop, then restart on the next tick → thrashing (start/stop loops).
              const _scForPrebuf = shadowCacheRef.current;
              const _scStats = _scForPrebuf?.getStats();
              // If getStats() returns null (shouldn't happen), assume NOT full to avoid
              // blocking prebuffer on stats failure. The inner loop still checks per-chunk.
              const _scFull = _scStats ? _scStats.totalMB >= _scStats.maxMB * 0.9 : false;
              // Cooldown: if prebuffer recently stopped because cache was full, don't restart
              // for 60s — prevents start/stop thrashing when cache hovers at 90%+.
              const _prebufCooldown = Date.now() - independentPrebufferRef.current.lastCacheFullTime < 60000;
              if (!independentPrebufferRef.current.active && !_scFull && !_prebufCooldown) {
                const ioCtrl = engine._transmuxer?._controller?._ioctl;
                const resumeFromByte = ioCtrl?._resumeFrom ?? -1;
                const currentRangeTo = ioCtrl?._currentRange?.to ?? -1;
                // Prefer the shadow cache's furthest contiguous byte over the
                // IOController's _resumeFrom — avoids re-downloading bytes the
                // cache already has (e.g., cache ends at 97.5MB but _resumeFrom
                // is 96.9MB → start from 97.5MB instead of re-fetching 0.6MB).
                const cacheEndByte = shadowCacheRef.current
                  ? shadowCacheRef.current.cachedUpTo(resumeFromByte >= 0 ? resumeFromByte : 0)
                  : -1;
                let startByte: number;
                if (cacheEndByte >= 0 && cacheEndByte > resumeFromByte) {
                  startByte = cacheEndByte + 1;  // +1: cachedUpTo returns inclusive end
                } else {
                  startByte = resumeFromByte >= 0 ? resumeFromByte : (currentRangeTo >= 0 ? currentRangeTo + 1 : -1);
                }

                if (startByte >= 0 && startByte < (state.current.fileLength || 0)) {
                  // Align to 188-byte TS packet boundary and verify 0x47 sync byte
                  const alignedStart = alignToTSSyncByte(startByte, shadowCacheRef.current);
                  const abortCtrl = new AbortController();
                  independentPrebufferRef.current = {
                    abortController: abortCtrl,
                    active: true,
                    startByte: alignedStart,
                    downloadedBytes: 0,
                    lastCacheFullTime: 0,
                  };

                  // Cap the prebuffer download to PREBUFFER_CAP_BYTES so we don't download
                  // the entire remainder of the file (which evicts all cache entries and crashes).
                  const fileLen = state.current.fileLength || 0;
                  const endByte = Math.min(alignedStart + PREBUFFER_CAP_BYTES, fileLen > 0 ? fileLen - 1 : alignedStart + PREBUFFER_CAP_BYTES);

                  diagLog(`[INDEPENDENT-PREBUFFER] Starting: byte=${alignedStart}-${endByte} (cap=${PREBUFFER_CAP_BYTES/(1024*1024)}MB, ioCtrl._resumeFrom=${resumeFromByte}, cacheEnd=${cacheEndByte}, _currentRange.to=${currentRangeTo})`);

                  // Fetch through the interceptor — it siphons to shadow cache automatically
                  const fetchUrl = streamUrl; // The /stream endpoint URL (captured in closure)
                  fetch(fetchUrl, {
                    headers: { Range: `bytes=${alignedStart}-${endByte}` },
                    signal: abortCtrl.signal,
                  }).then(async (response) => {
                    if (!response.ok || !response.body) {
                      diagLog(`[INDEPENDENT-PREBUFFER] Response not OK: status=${response.status}`);
                      independentPrebufferRef.current.active = false;
                      return;
                    }
                    const reader = response.body.getReader();
                    let capReached = false;
                    let cacheFull = false;
                    try {
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        // Data is already siphoned to shadow cache by the fetch interceptor's forwardAndSiphon()
                        // We just need to consume the stream to keep it flowing
                        independentPrebufferRef.current.downloadedBytes += value.length;

                        // ── Runtime cap check: stop if we've downloaded more than the cap ──
                        if (independentPrebufferRef.current.downloadedBytes > PREBUFFER_CAP_BYTES) {
                          capReached = true;
                          diagLog(`[INDEPENDENT-PREBUFFER] Cap reached: downloaded ${independentPrebufferRef.current.downloadedBytes} bytes > ${PREBUFFER_CAP_BYTES} — stopping`);
                          break;
                        }

                        // ── Cache-full check: stop if shadow cache is ≥90% full ──
                        const cache = shadowCacheRef.current;
                        if (cache) {
                          const stats = cache.getStats();
                          if (stats.totalMB >= stats.maxMB * 0.9) {
                            cacheFull = true;
                            independentPrebufferRef.current.lastCacheFullTime = Date.now();
                            diagLog(`[INDEPENDENT-PREBUFFER] Shadow cache full: ${stats.totalMB}/${stats.maxMB}MB (≥90%) — stopping (cooldown 60s)`);
                            break;
                          }
                        }
                      }
                      const reason = capReached ? ' (cap reached)' : cacheFull ? ' (cache full)' : '';
                      diagLog(`[INDEPENDENT-PREBUFFER] Completed${reason}: downloaded ${independentPrebufferRef.current.downloadedBytes} bytes from start=${alignedStart}`);
                    } catch (e: any) {
                      if (e.name === 'AbortError') {
                        diagLog(`[INDEPENDENT-PREBUFFER] Aborted after ${independentPrebufferRef.current.downloadedBytes} bytes — IOController resuming`);
                      } else {
                        diagLog(`[INDEPENDENT-PREBUFFER] Read error: ${e.message}`);
                      }
                    } finally {
                      independentPrebufferRef.current.active = false;
                      independentPrebufferRef.current.abortController = null;
                    }
                  }).catch((e: any) => {
                    if (e.name !== 'AbortError') {
                      diagLog(`[INDEPENDENT-PREBUFFER] Fetch error: ${e.message}`);
                    }
                    independentPrebufferRef.current.active = false;
                    independentPrebufferRef.current.abortController = null;
                  });
                }
              }
            }  // end fallback else (no pacing available)
            }  // end if (isPaused && !isBufferFull)
          }  // end else (not needsEviction)
          }  // end if/else needsEviction block
          };
      // At 16x, timeupdate (250ms) = 4s of content. Too slow to catch
      // buffer drain and resume before video stalls.
      const quotaGuardInterval = setInterval(sourceBufferQuotaGuard, 100);
      quotaGuardIntervalRef.current = quotaGuardInterval;
      quotaGuardHandlerRef.current = sourceBufferQuotaGuard;
      video.addEventListener('timeupdate', sourceBufferQuotaGuard); // also on timeupdate for coverage

      // ── Shadow cache trim: keep roughly 60s ahead / 60s behind of raw bytes around playhead ──
      // This is a soft cap; the 300MB absolute limit also applies.
      // At 4Mbps, 60s behind + 180s ahead = 240MB, well within the 300MB cache budget.
      // The exact window size is enforced by sourceBufferQuotaGuard; the shadow cache
      // keeps a generous linear window around the playhead so cached seeks can be instant.
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

      // ── lazyLoad is OFF — continuous download architecture ──
      // With lazyLoad disabled + lazyLoadRecoverDuration=30, suspendTransmuxer
      // fires on BUFFER_FULL (SourceBuffer quota exceeded). ResumeTransmuxer
      // fires when playhead approaches buffer end (within 30s), so download
      // auto-resumes after playback consumes enough buffer. No DTS patches
      // needed — BUFFER_FULL is a hard stop, not a graceful resume point.
      diagLog('[MPEGTS] Lazy-load buffer mode (lazyLoadMax=180, BUFFER_FULL handled by quota guard)');

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
  const _mpegtsUnbufferedSeek = async (timeSeconds: number, duration: number, isCacheHit?: boolean) => {
    // Cancel independent prebuffer — seek changes the download position
    if (independentPrebufferRef.current.active && independentPrebufferRef.current.abortController) {
      diagLog('[INDEPENDENT-PREBUFFER] Cancelling seek prebuffer');
      independentPrebufferRef.current.abortController.abort();
      independentPrebufferRef.current.active = false;
      independentPrebufferRef.current.abortController = null;
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
            diagLog('[MPEGTS] Unbuffered seek: SourceBuffer update wait timed out (3s) — proceeding with flush');
            resolve();
          }, 3000))])));
      }
    }

    // Mark user seek in progress — allows _onIOSeeked to fire insertDiscontinuity
    // (which is correct for user seeks, but wrong for lazyLoad resume/Early-EOF reconnect).
    // Use a generation counter so an earlier seek that finishes after a later seek does
    // not clear the flag for the later seek.
    mpegtsUnbufferedSeekGenerationRef.current = (mpegtsUnbufferedSeekGenerationRef.current || 0) + 1;
    const seekGen = mpegtsUnbufferedSeekGenerationRef.current;
    (window as any).__nobuf_userSeekInProgress = true;
    try {
    const video = videoRef.current;
    const player = mpegtsPlayerRef.current;
    if (!video || !player) {
      diagLog('[MPEGTS] Unbuffered seek: no video or player');
      return;
    }

    // Clear downloaded ranges — after seek, the byte range tracking starts fresh
    clearDownloadedRanges();

    const filesize = state.current.fileLength || 0;
    if (filesize <= 0 || duration <= 0) {
      diagLog(`[MPEGTS] Cannot unbuffered seek — filesize=${filesize}, duration=${duration}`);
      return;
    }

    // TS packets are 188 bytes. The byte offset MUST be aligned to a 188-byte
    // boundary, otherwise TSDemuxer lands mid-packet and sees garbage instead
    // of 0x47 sync bytes (e.g. sync_byte=170/0xAA), causing a flood of
    // "sync_byte != 0x47" errors and playback failure.
    // We also step back ~10 packets (~1880 bytes) so TSDemuxer has room to
    // find PAT/PMT + the nearest keyframe before the target time.
    const TS_PACKET_SIZE = 188;
    const seekByteFromIndex = (byteTimeSamplesRef.current?.length ?? 0) > 0
      ? findByteForTime(timeSeconds, byteTimeSamplesRef.current, duration, filesize)
      : -1;
    const RAW_BYTE_OFFSET = seekByteFromIndex >= 0
      ? seekByteFromIndex
      : Math.floor((timeSeconds / duration) * filesize);
    const ALIGNED_BYTE_OFFSET = Math.max(0,
      Math.floor(RAW_BYTE_OFFSET / TS_PACKET_SIZE) * TS_PACKET_SIZE
      - TS_PACKET_SIZE * 10  // step back ~10 packets for PAT/PMT + keyframe
    );
    const byteOffset = ALIGNED_BYTE_OFFSET;
    diagLog(`[MPEGTS] Unbuffered seek to ${timeSeconds.toFixed(1)}s (raw byte ${RAW_BYTE_OFFSET}, aligned ${ALIGNED_BYTE_OFFSET} [${RAW_BYTE_OFFSET % TS_PACKET_SIZE} off → ${ALIGNED_BYTE_OFFSET % TS_PACKET_SIZE}], ${(byteOffset/1024/1024).toFixed(1)}MB of ${(filesize/1024/1024).toFixed(1)}MB)`);

    try {
      const engine = (player as any)?._player_engine;
      if (!engine) {
        diagLog('[MPEGTS] No player engine — falling back to video.currentTime');
        video.currentTime = timeSeconds;
        return;
      }

      // 1. Flush SourceBuffers — remove all buffered ranges for clean slate
      const mseCtrl = engine._mse_controller;
      if (mseCtrl) {
        try { mseCtrl.flush(); } catch (_) {}
      }

      // 1b. Reset quota guard aggressive mode — after flush, totalBuffered=0
      //     so the guard will clear aggressive on next tick.
      (window as any).__nobuf_quotaGuardAggressive = false;
      (window as any).__nobuf_bufferFullDetected = false;
      (window as any).__nobuf_removeInProgress = false;
      (window as any).__nobuf_evictionResumePending = false;
      (window as any).__nobuf_evictionResumeByte = 0;
      (window as any).__nobuf_nuclearRecoveryInProgress = false;
      // Invalidate any pending nuclear recovery's restartAfterClear
      // so it won't resume from the old byte offset after this seek.
      (window as any).__nobuf_nuclearGeneration = ((window as any).__nobuf_nuclearGeneration || 0) + 1;
      // Byte-time samples are tied to the old byte stream. After a seek, using them
      // to convert buffer times back to bytes will return stale/wrong byte offsets,
      // which corrupts eviction resume and serve-limit calculations. Start fresh.
      byteTimeSamplesRef.current = [];

      // 2. Reset demuxer and remuxer for clean state after flush
      const tController = engine._transmuxer?._controller;
      if (!tController) {
        diagLog('[MPEGTS] No transmuxing controller — falling back');
        video.currentTime = timeSeconds;
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

          // CRITICAL: Reset _dtsBaseInited so _calculateDtsBase() runs again with
          // the new DTS values from the seek position. Without this, _dtsBase retains
          // the value from the initial load (~0ms), and originalDts = sample.dts - 0
          // produces wrong values (~40s from stale demuxer extrapolation instead of
          // ~1028s from actual PES headers at seek position).
          remuxer._dtsBaseInited = false;
          remuxer._audioDtsBase = Infinity;
          remuxer._videoDtsBase = Infinity;
          remuxer._dtsBase = -1;

          // insertDiscontinuity() resets _audioNextDts and _videoNextDts to undefined,
          // so the first batch after seek gets dtsCorrection=0 (clean start).
          // Note: ioctl.seek() will also trigger _onIOSeeked() → insertDiscontinuity()
          // again, which is harmless (idempotent).
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

        // Burst from disk cache when the forward 180s are already cached.
        // Disable interceptor pacing and set a serve limit so the shadow cache
        // saturates the SourceBuffer instantly without overshooting.
        if (isCacheHit && shadowCacheRef.current) {
          const sc = shadowCacheRef.current;
          sc._pacingBps = 0; // full speed from disk cache
          const serveLimitByte = findByteForTime(
            Math.min(timeSeconds + 180, duration),
            byteTimeSamplesRef.current,
            duration,
            filesize
          );
          if (serveLimitByte > 0) {
            sc._interceptorServeLimitByte = serveLimitByte;
          }
          diagLog(`[MPEGTS] Seek to cached range: pacing disabled, serve limit byte=${serveLimitByte}`);
        }

        // 4. Resume LoadingController if paused (BUFFER_FULL or initial load).
        //    After seek, LoadingController may still think it's paused.
        //    Fix: resume so it resets _paused = false and can monitor the buffer.
        const loadingCtrl = engine?._loading_controller;
        if (loadingCtrl && loadingCtrl._paused) {
          diagLog('[MPEGTS] Resuming LoadingController after seek (was paused)');
          // The patched resumeTransmuxer requires explicit authorization.
          const lcConfig = loadingCtrl._config;
          if (lcConfig) lcConfig.__nobuf_resumeAuthorized = true;
          loadingCtrl.resumeTransmuxer();
          if (lcConfig) lcConfig.__nobuf_resumeAuthorized = false;
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
            _mpegtsRecreatePlayerForSeek(byteOffset, timeSeconds);
          }
        }, 200);
        return; // Don't set currentTime yet — wait for IOController
      }

      // 4. Set video.currentTime — video element seeks to the target position
      video.currentTime = timeSeconds;
      diagLog(`[MPEGTS] Seek initiated — video.currentTime set to ${timeSeconds.toFixed(1)}s`);

    } catch (e: any) {
      diagLog(`[MPEGTS] Unbuffered seek failed: ${e.message}`);
      video.currentTime = timeSeconds;
    }
    } finally {
      // Clear user seek flag — after this point, _onIOSeeked should NOT
      // fire insertDiscontinuity (lazyLoad resume and Early-EOF reconnect
      // have continuous DTS, not a discontinuity). Only clear if this is still
      // the most recent seek generation, otherwise a later seek needs the flag.
      if (mpegtsUnbufferedSeekGenerationRef.current === seekGen) {
        (window as any).__nobuf_userSeekInProgress = false;
      }
    }
  };

  /** Last-resort: recreate mpegts.js player for seek when IOController is null.
   *  Destroys the current player and creates a new one that starts from byteOffset.
   */
  const _mpegtsRecreatePlayerForSeek = async (byteOffset: number, timeSeconds: number) => {
    const video = videoRef.current;
    const player = mpegtsPlayerRef.current;
    if (!video || !player) return;

    diagLog(`[MPEGTS] Recreating player for seek to byte ${byteOffset}`);

    // 1. Destroy current player
    try {
      player.detachMediaElement();
      player.unload();
      player.destroy();
    } catch (_) {}
    mpegtsPlayerRef.current = null;

    // 2. Create new player with a URL that includes the start offset
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
        lazyLoad: true,                // 180s ahead — fixed by adjustBufferForSpeed
        lazyLoadMaxDuration: 180,      // 180s ahead per 180s/60s policy
        lazyLoadRecoverDuration: 120,  // Resume 120s before buffer end
        seekType: 'range',
        autoCleanupSourceBuffer: false,  // We manage the 60s behind window ourselves
        autoCleanupMaxBackwardDuration: 60,
        autoCleanupMinBackwardDuration: 60,
        accurateSeek: false,
      });

      newPlayer.attachMediaElement(video);
      mpegtsPlayerRef.current = newPlayer;

      // ── No lazyLoad patches needed — continuous download mode ──
      // With lazyLoad disabled, suspendTransmuxer only fires on BUFFER_FULL.
      // No DTS capture/restore needed for BUFFER_FULL hard stops.

      newPlayer.on(MpegtsPlayer.Events.ERROR, (_type: string, detail: string) => {
        diagLog(`[MPEGTS] Recreated player error: ${detail}`);
      });

      newPlayer.load();

      // After load, the IOController is created — seek to the byte offset
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => resolve(), 5000);
        newPlayer.on(MpegtsPlayer.Events.METADATA_ARRIVED, () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      // Seek via internal IOController — reset stale demuxer/remuxer state first
      const engine = (newPlayer as any)?._player_engine;
      const tCtrl = engine?._transmuxer?._controller;
      if (tCtrl) {
        // Same DTS reset as _mpegtsUnbufferedSeek — prevents stale timestamp
        // extrapolation from the initial load() data (byte 0) corrupting seek frames.
        const demuxer = tCtrl._demuxer as any;
        if (demuxer) {
          demuxer.audio_last_sample_pts_ = undefined;
          demuxer.aac_last_incomplete_data_ = null;
        }
        const remuxer = tCtrl._remuxer as any;
        if (remuxer) {
          remuxer._dtsBaseInited = false;
          remuxer._audioDtsBase = Infinity;
          remuxer._videoDtsBase = Infinity;
          remuxer._dtsBase = -1;
        }
      }
      const ioctl = tCtrl?._ioctl;
      if (ioctl) {
        ioctl.seek(byteOffset);
        // Resume LoadingController if paused (BUFFER_FULL or initial load pause)
        const loadingCtrl = engine?._loading_controller;
        if (loadingCtrl && loadingCtrl._paused) {
          loadingCtrl.resumeTransmuxer();
        }
        video.currentTime = timeSeconds;
        diagLog(`[MPEGTS] Recreated player — seeked to byte ${byteOffset}`);
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

      await newPlayer.play();
      diagLog(`[MPEGTS] Recreated player — playback started at ${timeSeconds.toFixed(1)}s`);

    } catch (e: any) {
      diagLog(`[MPEGTS] Player recreation failed: ${e.message}`);
    }
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

      const parsedFallback = parseStreamUrl(url);
      if (parsedFallback) {
        const remuxUrl = `${parsedFallback.baseUrl}/remux/${parsedFallback.folderId}/${parsedFallback.messageId}?token=${encodeURIComponent(parsedFallback.token)}`;
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

      // Report tail range to backend cache
      reportRangesToBackend(tailStart, tailStart + tailData.byteLength - 1);
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

        reportRangesToBackend(moovFetchStart, moovFetchStart + completeData.byteLength - 1);
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
      if (!state.current.initialized && !cancelledRef.current) {
        console.log('[MSE] onReady did not fire after first chunk + moov, trying forward scan');
        await fetchMoreDataForwardScan(url, mp4box);
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

      if (!state.current.initialized && !cancelledRef.current) {
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
        reportRangesToBackend(offset, offset + data.byteLength - 1);
        trackDownloadedRange(offset, offset + data.byteLength - 1);
      } catch (e) {
        break;
      }
    }

    if (!state.current.initialized && !cancelledRef.current) {
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

        // Report and track ranges
        reportRangesToBackend(offset, offset + data.byteLength - 1);
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
          // MSE doesn't support this codec. Check if native <video> can play it.
          const canPlay = videoRef.current?.canPlayType(mimeType) ?? '';
          console.warn(`[MSE] Video codec NOT supported by MSE: ${mimeType}`);
          console.log(`[MSE] Native canPlayType("${mimeType}") = "${canPlay}"`);
          if (canPlay === 'probably' || canPlay === 'maybe') {
            // Native <video> can handle this codec — fall back to native playback.
            // Native <video> handles moov-at-end files via Range requests naturally.
            console.log(`[MSE] Falling back to native playback — codec "${videoCodec}" is natively supported (${canPlay})`);
            setUseNative(true);
          } else {
            // Neither MSE nor native <video> supports this codec.
            const codecName = videoCodec.startsWith('hvc1') || videoCodec.startsWith('hev1')
              ? 'HEVC (H.265)'
              : videoCodec.startsWith('av01')
                ? 'AV1'
                : videoCodec;
            const isHevc = videoCodec.startsWith('hvc1') || videoCodec.startsWith('hev1');
            const msg = `This video uses ${codecName} codec which is not supported by the built-in player.` +
              (isHevc ? ' On Windows, install "HEVC Video Extensions" from the Microsoft Store ($0.99) for in-app playback.' : '') +
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
        const ahead = getBufferedAheadSeconds();
        if (ahead <= MAX_BUFFER_AHEAD_SECONDS) break;
        // Sleep 2s — let playback consume buffered data before downloading more
        await new Promise(r => setTimeout(r, 2000));
        // Proactively evict during the wait to free space
        evictOldBuffer();
      }
      if (cancelledRef.current || !state.current.downloading || gen !== loopGeneration.current) break;

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

        // Report this range to cache backend
        reportRangesToBackend(offset, offset + data.byteLength - 1);
        // Track for green buffer bar
        trackDownloadedRange(offset, offset + data.byteLength - 1);

        // Throttle React state updates to every 250ms
        const now = Date.now();
        if (now - lastThrottleRef.current > 250) {
          lastThrottleRef.current = now;
          setPrefetchedBytes(state.current.currentOffset);

          // Speed tracking (sliding window)
          speedHistory.current.push({ bytes: data.byteLength, time: now });
          while (speedHistory.current.length > 0 && speedHistory.current[0].time < now - 5000) {
            speedHistory.current.shift();
          }
          if (speedHistory.current.length > 1) {
            const first = speedHistory.current[0];
            const last = speedHistory.current[speedHistory.current.length - 1];
            const timeDiff = (last.time - first.time) / 1000;
            if (timeDiff > 0) {
              const bytesTotal = speedHistory.current.reduce((sum, s) => sum + s.bytes, 0);
              setSpeed(bytesTotal / timeDiff);
            }
          }
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
    console.log(`[MSE] Download loop exited: offset=${state.current.currentOffset}, fileLength=${state.current.fileLength}, reachedEnd=${reachedEnd}`);
    if (!cancelledRef.current) {
      // Flush any remaining range reports
      flushRangeReport();
      if (reachedEnd) {
        console.log('[MSE] isComplete=true — video reached end');
        setIsComplete(true);
        isCompleteRef.current = true;
          hasEverCompletedRef.current = true;
      }
      setIsPrefetching(false);
      setSpeed(0);
    }
  };
  downloadLoopRef.current = downloadLoop;

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
    if (mpegtsPlayerRef.current && formatRef.current === 'ts') {
      const dur = state.current.duration || mpegtsDurationRef.current;
      if (!dur || dur <= 0 || !isFinite(dur)) return;
      const clamped = Math.max(0, Math.min(timeSeconds, dur - 0.1));
      const video = videoRef.current;
      if (!video) return;

      // Check if the target position is buffered (SourceBuffer) or cached (disk/shadow cache)
      const isBuffered = (() => {
        const sb = video.buffered;
        for (let i = 0; i < sb.length; i++) {
          if (clamped >= sb.start(i) && clamped < sb.end(i)) return true;
        }
        return false;
      })();

      // Disk-cached range check: forward 180s from seek target must be cached.
      // Uses the VBR byte/time index for accurate byte offsets instead of a
      // linear estimate, so the seek lands precisely and the interceptor can
      // burst the entire 180s window instantly.
      const isSeekToCachedRange = (targetTime: number) => {
        const fileLen = state.current.fileLength || 0;
        const duration = mpegtsDurationRef.current || state.current.duration || 0;
        if (!shadowCacheRef.current || fileLen === 0 || duration === 0) return false;
        const startByte = findByteForTime(targetTime, byteTimeSamplesRef.current, duration, fileLen);
        const endByte = findByteForTime(
          Math.min(targetTime + 180, duration),
          byteTimeSamplesRef.current,
          duration,
          fileLen
        );
        const endByteClamped = Math.min(endByte, fileLen - 1);
        if (endByteClamped <= startByte || endByteClamped <= 0) return false;
        const run = shadowCacheRef.current.cachedRunFrom(startByte);
        return run !== null && run.end >= endByteClamped;
      };

      const isCacheHit = !isBuffered && isSeekToCachedRange(clamped);

      if (isBuffered) {
        // Buffered seek — just set currentTime (mpegts.js handles it)
        diagLog(`[MPEGTS] Buffered seek to ${clamped.toFixed(1)}s`);
        video.currentTime = clamped;
      } else if (isCacheHit) {
        // Cached seek — data is on disk, server will serve instantly.
        // Still need unbuffered seek (mpegts must re-transmux), but the
        // loading latency will be minimal (~0.5-1s for transmux).
        // Suppress loading spinner for cache-hit seeks.
        diagLog(`[MPEGTS] Cache-hit seek to ${clamped.toFixed(1)}s (disk cached, suppressing spinner)`);
        suppressLoadingSpinnerRef.current = true;
        await _mpegtsUnbufferedSeek(clamped, dur, isCacheHit);
        // Auto-clear suppress after 3s (safety net)
        setTimeout(() => { suppressLoadingSpinnerRef.current = false; }, 3000);
      } else {
        // Unbuffered seek — data must be fetched from Telegram (slow)
        await _mpegtsUnbufferedSeek(clamped, dur, false);
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
        clearDownloadedRanges();

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
            const keyframeTimestamp = await transmuxerRef.current!.seekTo(clampedTime, INITIAL_SEEK_DURATION);

            bufferingForSeekRef.current = false;

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
                    const estimatedBytes = Math.floor((absoluteTimestamp / state.current.duration) * state.current.fileLength);
                    setPrefetchedBytes(estimatedBytes);
                    trackDownloadedRange(estimatedBytes, estimatedBytes + item.data.byteLength);
                  }
                }
              }

              console.log(`[MSE] Transmuxer seek complete: keyframe=${keyframeTimestamp.toFixed(2)}s, flushed ${buffer.length} buffered segments`);

              await sbVideo.waitForQueueDrain();
              if (sbAudio) await sbAudio.waitForQueueDrain();

              // Set video.currentTime to the actual keyframe position for accurate playback start
              video.currentTime = keyframeTimestamp;

              // Start streaming chain for continuous playback after limited seek
              startStreamingChain();
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

      const timeSinceLastSeek = Date.now() - lastSeekTimeRef.current;
      if (timeSinceLastSeek >= debounceMs || lastSeekTimeRef.current === 0) {
        if (seekDebounceTimerRef.current !== null) {
          clearTimeout(seekDebounceTimerRef.current);
          seekDebounceTimerRef.current = null;
        }
        executeTransmuxerSeek();
      } else {
        if (seekDebounceTimerRef.current !== null) {
          clearTimeout(seekDebounceTimerRef.current);
        }
        const remainingDebounce = debounceMs - timeSinceLastSeek;
        seekDebounceTimerRef.current = window.setTimeout(() => {
          seekDebounceTimerRef.current = null;
          executeTransmuxerSeek();
        }, remainingDebounce);
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

      // Restart download loop — seeking to an unbuffered position means the
      // user wants to watch from there, so downloads must resume regardless
      // of pause state. Clear isPaused so resumePrefetch() doesn't get stuck
      // (it checks !state.current.downloading which would be true if loop is
      // already running from this restart).
      if (!state.current.downloading && downloadLoopRef.current) {
        console.log('[MSE] Restarting download loop after seek (offset was at completion)');
        isPausedRef.current = false;
        setIsPaused(false);
        state.current.downloading = true;
        setIsPrefetching(true);
        downloadLoopRef.current(streamUrl);
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
    setIsPaused(true);
    setIsPrefetching(false);
    setSpeed(0);
  };

  const resumePrefetch = () => {
    if (!state.current.downloading && streamUrl && downloadLoopRef.current) {
      isPausedRef.current = false;
      setIsPaused(false);
      setIsPrefetching(true);
      downloadLoopRef.current(streamUrl);
    }
  };

  // Cold-start buffer gate: wait until the shadow cache has enough contiguous
  // bytes from the start of the file before attaching the mpegts.js player.
  // Returns true if the overlay was shown and the gate completed, false if the
  // cache was already warm enough to skip the overlay.
  const waitForColdStartBuffer = useCallback(async (format: DetectedFormat, url: string): Promise<boolean> => {
    if (format !== 'ts') return false;
    const fileLength = state.current.fileLength;
    if (fileLength <= 0) return false;

    // The shadow cache is created inside initTransmuxerPlayer, which runs AFTER
    // this gate. To make the gate meaningful, we must create it now so that the
    // first /stream fetches are cached and we can observe real progress.
    let cache = shadowCacheRef.current;
    if (!cache) {
      cache = new StreamShadowCache(300 * 1024 * 1024);
      shadowCacheRef.current = cache;
    }
    const urlKey = new URL(url).pathname;
    cache.reset(urlKey, fileLength);
    installStreamCacheInterceptor(cache);

    const initialRun = cache.cachedRunFrom(0);
    if (initialRun && initialRun.end >= MIN_COLD_START_BUFFER_BYTES - 1) {
      return false; // warm enough — skip overlay
    }

    setIsColdStartBuffering(true);
    const startTime = Date.now();
    let resolved = false;

    // Helper to pull the remaining cold-start target into the shadow cache via /stream.
    // Use one open-ended streaming request so the server pipelines the 512KB Telegram
    // chunks over a single HTTP connection instead of paying per-request overhead for
    // many small 1MB fetches. The interceptor siphons bytes as they arrive, so the
    // polling loop still sees real progress every 250ms.
    const fetchNextChunk = async (fromByte: number): Promise<number> => {
      const targetEnd = Math.min(MIN_COLD_START_BUFFER_BYTES - 1, fileLength - 1);
      if (fromByte >= targetEnd) return fromByte;
      const toByte = targetEnd;
      try {
        if (cancelledRef.current) return fromByte;
        const resp = await fetch(url, {
          headers: { Range: `bytes=${fromByte}-${toByte}` },
        });
        if (!resp.ok && resp.status !== 206) return fromByte;
        // Read the response as a stream. The interceptor already caches each chunk
        // as it passes through, so the cache polling loop stays live. We just track
        // how much we consumed so the next fetch resumes from the right byte if the
        // connection is interrupted.
        const reader = resp.body?.getReader();
        if (!reader) return fromByte;
        let received = 0;
        while (true) {
          if (cancelledRef.current) {
            reader.cancel().catch(() => {});
            return fromByte + received;
          }
          const { done, value } = await reader.read();
          if (done) break;
          received += value?.byteLength || 0;
        }
        return fromByte + received;
      } catch (e: any) {
        diagLog(`[MPEGTS] Cold-start chunk fetch failed at ${fromByte}: ${e.message}`);
        return fromByte;
      }
    };

    let nextFetchByte = initialRun ? initialRun.end + 1 : 0;
    let fetching = false;

    return new Promise((resolve) => {
      const timer = window.setInterval(async () => {
        if (cancelledRef.current) {
          window.clearInterval(timer);
          if (!resolved) {
            resolved = true;
            setIsColdStartBuffering(false);
            diagLog('[MPEGTS] Cold-start buffer gate cancelled');
            resolve(false);
          }
          return;
        }

        const now = Date.now();
        const elapsed = now - startTime;
        const currentRun = cache!.cachedRunFrom(0);
        const bytes = currentRun ? currentRun.end + 1 : 0;
        const duration = mpegtsDurationRef.current || state.current.duration || (fileLength / 4_000_000) * 8 || 1;
        const bufferedTime = bytes > 0 && fileLength > 0
          ? (bytes / fileLength) * duration
          : 0;

        setColdStartProgress({ bytes, targetBytes: MIN_COLD_START_BUFFER_BYTES });

        const byteReady = bytes >= MIN_COLD_START_BUFFER_BYTES;
        const timeReady = bufferedTime >= MIN_COLD_START_BUFFER_SECONDS;
        const timedOut = elapsed >= COLD_START_TIMEOUT_MS;

        if (byteReady || timeReady || timedOut) {
          window.clearInterval(timer);
          if (!resolved) {
            resolved = true;
            setIsColdStartBuffering(false);
            diagLog(`[MPEGTS] Cold-start buffer gate ${byteReady ? 'passed by bytes' : timeReady ? 'passed by time' : 'timed out'}: ${bytes} bytes / ${bufferedTime.toFixed(1)}s`);
            resolve(true);
          }
          return;
        }

        // Fire an async fetch for the next chunk if we have not reached the goal.
        // Only one fetch at a time; the interval just checks/reschedules.
        if (!fetching && nextFetchByte < MIN_COLD_START_BUFFER_BYTES && nextFetchByte < fileLength) {
          fetching = true;
          try {
            const fetchByte = nextFetchByte;
            nextFetchByte = await fetchNextChunk(fetchByte);
          } finally {
            fetching = false;
          }
        }
      }, 250);
    });
  }, []);

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
          if (!cancelledRef.current && !useNative && !mpegtsPlayerRef.current) {
            // Only fall back to native for MP4/MSE errors, NOT mpegts.js.
            // mpegts.js handles SourceBuffer quota errors internally (suspend/resume).
            console.warn('[MSE] Fatal video error (code', err.code, ') — falling back to native playback');
            setUseNative(true);
          }
        }
      });
    }
    videoRef.current = el;
  }, []);

  const setSuppressBackendReports = useCallback((suppress: boolean) => {
    suppressBackendReportsRef.current = suppress;
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

  // Reset cold-start overlay state when the stream changes or hook unmounts.
  // This ensures the overlay never stays stuck if the user closes the preview
  // while the buffer gate is still polling.
  useEffect(() => {
    return () => {
      setIsColdStartBuffering(false);
      setColdStartProgress({ bytes: 0, targetBytes: MIN_COLD_START_BUFFER_BYTES });
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
    speed,
    pausePrefetch,
    resumePrefetch,
    seekTo,
    suppressLoadingSpinnerRef,
    setVideoRef,
    downloadedTimeRanges,
    byteToTime,
    setSuppressBackendReports,
    getMp4Box: () => state.current.mp4box,
    getFileLength: getFileLengthCb,
    getMoovBuffer: getMoovBufferCb,
    getFirstChunk: getFirstChunkCb,
    getInitSegments: getInitSegmentsCb,
    getVideoTrackInfo: getVideoTrackInfoCb,
    getMP4BoxClass: getMP4BoxClassCb,
    isTransmuxer: isTransmuxerCb,
    getFormat: getFormatCb,
    isTransmuxerActive,
    getKeyframeTimestamps: () => transmuxerRef.current?.getKeyframeTimestamps() ?? [],
    getKeyframeByteOffsets: () => transmuxerRef.current?.getKeyframeByteOffsets() ?? [],
    getTsHeaderData: () => transmuxerRef.current?.getTsHeaderData() ?? null,
    getTransmuxerSourceConfig: () => transmuxerRef.current?.getSourceConfig() ?? null,
    isFmp4Stream: isFmp4StreamCb,
    getFmp4Config: getFmp4ConfigCb,
    isColdStartBuffering,
    coldStartProgress,
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

export function formatSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}
