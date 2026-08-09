// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { subRepairRegionRetryDelay } from '../components/dashboard/FastStreamPlayer';

describe('subtitle repair region ledger', () => {
  it('reopens progress with bounded retry delay', () => {
    expect(subRepairRegionRetryDelay('progress')).toBe(5_000);
  });

  it('reopens deferred immediately', () => {
    expect(subRepairRegionRetryDelay('deferred')).toBe(0);
  });

  it.each(['ok', 'no-progress', 'failed'] as const)('%s keeps the terminal region spent', (outcome) => {
    expect(subRepairRegionRetryDelay(outcome)).toBeNull();
  });
});
