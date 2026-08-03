import { describe, it, expect } from 'vitest';
import {
  scanForMkvClusterInWindow,
  scanForLastMkvClusterAtOrBefore,
  pickBisectProbe,
  stepBisectBracket,
  bisectShouldStop,
  injectMkvClusterPosition,
  findClusterCacheEntryNear,
} from '../hooks/useThumbnailExtractor';

/**
 * Round-3 Fix C (reports/round3-solution.md): cue-less MKV far-hover bisection.
 * Pure helpers: window scanner (find + VALIDATE a Cluster element, read its 0xE7
 * Timestamp) and clusterPositionCache injection (sorted splice mirroring vendored
 * matroska-demuxer insert semantics; guarded reach-in, degrade on shape drift).
 *
 * Fixture bytes are handcrafted EBML:
 *  - Cluster ID 1F 43 B6 75 (4-byte ID, stored as-is)
 *  - size vint: leading-zero length coding (0x80|n = 1-byte size n; 01FF..FF = unknown)
 *  - children: CRC-32 [BF 84 ..], Timestamp [E7 8n <be-uint>], SimpleBlock [A3 ..]
 */

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];

function tsElement(ticks: number, bytes: number = 2): number[] {
  const out = [0xe7, 0x80 | bytes];
  for (let i = bytes - 1; i >= 0; i--) out.push((ticks >> (8 * i)) & 0xff);
  return out;
}

function crcElement(): number[] {
  return [0xbf, 0x84, 0xaa, 0xbb, 0xcc, 0xdd];
}

function simpleBlock(payloadLen: number): number[] {
  return [0xa3, 0x80 | payloadLen, ...new Array(payloadLen).fill(0x11)];
}

function cluster(children: number[][], sizeBytes?: number[]): number[] {
  const body = children.flat();
  const size = sizeBytes ?? [0x80 | body.length]; // 1-byte defined size by default
  return [...CLUSTER_ID, ...size, ...body];
}

describe('scanForMkvClusterInWindow', () => {
  it('finds a cluster with CRC before Timestamp (child-walk, R11)', () => {
    const clu = cluster([crcElement(), tsElement(5000), simpleBlock(4)]);
    const buf = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, ...clu]);
    const hit = scanForMkvClusterInWindow(buf, 1000, 0, 10000, 0);
    expect(hit).toEqual({ elementStartPos: 1007, timestampTicks: 5000 });
  });

  it('rejects a false-positive ID (bad child) and finds the later real cluster', () => {
    const fake = [...CLUSTER_ID, 0x81, 0xff]; // size=1, child id 0xFF ∉ valid set
    const real = cluster([tsElement(7000)]);
    const buf = new Uint8Array([...fake, 0x00, ...real]);
    const hit = scanForMkvClusterInWindow(buf, 0, 0, 10000, 0);
    expect(hit).toEqual({ elementStartPos: fake.length + 1, timestampTicks: 7000 });
  });

  it('accepts unknown-size clusters (01 FF.. vlen)', () => {
    const clu = cluster([tsElement(1234)], [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const buf = new Uint8Array(clu);
    const hit = scanForMkvClusterInWindow(buf, 50, 0, 10000, 0);
    expect(hit).toEqual({ elementStartPos: 50, timestampTicks: 1234 });
  });

  it('rejects ticks outside the bisection bracket (+slack)', () => {
    const clu = cluster([tsElement(50000)]);
    const buf = new Uint8Array(clu);
    expect(scanForMkvClusterInWindow(buf, 0, 0, 10000, 1000)).toBeNull();
    // Same cluster passes with a bracket that includes it.
    expect(scanForMkvClusterInWindow(buf, 0, 45000, 55000, 0)).toEqual({
      elementStartPos: 0, timestampTicks: 50000,
    });
  });

  it('returns null when the window holds no cluster', () => {
    const buf = new Uint8Array(4096).fill(0x42);
    expect(scanForMkvClusterInWindow(buf, 0, 0, 10000, 0)).toBeNull();
  });
});

function fakeTrack(cache: Array<{ elementStartPos: number; startTimestamp: number }> | null) {
  return { _backing: { internalTrack: cache ? { clusterPositionCache: cache } : {} } };
}

describe('injectMkvClusterPosition', () => {
  it('sorted-splices into the middle and dedups by elementStartPos', () => {
    const cache = [
      { elementStartPos: 100, startTimestamp: 0 },
      { elementStartPos: 900, startTimestamp: 9000 },
    ];
    const track = fakeTrack(cache);
    expect(injectMkvClusterPosition(track, { elementStartPos: 500, startTimestamp: 5000 })).toBe(true);
    expect(cache.map((e) => e.startTimestamp)).toEqual([0, 5000, 9000]);
    // Same byte again → no duplicate.
    expect(injectMkvClusterPosition(track, { elementStartPos: 500, startTimestamp: 5000 })).toBe(true);
    expect(cache.length).toBe(3);
  });

  it('inserts at the head when earlier than everything', () => {
    const cache = [{ elementStartPos: 900, startTimestamp: 9000 }];
    expect(injectMkvClusterPosition(fakeTrack(cache), { elementStartPos: 10, startTimestamp: 100 })).toBe(true);
    expect(cache.map((e) => e.startTimestamp)).toEqual([100, 9000]);
  });

  it('degrades to false on shape drift (no clusterPositionCache)', () => {
    expect(injectMkvClusterPosition(fakeTrack(null), { elementStartPos: 1, startTimestamp: 1 })).toBe(false);
    expect(injectMkvClusterPosition(undefined, { elementStartPos: 1, startTimestamp: 1 })).toBe(false);
  });
});

describe('findClusterCacheEntryNear (R10 consult-before-bisect)', () => {
  const cache = [
    { elementStartPos: 100, startTimestamp: 0 },
    { elementStartPos: 500, startTimestamp: 5000 },
    { elementStartPos: 900, startTimestamp: 9000 },
  ];

  it('returns the at-or-before entry within the window', () => {
    expect(findClusterCacheEntryNear(fakeTrack(cache), 5100, 200)).toEqual({
      elementStartPos: 500, startTimestamp: 5000,
    });
  });

  it('null when the nearest at-or-before entry is too far behind', () => {
    expect(findClusterCacheEntryNear(fakeTrack(cache), 8000, 200)).toBeNull();
  });

  it('null on empty/drifted cache', () => {
    expect(findClusterCacheEntryNear(fakeTrack([]), 100, 200)).toBeNull();
    expect(findClusterCacheEntryNear(fakeTrack(null), 100, 200)).toBeNull();
  });
});

/**
 * Round-4 (4-c.md:463 — 30MB/33.9s for one bisection): probe-count optimizations.
 * pickBisectProbe: interpolation search — MKV byte↔time is near-linear (measured:
 * hover 35.87% of duration lived at 35.06% of the file), so seeding probes from
 * the (byte,ticks) bracket endpoints collapses 17 halving probes to ~2-4.
 * scanForLastMkvClusterAtOrBefore: in-buffer forward advance — one fetched window
 * often holds several clusters; take the LAST ≤ target instead of re-fetching
 * overlapping windows to creep forward (the log's last 6 probes re-downloaded an
 * already-fetched 1.5MB bracket).
 */
describe('pickBisectProbe (interpolation search)', () => {
  it('interpolates linearly between bracket endpoints', () => {
    // ticks 0..10000 over bytes 0..1_000_000, target 3500 → ~350_000
    const p = pickBisectProbe(0, 1_000_000, 0, 10_000, 3_500);
    expect(p).toBeGreaterThan(300_000);
    expect(p).toBeLessThan(400_000);
  });

  it('clamps the interpolation fraction away from the endpoints', () => {
    // target at 0.1% of the tick range must still probe ≥2% into the bracket
    expect(pickBisectProbe(0, 1_000_000, 0, 10_000, 10)).toBeGreaterThanOrEqual(20_000);
    // target at 99.9% must stay ≤98%
    expect(pickBisectProbe(0, 1_000_000, 0, 10_000, 9_990)).toBeLessThanOrEqual(980_000);
  });

  it('falls back to the midpoint without tick endpoints', () => {
    expect(pickBisectProbe(0, 1_000_000, null, null, 3_500)).toBe(500_000);
    expect(pickBisectProbe(0, 1_000_000, 0, null, 3_500)).toBe(500_000);
    expect(pickBisectProbe(0, 1_000_000, 5_000, 5_000, 5_500)).toBe(500_000); // degenerate
  });

  it('always lands strictly inside (lo, hi)', () => {
    const p = pickBisectProbe(100, 200, 0, 1, 0);
    expect(p).toBeGreaterThan(100);
    expect(p).toBeLessThan(200);
  });
});

describe('scanForLastMkvClusterAtOrBefore (in-buffer advance)', () => {
  it('returns the LAST cluster ≤ target, not the first', () => {
    const c1 = cluster([tsElement(1000)]);
    const c2 = cluster([tsElement(2000)]);
    const c3 = cluster([tsElement(3000)]);
    const buf = new Uint8Array([...c1, ...c2, ...c3]);
    const hit = scanForLastMkvClusterAtOrBefore(buf, 500, 2500);
    expect(hit).toEqual({ elementStartPos: 500 + c1.length, timestampTicks: 2000 });
  });

  it('all clusters ≤ target → the final one wins', () => {
    const c1 = cluster([tsElement(1000)]);
    const c2 = cluster([tsElement(3000)]);
    const buf = new Uint8Array([...c1, ...c2]);
    expect(scanForLastMkvClusterAtOrBefore(buf, 0, 5000)).toEqual({
      elementStartPos: c1.length, timestampTicks: 3000,
    });
  });

  it('none ≤ target → null (clusters exist but are all above)', () => {
    const buf = new Uint8Array(cluster([tsElement(9000)]));
    expect(scanForLastMkvClusterAtOrBefore(buf, 0, 5000)).toBeNull();
  });

  it('empty/garbage buffer → null', () => {
    expect(scanForLastMkvClusterAtOrBefore(new Uint8Array(1024).fill(0x42), 0, 5000)).toBeNull();
  });
});

/**
 * Round-5 (5-t.md:301-330 — 16 IDENTICAL 2MB re-fetches of 715751078-717848229):
 * the round-4 'above' branch set hi = max(lo+1, any.elementStartPos), but `any`
 * is found INSIDE the window starting at mid, so any.elementStartPos ≥ mid ≥ hi's
 * previous shrink floor — the bracket never moved and interpolation returned the
 * same probe byte until the iteration cap. The pure bracket step must shrink hi
 * to MID on an above-target outcome (the window proved no ≤-target cluster in
 * [mid, windowEnd]). And once best + the next above-target cluster bracket a gap
 * ≤ one acceptable walk, further probing is pure waste (the gap is one monster
 * cluster's interior; the capture walk reads those bytes anyway) — stop.
 */
describe('stepBisectBracket (round-5 spin fix)', () => {
  it('above outcome shrinks hi to MID, not to the found cluster byte', () => {
    const br = { lo: 703792420, hi: 716375330, loTicks: 4018639, hiTicks: 4057383 };
    const mid = pickBisectProbe(br.lo, br.hi, br.loTicks, br.hiTicks, 4055461);
    expect(mid).toBeLessThan(br.hi); // sanity: probe strictly inside
    stepBisectBracket(br, mid, { kind: 'above', byte: 716375330, ticks: 4057383 });
    expect(br.hi).toBe(mid);          // shrunk to mid — NOT the old static 716375330
    expect(br.hiTicks).toBe(4057383);
  });

  it('repeated above outcomes strictly shrink the bracket (no spin)', () => {
    const br = { lo: 703792420, hi: 716375330, loTicks: 4018639, hiTicks: 4057383 };
    let prevHi = br.hi;
    for (let i = 0; i < 6; i++) {
      const mid = pickBisectProbe(br.lo, br.hi, br.loTicks, br.hiTicks, 4055461);
      stepBisectBracket(br, mid, { kind: 'above', byte: 716375330, ticks: 4057383 });
      expect(br.hi).toBeLessThan(prevHi);
      prevHi = br.hi;
    }
  });

  it('below outcome advances lo past the found cluster', () => {
    const br = { lo: 0, hi: 1_000_000, loTicks: 0, hiTicks: 10_000 };
    stepBisectBracket(br, 500_000, { kind: 'below', byte: 600_000, ticks: 5_000 });
    expect(br.lo).toBe(600_001);
    expect(br.loTicks).toBe(5_000);
  });

  it('above outcome never collapses hi at/below lo', () => {
    const br = { lo: 100, hi: 200, loTicks: 0, hiTicks: 10 };
    stepBisectBracket(br, 100, { kind: 'above', byte: 150, ticks: 8 });
    expect(br.hi).toBeGreaterThan(br.lo);
  });
});

describe('bisectShouldStop (walkable-gap terminal rule)', () => {
  it('stops when best and the next above-target cluster bracket a walkable gap', () => {
    // Round-5 numbers: best@703792419, next@716375330 → 12.58MB ≤ 16MB cap.
    expect(bisectShouldStop(703792419, 716375330, 16 * 1024 * 1024)).toBe(true);
  });

  it('keeps probing while the gap exceeds the cap', () => {
    expect(bisectShouldStop(0, 32 * 1024 * 1024, 16 * 1024 * 1024)).toBe(false);
  });

  it('never stops without both endpoints', () => {
    expect(bisectShouldStop(null, 716375330, 16 * 1024 * 1024)).toBe(false);
    expect(bisectShouldStop(703792419, null, 16 * 1024 * 1024)).toBe(false);
  });
});
