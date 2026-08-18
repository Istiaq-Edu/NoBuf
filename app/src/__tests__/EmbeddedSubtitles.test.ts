/**
 * Embedded subtitle track selection — pure helper tests (plan §2.5).
 *
 * Covers: buildSubTrackLabel (title/language/badges), stripControlChars
 * (the 0x07 `{\anN}` mangling from E8), normalizeSubList (kind
 * classification incl. bitmap + defensive parsing), and the per-file
 * persistence LRU (round-trip, off-marker, cap).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSubTrackLabel,
  stripControlChars,
  normalizeSubList,
  readPersistedSubTrack,
  persistSubTrack,
  SUB_TRACK_STORE_KEY,
} from '../hooks/useMSEPlayer';

// Mock Tauri invoke so useMSEPlayer imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

describe('buildSubTrackLabel', () => {
  it('uses the language name alone when there is no title', () => {
    expect(buildSubTrackLabel({ language: 'eng', position: 1 })).toBe('English');
    expect(buildSubTrackLabel({ language: 'jpn', position: 2 })).toBe('Japanese');
  });

  it('prefixes language to a cryptic title (anime "Signs & Songs" case)', () => {
    expect(buildSubTrackLabel({ title: 'Signs & Songs', language: 'eng', position: 1 }))
      .toBe('English — Signs & Songs');
  });

  it('does NOT duplicate the language when the title already contains it', () => {
    expect(buildSubTrackLabel({ title: 'English (SDH)', language: 'eng', position: 1 }))
      .toBe('English (SDH)');
  });

  it('falls back to Track N when untagged', () => {
    expect(buildSubTrackLabel({ position: 3 })).toBe('Track 3');
    expect(buildSubTrackLabel({ language: 'und', position: 2 })).toBe('Track 2');
  });

  it('appends forced/SDH badges', () => {
    expect(buildSubTrackLabel({ language: 'eng', forced: true, position: 1 }))
      .toBe('English (Forced)');
    expect(buildSubTrackLabel({ language: 'eng', sdh: true, position: 1 }))
      .toBe('English (SDH)');
    expect(buildSubTrackLabel({ language: 'eng', forced: true, sdh: true, position: 1 }))
      .toBe('English (Forced, SDH)');
  });

  it('passes unknown language codes through uppercased', () => {
    expect(buildSubTrackLabel({ language: 'epo', position: 1 })).toBe('EPO');
  });
});

describe('stripControlChars', () => {
  it('removes the 0x07 BEL byte from mangled {\\anN} tags (E8)', () => {
    // ffmpeg turns literal "{\an8}Top" inside an SRT source into "{<0x07>n8}Top".
    const mangled = '1\n00:00:01,000 --> 00:00:03,000\n{\x07n8}Top positioned\n';
    expect(stripControlChars(mangled)).toBe('1\n00:00:01,000 --> 00:00:03,000\n{n8}Top positioned\n');
  });

  it('preserves newlines, tabs and CR', () => {
    const text = 'a\r\nb\tc\n';
    expect(stripControlChars(text)).toBe(text);
  });

  it('removes other C0 bytes (NUL, ESC, VT)', () => {
    expect(stripControlChars('a\x00b\x1Bc\x0Bd')).toBe('abcd');
  });

  it('is a no-op on clean subtitle text', () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,000\nHello <i>world</i>\n';
    expect(stripControlChars(srt)).toBe(srt);
  });
});

describe('normalizeSubList', () => {
  const backendJson = {
    tracks: [
      { index: 2, codec: 'subrip', kind: 'text', language: 'eng', title: 'English',
        is_default: true, forced: false, hearing_impaired: false },
      { index: 3, codec: 'ass', kind: 'text', language: 'jpn', title: '',
        is_default: false, forced: true, hearing_impaired: false },
      { index: 4, codec: 'hdmv_pgs_subtitle', kind: 'bitmap', language: 'ger', title: '',
        is_default: false, forced: false, hearing_impaired: true },
    ],
    fonts: [
      { index: 6, filename: 'font.ttf', mimetype: 'application/x-truetype-font' },
    ],
  };

  it('normalizes tracks with labels, kinds and badges', () => {
    const { tracks, fonts } = normalizeSubList(backendJson);
    expect(tracks).toHaveLength(3);
    expect(tracks[0]).toMatchObject({ idx: 2, kind: 'text', isDefault: true, label: 'English' });
    expect(tracks[1]).toMatchObject({ idx: 3, kind: 'text', forced: true, label: 'Japanese (Forced)' });
    expect(tracks[2]).toMatchObject({ idx: 4, kind: 'bitmap', sdh: true });
    expect(fonts).toEqual([{ idx: 6, filename: 'font.ttf', mimetype: 'application/x-truetype-font' }]);
  });

  it('orders default-disposition tracks first, keeping file order otherwise', () => {
    const { tracks } = normalizeSubList({
      tracks: [
        { index: 2, codec: 'subrip', kind: 'text', language: 'ger' },
        { index: 3, codec: 'ass', kind: 'text', language: 'jpn' },
        { index: 4, codec: 'subrip', kind: 'text', language: 'eng', is_default: true },
      ],
      fonts: [],
    });
    expect(tracks.map((t) => t.idx)).toEqual([4, 2, 3]); // default hoisted, rest stable
  });

  it('maps unknown kinds to unsupported and drops invalid indexes', () => {
    const { tracks } = normalizeSubList({
      tracks: [
        { index: 5, codec: 'kate', kind: 'weird' },
        { codec: 'subrip', kind: 'text' }, // no index → dropped
      ],
      fonts: [{ filename: 'x.ttf' }], // no index → dropped
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0].kind).toBe('unsupported');
  });

  it('survives null/malformed payloads', () => {
    expect(normalizeSubList(null)).toEqual({ tracks: [], fonts: [] });
    expect(normalizeSubList({})).toEqual({ tracks: [], fonts: [] });
    expect(normalizeSubList({ tracks: 'nope', fonts: 42 })).toEqual({ tracks: [], fonts: [] });
  });
});

describe('sub-track persistence LRU', () => {
  // The vitest env has no real Storage — install a minimal in-memory stand-in
  // (same pattern as AudioTrackSelection.test.ts).
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    });
  });

  it('round-trips a choice and the explicit off marker', () => {
    expect(readPersistedSubTrack('f:1')).toBeNull();
    persistSubTrack('f:1', 3);
    expect(readPersistedSubTrack('f:1')).toBe(3);
    persistSubTrack('f:1', -1); // explicit off
    expect(readPersistedSubTrack('f:1')).toBe(-1);
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem(SUB_TRACK_STORE_KEY, '{{{');
    expect(readPersistedSubTrack('f:1')).toBeNull();
    persistSubTrack('f:1', 2); // must not throw
    expect(readPersistedSubTrack('f:1')).toBe(2);
  });

  it('evicts the oldest entries beyond the cap (200)', () => {
    for (let i = 0; i < 205; i++) persistSubTrack(`f:${i}`, i);
    expect(readPersistedSubTrack('f:0')).toBeNull();   // evicted
    expect(readPersistedSubTrack('f:4')).toBeNull();   // evicted
    expect(readPersistedSubTrack('f:5')).toBe(5);      // survived
    expect(readPersistedSubTrack('f:204')).toBe(204);  // newest
  });

  it('re-inserting an existing key refreshes its LRU position', () => {
    for (let i = 0; i < 200; i++) persistSubTrack(`f:${i}`, i);
    persistSubTrack('f:0', 99); // refresh oldest
    persistSubTrack('f:new1', 1);
    persistSubTrack('f:new2', 2);
    expect(readPersistedSubTrack('f:0')).toBe(99); // survived (refreshed)
    expect(readPersistedSubTrack('f:1')).toBeNull(); // evicted instead
  });

  it('keeps audio and subtitle stores separate', () => {
    persistSubTrack('f:1', 3);
    expect(localStorage.getItem('nobuf-audio-track')).toBeNull();
  });
});
