// @vitest-environment jsdom
/**
 * Does Escape in the OpenSubtitles panel close the PANEL, or kill the whole video?
 *
 * This is not a hypothetical. The player's global handler maps Escape to
 * `handleClose()` → `setPlayingFile(null)` → the player unmounts, and a whole
 * session was previously lost to a synthetic Escape doing exactly that
 * (see nobuf-player-ui, "drag-cancel Escape"). The panel adds a SECOND document
 * listener, so the interaction between them decides whether the user loses their
 * video when they dismiss a dialog.
 *
 * Modelled on the real wiring, verified by reading both call sites:
 *   panel  → document.addEventListener('keydown', h, true)   // CAPTURE + stopPropagation
 *   player → document.addEventListener('keydown', h)          // BUBBLE, guards INPUT/TEXTAREA
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The behavioural tests below MODEL the two listeners. That model is only worth
 * anything if it matches what ships, so pin the three lines it depends on: flipping
 * either phase, or dropping the input guard, silently breaks the real interaction
 * while leaving the behavioural tests green.
 */
describe('the shipped wiring these tests model', () => {
  const src = (rel: string) =>
    readFileSync(join(__dirname, '..', rel), 'utf8');

  it('the panel registers Escape in CAPTURE phase and stops propagation', () => {
    const panel = src('components/dashboard/OpenSubtitlesPanel.tsx');
    const effect = panel.slice(
      panel.indexOf('const onKey = (e: KeyboardEvent)'),
      panel.indexOf('}, [onClose]);'),
    );
    expect(effect).toContain('e.stopPropagation()');
    expect(effect).toMatch(/addEventListener\('keydown',\s*onKey,\s*true\)/);
  });

  it('the player keyboard handler stays in BUBBLE phase and skips text inputs', () => {
    const player = src('components/dashboard/FastStreamPlayer.tsx');
    // Scope to the keyboard effect: `// Keyboard` → its cleanup.
    const start = player.indexOf('  // Keyboard');
    const effect = player.slice(start, player.indexOf('removeEventListener', start));
    expect(effect).toContain(
      "if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;",
    );
    // Bubble phase: registered WITHOUT a capture argument. If this ever becomes
    // `, true`, the player would see Escape before the panel could swallow it.
    expect(effect).toMatch(/addEventListener\('keydown',\s*h\)\s*;/);
    expect(effect).not.toMatch(/addEventListener\('keydown',\s*h,\s*true\)/);
  });
});

describe('Escape ordering: panel dismiss must not close the player', () => {
  let playerClosed = false;
  let panelClosed = false;
  let panelHandler: (e: KeyboardEvent) => void;
  let playerHandler: (e: KeyboardEvent) => void;

  beforeEach(() => {
    playerClosed = false;
    panelClosed = false;

    // The panel: capture phase, stops propagation (OpenSubtitlesPanel.tsx:97-105).
    panelHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        panelClosed = true;
      }
    };
    // The player: bubble phase, ignores events from text inputs
    // (FastStreamPlayer.tsx:2609-2628).
    playerHandler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if (e.key.toLowerCase() === 'escape') {
        e.preventDefault();
        playerClosed = true;
      }
    };
    document.addEventListener('keydown', panelHandler, true);
    document.addEventListener('keydown', playerHandler);
  });

  afterEach(() => {
    document.removeEventListener('keydown', panelHandler, true);
    document.removeEventListener('keydown', playerHandler);
    document.body.innerHTML = '';
  });

  function pressEscape(target: EventTarget = document.body) {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
  }

  it('CAPTURE runs before BUBBLE, so the panel sees Escape first', () => {
    pressEscape();
    expect(panelClosed).toBe(true);
  });

  it('THE REAL RISK: Escape must NOT reach the player and close the video', () => {
    // stopPropagation() in a document-level CAPTURE listener prevents the event
    // from ever reaching the bubble phase on the same node. If this assertion ever
    // fails, dismissing the search dialog also closes the user's video.
    pressEscape();
    expect(panelClosed).toBe(true);
    expect(playerClosed).toBe(false);
  });

  it('Escape from the API-key input is also contained', () => {
    // The panel holds a password input; Escape while focused there must dismiss the
    // dialog, not the player. (The player independently ignores INPUT targets.)
    const input = document.createElement('input');
    input.type = 'password';
    document.body.appendChild(input);
    pressEscape(input);
    expect(panelClosed).toBe(true);
    expect(playerClosed).toBe(false);
  });

  it('with the panel CLOSED, Escape reaches the player as usual', () => {
    // The guard must not be permanent: removing the panel listener restores the
    // normal close-the-video behaviour.
    document.removeEventListener('keydown', panelHandler, true);
    pressEscape();
    expect(panelClosed).toBe(false);
    expect(playerClosed).toBe(true);
  });

  it('a non-Escape key is not swallowed by the panel', () => {
    let playerSawSpace = false;
    const spaceHandler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT') return;
      if (e.key === ' ') playerSawSpace = true;
    };
    document.addEventListener('keydown', spaceHandler);
    document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key: ' ', bubbles: true, cancelable: true,
    }));
    document.removeEventListener('keydown', spaceHandler);
    expect(playerSawSpace).toBe(true);
    expect(panelClosed).toBe(false);
  });
});

describe('typing in the panel must not trigger player shortcuts', () => {
  /**
   * The player binds bare letters/space: ' '/k = play-pause, m = mute, f =
   * fullscreen, j/l = seek. The search box and the API-key field are text inputs, so
   * typing a title like "breaking bad" would otherwise pause playback, mute, and
   * toggle fullscreen mid-word.
   */
  const PLAYER_KEYS = [' ', 'k', 'm', 'f', 'j', 'l', ',', '.', '<', '>'];

  it('every player shortcut key is ignored when it originates in an INPUT', () => {
    const fired: string[] = [];
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // The shipped guard, copied verbatim from FastStreamPlayer.tsx:2611.
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      fired.push(e.key);
    };
    document.addEventListener('keydown', handler);

    const input = document.createElement('input');
    document.body.appendChild(input);
    for (const key of PLAYER_KEYS) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }
    document.removeEventListener('keydown', handler);
    document.body.innerHTML = '';

    expect(fired).toEqual([]);
  });

  it('the same keys DO reach the player from outside an input', () => {
    const fired: string[] = [];
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      fired.push(e.key);
    };
    document.addEventListener('keydown', handler);
    for (const key of PLAYER_KEYS) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }
    document.removeEventListener('keydown', handler);
    expect(fired).toEqual(PLAYER_KEYS);
  });
});
