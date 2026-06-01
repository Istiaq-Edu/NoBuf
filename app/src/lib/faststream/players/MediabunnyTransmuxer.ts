/**
 * MediabunnyTransmuxer — Transmuxes TS/MKV files to fMP4 or WebM segments
 * for MSE SourceBuffer using Mediabunny's Conversion API.
 *
 * Architecture:
 * 1. CustomSource (TauriStreamSource) provides data via HTTP byte-range requests
 * 2. Mediabunny Input reads the file format (TS/MKV)
 * 3. Mediabunny Output writes fMP4 (H264+AAC) or WebM (VP9+Opus) segments
 * 4. Data callbacks intercept segments → fed to MSE SourceBuffer
 * 5. Conversion API handles initial transmuxing (copies codec data, no re-encoding)
 * 6. Seeking uses manual packet-copy via EncodedPacketSink → EncodedVideoPacketSource
 *    to avoid the Conversion API's forced transcoding when trim.start > 0
 */

import {
  Input,
  Output,
  Conversion,
  Mp4OutputFormat,
  WebMOutputFormat,
  NullTarget,
  MATROSKA,
  MPEG_TS,
  ALL_FORMATS,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  CustomSource,
} from 'mediabunny';

import type { VideoCodec, AudioCodec, EncodedPacket } from 'mediabunny';
import type { SourceRef } from 'mediabunny';

import { createTauriStreamSource, type TauriStreamSourceConfig } from '../utils/TauriStreamSource';
import { scanTSFile, createOffsetTauriStreamSource, type TSKeyframeEntry, type TSScanResult } from '../utils/TSByteOffsetScanner';
import type { DetectedFormat } from '../utils/FormatDetector';
import { invoke } from '@tauri-apps/api/core';

// Diagnostic logging helper — routes to both console and Rust backend terminal.
function diagLog(msg: string) {
  console.log(msg);
  invoke('cmd_log', { message: msg }).catch(() => {});
}

export interface TransmuxerConfig {
  format: DetectedFormat;
  sourceConfig: TauriStreamSourceConfig;
  onInitSegment: (data: ArrayBuffer) => void;
  onMediaSegment: (data: ArrayBuffer, timestamp: number) => void;
  onDurationKnown: (duration: number) => void;
  onCodecUnsupported: (codec: string) => void;
  onError: (error: Error) => void;
  onSpeedUpdate?: (speed: number) => void;
  onProgressUpdate?: (processedTime: number, estimatedBytes: number) => void;
}

export interface TransmuxerTrackInfo {
  codec: string;
  type: 'video' | 'audio' | 'subtitle';
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  language?: string;
  codecParameterString?: string | null;
}

export interface TransmuxerInitResult {
  mseDecision: MseCodecDecision;
  mimeType: string;
  videoTrack: TransmuxerTrackInfo | null;
  audioTrack: TransmuxerTrackInfo | null;
}

type MseCodecDecision = 'fmp4' | 'webm' | 'unsupported';

function decideMseCodec(videoCodec: VideoCodec | null, _audioCodec: AudioCodec | null): MseCodecDecision {
  if (videoCodec && (videoCodec === 'avc' || videoCodec === 'av1')) return 'fmp4';
  if (videoCodec === 'vp8' || videoCodec === 'vp9') return 'webm';
  if (videoCodec === 'hevc') return 'unsupported';
  if (videoCodec === null) return 'unsupported';
  return 'fmp4';
}

function combineUint8Arrays(...arrays: Uint8Array[]): ArrayBuffer {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result.buffer;
}

export class MediabunnyTransmuxer {
  private config: TransmuxerConfig;
  private input: Input | null = null;
  private output: Output | null = null;
  private conversion: Conversion | null = null;
  // Persistent TauriStreamSource — its 32 MiB cache survives across Input
  // recreations, so refill seeks benefit from cached cluster data.
  private streamSource: CustomSource | null = null;
  // Master SourceRef keeps streamSource alive even when Inputs are disposed.
  private masterSourceRef: SourceRef | null = null;
  private disposed = false;
  private initSegmentBuffer: ArrayBuffer | null = null;
  private ftypData: Uint8Array | null = null;
  private currentMoofData: Uint8Array | null = null;
  private currentMoofTimestamp: number = 0;
  private mseDecision: MseCodecDecision = 'fmp4';
  private mimeType: string = '';
  private videoTrackInfo: TransmuxerTrackInfo | null = null;
  private audioTrackInfo: TransmuxerTrackInfo | null = null;
  private videoCodec: VideoCodec | null = null;
  private audioCodec: AudioCodec | null = null;
  private ebmlHeaderData: Uint8Array | null = null;
  private lastProcessedTime: number = 0;
  private seekAbortFlag = false;
  // Seek generation counter — incremented on each seek so stale callbacks are discarded
  private seekGeneration = 0;
  
  private duration: number = 0;
  private fileLength: number = 0;
  // Speed tracking: sliding-window of processed-time deltas
  private speedHistory: { processedTime: number; wallTime: number }[] = [];
  private lastSpeedThrottle = 0;

  // Keyframe index cache — sorted array of keyframe timestamps.
  // Built via background scan after init (metadataOnly for speed).
  // Once built, seekTo uses binary search to find nearest keyframe
  // instantly, then calls getKeyPacket with the known timestamp.
  // This dramatically reduces seek time for TS format where getKeyPacket
  // must linearly scan the entire file (8-12s per call).
  private keyframeTimestamps: number[] = [];
  private keyframeIndexBuilt = false; // Full coverage — background scan completed
  private keyframeIndexPartial = false; // Has timestamps — partial coverage from seeks
  private keyframeIndexPromise: Promise<void> | null = null;
  // TS byte-offset index — built by custom scanner (TSByteOffsetScanner).
  // Enables instant keyframe lookup by byte offset, bypassing mediabunny's
  // slow getKeyPacket linear scan (8-12s). When available, seekTo() creates
  // an OffsetCustomSource that starts from the keyframe byte offset, making
  // getKeyPacket scan only a small portion of the file instead of the whole thing.
  private keyframeByteOffsets: TSKeyframeEntry[] = [];
  private tsHeaderData: Uint8Array | null = null; // First ~64 KiB (PAT/PMT) for OffsetCustomSource

  constructor(config: TransmuxerConfig) {
    this.config = config;
  }

  async init(): Promise<TransmuxerInitResult | null> {
    if (this.disposed) return null;

    try {
      // Create persistent TauriStreamSource — its cache survives across Input
      // recreations, so refill seeks benefit from cached cluster data.
      this.streamSource = createTauriStreamSource(this.config.sourceConfig);
      // Master ref keeps source alive even when Inputs are disposed.
      this.masterSourceRef = this.streamSource.ref();

      const formats = this.config.format === 'ts' ? [MPEG_TS] :
                      this.config.format === 'mkv' ? [MATROSKA] :
                      ALL_FORMATS;

      this.input = new Input({ source: this.streamSource, formats });

      const t0 = performance.now();
      diagLog(`[Transmuxer] init: starting canRead() at t=${t0.toFixed(0)}ms`);
      const canRead = await this.input.canRead();
      diagLog(`[Transmuxer] init: canRead()=${canRead} took ${((performance.now() - t0)/1000).toFixed(1)}s`);
      if (!canRead) {
        throw new Error(`Cannot read ${this.config.format} file`);
      }

      // Duration discovery strategy:
      // - TS format: computeDuration() scans entire file (40+ seconds for large
      //   files). Use getDurationFromMetadata() first (fast, reads file header).
      //   If null (expected for TS — no metadata duration), defer the full scan
      //   to background so the player starts immediately with Infinity duration.
      // - Other formats (MP4/MKV): getDurationFromMetadata() usually works, so
      //   we get the duration quickly. If null, fall back to computeDuration().
      let duration: number | null = null;

      if (this.config.format === 'ts') {
        // TS format has NO metadata duration — getDurationFromMetadata() reads
        // the ENTIRE stream sequentially to compute duration from PCR values,
        // which takes 21+ minutes for a 1.3GB file and blocks init completely.
        // Skip it entirely: duration stays Infinity, and the real duration is
        // discovered later from the byte-offset scanner (sequential cached reads)
        // or from SourceBuffer buffered ranges as playback progresses.
        duration = Infinity;
        diagLog(`[Transmuxer] init: TS format — skipping getDurationFromMetadata(), duration=Infinity`);
        this.deferComputeDuration(); // disabled — logs "disabled" message
      } else {
        // Non-TS formats: try metadata first, fall back to full computation
        const t1 = performance.now();
        diagLog(`[Transmuxer] init: calling getDurationFromMetadata()`);
        const metadataDuration = await this.input.getDurationFromMetadata();
        diagLog(`[Transmuxer] init: getDurationFromMetadata()=${metadataDuration} took ${((performance.now() - t1)/1000).toFixed(1)}s`);
        if (metadataDuration !== null) {
          duration = metadataDuration;
        } else {
          duration = await this.input.computeDuration();
        }
      }

      this.duration = duration;
      this.fileLength = this.config.sourceConfig.fileSize;
      diagLog(`[Transmuxer] init: duration=${duration}, calling onDurationKnown`);
      this.config.onDurationKnown(duration);

      const t2 = performance.now();
      diagLog(`[Transmuxer] init: calling getPrimaryVideoTrack()`);
      const videoTrack = await this.input.getPrimaryVideoTrack();
      diagLog(`[Transmuxer] init: getPrimaryVideoTrack()=${videoTrack ? 'found' : 'null'} took ${((performance.now() - t2)/1000).toFixed(1)}s`);

      const t3 = performance.now();
      diagLog(`[Transmuxer] init: calling getPrimaryAudioTrack()`);
      const audioTrack = await this.input.getPrimaryAudioTrack();
      diagLog(`[Transmuxer] init: getPrimaryAudioTrack()=${audioTrack ? 'found' : 'null'} took ${((performance.now() - t3)/1000).toFixed(1)}s`);

      this.videoCodec = videoTrack ? await videoTrack.getCodec() : null;
      this.audioCodec = audioTrack ? await audioTrack.getCodec() : null;
      diagLog(`[Transmuxer] init: videoCodec=${this.videoCodec}, audioCodec=${this.audioCodec}`);
      const videoCodecString = videoTrack ? await videoTrack.getCodecParameterString() : null;
      const audioCodecString = audioTrack ? await audioTrack.getCodecParameterString() : null;

      this.mseDecision = decideMseCodec(this.videoCodec, this.audioCodec);

      if (this.mseDecision === 'unsupported') {
        const codecStr = `${this.videoCodec || 'unknown-video'}/${this.audioCodec || 'unknown-audio'}`;
        this.config.onCodecUnsupported(codecStr);
        return null;
      }

      this.mimeType = this.buildMimeType(videoCodecString, audioCodecString, this.videoCodec, this.audioCodec);

      if (this.mimeType && !MediaSource.isTypeSupported(this.mimeType)) {
        const codecStr = `${this.videoCodec || 'unknown-video'}/${this.audioCodec || 'unknown-audio'}`;
        this.config.onCodecUnsupported(codecStr);
        return null;
      }

      this.videoTrackInfo = videoTrack ? {
        codec: this.videoCodec || 'unknown',
        type: 'video',
        width: await videoTrack.getCodedWidth(),
        height: await videoTrack.getCodedHeight(),
        language: await videoTrack.getLanguageCode(),
        codecParameterString: videoCodecString,
      } : null;

      this.audioTrackInfo = audioTrack ? {
        codec: this.audioCodec || 'unknown',
        type: 'audio',
        sampleRate: await audioTrack.getSampleRate(),
        channels: await audioTrack.getNumberOfChannels(),
        language: await audioTrack.getLanguageCode(),
        codecParameterString: audioCodecString,
      } : null;

      this.setupOutput(this.seekGeneration);

      diagLog(`[Transmuxer] init: calling Conversion.init()`);
      const t4 = performance.now();
      this.conversion = await Conversion.init({ input: this.input, output: this.output! });
      diagLog(`[Transmuxer] init: Conversion.init() completed, isValid=${this.conversion.isValid} took ${((performance.now() - t4)/1000).toFixed(1)}s`);

      if (!this.conversion.isValid) {
        const discarded = this.conversion.discardedTracks;
        const reasons = discarded.map(t => t.reason).join(', ');
        diagLog(`[Transmuxer] init: Conversion not valid, discarded: ${reasons}`);
        this.config.onCodecUnsupported(reasons);
        return null;
      }

      diagLog(`[Transmuxer] init: SUCCESS — ${this.config.format} → ${this.mseDecision}, duration=${duration}s, mimeType=${this.mimeType}`);

      return {
        mseDecision: this.mseDecision,
        mimeType: this.mimeType,
        videoTrack: this.videoTrackInfo,
        audioTrack: this.audioTrackInfo,
      };
    } catch (e) {
      this.config.onError(e instanceof Error ? e : new Error(String(e)));
      return null;
    }
  }

  /** Disabled: computeDuration() makes random reads across the entire file,
   *  triggering dozens of targeted MISS downloads from Telegram that compete
   *  with the streaming download and starve it of bandwidth. Instead, the
   *  real duration is discovered from the byte-offset scanner (sequential
   *  reads from cached data) or from SourceBuffer buffered ranges as playback
   *  progresses.
   */
  private deferComputeDuration(): void {
    // Disabled — see comment above
    if (this.disposed) return;
    console.log('[Transmuxer] deferComputeDuration() disabled — duration will come from byte-offset scanner or SourceBuffer buffered ranges');
  }

  private buildMimeType(
    videoCodecString: string | null,
    audioCodecString: string | null,
    videoCodec: VideoCodec | null,
    audioCodec: AudioCodec | null,
  ): string {
    if (this.mseDecision === 'fmp4') {
      const videoPart = videoCodecString || (videoCodec === 'avc' ? 'avc1.42E01E' : '');
      const audioPart = audioCodecString || (audioCodec === 'aac' ? 'mp4a.40.2' : '');
      if (videoPart && audioPart) {
        return `video/mp4; codecs="${videoPart}, ${audioPart}"`;
      }
      if (videoPart) return `video/mp4; codecs="${videoPart}"`;
      if (audioPart) return `audio/mp4; codecs="${audioPart}"`;
      return 'video/mp4';
    } else if (this.mseDecision === 'webm') {
      const videoPart = videoCodec || '';
      const audioPart = audioCodec || '';
      if (videoPart && audioPart) {
        return `video/webm; codecs="${videoPart}, ${audioPart}"`;
      }
      if (videoPart) return `video/webm; codecs="${videoPart}"`;
      return 'video/webm';
    }
    return '';
  }

  private setupOutput(generation: number, skipInitSegment: boolean = false): void {
    if (this.mseDecision === 'fmp4') {
      this.output = new Output({
        format: new Mp4OutputFormat({
          fastStart: 'fragmented',
          minimumFragmentDuration: 0.5,
          onFtyp: (data: Uint8Array, _position: number) => {
            if (generation !== this.seekGeneration) return;
            if (skipInitSegment) return; // Continuation refill — skip init segment
            this.ftypData = data;
          },
          onMoov: (data: Uint8Array, _position: number) => {
            if (generation !== this.seekGeneration) return;
            if (skipInitSegment) return; // Continuation refill — skip init segment
            if (this.ftypData) {
              const initSegment = combineUint8Arrays(this.ftypData, data);
              this.initSegmentBuffer = initSegment;
              this.config.onInitSegment(initSegment);
            }
          },
          onMoof: (data: Uint8Array, _position: number, timestamp: number) => {
            if (generation !== this.seekGeneration) return;
            this.currentMoofData = data;
            this.currentMoofTimestamp = timestamp;
          },
          onMdat: (data: Uint8Array, _position: number) => {
            if (generation !== this.seekGeneration) return;
            if (this.currentMoofData) {
              const mediaSegment = combineUint8Arrays(this.currentMoofData, data);
              this.config.onMediaSegment(mediaSegment, this.currentMoofTimestamp);
              this.currentMoofData = null;
            }
          },
        }),
        target: new NullTarget(),
      });
    } else if (this.mseDecision === 'webm') {
      this.output = new Output({
        format: new WebMOutputFormat({
          appendOnly: true,
          minimumClusterDuration: 0.5,
          onEbmlHeader: (data: Uint8Array, _position: number) => {
            if (generation !== this.seekGeneration) return;
            if (skipInitSegment) return; // Continuation refill — skip init segment
            this.ebmlHeaderData = data;
          },
          onSegmentHeader: (data: Uint8Array, _position: number) => {
            if (generation !== this.seekGeneration) return;
            if (skipInitSegment) return; // Continuation refill — skip init segment
            if (this.ebmlHeaderData) {
              const initSegment = combineUint8Arrays(this.ebmlHeaderData, data);
              this.initSegmentBuffer = initSegment;
              this.config.onInitSegment(initSegment);
            } else {
              this.initSegmentBuffer = data.buffer as ArrayBuffer;
              this.config.onInitSegment(data.buffer as ArrayBuffer);
            }
          },
          onCluster: (data: Uint8Array, _position: number, timestamp: number) => {
            if (generation !== this.seekGeneration) return;
            this.config.onMediaSegment(data.buffer as ArrayBuffer, timestamp);
          },
        }),
        target: new NullTarget(),
      });
    }
  }

  /** Build keyframe index by scanning all video keyframes using metadataOnly.
   *  Runs in background after init — takes ~2-4s for TS (vs 8-12s for full
   *  getKeyPacket with data loading). Once built, all seeks use binary search
   *  on the cached timestamps for instant keyframe lookup, then call getKeyPacket
   *  with the known timestamp (still needs linear scan for TS but avoids the
   *  "find nearest keyframe" search overhead and allows verifyKeyPackets:false
   *  since our index already verified the keyframe timestamps).
   *
   *  For MKV format, this is much faster because MKV has Cue entries —
   *  getKeyPacket uses the index directly. Still useful as a cache for
   *  thumbnail pipeline which calls getKeyPacket repeatedly. */
  buildKeyframeIndex(): Promise<void> {
    if (this.keyframeIndexBuilt || this.keyframeIndexPromise || this.disposed) {
      return this.keyframeIndexPromise ?? Promise.resolve();
    }

    this.keyframeIndexPromise = this._buildKeyframeIndexInternal();
    return this.keyframeIndexPromise;
  }

  private async _buildKeyframeIndexInternal(): Promise<void> {
    if (this.disposed) return;

    const scanStart = performance.now();
    console.log(`[Transmuxer] Starting background keyframe index scan for ${this.config.format}...`);

    // For TS format: use custom byte-offset scanner (TSByteOffsetScanner).
    // This bypasses mediabunny entirely — reads file in 4 MiB chunks via
    // direct HTTP range requests and parses 188-byte TS packet headers.
    // Much faster than mediabunny's metadataOnly scan (2-5s vs never completing),
    // and produces a byte-offset index that enables instant seeking via
    // OffsetCustomSource (bypasses getKeyPacket's linear scan entirely).
    if (this.config.format === 'ts') {
      try {
        const result: TSScanResult = await scanTSFile(
          this.config.sourceConfig.url,
          this.config.sourceConfig.fileSize,
          this.config.sourceConfig.headers ?? {},
        );

        if (this.disposed) return;

        this.keyframeByteOffsets = result.keyframes;
        this.tsHeaderData = result.headerData;

        // Also populate the timestamp-only index (for findNearestKeyframe compatibility)
        this.keyframeTimestamps = result.keyframes.map(kf => kf.timestamp);
        this.keyframeIndexBuilt = true;

        // If duration was Infinity (deferred computeDuration disabled), update
        // from the scanner's last keyframe timestamp ONLY if the scanner found
        // enough keyframes for a reliable estimate (≥10 keyframes covers at
        // least 30-50s of video with typical GOP sizes of 2-5s). Don't use
        // partial scans (1-2 keyframes from only cached data) — they give
        // wildly inaccurate durations like 0.18s for a 2073s file.
        if (this.duration === Infinity && result.keyframes.length >= 10) {
          const scannerDuration = result.keyframes[result.keyframes.length - 1].timestamp;
          if (scannerDuration > 30) {
            this.duration = scannerDuration;
            this.config.onDurationKnown(scannerDuration);
            diagLog(`[Transmuxer] Duration from scanner: ${scannerDuration}s (${result.keyframes.length} keyframes)`);
          }
        }

        const scanDuration = performance.now() - scanStart;
        console.log(`[Transmuxer] TS byte-offset index built: ${result.keyframes.length} keyframes in ${scanDuration.toFixed(0)}ms, videoPid=0x${result.videoPid.toString(16)}, range=[${result.keyframes[0]?.timestamp.toFixed(2)}s .. ${result.keyframes[result.keyframes.length - 1]?.timestamp.toFixed(2)}s]`);
      } catch (e) {
        console.warn('[Transmuxer] TS byte-offset scanner failed, falling back to mediabunny scan:', e);
        // Fall back to mediabunny-based scan
        await this._buildKeyframeIndexMediabunny();
      }
      return;
    }

    // For MKV format: use mediabunny's metadataOnly scan — MKV has Cue entries
    // so getKeyPacket uses the index directly. Still useful as a cache for
    // thumbnail pipeline which calls getKeyPacket repeatedly.
    await this._buildKeyframeIndexMediabunny();
  }

  /** Mediabunny-based keyframe index scan — fallback for TS (if custom
   *  scanner fails) and primary method for MKV. */
  private async _buildKeyframeIndexMediabunny(): Promise<void> {
    if (this.disposed) return;

    const scanStart = performance.now();
    const scanSourceConfig: TauriStreamSourceConfig = {
      ...this.config.sourceConfig,
      maxCacheSize: 4 * 1024 * 1024, // 4 MiB — enough for efficient sequential read-ahead
      prefetchProfile: 'fileSystem', // 1 sequential prefetch worker — scan reads sequentially, 'none' causes 188-byte HTTP requests
    };
    const scanSource = createTauriStreamSource(scanSourceConfig);
    const formats = this.config.format === 'ts' ? [MPEG_TS] :
                    this.config.format === 'mkv' ? [MATROSKA] :
                    ALL_FORMATS;

    const scanInput = new Input({ source: scanSource, formats });

    try {
      const canRead = await scanInput.canRead();
      if (!canRead) {
        console.warn('[Transmuxer] Keyframe index scan: cannot read file');
        return;
      }

      const videoTrack = await scanInput.getPrimaryVideoTrack();
      if (!videoTrack) {
        console.warn('[Transmuxer] Keyframe index scan: no video track');
        return;
      }

      const videoSink = new EncodedPacketSink(videoTrack);

      let currentPacket = await videoSink.getFirstKeyPacket({ metadataOnly: true });
      const timestamps: number[] = [];

      while (currentPacket) {
        if (this.disposed) return;
        timestamps.push(currentPacket.timestamp);
        currentPacket = await videoSink.getNextKeyPacket(currentPacket, { metadataOnly: true });
      }

      this.keyframeTimestamps = timestamps;
      this.keyframeIndexBuilt = true;

      const scanDuration = performance.now() - scanStart;
      console.log(`[Transmuxer] Keyframe index built: ${timestamps.length} keyframes in ${scanDuration.toFixed(0)}ms, range=[${timestamps[0]?.toFixed(2)}s .. ${timestamps[timestamps.length - 1]?.toFixed(2)}s]`);
    } catch (e) {
      console.warn('[Transmuxer] Keyframe index scan failed:', e);
    } finally {
      scanInput.dispose();
    }
  }

  /** Add a keyframe timestamp to the index (sorted insertion).
   *  Used for incremental index building during seek operations. */
  private addKeyframeTimestamp(timestamp: number): void {
    if (this.keyframeIndexBuilt) return; // Full index already available — no need for incremental

    const ts = this.keyframeTimestamps;
    // Skip if already present (within 0.01s tolerance)
    if (ts.some(t => Math.abs(t - timestamp) < 0.01)) return;

    // Binary search for insertion position
    let lo = 0, hi = ts.length;
    while (lo < hi) {
      const mid = lo + ((hi - lo) >> 1);
      if (ts[mid] < timestamp) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    ts.splice(lo, 0, timestamp);
    this.keyframeIndexPartial = true;
  }

  /** Find the nearest keyframe timestamp at or before the given time.
   *  Uses binary search on the cached keyframe index for O(log n) lookup.
   *  Returns null if the index has no timestamps, or if the nearest timestamp
   *  is too far from the seek position for partial indexes.
   *
   *  For full indexes (keyframeIndexBuilt), always returns the nearest keyframe
   *  regardless of distance — the full index has complete coverage.
   *  For partial indexes (incremental, from seek operations), allows up to 60s
   *  gap — sparse but still useful for reducing getKeyPacket scan distance. */
  findNearestKeyframe(seekTime: number): number | null {
    if (this.keyframeTimestamps.length === 0) return null;

    const ts = this.keyframeTimestamps;
    // Binary search: find the rightmost timestamp <= seekTime
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) {
      const mid = lo + ((hi - lo + 1) >> 1); // upper mid to avoid infinite loop
      if (ts[mid] <= seekTime) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    // lo is the index of the rightmost keyframe <= seekTime
    if (ts[lo] <= seekTime) {
      // For full indexes, always return the nearest keyframe regardless of distance.
      // For partial indexes (built incrementally from seeks), allow up to 60s gap.
      // The previous 5s limit was too conservative for sparse incremental indexes
      // (e.g., 8 keyframes across 2073s file meant >5s gaps were everywhere).
      if (!this.keyframeIndexBuilt && seekTime - ts[lo] > 60) {
        return null; // Very sparse coverage — don't use partial index for distant seeks
      }
      return ts[lo];
    }

    // All keyframes are after seekTime — return the first one (edge case)
    // Only valid if the first keyframe is close to 0 (beginning of file)
    if (ts[0] < 1.0 && seekTime < 1.0) return ts[0];
    return null;
  }

  /** Find the nearest keyframe byte offset at or before the given time.
   *  Uses binary search on the byte-offset index for O(log n) lookup.
   *  Returns null if the byte-offset index has no entries.
   *  Only available for TS format after the custom scanner completes. */
  findNearestKeyframeByteOffset(seekTime: number): TSKeyframeEntry | null {
    if (this.keyframeByteOffsets.length === 0) return null;

    const kf = this.keyframeByteOffsets;
    // Binary search: find the rightmost entry with timestamp <= seekTime
    let lo = 0, hi = kf.length - 1;
    while (lo < hi) {
      const mid = lo + ((hi - lo + 1) >> 1);
      if (kf[mid].timestamp <= seekTime) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    if (kf[lo].timestamp <= seekTime) {
      return kf[lo];
    }

    // All keyframes are after seekTime — return the first one (edge case)
    if (kf[0].timestamp < 1.0 && seekTime < 1.0) return kf[0];
    return null;
  }

  /** Returns true if the keyframe index has any timestamps (partial or full). */
  isKeyframeIndexReady(): boolean {
    return this.keyframeIndexBuilt || this.keyframeIndexPartial;
  }

  /** Returns the keyframe timestamps array (for thumbnail pipeline). */
  getKeyframeTimestamps(): number[] {
    return this.keyframeTimestamps;
  }

  /** Returns the byte-offset keyframe index (for OffsetCustomSource seeking). */
  getKeyframeByteOffsets(): TSKeyframeEntry[] {
    return this.keyframeByteOffsets;
  }

  /** Returns the cached TS header data (PAT/PMT) for OffsetCustomSource. */
  getTsHeaderData(): Uint8Array | null {
    return this.tsHeaderData;
  }

  /** Returns the source configuration (URL, fileSize, headers) for OffsetCustomSource. */
  getSourceConfig(): { url: string; fileSize: number; headers?: Record<string, string> } | null {
    return {
      url: this.config.sourceConfig.url,
      fileSize: this.config.sourceConfig.fileSize,
      headers: this.config.sourceConfig.headers,
    };
  }

  async startTransmuxing(): Promise<void> {
    if (this.disposed || !this.conversion) return;

    try {
      this.conversion.onProgress = (_progress: number, processedTime: number) => {
        this.lastProcessedTime = processedTime;

        // Speed tracking: throttle updates to 250ms
        const now = Date.now();
        if (now - this.lastSpeedThrottle > 250 && this.duration > 0 && this.fileLength > 0) {
          this.lastSpeedThrottle = now;

          // Estimate bytes processed from time processed (rough VBR approximation)
          const estimatedBytes = Math.floor((processedTime / this.duration) * this.fileLength);

          this.speedHistory.push({ processedTime, wallTime: now });

          // Evict entries older than 5s
          while (this.speedHistory.length > 0 && this.speedHistory[0].wallTime < now - 5000) {
            this.speedHistory.shift();
          }

          // Calculate speed: (bytesDelta / wallTimeDelta) using VBR-estimated bytes
          if (this.speedHistory.length > 1) {
            const first = this.speedHistory[0];
            const last = this.speedHistory[this.speedHistory.length - 1];
            const timeDiffSec = (last.wallTime - first.wallTime) / 1000;
            const bytesDelta = Math.floor(((last.processedTime - first.processedTime) / this.duration) * this.fileLength);
            if (timeDiffSec > 0) {
              this.config.onSpeedUpdate?.(bytesDelta / timeDiffSec);
            }
          }

          // Progress update: estimated bytes processed
          this.config.onProgressUpdate?.(processedTime, estimatedBytes);
        }
      };

      await this.conversion.execute();
      console.log('[Transmuxer] Conversion complete');
      // Final speed = 0 on completion
      this.config.onSpeedUpdate?.(0);
    } catch (e) {
      // ConversionCanceledError and InputDisposedError are expected when seekTo()
      // cancels the Conversion and disposes the Input during an active transmux.
      // Re-throw so the caller (useMSEPlayer) can handle silently instead of
      // treating as a fatal error that tears down MSE.
      const isExpectedSeekError = e instanceof Error && (
        e.message.includes('has been canceled') ||
        e.name === 'ConversionCanceledError' ||
        e.message.includes('Input has been disposed') ||
        e.name === 'InputDisposedError'
      );
      if (isExpectedSeekError) {
        console.log('[Transmuxer] Conversion canceled/disposed (expected during seek)');
        throw e;
      }
      if (!this.disposed) {
        this.config.onError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  /**
   * Seek to a time position using manual packet-copy transmuxing.
   * Each call creates a fresh Input (reusing the persistent TauriStreamSource
   * whose cache survives across Input recreations). This guarantees a clean
   * demuxer state that can iterate from any position — unlike refillSeek's
   * reused Input which can't re-iterate packets from consumed positions.
   *
   * @param skipInitSegment When true, the Output skips producing init segment
   *   data. Only media segments are produced. Use for "continuation" refills
   *   where the keyframe timestamp matches the previous seekOffset — the
   *   SourceBuffer already has the init segment from the initial seek.
   *
   * Returns the keyframe timestamp so the caller can set the correct
   * SourceBuffer.timestampOffset.
   */
  async seekTo(seekTime: number, maxDuration: number = Infinity, options?: { skipInitSegment?: boolean }): Promise<number | null> {
    if (this.disposed) return null;

    // Abort any ongoing seek transmux loop
    this.seekAbortFlag = true;

    // Increment generation to discard stale callback data
    this.seekGeneration++;

    // Cancel current conversion and dispose input
    if (this.conversion) {
      try {
        await this.conversion.cancel();
      } catch (_e) {
        // Conversion may already be canceled — ignore
      }
      this.conversion = null;
    }
    if (this.input) {
      this.input.dispose();
      this.input = null;
    }

    // Clear output-related state
    this.ftypData = null;
    this.currentMoofData = null;
    this.ebmlHeaderData = null;
    this.initSegmentBuffer = null;
    this.output = null;

    // Clear abort flag for the new seek
    this.seekAbortFlag = false;

    const currentGeneration = this.seekGeneration;
    const skipInit = options?.skipInitSegment ?? false;

    try {
      const formats = this.config.format === 'ts' ? [MPEG_TS] :
                      this.config.format === 'mkv' ? [MATROSKA] :
                      ALL_FORMATS;

      // For TS format with byte-offset index available:
      // Find the nearest keyframe byte offset and create an OffsetCustomSource
      // that starts from that position. This dramatically speeds up getKeyPacket
      // — instead of scanning the entire file from byte 0 (8-12s), it only
      // scans from the keyframe position (a few hundred KiB, <1s).
      //
      // The OffsetCustomSource creates a virtual file: [header(PAT/PMT)] + [data from byteOffset]
      // mediabunny's Input parses PAT/PMT from the header, then encounters video
      // data starting at the keyframe position. getKeyPacket finds the keyframe
      // quickly because it's right after the header section.
      const byteOffsetKeyframe = this.config.format === 'ts' && this.keyframeByteOffsets.length > 0
        ? this.findNearestKeyframeByteOffset(seekTime)
        : null;

      if (byteOffsetKeyframe !== null && this.tsHeaderData) {
        // Fast TS seek using byte-offset index + OffsetCustomSource
        const offsetSource = createOffsetTauriStreamSource({
          url: this.config.sourceConfig.url,
          fileSize: this.config.sourceConfig.fileSize,
          byteOffset: byteOffsetKeyframe.byteOffset,
          headerData: this.tsHeaderData,
          headers: this.config.sourceConfig.headers ?? {},
          maxCacheSize: 8 * 1024 * 1024, // 8 MiB — enough for seek data + a few seconds
          prefetchProfile: 'fileSystem', // 1 sequential prefetch worker — 'none' causes 188-byte HTTP requests for each TS packet
        });

        this.input = new Input({ source: offsetSource, formats });
        console.log(`[Transmuxer] seekTo: using OffsetCustomSource — byteOffset=${byteOffsetKeyframe.byteOffset}, keyframeTs=${byteOffsetKeyframe.timestamp.toFixed(3)}s, seekTime=${seekTime.toFixed(2)}s`);
      } else {
        // No byte-offset index (MKV, or TS before scanner completes) — use
        // persistent streamSource. For TS, getKeyPacket scans from byte 0.
        this.input = new Input({ source: this.streamSource!, formats });
      }

      const canRead = await this.input.canRead();
      if (!canRead) {
        throw new Error(`Cannot read ${this.config.format} file after seek`);
      }

      // Get tracks
      const videoTrack = await this.input.getPrimaryVideoTrack();
      const audioTrack = await this.input.getPrimaryAudioTrack();

      if (!videoTrack) {
        throw new Error('No video track found after seek');
      }

      const seekStartTime = performance.now();

      // Find the nearest keyframe at or before seekTime.
      const videoKeyStart = performance.now();
      const videoSink = new EncodedPacketSink(videoTrack);
      const cachedKeyframeTs = this.findNearestKeyframe(seekTime);
      const useCachedIndex = cachedKeyframeTs !== null;

      // verifyKeyPackets: false when we know the timestamp from our index
      const verifyKeyPackets = !useCachedIndex;

      // For TS with byte-offset index: we already know the exact keyframe
      // timestamp from findNearestKeyframeByteOffset. Use it directly.
      // For OffsetCustomSource, getKeyPacket scans from byte 0 of the virtual
      // file (which is the header section), then quickly finds the keyframe
      // (which is right after the header). Total scan: ~100-200 KiB, <1s.
      let keyPacket: EncodedPacket | null;
      const seekTargetTs = byteOffsetKeyframe !== null
        ? byteOffsetKeyframe.timestamp // Use byte-offset index timestamp (most accurate)
        : cachedKeyframeTs ?? seekTime;

      if (useCachedIndex || byteOffsetKeyframe !== null) {
        keyPacket = await videoSink.getKeyPacket(seekTargetTs, { verifyKeyPackets: false });
        console.log(`[Transmuxer] seekTo: using keyframe index — seekTargetTs=${seekTargetTs.toFixed(3)}s, seekTime=${seekTime.toFixed(2)}s, byteOffset=${byteOffsetKeyframe?.byteOffset ?? 'N/A'}`);
      } else {
        keyPacket = await videoSink.getKeyPacket(seekTime, { verifyKeyPackets: true });
      }

      // Edge case: seekTime near 0.0 may have no keyframe "at or before" it
      // because the first keyframe in MKV/TS can have a slightly positive
      // timestamp (e.g., 0.04s). getKeyPacket(0.0) returns null even though
      // the first keyframe is right there. Retry with a small positive time
      // to find the first keyframe when seeking near the start of the file.
      if (!keyPacket && seekTime < 1.0) {
        const retryTs = useCachedIndex
          ? this.keyframeTimestamps[0] // Use first keyframe from index if available
          : Math.min(seekTime + 1.0, this.duration / 2);
        keyPacket = await videoSink.getKeyPacket(retryTs, { verifyKeyPackets: verifyKeyPackets });
        if (keyPacket) {
          console.log(`[Transmuxer] seekTo: first-keyframe fallback found keyframe at ${keyPacket.timestamp.toFixed(3)}s for seekTime=${seekTime.toFixed(2)}s`);
        }
      }

      console.log(`[Transmuxer] seekTo: video getKeyPacket took ${performance.now() - videoKeyStart}ms, skipInit=${skipInit}, usedIndex=${useCachedIndex}, byteOffsetSeek=${byteOffsetKeyframe !== null}`);

      if (!keyPacket) {
        // No keyframe found — this is a seek failure, not a fatal transmuxer
        // error. Return null so the caller can handle it without triggering
        // a fatal fallback to native playback.
        console.warn(`[Transmuxer] No keyframe found at or before ${seekTime}s`);
        return null;
      }

      const keyframeTimestamp = keyPacket.timestamp;
      console.log(`[Transmuxer] Seek to ${seekTime}s: keyframe at ${keyframeTimestamp}s`);

      // Collect keyframe timestamp for incremental index building — each seek
      // adds its keyframe to the index, enabling faster nearby seeks with
      // verifyKeyPackets:false. Sorted insertion keeps binary search valid.
      if (!this.keyframeIndexBuilt) {
        // Background scan hasn't completed — build index incrementally
        this.addKeyframeTimestamp(keyframeTimestamp);
      }

      // Create a new Output with generation-guarded callbacks
      this.setupOutput(currentGeneration, skipInit);
      // Capture local reference to prevent concurrent seek clearing this.output
      const localOutput = this.output!;

      // Create manual packet sources — no transcoding, just copy packets
      const videoSource = new EncodedVideoPacketSource(this.videoCodec!);
      const audioSource = this.audioCodec ? new EncodedAudioPacketSource(this.audioCodec) : null;

      // Add tracks to the output
      localOutput.addVideoTrack(videoSource);
      if (audioSource) {
        localOutput.addAudioTrack(audioSource);
      }

      // Start the output — triggers onFtyp + onMoov (init segment)
      await localOutput.start();

      // Get decoder configs for first packet metadata
      const videoDecoderConfig = await videoTrack.getDecoderConfig();
      const videoMeta = { decoderConfig: videoDecoderConfig ?? undefined };
      const audioDecoderConfig = audioTrack ? await audioTrack.getDecoderConfig() : null;
      const audioMeta = audioDecoderConfig
        ? { decoderConfig: audioDecoderConfig as AudioDecoderConfig | undefined }
        : undefined;

      // Find audio starting point nearest to keyframeTimestamp
      // If getKeyPacket fails (audio track has no Cue points), close audioSource
      // immediately — the Output treats closed tracks as "done" (keyFrameQueuedEverywhere
      // returns true for closed tracks), so segments can be produced with video-only data.
      // The init segment still includes the audio track definition (start() ran before
      // closing audioSource). Audio will be added via refill segments later.
      let audioStartPacket: EncodedPacket | null = null;
      let audioSink: EncodedPacketSink | null = null;
      let audioSkipped = false;
      if (audioTrack && audioSource) {
        const audioKeyStart = performance.now();
        audioSink = new EncodedPacketSink(audioTrack);
        // Use verifyKeyPackets: false when keyframe index is available —
        // same optimization as video getKeyPacket. Audio keyframes are less
        // critical than video (all audio packets are independently decodable
        // for AAC/Opus), so verification is even less necessary.
        audioStartPacket = await audioSink.getKeyPacket(keyframeTimestamp, { verifyKeyPackets: false });
        console.log(`[Transmuxer] seekTo: audio getKeyPacket took ${performance.now() - audioKeyStart}ms, result=${audioStartPacket ? 'found' : 'null (will skip audio)'}`);

        if (!audioStartPacket) {
          // No audio keyframe found near seek position — close audio source immediately.
          // This allows the Output to produce video-only segments without waiting for
          // audio data that would require iterating from file start (extremely slow).
          audioSource.close();
          audioSink = null;
          audioSkipped = true;
        }
      }

      // Run video and audio iteration concurrently for proper interleaving
      // If audio was skipped, only iterate video (fast — no audio bottleneck)
      const videoPromise = this.iterateVideoPackets(
        videoSink, keyPacket, videoSource, videoMeta, keyframeTimestamp, currentGeneration, maxDuration, verifyKeyPackets
      );
      const audioPromise = audioSink && audioSource && audioStartPacket
        ? this.iterateAudioPackets(
            audioSink, audioStartPacket, audioSource, audioMeta, keyframeTimestamp, currentGeneration, maxDuration
          )
        : Promise.resolve();

      const iterStartTime = performance.now();
      await Promise.all([videoPromise, audioPromise]);
      console.log(`[Transmuxer] seekTo: iteration took ${performance.now() - iterStartTime}ms (audioSkipped=${audioSkipped})`);

      // Close sources and finalize output
      videoSource.close();
      // audioSource may already be closed if audio was skipped
      if (audioSource && !audioSkipped) audioSource.close();

      if (currentGeneration === this.seekGeneration) {
        await localOutput.finalize();
        console.log(`[Transmuxer] Seek transmux complete, total=${performance.now() - seekStartTime}ms`);
      } else {
        console.log('[Transmuxer] Seek superseded by newer seek (generation mismatch)');
      }

      return keyframeTimestamp;
    } catch (e) {
      // Suppress error if this seek was superseded by a newer seek (generation mismatch),
      // aborted (seekAbortFlag), or the transmuxer was disposed. Also suppress
      // InputDisposedError/ConversionCanceledError which are expected when a newer
      // seek cancels the old one by disposing the Input.
      // CRITICAL: seekAbortFlag alone is insufficient because a concurrent
      // seekTo() call clears seekAbortFlag=false before this catch handler runs,
      // causing InputDisposedError to leak through to onError and tear down MSE.
      const isSuperseded = currentGeneration !== this.seekGeneration;
      const isAborted = this.seekAbortFlag;
      const isDisposed = this.disposed;
      const isExpectedError = e instanceof Error && (
        e.message.includes('has been canceled') ||
        e.name === 'ConversionCanceledError' ||
        e.message.includes('Input has been disposed') ||
        e.name === 'InputDisposedError'
      );

      if (isSuperseded || isAborted || isDisposed || isExpectedError) {
        console.log('[Transmuxer] Seek canceled/disposed (expected during seek)');
      } else {
        console.error('[Transmuxer] Seek failed:', e);
        this.config.onError(e instanceof Error ? e : new Error(String(e)));
      }
      return null;
    }
  }

  /**
   * Iterate video packets from the keyframe onward, adjusting timestamps
   * and adding them to the video source. The first packet gets decoder config metadata.
   */
  private async iterateVideoPackets(
    videoSink: EncodedPacketSink,
    keyPacket: EncodedPacket,
    videoSource: EncodedVideoPacketSource,
    videoMeta: { decoderConfig: VideoDecoderConfig | undefined },
    keyframeTimestamp: number,
    generation: number,
    maxDuration: number,
    verifyKeyPackets: boolean = true,
  ): Promise<void> {
    let isFirst = true;
    for await (const packet of videoSink.packets(keyPacket, undefined, { verifyKeyPackets })) {
      if (this.seekAbortFlag || this.disposed || generation !== this.seekGeneration) {
        videoSource.close();
        return;
      }

      // Clamp to non-negative: audio key packet timestamp can be slightly
      // before video keyframe (e.g., 1227.8706 vs 1227.883), producing
      // small negative values that IsobmffMuxer.validateTimestamp rejects.
      const adjustedTimestamp = Math.max(0, packet.timestamp - keyframeTimestamp);

      // Stop after producing enough data (maxDuration) — prevents iterating
      // the entire remaining file for large files, making seeks instant.
      if (maxDuration !== Infinity && adjustedTimestamp > maxDuration) {
        break;
      }

      const adjusted = packet.clone({
        timestamp: adjustedTimestamp,
      });

      if (isFirst) {
        await videoSource.add(adjusted, videoMeta);
        isFirst = false;
      } else {
        await videoSource.add(adjusted);
      }

      this.lastProcessedTime = packet.timestamp;
    }
  }

  /**
   * Iterate audio packets from a starting key packet onward, adjusting timestamps.
   * Timestamps are clamped to non-negative to avoid IsobmffMuxer validation errors
   * when the audio key packet is slightly before the video keyframe.
   */
  private async iterateAudioPackets(
    audioSink: EncodedPacketSink,
    startPacket: EncodedPacket,
    audioSource: EncodedAudioPacketSource,
    audioMeta: { decoderConfig: AudioDecoderConfig | undefined } | undefined,
    keyframeTimestamp: number,
    generation: number,
    maxDuration: number,
  ): Promise<void> {
    let isFirst = true;
    for await (const packet of audioSink.packets(startPacket)) {
      if (this.seekAbortFlag || this.disposed || generation !== this.seekGeneration) {
        audioSource.close();
        return;
      }

      // Clamp to non-negative: audio key packet timestamp can be slightly
      // before video keyframe (e.g., 1227.8706 vs 1227.883), producing
      // small negative values that IsobmffMuxer.validateTimestamp rejects.
      const adjustedTimestamp = Math.max(0, packet.timestamp - keyframeTimestamp);

      // Stop after producing enough data (maxDuration) — prevents iterating
      // the entire remaining file for large files, making seeks instant.
      if (maxDuration !== Infinity && adjustedTimestamp > maxDuration) {
        break;
      }

      const adjusted = packet.clone({
        timestamp: adjustedTimestamp,
      });

      if (isFirst) {
        await audioSource.add(adjusted, audioMeta);
        isFirst = false;
      } else {
        await audioSource.add(adjusted);
      }
    }
  }

  /**
   * Iterate audio packets from the beginning (no key packet found near keyframe).
   * Skips packets before keyframeTimestamp and clamps adjusted timestamps
   * to non-negative for the same reason as iterateAudioPackets.
   */
  getMseDecision(): MseCodecDecision {
    return this.mseDecision;
  }

  getMimeType(): string {
    return this.mimeType;
  }

  getInitSegment(): ArrayBuffer | null {
    return this.initSegmentBuffer;
  }

  getLastProcessedTime(): number {
    return this.lastProcessedTime;
  }

  getDuration(): number {
    return this.duration;
  }

  getFileLength(): number {
    return this.fileLength;
  }

  /** Abort an ongoing seek iteration. Used by thumbnail pipeline to stop
   *  seek after collecting enough segments (a few frames). */
  abortSeek(): void {
    this.seekAbortFlag = true;
  }

  dispose(): void {
    this.disposed = true;
    this.seekAbortFlag = true;
    this.speedHistory = [];
    this.keyframeTimestamps = [];
    this.keyframeIndexBuilt = false;
    this.keyframeIndexPartial = false;
    this.keyframeByteOffsets = [];
    this.tsHeaderData = null;
    if (this.conversion) {
      this.conversion.cancel().catch(() => {});
    }
    if (this.input) {
      this.input.dispose();
    }
    // Free master SourceRef — when all refs are freed, the Source is disposed
    // (its CustomSource dispose callback sets disposed=true to prevent further reads).
    if (this.masterSourceRef && !this.masterSourceRef.freed) {
      this.masterSourceRef.free();
    }
  }
}
