/**
 * Round-15 INTERACTION: R-3 (cue merge) × R-10 (PROACTIVE dead-band).
 *
 * Round-10's lesson: two changes that are individually green can be collectively
 * catastrophic. A serving path and a re-trigger path each passed their own tests
 * and together produced a 444-iteration loop that re-read gigabytes.
 *
 * These two changes touch the SAME chain:
 *
 *   R-10 widens the dead-band  →  PROACTIVE stops thrashing and actually downloads
 *                              →  the cache grows in large contiguous runs
 *                              →  `pick_subs_island` selects DIFFERENT islands
 *                              →  R-3 merges those islands' cues together
 *
 * So R-10 changes the INPUT DISTRIBUTION that R-3 consumes. Isolated tests never
 * exercise that. This file drives them as one closed loop and asserts BOUNDS, not
 * just correctness — a merge that is "correct" but unbounded in memory, or a
 * dead-band that is "correct" but never re-targets, both ship as bugs.
 */
import { describe, it, expect } from 'vitest';
import { mergeCues, lastCueEnd } from '../hooks/useMSEPlayer';

type Cue = { startTime: number; endTime: number; text: string };

/** Real numbers from the round-15 logs. */
const FILE_BYTES = 1_566_651_347;
const DURATION_S = 8888.136;
const MEAN_BPS = FILE_BYTES / DURATION_S;      // 176264.9
const EPSILON_BYTES = 5 * 1024 * 1024;          // R-10, mirrored from streaming.rs
const byteToTime = (b: number) => b / MEAN_BPS;

/** Mirror of `is_significant_target_change` (streaming.rs:102). */
const isSignificant = (cur: number, next: number) => Math.abs(next - cur) >= EPSILON_BYTES;

/** Cues at 1/sec over a time window — stands in for one island extraction. */
const island = (fromS: number, toS: number): Cue[] =>
  Array.from({ length: Math.max(0, Math.floor(toS - fromS)) }, (_, i) => ({
    startTime: fromS + i,
    endTime: fromS + i + 0.9,
    text: `cue@${Math.floor(fromS + i)}`,
  }));

describe('R-3 × R-10 interaction', () => {
  it('a full seek session leaves coverage monotonic AND bounded', () => {
    // The eight real seek targets from 15-c, in the order the user hit them.
    const seeks = [2212.1, 3397.8, 7174.3, 8160.7, 5181.4, 2381.5, 7074.6, 4294.6];

    let cues: Cue[] = [];
    let proactiveTarget = 0;
    let reEvaluations = 0;
    let prevEnd = -Infinity;
    let prevCount = 0;

    for (const t of seeks) {
      // R-10: does this seek move PROACTIVE's target past the dead-band?
      const targetByte = t * MEAN_BPS;
      if (isSignificant(proactiveTarget, targetByte)) {
        reEvaluations++;
        proactiveTarget = targetByte;
      }

      // R-3: the island around that playhead is extracted and merged in.
      // ~63s is the island width observed at 15-t:314 (11.1 MB).
      cues = mergeCues(cues, island(t, t + 63));

      // BOUND 1 — coverage never retreats (the R-3 invariant).
      const end = lastCueEnd(cues) ?? -Infinity;
      expect(end).toBeGreaterThanOrEqual(prevEnd);
      expect(cues.length).toBeGreaterThanOrEqual(prevCount);
      prevEnd = end;
      prevCount = cues.length;
    }

    // BOUND 2 — every one of these is a genuine user seek, so all must retarget.
    // (Pre-R-10 this was also 8; the thrash came from the ~13 spurious
    // "VBR correction" re-evals between them, which the wider band now absorbs.)
    expect(reEvaluations).toBe(8);

    // BOUND 3 — merged cue count stays proportional to what was extracted.
    // 8 islands × 63s, no overlap between these targets ⇒ 504. A merge that
    // duplicated on every pass would blow past this.
    expect(cues.length).toBe(8 * 63);
  });

  it('R-10 absorbs CBR jitter without R-3 losing coverage', () => {
    // The failure mode this pair could produce: PROACTIVE re-targets constantly,
    // each re-target yields a slightly different island, and every island
    // replaces the last. Pre-R-3 that destroyed cues; pre-R-10 it happened ~21
    // times per session.
    let cues: Cue[] = mergeCues([], island(2200, 2400));
    const baselineEnd = lastCueEnd(cues)!;
    const baselineCount = cues.length;

    let target = 2200 * MEAN_BPS;
    let reEvaluations = 0;

    // 50 sub-epsilon CBR wobbles around a stationary playhead.
    for (let i = 0; i < 50; i++) {
      const jitter = (i % 2 === 0 ? 1 : -1) * 2 * 1024 * 1024;  // ±2 MiB < 5 MiB
      const candidate = 2200 * MEAN_BPS + jitter;
      if (isSignificant(target, candidate)) {
        reEvaluations++;
        target = candidate;
        // A re-target re-extracts a NARROWER island — the 15-c:188 shape.
        cues = mergeCues(cues, island(2200, 2210));
      }
    }

    // BOUND — the dead-band must swallow all of it.
    expect(reEvaluations).toBe(0);
    // And coverage is untouched regardless.
    expect(lastCueEnd(cues)).toBeCloseTo(baselineEnd, 5);
    expect(cues.length).toBe(baselineCount);
  });

  it('the 15-c:188 regression cannot occur even when PROACTIVE re-targets', () => {
    // Compose the exact production failure: wide coverage installed, then a real
    // seek moves PROACTIVE (crossing the dead-band), and the resulting island is
    // far narrower than what the user already had.
    let cues = mergeCues([], island(0, 2300));      // user has 0-2300s
    const before = lastCueEnd(cues)!;

    const moved = isSignificant(0, 3397.8 * MEAN_BPS);
    expect(moved).toBe(true);                        // genuine seek, R-10 allows it

    cues = mergeCues(cues, island(100, 169));        // narrow island (the bug input)
    const after = lastCueEnd(cues)!;

    expect(after).toBeCloseTo(before, 5);            // 2131s NOT lost
    expect(cues[0].startTime).toBe(0);               // head intact
  });

  it('merge cost stays bounded across a long session (no quadratic blowup)', () => {
    // 74 extractions is the ledger ceiling noted in the repair-breaker comment.
    let cues: Cue[] = [];
    const t0 = performance.now();
    for (let i = 0; i < 74; i++) cues = mergeCues(cues, island(i * 120, i * 120 + 120));
    const elapsed = performance.now() - t0;

    expect(cues.length).toBe(74 * 120);
    // Generous ceiling — this is a smoke alarm for accidental O(n²), not a benchmark.
    expect(elapsed).toBeLessThan(2000);
  });
});
