// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectSubRepairCoverageIntervals, shouldReExtractSubAhead } from '../components/dashboard/FastStreamPlayer';

const interval = (startTime: number, endTime: number) => ({ startTime, endTime });

describe('partial subtitle scheduling uses the latest island, not merged history', () => {
  const merged = [interval(696, 700), interval(995, 1005)];
  const latestBackwardSeekIsland = [interval(696, 700)];

  it('does not let old future cues suppress repair after a backward seek', () => {
    expect(selectSubRepairCoverageIntervals(merged, latestBackwardSeekIsland, false))
      .toEqual(latestBackwardSeekIsland);
  });

  it('re-arms repair at 711s from the local frontier instead of the stale 1005s max', () => {
    const selected = selectSubRepairCoverageIntervals(merged, latestBackwardSeekIsland, false);
    const frontier = Math.max(...selected.map((cue) => cue.endTime));
    expect(frontier).toBe(700);
    expect(shouldReExtractSubAhead(711, frontier, false)).toBe(true);
    expect(shouldReExtractSubAhead(711, 1005, false)).toBe(false);
  });

  it('keeps the merged union for a fully covered artifact', () => {
    expect(selectSubRepairCoverageIntervals(merged, latestBackwardSeekIsland, true))
      .toEqual(merged);
  });

  it('falls back to merged coverage only before any successful local snapshot', () => {
    expect(selectSubRepairCoverageIntervals(merged, null, false)).toEqual(merged);
  });

  it('preserves a successful empty island as empty evidence', () => {
    expect(selectSubRepairCoverageIntervals(merged, [], false)).toEqual([]);
  });
});

describe('latest-island coverage is wired into shipped repair state', () => {
  const source = readFileSync(
    path.resolve(process.cwd(), 'src/components/dashboard/FastStreamPlayer.tsx'),
    'utf8',
  );

  it('stores local intervals on every successful manual and automatic extraction', () => {
    expect(source).toContain('localIntervals: SubCoverageInterval[] | null');
    expect(source).toContain('existing.localIntervals = scratch.isASS');
    expect(source).toContain('entry.localIntervals = scratch.isASS');
    expect(source).toContain('localIntervals: track.isASS');
  });

  it('uses local intervals only for scheduling while retaining merged track content', () => {
    const gateStart = source.indexOf('maybeRepairSubCoverageRef.current =');
    const gateEnd = source.indexOf('const repairSubCoverage = useCallback', gateStart);
    const gate = source.slice(gateStart, gateEnd);
    expect(gateStart).toBeGreaterThanOrEqual(0);
    expect(gate).toContain('selectSubRepairCoverageIntervals(');
    expect(gate).toContain('mergedCoverageIntervals, entry.localIntervals, !entry.partial');
    expect(gate).toContain('const emptyPartialSnapshot =');
    expect(gate).toContain('emptyPartialSnapshot ||');

    const repairStart = source.indexOf('const repairSubCoverage = useCallback');
    const repairEnd = source.indexOf('// Reset the per-region repair ledger', repairStart);
    const repair = source.slice(repairStart, repairEnd);
    expect(repair).toContain('mergeAssContent(entry.track.assContent, res.text)');
    expect(repair).toContain('mergeCues(entry.track.cues, scratch.cues)');
    expect(repair).toContain("if (res.error === 'empty-partial') entry.localIntervals = [];");
  });
});
