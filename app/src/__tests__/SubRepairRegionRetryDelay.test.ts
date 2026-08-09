// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { subRepairRegionRetryDelay } from '../components/dashboard/FastStreamPlayer';

describe('subtitle repair region retry delay', () => {
  it('delays progress before reopening the same region', () => {
    expect(subRepairRegionRetryDelay('progress')).toBe(5_000);
  });
  it('lets deferred reuse the breaker short-delay gate', () => {
    expect(subRepairRegionRetryDelay('deferred')).toBe(0);
  });
  it.each(['ok', 'no-progress', 'failed'] as const)('%s does not reopen the region', (outcome) => {
    expect(subRepairRegionRetryDelay(outcome)).toBeNull();
  });
});
