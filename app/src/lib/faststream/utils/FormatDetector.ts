/**
 * FormatDetector — detects video file format from magic bytes and file extension.
 * Used by useMSEPlayer to route to the correct handler (MP4/TS/MKV/native).
 */

export type DetectedFormat = 'mp4' | 'ts' | 'mkv' | 'webm' | 'unknown';

const MKV_MAGIC = [0x1A, 0x45, 0xDF, 0xA3]; // EBML header magic bytes
const TS_SYNC_BYTE = 0x47; // MPEG-TS sync byte

/**
 * Detect the format of a video file from the first bytes of data.
 * Primary detection via magic bytes; file extension used as secondary signal.
 *
 * @param data - First bytes of the file (at least 4 bytes recommended, 192+ for TS validation)
 * @param filename - Optional filename for extension-based fallback
 */
export function detectFormat(data: ArrayBuffer, filename?: string): DetectedFormat {
  const view = new DataView(data);
  if (data.byteLength < 4) return fallbackByExtension(filename);

  // MPEG-TS: sync byte 0x47 at positions 0, 188, 376 (188-byte packets).
  // Check TS FIRST — sync byte at offset 0 is distinctive and prevents
  // false-positive MP4 detection (bytes 4-7 of a TS PAT packet could
  // theoretically contain 'ftyp' by coincidence).
  if (view.getUint8(0) === TS_SYNC_BYTE) {
    let tsConfidence = 0;
    // Check sync byte at offset 188 (strong signal)
    if (data.byteLength >= 188 && view.getUint8(188) === TS_SYNC_BYTE) {
      tsConfidence++;
      // Check sync byte at offset 376 (very strong signal)
      if (data.byteLength >= 376 && view.getUint8(376) === TS_SYNC_BYTE) {
        tsConfidence++;
      }
    }
    if (tsConfidence >= 1) return 'ts';
    // Weak signal: just first sync byte. Accept if extension confirms.
    const ext = getExtension(filename);
    if (ext === '.ts' || ext === '.m2ts' || ext === '.mts') return 'ts';
  }

  // MP4 / MOV: starts with ftyp box (4-byte size + 'ftyp')
  const boxType = String.fromCharCode(
    view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7)
  );
  if (boxType === 'ftyp' || boxType === 'jP  ') return 'mp4';

  // MKV / WebM: starts with EBML header (0x1A 0x45 0xDFA3)
  if (
    view.getUint8(0) === MKV_MAGIC[0] &&
    view.getUint8(1) === MKV_MAGIC[1] &&
    view.getUint8(2) === MKV_MAGIC[2] &&
    view.getUint8(3) === MKV_MAGIC[3]
  ) {
    // Both MKV and WebM start with EBML header. Check DocType for distinction.
    // In practice, MSE treats them differently (fMP4 for MKV H264, WebM for VP9).
    // For our purposes, both route through the same MKV handler which decides
    // the output format based on codec content.
    return 'mkv';
  }

  return fallbackByExtension(filename);
}

function fallbackByExtension(filename?: string): DetectedFormat {
  if (!filename) return 'unknown';
  const ext = getExtension(filename);
  switch (ext) {
    case '.mp4': case '.m4v': case '.mov': return 'mp4';
    case '.ts': case '.m2ts': case '.mts': return 'ts';
    case '.mkv': case '.mk3d': return 'mkv';
    case '.webm': return 'webm';
    default: return 'unknown';
  }
}

function getExtension(filename?: string): string {
  if (!filename) return '';
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return '';
  return filename.slice(idx).toLowerCase();
}
