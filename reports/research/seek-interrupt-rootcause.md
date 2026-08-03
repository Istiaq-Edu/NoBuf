# Round-2 fixes — root-cause hypotheses (seek-interrupt + cue-less thumbnail scan)

Companion to `reports/research/round2-log-forensics.md` (log evidence). This doc holds the
DESIGN hypotheses that must be verified before the solution doc. Labels: **VERIFIED** = read in
source / proven by log arithmetic. **HYPOTHESIS** = plausible, needs a research task.

Target branch state: `Embedded-subtitle-extraction`, gates green (tsc 0, vitest 390/26 files,
cargo 178). All line numbers re-checked live 2026-08-02.

---

## ISSUE 1 — superseding seek cannot stop an in-flight cue-less getKeyPacket walk

### Facts (VERIFIED)

- V1. `seekTo` entry: `seekAbortFlag=true` (MediabunnyTransmuxer.ts:1295), `abortInFlight()`
  (:1303), `seekGeneration++` (:1306), flag cleared for the new seek (:1341).
- V2. `interruptSeek()` (:1925-1928) = `abortInFlight()` + `seekAbortFlag=true`. Called from
  useMSEPlayer.ts:9557-9572 via `shouldInterruptInflightSeek` (exported pure helper :699).
- V3. `abortInFlight()` (TauriStreamSource.ts:370-377) aborts only the AbortControllers in
  `inFlightAborts` **at that instant**. Each fetchRange attempt creates a FRESH controller
  (:127-128) and removes it in `finally`. A walk = MANY sequential fetchRange calls (one per
  mediabunny read, 8MB readahead each). Abort landing between two calls = permanently lost.
- V4. `seekAbortFlag` is checked ONLY in the packet iteration loops (:1648, :1742) and nowhere
  between `getKeyPacket` (:1448) and loop entry. mediabunny's internal cluster walk never sees it.
- V5. Log proof of the race: interrupt at 2-c:277-278, then `getKeyPacket took 35706.7ms`
  (2-c:279), 32MB fetched / 48MB consumed (2-c:281), keyframe resolved 1031.03s, init segment
  emitted (2-c:284) — all post-interrupt — then discarded by the gen guard (2-c:286). The
  1155.86s replacement never ran; user closed the player (2-t:320).
- V6. seekTo#2 is SERIALIZED behind seekTo#1: the supersede path waits for the in-flight seekTo
  promise to settle before running the latest target (useMSEPlayer drain on
  `transmuxerSeekInProgressRef`). So while the stale walk lives, the new seek CANNOT start —
  the "interrupt" is the only lever, and it's a no-op if it misses the fetch window.
- V7. No check of `seekAbortFlag`/generation exists after getKeyPacket resolves (:1471-1513):
  a condemned seek still resolves audio, creates Output, and emits an init segment (V5's 152B).

### Design (fix A1 — sticky condemn flag on the stream source)

`abortInFlight()` additionally sets `superseded=true` on the source. `fetchRange` checks it
at loop-top (next to the `disposed` check, :116) and before each retry attempt, throwing the
existing `'[TauriStreamSource] read aborted (superseded by seek)'` error (same path as today's
AbortError mapping :140-144 → caught by seekTo's `isAborted` :1599 → clean null return).
The flag is CLEARED at the next `seekTo` entry, immediately after the `abortInFlight()` call
(:1303) — for the user-drain supersession path (V6: the superseding seek is serialized behind
the drain, so every read issued between condemn and the new seekTo entry is stale).
**Scope (cross-validation R2):** this guarantee covers ONLY the user-drain path. The inverse
topology — a user seekTo superseding an in-flight REFILL seekTo — gets no sticky protection:
refills don't set `transmuxerSeekInProgressRef`, so the user seek executes immediately, condemns
at :1303 and self-clears microseconds later, re-opening today's between-fetch race for the
refill's walk. Accepted residual: harvested-index refills resolve getKeyPacket in 0.2-1.1ms
(forensics §A.1) so the window is ~ms; the A2 belt + generation guard discard the corpse result.
Not closable with one flag+clear (needs per-read epochs through mediabunny's worker).

- H1a (**HYPOTHESIS**): there are no fetches issued BY seekTo itself between :1303 and the clear
  point that could be killed wrongly. Believed true because the clear is synchronous, ~5 lines
  after the condemn, with only `conversion.cancel()` (:1313) possibly awaiting in between — and
  `this.conversion` is believed to be null in the MKV/TS seek path (legacy Conversion API unused
  since the Output/PacketSource rewrite). VERIFY: grep all `this.conversion =` assignments and
  confirm the seek path never sets it; confirm no other await sits in the entry window.
- H1b (**HYPOTHESIS**): a condemned-read throw inside `startPrefetch`'s background fetch is
  swallowed (logged) — does not propagate to onError / unhandledrejection. VERIFY: read
  startPrefetch's catch handling in TauriStreamSource.ts.
- H1c (**HYPOTHESIS**): `createTauriStreamSource` consumers are exactly (a) playback transmuxer
  and (b) TransmuxerThumbnailPipeline. The thumbnail instance never gets `abortInFlight()`
  called → never condemned → unaffected. VERIFY: grep all call sites.
- H1d (**HYPOTHESIS**): mediabunny does NOT internally retry/swallow read errors during
  getKeyPacket walks — a fetchRange throw rejects getKeyPacket promptly. Believed true from the
  existing abort path working when it lands mid-fetch. VERIFY in vendored
  `node_modules/mediabunny/src` (reader / matroska-demuxer error paths).

### Design (fix A2 — post-resolve belt in seekTo)

Right after getKeyPacket resolves (:1477-1480), add: if `this.seekAbortFlag || this.disposed ||
currentGeneration !== this.seekGeneration` → log + `return null`. Prevents V7's corpse work
(audio resolve, Output creation, init emit) when the walk completes despite condemnation
(resolved from warm cache, or raced through). Pure addition; normal seeks unaffected
(seekAbortFlag was cleared at :1341 for the current seek and only an interrupt re-sets it).

### Probe removal (Issue 4, riding along)

trace-27 byte-accounting (`seekSearchActive/Bytes/Consumed`, TauriStreamSource.ts:97-107
counters + :386-389 log; arming call :1446) is confirmed and comes out. KEEP `markSeekResolved`'s
`captureNextReadStart` arming — `clusterByteOfLastSeek` feeds `getLastSeekAnchor()`
(MediabunnyTransmuxer.ts:922-926) which is FUNCTIONAL (VBR anchor).
- H1e (**HYPOTHESIS**): `seekSearchBytes/Consumed` have no consumers outside the probe log.
  VERIFY: grep.

---

## ISSUE 2 — cue-less MKV hover thumbnail = unbounded linear scan

### Facts (VERIFIED)

- V8. captureAtTime MKV path (useThumbnailExtractor.ts:840-875): index binary-search hit within
  `THUMB_INDEX_MAX_GAP=12` (:81, :859) → cheap indexed lookup (:863). MISS (:864-871) or no
  index at all (:872-875) → **native `getKeyPacket(time, verify:true)` on the pipeline's OWN
  mediabunny Input** — on a 0-cue MKV that is a linear walk from its position-cache frontier
  toward the target byte.
- V9. Log proof: hover 3427.71s (2-c:161) with a 4-entry index near 0 → `source_id=thumbnail`
  walked 0→184MB in 8MB chunks for ~103s (2-t:185-319), target byte ≈ 604MB (3427.7/8888.1 ×
  1.566GB), still running at app close. `busy=true` (:823, :838) blocked every later hover.
- V10. The TS path already embodies the correct policy: no byte-offset index → warn + skip
  (:830-836). Cue-less MKV lacks the equivalent.
- V11. The pipeline learns playback's harvested keyframes via `updateKeyframeTimestamps`
  (:707-712), pushed by the effect at :1888-1911 gated on `mseGetters.keyframeIndexReady` —
  which flips only when the transmuxer has a partial/full index (useMSEPlayer:2966, 9463).
  Before first harvest (hover early in a session) the pipeline has NO index → :872 branch →
  native scan. So the guard cannot rely on the pushed index existing.

### Design (fix B — cue-less capture guard in the pipeline)

The pipeline must know the file is cue-less MKV, then: index covers hover (≤12s gap) → indexed
capture as today; otherwise → warn-once + `return false` (tooltip degrades to time-only, exactly
the TS precedent). Never native-scan a cue-less file.

- H2a (**HYPOTHESIS**): the cleanest source of cue-lessness is the pipeline's own mediabunny
  Input at init time — the same API the playback transmuxer uses to fill `mkvCueIndex`
  (MediabunnyTransmuxer.ts:209 gets it from somewhere — locate the producer). If the vendored
  mediabunny exposes cue points per-track/Input, the pipeline can self-detect with zero
  cross-hook plumbing. VERIFY: find how mkvCueIndex is populated; check the API is usable from
  TransmuxerThumbnailPipeline.init() without extra network cost (cues live in the already-read
  metadata tail; seedData/header should cover it).
- H2b (fallback design if H2a fails): plumb `isCuelessMkv()` from the transmuxer through
  mseGetters (pattern exists: getKeyframeTimestamps :10102-10106) into the pipeline via a
  setter next to updateKeyframeTimestamps. Downside: arrives only when the effect fires
  (keyframeIndexReady) — too late for the pre-harvest hover (V11). If used, ALSO gate the
  no-index branch (:872) for format==='mkv' pessimistically… messy. Prefer H2a.
- H2c (**HYPOTHESIS**): capture of a HARVESTED timestamp with `verifyKeyPackets:false` (:863) on
  the thumbnail's own cold Input is bounded by the hover time's byte position (walk from cache
  frontier / start toward ~playhead byte, warm after first capture) — acceptable cost, no
  regression vs today. VERIFY reasoning against vendored matroska-demuxer position-cache
  behavior (the same mechanism the refill-stall research mapped).

---

## Test seams (for the plan)

- H3a (**HYPOTHESIS**): pure-helper extraction is the established test pattern —
  `shouldInterruptInflightSeek` (useMSEPlayer.ts:699) has its own test file
  (`__tests__/decideSeekDispatch.test.ts` or similar). New helpers follow suit:
  `decideMkvCaptureStrategy(timestamps, time, maxGap, cueless)` → 'index'|'native'|'skip'
  (pipeline), and the source-level condemn logic tested via the source instance.
- H3b (**HYPOTHESIS**): TauriStreamSource is unit-testable in vitest by stubbing global.fetch and
  driving the vendored CustomSource read path (or the attached `(source as any)` helpers).
  VERIFY: how CustomSource exposes reads (vendored mediabunny custom-source), what existing
  tests mock (MpegtsChunkLoader.backpressure.test.ts mocks fetch?).

## Explicitly out of scope this round

- Issue 3 (cold cue-less far-seek = bandwidth-bound walk) — re-measure after fixes 1+2.
- PROACTIVE to-EOF prebuffer contention — pre-existing design, separate discussion.
- Cue-INDEXED MKV / TS / MP4 / remux tiers must be provably untouched (house rule).
