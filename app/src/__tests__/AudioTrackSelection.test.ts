import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAudioTrackLabel,
  pickDefaultAudioTrack,
  planAudioSwitch,
  withAudioIdx,
  readPersistedAudioTrack,
  persistAudioTrack,
  AUDIO_TRACK_STORE_KEY,
  type AudioTrackInfo,
} from '../hooks/useMSEPlayer';

// Mock Tauri invoke so useMSEPlayer imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

const track = (over: Partial<AudioTrackInfo>): AudioTrackInfo => ({
  id: 1, label: '', language: '', codec: 'aac', channels: 2,
  isDefault: false, playable: true, ...over,
});

describe('buildAudioTrackLabel', () => {
  it('prefers explicit title, always appends codec/channels (E9 dedup)', () => {
    expect(buildAudioTrackLabel({ title: 'Director Commentary', codec: 'aac', channels: 2, position: 1 }))
      .toBe('Director Commentary — AAC Stereo');
  });
  it('maps ISO 639-2 language codes to names', () => {
    expect(buildAudioTrackLabel({ language: 'jpn', codec: 'aac', channels: 2, position: 1 }))
      .toBe('Japanese — AAC Stereo');
    expect(buildAudioTrackLabel({ language: 'eng', codec: 'ac3', channels: 6, position: 2 }))
      .toBe('English — AC3 5.1');
  });
  it('uppercases unknown language codes instead of dropping them', () => {
    expect(buildAudioTrackLabel({ language: 'epo', codec: 'aac', channels: 2, position: 1 }))
      .toBe('EPO — AAC Stereo');
  });
  it("falls back to 'Track N' for untagged/und tracks (E9)", () => {
    expect(buildAudioTrackLabel({ position: 2, codec: 'aac', channels: 2 }))
      .toBe('Track 2 — AAC Stereo');
    expect(buildAudioTrackLabel({ language: 'und', position: 3, codec: 'opus', channels: 1 }))
      .toBe('Track 3 — OPUS Mono');
  });
  it('normalizes mp4a codec strings to AAC and handles 7.1/Nch layouts', () => {
    expect(buildAudioTrackLabel({ language: 'eng', codec: 'mp4a.40.2', channels: 8, position: 1 }))
      .toBe('English — AAC 7.1');
    expect(buildAudioTrackLabel({ language: 'eng', codec: 'flac', channels: 3, position: 1 }))
      .toBe('English — FLAC 3ch');
  });
  it('bare label when codec/channels unknown', () => {
    expect(buildAudioTrackLabel({ language: 'jpn', position: 1 })).toBe('Japanese');
  });
});

describe('pickDefaultAudioTrack', () => {
  const jp = track({ id: 1, language: 'jpn', isDefault: true });
  const en = track({ id: 2, language: 'eng' });
  const dts = track({ id: 3, language: 'eng', codec: 'dts', playable: false });

  it('returns null for empty list (E1)', () => {
    expect(pickDefaultAudioTrack([])).toBeNull();
  });
  it('persisted choice wins when present and playable (E10)', () => {
    expect(pickDefaultAudioTrack([jp, en], 2)).toBe(en);
  });
  it('ignores persisted id that no longer exists (E10)', () => {
    expect(pickDefaultAudioTrack([jp, en], 99)).toBe(jp);
  });
  it('ignores persisted id pointing at an unplayable track', () => {
    expect(pickDefaultAudioTrack([jp, dts], 3)).toBe(jp);
  });
  it('disposition default > first playable > first', () => {
    expect(pickDefaultAudioTrack([en, jp])).toBe(jp);          // default flag wins
    expect(pickDefaultAudioTrack([dts, en])).toBe(en);         // skip unplayable
    expect(pickDefaultAudioTrack([dts])).toBe(dts);            // all unplayable → first
  });
});

describe('planAudioSwitch', () => {
  it('remux tier always rebuilds (ffmpeg re-encodes to AAC)', () => {
    expect(planAudioSwitch({ tier: 'remux', targetPlayable: false })).toBe('rebuild');
  });
  it('ts tier rejects (mpegts.js has no track selection — scope cut)', () => {
    expect(planAudioSwitch({ tier: 'ts', targetPlayable: true })).toBe('reject');
  });
  it('unplayable target reroutes via remux (H3)', () => {
    expect(planAudioSwitch({ tier: 'mkv', targetPlayable: false })).toBe('reroute-remux');
    expect(planAudioSwitch({ tier: 'mp4', targetPlayable: false })).toBe('reroute-remux');
  });
  it('same mime → plain rebuild', () => {
    expect(planAudioSwitch({
      tier: 'mkv', targetPlayable: true,
      currentMime: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
      newMime: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
      isTypeSupportedFn: () => true,
    })).toBe('rebuild');
  });
  it('mime change + supported → rebuild-changetype (H1)', () => {
    expect(planAudioSwitch({
      tier: 'mkv', targetPlayable: true,
      currentMime: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
      newMime: 'video/mp4; codecs="avc1.64001f, opus"',
      isTypeSupportedFn: () => true,
    })).toBe('rebuild-changetype');
  });
  it('mime change + UNsupported → reroute-remux (H1 fallback, never dead SB)', () => {
    expect(planAudioSwitch({
      tier: 'mkv', targetPlayable: true,
      currentMime: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
      newMime: 'video/mp4; codecs="avc1.64001f, ac-3"',
      isTypeSupportedFn: () => false,
    })).toBe('reroute-remux');
  });
});

describe('withAudioIdx', () => {
  const base = 'http://127.0.0.1:8080/remux/home/84?token=abc&hevc_ok=false';

  it('appends audio_idx preserving existing params (E11)', () => {
    const out = withAudioIdx(base, 2);
    expect(out).toContain('audio_idx=2');
    expect(out).toContain('token=abc');
    expect(out).toContain('hevc_ok=false');
  });
  it('is idempotent — replaces an existing audio_idx, never duplicates', () => {
    const once = withAudioIdx(base, 2);
    const twice = withAudioIdx(once, 3);
    expect(twice.match(/audio_idx=/g)).toHaveLength(1);
    expect(twice).toContain('audio_idx=3');
  });
  it('removes the param when idx is null (revert to primary)', () => {
    const out = withAudioIdx(withAudioIdx(base, 2), null);
    expect(out).not.toContain('audio_idx');
    expect(out).toContain('token=abc');
  });
  it('handles URLs with seek params (recreate path shape)', () => {
    const seekUrl = base + '&ss=580.5&start_byte=1024';
    const out = withAudioIdx(seekUrl, 1);
    expect(out).toContain('ss=580.5');
    expect(out).toContain('start_byte=1024');
    expect(out).toContain('audio_idx=1');
  });
  it('string-fallback works for relative URLs', () => {
    expect(withAudioIdx('/remux/home/84?token=abc', 2)).toBe('/remux/home/84?token=abc&audio_idx=2');
    expect(withAudioIdx('/remux/home/84?audio_idx=1&token=abc', 2))
      .toBe('/remux/home/84?token=abc&audio_idx=2');
    expect(withAudioIdx('/remux/home/84?token=abc&audio_idx=1', null))
      .toBe('/remux/home/84?token=abc');
  });
});

describe('audio track persistence (localStorage LRU)', () => {
  // The vitest env has no real Storage — install a minimal in-memory stand-in.
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    });
  });

  it('round-trips a per-file choice', () => {
    persistAudioTrack('home:84', 2);
    expect(readPersistedAudioTrack('home:84')).toBe(2);
    expect(readPersistedAudioTrack('home:99')).toBeNull();
  });
  it('overwrites the same file key', () => {
    persistAudioTrack('home:84', 2);
    persistAudioTrack('home:84', 1);
    expect(readPersistedAudioTrack('home:84')).toBe(1);
  });
  it('caps the map at 200 entries, evicting oldest (LRU)', () => {
    for (let i = 0; i < 205; i++) persistAudioTrack(`f:${i}`, 1);
    const map = JSON.parse(localStorage.getItem(AUDIO_TRACK_STORE_KEY)!);
    expect(Object.keys(map)).toHaveLength(200);
    expect(readPersistedAudioTrack('f:0')).toBeNull();   // evicted
    expect(readPersistedAudioTrack('f:204')).toBe(1);    // newest kept
  });
  it('tolerates corrupted store content', () => {
    localStorage.setItem(AUDIO_TRACK_STORE_KEY, '{not json');
    expect(readPersistedAudioTrack('home:84')).toBeNull();
    persistAudioTrack('home:84', 2); // must not throw
    expect(readPersistedAudioTrack('home:84')).toBe(2);
  });
});
