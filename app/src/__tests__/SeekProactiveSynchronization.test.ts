import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/hooks/useMSEPlayer.ts'), 'utf8');

function executedSeekBlock(): string {
  const start = source.indexOf('const executeTransmuxerSeek = () => {');
  const end = source.indexOf('// Dispatch decision', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('user seek and proactive synchronization', () => {
  it('stops proactive before seekTo and does not report an estimated byte', () => {
    const block = executedSeekBlock();
    const seekCall = block.indexOf('await transmuxerRef.current!.seekTo(');
    const beforeSeek = block.slice(0, seekCall);
    expect(seekCall).toBeGreaterThan(0);
    expect(beforeSeek).toContain("invoke('cmd_stop_proactive_prebuffer'");
    expect(beforeSeek).not.toContain("invoke('cmd_report_playback_position'");
  });

  it('reports one resolved byte only after the supersession guard', () => {
    const block = executedSeekBlock();
    const guard = block.indexOf('if (isSeekSuperseded(');
    const report = block.indexOf('reportMkvProactivePosition(', guard);
    expect(guard).toBeGreaterThan(0);
    expect(report).toBeGreaterThan(guard);
    expect(block.slice(guard, report)).toContain('resolvedSeekByte');
  });

  it('warm/indexed seeks can restart from seekAnchor without a bisect anchor', () => {
    const block = executedSeekBlock();
    expect(block).toContain('bisectAnchor?.byteOffset ?? seekAnchor?.byteOffset ?? -1');
  });
});
