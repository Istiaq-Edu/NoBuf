// @vitest-environment jsdom
/**
 * Subtitle appearance/sync/cache state must leave NO trace on disk.
 *
 * This is the user-facing contract ("these subtitle settings should not be
 * remembered"), and it is easy to reintroduce by accident: one `updateSetting` call or
 * one `localStorage.setItem` in a future edit silently makes state durable again.
 *
 * The API key and language are the deliberate EXCEPTIONS — re-typing a credential
 * every launch is not acceptable — so they are asserted to still persist.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { persistCachedSub, readCachedSub, clearSubCache } from '../hooks/useMSEPlayer';

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
const player = src('components/dashboard/FastStreamPlayer.tsx');
const settings = src('context/SettingsContext.tsx');
const hook = src('hooks/useMSEPlayer.ts');

beforeEach(() => { clearSubCache(); localStorage.clear(); });

describe('no subtitle appearance state reaches settings.json', () => {
  it('the settings schema has no subtitle size/position keys', () => {
    expect(settings).not.toContain('playerSubtitleFontScale');
    expect(settings).not.toContain('playerSubtitleOffsetPct');
  });

  it('the player never calls updateSetting for a subtitle appearance value', () => {
    const calls = [...player.matchAll(/updateSetting\('([A-Za-z]+)'/g)].map((m) => m[1]);
    // Only the APPEARANCE keys are banned. openSubtitlesApiKey / Language / Quota are
    // the deliberate exceptions and must not trip this.
    const banned = calls.filter((k) => /^playerSubtitle/.test(k));
    expect(banned).toEqual([]);
    // Sanity: the exceptions ARE present, so this test is not passing vacuously.
    expect(calls.some((k) => k.startsWith('openSubtitles'))).toBe(true);
  });

  it('size and position live in component state, defaulting to 100% / midpoint', () => {
    expect(player).toContain('const [subFontScale, setSubFontScale] = useState(1);');
    expect(player).toContain('const [subOffsetPct, setSubOffsetPct] = useState(0);');
  });

  it('the layout memo consumes the session values, not settings', () => {
    const memoStart = player.indexOf('fontScale: subFontScale,');
    expect(memoStart).toBeGreaterThan(-1);
    const memo = player.slice(memoStart - 400, memoStart + 400);
    expect(memo).toContain('offsetPct: subOffsetPct,');
    expect(memo).not.toContain('settings.playerSubtitle');
  });
});

describe('no subtitle state reaches localStorage', () => {
  it('the delay store is gone from the hook', () => {
    expect(hook).not.toContain('nobuf-sub-delay');
    expect(hook).not.toContain('persistSubDelay');
    expect(hook).not.toContain('readPersistedSubDelay');
  });

  it('the download cache is gone from the hook', () => {
    expect(hook).not.toContain('nobuf-sub-cache');
  });

  it('caching a subtitle writes nothing to storage', () => {
    persistCachedSub('7:1', { text: 'WEBVTT\n\n', label: 'L', language: 'en' });
    expect(readCachedSub('7:1')).not.toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('the cache does not survive a simulated restart', () => {
    persistCachedSub('7:1', { text: 'WEBVTT\n\n', label: 'L', language: 'en' });
    clearSubCache();
    expect(readCachedSub('7:1')).toBeNull();
  });

  it('the PRE-EXISTING per-file track choice is untouched', () => {
    // Not part of this change: the track-selection store predates it and is tiny.
    // Asserted so a future cleanup does not remove it by association.
    expect(hook).toContain('nobuf-sub-track');
  });
});

describe('the API key and language DO still persist', () => {
  it('both remain in the settings schema with sanitizers', () => {
    // Assert the DEFAULT entries, not just any mention: the key name also appears in
    // the `Settings` type, so a grep for the bare name passes even if the persisted
    // default is deleted (a mutant survived exactly that).
    expect(settings).toContain("openSubtitlesApiKey: '',");
    expect(settings).toContain("openSubtitlesLanguage: 'en',");
    // Still declared on the type.
    expect(settings).toMatch(/openSubtitlesApiKey:\s*string;/);
    expect(settings).toMatch(/openSubtitlesLanguage:\s*string;/);
    // …and still sanitized on load, so a hand-edited file cannot throw on .trim().
    expect(settings).toContain('cleaned.openSubtitlesApiKey = sanitizeApiKey(');
    expect(settings).toContain('cleaned.openSubtitlesLanguage = sanitizeLangCode(');
  });

  it('the panel writes the language back through updateSetting', () => {
    expect(player).toContain("updateSetting('openSubtitlesLanguage', code)");
  });

  it('the key input writes through updateSetting', () => {
    expect(player).toContain("updateSetting('openSubtitlesApiKey'");
  });
});
