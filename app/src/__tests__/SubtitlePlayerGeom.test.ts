// @vitest-environment jsdom
/**
 * Player-side subtitle geometry derivations.
 *
 * These three functions were extracted OUT of the ResizeObserver callback and the
 * panel memo precisely so they can be bound by tests: jsdom has no ResizeObserver
 * and returns 0 for every geometry read, so the measurement path itself is
 * untestable — but the arithmetic it performs is not.
 *
 * jsdom is needed only at MODULE LOAD (importing FastStreamPlayer pulls in the
 * vendored vtt.mjs, which reads `window` at import time). The functions under test
 * are pure numbers in, numbers out.
 */
import { describe, expect, it } from 'vitest';
import {
  controlsInteractiveHeight,
  subGeomChanged,
  panelReserve,
} from '../components/dashboard/FastStreamPlayer';

describe('controlsInteractiveHeight', () => {
  it('subtracts the transparent pt-16 gradient pad from the border box', () => {
    // A real measurement: 152px border box, 64px pt-16 → 88px of actual controls.
    expect(controlsInteractiveHeight(152, 64)).toBe(88);
  });

  it('is NOT the same quantity as the existing controlsHeight state', () => {
    // controlsHeight is contentRect.height = borderBox - pt-16 - pb-2 = 80.
    // Subtracting the 64px pad from THAT would double-count it and float subtitles
    // 64px too high. This function starts from the BORDER box, hence 88 not 16.
    const borderBox = 152;
    const contentBox = borderBox - 64 - 8; // 80, what controlsHeight holds
    expect(controlsInteractiveHeight(borderBox, 64)).toBe(88);
    expect(controlsInteractiveHeight(contentBox, 64)).toBe(16); // the WRONG input
    expect(controlsInteractiveHeight(borderBox, 64)).not.toBe(contentBox);
  });

  it('never returns a negative height', () => {
    // Padding can exceed height mid-transition while the bar collapses.
    expect(controlsInteractiveHeight(40, 64)).toBe(0);
    expect(controlsInteractiveHeight(0, 64)).toBe(0);
  });

  it('treats a missing or unparsable padding as zero', () => {
    // parseFloat('') is NaN — the caller's `|| 0` handles it, but the function must
    // be total anyway, since a NaN would propagate into an inline px style.
    expect(controlsInteractiveHeight(152, NaN)).toBe(152);
    expect(controlsInteractiveHeight(NaN, 64)).toBe(0);
    expect(Number.isFinite(controlsInteractiveHeight(NaN, NaN))).toBe(true);
  });

  it('grows when the chip row wraps on a narrow window', () => {
    const single = controlsInteractiveHeight(152, 64);
    const wrapped = controlsInteractiveHeight(216, 64); // one extra 64px row
    expect(wrapped).toBeGreaterThan(single);
    expect(wrapped - single).toBe(64);
  });
});

describe('subGeomChanged', () => {
  const base = { boxW: 1920, boxH: 1000, ctrlH: 88 };

  it('reports a real resize', () => {
    expect(subGeomChanged(base, { ...base, boxW: 1600 })).toBe(true);
    expect(subGeomChanged(base, { ...base, boxH: 800 })).toBe(true);
    expect(subGeomChanged(base, { ...base, ctrlH: 152 })).toBe(true);
  });

  it('ignores sub-pixel jitter from fractional rects at 125%/150% DPI', () => {
    // Windows scaling yields values like 1919.6667; without an epsilon this would
    // re-render on every observer tick forever.
    expect(subGeomChanged(base, { boxW: 1920.2, boxH: 1000.3, ctrlH: 88.1 })).toBe(false);
  });

  it('uses a 0.5px threshold, exclusive below and inclusive at the bound', () => {
    expect(subGeomChanged(base, { ...base, boxW: 1920.49 })).toBe(false);
    expect(subGeomChanged(base, { ...base, boxW: 1920.5 })).toBe(true);
  });

  it('detects a change in any single axis independently', () => {
    expect(subGeomChanged(base, { boxW: 1920.1, boxH: 1000.1, ctrlH: 200 })).toBe(true);
  });

  it('treats the first real measurement after mount as a change', () => {
    // Initial state is all zeros; committing it would give fontSize 0 forever.
    expect(subGeomChanged({ boxW: 0, boxH: 0, ctrlH: 0 }, base)).toBe(true);
  });
});

describe('panelReserve', () => {
  it('is zero while the settings panel is closed', () => {
    expect(panelReserve(false, 336, 1920)).toBe(0);
  });

  it('reserves the panel width when open', () => {
    expect(panelReserve(true, 336, 1920)).toBe(336);
  });

  it('caps at 70% of the OUTER box, matching the panel maxWidth', () => {
    // The panel's own CSS is maxWidth:'70%' against the outer box, so the reserve
    // must use the same ceiling or it would over-reserve on a narrow window.
    expect(panelReserve(true, 9999, 1000)).toBe(700);
    expect(panelReserve(true, 336, 400)).toBe(280); // 70% of 400
  });

  it('prefers the live drag width over the persisted one (caller passes it)', () => {
    // The caller resolves panelDragWidth ?? persisted; both must survive the cap.
    expect(panelReserve(true, 500, 1920)).toBe(500);
    expect(panelReserve(true, 500, 600)).toBe(420);
  });

  it('never returns a negative or non-finite reserve', () => {
    for (const [w, outer] of [[NaN, 1920], [336, NaN], [-100, 1920], [336, 0], [NaN, NaN]] as const) {
      const got = panelReserve(true, w, outer);
      expect(Number.isFinite(got)).toBe(true);
      expect(got).toBeGreaterThanOrEqual(0);
    }
  });
});
