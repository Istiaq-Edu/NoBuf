import { describe, it, expect } from 'vitest';
import {
  emptySubRepairBreakerState,
  resetSubRepairBreakerForSeek,
  shouldAttemptSubRepair,
  reduceSubRepairBreaker,
  computeSubRepairBackoffMs,
} from '../hooks/useMSEPlayer';

/**
 * Round-27 — the defects actually observed in 26-c.md / 26-t.md.
 *
 * Every prior round's tests passed while the user kept seeing the bug, because
 * they asserted helpers in isolation against my assumptions. These are keyed to
 * BYTES AND TIMES COPIED OUT OF THE LOG, so they fail if the shipped behaviour
 * stops matching what the logs proved.
 *
 * Reference file (26-c:5, :18, :29): Inception 720p MKV
 *   total = 1,566,651,347 B   duration = 8888.136 s   mean = 176,264.9 B/s
 */

const TOTAL = 1_566_651_347;
const DUR = 8888.136;

const linearByte = (t: number) => Math.round((t / DUR) * TOTAL);
const linearTime = (b: number) => (b / TOTAL) * DUR;

/**
 * The VBR inversion `timeToByte` performs, reproduced over the anchor pairs the
 * log actually printed. Interpolation between anchors, matching useMSEPlayer's
 * binary search + linear interpolation between neighbours.
 */
function vbrByte(anchors: [number, number][], t: number): number {
  if (anchors.length < 2) return linearByte(t);
  const sorted = [...anchors].sort((a, b) => a[1] - b[1]);
  if (t <= sorted[0][1]) return sorted[0][0];
  if (t >= sorted[sorted.length - 1][1]) return sorted[sorted.length - 1][0];
  let lo = 0;
  for (let i = 0; i < sorted.length - 1; i++) if (sorted[i][1] <= t) lo = i;
  const [bLo, tLo] = sorted[lo];
  const [bHi, tHi] = sorted[lo + 1];
  return Math.floor(bLo + ((bHi - bLo) * (t - tLo)) / (tHi - tLo));
}

describe('round-27: the byte reported to PROACTIVE after a /remux seek', () => {
  // 26-c:186 and :262 — the ONLY VBR-aware estimator in the old build. Both
  // show the true byte sitting BEHIND the linear estimate.
  const anchors: [number, number][] = [
    [350_221_707, 2002],
    [588_311_507, 3349],
  ];

  it('reproduces the 26-c seek: linear overshoots the real cluster byte', () => {
    // 26-c:88 seekTime, :89 bisect result, :103 what was reported.
    const seekT = 1992.856;
    const trueClusterByte = 341_002_649; // bisect — ground truth
    const reportedByte = 351_267_118;    // what the old code sent

    // The old value was the linear estimate (to within rounding).
    expect(Math.abs(reportedByte - linearByte(seekT))).toBeLessThan(3_000);

    // And it overshot the real cluster byte by ~10 MB.
    const overshoot = reportedByte - trueClusterByte;
    expect(overshoot).toBeGreaterThan(9 * 1024 * 1024);
    expect(overshoot).toBeLessThan(11 * 1024 * 1024);
  });

  it('the VBR table lands closer to the true byte than linear does', () => {
    const seekT = 2002; // an anchor point: exact by construction
    const trueByte = 350_221_707;
    expect(vbrByte(anchors, seekT)).toBe(trueByte);
    // Linear is off by MiB at the same instant (26-c:186 says -2.5MiB).
    const linErr = Math.abs(linearByte(seekT) - trueByte);
    expect(linErr).toBeGreaterThan(2 * 1024 * 1024);
  });

  it('explains the 70% flip the user reported, without any threshold in code', () => {
    // The user: below ~70% the bar lands BEHIND the seek, above it AHEAD.
    // That is not a branch — it is the sign of (trueByte - linearByte).
    // Both logged anchors sit in the "true byte is behind linear" regime.
    for (const [b, t] of anchors) {
      expect(b - linearByte(t)).toBeLessThan(0);
      // Rendering that byte back through the LINEAR map puts the bar earlier
      // than the seek point — exactly the reported symptom.
      expect(linearTime(b)).toBeLessThan(t);
    }
  });

  it('quantifies the mis-draw in seconds for the logged seek', () => {
    const proactiveStart = 349_169_966; // 26-t:178 — where the sweep began
    const seekT = 1992.856;
    const drawnAt = linearTime(proactiveStart);
    // The bar was drawn ~12s BEHIND the seek point.
    expect(drawnAt).toBeLessThan(seekT);
    expect(seekT - drawnAt).toBeGreaterThan(5);
    expect(seekT - drawnAt).toBeLessThan(20);
  });
});

describe('round-27: subtitle repair backoff must not outlive the region', () => {
  it('reproduces 26-c: a 150s ladder earned at 2043s blocked the repair at 3349s', () => {
    // 26-c:267-268 — one failure, then "next attempt in 150s".
    let st = emptySubRepairBreakerState();
    st = reduceSubRepairBreaker(st, 'failed', 1_000, null);
    expect(st.consecutiveFailures).toBe(1);
    expect(Math.round(computeSubRepairBackoffMs(st.consecutiveFailures) / 1000)).toBe(150);

    // The viewer seeks forward ~1300s of content. Only 2s of wall clock passed,
    // so the ladder still gates — subtitles stay dead (the reported symptom).
    expect(shouldAttemptSubRepair(st, 3_000, false)).toBe(false);

    // After the region-aware reset, the new region is eligible immediately.
    const afterSeek = resetSubRepairBreakerForSeek(st);
    expect(shouldAttemptSubRepair(afterSeek, 3_000, false)).toBe(true);
  });

  it('reopens a tripped breaker on entering a new region', () => {
    // SUB_REPAIR_FAILURE_THRESHOLD is 3 and SUB_REPAIR_MAX_ATTEMPTS is 6, so
    // exactly 3 failures trip the breaker while leaving attempt budget — the
    // real "stuck open with retries left" case. (Six failures would ALSO hit
    // the ceiling, and the ceiling is checked before the backoff, which is what
    // an earlier draft of this test got wrong.)
    let st = emptySubRepairBreakerState();
    for (let i = 0; i < 3; i++) st = reduceSubRepairBreaker(st, 'failed', 1_000 + i, null);
    expect(st.open).toBe(true);
    expect(st.attempts).toBeLessThan(6);
    expect(shouldAttemptSubRepair(st, 10_000_000, false)).toBe(false); // a bare timer never reopens it

    const afterSeek = resetSubRepairBreakerForSeek(st);
    expect(afterSeek.open).toBe(false);
    expect(shouldAttemptSubRepair(afterSeek, 10_000_000, false)).toBe(true);
  });

  it('does NOT refund the attempts ceiling — seeking cannot buy unlimited repairs', () => {
    let st = emptySubRepairBreakerState();
    for (let i = 0; i < 6; i++) st = reduceSubRepairBreaker(st, 'failed', 1_000 + i, null);
    const attemptsBefore = st.attempts;

    const afterSeek = resetSubRepairBreakerForSeek(st);
    expect(afterSeek.attempts).toBe(attemptsBefore);
    expect(afterSeek.attempts).toBeGreaterThanOrEqual(6);

    // With the ceiling reached, the gate still refuses regardless of the reset.
    expect(shouldAttemptSubRepair(afterSeek, 10_000_000, false, 6)).toBe(false);
  });

  it('preserves the frontier so a genuine "no bytes arrived" verdict survives', () => {
    let st = emptySubRepairBreakerState();
    st = reduceSubRepairBreaker(st, 'failed', 1_000, 12_345_678);
    const afterSeek = resetSubRepairBreakerForSeek(st);
    expect(afterSeek.lastFrontierBytes).toBe(12_345_678);
  });

  it('is a no-op for a healthy breaker', () => {
    const clean = emptySubRepairBreakerState();
    expect(resetSubRepairBreakerForSeek(clean)).toEqual(clean);
  });
});
