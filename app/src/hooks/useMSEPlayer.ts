import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TelegramFile } from '../types';
import { SourceBufferWrapper } from '../lib/faststream/players/SourceBufferWrapper';

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
  start: () => void;
  stop: () => void;
}

const FRAGMENT_SIZES = [
  512 * 1024,   // 512KB — fast first frame after seek
  1024 * 1024,  // 1MB
  2 * 1024 * 1024,  // 2MB
  4 * 1024 * 1024,  // 4MB — steady state
];
const MAX_BUFFER_BYTES = 100 * 1024 * 1024; // 100MB max buffer before eviction
const BUFFER_KEEP_BEHIND = 30; // Keep 30s behind current playback position

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
  const [prefetchedBytes, setPrefetchedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [isPrefetching, setIsPrefetching] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(false); // Ref so seekTo can check without React state delay
  const [isComplete, setIsComplete] = useState(false);
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
  // Downloaded byte ranges — merged and converted to time for green buffer bar
  const downloadedRangesRef = useRef<[number, number][]>([]);
  // Cached init segments (codec config) — re-appended after each SourceBuffer clear
  const initSegmentsRef = useRef<Array<{ id: number; buffer: ArrayBuffer }>>([]);
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
      const [ts, te] = timeRanges[timeRanges.length - 1];
      console.log(`[BUFFER-BAR] First range after seek: bytes ${byteStart}-${byteEnd} → time ${ts.toFixed(1)}-${te.toFixed(1)}s`);
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
    setUseNative(false);

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
    clearDownloadedRanges();
    setPrefetchedBytes(0);
    setTotalBytes(0);
    setIsPrefetching(false);
    setIsComplete(false);
    setSpeed(0);
    setError(null);
    setMseUrl(null);

    // Try MSE first
    let blobUrl: string | null = null;
    try {
      const mediaSource = new MediaSource();
      blobUrl = URL.createObjectURL(mediaSource);
      // Set blob URL immediately so video element loads it and triggers sourceopen
      setMseUrl(blobUrl);
      state.current.mediaSource = mediaSource;

      const onSourceOpen = () => {
        if (cancelledRef.current) return;
        initMP4Box(streamUrl, mediaSource, blobUrl!);
      };

      mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true });

      // Timeout for MSE initialization (20s to allow fetching moov atom)
      setTimeout(() => {
        if (!state.current.initialized && !cancelledRef.current) {
          setError('MSE initialization timeout');
          setUseNative(true);
        }
      }, 20000);
    } catch (e) {
      setError('MediaSource not supported');
      setUseNative(true);
    }

    return () => {
      cancelledRef.current = true;
      // Flush remaining range reports before cleanup
      flushRangeReport();
      // Revoke blob URL on cleanup
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [streamUrl, flushRangeReport]);

  const cleanup = () => {
    abortRef.current?.abort();
    state.current.videoSourceBuffer?.destroy();
    state.current.audioSourceBuffer?.destroy();
    state.current.videoSourceBuffer = null;
    state.current.audioSourceBuffer = null;
    state.current.mp4box = null;
    state.current.initialized = false;
    clearDownloadedRanges();
  };

  /** Remove buffered data older than (currentTime - BUFFER_KEEP_BEHIND) when buffer is too large */
  const evictOldBuffer = () => {
    const video = videoRef.current;
    if (!video || video.currentTime <= 0) return;

    const sbVideo = state.current.videoSourceBuffer;
    const sbAudio = state.current.audioSourceBuffer;
    if (!sbVideo && !sbAudio) return;

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

    const evictBefore = Math.max(0, video.currentTime - BUFFER_KEEP_BEHIND);
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

      const data = await response.arrayBuffer();
      if (cancelledRef.current) return;

      // Check if it's a valid MP4 (starts with ftyp box)
      const view = new DataView(data);
      const boxType = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));

      if (boxType !== 'ftyp' && boxType !== 'jP  ') {
        setUseNative(true);
        return;
      }

      // Feed to mp4box
      const buffer = data as any;
      buffer.fileStart = 0;
      mp4box.appendBuffer(buffer);

      state.current.currentOffset = firstChunkSize;
      setPrefetchedBytes(firstChunkSize);

      // Report initial chunk range to cache backend
      reportRangesToBackend(0, firstChunkSize - 1);

      // If onReady hasn't fired yet, keep fetching more data (moov may be beyond 1MB)
      if (!state.current.initialized && state.current.fileLength > 0) {
        await fetchMoreData(url, mp4box);
      }
    } catch (e: any) {
      console.error('[MSE] Setup failed:', e);
      if (!cancelledRef.current) {
        setUseNative(true);
      }
    }
  };

  const fetchMoreData = async (url: string, mp4box: MP4BoxFile) => {
    const MAX_PREFETCH = 10 * 1024 * 1024; // 10MB max to find moov

    while (!cancelledRef.current && !state.current.initialized &&
           state.current.currentOffset < state.current.fileLength &&
           state.current.currentOffset < MAX_PREFETCH) {

      const offset = state.current.currentOffset;
      const chunkSize = FRAGMENT_SIZES[0]; // 512KB for moov discovery
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
      setUseNative(true);
    }
  };

  const onMP4BoxReady = (info: MP4BoxInfo, url: string, mediaSource: MediaSource, mp4box: MP4BoxFile, _blobUrl: string) => {
    if (!mediaSource || cancelledRef.current) return;

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
      console.log(`[BUFFER-BAR] VBR lookup table built: ${table.length} points, video duration=${state.current.duration.toFixed(1)}s`);
    }

    // Create SourceBuffers
    try {
      if (state.current.videoTracks.length > 0) {
        const track = state.current.videoTracks[0];
        const mimeType = `video/mp4; codecs="${track.codec}"`;
        if (MediaSource.isTypeSupported(mimeType)) {
          const sb = mediaSource.addSourceBuffer(mimeType);
          state.current.videoSourceBuffer = new SourceBufferWrapper(sb);
        } else {
          setUseNative(true);
          return;
        }
      }

      if (state.current.audioTracks.length > 0) {
        const track = state.current.audioTracks[0];
        const mimeType = `audio/mp4; codecs="${track.codec}"`;
        if (MediaSource.isTypeSupported(mimeType)) {
          const sb = mediaSource.addSourceBuffer(mimeType);
          state.current.audioSourceBuffer = new SourceBufferWrapper(sb);
        }
      }

      // Track IDs for mapping segments
      const videoTrackId = state.current.videoTracks.length > 0 ? state.current.videoTracks[0].id : -1;
      const audioTrackId = state.current.audioTracks.length > 0 ? state.current.audioTracks[0].id : -1;
      state.current.videoTrackId = videoTrackId;
      state.current.audioTrackId = audioTrackId;

      // Set up mp4box segmentation — pass user objects so onSegment/initSegs can identify tracks
      if (videoTrackId >= 0) {
        mp4box.setSegmentOptions(videoTrackId, { type: 'video' }, { nbSamples: 100 });
      }
      if (audioTrackId >= 0) {
        mp4box.setSegmentOptions(audioTrackId, { type: 'audio' }, { nbSamples: 100 });
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
          }
        }
      }

      state.current.initialized = true;
      setIsPrefetching(true);

      // Set up mp4box callback for segments
      mp4box.onSegment = (trackId: number, _user: any, buffer: ArrayBuffer, _sampleNum: number, _isLast: boolean) => {
        if (cancelledRef.current) return;

        const isVideo = trackId === videoTrackId;
        const isAudio = trackId === audioTrackId;

        if (isVideo && state.current.videoSourceBuffer) {
          state.current.videoSourceBuffer.appendBuffer(buffer);
        }
        if (isAudio && state.current.audioSourceBuffer) {
          state.current.audioSourceBuffer.appendBuffer(buffer);
        }

        // Evict old buffer to prevent memory growth
        evictOldBuffer();
      };

      // Start mp4box segment generation
      mp4box.start();

      // Start downloading and appending
      downloadLoop(url);
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
        state.current.currentOffset = syncOffset;
        chunksAfterSeek.current = 1;

        if (videoRef.current) {
          videoRef.current.currentTime = seekTime;
        }

        
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
        state.current.mp4box!.appendBuffer(buffer);
        state.current.mp4box!.flush();

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
    if (!cancelledRef.current) {
      // Flush any remaining range reports
      flushRangeReport();
      if (reachedEnd) {
        setIsComplete(true);
      }
      setIsPrefetching(false);
      setSpeed(0);
    }
  };
  downloadLoopRef.current = downloadLoop;

  // Direct seek function — avoids hard-restarting the download loop.
  // For already-buffered positions: just set currentTime, no download restart.
  // For unbuffered positions: jump byte offset and let the running loop continue naturally.
  const seekTo = useCallback((timeSeconds: number) => {
    if (!state.current.initialized || !streamUrl || useNative) return;
    if (state.current.fileLength <= 0 || !isFinite(timeSeconds) || timeSeconds < 0) return;

    // 1. Check if the target position is already buffered in the SourceBuffer
    if (videoRef.current && videoRef.current.buffered.length > 0) {
      for (let i = 0; i < videoRef.current.buffered.length; i++) {
        if (timeSeconds >= videoRef.current.buffered.start(i) &&
            timeSeconds <= videoRef.current.buffered.end(i)) {
          // Already buffered — just set currentTime, browser seeks within buffer
          videoRef.current.currentTime = timeSeconds;
          return;
        }
      }
    }

    // 2. Position is NOT buffered — jump the download to the new byte offset
    const seekByte = Math.floor((timeSeconds / state.current.duration) * state.current.fileLength);
    state.current.pendingSeek = seekByte;
    chunksAfterSeek.current = 0;
    setIsComplete(false);

    // Abort the in-flight fetch so the download loop processes the pending seek
    abortRef.current?.abort();

    // If the download loop isn't running AND we're not paused, restart it.
    // When paused, we store the pendingSeek but don't resume — the user must
    // explicitly click "resume buffering" to continue downloading.
    if (!state.current.downloading && !isPausedRef.current && downloadLoopRef.current) {
      state.current.downloading = true;
      setIsPrefetching(true);
      downloadLoopRef.current(streamUrl);
    }
  }, [streamUrl, useNative]);

  const pausePrefetch = () => {
    state.current.downloading = false;
    isPausedRef.current = true;
    loopGeneration.current++;
    abortRef.current?.abort();
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
    videoRef.current = el;
  }, []);

  const setSuppressBackendReports = useCallback((suppress: boolean) => {
    suppressBackendReportsRef.current = suppress;
  }, []);

  return {
    mseUrl: useNative ? null : mseUrl,
    error: useNative ? null : error,
    useNative,
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
    getFileLength: () => state.current.fileLength,
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
