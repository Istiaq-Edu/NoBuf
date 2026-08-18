// @vitest-environment jsdom
/**
 * Binds the computed layout to what actually reaches the DOM.
 *
 * SubtitleLayout.test.ts proves the arithmetic; this file proves the numbers are
 * WIRED — that bottomPx/fontPx land on real inline styles and that delaySec changes
 * which cue is on screen. Without this, every layout mutation could be reverted in
 * the overlay and the pure tests would stay green.
 *
 * jsdom cannot measure anything (getBoundingClientRect → 0, no ResizeObserver), but
 * it CAN read back inline styles we set ourselves, which is exactly the seam here.
 */
import { createRef } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubtitleOverlay } from '../components/dashboard/SubtitleOverlay';
import { SubtitleTrack } from '../lib/faststream/subtitles/SubtitleTrack';
import { subtitleLayout, type SubLayout } from '../lib/faststream/subtitles/subtitleLayout';

vi.mock('jassub', () => ({
  default: class {
    ready = Promise.resolve();
    destroy = vi.fn(async () => undefined);
    _canvas = document.createElement('canvas');
    _worker = { terminate: vi.fn() };
    constructor(_o: unknown) { /* not exercised: these tests use the DOM path */ }
  },
}));

afterEach(cleanup);

/** A VTT track with two consecutive cues, so a delay flips which one is active. */
function vttTrack(): SubtitleTrack {
  const track = new SubtitleTrack('test', 'en');
  track.loadText([
    'WEBVTT',
    '',
    '1',
    '00:00:10.000 --> 00:00:12.000',
    'FIRST',
    '',
    '2',
    '00:00:12.000 --> 00:00:14.000',
    'SECOND',
  ].join('\n'));
  return track;
}

function layoutFor(over: Partial<Parameters<typeof subtitleLayout>[0]> = {}): SubLayout {
  return subtitleLayout({
    boxW: 1920, boxH: 1000, videoW: 1920, videoH: 1080,
    fit: 'contain', rotation: 0, controlsContentH: 90, dlOverlayH: 0,
    panelReserveRight: 0, fontScale: 1, offsetPct: 0, blockH: 0,
    ...over,
  });
}

/** The rendered cue element (the DOM node that carries the inline styles). */
function cueEl(container: HTMLElement): HTMLElement {
  // Select structurally, not by style: the no-layout fallback path deliberately
  // leaves fontSize as a clamp() string, and a [style*="font-size"] selector would
  // then match nothing and mask the very fallback being asserted.
  const stack = container.querySelector('.flex-col.justify-end');
  const el = stack?.firstElementChild;
  if (!el) throw new Error('no cue element rendered');
  return el as HTMLElement;
}

function renderOverlay(props: {
  layout?: SubLayout;
  delaySec?: number;
  currentTime?: number;
  track?: SubtitleTrack;
}) {
  const track = props.track ?? vttTrack();
  return render(
    <SubtitleOverlay
      vidRef={createRef<HTMLVideoElement>()}
      activeTracks={[track]}
      currentTime={props.currentTime ?? 11}
      layout={props.layout}
      delaySec={props.delaySec}
    />,
  );
}

describe('layout → DOM wiring', () => {
  it('puts the computed bottom on the cue stack as PX, not a percentage', () => {
    // The pb-[6%] defect: a percentage bottom resolves against WIDTH, so it must
    // never appear in the output.
    const layout = layoutFor();
    const { container } = renderOverlay({ layout });
    const stack = container.querySelector('.flex-col.justify-end') as HTMLElement;
    expect(stack.style.bottom).toBe(`${layout.bottomPx}px`);
    expect(stack.style.bottom).not.toContain('%');
    expect(layout.bottomPx).toBeGreaterThan(0);
  });

  it('puts the computed font size on the cue as PX, never a vw clamp', () => {
    const layout = layoutFor();
    const { container } = renderOverlay({ layout });
    expect(cueEl(container).style.fontSize).toBe(`${layout.fontPx}px`);
    expect(cueEl(container).style.fontSize).not.toContain('vw');
    expect(cueEl(container).style.fontSize).not.toContain('clamp');
  });

  it('grows the rendered font when the size slider is raised', () => {
    // Deliberately a SHORT picture (400px) so 2x stays under the 96px ceiling —
    // on a 1000px picture both scales clamp to 96 and the assertion is vacuous.
    const small = renderOverlay({ layout: layoutFor({ boxH: 400, videoH: 400, fontScale: 1 }) });
    const smallPx = parseFloat(cueEl(small.container).style.fontSize);
    cleanup();
    const big = renderOverlay({ layout: layoutFor({ boxH: 400, videoH: 400, fontScale: 2 }) });
    const bigPx = parseFloat(cueEl(big.container).style.fontSize);
    expect(smallPx).toBe(20);   // 400 * 0.05 = 20
    expect(bigPx).toBe(40);     // and 2x is still below the 96px cap
    expect(bigPx).toBeCloseTo(smallPx * 2, 6);
  });

  it('raises the rendered bottom when the position slider is raised', () => {
    const base = renderOverlay({ layout: layoutFor({ offsetPct: 0 }) });
    const baseBottom = parseFloat((base.container.querySelector('.flex-col.justify-end') as HTMLElement).style.bottom);
    cleanup();
    const raised = renderOverlay({ layout: layoutFor({ offsetPct: 20 }) });
    const raisedBottom = parseFloat((raised.container.querySelector('.flex-col.justify-end') as HTMLElement).style.bottom);
    expect(raisedBottom).toBeGreaterThan(baseBottom);
  });

  it('lifts the cue when the control bar grows', () => {
    const short = renderOverlay({ layout: layoutFor({ controlsContentH: 90, boxH: 300, videoH: 300 }) });
    const shortBottom = parseFloat((short.container.querySelector('.flex-col.justify-end') as HTMLElement).style.bottom);
    cleanup();
    const tall = renderOverlay({ layout: layoutFor({ controlsContentH: 250, boxH: 300, videoH: 300 }) });
    const tallBottom = parseFloat((tall.container.querySelector('.flex-col.justify-end') as HTMLElement).style.bottom);
    expect(tallBottom).toBeGreaterThan(shortBottom);
  });

  it('reserves horizontal room for the open settings panel', () => {
    const { container } = renderOverlay({ layout: layoutFor({ panelReserveRight: 336 }) });
    const stack = container.querySelector('.flex-col.justify-end') as HTMLElement;
    expect(stack.style.right).toBe('336px');
  });

  it('caps the cue width in px so long lines cannot run under the panel', () => {
    const layout = layoutFor({ panelReserveRight: 336 });
    const { container } = renderOverlay({ layout });
    expect(cueEl(container).style.maxWidth).toBe(`${layout.maxWidthPx}px`);
  });

  it('clips the overlay root so a rotated wrapper cannot bleed over the controls', () => {
    // Assert BOTH branches: the rotated branch has its own root element, and a
    // mutation removing overflow-hidden from only one of them must still fail.
    const plain = renderOverlay({ layout: layoutFor() });
    expect((plain.container.firstElementChild as HTMLElement).className).toContain('overflow-hidden');
    cleanup();
    const rotated = renderOverlay({ layout: layoutFor({ rotation: 90 }) });
    const root = rotated.container.firstElementChild as HTMLElement;
    expect(root.className).toContain('overflow-hidden');
    // And the rotated wrapper really is inside that clipping root.
    expect(root.querySelector('[style*="rotate"]')).toBeTruthy();
  });

  it('rotates the wrapper at 90 degrees and sizes it from the picture rect', () => {
    const layout = layoutFor({ rotation: 90 });
    const { container } = renderOverlay({ layout });
    const rotated = container.querySelector('[style*="rotate"]') as HTMLElement;
    expect(rotated).toBeTruthy();
    expect(rotated.style.transform).toBe('rotate(90deg)');
    expect(rotated.style.width).toBe(`${layout.wrapper.w}px`);
    expect(rotated.style.height).toBe(`${layout.wrapper.h}px`);
  });

  it('falls back to the pre-change styling when no layout is supplied', () => {
    // Legacy callers/tests must render exactly as before.
    //
    // The clamp() font-size itself is NOT assertable here: jsdom's CSSOM discards
    // unsupported values outright (probed — `style.fontSize` reads '' and the style
    // attribute comes back null), so neither the parsed property nor the raw
    // attribute can see it. What IS observable, and what the fallback actually
    // guarantees, is that NO px geometry is emitted and the Tailwind width class is
    // still applied.
    const { container } = renderOverlay({});
    const el = cueEl(container);
    const stack = container.querySelector('.flex-col.justify-end') as HTMLElement;
    expect(el.className).toContain('max-w-[90%]');   // Tailwind cap, not a px cap
    expect(el.style.maxWidth).toBe('');              // no computed px width
    expect(stack.style.bottom).toBe('');             // no computed px bottom
    expect(stack.className).toContain('inset-x-0');
    // And with a layout supplied, all three flip to the computed form.
    cleanup();
    const withLayout = renderOverlay({ layout: layoutFor() });
    const el2 = cueEl(withLayout.container);
    const stack2 = withLayout.container.querySelector('.flex-col.justify-end') as HTMLElement;
    expect(el2.className).not.toContain('max-w-[90%]');
    expect(el2.style.maxWidth).toMatch(/px$/);
    expect(stack2.style.bottom).toMatch(/px$/);
  });

  it('never emits a NaN px style from a corrupt layout', () => {
    // In real Chromium `${NaN}px` → "NaNpx", which CSSOM DROPS silently: invisible
    // subtitles, no error. jsdom drops it too, which means the absence of the string
    // in innerHTML is NOT evidence the guard works — the guard is asserted directly
    // in the sibling test below. Here we only check the user-visible outcome: the
    // cue still renders.
    const corrupt = {
      fontPx: NaN, bottomPx: NaN, topPx: NaN, rightPx: NaN, maxWidthPx: NaN,
      wrapper: { x: NaN, y: NaN, w: NaN, h: NaN }, rotation: 0,
    } as unknown as SubLayout;
    const { container } = renderOverlay({ layout: corrupt });
    expect(container.innerHTML).not.toContain('NaN');
    expect(container.textContent).toContain('FIRST');
  });

  it('coerces every non-finite layout field to a finite px value', () => {
    // Binds the guard itself, not its DOM shadow.
    //
    // The discriminator: WITH the guard, NaN collapses to 0 and the element receives
    // a real `bottom: 0px`. WITHOUT it, `${NaN}px` produces "NaNpx", which CSSOM
    // rejects outright, so the property comes back EMPTY. So "not containing NaN" is
    // worthless as an assertion (empty also lacks 'NaN') — the presence of a parsable
    // 0px is what actually proves the coercion ran.
    const corrupt = {
      fontPx: NaN, bottomPx: NaN, topPx: -Infinity, rightPx: NaN, maxWidthPx: NaN,
      wrapper: { x: NaN, y: NaN, w: NaN, h: NaN }, rotation: 0,
    } as unknown as SubLayout;
    const { container } = renderOverlay({ layout: corrupt });
    const stack = container.querySelector('.flex-col.justify-end') as HTMLElement;

    expect(stack.style.bottom).not.toBe('');                        // not rejected by CSSOM
    expect(Number.isFinite(parseFloat(stack.style.bottom))).toBe(true);
    expect(stack.style.bottom).toBe('0px');
    // Infinity must be coerced too, not passed through as a huge/invalid length.
    expect(stack.style.right).toBe('0px');
  });
});

describe('sync delay → which cue renders', () => {
  it('shows the un-delayed cue for the current time', () => {
    const { container } = renderOverlay({ currentTime: 11, delaySec: 0 });
    expect(container.textContent).toContain('FIRST');
  });

  it('a POSITIVE delay makes subtitles appear later (holds the earlier cue)', () => {
    // At t=12.5 the un-delayed cue is SECOND; a +1s delay looks up t=11.5 → FIRST.
    const plain = renderOverlay({ currentTime: 12.5, delaySec: 0 });
    expect(plain.container.textContent).toContain('SECOND');
    cleanup();
    const delayed = renderOverlay({ currentTime: 12.5, delaySec: 1 });
    expect(delayed.container.textContent).toContain('FIRST');
    expect(delayed.container.textContent).not.toContain('SECOND');
  });

  it('a NEGATIVE delay makes subtitles appear earlier', () => {
    // At t=11.5 the un-delayed cue is FIRST; a -1s delay looks up t=12.5 → SECOND.
    const delayed = renderOverlay({ currentTime: 11.5, delaySec: -1 });
    expect(delayed.container.textContent).toContain('SECOND');
  });

  it('does NOT mutate the track cue times (non-destructive offset)', () => {
    // shift() would corrupt the track, and a later coverage-repair merge could
    // silently half-revert it. The offset must live only in the read.
    const track = vttTrack();
    const before = track.cues.map((c) => [c.startTime, c.endTime]);
    renderOverlay({ track, currentTime: 12.5, delaySec: 2.5 });
    expect(track.cues.map((c) => [c.startTime, c.endTime])).toEqual(before);
  });

  it('treats a non-finite delay as no delay instead of blanking the subtitles', () => {
    // activeCues(cues, NaN) returns [] — every comparison against NaN is false —
    // so an unguarded NaN would silently show nothing at all.
    for (const bad of [NaN, Infinity, -Infinity, undefined]) {
      const { container } = renderOverlay({ currentTime: 11, delaySec: bad as number });
      expect(container.textContent).toContain('FIRST');
      cleanup();
    }
  });
});
