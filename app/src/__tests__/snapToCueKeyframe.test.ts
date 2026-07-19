import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MediabunnyTransmuxer } from '../lib/faststream/players/MediabunnyTransmuxer';

// Mock Tauri invoke so the module's diagLog() imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * snapToCueKeyframe backs the abutting-refill fix (trace 20, Finding #1).
 *
 * A refill stops by breaking at `packet.timestamp >= stopKf`, so it appends every
 * sample strictly BELOW the stop cue keyframe. SourceBuffer.buffered.end then reports
 * ~1ms below that keyframe (last muxed-sample end — a different float clock than the
 * MKV cue time). The NEXT refill uses bufEnd as its seek position; left unsnapped,
 * nearestCueKeyframeAtOrBefore(bufEnd) rounds DOWN a full GOP (the stop keyframe is
 * 1ms ABOVE bufEnd) and re-transmuxes ~10s already buffered (observed overlap=10.009s).
 *
 * snapToCueKeyframe pulls bufEnd back onto the exact cue keyframe when within
 * tolerance, so the refill abuts cleanly. Must be a strict no-op when no cue index
 * exists (TS / pre-parse) and must never snap across a real GOP boundary.
 */

// The method reads only this.mkvCueIndex; construct a minimal instance and inject it.
function makeTransmuxer(cueTimes: number[]): MediabunnyTransmuxer {
  const t = new MediabunnyTransmuxer({
    format: 'mkv',
    sourceConfig: { url: 'http://x', fileSize: 1 },
    onInitSegment: () => {},
    onMediaSegment: () => {},
    onDurationKnown: () => {},
    onCodecUnsupported: () => {},
    onError: () => {},
  } as any);
  (t as any).mkvCueIndex = cueTimes.map((time, i) => ({ time, byteOffset: i * 1000 }));
  return t;
}

// Real trace-20 cue lattice: ~10s GOPs around the affected region.
const CUES = [0.09, 1471.39, 1481.403, 1491.413, 1501.423, 1515.337, 1525.347, 1534.623];

describe('snapToCueKeyframe', () => {
  let t: MediabunnyTransmuxer;
  beforeEach(() => { t = makeTransmuxer(CUES); });

  it('snaps a bufEnd 1ms BELOW a cue keyframe UP onto it (the actual bug)', () => {
    // bufEnd=1515.336 was rounding down to 1505.327 (a full GOP back). Snap to 1515.337.
    expect(t.snapToCueKeyframe(1515.336)).toBeCloseTo(1515.337, 6);
  });

  it('snaps a bufEnd 1ms ABOVE a cue keyframe DOWN onto it', () => {
    expect(t.snapToCueKeyframe(1491.414)).toBeCloseTo(1491.413, 6);
  });

  it('leaves a position exactly on a cue keyframe unchanged', () => {
    expect(t.snapToCueKeyframe(1501.423)).toBeCloseTo(1501.423, 6);
  });

  it('does NOT snap when the nearest cue is beyond tolerance (mid-GOP)', () => {
    // 1486.0 is ~4.6s from 1481.403 and ~5.4s from 1491.413 — both ≫ 0.25s tolerance.
    expect(t.snapToCueKeyframe(1486.0)).toBe(1486.0);
  });

  it('respects the boundary exactly at tolerance (0.25s snaps, 0.26s does not)', () => {
    expect(t.snapToCueKeyframe(1501.423 + 0.25)).toBeCloseTo(1501.423, 6); // within → snaps onto cue
    // 0.26 > 0.25 tolerance → no cue close enough → returned UNCHANGED (not snapped).
    expect(t.snapToCueKeyframe(1501.423 + 0.26)).toBeCloseTo(1501.683, 6);
  });

  it('picks the CLOSER of two neighbouring cues', () => {
    // Between 1481.403 and 1491.413; 1481.5 is closest to 1481.403.
    expect(t.snapToCueKeyframe(1481.5)).toBeCloseTo(1481.403, 6);
  });

  it('handles the first cue (near 0) and never snaps across the large first gap', () => {
    expect(t.snapToCueKeyframe(0.1)).toBeCloseTo(0.09, 6);       // within tolerance of 0.09
    expect(t.snapToCueKeyframe(700)).toBe(700);                  // far from any cue → unchanged
  });

  it('honours a custom tolerance', () => {
    // With a 12s tolerance the full-GOP-away cue WOULD snap; proves tolerance is the guard.
    expect(t.snapToCueKeyframe(1505.327, 12)).toBeCloseTo(1501.423, 6); // nearest is 1501.423 (3.9s) vs 1515.337 (10.0s)
  });

  it('is a strict no-op when the cue index is empty (TS / pre-parse)', () => {
    const ts = makeTransmuxer([]);
    expect(ts.snapToCueKeyframe(1515.336)).toBe(1515.336);
    expect(ts.snapToCueKeyframe(0)).toBe(0);
  });

  it('returns non-finite input unchanged (defensive)', () => {
    expect(Number.isNaN(t.snapToCueKeyframe(NaN))).toBe(true);
    expect(t.snapToCueKeyframe(Infinity)).toBe(Infinity);
  });
});
