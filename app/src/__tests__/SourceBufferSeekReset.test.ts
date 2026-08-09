import { describe, expect, it, vi } from 'vitest';
import { SourceBufferWrapper } from '../lib/faststream/players/SourceBufferWrapper';

class FakeSourceBuffer extends EventTarget {
  updating = true;
  remove = vi.fn((start: number, end: number) => {
    void start; void end;
    this.updating = true;
  });
  appendBuffer = vi.fn();
  abort = vi.fn(() => { this.updating = false; });
  buffered = {
    length: 3,
    start: (i: number) => [0, 100, 200][i],
    end: (i: number) => [40, 120, 240][i],
  } as TimeRanges;
}

describe('SourceBufferWrapper non-blocking seek reset', () => {
  it('aborts stale work and resolves without removing the historical range', async () => {
    const sourceBuffer = new FakeSourceBuffer();
    const wrapper = new SourceBufferWrapper(sourceBuffer as unknown as SourceBuffer);

    await wrapper.resetForSeekNonBlocking();

    expect(sourceBuffer.abort).toHaveBeenCalledOnce();
    expect(sourceBuffer.remove).not.toHaveBeenCalled();
  });

  it('prunes disjoint historical ranges after landing while retaining the target island', () => {
    const sourceBuffer = new FakeSourceBuffer();
    sourceBuffer.updating = false;
    const wrapper = new SourceBufferWrapper(sourceBuffer as unknown as SourceBuffer);

    wrapper.pruneBufferedRangesExcept(105);

    expect(sourceBuffer.remove).toHaveBeenCalledWith(0, 40);
    expect(sourceBuffer.remove).not.toHaveBeenCalledWith(100, 120);
  });
});
