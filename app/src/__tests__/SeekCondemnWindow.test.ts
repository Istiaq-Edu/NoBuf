import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTauriStreamSource } from '../lib/faststream/utils/TauriStreamSource';
import { mayReleaseSeekCondemnation } from '../lib/faststream/players/MediabunnyTransmuxer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

/**
 * Round-24 — "the previous prebuffer didn't stop after I seeked".
 *
 * Two independent defects, both verified against the 11:57:11 session log
 * (seek to t=1494.64s, resolved cluster byte 218,618,959 = 208.5 MiB):
 *
 *  FIX 1 (MediabunnyTransmuxer.seekTo): `resetSupersession()` ran at :1621,
 *    BEFORE `bisectSeekTarget` (:1703). A cue-less far seek therefore spent its
 *    whole 12.8s bisect with the condemnation already lifted, so the stale
 *    refill's next read passed and its sequential prefetch re-armed an 8 MiB
 *    ladder. Five stale `source_id=playback` reads walked 30.0 -> 44.5 MiB for
 *    18s after the seek. Release now happens after the keyframe resolves, with
 *    a generation-guarded `finally` covering all six early-exit paths.
 *
 *  FIX 2 (useMSEPlayer.stopStreamingChain): it called the flag-only
 *    `abortSeek()`, never `abortInFlight()`, so an 8 MiB read already on the
 *    wire completed and re-armed prefetch. Now takes `hard` and uses
 *    `interruptSeek()` on genuine position changes.
 *
 * The condemnation flag is per-source-instance (TauriStreamSource.ts:104), so
 * these tests drive the real source through its `_options.read()` seam.
 */

const ok206 = (b: Uint8Array) => new Response(b.slice().buffer as ArrayBuffer, { status: 206 });

/** Records every Range header so we can prove which byte regions were fetched. */
function recordingFetch(fileSize: number) {
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

afterEach(() => vi.unstubAllGlobals());

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

describe('round-24 FIX 1: condemnation must survive the whole search phase', () => {
  it('a condemned source rejects reads until explicitly reset', async () => {
    const { impl } = recordingFetch(64 * 1024 * 1024);
    vi.stubGlobal('fetch', impl);
    const s = createTauriStreamSource({ url: 'http://t/stream', fileSize: 64 * 1024 * 1024 }) as any;

    s.abortInFlight();
    // This models the ENTIRE search phase: bisect probes + keyframe walk. During
    // it, every stale-read attempt must die.
    for (let i = 0; i < 5; i++) {
      await expect(consumeRead(s, i * 1024, i * 1024 + 512))
        .rejects.toThrow('read aborted (superseded by seek)');
    }
    // Release only once the keyframe is resolved (the new call site).
    s.resetSupersession();
    await expect(consumeRead(s, 0, 512)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('no bytes reach the network while condemned (the starvation fix)', async () => {
    const FILE = 64 * 1024 * 1024;
    const { ranges, impl } = recordingFetch(FILE);
    vi.stubGlobal('fetch', impl);
    const s = createTauriStreamSource({ url: 'http://t/stream', fileSize: FILE }) as any;

    s.abortInFlight();
    for (const start of [31_457_280, 34_078_720, 39_845_888, 42_991_616, 46_661_632]) {
      // The five real stale reads from the log. NOTE: `read(start, end)` treats
      // `end` as EXCLUSIVE (`totalRequested = end - start`, TauriStreamSource
      // :251), so a full 8 MiB window is `start + 8 MiB`, not `- 1`.
      await consumeRead(s, start, start + 8 * 1024 * 1024).catch(() => {});
    }
    // Zero requests => zero download-semaphore permits taken => probes are not
    // starved. With only 2 global permits (lib.rs:255) this is the whole point.
    expect(ranges).toHaveLength(0);
  });

  it('release is idempotent and re-condemnation still works (multi-seek)', async () => {
    // File must exceed READAHEAD_CHUNK_SIZE (8 MiB) or a single read buffers the
    // WHOLE file and every later read is served from memory — which would make
    // the re-condemn assertion below vacuous.
    const FILE = 64 * 1024 * 1024;
    const { impl } = recordingFetch(FILE);
    vi.stubGlobal('fetch', impl);
    const s = createTauriStreamSource({ url: 'http://t/stream', fileSize: FILE }) as any;

    s.abortInFlight();
    s.resetSupersession();
    s.resetSupersession();                       // finally may double-release
    await expect(consumeRead(s, 0, 16)).resolves.toBeInstanceOf(Uint8Array);

    // Re-condemn for the next seek. Condemnation gates NETWORK fetches only, so
    // probe far outside the warmed readahead window to force a fresh fetch.
    s.abortInFlight();
    await expect(consumeRead(s, 48 * 1024 * 1024, 48 * 1024 * 1024 + 16))
      .rejects.toThrow('superseded by seek');
  });

  it('condemning one source never affects another (per-instance flag)', async () => {
    const { impl } = recordingFetch(1024);
    vi.stubGlobal('fetch', impl);
    const playback = createTauriStreamSource({ url: 'http://t/stream', fileSize: 1024 }) as any;
    const thumbnail = createTauriStreamSource({ url: 'http://t/stream', fileSize: 1024 }) as any;

    playback.abortInFlight();
    await expect(consumeRead(playback, 0, 16)).rejects.toThrow('superseded by seek');
    // The thumbnail pipeline must keep working through a playback seek.
    await expect(consumeRead(thumbnail, 0, 16)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe('round-24 FIX 1: the finally must not clobber a NEWER seek', () => {
  /**
   * Binds to the SHIPPED predicate. An earlier version of this block
   * re-implemented the rule locally, which made it vacuous: deleting the guard
   * from seekTo's finally left all tests green. Import the real thing instead.
   */
  it('an overtaken seek may NOT release (generation moved on)', () => {
    expect(mayReleaseSeekCondemnation(7, 8)).toBe(false);
    expect(mayReleaseSeekCondemnation(7, 9)).toBe(false);
  });

  it('the current seek MAY release on its own exit path', () => {
    expect(mayReleaseSeekCondemnation(7, 7)).toBe(true);
    expect(mayReleaseSeekCondemnation(0, 0)).toBe(true);
  });

  it('applied: an overtaken seek leaves the newer seek condemned', async () => {
    const { impl } = recordingFetch(64 * 1024 * 1024);
    vi.stubGlobal('fetch', impl);
    const s = createTauriStreamSource({ url: 'http://t/stream', fileSize: 64 * 1024 * 1024 }) as any;

    const genA = 7;
    let seekGeneration = 7;
    seekGeneration = 8;          // seek B starts and bumps the generation
    s.abortInFlight();           // B condemns stale work

    // A's finally runs late — the shipped guard must veto the release.
    if (mayReleaseSeekCondemnation(genA, seekGeneration)) s.resetSupersession();

    await expect(consumeRead(s, 0, 16)).rejects.toThrow('superseded by seek');
  });

  it('applied: the owning seek does release, so playback resumes', async () => {
    const { impl } = recordingFetch(64 * 1024 * 1024);
    vi.stubGlobal('fetch', impl);
    const s = createTauriStreamSource({ url: 'http://t/stream', fileSize: 64 * 1024 * 1024 }) as any;

    const genA = 7;
    const seekGeneration = 7;    // nothing overtook it
    s.abortInFlight();
    if (mayReleaseSeekCondemnation(genA, seekGeneration)) s.resetSupersession();

    await expect(consumeRead(s, 0, 16)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('every early-exit path releases (no permanently-dead source)', async () => {
    // Six exits exist between condemn and the success release: 2 throws and 4
    // `return null`s. All are covered by the same finally; model each.
    for (const exit of ['cannotRead', 'noVideoTrack', 'abandonBisect',
                        'abandonShadowRetry', 'noKeyPacket', 'abandonPostResolve']) {
      const { impl } = recordingFetch(1024);
      vi.stubGlobal('fetch', impl);
      const s = createTauriStreamSource({ url: 'http://t/stream', fileSize: 1024 }) as any;
      s.abortInFlight();
      if (mayReleaseSeekCondemnation(7, 7)) s.resetSupersession();
      await expect(consumeRead(s, 0, 16), `exit=${exit}`).resolves.toBeInstanceOf(Uint8Array);
      vi.unstubAllGlobals();
    }
  });
});

/**
 * The blocks above verify the PREDICATE and the SOURCE behaviour. Neither can
 * observe how `seekTo` is wired, because `seekTo` needs a live mediabunny Input
 * to run — and that is precisely where the fix lives. Deleting the generation
 * guard from the shipped `finally` left every test above green (verified by
 * mutation), so these assertions read the shipped file and pin the wiring.
 *
 * Cheap, deterministic, and they fail loudly if someone reverts the fix or moves
 * the release back above the bisect.
 */
describe('round-24: shipped wiring in MediabunnyTransmuxer.seekTo', () => {
  const SRC = readFileSync(
    fileURLToPath(new URL('../lib/faststream/players/MediabunnyTransmuxer.ts', import.meta.url)),
    'utf8',
  );

  /** Executable lines only — a rule quoted in a comment is documentation. */
  const codeLines: { n: number; text: string }[] = SRC.split('\n')
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });

  const lineOf = (re: RegExp) => codeLines.find(({ text }) => re.test(text))?.n;
  const allLinesOf = (re: RegExp) => codeLines.filter(({ text }) => re.test(text)).map(({ n }) => n);

  it('condemns in-flight reads on entry', () => {
    expect(lineOf(/abortInFlight\?\.\(\)/)).toBeDefined();
  });

  it('releases the condemnation only AFTER the bisect (the round-24 fix)', () => {
    const bisect = lineOf(/await this\.bisectSeekTarget/);
    const releases = allLinesOf(/resetSupersession\?\.\(\)/);
    expect(bisect).toBeDefined();

    // Release sites, and why each exists:
    //   1. pre-canRead()   — clears the condemnation this seek INHERITED from the
    //      caller's hard stop, so metadata reads can run. Round-24 lacked this
    //      and every seek died into /remux.
    //   2. pre-walk (x2)   — round-27: the keyframe walk is THIS seek's own read.
    //      One per branch (indexed / cue-less), mutually exclusive at runtime.
    //      27-c proved the walk was dying '(superseded by seek)' at gen 4->4.
    //   3. post-resolve    — the round-24 success-path release.
    //   4. finally         — generation-guarded catch-all.
    //
    // The invariant is NOT a head count and NOT "every release textually
    // follows the bisect" — it is "the BISECT runs condemned".
    //
    // Text order is not execution order here. The indexed release (:1765) sits
    // textually before the bisect but inside the `if (useCachedIndex || ...)`
    // branch, while the bisect lives in the `else`. They are mutually exclusive
    // at runtime, so that release can never precede a bisect that actually ran.
    // A release only precedes the bisect ON THE BISECT'S OWN PATH if it sits
    // OUTSIDE the indexed branch entirely — i.e. above the `if`.
    const ifLine = lineOf(/if \(useCachedIndex \|\| byteOffsetKeyframe !== null\) \{/)!;
    const before = releases.filter((r) => r < ifLine);
    const after = releases.filter((r) => r > bisect!);
    expect(before.length, 'only the inherited-condemnation clear may precede the bisect').toBe(1);
    expect(after.length, 'the walk/resolve/finally releases must all follow the bisect')
      .toBeGreaterThanOrEqual(3);
  });

  it('re-arms the condemnation between the metadata reads and the bisect', () => {
    // This is what keeps the round-24 win: stale refill reads stay locked out
    // for the whole expensive search. Without it the pre-canRead() release of
    // round-25 would simply undo round-24.
    //
    // Scope to seekTo's body: `canRead()` also appears in init (:519), the
    // keyframe scanner, and seqContinue. Anchoring on the file-wide first match
    // compares against init's copy and is meaningless.
    const seekToLine = lineOf(/async seekTo\(/)!;
    const after = (n: number | undefined) => n !== undefined && n > seekToLine;

    const release = allLinesOf(/resetSupersession\?\.\(\)/).find(after);
    const canRead = allLinesOf(/const canRead = await this\.input\.canRead\(\)/).find(after);
    const bisect = lineOf(/await this\.bisectSeekTarget/);
    const rearm = allLinesOf(/abortInFlight\?\.\(\)/).find((n) => n > canRead!);

    expect(release).toBeLessThan(canRead!);
    expect(rearm, 'search phase must be re-condemned').toBeDefined();
    expect(rearm!).toBeGreaterThan(canRead!);
    expect(rearm!).toBeLessThan(bisect!);
  });

  it('the finally releases through the generation guard, not directly', () => {
    // There are TWO `finally` blocks in this file; the first belongs to the
    // keyframe scanner (`scanInput.dispose()`). Anchor on seekTo's by finding
    // the one that mentions the condemnation.
    const blocks = [...SRC.matchAll(/\}\s*finally\s*\{([\s\S]*?)\n {4}\}/g)].map((m) => m[1]);
    const body = blocks.find((b) => b.includes('resetSupersession'));
    expect(body, 'seekTo finally block not found').toBeDefined();
    // The mutation that survived twice: guard deleted, bare release left behind.
    expect(body).toContain('mayReleaseSeekCondemnation');
    expect(body).toMatch(/if \(mayReleaseSeekCondemnation\([^)]*\)\) \{/);
  });

  it('the guard is real equality, not a stub', () => {
    expect(SRC).toMatch(
      /export function mayReleaseSeekCondemnation[^{]*\{\s*return capturedGen === liveGen;\s*\}/,
    );
  });
});
