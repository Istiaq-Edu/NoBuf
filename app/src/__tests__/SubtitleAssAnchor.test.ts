// @vitest-environment jsdom
/**
 * ASS alignment-tag parsing for the top-anchored ({\an8}) subtitle band.
 *
 * jsdom is required only at MODULE LOAD: importing SubtitleOverlay pulls in the
 * vendored vtt.mjs, whose last line is `export const WebVTT = window.WebVTT`, so a
 * node environment throws ReferenceError before any test runs. The functions under
 * test are pure strings-in/strings-out — no DOM is touched here (and none could be:
 * jsdom has no ResizeObserver and returns 0 for every geometry read, which is why
 * the anchor split was extracted as exported functions in the first place).
 */
import { describe, expect, it } from 'vitest';
import { isAssTopAligned, activeAssDialoguesByAnchor, activeAssText } from '../components/dashboard/SubtitleOverlay';

describe('isAssTopAligned — \\anN (ASS v4+)', () => {
  it('treats 7/8/9 as top', () => {
    for (const n of [7, 8, 9]) {
      expect(isAssTopAligned(`{\\an${n}}Sign text`)).toBe(true);
    }
  });

  it('treats 1-6 as not top', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(isAssTopAligned(`{\\an${n}}Dialogue`)).toBe(false);
    }
  });

  it('defaults to bottom with no alignment tag at all', () => {
    expect(isAssTopAligned('Plain dialogue line')).toBe(false);
    expect(isAssTopAligned('{\\i1}Italic but bottom{\\i0}')).toBe(false);
  });
});

describe('isAssTopAligned — legacy \\aN (SSA v4)', () => {
  it('treats 5/6/7 as top', () => {
    for (const n of [5, 6, 7]) {
      expect(isAssTopAligned(`{\\a${n}}Legacy sign`)).toBe(true);
    }
  });

  it('treats 1/2/3 (bottom) and 9/10/11 (middle) as not top', () => {
    for (const n of [1, 2, 3, 9, 10, 11]) {
      expect(isAssTopAligned(`{\\a${n}}Legacy line`)).toBe(false);
    }
  });

  it('does not confuse \\an5 (middle) with \\a5 (top)', () => {
    // The two dialects disagree on 5, so the `n` capture must be respected:
    // \an5 is middle-center (NOT top); \a5 is legacy top-left (top).
    expect(isAssTopAligned('{\\an5}Middle')).toBe(false);
    expect(isAssTopAligned('{\\a5}Legacy top')).toBe(true);
  });
});

describe('isAssTopAligned — tag placement and precedence', () => {
  it('finds the tag when combined with other overrides in one block', () => {
    expect(isAssTopAligned('{\\an8\\fs20\\c&HFFFFFF&}Styled sign')).toBe(true);
    expect(isAssTopAligned('{\\fs20\\an8}Order does not matter')).toBe(true);
  });

  it('finds the tag in a later block, not just the first', () => {
    expect(isAssTopAligned('{\\fs20}text{\\an8}moved up')).toBe(true);
  });

  it('lets the LAST alignment tag win, matching libass override processing', () => {
    expect(isAssTopAligned('{\\an8}{\\an2}ends at bottom')).toBe(false);
    expect(isAssTopAligned('{\\an2}{\\an8}ends at top')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAssTopAligned('{\\AN8}Sign')).toBe(true);
  });

  it('ignores an alignment-looking sequence OUTSIDE a brace block', () => {
    // Literal text must never be read as an override.
    expect(isAssTopAligned('the file is \\an8 bytes')).toBe(false);
  });

  it('does not treat unrelated \\a-prefixed tags as alignment', () => {
    // \alpha is not an alignment tag; a naive /\\a(\d+)/ would not match it either,
    // but an over-broad pattern might. Assert the intended behavior explicitly.
    expect(isAssTopAligned('{\\alpha&H80&}semi-transparent')).toBe(false);
  });
});

describe('activeAssDialoguesByAnchor', () => {
  const dialogues = [
    { start: 0, end: 10, text: 'Bottom dialogue' },
    { start: 0, end: 10, text: '{\\an8}Top sign' },
    { start: 20, end: 30, text: 'Later line' },
  ];

  it('splits simultaneous cues into the two bands', () => {
    const { bottom, top } = activeAssDialoguesByAnchor(dialogues, 5);
    expect(bottom).toEqual(['Bottom dialogue']);
    expect(top).toEqual(['Top sign']);
  });

  it('strips override tags from the emitted text', () => {
    const { top } = activeAssDialoguesByAnchor(dialogues, 5);
    expect(top[0]).not.toContain('\\an8');
    expect(top[0]).not.toContain('{');
  });

  it('returns empty bands when nothing is active', () => {
    expect(activeAssDialoguesByAnchor(dialogues, 15)).toEqual({ bottom: [], top: [] });
  });

  it('uses a half-open interval [start, end) so cues never double-render', () => {
    expect(activeAssDialoguesByAnchor(dialogues, 0).bottom).toHaveLength(1);
    // At t=10 the first pair has ended and the next has not begun.
    expect(activeAssDialoguesByAnchor(dialogues, 10)).toEqual({ bottom: [], top: [] });
    expect(activeAssDialoguesByAnchor(dialogues, 20).bottom).toEqual(['Later line']);
  });

  it('drops cues that render to empty text (drawing commands)', () => {
    const drawing = [{ start: 0, end: 10, text: '{\\p1}m 0 0 l 100 0 100 100{\\p0}' }];
    expect(activeAssDialoguesByAnchor(drawing, 5)).toEqual({ bottom: [], top: [] });
  });

  it('keeps multiple cues within the same band in order', () => {
    const stacked = [
      { start: 0, end: 5, text: '{\\an8}First sign' },
      { start: 0, end: 5, text: '{\\an8}Second sign' },
    ];
    expect(activeAssDialoguesByAnchor(stacked, 1).top).toEqual(['First sign', 'Second sign']);
  });

  it('preserves the pre-existing single-band helper (no regression)', () => {
    // activeAssText is the older API; it must still return BOTH groups flattened,
    // so any remaining caller keeps seeing every active line.
    // NB: the declared Format has 10 fields, so each Dialogue needs 9 commas before
    // the text — Name is empty, hence `Default,,0,0,0,,`.
    const content = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,Bottom line',
      'Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,{\\an8}Top line',
    ].join('\n');
    expect(activeAssText(content, 5)).toEqual(['Bottom line', 'Top line']);
  });
});
