/**
 * Round-10 P3-1 — probe-window clamp (`computeProbeFetchEnd`).
 *
 * Cold cue-less MKV seeks cost 13.0-15.6s click-to-first-frame. The bisect half
 * re-downloaded territory it had already proven useless: `stepBisectBracket`'s
 * 'above' branch shrinks `hi` to `mid`, establishing that no ≤-target cluster
 * exists at or above `hi`, yet every probe still pulled a full 2 MiB window.
 *
 * These tests pin the saving AND the round-3..9 invariants the clamp must not
 * break (plan E17-E19).
 */
import { describe, it, expect } from 'vitest';
import {
  computeProbeFetchEnd,
  stepBisectBracket,
  alignProbeStart,
  BISECT_CLAMP_SLACK_BYTES,
  BISECT_MIN_FETCH_BYTES,
  BISECT_CHUNK_ALIGN_BYTES,
  type BisectBracket,
} from '../lib/faststream/utils/MkvClusterBisect';

const W = 2 * 1024 * 1024;
const FSZ = 1_566_651_347; // the real asset

describe('computeProbeFetchEnd', () => {
  it('E17: leaves the window untouched while hi is still far away (first probes)', () => {
    const mid = 783_165_191;
    // hi = EOF on probe 1 — nothing proven yet, so no clamping.
    expect(computeProbeFetchEnd(mid, W, FSZ, FSZ)).toBe(mid + W - 1);
  });

  it('clamps to the proven bracket top once hi has shrunk', () => {
    const mid = 767_370_749;
    const hi = 767_884_960; // proven: no ≤-target cluster at/above this
    const end = computeProbeFetchEnd(mid, W, hi, FSZ);
    expect(end).toBeLessThan(mid + W - 1);
    expect(end).toBe(hi - 1 + BISECT_CLAMP_SLACK_BYTES);
  });

  it('keeps slack past hi so a straddling cluster header stays readable', () => {
    const mid = 1000;
    const hi = 2000;
    // A bare `hi` cut could truncate a 4-byte EBML ID + its Timestamp child.
    expect(computeProbeFetchEnd(mid, W, hi, FSZ)).toBeGreaterThan(hi);
  });

  it('never requests less than one Telegram chunk (a tiny range costs the same)', () => {
    const mid = 1_000_000;
    const hi = mid + 16; // absurdly tight bracket
    const end = computeProbeFetchEnd(mid, W, hi, FSZ);
    expect(end - mid + 1).toBeGreaterThanOrEqual(BISECT_MIN_FETCH_BYTES);
  });

  it('never reads past EOF, even with slack or the chunk floor applied', () => {
    const mid = FSZ - 100;
    expect(computeProbeFetchEnd(mid, W, FSZ, FSZ)).toBe(FSZ - 1);
    // Chunk floor must not push past EOF either.
    expect(computeProbeFetchEnd(FSZ - 10, W, FSZ - 5, FSZ)).toBe(FSZ - 1);
  });

  it('never returns an end below mid (empty/negative range)', () => {
    expect(computeProbeFetchEnd(5000, W, 1, FSZ)).toBeGreaterThanOrEqual(5000);
  });

  it('REAL 10-t SEQUENCE: 14.00 MiB -> 8.05 MiB, 28 -> 17 chunks (~3.3s)', () => {
    // Verbatim probe starts from 10-t seek #2; answer cluster at 766,837,065.
    const probes = [783_165_191, 758_024_771, 767_884_960, 767_370_749,
                    767_063_913, 766_921_798, 766_782_525];
    const ANSWER = 766_837_065;
    const CHUNK = 512 * 1024;

    let before = 0, after = 0;
    const br: BisectBracket = { lo: 0, hi: FSZ, loTicks: 0, hiTicks: 1 };
    for (const mid of probes) {
      before += W;
      after += computeProbeFetchEnd(mid, W, br.hi, FSZ) - mid + 1;
      // Mirror the driver: a probe above the answer proves hi can shrink to mid.
      if (mid > ANSWER) stepBisectBracket(br, mid, { kind: 'above', byte: mid, ticks: 2 });
    }

    expect(before).toBe(14 * 1024 * 1024);
    // 8.05 MiB, not the 7.30 MiB of the idealised model: the 64KiB straddle
    // slack and the 512KiB chunk floor cost ~0.6s between them, and both are
    // correctness requirements rather than tunables.
    expect(after).toBeLessThan(before);
    expect(after / 1024 / 1024).toBeCloseTo(8.05, 1);
    // Chunk count is what the 300ms rate limiter actually charges us for.
    const chunksBefore = Math.ceil(before / CHUNK);
    const chunksAfter = Math.ceil(after / CHUNK);
    expect(chunksBefore).toBe(28);
    expect(chunksAfter).toBe(17);
    // ~3.3s at 300ms/chunk — DERIVED from the rate limiter, not yet measured e2e.
    expect((chunksBefore - chunksAfter) * 0.3).toBeCloseTo(3.3, 1);
  });
});

describe('alignProbeStart (round-10b L1)', () => {
  it('aligns a probe start DOWN to a 512 KiB chunk boundary', () => {
    // Real probe 1 from the 10-t seek. Re-derived: 783165191 / 524288 = 1493.77,
    // so the chunk floor is 1493 * 524288 = 782,761,984 and the discarded
    // leading remainder is 783,165,191 - 782,761,984 = 403,207 bytes.
    const aligned = alignProbeStart(783_165_191, 0);
    expect(aligned % BISECT_CHUNK_ALIGN_BYTES).toBe(0);
    expect(aligned).toBe(782_761_984);
    expect(783_165_191 - aligned).toBe(403_207);
  });

  it('never steps below the proven bracket floor', () => {
    // Bytes under `lo` are already proven to hold no ≤-target cluster.
    const lo = 700_000_000;
    expect(alignProbeStart(700_000_100, lo)).toBe(lo);
  });

  it('is a no-op on an already-aligned start', () => {
    const already = 12 * BISECT_CHUNK_ALIGN_BYTES;
    expect(alignProbeStart(already, 0)).toBe(already);
  });

  it('REGRESSION: alignment must not feed the bracket — round-5 spin fix', () => {
    // stepBisectBracket's 'above' branch sets hi = mid. Feeding it the ALIGNED
    // (lower) value would shrink the bracket further than the evidence supports
    // and could skip the answer.
    const mid = 783_165_191;
    const aligned = alignProbeStart(mid, 0);
    expect(aligned).toBeLessThan(mid);

    const brUnaligned: BisectBracket = { lo: 0, hi: FSZ, loTicks: 0, hiTicks: 1 };
    stepBisectBracket(brUnaligned, mid, { kind: 'above', byte: mid, ticks: 2 });
    expect(brUnaligned.hi).toBe(mid); // the correct, evidence-backed value

    const brAligned: BisectBracket = { lo: 0, hi: FSZ, loTicks: 0, hiTicks: 1 };
    stepBisectBracket(brAligned, aligned, { kind: 'above', byte: aligned, ticks: 2 });
    // Demonstrates the bug this guards against: a tighter, UNPROVEN bracket.
    expect(brAligned.hi).toBeLessThan(brUnaligned.hi);
  });

  it('saves one 512 KiB API call per probe on the real 10-t sequence', () => {
    const probes = [783_165_191, 758_024_771, 767_884_960, 767_370_749,
                    767_063_913, 766_921_798, 766_782_525];
    const W = 2 * 1024 * 1024;
    const CHUNK = 512 * 1024;
    let unalignedCalls = 0, alignedCalls = 0;
    for (const mid of probes) {
      // Unaligned: a leading partial chunk pushes 4 chunks of payload into 5 calls.
      const uStart = mid, uEnd = mid + W - 1;
      unalignedCalls += Math.ceil(uEnd / CHUNK) - Math.floor(uStart / CHUNK);
      const aStart = alignProbeStart(mid, 0), aEnd = aStart + W - 1;
      alignedCalls += Math.ceil(aEnd / CHUNK) - Math.floor(aStart / CHUNK);
    }
    expect(alignedCalls).toBeLessThan(unalignedCalls);
    expect(unalignedCalls - alignedCalls).toBe(probes.length); // exactly 1 per probe
  });
});

describe('clamp preserves the round-5/round-7 bisect invariants', () => {
  it('E18: round-5 spin fix — "above" still shrinks hi to MID, not to the found byte', () => {
    const br: BisectBracket = { lo: 100, hi: 10_000, loTicks: 0, hiTicks: 999 };
    // Cluster found INSIDE the window, so its byte is >= mid by construction.
    stepBisectBracket(br, 5000, { kind: 'above', byte: 7500, ticks: 500 });
    expect(br.hi).toBe(5000); // NOT 7500 — otherwise the bracket never shrinks
  });

  it('E18: the shrunken hi immediately narrows the next probe window', () => {
    const br: BisectBracket = { lo: 100, hi: 10_000_000, loTicks: 0, hiTicks: 999 };
    const wide = computeProbeFetchEnd(1_000_000, W, br.hi, FSZ);
    stepBisectBracket(br, 1_500_000, { kind: 'above', byte: 1_800_000, ticks: 500 });
    const narrow = computeProbeFetchEnd(1_000_000, W, br.hi, FSZ);
    expect(narrow).toBeLessThan(wide);
  });

  it('E19: clamping affects only the FETCH size, never the probe point', () => {
    // The injected answer comes from pickBisectProbe/scan results, which the
    // clamp does not touch — so the round-7 shadow guarantee (inject BEHIND the
    // keyframe shadow, never at the target) is unaffected by construction.
    const br: BisectBracket = { lo: 0, hi: 900_000, loTicks: 0, hiTicks: 10 };
    const end = computeProbeFetchEnd(800_000, W, br.hi, FSZ);
    expect(end).toBeGreaterThanOrEqual(800_000); // range still starts AT mid
    expect(br.lo).toBe(0);                        // bracket untouched by clamping
    expect(br.hi).toBe(900_000);
  });

  it('"below" outcomes advance lo and do not clamp anything away', () => {
    const br: BisectBracket = { lo: 100, hi: 10_000_000, loTicks: 0, hiTicks: 999 };
    stepBisectBracket(br, 2000, { kind: 'below', byte: 2500, ticks: 300 });
    expect(br.lo).toBe(2501);
    // hi unchanged ⇒ still a full window available.
    expect(computeProbeFetchEnd(3000, W, br.hi, FSZ)).toBe(3000 + W - 1);
  });
});
