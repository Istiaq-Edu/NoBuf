import { describe, it, expect, vi } from 'vitest';
import { computeRefillChainDelay } from '../hooks/useMSEPlayer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Null-failure backoff (fix C, refill-stall stack): a refill whose seekTo
 * returned null must NOT rechain at 0ms — on cue-less MKV the null is
 * deterministic (frozen demuxer position cache, zero I/O per retry; 3,413
 * observed retries at ~130Hz were arithmetic-guaranteed pointless). Flat
 * 1000ms turns the spin into ≤1Hz while the breaker (fix B) counts to its
 * verdict in ~4s. Healthy refills keep the shipped delay formula BYTE-FOR-BYTE
 * (regression pin below) so cue-indexed/TS chains are provably untouched.
 */
describe('computeRefillChainDelay', () => {
  it('returns 1000ms after a null refill regardless of buffer state', () => {
    expect(computeRefillChainDelay(true, 0.1, 20)).toBe(1000);
    expect(computeRefillChainDelay(true, 15, 20)).toBe(1000);
    expect(computeRefillChainDelay(true, 25, 20)).toBe(1000);
  });

  it('keeps 0ms immediate rechain below threshold on healthy refills', () => {
    expect(computeRefillChainDelay(false, 5, 20)).toBe(0);
    expect(computeRefillChainDelay(false, 19.9, 20)).toBe(0);
  });

  it('pins the shipped adaptive formula for healthy refills at/above threshold', () => {
    // min(5000, max(2000, floor((ahead-20)*200)))
    expect(computeRefillChainDelay(false, 20, 20)).toBe(2000);   // floor(0)→2000 clamp
    expect(computeRefillChainDelay(false, 25, 20)).toBe(2000);   // 1000→2000 clamp
    expect(computeRefillChainDelay(false, 32.5, 20)).toBe(2500); // formula region
    expect(computeRefillChainDelay(false, 40, 20)).toBe(4000);
    expect(computeRefillChainDelay(false, 60, 20)).toBe(5000);   // 8000→5000 cap
  });
});
