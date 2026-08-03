import { describe, it, expect, vi } from 'vitest';
import { MediabunnyTransmuxer } from '../lib/faststream/players/MediabunnyTransmuxer';

// Mock Tauri invoke so the module's diagLog() imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * resolveAudioStartPacket backs Layer 1 of the MKV audio-skip fix
 * (reports/mkv-audioskip-solution.md §Layer 1).
 *
 * Chain: getKeyPacket(kf) ?? (kf <= NEAR_START ? getFirstKeyPacket() : null).
 * The repro (Inception MKV): default AAC track starts at 0.029s, file has 0 cue
 * points → getKeyPacket(0) is null (needs ts <= 0) → the old code closed the
 * audio source → video-only moov under a 2-codec mime → Chromium code-4 fatal.
 * getFirstKeyPacket bypasses cues by design and returns the 0.029s packet.
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
  });
}

function makeSink(keyPacketResult: unknown, firstKeyResult: unknown) {
  return {
    getKeyPacket: vi.fn().mockResolvedValue(keyPacketResult),
    getFirstKeyPacket: vi.fn().mockResolvedValue(firstKeyResult),
  };
}

describe('resolveAudioStartPacket (Layer-1 chain)', () => {
  it('link 1 hit → returns it unmodified, never calls getFirstKeyPacket (D2 happy path)', async () => {
    const t = makeTransmuxer() as any;
    const pkt = { timestamp: 12.3 };
    const sink = makeSink(pkt, null);
    const out = await t.resolveAudioStartPacket(sink, 12.3, t.seekGeneration);
    expect(out).toBe(pkt);
    expect(sink.getKeyPacket).toHaveBeenCalledWith(12.3, { verifyKeyPackets: false });
    expect(sink.getFirstKeyPacket).not.toHaveBeenCalled();
  });

  it('link 1 null + near-start → getFirstKeyPacket result (the repro: audio at 0.029s)', async () => {
    const t = makeTransmuxer() as any;
    const first = { timestamp: 0.029 };
    const sink = makeSink(null, first);
    const out = await t.resolveAudioStartPacket(sink, 0, t.seekGeneration);
    expect(out).toBe(first);
    expect(sink.getFirstKeyPacket).toHaveBeenCalledTimes(1);
  });

  it('link 1 null + mid-file → null WITHOUT a from-start scan (D9 cost guard)', async () => {
    const t = makeTransmuxer() as any;
    const sink = makeSink(null, { timestamp: 0.029 });
    const out = await t.resolveAudioStartPacket(sink, 3600, t.seekGeneration);
    expect(out).toBeNull();
    expect(sink.getFirstKeyPacket).not.toHaveBeenCalled();
  });

  it('near-start boundary is inclusive (kf === NEAR_START falls back; just above does not)', async () => {
    const t = makeTransmuxer() as any;
    const first = { timestamp: 0.5 };
    expect(await t.resolveAudioStartPacket(makeSink(null, first), 10, t.seekGeneration)).toBe(first);
    expect(await t.resolveAudioStartPacket(makeSink(null, first), 10.01, t.seekGeneration)).toBeNull();
  });

  it('supersession between links → null, second link never runs (F6)', async () => {
    const t = makeTransmuxer() as any;
    const sink = {
      getKeyPacket: vi.fn().mockImplementation(async () => {
        t.seekGeneration++; // a newer seek arrives while link 1 awaits
        return null;
      }),
      getFirstKeyPacket: vi.fn().mockResolvedValue({ timestamp: 0.029 }),
    };
    // Caller contract: pass the generation captured BEFORE link 1. Argument is
    // evaluated before the call, so this is the pre-bump value; the mock bumps
    // the live generation during link 1 → the post-link check sees a mismatch.
    const out = await t.resolveAudioStartPacket(sink, 0, t.seekGeneration);
    expect(out).toBeNull();
    expect(sink.getFirstKeyPacket).not.toHaveBeenCalled();
  });

  it('disposed between links → null (InputDisposedError window shrunk, F1)', async () => {
    const t = makeTransmuxer() as any;
    const sink = {
      getKeyPacket: vi.fn().mockImplementation(async () => { t.disposed = true; return null; }),
      getFirstKeyPacket: vi.fn().mockResolvedValue({ timestamp: 0.029 }),
    };
    const out = await t.resolveAudioStartPacket(sink, 0, t.seekGeneration);
    expect(out).toBeNull();
    expect(sink.getFirstKeyPacket).not.toHaveBeenCalled();
  });

  it('fallback returning null stays null (truly audio-less window)', async () => {
    const t = makeTransmuxer() as any;
    const out = await t.resolveAudioStartPacket(makeSink(null, null), 0, t.seekGeneration);
    expect(out).toBeNull();
  });
});
