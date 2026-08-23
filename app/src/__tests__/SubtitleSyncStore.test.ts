// @vitest-environment jsdom
/**
 * Per-file subtitle sync delay store + the settings sanitizer.
 *
 * jsdom for localStorage. The LRU shape mirrors persistSubTrack (cap 200,
 * delete-then-reinsert for recency), so the same eviction assertions apply.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SUB_DELAY_LIMIT_S,
  clampSubDelay,
  SUB_CACHE_MAX_BYTES,
  SUB_CACHE_MAX_ENTRY_BYTES,
  readCachedSub,
  persistCachedSub,
  clearSubCache,
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

describe('sync delay is SESSION-ONLY (deliberately not persisted)', () => {
  it('exports no delay store key or writer', async () => {
    // The per-file delay used to live in localStorage under 'nobuf-sub-delay'.
    // It is now plain component state: nothing subtitle-related writes to disk.
    const mod = await import('../hooks/useMSEPlayer');
    expect('SUB_DELAY_STORE_KEY' in mod).toBe(false);
    expect('persistSubDelay' in mod).toBe(false);
    expect('readPersistedSubDelay' in mod).toBe(false);
  });

  it('leaves no delay entry in localStorage', () => {
    // Guard against a reintroduced write under the old (or any) key.
    expect(localStorage.getItem('nobuf-sub-delay')).toBeNull();
  });

  it('the player resets the delay to 0 on every file change', () => {
    const player = readFileSync(
      join(__dirname, '..', 'components/dashboard/FastStreamPlayer.tsx'),
      'utf8',
    );
    expect(player).toContain('useEffect(() => { setSubDelay(0); }, [subFileKey]);');
    // …and the setter must not persist anything.
    const applyStart = player.indexOf('const applySubDelay =');
    const apply = player.slice(applyStart, player.indexOf('}, [', applyStart));
    expect(apply).toContain('setSubDelay(clampSubDelay(seconds))');
    expect(apply).not.toContain('persistSubDelay');
  });

  it('clampSubDelay is still applied so the slider cannot exceed its bounds', () => {
    // The clamp survives the persistence removal — it guards the live value.
    expect(clampSubDelay(999)).toBe(SUB_DELAY_LIMIT_S);
    expect(clampSubDelay(-999)).toBe(-SUB_DELAY_LIMIT_S);
    expect(clampSubDelay(NaN)).toBe(0);
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

describe('downloaded-subtitle cache — SESSION-ONLY, in memory (never on disk)', () => {
  beforeEach(() => { clearSubCache(); localStorage.clear(); });

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
    // One logical entry: the old label must be gone, not shadowed.
    expect(readCachedSub('7:1')!.label).toBe('new');
    expect(readCachedSub('7:1')!.text).toBe(VTT);
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

  it('writes NOTHING to localStorage — this is the whole point', () => {
    persistCachedSub('7:1', entry);
    expect(readCachedSub('7:1')).toEqual(entry);
    // No key, old or new, may appear on disk.
    expect(localStorage.getItem('nobuf-sub-cache')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('a fresh session starts empty (restart semantics)', () => {
    persistCachedSub('7:1', entry);
    expect(readCachedSub('7:1')).not.toBeNull();
    clearSubCache(); // stands in for a process restart
    expect(readCachedSub('7:1')).toBeNull();
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
    // Count what SURVIVED through the public reader.
    let kept = 0;
    let bytes = 0;
    for (let i = 0; i < 20; i++) {
      const hit = readCachedSub(`f:${i}`);
      if (hit) { kept += 1; bytes += hit.text.length; }
    }
    expect(bytes).toBeLessThanOrEqual(SUB_CACHE_MAX_BYTES);
    expect(kept).toBeLessThan(20);
    // Newest survives, oldest is evicted.
    expect(readCachedSub('f:19')).not.toBeNull();
    expect(readCachedSub('f:0')).toBeNull();
  });

  it('re-saving a file REFRESHES its LRU position so it is not evicted next', () => {
    // C5: dropping the delete-before-insert kept every test green.
    const big = 'x'.repeat(200 * 1024);
    persistCachedSub('f:a', { text: big, label: 'a', language: 'en' });
    persistCachedSub('f:b', { text: big, label: 'b', language: 'en' });
    // Touch 'a' again — it must now be NEWER than 'b'.
    persistCachedSub('f:a', { text: big, label: 'a2', language: 'en' });
    // 'a' was touched last, so it must outlive 'b' once the budget forces eviction.
    // 9 fills is the exact count that pushes past the 2MB budget by ONE entry: the
    // eviction walks oldest-first and must stop after removing 'b'. (10 fills evicts
    // both and proves nothing about ordering; 8 evicts neither.)
    const big2 = 'y'.repeat(200 * 1024);
    for (let i = 0; i < 9; i++) {
      persistCachedSub(`f:fill${i}`, { text: big2, label: 'x', language: 'en' });
    }
    expect(readCachedSub('f:b')).toBeNull();
    expect(readCachedSub('f:a')!.label).toBe('a2');
  });

  it('never stores an entry with empty text', () => {
    // C7: without this, `{text:''}` was written and read back as a usable track.
    persistCachedSub('f:empty', { text: '', label: 'L', language: 'en' });
    expect(readCachedSub('f:empty')).toBeNull();
    expect(localStorage.getItem('nobuf-sub-cache')).toBeNull();
  });

  it('an empty-text entry never becomes a cache HIT', () => {
    // C9: loadText('') yields a track with zero cues — subtitles that silently never
    // appear. The writer rejects it, so a read can never observe one.
    persistCachedSub('f:1', { text: '', label: 'L', language: 'en' });
    expect(readCachedSub('f:1')).toBeNull();
    // …and a whitespace-only payload is still text, so it IS stored (parsing it is
    // the parser's job, not the cache's).
    persistCachedSub('f:2', { text: ' ', label: 'L', language: 'en' });
    expect(readCachedSub('f:2')).not.toBeNull();
  });

  it('a malformed entry cannot be injected through the writer', () => {
    // The old localStorage store could be hand-edited, so the reader validated each
    // record. In memory the writer is the only door: prove it rejects junk and that
    // valid neighbours are untouched.
    persistCachedSub('good:1', entry);
    persistCachedSub('bad:1', { text: '', label: 'x', language: 'en' });
    persistCachedSub('', entry);
    // @ts-expect-error deliberately wrong shape at the boundary
    persistCachedSub('bad:2', { label: 'no text', language: 'en' });
    expect(readCachedSub('bad:1')).toBeNull();
    expect(readCachedSub('bad:2')).toBeNull();
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
