// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('backs off a successful zero-dialogue island without slowing a still-filling decline', () => {
    // 21-c:1319-1418 rebuilt ten growing islands in eleven seconds, all yielding
    // the same ASS header and zero Dialogue rows. A successful empty snapshot is
    // positive evidence of a dialogue-free span; a 204 decline is not.
    expect(subRepairRegionRetryDelay('deferred', true)).toBe(3_000);
    expect(subRepairRegionRetryDelay('deferred', false)).toBe(1_000);
  });

  it('binds the successful-empty evidence to the shipped repair scheduler', () => {
    const source = readFileSync(
      `${process.cwd()}/src/components/dashboard/FastStreamPlayer.tsx`, 'utf8',
    );
    const start = source.indexOf('const repairSubCoverage = useCallback');
    const end = source.indexOf('// Reset the per-region repair ledger', start);
    const repair = source.slice(start, end);
    expect(repair).toContain(
      'successfulEmptyPartial = res.partial && entry.localIntervals.length === 0',
    );
    expect(repair).toContain(
      'subRepairRegionRetryDelay(outcome, successfulEmptyPartial)',
    );
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
