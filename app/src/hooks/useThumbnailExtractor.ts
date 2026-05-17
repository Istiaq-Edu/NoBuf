import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hover preview thumbnail extractor.
 *
 * Uses a hidden <video> element with crossOrigin="anonymous" to decode
 * frames on demand. The hidden video loads the same stream URL as the
 * main player. On hover, it seeks to the requested time and captures
 * the decoded frame to a canvas.
 *
 * The main video element is NEVER touched — no flickering.
 */

export interface ThumbnailResult {
  dataUrl: string;
  width: number;
  height: number;
  time: number;
}

const THUMBNAIL_WIDTH = 114;
const THUMBNAIL_HEIGHT = 64;

export function useThumbnailExtractor(
  _videoRef: React.RefObject<HTMLVideoElement | null>,
  streamUrl: string | null,
) {
  const [ready, setReady] = useState(false);
  const cacheRef = useRef<Map<number, string>>(new Map());
  const pendingRef = useRef<Map<number, Promise<ThumbnailResult | null>>>(new Map());
  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);

  // Create hidden video element for thumbnails
  useEffect(() => {
    if (!streamUrl) return;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous'; // Required to avoid tainted canvas
    video.style.position = 'absolute';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    document.body.appendChild(video);

    video.src = streamUrl;

    video.addEventListener('loadeddata', () => {
      console.log('[ThumbnailExtractor] Hidden video loadeddata, readyState:', video.readyState);
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

  const getThumbnail = useCallback(async (timeSeconds: number): Promise<ThumbnailResult | null> => {
    const video = hiddenVideoRef.current;
    if (!video || !ready) return null;

    const cacheKey = Math.floor(timeSeconds / 2) * 2;

    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      return { dataUrl: cached, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, time: cacheKey };
    }

    const pending = pendingRef.current.get(cacheKey);
    if (pending) return pending;

    const promise = seekAndCapture(video, cacheKey);
    pendingRef.current.set(cacheKey, promise);

    try {
      const result = await promise;
      if (result) {
        cacheRef.current.set(cacheKey, result.dataUrl);
      }
      return result;
    } finally {
      pendingRef.current.delete(cacheKey);
    }
  }, [ready]);

  return { ready, getThumbnail };
}

/**
 * Seek the hidden video to the requested time and capture the frame.
 * Serializes requests — only one seek at a time to avoid conflicts.
 */
function seekAndCapture(
  video: HTMLVideoElement,
  timeSeconds: number,
): Promise<ThumbnailResult | null> {
  return new Promise((resolve) => {
    let settled = false;

    const onSeeked = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);

      try {
        const canvas = document.createElement('canvas');
        canvas.width = THUMBNAIL_WIDTH;
        canvas.height = THUMBNAIL_HEIGHT;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(video, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.6);

        resolve({
          dataUrl,
          width: THUMBNAIL_WIDTH,
          height: THUMBNAIL_HEIGHT,
          time: timeSeconds,
        });
      } catch (e) {
        console.warn('[ThumbnailExtractor] Canvas capture failed:', e);
        resolve(null);
      }
    };

    video.addEventListener('seeked', onSeeked);

    // If already at the right time, capture immediately
    if (Math.abs(video.currentTime - timeSeconds) < 0.5 && video.readyState >= 2) {
      video.removeEventListener('seeked', onSeeked);
      onSeeked();
      return;
    }

    video.currentTime = timeSeconds;

    setTimeout(() => {
      if (!settled) {
        settled = true;
        video.removeEventListener('seeked', onSeeked);
        resolve(null);
      }
    }, 5000);
  });
}
