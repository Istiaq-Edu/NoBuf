/**
 * Round-10 P1-2 — subtitle coverage repair (pure helpers).
 *
 * Session A is the regression these encode: extraction returned cues for
 * 0-196s of an 8888s film while the viewer sat at 4500s. Nothing rendered, and
 * nothing in the app ever re-extracted — `fetchEmbeddedSubText` had exactly one
 * consumer (a manual click) whose re-extract branch required `partial && !active`,
 * and the backend's disk-cache replay omits `X-Subs-Partial`, so a truncated body
 * arrived as `partial:false`: a permanent dead end.
 *
 * `shouldReExtractSub` replaces that flag with cue-list ground truth.
 */
import { describe, it, expect } from 'vitest';
import { shouldReExtractSub, lastCueEnd, SUB_COVERAGE_GRACE_S } from '../hooks/useMSEPlayer';

const cues = (...ends: number[]) => ends.map((e) => ({ endTime: e }));

describe('lastCueEnd', () => {
  it('returns the furthest cue end', () => {
    expect(lastCueEnd(cues(10, 200, 55))).toBe(200);
  });

  it('returns null for an empty list (ASS/jassub tracks keep cues empty)', () => {
    expect(lastCueEnd([])).toBeNull();
  });

  it('ignores non-finite ends rather than poisoning the max', () => {
    expect(lastCueEnd(cues(10, NaN, 30, Infinity))).toBe(30);
  });
});

describe('shouldReExtractSub', () => {
  it('SESSION A: playhead 4500s with cues ending at 196s must re-extract', () => {
    expect(shouldReExtractSub(4500, 196, false)).toBe(true);
  });

  it('does not re-extract while the playhead is inside covered territory', () => {
    expect(shouldReExtractSub(150, 196, false)).toBe(false);
  });

  it('never re-extracts a fully-covered track, however far ahead the playhead', () => {
    // Whole file extracted: dialogue legitimately ends long before the credits.
    expect(shouldReExtractSub(8000, 196, true)).toBe(false);
  });

  it('re-extracts when a track has no cues at all', () => {
    expect(shouldReExtractSub(100, null, false)).toBe(true);
  });

  it('leaves a fully-covered cue-less track alone (ASS renders via jassub)', () => {
    expect(shouldReExtractSub(100, null, true)).toBe(false);
  });

  it('tolerates the normal end-of-dialogue gap via the grace window', () => {
    const lastCue = 1000;
    // Just inside the grace window — a real gap between lines, not a failure.
    expect(shouldReExtractSub(lastCue + SUB_COVERAGE_GRACE_S - 1, lastCue, false)).toBe(false);
    // Beyond it — the cues have genuinely fallen behind.
    expect(shouldReExtractSub(lastCue + SUB_COVERAGE_GRACE_S + 1, lastCue, false)).toBe(true);
  });

  it('is inclusive at the grace boundary (no re-extract exactly at the edge)', () => {
    expect(shouldReExtractSub(1000 + SUB_COVERAGE_GRACE_S, 1000, false)).toBe(false);
  });

  it('ignores a non-finite or negative playhead instead of thrashing', () => {
    expect(shouldReExtractSub(NaN, 196, false)).toBe(false);
    expect(shouldReExtractSub(-5, 196, false)).toBe(false);
  });

  it('honours a custom grace window', () => {
    expect(shouldReExtractSub(210, 196, false, 5)).toBe(true);
    expect(shouldReExtractSub(210, 196, false, 100)).toBe(false);
  });
});
