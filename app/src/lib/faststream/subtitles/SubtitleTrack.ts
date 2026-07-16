/**
 * SubtitleTrack — a parsed subtitle track (list of timed cues).
 *
 * Ported from FastStream's SubtitleTrack.mjs, converted to TypeScript.
 * Container-agnostic: it consumes already-extracted subtitle TEXT (from a
 * sidecar file/URL, OpenSubtitles, or — in v2 — an embedded MKV extractor)
 * and parses it into sorted VTTCues via the vendored videojs/vtt.js bundle.
 *
 * Design note (verified): FastStream's loadText only branched on
 * <?xml / WEBVTT / else-SRT and fed real ASS through srt2webvtt, which does
 * NOT understand ASS. We tag ASS/SSA here (`isASS`) so the renderer can route
 * it to jassub (libass) instead of mangling it. The raw text is preserved on
 * `assContent` for jassub; cues[] stays empty for ASS tracks.
 */
import { WebVTT, type VTTCue, type VTTRegion } from './vtt.mjs';
import { SubtitleUtils } from './SubtitleUtils';

export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ssa' | 'xml' | 'unknown';

function detectFormat(text: string): SubtitleFormat {
  const head = text.slice(0, 4096);
  if (head.substring(0, 5) === '<?xml') return 'xml';
  const firstLine = head.trim().split('\n')[0].trim();
  if (firstLine.substring(0, 6) === 'WEBVTT') return 'vtt';
  // ASS/SSA are identified by their section headers.
  if (/^\uFEFF?\s*\[Script Info\]/i.test(head) || /\n\s*\[V4\+? Styles\]/i.test(head)) {
    // SSA is "v4 Styles"; ASS is "v4+ Styles". Both go to libass.
    return /\[V4\+ Styles\]/i.test(head) ? 'ass' : 'ssa';
  }
  return 'srt';
}

export class SubtitleTrack {
  label: string | null;
  language: string | null;
  cues: VTTCue[] = [];
  regions: VTTRegion[] = [];

  /** True for ASS/SSA — render via jassub, not the VTT cue overlay. */
  isASS = false;
  /** Raw ASS/SSA script text, preserved for jassub (empty for VTT/SRT). */
  assContent: string | null = null;
  format: SubtitleFormat = 'unknown';

  constructor(label: string | null, language: string | null) {
    this.label = label;
    this.language = language;
  }

  async loadURL(url: string): Promise<void> {
    const response = await fetch(url);
    const text = await response.text();
    this.loadText(text);
  }

  shift(time: number): void {
    // ASS is shifted at the jassub layer via timeOffset; VTT cues shift here.
    this.cues.forEach((cue) => {
      cue.startTime += time;
      cue.endTime += time;
    });
  }

  shiftAfter(cue: VTTCue, time: number): void {
    // Only shift the given cue and everything after it, so a user can fix
    // drift from a point onward without touching earlier cues.
    let shift = false;
    this.cues.forEach((c) => {
      if (c === cue) shift = true;
      if (shift) {
        c.startTime += time;
        c.endTime += time;
      }
    });
  }

  loadText(text: string): void {
    this.format = detectFormat(text);

    if (this.format === 'ass' || this.format === 'ssa') {
      // Route to jassub — do NOT feed through srt2webvtt (would mangle it).
      this.isASS = true;
      this.assContent = text;
      this.cues = [];
      return;
    }

    let vtt = text;
    if (this.format === 'xml') {
      vtt = SubtitleUtils.xml2vtt(text);
    } else if (this.format === 'srt') {
      vtt = SubtitleUtils.srt2webvtt(text);
    }

    // Normalize {\an}/{\b1} style formatting tags into WebVTT-compatible cues.
    vtt = SubtitleUtils.convertSubtitleFormatting(vtt);

    const parser = new WebVTT.Parser(window, WebVTT.StringDecoder());
    parser.onRegion = (region: VTTRegion) => {
      this.regions.push(region);
    };
    parser.oncue = (cue: VTTCue) => {
      this.cues.push(cue);
    };
    parser.onflush = () => {
      this.cues.sort((a, b) => a.startTime - b.startTime);
    };
    parser.onparsingerror = (error: Error) => {
      console.error('[SubtitleTrack] parse error:', error);
    };

    parser.parse(vtt);
    parser.flush();
  }

  equals(otherTrack: SubtitleTrack): boolean {
    if (this.label !== otherTrack.label && this.language !== otherTrack.language) {
      return false;
    }
    if (this.isASS !== otherTrack.isASS) return false;
    if (this.isASS) {
      return this.assContent === otherTrack.assContent;
    }
    if (this.cues.length !== otherTrack.cues.length) return false;
    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i];
      const otherCue = otherTrack.cues[i];
      if (
        cue.startTime !== otherCue.startTime ||
        cue.endTime !== otherCue.endTime ||
        cue.text !== otherCue.text
      ) {
        return false;
      }
    }
    return true;
  }
}
