/**
 * TSByteOffsetScanner — Fast keyframe index builder for MPEG-TS files.
 *
 * Reads the file in chunks via direct HTTP range requests and parses
 * 188-byte TS packet headers to find video keyframes with PTS timestamps.
 * Builds a {timestamp, byteOffset} index that enables instant keyframe
 * lookup, replacing mediabunny's slow getKeyPacket linear scan (8-12s).
 *
 * Also extracts the video PID from PAT/PMT tables and caches the first
 * ~64 KiB of the file (containing PAT/PMT) for use in offset-based
 * seeking via OffsetCustomSource.
 */

import { CustomSource } from 'mediabunny';

export interface TSKeyframeEntry {
  timestamp: number; // PTS / 90000, in seconds
  byteOffset: number; // Byte position in the original file
}

export interface TSScanResult {
  keyframes: TSKeyframeEntry[];
  videoPid: number;
  headerData: Uint8Array; // First HEADER_CACHE_SIZE bytes (contains PAT/PMT)
  duration: number; // Last PTS timestamp (approximate duration)
}

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const INITIAL_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MiB for first chunk (find PAT/PMT reliably)
const BULK_CHUNK_SIZE = 16 * 1024 * 1024; // 16 MiB for bulk scan (fewer HTTP requests = faster)
const PARALLEL_CHUNKS = 1; // Sequential scanning — avoids coordinator contention with prefetch + computeDuration
const HEADER_CACHE_SIZE = 64 * 1024; // 64 KiB — enough for PAT/PMT + initial data

// PTS clock frequency: 90 kHz
const PTS_CLOCK_RATE = 90000;

/**
 * Scan a TS file via HTTP range requests and build a keyframe byte-offset index.
 * This runs independently of mediabunny — no Input, no ReadOrchestrator, no
 * backend coordinator contention. Uses direct fetch() calls with Range headers.
 *
 * For a 2 GiB file with 4 MiB chunks: ~500 HTTP requests, ~2-5s total scan time
 * (assuming backend responds quickly for cached data).
 */
export async function scanTSFile(
  url: string,
  fileSize: number,
  headers: Record<string, string> = {},
  abortSignal?: AbortSignal,
): Promise<TSScanResult> {
  // Append cached_only=true to prevent the /stream/ endpoint from spawning
  // targeted downloads for uncached chunks. When cached_only is set, the
  // backend returns 503 for any range not already on disk — no coordinator
  // subscription, no targeted sequential download. The scanner skips those
  // chunks and builds a partial keyframe index from cached data only.
  const separator = url.includes('?') ? '&' : '?';
  const scanUrl = `${url}${separator}cached_only=true`;
  const allHeaders = { ...headers };
  const keyframes: TSKeyframeEntry[] = [];
  let videoPid: number | null = null;
  let videoStreamType: number | null = null;
  let pmtPid: number | null = null;
  let lastPts: number = 0;
  let headerData: Uint8Array = new Uint8Array(0);
  let skippedChunks = 0;

  // Calculate chunk layout:
  // Chunk 0: 0 → INITIAL_CHUNK_SIZE-1 (1 MiB — find PAT/PMT quickly)
  // Chunk 1..N: INITIAL_CHUNK_SIZE → ... (8 MiB each — bulk scan)
  const bulkChunks = fileSize > INITIAL_CHUNK_SIZE
    ? Math.ceil((fileSize - INITIAL_CHUNK_SIZE) / BULK_CHUNK_SIZE)
    : 0;
  const totalChunks = 1 + bulkChunks;
  console.log(`[TSScanner] Starting scan: fileSize=${(fileSize / 1024 / 1024).toFixed(1)}MiB, initial=1, bulk=${bulkChunks}, total=${totalChunks}`);

  // Helper: calculate file offset for a chunk index
  const getChunkRange = (chunkIdx: number): [number, number, number] => {
    if (chunkIdx === 0) {
      const size = INITIAL_CHUNK_SIZE;
      return [0, 0, Math.min(size - 1, fileSize - 1)];
    }
    const offset = INITIAL_CHUNK_SIZE + (chunkIdx - 1) * BULK_CHUNK_SIZE;
    const size = BULK_CHUNK_SIZE;
    return [offset, offset, Math.min(offset + size - 1, fileSize - 1)];
  };

  // Helper: fetch a chunk via /stream/?cached_only=true
  // With cached_only, 503 means "this range isn't cached yet" — skip it
  // instead of retrying (no targeted download will fill it for us).
  // Returns null for uncached/failed chunks so the scanner can skip them.
  const fetchChunk = async (chunkIdx: number): Promise<{ data: Uint8Array; chunkStart: number } | null> => {
    const [_fileOffset, chunkStart, chunkEnd] = getChunkRange(chunkIdx);

    if (abortSignal?.aborted) return null;

    const response = await fetch(scanUrl, {
      headers: {
        ...allHeaders,
        Range: `bytes=${chunkStart}-${chunkEnd}`,
      },
      signal: abortSignal ?? undefined,
    });

    if (response.ok || response.status === 206) {
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length === 0) return null;
      return { data, chunkStart };
    }

    // 503 from cached_only means "range not cached" — skip it, don't retry
    if (response.status === 503) {
      const reason = response.headers.get('X-Reason') || '';
      if (reason === 'cached-only-miss') {
        // This range isn't on disk yet — skip it silently
        skippedChunks++;
        return null;
      }
      // Other 503 reasons (download-busy) — also skip since we don't
      // want to wait for or trigger targeted downloads
      console.warn(`[TSScanner] HTTP 503 (${reason}) for chunk ${chunkIdx}, skipping`);
      skippedChunks++;
      return null;
    }

    console.warn(`[TSScanner] HTTP ${response.status} for chunk ${chunkIdx} (${chunkStart}-${chunkEnd}), skipping`);
    return null;
  };

  // Helper: parse TS packets in a chunk, adding keyframes to the index
  const parseChunk = (data: Uint8Array, chunkStart: number): void => {
    let offset = findSyncByte(data, 0);
    if (offset === -1) return;

    if (!verifySyncAlignment(data, offset)) {
      for (let tryOffset = offset + 1; tryOffset < Math.min(offset + TS_PACKET_SIZE, data.length); tryOffset++) {
        if (verifySyncAlignment(data, tryOffset)) {
          offset = tryOffset;
          break;
        }
      }
    }

    while (offset + TS_PACKET_SIZE <= data.length) {
      if (data[offset] !== TS_SYNC_BYTE) break;

      const packet = data.subarray(offset, offset + TS_PACKET_SIZE);
      const pid = ((packet[1] & 0x1F) << 8) | packet[2];
      const afc = (packet[3] >> 4) & 0x03;

      // Parse PAT (PID 0) to find PMT PID
      if (pid === 0x0000 && pmtPid === null) {
        const parsed = parsePAT(packet, afc);
        if (parsed !== null) {
          pmtPid = parsed;
          console.log(`[TSScanner] Found PAT: PMT PID = 0x${pmtPid.toString(16)}`);
        }
      }

      // Parse PMT to find video PID and stream type
      if (pmtPid !== null && videoPid === null && pid === pmtPid) {
        const vPidInfo = parsePMT(packet, afc);
        if (vPidInfo !== null) {
          videoPid = vPidInfo.pid;
          videoStreamType = vPidInfo.streamType;
          console.log(`[TSScanner] Found PMT: Video PID = 0x${vPidInfo.pid.toString(16)}, streamType = 0x${vPidInfo.streamType.toString(16)}`);
        }
      }

      // Check if this is a video keyframe packet
      if (videoPid !== null && videoPid > 0 && pid === videoPid) {
        const pusi = (packet[1] >> 6) & 1;

        // Only check packets with payload (AFC=1 or AFC=3).
        // AFC=2 (adaptation field only) is padding — no keyframe data.
        if (pusi === 1 && (afc === 0x01 || afc === 0x03)) {
          let isKeyframe = false;

          // Method 1: RAI (Random Access Indicator) bit in adaptation field.
          // Standard MPEG-TS keyframe marker, but many encoders omit it.
          if (afc === 0x03) {
            const afLength = packet[4];
            if (afLength > 0) {
              const rai = (packet[5] >> 6) & 1;
              if (rai === 1) {
                isKeyframe = true;
              }
            }
          }

          // Method 2: H.264/HEVC NAL type detection in PES payload (fallback).
          // Checks for IDR/SPS/PPS (H.264) or IRAP (HEVC) NAL units.
          // Critical fallback for streams where the encoder doesn't set RAI.
          // Also handles AFC=1 (payload only) packets where there's no
          // adaptation field to check for RAI.
          if (!isKeyframe && videoStreamType !== null) {
            const isH264 = videoStreamType === 0x1B || videoStreamType === 0x01 || videoStreamType === 0x10;
            const isHEVC = videoStreamType === 0x24;
            if (isH264) {
              isKeyframe = detectH264KeyframeInPES(packet, afc);
            } else if (isHEVC) {
              isKeyframe = detectHEVCKeyframeInPES(packet, afc);
            }
          }

          if (isKeyframe) {
            // Extract PTS timestamp
            const afLength = afc === 0x03 ? packet[4] : 0; // afLength ignored for AFC=1
            const pts = extractPTS(packet, afc, afLength);
            if (pts !== null) {
              const timestamp = pts / PTS_CLOCK_RATE;
              const byteOffset = chunkStart + offset;

              if (keyframes.length === 0 || Math.abs(timestamp - keyframes[keyframes.length - 1].timestamp) > 0.01) {
                keyframes.push({ timestamp, byteOffset });
              }
              lastPts = pts;
            }
          }
        }
      }

      offset += TS_PACKET_SIZE;
    }
  };

  // ======== Phase 1: Fetch and parse the first chunk sequentially (find PAT/PMT) ========
  // The first chunk (0-2MiB) contains PAT/PMT tables — without them we can't
  // identify the video PID. If it's not cached yet (cached_only returned 503),
  // we can't proceed at all. Bail out and let the caller retry later.
  if (abortSignal?.aborted) {
    return { keyframes: [], videoPid: 0, headerData: new Uint8Array(0), duration: 0 };
  }

  const firstChunk = await fetchChunk(0);
  if (!firstChunk) {
    // First chunk not cached yet — can't find PAT/PMT, can't proceed.
    // Return empty result; caller should retry later when data is cached.
    console.warn('[TSScanner] First chunk not cached (cached_only=503) — aborting scan, will retry later');
    return { keyframes: [], videoPid: 0, headerData: new Uint8Array(0), duration: 0 };
  }

  // Cache header data from the first chunk (contains PAT/PMT)
  const data = firstChunk.data;
  headerData = data.length >= HEADER_CACHE_SIZE
    ? data.slice(0, HEADER_CACHE_SIZE)
    : data.slice(0, Math.min(data.length, HEADER_CACHE_SIZE));

  parseChunk(firstChunk.data, firstChunk.chunkStart);
  const vPidDisplay = videoPid !== null ? `0x${(videoPid as number).toString(16)}` : 'not found';
  const vTypeDisplay = videoStreamType !== null ? `0x${(videoStreamType as number).toString(16)}` : 'not found';
  const pmtDisplay = pmtPid !== null ? `0x${(pmtPid as number).toString(16)}` : 'not found';
  console.log(`[TSScanner] Phase 1 done: videoPid=${vPidDisplay}, streamType=${vTypeDisplay}, pmtPid=${pmtDisplay}`);

  // ======== Phase 2: Fetch and parse bulk chunks in parallel batches ========
  const batchSize = PARALLEL_CHUNKS;
  let chunksProcessed = 1; // Phase 1 already done
  let consecutive503s = 0; // Stop scanning after N consecutive 503s (cached_only)
  const MAX_CONSECUTIVE_503S = 5; // After 5 consecutive uncached chunks, stop — more data will arrive later

  for (let batchStart = 1; batchStart < totalChunks; batchStart += batchSize) {
    if (abortSignal?.aborted) break;
    if (consecutive503s >= MAX_CONSECUTIVE_503S) {
      console.log(`[TSScanner] Stopped scan after ${consecutive503s} consecutive uncached chunks at chunk ${batchStart} — will retry later when more data is cached`);
      break;
    }

    const batchEnd = Math.min(batchStart + batchSize, totalChunks);
    const batchIndices = [];
    for (let i = batchStart; i < batchEnd; i++) {
      batchIndices.push(i);
    }

    // Fetch all chunks in this batch concurrently
    const batchResults = await Promise.all(batchIndices.map(idx => fetchChunk(idx)));

    // Parse each chunk sequentially (keyframes must be in order for dedup)
    let anyChunkData = false;
    for (const result of batchResults) {
      if (result) {
        parseChunk(result.data, result.chunkStart);
        anyChunkData = true;
      }
      chunksProcessed++;
    }

    // Track consecutive 503s — reset when we get actual data
    if (anyChunkData) {
      consecutive503s = 0;
    } else {
      consecutive503s++;
    }

    // Progress log — more frequent for better visibility of keyframe detection
    const progress = chunksProcessed / totalChunks * 100;
    if (chunksProcessed % 5 === 0 || progress >= 100) {
      console.log(`[TSScanner] Progress: ${progress.toFixed(0)}% (${chunksProcessed}/${totalChunks}), keyframes=${keyframes.length}, videoPid=0x${(videoPid ?? 0).toString(16)}, streamType=0x${(videoStreamType ?? 0).toString(16)}`);
    }
  }

  // Handle case where video PID was not found
  if (videoPid === null) {
    console.warn('[TSScanner] Could not identify video PID from PAT/PMT');
  }

  const duration = lastPts / PTS_CLOCK_RATE;
  console.log(`[TSScanner] Scan complete: ${keyframes.length} keyframes, ${skippedChunks} chunks skipped (not cached), videoPid=0x${(videoPid ?? 0).toString(16)}, duration≈${duration.toFixed(2)}s, range=[${keyframes[0]?.timestamp.toFixed(2)}s .. ${keyframes[keyframes.length - 1]?.timestamp.toFixed(2)}s]`);

  return {
    keyframes,
    videoPid: videoPid ?? 0,
    headerData,
    duration,
  };
}

/** Find the first TS sync byte (0x47) in the data. */
function findSyncByte(data: Uint8Array, start: number): number {
  for (let i = start; i < data.length; i++) {
    if (data[i] === TS_SYNC_BYTE) return i;
  }
  return -1;
}

/** Verify that sync bytes appear at every 188-byte interval from the given offset. */
function verifySyncAlignment(data: Uint8Array, offset: number): boolean {
  // Check at least 3 consecutive sync positions
  for (let i = 0; i < 3; i++) {
    const pos = offset + i * TS_PACKET_SIZE;
    if (pos >= data.length) return true; // Not enough data to verify further — assume aligned
    if (data[pos] !== TS_SYNC_BYTE) return false;
  }
  return true;
}

/** Parse PAT (Program Association Table) from a TS packet.
 *  Returns the PMT PID, or null if parsing fails. */
function parsePAT(packet: Uint8Array, afc: number): number | null {
  // Skip adaptation field if present
  let payloadOffset = 4; // Start after TS header
  if (afc === 0x02 || afc === 0x03) {
    const afLength = packet[4];
    payloadOffset = 5 + afLength;
  }

  // Pointer field (1 byte) — offset to start of table section
  const pointerField = packet[payloadOffset];
  const tableStart = payloadOffset + 1 + pointerField;

  if (tableStart + 8 > TS_PACKET_SIZE) return null; // Not enough data

  // Table ID must be 0x00 for PAT
  if (packet[tableStart] !== 0x00) return null;

  // Section syntax indicator + section length
  const sectionLength = ((packet[tableStart + 1] & 0x03) << 8) | packet[tableStart + 2];
  const programDataStart = tableStart + 8; // After table_id, section_length, transport_stream_id, version, section_number, last_section_number

  // Parse program entries
  const programDataEnd = tableStart + 3 + sectionLength - 4; // -4 for CRC32
  let offset = programDataStart;
  while (offset + 4 <= programDataEnd) {
    const programNumber = (packet[offset] << 8) | packet[offset + 1];
    const pid = ((packet[offset + 2] & 0x1F) << 8) | packet[offset + 3];

    if (programNumber !== 0) {
      // This is a program → PMT PID
      return pid;
    }
    // program_number = 0 → network PID, skip
    offset += 4;
  }

  return null;
}

/** Parse PMT (Program Map Table) from a TS packet.
 *  Returns the video elementary stream PID and stream_type, or null if parsing fails. */
function parsePMT(packet: Uint8Array, afc: number): { pid: number; streamType: number } | null {
  // Skip adaptation field if present
  let payloadOffset = 4;
  if (afc === 0x02 || afc === 0x03) {
    const afLength = packet[4];
    payloadOffset = 5 + afLength;
  }

  // Pointer field
  const pointerField = packet[payloadOffset];
  const tableStart = payloadOffset + 1 + pointerField;

  if (tableStart + 12 > TS_PACKET_SIZE) return null;

  // Table ID must be 0x02 for PMT
  if (packet[tableStart] !== 0x02) return null;

  // Section length
  const sectionLength = ((packet[tableStart + 1] & 0x03) << 8) | packet[tableStart + 2];

  // Program info length
  const programInfoLength = ((packet[tableStart + 10] & 0x03) << 8) | packet[tableStart + 11];

  // Stream entries start after program info
  let offset = tableStart + 12 + programInfoLength;
  const streamDataEnd = tableStart + 3 + sectionLength - 4; // -4 for CRC32

  // Parse stream entries to find video PID
  // Common video stream types: 0x1B (H.264), 0x24 (H.265/HEVC), 0x10 (MPEG-2 video)
  const videoStreamTypes = [0x1B, 0x24, 0x10, 0x01]; // H.264, HEVC, MPEG-2, MPEG-1

  while (offset + 5 <= streamDataEnd) {
    const streamType = packet[offset];
    const esPid = ((packet[offset + 1] & 0x1F) << 8) | packet[offset + 2];
    const esInfoLength = ((packet[offset + 3] & 0x03) << 8) | packet[offset + 4];

    if (videoStreamTypes.includes(streamType)) {
      return { pid: esPid, streamType };
    }

    offset += 5 + esInfoLength;
  }

  return null;
}

/** Extract PTS timestamp from a TS packet's PES header.
 *  Requires PUSI=1 (Payload Unit Start Indicator) and PTS_DTS_flags != 00. */
function extractPTS(packet: Uint8Array, afc: number, afLength: number): number | null {
  // Calculate PES header offset
  let pesOffset: number;

  if (afc === 0x03) {
    // Adaptation field + payload
    pesOffset = 4 + 1 + afLength; // TS header + AFC length byte + adaptation field
  } else if (afc === 0x01) {
    // Payload only
    pesOffset = 4;
  } else {
    return null; // No payload
  }

  // PES header start code: 0x00 0x00 0x01
  if (pesOffset + 9 > TS_PACKET_SIZE) return null; // Not enough data for PES header
  if (packet[pesOffset] !== 0x00 || packet[pesOffset + 1] !== 0x00 || packet[pesOffset + 2] !== 0x01) {
    return null; // Not a valid PES header
  }

  // PES header flags: check PTS_DTS_flags (bits 7-6 of the second flags byte)
  // Skip the first flags byte (PES scrambling control, priority, etc.)
  const flagsByte2 = packet[pesOffset + 7];

  // Check PTS_DTS_flags (bits 7-6 of flagsByte2)
  const ptsDtsFlags = (flagsByte2 >> 6) & 0x03;
  if (ptsDtsFlags === 0x00) return null; // No PTS

  // PTS starts at pesOffset + 9 (after PES header: start code(3) + stream_id(1) +
  // PES_packet_length(2) + flags1(1) + flags2(1) + header_data_length(1))
  const ptsOffset = pesOffset + 9;
  if (ptsOffset + 5 > TS_PACKET_SIZE) return null;

  // Decode PTS (33 bits, encoded in 5 bytes with marker bits)
  // Byte 0: [marker4(0010/0011)][PTS32-30(3)][1]
  // Byte 1: PTS29-22 (8 bits)
  // Byte 2: [PTS21-15(7)][1]
  // Byte 3: PTS14-7 (8 bits)
  // Byte 4: [PTS6-0(7)][1]
  const b0 = packet[ptsOffset];
  const b1 = packet[ptsOffset + 1];
  const b2 = packet[ptsOffset + 2];
  const b3 = packet[ptsOffset + 3];
  const b4 = packet[ptsOffset + 4];

  // Verify marker bits (bit 0 of each group must be 1)
  if ((b0 & 0x01) !== 1 || (b2 & 0x01) !== 1 || (b4 & 0x01) !== 1) {
    return null; // Invalid marker bits
  }

  const pts30 = (b0 >> 1) & 0x07; // PTS[32..30]
  const pts29to15 = ((b1 << 7) | ((b2 >> 1) & 0x7F)) & 0x7FFF; // PTS[29..15]
  const pts14to0 = ((b3 << 7) | ((b4 >> 1) & 0x7F)) & 0x7FFF; // PTS[14..0]

  const pts = (pts30 << 30) | (pts29to15 << 15) | pts14to0;
  return pts;
}

/** Detect H.264 keyframe in a PES payload within a TS packet.
 *  Checks for IDR NAL unit (type 5) or SPS (type 7) / PPS (type 8)
 *  in the PES payload after the PES header.
 *  This is a fallback for streams that don't set the RAI (Random Access
 *  Indicator) bit in the adaptation field — many encoders omit RAI. */
function detectH264KeyframeInPES(packet: Uint8Array, afc: number): boolean {
  // Calculate PES header offset based on AFC
  let pesOffset: number;
  if (afc === 0x03) {
    const afLength = packet[4];
    pesOffset = 4 + 1 + afLength; // TS header + AFC length byte + adaptation field
  } else if (afc === 0x01) {
    pesOffset = 4; // Payload only — no adaptation field
  } else {
    return false; // AFC=0x02 (adaptation field only) or reserved — no payload
  }

  // Verify PES start code: 0x00 0x00 0x01
  if (pesOffset + 9 > TS_PACKET_SIZE) return false;
  if (packet[pesOffset] !== 0x00 || packet[pesOffset + 1] !== 0x00 || packet[pesOffset + 2] !== 0x01) {
    return false;
  }

  // PES header: start_code(3) + stream_id(1) + PES_packet_length(2) +
  // flags1(1) + flags2(1) + PES_header_data_length(1) = 9 bytes minimum
  // Payload starts at pesOffset + 9 + PES_header_data_length
  const pesHeaderDataLength = packet[pesOffset + 8];
  const payloadStart = pesOffset + 9 + pesHeaderDataLength;

  if (payloadStart + 4 > TS_PACKET_SIZE) return false; // Not enough bytes for NAL start code + type

  // Scan ALL NAL units in the PES payload for keyframe types (5=IDR, 7=SPS, 8=PPS).
  // H.264 access units typically start with AUD (type 9) before SPS/PPS/IDR NALs.
  // Must scan past non-keyframe NALs (AUD, SEI, etc.) to find the actual keyframe.
  for (let i = payloadStart; i < TS_PACKET_SIZE - 3; i++) {
    if (packet[i] !== 0x00) continue;
    if (packet[i + 1] !== 0x00) continue;

    // Check for 4-byte start code (0x00 0x00 0x00 0x01)
    if (i + 4 < TS_PACKET_SIZE && packet[i + 2] === 0x00 && packet[i + 3] === 0x01) {
      const nalType = packet[i + 4] & 0x1F;
      if (nalType === 5 || nalType === 7 || nalType === 8) return true;
      i += 3; // Skip past 0x00 0x00 0x00 — loop's i++ handles 0x01
      continue;
    }
    // Check for 3-byte start code (0x00 0x00 0x01)
    if (packet[i + 2] === 0x01) {
      const nalType = packet[i + 3] & 0x1F;
      if (nalType === 5 || nalType === 7 || nalType === 8) return true;
      i += 2; // Skip past 0x00 0x00 — loop's i++ handles 0x01
      continue;
    }
  }

  return false; // No keyframe NAL found in payload
}

/** Detect HEVC (H.265) keyframe in a PES payload within a TS packet.
 *  Checks for IRAP NAL units (types 16-21: BLA, IDR_W_RADL, IDR_N_LP, CRA)
 *  in the PES payload. HEVC NAL header is 2 bytes: nal_unit_type = (byte0 >> 1) & 0x3F. */
function detectHEVCKeyframeInPES(packet: Uint8Array, afc: number): boolean {
  let pesOffset: number;
  if (afc === 0x03) {
    const afLength = packet[4];
    pesOffset = 4 + 1 + afLength;
  } else if (afc === 0x01) {
    pesOffset = 4;
  } else {
    return false;
  }

  if (pesOffset + 9 > TS_PACKET_SIZE) return false;
  if (packet[pesOffset] !== 0x00 || packet[pesOffset + 1] !== 0x00 || packet[pesOffset + 2] !== 0x01) {
    return false;
  }

  const pesHeaderDataLength = packet[pesOffset + 8];
  const payloadStart = pesOffset + 9 + pesHeaderDataLength;

  if (payloadStart + 5 > TS_PACKET_SIZE) return false;

  // Scan ALL NAL units in the PES payload for IRAP types (16-21: BLA, IDR, CRA)
  // and VPS/SPS/PPS (32-34) which always precede IRAP slices in access units.
  // HEVC access units typically start with AUD (type 35) before VPS/SPS/PPS/IRAP.
  // Must scan past non-keyframe NALs (AUD, SEI, etc.) to find keyframe indicators.
  for (let i = payloadStart; i < TS_PACKET_SIZE - 3; i++) {
    if (packet[i] !== 0x00) continue;
    if (packet[i + 1] !== 0x00) continue;

    // 4-byte start code: 0x00 0x00 0x00 0x01 + 2-byte HEVC NAL header
    if (i + 5 < TS_PACKET_SIZE && packet[i + 2] === 0x00 && packet[i + 3] === 0x01) {
      const nalType = (packet[i + 4] >> 1) & 0x3F;
      if ((nalType >= 16 && nalType <= 21) || (nalType >= 32 && nalType <= 34)) return true;
      i += 3; // Skip past 0x00 0x00 0x00 — loop's i++ handles 0x01
      continue;
    }
    // 3-byte start code: 0x00 0x00 0x01 + 2-byte HEVC NAL header
    if (packet[i + 2] === 0x01) {
      const nalType = (packet[i + 3] >> 1) & 0x3F;
      if ((nalType >= 16 && nalType <= 21) || (nalType >= 32 && nalType <= 34)) return true;
      i += 2; // Skip past 0x00 0x00 — loop's i++ handles 0x01
      continue;
    }
  }

  return false; // No IRAP or VPS/SPS/PPS NAL found in payload
}

/**
 * Create an OffsetCustomSource for fast TS seeking.
 *
 * This creates a virtual file that starts with cached header data (PAT/PMT
 * from the beginning of the file) followed by data from the keyframe byte offset.
 * mediabunny's Input can parse this virtual file: it reads PAT/PMT from the
 * header, then encounters video data starting at the keyframe position.
 * getKeyPacket finds the keyframe quickly (it's right after the header section)
 * instead of scanning the entire file from byte 0 (8-12s for TS).
 *
 * The virtual file layout:
 *   [0, headerSize)           → header data (PAT/PMT from original file start)
 *   [headerSize, virtualEnd)  → original file data from [byteOffset, fileSize)
 */
export interface OffsetSourceConfig {
  url: string;
  fileSize: number;
  byteOffset: number;
  headerData: Uint8Array;
  headers?: Record<string, string>;
  maxCacheSize?: number;
  prefetchProfile?: 'none' | 'fileSystem' | 'network';
}

export function createOffsetTauriStreamSource(config: OffsetSourceConfig): CustomSource {
  const {
    url,
    fileSize,
    byteOffset,
    headerData,
    headers = {},
    maxCacheSize,
    prefetchProfile = 'fileSystem', // 1 sequential prefetch worker — 'none' causes 188-byte HTTP requests
  } = config;

  // Append cached_only=true to prevent targeted download spawning.
  // The scanner/capture only reads data that should already be cached
  // on disk (within the sequential download's progress).
  const separator = url.includes('?') ? '&' : '?';
  const cachedOnlyUrl = `${url}${separator}cached_only=true`;

  const allHeaders = { ...headers };
  const virtualSize = headerData.length + (fileSize - byteOffset);
  let disposed = false;

  // Import CustomSource from mediabunny at the top level
  // (this function is called from MediabunnyTransmuxer which already imports it)
  // We use a dynamic import pattern but since this is a utility file,
  // we'll construct the CustomSource inline.

  return new CustomSource({
    getSize: async () => virtualSize,
    read: async (start: number, end: number) => {
      if (disposed) throw new Error('[OffsetSource] disposed during read');

      const totalRequested = end - start;
      const result = new Uint8Array(totalRequested);
      let filled = 0;

      // Part 1: Read from header data (if start < headerData.length)
      if (start < headerData.length) {
        const headerEnd = Math.min(end, headerData.length);
        const headerSlice = headerData.subarray(start, headerEnd);
        result.set(headerSlice, filled);
        filled += headerSlice.length;
      }

      // Part 2: Read from original file at byteOffset position
      if (filled < totalRequested) {
        // Calculate the position in the original file
        const virtualRemainingStart = start + filled;
        const origStart = byteOffset + (virtualRemainingStart - headerData.length);
        const origEnd = byteOffset + (end - headerData.length) - 1;

        if (origStart <= origEnd && origStart < fileSize) {
          const clampedOrigEnd = Math.min(origEnd, fileSize - 1);

          // Fetch from original file via HTTP range request
          // Use the same robust fetching as TauriStreamSource (handle 503, partial responses)
          let currentOrigStart = origStart;
          let emptyRetries = 0;

          while (filled < totalRequested && currentOrigStart <= clampedOrigEnd) {
            if (disposed) throw new Error('[OffsetSource] disposed during read');

            const remaining = totalRequested - filled;
            const rangeEnd = Math.min(currentOrigStart + remaining - 1, clampedOrigEnd);

            let chunk: Uint8Array | null = null;

            for (let attempt = 0; attempt <= 5; attempt++) {
              if (disposed) throw new Error('[OffsetSource] disposed during read');

              const response = await fetch(cachedOnlyUrl, {
                headers: {
                  ...allHeaders,
                  Range: `bytes=${currentOrigStart}-${rangeEnd}`,
                },
              });

              if (response.ok || response.status === 206) {
                const data = await response.arrayBuffer();
                chunk = new Uint8Array(data);
                break;
              }

              if (response.status === 503) {
                const reason = response.headers.get('X-Reason') || '';
                if (reason === 'cached-only-miss') {
                  // Range not cached — throw immediately, don't retry.
                  // The thumbnail extractor should only capture at cached positions.
                  throw new Error(`[OffsetSource] Range ${currentOrigStart}-${rangeEnd} not cached (cached_only=503) — thumbnail position beyond cached data`);
                }
                // Other 503 reasons (download-busy) — retry with exponential backoff
                if (attempt < 5) {
                  const retryAfter = parseInt(response.headers.get('Retry-After') || '30', 10);
                  const delay = Math.min(retryAfter * 1000, 1000 * Math.pow(2, attempt), 15000);
                  console.warn(`[OffsetSource] HTTP 503 for range ${currentOrigStart}-${rangeEnd}, retry ${attempt + 1}/5 in ${delay}ms`);
                  await new Promise(r => setTimeout(r, delay));
                  continue;
                }
              }

              throw new Error(`[OffsetSource] HTTP ${response.status} for range ${currentOrigStart}-${rangeEnd}`);
            }

            if (!chunk) {
              throw new Error(`[OffsetSource] HTTP 503 max retries exceeded`);
            }

            if (chunk.length === 0) {
              emptyRetries++;
              if (emptyRetries >= 60) {
                throw new Error(`[OffsetSource] No data available after 60 retries`);
              }
              await new Promise(r => setTimeout(r, 500));
              continue;
            }

            const copyLen = Math.min(chunk.length, totalRequested - filled);
            result.set(chunk.subarray(0, copyLen), filled);
            filled += copyLen;
            currentOrigStart += copyLen;
            emptyRetries = 0;

            if (chunk.length < (rangeEnd - currentOrigStart + copyLen + 1)) {
              await new Promise(r => setTimeout(r, 100));
            }
          }
        }
      }

      if (filled < totalRequested) {
        throw new Error(`[OffsetSource] Could not fill requested range: got ${filled}/${totalRequested} bytes`);
      }

      return result;
    },
    dispose: () => {
      disposed = true;
      console.log('[OffsetSource] disposed');
    },
    maxCacheSize,
    prefetchProfile,
  });
}
