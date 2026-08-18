import { describe, it, expect, vi } from 'vitest';
import { classifyNullRefill } from '../hooks/useMSEPlayer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Null-refill circuit breaker (fix B): classifies consecutive seekTo-null
 * refills. Near the file end (within one GOP, floor 5s) a null means the last
 * keyframe is behind us and fully transmuxed → 'eof' at N≥2 (mirrors the
 * shipped indexed-EOF precedent: nearEOF + noProgress≥1 = 2 observations).
 * Mid-file → 'reroute' to the ffmpeg tier at N≥5. The 30s fixed threshold was
 * REJECTED in review (could truncate ~3 GOPs of tail); threshold is dynamic:
 * max(estimatedKeyframeInterval, 5), computed at the call site.
 */
describe('classifyNullRefill', () => {
  const DUR = 8888.1;
  const GOP = 10.4;

  it('mid-file: continue below 5, reroute at 5+', () => {
    for (let n = 1; n <= 4; n++) {
      expect(classifyNullRefill(n, 25.02, DUR, true, GOP)).toBe('continue');
    }
    expect(classifyNullRefill(5, 25.02, DUR, true, GOP)).toBe('reroute');
    expect(classifyNullRefill(6, 25.02, DUR, true, GOP)).toBe('reroute');
  });

  it('near-EOF: continue at 1, eof at 2+ (never reroute)', () => {
    const pos = DUR - 3; // inside the final GOP
    expect(classifyNullRefill(1, pos, DUR, true, GOP)).toBe('continue');
    expect(classifyNullRefill(2, pos, DUR, true, GOP)).toBe('eof');
    expect(classifyNullRefill(7, pos, DUR, true, GOP)).toBe('eof');
  });

  it('near-EOF boundary sits exactly at duration - threshold', () => {
    expect(classifyNullRefill(2, DUR - GOP, DUR, true, GOP)).toBe('eof');       // on the line
    expect(classifyNullRefill(2, DUR - GOP - 0.01, DUR, true, GOP)).toBe('continue'); // just outside, N<5
    expect(classifyNullRefill(5, DUR - GOP - 0.01, DUR, true, GOP)).toBe('reroute');  // just outside, N≥5
  });

  it('unknown/degenerate duration can never declare eof', () => {
    expect(classifyNullRefill(9, 100, 0, true, GOP)).toBe('reroute');
    expect(classifyNullRefill(9, 100, Infinity, true, GOP)).toBe('reroute');
    expect(classifyNullRefill(9, 100, NaN, true, GOP)).toBe('reroute');
  });

  it('non-MKV never classifies (TS/MP4 hygiene, N5)', () => {
    expect(classifyNullRefill(99, 25.02, DUR, false, GOP)).toBe('continue');
  });
});
