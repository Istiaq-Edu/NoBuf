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

/** Patch fMP4 init segment mvhd.duration and tkhd.duration from 0xFFFFFFFF
 *  (Infinity) to a finite value. Chrome reads mvhd.duration from the init
 *  segment and sets mediaSource.duration=Infinity, causing expensive
 *  DurationChanged notifications on every media segment append (8-9s per
 *  append). Patching to a finite value eliminates this. */
function patchMvhdDuration(initSegment: ArrayBuffer, durationSeconds: number): ArrayBuffer {
  const buffer = initSegment.slice(0);
  const view = new DataView(buffer);
  const len = buffer.byteLength;
  let offset = 0;

  while (offset + 8 <= len) {
    const boxSize = view.getUint32(offset);
    const boxType = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7),
    );

    if (boxType === 'moov') {
      let childOffset = offset + 8;
      const moovEnd = Math.min(offset + boxSize, len);
      let movieTimescale = 90000;

      while (childOffset + 8 <= moovEnd) {
        const childSize = view.getUint32(childOffset);
        const childType = String.fromCharCode(
          view.getUint8(childOffset + 4), view.getUint8(childOffset + 5),
          view.getUint8(childOffset + 6), view.getUint8(childOffset + 7),
        );

        if (childType === 'mvhd' && childOffset + 28 <= len) {
          if (view.getUint8(childOffset + 8) === 0) {
            movieTimescale = view.getUint32(childOffset + 20);
            const dur = Math.min(Math.floor(durationSeconds * movieTimescale), 0x7FFFFFFF);
            view.setUint32(childOffset + 24, dur);
          }
        }

        if (childType === 'trak') {
          let trakOff = childOffset + 8;
          const trakEnd = Math.min(childOffset + childSize, len);
          while (trakOff + 8 <= trakEnd) {
            const tSize = view.getUint32(trakOff);
            const tType = String.fromCharCode(
              view.getUint8(trakOff + 4), view.getUint8(trakOff + 5),
              view.getUint8(trakOff + 6), view.getUint8(trakOff + 7),
            );
            if (tType === 'tkhd' && trakOff + 32 <= len && view.getUint8(trakOff + 8) === 0) {
              const dur = Math.min(Math.floor(durationSeconds * movieTimescale), 0x7FFFFFFF);
              view.setUint32(trakOff + 28, dur);
            }
            if (tSize === 0) break;
            trakOff += tSize;
          }
        }

        if (childSize === 0) break;
        childOffset += childSize;
      }
    }

    if (boxSize === 0) break;
    offset += boxSize;
  }

  return buffer;
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
  const suppressLoadingSpinnerRef = useRef(false); // suppress spinner for cache-hit seeks
  const quotaGuardIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null); // 100ms quota guard
  const mpegtsSpeedHistoryRef = useRef<{ time: number; byte: number }[]>([]); // download speed tracking for TS
  const mpegtsFailedRef = useRef(false);     // Set true if mpegts.js fails, skip retry
  const mpegtsDurationRef = useRef<number>(0); // Duration from metadata for mpegts.js
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
  // Timer ID for periodic keyframe index refresh (FIX 3)
  const keyframeRefreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      // Revoke blob URL on cleanup
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [streamUrl]);

  const cleanup = () => {
    abortRef.current?.abort();
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

      // Common path for both TS (mux.js) and MKV/WebM (mediabunny)
      diagLog(`[MSE] Detected ${format} format — initializing transmuxer, fileLength=${state.current.fileLength}`);
      await initTransmuxerPlayer(url, mediaSource, blobUrl!, format, data);
      return;

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
    const metaUrl = `${parsed.baseUrl}/fmp4/metadata/${parsed.folderId}/${parsed.messageId}?token=${encodeURIComponent(parsed.token)}`;

    // Get known duration. For TS files, Telegram doesn't provide video duration
    // in the document attributes, so file?.duration is typically undefined.
    // We MUST fetch from /fmp4/metadata/ which estimates duration from bitrate+filesize.
    let knownDuration: number | undefined = file?.duration ? file.duration : undefined;
    const knownFilesize = state.current.fileLength > 0 ? state.current.fileLength : undefined;

    if (!knownDuration) {
      try {
        diagLog(`[MPEGTS] Fetching duration from metadata endpoint: ${metaUrl}`);
        const metaResp = await fetch(metaUrl);
        if (metaResp.ok) {
          const meta = await metaResp.json();
          // Backend returns { duration_s: number, ... } not { duration: number }
          const metaDur = meta.duration_s || meta.duration;
          if (metaDur && metaDur > 0) {
            knownDuration = metaDur;
            // Store on window for synchronous access from FastStreamPlayer
            // (mpegtsDurationRef is set later, after player init, but onMeta
            // fires at loadedmetadata which is before that)
            (window as any).__nobuf_ptsDuration = metaDur;
            diagLog(`[MPEGTS] Got duration from metadata: ${knownDuration}s (field: ${meta.duration_s ? 'duration_s' : 'duration'})`);
          } else {
            diagLog(`[MPEGTS] Metadata response had no valid duration: ${JSON.stringify(meta).slice(0, 200)}`);
          }
        } else {
          diagLog(`[MPEGTS] Metadata endpoint returned ${metaResp.status}`);
        }
      } catch (e: any) {
        diagLog(`[MPEGTS] Metadata fetch failed: ${e.message}`);
      }
    }

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
      stashInitialSize: 1024 * 1024, // 1MB initial stash — reduces rebuffering
      lazyLoad: true,                // ENABLED: registers timeupdate listener for auto-resume.
                                     // lazyLoadMaxDuration=9999 means lazyLoad NEVER suspends for
                                     // "too much buffer ahead" — only SourceBuffer quota (BUFFER_FULL)
                                     // triggers suspend, which our quota guard handles with eviction.
                                     // This enables CONTINUOUS download → green bar updates real-time.
      lazyLoadMaxDuration: 9999,     // Effectively DISABLE lazyLoad's proactive suspend.
                                     // Previous 120 caused re-suspend after BUFFER_FULL recovery:
                                     // recovery fills buffer to ~155s ahead, lazyLoad sees ahead>120,
                                     // immediately re-suspends → download stops for 90+ seconds.
                                     // With 9999, only BUFFER_FULL (SourceBuffer quota) pauses download.
                                     // Our quota guard (100ms) detects BUFFER_FULL, evicts, resumes.
      lazyLoadRecoverDuration: 30,   // Resume 30s before buffer end — natural backpressure
      seekType: 'range',             // Use HTTP Range for seeking (our server supports it)
      autoCleanupSourceBuffer: true, // Evict backward data when quota approached
                                     // 10 min behind (user's specified window).
      autoCleanupMaxBackwardDuration: 600,  // 10 min behind
      autoCleanupMinBackwardDuration: 300,  // start cleanup when >5 min behind
      accurateSeek: false,           // Let mpegts.js seek to nearest keyframe for speed
    });

    // Store player ref for cleanup
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

      // Mark that MSE pipeline is initialized (prevents MSE timeout)
      transmuxerInitInProgressRef.current = true;

      // Load and start playback
      player.load();
      diagLog('[MPEGTS] Player loaded, starting playback');

      // Wait briefly for the player to initialize the MediaSource
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('mpegts.js initialization timeout (10s)'));
        }, 10000);

        player.on(MpegtsPlayer.Events.METADATA_PARSED, () => {
          clearTimeout(timeout);
          diagLog('[MPEGTS] Metadata parsed — player initialized');
          resolve();
        });

        // Also resolve on MEDIA_INFO if METADATA_PARSED doesn't fire
        player.on(MpegtsPlayer.Events.MEDIA_INFO, (info: any) => {
          clearTimeout(timeout);
          diagLog(`[MPEGTS] Media info: duration=${info.duration}s, codec=${info.videoCodec},${info.audioCodec}`);
          resolve();
        });
      });

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
            // ── DTS overflow guard ──
            // mpegts.js DTS computation can produce garbage values (~2^32/1000 ≈ 4294967s).
            if (video.duration > known * 10) {
              const oldDur = ms.duration;
              try {
                ms.duration = known;
                diagLog(`[MPEGTS] DTS overflow guard: mediaSource.duration ${oldDur} → ${known}s`);
              } catch (e: any) {
                // SourceBuffer updating — retry after updateend
                const sbVideo = ms.sourceBuffers?.[0];
                if (sbVideo && sbVideo.updating) {
                  const retryDur = known;
                  const retry = () => {
                    try { ms.duration = retryDur; diagLog(`[MPEGTS] DTS overflow guard (retry): ${oldDur} → ${retryDur}s`); } catch (_) {}
                  };
                  sbVideo.addEventListener('updateend', retry, { once: true });
                }
              }
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

      // ── SourceBuffer config — 10 min memory window ──
      // User's architecture: 10 min behind + 10 min ahead of playhead.
      // Playback speed does NOT change this.
      // Disk cache holds the rest. SourceBuffer eviction handles quota.
      const adjustBufferForSpeed = () => {
        const lc = (player as any)?._player_engine?._loading_controller;
        if (lc?._config) {
          // ENABLE lazyLoad — mpegts.js manages backpressure naturally.
          // Suspends at 10 min ahead, resumes when playhead nears buffer end.
          // This prevents SourceBuffer quota overflow (the #1 crash cause).
          lc._config.lazyLoad = true;
          lc._config.lazyLoadMaxDuration = 9999;     // Effectively disable lazyLoad's proactive suspend
                                                     // Only BUFFER_FULL (SourceBuffer quota) triggers suspend
                                                     // Our quota guard handles eviction + resume
          lc._config.lazyLoadRecoverDuration = 30;  // Resume 30s before buffer end

          // 10 min behind playhead (user's specified window).
          lc._config.autoCleanupMaxBackwardDuration = 600;  // 10 min behind
          lc._config.autoCleanupMinBackwardDuration = 300;   // start cleanup when >5 min behind

          diagLog(`[MPEGTS] Buffer window: 10min behind + continuous ahead, lazyLoad=ON (maxDuration=9999, quota-guard-managed)`);
        }
      };
      adjustBufferForSpeed(); // set initial values

      // ── Monkey-patch LoadingController.resumeTransmuxer ──
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
      // Fix: Reset _dtsBaseInited + call seek() (clears segment info lists +
      // stashed samples) BEFORE the resume logic runs.
      try {
        const engine = (player as any)?._player_engine;
        const loadingCtrl = engine?._loading_controller;
        if (loadingCtrl) {
          const origResume = loadingCtrl.resumeTransmuxer.bind(loadingCtrl);
          loadingCtrl.resumeTransmuxer = function () {
            try {
              const tController = engine._transmuxer?._controller;
              if (tController?._remuxer) {
                const remuxer = tController._remuxer;
                const isBufferFullRecovery = (window as any).__nobuf_bufferFullDetected === true;

                // DO NOT reset _dtsBaseInited — keep the original _dtsBase!
                remuxer._audioDtsBase = Infinity;
                remuxer._videoDtsBase = Infinity;

                // seek(0) clears segment info lists — ALWAYS needed to prevent
                // "Dropping audio frame" from stale segment info comparisons.
                remuxer.seek?.(0);

                if (isBufferFullRecovery) {
                  // BUFFER_FULL recovery: do NOT call insertDiscontinuity()!
                  // insertDiscontinuity resets _nextDts → timestamps restart from 0
                  // → overlaps existing SB data → decoder stalls.
                  // Instead, SAVE _nextDts before origResume (which triggers
                  // insertDiscontinuity via _onIOSeeked) and RESTORE after.
                  // Also set _resumeFrom to the byte offset for the SB end
                  // so the download picks up exactly where the SB ends.
                  const savedVideoNextDts = remuxer._videoNextDts;
                  const savedAudioNextDts = remuxer._audioNextDts;

                  // Set _resumeFrom to byte offset for SB end position.
                  // ioCtrl.resume() reads _resumeFrom and calls _internalSeek(bytes).
                  const ioCtrl = tController?._ioctl;
                  if (ioCtrl) {
                    const mseCtrl = engine._mse_controller;
                    const ms = mseCtrl?.getObject?.();
                    const sbs = ms?.sourceBuffers;
                    if (sbs && sbs.length > 0) {
                      // Find the furthest SB end time across all SBs
                      let maxEndTime = 0;
                      for (let i = 0; i < sbs.length; i++) {
                        const sb = sbs[i];
                        if (sb.buffered.length > 0) {
                          const end = sb.buffered.end(sb.buffered.length - 1);
                          if (end > maxEndTime) maxEndTime = end;
                        }
                      }
                      if (maxEndTime > 0) {
                        const dur = state.current.duration;
                        const fLen = state.current.fileLength;
                        if (dur > 0 && fLen > 0) {
                          // Estimate byte offset from time: (time/duration) * fileSize
                          // Round DOWN to 188-byte boundary for TS alignment
                          const rawByte = (maxEndTime / dur) * fLen;
                          const alignedByte = Math.floor(rawByte / 188) * 188;
                          ioCtrl._resumeFrom = alignedByte;
                          diagLog(`[MPEGTS] BUFFER_FULL resume: _resumeFrom set to ${alignedByte} (time=${maxEndTime.toFixed(1)}s, estByte=${rawByte.toFixed(0)})`);
                        }
                      }
                    }
                  }

                  // Call origResume — this triggers ioCtrl.resume() which reads
                  // our _resumeFrom, then _onIOSeeked → insertDiscontinuity().
                  // insertDiscontinuity will reset _nextDts, but we restore after.
                  origResume();

                  // RESTORE _nextDts that insertDiscontinuity reset.
                  // This ensures new segments are placed CONTIGUOUSLY after
                  // the existing SB content, not at timestamp 0.
                  if (savedVideoNextDts != null) remuxer._videoNextDts = savedVideoNextDts;
                  if (savedAudioNextDts != null) remuxer._audioNextDts = savedAudioNextDts;
                  diagLog(`[MPEGTS] BUFFER_FULL resume: _nextDts restored (video=${savedVideoNextDts}, audio=${savedAudioNextDts})`);
                  // NOW clear the flag — resumeTransmuxer wrapper has used it
                  (window as any).__nobuf_bufferFullDetected = false;
                  return; // origResume already called above
                } else {
                  // Normal resume (seek/lazyLoad): insertDiscontinuity is needed
                  remuxer.insertDiscontinuity?.();
                  diagLog('[MPEGTS] resumeTransmuxer patch: seek+insertDiscontinuity (normal resume)');
                }
              }
              // Also reset audio_last_sample_pts_ in TSDemuxer — prevents
              // stale extrapolation from previous position
              if (tController?._demuxer) {
                const demuxer = tController._demuxer as any;
                if (demuxer.audio_last_sample_pts_ !== undefined) {
                  demuxer.audio_last_sample_pts_ = undefined;
                }
                if (demuxer.aac_last_incomplete_data_ != null) {
                  demuxer.aac_last_incomplete_data_ = null;
                }
              }
            } catch (e: any) {
              diagLog(`[MPEGTS] resumeTransmuxer patch warning: ${e.message}`);
            }
            origResume();
          };
          diagLog('[MPEGTS] Patched LoadingController.resumeTransmuxer: preserve _dtsBaseInited + seek() + insertDiscontinuity BEFORE resume');

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
            const lazyLoadMax = (player as any)?._config?.lazyLoadMaxDuration ?? 9999;
            // With lazyLoadMax=9999, lazyLoad never suspends for "too much buffer ahead".
            // So if suspendTransmuxer fires, it MUST be BUFFER_FULL (SourceBuffer quota).
            // The old check `ahead < lazyLoadMax` is always true now, but we keep it
            // for clarity and future-proofing (in case lazyLoadMax is lowered again).
            const isBufferFullSuspension = ahead < lazyLoadMax;
            diagLog(`[MPEGTS] suspendTransmuxer: currentTime=${ct.toFixed(1)}s, bufferEnd=${bufEnd.toFixed(1)}s, ahead=${ahead.toFixed(1)}s, lazyLoadMax=${lazyLoadMax}, isBufferFull=${isBufferFullSuspension}`);

            origSuspend();

            // ── Register timeupdate listener for auto-resume ──
            // _onMSEBufferFull does NOT do this — only lazyLoad does.
            // Without this, _resumeTransmuxerIfNeeded never fires after BUFFER_FULL.
            if (loadingCtrl._media_element && loadingCtrl.e?.onMediaTimeUpdate) {
              loadingCtrl._media_element.addEventListener('timeupdate', loadingCtrl.e.onMediaTimeUpdate);
            }

            // ── If BUFFER_FULL suspension, evict + fix _resumeFrom + resume ──
            if (isBufferFullSuspension) {
              diagLog(`[MPEGTS] BUFFER_FULL recovery: scheduling eviction + _resumeFrom fix + immediate resume`);
              (window as any).__nobuf_bufferFullDetected = true;

              const doEvictAndResume = () => {
                const engine = (player as any)?._player_engine;
                if (!engine) return;
                const mseCtrl = engine._mse_controller;

                // Use OUR flag, NOT lc._paused — ManagedMediaSource's startstreaming
                // event auto-resumes via _onMSEStartStreaming, so _paused is false
                // by the time this runs. We still need to evict if our flag is set.
                if ((window as any).__nobuf_bufferFullDetected !== true) return;

                const lc = engine._loading_controller;

                // Track retry count to break infinite loops if sbuf.updating is permanently stuck
                const retryCount = ((window as any).__nobuf_evictRetryCount ?? 0) + 1;
                (window as any).__nobuf_evictRetryCount = retryCount;

                if (retryCount > 10) {
                  diagLog(`[MPEGTS-BUFFER-FULL] Eviction retries exhausted (${retryCount}) — force-clearing flags and resuming`);
                  (window as any).__nobuf_bufferFullDetected = false;
                  (window as any).__nobuf_removeInProgress = false;
                  (window as any).__nobuf_evictRetryCount = 0;
                  if (mseCtrl?._isBufferFull) mseCtrl._isBufferFull = false;
                  try { lc.resumeTransmuxer(); } catch (_) {}
                  return;
                }

                // NOTE: Do NOT clear _isBufferFull here — the quota guard needs
                // to see it as true to trigger eviction. The quota guard's
                // onEvictDone callback will clear it after successful eviction.
                // if (mseCtrl?._isBufferFull) mseCtrl._isBufferFull = false;

                const sb2 = video?.buffered;
                if (!sb2 || sb2.length === 0) return;

                // ── FIX _resumeFrom: point to SourceBuffer's END, not loader's end ──
                // The io-controller's _resumeFrom was set during abort() to the byte
                // offset of the last chunk the LOADER delivered (which may be well past
                // the SourceBuffer's content if appendBuffer failed with QuotaExceeded).
                // If we resume from there, new data timestamps start beyond the
                // SourceBuffer's content → TIMESTAMP GAP → video stalls at gap edge.
                const currentBufEnd = sb2.end(sb2.length - 1);
                const dur = video!.duration || mpegtsDurationRef.current || 0;
                const fileLen = state.current.fileLength || 0;
                if (dur > 0 && fileLen > 0) {
                  const bytePerSec = fileLen / dur;
                  // Round DOWN to nearest 188-byte TS packet boundary
                  // If we don't align, the TSDemuxer sees a byte mid-packet
                  // (sync_byte=235 instead of 0x47) and rejects all data.
                  const rawByte = Math.floor(currentBufEnd * bytePerSec);
                  const sbEndByte = Math.floor(rawByte / 188) * 188;
                  const ioCtrl = engine._transmuxer?._controller?._ioctl;
                  if (ioCtrl) {
                    const oldResume = ioCtrl._resumeFrom || 0;
                    ioCtrl._resumeFrom = sbEndByte;
                    diagLog(`[MPEGTS] BUFFER_FULL recovery: _resumeFrom ${oldResume} → ${sbEndByte} (bufEnd=${currentBufEnd.toFixed(1)}s, bytePerSec=${bytePerSec.toFixed(0)})`);
                  }
                }

                // ── Evict backward data (everything behind playhead) ──
                const evictBefore = video!.currentTime;
                const evictAfter = evictBefore + 120;  // keep 2min ahead (SB can't hold more)
                const ms = mseCtrl?.getObject?.();
                const sourceBuffers = ms?.sourceBuffers;

                let didEvict = false;
                if (sourceBuffers && sourceBuffers.length > 0) {
                  for (let i = 0; i < sourceBuffers.length; i++) {
                    const sbuf = sourceBuffers[i];
                    if (sbuf.updating) continue;  // can't remove while updating
                    if (sbuf.buffered.length > 0) {
                      if (evictBefore > 0 && sbuf.buffered.start(0) < evictBefore) {
                        try {
                          diagLog(`[MPEGTS-BUFFER-FULL] Evicting [0, ${evictBefore.toFixed(1)}) from SourceBuffer[${i}]`);
                          sbuf.remove(0, evictBefore);
                          didEvict = true;
                        } catch (e: any) {
                          diagLog(`[MPEGTS-BUFFER-FULL] Evict failed: ${e.message}`);
                        }
                      }
                      // Only evict far-ahead tail if SB is still not updating
                      if (!sbuf.updating && sbuf.buffered.length > 0 && sbuf.buffered.end(sbuf.buffered.length - 1) > evictAfter) {
                        try {
                          diagLog(`[MPEGTS-BUFFER-FULL] Evicting ahead tail [${evictAfter.toFixed(1)}, ${sbuf.buffered.end(sbuf.buffered.length - 1).toFixed(1)}) from SourceBuffer[${i}]`);
                          sbuf.remove(evictAfter, sbuf.buffered.end(sbuf.buffered.length - 1));
                          didEvict = true;
                        } catch (_) {}
                      }
                    }
                  }
                }

                if (!didEvict) {
                  // Could not evict (sbuf.updating stuck?) — retry after 200ms
                  diagLog(`[MPEGTS-BUFFER-FULL] Could not evict (sbuf.updating stuck?) — retrying in 200ms`);
                  setTimeout(doEvictAndResume, 200);
                  return;
                }

                // ── WAIT for remove() to complete before resuming ──
                // The remove() is async — sbuf.updating=true until updateend fires.
                // Resuming before the remove completes means appendBuffer will fail again.
                const lastSbuf = sourceBuffers[sourceBuffers.length - 1];
                const onResumeAfterEvict = () => {
                  lastSbuf.removeEventListener('updateend', onResumeAfterEvict);
                  lastSbuf.removeEventListener('error', onResumeAfterEvict);
                  (window as any).__nobuf_removeInProgress = false;
                  (window as any).__nobuf_bufferFullDetected = false;
                  if (mseCtrl?._isBufferFull) mseCtrl._isBufferFull = false;
                  diagLog(`[MPEGTS-BUFFER-FULL] Eviction complete, resuming download (playhead=${video?.currentTime?.toFixed(1)}s)`);
                  try {
                    lc.resumeTransmuxer();
                  } catch (e: any) {
                    diagLog(`[MPEGTS-BUFFER-FULL] Resume after eviction failed: ${e.message}`);
                    setTimeout(() => {
                      if (lc?._paused) {
                        try { lc.resumeTransmuxer(); } catch (_) {}
                      }
                    }, 500);
                  }
                };
                (window as any).__nobuf_removeInProgress = true;
                lastSbuf.addEventListener('updateend', onResumeAfterEvict);
                lastSbuf.addEventListener('error', onResumeAfterEvict);
              };

              // Delay 50ms (not 200ms) — SourceBuffer's updateend from the failed
              // appendBuffer has already fired (that's what triggered BUFFER_FULL).
              setTimeout(doEvictAndResume, 50);
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
      // With lazyLoadMaxDuration=9999, lazyLoad NEVER suspends for "too much buffer ahead".
      // Only SourceBuffer quota (BUFFER_FULL) triggers suspendTransmuxer.
      // This guard runs every 100ms and detects BUFFER_FULL via:
      //   1. mseCtrl._isBufferFull === true (set after BUFFER_FULL event)
      //   2. totalBuffered > QUOTA_DANGER_DURATION (proactive eviction)
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
      const QUOTA_DANGER_DURATION = 150;  // ahead > 150s — start proactive eviction
      const QUOTA_KEEP_AHEAD = 120;       // keep 2 min ahead — SourceBuffer can't hold 10min
      // NOTE: With ~270s SourceBuffer quota at 4Mbps, 10min ahead (600s ≈ 300MB) is 
      // impossible. Keep 120s ahead in SB, rest stays in shadow cache for re-download.
      // proactive at ahead>150 is KEPT as backup trigger for edge cases.
      // NOTE: proactive eviction at ahead>150 can cause remove() spam that's slower than
      // the download. Only do it when we're approaching the real byte quota.
      let _aggressiveCleanupActive = false;
      let _removeInProgress = false;  // true while sb.remove() is pending
      (window as any).__nobuf_removeInProgress = false;
      // _bufferFullDetected is tracked via (window).__nobuf_bufferFullDetected
      // because the suspendTransmuxer patch (defined earlier) can't access this closure.
      (window as any).__nobuf_quotaGuardAggressive = false;
      (window as any).__nobuf_bufferFullDetected = false; // accessible from suspendTransmuxer patch
      (window as any).__nobuf_evictScheduled = false;     // accessible from ERROR handler eviction
      (window as any).__nobuf_ptsDuration = 0;             // clear PTS-based duration

      // Helper: resume download AND register timeupdate listener for auto-recovery.
      // With lazyLoad=true, the timeupdate listener IS registered by mpegts.js
      // via _suspendTransmuxerIfBufferedPositionExceeded. But if we reach here
      // from a BUFFER_FULL path (rather than lazyLoad suspend), the listener
      // might not be registered. We add it as a safety measure.
      const resumeWithAutoRecovery = (lc: any) => {
        if (!lc || !lc._paused) {
          diagLog(`[MPEGTS-QUOTA] resumeWithAutoRecovery: SKIP (lc=${!!lc}, paused=${lc?._paused})`);
          return;
        }
        try {
          diagLog('[MPEGTS-QUOTA] resumeWithAutoRecovery: calling resumeTransmuxer()');
          lc.resumeTransmuxer();
          // Register timeupdate listener so mpegts.js can auto-resume in future
          // BUFFER_FULL cycles (same as _suspendTransmuxerIfBufferedPositionExceeded
          // does, but that path doesn't register the listener for BUFFER_FULL).
          lc._media_element?.addEventListener('timeupdate', lc.e?.onMediaTimeUpdate);
        } catch (e: any) {
          diagLog(`[MPEGTS] resumeWithAutoRecovery failed: ${e.message}`);
        }
      };

      const sourceBufferQuotaGuard = () => {
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

        // Calculate total buffered duration
        let totalBuffered = 0;
        for (let i = 0; i < sb.length; i++) {
          totalBuffered += sb.end(i) - sb.start(i);
        }
        const bufEnd = sb.end(sb.length - 1);
        const ahead = bufEnd - curTime;

        // ── HEAVY DEBUG: periodic state dump every ~5s ──
        // Logs download state, buffer state, shadow cache state
        const now = performance.now();
        if (!(sourceBufferQuotaGuard as any)._lastDump || now - (sourceBufferQuotaGuard as any)._lastDump > 5000) {
          (sourceBufferQuotaGuard as any)._lastDump = now;
          const cache = shadowCacheRef.current;
          const cacheRanges: Array<{start: number, end: number}> = cache ? cache.entryRanges ?? [] : [];
          const cacheBytes = cacheRanges.reduce((sum: number, r: {start: number, end: number}) => sum + (r.end - r.start), 0);
          diagLog(`[MPEGTS-STATE] ct=${curTime.toFixed(1)}s bufEnd=${bufEnd.toFixed(1)}s ahead=${ahead.toFixed(1)}s totalBuf=${totalBuffered.toFixed(1)}s paused=${isPaused} bufFull=${isBufferFull} _resumeFrom=${resumeFrom} cacheBytes=${(cacheBytes/1048576).toFixed(1)}MB cacheRanges=${cacheRanges.length} aggressive=${_aggressiveCleanupActive} removeInProgress=${_removeInProgress}`);
        }

        // ── Only evict when SourceBuffer quota is ACTUALLY hit ──
        // Proactive eviction at ahead>150 causes remove() spam that's slower
        // than the download (3072x speed). The SourceBuffer gets stuck updating=true
        // while the download keeps appending → BUFFER_FULL cascade.
        // Instead, let the download run until actual byte quota is hit, then
        // do ONE big sb.remove(0, curTime) to free space instantly.
        const needsEviction = isBufferFull;

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

          // 1. Evict backward data behind playhead to free SourceBuffer byte quota.
          //    Keep up to 10min ahead (QUOTA_KEEP_AHEAD) — only evict the far-ahead tail
          //    if the buffer extends beyond that AND we need more quota room.
          const evictBefore = curTime;  // evict EVERYTHING behind playhead
          const evictAfter = curTime + QUOTA_KEEP_AHEAD;  // only evict beyond 10min ahead
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

            for (let i = 0; i < sourceBuffers.length; i++) {
              const sbuf = sourceBuffers[i];
              if (!sbuf.updating && sbuf.buffered.length > 0) {
                // Evict backward: remove EVERYTHING from 0 to curTime in ONE call.
                // MSE remove(start, end) removes all data in [start, end) regardless of
                // how many individual buffered ranges exist — no need to iterate.
                if (evictBefore > 0 && sbuf.buffered.start(0) < evictBefore) {
                  try {
                    _removeInProgress = true;
                    (window as any).__nobuf_removeInProgress = true;
                    diagLog(`[MPEGTS-QUOTA] Evicting backward: [0, ${evictBefore.toFixed(1)})`);
                    sbuf.remove(0, evictBefore);
                    evicted = true;
                    // After remove(), sbuf.updating=true — can't do another remove on this SB.
                    // Skip ahead-tail eviction for this SourceBuffer.
                    continue;
                  } catch (e: any) { _removeInProgress = false; (window as any).__nobuf_removeInProgress = false; diagLog(`[MPEGTS-QUOTA] Backward eviction FAILED: ${e.message}`); }
                }
                // Evict far-ahead tail beyond QUOTA_KEEP_AHEAD (10min)
                // Only try if we did NOT just do backward eviction (sbuf.updating would be true)
                if (!sbuf.updating && sbuf.buffered.length > 0 && sbuf.buffered.end(sbuf.buffered.length - 1) > evictAfter) {
                  try {
                    _removeInProgress = true;
                    (window as any).__nobuf_removeInProgress = true;
                    diagLog(`[MPEGTS-QUOTA] Evicting ahead tail: [${evictAfter.toFixed(1)}, ${sbuf.buffered.end(sbuf.buffered.length - 1).toFixed(1)})`);
                    sbuf.remove(evictAfter, sbuf.buffered.end(sbuf.buffered.length - 1));
                    evicted = true;
                  } catch (e: any) { _removeInProgress = false; (window as any).__nobuf_removeInProgress = false; diagLog(`[MPEGTS-QUOTA] Ahead tail eviction FAILED: ${e.message}`); }
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
              const onEvictDone = () => {
                lastSbuf.removeEventListener('updateend', onEvictDone);
                lastSbuf.removeEventListener('error', onEvictDone);
                _removeInProgress = false;
                (window as any).__nobuf_removeInProgress = false;
                if (mseCtrl?._isBufferFull) mseCtrl._isBufferFull = false;
                // NOTE: Do NOT clear __nobuf_bufferFullDetected HERE —
                // the resumeTransmuxer wrapper reads it to decide whether
                // to save/restore _nextDts and set _resumeFrom.
                // The wrapper will clear it after restoring _nextDts.
                // Check if there's room now before resuming
                const sb2 = video.buffered;
                let totalBuf2 = 0;
                if (sb2 && sb2.length > 0) {
                  for (let j = 0; j < sb2.length; j++) {
                    totalBuf2 += sb2.end(j) - sb2.start(j);
                  }
                }
                // SAFETY: clear aggressive flag if eviction brought us below danger threshold
                const ahead2 = sb2 && sb2.length > 0 ? sb2.end(sb2.length - 1) - video.currentTime : 0;
                if (ahead2 < QUOTA_DANGER_DURATION || totalBuf2 < QUOTA_DANGER_DURATION) {
                  _aggressiveCleanupActive = false;
                  (window as any).__nobuf_quotaGuardAggressive = false;
                  const lc2 = (player as any)?._player_engine?._loading_controller;
                  resumeWithAutoRecovery(lc2);
                } else {
                  // Still over quota — resume download, next guard tick will evict more.
                  // But we MUST resume so the player doesn't stall.
                  const lc2 = (player as any)?._player_engine?._loading_controller;
                  resumeWithAutoRecovery(lc2);
                }
              };
              lastSbuf.addEventListener('updateend', onEvictDone);
              lastSbuf.addEventListener('error', onEvictDone);
            }
          }

          // 2. At t=0 (or early playback), there's nothing behind to evict.
          //    But we CAN evict the far-ahead tail (keep 120s ahead).
          //    If no eviction happened at all (nothing to evict), don't resume —
          //    mpegts.js will immediately re-suspend on BUFFER_FULL.
          //    The video continues playing from already-buffered data.

        } else {
          // ── Quota pressure relieved ──

          if (_aggressiveCleanupActive && !isBufferFull) {
            _aggressiveCleanupActive = false;
            (window as any).__nobuf_quotaGuardAggressive = false;
            (sourceBufferQuotaGuard as any)._loggedStuckUpdating = false;
            (sourceBufferQuotaGuard as any)._loggedSbState = false;
            diagLog(`[MPEGTS-QUOTA] Aggressive cleanup CLEARED: ahead=${ahead.toFixed(1)}s < ${QUOTA_DANGER_DURATION}s, bufFull=${isBufferFull}`);
          }

          // Resume download if paused but quota is OK.
          // With lazyLoadMaxDuration=9999, lazyLoad NEVER suspends for "too much
          // buffer ahead", so if download is paused, it's either:
          //   1. BUFFER_FULL that our suspendTransmuxer patch didn't recover from
          //   2. A stale pause from an earlier BUFFER_FULL cycle
          // In either case, if ahead < QUOTA_DANGER_DURATION and isBufferFull is false,
          // we can safely resume. We don't resume during active aggressive cleanup to
          // avoid oscillation (eviction is in progress, wait for it to finish).
          if (isPaused && !_aggressiveCleanupActive && !_removeInProgress && !isBufferFull) {
            diagLog(`[MPEGTS-QUOTA] Download PAUSED but quota OK (ahead=${ahead.toFixed(1)}s, totalBuf=${totalBuffered.toFixed(1)}s, bufFull=${isBufferFull}) → resuming`);
            if (mseCtrl?._isBufferFull) mseCtrl._isBufferFull = false;
            (window as any).__nobuf_bufferFullDetected = false;
            resumeWithAutoRecovery(lc);
          }
        }
      };
      // At 16x, timeupdate (250ms) = 4s of content. Too slow to catch
      // buffer drain and resume before video stalls.
      const quotaGuardInterval = setInterval(sourceBufferQuotaGuard, 100);
      quotaGuardIntervalRef.current = quotaGuardInterval;
      quotaGuardHandlerRef.current = sourceBufferQuotaGuard;
      video.addEventListener('timeupdate', sourceBufferQuotaGuard); // also on timeupdate for coverage

      // ── Shadow cache trim: keep ±10 min of raw bytes around playhead ──
      // At 4Mbps, ±10min = ±300MB each side. Cache budget (300MB) may trim
      // to ±5min at high bitrate, but the eviction handles this naturally.
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
      diagLog('[MPEGTS] Continuous download mode (lazyLoadMax=9999, quota guard manages BUFFER_FULL)');

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
  const _mpegtsUnbufferedSeek = (timeSeconds: number, duration: number) => {
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
    const RAW_BYTE_OFFSET = Math.floor((timeSeconds / duration) * filesize);
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
        }

        // --- MP4Remuxer reset ---
        if (tController._remuxer) {
          const remuxer = tController._remuxer as any;

          // seek() clears stashed samples and segment info lists (but NOT _dtsBaseInited)
          remuxer.seek?.();

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
        lazyLoad: true,                // 2 min ahead — prevents SourceBuffer quota overflow
        lazyLoadMaxDuration: 120,      // 2 min ahead — MUST be < SourceBuffer quota (~150s)
        lazyLoadRecoverDuration: 30,   // Resume 30s before buffer end
        seekType: 'range',
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 600,  // 10 min behind
        autoCleanupMinBackwardDuration: 300,
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
   * NEW TS→fMP4 pipeline: Uses backend /fmp4/ endpoints instead of mux.js.
   * The backend transmuxes TS→fMP4, returning proper fMP4 init + media segments.
   * Frontend appends them directly to MSE SourceBuffer — same as the MP4 path.
   * This avoids mux.js's broken push-based streaming that causes 10-24s appendBuffer stalls.
   */
  const _initTsFmp4Pipeline = async (
    url: string,
    mediaSource: MediaSource,
    _blobUrl: string,
    _format: string,
    _firstChunkData: ArrayBuffer | null,
  ): Promise<boolean> => {
    diagLog('[MSE-TS-FMP4] Starting TS→fMP4 pipeline');

    const parsed = parseStreamUrl(url);
    if (!parsed) {
      diagLog('[MSE-TS-FMP4] Failed to parse stream URL, falling back to mux.js');
      return false;
    }

    const { baseUrl, folderId, messageId, token } = parsed;
    const fmp4BaseUrl = `${baseUrl}/fmp4`;
    const queryParams = `token=${encodeURIComponent(token)}`;

    // Step 1: Fetch metadata (duration, codec info)
    let duration = 0;
    let videoCodec = 'avc';
    let mimeType = 'video/mp4; codecs="avc1.64001f,mp4a.40.2"';
    try {
      const metaResp = await fetch(`${fmp4BaseUrl}/metadata/${folderId}/${messageId}?${queryParams}`);
      if (metaResp.ok) {
        const meta = await metaResp.json();
        duration = meta.duration_s || 0;
        videoCodec = meta.video_codec || 'avc';
        if (meta.mime_type) {
          mimeType = meta.mime_type;
        }
        state.current.duration = duration;
        state.current.fileLength = meta.total_size || 0;
        if (state.current.fileLength > 0) {
          setTotalBytes(state.current.fileLength);
        }
        diagLog(`[MSE-TS-FMP4] Metadata: duration=${duration}s, codec=${videoCodec}, mime=${mimeType}`);
      }
    } catch (e) {
      diagLog(`[MSE-TS-FMP4] Metadata fetch failed: ${e}`);
    }

    // Fallback: use fileLength from HEAD request if metadata didn't provide it
    if (!state.current.fileLength || state.current.fileLength === 0) {
      try {
        const headResp = await fetch(url, { method: 'HEAD' });
        const headLen = headResp.headers.get('Content-Length');
        if (headLen) {
          state.current.fileLength = parseInt(headLen, 10);
          setTotalBytes(state.current.fileLength);
        }
      } catch {}
    }

    // Step 2: Check codec support — HEVC not supported by MSE in WebView2
    if (videoCodec === 'hevc' || mimeType.includes('hvc1') || mimeType.includes('hev1')) {
      if (!MediaSource.isTypeSupported(mimeType)) {
        diagLog('[MSE-TS-FMP4] HEVC not supported by MSE, falling back');
        return false;
      }
    }

    // Step 3: Fetch fMP4 init segment
    let initSegmentData: ArrayBuffer;
    try {
      const initResp = await fetch(`${fmp4BaseUrl}/init/${folderId}/${messageId}?${queryParams}`);
      if (!initResp.ok) {
        throw new Error(`Init segment fetch failed: ${initResp.status}`);
      }
      // Read mime type from response header if not already set
      const respMimeType = initResp.headers.get('X-Mime-Type');
      const respVideoCodec = initResp.headers.get('X-Video-Codec');
      const respAudioCodec = initResp.headers.get('X-Audio-Codec');
      if (respMimeType && !mimeType.includes('codecs=')) {
        // Only override if we don't already have codecs
        if (respVideoCodec && respAudioCodec) {
          mimeType = `${respMimeType}; codecs="${respVideoCodec},${respAudioCodec}"`;
        }
      }
      const respTotalSize = initResp.headers.get('X-Total-File-Size');
      if (respTotalSize && !state.current.fileLength) {
        state.current.fileLength = parseInt(respTotalSize, 10);
        setTotalBytes(state.current.fileLength);
      }
      initSegmentData = await initResp.arrayBuffer();
      diagLog(`[MSE-TS-FMP4] Init segment: ${initSegmentData.byteLength} bytes, mime=${mimeType}`);
    } catch (e) {
      diagLog(`[MSE-TS-FMP4] Init segment fetch failed: ${e}, falling back to mux.js`);
      return false;
    }

    // Step 4: Create SourceBuffer and append init segment
    if (!MediaSource.isTypeSupported(mimeType)) {
      diagLog(`[MSE-TS-FMP4] MSE doesn't support mime: ${mimeType}, falling back`);
      return false;
    }

    // Patch mvhd duration to a finite value (same as MP4/MKV paths)
    const patchedInit = (duration > 0 && isFinite(duration))
      ? patchMvhdDuration(initSegmentData, duration)
      : initSegmentData;

    // Combined SourceBuffer for fMP4 (backend produces combined video+audio segments)
    let sourceBuffer: SourceBufferWrapper;
    try {
      const sb = mediaSource.addSourceBuffer(mimeType);
      sourceBuffer = new SourceBufferWrapper(sb);
      sourceBuffer.setTimestampOffset(0);
      state.current.videoSourceBuffer = sourceBuffer;
      state.current.audioSourceBuffer = null; // Combined SB, no separate audio
      diagLog(`[MSE-TS-FMP4] Created combined SourceBuffer: ${mimeType}`);
    } catch (e: any) {
      diagLog(`[MSE-TS-FMP4] Failed to create SourceBuffer: ${e}, falling back`);
      return false;
    }

    // Cache init segment for re-append after seek
    initSegmentsRef.current = [{ id: 1, buffer: patchedInit.slice(0) }];

    // Append init segment
    sourceBuffer.appendBuffer(patchedInit);
    await sourceBuffer.waitForQueueDrain();
    diagLog('[MSE-TS-FMP4] Init segment appended successfully');

    // Step 5: Fetch keyframe index (async, non-blocking)
    fetch(`${fmp4BaseUrl}/keyframes/${folderId}/${messageId}?${queryParams}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.keyframes) {
          byteToTimeTableRef.current = data.keyframes.map((kf: any) => [kf.byte_offset, kf.timestamp_s] as [number, number]);
          setKeyframeIndexReady(true);
          diagLog(`[MSE-TS-FMP4] Keyframe index: ${data.keyframes.length} entries`);
        }
      })
      .catch(e => diagLog(`[MSE-TS-FMP4] Keyframe index fetch failed (non-critical): ${e}`));

    // Step 6: Set duration on MediaSource
    if (duration > 0 && isFinite(duration) && mediaSource.readyState === 'open') {
      try {
        mediaSource.duration = duration;
      } catch (_e) {
        setTimeout(() => { try { mediaSource.duration = duration; } catch (_) {} }, 100);
      }
    }

    // Fallback: estimate duration from fileLength if metadata didn't provide it
    if (!state.current.duration || state.current.duration === 0 || !isFinite(state.current.duration)) {
      if (file?.duration && file.duration > 0 && isFinite(file.duration)) {
        state.current.duration = file.duration;
        diagLog(`[MSE-TS-FMP4] Using telegramDuration=${file.duration}s`);
      } else if (state.current.fileLength > 0) {
        const estimatedBitrate = 3_000_000;
        state.current.duration = state.current.fileLength / estimatedBitrate;
        state.current.bitrate = estimatedBitrate;
        diagLog(`[MSE-TS-FMP4] Estimated duration: ${state.current.duration.toFixed(1)}s from fileSize=${state.current.fileLength} / 3Mbps`);
      }
    }

    if (state.current.fileLength > 0 && state.current.duration > 0 && isFinite(state.current.duration)) {
      state.current.bitrate = state.current.fileLength / state.current.duration;
    }

    // Mark as initialized — MSE is ready to receive segments
    state.current.initialized = true;
    transmuxerInitInProgressRef.current = false;
    fmp4PipelineActiveRef.current = true;
    // DO NOT set transmuxerRef.current — this ensures isTransmuxer() returns false,
    // so the MP4-style thumbnail pipeline is used instead of the WebCodecs+mediabunny TS pipeline.

    // Store fMP4 config for thumbnail pipeline
    fmp4ConfigRef.current = {
      baseUrl: fmp4BaseUrl,
      folderId,
      messageId,
      queryParams,
      mimeType,
      duration: state.current.duration,
    };

    // Clear init timeout
    if (initTimeoutRef.current !== null) {
      clearTimeout(initTimeoutRef.current);
      initTimeoutRef.current = null;
    }

    setIsPrefetching(true);
    setSpeed(0);
    setThumbnailDataReady(true);

    // Step 7: Start progressive download loop for fMP4 segments
    // Reset byte/time offsets for initial playback (seek code sets these itself)
    fmp4CurrentByteOffsetRef.current = 0;
    fmp4CurrentTimeRef.current = 0;
    fmp4ExpectedStartTimeRef.current = 0;

    const fmp4DownloadLoop = async () => {
      const gen = ++loopGeneration.current;
      state.current.downloading = true;
      let segmentNumber = 1;
      let consecutiveErrors = 0;
      let cacheWaitErrors = 0; // Separate counter for cache-boundary waits (500/503)
      const MAX_CONSECUTIVE_ERRORS = 10; // Hard limit for non-cache errors
      const MAX_CACHE_WAIT_ATTEMPTS = 60; // Allow up to ~5 min of waiting for cache (60 × 5s)
      const targetDuration = 5.0; // 5-second segments
      const maxBufferAhead = MAX_BUFFER_AHEAD_SECONDS; // 30 seconds

      // Helper: check if error message indicates a cache-boundary issue
      // (data not yet downloaded from Telegram, stream info missing from partial data, etc.)
      const isCacheBoundaryError = (status: number, errorMsg: string): boolean => {
        if (status === 503) return true; // 503 always means "not ready yet"
        if (status === 500) {
          const lower = errorMsg.toLowerCase();
          // These messages from fmp4_segment indicate the data isn't cached yet
          return lower.includes('stream info') ||
                 lower.includes('cache') ||
                 lower.includes('data file') ||
                 lower.includes('not yet') ||
                 lower.includes('waiting for') ||
                 lower.includes('extraction failed') ||
                 lower.includes('read failed') ||
                 lower.includes('seek failed');
        }
        return false;
      };

      // Helper: poll backend cache status and wait until the download has progressed
      // past the current byte offset. Returns the new cached_bytes count, or -1 on failure.
      const waitForDownloadProgress = async (currentOffset: number, minWaitMs: number): Promise<number> => {
        const deadline = Date.now() + 120_000; // Max 2 minutes waiting for progress
        let lastCachedBytes = 0;
        let staleCount = 0;

        // First, wait the minimum delay
        await new Promise(r => setTimeout(r, minWaitMs));

        while (Date.now() < deadline) {
          if (cancelledRef.current || gen !== loopGeneration.current) return -1;

          try {
            const status = await invoke<any>('cmd_get_cache_status', { messageId: file?.id });
            if (status && status.cached_bytes !== undefined) {
              lastCachedBytes = status.cached_bytes;

              // Check if any cached range covers our needed offset
              if (status.cached_ranges && Array.isArray(status.cached_ranges)) {
                for (const [start, end] of status.cached_ranges) {
                  if (start <= currentOffset && end >= currentOffset) {
                    diagLog(`[MSE-TS-FMP4] Cache now covers offset ${currentOffset} (range ${start}-${end}), cached_bytes=${status.cached_bytes}`);
                    return status.cached_bytes;
                  }
                }
              }

              // If cached_bytes has progressed past our offset, data should be available
              if (status.cached_bytes > currentOffset) {
                diagLog(`[MSE-TS-FMP4] Download progressed past offset ${currentOffset} (cached_bytes=${status.cached_bytes}), retrying segment`);
                return status.cached_bytes;
              }

              // File is fully cached — definitely ready
              if (status.is_complete) {
                diagLog(`[MSE-TS-FMP4] File fully cached, retrying segment`);
                return status.cached_bytes;
              }

              // Check if progress is stale (no new bytes for several polls)
              if (status.cached_bytes === lastCachedBytes) {
                staleCount++;
              } else {
                staleCount = 0;
              }
            }
          } catch {
            // cmd_get_cache_status might not be available — just wait and retry segment
            break;
          }

          // If no progress after several polls, still continue waiting but log
          if (staleCount >= 10) {
            diagLog(`[MSE-TS-FMP4] Download appears stalled (cached_bytes=${lastCachedBytes} unchanged for ${staleCount} polls), continuing to wait...`);
            staleCount = 0; // Reset to avoid spamming
          }

          // Wait 2 seconds between polls (don't hammer the backend)
          await new Promise(r => setTimeout(r, 2000));
        }

        return lastCachedBytes;
      };

      diagLog(`[MSE-TS-FMP4] Starting download loop, total_size=${state.current.fileLength}, duration=${state.current.duration}`);

      while (fmp4CurrentByteOffsetRef.current < state.current.fileLength) {
        // Check cancellation
        if (cancelledRef.current || gen !== loopGeneration.current) {
          diagLog('[MSE-TS-FMP4] Download loop cancelled (generation mismatch or cancelled)');
          break;
        }

        // Bug #4 fix: check if SourceBuffer is fatally broken
        if (sourceBuffer.hasFatalError) {
          diagLog('[MSE-TS-FMP4] SourceBuffer fatal error — stopping download loop');
          break;
        }

        // Gap-aware backpressure: if the SourceBuffer has gaps between
        // buffered ranges, we MUST keep fetching to fill them.  Without
        // this check, Chrome stalls at a gap → playback doesn't advance
        // → ahead never decreases → download loop deadlocks waiting for
        // backpressure that can never be relieved.
        const sbRanges = sourceBuffer.buffered;
        let hasGaps = false;
        if (sbRanges.length > 1) {
          // Multiple buffered ranges ⇒ there's at least one gap between them
          hasGaps = true;
        } else if (sbRanges.length === 1) {
          // Check if there's a gap between the start of buffered data and position 0
          if (sbRanges.start(0) > 0.5) hasGaps = true;
        }

        // Quota-aware backpressure: when QuotaExceededError is set, pause
        // downloading until the player consumes buffer and eviction frees space.
        if (sourceBuffer.isQuotaExceeded) {
          evictOldBuffer();
          if (sourceBuffer.isQuotaExceeded) {
            // Still over quota — wait for player to consume buffer
            await new Promise(r => setTimeout(r, 2000));
            sourceBuffer.clearQuotaExceeded(); // Try again after wait
            continue;
          }
        }

        // Backpressure check — skip when there are gaps so we can fetch
        // the data needed to fill them.
        if (!hasGaps) {
          while (!cancelledRef.current && state.current.downloading && gen === loopGeneration.current) {
            const ahead = getBufferedAheadSeconds();
            if (ahead <= maxBufferAhead) break;
            await new Promise(r => setTimeout(r, 2000));
            evictOldBuffer();
          }
        }
        if (cancelledRef.current || !state.current.downloading || gen !== loopGeneration.current) break;

        // Fetch next fMP4 segment using byte_offset-based sequential playback.
        // byte_offset determines WHERE to read from (no Fmp4ByteTimeCache lookup needed).
        // time is also passed for PTS overlap filtering (align=none mode) to
        // prevent SourceBuffer duplicates from the overlap region.
        // Seeking uses time=T&align=keyframe (separate path).
        // min_time tells the backend to drop frames with PTS before this time
        // (the end PTS of the previous segment), avoiding duplicates from overlap.
        const minTime = segmentNumber > 1 ? fmp4CurrentTimeRef.current : 0;
        const segUrl = `${fmp4BaseUrl}/segment/${folderId}/${messageId}?${queryParams}&byte_offset=${fmp4CurrentByteOffsetRef.current}&time=${fmp4CurrentTimeRef.current}&min_time=${minTime}&duration=${targetDuration}&segment_sequence=${segmentNumber}&align=none`;

        let segResp: Response;
        try {
          segResp = await fetch(segUrl);
        } catch (e) {
          diagLog(`[MSE-TS-FMP4] Segment fetch error: ${e}`);
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            diagLog(`[MSE-TS-FMP4] Too many consecutive non-cache errors (${consecutiveErrors}), stopping download loop`);
            break;
          }
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        if (cancelledRef.current || gen !== loopGeneration.current) break;

        if (segResp.status === 503) {
          // Download in progress on backend — honor Retry-After header.
          // 503 is a known wait state, NOT a real error — don't count against consecutiveErrors.
          const retryAfter = parseInt(segResp.headers.get('Retry-After') || '2', 10) * 1000;
          cacheWaitErrors++;
          if (cacheWaitErrors >= MAX_CACHE_WAIT_ATTEMPTS) {
            diagLog(`[MSE-TS-FMP4] Too many cache wait attempts (${cacheWaitErrors}), stopping download loop`);
            break;
          }
          if (cacheWaitErrors % 10 === 1) {
            diagLog(`[MSE-TS-FMP4] Segment 503 (cache wait #${cacheWaitErrors}), retrying after ${retryAfter}ms, offset=${fmp4CurrentByteOffsetRef.current}`);
          }
          // Wait for download to progress before retrying
          await waitForDownloadProgress(fmp4CurrentByteOffsetRef.current, retryAfter);
          continue;
        }

        if (!segResp.ok) {
          // Try to extract error message from response body
          let errorMsg = '';
          try { errorMsg = await segResp.text(); } catch {}
          diagLog(`[MSE-TS-FMP4] Segment fetch failed: ${segResp.status} ${errorMsg.slice(0, 200)}`);
          if (segResp.status === 416 || segResp.status === 404) break; // End of file — permanent

          // Check if this is a cache-boundary error (data not downloaded yet)
          if (isCacheBoundaryError(segResp.status, errorMsg)) {
            cacheWaitErrors++;
            if (cacheWaitErrors >= MAX_CACHE_WAIT_ATTEMPTS) {
              diagLog(`[MSE-TS-FMP4] Too many cache wait attempts (${cacheWaitErrors}), stopping download loop. Last error: ${segResp.status} ${errorMsg.slice(0, 100)}`);
              break;
            }
            if (cacheWaitErrors % 5 === 1) {
              diagLog(`[MSE-TS-FMP4] Cache-boundary ${segResp.status} (wait #${cacheWaitErrors}), waiting for download to progress at offset=${fmp4CurrentByteOffsetRef.current}`);
            }
            // Wait for download progress — 5 seconds base delay for 500, shorter for others
            const baseDelay = segResp.status >= 500 ? 5000 : 2000;
            await waitForDownloadProgress(fmp4CurrentByteOffsetRef.current, baseDelay);
            // Reset regular consecutiveErrors since this isn't a "real" error
            consecutiveErrors = 0;
            continue;
          }

          // Non-cache error — count against the hard limit
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            diagLog(`[MSE-TS-FMP4] Too many consecutive non-cache errors (${consecutiveErrors}), stopping download loop`);
            break;
          }
          // Reset cache wait counter on a different kind of error
          cacheWaitErrors = 0;
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        const segData = await segResp.arrayBuffer();
        const segStartTime = parseFloat(segResp.headers.get('X-Segment-Start-Time') || '0');
        const segDuration = parseFloat(segResp.headers.get('X-Segment-Duration') || '0');
        const segEndTime = parseFloat(segResp.headers.get('X-Segment-End-Time') || '0');
        const nextOffset = parseInt(segResp.headers.get('X-Next-Byte-Offset') || '0', 10);
        const respTotalSize = segResp.headers.get('X-Total-File-Size');
        if (respTotalSize && state.current.fileLength === 0) {
          state.current.fileLength = parseInt(respTotalSize, 10);
          setTotalBytes(state.current.fileLength);
        }

        if (segData.byteLength === 0) {
          diagLog('[MSE-TS-FMP4] Empty segment, advancing offset');
          fmp4CurrentByteOffsetRef.current = nextOffset || fmp4CurrentByteOffsetRef.current + 500000;
          if (fmp4CurrentByteOffsetRef.current >= state.current.fileLength) break;
          continue;
        }

        // Evict old buffer before appending (same pattern as MP4/MKV)
        evictOldBuffer();

        // timestampOffset: NOT used with flush+overlap approach.
        // The backend's min_time filter removes overlap-region frames,
        // so segments are naturally contiguous. timestampOffset would
        // shift DTS and corrupt B-frame placement (causing SB fragmentation).

        // Safety net: set appendWindowStart to filter any overlap-region
        // frames that slipped past min_time. Use the end of the last SB range.
        if (segmentNumber > 1) {
          const sbRanges = sourceBuffer.buffered;
          if (sbRanges.length > 0) {
            const lastEnd = sbRanges.end(sbRanges.length - 1);
            // Only filter if there's actual overlap risk (segment starts before last buffer end)
            if (segStartTime < lastEnd - 0.1) {
              sourceBuffer.setAppendWindow(lastEnd - 0.05); // 50ms tolerance for B-frames
            } else {
              sourceBuffer.clearAppendWindow();
            }
          }
        }

        // Append to SourceBuffer
        try {
          sourceBuffer.appendBuffer(segData);
          await sourceBuffer.waitForQueueDrain();
        } catch (e) {
          diagLog(`[MSE-TS-FMP4] Segment append error: ${e}`);
          break;
        }

        if (segmentNumber <= 30) {
          diagLog(`[MSE-TS-FMP4] Segment ${segmentNumber}: ${segData.byteLength}b, start=${segStartTime.toFixed(2)}s, dur=${segDuration.toFixed(2)}s, end=${segEndTime.toFixed(2)}s`);
        }

        // Track byte ranges for green buffer bar (same pattern as MP4 downloadLoop)
        const segStartOffset = fmp4CurrentByteOffsetRef.current;
        const segEndOffset = nextOffset || segStartOffset + segData.byteLength;
        reportRangesToBackend(segStartOffset, segEndOffset - 1);
        trackDownloadedRange(segStartOffset, segEndOffset - 1);

        // *** KEY: Update byte_offset as PRIMARY position tracker ***
        // byte_offset drives the while-loop condition and the next segment URL.
        // Use X-Next-Byte-Offset from the server (accurate: capped_read_end + 1
        // rounded up to TS packet boundary). Fall back to advancing by
        // segData.byteLength if header is 0 or missing.
        if (nextOffset > 0) {
          fmp4CurrentByteOffsetRef.current = nextOffset;
        } else {
          fmp4CurrentByteOffsetRef.current += segData.byteLength;
        }

        // Also update time for seek-time tracking and PTS overlap filtering.
        // This is secondary — it's used in the URL's time= param so the
        // backend can filter out overlap-region frames.
        if (segEndTime > 0) {
          fmp4CurrentTimeRef.current = segEndTime;
        } else if (segStartTime > 0 && segDuration > 0) {
          fmp4CurrentTimeRef.current = segStartTime + segDuration;
        }

        // Update expected start time for timestampOffset of NEXT segment.
        // After appending, the SourceBuffer's buffered range end tells us
        // exactly where the data ended up in the timeline.
        const sbBufRanges = sourceBuffer.buffered;
        if (sbBufRanges.length > 0) {
          fmp4ExpectedStartTimeRef.current = sbBufRanges.end(sbBufRanges.length - 1);
        } else if (segEndTime > 0) {
          fmp4ExpectedStartTimeRef.current = segEndTime;
        }

        // Update progress
        state.current.currentOffset = segEndOffset;
        const now = Date.now();
        if (now - lastThrottleRef.current > 250) {
          lastThrottleRef.current = now;
          setPrefetchedBytes(segEndOffset);

          // Speed tracking
          speedHistory.current.push({ bytes: segData.byteLength, time: now });
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

        segmentNumber++;
        consecutiveErrors = 0; // Reset error counter on successful fetch
        cacheWaitErrors = 0;   // Reset cache wait counter on successful fetch
      }

      state.current.downloading = false;

      // Check if we reached the end
      const reachedEnd = fmp4CurrentByteOffsetRef.current >= state.current.fileLength;
      const exitReason = cancelledRef.current ? 'cancelled' :
                          gen !== loopGeneration.current ? 'generation-mismatch' :
                          sourceBuffer.hasFatalError ? 'fatal-error' :
                          reachedEnd ? 'end-of-file' : 'unknown';
      diagLog(`[MSE-TS-FMP4] Download loop exited: offset=${fmp4CurrentByteOffsetRef.current}, fileLength=${state.current.fileLength}, reachedEnd=${reachedEnd}, cacheWaitErrors=${cacheWaitErrors}, reason=${exitReason}`);

      if (!cancelledRef.current) {
        flushRangeReport();
        if (reachedEnd) {
          setIsComplete(true);
          isCompleteRef.current = true;
          hasEverCompletedRef.current = true;
          const ms = state.current.mediaSource;
          if (ms && ms.readyState === 'open') {
            try { ms.endOfStream(); diagLog('[MSE-TS-FMP4] endOfStream called'); } catch (e) { diagLog(`[MSE-TS-FMP4] endOfStream failed: ${e}`); }
          }
        }
        setIsPrefetching(false);
        setSpeed(0);
      }
    };

    // Store download loop ref and start it
    downloadLoopRef.current = () => fmp4DownloadLoop();
    fmp4DownloadLoop();

    // Periodically refresh keyframe index as more data gets cached
    if (keyframeRefreshTimerRef.current) clearInterval(keyframeRefreshTimerRef.current);
    keyframeRefreshTimerRef.current = setInterval(async () => {
      if (cancelledRef.current) return;
      try {
        const kfResp = await fetch(`${fmp4BaseUrl}/keyframes/${folderId}/${messageId}?${queryParams}`);
        if (kfResp.ok) {
          const kfData = await kfResp.json();
          if (kfData.keyframes && kfData.keyframes.length > byteToTimeTableRef.current.length) {
            diagLog(`[MSE-TS-FMP4] Keyframe index refreshed: ${byteToTimeTableRef.current.length} → ${kfData.keyframes.length} entries`);
            byteToTimeTableRef.current = kfData.keyframes.map((kf: any) => [kf.byte_offset, kf.timestamp_s]);
          }
        }
      } catch (_e) { /* ignore refresh errors */ }
    }, 30000); // Refresh every 30 seconds

    diagLog('[MSE-TS-FMP4] Pipeline initialized successfully');
    return true; // Signal success — new pipeline handles everything
  };

  /** Initialize the transmuxer player for TS/MKV files.
    *  TS format uses mux.js (push-based, no random access, no binary search).
    *  MKV/WebM uses Mediabunny (works well with Conversion API). */
  const initTransmuxerPlayerOriginal = async (url: string, mediaSource: MediaSource, _blobUrl: string, format: DetectedFormat, firstChunkData: ArrayBuffer) => {
    diagLog(`[MSE] initTransmuxerPlayer: format=${format}, seedData=${firstChunkData.byteLength} bytes (${(firstChunkData.byteLength/1024/1024).toFixed(1)}MB)`);

    // TS format: use mux.js (push-based, instant init, no binary search over HTTP)
    if (format === 'ts') {
      try {
        let muxJsMediaSegmentCount = 0;
        const tsAbortController = new AbortController();
        abortRef.current = tsAbortController;
        const muxTsTransmuxer = new MuxJsTsTransmuxer({
          url,
          fileSize: state.current.fileLength,
          firstChunkData,
          abortSignal: tsAbortController.signal,
          onInitSegment: (data: ArrayBuffer, _type: 'combined') => {
            if (cancelledRef.current) return;
            const patchedData = state.current.duration > 0 && isFinite(state.current.duration)
              ? patchMvhdDuration(data, state.current.duration)
              : data;
            diagLog(`[MSE] MuxJsTs combined init segment: ${patchedData.byteLength} bytes (cached)`);
            if (bufferingForSeekRef.current) {
              seekBufferRef.current.push({ type: 'init', data: patchedData.slice(0), timestamp: undefined, trackType: 'combined' });
              return;
            }
            initSegmentsRef.current = [{ id: 1, buffer: patchedData.slice(0) }];
          },
          onMediaSegment: (data: ArrayBuffer, timestamp: number, _type: 'combined') => {
            if (cancelledRef.current) return;
            if (bufferingForSeekRef.current) {
              seekBufferRef.current.push({ type: 'media', data: data.slice(0), timestamp, trackType: 'combined' });
              return;
            }
            // Burst buffer: store segment instead of appending during active playback.
            // Chrome's appendBuffer takes 10-24s during active playback; when
            // the video is paused, appends are instant (0-1ms). The drain loop
            // appends when the video stalls or buffer runs low.
            burstBufferRef.current.push({ data: data.slice(0), timestamp });
            muxJsMediaSegmentCount++;
            if (muxJsMediaSegmentCount <= 30) {
              diagLog(`[MSE] MuxJsTs burst-buffered seg #${muxJsMediaSegmentCount}: ${data.byteLength}B, ts=${timestamp.toFixed(3)}s, burstQueue=${burstBufferRef.current.length}`);
            }
            const absoluteTimestamp = timestamp + seekOffsetRef.current;
            if (absoluteTimestamp > 0 && state.current.duration > 0 && state.current.duration !== Infinity && state.current.fileLength > 0) {
              const estimatedBytes = Math.floor((absoluteTimestamp / state.current.duration) * state.current.fileLength);
              trackDownloadedRange(estimatedBytes, estimatedBytes + data.byteLength);
            }
          },
          onDurationKnown: (duration: number) => {
            if (cancelledRef.current) return;
            if (duration === Infinity && file?.duration && file.duration > 0 && isFinite(file.duration)) {
              diagLog(`[MSE] MuxJsTs duration: Infinity, using telegramDuration=${file.duration}s`);
              duration = file.duration;
            }
            diagLog(`[MSE] MuxJsTs duration known: ${duration}s`);
            state.current.duration = duration;
            if (state.current.fileLength > 0 && duration > 0 && duration !== Infinity) {
              state.current.bitrate = state.current.fileLength / duration;
            }
            if (duration !== Infinity && duration > 0) {
              try { mediaSource.duration = duration; } catch (_e) {
                setTimeout(() => { try { mediaSource.duration = duration; } catch (_) {} }, 100);
              }
            }
          },
          onSpeedUpdate: (speed: number) => {
            if (cancelledRef.current) return;
            setSpeed(speed);
          },
          onProgressUpdate: (streamingOffset: number) => {
            if (cancelledRef.current) return;
            setPrefetchedBytes(streamingOffset);
          },
          onWaitForQueue: async () => {
            // Backpressure: pause streaming when burst buffer is large.
            // The drain loop will consume the burst buffer when the video stalls.
            const burstSize = burstBufferRef.current.length;
            if (burstSize > 30) {
              diagLog(`[MSE] Burst buffer full (${burstSize} segments) — pausing streaming`);
              await new Promise<void>(r => setTimeout(r, 1000));
            }
          },
          getBufferedAhead: () => getBufferedAheadSeconds(),
          onCodecUnsupported: (codec: string) => {
            if (cancelledRef.current) return;
            diagLog(`[MSE] MuxJsTs codec unsupported: ${codec}`);
            setError(`Codec not supported for MSE playback: ${codec}`);
            setUseNative(true);
          },
          onError: (error: Error) => {
            if (cancelledRef.current) return;
            diagLog(`[MSE] MuxJsTs ERROR: ${error.message}`);
            setError(error.message);
            setUseNative(true);
          },
        });

        transmuxerInitInProgressRef.current = true;
        const result = await muxTsTransmuxer.init();
        if (!result || cancelledRef.current) {
          transmuxerInitInProgressRef.current = false;
          diagLog('[MSE] MuxJsTs init FAILED or cancelled — no result');
          return;
        }

        diagLog(`[MSE] MuxJsTs init success: mimeType=${result.mimeType}, videoCodec=${result.videoCodec}`);

        // Set UI duration from telegramDuration if available (without setting mediaSource.duration)
        if (file?.duration && file.duration > 0 && isFinite(file.duration)) {
          state.current.duration = file.duration;
          state.current.bitrate = state.current.fileLength / file.duration;
        }

        // Combined SourceBuffer for TS (remux:true produces combined segments)
        try {
          const sb = mediaSource.addSourceBuffer(result.mimeType);
          state.current.videoSourceBuffer = new SourceBufferWrapper(sb);
          state.current.videoSourceBuffer.setTimestampOffset(0);
          state.current.audioSourceBuffer = null;
          diagLog(`[MSE] Created combined SourceBuffer for TS: ${result.mimeType}`);
        } catch (e: any) {
          console.error(`[MSE] Failed to add SourceBuffer for TS:`, e);
          diagLog(`[MSE] SourceBuffer creation failed for TS — falling back to native`);
          setUseNative(true);
          transmuxerInitInProgressRef.current = false;
          return;
        }

        if (!state.current.duration || state.current.duration === 0 || !isFinite(state.current.duration)) {
          if (state.current.fileLength > 0) {
            const estimatedBitrate = 3_000_000;
            state.current.duration = state.current.fileLength / estimatedBitrate;
            state.current.bitrate = estimatedBitrate;
            diagLog(`[MSE] Estimated TS duration: ${state.current.duration.toFixed(1)}s from fileSize=${state.current.fileLength} / 3Mbps`);
          }
        }

        // Append init segment and first media segments from mux.js init
        initSegmentsRef.current = [];
        if (result.initSegment) {
          const patchedInit = state.current.duration > 0 && isFinite(state.current.duration)
            ? patchMvhdDuration(result.initSegment, state.current.duration)
            : result.initSegment;
          state.current.videoSourceBuffer?.appendBuffer(patchedInit);
          initSegmentsRef.current.push({ id: 1, buffer: patchedInit.slice(0) });
        }
        if (result.firstMediaSegment) {
          state.current.videoSourceBuffer?.appendBuffer(result.firstMediaSegment);
        }
        const sbV = state.current.videoSourceBuffer;
        if (sbV) await sbV.waitForQueueDrain();
        for (const seg of result.extraMediaSegments) {
          state.current.videoSourceBuffer?.appendBuffer(seg.data);
        }
        if (sbV) await sbV.waitForQueueDrain();

        if (state.current.duration > 0 && isFinite(state.current.duration)) {
          try {
            mediaSource.duration = state.current.duration;
            diagLog(`[MSE] Set mediaSource.duration=${state.current.duration.toFixed(1)}s after init segments processed`);
          } catch (_e) {
            setTimeout(() => {
              try { mediaSource.duration = state.current.duration; } catch (_) {}
            }, 100);
          }
        }

        transmuxerInitInProgressRef.current = false;
        state.current.initialized = true;
        if (initTimeoutRef.current !== null) {
          clearTimeout(initTimeoutRef.current);
          initTimeoutRef.current = null;
        }
        transmuxerRef.current = muxTsTransmuxer;
        setIsTransmuxerActive(true);

        // Build keyframe index in background
        setTimeout(() => {
          if (!cancelledRef.current && transmuxerRef.current) {
            transmuxerRef.current.buildKeyframeIndex().then(() => {
              if (!cancelledRef.current) {
                setKeyframeIndexReady(true);
                console.log('[MSE] Keyframe index ready — thumbnail pipeline will use it');
                // Build byteToTime lookup table from keyframe byte-offsets
                const offsets = transmuxerRef.current?.getKeyframeByteOffsets();
                if (offsets && offsets.length > 1) {
                  byteToTimeTableRef.current = offsets.map(kf => [kf.byteOffset, kf.timestamp] as [number, number]);
                }
              }
            }).catch((e) => {
              console.warn('[MSE] Keyframe index build failed (non-critical):', e);
            });
          }
        }, 0);

        // Start progressive streaming (push-based, different from mediabunny's Conversion)
        setIsPrefetching(true);
        setSpeed(0);

        // Burst drain loop: appends accumulated segments to SourceBuffer
        // when the video is paused/stalled (appends are 0-1ms when not decoding).
        // DEPRECATED: Only used by mux.js fallback. The fMP4 pipeline does not use burst buffering.
        // During active playback, Chrome's appendBuffer takes 10-24s per segment
        // because the decode pipeline blocks SourceBuffer operations.
        const startBurstDrainLoop = () => {
          const drain = async () => {
            if (drainInProgressRef.current || cancelledRef.current) return;
            const video = videoRef.current;
            const sb = state.current.videoSourceBuffer;
            if (!video || !sb || sb.hasFatalError) return;
            if (burstBufferRef.current.length === 0) return;

            const ahead = getBufferedAheadSeconds();
            const segments = burstBufferRef.current;
            const shouldDrain = ahead < 5 || video.paused || video.readyState < 3 || segments.length > 20;
            if (!shouldDrain) return;

            drainInProgressRef.current = true;
            const wasPlaying = !video.paused && !video.ended;
            if (wasPlaying) video.pause();

            burstBufferRef.current = [];

            // Reset SourceBuffer: remove all data, re-append init + new data.
            // Chrome's appendBuffer takes 10-28s when SB has existing data and
            // video has ever played. With empty SB, appends are 0-2ms.
            const drainStartTime = Date.now();

            try {
              sb.abort();
              const ranges = sb.buffered;
              if (ranges.length > 0) {
                sb.remove(ranges.start(0), ranges.end(ranges.length - 1));
                await sb.waitForQueueDrain();
              }

              const initSegs = initSegmentsRef.current;
              for (const seg of initSegs) {
                sb.appendBuffer(seg.buffer.slice(0));
              }
              if (initSegs.length > 0) {
                await sb.waitForQueueDrain();
              }

              for (const seg of segments) {
                sb.appendBuffer(seg.data);
              }
              await sb.waitForQueueDrain();

              const drainElapsed = Date.now() - drainStartTime;
              diagLog(`[MSE] Burst drain (reset): ${segments.length} segments in ${drainElapsed}ms, wasPlaying=${wasPlaying}`);

              if (wasPlaying && segments.length > 0) {
                const resumeTime = segments[0].timestamp + seekOffsetRef.current;
                video.currentTime = resumeTime;
                video.play().catch(() => {});
              }
            } catch (e) {
              diagLog(`[MSE] Burst drain error: ${e}`);
              if (wasPlaying) video.play().catch(() => {});
            }

            drainInProgressRef.current = false;
            diagLog(`[MSE] Burst drain complete, ahead=${getBufferedAheadSeconds().toFixed(1)}s`);
          };

          drainTimerRef.current = window.setInterval(drain, 500);
        };
        startBurstDrainLoop();

        muxTsTransmuxer.startStreaming().then(async () => {
          if (!cancelledRef.current) {
            // Final burst drain before endOfStream
            if (drainTimerRef.current !== null) {
              clearInterval(drainTimerRef.current);
              drainTimerRef.current = null;
            }
            const finalSegments = burstBufferRef.current;
            burstBufferRef.current = [];
            if (finalSegments.length > 0) {
              const sb = state.current.videoSourceBuffer;
              const video = videoRef.current;
              if (sb && video) {
                video.pause();
                sb.abort();
                const ranges = sb.buffered;
                if (ranges.length > 0) {
                  sb.remove(ranges.start(0), ranges.end(ranges.length - 1));
                  await sb.waitForQueueDrain();
                }
                const initSegs = initSegmentsRef.current;
                for (const seg of initSegs) sb.appendBuffer(seg.buffer.slice(0));
                if (initSegs.length > 0) await sb.waitForQueueDrain();
                for (const seg of finalSegments) sb.appendBuffer(seg.data);
                await sb.waitForQueueDrain();
              }
            }
            console.log('[MSE] MuxJsTs streaming complete');
            setIsComplete(true);
            isCompleteRef.current = true;
            hasEverCompletedRef.current = true;
            setIsPrefetching(false);
            setSpeed(0);
            setPrefetchedBytes(state.current.fileLength);
            const ms = state.current.mediaSource;
            if (ms && ms.readyState === 'open') {
              try { ms.endOfStream(); console.log('[MSE] endOfStream called after streaming complete'); } catch (e) { console.warn('[MSE] endOfStream failed:', e); }
            }
          }
        }).catch((e: Error) => {
          if (!cancelledRef.current) {
            const msg = e.message || '';
            const isExpected = msg.includes('aborted') || msg.includes('disposed') || msg.includes('cancelled');
            if (isExpected) {
              console.log('[MSE] MuxJsTs streaming interrupted (expected during seek)');
              return;
            }
            console.error('[MSE] MuxJsTs streaming failed:', e);
            setError(e.message);
          }
        });
      } catch (e: any) {
        transmuxerInitInProgressRef.current = false;
        console.error('[MSE] MuxJsTs setup failed:', e);
        if (!cancelledRef.current) {
          setError(`MuxJsTs setup failed: ${e.message}`);
          setUseNative(true);
        }
      }
      return;
    }

    // MKV/WebM format: use Mediabunny (Conversion API, works well for non-TS)
    try {
      const transmuxer = new MediabunnyTransmuxer({
        format,
        sourceConfig: {
          url,
          fileSize: state.current.fileLength,
          maxCacheSize: 32 * 1024 * 1024,
          prefetchProfile: 'network',
          seedData: firstChunkData,
        },
        onInitSegment: (data: ArrayBuffer) => {
          if (cancelledRef.current) return;
          diagLog(`[MSE] Transmuxer init segment: ${data.byteLength} bytes`);
          // During seek: buffer segments until setTimestampOffset() is called,
          // because setTimestampOffset() clears the SB queue and would discard
          // segments queued before the offset is set.
          if (bufferingForSeekRef.current) {
            seekBufferRef.current.push({ type: 'init', data: data.slice(0) });
            initSegmentsRef.current = [{ id: 1, buffer: data.slice(0) }];
            return;
          }
          // Append init segment to SourceBuffer
          state.current.videoSourceBuffer?.appendBuffer(data);
          // Cache init segment for re-append after seek
          initSegmentsRef.current = [{ id: 1, buffer: data.slice(0) }];
        },
        onMediaSegment: (data: ArrayBuffer, timestamp: number) => {
          if (cancelledRef.current) return;
          // During seek: buffer segments until setTimestampOffset() is called
          if (bufferingForSeekRef.current) {
            seekBufferRef.current.push({ type: 'media', data: data.slice(0), timestamp });
            return;
          }
          // Evict old buffer BEFORE appending (same pattern as MP4's onSegment)
          evictOldBuffer();
          // Backpressure: if buffer ahead exceeds MAX_BUFFER_AHEAD_SECONDS,
          // also evict far-ahead data to prevent QuotaExceededError.
          // (Conversion.execute() can't be paused, so we evict instead.)
          const video = videoRef.current;
          if (video) {
            const ahead = getBufferedAheadSeconds();
            if (ahead > MAX_BUFFER_AHEAD_SECONDS) {
              const sb = state.current.videoSourceBuffer;
              if (sb) {
                const ranges = sb.buffered;
                // Evict ranges far ahead of playback (> MAX_BUFFER_AHEAD_SECONDS)
                const maxAheadEnd = video.currentTime + MAX_BUFFER_AHEAD_SECONDS;
                for (let i = 0; i < ranges.length; i++) {
                  if (ranges.start(i) > maxAheadEnd) {
                    sb.remove(ranges.start(i), ranges.end(i));
                  } else if (ranges.end(i) > maxAheadEnd) {
                    sb.remove(maxAheadEnd, ranges.end(i));
                  }
                }
              }
            }
          }
          // Append media segment to SourceBuffer
          state.current.videoSourceBuffer?.appendBuffer(data);

          // Progress tracking — adjust timestamp for seek offset
          // (transmuxer timestamps are relative after trim, starting from 0)
          const absoluteTimestamp = timestamp + seekOffsetRef.current;
          if (absoluteTimestamp > 0 && state.current.duration > 0 && state.current.duration !== Infinity && state.current.fileLength > 0) {
            const estimatedBytes = Math.floor((absoluteTimestamp / state.current.duration) * state.current.fileLength);
            setPrefetchedBytes(estimatedBytes);
            // Track for green buffer bar (time-based, not byte-based)
            trackDownloadedRange(estimatedBytes, estimatedBytes + data.byteLength);
          }
        },
        onDurationKnown: (duration: number) => {
          if (cancelledRef.current) return;
          if (duration === Infinity && file?.duration && file.duration > 0 && isFinite(file.duration)) {
            diagLog(`[MSE] Transmuxer duration: Infinity, using telegramDuration=${file.duration}s`);
            duration = file.duration;
          }
          diagLog(`[MSE] Transmuxer duration known: ${duration}s`);
          state.current.duration = duration;
          if (state.current.fileLength > 0 && duration > 0 && duration !== Infinity) {
            state.current.bitrate = state.current.fileLength / duration;
          }
          try {
            mediaSource.duration = duration;
          } catch (_e) {
            setTimeout(() => {
              try { mediaSource.duration = duration; } catch (_) {}
            }, 100);
          }
        },
        onSpeedUpdate: (speed: number) => {
          if (cancelledRef.current) return;
          setSpeed(speed);
        },
        onProgressUpdate: (_processedTime: number, estimatedBytes: number) => {
          if (cancelledRef.current) return;
          // Update prefetchedBytes more accurately from transmuxer progress
          setPrefetchedBytes(estimatedBytes);
        },
        onCodecUnsupported: (codec: string) => {
          if (cancelledRef.current) return;
          diagLog(`[MSE] Transmuxer codec unsupported: ${codec}`);
          // Codec not supported by MSE — try native playback first, then error+download
          setError(`Codec not supported for MSE playback: ${codec}`);
          setUseNative(true);
        },
        onError: (error: Error) => {
          if (cancelledRef.current) return;
          diagLog(`[MSE] Transmuxer ERROR: ${error.message}`);
          setError(error.message);
          setUseNative(true);
        },
      });

      // Initialize the transmuxer (read file header, determine codecs)
      // Mark init as in-progress so the fatal video error handler doesn't
      // trigger fallback during init (the video element fires error code 4
      // because the blob URL has no data yet — this is expected, not fatal).
      transmuxerInitInProgressRef.current = true;
      const result = await transmuxer.init();
      if (!result || cancelledRef.current) {
        transmuxerInitInProgressRef.current = false;
        diagLog('[MSE] Transmuxer init FAILED or cancelled — no result');
        return;
      }

      diagLog(`[MSE] Transmuxer init success: decision=${result.mseDecision}, mimeType=${result.mimeType}`);

      // Create SourceBuffer with the mime type from the init result
      // For fMP4/WebM, a single combined SourceBuffer handles interleaved video+audio
      try {
        const sb = mediaSource.addSourceBuffer(result.mimeType);
        state.current.videoSourceBuffer = new SourceBufferWrapper(sb);
        state.current.videoSourceBuffer.setTimestampOffset(0);
        diagLog(`[MSE] Created combined SourceBuffer with mimeType: ${result.mimeType}`);
      } catch (e: any) {
        console.error(`[MSE] Failed to add SourceBuffer with mimeType "${result.mimeType}":`, e);
        // Try fallback mime types
        const fallbackMimes = result.mseDecision === 'fmp4'
          ? ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4; codecs="avc1.42E01E"', 'video/mp4']
          : ['video/webm; codecs="vp9, opus"', 'video/webm; codecs="vp8, opus"', 'video/webm'];

        for (const mime of fallbackMimes) {
          try {
            if (MediaSource.isTypeSupported(mime)) {
              const sb = mediaSource.addSourceBuffer(mime);
              state.current.videoSourceBuffer = new SourceBufferWrapper(sb);
              state.current.videoSourceBuffer.setTimestampOffset(0);
              console.log(`[MSE] Created SourceBuffer with fallback mimeType: ${mime}`);
              break;
            }
          } catch (_) {
            continue;
          }
        }

        if (!state.current.videoSourceBuffer) {
          setError(`MSE SourceBuffer creation failed for ${format}`);
          transmuxerInitInProgressRef.current = false;
          diagLog(`[MSE] SourceBuffer creation failed for ${format} — falling back to native`);
          setUseNative(true);
          return;
        }
      }

      // Transmuxer init is complete and SourceBuffer is ready — the fatal video
      // error handler can now safely trigger fallback if needed
      transmuxerInitInProgressRef.current = false;

      // Mark as initialized — MSE is ready to receive segments
      state.current.initialized = true;
      // Clear init timeout — MSE init succeeded, no need for fallback
      if (initTimeoutRef.current !== null) {
        clearTimeout(initTimeoutRef.current);
        initTimeoutRef.current = null;
      }
      transmuxerRef.current = transmuxer;
      // Set state to trigger re-render in effects that depend on mseGetters
      setIsTransmuxerActive(true);

      // Build keyframe index in background — MKV Cue entries make this fast.
      // Start scanner immediately — no computeDuration random reads needed.
      setTimeout(() => {
        if (!cancelledRef.current && transmuxerRef.current) {
          transmuxerRef.current.buildKeyframeIndex().then(() => {
            if (!cancelledRef.current) {
              setKeyframeIndexReady(true);
              console.log('[MSE] Keyframe index ready — thumbnail pipeline will use it');
            }
          }).catch((e) => {
            console.warn('[MSE] Keyframe index build failed (non-critical):', e);
          });
        }
      }, 0);

      // Start progressive transmuxing (produces segments via callbacks)
      setIsPrefetching(true);
      setSpeed(0);

      transmuxer.startTransmuxing().then(() => {
        if (!cancelledRef.current) {
          console.log('[MSE] Transmuxing complete');
          setIsComplete(true);
          isCompleteRef.current = true;
          hasEverCompletedRef.current = true;
          setIsPrefetching(false);
          setSpeed(0);
          setPrefetchedBytes(state.current.fileLength);
          // Signal end of stream to the browser so it fires the 'ended' event
          // and shows the replay overlay. Without this, video.ended never
          // becomes true and the replay overlay never appears.
          const ms = state.current.mediaSource;
          if (ms && ms.readyState === 'open') {
            try { ms.endOfStream(); console.log('[MSE] endOfStream called after transmuxing complete'); } catch (e) { console.warn('[MSE] endOfStream failed:', e); }
          }
        }
      }).catch((e: Error) => {
        if (!cancelledRef.current) {
          // ConversionCanceledError and InputDisposedError are expected when
          // seekTo() cancels the Conversion and disposes the Input during an
          // active transmux — don't treat as fatal error that tears down MSE
          const isExpectedSeekError = e.message?.includes('has been canceled') ||
            e.name === 'ConversionCanceledError' ||
            e.message?.includes('Input has been disposed') ||
            e.name === 'InputDisposedError';
          if (isExpectedSeekError) {
            console.log('[MSE] Conversion canceled/disposed (expected during seek)');
            return;
          }
          console.error('[MSE] Transmuxing failed:', e);
          setError(e.message);
        }
      });
    } catch (e: any) {
      transmuxerInitInProgressRef.current = false;
      console.error('[MSE] Transmuxer setup failed:', e);
      if (!cancelledRef.current) {
        setError(`Transmuxer setup failed: ${e.message}`);
        setUseNative(true);
      }
    }
  };

  /** Initialize the transmuxer player — dispatches to the appropriate pipeline.
   *  For TS format: tries the new backend fMP4 pipeline first, falls back to mux.js.
   *  For MKV/WebM format: uses Mediabunny (Conversion API). */
  const initTransmuxerPlayer = async (url: string, mediaSource: MediaSource, blobUrl: string, format: DetectedFormat, firstChunkData: ArrayBuffer) => {
    if (format === 'ts') {
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
        diagLog('[MSE] mpegts.js failed — falling back to fMP4 pipeline');
      }

      // Fallback: backend fMP4 pipeline (progressive segment loading)
      const fmp4Success = await _initTsFmp4Pipeline(url, mediaSource, blobUrl, format, firstChunkData);
      if (fmp4Success) return;

      // Last fallback: native <video> via /remux/ endpoint
      const parsed2 = parseStreamUrl(url);
      if (parsed2) {
        const remuxUrl = `${parsed2.baseUrl}/remux/${parsed2.folderId}/${parsed2.messageId}?token=${encodeURIComponent(parsed2.token)}`;
        diagLog(`[MSE] All TS pipelines failed — using ffmpeg remux fallback: ${remuxUrl}`);
        remuxUrlRef.current = remuxUrl;
        setUseNative(true);
        return;
      }
      diagLog('[MSE] TS format but failed to parse stream URL — falling back to mux.js');
    }
    // Original path (mux.js for TS, Mediabunny for MKV/WebM)
    await initTransmuxerPlayerOriginal(url, mediaSource, blobUrl, format, firstChunkData);
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
  const seekTo = useCallback((timeSeconds: number) => {
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
    // lazyLoadMaxDuration seconds (~30s ≈ 15MB) instead of downloading the
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

      // Also check shadow cache — if the byte range is cached, the server will
      // serve it instantly via CACHE-PREFIX, so the seek will be fast even
      // though it's "unbuffered" in the SourceBuffer sense.
      const isCacheHit = (() => {
        if (isBuffered) return true;  // already buffered = instant
        const cache = shadowCacheRef.current;
        if (!cache || cache.fileLength <= 0 || dur <= 0) return false;
        const approxByte = Math.floor((clamped / dur) * cache.fileLength);
        return cache.hasByte(approxByte);
      })();

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
        _mpegtsUnbufferedSeek(clamped, dur);
        // Auto-clear suppress after 3s (safety net)
        setTimeout(() => { suppressLoadingSpinnerRef.current = false; }, 3000);
      } else {
        // Unbuffered seek — data must be fetched from Telegram (slow)
        _mpegtsUnbufferedSeek(clamped, dur);
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

  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    // Bug #4 fix: when the video element encounters a fatal decoder error
    // (CHUNK_DEMUXER_ERROR_APPEND_FAILED), fall back to native playback.
    // The error is permanent — once HTMLMediaElement.error is set, no more
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

  return {
    mseUrl: (useNative || !!mpegtsPlayerRef.current) ? null : mseUrl,
    error: useNative ? null : error,
    useNative,
    remuxUrl: remuxUrlRef.current,
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
