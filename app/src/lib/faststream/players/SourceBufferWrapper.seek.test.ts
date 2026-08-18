import { describe, expect, it, vi } from 'vitest';
import { SourceBufferWrapper } from './SourceBufferWrapper';

function fakeSourceBuffer(updating = false) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    updating,
    buffered: { length: 1, start: () => 0, end: () => 100 },
    addEventListener: (type: string, fn: () => void) => {
      let set = listeners.get(type);
      if (!set) { set = new Set(); listeners.set(type, set); }
      set.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    abort: vi.fn(),
    remove: vi.fn(),
    appendBuffer: vi.fn(),
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
  } as unknown as SourceBuffer & { fire: (type: string) => void; remove: ReturnType<typeof vi.fn> };
}

describe('SourceBufferWrapper non-blocking seek reset', () => {
  it('clears stale work without waiting for full-range removal', async () => {
    const source = fakeSourceBuffer(true);
    const wrapper = new SourceBufferWrapper(source);
    wrapper.appendBuffer(new ArrayBuffer(8));

    await wrapper.resetForSeekNonBlocking();

    expect(source.abort).toHaveBeenCalled();
    expect(source.remove).not.toHaveBeenCalled();
    expect(wrapper.queueLength).toBe(0);
  });

  it('keeps the full reset blocking until old ranges are removed', async () => {
    const source = fakeSourceBuffer(false);
    const wrapper = new SourceBufferWrapper(source);
    let resolved = false;
    const reset = wrapper.resetForSeek().then(() => { resolved = true; });

    expect(source.remove).toHaveBeenCalledWith(0, 100);
    expect(resolved).toBe(false);
    source.fire('updateend');
    await reset;
    expect(resolved).toBe(true);
  });
});
