// @vitest-environment jsdom
/**
 * Task 9 acceptance criteria that were missed on the first pass and are invisible to
 * both tsc and the behavioural tests:
 *
 *   9.2 double-click resets on the Size and Position sliders
 *   9.2 ±0.1s sync nudge buttons
 *   9.3 the whole appearance block is gated on the file HAVING subtitles (D13)
 *
 * These are structural assertions against the shipped JSX. That is deliberate: a
 * render-condition regression ("controls appear on a file with no subtitles", "the
 * reset stopped working") produces no type error and no behavioural failure
 * anywhere else in the suite.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const player = readFileSync(
  join(__dirname, '..', 'components/dashboard/FastStreamPlayer.tsx'),
  'utf8',
);

/**
 * The appearance/sync column: anchored on CODE, not comment prose.
 *
 * An earlier version sliced from `{/* Appearance + sync.` — a comment — and every
 * assertion broke the moment that comment was reworded during the two-column
 * redesign. Anchor on the D13 gate expression instead, which is the thing under test.
 */
function appearanceBlock(): string {
  const start = player.indexOf('{(subs.tracks.length > 0 || msePlayer.embeddedSubTracks.length > 0) && (');
  expect(start).toBeGreaterThan(-1);
  const end = player.indexOf("case 'audio':", start);
  expect(end).toBeGreaterThan(start);
  return player.slice(start, end);
}

describe('Task 9.3 — the appearance block is gated on having subtitles (D13)', () => {
  it('renders only when a sidecar or embedded track exists', () => {
    // Without this the file shows Size/Position/Sync sliders and an OpenSubtitles
    // key field on a video that has no subtitles at all — dead UI.
    expect(appearanceBlock()).toContain(
      '{(subs.tracks.length > 0 || msePlayer.embeddedSubTracks.length > 0) && (',
    );
  });

  it('the gate opens BEFORE the sliders, not after them', () => {
    const block = appearanceBlock();
    const firstSlider = block.indexOf('aria-label="Subtitle size"');
    // appearanceBlock() starts AT the gate, so the slider must appear after index 0.
    expect(firstSlider).toBeGreaterThan(0);
  });
});

describe('Task 9.2 — double-click resets each slider to its default', () => {
  it('Size resets to 1 (100%)', () => {
    const block = appearanceBlock();
    expect(block).toContain(
      "onDoubleClick={(e) => { e.stopPropagation(); updateSetting('playerSubtitleFontScale', 1); }}",
    );
  });

  it('Position resets to 0 (Default)', () => {
    const block = appearanceBlock();
    expect(block).toContain(
      "onDoubleClick={(e) => { e.stopPropagation(); updateSetting('playerSubtitleOffsetPct', 0); }}",
    );
  });

  it('both reset handlers stopPropagation so the menu does not close', () => {
    const block = appearanceBlock();
    const dbl = block.match(/onDoubleClick=\{\(e\) => \{[^}]*\}/g) ?? [];
    expect(dbl.length).toBeGreaterThanOrEqual(2);
    for (const h of dbl) expect(h).toContain('e.stopPropagation()');
  });
});

describe('Task 9.2 — ±0.1s sync nudge buttons', () => {
  it('offers both a −0.1 and a +0.1 nudge', () => {
    const block = appearanceBlock();
    expect(block).toContain('applySubDelay(subDelay - 0.1)');
    expect(block).toContain('applySubDelay(subDelay + 0.1)');
  });

  it('each nudge is disabled at the corresponding limit', () => {
    // Nudging past ±SUB_DELAY_LIMIT_S would be silently clamped, so the button must
    // read as unavailable rather than appearing to do nothing.
    const block = appearanceBlock();
    expect(block).toContain('disabled={subDelay <= -SUB_DELAY_LIMIT_S}');
    expect(block).toContain('disabled={subDelay >= SUB_DELAY_LIMIT_S}');
  });

  it('keeps the Reset control alongside the nudges', () => {
    const block = appearanceBlock();
    expect(block).toContain('applySubDelay(0)');
    expect(block).toContain('disabled={subDelay === 0}');
  });

  it('nudges stopPropagation so clicking one does not dismiss the menu', () => {
    const block = appearanceBlock();
    const idx = block.indexOf('applySubDelay(subDelay - 0.1)');
    // The handler on that same line must stop propagation.
    const line = block.slice(block.lastIndexOf('\n', idx), block.indexOf('\n', idx));
    expect(line).toContain('e.stopPropagation()');
  });
});

describe('Task 9.1 — the block stayed outside the EarlySubtitleSelection fence', () => {
  it('sits after the "Load subtitle file…" divider, not inside the toggle handlers', () => {
    // §1.3: EarlySubtitleSelection.test.ts slices named regions; inserting inside
    // one would break it. It passes, but pin the ordering that keeps it passing.
    const loadRow = player.indexOf('Load subtitle file…');
    const block = player.indexOf('{(subs.tracks.length > 0 || msePlayer.embeddedSubTracks.length > 0) && (');
    const toggleHandler = player.indexOf('const toggleEmbeddedSub = useCallback');
    expect(loadRow).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(loadRow);
    expect(block).toBeGreaterThan(toggleHandler);
  });
});
