// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { shouldStagePendingPartialSubTrack } from '../components/dashboard/FastStreamPlayer';

describe('early embedded subtitle selection', () => {
  it('stages an empty partial result so automatic repair can finish it', () => {
    expect(shouldStagePendingPartialSubTrack('empty-partial', false)).toBe(true);
  });

  it('does not replace an existing track', () => {
    expect(shouldStagePendingPartialSubTrack('empty-partial', true)).toBe(false);
  });

  it.each(['empty', 'failed'] as const)('does not stage a terminal %s result', (error) => {
    expect(shouldStagePendingPartialSubTrack(error, false)).toBe(false);
  });

  it('wires the pending decision into manual selection and activates the staged track', () => {
    const source = readFileSync(`${process.cwd()}/src/components/dashboard/FastStreamPlayer.tsx`, 'utf8');
    const start = source.indexOf('const toggleEmbeddedSub = useCallback');
    const end = source.indexOf('// Round-10 P1-2: automatic subtitle-coverage repair.', start);
    const toggle = source.slice(start, end);
    const pendingStart = toggle.indexOf("origin === 'user'");
    const pendingEnd = toggle.indexOf('// Round-14 F4:', pendingStart);
    const pendingBranch = toggle.slice(pendingStart, pendingEnd);
    expect(pendingStart).toBeGreaterThanOrEqual(0);
    expect(pendingBranch).toContain('shouldStagePendingPartialSubTrack(res.error, !!existing)');
    expect(pendingBranch).toContain('subs.getSelectionVersion() === selectionVersionAtStart');
    expect(pendingBranch).toContain('embeddedSubTracksRef.current.set(idx, { track, partial: true })');
    expect(pendingBranch).toContain('subs.activateTrack(subs.addTrack(track))');
    expect(pendingBranch).toContain('persistSubTrack(fileKey, idx)');
  });
});
