/**
 * Round-22 F2 — bisect terminal creep.
 *
 * `alignProbeStart` floors every probe's fetch start to a 512 KiB cell
 * (BISECT_CHUNK_ALIGN_BYTES). While the bracket is wide that is right: it stops
 * the leading partial chunk being wasted. Once the bracket narrows to a couple
 * of cells, consecutive interpolated mids floor to ADJACENT cells, so the probe
 * advances exactly one cell per iteration instead of halving — the alignment
 * grain becomes the search step.
 *
 * From 22-t seek 2 (target 4982.1s), the tail of the bisect:
 *
 *   830,996,480 -> 829,947,904   1024 KiB  = 2 align cells
 *   829,947,904 -> 829,423,616    512 KiB  = 1 align cell
 *   829,423,616 -> 828,899,328    512 KiB  = 1 align cell
 *
 * Byte-exact multiples of the align cell. That seek used 7 probes where ~4 would
 * do; at the fitted ~0.79s round-trip + 0.30s limiter per probe, the three creep
 * steps cost ~3.3s of an 11.5s bisect.
 *
 * `bisectShouldStop` cannot catch this: it needs BOTH `best` and `nextAbove`, and
 * a downward creep keeps producing 'below' hits so `nextAbove` stays null.
 */
import { describe, it, expect } from 'vitest';
import {
  bisectBracketTooNarrow,
  bisectShouldStop,
  alignProbeStart,
  BISECT_MIN_USEFUL_BRACKET_BYTES,
  BISECT_CHUNK_ALIGN_BYTES,
  BISECT_WALKABLE_GAP_BYTES,
} from '../lib/faststream/utils/MkvClusterBisect';

const KIB = 1024;

describe('round-22 F2: bisect terminal creep', () => {
  it('reproduces the creep steps from the 22-t log', () => {
    // Every observed step is an exact multiple of the alignment cell — proof the
    // thing moving is the FLOORED fetch start, not the interpolated mid.
    const probes = [830_996_480, 829_947_904, 829_423_616, 828_899_328];
    const steps = probes.slice(0, -1).map((p, i) => p - probes[i + 1]);
    expect(steps).toEqual([1024 * KIB, 512 * KIB, 512 * KIB]);
    for (const s of steps) {
      expect(s % BISECT_CHUNK_ALIGN_BYTES).toBe(0);
    }
  });

  it('stops on the narrow brackets that produced those creep steps', () => {
    // The last two steps ran on a 512 KiB bracket — half of it (256 KiB) is
    // smaller than one align cell, so no probe can express real progress.
    expect(bisectBracketTooNarrow(829_423_616, 829_947_904)).toBe(true);
    expect(bisectBracketTooNarrow(828_899_328, 829_423_616)).toBe(true);
  });

  it('keeps probing while the bracket is still wide', () => {
    // Seek 2's opening bracket spanned the whole file — must not stop there.
    expect(bisectBracketTooNarrow(0, 1_566_651_347)).toBe(false);
    // ...and a mid-search 34 MB bracket is still very much worth halving.
    expect(bisectBracketTooNarrow(837_812_224, 873_988_096)).toBe(false);
  });

  it('draws the line at exactly 2 alignment cells', () => {
    const lo = 800_000_000;
    expect(BISECT_MIN_USEFUL_BRACKET_BYTES).toBe(2 * BISECT_CHUNK_ALIGN_BYTES);
    // Exactly at the threshold -> too narrow (inclusive).
    expect(bisectBracketTooNarrow(lo, lo + BISECT_MIN_USEFUL_BRACKET_BYTES)).toBe(true);
    // One byte wider -> still useful.
    expect(bisectBracketTooNarrow(lo, lo + BISECT_MIN_USEFUL_BRACKET_BYTES + 1)).toBe(false);
  });

  it('is consistent with the alignment it defends against', () => {
    // The degeneracy is QUANTISATION LOSS: alignment can only deliver whole
    // cells, so a halving step smaller than one cell is rounded away entirely.
    const lo = 828_899_328; // cell-aligned, as every post-align probe start is
    const half = (w: number) => {
      const hi = lo + w;
      const mid = lo + Math.floor((hi - lo) / 2);
      return alignProbeStart(mid, lo) - lo;
    };
    // 1 cell wide: halving wants +256 KiB, alignment delivers ZERO — the probe
    // cannot move at all and would re-read the identical range.
    expect(half(BISECT_CHUNK_ALIGN_BYTES)).toBe(0);
    // At the threshold the step is exactly one cell — the observed creep.
    expect(half(BISECT_MIN_USEFUL_BRACKET_BYTES)).toBe(BISECT_CHUNK_ALIGN_BYTES);
    // Both of those brackets are cut by the guard.
    expect(bisectBracketTooNarrow(lo, lo + BISECT_CHUNK_ALIGN_BYTES)).toBe(true);
    expect(bisectBracketTooNarrow(lo, lo + BISECT_MIN_USEFUL_BRACKET_BYTES)).toBe(true);
    // Above it, alignment tracks the true halving point again.
    expect(half(4 * BISECT_CHUNK_ALIGN_BYTES)).toBe(2 * BISECT_CHUNK_ALIGN_BYTES);
    expect(bisectBracketTooNarrow(lo, lo + 4 * BISECT_CHUNK_ALIGN_BYTES)).toBe(false);
  });

  it('handles degenerate and inverted brackets without throwing', () => {
    expect(bisectBracketTooNarrow(100, 100)).toBe(true);   // empty
    expect(bisectBracketTooNarrow(200, 100)).toBe(true);   // inverted
    expect(bisectBracketTooNarrow(0, 0)).toBe(true);
  });

  it('does not replace the round-5 walkable-gap rule', () => {
    // The two stop rules answer different questions and must both survive.
    // Round-5 case: best/nextAbove bracket a 12.58 MB cluster interior.
    expect(bisectShouldStop(703_792_419, 716_375_330, BISECT_WALKABLE_GAP_BYTES)).toBe(false);
    // ...and a gap inside the walkable budget does stop.
    expect(bisectShouldStop(800_000_000, 800_000_000 + BISECT_WALKABLE_GAP_BYTES, BISECT_WALKABLE_GAP_BYTES)).toBe(true);
    // F2's rule is independent of nextAbove, which is exactly why it catches the
    // downward creep that leaves nextAbove null.
    expect(bisectShouldStop(829_423_616, null, BISECT_WALKABLE_GAP_BYTES)).toBe(false);
    expect(bisectBracketTooNarrow(829_423_616, 829_947_904)).toBe(true);
  });

  it('threshold stays well under the walkable-gap budget', () => {
    // If F2's threshold ever exceeded the walkable gap it would cut the search
    // short of what the bounded walk can absorb.
    expect(BISECT_MIN_USEFUL_BRACKET_BYTES).toBeLessThan(BISECT_WALKABLE_GAP_BYTES);
  });
});
