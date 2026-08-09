/**
 * Round-16: ASS/SSA subtitle repairs were scored `no-progress` unconditionally.
 *
 * The bug, from log 16-c:213 and 16-c:267:
 *
 *   [SUBS] repair track 2 attempt 1/6: no-progress — coverage nones → nones, playhead 2005s, 62ms
 *   [SUBS] repair track 3 attempt 1/6: no-progress — coverage nones → nones, playhead 2015s, 48ms
 *
 * Both extractions SUCCEEDED (956 and 1495 characters of real subtitle text).
 * But jassub renders ASS from `assContent` and leaves `cues` EMPTY by design, so
 * `lastCueEnd` returns null before and after — every time, forever. That made
 * `shouldReExtractSub(playhead, null)` return true, so the classifier fell
 * straight through to 'no-progress'.
 *
 * Consequence: the breaker counted a failure after every successful ASS repair,
 * backed off 150s, and after 6 attempts would disable subtitle repair for the
 * file entirely.
 */
import { describe, it, expect } from 'vitest';
import { classifySubRepairOutcome } from '../hooks/useMSEPlayer';

describe('classifySubRepairOutcome — ASS/SSA tracks (no cue list)', () => {
  it('scores a successful ASS extraction as progress, not no-progress', () => {
    // The exact 16-c:213 scenario: 0 bytes -> 956 bytes at playhead 2005s.
    const outcome = classifySubRepairOutcome(
      null, null, 2005, false, false, undefined,
      0,    // assBeforeLen — nothing loaded yet
      956,  // assAfterLen  — the extraction that got scored a failure
    );
    expect(outcome).toBe('progress');
  });

  it('scores the 16-c:267 case (1495 chars) as progress too', () => {
    expect(
      classifySubRepairOutcome(null, null, 2015, false, false, undefined, 0, 1495),
    ).toBe('progress');
  });

  it('treats unchanged ASS content as ok — NOT a breaker-tripping failure', () => {
    // Re-extracting the same region returns the same text. That is the extractor
    // having nothing more to give right now, not evidence of a fault.
    expect(
      classifySubRepairOutcome(null, null, 2005, false, false, undefined, 956, 956),
    ).toBe('ok');
  });

  it('still reports no-progress when ASS extraction returns nothing', () => {
    expect(
      classifySubRepairOutcome(null, null, 2005, false, false, undefined, 956, 0),
    ).toBe('no-progress');
  });

  it('growing ASS content across repairs is progress', () => {
    expect(
      classifySubRepairOutcome(null, null, 3000, false, false, undefined, 956, 4200),
    ).toBe('progress');
  });

  it('a hard error is still failed, regardless of content', () => {
    expect(
      classifySubRepairOutcome(null, null, 2005, true, false, undefined, 0, 956),
    ).toBe('failed');
  });

  it('SIX consecutive successful ASS repairs never trip the breaker', () => {
    // The regression that mattered: 6 failures disables repair for the file.
    // Simulate a track whose content grows, then plateaus.
    const lengths = [0, 956, 1495, 2400, 2400, 2400, 2400];
    const outcomes = lengths.slice(1).map((len, i) =>
      classifySubRepairOutcome(null, null, 2000 + i * 10, false, false, undefined, lengths[i], len),
    );
    expect(outcomes).not.toContain('no-progress');
    expect(outcomes).not.toContain('failed');
  });
});

describe('classifySubRepairOutcome — cue-list tracks are unchanged', () => {
  it('SRT coverage growth is still progress', () => {
    expect(classifySubRepairOutcome(169, 2300, 3398, false, false)).toBe('progress');
  });

  it('SRT coverage regression is still no-progress', () => {
    // The round-15 R-3 case: 2300s -> 169s while the playhead is at 3398s.
    expect(classifySubRepairOutcome(2300, 169, 3398, false, false)).toBe('no-progress');
  });

  it('SRT coverage that reaches the playhead is ok', () => {
    expect(classifySubRepairOutcome(100, 3500, 3398, false, false)).toBe('ok');
  });

  it('SRT error is failed', () => {
    expect(classifySubRepairOutcome(100, null, 3398, true, false)).toBe('failed');
  });
});
