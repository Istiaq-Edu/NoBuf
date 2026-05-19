import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hover preview thumbnail extractor.
 *
 * Design:
 * - Captures frames from MAIN video during playback (zero bandwidth cost)
 * - Thumbnails never go ahead of the buffer — only captures what's already buffered
 * - Delayed start: waits for MSE ready + 5 seconds before capturing
 * - On-demand: hidden video used ONLY for unbuffered hover positions
 * - Per-request Promise pattern for hover (no race conditions)
 * - FIFO eviction at 300 entries
 */

export interface ThumbnailResult {
  dataUrl: string;
  width: number;
  height: number;
  time: number;
}

const THUMBNAIL_WIDTH = 114;
const THUMBNAIL_HEIGHT = 64;
const BUCKET_SIZE = 2;
const MAX_BUFFER_SIZE = 300;
const CAPTURE_DELAY_MS = 5000; // Wait 5s after MSE ready before starting capture

interface PendingRequest {
  time: number;
  resolve: (result: ThumbnailResult | null) => void;
}

export function useThumbnailExtractor(
  mainVideoRef: React.RefObject<HTMLVideoElement | null>,
  streamUrl: string | null,
  mseReady: boolean = false,
) {
  const [ready, setReady] = useState(false);
  const [cachedTimes, setCachedTimes] = useState<Set<number>>(new Set());

  // Frame storage — FIFO with max size
  const frameBufferRef = useRef<Map<number, string>>(new Map());
  const insertionOrderRef = useRef<number[]>([]);
  const doneRangesRef = useRef<{ start: number; end: number }[]>([]);

  // Hidden video (for on-demand only)
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mainTimeRef = useRef(0);
  const durationRef = useRef(0);

  // Hover request protocol
  const hoverQueueRef = useRef<PendingRequest[]>([]);

  // Throttle for cachedTimes updates
  const lastCachedUpdateRef = useRef(0);

  // Create hidden video element (for on-demand hover to unbuffered positions)
  useEffect(() => {
    if (!streamUrl) return;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'none'; // Don't auto-download — only load on-demand for hover thumbnails
    video.crossOrigin = 'anonymous';
    video.style.position = 'absolute';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    document.body.appendChild(video);

    const canvas = document.createElement('canvas');
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    canvasRef.current = canvas;

    video.src = streamUrl;

    video.addEventListener('loadeddata', () => {
      console.log('[ThumbnailExtractor] Hidden video loaded (on-demand only)');
      durationRef.current = video.duration;
      setReady(true);
    });

    video.addEventListener('error', () => {
      console.warn('[ThumbnailExtractor] Hidden video error:', video.error);
    });

    hiddenVideoRef.current = video;

    return () => {
      video.pause();
      video.removeAttribute('src');
      video.removeAttribute('crossorigin');
      video.load();
      document.body.removeChild(video);
      hiddenVideoRef.current = null;
      canvasRef.current = null;

      frameBufferRef.current.clear();
      insertionOrderRef.current = [];
      doneRangesRef.current = [];
      setReady(false);

      for (const req of hoverQueueRef.current) {
        req.resolve(null);
      }
      hoverQueueRef.current = [];
    };
  }, [streamUrl]);

  // Track main video time
  useEffect(() => {
    const video = mainVideoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      mainTimeRef.current = video.currentTime;
    };
    const onDurationChange = () => {
      durationRef.current = video.duration;
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    mainTimeRef.current = video.currentTime;
    durationRef.current = video.duration;

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
    };
  }, [mainVideoRef]);

  // Throttled cachedTimes update
  const updateCachedTimes = useCallback(() => {
    const now = Date.now();
    if (now - lastCachedUpdateRef.current > 500) {
      lastCachedUpdateRef.current = now;
      setCachedTimes(new Set(frameBufferRef.current.keys()));
    }
  }, []);

  // FIFO eviction helper
  const evictIfNeeded = useCallback(() => {
    const buf = frameBufferRef.current;
    const order = insertionOrderRef.current;
    while (buf.size > MAX_BUFFER_SIZE && order.length > 0) {
      const oldest = order.shift()!;
      buf.delete(oldest);
    }
  }, []);

  // Done-range helpers
  const markDone = useCallback((bucket: number) => {
    doneRangesRef.current.push({ start: bucket, end: bucket });
    const ranges = doneRangesRef.current.sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const r of ranges) {
      if (merged.length > 0 && r.start <= merged[merged.length - 1].end + BUCKET_SIZE) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
      } else {
        merged.push({ ...r });
      }
    }
    doneRangesRef.current = merged;
  }, []);

  // Capture frame using reusable canvas
  const captureFrame = useCallback((video: HTMLVideoElement, bucket: number): boolean => {
    if (frameBufferRef.current.has(bucket)) return true;
    const canvas = canvasRef.current;
    if (!canvas) return false;

    try {
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6);

      frameBufferRef.current.set(bucket, dataUrl);
      insertionOrderRef.current.push(bucket);
      evictIfNeeded();
      markDone(bucket);
      updateCachedTimes();
      return true;
    } catch {
      return false;
    }
  }, [markDone, evictIfNeeded, updateCachedTimes]);

  // Capture frames from main video during playback (zero bandwidth cost)
  // Starts after delay to let video buffer first
  useEffect(() => {
    const video = mainVideoRef.current;
    if (!video || !mseReady || !('requestVideoFrameCallback' in video)) return;

    let active = true;
    let lastCaptureBucket = -1;
    let started = false;

    const timer = setTimeout(() => {
      started = true;
      console.log(`[MAIN-CAP] Starting main video frame capture after ${CAPTURE_DELAY_MS}ms delay`);
      let mainCaptureCount = 0;

      const onFrame = () => {
        if (!active || !started) return;

        const time = video.currentTime;
        const bucket = Math.floor(time / BUCKET_SIZE) * BUCKET_SIZE;

        if (bucket !== lastCaptureBucket && !frameBufferRef.current.has(bucket) && video.readyState >= 2) {
          lastCaptureBucket = bucket;
          const captured = captureFrame(video, bucket);
          mainCaptureCount++;
          if (mainCaptureCount <= 5 || mainCaptureCount % 20 === 0) {
            console.log(`[MAIN-CAP] #${mainCaptureCount}: ${time.toFixed(1)}s (bucket ${bucket}), success=${captured}, cacheSize=${frameBufferRef.current.size}`);
          }
        }

        (video as any).requestVideoFrameCallback(onFrame);
      };

      (video as any).requestVideoFrameCallback(onFrame);
    }, CAPTURE_DELAY_MS);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [mainVideoRef, mseReady, captureFrame]);

  // Seek helper for hidden video
  const seekTo = useCallback((video: HTMLVideoElement, time: number): Promise<boolean> => {
    return new Promise((resolve) => {
      if (Math.abs(video.currentTime - time) < 0.3 && video.readyState >= 2) {
        resolve(true);
        return;
      }
      let done = false;
      const onSeeked = () => {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', onSeeked);
        resolve(true);
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = time;
      setTimeout(() => {
        if (!done) {
          done = true;
          video.removeEventListener('seeked', onSeeked);
          resolve(false);
        }
      }, 5000);
    });
  }, []);

  // No background hidden video loop — main video capture via requestVideoFrameCallback handles buffered content.
  // Hidden video is used ONLY for on-demand hover requests (see hover processor below).

  // Hover request processor — processes one request at a time
  useEffect(() => {
    if (!ready) return;
    let active = true;

    let hoverCount = 0;

    const processLoop = async () => {
      console.log(`[HOVER] Process loop started, ready=${ready}`);
      while (active) {
        const request = await new Promise<PendingRequest | null>((resolve) => {
          const checkQueue = () => {
            if (!active) { resolve(null); return; }
            const req = hoverQueueRef.current.shift();
            if (req) { resolve(req); return; }
            setTimeout(checkQueue, 50);
          };
          checkQueue();
        });

        if (!active || !request) continue;

        hoverCount++;
        const video = hiddenVideoRef.current;
        if (!video) {
          request.resolve(null);
          continue;
        }

        const bucket = Math.floor(request.time / BUCKET_SIZE) * BUCKET_SIZE;

        // Check cache first
        const cached = frameBufferRef.current.get(bucket);
        if (cached) {
          request.resolve({ dataUrl: cached, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, time: bucket });
          continue;
        }

        // Not cached — use hidden video for on-demand capture
        if (video.readyState < 1) {
          request.resolve(null);
          continue;
        }

        // Seek hidden video to requested position
        video.pause();
        const seekStart = performance.now();
        const ok = await seekTo(video, request.time);
        const seekMs = performance.now() - seekStart;

        console.log(`[HOVER] #${hoverCount}: time=${request.time.toFixed(1)}s, seek=${seekMs.toFixed(0)}ms, ok=${ok}`);

        if (ok) {
          captureFrame(video, bucket);
        }

        // Stop hidden video after capture — no background loop to resume
        video.pause();

        const result = frameBufferRef.current.get(bucket);
        request.resolve(result ? { dataUrl: result, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, time: bucket } : null);
      }
    };

    processLoop();
    return () => { active = false; };
  }, [ready, seekTo, captureFrame]);

  // Public API: getThumbnail — latest request wins
  const getThumbnail = useCallback(async (timeSeconds: number): Promise<ThumbnailResult | null> => {
    const bucket = Math.floor(timeSeconds / BUCKET_SIZE) * BUCKET_SIZE;

    // Check cache first (instant — captured during playback)
    const cached = frameBufferRef.current.get(bucket);
    if (cached) {
      console.log(`[GET] time=${timeSeconds.toFixed(1)}s, bucket=${bucket} → CACHE_HIT`);
      return { dataUrl: cached, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, time: bucket };
    }

    // Cancel all previous pending requests
    const cancelled = hoverQueueRef.current.length;
    if (cancelled > 0) {
      console.log(`[GET] time=${timeSeconds.toFixed(1)}s, cancelling ${cancelled} pending requests`);
    }
    for (const req of hoverQueueRef.current) {
      req.resolve(null);
    }
    hoverQueueRef.current = [];

    // Create per-request Promise
    return new Promise<ThumbnailResult | null>((resolve) => {
      const request: PendingRequest = { time: timeSeconds, resolve };
      hoverQueueRef.current.push(request);
      console.log(`[GET] time=${timeSeconds.toFixed(1)}s, bucket=${bucket} → QUEUED (queue=${hoverQueueRef.current.length})`);

      setTimeout(() => {
        const idx = hoverQueueRef.current.indexOf(request);
        if (idx >= 0) {
          console.warn(`[GET] time=${timeSeconds.toFixed(1)}s → TIMEOUT (5s)`);
          hoverQueueRef.current.splice(idx, 1);
          resolve(null);
        }
      }, 5000);
    });
  }, []);

  return { ready, getThumbnail, cachedTimes };
}
