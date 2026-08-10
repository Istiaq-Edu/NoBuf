import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('MKV proactive reporter lifecycle', () => {
  const source = readFileSync(`${process.cwd()}/src/hooks/useMSEPlayer.ts`, 'utf8');

  it('starts a periodic exact-byte reporter on prime, seek completion, and resume', () => {
    const fnStart = source.indexOf('const startMkvProactiveReporter = () =>');
    const fnEnd = source.indexOf('/**', fnStart);
    const helper = source.slice(fnStart, fnEnd);
    expect(helper).toContain('setInterval(tick, 2_000)');
    expect(helper).toContain('timeToByte(video.currentTime)');
    const report = source.slice(source.indexOf('const reportMkvProactivePosition ='), fnStart);
    expect(report).toContain('isPlayerDownloading: refillInProgressRef.current');
    expect(report).toContain('mkvProactiveReportInFlightRef.current) return');
    expect(report).toContain('mkvProactiveReportInFlightRef.current = true');
    expect(report).toContain('finally { mkvProactiveReportInFlightRef.current = false; }');
    expect(source.match(/startMkvProactiveReporter\(\);/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('uses the existing pause and teardown interval cleanup', () => {
    const pause = source.slice(source.indexOf('const pausePrefetch = () =>'), source.indexOf('const resumePrefetch = () =>'));
    expect(pause).toContain('clearInterval(proactiveIntervalRef.current)');
    expect(pause).toContain('proactiveIntervalRef.current = null');
  });
});
