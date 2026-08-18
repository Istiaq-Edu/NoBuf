import { describe, it, expect } from 'vitest';

/**
 * Round-23 G1b — the abandon path must DISARM anchor capture.
 *
 * `MediabunnyTransmuxer.seekTo` bails to null right after getKeyPacket resolves
 * when the seek was condemned mid-walk (`shouldAbandonResolvedSeek`). That early
 * return sits BEFORE `markSeekResolved()`, which is deliberate: arming capture
 * there would pair the SUPERSEDING seek's cluster byte with this corpse's
 * keyframe time.
 *
 * The gap it left: if capture was already armed by an EARLIER seek, the abandon
 * path never clears it. The flag survives into the superseding seek, whose first
 * read is then recorded as `clusterByteOfLastSeek` — producing exactly the
 * corrupt VBR anchor the guard exists to prevent, by a different route.
 *
 * These tests model the flag's lifetime against the real read path
 * (`TauriStreamSource.ts:265-268`: capture fires on the next read, then
 * self-clears).
 */

/** Mirrors the capture flag in the real source factory. */
function makeCaptureModel() {
  let captureNextReadStart = false;
  let clusterByteOfLastSeek = -1;
  return {
    markSeekResolved: () => { captureNextReadStart = true; },
    clearSeekState: () => { captureNextReadStart = false; },
    /** TauriStreamSource read path: capture fires once, then disarms itself. */
    read: (start: number) => {
      if (captureNextReadStart) {
        clusterByteOfLastSeek = start;
        captureNextReadStart = false;
      }
    },
    isArmed: () => captureNextReadStart,
    anchorByte: () => clusterByteOfLastSeek,
  };
}

describe('G1b: seek-state disarm on the abandon path', () => {
  it('a resolved seek captures the next read as its anchor (baseline)', () => {
    const s = makeCaptureModel();
    s.markSeekResolved();
    s.read(254_907_766);
    expect(s.anchorByte()).toBe(254_907_766);
    expect(s.isArmed()).toBe(false);
  });

  it('WITHOUT the disarm, a stale arm poisons the superseding seek', () => {
    const s = makeCaptureModel();
    // Seek A resolves and arms capture, but its read never lands (superseded).
    s.markSeekResolved();
    // Seek B is abandoned post-resolve — old code returned null here, no clear.
    // Seek C's first read is now mistaken for seek A's cluster byte.
    s.read(951_280_700);
    expect(s.anchorByte()).toBe(951_280_700); // wrong seek's byte, captured
  });

  it('WITH the disarm, the abandon path leaves capture cold', () => {
    const s = makeCaptureModel();
    s.markSeekResolved();
    s.clearSeekState(); // G1b
    s.read(951_280_700);
    expect(s.anchorByte()).toBe(-1); // no anchor recorded
    expect(s.isArmed()).toBe(false);
  });

  it('the disarm does NOT arm capture (must not become markSeekResolved)', () => {
    const s = makeCaptureModel();
    s.clearSeekState();
    expect(s.isArmed()).toBe(false);
    s.read(123_456);
    expect(s.anchorByte()).toBe(-1);
  });

  it('is idempotent — safe on any bail path, called twice or never armed', () => {
    const s = makeCaptureModel();
    s.clearSeekState();
    s.clearSeekState();
    expect(s.isArmed()).toBe(false);
    // And a later legitimate seek still works.
    s.markSeekResolved();
    s.read(1_384_299_767);
    expect(s.anchorByte()).toBe(1_384_299_767);
  });
});
