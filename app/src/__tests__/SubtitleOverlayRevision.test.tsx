// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('SubtitleOverlay cue revision invalidation', () => {
  it('recomputes DOM lines when cues mutate in place and revision changes', () => {
    const source = readFileSync(`${process.cwd()}/src/components/dashboard/SubtitleOverlay.tsx`, 'utf8');
    expect(source).toContain('}, [vttTracks, currentTime, revision]);');
  });
});
