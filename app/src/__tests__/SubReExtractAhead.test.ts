// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldReExtractSubAhead, shouldBypassRegionLedger, SUB_REEXTRACT_LEAD_S } from '../components/dashboard/FastStreamPlayer';

// Round-14 B2: the lead-time re-extraction trigger. Fires when the playhead is
// within SUB_REEXTRACT_LEAD_S of the coverage frontier so the next island is
// fetched BEFORE the visible cues run out. Every case here is one the 15-c storm
// regression got wrong.
describe('shouldReExtractSubAhead', () => {
  const LEAD = SUB_REEXTRACT_LEAD_S; // 20

  it('does NOT fire during the quiet intro before any cue exists (15-c storm cause)', () => {
    // 15-c fired ~30× in the first 8s because "no cue nearby" was treated as a
    // hole. With no coverage yet, lastCueEnd is null → never fire.
    expect(shouldReExtractSubAhead(0.5, null, false)).toBe(false);
    expect(shouldReExtractSubAhead(8, null, false)).toBe(false);
  });

  it('does NOT fire when the playhead is comfortably inside coverage', () => {
    // Frontier at 200s, playhead 150s → 50s of runway (> 20s lead) → no fire.
    expect(shouldReExtractSubAhead(150, 200, false)).toBe(false);
    expect(shouldReExtractSubAhead(179.9, 200, false)).toBe(false); // just outside the lead
  });

  it('fires when the playhead approaches the coverage frontier (within the lead)', () => {
    // Frontier 200s, playhead 185s → 15s runway (< 20s lead) → fetch ahead now.
    expect(shouldReExtractSubAhead(185, 200, false)).toBe(true);
    expect(shouldReExtractSubAhead(180.1, 200, false)).toBe(true); // just inside the lead
  });

  it('fires when coverage is already exhausted (playhead past the frontier)', () => {
    expect(shouldReExtractSubAhead(210, 200, false)).toBe(true);
  });

  it('does NOT fire for a fully-covered track (nothing left to extract)', () => {
    expect(shouldReExtractSubAhead(185, 200, true)).toBe(false);
    expect(shouldReExtractSubAhead(210, 200, true)).toBe(false);
  });

  it('guards non-finite / negative playhead', () => {
    expect(shouldReExtractSubAhead(NaN, 200, false)).toBe(false);
    expect(shouldReExtractSubAhead(-5, 200, false)).toBe(false);
  });

  it('respects a custom lead', () => {
    // 5s lead: frontier 200, playhead 190 → 10s runway > 5s → no fire.
    expect(shouldReExtractSubAhead(190, 200, false, 5)).toBe(false);
    // playhead 196 → 4s runway < 5s → fire.
    expect(shouldReExtractSubAhead(196, 200, false, 5)).toBe(true);
  });

  it('default lead is 20s (well under a ~100s island, well above a normal inter-cue gap)', () => {
    expect(SUB_REEXTRACT_LEAD_S).toBe(20);
  });

  // Structural guard: the predicate must be ORed into the repair-loop trigger,
  // not just defined. A pure test cannot catch deletion of the call site.
  it('FastStreamPlayer ORs shouldReExtractSubAhead into the re-extract trigger', () => {
    const src = readFileSync(
      path.resolve(process.cwd(), 'src/components/dashboard/FastStreamPlayer.tsx'),
      'utf-8',
    );
    const effectStart = src.indexOf('maybeRepairSubCoverageRef.current = (playheadS: number) =>');
    const effectEnd = src.indexOf('const repairSubCoverage = useCallback', effectStart);
    expect(effectStart).toBeGreaterThan(-1);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const body = src.slice(effectStart, effectEnd);
    expect(body).toContain('shouldReExtractSubAhead(playheadS, coverageFrontier, !entry.partial)');
    // Must be OR'd WITH the wide adequacy gate, not replace it.
    expect(body).toContain('shouldReExtractSub(');
  });
});

// Round-21 (17-c/17-t): the region-ledger BYPASS. An island covers only a few
// seconds, but the region ledger latches the whole 120s region; without this
// bypass the playhead walks off the island's end and subtitles blank for up to
// ~112s (17-t: seek 982s → island to ~990s → playhead 1024s, zero re-extracts).
describe('shouldBypassRegionLedger', () => {
  it('does NOT bypass when the playhead is well BEFORE the frontier (comfortably covered)', () => {
    // Round-22: bypass fires on the lead edge (playhead > frontier - 20). At
    // frontier 990s, playhead 965s is 25s before it (> 20s runway) — no bypass.
    expect(shouldBypassRegionLedger(965, 990, false, null)).toBe(false);
  });

  it('bypasses on the LEAD edge — approaching the frontier with covered runway left (round-22)', () => {
    // 18-t: the next island must be fetched BEFORE coverage runs out. Frontier
    // 990s, playhead 975s (within the 20s lead window) → bypass so the fetch
    // starts while ~15s of runway remains, not 20s after the blank begins.
    expect(shouldBypassRegionLedger(975, 990, false, null)).toBe(true);
    // Still fires once the playhead has passed the frontier (the 17-t blank case).
    expect(shouldBypassRegionLedger(1011, 990, false, null)).toBe(true);
  });

  it('refuses a repeat bypass at an UNCHANGED frontier (storm guard for memo-replay)', () => {
    // Already bypassed at frontier 990; the extraction returned the same island
    // (frontier still 990). A second bypass at the same frontier would storm —
    // an `ok` memo-replay resets the breaker, so only this guard stops it. This is
    // now the SOLE storm defense (round-22 dropped the past-frontier position gate).
    expect(shouldBypassRegionLedger(1011, 990, false, 990)).toBe(false);
    expect(shouldBypassRegionLedger(975, 990, false, 990)).toBe(false);  // lead edge, same frontier: still blocked
    expect(shouldBypassRegionLedger(1011, 985, false, 990)).toBe(false); // frontier went backward: no
  });

  it('allows a further bypass once the frontier ADVANCED past the last bypass', () => {
    // First bypass grew coverage 990 → 1010; playhead now 995 (within the new
    // lead window) and the frontier advanced past the recorded 990 → bypass again.
    expect(shouldBypassRegionLedger(995, 1010, false, 990)).toBe(true);
  });

  it('does NOT bypass a fully-covered track or one with no coverage yet', () => {
    expect(shouldBypassRegionLedger(1011, 990, true, null)).toBe(false);
    expect(shouldBypassRegionLedger(1011, null, false, null)).toBe(false);
  });

  it('guards non-finite / negative playhead', () => {
    expect(shouldBypassRegionLedger(NaN, 990, false, null)).toBe(false);
    expect(shouldBypassRegionLedger(-5, 990, false, null)).toBe(false);
  });

  // Structural guard: the bypass must be wired into the repair-loop gate so it
  // actually short-circuits the one-shot `subRepairAttemptedRef` check.
  it('FastStreamPlayer wires shouldBypassRegionLedger into the region-ledger gate', () => {
    const src = readFileSync(
      path.resolve(process.cwd(), 'src/components/dashboard/FastStreamPlayer.tsx'),
      'utf-8',
    );
    const effectStart = src.indexOf('maybeRepairSubCoverageRef.current = (playheadS: number) =>');
    const effectEnd = src.indexOf('const repairSubCoverage = useCallback', effectStart);
    const body = src.slice(effectStart, effectEnd);
    // The bypass is computed and short-circuits the one-shot ledger check.
    expect(body).toContain('shouldBypassRegionLedger(');
    expect(body).toContain('if (!bypassLedger && subRepairAttemptedRef.current.has(regionKey)) continue;');
  });
});
