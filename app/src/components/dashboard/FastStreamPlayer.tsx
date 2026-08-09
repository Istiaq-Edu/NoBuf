import { useEffect, useRef, useState, useCallback, useMemo, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { TelegramFile } from '../../types';
import { isVideoFile } from '../../utils';
import { useMSEPlayer, readPersistedSubTrack, persistSubTrack, shouldReExtractSub, lastCueEnd,
  shouldReportSubFailure,
  mergeCues,
  classifySubRepairOutcome, reduceSubRepairBreaker, shouldAttemptSubRepair,
  emptySubRepairBreakerState, computeSubRepairBackoffMs, resetSubRepairBreakerForSeek,
  SUB_REPAIR_MAX_ATTEMPTS, type SubRepairBreakerState, type SubRepairOutcome } from '../../hooks/useMSEPlayer';
import { pushSample, computeWindowSpeed, speedMeterValue, formatSpeed, type SpeedSample } from '../../lib/faststream/speedMeter';
import { useThumbnailExtractor } from '../../hooks/useThumbnailExtractor';
import { useSettings, SkipDuration, VideoFit, SpeedLimitValue, SPEED_LIMIT_PRESETS, formatSpeedLimit, formatSpeedLimitCompact } from '../../context/SettingsContext';
import { useCacheSession } from '../../context/CacheSessionContext';
import { VideoCacheDialog } from './VideoCacheDialog';
import { useSubtitles } from '../../hooks/useSubtitles';
import { SubtitleOverlay } from './SubtitleOverlay';
import { SubtitleTrack } from '../../lib/faststream/subtitles/SubtitleTrack';

export function subRepairRegionRetryDelay(outcome: SubRepairOutcome): number | null {
  if (outcome === 'progress') return 5_000;
  if (outcome === 'deferred') return 0;
  return null;
}

export function shouldStagePendingPartialSubTrack(
  error: 'empty' | 'empty-partial' | 'failed',
  hasExistingTrack: boolean,
): boolean {
  return error === 'empty-partial' && !hasExistingTrack;
}

interface FastStreamPlayerProps {
  file: TelegramFile;
  streamUrl: string;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  activeFolderId: number | null;
  onContinueToDownload?: (messageId: number, filename: string, folderId: number | null, savePath: string, fromCachePercent: number) => void;
  isAlreadyDownloading?: boolean;
    isPublicChannel?: boolean;
  }

  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

  /** Sort + merge [start,end] time ranges, bridging gaps up to `toleranceS`.
   *  The backend's cached_ranges are contiguous byte runs meeting at byte
   *  boundaries, but byteToTime interpolates piecewise-linearly between sparse
   *  (~8.5s-apart) VBR cue anchors, so two byte-adjacent runs straddling a cue
   *  segment boundary map to time endpoints that differ by a sub-second sliver
   *  — a hairline gap on the green bar. A GENUINE undownloaded gap is at least
   *  one coordinator chunk (~4-8MB ≈ several seconds), so a 1.0s default bridges
   *  rendering artifacts without hiding real gaps. Used by BOTH bar-update paths
   *  so they stay consistent (the download-progress path previously set raw,
   *  unsorted, unmerged ranges → visible gaps). */
  function mergeTimeRanges(ranges: [number, number][], toleranceS = 1.0): [number, number][] {
    if (ranges.length === 0) return [];
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const r of sorted) {
      if (merged.length === 0 || r[0] > merged[merged.length - 1][1] + toleranceS) {
        merged.push([r[0], r[1]]);
      } else {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
      }
    }
    return merged;
  }

  type ChipTone = 'secondary' | 'primary' | 'green';

  function SettingsSection({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
    return (
      <div className="px-4 py-3.5 border-b border-white/[0.06]">
        <h3 className="text-white/40 text-[10px] font-semibold uppercase tracking-[0.14em] mb-3 flex items-center gap-1.5">
          <span className="text-nobuf-primary/70">{icon}</span>{title}
        </h3>
        <div className="space-y-3.5">{children}</div>
      </div>
    );
  }

  function SettingRow({ label, hint, stack, children }: { label: string; hint?: string; stack?: boolean; children: ReactNode }) {
    const head = (
      <div className="min-w-0">
        <div className="text-white/75 text-xs">{label}</div>
        {hint && <div className="text-white/35 text-[10px] leading-snug mt-0.5">{hint}</div>}
      </div>
    );
    if (stack) return <div>{head && <div className="mb-2">{head}</div>}{children}</div>;
    return (
      <div className="flex items-center justify-between gap-3">
        {head}
        <div className="shrink-0">{children}</div>
      </div>
    );
  }

  function Switch({ on, onClick, title }: { on: boolean; onClick: () => void; title?: string }) {
    return (
      <button onClick={onClick} title={title} role="switch" aria-checked={on}
        className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 ${on ? 'bg-nobuf-primary' : 'bg-white/15'}`}>
        <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-200 ${on ? 'left-[21px]' : 'left-[3px]'}`} />
      </button>
    );
  }

  function Chip({ active, onClick, tone = 'secondary', children }: { active: boolean; onClick: () => void; tone?: ChipTone; children: ReactNode }) {
    const activeCls =
      tone === 'green' ? 'bg-green-500/25 text-green-300 ring-1 ring-green-400/40'
      : tone === 'primary' ? 'bg-nobuf-primary/20 text-nobuf-primary ring-1 ring-nobuf-primary/40'
      : 'bg-nobuf-secondary text-white';
    return (
      <button onClick={onClick}
        className={`px-2.5 py-1 rounded-md text-xs transition-all duration-150 ${active ? activeCls : 'bg-white/[0.07] text-white/55 hover:bg-white/15 hover:text-white/85'}`}>
        {children}
      </button>
    );
  }

  function UnitToggle({ unit, onChange, tone }: { unit: 'kb' | 'mb'; onChange: (u: 'kb' | 'mb') => void; tone: 'green' | 'primary' }) {
    const activeCls = tone === 'green' ? 'bg-green-500/25 text-green-300' : 'bg-nobuf-primary/20 text-nobuf-primary';
    return (
      <div className="flex rounded-md overflow-hidden border border-white/10 shrink-0">
        {(['kb', 'mb'] as const).map(u => (
          <button key={u} onClick={() => onChange(u)}
            className={`px-2 py-1 text-[10px] font-mono transition-colors ${unit === u ? activeCls : 'bg-white/[0.04] text-white/40 hover:text-white/70'}`}>
            {u === 'kb' ? 'KB/s' : 'MB/s'}
          </button>
        ))}
      </div>
    );
  }

  const NumInput = ({ value, onChange, focusCls = 'focus:border-nobuf-secondary', title, w = 'w-14' }: { value: number | string; onChange: (v: string) => void; focusCls?: string; title?: string; w?: string }) => (
    <input type="number" value={value} title={title} onChange={e => onChange(e.target.value)}
      className={`${w} px-1.5 py-1 rounded-md text-xs font-mono bg-white/[0.07] text-white/80 border border-white/10 ${focusCls} focus:outline-none text-center`} />
  );

  export function FastStreamPlayer({ file, streamUrl, onClose, onNext, onPrev, activeFolderId, onContinueToDownload, isAlreadyDownloading, isPublicChannel }: FastStreamPlayerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const vidRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const subFileInputRef = useRef<HTMLInputElement>(null);
  const { settings, updateSetting } = useSettings();
  const cacheSession = useCacheSession();
  const subs = useSubtitles();
  // Embedded subtitle bookkeeping: stream idx → loaded SubtitleTrack (so a
  // re-click toggles instead of re-fetching, E18), which idx is mid-fetch
  // (spinner row + double-click guard), and the busy idx as state for renders.
  const embeddedSubTracksRef = useRef<Map<number, { track: SubtitleTrack; partial: boolean }>>(new Map());
  const embeddedSubLoadingIdxRef = useRef<number | null>(null);
  const [embeddedSubBusyIdx, setEmbeddedSubBusyIdx] = useState<number | null>(null);
  // Round-14 F4: tracks whose AUTOMATIC session-restore found no usable cues.
  // Drives a passive marker on the subtitle row instead of an unprompted toast
  // (F4.5 (b)). Cleared per track on any successful extraction, and wholesale on
  // a file switch — "unavailable" is a statement about one file's cache state,
  // never a durable property of the track.
  const [embeddedSubUnavailable, setEmbeddedSubUnavailable] = useState<Set<number>>(new Set());
  // Generation counter bumped on every file switch: an extraction that started
  // on file A must NOT activate/persist/clear state after the player moved to
  // file B (review finding: stale cues crossing a mid-extraction file switch).
  const embeddedSubFileGenRef = useRef(0);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const durRef = useRef(0);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(settings.playerSpeed);

  // Reset playback speed to the (non-persistent) default every time a new video is opened.
  useEffect(() => {
    setRate(settings.playerSpeed);
  }, [file.id, settings.playerSpeed]);

  // Drop any loaded subtitle tracks when the source file changes.
  useEffect(() => {
    subs.clearTracks();
    embeddedSubTracksRef.current.clear();
    embeddedSubLoadingIdxRef.current = null;
    setEmbeddedSubBusyIdx(null);
    setEmbeddedSubUnavailable(new Set()); // round-14 F4: per-file, never durable
    embeddedSubFileGenRef.current++; // invalidate any in-flight extraction
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);
  const [_buf, setBuf] = useState(0);  // tracked for re-render triggering; bar now reads video.buffered directly
  const [load, setLoad] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Track the actual URL set as <video>.src for diagnostic display
  const [lastVideoSrc, setLastVideoSrc] = useState<string | null>(null);
  const [vis, setVis] = useState(true);
  const [fs, setFs] = useState(false);
  const [menu, setMenu] = useState(false);
  const [subMenu, setSubMenu] = useState(false);
  const [audioMenu, setAudioMenu] = useState(false);
  const [audioSwitching, setAudioSwitching] = useState(false);
  const [tip, setTip] = useState<{ t: number; x: number; show: boolean }>({ t: 0, x: 0, show: false });

  // Settings panel state
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Control-bar customization (drag & drop chips). Declared here — above the
  // auto-hide + tray effects that read them.
  const [dragChip, setDragChip] = useState<string | null>(null);
  const [dropSide, setDropSide] = useState<'left' | 'right' | 'tray' | null>(null);
  const [dragKind, setDragKind] = useState<'chip' | null>(null); // non-null while a bar chip (incl. the ⋯ tray) is being dragged
  // True only WHILE a chip/tray drag is physically in progress (dragstart→dragend).
  const dragActiveRef = useRef(false);
  // Timestamp of the last dragend. The WebView fires a synthetic Escape keydown a
  // few ms after a *cancelled* native drag; we swallow any Escape landing within
  // this window. A timestamp (not a held boolean) can NEVER get stuck "armed", so
  // the X button and a genuine Escape are never disabled by a drag that failed to
  // fire a clean dragend — which is what was killing the close button.
  const lastDragEndRef = useRef(0);
  const markDragStart = useCallback(() => { dragActiveRef.current = true; }, []);
  const markDragEnd = useCallback(() => { dragActiveRef.current = false; lastDragEndRef.current = Date.now(); }, []);
  const [dropIndex, setDropIndex] = useState<number | null>(null); // live insertion slot within the active side
  const [trayOpen, setTrayOpen] = useState(false);
  // Live width while dragging the resize handle (null = use persisted settings width).
  const [panelDragWidth, setPanelDragWidth] = useState<number | null>(null);
  const panelResizing = useRef(false);
  const [controlsPinned, setControlsPinned] = useState(true); // default pinned; only matters when playerShowPinButton is on
  const [loop, setLoop] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [brightness, setBrightness] = useState(1);
  const [pip, setPip] = useState(false);
  const [videoResolution, setVideoResolution] = useState<{ w: number; h: number } | null>(null);
  // Speed limit custom input state
  const [customPrebufferValue, setCustomPrebufferValue] = useState<string>('');
  const [customPrebufferUnit, setCustomPrebufferUnit] = useState<'kb' | 'mb'>('mb');
  const [customDownloadValue, setCustomDownloadValue] = useState<string>('');
  const [customDownloadUnit, setCustomDownloadUnit] = useState<'kb' | 'mb'>('mb');
  // Video cache dialog state — replaces old bgCache auto-dialog
  const [showCacheDialog, setShowCacheDialog] = useState(false);
  const [pendingCachePercent, setPendingCachePercent] = useState(0);
  const [skipFeedback, setSkipFeedback] = useState<{ direction: 'forward' | 'backward'; totalDelta: number; from: number; to: number } | null>(null);
  const skipFeedbackTimer = useRef<number>(0);
  const skipFeedbackKey = useRef(0);
  // Anchor time where the current burst started — lets us show the true cumulative
  // jump (from → to) across rapid key presses instead of a single-step estimate.
  const skipBurstFrom = useRef<number | null>(null);
  const [videoEnded, setVideoEnded] = useState(false);
  // Ref synced alongside videoEnded state — prevents stale closure in
  // onPlay handler (which is inside a useEffect and doesn't have videoEnded
  // in its deps). Also used by seekFwd/seekBwd for synchronous checks.
  const videoEndedRef = useRef(false);

  const [cachePercent, setCachePercent] = useState(0);
  const [cacheComplete, setCacheComplete] = useState(false);
  // Time ranges from backend cache (includes both playback buffer + download)
  const [cachedTimeRanges, setCachedTimeRanges] = useState<[number, number][]>([]);
  // SourceBuffer memory ranges — updated by 'progress' event on <video>
  // for real-time white bar rendering (not dependent on React re-renders)
  const [bufferedRanges, setBufferedRanges] = useState<[number, number][]>([]);
  // Maximum time position with cached data — used to prevent thumbnail
  // extractor from seeking beyond available data (which causes 503 → fatal error)
  const maxCachedTime = cachedTimeRanges.length > 0
    ? Math.max(...cachedTimeRanges.map(r => r[1]))
    : 0;
  const [controlsHeight, setControlsHeight] = useState(0);
  const [miniBarVisible, setMiniBarVisible] = useState(false);

  // Download overlay state
  const [dlOverlay, setDlOverlay] = useState<{ active: boolean; percent: number; fromCache: boolean; speed: number; completed?: boolean } | null>(null);
  const [dlOverlayVisible, setDlOverlayVisible] = useState(false);
  const dlTransferIdRef = useRef<string>('');
  const dismissTimerRef = useRef<number>(0);

  // MSE player handles ALL formats (MP4/MKV/WebM/TS).
  // TS files now use the MSE transmuxer (MediabunnyTransmuxer) with byte-offset
  // keyframe seeking instead of hls.js. This eliminates MISS-FAR targeted
  // downloads at seek positions — same "seek poison" approach as .mp4 files.

  const msePlayer = useMSEPlayer(streamUrl, file, activeFolderId, isPublicChannel);

  // MSE player handles ALL formats (MP4, TS, MKV, WebM).
  // TS files use MediabunnyTransmuxer instead of hls.js.

  // Merge into unified player interface — MSE player handles everything
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
    pausePrefetch: msePlayer.pausePrefetch,
    resumePrefetch: msePlayer.resumePrefetch,
    seekTo: msePlayer.seekTo,
    suppressLoadingSpinnerRef: msePlayer.suppressLoadingSpinnerRef,
    setVideoRef: msePlayer.setVideoRef,
    downloadedTimeRanges: msePlayer.downloadedTimeRanges,
    byteToTime: msePlayer.byteToTime,
    recordByteTimeAnchor: msePlayer.recordByteTimeAnchor,
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
    getTransmuxerSourceConfig: msePlayer.getTransmuxerSourceConfig,
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
    pausePrefetch,
    resumePrefetch,
    seekTo,
    suppressLoadingSpinnerRef,
    setVideoRef,
    downloadedTimeRanges: _downloadedTimeRanges, // kept for re-render triggering + backend reporting
    byteToTime,
    recordByteTimeAnchor,
    thumbnailDataReady,
    moovBufferReady,
    isTransmuxer,
    isTransmuxerActive: _isTransmuxerActive,
    keyframeIndexReady: _keyframeIndexReady,
    isColdStartBuffering,
    coldStartProgress,
    coldStartPhase,
    detectedFormat,
  } = player;

  // Cold-start overlay visibility with a 300ms fade-out so the overlay doesn't
  // snap off the moment the buffer gate completes. Playback starts immediately
  // underneath the overlay; the overlay is purely informational progress.
  const [showColdStartOverlay, setShowColdStartOverlay] = useState(false);
  // Dedicated overlay for the remux fallback path (TS files with timed_id3).
  // Covers the full startup pipeline: metadata fetch + ffprobe + ffmpeg spawn +
  // first fMP4 fragments. The cold-start overlay only covers the mpegts.js 5MB
  // prebuffer — it hides at ~2s, but remux video isn't ready for 5-10s. This
  // state stays true until onPlay fires (video actually playing) or a 15s
  // safety timeout prevents a stuck overlay if playback never starts.
  const [isRemuxLoading, setIsRemuxLoading] = useState(false);
  const isRemuxLoadingRef = useRef(false);
  isRemuxLoadingRef.current = isRemuxLoading;
  // Ref mirror so event handlers (onMeta/onCanPlay) inside the useEffect
  // closure can check the current cold-start state without re-registering.
  // Without this, the handlers capture a stale `isColdStartBuffering=false`
  // and call v.play() before the 5 MB buffer gate resolves, defeating the
  // cold-start prebuffer and starting playback under the overlay.
  const coldStartBufferingRef = useRef(false);
  coldStartBufferingRef.current = isColdStartBuffering;
  useEffect(() => {
    if (isColdStartBuffering) {
      setShowColdStartOverlay(true);
    } else if (showColdStartOverlay) {
      setShowColdStartOverlay(false);
    }
  }, [isColdStartBuffering, showColdStartOverlay]);

  // Native playback fallback: when MSE/HLS fails (e.g., codec not supported),
  // the player falls back to native <video> using streamUrl directly.
  // Only show error if there's an actual error from the player, not just
  // because native mode is active.
  useEffect(() => {
    if (playerUnsupportedCodec) {
      setErr(playerUnsupportedCodec);
      setLoad(false);
    } else if (playerUseNative && playerError && !playerMseUrl) {
      setErr(playerError);
      setLoad(false);
    }
  }, [playerUseNative, playerMseUrl, playerError, playerUnsupportedCodec]);

  // Thumbnail extractor — all formats use MSE-based extraction now
  // TS files use the MSE transmuxer (MediabunnyTransmuxer) with byte-offset
  // keyframe seeking — no separate HLS thumbnail pipeline needed.
  const mseGetters = useMemo(() => ({
    getMoovBuffer: msePlayer.getMoovBuffer, getFirstChunk: msePlayer.getFirstChunk, getInitSegments: msePlayer.getInitSegments, getVideoTrackInfo: msePlayer.getVideoTrackInfo, getMP4BoxClass: msePlayer.getMP4BoxClass, getFileLength: msePlayer.getFileLength, isTransmuxer: msePlayer.isTransmuxer, getFormat: msePlayer.getFormat, getKnownDuration: msePlayer.getKnownDuration, isTransmuxerActive: msePlayer.isTransmuxerActive, getKeyframeTimestamps: msePlayer.getKeyframeTimestamps, getKeyframeByteOffsets: msePlayer.getKeyframeByteOffsets, getTsHeaderData: msePlayer.getTsHeaderData, getTransmuxerSourceConfig: msePlayer.getTransmuxerSourceConfig, recordByteTimeAnchor: msePlayer.recordByteTimeAnchor, keyframeIndexReady: msePlayer.keyframeIndexReady, isFmp4Stream: msePlayer.isFmp4Stream, getFmp4Config: msePlayer.getFmp4Config, getRemuxThumbConfig: msePlayer.getRemuxThumbConfig,
  }), [msePlayer.getMoovBuffer, msePlayer.getFirstChunk, msePlayer.getInitSegments, msePlayer.getVideoTrackInfo, msePlayer.getMP4BoxClass, msePlayer.getFileLength, msePlayer.isTransmuxer, msePlayer.getFormat, msePlayer.getKnownDuration, msePlayer.isTransmuxerActive, msePlayer.getKeyframeTimestamps, msePlayer.getKeyframeByteOffsets, msePlayer.getTsHeaderData, msePlayer.getTransmuxerSourceConfig, msePlayer.recordByteTimeAnchor, msePlayer.keyframeIndexReady, msePlayer.isFmp4Stream, msePlayer.getFmp4Config, msePlayer.getRemuxThumbConfig]);

  const { getCachedThumbnailSync, setDesiredHoverTime, clearDesiredHover, cachedTimes } = useThumbnailExtractor(vidRef, streamUrl, playerUseNative, mseGetters, thumbnailDataReady, moovBufferReady, maxCachedTime);
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
    // Swallow the phantom click WebView2 synthesizes on the element under the
    // cursor when a native chip-drag is released — dropping on the bar's right
    // end lands that click on this X button. A real X click never lands within
    // 350ms of a chip dragend, so a recency window blocks the phantom without
    // ever disabling a genuine close.
    if (Date.now() - lastDragEndRef.current < 350) return;
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
          invoke('cmd_delete_cache', { messageId: file.id, reason: 'player-close-zero-cache' }).catch(() => {
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
      invoke('cmd_delete_cache', { messageId: file.id, reason: 'cache-dialog-discard' }).catch(() => {
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
  // shadowCacheModRef removed — shadow cache ranges are no longer shown on the green bar

  // Poll cache status for green bar — updates every 500ms for near-realtime feel.
  // Merges disk cache ranges (from backend) with shadow cache ranges (from JS memory)
  // Also computes the download-speed meter value from the backend's cumulative
  // session_downloaded_bytes counter (bytes that actually arrived from Telegram
  // — disk-cache HITs never touch it). Window math lives in speedMeter.ts.
  const greenBarSpeedHistoryRef = useRef<SpeedSample[]>([]);
  const [greenBarSpeed, setGreenBarSpeed] = useState(0);
  // When the green-bar poll gate (seek-settle) first engaged, for the bounded-
  // freeze safety timeout below. 0 = gate not currently engaged.
  const seekSettleStartRef = useRef(0);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      while (active) {
        try {
          // Skip cache status polling during seek/VBR correction AND through the
          // post-seek align-settle window. The green bar converts disk-cache BYTE
          // ranges to TIME via byteToTime(), which for TS/remux is a LINEAR map on
          // VBR content (no keyframe index). During a seek the backend adds new
          // cached ranges and recordByteTimeAnchor mutates the byte→time table, so
          // polling mid-settle repaints segments at provisional positions and then
          // shifts them when the table updates — the "green bar falsely shows then
          // fixes itself" flicker (proven logs 10). Gate on BOTH:
          //   - __nobuf_userSeekInProgress (set at seek dispatch, cleared when the
          //     new player is wired — but that's BEFORE the ~3s align settle), and
          //   - __nobuf_seekTargetTime > 0 (held until currentTime catches up to the
          //     seek target, i.e. the seek has truly settled — see onTime).
          // Holding through both means the bar keeps its last-good segments and
          // updates ONCE, atomically, after the seek settles — no visible reshuffle.
          const _seekSettling =
            (window as any).__nobuf_userSeekInProgress === true ||
            ((window as any).__nobuf_seekTargetTime > 0);
          // BOUNDED FREEZE: never gate the bar for more than ~8s. If a seek's
          // buffer never populates, __nobuf_seekTargetTime can stay >0 forever
          // (onTime only clears it when currentTime catches up), which would
          // freeze the green bar permanently. Track when the gate first engaged;
          // once it's been held ~8s, force a poll so the bar can't get stuck.
          const _nowMs = Date.now();
          if (_seekSettling) {
            if (seekSettleStartRef.current === 0) seekSettleStartRef.current = _nowMs;
          } else {
            seekSettleStartRef.current = 0;
          }
          const _gateExpired =
            seekSettleStartRef.current > 0 && _nowMs - seekSettleStartRef.current > 8000;

          // Fetch status EVERY tick — the speed meter must never sit behind the
          // seek-settle gate (a gated sample series reads as a fake stall → 0
          // during seeks). Only the ranges→time consumers below stay gated.
          const status = await invoke<any>('cmd_get_cache_status', { messageId: file.id });

          // ── Download speed (bytes actually fetched from Telegram) ──
          // status.session_downloaded_bytes is a backend cumulative counter fed
          // ONLY at iter_download chunk arrivals — cache HITs can't inflate it.
          // Windowed cumulative diff + stall-zero + reset guard: speedMeter.ts.
          {
            const sampleT = Date.now();
            const samples = greenBarSpeedHistoryRef.current;
            if (status?.is_complete) {
              // Fully cached: nothing can be downloading — snap to 0 now
              // instead of waiting out the 3s stall window.
              samples.length = 0;
              setGreenBarSpeed(0);
            } else {
              pushSample(samples, sampleT, status?.session_downloaded_bytes ?? 0);
              setGreenBarSpeed(computeWindowSpeed(samples, sampleT));
            }
          }

          if (!_seekSettling || _gateExpired) {
            if (_gateExpired) seekSettleStartRef.current = 0; // reset so next seek re-arms
          if (status) {
            setCachePercent(status.percentage);
            setCacheComplete(status.is_complete);

            // Update session cache tracker via ref (avoids re-triggering this effect)
            const cs = cacheSessionRef.current;
            if (cs.getCacheInfo(file.id) && status.percentage > 0) {
              cs.updateCachePercent(file.id, status.percentage);
            }
          }
          // Build ranges from BOTH backend + shadow cache, regardless of status
          // Use real duration if available, fall back to estimate for green bar calculation
          // Prefer the accurate PTS duration (set from /fmp4/metadata ~2s after
          // open) over the 4Mbps estimate. Without __nobuf_ptsDuration here the
          // green bar stayed dark for the entire ~12s duration-probe retry window
          // even though the real duration was known almost immediately — the bar's
          // data gate (durForBar > 0) and this whole block never ran. durRef stays
          // authoritative once the seek-bar duration is confirmed.
          const durForBar = durRef.current || (window as any).__nobuf_ptsDuration || (window as any).__nobuf_estimateDuration || 0;
          const ranges: [number, number][] = [];

          // Backend ranges (disk cache) → green prebuffer bar. Two corrections,
          // both proven from remux-seek logs (5-c/5-t.md):
          //
          // (A) EFFECTIVE PLAYHEAD. A remux seek RECREATES the mpegts player, so
          //     video.currentTime resets to 0 while the seek gap downloads — the
          //     logs showed playhead=0.0s on every poll after a seek, so a raw
          //     currentTime filter drops nothing and stale chunks (cold-start
          //     0-46s, previous seek's region) linger. Use the seek target
          //     (__nobuf_seekTargetTime) as the playhead until currentTime catches
          //     up past it.
          //
          // (B) VBR ANCHOR CAPTURE. byteToTime is LINEAR for HEVC/remux (the
          //     keyframe-index poll is gated off for MKV — useMSEPlayer:7704), and
          //     linear is badly wrong for VBR: seeking to 1802.7s, ffmpeg actually
          //     read byte 813MB, but linear mapped 813MB→1979s (+177s). After a
          //     seek to T, the cached range whose START byte is nearest the linear
          //     estimate of T IS the region ffmpeg read for T — a ground-truth
          //     (byte,time) anchor. Feed it to recordByteTimeAnchor (monotonicity-
          //     guarded) so byteToTime self-calibrates off the linear fallback.
          if (status?.cached_ranges && status.total_bytes > 0 && durForBar > 0) {
            const cachedRanges = status.cached_ranges as [number, number][];
            const seekTarget = (window as any).__nobuf_seekTargetTime;
            // (rawPlayhead removed with the GREEN-BAR diagnostic log; re-add
            //  `const rawPlayhead = vidRef.current?.currentTime ?? 0;` if re-enabling.)
            // (B) Capture a VBR anchor for the active seek before converting.
            // ROUND-5 GATE (user report: "seeked to 5min → instant 1-2min of
            // green that isn't downloaded"): this heuristic pairs the nearest
            // cached-range START with the seek time. That's sound ONLY on the
            // linear /remux-tier where ffmpeg's reads for the seek create that
            // range. On the MKV transmuxer tier it's poison: thumbnail-probe /
            // old-seek islands get snapped to the playhead (island start ↔
            // seekTarget) → the whole island instantly renders as phantom
            // prebuffer AT the seek point, and the bogus anchor then blocks the
            // transmuxer's real ground-truth anchor (getLastSeekAnchor,
            // monotonicity guard rejects the later correct pair). The
            // transmuxer records its own exact anchors — skip the guess there.
            if (!isTransmuxer() && typeof seekTarget === 'number' && seekTarget > 0 && recordByteTimeAnchor) {
              const linearByte = (seekTarget / durForBar) * status.total_bytes;
              // Nearest cached-range START to the linear estimate = ffmpeg's real
              // cluster read for this seek. Ignore the front (0) and tail ranges.
              let best: number | null = null;
              let bestDist = Infinity;
              for (const [s] of cachedRanges) {
                if (s < 4 * 1024 * 1024) continue; // skip cold-start front reads
                const d = Math.abs(s - linearByte);
                if (d < bestDist) { bestDist = d; best = s; }
              }
              // Only trust it when the range start is within 128MB of the estimate
              // (VBR skew is large but bounded — see backend max_window 256MB).
              if (best !== null && bestDist < 128 * 1024 * 1024) {
                recordByteTimeAnchor(best, seekTarget);
              }
            }
            // Show EVERY cached range. This bar is sourced from the backend disk
            // cache (status.cached_ranges) — every range in it is ON DISK and
            // INSTANTLY SEEKABLE, so all of it is genuinely available and must
            // stay lit. A prior recency filter (drop anything >60s behind the
            // effective playhead) made regions VANISH on every forward seek even
            // though they were never evicted (proven: trace 18-t — 0-46s, 52-82s,
            // 679-756s all persist in cached_ranges after a seek to 1262s). That
            // filter conflated an in-memory playback window with disk-cache
            // availability; the two are different. Removed — the bar now mirrors
            // exactly what the disk cache holds.
            for (const [s, e] of cachedRanges) {
              ranges.push([byteToTime(s), byteToTime(e + 1)]);
            }
            // DIAGNOSTIC (disabled — green-bar persistence confirmed). Re-enable
            // by uncommenting if the byte→time conversion needs inspection again.
            // console.log(`[GREEN-BAR] raw=${rawPlayhead.toFixed(1)}s seekTgt=${typeof seekTarget==='number'?seekTarget.toFixed(1):'-'} dur=${durForBar.toFixed(1)}s | cached bytes→time: ${cachedRanges.map(([s,e]) => `${(s/1e6).toFixed(0)}-${(e/1e6).toFixed(0)}MB→${byteToTime(s).toFixed(0)}-${byteToTime(e+1).toFixed(0)}s`).join(', ')} | shown: ${ranges.map(([a,b])=>`${a.toFixed(0)}-${b.toFixed(0)}s`).join(', ') || 'none'}`);
          }

          // Shadow cache ranges are NOT shown on the green bar.
          // The shadow cache is in-memory data already shown by the white bar
          // (bufferedRanges from v.buffered). Showing it on the green bar is:
          // 1. Redundant (same data, different color)
          // 2. Wrong for VBR (byteToTime uses linear mapping when keyframe
          //    table is empty, which is always for TS files because the backend
          //    keyframe scanner can't build the index from sparse cached data)
          // 3. Misleading (shows data that's NOT on disk as "prebuffer")
          // The green bar should ONLY show disk cache (cmd_get_cache_status)
          // — the ACTUAL prebuffered data on local disk.
          // Merge overlapping/adjacent ranges (shared helper, 1.0s tolerance —
          // see mergeTimeRanges for why byte-adjacent VBR runs need bridging).
          if (ranges.length > 0) {
            setCachedTimeRanges(mergeTimeRanges(ranges));
          }
          } // end if (!__nobuf_userSeekInProgress)
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 500));
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
            const ranges: [number, number][] = status.cached_ranges
              .map(([s, e]: [number, number]) => [byteToTime(s), byteToTime(e + 1)]);
            // Sort+merge (shared helper) — this path previously set raw,
            // unsorted, unmerged ranges, which is the primary source of the
            // hairline gaps the user saw on the green bar.
            setCachedTimeRanges(mergeTimeRanges(ranges));
          }
        } catch { /* ignore */ }
        if (event.payload.percent >= 100) {
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
  // Green bar = disk cache (cachedTimeRanges from cmd_get_cache_status polling).
  // Gray/White bar = in-memory SourceBuffer (video.buffered — instant seeks).
  // Yellow bar = thumbnail coverage.
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

      // Player prebuffer continues running — download and prebuffer interleave
      // through Semaphore(1) at the Rust level (one Telegram iter_download call
      // at a time → no FLOOD_WAIT). The backend updates CacheMeta per-chunk.
      await invoke('cmd_download_file', {
        messageId: file.id,
        savePath,
        folderId: activeFolderId,
        transferId,
      });

      toast.success(cacheComplete ? `Downloaded from cache: ${file.name}` : `Downloaded: ${file.name}`);
    } catch (e: any) {
      const errMsg = String(e);
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
  }, [file, activeFolderId, cacheComplete]);

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
    setDlOverlayVisible(false);
    clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = window.setTimeout(() => {
      setDlOverlay(null);
      dlTransferIdRef.current = '';
    }, 300);
  }, [dlOverlay?.completed]);


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

    // Pass video element to player hook
    setVideoRef(v);

    // Video src assignment depends on playback mode:
    // - MSE mode (ALL formats including TS): uses Blob URL (same-origin, bypasses WebView2 restrictions)
    //   Native fallback uses streamUrl directly — the Actix streaming server
    //   includes CORS headers with Access-Control-Allow-Private-Network: true.
    //   TS files use MSE transmuxer (MediabunnyTransmuxer) instead of hls.js.
    if (playerUseNative) {
      // Native fallback: use remux URL (ffmpeg TS→MPEG-TS) if available, otherwise raw streamUrl
      // NOTE: /remux outputs MPEG-TS (video/mp2t), which native <video> CANNOT play.
      // The remux URL is intended for mpegts.js consumption. If native fallback
      // is used with a remux URL, playback will fail — but this path is only
      // hit when mpegts.js itself fails to initialize (rare edge case).
      const nativeUrl = playerRemuxUrl || streamUrl;
      console.log('[Player] Native fallback: setting video src to', nativeUrl === playerRemuxUrl ? 'remux URL' : 'streamUrl');

      // For remux URLs: Override the player UI duration with the KNOWN duration.
      // When the file is NOT cached, the /remux/ endpoint streams piped fMP4
      // with empty_moov (duration=0 in moov box). Chrome reads this as
      // "live streaming" and video.duration shows ~3s. Override from metadata.
      // When the file IS cached, faststart moov has the correct duration
      // and Chrome gets it right — the override is harmless (same value).
      if (nativeUrl === playerRemuxUrl && file) {
        let knownDuration = 0;
        // Priority 1: Telegram metadata duration
        if (file.duration && file.duration > 0 && isFinite(file.duration)) {
          knownDuration = file.duration;
        }
        // Priority 2: PTS-based duration from backend metadata endpoint
        if (knownDuration <= 0 && (window as any).__nobuf_ptsDuration > 0) {
          knownDuration = (window as any).__nobuf_ptsDuration;
        }
        // NO Priority 3 (4Mbps estimate) for the remux path — it poisons durRef
        // with ~38min before the fetch resolves, causing the "live-stream" growing
        // duration. If no authoritative duration is available yet, leave durRef
        // at 0 and let onDurChange set it once __nobuf_ptsDuration arrives.
        // The onDurChange suppression guard (isRemux && realDuration <= 0 → return)
        // keeps the displayed duration at 0:00 until the real value is known.
        if (knownDuration > 0) {
          console.log('[Player] Remux: overriding duration to', knownDuration.toFixed(1), 's');
          setDur(knownDuration);
          durRef.current = knownDuration;
        }
      }

      v.src = nativeUrl;
      setLastVideoSrc(nativeUrl);
      v.autoplay = true;
      // Show the remux loading overlay — covers download + ffprobe + ffmpeg startup +
      // first fragments. Hidden by onPlay (video actually playing) or timeout.
      // For large uncached files the backend must: download → ffprobe → ffmpeg start →
      // produce first fMP4 fragment → browser decode → fire play. 45s covers 1GB+ files.
      if (nativeUrl === playerRemuxUrl) {
        setIsRemuxLoading(true);
        const remuxTimeoutId = setTimeout(() => {
          if (isRemuxLoadingRef.current) {
            console.warn('[Player] Remux loading timeout (45s) — hiding overlay');
            setIsRemuxLoading(false);
          }
        }, 45000);
        // Store timeout id on the video element so onPlay/onErr can clear it
        (v as any).__nobuf_remuxTimeoutId = remuxTimeoutId;
      }
    } else {
      // MSE mode (ALL formats): use Blob URL
      // For mpegts.js (TS files), mseUrl is null because mpegts.js creates
      // its own MediaSource and sets video.src internally. We must NOT
      // skip event listener setup — just skip the src assignment.
      const videoUrl = playerMseUrl;
      if (videoUrl) {
        console.log('[Player] Setting video src:', videoUrl);
        v.src = videoUrl;
        setLastVideoSrc(videoUrl);
      } else {
        console.log('[Player] MSE URL not set yet — active tier (mpegts.js/MKV transmuxer) attaches its own src');
        // mpegts.js will set video.src after attachMediaElement()
        // Mark as MSE blob URL for the durationchange guard
        setLastVideoSrc('mpegts://internal');
      }
      // NEVER set v.autoplay in MSE mode. For TS files, playerMseUrl goes
      // null→blobUrl→null as mpegts.js initializes. The blobUrl run would
      // set autoplay=true, and the browser would auto-play when the first
      // fMP4 segment is appended — before the 5 MB cold-start gate
      // resolves. For MP4, the onMeta/onCanPlay handlers call v.play()
      // explicitly. For TS, player.play() is called after the gate.
      v.autoplay = false;
    }

    const onMeta = () => {
      console.log('[Player] loadedmetadata, duration:', v.duration, 'readyState:', v.readyState);
      // For TS files via mpegts.js: video.duration is often Infinity
      // because TS has no global duration header. Override with known duration.
      // Priority: (1) Telegram metadata, (2) PTS-based from backend /fmp4/metadata/,
      // (3) file.size bitrate estimate (last resort, often wrong for TS)
      if (!isFinite(v.duration) && file) {
        let knownDuration = 0;
        const isEstimateSource = !file.duration && !(window as any).__nobuf_ptsDuration;
        if (file.duration && file.duration > 0 && isFinite(file.duration)) {
          knownDuration = file.duration;
        }
        if (knownDuration <= 0 && (window as any).__nobuf_ptsDuration > 0) {
          knownDuration = (window as any).__nobuf_ptsDuration; // PTS-based from tail scan
        }
        if (knownDuration <= 0 && file.size > 0) {
          knownDuration = (file.size / 4_000_000) * 8; // ~4Mbps estimate (unreliable for TS)
        }
        if (knownDuration > 0) {
          console.log('[Player] MPEGTS: overriding Infinity duration to', knownDuration.toFixed(1), 's (source:', file.duration ? 'Telegram' : (window as any).__nobuf_ptsDuration ? 'PTS-tail' : '4Mbps-estimate', ')');
          if (isEstimateSource) {
            // 4Mbps estimate — DO NOT show in UI (user wants 0 until real PTS arrives).
            // Keep the estimate in __nobuf_estimateDuration for seek bar range
            // calculation, but leave dur state at 0.
            (window as any).__nobuf_durationIsEstimate = true;
            (window as any).__nobuf_estimateDuration = knownDuration;
            // setDur stays at 0 — UI shows "0:00 / 0:00" until real PTS
            // durRef.current stays at 0 — shrink guard won't block real PTS
          } else {
            (window as any).__nobuf_durationIsEstimate = false;
            setDur(knownDuration);
            durRef.current = knownDuration;
          }
        }
      } else {
        // For remux URLs in piped mode: video.duration is unreliable (empty_moov = ~3s).
        // If we already set a metadata-provided duration, don't let video.duration
        // overwrite it. For cached mode, video.duration is correct from faststart moov.
        // For mpegts.js, if the only duration we have is the 4 Mbps estimate, keep
        // the UI at 0:00 until the real PTS duration arrives.
        const isRemux = lastVideoSrc === playerRemuxUrl || v.src?.includes('/remux/');
        const realDuration = (file?.duration && file.duration > 0 && isFinite(file.duration))
          ? file.duration : ((window as any).__nobuf_ptsDuration > 0 ? (window as any).__nobuf_ptsDuration : 0);
        const isEstimate = (window as any).__nobuf_durationIsEstimate === true && realDuration <= 0;

        // On remux: if authoritative duration is known, use it immediately — don't
        // let the bogus empty_moov duration (5s, 10s, etc.) flash in the UI.
        if (isRemux && realDuration > 0) {
          setDur(realDuration);
          durRef.current = realDuration;
        } else if (!isRemux || v.duration > durRef.current) {
          if (isEstimate) {
            (window as any).__nobuf_estimateDuration = v.duration;
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
      // Don't start playback during cold-start buffering — the gate in
      // useMSEPlayer._initMpegtsPlayer will call player.play() after 5 MB
      // is cached. Starting here would play under the overlay with thin buffer.
      if (!coldStartBufferingRef.current) {
        // Don't auto-play during deferred VBR check — the align poll will play()
        // after confirming the position is correct (or after VBR correction)
        if ((window as any).__nobuf_seekTargetTime > 0) return;
        v.play().catch((e: any) => {
          if (e?.name !== 'AbortError') console.warn('[Player] play() failed:', e);
        });
      }
    };
    const onCanPlay = () => {
      // Update buffered ranges on canplay (first data available)
      const ranges: [number, number][] = [];
      for (let i = 0; i < v.buffered.length; i++) {
        ranges.push([v.buffered.start(i), v.buffered.end(i)]);
      }
      if (ranges.length > 0) setBufferedRanges(ranges);
      // Don't auto-play when the replay overlay is showing — the MSE guard
      // already paused the video and dispatched 'ended'. canplay fires from
      // the currentTime change, and calling play() here would resume playback
      // under the overlay, eventually causing the video to hit 'waiting' at
      // duration (the "loading on finish" bug).
      if (videoEndedRef.current) return;
      // Same cold-start gate as onMeta — don't play before the buffer gate.
      if (coldStartBufferingRef.current) return;
      // Don't auto-play during deferred VBR check
      if ((window as any).__nobuf_seekTargetTime > 0) return;
      v.play().catch(() => {});
    };
    const onErr = () => {
      const err = v.error;
      console.error('[Player] video error:', err?.code, err?.message, 'src:', v.src);
      // Clear remux loading overlay on error — don't keep it stuck
      if (isRemuxLoadingRef.current) {
        setIsRemuxLoading(false);
      }
      if ((v as any).__nobuf_remuxTimeoutId) {
        clearTimeout((v as any).__nobuf_remuxTimeoutId);
        (v as any).__nobuf_remuxTimeoutId = null;
      }
      setErr(playerError || `Video error: ${err?.message || 'unknown'}`);
      setLoad(false);
    };
    const onTime = () => {
      const ct = v.currentTime;
      if (!isFinite(ct)) return; // guard against NaN after eviction/resume
      // During player recreation, hold the bar at the seek target.
      // Hold when ct is BELOW target (forward seek / recreation ct=0)
      // OR when ct is far ABOVE target (backward seek — stale old buffer ct).
      // Don't clear during active recreation — wait for align poll.
      const seekTarget = (window as any).__nobuf_seekTargetTime;
      const seekInProgress = (window as any).__nobuf_userSeekInProgress === true;
      if (seekTarget > 0 && (seekInProgress || ct < seekTarget - 2 || ct > seekTarget + 20)) {
        setTime(seekTarget);
      } else {
        if (seekTarget > 0) {
          (window as any).__nobuf_seekTargetTime = 0; // seek complete — clear
        }
        setTime(ct);
      }
      // Get the furthest buffered position
      if (v.buffered.length > 0) {
        let maxBuf = 0;
        for (let i = 0; i < v.buffered.length; i++) {
          maxBuf = Math.max(maxBuf, v.buffered.end(i));
        }
        setBuf(maxBuf);
      }
      // Update SourceBuffer memory ranges for white bar (every timeupdate = ~250ms)
      const ranges: [number, number][] = [];
      for (let i = 0; i < v.buffered.length; i++) {
        ranges.push([v.buffered.start(i), v.buffered.end(i)]);
      }
      setBufferedRanges(ranges);
      // Round-10 P1-2: repair stale subtitle coverage automatically. Nothing in
      // the app re-extracted after a seek, so cues for 0-196s stayed on screen
      // (i.e. blank) while the viewer watched at 4500s. Checked on the existing
      // timeupdate tick — no new timer, no new I/O — and only fires when an
      // ACTIVE track's cues have genuinely fallen behind the playhead.
      // maybeRepairSubCoverage self-throttles and no-ops while a fetch is live.
      maybeRepairSubCoverageRef.current?.(ct);
    };
    const onPlay = () => {
      // Clear remux loading overlay — video is actually playing now
      if (isRemuxLoadingRef.current) {
        setIsRemuxLoading(false);
      }
      if ((v as any).__nobuf_remuxTimeoutId) {
        clearTimeout((v as any).__nobuf_remuxTimeoutId);
        (v as any).__nobuf_remuxTimeoutId = null;
      }
      setPlaying(true);
      // Only clear videoEnded if the video is NOT at the end.
      // When the MSE guard dispatches a synthetic 'ended' event, it also
      // calls pause(). If a download loop restart then causes play(), onPlay
      // fires and would clear videoEnded=false — destroying the replay overlay.
      // Only clear when the user intentionally starts a replay from the beginning.
      if (videoEndedRef.current && v.currentTime > 1) {
        // Video ended but now playing from a non-start position — keep overlay.
        // This happens when a seek restarts the download loop after the MSE
        // guard forced videoEnded=true. The replay overlay should stay.
        console.log(`[Player] onPlay while videoEnded=true at currentTime=${v.currentTime.toFixed(1)}s — keeping replay overlay`);
      } else {
        console.log('[Player] onPlay — clearing videoEnded');
        setVideoEnded(false);
        videoEndedRef.current = false;
      }
    };
    const onPause = () => setPlaying(false);
    const onEnded = () => { console.log('[Player] onEnded — setting videoEnded=true'); setPlaying(false); setVideoEnded(true); videoEndedRef.current = true; };
    const onWait = () => { if (!suppressLoadingSpinnerRef.current) setLoad(true); };
    const onPlay2 = () => setLoad(false);
    const onProgress = () => {
      // Update buffer end for UI
      if (v.buffered.length > 0) {
        let maxBuf = 0;
        for (let i = 0; i < v.buffered.length; i++) {
          maxBuf = Math.max(maxBuf, v.buffered.end(i));
        }
        setBuf(maxBuf);
      }
      // Update SourceBuffer memory ranges for white bar (real-time)
      const ranges: [number, number][] = [];
      for (let i = 0; i < v.buffered.length; i++) {
        ranges.push([v.buffered.start(i), v.buffered.end(i)]);
      }
      setBufferedRanges(ranges);
    };

    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('error', onErr);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('waiting', onWait);
    v.addEventListener('playing', onPlay2);
    v.addEventListener('progress', onProgress);
    const onDurChange = () => {
      if (!file) return;

      // Authoritative duration sources (highest priority first):
      // 1. Telegram metadata attached to the file object
      // 2. PTS-based tail-scan duration reported by the backend
      // The 4 Mbps filesize estimate is NEVER authoritative and must never be
      // used as a floor for the real duration.
      const realDuration = (file.duration && file.duration > 0 && isFinite(file.duration))
        ? file.duration
        : ((window as any).__nobuf_ptsDuration > 0 ? (window as any).__nobuf_ptsDuration : 0);

      const isRemux = lastVideoSrc === playerRemuxUrl || v.src?.includes('/remux/');

      // On remux fallback: suppress fragment-growing duration (5→10→20→49s) and
      // the 4Mbps estimate until the backend PTS duration arrives. The cold-start
      // overlay hides the video during the fetch; this guard prevents durRef from
      // being polluted underneath. Once __nobuf_ptsDuration is set, realDuration > 0
      // and the floor guard below clamps correctly from the first real event.
      if (isRemux && realDuration <= 0 && isFinite(v.duration) && v.duration > 0) {
        return;
      }

      if (isFinite(v.duration) && v.duration > 0) {
        // Overflow guard: mpegts.js can report ~2^32/1000 ≈ 4294967s after aborts.
        const isOverflow = realDuration > 0 && v.duration > realDuration * 1.5;
        const clampedDur = isOverflow ? realDuration : v.duration;

        // Real metadata/PTS duration is the hard floor. If mpegts.js recalculates
        // duration from the current buffer only (e.g., 153s instead of 2073s),
        // restore the authoritative value.
        const safeDur = (realDuration > 0 && clampedDur < realDuration) ? realDuration : clampedDur;

        // Early exit: if we already have this duration set, nothing to do.
        // fMP4 empty_moov streams fire durationchange on every fragment arrival —
        // without this guard we'd log thousands of no-op corrections.
        if (durRef.current > 0 && Math.abs(safeDur - durRef.current) < 0.01) {
          return;
        }

        if (!isRemux || safeDur > durRef.current) {
          const isEstimate = (window as any).__nobuf_durationIsEstimate === true;

          if (safeDur !== v.duration) {
            console.warn('[Player] durationchange corrected:', v.duration, '→', safeDur, '(real:', realDuration, ')');
          } else {
            console.log('[Player] durationchange:', safeDur, 's (was:', durRef.current, ')');
          }

          if (realDuration <= 0 && isEstimate) {
            // Still only the 4 Mbps estimate: keep the UI at 0:00 until real PTS
            // arrives, but store the estimate for the seek-bar range.
            (window as any).__nobuf_estimateDuration = safeDur;
          } else {
            setDur(safeDur);
            durRef.current = safeDur;
            (window as any).__nobuf_durationIsEstimate = false;
          }
        }
      } else if (!isFinite(v.duration)) {
        // mpegts.js reports Infinity before metadata arrives. Override from the
        // best available source; fall back to the 4 Mbps estimate only if needed.
        let knownDuration = realDuration;
        let isEstimate = realDuration <= 0;

        if (knownDuration <= 0 && file.size > 0) {
          knownDuration = (file.size / 4_000_000) * 8; // unreliable for TS
          isEstimate = true;
        }

        if (knownDuration > 0) {
          const source = isEstimate ? '4Mbps' : (file.duration ? 'Telegram' : 'PTS-tail');
          console.log('[Player] durationchange Infinity → override:', knownDuration.toFixed(1), 's (source:', source, ')');

          if (isEstimate) {
            (window as any).__nobuf_durationIsEstimate = true;
            (window as any).__nobuf_estimateDuration = knownDuration;
            // Don't set durRef/setDur — wait for the real PTS duration.
          } else {
            (window as any).__nobuf_durationIsEstimate = false;
            setDur(knownDuration);
            durRef.current = knownDuration;
          }
        }
      }
    };
    v.addEventListener('durationchange', onDurChange);

    // ── rAF-based buffered ranges polling ──
    // SourceBuffer.remove() and appendBuffer() don't fire 'progress' or
    // 'timeupdate'. After BUFFER_FULL eviction, the white bar shows stale
    // data until the next video event. Poll video.buffered every ~250ms
    // via requestAnimationFrame to ensure real-time bar updates.
    let rafId = 0;
    let lastPollTime = 0;
    const pollBuffered = (now: number) => {
      if (now - lastPollTime >= 250) {
        lastPollTime = now;
        // Suppress buffered ranges update during seek/VBR correction.
        // The initial /stream download goes to the linear estimate (wrong position),
        // shows on the progress bar, then VBR correction flushes SourceBuffers →
        // the indicator disappears. This flash is confusing. Instead, keep the
        // old ranges until VBR correction completes and the video is playing
        // from the correct position.
        if ((window as any).__nobuf_userSeekInProgress !== true) {
          const ranges: [number, number][] = [];
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
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('error', onErr);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('waiting', onWait);
      v.removeEventListener('playing', onPlay2);
      v.removeEventListener('progress', onProgress);
      v.removeEventListener('durationchange', onDurChange);
    };
  }, [streamUrl, playerMseUrl, playerUseNative, playerRemuxUrl, setVideoRef]);

  // Buffer state is already updated by timeupdate and progress events above

  // Auto-hide controls — show on mouse activity, hide after idle during playback.
  // Behavior is gated by the "show pin button" setting:
  //   • OFF (default): control bar is ALWAYS visible — never auto-hides.
  //   • ON: user gets a pin toggle on the bar. Pinned → always visible;
  //         unpinned → auto-hide after a fixed idle delay while playing.
  const lastMousePos = useRef({ x: 0, y: 0 });
  const PIN_AUTO_HIDE_MS = 3000; // fixed idle delay when pin feature is on + unpinned
  const showPinButton = settings.playerShowPinButton;
  useEffect(() => {
    // Pin feature off → controls never auto-hide.
    if (!showPinButton) {
      setVis(true);
      return;
    }
    // Always show controls when paused, settings panel is open, pinned, or
    // while a chip/tray is being dragged (auto-hide mid-drag would abort the drop).
    if (!playing || settingsOpen || controlsPinned || dragKind) {
      setVis(true);
      return;
    }

    let hideTimer: number;

    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        // CSS :hover works with stationary mouse — unlike JS event tracking
        if (playing && !settingsOpen && !controlsPinned && !controlsRef.current?.matches(':hover')) {
          setVis(false);
        }
      }, PIN_AUTO_HIDE_MS);
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
        if (playing && !settingsOpen && !controlsPinned) setVis(false);
      }, 1500);
    };

    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseleave', onMouseLeave);
    return () => {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseleave', onMouseLeave);
      clearTimeout(hideTimer);
    };
  }, [showPinButton, playing, settingsOpen, controlsPinned, dragKind]);

  // Close the customization tray on outside-click or Escape.
  useEffect(() => {
    if (!trayOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-tray-root]')) setTrayOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTrayOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [trayOpen]);

  // While any chip/tray drag is active, force a 'grabbing' cursor everywhere and
  // block text selection — so the cursor reflects drag state across the whole UI.
  useEffect(() => {
    if (!dragKind) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    return () => { document.body.style.cursor = prevCursor; document.body.style.userSelect = prevSelect; };
  }, [dragKind]);

  // Native drag-and-drop hard guard. While the player is mounted, cancel EVERY
  // dragover/drop at the document in the capture phase. Without this, releasing a
  // chip anywhere outside the bar lets the WebView treat the drop as "navigate to
  // this payload" — which reloads the <video> src and throws it to the error
  // screen. Capture-phase on document beats React's synthetic root listeners, so
  // the native default never runs. The bar's own onDrop still gets the event.
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      const onBar = !!(e.target as HTMLElement)?.closest?.('[data-controls-root]');
      // Only hard-cancel drops that land OUTSIDE the control bar. Inside the bar,
      // let React's own onDrop/onDragOver handle it (they preventDefault too).
      if (!onBar) e.preventDefault();
    };
    document.addEventListener('dragover', prevent, true);
    document.addEventListener('drop', prevent, true);
    return () => {
      document.removeEventListener('dragover', prevent, true);
      document.removeEventListener('drop', prevent, true);
    };
  }, []);

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

  const replay = useCallback(() => {
    const v = vidRef.current;
    if (!v) return;
    setVideoEnded(false);
    videoEndedRef.current = false;
    if (playerUseNative) {
      v.play().catch(() => {});
    } else {
      seekTo(0);
      // seekTo sets pendingSeek + restarts download loop; video.play() starts playback
      v.play().catch(() => {});
    }
  }, [playerUseNative, seekTo]);

  useEffect(() => {
    if (pip && vidRef.current) {
      vidRef.current.requestPictureInPicture?.().catch(() => { toast.error('PiP not supported'); setPip(false); });
    } else if (!pip && document.pictureInPictureElement) {
      document.exitPictureInPicture?.().catch(() => {});
    }
  }, [pip]);

  // Keep the `pip` flag (and thus the chip's active color) in sync with the
  // ACTUAL PiP window state. Closing PiP via the window's own X fires
  // 'leavepictureinpicture' without touching our state — without this the chip
  // stays highlighted. Setting state to the value it already holds is a no-op,
  // so this can't ping-pong with the effect above.
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return;
    const onEnter = () => setPip(true);
    const onLeave = () => setPip(false);
    v.addEventListener('enterpictureinpicture', onEnter);
    v.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      v.removeEventListener('enterpictureinpicture', onEnter);
      v.removeEventListener('leavepictureinpicture', onLeave);
    };
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

  const toggle = useCallback(() => { const v = vidRef.current; if (!v) return; if (videoEndedRef.current) { replay(); } else { v.paused ? v.play().catch(() => {}) : v.pause(); } }, [replay]);
  const seek = useCallback((s: number) => {
    const v = vidRef.current;
    if (!v) return null;
    const from = v.currentTime;
    const target = Math.max(0, Math.min(from + s, dur));
    if (playerUseNative) {
      v.currentTime = target;
    } else if (target >= dur) {
      // Seeking to/past the end → directly show replay overlay.
      // Playing through the last fraction of a second with MSE is unreliable
      // (SourceBuffer may lack data, 'ended' event may not fire, and React
      // state prefetchComplete can be stale after backward seeks reset it).
      // Directly ending the video is the most reliable approach.
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
  // Show/refresh the skip feedback overlay. Reads the REAL from/to returned by
  // seek() (live video time, not lagging React state) and accumulates the total
  // jump across a rapid burst of presses so the numbers always match reality.
  const showSkipFeedback = useCallback((dir: 'forward' | 'backward', res: { from: number; to: number } | null) => {
    if (!res) return;
    setVis(true);
    const bursting = skipBurstFrom.current != null;
    const anchor = bursting ? (skipBurstFrom.current as number) : res.from;
    skipBurstFrom.current = anchor;
    // Only bump the key (→ remount → play the entrance animation) when a NEW
    // burst starts. Mid-burst presses keep the same key so the overlay just
    // updates its numbers in place — no jarring re-animation.
    if (!bursting) skipFeedbackKey.current += 1;
    clearTimeout(skipFeedbackTimer.current);
    setSkipFeedback({ direction: dir, from: anchor, to: res.to, totalDelta: res.to - anchor });
    skipFeedbackTimer.current = window.setTimeout(() => { setSkipFeedback(null); skipBurstFrom.current = null; }, 1000);
  }, []);
  const seekFwd = useCallback(() => {
    // When replay overlay is showing, ignore forward seeks — the video
    // has already ended. Pressing space/k calls replay() via toggle().
    if (videoEndedRef.current) return;
    showSkipFeedback('forward', seek(settings.playerSkipForward));
  }, [seek, showSkipFeedback, settings.playerSkipForward]);
  const seekBwd = useCallback(() => {
    // When replay overlay is showing, allow backward seeks — the user
    // wants to re-watch content near the end. Clear videoEnded so the
    // overlay disappears and the video resumes from the new position.
    const wasVideoEnded = videoEndedRef.current;
    if (wasVideoEnded) {
      console.log('[Player] seekBwd while videoEnded=true — clearing overlay, resuming playback');
      setVideoEnded(false);
      videoEndedRef.current = false;
    }
    const res = seek(-settings.playerSkipBackward);
    // Resume playback AFTER the backward seek — must not call play() before
    // seek() because currentTime might be at duration (from MSE guard), and
    // play() at duration fires 'ended' immediately, re-setting videoEnded=true
    // right after we just cleared it. After seek(), currentTime is at the
    // backward position, so play() resumes normally without firing 'ended'.
    if (wasVideoEnded) {
      vidRef.current?.play().catch(() => {});
    }
    showSkipFeedback('backward', res);
  }, [seek, showSkipFeedback, settings.playerSkipBackward]);
  // Fixed 30s jump chips (replace prev/next). Reuse seek() + the side overlay.
  const skip30Fwd = useCallback(() => { if (videoEndedRef.current) return; showSkipFeedback('forward', seek(30)); }, [seek, showSkipFeedback]);
  const skip30Bwd = useCallback(() => { showSkipFeedback('backward', seek(-30)); }, [seek, showSkipFeedback]);
  const setVol2 = useCallback((n: number) => { const v = vidRef.current; if (!v) return; v.volume = Math.max(0, Math.min(1, n)); setVol(v.volume); if (n > 0) { v.muted = false; setMuted(false); } }, []);
  const mute = useCallback(() => { const v = vidRef.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); }, []);
  const fs2 = useCallback(() => { document.fullscreenElement ? document.exitFullscreen() : boxRef.current?.requestFullscreen(); }, []);
  const rate2 = useCallback((r: number) => { const v = vidRef.current; if (v) { v.playbackRate = r; setRate(r); } setMenu(false); }, []);

  // Load a sidecar subtitle file (.srt/.vtt/.ass/.ssa) chosen by the user.
  const loadSubFile = useCallback(async (fileList: FileList | null) => {
    const f = fileList?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const track = new SubtitleTrack(f.name.replace(/\.[^.]+$/, ''), null);
      track.loadText(text);
      subs.activateTrack(subs.addTrack(track));
      toast.success(`Loaded subtitles: ${f.name}`);
    } catch (e) {
      toast.error('Failed to load subtitle file');
      console.error('[Subtitles] sidecar load failed:', e);
    }
  }, [subs]);

  // Toggle an EMBEDDED subtitle track (captions menu → Embedded section).
  // First click extracts via the backend (spinner row while running) and
  // activates; later clicks toggle the already-loaded track without refetch.
  // The choice is persisted per file (-1 = explicitly off) and re-applied on
  // the next open of the same file.
  // Round-14 F4: `origin` distinguishes a human click from the session-restore
  // effect that re-applies a persisted choice on open. Both paths run the SAME
  // extraction — only the FAILURE REPORTING differs. It defaults to 'user' so
  // every existing caller keeps today's behaviour; only the auto-restore site
  // passes 'auto'.
  //
  // Why this exists (14-t:120, forensics C6): on open, the extractor gets the
  // contiguous 0-prefix — 3,670,016 B = 20.8 s of an 8888 s film. Inception's
  // first 20 s is the beach/waves sequence with no dialogue, so ZERO cues is the
  // CORRECT result for that input. The old code still fired
  // "No cues in the downloaded portion yet — try again as more downloads",
  // which is (a) unprompted, (b) wrong (nothing is stalled), and (c) advice the
  // user cannot act on — island mode needs a playhead, and at open there is none.
  const toggleEmbeddedSub = useCallback(async (idx: number, label: string, language: string, origin: 'user' | 'auto' = 'user') => {
    const fileKey = `${activeFolderId ?? 'pub'}:${file.id}`;
    // Already loaded → plain toggle; EXCEPT a track whose cues no longer reach the
    // playhead, which is re-extracted against the island around the viewer.
    //
    // Round-10 P1-2: the old condition was `partial && !active`. That dead-ended:
    // the backend's disk-cache replay omits X-Subs-Partial, so a truncated body
    // arrived as partial:false and could NEVER re-extract (session A: cues for
    // 0-196s of an 8888s film, viewer at 4500s, nothing renderable, no escape).
    // Coverage is now judged from the cue list itself — ground truth about what
    // the user can actually see — so a stale track repairs on the next click even
    // while it is active.
    const existing = embeddedSubTracksRef.current.get(idx);
    const isActive = existing ? subs.activeTracks.includes(existing.track) : false;
    const staleForPlayhead = existing
      ? shouldReExtractSub(
          vidRef.current?.currentTime ?? 0,
          lastCueEnd(existing.track.cues),
          !existing.partial,
          undefined,
          // Round-20: pass the cue INTERVALS so a backward seek into a hole
          // between two islands is seen as uncovered.
          existing.track.cues,
        )
      : false;
    // Re-extract only when the cues can't serve the viewer: stale coverage, or a
    // partial track being switched back ON. Everything else is a plain toggle.
    if (existing && !staleForPlayhead && !(existing.partial && !isActive)) {
      subs.toggleTrack(existing.track);
      persistSubTrack(fileKey, isActive ? -1 : idx);
      return;
    }
    // The persisted-track restore may already be extracting this exact track when
    // the user opens the menu. That request will activate it on success; don't
    // turn a normal early click into an error-looking toast.
    if (embeddedSubLoadingIdxRef.current != null) {
      if (embeddedSubLoadingIdxRef.current !== idx || origin !== 'user') {
        if (origin === 'user') toast.info('Subtitle extraction already running — one moment');
      }
      return;
    }
    // Round-10b: a manual toggle is an explicit human request, so it RESETS the
    // breaker for this track. Automatic repair may have given up; the user
    // asking again must always get a real attempt.
    subBreakerRef.current.delete(`${file.id}:${idx}`);
    embeddedSubLoadingIdxRef.current = idx;
    setEmbeddedSubBusyIdx(idx);
    const genAtStart = embeddedSubFileGenRef.current;
    // Partial re-select: show the old cues IMMEDIATELY while the re-extract runs.
    if (existing) {
      subs.activateTrack(existing.track);
      persistSubTrack(fileKey, idx);
    }
    try {
      const res = await msePlayer.fetchEmbeddedSubText(idx);
      // File switched while extracting: the reset effect already cleared the
      // bookkeeping — drop this result entirely (activating would attach file
      // A's cues to file B; the finally must not clobber B's state either).
      if (embeddedSubFileGenRef.current !== genAtStart) return;
      if ('error' in res) {
        if (origin === 'user' && shouldStagePendingPartialSubTrack(res.error, !!existing)) {
          const track = new SubtitleTrack(label, language || null);
          embeddedSubTracksRef.current.set(idx, { track, partial: true });
          subs.activateTrack(subs.addTrack(track));
          persistSubTrack(fileKey, idx);
          setEmbeddedSubUnavailable((prev) => {
            if (!prev.has(idx)) return prev;
            const next = new Set(prev);
            next.delete(idx);
            return next;
          });
          subRepairAttemptedRef.current.delete(
            `${file.id}:${idx}:${Math.floor((vidRef.current?.currentTime ?? 0) / 120)}`,
          );
          return;
        }
        // Round-14 F4: an AUTOMATIC session-restore must not narrate its own
        // failure. The user did not ask for this extraction, the advice
        // ("try again as more downloads") is wrong at open, and island mode
        // cannot help without a playhead. Record it silently instead — the
        // subtitle button renders a passive "unavailable" marker (F4.5 (b)),
        // which is honest without hijacking the screen.
        //
        // A MANUAL click still reports everything, exactly as before: round-10b
        // fixed a silently-dropped click, and over-suppressing here would
        // reintroduce that defect (F4.2).
        if (!shouldReportSubFailure(origin)) {
          setEmbeddedSubUnavailable((prev) => {
            if (prev.has(idx)) return prev;
            const next = new Set(prev);
            next.add(idx);
            return next;
          });
          return;
        }
        if (res.error === 'empty') toast.info('This subtitle track has no cues');
        else if (res.error === 'empty-partial') {
          // Round-9 I-5: distinguish "nothing new downloaded" from a fresh miss.
          if (res.unchanged) toast.info('Cache front hasn\u2019t advanced — more of the file must download before new cues can appear');
          else toast.info('No cues in the downloaded portion yet — try again as more downloads');
        }
        else if (!existing) toast.error('Subtitle extraction failed');
        // Partial re-extract failure: old cues stay active — nothing to undo.
        return;
      }
      // Round-14 F4: a successful extraction clears any prior "unavailable"
      // marker for this track (the cache front advanced, or the user seeked
      // into a region that has cues).
      setEmbeddedSubUnavailable((prev) => {
        if (!prev.has(idx)) return prev;
        const next = new Set(prev);
        next.delete(idx);
        return next;
      });
      if (existing) {
        // Round-15 R-3: MERGE, never clobber — same defect as the repair path.
        // loadText REPLACES state for ASS (assContent) but APPENDS cues for
        // SRT/VTT (parser.oncue pushes), so the live track cannot be reused
        // directly; parse into a scratch track and union the cue lists.
        const scratch = new SubtitleTrack(null, null);
        scratch.loadText(res.text);
        if (scratch.isASS) {
          existing.track.cues = [];
          existing.track.loadText(res.text);
        } else {
          existing.track.cues = mergeCues(existing.track.cues, scratch.cues);
          existing.track.format = scratch.format;
        }
        existing.partial = res.partial;
        // Re-activate to force the renderer to re-read the cue list.
        subs.deactivateTrack(existing.track);
        subs.activateTrack(existing.track);
        return;
      }
      const track = new SubtitleTrack(label, language || null);
      track.loadText(res.text);
      embeddedSubTracksRef.current.set(idx, { track, partial: res.partial });
      subs.activateTrack(subs.addTrack(track));
      persistSubTrack(fileKey, idx);
    } finally {
      if (embeddedSubFileGenRef.current === genAtStart) {
        embeddedSubLoadingIdxRef.current = null;
        setEmbeddedSubBusyIdx(null);
      }
    }
  }, [subs, msePlayer, activeFolderId, file.id]);

  // Round-10 P1-2: automatic subtitle-coverage repair.
  //
  // Session A: the viewer seeked to 4500s of an 8888s film while the extracted
  // cues covered 0-196s. Nothing rendered, and nothing in the app ever
  // re-extracted — `fetchEmbeddedSubText` had exactly one consumer (a manual
  // click), and even that dead-ended on the `partial` flag. This closes the loop:
  // when an ACTIVE track's cues fall behind the playhead, re-extract against the
  // island around the viewer and swap the cues in place.
  //
  // Driven by the existing timeupdate tick (no new timer, no polling). Guards:
  //   - only for an ACTIVE embedded track (never resurrects a disabled one)
  //   - coverage judged from the cue list, so ASS/jassub tracks (cues stay empty)
  //     report unknown coverage and are left alone
  //   - one repair per playhead REGION, so a still-short result can't spin
  //   - skipped while any extraction is in flight, and generation-guarded so a
  //     file switch mid-fetch discards the result
  const subRepairAttemptedRef = useRef<Set<string>>(new Set());
  // Round-10b: breaker state per (file, track). Survives file switches so
  // "this file's subtitles are broken" is learnable, LRU-bounded so it cannot
  // grow without limit. Keyed the same way as the region ledger.
  const subBreakerRef = useRef<Map<string, SubRepairBreakerState>>(new Map());
  const SUB_BREAKER_LRU_CAP = 32;
  const getBreaker = useCallback((key: string): SubRepairBreakerState => {
    return subBreakerRef.current.get(key) ?? emptySubRepairBreakerState();
  }, []);
  const setBreaker = useCallback((key: string, next: SubRepairBreakerState) => {
    const m = subBreakerRef.current;
    m.delete(key);          // re-insert so Map iteration order is LRU
    m.set(key, next);
    while (m.size > SUB_BREAKER_LRU_CAP) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }, []);
  const maybeRepairSubCoverageRef = useRef<((t: number) => void) | null>(null);
  useEffect(() => {
    maybeRepairSubCoverageRef.current = (playheadS: number) => {
      if (embeddedSubLoadingIdxRef.current != null) return;
      if (!Number.isFinite(playheadS) || playheadS <= 0) return;
      for (const [idx, entry] of embeddedSubTracksRef.current) {
        if (!subs.activeTracks.includes(entry.track)) continue;
        // Round-20: pass the cue INTERVALS. With only `lastCueEnd` this gate
        // silently skipped every backward seek into a hole between two islands
        // (20-c: 7 consecutive seeks, zero requests reached the backend).
        if (!shouldReExtractSub(
          playheadS, lastCueEnd(entry.track.cues), !entry.partial,
          undefined, entry.track.cues,
        )) continue;
        // Round-10b: the breaker gates BEFORE the region ledger. The ledger
        // bounds distinct regions; only the breaker bounds total attempts, and
        // only it can learn that this file is simply not repairable right now.
        const bkey = `${file.id}:${idx}`;
        // Round-27: a backoff is evidence about the REGION it was earned in, not
        // about the file. 26-c: a failure at coverage 2043s bought a 150s ladder,
        // the viewer seeked to 3349s, and subtitles stayed dead for the rest of
        // the session waiting out a penalty earned ~1300s of content away. When
        // the playhead enters a 120s region this track has never attempted, drop
        // the time-based penalties (the `attempts` ceiling deliberately survives,
        // so seeking cannot buy unlimited repairs).
        const regionKey = `${file.id}:${idx}:${Math.floor(playheadS / 120)}`;
        if (!subRepairAttemptedRef.current.has(regionKey)) {
          const stale = getBreaker(bkey);
          if (stale.consecutiveFailures > 0 || stale.open || (stale.consecutiveDefers ?? 0) > 0) {
            setBreaker(bkey, resetSubRepairBreakerForSeek(stale));
            console.log(
              `[SUBS] repair breaker reset for track ${idx}: new region at ${playheadS.toFixed(0)}s ` +
              `(was ${stale.consecutiveFailures} failures, open=${stale.open})`,
            );
          }
        }
        const st = getBreaker(bkey);
        if (!shouldAttemptSubRepair(st, Date.now(), false)) {
          continue;
        }
        // One attempt per ~2-minute region, on top of the breaker: a genuinely
        // uncached region must not re-fetch on every tick.
        if (subRepairAttemptedRef.current.has(regionKey)) continue;
        subRepairAttemptedRef.current.add(regionKey);
        void repairSubCoverage(idx, entry, bkey, playheadS, regionKey);
        return; // one at a time; the backend serialises extractions anyway
      }
    };
  });

  const repairSubCoverage = useCallback(async (
    idx: number,
    entry: { track: SubtitleTrack; partial: boolean },
    bkey: string,
    playheadS: number,
    regionKey?: string,
  ) => {
    if (embeddedSubLoadingIdxRef.current != null) return;
    embeddedSubLoadingIdxRef.current = idx;
    const genAtStart = embeddedSubFileGenRef.current;
    const startedAt = Date.now();
    const before = lastCueEnd(entry.track.cues);
    // Round-20: cue COUNT before the repair. A backward-seek repair fills a hole
    // in the middle of the timeline, which raises the count without moving
    // `lastCueEnd` at all — so the count is what proves it did something.
    const cuesBeforeCount = entry.track.cues?.length ?? 0;
    // Round-16: ASS/SSA keeps `cues` empty (jassub renders `assContent`), so the
    // cue list cannot describe its coverage. Track content length instead.
    const assBeforeLen = entry.track.isASS ? (entry.track.assContent?.length ?? 0) : null;
    const stBefore = getBreaker(bkey);
    const attemptNo = stBefore.attempts + 1;
    let hadError = false;
    let after: number | null = before;
    let assAfterLen: number | null = assBeforeLen;
    // Round-17: the backend's contiguous cache frontier, from X-Subs-Frontier.
    // `reduceSubRepairBreaker` resets the failure counter when this GROWS between
    // attempts — the mechanism that reopens the breaker as data arrives. It was
    // dead code until now because this call site passed a hardcoded `null`.
    let frontierBytes: number | null = null;
    try {
      const res = await msePlayer.fetchEmbeddedSubText(idx);
      if (embeddedSubFileGenRef.current !== genAtStart) return; // file switched
      frontierBytes = res.frontier;
      if ('error' in res) {
        hadError = true;
      } else {
        // Round-15 R-3: MERGE, never clobber. The old code did
        // `entry.track.cues = []; entry.track.loadText(res.text)` — a blind
        // replace that destroyed coverage whenever a later island-mode
        // extraction returned a narrower span (15-c:188: 2300s -> 169s).
        //
        // `cues = []` cannot simply be dropped: loadText APPENDS for SRT/VTT
        // (parser.oncue pushes), so reusing the live track would duplicate every
        // cue. Parse into a scratch track instead, then union the two lists.
        //
        // ASS is exempt: loadText stores `assContent` and leaves `cues` empty
        // (SubtitleTrack.ts:80-86), so there is no cue list to merge and jassub
        // needs the replacement content verbatim.
        const scratch = new SubtitleTrack(null, null);
        scratch.loadText(res.text);
        if (scratch.isASS) {
          entry.track.cues = [];
          entry.track.loadText(res.text);
          assAfterLen = entry.track.assContent?.length ?? 0;
        } else {
          entry.track.cues = mergeCues(entry.track.cues, scratch.cues);
          entry.track.format = scratch.format;
        }
        entry.partial = res.partial;
        after = lastCueEnd(entry.track.cues);
        // Re-activate so the renderer re-reads the cue list.
        subs.deactivateTrack(entry.track);
        subs.activateTrack(entry.track);
      }
    } catch {
      hadError = true;
    } finally {
      // Round-10b: clear UNCONDITIONALLY. The old code only cleared when the
      // generation still matched, so a file switch mid-repair left the flag set
      // and blocked EVERY future repair for the session.
      if (embeddedSubLoadingIdxRef.current === idx) {
        embeddedSubLoadingIdxRef.current = null;
      }
    }
    if (embeddedSubFileGenRef.current !== genAtStart) return;
    const outcome = classifySubRepairOutcome(
      before, after, playheadS, hadError, !entry.partial,
      undefined, assBeforeLen, assAfterLen,
      // Round-17: growth between attempts turns a 204 decline from `failed`
      // (150s ladder) into `deferred` (retry soon, no failure budget spent).
      stBefore.lastFrontierBytes, frontierBytes,
      // Round-20: cue intervals + the pre-repair count, so a backward-seek
      // repair that filled a mid-file hole is scored on what it actually did.
      entry.track.cues, cuesBeforeCount,
    );
    const stAfter = reduceSubRepairBreaker(stBefore, outcome, startedAt, frontierBytes);
    setBreaker(bkey, stAfter);
    const retryDelay = subRepairRegionRetryDelay(outcome);
    if (regionKey && retryDelay != null) {
      if (retryDelay === 0) {
        subRepairAttemptedRef.current.delete(regionKey);
      } else {
        setTimeout(() => {
          if (embeddedSubFileGenRef.current === genAtStart) {
            subRepairAttemptedRef.current.delete(regionKey);
          }
        }, retryDelay);
      }
    }
    const elapsed = Date.now() - startedAt;
    // Round-10b: 12-t.md had 444 identical lines with no counter, so the runaway
    // was invisible until byte totals were summed by hand. Every line now carries
    // attempt n/max, coverage before→after, elapsed ms, and the outcome.
    console.log(
      `[SUBS] repair track ${idx} attempt ${attemptNo}/${SUB_REPAIR_MAX_ATTEMPTS}: ` +
      `${outcome} — ` +
      (assAfterLen != null
        // ASS/SSA has no cue list, so "coverage 2300s" is meaningless for it —
        // report what actually changed (16-c:213 logged `nones → nones`).
        ? `content ${assBeforeLen ?? 0}B → ${assAfterLen}B, `
        : `coverage ${before?.toFixed(0) ?? 'none'}s → ${after?.toFixed(0) ?? 'none'}s, `) +
      `playhead ${playheadS.toFixed(0)}s, ${elapsed}ms`,
    );
    if (stAfter.open && !stBefore.open) {
      console.warn(
        `[SUBS] repair BREAKER OPEN for track ${idx} after ${stAfter.consecutiveFailures} ` +
        `consecutive non-progress attempts — automatic repair suspended for this file. ` +
        `A manual track toggle still forces a retry.`,
      );
    } else if (!stAfter.open && stAfter.consecutiveFailures > 0) {
      console.log(
        `[SUBS] repair backoff for track ${idx}: next attempt in ` +
        `${Math.round(computeSubRepairBackoffMs(stAfter.consecutiveFailures) / 1000)}s`,
      );
    }
  }, [subs, msePlayer, getBreaker, setBreaker]);

  // Reset the per-region repair ledger when the file changes. The BREAKER map
  // deliberately survives: a file known to be unrepairable must stay known.
  useEffect(() => {
    subRepairAttemptedRef.current.clear();
  }, [file.id]);

  // Re-apply the persisted embedded-subtitle choice when the track list for
  // this file materializes (plan §2.4: never auto-enable without a persisted
  // choice; -1 = explicit off, absent = no stored preference).
  const embeddedSubAutoAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    const fileKey = `${activeFolderId ?? 'pub'}:${file.id}`;
    if (embeddedSubAutoAppliedRef.current === fileKey) return; // once per file
    if (msePlayer.embeddedSubTracks.length === 0) return;
    embeddedSubAutoAppliedRef.current = fileKey;
    const persisted = readPersistedSubTrack(fileKey);
    if (persisted == null || persisted < 0) return; // off / no choice
    const t = msePlayer.embeddedSubTracks.find((s) => s.idx === persisted && s.kind === 'text');
    if (!t) return;
    // Round-14 F4: 'auto' — this is session restore, not a human request. A
    // failure here must not toast (forensics C6: it fired on EVERY open of a
    // partially-cached file with a persisted choice).
    void toggleEmbeddedSub(t.idx, t.label, t.language, 'auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msePlayer.embeddedSubTracks, file.id, activeFolderId]);

  // Settings panel resize: drag the left edge. Width is clamped to the player box
  // and persisted so it's remembered across sessions. Panel grows leftward, so a
  // drag to the LEFT (smaller clientX) = wider panel.
  const PANEL_MIN = 260, PANEL_MAX_FRAC = 0.7;
  const startPanelResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    panelResizing.current = true;
    const rect = boxRef.current?.getBoundingClientRect();
    const boxW = rect?.width ?? window.innerWidth;
    const rightEdge = rect?.right ?? window.innerWidth;
    const maxW = Math.max(PANEL_MIN, Math.round(boxW * PANEL_MAX_FRAC));
    const move = (ev: MouseEvent) => {
      if (!panelResizing.current) return;
      const w = Math.max(PANEL_MIN, Math.min(maxW, Math.round(rightEdge - ev.clientX)));
      setPanelDragWidth(w);
    };
    const up = () => {
      panelResizing.current = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      setPanelDragWidth(w => { if (w != null) updateSetting('playerSettingsWidth', w); return null; });
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }, [updateSetting]);

  // ─── Customizable control-bar layout (drag & drop chips between zones) ──────
  // Chips are keyed ids. A sanitized layout guarantees fixed anchors are never
  // in the movable pool and any newly-added chip id shows up (in the tray) so a
  // stale persisted layout can't hide a control. '__tray__' is the ⋯ trigger —
  // positionable on the bar like any chip, but it can never live inside the tray
  // popover (it IS the popover) and must always be present somewhere on the bar.
  const TRAY = '__tray__';
  const ALL_CHIPS = useMemo(() => ['skipBack', 'skipFwd', 'captions', 'audio', 'loop', 'pip', 'speed', 'download', 'settings', 'pin', 'fullscreen', TRAY], []);
  const barLayout = useMemo(() => {
    const raw = settings.playerBarLayout ?? { left: [], right: [], tray: [] };
    const seen = new Set<string>();
    const clean = (arr: string[]) => (arr ?? []).filter(id => ALL_CHIPS.includes(id) && !seen.has(id) && (seen.add(id), true));
    const left = clean(raw.left), right = clean(raw.right);
    // The ⋯ trigger can't be parked inside its own popover — pull it out if stale
    // layout put it there, and guarantee it lands on the bar (default: right end).
    const tray = clean(raw.tray).filter(id => id !== TRAY);
    if (!seen.has(TRAY)) { right.push(TRAY); seen.add(TRAY); }
    const missing = ALL_CHIPS.filter(id => id !== TRAY && !seen.has(id)); // any unplaced chip → tray
    return { left, right, tray: [...tray, ...missing] };
  }, [settings.playerBarLayout, ALL_CHIPS]);

  const moveChip = useCallback((chip: string, zone: 'left' | 'right' | 'tray', index?: number) => {
    const next = { left: [...barLayout.left], right: [...barLayout.right], tray: [...barLayout.tray] };
    const from = (['left', 'right', 'tray'] as const).find(z => next[z].includes(chip));
    const fromIdx = from ? next[from].indexOf(chip) : -1;
    next.left = next.left.filter(c => c !== chip);
    next.right = next.right.filter(c => c !== chip);
    next.tray = next.tray.filter(c => c !== chip);
    // index is a FULL-array slot (counted with the dragged chip still present).
    // When moving within the same zone from an earlier slot, removal shifts the
    // target left by one — adjust so the chip lands exactly where the bar showed.
    let target = index;
    if (target != null && from === zone && fromIdx !== -1 && fromIdx < target) target -= 1;
    if (target == null || target < 0 || target > next[zone].length) next[zone].push(chip);
    else next[zone].splice(target, 0, chip);
    updateSetting('playerBarLayout', next);
  }, [barLayout, updateSetting]);
  // Which side of the row a free-area drop lands on (X vs horizontal midpoint).
  const sideFromX = useCallback((clientX: number): 'left' | 'right' => {
    const rect = controlsRef.current?.getBoundingClientRect();
    return rect && clientX > rect.left + rect.width / 2 ? 'right' : 'left';
  }, []);
  // FULL-array insertion index within a side (counts ALL chips, including the
  // dragged one) so the visual insertion bar and the final landing slot agree.
  const indexFromX = useCallback((side: 'left' | 'right', clientX: number): number => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(`[data-chip-zone="${side}"] [data-chip-id]`));
    let idx = 0;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (clientX > r.left + r.width / 2) idx++; else break;
    }
    return idx;
  }, []);
  // Unified free-area drop on the buttons row. The ⋯ tray is now just another
  // chip (id=TRAY), so a single path handles every draggable — insert at the
  // aimed slot on whichever side the cursor is over.
  const onRowDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation(); // don't let the container's stray-drop swallow handler also fire
    lastDragEndRef.current = Date.now(); // stamp recency here too: a reordered tray node's onDragEnd may not fire
    const side = sideFromX(e.clientX);
    if (dragChip) moveChip(dragChip, side, indexFromX(side, e.clientX));
    setDragChip(null);
    setDragKind(null);
    setDropSide(null);
    setDropIndex(null);
  }, [moveChip, sideFromX, indexFromX, dragChip]);
  const onTrayDrop = useCallback(() => {
    lastDragEndRef.current = Date.now(); // stamp recency: guards the phantom post-drop click on the X button
    if (dragChip) moveChip(dragChip, 'tray');
    setDragChip(null);
    setDropSide(null);
    setDragKind(null);
  }, [moveChip, dragChip]);

  const onBarClick = useCallback((e: React.MouseEvent) => {
    if (!barRef.current || !vidRef.current || !isFinite(dur) || dur <= 0) return;
    // If replay overlay is showing, clicking the progress bar means the user
    // wants to resume from that position. Clear videoEnded and proceed.
    if (videoEndedRef.current) {
      setVideoEnded(false);
      videoEndedRef.current = false;
    }
    const r = barRef.current.getBoundingClientRect();
    const targetTime = ((e.clientX - r.left) / r.width) * dur;
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
      setTime(targetTime); // Instant UI update before debounce/recreation
      seekTo(targetTime);
    }
  }, [dur, playerUseNative, seekTo]);

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
        // Not cached: show spinner if thumbnails CAN be generated.
        // - Native mode: hidden video can seek to any position
        // - MP4 MSE: mini pipeline + moov buffer enables on-demand capture
        // - Transmuxer (MKV/TS): second transmuxer instance + hidden video + MSE
        // - TS via fMP4 backend: Fmp4ThumbnailPipeline (backend /fmp4/segment)
        // - MP4-HEVC→/remux reroute: backend /thumb (server-side ffmpeg JPEG)
        const canGenerateThumbnails = playerUseNative
          || (thumbnailDataReady && moovBufferReady)
          || isTransmuxer()
          || (thumbnailDataReady && mseGetters?.isFmp4Stream())
          || (thumbnailDataReady && !!mseGetters?.getRemuxThumbConfig?.());
        if (canGenerateThumbnails) {
          setThumbUrl(null);
          setThumbLoading(true);

          // Cancel previous debounce timer
          clearTimeout(hoverDebounceRef.current);
          hoverDebounceRef.current = window.setTimeout(() => {
            setDesiredHoverTime(hoverTime);
          }, 1000);
        } else {
          setThumbUrl(null);
          setThumbLoading(false);
          clearDesiredHover();
        }
      }
    }
  }, [dur, getCachedThumbnailSync, setDesiredHoverTime, clearDesiredHover, thumbnailDataReady, moovBufferReady, mseGetters]);

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
        case 'escape':
          e.preventDefault();
          // Swallow the synthetic Escape the WebView fires when a native chip drag
          // is cancelled (arrives within a few ms of dragend). A deliberate user
          // Escape always lands well after any drag, so this only eats the
          // drag-cancel artifact — never a real close request.
          if (dragActiveRef.current || Date.now() - lastDragEndRef.current < 350) break;
          document.fullscreenElement ? document.exitFullscreen() : handleClose();
          break;
        case 'j': e.preventDefault(); seekBwd(); break;
        case 'l': e.preventDefault(); seekFwd(); break;
        case ',': e.preventDefault(); rate2(Math.max(0.25, rate - 0.25)); break;
        case '.': e.preventDefault(); rate2(Math.min(4, rate + 0.25)); break;
        case '<': e.preventDefault(); rate2(Math.max(0.25, rate / 2)); break;
        case '>': e.preventDefault(); rate2(Math.min(4, rate * 2)); break;
        case 'c':
          e.preventDefault();
          // Toggle subtitles: if none loaded, no-op; if none active, enable the
          // first track; otherwise toggle off/on remembering the last-active set.
          if (subs.tracks.length === 0) break;
          if (subs.activeTracks.length === 0 && !subs.hasLastActive) subs.activateTrack(subs.tracks[0]);
          else subs.toggleSubtitles();
          break;
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [toggle, seek, setVol2, mute, fs2, handleClose, onNext, onPrev, vol, rate, rate2, dur, subs]);

  const pct = dur > 0 ? (time / dur) * 100 : 0;

  // Duration used ONLY for the prebuffer/green bar + buffer-ahead readout. The
  // seek-bar `dur` is intentionally held at 0 on the remux path until the real
  // PTS duration is confirmed (avoids a wrong growing-duration seek bar). But the
  // accurate PTS duration (__nobuf_ptsDuration) is known ~2s after open — ~10s
  // before `dur` is set — and gating the green bar / buffer-ahead on `dur > 0`
  // left them dark for that whole window even though cached ranges existed. Fall
  // back to the PTS (then estimate) duration so those indicators light up
  // immediately. Does NOT touch the seek bar / time readout.
  const barDur = dur || (window as any).__nobuf_ptsDuration || (window as any).__nobuf_estimateDuration || 0;

  // Chip registry: id → button JSX. Each movable control lives here once and is
  // placed by the persisted layout into left/right/tray zones.
  const chipButton = (id: string): { el: React.ReactNode; label: string } => {
    switch (id) {
      case 'skipBack': return { label: 'Back 30s', el:
        <button onClick={skip30Bwd} className="p-1.5 hover:bg-white/10 rounded text-white" title="Back 30s">
          <svg className="w-5 h-5 block" fill="currentColor" viewBox="0 0 24 24"><path d="M12.5 3C7.81 3 4 6.81 4 11.5S7.81 20 12.5 20s8.5-3.81 8.5-8.5c0-.53-.05-1.05-.14-1.55l-1.63.55c.05.33.07.66.07 1 0 3.58-2.92 6.5-6.5 6.5S6 15.08 6 11.5 8.92 5 12.5 5V8l4-4-4-4v3z" transform="scale(-1,1) translate(-24,0)"/><text x="12" y="15" fontSize="8" fontFamily="monospace" fill="currentColor" textAnchor="middle" fontWeight="bold">30</text></svg>
        </button> };
      case 'skipFwd': return { label: 'Forward 30s', el:
        <button onClick={skip30Fwd} className="p-1.5 hover:bg-white/10 rounded text-white" title="Forward 30s">
          <svg className="w-5 h-5 block" fill="currentColor" viewBox="0 0 24 24"><path d="M12.5 3C7.81 3 4 6.81 4 11.5S7.81 20 12.5 20s8.5-3.81 8.5-8.5c0-.53-.05-1.05-.14-1.55l-1.63.55c.05.33.07.66.07 1 0 3.58-2.92 6.5-6.5 6.5S6 15.08 6 11.5 8.92 5 12.5 5V8l4-4-4-4v3z"/><text x="12" y="15" fontSize="8" fontFamily="monospace" fill="currentColor" textAnchor="middle" fontWeight="bold">30</text></svg>
        </button> };
      case 'captions': return { label: 'Subtitles', el:
        <div className="relative">
          <button onClick={(e) => { e.stopPropagation(); setSubMenu(m => !m); }} className={`p-1.5 hover:bg-white/10 rounded transition-colors ${subs.activeTracks.length ? 'text-nobuf-primary' : 'text-white'}`} title="Subtitles">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>
          </button>
          {subMenu && (
            <div className="absolute bottom-full right-0 mb-2 bg-black/95 border border-white/10 rounded-lg overflow-hidden min-w-[180px] max-h-72 overflow-y-auto z-50 shadow-2xl py-1" onClick={e => e.stopPropagation()}>
              <button onClick={() => { subs.activeTracks.forEach(subs.deactivateTrack); persistSubTrack(`${activeFolderId ?? 'pub'}:${file.id}`, -1); }} className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 ${subs.activeTracks.length === 0 ? 'text-nobuf-primary font-semibold' : 'text-white'}`}>Off</button>
              {subs.tracks.map((t, i) => (
                <button key={i} onClick={() => subs.toggleTrack(t)} className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 truncate ${subs.activeTracks.includes(t) ? 'text-nobuf-primary bg-nobuf-primary/10 font-semibold' : 'text-white'}`}>
                  {t.label || t.language || `Track ${i + 1}`}{t.isASS ? ' (ASS)' : ''}
                </button>
              ))}
              {(msePlayer.embeddedSubTracks.length > 0 || msePlayer.embeddedSubsLoading) && (
                <div className="border-t border-white/10 mt-1 pt-1">
                  <div className="px-3 py-1 text-[11px] uppercase tracking-wider text-white/40 select-none">Embedded</div>
                  {msePlayer.embeddedSubsLoading && msePlayer.embeddedSubTracks.length === 0 && (
                    <div className="px-3 py-1.5 text-sm text-white/50">Scanning tracks…</div>
                  )}
                  {msePlayer.embeddedSubTracks.map((t) => {
                    const loaded = embeddedSubTracksRef.current.get(t.idx);
                    const active = !!loaded && subs.activeTracks.includes(loaded.track);
                    const busy = embeddedSubBusyIdx === t.idx;
                    // Round-14 F4.5(b): a silent auto-restore failure surfaces
                    // here instead of as a toast. Suppressed while busy/active.
                    const unavailable = embeddedSubUnavailable.has(t.idx) && !busy && !active;
                    const disabled = t.kind !== 'text' || busy;
                    return (
                      <button
                        key={t.idx}
                        disabled={disabled}
                        title={t.kind !== 'text'
                          ? 'Image-based subtitles — not supported'
                          : unavailable
                            ? 'No cues in the downloaded portion yet — click to retry'
                            : t.label}
                        onClick={() => { void toggleEmbeddedSub(t.idx, t.label, t.language); }}
                        className={`block w-full text-left px-3 py-1.5 text-sm truncate ${
                          t.kind !== 'text'
                            ? 'text-white/30 cursor-not-allowed'
                            : active
                              ? 'text-nobuf-primary bg-nobuf-primary/10 font-semibold hover:bg-white/10'
                              : 'text-white hover:bg-white/10'
                        }`}
                      >
                        {busy
                          ? `${t.label} — extracting…`
                          : `${t.label}${t.kind !== 'text' ? ' (image-based)' : ''}`}
                        {unavailable && <span className="text-white/40"> — not downloaded yet</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="border-t border-white/10 mt-1 pt-1">
                <button onClick={() => { setSubMenu(false); subFileInputRef.current?.click(); }} className="block w-full text-left px-3 py-1.5 text-sm text-white/80 hover:bg-white/10">Load subtitle file…</button>
              </div>
            </div>
          )}
        </div> };
      case 'audio': {
        // Audio-track menu — visual twin of the captions chip. Hidden entirely
        // when the file has ≤1 audio track (no dead UI). Switching rebuilds the
        // pipeline like a seek and NEVER unpauses a paused player.
        const aTracks = msePlayer.audioTracks;
        if (aTracks.length <= 1) return { label: 'Audio', el: null };
        const nonDefaultActive = msePlayer.activeAudioTrackId != null
          && aTracks.some(t => t.id === msePlayer.activeAudioTrackId && !t.isDefault);
        return { label: 'Audio', el:
        <div className="relative">
          <button onClick={(e) => { e.stopPropagation(); setAudioMenu(m => !m); }} className={`p-1.5 hover:bg-white/10 rounded transition-colors ${nonDefaultActive ? 'text-nobuf-primary' : 'text-white'}`} title="Audio track">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
          </button>
          {audioMenu && (
            <div className="absolute bottom-full right-0 mb-2 bg-black/95 border border-white/10 rounded-lg overflow-hidden min-w-[180px] max-h-72 overflow-y-auto z-50 shadow-2xl py-1" onClick={e => e.stopPropagation()}>
              {aTracks.map((t) => (
                <button
                  key={t.id}
                  disabled={audioSwitching || !t.playable}
                  onClick={async () => {
                    setAudioMenu(false);
                    if (t.id === msePlayer.activeAudioTrackId) return;
                    setAudioSwitching(true);
                    const ok = await msePlayer.switchAudioTrack(t.id);
                    setAudioSwitching(false);
                    if (!ok) toast.error('Audio switch failed — reverted');
                  }}
                  className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 truncate ${
                    t.id === msePlayer.activeAudioTrackId
                      ? 'text-nobuf-primary bg-nobuf-primary/10 font-semibold'
                      : t.playable ? 'text-white' : 'text-white/40 cursor-not-allowed'
                  }`}
                >
                  {t.label}{!t.playable ? ' (unsupported)' : ''}
                </button>
              ))}
            </div>
          )}
        </div> };
      }
      case 'loop': return { label: 'Loop', el:
        <button onClick={() => setLoop(l => !l)} className={`p-1.5 hover:bg-white/10 rounded transition-colors ${loop ? 'text-nobuf-primary' : 'text-white'}`} title={loop ? 'Loop on' : 'Loop off'}>
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
        </button> };
      case 'pip': return { label: 'Picture-in-Picture', el:
        <button onClick={() => setPip(p => !p)} className={`p-1.5 hover:bg-white/10 rounded transition-colors ${pip ? 'text-nobuf-primary' : 'text-white'}`} title="Picture-in-Picture">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z"/></svg>
        </button> };
      case 'speed': return { label: 'Speed', el:
        <div className="relative">
          <button onClick={() => setMenu(!menu)} className={`px-1.5 py-1 hover:bg-white/10 rounded text-xs font-mono font-semibold flex items-center gap-1 ${rate !== 1 ? 'text-nobuf-primary' : 'text-white'}`} title="Playback speed">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            {rate}x
          </button>
          {menu && (
            <div className="absolute bottom-full right-0 mb-2 bg-black/95 border border-white/10 rounded-lg overflow-hidden min-w-[64px] max-h-64 overflow-y-auto z-50 shadow-2xl">
              {RATES.map(r => (<button key={r} onClick={() => rate2(r)} className={`block w-full text-left px-3 py-1.5 text-sm font-mono hover:bg-white/10 ${rate === r ? 'text-nobuf-primary bg-nobuf-primary/10 font-semibold' : 'text-white'}`}>{r}x</button>))}
            </div>
          )}
        </div> };
      case 'download': return { label: 'Download', el:
        <button onClick={handleDownload} className="p-1.5 hover:bg-white/10 rounded flex items-center gap-1" title="Download">
          <svg className={`w-5 h-5 ${dlOverlay?.active && !dlOverlay?.completed ? 'text-nobuf-primary animate-blink' : 'text-white'}`} fill="currentColor" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" /></svg>
          {dlOverlay?.active && !dlOverlay?.completed && (<span className="text-xs font-mono text-nobuf-primary">{Math.round(dlOverlay.percent)}%</span>)}
        </button> };
      case 'settings': return { label: 'Settings', el:
        <button onClick={(e) => { e.stopPropagation(); setSettingsOpen(prev => !prev); }} className="p-1.5 hover:bg-white/10 rounded text-white" title="Settings">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.6 3.6 0 0112 15.6z" /></svg>
        </button> };
      case 'pin': return showPinButton ? { label: 'Pin', el:
        <button onClick={() => setControlsPinned(p => !p)} className={`p-1.5 hover:bg-white/10 rounded transition-colors ${controlsPinned ? 'text-nobuf-primary' : 'text-white/50'}`} title={controlsPinned ? 'Unpin controls (auto-hide)' : 'Pin controls (always show)'}>
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" style={{ transform: controlsPinned ? 'rotate(0deg)' : 'rotate(45deg)', transition: 'transform 200ms' }}><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" /></svg>
        </button> } : { label: 'Pin', el: null };
      case 'fullscreen': return { label: 'Fullscreen', el:
        <button onClick={fs2} className="p-1.5 hover:bg-white/10 rounded text-white" title="Fullscreen (F)">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">{fs ? <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" /> : <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />}</svg>
        </button> };
      default: return { label: id, el: null };
    }
  };
  // Render a draggable chip. IMPORTANT: this is a plain function, NOT a nested
  // component — a nested component gets a new identity on every setDragChip and
  // React remounts the node mid-drag, which cancels the native drag. A function
  // returns stable element types so the drag survives.
  const renderChip = (id: string) => {
    if (id === TRAY) return renderTray();
    const { el, label } = chipButton(id);
    if (!el) return null;
    return (
      <div
        key={id}
        draggable
        onDragStart={(e) => {
          markDragStart();
          setDragChip(id);
          setDragKind('chip');
          // If this chip lives in the tray, collapse the popover so its empty
          // space doesn't linger. Deferred a tick: collapsing synchronously here
          // unmounts the chip mid-dragstart and the native drag aborts. Drag-over
          // the ⋯ reopens it.
          if (barLayout.tray.includes(id)) setTimeout(() => setTrayOpen(false), 0);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id); // required or the webview aborts the drag
        }}
        onDragEnd={() => { markDragEnd(); setDragChip(null); setDragKind(null); setDropSide(null); setDropIndex(null); }}
        title={`${label} — drag to move`}
        data-chip-id={id}
        className={`transition-all duration-150 cursor-grab active:cursor-grabbing ${dragChip === id ? 'opacity-30 scale-90' : 'opacity-100 hover:-translate-y-0.5'}`}
      >
        {el}
      </div>
    );
  };

  // Render a side's chips with a vertical insertion bar at the live drop slot.
  const insertBar = (key: string) => (
    <div key={key} className="w-0.5 h-6 rounded-full bg-nobuf-primary shadow-[0_0_8px_rgba(29,252,159,0.8)] animate-[barPulse_0.8s_ease-in-out_infinite]" />
  );
  const renderZone = (side: 'left' | 'right') => {
    const ids = barLayout[side];
    // Show the insertion bar only when dropping here would ACTUALLY move the chip.
    // A drop is a no-op when the chip is already in this side and the target slot
    // is its current index or the slot immediately after it — suppress the bar then.
    let showBar = dragKind === 'chip' && dropSide === side && dropIndex != null;
    if (showBar && dragChip) {
      const cur = ids.indexOf(dragChip);
      if (cur !== -1 && (dropIndex === cur || dropIndex === cur + 1)) showBar = false;
    }
    // NOTE: never filter out the dragged chip — unmounting the drag source cancels
    // the native drag. Keep every chip mounted; the dragged one just dims.
    const out: React.ReactNode[] = [];
    ids.forEach((id, i) => {
      if (showBar && dropIndex === i) out.push(insertBar(`bar-${side}`));
      out.push(renderChip(id));
    });
    if (showBar && dropIndex! >= ids.length) out.push(insertBar(`bar-${side}-end`));
    return <span data-chip-zone={side} className="flex items-center gap-1">{out}</span>;
  };

  // The ⋯ trigger renders as a positional chip (data-chip-id=TRAY) so it flows
  // through the SAME unified drag/insertion logic as every other button. It's also
  // a drop target: drop a chip on it to park that chip in the popover.
  const traySide: 'left' | 'right' = barLayout.left.includes(TRAY) ? 'left' : 'right';
  const renderTray = () => (
    <div
      key={TRAY}
      data-chip-id={TRAY}
      data-tray-root
      className={`relative transition-all duration-150 ${dragChip === TRAY ? 'opacity-30 scale-90' : 'opacity-100'}`}
    >
      <button
        draggable
        onDragStart={(e) => {
          markDragStart();
          setDragChip(TRAY);
          setDragKind('chip');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', TRAY);
          setTrayOpen(false); // collapse while dragging the trigger itself
        }}
        onDragEnd={() => { markDragEnd(); setDragChip(null); setDragKind(null); setDropSide(null); setDropIndex(null); }}
        onClick={() => setTrayOpen(o => !o)}
        onDragOver={(e) => { if (dragKind === 'chip' && dragChip !== TRAY) { e.preventDefault(); e.stopPropagation(); setDropSide('tray'); setTrayOpen(true); } }}
        onDrop={(e) => { if (dragKind === 'chip' && dragChip !== TRAY) { e.preventDefault(); e.stopPropagation(); onTrayDrop(); } }}
        title="Customize controls — drag icons out to the bar, or drag me to reposition"
        className={`p-1.5 rounded transition-all duration-150 cursor-grab active:cursor-grabbing ${trayOpen || dropSide === 'tray' ? 'bg-white/15 text-nobuf-primary' : 'hover:bg-white/10 text-white hover:-translate-y-0.5'}`}
      >
        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
      </button>
      {trayOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          onDragOver={(e) => { if (dragKind === 'chip' && dragChip !== TRAY && !barLayout.tray.includes(dragChip!)) { e.preventDefault(); e.stopPropagation(); setDropSide('tray'); } }}
          onDrop={(e) => { if (dragKind === 'chip' && dragChip !== TRAY && !barLayout.tray.includes(dragChip!)) { e.preventDefault(); e.stopPropagation(); onTrayDrop(); } }}
          className={`absolute bottom-full ${traySide === 'right' ? 'right-0' : 'left-0'} mb-0.5 p-2 rounded-xl bg-black/95 border backdrop-blur-xl shadow-2xl z-50 transition-colors ${dropSide === 'tray' ? 'border-nobuf-primary/60 ring-1 ring-nobuf-primary/40' : 'border-white/10'}`}
        >
          <div className="text-[10px] uppercase tracking-wider text-white/40 px-1 pb-1.5 whitespace-nowrap">Drag to the bar · drop here to park</div>
          <div className="flex flex-wrap gap-1 max-w-[220px] min-w-[120px]">
            {barLayout.tray.map(id => renderChip(id))}
            {barLayout.tray.length === 0 && (
              <span className="text-white/30 text-xs px-1 py-2">Empty — drag icons here to park them.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div
      ref={boxRef}
      className="fixed inset-0 z-50 bg-black flex flex-col select-none"
      onDragOver={(e) => { if (dragKind) e.preventDefault(); }}
      onDrop={(e) => {
        // Stray chip drop outside the bar (e.g. over the video). Swallow it so the
        // webview never tries to navigate to the drag payload — that was crashing
        // the player to the "Video error: unknown" screen. Just cancel the drag.
        if (dragKind) { e.preventDefault(); setDragChip(null); setDragKind(null); setDropSide(null); setDropIndex(null); }
      }}
    >
      {/* Hidden file input for sidecar subtitle loading (.srt/.vtt/.ass/.ssa) */}
      <input
        ref={subFileInputRef}
        type="file"
        accept=".srt,.vtt,.ass,.ssa"
        className="hidden"
        onChange={(e) => { loadSubFile(e.target.files); e.target.value = ''; }}
      />
      {/* Video - FastStream's DirectVideoPlayer approach */}
      <div className="flex-1 flex items-center justify-center min-h-0 relative cursor-pointer" onClick={toggle} onDoubleClick={fs2}>
        {err ? (
          <div className="text-center px-8">
            <div className="text-amber-400 text-lg mb-2">{err}</div>
            {playerUnsupportedCodec ? (
              <div className="flex gap-3 justify-center">
                <button onClick={handleDownload} className="px-4 py-2 bg-nobuf-primary/15 hover:bg-nobuf-primary/25 text-nobuf-primary rounded-lg transition-colors">Download Video</button>
                <button onClick={handleClose} className="px-4 py-2 bg-white/10 hover:bg-white/20 text-nobuf-subtext rounded-lg transition-colors">Close</button>
              </div>
            ) : (
              <>
                <div className="text-gray-500 text-xs break-all max-w-md mb-4">{lastVideoSrc || streamUrl}</div>
                <button onClick={handleClose} className="px-4 py-2 bg-nobuf-primary/15 hover:bg-nobuf-primary/25 text-nobuf-primary rounded-lg transition-colors">Close</button>
              </>
            )}
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
        {!err && (
          <SubtitleOverlay vidRef={vidRef} activeTracks={subs.activeTracks} currentTime={time} assFonts={msePlayer.getEmbeddedSubFontUrls()} />
        )}
        {load && !err && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
          </div>
        )}
        {/* Cold-start optimization overlay — phase-aware messaging with dynamic progress */}
        {(showColdStartOverlay || isRemuxLoading) && !err && (
          <div className={`absolute inset-x-0 top-0 bottom-16 flex items-center justify-center z-30 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${(isColdStartBuffering || isRemuxLoading) ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
            <div className="flex flex-col items-center gap-4 max-w-md px-6">
              {/* Spinner */}
              <div className="relative w-16 h-16">
                <div className="absolute inset-0 border-4 border-nobuf-primary/20 rounded-full" />
                <div className="absolute inset-0 border-4 border-transparent border-t-nobuf-primary rounded-full animate-spin" />
                {/* Format badge */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-nobuf-primary text-xs font-bold uppercase tracking-wider">
                    {detectedFormat === 'ts' ? 'TS' : detectedFormat === 'mp4' ? 'MP4' : detectedFormat === 'mkv' ? 'MKV' : ''}
                  </span>
                </div>
              </div>
              {/* Phase-aware title + subtitle */}
              <div className="text-center">
                <div className="text-white text-lg font-semibold mb-1">
                  {coldStartPhase === 'fetching_metadata' ? 'Reading video metadata' :
                   coldStartPhase === 'buffering' ? 'Optimizing for smooth playback' :
                   coldStartPhase === 'initializing_player' ? 'Preparing video stream' :
                   'Preparing video'}
                </div>
                <div className="text-white/50 text-sm">
                  {coldStartPhase === 'fetching_metadata' ? 'Locating video structure for instant start' :
                   coldStartPhase === 'buffering' ? 'Pre-loading data to prevent buffering' :
                   coldStartPhase === 'initializing_player' ? 'Converting format for seamless playback' :
                   'Ensuring buffer-free experience'}
                </div>
              </div>
              {/* Progress bar — only for buffering phase with known target */}
              {coldStartProgress.targetBytes > 0 && coldStartPhase === 'buffering' && (
                <>
                  <div className="text-white/60 text-sm font-mono">
                    {formatBytes(coldStartProgress.bytes)} / {formatBytes(coldStartProgress.targetBytes)}
                  </div>
                  <div className="w-64 h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-nobuf-primary to-nobuf-primary/70 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${Math.min(100, (coldStartProgress.bytes / coldStartProgress.targetBytes) * 100)}%` }}
                    />
                  </div>
                </>
              )}
              {/* Indeterminate bar for metadata or initializing phase */}
              {(coldStartPhase === 'fetching_metadata' || coldStartPhase === 'initializing_player') && (
                <div className="w-64 h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-nobuf-primary to-transparent rounded-full animate-[shimmer_1.5s_ease-in-out_infinite]" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Persistent mini progress bar + speed — visible when controls are hidden */}
      {miniBarVisible && !err && dur > 0 && (
        <div className="absolute bottom-[2px] left-0 right-0 z-40 pointer-events-none transition-opacity duration-300">
          <div className="flex items-center justify-end gap-1 px-2 pb-0.5">
            {!prefetchComplete && (
              <button
                onClick={(e) => { e.stopPropagation(); prefetchPaused ? resumePrefetch() : pausePrefetch(); }}
                className="pointer-events-auto hover:bg-white/10 rounded p-0.5"
                title={prefetchPaused ? 'Resume buffering' : 'Pause buffering'}
              >
                {prefetchPaused ? (
                  <svg className="w-3 h-3 text-white/60" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                ) : (
                  <svg className="w-3 h-3 text-white/60" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
                )}
              </button>
            )}
            <span className="text-[10px] font-mono text-white/60 bg-black/40 px-1.5 py-0.5 rounded">
              {(() => { const s = speedMeterValue(greenBarSpeed, prefetchPaused); return s > 0 ? formatSpeed(s) : '—'; })()}
            </span>
          </div>
          <div className="relative h-[2px] bg-white/20">
            <div className="absolute inset-y-0 left-0 bg-red-500 rounded-full" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {/* Controls - FastStream-style */}
      <div
        ref={controlsRef}
        data-controls-root
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
          className="relative cursor-pointer group mb-1 mx-1 py-3"
          onClick={onBarClick}
          onMouseMove={onBarMove}
          onMouseLeave={() => {
            setTip(p => ({ ...p, show: false }));
            clearTimeout(hoverDebounceRef.current);
            clearDesiredHover();
            // Clear thumbnail loading state — spinner should disappear
            // immediately when mouse leaves the progress bar
            setThumbLoading(false);
            setThumbUrl(null);
            lastThumbTimeRef.current = -1;
          }}
        >
          {/* Visual bar track */}
          <div className="relative h-4 bg-white/20 rounded-full group-hover:h-5 transition-all">
            {/* White bar — SourceBuffer memory (in-memory data visible to the player).
                Shows the ENTIRE SourceBuffer range: from start to end of each buffered
                range (both behind and ahead of playhead). This represents the 10min
                backward + 10min forward buffer window. Base layer (z-0) so red bar
                draws on top.
                Updated in real-time via 'progress' and 'timeupdate' events. */}
            {bufferedRanges.length > 0 && dur > 0 && (() => {
              return bufferedRanges.map(([ts, te], i) => {
                const leftPct = (ts / dur) * 100;
                const widthPct = ((te - ts) / dur) * 100;
                return (
                  <div
                    key={`mem-${i}`}
                    className="absolute inset-y-0 bg-white/40 rounded-full z-0"
                    style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.15)}%` }}
                  />
                );
              });
            })()}
            {/* Playback position (red) — z-10, ON TOP of white bar */}
            <div className="absolute inset-y-0 left-0 bg-red-500 rounded-full z-10" style={{ width: `${pct}%` }} />
            {/* Green bar — disk + shadow cache (thin, above red bar, bottom edge) */}
            {cachedTimeRanges.length > 0 && barDur > 0 && (() => {
              // Merge overlapping cached ranges
              const sorted = [...cachedTimeRanges].sort((a, b) => a[0] - b[0]);
              const merged: [number, number][] = [];
              for (const r of sorted) {
                // Merge overlapping ranges with tight tolerance (0.01s).
                // Do NOT bridge the gap between /stream and PROACTIVE ranges.
                // The gap should be EMPTY — no fake fill. The user sees two
                // separate green bars: one at the seek point (/stream) and one
                // 40s ahead (PROACTIVE). As /stream progresses, the first bar
                // grows until it meets the second bar, then they merge naturally.
                if (merged.length === 0 || r[0] > merged[merged.length - 1][1] + 0.01) {
                  merged.push([r[0], r[1]]);
                } else {
                  merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
                }
              }
              return merged.map(([ts, te], i) => {
                const leftPct = (ts / barDur) * 100;
                const widthPct = ((te - ts) / barDur) * 100;
                return (
                  <div
                    key={`cache-${i}`}
                    className="absolute bottom-0 h-[3px] bg-green-400/70 rounded-full z-20"
                    style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.2)}%` }}
                  />
                );
              });
            })()}
            {/* Preview thumbnail coverage — yellow bar (thin, above red bar, top edge) */}
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
                    className="absolute top-0 h-[3px] bg-yellow-400/70 rounded-full z-30"
                    style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.2)}%` }}
                  />
                );
              });
            })()}

          </div>
          {/* Tooltip with WebCodecs thumbnail */}
          {tip.show && (() => {
            const barWidth = barRef.current?.getBoundingClientRect().width ?? 0;
            const tooltipHalf = 120;
            const clampedX = Math.max(tooltipHalf, Math.min(tip.x, barWidth - tooltipHalf));
            return (
              <div className="absolute pointer-events-none flex flex-col items-center" style={{ left: clampedX, bottom: '100%', marginBottom: '8px', transform: 'translateX(-50%)' }}>
                {thumbUrl ? (
                  <img
                    src={thumbUrl}
                    className="rounded overflow-hidden border border-white/20 mb-1 shadow-lg"
                    style={{ width: 228, height: 128, objectFit: 'cover' }}
                    alt=""
                  />
                ) : thumbLoading ? (
                  <div className="w-[228px] h-[128px] rounded border border-white/20 mb-1 bg-white/5 flex items-center justify-center">
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

        {/* Buttons row — also the free-area drop surface for customizable chips.
            Drop side is decided by X position (left half vs right half). */}
        <div
          className="flex items-center justify-between relative"
          onDragOver={(e) => { if (dragKind) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; const s = sideFromX(e.clientX); setDropSide(s); setDropIndex(dragKind === 'chip' ? indexFromX(s, e.clientX) : null); } }}
          onDrop={onRowDrop}
        >
          <div className="flex items-center gap-1 relative z-10">
            {/* Play/Pause — fixed anchor, larger for visual weight + centering */}
            <button onClick={toggle} className="p-1 hover:bg-white/10 rounded text-white transition-transform active:scale-90 flex items-center justify-center" title="Play/Pause (Space)">
              <svg className="w-7 h-7 block" fill="currentColor" viewBox="0 0 24 24">
                {playing ? <path d="M8 5a1.5 1.5 0 013 0v14a1.5 1.5 0 01-3 0V5zm5 0a1.5 1.5 0 013 0v14a1.5 1.5 0 01-3 0V5z" /> : <path d="M7 5.27v13.46c0 .79.87 1.27 1.54.84l10.58-6.73a1 1 0 000-1.68L8.54 4.43C7.87 4 7 4.48 7 5.27z" />}
              </svg>
            </button>
            {/* Left chips — free area with insertion bar */}
            {renderZone('left')}
            {/* Volume — fixed anchor. % sits LEFT of the icon. */}
            <div className="flex items-center group">
              <span className="text-white/70 text-xs font-mono tabular-nums leading-none w-8 text-right mr-0.5">{muted ? 0 : Math.round(vol * 100)}%</span>
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

            <span className="text-white text-xs font-mono leading-none ml-1">{fmt(time)} / {fmt(dur)}</span>
          </div>
          <div className="flex items-center gap-1 relative z-10">

            {(() => {
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
              if (cachedTimeRanges.length > 0 && barDur > 0) {
                for (const [s, e] of cachedTimeRanges) {
                  if (e > curTime) {
                    cacheAhead += e - Math.max(s, curTime);
                  }
                }
              }
              cacheAhead = Math.max(0, cacheAhead - sbAhead);
              const totalAhead = sbAhead + cacheAhead;

              const healthColor = totalAhead > 300 ? 'text-green-400'
                : totalAhead > 60 ? 'text-yellow-400'
                : totalAhead > 10 ? 'text-orange-400'
                : 'text-red-400';

              return (
                <div className="flex items-center gap-1.5 px-2 py-1 bg-white/5 rounded-lg border border-white/10">
                  {/* Play/Pause prebuffer */}
                  <button
                    onClick={(e) => { e.stopPropagation(); prefetchPaused ? resumePrefetch() : pausePrefetch(); }}
                    className={`hover:bg-white/10 rounded p-0.5 ${prefetchComplete ? 'cursor-default' : ''}`}
                    disabled={prefetchComplete}
                    title={prefetchComplete ? 'Buffering complete' : prefetchPaused ? 'Resume buffering' : 'Pause buffering'}
                  >
                    {prefetchComplete ? (
                      <svg className="w-3.5 h-3.5 text-green-400" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>
                    ) : prefetchPaused ? (
                      <svg className="w-3.5 h-3.5 text-white/70" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5 text-white/70" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
                    )}
                  </button>
                  {/* Download speed */}
                  <span className="text-xs font-mono text-white/60" title="Download speed from Telegram">
                    {(() => { const s = speedMeterValue(greenBarSpeed, prefetchPaused); return s > 0 ? formatSpeed(s) : '—'; })()}
                  </span>
                  {/* Buffer ahead */}
                  <span className={`text-xs font-mono ${healthColor}`} title={`SourceBuffer: ${sbAhead.toFixed(0)}s ahead\nDisk cache: +${cacheAhead.toFixed(0)}s ahead`}>
                    {totalAhead >= 60 ? `${(totalAhead / 60).toFixed(1)}m` : `${totalAhead.toFixed(0)}s`}
                  </span>
                </div>
              );
            })()}
            {/* Prebuffer speed limit indicator */}
            {settings.prebufferSpeedLimit > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); setSettingsOpen(prev => !prev); }}
                className="p-1.5 hover:bg-white/10 rounded flex items-center gap-0.5"
                title={`Prebuffer limited to ${formatSpeedLimit(settings.prebufferSpeedLimit)}`}
              >
                <svg className="w-3.5 h-3.5 text-green-400" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                <span className="text-xs font-mono text-green-400">{formatSpeedLimitCompact(settings.prebufferSpeedLimit)}</span>
              </button>
            )}
            {/* Download speed limit indicator */}
            {settings.downloadSpeedLimit > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); setSettingsOpen(prev => !prev); }}
                className="p-1.5 hover:bg-white/10 rounded flex items-center gap-0.5"
                title={`Download limited to ${formatSpeedLimit(settings.downloadSpeedLimit)}`}
              >
                <svg className="w-3.5 h-3.5 text-nobuf-primary" fill="currentColor" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                <span className="text-xs font-mono text-nobuf-primary">{formatSpeedLimitCompact(settings.downloadSpeedLimit)}</span>
              </button>
            )}
            {/* Right chips — free area with insertion bar (incl. the ⋯ tray chip) */}
            {renderZone('right')}
            {/* Close — fixed anchor, always far right, matches play/pause size */}
            <button onClick={handleClose} className="p-1 rounded text-red-500 hover:text-red-400 hover:bg-red-500/15 transition-transform active:scale-90 flex items-center justify-center" title="Close (Esc)">
              <svg className="w-7 h-7 block" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        </div>

        
      </div>

      {/* Settings overlay panel */}
      {settingsOpen && (
        <div
          className="absolute right-0 top-0 bottom-0 z-30 bg-gradient-to-b from-black/80 to-black/70 backdrop-blur-2xl border-l border-white/10 overflow-y-auto shadow-2xl shadow-black/50 animate-[settingsIn_180ms_ease-out]"
          onClick={(e) => e.stopPropagation()}
          style={{ width: panelDragWidth ?? settings.playerSettingsWidth, maxWidth: '70%', scrollbarWidth: 'thin', transition: panelDragWidth == null ? 'width 120ms ease' : 'none' }}
        >
          <style>{`@keyframes settingsIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:translateX(0)}}`}</style>
          {/* Resize handle — drag the left edge; double-click resets to default width */}
          <div
            onMouseDown={startPanelResize}
            onDoubleClick={() => updateSetting('playerSettingsWidth', 336)}
            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize group z-20 hover:bg-nobuf-primary/20 active:bg-nobuf-primary/30 transition-colors"
            title="Drag to resize · double-click to reset"
          >
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-10 rounded-full bg-white/20 group-hover:bg-nobuf-primary/70 transition-colors" />
          </div>
          {/* Header */}
          <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/40 backdrop-blur-xl">
            <span className="text-white text-sm font-semibold tracking-wide flex items-center gap-2">
              <svg className="w-4 h-4 text-nobuf-primary" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              Settings
            </span>
            <button onClick={() => setSettingsOpen(false)} className="p-1 hover:bg-white/10 rounded-md text-nobuf-subtext hover:text-nobuf-primary transition-colors" title="Close settings">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
            </button>
          </div>

          {/* Playback */}
          <SettingsSection title="Playback" icon={<svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>}>
            <SettingRow label="Skip forward" stack>
              <div className="flex gap-1 items-center">
                {[5, 10, 15, 30].map(s => (
                  <Chip key={s} active={settings.playerSkipForward === s} onClick={() => updateSetting('playerSkipForward', s as SkipDuration)}>
                    <span className="font-mono">{s}s</span>
                  </Chip>
                ))}
                <NumInput value={settings.playerSkipForward} title="Custom seconds (1-60)"
                  onChange={v => updateSetting('playerSkipForward', Math.max(1, Math.min(60, parseInt(v) || 1)) as SkipDuration)} />
              </div>
            </SettingRow>
            <SettingRow label="Skip backward" stack>
              <div className="flex gap-1 items-center">
                {[5, 10, 15, 30].map(s => (
                  <Chip key={s} active={settings.playerSkipBackward === s} onClick={() => updateSetting('playerSkipBackward', s as SkipDuration)}>
                    <span className="font-mono">{s}s</span>
                  </Chip>
                ))}
                <NumInput value={settings.playerSkipBackward} title="Custom seconds (1-60)"
                  onChange={v => updateSetting('playerSkipBackward', Math.max(1, Math.min(60, parseInt(v) || 1)) as SkipDuration)} />
              </div>
            </SettingRow>
          </SettingsSection>

          {/* Display */}
          <SettingsSection title="Display" icon={<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/></svg>}>
            <SettingRow label="Video fit" stack>
              <div className="flex gap-1">
                {([['original', 'Original'], ['contain', 'Fit'], ['fill', 'Fill']] as [VideoFit, string][]).map(([val, label]) => (
                  <Chip key={val} active={settings.playerVideoFit === val} onClick={() => updateSetting('playerVideoFit', val)}>{label}</Chip>
                ))}
              </div>
            </SettingRow>
            <SettingRow label="Rotation" stack>
              <div className="flex gap-1">
                {[0, 90, 180, 270].map(r => (
                  <Chip key={r} active={rotation === r} onClick={() => setRotation(r)}><span className="font-mono">{r}°</span></Chip>
                ))}
              </div>
            </SettingRow>
            <SettingRow label="Brightness" stack>
              <div className="flex items-center gap-2.5">
                <input type="range" min="0.5" max="2" step="0.1" value={brightness}
                  onChange={e => setBrightness(parseFloat(e.target.value))}
                  className="flex-1 accent-nobuf-primary h-1" />
                <span className="text-white/60 text-xs font-mono w-7 text-right tabular-nums">{brightness.toFixed(1)}</span>
              </div>
            </SettingRow>
          </SettingsSection>

          {/* Behavior */}
          <SettingsSection title="Behavior" icon={<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>}>
            <SettingRow label="Show pin button" hint="Adds a pin toggle to the control bar. When off, controls stay visible.">
              <Switch on={settings.playerShowPinButton} onClick={() => updateSetting('playerShowPinButton', !settings.playerShowPinButton)}
                title={settings.playerShowPinButton ? 'Hide pin button' : 'Show pin button'} />
            </SettingRow>
          </SettingsSection>

          {/* Bandwidth */}
          <SettingsSection title="Bandwidth" icon={
            <span className="flex items-center gap-0.5"><span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400" /><span className="inline-block w-1.5 h-1.5 rounded-full bg-nobuf-primary" /></span>
          }>
            {/* Prebuffer speed limit */}
            <SettingRow stack label="Prebuffer speed">
              <div className="flex flex-wrap gap-1 items-center">
                {SPEED_LIMIT_PRESETS.map(p => (
                  <Chip key={p.value} tone="green" active={settings.prebufferSpeedLimit === p.value}
                    onClick={() => { updateSetting('prebufferSpeedLimit', p.value as SpeedLimitValue); setCustomPrebufferValue(''); }}>
                    {p.label}
                  </Chip>
                ))}
                <div className="flex items-center gap-1">
                  <input type="number" min="1" max="102400" placeholder="Custom" value={customPrebufferValue}
                    onChange={e => {
                      const raw = e.target.value; setCustomPrebufferValue(raw);
                      if (raw && Number(raw) > 0) { const kb = customPrebufferUnit === 'mb' ? Number(raw) * 1024 : Number(raw); updateSetting('prebufferSpeedLimit', Math.min(Math.max(kb, 1), 102400)); }
                    }}
                    className="w-16 px-1.5 py-1 rounded-md text-xs font-mono bg-white/[0.07] text-white/80 border border-white/10 focus:border-green-400 focus:outline-none text-center" />
                  <UnitToggle unit={customPrebufferUnit} tone="green" onChange={unit => {
                    setCustomPrebufferUnit(unit);
                    if (customPrebufferValue && Number(customPrebufferValue) > 0) { const kb = unit === 'mb' ? Number(customPrebufferValue) * 1024 : Number(customPrebufferValue); updateSetting('prebufferSpeedLimit', Math.min(Math.max(kb, 1), 102400)); }
                  }} />
                </div>
              </div>
              {settings.prebufferSpeedLimit > 0 && (
                <div className="mt-2 inline-flex items-center gap-1 text-[10px] text-green-300/80 bg-green-500/10 px-2 py-0.5 rounded">
                  <span className="inline-block w-1 h-1 rounded-full bg-green-400" />Active: {formatSpeedLimit(settings.prebufferSpeedLimit)}
                </div>
              )}
            </SettingRow>
            {/* Download speed limit */}
            <SettingRow stack label="Download speed">
              <div className="flex flex-wrap gap-1 items-center">
                {SPEED_LIMIT_PRESETS.map(p => (
                  <Chip key={p.value} tone="primary" active={settings.downloadSpeedLimit === p.value}
                    onClick={() => { updateSetting('downloadSpeedLimit', p.value as SpeedLimitValue); setCustomDownloadValue(''); }}>
                    {p.label}
                  </Chip>
                ))}
                <div className="flex items-center gap-1">
                  <input type="number" min="1" max="102400" placeholder="Custom" value={customDownloadValue}
                    onChange={e => {
                      const raw = e.target.value; setCustomDownloadValue(raw);
                      if (raw && Number(raw) > 0) { const kb = customDownloadUnit === 'mb' ? Number(raw) * 1024 : Number(raw); updateSetting('downloadSpeedLimit', Math.min(Math.max(kb, 1), 102400)); }
                    }}
                    className="w-16 px-1.5 py-1 rounded-md text-xs font-mono bg-white/[0.07] text-white/80 border border-white/10 focus:border-nobuf-primary focus:outline-none text-center" />
                  <UnitToggle unit={customDownloadUnit} tone="primary" onChange={unit => {
                    setCustomDownloadUnit(unit);
                    if (customDownloadValue && Number(customDownloadValue) > 0) { const kb = unit === 'mb' ? Number(customDownloadValue) * 1024 : Number(customDownloadValue); updateSetting('downloadSpeedLimit', Math.min(Math.max(kb, 1), 102400)); }
                  }} />
                </div>
              </div>
              {settings.downloadSpeedLimit > 0 && (
                <div className="mt-2 inline-flex items-center gap-1 text-[10px] text-nobuf-primary/80 bg-nobuf-primary/10 px-2 py-0.5 rounded">
                  <span className="inline-block w-1 h-1 rounded-full bg-nobuf-primary" />Active: {formatSpeedLimit(settings.downloadSpeedLimit)}
                </div>
              )}
            </SettingRow>
            {/* Conflict warning */}
            {settings.prebufferSpeedLimit > 0 && settings.downloadSpeedLimit > 0 && (
              <div className="flex items-start gap-1.5 px-2.5 py-2 rounded-md bg-yellow-500/10 border border-yellow-500/20 text-yellow-300/90 text-[10px] leading-snug">
                <svg className="w-3 h-3 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                <span>Both limits share 1 Telegram connection — speeds may not reach their full ceiling simultaneously.</span>
              </div>
            )}
          </SettingsSection>

          {/* Info */}
          <SettingsSection title="Video info" icon={<svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path strokeLinecap="round" d="M12 11v5M12 8h.01"/></svg>}>
            <div className="space-y-2 -mt-1">
              {videoResolution && (
                <div className="flex justify-between items-center text-xs">
                  <span className="text-white/45">Resolution</span>
                  <span className="text-white/85 font-mono">{videoResolution.w}×{videoResolution.h}</span>
                </div>
              )}
              {dur > 0 && (
                <div className="flex justify-between items-center text-xs">
                  <span className="text-white/45">Duration</span>
                  <span className="text-white/85 font-mono">{fmt(dur)}</span>
                </div>
              )}
              {totalBytes > 0 && (
                <div className="flex justify-between items-center text-xs">
                  <span className="text-white/45">File size</span>
                  <span className="text-white/85 font-mono">{formatBytes(totalBytes)}</span>
                </div>
              )}
              <div className="flex justify-between items-center text-xs">
                <span className="text-white/45">Cache</span>
                <span className={`font-mono ${cacheComplete ? 'text-green-300' : 'text-white/85'}`}>{cacheComplete ? 'Complete ✓' : cachePercent > 0 ? `${cachePercent}%` : 'None'}</span>
              </div>
            </div>
          </SettingsSection>
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
                className={`h-full rounded-full transition-all duration-300 ${dlOverlay.completed || dlOverlay.fromCache ? 'bg-green-400' : 'bg-nobuf-secondary'}`}
                style={{ width: `${dlOverlay.percent}%` }}
              />
            </div>
            <span className="text-nobuf-text text-xs font-mono whitespace-nowrap">
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
              className={`p-1 hover:bg-white/10 rounded transition-colors flex-shrink-0 ${dlOverlay.completed ? 'text-nobuf-subtext/60 hover:text-nobuf-primary' : 'text-nobuf-subtext/60 hover:text-red-400'}`}
              title={dlOverlay.completed ? 'Close' : 'Cancel download'}
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
            </button>
          </div>
        )}
      </div>
      {/* Skip feedback — sits on the side you're seeking toward (left for
          rewind, right for forward). Shows only: how much, and from→to.
          Numbers come from seek() (real video time). Mid-burst presses reuse
          the same key so it updates in place instead of re-animating. */}
      {skipFeedback && (() => {
        const isForward = skipFeedback.direction === 'forward';
        const fromTime = Math.max(0, Math.min(skipFeedback.from, dur || skipFeedback.from));
        const toTime = Math.max(0, Math.min(skipFeedback.to, dur || skipFeedback.to));
        const deltaSec = Math.round(Math.abs(skipFeedback.totalDelta));
        const accent = isForward ? 'text-nobuf-primary' : 'text-white';
        const glow = isForward ? 'rgba(29,252,159,0.35)' : 'rgba(255,255,255,0.25)';
        return (
          <div className={`absolute inset-y-0 ${isForward ? 'right-0' : 'left-0'} w-1/2 flex items-center ${isForward ? 'justify-end pr-[8%]' : 'justify-start pl-[8%]'} pointer-events-none z-20`}>
            <div key={skipFeedbackKey.current}
              className={`flex flex-col ${isForward ? 'items-end' : 'items-start'} gap-1 animate-[skipIn_0.25s_ease-out]`}>
              <span className={`text-4xl font-black font-mono tabular-nums ${accent}`} style={{ textShadow: `0 0 16px ${glow}` }}>
                {isForward ? '+' : '−'}{deltaSec}s
              </span>
              <span className="text-white/70 text-lg font-mono tabular-nums" style={{ textShadow: '0 2px 8px rgba(0,0,0,0.6)' }}>
                {fmt(fromTime)} <span className={accent}>→</span> {fmt(toTime)}
              </span>
            </div>
          </div>
        );
      })()}

      {/* Replay overlay — shown when video has ended */}
      {videoEnded && !load && !err && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={(e) => { e.stopPropagation(); replay(); }}
              className="w-20 h-20 bg-white/15 hover:bg-white/25 backdrop-blur-sm rounded-full flex items-center justify-center transition-all duration-200 hover:scale-105 group pointer-events-auto"
            >
              <svg className="w-10 h-10 text-white group-hover:text-white/90" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
              </svg>
            </button>
            <span className="text-white/70 text-sm font-medium tracking-wide">Replay</span>
          </div>
        </div>
      )}
      {/* Paused play icon — shown when paused mid-video (not ended) */}
      {!playing && !videoEnded && !load && !err && (
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
