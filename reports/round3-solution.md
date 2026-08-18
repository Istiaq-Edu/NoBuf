# Round-3 solution — audio-switch stutter, bounded subtitle extraction, far-hover bisection

**Build-ready consolidation.** Sources: `reports/research/round3-log-forensics.md`,
`round3-rootcause.md`, `round3-self-verify.md`, `round3-verify-{a-audioswitch,b-subs,c-bisect}.md`,
`round3-crossvalidation-review.md` (fresh-eyes; verdicts A SHIP / B SHIP-with-MUST-R1 / C SHIP).
R1 was independently re-derived by the orchestrator before adoption (is_range_cached =
contiguous full coverage; :753-764 is a whole-request pre-body 503). All MUSTs and adopted
SHOULDs are folded in below. Line anchors verified live 2026-08-03; plan uses grep anchors.

Symptom → fix map (user's round-3 reports):
| Symptom | Fix |
|---|---|
| Small stutter on audio switch | A (A-1 reorder + A-2 harvested boundaries) |
| Subtitle never appears after selecting | B (B-1..B-4 bounded partial extraction) |
| Hover thumbnail missing (far positions) | C (C-1..C-4 cluster bisection + injection) |

---

## FIX A — audio-switch stutter (frontend only)

**A-1 Reorder `_switchMkvAudioTrack` (useMSEPlayer.ts, grep `_switchMkvAudioTrack`).**
Today: flush (`resetForSeek`) → optional `changeType` → transmux (`seekTo`) → append. The
playhead sits on zero data for the whole sequence (forensics: all 4 switches, no network).
New order (verify-a H-A1c constraint table, independently re-derived by reviewer R6):

1. UNCHANGED: `seekGen` capture → `stopStreamingChain()` → state resets →
   `bufferingForSeekRef=true` → `seekBufferRef=[]` (all MUST precede seekTo).
2. `stopTime` + `await transmuxer.seekTo(t, SEEK_START_DURATION, {skipInitSegment:false, stopTime})`
   — FIRST, old buffer keeps playing; segments land in `seekBufferRef`.
3. `bufferingForSeekRef=false` → supersession check (bail with buffer INTACT) →
   null-keyframe escalation (escalate with buffer INTACT — strictly better than today).
4. R6 (adopted): `changeType(newMime)` BEFORE the flush when plan==='rebuild-changetype'.
   Failure → in-place revert: discard seekBuffer, `setDesiredAudioTrack(null)`,
   `startStreamingChain()`, return false — old track keeps playing (kills the pre-existing
   dead-player latent found in verify-a H-A1d). If the revert itself returns null → escalate
   to /remux like the null path.
5. `resetForSeek()` → `seekOffsetRef=kf` → `setTimestampOffset(kf)` → append captured
   segments → `startStreamingChain()`. No-data window shrinks to flush+append (~ms).

**A-2 Harvested-index fallback in boundary helpers (MediabunnyTransmuxer.ts).**
`nextKeyframeAtOrAfter` and `snapToCueKeyframe` consult only `mkvCueIndex` → on cue-less files
every stopTime is Infinity/undefined → switch stops mid-GOP → first refill re-resolves the SAME
keyframe behind the playhead and replaces coded frames at the playhead (4/4 switches in logs).
Fallback when `mkvCueIndex.length===0`: binary-search `this.keyframeTimestamps` (sorted+deduped
— self-verify H-A2b, four write sites re-verified by reviewer R8):
- `nextKeyframeAtOrAfter`: first harvested ts STRICTLY > time; **clamp** — if found > time+25
  (HARVEST_BOUNDARY_CLAMP_S, mirrors REFILL_MAX_DURATION_CAP) return null (gappy-harvest guard;
  post-far-seek gap query hits the clamp → null → today's maxDuration fallback, R8-verified).
- `snapToCueKeyframe`: same neighbor-compare within 0.25s on the harvested array.
- R7 (adopted): gate BOTH fallbacks on `this.config.format === 'mkv'` (class is format-agnostic;
  TS scanner populates keyframeTimestamps; 3 direct-instantiation test suites all pass format:'mkv').
Effect: switch seekTo gets a real boundary → ends ON a keyframe → post-switch refill abuts with
zero overlap (round-1 mechanism finally engages on cue-less files); refills too.
Window growth bounded (R8): stopTime bypasses maxDuration for the video cut → worst ≈29s
transmux vs 8s today, cache-served in the stutter scenario (≤~200ms); acceptable, disclosed.
R9 (disclosed, no action): cold-switch playhead may outrun the appended window → brief spinner
+ first refill self-heals; today's order stalls harder for the same duration.

Cue-INDEXED MKV / TS / MP4 / remux tiers: untouched (cue path short-circuits; format gate;
only MKV(avc) instantiates this class — H-A2c re-verified, the FastStreamPlayer.tsx:251-258
comment claiming otherwise LIES and must not be trusted).

## FIX B — subtitle bounded partial extraction (Rust + minimal frontend)

Root cause (verified + arithmetic): not-fully-cached file → extraction input is
`/stream?...source_id=subs` with NO bound → ffmpeg demuxes the whole 1.47GB at Telegram speed
(1.39MB/s measured) ≈ 16min ≫ 120s timeout → doomed 504, UI shows nothing; extraction outlives
player close (actix runs handler futures to completion after disconnect — PROVEN by verify-b's
actix harness; frontend AbortController would be useless) and blocks cache deletion ≤120s.

**B-1 `cached_prefix` param (MUST R1 — three server elements, NOT two):**
1. `StreamQuery`: new `cached_prefix: Option<bool>`.
2. Pre-body: when set, BYPASS the `cached_only` initial-503 (grep `CACHED_ONLY: msg`) AND the
   coordinator subscribe/spawn section — a subs read must never spawn a Telegram download.
   (`cached_only` semantics stay byte-identical for its existing senders: TSByteOffsetScanner
   bulk chunks, TauriStreamSource 503 handler.)
3. Body: capture the flag before `async_stream::stream!`; gate the frontier poll-wait (grep
   `STREAM-CACHE-WAIT] waiting`) and the Telegram fallback entry so the body ENDS at the cache
   frontier. End-shape = verify-b's CUT/CLEAN shapes: ffmpeg exits 0 with all prefix cues
   (96/96 in fixture); reopen requests get short/empty bodies and die the same way.
**B-2 Extract call site** (grep `subs_input_source(&folder_id_str` in `subtitles_extract_track`
only): append `&cached_prefix=1` when `!fully_cached`. Probe (needs EOF tail) and font endpoints
share `subs_input_source` and stay unbounded — do NOT touch the shared helper.
Also: add `X-Subs-Partial: 1`-equivalent signal to the 204 zero-cue response when
`!fully_cached` (R5: frontend copy "no cues yet").
**B-3 `-flush_packets 1`** in `build_sub_extract_args` (belt: output survives even SIGKILL —
fixture: 90 cues at t=25s vs 0 without; makes future timeout-salvage possible).
**B-4 Frontend:** `fetchEmbeddedSubText` returns `partial` (header already read); cache entry
in `toggleEmbeddedSub` remembers partial-ness; re-selecting a partial track re-extracts against
the (larger) prefix and REPLACES the cached SubtitleTrack (R5: today's `.get(idx)` early-return
would freeze the first partial forever); 204-partial toast says "no cues yet". 429 in-flight +
single retry flow unchanged (R5-verified OK now extraction is seconds). No AbortController.

Fixture re-run bundled with implementation (R1): python frontier mock of the NEW end-shape
(prefix bytes → clean close; reopen → empty close) + real ffmpeg → expect exit 0 + prefix cues.

## FIX C — far-hover thumbnail via cluster bisection + cache injection (frontend)

Design (verify-c: **pre-built into mediabunny** — `InternalTrack.clusterPositionCache`
{elementStartPos, startTimestamp}[] is exactly the walk-start structure `performClusterLookup`
binary-searches; organic inserts are sorted-spliced; sparse entries are the design):

**C-1 Bisection** (`useThumbnailExtractor.ts` co-located exports, pure parts unit-tested):
byte-space binary search: probe mid → fetch bounded window (1-2MB, geometric grow on no-find)
via plain `fetch` Range reads on `this.streamUrl` + EXPLICIT `&source_id=thumbnail` (R11: the
MP4 precedent URL carries no source_id; append it) → sync-scan `1F 43 B6 75` → validate
(EBML vlen size plausible OR unknown-size marker; child-WALK to 0xE7 — CRC-32 0xBF is commonly
first (R11); ticks within bisection bracket) → recurse until last cluster with time ≤ T.
~11 probes for 1.46GB. Seed lo-bound from guarded `segment.clusterSeekStartPos ?? dataStartPos`
reach-in (R11 — skips header region, satisfies verify-c residual 7).
**C-2 Injection:** guarded reach-in `(videoTrack as any)._backing.internalTrack.
clusterPositionCache` (readMkvCuePointCount style; sink/track identity verified R11) —
sorted-splice `{elementStartPos: byte of the Cluster ID first byte, startTimestamp:
Math.round(seconds * segment.timestampFactor)}` mirroring the organic insert (dedup by
elementStartPos-at-index). Any shape drift → degrade to today's skip.
**C-3 captureAtTime skip-branch becomes:** consult existing clusterPositionCache first (R10:
entry within [T−35s, T] → skip bisection, straight to capture — kills re-bisecting adjacent
buckets and reuses organic entries) → else bisect (memoized) → inject → `captureNative(T)`
(getKeyPacket now walks ≤1-2 clusters) → on null keyPacket back off one probe step once
(verify-c risk 3); on throw/assert splice the injected entry back out and skip (risk 4).
**C-4 Skip/busy memoization:** per-bucket state (inflight | done | failed) so processLoop stops
hammering a skipped bucket (forensics: 36 retries @ ~250ms); failed buckets retry only after
the keyframe index/anchor state changes or a cooldown.

Cost: cold far hover ≈ 10-22MB bounded reads (~7-15s at Telegram speed, memoized; warm/cached
instant). No unbounded scans anywhere; cue-indexed files never enter this path (guard already
routes them to the index).

## Residuals accepted (disclosed, no action this round)
- R9 cold-switch brief spinner (self-healing, better than today).
- R3: post-close extraction lives ≤120s worst case via tokio timeout + kill_on_drop (was
  framed as unbounded; bounded-input fix shrinks to seconds anyway).
- R4 stale timeout comments/log in poll loop — fix the warn line while editing that region.
- 3615ms updateend during round-3's user seek (watch round 4); PROACTIVE-to-EOF contention.

## Gates
`npx tsc --noEmit` = 0 · `npx vitest run` all green (baseline 415/31 + new suites) ·
`cargo test --no-default-features` (baseline 178) · cargo build (Tauri codegen) ·
B fixture re-run (ffmpeg vs frontier mock) · then user e2e via tauri dev (Inception MKV:
audio switch ×4, subtitle select on partial cache, far hover, plus cue-indexed/TS/MP4 sanity).
