/**
 * useSubtitles — React state for loaded subtitle tracks and which are active.
 *
 * Container-agnostic track manager (port of FastStream's SubtitlesManager state
 * half). Sources feed in SubtitleTrack instances (sidecar file/URL now;
 * OpenSubtitles + embedded MKV later); this hook owns add/activate/toggle/clear.
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
  toggleTrack: (track: SubtitleTrack) => void;
  toggleSubtitles: () => void;
  removeTrack: (track: SubtitleTrack) => void;
  clearTracks: () => void;
}

export function useSubtitles(): UseSubtitles {
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [activeTracks, setActiveTracks] = useState<SubtitleTrack[]>([]);
  const [hasLastActive, setHasLastActive] = useState(false);
  const lastActiveRef = useRef<SubtitleTrack[] | null>(null);

  const addTrack = useCallback((track: SubtitleTrack): SubtitleTrack => {
    let existing: SubtitleTrack | undefined;
    setTracks((prev) => {
      existing = prev.find((t) => t.equals(track));
      return existing ? prev : [...prev, track];
    });
    return existing ?? track;
  }, []);

  const activateTrack = useCallback((track: SubtitleTrack) => {
    setActiveTracks((prev) => (prev.includes(track) ? prev : [...prev, track]));
  }, []);

  const deactivateTrack = useCallback((track: SubtitleTrack) => {
    setActiveTracks((prev) => prev.filter((t) => t !== track));
  }, []);

  const toggleTrack = useCallback((track: SubtitleTrack) => {
    setActiveTracks((prev) =>
      prev.includes(track) ? prev.filter((t) => t !== track) : [...prev, track],
    );
  }, []);

  // Off ⇄ on: remembers the last-active set so the CC toggle restores it.
  const toggleSubtitles = useCallback(() => {
    setActiveTracks((prev) => {
      if (prev.length === 0) {
        const restore = lastActiveRef.current;
        lastActiveRef.current = null;
        setHasLastActive(false);
        if (restore && restore.length) return restore;
        return []; // caller can activate tracks[0] explicitly if desired
      }
      lastActiveRef.current = prev.slice();
      setHasLastActive(true);
      return [];
    });
  }, []);

  const removeTrack = useCallback((track: SubtitleTrack) => {
    setTracks((prev) => prev.filter((t) => t !== track));
    setActiveTracks((prev) => prev.filter((t) => t !== track));
  }, []);

  const clearTracks = useCallback(() => {
    setTracks([]);
    setActiveTracks([]);
    lastActiveRef.current = null;
    setHasLastActive(false);
  }, []);

  return {
    tracks,
    activeTracks,
    hasLastActive,
    addTrack,
    activateTrack,
    deactivateTrack,
    toggleTrack,
    toggleSubtitles,
    removeTrack,
    clearTracks,
  };
}
