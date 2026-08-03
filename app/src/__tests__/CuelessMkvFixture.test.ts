import { describe, it, expect, vi } from 'vitest';
import {
  Output, Input, MkvOutputFormat, BufferTarget, BufferSource,
  EncodedVideoPacketSource, EncodedPacket, EncodedPacketSink, MATROSKA,
} from 'mediabunny';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * In-tree pin of the mediabunny cue-less getKeyPacket contract bug (H1,
 * reports/research/refill-stall-verify-h1.md — present through v1.52.2):
 * after linear iteration populates the cluster position cache, a mid-GOP
 * target whose GOP keyframe cluster lies BEHIND the walk start returns null
 * even though a keyframe ≤ target exists. Fix A (harvest) resolves refills to
 * exact harvested timestamps, whose own clusters ARE reachable — asserted
 * here against the same real file. IF A MEDIABUNNY UPGRADE MAKES THE NULL
 * ASSERT FAIL, the upstream bug is fixed and fix A can be retired.
 *
 * Muxer geometry (verified matroska-muxer.ts:74/:1137-1148): clusters break
 * only on keyframes (≥ minimumClusterDuration) or at the 32,767ms overflow —
 * GOP must exceed 32.77s to produce mid-GOP cluster starts. Keyframes at
 * 0/40s → clusters at 0, ~32.8 (mid-GOP, deltas only), 40.
 */
async function buildCuelessMkv(): Promise<Uint8Array> {
  const target = new BufferTarget();
  const output = new Output({ format: new MkvOutputFormat({ appendOnly: true }), target });
  const source = new EncodedVideoPacketSource('vp8');
  output.addVideoTrack(source);
  await output.start();
  let first = true;
  for (let ts = 0; ts < 45; ts += 0.5) {
    const isKey = ts === 0 || ts === 40;
    const packet = new EncodedPacket(new Uint8Array(isKey ? 800 : 200), isKey ? 'key' : 'delta', ts, 0.5);
    if (first) {
      await source.add(packet, { decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 240 } });
      first = false;
    } else {
      await source.add(packet);
    }
  }
  await output.finalize();
  const buf = new Uint8Array(target.buffer!);
  // finalize() writes a trailing Cues element UNCONDITIONALLY even with
  // appendOnly (only the SeekHead + size back-patch are skipped). Truncate at
  // the trailing top-level Cues ID 1C 53 BB 6B — scanning from the END, so
  // payload false-positives (all earlier) are skipped. appendOnly segments
  // have unknown size → a truncated tail is legal, walkable Matroska.
  for (let i = buf.length - 4; i >= 0; i--) {
    if (buf[i] === 0x1c && buf[i + 1] === 0x53 && buf[i + 2] === 0xbb && buf[i + 3] === 0x6b) {
      return buf.subarray(0, i);
    }
  }
  throw new Error('trailing Cues element not found in muxed output');
}

describe('cue-less MKV getKeyPacket (H1 pin + harvest resolution)', () => {
  it('nulls on a mid-GOP target behind the read frontier; exact harvested lookups succeed', async () => {
    const bytes = await buildCuelessMkv();
    const input = new Input({ source: new BufferSource(bytes), formats: [MATROSKA] });
    const track = await input.getPrimaryVideoTrack();
    expect(track).toBeTruthy();
    const sink = new EncodedPacketSink(track!);

    // Simulate the prime: iterate 0→35 (populates the position cache with an
    // entry per read cluster, including the mid-GOP ~32.8s cluster) and
    // harvest keyframes the way fix A does.
    const harvested: number[] = [];
    for await (const p of sink.packets(undefined, undefined, { verifyKeyPackets: false })) {
      if (p.type === 'key') harvested.push(p.timestamp);
      if (p.timestamp >= 35) break;
    }
    expect(harvested).toEqual([0]); // only kf 0 lies in [0,35]

    // H1 REPRO (the refill geometry): target 35 — keyframe 0 ≤ 35 exists, but
    // the walk starts at the cached mid-GOP ~32.8 cluster and only moves
    // forward → null. THE CONTRACT VIOLATION, pinned.
    const nullResult = await sink.getKeyPacket(35, { verifyKeyPackets: false });
    expect(nullResult).toBeNull();

    // Determinism (review L7): even after iterating the WHOLE file (cache
    // fully populated), the same lookup still nulls — retries are pointless,
    // which is why the breaker's N=5 is generous, not risky.
    for await (const p of sink.packets(undefined, undefined, { verifyKeyPackets: false })) {
      if (p.type === 'key' && !harvested.includes(p.timestamp)) harvested.push(p.timestamp);
    }
    expect(harvested).toEqual([0, 40]);
    expect(await sink.getKeyPacket(35, { verifyKeyPackets: false })).toBeNull();

    // HARVEST RESOLUTION (what fix A does instead): exact harvested-timestamp
    // lookups land on the keyframe's own cached cluster — reachable, no walk.
    const kf0 = await sink.getKeyPacket(0, { verifyKeyPackets: false });
    expect(kf0?.timestamp).toBe(0);
    const kf40 = await sink.getKeyPacket(40, { verifyKeyPackets: false });
    expect(kf40?.timestamp).toBe(40);
  });
});
