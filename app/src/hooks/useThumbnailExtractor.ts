import { useState, useEffect, useCallback, useRef } from 'react';
import { MSEGetters } from './useMSEPlayer';

/**
 * Hover preview thumbnail extractor.
 *
 * Design:
 * - Captures frames from MAIN video during playback (zero bandwidth cost)
 * - Delayed start: waits 2 seconds before capturing
 * - On-demand hover: two approaches depending on playback mode:
 *   - NATIVE mode: hidden video seeks to unplayed positions (works for faststarted MP4s)
 *   - MSE mode: mini MSE pipeline for hidden video — separate MediaSource + SourceBuffer +
 *     second mp4box instance. Fetches data for any hover position (buffered or unbuffered),
 *     processes through second mp4box, appends to hidden video's SourceBuffer, captures frame.
 *     No screen flicker (separate video element), cross-platform (MSE works everywhere).
 * - requestVideoFrameCallback chain restarts after seeks via seeked event listener
 * - Ref-based desired position: hover processor continuously targets current hover position
 * - Synchronous cache check for instant display of already-cached thumbnails
 * - FIFO eviction at 5000 entries (~166 min at 2s intervals)
 */

const THUMBNAIL_WIDTH = 114;
const THUMBNAIL_HEIGHT = 64;
const BUCKET_SIZE = 2;
const MAX_BUFFER_SIZE = 5000;
const CAPTURE_DELAY_MS = 2000;
const MIN_HOVER_FETCH_SIZE = 256 * 1024; // 256KB minimum per hover position
const MAX_HOVER_FETCH_SIZE = 5 * 1024 * 1024; // 5MB maximum — covers large keyframe gaps
const THUMBNAIL_NB_SAMPLES = 1; // 1 sample per segment — ensures every sample immediately flushes via onSegment

// ─── Mini MSE Pipeline ───────────────────────────────────────────────────
// Creates a hidden video + MediaSource + SourceBuffer + second mp4box instance
// for thumbnail extraction at any position (buffered or unbuffered).

class ThumbnailPipeline {
  video: HTMLVideoElement;
  mediaSource: MediaSource | null = null;
  sourceBuffer: SourceBuffer | null = null;
  mp4box: any = null; // MP4BoxFile
  blobUrl: string | null = null;
  canvas: HTMLCanvasElement;
  initSegment: ArrayBuffer | null = null;
  videoTrackId: number;
  videoCodec: string;
  MP4BoxClass: any;
  streamUrl: string;
  fileLength: number;
  duration: number = 0;
  bitrate: number = 0; // bytes per second — used for dynamic fetch sizing
  moovBuffer: ArrayBuffer;
  moovFileStart: number;
  firstChunk: ArrayBuffer;
  ready = false;
  active = true;
  busy = false;
  pendingSegments: ArrayBuffer[] = [];
  collectMode = false;

  constructor(
    moovBuffer: ArrayBuffer, moovFileStart: number, firstChunk: ArrayBuffer,
    videoTrackId: number, videoCodec: string,
    MP4BoxClass: any, streamUrl: string, fileLength: number,
    canvas: HTMLCanvasElement,
  ) {
    this.moovBuffer = moovBuffer;
    this.moovFileStart = moovFileStart;
    this.firstChunk = firstChunk;
    this.videoTrackId = videoTrackId;
    this.videoCodec = videoCodec;
    this.MP4BoxClass = MP4BoxClass;
    this.streamUrl = streamUrl;
    this.fileLength = fileLength;
    this.canvas = canvas;

    // Create hidden video element
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.style.position = 'absolute';
    this.video.style.left = '-9999px';
    this.video.style.width = '1px';
    this.video.style.height = '1px';
    document.body.appendChild(this.video);
  }

  /** Initialize the mini MSE pipeline. Creates MediaSource, SourceBuffer, and second mp4box. */
  async init(): Promise<boolean> {
    if (!this.active) return false;

    const mimeType = `video/mp4; codecs="${this.videoCodec}"`;
    if (!MediaSource.isTypeSupported(mimeType)) {
      console.warn(`[ThumbnailPipeline] Codec not supported: ${mimeType}`);
      return false;
    }

    // Create MediaSource and blob URL
    this.mediaSource = new MediaSource();
    this.blobUrl = URL.createObjectURL(this.mediaSource);

    // Set video.src BEFORE waiting for sourceopen — sourceopen only fires
    // when a media element is assigned the blobUrl.
    this.video.src = this.blobUrl;

    // Wait for sourceopen (now it will actually fire because video.src is set)
    await new Promise<void>((resolve) => {
      if (this.mediaSource!.readyState === 'open') {
        resolve();
      } else {
        this.mediaSource!.addEventListener('sourceopen', () => resolve(), { once: true });
      }
    });

    if (!this.active) return false;

    // Create SourceBuffer
    this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);

    // Create second mp4box instance
    this.mp4box = this.MP4BoxClass.createFile(false);

    // Set up mp4box callbacks
    this.mp4box.onReady = (_info: any) => {
      this.mp4box.setSegmentOptions(this.videoTrackId, { type: 'video' }, { nbSamples: THUMBNAIL_NB_SAMPLES });
      const initSegs = this.mp4box.initializeSegmentation();
      const videoInitSeg = initSegs.find((s: any) => s.id === this.videoTrackId);
      if (videoInitSeg) {
        this.initSegment = videoInitSeg.buffer.slice(0);
      }
      this.mp4box.start(); // Required for onSegment to fire
    };

    this.mp4box.onSegment = (trackId: number, _user: any, buffer: ArrayBuffer, _sampleNum: number, _isLast: boolean) => {
      if (this.collectMode && trackId === this.videoTrackId) {
        this.pendingSegments.push(buffer.slice(0));
      }
    };

    // Detect whether moov is entirely contained in the first chunk.
    // For faststarted MP4s, the first chunk already contains ftyp+moov+mdat.
    // In that case, Step 1 alone triggers onReady+start() — mdat samples are
    // processed and segments generated. Steps 2/3 would be redundant AND
    // harmful: re-appending the clone produces NO segments because mp4box's
    // nextSampleNumber has already advanced past those samples.
    const moovEntirelyInFirstChunk =
      (this.moovFileStart + this.moovBuffer.byteLength) <= this.firstChunk.byteLength;

    const firstChunkBuffer = this.firstChunk.slice(0) as any;
    firstChunkBuffer.fileStart = 0;

    const moovBufferForAppend = this.moovBuffer.slice(0) as any;
    moovBufferForAppend.fileStart = this.moovFileStart;

    const firstChunkClone = this.firstChunk.slice(0) as any;
    firstChunkClone.fileStart = 0;

    // Set collectMode BEFORE any appends so we capture ALL segments
    // (for faststarted files, Step 1 alone generates segments from mdat)
    this.collectMode = true;

    // Step 1: Append first chunk — mp4box sees fileStart=0, initialized() succeeds
    this.mp4box.appendBuffer(firstChunkBuffer);

    if (!moovEntirelyInFirstChunk) {
      // Moov-at-end (or moov extends beyond first chunk): need separate moov
      // append + re-append first chunk clone for mdat processing.
      // Step 2: Append moov — mp4box parses moov, onReady fires (calls start())
      this.mp4box.appendBuffer(moovBufferForAppend);
      // Step 3: Re-append first chunk clone — mp4box processes mdat data, onSegment fires
      this.mp4box.appendBuffer(firstChunkClone);
    }
    // else: moov entirely in first chunk — Step 1 already triggered onReady+start(),
    // mdat samples processed, segments captured by collectMode. No further steps needed.

    this.mp4box.flush();

    // Collect initial segments from position 0
    const initialSegments = this.pendingSegments.splice(0);
    this.collectMode = false;

    console.log('[ThumbnailPipeline] Init: moovEntirelyInFirstChunk=' + moovEntirelyInFirstChunk +
      ' moovFileStart=' + this.moovFileStart + ' moovSize=' + this.moovBuffer.byteLength +
      ' firstChunkSize=' + this.firstChunk.byteLength +
      ' initialSegments=' + initialSegments.length);

    if (!this.active) return false;

    // Append init segment to SourceBuffer first
    if (this.initSegment) {
      await this._waitForUpdateEnd();
      this.sourceBuffer!.appendBuffer(this.initSegment);
      await this._waitForUpdateEnd();
    }

    // Append each initial media segment
    for (const seg of initialSegments) {
      if (!this.active) return false;
      await this._waitForUpdateEnd();
      this.sourceBuffer!.appendBuffer(seg);
    }

    // Wait for all SourceBuffer operations to complete
    await this._waitForUpdateEnd();

    // Wait for loadedmetadata (video.src is already set)
    await new Promise<boolean>((resolve) => {
      if (this.video.readyState >= 1) {
        resolve(true);
        return;
      }
      let done = false;
      const onLoaded = () => {
        if (done) return;
        done = true;
        this.video.removeEventListener('loadedmetadata', onLoaded);
        resolve(true);
      };
      this.video.addEventListener('loadedmetadata', onLoaded);
      setTimeout(() => {
        if (!done) {
          done = true;
          this.video.removeEventListener('loadedmetadata', onLoaded);
          resolve(false);
        }
      }, 10000);
    });

    if (!this.active) return false;

    this.duration = this.video.duration;
    this.bitrate = this.fileLength / this.duration;

    this.ready = true;
    console.log('[ThumbnailPipeline] Mini MSE pipeline ready');
    return true;
  }

  /** Wait for SourceBuffer updateend event */
  private async _waitForUpdateEnd(): Promise<void> {
    const sb = this.sourceBuffer;
    if (!sb) return;
    if (!sb.updating) return;
    return new Promise<void>((resolve) => {
      sb.addEventListener('updateend', () => resolve(), { once: true });
    });
  }

  /** Remove all buffered data from SourceBuffer */
  private async _removeAllBufferedData(): Promise<void> {
    const sb = this.sourceBuffer;
    if (!sb) return;

    await this._waitForUpdateEnd();

    const buffered = sb.buffered;
    if (buffered.length === 0) return;

    const start = buffered.start(0);
    const end = buffered.end(buffered.length - 1);

    sb.remove(start, end);
    await this._waitForUpdateEnd();
  }

  /** Seek hidden video to a time position and wait for seeked event.
   *  Always seeks — never skips based on proximity, for maximum accuracy. */
  private async _seekVideo(time: number): Promise<boolean> {
    const video = this.video;

    return new Promise<boolean>((resolve) => {
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
      }, 5000);
    });
  }

  /** Wait for the video decoder to actually render the frame at the seek position.
   *  Uses requestVideoFrameCallback when available for precise frame timing.
   *  Falls back to a proportional delay based on the keyframe-to-target gap. */
  private async _waitForFrameRender(seekTarget: number, adjustedTime: number): Promise<void> {
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      // Use requestVideoFrameCallback to wait for the actual rendered frame
      await new Promise<void>((resolve) => {
        let settled = false;
        const onFrame = (_now: number, metadata: any) => {
          if (settled) return;
          const mediaTime = metadata.mediaTime ?? metadata.currentTime ?? this.video.currentTime;
          // If the rendered frame is close enough to seekTarget, we're done
          if (Math.abs(mediaTime - seekTarget) < 0.1) {
            settled = true;
            resolve();
          } else {
            // Frame not at target yet — request another callback
            this.video.requestVideoFrameCallback(onFrame);
          }
        };
        this.video.requestVideoFrameCallback(onFrame);
        // Safety timeout: don't wait forever
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, 2000);
      });
    } else {
      // Fallback: proportional delay based on keyframe gap
      // More frames to decode = more wait time needed
      const timeGap = Math.abs(seekTarget - adjustedTime);
      const delay = Math.max(150, Math.ceil(timeGap * 100));
      await new Promise(r => setTimeout(r, delay));
    }
  }

  /** Capture a frame at the given time position using the mini MSE pipeline.
   *  Returns true if a frame was captured and stored in the frame buffer, false otherwise.
   *  The caller provides the frameBuffer and insertionOrder for storage. */
  async captureAtTime(
    time: number,
    frameBuffer: Map<number, string>,
    insertionOrder: number[],
    forceUpdateCachedTimes: () => void,
  ): Promise<boolean> {
    if (!this.ready || !this.active || this.busy) return false;

    const bucket = Math.floor(time / BUCKET_SIZE) * BUCKET_SIZE;
    if (frameBuffer.has(bucket)) return true;

    this.busy = true;

    try {
      // 1. Remove all old SourceBuffer data
      await this._removeAllBufferedData();

      // 2. Re-append init segment
      if (this.initSegment) {
        this.sourceBuffer!.appendBuffer(this.initSegment);
        await this._waitForUpdateEnd();
      }

      // 3. Clear old segment state (don't call flush() — it ends the mp4box stream)
      this.collectMode = false;
      this.pendingSegments = [];

      // 4. Seek mp4box to hover time — use seekTrack directly to bypass
      //    getEndFilePositionAfter which adjusts offset based on stale stream buffers
      //    and causes wrong fetch positions on subsequent hovers
      this.collectMode = true;
      const trak = this.mp4box.getTrackById(this.videoTrackId);
      if (!trak) {
        console.warn('[ThumbnailPipeline] No video track found for seek');
        return false;
      }
      const seekInfo = this.mp4box.seekTrack(time, true, trak) as any;
      if (!seekInfo || typeof seekInfo.offset !== 'number') {
        console.warn('[ThumbnailPipeline] seek failed for time:', time);
        return false;
      }

      const seekOffset = seekInfo.offset;
      const adjustedTime = seekInfo.time ?? time; // Actual sync sample time

      // 5. Dynamic fetch size — fetch more data when desired time is far from keyframe
      const timeGap = Math.max(0, time - adjustedTime);
      const dynamicFetchSize = timeGap > 0
        ? Math.max(MIN_HOVER_FETCH_SIZE, Math.ceil(timeGap * this.bitrate * 1.5) + MIN_HOVER_FETCH_SIZE)
        : MIN_HOVER_FETCH_SIZE;
      const fetchSize = Math.min(dynamicFetchSize, MAX_HOVER_FETCH_SIZE);
      console.log('[ThumbnailPipeline] seek: desiredTime=' + time.toFixed(2) + ' adjustedTime=' + adjustedTime.toFixed(2) + ' timeGap=' + timeGap.toFixed(2) + ' fetchSize=' + (fetchSize / 1024).toFixed(0) + 'KB');
      const fetchEnd = Math.min(seekOffset + fetchSize - 1, this.fileLength - 1);
      const response = await fetch(this.streamUrl, {
        headers: { Range: `bytes=${seekOffset}-${fetchEnd}` },
      });

      if (!response.ok && response.status !== 206) {
        console.warn(`[ThumbnailPipeline] Fetch failed (HTTP ${response.status})`);
        return false;
      }

      const data = await response.arrayBuffer();
      const buffer = data as any;
      buffer.fileStart = seekOffset;

      // 6. Append data to mp4box — onSegment collects new segments
      this.mp4box.appendBuffer(buffer);

      // 7. Collect all segments from this hover position
      const segments = this.pendingSegments.splice(0);
      this.collectMode = false;

      if (segments.length === 0) {
        console.warn('[ThumbnailPipeline] No segments produced for time:', time);
        return false;
      }

      // 8. Append each segment to SourceBuffer
      for (const seg of segments) {
        await this._waitForUpdateEnd();
        if (!this.active) return false;
        this.sourceBuffer!.appendBuffer(seg);
      }
      await this._waitForUpdateEnd();

      // 9. Check if SourceBuffer covers the desired time
      const sbBuffered = this.sourceBuffer!.buffered;
      let coversDesiredTime = false;
      for (let i = 0; i < sbBuffered.length; i++) {
        if (sbBuffered.start(i) <= time && sbBuffered.end(i) >= time) {
          coversDesiredTime = true;
          break;
        }
      }
      // Seek to EXACT desired time if SourceBuffer covers it; otherwise fall back to keyframe time
      const seekTarget = coversDesiredTime ? time : adjustedTime;
      console.log('[ThumbnailPipeline] SourceBuffer: coversDesired=' + coversDesiredTime + ' seekTarget=' + seekTarget.toFixed(2) + ' ranges=' + sbBuffered.length);
      const seeked = await this._seekVideo(seekTarget);
      if (!seeked) {
        console.warn('[ThumbnailPipeline] Video seek failed for time:', seekTarget.toFixed(2));
        return false;
      }

      // Wait for the decoder to render the frame at the seek position
      await this._waitForFrameRender(seekTarget, adjustedTime);

      // 10. Capture frame
      const canvas = this.canvas;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(this.video, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6);

      frameBuffer.set(bucket, dataUrl);
      insertionOrder.push(bucket);
      // FIFO eviction
      while (frameBuffer.size > MAX_BUFFER_SIZE && insertionOrder.length > 0) {
        const oldest = insertionOrder.shift()!;
        frameBuffer.delete(oldest);
      }

      forceUpdateCachedTimes();
      return true;
    } catch (e) {
      console.warn('[ThumbnailPipeline] captureAtTime failed:', e);
      return false;
    } finally {
      this.busy = false;
    }
  }

  destroy(): void {
    this.active = false;
    this.ready = false;
    this.busy = false;

    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      if (this.video.parentNode) {
        document.body.removeChild(this.video);
      }
    }

    if (this.mediaSource) {
      try { this.mediaSource.endOfStream(); } catch (_) { /* ignore */ }
    }

    if (this.sourceBuffer) {
      try { this.sourceBuffer.abort(); } catch (_) { /* ignore */ }
    }

    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
    }

    this.mp4box = null;
    this.initSegment = null;
    this.video = null as any;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.blobUrl = null;
    this.canvas = null as any;
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────

export function useThumbnailExtractor(
  mainVideoRef: React.RefObject<HTMLVideoElement | null>,
  streamUrl: string | null,
  videoStreamUrl?: string | null,
  useNative: boolean = true,
  mseGetters?: MSEGetters,
  thumbnailDataReady?: boolean,
  moovBufferReady?: boolean,
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
  const pipelineRef = useRef<ThumbnailPipeline | null>(null);
  

  // ─── Helpers ──────────────────────────────────────────────────────────

  // Force-update cachedTimes (bypass throttle — used after on-demand captures)
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

  // Capture frame using reusable canvas (for main video passive capture)
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

  // ─── Mini MSE Pipeline Setup (MSE mode) ──────────────────────────────

  // Create canvas for MSE mode (needed for both pipeline and main video capture)
  useEffect(() => {
    if (!useNative && streamUrl) {
      const canvas = document.createElement('canvas');
      canvas.width = THUMBNAIL_WIDTH;
      canvas.height = THUMBNAIL_HEIGHT;
      canvasRef.current = canvas;
      setReady(true); // Ready for passive capture immediately
    }
  }, [useNative, streamUrl]);

  // Initialize mini MSE pipeline when thumbnailDataReady AND moovBufferReady
  // are both true. moovBufferReady is needed because for faststarted files
  // where moov extends beyond the first chunk, moovBufferRef is set AFTER
  // onReady fires (by fetchMoovForFaststarted). Without this check, the
  // pipeline effect fires with moovBuf=null and returns early, never retrying.
  useEffect(() => {
    if (useNative || !streamUrl || !mseGetters || !thumbnailDataReady || !moovBufferReady) return;

    let cancelled = false;

    const moovBuf = mseGetters.getMoovBuffer();
    const firstChunk = mseGetters.getFirstChunk();
    const trackInfo = mseGetters.getVideoTrackInfo();
    const MP4BoxClass = mseGetters.getMP4BoxClass();
    const fileLength = mseGetters.getFileLength();

    console.log('[ThumbnailExtractor] Pipeline init triggered by thumbnailDataReady: moovBuf=' + !!moovBuf + ' firstChunk=' + !!firstChunk + ' trackInfo=' + !!trackInfo + ' MP4BoxClass=' + !!MP4BoxClass + ' fileLength=' + fileLength + ' canvas=' + !!canvasRef.current);

    if (!moovBuf || !firstChunk || !trackInfo || !MP4BoxClass || fileLength <= 0) {
      console.warn('[ThumbnailExtractor] Pipeline init: data not ready despite thumbnailDataReady=true');
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      console.warn('[ThumbnailExtractor] Pipeline init: canvas not created yet');
      return;
    }

    const pipeline = new ThumbnailPipeline(
      moovBuf.buffer, moovBuf.fileStart, firstChunk,
      trackInfo.trackId, trackInfo.codec,
      MP4BoxClass, streamUrl, fileLength,
      canvas,
    );

    pipelineRef.current = pipeline;

    pipeline.init().then((success) => {
      if (cancelled) return;
      if (success && pipeline.active) {
        console.log('[ThumbnailExtractor] Mini MSE pipeline initialized successfully');
      } else {
        console.warn('[ThumbnailExtractor] Mini MSE pipeline initialization failed');
        pipeline.destroy();
        pipelineRef.current = null;
      }
    });

    return () => {
      cancelled = true;
      console.log('[ThumbnailExtractor] Pipeline init effect cleanup — destroying pipeline');
      if (pipelineRef.current) {
        pipelineRef.current.destroy();
        pipelineRef.current = null;
      }
    };
  }, [useNative, streamUrl, mseGetters, thumbnailDataReady, moovBufferReady]);

  // ─── Hidden Video Setup (NATIVE mode) ────────────────────────────────

  useEffect(() => {
    if (!streamUrl || !useNative) return;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'none';
    video.style.position = 'absolute';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    document.body.appendChild(video);

    const canvas = document.createElement('canvas');
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    canvasRef.current = canvas;

    video.src = videoStreamUrl || streamUrl;

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
  }, [streamUrl, videoStreamUrl, useNative]);

  // ─── Main Video Duration Tracking ────────────────────────────────────

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

  // ─── Passive Capture (requestVideoFrameCallback) ─────────────────────

  // Capture frames from main video during playback (zero bandwidth cost).
  // Works for both MSE and native playback modes.
  // Robust after seeks: listens for 'seeked' event on the main video and
  // re-registers requestVideoFrameCallback to restart the capture chain.
  useEffect(() => {
    const video = mainVideoRef.current;
    if (!video || !('requestVideoFrameCallback' in video)) return;

    let active = true;
    let lastCaptureBucket = -1;
    let started = false;
    let rafRegistered = false;

    const registerCallback = () => {
      if (!active || !started || rafRegistered) return;
      rafRegistered = true;
      (video as any).requestVideoFrameCallback(onFrame);
    };

    const onFrame = () => {
      rafRegistered = false;
      if (!active || !started) return;

      const time = video.currentTime;
      const bucket = Math.floor(time / BUCKET_SIZE) * BUCKET_SIZE;

      if (bucket !== lastCaptureBucket && !frameBufferRef.current.has(bucket) && video.readyState >= 2) {
        lastCaptureBucket = bucket;
        captureFrame(video, bucket);
      }

      registerCallback();
    };

    // After any seek completes, reset lastCaptureBucket and re-register
    // requestVideoFrameCallback to restart the capture chain.
    const onSeeked = () => {
      if (!active || !started) return;
      lastCaptureBucket = -1;
      registerCallback();
    };

    const timer = setTimeout(() => {
      started = true;
      registerCallback();
    }, CAPTURE_DELAY_MS);

    video.addEventListener('seeked', onSeeked);

    return () => {
      active = false;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
    };
  }, [mainVideoRef, captureFrame]);

  // ─── Seek Helpers (NATIVE mode) ──────────────────────────────────────

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

  // ─── Hover Processor ─────────────────────────────────────────────────

  // Ref-based: continuously targets desiredHoverTimeRef.
  // NATIVE mode: uses hidden video (can seek to any position natively)
  // MSE mode: uses mini MSE pipeline (can seek to any position, no flicker)
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

        if (useNative) {
          // Native mode: use hidden video to seek to any position
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
        } else {
          // MSE mode: use mini MSE pipeline for any position (buffered or unbuffered)
          const pipeline = pipelineRef.current;
          if (pipeline && pipeline.ready && !pipeline.busy) {
            console.log('[ThumbnailExtractor] Hover: calling captureAtTime for time', desiredTime);
            const captured = await pipeline.captureAtTime(
              desiredTime,
              frameBufferRef.current,
              insertionOrderRef.current,
              forceUpdateCachedTimes,
            );
            console.log('[ThumbnailExtractor] Hover: captureAtTime result', captured);
            if (!captured && active) {
              // Pipeline failed — brief wait before retry
              await new Promise(r => setTimeout(r, 200));
            }
          } else {
            // Pipeline not ready or busy — brief wait
            console.log('[ThumbnailExtractor] Hover: pipeline not available, ready=', pipeline?.ready, 'busy=', pipeline?.busy, 'pipeline=', !!pipeline);
            await new Promise(r => setTimeout(r, 200));
          }
        }

        if (!active) break;
        await new Promise(r => setTimeout(r, 50));
      }
    };

    processLoop();
    return () => { active = false; };
  }, [useNative, seekTo, ensureMetadata, captureFrame, forceUpdateCachedTimes]);

  // ─── Public API ──────────────────────────────────────────────────────

  const getCachedThumbnailSync = useCallback((timeSeconds: number): string | null => {
    const bucket = Math.floor(timeSeconds / BUCKET_SIZE) * BUCKET_SIZE;
    return frameBufferRef.current.get(bucket) ?? null;
  }, []);

  const setDesiredHoverTime = useCallback((time: number) => {
    desiredHoverTimeRef.current = time;
    hoverActiveRef.current = true;
  }, []);

  const clearDesiredHover = useCallback(() => {
    hoverActiveRef.current = false;
    desiredHoverTimeRef.current = -1;
  }, []);

  return { ready, getCachedThumbnailSync, setDesiredHoverTime, clearDesiredHover, cachedTimes };
}
