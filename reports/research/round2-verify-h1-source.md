# Round-2 verification — H1a / H1b / H1c / H1e (sticky-condemn source design)

Verifies hypotheses from `reports/research/seek-interrupt-rootcause.md` §ISSUE 1 by direct
source reading. Branch `Embedded-subtitle-extraction`, lines re-checked 2026-08-02.

---

## H1a — no wrongly-killed fetch between seekTo entry and the sticky-clear point

**Verdict: VERIFIED** (with one factual correction to the hypothesis text; design unaffected).

Evidence — the seekTo entry window is fully synchronous up to the clear point:

- MediabunnyTransmuxer.ts:1291 `async seekTo(...)`; :1292 `if (this.disposed) return null` (sync).
- :1295 `this.seekAbortFlag = true` (sync).
- :1303 `(this.streamSource as any)?.abortInFlight?.()` (sync — TauriStreamSource.ts:370-377 is a
  plain loop over `inFlightAborts`, no await).
- **Clear point = a new line right after :1303, before `this.seekGeneration++` at :1306.**
  Between :1291 and that point there are exactly three synchronous statements (:1292, :1295,
  :1303). Zero awaits, zero reads → nothing seekTo issues can be sticky-killed in the window.
- First await after the clear point is `await this.conversion.cancel()` at :1313; first
  source READ after it is `await this.input.canRead()` (:1392) / `getPrimaryVideoTrack()`
  (:1398) / `resolveAudioTrack` (:1400); getKeyPacket calls are at :1448 / :1451 (+ near-zero
  retry :1463); probe arm `markSeekStart` at :1446. All AFTER the clear → never condemned.
- seekAbortFlag lifecycle confirmed: set :1295, cleared :1341 — clear point sits before both
  :1341 and every getKeyPacket call.

Correction to the hypothesis's belief ("`this.conversion` is null in the MKV/TS seek path"):

- `this.conversion =` assignments: MediabunnyTransmuxer.ts:519 (`await Conversion.init(...)`
  in `init()`, **MKV/non-TS path only** — TS returns early at :407-413 before :519) and :1317
  (`= null` in seekTo after cancel).
- So on the **first MKV seek** `this.conversion` IS non-null (set at :519, executed by
  `startTransmuxing` :1225/:1256) and `await this.conversion.cancel()` at :1313 genuinely
  awaits. Every subsequent seek finds it null (:1317; nothing re-assigns it). For TS it is
  always null.
- **Design impact: none.** :1313 is after the clear point, so the sticky flag is already off
  during that await. Worst case during the first-MKV-seek cancel await: a dying-conversion
  read escapes condemnation — identical to today's behavior (abortInFlight at :1303 already
  aborted its in-flight fetch).

---

## H1b — condemned-read throws: prefetch is swallowed; main read lands in seekTo's catch

**Verdict: VERIFIED.**

Prefetch path (background):

- `startPrefetch` (TauriStreamSource.ts:204-215):
  `prefetchPromise = fetchRange(start, end).then(data => ({data,start})).catch(() => { prefetchPromise = null; return null; })` (:209-214).
- The `.catch` is attached at creation → the chain resolves to `null` on ANY error. No log, no
  rethrow, no onError, no unhandled-rejection window. A sticky throw inside a prefetch dies here.
- Consumer `ensureBufferCovers` awaits the already-caught chain (:226-236): `result === null` →
  skips buffer install, falls through to a direct `fetchRange` (:240-247). Silent degradation.

Main read path (mediabunny CustomSource.read):

- `fetchRange` throw propagates via `ensureBufferCovers` (:243, no try) into `read`'s
  try/catch at :301-306 — rethrown when `!disposed` (:305); or via the tail-fill loop's
  try/catch :332-340 — rethrown when `!disposed` (:339). Sticky-condemned ≠ disposed → rethrow.
- The `disposed` swallow-to-partial branches (:304, :318-325, :338) do NOT apply to sticky.
- The read rejection propagates through mediabunny to the awaited
  `videoSink.getKeyPacket(...)` (:1448/:1451), which sits inside seekTo's try block
  (:1349) → caught at MediabunnyTransmuxer.ts:1590-1615.
- In that catch: `isAborted = this.seekAbortFlag` (:1599). The condemned walk belongs to the
  OLD seekTo whose flag was set by the interrupt (:1295 or interruptSeek :1926) and is not yet
  cleared (the superseding seekTo's :1341 runs only after the old promise settles — the
  documented serialization, useMSEPlayer.ts:9540-9542). → suppressed at :1608-1609, clean
  `return null` :1614. onError is only reached in the else branch (:1611-1612).
- Corroborating comment for mediabunny propagation (H1d dependency): the interruptSeek doc
  block at :1913-1916 records the observed behavior — the aborted fetch "surfaces as the
  expected 'read aborted' error, caught as isAborted in seekTo's handler → returns null
  cleanly". Full internal-retry audit of vendored mediabunny remains H1d's scope.

---

## H1c — createTauriStreamSource call sites; sticky flag cannot reach thumbnails

**Verdict: VERIFIED** (safety property), with an amendment: **three** call sites, not two.

All call sites of `createTauriStreamSource` in app/src (grep, full tree):

1. MediabunnyTransmuxer.ts:316 — `this.streamSource` (playback instance, created in `init()`).
   **Receives abortInFlight()**: seekTo :1303 and interruptSeek :1927 (the only two callers of
   `abortInFlight` in app/src; both target `this.streamSource`). Sticky condemnation applies
   here — as intended.
2. MediabunnyTransmuxer.ts:743 — `scanSource`, a local instance inside
   `_buildKeyframeIndexMediabunny` (:734-784), disposed in its `finally` (:782). Never exposed;
   **never receives abortInFlight** → never condemned. (This is the instance the hypothesis
   enumeration missed.)
3. useThumbnailExtractor.ts:738 — the TransmuxerThumbnailPipeline's OWN instance
   (`const source = createTauriStreamSource(this.sourceConfig)` inside `init()`, wrapped in its
   own Input :742). grep for `abortInFlight` in useThumbnailExtractor.ts: **zero hits** → the
   pipeline never condemns its source; a sticky flag on the PLAYBACK source (a different
   closure instance) is unreachable from thumbnails.

Note (adjacent, unchanged by the fix): the TS byte-offset seek path uses a per-seek
`createOffsetTauriStreamSource` (MediabunnyTransmuxer.ts:1370; factory TSByteOffsetScanner.ts:975)
whose fetches were never targeted by `abortInFlight` on `this.streamSource` — sticky doesn't
change TS-path behavior either way. Thumbnails also use it (useThumbnailExtractor.ts:994).

---

## H1e — trace-27 probe is removable; markSeekResolved's anchor capture is functional

**Verdict: VERIFIED.**

Consumers found (grep whole app, node_modules excluded; no test files reference any of these):

- `seekSearchActive/Bytes/Consumed` exist ONLY in TauriStreamSource.ts: decl :105-107,
  count-fetched :188, count-consumed :259, reset/arm :379, log+disarm :386-389. Probe-only.
- `markSeekStart` defined :379, sole caller MediabunnyTransmuxer.ts:1446 (comment :1444-1445).
  Probe-only.
- `markSeekResolved` defined :384-390, sole caller MediabunnyTransmuxer.ts:1486. **Dual-use**:
  - :385 `captureNextReadStart = true` — FUNCTIONAL. Feeds read() capture :273-276 →
    `clusterByteOfLastSeek` (:94, :274) → `getClusterByteOfLastSeek` (:393) →
    `getLastSeekAnchor` (MediabunnyTransmuxer.ts:922-926, pairs with `lastSeekKeyframeTime`
    set at :1487) → useMSEPlayer.ts:9389 (sole caller) → `recordByteTimeAnchor(...)` :9390
    (VBR byte↔time calibration anchor for the green prebuffer bar).
  - :386-389 probe log — removable.

Delete list (probe removal):

- TauriStreamSource.ts:97-104 (probe comment) + :105-107 (three vars)
- TauriStreamSource.ts:188 (`if (seekSearchActive) seekSearchBytes += chunk.length`)
- TauriStreamSource.ts:254-258 (probe comment) + :259 (`if (seekSearchActive) seekSearchConsumed += totalRequested`)
- TauriStreamSource.ts:378-379 (`markSeekStart` comment + definition)
- TauriStreamSource.ts:382-383 (the "PROBE: also stop + log" half of the comment) + :386-389
  (the `if (seekSearchActive)` block inside markSeekResolved)
- MediabunnyTransmuxer.ts:1444-1446 (probe comment + `markSeekStart` arm call)

Must STAY (functional VBR anchor chain):

- TauriStreamSource.ts:88-95 (`clusterByteOfLastSeek` / `captureNextReadStart` decls + comment)
- TauriStreamSource.ts:270-276 (capture-on-next-read logic in read())
- TauriStreamSource.ts:380-381, :384-385, :390 (markSeekResolved keeping `captureNextReadStart = true`)
- TauriStreamSource.ts:391-393 (`getClusterByteOfLastSeek` accessor)
- MediabunnyTransmuxer.ts:1482-1486 (markSeekResolved call) + :1487 (`lastSeekKeyframeTime`)
- MediabunnyTransmuxer.ts:920-926 (`getLastSeekAnchor`)
- useMSEPlayer.ts:9389-9390 (anchor consumer → `recordByteTimeAnchor`)

---

## Implications for the fix design (A1)

1. Clear point confirmed: insert `superseded = false`-clearing call immediately after the
   `abortInFlight()` at MediabunnyTransmuxer.ts:1303, before :1306. The entry window is
   synchronous; nothing legitimate can be condemned. (H1a)
2. The sticky throw reuses today's exact error-handling routes: prefetch → silent catch
   (TauriStreamSource.ts:211-214); main read → seekTo catch :1590-1615 → isAborted :1599 →
   null. No new onError/unhandled-rejection surface. (H1b)
3. Sticky state is per-closure-instance; only the playback `this.streamSource` ever gets
   `abortInFlight()`. Thumbnail pipeline (useThumbnailExtractor.ts:738) and the keyframe scan
   source (MediabunnyTransmuxer.ts:743) are separate instances — provably unaffected. (H1c)
4. Probe removal is safe per the delete/keep lists above; `markSeekResolved` must survive in
   reduced form (anchor arming only). (H1e)
5. Residual open item: H1d (mediabunny never swallows read errors mid-getKeyPacket) is
   corroborated by the documented observed behavior at MediabunnyTransmuxer.ts:1913-1916 but
   still needs the vendored-source audit tasked separately.
