import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifySubRepairOutcome } from '../hooks/useMSEPlayer';

describe('round 36 subtitle repair verdicts', () => {
  it('keeps normal dialogue gaps inside the coverage grace at ok', () => {
    expect(classifySubRepairOutcome(
      2248, 7085, 7075, false, false,
      undefined, null, null, null, null,
      [{ startTime: 7082.78, endTime: 7084.87 }], 24,
    )).toBe('ok');
  });

  it('accepts a cue that actually covers the playhead', () => {
    expect(classifySubRepairOutcome(
      7000, 7085, 7075, false, false,
      undefined, null, null, null, null,
      [{ startTime: 7074, endTime: 7076 }], 24,
    )).toBe('ok');
  });

  it('treats the first partial frontier as deferred, not a 150-second failure', () => {
    expect(classifySubRepairOutcome(
      null, null, 6367, true, false,
      undefined, null, null, null, 33_554_432,
    )).toBe('deferred');
  });
});

describe('round 36 post-seek runway and discriminator', () => {
  const source = readFileSync(`${process.cwd()}/src/hooks/useMSEPlayer.ts`, 'utf8');

  it('seeds substantially more than the logged 8-second landing island', () => {
    expect(source).toContain('const SEEK_START_DURATION = 20;');
  });

  it('keeps a generation-safe bounded post-seek stall discriminator', () => {
    expect(source).toContain('performance.now() - monitorStartedAt > 15_000');
    expect(source).toContain('seekGen !== transmuxerSeekGenRef.current');
    expect(source).toContain('[MSE] SEEK-STALL:');
  });
});
