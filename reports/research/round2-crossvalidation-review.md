# Round-2 cross-validation review — sticky condemn + cue-less thumbnail guard

Fresh-eyes review of the consolidated fix design against the 6 research docs and live source.
Branch `Embedded-subtitle-extraction`, all citations re-read from source 2026-08-02. Reviewer had
no prior involvement; every load-bearing claim below was re-derived from the files, not the docs.

---

## R1 — Sticky-clear placement: SOUND (verified, one adjacent note)

- seekTo entry is fully synchronous through the proposed clear point: :1292 disposed-return,
  :1295 `seekAbortFlag=true`, :1303 `abortInFlight()`, then (new) `resetSupersession()`, :1306
  `seekGeneration++`. First await is `conversion.cancel()` :1313 (non-null only on the FIRST MKV
  seek — `this.conversion=` at :519 and :1317 only, matching h1-source's correction). First source
  reads are :1392 `canRead()` / :1398 `getPrimaryVideoTrack()` / :1400 `resolveAudioTrack()` — all
  AFTER the clear. No early return between :1303 and :1448 (the throws at :1393, :1402 land in the
  :1590 catch with the flag already cleared). ✅
- TS byte-offset branch :1370-1380 uses a per-seek `createOffsetTauriStreamSource` — separate
  closure, never condemned; TS-without-index (:1389) uses `this.streamSource` and is covered by the
  entry clear. ✅
- Other entry points: `startTransmuxing` (:1189) has **zero callers** in app/src (only a comment at
  useMSEPlayer.ts:7318 explaining why it must not be called) — dead for MKV; ignore.
  `_buildKeyframeIndexMediabunny` :743 uses its own `scanSource` (H1c #2) — never condemned. The
  refill path calls `transmuxer.seekTo` (useMSEPlayer.ts:2798), never iterates the source directly. ✅
- Condemn with NO subsequent seekTo (user closes player): remaining reads are prefetch (swallowed,
  :211-214) or a main read (throws → :1590 catch). `dispose()` performs no reads. Permanently
  condemned idle source is inert. ✅
- **Note (info):** between interrupt and the drain's superseding seekTo (~120ms+), a user opening
  the audio menu hits `getAudioTracks()` (:1837) on the condemned source → possible condemned throw
  → caught :1863 → returns `[]`. Transient, self-heals at next seekTo. Worth a code comment.

## R2 — Refill chain cannot clear the condemn prematurely: VERIFIED, but a sibling gap exists

- Premature-clear scenario is impossible: during an in-flight USER seek the chain is already dead —
  `executeTransmuxerSeek` called `stopStreamingChain()` (:9302) at that seek's entry (gen bump kills
  pending setTimeouts at :3069/:3085; in-flight refill bails at :2810). The chain restarts only in
  the success commit (:9444), which the interrupt's gen bump (:9571) blocks via the supersession
  guard (:9342). Other seekTo callers (:6376 audio switch, :7335 prime) stop the chain first / run
  pre-seek. So no refill seekTo can fire between `interruptSeek()` and the superseding user seekTo. ✅
- The gen bump at :9571 also prevents the interrupted seek's null branch from firing the G1
  `/remux` reroute (:9479) — guard at :9342 returns first. Load-bearing and intact. ✅
- **GAP (must-document, not must-code):** the inverse topology — a user seekTo superseding an
  in-flight REFILL seekTo — gets no sticky protection. Refills don't set
  `transmuxerSeekInProgressRef` (:9227/:9492 only), so `decideSeekDispatch` executes the user seek
  immediately; its entry condemns (:1303) and self-clears microseconds later, leaving only today's
  one-shot abort for the refill's in-flight getKeyPacket walk. If that abort lands between fetches,
  the zombie walk survives until its next per-packet/gen check or the A2 belt. rootcause.md's claim
  "every read issued between condemn and the next seekTo entry is stale BY DEFINITION (V6) … the
  sticky window is exactly right" **overclaims** — V6 serialization covers only the user-drain path.
  Exposure is small post-round-1 (refills resolve from the harvested index in 0.2-1.1ms, forensics
  §A.1; belt+gen discard the corpse) and is not closable with one flag+clear (the source cannot
  distinguish the zombie's next read from the new seek's — would need per-read epochs through
  mediabunny's worker). Accept + scope the claim so round-3 forensics doesn't chase a ghost.

## R3 — A2 belt placement: must be pinned ABOVE :1486

- Between getKeyPacket (:1448/:1451) and :1479 sit only the near-zero retry (:1459-1467) and the
  null check (:1471-1477) — no side effects. But :1486-1495 have three:
  1. `markSeekResolved()` :1486 arms `captureNextReadStart` — a condemned seek arming it makes the
     SUPERSEDING seek's first read captured as `clusterByteOfLastSeek` paired with the CONDEMNED
     seek's `lastSeekKeyframeTime` (:1487) — a corrupt VBR anchor. (In practice the superseding
     seek re-arms and overwrites before the commit path reads :9389, so it's latent — but the belt
     exists precisely to stop corpse work; don't create new corpse state.)
  2. `lastSeekKeyframeTime` :1487 — same pairing hazard.
  3. `addKeyframeTimestamp` :1494 — harmless (a condemned seek's keyframe is still a real keyframe;
     sorted+deduped insert), skipping is fine either way.
- **Verdict:** belt goes after the :1471-1477 null check, BEFORE :1486. The design says "~:1479
  after the null check" — correct, but the constraint "before :1486-1495" is load-bearing and must
  be explicit in the plan; "skips audio resolve, Output creation, init-segment emit" undersells it.
- Belt predicate vs refills: `stopStreamingChain()` calls `abortSeek()` (:2687) → sets
  `seekAbortFlag` → an in-flight refill resolving after a chain stop is correctly abandoned; its
  null return is absorbed by the chain-gen bail (:2810). No false abandons for healthy refills
  (flag cleared at :1341, gen matches). ✅

## R4 — Fix B decision placement: SAFE; mapping clean; formats correctly scoped

- :817-:838 is fully synchronous (busy check :823, bucket :825-826, TS branch :830-836,
  `busy=true` :838). A pure sync decision inserted before :838 introduces no await → two rapid
  hovers cannot interleave; 'skip' returns before busy is ever set (and the TS skip precedent
  :830-836 also returns pre-busy — consistent). ✅
- 'index' decision timestamp === today's `ts[lo]` (:860); sole consumer is the getKeyPacket call
  :863 (`keyframeTimestampFromIndex` is never read after :863 — verified :840-957). Drop-in. ✅
- Non-MKV: TS exits at :830; mp4/unknown never construct the pipeline (useThumbnailExtractor
  :1784-1787). Detection is gated `format==='mkv'`; all other formats keep `isCuelessMkv=false`
  → decision degenerates to today's index/native branch exactly. MP4 native path untouched. ✅
- :859's boundary semantics (`ts[lo] <= time && gap <= 12`) are reproduced by the truth table
  (exact-hit, =12 boundary, before-first-keyframe rows all present). ✅

## R5 — Detection timing: OK with one placement correction

- "Immediately after getPrimaryVideoTrack() (:762)" is one line too early: the null/cancel check is
  :763-769. Detection on a null track sets `isCuelessMkv=true` pointlessly (init returns false
  anyway) — harmless but sloppy; place it after :769.
- Metadata unreachable (network error): getPrimaryVideoTrack throws → init catch :804-810 → ready
  stays false → captureAtTime unreachable (:823). Clean skip. ✅
- Field default `false` = behave-as-today before/without detection. ✅
- Cue inheritance verified in vendored source: tracks with 0 cues inherit the cue-richest track's
  list (matroska-demuxer.ts "distribute the cue points" block), so video `cuePoints.length===0`
  ⇔ whole-file cue-less — matches the transmuxer's `mkvCueIndex.length===0` gate (:1645). ✅

## R6 — Cross-doc contradictions (3 found)

1. **Clear-point location — forensics vs design (MUST fix docs).** round2-log-forensics.md §B.1:
   "cleared in `markSeekStart()` (already called at every seekTo entry, :1446)" and
   round2-verify-h3-testseams.md Test-1 preamble ("if the fix instead clears inside markSeekStart,
   s/resetSupersession/markSeekStart/"). Both are wrong TWICE: (a) markSeekStart is DELETED by the
   Issue-4 probe removal in the same change; (b) :1446 is not "seekTo entry" — it sits after the
   :1392-1400 reads, which would run condemned on cold paths (first-seek-after-interrupt would
   self-kill). The consolidated design (clear at :1303, before :1306) is correct; purge the stale
   text so an implementer can't follow it.
2. **null cue-count mapping (resolved in favor of the h2 doc).** h2 says null (shape drift) →
   cue-less; the earlier self-note argued null → 'native'. h2 is right for THIS codebase: on drift,
   `extractMkvCueIndex` also degrades to `[]` (:211-214), so playback itself behaves cue-less
   (`nearestCueKeyframeAtOrBefore`/`nextKeyframeAtOrAfter` return null) — thumbnails matching
   playback's degraded mode is consistent; and the failure asymmetry (skipped thumbnail + warn vs
   103s busy-locked walk) is decisive. Pinned vendored 1.45.4 makes the branch cold anyway
   (`_backing.internalTrack.cuePoints` verified in src AND dist).
3. **Helper location — h2 doc vs consolidated design (resolved).** h2 proposes a new shared
   `utils/mkvCues.ts` consumed by transmuxer + pipeline; the design keeps both helpers exported
   from useThumbnailExtractor.ts and leaves the transmuxer untouched. The design wins (house rule:
   cue-indexed MKV tier provably untouched; single consumer; hook-file export precedent :116/:143)
   — but note the docs disagree, so the plan must state the final location explicitly.
   Minor staleness, no action: forensics §B.2 still sketches the H2b plumbing that H2a obsoleted;
   rootcause header says "390/26" vs actual 400/28 (h3 already corrects it); isExpectedError cited
   as :1602-1607, actual :1601-1606.

## R7 — Test designs: VALID, two nits

- **Test 1 "condemn BETWEEN fetches" is valid.** read(0,16) with fileSize=16 → `ensureBufferCovers`
  → ONE `fetchRange(0,15)`; the while-loop-top check (:115) runs before the FIRST fetch attempt, so
  a pre-set condemn rejects before any network call — exactly the closed V3 window. Pre-fix this
  resolved (spike-pinned) → the assertion inverts with the fix. ✅
- hangingFetch attaches its abort listener synchronously inside the stub's promise executor;
  fetchRange passes `signal` at :137 before awaiting → mid-fetch abort test is sound. ✅
- Full-range 206s avoid the real 100ms PARTIAL_RETRY sleep; prefetch disabled by
  `afterEnd >= fileSize` (:205). No fake timers needed. `vi.unstubAllGlobals()` in afterEach ✅.
  Co-location precedent confirmed (`MpegtsChunkLoader.backpressure.test.ts`); no vitest config →
  node env ✅. Tauri mock required for Tests 2/3 (transmuxer imports `invoke` at :38;
  useThumbnailExtractor imports `MSEGetters` from useMSEPlayer — value-form import, so keep the
  mock exactly as the skeletons do) ✅.
- **Nit 1:** Test 2's contract note — implementation must return the FOUND `ts[lo]` in the decision
  (not the hover time); the truth table pins this but the plan should restate it.
- **Nit 2:** strike Test 1's "s/resetSupersession/markSeekStart/" fallback line (see R6.1).

## R8 — Blast radius: CONTAINED

- `abortInFlight` callers: exactly MediabunnyTransmuxer.ts:1303 + :1927 (grep, app/src). ✅
- fetchRange consumers: main read chain (:302/:333 → rethrow when !disposed :305/:339 → seekTo
  catch :1590) and `startPrefetch` (:209-214, silently caught). `ensureBufferCovers`'s
  prefetch-await path resolves null on a condemned prefetch and falls through to a direct
  fetchRange → same throw path. No other consumer. ✅
- Thumbnail pipeline (useThumbnailExtractor.ts:738), scan source (:743), TS offset sources
  (:1370/:994), the disk warmer (raw fetch loop, source_id=warmer, useMSEPlayer :6969+) and
  subtitle probing (backend ffmpeg) never touch the playback source instance. ✅
- No Tauri invoke anywhere in these paths (TauriStreamSource uses bare `fetch`; transmuxer's
  `invoke` is diag logging only :43). Frontend-only confirmed. ✅

## R9 — Probe-removal delete list: SAFE (simulated)

- Deletions (:105-107, :188, :259, :378-379, :386-389, transmuxer :1444-1446) reference only
  `seekSearch*`/`markSeekStart`, which nothing in the keep list touches. `markSeekResolved`
  survives as `{ captureNextReadStart = true; }` (:384-385, :390); its keep-chain
  (read() capture :273-276 → `clusterByteOfLastSeek` → `getClusterByteOfLastSeek` :393 →
  `getLastSeekAnchor` :922-926 → useMSEPlayer :9389-9390) is closed and self-contained. ✅
- One interplay worth stating in the plan: the sticky loop-top check is inserted "next to the
  disposed check :116" — write the patch against post-deletion line numbers.

## R10 — Ship verdict: YES, with the changes below

The design is correct where it matters: clear point verified synchronous, error routing reuses the
existing aborted-seek path end-to-end (H1b/H1d re-verified in vendored source — orchestrator
rejects pendingSlices :2005-2014, no retry for CustomSource, demuxer walk catch-free), state
isolation airtight, fix B mirrors the TS precedent with provably untouched cue-indexed/native
tiers, and the tests pin the exact inverted behavior.

### MUST (before implementation)
1. **Pin the A2 belt above :1486.** State explicitly: belt after the :1471-1477 null check and
   BEFORE `markSeekResolved()`/:1487/:1494, so a condemned seek never arms the VBR-anchor capture
   or writes `lastSeekKeyframeTime`. (R3)
2. **Purge the stale clear-point text.** forensics §B.1 "cleared in markSeekStart() … :1446" and
   the h3 Test-1 markSeekStart fallback both point at a function the same commit deletes, at a
   location AFTER cold-path reads (:1392-1400) — an implementer following them ships a broken clear.
   Clear = `resetSupersession()` at :1303 before :1306, full stop. (R6.1)
3. **Scope the sticky-window claim.** rootcause §A1's "every read between condemn and the next
   seekTo entry is stale by definition" holds only for the user-drain supersession path (V6). A
   user seekTo superseding an in-flight REFILL seekTo self-clears at entry and re-opens the
   between-fetch race for that refill's walk (bounded: harvested-index refills resolve in ms; belt
   + gen guard discard the result). Document as an accepted residual with the R2 reasoning. (R2)

### SHOULD
4. Move isCuelessMkv detection after the videoTrack null check (:763-769), not literally after :762. (R5)
5. Fix the plan's helper-location ambiguity: both helpers live in useThumbnailExtractor.ts (h2's
   `mkvCues.ts` proposal explicitly rejected), and `decideMkvCaptureStrategy` returns the found
   `ts[lo]` timestamp. (R6.3, R7)
6. Add a one-line code comment on `getAudioTracks`/`setDesiredAudioTrack`: transient condemned-window
   failures degrade via existing try/catch (empty list / revert) and self-heal at the next seekTo. (R1)

### NICE
7. Log one line when the loop-top check kills a condemned walk (round-3 log legibility).
8. Extra Test-1 case: re-condemn after resetSupersession (interrupt → clear → interrupt) to pin
   re-entrancy.
9. Consider an early condemned check before the near-start retry (:1459-1467) — micro-saving only.
