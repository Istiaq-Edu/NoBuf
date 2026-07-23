import { describe, it, expect, vi } from 'vitest';
import { computeThumbnailSeekTarget } from '../hooks/useThumbnailExtractor';

// Mock Tauri invoke so the hook module imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * computeThumbnailSeekTarget decides video.currentTime for a hover capture.
 * The critical bug (log 15, t=1633.88): seeking to exactly buffered.start(0)
 * deterministically failed (no decodable frame at the exact boundary → no
 * 'seeked' → 5s timeout) while a near-identical hover one range over succeeded.
 * The fix nudges just inside the first range when the requested time isn't
 * covered. These tests lock that logic.
 */
describe('computeThumbnailSeekTarget', () => {
  it('returns null when there are no buffered ranges', () => {
    expect(computeThumbnailSeekTarget(1633.88, [])).toBeNull();
  });

  it('seeks to the requested time when a range covers it (accurate frame)', () => {
    const ranges = [{ start: 1630, end: 1640 }];
    expect(computeThumbnailSeekTarget(1633.88, ranges)).toBe(1633.88);
  });

  it('nudges past start(0) when the time is NOT covered (the 1633.88 fix)', () => {
    // Segment landed at 1667.62 (VBR skew); requested 1633.88 not covered.
    const ranges = [{ start: 1667.62, end: 1669.62 }];
    // Nudged by default epsilon 0.1 → 1667.72, NOT the exact boundary 1667.62.
    expect(computeThumbnailSeekTarget(1633.88, ranges)).toBeCloseTo(1667.72, 5);
  });

  it('does not exceed the range midpoint for a very short range', () => {
    // Range only 0.05s wide; epsilon 0.1 would overshoot the end → clamp to mid.
    const ranges = [{ start: 100.0, end: 100.05 }];
    expect(computeThumbnailSeekTarget(50, ranges)).toBeCloseTo(100.025, 5);
  });

  it('handles a degenerate zero-width range without overshooting', () => {
    const ranges = [{ start: 200, end: 200 }];
    expect(computeThumbnailSeekTarget(50, ranges)).toBe(200);
  });

  it('checks ALL ranges for coverage, not just the first', () => {
    const ranges = [
      { start: 100, end: 110 },
      { start: 1630, end: 1640 },
    ];
    // Covered by the SECOND range → seek to the exact requested time.
    expect(computeThumbnailSeekTarget(1633.88, ranges)).toBe(1633.88);
  });

  it('nudges into the FIRST range when uncovered by any range', () => {
    const ranges = [
      { start: 500, end: 502 },
      { start: 900, end: 902 },
    ];
    expect(computeThumbnailSeekTarget(1633.88, ranges)).toBeCloseTo(500.1, 5);
  });

  it('respects a custom epsilon', () => {
    const ranges = [{ start: 1000, end: 1005 }];
    expect(computeThumbnailSeekTarget(50, ranges, 0.5)).toBeCloseTo(1000.5, 5);
  });

  it('treats a range whose start equals time as covered (inclusive boundary)', () => {
    const ranges = [{ start: 1633.88, end: 1640 }];
    expect(computeThumbnailSeekTarget(1633.88, ranges)).toBe(1633.88);
  });
});
