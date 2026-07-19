import { describe, it, expect, vi } from 'vitest';
import { clampSeekTime, buildRemuxSeekUrl, shouldSkipRemuxPositionReport, pinRemuxerDtsBase } from '../hooks/useMSEPlayer';

// Mock Tauri invoke so useMSEPlayer imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * These pure helpers back the HEVC/MKV "remux-seek" path: a source served via
 * /remux (ffmpeg transcode → MPEG-TS) can't be byte-seeked on its raw /stream/
 * (that's a Matroska container). Instead the player is recreated from
 * /remux?ss=<time> and ffmpeg does the seek. clampSeekTime bounds the target;
 * buildRemuxSeekUrl constructs the request the backend's {:.3} ss parse expects.
 */
describe('clampSeekTime', () => {
  it('passes through a normal in-range seek', () => {
    expect(clampSeekTime(580.6, 1200)).toBe(580.6);
  });

  it('clamps a seek at/after EOF to duration - tailMargin (empty-stream guard)', () => {
    // ffmpeg -ss == duration emits no frames; leave 0.5s headroom by default.
    expect(clampSeekTime(1200, 1200)).toBe(1199.5);
    expect(clampSeekTime(5000, 1200)).toBe(1199.5);
  });

  it('honors a custom tail margin', () => {
    expect(clampSeekTime(1200, 1200, 2)).toBe(1198);
  });

  it('negative requested → 0', () => {
    expect(clampSeekTime(-30, 1200)).toBe(0);
  });

  it('NaN / Infinity requested → 0 (defends against seek-UI garbage)', () => {
    expect(clampSeekTime(NaN, 1200)).toBe(0);
    expect(clampSeekTime(Infinity, 1200)).toBe(0);
  });

  it('non-positive / non-finite duration → 0 (nothing to seek into)', () => {
    expect(clampSeekTime(100, 0)).toBe(0);
    expect(clampSeekTime(100, -5)).toBe(0);
    expect(clampSeekTime(100, NaN)).toBe(0);
  });

  it('very short clip where duration < tailMargin clamps to 0, never negative', () => {
    expect(clampSeekTime(0.4, 0.3)).toBe(0);
  });
});

describe('buildRemuxSeekUrl', () => {
  const base = 'http://localhost:14201/remux/3574767635/19?token=abc%3D';

  it('appends &ss= (base already has a query string) with 3-decimal precision', () => {
    expect(buildRemuxSeekUrl(base, 580.6)).toBe(
      'http://localhost:14201/remux/3574767635/19?token=abc%3D&ss=580.600'
    );
  });

  it('uses ? when the base has no query string', () => {
    expect(buildRemuxSeekUrl('http://x/remux/1/2', 12)).toBe('http://x/remux/1/2?ss=12.000');
  });

  it('millisecond precision matches the backend {:.3} parse', () => {
    expect(buildRemuxSeekUrl(base, 0.001)).toContain('ss=0.001');
    expect(buildRemuxSeekUrl(base, 123.4567)).toContain('ss=123.457');
  });

  it('non-positive / non-finite seek → ss=0.000 (start of stream)', () => {
    expect(buildRemuxSeekUrl(base, 0)).toContain('ss=0.000');
    expect(buildRemuxSeekUrl(base, -5)).toContain('ss=0.000');
    expect(buildRemuxSeekUrl(base, NaN)).toContain('ss=0.000');
    expect(buildRemuxSeekUrl(base, Infinity)).toContain('ss=0.000');
  });

  it('null/blank base → null so callers bail cleanly', () => {
    expect(buildRemuxSeekUrl(null, 100)).toBeNull();
    expect(buildRemuxSeekUrl('', 100)).toBeNull();
  });

  it('round-trips with clampSeekTime (real call-site composition)', () => {
    // The seek path clamps first, then builds the URL from the clamped value.
    const clamped = clampSeekTime(99999, 1200);
    expect(buildRemuxSeekUrl(base, clamped)).toContain('ss=1199.500');
  });
});

/**
 * The 10s proactive-position reporter must keep firing during normal /remux
 * playback (it's the ONLY trigger that starts the proactive prebuffer), but must
 * NOT fire during the seek-recreation / pre-first-frame window where the <video>
 * reads currentTime≈0 — a report there stomps the proactive target to byte 0
 * ("playhead jumped backward to byte 0"). This guard threads that needle.
 */
describe('shouldSkipRemuxPositionReport', () => {
  it('normal mid-file remux playback → report (proactive keeps running)', () => {
    expect(shouldSkipRemuxPositionReport(true, false, 600)).toBe(false);
  });

  it('during seek recreation (video detached) → skip', () => {
    expect(shouldSkipRemuxPositionReport(true, true, 600)).toBe(true);
  });

  it('post-clear but first ss-frame not decoded (currentTime≈0) → skip byte-0 transient', () => {
    expect(shouldSkipRemuxPositionReport(true, false, 0)).toBe(true);
    expect(shouldSkipRemuxPositionReport(true, false, 0.5)).toBe(true);
  });

  it('t=1.0 boundary → report (only < 1 is suppressed)', () => {
    expect(shouldSkipRemuxPositionReport(true, false, 1)).toBe(false);
  });

  it('genuine seek to start (t<1) → skip, harmless (byte 0 covered by bootstrap)', () => {
    expect(shouldSkipRemuxPositionReport(true, false, 0.3)).toBe(true);
  });

  it('native TS / timed_id3 (needsRemuxSeek=false) → guard inert, always report', () => {
    expect(shouldSkipRemuxPositionReport(false, false, 0)).toBe(false);
    expect(shouldSkipRemuxPositionReport(false, true, 600)).toBe(false); // even mid-seek
  });
});

/**
 * pinRemuxerDtsBase is the core of the robust remux-seek fix. /remux?ss=T emits
 * MPEG-TS with ABSOLUTE first PTS (≈T). mpegts.js's MP4Remuxer._calculateDtsBase()
 * (run lazily on the first remux()) would normalize output to start at 0, breaking
 * the absolute-time UI. Pinning _dtsBase=0 + _dtsBaseInited=true keeps the timeline
 * absolute AND blocks that recompute (mp4-remuxer.js:136 — `if (!this._dtsBaseInited)`).
 *
 * The old approach pre-created a demuxer from FAKE probe data, which hijacked
 * ioctl.onDataArrival and prevented the real TS probe (buffered stayed EMPTY). The
 * fix instead lets the real byte-0 probe build the remuxer and only pins it — these
 * tests lock in the pin semantics and the wrapper ordering that guarantees the pin
 * lands after the real setup but before the first remux().
 */
describe('pinRemuxerDtsBase', () => {
  // A faithful-enough MP4Remuxer stand-in: _calculateDtsBase mirrors the library
  // (no-op once _dtsBaseInited), so we can prove the pin blocks normalization.
  const makeRemuxer = () => ({
    _dtsBase: -1,
    _dtsBaseInited: false,
    _audioDtsBase: 0,
    _videoDtsBase: 0,
    _audioStashedLastSample: { dts: 123 },
    _videoStashedLastSample: { dts: 456 },
    _videoSegmentInfoList: { _cleared: false, clear() { this._cleared = true; } },
    _audioSegmentInfoList: { _cleared: false, clear() { this._cleared = true; } },
    _discontinuity: false,
    insertDiscontinuity() { this._discontinuity = true; },
    // Library semantics: normalize to first sample DTS unless already pinned.
    _calculateDtsBase(firstDts: number) {
      if (this._dtsBaseInited) return;
      this._dtsBase = firstDts;
      this._dtsBaseInited = true;
    },
    remux(firstDts: number) {
      if (!this._dtsBaseInited) this._calculateDtsBase(firstDts);
    },
  });

  it('pins _dtsBase to 0 and marks it initialized', () => {
    const r = makeRemuxer();
    expect(pinRemuxerDtsBase(r)).toBe(true);
    expect(r._dtsBase).toBe(0);
    expect(r._dtsBaseInited).toBe(true);
  });

  it('blocks _calculateDtsBase from normalizing an absolute-PTS stream to 0', () => {
    const r = makeRemuxer();
    pinRemuxerDtsBase(r);
    // First remux() sees absolute DTS ≈ 820s·90000; without the pin this would
    // set _dtsBase to that value (output normalized to 0). With the pin it's a no-op.
    r.remux(820 * 90000);
    expect(r._dtsBase).toBe(0); // stayed absolute — the whole point
  });

  it('without the pin, the remuxer WOULD normalize (control case proving the mechanism)', () => {
    const r = makeRemuxer();
    r.remux(820 * 90000);
    expect(r._dtsBase).toBe(820 * 90000); // normalized away from absolute — the bug we prevent
    expect(r._dtsBaseInited).toBe(true);
  });

  it('resets per-track bases to Infinity and clears stashed samples + segment lists', () => {
    const r = makeRemuxer();
    pinRemuxerDtsBase(r);
    expect(r._audioDtsBase).toBe(Infinity);
    expect(r._videoDtsBase).toBe(Infinity);
    expect(r._audioStashedLastSample).toBeNull();
    expect(r._videoStashedLastSample).toBeNull();
    expect(r._videoSegmentInfoList._cleared).toBe(true);
    expect(r._audioSegmentInfoList._cleared).toBe(true);
    expect(r._discontinuity).toBe(true);
  });

  it('is null-safe: returns false for null/undefined (no throw)', () => {
    expect(pinRemuxerDtsBase(null)).toBe(false);
    expect(pinRemuxerDtsBase(undefined)).toBe(false);
  });

  it('is idempotent: pinning twice keeps _dtsBase=0', () => {
    const r = makeRemuxer();
    pinRemuxerDtsBase(r);
    pinRemuxerDtsBase(r);
    expect(r._dtsBase).toBe(0);
    expect(r._dtsBaseInited).toBe(true);
  });

  it('tolerates a minimal remuxer missing optional list/discontinuity APIs', () => {
    const bare: any = { _dtsBase: -1, _dtsBaseInited: false };
    expect(() => pinRemuxerDtsBase(bare)).not.toThrow();
    expect(bare._dtsBase).toBe(0);
    expect(bare._dtsBaseInited).toBe(true);
  });

  /**
   * Ordering contract of the _setupTSDemuxerRemuxer wrapper used at the call site:
   * the real setup MUST run first (build demuxer+remuxer from the real probe), THEN
   * the pin, THEN — later — the first remux(). This models that exact sequence and
   * asserts the resulting timeline is absolute. If the pin ran before setup (old
   * bug) the remuxer wouldn't exist yet and the stream would normalize.
   */
  it('wrapper ordering: real setup → pin → remux yields an absolute timeline', () => {
    const ctrl: any = {
      _remuxer: null as any,
      _setupTSDemuxerRemuxer(_probe: any) { this._remuxer = makeRemuxer(); }, // real probe builds it
    };
    // Install the same wrapper shape as the call site.
    const originalSetup = ctrl._setupTSDemuxerRemuxer.bind(ctrl);
    ctrl._setupTSDemuxerRemuxer = (probe: any) => {
      originalSetup(probe);
      pinRemuxerDtsBase(ctrl._remuxer);
    };
    // Real byte-0 probe fires:
    ctrl._setupTSDemuxerRemuxer({ match: true });
    expect(ctrl._remuxer).not.toBeNull();
    expect(ctrl._remuxer._dtsBaseInited).toBe(true);
    // First transmux of absolute-PTS data:
    ctrl._remuxer.remux(600 * 90000);
    expect(ctrl._remuxer._dtsBase).toBe(0); // absolute preserved
  });
});
