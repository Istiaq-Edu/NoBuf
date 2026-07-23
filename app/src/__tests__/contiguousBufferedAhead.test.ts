import { describe, it, expect } from 'vitest';
import {
  contiguousBufferedAhead,
  MAX_BUFFER_HOLE_SECONDS,
  type SimpleTimeRange,
} from '../hooks/useMSEPlayer';

// Mock Tauri invoke so useMSEPlayer imports cleanly in jsdom.
import { vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * contiguousBufferedAhead is the download-loop backpressure measure: how many
 * seconds of buffer are reachable from the playhead by CONTINUOUS playback,
 * tolerating sub-frame holes. It replaced a naive "sum every range ahead of
 * currentTime" that counted stale far-away islands and deadlocked the loop
 * after a near-EOF-then-backward seek (see SEEK-STRAND-CROSSVALIDATION.md).
 *
 * Algorithm mirrors hls.js BufferHelper.bufferedInfo.
 */
describe('contiguousBufferedAhead', () => {
  // ── Degenerate / guard inputs ────────────────────────────────────────────
  it('empty ranges → 0', () => {
    expect(contiguousBufferedAhead([], 100)).toBe(0);
  });

  it('non-finite pos (NaN) → 0', () => {
    expect(contiguousBufferedAhead([{ start: 0, end: 30 }], NaN)).toBe(0);
  });

  it('Infinity pos → 0', () => {
    expect(contiguousBufferedAhead([{ start: 0, end: 30 }], Infinity)).toBe(0);
  });

  it('negative pos is clamped to 0 → counts from 0', () => {
    expect(contiguousBufferedAhead([{ start: 0, end: 30 }], -50)).toBe(30);
  });

  it('drops degenerate ranges (end <= start, NaN bounds)', () => {
    const ranges: SimpleTimeRange[] = [
      { start: 10, end: 10 }, // zero-length
      { start: 20, end: 15 }, // inverted
      { start: NaN, end: 5 }, // non-finite
      { start: 0, end: 30 }, // the only real one
    ];
    expect(contiguousBufferedAhead(ranges, 5)).toBe(25);
  });

  // ── Basic reachable buffer ───────────────────────────────────────────────
  it('pos inside a single range → end - pos', () => {
    expect(contiguousBufferedAhead([{ start: 0, end: 30 }], 10)).toBe(20);
  });

  it('pos at range start → full range length', () => {
    expect(contiguousBufferedAhead([{ start: 100, end: 130 }], 100)).toBe(30);
  });

  it('pos exactly at range end → 0 (nothing ahead)', () => {
    expect(contiguousBufferedAhead([{ start: 0, end: 30 }], 30)).toBe(0);
  });

  it('pos past the last range end → 0', () => {
    expect(contiguousBufferedAhead([{ start: 0, end: 30 }], 45)).toBe(0);
  });

  // ── THE deadlock bug: stale far-away island must NOT count ───────────────
  it('far-away island ahead of pos → 0 (the strand-seek bug)', () => {
    // Reproduces the real log: after seeking to 4027.9s, the SourceBuffer still
    // held leftover islands at 140s and 4793s and 9527s. The old code summed
    // ~31s and jammed backpressure. Only reachable buffer should count → 0.
    const ranges: SimpleTimeRange[] = [
      { start: 139.73, end: 140.05 },
      { start: 4793.15, end: 4793.39 },
      { start: 9527.47, end: 9558.54 },
    ];
    expect(contiguousBufferedAhead(ranges, 4027.9)).toBe(0);
  });

  it('island BEHIND pos is ignored, reachable region counted', () => {
    const ranges: SimpleTimeRange[] = [
      { start: 0, end: 140 }, // behind + around pos
      { start: 9527, end: 9558 }, // stale island far ahead
    ];
    // pos=100 sits in [0,140]; reachable = 140-100 = 40; island not added.
    expect(contiguousBufferedAhead(ranges, 100)).toBe(40);
  });

  it('big forward gap → counts only up to the gap, not past it', () => {
    const ranges: SimpleTimeRange[] = [
      { start: 0, end: 30 },
      { start: 4000, end: 4030 },
    ];
    expect(contiguousBufferedAhead(ranges, 10)).toBe(20);
  });

  // ── Hole tolerance (sub-frame boundary gaps are bridged) ─────────────────
  it('tiny hole within tolerance is bridged (contiguous)', () => {
    const ranges: SimpleTimeRange[] = [
      { start: 0, end: 30 },
      { start: 30.2, end: 60 }, // 0.2s gap < 0.5s tolerance
    ];
    expect(contiguousBufferedAhead(ranges, 10)).toBe(50); // 60 - 10
  });

  it('hole larger than tolerance is a real gap (not bridged)', () => {
    const ranges: SimpleTimeRange[] = [
      { start: 0, end: 30 },
      { start: 31, end: 60 }, // 1s gap > 0.5s tolerance
    ];
    expect(contiguousBufferedAhead(ranges, 10)).toBe(20); // stops at 30
  });

  it('pos just before a range within tolerance bridges the gap', () => {
    // playhead landed a hair before buffered data (rounding) — still reachable.
    expect(contiguousBufferedAhead([{ start: 100, end: 130 }], 99.7)).toBeCloseTo(30.3, 5);
  });

  it('pos just before a range BEYOND tolerance → 0', () => {
    expect(contiguousBufferedAhead([{ start: 100, end: 130 }], 98)).toBe(0);
  });

  // ── Unsorted / overlapping input (browsers don't guarantee order) ────────
  it('unsorted ranges are handled', () => {
    const ranges: SimpleTimeRange[] = [
      { start: 4000, end: 4030 },
      { start: 0, end: 30 },
      { start: 30.1, end: 100 },
    ];
    // pos=10 → [0,30]+[30.1,100] merge (0.1<0.5) → reachable to 100 → 90
    expect(contiguousBufferedAhead(ranges, 10)).toBe(90);
  });

  it('overlapping ranges merge correctly', () => {
    const ranges: SimpleTimeRange[] = [
      { start: 0, end: 10 },
      { start: 5, end: 15 },
    ];
    expect(contiguousBufferedAhead(ranges, 2)).toBe(13); // 15 - 2
  });

  it('fully-contained overlap uses the wider end', () => {
    const ranges: SimpleTimeRange[] = [
      { start: 1, end: 15 },
      { start: 2, end: 8 }, // contained within [1,15]
    ];
    expect(contiguousBufferedAhead(ranges, 3)).toBe(12); // 15 - 3
  });

  it('does not mutate the caller array', () => {
    const ranges: SimpleTimeRange[] = [
      { start: 4000, end: 4030 },
      { start: 0, end: 30 },
    ];
    const snapshot = JSON.parse(JSON.stringify(ranges));
    contiguousBufferedAhead(ranges, 10);
    expect(ranges).toEqual(snapshot);
  });

  // ── Backpressure decision parity (the reason this function exists) ───────
  it('deadlock scenario: ahead reads 0 so a 30s cap would UNBLOCK the loop', () => {
    const ranges: SimpleTimeRange[] = [
      { start: 139.73, end: 140.05 },
      { start: 4793.15, end: 4793.39 },
      { start: 9527.47, end: 9558.54 },
    ];
    const ahead = contiguousBufferedAhead(ranges, 4027.9);
    const MAX_BUFFER_AHEAD_SECONDS = 30;
    // Old buggy sum would have been ~31 (> cap → sleep forever). Now 0 (<= cap → fetch).
    expect(ahead).toBeLessThanOrEqual(MAX_BUFFER_AHEAD_SECONDS);
  });

  it('genuinely full contiguous buffer still reads as full (backpressure preserved)', () => {
    // Ensure the fix did not disable backpressure for the normal case.
    const ranges: SimpleTimeRange[] = [{ start: 100, end: 100 + 45 }];
    const ahead = contiguousBufferedAhead(ranges, 100);
    expect(ahead).toBe(45);
    expect(ahead).toBeGreaterThan(30); // > cap → loop correctly sleeps
  });

  it('exported tolerance constant is a small positive number', () => {
    expect(MAX_BUFFER_HOLE_SECONDS).toBeGreaterThan(0);
    expect(MAX_BUFFER_HOLE_SECONDS).toBeLessThanOrEqual(1);
  });

  it('custom maxHoleDuration=0 treats any gap as real', () => {
    const ranges: SimpleTimeRange[] = [
      { start: 0, end: 30 },
      { start: 30.001, end: 60 },
    ];
    expect(contiguousBufferedAhead(ranges, 10, 0)).toBe(20); // no bridging
  });
});
