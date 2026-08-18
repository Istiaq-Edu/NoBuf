// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSubtitles } from '../hooks/useSubtitles';
import { SubtitleTrack } from '../lib/faststream/subtitles/SubtitleTrack';

function track(label: string): SubtitleTrack {
  return new SubtitleTrack(label, null);
}

describe('useSubtitles single-selection contract', () => {
  it('replaces the active track when another track is activated', () => {
    const first = track('English');
    const second = track('Spanish');
    const { result } = renderHook(() => useSubtitles());

    act(() => result.current.activateTrack(first));
    expect(result.current.activeTracks).toEqual([first]);

    act(() => result.current.activateTrack(second));
    expect(result.current.activeTracks).toEqual([second]);
  });

  it('toggles the selected track off and replaces it when another is selected', () => {
    const first = track('English');
    const second = track('Spanish');
    const { result } = renderHook(() => useSubtitles());

    act(() => result.current.toggleTrack(first));
    act(() => result.current.toggleTrack(second));
    expect(result.current.activeTracks).toEqual([second]);

    act(() => result.current.toggleTrack(second));
    expect(result.current.activeTracks).toEqual([]);
  });

  it('restores only the last selected track after the global subtitles toggle', () => {
    const first = track('English');
    const second = track('Spanish');
    const { result } = renderHook(() => useSubtitles());

    act(() => result.current.activateTrack(first));
    act(() => result.current.activateTrack(second));
    act(() => result.current.toggleSubtitles());
    expect(result.current.activeTracks).toEqual([]);
    expect(result.current.hasLastActive).toBe(true);

    act(() => result.current.toggleSubtitles());
    expect(result.current.activeTracks).toEqual([second]);
    expect(result.current.hasLastActive).toBe(false);
  });

  it('does not restore a stale track after a new menu selection', () => {
    const first = track('English');
    const second = track('Spanish');
    const { result } = renderHook(() => useSubtitles());

    act(() => result.current.activateTrack(first));
    act(() => result.current.toggleSubtitles());
    act(() => result.current.activateTrack(second));
    act(() => result.current.deactivateTrack(second));
    act(() => result.current.toggleSubtitles());
    expect(result.current.activeTracks).toEqual([]);
  });

  it('exposes synchronous intent changes for async completion guards', () => {
    const first = track('English');
    const second = track('Spanish');
    const { result } = renderHook(() => useSubtitles());
    const initial = result.current.getSelectionVersion();

    act(() => result.current.activateTrack(first));
    const firstSelected = result.current.getSelectionVersion();
    expect(firstSelected).toBeGreaterThan(initial);
    expect(result.current.isTrackActive(first)).toBe(true);

    act(() => result.current.activateTrack(second));
    expect(result.current.getSelectionVersion()).toBeGreaterThan(firstSelected);
    expect(result.current.isTrackActive(first)).toBe(false);
    expect(result.current.isTrackActive(second)).toBe(true);
  });

  it('records an explicit Off intent before extraction activates a track', () => {
    const { result } = renderHook(() => useSubtitles());
    const before = result.current.getSelectionVersion();

    act(() => result.current.deactivateAll());

    expect(result.current.activeTracks).toEqual([]);
    expect(result.current.getSelectionVersion()).toBeGreaterThan(before);
  });

  it('does not restore a track removed while subtitles are Off', () => {
    const first = track('English');
    const { result } = renderHook(() => useSubtitles());

    act(() => result.current.addTrack(first));
    act(() => result.current.activateTrack(first));
    act(() => result.current.toggleSubtitles());
    act(() => result.current.removeTrack(first));
    act(() => result.current.toggleSubtitles());

    expect(result.current.activeTracks).toEqual([]);
  });
});