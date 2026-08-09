import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTauriStreamSource } from './TauriStreamSource';

/**
 * Fix A1 (round-2): sticky seek condemnation.
 *
 * Root cause pinned here (round-2 forensics §A, V3): abortInFlight() aborted only the
 * AbortControllers alive AT THAT INSTANT, but a cue-less getKeyPacket walk is a LOOP of
 * sequential fetches, each with a fresh controller — an interrupt landing BETWEEN two
 * fetches was silently lost and the condemned walk ran to completion (observed: 35.7s,
 * 48MB zombie that resolved, emitted an init segment, and was discarded).
 *
 * Sticky semantics: abortInFlight() sets `superseded`; every subsequent fetch attempt
 * throws '[TauriStreamSource] read aborted (superseded by seek)' (the EXISTING error text,
 * so downstream routing — seekTo's isAborted/isExpectedError — is unchanged) until
 * resetSupersession() is called at the next seekTo entry.
 *
 * Test seam: vendored CustomSource stores its options object as `_options`; driving
 * `(source as any)._options.read(start, end)` exercises our read → ensureBufferCovers →
 * fetchRange directly with no Input/orchestrator/backend. fileSize=16 keeps every read to
 * ONE fetch and disables prefetch (afterEnd >= fileSize).
 */

const FILE = new Uint8Array(16).map((_, i) => i);
const ok206 = (b: Uint8Array) => new Response(b.slice().buffer as ArrayBuffer, { status: 206 });
const servingFetch = () => vi.fn(async (_u: any, init: any) => {
  const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
  return ok206(FILE.subarray(+m[1], +m[2] + 1));
});
const hangingFetch = () => vi.fn((_u: any, init: any) => new Promise((_r, rej) =>
  init.signal.addEventListener('abort', () => rej(new DOMException('x', 'AbortError')))));
const makeSource = () => createTauriStreamSource({ url: 'http://t/stream', fileSize: 16 }) as any;

async function consumeRead(source: any, start: number, end: number): Promise<Uint8Array> {
  const value = await source._options.read(start, end);
  if (value instanceof Uint8Array) return value;
  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    size += next.value.byteLength;
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return merged;
}

afterEach(() => vi.unstubAllGlobals());

describe('TauriStreamSource sticky condemn (fix A1)', () => {
  it('exposes the test seam (vendored CustomSource keeps _options)', () => {
    vi.stubGlobal('fetch', servingFetch());
    expect(typeof makeSource()._options?.read).toBe('function');
  });

  it('condemn BETWEEN fetches rejects the next read (the lost-abort window, closed)', async () => {
    vi.stubGlobal('fetch', servingFetch());
    const s = makeSource();
    s.abortInFlight();                       // lands while nothing is in flight
    await expect(consumeRead(s, 0, 16))     // pre-fix this RESOLVED (spike-pinned bug)
      .rejects.toThrow('[TauriStreamSource] read aborted (superseded by seek)');
  });

  it('condemn MID-fetch still rejects (existing abort mapping kept)', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const s = makeSource();
    const p = consumeRead(s, 0, 16);
    await new Promise(r => setTimeout(r, 10));
    s.abortInFlight();
    await expect(p).rejects.toThrow('read aborted (superseded by seek)');
  });

  it('resetSupersession clears the condemn → next read succeeds (new seek proceeds)', async () => {
    vi.stubGlobal('fetch', servingFetch());
    const s = makeSource();
    s.abortInFlight();
    await expect(consumeRead(s, 0, 16)).rejects.toThrow('superseded by seek');
    s.resetSupersession();                   // seekTo-entry clear (fix A1)
    const data = await consumeRead(s, 0, 16);
    expect(Array.from(data)).toEqual(Array.from(FILE));
  });

  it('re-condemn after reset rejects again (re-entrancy pinned)', async () => {
    vi.stubGlobal('fetch', servingFetch());
    const s = makeSource();
    s.abortInFlight();
    s.resetSupersession();
    s.abortInFlight();                       // interrupt again — flag must re-arm
    // NOTE: condemnation gates NETWORK fetches only. A read fully served by the
    // readahead buffer resolves even while condemned (free in-memory serve; a real
    // zombie walk marches into NEW territory and dies at its first network touch).
    // Hence no read between reset and re-condemn here — the first fetch-touching
    // read must reject.
    await expect(consumeRead(s, 0, 16)).rejects.toThrow('superseded by seek');
  });

  it('a fresh source is not condemned (thumbnail instance unaffected)', async () => {
    vi.stubGlobal('fetch', servingFetch());
    await expect(consumeRead(makeSource(), 0, 16)).resolves.toHaveLength(16);
  });
});
