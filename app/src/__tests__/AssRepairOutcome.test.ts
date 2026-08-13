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
import { assDialogueIntervals, classifySubRepairOutcome, mergeAssContent } from '../hooks/useMSEPlayer';

const ass = (start: string, end: string, text: string) =>
  `[Script Info]\nScriptType: v4.00+\n[Events]\nDialogue: 0,${start},${end},Default,,0,0,0,,${text}`;

function classifyAss(before: string, after: string, playhead: number) {
  return classifySubRepairOutcome(
    null, null, playhead, false, false, undefined,
    before.length, after.length, null, null, null, null,
    assDialogueIntervals(after), assDialogueIntervals(before).length,
  );
}

describe('classifySubRepairOutcome — ASS/SSA tracks (no cue list)', () => {
  it('scores an ASS dialogue covering the playhead as ok', () => {
    expect(classifyAss('', ass('0:33:20.00', '0:33:30.00', 'visible'), 2005)).toBe('ok');
  });

  it('treats ordinary silence near extracted ASS dialogue as covered', () => {
    expect(classifyAss('', ass('0:33:00.00', '0:33:10.00', 'nearby'), 2050)).toBe('ok');
  });

  it('keeps retrying when new dialogue still does not cover the playhead', () => {
    expect(classifyAss('', ass('0:10:00.00', '0:10:10.00', 'earlier'), 2015)).toBe('progress-uncovered');
  });

  it('treats unchanged uncovered ASS as deferred, not success', () => {
    const content = ass('0:10:00.00', '0:10:10.00', 'earlier');
    expect(classifyAss(content, content, 2005)).toBe('deferred');
  });

  it('still reports no-progress when ASS extraction returns nothing', () => {
    expect(classifyAss(ass('0:10:00.00', '0:10:10.00', 'old'), '[Events]', 2005)).toBe('no-progress');
  });

  it('merges dialogue islands without losing the existing header or cues', () => {
    const first = ass('0:10:00.00', '0:10:10.00', 'first');
    const second = ass('0:50:00.00', '0:50:10.00', 'second');
    const merged = mergeAssContent(first, second);
    expect(merged.match(/^Dialogue:/gm)).toHaveLength(2);
    expect(merged).toContain('ScriptType: v4.00+');
    expect(mergeAssContent(merged, second)).toBe(merged);
  });

  it('manual refresh keeps earlier ASS islands instead of replacing them', () => {
    const opening = ass('0:00:32.00', '0:00:42.00', 'opening');
    const later = ass('1:16:45.00', '1:16:50.00', 'later');
    const merged = mergeAssContent(opening, later);
    expect(merged).toContain('opening');
    expect(merged).toContain('later');
    expect(assDialogueIntervals(merged)).toHaveLength(2);
  });

  it('a hard error is still failed, regardless of content', () => {
    expect(
      classifySubRepairOutcome(null, null, 2005, true, false, undefined, 0, 956),
    ).toBe('failed');
  });

  it('does not mistake a smaller unrelated island for success', () => {
    const covering = ass('0:33:20.00', '0:33:30.00', 'visible');
    const unrelated = ass('0:10:00.00', '0:10:10.00', 'earlier');
    expect(classifyAss(covering, unrelated, 2005)).toBe('deferred');
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
