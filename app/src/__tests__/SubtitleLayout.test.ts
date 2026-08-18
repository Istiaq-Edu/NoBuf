/**
 * Pure geometry tests for the subtitle overlay layout.
 *
 * Node environment on purpose (no jsdom docblock): every value here is injected, and
 * jsdom would add nothing — it returns 0 for getBoundingClientRect/offsetHeight/
 * videoWidth and has no ResizeObserver, which is precisely why this logic was
 * extracted into a pure module.
 *
 * The expected numbers were re-derived by execution while reviewing the plan; each
 * group cites the defect or edge case it pins.
 */
import { describe, expect, it } from 'vitest';
import {
  pictureRect,
  visiblePictureRect,
  rotatedPictureRect,
  subtitleLayout,
  SUB_FONT_RATIO,
  SUB_FONT_MIN_PX,
  SUB_FONT_MAX_PX,
  SUB_BOTTOM_RATIO,
  SUB_LETTERBOX_DESCENT_RATIO,
  SUB_SCALE_MIN,
  SUB_SCALE_MAX,
  SUB_OFFSET_MAX_PCT,
  SUB_LINE_WIDTH_16_9,
  SUB_LINE_WIDTH_OTHER,
  SUB_SAFE_PX,
  type SubFit,
  type SubLayoutInput,
} from '../lib/faststream/subtitles/subtitleLayout';

/** Minimal valid input; each test overrides only what it exercises. */
function input(over: Partial<SubLayoutInput> = {}): SubLayoutInput {
  return {
    boxW: 1920,
    boxH: 1000,
    videoW: 1920,
    videoH: 1080,
    fit: 'contain',
    rotation: 0,
    controlsContentH: 90,
    dlOverlayH: 0,
    panelReserveRight: 0,
    fontScale: 1,
    offsetPct: 0,
    blockH: 0,
    ...over,
  };
}

const finite = (r: { x: number; y: number; w: number; h: number }) =>
  [r.x, r.y, r.w, r.h].every(Number.isFinite);

describe('pictureRect', () => {
  it('contain pillarboxes a 16:9 video in a shorter box', () => {
    // Box is 1.92:1, video is 1.78:1 → height-limited, bars left/right.
    const p = pictureRect(1920, 1000, 1920, 1080, 'contain');
    expect(p.h).toBe(1000);
    expect(p.w).toBeCloseTo(1777.78, 2);
    expect(p.x).toBeCloseTo(71.11, 2);
    expect(p.y).toBe(0);
  });

  it('contain letterboxes in a tall narrow box (picture far above the box bottom)', () => {
    // The case that exposes the pb-[6%] defect: 475px of black below the picture.
    const p = pictureRect(800, 1400, 1920, 1080, 'contain');
    expect(p).toEqual({ x: 0, y: 475, w: 800, h: 450 });
  });

  it('contain on an exact aspect match yields scale 1 with no bars and no jitter', () => {
    const p = pictureRect(1920, 1080, 1920, 1080, 'contain');
    expect(p).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it('fill ignores intrinsic size entirely', () => {
    expect(pictureRect(1920, 1000, 1920, 1080, 'fill')).toEqual({ x: 0, y: 0, w: 1920, h: 1000 });
    // Even a wildly different aspect still fills.
    expect(pictureRect(800, 600, 3840, 1080, 'fill')).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it('none keeps intrinsic size and centers it, going negative when oversized', () => {
    expect(pictureRect(1920, 1000, 1920, 1080, 'none')).toEqual({ x: 0, y: -40, w: 1920, h: 1080 });
  });

  it('none with a 4K video in a small window returns the true unclipped rect', () => {
    // E8: the single most likely "subtitles disappeared" bug. A naive p.y + p.h here
    // gives 1580, so bottom = boxH - 1580 = -580 and the cues land off-screen.
    const p = pictureRect(1920, 1000, 3840, 2160, 'none');
    expect(p).toEqual({ x: -960, y: -580, w: 3840, h: 2160 });
    expect(1000 - (p.y + p.h)).toBe(-580);
  });

  it('none with a video SMALLER than the box centers it with the bottom above the box', () => {
    const p = pictureRect(1920, 1000, 640, 360, 'none');
    expect(p).toEqual({ x: 640, y: 320, w: 640, h: 360 });
    expect(p.y + p.h).toBe(680); // subtitles must sit 320px above the box bottom
  });

  it('falls back to the full box when intrinsic size is unknown or degenerate', () => {
    // E1 pre-loadedmetadata, E2 audio-only/0x0 — must match today's visual behavior.
    for (const [vw, vh] of [[null, null], [0, 0], [1920, 0], [0, 1080]] as const) {
      expect(pictureRect(1920, 1000, vw, vh, 'contain')).toEqual({ x: 0, y: 0, w: 1920, h: 1000 });
    }
  });

  it('returns a zero rect for a zero-size box rather than dividing', () => {
    // E11: videobox is legitimately 0x0 for a frame during mount.
    expect(pictureRect(0, 0, 1920, 1080, 'contain')).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('is TOTAL: no non-finite input can produce a non-finite rect', () => {
    // E13. A NaN px style is silently dropped by CSSOM, so a NaN here renders
    // nothing at all with no error. The video-size guard alone does NOT catch a
    // NaN BOX — that is why box dims are sanitized first.
    const fits: SubFit[] = ['contain', 'fill', 'none'];
    const bad = [NaN, Infinity, -Infinity, -5, 0, undefined as unknown as number];
    for (const fit of fits) {
      for (const bw of bad) {
        for (const bh of bad) {
          expect(finite(pictureRect(bw, bh, 1920, 1080, fit))).toBe(true);
        }
      }
      for (const vw of bad) {
        expect(finite(pictureRect(1920, 1000, vw, 1080, fit))).toBe(true);
        expect(finite(pictureRect(1920, 1000, 1920, vw, fit))).toBe(true);
      }
    }
    expect(finite(pictureRect(NaN, NaN, 1920, 1080, 'contain'))).toBe(true);
  });
});

describe('visiblePictureRect', () => {
  it('clips an oversized picture to the box', () => {
    const p = pictureRect(1920, 1000, 3840, 2160, 'none');
    expect(visiblePictureRect(p, 1920, 1000)).toEqual({ x: 0, y: 0, w: 1920, h: 1000 });
  });

  it('leaves a fully visible picture untouched', () => {
    const p = pictureRect(800, 1400, 1920, 1080, 'contain');
    expect(visiblePictureRect(p, 800, 1400)).toEqual({ x: 0, y: 475, w: 800, h: 450 });
  });

  it('never returns negative extents when the rect is fully outside', () => {
    const out = visiblePictureRect({ x: -500, y: -500, w: 100, h: 100 }, 1920, 1000);
    expect(out.w).toBe(0);
    expect(out.h).toBe(0);
  });
});

describe('rotatedPictureRect', () => {
  it('swaps w/h at 90 and 270 and keeps the center fixed', () => {
    const p = pictureRect(1920, 1000, 1920, 1080, 'contain');
    for (const rot of [90, 270] as const) {
      const r = rotatedPictureRect(p, rot);
      expect(r.w).toBeCloseTo(1000, 2);
      expect(r.h).toBeCloseTo(1777.78, 2);
      expect(r.x).toBeCloseTo(460, 2);
      expect(r.y).toBeCloseTo(-388.89, 2);
      // Center is rotation-invariant under object-position 50% 50%.
      expect(r.x + r.w / 2).toBeCloseTo(p.x + p.w / 2, 6);
      expect(r.y + r.h / 2).toBeCloseTo(p.y + p.h / 2, 6);
    }
  });

  it('preserves dimensions at 0 and 180', () => {
    const p = pictureRect(1920, 1000, 1920, 1080, 'contain');
    for (const rot of [0, 180] as const) {
      const r = rotatedPictureRect(p, rot);
      expect(r.w).toBeCloseTo(p.w, 6);
      expect(r.h).toBeCloseTo(p.h, 6);
    }
  });

  it('E14: at 90 the rotated picture bottom falls BELOW the box and must be clipped', () => {
    const p = pictureRect(1920, 1000, 1920, 1080, 'contain');
    const r = rotatedPictureRect(p, 90);
    expect(r.y + r.h - 1000).toBeCloseTo(388.89, 2); // off-screen by this much
    expect(visiblePictureRect(r, 1920, 1000).h).toBe(1000);
  });
});

describe('subtitleLayout — font size', () => {
  it('is 5% of picture height at 100% scale', () => {
    // 720p / 1080p / 1440p pictures, using fill so picture height == box height.
    for (const [ph, expected] of [[720, 36], [1080, 54], [1440, 72]] as const) {
      const l = subtitleLayout(input({ boxH: ph, fit: 'fill' }));
      expect(l.fontPx).toBe(expected);
      expect(l.fontPx).toBe(SUB_FONT_RATIO * ph);
    }
  });

  it('scales linearly with the user multiplier between the clamps', () => {
    const half = subtitleLayout(input({ boxH: 1080, fit: 'fill', fontScale: 0.5 }));
    const base = subtitleLayout(input({ boxH: 1080, fit: 'fill', fontScale: 1 }));
    expect(half.fontPx).toBe(27);
    expect(base.fontPx).toBe(54);
    expect(half.fontPx * 2).toBe(base.fontPx);
  });

  it('clamps the ceiling: 300% on a 1080p picture would be 162px', () => {
    const l = subtitleLayout(input({ boxH: 1080, fit: 'fill', fontScale: SUB_SCALE_MAX }));
    expect(SUB_FONT_RATIO * 1080 * SUB_SCALE_MAX).toBe(162);
    expect(l.fontPx).toBe(SUB_FONT_MAX_PX);
  });

  it('clamps the floor on a short letterboxed picture', () => {
    // 360px picture → 18px, below the WCAG large-text threshold, so the floor applies.
    const l = subtitleLayout(input({ boxH: 360, fit: 'fill' }));
    expect(SUB_FONT_RATIO * 360).toBe(18);
    expect(l.fontPx).toBe(SUB_FONT_MIN_PX);
  });

  it('sizes from the PICTURE, not the box (the whole point of the change)', () => {
    // 640x360 video, object-fit:none, in a 1000px-tall box: picture is 360px.
    const l = subtitleLayout(input({ boxW: 1920, boxH: 1000, videoW: 640, videoH: 360, fit: 'none' }));
    expect(l.fontPx).toBe(SUB_FONT_MIN_PX); // 360*0.05 = 18 → floor 20
    // Sizing off the box would have produced 50px.
    expect(l.fontPx).not.toBe(SUB_FONT_RATIO * 1000);
  });

  it('sizes from the VISIBLE picture when object-fit:none overflows the box', () => {
    // Geometric picture is 2160px tall, but only 1000px is on screen.
    const l = subtitleLayout(input({ videoW: 3840, videoH: 2160, fit: 'none' }));
    expect(l.fontPx).toBe(SUB_FONT_RATIO * 1000); // 50px, not 108px
  });

  it('out-of-range and non-finite scales degrade safely', () => {
    const tooBig = subtitleLayout(input({ boxH: 1080, fit: 'fill', fontScale: 99 }));
    const tooSmall = subtitleLayout(input({ boxH: 1080, fit: 'fill', fontScale: 0.01 }));
    const nan = subtitleLayout(input({ boxH: 1080, fit: 'fill', fontScale: NaN }));
    expect(tooBig.fontPx).toBe(SUB_FONT_MAX_PX);
    expect(tooSmall.fontPx).toBe(SUB_FONT_RATIO * 1080 * SUB_SCALE_MIN);
    expect(nan.fontPx).toBe(SUB_FONT_RATIO * 1080); // treated as 1.0
  });
});

describe('subtitleLayout — bottom offset', () => {
  it('clears the control bar with the safety margin', () => {
    const l = subtitleLayout(input({ controlsContentH: 90 }));
    expect(l.bottomPx).toBeGreaterThanOrEqual(90 + SUB_SAFE_PX);
  });

  it('lifts above the download overlay while it is visible', () => {
    const without = subtitleLayout(input({ boxH: 300, videoW: 640, videoH: 480, dlOverlayH: 0 }));
    const withDl = subtitleLayout(input({ boxH: 300, videoW: 640, videoH: 480, dlOverlayH: 40 }));
    expect(withDl.bottomPx - without.bottomPx).toBe(40);
  });

  it('sits just above the control bar on a WIDE (2.39:1) film, not floating', () => {
    // The reported defect: a cinemascope film in a 16:9 window has ~99px of bottom
    // letterbox, and the old `letterbox + 0.05×pictureH` baseline put cues 138px up —
    // a 65px gap above the control bar that reads as "too high".
    const l = subtitleLayout(input({
      boxW: 1920, boxH: 1000, videoW: 2560, videoH: 1070,
      controlsContentH: 73,
    }));
    // Clears the bar by the safe margin only.
    expect(l.bottomPx).toBeCloseTo(73 + SUB_SAFE_PX, 6);
    expect(l.bottomPx - 73).toBeLessThanOrEqual(5);
    // Explicitly NOT the old formula.
    const pictureH = 1920 * 1070 / 2560;
    const letterboxBottom = (1000 - pictureH) / 2;
    expect(l.bottomPx).not.toBeCloseTo(letterboxBottom + 0.05 * pictureH, 1);
  });

  it('a 16:9 video in a 16:9 window is unchanged by the letterbox descent', () => {
    // No letterbox ⇒ nothing to descend into; this must stay exactly as before.
    const l = subtitleLayout(input({
      boxW: 1920, boxH: 1080, videoW: 1920, videoH: 1080, controlsContentH: 73,
    }));
    expect(l.bottomPx).toBeCloseTo(73 + SUB_SAFE_PX, 6);
  });

  it('stays near the PICTURE bottom in a tall narrow window, not stranded in the black bar', () => {
    // E7: picture is 800x450 at y=475, so 475px of letterbox sits below it.
    const l = subtitleLayout(input({ boxW: 800, boxH: 1400, controlsContentH: 90 }));
    // Cues descend a BOUNDED amount into the letterbox (desktop-player convention —
    // dialogue sits just above the control bar, not floating inside the image), but
    // the descent is capped at SUB_LETTERBOX_DESCENT_RATIO of picture height so a
    // heavily-letterboxed layout never strands text far below the picture.
    const letterboxBottom = 475;
    const descent = SUB_LETTERBOX_DESCENT_RATIO * 450; // 22.5px
    expect(l.bottomPx).toBeCloseTo(letterboxBottom - descent, 6);
    expect(l.bottomPx).toBeCloseTo(452.5, 6);
    // The invariant that matters: still within a fraction of the picture edge, and
    // nowhere near the original defect (pb-[6%] = 48px, i.e. 427px too low).
    expect(letterboxBottom - l.bottomPx).toBeLessThanOrEqual(0.05 * 450 + 0.5);
    expect(l.bottomPx).toBeGreaterThan(0.5 * letterboxBottom);
    expect(l.bottomPx).not.toBeCloseTo(0.06 * 800, 1);
  });

  it('never lands below the box for an oversized object-fit:none picture', () => {
    // E8: without the visible-rect intersection this would be -580.
    const l = subtitleLayout(input({ videoW: 3840, videoH: 2160, fit: 'none' }));
    expect(l.bottomPx).toBeGreaterThan(0);
    expect(l.bottomPx).toBeGreaterThanOrEqual(90 + SUB_SAFE_PX);
  });

  it('adds the user offset on top of the default title-safe margin', () => {
    const base = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: 0 }));
    const raised = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: 20 }));
    expect(raised.bottomPx - base.bottomPx).toBeCloseTo(0.20 * 1000, 6);
  });

  it('has NO DEAD ZONE: every slider step moves the cues, even when the bar floor dominates', () => {
    // Regression: folding the user offset INSIDE max(preferred, chromeReserve) made
    // the first ~4.2 percentage points (11% of the slider) produce zero movement,
    // because the chrome floor swallowed them. The floor must be applied first and
    // the offset added on top.
    const at = (offsetPct: number) =>
      subtitleLayout(input({ boxH: 1000, fit: 'fill', controlsContentH: 90, offsetPct })).bottomPx;
    let previous = at(0);
    for (const pct of [1, 2, 3, 4, 5, 10, 20, 40]) {
      const current = at(pct);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    // Each 1% step is worth exactly 1% of picture height.
    expect(at(1) - at(0)).toBeCloseTo(10, 6);
  });

  it('keeps the persistent user offset independent of the dynamic chrome reserve', () => {
    // mpv's sub-margin-y vs sub-margin-y-offset split: transient UI must not
    // change what the user's saved offset contributes.
    const a = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: 10, dlOverlayH: 0 }));
    const b = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: 10, dlOverlayH: 40 }));
    const a0 = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: 0, dlOverlayH: 0 }));
    const b0 = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: 0, dlOverlayH: 40 }));
    expect(a.bottomPx - a0.bottomPx).toBeCloseTo(b.bottomPx - b0.bottomPx, 6);
  });

  it('clamps the offset to the allowed range', () => {
    const over = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: 999 }));
    const capped = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: SUB_OFFSET_MAX_PCT }));
    const negative = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: -50 }));
    const zero = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: 0 }));
    expect(over.bottomPx).toBe(capped.bottomPx);
    expect(negative.bottomPx).toBe(zero.bottomPx);
  });

  it('E9: keeps cues above the bar when the upper bound inverts below the reserve', () => {
    // Brute-forced inverting input: 360x500 box, 1920x1080 video, wrapped control bar
    // (250px) + download overlay (40px), 300% scale, 3 lines.
    // upper = 234 < chrome = 292, so a plain clamp(preferred, min, max) with min > max
    // returns the SMALLER bound and slides the cues back under the bar.
    const boxW = 360, boxH = 500, controlsContentH = 250, dlOverlayH = 40;
    const p = pictureRect(boxW, boxH, 1920, 1080, 'contain');
    const fontPx = Math.min(Math.max(SUB_FONT_MIN_PX, SUB_FONT_RATIO * p.h * 3), SUB_FONT_MAX_PX);
    const blockH = 3 * fontPx * 1.2 + 2 * 4;
    const chromeReserve = controlsContentH + dlOverlayH + SUB_SAFE_PX;
    const upperBound = boxH - p.y - blockH;

    // Precondition: this input really does invert (a non-inverting example would
    // make the assertion below vacuous).
    expect(upperBound).toBeLessThan(chromeReserve);

    const l = subtitleLayout(input({
      boxW, boxH, videoW: 1920, videoH: 1080, fit: 'contain',
      controlsContentH, dlOverlayH, fontScale: 3, blockH,
    }));
    expect(l.bottomPx).toBeGreaterThanOrEqual(chromeReserve);
  });

  it('respects the top-overflow upper bound when it does not invert', () => {
    const l = subtitleLayout(input({
      boxW: 1920, boxH: 1000, fit: 'fill', offsetPct: SUB_OFFSET_MAX_PCT, blockH: 300,
    }));
    expect(l.bottomPx).toBeLessThanOrEqual(1000 - 300);
  });
});

describe('subtitleLayout — top anchor, width, panel, totality', () => {
  it('mirrors the user offset from the top edge for {\\an8} cues', () => {
    const base = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: 0 }));
    const raised = subtitleLayout(input({ boxH: 1000, fit: 'fill', offsetPct: 20 }));
    expect(base.topPx).toBeCloseTo(SUB_BOTTOM_RATIO * 1000, 6);
    expect(raised.topPx - base.topPx).toBeCloseTo(0.20 * 1000, 6);
  });

  it('offsets the top anchor by the letterbox bar so signs sit on the picture', () => {
    const l = subtitleLayout(input({ boxW: 800, boxH: 1400 }));
    expect(l.topPx).toBeCloseTo(475 + SUB_BOTTOM_RATIO * 450, 6);
  });

  it('caps line width near the picture edge, and never boxes cues into a column', () => {
    // Asserted against LITERALS, not the exported constants: comparing to
    // SUB_LINE_WIDTH_16_9 would move with any change to it, so the assertion
    // would survive a mutation of the value it exists to pin (it did).
    //
    // These are CEILINGS for long lines, not target widths — the cue box is
    // fit-content, so a short line stays short. An earlier 0.68 (a BBC editorial
    // guideline for authored broadcast subs) made every cue read as a narrow centred
    // column on arbitrary downloaded tracks.
    const wide = subtitleLayout(input({ boxW: 1920, boxH: 1080, videoW: 1920, videoH: 1080 }));
    expect(wide.maxWidthPx).toBeCloseTo(1766.4, 1); // 1920 * 0.92
    const four3 = subtitleLayout(input({ boxW: 1000, boxH: 1000, videoW: 640, videoH: 480 }));
    expect(four3.maxWidthPx).toBeCloseTo(940, 1);   // 1000 * 0.94
    // The two ratios stay distinct (16:9 lines are longer, so they wrap slightly
    // earlier), and both must leave the text room to breathe.
    expect(SUB_LINE_WIDTH_16_9).toBeLessThan(SUB_LINE_WIDTH_OTHER);
    expect(SUB_LINE_WIDTH_16_9).toBeCloseTo(0.92, 6);
    expect(SUB_LINE_WIDTH_OTHER).toBeCloseTo(0.94, 6);
    // Regression guard: a cue must never be capped to a narrow centred column.
    expect(SUB_LINE_WIDTH_16_9).toBeGreaterThan(0.85);
  });

  it('still honours a horizontal reserve when one is passed (contract kept)', () => {
    // The PLAYER now always passes 0 — the settings panel is z-50 and simply draws on
    // top of subtitles instead of squeezing them (squeezing reflowed the text
    // mid-playback). The parameter itself stays functional so a future overlay that
    // genuinely must not be covered can use it.
    const closed = subtitleLayout(input({ boxW: 1920, boxH: 1080, panelReserveRight: 0 }));
    const open = subtitleLayout(input({ boxW: 1920, boxH: 1080, panelReserveRight: 336 }));
    expect(closed.rightPx).toBe(0);
    expect(open.rightPx).toBe(336);
    expect(open.maxWidthPx).toBeCloseTo(closed.maxWidthPx - 336, 6);
  });

  it('never returns a negative max width when the panel is wider than the picture', () => {
    const l = subtitleLayout(input({ boxW: 400, boxH: 300, panelReserveRight: 9999 }));
    expect(l.maxWidthPx).toBe(0);
  });

  it('exposes the UNROTATED visible picture rect as the rotation wrapper box', () => {
    const l = subtitleLayout(input({ rotation: 90 }));
    expect(l.rotation).toBe(90);
    // Wrapper is laid out pre-rotation; the browser rotates it like the video.
    expect(l.wrapper.w).toBeCloseTo(1777.78, 2);
    expect(l.wrapper.h).toBe(1000);
  });

  it('normalizes an unexpected rotation value to 0', () => {
    const l = subtitleLayout(input({ rotation: 45 as unknown as 0 }));
    expect(l.rotation).toBe(0);
  });

  it('is TOTAL: every field stays finite for any garbage input', () => {
    const bad = [NaN, Infinity, -Infinity, -1, 0, undefined as unknown as number];
    const fits: SubFit[] = ['contain', 'fill', 'none'];
    for (const fit of fits) {
      for (const v of bad) {
        const l = subtitleLayout(input({
          boxW: v, boxH: v, videoW: v, videoH: v, fit,
          controlsContentH: v, dlOverlayH: v, panelReserveRight: v,
          fontScale: v, offsetPct: v, blockH: v,
        }));
        for (const [key, value] of Object.entries(l)) {
          if (key === 'wrapper') {
            expect(finite(value as never)).toBe(true);
          } else if (key !== 'rotation') {
            expect(Number.isFinite(value as number)).toBe(true);
          }
        }
        // A non-finite font size would be dropped by CSSOM and render nothing.
        expect(l.fontPx).toBeGreaterThanOrEqual(SUB_FONT_MIN_PX);
      }
    }
  });
});
