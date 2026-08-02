import { describe, it, expect, vi } from 'vitest';
import { MediabunnyTransmuxer } from '../lib/faststream/players/MediabunnyTransmuxer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Round-3 Fix A-2 (reports/round3-solution.md): cue-less MKV boundary fallback.
 * nextKeyframeAtOrAfter / snapToCueKeyframe consult only mkvCueIndex — on a 0-cue
 * file every refill/switch stopTime is Infinity/undefined, so the switch seekTo
 * stops mid-GOP and the first post-switch refill re-resolves the SAME keyframe
 * behind the playhead, replacing coded frames the decoder is about to render
 * (round-3 logs: 4/4 switches, switch-kf == refill-kf). Fallback: when the cue
 * index is empty AND format==='mkv', consult the harvested keyframeTimestamps
 * (sorted+deduped by addKeyframeTimestamp). nextKeyframeAtOrAfter clamps gappy
 * harvests (boundary > time+25 → null) because stopTime BYPASSES maxDuration in
 * iterateVideoPackets — an unclamped cross-gap boundary would transmux minutes.
 */
function makeTransmuxer(format: 'mkv' | 'ts' = 'mkv'): MediabunnyTransmuxer {
  return new MediabunnyTransmuxer({
    format,
    sourceConfig: { url: 'http://x', fileSize: 1 },
    onInitSegment: () => {},
    onMediaSegment: () => {},
    onDurationKnown: () => {},
    onCodecUnsupported: () => {},
    onError: () => {},
  } as any);
}

describe('nextKeyframeAtOrAfter harvested fallback (cue-less MKV)', () => {
  it('returns the first harvested keyframe STRICTLY after time', () => {
    const t = makeTransmuxer() as any;
    t.keyframeTimestamps = [10.4, 20.8, 31.2];
    expect(t.nextKeyframeAtOrAfter(12)).toBe(20.8);
  });

  it('exact-hit returns the NEXT boundary (strictly-greater semantics, mirrors cue path)', () => {
    const t = makeTransmuxer() as any;
    t.keyframeTimestamps = [10.4, 20.8, 31.2];
    expect(t.nextKeyframeAtOrAfter(20.8)).toBe(31.2);
  });

  it('clamps gappy harvests: boundary further than time+25 → null (maxDuration fallback)', () => {
    const t = makeTransmuxer() as any;
    t.keyframeTimestamps = [10, 600];
    expect(t.nextKeyframeAtOrAfter(12)).toBeNull();
  });

  it('no boundary above time → null', () => {
    const t = makeTransmuxer() as any;
    t.keyframeTimestamps = [10.4, 20.8];
    expect(t.nextKeyframeAtOrAfter(25)).toBeNull();
  });

  it('empty harvest → null (unchanged cue-less behavior)', () => {
    const t = makeTransmuxer() as any;
    expect(t.nextKeyframeAtOrAfter(12)).toBeNull();
  });

  it('format gate: TS construction never uses the fallback', () => {
    const t = makeTransmuxer('ts') as any;
    t.keyframeTimestamps = [10.4, 20.8, 31.2];
    expect(t.nextKeyframeAtOrAfter(12)).toBeNull();
  });

  it('cue index present → cue result wins even when harvest disagrees', () => {
    const t = makeTransmuxer() as any;
    t.mkvCueIndex = [{ time: 15, clusterByte: 0 }, { time: 30, clusterByte: 1 }];
    t.keyframeTimestamps = [11, 13, 14];
    expect(t.nextKeyframeAtOrAfter(12)).toBe(15);
  });
});

describe('snapToCueKeyframe harvested fallback (cue-less MKV)', () => {
  it('snaps to a harvested keyframe within tolerance', () => {
    const t = makeTransmuxer() as any;
    t.keyframeTimestamps = [10.4, 20.8, 31.2];
    expect(t.snapToCueKeyframe(20.799, 0.25)).toBe(20.8);
    expect(t.snapToCueKeyframe(20.801, 0.25)).toBe(20.8);
  });

  it('no neighbor within tolerance → identity', () => {
    const t = makeTransmuxer() as any;
    t.keyframeTimestamps = [10.4, 20.8, 31.2];
    expect(t.snapToCueKeyframe(15, 0.25)).toBe(15);
  });

  it('empty harvest → identity (unchanged cue-less behavior)', () => {
    const t = makeTransmuxer() as any;
    expect(t.snapToCueKeyframe(20.799, 0.25)).toBe(20.799);
  });

  it('format gate: TS construction stays identity', () => {
    const t = makeTransmuxer('ts') as any;
    t.keyframeTimestamps = [10.4, 20.8, 31.2];
    expect(t.snapToCueKeyframe(20.799, 0.25)).toBe(20.799);
  });

  it('cue index present → cue snap wins (fallback not consulted)', () => {
    const t = makeTransmuxer() as any;
    t.mkvCueIndex = [{ time: 20.7, clusterByte: 0 }];
    t.keyframeTimestamps = [20.9];
    expect(t.snapToCueKeyframe(20.75, 0.25)).toBe(20.7);
  });
});
