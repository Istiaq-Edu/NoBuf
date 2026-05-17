import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hover preview thumbnail extractor — inspired by FastStream's PreviewFrameExtractor.
 *
 * Strategy:
 * - Hidden <video> element continuously generates thumbnails in a background loop
 * - Follows the main player's position (±30s ahead), pauses when too far
 * - On hover to unbuffered area: jumps to that position, generates ~15s of thumbnails
 * - Keeps max 3 "sections" (continuous ranges), LRU eviction
 * - For buffered ranges: instant capture from main video (no seek needed)
 */

export interface ThumbnailResult {
  dataUrl: string;
  width: number;
  height: number;
  time: number;
}

interface Section {
  start: number; // first bucket time
  end: number;   // last bucket time
  thumbnails: Map<number, string>; // bucket → dataUrl
}

const THUMBNAIL_WIDTH = 114;
const THUMBNAIL_HEIGHT = 64;
const BUCKET_SIZE = 2; // seconds per thumbnail
const SECTION_DURATION = 15; // seconds per section
const MAX_SECTIONS = 3;

export function useThumbnailExtractor(
  mainVideoRef: React.RefObject<HTMLVideoElement | null>,
  streamUrl: string | null,
) {
  const [ready, setReady] = useState(false);
  const [cachedTimes, setCachedTimes] = useState<Set<number>>(new Set());
  const sectionsRef = useRef<Section[]>([]); // LRU: newest at end
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const generatingRef = useRef(false);
  const mainTimeRef = useRef(0);
  const durationRef = useRef(0);

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
      console.log('[ThumbnailExtractor] Hidden video ready');
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
      setReady(false);
    };
  }, [streamUrl]);


  // Helper: get thumbnail from any section
  const getCached = useCallback((bucket: number): string | null => {
    for (const s of sectionsRef.current) {
      const url = s.thumbnails.get(bucket);
      if (url) return url;
    }
    return null;
  }, []);

  // Helper: evict oldest section if over limit
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const evictIfNeeded = useCallback(() => {
    while (sectionsRef.current.length > MAX_SECTIONS) {
      const removed = sectionsRef.current.shift()!;
      removed.thumbnails.clear();
    }
    updateCachedTimes();
  }, []);

  // Helper: update cachedTimes state
  const updateCachedTimes = useCallback(() => {
    const times = new Set<number>();
    for (const s of sectionsRef.current) {
      for (const key of s.thumbnails.keys()) {
        times.add(key);
      }
    }
    setCachedTimes(times);
  }, []);

  // Helper: capture frame at current hidden video position
  const captureFrame = useCallback((video: HTMLVideoElement, _bucket: number): string | null => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = THUMBNAIL_WIDTH;
      canvas.height = THUMBNAIL_HEIGHT;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
      return canvas.toDataURL('image/jpeg', 0.6);
    } catch (e) {
      console.warn('[ThumbnailExtractor] Canvas capture failed:', e);
      return null;
    }
  }, []);

  // Helper: seek hidden video to time and wait for seeked
  const seekTo = useCallback((video: HTMLVideoElement, time: number): Promise<boolean> => {
    return new Promise((resolve) => {
      if (Math.abs(video.currentTime - time) < 0.5 && video.readyState >= 2) {
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

  // Generate a section of thumbnails starting at startTime
  const generateSection = useCallback(async (startTime: number) => {
    const video = hiddenVideoRef.current;
    if (!video || !ready || generatingRef.current) return;
    generatingRef.current = true;

    const sectionStart = Math.floor(startTime / BUCKET_SIZE) * BUCKET_SIZE;
    const sectionEnd = sectionStart + SECTION_DURATION;
    const newSection: Section = {
      start: sectionStart,
      end: Math.min(sectionEnd, durationRef.current || Infinity),
      thumbnails: new Map(),
    };

    console.log(`[ThumbnailExtractor] Generating section ${sectionStart}s-${newSection.end}s`);

    for (let t = sectionStart; t <= newSection.end; t += BUCKET_SIZE) {
      // Check if already cached in any section
      if (getCached(t)) continue;

      const ok = await seekTo(video, t);
      if (!ok) continue;

      const dataUrl = captureFrame(video, t);
      if (dataUrl) {
        newSection.thumbnails.set(t, dataUrl);
      }
    }

    // Add section and evict oldest if needed
    sectionsRef.current.push(newSection);
    evictIfNeeded();

    console.log(`[ThumbnailExtractor] Section done: ${newSection.thumbnails.size} thumbnails`);
    generatingRef.current = false;
  }, [ready, getCached, seekTo, captureFrame, evictIfNeeded]);

  // Background generation: follow main player position
  const bgLoopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!ready) return;

    const bgLoop = async () => {
      const video = hiddenVideoRef.current;
      if (!video || generatingRef.current) {
        bgLoopRef.current = setTimeout(bgLoop, 1000);
        return;
      }

      const mainTime = mainTimeRef.current;
      const aheadTime = mainTime + 10; // generate 10s ahead

      // Check if ahead position is already cached
      const aheadBucket = Math.floor(aheadTime / BUCKET_SIZE) * BUCKET_SIZE;
      if (!getCached(aheadBucket) && aheadTime < (durationRef.current || Infinity)) {
        await generateSection(aheadTime);
      }

      bgLoopRef.current = setTimeout(bgLoop, 2000);
    };

    bgLoopRef.current = setTimeout(bgLoop, 3000); // start after 3s delay

    return () => {
      if (bgLoopRef.current) clearTimeout(bgLoopRef.current);
    };
  }, [ready, getCached, generateSection]);

  // Update main time ref from video element
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

  // Get thumbnail for hover
  const getThumbnail = useCallback(async (timeSeconds: number): Promise<ThumbnailResult | null> => {
    const bucket = Math.floor(timeSeconds / BUCKET_SIZE) * BUCKET_SIZE;

    // Check cache first (instant)
    const cached = getCached(bucket);
    if (cached) {
      return { dataUrl: cached, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, time: bucket };
    }

    // Not cached — generate a section starting at this position
    await generateSection(timeSeconds);

    const result = getCached(bucket);
    if (result) {
      return { dataUrl: result, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, time: bucket };
    }

    return null;
  }, [getCached, generateSection]);

  return { ready, getThumbnail, cachedTimes };
}
