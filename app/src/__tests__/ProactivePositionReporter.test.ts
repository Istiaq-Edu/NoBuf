// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  decideMpegtsProactiveReport,
  startProactivePositionReporter,
} from '../hooks/useMSEPlayer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

describe('startProactivePositionReporter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Regression: the HEVC-MKV remux path consumed its cached 6 MiB prefix,
   * then transferred zero bytes for five seconds because the old scheduler's
   * first report did not run until the 10-second interval elapsed. */
  it('reports immediately instead of waiting for the first interval', () => {
    const report = vi.fn();
    const interval = startProactivePositionReporter({ report });

    expect(report).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9_999);
    expect(report).toHaveBeenCalledTimes(1);
    clearInterval(interval);
  });

  it('keeps the existing 10-second periodic cadence after the eager report', () => {
    const report = vi.fn();
    const interval = startProactivePositionReporter({ report });

    vi.advanceTimersByTime(10_000);
    expect(report).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(20_000);
    expect(report).toHaveBeenCalledTimes(4);
    clearInterval(interval);
  });

  it('returns the owned interval so existing pause and teardown cleanup can stop it', () => {
    const report = vi.fn();
    const interval = startProactivePositionReporter({ report });

    clearInterval(interval);
    vi.advanceTimersByTime(30_000);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('binds the cold-start exemption to the shipped decision helper', () => {
    const base = {
      hasVideo: true,
      videoPaused: false,
      videoEnded: false,
      needsRemuxSeek: true,
      userSeekInProgress: false,
      currentTime: 0,
      playerDownloading: true,
    };

    // The eager byte-zero seed must start the sole proactive owner even though
    // the foreground IOController is active and the remux transient guard would
    // reject an ordinary periodic report at t=0.
    expect(decideMpegtsProactiveReport({ ...base, eager: true })).toEqual({
      report: true,
      playerDownloading: false,
    });
    expect(decideMpegtsProactiveReport({ ...base, eager: false })).toEqual({
      report: false,
      playerDownloading: true,
    });

    // Pause remains a hard lifecycle boundary: eager scheduling does not turn
    // "paused means paused" into a hidden background restart.
    expect(decideMpegtsProactiveReport({
      ...base,
      eager: true,
      videoPaused: true,
    }).report).toBe(false);
  });

  it('preserves real foreground ownership on later native-TS ticks', () => {
    expect(decideMpegtsProactiveReport({
      eager: false,
      hasVideo: true,
      videoPaused: false,
      videoEnded: false,
      needsRemuxSeek: false,
      userSeekInProgress: false,
      currentTime: 20,
      playerDownloading: true,
    })).toEqual({ report: true, playerDownloading: true });
  });

  it('is the scheduler and decision helper used by the shipped MPEGTS pipeline', () => {
    // Normalize EOL: `initEnd`'s needle spans a line break, so on a Windows
    // checkout (core.autocrlf=true) it resolved to -1 and slice(initStart, -1)
    // silently widened the scope to nearly the whole 580KB file — the asserts
    // below then passed against unrelated code. Normalize, then prove the
    // scope actually bounded before trusting what it contains.
    const source = readFileSync(`${process.cwd()}/src/hooks/useMSEPlayer.ts`, 'utf8')
      .replace(/\r\n/g, '\n');
    const initStart = source.indexOf('const _initMpegtsPlayer = async (');
    const initEnd = source.indexOf('/**\n   * TS-HEVC fatal-error recovery', initStart);
    expect(initStart, '_initMpegtsPlayer not found').toBeGreaterThan(-1);
    expect(initEnd, 'TS-HEVC recovery boundary not found').toBeGreaterThan(initStart);
    const init = source.slice(initStart, initEnd);

    expect(init).toContain('const decision = decideMpegtsProactiveReport({');
    expect(init).toContain('isPlayerDownloading: decision.playerDownloading');
    expect(init).toContain('const proactiveInterval = startProactivePositionReporter({');
    expect(init).toContain('report: reportProactivePosition');
  });
});
