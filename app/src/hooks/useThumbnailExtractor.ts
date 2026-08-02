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

const THUMBNAIL_WIDTH = 228;
const THUMBNAIL_HEIGHT = 128;
const BUCKET_SIZE = 2;
const MAX_BUFFER_SIZE = 5000;

// ─── Seek-in-progress suppression ─────────────────────────────────────
// Prevents thumbnail capture from firing during seeks, which causes
// concurrent fMP4 segment downloads that trigger FLOOD_PREMIUM_WAIT and
// 503 errors. The __nobuf_userSeekInProgress flag is set true by
// useMSEPlayer at seek start and cleared on seek completion. If the seek
// completion callback never fires (component unmount, error), the flag
// stays stuck — the 30s safety timeout below treats it as not-in-progress
// so thumbnails resume. We do NOT mutate the global flag (other components
// read it for cache polling suppression).
let _seekFlagFirstSeen: number | null = null;

function isSeekInProgress(): boolean {
  // Check if a seek is actively executing (__nobuf_userSeekInProgress)
  // OR if a seek was recently requested (__nobuf_seekRequestedAt covers
  // the 400ms debounce window before _mpegtsUnbufferedSeek runs).
  const executing = (window as any).__nobuf_userSeekInProgress === true;
  const requestedAt = (window as any).__nobuf_seekRequestedAt || 0;
  const requestedRecently = Date.now() - requestedAt < 30000; // covers debounce + execution + align poll (typically 5-15s)

  if (!executing && !requestedRecently) {
    _seekFlagFirstSeen = null;
    return false;
  }

  // Stuck-flag safety only applies to __nobuf_userSeekInProgress
  // (the debounce timestamp is transient and always cleared within 400ms).
  if (executing) {
    if (_seekFlagFirstSeen === null) {
      _seekFlagFirstSeen = Date.now();
    }
    if (Date.now() - _seekFlagFirstSeen > 30000) {
      _seekFlagFirstSeen = null;
      return false;
    }
    return true;
  }

  // requestedRecently but not executing — suppress thumbnails
  return true;
}

const CAPTURE_DELAY_MS = 2000;
const MIN_HOVER_FETCH_SIZE = 256 * 1024; // 256KB minimum per hover position
const MAX_HOVER_FETCH_SIZE = 5 * 1024 * 1024; // 5MB maximum — covers large keyframe gaps
const THUMBNAIL_NB_SAMPLES = 1; // 1 sample per segment — ensures every sample immediately flushes via onSegment
// Max gap (s) between a hover time and the nearest keyframe in the sparse
// playback-built index before we distrust it and use native getKeyPacket(time)
// instead. The playback index only holds keyframes seen so far (often 2-3 near
// the start), so a far hover must NOT snap to a stale near-start keyframe.
const THUMB_INDEX_MAX_GAP = 12; // one conservative GOP

// Frontend timeout for the backend /fmp4/keyframe-at search. MUST be >= the
// backend's own search deadline (15s, server.rs find_keyframe_at_or_before_time)
// plus a small margin for network/serialisation. Previously this was 5s, which
// GUARANTEED the frontend aborted before the backend could ever return a real
// keyframe — every far hover fell back to the crude linear byte estimate and
// then failed to seek (VBR skew). With the backward-biased window search the
// backend now converges within its deadline, so we wait for the real answer.
// The subsequent segment fetch keeps its own independent 10s timeout, and the
// `busy` flag + hover debounce prevent scrub pile-up, so a slow keyframe search
// can't stack up concurrent requests.
export const KEYFRAME_AT_TIMEOUT_MS = 9000; // backend deadline 8s + 1s margin
// Mirror of the backend search deadline (server.rs find_keyframe_at_or_before_time,
// `search_deadline = Duration::from_secs(8)`). Exported so a unit test can assert
// the frontend timeout stays >= the backend deadline; if the backend value changes,
// the test fails and forces this to be re-synced.
export const BACKEND_KEYFRAME_SEARCH_DEADLINE_MS = 8000;

/** Backend /fmp4/keyframe-at response (subset used for segment routing). */
export interface KeyframeAtResponse { byte_offset?: number | null; fallback?: boolean; }

/**
 * Decide how a hover thumbnail resolves its /segment fetch from a keyframe-at
 * response. Returns `{ mode: 'byte', byteOffset }` when the backend gave a usable
 * position — BOTH the exact keyframe (fallback:false) AND the deadline fallback
 * (fallback:true), whose byte is the linear estimate (time/duration)*size and is
 * the correct ~position for `time`. Returns `{ mode: 'time' }` only when there is
 * no byte at all (fall back to the original time-based URL).
 *
 * Regression guard (log 3-c): the old code used the byte ONLY when !fallback, so a
 * fallback:true response fell through to the time URL → backend's SPARSE
 * Fmp4ByteTimeCache → wrong early-file frame (time=878s captured the 58s frame).
 * Pure + exported so this routing is unit-tested without a live backend.
 */
export function resolveKeyframeSegmentMode(
  kf: KeyframeAtResponse | null | undefined,
): { mode: 'byte'; byteOffset: number } | { mode: 'time' } {
  if (kf && kf.byte_offset != null) return { mode: 'byte', byteOffset: kf.byte_offset };
  return { mode: 'time' };
}

/**
 * Compute the video.currentTime seek target for a thumbnail capture, given the
 * requested `time` and the SourceBuffer's buffered ranges after the segment was
 * appended.
 *
 * Why not just seek to `time` or to `buffered.start(0)`:
 *  - If a buffered range already covers `time`, seek there (accurate frame).
 *  - Otherwise the segment landed at a different position (VBR skew): seek into
 *    the FIRST buffered range. Crucially we nudge `epsilon` seconds PAST
 *    `start(0)` rather than exactly onto it. Seeking to exactly buffered.start(0)
 *    is a known MSE failure mode: the first sample's presentation time can sit a
 *    fraction after the range start, so `currentTime = start(0)` lands just
 *    before any decodable frame, no `seeked` event fires, and the capture times
 *    out (observed deterministically at t=1633.88 in log 15 while a near-identical
 *    hover one range over succeeded). Nudging inside the range guarantees a
 *    decodable sample. `epsilon` is clamped so it never exceeds the range.
 *
 * Returns null when there is no buffered range to seek into (caller bails).
 * Pure + exported so the seek-target logic is unit-tested without a live element.
 */
export function computeThumbnailSeekTarget(
  time: number,
  ranges: { start: number; end: number }[],
  epsilon = 0.1,
): number | null {
  if (ranges.length === 0) return null;
  // Already covered → seek to the requested time (most accurate).
  for (const r of ranges) {
    if (r.start <= time && r.end >= time) return time;
  }
  // Not covered → nudge just inside the first range, but never past its end.
  const first = ranges[0];
  if (first.end <= first.start) return first.start; // degenerate range
  const nudged = first.start + epsilon;
  return Math.min(nudged, (first.start + first.end) / 2);
}

/** Fix B (round-2): MKV thumbnail capture strategy. 'index' = harvested-keyframe hit within
 *  maxGap (timestamp is the FOUND ts[lo], never the hover time) → cheap indexed capture.
 *  Miss/empty: cue-indexed MKV keeps today's 'native' getKeyPacket; cue-less MKV → 'skip'
 *  (native getKeyPacket on a 0-cue file is an unbounded linear cluster walk — observed 103s+,
 *  184MB for ONE hover, busy-locking every later hover; the TS path already skips when it has
 *  no index). Pure + exported for unit testing, like the helpers above. */
export type MkvCaptureDecision =
  | { strategy: 'index'; timestamp: number }
  | { strategy: 'native' }
  | { strategy: 'skip' };

export function decideMkvCaptureStrategy(
  timestamps: number[], time: number, maxGap: number, cueless: boolean,
): MkvCaptureDecision {
  if (timestamps.length > 0) {
    let lo = 0, hi = timestamps.length - 1;
    while (lo < hi) {
      const mid = lo + ((hi - lo + 1) >> 1);
      if (timestamps[mid] <= time) lo = mid; else hi = mid - 1;
    }
    if (timestamps[lo] <= time && time - timestamps[lo] <= maxGap) {
      return { strategy: 'index', timestamp: timestamps[lo] };
    }
  }
  return cueless ? { strategy: 'skip' } : { strategy: 'native' };
}

/** Cue-point count from mediabunny's already-parsed MKV metadata (pure in-memory read — zero
 *  I/O; getPrimaryVideoTrack already ran readMetadata). Reaches vendored internals by the same
 *  convention as MediabunnyTransmuxer.extractMkvCueIndex; null = layout drift. */
export function readMkvCuePointCount(videoTrack: unknown): number | null {
  try {
    const cues = (videoTrack as any)?._backing?.internalTrack?.cuePoints;
    return Array.isArray(cues) ? cues.length : null;
  } catch { return null; }
}

// ─── Round-3 Fix C: cue-less MKV far-hover bisection helpers ─────────────────
// A cue-less MKV forces mediabunny's getKeyPacket into a LINEAR cluster walk
// from its last known position (observed round-2: 184MB/103s for ONE hover).
// The demuxer's own walk-start structure — InternalTrack.clusterPositionCache:
// {elementStartPos, startTimestamp}[] (sorted, sparse-ok, binary-searched by
// performClusterLookup) — is injectable: byte-bisect the file for the cluster
// at-or-before the hover time, insert a synthetic entry, and the walk becomes
// ≤1-2 clusters. Verified against vendored mediabunny 1.45.4
// (reports/research/round3-verify-c-bisect.md). All three helpers are pure /
// guarded reach-ins (readMkvCuePointCount precedent): shape drift ⇒ null/false
// ⇒ callers degrade to the round-2 skip behavior.

const MKV_CLUSTER_ID = 0x1f43b675;
/** EBML IDs legal as Cluster children (vendored demuxer's handled set):
 *  Timestamp, CRC-32, SilentTracks, Position, PrevSize, SimpleBlock, BlockGroup. */
const MKV_CLUSTER_CHILD_IDS = new Set([0xe7, 0xbf, 0x5854, 0xa7, 0xab, 0xa3, 0xa0]);

/** Parse an EBML vint at `pos`: returns value + width, or null. `keepMarker`
 *  keeps the length-descriptor bit (element IDs are stored WITH the marker). */
function readVint(buf: Uint8Array, pos: number, keepMarker: boolean): { value: number; width: number } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (first === 0) return null;
  let width = 1;
  for (let mask = 0x80; !(first & mask); mask >>= 1) width++;
  if (width > 8 || pos + width > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> width);
  for (let i = 1; i < width; i++) value = value * 256 + buf[pos + i];
  return { value, width };
}

/** True when the size vint at `pos` is the EBML unknown-size marker (all
 *  value bits set, any width — e.g. 0xFF, 0x01FF..FF). */
function isUnknownSize(buf: Uint8Array, pos: number): boolean {
  const v = readVint(buf, pos, false);
  if (!v) return false;
  const first = buf[pos];
  const valueBitsFirst = first & (0xff >> v.width);
  if (valueBitsFirst !== (0xff >> v.width)) return false;
  for (let i = 1; i < v.width; i++) if (buf[pos + i] !== 0xff) return false;
  return true;
}

/** Sync-scan a fetched window for a VALIDATED MKV Cluster and read its 0xE7
 *  Timestamp. Validation (verify-c H-C1e): plausible size vint (or unknown-size
 *  marker), child-walk with only legal Cluster-child IDs until 0xE7 (CRC-32 is
 *  commonly first — R11), ticks within [loTicks-slack, hiTicks+slack]. False
 *  positives continue the scan. Returns ABSOLUTE file position of the ID's
 *  first byte (the demuxer parses the header at exactly that byte). */
export function scanForMkvClusterInWindow(
  buf: Uint8Array,
  windowFileOffset: number,
  loTicks: number,
  hiTicks: number,
  slackTicks: number,
): { elementStartPos: number; timestampTicks: number } | null {
  const MAX_DEFINED_SIZE = 256 * 1024 * 1024; // clusters beyond 256MB are implausible
  outer:
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0 !== MKV_CLUSTER_ID) continue;
    const sizePos = i + 4;
    const size = readVint(buf, sizePos, false);
    if (!size) continue;
    if (!isUnknownSize(buf, sizePos) && size.value > MAX_DEFINED_SIZE) continue;
    // Child-walk from data start until we hit Timestamp (0xE7) or run out.
    let p = sizePos + size.width;
    for (let child = 0; child < 8 && p < buf.length; child++) {
      const id = readVint(buf, p, true);
      if (!id || !MKV_CLUSTER_CHILD_IDS.has(id.value)) continue outer;
      const childSize = readVint(buf, p + id.width, false);
      if (!childSize) continue outer;
      const dataPos = p + id.width + childSize.width;
      if (id.value === 0xe7) {
        if (dataPos + childSize.value > buf.length || childSize.value === 0 || childSize.value > 8) continue outer;
        let ticks = 0;
        for (let b = 0; b < childSize.value; b++) ticks = ticks * 256 + buf[dataPos + b];
        if (ticks < loTicks - slackTicks || ticks > hiTicks + slackTicks) continue outer;
        return { elementStartPos: windowFileOffset + i, timestampTicks: ticks };
      }
      p = dataPos + childSize.value; // skip this child (CRC-32 etc.)
    }
  }
  return null;
}

/** timestampFactor (ticks per second) from the segment — guarded reach-in. */
export function readMkvTimestampFactor(videoTrack: unknown): number | null {
  try {
    const f = (videoTrack as any)?._backing?.internalTrack?.segment?.timestampFactor;
    return typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : null;
  } catch { return null; }
}

/** First-cluster byte (bisection lo-bound; skips the header region and pins
 *  segment membership — verify-c residual 7). Guarded reach-in. */
export function readMkvClusterSeekStart(videoTrack: unknown): number | null {
  try {
    const seg = (videoTrack as any)?._backing?.internalTrack?.segment;
    const v = seg?.clusterSeekStartPos ?? seg?.dataStartPos;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  } catch { return null; }
}

/** Insert a synthetic entry into the demuxer's clusterPositionCache — sorted
 *  splice by startTimestamp + neighbor dedup by elementStartPos, mirroring the
 *  vendored organic insert (matroska-demuxer readCluster). false = shape drift
 *  (caller degrades to skip). */
export function injectMkvClusterPosition(
  videoTrack: unknown,
  entry: { elementStartPos: number; startTimestamp: number },
): boolean {
  try {
    const cache = (videoTrack as any)?._backing?.internalTrack?.clusterPositionCache;
    if (!Array.isArray(cache)) return false;
    // binarySearchLessOrEqual by startTimestamp (last index with value <= key).
    let lo = 0, hi = cache.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cache[mid].startTimestamp <= entry.startTimestamp) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx >= 0 && cache[idx].elementStartPos === entry.elementStartPos) return true; // dup
    cache.splice(idx + 1, 0, { elementStartPos: entry.elementStartPos, startTimestamp: entry.startTimestamp });
    return true;
  } catch { return false; }
}

/** R10 consult-before-bisect: an existing cache entry (organic OR injected)
 *  with startTimestamp ∈ [targetTicks - windowTicks, targetTicks] already
 *  bounds getKeyPacket's walk — skip the bisection entirely. */
export function findClusterCacheEntryNear(
  videoTrack: unknown,
  targetTicks: number,
  windowTicks: number,
): { elementStartPos: number; startTimestamp: number } | null {
  try {
    const cache = (videoTrack as any)?._backing?.internalTrack?.clusterPositionCache;
    if (!Array.isArray(cache) || cache.length === 0) return null;
    let lo = 0, hi = cache.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cache[mid].startTimestamp <= targetTicks) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx < 0) return null;
    const e = cache[idx];
    return targetTicks - e.startTimestamp <= windowTicks
      ? { elementStartPos: e.elementStartPos, startTimestamp: e.startTimestamp }
      : null;
  } catch { return null; }
}

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
      if (!this.video || !this.active) {
        resolve(false);
        return;
      }
      if (this.video.readyState >= 1) {
        resolve(true);
        return;
      }
      let done = false;
      const onLoaded = () => {
        if (done) return;
        done = true;
        if (videoRef) videoRef.removeEventListener('loadedmetadata', onLoaded);
        resolve(true);
      };
      if (this.video) {
        this.video.addEventListener('loadedmetadata', onLoaded);
      } else {
        resolve(false);
        return;
      }
      const videoRef = this.video;
      setTimeout(() => {
        if (!done) {
          done = true;
          if (videoRef) videoRef.removeEventListener('loadedmetadata', onLoaded);
          resolve(false);
        }
      }, 10000);
    });

    if (!this.active || !this.video) return false;

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

      // 2. Re-append init segment (teardown-guarded: destroy() nulls sourceBuffer
      //    mid-await when the streaming chain stops during a hover)
      if (this.initSegment) {
        if (!this.active || !this.sourceBuffer) return false;
        this.sourceBuffer.appendBuffer(this.initSegment);
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

      // 9. Check if SourceBuffer covers the desired time (teardown-guarded)
      if (!this.active || !this.sourceBuffer) return false;
      const sbBuffered = this.sourceBuffer.buffered;
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

      // 10. Capture frame (teardown-guarded: destroy() nulls canvas/video)
      if (!this.active || !this.canvas || !this.video) return false;
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
  // Fix B (round-2): cue-less MKV ⇒ native getKeyPacket is an unbounded linear walk — captures
  // become index-or-skip. Detected in init() from mediabunny's already-parsed metadata.
  isCuelessMkv = false;
  private warnedCuelessSkip = false;

  constructor(
    streamUrl: string,
    fileLength: number,
    format: string,
    canvas: HTMLCanvasElement,
    keyframeTimestamps?: number[],
    knownDuration?: number,
  ) {
    this.canvas = canvas;
    this.format = format;
    // Probed/metadata duration from the player. When available, init() uses it
    // instead of mediabunny's computeDuration(), which for a headerless MKV
    // (no Segment duration element) scans every packet to EOF — an 8MB
    // sequential front-march over /stream that pollutes the disk cache and
    // starves the seek prebuffer on the single rate-limited Telegram pipe.
    this.duration = knownDuration && knownDuration > 0 ? knownDuration : 0;
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
      sourceId: 'thumbnail',   // isolates thumbnail reads from the player in the backend coordinator (source_ids_match) so they don't cross-cancel
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

      // Get duration. Skip computeDuration() when the player already probed it
      // — for headerless MKV that call scans to EOF (8MB front-march) and hangs
      // init before "Ready", starving the seek prebuffer.
      if (this.duration <= 0) {
        this.duration = await this.input.computeDuration();
      }

      // Get video track
      this.videoTrack = await this.input.getPrimaryVideoTrack();
      if (!this.videoTrack || !this.active) {
        if (this.input) { this.input.dispose(); this.input = null; }
        this._initInProgress = false;
        if (!this.active) console.log('[TransmuxerThumbnailPipeline] Init cancelled during getVideoTrack');
        else console.warn('[TransmuxerThumbnailPipeline] No video track');
        return false;
      }

      // Fix B (round-2): cue-lessness from already-parsed metadata (zero I/O). null (vendored
      // layout drift) ⇒ treated cue-less: extractMkvCueIndex degrades to [] the same way, so
      // playback is ALSO cue-less on drift; a skipped thumbnail beats a 103s busy-locked walk.
      // Cold branch on pinned mediabunny 1.45.4 (shape proven in prod by the transmuxer).
      if (this.format === 'mkv') {
        const cueCount = readMkvCuePointCount(this.videoTrack);
        this.isCuelessMkv = (cueCount ?? 0) === 0;
        if (this.isCuelessMkv) console.warn('[TransmuxerThumbnailPipeline] MKV has no Cues — native-scan captures disabled (index-or-skip)');
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

      // Check if the codec is supported by VideoDecoder. Expected to fail for
      // 10-bit HEVC (e.g. hev1.2.4.H120.90) on Chromium/WebView2 — WebCodecs has
      // no software fallback for it. This is NOT an error: scrub-preview
      // thumbnails are simply disabled for this file (the hover handler in
      // FastStreamPlayer degrades to a time-only tooltip). Playback is unaffected —
      // HEVC plays via the /remux → mpegts.js path. Log at info level so it does
      // not surface as a broken-pipeline warning.
      const support = await VideoDecoder.isConfigSupported(this.decoderConfig);
      if (!support.supported) {
        console.info('[TransmuxerThumbnailPipeline] Codec not supported by VideoDecoder (expected for 10-bit HEVC); scrub thumbnails disabled for this file:', this.decoderConfig.codec);
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

    // Fix B (round-2): pick the MKV strategy BEFORE locking busy — a cue-less 'skip' must never
    // block later hovers (the 103s walk also busy-locked every subsequent capture). This region
    // is await-free, so two hovers cannot interleave between decision and busy=true.
    const mkvDecision = decideMkvCaptureStrategy(
      this.keyframeTimestamps, time, THUMB_INDEX_MAX_GAP, this.isCuelessMkv,
    );
    if (mkvDecision.strategy === 'skip') {
      if (!this.warnedCuelessSkip) {
        this.warnedCuelessSkip = true;
        console.warn(`[TransmuxerThumbnailPipeline] Cue-less MKV: hover ${time.toFixed(1)}s outside harvested index — capture skipped (tooltip degrades to time-only; TS-precedent)`);
      }
      return false;
    }

    this.busy = true;

    try {
      // 1. Find nearest keyframe — strategy decided above (fix B).
      let keyPacket: EncodedPacket | null;

      if (mkvDecision.strategy === 'index') {
        // Harvested-index hit — known keyframe timestamp, verifyKeyPackets:false (the index
        // only ever holds confirmed keyframes). Cold-Input cost is bounded by this timestamp's
        // cluster byte with a hard in-demuxer stop, warms after the first capture, and is
        // typically disk-speed (on cue-less files playback already walked ≤ this byte).
        keyPacket = await this.videoSink!.getKeyPacket(mkvDecision.timestamp, { verifyKeyPackets: false });
      } else {
        // 'native' — cue-indexed MKV: the sparse playback-built index misses this hover (or is
        // empty pre-harvest); mediabunny's full Cues find the real keyframe at `time`. This
        // tier is byte-identical to pre-fix behavior. Cue-less never reaches here ('skip').
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
      if (!this.video || !this.active) {
        resolve(false);
        return;
      }
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
        if (!this.active || !this.sourceBuffer) return false;
        this.sourceBuffer.appendBuffer(this.initSegment);
        await this._waitForUpdateEnd();
      }

      // 3. Fetch keyframe byte offset from backend for precise seeking.
      //    Timeout: KEYFRAME_AT_TIMEOUT_MS (>= backend 15s deadline) — the backend
      //    now converges within its deadline (backward-biased window search), so
      //    we wait for the real keyframe instead of preempting it with a crude
      //    linear byte estimate that then fails to seek on VBR content.
      let segUrl = `${this.fmp4BaseUrl}/segment/${this.folderId}/${this.messageId}?${this.queryParams}&time=${time.toFixed(3)}&duration=0.5`;
      try {
        const kfUrl = `${this.fmp4BaseUrl}/keyframe-at/${this.folderId}/${this.messageId}?${this.queryParams}&time=${time.toFixed(3)}&duration=${this.duration.toFixed(3)}`;
        const kfController = new AbortController();
        const kfTimeoutId = setTimeout(() => kfController.abort(), KEYFRAME_AT_TIMEOUT_MS);
        const kfResp = await fetch(kfUrl, { signal: kfController.signal });
        clearTimeout(kfTimeoutId);
        if (kfResp.ok) {
          const kfData = await kfResp.json();
          // Route via the pure, unit-tested resolver (resolveKeyframeSegmentMode).
          // BOTH exact keyframe and deadline fallback carry a usable byte_offset;
          // only a byte-less response falls back to the original time URL.
          const seg = resolveKeyframeSegmentMode(kfData);
          if (seg.mode === 'byte') {
            segUrl = `${this.fmp4BaseUrl}/segment/${this.folderId}/${this.messageId}?${this.queryParams}&byte_offset=${seg.byteOffset}&duration=0.5&align=keyframe`;
            console.log(`[Fmp4ThumbnailPipeline] Using ${kfData.fallback ? 'fallback (linear)' : 'keyframe-at'} byte_offset=${seg.byteOffset} for time=${time.toFixed(2)}s`);
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

      // 6. Append segment to SourceBuffer.
      //    Guard against a teardown race: destroy() (fired when the streaming
      //    chain stops mid-hover) sets active=false and nulls sourceBuffer while
      //    this async method is parked on an await above. Dereferencing
      //    this.sourceBuffer! then throws "Cannot read properties of null
      //    (reading 'appendBuffer')". Bail cleanly instead.
      await this._waitForUpdateEnd();
      if (!this.active || !this.sourceBuffer) return false;
      this.sourceBuffer.appendBuffer(segData);
      await this._waitForUpdateEnd();

      // 5. Compute the seek target from the buffered ranges. Seeking to exactly
      //    buffered.start(0) is a known MSE failure mode (first sample's PTS can
      //    sit a fraction after the range start → no decodable frame at start →
      //    no 'seeked' event → 5s timeout). computeThumbnailSeekTarget nudges
      //    just inside the first range when `time` isn't covered.
      if (!this.active || !this.sourceBuffer) return false;
      const sbBuffered = this.sourceBuffer.buffered;
      const ranges: { start: number; end: number }[] = [];
      for (let i = 0; i < sbBuffered.length; i++) {
        ranges.push({ start: sbBuffered.start(i), end: sbBuffered.end(i) });
      }
      // Diagnostic: exact buffered ranges so a failing capture is provable from
      // the log (range count + first-range width discriminate the seek-fail case).
      console.log('[Fmp4ThumbnailPipeline] buffered ranges for time=' + time.toFixed(2)
        + ': ' + (ranges.length === 0 ? 'EMPTY'
          : ranges.map(r => `[${r.start.toFixed(2)}-${r.end.toFixed(2)}]`).join(',')));

      const seekTarget = computeThumbnailSeekTarget(time, ranges) ?? time;
      if (seekTarget !== time) {
        console.log('[Fmp4ThumbnailPipeline] Target time not in buffer, seeking to ' + seekTarget.toFixed(2));
      }

      // 6. Seek video to target time. If the seek fails AND we were aiming at a
      //    (nudged) range start, retry once at the range midpoint — a wider offset
      //    that is always decodable — before giving up.
      let seeked = await this._seekVideo(seekTarget);
      if (!seeked && ranges.length > 0) {
        const mid = (ranges[0].start + ranges[0].end) / 2;
        if (Math.abs(mid - seekTarget) > 0.01) {
          console.warn('[Fmp4ThumbnailPipeline] Seek to ' + seekTarget.toFixed(2)
            + ' failed — retrying at range midpoint ' + mid.toFixed(2));
          seeked = await this._seekVideo(mid);
          if (seeked) {
            await this._waitForFrameRender(mid);
            if (!this.active || !this.canvas || !this.video) return false;
            const c = this.canvas;
            const cx = c.getContext('2d')!;
            cx.drawImage(this.video, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
            const midUrl = c.toDataURL('image/jpeg', 0.6);
            frameBuffer.set(bucket, midUrl);
            insertionOrder.push(bucket);
            while (frameBuffer.size > MAX_BUFFER_SIZE && insertionOrder.length > 0) {
              const oldest = insertionOrder.shift()!;
              frameBuffer.delete(oldest);
            }
            forceUpdateCachedTimes();
            console.log('[Fmp4ThumbnailPipeline] Captured thumbnail at ' + time.toFixed(2) + 's (midpoint retry, seekTarget=' + mid.toFixed(2) + ')');
            return true;
          }
        }
      }
      if (!seeked) {
        console.warn('[Fmp4ThumbnailPipeline] Video seek failed for time:', seekTarget.toFixed(2));
        return false;
      }

      // 7. Wait for frame render
      await this._waitForFrameRender(seekTarget);

      // 8. Capture frame. Guard again: teardown during the seek/render awaits
      //    nulls this.canvas/this.video (destroy() sets them to null as any).
      if (!this.active || !this.canvas || !this.video) return false;
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
  // MP4-HEVC→/remux reroute: hover thumbnails via backend /thumb (server-side
  // ffmpeg single-frame JPEG). No client pipeline — just a serialized fetch.
  const remuxThumbBusyRef = useRef(false);
  

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
  // Uses ref for mseGetters to prevent infinite init→destroy→init loop
  // (mseGetters gets a new object reference on every parent render).
  const mseGettersRefForMSE = useRef(mseGetters);
  mseGettersRefForMSE.current = mseGetters;
  const pipelineInitializedRef = useRef(false);
  useEffect(() => {
    if (useNative || !streamUrl || !thumbnailDataReady || !moovBufferReady) return;
    // Hard guard: only initialize once per video. Prevents infinite init→destroy→init loop.
    if (pipelineInitializedRef.current || pipelineRef.current) return;
    pipelineInitializedRef.current = true;
    const mseGetters = mseGettersRefForMSE.current;
    if (!mseGetters) return;

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
      pipelineInitializedRef.current = false;
      if (pipelineRef.current) {
        pipelineRef.current.destroy();
        pipelineRef.current = null;
      }
    };
  }, [useNative, streamUrl, thumbnailDataReady, moovBufferReady]); // mseGetters excluded — uses ref to prevent infinite re-init loop

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
      getters.getKnownDuration?.() ?? 0, // Probed duration — skips EOF-scanning computeDuration() for headerless MKV
    );

    transmuxerPipelineRef.current = pipeline;

    pipeline.init().then((success) => {
      if (cancelled) return;
      if (success && pipeline.active) {
        console.log('[ThumbnailExtractor] Transmuxer thumbnail pipeline initialized successfully');
        setReady(true); readyRef.current = true;
      } else {
        // Not necessarily an error: for 10-bit HEVC (WebCodecs-unsupported) init
        // returns false by design. Scrub-preview thumbnails are disabled for this
        // file; the hover handler degrades to a time-only tooltip and playback is
        // unaffected. Log at info level so it does not look like a broken pipeline.
        console.info('[ThumbnailExtractor] Transmuxer thumbnail pipeline unavailable (scrub thumbnails disabled for this file; playback unaffected)');
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
      // Byte-offsets are only consumed by the TS OffsetCustomSource capture path.
      // MKV/MP4 capture via mediabunny getKeyPacket + the timestamp binary search
      // (cluster-based, already fast), so empty byte-offsets here is expected, not
      // a missing index. Log timestamps only to avoid implying something's absent.
      console.log(`[ThumbnailExtractor] Updated keyframe timestamps: ${timestamps.length} available (timestamp-based capture; byte-offsets N/A for non-TS)`);
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
      // THUMBNAIL DURATION CORRECTION. The thumbnail pipelines are constructed at
      // MEDIA_INFO time with the 4Mbps ESTIMATE duration (real PTS duration isn't
      // known yet). When the real duration later arrives it fires `durationchange`
      // on the main video — push it into the live pipeline(s) so hover byte offsets
      // (time/duration*fileSize) and the /keyframe-at duration= param are computed
      // against the TRUE duration. Without this the preview shows a frame 170-280s
      // off the hover point on VBR (proven logs 12-c). Guard on a finite, positive,
      // meaningfully-different value so we never clobber a good duration with NaN/0.
      const d = video.duration;
      if (Number.isFinite(d) && d > 0) {
        const fp = fmp4PipelineRef.current;
        if (fp && Math.abs(fp.duration - d) > 0.5) fp.duration = d;
        const tp = transmuxerPipelineRef.current;
        if (tp && Math.abs(tp.duration - d) > 0.5) tp.duration = d;
      }
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

          // Suppress thumbnail capture during seeks — prevents concurrent
          // fMP4 segment downloads that trigger FLOOD_PREMIUM_WAIT and 503
          // errors. The 30s stuck-flag safety in isSeekInProgress() ensures
          // thumbnails resume even if the seek completion callback never fires.
          if (isSeekInProgress()) {
            await new Promise(r => setTimeout(r, 500));
            continue;
          }

          // MP4-HEVC→/remux reroute: server-side /thumb JPEG fetch. Placed
          // FIRST — when this config is set no client pipeline exists for the
          // file (WebView2 can't decode HEVC), so it's the only capture path.
          const remuxThumbCfg = getters?.getRemuxThumbConfig?.() ?? null;
          if (remuxThumbCfg) {
            if (remuxThumbBusyRef.current) {
              await new Promise(r => setTimeout(r, 150));
              continue;
            }
            remuxThumbBusyRef.current = true;
            try {
              const { baseUrl, folderId, messageId, token, duration } = remuxThumbCfg;
              const url = `${baseUrl}/thumb/${folderId}/${messageId}?token=${encodeURIComponent(token)}&time=${bucket}` +
                (duration > 0 ? `&duration=${duration}` : '');
              const resp = await fetch(url);
              if (resp.ok) {
                const blob = await resp.blob();
                const dataUrl = await new Promise<string>((resolve, reject) => {
                  const fr = new FileReader();
                  fr.onload = () => resolve(fr.result as string);
                  fr.onerror = () => reject(fr.error);
                  fr.readAsDataURL(blob);
                });
                // Stale guard: if the effect tore down mid-fetch (video
                // switched / unmounted), drop the frame instead of writing a
                // previous video's thumbnail into the fresh frame buffer.
                // (Native path has the same `active` check before capture.)
                if (active) {
                  frameBufferRef.current.set(bucket, dataUrl);
                  insertionOrderRef.current.push(bucket);
                  evictIfNeeded();
                  forceUpdateCachedTimes();
                }
              } else if (resp.status === 429) {
                // Another hover's ffmpeg is running server-side — retry soon.
                await new Promise(r => setTimeout(r, 400));
              } else {
                console.warn(`[ThumbnailExtractor] /thumb HTTP ${resp.status} for t=${bucket}`);
                await new Promise(r => setTimeout(r, 1000));
              }
            } catch (e) {
              console.warn('[ThumbnailExtractor] /thumb fetch failed:', e);
              await new Promise(r => setTimeout(r, 1000));
            } finally {
              remuxThumbBusyRef.current = false;
            }
          } else if (fmp4Pipeline && fmp4Pipeline.ready && !fmp4Pipeline.busy) {
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
