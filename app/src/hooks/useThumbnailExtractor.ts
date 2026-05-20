import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hover preview thumbnail extractor.
 *
 * Design:
 * - Captures frames from MAIN video during playback (zero bandwidth cost)
 * - Delayed start: waits for MSE ready + 2 seconds before capturing
 * - On-demand: hidden video used for unplayed hover positions (lazy metadata load)
 * - Ref-based desired position: hover processor continuously targets current hover position
 *   (no queue, no cancellation, no stale results)
 * - Synchronous cache check for instant display of already-cached thumbnails
 * - FIFO eviction at 5000 entries (~166 min at 2s intervals)
 */

const THUMBNAIL_WIDTH = 114;
const THUMBNAIL_HEIGHT = 64;
const BUCKET_SIZE = 2;
const MAX_BUFFER_SIZE = 5000;
const CAPTURE_DELAY_MS = 2000;

export function useThumbnailExtractor(
  mainVideoRef: React.RefObject<HTMLVideoElement | null>,
  streamUrl: string | null,
  mseReady: boolean = false,
) {
  const [ready, setReady] = useState(false);
  const [cachedTimes, setCachedTimes] = useState<Set<number>>(new Set());

  const frameBufferRef = useRef<Map<number, string>>(new Map());
  const insertionOrderRef = useRef<number[]>([]);

  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const durationRef = useRef(0);

  const desiredHoverTimeRef = useRef<number>(-1);
  const hoverActiveRef = useRef(false);

  const lastCachedUpdateRef = useRef(0);

  // Create hidden video element (for on-demand hover to unbuffered positions)
  useEffect(() => {
    if (!streamUrl) return;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'none';
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

    video.addEventListener('loadedmetadata', () => {
      durationRef.current = video.duration;
      setReady(true);
    });

    video.addEventListener('error', () => {
      console.warn('[ThumbnailExtractor] Hidden video error:', video.error?.code, video.error?.message);
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
      setReady(false);
      desiredHoverTimeRef.current = -1;
      hoverActiveRef.current = false;
    };
  }, [streamUrl]);

  // Track main video duration
  useEffect(() => {
    const video = mainVideoRef.current;
    if (!video) return;

    const onDurationChange = () => {
      durationRef.current = video.duration;
    };

    video.addEventListener('durationchange', onDurationChange);
    durationRef.current = video.duration;

    return () => {
      video.removeEventListener('durationchange', onDurationChange);
    };
  }, [mainVideoRef]);

  // Force-update cachedTimes (bypass throttle — used after on-demand captures
  // so the yellow bar and display effect update promptly)
  const forceUpdateCachedTimes = useCallback(() => {
    lastCachedUpdateRef.current = Date.now();
    setCachedTimes(new Set(frameBufferRef.current.keys()));
  }, []);

  // Throttled cachedTimes update (for main video capture — high frequency)
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

  // Capture frame using reusable canvas
  const captureFrame = useCallback((video: HTMLVideoElement, bucket: number, isOnDemand: boolean = false): boolean => {
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

      // Force update after on-demand capture so display effect and yellow bar
      // update promptly. Throttled update for main video capture.
      if (isOnDemand) {
        forceUpdateCachedTimes();
      } else {
        updateCachedTimes();
      }
      return true;
    } catch {
      return false;
    }
  }, [evictIfNeeded, forceUpdateCachedTimes, updateCachedTimes]);

  // Capture frames from main video during playback (zero bandwidth cost)
  useEffect(() => {
    const video = mainVideoRef.current;
    if (!video || !mseReady || !('requestVideoFrameCallback' in video)) return;

    let active = true;
    let lastCaptureBucket = -1;
    let started = false;

    const timer = setTimeout(() => {
      started = true;

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
      }, 10000);
    });
  }, []);

  // Ensure hidden video metadata is loaded (lazy load on first request)
  const ensureMetadata = useCallback(async (video: HTMLVideoElement): Promise<boolean> => {
    if (video.readyState >= 1) return true;

    video.load();

    return new Promise((resolve) => {
      let done = false;
      const onLoaded = () => {
        if (done) return;
        done = true;
        video.removeEventListener('loadedmetadata', onLoaded);
        durationRef.current = video.duration;
        setReady(true);
        resolve(true);
      };
      video.addEventListener('loadedmetadata', onLoaded);
      setTimeout(() => {
        if (!done) {
          done = true;
          video.removeEventListener('loadedmetadata', onLoaded);
          resolve(false);
        }
      }, 10000);
    });
  }, []);

  // Hover processor — ref-based: continuously targets desiredHoverTimeRef.
  // No queue, no cancellation, no stale results. When the user moves, the
  // desired position changes and the processor adjusts naturally.
  useEffect(() => {
    let active = true;

    const processLoop = async () => {
      while (active) {
        const desiredTime = desiredHoverTimeRef.current;

        if (!hoverActiveRef.current || desiredTime < 0) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }

        const bucket = Math.floor(desiredTime / BUCKET_SIZE) * BUCKET_SIZE;

        if (frameBufferRef.current.has(bucket)) {
          await new Promise(r => setTimeout(r, 50));
          continue;
        }

        const video = hiddenVideoRef.current;
        if (!video) {
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        const metadataOk = await ensureMetadata(video);
        if (!metadataOk || !active) continue;

        video.pause();
        const ok = await seekTo(video, desiredTime);

        if (ok && active) {
          captureFrame(video, bucket, true);
        }

        video.pause();

        await new Promise(r => setTimeout(r, 50));
      }
    };

    processLoop();
    return () => { active = false; };
  }, [seekTo, ensureMetadata, captureFrame]);

  // Public API: getCachedThumbnailSync — returns cached dataUrl synchronously
  const getCachedThumbnailSync = useCallback((timeSeconds: number): string | null => {
    const bucket = Math.floor(timeSeconds / BUCKET_SIZE) * BUCKET_SIZE;
    return frameBufferRef.current.get(bucket) ?? null;
  }, []);

  // Public API: setDesiredHoverTime — updates the desired position for the hover processor
  const setDesiredHoverTime = useCallback((time: number) => {
    desiredHoverTimeRef.current = time;
    hoverActiveRef.current = true;
  }, []);

  // Public API: clearDesiredHover — called when mouse leaves the progress bar
  const clearDesiredHover = useCallback(() => {
    hoverActiveRef.current = false;
    desiredHoverTimeRef.current = -1;
  }, []);

  return { ready, getCachedThumbnailSync, setDesiredHoverTime, clearDesiredHover, cachedTimes };
}
