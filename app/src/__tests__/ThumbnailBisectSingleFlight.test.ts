import { describe, expect, it, vi } from 'vitest';
import {
  decideThumbnailBisectAction,
  shouldStartThumbnailFallback,
  startSingleThumbnailBisect,
  type ThumbnailBisectMemoEntry,
} from '../hooks/useThumbnailExtractor';

describe('startSingleThumbnailBisect', () => {
  it('shares one operation for concurrent requests in the same bucket', async () => {
    const memo = new Map<number, ThumbnailBisectMemoEntry>();
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const operation = vi.fn(() => pending);

    const first = startSingleThumbnailBisect(memo, 5500, 10, operation);
    const second = startSingleThumbnailBisect(memo, 5500, 11, operation);

    expect(second).toBe(first);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(memo.get(5500)?.state).toBe('inflight');
    resolve();
    await first;
  });

  it('allows fallback after the previous operation settled as failed', async () => {
    const memo = new Map<number, ThumbnailBisectMemoEntry>([[5500, { state: 'failed', at: 10 }]]);
    const operation = vi.fn(async () => { memo.set(5500, { state: 'done', at: 20 }); });

    await startSingleThumbnailBisect(memo, 5500, 20, operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(memo.get(5500)?.state).toBe('done');
  });

  it('does not couple independent hover buckets', async () => {
    const memo = new Map<number, ThumbnailBisectMemoEntry>();
    const operationA = vi.fn(async () => undefined);
    const operationB = vi.fn(async () => undefined);

    await Promise.all([
      startSingleThumbnailBisect(memo, 5500, 10, operationA),
      startSingleThumbnailBisect(memo, 5510, 10, operationB),
    ]);

    expect(operationA).toHaveBeenCalledTimes(1);
    expect(operationB).toHaveBeenCalledTimes(1);
  });
});

describe('shouldStartThumbnailFallback', () => {
  it('allows the fallback once after the primary bisection', () => {
    expect(shouldStartThumbnailFallback({ state: 'done', at: 10 })).toBe(true);
  });

  it('does not rearm after a completed fallback still yields no keyframe', () => {
    expect(shouldStartThumbnailFallback({
      state: 'done', at: 20, fallbackAttempted: true,
    })).toBe(false);
  });

  it('keeps a failed fallback bucket from relaunching immediately', () => {
    expect(shouldStartThumbnailFallback({
      state: 'failed', at: 20, fallbackAttempted: true,
    })).toBe(false);
  });
});

describe('decideThumbnailBisectAction', () => {
  it('honors failed cooldown even when an injected near entry remains', () => {
    expect(decideThumbnailBisectAction(
      { state: 'failed', at: 1_000, fallbackAttempted: true }, true, 2_000,
    )).toBe('cooldown');
  });

  it('honors cooldown after a completed fallback still yields no keyframe', () => {
    expect(decideThumbnailBisectAction(
      { state: 'done', at: 1_000, fallbackAttempted: true }, true, 2_000,
    )).toBe('cooldown');
  });

  it('captures from a healthy near entry', () => {
    expect(decideThumbnailBisectAction(undefined, true, 2_000)).toBe('capture');
  });

  it('retries a failed bucket only after cooldown', () => {
    expect(decideThumbnailBisectAction(
      { state: 'failed', at: 1_000 }, false, 61_001,
    )).toBe('start');
  });
});
