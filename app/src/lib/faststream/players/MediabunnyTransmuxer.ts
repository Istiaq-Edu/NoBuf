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
  BufferSource,
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

// Layer-1 audio-start fallback window (reports/mkv-audioskip-solution.md §Layer 1).
// getFirstKeyPacket scans from segment start by DESIGN (bypasses cues) — cheap only
// when the window itself is near the head (bytes already in the seed/cold-start
// prefetch, and the subsequent audio iteration covers ≤ this many seconds). For
// mid-file windows the fallback must NOT run: iterating audio from the file's first
// packet to a far window would stream every cluster in between over HTTP (edge-A D9).
const NEAR_START_AUDIO_FALLBACK_S = 10;

// Round-3 Fix A-2: cap for the harvested-boundary fallback in nextKeyframeAtOrAfter.
// Mirrors REFILL_MAX_DURATION_CAP (useMSEPlayer). The harvest can be gappy across
// far-seek discontinuities, and a stopTime BYPASSES maxDuration in the video
// iteration — an unclamped cross-gap boundary would transmux minutes in one refill.
const HARVEST_BOUNDARY_CLAMP_S = 25;

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

/** Fix A2 (round-2): post-resolve abandon predicate. True ⇒ this seek was condemned while its
 *  getKeyPacket walk ran (interrupt set seekAbortFlag / dispose / a newer seek bumped the
 *  generation) and must do ZERO further work — see the belt call in seekTo. Pure + exported
 *  for unit testing (house pattern: shouldInterruptInflightSeek et al.). */
export function shouldAbandonResolvedSeek(
  seekAbortFlag: boolean, disposed: boolean, capturedGen: number, liveGen: number,
): boolean {
  return seekAbortFlag || disposed || capturedGen !== liveGen;
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
  // User-selected audio track id (mediabunny InputTrack.id). null = primary.
  // Consumed by resolveAudioTrack() at init and in the seekTo() hot path, so a
  // switch = set this + rebuild from playhead (audio-track-selection plan §3).
  private desiredAudioTrackId: number | null = null;
  // Layer 3 support (audio-skip fix): audio packets actually emitted by the
  // current seekTo window. A 2-track window that emits ZERO audio packets
  // starves the SourceBuffer's buffered intersection (stall with no error
  // event) — the refill chain watches this via wasLastWindowAudioStarved().
  private windowAudioPacketsAdded = 0;
  private lastWindowAudioStarved = false;
  private ebmlHeaderData: Uint8Array | null = null;
  private lastProcessedTime: number = 0;
  private seekAbortFlag = false;
  // Keyframe time of the last resolved seek — paired with the source's captured
  // cluster byte to form a real VBR byte↔time calibration anchor.
  private lastSeekKeyframeTime = -1;
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
  private tsHeaderData: Uint8Array | null = null;
  private initInputRef: Input | null = null;

  // MKV Cues byte index — extracted from mediabunny's already-parsed cuePoints
  // at init: sorted [{time (s), byteOffset (absolute cluster byte)}]. mediabunny
  // parses these from the file's Cues element to seek, and clusterPosition is the
  // EXACT VBR cluster byte — unlike the linear time/duration estimate. Used to
  // tell the backend prefetch the real byte region for a seek target so the cold
  // cluster fetch hits warm cache instead of a wrong-region miss. Empty when the
  // MKV has no Cues or mediabunny's internal layout changed (guarded extraction).
  private mkvCueIndex: { time: number; byteOffset: number }[] = [];

  // Cue-less MKV harvest watermark (fix A, reports/refill-stall-solution.md):
  // ONE contiguous span [start, end] of fully-iterated packet timestamps.
  // Inside it, every keyframe is guaranteed present in keyframeTimestamps, so
  // findNearestKeyframe may trust the index at any distance. -1 = empty.
  private harvestSpanStart = -1;
  private harvestSpanEnd = -1;

  constructor(config: TransmuxerConfig) {
    this.config = config;
  }

  /** Extract mediabunny's already-parsed MKV Cues into a sorted time→byte index.
   *  Reaches internal demuxer fields (no public API exists) — fully guarded so a
   *  mediabunny layout change degrades to an empty index (current behavior), never
   *  a crash. cuePoint.time is in segment ticks (÷ timestampFactor = seconds);
   *  clusterPosition is the absolute file byte of the cluster. Called once at init. */
  private extractMkvCueIndex(videoTrack: unknown): void {
    if (this.config.format !== 'mkv') return;
    try {
      const internal = (videoTrack as any)?._backing?.internalTrack;
      const factor = internal?.segment?.timestampFactor;
      const cues = internal?.cuePoints;
      if (!Array.isArray(cues) || !factor || factor <= 0) return;
      const index: { time: number; byteOffset: number }[] = [];
      for (const c of cues) {
        if (typeof c?.time !== 'number' || typeof c?.clusterPosition !== 'number') continue;
        if (c.clusterPosition < 0) continue;
        index.push({ time: c.time / factor, byteOffset: c.clusterPosition });
      }
      index.sort((a, b) => a.time - b.time);
      this.mkvCueIndex = index;
      diagLog(`[Transmuxer] MKV cue index: extracted ${index.length} cue points (real VBR byte offsets)`);
    } catch (e: any) {
      diagLog(`[Transmuxer] MKV cue index extraction failed (non-fatal): ${e?.message ?? e}`);
      this.mkvCueIndex = [];
    }
  }

  /** Real cluster byte at/just before `time` from the MKV cue index, or -1 if the
   *  index is empty/unavailable. Used to point the backend prefetch at the exact
   *  VBR region a seek will read, instead of a linear time/duration estimate. */
  getByteOffsetForTime(time: number): number {
    const idx = this.mkvCueIndex;
    if (idx.length === 0 || !Number.isFinite(time)) return -1;
    let lo = 0, hi = idx.length - 1;
    if (time <= idx[0].time) return idx[0].byteOffset;
    while (lo < hi) {
      const mid = lo + ((hi - lo + 1) >> 1);
      if (idx[mid].time <= time) lo = mid; else hi = mid - 1;
    }
    return idx[lo].byteOffset;
  }

  /** The full extracted MKV cue index (sorted time→byte). Used to seed the
   *  player's byte↔time calibration table so the green prebuffer bar is
   *  VBR-accurate from the first frame of any seek, not after it self-corrects. */
  getMkvCueIndex(): { time: number; byteOffset: number }[] {
    return this.mkvCueIndex;
  }

  /** Fix #1: first cue keyframe time STRICTLY greater than `time`, or null if
   *  none/empty. Refills use this as their stop boundary so a refill ends
   *  exactly on a GOP boundary; the NEXT refill then seeks to that same
   *  boundary and abuts with zero overlap (no coded-frame replacement → no
   *  PIPELINE_ERROR_DECODE) and zero gap (boundary is a real keyframe, so the
   *  next GOP starts precisely where this one stopped). Returns null when the
   *  cue index is unavailable (TS / pre-parse), so callers fall back to the
   *  original maxDuration behavior unchanged. */
  nextKeyframeAtOrAfter(time: number): number | null {
    if (!Number.isFinite(time)) return null;
    const idx = this.mkvCueIndex;
    if (idx.length === 0) {
      // Round-3 Fix A-2: cue-less MKV — fall back to the harvested keyframe index
      // (sorted+deduped by addKeyframeTimestamp). Without this, every cue-less
      // refill/switch stopTime is Infinity → the switch seekTo stops mid-GOP → the
      // first post-switch refill re-resolves the SAME keyframe behind the playhead
      // and replaces coded frames right at it (round-3 logs: 4/4 switches). Gated
      // on mkv: the class is format-agnostic and the TS scanner also populates
      // keyframeTimestamps (review R7). CLAMP: harvest can be gappy across far-seek
      // discontinuities, and stopTime BYPASSES maxDuration in iterateVideoPackets —
      // an unclamped cross-gap boundary would transmux minutes (review R8).
      if (this.config.format !== 'mkv') return null;
      const ts = this.keyframeTimestamps;
      if (ts.length === 0) return null;
      let lo = 0, hi = ts.length; // find first ts[i] > time
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ts[mid] > time) hi = mid; else lo = mid + 1;
      }
      if (lo >= ts.length) return null;
      return ts[lo] - time <= HARVEST_BOUNDARY_CLAMP_S ? ts[lo] : null;
    }
    let lo = 0, hi = idx.length; // find first idx[i].time > time
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (idx[mid].time > time) hi = mid; else lo = mid + 1;
    }
    return lo < idx.length ? idx[lo].time : null;
  }

  /** Nearest MKV cue keyframe time AT OR BEFORE `time`, or null if none/empty.
   *  Unlike findNearestKeyframe (which reads the sparse, incrementally-built
   *  keyframeTimestamps), this consults the FULL 419-entry parsed cue index, so
   *  it has complete coverage for ANY seek target. Wiring this into seekTo turns
   *  a far uncached MKV seek from an ~8s blind network cluster scan
   *  (getKeyPacket(seekTime) with verifyKeyPackets:true) into a ~100ms indexed
   *  jump (getKeyPacket(knownKeyframeTs) with verifyKeyPackets:false). */
  nearestCueKeyframeAtOrBefore(time: number): number | null {
    const idx = this.mkvCueIndex;
    if (idx.length === 0 || !Number.isFinite(time)) return null;
    // Binary search: rightmost idx[i].time <= time
    let lo = 0, hi = idx.length - 1;
    while (lo < hi) {
      const mid = lo + ((hi - lo + 1) >> 1);
      if (idx[mid].time <= time) lo = mid; else hi = mid - 1;
    }
    if (idx[lo].time <= time) return idx[lo].time;
    return idx[0].time < 1.0 && time < 1.0 ? idx[0].time : null;
  }

  /** Snap `time` to the nearest cue keyframe when it lies within `tolerance`
   *  seconds of one; otherwise return `time` unchanged. Fixes the abutting-refill
   *  waste: a refill stops by breaking at `packet.timestamp >= stopKf`, so it
   *  appends every sample strictly BELOW the stop keyframe. SourceBuffer.buffered.end
   *  then reports ~1ms below that keyframe (the last muxed sample's end — a
   *  DIFFERENT float clock than the MKV cue time). The next refill uses that
   *  bufEnd as its seek position, and nearestCueKeyframeAtOrBefore() rounds it
   *  DOWN a full GOP (the stop keyframe is 1ms ABOVE bufEnd, so "at or before"
   *  skips it), re-transmuxing ~10s already buffered (observed: bufEnd=1515.336
   *  → re-seek to 1505.327, overlap=10.009s). Snapping bufEnd up to the cue
   *  keyframe (1515.337) makes the refill abut cleanly. Tolerance 0.25s ≫ the
   *  ~1ms clock skew yet ≪ any real GOP interval (~10s here), so it can never
   *  mis-snap across a keyframe. No-op (returns `time`) when the cue index is
   *  unavailable (TS / pre-parse), preserving that path unchanged. */
  snapToCueKeyframe(time: number, tolerance: number = 0.25): number {
    if (!Number.isFinite(time)) return time;
    const idx = this.mkvCueIndex;
    if (idx.length === 0) {
      // Round-3 Fix A-2: harvested fallback (same rationale as nextKeyframeAtOrAfter;
      // no clamp needed — a snap is bounded by `tolerance` by construction).
      if (this.config.format !== 'mkv') return time;
      const ts = this.keyframeTimestamps;
      if (ts.length === 0) return time;
      let lo = 0, hi = ts.length; // first ts[i] >= time
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ts[mid] < time) lo = mid + 1; else hi = mid;
      }
      let best = time;
      let bestDelta = tolerance;
      for (const i of [lo - 1, lo]) {
        if (i < 0 || i >= ts.length) continue;
        const delta = Math.abs(ts[i] - time);
        if (delta <= bestDelta) { bestDelta = delta; best = ts[i]; }
      }
      return best;
    }
    // Binary search for the insertion point, then compare the neighbours on
    // either side — the nearest cue may be just above or just below `time`.
    let lo = 0, hi = idx.length; // first idx[i].time >= time
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (idx[mid].time < time) lo = mid + 1; else hi = mid;
    }
    let best = time;
    let bestDelta = tolerance;
    for (const i of [lo - 1, lo]) {
      if (i < 0 || i >= idx.length) continue;
      const delta = Math.abs(idx[i].time - time);
      if (delta <= bestDelta) { bestDelta = delta; best = idx[i].time; }
    }
    return best;
  }

  async init(): Promise<TransmuxerInitResult | null> {
    if (this.disposed) return null;

    try {
      this.streamSource = createTauriStreamSource(this.config.sourceConfig);
      this.masterSourceRef = this.streamSource.ref();

      const formats = this.config.format === 'ts' ? [MPEG_TS] :
                      this.config.format === 'mkv' ? [MATROSKA] :
                      ALL_FORMATS;

      let initInput: Input | undefined;
      const isTs = this.config.format === 'ts';

      if (isTs && this.config.sourceConfig.seedData) {
        const initSource = new BufferSource(this.config.sourceConfig.seedData);
        initInput = new Input({ source: initSource, formats: [MPEG_TS] });
        const t0init = performance.now();
        try {
          await initInput.getTracks();
          this.initInputRef = initInput;
          diagLog(`[Transmuxer] init: initInput pre-warmed from ${this.config.sourceConfig.seedData.byteLength} bytes seed, took ${((performance.now() - t0init) / 1000).toFixed(2)}s`);
        } catch (e) {
          diagLog(`[Transmuxer] init: initInput pre-warm failed: ${e}, continuing without`);
          initInput = undefined;
        }
      }

      // For TS: skip Conversion.init() — it calls getFirstTimestamp() which
      // reads packets past the seed (40+ seconds over HTTP). Instead, use
      // seekTo(0) in startTransmuxing() which produces segments via manual
      // packet-copy (proven path, same as seeking). The main Input is created
      // lazily inside seekTo() with initInput for fast codec matching.
      // For non-TS (MKV): use the existing Conversion path (fast random access).
      if (isTs) {
        const trackInput = initInput || (() => { throw new Error('No initInput for TS'); })();

        const t2 = performance.now();
        diagLog(`[Transmuxer] init: calling getPrimaryVideoTrack() on initInput`);
        const videoTrack = await trackInput.getPrimaryVideoTrack();
        diagLog(`[Transmuxer] init: getPrimaryVideoTrack()=${videoTrack ? 'found' : 'null'} took ${((performance.now() - t2)/1000).toFixed(1)}s`);

        const t3 = performance.now();
        diagLog(`[Transmuxer] init: calling getPrimaryAudioTrack() on initInput`);
        const audioTrack = await trackInput.getPrimaryAudioTrack();
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

        this.duration = Infinity;
        this.fileLength = this.config.sourceConfig.fileSize;
        diagLog(`[Transmuxer] init: TS — duration=Infinity, skipping Conversion.init()`);
        this.config.onDurationKnown(Infinity);
        this.deferComputeDuration();

        diagLog(`[Transmuxer] init: SUCCESS — ts → ${this.mseDecision}, mimeType=${this.mimeType}`);

        return {
          mseDecision: this.mseDecision,
          mimeType: this.mimeType,
          videoTrack: this.videoTrackInfo,
          audioTrack: this.audioTrackInfo,
        };
      }

      // Non-TS (MKV) path: use Conversion for streaming
      this.input = new Input({ source: this.streamSource, formats });

      const t0 = performance.now();
      diagLog(`[Transmuxer] init: starting canRead() at t=${t0.toFixed(0)}ms`);
      const canRead = await this.input.canRead();
      diagLog(`[Transmuxer] init: canRead()=${canRead} took ${((performance.now() - t0)/1000).toFixed(1)}s`);
      if (!canRead) {
        throw new Error(`Cannot read ${this.config.format} file`);
      }

      let duration: number | null = null;
      const t1 = performance.now();
      diagLog(`[Transmuxer] init: calling getDurationFromMetadata()`);
      const metadataDuration = await this.input.getDurationFromMetadata();
      diagLog(`[Transmuxer] init: getDurationFromMetadata()=${metadataDuration} took ${((performance.now() - t1)/1000).toFixed(1)}s`);
      if (metadataDuration !== null) {
        duration = metadataDuration;
      } else {
        duration = await this.input.computeDuration();
      }

      this.duration = duration;
      this.fileLength = this.config.sourceConfig.fileSize;
      diagLog(`[Transmuxer] init: duration=${duration}, calling onDurationKnown`);
      this.config.onDurationKnown(duration);

      const t2 = performance.now();
      diagLog(`[Transmuxer] init: calling getPrimaryVideoTrack()`);
      const videoTrack = await this.input.getPrimaryVideoTrack();
      diagLog(`[Transmuxer] init: getPrimaryVideoTrack()=${videoTrack ? 'found' : 'null'} took ${((performance.now() - t2)/1000).toFixed(1)}s`);

      // Build the real VBR time→byte cue index from mediabunny's parsed Cues.
      if (videoTrack) this.extractMkvCueIndex(videoTrack);

      const t3 = performance.now();
      diagLog(`[Transmuxer] init: calling resolveAudioTrack()`);
      let audioTrack = await this.resolveAudioTrack(this.input);
      diagLog(`[Transmuxer] init: resolveAudioTrack()=${audioTrack ? 'found' : 'null'} took ${((performance.now() - t3)/1000).toFixed(1)}s`);

      // Layer 2 (audio-skip fix): probe the audio START before declaring the
      // mime. The SourceBuffer is created from init()'s track inventory, but
      // whether audio can actually be EMITTED is only known after a start
      // lookup — for a cue-less MKV whose audio starts >0s the legacy lookup
      // returned null, audio was silently skipped, and the init segment
      // omitted the promised aac trak → Chromium code-4 fatal. Probe with the
      // same Layer-1 chain the windows use (head bytes are seed-cached, so
      // this costs one in-memory cluster read); if even the chain fails,
      // declare video-only NOW — every downstream site keys off audioCodec,
      // so the mime, setupOutput's addAudioTrack, and the window pumps all
      // stay consistent automatically.
      if (audioTrack) {
        const probeSink = new EncodedPacketSink(audioTrack);
        const probe = await this.resolveAudioStartPacket(probeSink, 0, this.seekGeneration);
        if (!probe) {
          diagLog('[Transmuxer] init: audio start UNRESOLVABLE (even via fallback chain) — declaring VIDEO-ONLY output');
          audioTrack = null;
        }
      }

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
    // Dedup via neighbor check — O(log n) total, replacing the old O(n)
    // ts.some() scan (the harvest path calls this per keyframe; ~3k keyframes
    // on a 9h file would make the linear scan ~5M compares over the file).
    if ((lo < ts.length && Math.abs(ts[lo] - timestamp) < 0.01)
     || (lo > 0 && Math.abs(ts[lo - 1] - timestamp) < 0.01)) return;
    ts.splice(lo, 0, timestamp);
    this.keyframeIndexPartial = true;
  }

  /** Watermark update (cue-less MKV harvest). Consecutive refill windows
   *  OVERLAP by construction on cue-less files (the next window re-resolves
   *  the PRIOR keyframe behind the mid-GOP maxDuration cut), so the merge
   *  branch runs with negative gap; the 0.25s tolerance additionally bridges
   *  float jitter on exact-abut geometries. A disjoint HIGHER window (far
   *  forward seek) RESETS the span (single-span model — the refill chain only
   *  queries the current playback region; GOP>12s coverage behind a far seek
   *  degrades to the G1/B guards, disclosed in the design). A disjoint LOWER
   *  window merges without extending — the span can under-claim, NEVER
   *  over-claim (span facts are monotone: once fully iterated, always true). */
  private noteIterated(ts: number): void {
    if (this.harvestSpanEnd >= 0 && ts <= this.harvestSpanEnd + 0.25) {
      if (ts > this.harvestSpanEnd) this.harvestSpanEnd = ts;
    } else if (ts > this.harvestSpanEnd) {
      // First-ever window or disjoint-higher reset. (`ts > end` is always
      // true here for non-negative timestamps; the guard only rejects
      // degenerate negatives.)
      this.harvestSpanStart = ts;
      this.harvestSpanEnd = ts;
    }
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
      // For partial indexes (built incrementally from seeks), the nearest INDEXED
      // keyframe may be far before seekTime with un-indexed keyframes in between —
      // returning it would make the caller seek to that stale position instead of
      // seekTime (observed: a sparse [0.09s] index collapsed every refill seek
      // (15s, 17s, …) back to 0.09s → same-keyframe → false EOF at 17s). Only
      // trust a partial-index hit within ONE GOP (~12s); beyond that, return null
      // so the caller falls back to native getKeyPacket(seekTime), which finds the
      // true keyframe at the requested position (fast for MKV — cluster-based).
      // Inside the harvest watermark the index provably contains EVERY
      // keyframe of the span, so the nearest indexed keyframe IS the true
      // nearest — trust it at any distance (a GOP>12s cue-less file would
      // otherwise still null). Outside the span the 12s rule is unchanged.
      const inWatermark = this.harvestSpanEnd >= 0
        && seekTime >= this.harvestSpanStart && seekTime <= this.harvestSpanEnd + 0.25;
      if (!this.keyframeIndexBuilt && !inWatermark && seekTime - ts[lo] > 12) {
        return null; // Sparse coverage — don't seek to a distant stale keyframe
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

  /** Real cluster byte + keyframe time of the last resolved seek — used to add
   *  a VBR byte↔time calibration anchor. Returns null until a seek captures it. */
  getLastSeekAnchor(): { byteOffset: number; time: number } | null {
    const byteOffset = (this.streamSource as any)?.getClusterByteOfLastSeek?.() ?? -1;
    if (byteOffset < 0 || this.lastSeekKeyframeTime < 0) return null;
    return { byteOffset, time: this.lastSeekKeyframeTime };
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

  /** Phase 1 for TS: produce init + media segments from initInput (BufferSource).
   *  All reads are in-memory (instant) — no HTTP binary search overhead.
   *  Produces ~5-10s of video from the 20MB seed data. */
  private async produceSegmentsFromInitInput(): Promise<number | null> {
    if (!this.initInputRef || this.disposed) return null;

    const initInput = this.initInputRef;
    const generation = this.seekGeneration;

    const videoTrack = await initInput.getPrimaryVideoTrack();
    const audioTrack = await initInput.getPrimaryAudioTrack();
    if (!videoTrack) return null;

    this.setupOutput(generation);
    const output = this.output!;

    const videoSource = new EncodedVideoPacketSource(this.videoCodec!);
    const audioSource = this.audioCodec ? new EncodedAudioPacketSource(this.audioCodec) : null;

    output.addVideoTrack(videoSource);
    if (audioSource) output.addAudioTrack(audioSource);

    await output.start();

    const videoSink = new EncodedPacketSink(videoTrack);
    const keyPacket = await videoSink.getFirstKeyPacket();
    if (!keyPacket) return null;

    const keyframeTimestamp = keyPacket.timestamp;

    const videoDecoderConfig = await videoTrack.getDecoderConfig();
    const videoMeta = { decoderConfig: videoDecoderConfig ?? undefined };

    let audioStartPacket: EncodedPacket | null = null;
    let audioSink: EncodedPacketSink | null = null;
    let audioSkipped = false;
    if (audioTrack && audioSource) {
      audioSink = new EncodedPacketSink(audioTrack);
      audioStartPacket = await this.resolveAudioStartPacket(audioSink, keyframeTimestamp, generation);
      if (!audioStartPacket) {
        audioSource.close();
        audioSink = null;
        audioSkipped = true;
      }
    }

    const audioDecoderConfig = audioTrack ? await audioTrack.getDecoderConfig() : null;
    const audioMeta = audioDecoderConfig
      ? { decoderConfig: audioDecoderConfig as AudioDecoderConfig | undefined }
      : undefined;

    const videoPromise = this.iterateVideoPackets(
      videoSink, keyPacket, videoSource, videoMeta, keyframeTimestamp, generation, Infinity, false,
    );
    const audioPromise = audioSink && audioSource && audioStartPacket
      ? this.iterateAudioPackets(
          audioSink, audioStartPacket, audioSource, audioMeta, keyframeTimestamp, generation, Infinity,
        )
      : Promise.resolve();

    try {
      await Promise.all([videoPromise, audioPromise]);
    } catch (e) {
      diagLog(`[Transmuxer] Phase 1 iteration ended: ${e instanceof Error ? e.message : String(e)}`);
    }

    try { videoSource.close(); } catch (_) {}
    if (audioSource && !audioSkipped) {
      try { audioSource.close(); } catch (_) {}
    }

    if (generation === this.seekGeneration) {
      try { await output.finalize(); } catch (_) {}
    }

    return keyframeTimestamp;
  }

  /** Phase 2 for TS: sequential iteration from byte 0 using TauriStreamSource.
   *  The first 20MB (seed) reads are instant, so skipping past Phase 1's
   *  data takes ~1s. Past the seed, the read-ahead buffer handles HTTP.
   *  No binary search, no scanner wait needed. */
  private async sequentialContinue(skipBeforeTime: number): Promise<void> {
    if (this.disposed || !this.streamSource) return;

    const formats = [MPEG_TS];
    const generation = this.seekGeneration;

    this.input = new Input({
      source: this.streamSource,
      formats,
      initInput: this.initInputRef ?? undefined,
    });

    diagLog(`[Transmuxer] seqContinue: calling canRead at t=${performance.now().toFixed(0)}ms`);
    const t0 = performance.now();
    const canRead = await this.input.canRead();
    diagLog(`[Transmuxer] seqContinue: canRead took ${((performance.now() - t0)/1000).toFixed(2)}s`);
    if (!canRead) return;

    diagLog(`[Transmuxer] seqContinue: calling getPrimaryVideoTrack at t=${performance.now().toFixed(0)}ms`);
    const t1 = performance.now();
    const videoTrack = await this.input.getPrimaryVideoTrack();
    diagLog(`[Transmuxer] seqContinue: getPrimaryVideoTrack took ${((performance.now() - t1)/1000).toFixed(2)}s`);
    diagLog(`[Transmuxer] seqContinue: calling getPrimaryAudioTrack at t=${performance.now().toFixed(0)}ms`);
    const t2 = performance.now();
    const audioTrack = await this.input.getPrimaryAudioTrack();
    diagLog(`[Transmuxer] seqContinue: getPrimaryAudioTrack took ${((performance.now() - t2)/1000).toFixed(2)}s`);
    if (!videoTrack) return;

    const videoSink = new EncodedPacketSink(videoTrack);
    diagLog(`[Transmuxer] seqContinue: calling getFirstKeyPacket at t=${performance.now().toFixed(0)}ms`);
    const t3 = performance.now();
    const firstKey = await videoSink.getFirstKeyPacket();
    diagLog(`[Transmuxer] seqContinue: getFirstKeyPacket took ${((performance.now() - t3)/1000).toFixed(2)}s`);
    if (!firstKey) return;

    const keyframeTimestamp = firstKey.timestamp;
    diagLog(`[Transmuxer] seqContinue: firstKey at ${keyframeTimestamp.toFixed(3)}s, skipBefore=${skipBeforeTime.toFixed(2)}s`);

    diagLog(`[Transmuxer] seqContinue: calling setupOutput at t=${performance.now().toFixed(0)}ms`);
    const t4 = performance.now();
    this.setupOutput(generation, true); // skipInitSegment = true
    diagLog(`[Transmuxer] seqContinue: setupOutput took ${((performance.now() - t4)/1000).toFixed(2)}s`);
    const output = this.output!;

    const videoSource = new EncodedVideoPacketSource(this.videoCodec!);
    const audioSource = this.audioCodec ? new EncodedAudioPacketSource(this.audioCodec) : null;

    output.addVideoTrack(videoSource);
    if (audioSource) output.addAudioTrack(audioSource);

    diagLog(`[Transmuxer] seqContinue: calling output.start at t=${performance.now().toFixed(0)}ms`);
    const t5 = performance.now();
    await output.start();
    diagLog(`[Transmuxer] seqContinue: output.start took ${((performance.now() - t5)/1000).toFixed(2)}s`);

    diagLog(`[Transmuxer] seqContinue: calling videoTrack.getDecoderConfig at t=${performance.now().toFixed(0)}ms`);
    const t6 = performance.now();
    const videoDecoderConfig = await videoTrack.getDecoderConfig();
    diagLog(`[Transmuxer] seqContinue: videoTrack.getDecoderConfig took ${((performance.now() - t6)/1000).toFixed(2)}s`);
    const videoMeta = { decoderConfig: videoDecoderConfig ?? undefined };

    let audioStartPacket: EncodedPacket | null = null;
    let audioSink: EncodedPacketSink | null = null;
    let audioSkipped = false;
    if (audioTrack && audioSource) {
      audioSink = new EncodedPacketSink(audioTrack);
      diagLog(`[Transmuxer] seqContinue: resolving audio start at t=${performance.now().toFixed(0)}ms`);
      const t7 = performance.now();
      audioStartPacket = await this.resolveAudioStartPacket(audioSink, keyframeTimestamp, generation);
      diagLog(`[Transmuxer] seqContinue: audio start resolve took ${((performance.now() - t7)/1000).toFixed(2)}s`);
      if (!audioStartPacket) {
        audioSource.close();
        audioSink = null;
        audioSkipped = true;
      }
    }

    diagLog(`[Transmuxer] seqContinue: calling audioTrack.getDecoderConfig at t=${performance.now().toFixed(0)}ms`);
    const t8 = performance.now();
    const audioDecoderConfig = audioTrack ? await audioTrack.getDecoderConfig() : null;
    diagLog(`[Transmuxer] seqContinue: audioTrack.getDecoderConfig took ${((performance.now() - t8)/1000).toFixed(2)}s`);
    const audioMeta = audioDecoderConfig
      ? { decoderConfig: audioDecoderConfig as AudioDecoderConfig | undefined }
      : undefined;

    let videoFirst = true;
    let audioFirst = true;
    let videoStarted = false;
    let audioStarted = false;

    const videoPromise = (async () => {
      for await (const packet of videoSink.packets(firstKey, undefined, { verifyKeyPackets: false })) {
        if (this.disposed || generation !== this.seekGeneration) {
          videoSource.close();
          return;
        }

        const adjustedTimestamp = Math.max(0, packet.timestamp - keyframeTimestamp);

        if (!videoStarted && packet.timestamp < skipBeforeTime - 0.5) {
          continue;
        }
        videoStarted = true;

        const adjusted = packet.clone({ timestamp: adjustedTimestamp });
        if (videoFirst) {
          await videoSource.add(adjusted, videoMeta);
          videoFirst = false;
        } else {
          await videoSource.add(adjusted);
        }
        this.lastProcessedTime = packet.timestamp;
      }
    })();

    const audioPromise = audioSink && audioSource && audioStartPacket
      ? (async () => {
          for await (const packet of audioSink.packets(audioStartPacket!)) {
            if (this.disposed || generation !== this.seekGeneration) {
              audioSource.close();
              return;
            }

            if (!audioStarted && packet.timestamp < skipBeforeTime - 0.5) {
              continue;
            }
            audioStarted = true;

            const adjustedTimestamp = Math.max(0, packet.timestamp - keyframeTimestamp);
            const adjusted = packet.clone({ timestamp: adjustedTimestamp });
            if (audioFirst) {
              await audioSource.add(adjusted, audioMeta);
              audioFirst = false;
            } else {
              await audioSource.add(adjusted);
            }
          }
        })()
      : Promise.resolve();

    const iterStart = performance.now();
    await Promise.all([videoPromise, audioPromise]);
    diagLog(`[Transmuxer] seqContinue: iteration took ${((performance.now() - iterStart)/1000).toFixed(1)}s`);

    try { videoSource.close(); } catch (_) {}
    if (audioSource && !audioSkipped) {
      try { audioSource.close(); } catch (_) {}
    }

    if (generation === this.seekGeneration) {
      try { await output.finalize(); } catch (_) {}
      diagLog('[Transmuxer] seqContinue: finalized');
    }
  }

  async startTransmuxing(): Promise<void> {
    if (this.disposed) return;

    try {
      if (this.config.format === 'ts' && this.initInputRef) {
        // Phase 1: produce segments from initInput (BufferSource, all in-memory).
        // getKeyPacket/getFirstKeyPacket on initInput is instant — no binary
        // search over HTTP. Produces init segment + ~5-10s of video from 20MB seed.
        diagLog('[Transmuxer] Phase 1: starting with initInput');
        const phase1Result = await this.produceSegmentsFromInitInput();
        diagLog(`[Transmuxer] Phase 1 done: keyframe=${phase1Result}, lastTime=${this.lastProcessedTime.toFixed(2)}s`);

        // Phase 2: sequential continuation from main Input.
        // Instead of binary-search seekTo (30-60s over HTTP), iterate from
        // byte 0 using streamSource. The first 20MB reads from seed (instant),
        // so we skip past Phase 1's data in ~1s. Past the seed, the read-ahead
        // buffer fetches 8MB chunks. No binary search, no scanner wait.
        // Start scanner in background for future seeks (non-blocking).
        if (!this.keyframeIndexPromise && !this.keyframeIndexBuilt) {
          this.buildKeyframeIndex();
        }

        if (!this.disposed) {
          diagLog('[Transmuxer] Phase 2: sequential continuation');
          await this.sequentialContinue(this.lastProcessedTime);
        }
        return;
      }

      // No initInput or non-TS: use seekTo(0) or Conversion
      if (this.config.format === 'ts') {
        diagLog('[Transmuxer] startTransmuxing: TS — no initInput, using seekTo(0)');
        await this.seekTo(0);
        return;
      }

      if (!this.conversion) return;

      this.conversion.onProgress = (_progress: number, processedTime: number) => {
        this.lastProcessedTime = processedTime;

        const now = Date.now();
        if (now - this.lastSpeedThrottle > 250 && this.duration > 0 && this.fileLength > 0) {
          this.lastSpeedThrottle = now;

          const estimatedBytes = Math.floor((processedTime / this.duration) * this.fileLength);

          this.speedHistory.push({ processedTime, wallTime: now });

          while (this.speedHistory.length > 0 && this.speedHistory[0].wallTime < now - 5000) {
            this.speedHistory.shift();
          }

          if (this.speedHistory.length > 1) {
            const first = this.speedHistory[0];
            const last = this.speedHistory[this.speedHistory.length - 1];
            const timeDiffSec = (last.wallTime - first.wallTime) / 1000;
            const bytesDelta = Math.floor(((last.processedTime - first.processedTime) / this.duration) * this.fileLength);
            if (timeDiffSec > 0) {
              this.config.onSpeedUpdate?.(bytesDelta / timeDiffSec);
            }
          }

          this.config.onProgressUpdate?.(processedTime, estimatedBytes);
        }
      };

      await this.conversion.execute();
      console.log('[Transmuxer] Conversion complete');
      this.config.onSpeedUpdate?.(0);
    } catch (e) {
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
  async seekTo(seekTime: number, maxDuration: number = Infinity, options?: { skipInitSegment?: boolean; stopTime?: number }): Promise<number | null> {
    if (this.disposed) return null;

    // Abort any ongoing seek transmux loop
    this.seekAbortFlag = true;

    // Abort the shared stream source's in-flight fetch. A refill's getKeyPacket
    // read (e.g. at ~45MB) may still be awaiting an HTTP range when the user
    // seeks far away (e.g. ~660MB); without this, the stale read keeps its
    // backend download registered and ping-pongs with the new seek's download
    // in the coordinator's zombie-cancel logic (both source_id=None) so neither
    // ever completes and the seek hangs. Aborting frees the slot immediately.
    (this.streamSource as any)?.abortInFlight?.();
    // Fix A1 (round-2): clear the sticky condemnation set by interruptSeek()/a prior entry —
    // THIS seek's reads must pass. Entry is synchronous from here through seekGeneration++,
    // so nothing this seek issues can be condemned. Scope: protects the user-drain supersede
    // path; a user seek superseding an in-flight REFILL self-clears in ~µs (accepted residual,
    // see reports/seek-interrupt-solution.md).
    (this.streamSource as any)?.resetSupersession?.();

    // Increment generation to discard stale callback data
    this.seekGeneration++;
    // Layer-3 starvation watchdog: reset the per-window audio emission counter.
    this.windowAudioPacketsAdded = 0;

    // Cancel current conversion and dispose input
    if (this.conversion) {
      try {
        await this.conversion.cancel();
      } catch (_e) {
        // Conversion may already be canceled — ignore
      }
      this.conversion = null;
    }
    // Dispose input on every seek EXCEPT the MKV persistent-Input path. For MKV
    // the Input wraps the persistent streamSource and mediabunny caches the parsed
    // metadata (SeekHead + Cues) per-Input (readMetadataPromise). Recreating the
    // Input every seek discards that cache and forces a full tail Cues re-parse
    // over the network. Keeping it alive means metadata is parsed ONCE; each seek
    // is then an in-memory cuePoints binary search + one cluster fetch. The
    // Output/Conversion state is cleared separately below, so reusing the Input is
    // safe (tracks bind to the Input; EncodedPacketSink is recreated per seek).
    const reuseMkvInput = this.config.format === 'mkv' && this.input !== null;
    if (this.input && !reuseMkvInput) {
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
    // Fix #1: optional keyframe-boundary stop for abutting refills (see
    // iterateVideoPackets). Infinity when not requested → maxDuration behavior.
    const stopTime = options?.stopTime ?? Infinity;

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

        this.input = new Input({ source: offsetSource, formats, initInput: this.initInputRef ?? undefined });
        console.log(`[Transmuxer] seekTo: using OffsetCustomSource — byteOffset=${byteOffsetKeyframe.byteOffset}, keyframeTs=${byteOffsetKeyframe.timestamp.toFixed(3)}s, seekTime=${seekTime.toFixed(2)}s`);
      } else if (reuseMkvInput && this.input) {
        // MKV persistent-Input reuse: keep the existing Input (and its cached
        // metadata/Cues) instead of recreating it. Metadata parsed once at init.
        console.log(`[Transmuxer] seekTo: reusing persistent MKV Input (cues cached), seekTime=${seekTime.toFixed(2)}s`);
      } else {
        // No byte-offset index (MKV first seek, or TS before scanner completes) —
        // use persistent streamSource with initInput for codec matching.
        this.input = new Input({ source: this.streamSource!, formats, initInput: this.initInputRef ?? undefined });
      }

      const canRead = await this.input.canRead();
      if (!canRead) {
        throw new Error(`Cannot read ${this.config.format} file after seek`);
      }

      // Get tracks
      const videoTrack = await this.input.getPrimaryVideoTrack();
      // Honors the user's audio selection (desiredAudioTrackId); primary otherwise.
      const audioTrack = await this.resolveAudioTrack(this.input);

      if (!videoTrack) {
        throw new Error('No video track found after seek');
      }

      const seekStartTime = performance.now();

      // Find the nearest keyframe at or before seekTime.
      const videoKeyStart = performance.now();
      const videoSink = new EncodedPacketSink(videoTrack);
      let cachedKeyframeTs: number | null = null;
      if (this.config.format === 'mkv') {
        // Cue index FIRST for MKV: it is authoritative (full coverage, exact
        // keyframe times) and — critically — is the SAME index used to compute
        // refill stopTimes (nextKeyframeAtOrAfter). Resolving the seek from it
        // guarantees a refill seeking to the previous refill's stop boundary
        // resolves EXACTLY that keyframe → zero-overlap abut (no coded-frame
        // replacement → no stranded P-frame → no PIPELINE_ERROR_DECODE).
        // The sparse findNearestKeyframe would instead return an EARLIER
        // keyframe within its 12s tolerance (the stop-boundary keyframe isn't in
        // the sparse index — it was never a seek RESULT, only a stopTime), which
        // re-emits an already-buffered GOP and strands a P-frame (observed:
        // seek 114.07 → resolved 105.128, overlap 8.942s → decode crash at 118.9s).
        cachedKeyframeTs = this.nearestCueKeyframeAtOrBefore(seekTime);
      }
      if (cachedKeyframeTs === null) {
        cachedKeyframeTs = this.findNearestKeyframe(seekTime);
      }
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

      // Fix A2 (round-2): post-resolve belt. The walk may resolve AFTER condemnation (warm
      // cache, or the interrupt raced the last fetch). Bail BEFORE any corpse work: arming
      // markSeekResolved here would pair the SUPERSEDING seek's first cluster byte with THIS
      // corpse's keyframe time (corrupt VBR anchor); also skips lastSeekKeyframeTime, harvest,
      // Output creation, audio resolve, and the init-segment emit.
      if (shouldAbandonResolvedSeek(this.seekAbortFlag, this.disposed, currentGeneration, this.seekGeneration)) {
        console.log(`[Transmuxer] Seek abandoned post-resolve (condemned while walking): target=${seekTime.toFixed(2)}s resolved=${keyframeTimestamp.toFixed(3)}s`);
        return null;
      }

      // Arm the source to capture the cluster byte of the upcoming forward fMP4
      // iteration (the read that actually contains this keyframe's data), so the
      // caller can add a REAL (clusterByte, keyframeTimestamp) VBR anchor — not
      // the Cues/SeekHead tail byte getKeyPacket just read to locate it.
      (this.streamSource as any)?.markSeekResolved?.();
      this.lastSeekKeyframeTime = keyframeTimestamp;

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

      const audioMeta = audioTrack
        ? { decoderConfig: (await audioTrack.getDecoderConfig()) as AudioDecoderConfig | undefined }
        : undefined;

      // Find the audio starting point for this window via the Layer-1 fallback
      // chain (getKeyPacket ?? near-start getFirstKeyPacket — see
      // resolveAudioStartPacket). When the chain still returns null (mid-file
      // zero-audio window, or a truly broken track), close the audio source so
      // the Output can produce video-only MEDIA segments — the Output treats
      // closed tracks as "done" (keyFrameQueuedEverywhere returns true for
      // closed tracks). NOTE: a zero-packet closed track is OMITTED from the
      // moov (mediabunny lazy-creates trackDatas on first sample) — a full
      // (non-skipInitSegment) window that skips audio under a 2-codec
      // SourceBuffer mime is a Chromium code-4 fatal. Layer 2 (probe-at-init)
      // prevents that for the init window; Layer 3 reroutes if it ever fires.
      let audioStartPacket: EncodedPacket | null = null;
      let audioSink: EncodedPacketSink | null = null;
      let audioSkipped = false;
      if (audioTrack && audioSource) {
        const audioKeyStart = performance.now();
        audioSink = new EncodedPacketSink(audioTrack);
        audioStartPacket = await this.resolveAudioStartPacket(audioSink, keyframeTimestamp, currentGeneration);
        console.log(`[Transmuxer] seekTo: audio start resolve took ${performance.now() - audioKeyStart}ms, result=${audioStartPacket ? 'found' : 'null (will skip audio)'}`);

        if (!audioStartPacket) {
          audioSource.close();
          audioSink = null;
          audioSkipped = true;
        }
      }

      // Run video and audio iteration concurrently for proper interleaving
      // If audio was skipped, only iterate video (fast — no audio bottleneck)
      const videoPromise = this.iterateVideoPackets(
        videoSink, keyPacket, videoSource, videoMeta, keyframeTimestamp, currentGeneration, maxDuration, verifyKeyPackets, stopTime
      );
      const audioPromise = audioSink && audioSource && audioStartPacket
        ? this.iterateAudioPackets(
            audioSink, audioStartPacket, audioSource, audioMeta, keyframeTimestamp, currentGeneration, maxDuration, stopTime
          )
        : Promise.resolve();

      const iterStartTime = performance.now();
      await Promise.all([videoPromise, audioPromise]);
      console.log(`[Transmuxer] seekTo: iteration took ${performance.now() - iterStartTime}ms (audioSkipped=${audioSkipped})`);

      // Zero-audio window signal (edge-A F5): a 2-track window is "starved"
      // when the output intended audio but ZERO audio packets were emitted —
      // either the start packet was null (audioSkipped) OR the resolved start
      // was already >= stopTime and the loop cut on iteration 1. The refill
      // chain converts consecutive starved windows into a Layer-3 reroute.
      // Generation-gated like finalize below: a superseded seek's write is
      // garbage (its reader bails on the chain-generation check anyway).
      if (currentGeneration === this.seekGeneration) {
        this.lastWindowAudioStarved =
          audioTrack !== null && this.audioCodec !== null && this.windowAudioPacketsAdded === 0;
      }

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
        e.message.includes('read aborted (superseded by seek)') ||
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
    stopTime: number = Infinity,
  ): Promise<void> {
    // Cue-less MKV keyframe harvest (fix A — reports/refill-stall-solution.md):
    // mediabunny's getKeyPacket walk starts at the highest position-cache entry
    // ≤ target and only moves FORWARD (vendored matroska-demuxer.ts:2233-2260;
    // the cache path lacks the cue path's lied-to-us retry), so once a GOP's
    // keyframe cluster falls behind the read frontier, every mid-GOP lookup in
    // the played span returns null — permanently. Harvest every keyframe the
    // pump observes (ORIGINAL pre-clone timestamps) so findNearestKeyframe
    // resolves refills from memory instead of re-searching. Gated: cue-INDEXED
    // files keep a byte-identical index (their seekTo never reaches
    // findNearestKeyframe), and a completed full scan needs no increments.
    const harvest = this.config.format === 'mkv'
      && !this.keyframeIndexBuilt
      && this.mkvCueIndex.length === 0;
    let isFirst = true;
    for await (const packet of videoSink.packets(keyPacket, undefined, { verifyKeyPackets })) {
      if (this.seekAbortFlag || this.disposed || generation !== this.seekGeneration) {
        videoSource.close();
        return;
      }

      if (harvest) {
        if (packet.type === 'key') this.addKeyframeTimestamp(packet.timestamp);
        this.noteIterated(packet.timestamp);
      }

      // Clamp to non-negative: audio key packet timestamp can be slightly
      // before video keyframe (e.g., 1227.8706 vs 1227.883), producing
      // small negative values that IsobmffMuxer.validateTimestamp rejects.
      const adjustedTimestamp = Math.max(0, packet.timestamp - keyframeTimestamp);

      // Fix #1 (abutting refills): when stopTime is set (a real cue keyframe
      // time), stop EXACTLY at that boundary — break before emitting the packet
      // at/after it. stopTime is a keyframe time, so this refill ends on a clean
      // GOP boundary; the next refill seeks forward to this same boundary and
      // abuts with zero overlap (no coded-frame replacement → no decode crash)
      // and zero gap. When stopTime is Infinity (no cue index, e.g. TS), fall
      // back to the original maxDuration cutoff — behavior unchanged.
      if (stopTime !== Infinity) {
        if (packet.timestamp >= stopTime) break;
      } else if (maxDuration !== Infinity && adjustedTimestamp > maxDuration) {
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
   * Resolve the audio packet a transmux window starts from (Layer 1 of the
   * audio-skip fix — reports/mkv-audioskip-solution.md).
   *
   * Chain: getKeyPacket(kf) ?? (near-start ? getFirstKeyPacket() : null).
   *  - getKeyPacket(t) returns the last packet with ts <= t → NULL when the
   *    audio track starts after t (e.g. default track starting at 0.029s with
   *    kf=0 — the Inception repro). All audio packets are typed 'key' on both
   *    MKV and TS, so a getPacket() link would return the identical result
   *    (crossvalidation #8) — omitted.
   *  - getFirstKeyPacket() bypasses cues and scans from segment start — the
   *    library's own fallback idiom (media-sink.ts:526-527). Gated to
   *    near-start windows; a mid-file null is surfaced as a zero-audio window
   *    (Layer 2/3 handle it) instead of an unbounded from-start iteration.
   *  - Generation/disposal checked between links: a superseding seek must not
   *    pay for a fallback scan it will discard (edge-A F6).
   */
  private async resolveAudioStartPacket(
    audioSink: EncodedPacketSink,
    keyframeTimestamp: number,
    generation: number,
  ): Promise<EncodedPacket | null> {
    const direct = await audioSink.getKeyPacket(keyframeTimestamp, { verifyKeyPackets: false });
    if (direct) return direct;
    if (this.disposed || generation !== this.seekGeneration) return null;
    if (keyframeTimestamp > NEAR_START_AUDIO_FALLBACK_S) return null;
    const first = await audioSink.getFirstKeyPacket();
    if (this.disposed || generation !== this.seekGeneration) return null;
    if (first) {
      diagLog(`[Transmuxer] audio start: fallback getFirstKeyPacket → ${first.timestamp.toFixed(3)}s (kf=${keyframeTimestamp.toFixed(3)}s)`);
    }
    return first;
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
    stopTime: number = Infinity,
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

      // Fix #7 (A/V aligned cut): stop audio at the SAME absolute boundary as
      // video (stopTime), not at an independently-computed maxDuration. Cutting
      // the two tracks at different absolute times per refill accumulated A/V
      // desync across refills. When stopTime is Infinity, keep the original
      // maxDuration cutoff — behavior unchanged.
      if (stopTime !== Infinity) {
        if (packet.timestamp >= stopTime) break;
      } else if (maxDuration !== Infinity && adjustedTimestamp > maxDuration) {
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
      // NOTE (reviewer advisory): a superseded window's in-flight add() can
      // complete after a new seekTo reset this counter, leaking ≤1 stale
      // increment into the new window — delays the watchdog by one window at
      // worst, never a false fire (the flag write in seekTo is generation-gated).
      this.windowAudioPacketsAdded++;
    }
  }

  /** True when the LAST seekTo window intended audio but emitted zero audio
   *  packets (zero-audio window — buffered-intersection starvation risk). */
  wasLastWindowAudioStarved(): boolean {
    return this.lastWindowAudioStarved;
  }

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

  // ══════════════ Audio track selection (plan §3, MKV tier) ══════════════

  /** Resolve the audio track honoring the user's selection; falls back to the
   *  primary track when no selection was made or the id no longer resolves. */
  private async resolveAudioTrack(input: NonNullable<typeof this.input>) {
    if (this.desiredAudioTrackId != null) {
      try {
        const all = await input.getAudioTracks();
        const picked = all.find(t => t.id === this.desiredAudioTrackId);
        if (picked) return picked;
        diagLog(`[Transmuxer] desired audio track id=${this.desiredAudioTrackId} not found — falling back to primary`);
      } catch (e: any) {
        diagLog(`[Transmuxer] getAudioTracks failed (${e?.message}) — falling back to primary`);
      }
    }
    return input.getPrimaryAudioTrack();
  }

  /** Enumerate audio tracks with menu metadata. Cheap on the persistent MKV
   *  Input (metadata/Cues already parsed — plan I1; timing logged to verify).
   *  Round-2 note: during the ~120ms condemned window (interrupt → next seekTo) reads here
   *  can throw the superseded error — caught below, degrades to [], self-heals at next seekTo. */
  async getAudioTracks(): Promise<Array<{
    id: number; language: string; name: string | null; codec: string;
    channels: number; isDefault: boolean; codecParameterString: string | null;
  }>> {
    if (!this.input) return [];
    const t0 = performance.now();
    try {
      const tracks = await this.input.getAudioTracks();
      const out = [];
      for (const t of tracks) {
        const [language, name, codec, channels, disposition, cps] = await Promise.all([
          t.getLanguageCode(), t.getName(), t.getCodec(),
          t.getNumberOfChannels(), t.getDisposition(), t.getCodecParameterString(),
        ]);
        out.push({
          id: t.id,
          language: language ?? 'und',
          name,
          codec: (codec as string | null) ?? 'unknown',
          channels: channels ?? 0,
          isDefault: !!disposition?.default,
          codecParameterString: cps,
        });
      }
      diagLog(`[Transmuxer] getAudioTracks: ${out.length} track(s) in ${(performance.now() - t0).toFixed(0)}ms`);
      return out;
    } catch (e: any) {
      diagLog(`[Transmuxer] getAudioTracks failed: ${e?.message}`);
      return [];
    }
  }

  /**
   * Select the audio track for all FUTURE seekTo() runs and re-derive the
   * codec-dependent state (audioCodec, audioTrackInfo, mimeType — a different
   * track may use a different codec, H1). Returns the NEW combined mimeType
   * (caller decides plain rebuild vs changeType vs reroute via planAudioSwitch)
   * or null when the track can't be resolved/derived.
   */
  async setDesiredAudioTrack(trackId: number | null): Promise<string | null> {
    const prev = this.desiredAudioTrackId;
    this.desiredAudioTrackId = trackId;
    if (!this.input) return this.mimeType || null;
    try {
      const audioTrack = await this.resolveAudioTrack(this.input);
      const videoCodecString = this.videoTrackInfo?.codecParameterString ?? null;
      this.audioCodec = audioTrack ? await audioTrack.getCodec() : null;
      const audioCodecString = audioTrack ? await audioTrack.getCodecParameterString() : null;
      this.audioTrackInfo = audioTrack ? {
        codec: this.audioCodec || 'unknown',
        type: 'audio',
        sampleRate: await audioTrack.getSampleRate(),
        channels: await audioTrack.getNumberOfChannels(),
        language: await audioTrack.getLanguageCode(),
        codecParameterString: audioCodecString,
      } : null;
      this.mimeType = this.buildMimeType(videoCodecString, audioCodecString, this.videoCodec, this.audioCodec);
      diagLog(`[Transmuxer] setDesiredAudioTrack(${trackId}): codec=${this.audioCodec}, mime=${this.mimeType}`);
      return this.mimeType || null;
    } catch (e: any) {
      diagLog(`[Transmuxer] setDesiredAudioTrack(${trackId}) failed: ${e?.message} — reverting to previous selection`);
      this.desiredAudioTrackId = prev;
      return null;
    }
  }

  /**
   * Interrupt an in-flight USER seek so a superseding seek can start NOW instead
   * of waiting for this one's full lifecycle (getKeyPacket search + the multi-
   * second transmux iteration) to finish on its own.
   *
   * WHY THIS IS DISTINCT FROM abortSeek():
   *   abortSeek() only sets seekAbortFlag, which stops the packet iteration loop
   *   (checked per-packet at iterateVideoPackets/iterateAudioPackets). That alone
   *   is NOT enough when the seek is blocked EARLIER — inside getKeyPacket, which
   *   awaits a cold cluster HTTP range. seekAbortFlag isn't checked during that
   *   network wait, so the seek would still hang for the full fetch. We ALSO
   *   abort the shared stream source's in-flight fetch so getKeyPacket's await
   *   rejects immediately (surfaces as the expected "read aborted" error, caught
   *   as isAborted in seekTo's handler → returns null cleanly). Two levers,
   *   because the cost lives in two places: network (getKeyPacket) and CPU
   *   (iteration). Named separately from abortSeek() so the thumbnail pipeline's
   *   collect-a-few-frames abort keeps its original network-preserving behavior.
   *
   * Safe to call when no seek is running: seekAbortFlag is reset at the top of
   * the next seekTo (before the new iteration), and abortInFlight() is a no-op
   * when nothing is fetching.
   */
  interruptSeek(): void {
    this.seekAbortFlag = true;
    (this.streamSource as any)?.abortInFlight?.();
  }

  dispose(): void {
    this.disposed = true;
    this.seekAbortFlag = true;
    this.speedHistory = [];
    this.keyframeTimestamps = [];
    this.keyframeIndexBuilt = false;
    this.keyframeIndexPartial = false;
    this.harvestSpanStart = -1;
    this.harvestSpanEnd = -1;
    this.keyframeByteOffsets = [];
    this.tsHeaderData = null;
    this.initInputRef = null;
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
