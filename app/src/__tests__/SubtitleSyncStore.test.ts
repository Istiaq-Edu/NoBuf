// @vitest-environment jsdom
/**
 * Per-file subtitle sync delay store + the settings sanitizer.
 *
 * jsdom for localStorage. The LRU shape mirrors persistSubTrack (cap 200,
 * delete-then-reinsert for recency), so the same eviction assertions apply.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import {
  SUB_DELAY_STORE_KEY,
  SUB_DELAY_LIMIT_S,
  clampSubDelay,
  readPersistedSubDelay,
  persistSubDelay,
  SUB_CACHE_STORE_KEY,
  SUB_CACHE_MAX_BYTES,
  SUB_CACHE_MAX_ENTRY_BYTES,
  readCachedSub,
  persistCachedSub,
  evictSubCache,
} from '../hooks/useMSEPlayer';
import { clampSetting, sanitizeApiKey, sanitizeLangCode, parseQuotaResetAt, liveQuota, formatResetIn } from '../context/SettingsContext';

beforeEach(() => localStorage.clear());

describe('clampSubDelay', () => {
  it('passes through in-range values including negatives', () => {
    for (const v of [0, 0.05, -0.05, 2.5, -2.5, 10, -10]) {
      expect(clampSubDelay(v)).toBe(v);
    }
  });

  it('clamps beyond the ±limit', () => {
    expect(clampSubDelay(999)).toBe(SUB_DELAY_LIMIT_S);
    expect(clampSubDelay(-999)).toBe(-SUB_DELAY_LIMIT_S);
  });

  it('maps every non-finite value to 0, never NaN', () => {
    // A NaN delay would make activeCues(cues, NaN) return [] — zero subtitles,
    // silently, with no error. It must degrade to "no delay" instead.
    for (const v of [NaN, Infinity, -Infinity, undefined as unknown as number]) {
      expect(clampSubDelay(v)).toBe(0);
      expect(Number.isFinite(clampSubDelay(v))).toBe(true);
    }
  });
});

describe('per-file sync delay persistence', () => {
  it('round-trips a delay for a file key', () => {
    persistSubDelay('f:1', 2.5);
    expect(readPersistedSubDelay('f:1')).toBe(2.5);
  });

  it('keeps delays independent per file', () => {
    persistSubDelay('f:1', 2.5);
    persistSubDelay('f:2', -1.25);
    expect(readPersistedSubDelay('f:1')).toBe(2.5);
    expect(readPersistedSubDelay('f:2')).toBe(-1.25);
  });

  it('returns 0 for an unknown key', () => {
    expect(readPersistedSubDelay('never-seen')).toBe(0);
  });

  it('clamps on write and on read', () => {
    persistSubDelay('f:1', 999);
    expect(readPersistedSubDelay('f:1')).toBe(SUB_DELAY_LIMIT_S);
    // A value written out-of-range by an older build must still read back clamped.
    localStorage.setItem(SUB_DELAY_STORE_KEY, JSON.stringify({ 'f:2': -500 }));
    expect(readPersistedSubDelay('f:2')).toBe(-SUB_DELAY_LIMIT_S);
  });

  it('never throws and never returns NaN on corrupt storage', () => {
    for (const junk of ['not json', '[]', 'null', '{"f:1":"abc"}', '{"f:1":null}']) {
      localStorage.setItem(SUB_DELAY_STORE_KEY, junk);
      const got = readPersistedSubDelay('f:1');
      expect(Number.isFinite(got)).toBe(true);
      expect(got).toBe(0);
    }
  });

  it('writing a non-finite delay stores 0 rather than corrupting the map', () => {
    persistSubDelay('f:1', NaN);
    expect(readPersistedSubDelay('f:1')).toBe(0);
    expect(JSON.parse(localStorage.getItem(SUB_DELAY_STORE_KEY)!)['f:1']).toBe(0);
  });

  it('evicts oldest entries past the 200-key cap', () => {
    for (let i = 0; i < 205; i++) persistSubDelay(`f:${i}`, i % 7);
    const map = JSON.parse(localStorage.getItem(SUB_DELAY_STORE_KEY)!);
    expect(Object.keys(map).length).toBeLessThanOrEqual(200);
    expect(map['f:0']).toBeUndefined();   // evicted
    expect(map['f:204']).toBeDefined();   // newest kept
  });

  it('re-writing a key refreshes its recency so it survives eviction', () => {
    // The refresh is `delete map[k]` before re-inserting: without it the key keeps
    // its ORIGINAL insertion position and is evicted first, because eviction walks
    // Object.keys() in insertion order.
    // Fill to the cap, touch the oldest key, then overflow by enough that the
    // untouched-oldest window is provably evicted while the touched key survives.
    for (let i = 0; i < 200; i++) persistSubDelay(`f:${i}`, 1);
    persistSubDelay('f:0', 3);                 // touch the OLDEST → must move to newest
    for (let i = 0; i < 5; i++) persistSubDelay(`f:new${i}`, 4); // force 5 evictions

    const map = JSON.parse(localStorage.getItem(SUB_DELAY_STORE_KEY)!);
    expect(Object.keys(map).length).toBeLessThanOrEqual(200);
    // f:0 was re-inserted at the newest position, so the 5 evictions took
    // f:1..f:5 instead of f:0.
    expect(map['f:0']).toBe(3);
    for (let i = 1; i <= 5; i++) expect(map[`f:${i}`]).toBeUndefined();
    expect(map['f:6']).toBeDefined();
  });

  it('is independent of the sub-TRACK store (separate localStorage keys)', () => {
    persistSubDelay('f:1', 2.5);
    expect(localStorage.getItem('nobuf-sub-track')).toBeNull();
    expect(SUB_DELAY_STORE_KEY).not.toBe('nobuf-sub-track');
  });
});

describe('clampSetting (persisted subtitle size/position sanitizer)', () => {
  it('passes through in-range values', () => {
    expect(clampSetting(1.5, 0.5, 3, 1)).toBe(1.5);
    expect(clampSetting(0, 0, 40, 0)).toBe(0);
  });

  it('clamps out-of-range values to the bounds', () => {
    expect(clampSetting(99, 0.5, 3, 1)).toBe(3);
    expect(clampSetting(-99, 0.5, 3, 1)).toBe(0.5);
    expect(clampSetting(1000, 0, 40, 0)).toBe(40);
  });

  it('falls back for non-finite or non-numeric stored values', () => {
    // A corrupt settings.json must not put NaN into an inline px style.
    for (const v of [NaN, Infinity, -Infinity, undefined]) {
      expect(clampSetting(v as number | undefined, 0.5, 3, 1)).toBe(1);
    }
    expect(clampSetting('2' as unknown as number, 0.5, 3, 1)).toBe(1);
  });
});

describe('sanitizeApiKey (persisted OpenSubtitles credential)', () => {
  it('keeps a well-formed key', () => {
    // A synthetic 32-char alphanumeric key. NEVER put a real credential in a test.
    const KEY = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
    expect(KEY).toHaveLength(32);
    expect(sanitizeApiKey(KEY, '')).toBe(KEY);
  });

  it('trims whitespace from a pasted key', () => {
    expect(sanitizeApiKey('  abc123DEF  ', '')).toBe('abc123DEF');
    expect(sanitizeApiKey('\tabc123\n', '')).toBe('abc123');
  });

  it('treats an empty or blank value as no key', () => {
    expect(sanitizeApiKey('', 'fallback')).toBe('');
    expect(sanitizeApiKey('   ', 'fallback')).toBe('');
  });

  it('falls back for a non-string from a hand-edited settings.json', () => {
    // The panel calls apiKey.trim(); a number/object/null would THROW there and
    // take the whole captions menu down.
    for (const bad of [42, null, undefined, {}, [], true]) {
      expect(sanitizeApiKey(bad, 'fb')).toBe('fb');
    }
  });

  it('rejects a value that could smuggle a header or newline', () => {
    // The key goes into an Api-Key HTTP header on the Rust side.
    expect(sanitizeApiKey('abc\r\nX-Evil: 1', 'fb')).toBe('fb');
    expect(sanitizeApiKey('abc def', 'fb')).toBe('fb');
    expect(sanitizeApiKey('abc:123', 'fb')).toBe('fb');
  });

  it('always returns a string that survives .trim()', () => {
    for (const v of [42, null, 'ok123', '  ', {}, 'a:b']) {
      expect(typeof sanitizeApiKey(v, '').trim()).toBe('string');
    }
  });
});

describe('sanitizeLangCode (persisted search language)', () => {
  it('keeps a valid ISO 639-1 code', () => {
    expect(sanitizeLangCode('en', 'en')).toBe('en');
    expect(sanitizeLangCode('bn', 'en')).toBe('bn');
  });

  it('normalises case and whitespace', () => {
    expect(sanitizeLangCode(' EN ', 'en')).toBe('en');
    expect(sanitizeLangCode('Fr', 'en')).toBe('fr');
  });

  it('falls back for anything that is not a 2-letter code', () => {
    for (const bad of ['eng', 'e', '', 'e1', '12', 'zz9', 7, null, undefined, {}]) {
      expect(sanitizeLangCode(bad, 'en')).toBe('en');
    }
  });

  it('cannot inject a URL parameter (it reaches a query string)', () => {
    expect(sanitizeLangCode('en&order_by=votes', 'en')).toBe('en');
  });
});

describe('parseQuotaResetAt (OpenSubtitles reports reset as PROSE, not a timestamp)', () => {
  const NOW = 1_700_000_000_000;

  it('parses the exact string the live API returned', () => {
    // Verified live: reset_time: "09 hours and 10 minutes"
    const at = parseQuotaResetAt('09 hours and 10 minutes', NOW);
    expect(at).toBe(NOW + (9 * 60 + 10) * 60_000);
  });

  it('handles hours-only and minutes-only forms', () => {
    expect(parseQuotaResetAt('3 hours', NOW)).toBe(NOW + 180 * 60_000);
    expect(parseQuotaResetAt('45 minutes', NOW)).toBe(NOW + 45 * 60_000);
    expect(parseQuotaResetAt('1 hour and 1 minute', NOW)).toBe(NOW + 61 * 60_000);
  });

  it('returns null for anything unparseable rather than guessing', () => {
    // Guessing optimistically would re-enable buttons the API will reject.
    for (const bad of ['', '   ', 'soon', 'tomorrow', 'reset pending']) {
      expect(parseQuotaResetAt(bad, NOW)).toBeNull();
    }
  });

  it('returns null for a non-string', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(parseQuotaResetAt(bad as unknown as string, NOW)).toBeNull();
    }
  });

  it('rejects a window longer than a day (format misread)', () => {
    // Daily quota can never reset in 40 hours; treat as unknown, do not lock out.
    expect(parseQuotaResetAt('40 hours', NOW)).toBeNull();
    expect(parseQuotaResetAt('0 hours and 0 minutes', NOW)).toBeNull();
  });

  it('always returns a FUTURE instant when it parses', () => {
    for (const s of ['1 minute', '23 hours and 59 minutes', '9 hours']) {
      const at = parseQuotaResetAt(s, NOW)!;
      expect(at).toBeGreaterThan(NOW);
    }
  });
});

describe('liveQuota (a persisted daily quota must EXPIRE)', () => {
  const NOW = 1_700_000_000_000;

  it('passes through a quota that has not reset yet', () => {
    expect(liveQuota({ remaining: 4, resetAtMs: NOW + 60_000 }, NOW))
      .toEqual({ remaining: 4, resetAtMs: NOW + 60_000 });
  });

  it('drops a quota whose reset has passed', () => {
    // THE BUG THIS PREVENTS: yesterday's "0 left" would disable the download
    // buttons forever, with no way for the user to recover.
    expect(liveQuota({ remaining: 0, resetAtMs: NOW - 1 }, NOW)).toBeNull();
    expect(liveQuota({ remaining: 0, resetAtMs: NOW }, NOW)).toBeNull();
  });

  it('treats missing or corrupt storage as unknown', () => {
    for (const bad of [null, undefined, {}, { remaining: 4 }, { resetAtMs: NOW + 1 },
                       { remaining: 'x', resetAtMs: NOW + 1 }, { remaining: NaN, resetAtMs: NOW + 1 },
                       { remaining: 4, resetAtMs: NaN }, 'nope', 42]) {
      expect(liveQuota(bad as never, NOW)).toBeNull();
    }
  });

  it('floors and clamps a nonsense remaining count', () => {
    expect(liveQuota({ remaining: -5, resetAtMs: NOW + 1000 }, NOW)!.remaining).toBe(0);
    expect(liveQuota({ remaining: 3.7, resetAtMs: NOW + 1000 }, NOW)!.remaining).toBe(3);
  });

  it('round-trips a parsed reset time', () => {
    const at = parseQuotaResetAt('2 hours', NOW)!;
    const live = liveQuota({ remaining: 5, resetAtMs: at }, NOW);
    expect(live).not.toBeNull();
    // ...and is gone once that window elapses.
    expect(liveQuota({ remaining: 5, resetAtMs: at }, at + 1)).toBeNull();
  });
});

describe('formatResetIn', () => {
  const NOW = 1_700_000_000_000;

  it('formats hours and minutes compactly', () => {
    expect(formatResetIn(NOW + (9 * 60 + 10) * 60_000, NOW)).toBe('9h 10m');
    expect(formatResetIn(NOW + 120 * 60_000, NOW)).toBe('2h');
    expect(formatResetIn(NOW + 45 * 60_000, NOW)).toBe('45m');
  });

  it('is empty for a past or invalid deadline', () => {
    expect(formatResetIn(NOW - 1, NOW)).toBe('');
    expect(formatResetIn(NOW, NOW)).toBe('');
    expect(formatResetIn(NaN, NOW)).toBe('');
  });

  it('rounds partial minutes up so it never reads 0m while time remains', () => {
    expect(formatResetIn(NOW + 30_000, NOW)).toBe('1m');
  });
});

describe('downloaded-subtitle cache (5 downloads/day makes a re-open expensive)', () => {
  beforeEach(() => localStorage.clear());

  const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nhello\n';
  const entry = { text: VTT, label: 'Inception.2010.DVDRip', language: 'en' };

  it('round-trips a downloaded subtitle for the same file key', () => {
    // THE POINT: clearTracks() drops the track on close; without this the user
    // spends another of 5 daily downloads to watch the same file again.
    expect(readCachedSub('7:1234')).toBeNull();
    persistCachedSub('7:1234', entry);
    expect(readCachedSub('7:1234')).toEqual(entry);
  });

  it('is keyed per file — one file never returns another file\'s subtitle', () => {
    persistCachedSub('7:1', { ...entry, label: 'first' });
    persistCachedSub('7:2', { ...entry, label: 'second' });
    expect(readCachedSub('7:1')!.label).toBe('first');
    expect(readCachedSub('7:2')!.label).toBe('second');
    expect(readCachedSub('7:3')).toBeNull();
  });

  it('overwrites the entry when a different subtitle is picked for the same file', () => {
    persistCachedSub('7:1', { ...entry, label: 'old' });
    persistCachedSub('7:1', { ...entry, label: 'new' });
    expect(readCachedSub('7:1')!.label).toBe('new');
    const map = JSON.parse(localStorage.getItem(SUB_CACHE_STORE_KEY)!);
    expect(Object.keys(map)).toHaveLength(1);
  });

  it('ignores an empty key or empty text', () => {
    persistCachedSub('', entry);
    persistCachedSub('7:9', { ...entry, text: '' });
    expect(readCachedSub('')).toBeNull();
    expect(readCachedSub('7:9')).toBeNull();
  });

  it('skips an oversized payload instead of evicting everything for it', () => {
    persistCachedSub('7:keep', entry);
    const huge = { ...entry, text: 'x'.repeat(SUB_CACHE_MAX_ENTRY_BYTES + 1) };
    persistCachedSub('7:huge', huge);
    expect(readCachedSub('7:huge')).toBeNull();
    // The existing entry must survive the rejected write.
    expect(readCachedSub('7:keep')).toEqual(entry);
  });

  it('survives corrupt storage without losing good entries', () => {
    localStorage.setItem(SUB_CACHE_STORE_KEY, '{not json');
    expect(readCachedSub('7:1')).toBeNull();
    // A write recovers rather than throwing.
    persistCachedSub('7:1', entry);
    expect(readCachedSub('7:1')).toEqual(entry);
  });

  // ---- Mutation-driven gap closers ------------------------------------
  // The four tests below exist because mutants SURVIVED without them: the suite
  // tested evictSubCache in isolation and never proved persistCachedSub CALLS it.

  it('persistCachedSub ACTUALLY enforces the byte budget (not just evictSubCache)', () => {
    // C1: deleting the evictSubCache call from persistCachedSub passed all 53 tests.
    // Isolation proves nothing about integration — bind the shipped writer.
    const big = 'x'.repeat(200 * 1024); // 200 KB each, under the per-entry cap
    for (let i = 0; i < 20; i++) {
      persistCachedSub(`f:${i}`, { text: big, label: `L${i}`, language: 'en' });
    }
    const stored = localStorage.getItem(SUB_CACHE_STORE_KEY)!;
    expect(stored.length).toBeLessThanOrEqual(SUB_CACHE_MAX_BYTES + 64 * 1024);
    const map = JSON.parse(stored);
    expect(Object.keys(map).length).toBeLessThan(20);
    // Newest survives, oldest is gone.
    expect(map['f:19']).toBeDefined();
    expect(map['f:0']).toBeUndefined();
  });

  it('re-saving a file REFRESHES its LRU position so it is not evicted next', () => {
    // C5: dropping the delete-before-insert kept every test green.
    const big = 'x'.repeat(200 * 1024);
    persistCachedSub('f:a', { text: big, label: 'a', language: 'en' });
    persistCachedSub('f:b', { text: big, label: 'b', language: 'en' });
    // Touch 'a' again — it must now be NEWER than 'b'.
    persistCachedSub('f:a', { text: big, label: 'a2', language: 'en' });
    const order = Object.keys(JSON.parse(localStorage.getItem(SUB_CACHE_STORE_KEY)!));
    expect(order.indexOf('f:a')).toBeGreaterThan(order.indexOf('f:b'));
    expect(readCachedSub('f:a')!.label).toBe('a2');
  });

  it('never stores an entry with empty text', () => {
    // C7: without this, `{text:''}` was written and read back as a usable track.
    persistCachedSub('f:empty', { text: '', label: 'L', language: 'en' });
    const raw = localStorage.getItem(SUB_CACHE_STORE_KEY);
    expect(raw === null || JSON.parse(raw)['f:empty'] === undefined).toBe(true);
    expect(readCachedSub('f:empty')).toBeNull();
  });

  it('rejects a stored entry whose text is an empty string', () => {
    // C9: an empty-text record must not read back as a cache HIT — loadText('')
    // yields a track with zero cues, i.e. subtitles that silently never appear.
    localStorage.setItem(SUB_CACHE_STORE_KEY, JSON.stringify({
      'f:1': { text: '', label: 'L', language: 'en' },
    }));
    expect(readCachedSub('f:1')).toBeNull();
  });

  it('drops individually malformed records but keeps valid neighbours', () => {
    localStorage.setItem(SUB_CACHE_STORE_KEY, JSON.stringify({
      'bad:1': 42,
      'bad:2': { text: 123, label: 'x', language: 'en' },
      'bad:3': { label: 'no text', language: 'en' },
      'bad:4': null,
      'good:1': entry,
    }));
    expect(readCachedSub('bad:1')).toBeNull();
    expect(readCachedSub('bad:2')).toBeNull();
    expect(readCachedSub('bad:3')).toBeNull();
    expect(readCachedSub('bad:4')).toBeNull();
    expect(readCachedSub('good:1')).toEqual(entry);
  });
});

describe('evictSubCache (byte budget, oldest-first)', () => {
  const mk = (text: string) => ({ text, label: 'L', language: 'en' });

  it('keeps everything when under budget', () => {
    const map = { a: mk('x'.repeat(10)), b: mk('y'.repeat(10)) };
    expect(Object.keys(evictSubCache(map, 1000))).toEqual(['a', 'b']);
  });

  it('evicts OLDEST first (insertion order is LRU order)', () => {
    // persistCachedSub deletes before re-inserting, so key order is oldest→newest.
    const map = { oldest: mk('x'.repeat(100)), mid: mk('y'.repeat(100)), newest: mk('z'.repeat(100)) };
    const out = evictSubCache(map, 220);
    expect(out.oldest).toBeUndefined();
    expect(Object.keys(out)).toEqual(['mid', 'newest']);
  });

  it('evicts as many as needed to fit', () => {
    const map = { a: mk('x'.repeat(100)), b: mk('y'.repeat(100)), c: mk('z'.repeat(100)) };
    expect(Object.keys(evictSubCache(map, 110))).toEqual(['c']);
  });

  it('can empty the map when even one entry will not fit', () => {
    expect(evictSubCache({ a: mk('x'.repeat(100)) }, 5)).toEqual({});
  });

  it('counts the key and label, not just the text', () => {
    // Under-counting size is how a byte-capped cache silently overflows the quota.
    const longKey = 'k'.repeat(200);
    const out = evictSubCache({ [longKey]: mk('x'.repeat(50)) }, 100);
    expect(out[longKey]).toBeUndefined();
  });

  it('does not mutate the input map', () => {
    const map = { a: mk('x'.repeat(100)), b: mk('y'.repeat(100)) };
    evictSubCache(map, 10);
    expect(Object.keys(map)).toEqual(['a', 'b']);
  });

  it('enforces the shipped budget against a realistic payload size', () => {
    // A real download measured 127,277 bytes, so a 200-ENTRY cap (like the delay
    // store's) would permit ~25 MB and blow the ~5 MB localStorage quota.
    const real = 127_277;
    expect(SUB_CACHE_MAX_BYTES).toBeLessThan(5 * 1024 * 1024);
    expect(Math.floor(SUB_CACHE_MAX_BYTES / real)).toBeGreaterThanOrEqual(10);
    const map: Record<string, { text: string; label: string; language: string }> = {};
    for (let i = 0; i < 40; i++) map[`f:${i}`] = mk('x'.repeat(real));
    const kept = Object.keys(evictSubCache(map, SUB_CACHE_MAX_BYTES)).length;
    expect(kept).toBeLessThan(40);
    expect(kept).toBeGreaterThan(5);
  });
});
