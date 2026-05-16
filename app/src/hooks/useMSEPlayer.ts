import { useEffect, useRef, useState, useCallback } from 'react';
import { SourceBufferWrapper } from '../lib/faststream/players/SourceBufferWrapper';

/**
 * MSE (MediaSource Extensions) player hook using FastStream's approach.
 * Falls back to native video if MSE fails (non-MP4 format, etc.)
 */

const FRAGMENT_SIZE = 4 * 1024 * 1024; // 4MB per chunk — fewer round trips after seek

interface MSEState {
  mediaSource: MediaSource | null;
  videoSourceBuffer: SourceBufferWrapper | null;
  audioSourceBuffer: SourceBufferWrapper | null;
  mp4box: any;
  fileLength: number;
  duration: number;
  bitrate: number;
  videoTracks: any[];
  audioTracks: any[];
  initialized: boolean;
  downloading: boolean;
  currentOffset: number;
  pendingSeek: number;
}

export function useMSEPlayer(streamUrl: string | null, currentTime: number = 0) {
  const [mseUrl, setMseUrl] = useState<string | null>(null);
  const [mseReady, setMseReady] = useState(false); // true after init segments appended
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useNative, setUseNative] = useState(false); // Fallback flag
  const [prefetchedBytes, setPrefetchedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [isPrefetching, setIsPrefetching] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [speed, setSpeed] = useState(0);

  const downloadLoopRef = useRef<((url: string) => void) | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
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
    initialized: false,
    downloading: false,
    currentOffset: 0,
    pendingSeek: -1,
  });

  const speedHistory = useRef<{ bytes: number; time: number }[]>([]);
  const lastTimeRef = useRef(0);
  const prevUrlRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

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
      initialized: false,
      downloading: false,
      currentOffset: 0,
      pendingSeek: -1,
    };
    lastTimeRef.current = currentTime;
    speedHistory.current = [];
    setPrefetchedBytes(0);
    setTotalBytes(0);
    setIsPrefetching(false);
    setIsComplete(false);
    setSpeed(0);
    setError(null);
    setIsReady(false);
    setMseUrl(null);
    setMseReady(false);

    // Try MSE first
    console.log('[MSE] Initializing for URL:', streamUrl);
    let blobUrl: string | null = null;
    try {
      const mediaSource = new MediaSource();
      blobUrl = URL.createObjectURL(mediaSource);
      // Set blob URL immediately so video element loads it and triggers sourceopen
      setMseUrl(blobUrl);
      state.current.mediaSource = mediaSource;

      const onSourceOpen = () => {
        console.log('[MSE] sourceopen event fired');
        if (cancelledRef.current) return;
        initMP4Box(streamUrl, mediaSource, blobUrl!);
      };

      mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true });

      // Timeout for MSE initialization (20s to allow fetching moov atom)
      setTimeout(() => {
        if (!state.current.initialized && !cancelledRef.current) {
          console.warn('[MSE] MSE initialization timeout, falling back to native');
          setUseNative(true);
        }
      }, 20000);
    } catch (e) {
      console.warn('[MSE] MediaSource not supported, using native:', e);
      setUseNative(true);
    }

    return () => {
      cancelledRef.current = true;
      // Revoke blob URL on cleanup
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [streamUrl]);

  const cleanup = () => {
    state.current.videoSourceBuffer?.destroy();
    state.current.audioSourceBuffer?.destroy();
    state.current.videoSourceBuffer = null;
    state.current.audioSourceBuffer = null;
    state.current.mp4box = null;
    state.current.initialized = false;
  };

  const initMP4Box = async (url: string, mediaSource: MediaSource, blobUrl: string) => {
    try {
      const MP4Box = await loadMP4Box();
      if (cancelledRef.current) return;

      const mp4box = MP4Box.createFile(false);
      state.current.mp4box = mp4box;

      mp4box.onReady = (info: any) => {
        console.log('[MSE] mp4box onReady!', info);
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

      // Fetch first fragment
      const response = await fetch(url, {
        headers: { Range: `bytes=0-${FRAGMENT_SIZE - 1}` },
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
        console.warn('[MSE] Not a valid MP4 file (box:', boxType, '), falling back to native');
        setUseNative(true);
        return;
      }

      // Feed to mp4box
      const buffer = data as any;
      buffer.fileStart = 0;
      mp4box.appendBuffer(buffer);

      state.current.currentOffset = FRAGMENT_SIZE;
      setPrefetchedBytes(FRAGMENT_SIZE);

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

  const fetchMoreData = async (url: string, mp4box: any) => {
    const MAX_PREFETCH = 10 * 1024 * 1024; // 10MB max to find moov

    while (!cancelledRef.current && !state.current.initialized &&
           state.current.currentOffset < state.current.fileLength &&
           state.current.currentOffset < MAX_PREFETCH) {

      const offset = state.current.currentOffset;
      const end = Math.min(offset + FRAGMENT_SIZE - 1, state.current.fileLength - 1);

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
      } catch (e) {
        console.error('[MSE] fetchMoreData error:', e);
        break;
      }
    }

    if (!state.current.initialized && !cancelledRef.current) {
      console.warn('[MSE] mp4box onReady still not fired after fetching', state.current.currentOffset, 'bytes');
      setUseNative(true);
    }
  };

  const onMP4BoxReady = (info: any, url: string, mediaSource: MediaSource, mp4box: any, blobUrl: string) => {
    console.log('[MSE] onMP4BoxReady called with info:', info);
    if (!mediaSource || cancelledRef.current) return;

    state.current.duration = info.duration / info.timescale;
    console.log('[MSE] Duration:', state.current.duration, 'seconds');

    // Set MediaSource duration so the video element knows the total length
    if (mediaSource.readyState === 'open') {
      mediaSource.duration = state.current.duration;
      console.log('[MSE] MediaSource duration set to', state.current.duration);
    }

    // Extract tracks
    for (const track of info.videoTracks) {
      state.current.videoTracks.push({
        id: track.id,
        codec: track.codec,
        width: track.width,
        height: track.height,
        duration: track.duration,
        timescale: track.timescale,
      });
    }

    for (const track of info.audioTracks) {
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

    // Create SourceBuffers
    try {
      if (state.current.videoTracks.length > 0) {
        const track = state.current.videoTracks[0];
        const mimeType = `video/mp4; codecs="${track.codec}"`;
        if (MediaSource.isTypeSupported(mimeType)) {
          const sb = mediaSource.addSourceBuffer(mimeType);
          state.current.videoSourceBuffer = new SourceBufferWrapper(sb);
        } else {
          console.warn('[MSE] Video codec not supported:', mimeType);
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
      // Signal that init segments are appended — video can now load the blob URL
      setMseReady(true);
      setIsReady(true);
      setIsPrefetching(true);
      console.log('[MSE] Initialization complete!');

      // Set up mp4box callback for segments
      mp4box.onSegment = (trackId: number, user: any, buffer: ArrayBuffer, _sampleNum: number, isLast: boolean) => {
        if (cancelledRef.current) return;

        if (trackId === videoTrackId && state.current.videoSourceBuffer) {
          state.current.videoSourceBuffer.appendBuffer(buffer);
        }
        if (trackId === audioTrackId && state.current.audioSourceBuffer) {
          state.current.audioSourceBuffer.appendBuffer(buffer);
        }

        if (isLast) {
          console.log('[MSE] All segments flushed');
        }
      };

      // Start mp4box segment generation
      console.log('[MSE] Starting mp4box segment generation...');
      mp4box.start();

      // Start downloading and appending
      downloadLoop(url);
    } catch (e: any) {
      console.error('[MSE] Failed to create SourceBuffers:', e);
      if (!cancelledRef.current) {
        setUseNative(true);
      }
    }
  };

  const downloadLoop = async (url: string) => {
    if (cancelledRef.current || !state.current.initialized) return;

    state.current.downloading = true;

    while (!cancelledRef.current && state.current.downloading && state.current.currentOffset < state.current.fileLength) {
      // Check for pending seek
      if (state.current.pendingSeek >= 0) {
        const seekByte = state.current.pendingSeek;
        const seekTime = state.current.bitrate > 0 ? seekByte / state.current.bitrate : 0;
        state.current.pendingSeek = -1;
        state.current.currentOffset = seekByte;

        // Reset mp4box for new position — segments mode uses mp4box timestamps directly
        state.current.mp4box.flush();
        state.current.mp4box.seek(seekTime, true);

        console.log(`[MSE] Seeking to ${formatBytes(seekByte)} (${seekTime.toFixed(1)}s)`);
      }

      const offset = state.current.currentOffset;
      const end = Math.min(offset + FRAGMENT_SIZE - 1, state.current.fileLength - 1);

      // Create a new AbortController for this fetch
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch(url, {
          headers: { Range: `bytes=${offset}-${end}` },
          signal: controller.signal,
        });

        if (cancelledRef.current) break;

        if (!response.ok && response.status !== 206) {
          console.error('[MSE] Download failed:', response.status);
          break;
        }

        const data = await response.arrayBuffer();
        if (cancelledRef.current) break;

        // Feed to mp4box for segmentation
        const buffer = data as any;
        buffer.fileStart = offset;
        state.current.mp4box.appendBuffer(buffer);
        state.current.mp4box.flush();

        // Update tracking
        state.current.currentOffset = offset + data.byteLength;
        setPrefetchedBytes(state.current.currentOffset);

        // Speed tracking
        const now = Date.now();
        speedHistory.current.push({ bytes: data.byteLength, time: now });
        speedHistory.current = speedHistory.current.filter(s => s.time > now - 5000);
        if (speedHistory.current.length > 1) {
          const first = speedHistory.current[0];
          const last = speedHistory.current[speedHistory.current.length - 1];
          const timeDiff = (last.time - first.time) / 1000;
          if (timeDiff > 0) {
            const bytesTotal = speedHistory.current.reduce((sum, s) => sum + s.bytes, 0);
            setSpeed(bytesTotal / timeDiff);
          }
        }

        // No delay — fetch as fast as possible for smooth playback
      } catch (e: any) {
        if (cancelledRef.current) break;
        if (e.name === 'AbortError') break; // Seek cancelled this fetch
        console.error('[MSE] Download error:', e);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    state.current.downloading = false;

    // Only set isComplete if we reached the end (not interrupted by seek)
    const reachedEnd = state.current.currentOffset >= state.current.fileLength;
    if (!cancelledRef.current) {
      if (reachedEnd) {
        setIsComplete(true);
      }
      setIsPrefetching(false);
      setSpeed(0);
    }
  };
  downloadLoopRef.current = downloadLoop;

  // Direct seek function — bypasses currentTime observer for MSE unbuffered seeking
  const seekTo = useCallback((timeSeconds: number) => {
    if (!state.current.initialized || !streamUrl || useNative) return;
    if (state.current.fileLength <= 0 || state.current.bitrate <= 0) return;
    if (!isFinite(timeSeconds) || timeSeconds < 0) return;

    const seekByte = Math.floor((timeSeconds / state.current.duration) * state.current.fileLength);
    console.log(`[MSE] seekTo(${timeSeconds.toFixed(1)}s) → byte ${formatBytes(seekByte)}`);
    state.current.pendingSeek = seekByte;
    state.current.downloading = false;

    // Set currentTime immediately — progress bar jumps to new position right away
    if (videoRef.current) {
      videoRef.current.currentTime = timeSeconds;
    }

    // Cancel any in-flight fetch so the loop exits immediately
    abortRef.current?.abort();
    abortRef.current = null;
    setIsComplete(false);
    setIsPrefetching(true);

    // Restart download loop immediately — fetch was aborted above
    setTimeout(() => {
      if (!cancelledRef.current && downloadLoopRef.current && streamUrl) {
        downloadLoopRef.current(streamUrl);
      }
    }, 50);
  }, [streamUrl, useNative]);

  const pausePrefetch = () => {
    state.current.downloading = false;
    setIsPaused(true);
    setIsPrefetching(false);
    setSpeed(0);
  };

  const resumePrefetch = () => {
    if (!state.current.downloading && streamUrl && downloadLoopRef.current) {
      setIsPaused(false);
      setIsPrefetching(true);
      downloadLoopRef.current(streamUrl);
    }
  };

  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
  }, []);

  return {
    mseUrl: useNative ? null : mseUrl, // Return null to use native video
    mseReady: useNative ? true : mseReady, // Ready immediately for native
    isReady: useNative ? true : isReady, // Ready immediately for native
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
