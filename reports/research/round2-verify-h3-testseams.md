# Round-2 verification — H3a/H3b test seams (+ concrete test designs)

Verifies the two test-seam hypotheses from `seek-interrupt-rootcause.md` §Test seams and
delivers the test skeletons for fixes A (sticky condemn), A2 (post-resolve belt), and B
(cue-less capture guard). All API names below verified against live source 2026-08-02.
**Baseline note:** suite is now **400 tests / 28 files** (report said 390/26 — grown since);
`npx vitest run` all green after this task's spike was removed.

---

## H3a — pure-helper extraction is the established pattern: **VERIFIED**

- `decideSeekDispatch.test.ts` imports 5 pure helpers **directly from the hook file**:
  `decideSeekDispatch, isSeekSuperseded, computeSeekLandingTime, shouldInterruptInflightSeek,
  shouldWarmerYield` from `../hooks/useMSEPlayer` (test :2-8; exports at useMSEPlayer.ts:590,
  :613, :699…). Same pattern: `NullRefillBreaker.test.ts` (`classifyNullRefill`),
  `RefillBackoff.test.ts` (`computeRefillChainDelay`).
- **useThumbnailExtractor.ts already has this in-file precedent**: exported pure helpers
  `resolveKeyframeSegmentMode` (:116, comment "Pure + exported so this routing is unit-tested
  without a live backend") and `computeThumbnailSeekTarget` (:143), tested in
  `SpeedMeterAndThumbTimeout.test.ts` and `ThumbnailSeekTarget.test.ts`. `decideMkvCaptureStrategy`
  slots in beside them with zero novelty.
- **Conventions**: tests in `app/src/__tests__/<Name>.test.ts` (PascalCase or helperName);
  source-level tests may co-locate (`src/lib/faststream/MpegtsChunkLoader.backpressure.test.ts`).
  Every test importing a hook/transmuxer module adds
  `vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }))`.
  Rich doc-comments citing the trace/root-cause are house style.
- **Config quirks**: there is **NO vitest.config.ts and no `test` section in vite.config.ts**
  → environment defaults to **node** (vitest 4.1.6). jsdom is installed but opt-in per file via
  `// @vitest-environment jsdom` docblock (only `SubtitleTrack.test.ts:1` uses it). New tests
  need nothing special; node ≥20 provides global `fetch`/`Response` (spike-verified).

## H3b — TauriStreamSource unit-testable via stubbed fetch: **VERIFIED (empirically)**

1. **fetch source**: `fetchRange` calls bare **global `fetch`** (TauriStreamSource.ts:135) — no
   import, no Tauri plugin → `vi.stubGlobal('fetch', …)` intercepts it. `stubGlobal` precedent:
   `AudioTrackSelection.test.ts:193`, `EmbeddedSubtitles.test.ts:141` (localStorage). No existing
   test stubs fetch (`MpegtsChunkLoader.backpressure.test.ts` mocks the mpegts module + fake
   timers, not fetch) — new but trivially supported.
2. **Drive seam**: vendored `CustomSource` stores its options object on the instance:
   `this._options = options` (node_modules/mediabunny/dist/modules/src/source.js:775; class at
   :752). So `(source as any)._options.read(start, end)` drives OUR read callback (and through
   it `ensureBufferCovers`→`fetchRange`) directly — no Input, no orchestrator, no backend.
   Depending on a vendored private field has precedent (`CuelessMkvFixture.test.ts` pins vendored
   demuxer behavior); guard with a one-line `expect(typeof (source as any)._options?.read).toBe('function')`
   so a mediabunny upgrade fails loudly.
3. **Spike proof** (written, run, deleted): 3/3 green in node env —
   (a) `_options.read(0,16)` with stubbed fetch returns bytes, one Range request `bytes=0-15`;
   (b) `abortInFlight()` while a fetch is in flight → rejects with
   `'[TauriStreamSource] read aborted (superseded by seek)'` (existing mapping :140-144);
   (c) **the bug pin**: `abortInFlight()` BETWEEN fetches is lost — next read succeeds
   (root-cause V3). Post-fix, (c) inverts and becomes the core sticky-condemn assertion.
4. Rejection propagation verified: fetchRange throws pass through `_options.read`'s catch blocks
   (:303-306, :334-339 rethrow when `!disposed`) → the read promise rejects. A condemned
   background prefetch is swallowed by `startPrefetch`'s `.catch` (:211-214) — H1b holds at the
   source level. Tiny `fileSize` (16B) keeps each read to ONE fetch and disables prefetch
   (`afterEnd >= fileSize` guard :205) — no timer gymnastics needed.

---

## Test 1 — sticky condemn (fix A): `src/lib/faststream/utils/TauriStreamSource.condemn.test.ts`

Co-located (loader precedent). Names real today except `resetSupersession` (the fix adds it).
[Clear point is FIXED per cross-validation R6.1: `resetSupersession()` at seekTo entry
(MediabunnyTransmuxer.ts:1303, before :1306). Do NOT clear inside `markSeekStart` — that
function is deleted by this same change and sits after cold-path reads.]

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTauriStreamSource } from './TauriStreamSource';

const FILE = new Uint8Array(16).map((_, i) => i);
const ok206 = (b: Uint8Array) => new Response(b.slice().buffer as ArrayBuffer, { status: 206 });
const servingFetch = () => vi.fn(async (_u: any, init: any) => {
  const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)!;
  return ok206(FILE.subarray(+m[1], +m[2] + 1));
});
const hangingFetch = () => vi.fn((_u: any, init: any) => new Promise((_r, rej) =>
  init.signal.addEventListener('abort', () => rej(new DOMException('x', 'AbortError')))));
const makeSource = () => createTauriStreamSource({ url: 'http://t/stream', fileSize: 16 }) as any;

afterEach(() => vi.unstubAllGlobals());

describe('TauriStreamSource sticky condemn (fix A)', () => {
  it('exposes the test seam (vendored CustomSource keeps _options)', () => {
    vi.stubGlobal('fetch', servingFetch());
    expect(typeof makeSource()._options?.read).toBe('function');
  });

  it('condemn BETWEEN fetches rejects the next read (the V3 lost-abort window, closed)', async () => {
    vi.stubGlobal('fetch', servingFetch());
    const s = makeSource();
    s.abortInFlight();                       // lands while nothing is in flight
    await expect(s._options.read(0, 16))     // pre-fix this RESOLVED (spike-pinned)
      .rejects.toThrow('[TauriStreamSource] read aborted (superseded by seek)');
  });

  it('condemn MID-fetch still rejects (existing abort mapping kept)', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const s = makeSource();
    const p = s._options.read(0, 16);
    await new Promise(r => setTimeout(r, 10));
    s.abortInFlight();
    await expect(p).rejects.toThrow('read aborted (superseded by seek)');
  });

  it('resetSupersession clears the condemn → next read succeeds (new seek proceeds)', async () => {
    vi.stubGlobal('fetch', servingFetch());
    const s = makeSource();
    s.abortInFlight();
    await expect(s._options.read(0, 16)).rejects.toThrow('superseded by seek');
    s.resetSupersession();                   // seekTo-entry clear (fix A)
    const data: Uint8Array = await s._options.read(0, 16);
    expect(Array.from(data)).toEqual(Array.from(FILE));
  });

  it('a fresh source is not condemned (thumbnail instance unaffected, H1c)', async () => {
    vi.stubGlobal('fetch', servingFetch());
    await expect(makeSource()._options.read(0, 16)).resolves.toHaveLength(16);
  });
});
```

## Test 2 — `decideMkvCaptureStrategy` (fix B): `src/__tests__/decideMkvCaptureStrategy.test.ts`

Extract from useThumbnailExtractor.ts:847-875 as an exported pure helper beside
`computeThumbnailSeekTarget`. Proposed contract (return the hit timestamp so the call site keeps
`verifyKeyPackets:false` on it):

```ts
export type MkvCaptureDecision =
  | { strategy: 'index'; timestamp: number }
  | { strategy: 'native' }   // cue-indexed MKV fallback — unchanged tier
  | { strategy: 'skip' };    // cue-less + index miss → TS-precedent skip (:830-836)
export function decideMkvCaptureStrategy(
  timestamps: number[], time: number, maxGap: number, cueless: boolean,
): MkvCaptureDecision;
```

```ts
import { describe, it, expect, vi } from 'vitest';
import { decideMkvCaptureStrategy } from '../hooks/useThumbnailExtractor';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

describe('decideMkvCaptureStrategy', () => {
  const TS = [0, 10, 20, 30];       // harvested keyframes
  const GAP = 12;                    // THUMB_INDEX_MAX_GAP (useThumbnailExtractor.ts:81)

  it('index hit within gap → indexed capture with the FOUND timestamp (both cue states)', () => {
    expect(decideMkvCaptureStrategy(TS, 15, GAP, true)).toEqual({ strategy: 'index', timestamp: 10 });
    expect(decideMkvCaptureStrategy(TS, 15, GAP, false)).toEqual({ strategy: 'index', timestamp: 10 });
    expect(decideMkvCaptureStrategy(TS, 30, GAP, true)).toEqual({ strategy: 'index', timestamp: 30 }); // exact
    expect(decideMkvCaptureStrategy(TS, 42, GAP, true)).toEqual({ strategy: 'index', timestamp: 30 }); // gap boundary =12
  });

  it('gap miss: cue-less → skip (the V9 unbounded-scan fix); cue-indexed → native (tier untouched)', () => {
    expect(decideMkvCaptureStrategy(TS, 42.01, GAP, true)).toEqual({ strategy: 'skip' });
    expect(decideMkvCaptureStrategy(TS, 42.01, GAP, false)).toEqual({ strategy: 'native' });
  });

  it('no index at all (pre-harvest hover, V11): cue-less → skip; cue-indexed → native', () => {
    expect(decideMkvCaptureStrategy([], 3427.71, GAP, true)).toEqual({ strategy: 'skip' });   // the trace hover
    expect(decideMkvCaptureStrategy([], 3427.71, GAP, false)).toEqual({ strategy: 'native' });
  });

  it('hover BEFORE the first keyframe (ts[lo] > time) is a miss, not a bogus hit', () => {
    expect(decideMkvCaptureStrategy([100, 200], 50, GAP, false)).toEqual({ strategy: 'native' });
    expect(decideMkvCaptureStrategy([100, 200], 50, GAP, true)).toEqual({ strategy: 'skip' });
  });

  it('binary search picks nearest ≤ time, never a later keyframe', () => {
    expect(decideMkvCaptureStrategy(TS, 29.9, GAP, true)).toEqual({ strategy: 'index', timestamp: 20 });
  });
});
```

## Test 3 — `shouldAbandonResolvedSeek` (fix A2): **recommend extraction — YES**

The belt is a 3-term predicate at the post-`getKeyPacket` join (MediabunnyTransmuxer.ts:1471-1487,
mirroring the catch-handler terms at :1598-1600). House style pins even 2-term predicates
(`shouldInterruptInflightSeek`, `shouldWarmerYield` — 4-8-case truth tables), so extract a
module-level export in `players/MediabunnyTransmuxer.ts` (file currently exports only
interfaces + the class — a function export is new but unremarkable):

```ts
export function shouldAbandonResolvedSeek(
  seekAbortFlag: boolean, disposed: boolean, capturedGen: number, liveGen: number,
): boolean { return seekAbortFlag || disposed || capturedGen !== liveGen; }
```

`src/__tests__/AbandonResolvedSeek.test.ts` — MUST carry the Tauri mock (the transmuxer module
imports `invoke` at MediabunnyTransmuxer.ts:38; mediabunny/TauriStreamSource imports are
node-safe, proven by CuelessMkvFixture.test.ts):

```ts
import { describe, it, expect, vi } from 'vitest';
import { shouldAbandonResolvedSeek } from '../lib/faststream/players/MediabunnyTransmuxer';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

describe('shouldAbandonResolvedSeek (post-getKeyPacket belt, fix A2)', () => {
  it('clean current-generation seek proceeds', () =>
    expect(shouldAbandonResolvedSeek(false, false, 7, 7)).toBe(false));
  it('interrupt re-set the abort flag → abandon (V5: 35.7s stale walk resolved post-interrupt)', () =>
    expect(shouldAbandonResolvedSeek(true, false, 7, 7)).toBe(true));
  it('disposed mid-walk → abandon', () =>
    expect(shouldAbandonResolvedSeek(false, true, 7, 7)).toBe(true));
  it('generation bumped by a newer seek → abandon (any mismatch, order-agnostic)', () => {
    expect(shouldAbandonResolvedSeek(false, false, 7, 8)).toBe(true);
    expect(shouldAbandonResolvedSeek(false, false, 8, 7)).toBe(true);
  });
});
```

(Alternative — inline the 3 checks without a helper, as :1598 does today, and skip the unit test.
Rejected: the whole point of A2 is V7's untested corpse-work path; a pinned truth table is ~free.)

---

## Facts a test author must know (gotchas)

1. **No vitest config exists** → node env default; don't assume jsdom. Add
   `// @vitest-environment jsdom` per-file only if DOM is needed (none of these three need it).
2. `_options` is a **private vendored field** — keep the seam-guard assertion (Test 1, first it)
   so a mediabunny bump that renames it fails with a readable message, not a hang.
3. `vi.unstubAllGlobals()` in `afterEach` — fetch stubs leak across tests otherwise.
4. Partial-chunk (`chunk.length < requestedSize`) paths sleep real 100ms (`PARTIAL_RETRY_DELAY_MS`)
   — serve **full-range 206s** per fetch (as the skeletons do) to keep tests instant.
5. `markSeekStart`/probe counters are slated for removal (Issue 4); don't couple tests to them.
   `markSeekResolved`'s `captureNextReadStart` arming stays (VBR anchor) — irrelevant to these tests.
6. The condemn test's "between fetches" case is the INVERSE of today's behavior — land it in the
   same commit as fix A, never before.
