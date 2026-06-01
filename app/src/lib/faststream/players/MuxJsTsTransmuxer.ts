/**
 * MuxJsTsTransmuxer — Push-based TS→fMP4 transmuxer using mux.js.
 *
 * Replaces mediabunny's sequential-scan approach for TS format.
 * mux.js is push-based: feed Uint8Array chunks → get fMP4 init + media segments.
 * No sequential metadata scan needed — produces output within milliseconds.
 *
 * Architecture:
 * 1. Fetch byte ranges from TauriStreamSource HTTP endpoint
 * 2. Push data into mux.js Transmuxer (push + flush)
 * 3. 'data' event emits fMP4 init segment + media segments
 * 4. Callbacks route segments to MSE SourceBuffer
 * 5. Seeking uses scanTSFile byte-offset index + fresh Transmuxer
 *
 * CRITICAL: keepOriginalTimestamps:true + GOP cache clearing + restored
 * original extendFirstKeyFrame + COMBINED audio/video SourceBuffer.
 *
 * Root cause of quality deformation: true passthrough (return gops) allowed
 * segments starting with P-frames (mid-GOP flushes). Chrome's MSE decoder
 * requires each append to start with a keyframe (sync sample) in "segments"
 * mode. P-frames at segment start cause decoder artifacts (blurry, wrong
 * colors) because Chrome can't properly initialize decode context.
 *
 * The original extendFirstKeyFrame removes incomplete first GOPs (ensuring
 * keyframe alignment) and extends the keyframe's duration to cover removed
 * time. Trade-off: ~0.07-0.33s P-frames dropped per flush (~1-5% data),
 * causing minor stuttering but NO quality deformation.
 * Mitigated by FLUSH_INTERVAL=8 (2MB per flush, fewer mid-GOP flushes).
 *
 * Root cause of audio/video misalignment: mux.js GOP fusion prepends VIDEO
 * GOPs only (never audio). In a combined SourceBuffer, this creates 0.38-
 * 1.87s audio/video offset. GOP cache clearing prevents fusion entirely.
 *
 * Combined SourceBuffer handles HE-AAC codec mismatch: Chrome auto-detects
 * HE-AAC from AudioSpecificConfig (strict codec matching only for separate
 * audio SBs). Audio/video offset (~0.04-0.22s) is natural TS stream offset.
 *
 * With keepOriginalTimestamps:true + GOP cache clearing + original
 * extendFirstKeyFrame + combined SourceBuffer:
 * - Original absolute timestamps → timestampOffset=0 for all operations
 * - No GOP fusion (cache cleared after each flush) → prependedContentDuration=0
 * - Keyframe-aligned segments (original extendFirstKeyFrame) → no artifacts
 * - Minor P-frame drops (~0.07-0.33s per flush) → stuttering, mitigated by FLUSH_INTERVAL=8
 * - Audio/video offset is natural TS stream offset (~0.04-0.22s) — acceptable
 *
 * AVC (H.264) only — mux.js does not support HEVC transmuxing.
 * HEVC TS files fall back to native <video> playback.
 */

import muxjs from 'mux.js';
import { invoke } from '@tauri-apps/api/core';
import { scanTSFile, type TSKeyframeEntry } from '../utils/TSByteOffsetScanner';

function diagLog(msg: string) {
  console.log(msg);
  invoke('cmd_log', { message: msg }).catch(() => {});
}

export interface MuxJsTsConfig {
  url: string;
  fileSize: number;
  firstChunkData: ArrayBuffer;
  onInitSegment: (data: ArrayBuffer) => void;
  onMediaSegment: (data: ArrayBuffer, timestamp: number) => void;
  onDurationKnown: (duration: number) => void;
  onCodecUnsupported: (codec: string) => void;
  onError: (error: Error) => void;
}

const H264_STREAM_TYPE = 0x1B;
const HEVC_STREAM_TYPE = 0x24;

/** Parse PMT from first TS packets to detect video codec (AVC vs HEVC).
 *  Returns the stream_type of the first video stream entry found. */
function detectVideoCodecFromPmt(data: Uint8Array): number | null {
  const PACKET_SIZE = 188;
  let pmtPid: number | null = null;

  for (let offset = 0; offset < data.length - PACKET_SIZE; offset += PACKET_SIZE) {
    if (data[offset] !== 0x47) continue;
    const pid = ((data[offset + 1] & 0x1F) << 8) | data[offset + 2];
    if (pid === 0) {
      const pusi = (data[offset + 1] & 0x40) !== 0;
      let payloadOffset = 4;
      if ((data[offset + 3] & 0x30) > 0x10) {
        payloadOffset += data[offset + 4] + 1;
      }
      if (!pusi || payloadOffset >= offset + PACKET_SIZE) continue;
      const pointer = data[payloadOffset];
      const sectionStart = payloadOffset + 1 + pointer;
      if (sectionStart + 12 >= offset + PACKET_SIZE) continue;
      if (data[sectionStart] !== 0x00) continue;
      const sectionLength = ((data[sectionStart + 1] & 0x0F) << 8) | data[sectionStart + 2];
      const entryEnd = sectionStart + 3 + sectionLength - 4;
      let pos = sectionStart + 8;
      while (pos + 4 <= entryEnd) {
        const progNum = (data[pos] << 8) | data[pos + 1];
        if (progNum !== 0) {
          pmtPid = ((data[pos + 2] & 0x1F) << 8) | data[pos + 3];
          break;
        }
        pos += 4;
      }
      break;
    }
  }

  if (pmtPid === null) return null;

  for (let offset = 0; offset < data.length - PACKET_SIZE; offset += PACKET_SIZE) {
    if (data[offset] !== 0x47) continue;
    const pid = ((data[offset + 1] & 0x1F) << 8) | data[offset + 2];
    if (pid !== pmtPid && pid !== 0x1000) continue;
    const pusi = (data[offset + 1] & 0x40) !== 0;
    let payloadOffset = 4;
    if ((data[offset + 3] & 0x30) > 0x10) {
      payloadOffset += data[offset + 4] + 1;
    }
    if (!pusi || payloadOffset >= offset + PACKET_SIZE) continue;
    const pointer = data[payloadOffset];
    const sectionStart = payloadOffset + 1 + pointer;
    if (sectionStart >= offset + PACKET_SIZE) continue;
    if (data[sectionStart] !== 0x02) continue;
    const sectionLength = ((data[sectionStart + 1] & 0x0F) << 8) | data[sectionStart + 2];
    const programInfoLength = ((data[sectionStart + 10] & 0x0F) << 8) | data[sectionStart + 11];
    const crcEnd = sectionStart + 3 + sectionLength - 4;
    let pos = sectionStart + 12 + programInfoLength;
    while (pos + 5 <= crcEnd) {
      const streamType = data[pos];
      if (streamType === H264_STREAM_TYPE || streamType === HEVC_STREAM_TYPE) {
        return streamType;
      }
      const esInfoLength = ((data[pos + 3] & 0x0F) << 8) | data[pos + 4];
      pos += 5 + esInfoLength;
    }
    break;
  }

  return null;
}

/** Extract only PAT and PMT TS packets from header data.
 *  Used for seek transmuxer initialization — provides stream mapping
 *  (PID → stream type) without including any PES data from byte 0.
 *  PES data from byte 0 would pollute normalized timestamps because
 *  mux.js sets timelineStartInfo from the earliest DTS in pushed data.
 *  With only PAT/PMT (no PES), the timeline start comes from the
 *  seek data's first PES packet (at the keyframe position), ensuring
 *  normalized timestamps start near 0 for correct setTimestampOffset positioning. */
function extractPmtPackets(data: Uint8Array): Uint8Array {
  const PACKET_SIZE = 188;
  const pmtPids = new Set<number>();
  const selectedPackets: Uint8Array[] = [];

  // First pass: find PAT packets and extract PMT PIDs
  for (let offset = 0; offset <= data.length - PACKET_SIZE; offset += PACKET_SIZE) {
    if (data[offset] !== 0x47) continue;
    const pid = ((data[offset + 1] & 0x1F) << 8) | data[offset + 2];
    if (pid === 0) {
      selectedPackets.push(data.slice(offset, offset + PACKET_SIZE));
      // Parse PAT to find PMT PIDs
      const pusi = (data[offset + 1] & 0x40) !== 0;
      let payloadOffset = 4;
      if ((data[offset + 3] & 0x30) > 0x10) {
        payloadOffset += data[offset + 4] + 1;
      }
      if (pusi && payloadOffset < offset + PACKET_SIZE) {
        const pointer = data[payloadOffset];
        const sectionStart = payloadOffset + 1 + pointer;
        if (sectionStart + 12 < offset + PACKET_SIZE && data[sectionStart] === 0x00) {
          const sectionLength = ((data[sectionStart + 1] & 0x0F) << 8) | data[sectionStart + 2];
          const entryEnd = sectionStart + 3 + sectionLength - 4;
          let pos = sectionStart + 8;
          while (pos + 4 <= entryEnd) {
            const progNum = (data[pos] << 8) | data[pos + 1];
            if (progNum !== 0) {
              pmtPids.add(((data[pos + 2] & 0x1F) << 8) | data[pos + 3]);
            }
            pos += 4;
          }
        }
      }
    }
  }

  // Second pass: find PMT packets
  for (let offset = 0; offset <= data.length - PACKET_SIZE; offset += PACKET_SIZE) {
    if (data[offset] !== 0x47) continue;
    const pid = ((data[offset + 1] & 0x1F) << 8) | data[offset + 2];
    if (pmtPids.has(pid)) {
      selectedPackets.push(data.slice(offset, offset + PACKET_SIZE));
    }
  }

  // Combine selected packets
  const totalLength = selectedPackets.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const p of selectedPackets) {
    result.set(p, pos);
    pos += p.length;
  }
  diagLog(`[MuxJsTs] extractPmtPackets: ${selectedPackets.length} packets (${totalLength} bytes) from ${data.byteLength} bytes header data, pmtPids=[${[...pmtPids].join(',')}]`);
  return result;
}

export class MuxJsTsTransmuxer {
  private config: MuxJsTsConfig;
  private disposed = false;
  private transmuxer: any = null;
  private videoCodec: 'avc' | 'hevc' | null = null;
  private mimeType = '';
  private videoMimeType = '';
  private audioMimeType = '';
  private duration = Infinity;
  private fileLength: number;
  private initSegmentBuffer: ArrayBuffer | null = null;
  private lastProcessedTime = 0;

  private keyframeByteOffsets: TSKeyframeEntry[] = [];
  private keyframeTimestamps: number[] = [];
  private keyframeIndexBuilt = false;
  private keyframeIndexPromise: Promise<void> | null = null;
  private tsHeaderData: Uint8Array | null = null;
  private tsPmtData: Uint8Array | null = null; // PAT/PMT only (no PES) for seeks

  private streamingOffset = 0;
  private streamUrl: string;
  private seekGeneration = 0;
  // mux.js emits timing info as separate Transmuxer events, NOT as properties
  // of the 'data' segment. With keepOriginalTimestamps:true, baseMediaDecodeTime
  // is the original absolute DTS (in 90kHz timescale, audio converted to 90kHz
  // via clock.audioTsToVideoTs). The timestamp IS the absolute position.
  // For initial streaming (timestampOffset=0) and seeks (timestampOffset=0),
  // data is positioned at its original absolute position on the timeline.
  private latestVideoSegmentTimingInfo: { start: { dts: number; pts: number }; end: { dts: number; pts: number }; baseMediaDecodeTime: number; prependedContentDuration?: number } | null = null;
  private latestVideoTimingInfo: { start: number; end: number } | null = null;
  private latestAudioSegmentTimingInfo: { start: { dts: number; pts: number }; end: { dts: number; pts: number }; baseMediaDecodeTime: number } | null = null;
  private streamingSegCounter = 0;

  constructor(config: MuxJsTsConfig) {
    this.config = config;
    this.fileLength = config.fileSize;
    this.streamUrl = config.url;
    this.tsHeaderData = new Uint8Array(config.firstChunkData.slice(0, Math.min(65536, config.firstChunkData.byteLength)));
  }

  async init(): Promise<{ mimeType: string; videoMimeType: string; audioMimeType: string; videoCodec: string; videoTrack: any; audioTrack: any; initSegment: ArrayBuffer; firstMediaSegment: ArrayBuffer | null; firstMediaTimestamp: number } | null> {
    if (this.disposed) return null;

    const seedData = new Uint8Array(this.config.firstChunkData);

    const seedHex = Array.from(seedData.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    diagLog(`[MuxJsTs] Seed data: ${seedData.byteLength} bytes, first16=[${seedHex}]`);

    const pmtStreamType = detectVideoCodecFromPmt(seedData);
    diagLog(`[MuxJsTs] PMT stream_type detected: 0x${(pmtStreamType ?? 0).toString(16)}`);

    if (pmtStreamType === HEVC_STREAM_TYPE) {
      diagLog(`[MuxJsTs] HEVC (H.265) detected — not supported by mux.js, falling back to native playback`);
      this.videoCodec = 'hevc';
      this.config.onCodecUnsupported('hevc/aac');
      return null;
    }

    if (pmtStreamType === null) {
      diagLog(`[MuxJsTs] Could not detect video codec from PMT — trying mux.js anyway`);
    }

    this.videoCodec = 'avc';

    diagLog(`[MuxJsTs] muxjs type: ${typeof muxjs}, keys: ${Object.keys(muxjs).join(',')}`);
    diagLog(`[MuxJsTs] muxjs.mp4 type: ${typeof muxjs?.mp4}, keys: ${muxjs?.mp4 ? Object.keys(muxjs.mp4).join(',') : 'undefined'}`);
    diagLog(`[MuxJsTs] muxjs.mp4.Transmuxer type: ${typeof muxjs?.mp4?.Transmuxer}`);

    const TransmuxerClass = muxjs?.mp4?.Transmuxer;
    if (!TransmuxerClass || typeof TransmuxerClass !== 'function') {
      diagLog(`[MuxJsTs] ERROR: muxjs.mp4.Transmuxer is not a constructor! Trying fallback import...`);
      const fallback = (muxjs as any)?.Transmuxer || (muxjs as any)?.default?.mp4?.Transmuxer;
      diagLog(`[MuxJsTs] Fallback Transmuxer type: ${typeof fallback}`);
      if (!fallback) {
        diagLog(`[MuxJsTs] No Transmuxer found — mux.js import is broken`);
        this.config.onCodecUnsupported('unknown/aac');
        return null;
      }
    }

    // CRITICAL: keepOriginalTimestamps:true — original absolute timestamps.
    // Combined with GOP cache clearing and combined SourceBuffer:
    // - timestampOffset=0 for all operations (timestamps already absolute)
    // - No GOP fusion (cache cleared after each flush)
    // - Audio/video in one combined SourceBuffer (Chrome auto-detects HE-AAC)
    // - Natural audio/video offset (~0.04-0.22s) is acceptable in combined mode
    const transmuxer = new (TransmuxerClass || (muxjs as any)?.Transmuxer || (muxjs as any)?.default?.mp4?.Transmuxer)({
      keepOriginalTimestamps: true,
    });
    diagLog(`[MuxJsTs] transmuxer created: keepOriginalTimestamps=true, type=${typeof transmuxer}`);
    this.transmuxer = transmuxer;

    // Timing event listeners — persist from init through streaming.
    // Do NOT remove these (bug #13: removing caused ts=0.000s).
    transmuxer.on('videoTimingInfo', (timingInfo: any) => {
      this.latestVideoTimingInfo = timingInfo;
    });
    transmuxer.on('videoSegmentTimingInfo', (timingInfo: any) => {
      this.latestVideoSegmentTimingInfo = timingInfo;
      const bmdt = timingInfo?.baseMediaDecodeTime ?? 0;
      const prepDur = timingInfo?.prependedContentDuration ?? 0;
      diagLog(`[MuxJsTs] videoSegmentTimingInfo: bmdt=${bmdt} (${(bmdt / 90000).toFixed(3)}s), prependedContentDuration=${prepDur} (${(prepDur / 90000).toFixed(3)}s)`);
    });
    transmuxer.on('processedGopsInfo', (gopsInfo: any[]) => {
      if (gopsInfo.length > 0) {
        diagLog(`[MuxJsTs] processedGopsInfo: ${gopsInfo.length} GOPs, first gop pts=${gopsInfo[0].pts} dts=${gopsInfo[0].dts}`);
      }
    });
    transmuxer.on('audioSegmentTimingInfo', (timingInfo: any) => {
      this.latestAudioSegmentTimingInfo = timingInfo;
      const audioBmdt = timingInfo?.baseMediaDecodeTime ?? 0;
      diagLog(`[MuxJsTs] audioSegmentTimingInfo: audioBmdt=${audioBmdt} (${(audioBmdt / 90000).toFixed(3)}s)`);
      if (this.latestVideoSegmentTimingInfo) {
        const videoBmdt = this.latestVideoSegmentTimingInfo.baseMediaDecodeTime;
        const diff = Math.abs(videoBmdt - audioBmdt);
        diagLog(`[MuxJsTs] audio/video alignment: diff=${(diff / 90000).toFixed(3)}s (natural TS stream offset with keepOriginalTimestamps:true)`);
      }
    });

    let initSegmentReceived = false;
    let initSegmentData: Uint8Array | null = null;
    let firstMediaSegmentData: Uint8Array | null = null;
    let firstTimestamp = 0;

    const initDataHandler = (segment: any) => {
      if (this.disposed) return;
      if (segment.initSegment) {
        initSegmentData = segment.initSegment;
        initSegmentReceived = true;
        diagLog(`[MuxJsTs] Init segment received: ${(initSegmentData as Uint8Array).byteLength} bytes`);
      }
      if (segment.data) {
        if (!firstMediaSegmentData) {
          firstMediaSegmentData = segment.data;
          diagLog(`[MuxJsTs] Init-phase first media: latestVideoSegmentTimingInfo=${JSON.stringify(this.latestVideoSegmentTimingInfo ?? null)}`);
          if (this.latestVideoSegmentTimingInfo) {
            // With keepOriginalTimestamps:true, baseMediaDecodeTime is original
            // absolute DTS. For initial streaming, this ≈ 0 (byte 0 data).
            firstTimestamp = this.latestVideoSegmentTimingInfo.baseMediaDecodeTime / 90000;
            diagLog(`[MuxJsTs] Init-phase firstTimestamp: ${firstTimestamp.toFixed(3)}s (bmdt=${this.latestVideoSegmentTimingInfo.baseMediaDecodeTime})`);
          } else if (this.latestVideoTimingInfo) {
            firstTimestamp = this.latestVideoTimingInfo.start / 90000;
            diagLog(`[MuxJsTs] Init-phase firstTimestamp (fallback): ${firstTimestamp.toFixed(3)}s`);
          }
        }
      }
    };

    transmuxer.on('data', initDataHandler);

    diagLog(`[MuxJsTs] Pushing seed data: ${seedData.byteLength} bytes`);
    transmuxer.push(seedData);
    transmuxer.flush();
    // Clear GOP cache after init-phase flush to prevent GOP fusion.
    // GOP fusion only prepends video GOPs (not audio), creating
    // audio/video offset in a combined SourceBuffer. Clearing
    // avoids redundant data overlap and ensures consistent
    // segment boundaries.
    this.clearGopCache();

    if (!initSegmentReceived) {
      const CHUNK_SIZE = 512 * 1024;
      let offset = seedData.byteLength;
      for (let i = 0; i < 20 && !initSegmentReceived; i++) {
        if (offset >= this.fileLength) break;
        const end = Math.min(offset + CHUNK_SIZE, this.fileLength);
        try {
          const response = await fetch(this.streamUrl, {
            headers: { Range: `bytes=${offset}-${end - 1}` },
          });
          if (!response.ok && response.status !== 206) break;
          const chunk = new Uint8Array(await response.arrayBuffer());
          diagLog(`[MuxJsTs] Init-phase extra chunk: ${chunk.byteLength} bytes, range=${offset}-${end - 1}`);
          transmuxer.push(chunk);
          transmuxer.flush();
          this.clearGopCache();
          offset += chunk.byteLength;
        } catch (e) {
          diagLog(`[MuxJsTs] Fetch chunk failed at offset ${offset}: ${e}`);
          break;
        }
      }
      this.streamingOffset = offset;
    } else {
      this.streamingOffset = seedData.byteLength;
    }

    if (!initSegmentReceived || !initSegmentData) {
      diagLog(`[MuxJsTs] Failed to get init segment — codec not supported or corrupt file`);
      transmuxer.off('data', initDataHandler);
      this.config.onCodecUnsupported('unknown/aac');
      return null;
    }

    const initBuf = initSegmentData!;
    this.initSegmentBuffer = initBuf.buffer.slice(initBuf.byteOffset, initBuf.byteOffset + initBuf.byteLength);

    diagLog(`[MuxJsTs] Init segment ready (${this.initSegmentBuffer!.byteLength} bytes), returning to caller`);
    this.config.onDurationKnown(Infinity);

    // Pre-compute PAT/PMT-only data for seek transmuxer initialization
    if (this.tsHeaderData) {
      this.tsPmtData = extractPmtPackets(this.tsHeaderData);
    }

    let firstMediaSegment: ArrayBuffer | null = null;
    let firstMediaTimestamp = 0;
    if (firstMediaSegmentData) {
      const md = firstMediaSegmentData as Uint8Array;
      firstMediaSegment = md.buffer.slice(md.byteOffset, md.byteOffset + md.byteLength);
      firstMediaTimestamp = firstTimestamp;
      this.lastProcessedTime = firstTimestamp;
    }

    // Parse init segment to extract codec strings
    const tools = muxjs?.mp4?.tools || (muxjs as any)?.default?.mp4?.tools;
    const parsedInit: any[] = tools ? tools.inspect(initBuf) : [];
    let videoCodecString = 'avc1.42E01E';

    // Audio codec: use mux.js's sampleEntry.audioObjectType.
    // NOTE: mux.js returns audioObjectType=2 for both AAC-LC and HE-AAC
    // (ADTS uses implicit SBR signaling). Chrome's combined SourceBuffer
    // auto-detects HE-AAC, so mp4a.40.2 works in combined mode. Separate
    // audio SourceBuffers reject HE-AAC with mp4a.40.2 (strict codec match).
    let audioCodecString = 'mp4a.40.2';

    // Video: extract avc1 profile/level from SPS in init segment's moov box
    for (const box of parsedInit) {
      if (box.type === 'moov' && box.boxes) {
        for (const subBox of box.boxes) {
          if (subBox.type === 'trak' && subBox.boxes) {
            for (const trakSub of subBox.boxes) {
              if (trakSub.type === 'mdia' && trakSub.boxes) {
                for (const mdiaSub of trakSub.boxes) {
                  if (mdiaSub.type === 'stbl' && mdiaSub.boxes) {
                    for (const stblSub of mdiaSub.boxes) {
                      if (stblSub.type === 'stsd' && stblSub.boxes && stblSub.boxes.length > 0) {
                        const sampleEntry = stblSub.boxes[0];
                        if (sampleEntry.type === 'avc1' && sampleEntry.avcData) {
                          videoCodecString = `avc1.${sampleEntry.avcData}`;
                        } else if (sampleEntry.type === 'mp4a' && sampleEntry.audioObjectType) {
                          audioCodecString = `mp4a.40.${sampleEntry.audioObjectType}`;
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    this.mimeType = `video/mp4; codecs="${videoCodecString}, ${audioCodecString}"`;
    this.videoMimeType = `video/mp4; codecs="${videoCodecString}"`;
    this.audioMimeType = `audio/mp4; codecs="${audioCodecString}"`;
    diagLog(`[MuxJsTs] MIME types: combined=${this.mimeType}, video=${this.videoMimeType}, audio=${this.audioMimeType}`);

    // Remove init-phase data handler — streaming uses its own.
    // CRITICAL: Do NOT remove timing listeners — they persist for streaming (bug #13).
    transmuxer.off('data', initDataHandler);
    // Reset stale init-phase timing values so first streaming flush gets fresh data
    this.latestVideoSegmentTimingInfo = null;
    this.latestVideoTimingInfo = null;
    this.latestAudioSegmentTimingInfo = null;
    this.streamingSegCounter = 0;

    this.buildKeyframeIndex();

    diagLog(`[MuxJsTs] init: SUCCESS — AVC TS → fMP4, keepOriginalTimestamps=true, combined SourceBuffer, mimeType=${this.mimeType}`);
    return {
      mimeType: this.mimeType,
      videoMimeType: this.videoMimeType,
      audioMimeType: this.audioMimeType,
      videoCodec: 'avc',
      videoTrack: { codec: 'avc', type: 'video' },
      audioTrack: { codec: 'aac', type: 'audio' },
      initSegment: this.initSegmentBuffer!,
      firstMediaSegment,
      firstMediaTimestamp,
    };
  }

  async startStreaming(): Promise<void> {
    if (this.disposed) return;

    const CHUNK_SIZE = 256 * 1024;
    const FLUSH_INTERVAL = 8;
    let offset = this.streamingOffset;
    const generation = this.seekGeneration;
    let chunkCount = 0;

    diagLog(`[MuxJsTs] startStreaming: from offset ${offset}, fileLength=${this.fileLength}, keepOriginalTimestamps=true`);

    const streamDataHandler = (segment: any) => {
      if (this.disposed || generation !== this.seekGeneration) return;

      if (segment.initSegment) {
        diagLog(`[MuxJsTs] Streaming: skipping redundant init segment`);
      }

      if (segment.data) {
        const dataBytes = segment.data.byteLength;
        const mediaAb = segment.data.buffer.slice(segment.data.byteOffset, segment.data.byteOffset + segment.data.byteLength);
        const segTimingInfo = this.latestVideoSegmentTimingInfo;
        const rawTimingInfo = this.latestVideoTimingInfo;
        // With keepOriginalTimestamps:true: baseMediaDecodeTime is the original
        // absolute DTS (in 90kHz). For initial streaming with timestampOffset=0,
        // this IS the absolute position on the timeline.
        const timestamp = segTimingInfo
          ? segTimingInfo.baseMediaDecodeTime / 90000
          : (rawTimingInfo?.start ?? 0) / 90000;

        const prependedDuration = segTimingInfo?.prependedContentDuration ?? 0;
        this.streamingSegCounter++;
        const segIdx = this.streamingSegCounter;
        if (segIdx <= 10) {
          const audioBmdt = this.latestAudioSegmentTimingInfo?.baseMediaDecodeTime ?? null;
          diagLog(`[MuxJsTs] Streaming seg#${segIdx}: ts=${timestamp.toFixed(3)}s, bmdt=${segTimingInfo?.baseMediaDecodeTime ?? 'null'}, audioBmdt=${audioBmdt}, prependedContentDuration=${prependedDuration} (${(prependedDuration / 90000).toFixed(3)}s)`);
          // With GOP cache clearing, prependedContentDuration should be 0
          // (no GOP fusion). If > 0, cache clearing failed — investigate.
        }

        diagLog(`[MuxJsTs] Streaming: media segment ${dataBytes} bytes, ts=${timestamp.toFixed(3)}s, prepended=${(prependedDuration / 90000).toFixed(3)}s`);
        this.config.onMediaSegment(mediaAb, timestamp);
        this.lastProcessedTime = timestamp;
        // Reset timing info after using it so stale values don't leak across flushes
        this.latestVideoSegmentTimingInfo = null;
        this.latestVideoTimingInfo = null;
        this.latestAudioSegmentTimingInfo = null;
      }
    };

    this.transmuxer.on('data', streamDataHandler);

    while (!this.disposed && generation === this.seekGeneration && offset < this.fileLength) {
      const end = Math.min(offset + CHUNK_SIZE, this.fileLength);

      try {
        const response = await fetch(this.streamUrl, {
          headers: { Range: `bytes=${offset}-${end - 1}` },
        });
        if (!response.ok && response.status !== 206) {
          diagLog(`[MuxJsTs] Streaming fetch failed at offset ${offset}: status ${response.status}`);
          break;
        }
        const chunk = new Uint8Array(await response.arrayBuffer());

        this.transmuxer.push(chunk);
        chunkCount++;
        offset += chunk.byteLength;
        this.streamingOffset = offset;

        // Flush periodically to emit buffered fMP4 segments.
        // Clear GOP cache after each flush to prevent GOP fusion.
        // GOP fusion only prepends video GOPs, creating audio/video
        // offset. Clearing ensures consistent, non-overlapping segments.
        if (chunkCount % FLUSH_INTERVAL === 0) {
          this.transmuxer.flush();
          this.clearGopCache();
        }
      } catch (e) {
        diagLog(`[MuxJsTs] Streaming error at offset ${offset}: ${e}`);
        break;
      }
    }

    // Final flush to emit any remaining buffered data
    if (!this.disposed) {
      try {
        this.transmuxer.flush();
        this.clearGopCache();
      } catch (_) {}
    }

    this.transmuxer.off('data', streamDataHandler);
    diagLog(`[MuxJsTs] Streaming ended at offset ${offset}`);

    // If streaming was interrupted (seek/dispose), throw so the .catch()
    // handler processes it instead of .then() incorrectly calling endOfStream().
    // Without this, .then() calls ms.endOfStream() on seek interruption,
    // transitioning MediaSource to 'ended' state and breaking seek appendBuffer().
    if (this.disposed || generation !== this.seekGeneration) {
      throw new Error('aborted: streaming interrupted by seek/dispose');
    }
  }

  async seekTo(seekTime: number, _maxDuration: number = Infinity, options?: { skipInitSegment?: boolean }): Promise<number | null> {
    if (this.disposed) return null;

    const currentGeneration = ++this.seekGeneration;

    const keyframeTs = this.findNearestKeyframe(seekTime);
    if (keyframeTs === null) {
      diagLog(`[MuxJsTs] seekTo: no keyframe index available`);
      return null;
    }

    const keyframeEntry = this.keyframeByteOffsets.find(e => e.timestamp === keyframeTs);
    if (!keyframeEntry) {
      diagLog(`[MuxJsTs] seekTo: no byte offset for keyframe at ${keyframeTs.toFixed(3)}s`);
      return null;
    }

    diagLog(`[MuxJsTs] seekTo: keyframe at ${keyframeTs.toFixed(3)}s, byteOffset=${keyframeEntry.byteOffset}`);

    const TransmuxerClass = muxjs?.mp4?.Transmuxer || (muxjs as any)?.Transmuxer || (muxjs as any)?.default?.mp4?.Transmuxer;
    // CRITICAL: keepOriginalTimestamps:true for seek transmuxer.
    // Original absolute timestamps → caller uses setTimestampOffset(0)
    // and seekOffsetRef=0 (timestamps are already at absolute positions).
    const seekTransmuxer = new TransmuxerClass({
      keepOriginalTimestamps: true,
    });
    const skipInit = options?.skipInitSegment ?? false;
    const segments: Array<{ init: Uint8Array | null; media: Uint8Array | null; timestamp: number }> = [];

    let seekSegTimingInfo: { start: { dts: number; pts: number }; end: { dts: number; pts: number }; baseMediaDecodeTime: number } | null = null;
    let seekRawTimingInfo: { start: number; end: number } | null = null;
    seekTransmuxer.on('videoTimingInfo', (timingInfo: any) => {
      seekRawTimingInfo = timingInfo;
    });
    seekTransmuxer.on('videoSegmentTimingInfo', (timingInfo: any) => {
      seekSegTimingInfo = timingInfo;
      diagLog(`[MuxJsTs] seek videoSegmentTimingInfo: bmdt=${timingInfo?.baseMediaDecodeTime} (${((timingInfo?.baseMediaDecodeTime ?? 0) / 90000).toFixed(3)}s), prepended=${timingInfo?.prependedContentDuration ?? 0}`);
    });

    seekTransmuxer.on('data', (segment: any) => {
      if (currentGeneration !== this.seekGeneration) return;
      // With keepOriginalTimestamps:true, baseMediaDecodeTime is the
      // original absolute DTS. Timestamp IS the absolute position.
      // Caller uses setTimestampOffset(0) and seekOffsetRef=0.
      const timestamp = seekSegTimingInfo
        ? seekSegTimingInfo.baseMediaDecodeTime / 90000
        : (seekRawTimingInfo?.start ?? 0) / 90000;
      segments.push({
        init: segment.initSegment || null,
        media: segment.data || null,
        timestamp,
      });
      seekSegTimingInfo = null;
      seekRawTimingInfo = null;
    });

    const SEEK_FETCH_SIZE = Math.min(2 * 1024 * 1024, this.fileLength - keyframeEntry.byteOffset);

    try {
      const dataToPush: Uint8Array[] = [];
      // Push PAT/PMT only (not full tsHeaderData) for seek transmuxer.
      // Full tsHeaderData includes PES data from byte 0 with DTS values near 0,
      // which would set the timeline start to byte 0 instead of the keyframe.
      // With only PAT/PMT (no PES), timelineStartInfo comes from the seek data's
      // first PES packet at the keyframe position, so normalized timestamps start near 0.
      if (keyframeEntry.byteOffset > 0 && this.tsPmtData && this.tsPmtData.byteLength > 0) {
        dataToPush.push(this.tsPmtData);
        diagLog(`[MuxJsTs] seek: pushing PAT/PMT only (${this.tsPmtData.byteLength} bytes) for stream mapping`);
      } else if (keyframeEntry.byteOffset > 0 && this.tsHeaderData) {
        // Fallback: if tsPmtData wasn't pre-computed, use full tsHeaderData
        // This may include byte-0 PES data, but it's better than no stream mapping
        dataToPush.push(this.tsHeaderData);
        diagLog(`[MuxJsTs] seek: WARNING — using full tsHeaderData (${this.tsHeaderData.byteLength} bytes) as fallback, may include byte-0 PES data`);
      }

      const end = Math.min(keyframeEntry.byteOffset + SEEK_FETCH_SIZE, this.fileLength);
      const response = await fetch(this.streamUrl, {
        headers: { Range: `bytes=${keyframeEntry.byteOffset}-${end - 1}` },
      });
      if (!response.ok && response.status !== 206) {
        diagLog(`[MuxJsTs] Seek fetch failed: status ${response.status}`);
        return null;
      }
      dataToPush.push(new Uint8Array(await response.arrayBuffer()));

      for (const chunk of dataToPush) {
        if (currentGeneration !== this.seekGeneration) return null;
        seekTransmuxer.push(chunk);
      }
      seekTransmuxer.flush();

      for (const seg of segments) {
        if (currentGeneration !== this.seekGeneration) return null;
        if (seg.init && !skipInit) {
          const initAb = seg.init.buffer.slice(seg.init.byteOffset, seg.init.byteOffset + seg.init.byteLength);
          this.config.onInitSegment(initAb);
          this.initSegmentBuffer = initAb;
        }
        if (seg.media) {
          const mediaAb = seg.media.buffer.slice(seg.media.byteOffset, seg.media.byteOffset + seg.media.byteLength);
          // Return keyframeTs as the seek target — with keepOriginalTimestamps:true,
          // caller uses setTimestampOffset(0) and seekOffsetRef=0
          // (timestamps are already at absolute positions)
          this.config.onMediaSegment(mediaAb, keyframeTs);
          this.lastProcessedTime = keyframeTs;
        }
      }

      this.streamingOffset = end;
      diagLog(`[MuxJsTs] seekTo: completed, keyframeTs=${keyframeTs.toFixed(3)}s, segments=${segments.length}`);
      return keyframeTs;
    } catch (e) {
      if (currentGeneration !== this.seekGeneration) return null;
      diagLog(`[MuxJsTs] seekTo error: ${e}`);
      this.config.onError(e instanceof Error ? e : new Error(String(e)));
      return null;
    }
  }

  private findNearestKeyframe(seekTime: number): number | null {
    if (this.keyframeTimestamps.length === 0) return null;
    let lo = 0;
    let hi = this.keyframeTimestamps.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.keyframeTimestamps[mid] <= seekTime) lo = mid + 1;
      else hi = mid - 1;
    }
    if (hi >= 0) return this.keyframeTimestamps[hi];
    return this.keyframeTimestamps[0];
  }

  async buildKeyframeIndex(): Promise<void> {
    if (this.disposed || this.keyframeIndexPromise) return;
    if (this.videoCodec !== 'avc') return;
    this.keyframeIndexPromise = this._buildKeyframeIndex();
    return this.keyframeIndexPromise;
  }

  private async _buildKeyframeIndex(): Promise<void> {
    try {
      diagLog(`[MuxJsTs] Starting keyframe index scan`);
      const scanResult = await scanTSFile(this.streamUrl, this.fileLength, {});

      if (scanResult && scanResult.keyframes.length > 0) {
        this.keyframeByteOffsets = scanResult.keyframes;
        this.keyframeTimestamps = scanResult.keyframes.map(e => e.timestamp);
        this.keyframeTimestamps.sort((a, b) => a - b);
        this.keyframeIndexBuilt = true;

        if (scanResult.duration > 0 && scanResult.duration < Infinity) {
          this.duration = scanResult.duration;
          this.config.onDurationKnown(this.duration);
        }

        diagLog(`[MuxJsTs] Keyframe index built: ${this.keyframeTimestamps.length} keyframes, duration=${this.duration.toFixed(1)}s`);
      } else {
        diagLog(`[MuxJsTs] Keyframe index scan returned no results`);
      }
    } catch (e) {
      diagLog(`[MuxJsTs] Keyframe index scan error: ${e}`);
    }
  }

  getMseDecision(): string { return this.videoCodec === 'avc' ? 'fmp4' : 'unsupported'; }
  getMimeType(): string { return this.mimeType; }
  getInitSegment(): ArrayBuffer | null { return this.initSegmentBuffer; }
  getLastProcessedTime(): number { return this.lastProcessedTime; }
  getDuration(): number { return this.duration; }
  getFileLength(): number { return this.fileLength; }
  isKeyframeIndexReady(): boolean { return this.keyframeIndexBuilt || this.keyframeTimestamps.length > 0; }
  getKeyframeTimestamps(): number[] { return this.keyframeTimestamps; }
  getKeyframeByteOffsets(): TSKeyframeEntry[] { return this.keyframeByteOffsets; }
  getTsHeaderData(): Uint8Array | null { return this.tsHeaderData; }
  getSourceConfig(): any { return null; }
  abortSeek(): void { this.seekGeneration++; }

  /** Clear mux.js VideoSegmentStream's GOP cache to prevent GOP fusion.
   * GOP fusion prepends cached video GOPs to mid-GOP flushes, but only
   * for video (not audio). With a combined SourceBuffer, this creates
   * audio/video timing misalignment (video GOPs shifted earlier while
   * audio stays at original position). Clearing after each flush ensures:
   * - prependedContentDuration = 0 (no fusion)
   * - Keyframe-aligned segments (original extendFirstKeyFrame handles
   *   incomplete first GOPs by removing them — no quality deformation)
   * - Combined SourceBuffer maintains audio/video alignment */
  private clearGopCache(): void {
    try {
      const pipeline = this.transmuxer?.transmuxPipeline_;
      if (pipeline?.videoSegmentStream) {
        pipeline.videoSegmentStream.gopCache_ = [];
      }
    } catch (_) {
      // GOP cache access failed — non-critical, fusion may occur
    }
  }

  dispose(): void {
    this.disposed = true;
    this.seekGeneration++;
    this.latestVideoSegmentTimingInfo = null;
    this.latestVideoTimingInfo = null;
    this.latestAudioSegmentTimingInfo = null;
    this.streamingSegCounter = 0;
    this.keyframeTimestamps = [];
    this.keyframeByteOffsets = [];
    this.keyframeIndexBuilt = false;
    this.tsHeaderData = null;
    this.tsPmtData = null;
    if (this.transmuxer) {
      try { this.transmuxer.off('data'); this.transmuxer.off('done'); this.transmuxer.off('videoTimingInfo'); this.transmuxer.off('videoSegmentTimingInfo'); } catch (_) {}
      try { this.transmuxer.reset(); } catch (_) {}
      this.transmuxer = null;
    }
  }
}
