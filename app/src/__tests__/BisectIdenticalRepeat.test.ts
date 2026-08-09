/**
 * Round-23 G2/G3 — bisect driver: identical-repeat and progress-based creep.
 *
 * G2. `computeProbeFetchEnd` floors its result at `mid + BISECT_MIN_FETCH_BYTES`.
 *     Once `hi` is close, that floor BINDS and fetchEnd depends on `mid` alone —
 *     independent of both `window` and `hi`. The no-cluster path then doubles
 *     `window` (2→4→8 MiB) and re-probes, re-issuing a BYTE-IDENTICAL request
 *     each time, then `return null` — which degrades the caller to the unbounded
 *     raw walk that bisection exists to prevent.
 *
 *     23-t shows exactly three identical fetches, twice:
 *       L332/334/336  1095761920-1096286207  (524288 B, all PREBUFFER HIT)
 *       L479/481/483   676855808-677380095   (524288 B, all PREBUFFER HIT)
 *
 * G3. Round-22's F2 guard only fires under 1 MiB. The 23-t terminal steps shrank
 *     the bracket ~2% per probe while still ~25 MiB wide, so they slipped past.
 *     Research proposed raising the width threshold to 25 MiB; that is REJECTED
 *     here — it would hand a 25 MiB residue to a walk budgeted at 4 MiB. The
 *     shipped rule is progress-based AND gated on the residue being walkable.
 */
import { describe, it, expect } from 'vitest';
import {
  bisectMkvClusterSearch,
  computeProbeFetchEnd,
  bisectProbeIsCreeping,
  bisectBracketTooNarrow,
  alignProbeStart,
  BISECT_MIN_FETCH_BYTES,
  BISECT_CHUNK_ALIGN_BYTES,
  BISECT_WALKABLE_GAP_BYTES,
  BISECT_CLAMP_SLACK_BYTES,
} from '../lib/faststream/utils/MkvClusterBisect';

const MIB = 1024 * 1024;

describe('round-23 G2: the MIN_FETCH floor makes window growth a no-op', () => {
  it('reproduces the byte-identical repeat from 23-t L332/334/336', () => {
    // The observed repeated range, and the bracket state that produced it.
    const fetchStart = 1_095_761_920;
    const observedEnd = 1_096_286_207; // = fetchStart + 524288 - 1
    expect(observedEnd - fetchStart + 1).toBe(BISECT_MIN_FETCH_BYTES);

    // `hi` close enough that the floor binds. Growing the window 2→4→8 MiB
    // cannot move fetchEnd by a single byte — this is the whole defect.
    const hi = fetchStart + 200_000;
    const fileSize = 1_566_651_347;
    const ends = [2 * MIB, 4 * MIB, 8 * MIB].map((w) =>
      computeProbeFetchEnd(fetchStart, w, hi, fileSize),
    );
    expect(ends).toEqual([observedEnd, observedEnd, observedEnd]);
  });

  it('reproduces the second occurrence, 23-t L479/481/483', () => {
    const fetchStart = 676_855_808;
    const observedEnd = 677_380_095;
    const hi = fetchStart + 150_000;
    const ends = [2 * MIB, 4 * MIB, 8 * MIB].map((w) =>
      computeProbeFetchEnd(fetchStart, w, hi, 1_566_651_347),
    );
    expect(new Set(ends).size).toBe(1);
    expect(ends[0]).toBe(observedEnd);
  });

  it('identifies the exact onset condition: hi - fetchStart < minFetch + slack', () => {
    const fetchStart = 1_000_000_000;
    const fileSize = 1_566_651_347;
    const onset = BISECT_MIN_FETCH_BYTES + BISECT_CLAMP_SLACK_BYTES;
    // Just inside the onset: floor binds, window is ignored.
    const tight = hi2 => [2 * MIB, 8 * MIB].map(w => computeProbeFetchEnd(fetchStart, w, hi2, fileSize));
    const inside = tight(fetchStart + onset - 1);
    expect(inside[0]).toBe(inside[1]);
    // Comfortably outside: the window is honoured again, so growth helps.
    const outside = tight(fetchStart + 16 * MIB);
    expect(outside[0]).not.toBe(outside[1]);
  });

  it('window growth DOES still work when the bracket is wide', () => {
    // Guard against over-fixing: growth must remain effective in the normal case.
    const fetchStart = 500_000_000;
    const hi = fetchStart + 64 * MIB;
    const small = computeProbeFetchEnd(fetchStart, 2 * MIB, hi, 1_566_651_347);
    const large = computeProbeFetchEnd(fetchStart, 8 * MIB, hi, 1_566_651_347);
    expect(large - small).toBe(6 * MIB);
  });
});

describe('round-23 G3: creep detection by progress, gated on walkability', () => {
  it('cuts a ~2% shrink once the residue is walkable', () => {
    // The 23-t signature: bracket barely moves, and it is small enough that the
    // forward walk can absorb what remains.
    const width = 3 * MIB;                 // <= walkable gap
    const prev = Math.round(width / 0.98); // r ≈ 0.98 shrink
    expect(bisectProbeIsCreeping(prev, width)).toBe(true);
  });

  it('does NOT cut while the residue exceeds the walk budget', () => {
    // This is the rejected proposal's failure mode: a wide bracket shrinking
    // slowly must keep probing, because the walk is budgeted at 4 MiB.
    //
    // Ratio matters. At r = 0.98 a 25 MiB bracket sheds 522 KiB — MORE than one
    // align cell — so the progress rule alone already returns false and this
    // assertion would pass even with the walkable gate deleted (verified: the
    // first version of this test survived that mutation). r = 0.995 sheds
    // 129 KiB, so the gate is the only thing that can save it.
    const width = 25 * MIB;
    const prev = Math.round(width / 0.995);
    expect(prev - width).toBeLessThan(BISECT_CHUNK_ALIGN_BYTES); // genuinely creeping
    expect(width).toBeGreaterThan(BISECT_WALKABLE_GAP_BYTES);    // but not walkable
    expect(bisectProbeIsCreeping(prev, width)).toBe(false);
  });

  it('never fires on the first probe (no previous width)', () => {
    expect(bisectProbeIsCreeping(-1, 1 * MIB)).toBe(false);
    expect(bisectProbeIsCreeping(-1, 500 * MIB)).toBe(false);
  });

  it('allows healthy halving to continue', () => {
    // A real bisection halves; that is progress far above one align cell.
    expect(bisectProbeIsCreeping(8 * MIB, 4 * MIB)).toBe(false);
    expect(bisectProbeIsCreeping(4 * MIB, 2 * MIB)).toBe(false);
  });

  it('treats a bracket that did not move at all as creeping', () => {
    expect(bisectProbeIsCreeping(2 * MIB, 2 * MIB)).toBe(true);
  });

  it('uses one alignment cell as the progress floor', () => {
    const w = 3 * MIB;
    // Exactly one cell of progress is enough to continue.
    expect(bisectProbeIsCreeping(w + BISECT_CHUNK_ALIGN_BYTES, w)).toBe(false);
    // One byte less is quantised away by alignProbeStart.
    expect(bisectProbeIsCreeping(w + BISECT_CHUNK_ALIGN_BYTES - 1, w)).toBe(true);
  });

  it('stays consistent with the F2 width rule rather than replacing it', () => {
    // F2 catches the sub-1-MiB case regardless of shrink ratio; G3 catches the
    // slow-shrink case above it. Both must survive.
    const lo = 828_899_328;
    expect(bisectBracketTooNarrow(lo, lo + BISECT_CHUNK_ALIGN_BYTES)).toBe(true);
    expect(bisectProbeIsCreeping(4 * MIB, 3 * MIB)).toBe(false); // 1 MiB progress
  });

  it('the walkable gate is the load-bearing difference from the rejected fix', () => {
    // Identical ABSOLUTE progress on both sides, so the progress rule cannot be
    // what separates them — only the walkable gate can. Any shrink below one
    // align cell is "creeping"; whether we ACT on it depends solely on whether
    // the walk can absorb what is left.
    const progress = 128 * 1024; // < BISECT_CHUNK_ALIGN_BYTES
    const walkable = 2 * MIB;        // <= 4 MiB budget -> cut
    const notWalkable = 25 * MIB;    // >  4 MiB budget -> keep probing
    expect(progress).toBeLessThan(BISECT_CHUNK_ALIGN_BYTES);
    expect(bisectProbeIsCreeping(walkable + progress, walkable)).toBe(true);
    expect(bisectProbeIsCreeping(notWalkable + progress, notWalkable)).toBe(false);
  });

  it('boundary: exactly at the walkable gap is still cuttable', () => {
    // <= walkableGap is what the walk is budgeted for, so the boundary itself
    // must be treated as absorbable.
    const w = BISECT_WALKABLE_GAP_BYTES;
    expect(bisectProbeIsCreeping(w + 1024, w)).toBe(true);
    // One byte over, and it is the walk's problem no longer.
    expect(bisectProbeIsCreeping(w + 1 + 1024, w + 1)).toBe(false);
  });
});

describe('round-23 G2: driver level — the loop must not re-issue the same range', () => {
  /**
   * The helper tests above prove the MIN_FETCH floor makes `window` irrelevant.
   * They do NOT prove the loop stops repeating, because the repeat is a property
   * of the driver, not the helper. This drives the real `bisectMkvClusterSearch`
   * through the injected `fetchImpl` seam and counts actual HTTP ranges.
   *
   * The trap: a region with NO cluster at all, so `scanForMkvClusterInWindow`
   * returns null and the grow path at :595 is taken (window 2→4→8 MiB). With the
   * floor binding, all three probes ask for the identical bytes.
   */
  function clusterlessFetch() {
    const calls: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { headers?: { Range?: string } }) => {
      const m = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? '');
      if (!m) throw new Error('no range');
      const start = parseInt(m[1], 10);
      const end = parseInt(m[2], 10);
      calls.push(`${start}-${end}`);
      // Zero-filled: parses cleanly, contains no cluster ID anywhere.
      return {
        ok: true,
        status: 206,
        arrayBuffer: async () => new Uint8Array(end - start + 1).buffer,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it('issues each byte range at most once (no identical repeat)', async () => {
    const { calls, fetchImpl } = clusterlessFetch();
    // Bracket tight enough that the MIN_FETCH floor binds immediately, which is
    // what 23-t L332/334/336 looked like.
    const startLo = 1_095_761_920;
    await bisectMkvClusterSearch({
      probeUrl: 'http://x/stream?source_id=playback-bisect',
      fileSize: startLo + 260_000,
      startLo,
      targetTicks: 5_000_000,
      hiTicks: 6_000_000,
      fetchImpl,
    });
    const unique = new Set(calls);
    expect(calls.length).toBe(unique.size);
  });

  it('specifically never fetches one range three times (the 23-t ladder)', async () => {
    const { calls, fetchImpl } = clusterlessFetch();
    const startLo = 676_855_808;
    await bisectMkvClusterSearch({
      probeUrl: 'http://x/stream?source_id=playback-bisect',
      fileSize: startLo + 200_000,
      startLo,
      targetTicks: 3_000_000,
      hiTicks: 6_000_000,
      fetchImpl,
    });
    const counts = new Map<string, number>();
    for (const c of calls) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(Math.max(0, ...counts.values())).toBeLessThanOrEqual(1);
  });

  it('still finds the answer on a healthy file (guard is not over-eager)', async () => {
    // Regression fence: the identical-repeat break must not truncate a search
    // that is making real progress.
    const fileSize = 64 * MIB;
    const spacing = 1 * MIB;
    const file = new Uint8Array(fileSize);
    const clusters: { byte: number; ticks: number }[] = [];
    // Minimal valid cluster: ID 1F43B675, unknown size, CRC, Timestamp, block.
    for (let byte = 4096, i = 0; byte + 64 < fileSize; byte += spacing, i++) {
      const ticks = i * 1000;
      const ts = [0xe7, 0x83, (ticks >> 16) & 0xff, (ticks >> 8) & 0xff, ticks & 0xff];
      const body = [0xbf, 0x81, 0x00, ...ts, 0xa3, 0x81, 0x00];
      file.set([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...body], byte);
      clusters.push({ byte, ticks });
    }
    const fetchImpl = (async (_url: unknown, init?: { headers?: { Range?: string } }) => {
      const m = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? '');
      const start = parseInt(m![1], 10);
      const end = parseInt(m![2], 10);
      return {
        ok: true,
        status: 206,
        arrayBuffer: async () => file.slice(start, end + 1).buffer,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const targetTicks = 40_500;
    const res = await bisectMkvClusterSearch({
      probeUrl: 'http://x/stream?source_id=playback-bisect',
      fileSize,
      startLo: 4096,
      targetTicks,
      hiTicks: 63_000,
      fetchImpl,
    });
    expect(res).not.toBeNull();
    const expected = clusters.filter((c) => c.ticks <= targetTicks).pop()!;
    expect(res!.entry.elementStartPos).toBe(expected.byte);
  });
});

describe('round-23: edge cases required by the plan', () => {
  it('bracket smaller than one chunk', () => {
    const lo = 800 * MIB;
    expect(bisectBracketTooNarrow(lo, lo + 1000)).toBe(true);
    expect(bisectProbeIsCreeping(1000, 999)).toBe(true);
  });

  it('EOF: fetchEnd never exceeds the last byte', () => {
    const fileSize = 1_566_651_347;
    const nearEof = fileSize - 1000;
    const end = computeProbeFetchEnd(nearEof, 8 * MIB, fileSize, fileSize);
    expect(end).toBeLessThanOrEqual(fileSize - 1);
  });

  it('monster 12.58 MB cluster interior is NOT cut by the creep rule', () => {
    // Round-5's case: best@703792419 next@716375330. That residue is far above
    // the walk budget, so slow progress must not end the search.
    const gap = 716_375_330 - 703_792_419;
    expect(gap).toBeGreaterThan(BISECT_WALKABLE_GAP_BYTES);
    expect(bisectProbeIsCreeping(Math.round(gap / 0.98), gap)).toBe(false);
  });

  it('inverted bracket does not throw or report progress', () => {
    expect(bisectProbeIsCreeping(100, 200)).toBe(true); // width grew => no progress
    expect(bisectBracketTooNarrow(200, 100)).toBe(true);
  });

  it('alignment still floors probe starts to the bracket floor', () => {
    const lo = 1_095_761_920;
    expect(alignProbeStart(lo + 1000, lo)).toBe(lo);
  });
});
