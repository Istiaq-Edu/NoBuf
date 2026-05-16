import { useEffect, useRef, useState } from 'react';

/**
 * FastStream-style background prefetching with speed tracking.
 */

const CHUNK_SIZE = 1024 * 1024; // 1MB
const SPEED_WINDOW = 5; // seconds

export function useVideoPrefetch(streamUrl: string | null) {
  const [prefetchedBytes, setPrefetchedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [isPrefetching, setIsPrefetching] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [speed, setSpeed] = useState(0);

  // Single ref for all mutable state
  const state = useRef({
    url: null as string | null,
    active: false,
    offset: 0,
    totalBytes: 0,
    paused: false,
    complete: false,
  });
  const speedHistory = useRef<{ bytes: number; time: number }[]>([]);

  // Track URL changes and reset state
  useEffect(() => {
    if (!streamUrl) return;

    // Reset state for new URL
    state.current = {
      url: streamUrl,
      active: false,
      offset: 0,
      totalBytes: 0,
      paused: false,
      complete: false,
    };
    speedHistory.current = [];
    setPrefetchedBytes(0);
    setTotalBytes(0);
    setIsPrefetching(false);
    setIsPaused(false);
    setIsComplete(false);
    setSpeed(0);

    // Start download
    let cancelled = false;
    let offset = 0;

    const download = async () => {
      state.current.active = true;
      setIsPrefetching(true);

      while (!cancelled && !state.current.paused && !state.current.complete) {
        const end = offset + CHUNK_SIZE - 1;
        try {
          const response = await fetch(streamUrl, {
            headers: { Range: `bytes=${offset}-${end}` },
          });

          if (!response.ok && response.status !== 206) {
            break;
          }

          // Get total size from Content-Range
          if (state.current.totalBytes === 0) {
            const range = response.headers.get('Content-Range');
            if (range) {
              const match = range.match(/\/(\d+)/);
              if (match) {
                const total = parseInt(match[1], 10);
                if (total > 0) {
                  state.current.totalBytes = total;
                  setTotalBytes(total);
                }
              }
            }
          }

          const data = await response.arrayBuffer();
          offset += data.byteLength;
          state.current.offset = offset;
          setPrefetchedBytes(offset);

          // Speed tracking
          const now = Date.now();
          speedHistory.current.push({ bytes: data.byteLength, time: now });
          speedHistory.current = speedHistory.current.filter(s => s.time > now - SPEED_WINDOW * 1000);
          if (speedHistory.current.length > 1) {
            const first = speedHistory.current[0];
            const last = speedHistory.current[speedHistory.current.length - 1];
            const timeDiff = (last.time - first.time) / 1000;
            if (timeDiff > 0) {
              const bytesTotal = speedHistory.current.reduce((sum, s) => sum + s.bytes, 0);
              setSpeed(bytesTotal / timeDiff);
            }
          }

          const total = state.current.totalBytes;
          console.log(`[Prefetch] ${formatBytes(offset)}${total > 0 ? '/' + formatBytes(total) : ''}`);

          if (total > 0 && offset >= total) {
            state.current.complete = true;
            setIsComplete(true);
            break;
          }

          if (data.byteLength < CHUNK_SIZE) {
            state.current.totalBytes = offset;
            state.current.complete = true;
            setTotalBytes(offset);
            setIsComplete(true);
            break;
          }

          await new Promise(r => setTimeout(r, 50));
        } catch (e: any) {
          if (cancelled) break;
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      state.current.active = false;
      setIsPrefetching(false);
      setSpeed(0);
    };

    download();

    return () => {
      cancelled = true;
    };
  }, [streamUrl]);

  const pausePrefetch = () => {
    state.current.paused = true;
    setIsPaused(true);
    setSpeed(0);
  };

  const resumePrefetch = () => {
    state.current.paused = false;
    setIsPaused(false);
    speedHistory.current = [];
  };

  return {
    prefetchedBytes,
    totalBytes,
    isPrefetching,
    isPaused,
    isComplete,
    speed,
    pausePrefetch,
    resumePrefetch,
  };
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
