import { describe, it, expect } from 'vitest';
import {
  scanForMkvClusterInWindow,
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
