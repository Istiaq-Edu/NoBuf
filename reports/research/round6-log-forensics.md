# Round-6 Log Forensics — first-seek "phantom prebuffer" + second-seek hang

**Logs:** 6-c.md (console, 237 lines), 6-t.md (terminal/Rust, 229 lines). Read line-by-line.
**File under test:** Inception 1.46GB MKV (1,566,651,347 B), duration 8888.136s, **0 cue points** (6-c:32),
2 audio tracks (Hindi 5.1 + English 5.1), 1 sub track. avg bitrate = 1566651347/8888.136 = **176,263 B/s**.
Round-5 fixes (aa42b0c) present: D2 gate confirmed active (no phantom island snap in this session), D1/D3
**never exercised — the user never hovered** (zero `TransmuxerThumbnailPipeline` bisect logs; no
`source_id=thumbnail` reads after init probes at 10:53:57).

---

## Incident 1 — first seek (119.6s): bar said "prebuffered", play took 5.9s

**Console:** 161 (seek unbuffered 119.6s) → 166 (SBW #12 abort-drain 4120ms) → 168
(`getKeyPacket took 5649.3ms, usedIndex=false`) → 174 (keyframe 116.12s) → 190 (**SEEK-TO-PLAY 5888ms**).

**Why `usedIndex=false`:** cue index empty (0 cues) and harvest had only **4 keyframes** (6-c:144),
max ≈ 48.2s (buffer end, 6-c:158). 119.6 − 48.2 = 71.4s ≫ 12s sparse tolerance → miss → raw
`getKeyPacket(119.6, verify=true)` = linear cluster walk.

**Walk cost (6-t):** reads 31.4–35.6MB HIT disk (10:54:23), 35.6–41.9MB CACHE-PREFIX (2MB disk + 4.2MB
network poll). Keyframe 116.116s ≈ byte ~34–36MB. Walk ≈ 4–8MB parse, part network → 5.6s.

**Why the bar showed that point green (the complaint):** before the seek, `byteToTimeTableRef` held ONLY
the baseline seed [(0,0), (1.4661GB, 8888.136s)] → `byteToTime` is pure linear. Disk cache front run was
~0–40MB. Linear: 40MB → 40/1493.9 × 8888.136 = **227s green head**. Reality: local bitrate ≈ 0.31MB/s
(2× file avg — dual 5.1 audio + action scenes), so 40MB ≈ **~125s** of real media. The bar overshot by
~100s (+80%). 119.6s sat inside the green head; the data for it (bytes 34–41.9MB) was only PARTLY on
disk, and even the on-disk part needs a cue-less cluster walk to locate → 5.9s, not instant.

Verdict: **green bar = linear extrapolation over a giant unanchored span.** Anchors only come from
`getLastSeekAnchor` after USER seeks (useMSEPlayer:9419) — refills never record anchors, so before the
first user seek the table is the bare 2-point seed and the whole front cache maps at file-average slope
(which is ~2× off here).

## Incident 2 — second seek (2819.9s): "stuck" = 7-minute silent cluster walk, user killed it

**Console:** 224 (seek unbuffered 2819.9s at ≈10:54:36) → 229 (SBW #28 abort-drain 5442ms) → 230
(`seekTo: reusing persistent MKV Input, seekTime=2819.89s`) → **then NOTHING from the transmuxer, ever.**
Lines 231–237 are teardown (stopStreamingChain via effect cleanup at useMSEPlayer:1046, both
TauriStreamSources disposed) — the user closed the player.

**The smoking gun (6-t):** the mediabunny walk reading 8MB chunks *sequentially* at Telegram speed:

| time | range (source_id=playback) |
|---|---|
| 10:54:36 | 41.9–50.3MB (HIT/subscribe) |
| 10:54:36 | 50.3–58.7MB |
| 10:54:42 | 58.7–67.1MB |
| 10:54:47 | 67.1–75.5MB |
| 10:54:52 | 75.5–83.9MB |
| 10:54:58 | 83.9–92.3MB |
| 10:55:03 | 92.3–100.7MB |
| 10:55:08 | 100.7–109.1MB |
| 10:55:14 | 109.1–117.4MB |
| 10:55:19 | 117.4–125.8MB |

= **83.9MB in 43s ≈ 1.95MB/s.** Target: linear byte for 2819.9s = 496MB; real VBR byte ≈ 0.31MB/s local
≈ **~870MB**. Remaining walk ≈ 750–820MB → **6.5–7.2 minutes** of silent black frame. User waited 46s,
then hit cache-discard 3× (6-t:210–212, 10:55:22–26) and quit (10:55:43).

**Root cause:** round-5's cluster bisection lives ONLY in `TransmuxerThumbnailPipeline` (hover path).
The PLAYER's `MediabunnyTransmuxer.seekTo` has no bisection — on cue-less + harvest-miss it falls to a
raw `getKeyPacket` linear walk. Rounds 4/5 e2e always hovered before seeking (hover bisect injected the
cluster position into the demuxer's position cache; the subsequent seek rode it). This session seeked
WITHOUT hovering → unbounded walk. **The fix must live in the player seek path, not the hover path.**

**Compounding (backend, follow-up):** cmd_report_playback_position(2819.9s) → backend PROACTIVE spawned
a SEQUENTIAL download from the **linear** byte 494.9MB (6-t:193–194) — ~380MB before the real position —
competing with the walk for the 3 DownloadPool workers the whole time.

## Secondary observations (no action this round)

1. **SBW abort-drain 4120ms/5442ms** (6-c:166, 229): tiny queued appends' `updateend` arrived seconds
   after `abort()` during seek teardown. Concurrent with (not additive to) the seek latency. Watch.
2. **Refill byte estimates are linear** (useMSEPlayer:2950–2955): `trackDownloadedRange(linearBytes)`
   feeds `downloadedTimeRanges` — round-trips through the (anchored) `byteToTime` → distorted times.
   Consumer is only re-render triggering + backend report (FSP:318), green bar unaffected. Latent.
3. **cache-discard while streaming** correctly deferred file deletion (os error 32 → next-startup clean).
4. FMP4-KF "data file not ready" at 10:53:50 ×2 — expected cold-start.
5. D2 gate held: no `(B)` phantom anchor was recorded on this transmuxer session (bar overshoot here is
   incident-1's linear mapping, a different mechanism than round-5's island-snap).

---

# Fixes (this round)

**A. Player-side cluster bisection** — in `MediabunnyTransmuxer.seekTo`, when mkv && cue-less && harvest
miss && no byte-offset index: byte-bisect the cluster containing the target (same engine as hover),
inject into the demuxer position cache, then `getKeyPacket` walks only the residual ≤16MB gap.
Engine extracted to `lib/faststream/utils/MkvClusterBisect.ts` (shared by pipeline + player; avoids the
lib→hook→lib import cycle). Expected: 2819.9s seek = 3–5 probes ≈ 5–11MB ≈ **3–8s** instead of 7 min.

**B. Anchor densification for the green bar** —
   (1) ~~refill completions record `getLastSeekAnchor`~~ **REJECTED during implementation**: refills
       resolve inside mediabunny's 32MB Input cache, so the armed `captureNextReadStart` fires on the
       first UNCACHED read — up to 32MB past the true cluster byte → poisoned anchor. Instead:
       **harvest the demuxer's own `clusterPositionCache`** after each seekTo resolve (organic entries
       are inserted by readCluster for every cluster walked/iterated — exact (byte, ticks) ground truth,
       round-3-verified structure). Dedup via a Set in the transmuxer; refill cadence (~10-20s) keeps
       the table dense as playback progresses;
   (2) player bisect probes feed every validated cluster through a new `onByteTimeAnchor` config
       callback on MediabunnyTransmuxer (mirrors round-5 D3 for the hover pipeline);
   (3) hover-pipeline D3 anchors (already wired in aa42b0c).

## Verification

- vitest: existing MkvClusterBisect suite green through the module move (re-exports) + 5 new driver
  tests (synthetic-file bisect, anchor feeding, abort, HTTP-failure, degenerate). **458/458 (33 files)**.
- tsc --noEmit: 0 errors.
- e2e (user): cold start → NO hover → far seek (≥30min) → frame within ~10s, no multi-minute walk;
  green bar head after ~1min of playback ≈ real buffered time (not 2×).

## Implementation notes (final)

- Engine: `lib/faststream/utils/MkvClusterBisect.ts` — helpers moved verbatim from
  useThumbnailExtractor (which now re-exports them; test imports unchanged) + new
  `bisectMkvClusterSearch` driver (the round-5 loop, parameterized: probeUrl, shouldContinue,
  onClusterFound, injectable fetch) + new `readMkvClusterPositions` (organic cache snapshot).
- Fix A wiring (`MediabunnyTransmuxer.seekTo`, no-index else-branch only): gated
  `format==='mkv' && mkvCueIndex.length===0`; near-start guard (`targetTicks ≤ 35s·factor` — the
  initial prime seeks to 0 through this path); `findClusterCacheEntryNear` short-circuit (organic
  or previously-injected entry near target ⇒ walk already bounded — refills and audio-switch
  rebuilds hit this, zero probes); `source_id=seek-bisect` (distinct from playback/thumbnail so
  the coordinator's zombie-cancel can't cross-fire); abandon-check after the await
  (shouldAbandonResolvedSeek belt, same as post-resolve).
  Note the cached-index path needs NO bisect: a harvested keyframe only exists where a previous
  iteration ran, and readCluster inserted organic cluster positions along that whole path.
- Fix B wiring: `TransmuxerConfig.onByteTimeAnchor` → useMSEPlayer `recordByteTimeAnchor`
  (monotonicity-guarded table). Sources: (1) `harvestClusterAnchors(videoTrack)` after every
  seekTo iteration (organic clusterPositionCache snapshot, Set-deduped by byte); (2) every
  validated bisect probe cluster via onClusterFound.
