import { useState, useEffect, useCallback, useRef } from 'react';
import { MSEGetters } from './useMSEPlayer';
import { Input, EncodedPacketSink, MATROSKA, MPEG_TS, ALL_FORMATS } from 'mediabunny';
import type { InputVideoTrack, VideoCodec, EncodedPacket } from 'mediabunny';
import { createTauriStreamSource, type TauriStreamSourceConfig } from '../lib/faststream/utils/TauriStreamSource';

import { createOffsetTauriStreamSource, type TSKeyframeEntry } from '../lib/faststream/utils/TSByteOffsetScanner';

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

// ─── Transmuxer Thumbnail Pipeline (WebCodecs VideoDecoder) ────────────
// Uses mediabunny Input + getKeyPacket() → toEncodedVideoChunk() → VideoDecoder
// for on-demand thumbnail capture at any position in MKV/TS files.
// Bypasses MSE entirely — no SourceBuffer, no MediaSource, no hidden video.
// Downloads only ONE keyframe cluster per hover (vs 3s of data via refillSeek).

class TransmuxerThumbnailPipeline {
  canvas: HTMLCanvasElement;
  input: Input | null = null;
  videoTrack: InputVideoTrack | null = null;
  videoSink: EncodedPacketSink | null = null;
  videoCodec: VideoCodec | null = null;
  decoderConfig: VideoDecoderConfig | null = null;
  duration: number = 0;
  format: string;
  sourceConfig: TauriStreamSourceConfig;
  // Keyframe index from MediabunnyTransmuxer — allows binary search
  // for instant keyframe lookup instead of slow getKeyPacket for TS.
  keyframeTimestamps: number[] = [];
  // Byte-offset keyframe index + header data + source config for OffsetCustomSource.
  // When available, TS captures use temporary OffsetSource Inputs for fast seeks
  // instead of slow getKeyPacket (8-12s per call).
  keyframeByteOffsets: TSKeyframeEntry[] = [];
  tsHeaderData: Uint8Array | null = null;
  sourceConfigWithHeaders: { url: string; fileSize: number; headers?: Record<string, string> } | null = null;
  ready = false;
  active = true;
  busy = false;
  _initInProgress = false;

  constructor(
    streamUrl: string,
    fileLength: number,
    format: string,
    canvas: HTMLCanvasElement,
    keyframeTimestamps?: number[],
  ) {
    this.canvas = canvas;
    this.format = format;
    // The pipeline's Input reads small amounts at the beginning of the file
    // (canRead, getPrimaryVideoTrack, etc.) — these subscribe to the
    // sequential download, not targeted downloads. With prefetchProfile:
    // 'none', the Input won't make background reads into uncached territory.
    // NOTE: cached_only=true is NOT used here — it blocks initialization reads
    // (byte 0-204) when the meta file hasn't been created yet. Only the
    // TSScanner and OffsetCustomSource use cached_only=true.
    this.sourceConfig = {
      url: streamUrl,
      fileSize: fileLength,
      prefetchProfile: 'none', // No prefetch — prevents background reads into uncached territory
    };
    this.keyframeTimestamps = keyframeTimestamps ?? [];
  }

  /** Update keyframe timestamps from the transmuxer's cached index.
   *  Called when the keyframe index finishes building in the background,
   *  allowing subsequent thumbnail captures to use binary search instead
   *  of slow linear getKeyPacket for TS format. */
  updateKeyframeTimestamps(timestamps: number[]): void {
    this.keyframeTimestamps = timestamps;
  }

  /** Update byte-offset keyframe data for OffsetCustomSource-based TS captures.
   *  When available, TS thumbnail captures use temporary OffsetSource Inputs
   *  for fast seeks (<1s) instead of slow getKeyPacket (8-12s per call). */
  updateKeyframeData(
    byteOffsets: TSKeyframeEntry[],
    headerData: Uint8Array | null,
    sourceConfig: { url: string; fileSize: number; headers?: Record<string, string> } | null,
  ): void {
    this.keyframeByteOffsets = byteOffsets;
    this.tsHeaderData = headerData;
    this.sourceConfigWithHeaders = sourceConfig;
  }

  /** Initialize the thumbnail pipeline. Creates Input, gets video track and decoder config. */
  async init(): Promise<boolean> {
    if (!this.active) return false;

    this._initInProgress = true;

    try {
      // Check if VideoDecoder is available
      if (typeof VideoDecoder === 'undefined') {
        console.warn('[TransmuxerThumbnailPipeline] VideoDecoder not available');
        return false;
      }

      // Create Input from TauriStreamSource (separate from main player)
      const source = createTauriStreamSource(this.sourceConfig);
      const formats = this.format === 'ts' ? [MPEG_TS] :
                      this.format === 'mkv' ? [MATROSKA] :
                      ALL_FORMATS;
      this.input = new Input({ source, formats });

      const canRead = await this.input.canRead();
      if (!canRead || !this.active) {
        // Init was cancelled (destroy() called during init) — clean up Input
        if (this.input) { this.input.dispose(); this.input = null; }
        this._initInProgress = false;
        if (!this.active) console.log('[TransmuxerThumbnailPipeline] Init cancelled during canRead');
        else console.warn('[TransmuxerThumbnailPipeline] Cannot read file');
        return false;
      }

      // Get duration
      this.duration = await this.input.computeDuration();

      // Get video track
      this.videoTrack = await this.input.getPrimaryVideoTrack();
      if (!this.videoTrack || !this.active) {
        if (this.input) { this.input.dispose(); this.input = null; }
        this._initInProgress = false;
        if (!this.active) console.log('[TransmuxerThumbnailPipeline] Init cancelled during getVideoTrack');
        else console.warn('[TransmuxerThumbnailPipeline] No video track');
        return false;
      }

      // Get video codec
      this.videoCodec = await this.videoTrack.getCodec();

      // Get decoder config (includes codec string + SPS/PPS description)
      this.decoderConfig = await this.videoTrack.getDecoderConfig();
      if (!this.decoderConfig || !this.active) {
        if (this.input) { this.input.dispose(); this.input = null; }
        this._initInProgress = false;
        if (!this.active) console.log('[TransmuxerThumbnailPipeline] Init cancelled during getDecoderConfig');
        else console.warn('[TransmuxerThumbnailPipeline] No decoder config');
        return false;
      }

      // Check if the codec is supported by VideoDecoder
      const support = await VideoDecoder.isConfigSupported(this.decoderConfig);
      if (!support.supported) {
        console.warn('[TransmuxerThumbnailPipeline] Codec not supported by VideoDecoder:', this.decoderConfig.codec);
        return false;
      }

      // Create EncodedPacketSink for keyframe lookup
      this.videoSink = new EncodedPacketSink(this.videoTrack);

      this.ready = true;
      this._initInProgress = false;
      console.log('[TransmuxerThumbnailPipeline] Ready — duration=' + this.duration.toFixed(1) + 's, codec=' + this.decoderConfig.codec);
      return true;
    } catch (e) {
      // Init failed — clean up Input to avoid orphaned resources
      if (this.input) { this.input.dispose(); this.input = null; }
      this._initInProgress = false;
      console.warn('[TransmuxerThumbnailPipeline] Init failed:', e);
      return false;
    }
  }

  /** Capture a thumbnail at the given time position using WebCodecs VideoDecoder.
   *  For TS format with byte-offset index: uses OffsetCustomSource for fast seeks (<1s).
   *  For TS format without byte-offset index: skips (too slow — 8-12s per call).
   *  For MKV format: uses mediabunny getKeyPacket (fast — cluster-based seeking). */
  async captureAtTime(
    time: number,
    frameBuffer: Map<number, string>,
    insertionOrder: number[],
    forceUpdateCachedTimes: () => void,
  ): Promise<boolean> {
    if (!this.ready || !this.active || this.busy) return false;

    const bucket = Math.floor(time / BUCKET_SIZE) * BUCKET_SIZE;
    if (frameBuffer.has(bucket)) return true;

    // For TS format: use OffsetCustomSource when byte-offset data is available,
    // otherwise skip entirely (getKeyPacket for TS is 8-12s per call — unacceptable).
    if (this.format === 'ts') {
      if (this.keyframeByteOffsets.length > 0 && this.tsHeaderData && this.sourceConfigWithHeaders) {
        return await this._captureTSWithOffsetSource(time, bucket, frameBuffer, insertionOrder, forceUpdateCachedTimes);
      }
      console.warn('[TransmuxerThumbnailPipeline] TS capture skipped — byte-offset index not available yet');
      return false;
    }

    this.busy = true;

    try {
      // 1. Find nearest keyframe — use cached keyframe index when available
      //    for instant binary search (O(log n)) instead of slow getKeyPacket
      //    for TS format (8-12s linear scan per call).
      let keyPacket: EncodedPacket | null;
      let keyframeTimestampFromIndex: number | null = null;

      if (this.keyframeTimestamps.length > 0) {
        // Binary search for nearest keyframe ≤ time
        const ts = this.keyframeTimestamps;
        let lo = 0, hi = ts.length - 1;
        while (lo < hi) {
          const mid = lo + ((hi - lo + 1) >> 1);
          if (ts[mid] <= time) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        if (ts[lo] <= time) {
          keyframeTimestampFromIndex = ts[lo];
          // Use the known timestamp with verifyKeyPackets: false — our index
          // already confirmed this is a keyframe during the metadataOnly scan.
          keyPacket = await this.videoSink!.getKeyPacket(keyframeTimestampFromIndex, { verifyKeyPackets: false });
        } else {
          // All keyframes are after time — use the first one
          keyframeTimestampFromIndex = ts[0];
          keyPacket = await this.videoSink!.getKeyPacket(keyframeTimestampFromIndex, { verifyKeyPackets: false });
        }
      } else {
        // No keyframe index — fall back to standard getKeyPacket with verification
        keyPacket = await this.videoSink!.getKeyPacket(time, { verifyKeyPackets: true });
      }

      if (!keyPacket || !this.active) {
        console.warn('[TransmuxerThumbnailPipeline] No keyframe at time:', time);
        return false;
      }

      // 2. Set up VideoDecoder output capture — always keep the latest decoded frame
      //    (closest to hover position). Previous frames are closed immediately.
      //    Uses an array container instead of a let variable because TypeScript
      //    cannot narrow let variables that are reassigned inside closures.
      const capturedFrames: VideoFrame[] = [];
      const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          // Close all previous frames and keep only the latest one
          while (capturedFrames.length > 0) {
            capturedFrames.pop()!.close();
          }
          capturedFrames.push(frame);
        },
        error: (e: Error) => {
          console.warn('[TransmuxerThumbnailPipeline] Decode error:', e);
        },
      });

      // 3. Configure decoder with codec config from video track
      decoder.configure(this.decoderConfig!);

      // 4. Decode the keyframe packet
      const keyChunk = keyPacket.toEncodedVideoChunk();
      decoder.decode(keyChunk);

      // 5. Optionally decode a few delta packets for better position accuracy.
      //    If hover position is more than 0.5s from keyframe, iterate packets
      //    up to 3s past the keyframe to get closer to the hover position.
      //    The output callback automatically closes old frames and keeps the latest one.
      const timeGap = time - keyPacket.timestamp;
      if (timeGap > 0.5 && this.videoSink) {
        const packets = this.videoSink.packets(keyPacket, undefined, { verifyKeyPackets: true });
        for await (const packet of packets) {
          if (!this.active) break;
          const deltaFromKey = packet.timestamp - keyPacket.timestamp;
          // Stop after 3s past keyframe or when we've passed the hover position
          if (deltaFromKey > 3 || packet.timestamp >= time) break;
          decoder.decode(packet.toEncodedVideoChunk());
        }
      }

      // 6. Flush decoder — forces all pending decoded frames to be output
      await decoder.flush();
      decoder.close();

      // Extract captured frame from array container
      if (capturedFrames.length === 0 || !this.active) {
        console.warn('[TransmuxerThumbnailPipeline] No frame captured for time:', time);
        return false;
      }
      const frame = capturedFrames[0];

      // 7. Draw frame on canvas
      const ctx = this.canvas.getContext('2d')!;
      ctx.drawImage(frame, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
      const dataUrl = this.canvas.toDataURL('image/jpeg', 0.6);
      frame.close();

      // 8. Cache thumbnail
      frameBuffer.set(bucket, dataUrl);
      insertionOrder.push(bucket);
      while (frameBuffer.size > MAX_BUFFER_SIZE && insertionOrder.length > 0) {
        const oldest = insertionOrder.shift()!;
        frameBuffer.delete(oldest);
      }
      forceUpdateCachedTimes();

      console.log('[TransmuxerThumbnailPipeline] Captured thumbnail at ' + time.toFixed(2) + 's (keyframe=' + keyPacket.timestamp.toFixed(2) + 's, gap=' + timeGap.toFixed(2) + 's)');
      return true;
    } catch (e) {
      console.warn('[TransmuxerThumbnailPipeline] captureAtTime failed:', e);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Fast TS thumbnail capture using OffsetCustomSource.
   *  Creates a temporary Input that starts with header data (PAT/PMT) followed by
   *  data from the keyframe byte offset. getKeyPacket finds the keyframe quickly
   *  because it's near the start of the virtual file (<1s vs 8-12s for TS). */
  private async _captureTSWithOffsetSource(
    time: number,
    bucket: number,
    frameBuffer: Map<number, string>,
    insertionOrder: number[],
    forceUpdateCachedTimes: () => void,
  ): Promise<boolean> {
    this.busy = true;

    try {
      // 1. Binary search byte-offset index for nearest keyframe ≤ time
      const kf = this.keyframeByteOffsets;
      let lo = 0, hi = kf.length - 1;
      while (lo < hi) {
        const mid = lo + ((hi - lo + 1) >> 1);
        if (kf[mid].timestamp <= time) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }

      let targetEntry: TSKeyframeEntry;
      if (kf[lo].timestamp <= time) {
        targetEntry = kf[lo];
      } else {
        // All keyframes are after time — use the first one
        targetEntry = kf[0];
      }

      // 2. Create OffsetCustomSource — virtual file: header + data from byteOffset
      const offsetSource = createOffsetTauriStreamSource({
        url: this.sourceConfigWithHeaders!.url,
        fileSize: this.sourceConfigWithHeaders!.fileSize,
        byteOffset: targetEntry.byteOffset,
        headerData: this.tsHeaderData!,
        headers: this.sourceConfigWithHeaders!.headers ?? {},
        maxCacheSize: 4 * 1024 * 1024, // 4 MiB — enough for keyframe + delta data
        prefetchProfile: 'none', // No prefetch — only reads specific bytes for thumbnail decode
      });

      // 3. Create temporary Input from OffsetCustomSource
      let tempInput: Input | null = null;
      try {
        tempInput = new Input({ source: offsetSource, formats: [MPEG_TS] });
        const canRead = await tempInput.canRead();
        if (!canRead || !this.active) {
          console.warn('[TransmuxerThumbnailPipeline] OffsetSource Input cannot read');
          return false;
        }

        // 4. Get video track + create EncodedPacketSink
        const videoTrack = await tempInput.getPrimaryVideoTrack();
        if (!videoTrack || !this.active) {
          console.warn('[TransmuxerThumbnailPipeline] No video track in OffsetSource Input');
          return false;
        }
        const tempSink = new EncodedPacketSink(videoTrack);

        // 5. Get keyframe packet — fast because keyframe is near start of virtual file
        const keyPacket = await tempSink.getKeyPacket(targetEntry.timestamp, { verifyKeyPackets: false });
        if (!keyPacket || !this.active) {
          console.warn('[TransmuxerThumbnailPipeline] No keyframe packet from OffsetSource at', targetEntry.timestamp.toFixed(2));
          return false;
        }

        // 6. Set up VideoDecoder — reuse cached decoderConfig from initial Input
        const capturedFrames: VideoFrame[] = [];
        const decoder = new VideoDecoder({
          output: (frame: VideoFrame) => {
            while (capturedFrames.length > 0) {
              capturedFrames.pop()!.close();
            }
            capturedFrames.push(frame);
          },
          error: (e: Error) => {
            console.warn('[TransmuxerThumbnailPipeline] Decode error:', e);
          },
        });

        decoder.configure(this.decoderConfig!);

        // 7. Decode the keyframe packet
        decoder.decode(keyPacket.toEncodedVideoChunk());

        // 8. Optionally decode delta packets for better position accuracy
        const timeGap = time - keyPacket.timestamp;
        if (timeGap > 0.5) {
          for await (const packet of tempSink.packets(keyPacket, undefined, { verifyKeyPackets: true })) {
            if (!this.active) break;
            const deltaFromKey = packet.timestamp - keyPacket.timestamp;
            if (deltaFromKey > 3 || packet.timestamp >= time) break;
            decoder.decode(packet.toEncodedVideoChunk());
          }
        }

        // 9. Flush decoder
        await decoder.flush();
        decoder.close();

        if (capturedFrames.length === 0 || !this.active) {
          console.warn('[TransmuxerThumbnailPipeline] No frame captured for time:', time.toFixed(2));
          return false;
        }
        const frame = capturedFrames[0];

        // 10. Draw frame on canvas
        const ctx = this.canvas.getContext('2d')!;
        ctx.drawImage(frame, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
        const dataUrl = this.canvas.toDataURL('image/jpeg', 0.6);
        frame.close();

        // 11. Cache thumbnail
        frameBuffer.set(bucket, dataUrl);
        insertionOrder.push(bucket);
        while (frameBuffer.size > MAX_BUFFER_SIZE && insertionOrder.length > 0) {
          const oldest = insertionOrder.shift()!;
          frameBuffer.delete(oldest);
        }
        forceUpdateCachedTimes();

        console.log('[TransmuxerThumbnailPipeline] OffsetSource capture at ' + time.toFixed(2) + 's (keyframe=' + keyPacket.timestamp.toFixed(2) + 's, gap=' + timeGap.toFixed(2) + 's, byteOffset=' + targetEntry.byteOffset + ')');
        return true;
      } finally {
        // Dispose temporary Input — release OffsetSource resources
        if (tempInput) {
          tempInput.dispose();
        }
      }
    } catch (e) {
      console.warn('[TransmuxerThumbnailPipeline] _captureTSWithOffsetSource failed:', e);
      return false;
    } finally {
      this.busy = false;
    }
  }

  destroy(): void {
    this.active = false;
    this.ready = false;
    this.busy = false;
    // Don't dispose input synchronously — if init() is still running,
    // disposing the Input causes "Assertion failed" in ReadOrchestrator
    // because canRead() has pending reads on the now-disposed source.
    // Instead, init() checks this.active after each async step and
    // disposes the input itself if active became false during init.
    if (this.input && !this._initInProgress) {
      this.input.dispose();
      this.input = null;
    }
    this.videoTrack = null;
    this.videoSink = null;
    this.decoderConfig = null;
  }
}

// ─── fMP4 Backend Thumbnail Pipeline ──────────────────────────────────
// Uses the TS→fMP4 backend segment endpoints for thumbnail extraction.
// Creates a hidden <video> + MediaSource + SourceBuffer, fetches init segment
// and time-based media segments from the backend, seeks and captures frames.
// Same MSE approach as ThumbnailPipeline but uses backend endpoints instead
// of mp4box.js for seeking (because the source is TS, not MP4).

class Fmp4ThumbnailPipeline {
  video: HTMLVideoElement;
  mediaSource: MediaSource | null = null;
  sourceBuffer: SourceBuffer | null = null;
  blobUrl: string | null = null;
  canvas: HTMLCanvasElement;
  initSegment: ArrayBuffer | null = null;
  // Backend fMP4 endpoint config
  fmp4BaseUrl: string;
  folderId: string;
  messageId: string;
  queryParams: string;
  mimeType: string;
  duration: number = 0;
  fileSize: number = 0;
  ready = false;
  active = true;
  busy = false;

  constructor(
    config: {
      baseUrl: string;
      folderId: string;
      messageId: string;
      queryParams: string;
      mimeType: string;
      duration: number;
      fileSize: number;
    },
    canvas: HTMLCanvasElement,
  ) {
    this.fmp4BaseUrl = config.baseUrl;
    this.folderId = config.folderId;
    this.messageId = config.messageId;
    this.queryParams = config.queryParams;
    this.mimeType = config.mimeType;
    this.duration = config.duration;
    this.fileSize = config.fileSize;
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

  /** Initialize the fMP4 thumbnail pipeline. Fetches init segment, sets up MSE. */
  async init(): Promise<boolean> {
    if (!this.active) return false;

    const mimeType = this.mimeType;
    if (!MediaSource.isTypeSupported(mimeType)) {
      console.warn(`[Fmp4ThumbnailPipeline] Codec not supported: ${mimeType}`);
      return false;
    }

    // Create MediaSource and blob URL
    this.mediaSource = new MediaSource();
    this.blobUrl = URL.createObjectURL(this.mediaSource);

    // Set video.src BEFORE waiting for sourceopen
    this.video.src = this.blobUrl;

    // Wait for sourceopen
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

    // Fetch init segment from backend
    const initUrl = `${this.fmp4BaseUrl}/init/${this.folderId}/${this.messageId}?${this.queryParams}`;
    console.log('[Fmp4ThumbnailPipeline] Fetching init segment:', initUrl);

    const initResp = await fetch(initUrl);
    if (!initResp.ok) {
      console.warn(`[Fmp4ThumbnailPipeline] Init segment fetch failed (HTTP ${initResp.status})`);
      return false;
    }

    this.initSegment = await initResp.arrayBuffer();

    // Append init segment to SourceBuffer
    await this._waitForUpdateEnd();
    this.sourceBuffer!.appendBuffer(this.initSegment);
    await this._waitForUpdateEnd();

    // Fetch a small initial segment (first 0.5s) so the video element gets metadata
    const segUrl = `${this.fmp4BaseUrl}/segment/${this.folderId}/${this.messageId}?${this.queryParams}&time=0&duration=0.5`;
    console.log('[Fmp4ThumbnailPipeline] Fetching initial segment:', segUrl);

    const segResp = await fetch(segUrl);
    if (segResp.ok) {
      const segData = await segResp.arrayBuffer();
      if (segData.byteLength > 0) {
        await this._waitForUpdateEnd();
        this.sourceBuffer!.appendBuffer(segData);
        await this._waitForUpdateEnd();
      }
    }

    // Wait for loadedmetadata
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

    // Update duration from video if not already set
    if (this.video.duration && isFinite(this.video.duration) && this.video.duration > 0) {
      this.duration = this.video.duration;
    }

    this.ready = true;
    console.log('[Fmp4ThumbnailPipeline] Pipeline ready, duration=' + this.duration.toFixed(1) + 's');
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

  /** Seek hidden video to a time position and wait for seeked event */
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

  /** Wait for the video decoder to actually render the frame at the seek position */
  private async _waitForFrameRender(seekTarget: number): Promise<void> {
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const onFrame = (_now: number, metadata: any) => {
          if (settled) return;
          const mediaTime = metadata.mediaTime ?? metadata.currentTime ?? this.video.currentTime;
          if (Math.abs(mediaTime - seekTarget) < 0.1) {
            settled = true;
            resolve();
          } else {
            this.video.requestVideoFrameCallback(onFrame);
          }
        };
        this.video.requestVideoFrameCallback(onFrame);
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, 2000);
      });
    } else {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  /** Capture a frame at the given time position using backend fMP4 segments.
   *  Returns true if a frame was captured and stored in the frame buffer. */
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

      // 3. Fetch keyframe byte offset from backend for precise seeking.
      //    Timeout: 5s — if the keyframe search takes longer (FLOOD_PREMIUM_WAIT,
      //    expanding window search), fall back to linear byte estimate.
      let segUrl = `${this.fmp4BaseUrl}/segment/${this.folderId}/${this.messageId}?${this.queryParams}&time=${time.toFixed(3)}&duration=0.5`;
      try {
        const kfUrl = `${this.fmp4BaseUrl}/keyframe-at/${this.folderId}/${this.messageId}?${this.queryParams}&time=${time.toFixed(3)}&duration=${this.duration.toFixed(3)}`;
        const kfController = new AbortController();
        const kfTimeoutId = setTimeout(() => kfController.abort(), 5000);
        const kfResp = await fetch(kfUrl, { signal: kfController.signal });
        clearTimeout(kfTimeoutId);
        if (kfResp.ok) {
          const kfData = await kfResp.json();
          if (kfData.byte_offset != null && !kfData.fallback) {
            segUrl = `${this.fmp4BaseUrl}/segment/${this.folderId}/${this.messageId}?${this.queryParams}&byte_offset=${kfData.byte_offset}&duration=0.5&align=keyframe`;
            console.log('[Fmp4ThumbnailPipeline] Using keyframe-at byte_offset=' + kfData.byte_offset + ' for time=' + time.toFixed(2) + 's');
          }
        }
      } catch {
        // Timeout — keyframe-at took too long (FLOOD_PREMIUM_WAIT, expanding
        // window search). Fall back to linear byte estimate instead of time-based
        // fetch, because the backend's time→byte cache (Fmp4ByteTimeCache) has
        // sparse entries and will return a keyframe at ~12s for a 881s target.
        // Linear estimate: (time / duration) * fileSize — only 6-10MB off for VBR.
        if (this.duration > 0 && this.fileSize > 0) {
          const linearByte = Math.floor((time / this.duration) * this.fileSize);
          segUrl = `${this.fmp4BaseUrl}/segment/${this.folderId}/${this.messageId}?${this.queryParams}&byte_offset=${linearByte}&duration=0.5`;
          console.log('[Fmp4ThumbnailPipeline] Keyframe-at timeout, using linear byte_offset=' + linearByte + ' for time=' + time.toFixed(2) + 's');
        }
      }

      // 4. Fetch media segment from backend (with 10s timeout for uncached positions)
      console.log('[Fmp4ThumbnailPipeline] Fetching segment at time=' + time.toFixed(2) + 's');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      let segResp: Response;
      try {
        segResp = await fetch(segUrl, { signal: controller.signal });
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          console.warn('[Fmp4ThumbnailPipeline] Segment fetch timed out for time:', time.toFixed(2));
        } else {
          console.warn('[Fmp4ThumbnailPipeline] Segment fetch error:', e?.message);
        }
        return false;
      } finally {
        clearTimeout(timeoutId);
      }

      // 5. Handle 503 (download busy) — retry once after Retry-After
      if (segResp.status === 503) {
        const retryAfter = parseInt(segResp.headers.get('Retry-After') || '2', 10);
        console.log('[Fmp4ThumbnailPipeline] Segment 503, retrying after ' + retryAfter + 's');
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        segResp = await fetch(segUrl);
      }

      if (!segResp.ok) {
        console.warn(`[Fmp4ThumbnailPipeline] Segment fetch failed (HTTP ${segResp.status})`);
        return false;
      }

      const segData = await segResp.arrayBuffer();
      if (segData.byteLength === 0) {
        console.warn('[Fmp4ThumbnailPipeline] Empty segment for time:', time);
        return false;
      }

      // 6. Append segment to SourceBuffer
      await this._waitForUpdateEnd();
      this.sourceBuffer!.appendBuffer(segData);
      await this._waitForUpdateEnd();

      // 5. Check if SourceBuffer covers the desired time
      const sbBuffered = this.sourceBuffer!.buffered;
      let seekTarget = time;
      if (sbBuffered.length > 0) {
        // Find the range that covers our target time
        let coversTime = false;
        for (let i = 0; i < sbBuffered.length; i++) {
          if (sbBuffered.start(i) <= time && sbBuffered.end(i) >= time) {
            coversTime = true;
            break;
          }
        }
        // If not covered, seek to the start of the first range
        if (!coversTime) {
          seekTarget = sbBuffered.start(0);
          console.log('[Fmp4ThumbnailPipeline] Target time not in buffer, seeking to ' + seekTarget.toFixed(2));
        }
      }

      // 6. Seek video to target time
      const seeked = await this._seekVideo(seekTarget);
      if (!seeked) {
        console.warn('[Fmp4ThumbnailPipeline] Video seek failed for time:', seekTarget.toFixed(2));
        return false;
      }

      // 7. Wait for frame render
      await this._waitForFrameRender(seekTarget);

      // 8. Capture frame
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
      console.log('[Fmp4ThumbnailPipeline] Captured thumbnail at ' + time.toFixed(2) + 's (seekTarget=' + seekTarget.toFixed(2) + ')');
      return true;
    } catch (e) {
      console.warn('[Fmp4ThumbnailPipeline] captureAtTime failed:', e);
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
  useNative: boolean = true,
  mseGetters?: MSEGetters,
  thumbnailDataReady?: boolean,
  moovBufferReady?: boolean,
  maxCachedTime?: number,
) {
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false); // Mirror of ready state for async loops
  const [cachedTimes, setCachedTimes] = useState<Set<number>>(new Set());

  const frameBufferRef = useRef<Map<number, string>>(new Map());
  const insertionOrderRef = useRef<number[]>([]);

  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const durationRef = useRef(0);
  const maxCachedTimeRef = useRef(0);

  // Keep refs in sync with props
  useEffect(() => { maxCachedTimeRef.current = maxCachedTime ?? 0; }, [maxCachedTime]);

  const desiredHoverTimeRef = useRef<number>(-1);
  const hoverActiveRef = useRef(false);

  const lastCachedUpdateRef = useRef(0);
  const pipelineRef = useRef<ThumbnailPipeline | null>(null);
  const transmuxerPipelineRef = useRef<TransmuxerThumbnailPipeline | null>(null);
  const fmp4PipelineRef = useRef<Fmp4ThumbnailPipeline | null>(null);
  

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

  // Create canvas for MSE mode (needed for pipeline-based thumbnail capture).
  // For native mode, the hidden video setup creates its own canvas.
  useEffect(() => {
    if (!useNative && streamUrl) {
      const canvas = document.createElement('canvas');
      canvas.width = THUMBNAIL_WIDTH;
      canvas.height = THUMBNAIL_HEIGHT;
      canvasRef.current = canvas;
      setReady(true); readyRef.current = true; // Ready for passive capture immediately
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

  // ─── Transmuxer Thumbnail Pipeline Setup (MKV/TS on-demand thumbnails) ────
  // Creates a second Input + VideoDecoder for thumbnail extraction at any position.
  // Separate from main transmuxer so seeking doesn't disrupt playback.
  // NOTE: This effect only re-runs when isTransmuxerActive changes (false→true).
  // It does NOT re-run when keyframeIndexReady changes — the keyframe index
  // update is handled by the separate "Keyframe Index Update" effect below.
  // Using a ref for mseGetters prevents the effect from re-running when
  // mseGetters object reference changes due to state updates like keyframeIndexReady.
  const mseGettersRef = useRef(mseGetters);
  mseGettersRef.current = mseGetters;

  useEffect(() => {
    const getters = mseGettersRef.current;
    if (useNative || !streamUrl || !getters || !getters.isTransmuxerActive) return;

    let cancelled = false;
    const fileLength = getters.getFileLength();
    const format = getters.getFormat();

    if (fileLength <= 0 || format === 'unknown' || format === 'mp4') {
      console.warn('[ThumbnailExtractor] Transmuxer pipeline: not applicable (format=' + format + ', fileLength=' + fileLength + ')');
      return;
    }

    // MSE canvas must be created for thumbnail capture
    const canvas = canvasRef.current;
    if (!canvas) {
      const newCanvas = document.createElement('canvas');
      newCanvas.width = THUMBNAIL_WIDTH;
      newCanvas.height = THUMBNAIL_HEIGHT;
      canvasRef.current = newCanvas;
    }

    const pipeline = new TransmuxerThumbnailPipeline(
      streamUrl,
      fileLength,
      format,
      canvasRef.current!,
      getters.getKeyframeTimestamps(), // Cached keyframe index for fast seek
    );

    transmuxerPipelineRef.current = pipeline;

    pipeline.init().then((success) => {
      if (cancelled) return;
      if (success && pipeline.active) {
        console.log('[ThumbnailExtractor] Transmuxer thumbnail pipeline initialized successfully');
        setReady(true); readyRef.current = true;
      } else {
        console.warn('[ThumbnailExtractor] Transmuxer thumbnail pipeline initialization failed');
        pipeline.destroy();
        transmuxerPipelineRef.current = null;
      }
    });

    return () => {
      cancelled = true;
      console.log('[ThumbnailExtractor] Transmuxer pipeline effect cleanup');
      if (transmuxerPipelineRef.current) {
        transmuxerPipelineRef.current.destroy();
        transmuxerPipelineRef.current = null;
      }
    };
  }, [useNative, streamUrl, mseGetters?.isTransmuxerActive]);

  // ─── fMP4 Backend Thumbnail Pipeline Setup (TS→fMP4 backend pipeline) ──────
  // When the backend TS→fMP4 pipeline is active (isFmp4Stream=true), use the
  // backend's fMP4 segment endpoints for thumbnail extraction instead of
  // mp4box.js (which can't parse TS) or WebCodecs (which needs mediabunny).
  // Uses mseGettersRef to avoid depending on mseGetters object directly.
  useEffect(() => {
    const getters = mseGettersRef.current;
    if (useNative || !streamUrl || !getters || !thumbnailDataReady || !getters.isFmp4Stream()) return;

    const fmp4Config = getters.getFmp4Config();
    if (!fmp4Config) return;

    let cancelled = false;

    // MSE canvas must be created for thumbnail capture
    if (!canvasRef.current) {
      const newCanvas = document.createElement('canvas');
      newCanvas.width = THUMBNAIL_WIDTH;
      newCanvas.height = THUMBNAIL_HEIGHT;
      canvasRef.current = newCanvas;
    }

    const pipeline = new Fmp4ThumbnailPipeline(fmp4Config, canvasRef.current!);
    fmp4PipelineRef.current = pipeline;

    pipeline.init().then((success) => {
      if (cancelled) return;
      if (success && pipeline.active) {
        console.log('[ThumbnailExtractor] fMP4 thumbnail pipeline initialized successfully');
        setReady(true); readyRef.current = true;
      } else {
        console.warn('[ThumbnailExtractor] fMP4 thumbnail pipeline initialization failed');
        pipeline.destroy();
        fmp4PipelineRef.current = null;
      }
    });

    return () => {
      cancelled = true;
      console.log('[ThumbnailExtractor] fMP4 pipeline effect cleanup');
      if (fmp4PipelineRef.current) {
        fmp4PipelineRef.current.destroy();
        fmp4PipelineRef.current = null;
      }
    };
  }, [useNative, streamUrl, thumbnailDataReady]);

  // ─── Keyframe Index Update ─────────────────────────────────────────────
  // The keyframe index is built in background after transmuxer init.
  // When it becomes available, push it to the thumbnail pipeline so
  // subsequent captures use binary search instead of slow getKeyPacket.
  // Also push byte-offset data for TS OffsetCustomSource-based captures.
  // Uses mseGettersRef to avoid depending on the mseGetters object directly.
  useEffect(() => {
    const getters = mseGettersRef.current;
    if (!getters || !getters.keyframeIndexReady || !transmuxerPipelineRef.current) return;

    const timestamps = getters.getKeyframeTimestamps();
    if (timestamps.length > 0) {
      transmuxerPipelineRef.current.updateKeyframeTimestamps(timestamps);
    }

    // Push byte-offset data for OffsetCustomSource-based TS captures
    const byteOffsets = getters.getKeyframeByteOffsets?.() ?? [];
    const headerData = getters.getTsHeaderData?.() ?? null;
    const sourceConfig = getters.getTransmuxerSourceConfig?.() ?? null;
    if (byteOffsets.length > 0) {
      transmuxerPipelineRef.current.updateKeyframeData(byteOffsets, headerData, sourceConfig);
      console.log(`[ThumbnailExtractor] Updated keyframe data: ${timestamps.length} timestamps, ${byteOffsets.length} byte-offsets`);
    } else {
      console.log(`[ThumbnailExtractor] Updated keyframe timestamps: ${timestamps.length} available (no byte-offsets yet)`);
    }
  }, [mseGetters?.keyframeIndexReady]);

  // ─── Hidden Video Setup (NATIVE mode only) ────────────────────────────────

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

    video.src = streamUrl;

    video.addEventListener('loadedmetadata', () => {
      durationRef.current = video.duration;
      setReady(true); readyRef.current = true;
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
      setReady(false); readyRef.current = false;
      desiredHoverTimeRef.current = -1;
      hoverActiveRef.current = false;
    };
  }, [streamUrl, useNative]);

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
        setReady(true); readyRef.current = true;
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
          // MSE mode: use mini MSE pipeline (MP4), fMP4 backend pipeline (TS→fMP4), or transmuxer pipeline (MKV/WebM)
          const pipeline = pipelineRef.current;
          const transmuxerPipeline = transmuxerPipelineRef.current;
          const fmp4Pipeline = fmp4PipelineRef.current;
          const getters = mseGettersRef.current;

          // For TS format with client-side transmuxer (not fMP4 backend), skip captures
          // until keyframe byte-offset index is ready.
          // Without it, getKeyPacket is 8-12s per call — unacceptable for hover UX.
          // Note: fMP4 backend pipeline does NOT need keyframeIndexReady — it fetches
          // segments from the server by timestamp, no byte-offset seeking needed.
          if (transmuxerPipeline && getters && getters.getFormat() === 'ts' && !getters.isFmp4Stream() && !getters.keyframeIndexReady) {
            await new Promise(r => setTimeout(r, 200));
            continue;
          }

          if (fmp4Pipeline && fmp4Pipeline.ready && !fmp4Pipeline.busy) {
            // fMP4 backend pipeline (TS→fMP4): fetches segments from backend by timestamp
            console.log('[ThumbnailExtractor] Hover: calling fMP4 captureAtTime for time', desiredTime);
            const captured = await fmp4Pipeline.captureAtTime(
              desiredTime,
              frameBufferRef.current,
              insertionOrderRef.current,
              forceUpdateCachedTimes,
            );
            console.log('[ThumbnailExtractor] Hover: fMP4 captureAtTime result', captured);
            if (!captured && active) {
              await new Promise(r => setTimeout(r, 200));
            }
          } else if (pipeline && pipeline.ready && !pipeline.busy) {
            console.log('[ThumbnailExtractor] Hover: calling MP4 captureAtTime for time', desiredTime);
            const captured = await pipeline.captureAtTime(
              desiredTime,
              frameBufferRef.current,
              insertionOrderRef.current,
              forceUpdateCachedTimes,
            );
            console.log('[ThumbnailExtractor] Hover: MP4 captureAtTime result', captured);
            if (!captured && active) {
              await new Promise(r => setTimeout(r, 200));
            }
          } else if (transmuxerPipeline && transmuxerPipeline.ready && !transmuxerPipeline.busy) {
            console.log('[ThumbnailExtractor] Hover: calling transmuxer captureAtTime for time', desiredTime);
            const captured = await transmuxerPipeline.captureAtTime(
              desiredTime,
              frameBufferRef.current,
              insertionOrderRef.current,
              forceUpdateCachedTimes,
            );
            console.log('[ThumbnailExtractor] Hover: transmuxer captureAtTime result', captured);
            if (!captured && active) {
              await new Promise(r => setTimeout(r, 200));
            }
          } else {
            console.log('[ThumbnailExtractor] Hover: no pipeline available, mp4=', !!pipeline, 'transmuxer=', !!transmuxerPipeline, 'fmp4=', !!fmp4Pipeline);
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
