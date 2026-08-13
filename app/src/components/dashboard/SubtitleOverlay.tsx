/**
 * SubtitleOverlay — paints active subtitle cues over the <video>.
 *
 * Two render paths:
 *  - VTT/SRT/XML tracks → DOM cue overlay, cues located by binary search on the
 *    video's real currentTime (the same presentation clock the progress bar
 *    uses, so subs honor NoBuf's VBR/seek-offset handling and never drift).
 *  - ASS/SSA tracks → jassub (libass WASM) in normal browsers. Tauri/WebView2
 *    uses the DOM dialogue path because JASSUB's canvas can become an opaque
 *    video-sized layer there after seek/recreation. NOTE: both paths render the
 *    first active ASS track (matching libass's single-track model).
 *
 * Mount as a sibling of <video> inside the relative video box; `inset-0` +
 * pointer-events-none keeps it non-interactive and confined to the video area.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import JASSUB from 'jassub';
import jassubWorkerUrl from 'jassub/dist/worker/worker.js?worker&url';
import jassubWasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url';
import jassubModernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url';
import jassubDefaultFontUrl from 'jassub/dist/default.woff2?url';
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

function parseAssTime(value: string): number | null {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const fraction = Number((match[4] ?? '').padEnd(2, '0')) / 100;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + fraction;
}

interface AssDialogue {
  start: number;
  end: number;
  text: string;
}

const DEFAULT_ASS_EVENT_FORMAT = [
  'layer', 'start', 'end', 'style', 'name',
  'marginl', 'marginr', 'marginv', 'effect', 'text',
];

function parseAssDialogues(content: string): AssDialogue[] {
  const dialogues: AssDialogue[] = [];
  let inEvents = false;
  let format = DEFAULT_ASS_EVENT_FORMAT;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.charCodeAt(rawLine.length - 1) === 13 ? rawLine.slice(0, -1) : rawLine;
    const section = line.match(/^\s*\[([^\]]+)]\s*$/);
    if (section) {
      inEvents = section[1].trim().toLowerCase() === 'events';
      continue;
    }
    if (!inEvents) continue;

    const formatMatch = line.match(/^\s*Format\s*:\s*(.*)$/i);
    if (formatMatch) {
      const candidate = formatMatch[1].split(',').map((field) => field.trim().toLowerCase());
      if (candidate.includes('start') && candidate.includes('end') && candidate.includes('text')) {
        format = candidate;
      }
      continue;
    }

    const dialogueMatch = line.match(/^\s*Dialogue\s*:\s*(.*)$/i);
    if (!dialogueMatch) continue;
    const fields = dialogueMatch[1].split(',');
    const startIndex = format.indexOf('start');
    const endIndex = format.indexOf('end');
    const textIndex = format.indexOf('text');
    if (startIndex < 0 || endIndex < 0 || textIndex < 0 || fields.length <= Math.max(startIndex, endIndex, textIndex)) {
      continue;
    }

    const start = parseAssTime(fields[startIndex]);
    const end = parseAssTime(fields[endIndex]);
    if (start == null || end == null || end < start) continue;
    // Text is conventionally the final field and may itself contain commas.
    const text = textIndex === format.length - 1
      ? fields.slice(textIndex).join(',')
      : fields[textIndex];
    dialogues.push({ start, end, text });
  }
  return dialogues;
}

function assTextToPlainText(value: string): string {
  let drawingDepth = 0;
  let output = '';
  for (const token of value.split(/(\{[^}]*\}|\\N|\\n|\\h)/g)) {
    if (token.startsWith('{') && token.endsWith('}')) {
      for (const match of token.matchAll(/\\p(\d+)/gi)) drawingDepth = Number(match[1]);
    } else if (drawingDepth === 0) {
      if (/^\\[Nn]$/.test(token)) output += '\n';
      else if (token === '\\h') output += '\u00a0';
      else output += token;
    }
  }
  return output.trim();
}

export function assDialogueBounds(content: string): { first: number; last: number; count: number } | null {
  const dialogues = parseAssDialogues(content);
  if (dialogues.length === 0) return null;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const dialogue of dialogues) {
    first = Math.min(first, dialogue.start);
    last = Math.max(last, dialogue.end);
  }
  return { first, last, count: dialogues.length };
}

function activeAssDialogueText(dialogues: AssDialogue[], time: number): string[] {
  return dialogues
    .filter((dialogue) => time >= dialogue.start && time < dialogue.end)
    .map((dialogue) => assTextToPlainText(dialogue.text))
    .filter(Boolean);
}

export function activeAssText(content: string, time: number): string[] {
  return activeAssDialogueText(parseAssDialogues(content), time);
}

/** WebView2 OffscreenCanvas can black out the video despite a ready JASSUB worker. */
export function shouldUseJassub(): boolean {
  return typeof window !== 'undefined' && !isTauri();
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

  // ---- ASS path (JASSUB in browsers, DOM in Tauri/WebView2) --------------
  // Recreate the instance whenever the active ASS content changes. jassub has
  // no stable public instance-level setTrack (only the async worker proxy), and
  // track swaps are rare, so create/destroy is the simplest correct approach.
  const jassubRef = useRef<JASSUB | null>(null);
  const [assRendererFailed, setAssRendererFailed] = useState(false);
  const useJassub = shouldUseJassub();
  useEffect(() => {
    if (!assTrack?.assContent) return;
    console.log(`[SUBS-RENDER] selected=${useJassub ? 'jassub' : 'dom-tauri'} tauri=${isTauri()}`);
  }, [assTrack?.assContent, useJassub]);
  useEffect(() => {
    const video = vidRef.current;
    if (!useJassub || !assTrack?.assContent || !video) return;
    let instance: JASSUB;
    setAssRendererFailed(false);
    try {
      instance = new JASSUB({
        video,
        subContent: assTrack.assContent,
        workerUrl: jassubWorkerUrl,
        wasmUrl: jassubWasmUrl,
        modernWasmUrl: jassubModernWasmUrl,
        // Vite prebundles the bare `jassub` import under node_modules/.vite.
        // JASSUB's implicit new URL('./default.woff2', import.meta.url) then
        // points at a file Vite never emits. Supply the real package asset so
        // libass always has a glyph source, even when the MKV has no fonts.
        availableFonts: { 'liberation sans': jassubDefaultFontUrl },
        defaultFont: 'liberation sans',
        // Embedded MKV font attachments (eager, non-blocking fetch by jassub).
        // Missing/unused fonts degrade to the bundled default font gracefully.
        ...(assFonts && assFonts.length > 0 ? { fonts: assFonts } : {}),
      });
    } catch (error) {
      const orphan = video.nextElementSibling;
      if (orphan instanceof HTMLCanvasElement && orphan.classList.contains('JASSUB')) {
        orphan.remove();
      }
      setAssRendererFailed(true);
      console.error('[SUBS-RENDER] ASS renderer startup failed:', error);
      return;
    }
    jassubRef.current = instance;
    instance._canvas.style.zIndex = '20';
    let disposed = false;
    let rendererFailed = false;
    const failRenderer = (message: string, error?: unknown) => {
      if (disposed || rendererFailed) return;
      rendererFailed = true;
      instance._worker?.terminate();
      instance._canvas.remove();
      if (jassubRef.current === instance) jassubRef.current = null;
      setAssRendererFailed(true);
      if (error === undefined) console.error(message);
      else console.error(message, error);
    };
    const bounds = assDialogueBounds(assTrack.assContent);
    console.log(
      `[SUBS-RENDER] ASS boot: playhead=${video.currentTime.toFixed(2)}s ` +
      `dialogues=${bounds?.count ?? 0} span=${bounds ? `${bounds.first.toFixed(2)}-${bounds.last.toFixed(2)}s` : 'none'} ` +
      `content=${assTrack.assContent.length}B`,
    );
    const readyTimeout = window.setTimeout(() => {
      failRenderer('[SUBS-RENDER] ASS renderer timed out after 3000ms; using text fallback');
    }, 3000);
    void instance.ready.then(() => {
      window.clearTimeout(readyTimeout);
      if (disposed || rendererFailed) return;
      setAssRendererFailed(false);
      console.log(
        `[SUBS-RENDER] ASS ready: playhead=${video.currentTime.toFixed(2)}s ` +
        `canvas=${instance._canvas.width}x${instance._canvas.height} css=${instance._canvas.style.width}x${instance._canvas.style.height}`,
      );
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback((_now, metadata) => {
          if (!disposed) console.log(`[SUBS-RENDER] ASS frame: mediaTime=${metadata.mediaTime.toFixed(2)}s`);
        });
      }
    }).catch((error: unknown) => {
      window.clearTimeout(readyTimeout);
      failRenderer('[SUBS-RENDER] ASS renderer failed:', error);
    });
    return () => {
      disposed = true;
      window.clearTimeout(readyTimeout);
      void instance.ready.then(
        () => instance.destroy(),
        () => {
          // jassub.destroy() awaits the rejected ready promise before it
          // terminates the worker, so terminate the failed worker explicitly.
          if (!rendererFailed) instance._worker?.terminate();
          instance._canvas.remove();
        },
      ).catch(() => {});
      if (jassubRef.current === instance) jassubRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assTrack?.assContent, vidRef, assFonts?.join(','), useJassub]);

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

  const assDialogues = useMemo(
    () => assTrack?.assContent ? parseAssDialogues(assTrack.assContent) : [],
    [assTrack?.assContent, revision],
  );
  const assFallbackLines = useMemo(
    () => (!useJassub || assRendererFailed)
      ? activeAssDialogueText(assDialogues, currentTime)
      : [],
    [useJassub, assRendererFailed, assDialogues, currentTime],
  );

  useEffect(() => {
    if (useJassub || !assTrack?.assContent) return;
    const bounds = assDialogueBounds(assTrack.assContent);
    console.log(
      `[SUBS-RENDER] mode=dom-webview2 playhead=${currentTime.toFixed(2)}s ` +
      `active=${assFallbackLines.length} dialogues=${bounds?.count ?? 0} ` +
      `span=${bounds ? `${bounds.first.toFixed(2)}-${bounds.last.toFixed(2)}s` : 'none'}`,
    );
    // Report extraction/revision changes, not every player timeupdate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useJassub, assTrack?.assContent, revision]);

  if (lines.length === 0 && assFallbackLines.length === 0 && !assTrack) return null;

  return (
    <div className="absolute inset-0 pointer-events-none flex flex-col justify-end items-center pb-[6%] gap-1 z-20">
      {assFallbackLines.map((text, index) => (
        <div
          key={`ass-fallback-${index}-${text}`}
          data-ass-subtitle
          className="max-w-[90%] whitespace-pre-line text-center leading-tight"
          style={{
            color: 'var(--color-nobuf-subtitle-text, #fff)',
            background: 'rgba(10,10,10,0.35)',
            padding: '0.1em 0.4em',
            borderRadius: 4,
            fontSize: 'clamp(16px, 3vw, 34px)',
            textShadow: '0 0 3px #000, 0 0 3px #000',
          }}
        >
          {text}
        </div>
      ))}
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
