import { describe, it, expect, vi } from 'vitest';
import { MediabunnyTransmuxer } from '../lib/faststream/players/MediabunnyTransmuxer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Cue-less MKV keyframe harvest (fix A, reports/refill-stall-solution.md).
 * mediabunny's getKeyPacket cannot find a keyframe BEHIND its position-cache
 * walk start, so cue-less refills at bufEnd null forever. The harvest feeds
 * every iterated keyframe into the partial index; the contiguous watermark
 * [harvestSpanStart, harvestSpanEnd] lets findNearestKeyframe trust the index
 * at ANY distance inside fully-iterated spans (GOP>12s files included), while
 * the 12s sparse rule stays byte-identical outside.
 */
function makeTransmuxer(): MediabunnyTransmuxer {
  return new MediabunnyTransmuxer({
    format: 'mkv',
    sourceConfig: { url: 'http://x', fileSize: 1 },
    onInitSegment: () => {},
    onMediaSegment: () => {},
    onDurationKnown: () => {},
    onCodecUnsupported: () => {},
    onError: () => {},
  } as any);
}

describe('addKeyframeTimestamp dedup (O(log n) neighbor check)', () => {
  it('dedups ±0.01s twins and keeps the array sorted under out-of-order inserts', () => {
    const t = makeTransmuxer() as any;
    t.addKeyframeTimestamp(20.81);
    t.addKeyframeTimestamp(20.815);  // within 0.01 → dropped
    t.addKeyframeTimestamp(20.805);  // within 0.01 → dropped
    t.addKeyframeTimestamp(0);
    t.addKeyframeTimestamp(10.4);
    t.addKeyframeTimestamp(10.4);    // exact dup → dropped
    expect(t.getKeyframeTimestamps()).toEqual([0, 10.4, 20.81]);
  });
});

describe('harvest watermark (noteIterated)', () => {
  it('merges abutting/overlapping windows into one span', () => {
    const t = makeTransmuxer() as any;
    t.noteIterated(0); t.noteIterated(0.2); t.noteIterated(0.4);
    expect(t.harvestSpanStart).toBe(0);
    expect(t.harvestSpanEnd).toBeCloseTo(0.4, 9);
    t.noteIterated(0.6); // within 0.25 tolerance → extend
    expect(t.harvestSpanEnd).toBeCloseTo(0.6, 9);
  });

  it('resets the span on a disjoint HIGHER window (far forward seek)', () => {
    const t = makeTransmuxer() as any;
    t.noteIterated(0); t.noteIterated(5);
    t.noteIterated(100); // gap ≫ 0.25 → new span
    expect(t.harvestSpanStart).toBe(100);
    expect(t.harvestSpanEnd).toBe(100);
  });

  it('never over-claims on a disjoint LOWER window (backward seek)', () => {
    const t = makeTransmuxer() as any;
    t.noteIterated(100); t.noteIterated(100.2);
    t.noteIterated(50); // merge branch, no extension — span unchanged
    expect(t.harvestSpanStart).toBe(100);
    expect(t.harvestSpanEnd).toBeCloseTo(100.2, 9);
  });
});

describe('findNearestKeyframe watermark trust', () => {
  it('trusts any distance inside the span; 12s rule intact outside', () => {
    const t = makeTransmuxer() as any;
    t.keyframeTimestamps = [0, 20];
    t.keyframeIndexPartial = true;
    t.harvestSpanStart = 0; t.harvestSpanEnd = 45;
    expect(t.findNearestKeyframe(45)).toBe(20);   // 25s gap — trusted inside span
    expect(t.findNearestKeyframe(45.2)).toBe(20); // inside the +0.25 tolerance lip
    t.harvestSpanStart = -1; t.harvestSpanEnd = -1;
    expect(t.findNearestKeyframe(45)).toBeNull(); // sparse rule restored
    expect(t.findNearestKeyframe(25)).toBe(20);   // ≤12s gap allowed outside span (unchanged rule)
    expect(t.findNearestKeyframe(33)).toBeNull(); // 13s gap rejected outside span (unchanged rule)
  });
});

/** Drive the REAL iterateVideoPackets with a scripted sink (AudioStartChain
 *  mock pattern). Packets carry ORIGINAL absolute timestamps; the pump clones
 *  them rebased for muxing — harvest must record the pre-clone values.
 *  Frames are 0.2s apart (realistic: below the 0.25s watermark merge
 *  tolerance — real video is ~0.04s/frame; 5s-apart fake packets would
 *  spuriously reset the single-span watermark). */
function fakePacket(timestamp: number, type: 'key' | 'delta') {
  return {
    timestamp,
    type,
    clone: (opts: { timestamp: number }) => ({ timestamp: opts.timestamp, type }),
  };
}

/** Frames every 0.2s in [0, 25.0]; keyframes at 0, 10.4, 20.81 (the 20.8
 *  slot shifts to 20.81 — gaps 20.6→20.81→21.0 stay under tolerance). */
function buildPackets(): any[] {
  const out: any[] = [];
  for (let i = 0; i <= 125; i++) {
    const slot = Math.round(i * 0.2 * 10) / 10;
    if (slot === 20.8) { out.push(fakePacket(20.81, 'key')); continue; }
    const isKey = slot === 0 || slot === 10.4;
    out.push(fakePacket(slot, isKey ? 'key' : 'delta'));
  }
  return out;
}

async function driveIteration(t: any, packets: any[], keyframeTs: number, maxDuration: number) {
  const sink = { packets: async function* () { for (const p of packets) yield p; } };
  const source = { add: async () => {}, close: () => {} };
  await t.iterateVideoPackets(
    sink, packets[0], source, { decoderConfig: undefined },
    keyframeTs, t.seekGeneration, maxDuration, false, Infinity,
  );
}

describe('iterateVideoPackets keyframe harvest', () => {
  it('harvests ORIGINAL key timestamps, including the cut-triggering key packet', async () => {
    const t = makeTransmuxer() as any;
    const packets = buildPackets();
    // maxDuration 20.7: frames ≤20.6 emit; 20.81 (key) exceeds the cut — but
    // harvest runs BEFORE the stop check, so it MUST be captured (this is
    // what makes the next refill resolve instead of nulling).
    await driveIteration(t, packets, 0, 20.7);
    expect(t.getKeyframeTimestamps()).toEqual([0, 10.4, 20.81]);
    expect(t.harvestSpanStart).toBe(0);
    expect(t.harvestSpanEnd).toBeCloseTo(20.81, 9); // watermark reaches the break packet
  });

  it('refill continuation window merges into one span with ORIGINAL timestamps', async () => {
    const t = makeTransmuxer() as any;
    const packets = buildPackets();
    await driveIteration(t, packets, 0, 20.7); // prime: span [0, 20.81]
    // Continuation refill: starts at the 20.81 keyframe (kf=20.81 → clones
    // are rebased to ~0). Harvest must see ORIGINALS: span extends to 25.0,
    // not to ~4.2, and the re-observed 20.81 key dedups instead of duplicating.
    const tail = packets.filter(p => p.timestamp >= 20.81);
    await driveIteration(t, tail, 20.81, 17);
    expect(t.getKeyframeTimestamps()).toEqual([0, 10.4, 20.81]);
    expect(t.harvestSpanStart).toBe(0);              // single merged span
    expect(t.harvestSpanEnd).toBeCloseTo(25.0, 9);   // original time-base
  });

  it('cue-indexed transmuxer never harvests (byte-identical index for indexed files)', async () => {
    const t = makeTransmuxer() as any;
    t.mkvCueIndex = [{ time: 0, byteOffset: 0 }];
    await driveIteration(t, buildPackets(), 0, 20.7);
    expect(t.getKeyframeTimestamps()).toEqual([]);
    expect(t.harvestSpanEnd).toBe(-1);
  });

  it('keyframeIndexBuilt disables harvest (full scan already authoritative)', async () => {
    const t = makeTransmuxer() as any;
    t.keyframeIndexBuilt = true;
    await driveIteration(t, buildPackets(), 0, 20.7);
    expect(t.harvestSpanEnd).toBe(-1);
  });
});
