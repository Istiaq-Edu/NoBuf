// @vitest-environment node
/**
 * Subtitle cues must never paint over a popup menu, and the position slider must be
 * bidirectional with its default at the midpoint.
 *
 * Z-ORDER is structural because it is a pure stacking-context concern: the overlay is
 * `z-20` inside the video box; the controls bar is a LATER SIBLING with no z-index, so
 * without an explicit level the overlay wins on DOM order and cues cover the captions
 * menu. The popover's own `z-50` cannot save it — the chip wrapper's
 * `hover:-translate-y-0.5` transform makes each chip a containing block that traps its
 * descendants' stacking.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  subtitleLayout,
  SUB_OFFSET_MIN_PCT,
  SUB_OFFSET_MAX_PCT,
  SUB_SAFE_PX,
} from '../lib/faststream/subtitles/subtitleLayout';

const player = readFileSync(
  join(__dirname, '..', 'components/dashboard/FastStreamPlayer.tsx'),
  'utf8',
);
const overlay = readFileSync(
  join(__dirname, '..', 'components/dashboard/SubtitleOverlay.tsx'),
  'utf8',
);

describe('subtitles never render above a popup menu', () => {
  it('the controls bar sits above the subtitle overlay', () => {
    // Anchor on the JSX attribute occurrence (the string also appears in a
    // `closest('[data-controls-root]')` guard earlier in the file).
    const attr = player.indexOf('        data-controls-root');
    expect(attr).toBeGreaterThan(-1);
    const bar = player.slice(attr, attr + 600);
    expect(bar).toContain('z-40');
    // The overlay must stay BELOW it.
    expect(overlay).toContain('z-20');
    expect(overlay).not.toContain('z-40');
    expect(overlay).not.toContain('z-50');
  });

  it('the settings panel stays above the raised control bar', () => {
    // The panel is a later sibling; leaving it at z-30 would put the bar on top of it.
    const panel = player.slice(player.indexOf('animate-[settingsIn_180ms_ease-out]') - 300);
    expect(panel.slice(0, 400)).toContain('z-50');
  });

  it('the captions popover is above the overlay via its parent bar', () => {
    const pop = player.slice(player.indexOf('{subMenu && ('), player.indexOf('{subMenu && (') + 400);
    expect(pop).toContain('z-50');
  });

  it('the overlay is pointer-events-none so raising the bar cannot steal clicks', () => {
    expect(overlay).toContain('pointer-events-none');
  });
});

describe('position slider is bidirectional with a midpoint default', () => {
  const input = (over: Partial<Parameters<typeof subtitleLayout>[0]> = {}) => ({
    boxW: 1920, boxH: 1080, videoW: 1920, videoH: 1080,
    fit: 'contain' as const, rotation: 0 as const,
    controlsContentH: 73, dlOverlayH: 0, panelReserveRight: 0,
    scale: 1, offsetPct: 0, blockH: 40, ...over,
  });

  it('the range is symmetric around zero', () => {
    expect(SUB_OFFSET_MIN_PCT).toBe(-SUB_OFFSET_MAX_PCT);
    expect(SUB_OFFSET_MIN_PCT).toBeLessThan(0);
  });

  it('a NEGATIVE offset lowers cues below the default', () => {
    // Use a LETTERBOXED layout so the default sits above the chrome floor and there is
    // genuine room to descend. In a flush 16:9 window the default is already floored at
    // the bar, so "lower" is a no-op there and the assertion would be vacuous — a
    // clamp(0,…) mutant survived exactly that mistake.
    const wide = { videoW: 2560, videoH: 1070, boxW: 1920, boxH: 1400, controlsContentH: 73 };
    const base = subtitleLayout(input({ ...wide, offsetPct: 0 }));
    const down = subtitleLayout(input({ ...wide, offsetPct: -20 }));
    // Must ACTUALLY move, not merely fail to rise.
    expect(down.bottomPx).toBeLessThan(base.bottomPx);
    expect(base.bottomPx - down.bottomPx).toBeGreaterThan(1);
    // …and never under the bar.
    expect(down.bottomPx).toBeGreaterThanOrEqual(73 + SUB_SAFE_PX - 0.001);
  });

  it('negative travel is proportional, not collapsed to the floor', () => {
    // Pins the SIGN handling: −10 must land strictly between 0 and −20.
    const wide = { videoW: 2560, videoH: 1070, boxW: 1920, boxH: 1400, controlsContentH: 73 };
    const at0 = subtitleLayout(input({ ...wide, offsetPct: 0 })).bottomPx;
    const at10 = subtitleLayout(input({ ...wide, offsetPct: -10 })).bottomPx;
    const at20 = subtitleLayout(input({ ...wide, offsetPct: -20 })).bottomPx;
    expect(at10).toBeLessThan(at0);
    expect(at20).toBeLessThan(at10);
  });

  it('a POSITIVE offset still raises cues', () => {
    const base = subtitleLayout(input({ offsetPct: 0 }));
    const up = subtitleLayout(input({ offsetPct: 20 }));
    expect(up.bottomPx).toBeGreaterThan(base.bottomPx);
  });

  it('the negative extreme can NEVER push cues under the control bar', () => {
    // The whole point of re-flooring after the offset: "lower" must stop at the bar,
    // not slide behind it where the text is unreadable.
    for (const ctrlH of [40, 73, 90, 140]) {
      const l = subtitleLayout(input({ offsetPct: SUB_OFFSET_MIN_PCT, controlsContentH: ctrlH }));
      expect(l.bottomPx).toBeGreaterThanOrEqual(ctrlH + SUB_SAFE_PX - 0.001);
    }
  });

  it('clamps an out-of-range persisted value at both ends', () => {
    const under = subtitleLayout(input({ offsetPct: -999 }));
    const over = subtitleLayout(input({ offsetPct: 999 }));
    const min = subtitleLayout(input({ offsetPct: SUB_OFFSET_MIN_PCT }));
    const max = subtitleLayout(input({ offsetPct: SUB_OFFSET_MAX_PCT }));
    expect(under.bottomPx).toBeCloseTo(min.bottomPx, 6);
    expect(over.bottomPx).toBeCloseTo(max.bottomPx, 6);
  });

  it('a non-finite offset behaves as the default, not as blank output', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const l = subtitleLayout(input({ offsetPct: bad }));
      expect(Number.isFinite(l.bottomPx)).toBe(true);
      expect(l.bottomPx).toBeCloseTo(subtitleLayout(input({ offsetPct: 0 })).bottomPx, 6);
    }
  });

  it('the slider UI spans the full signed range and centres its default', () => {
    const start = player.indexOf('aria-label="Subtitle vertical position"');
    expect(start).toBeGreaterThan(-1);
    // Window must cover the readout ABOVE the input and the labels BELOW it.
    const block = player.slice(start - 1200, start + 600);
    expect(block).toContain('min={SUB_OFFSET_MIN_PCT} max={SUB_OFFSET_MAX_PCT}');
    // Sign-aware readout: a negative value must not render as "+-20%".
    expect(block).toContain("settings.playerSubtitleOffsetPct > 0 ? '+' : '−'");
    expect(block).toContain('Math.abs(settings.playerSubtitleOffsetPct)');
    // Direction labels so the midpoint default is self-explanatory.
    expect(block).toContain('lower');
    expect(block).toContain('raise');
  });

  it('the persisted-settings sanitizer accepts the negative half', () => {
    const settings = readFileSync(join(__dirname, '..', 'context/SettingsContext.tsx'), 'utf8');
    expect(settings).toContain('cleaned.playerSubtitleOffsetPct, -40, 40');
    // Default stays at the midpoint.
    expect(settings).toContain('playerSubtitleOffsetPct: 0,');
  });
});
