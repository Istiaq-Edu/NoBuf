// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifySubRepairOutcome, emptySubRepairBreakerState, reduceSubRepairBreaker, resetSubRepairBreakerForSeek, scheduleEmbeddedSubInventory, SUB_REPAIR_MAX_DEFERS } from '../hooks/useMSEPlayer';

describe('round 37 uncovered subtitle progress', () => {
  it('does not spend the attempt budget when new cues still miss the playhead', () => {
    const outcome = classifySubRepairOutcome(
      1980, 6900, 6696, false, false,
      undefined, null, null, null, null,
      [{ startTime: 6890, endTime: 6895 }], 0,
    );
    expect(outcome).toBe('progress-uncovered');
    const next = reduceSubRepairBreaker(emptySubRepairBreakerState(), outcome, 1000, null);
    expect(next.attempts).toBe(0);
    expect(next.consecutiveDefers).toBe(1);
  });

  it('preserves the defer ceiling across region-ledger resets', () => {
    let state = emptySubRepairBreakerState();
    for (let i = 0; i < SUB_REPAIR_MAX_DEFERS; i++) {
      state = reduceSubRepairBreaker(state, 'progress-uncovered', i * 5_000, null);
      state = resetSubRepairBreakerForSeek(state);
    }
    expect(state.consecutiveDefers).toBe(0);
    expect(state.attempts).toBeGreaterThan(0);
    expect(state.deferExhausted).toBe(true);
  });
});

describe('round 37 proactive and cached-prefix lifecycle wiring', () => {
  const frontend = readFileSync(`${process.cwd()}/src/hooks/useMSEPlayer.ts`, 'utf8');
  const backend = readFileSync(`${process.cwd()}/src-tauri/src/commands/streaming.rs`, 'utf8');
  const server = readFileSync(`${process.cwd()}/src-tauri/src/server.rs`, 'utf8');

  it('reports post-seek proactive only after the refill chain starts', () => {
    const start = frontend.indexOf('if (keyframeTimestamp !== null)');
    const success = frontend.slice(start, frontend.indexOf('// Seek failed — discard buffered segments', start));
    expect(success.indexOf('startStreamingChain();')).toBeLessThan(success.indexOf('reportMkvProactivePosition(clampedTime'));
  });

  it('defers worker admission while foreground playback is downloading', () => {
    expect(backend).toContain('if is_player_downloading {');
    expect(backend).toContain('foreground playback downloading — deferring proactive spawn');
  });

  it('never applies bootstrap skip-poll to cached-prefix readers', () => {
    expect(server).toContain('pub(crate) fn should_skip_cache_poll(cached_prefix: bool, cache_missing_or_cold: bool)');
    expect(server).toContain('!cached_prefix && cache_missing_or_cold');
    expect(server).toContain('format!("{}&cached_prefix=true", source)');
  });
});

describe('embedded subtitle inventory scheduling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for player initialization, then loads and retries', () => {
    let initialized = false;
    const load = vi.fn();
    const stop = scheduleEmbeddedSubInventory(load, () => initialized);

    vi.advanceTimersByTime(1_500);
    expect(load).not.toHaveBeenCalled();

    initialized = true;
    vi.advanceTimersByTime(250);
    expect(load).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(5_000);
    expect(load).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(20_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('uses the bounded fallback when initialization never completes', () => {
    const load = vi.fn();
    const stop = scheduleEmbeddedSubInventory(load, () => false);

    vi.advanceTimersByTime(19_999);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledOnce();
    stop();
  });

  it('cancels pending initialization and fallback timers', () => {
    const load = vi.fn();
    const stop = scheduleEmbeddedSubInventory(load, () => false);
    stop();
    vi.advanceTimersByTime(30_000);
    expect(load).not.toHaveBeenCalled();
  });
});
