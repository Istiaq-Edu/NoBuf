/**
 * subtitleLayout — pure geometry for the on-video subtitle overlay.
 *
 * Why this module exists: jsdom returns 0 for getBoundingClientRect/offsetHeight/
 * videoWidth and has no ResizeObserver, so overlay geometry cannot be asserted
 * through a rendered DOM. Everything here takes injected numbers and returns
 * numbers, which makes the whole layout unit-testable.
 *
 * Coordinate space: videobox-local, origin at the videobox padding-box top-left —
 * the same space an `absolute inset-0` child resolves against.
 *
 * Two facts that drive the design:
 *  - CSS 2.1 §8.4: percentage padding (incl. padding-bottom) resolves against the
 *    containing block's WIDTH. A `pb-[6%]` "bottom gap" therefore tracks horizontal
 *    resize only. All offsets here are px.
 *  - Font size is a fraction of the letterboxed PICTURE height (Chromium's ::cue
 *    uses min(h,w) * 0.05 off the video content box), never a viewport unit.
 *
 * Chrome avoidance mirrors mpv's split of `--sub-margin-y` (persistent, user) and
 * `--sub-margin-y-offset` (dynamic, "to avoid subtitle/UI overlap"): the reserve
 * for the control bar is a separate additive term from the user's saved position,
 * so transient UI can never corrupt the persisted value.
 */

/** CSS object-fit values the player supports. `VideoFit.'original'` maps to 'none'. */
export type SubFit = 'contain' | 'fill' | 'none';

export interface Rect { x: number; y: number; w: number; h: number }

/** Base cue font size as a fraction of picture height (Chromium ::cue convention). */
export const SUB_FONT_RATIO = 0.05;
/** Hard px floor. Above WCAG 2.2 SC 1.4.3's 18.66px large-text threshold. */
export const SUB_FONT_MIN_PX = 20;
/** Hard px ceiling — beyond this, two lines of 42 chars cannot fit 90% of 1080p width. */
export const SUB_FONT_MAX_PX = 96;
/** Default bottom margin as a fraction of picture height (SMPTE title-safe 90% ⇒ 5%). */
export const SUB_BOTTOM_RATIO = 0.05;

/**
 * How far cues may descend into the bottom letterbox bar, as a fraction of picture
 * height.
 *
 * Desktop players place dialogue just above the control bar rather than inside the
 * picture, so on letterboxed content the cue sits partly in the black bar. Measured:
 * a 2.39:1 film in a 1920×1000 window has a 98px bottom bar, and the old
 * `letterbox + 0.05×pictureH` baseline put cues 138px up — a 65px gap above the
 * control bar that reads as "floating too high".
 *
 * Capped rather than unbounded: a portrait window playing 16:9 has ~330px of
 * letterbox, and descending all of it strands the text in black far below the image.
 * 0.05 lets a normal film's cues reach the bar while a heavily-letterboxed layout
 * keeps them near the picture edge.
 */
export const SUB_LETTERBOX_DESCENT_RATIO = 0.05;
export const SUB_SCALE_MIN = 0.5;
export const SUB_SCALE_MAX = 3.0;
/**
 * Position-slider travel as a % of picture height, in EACH direction.
 *
 * The slider is BIDIRECTIONAL and centred: 0 is the default resting place, positive
 * raises cues, negative lowers them toward (and into) the bottom bar. The original
 * one-directional 0→40 range meant the default sat at the far-left end and the only
 * possible adjustment was upward.
 */
export const SUB_OFFSET_MAX_PCT = 40;
/** Most negative value the slider may take (downward travel). */
export const SUB_OFFSET_MIN_PCT = -40;
/** Max absolute sync delay in seconds. */
export const SUB_DELAY_MAX_S = 10;
/** Max cue line width as a fraction of picture width — BBC online, landscape 16:9. */
export const SUB_LINE_WIDTH_16_9 = 0.68;
/** Same, for non-16:9 (4:3, 1:1, 9:16) pictures. */
export const SUB_LINE_WIDTH_OTHER = 0.90;
/** Absorbs ±1px drift from fractional getBoundingClientRect at 125%/150% DPI. */
export const SUB_SAFE_PX = 2;
/** BBC absolute ceiling on simultaneous subtitle lines. */
export const SUB_MAX_LINES = 3;

/** Aspect ratios within this tolerance of 16:9 use the narrower BBC width cap. */
const ASPECT_16_9 = 16 / 9;
const ASPECT_TOLERANCE = 0.05;

export interface SubLayoutInput {
  boxW: number;
  boxH: number;
  videoW: number | null;
  videoH: number | null;
  fit: SubFit;
  rotation: 0 | 90 | 180 | 270;
  /** Control bar's REAL interactive height (contentRect already excludes pt-16/pb-2). */
  controlsContentH: number;
  /** Height of the download progress overlay, 0 when hidden. */
  dlOverlayH: number;
  /** Horizontal reserve for the open settings panel, 0 when closed. */
  panelReserveRight: number;
  /** User size multiplier, SUB_SCALE_MIN..SUB_SCALE_MAX. */
  fontScale: number;
  /** User upward offset, 0..SUB_OFFSET_MAX_PCT (% of picture height). */
  offsetPct: number;
  /** Measured height of the rendered cue stack, for the top-overflow clamp. */
  blockH?: number;
}

export interface SubLayout {
  fontPx: number;
  /** Overlay `bottom` in px — immune to the percentage-padding width trap. */
  bottomPx: number;
  /** Mirrored inset for top-anchored cues ({\an8}, WebVTT line:0). */
  topPx: number;
  /** Overlay `right` in px, reserving space for the settings panel. */
  rightPx: number;
  maxWidthPx: number;
  /** Unrotated visible picture rect — the rotation wrapper's box. */
  wrapper: Rect;
  rotation: 0 | 90 | 180 | 270;
}

/** Coerce anything non-finite or non-positive to 0. */
function sanitizeDim(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(min: number, value: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Rendered PICTURE rect for an object-fit value, assuming object-position 50% 50%
 * (the CSS initial value, which the player never overrides).
 *
 * MAY return negative x/y and w/h larger than the box — with object-fit:none and an
 * oversized video that IS the true unclipped picture rect. Callers must intersect
 * with `visiblePictureRect` before positioning anything.
 *
 * Box dims are sanitized FIRST: the video-size guard alone does not catch a NaN box
 * (pictureRect(NaN, NaN, 1920, 1080, 'contain') would otherwise return all-NaN, and
 * a NaN px style is silently dropped by CSSOM — invisible subtitles, no error).
 */
export function pictureRect(
  boxW: number,
  boxH: number,
  videoW: number | null,
  videoH: number | null,
  fit: SubFit,
): Rect {
  const bw = sanitizeDim(boxW);
  const bh = sanitizeDim(boxH);

  // 'fill' stretches to the content box and ignores intrinsic size entirely.
  if (fit === 'fill') return { x: 0, y: 0, w: bw, h: bh };

  // Unknown/degenerate intrinsic size (pre-loadedmetadata, audio-only, 0x0 track):
  // fall back to the full box, which matches the pre-change visual behavior.
  const vw = videoW == null ? 0 : sanitizeDim(videoW);
  const vh = videoH == null ? 0 : sanitizeDim(videoH);
  if (vw <= 0 || vh <= 0) return { x: 0, y: 0, w: bw, h: bh };
  if (bw <= 0 || bh <= 0) return { x: 0, y: 0, w: 0, h: 0 };

  if (fit === 'none') {
    // Concrete size = intrinsic size, unscaled, centered by object-position 50% 50%.
    return { x: (bw - vw) / 2, y: (bh - vh) / 2, w: vw, h: vh };
  }

  // 'contain': uniform scale to fit, so the smaller of the two axis ratios wins.
  const scale = Math.min(bw / vw, bh / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

/** Intersection of a picture rect with the box — the part actually on screen. */
export function visiblePictureRect(p: Rect, boxW: number, boxH: number): Rect {
  const bw = sanitizeDim(boxW);
  const bh = sanitizeDim(boxH);
  const x1 = Math.max(0, Number.isFinite(p.x) ? p.x : 0);
  const y1 = Math.max(0, Number.isFinite(p.y) ? p.y : 0);
  const px2 = (Number.isFinite(p.x) ? p.x : 0) + (Number.isFinite(p.w) ? p.w : 0);
  const py2 = (Number.isFinite(p.y) ? p.y : 0) + (Number.isFinite(p.h) ? p.h : 0);
  const x2 = Math.min(bw, px2);
  const y2 = Math.min(bh, py2);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

/**
 * Axis-aligned rect after rotating `p` by a multiple of 90° about its own center.
 *
 * CSS Transforms 1 §3: a transform does not affect layout, so object-fit resolves
 * in the UNROTATED box and only the result is painted rotated. Under object-position
 * 50% 50% the picture center coincides with the box center, so it is rotation-
 * invariant — the box dimensions are therefore not needed here, and 90/270 simply
 * swaps w/h about that fixed center.
 */
export function rotatedPictureRect(p: Rect, rot: 0 | 90 | 180 | 270): Rect {
  const swap = rot === 90 || rot === 270;
  const w = swap ? p.h : p.w;
  const h = swap ? p.w : p.h;
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * Single entry point. Total by construction: every non-finite, zero, or negative
 * input yields a finite result, because a NaN px style is dropped silently by CSSOM
 * and would render nothing at all.
 */
export function subtitleLayout(input: SubLayoutInput): SubLayout {
  const boxW = sanitizeDim(input.boxW);
  const boxH = sanitizeDim(input.boxH);
  const rotation = input.rotation === 90 || input.rotation === 180 || input.rotation === 270
    ? input.rotation
    : 0;
  const scale = Number.isFinite(input.fontScale)
    ? clamp(SUB_SCALE_MIN, input.fontScale, SUB_SCALE_MAX)
    : 1;
  const offsetPct = Number.isFinite(input.offsetPct)
    ? clamp(SUB_OFFSET_MIN_PCT, input.offsetPct, SUB_OFFSET_MAX_PCT)
    : 0;
  const controlsContentH = sanitizeDim(input.controlsContentH);
  const dlOverlayH = sanitizeDim(input.dlOverlayH);
  const panelReserveRight = sanitizeDim(input.panelReserveRight);
  const blockH = sanitizeDim(input.blockH ?? 0);

  const geometric = pictureRect(boxW, boxH, input.videoW, input.videoH, input.fit);
  const pv = visiblePictureRect(geometric, boxW, boxH);
  // Positioning always uses the VISIBLE rect: with object-fit:none and a 4K video in
  // a small window the geometric bottom edge sits below the window, which would put
  // the cues off-screen.
  const anchor = rotation === 0
    ? pv
    : visiblePictureRect(rotatedPictureRect(geometric, rotation), boxW, boxH);

  // Size from the visible picture height so an oversized 'none' picture doesn't
  // produce huge text in a small box, and a 450px-tall letterboxed picture doesn't
  // get text sized for the 1400px box.
  const fontPx = clamp(SUB_FONT_MIN_PX, SUB_FONT_RATIO * anchor.h * scale, SUB_FONT_MAX_PX);

  // DYNAMIC term: transient chrome we must clear. Never persisted.
  const chromeReserve = controlsContentH + dlOverlayH + SUB_SAFE_PX;
  // Baseline: sit just above the control bar. For letterboxed content that means
  // descending INTO the letterbox, which is the desktop-player convention (mpv/VLC)
  // and what "close to the bar" means — a 2.39:1 film in a 16:9 window has ~98px of
  // bar, and adding a 5%-of-picture margin on top of it floated cues 65px clear of
  // the control bar.
  //
  // The descent is CAPPED, because the opposite extreme is also wrong: a portrait
  // window playing 16:9 has ~330px of letterbox, and an unbounded descent leaves the
  // cue stranded in black far below the image (the original defect #3).
  const letterboxBottom = boxH - (anchor.y + anchor.h);
  const pictureBaseline = Math.max(
    0,
    letterboxBottom - SUB_LETTERBOX_DESCENT_RATIO * anchor.h,
  );
  const floor = Math.max(pictureBaseline, chromeReserve);
  // PERSISTENT term: the user's travel, additive on top of the floor. Now signed —
  // positive raises, negative lowers. A negative offset can never push cues under the
  // control bar, because `Math.max(preferred, chromeReserve)` below re-floors it.
  const userOffset = (offsetPct / 100) * anchor.h;
  const preferred = floor + userOffset;
  // Upper bound keeps the cue stack from growing past the picture's top edge.
  const upperBound = boxH - anchor.y - blockH;
  // The inner max matters: when upperBound < chromeReserve (short window with a
  // wrapped control bar) a plain clamp would return the SMALLER bound and slide the
  // cues back under the bar.
  const bottomPx = Math.min(
    Math.max(preferred, chromeReserve),
    Math.max(upperBound, chromeReserve),
  );

  // Top-anchored cues ({\an8}) get the mirrored inset so the position slider nudges
  // both groups toward the middle instead of dragging signs into the bottom band.
  const topPx = anchor.y + SUB_BOTTOM_RATIO * anchor.h + userOffset;

  const aspect = anchor.h > 0 ? anchor.w / anchor.h : ASPECT_16_9;
  const widthRatio = Math.abs(aspect - ASPECT_16_9) <= ASPECT_TOLERANCE
    ? SUB_LINE_WIDTH_16_9
    : SUB_LINE_WIDTH_OTHER;
  const maxWidthPx = Math.max(0, anchor.w * widthRatio - panelReserveRight);

  return {
    fontPx,
    bottomPx,
    topPx,
    rightPx: panelReserveRight,
    maxWidthPx,
    wrapper: pv,
    rotation,
  };
}
