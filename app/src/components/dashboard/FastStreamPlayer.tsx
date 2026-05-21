import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { TelegramFile } from '../../types';
import { isVideoFile } from '../../utils';
import { useMSEPlayer, formatSpeed } from '../../hooks/useMSEPlayer';
import { useThumbnailExtractor } from '../../hooks/useThumbnailExtractor';
import { useSettings, SkipDuration, VideoFit, AutoHideDelay } from '../../context/SettingsContext';
import { useCacheSession } from '../../context/CacheSessionContext';
import { VideoCacheDialog } from './VideoCacheDialog';

interface FastStreamPlayerProps {
  file: TelegramFile;
  streamUrl: string;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  activeFolderId: number | null;
  onContinueToDownload?: (messageId: number, filename: string, folderId: number | null, savePath: string, fromCachePercent: number) => void;
  isAlreadyDownloading?: boolean;
}

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8, 16];

export function FastStreamPlayer({ file, streamUrl, onClose, onNext, onPrev, activeFolderId, onContinueToDownload, isAlreadyDownloading }: FastStreamPlayerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const vidRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const { settings, updateSetting } = useSettings();
  const cacheSession = useCacheSession();

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const durRef = useRef(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(settings.playerSpeed);
  const [buf, setBuf] = useState(0);
  const [load, setLoad] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [vis, setVis] = useState(true);
  const [fs, setFs] = useState(false);
  const [menu, setMenu] = useState(false);
  const [tip, setTip] = useState<{ t: number; x: number; show: boolean }>({ t: 0, x: 0, show: false });

  // Settings panel state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loop, setLoop] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [brightness, setBrightness] = useState(1);
  const [pip, setPip] = useState(false);
  const [videoResolution, setVideoResolution] = useState<{ w: number; h: number } | null>(null);
  // Video cache dialog state — replaces old bgCache auto-dialog
  const [showCacheDialog, setShowCacheDialog] = useState(false);
  const [pendingCachePercent, setPendingCachePercent] = useState(0);
  const [skipFeedback, setSkipFeedback] = useState<{ direction: 'forward' | 'backward'; amount: number } | null>(null);
  const skipFeedbackTimer = useRef<number>(0);
  const skipFeedbackKey = useRef(0);

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

  // Close handler — background cache controls behavior
  // Close handler — show VideoCacheDialog for video files with cache > 0%
  const handleClose = useCallback(async () => {
    // Only show dialog for video files with cached data
    if (!isVideoFile(file.name)) {
      // console.log(`[CACHE-DIALOG] Not a video file — closing directly for "${file.name}"`);
      onClose();
      return;
    }

    try {
      const cacheStatus = await invoke<any>('cmd_get_cache_status', {
        messageId: file.id,
      });

      if (cacheStatus && cacheStatus.percentage > 0) {
        // Video has meaningful cache data — show VideoCacheDialog
        // console.log(`[CACHE-DIALOG] Video has ${cacheStatus.percentage}% cache — showing dialog for msg=${file.id}`);
        setPendingCachePercent(cacheStatus.percentage);
        setShowCacheDialog(true);
        return; // Don't close yet — wait for dialog choice
      }

      if (cacheStatus && cacheStatus.percentage === 0 && cacheStatus.cached_bytes > 0) {
        onClose();
        const tryDelete = (attempt: number) => {
          invoke('cmd_delete_cache', { messageId: file.id }).catch(() => {
            if (attempt < 5) {
              setTimeout(() => tryDelete(attempt + 1), 2000);
            }
          });
        };
        setTimeout(() => tryDelete(1), 2000);
        return;
      }
    } catch {
      // No cache data — just close directly
      // console.log(`[CACHE-DIALOG] No cache status for msg=${file.id} — closing directly`);
    }
    onClose();
  }, [file.id, file.name, onClose]);

  // VideoCacheDialog action handlers
  const handleCacheDiscard = useCallback(() => {
    setShowCacheDialog(false);
    cacheSession.removeCache(file.id);
    onClose();
    // Schedule cache deletion after player closes — the Actix stream needs time
    // to drop its StreamingGuard and file handle. cmd_delete_cache now returns
    // an error when streaming is still active, so retries properly handle this.
    const tryDelete = (attempt: number) => {
      invoke('cmd_delete_cache', { messageId: file.id }).catch(() => {
        if (attempt < 5) {
          setTimeout(() => tryDelete(attempt + 1), 2000);
        }
      });
    };
    setTimeout(() => tryDelete(1), 2000);
  }, [file.id, cacheSession, onClose]);

  const handleCacheKeepBuffers = useCallback(() => {
    // console.log(`[CACHE-DIALOG] Keep Buffers selected — registering ${pendingCachePercent}% in session for msg=${file.id}`);
    setShowCacheDialog(false);
    cacheSession.registerCache(file.id, pendingCachePercent, file.name);
    onClose();
  }, [file.id, pendingCachePercent, file.name, cacheSession, onClose]);

  const handleCacheContinueDownload = useCallback((savePath: string) => {
    // console.log(`[CACHE-DIALOG] Continue Download selected — queuing download at ${pendingCachePercent}% for msg=${file.id}`);
    setShowCacheDialog(false);
    // Queue in download panel with fromCachePercent
    // This will be wired from Dashboard via a prop callback
    onContinueToDownload?.(file.id, file.name, activeFolderId, savePath, pendingCachePercent);
    cacheSession.removeCache(file.id);
    onClose();
  }, [file.id, file.name, activeFolderId, pendingCachePercent, onContinueToDownload, cacheSession, onClose]);

  const handleCacheDialogCancel = useCallback(() => {
    // console.log(`[CACHE-DIALOG] Cancelled — returning to video player for msg=${file.id}`);
    setShowCacheDialog(false);
  }, [file.id]);

  const handleAlreadyDownloadingClose = useCallback(() => {
    setShowCacheDialog(false);
    toast.info(`${file.name} is already downloading — check the transfer panel`);
    onClose();
  }, [file.id, file.name, onClose]);

  // Ref to cacheSession so the poll effect doesn't re-trigger on every updateCachePercent
  // (which would create an infinite loop: poll → update → state change → effect re-run → new poll → ...)
  const cacheSessionRef = useRef(cacheSession);
  cacheSessionRef.current = cacheSession;

  // Poll cache status every 5 seconds while playing — also updates session tracker
  useEffect(() => {
    let active = true;
    const poll = async () => {
      while (active) {
        try {
          const status = await invoke<any>('cmd_get_cache_status', { messageId: file.id });
          if (status) {
            setCachePercent(status.percentage);
            setCacheComplete(status.is_complete);
            // Update session cache tracker via ref (avoids re-triggering this effect)
            const cs = cacheSessionRef.current;
            if (cs.getCacheInfo(file.id) && status.percentage > 0) {
              cs.updateCachePercent(file.id, status.percentage);
            }
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
  }, [file.id, byteToTime]); // Removed cacheSession — uses ref instead

  // Show "Resuming from X% cache" toast ONCE when opening a video with session cache.
  // A ref guard prevents the toast from re-showing on every cacheSession state change
  // (updateCachePercent re-creates the context, which would otherwise re-trigger this effect).
  const hasShownResumeToast = useRef(false);
  useEffect(() => {
    if (hasShownResumeToast.current) return;
    const cached = cacheSession.getCacheInfo(file.id);
    if (cached && cached.percentage > 0) {
      hasShownResumeToast.current = true;
      // console.log(`[CACHE-RESUME] Showing resuming toast: ${cached.percentage}% for msg=${file.id}`);
      toast.info(`Resuming from ${cached.percentage}% cache`, { duration: 3000 });
    }
  }, [file.id, cacheSession]);

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
      // console.log(`[BUFFER-BAR] Download starting: transferId=${transferId} savePath=${savePath} dur=${dur.toFixed(1)}s totalBytes=${totalBytes}`);
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
      setVideoResolution({ w: v.videoWidth, h: v.videoHeight });
      v.playbackRate = settings.playerSpeed;
      v.loop = loop;
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
  const hideDelayMs = settings.playerAutoHideDelay === 0 ? 0 : settings.playerAutoHideDelay * 1000;
  useEffect(() => {
    // Always show controls when paused or settings panel is open
    if (!playing || settingsOpen) {
      setVis(true);
      return;
    }
    // Never auto-hide if delay is 0
    if (hideDelayMs === 0) {
      setVis(true);
      return;
    }

    let hideTimer: number;

    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        // CSS :hover works with stationary mouse — unlike JS event tracking
        if (playing && !settingsOpen && !controlsRef.current?.matches(':hover')) {
          setVis(false);
        }
      }, hideDelayMs);
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
        if (playing && !settingsOpen) setVis(false);
      }, 1500);
    };

    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseleave', onMouseLeave);
    return () => {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseleave', onMouseLeave);
      clearTimeout(hideTimer);
    };
  }, [playing, settingsOpen, hideDelayMs]);

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

  // Sync player settings to video element
  useEffect(() => {
    const v = vidRef.current;
    if (v) v.loop = loop;
  }, [loop]);

  useEffect(() => {
    const v = vidRef.current;
    if (v) v.playbackRate = rate;
    updateSetting('playerSpeed', rate);
  }, [rate, updateSetting]);

  useEffect(() => {
    if (pip && vidRef.current) {
      vidRef.current.requestPictureInPicture?.().catch(() => { toast.error('PiP not supported'); setPip(false); });
    } else if (!pip && document.pictureInPictureElement) {
      document.exitPictureInPicture?.().catch(() => {});
    }
  }, [pip]);

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
  const seekFwd = useCallback(() => {
    seek(settings.playerSkipForward);
    setVis(true);
    clearTimeout(skipFeedbackTimer.current);
    skipFeedbackKey.current += 1;
    setSkipFeedback({ direction: 'forward', amount: settings.playerSkipForward });
    skipFeedbackTimer.current = window.setTimeout(() => setSkipFeedback(null), 1500);
  }, [seek, settings.playerSkipForward]);
  const seekBwd = useCallback(() => {
    seek(-settings.playerSkipBackward);
    setVis(true);
    clearTimeout(skipFeedbackTimer.current);
    skipFeedbackKey.current += 1;
    setSkipFeedback({ direction: 'backward', amount: settings.playerSkipBackward });
    skipFeedbackTimer.current = window.setTimeout(() => setSkipFeedback(null), 1500);
  }, [seek, settings.playerSkipBackward]);
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
        case 'arrowleft': e.preventDefault(); e.shiftKey ? onPrev?.() : seekBwd(); break;
        case 'arrowright': e.preventDefault(); e.shiftKey ? onNext?.() : seekFwd(); break;
        case 'arrowup': e.preventDefault(); setVol2(vol + 0.1); break;
        case 'arrowdown': e.preventDefault(); setVol2(vol - 0.1); break;
        case 'm': e.preventDefault(); mute(); break;
        case 'f': e.preventDefault(); fs2(); break;
        case 'escape': e.preventDefault(); document.fullscreenElement ? document.exitFullscreen() : handleClose(); break;
        case 'j': e.preventDefault(); seekBwd(); break;
        case 'l': e.preventDefault(); seekFwd(); break;
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
          <video
            ref={vidRef}
            className="w-full h-full"
            playsInline
            style={{
              objectFit: settings.playerVideoFit === 'original' ? 'none' : settings.playerVideoFit,
              filter: `brightness(${brightness})`,
              transform: rotation ? `rotate(${rotation}deg)` : undefined,
            }}
          />
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
            {/* Speed */}
            <div className="relative">
              <button onClick={() => setMenu(!menu)} className="px-2 py-1 hover:bg-white/10 rounded text-white text-xs font-mono" title="Playback speed">
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
            {/* Settings */}
            <button onClick={(e) => { e.stopPropagation(); setSettingsOpen(prev => !prev); }} className="p-1.5 hover:bg-white/10 rounded text-white" title="Settings">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.6 3.6 0 0112 15.6z" /></svg>
            </button>
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

      {/* Settings overlay panel */}
      {settingsOpen && (
        <div
          className="absolute right-0 top-0 bottom-0 w-[40%] max-w-[320px] z-30 bg-black/70 backdrop-blur-xl border-l border-white/10 overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <span className="text-white text-sm font-semibold">Settings</span>
            <button onClick={() => setSettingsOpen(false)} className="p-1 hover:bg-white/10 rounded text-white/60 hover:text-white transition-colors" title="Close settings">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
            </button>
          </div>

          {/* Playback */}
          <div className="px-4 py-3 border-b border-white/10">
            <h3 className="text-white/50 text-[10px] uppercase tracking-wider mb-2">Playback</h3>
            {/* Loop */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-white/70 text-xs">Loop</span>
              <button
                onClick={() => setLoop(!loop)}
                className={`w-10 h-5 rounded-full transition-colors relative ${loop ? 'bg-telegram-secondary' : 'bg-white/20'}`}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${loop ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
            {/* Skip forward */}
            <div className="mb-3">
              <label className="text-white/70 text-xs mb-1.5 block">Skip forward</label>
              <div className="flex gap-1 items-center">
                {[5, 10, 15, 30].map(s => (
                  <button
                    key={s}
                    onClick={() => updateSetting('playerSkipForward', s as SkipDuration)}
                    className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${settings.playerSkipForward === s ? 'bg-telegram-secondary text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
                  >
                    {s}s
                  </button>
                ))}
                <input
                  type="number" min="1" max="60"
                  value={settings.playerSkipForward}
                  onChange={e => { const v = Math.max(1, Math.min(60, parseInt(e.target.value) || 1)); updateSetting('playerSkipForward', v as SkipDuration); }}
                  className="w-14 px-1.5 py-1 rounded text-xs font-mono bg-white/10 text-white/80 border border-white/10 focus:border-telegram-secondary focus:outline-none text-center"
                  title="Custom seconds (1-60)"
                />
              </div>
            </div>
            {/* Skip backward */}
            <div className="mb-0">
              <label className="text-white/70 text-xs mb-1.5 block">Skip backward</label>
              <div className="flex gap-1 items-center">
                {[5, 10, 15, 30].map(s => (
                  <button
                    key={s}
                    onClick={() => updateSetting('playerSkipBackward', s as SkipDuration)}
                    className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${settings.playerSkipBackward === s ? 'bg-telegram-secondary text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
                  >
                    {s}s
                  </button>
                ))}
                <input
                  type="number" min="1" max="60"
                  value={settings.playerSkipBackward}
                  onChange={e => { const v = Math.max(1, Math.min(60, parseInt(e.target.value) || 1)); updateSetting('playerSkipBackward', v as SkipDuration); }}
                  className="w-14 px-1.5 py-1 rounded text-xs font-mono bg-white/10 text-white/80 border border-white/10 focus:border-telegram-secondary focus:outline-none text-center"
                  title="Custom seconds (1-60)"
                />
              </div>
            </div>
          </div>

          {/* Display */}
          <div className="px-4 py-3 border-b border-white/10">
            <h3 className="text-white/50 text-[10px] uppercase tracking-wider mb-2">Display</h3>
            {/* Video fit */}
            <div className="mb-3">
              <label className="text-white/70 text-xs mb-1.5 block">Video fit</label>
              <div className="flex gap-1">
                {([
                  ['original', 'Original'],
                  ['contain', 'Fit'],
                  ['fill', 'Fill'],
                ] as [VideoFit, string][]).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => updateSetting('playerVideoFit', val)}
                    className={`px-2.5 py-1 rounded text-xs transition-colors ${settings.playerVideoFit === val ? 'bg-telegram-secondary text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {/* Rotation */}
            <div className="mb-3">
              <label className="text-white/70 text-xs mb-1.5 block">Rotation</label>
              <div className="flex gap-1">
                {[0, 90, 180, 270].map(r => (
                  <button
                    key={r}
                    onClick={() => setRotation(r)}
                    className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${rotation === r ? 'bg-telegram-secondary text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
                  >
                    {r}°
                  </button>
                ))}
              </div>
            </div>
            {/* Brightness */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-white/70 text-xs">Brightness</label>
                <span className="text-white/50 text-xs font-mono">{brightness.toFixed(1)}</span>
              </div>
              <input
                type="range" min="0.5" max="2" step="0.1"
                value={brightness}
                onChange={e => setBrightness(parseFloat(e.target.value))}
                className="w-full accent-telegram-secondary h-1"
              />
            </div>
            {/* PiP */}
            <div className="flex items-center justify-between">
              <span className="text-white/70 text-xs">Picture-in-Picture</span>
              <button
                onClick={() => setPip(!pip)}
                className={`w-10 h-5 rounded-full transition-colors relative ${pip ? 'bg-telegram-secondary' : 'bg-white/20'}`}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${pip ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
          </div>

          {/* Behavior */}
          <div className="px-4 py-3 border-b border-white/10">
            <h3 className="text-white/50 text-[10px] uppercase tracking-wider mb-2">Behavior</h3>
            {/* Auto-hide delay */}
            <div className="mb-3">
              <label className="text-white/70 text-xs mb-1.5 block">Auto-hide controls</label>
              <div className="flex gap-1">
                {([
                  [3, '3s'],
                  [5, '5s'],
                  [10, '10s'],
                  [0, 'Never'],
                ] as [AutoHideDelay, string][]).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => updateSetting('playerAutoHideDelay', val)}
                    className={`px-2.5 py-1 rounded text-xs transition-colors ${settings.playerAutoHideDelay === val ? 'bg-telegram-secondary text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            </div>

          {/* Info */}
          <div className="px-4 py-3">
            <h3 className="text-white/50 text-[10px] uppercase tracking-wider mb-2">Video info</h3>
            <div className="space-y-1">
              {videoResolution && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/50">Resolution</span>
                  <span className="text-white/80 font-mono">{videoResolution.w}×{videoResolution.h}</span>
                </div>
              )}
              {dur > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/50">Duration</span>
                  <span className="text-white/80 font-mono">{fmt(dur)}</span>
                </div>
              )}
              {totalBytes > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/50">File size</span>
                  <span className="text-white/80 font-mono">{formatBytes(totalBytes)}</span>
                </div>
              )}
              <div className="flex justify-between text-xs">
                <span className="text-white/50">Cache</span>
                <span className="text-white/80 font-mono">{cacheComplete ? 'Complete ✓' : cachePercent > 0 ? `${cachePercent}%` : 'None'}</span>
              </div>
            </div>
          </div>
        </div>
      )}

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

      {/* Skip feedback overlay */}
      {skipFeedback && (() => {
        const fromTime = time;
        const toTime = skipFeedback.direction === 'forward'
          ? Math.min(fromTime + skipFeedback.amount, dur)
          : Math.max(fromTime - skipFeedback.amount, 0);
        const isForward = skipFeedback.direction === 'forward';
        return (
          <div
            key={skipFeedbackKey.current}
            className="absolute inset-0 flex items-center justify-center pointer-events-none z-20 animate-[skipPop_1.5s_ease-out_forwards]"
          >
            <div className="flex flex-col items-center gap-2 bg-black/30 backdrop-blur-xl rounded-2xl px-10 py-6">
              {/* Icon + delta */}
              <div className="flex items-center gap-2">
                {isForward ? (
                  <svg className="w-7 h-7 text-telegram-primary" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M5.59 7.41L10.18 12l-4.59 4.59L7 18l6-6-6-6zM16 18l6-6-6-6-1.41 1.41L20.18 12l-5.59 4.59L16 18z" />
                  </svg>
                ) : (
                  <svg className="w-7 h-7 text-white" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18.41 16.59L13.82 12l4.59-4.59L17 6l-6 6 6 6zM8 6l-6 6 6 6 1.41-1.41L3.82 12l5.59-4.59L8 6z" />
                  </svg>
                )}
                <span className={`text-xl font-bold font-mono ${isForward ? 'text-telegram-primary' : 'text-white'}`}>
                  {isForward ? '+' : '-'}{skipFeedback.amount}s
                </span>
              </div>
              {/* FROM → TO — big, bold, dominant */}
              <div className="flex items-center gap-4">
                <span className="text-2xl font-bold text-white font-mono">{fmt(fromTime)}</span>
                <svg className={`w-6 h-6 ${isForward ? 'text-telegram-primary' : 'text-white/60'}`} fill="currentColor" viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" /></svg>
                <span className={`text-2xl font-bold font-mono ${isForward ? 'text-telegram-primary' : 'text-white'}`}>{fmt(toTime)}</span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Big play */}
      {!playing && !load && !err && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-16 h-16 bg-black/50 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-white ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
          </div>
        </div>
      )}
      {/* VideoCacheDialog — shown when closing a video with cache > 0% */}
      {showCacheDialog && (
        <VideoCacheDialog
          percentage={pendingCachePercent}
          filename={file.name}
          messageId={file.id}
          isAlreadyDownloading={isAlreadyDownloading ?? false}
          onDiscard={handleCacheDiscard}
          onKeepBuffers={handleCacheKeepBuffers}
          onContinueDownload={handleCacheContinueDownload}
          onAlreadyDownloadingClose={handleAlreadyDownloadingClose}
          onCancel={handleCacheDialogCancel}
        />
      )}
    </div>
  );
}
