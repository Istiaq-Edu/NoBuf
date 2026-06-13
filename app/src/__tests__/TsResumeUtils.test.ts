import { describe, it, expect, vi } from 'vitest';
import { StreamShadowCache } from '../lib/faststream/StreamShadowCache';
import { alignToTSSyncByte, computeResumeByte } from '../hooks/useMSEPlayer';

// Mock Tauri invoke so useMSEPlayer imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

const fileLength = 1_000_000_000;
const duration = 2000;

function makeCacheWithSyncByte(syncByte: number, start: number, end: number): StreamShadowCache {
  const cache = new StreamShadowCache();
  cache.reset('/test', fileLength);
  const data = new Uint8Array(end - start + 1);
  for (let i = 0; i < data.length; i++) {
    const bytePos = start + i;
    // Place 0x47 at every 188-byte boundary inside the range.
    data[i] = (bytePos % 188 === 0) ? 0x47 : 0x00;
  }
  // Overwrite the requested position to the explicit sync byte if needed.
  if (syncByte >= start && syncByte <= end) {
    data[syncByte - start] = 0x47;
  }
  cache.put(start, data);
  return cache;
}

describe('computeResumeByte', () => {
  it('returns the byte corresponding to bufferEnd without undershoot', () => {
    const cache = makeCacheWithSyncByte(0, 0, 999_999);
    const bufEnd = 100;
    const byte = computeResumeByte(bufEnd, duration, fileLength, cache, false);
    const expected = Math.floor((bufEnd / duration) * fileLength / 188) * 188;
    expect(byte).toBe(expected);
  });

  it('undershoots by ~5 seconds when asked', () => {
    const cache = makeCacheWithSyncByte(0, 0, 999_999);
    const bufEnd = 500;
    const byte = computeResumeByte(bufEnd, duration, fileLength, cache, true);
    const bytesPerSecond = fileLength / duration;
    const approx = (bufEnd - 5) * bytesPerSecond;
    expect(byte).toBeGreaterThan(0);
    expect(byte).toBeLessThan(Math.floor((bufEnd / duration) * fileLength));
    expect(Math.abs(byte - Math.floor(approx / 188) * 188)).toBeLessThan(188 * 2);
  });

  it('returns -1 for invalid inputs', () => {
    expect(computeResumeByte(0, duration, fileLength, null, false)).toBe(-1);
    expect(computeResumeByte(100, 0, fileLength, null, false)).toBe(-1);
    expect(computeResumeByte(100, duration, 0, null, false)).toBe(-1);
  });
});

describe('alignToTSSyncByte', () => {
  it('returns a 188-byte boundary', () => {
    const cache = makeCacheWithSyncByte(0, 0, 999_999);
    const aligned = alignToTSSyncByte(123_456, cache);
    expect(aligned % 188).toBe(0);
  });

  it('finds the next 0x47 boundary within the cached range', () => {
    const cache = makeCacheWithSyncByte(188, 0, 999_999);
    // 200 rounds down to 188, which is the first 188-boundary after 0.
    const aligned = alignToTSSyncByte(200, cache);
    expect(aligned).toBe(188);
  });

  it('falls back to 188-aligned position when cache does not cover scan range', () => {
    const cache = new StreamShadowCache();
    cache.reset('/test', fileLength);
    // Cache only has data far before the target.
    cache.put(0, new Uint8Array(1000));
    const aligned = alignToTSSyncByte(500_000, cache);
    expect(aligned % 188).toBe(0);
  });

  it('returns 0 for negative byte positions', () => {
    const cache = makeCacheWithSyncByte(0, 0, 999_999);
    expect(alignToTSSyncByte(-100, cache)).toBe(0);
  });
});
