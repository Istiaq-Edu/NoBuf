import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTauriStreamSource } from '../lib/faststream/utils/TauriStreamSource';

/**
 * Round-25 REGRESSION — round-24's condemnation window swallowed the seek itself.
 *
 * Round-24 made two changes that are individually correct and jointly fatal:
 *
 *   1. `stopStreamingChain(true)` now calls `interruptSeek()`, which calls
 *      `abortInFlight()` -> `superseded = true`. This happens BEFORE `seekTo`.
 *   2. `seekTo` no longer releases the condemnation early; the release moved to
 *      after the keyframe resolves.
 *
 * Net effect: the source is condemned on ENTRY to `seekTo` (by the caller) and
 * stays condemned across `canRead()` / `getPrimaryVideoTrack()`. Any of those
 * that needs a byte read throws '(superseded by seek)'. `seekTo`'s catch treats
 * that message as an expected cancellation and returns null, and the caller
 * reroutes the whole file to the /remux tier.
 *
 * Observed in 25-c:
 *   :81  Streaming chain stopped (hard — in-flight reads aborted)
 *   :86  seekTo: reusing persistent MKV Input, seekTime=89.68s
 *   :87  Seek canceled/disposed (expected during seek)
 *   :88  MKV user seek keyframe unresolvable — rerouting to /remux
 *
 * Consequence for the user: every seek falls to /remux, which has no bisect and
 * therefore reports a LINEAR byte estimate to the prebuffer. Verified against
 * the log — all five reports equal linear(t) within ~90 bytes:
 *   t=89.679s   -> 15,807,020   (linear 15,807,108)
 *   t=2670.427s -> 470,697,938  (linear 470,698,024)
 *   t=4643.354s -> 818,452,385  (linear 818,452,462)
 * On this VBR file that estimate runs 40-60 MB off the true cluster, which is
 * exactly "prebuffer points are way too much off".
 */

const ok206 = (b: Uint8Array) => new Response(b.slice().buffer as ArrayBuffer, { status: 206 });

function servingFetch(fileSize: number) {
  const ranges: string[] = [];
  const impl = vi.fn(async (_u: unknown, init: { headers: Record<string, string> }) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
    const start = +m[1];
    const end = Math.min(+m[2], fileSize - 1);
    ranges.push(`${start}-${end}`);
    return ok206(new Uint8Array(end - start + 1));
  });
  return { ranges, impl };
}

const FILE = 64 * 1024 * 1024;

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

describe('round-25: a caller-condemned source must not break the seek that follows', () => {
  it('REPRODUCES the regression: condemn-then-seek makes the first read throw', async () => {
    const { impl } = servingFetch(FILE);
    vi.stubGlobal('fetch', impl);
    const s = createTauriStreamSource({ url: 'http://t/stream', fileSize: FILE }) as any;

    // stopStreamingChain(true) -> interruptSeek() -> abortInFlight()
    s.abortInFlight();

    // seekTo() entry: abortInFlight() again, then NO release before canRead().
    s.abortInFlight();

    // canRead()/getPrimaryVideoTrack() on a fresh-metadata path need a read.
    await expect(consumeRead(s, 0, 4096))
      .rejects.toThrow('read aborted (superseded by seek)');
  });

  it('the fix: seekTo must arm its own window, not inherit the caller\'s', async () => {
    const { impl } = servingFetch(FILE);
    vi.stubGlobal('fetch', impl);
    const s = createTauriStreamSource({ url: 'http://t/stream', fileSize: FILE }) as any;

    s.abortInFlight();          // caller condemns (hard stop)
    s.abortInFlight();          // seekTo entry condemns

    // seekTo must clear the inherited condemnation before its metadata reads,
    // then re-arm it for the search phase itself. After that clear, reads work.
    s.resetSupersession();
    await expect(consumeRead(s, 0, 4096)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('seekTo releases BEFORE canRead() and re-arms AFTER the track resolves', async () => {
    // Structural: the behavioral tests above exercise TauriStreamSource's
    // predicate, but nothing binds seekTo to actually call it in the right
    // order. Assert the shipped ordering directly, or deleting either call
    // silently reintroduces the /remux reroute.
    //
    // NOTE: `canRead()` appears at four call sites (init, keyframe scan,
    // seqContinue, seekTo). Scope the search to seekTo's body first — anchoring
    // on the file-wide first match compares against init's copy and is
    // meaningless.
    const fs = await import('node:fs');
    const full = fs.readFileSync(
      new URL('../lib/faststream/players/MediabunnyTransmuxer.ts', import.meta.url),
      'utf8',
    );
    const bodyStart = full.indexOf('async seekTo(');
    expect(bodyStart, 'seekTo not found').toBeGreaterThan(-1);
    const src = full.slice(bodyStart);

    const release = src.indexOf('resetSupersession?.();');
    const canRead = src.indexOf('const canRead = await this.input.canRead()');
    const rearm = src.indexOf('abortInFlight?.();\n\n      const seekStartTime = performance.now()');

    expect(release, 'seekTo must clear the inherited condemnation').toBeGreaterThan(-1);
    expect(canRead, 'seekTo canRead() not found').toBeGreaterThan(-1);
    expect(rearm, 'seekTo must re-arm the condemnation for the search phase').toBeGreaterThan(-1);

    // release -> canRead -> re-arm, in that order.
    expect(release).toBeLessThan(canRead);
    expect(canRead).toBeLessThan(rearm);
  });

  it('stale-read protection still holds once the search phase re-arms', async () => {
    const { ranges, impl } = servingFetch(FILE);
    vi.stubGlobal('fetch', impl);
    const s = createTauriStreamSource({ url: 'http://t/stream', fileSize: FILE }) as any;

    s.resetSupersession();
    await consumeRead(s, 0, 4096);           // metadata read succeeds
    const afterMetadata = ranges.length;

    // Search phase begins: re-arm so stale refill reads cannot steal permits.
    s.abortInFlight();
    for (const start of [31_457_280, 39_845_888, 46_661_632]) {
      await consumeRead(s, start, start + 8 * 1024 * 1024).catch(() => {});
    }
    expect(ranges.length).toBe(afterMetadata); // zero new network traffic
  });
});
