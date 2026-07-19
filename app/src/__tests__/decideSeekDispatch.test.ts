import { describe, it, expect, vi } from 'vitest';
import { decideSeekDispatch, isSeekSuperseded, computeSeekLandingTime } from '../hooks/useMSEPlayer';

// Mock Tauri invoke so useMSEPlayer imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * decideSeekDispatch decides whether an unbuffered transmuxer seek runs now
 * ('execute') or is held for the debounce/drain timer ('defer').
 *
 * Root cause it fixes (trace 21, cross-validated): the old logic fired a seek
 * immediately whenever the debounce window had elapsed — EVEN while a previous
 * transmuxer seek was still in flight. A rapid burst of spaced seeks then
 * spawned two concurrent source_id=playback reads on the shared MKV Input; one
 * was orphaned and empty-retried ~32s. The decisive rule: while a seek is in
 * flight, ALWAYS defer.
 *
 * Signature: (now, lastSeekTime, debounceMs, seekInProgress, firstSeekEver)
 */
describe('decideSeekDispatch', () => {
  const DEBOUNCE = 500;

  // ── Idle (no seek in flight) ──────────────────────────────────────────────
  it('first seek ever (idle) → execute', () => {
    // firstSeekEver=true regardless of timing
    expect(decideSeekDispatch(1000, 0, DEBOUNCE, false, true)).toBe('execute');
  });

  it('idle + debounce window elapsed → execute', () => {
    // now - lastSeekTime = 600 >= 500
    expect(decideSeekDispatch(1600, 1000, DEBOUNCE, false, false)).toBe('execute');
  });

  it('idle + within debounce window → defer (rapid drag coalescing)', () => {
    // now - lastSeekTime = 200 < 500
    expect(decideSeekDispatch(1200, 1000, DEBOUNCE, false, false)).toBe('defer');
  });

  it('idle + exactly at the debounce boundary → execute', () => {
    expect(decideSeekDispatch(1500, 1000, DEBOUNCE, false, false)).toBe('execute');
  });

  // ── In flight (THE regression) ────────────────────────────────────────────
  it('seek in flight + spaced beyond debounce → defer (the trace-21 fix)', () => {
    // Old logic returned execute here (600 >= 500) and spawned a 2nd concurrent
    // seek. The fix: in-flight always defers.
    expect(decideSeekDispatch(1600, 1000, DEBOUNCE, true, false)).toBe('defer');
  });

  it('seek in flight + within debounce → defer', () => {
    expect(decideSeekDispatch(1200, 1000, DEBOUNCE, true, false)).toBe('defer');
  });

  it('seek in flight overrides firstSeekEver → defer', () => {
    // Even the "first seek" must wait if somehow a seek is already running.
    expect(decideSeekDispatch(1000, 0, DEBOUNCE, true, true)).toBe('defer');
  });

  it('flag clears → the same spaced target now executes', () => {
    // Same inputs as the regression case but seekInProgress=false (in-flight
    // seek completed) → the deferred drain now fires.
    expect(decideSeekDispatch(1600, 1000, DEBOUNCE, false, false)).toBe('execute');
  });

  // ── Drain sequence: simulate the self-rescheduling timer ──────────────────
  it('deferred drain fires the LATEST target once idle (last-target-wins)', () => {
    // Model the wiring: a burst arrives while a seek is in flight. Each event
    // defers and updates the captured target. The drain re-checks until idle.
    let seekInProgress = true;
    let lastSeekTime = 1000;
    const debounce = DEBOUNCE;

    // Three burst events (targets 100, 200, 300) all while in-flight → all defer.
    const targets = [100, 200, 300];
    let captured = -1;
    for (const t of targets) {
      const d = decideSeekDispatch(1100, lastSeekTime, debounce, seekInProgress, false);
      expect(d).toBe('defer');
      captured = t; // last-target-wins: latest event overwrites
    }
    expect(captured).toBe(300);

    // Drain ticks while still in-flight → keep deferring.
    expect(decideSeekDispatch(1300, lastSeekTime, debounce, seekInProgress, false)).toBe('defer');
    expect(decideSeekDispatch(1500, lastSeekTime, debounce, seekInProgress, false)).toBe('defer');

    // In-flight seek completes; window has since elapsed → execute the LATEST.
    seekInProgress = false;
    const finalNow = lastSeekTime + debounce + 100; // 1600
    expect(decideSeekDispatch(finalNow, lastSeekTime, debounce, seekInProgress, false)).toBe('execute');
    // The executed target would be `captured` (300), not the intermediate 100/200.
    expect(captured).toBe(300);
  });

  // ── Guard inputs ──────────────────────────────────────────────────────────
  it('idle + zero elapsed + not first → defer', () => {
    expect(decideSeekDispatch(1000, 1000, DEBOUNCE, false, false)).toBe('defer');
  });
});

/**
 * isSeekSuperseded guards the async completion of a transmuxer seek. A seek
 * captures its generation at start; a cold far seek can take 5-8s to resolve.
 * If a newer user seek bumped the live generation in the meantime, committing
 * the stale seek's result (video.currentTime, startStreamingChain, refill) would
 * plant playback on a PREVIOUS position — the trace-22 "backward seek goes to
 * previous point". The guard bails the stale commit.
 *
 * Signature: (capturedGen, liveGen) → true when stale (must NOT commit).
 */
describe('isSeekSuperseded', () => {
  it('same generation → not superseded (commit proceeds)', () => {
    expect(isSeekSuperseded(5, 5)).toBe(false);
  });

  it('a newer seek bumped the live generation → superseded (bail)', () => {
    // captured gen 5 at start, live gen is now 6 (a newer seek arrived)
    expect(isSeekSuperseded(5, 6)).toBe(true);
  });

  it('several newer seeks arrived during a slow cold resolve → superseded', () => {
    expect(isSeekSuperseded(5, 9)).toBe(true);
  });

  it('first-ever seek (gen 1) with no supersession → commits', () => {
    expect(isSeekSuperseded(1, 1)).toBe(false);
  });

  it('is generation-order agnostic — any mismatch is stale', () => {
    // Defensive: even the (impossible) captured>live case is treated as stale
    // rather than silently committing, since it still means "not the live seek".
    expect(isSeekSuperseded(7, 6)).toBe(true);
  });
});

/**
 * computeSeekLandingTime places video.currentTime after a transmuxer seek.
 * A seek snaps to the cue keyframe at/below the requested target (3-9s earlier
 * for sparse VBR keyframes); the old code set currentTime to the keyframe,
 * causing the trace-24 undershoot ("seek to 875s starts at 872s"). The fix
 * lands on the requested target when it's inside the buffered span
 * [keyframe, bufferedEnd], clamping to bufferedEnd to avoid unbuffered holes.
 *
 * Signature: (target, keyframe, bufferedEnd) → landing time.
 */
describe('computeSeekLandingTime', () => {
  it('lands on the requested target when inside the buffered span (the fix)', () => {
    // trace-24: seek 875, keyframe 871.9, buffered to ~880 → land on 875, not 871.9
    expect(computeSeekLandingTime(875, 871.9, 880)).toBe(875);
  });

  it('backward-seek undershoot cases land exactly on target', () => {
    expect(computeSeekLandingTime(1865.5, 1859.9, 1873)).toBe(1865.5);
    expect(computeSeekLandingTime(1587.1, 1583.2, 1595)).toBe(1587.1);
  });

  it('clamps to bufferedEnd when target exceeds the buffered range', () => {
    // Short window / short tail — never seek into an unbuffered hole.
    expect(computeSeekLandingTime(882, 871.9, 880)).toBe(880);
  });

  it('falls back to keyframe when target is (defensively) below it', () => {
    expect(computeSeekLandingTime(870, 871.9, 880)).toBe(871.9);
  });

  it('target exactly at keyframe → keyframe (no undershoot to fix)', () => {
    expect(computeSeekLandingTime(871.9, 871.9, 880)).toBe(871.9);
  });

  it('target exactly at bufferedEnd → lands there (boundary)', () => {
    expect(computeSeekLandingTime(880, 871.9, 880)).toBe(880);
  });
});
