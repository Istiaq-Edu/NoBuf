/**
 * Round-15 R-3 — subtitle cue MERGE (never clobber).
 *
 * The bug (forensics R-3, log 15-c:188):
 *   [SUBS] repair track 3 attempt 1/6: no-progress — coverage 2300s -> 169s
 *
 * `repairSubCoverage` did `entry.track.cues = []` then `loadText(res.text)` — an
 * unconditional REPLACE. Under island mode a later extraction is built around the
 * CURRENT playhead, so it legitimately covers a narrower span than an earlier one.
 * The user lost 2131 seconds of subtitles they already had.
 *
 * `classifySubRepairOutcome` DID flag it as 'no-progress', but only after the
 * write — detection is not protection.
 *
 * Worse (found during the edge-case pass, invisible in the log): an extraction
 * covering 2100-2400s replacing one covering 0-2300s RAISES lastCueEnd
 * (2300 -> 2400) so it scores 'ok', while silently dropping every cue before
 * 2100s. Coverage is an interval set; a max cannot describe it.
 */
import { describe, it, expect } from 'vitest';
import { mergeCues, lastCueEnd } from '../hooks/useMSEPlayer';

type Cue = { startTime: number; endTime: number; text: string };
const cue = (s: number, e: number, t = `c${s}`): Cue => ({ startTime: s, endTime: e, text: t });

/** Cues at 1/sec over [from, to). */
const span = (from: number, to: number): Cue[] =>
  Array.from({ length: to - from }, (_, i) => cue(from + i, from + i + 0.9));

describe('mergeCues — the round-15 regression', () => {
  it('E1: keeps the wider coverage when a NARROWER extraction arrives (the 15-c:188 bug)', () => {
    const existing = span(0, 2300);   // what the user already had
    const incoming = span(0, 169);    // what island mode returned

    const merged = mergeCues(existing, incoming);

    // The exact assertion that fails against the pre-fix `cues = []` behaviour.
    expect(lastCueEnd(merged)).toBeCloseTo(lastCueEnd(existing)!, 5);
    expect(merged.length).toBe(2300);
  });

  it('E2: keeps the HEAD when the new extraction only covers a later window', () => {
    // This is the case the breaker scores 'ok' — lastCueEnd RISES while cues
    // before 2100s are destroyed. Silent data loss in every prior round.
    const existing = span(0, 2300);
    const incoming = span(2100, 2400);

    const merged = mergeCues(existing, incoming);

    expect(lastCueEnd(merged)).toBeCloseTo(2399.9, 5);   // tail extended
    expect(merged[0].startTime).toBe(0);                  // head PRESERVED
    expect(merged.length).toBe(2400);                     // union, 200 overlap deduped
  });

  it('E3: identical extraction is a no-op (dedupe, no duplicates)', () => {
    const existing = span(0, 100);
    const merged = mergeCues(existing, span(0, 100));
    expect(merged.length).toBe(100);
  });

  it('E4: interior extraction loses neither head nor tail', () => {
    const existing = [...span(0, 50), ...span(200, 250)];
    const merged = mergeCues(existing, span(100, 150));

    expect(merged[0].startTime).toBe(0);
    expect(lastCueEnd(merged)).toBeCloseTo(249.9, 5);
    expect(merged.length).toBe(150);
  });

  it('E5: cold start — empty existing accepts everything', () => {
    expect(mergeCues([], span(0, 169)).length).toBe(169);
  });

  it('E6: an EMPTY extraction cannot destroy existing coverage', () => {
    const existing = span(0, 2300);
    const merged = mergeCues(existing, []);
    expect(lastCueEnd(merged)).toBeCloseTo(lastCueEnd(existing)!, 5);
    expect(merged.length).toBe(2300);
  });

  it('output stays sorted by start time regardless of input order', () => {
    const merged = mergeCues([cue(500, 501)], [cue(10, 11), cue(900, 901), cue(100, 101)]);
    expect(merged.map((c) => c.startTime)).toEqual([10, 100, 500, 900]);
  });

  it('cues sharing a start time but differing in end/text are both kept', () => {
    const merged = mergeCues([cue(10, 11, 'a')], [cue(10, 12, 'a'), cue(10, 11, 'b')]);
    expect(merged.length).toBe(3);
  });

  it('preserves the ALREADY-DISPLAYED object on an exact duplicate', () => {
    // The renderer may hold live VTTCue instances; a duplicate key must not swap
    // the object out from under it.
    const live = cue(10, 11, 'same');
    const fresh = cue(10, 11, 'same');
    const merged = mergeCues([live], [fresh]);
    expect(merged.length).toBe(1);
    expect(merged[0]).toBe(live);
  });

  it('MONOTONICITY: coverage never shrinks across a chain of arbitrary extractions', () => {
    // The property that makes the fix correct by construction, not by luck.
    const extractions = [span(0, 300), span(1000, 1100), span(50, 80), [], span(2000, 2300), span(0, 10)];
    let acc: Cue[] = [];
    let prevEnd = -Infinity;
    let prevCount = 0;

    for (const next of extractions) {
      acc = mergeCues(acc, next);
      const end = lastCueEnd(acc) ?? -Infinity;
      expect(end).toBeGreaterThanOrEqual(prevEnd);      // tail never retreats
      expect(acc.length).toBeGreaterThanOrEqual(prevCount); // cues never vanish
      prevEnd = end;
      prevCount = acc.length;
    }
  });
});
