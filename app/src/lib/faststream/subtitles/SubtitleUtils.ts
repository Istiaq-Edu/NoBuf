/**
 * Utility functions for subtitle parsing and conversion.
 *
 * Ported faithfully from FastStream (`_ref_faststream/chrome/player/utils/SubtitleUtils.mjs`,
 * v1.3.77). Pure functions only — no DOM/browser state beyond DOMParser (xml2vtt).
 * Container-agnostic: operates on already-extracted subtitle text, never on media binaries.
 */

/** A minimal cue shape (matches the fields we read from VTTCue). */
export interface CueLike {
  startTime: number;
  endTime: number;
  text: string;
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&gt;': '>',
  '&lt;': '<',
  '&quot;': '"',
  '&apos;': "'",
};

/**
 * Translates XML entities in a string to their corresponding characters.
 */
export function translateXMLEntities(str: string): string {
  const entitySplit = str.split(/(&[#a-zA-Z0-9]+;)/);
  if (entitySplit.length <= 1) {
    // No entities. Skip the rest of the function.
    return str;
  }

  for (let i = 1; i < entitySplit.length; i += 2) {
    const reference = entitySplit[i];
    if (reference.charAt(1) === '#') {
      let code: number;
      if (reference.charAt(2) === 'x') {
        // Hexadecimal
        code = parseInt(reference.substring(3, reference.length - 1), 16);
      } else {
        // Decimal
        code = parseInt(reference.substring(2, reference.length - 1), 10);
      }

      // Translate into string according to ISO/IEC 10646
      if (!isNaN(code) && code >= 0 && code <= 0x10ffff) {
        entitySplit[i] = String.fromCodePoint(code);
      }
    } else if (Object.prototype.hasOwnProperty.call(XML_ENTITIES, reference)) {
      entitySplit[i] = XML_ENTITIES[reference];
    }
  }

  return entitySplit.join('');
}

/**
 * Formats a time value in seconds to WebVTT time format (HH:MM:SS.mmm).
 */
export function vttTimeFormat(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  const s = Math.floor(sec % 60);
  const ms = Math.floor(sec * 1000) % 1000;

  const hh = (100 + h).toString().substring(1);
  const mm = (100 + m).toString().substring(1);
  const ss = (100 + s).toString().substring(1);
  const msms = (1000 + ms).toString().substring(1);
  // HH:MM:SS.mmm
  return hh + ':' + mm + ':' + ss + '.' + msms;
}

/**
 * Formats a time value in seconds to SRT time format (HH:MM:SS,mmm).
 */
export function srtTimeFormat(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  const s = Math.floor(sec % 60);
  const ms = Math.floor(sec * 1000) % 1000;

  const hh = (100 + h).toString().substring(1);
  const mm = (100 + m).toString().substring(1);
  const ss = (100 + s).toString().substring(1);
  const msms = (1000 + ms).toString().substring(1);
  // HH:MM:SS,mmm
  return hh + ':' + mm + ':' + ss + ',' + msms;
}

/**
 * Converts a single SRT caption block to a WebVTT cue string.
 */
export function convertSrtCue(caption: string): string {
  let cue = '';
  const s = caption.split(/\n/);
  if (s.length < 2) {
    // file format error or comment lines
    return '';
  }
  // concatenate multi-line string separated in array into one
  while (s.length > 3) {
    for (let i = 3; i < s.length; i++) {
      s[2] += '\n' + s[i];
    }
    s.splice(3, s.length - 3);
  }
  let line = 0;
  // detect identifier
  if (!s[0].match(/\d+:\d+:\d+/) && s[1].match(/\d+:\d+:\d+/)) {
    const idMatch = s[0].match(/\w+/);
    cue += (idMatch ? idMatch[0] : '') + '\n';
    line += 1;
  }
  // get time strings
  if (s[line].match(/\d+:\d+:\d+/)) {
    // convert time string
    const m = s[1].match(
      /(\d+):(\d+):(\d+)(?:,(\d+))?\s*--?>\s*(\d+):(\d+):(\d+)(?:,(\d+))?/,
    );
    if (m) {
      cue +=
        m[1] + ':' + m[2] + ':' + m[3] + '.' + m[4] + ' --> ' +
        m[5] + ':' + m[6] + ':' + m[7] + '.' + m[8] + '\n';
      line += 1;
    } else {
      // Unrecognized timestring
      return '';
    }
  } else {
    // file format error or comment lines
    return '';
  }
  // get cue text
  if (s[line]) {
    const cueText = s[line].replace(/<\s*\/?\s*br\b[^>]*>/gi, '\n');
    cue += cueText + '\n\n';
  }
  return cue;
}

/**
 * Converts SRT subtitle data to WebVTT format.
 */
export function srt2webvtt(data: string): string {
  // remove dos newlines
  let srt = data.replace(/\r+/g, '');
  // trim white space start and end
  srt = srt.replace(/^\s+|\s+$/g, '');
  // get cues
  const cuelist = srt.split('\n\n');
  let result = '';
  if (cuelist.length > 0) {
    result += 'WEBVTT\n\n';
    for (let i = 0; i < cuelist.length; i = i + 1) {
      result += convertSrtCue(cuelist[i]);
    }
  }
  return result;
}

/**
 * Converts XML (YouTube-style `<text start dur>`) subtitle data to WebVTT format.
 */
export function xml2vtt(data: string): string {
  const parser = new DOMParser();
  const xml = parser.parseFromString(data, 'text/xml');
  const cues = xml.getElementsByTagName('text');
  const result = ['WEBVTT'];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const start = parseFloat(cue.getAttribute('start') || '0');
    const dur = parseFloat(cue.getAttribute('dur') || '0');
    const end = start + dur;
    const text = translateXMLEntities(cue.textContent || '');
    result.push(
      (i + 1) + '\n' + vttTimeFormat(start) + ' --> ' + vttTimeFormat(end) + '\n' + text,
    );
  }
  return result.join('\n\n');
}

/**
 * Converts an array of cues to SRT subtitle format (for export/download).
 */
export function cuesToSrt(cues: CueLike[]): string {
  const result: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const start = srtTimeFormat(cue.startTime);
    const end = srtTimeFormat(cue.endTime);
    const text = cue.text;
    result.push((i + 1) + '\n' + start + ' --> ' + end + '\n' + text);
  }
  return result.join('\n\n');
}

/**
 * Converts subtitle formatting tags (ASS-style alignment/bold/italic/underline)
 * into WebVTT-compatible cue settings and HTML tags.
 */
export function convertSubtitleFormatting(text: string): string {
  const alignmentSettings: Record<string, string> = {
    1: 'line:95% position:0% align:start',
    2: 'line:95% position:50% align:center',
    3: 'line:95% position:100% align:end',
    4: 'line:50% position:0% align:start',
    5: 'line:50% position:50% align:center',
    6: 'line:50% position:100% align:end',
    7: 'line:5% position:0% align:start',
    8: 'line:5% position:50% align:center',
    9: 'line:5% position:100% align:end',
  };

  const withAlignment = text.replace(
    /(\r\n|\n)\{\\?an(\d)\}/gi,
    (_match, _newline, alignment) => {
      const settings = alignmentSettings[alignment];
      if (settings) {
        return ` ${settings}\n`;
      }
      return '\n';
    },
  );

  return withAlignment
    .replace(/\{\\([ibu])1\}/gi, '<$1>') // {\b1}, {\i1}, {\u1} -> <b>, <i>, <u>
    .replace(/\{\\([ibu])\}/gi, '</$1>') // {\b}, {\i}, {\u} -> </b>, </i>, </u>
    .replace(/\{([ibu])\}/gi, '<$1>') // {b}, {i}, {u} -> <b>, <i>, <u>
    .replace(/\{\/([ibu])\}/gi, '</$1>') // {/b}, {/i}, {/u} -> </b>, </i>, </u>
    .replace(/\{\\?an\d\}/gi, '') // strip any remaining alignment tags
    .replace(/\\h/gi, ' '); // convert hard spaces to regular spaces
}

/**
 * Namespace object mirroring FastStream's `SubtitleUtils` static class,
 * so ported call-sites (`SubtitleUtils.srt2webvtt(...)`) port with minimal churn.
 */
export const SubtitleUtils = {
  translateXMLEntities,
  vttTimeFormat,
  srtTimeFormat,
  convertSrtCue,
  srt2webvtt,
  xml2vtt,
  cuesToSrt,
  convertSubtitleFormatting,
};
