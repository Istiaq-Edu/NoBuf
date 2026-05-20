import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { TelegramFile } from '../../types';
import { useMSEPlayer, formatSpeed } from '../../hooks/useMSEPlayer';
import { useThumbnailExtractor } from '../../hooks/useThumbnailExtractor';
import { useConfirm } from '../../context/ConfirmContext';

interface FastStreamPlayerProps {
  file: TelegramFile;
  streamUrl: string;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  activeFolderId: number | null;
}

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8, 16];

export function FastStreamPlayer({ file, streamUrl, onClose, onNext, onPrev, activeFolderId }: FastStreamPlayerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const vidRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const { confirm } = useConfirm();

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const durRef = useRef(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [buf, setBuf] = useState(0);
  const [load, setLoad] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [vis, setVis] = useState(true);
  const [fs, setFs] = useState(false);
  const [menu, setMenu] = useState(false);
  const [tip, setTip] = useState<{ t: number; x: number; show: boolean }>({ t: 0, x: 0, show: false });

  const [cachePercent, setCachePercent] = useState(0);
  const [cacheComplete, setCacheComplete] = useState(false);
  // Time ranges from backend cache (includes both playback buffer + download)
  const [cachedTimeRanges, setCachedTimeRanges] = useState<[number, number][]>([]);
  const [controlsHeight, setControlsHeight] = useState(0);
  const [miniBarVisible, setMiniBarVisible] = useState(false);

  // Download overlay state
  const [dlOverlay, setDlOverlay] = useState<{ active: boolean; percent: number; fromCache: boolean; speed: number; completed?: boolean } | null>(null);
  const [dlOverlayVisible, setDlOverlayVisible] = useState(false);
  const dlTransferIdRef = useRef<string>('');
  const dismissTimerRef = useRef<number>(0);

  // MSE player with native fallback
  const {
    mseUrl,
    error: mseError,
    useNative,
    prefetchedBytes,
    totalBytes,
    isPrefetching,
    isPaused: prefetchPaused,
    isComplete: prefetchComplete,
    speed,
    pausePrefetch,
    resumePrefetch,
    seekTo,
    setVideoRef,
    downloadedTimeRanges: _downloadedTimeRanges, // kept for re-render triggering + backend reporting
    byteToTime,
    setSuppressBackendReports,
  } = useMSEPlayer(streamUrl, file, activeFolderId);
  // MSE is ready once loadedmetadata fires (duration is set)
  const mseReady = dur > 0;

  // Thumbnail extractor — ref-based hover processor + synchronous cache check
  const { getCachedThumbnailSync, setDesiredHoverTime, clearDesiredHover, cachedTimes } = useThumbnailExtractor(vidRef, streamUrl, mseReady);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbLoading, setThumbLoading] = useState(false);
  const lastThumbTimeRef = useRef<number>(-1);

  // When cachedTimes updates (from on-demand capture), check if the current
  // hover position is now cached and update the display. This is the key
  // mechanism that makes on-demand thumbnails appear — the hover processor
  // caches them, cachedTimes state updates, and this effect resolves the spinner.
  useEffect(() => {
    if (lastThumbTimeRef.current >= 0 && thumbLoading) {
      const cachedUrl = getCachedThumbnailSync(lastThumbTimeRef.current);
      if (cachedUrl) {
        setThumbUrl(cachedUrl);
        setThumbLoading(false);
      }
    }
  }, [cachedTimes, getCachedThumbnailSync, thumbLoading]);

  // Close handler — check cache status and offer to continue in background
  const handleClose = useCallback(async () => {
    try {
      const cacheStatus = await invoke<any>('cmd_get_cache_status', {
        messageId: file.id,
      });

      if (cacheStatus && cacheStatus.percentage > 0 && !cacheStatus.is_complete) {
        const choice = await confirm({
          title: 'Video partially cached',
          message: `${cacheStatus.percentage}% of this video is cached locally. Continue downloading in the background for faster access later?`,
          confirmText: 'Continue in Background',
          cancelText: 'Close & Discard Cache',
        });

        if (choice) {
          await invoke('cmd_start_background_cache', {
            messageId: file.id,
            folderId: activeFolderId ?? 0,
          });
          toast.success('Video caching in background');
        } else {
          // Discard cache for this video
          await invoke('cmd_delete_cache', { messageId: file.id }).catch(() => {});
        }
      }
    } catch {
      // No cache or error — just close
    }
    onClose();
  }, [file.id, activeFolderId, confirm, onClose]);

  // Poll cache status every 5 seconds while playing
  useEffect(() => {
    let active = true;
    const poll = async () => {
      while (active) {
        try {
          const status = await invoke<any>('cmd_get_cache_status', { messageId: file.id });
          if (status) {
            setCachePercent(status.percentage);
            setCacheComplete(status.is_complete);
            if (status.cached_ranges && durRef.current > 0 && status.total_bytes > 0) {
              const ranges: [number, number][] = status.cached_ranges.map(
                ([s, e]: [number, number]) => [
                  byteToTime(s),
                  byteToTime(e + 1),
                ]
              );
              setCachedTimeRanges(ranges);
            }
          }
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 5000));
      }
    };
    poll();
    return () => { active = false; };
  }, [file.id]);

  // Listen for download-progress events for our transferId
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<any>('download-progress', async (event) => {
      if (event.payload.id === dlTransferIdRef.current) {
        setDlOverlay({
          active: true,
          percent: event.payload.percent,
          fromCache: cacheComplete,
          speed: event.payload.speed_bytes_per_sec,
        });
        try {
          const status = await invoke<any>('cmd_get_cache_status', { messageId: file.id });
          if (status?.cached_ranges && dur > 0 && status.total_bytes > 0) {
            const ranges: [number, number][] = status.cached_ranges.map(
              ([s, e]: [number, number]) => [
                byteToTime(s),
                byteToTime(e + 1),
              ]
            );
            setCachedTimeRanges(ranges);
          }
        } catch { /* ignore */ }
        if (event.payload.percent >= 100) {
          setSuppressBackendReports(false);
          setDlOverlay(prev => prev ? { ...prev, completed: true } : null);
          dlTransferIdRef.current = '';
        }
      }
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [cacheComplete, dur, totalBytes, file.id]);

  // Download handler — player prebuffer and file download run simultaneously,
  // interleaved at the Rust level via a Semaphore(1) that serializes all Telegram
  // iter_download calls. Only one chunk request hits Telegram at a time → no FLOOD_WAIT.
  // Green bar merges player's in-memory ranges (downloadedTimeRanges) and download's
  // cache ranges (cachedTimeRanges from cmd_get_cache_status polling).
  const handleDownload = useCallback(async () => {
    try {
      const savePath = await save({ defaultPath: file.name });
      if (!savePath) return;

      const transferId = `dl-${file.id}-${Date.now()}`;
      console.log(`[BUFFER-BAR] Download starting: transferId=${transferId} savePath=${savePath} dur=${dur.toFixed(1)}s totalBytes=${totalBytes}`);
      dlTransferIdRef.current = transferId;
      setDlOverlay({ active: true, percent: 0, fromCache: cacheComplete, speed: 0 });
      setDlOverlayVisible(true);
      clearTimeout(dismissTimerRef.current);

      // Suppress player's cache meta reports during download — download updates
      // CacheMeta per-chunk instead (protected by per-message Mutex in Rust).
      // Player prebuffer continues running — both interleave through Semaphore(1)
      // at the Rust level (one Telegram iter_download call at a time → no FLOOD_WAIT).
      setSuppressBackendReports(true);

      await invoke('cmd_download_file', {
        messageId: file.id,
        savePath,
        folderId: activeFolderId,
        transferId,
      });

      setSuppressBackendReports(false);
      toast.success(cacheComplete ? `Downloaded from cache: ${file.name}` : `Downloaded: ${file.name}`);
    } catch (e: any) {
      const errMsg = String(e);
      setSuppressBackendReports(false);
      if (!errMsg.includes('cancelled') && !errMsg.includes('Cancel')) {
        toast.error(`Download failed: ${errMsg}`);
      }
      setDlOverlayVisible(false);
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = window.setTimeout(() => {
        setDlOverlay(null);
        dlTransferIdRef.current = '';
      }, 300);
    }
  }, [file, activeFolderId, cacheComplete, setSuppressBackendReports]);

  // Cancel or dismiss download overlay
  const handleCancelDownload = useCallback(async () => {
    // If download completed, just dismiss the overlay
    if (dlOverlay?.completed) {
      setDlOverlayVisible(false);
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = window.setTimeout(() => setDlOverlay(null), 300);
      return;
    }
    if (!dlTransferIdRef.current) return;
    try {
      await invoke('cmd_cancel_transfer', { transferId: dlTransferIdRef.current });
    } catch { /* ignore */ }
    setSuppressBackendReports(false);
    setDlOverlayVisible(false);
    clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = window.setTimeout(() => {
      setDlOverlay(null);
      dlTransferIdRef.current = '';
    }, 300);
  }, [setSuppressBackendReports, dlOverlay?.completed]);


  const fmt = (s: number) => {
    if (!isFinite(s)) return '0:00';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = Math.floor(s % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}` : `${m}:${String(sc).padStart(2, '0')}`;
  };

  const formatBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  // Init video - use MSE URL or fall back to native
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return;

    // Pass video element to MSE hook for seek currentTime setting
    setVideoRef(v);

    // Use MSE URL if available, otherwise use streamUrl directly
    const videoUrl = useNative ? streamUrl : (mseUrl || streamUrl);
    if (!videoUrl) return;

    console.log('[Player] Setting video src:', videoUrl, 'useNative:', useNative);
    v.src = videoUrl;
    v.autoplay = true;

    const onMeta = () => {
      console.log('[Player] loadedmetadata, duration:', v.duration, 'readyState:', v.readyState);
      setDur(v.duration);
      durRef.current = v.duration;
      setVol(v.volume);
      setMuted(v.muted);
      setLoad(false);
      // Ensure playback starts (autoplay may be blocked by browser)
      v.play().catch((e) => console.warn('[Player] play() failed:', e));
    };
    const onCanPlay = () => {
      v.play().catch(() => {});
    };
    const onErr = () => {
      const err = v.error;
      console.error('[Player] video error:', err?.code, err?.message);
      setErr(mseError || `Video error: ${err?.message || 'unknown'}`);
      setLoad(false);
    };
    const onTime = () => {
      setTime(v.currentTime);
      // Get the furthest buffered position
      if (v.buffered.length > 0) {
        let maxBuf = 0;
        for (let i = 0; i < v.buffered.length; i++) {
          maxBuf = Math.max(maxBuf, v.buffered.end(i));
        }
        setBuf(maxBuf);
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onWait = () => setLoad(true);
    const onPlay2 = () => setLoad(false);
    const onProgress = () => {
      // Update buffer on progress events too
      if (v.buffered.length > 0) {
        let maxBuf = 0;
        for (let i = 0; i < v.buffered.length; i++) {
          maxBuf = Math.max(maxBuf, v.buffered.end(i));
        }
        setBuf(maxBuf);
      }
    };

    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('error', onErr);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('waiting', onWait);
    v.addEventListener('playing', onPlay2);
    v.addEventListener('progress', onProgress);
    return () => {
      setVideoRef(null);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('error', onErr);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('waiting', onWait);
      v.removeEventListener('playing', onPlay2);
      v.removeEventListener('progress', onProgress);
    };
  }, [streamUrl, mseUrl, useNative, setVideoRef]);


  // Buffer state is already updated by timeupdate and progress events above

  // Auto-hide controls — show on mouse activity, hide after idle during playback
  const lastMousePos = useRef({ x: 0, y: 0 });
  useEffect(() => {
    // Always show controls when paused (no auto-hide)
    if (!playing) {
      setVis(true);
      return;
    }

    let hideTimer: number;

    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        // CSS :hover works with stationary mouse — unlike JS event tracking
        if (playing && !controlsRef.current?.matches(':hover')) {
          setVis(false);
        }
      }, 3000);
    };

    // Schedule initial hide — handles case where mouse is already outside window
    scheduleHide();

    const mv = (e: MouseEvent) => {
      // Only trigger visibility if mouse moved > 5px — prevents sub-pixel jitter
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        lastMousePos.current = { x: e.clientX, y: e.clientY };
        setVis(true);
      }
      scheduleHide();
    };

    // Mouse left the app window — schedule hide with shorter delay
    const onMouseLeave = () => {
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (playing) setVis(false);
      }, 1500);
    };

    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseleave', onMouseLeave);
    return () => {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseleave', onMouseLeave);
      clearTimeout(hideTimer);
    };
  }, [playing]);

  // Mini progress bar — appears after controls have fully hidden (300ms delay)
  useEffect(() => {
    if (!vis && playing) {
      const timer = window.setTimeout(() => setMiniBarVisible(true), 300);
      return () => clearTimeout(timer);
    }
    setMiniBarVisible(false);
  }, [vis, playing]);

  // Fullscreen
  useEffect(() => {
    const ch = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', ch);
    return () => document.removeEventListener('fullscreenchange', ch);
  }, []);

  // Track controls overlay height for download overlay positioning
  useEffect(() => {
    const el = controlsRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setControlsHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const toggle = useCallback(() => { const v = vidRef.current; if (!v) return; v.paused ? v.play().catch(() => {}) : v.pause(); }, []);
  const seek = useCallback((s: number) => {
    const v = vidRef.current;
    if (!v) return;
    const target = Math.max(0, Math.min(v.currentTime + s, dur));
    if (useNative) {
      v.currentTime = target;
    } else {
      seekTo(target);
    }
  }, [dur, useNative, seekTo]);
  const setVol2 = useCallback((n: number) => { const v = vidRef.current; if (!v) return; v.volume = Math.max(0, Math.min(1, n)); setVol(v.volume); if (n > 0) { v.muted = false; setMuted(false); } }, []);
  const mute = useCallback(() => { const v = vidRef.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); }, []);
  const fs2 = useCallback(() => { document.fullscreenElement ? document.exitFullscreen() : boxRef.current?.requestFullscreen(); }, []);
  const rate2 = useCallback((r: number) => { const v = vidRef.current; if (v) { v.playbackRate = r; setRate(r); } setMenu(false); }, []);

  const onBarClick = useCallback((e: React.MouseEvent) => {
    if (!barRef.current || !vidRef.current || !isFinite(dur) || dur <= 0) return;
    const r = barRef.current.getBoundingClientRect();
    const targetTime = ((e.clientX - r.left) / r.width) * dur;
    if (useNative) {
      vidRef.current.currentTime = targetTime;
    } else {
      seekTo(targetTime);
    }
  }, [dur, useNative, seekTo]);

  const tipRafRef = useRef(0);
  const hoverDebounceRef = useRef(0);
  const onBarMove = useCallback((e: React.MouseEvent) => {
    if (!barRef.current) return;
    const r = barRef.current.getBoundingClientRect();
    const hoverTime = ((e.clientX - r.left) / r.width) * dur;

    // Throttle tooltip position updates to rAF
    cancelAnimationFrame(tipRafRef.current);
    tipRafRef.current = requestAnimationFrame(() => {
      setTip({ t: hoverTime, x: e.clientX - r.left, show: true });
    });

    const roundedTime = Math.floor(hoverTime / 2) * 2;
    if (roundedTime !== lastThumbTimeRef.current) {
      lastThumbTimeRef.current = roundedTime;

      // Synchronous cache check — instant display for already-cached thumbnails
      const cachedUrl = getCachedThumbnailSync(hoverTime);
      if (cachedUrl) {
        setThumbUrl(cachedUrl);
        setThumbLoading(false);
        // Cancel any pending on-demand request (we have the thumbnail)
        clearTimeout(hoverDebounceRef.current);
        clearDesiredHover();
      } else {
        // Not cached: show spinner immediately, but delay the on-demand seek
        // by 1 second. This prevents accidental/sweep hovers from triggering
        // expensive network seeks. If the user stays at this position for 1s,
        // the hover processor starts generating the thumbnail.
        setThumbUrl(null);
        setThumbLoading(true);

        // Cancel previous debounce timer
        clearTimeout(hoverDebounceRef.current);
        hoverDebounceRef.current = window.setTimeout(() => {
          setDesiredHoverTime(hoverTime);
        }, 1000);
      }
    }
  }, [dur, getCachedThumbnailSync, setDesiredHoverTime, clearDesiredHover]);

  // Keyboard
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      switch (e.key.toLowerCase()) {
        case ' ': case 'k': e.preventDefault(); toggle(); break;
        case 'arrowleft': e.preventDefault(); e.shiftKey ? onPrev?.() : seek(-5); break;
        case 'arrowright': e.preventDefault(); e.shiftKey ? onNext?.() : seek(5); break;
        case 'arrowup': e.preventDefault(); setVol2(vol + 0.1); break;
        case 'arrowdown': e.preventDefault(); setVol2(vol - 0.1); break;
        case 'm': e.preventDefault(); mute(); break;
        case 'f': e.preventDefault(); fs2(); break;
        case 'escape': e.preventDefault(); document.fullscreenElement ? document.exitFullscreen() : handleClose(); break;
        case 'j': e.preventDefault(); seek(-10); break;
        case 'l': e.preventDefault(); seek(10); break;
        case ',': e.preventDefault(); rate2(Math.max(0.25, rate - 0.25)); break;
        case '.': e.preventDefault(); rate2(Math.min(16, rate + 0.25)); break;
        case '<': e.preventDefault(); rate2(Math.max(0.25, rate / 2)); break;
        case '>': e.preventDefault(); rate2(Math.min(16, rate * 2)); break;
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [toggle, seek, setVol2, mute, fs2, handleClose, onNext, onPrev, vol, rate, rate2, dur]);

  const pct = dur > 0 ? (time / dur) * 100 : 0;
  const bufPct = dur > 0 ? (buf / dur) * 100 : 0;

  return (
    <div ref={boxRef} className="fixed inset-0 z-50 bg-black flex flex-col select-none">
      {/* Video - FastStream's DirectVideoPlayer approach */}
      <div className="flex-1 flex items-center justify-center min-h-0 relative cursor-pointer" onClick={toggle} onDoubleClick={fs2}>
        {err ? (
          <div className="text-center px-8">
            <div className="text-red-400 text-lg mb-2">{err}</div>
            <div className="text-gray-500 text-xs break-all max-w-md mb-4">{streamUrl}</div>
            <button onClick={handleClose} className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded">Close</button>
          </div>
        ) : (
          <video ref={vidRef} className="max-w-full max-h-full" playsInline />
        )}
        {load && !err && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Persistent mini progress bar — visible when controls are hidden */}
      {miniBarVisible && !err && dur > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/20 z-40 pointer-events-none transition-opacity duration-300">
          <div className="absolute inset-y-0 left-0 bg-red-500 rounded-full" style={{ width: `${pct}%` }} />
        </div>
      )}

      {/* Controls - FastStream-style */}
      <div
        ref={controlsRef}
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent pt-16 pb-2 px-3 ${vis ? '' : 'pointer-events-none'}`}
        style={{
          opacity: vis ? 1 : 0,
          transform: vis ? 'translateY(0)' : 'translateY(20px)',
          transition: 'opacity 300ms ease-out, transform 300ms ease-out',
        }}
      >
        {/* Progress bar — unified with buffer, position, and preview indicators */}
        <div
          ref={barRef}
          className="relative cursor-pointer group mb-3 mx-1 py-3"
          onClick={onBarClick}
          onMouseMove={onBarMove}
          onMouseLeave={() => {
            setTip(p => ({ ...p, show: false }));
            clearTimeout(hoverDebounceRef.current);
            clearDesiredHover();
          }}
        >
          {/* Visual bar track */}
          <div className="relative h-4 bg-white/20 rounded-full group-hover:h-5 transition-all">
            {/* Green buffer bar — all locally available data (SourceBuffer + disk cache) */}
            {(() => {
              const vid = vidRef.current;
              const bufferedRanges: [number, number][] = [];
              if (vid && vid.buffered && vid.buffered.length > 0) {
                for (let i = 0; i < vid.buffered.length; i++) {
                  bufferedRanges.push([vid.buffered.start(i), vid.buffered.end(i)]);
                }
              }
              const merged = [...bufferedRanges, ...cachedTimeRanges];
              if (merged.length === 0 || dur <= 0) return null;
              const sorted = merged.sort((a, b) => a[0] - b[0]);
              const deduped: [number, number][] = [];
              for (const r of sorted) {
                if (deduped.length === 0 || r[0] > deduped[deduped.length - 1][1] + 0.01) {
                  deduped.push(r);
                } else {
                  deduped[deduped.length - 1][1] = Math.max(deduped[deduped.length - 1][1], r[1]);
                }
              }
              return deduped.map(([ts, te], i) => {
                const leftPct = (ts / dur) * 100;
                const widthPct = ((te - ts) / dur) * 100;
                return (
                  <div
                    key={`buf-${i}`}
                    className="absolute bottom-0 h-[3px] bg-green-400/70 rounded-full z-20"
                    style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.2)}%` }}
                  />
                );
              });
            })()}
            {/* Preview thumbnail coverage — yellow bar, hover-only */}
            {cachedTimes.size > 0 && dur > 0 && (() => {
              // Group consecutive cached times into segments
              const sorted = Array.from(cachedTimes).sort((a, b) => a - b);
              const segments: { start: number; end: number }[] = [];
              let segStart = sorted[0];
              let segEnd = sorted[0];
              for (let i = 1; i < sorted.length; i++) {
                if (sorted[i] - sorted[i - 1] <= 4) {
                  segEnd = sorted[i];
                } else {
                  segments.push({ start: segStart, end: segEnd });
                  segStart = sorted[i];
                  segEnd = sorted[i];
                }
              }
              segments.push({ start: segStart, end: segEnd });

              return segments.map((seg, i) => {
                const leftPct = (seg.start / dur) * 100;
                const widthPct = ((seg.end - seg.start + 2) / dur) * 100;
                return (
                  <div
                    key={i}
                    className="absolute top-0 h-[3px] bg-yellow-400/70 rounded-full z-10"
                    style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.2)}%` }}
                  />
                );
              });
            })()}
            {/* MSE buffer indicator */}
            <div className="absolute inset-y-0 left-0 bg-white/30 rounded-full" style={{ width: `${bufPct}%` }} />
            {/* Playback position */}
            <div className="absolute inset-y-0 left-0 bg-red-500 rounded-full" style={{ width: `${pct}%` }} />
            {/* Knob */}
            <div className="absolute w-4 h-4 bg-red-500 rounded-full top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity" style={{ left: `${pct}%`, transform: 'translate(-50%, -50%)' }} />
          </div>
          {/* Tooltip with WebCodecs thumbnail */}
          {tip.show && (() => {
            const barWidth = barRef.current?.getBoundingClientRect().width ?? 0;
            const tooltipHalf = 60;
            const clampedX = Math.max(tooltipHalf, Math.min(tip.x, barWidth - tooltipHalf));
            return (
              <div className="absolute pointer-events-none flex flex-col items-center" style={{ left: clampedX, bottom: '100%', marginBottom: '8px', transform: 'translateX(-50%)' }}>
                {thumbUrl ? (
                  <img
                    src={thumbUrl}
                    className="rounded overflow-hidden border border-white/20 mb-1 shadow-lg"
                    style={{ width: 114, height: 64, objectFit: 'cover' }}
                    alt=""
                  />
                ) : thumbLoading ? (
                  <div className="w-[114px] h-[64px] rounded border border-white/20 mb-1 bg-white/5 flex items-center justify-center">
                    <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                  </div>
                ) : null}
                <div className="px-2 py-0.5 bg-black/80 text-white text-xs rounded whitespace-nowrap font-mono">
                  {fmt(tip.t)}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Buttons row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            {/* Play/Pause */}
            <button onClick={toggle} className="p-1.5 hover:bg-white/10 rounded text-white" title="Play/Pause (Space)">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                {playing ? <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /> : <path d="M8 5v14l11-7z" />}
              </svg>
            </button>
            {/* Prev */}
            {onPrev && (
              <button onClick={onPrev} className="p-1.5 hover:bg-white/10 rounded text-white" title="Previous">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
              </button>
            )}
            {/* Next */}
            {onNext && (
              <button onClick={onNext} className="p-1.5 hover:bg-white/10 rounded text-white" title="Next">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg>
              </button>
            )}
            {/* Volume */}
            <div className="flex items-center group">
              <button onClick={mute} className="p-1.5 hover:bg-white/10 rounded text-white" title="Mute (M)">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  {muted || vol === 0
                    ? <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                    : vol < 0.5
                      ? <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                      : <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />}
                </svg>
              </button>
              <input type="range" min="0" max="1" step="0.01" value={muted ? 0 : vol} onChange={e => setVol2(parseFloat(e.target.value))} className="w-0 group-hover:w-20 transition-all opacity-0 group-hover:opacity-100 accent-white" />
            </div>
            {/* Time */}
            <span className="text-white text-xs font-mono ml-1">{fmt(time)} / {fmt(dur)}</span>
          </div>
          <div className="flex items-center gap-1">
            {/* FastStream Buffer control button */}
            {(isPrefetching || prefetchPaused || prefetchComplete || prefetchedBytes > 0) && (
              <button
                onClick={(e) => { e.stopPropagation(); prefetchPaused ? resumePrefetch() : pausePrefetch(); }}
                className="p-1.5 hover:bg-white/10 rounded text-white flex items-center gap-1"
                title={prefetchPaused ? 'Resume buffering' : prefetchComplete ? 'Buffering complete' : 'Pause buffering'}
              >
                {prefetchPaused ? (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                ) : prefetchComplete ? (
                  <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>
                ) : (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
                )}
                <span className="text-xs">
                  {prefetchComplete ? 'Done' : `${formatBytes(prefetchedBytes)}${speed > 0 ? ` (${formatSpeed(speed)})` : ''}`}
                </span>
              </button>
            )}
            {/* Rate */}
            <div className="relative">
              <button onClick={() => setMenu(!menu)} className="px-2 py-1 hover:bg-white/10 rounded text-white text-xs font-mono" title="Playback rate">
                {rate}x
              </button>
              {menu && (
                <div className="absolute bottom-full right-0 mb-2 bg-black/90 border border-white/10 rounded-lg overflow-hidden min-w-[60px] z-50">
                  {RATES.map(r => (
                    <button key={r} onClick={() => rate2(r)} className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 ${rate === r ? 'text-red-400 bg-white/5' : 'text-white'}`}>
                      {r}x
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Download */}
            <button onClick={handleDownload} className="p-1.5 hover:bg-white/10 rounded text-white flex items-center gap-1" title="Download">
              <svg className={`w-5 h-5 ${dlOverlayVisible && !dlOverlay?.completed ? 'animate-subtle-pulse' : ''}`} fill="currentColor" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" /></svg>
              {cachePercent > 0 && (
                <span className="text-xs font-mono">
                  {cacheComplete ? <span className="text-green-400">✓</span> : `${cachePercent}%`}
                </span>
              )}
            </button>
            {/* Close */}
            <button onClick={handleClose} className="p-1.5 hover:bg-white/10 rounded text-white" title="Close (Esc)">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
            </button>
            {/* Fullscreen */}
            <button onClick={fs2} className="p-1.5 hover:bg-white/10 rounded text-white" title="Fullscreen (F)">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                {fs
                  ? <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                  : <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />}
              </svg>
            </button>
          </div>
        </div>

        
      </div>

      {/* File name */}
      <div className={`absolute top-3 left-3 right-3 text-white text-sm truncate transition-opacity duration-300 ${vis ? 'opacity-100' : 'opacity-0'}`} style={{ textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
        {file.name}
      </div>

      {/* Download overlay — always rendered for smooth fade transitions */}
      <div
        className={`absolute left-4 right-4 transition-all duration-300 ease-out ${dlOverlayVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{ bottom: dlOverlayVisible ? (vis && controlsHeight > 0 ? controlsHeight + 12 : 64) : 64 }}
      >
        {dlOverlay && (
          <div className={`flex items-center gap-2 bg-black/40 rounded-lg px-3 py-2 backdrop-blur-sm transition-opacity duration-300 ${dlOverlay.completed ? 'opacity-80' : 'opacity-100'}`}>
            <div className="flex-1 bg-white/10 rounded-full h-2 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${dlOverlay.completed || dlOverlay.fromCache ? 'bg-green-400' : 'bg-telegram-secondary'}`}
                style={{ width: `${dlOverlay.percent}%` }}
              />
            </div>
            <span className="text-white/90 text-xs font-mono whitespace-nowrap">
              {dlOverlay.completed
                ? 'Completed'
                : dlOverlay.fromCache
                  ? 'From cache'
                  : dlOverlay.speed > 0
                    ? `${formatBytes(dlOverlay.speed)}/s`
                    : 'Downloading...'
              }
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); handleCancelDownload(); }}
              className={`p-1 hover:bg-white/10 rounded transition-colors flex-shrink-0 ${dlOverlay.completed ? 'text-white/60 hover:text-white' : 'text-white/60 hover:text-red-400'}`}
              title={dlOverlay.completed ? 'Close' : 'Cancel download'}
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
            </button>
          </div>
        )}
      </div>

      {/* Big play */}
      {!playing && !load && !err && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-16 h-16 bg-black/50 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-white ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          </div>
        </div>
      )}
    </div>
  );
}
