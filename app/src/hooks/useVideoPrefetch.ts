import { useEffect, useRef, useState } from 'react';
import { fragmentStore, ByteRange } from '../lib/FragmentStore';

/**
 * FastStream-style background prefetching with fragment tracking.
 * Memory-only storage - fragments cleared on video/app restart.
 */

const CHUNK_SIZE = 1024 * 1024; // 1MB
const SPEED_WINDOW = 5; // seconds
const SEEK_JUMP_THRESHOLD = 2; // seconds - detect seek if time jumps more than 2s

export function useVideoPrefetch(streamUrl: string | null, currentTime: number = 0, duration: number = 0, fileSize: number = 0) {
  const [prefetchedBytes, setPrefetchedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [isPrefetching, setIsPrefetching] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [bufferedRanges, setBufferedRanges] = useState<ByteRange[]>([]);

  // Track previous URL for cleanup
  const prevUrlRef = useRef<string | null>(null);

  // Single ref for all mutable state
  const state = useRef({
    active: false,
    offset: 0,
    totalBytes: 0,
    paused: false,
    complete: false,
    seekTarget: -1,
  });
  const speedHistory = useRef<{ bytes: number; time: number }[]>([]);
  const lastSeekByte = useRef(0);
  const lastTimeRef = useRef(0); // Track previous time for jump detection

  // Calculate byte position from time
  const getByteFromTime = (time: number, dur: number, bytes: number): number => {
    if (bytes > 0 && dur > 0) {
      return Math.floor((time / dur) * bytes);
    }
    return Math.floor(time * 250000);
  };

  // Track URL changes and reset state
  useEffect(() => {
    if (!streamUrl) return;

    // Clear fragments from previous video
    if (prevUrlRef.current && prevUrlRef.current !== streamUrl) {
      fragmentStore.clear(prevUrlRef.current);
    }
    prevUrlRef.current = streamUrl;

    // Calculate start byte from currentTime
    const startByte = getByteFromTime(currentTime, duration, fileSize);

    // Reset state for new URL
    state.current = {
      active: false,
      offset: startByte,
      totalBytes: fileSize || 0,
      paused: false,
      complete: false,
      seekTarget: -1,
    };
    lastSeekByte.current = startByte;
    lastTimeRef.current = currentTime;
    speedHistory.current = [];
    setPrefetchedBytes(startByte);
    setTotalBytes(fileSize || 0);
    setIsPrefetching(false);
    setIsPaused(false);
    setIsComplete(false);
    setSpeed(0);
    setBufferedRanges([]);

    // Start download from current position
    let cancelled = false;

    const download = async () => {
      state.current.active = true;
      setIsPrefetching(true);

      while (!cancelled && !state.current.paused && !state.current.complete) {
        // Check for seek target
        if (state.current.seekTarget >= 0) {
          state.current.offset = state.current.seekTarget;
          state.current.seekTarget = -1;
          state.current.complete = false;
          speedHistory.current = [];
        }

        const offset = state.current.offset;
        const end = offset + CHUNK_SIZE - 1;

        // Skip if already downloaded
        if (fragmentStore.has(streamUrl, offset, end)) {
          state.current.offset = offset + CHUNK_SIZE;
          continue;
        }

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
          const actualEnd = offset + data.byteLength - 1;

          // Store in fragment store
          fragmentStore.put(streamUrl, offset, actualEnd, data);

          // Update tracking
          state.current.offset = offset + data.byteLength;
          setPrefetchedBytes(state.current.offset);
          setBufferedRanges(fragmentStore.getRanges(streamUrl));

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
          console.log(`[Prefetch] ${formatBytes(state.current.offset)}${total > 0 ? '/' + formatBytes(total) : ''}`);

          if (total > 0 && state.current.offset >= total) {
            state.current.complete = true;
            setIsComplete(true);
            break;
          }

          if (data.byteLength < CHUNK_SIZE) {
            state.current.totalBytes = state.current.offset;
            state.current.complete = true;
            setTotalBytes(state.current.offset);
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

  // Handle seeking - detect time jumps
  useEffect(() => {
    if (!streamUrl) return;

    const timeJump = Math.abs(currentTime - lastTimeRef.current);
    lastTimeRef.current = currentTime;

    // Detect seek: time jumped more than threshold
    if (timeJump > SEEK_JUMP_THRESHOLD && duration > 0) {
      const newStartByte = getByteFromTime(currentTime, duration, fileSize);
      console.log(`[Prefetch] Seek detected (${timeJump.toFixed(1)}s jump): jumping to ${formatBytes(newStartByte)}`);
      lastSeekByte.current = newStartByte;
      state.current.seekTarget = newStartByte;
      state.current.complete = false;
      setIsComplete(false);
    }
  }, [currentTime, duration, fileSize, streamUrl]);

  const pausePrefetch = () => {
    state.current.paused = true;
    setIsPaused(true);
    setSpeed(0);
  };

  const resumePrefetch = () => {
    state.current.paused = false;
    setIsPaused(false);
    speedHistory.current = [];
    if (!state.current.active && streamUrl) {
      // Restart download
      state.current.active = true;
      setIsPrefetching(true);
    }
  };

  return {
    prefetchedBytes,
    totalBytes,
    isPrefetching,
    isPaused,
    isComplete,
    speed,
    bufferedRanges,
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
