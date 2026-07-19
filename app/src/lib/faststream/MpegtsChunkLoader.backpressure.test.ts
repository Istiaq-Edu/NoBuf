import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createChunkedFetchLoader } from './MpegtsChunkLoader';

// Minimal fake mpegts module: the loader only needs BaseLoader (a base class),
// LoaderStatus/LoaderErrors enums, and is otherwise self-contained.
function makeFakeMpegts() {
  class BaseLoader {
    _needStash = false;
    needStashBuffer = false;
    constructor(_type: string) {}
    isWorking() { return false; }
    destroy() {}
  }
  return {
    BaseLoader,
    LoaderStatus: { kIdle: 0, kConnecting: 1, kBuffering: 2, kComplete: 3, kError: 4 },
    LoaderErrors: { EXCEPTION: 'Exception' },
  };
}

// Access the private _awaitBackpressure via an instance. We drive the loop with
// a controllable "ahead" value and vitest fake timers, asserting the gate opens
// and closes at the configured thresholds (60s max, 15s hysteresis → resume 45s).
function makeLoader(aheadSeq: number[], overrides: Record<string, any> = {}) {
  const mpegts = makeFakeMpegts();
  const LoaderClass = createChunkedFetchLoader(mpegts);
  let idx = 0;
  const cfg = {
    getBufferedAheadSeconds: () => aheadSeq[Math.min(idx, aheadSeq.length - 1)],
    pipeBackpressureMaxAhead: 60,
    pipeBackpressureHysteresis: 15,
    ...overrides,
  };
  const loader: any = new LoaderClass(null, cfg);
  const advance = () => { idx = Math.min(idx + 1, aheadSeq.length - 1); };
  return { loader, advance };
}

describe('MpegtsChunkLoader pipe backpressure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).window = (globalThis as any).window || {};
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not throttle when no callback is configured (byte-seekable /stream player)', async () => {
    const mpegts = makeFakeMpegts();
    const LoaderClass = createChunkedFetchLoader(mpegts);
    const loader: any = new LoaderClass(null, {}); // no getBufferedAheadSeconds
    // Should resolve immediately without touching timers.
    await expect(loader._awaitBackpressure(loader._pumpGen)).resolves.toBeUndefined();
  });

  it('returns immediately when ahead <= max (below throttle threshold)', async () => {
    const { loader } = makeLoader([30]); // 30s < 60s
    await expect(loader._awaitBackpressure(loader._pumpGen)).resolves.toBeUndefined();
  });

  it('returns immediately when ahead is 0 (pre-align warmup, playhead not in a range)', async () => {
    const { loader } = makeLoader([0]);
    await expect(loader._awaitBackpressure(loader._pumpGen)).resolves.toBeUndefined();
  });

  it('throttles above max and resumes once drained to (max - hysteresis)', async () => {
    // Buffer at 80s → throttle. Stays 80 for two ticks, then drains below 45s.
    const ahead = [80, 80, 80, 44];
    let idx = 0;
    const { loader } = makeLoader([80], {
      getBufferedAheadSeconds: () => ahead[Math.min(idx, ahead.length - 1)],
    });
    let resolved = false;
    const p = loader._awaitBackpressure(loader._pumpGen).then(() => { resolved = true; });

    // First check: 80 > 60 → enters wait loop. Still 80 → keeps waiting.
    await vi.advanceTimersByTimeAsync(250); idx = 1;
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(250); idx = 2;
    expect(resolved).toBe(false);
    // Now drains to 44 (< resumeAt 45) → loop exits.
    await vi.advanceTimersByTimeAsync(250); idx = 3;
    await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(resolved).toBe(true);
  });

  it('keeps throttling while still above resume threshold (46s > 45s resumeAt)', async () => {
    const ahead = [70, 46, 46];
    let idx = 0;
    const { loader } = makeLoader([70], {
      getBufferedAheadSeconds: () => ahead[Math.min(idx, ahead.length - 1)],
    });
    let resolved = false;
    loader._awaitBackpressure(loader._pumpGen).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(250); idx = 1; // 46 still > 45
    await vi.advanceTimersByTimeAsync(250); idx = 2;
    expect(resolved).toBe(false); // 46 > 45 → still throttled
  });

  it('bails out of the wait loop when the pump generation is superseded', async () => {
    const { loader } = makeLoader([90, 90, 90]);
    let resolved = false;
    const p = loader._awaitBackpressure(loader._pumpGen).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(250);
    expect(resolved).toBe(false);
    // Simulate the player being recreated: bump the generation.
    loader._pumpGen++;
    await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(resolved).toBe(true); // exited despite ahead still 90 (stale pump)
  });

  it('bails out of the wait loop on abort request', async () => {
    const { loader } = makeLoader([90, 90]);
    let resolved = false;
    const p = loader._awaitBackpressure(loader._pumpGen).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(250);
    loader._requestAbort = true;
    await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(resolved).toBe(true);
  });
});
