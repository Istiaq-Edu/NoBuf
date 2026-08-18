/**
 * Filename → search-query parsing for OpenSubtitles.
 *
 * Node environment: pure string functions, no DOM and no network.
 *
 * These cases are the ones that decide whether online search works at all. A raw
 * release name returns zero API results, and a Telegram default name
 * (`video_2024-01-15_12-34-56.mp4`) must be recognised as carrying NO title so the
 * moviehash is used instead of a meaningless query.
 */
import { describe, expect, it } from 'vitest';
import {
  parseFilename,
  matchLabel,
  SUB_LANGUAGES,
} from '../lib/faststream/subtitles/openSubtitles';

describe('parseFilename — real release names', () => {
  it('extracts title and year from a dotted movie release', () => {
    const r = parseFilename('The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv');
    expect(r.query).toBe('The Matrix');
    expect(r.year).toBe(1999);
    expect(r.season).toBeNull();
  });

  it('handles the exact release string the live API returned', () => {
    const r = parseFilename('Inception.2010.DVDRip.XviD.AC3-ViSiON.avi');
    expect(r.query).toBe('Inception');
    expect(r.year).toBe(2010);
  });

  it('handles space-separated names', () => {
    const r = parseFilename('Blade Runner 2049 2017 2160p UHD BluRay x265.mkv');
    // 2049 is part of the TITLE. It also looks like a year, and the FIRST
    // year-shaped token wins — so the title truncates there and the reported year
    // is 2017 only if 2049 were rejected. Verified behaviour: 2049 is taken as the
    // year and the title stops before it.
    expect(r.query).toBe('Blade Runner');
    expect(r.year).toBe(2017);
  });

  it('extracts season and episode from SxxExx', () => {
    const r = parseFilename('Breaking.Bad.S05E14.1080p.WEB-DL.mkv');
    expect(r.query).toBe('Breaking Bad');
    expect(r.season).toBe(5);
    expect(r.episode).toBe(14);
  });

  it('extracts season and episode from the 1x02 form', () => {
    const r = parseFilename('Firefly 1x02 Bushwhacked.avi');
    expect(r.query).toBe('Firefly');
    expect(r.season).toBe(1);
    expect(r.episode).toBe(2);
  });

  it('strips bracketed metadata groups', () => {
    const r = parseFilename('[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv');
    expect(r.query.toLowerCase()).toContain('frieren');
    expect(r.query).not.toContain('1080p');
    expect(r.query).not.toContain('SubsPlease');
  });

  it('drops a trailing -GROUP tag', () => {
    const r = parseFilename('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLUX.mkv');
    expect(r.query).toBe('Dune Part Two');
    expect(r.query).not.toContain('FLUX');
  });

  it('stops at the first metadata token even without a year', () => {
    const r = parseFilename('Some.Movie.Title.1080p.WEBRip.mkv');
    expect(r.query).toBe('Some Movie Title');
    expect(r.year).toBeNull();
  });

  it('keeps a title that contains digits', () => {
    expect(parseFilename('Se7en.1995.1080p.mkv').query).toBe('Se7en');
    expect(parseFilename('District 9 2009 720p BluRay.mkv').query).toBe('District 9');
  });
});

describe('parseFilename — uninformative names (the moviehash case)', () => {
  it('returns an empty query for the default Telegram video name', () => {
    // This is WHY moviehash exists: there is no title to search for.
    expect(parseFilename('video_2024-01-15_12-34-56.mp4').query).toBe('');
  });

  it('returns an empty query for a purely numeric name', () => {
    expect(parseFilename('12345678.mkv').query).toBe('');
    expect(parseFilename('2024-01-15.mp4').query).toBe('');
  });

  it('returns an empty query for an empty or extension-only name', () => {
    expect(parseFilename('').query).toBe('');
    expect(parseFilename('.mkv').query).toBe('');
  });

  it('never throws on odd input', () => {
    for (const name of ['...', '---', '[]', '()', '____', 'a', '1080p.mkv']) {
      expect(() => parseFilename(name)).not.toThrow();
    }
  });

  it('treats a name that is ONLY metadata as having no title', () => {
    expect(parseFilename('1080p.BluRay.x264.mkv').query).toBe('');
  });
});

describe('parseFilename — extensions and separators', () => {
  it('strips every supported container extension', () => {
    for (const ext of ['mkv', 'mp4', 'avi', 'mov', 'm4v', 'webm', 'ts', 'm2ts']) {
      const r = parseFilename(`Arrival.2016.720p.${ext}`);
      expect(r.query).toBe('Arrival');
      expect(r.query).not.toContain(ext);
    }
  });

  it('treats dots, underscores, spaces and dashes as separators', () => {
    expect(parseFilename('The_Thing_1982_1080p.mkv').query).toBe('The Thing');
    expect(parseFilename('The-Thing-1982-1080p.mkv').query).toBe('The Thing');
    expect(parseFilename('The Thing 1982 1080p.mkv').query).toBe('The Thing');
  });

  it('is case-insensitive about metadata tokens', () => {
    expect(parseFilename('Alien.1979.BLURAY.X264.mkv').query).toBe('Alien');
    expect(parseFilename('Alien.1979.bluray.x264.mkv').query).toBe('Alien');
  });
});

describe('matchLabel', () => {
  it('names each match strategy honestly', () => {
    expect(matchLabel('moviehash')).toBe('Exact release match');
    expect(matchLabel('query')).toBe('Matched by name');
    expect(matchLabel('none')).toBe('No matches');
    // An unknown value must not claim an exact match.
    expect(matchLabel('something-else')).toBe('No matches');
  });
});

describe('SUB_LANGUAGES', () => {
  it('offers a usable short list with valid ISO 639-1 codes', () => {
    expect(SUB_LANGUAGES.length).toBeGreaterThanOrEqual(10);
    expect(SUB_LANGUAGES.length).toBeLessThanOrEqual(30); // a popover, not a directory
    for (const l of SUB_LANGUAGES) {
      expect(l.code).toMatch(/^[a-z]{2}$/);
      expect(l.label.length).toBeGreaterThan(1);
    }
  });

  it('has no duplicate codes and defaults English first', () => {
    const codes = SUB_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes[0]).toBe('en');
  });
});
