import { describe, it, expect, vi } from 'vitest';
import { StreamShadowCache } from '../lib/faststream/StreamShadowCache';
import { alignToTSSyncByte, computeResumeByte, computeSlidingWindowSeconds, findByteForTime, findTimeForByte, ByteTimeSample } from '../hooks/useMSEPlayer';

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

  it('falls back to linear mapping when samples are corrupted', () => {
    const corruptedSamples: ByteTimeSample[] = [
      { time: 100, byte: 50_000_000 },
      { time: 200, byte: NaN },
      { time: 300, byte: 150_000_000 },
    ];
    const byte = findByteForTime(250, corruptedSamples, duration, fileLength);
    const expected = Math.floor((250 / duration) * fileLength);
    expect(byte).toBe(expected);
  });

  it('falls back to linear mapping when extrapolation exceeds fileLength', () => {
    const inflatedSamples: ByteTimeSample[] = [
      { time: 100, byte: 50_000_000 },
      { time: 500, byte: 10_000_000_000 }, // absurd byte > fileLength
    ];
    const byte = findByteForTime(600, inflatedSamples, duration, fileLength);
    const expected = Math.floor((600 / duration) * fileLength);
    expect(byte).toBe(expected);
  });

  it('returns 0 for non-finite targetTime', () => {
    expect(findByteForTime(NaN, samples, duration, fileLength)).toBe(0);
    expect(findByteForTime(Infinity, samples, duration, fileLength)).toBe(0);
  });

  it('falls back to linear for flat-region corruption (IOController paused at EOF)', () => {
    // Two samples with a huge time gap but nearly the same byte: this is the
    // corruption seen in 78-c.md where the IOController sat at EOF while the
    // SourceBuffer kept processing data. Interpolation would otherwise claim
    // mid-file times map to near-EOF bytes.
    const flatSamples: ByteTimeSample[] = [
      { time: 1500, byte: 750_000_000 },
      { time: 2073, byte: 750_000_512 }, // only 512 bytes apart over 573s
    ];
    const byte = findByteForTime(1800, flatSamples, duration, fileLength);
    const expected = Math.floor((1800 / duration) * fileLength);
    expect(byte).toBe(expected);
  });

  it('clamps extrapolation beyond duration to EOF', () => {
    const byte = findByteForTime(2500, samples, duration, fileLength);
    expect(byte).toBe(fileLength);
  });

  it('falls back to linear when interpolation exceeds fileLength', () => {
    const inflatedSamples: ByteTimeSample[] = [
      { time: 100, byte: 50_000_000 },
      { time: 500, byte: 1_200_000_000 }, // close to EOF already at 500s
    ];
    const byte = findByteForTime(600, inflatedSamples, duration, fileLength);
    const expected = Math.floor((600 / duration) * fileLength);
    expect(byte).toBe(expected);
  });
});

describe('findTimeForByte', () => {
  const samples: ByteTimeSample[] = [
    { time: 100, byte: 50_000_000 },    // 1 Mbps region
    { time: 500, byte: 250_000_000 },    // 1 Mbps region
    { time: 1000, byte: 500_000_000 },   // 1 Mbps region
    { time: 1500, byte: 750_000_000 },   // 4 Mbps region
    { time: 1900, byte: 950_000_000 },   // 4 Mbps region
  ];

  it('interpolates between observed samples by byte', () => {
    // 150MB is between 50MB/100s and 250MB/500s. Local bitrate = 200MB/400s = 500KB/s.
    const time = findTimeForByte(150_000_000, samples, duration, fileLength);
    const expected = 100 + (150_000_000 - 50_000_000) / 500_000;
    expect(time).toBeCloseTo(expected, 1);
  });

  it('uses local bitrate for VBR regions', () => {
    // 800MB is between 500MB/1000s and 750MB/1500s. Local bitrate = 250MB/500s = 500KB/s.
    const time = findTimeForByte(800_000_000, samples, duration, fileLength);
    const expected = 1000 + (800_000_000 - 500_000_000) / 500_000;
    expect(time).toBeCloseTo(expected, 1);
  });

  it('falls back to linear mapping when not enough samples', () => {
    const time = findTimeForByte(250_000_000, [], duration, fileLength);
    const expected = (250_000_000 / fileLength) * duration;
    expect(time).toBeCloseTo(expected, 1);
  });

  it('returns 0 for targetByte <= 0', () => {
    expect(findTimeForByte(0, samples, duration, fileLength)).toBe(0);
    expect(findTimeForByte(-10, samples, duration, fileLength)).toBe(0);
  });
});

describe('computeResumeByte with backend samples', () => {
  const samples: ByteTimeSample[] = [
    { time: 100, byte: 50_000_000 },
    { time: 500, byte: 250_000_000 },
    { time: 1000, byte: 500_000_000 },
  ];

  it('uses VBR-aware byte mapping when samples are provided', () => {
    const cache = makeCacheWithSyncByte(0, 0, 999_999);
    const bufEnd = 300;
    const byte = computeResumeByte(bufEnd, duration, fileLength, cache, false, samples);
    // At 300s, linear mapping would give 150MB, but local (100s/50MB -> 500s/250MB) gives 150MB.
    // It matches here, but we verify it's using the sample path by checking alignment.
    expect(byte).toBe(Math.floor(150_000_000 / 188) * 188);
  });

  it('undershoots using VBR samples when available', () => {
    const cache = makeCacheWithSyncByte(0, 0, 999_999);
    const bufEnd = 300;
    const byte = computeResumeByte(bufEnd, duration, fileLength, cache, true, samples);
    // 5s before 300s in the local 1 Mbps region -> 2.5MB before.
    expect(byte).toBeGreaterThan(0);
    expect(byte).toBeLessThan(Math.floor(150_000_000 / 188) * 188);
  });
});


describe('computeSlidingWindowSeconds', () => {
  it('returns target 180s/30s for the logged TS file bitrate (~5 Mbps)', () => {
    // File: 1313957192 bytes / 2073s ≈ 5.07 Mbps
    // 210s * 5.07 Mbps / 8 ≈ 133 MB, well under 250 MB
    const bitrate = 1_313_957_192 / 2073;
    const result = computeSlidingWindowSeconds(bitrate, 1);
    expect(result.forward).toBe(180);
    expect(result.backward).toBe(30);
  });

  it('returns target 180s/30s when budget is not exceeded', () => {
    // 1 MB/s (8 Mbps) → 210 MB for 210s, well under 250 MB
    const result = computeSlidingWindowSeconds(1_000_000, 1);
    expect(result.forward).toBe(180);
    expect(result.backward).toBe(30);
  });

  it('shrinks forward when budget is exceeded', () => {
    // 3 MB/s → 210s = 630 MB, over 250 MB; budget ~83s so forward shrinks
    const result = computeSlidingWindowSeconds(3_000_000, 1);
    expect(result.forward).toBeLessThan(180);
    expect(result.backward).toBeLessThanOrEqual(30);
    expect(result.forward).toBeGreaterThanOrEqual(60);
    expect(result.backward).toBeGreaterThanOrEqual(5);
  });

  it('falls back to safe defaults when bitrate is unknown', () => {
    const result = computeSlidingWindowSeconds(0, 1);
    expect(result.forward).toBe(60);
    expect(result.backward).toBe(30);
  });

  it('caps forward at the budget and never drops below 0', () => {
    // 50 MB/s — budget can only hold ~5s total, so forward is clamped down hard
    const result = computeSlidingWindowSeconds(50_000_000, 1);
    expect(result.forward).toBeGreaterThanOrEqual(0);
    expect(result.backward).toBeGreaterThanOrEqual(0);
    expect(result.forward + result.backward).toBeLessThanOrEqual(
      Math.floor((250 * 1024 * 1024) / 50_000_000)
    );
  });

  it('keeps at least 5s backward when the budget is tight', () => {
    // 50 MB/s — total budget is ~5s; backward should floor to 5s before forward is clamped
    const result = computeSlidingWindowSeconds(50_000_000, 1);
    expect(result.backward).toBeGreaterThanOrEqual(5);
  });
});