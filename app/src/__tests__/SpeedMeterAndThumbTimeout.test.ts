import { describe, it, expect, vi } from 'vitest';
import { speedMeterValue } from '../hooks/useMSEPlayer';
import { KEYFRAME_AT_TIMEOUT_MS, BACKEND_KEYFRAME_SEARCH_DEADLINE_MS, resolveKeyframeSegmentMode } from '../hooks/useThumbnailExtractor';

// Mock Tauri invoke so the hook modules import cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * B1: the download-speed meter used to read ONLY greenBarSpeed (disk cache
 * cached_bytes delta), which sits at 0 during cold start because the disk cache
 * barely grows for the first ~40s while the /remux pipe feeds mpegts.js directly.
 * speedMeterValue falls back to the live MSE pipe throughput (mseSpeed) so the
 * meter isn't stuck at "—", while preserving "paused means paused".
 */
describe('speedMeterValue (B1 cold-start speed indicator)', () => {
  it('prefers greenBarSpeed when it is live', () => {
    // Disk prebuffer running: that IS the real signal, use it over mseSpeed.
    expect(speedMeterValue(2_000_000, 500_000, false)).toBe(2_000_000);
  });

  it('falls back to MSE pipe speed during cold start (greenBarSpeed still 0)', () => {
    // The exact bug: disk delta 0, but bytes ARE streaming through mpegts.js.
    expect(speedMeterValue(0, 1_234_567, false)).toBe(1_234_567);
  });

  it('returns 0 (→ "—") when both signals are idle', () => {
    expect(speedMeterValue(0, 0, false)).toBe(0);
  });

  it('shows nothing when prefetch is paused, even if bytes are in flight ("paused means paused")', () => {
    // Residual in-flight bytes must NOT light the meter while the user paused.
    expect(speedMeterValue(2_000_000, 1_000_000, true)).toBe(0);
    expect(speedMeterValue(0, 5_000_000, true)).toBe(0);
  });

  it('ignores negative/garbage values gracefully', () => {
    // Neither > 0 → 0. (Guards against a transient negative delta.)
    expect(speedMeterValue(-5, -9, false)).toBe(0);
    // greenBar garbage but mseSpeed valid → use mseSpeed.
    expect(speedMeterValue(-5, 800_000, false)).toBe(800_000);
  });
});

/**
 * C2: the frontend keyframe-at abort timeout MUST be >= the backend search
 * deadline, otherwise the frontend always preempts the backend before it can
 * return a real keyframe and every far hover falls back to a crude linear byte
 * estimate that then fails to seek on VBR content. This test fails if either
 * value drifts out of sync.
 */
describe('keyframe-at timeout alignment (C2)', () => {
  it('frontend timeout is at least the backend search deadline', () => {
    expect(KEYFRAME_AT_TIMEOUT_MS).toBeGreaterThanOrEqual(BACKEND_KEYFRAME_SEARCH_DEADLINE_MS);
  });

  it('keeps a sane margin above the backend deadline (not absurdly long)', () => {
    const margin = KEYFRAME_AT_TIMEOUT_MS - BACKEND_KEYFRAME_SEARCH_DEADLINE_MS;
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeLessThanOrEqual(5000); // >0, but don't hang the UI for many extra seconds
  });
});

/**
 * Thumbnail accuracy regression (log 3-c): a hover at time=878s rendered the 58s
 * frame because a deadline `fallback:true` response was routed to the time-based
 * segment URL (sparse Fmp4ByteTimeCache) instead of using its (linear-estimate)
 * byte_offset. resolveKeyframeSegmentMode must use the byte for BOTH the exact
 * keyframe AND the fallback, and only choose time-mode when no byte exists.
 */
describe('keyframe-at segment routing (thumbnail accuracy)', () => {
  it('uses byte_offset for an exact keyframe (fallback:false)', () => {
    expect(resolveKeyframeSegmentMode({ byte_offset: 556811670, fallback: false }))
      .toEqual({ mode: 'byte', byteOffset: 556811670 });
  });

  it('uses byte_offset for a deadline fallback (fallback:true) — the bug', () => {
    // The old code fell through to time-mode here → wrong early-file frame.
    expect(resolveKeyframeSegmentMode({ byte_offset: 556811670, fallback: true }))
      .toEqual({ mode: 'byte', byteOffset: 556811670 });
  });

  it('falls back to time-mode only when there is no byte_offset', () => {
    expect(resolveKeyframeSegmentMode({ fallback: true })).toEqual({ mode: 'time' });
    expect(resolveKeyframeSegmentMode({ byte_offset: null })).toEqual({ mode: 'time' });
    expect(resolveKeyframeSegmentMode(null)).toEqual({ mode: 'time' });
    expect(resolveKeyframeSegmentMode(undefined)).toEqual({ mode: 'time' });
  });

  it('accepts byte_offset 0 (start of file) as a valid byte position', () => {
    expect(resolveKeyframeSegmentMode({ byte_offset: 0, fallback: false }))
      .toEqual({ mode: 'byte', byteOffset: 0 });
  });
});
