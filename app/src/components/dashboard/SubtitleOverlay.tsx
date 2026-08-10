/**
 * SubtitleOverlay — paints active subtitle cues over the <video>.
 *
 * Two render paths:
 *  - VTT/SRT/XML tracks → DOM cue overlay, cues located by binary search on the
 *    video's real currentTime (the same presentation clock the progress bar
 *    uses, so subs honor NoBuf's VBR/seek-offset handling and never drift).
 *  - ASS/SSA tracks → jassub (libass WASM), which owns its own canvas + timing
 *    off the same <video>. NOTE: jassub renders ONE track; if multiple ASS
 *    tracks are active we drive the first (matches libass single-track model).
 *
 * Mount as a sibling of <video> inside the relative video box; `inset-0` +
 * pointer-events-none keeps it non-interactive and confined to the video area.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import JASSUB from 'jassub';
import jassubWorkerUrl from 'jassub/dist/wasm/jassub-worker.js?url';
import jassubWasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url';
import jassubModernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url';
import { WebVTT, type VTTCue } from '../../lib/faststream/subtitles/vtt.mjs';
import { SubtitleTrack } from '../../lib/faststream/subtitles/SubtitleTrack';

/** FastStream's binary search: returns match index, or -(insertionPoint)-1. */
function binarySearch(cues: VTTCue[], time: number): number {
  let lower = 0;
  let upper = cues.length - 1;
  while (lower <= upper) {
    const mid = (upper + lower) >> 1;
    const start = cues[mid].startTime;
    if (start < time) lower = mid + 1;
    else if (start > time) upper = mid - 1;
    else return mid;
  }
  return -lower - 1;
}

/** Active cues at `time` for one track, walking back over overlapping cues. */
function activeCues(cues: VTTCue[], time: number): VTTCue[] {
  if (cues.length === 0) return [];
  let i = binarySearch(cues, time);
  if (i < -1) i = -i - 2;
  else if (i < 0) i = 0;
  // Overlapping cues can start earlier; rewind while the previous still covers.
  while (i > 0 && cues[i - 1].endTime >= time && cues[i - 1].startTime <= time) i--;
  const out: VTTCue[] = [];
  while (i >= 0 && i < cues.length && cues[i].startTime <= time && cues[i].endTime >= time) {
    out.push(cues[i]);
    i++;
  }
  return out;
}

interface Props {
  vidRef: RefObject<HTMLVideoElement | null>;
  activeTracks: SubtitleTrack[];
  /** Video currentTime, driven by the player's timeupdate (seconds). */
  currentTime: number;
  /** Changes whenever an active track's cue payload is merged in place. */
  revision?: number;
  /** Font URLs for embedded ASS tracks (MKV attachments served by the
   *  backend). Passed to jassub's `fonts` option; absent = unchanged
   *  behavior for sidecar ASS. */
  assFonts?: string[];
}

export function SubtitleOverlay({ vidRef, activeTracks, currentTime, revision = 0, assFonts }: Props) {
  const vttTracks = useMemo(() => activeTracks.filter((t) => !t.isASS), [activeTracks]);
  const assTrack = useMemo(() => activeTracks.find((t) => t.isASS) ?? null, [activeTracks]);

  // ---- ASS path (jassub) -------------------------------------------------
  // Recreate the instance whenever the active ASS content changes. jassub has
  // no stable public instance-level setTrack (only the async worker proxy), and
  // track swaps are rare, so create/destroy is the simplest correct approach.
  const jassubRef = useRef<JASSUB | null>(null);
  useEffect(() => {
    const video = vidRef.current;
    if (!assTrack?.assContent || !video) return;
    const instance = new JASSUB({
      video,
      subContent: assTrack.assContent,
      workerUrl: jassubWorkerUrl,
      wasmUrl: jassubWasmUrl,
      modernWasmUrl: jassubModernWasmUrl,
      // Embedded MKV font attachments (eager, non-blocking fetch by jassub).
      // Missing/unused fonts degrade to the bundled default font gracefully.
      ...(assFonts && assFonts.length > 0 ? { fonts: assFonts } : {}),
    });
    jassubRef.current = instance;
    return () => {
      instance.destroy();
      if (jassubRef.current === instance) jassubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assTrack?.assContent, vidRef, assFonts?.join(',')]);

  // ---- VTT/SRT DOM path --------------------------------------------------
  const lines = useMemo(() => {
    const rendered: { key: string; html: string }[] = [];
    for (const track of vttTracks) {
      for (const cue of activeCues(track.cues, currentTime)) {
        if (!cue.dom) cue.dom = WebVTT.convertCueToDOMTree(window, cue.text);
        const holder = document.createElement('div');
        if (cue.dom) holder.appendChild(cue.dom.cloneNode(true));
        rendered.push({ key: `${track.language ?? ''}-${cue.startTime}-${cue.text}`, html: holder.innerHTML });
      }
    }
    return rendered;
  }, [vttTracks, currentTime, revision]);

  useEffect(() => {
    if (revision === 0) return;
    for (const track of vttTracks) {
      const active = activeCues(track.cues, currentTime);
      const nearest = track.cues.reduce<VTTCue | null>((best, cue) => {
        if (!best) return cue;
        const cueDistance = currentTime < cue.startTime ? cue.startTime - currentTime
          : currentTime > cue.endTime ? currentTime - cue.endTime : 0;
        const bestDistance = currentTime < best.startTime ? best.startTime - currentTime
          : currentTime > best.endTime ? currentTime - best.endTime : 0;
        return cueDistance < bestDistance ? cue : best;
      }, null);
      console.log(
        `[SUBS-RENDER] revision=${revision} t=${currentTime.toFixed(2)}s cues=${track.cues.length} ` +
        `nearest=${nearest ? `${nearest.startTime.toFixed(2)}-${nearest.endTime.toFixed(2)}s` : 'none'} active=${active.length}`,
      );
    }
    // This is deliberately revision-triggered, not timeupdate-triggered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  if (lines.length === 0 && !assTrack) return null;

  return (
    <div className="absolute inset-0 pointer-events-none flex flex-col justify-end items-center pb-[6%] gap-1 z-20">
      {lines.map((l) => (
        <div
          key={l.key}
          className="max-w-[90%] text-center leading-tight"
          style={{
            color: 'var(--color-nobuf-subtitle-text, #fff)',
            background: 'rgba(10,10,10,0.35)',
            padding: '0.1em 0.4em',
            borderRadius: 4,
            fontSize: 'clamp(16px, 3vw, 34px)',
            textShadow: '0 0 3px #000, 0 0 3px #000',
          }}
          dangerouslySetInnerHTML={{ __html: l.html }}
        />
      ))}
    </div>
  );
}
