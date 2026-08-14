// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { subRepairRegionRetryDelay, scheduleSubRepairRegionRetry } from '../components/dashboard/FastStreamPlayer';

describe('subtitle repair region retry delay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('delays progress before reopening the same region', () => {
    expect(subRepairRegionRetryDelay('progress')).toBe(5_000);
    expect(subRepairRegionRetryDelay('progress-uncovered')).toBe(5_000);
  });

  it('retries a deferred region after one second without a video timeupdate', () => {
    expect(subRepairRegionRetryDelay('deferred')).toBe(1_000);
    const attemptedRegions = new Set(['42:1:1200']);
    const timers = new Map<string, number>();
    const retry = vi.fn();
    const currentGeneration = vi.fn(() => 7);
    const currentPlayhead = vi.fn(() => 1234.5);

    scheduleSubRepairRegionRetry({
      regionKey: '42:1:1200',
      delayMs: subRepairRegionRetryDelay('deferred')!,
      generation: 7,
      timers,
      attemptedRegions,
      currentGeneration,
      currentPlayhead,
      retry,
    });

    vi.advanceTimersByTime(999);
    expect(retry).not.toHaveBeenCalled();
    expect(attemptedRegions.has('42:1:1200')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith(1234.5);
    expect(attemptedRegions.has('42:1:1200')).toBe(false);
    expect(timers.has('42:1:1200')).toBe(false);
  });

  it('drops a scheduled retry after a file generation changes', () => {
    let generation = 7;
    const retry = vi.fn();
    const attemptedRegions = new Set(['42:1:1200']);
    scheduleSubRepairRegionRetry({
      regionKey: '42:1:1200',
      delayMs: 1_000,
      generation,
      timers: new Map(),
      attemptedRegions,
      currentGeneration: () => generation,
      currentPlayhead: () => 1234.5,
      retry,
    });

    generation = 8;
    vi.advanceTimersByTime(1_000);
    expect(retry).not.toHaveBeenCalled();
    expect(attemptedRegions.has('42:1:1200')).toBe(true);
  });

  it.each(['ok', 'no-progress', 'failed'] as const)('%s does not reopen the region', (outcome) => {
    expect(subRepairRegionRetryDelay(outcome)).toBeNull();
  });
});
