/**
 * Round-14 F4 — subtitle failure REPORTING provenance.
 *
 * The bug (forensics C6, user-reported): opening a video fired
 * "No cues in the downloaded portion yet — try again as more downloads"
 * before the user touched anything.
 *
 * Chain, read from source:
 *   1. FastStreamPlayer.tsx auto-restore effect re-applies the persisted
 *      subtitle choice as soon as the track list materializes.
 *   2. It called `toggleEmbeddedSub(...)` — the SAME function the onClick
 *      handler calls — with no way to tell the two apart.
 *   3. The `empty-partial` branch toasted, so an automatic restore narrated its
 *      own failure as if the user had asked for it.
 *
 * The extraction itself was CORRECT. At open the extractor gets the contiguous
 * 0-prefix; on the round-14 capture (14-t:99-101) that was 3,670,016 B of a
 * 1,566,651,347 B / 8888.136 s film:
 *
 *     3670016 / (1566651347 / 8888.136) = 20.8 seconds
 *
 * Inception's first 20.8 s is the beach/waves opening with no dialogue, so zero
 * cues is right. Reporting it was the defect.
 */
import { describe, it, expect } from 'vitest';
import { shouldReportSubFailure } from '../hooks/useMSEPlayer';

describe('shouldReportSubFailure (round-14 F4)', () => {
  it('F4.2: a MANUAL click always reports — never silently drop a human request', () => {
    // Round-10b fixed a silently-dropped click (the in-flight guard returned
    // with no feedback). Over-suppressing here would reintroduce that defect.
    expect(shouldReportSubFailure('user')).toBe(true);
  });

  it('stays silent for an AUTOMATIC session restore', () => {
    // This is the round-14 bug: the user did not ask, nothing is stalled, and
    // "try again" is un-actionable because island mode needs a playhead that
    // does not exist at open.
    expect(shouldReportSubFailure('auto')).toBe(false);
  });

  it('the two origins must never agree — that equality WAS the bug', () => {
    // Before F4 there was a single code path, so both provenances produced the
    // same (reporting) behaviour. If this ever collapses back to equality, the
    // toast returns on every open of a partially-cached file.
    expect(shouldReportSubFailure('user')).not.toBe(shouldReportSubFailure('auto'));
  });

  it('F4.4: auto fails silently, then the same track reports on a manual retry', () => {
    // Sequence from the edge-case matrix: session restore fails quietly (the row
    // shows a passive marker), then the user clicks that row. The click MUST be
    // treated as a first-class request — the breaker is also reset on manual
    // click, so the extraction genuinely re-runs rather than replaying a memo.
    const auto = shouldReportSubFailure('auto');
    const thenManual = shouldReportSubFailure('user');
    expect(auto).toBe(false);
    expect(thenManual).toBe(true);
  });

  it('is pure — repeated calls cannot drift', () => {
    // Guards against anyone turning this into stateful "only warn once" logic,
    // which would make a real user click silent after the first failure.
    for (let i = 0; i < 5; i++) {
      expect(shouldReportSubFailure('user')).toBe(true);
      expect(shouldReportSubFailure('auto')).toBe(false);
    }
  });
});
