# Round-2 solution — sticky seek condemnation + cue-less thumbnail guard

**Build-ready consolidation.** Sources: `reports/research/round2-log-forensics.md` (log proof),
`seek-interrupt-rootcause.md` (design + verified facts), `round2-verify-h1-source.md`,
`round2-verify-h1d-mediabunny.md`, `round2-verify-h2-thumbnail.md`, `round2-verify-h3-testseams.md`
(verification), `round2-crossvalidation-review.md` (fresh-eyes review — ship verdict YES; its 3
MUSTs are folded in below). All hypotheses VERIFIED; no INCONCLUSIVE remain.

Branch `Embedded-subtitle-extraction`. Gates baseline: `npx tsc --noEmit` exit 0;
`npx vitest run` **400 tests / 28 files** green; `cargo test --no-default-features` 178/178.
Frontend-only change — no Rust, no Tauri invoke surface touched (review R8).

---

## Problem 1 — supersede can't stop an in-flight cue-less seek walk (log: 35.7s zombie)

User seeked 1036.3s then 1155.9s 0.5s later. Interrupt fired; the condemned getKeyPacket walk ran
**35.7s more** (48MB), resolved, emitted an init segment — then was discarded. The replacement
never ran before app close. Root cause (V3, verified): `abortInFlight()` only aborts controllers
alive at that instant; the walk is a loop of sequential fetches, each with a fresh controller —
an abort landing between fetches is silently lost. `seekAbortFlag` is never checked inside
mediabunny's cluster walk (V4).

### Fix A1 — sticky condemn flag on TauriStreamSource (~15 lines)

`app/src/lib/faststream/utils/TauriStreamSource.ts`:

- Closure-level `let superseded = false;` beside `disposed`.
- `abortInFlight()` (:370-377) sets `superseded = true` in addition to aborting live controllers.
- `fetchRange` checks at while-loop top (beside the `disposed` check) and before each retry
  attempt: if `superseded` → `throw new Error('[TauriStreamSource] read aborted (superseded by
  seek)')` — the EXISTING error text (:140-144), so the whole downstream routing is unchanged.
- New attached helper `(source as any).resetSupersession = () => { superseded = false; }`.

`app/src/lib/faststream/players/MediabunnyTransmuxer.ts` — seekTo entry:

- Call `(this.streamSource as any)?.resetSupersession?.();` **immediately after** the
  `abortInFlight()` at :1303, **before** `seekGeneration++` (:1306). Entry is fully synchronous
  through this point (H1a: :1292/:1295/:1303 only — zero awaits/reads), so nothing legitimate is
  ever condemned. Net effect: reads between `interruptSeek()` and the next seekTo entry die; the
  new seek's own reads pass. **Do NOT clear anywhere else** (an earlier draft's markSeekStart idea
  was doubly wrong — see R6.1).

Why the throw is safe end-to-end (all verified):
- Main read: rethrown when `!disposed` (:305/:339) → mediabunny CustomSource worker has no
  try/catch (source.ts:1211-1212) → orchestrator rejects all pendingSlices, **no retry**
  (source.ts:2005-2014; retry machinery is UrlSource-only) → demuxer walk catch-free
  (matroska-demuxer.ts:2282/:2314) → getKeyPacket rejects → seekTo catch :1590-1615 →
  `isAborted` (:1599, flag still set — drain serialization) → clean `return null`. (H1b + H1d)
- Background prefetch: swallowed by `startPrefetch`'s `.catch` (:209-214) → null → consumer
  degrades to direct fetch. (H1b)
- Persistent MKV Input is NOT poisoned by a mid-walk throw: demuxer caches are written
  only-on-success; no rejected-promise caching in the read path. No dispose/recreate needed.
  (H1d Q2/Q3) Rule preserved: `readMetadataPromise`/`decoderConfigPromise` settle at init(),
  before any condemn can exist — keep it that way.
- Instance isolation: only the playback source ever receives `abortInFlight()` (callers: seekTo
  :1303, interruptSeek :1927 — grep-verified). Thumbnail pipeline source
  (useThumbnailExtractor.ts:738), keyframe-scan source (MediabunnyTransmuxer.ts:743), TS
  offset sources, disk warmer (bare fetch): all separate. (H1c, R8)

**Scope note (R2, accepted residual):** sticky protection covers the user-drain supersession
path. A user seekTo superseding an in-flight REFILL seekTo self-clears at entry (~µs window) —
that refill's walk keeps only today's one-shot abort. Bounded: harvested-index refills resolve
in 0.2-1.1ms; the A2 belt + gen guard discard any corpse result. Round-3 forensics: don't chase
this as a ghost.

### Fix A2 — post-resolve belt in seekTo (+ pure helper)

Export from `MediabunnyTransmuxer.ts` (module-level, beside the class):

```ts
export function shouldAbandonResolvedSeek(
  seekAbortFlag: boolean, disposed: boolean, capturedGen: number, liveGen: number,
): boolean { return seekAbortFlag || disposed || capturedGen !== liveGen; }
```

Call site — **pinned by review MUST 1**: after the `!keyPacket` null check (:1471-1477) and the
`keyframeTimestamp` assignment (:1479), **BEFORE `markSeekResolved()` (:1486)**:

```ts
if (shouldAbandonResolvedSeek(this.seekAbortFlag, this.disposed, currentGeneration, this.seekGeneration)) {
  console.log('[Transmuxer] Seek abandoned post-resolve (condemned while walking)');
  return null;
}
```

A condemned seek must NOT: arm the VBR-anchor capture (:1486 — else the superseding seek's
cluster byte pairs with the corpse's keyframe time), write `lastSeekKeyframeTime` (:1487),
harvest (:1494), create an Output, resolve audio, or emit an init segment. Healthy refills are
never false-abandoned (flag cleared :1341, gen matches); a refill resolving after
`stopStreamingChain()`→`abortSeek()` is correctly abandoned and absorbed by the chain-gen bail
(useMSEPlayer.ts:2810). (R3)

### Rider — Caveat B hardening (1 line)

Add to `isExpectedError` (:1601-1606): `e.message.includes('read aborted (superseded by seek)')`.
Closes the narrow pre-existing race where a late rejection reaches a NEW seek's getKeyPacket via
a shared pendingSlice after flags cleared → would hit onError → MSE teardown.

Known cosmetic (H1d Caveat C, pre-existing): a condemned worker with zero pendingSlices rethrows
into a voided promise → one `unhandledrejection` console line per condemned walk. Accept.

Optional comment (R1 note / SHOULD 6): `getAudioTracks`/`setDesiredAudioTrack` during the
condemned window (~120ms) degrade via existing try/catch (empty list / revert) and self-heal at
the next seekTo.

---

## Problem 2 — cue-less MKV hover thumbnail = unbounded linear scan (log: 103s+, still running at quit)

One hover at 3427.7s with a 4-entry index near 0 → index miss → native
`getKeyPacket(3427.7, verify:true)` on the pipeline's own Input → linear cluster walk toward byte
~604MB; walked 184MB in 103s, `busy=true` blocked all later hovers, stole download workers from
playback the whole time. The TS path already skips when it has no index (:830-836); cue-less MKV
lacks the guard.

### Fix B — cue-less capture guard in TransmuxerThumbnailPipeline

Both helpers exported from `app/src/hooks/useThumbnailExtractor.ts` (house pattern — beside
`resolveKeyframeSegmentMode` :116 / `computeThumbnailSeekTarget` :143; h2's separate-file idea
rejected, single consumer, transmuxer untouched — R6.3):

```ts
/** Cue-point count from mediabunny's already-parsed metadata (in-memory; zero I/O).
 *  null = internals not in the expected shape (vendored-version drift). */
export function readMkvCuePointCount(videoTrack: unknown): number | null {
  try {
    const cues = (videoTrack as any)?._backing?.internalTrack?.cuePoints;
    return Array.isArray(cues) ? cues.length : null;
  } catch { return null; }
}

export type MkvCaptureDecision =
  | { strategy: 'index'; timestamp: number }  // harvested hit → existing :863 path
  | { strategy: 'native' }                    // cue-indexed MKV fallback — tier untouched
  | { strategy: 'skip' };                     // cue-less + miss → TS-precedent skip
export function decideMkvCaptureStrategy(
  timestamps: number[], time: number, maxGap: number, cueless: boolean,
): MkvCaptureDecision;
// Contract: 'index'.timestamp is the FOUND ts[lo] (nearest ≤ time, gap ≤ maxGap) — never the
// hover time. Miss (no ts ≤ time, or gap > maxGap): cueless ? 'skip' : 'native'. (R7 nit 1)
```

Detection — `init()`, **after the videoTrack null/cancel check (:763-769)**, not literally after
:762 (R5 / SHOULD 4):

```ts
if (this.format === 'mkv') {
  const cueCount = readMkvCuePointCount(this.videoTrack);
  this.isCuelessMkv = (cueCount ?? 0) === 0;  // null (layout drift) ⇒ cue-less: matches
  // extractMkvCueIndex's catch⇒[] degrade (playback also behaves cue-less on drift, R6.2);
  // a skipped thumbnail beats a 100s busy-locked walk. Cold branch on pinned 1.45.4.
  if (this.isCuelessMkv) console.warn('[TransmuxerThumbnailPipeline] MKV has no Cues — native-scan captures disabled (index-or-skip)');
}
```

Zero extra network: init() already calls `getPrimaryVideoTrack()` → `readMetadata()` (memoized;
stops at first Cluster, tail-reads Cues via SeekHead), so `cuePoints` is a pure in-memory read.
Cue inheritance means video-track `cuePoints.length===0` ⇔ whole-file cue-less — same definition
as the transmuxer's `mkvCueIndex.length===0` (:1645). (H2a)

`captureAtTime` — compute the decision synchronously **before `this.busy = true` (:838)** (the
:817-838 region is await-free, so no hover interleave — R4); replace the MKV branch tangle
(:847-875):

- `'skip'` → warn-**once** (instance flag; cue-lessness is permanent, unlike TS's transient
  index-absence) + `return false` — busy never set, tooltip degrades to time-only.
- `'index'` → existing :863 path (`verifyKeyPackets:false`) with the decision's timestamp.
- `'native'` → existing :870/:874 native path — **cue-indexed MKV tier byte-identical**.
- Non-MKV: TS exits at :830 before the decision; mp4/webm never construct this pipeline.
  `isCuelessMkv` defaults `false` = behave-as-today. (R4/R5)

Accepted cost (H2c, document don't fix): the FIRST harvested-far indexed capture on a cold
thumbnail Input is O(T_byte) cluster parsing with a hard in-demuxer stop at T's cluster
(latestTimestamp bound), warms the Input for subsequent captures, and is typically disk-speed
(harvest invariant: playback already walked ≤ T). No new bound on the indexed branch.

---

## Issue 4 rider — trace-27 probe removal

Delete (per H1e, verified no other consumers; patch against post-deletion line numbers — R9):
- TauriStreamSource.ts :97-107 (probe comment + 3 vars), :188, :254-259, :378-379
  (markSeekStart), :382-383 + :386-389 (probe half of markSeekResolved).
- MediabunnyTransmuxer.ts :1444-1446 (arm call + comment).

KEEP (functional VBR anchor chain): `captureNextReadStart` decls + read()-capture (:88-95,
:270-276), `markSeekResolved` reduced to `{ captureNextReadStart = true; }`,
`getClusterByteOfLastSeek` (:391-393), `getLastSeekAnchor` (MediabunnyTransmuxer.ts:920-926),
consumer useMSEPlayer.ts:9389-9390.

---

## Tests (TDD — designs verified by spike, 3/3 green then deleted)

1. `src/lib/faststream/utils/TauriStreamSource.condemn.test.ts` (co-located; skeleton in
   round2-verify-h3-testseams.md §Test 1): seam guard (`_options.read` exists), condemn BETWEEN
   fetches rejects (the inverted V3 pin — valid: loop-top check runs before the FIRST fetch),
   condemn MID-fetch rejects (existing mapping kept), `resetSupersession()` → next read succeeds,
   fresh source unaffected. NICE: re-condemn after reset. `vi.stubGlobal('fetch', …)` +
   `vi.unstubAllGlobals()` in afterEach; full-range 206s; node env (no vitest config exists).
2. `src/__tests__/decideMkvCaptureStrategy.test.ts` (§Test 2): truth table incl. exact-hit,
   =12 boundary, before-first-keyframe, pre-harvest empty index (the 3427.71s trace case),
   cueless×{hit,miss} × cue-indexed×{hit,miss}.
3. `src/__tests__/AbandonResolvedSeek.test.ts` (§Test 3): 4-row truth table. Tauri mock line
   mandatory (transmuxer imports invoke).

Order per commit: failing test → confirm fail → minimal code → green → next. The condemn
between-fetches test lands in the SAME commit as fix A1 (it pins inverted behavior).

## Gates & verification

- `npx tsc --noEmit` exit 0; `npx vitest run` ≥ 400+new, all green; `cargo test
  --no-default-features` 178/178 (untouched, run once at end).
- Manual e2e (user, tauri dev, Inception MKV): (1) double-seek far apart within ~0.5s → second
  seek starts within ~1 poll (no 35s zombie; look for the new condemned-walk log); (2) hover far
  timeline early → no `source_id=thumbnail` mega-walk, tooltip shows time-only; (3) cue-INDEXED
  MKV + TS + MP4 sanity: seek/hover unchanged.
