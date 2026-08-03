# Round-3 root causes & fix hypotheses — audio-switch stutter / subtitle no-show / far-hover preview

Companion to `round3-log-forensics.md` (log evidence). Labels: **VERIFIED** = re-derived from
live source/logs with citations. **HYPOTHESIS** = plausible, needs subagent/self verification.

Baselines: branch `Embedded-subtitle-extraction` @ dcc0ee3+3 (round-2 fixes in). Gates: tsc 0,
vitest 415/31, cargo 178. File under test: Inception MKV 1.46GB/8888s, 0 cues, GOP ≈ 10.4s.

---

## ISSUE A — audio-switch stutter

### A1 flush-before-transmux ordering — VERIFIED (source)

`_switchMkvAudioTrack` (useMSEPlayer.ts:6284-6410) sequence at :6352-6379:
`stopStreamingChain()` → `bufferingForSeekRef=true` → **`await sbVideo.resetForSeek()` (:6360,
FLUSHES the SB — round-3 logs: ~32s buffered vanish)** → optional `changeType` (:6363) →
`await transmuxer.seekTo(t, …, {skipInitSegment:false})` (:6376) → append seekBuffer (:6403) →
`startStreamingChain()` (:6407).

The playhead has ZERO buffered data from the flush until the post-seekTo appends complete —
window = flush + transmux (15-50ms measured, 3-c:188/248/312/361) + init+segment appends +
queue drain. All 4 round-3 switches were fully cache-served, so this window is the floor, and
it is user-visible.

**Fix A1 (reorder) — HYPOTHESIS H-A1:** run `seekTo` FIRST (segments already route into
`seekBufferRef` — the buffering flag is set before it), keeping the old buffer playing during
the transmux; only THEN `resetForSeek()` → `changeType(newMime)` → `setTimestampOffset` →
append → restart chain. Shrinks the no-data window to flush+append (~ms). Sub-claims to verify:
- H-A1a: `resetForSeek()` semantics permit calling AFTER the transmux with segments pending in
  `seekBufferRef` (it must not clear that ref) — read SourceBufferWrapper.
- H-A1b: MSE `changeType()` with buffered data present is legal & keeps buffered ranges
  (spec + our wrapper), so flush-then-changeType order can stay as flush→changeType→append.
- H-A1c: no other consumer assumes "SB already flushed" between setDesiredAudioTrack and
  seekTo (grep the K-section seek chain for ordering deps).
- H-A1d: on the `reroute-remux`/`reject`/null-keyframe paths the reorder must leave behavior
  identical (flush only happens on the happy path today — confirm).

### A2 cue-less refill boundaries never engage → coded-frame replacement at playhead — VERIFIED (logs+source), fix HYPOTHESIS

- `nextKeyframeAtOrAfter` reads ONLY `this.mkvCueIndex` (MediabunnyTransmuxer.ts:257-266,
  `idx.length===0 → null`); `snapToCueKeyframe` same (:302-319). This file: 0 cues → refill
  stopTime = Infinity (useMSEPlayer.ts:2785 `?? Infinity`), switch stopTime = undefined (:6375).
- Consequence chain (VERIFIED in 3-c, 4/4 switches): switch seekTo stops mid-GOP at
  maxDuration → first refill seeks bufEnd (mid-GOP) → `seekTo` resolves the SAME keyframe
  behind (142.809/155.572/178.261/179.638 — switch-kf == refill-kf every time) → re-transmuxes
  4+s and REPLACES coded frames 0-4s ahead of the playhead (SB [142.81-159.70] 3-c:203 while
  playhead ≈147.1). During steady playback the same replacement happens 20-40s ahead
  (harmless); right after a switch it's at the playhead → decoder hiccup. This is why round-1's
  zero-overlap abutting fix (which killed the ~51s decode crash) never engages on cue-less files.

**Fix A2 — HYPOTHESIS H-A2:** fall back to the HARVESTED keyframe index
(`keyframeTimestamps`, built by round-1 harvest during every iteration) in both helpers when
`mkvCueIndex` is empty:
- `nextKeyframeAtOrAfter`: search harvested timestamps; **clamp** — if the found boundary
  exceeds `time + REFILL_MAX_DURATION_CAP` (harvest can be gappy across far-seek
  discontinuities), return null (today's maxDuration fallback). Without the clamp a gappy
  harvest would make one refill transmux hundreds of seconds, because when stopTime is set
  maxDuration is ignored for the video cut (MediabunnyTransmuxer.ts:1687-1695).
- `snapToCueKeyframe`: harvested fallback is intrinsically safe (0.25s tolerance).
Sub-claims to verify:
- H-A2a: harvested coverage spans the replayed region right after a switch — VERIFIED by logs
  (refills 0→240s all resolved `usedIndex=true`, 3-c throughout) but confirm the switch path
  reads the same index (`findNearestKeyframe` vs cue-only helpers).
- H-A2b: `keyframeTimestamps` is maintained SORTED + deduped (both helpers binary-search).
  Read the harvest insert code. If append-only per-refill with out-of-order user seeks, a
  sorted-insert or sort-on-read is required.
- H-A2c: refill path (useMSEPlayer.ts:2770/2785) and switch path (:6375) both pick up the
  fallback with no other call-site changes; TS path unaffected (keyframeTimestamps exists for
  TS too — helpers are MKV-named but generic; confirm no TS regression: TS refills pass
  stopTime=Infinity today because mkvCueIndex is TS-empty… after the fallback TS would suddenly
  get stopTimes from its scanner-built index. Decide: gate fallback on `format==='mkv'`, or
  prove TS benefits/neutral).

### A3 decoder re-init on switch — inherent, note only

New ftyp+moov (skipInitSegment:false) + changeType ⇒ one audio decoder re-init per switch.
Cannot be removed (codec config differs); with A1+A2 the visible window shrinks to ~flush+append.

---

## ISSUE B — embedded subtitle never appears

### B1 unbounded full-file extraction at Telegram speed — VERIFIED (source+logs+arithmetic)

- `subs_input_source` (server.rs:5855-5872): file fully cached → local path; ELSE →
  `http://127.0.0.1:{port}/stream/...&source_id=subs` — NO `cached_only`, NO byte bound.
- Extraction runs ffmpeg over that URL with `tokio::time::timeout(120s)` (server.rs:6109-6130);
  whole-track policy is deliberate (mid-file -ss over HTTP pathological — P6, :6004-6009).
- Round-3 arithmetic (3-t): start 18:48:22 at cache frontier 144.7MB; subs stream reached
  215.5MB by 18:49:13 exit ⇒ 1.39MB/s ⇒ full 1.47GB ≈ **16 min ≫ 120s timeout** ⇒ the request
  was doomed to 504 (user closed at +51s, before it fired). UI saw nothing.
- Non-zero ffmpeg exit ⇒ output DISCARDED, 502 (server.rs:6131-6148) — even if the tmp file
  already contains every cue ffmpeg parsed before the failure.

**Fix B1 — HYPOTHESIS H-B1 (bounded partial extraction):** when the file is NOT fully cached,
extract from the CACHED PREFIX only, serve as partial (existing `X-Subs-Partial: 1` machinery,
:6187-6188), and let the frontend re-extract later as cache grows. Two candidate mechanisms:
- (i) bounded-read param on the subs /stream URL. [CORRECTED per cross-validation R1: plain
  `&cached_only=true` does NOT produce a frontier-bounded body — the :753-764 check is an
  INITIAL whole-request 503 (fires whenever the range isn't FULLY cached; ffmpeg's first
  request is 0-EOF → instant 503 → DENY shape → exit 8, zero subs). A dedicated
  `cached_prefix` param is required: bypass the initial 503 + coordinator, enter the stream
  body, and gate the body's poll-wait + Telegram fallback so it ENDS at the frontier.]
  NEEDS VERIFICATION: does the srt/ass
  muxer flush cues incrementally to the tmp file, and does ffmpeg exit code / stderr allow
  distinguishing "read error after N cues" (salvageable) from real failure? Likely requires
  server change: on non-zero exit, if tmp file non-empty → serve as partial instead of 502.
- (ii) `-t <cached_frontier_seconds>` / byte-bounded input — worse (needs byte→time mapping).
Preference: (i) + salvage-on-nonzero-exit. Also keep 120s timeout (cached-prefix read is local
disk through actix — seconds).

### B2 zero UI feedback + no progressive growth — VERIFIED (frontend)

`fetchEmbeddedSubText` (useMSEPlayer.ts:6146+) resolves only on completion; selection UI has no
pending/partial state; `X-Subs-Partial` is logged (:6170) but nothing re-extracts later.
**Fix HYPOTHESIS H-B2:** pending state on the selected track while the fetch runs; on partial
result, show cues + schedule a re-extract (trigger: cache-growth signal or timer or next
selection; pick simplest that fits "paused means paused" UX norms — likely: re-extract when the
user re-opens the menu OR when PROACTIVE completes the file; verify what completion signals the
frontend already has).

### B3 extraction not cancelled on player close; blocks cache deletion — VERIFIED (logs), mechanism HYPOTHESIS

3-t:285-295: player closed 18:48:39; six `cmd_delete_cache` attempts through 18:48:47 all
`active streaming — skipping deletion`; subs stream still downloading at 18:49:13 exit (:305);
locked `109.dat` + `remux\subs` survive to next-boot cleanup (:308-311).
**HYPOTHESIS H-B3:** the frontend fetch has no AbortController tied to player teardown, so the
HTTP request stays open; and even if aborted, actix must drop the handler future for
`kill_on_drop(true)` (server.rs:6116) to kill ffmpeg. Verify: (a) no abort wiring in
`fetchEmbeddedSubText`/callers; (b) actix-web drops handler futures on client disconnect (it
does for streaming responses — confirm for in-flight `cmd.output().await`); (c) ffmpeg death →
its /stream connection closes → `source_id=subs` streaming ends → cache deletion unblocks.

---

## ISSUE C — far-hover thumbnail preview on cue-less MKV

### C1 current state — VERIFIED

Round-2 guard works as designed (skip, no scan — 3-c:396, zero thumbnail traffic in 3-t), but
"time-only tooltip" is REJECTED by user: a real frame is required, still with NO unbounded scans.

### C2 cluster bisection — HYPOTHESIS H-C1 (the design)

MKV Clusters start with ID `0x1F43B675` and carry an absolute Timestamp element (0xE7) scaled
by timestampFactor. Without Cues, binary-search the BYTE space: probe mid, fetch a bounded
window (1-2MB), sync-scan for the Cluster ID, read its Timestamp, recurse. ~log2(1.46GB/1MB)
≈ 11 probes ⇒ ~10-22MB bounded reads worst case (cold ≈ 7-15s at Telegram speed; warm/cached
instant; result memoized per region). Then make mediabunny's `getKeyPacket(T)` start its walk
AT the found cluster instead of byte 0 by injecting a synthetic entry into the demuxer's
cluster position cache (round-2 research: the walk starts from the highest cache entry ≤
target — `performClusterLookup`, matroska-demuxer.ts:2201-2383).
Sub-claims to verify (vendored mediabunny source, app/node_modules/mediabunny/src):
- H-C1a: exact internal structure name/shape for the cluster position cache on
  MatroskaDemuxer / segment; how `performClusterLookup` seeds its walk start from it; whether a
  synthetic {clusterByte, clusterTime} entry at a REAL cluster boundary is safe and sufficient
  to bound the walk to ≤1-2 clusters.
- H-C1b: the thumbnail pipeline owns its OWN Input/demuxer (useThumbnailExtractor init) —
  injection must target that instance via a guarded reach-in (cuePoints precedent,
  extractMkvCueIndex MediabunnyTransmuxer.ts:195-215). Confirm reach-in path exists on the
  pipeline's videoTrack.
- H-C1c: bisection correctness on this container: clusters break only on keyframes or 32.767s
  overflow (fixture research) — so cluster start time ≤ T < next cluster start + ~33s bound;
  getKeyPacket(T) from injected start walks ≤ 2 clusters. Also handle: probe window contains
  NO cluster ID (window too small / inside huge cluster) → expand window geometrically.
- H-C1d: EBML parse of Timestamp within a cluster found mid-file is self-contained (no segment
  context needed beyond timestampFactor, which we already extract in extractMkvCueIndex).

### C3 hover-skip busy-loop — VERIFIED (logs), fix trivial

processLoop retried the same skipped bucket ~40× at ~250ms (3-c:396-485). Fix: memoize skipped
buckets (per index/anchor state revision) so a 'skip' decision isn't re-attempted until the
index grows or bisection lands; also covers the bisect-in-flight case (don't re-dispatch while
one runs).

---

## Fix interaction notes

- A2's harvested-fallback also gives the SWITCH path a stopTime (:6375 uses the same helper) —
  switch seekTo then ends ON a boundary, so the post-switch refill abuts with zero overlap:
  A1 (ordering) and A2 (boundaries) compose; neither alone fully kills the stutter.
- C1's bisection could someday serve cold far SEEKS too (Issue 3, round-2 deferred) — keep the
  helper transmuxer-adjacent and pipeline-agnostic, but DO NOT wire it into seekTo this round
  (scope).
- B fixes are Rust+frontend only; A fixes are frontend-only; C is frontend+vendored-reach-in.
  No shared files across A/B; A and C both touch MediabunnyTransmuxer.ts (different regions)
  and useMSEPlayer.ts vs useThumbnailExtractor.ts — implementation order A→C or C→A, B parallel.

## Verification matrix (dispatch)

| Sub | Scope | Deliverable |
|---|---|---|
| V-A | H-A1a-d, H-A2a-c source verification | round3-verify-a-audioswitch.md |
| V-B | H-B1 ffmpeg partial-cue behavior + salvage; H-B3 actix/abort chain | round3-verify-b-subs.md |
| V-C | H-C1a-d mediabunny cluster cache + bisection feasibility | round3-verify-c-bisect.md |
| self | H-A2b harvest sort, H-A1a resetForSeek, B3a frontend abort absence | (parallel, this session) |
