import { describe, expect, it } from 'vitest';
import { SourceBufferWrapper } from '../lib/faststream/players/SourceBufferWrapper';

describe('SourceBufferWrapper non-blocking seek reset', () => {
  it('clears pending work without waiting for remove-all', async () => {
    const listeners = new Map<string, Set<() => void>>();
    const sb = {
      updating: false,
      buffered: { length: 1, start: () => 0, end: () => 40 },
      addEventListener(type: string, fn: () => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener() {},
      abort() {},
      remove() { throw new Error('blocking remove must not run'); },
      appendBuffer() {},
    } as unknown as SourceBuffer;
    const wrapper = new SourceBufferWrapper(sb);
    await wrapper.resetForSeekNonBlocking();
    expect(wrapper.queueLength).toBe(0);
  });
});
