# Round-8 log forensics — 8-c.md (console, 431 lines) / 8-t.md (294 lines)

Same Inception MKV (1,566,651,347 B, 8888.136s, cue-less, GOP ~10.4s, avg 176 KB/s).
Round-7 fix CONFIRMED working: both far seeks bisected with shadow=35.0s, resolved keyframes,
ZERO reroutes, zero fatals. Session healthy end-to-end. Remaining findings are latency
inefficiencies + one UX bug (the audio-switch rejection).

## Seek timeline (all succeeded)

| Seek | Bisect | getKeyPacket (walk) | Click→frame | Walk detail |
|---|---|---|---|---|
| 109.6s | skipped (near-entry hit at shadowed 74.6s: organic entry ~48s from prime/refill walk) | 4.05s | 4.24s | ~48→109.6s = 61.6s ≈ 10.9MB, mostly warmer-cached (0-58MB on disk) |
| 3318.1s | 3 probes, 6MB, 4.3s (1 probe PREBUFFER HIT from hover) | 9.28s | 9.41s | injected 3259.089s → kf 3317.94s = 59s ≈ 10.4MB @ ~1.1MB/s |
| 6865.4s | 3 probes, 6MB, 6.0s (cold) | 12.23s | 12.40s | injected 6830.073s → kf 6864.48s = 35.3s ≈ 6.2MB @ ~0.85MB/s (Telegram bootstrap) |

Post-bisect WALK is now the dominant cost (9-12s), not the bisect (4-6s). The walk is
network-bound: it reads shadow-window bytes sequentially through the playback source at
download speed. Proactive downloader keyed off the FIRST probe byte, not the injection byte —
gap start landed AFTER the walk window both times (589.8MB > walk 559-571MB; 1215.1MB > walk
1202.9-1213MB), so the walk trickled at bootstrap speed instead of riding an active download.

## I1 (user Q2): the failed audio switch — E3 refill conflation

8-c:412 / 8-t:253 (15:22:44): `[AUDIO] switch rejected: cold start / seek in progress (E3)`.
User clicked the audio switch at playback ~6887s — no cold start (long past), no user seek in
flight. The E3 guard is `isColdStartBuffering || bufferingForSeekRef.current` — and
**refills** set `bufferingForSeekRef=true` around their whole `transmuxer.seekTo(...)`
(useMSEPlayer ~:2797-2820) so segment callbacks route to seekBufferRef. Normally that window is
~30ms; on this cue-less file post-far-seek refills run 3-5s each (iterations 5162/5332/5030/
3168ms — walk data still downloading) and chain near-immediately ("below threshold — chaining
next refill immediately"), so bufferingForSeekRef is true ~50-70% of wall time → the switch is
rejected most of the time, silently reverting the dropdown. The reject at :412 landed mid-refill
(seekTime=6887.79 iteration 5030ms, :407-:414 bracket it exactly).

The guard is over-broad: a switch during a REFILL is structurally identical to a user seek
during a refill — which this same log shows working three times (seeks #1-3 all landed
mid-chain: seekGen bump + stopStreamingChain condemn the in-flight refill; its stale-generation
guards skip every ref write — the exact machinery built in rounds 1-3). Only cold start and a
USER seek genuinely need to block a switch.

## I2 (user Q1, latency): hover work invisible to the seek — separate demuxer caches

The hover at 3318.1s bisected and injected cluster (byte=562571650, ticks=3290621) — into the
THUMBNAIL pipeline's own Input/videoTrack. `MediabunnyTransmuxer.seekTo` bisects against the
PLAYBACK track's clusterPositionCache. Separate instances, separate caches (verified:
useThumbnailExtractor `this.videoTrack` vs transmuxer's `input.getPrimaryVideoTrack()`).
Consequence in this log: seek #2 to the SAME position re-probed the region from scratch
(4.3s), and its injection landed at 3259.089s → 59s walk, when the hover had already proven
cluster 3290.621s (27.5s walk, keyframe 3317.94 inside — the hover captured it). Purge log line
absent → purged=0 → confirms the playback cache had no entries there (nothing to purge, nothing
to reuse). Hover→click is the most common far-seek gesture; today it double-pays.

Also: bisectSeekTarget's optimistic short-circuit only checks [shadowed−35s, shadowed]; any
entry in (shadowed, target] is unconditionally purged even when it sits BEHIND the true last
keyframe (provably fine to walk from). Conservative-correct, but it forfeits reuse.

## I3 (robustness, latent): adaptive shadow permanently saturated

`computeKeyframeShadowSeconds` takes 2× the MAX consecutive harvested-keyframe gap. Far seeks
insert jump gaps into the harvest (…155.6s → 3317.94s = 3162s gap), so after ANY far seek the
max gap is a jump artifact and shadow = 35s forever — on every file, regardless of true GOP.
On this file 35s is right anyway (first-window artifact gap 0→20.812 → 2×20.8 clamps to 35),
but a 5s-GOP file would still walk 35s windows after its first far seek. Gap filter needed:
only gaps ≤ 60s are GOP evidence.

## Minor/no-action

- 8-c:5-12 double "Initializing MSE player" — React strict-mode dev remount, known artifact.
- 8-c:166 `updateend #12: 2837ms, 778B` — one-off SB queue wait during seek #1 flush; benign.
- 8-t:66-67 `[FMP4-KF] Data file not ready` — expected pre-cache cold path.
- 8-t:275-294 cache-dialog-discard → os error 32 deferred delete → next-startup cleanup ran
  (8-t:20-21). Known Windows lock pattern, by design.
- Hover first-thumb ≈ 26s total (bisect 10.9s + capture walk, network-bound) — user accepted
  hover as fixed; further hover latency work stays deferred.

## Optimality verdict (user Q1)

Correctness/robustness: the ladder (index → optimistic near-entry → bisect+shadow → belt@35 →
reroute) is sound; every rung log-proven across rounds 5-8; nothing in 8-x contradicts it.
Latency: bisect probe count (3) is near log2-optimal with startLo hints. The remaining cost is
walk bytes × network speed. Player-side levers, in value order:
1. Bridge hover↔playback cluster discoveries (I2) — kills duplicate probes AND shortens walks
   on warm regions (seek #2: ~9.4s → ~3-4s, mostly disk-cached).
2. Allow reuse of entries in (shadowed, target] before purging (I2) — walk from the closest
   proven cluster; the round-7 belt already rescues the rare in-shadow miss (bounded ≤ 1 GOP
   wasted walk, then belt purges+bisects@35 exactly as today).
3. Gap-filter the shadow estimator (I3) — no change on this file, prevents saturation on
   short-GOP files.
Not worth it player-side: tightening BISECT_WALKABLE_GAP_BYTES (probe bytes ≈ walk bytes saved,
round-5 tuning stands); median-gap shadow (risks belt round-trips). Next real lever is
BACKEND: point the proactive downloader at the injection byte (walk window rides 3-worker
DownloadPool instead of bootstrap polling) — out of player scope this round, noted for later.
