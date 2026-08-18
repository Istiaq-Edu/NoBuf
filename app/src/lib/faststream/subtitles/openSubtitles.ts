/**
 * OpenSubtitles search helpers — pure, no network, no DOM.
 *
 * Extracted so the query-building logic is unit-testable: the Tauri commands that
 * actually talk to the API cannot run under vitest, but the decisions about WHAT to
 * ask for are the part most likely to be wrong.
 */

/** Words that are release metadata, never part of a title. */
const RELEASE_NOISE = new Set([
  // resolution / source
  '480p', '576p', '720p', '1080p', '1440p', '2160p', '4k', '8k', 'uhd', 'hd', 'sd',
  'bluray', 'blu-ray', 'brrip', 'bdrip', 'bdremux', 'remux', 'webrip', 'web-dl',
  'webdl', 'web', 'hdrip', 'dvdrip', 'dvdscr', 'dvd', 'hdtv', 'pdtv', 'cam',
  'ts', 'tc', 'r5', 'hdcam', 'hdts', 'screener',
  // video codec
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1', 'vp9',
  '10bit', '8bit', 'hi10p', 'hdr', 'hdr10', 'dv', 'dolby', 'vision', 'sdr',
  // audio
  'aac', 'ac3', 'eac3', 'dts', 'dtshd', 'truehd', 'atmos', 'flac', 'mp3', 'opus',
  'ddp', 'dd', '5', '1', '2', '7', 'ma', 'hq',
  // edition / misc
  'extended', 'unrated', 'remastered', 'proper', 'repack', 'internal', 'limited',
  'dubbed', 'subbed', 'multi', 'dual', 'audio', 'complete', 'uncut', 'directors',
  'cut', 'theatrical', 'imax', 'criterion', 'anniversary', 'edition',
]);

/** Generic camera/messenger prefixes that are not a title. */
const GENERIC_STEMS = new Set([
  'video', 'vid', 'movie', 'clip', 'record', 'recording', 'screenrecord',
  'screencast', 'img', 'image', 'file', 'download', 'output', 'untitled',
  'whatsapp', 'telegram', 'signal', 'vlc', 'obs', 'capture', 'sample', 'trailer',
]);

/** Container extensions stripped before parsing. */
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|webm|flv|wmv|mpg|mpeg|ts|m2ts|ogv|3gp)$/i;

export interface ParsedFilename {
  /** Cleaned title, suitable as an OpenSubtitles `query`. */
  query: string;
  /** Four-digit year when one is present in the name. */
  year: number | null;
  /** Season number from SxxExx / 1x02 patterns. */
  season: number | null;
  episode: number | null;
}

/**
 * Turn a media filename into a search query.
 *
 * Release names carry far more metadata than title
 * (`The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv`), and passing the raw name to the
 * API returns nothing — the noise has to go. Everything from the first year or
 * resolution token onward is release metadata, so the title is what precedes it.
 *
 * Returns an empty query when nothing title-like survives (e.g. a bare
 * `video_2024-01-15_12-34-56.mp4`), which is the signal to rely on the moviehash
 * instead of sending a meaningless search.
 */
export function parseFilename(name: string): ParsedFilename {
  let base = name.replace(VIDEO_EXT, '');
  // Strip a trailing -GROUP tag.
  base = base.replace(/-[A-Za-z0-9]{2,}$/, '');
  // Bracketed groups are almost always metadata: [1080p], (2019), {Hi10}.
  base = base.replace(/[[({][^\])}]*[\])}]/g, ' ');
  // Separators → spaces. Keep alphanumerics only, so `x264-GROUP` cannot survive.
  const tokens = base
    .split(/[\s._\-+]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  let year: number | null = null;
  let season: number | null = null;
  let episode: number | null = null;
  const title: string[] = [];
  let stopped = false;

  for (const token of tokens) {
    const lower = token.toLowerCase();

    // SxxExx / SxxEyy
    const se = lower.match(/^s(\d{1,2})e(\d{1,3})$/);
    if (se) {
      season = Number(se[1]);
      episode = Number(se[2]);
      stopped = true;
      continue;
    }
    // 1x02
    const alt = lower.match(/^(\d{1,2})x(\d{1,3})$/);
    if (alt) {
      season = Number(alt[1]);
      episode = Number(alt[2]);
      stopped = true;
      continue;
    }
    // A plausible release year ends the title.
    if (/^(19|20)\d{2}$/.test(token)) {
      const value = Number(token);
      if (value >= 1900 && value <= 2099) {
        year = value;
        stopped = true;
        continue;
      }
    }
    // Any known metadata word ends the title too.
    if (RELEASE_NOISE.has(lower)) {
      stopped = true;
      continue;
    }
    if (!stopped) title.push(token);
  }

  // A "title" made only of digits/timestamps carries no information — e.g.
  // `video_2024-01-15_12-34-56`, the default Telegram name. Neither does a lone
  // generic stem: searching OpenSubtitles for "video" returns garbage, and an empty
  // query is the signal to rely on the moviehash instead.
  const query = title.join(' ').trim();
  const hasLetters = /[a-z]/i.test(query);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const onlyGeneric = words.length > 0 && words.every((w) => GENERIC_STEMS.has(w));
  return {
    query: hasLetters && !onlyGeneric ? query : '',
    year,
    season,
    episode,
  };
}

/** Human-readable label for how a result was matched. */
export function matchLabel(matchedBy: string): string {
  switch (matchedBy) {
    case 'moviehash':
      return 'Exact release match';
    case 'query':
      return 'Matched by name';
    default:
      return 'No matches';
  }
}

/**
 * Languages offered in the search panel.
 *
 * Deliberately short: the API accepts any ISO 639-1 code, but a 180-entry list in a
 * player popover is unusable. These cover the overwhelming majority of subtitle
 * availability on OpenSubtitles.
 */
export const SUB_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'bn', label: 'Bengali' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'tr', label: 'Turkish' },
  { code: 'pl', label: 'Polish' },
  { code: 'nl', label: 'Dutch' },
];
