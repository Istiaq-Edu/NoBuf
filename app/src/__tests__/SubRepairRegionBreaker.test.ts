import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  emptySubRepairBreakerState,
  reduceSubRepairBreaker,
  shouldAttemptSubRepair,
  selectSubRepairBreakerKey,
} from '../hooks/useMSEPlayer';

describe('subtitle repair breaker regions', () => {
  it('keeps a distant seek repair available after the opening region exhausts its attempts', () => {
    const fileId = 'file';
    const trackIdx = 2;

    let opening = emptySubRepairBreakerState();
    for (let i = 0; i < 6; i++) {
      opening = reduceSubRepairBreaker(opening, 'no-progress', i * 1000, null);
    }

    const states = new Map<string, typeof opening>();
    states.set(selectSubRepairBreakerKey(fileId, trackIdx, 10), opening);

    const distantKey = selectSubRepairBreakerKey(fileId, trackIdx, 1370);
    const distant = states.get(distantKey) ?? emptySubRepairBreakerState();

    expect(shouldAttemptSubRepair(opening, 100_000, false)).toBe(false);
    expect(shouldAttemptSubRepair(distant, 100_000, false)).toBe(true);
    expect(distantKey).not.toBe(selectSubRepairBreakerKey(fileId, trackIdx, 10));
  });

  it('FastStreamPlayer keys the breaker by region, not by file/track', () => {
    // Structural guard, scoped to the enclosing effect body. The pure-function
    // test above cannot catch a regression to file-wide keys in the component
    // (verified: swapping `bkey = regionKey` for `bkey = file.id:idx` left the
    // suite green). This assertion fails on exactly that mutation.
    const src = readFileSync(
      fileURLToPath(new URL('../components/dashboard/FastStreamPlayer.tsx', import.meta.url)),
      'utf-8',
    );
    const effectStart = src.indexOf('maybeRepairSubCoverageRef.current = (playheadS: number) =>');
    const effectEnd = src.indexOf('const repairSubCoverage = useCallback', effectStart);
    expect(effectStart).toBeGreaterThan(-1);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const body = src.slice(effectStart, effectEnd);
    expect(body).toContain('const bkey = regionKey;');
  });
});
