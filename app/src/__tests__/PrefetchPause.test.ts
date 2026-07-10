import { describe, it, expect, vi } from 'vitest';
import { decideTsSeekAction, TsSeekAction } from '../hooks/useMSEPlayer';

// Mock Tauri invoke so useMSEPlayer imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * decideTsSeekAction is the single source of truth for the TS pause/seek policy.
 * It mirrors the branches in seekTo():
 *   - buffered      → target is in the in-memory SourceBuffer (no network)
 *   - cache         → target's forward window is on local disk (no network)
 *   - network       → target is unbuffered AND prefetch is running (fetch Telegram)
 *   - blocked-paused → target is unbuffered AND prefetch is paused (honor pause)
 *
 * Core requirement (user): while paused, playback continues from memory/disk
 * buffers, seeks to buffered/cached positions are allowed, but a seek to an
 * unbuffered position must NOT fetch from Telegram — it stays paused.
 */
describe('decideTsSeekAction', () => {
  // ── Not paused: normal playback ──────────────────────────────────────────
  it('buffered target → memory playback, even when running', () => {
    expect(decideTsSeekAction(false, true, false)).toBe<TsSeekAction>('buffered');
  });

  it('cached target → disk playback when running', () => {
    expect(decideTsSeekAction(false, false, true)).toBe<TsSeekAction>('cache');
  });

  it('unbuffered target while running → fetch from Telegram', () => {
    expect(decideTsSeekAction(false, false, false)).toBe<TsSeekAction>('network');
  });

  // ── Paused: "paused means paused" ────────────────────────────────────────
  it('buffered target while PAUSED → still plays from memory (no network)', () => {
    // The in-memory SourceBuffer is already downloaded; seeking into it never
    // touches Telegram, so it is allowed even while paused.
    expect(decideTsSeekAction(true, true, false)).toBe<TsSeekAction>('buffered');
  });

  it('cached target while PAUSED → still plays from disk (no network)', () => {
    // Disk cache is local; serving it never touches Telegram.
    expect(decideTsSeekAction(true, false, true)).toBe<TsSeekAction>('cache');
  });

  it('unbuffered target while PAUSED → blocked, no Telegram fetch', () => {
    // THE KEY REQUIREMENT: an unbuffered seek while paused must not fetch.
    expect(decideTsSeekAction(true, false, false)).toBe<TsSeekAction>('blocked-paused');
  });

  // ── Precedence: buffered beats cache beats pause ─────────────────────────
  it('buffered takes precedence over cache', () => {
    // If a region is both in memory and on disk, prefer the memory read.
    expect(decideTsSeekAction(false, true, true)).toBe<TsSeekAction>('buffered');
    expect(decideTsSeekAction(true, true, true)).toBe<TsSeekAction>('buffered');
  });

  it('cache takes precedence over pause-block', () => {
    // A cached target is served from disk regardless of pause state — the
    // pause only blocks NETWORK seeks.
    expect(decideTsSeekAction(true, false, true)).toBe<TsSeekAction>('cache');
  });

  it('pause only changes the unbuffered branch (network ↔ blocked-paused)', () => {
    // Buffered and cache decisions are identical whether paused or not; only
    // the unbuffered case flips. This proves pause never blocks memory/disk.
    expect(decideTsSeekAction(false, true, false)).toBe(decideTsSeekAction(true, true, false));
    expect(decideTsSeekAction(false, false, true)).toBe(decideTsSeekAction(true, false, true));
    expect(decideTsSeekAction(false, false, false)).not.toBe(decideTsSeekAction(true, false, false));
  });

  // ── Exhaustive truth table (all 8 combinations) ──────────────────────────
  it('covers the full truth table', () => {
    const table: Array<[boolean, boolean, boolean, TsSeekAction]> = [
      // paused, buffered, cache  → expected
      [false, false, false, 'network'],
      [false, false, true,  'cache'],
      [false, true,  false, 'buffered'],
      [false, true,  true,  'buffered'],
      [true,  false, false, 'blocked-paused'],
      [true,  false, true,  'cache'],
      [true,  true,  false, 'buffered'],
      [true,  true,  true,  'buffered'],
    ];
    for (const [paused, buffered, cache, expected] of table) {
      expect(decideTsSeekAction(paused, buffered, cache)).toBe(expected);
    }
  });

  // ── Invariant: 'network' is the ONLY action that touches Telegram ────────
  it('never returns network while paused (pause fully gates Telegram)', () => {
    for (const buffered of [false, true]) {
      for (const cache of [false, true]) {
        expect(decideTsSeekAction(true, buffered, cache)).not.toBe('network');
      }
    }
  });
});
