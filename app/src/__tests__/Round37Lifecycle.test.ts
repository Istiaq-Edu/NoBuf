import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifySubRepairOutcome, emptySubRepairBreakerState, reduceSubRepairBreaker, resetSubRepairBreakerForSeek } from '../hooks/useMSEPlayer';

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
    for (let i = 0; i < 12; i++) {
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
    expect(server).toContain('should_skip_cache_poll(cached_prefix_stream, cache_missing_or_cold)');
    expect(server).toContain('format!("{}&cached_prefix=true", source)');
    expect(frontend).toContain('window.setInterval(() => { void loadEmbeddedSubTracks(); }, 5_000)');
    expect(frontend).toContain('window.clearInterval(retry)');
  });
});
