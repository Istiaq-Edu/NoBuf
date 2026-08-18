# Round-2 plan — sticky seek condemnation + cue-less thumbnail guard

**Execute after reading:** `reports/seek-interrupt-solution.md` (authoritative design; MUSTs from
`reports/research/round2-crossvalidation-review.md` already folded in).

Repo: `D:\DEVELOPMENT\Telegram-Drive`, branch `Embedded-subtitle-extraction`. Frontend-only.
Terminal is git-bash: use `/d/DEVELOPMENT/Telegram-Drive/...` paths; run node commands from `app/`.

**Gates (run from `app/`):**
- `npx tsc --noEmit` → exit 0
- `npx vitest run` → baseline **400 tests / 28 files** green (no `--reporter=basic` — flag doesn't exist)
- `cd src-tauri && cargo test --no-default-features` → 178/178 (run once, Task 6 — Rust untouched)

**House rules:** surgical diffs only; cue-INDEXED MKV / TS / MP4 / remux tiers byte-identical;
single-file lint output from the editor is NOISE — only the gates above are authoritative.
Anchors below are GREP STRINGS (line numbers are hints only — they drift, especially after Task 3).
TDD per task: write test → run, confirm RED → minimal code → run, confirm GREEN → commit.

**Task order is load-bearing:** T1/T2 are pure helpers (safe first), T3 shifts line numbers
(before T4's source edits), T4 is ONE commit (sticky flag + transmuxer clear MUST land together —
`seekTo` itself calls `abortInFlight()` at entry, so a tree with the flag but no clear kills every
2nd seek), T5 wires fix B.

---

## Task 1 — `decideMkvCaptureStrategy` helper + truth table (fix B logic)

Files: `app/src/hooks/useThumbnailExtractor.ts`, NEW `app/src/__tests__/decideMkvCaptureStrategy.test.ts`

- [ ] 1.1 Write the test file (content: solution doc §Tests #2 / round2-verify-h3-testseams.md §Test 2,
  verbatim — 6 `it` blocks incl. exact-hit, =12 boundary, before-first-keyframe, pre-harvest empty
  index at 3427.71, cueless×miss→skip, cue-indexed×miss→native). Keep the
  `vi.mock('@tauri-apps/api/core', …)` line.
- [ ] 1.2 `npx vitest run src/__tests__/decideMkvCaptureStrategy.test.ts` → RED (import fails — helper missing).
- [ ] 1.3 In `useThumbnailExtractor.ts`, find `export function computeThumbnailSeekTarget` (≈:143),
  read to its closing brace, insert AFTER it:

```ts
/** Fix B (round-2): MKV thumbnail capture strategy. 'index' = harvested-keyframe hit within
 *  maxGap (timestamp is the FOUND ts[lo], never the hover time) → cheap indexed capture.
 *  Miss/empty: cue-indexed MKV keeps today's 'native' getKeyPacket; cue-less MKV → 'skip'
 *  (native getKeyPacket on a 0-cue file is an unbounded linear cluster walk — observed 103s+,
 *  184MB for ONE hover, busy-locking every later hover; the TS path already skips when it has
 *  no index). Pure + exported for unit testing, like the helpers above. */
export type MkvCaptureDecision =
  | { strategy: 'index'; timestamp: number }
  | { strategy: 'native' }
  | { strategy: 'skip' };

export function decideMkvCaptureStrategy(
  timestamps: number[], time: number, maxGap: number, cueless: boolean,
): MkvCaptureDecision {
  if (timestamps.length > 0) {
    let lo = 0, hi = timestamps.length - 1;
    while (lo < hi) {
      const mid = lo + ((hi - lo + 1) >> 1);
      if (timestamps[mid] <= time) lo = mid; else hi = mid - 1;
    }
    if (timestamps[lo] <= time && time - timestamps[lo] <= maxGap) {
      return { strategy: 'index', timestamp: timestamps[lo] };
    }
  }
  return cueless ? { strategy: 'skip' } : { strategy: 'native' };
}
```

  (Binary search reproduces captureAtTime's current `ts[lo] <= time && time - ts[lo] <= THUMB_INDEX_MAX_GAP`
  semantics exactly — do not "improve" boundaries.)
- [ ] 1.4 `npx vitest run src/__tests__/decideMkvCaptureStrategy.test.ts` → GREEN.
- [ ] 1.5 `npx tsc --noEmit` → 0. `npx vitest run` → 400+6.
- [ ] 1.6 Commit: `Add decideMkvCaptureStrategy helper for cue-less MKV thumbnail guard`

## Task 2 — `shouldAbandonResolvedSeek` helper + truth table (fix A2 logic)

Files: `app/src/lib/faststream/players/MediabunnyTransmuxer.ts`, NEW `app/src/__tests__/AbandonResolvedSeek.test.ts`

- [ ] 2.1 Write the test (solution doc §Tests #3 / h3 §Test 3 verbatim — 4 rows; MUST keep the Tauri
  mock line, the transmuxer module imports `invoke`).
- [ ] 2.2 Targeted vitest → RED (missing export).
- [ ] 2.3 In `MediabunnyTransmuxer.ts`, grep `class MediabunnyTransmuxer` (declaration). Insert
  IMMEDIATELY BEFORE it, at module level:

```ts
/** Fix A2 (round-2): post-resolve abandon predicate. True ⇒ this seek was condemned while its
 *  getKeyPacket walk ran (interrupt set seekAbortFlag / dispose / a newer seek bumped the
 *  generation) and must do ZERO further work — see the belt call in seekTo. Pure + exported
 *  for unit testing (house pattern: shouldInterruptInflightSeek et al.). */
export function shouldAbandonResolvedSeek(
  seekAbortFlag: boolean, disposed: boolean, capturedGen: number, liveGen: number,
): boolean {
  return seekAbortFlag || disposed || capturedGen !== liveGen;
}
```

- [ ] 2.4 Targeted vitest → GREEN. `npx tsc --noEmit` → 0. Full vitest → 400+10.
- [ ] 2.5 Commit: `Add shouldAbandonResolvedSeek predicate for post-resolve seek belt`

## Task 3 — trace-27 probe removal (pure deletion; do BEFORE Task 4 so its anchors are final)

Files: `app/src/lib/faststream/utils/TauriStreamSource.ts`, `app/src/lib/faststream/players/MediabunnyTransmuxer.ts`

Delete list (verified no other consumers — round2-verify-h1-source.md §H1e):
- [ ] 3.1 TauriStreamSource.ts — delete the probe comment block starting
  `// PROBE (trace-27): byte-accounting to split a cold seek's cost` (≈:97-104) AND the three vars
  `let seekSearchActive = false;` / `let seekSearchBytes = 0;` (+ trailing comment) /
  `let seekSearchConsumed = 0;` (+ comment).
- [ ] 3.2 Delete line `if (seekSearchActive) seekSearchBytes += chunk.length; // PROBE: count search bytes`.
- [ ] 3.3 Delete the `// PROBE (trace-28): count bytes mediabunny actually REQUESTS` comment block
  + line `if (seekSearchActive) seekSearchConsumed += totalRequested;` (inside `read:`).
- [ ] 3.4 Delete `// PROBE (trace-27): arm search byte-accounting at seekTo entry.` +
  `(source as any).markSeekStart = () => { … };`.
- [ ] 3.5 In `markSeekResolved`: KEEP `captureNextReadStart = true;`; delete the probe half — the
  comment lines `// PROBE: also stop + log the SEARCH byte total …` / `… the reducible portion, vs
  playback bytes after.` and the whole `if (seekSearchActive) { console.log(…SEEK SEARCH fetched…); … }`
  block. Result: `(source as any).markSeekResolved = () => { captureNextReadStart = true; };`
  KEEP the functional comment above it (`// Arm cluster-byte capture: …`).
- [ ] 3.6 MediabunnyTransmuxer.ts — delete the two comment lines
  `// PROBE (trace-27): arm search byte-accounting so markSeekResolved can log` /
  `// how many bytes THIS getKeyPacket read from the cue cluster to the keyframe.` AND the call
  `(this.streamSource as any)?.markSeekStart?.();` (≈:1444-1446, just above the
  `if (useCachedIndex || byteOffsetKeyframe !== null)` getKeyPacket block).
- [ ] 3.7 MUST-KEEP check (grep, expect all still present): `clusterByteOfLastSeek`,
  `captureNextReadStart` (decl + read() capture + markSeekResolved), `getClusterByteOfLastSeek`,
  `getLastSeekAnchor` (transmuxer), `recordByteTimeAnchor` consumer in useMSEPlayer.
- [ ] 3.8 `npx tsc --noEmit` → 0 (catches any missed reference). Full vitest → 400+10 (no test
  references probes). Commit: `Remove trace-27 seek-search byte-accounting probe (confirmed)`

## Task 4 — Fix A1 sticky condemn + A2 belt wiring + rider (ONE commit — see order note)

Files: `app/src/lib/faststream/utils/TauriStreamSource.ts`,
`app/src/lib/faststream/players/MediabunnyTransmuxer.ts`,
NEW `app/src/lib/faststream/utils/TauriStreamSource.condemn.test.ts`

- [ ] 4.1 Write the condemn test (solution doc §Tests #1 / h3 §Test 1 skeleton, post-R6.1 version —
  NO markSeekStart references). Cases: seam guard (`_options.read` is a function); condemn BETWEEN
  fetches rejects; condemn MID-fetch rejects; `resetSupersession()` → next read succeeds;
  re-condemn after reset rejects again; fresh source unaffected. `vi.stubGlobal('fetch', …)` +
  `vi.unstubAllGlobals()` in `afterEach`; full-range 206 responses only (partial chunks hit a real
  100ms retry sleep); fileSize=16 keeps every read to ONE fetch and disables prefetch.
- [ ] 4.2 `npx vitest run src/lib/faststream/utils/TauriStreamSource.condemn.test.ts` → RED
  (between-fetches case: read RESOLVES today — the pinned V3 bug; resetSupersession missing).
- [ ] 4.3 TauriStreamSource.ts — after `let captureNextReadStart = false;` add:

```ts
  // Fix A1 (round-2): sticky supersession. abortInFlight() aborts only the controllers alive
  // AT THAT INSTANT — but a cue-less getKeyPacket walk is a LOOP of sequential fetches, each
  // with a fresh controller, so an abort landing BETWEEN two fetches was silently lost and the
  // condemned walk ran to completion (observed: 35.7s / 48MB zombie, round-2 forensics).
  // Sticky: every fetch attempt after condemnation dies until the next seekTo entry calls
  // resetSupersession(). Per-closure-instance — thumbnail/scan/TS-offset sources are separate
  // instances and are never condemned.
  let superseded = false;
```

- [ ] 4.4 fetchRange — TWO checks (the two `if (disposed) throw …` lines are textually identical;
  disambiguate by context). At WHILE-LOOP TOP (the one directly under `while (pos <= end) {`):

```ts
      if (disposed) throw new Error('[TauriStreamSource] disposed during fetch');
      if (superseded) throw new Error('[TauriStreamSource] read aborted (superseded by seek)');
```

  And inside the attempt loop (the one directly under `for (let attempt = 0; attempt <= MAX_503_RETRIES; attempt++) {`):

```ts
        if (disposed) throw new Error('[TauriStreamSource] disposed during fetch');
        if (superseded) throw new Error('[TauriStreamSource] read aborted (superseded by seek)');
```

  EXACT error text — must match the existing AbortError mapping string so downstream routing
  (seekTo isAborted + the 4.7 rider) is uniform.
- [ ] 4.5 `abortInFlight` — inside the attached function, before the loop over `inFlightAborts`, add:

```ts
    superseded = true; // sticky — survives until the next seekTo entry (resetSupersession)
```

- [ ] 4.6 After the `abortInFlight` attachment block, add:

```ts
  // Fix A1: clear the sticky condemnation for a NEW seek. Called at seekTo entry immediately
  // after abortInFlight() — the new seek's own reads must pass. NOWHERE else.
  (source as any).resetSupersession = () => { superseded = false; };
```

- [ ] 4.7 MediabunnyTransmuxer.ts — seekTo entry: after the line
  `(this.streamSource as any)?.abortInFlight?.();` that sits under the comment block starting
  `// Abort the shared stream source's in-flight fetch.` (seekTo's — NOT interruptSeek's), add:

```ts
    // Fix A1 (round-2): clear the sticky condemnation set by interruptSeek()/a prior entry —
    // THIS seek's reads must pass. Entry is synchronous from here through seekGeneration++,
    // so nothing this seek issues can be condemned. Scope: protects the user-drain supersede
    // path; a user seek superseding an in-flight REFILL self-clears in ~µs (accepted residual,
    // see reports/seek-interrupt-solution.md).
    (this.streamSource as any)?.resetSupersession?.();
```

  interruptSeek (grep `interruptSeek(): void`) gets NO reset — it is the condemner.
- [ ] 4.8 A2 belt — in seekTo, directly after the two lines
  `const keyframeTimestamp = keyPacket.timestamp;` +
  `console.log(\`[Transmuxer] Seek to ${seekTime}s: keyframe at ${keyframeTimestamp}s\`);`
  and BEFORE the comment `// Arm the source to capture the cluster byte …` (`markSeekResolved` arm):

```ts
      // Fix A2 (round-2): post-resolve belt. The walk may resolve AFTER condemnation (warm
      // cache, or the interrupt raced the last fetch). Bail BEFORE any corpse work: arming
      // markSeekResolved here would pair the SUPERSEDING seek's first cluster byte with THIS
      // corpse's keyframe time (corrupt VBR anchor); also skips lastSeekKeyframeTime, harvest,
      // Output creation, audio resolve, and the init-segment emit (V7).
      if (shouldAbandonResolvedSeek(this.seekAbortFlag, this.disposed, currentGeneration, this.seekGeneration)) {
        console.log(`[Transmuxer] Seek abandoned post-resolve (condemned while walking): target=${seekTime.toFixed(2)}s resolved=${keyframeTimestamp.toFixed(3)}s`);
        return null;
      }
```

  Placement is LOAD-BEARING (review MUST 1): above `markSeekResolved()` / `lastSeekKeyframeTime` /
  `addKeyframeTimestamp`.
- [ ] 4.9 Rider (Caveat B): in seekTo's catch, grep `const isExpectedError = e instanceof Error && (`
  and add as the FIRST clause:

```ts
        e.message.includes('read aborted (superseded by seek)') ||
```

- [ ] 4.10 Optional 1-line comment (review SHOULD 6): above `getAudioTracks(` implementation:
  `// Round-2 note: during the ~120ms condemned window (interrupt → next seekTo) reads here can
  // throw the superseded error — caught below, degrades to [] / revert, self-heals at next seekTo.`
- [ ] 4.11 `npx vitest run src/lib/faststream/utils/TauriStreamSource.condemn.test.ts` → GREEN (all 6).
- [ ] 4.12 `npx tsc --noEmit` → 0. Full `npx vitest run` → 400+16, ZERO failures (existing seek/refill
  suites must be untouched). Commit:
  `Make seek supersession sticky + post-resolve belt (kills zombie getKeyPacket walks)`

## Task 5 — Fix B wiring: cue-less detection + capture guard

Files: `app/src/hooks/useThumbnailExtractor.ts`

- [ ] 5.1 Class fields — after `_initInProgress = false;` in `class TransmuxerThumbnailPipeline`:

```ts
  // Fix B (round-2): cue-less MKV ⇒ native getKeyPacket is an unbounded linear walk — captures
  // become index-or-skip. Detected in init() from mediabunny's already-parsed metadata.
  isCuelessMkv = false;
  private warnedCuelessSkip = false;
```

- [ ] 5.2 Helper — after `decideMkvCaptureStrategy` (Task 1), add:

```ts
/** Cue-point count from mediabunny's already-parsed MKV metadata (pure in-memory read — zero
 *  I/O; getPrimaryVideoTrack already ran readMetadata). Reaches vendored internals by the same
 *  convention as MediabunnyTransmuxer.extractMkvCueIndex; null = layout drift. */
export function readMkvCuePointCount(videoTrack: unknown): number | null {
  try {
    const cues = (videoTrack as any)?._backing?.internalTrack?.cuePoints;
    return Array.isArray(cues) ? cues.length : null;
  } catch { return null; }
}
```

- [ ] 5.3 Detection — in `init()`, AFTER the videoTrack null/cancel guard (the block
  `if (!this.videoTrack || !this.active) { … return false; }`) and BEFORE the
  `// Get video codec` comment (review SHOULD 4 — not literally after getPrimaryVideoTrack):

```ts
      // Fix B (round-2): cue-lessness from already-parsed metadata (zero I/O). null (vendored
      // layout drift) ⇒ treated cue-less: extractMkvCueIndex degrades to [] the same way, so
      // playback is ALSO cue-less on drift; a skipped thumbnail beats a 103s busy-locked walk.
      // Cold branch on pinned mediabunny 1.45.4 (shape proven in prod by the transmuxer).
      if (this.format === 'mkv') {
        const cueCount = readMkvCuePointCount(this.videoTrack);
        this.isCuelessMkv = (cueCount ?? 0) === 0;
        if (this.isCuelessMkv) console.warn('[TransmuxerThumbnailPipeline] MKV has no Cues — native-scan captures disabled (index-or-skip)');
      }
```

- [ ] 5.4 captureAtTime — insert the decision BETWEEN the TS branch's closing `}` (after
  `console.warn('[TransmuxerThumbnailPipeline] TS capture skipped — …')` / `return false;` block)
  and `this.busy = true;`:

```ts
    // Fix B (round-2): pick the MKV strategy BEFORE locking busy — a cue-less 'skip' must never
    // block later hovers (the 103s walk also busy-locked every subsequent capture). This region
    // is await-free, so two hovers cannot interleave between decision and busy=true.
    const mkvDecision = decideMkvCaptureStrategy(
      this.keyframeTimestamps, time, THUMB_INDEX_MAX_GAP, this.isCuelessMkv,
    );
    if (mkvDecision.strategy === 'skip') {
      if (!this.warnedCuelessSkip) {
        this.warnedCuelessSkip = true;
        console.warn(`[TransmuxerThumbnailPipeline] Cue-less MKV: hover ${time.toFixed(1)}s outside harvested index — capture skipped (tooltip degrades to time-only; TS-precedent)`);
      }
      return false;
    }
```

- [ ] 5.5 Replace the keyframe-lookup block — from `let keyPacket: EncodedPacket | null;` down to
  the `}` that closes the `} else {` native-fallback branch (the one containing
  `// No keyframe index — fall back to standard getKeyPacket with verification`), i.e. the whole
  old binary-search + two native fallbacks, with:

```ts
      let keyPacket: EncodedPacket | null;

      if (mkvDecision.strategy === 'index') {
        // Harvested-index hit — known keyframe timestamp, verifyKeyPackets:false (the index
        // only ever holds confirmed keyframes). Cold-Input cost is bounded by this timestamp's
        // cluster byte with a hard in-demuxer stop, warms after the first capture, and is
        // typically disk-speed (on cue-less files playback already walked ≤ this byte).
        keyPacket = await this.videoSink!.getKeyPacket(mkvDecision.timestamp, { verifyKeyPackets: false });
      } else {
        // 'native' — cue-indexed MKV: the sparse playback-built index misses this hover (or is
        // empty pre-harvest); mediabunny's full Cues find the real keyframe at `time`. This
        // tier is byte-identical to pre-fix behavior. Cue-less never reaches here ('skip').
        keyPacket = await this.videoSink!.getKeyPacket(time, { verifyKeyPackets: true });
      }
```

  NOTE: the old `keyframeTimestampFromIndex` local DIES here — it must not survive as a
  write-only variable (tsconfig has `noUnusedLocals`; vitest won't catch TS6133).
- [ ] 5.6 Grep check: `keyframeTimestampFromIndex` → ZERO hits in the file.
- [ ] 5.7 `npx tsc --noEmit` → 0. Full vitest → 400+16 green (no new tests — the helper truth table
  from Task 1 covers the logic; the wiring is exercised by e2e).
- [ ] 5.8 Commit: `Guard cue-less MKV thumbnail captures (index-or-skip, no native scans)`

## Task 6 — Final gates + handoff

- [ ] 6.1 From `app/`: `npx tsc --noEmit` (0) && `npx vitest run` (**416 expected**, count printed —
  must be ≥ 400+16, zero failures).
- [ ] 6.2 `cd src-tauri && cargo test --no-default-features` → 178/178 (proves Rust untouched).
- [ ] 6.3 `git log --oneline -6 | cat` → the 5 commits above present, tree clean (`git status`).
- [ ] 6.4 HAND BACK for manual e2e (tauri dev, Inception cue-less MKV). Checklist for the user:
  1. Play → seek far (e.g. ~1036s) → within ~0.5s seek again (~1156s). EXPECT: console shows
     `Seek abandoned post-resolve` OR the condemned walk dying fast (`read aborted (superseded
     by seek)`), and the SECOND target starts within ~1-2s — no 35s zombie, no 48MB corpse fetch.
  2. Fresh session → hover the far timeline (~3400s) BEFORE playing that far. EXPECT: one warn
     `Cue-less MKV: hover … outside harvested index — capture skipped`, tooltip shows time-only,
     NO `source_id=thumbnail` mega-walk in the terminal log, later hovers still respond.
  3. Hover NEAR the played region (≤12s behind a harvested keyframe). EXPECT: thumbnail appears
     (indexed capture path still works).
  4. Sanity on a cue-INDEXED MKV + a TS + an MP4: seek + hover behave exactly as before.

## Pitfalls (read before starting)

- The two `if (disposed) throw` lines in fetchRange are IDENTICAL text — always patch with
  surrounding context (`while (pos <= end) {` vs `for (let attempt …`).
- `abortInFlight` appears in seekTo AND interruptSeek — only seekTo gets `resetSupersession()`.
- Belt (4.8) MUST sit above the `markSeekResolved` arm — that ordering is review MUST 1, not style.
- Error string must be char-exact `[TauriStreamSource] read aborted (superseded by seek)` in all
  three places (existing mapping, two new throws) or the rider/isAborted routing silently misses.
- Windows/MSYS: `cd /d/DEVELOPMENT/Telegram-Drive/app` then run npx; don't chain `git -C /d/...`.
- Editor per-file lint floods (missing Promise/Set) are false — only `npx tsc --noEmit` counts.
- vitest: no `--reporter=basic` flag in this version (exits 1).
