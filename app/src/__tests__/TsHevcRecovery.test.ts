import { describe, it, expect, vi } from 'vitest';
import {
  isAlreadyRemuxUrl,
  isFatalSourceBufferCreationError,
  planRemuxRecovery,
} from '../hooks/useMSEPlayer';

// Mock Tauri invoke so useMSEPlayer imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * These helpers back the TS-HEVC fatal-error recovery: when mpegts.js playback
 * of a TS file dies because MSE can't decode the codec (HEVC on stock WebView2
 * — MediaSource.addSourceBuffer('…hvc1…') throws NotSupportedError, or the
 * demuxer emits CodecUnsupported), the player is recreated on the /remux →
 * mpegts.js tier (ffmpeg transcode, the timed_id3 pipeline) instead of the old
 * broken outcomes: infinite quota-eviction hang (video.error unset) or native
 * <video> pointed at an MPEG-TS pipe it cannot demux.
 */

describe('isAlreadyRemuxUrl', () => {
  it('detects /remux URLs (loop guard: never re-recover a /remux failure)', () => {
    expect(isAlreadyRemuxUrl('http://127.0.0.1:8080/remux/home/84?token=abc&hevc_ok=false')).toBe(true);
    expect(isAlreadyRemuxUrl('http://127.0.0.1:8080/remux/123/456?token=x&ss=580.5&start_byte=1024')).toBe(true);
  });

  it('rejects /stream and other URLs', () => {
    expect(isAlreadyRemuxUrl('http://127.0.0.1:8080/stream/home/84?token=abc')).toBe(false);
    expect(isAlreadyRemuxUrl('http://127.0.0.1:8080/fmp4/init/home/84?token=abc')).toBe(false);
  });

  it('handles null/undefined/empty (no player URL known)', () => {
    expect(isAlreadyRemuxUrl(null)).toBe(false);
    expect(isAlreadyRemuxUrl(undefined)).toBe(false);
    expect(isAlreadyRemuxUrl('')).toBe(false);
  });

  it('does not false-positive on /remux appearing in the query string', () => {
    // Pathname check, not substring: token containing "/remux/" must not trip it.
    expect(isAlreadyRemuxUrl('http://h/stream/home/84?next=/remux/home/85')).toBe(false);
  });

  it('falls back to substring matching for unparseable URLs', () => {
    expect(isAlreadyRemuxUrl('/remux/home/84?token=abc')).toBe(true);
    expect(isAlreadyRemuxUrl('/stream/home/84')).toBe(false);
  });
});

describe('isFatalSourceBufferCreationError', () => {
  it('matches the Chromium addSourceBuffer NotSupported message (HEVC on stock WebView2)', () => {
    // Exact shape mse-controller.js emits: {code: error.code, msg: error.message}
    expect(isFatalSourceBufferCreationError({
      code: 9,
      msg: "Failed to execute 'addSourceBuffer' on 'MediaSource': The type provided ('video/mp4;codecs=hvc1.2.4.L123.b0') is unsupported.",
    })).toBe(true);
  });

  it('matches on message alone when WebView2 reports code=0/name=undefined', () => {
    // PROVEN WebView2 behavior for DOMExceptions (see MediaMSEError handler):
    // numeric code is unreliable, message signature is the discriminator.
    expect(isFatalSourceBufferCreationError({
      code: 0,
      msg: "Failed to execute 'addSourceBuffer' on 'MediaSource': The type provided is unsupported.",
    })).toBe(true);
    expect(isFatalSourceBufferCreationError({ msg: 'NotSupportedError: something' })).toBe(true);
  });

  it('matches bare code=9 (DOMException.NOT_SUPPORTED_ERR) with no message', () => {
    expect(isFatalSourceBufferCreationError({ code: 9, msg: '' })).toBe(true);
  });

  it('NEVER matches quota/appendBuffer shapes (recoverable — quota guard handles them)', () => {
    expect(isFatalSourceBufferCreationError({
      code: 22,
      msg: "Failed to execute 'appendBuffer' on 'SourceBuffer': The SourceBuffer is full, and cannot free space to append additional buffers.",
    })).toBe(false);
    // WebView2 quota shape: code=0, name=undefined — the original bug report.
    expect(isFatalSourceBufferCreationError({
      code: 0,
      msg: "Failed to execute 'appendBuffer' on 'SourceBuffer': This SourceBuffer is full",
    })).toBe(false);
    expect(isFatalSourceBufferCreationError({ msg: 'QuotaExceededError' })).toBe(false);
  });

  it('does not match unrelated/empty errors', () => {
    expect(isFatalSourceBufferCreationError({ code: 0, msg: 'network error' })).toBe(false);
    expect(isFatalSourceBufferCreationError({})).toBe(false);
    expect(isFatalSourceBufferCreationError(null)).toBe(false);
    expect(isFatalSourceBufferCreationError(undefined)).toBe(false);
  });
});

describe('planRemuxRecovery', () => {
  const base = {
    failedUrl: 'http://127.0.0.1:8080/stream/home/84?token=abc',
    alreadyAttempted: false,
    currentTime: 0,
    duration: 5400,
    fileLength: 2_000_000_000,
  };

  it('skips when the failure was on the /remux tier itself (loop guard E1)', () => {
    expect(planRemuxRecovery({
      ...base,
      failedUrl: 'http://127.0.0.1:8080/remux/home/84?token=abc&hevc_ok=false',
    })).toEqual({ action: 'skip' });
  });

  it('skips on the second attempt for the same file load (one-shot guard E2)', () => {
    expect(planRemuxRecovery({ ...base, alreadyAttempted: true })).toEqual({ action: 'skip' });
  });

  it('cold-starts (init) when playback had not progressed', () => {
    expect(planRemuxRecovery(base)).toEqual({ action: 'init' });
    expect(planRemuxRecovery({ ...base, currentTime: 3.2 })).toEqual({ action: 'init' });
  });

  it('resumes near the playhead (seek) when ≥8s decoded and byte-forward inputs known', () => {
    expect(planRemuxRecovery({ ...base, currentTime: 612.4 }))
      .toEqual({ action: 'seek', time: 612.4 });
  });

  it('falls back to init when duration or fileLength is unknown (byte-forward impossible)', () => {
    expect(planRemuxRecovery({ ...base, currentTime: 612.4, duration: 0 })).toEqual({ action: 'init' });
    expect(planRemuxRecovery({ ...base, currentTime: 612.4, fileLength: 0 })).toEqual({ action: 'init' });
  });

  it('treats non-finite currentTime as cold start (video element reset already zeroed it)', () => {
    expect(planRemuxRecovery({ ...base, currentTime: NaN })).toEqual({ action: 'init' });
    expect(planRemuxRecovery({ ...base, currentTime: Infinity })).toEqual({ action: 'init' });
  });

  it('loop guard wins over resume (skip even with a valid playhead)', () => {
    expect(planRemuxRecovery({
      ...base,
      failedUrl: 'http://127.0.0.1:8080/remux/home/84?token=abc',
      currentTime: 612.4,
    })).toEqual({ action: 'skip' });
  });
});
