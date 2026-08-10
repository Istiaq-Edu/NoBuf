/**
 * Round-17: a 204 "not cached here yet" was scored as a hard failure.
 *
 * From the production session (17-t.md):
 *
 *   12:02:51  [SUBS-ISLAND] no usable island and prefix ends at 33554432B
 *                           while playhead is 572016605B — declining
 *   12:02:58  [SUBS-ISLAND] island 547814419-580386815 (31.1 MiB) served
 *                           for playhead 573250145
 *
 * The island served at :217 CONTAINS the playhead declined at :213. The data was
 * SEVEN SECONDS away. But the decline scored `failed`, which put the next attempt
 * 150s out (SUB_REPAIR_BACKOFF_BASE_MS), then 300s, and after three of them the
 * breaker opened and automatic repair stopped for the whole file.
 *
 * The fix: when the cache frontier GREW between attempts, bytes are still landing,
 * so the verdict is `deferred` — retry in ~5s, spend no failure or attempt budget.
 * When it did NOT grow, nothing is arriving and `failed` is still correct.
 */
import { describe, it, expect } from 'vitest';
import {
  classifySubRepairOutcome,
  reduceSubRepairBreaker,
  shouldAttemptSubRepair,
  emptySubRepairBreakerState,
  computeSubRepairBackoffMs,
  SUB_REPAIR_MAX_DEFERS,
  SUB_REPAIR_DEFER_RETRY_MS,
  SUB_REPAIR_FAILURE_THRESHOLD,
  SUB_REPAIR_MAX_ATTEMPTS,
  type SubRepairBreakerState,
} from '../hooks/useMSEPlayer';

// Real bytes from 17-t.md:213 and :217.
const FRONTIER_AT_DECLINE = 33_554_432;   // prefix end when it declined
const FRONTIER_LATER      = 41_943_040;   // +8 MiB, download still running

describe('round-17: 204 decline classification', () => {
  it('scores a decline as DEFERRED when the frontier grew (the logged case)', () => {
    expect(classifySubRepairOutcome(
      null, null, 3238, /* hadError */ true, false,
      undefined, null, null,
      FRONTIER_AT_DECLINE, FRONTIER_LATER,
    )).toBe('deferred');
  });

  it('still scores FAILED when the frontier did NOT move', () => {
    expect(classifySubRepairOutcome(
      null, null, 3238, true, false,
      undefined, null, null,
      FRONTIER_AT_DECLINE, FRONTIER_AT_DECLINE,
    )).toBe('failed');
  });

  it('treats the first partial frontier as DEFERRED when bytes exist', () => {
    expect(classifySubRepairOutcome(
      null, null, 6367, true, false,
      undefined, null, null,
      null, FRONTIER_LATER,
    )).toBe('deferred');
  });

  it('still scores FAILED when the frontier went backwards', () => {
    expect(classifySubRepairOutcome(
      null, null, 3238, true, false,
      undefined, null, null,
      FRONTIER_LATER, FRONTIER_AT_DECLINE,
    )).toBe('failed');
  });

  it('still scores FAILED when no frontier is known (header absent)', () => {
    expect(classifySubRepairOutcome(
      null, null, 3238, true, false,
      undefined, null, null,
      null, null,
    )).toBe('failed');
    // A current frontier without a baseline is evidence that this is a partial,
    // still-materializing input; only a missing current frontier is unknowable.
    expect(classifySubRepairOutcome(
      null, null, 3238, true, false, undefined, null, null, null, FRONTIER_LATER,
    )).toBe('deferred');
    expect(classifySubRepairOutcome(
      null, null, 3238, true, false, undefined, null, null, FRONTIER_AT_DECLINE, null,
    )).toBe('failed');
  });

  it('keeps normal dialogue gaps inside the coverage grace at ok', () => {
    expect(classifySubRepairOutcome(
      2248, 7085, 7075, false, false,
      undefined, null, null, null, null,
      [{ startTime: 7082.78, endTime: 7084.87 }], 24,
    )).toBe('ok');
  });

  it('does not disturb the non-error paths', () => {
    // A successful ASS extraction is still `progress`, frontier notwithstanding.
    expect(classifySubRepairOutcome(
      null, null, 3238, false, false,
      undefined, 100, 956,
      FRONTIER_AT_DECLINE, FRONTIER_LATER,
    )).toBe('progress');
  });
});

describe('round-17: deferred spends no failure or attempt budget', () => {
  it('leaves failures and attempts untouched, and cannot open the breaker', () => {
    let st = emptySubRepairBreakerState();
    st = { ...st, lastFrontierBytes: FRONTIER_AT_DECLINE };

    // Three declines in a row: under the old scoring this opened the breaker
    // (SUB_REPAIR_FAILURE_THRESHOLD = 3) and ended repair for the file.
    let frontier = FRONTIER_LATER;
    for (let i = 0; i < SUB_REPAIR_FAILURE_THRESHOLD; i++) {
      st = reduceSubRepairBreaker(st, 'deferred', 1_000 * i, frontier);
      frontier += 8 * 1024 * 1024; // download keeps advancing
    }

    expect(st.open).toBe(false);
    expect(st.consecutiveFailures).toBe(0);
    expect(st.attempts).toBe(0);
    expect(st.consecutiveDefers).toBe(SUB_REPAIR_FAILURE_THRESHOLD);
  });

  it('is BOUNDED: past the defer cap it falls through to the failure ladder', () => {
    let st = { ...emptySubRepairBreakerState(), lastFrontierBytes: 0 };
    let frontier = 8 * 1024 * 1024;

    // A download that advances forever without reaching the playhead must not
    // defer forever.
    for (let i = 0; i < SUB_REPAIR_MAX_DEFERS + SUB_REPAIR_FAILURE_THRESHOLD; i++) {
      st = reduceSubRepairBreaker(st, 'deferred', 1_000 * i, frontier);
      frontier += 8 * 1024 * 1024;
    }

    expect(st.consecutiveDefers).toBeLessThanOrEqual(SUB_REPAIR_MAX_DEFERS);
    expect(st.attempts).toBeGreaterThan(0);
  });

  it('clears the defer counter once a real outcome arrives', () => {
    let st = { ...emptySubRepairBreakerState(), lastFrontierBytes: 0 };
    st = reduceSubRepairBreaker(st, 'deferred', 0, 8 * 1024 * 1024);
    expect(st.consecutiveDefers).toBe(1);

    st = reduceSubRepairBreaker(st, 'progress', 1_000, 16 * 1024 * 1024);
    expect(st.consecutiveDefers).toBe(0);
    expect(st.attempts).toBe(1); // progress DOES spend the attempt budget
  });

  it('resets everything on ok', () => {
    let st = { ...emptySubRepairBreakerState(), lastFrontierBytes: 0 };
    st = reduceSubRepairBreaker(st, 'deferred', 0, 8 * 1024 * 1024);
    st = reduceSubRepairBreaker(st, 'ok', 1_000, 16 * 1024 * 1024);
    expect(st.consecutiveDefers).toBe(0);
    expect(st.consecutiveFailures).toBe(0);
    expect(st.attempts).toBe(0);
    expect(st.open).toBe(false);
  });
});

describe('round-17: deferred retries in seconds, not minutes', () => {
  it('waits ~5s after a defer instead of the 150s failure base', () => {
    const deferred: SubRepairBreakerState = {
      ...emptySubRepairBreakerState(),
      consecutiveDefers: 1,
      lastAttemptStartedAtMs: 0,
    };

    // Not yet — just under the defer retry window.
    expect(shouldAttemptSubRepair(deferred, SUB_REPAIR_DEFER_RETRY_MS - 1, false)).toBe(false);
    // ...and allowed once it elapses.
    expect(shouldAttemptSubRepair(deferred, SUB_REPAIR_DEFER_RETRY_MS, false)).toBe(true);

    // The logged recovery was 7s. Under the OLD scoring that attempt was still
    // 143s away; under the new one it is allowed.
    const SEVEN_SECONDS = 7_000;
    expect(shouldAttemptSubRepair(deferred, SEVEN_SECONDS, false)).toBe(true);

    const failed: SubRepairBreakerState = {
      ...emptySubRepairBreakerState(),
      consecutiveFailures: 1,
      lastAttemptStartedAtMs: 0,
    };
    expect(shouldAttemptSubRepair(failed, SEVEN_SECONDS, false)).toBe(false);
    expect(computeSubRepairBackoffMs(1)).toBe(150_000);
  });

  it('keeps honouring the open breaker and the attempt ceiling', () => {
    const open: SubRepairBreakerState = {
      ...emptySubRepairBreakerState(), consecutiveDefers: 1, open: true,
    };
    expect(shouldAttemptSubRepair(open, 1_000_000, false)).toBe(false);
    // ...but a manual toggle still forces a retry.
    expect(shouldAttemptSubRepair(open, 1_000_000, true)).toBe(true);

    const spent: SubRepairBreakerState = {
      ...emptySubRepairBreakerState(),
      consecutiveDefers: 1,
      attempts: SUB_REPAIR_MAX_ATTEMPTS,
    };
    expect(shouldAttemptSubRepair(spent, 1_000_000, false)).toBe(false);
  });
});

describe('round-17: persisted pre-round-17 state still works', () => {
  it('treats a missing consecutiveDefers as zero', () => {
    // Breaker state is persisted, so states written before this round come back
    // without the field.
    const legacy = {
      consecutiveFailures: 1, attempts: 2, lastAttemptStartedAtMs: 0,
      open: false, lastFrontierBytes: FRONTIER_AT_DECLINE,
    } as SubRepairBreakerState;

    // No defers recorded → the failure ladder applies, not the 5s defer window.
    expect(shouldAttemptSubRepair(legacy, 10_000, false)).toBe(false);

    const next = reduceSubRepairBreaker(legacy, 'deferred', 1_000, FRONTIER_LATER);
    expect(next.consecutiveDefers).toBe(1);
    // Frontier growth also cleared the stale failure.
    expect(next.consecutiveFailures).toBe(0);
  });
});
