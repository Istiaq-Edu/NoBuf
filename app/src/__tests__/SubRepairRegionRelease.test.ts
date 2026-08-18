// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldReleaseSubRepairRegion } from '../components/dashboard/FastStreamPlayer';

// Regression guard for 13-c/13-t: after a seek, an ASS island extraction that
// covers the playhead returns `ok` and latches the 120s region as done. The
// playhead then outruns the island's few seconds of cues WITHIN that region and
// the one-shot ledger blocks every re-extraction until the next seek — subtitles
// freeze then vanish (measured: nearestCueDelta grew +0.00 → −21.87s over 22s of
// playback with zero repair attempts). `shouldReleaseSubRepairRegion` frees the
// ledger after a successful-but-partial extraction so forward playback can
// re-extract when coverage is exhausted.
//
// Round-14(B2) added the third arg `coverageAdvanced`: release ONLY when the
// extraction actually extended coverage. This is the 15-c storm guard — an `ok`
// that did not grow the frontier must keep the region latched, or the lead-time
// trigger re-arms every tick (~4 `ok 956B→956B`/s, unstoppable by the breaker
// because `ok` is its reset condition).
describe('shouldReleaseSubRepairRegion', () => {
  it('releases after a partial ok that ADVANCED coverage (the 13-c fix)', () => {
    expect(shouldReleaseSubRepairRegion('ok', true, true)).toBe(true);
  });

  it('KEEPS the region latched when a partial ok did NOT advance coverage (15-c storm guard)', () => {
    // Same island re-extracted, content unchanged → releasing would re-arm the
    // lead-time trigger into a tight loop. Must stay latched.
    expect(shouldReleaseSubRepairRegion('ok', true, false)).toBe(false);
  });

  it('keeps the region latched when a fully-covered track reports ok', () => {
    // Not partial ⇒ the whole file's cues are present; nothing left to extract.
    expect(shouldReleaseSubRepairRegion('ok', false, true)).toBe(false);
    expect(shouldReleaseSubRepairRegion('ok', false, false)).toBe(false);
  });

  it.each(['progress', 'progress-uncovered', 'deferred', 'no-progress', 'failed'] as const)(
    '%s does not release via this path (breaker backoff / scheduled retry owns it)',
    (outcome) => {
      // Only `ok` is handled here; every other outcome is governed by the
      // breaker (failures/no-progress) or the scheduled retry (progress/
      // deferred). Releasing them here would double-drive the ledger.
      expect(shouldReleaseSubRepairRegion(outcome, true, true)).toBe(false);
      expect(shouldReleaseSubRepairRegion(outcome, true, false)).toBe(false);
      expect(shouldReleaseSubRepairRegion(outcome, false, true)).toBe(false);
    },
  );

  // Structural guard: the release must actually be wired into the repair outcome
  // handler, keyed on `entry.partial` AND the computed `coverageAdvanced`. The
  // pure test above cannot catch deletion of the call site, nor a caller that
  // drops the progress arg and reintroduces the storm.
  it('FastStreamPlayer releases the ledger only on ok+partial+advanced in the repair handler', () => {
    const src = readFileSync(
      path.resolve(process.cwd(), 'src/components/dashboard/FastStreamPlayer.tsx'),
      'utf-8',
    );
    const callStart = src.indexOf('const repairSubCoverage = useCallback');
    expect(callStart).toBeGreaterThan(-1);
    const body = src.slice(callStart);
    expect(body).toContain('shouldReleaseSubRepairRegion(outcome, entry.partial, coverageAdvanced)');
    expect(body).toContain('subRepairAttemptedRef.current.delete(regionKey)');
    // The progress signal must be computed, not hardcoded true.
    expect(body).toContain('const coverageAdvanced =');
  });
});
