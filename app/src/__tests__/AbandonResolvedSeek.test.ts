import { describe, it, expect, vi } from 'vitest';
import { shouldAbandonResolvedSeek } from '../lib/faststream/players/MediabunnyTransmuxer';

// The transmuxer module imports Tauri invoke (diag logging) — mock so it loads in node env.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * shouldAbandonResolvedSeek — post-getKeyPacket belt (fix A2, round-2).
 *
 * Root cause it fixes (round-2 forensics §A / V7): a condemned cue-less seek walk can RESOLVE
 * after the interrupt (35.7s zombie observed: resolved keyframe 1031.03s, created an Output,
 * emitted a 152B init segment — all corpse work discarded by the generation guard). The belt
 * bails to null right after getKeyPacket resolves, BEFORE markSeekResolved/lastSeekKeyframeTime/
 * harvest/Output/audio/init-emit, so a condemned seek does ZERO further work.
 */
describe('shouldAbandonResolvedSeek (post-getKeyPacket belt, fix A2)', () => {
  it('clean current-generation seek proceeds', () =>
    expect(shouldAbandonResolvedSeek(false, false, 7, 7)).toBe(false));

  it('interrupt re-set the abort flag → abandon (the 35.7s stale walk resolved post-interrupt)', () =>
    expect(shouldAbandonResolvedSeek(true, false, 7, 7)).toBe(true));

  it('disposed mid-walk → abandon', () =>
    expect(shouldAbandonResolvedSeek(false, true, 7, 7)).toBe(true));

  it('generation bumped by a newer seek → abandon (any mismatch, order-agnostic)', () => {
    expect(shouldAbandonResolvedSeek(false, false, 7, 8)).toBe(true);
    expect(shouldAbandonResolvedSeek(false, false, 8, 7)).toBe(true);
  });
});
