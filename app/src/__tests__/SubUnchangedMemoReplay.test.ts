import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('successful embedded-subtitle memo replay wiring', () => {
  it('preserves X-Subs-Unchanged on HTTP 200 responses', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/hooks/useMSEPlayer.ts'), 'utf-8');
    const start = src.indexOf('const fetchEmbeddedSubText = useCallback');
    const end = src.indexOf('/** Build the /subtitles font URLs', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    expect(body).toContain("const unchanged = resp.headers.get('X-Subs-Unchanged') === '1'");
    expect(body).toContain('return { text, format, partial, unchanged, frontier: okFrontier }');
  });

  it('forwards the successful-response marker into outcome classification', () => {
    const src = readFileSync(
      path.resolve(process.cwd(), 'src/components/dashboard/FastStreamPlayer.tsx'),
      'utf-8',
    );
    const start = src.indexOf('const repairSubCoverage = useCallback');
    const end = src.indexOf('// Reset the per-region repair ledger', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    expect(body).toContain('snapshotUnchanged = res.unchanged');
    const classifyStart = body.indexOf('const outcome = classifySubRepairOutcome(');
    const classifyEnd = body.indexOf(');', classifyStart);
    expect(classifyStart).toBeGreaterThan(-1);
    expect(classifyEnd).toBeGreaterThan(classifyStart);
    expect(body.slice(classifyStart, classifyEnd)).toContain('snapshotUnchanged');
  });
});
