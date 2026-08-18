// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { decideColdStartOverlayArm } from '../hooks/useMSEPlayer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Defect A (22-t.md:63 → :78): the user clicks an MKV at 15:44:20 and the
 * branded cold-start overlay only arms at 15:44:28, because every arm site
 * (useMSEPlayer.ts:4178/:4206/:4288/:4309) sits DOWNSTREAM of format detection
 * and the blocking 6 MiB MKV prefetch. The open boundary must arm it instead.
 *
 * The dangerous half of that change is dismissal: three native bail-outs
 * (:4063 unknown, :4223 webm, :4300 VP9/AV1 MKV) do `setUseNative(true); return;`
 * and never dismiss, so arming earlier without a native arm would strand a
 * black overlay over working native video until the 45s safety timeout (:11056).
 */
describe('decideColdStartOverlayArm — open-boundary arming', () => {
  const openBoundary = {
    streamOpen: true,
    formatDetected: false,
    useNative: false,
    playerReady: false,
  };

  it('arms at the open boundary before any format detection or network I/O', () => {
    // This is the defect: at click time nothing armed the overlay.
    expect(decideColdStartOverlayArm(openBoundary)).toEqual({
      armed: true,
      phase: 'fetching_metadata',
    });
  });

  it('never arms the byte-progress buffering phase before detection', () => {
    // The progress poller (:11037-11050) reads shadowCacheRef — created at
    // :4192/:4266, i.e. AFTER detection — and measures COLD_START_TIMEOUT_MS
    // from arm time. Arming 'buffering' at open would shorten the real TS gate.
    expect(decideColdStartOverlayArm(openBoundary).phase).not.toBe('buffering');
    expect(decideColdStartOverlayArm({ ...openBoundary, formatDetected: true }).phase)
      .not.toBe('buffering');
  });

  it('keeps the same phase across the pre-detection window so the overlay never swaps identity', () => {
    // A phase change on a live overlay reads to the user as a second overlay.
    const atOpen = decideColdStartOverlayArm(openBoundary);
    const stillDetecting = decideColdStartOverlayArm({ ...openBoundary, formatDetected: false });
    expect(stillDetecting).toEqual(atOpen);
  });

  it('dismisses when a route falls back to native playback', () => {
    // :4063 / :4223 / :4300 — bare returns that never dismissed.
    expect(decideColdStartOverlayArm({ ...openBoundary, useNative: true })).toEqual({
      armed: false,
      phase: 'none',
    });
  });

  it('dismisses once the player is ready', () => {
    expect(decideColdStartOverlayArm({ ...openBoundary, playerReady: true })).toEqual({
      armed: false,
      phase: 'none',
    });
  });

  it('does not arm when no stream is open', () => {
    expect(decideColdStartOverlayArm({ ...openBoundary, streamOpen: false })).toEqual({
      armed: false,
      phase: 'none',
    });
  });

  /**
   * Bounded no-gap composed lifecycle. Per-site tests pass while a native path
   * still strands the overlay, so the invariant has to be asserted across the
   * whole open → detect → route timeline, not at one site.
   */
  it('covers the entire open→ready window with no un-armed gap and no stranded overlay', () => {
    // Mirrors 22-t.md: open 15:44:20, detect 15:44:22, prefetch to 15:44:28,
    // route 15:44:28, MEDIA_INFO 15:44:30.
    const timeline = [
      { at: '15:44:20 open',            streamOpen: true, formatDetected: false, useNative: false, playerReady: false },
      { at: '15:44:20 sourceopen',      streamOpen: true, formatDetected: false, useNative: false, playerReady: false },
      { at: '15:44:22 detect=mkv',      streamOpen: true, formatDetected: true,  useNative: false, playerReady: false },
      { at: '15:44:22-28 prefetch',     streamOpen: true, formatDetected: true,  useNative: false, playerReady: false },
      { at: '15:44:28 route hevc',      streamOpen: true, formatDetected: true,  useNative: false, playerReady: false },
    ];

    for (const step of timeline) {
      const { at, ...input } = step;
      expect(decideColdStartOverlayArm(input), `overlay must be armed at ${at}`).toEqual({
        armed: true,
        phase: 'fetching_metadata',
      });
    }

    // 15:44:30 MEDIA_INFO — and the native escape hatch, which must NOT strand.
    expect(decideColdStartOverlayArm({
      streamOpen: true, formatDetected: true, useNative: false, playerReady: true,
    }).armed).toBe(false);
    expect(decideColdStartOverlayArm({
      streamOpen: true, formatDetected: true, useNative: true, playerReady: false,
    }).armed).toBe(false);
  });
});

describe('cold-start overlay arming is wired into the shipped init effect', () => {
  const source = readFileSync(`${process.cwd()}/src/hooks/useMSEPlayer.ts`, 'utf8');

  it('arms from the per-file init block, above the MediaSource/format work', () => {
    const effectStart = source.indexOf('  // Initialize MSE when streamUrl changes');
    const armIdx = source.indexOf('applyColdStartOverlayArm({ streamOpen: true })', effectStart);
    const mediaSourceIdx = source.indexOf('const mediaSource = new MediaSource();', effectStart);
    const detectIdx = source.indexOf('const format = detectFormat(', effectStart);

    expect(armIdx).toBeGreaterThan(effectStart);
    // The whole point: arming happens BEFORE the blocking startup work.
    expect(armIdx).toBeLessThan(mediaSourceIdx);
    expect(armIdx).toBeLessThan(detectIdx);
  });

  it('routes the wrapper through the shipped pure decision helper', () => {
    const wrapper = source.slice(
      source.indexOf('const applyColdStartOverlayArm = ('),
      source.indexOf('const isCompleteRef ='),
    );
    expect(wrapper).toContain('decideColdStartOverlayArm({');
    expect(wrapper).toContain('setIsColdStartBuffering(true)');
    expect(wrapper).toContain('setIsColdStartBuffering(false)');
  });

  it('guards the arm behind the per-file discriminator so an MP4 audio switch cannot flash it', () => {
    // The init effect deps are [streamUrl, mp4ReinitNonce] — a nonce-driven
    // same-file re-init must not re-arm the overlay mid-playback.
    const guard = source.indexOf('if (lastEffectStreamUrlRef.current !== streamUrl) {');
    const guardEnd = source.indexOf('\n    }', guard);
    const perFileBlock = source.slice(guard, guardEnd);
    expect(perFileBlock).toContain('applyColdStartOverlayArm({ streamOpen: true })');
  });

  it('dismisses on every native fallback route', () => {
    // Each bail-out must run the arm decision with useNative=true rather than
    // returning bare. Counted so a single missed site fails.
    const dismissals = source.match(/applyColdStartOverlayArm\(\{ useNative: true \}\)/g) ?? [];
    expect(dismissals.length).toBeGreaterThanOrEqual(4);
  });
});
