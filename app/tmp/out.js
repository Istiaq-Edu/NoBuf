"use strict";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { isVideoFile } from "../../utils";
import { useMSEPlayer, formatSpeed } from "../../hooks/useMSEPlayer";
import { useThumbnailExtractor } from "../../hooks/useThumbnailExtractor";
import { useSettings, SPEED_LIMIT_PRESETS, formatSpeedLimit, formatSpeedLimitCompact } from "../../context/SettingsContext";
import { useCacheSession } from "../../context/CacheSessionContext";
import { VideoCacheDialog } from "./VideoCacheDialog";
import { useSubtitles } from "../../hooks/useSubtitles";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { SubtitleTrack } from "../../lib/faststream/subtitles/SubtitleTrack";
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
function mergeTimeRanges(ranges, toleranceS = 1) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of sorted) {
    if (merged.length === 0 || r[0] > merged[merged.length - 1][1] + toleranceS) {
      merged.push([r[0], r[1]]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
    }
  }
  return merged;
}
function SettingsSection({ icon, title, children }) {
  return /* @__PURE__ */ jsxs("div", { className: "px-4 py-3.5 border-b border-white/[0.06]", children: [
    /* @__PURE__ */ jsxs("h3", { className: "text-white/40 text-[10px] font-semibold uppercase tracking-[0.14em] mb-3 flex items-center gap-1.5", children: [
      /* @__PURE__ */ jsx("span", { className: "text-nobuf-primary/70", children: icon }),
      title
    ] }),
    /* @__PURE__ */ jsx("div", { className: "space-y-3.5", children })
  ] });
}
function SettingRow({ label, hint, stack, children }) {
  const head = /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
    /* @__PURE__ */ jsx("div", { className: "text-white/75 text-xs", children: label }),
    hint && /* @__PURE__ */ jsx("div", { className: "text-white/35 text-[10px] leading-snug mt-0.5", children: hint })
  ] });
  if (stack) return /* @__PURE__ */ jsxs("div", { children: [
    head && /* @__PURE__ */ jsx("div", { className: "mb-2", children: head }),
    children
  ] });
  return /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-3", children: [
    head,
    /* @__PURE__ */ jsx("div", { className: "shrink-0", children })
  ] });
}
function Switch({ on, onClick, title }) {
  return /* @__PURE__ */ jsx(
    "button",
    {
      onClick,
      title,
      role: "switch",
      "aria-checked": on,
      className: `relative w-10 h-[22px] rounded-full transition-colors duration-200 ${on ? "bg-nobuf-primary" : "bg-white/15"}`,
      children: /* @__PURE__ */ jsx("span", { className: `absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-200 ${on ? "left-[21px]" : "left-[3px]"}` })
    }
  );
}
function Chip({ active, onClick, tone = "secondary", children }) {
  const activeCls = tone === "green" ? "bg-green-500/25 text-green-300 ring-1 ring-green-400/40" : tone === "primary" ? "bg-nobuf-primary/20 text-nobuf-primary ring-1 ring-nobuf-primary/40" : "bg-nobuf-secondary text-white";
  return /* @__PURE__ */ jsx(
    "button",
    {
      onClick,
      className: `px-2.5 py-1 rounded-md text-xs transition-all duration-150 ${active ? activeCls : "bg-white/[0.07] text-white/55 hover:bg-white/15 hover:text-white/85"}`,
      children
    }
  );
}
function UnitToggle({ unit, onChange, tone }) {
  const activeCls = tone === "green" ? "bg-green-500/25 text-green-300" : "bg-nobuf-primary/20 text-nobuf-primary";
  return /* @__PURE__ */ jsx("div", { className: "flex rounded-md overflow-hidden border border-white/10 shrink-0", children: ["kb", "mb"].map((u) => /* @__PURE__ */ jsx(
    "button",
    {
      onClick: () => onChange(u),
      className: `px-2 py-1 text-[10px] font-mono transition-colors ${unit === u ? activeCls : "bg-white/[0.04] text-white/40 hover:text-white/70"}`,
      children: u === "kb" ? "KB/s" : "MB/s"
    },
    u
  )) });
}
const NumInput = ({ value, onChange, focusCls = "focus:border-nobuf-secondary", title, w = "w-14" }) => /* @__PURE__ */ jsx(
  "input",
  {
    type: "number",
    value,
    title,
    onChange: (e) => onChange(e.target.value),
    className: `${w} px-1.5 py-1 rounded-md text-xs font-mono bg-white/[0.07] text-white/80 border border-white/10 ${focusCls} focus:outline-none text-center`
  }
);
export function FastStreamPlayer({ file, streamUrl, onClose, onNext, onPrev, activeFolderId, onContinueToDownload, isAlreadyDownloading, isPublicChannel }) {
  const boxRef = useRef(null);
  const vidRef = useRef(null);
  const barRef = useRef(null);
  const controlsRef = useRef(null);
  const subFileInputRef = useRef(null);
  const { settings, updateSetting } = useSettings();
  const cacheSession = useCacheSession();
  const subs = useSubtitles();
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const durRef = useRef(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(settings.playerSpeed);
  useEffect(() => {
    setRate(settings.playerSpeed);
  }, [file.id, settings.playerSpeed]);
  useEffect(() => {
    subs.clearTracks();
  }, [file.id]);
  const [_buf, setBuf] = useState(0);
  const [load, setLoad] = useState(true);
  const [err, setErr] = useState(null);
  const [lastVideoSrc, setLastVideoSrc] = useState(null);
  const [vis, setVis] = useState(true);
  const [fs, setFs] = useState(false);
  const [menu, setMenu] = useState(false);
  const [subMenu, setSubMenu] = useState(false);
  const [tip, setTip] = useState({ t: 0, x: 0, show: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragChip, setDragChip] = useState(null);
  const [dropSide, setDropSide] = useState(null);
  const [dragKind, setDragKind] = useState(null);
  const dragActiveRef = useRef(false);
  const lastDragEndRef = useRef(0);
  const markDragStart = useCallback(() => {
    dragActiveRef.current = true;
  }, []);
  const markDragEnd = useCallback(() => {
    dragActiveRef.current = false;
    lastDragEndRef.current = Date.now();
  }, []);
  const [dropIndex, setDropIndex] = useState(null);
  const [trayOpen, setTrayOpen] = useState(false);
  const [panelDragWidth, setPanelDragWidth] = useState(null);
  const panelResizing = useRef(false);
  const [controlsPinned, setControlsPinned] = useState(true);
  const [loop, setLoop] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [brightness, setBrightness] = useState(1);
  const [pip, setPip] = useState(false);
  const [videoResolution, setVideoResolution] = useState(null);
  const [customPrebufferValue, setCustomPrebufferValue] = useState("");
  const [customPrebufferUnit, setCustomPrebufferUnit] = useState("mb");
  const [customDownloadValue, setCustomDownloadValue] = useState("");
  const [customDownloadUnit, setCustomDownloadUnit] = useState("mb");
  const [showCacheDialog, setShowCacheDialog] = useState(false);
  const [pendingCachePercent, setPendingCachePercent] = useState(0);
  const [skipFeedback, setSkipFeedback] = useState(null);
  const skipFeedbackTimer = useRef(0);
  const skipFeedbackKey = useRef(0);
  const skipBurstFrom = useRef(null);
  const [videoEnded, setVideoEnded] = useState(false);
  const videoEndedRef = useRef(false);
  const [cachePercent, setCachePercent] = useState(0);
  const [cacheComplete, setCacheComplete] = useState(false);
  const [cachedTimeRanges, setCachedTimeRanges] = useState([]);
  const [bufferedRanges, setBufferedRanges] = useState([]);
  const maxCachedTime = cachedTimeRanges.length > 0 ? Math.max(...cachedTimeRanges.map((r) => r[1])) : 0;
  const [controlsHeight, setControlsHeight] = useState(0);
  const [miniBarVisible, setMiniBarVisible] = useState(false);
  const [dlOverlay, setDlOverlay] = useState(null);
  const [dlOverlayVisible, setDlOverlayVisible] = useState(false);
  const dlTransferIdRef = useRef("");
  const dismissTimerRef = useRef(0);
  const msePlayer = useMSEPlayer(streamUrl, file, activeFolderId, isPublicChannel);
  const player = {
    mseUrl: msePlayer.mseUrl,
    error: msePlayer.error,
    useNative: msePlayer.useNative,
    remuxUrl: msePlayer.remuxUrl,
    unsupportedCodec: msePlayer.unsupportedCodec,
    prefetchedBytes: msePlayer.prefetchedBytes,
    totalBytes: msePlayer.totalBytes,
    isPrefetching: msePlayer.isPrefetching,
    isPaused: msePlayer.isPaused,
    isComplete: msePlayer.isComplete,
    speed: msePlayer.speed,
    pausePrefetch: msePlayer.pausePrefetch,
    resumePrefetch: msePlayer.resumePrefetch,
    seekTo: msePlayer.seekTo,
    suppressLoadingSpinnerRef: msePlayer.suppressLoadingSpinnerRef,
    setVideoRef: msePlayer.setVideoRef,
    downloadedTimeRanges: msePlayer.downloadedTimeRanges,
    byteToTime: msePlayer.byteToTime,
    setSuppressBackendReports: msePlayer.setSuppressBackendReports,
    thumbnailDataReady: msePlayer.thumbnailDataReady,
    moovBufferReady: msePlayer.moovBufferReady,
    isTransmuxer: msePlayer.isTransmuxer,
    isTransmuxerActive: msePlayer.isTransmuxerActive,
    keyframeIndexReady: msePlayer.keyframeIndexReady,
    coldStartProgress: msePlayer.coldStartProgress,
    isColdStartBuffering: msePlayer.isColdStartBuffering,
    coldStartPhase: msePlayer.coldStartPhase,
    detectedFormat: msePlayer.detectedFormat,
    getMoovBuffer: msePlayer.getMoovBuffer,
    getFirstChunk: msePlayer.getFirstChunk,
    getInitSegments: msePlayer.getInitSegments,
    getVideoTrackInfo: msePlayer.getVideoTrackInfo,
    getMP4BoxClass: msePlayer.getMP4BoxClass,
    getFileLength: msePlayer.getFileLength,
    getFormat: msePlayer.getFormat,
    getKeyframeTimestamps: msePlayer.getKeyframeTimestamps,
    getKeyframeByteOffsets: msePlayer.getKeyframeByteOffsets,
    getTsHeaderData: msePlayer.getTsHeaderData,
    getTransmuxerSourceConfig: msePlayer.getTransmuxerSourceConfig
  };
  const {
    mseUrl: playerMseUrl,
    error: playerError,
    useNative: playerUseNative,
    remuxUrl: playerRemuxUrl,
    unsupportedCodec: playerUnsupportedCodec,
    prefetchedBytes: _prefetchedBytes,
    totalBytes,
    isPrefetching: _isPrefetching,
    isPaused: prefetchPaused,
    isComplete: prefetchComplete,
    speed: _whiteBarSpeed,
    // kept for MSE hook internals, but speed meter now uses greenBarSpeed
    pausePrefetch,
    resumePrefetch,
    seekTo,
    suppressLoadingSpinnerRef,
    setVideoRef,
    downloadedTimeRanges: _downloadedTimeRanges,
    // kept for re-render triggering + backend reporting
    byteToTime,
    recordByteTimeAnchor,
    setSuppressBackendReports,
    thumbnailDataReady,
    moovBufferReady,
    isTransmuxer,
    isTransmuxerActive: _isTransmuxerActive,
    keyframeIndexReady: _keyframeIndexReady,
    isColdStartBuffering,
    coldStartProgress,
    coldStartPhase,
    detectedFormat
  } = player;
  const [showColdStartOverlay, setShowColdStartOverlay] = useState(false);
  const [isRemuxLoading, setIsRemuxLoading] = useState(false);
  const isRemuxLoadingRef = useRef(false);
  isRemuxLoadingRef.current = isRemuxLoading;
  const coldStartBufferingRef = useRef(false);
  coldStartBufferingRef.current = isColdStartBuffering;
  useEffect(() => {
    if (isColdStartBuffering) {
      setShowColdStartOverlay(true);
    } else if (showColdStartOverlay) {
      setShowColdStartOverlay(false);
    }
  }, [isColdStartBuffering, showColdStartOverlay]);
  useEffect(() => {
    if (playerUnsupportedCodec) {
      setErr(playerUnsupportedCodec);
      setLoad(false);
    } else if (playerUseNative && playerError && !playerMseUrl) {
      setErr(playerError);
      setLoad(false);
    }
  }, [playerUseNative, playerMseUrl, playerError, playerUnsupportedCodec]);
  const mseGetters = useMemo(() => ({
    getMoovBuffer: msePlayer.getMoovBuffer,
    getFirstChunk: msePlayer.getFirstChunk,
    getInitSegments: msePlayer.getInitSegments,
    getVideoTrackInfo: msePlayer.getVideoTrackInfo,
    getMP4BoxClass: msePlayer.getMP4BoxClass,
    getFileLength: msePlayer.getFileLength,
    isTransmuxer: msePlayer.isTransmuxer,
    getFormat: msePlayer.getFormat,
    getKnownDuration: msePlayer.getKnownDuration,
    isTransmuxerActive: msePlayer.isTransmuxerActive,
    getKeyframeTimestamps: msePlayer.getKeyframeTimestamps,
    getKeyframeByteOffsets: msePlayer.getKeyframeByteOffsets,
    getTsHeaderData: msePlayer.getTsHeaderData,
    getTransmuxerSourceConfig: msePlayer.getTransmuxerSourceConfig,
    keyframeIndexReady: msePlayer.keyframeIndexReady,
    isFmp4Stream: msePlayer.isFmp4Stream,
    getFmp4Config: msePlayer.getFmp4Config
  }), [msePlayer.getMoovBuffer, msePlayer.getFirstChunk, msePlayer.getInitSegments, msePlayer.getVideoTrackInfo, msePlayer.getMP4BoxClass, msePlayer.getFileLength, msePlayer.isTransmuxer, msePlayer.getFormat, msePlayer.getKnownDuration, msePlayer.isTransmuxerActive, msePlayer.getKeyframeTimestamps, msePlayer.getKeyframeByteOffsets, msePlayer.getTsHeaderData, msePlayer.getTransmuxerSourceConfig, msePlayer.keyframeIndexReady, msePlayer.isFmp4Stream, msePlayer.getFmp4Config]);
  const { getCachedThumbnailSync, setDesiredHoverTime, clearDesiredHover, cachedTimes } = useThumbnailExtractor(vidRef, streamUrl, playerUseNative, mseGetters, thumbnailDataReady, moovBufferReady, maxCachedTime);
  const [thumbUrl, setThumbUrl] = useState(null);
  const [thumbLoading, setThumbLoading] = useState(false);
  const lastThumbTimeRef = useRef(-1);
  useEffect(() => {
    if (lastThumbTimeRef.current >= 0 && thumbLoading) {
      const cachedUrl = getCachedThumbnailSync(lastThumbTimeRef.current);
      if (cachedUrl) {
        setThumbUrl(cachedUrl);
        setThumbLoading(false);
      }
    }
  }, [cachedTimes, getCachedThumbnailSync, thumbLoading]);
  const handleClose = useCallback(async () => {
    if (Date.now() - lastDragEndRef.current < 350) return;
    if (!isVideoFile(file.name)) {
      onClose();
      return;
    }
    try {
      const cacheStatus = await invoke("cmd_get_cache_status", {
        messageId: file.id
      });
      if (cacheStatus && cacheStatus.percentage > 0) {
        setPendingCachePercent(cacheStatus.percentage);
        setShowCacheDialog(true);
        return;
      }
      if (cacheStatus && cacheStatus.percentage === 0 && cacheStatus.cached_bytes > 0) {
        onClose();
        const tryDelete = (attempt) => {
          invoke("cmd_delete_cache", { messageId: file.id, reason: "player-close-zero-cache" }).catch(() => {
            if (attempt < 5) {
              setTimeout(() => tryDelete(attempt + 1), 2e3);
            }
          });
        };
        setTimeout(() => tryDelete(1), 2e3);
        return;
      }
    } catch {
    }
    onClose();
  }, [file.id, file.name, onClose]);
  const handleCacheDiscard = useCallback(() => {
    setShowCacheDialog(false);
    cacheSession.removeCache(file.id);
    onClose();
    const tryDelete = (attempt) => {
      invoke("cmd_delete_cache", { messageId: file.id, reason: "cache-dialog-discard" }).catch(() => {
        if (attempt < 5) {
          setTimeout(() => tryDelete(attempt + 1), 2e3);
        }
      });
    };
    setTimeout(() => tryDelete(1), 2e3);
  }, [file.id, cacheSession, onClose]);
  const handleCacheKeepBuffers = useCallback(() => {
    setShowCacheDialog(false);
    cacheSession.registerCache(file.id, pendingCachePercent, file.name);
    onClose();
  }, [file.id, pendingCachePercent, file.name, cacheSession, onClose]);
  const handleCacheContinueDownload = useCallback((savePath) => {
    setShowCacheDialog(false);
    onContinueToDownload?.(file.id, file.name, activeFolderId, savePath, pendingCachePercent);
    cacheSession.removeCache(file.id);
    onClose();
  }, [file.id, file.name, activeFolderId, pendingCachePercent, onContinueToDownload, cacheSession, onClose]);
  const handleCacheDialogCancel = useCallback(() => {
    setShowCacheDialog(false);
  }, [file.id]);
  const handleAlreadyDownloadingClose = useCallback(() => {
    setShowCacheDialog(false);
    toast.info(`${file.name} is already downloading \u2014 check the transfer panel`);
    onClose();
  }, [file.id, file.name, onClose]);
  const cacheSessionRef = useRef(cacheSession);
  cacheSessionRef.current = cacheSession;
  const greenBarSpeedHistoryRef = useRef([]);
  const [greenBarSpeed, setGreenBarSpeed] = useState(0);
  useEffect(() => {
    let active = true;
    let lastCachedBytes = 0;
    const poll = async () => {
      while (active) {
        try {
          if (window.__nobuf_userSeekInProgress !== true) {
            const status = await invoke("cmd_get_cache_status", { messageId: file.id });
            if (status) {
              setCachePercent(status.percentage);
              setCacheComplete(status.is_complete);
              const now = Date.now();
              const cachedBytes = status.cached_bytes ?? 0;
              if (lastCachedBytes > 0 && cachedBytes > lastCachedBytes) {
                const delta = cachedBytes - lastCachedBytes;
                const hist = greenBarSpeedHistoryRef.current;
                hist.push({ bytes: delta, time: now });
                while (hist.length > 0 && hist[0].time < now - 5e3) hist.shift();
                if (hist.length >= 2) {
                  const totalBytes2 = hist.reduce((s, e) => s + e.bytes, 0);
                  const dt = (hist[hist.length - 1].time - hist[0].time) / 1e3;
                  if (dt > 0.3) {
                    setGreenBarSpeed(totalBytes2 / dt);
                  }
                }
              }
              if (cachedBytes > 0) lastCachedBytes = cachedBytes;
              if (status.is_complete) {
                setGreenBarSpeed(0);
                lastCachedBytes = 0;
                greenBarSpeedHistoryRef.current = [];
              }
              const cs = cacheSessionRef.current;
              if (cs.getCacheInfo(file.id) && status.percentage > 0) {
                cs.updateCachePercent(file.id, status.percentage);
              }
            }
            const durForBar = durRef.current || window.__nobuf_estimateDuration || 0;
            const ranges = [];
            if (status?.cached_ranges && status.total_bytes > 0 && durForBar > 0) {
              const cachedRanges = status.cached_ranges;
              const seekTarget = window.__nobuf_seekTargetTime;
              const rawPlayhead = vidRef.current?.currentTime ?? 0;
              if (typeof seekTarget === "number" && seekTarget > 0 && recordByteTimeAnchor) {
                const linearByte = seekTarget / durForBar * status.total_bytes;
                let best = null;
                let bestDist = Infinity;
                for (const [s] of cachedRanges) {
                  if (s < 4 * 1024 * 1024) continue;
                  const d = Math.abs(s - linearByte);
                  if (d < bestDist) {
                    bestDist = d;
                    best = s;
                  }
                }
                if (best !== null && bestDist < 128 * 1024 * 1024) {
                  recordByteTimeAnchor(best, seekTarget);
                }
              }
              const playhead = typeof seekTarget === "number" && seekTarget > rawPlayhead ? seekTarget : rawPlayhead;
              const behindWindow = 60;
              const dropped = [];
              for (const [s, e] of cachedRanges) {
                const ts = byteToTime(s);
                const te = byteToTime(e + 1);
                if (te < playhead - behindWindow) {
                  dropped.push([ts, te]);
                  continue;
                }
                ranges.push([ts, te]);
              }
              console.log(`[GREEN-BAR] playhead=${playhead.toFixed(1)}s (raw=${rawPlayhead.toFixed(1)}, seekTgt=${typeof seekTarget === "number" ? seekTarget.toFixed(1) : "-"}) dur=${durForBar.toFixed(1)}s | cached bytes\u2192time: ${cachedRanges.map(([s, e]) => `${(s / 1e6).toFixed(0)}-${(e / 1e6).toFixed(0)}MB\u2192${byteToTime(s).toFixed(0)}-${byteToTime(e + 1).toFixed(0)}s`).join(", ")} | kept: ${ranges.map(([a, b]) => `${a.toFixed(0)}-${b.toFixed(0)}s`).join(", ") || "none"} | dropped: ${dropped.map(([a, b]) => `${a.toFixed(0)}-${b.toFixed(0)}s`).join(", ") || "none"}`);
            }
            if (ranges.length > 0) {
              setCachedTimeRanges(mergeTimeRanges(ranges));
            }
          }
        } catch {
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    };
    poll();
    return () => {
      active = false;
    };
  }, [file.id, byteToTime]);
  const hasShownResumeToast = useRef(false);
  useEffect(() => {
    if (hasShownResumeToast.current) return;
    const cached = cacheSession.getCacheInfo(file.id);
    if (cached && cached.percentage > 0) {
      hasShownResumeToast.current = true;
      toast.info(`Resuming from ${cached.percentage}% cache`, { duration: 3e3 });
    }
  }, [file.id, cacheSession]);
  useEffect(() => {
    let unlisten;
    listen("download-progress", async (event) => {
      if (event.payload.id === dlTransferIdRef.current) {
        setDlOverlay({
          active: true,
          percent: event.payload.percent,
          fromCache: cacheComplete,
          speed: event.payload.speed_bytes_per_sec
        });
        try {
          const status = await invoke("cmd_get_cache_status", { messageId: file.id });
          if (status?.cached_ranges && dur > 0 && status.total_bytes > 0) {
            const ranges = status.cached_ranges.map(([s, e]) => [byteToTime(s), byteToTime(e + 1)]);
            setCachedTimeRanges(mergeTimeRanges(ranges));
          }
        } catch {
        }
        if (event.payload.percent >= 100) {
          setSuppressBackendReports(false);
          setDlOverlay((prev) => prev ? { ...prev, completed: true } : null);
          dlTransferIdRef.current = "";
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [cacheComplete, dur, totalBytes, file.id]);
  const handleDownload = useCallback(async () => {
    try {
      const savePath = await save({ defaultPath: file.name });
      if (!savePath) return;
      const transferId = `dl-${file.id}-${Date.now()}`;
      dlTransferIdRef.current = transferId;
      setDlOverlay({ active: true, percent: 0, fromCache: cacheComplete, speed: 0 });
      setDlOverlayVisible(true);
      clearTimeout(dismissTimerRef.current);
      setSuppressBackendReports(true);
      await invoke("cmd_download_file", {
        messageId: file.id,
        savePath,
        folderId: activeFolderId,
        transferId
      });
      setSuppressBackendReports(false);
      toast.success(cacheComplete ? `Downloaded from cache: ${file.name}` : `Downloaded: ${file.name}`);
    } catch (e) {
      const errMsg = String(e);
      setSuppressBackendReports(false);
      if (!errMsg.includes("cancelled") && !errMsg.includes("Cancel")) {
        toast.error(`Download failed: ${errMsg}`);
      }
      setDlOverlayVisible(false);
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = window.setTimeout(() => {
        setDlOverlay(null);
        dlTransferIdRef.current = "";
      }, 300);
    }
  }, [file, activeFolderId, cacheComplete, setSuppressBackendReports]);
  const handleCancelDownload = useCallback(async () => {
    if (dlOverlay?.completed) {
      setDlOverlayVisible(false);
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = window.setTimeout(() => setDlOverlay(null), 300);
      return;
    }
    if (!dlTransferIdRef.current) return;
    try {
      await invoke("cmd_cancel_transfer", { transferId: dlTransferIdRef.current });
    } catch {
    }
    setSuppressBackendReports(false);
    setDlOverlayVisible(false);
    clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = window.setTimeout(() => {
      setDlOverlay(null);
      dlTransferIdRef.current = "";
    }, 300);
  }, [setSuppressBackendReports, dlOverlay?.completed]);
  const fmt = (s) => {
    if (!isFinite(s)) return "0:00";
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sc = Math.floor(s % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sc).padStart(2, "0")}` : `${m}:${String(sc).padStart(2, "0")}`;
  };
  const formatBytes = (b) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return;
    setVideoRef(v);
    if (playerUseNative) {
      const nativeUrl = playerRemuxUrl || streamUrl;
      console.log("[Player] Native fallback: setting video src to", nativeUrl === playerRemuxUrl ? "remux URL" : "streamUrl");
      if (nativeUrl === playerRemuxUrl && file) {
        let knownDuration = 0;
        if (file.duration && file.duration > 0 && isFinite(file.duration)) {
          knownDuration = file.duration;
        }
        if (knownDuration <= 0 && window.__nobuf_ptsDuration > 0) {
          knownDuration = window.__nobuf_ptsDuration;
        }
        if (knownDuration > 0) {
          console.log("[Player] Remux: overriding duration to", knownDuration.toFixed(1), "s");
          setDur(knownDuration);
          durRef.current = knownDuration;
        }
      }
      v.src = nativeUrl;
      setLastVideoSrc(nativeUrl);
      v.autoplay = true;
      if (nativeUrl === playerRemuxUrl) {
        setIsRemuxLoading(true);
        const remuxTimeoutId = setTimeout(() => {
          if (isRemuxLoadingRef.current) {
            console.warn("[Player] Remux loading timeout (45s) \u2014 hiding overlay");
            setIsRemuxLoading(false);
          }
        }, 45e3);
        v.__nobuf_remuxTimeoutId = remuxTimeoutId;
      }
    } else {
      const videoUrl = playerMseUrl;
      if (videoUrl) {
        console.log("[Player] Setting video src:", videoUrl);
        v.src = videoUrl;
        setLastVideoSrc(videoUrl);
      } else {
        console.log("[Player] MSE URL is null (mpegts.js mode) \u2014 skipping video.src, mpegts.js will set it");
        setLastVideoSrc("mpegts://internal");
      }
      v.autoplay = false;
    }
    const onMeta = () => {
      console.log("[Player] loadedmetadata, duration:", v.duration, "readyState:", v.readyState);
      if (!isFinite(v.duration) && file) {
        let knownDuration = 0;
        const isEstimateSource = !file.duration && !window.__nobuf_ptsDuration;
        if (file.duration && file.duration > 0 && isFinite(file.duration)) {
          knownDuration = file.duration;
        }
        if (knownDuration <= 0 && window.__nobuf_ptsDuration > 0) {
          knownDuration = window.__nobuf_ptsDuration;
        }
        if (knownDuration <= 0 && file.size > 0) {
          knownDuration = file.size / 4e6 * 8;
        }
        if (knownDuration > 0) {
          console.log("[Player] MPEGTS: overriding Infinity duration to", knownDuration.toFixed(1), "s (source:", file.duration ? "Telegram" : window.__nobuf_ptsDuration ? "PTS-tail" : "4Mbps-estimate", ")");
          if (isEstimateSource) {
            window.__nobuf_durationIsEstimate = true;
            window.__nobuf_estimateDuration = knownDuration;
          } else {
            window.__nobuf_durationIsEstimate = false;
            setDur(knownDuration);
            durRef.current = knownDuration;
          }
        }
      } else {
        const isRemux = lastVideoSrc === playerRemuxUrl || v.src?.includes("/remux/");
        const realDuration = file?.duration && file.duration > 0 && isFinite(file.duration) ? file.duration : window.__nobuf_ptsDuration > 0 ? window.__nobuf_ptsDuration : 0;
        const isEstimate = window.__nobuf_durationIsEstimate === true && realDuration <= 0;
        if (isRemux && realDuration > 0) {
          setDur(realDuration);
          durRef.current = realDuration;
        } else if (!isRemux || v.duration > durRef.current) {
          if (isEstimate) {
            window.__nobuf_estimateDuration = v.duration;
          } else {
            setDur(v.duration);
            durRef.current = v.duration;
          }
        }
      }
      setVol(v.volume);
      setMuted(v.muted);
      setVideoResolution({ w: v.videoWidth, h: v.videoHeight });
      v.playbackRate = settings.playerSpeed;
      v.loop = loop;
      setLoad(false);
      if (!coldStartBufferingRef.current) {
        if (window.__nobuf_seekTargetTime > 0) return;
        v.play().catch((e) => {
          if (e?.name !== "AbortError") console.warn("[Player] play() failed:", e);
        });
      }
    };
    const onCanPlay = () => {
      const ranges = [];
      for (let i = 0; i < v.buffered.length; i++) {
        ranges.push([v.buffered.start(i), v.buffered.end(i)]);
      }
      if (ranges.length > 0) setBufferedRanges(ranges);
      if (videoEndedRef.current) return;
      if (coldStartBufferingRef.current) return;
      if (window.__nobuf_seekTargetTime > 0) return;
      v.play().catch(() => {
      });
    };
    const onErr = () => {
      const err2 = v.error;
      console.error("[Player] video error:", err2?.code, err2?.message, "src:", v.src);
      if (isRemuxLoadingRef.current) {
        setIsRemuxLoading(false);
      }
      if (v.__nobuf_remuxTimeoutId) {
        clearTimeout(v.__nobuf_remuxTimeoutId);
        v.__nobuf_remuxTimeoutId = null;
      }
      setErr(playerError || `Video error: ${err2?.message || "unknown"}`);
      setLoad(false);
    };
    const onTime = () => {
      const ct = v.currentTime;
      if (!isFinite(ct)) return;
      const seekTarget = window.__nobuf_seekTargetTime;
      const seekInProgress = window.__nobuf_userSeekInProgress === true;
      if (seekTarget > 0 && (seekInProgress || ct < seekTarget - 2 || ct > seekTarget + 20)) {
        setTime(seekTarget);
      } else {
        if (seekTarget > 0) {
          window.__nobuf_seekTargetTime = 0;
        }
        setTime(ct);
      }
      if (v.buffered.length > 0) {
        let maxBuf = 0;
        for (let i = 0; i < v.buffered.length; i++) {
          maxBuf = Math.max(maxBuf, v.buffered.end(i));
        }
        setBuf(maxBuf);
      }
      const ranges = [];
      for (let i = 0; i < v.buffered.length; i++) {
        ranges.push([v.buffered.start(i), v.buffered.end(i)]);
      }
      setBufferedRanges(ranges);
    };
    const onPlay = () => {
      if (isRemuxLoadingRef.current) {
        setIsRemuxLoading(false);
      }
      if (v.__nobuf_remuxTimeoutId) {
        clearTimeout(v.__nobuf_remuxTimeoutId);
        v.__nobuf_remuxTimeoutId = null;
      }
      setPlaying(true);
      if (videoEndedRef.current && v.currentTime > 1) {
        console.log(`[Player] onPlay while videoEnded=true at currentTime=${v.currentTime.toFixed(1)}s \u2014 keeping replay overlay`);
      } else {
        console.log("[Player] onPlay \u2014 clearing videoEnded");
        setVideoEnded(false);
        videoEndedRef.current = false;
      }
    };
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      console.log("[Player] onEnded \u2014 setting videoEnded=true");
      setPlaying(false);
      setVideoEnded(true);
      videoEndedRef.current = true;
    };
    const onWait = () => {
      if (!suppressLoadingSpinnerRef.current) setLoad(true);
    };
    const onPlay2 = () => setLoad(false);
    const onProgress = () => {
      if (v.buffered.length > 0) {
        let maxBuf = 0;
        for (let i = 0; i < v.buffered.length; i++) {
          maxBuf = Math.max(maxBuf, v.buffered.end(i));
        }
        setBuf(maxBuf);
      }
      const ranges = [];
      for (let i = 0; i < v.buffered.length; i++) {
        ranges.push([v.buffered.start(i), v.buffered.end(i)]);
      }
      setBufferedRanges(ranges);
    };
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("error", onErr);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    v.addEventListener("waiting", onWait);
    v.addEventListener("playing", onPlay2);
    v.addEventListener("progress", onProgress);
    const onDurChange = () => {
      if (!file) return;
      const realDuration = file.duration && file.duration > 0 && isFinite(file.duration) ? file.duration : window.__nobuf_ptsDuration > 0 ? window.__nobuf_ptsDuration : 0;
      const isRemux = lastVideoSrc === playerRemuxUrl || v.src?.includes("/remux/");
      if (isRemux && realDuration <= 0 && isFinite(v.duration) && v.duration > 0) {
        return;
      }
      if (isFinite(v.duration) && v.duration > 0) {
        const isOverflow = realDuration > 0 && v.duration > realDuration * 1.5;
        const clampedDur = isOverflow ? realDuration : v.duration;
        const safeDur = realDuration > 0 && clampedDur < realDuration ? realDuration : clampedDur;
        if (durRef.current > 0 && Math.abs(safeDur - durRef.current) < 0.01) {
          return;
        }
        if (!isRemux || safeDur > durRef.current) {
          const isEstimate = window.__nobuf_durationIsEstimate === true;
          if (safeDur !== v.duration) {
            console.warn("[Player] durationchange corrected:", v.duration, "\u2192", safeDur, "(real:", realDuration, ")");
          } else {
            console.log("[Player] durationchange:", safeDur, "s (was:", durRef.current, ")");
          }
          if (realDuration <= 0 && isEstimate) {
            window.__nobuf_estimateDuration = safeDur;
          } else {
            setDur(safeDur);
            durRef.current = safeDur;
            window.__nobuf_durationIsEstimate = false;
          }
        }
      } else if (!isFinite(v.duration)) {
        let knownDuration = realDuration;
        let isEstimate = realDuration <= 0;
        if (knownDuration <= 0 && file.size > 0) {
          knownDuration = file.size / 4e6 * 8;
          isEstimate = true;
        }
        if (knownDuration > 0) {
          const source = isEstimate ? "4Mbps" : file.duration ? "Telegram" : "PTS-tail";
          console.log("[Player] durationchange Infinity \u2192 override:", knownDuration.toFixed(1), "s (source:", source, ")");
          if (isEstimate) {
            window.__nobuf_durationIsEstimate = true;
            window.__nobuf_estimateDuration = knownDuration;
          } else {
            window.__nobuf_durationIsEstimate = false;
            setDur(knownDuration);
            durRef.current = knownDuration;
          }
        }
      }
    };
    v.addEventListener("durationchange", onDurChange);
    let rafId = 0;
    let lastPollTime = 0;
    const pollBuffered = (now) => {
      if (now - lastPollTime >= 250) {
        lastPollTime = now;
        if (window.__nobuf_userSeekInProgress !== true) {
          const ranges = [];
          for (let i = 0; i < v.buffered.length; i++) {
            ranges.push([v.buffered.start(i), v.buffered.end(i)]);
          }
          setBufferedRanges(ranges);
        }
      }
      rafId = requestAnimationFrame(pollBuffered);
    };
    rafId = requestAnimationFrame(pollBuffered);
    return () => {
      setVideoRef(null);
      cancelAnimationFrame(rafId);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("error", onErr);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("waiting", onWait);
      v.removeEventListener("playing", onPlay2);
      v.removeEventListener("progress", onProgress);
      v.removeEventListener("durationchange", onDurChange);
    };
  }, [streamUrl, playerMseUrl, playerUseNative, playerRemuxUrl, setVideoRef]);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const PIN_AUTO_HIDE_MS = 3e3;
  const showPinButton = settings.playerShowPinButton;
  useEffect(() => {
    if (!showPinButton) {
      setVis(true);
      return;
    }
    if (!playing || settingsOpen || controlsPinned || dragKind) {
      setVis(true);
      return;
    }
    let hideTimer;
    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (playing && !settingsOpen && !controlsPinned && !controlsRef.current?.matches(":hover")) {
          setVis(false);
        }
      }, PIN_AUTO_HIDE_MS);
    };
    scheduleHide();
    const mv = (e) => {
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        lastMousePos.current = { x: e.clientX, y: e.clientY };
        setVis(true);
      }
      scheduleHide();
    };
    const onMouseLeave = () => {
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (playing && !settingsOpen && !controlsPinned) setVis(false);
      }, 1500);
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseleave", onMouseLeave);
    return () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseleave", onMouseLeave);
      clearTimeout(hideTimer);
    };
  }, [showPinButton, playing, settingsOpen, controlsPinned, dragKind]);
  useEffect(() => {
    if (!trayOpen) return;
    const onDown = (e) => {
      const t = e.target;
      if (!t.closest("[data-tray-root]")) setTrayOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setTrayOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [trayOpen]);
  useEffect(() => {
    if (!dragKind) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragKind]);
  useEffect(() => {
    const prevent = (e) => {
      const onBar = !!e.target?.closest?.("[data-controls-root]");
      if (!onBar) e.preventDefault();
    };
    document.addEventListener("dragover", prevent, true);
    document.addEventListener("drop", prevent, true);
    return () => {
      document.removeEventListener("dragover", prevent, true);
      document.removeEventListener("drop", prevent, true);
    };
  }, []);
  useEffect(() => {
    if (!vis && playing) {
      const timer = window.setTimeout(() => setMiniBarVisible(true), 300);
      return () => clearTimeout(timer);
    }
    setMiniBarVisible(false);
  }, [vis, playing]);
  useEffect(() => {
    const ch = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", ch);
    return () => document.removeEventListener("fullscreenchange", ch);
  }, []);
  useEffect(() => {
    const v = vidRef.current;
    if (v) v.loop = loop;
  }, [loop]);
  useEffect(() => {
    const v = vidRef.current;
    if (v) v.playbackRate = rate;
    updateSetting("playerSpeed", rate);
  }, [rate, updateSetting]);
  const replay = useCallback(() => {
    const v = vidRef.current;
    if (!v) return;
    setVideoEnded(false);
    videoEndedRef.current = false;
    if (playerUseNative) {
      v.play().catch(() => {
      });
    } else {
      seekTo(0);
      v.play().catch(() => {
      });
    }
  }, [playerUseNative, seekTo]);
  useEffect(() => {
    if (pip && vidRef.current) {
      vidRef.current.requestPictureInPicture?.().catch(() => {
        toast.error("PiP not supported");
        setPip(false);
      });
    } else if (!pip && document.pictureInPictureElement) {
      document.exitPictureInPicture?.().catch(() => {
      });
    }
  }, [pip]);
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return;
    const onEnter = () => setPip(true);
    const onLeave = () => setPip(false);
    v.addEventListener("enterpictureinpicture", onEnter);
    v.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      v.removeEventListener("enterpictureinpicture", onEnter);
      v.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, []);
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
  const toggle = useCallback(() => {
    const v = vidRef.current;
    if (!v) return;
    if (videoEndedRef.current) {
      replay();
    } else {
      v.paused ? v.play().catch(() => {
      }) : v.pause();
    }
  }, [replay]);
  const seek = useCallback((s) => {
    const v = vidRef.current;
    if (!v) return null;
    const from = v.currentTime;
    const target = Math.max(0, Math.min(from + s, dur));
    if (playerUseNative) {
      v.currentTime = target;
    } else if (target >= dur) {
      v.currentTime = dur;
      v.pause();
      setVideoEnded(true);
      videoEndedRef.current = true;
      setPlaying(false);
      setLoad(false);
    } else {
      seekTo(target);
    }
    return { from, to: target };
  }, [dur, playerUseNative, seekTo]);
  const showSkipFeedback = useCallback((dir, res) => {
    if (!res) return;
    setVis(true);
    const bursting = skipBurstFrom.current != null;
    const anchor = bursting ? skipBurstFrom.current : res.from;
    skipBurstFrom.current = anchor;
    if (!bursting) skipFeedbackKey.current += 1;
    clearTimeout(skipFeedbackTimer.current);
    setSkipFeedback({ direction: dir, from: anchor, to: res.to, totalDelta: res.to - anchor });
    skipFeedbackTimer.current = window.setTimeout(() => {
      setSkipFeedback(null);
      skipBurstFrom.current = null;
    }, 1e3);
  }, []);
  const seekFwd = useCallback(() => {
    if (videoEndedRef.current) return;
    showSkipFeedback("forward", seek(settings.playerSkipForward));
  }, [seek, showSkipFeedback, settings.playerSkipForward]);
  const seekBwd = useCallback(() => {
    const wasVideoEnded = videoEndedRef.current;
    if (wasVideoEnded) {
      console.log("[Player] seekBwd while videoEnded=true \u2014 clearing overlay, resuming playback");
      setVideoEnded(false);
      videoEndedRef.current = false;
    }
    const res = seek(-settings.playerSkipBackward);
    if (wasVideoEnded) {
      vidRef.current?.play().catch(() => {
      });
    }
    showSkipFeedback("backward", res);
  }, [seek, showSkipFeedback, settings.playerSkipBackward]);
  const skip30Fwd = useCallback(() => {
    if (videoEndedRef.current) return;
    showSkipFeedback("forward", seek(30));
  }, [seek, showSkipFeedback]);
  const skip30Bwd = useCallback(() => {
    showSkipFeedback("backward", seek(-30));
  }, [seek, showSkipFeedback]);
  const setVol2 = useCallback((n) => {
    const v = vidRef.current;
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, n));
    setVol(v.volume);
    if (n > 0) {
      v.muted = false;
      setMuted(false);
    }
  }, []);
  const mute = useCallback(() => {
    const v = vidRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);
  const fs2 = useCallback(() => {
    document.fullscreenElement ? document.exitFullscreen() : boxRef.current?.requestFullscreen();
  }, []);
  const rate2 = useCallback((r) => {
    const v = vidRef.current;
    if (v) {
      v.playbackRate = r;
      setRate(r);
    }
    setMenu(false);
  }, []);
  const loadSubFile = useCallback(async (fileList) => {
    const f = fileList?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const track = new SubtitleTrack(f.name.replace(/\.[^.]+$/, ""), null);
      track.loadText(text);
      subs.activateTrack(subs.addTrack(track));
      toast.success(`Loaded subtitles: ${f.name}`);
    } catch (e) {
      toast.error("Failed to load subtitle file");
      console.error("[Subtitles] sidecar load failed:", e);
    }
  }, [subs]);
  const PANEL_MIN = 260, PANEL_MAX_FRAC = 0.7;
  const startPanelResize = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    panelResizing.current = true;
    const rect = boxRef.current?.getBoundingClientRect();
    const boxW = rect?.width ?? window.innerWidth;
    const rightEdge = rect?.right ?? window.innerWidth;
    const maxW = Math.max(PANEL_MIN, Math.round(boxW * PANEL_MAX_FRAC));
    const move = (ev) => {
      if (!panelResizing.current) return;
      const w = Math.max(PANEL_MIN, Math.min(maxW, Math.round(rightEdge - ev.clientX)));
      setPanelDragWidth(w);
    };
    const up = () => {
      panelResizing.current = false;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
      setPanelDragWidth((w) => {
        if (w != null) updateSetting("playerSettingsWidth", w);
        return null;
      });
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }, [updateSetting]);
  const TRAY = "__tray__";
  const ALL_CHIPS = useMemo(() => ["skipBack", "skipFwd", "captions", "loop", "pip", "speed", "download", "settings", "pin", "fullscreen", TRAY], []);
  const barLayout = useMemo(() => {
    const raw = settings.playerBarLayout ?? { left: [], right: [], tray: [] };
    const seen = /* @__PURE__ */ new Set();
    const clean = (arr) => (arr ?? []).filter((id) => ALL_CHIPS.includes(id) && !seen.has(id) && (seen.add(id), true));
    const left = clean(raw.left), right = clean(raw.right);
    const tray = clean(raw.tray).filter((id) => id !== TRAY);
    if (!seen.has(TRAY)) {
      right.push(TRAY);
      seen.add(TRAY);
    }
    const missing = ALL_CHIPS.filter((id) => id !== TRAY && !seen.has(id));
    return { left, right, tray: [...tray, ...missing] };
  }, [settings.playerBarLayout, ALL_CHIPS]);
  const moveChip = useCallback((chip, zone, index) => {
    const next = { left: [...barLayout.left], right: [...barLayout.right], tray: [...barLayout.tray] };
    const from = ["left", "right", "tray"].find((z) => next[z].includes(chip));
    const fromIdx = from ? next[from].indexOf(chip) : -1;
    next.left = next.left.filter((c) => c !== chip);
    next.right = next.right.filter((c) => c !== chip);
    next.tray = next.tray.filter((c) => c !== chip);
    let target = index;
    if (target != null && from === zone && fromIdx !== -1 && fromIdx < target) target -= 1;
    if (target == null || target < 0 || target > next[zone].length) next[zone].push(chip);
    else next[zone].splice(target, 0, chip);
    updateSetting("playerBarLayout", next);
  }, [barLayout, updateSetting]);
  const sideFromX = useCallback((clientX) => {
    const rect = controlsRef.current?.getBoundingClientRect();
    return rect && clientX > rect.left + rect.width / 2 ? "right" : "left";
  }, []);
  const indexFromX = useCallback((side, clientX) => {
    const nodes = Array.from(document.querySelectorAll(`[data-chip-zone="${side}"] [data-chip-id]`));
    let idx = 0;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (clientX > r.left + r.width / 2) idx++;
      else break;
    }
    return idx;
  }, []);
  const onRowDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    lastDragEndRef.current = Date.now();
    const side = sideFromX(e.clientX);
    if (dragChip) moveChip(dragChip, side, indexFromX(side, e.clientX));
    setDragChip(null);
    setDragKind(null);
    setDropSide(null);
    setDropIndex(null);
  }, [moveChip, sideFromX, indexFromX, dragChip]);
  const onTrayDrop = useCallback(() => {
    lastDragEndRef.current = Date.now();
    if (dragChip) moveChip(dragChip, "tray");
    setDragChip(null);
    setDropSide(null);
    setDragKind(null);
  }, [moveChip, dragChip]);
  const onBarClick = useCallback((e) => {
    if (!barRef.current || !vidRef.current || !isFinite(dur) || dur <= 0) return;
    if (videoEndedRef.current) {
      setVideoEnded(false);
      videoEndedRef.current = false;
    }
    const r = barRef.current.getBoundingClientRect();
    const targetTime = (e.clientX - r.left) / r.width * dur;
    if (playerUseNative) {
      vidRef.current.currentTime = targetTime;
    } else if (targetTime >= dur) {
      vidRef.current.currentTime = dur;
      vidRef.current.pause();
      setVideoEnded(true);
      videoEndedRef.current = true;
      setPlaying(false);
      setLoad(false);
    } else {
      setTime(targetTime);
      seekTo(targetTime);
    }
  }, [dur, playerUseNative, seekTo]);
  const tipRafRef = useRef(0);
  const hoverDebounceRef = useRef(0);
  const onBarMove = useCallback((e) => {
    if (!barRef.current) return;
    const r = barRef.current.getBoundingClientRect();
    const hoverTime = (e.clientX - r.left) / r.width * dur;
    cancelAnimationFrame(tipRafRef.current);
    tipRafRef.current = requestAnimationFrame(() => {
      setTip({ t: hoverTime, x: e.clientX - r.left, show: true });
    });
    const roundedTime = Math.floor(hoverTime / 2) * 2;
    if (roundedTime !== lastThumbTimeRef.current) {
      lastThumbTimeRef.current = roundedTime;
      const cachedUrl = getCachedThumbnailSync(hoverTime);
      if (cachedUrl) {
        setThumbUrl(cachedUrl);
        setThumbLoading(false);
        clearTimeout(hoverDebounceRef.current);
        clearDesiredHover();
      } else {
        const canGenerateThumbnails = playerUseNative || thumbnailDataReady && moovBufferReady || isTransmuxer() || thumbnailDataReady && mseGetters?.isFmp4Stream();
        if (canGenerateThumbnails) {
          setThumbUrl(null);
          setThumbLoading(true);
          clearTimeout(hoverDebounceRef.current);
          hoverDebounceRef.current = window.setTimeout(() => {
            setDesiredHoverTime(hoverTime);
          }, 1e3);
        } else {
          setThumbUrl(null);
          setThumbLoading(false);
          clearDesiredHover();
        }
      }
    }
  }, [dur, getCachedThumbnailSync, setDesiredHoverTime, clearDesiredHover, thumbnailDataReady, moovBufferReady, mseGetters]);
  useEffect(() => {
    const h = (e) => {
      const t = e.target;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      switch (e.key.toLowerCase()) {
        case " ":
        case "k":
          e.preventDefault();
          toggle();
          break;
        case "arrowleft":
          e.preventDefault();
          e.shiftKey ? onPrev?.() : seekBwd();
          break;
        case "arrowright":
          e.preventDefault();
          e.shiftKey ? onNext?.() : seekFwd();
          break;
        case "arrowup":
          e.preventDefault();
          setVol2(vol + 0.1);
          break;
        case "arrowdown":
          e.preventDefault();
          setVol2(vol - 0.1);
          break;
        case "m":
          e.preventDefault();
          mute();
          break;
        case "f":
          e.preventDefault();
          fs2();
          break;
        case "escape":
          e.preventDefault();
          if (dragActiveRef.current || Date.now() - lastDragEndRef.current < 350) break;
          document.fullscreenElement ? document.exitFullscreen() : handleClose();
          break;
        case "j":
          e.preventDefault();
          seekBwd();
          break;
        case "l":
          e.preventDefault();
          seekFwd();
          break;
        case ",":
          e.preventDefault();
          rate2(Math.max(0.25, rate - 0.25));
          break;
        case ".":
          e.preventDefault();
          rate2(Math.min(4, rate + 0.25));
          break;
        case "<":
          e.preventDefault();
          rate2(Math.max(0.25, rate / 2));
          break;
        case ">":
          e.preventDefault();
          rate2(Math.min(4, rate * 2));
          break;
        case "c":
          e.preventDefault();
          if (subs.tracks.length === 0) break;
          if (subs.activeTracks.length === 0 && !subs.hasLastActive) subs.activateTrack(subs.tracks[0]);
          else subs.toggleSubtitles();
          break;
      }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [toggle, seek, setVol2, mute, fs2, handleClose, onNext, onPrev, vol, rate, rate2, dur, subs]);
  const pct = dur > 0 ? time / dur * 100 : 0;
  const chipButton = (id) => {
    switch (id) {
      case "skipBack":
        return { label: "Back 30s", el: /* @__PURE__ */ jsx("button", { onClick: skip30Bwd, className: "p-1.5 hover:bg-white/10 rounded text-white", title: "Back 30s", children: /* @__PURE__ */ jsxs("svg", { className: "w-5 h-5 block", fill: "currentColor", viewBox: "0 0 24 24", children: [
          /* @__PURE__ */ jsx("path", { d: "M12.5 3C7.81 3 4 6.81 4 11.5S7.81 20 12.5 20s8.5-3.81 8.5-8.5c0-.53-.05-1.05-.14-1.55l-1.63.55c.05.33.07.66.07 1 0 3.58-2.92 6.5-6.5 6.5S6 15.08 6 11.5 8.92 5 12.5 5V8l4-4-4-4v3z", transform: "scale(-1,1) translate(-24,0)" }),
          /* @__PURE__ */ jsx("text", { x: "12", y: "15", fontSize: "8", fontFamily: "monospace", fill: "currentColor", textAnchor: "middle", fontWeight: "bold", children: "30" })
        ] }) }) };
      case "skipFwd":
        return { label: "Forward 30s", el: /* @__PURE__ */ jsx("button", { onClick: skip30Fwd, className: "p-1.5 hover:bg-white/10 rounded text-white", title: "Forward 30s", children: /* @__PURE__ */ jsxs("svg", { className: "w-5 h-5 block", fill: "currentColor", viewBox: "0 0 24 24", children: [
          /* @__PURE__ */ jsx("path", { d: "M12.5 3C7.81 3 4 6.81 4 11.5S7.81 20 12.5 20s8.5-3.81 8.5-8.5c0-.53-.05-1.05-.14-1.55l-1.63.55c.05.33.07.66.07 1 0 3.58-2.92 6.5-6.5 6.5S6 15.08 6 11.5 8.92 5 12.5 5V8l4-4-4-4v3z" }),
          /* @__PURE__ */ jsx("text", { x: "12", y: "15", fontSize: "8", fontFamily: "monospace", fill: "currentColor", textAnchor: "middle", fontWeight: "bold", children: "30" })
        ] }) }) };
      case "captions":
        return { label: "Subtitles", el: /* @__PURE__ */ jsxs("div", { className: "relative", children: [
          /* @__PURE__ */ jsx("button", { onClick: (e) => {
            e.stopPropagation();
            setSubMenu((m) => !m);
          }, className: `p-1.5 hover:bg-white/10 rounded transition-colors ${subs.activeTracks.length ? "text-nobuf-primary" : "text-white"}`, title: "Subtitles", children: /* @__PURE__ */ jsx("svg", { className: "w-5 h-5", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z" }) }) }),
          subMenu && /* @__PURE__ */ jsxs("div", { className: "absolute bottom-full right-0 mb-2 bg-black/95 border border-white/10 rounded-lg overflow-hidden min-w-[180px] max-h-72 overflow-y-auto z-50 shadow-2xl py-1", onClick: (e) => e.stopPropagation(), children: [
            /* @__PURE__ */ jsx("button", { onClick: () => {
              subs.activeTracks.forEach(subs.deactivateTrack);
            }, className: `block w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 ${subs.activeTracks.length === 0 ? "text-nobuf-primary font-semibold" : "text-white"}`, children: "Off" }),
            subs.tracks.map((t, i) => /* @__PURE__ */ jsxs("button", { onClick: () => subs.toggleTrack(t), className: `block w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 truncate ${subs.activeTracks.includes(t) ? "text-nobuf-primary bg-nobuf-primary/10 font-semibold" : "text-white"}`, children: [
              t.label || t.language || `Track ${i + 1}`,
              t.isASS ? " (ASS)" : ""
            ] }, i)),
            /* @__PURE__ */ jsx("div", { className: "border-t border-white/10 mt-1 pt-1", children: /* @__PURE__ */ jsx("button", { onClick: () => {
              setSubMenu(false);
              subFileInputRef.current?.click();
            }, className: "block w-full text-left px-3 py-1.5 text-sm text-white/80 hover:bg-white/10", children: "Load subtitle file\u2026" }) })
          ] })
        ] }) };
      case "loop":
        return { label: "Loop", el: /* @__PURE__ */ jsx("button", { onClick: () => setLoop((l) => !l), className: `p-1.5 hover:bg-white/10 rounded transition-colors ${loop ? "text-nobuf-primary" : "text-white"}`, title: loop ? "Loop on" : "Loop off", children: /* @__PURE__ */ jsx("svg", { className: "w-5 h-5", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" }) }) }) };
      case "pip":
        return { label: "Picture-in-Picture", el: /* @__PURE__ */ jsx("button", { onClick: () => setPip((p) => !p), className: `p-1.5 hover:bg-white/10 rounded transition-colors ${pip ? "text-nobuf-primary" : "text-white"}`, title: "Picture-in-Picture", children: /* @__PURE__ */ jsx("svg", { className: "w-5 h-5", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z" }) }) }) };
      case "speed":
        return { label: "Speed", el: /* @__PURE__ */ jsxs("div", { className: "relative", children: [
          /* @__PURE__ */ jsxs("button", { onClick: () => setMenu(!menu), className: `px-1.5 py-1 hover:bg-white/10 rounded text-xs font-mono font-semibold flex items-center gap-1 ${rate !== 1 ? "text-nobuf-primary" : "text-white"}`, title: "Playback speed", children: [
            /* @__PURE__ */ jsx("svg", { className: "w-4 h-4", fill: "none", stroke: "currentColor", strokeWidth: "2", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M13 10V3L4 14h7v7l9-11h-7z" }) }),
            rate,
            "x"
          ] }),
          menu && /* @__PURE__ */ jsx("div", { className: "absolute bottom-full right-0 mb-2 bg-black/95 border border-white/10 rounded-lg overflow-hidden min-w-[64px] max-h-64 overflow-y-auto z-50 shadow-2xl", children: RATES.map((r) => /* @__PURE__ */ jsxs("button", { onClick: () => rate2(r), className: `block w-full text-left px-3 py-1.5 text-sm font-mono hover:bg-white/10 ${rate === r ? "text-nobuf-primary bg-nobuf-primary/10 font-semibold" : "text-white"}`, children: [
            r,
            "x"
          ] }, r)) })
        ] }) };
      case "download":
        return { label: "Download", el: /* @__PURE__ */ jsxs("button", { onClick: handleDownload, className: "p-1.5 hover:bg-white/10 rounded flex items-center gap-1", title: "Download", children: [
          /* @__PURE__ */ jsx("svg", { className: `w-5 h-5 ${dlOverlay?.active && !dlOverlay?.completed ? "text-nobuf-primary animate-blink" : "text-white"}`, fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" }) }),
          dlOverlay?.active && !dlOverlay?.completed && /* @__PURE__ */ jsxs("span", { className: "text-xs font-mono text-nobuf-primary", children: [
            Math.round(dlOverlay.percent),
            "%"
          ] })
        ] }) };
      case "settings":
        return { label: "Settings", el: /* @__PURE__ */ jsx("button", { onClick: (e) => {
          e.stopPropagation();
          setSettingsOpen((prev) => !prev);
        }, className: "p-1.5 hover:bg-white/10 rounded text-white", title: "Settings", children: /* @__PURE__ */ jsx("svg", { className: "w-5 h-5", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.6 3.6 0 0112 15.6z" }) }) }) };
      case "pin":
        return showPinButton ? { label: "Pin", el: /* @__PURE__ */ jsx("button", { onClick: () => setControlsPinned((p) => !p), className: `p-1.5 hover:bg-white/10 rounded transition-colors ${controlsPinned ? "text-nobuf-primary" : "text-white/50"}`, title: controlsPinned ? "Unpin controls (auto-hide)" : "Pin controls (always show)", children: /* @__PURE__ */ jsx("svg", { className: "w-4 h-4", fill: "currentColor", viewBox: "0 0 24 24", style: { transform: controlsPinned ? "rotate(0deg)" : "rotate(45deg)", transition: "transform 200ms" }, children: /* @__PURE__ */ jsx("path", { d: "M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" }) }) }) } : { label: "Pin", el: null };
      case "fullscreen":
        return { label: "Fullscreen", el: /* @__PURE__ */ jsx("button", { onClick: fs2, className: "p-1.5 hover:bg-white/10 rounded text-white", title: "Fullscreen (F)", children: /* @__PURE__ */ jsx("svg", { className: "w-5 h-5", fill: "currentColor", viewBox: "0 0 24 24", children: fs ? /* @__PURE__ */ jsx("path", { d: "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" }) : /* @__PURE__ */ jsx("path", { d: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" }) }) }) };
      default:
        return { label: id, el: null };
    }
  };
  const renderChip = (id) => {
    if (id === TRAY) return renderTray();
    const { el, label } = chipButton(id);
    if (!el) return null;
    return /* @__PURE__ */ jsx(
      "div",
      {
        draggable: true,
        onDragStart: (e) => {
          markDragStart();
          setDragChip(id);
          setDragKind("chip");
          if (barLayout.tray.includes(id)) setTimeout(() => setTrayOpen(false), 0);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", id);
        },
        onDragEnd: () => {
          markDragEnd();
          setDragChip(null);
          setDragKind(null);
          setDropSide(null);
          setDropIndex(null);
        },
        title: `${label} \u2014 drag to move`,
        "data-chip-id": id,
        className: `transition-all duration-150 cursor-grab active:cursor-grabbing ${dragChip === id ? "opacity-30 scale-90" : "opacity-100 hover:-translate-y-0.5"}`,
        children: el
      },
      id
    );
  };
  const insertBar = (key) => /* @__PURE__ */ jsx("div", { className: "w-0.5 h-6 rounded-full bg-nobuf-primary shadow-[0_0_8px_rgba(29,252,159,0.8)] animate-[barPulse_0.8s_ease-in-out_infinite]" }, key);
  const renderZone = (side) => {
    const ids = barLayout[side];
    let showBar = dragKind === "chip" && dropSide === side && dropIndex != null;
    if (showBar && dragChip) {
      const cur = ids.indexOf(dragChip);
      if (cur !== -1 && (dropIndex === cur || dropIndex === cur + 1)) showBar = false;
    }
    const out = [];
    ids.forEach((id, i) => {
      if (showBar && dropIndex === i) out.push(insertBar(`bar-${side}`));
      out.push(renderChip(id));
    });
    if (showBar && dropIndex >= ids.length) out.push(insertBar(`bar-${side}-end`));
    return /* @__PURE__ */ jsx("span", { "data-chip-zone": side, className: "flex items-center gap-1", children: out });
  };
  const traySide = barLayout.left.includes(TRAY) ? "left" : "right";
  const renderTray = () => /* @__PURE__ */ jsxs(
    "div",
    {
      "data-chip-id": TRAY,
      "data-tray-root": true,
      className: `relative transition-all duration-150 ${dragChip === TRAY ? "opacity-30 scale-90" : "opacity-100"}`,
      children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            draggable: true,
            onDragStart: (e) => {
              markDragStart();
              setDragChip(TRAY);
              setDragKind("chip");
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", TRAY);
              setTrayOpen(false);
            },
            onDragEnd: () => {
              markDragEnd();
              setDragChip(null);
              setDragKind(null);
              setDropSide(null);
              setDropIndex(null);
            },
            onClick: () => setTrayOpen((o) => !o),
            onDragOver: (e) => {
              if (dragKind === "chip" && dragChip !== TRAY) {
                e.preventDefault();
                e.stopPropagation();
                setDropSide("tray");
                setTrayOpen(true);
              }
            },
            onDrop: (e) => {
              if (dragKind === "chip" && dragChip !== TRAY) {
                e.preventDefault();
                e.stopPropagation();
                onTrayDrop();
              }
            },
            title: "Customize controls \u2014 drag icons out to the bar, or drag me to reposition",
            className: `p-1.5 rounded transition-all duration-150 cursor-grab active:cursor-grabbing ${trayOpen || dropSide === "tray" ? "bg-white/15 text-nobuf-primary" : "hover:bg-white/10 text-white hover:-translate-y-0.5"}`,
            children: /* @__PURE__ */ jsxs("svg", { className: "w-6 h-6", fill: "currentColor", viewBox: "0 0 24 24", children: [
              /* @__PURE__ */ jsx("circle", { cx: "5", cy: "12", r: "2" }),
              /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "2" }),
              /* @__PURE__ */ jsx("circle", { cx: "19", cy: "12", r: "2" })
            ] })
          }
        ),
        trayOpen && /* @__PURE__ */ jsxs(
          "div",
          {
            onClick: (e) => e.stopPropagation(),
            onDragOver: (e) => {
              if (dragKind === "chip" && dragChip !== TRAY && !barLayout.tray.includes(dragChip)) {
                e.preventDefault();
                e.stopPropagation();
                setDropSide("tray");
              }
            },
            onDrop: (e) => {
              if (dragKind === "chip" && dragChip !== TRAY && !barLayout.tray.includes(dragChip)) {
                e.preventDefault();
                e.stopPropagation();
                onTrayDrop();
              }
            },
            className: `absolute bottom-full ${traySide === "right" ? "right-0" : "left-0"} mb-0.5 p-2 rounded-xl bg-black/95 border backdrop-blur-xl shadow-2xl z-50 transition-colors ${dropSide === "tray" ? "border-nobuf-primary/60 ring-1 ring-nobuf-primary/40" : "border-white/10"}`,
            children: [
              /* @__PURE__ */ jsx("div", { className: "text-[10px] uppercase tracking-wider text-white/40 px-1 pb-1.5 whitespace-nowrap", children: "Drag to the bar \xB7 drop here to park" }),
              /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-1 max-w-[220px] min-w-[120px]", children: [
                barLayout.tray.map((id) => renderChip(id)),
                barLayout.tray.length === 0 && /* @__PURE__ */ jsx("span", { className: "text-white/30 text-xs px-1 py-2", children: "Empty \u2014 drag icons here to park them." })
              ] })
            ]
          }
        )
      ]
    },
    TRAY
  );
  return /* @__PURE__ */ jsxs(
    "div",
    {
      ref: boxRef,
      className: "fixed inset-0 z-50 bg-black flex flex-col select-none",
      onDragOver: (e) => {
        if (dragKind) e.preventDefault();
      },
      onDrop: (e) => {
        if (dragKind) {
          e.preventDefault();
          setDragChip(null);
          setDragKind(null);
          setDropSide(null);
          setDropIndex(null);
        }
      },
      children: [
        /* @__PURE__ */ jsx(
          "input",
          {
            ref: subFileInputRef,
            type: "file",
            accept: ".srt,.vtt,.ass,.ssa",
            className: "hidden",
            onChange: (e) => {
              loadSubFile(e.target.files);
              e.target.value = "";
            }
          }
        ),
        /* @__PURE__ */ jsxs("div", { className: "flex-1 flex items-center justify-center min-h-0 relative cursor-pointer", onClick: toggle, onDoubleClick: fs2, children: [
          err ? /* @__PURE__ */ jsxs("div", { className: "text-center px-8", children: [
            /* @__PURE__ */ jsx("div", { className: "text-amber-400 text-lg mb-2", children: err }),
            playerUnsupportedCodec ? /* @__PURE__ */ jsxs("div", { className: "flex gap-3 justify-center", children: [
              /* @__PURE__ */ jsx("button", { onClick: handleDownload, className: "px-4 py-2 bg-nobuf-primary/15 hover:bg-nobuf-primary/25 text-nobuf-primary rounded-lg transition-colors", children: "Download Video" }),
              /* @__PURE__ */ jsx("button", { onClick: handleClose, className: "px-4 py-2 bg-white/10 hover:bg-white/20 text-nobuf-subtext rounded-lg transition-colors", children: "Close" })
            ] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
              /* @__PURE__ */ jsx("div", { className: "text-gray-500 text-xs break-all max-w-md mb-4", children: lastVideoSrc || streamUrl }),
              /* @__PURE__ */ jsx("button", { onClick: handleClose, className: "px-4 py-2 bg-nobuf-primary/15 hover:bg-nobuf-primary/25 text-nobuf-primary rounded-lg transition-colors", children: "Close" })
            ] })
          ] }) : /* @__PURE__ */ jsx(
            "video",
            {
              ref: vidRef,
              className: "w-full h-full",
              playsInline: true,
              style: {
                objectFit: settings.playerVideoFit === "original" ? "none" : settings.playerVideoFit,
                filter: `brightness(${brightness})`,
                transform: rotation ? `rotate(${rotation}deg)` : void 0
              }
            }
          ),
          !err && /* @__PURE__ */ jsx(SubtitleOverlay, { vidRef, activeTracks: subs.activeTracks, currentTime: time }),
          load && !err && /* @__PURE__ */ jsx("div", { className: "absolute inset-0 flex items-center justify-center pointer-events-none", children: /* @__PURE__ */ jsx("div", { className: "w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" }) }),
          (showColdStartOverlay || isRemuxLoading) && !err && /* @__PURE__ */ jsx("div", { className: `absolute inset-x-0 top-0 bottom-16 flex items-center justify-center z-30 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${isColdStartBuffering || isRemuxLoading ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`, children: /* @__PURE__ */ jsxs("div", { className: "flex flex-col items-center gap-4 max-w-md px-6", children: [
            /* @__PURE__ */ jsxs("div", { className: "relative w-16 h-16", children: [
              /* @__PURE__ */ jsx("div", { className: "absolute inset-0 border-4 border-nobuf-primary/20 rounded-full" }),
              /* @__PURE__ */ jsx("div", { className: "absolute inset-0 border-4 border-transparent border-t-nobuf-primary rounded-full animate-spin" }),
              /* @__PURE__ */ jsx("div", { className: "absolute inset-0 flex items-center justify-center", children: /* @__PURE__ */ jsx("span", { className: "text-nobuf-primary text-xs font-bold uppercase tracking-wider", children: detectedFormat === "ts" ? "TS" : detectedFormat === "mp4" ? "MP4" : detectedFormat === "mkv" ? "MKV" : "" }) })
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "text-center", children: [
              /* @__PURE__ */ jsx("div", { className: "text-white text-lg font-semibold mb-1", children: coldStartPhase === "fetching_metadata" ? "Reading video metadata" : coldStartPhase === "buffering" ? "Optimizing for smooth playback" : coldStartPhase === "initializing_player" ? "Preparing video stream" : "Preparing video" }),
              /* @__PURE__ */ jsx("div", { className: "text-white/50 text-sm", children: coldStartPhase === "fetching_metadata" ? "Locating video structure for instant start" : coldStartPhase === "buffering" ? "Pre-loading data to prevent buffering" : coldStartPhase === "initializing_player" ? "Converting format for seamless playback" : "Ensuring buffer-free experience" })
            ] }),
            coldStartProgress.targetBytes > 0 && coldStartPhase === "buffering" && /* @__PURE__ */ jsxs(Fragment, { children: [
              /* @__PURE__ */ jsxs("div", { className: "text-white/60 text-sm font-mono", children: [
                formatBytes(coldStartProgress.bytes),
                " / ",
                formatBytes(coldStartProgress.targetBytes)
              ] }),
              /* @__PURE__ */ jsx("div", { className: "w-64 h-1.5 bg-white/10 rounded-full overflow-hidden", children: /* @__PURE__ */ jsx(
                "div",
                {
                  className: "h-full bg-gradient-to-r from-nobuf-primary to-nobuf-primary/70 rounded-full transition-all duration-300 ease-out",
                  style: { width: `${Math.min(100, coldStartProgress.bytes / coldStartProgress.targetBytes * 100)}%` }
                }
              ) })
            ] }),
            (coldStartPhase === "fetching_metadata" || coldStartPhase === "initializing_player") && /* @__PURE__ */ jsx("div", { className: "w-64 h-1.5 bg-white/10 rounded-full overflow-hidden", children: /* @__PURE__ */ jsx("div", { className: "h-full w-1/3 bg-gradient-to-r from-transparent via-nobuf-primary to-transparent rounded-full animate-[shimmer_1.5s_ease-in-out_infinite]" }) })
          ] }) })
        ] }),
        miniBarVisible && !err && dur > 0 && /* @__PURE__ */ jsxs("div", { className: "absolute bottom-[2px] left-0 right-0 z-40 pointer-events-none transition-opacity duration-300", children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-end gap-1 px-2 pb-0.5", children: [
            !prefetchComplete && /* @__PURE__ */ jsx(
              "button",
              {
                onClick: (e) => {
                  e.stopPropagation();
                  prefetchPaused ? resumePrefetch() : pausePrefetch();
                },
                className: "pointer-events-auto hover:bg-white/10 rounded p-0.5",
                title: prefetchPaused ? "Resume buffering" : "Pause buffering",
                children: prefetchPaused ? /* @__PURE__ */ jsx("svg", { className: "w-3 h-3 text-white/60", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M8 5v14l11-7z" }) }) : /* @__PURE__ */ jsx("svg", { className: "w-3 h-3 text-white/60", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M6 4h4v16H6V4zm8 0h4v16h-4V4z" }) })
              }
            ),
            /* @__PURE__ */ jsx("span", { className: "text-[10px] font-mono text-white/60 bg-black/40 px-1.5 py-0.5 rounded", children: greenBarSpeed > 0 ? formatSpeed(greenBarSpeed) : "\u2014" })
          ] }),
          /* @__PURE__ */ jsx("div", { className: "relative h-[2px] bg-white/20", children: /* @__PURE__ */ jsx("div", { className: "absolute inset-y-0 left-0 bg-red-500 rounded-full", style: { width: `${pct}%` } }) })
        ] }),
        /* @__PURE__ */ jsxs(
          "div",
          {
            ref: controlsRef,
            "data-controls-root": true,
            className: `absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent pt-16 pb-2 px-3 ${vis ? "" : "pointer-events-none"}`,
            style: {
              opacity: vis ? 1 : 0,
              transform: vis ? "translateY(0)" : "translateY(20px)",
              transition: "opacity 300ms ease-out, transform 300ms ease-out"
            },
            children: [
              /* @__PURE__ */ jsxs(
                "div",
                {
                  ref: barRef,
                  className: "relative cursor-pointer group mb-1 mx-1 py-3",
                  onClick: onBarClick,
                  onMouseMove: onBarMove,
                  onMouseLeave: () => {
                    setTip((p) => ({ ...p, show: false }));
                    clearTimeout(hoverDebounceRef.current);
                    clearDesiredHover();
                    setThumbLoading(false);
                    setThumbUrl(null);
                    lastThumbTimeRef.current = -1;
                  },
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "relative h-4 bg-white/20 rounded-full group-hover:h-5 transition-all", children: [
                      bufferedRanges.length > 0 && dur > 0 && (() => {
                        return bufferedRanges.map(([ts, te], i) => {
                          const leftPct = ts / dur * 100;
                          const widthPct = (te - ts) / dur * 100;
                          return /* @__PURE__ */ jsx(
                            "div",
                            {
                              className: "absolute inset-y-0 bg-white/40 rounded-full z-0",
                              style: { left: `${leftPct}%`, width: `${Math.max(widthPct, 0.15)}%` }
                            },
                            `mem-${i}`
                          );
                        });
                      })(),
                      /* @__PURE__ */ jsx("div", { className: "absolute inset-y-0 left-0 bg-red-500 rounded-full z-10", style: { width: `${pct}%` } }),
                      cachedTimeRanges.length > 0 && dur > 0 && (() => {
                        const sorted = [...cachedTimeRanges].sort((a, b) => a[0] - b[0]);
                        const merged = [];
                        for (const r of sorted) {
                          if (merged.length === 0 || r[0] > merged[merged.length - 1][1] + 0.01) {
                            merged.push([r[0], r[1]]);
                          } else {
                            merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
                          }
                        }
                        return merged.map(([ts, te], i) => {
                          const leftPct = ts / dur * 100;
                          const widthPct = (te - ts) / dur * 100;
                          return /* @__PURE__ */ jsx(
                            "div",
                            {
                              className: "absolute bottom-0 h-[3px] bg-green-400/70 rounded-full z-20",
                              style: { left: `${leftPct}%`, width: `${Math.max(widthPct, 0.2)}%` }
                            },
                            `cache-${i}`
                          );
                        });
                      })(),
                      cachedTimes.size > 0 && dur > 0 && (() => {
                        const sorted = Array.from(cachedTimes).sort((a, b) => a - b);
                        const segments = [];
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
                          const leftPct = seg.start / dur * 100;
                          const widthPct = (seg.end - seg.start + 2) / dur * 100;
                          return /* @__PURE__ */ jsx(
                            "div",
                            {
                              className: "absolute top-0 h-[3px] bg-yellow-400/70 rounded-full z-30",
                              style: { left: `${leftPct}%`, width: `${Math.max(widthPct, 0.2)}%` }
                            },
                            i
                          );
                        });
                      })()
                    ] }),
                    tip.show && (() => {
                      const barWidth = barRef.current?.getBoundingClientRect().width ?? 0;
                      const tooltipHalf = 120;
                      const clampedX = Math.max(tooltipHalf, Math.min(tip.x, barWidth - tooltipHalf));
                      return /* @__PURE__ */ jsxs("div", { className: "absolute pointer-events-none flex flex-col items-center", style: { left: clampedX, bottom: "100%", marginBottom: "8px", transform: "translateX(-50%)" }, children: [
                        thumbUrl ? /* @__PURE__ */ jsx(
                          "img",
                          {
                            src: thumbUrl,
                            className: "rounded overflow-hidden border border-white/20 mb-1 shadow-lg",
                            style: { width: 228, height: 128, objectFit: "cover" },
                            alt: ""
                          }
                        ) : thumbLoading ? /* @__PURE__ */ jsx("div", { className: "w-[228px] h-[128px] rounded border border-white/20 mb-1 bg-white/5 flex items-center justify-center", children: /* @__PURE__ */ jsx("div", { className: "w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" }) }) : null,
                        /* @__PURE__ */ jsx("div", { className: "px-2 py-0.5 bg-black/80 text-white text-xs rounded whitespace-nowrap font-mono", children: fmt(tip.t) })
                      ] });
                    })()
                  ]
                }
              ),
              /* @__PURE__ */ jsxs(
                "div",
                {
                  className: "flex items-center justify-between relative",
                  onDragOver: (e) => {
                    if (dragKind) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const s = sideFromX(e.clientX);
                      setDropSide(s);
                      setDropIndex(dragKind === "chip" ? indexFromX(s, e.clientX) : null);
                    }
                  },
                  onDrop: onRowDrop,
                  children: [
                    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1 relative z-10", children: [
                      /* @__PURE__ */ jsx("button", { onClick: toggle, className: "p-1 hover:bg-white/10 rounded text-white transition-transform active:scale-90 flex items-center justify-center", title: "Play/Pause (Space)", children: /* @__PURE__ */ jsx("svg", { className: "w-7 h-7 block", fill: "currentColor", viewBox: "0 0 24 24", children: playing ? /* @__PURE__ */ jsx("path", { d: "M8 5a1.5 1.5 0 013 0v14a1.5 1.5 0 01-3 0V5zm5 0a1.5 1.5 0 013 0v14a1.5 1.5 0 01-3 0V5z" }) : /* @__PURE__ */ jsx("path", { d: "M7 5.27v13.46c0 .79.87 1.27 1.54.84l10.58-6.73a1 1 0 000-1.68L8.54 4.43C7.87 4 7 4.48 7 5.27z" }) }) }),
                      renderZone("left"),
                      /* @__PURE__ */ jsxs("div", { className: "flex items-center group", children: [
                        /* @__PURE__ */ jsxs("span", { className: "text-white/70 text-xs font-mono tabular-nums leading-none w-8 text-right mr-0.5", children: [
                          muted ? 0 : Math.round(vol * 100),
                          "%"
                        ] }),
                        /* @__PURE__ */ jsx("button", { onClick: mute, className: "p-1.5 hover:bg-white/10 rounded text-white", title: "Mute (M)", children: /* @__PURE__ */ jsx("svg", { className: "w-5 h-5", fill: "currentColor", viewBox: "0 0 24 24", children: muted || vol === 0 ? /* @__PURE__ */ jsx("path", { d: "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" }) : vol < 0.5 ? /* @__PURE__ */ jsx("path", { d: "M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" }) : /* @__PURE__ */ jsx("path", { d: "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" }) }) }),
                        /* @__PURE__ */ jsx("input", { type: "range", min: "0", max: "1", step: "0.01", value: muted ? 0 : vol, onChange: (e) => setVol2(parseFloat(e.target.value)), className: "w-0 group-hover:w-20 transition-all opacity-0 group-hover:opacity-100 accent-white" })
                      ] }),
                      /* @__PURE__ */ jsxs("span", { className: "text-white text-xs font-mono leading-none ml-1", children: [
                        fmt(time),
                        " / ",
                        fmt(dur)
                      ] })
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1 relative z-10", children: [
                      (() => {
                        const vid = vidRef.current;
                        const curTime = vid?.currentTime ?? 0;
                        let sbAhead = 0;
                        if (vid?.buffered && vid.buffered.length > 0) {
                          for (let i = 0; i < vid.buffered.length; i++) {
                            if (vid.buffered.end(i) > curTime) {
                              sbAhead += vid.buffered.end(i) - Math.max(vid.buffered.start(i), curTime);
                            }
                          }
                        }
                        let cacheAhead = 0;
                        if (cachedTimeRanges.length > 0 && dur > 0) {
                          for (const [s, e] of cachedTimeRanges) {
                            if (e > curTime) {
                              cacheAhead += e - Math.max(s, curTime);
                            }
                          }
                        }
                        cacheAhead = Math.max(0, cacheAhead - sbAhead);
                        const totalAhead = sbAhead + cacheAhead;
                        const healthColor = totalAhead > 300 ? "text-green-400" : totalAhead > 60 ? "text-yellow-400" : totalAhead > 10 ? "text-orange-400" : "text-red-400";
                        return /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1.5 px-2 py-1 bg-white/5 rounded-lg border border-white/10", children: [
                          /* @__PURE__ */ jsx(
                            "button",
                            {
                              onClick: (e) => {
                                e.stopPropagation();
                                prefetchPaused ? resumePrefetch() : pausePrefetch();
                              },
                              className: `hover:bg-white/10 rounded p-0.5 ${prefetchComplete ? "cursor-default" : ""}`,
                              disabled: prefetchComplete,
                              title: prefetchComplete ? "Buffering complete" : prefetchPaused ? "Resume buffering" : "Pause buffering",
                              children: prefetchComplete ? /* @__PURE__ */ jsx("svg", { className: "w-3.5 h-3.5 text-green-400", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" }) }) : prefetchPaused ? /* @__PURE__ */ jsx("svg", { className: "w-3.5 h-3.5 text-white/70", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M8 5v14l11-7z" }) }) : /* @__PURE__ */ jsx("svg", { className: "w-3.5 h-3.5 text-white/70", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M6 4h4v16H6V4zm8 0h4v16h-4V4z" }) })
                            }
                          ),
                          /* @__PURE__ */ jsx("span", { className: "text-xs font-mono text-white/60", title: "Download speed from Telegram", children: greenBarSpeed > 0 ? formatSpeed(greenBarSpeed) : "\u2014" }),
                          /* @__PURE__ */ jsx("span", { className: `text-xs font-mono ${healthColor}`, title: `SourceBuffer: ${sbAhead.toFixed(0)}s ahead
Disk cache: +${cacheAhead.toFixed(0)}s ahead`, children: totalAhead >= 60 ? `${(totalAhead / 60).toFixed(1)}m` : `${totalAhead.toFixed(0)}s` })
                        ] });
                      })(),
                      settings.prebufferSpeedLimit > 0 && /* @__PURE__ */ jsxs(
                        "button",
                        {
                          onClick: (e) => {
                            e.stopPropagation();
                            setSettingsOpen((prev) => !prev);
                          },
                          className: "p-1.5 hover:bg-white/10 rounded flex items-center gap-0.5",
                          title: `Prebuffer limited to ${formatSpeedLimit(settings.prebufferSpeedLimit)}`,
                          children: [
                            /* @__PURE__ */ jsx("svg", { className: "w-3.5 h-3.5 text-green-400", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" }) }),
                            /* @__PURE__ */ jsx("span", { className: "text-xs font-mono text-green-400", children: formatSpeedLimitCompact(settings.prebufferSpeedLimit) })
                          ]
                        }
                      ),
                      settings.downloadSpeedLimit > 0 && /* @__PURE__ */ jsxs(
                        "button",
                        {
                          onClick: (e) => {
                            e.stopPropagation();
                            setSettingsOpen((prev) => !prev);
                          },
                          className: "p-1.5 hover:bg-white/10 rounded flex items-center gap-0.5",
                          title: `Download limited to ${formatSpeedLimit(settings.downloadSpeedLimit)}`,
                          children: [
                            /* @__PURE__ */ jsx("svg", { className: "w-3.5 h-3.5 text-nobuf-primary", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" }) }),
                            /* @__PURE__ */ jsx("span", { className: "text-xs font-mono text-nobuf-primary", children: formatSpeedLimitCompact(settings.downloadSpeedLimit) })
                          ]
                        }
                      ),
                      renderZone("right"),
                      /* @__PURE__ */ jsx("button", { onClick: handleClose, className: "p-1 rounded text-red-500 hover:text-red-400 hover:bg-red-500/15 transition-transform active:scale-90 flex items-center justify-center", title: "Close (Esc)", children: /* @__PURE__ */ jsx("svg", { className: "w-7 h-7 block", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M6 6l12 12M18 6L6 18" }) }) })
                    ] })
                  ]
                }
              )
            ]
          }
        ),
        settingsOpen && /* @__PURE__ */ jsxs(
          "div",
          {
            className: "absolute right-0 top-0 bottom-0 z-30 bg-gradient-to-b from-black/80 to-black/70 backdrop-blur-2xl border-l border-white/10 overflow-y-auto shadow-2xl shadow-black/50 animate-[settingsIn_180ms_ease-out]",
            onClick: (e) => e.stopPropagation(),
            style: { width: panelDragWidth ?? settings.playerSettingsWidth, maxWidth: "70%", scrollbarWidth: "thin", transition: panelDragWidth == null ? "width 120ms ease" : "none" },
            children: [
              /* @__PURE__ */ jsx("style", { children: `@keyframes settingsIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:translateX(0)}}` }),
              /* @__PURE__ */ jsx(
                "div",
                {
                  onMouseDown: startPanelResize,
                  onDoubleClick: () => updateSetting("playerSettingsWidth", 336),
                  className: "absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize group z-20 hover:bg-nobuf-primary/20 active:bg-nobuf-primary/30 transition-colors",
                  title: "Drag to resize \xB7 double-click to reset",
                  children: /* @__PURE__ */ jsx("div", { className: "absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-10 rounded-full bg-white/20 group-hover:bg-nobuf-primary/70 transition-colors" })
                }
              ),
              /* @__PURE__ */ jsxs("div", { className: "sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/40 backdrop-blur-xl", children: [
                /* @__PURE__ */ jsxs("span", { className: "text-white text-sm font-semibold tracking-wide flex items-center gap-2", children: [
                  /* @__PURE__ */ jsxs("svg", { className: "w-4 h-4 text-nobuf-primary", fill: "none", stroke: "currentColor", strokeWidth: "2", viewBox: "0 0 24 24", children: [
                    /* @__PURE__ */ jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" }),
                    /* @__PURE__ */ jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M15 12a3 3 0 11-6 0 3 3 0 016 0z" })
                  ] }),
                  "Settings"
                ] }),
                /* @__PURE__ */ jsx("button", { onClick: () => setSettingsOpen(false), className: "p-1 hover:bg-white/10 rounded-md text-nobuf-subtext hover:text-nobuf-primary transition-colors", title: "Close settings", children: /* @__PURE__ */ jsx("svg", { className: "w-4 h-4", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" }) }) })
              ] }),
              /* @__PURE__ */ jsxs(SettingsSection, { title: "Playback", icon: /* @__PURE__ */ jsx("svg", { className: "w-3 h-3", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M8 5v14l11-7z" }) }), children: [
                /* @__PURE__ */ jsx(SettingRow, { label: "Skip forward", stack: true, children: /* @__PURE__ */ jsxs("div", { className: "flex gap-1 items-center", children: [
                  [5, 10, 15, 30].map((s) => /* @__PURE__ */ jsx(Chip, { active: settings.playerSkipForward === s, onClick: () => updateSetting("playerSkipForward", s), children: /* @__PURE__ */ jsxs("span", { className: "font-mono", children: [
                    s,
                    "s"
                  ] }) }, s)),
                  /* @__PURE__ */ jsx(
                    NumInput,
                    {
                      value: settings.playerSkipForward,
                      title: "Custom seconds (1-60)",
                      onChange: (v) => updateSetting("playerSkipForward", Math.max(1, Math.min(60, parseInt(v) || 1)))
                    }
                  )
                ] }) }),
                /* @__PURE__ */ jsx(SettingRow, { label: "Skip backward", stack: true, children: /* @__PURE__ */ jsxs("div", { className: "flex gap-1 items-center", children: [
                  [5, 10, 15, 30].map((s) => /* @__PURE__ */ jsx(Chip, { active: settings.playerSkipBackward === s, onClick: () => updateSetting("playerSkipBackward", s), children: /* @__PURE__ */ jsxs("span", { className: "font-mono", children: [
                    s,
                    "s"
                  ] }) }, s)),
                  /* @__PURE__ */ jsx(
                    NumInput,
                    {
                      value: settings.playerSkipBackward,
                      title: "Custom seconds (1-60)",
                      onChange: (v) => updateSetting("playerSkipBackward", Math.max(1, Math.min(60, parseInt(v) || 1)))
                    }
                  )
                ] }) })
              ] }),
              /* @__PURE__ */ jsxs(SettingsSection, { title: "Display", icon: /* @__PURE__ */ jsx("svg", { className: "w-3 h-3", fill: "none", stroke: "currentColor", strokeWidth: "2", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("rect", { x: "3", y: "5", width: "18", height: "14", rx: "2" }) }), children: [
                /* @__PURE__ */ jsx(SettingRow, { label: "Video fit", stack: true, children: /* @__PURE__ */ jsx("div", { className: "flex gap-1", children: [["original", "Original"], ["contain", "Fit"], ["fill", "Fill"]].map(([val, label]) => /* @__PURE__ */ jsx(Chip, { active: settings.playerVideoFit === val, onClick: () => updateSetting("playerVideoFit", val), children: label }, val)) }) }),
                /* @__PURE__ */ jsx(SettingRow, { label: "Rotation", stack: true, children: /* @__PURE__ */ jsx("div", { className: "flex gap-1", children: [0, 90, 180, 270].map((r) => /* @__PURE__ */ jsx(Chip, { active: rotation === r, onClick: () => setRotation(r), children: /* @__PURE__ */ jsxs("span", { className: "font-mono", children: [
                  r,
                  "\xB0"
                ] }) }, r)) }) }),
                /* @__PURE__ */ jsx(SettingRow, { label: "Brightness", stack: true, children: /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2.5", children: [
                  /* @__PURE__ */ jsx(
                    "input",
                    {
                      type: "range",
                      min: "0.5",
                      max: "2",
                      step: "0.1",
                      value: brightness,
                      onChange: (e) => setBrightness(parseFloat(e.target.value)),
                      className: "flex-1 accent-nobuf-primary h-1"
                    }
                  ),
                  /* @__PURE__ */ jsx("span", { className: "text-white/60 text-xs font-mono w-7 text-right tabular-nums", children: brightness.toFixed(1) })
                ] }) })
              ] }),
              /* @__PURE__ */ jsx(SettingsSection, { title: "Behavior", icon: /* @__PURE__ */ jsx("svg", { className: "w-3 h-3", fill: "none", stroke: "currentColor", strokeWidth: "2", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M13 10V3L4 14h7v7l9-11h-7z" }) }), children: /* @__PURE__ */ jsx(SettingRow, { label: "Show pin button", hint: "Adds a pin toggle to the control bar. When off, controls stay visible.", children: /* @__PURE__ */ jsx(
                Switch,
                {
                  on: settings.playerShowPinButton,
                  onClick: () => updateSetting("playerShowPinButton", !settings.playerShowPinButton),
                  title: settings.playerShowPinButton ? "Hide pin button" : "Show pin button"
                }
              ) }) }),
              /* @__PURE__ */ jsxs(SettingsSection, { title: "Bandwidth", icon: /* @__PURE__ */ jsxs("span", { className: "flex items-center gap-0.5", children: [
                /* @__PURE__ */ jsx("span", { className: "inline-block w-1.5 h-1.5 rounded-full bg-green-400" }),
                /* @__PURE__ */ jsx("span", { className: "inline-block w-1.5 h-1.5 rounded-full bg-nobuf-primary" })
              ] }), children: [
                /* @__PURE__ */ jsxs(SettingRow, { stack: true, label: "Prebuffer speed", children: [
                  /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-1 items-center", children: [
                    SPEED_LIMIT_PRESETS.map((p) => /* @__PURE__ */ jsx(
                      Chip,
                      {
                        tone: "green",
                        active: settings.prebufferSpeedLimit === p.value,
                        onClick: () => {
                          updateSetting("prebufferSpeedLimit", p.value);
                          setCustomPrebufferValue("");
                        },
                        children: p.label
                      },
                      p.value
                    )),
                    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1", children: [
                      /* @__PURE__ */ jsx(
                        "input",
                        {
                          type: "number",
                          min: "1",
                          max: "102400",
                          placeholder: "Custom",
                          value: customPrebufferValue,
                          onChange: (e) => {
                            const raw = e.target.value;
                            setCustomPrebufferValue(raw);
                            if (raw && Number(raw) > 0) {
                              const kb = customPrebufferUnit === "mb" ? Number(raw) * 1024 : Number(raw);
                              updateSetting("prebufferSpeedLimit", Math.min(Math.max(kb, 1), 102400));
                            }
                          },
                          className: "w-16 px-1.5 py-1 rounded-md text-xs font-mono bg-white/[0.07] text-white/80 border border-white/10 focus:border-green-400 focus:outline-none text-center"
                        }
                      ),
                      /* @__PURE__ */ jsx(UnitToggle, { unit: customPrebufferUnit, tone: "green", onChange: (unit) => {
                        setCustomPrebufferUnit(unit);
                        if (customPrebufferValue && Number(customPrebufferValue) > 0) {
                          const kb = unit === "mb" ? Number(customPrebufferValue) * 1024 : Number(customPrebufferValue);
                          updateSetting("prebufferSpeedLimit", Math.min(Math.max(kb, 1), 102400));
                        }
                      } })
                    ] })
                  ] }),
                  settings.prebufferSpeedLimit > 0 && /* @__PURE__ */ jsxs("div", { className: "mt-2 inline-flex items-center gap-1 text-[10px] text-green-300/80 bg-green-500/10 px-2 py-0.5 rounded", children: [
                    /* @__PURE__ */ jsx("span", { className: "inline-block w-1 h-1 rounded-full bg-green-400" }),
                    "Active: ",
                    formatSpeedLimit(settings.prebufferSpeedLimit)
                  ] })
                ] }),
                /* @__PURE__ */ jsxs(SettingRow, { stack: true, label: "Download speed", children: [
                  /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-1 items-center", children: [
                    SPEED_LIMIT_PRESETS.map((p) => /* @__PURE__ */ jsx(
                      Chip,
                      {
                        tone: "primary",
                        active: settings.downloadSpeedLimit === p.value,
                        onClick: () => {
                          updateSetting("downloadSpeedLimit", p.value);
                          setCustomDownloadValue("");
                        },
                        children: p.label
                      },
                      p.value
                    )),
                    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1", children: [
                      /* @__PURE__ */ jsx(
                        "input",
                        {
                          type: "number",
                          min: "1",
                          max: "102400",
                          placeholder: "Custom",
                          value: customDownloadValue,
                          onChange: (e) => {
                            const raw = e.target.value;
                            setCustomDownloadValue(raw);
                            if (raw && Number(raw) > 0) {
                              const kb = customDownloadUnit === "mb" ? Number(raw) * 1024 : Number(raw);
                              updateSetting("downloadSpeedLimit", Math.min(Math.max(kb, 1), 102400));
                            }
                          },
                          className: "w-16 px-1.5 py-1 rounded-md text-xs font-mono bg-white/[0.07] text-white/80 border border-white/10 focus:border-nobuf-primary focus:outline-none text-center"
                        }
                      ),
                      /* @__PURE__ */ jsx(UnitToggle, { unit: customDownloadUnit, tone: "primary", onChange: (unit) => {
                        setCustomDownloadUnit(unit);
                        if (customDownloadValue && Number(customDownloadValue) > 0) {
                          const kb = unit === "mb" ? Number(customDownloadValue) * 1024 : Number(customDownloadValue);
                          updateSetting("downloadSpeedLimit", Math.min(Math.max(kb, 1), 102400));
                        }
                      } })
                    ] })
                  ] }),
                  settings.downloadSpeedLimit > 0 && /* @__PURE__ */ jsxs("div", { className: "mt-2 inline-flex items-center gap-1 text-[10px] text-nobuf-primary/80 bg-nobuf-primary/10 px-2 py-0.5 rounded", children: [
                    /* @__PURE__ */ jsx("span", { className: "inline-block w-1 h-1 rounded-full bg-nobuf-primary" }),
                    "Active: ",
                    formatSpeedLimit(settings.downloadSpeedLimit)
                  ] })
                ] }),
                settings.prebufferSpeedLimit > 0 && settings.downloadSpeedLimit > 0 && /* @__PURE__ */ jsxs("div", { className: "flex items-start gap-1.5 px-2.5 py-2 rounded-md bg-yellow-500/10 border border-yellow-500/20 text-yellow-300/90 text-[10px] leading-snug", children: [
                  /* @__PURE__ */ jsx("svg", { className: "w-3 h-3 mt-0.5 shrink-0", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" }) }),
                  /* @__PURE__ */ jsx("span", { children: "Both limits share 1 Telegram connection \u2014 speeds may not reach their full ceiling simultaneously." })
                ] })
              ] }),
              /* @__PURE__ */ jsx(SettingsSection, { title: "Video info", icon: /* @__PURE__ */ jsxs("svg", { className: "w-3 h-3", fill: "none", stroke: "currentColor", strokeWidth: "2", viewBox: "0 0 24 24", children: [
                /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "9" }),
                /* @__PURE__ */ jsx("path", { strokeLinecap: "round", d: "M12 11v5M12 8h.01" })
              ] }), children: /* @__PURE__ */ jsxs("div", { className: "space-y-2 -mt-1", children: [
                videoResolution && /* @__PURE__ */ jsxs("div", { className: "flex justify-between items-center text-xs", children: [
                  /* @__PURE__ */ jsx("span", { className: "text-white/45", children: "Resolution" }),
                  /* @__PURE__ */ jsxs("span", { className: "text-white/85 font-mono", children: [
                    videoResolution.w,
                    "\xD7",
                    videoResolution.h
                  ] })
                ] }),
                dur > 0 && /* @__PURE__ */ jsxs("div", { className: "flex justify-between items-center text-xs", children: [
                  /* @__PURE__ */ jsx("span", { className: "text-white/45", children: "Duration" }),
                  /* @__PURE__ */ jsx("span", { className: "text-white/85 font-mono", children: fmt(dur) })
                ] }),
                totalBytes > 0 && /* @__PURE__ */ jsxs("div", { className: "flex justify-between items-center text-xs", children: [
                  /* @__PURE__ */ jsx("span", { className: "text-white/45", children: "File size" }),
                  /* @__PURE__ */ jsx("span", { className: "text-white/85 font-mono", children: formatBytes(totalBytes) })
                ] }),
                /* @__PURE__ */ jsxs("div", { className: "flex justify-between items-center text-xs", children: [
                  /* @__PURE__ */ jsx("span", { className: "text-white/45", children: "Cache" }),
                  /* @__PURE__ */ jsx("span", { className: `font-mono ${cacheComplete ? "text-green-300" : "text-white/85"}`, children: cacheComplete ? "Complete \u2713" : cachePercent > 0 ? `${cachePercent}%` : "None" })
                ] })
              ] }) })
            ]
          }
        ),
        /* @__PURE__ */ jsx("div", { className: `absolute top-3 left-3 right-3 text-white text-sm truncate transition-opacity duration-300 ${vis ? "opacity-100" : "opacity-0"}`, style: { textShadow: "0 1px 3px rgba(0,0,0,0.5)" }, children: file.name }),
        /* @__PURE__ */ jsx(
          "div",
          {
            className: `absolute left-4 right-4 transition-all duration-300 ease-out ${dlOverlayVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`,
            style: { bottom: dlOverlayVisible ? vis && controlsHeight > 0 ? controlsHeight + 12 : 64 : 64 },
            children: dlOverlay && /* @__PURE__ */ jsxs("div", { className: `flex items-center gap-2 bg-black/40 rounded-lg px-3 py-2 backdrop-blur-sm transition-opacity duration-300 ${dlOverlay.completed ? "opacity-80" : "opacity-100"}`, children: [
              /* @__PURE__ */ jsx("div", { className: "flex-1 bg-white/10 rounded-full h-2 overflow-hidden", children: /* @__PURE__ */ jsx(
                "div",
                {
                  className: `h-full rounded-full transition-all duration-300 ${dlOverlay.completed || dlOverlay.fromCache ? "bg-green-400" : "bg-nobuf-secondary"}`,
                  style: { width: `${dlOverlay.percent}%` }
                }
              ) }),
              /* @__PURE__ */ jsx("span", { className: "text-nobuf-text text-xs font-mono whitespace-nowrap", children: dlOverlay.completed ? "Completed" : dlOverlay.fromCache ? "From cache" : dlOverlay.speed > 0 ? `${formatBytes(dlOverlay.speed)}/s` : "Downloading..." }),
              /* @__PURE__ */ jsx(
                "button",
                {
                  onClick: (e) => {
                    e.stopPropagation();
                    handleCancelDownload();
                  },
                  className: `p-1 hover:bg-white/10 rounded transition-colors flex-shrink-0 ${dlOverlay.completed ? "text-nobuf-subtext/60 hover:text-nobuf-primary" : "text-nobuf-subtext/60 hover:text-red-400"}`,
                  title: dlOverlay.completed ? "Close" : "Cancel download",
                  children: /* @__PURE__ */ jsx("svg", { className: "w-4 h-4", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" }) })
                }
              )
            ] })
          }
        ),
        skipFeedback && (() => {
          const isForward = skipFeedback.direction === "forward";
          const fromTime = Math.max(0, Math.min(skipFeedback.from, dur || skipFeedback.from));
          const toTime = Math.max(0, Math.min(skipFeedback.to, dur || skipFeedback.to));
          const deltaSec = Math.round(Math.abs(skipFeedback.totalDelta));
          const accent = isForward ? "text-nobuf-primary" : "text-white";
          const glow = isForward ? "rgba(29,252,159,0.35)" : "rgba(255,255,255,0.25)";
          return /* @__PURE__ */ jsx("div", { className: `absolute inset-y-0 ${isForward ? "right-0" : "left-0"} w-1/2 flex items-center ${isForward ? "justify-end pr-[8%]" : "justify-start pl-[8%]"} pointer-events-none z-20`, children: /* @__PURE__ */ jsxs(
            "div",
            {
              className: `flex flex-col ${isForward ? "items-end" : "items-start"} gap-1 animate-[skipIn_0.25s_ease-out]`,
              children: [
                /* @__PURE__ */ jsxs("span", { className: `text-4xl font-black font-mono tabular-nums ${accent}`, style: { textShadow: `0 0 16px ${glow}` }, children: [
                  isForward ? "+" : "\u2212",
                  deltaSec,
                  "s"
                ] }),
                /* @__PURE__ */ jsxs("span", { className: "text-white/70 text-lg font-mono tabular-nums", style: { textShadow: "0 2px 8px rgba(0,0,0,0.6)" }, children: [
                  fmt(fromTime),
                  " ",
                  /* @__PURE__ */ jsx("span", { className: accent, children: "\u2192" }),
                  " ",
                  fmt(toTime)
                ] })
              ]
            },
            skipFeedbackKey.current
          ) });
        })(),
        videoEnded && !load && !err && /* @__PURE__ */ jsx("div", { className: "absolute inset-0 flex items-center justify-center pointer-events-none", children: /* @__PURE__ */ jsxs("div", { className: "flex flex-col items-center gap-3", children: [
          /* @__PURE__ */ jsx(
            "button",
            {
              onClick: (e) => {
                e.stopPropagation();
                replay();
              },
              className: "w-20 h-20 bg-white/15 hover:bg-white/25 backdrop-blur-sm rounded-full flex items-center justify-center transition-all duration-200 hover:scale-105 group pointer-events-auto",
              children: /* @__PURE__ */ jsx("svg", { className: "w-10 h-10 text-white group-hover:text-white/90", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" }) })
            }
          ),
          /* @__PURE__ */ jsx("span", { className: "text-white/70 text-sm font-medium tracking-wide", children: "Replay" })
        ] }) }),
        !playing && !videoEnded && !load && !err && /* @__PURE__ */ jsx("div", { className: "absolute inset-0 flex items-center justify-center pointer-events-none", children: /* @__PURE__ */ jsx("div", { className: "w-16 h-16 bg-black/50 rounded-full flex items-center justify-center", children: /* @__PURE__ */ jsx("svg", { className: "w-8 h-8 text-white ml-1", fill: "currentColor", viewBox: "0 0 24 24", children: /* @__PURE__ */ jsx("path", { d: "M8 5v14l11-7z" }) }) }) }),
        showCacheDialog && /* @__PURE__ */ jsx(
          VideoCacheDialog,
          {
            percentage: pendingCachePercent,
            filename: file.name,
            messageId: file.id,
            isAlreadyDownloading: isAlreadyDownloading ?? false,
            onDiscard: handleCacheDiscard,
            onKeepBuffers: handleCacheKeepBuffers,
            onContinueDownload: handleCacheContinueDownload,
            onAlreadyDownloadingClose: handleAlreadyDownloadingClose,
            onCancel: handleCacheDialogCancel
          }
        )
      ]
    }
  );
}
