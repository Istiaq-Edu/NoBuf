import { describe, it, expect, vi } from 'vitest';
import {
  isHevcFamilyCodec,
  computeRemuxSeekStartByte,
  hevcMseSupported,
  buildRemuxSeekUrl,
  clampSeekTime,
} from '../hooks/useMSEPlayer';

// Mock Tauri invoke so useMSEPlayer imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * These helpers back the MP4-HEVC → /remux reroute: when MSE rejects the MP4's
 * video codec, HEVC-family files are handed to the ffmpeg /remux → mpegts.js
 * tier (the same pipeline MKV-HEVC uses) instead of hard-erroring with
 * "Codec completely unsupported".
 */
describe('isHevcFamilyCodec', () => {
  it('matches plain HEVC codec strings (hvc1/hev1, any profile/level)', () => {
    // The exact string from the user's failing file (Main10 L4.0):
    expect(isHevcFamilyCodec('hvc1.1.6.L120.90')).toBe(true);
    expect(isHevcFamilyCodec('hvc1.2.4.L123.B0')).toBe(true); // Main10
    expect(isHevcFamilyCodec('hev1.1.6.L93.B0')).toBe(true);
  });

  it('matches Dolby Vision HEVC (dvh1/dvhe) — DV profile 5/8 are HEVC bitstreams', () => {
    // Previously these missed the startsWith(hvc1)||startsWith(hev1) checks
    // and hard-errored instead of rerouting.
    expect(isHevcFamilyCodec('dvh1.05.06')).toBe(true);
    expect(isHevcFamilyCodec('dvhe.08.07')).toBe(true);
  });

  it('is case-insensitive (codec strings from some muxers are uppercased)', () => {
    expect(isHevcFamilyCodec('HVC1.1.6.L120.90')).toBe(true);
    expect(isHevcFamilyCodec('DVHE.08.07')).toBe(true);
  });

  it('does NOT match non-HEVC codecs (they keep their existing routing)', () => {
    expect(isHevcFamilyCodec('avc1.640028')).toBe(false); // H.264 → MSE direct
    expect(isHevcFamilyCodec('av01.0.08M.08')).toBe(false); // AV1 → native check
    expect(isHevcFamilyCodec('vp09.00.10.08')).toBe(false);
    expect(isHevcFamilyCodec('mp4a.40.2')).toBe(false); // audio, never video-routed
  });

  it('null/undefined/empty → false (defensive: track may lack a codec)', () => {
    expect(isHevcFamilyCodec(null)).toBe(false);
    expect(isHevcFamilyCodec(undefined)).toBe(false);
    expect(isHevcFamilyCodec('')).toBe(false);
  });
});

/**
 * computeRemuxSeekStartByte guards the BYTE-FORWARD seek mechanism: feeding
 * ffmpeg stdin [TS init_prefix + raw /stream bytes] is only valid when the
 * /stream content is REAL MPEG-TS. For MKV/MP4 sources a mid-file slice on
 * stdin dies with "Invalid data found" (execution-proven), so the helper must
 * return undefined → the seek URL carries only ss= and ffmpeg seeks the
 * seekable HTTP input itself.
 */
describe('computeRemuxSeekStartByte', () => {
  const DUR = 6267.712; // the user's real file
  const SIZE = 1462989388;

  it('TS source (timed_id3) → linear byte estimate (the proven robust path)', () => {
    const b = computeRemuxSeekStartByte(true, 671.68, DUR, SIZE);
    expect(b).toBe(Math.round((671.68 / DUR) * SIZE));
  });

  it('MKV/MP4 source → ALWAYS undefined, even with valid duration+size', () => {
    // This kills the latent MKV bug: fileLength+duration are always known for
    // MKV, so the old code sent start_byte → backend fed mid-file Matroska to
    // ffmpeg stdin → instant death. Now: ss-only.
    expect(computeRemuxSeekStartByte(false, 671.68, DUR, SIZE)).toBeUndefined();
    expect(computeRemuxSeekStartByte(false, 5000, DUR, SIZE)).toBeUndefined();
  });

  it('t=0 / negative / NaN → undefined (front of file needs no byte seek)', () => {
    expect(computeRemuxSeekStartByte(true, 0, DUR, SIZE)).toBeUndefined();
    expect(computeRemuxSeekStartByte(true, -3, DUR, SIZE)).toBeUndefined();
    expect(computeRemuxSeekStartByte(true, NaN, DUR, SIZE)).toBeUndefined();
  });

  it('unknown duration or size → undefined (cannot estimate)', () => {
    expect(computeRemuxSeekStartByte(true, 100, 0, SIZE)).toBeUndefined();
    expect(computeRemuxSeekStartByte(true, 100, DUR, 0)).toBeUndefined();
    expect(computeRemuxSeekStartByte(true, 100, NaN, SIZE)).toBeUndefined();
  });

  it('composes with buildRemuxSeekUrl: MP4/MKV seeks carry ss= but NEVER start_byte', () => {
    const base = 'http://localhost:14201/remux/home/84?token=abc&hevc_ok=false';
    const t = clampSeekTime(1200, DUR);
    const url = buildRemuxSeekUrl(base, t, computeRemuxSeekStartByte(false, t, DUR, SIZE));
    expect(url).toContain('ss=1200.000');
    expect(url).not.toContain('start_byte');
  });

  it('composes with buildRemuxSeekUrl: timed_id3 TS seeks carry BOTH', () => {
    const base = 'http://localhost:14201/remux/home/84?token=abc&hevc_ok=false';
    const url = buildRemuxSeekUrl(base, 671.68, computeRemuxSeekStartByte(true, 671.68, DUR, SIZE));
    expect(url).toContain('start_byte=');
    expect(url).toContain('ss=671.680');
  });
});

/**
 * hevcMseSupported feeds the /remux `hevc_ok` hint (previously a dead param —
 * read by the backend, never sent by the frontend). On machines WITH the HEVC
 * Video Extensions, 8-bit HEVC gets `-c:v copy` (zero transcode); everyone
 * else transcodes. Verified empirically: stock WebView2 returns false.
 */
describe('hevcMseSupported', () => {
  it('true when MSE reports HEVC Main profile support (extension installed)', () => {
    expect(hevcMseSupported((m) => m.includes('hvc1'))).toBe(true);
  });

  it('false on stock WebView2 (isTypeSupported returns false)', () => {
    expect(hevcMseSupported(() => false)).toBe(false);
  });

  it('false when the probe throws (no MediaSource in exotic contexts)', () => {
    expect(hevcMseSupported(() => { throw new Error('no MSE'); })).toBe(false);
  });

  it('probes an 8-bit Main profile string, not Main10', () => {
    // 10-bit is always transcoded server-side; the hint only unlocks the
    // 8-bit copy path — so the probe must ask about Main (hvc1.1...), not
    // Main10 (hvc1.2...).
    let probed = '';
    hevcMseSupported((m) => { probed = m; return false; });
    expect(probed).toContain('hvc1.1');
    expect(probed).not.toContain('hvc1.2');
  });
});
