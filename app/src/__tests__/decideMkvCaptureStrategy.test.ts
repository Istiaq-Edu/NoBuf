import { describe, it, expect, vi } from 'vitest';
import { decideMkvCaptureStrategy } from '../hooks/useThumbnailExtractor';

// Mock Tauri invoke so useThumbnailExtractor imports cleanly in node env.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * decideMkvCaptureStrategy picks the MKV thumbnail capture path (fix B, round-2).
 *
 * Root cause it fixes (round-2 forensics §B): on a cue-less MKV, an index miss fell
 * back to native getKeyPacket(time, verify:true) — a linear cluster walk toward the
 * hover byte. One hover at 3427.7s walked 184MB for 103s+, busy-locking every later
 * hover and stealing download workers from playback. The TS path already skips when
 * it has no usable index; this helper gives cue-less MKV the same policy:
 * harvested-index hit → 'index'; miss on cue-less → 'skip'; miss on cue-INDEXED →
 * 'native' (that tier keeps today's full-Cues getKeyPacket, byte-identical).
 *
 * Contract: 'index'.timestamp is the FOUND ts[lo] (nearest keyframe ≤ time within
 * maxGap) — never the hover time itself.
 */
describe('decideMkvCaptureStrategy', () => {
  const TS = [0, 10, 20, 30]; // harvested keyframes
  const GAP = 12;             // THUMB_INDEX_MAX_GAP (useThumbnailExtractor.ts)

  it('index hit within gap → indexed capture with the FOUND timestamp (both cue states)', () => {
    expect(decideMkvCaptureStrategy(TS, 15, GAP, true)).toEqual({ strategy: 'index', timestamp: 10 });
    expect(decideMkvCaptureStrategy(TS, 15, GAP, false)).toEqual({ strategy: 'index', timestamp: 10 });
    expect(decideMkvCaptureStrategy(TS, 30, GAP, true)).toEqual({ strategy: 'index', timestamp: 30 }); // exact hit
    expect(decideMkvCaptureStrategy(TS, 42, GAP, true)).toEqual({ strategy: 'index', timestamp: 30 }); // gap boundary =12
  });

  it('gap miss: cue-less → skip (the unbounded-scan fix); cue-indexed → native (tier untouched)', () => {
    expect(decideMkvCaptureStrategy(TS, 42.01, GAP, true)).toEqual({ strategy: 'skip' });
    expect(decideMkvCaptureStrategy(TS, 42.01, GAP, false)).toEqual({ strategy: 'native' });
  });

  it('no index at all (pre-harvest hover): cue-less → skip; cue-indexed → native', () => {
    expect(decideMkvCaptureStrategy([], 3427.71, GAP, true)).toEqual({ strategy: 'skip' });   // the trace hover
    expect(decideMkvCaptureStrategy([], 3427.71, GAP, false)).toEqual({ strategy: 'native' });
  });

  it('hover BEFORE the first keyframe (ts[lo] > time) is a miss, not a bogus hit', () => {
    expect(decideMkvCaptureStrategy([100, 200], 50, GAP, false)).toEqual({ strategy: 'native' });
    expect(decideMkvCaptureStrategy([100, 200], 50, GAP, true)).toEqual({ strategy: 'skip' });
  });

  it('binary search picks nearest ≤ time, never a later keyframe', () => {
    expect(decideMkvCaptureStrategy(TS, 29.9, GAP, true)).toEqual({ strategy: 'index', timestamp: 20 });
  });
});
