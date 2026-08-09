import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTauriStreamSource } from '../lib/faststream/utils/TauriStreamSource';

const FILE_SIZE = 64 * 1024 * 1024;

const responseWithDelayedTail = () => new Response(
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      setTimeout(() => {
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      }, 25);
    },
  }),
  { status: 206 },
);

afterEach(() => vi.unstubAllGlobals());

describe('TauriStreamSource streaming reads', () => {
  it('delivers the first range chunk before the requested range completes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseWithDelayedTail()));
    const source = createTauriStreamSource({
      url: 'http://t/stream',
      fileSize: FILE_SIZE,
      prefetchProfile: 'none',
    }) as any;

    const result = await source._options.read(0, 4);
    expect(result).toBeInstanceOf(ReadableStream);

    const reader = result.getReader();
    const first = await reader.read();
    expect(Array.from(first.value as Uint8Array)).toEqual([1, 2]);

    const second = await reader.read();
    expect(Array.from(second.value as Uint8Array)).toEqual([3, 4]);
    expect((await reader.read()).done).toBe(true);
  });
});
