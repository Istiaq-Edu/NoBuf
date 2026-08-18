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
    expect(pendingBranch).toContain('embeddedSubTracksRef.current.set(idx, { track, partial: true, localIntervals: null })');
    expect(pendingBranch).toContain('subs.activateTrack(subs.addTrack(track))');
    expect(pendingBranch).toContain('persistSubTrack(fileKey, idx)');
  });

  it('routes a loaded embedded-track row through coverage-aware re-extraction', () => {
    const source = readFileSync(`${process.cwd()}/src/components/dashboard/FastStreamPlayer.tsx`, 'utf8');
    const handlerStart = source.indexOf('const toggleLoadedSubTrack = useCallback');
    const handlerEnd = source.indexOf('// Round-10 P1-2: automatic subtitle-coverage repair.', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handler).toContain('if (entry.track !== track) continue');
    expect(handler).toContain('void toggleEmbeddedSub(');
    expect(handler).toContain('subs.toggleTrack(track)');

    const menuStart = source.indexOf('{sidecarTracks.map((t) => (');
    const menuEnd = source.indexOf('{(msePlayer.embeddedSubTracks.length', menuStart);
    const loadedTrackMenu = source.slice(menuStart, menuEnd);
    expect(menuStart).toBeGreaterThanOrEqual(0);
    expect(loadedTrackMenu).toContain('onClick={() => toggleLoadedSubTrack(t)}');
    expect(loadedTrackMenu).not.toContain('onClick={() => subs.toggleTrack(t)}');

    // The upper loaded-tracks list must render ONLY sidecar tracks — embedded
    // tracks are owned by the "Embedded" section below. Listing them in both
    // places gave the raw toggle row a duplicate that silently reverted the
    // active track. `sidecarTracks` filters embedded tracks out of `subs.tracks`.
    const sidecarDef = source.indexOf('const sidecarTracks = subs.tracks.filter');
    expect(sidecarDef).toBeGreaterThanOrEqual(0);
    expect(source).toContain('!embeddedTrackObjs.has(t)');
    // The old bug: the loaded list mapped `subs.tracks` directly.
    expect(source).not.toContain('{subs.tracks.map(');
  });
});
