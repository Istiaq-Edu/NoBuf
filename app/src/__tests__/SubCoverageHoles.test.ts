/**
 * Round-20: subtitles worked for the first two seeks, then stopped forever.
 *
 * From 20-c, nine seeks were performed. Only the first two extracted:
 *
 *   seek 1  ->  2909.6s   EXTRACTED (2997 chars, cues ~3019..3574s)
 *   seek 2  ->  7543.0s   EXTRACTED ( 534 chars, cues ~7543..7574s)
 *   seek 3  ->  6377.1s   nothing
 *   seek 4  ->  5420.6s   nothing
 *   seek 5  ->  3108.9s   nothing
 *   seek 6  ->  3278.2s   nothing
 *   seek 7  ->  2291.8s   nothing
 *   seek 8  ->  3328.1s   nothing
 *   seek 9  ->  3168.6s   nothing
 *
 * The backend logs show no [SUBS] activity at all after 17:24:18 — the requests
 * never left the frontend.
 *
 * `shouldReExtractSub` asked "has the playhead outrun the LAST cue?":
 *
 *     return playheadS > lastCueEndS + graceS
 *
 * After seek 2, `lastCueEnd` is 7574. Every subsequent (backward) seek is below
 * that, so the gate said "covered" and skipped — even though the cues are two
 * tiny islands with a 3969-second hole between them, and every one of those
 * seeks landed inside the hole.
 *
 * Island extraction produces an INTERVAL SET, and a max cannot describe it —
 * the rule `mergeCues` already documents. The gate now asks the interval-set
 * question: is there a cue covering the playhead?
 */
import { describe, it, expect } from 'vitest';
import { shouldReExtractSub, SUB_COVERAGE_GRACE_S } from '../hooks/useMSEPlayer';

const cue = (startTime: number, endTime: number) => ({ startTime, endTime });

/**
 * The cue shape after the two successful extractions, taken from the log rather
 * than guessed. 20-c:186 reports `coverage 3019s → 7574s`, i.e. `lastCueEnd` was
 * 3019 after island A and 7574 after island B. Island A's 2997 B of SRT is a few
 * dozen cues ending at 3019s; island B's 534 B is a handful ending at 7574s.
 */
const ISLANDS = [
  cue(2889, 3019),   // island A, byte 509 MB — cues end at 3019s (20-c:186)
  cue(7543, 7574),   // island B, byte 1341 MB
];
const LAST_CUE_END = 7574;

describe('round-20: backward seeks into a hole between islands', () => {
  // 3108.9s is deliberately absent: it sits 89.9s past island A's last cue
  // (3019s), i.e. INSIDE the 90s grace window, so "covered" is the correct
  // verdict there. It gets its own test below.
  it.each([6377.1, 5420.6, 3278.2, 2291.8, 3328.1, 3168.6])(
    'seek back to %ss re-extracts (it is inside the hole)',
    (playhead) => {
      // Old behaviour: `playhead > 7574 + 90` is false -> skipped.
      expect(shouldReExtractSub(playhead, LAST_CUE_END, false)).toBe(false);
      // New behaviour: no cue interval covers it -> re-extract.
      expect(shouldReExtractSub(playhead, LAST_CUE_END, false, undefined, ISLANDS)).toBe(true);
    },
  );

  it('treats 3108.9s as covered — it is within grace of island A', () => {
    // 3108.9 - 3019 = 89.9 < SUB_COVERAGE_GRACE_S (90). Dialogue routinely
    // pauses this long, so re-extracting here would be churn, not repair.
    expect(shouldReExtractSub(3108.9, LAST_CUE_END, false, undefined, ISLANDS)).toBe(false);
  });

  it('does NOT re-extract inside a covered island', () => {
    expect(shouldReExtractSub(2950, LAST_CUE_END, false, undefined, ISLANDS)).toBe(false);
    expect(shouldReExtractSub(7550, LAST_CUE_END, false, undefined, ISLANDS)).toBe(false);
  });

  it('honours the grace window around each island', () => {
    const g = SUB_COVERAGE_GRACE_S;
    // Just inside grace after island A -> still counts as covered.
    expect(shouldReExtractSub(3019 + g - 1, LAST_CUE_END, false, undefined, ISLANDS)).toBe(false);
    // Just outside -> genuinely uncovered.
    expect(shouldReExtractSub(3019 + g + 1, LAST_CUE_END, false, undefined, ISLANDS)).toBe(true);
    // Symmetrically before island A.
    expect(shouldReExtractSub(2889 - g + 1, LAST_CUE_END, false, undefined, ISLANDS)).toBe(false);
    expect(shouldReExtractSub(2889 - g - 1, LAST_CUE_END, false, undefined, ISLANDS)).toBe(true);
  });

  it('still re-extracts past the end of the last island', () => {
    expect(shouldReExtractSub(8000, LAST_CUE_END, false, undefined, ISLANDS)).toBe(true);
  });

  it('never re-extracts a fully covered track, hole or not', () => {
    expect(shouldReExtractSub(5000, LAST_CUE_END, true, undefined, ISLANDS)).toBe(false);
  });

  it('falls back to the lastCueEnd rule when no cues are supplied', () => {
    // Existing callers that pass no interval list keep the old semantics.
    expect(shouldReExtractSub(6377, LAST_CUE_END, false)).toBe(false);
    expect(shouldReExtractSub(8000, LAST_CUE_END, false)).toBe(true);
    expect(shouldReExtractSub(6377, LAST_CUE_END, false, undefined, null)).toBe(false);
    expect(shouldReExtractSub(6377, LAST_CUE_END, false, undefined, [])).toBe(false);
  });

  it('re-extracts when there are no cues at all', () => {
    expect(shouldReExtractSub(3000, null, false)).toBe(true);
    expect(shouldReExtractSub(3000, null, false, undefined, [])).toBe(true);
  });

  it('rejects a nonsense playhead in both modes', () => {
    expect(shouldReExtractSub(NaN, LAST_CUE_END, false, undefined, ISLANDS)).toBe(false);
    expect(shouldReExtractSub(-1, LAST_CUE_END, false, undefined, ISLANDS)).toBe(false);
    expect(shouldReExtractSub(NaN, LAST_CUE_END, false)).toBe(false);
  });

  it('handles a dense prefix-shaped track the same as before', () => {
    // Contiguous cues from 0 — the shape the old rule was written for.
    const dense = Array.from({ length: 100 }, (_, i) => cue(i * 10, i * 10 + 9));
    expect(shouldReExtractSub(500, 999, false, undefined, dense)).toBe(false);
    // Past the end + grace.
    expect(shouldReExtractSub(999 + SUB_COVERAGE_GRACE_S + 1, 999, false, undefined, dense)).toBe(true);
  });

  it('reproduces the full nine-seek session from the log', () => {
    const seeks = [2909.6, 7543.0, 6377.1, 5420.6, 3108.9, 3278.2, 2291.8, 3328.1, 3168.6];
    const backward = seeks.slice(2);
    // Old rule skipped ALL seven — the reported bug.
    expect(backward.map((s) => shouldReExtractSub(s, LAST_CUE_END, false)))
      .toEqual([false, false, false, false, false, false, false]);
    // New rule attempts every one that is genuinely uncovered. 3108.9s (index 2)
    // is within grace of island A, so leaving it alone is correct.
    expect(backward.map((s) => shouldReExtractSub(s, LAST_CUE_END, false, undefined, ISLANDS)))
      .toEqual([true, true, false, true, true, true, true]);
  });
});
