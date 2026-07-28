import { describe, it, expect } from 'vitest';
import {
  pushSample,
  computeWindowSpeed,
  speedMeterValue,
  formatSpeed,
  SPEED_WINDOW_MS,
  SPEED_STALL_MS,
  type SpeedSample,
} from '../lib/faststream/speedMeter';

/**
 * Speed meter — backend cumulative counter, windowed rate.
 *
 * The meter samples StreamCacheManager's session_downloaded_bytes (bytes that
 * actually arrived from Telegram — disk-cache HITs never touch it) every 500ms
 * and computes speed as a cumulative diff over a 3s sliding window:
 *   speed = (bytes_last − bytes_first) / (t_last − t_first)
 * This is exact under polling jitter (no per-interval delta summation, which
 * had a systematic N/(N−1) inflation: +10% steady, +100% on first reading).
 * A hard zero applies after 3s without counter growth ("you're getting
 * nothing" honesty), plus a sub-500 B/s noise floor.
 */

const MB = 1_000_000;

/** Simulate polling a counter function every 500ms for `seconds`. */
function run(counterFn: (tMs: number) => number, seconds: number): { t: number; v: number }[] {
  const samples: SpeedSample[] = [];
  const out: { t: number; v: number }[] = [];
  for (let t = 500; t <= seconds * 1000; t += 500) {
    pushSample(samples, t, counterFn(t));
    out.push({ t: t / 1000, v: computeWindowSpeed(samples, t) });
  }
  return out;
}

describe('computeWindowSpeed — window arithmetic (defect 3 regression)', () => {
  it('reports exactly 1.000 MB/s for a constant 1 MB/s counter (was +10%)', () => {
    const out = run((t) => (t / 1000) * MB, 20);
    expect(out[out.length - 1].v).toBeCloseTo(MB, 0);
  });

  it('never spikes above the true rate at startup (was +100% first reading)', () => {
    const out = run((t) => (t / 1000) * MB, 20);
    const max = Math.max(...out.map((o) => o.v));
    expect(max).toBeLessThanOrEqual(MB + 1);
  });

  it('produces a live reading within 1.5s of the first bytes', () => {
    const out = run((t) => (t / 1000) * MB, 5);
    expect(out.some((o) => o.t <= 1.5 && o.v > 0)).toBe(true);
  });

  it('tracks a bursty 512KB-chunk arrival pattern within 8% (was +50%)', () => {
    const chunk = 512 * 1024;
    const out = run((t) => Math.floor(t / 700) * chunk, 20);
    const trueRate = chunk / 0.7;
    const last = out[out.length - 1].v;
    expect(Math.abs(last - trueRate) / trueRate).toBeLessThan(0.08);
  });
});

describe('computeWindowSpeed — stall decay (defect 1 regression)', () => {
  it('drops to 0 within 3.5s of a network stall (was frozen forever)', () => {
    const out = run((t) => (Math.min(t, 10_000) / 1000) * MB, 20);
    // ~1 MB/s just before the stall…
    const before = out.find((o) => o.t === 9.5)!;
    expect(before.v).toBeCloseTo(MB, 0);
    // …and hard 0 from 13.5s on (stall at 10s + 3s stall window + slack)
    for (const o of out) {
      if (o.t >= 13.5) expect(o.v).toBe(0);
    }
  });

  it('shows 0 for a flat counter — fully cached replay (defect 2 regression)', () => {
    const out = run(() => 0, 10);
    for (const o of out) expect(o.v).toBe(0);
  });
});

describe('pushSample — reset guard', () => {
  it('recovers cleanly when the counter drops (cache deleted mid-session)', () => {
    const out = run((t) => (t <= 8000 ? (t / 1000) * MB : ((t - 8000) / 1000) * MB), 16);
    for (const o of out) expect(o.v).toBeGreaterThanOrEqual(0);
    expect(out[out.length - 1].v).toBeCloseTo(MB, 0);
  });

  it('trims samples older than the window', () => {
    const samples: SpeedSample[] = [];
    for (let t = 500; t <= 10_000; t += 500) pushSample(samples, t, t);
    expect(samples[0].t).toBeGreaterThanOrEqual(10_000 - SPEED_WINDOW_MS);
  });
});

describe('computeWindowSpeed — noise floor & minimums', () => {
  it('returns 0 with fewer than 2 samples', () => {
    const samples: SpeedSample[] = [];
    pushSample(samples, 500, 1000);
    expect(computeWindowSpeed(samples, 500)).toBe(0);
  });

  it('suppresses sub-500 B/s readings (noise floor)', () => {
    // 100 B/s: real but meaningless — show 0 instead of flicker
    const out = run((t) => (t / 1000) * 100, 10);
    for (const o of out) expect(o.v).toBe(0);
  });

  it('exports sane constants', () => {
    expect(SPEED_WINDOW_MS).toBe(3000);
    expect(SPEED_STALL_MS).toBe(3000);
  });
});

describe('speedMeterValue — "paused means paused"', () => {
  it('returns 0 when prefetch is paused, regardless of in-flight bytes', () => {
    expect(speedMeterValue(2 * MB, true)).toBe(0);
  });

  it('passes the speed through when not paused', () => {
    expect(speedMeterValue(2 * MB, false)).toBe(2 * MB);
  });

  it('returns 0 for idle', () => {
    expect(speedMeterValue(0, false)).toBe(0);
  });
});

describe('formatSpeed — display units', () => {
  it('formats B/s, KB/s, MB/s at the right boundaries', () => {
    expect(formatSpeed(512)).toBe('512 B/s');
    expect(formatSpeed(2048)).toBe('2.0 KB/s');
    expect(formatSpeed(1024 * 1024 * 1.5)).toBe('1.5 MB/s');
  });
});
