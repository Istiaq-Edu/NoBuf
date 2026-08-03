# Round-2 Log Forensics — post refill-stall fix (2-c.md / 2-t.md, 2026-08-02 15:50–15:54)

File: Inception MKV, 1.46 GB / 8888.136s, **0 cues**, GOP ≈ 10.4s. Session: play from 0 → ~133s,
hover thumbnail at 3427.7s, seek 637.7s (ok), seek 1036.3s (hang), supersede-seek 1155.9s,
user closes player at 15:53:51, app exit.

## A. CONFIRMED FIXED (evidence)

1. **The 25.024s refill stall is gone.** Every refill now resolves from the harvested index:
   `seekTo: using keyframe index — seekTargetTs=20.812s` (2-c:67) and 10 more (86,103,120,144,
   169,186,203,220,250,261). getKeyPacket per refill: 0.2–1.1 ms (was: 3,413 failures at 130 Hz).
   ZERO `Streaming refill failed` lines in the whole log. Breaker/backoff/G1/G2 never needed to fire.
2. **Chain-continue delay formula intact**: ahead=21.5s → `sleeping 2000ms` (2-c:258) —
   min(5000,max(2000,floor(1.5×200)))=2000 ✓.
3. **Warm seek UX**: seek 637.7s click→first-frame = 1035 ms (2-c:259); VBR probe shows
   fetched=56MB consumed=72MB (16MB served from cache/seed) (2-c:239).
4. Audio fix still holding: `audioSkipped=false` on every window; 2-codec SB; zero fatals, zero reroutes.

## B. ISSUES FOUND (ranked)

### ISSUE 1 — CRITICAL: superseding seek does NOT stop an in-flight getKeyPacket walk
**Evidence:** seek 1036.28s starts (2-c:276); +~0.5s user seeks 1155.9s → `Superseding in-flight
seek (gen→3) — interrupting` (2-c:277-278); yet `getKeyPacket took 35706.7ms` (2-c:279) — the walk
ran 35.7s AFTER the interrupt, fetched 32MB network / consumed 48MB (2-c:281), resolved 1031.03s,
emitted a 152B init (2-c:284), and only THEN was discarded by the supersession guard (2-c:286).
The 1155.86 replacement seek started at 2-c:290 and never completed — user closed the player
(2-t:320 `cache-dialog-discard` 15:53:51). **User-visible: ~40s dead spinner → gave up.**

**Root cause (source-verified):** `interruptSeek()` = `seekAbortFlag=true` + `abortInFlight()`
(MediabunnyTransmuxer.ts:1925-1928). `abortInFlight()` aborts only the AbortControllers alive AT
THAT INSTANT (TauriStreamSource.ts:370-377). The cue-less walk is a LOOP of 8MB fetches: each new
`fetchRange` chunk creates a FRESH controller (ts:127-128) that the one-shot abort never saw.
`seekAbortFlag` is only checked per-packet in the ITERATION (which did exit in 0.1ms, 2-c:283) —
mediabunny's internal cluster walk can't see it. So the abort is a race: lands during a live fetch
→ works; lands between chunks → silently lost, walk continues chunk after chunk.

**Fix (small):** make supersession STICKY on the source: `abortInFlight()` also sets
`superseded=true`; `fetchRange` checks it at loop-top/before each fetch and throws the existing
`read aborted (superseded by seek)` error (same path as today's abort → isAborted → seekTo returns
null cleanly); cleared via a NEW `resetSupersession()` called at seekTo entry — immediately
after the `abortInFlight()` at MediabunnyTransmuxer.ts:1303, before `seekGeneration++` (:1306).
[CORRECTED per cross-validation R6.1: an earlier draft said "cleared in markSeekStart() (:1446)"
— wrong twice: markSeekStart is deleted by this same change (Issue-4 probe removal), and :1446
sits AFTER the cold-path reads (:1392-1400), which would run condemned and self-kill the first
seek after an interrupt.]
Belt: in seekTo, bail to null right after getKeyPacket if `seekAbortFlag` is set (skip audio
resolve/init emit for a corpse). ~15 lines + unit test. Thumbnail source unaffected (separate instance).

### ISSUE 2 — CRITICAL: cue-less hover thumbnail = unbounded linear file scan
**Evidence:** hover at 3427.71s (2-c:161). Thumbnail pipeline index had only 4 timestamps near 0
(2-c:79); gap > THUMB_INDEX_MAX_GAP(12) → native `getKeyPacket(3427.7, verify:true)`
(useThumbnailExtractor.ts:870). On a 0-cue MKV that is a LINEAR WALK from the last cached cluster:
`source_id=thumbnail` marched 0MB → 184MB in 8MB chunks over ~103s (2-t:185-319, 15:51:59→15:53:42),
still running at app close. Target byte ≈ 3427.7/8888.1 × 1.566GB ≈ **604MB** — it would have walked
~10 more minutes. Meanwhile it competed with playback + warmer + PROACTIVE (2-t:244-245) for the
3 download workers — **this bandwidth theft is a direct amplifier of Issue 1's 35.7s walk**, which
overlapped it in time. Also `busy=true` for the whole walk blocks every subsequent hover capture.

**Root cause:** captureAtTime's fallback (:864-875) assumes native getKeyPacket is cheap (true for
cue-INDEXED MKV; false for cue-less). The TS path already has the correct pattern: no byte-offset
index → `capture skipped` (:830-836). Cue-less MKV lacks the equivalent guard.

**Fix (small):** the player tells the pipeline once whether the MKV is cue-less
(transmuxer.mkvCueIndex.length===0 && !keyframeIndexBuilt — plumb via the existing
updateKeyframeTimestamps/updateKeyframeData channel). In captureAtTime: MKV + cue-less + hover time
not covered by the index (the :859 check already computes this) → return false with a one-time
warn (mirror :834), instead of falling through to the native scan. Harvested-span hovers still work.
~20 lines + unit test.

### ISSUE 3 — MEDIUM (structural): cold cue-less user seeks are bandwidth-bound linear walks
Seek 637.7s consumed 72MB search bytes (2-c:239) — fine warm (1.0s). Seek 1036.3s consumed 48MB
cold under contention → 35.7s (2-c:281). Without cues this walk is intrinsic to the mediabunny
tier: the position-cache can only start ≤ target, coverage beyond the harvest span requires reading
the file forward. Fixes 1+2 shrink it (interruptible + no thumbnail contention); the remainder is a
TIER-ROUTING tradeoff (e.g. far cold seek beyond harvestSpanEnd on a cue-less file → /remux tier,
which seeks byte-linearly in O(1)). NOT recommending action this round — measure after 1+2 land.

### ISSUE 4 — LOW: probe/log noise
- `SEEK SEARCH fetched=0.00MB consumed=0.00MB` printed for every index-resolved refill (12× here;
  2-c:45,70,89,…): trace-27 probe was to be removed once confirmed — gate it on `!usedIndex` or delete.
- Refill cadence: 5–8× `exceeds cap 30s — sleeping 2000ms` between refills (by design; buffer
  overshoots to ~45s because cap gates refill START while each window delivers a full GOP-quantized
  chunk — bounded, harmless).

### INFO (no action)
- Dev StrictMode double-init (2-c:4-11) — dev-only, first mount torn down cleanly.
- `source_id=subs` whole-file Range requests (2-t:76,81,86) — ffmpeg probing embedded subs; reads
  sparsely then closes; served via cache-prefix. Normal.
- Windows file-lock on cache delete while streaming (2-t:323) — deferred deletion worked; startup
  cleanup removed it next run (2-t:20-21). Handled.
- PROACTIVE spawns a 1.35GB to-EOF sequential download (2-t:244-245) — pre-existing design; another
  bandwidth-contention contributor to Issue 1/3 worth revisiting later.

## C. Recommendation
Fix Issues 1+2 now (both small, both TDD-able, both in already-touched files + useThumbnailExtractor);
re-measure Issue 3 afterwards. Issue 4 probe removal can ride along with Issue 1 (same file).
