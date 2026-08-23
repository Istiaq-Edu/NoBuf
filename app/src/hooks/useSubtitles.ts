/**
 * useSubtitles — React state for loaded subtitle tracks and which are active.
 *
 * Container-agnostic track manager (port of FastStream's SubtitlesManager state
 * half). Sources feed in SubtitleTrack instances (sidecar file/URL now;
 * OpenSubtitles + embedded MKV later); this hook owns add/activate/toggle/clear
 * and enforces at most one active track.
 */
import { useCallback, useRef, useState } from 'react';
import { SubtitleTrack } from '../lib/faststream/subtitles/SubtitleTrack';

export interface UseSubtitles {
  tracks: SubtitleTrack[];
  activeTracks: SubtitleTrack[];
  /** True when subtitles were toggled off but a set is remembered for restore. */
  hasLastActive: boolean;
  addTrack: (track: SubtitleTrack) => SubtitleTrack;
  activateTrack: (track: SubtitleTrack) => void;
  deactivateTrack: (track: SubtitleTrack) => void;
  deactivateAll: () => void;
  toggleTrack: (track: SubtitleTrack) => void;
  toggleSubtitles: () => void;
  getSelectionVersion: () => number;
  isTrackActive: (track: SubtitleTrack) => boolean;
  removeTrack: (track: SubtitleTrack) => void;
  clearTracks: () => void;
}

export function useSubtitles(): UseSubtitles {
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [activeTracks, setActiveTracks] = useState<SubtitleTrack[]>([]);
  const [hasLastActive, setHasLastActive] = useState(false);
  const lastActiveRef = useRef<SubtitleTrack[] | null>(null);
  const activeTracksRef = useRef<SubtitleTrack[]>([]);
  const selectionVersionRef = useRef(0);

  const commitSelection = useCallback((next: SubtitleTrack[]) => {
    activeTracksRef.current = next;
    selectionVersionRef.current += 1;
    setActiveTracks(next);
  }, []);

  const addTrack = useCallback((track: SubtitleTrack): SubtitleTrack => {
    let existing: SubtitleTrack | undefined;
    setTracks((prev) => {
      existing = prev.find((t) => t.equals(track));
      return existing ? prev : [...prev, track];
    });
    return existing ?? track;
  }, []);

  const activateTrack = useCallback((track: SubtitleTrack) => {
    if (activeTracksRef.current.length === 1 && activeTracksRef.current[0] === track) return;
    lastActiveRef.current = null;
    setHasLastActive(false);
    commitSelection([track]);
  }, [commitSelection]);

  const deactivateTrack = useCallback((track: SubtitleTrack) => {
    const next = activeTracksRef.current.filter((t) => t !== track);
    if (next.length !== activeTracksRef.current.length) {
      lastActiveRef.current = null;
      setHasLastActive(false);
      commitSelection(next);
    }
  }, [commitSelection]);

  const deactivateAll = useCallback(() => {
    lastActiveRef.current = null;
    setHasLastActive(false);
    commitSelection([]);
  }, [commitSelection]);

  const toggleTrack = useCallback((track: SubtitleTrack) => {
    lastActiveRef.current = null;
    setHasLastActive(false);
    commitSelection(
      activeTracksRef.current.length === 1 && activeTracksRef.current[0] === track
        ? []
        : [track],
    );
  }, [commitSelection]);

  // Off ⇄ on: remembers the last-active set so the CC toggle restores it.
  const toggleSubtitles = useCallback(() => {
    const prev = activeTracksRef.current;
    if (prev.length === 0) {
      const restore = lastActiveRef.current;
      lastActiveRef.current = null;
      setHasLastActive(false);
      if (restore && restore.length) commitSelection([restore[0]]);
      return;
    }
    lastActiveRef.current = [prev[0]];
    setHasLastActive(true);
    commitSelection([]);
  }, [commitSelection]);

  const getSelectionVersion = useCallback(() => selectionVersionRef.current, []);
  const isTrackActive = useCallback(
    (track: SubtitleTrack) => activeTracksRef.current.includes(track),
    [],
  );

  const removeTrack = useCallback((track: SubtitleTrack) => {
    setTracks((prev) => prev.filter((t) => t !== track));
    if (lastActiveRef.current?.includes(track)) {
      lastActiveRef.current = null;
      setHasLastActive(false);
    }
    const next = activeTracksRef.current.filter((t) => t !== track);
    if (next.length !== activeTracksRef.current.length) commitSelection(next);
  }, [commitSelection]);

  const clearTracks = useCallback(() => {
    setTracks([]);
    commitSelection([]);
    lastActiveRef.current = null;
    setHasLastActive(false);
  }, [commitSelection]);

  return {
    tracks,
    activeTracks,
    hasLastActive,
    addTrack,
    activateTrack,
    deactivateTrack,
    deactivateAll,
    toggleTrack,
    toggleSubtitles,
    getSelectionVersion,
    isTrackActive,
    removeTrack,
    clearTracks,
  };
}
