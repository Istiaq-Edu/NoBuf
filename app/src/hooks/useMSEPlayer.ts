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
const MAX_BUFFER_BYTES = 50 * 1024 * 1024; // 50MB max buffer before eviction (Bug #16: reduced from 100MB)
const BUFFER_KEEP_BEHIND = 30; // Keep 30s behind current playback position
const MAX_BUFFER_AHEAD_SECONDS = 120; // Bug #16: backpressure — stop downloading when >2min buffered ahead

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
  const SEEK_DEBOUNCE_MS_TS = 2000; // TS format — longer debounce because getKeyPacket is slow (prevent concurrent seeks during drag)
  // Track when the last unbuffered seek was actually executed (instant or debounce expired).
  // The FIRST seek is instant; subsequent seeks within SEEK_DEBOUNCE_MS are debounced.
  const lastSeekTimeRef = useRef<number>(0);
  // Whether a transmuxer seek (seekTo + resetForSeek) is currently in progress.
  // Prevents starting a new seek while the previous one is still running getKeyPacket
  // (8-18s for TS). Without this, the debounce resets when the seek STARTS, so
  // subsequent seeks during a long-running getKeyPacket pass the debounce check
  // and start concurrently — wasting bandwidth and coordinator slots.
  const transmuxerSeekInProgressRef = useRef(false);
  // Downloaded byte ranges — merged and converted to time for green buffer bar
  const downloadedRangesRef = useRef<[number, number][]>([]);
  // Transmuxer for TS/MKV format playback (null when not active)
  const transmuxerInitInProgressRef = useRef(false);
  const transmuxerRef = useRef<MediabunnyTransmuxer | MuxJsTsTransmuxer | null>(null);
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
  const seekBufferRef = useRef<Array<{ type: 'init' | 'media'; data: ArrayBuffer; timestamp?: number }>>([]);
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
      // Flush remaining range reports before cleanup
      flushRangeReportRef.current();
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
    seekOffsetRef.current = 0;
    bufferingForSeekRef.current = false;
    seekBufferRef.current = [];
    stopStreamingChain();
    refillInProgressRef.current = false;
    state.current.mp4box = null;
    state.current.initialized = false;
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
    console.log('[MSE] Streaming chain stopped');
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
        // TS format: timestampOffset=0 (keepOriginalTimestamps:true, absolute timestamps)
        // MKV format: timestampOffset=keyframeTimestamp (keepOriginalTimestamps:false, normalized)
        const isTsFormat = formatRef.current === 'ts';
        const tsOffset = isTsFormat ? 0 : keyframeTimestamp;
        seekOffsetRef.current = tsOffset;
        await sb.setTimestampOffset(tsOffset);
        const buffer = seekBufferRef.current;
        seekBufferRef.current = [];
        let segmentCount = 0;
        for (const item of buffer) {
          if (item.type === 'media') {
            sb.appendBuffer(item.data);
            segmentCount++;
          }
        }
        console.log(`[MSE] EOF final refill: keyframe=${keyframeTimestamp.toFixed(2)}s, flushed ${segmentCount} segments`);
        await sb.waitForQueueDrain();
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
        // Discontinuity refill: set timestampOffset and flush buffered segments.
        // TS format: timestampOffset=0 (keepOriginalTimestamps:true → absolute timestamps)
        // MKV format: timestampOffset=keyframeTimestamp (keepOriginalTimestamps:false → normalized)
        evictOldBuffer();
        const isTsFormat = formatRef.current === 'ts';
        const tsOffset = isTsFormat ? 0 : keyframeTimestamp;
        seekOffsetRef.current = tsOffset;
        await sb.setTimestampOffset(tsOffset);

        const buffer = seekBufferRef.current;
        seekBufferRef.current = [];
        let segmentCount = 0;
        for (const item of buffer) {
          if (item.type === 'media') {
            sb.appendBuffer(item.data);
            segmentCount++;
            // Progress tracking
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
    // When currentTime is 0 (initial buffering), keep only first 60s.
    // When playing, keep BUFFER_KEEP_BEHIND (30s) behind current position.
    const evictBefore = currentTime <= 0
      ? 0  // Don't evict during initial buffering — keep everything from 0
      : Math.max(0, currentTime - BUFFER_KEEP_BEHIND);

    if (evictBefore <= 0) return; // Nothing to evict at the start

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

      if (format === 'ts') {
        // TS format with mux.js — push-based, no large prefetch needed.
        // mux.js processes data on-the-fly: push first chunk → get init + media segments.
        // No sequential scan, no 20MB seed requirement like mediabunny.
        diagLog(`[MSE] ts: mux.js push-based — using initial chunk (${data.byteLength} bytes), no extra prefetch`);
      } else if (format === 'mkv' || format === 'webm') {
        // MKV/WebM formats need a larger initial prefetch because mediabunny's
        // Input reads progressively during init (canRead + track discovery +
        // codec extraction). With only 512KB cached, reads beyond that trigger
        // slow 64KB/s MISS downloads from Telegram. Fetch additional data up
        // to TS_INITIAL_PREFETCH so the transmuxer init completes within
        // cached territory.
        if (data.byteLength < TS_INITIAL_PREFETCH && state.current.fileLength > TS_INITIAL_PREFETCH) {
          diagLog(`[MSE] ${format}: fetching additional prefetch data (${data.byteLength} → ${TS_INITIAL_PREFETCH} bytes)`);
          try {
            const extraResponse = await fetch(url, {
              headers: { Range: `bytes=${data.byteLength}-${TS_INITIAL_PREFETCH - 1}` },
            });
            if (extraResponse.ok || extraResponse.status === 206) {
              const extraData = await extraResponse.arrayBuffer();
              if (!cancelledRef.current) {
                // Merge first chunk + extra data into one contiguous buffer
                const merged = new Uint8Array(data.byteLength + extraData.byteLength);
                merged.set(new Uint8Array(data), 0);
                merged.set(new Uint8Array(extraData), data.byteLength);
                data = merged.buffer; // Replace data with merged buffer so seedData covers full prefetch
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

  /** Initialize the transmuxer player for TS/MKV files.
   *  Uses Mediabunny to demux the input and remux to fMP4/WebM segments for MSE. */
  const initTransmuxerPlayer = async (url: string, mediaSource: MediaSource, _blobUrl: string, format: DetectedFormat, firstChunkData: ArrayBuffer) => {
    diagLog(`[MSE] initTransmuxerPlayer: format=${format}, seedData=${firstChunkData.byteLength} bytes (${(firstChunkData.byteLength/1024/1024).toFixed(1)}MB)`);
    let muxJsMediaSegmentCount = 0;
    try {
      // TS format: use mux.js (push-based, instant init, no sequential scan)
      // MKV/WebM format: use mediabunny (works well, no changes needed)
      if (format === 'ts') {
        const muxTsTransmuxer = new MuxJsTsTransmuxer({
          url,
          fileSize: state.current.fileLength,
          firstChunkData,
          onInitSegment: (data: ArrayBuffer) => {
            if (cancelledRef.current) return;
            diagLog(`[MSE] MuxJsTs init segment: ${data.byteLength} bytes`);
            if (bufferingForSeekRef.current) {
              seekBufferRef.current.push({ type: 'init', data: data.slice(0) });
              initSegmentsRef.current = [{ id: 1, buffer: data.slice(0) }];
              return;
            }
            // Append init segment to combined SourceBuffer (contains both video+audio trak boxes)
            state.current.videoSourceBuffer?.appendBuffer(data);
            initSegmentsRef.current = [{ id: 1, buffer: data.slice(0) }];
          },
          onMediaSegment: (data: ArrayBuffer, timestamp: number) => {
            if (cancelledRef.current) return;
            if (bufferingForSeekRef.current) {
              seekBufferRef.current.push({ type: 'media', data: data.slice(0), timestamp });
              return;
            }
            evictOldBuffer();
            // Append to combined SourceBuffer (contains both audio+video tracks)
            state.current.videoSourceBuffer?.appendBuffer(data);
            // Diagnostic: log SourceBuffer buffered ranges after first 10 appends
            muxJsMediaSegmentCount++;
            if (muxJsMediaSegmentCount <= 10) {
              const sbVideo = state.current.videoSourceBuffer;
              if (sbVideo) {
                try {
                  const rangesV = sbVideo.buffered;
                  let rangeStrV = '';
                  for (let i = 0; i < rangesV.length; i++) {
                    rangeStrV += `[${rangesV.start(i).toFixed(2)}-${rangesV.end(i).toFixed(2)}s]`;
                  }
                  diagLog(`[MSE] MuxJsTs onMediaSegment #${muxJsMediaSegmentCount}: ${data.byteLength} bytes, ts=${timestamp.toFixed(3)}s, SB=${rangeStrV}, sbQueue=${sbVideo.queueLength}`);
                } catch (_) {}
              }
            }
            const absoluteTimestamp = timestamp + seekOffsetRef.current;
            if (absoluteTimestamp > 0 && state.current.duration > 0 && state.current.duration !== Infinity && state.current.fileLength > 0) {
              const estimatedBytes = Math.floor((absoluteTimestamp / state.current.duration) * state.current.fileLength);
              setPrefetchedBytes(estimatedBytes);
              trackDownloadedRange(estimatedBytes, estimatedBytes + data.byteLength);
            }
          },
          onDurationKnown: (duration: number) => {
            if (cancelledRef.current) return;
            diagLog(`[MSE] MuxJsTs duration known: ${duration}s`);
            state.current.duration = duration;
            if (state.current.fileLength > 0 && duration > 0 && duration !== Infinity) {
              state.current.bitrate = state.current.fileLength / duration;
            }
            try {
              mediaSource.duration = duration;
            } catch (_e) {
              setTimeout(() => { try { mediaSource.duration = duration; } catch (_) {} }, 100);
            }
          },
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

        diagLog(`[MSE] MuxJsTs init success: mimeType=${result.mimeType}, videoMimeType=${result.videoMimeType}, audioMimeType=${result.audioMimeType}`);

        // Create COMBINED SourceBuffer for TS format.
        // Chrome's MSE does strict codec checking for separate audio SourceBuffers
        // — HE-AAC data (audioObjectType 0x40/SBR) is rejected when the codec
        // string says mp4a.40.2 (AAC-LC). Combined SourceBuffer is more lenient:
        // Chrome auto-detects HE-AAC from the AudioSpecificConfig and accepts
        // the mismatch. With keepOriginalTimestamps:true + GOP cache clearing +
        // true passthrough, audio/video offset is ~0.04-0.23s (natural TS
        // stream offset) — negligible in combined mode.
        try {
          const sbCombined = mediaSource.addSourceBuffer(result.mimeType);
          state.current.videoSourceBuffer = new SourceBufferWrapper(sbCombined);
          state.current.videoSourceBuffer.setTimestampOffset(0);
          state.current.audioSourceBuffer = null; // No separate audio SB for TS
          diagLog(`[MSE] Created combined SourceBuffer for TS with mimeType: ${result.mimeType}`);
        } catch (e: any) {
          console.error(`[MSE] Failed to add combined SourceBuffer "${result.mimeType}":`, e);
          const fallbackMimes = ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4; codecs="avc1.42E01E"', 'video/mp4'];
          for (const mime of fallbackMimes) {
            try {
              if (MediaSource.isTypeSupported(mime)) {
                const sb = mediaSource.addSourceBuffer(mime);
                state.current.videoSourceBuffer = new SourceBufferWrapper(sb);
                state.current.videoSourceBuffer.setTimestampOffset(0);
                state.current.audioSourceBuffer = null;
                console.log(`[MSE] Created combined SourceBuffer with fallback mimeType: ${mime}`);
                break;
              }
            } catch (_) { continue; }
          }
          if (!state.current.videoSourceBuffer) {
            diagLog(`[MSE] SourceBuffer creation failed for TS — falling back to native`);
            setUseNative(true);
            return;
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

        // The init segment and first media segment were produced during
        // muxTsTransmuxer.init() BEFORE the SourceBuffer existed, so the
        // onInitSegment/onMediaSegment callbacks silently dropped them.
        // Now that the SourceBuffer exists, append them from the returned data.
        if (result.initSegment && state.current.videoSourceBuffer) {
          diagLog(`[MSE] Appending init segment to combined SourceBuffer: ${result.initSegment.byteLength} bytes`);
          state.current.videoSourceBuffer.appendBuffer(result.initSegment);
          initSegmentsRef.current = [{ id: 1, buffer: result.initSegment }];
        }
        if (result.firstMediaSegment && state.current.videoSourceBuffer) {
          diagLog(`[MSE] Appending first media segment to combined SourceBuffer: ${result.firstMediaSegment.byteLength} bytes, ts=${result.firstMediaTimestamp.toFixed(3)}s`);
          evictOldBuffer();
          state.current.videoSourceBuffer.appendBuffer(result.firstMediaSegment);
        }

        // Diagnostic: check SourceBuffer ranges after init + first media segment
        setTimeout(() => {
          const sbVideo = state.current.videoSourceBuffer;
          if (sbVideo) {
            try {
              const rangesV = sbVideo.buffered;
              let rangeStrV = '';
              for (let i = 0; i < rangesV.length; i++) {
                rangeStrV += `[${rangesV.start(i).toFixed(2)}-${rangesV.end(i).toFixed(2)}s]`;
              }
              diagLog(`[MSE] SourceBuffer ranges after init+firstMedia: ${rangeStrV}`);
            } catch (_) {}
          }
        }, 500);

        // Build keyframe index in background
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

        // Start progressive streaming (push-based, different from mediabunny's Conversion)
        setIsPrefetching(true);
        setSpeed(0);

        muxTsTransmuxer.startStreaming().then(() => {
          if (!cancelledRef.current) {
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
            // Abort/dispose errors are expected during seeks — don't treat as fatal
            const msg = e.message || '';
            const isExpected = msg.includes('aborted') || msg.includes('disposed') || msg.includes('cancelled');
            if (isExpected) {
              console.log('[MSE] MuxJsTs streaming aborted (expected during seek/dispose)');
              return;
            }
            console.error('[MSE] MuxJsTs streaming failed:', e);
            setError(e.message);
          }
        });
        return;
      }

      // MKV/WebM format: use mediabunny (unchanged)
      const transmuxer = new MediabunnyTransmuxer({
        format,
        sourceConfig: {
          url,
          fileSize: state.current.fileLength,
          maxCacheSize: 32 * 1024 * 1024, // 32 MiB — reduces duplicate HTTP range requests during concurrent video+audio iterations (default 8 MiB is too small)
          prefetchProfile: 'network', // MKV/WebM: 'network' (3 workers, aggressive random prefetch) for fast random access.
          seedData: firstChunkData, // In-memory first chunk data — reads within [0, firstChunkData.byteLength] bypass HTTP entirely (zero latency). Eliminates the ~0.5-1s per-request round-trip delay through the Tauri/WebView2 bridge that made the transmuxer init take 30+ seconds.
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
          diagLog(`[MSE] Transmuxer duration known: ${duration}s`);
          state.current.duration = duration;
          // Calculate bitrate for evictOldBuffer (same as MP4 path)
          // Skip for Infinity (deferred TS duration — will update when real duration arrives)
          if (state.current.fileLength > 0 && duration > 0 && duration !== Infinity) {
            state.current.bitrate = state.current.fileLength / duration;
          }
          // Set MediaSource.duration so the video element reports the correct duration
          // (instead of Infinity). Safe to set before SourceBuffer is created — no SB is updating.
          try {
            mediaSource.duration = duration;
          } catch (_e) {
            // SourceBuffer might be updating — retry with a small delay
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

      // Build keyframe index in background — dramatically speeds up subsequent
      // seeks for TS format (O(log n) binary search vs 8-12s linear scan).
      // Start scanner immediately — no computeDuration random reads needed
      // (scanner uses direct fetch, independent of mediabunny's ReadOrchestrator).
      // MKV format also starts immediately — no computeDuration random reads needed.
      const scannerDelay = 0;
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
      }, scannerDelay);

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
    if (!state.current.initialized || !streamUrl || useNative) return;
    if (state.current.fileLength <= 0 || !isFinite(timeSeconds) || timeSeconds < 0) return;

    const clampedTime = Math.min(timeSeconds, state.current.duration - 0.001);

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

        const sbVideo = state.current.videoSourceBuffer;
        const isTsFormat = formatRef.current === 'ts';
        if (sbVideo) {
          // Enable buffering mode: segments produced during seekTo will be
          // buffered in seekBufferRef instead of appended to the SourceBuffer.
          // This is necessary because setTimestampOffset() clears the SB queue,
          // and we can't set timestampOffset until we know the keyframe timestamp.
          bufferingForSeekRef.current = true;
          seekBufferRef.current = [];

          // Reset SourceBuffer for TS format (combined video+audio)
          const resetPromises = [sbVideo.resetForSeek()];

          Promise.all(resetPromises).then(async () => {
            const keyframeTimestamp = await transmuxerRef.current!.seekTo(clampedTime, INITIAL_SEEK_DURATION);

            // Disable buffering mode — segments from now on append directly
            bufferingForSeekRef.current = false;

            if (keyframeTimestamp !== null) {
              // TS format: keepOriginalTimestamps:true → timestamps are absolute.
              // Use setTimestampOffset(0) (not keyframeTimestamp) to clear SB
              // queues. MKV format: keepOriginalTimestamps:false → use
              // setTimestampOffset(keyframeTimestamp) for absolute positioning.
              const tsOffset = isTsFormat ? 0 : keyframeTimestamp;
              seekOffsetRef.current = tsOffset;
              await sbVideo.setTimestampOffset(tsOffset);

              // Flush buffered segments to combined SourceBuffer.
              const buffer = seekBufferRef.current;
              seekBufferRef.current = [];
              for (const item of buffer) {
                if (item.type === 'init') {
                  sbVideo.appendBuffer(item.data);
                } else if (item.type === 'media') {
                  sbVideo.appendBuffer(item.data);
                  // Progress tracking for buffered media segments
                  const absoluteTimestamp = item.timestamp! + seekOffsetRef.current;
                  if (absoluteTimestamp > 0 && state.current.duration > 0 && state.current.fileLength > 0) {
                    const estimatedBytes = Math.floor((absoluteTimestamp / state.current.duration) * state.current.fileLength);
                    setPrefetchedBytes(estimatedBytes);
                    trackDownloadedRange(estimatedBytes, estimatedBytes + item.data.byteLength);
                  }
                }
              }

              console.log(`[MSE] Transmuxer seek complete: keyframe=${keyframeTimestamp.toFixed(2)}s, flushed ${buffer.length} buffered segments`);

              // Wait for SourceBuffer to process all queued data
              await sbVideo.waitForQueueDrain();

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
          if (!cancelledRef.current && !useNative) {
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

  return {
    mseUrl: useNative ? null : mseUrl,
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
    keyframeIndexReady,
    thumbnailDataReady,
    moovBufferReady,
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
