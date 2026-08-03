# Round-2 verify — H1d: mediabunny error propagation during getKeyPacket walk

**Hypothesis (H1d):** mediabunny does NOT internally retry/swallow read errors during getKeyPacket
walks — a fetchRange throw rejects getKeyPacket promptly.

## VERDICT: **VERIFIED** (with two flagged caveats, neither blocking the sticky-flag fix)

All paths read live from vendored `app/node_modules/mediabunny/src` (TS source, the one the app
imports) on 2026-08-02. Our source is `new CustomSource({getSize, read, dispose, ...})`
(TauriStreamSource.ts:250-365).

---

## Full error-propagation trace (throw site → getKeyPacket rejection)

1. **Our read callback rethrows.** CustomSource `read` (TauriStreamSource.ts:252) calls
   `fetchRange` at :333; its catch (:334-340) swallows ONLY when `disposed` (returns partial
   buffer, :338) and **rethrows otherwise** (:339). The condemn/abort error is thrown inside
   fetchRange at :140-144.
2. **CustomSource worker loop has no try/catch.** `CustomSource._runWorker` (source.ts:1206-1270)
   awaits `this._options.read(...)` at :1211-1212. No catch → the async function rejects.
3. **Orchestrator rejects, does NOT retry.** `ReadOrchestrator.runWorker` (source.ts:1997-2044):
   `.catch(error)` at :2005-2014 sets `worker.running=false` (:2006), then
   `worker.pendingSlices.forEach(x => x.reject(error))` (:2009) and clears the list (:2010).
   **There is no retry loop anywhere in this path.** (If the worker had NO pending slices it
   rethrows at :2012 → unhandled rejection; see Caveat C.) The `.finally` (:2015-2043) only
   respawns *queued* reads as fresh workers — fresh `options.read` calls, not replays of the
   failed promise.
4. **Rejection reaches the awaiter.** The rejected pendingSlice belongs to the promise created via
   `promiseWithResolvers` in `ReadOrchestrator.read` (source.ts:1793), returned through
   `result = promise.then(...)` (:1890-1894) → `CustomSource._read` (:1174-1203) →
   `Reader.requestSlice` (reader.ts:29-65; `_read` call :48, `.then` :51-57 propagates rejection)
   → `requestSliceRange` (reader.ts:67-104).
5. **Demuxer walk has no try/catch.** `performClusterLookup` (matroska-demuxer.ts:2201-2383):
   `await slice` at :2282 (header read) and `await demuxer.readCluster(...)` at :2314 throw
   straight out. `readCluster` (:595-728) likewise has no catch around its awaits (:601, :618-623,
   :630). `resync`/`searchForNextElementId` (ebml.ts:680, :712) contain zero try/catch (grep: 0).
   The only try/catch in the whole demuxer is a rotation-normalization guard
   (matroska-demuxer.ts:1378-1382) — unrelated.
6. **Sink propagates.** Backing `getKeyPacket` (matroska-demuxer.ts:2087-2112) returns
   `performClusterLookup` directly. `EncodedPacketSink.getKeyPacket` (media-sink.ts:235-260)
   awaits it with no catch (:244 / :247). Its recursion (:256) and the faulty-cue-point re-lookup
   (matroska-demuxer.ts:2367-2375) run only on SUCCESS paths — never as error recovery.
7. **Transmuxer catches.** Rejection lands in `seekTo`'s catch
   (MediabunnyTransmuxer.ts:~1590-1615): `isAborted = this.seekAbortFlag` → logged
   "Seek canceled/disposed (expected during seek)" → `return null`.

**Retry machinery exists only for `UrlSource`**: `DEFAULT_RETRY_DELAY` (source.ts:626-664) is
wired via `UrlSourceOptions.getRetryDelay` and used inside UrlSource's read machinery
(source.ts:917-926). `CustomSourceOptions` has no retry knob at all (constructor validates only
getSize/read/dispose/maxCacheSize/prefetchProfile, source.ts:1131-1154). → **prompt rejection, no
internal retry, no hang.**

---

## Q1 — Any layer that catch-and-retries or catch-and-nulls?

**No.** Only three catch sites touch the path:
- TauriStreamSource.ts:334-340 — rethrows unless `disposed` (dispose-only null-ish return, by our
  own design, :304 and :318-325).
- source.ts:2005-2014 — converts worker failure into pendingSlice rejections (propagation, not
  swallowing).
- MediabunnyTransmuxer.ts:1590+ — the intended final consumer.
`null` returns from `Reader.requestSlice*` happen only for out-of-bounds reads (reader.ts:34-40)
or EOF-truncated slices (source.ts:2172, :2187, :2232 resolve(null)) — size-driven, not
error-driven. A `null` slice makes the walk `break` cleanly (matroska-demuxer.ts:2283), returning
bestCluster/null — that's the EOF path, not the error path.

## Q2 — Does a mid-walk throw poison the demuxer/Input for the NEXT seek? (persistent-MKV Input)

**No poisoning in the seek path.** All demuxer state mutated by the walk is written only AFTER the
awaited reads succeed:
- `segment.lastReadCluster` — assigned at matroska-demuxer.ts:726, the last line of `readCluster`,
  after all awaits. A throw leaves the previous (fully valid) cluster in place. The :596-598 memo
  therefore never serves a half-built cluster.
- `clusterPositionCache` — inserted at :719-722 inside the per-track loop (:649-724), which runs
  only after the full cluster slice was fetched (:630) and parsed synchronously (:645,
  `readContiguousElements` operates on in-memory bytes; a network throw cannot interrupt it).
  **No half-written entry is possible.** Dedup by elementStartPos at :717.
- `demuxer.currentCluster` (:640) — set post-await; and it is a parse cursor only (used by the
  sync element handlers :1449-1505), never consulted by `performClusterLookup`, which uses its own
  local `currentCluster` (:2214). Inert even if stale.
- ReadOrchestrator: the failed worker stays in `workers[]` (only URL-source paths call
  `onWorkerFinished`, source.ts:589/943/954), but with `running=false`, `pendingSlices=[]` it is
  (a) LRU-evictable (:1951-1977) and (b) safely re-runnable — `checkHoleAgainstWorker`
  (:1902-1931) re-kicks it with a **fresh** `options.read` from `worker.currentPos`. Bytes cached
  from iterations that completed BEFORE the throw (`supplyWorkerData` :2081-2154) are real data —
  reusable, not poison.

**Caveat A (flagged, currently unreachable in our flow):** the two `??=`-cached promises on the
Input DO cache rejections forever: `readMetadataPromise` (matroska-demuxer.ts:241, :321) and video
`decoderConfigPromise` (:2388, :2441; the latter can itself walk clusters via `getFirstPacket`,
:2452). Neither is ever reset on rejection. In the current transmuxer both settle during `init()`
(canRead/getDurationFromMetadata/getDecoderConfig at MediabunnyTransmuxer.ts:420-430, :982, :998)
**before any seek — hence before any condemn — can occur**, so the persistent-Input path
(:1327-1331) is safe today. RULE FOR THE FIX: a condemned throw must never be able to land inside
the FIRST evaluation of these promises; if init were ever made lazy/seek-triggered for these,
dispose+recreate the Input after a condemned throw instead.

## Q3 — Are read promises deduplicated/shared by offset? Could a rejected promise stay cached?

**No promise cache exists in the CustomSource read path.** The orchestrator caches **bytes only**
(`CacheEntry {start,end,bytes,view,age}`, inserted at source.ts:2087-2093 / :2236+ — only
successfully read data ever enters). Request coalescing is done via workers + pendingSlices
(one-shot resolver objects), and every error path clears them: rejected at :2009 and emptied at
:2010; queued reads (:1677-1682, :1844-1883) are drained by the `.finally` (:2021-2042) into fresh
workers issuing fresh reads. A later seek re-reading the same offset creates a brand-new
pendingSlice/promise. (`Input._sourceCachePromises`, input.ts:130/201-254, is segmented-input/HLS
machinery — not on this path; `_demuxerPromise` input.ts:272 settles at init.) → **A stale
rejection cannot be served to a later seek.**

## Q4 — Why the existing mid-fetch abort works (and why the sticky throw behaves identically)

`abortInFlight()` → `AbortController.abort()` → fetch rejects with AbortError → mapped at
TauriStreamSource.ts:140-144 to `'[TauriStreamSource] read aborted (superseded by seek)'` → the
exact chain in the trace above (no retry layer anywhere) → seekTo catch where
`isAborted = this.seekAbortFlag` is true (interruptSeek set it) → clean null. The sticky-flag
throw uses the same Error, same throw site (fetchRange), same chain — **identical behavior by
construction.**

**Caveat B (pre-existing, narrow race — recommend one-line hardening):** the seekTo catch
classifies via `seekAbortFlag`/generation/disposed/message (MediabunnyTransmuxer.ts:1598-1607).
If a worker's pre-condemn in-flight read rejects LATE (after the next seekTo cleared the flag) and
the new seek had already attached a pendingSlice to that same worker (source.ts:1915-1920 attaches
to running workers; the :2009 reject then rejects ALL its slices), the new seek's getKeyPacket
rejects with the "superseded" message while `isAborted=false` and generation matches → falls into
`onError` → MSE teardown. Microtask ordering (old walk settles before the drain dispatches the new
seek) makes this practically unobserved, and it is equally reachable TODAY. Hardening: add
`e.message.includes('read aborted (superseded by seek)')` to `isExpectedError` (:1602-1607).

**Caveat C (cosmetic, pre-existing):** a failing worker with `pendingSlices.length === 0` (e.g. a
pure prefetch-extension worker caught by abort/condemn) **rethrows** inside a `void`ed promise
chain (source.ts:2004, :2012) → browser `unhandledrejection` console noise. This is exactly the
mechanism our dispose-path comment already documents (TauriStreamSource.ts:318-325). The sticky
flag adds at most one more such log line per condemned walk; no functional impact.

---

## Summary for the fix (A1 sticky condemn flag)

- Error propagation: prompt, single-shot, no retry/swallow/hang — **H1d VERIFIED**.
- Persistent MKV Input survives a condemned mid-walk throw: cluster caches are written
  only-on-success, no rejected-promise caching in the read path. No dispose+recreate needed.
- Do NOT let a condemned throw land in the first evaluation of `readMetadataPromise` /
  `decoderConfigPromise` (both init-time today — keep it that way).
- Recommended rider: add the superseded message to seekTo's `isExpectedError` list (Caveat B).
