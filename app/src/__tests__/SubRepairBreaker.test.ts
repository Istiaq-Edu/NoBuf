/**
 * Round-10b — subtitle repair circuit breaker, backoff, and outcome classification.
 *
 * These encode the 444-iteration runaway from 12-t.md. Round-10 shipped
 * auto-repair with an in-flight guard and a 120s-region ledger; that combination
 * prevents CONCURRENCY but not REPETITION. When a 120s extraction finishes,
 * playback has already advanced the playhead into a fresh unattempted region,
 * which re-arms repair immediately — a sustained ~1 extraction per 120s forever.
 * Over an 8888s film the ledger alone permits 74 extractions at ~10 MiB each.
 *
 * Every test in the "would have caught the runaway" block FAILS against
 * round-10's code, because none of these functions existed.
 */
import { describe, it, expect } from 'vitest';
import {
  classifySubRepairOutcome,
  reduceSubRepairBreaker,
  computeSubRepairBackoffMs,
  shouldAttemptSubRepair,
  emptySubRepairBreakerState,
  SUB_REPAIR_MAX_ATTEMPTS,
  SUB_REPAIR_FAILURE_THRESHOLD,
  SUB_REPAIR_BACKOFF_BASE_MS,
  SUB_REPAIR_BACKOFF_CAP_MS,
  type SubRepairBreakerState,
} from '../hooks/useMSEPlayer';

const fresh = (): SubRepairBreakerState => emptySubRepairBreakerState();

describe('classifySubRepairOutcome', () => {
  it('an extraction that reaches the playhead is ok', () => {
    // Cues now end at 5000s, playhead 4500s → covered.
    expect(classifySubRepairOutcome(196, 5000, 4500, false, false)).toBe('ok');
  });

  it('MORE cues but still short of the playhead is PROGRESS, not failure', () => {
    // The distinction that keeps a converging repair alive: coverage grew
    // 196s → 2000s while the viewer sits at 4500s. Still short, but working.
    expect(classifySubRepairOutcome(196, 2000, 4500, false, false)).toBe('progress');
  });

  it('same coverage as before is no-progress', () => {
    expect(classifySubRepairOutcome(196, 196, 4500, false, false)).toBe('no-progress');
  });

  it('LESS coverage than before is no-progress', () => {
    expect(classifySubRepairOutcome(2000, 196, 4500, false, false)).toBe('no-progress');
  });

  it('a thrown/errored attempt is failed', () => {
    expect(classifySubRepairOutcome(196, null, 4500, true, false)).toBe('failed');
  });

  it('first cues where there were none is progress', () => {
    expect(classifySubRepairOutcome(null, 300, 4500, false, false)).toBe('progress');
  });

  it('a fully-covered track is ok however far ahead the playhead sits', () => {
    // Dialogue legitimately ends long before the credits do.
    expect(classifySubRepairOutcome(196, 196, 8000, false, true)).toBe('ok');
  });

  it('an ABORTED read that still grew coverage counts as progress', () => {
    // Verified in a real repro: a read that died with WSAECONNABORTED
    // (Error number -10053) still produced 8 correct cues. A truncated read
    // that advanced coverage must never be scored as a failure.
    expect(classifySubRepairOutcome(600, 670, 4500, false, false)).toBe('progress');
  });
});

describe('computeSubRepairBackoffMs', () => {
  it('is zero when nothing has failed', () => {
    expect(computeSubRepairBackoffMs(0)).toBe(0);
  });

  it('doubles per consecutive failure from the base', () => {
    expect(computeSubRepairBackoffMs(1)).toBe(SUB_REPAIR_BACKOFF_BASE_MS);
    expect(computeSubRepairBackoffMs(2)).toBe(SUB_REPAIR_BACKOFF_BASE_MS * 2);
    expect(computeSubRepairBackoffMs(3)).toBe(SUB_REPAIR_BACKOFF_BASE_MS * 4);
  });

  it('clamps at the cap and never exceeds it', () => {
    expect(computeSubRepairBackoffMs(99)).toBe(SUB_REPAIR_BACKOFF_CAP_MS);
    for (let f = 1; f < 40; f++) {
      expect(computeSubRepairBackoffMs(f)).toBeLessThanOrEqual(SUB_REPAIR_BACKOFF_CAP_MS);
    }
  });

  it('RESONANCE: the base exceeds the backend 120s extraction timeout', () => {
    // The 120s backend timeout (server.rs) and the 120s region width were in
    // near-resonance, which is what sustained a 100% duty cycle. The backoff
    // base must sit above the timeout or a worst-case hang re-arms instantly.
    const BACKEND_EXTRACTION_TIMEOUT_MS = 120_000;
    expect(SUB_REPAIR_BACKOFF_BASE_MS).toBeGreaterThan(BACKEND_EXTRACTION_TIMEOUT_MS);
  });
});

describe('reduceSubRepairBreaker', () => {
  it('opens after the failure threshold of consecutive non-progress attempts', () => {
    let st = fresh();
    for (let i = 0; i < SUB_REPAIR_FAILURE_THRESHOLD; i++) {
      expect(st.open).toBe(false);
      st = reduceSubRepairBreaker(st, 'no-progress', 1000 * (i + 1), null);
    }
    expect(st.open).toBe(true);
    expect(st.consecutiveFailures).toBe(SUB_REPAIR_FAILURE_THRESHOLD);
  });

  it('progress resets the failure counter but still spends the attempt budget', () => {
    let st = fresh();
    st = reduceSubRepairBreaker(st, 'no-progress', 1000, null);
    st = reduceSubRepairBreaker(st, 'no-progress', 2000, null);
    expect(st.consecutiveFailures).toBe(2);
    st = reduceSubRepairBreaker(st, 'progress', 3000, null);
    expect(st.consecutiveFailures).toBe(0);   // converging — do not trip
    expect(st.attempts).toBe(3);              // but the budget is still consumed
    expect(st.open).toBe(false);
  });

  it('ok fully resets the breaker', () => {
    let st = fresh();
    st = reduceSubRepairBreaker(st, 'no-progress', 1000, null);
    st = reduceSubRepairBreaker(st, 'no-progress', 2000, null);
    st = reduceSubRepairBreaker(st, 'no-progress', 3000, null);
    expect(st.open).toBe(true);
    st = reduceSubRepairBreaker(st, 'ok', 4000, null);
    expect(st).toMatchObject({ consecutiveFailures: 0, attempts: 0, open: false });
  });

  it('frontier growth clears STALE failure history before scoring this attempt', () => {
    // Ordering is load-bearing: the reset clears pre-growth history first, then
    // the current attempt is scored on its own merits. Scoring first and
    // resetting after would discard real evidence — a failure made WITH the new
    // frontier — and a frontier that grows every time could zero it forever.
    let st = fresh();
    st = reduceSubRepairBreaker(st, 'no-progress', 1000, 1_000_000);
    st = reduceSubRepairBreaker(st, 'no-progress', 2000, 1_000_000);
    expect(st.consecutiveFailures).toBe(2);
    // More of the file arrived, and this attempt STILL failed: history clears,
    // then this failure is counted → exactly 1.
    st = reduceSubRepairBreaker(st, 'no-progress', 3000, 5_000_000);
    expect(st.consecutiveFailures).toBe(1);
    expect(st.open).toBe(false);
  });

  it('never mutates the input state', () => {
    const st = fresh();
    const snapshot = { ...st };
    reduceSubRepairBreaker(st, 'failed', 1000, null);
    expect(st).toEqual(snapshot);
  });
});

describe('shouldAttemptSubRepair', () => {
  it('allows a first attempt on fresh state', () => {
    expect(shouldAttemptSubRepair(fresh(), 10_000, false)).toBe(true);
  });

  it('refuses while the breaker is open', () => {
    const st: SubRepairBreakerState = { ...fresh(), open: true };
    expect(shouldAttemptSubRepair(st, 10_000_000, false)).toBe(false);
  });

  it('CEILING: refuses past the hard attempt ceiling even without tripping', () => {
    // The region ledger bounds distinct REGIONS (74 over an 8888s film); only
    // this ceiling bounds TOTAL attempts. Progress outcomes never trip the
    // breaker, so without the ceiling a slowly-converging file could run
    // indefinitely.
    const st: SubRepairBreakerState = {
      ...fresh(), attempts: SUB_REPAIR_MAX_ATTEMPTS, consecutiveFailures: 0,
    };
    expect(shouldAttemptSubRepair(st, 10_000_000, false)).toBe(false);
  });

  it('honours the backoff window measured from attempt START', () => {
    const st: SubRepairBreakerState = {
      ...fresh(), consecutiveFailures: 1, lastAttemptStartedAtMs: 1_000_000,
    };
    const wait = computeSubRepairBackoffMs(1);
    expect(shouldAttemptSubRepair(st, 1_000_000 + wait - 1, false)).toBe(false);
    expect(shouldAttemptSubRepair(st, 1_000_000 + wait, false)).toBe(true);
  });

  it('a MANUAL request always bypasses the breaker and the ceiling', () => {
    // A human clicking the track is an explicit request, not a runaway.
    const st: SubRepairBreakerState = {
      ...fresh(), open: true, attempts: SUB_REPAIR_MAX_ATTEMPTS * 10,
      consecutiveFailures: 99, lastAttemptStartedAtMs: 1_000_000,
    };
    expect(shouldAttemptSubRepair(st, 1_000_001, true)).toBe(true);
  });
});

describe('REGRESSION: the 12-t.md runaway is now bounded', () => {
  it('a permanently-unrepairable track stops instead of retrying forever', () => {
    // Simulate the observed pathology: every attempt returns the same coverage
    // while the playhead keeps advancing into fresh 120s regions, which is what
    // re-armed repair indefinitely under round-10.
    let st = fresh();
    let started = 0;
    // Explicit clock: the gate check and the state update must see the SAME
    // instant, and each step must exceed the backoff base or the gate correctly
    // refuses (that refusal is the feature, not the scenario under test).
    let clock = 1_000_000;

    while (shouldAttemptSubRepair(st, clock, false) && started < 100) {
      started++;
      const outcome = classifySubRepairOutcome(196, 196, 4500, false, false);
      expect(outcome).toBe('no-progress');
      st = reduceSubRepairBreaker(st, outcome, clock, null);
      clock += 400_000; // well past the growing backoff, so only the breaker stops us
    }

    expect(started).toBe(SUB_REPAIR_FAILURE_THRESHOLD);
    expect(st.open).toBe(true);
    // Round-10 would have kept going for all 74 regions; this stops at 3.
    expect(started).toBeLessThan(74);
  });

  it('a CONVERGING track keeps working, bounded by the ceiling', () => {
    // Progress must not trip the breaker — a repair that is slowly catching up
    // deserves to continue. The ceiling is what bounds it.
    let st = fresh();
    let coverage = 196;
    let started = 0;
    while (shouldAttemptSubRepair(st, 1_000_000 + started * 200_000, false) && started < 100) {
      started++;
      const before = coverage;
      coverage += 800; // each attempt genuinely advances coverage
      const outcome = classifySubRepairOutcome(before, coverage, 9000, false, false);
      expect(outcome).toBe('progress');
      st = reduceSubRepairBreaker(st, outcome, 1_000_000 + started * 200_000, null);
    }
    expect(st.open).toBe(false);                       // never tripped
    expect(started).toBe(SUB_REPAIR_MAX_ATTEMPTS);     // stopped by the ceiling
  });

  it('bounds total extraction cost far below the observed 4.34 GiB', () => {
    // 12-t: 444 island serves at ~10 MiB each produced ZERO subtitles.
    // Worst case now: SUB_REPAIR_MAX_ATTEMPTS extractions.
    const MIB_PER_EXTRACTION = 10;
    const worstCaseMiB = SUB_REPAIR_MAX_ATTEMPTS * MIB_PER_EXTRACTION;
    const observedMiB = 4.34 * 1024;
    expect(worstCaseMiB).toBeLessThan(observedMiB / 10);
  });
});
