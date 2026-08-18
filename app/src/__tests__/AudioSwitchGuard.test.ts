import { describe, it, expect, vi } from 'vitest';
import { shouldRejectAudioSwitch } from '../hooks/useMSEPlayer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Round-8 I1 (8-c:412): the E3 guard `isColdStartBuffering ||
 * bufferingForSeekRef.current` conflated REFILLS with user seeks. Refills hold
 * bufferingForSeek around their whole seekTo (3-5s each on cue-less MKV after
 * a far seek, chained near-immediately), so audio switches were rejected most
 * of wall time and the dropdown silently reverted. A switch during a refill is
 * structurally identical to a user seek during a refill — proven safe 3x in
 * the same log (seekGen bump + stopStreamingChain condemn the refill; its
 * stale-generation guards skip every ref write). Only cold start, a USER seek,
 * and non-refill buffering (initial prime / MP4 seek windows) block.
 */
describe('shouldRejectAudioSwitch', () => {
  it('allows the 8-c:412 case: refill-owned buffering', () => {
    expect(shouldRejectAudioSwitch(false, false, true, true)).toBeNull();
  });

  it('allows when fully idle', () => {
    expect(shouldRejectAudioSwitch(false, false, false, false)).toBeNull();
  });

  it('rejects during cold start', () => {
    expect(shouldRejectAudioSwitch(true, false, false, false)).toMatch(/cold start/);
  });

  it('rejects during a user seek', () => {
    expect(shouldRejectAudioSwitch(false, true, false, false)).toMatch(/seek/);
  });

  it('rejects during a user seek even when a refill is also in flight', () => {
    expect(shouldRejectAudioSwitch(false, true, true, true)).toMatch(/seek/);
  });

  it('rejects non-refill buffering (initial prime / MP4 seek paths)', () => {
    expect(shouldRejectAudioSwitch(false, false, true, false)).toMatch(/priming/);
  });

  it('cold start wins over everything (reason stability)', () => {
    expect(shouldRejectAudioSwitch(true, true, true, true)).toMatch(/cold start/);
  });
});
