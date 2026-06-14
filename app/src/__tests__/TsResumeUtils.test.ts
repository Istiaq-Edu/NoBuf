import { describe, it, expect, vi } from 'vitest';
import { StreamShadowCache } from '../lib/faststream/StreamShadowCache';
import { alignToTSSyncByte, computeResumeByte, findByteForTime, findBitrateForTime, ByteTimeSample } from '../hooks/useMSEPlayer';

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

describe('findByteForTime', () => {
  // Simulate a VBR file: first half is low bitrate (1 Mbps), second half is high bitrate (4 Mbps).
  // Duration 2000s, fileLength 1_000_000_000 bytes.
  const samples: ByteTimeSample[] = [
    { time: 100, byte: 50_000_000 },   // 1 Mbps region
    { time: 500, byte: 250_000_000 },    // 1 Mbps region
    { time: 1000, byte: 500_000_000 },   // 1 Mbps region (up to 1 Gbps? no, 1 Mbps)
    { time: 1500, byte: 750_000_000 },   // 4 Mbps region
    { time: 1900, byte: 950_000_000 },   // 4 Mbps region
  ];

  it('interpolates between observed samples', () => {
    // At 300s, we are between 100s/50MB and 500s/250MB. Local bitrate = 200MB/400s = 500KB/s.
    const byte = findByteForTime(300, samples, duration, fileLength);
    const expected = 50_000_000 + (300 - 100) * 500_000;
    expect(byte).toBe(Math.floor(expected));
  });

  it('uses local bitrate instead of wrong global average for VBR', () => {
    const vbrSamples: ByteTimeSample[] = [
      { time: 100, byte: 10_000_000 },   // 100 KB/s
      { time: 500, byte: 50_000_000 },    // 100 KB/s
      { time: 1000, byte: 300_000_000 },  // 500 KB/s
      { time: 1500, byte: 800_000_000 },  // 1 MB/s
    ];
    // At 1200s, global average would give 600MB, but local (between 1000s/300MB and 1500s/800MB) is 500KB/s -> 500MB.
    const byte = findByteForTime(1200, vbrSamples, duration, fileLength);
    expect(byte).toBe(500_000_000);
  });

  it('falls back to linear mapping when not enough samples', () => {
    const byte = findByteForTime(500, [], duration, fileLength);
    const expected = Math.floor((500 / duration) * fileLength);
    expect(byte).toBe(expected);
  });

  it('returns 0 for targetTime <= 0', () => {
    expect(findByteForTime(0, samples, duration, fileLength)).toBe(0);
    expect(findByteForTime(-10, samples, duration, fileLength)).toBe(0);
  });
});

describe('findBitrateForTime', () => {
  it('uses the median bitrate of recent samples', () => {
    const samples: ByteTimeSample[] = [
      { time: 0, byte: 0, bitrate: 1_000_000 },
      { time: 100, byte: 100_000_000, bitrate: 1_000_000 },
      { time: 200, byte: 300_000_000, bitrate: 2_000_000 },
      { time: 300, byte: 500_000_000, bitrate: 2_000_000 },
      { time: 400, byte: 600_000_000, bitrate: 1_000_000 },
      { time: 500, byte: 700_000_000, bitrate: 2_000_000 },
    ];
    // Recent 5 bitrates: [1_000_000, 2_000_000, 2_000_000, 1_000_000, 2_000_000]
    // sorted -> [1_000_000, 1_000_000, 2_000_000, 2_000_000, 2_000_000], median = 2_000_000
    expect(findBitrateForTime(samples, duration, fileLength)).toBe(2_000_000);
  });

  it('computes bitrate from last two samples when bitrate field is missing', () => {
    const samples: ByteTimeSample[] = [
      { time: 0, byte: 0 },
      { time: 100, byte: 100_000_000 },
    ];
    // 100MB / 100s = 1MB/s
    expect(findBitrateForTime(samples, duration, fileLength)).toBe(1_000_000);
  });

  it('falls back to global average bitrate when not enough samples', () => {
    const bitrate = findBitrateForTime([], duration, fileLength);
    expect(bitrate).toBe(fileLength / duration);
  });

  it('returns 0 fallback when no duration/fileLength provided', () => {
    expect(findBitrateForTime([], 0, 0)).toBe(0);
  });
});
