// @vitest-environment node
/**
 * Captions popover: two-column layout, and the drag guard that keeps slider drags
 * from being hijacked into a control-bar chip drag.
 *
 * Structural, because both are render-shape concerns that tsc cannot see and no
 * behavioural test elsewhere touches: a regression here shows up only as "the sliders
 * feel broken" or "the menu is one narrow column again".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const player = readFileSync(
  join(__dirname, '..', 'components/dashboard/FastStreamPlayer.tsx'),
  'utf8',
);

/** The `renderChip` body — the wrapper that carries `draggable`. */
function renderChipBody(): string {
  const start = player.indexOf('const renderChip = (id: string) => {');
  expect(start).toBeGreaterThan(-1);
  const end = player.indexOf('const insertBar =', start);
  expect(end).toBeGreaterThan(start);
  return player.slice(start, end);
}

describe('slider drags must not trigger control-bar chip drag-and-drop', () => {
  it('the chip wrapper is only draggable while its popover is CLOSED', () => {
    // ROOT CAUSE: WebView2 hands a nested drag to the OUTERMOST draggable ancestor.
    // The captions popover (with its range inputs) is rendered by chipButton INSIDE
    // the draggable chip wrapper, so dragging a slider started a CHIP drag — the
    // insertion bar appeared and the slider never received its pointer stream.
    const body = renderChipBody();
    expect(body).toContain('draggable={isDraggable}');
    expect(body).not.toMatch(/^\s+draggable$/m);
  });

  it('computes menuOpen from every chip that owns a popover', () => {
    const body = renderChipBody();
    // captions/speed/audio are the three chips with menus containing controls.
    expect(body).toContain("(id === 'captions' && subMenu)");
    expect(body).toContain("(id === 'speed' && menu)");
    expect(body).toContain("(id === 'audio' && audioMenu)");
    expect(body).toContain('const isDraggable = !menuOpen;');
  });

  it('onDragStart bails out when the chip is not draggable', () => {
    // Belt-and-braces: `draggable={false}` should prevent the event, but a webview
    // that fires it anyway must not arm the bar-layout drag state.
    const body = renderChipBody();
    expect(body).toContain('if (!isDraggable) { e.preventDefault(); return; }');
    // The bail-out must come BEFORE any drag state is set.
    const bail = body.indexOf('if (!isDraggable)');
    const arm = body.indexOf('setDragChip(id)');
    expect(bail).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(bail);
  });

  it('drops the grab cursor while the menu is open', () => {
    // A grab cursor over an open menu advertises a drag that is disabled.
    const body = renderChipBody();
    expect(body).toContain("${isDraggable ? 'cursor-grab active:cursor-grabbing' : ''}");
  });

  it('still marks drag start/end for the Escape and phantom-click guards', () => {
    // Those guards depend on markDragStart/markDragEnd; disabling the drag must not
    // remove them, or the drag-cancel Escape would close the video again.
    const body = renderChipBody();
    expect(body).toContain('markDragStart()');
    expect(body).toContain('markDragEnd()');
  });

  it('keeps the dataTransfer payload the webview requires', () => {
    const body = renderChipBody();
    expect(body).toContain("e.dataTransfer.setData('text/plain', id)");
  });
});

describe('captions popover is a two-column layout', () => {
  function popover(): string {
    const start = player.indexOf('{subMenu && (');
    expect(start).toBeGreaterThan(-1);
    const end = player.indexOf("case 'audio':", start);
    return player.slice(start, end);
  }

  it('is a flex row wide enough for two columns', () => {
    const p = popover();
    expect(p).toContain('flex items-stretch');
    expect(p).toMatch(/w-\[520px\]/);
    // Must not overflow a small window.
    expect(p).toContain('max-w-[92vw]');
  });

  it('the track column flexes and scrolls independently', () => {
    // A file with many embedded tracks must not push the sliders out of reach.
    const p = popover();
    expect(p).toContain('flex-1 min-w-0 overflow-y-auto');
  });

  it('the slider column has a fixed width, its own border and its own scroll', () => {
    const p = popover();
    expect(p).toContain('w-[248px] shrink-0 border-l border-white/10 overflow-y-auto');
  });

  it('no longer forces a single narrow column', () => {
    const p = popover();
    expect(p).not.toContain('min-w-[180px]');
    // `overflow-hidden` on the root would clip both columns' scrollbars.
    const root = p.slice(0, p.indexOf('>'));
    expect(root).not.toContain('overflow-hidden');
  });

  it('the track column closes before the slider column opens', () => {
    // Ordering proof: tracks (left) precede the D13-gated slider column (right).
    const p = popover();
    const loadRow = p.indexOf('Load subtitle file…');
    const gate = p.indexOf('{(subs.tracks.length > 0 || msePlayer.embeddedSubTracks.length > 0) && (');
    const sliderCol = p.indexOf('w-[248px] shrink-0');
    expect(loadRow).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(loadRow);
    expect(sliderCol).toBeGreaterThan(gate);
  });
});
