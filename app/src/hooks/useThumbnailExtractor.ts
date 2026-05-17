import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hover preview thumbnail extractor.
 *
 * Design:
 * - Hidden video plays at 8x speed, background loop captures frames via rAF
 * - Hover requests use a mutex — only ONE active at a time, new ones replace it
 * - After hover, background continues from hover position (doesn't jump to 0)
 * - toDataURL (synchronous) for immediate thumbnail availability
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

export function useThumbnailExtractor(
  mainVideoRef: React.RefObject<HTMLVideoElement | null>,
  streamUrl: string | null,
) {
  const [ready, setReady] = useState(false);
  const [cachedTimes, setCachedTimes] = useState<Set<number>>(new Set());
  const frameBufferRef = useRef<Map<number, string>>(new Map());
  const doneRangesRef = useRef<{ start: number; end: number }[]>([]);
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const mainTimeRef = useRef(0);
  const durationRef = useRef(0);

  // Mutex for hover requests — only one active at a time
  const hoverMutexRef = useRef(false);
  const hoverSignalRef = useRef<((time: number) => void) | null>(null);
  const hoverResultRef = useRef<ThumbnailResult | null | undefined>(undefined);
  const lastHoverTimeRef = useRef(0);

  // Create hidden video element
  useEffect(() => {
    if (!streamUrl) return;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.style.position = 'absolute';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    document.body.appendChild(video);

    video.src = streamUrl;

    video.addEventListener('loadeddata', () => {
      console.log('[ThumbnailExtractor] Hidden video ready, duration:', video.duration);
      durationRef.current = video.duration;
      setReady(true);
      video.playbackRate = 16;
      video.currentTime = 0;
      video.play().catch(() => {});
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
      setReady(false);
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

  // Done-range helpers
  const isDone = useCallback((bucket: number): boolean => {
    for (const r of doneRangesRef.current) {
      if (bucket >= r.start && bucket <= r.end) return true;
    }
    return false;
  }, []);

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

  // Capture frame synchronously
  const captureFrame = useCallback((video: HTMLVideoElement, bucket: number): boolean => {
    if (frameBufferRef.current.has(bucket)) return true;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = THUMBNAIL_WIDTH;
      canvas.height = THUMBNAIL_HEIGHT;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      frameBufferRef.current.set(bucket, dataUrl);
      markDone(bucket);
      setCachedTimes(new Set(frameBufferRef.current.keys()));
      return true;
    } catch {
      return false;
    }
  }, [markDone]);

  // Helper: find the first uncovered position in the buffered range
  const findUncoveredBufferedPosition = useCallback((): number | null => {
    const mainVideo = mainVideoRef.current;
    if (!mainVideo || mainVideo.buffered.length === 0) return null;

    // Find the buffered range containing current playback position
    const mainTime = mainTimeRef.current;
    for (let i = 0; i < mainVideo.buffered.length; i++) {
      const start = mainVideo.buffered.start(i);
      const end = mainVideo.buffered.end(i);

      // Only look at the buffered range containing current position
      if (mainTime >= start && mainTime <= end) {
        // Find the first uncovered bucket in this range
        const beginBucket = Math.floor(start / BUCKET_SIZE) * BUCKET_SIZE;
        const endBucket = Math.floor(end / BUCKET_SIZE) * BUCKET_SIZE;
        for (let b = beginBucket; b <= endBucket; b += BUCKET_SIZE) {
          if (!isDone(b)) {
            return b;
          }
        }
        return null; // all covered
      }
    }
    return null;
  }, [mainVideoRef, isDone]);

  // Helper: find how many buckets are uncovered in the buffered range
  const getUncoveredBufferedCount = useCallback((): number => {
    const mainVideo = mainVideoRef.current;
    if (!mainVideo || mainVideo.buffered.length === 0) return 0;

    const mainTime = mainTimeRef.current;
    let uncovered = 0;
    for (let i = 0; i < mainVideo.buffered.length; i++) {
      const start = mainVideo.buffered.start(i);
      const end = mainVideo.buffered.end(i);
      if (mainTime >= start && mainTime <= end) {
        const beginBucket = Math.floor(start / BUCKET_SIZE) * BUCKET_SIZE;
        const endBucket = Math.floor(end / BUCKET_SIZE) * BUCKET_SIZE;
        for (let b = beginBucket; b <= endBucket; b += BUCKET_SIZE) {
          if (!isDone(b)) uncovered++;
        }
        break;
      }
    }
    return uncovered;
  }, [mainVideoRef, isDone]);

  // Background capture loop — dynamically adjusts to keep up with buffered ranges
  useEffect(() => {
    if (!ready) return;
    let animId: number;
    let captureCount = 0;
    let checkCounter = 0;

    const loop = () => {
      const video = hiddenVideoRef.current;
      if (!video) {
        animId = requestAnimationFrame(loop);
        return;
      }

      // Skip if hover is active
      if (hoverMutexRef.current) {
        animId = requestAnimationFrame(loop);
        return;
      }

      const time = video.currentTime;
      const bucket = Math.floor(time / BUCKET_SIZE) * BUCKET_SIZE;

      // Every 30 ticks (~500ms), check if we need to jump to uncovered buffered area
      checkCounter++;
      if (checkCounter >= 30) {
        checkCounter = 0;

        const uncovered = getUncoveredBufferedCount();
        if (uncovered > 0) {
          const target = findUncoveredBufferedPosition();
          if (target !== null && Math.abs(target - time) > 10) {
            // Jump to the uncovered area
            console.log(`[ThumbnailExtractor-BG] BUFFER SYNC: ${uncovered} uncovered buckets, jumping ${time.toFixed(1)}s → ${target}s`);
            video.currentTime = target;
            video.playbackRate = 16;
            if (video.paused) video.play().catch(() => {});
          }
        }
      }

      // Capture frame if not done and video is ready
      if (!isDone(bucket) && video.readyState >= 2) {
        captureFrame(video, bucket);
        captureCount++;
        if (captureCount % 10 === 0) {
          const uncovered = getUncoveredBufferedCount();
          console.log(`[ThumbnailExtractor-BG] Captured ${captureCount} frames, at ${time.toFixed(1)}s, buffer=${frameBufferRef.current.size}, uncovered=${uncovered}`);
        }
      }

      // Check end
      if (time >= (durationRef.current || Infinity) - 1) {
        video.pause();
        console.log(`[ThumbnailExtractor-BG] Reached end, captured=${captureCount}`);
      }

      animId = requestAnimationFrame(loop);
    };

    console.log('[ThumbnailExtractor-BG] Starting background loop (buffer-aware)');
    animId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animId);
  }, [ready, isDone, captureFrame, findUncoveredBufferedPosition, getUncoveredBufferedCount]);

  // Seek helper
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

  // Hover request handler — runs in a loop, processes one request at a time
  useEffect(() => {
    if (!ready) return;
    let active = true;

    const processLoop = async () => {
      while (active) {
        // Wait for a hover request
        const target = await new Promise<number | null>((resolve) => {
          hoverSignalRef.current = resolve;
        });

        if (!active || target === null) continue;

        const video = hiddenVideoRef.current;
        if (!video) continue;

        const bucket = Math.floor(target / BUCKET_SIZE) * BUCKET_SIZE;

        // Check cache first
        const cached = frameBufferRef.current.get(bucket);
        if (cached) {
          hoverResultRef.current = { dataUrl: cached, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, time: bucket };
          continue;
        }

        // Pause background, seek, capture
        console.log(`[ThumbnailExtractor-HOVER] Seeking to ${target.toFixed(1)}s (bucket ${bucket})`);
        video.pause();
        hoverMutexRef.current = true;

        const seekStart = performance.now();
        const ok = await seekTo(video, target);
        console.log(`[ThumbnailExtractor-HOVER] Seek ${(performance.now() - seekStart).toFixed(0)}ms, ok=${ok}`);

        if (ok) {
          captureFrame(video, bucket);
        }

        hoverMutexRef.current = false;
        lastHoverTimeRef.current = Date.now();

        // Resume background playback
        video.playbackRate = 16;
        video.play().catch(() => {});

        const result = frameBufferRef.current.get(bucket);
        if (result) {
          console.log(`[ThumbnailExtractor-HOVER] Captured bucket ${bucket}, buffer=${frameBufferRef.current.size}`);
          hoverResultRef.current = { dataUrl: result, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, time: bucket };
        } else {
          console.log(`[ThumbnailExtractor-HOVER] Failed to capture bucket ${bucket}`);
          hoverResultRef.current = null;
        }
      }
    };

    processLoop();
    return () => { active = false; };
  }, [ready, seekTo, captureFrame]);

  // Public API: getThumbnail — signals the hover processor and waits for result
  const getThumbnail = useCallback(async (timeSeconds: number): Promise<ThumbnailResult | null> => {
    const bucket = Math.floor(timeSeconds / BUCKET_SIZE) * BUCKET_SIZE;

    // Check cache first (instant)
    const cached = frameBufferRef.current.get(bucket);
    if (cached) {
      return { dataUrl: cached, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, time: bucket };
    }

    // Signal the hover processor and wait for result
    if (hoverSignalRef.current) {
      hoverResultRef.current = undefined;
      hoverSignalRef.current(timeSeconds);

      // Poll for result
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if (hoverResultRef.current !== undefined) {
          return hoverResultRef.current;
        }
        await new Promise(r => setTimeout(r, 50));
      }
    }

    return null;
  }, []);

  return { ready, getThumbnail, cachedTimes };
}
