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
  const hoverMutexRef = useRef(false);
  const lastHoverTimeRef = useRef(0);

  // Throttle for cachedTimes updates
  const lastCachedUpdateRef = useRef(0);

  // Create hidden video element (for on-demand hover to unbuffered positions)
  useEffect(() => {
    if (!streamUrl) return;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata'; // Minimal bandwidth — only load metadata
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
    if (now - lastCachedUpdateRef.current > 1000) {
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
      console.log('[ThumbnailExtractor] Starting main video frame capture');

      const onFrame = () => {
        if (!active || !started) return;

        const time = video.currentTime;
        const bucket = Math.floor(time / BUCKET_SIZE) * BUCKET_SIZE;

        if (bucket !== lastCaptureBucket && !frameBufferRef.current.has(bucket) && video.readyState >= 2) {
          lastCaptureBucket = bucket;
          captureFrame(video, bucket);
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

  // Background loop: use hidden video to fill buffered range gaps
  // The main video downloads data → browser HTTP cache → hidden video reads from cache (no extra bandwidth)
  // This keeps thumbnails in sync with the buffer even when playback is behind
  useEffect(() => {
    if (!ready || !mseReady) return;
    let animId: number;
    let started = false;

    const loop = () => {
      const video = hiddenVideoRef.current;
      const mainVideo = mainVideoRef.current;
      if (!video || !mainVideo) {
        animId = requestAnimationFrame(loop);
        return;
      }

      // Start hidden video after delay
      if (!started && video.readyState >= 1) {
        started = true;
        video.playbackRate = 16;
        video.currentTime = 0;
        video.play().catch(() => {});
        console.log('[ThumbnailExtractor-BG] Started hidden video for buffered range sync');
      }

      if (!started || hoverMutexRef.current) {
        animId = requestAnimationFrame(loop);
        return;
      }

      const time = video.currentTime;
      const bucket = Math.floor(time / BUCKET_SIZE) * BUCKET_SIZE;

      // Only capture if this position is within the main video's buffered range
      let isBuffered = false;
      for (let i = 0; i < mainVideo.buffered.length; i++) {
        if (time >= mainVideo.buffered.start(i) && time <= mainVideo.buffered.end(i)) {
          isBuffered = true;
          break;
        }
      }

      if (isBuffered && !frameBufferRef.current.has(bucket) && video.readyState >= 2) {
        captureFrame(video, bucket);
      }

      // If we've gone past the buffer, pause and wait
      if (!isBuffered && time > 0) {
        // Find the end of the current buffer
        let bufferEnd = 0;
        for (let i = 0; i < mainVideo.buffered.length; i++) {
          bufferEnd = Math.max(bufferEnd, mainVideo.buffered.end(i));
        }
        // If we're past the buffer, jump back to buffer end to wait for more data
        if (time > bufferEnd + 5) {
          video.pause();
          // Check again in 2 seconds
          setTimeout(() => {
            if (hiddenVideoRef.current && !hoverMutexRef.current) {
              video.playbackRate = 16;
              video.play().catch(() => {});
            }
          }, 2000);
        }
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [ready, mseReady, captureFrame]);

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
      }, 3000);
    });
  }, []);

  // Hover request processor — processes one request at a time
  useEffect(() => {
    if (!ready) return;
    let active = true;

    const processLoop = async () => {
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

        const video = hiddenVideoRef.current;
        if (!video) {
          request.resolve(null);
          continue;
        }

        const bucket = Math.floor(request.time / BUCKET_SIZE) * BUCKET_SIZE;

        // Check cache first (instant — captured during playback)
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

        video.pause();
        hoverMutexRef.current = true;

        const ok = await seekTo(video, request.time);

        if (ok) {
          captureFrame(video, bucket);
        }

        hoverMutexRef.current = false;
        lastHoverTimeRef.current = Date.now();

        // Resume hidden video in preload mode (minimal bandwidth)
        video.preload = 'metadata';

        const result = frameBufferRef.current.get(bucket);
        if (result) {
          request.resolve({ dataUrl: result, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, time: bucket });
        } else {
          request.resolve(null);
        }
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
      return { dataUrl: cached, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, time: bucket };
    }

    // Cancel all previous pending requests
    for (const req of hoverQueueRef.current) {
      req.resolve(null);
    }
    hoverQueueRef.current = [];

    // Create per-request Promise
    return new Promise<ThumbnailResult | null>((resolve) => {
      const request: PendingRequest = { time: timeSeconds, resolve };
      hoverQueueRef.current.push(request);

      setTimeout(() => {
        const idx = hoverQueueRef.current.indexOf(request);
        if (idx >= 0) {
          hoverQueueRef.current.splice(idx, 1);
          resolve(null);
        }
      }, 5000);
    });
  }, []);

  return { ready, getThumbnail, cachedTimes };
}
