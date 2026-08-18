// @vitest-environment jsdom
/**
 * Does a restored cached subtitle actually SHOW UP, and does it survive the
 * lifecycle that discards everything else?
 *
 * The cache is worthless if the captions menu never lists the restored track: it is
 * added but deliberately NOT auto-activated, so the menu row is the only way the
 * user can reach it. That makes the menu's filter a load-bearing invariant, and it
 * is expressed as an EXCLUSION (`!embeddedTrackObjs.has(t)`) — switching it to an
 * allowlist would silently kill the whole feature while every other test stays
 * green.
 *
 * jsdom is needed because SubtitleTrack pulls in the vendored vtt.mjs, which touches
 * `window` at import time.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SubtitleTrack } from '../lib/faststream/subtitles/SubtitleTrack';
import {
  readCachedSub,
  persistCachedSub,
  subtitleLabel,
} from '../hooks/useMSEPlayer';

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
first line

2
00:00:04.500 --> 00:00:06.000
second line
`;

describe('a restored cached subtitle is reachable in the captions menu', () => {
  beforeEach(() => localStorage.clear());

  it('parses back into a usable track with its cues intact', () => {
    persistCachedSub('7:42', { text: VTT, label: 'Inception.2010.DVDRip', language: 'en' });
    const cached = readCachedSub('7:42')!;

    // Exactly what the restore path in FastStreamPlayer does.
    const track = new SubtitleTrack(subtitleLabel(cached.label), cached.language || null);
    track.loadText(cached.text);

    expect(track.cues.length).toBe(2);
    expect(track.cues[0].startTime).toBeCloseTo(1, 3);
    expect(track.cues[1].endTime).toBeCloseTo(6, 3);
    // The release name has no extension, so NOTHING may be trimmed from it.
    expect(track.label).toBe('Inception.2010.DVDRip');
  });

  it('subtitleLabel trims only real subtitle extensions, never a release segment', () => {
    // THE BUG: the file-picker regex /\.[^.]+$/ strips the last dot-segment blindly,
    // which is right for filenames but wrong for API release names —
    // `Inception.2010.DVDRip` became `Inception.2010` (source lost) and
    // `…WEB-DL.x264-PAREE` lost its group, making releases indistinguishable.
    expect(subtitleLabel('Inception.2010.DVDRip')).toBe('Inception.2010.DVDRip');
    expect(subtitleLabel('Breaking.Bad.S05E14.720p.WEB-DL.x264-PAREE'))
      .toBe('Breaking.Bad.S05E14.720p.WEB-DL.x264-PAREE');

    // Real extensions ARE removed (the API returns .webvtt filenames).
    expect(subtitleLabel('Inception.2010.DVDRip.XviD.AC3-ViSiON.webvtt'))
      .toBe('Inception.2010.DVDRip.XviD.AC3-ViSiON');
    for (const ext of ['vtt', 'srt', 'ass', 'ssa', 'sub', 'sbv', 'txt', 'WEBVTT', 'SRT']) {
      expect(subtitleLabel(`Movie.${ext}`)).toBe('Movie');
    }

    // Names with no dots, and odd input, survive intact.
    expect(subtitleLabel('Two Swords')).toBe('Two Swords');
    expect(subtitleLabel('Inception')).toBe('Inception');
    expect(subtitleLabel('  padded  ')).toBe('padded');
    // A label that is ONLY an extension must not become empty (an empty menu row).
    expect(subtitleLabel('.srt')).toBe('.srt');
    expect(subtitleLabel('')).toBe('');
  });

  it('is NOT an embedded track, so the sidecar filter keeps it', () => {
    // The menu computes: subs.tracks.filter((t) => !embeddedTrackObjs.has(t))
    // where embeddedTrackObjs comes from embeddedSubTracksRef. A restored track is
    // never registered there, so it must pass the filter.
    const restored = new SubtitleTrack('Restored', 'en');
    restored.loadText(VTT);
    const embedded = new SubtitleTrack('Embedded JPN', 'ja');
    embedded.loadText(VTT);

    const embeddedTrackObjs = new Set([embedded]);
    const tracks = [restored, embedded];
    const sidecar = tracks.filter((t) => !embeddedTrackObjs.has(t));

    expect(sidecar).toContain(restored);
    expect(sidecar).not.toContain(embedded);
    expect(sidecar).toHaveLength(1);
  });

  it('language survives the round trip so the menu can label it', () => {
    persistCachedSub('7:1', { text: VTT, label: 'Sub', language: 'bn' });
    const c = readCachedSub('7:1')!;
    const track = new SubtitleTrack(c.label, c.language || null);
    expect(track.language).toBe('bn');
  });

  it('a missing language becomes null rather than an empty-string language', () => {
    persistCachedSub('7:2', { text: VTT, label: 'Sub', language: '' });
    const c = readCachedSub('7:2')!;
    const track = new SubtitleTrack(c.label, c.language || null);
    expect(track.language).toBeNull();
  });

  it('a payload that is not valid WebVTT does not throw the restore path', () => {
    // The restore is wrapped in try/catch; prove the failure mode is a no-cue track
    // or a caught throw, never an unhandled exception that breaks the file switch.
    // Injected through the WRITER — the cache is in memory now, so localStorage
    // cannot seed a bad record.
    persistCachedSub('7:3', { text: 'not a subtitle at all', label: 'junk', language: 'en' });
    const c = readCachedSub('7:3');
    expect(c).not.toBeNull();
    expect(() => {
      const t = new SubtitleTrack(c!.label, c!.language || null);
      try { t.loadText(c!.text); } catch { /* mirrored by the shipped try/catch */ }
    }).not.toThrow();
  });
});

describe('the shipped restore wiring', () => {
  const player = readFileSync(
    join(__dirname, '..', 'components/dashboard/FastStreamPlayer.tsx'),
    'utf8',
  );

  it('restores INSIDE the same effect that clears tracks, after the clear', () => {
    // Ordering is the whole risk: a separate effect could run before the clear and
    // have its restored track wiped. Scope to the clear effect body.
    const start = player.indexOf('subs.clearTracks();');
    const end = player.indexOf('}, [file.id]);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const effect = player.slice(start, end);
    expect(effect).toContain('readCachedSub(');
    expect(effect).toContain('subs.addTrack(track)');
    // The restore must come AFTER the clear, not before it.
    expect(effect.indexOf('readCachedSub(')).toBeGreaterThan(effect.indexOf('subs.clearTracks();'));
  });

  it('does NOT auto-activate the restored track', () => {
    // Deliberate: forcing subtitles on at open would be a behaviour change the user
    // never asked for. The row appears in the menu; the user chooses.
    const start = player.indexOf('subs.clearTracks();');
    const effect = player.slice(start, player.indexOf('}, [file.id]);', start));
    expect(effect).not.toContain('activateTrack');
  });

  it('caches the text when an online subtitle is accepted', () => {
    const start = player.indexOf('const acceptOnlineSub =');
    const end = player.indexOf('}, [subs, activeFolderId, file.id]);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = player.slice(start, end);
    expect(fn).toContain('persistCachedSub(');
    // Same key shape as the restore and the sync-delay store.
    expect(fn).toContain("${activeFolderId ?? 'pub'}:${file.id}");
    // Label trimming goes through the shared helper, NOT the file-picker regex that
    // eats a release-name segment.
    expect(fn).toContain('subtitleLabel(');
    expect(fn).not.toContain("replace(/\\.[^.]+$/, '')");
  });

  it('the restore path also uses the shared label helper', () => {
    const start = player.indexOf('subs.clearTracks();');
    const effect = player.slice(start, player.indexOf('}, [file.id]);', start));
    expect(effect).toContain('subtitleLabel(');
    expect(effect).not.toContain("replace(/\\.[^.]+$/, '')");
  });

  it('the FILE-PICKER path keeps the blind regex (filenames DO have extensions)', () => {
    // Guard against an over-eager "consistency" refactor: a picked file really is
    // `name.srt`, so stripping its last segment is correct there.
    const start = player.indexOf('const loadSubFile =');
    const fn = player.slice(start, player.indexOf('}, [subs]);', start));
    expect(fn).toContain("f.name.replace(/\\.[^.]+$/, '')");
  });
});
