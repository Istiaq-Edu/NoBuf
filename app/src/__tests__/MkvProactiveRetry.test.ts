import { describe, expect, it } from 'vitest';
import { shouldRetryMkvProactiveReport } from '../hooks/useMSEPlayer';

describe('shouldRetryMkvProactiveReport', () => {
  it('retries a rejected report while the seek generation is current', () => {
    expect(shouldRetryMkvProactiveReport(false, 0, 12, 4, 4, false)).toBe(true);
  });

  it('does not retry an accepted report', () => {
    expect(shouldRetryMkvProactiveReport(true, 0, 12, 4, 4, false)).toBe(false);
  });

  it('does not let a stale seek resurrect proactive work', () => {
    expect(shouldRetryMkvProactiveReport(false, 0, 12, 4, 5, false)).toBe(false);
  });

  it('does not restart proactive while paused', () => {
    expect(shouldRetryMkvProactiveReport(false, 0, 12, 4, 4, true)).toBe(false);
  });

  it('stops at the retry ceiling', () => {
    expect(shouldRetryMkvProactiveReport(false, 3, 4, 4, 4, false)).toBe(false);
  });
});
