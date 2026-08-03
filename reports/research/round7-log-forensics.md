# Round-7 log forensics — 7-c.md (console, 667 lines) / 7-t.md (terminal, 787 lines)

File: Inception 2010 720p (1,566,651,347 B ≈ 1.46GB, 8888.136s, cue-less MKV, avc+aac 2 audio
tracks, GOP ≈ 10.4s from harvested keyframes 0 / 20.812 / 31.24 / 41.625). timestampFactor = 1000
(ticks = ms).

## Timeline

- 7-c:42-125 — prime seek 0 OK (near-start guard: no bisect, `usedIndex=false`), initial buffer
  [0-25.02s], refills via harvested keyframe index (`usedIndex=true`) to 58.52s.
- 7-c:178 — USER SEEK #1: 149.5s (unbuffered, instant).
- 7-c:185 — round-6 Fix A ran: `seekTo bisect: cluster for 149.5s at byte=31859439, ticks=147773
  (1 probes, 2.0MB in 0.3s)`. Probe request 31338737-33435888 was **PREBUFFER HIT: served from
  disk cache** (7-t:174-175).
- 7-c:186-187 — `video getKeyPacket took 342ms` → **`No keyframe found at or before 149.464s`**.
- 7-c:203-212 — `MKV user seek keyframe unresolvable — rerouting to /remux` → transmuxer + both
  TauriStreamSources DISPOSED. MSE tier lost for the session.
- 7-c:209-667 / 7-t:180-772 — the rest of the session runs on the ffmpeg remux (mpegts) tier:
  seeks 3826.3s / 2242.0s / 1484.7s each recreate the player via `/remux?ss=`; aligns land +1.4s
  AHEAD of target (150.8 for 149.5, 3827.7 for 3826.3, 2243.3 for 2242.0, 1486.1 for 1484.7).
  Duration override logs `3133.3s (4Mbps estimate)` — estimate is NOT applied to the UI bar
  (FastStreamPlayer keeps durRef=8888.136 from the MKV phase; estimate path skips setDur).

## Incident 1 (NEW, fatal): round-6 Fix A injection poisons getKeyPacket — "keyframe shadow"

mediabunny `performClusterLookup` (matroska-demuxer.js:1920+) picks
`binarySearchLessOrEqual(clusterPositionCache, target)` — the closest cache entry AT-OR-BEFORE the
target — and walks FORWARD only. `getKeyPacket`'s match requires a block with `isKeyFrame &&
timestamp <= target` inside a walked cluster; the walk breaks at the first cluster starting past
the target.

Arithmetic (this run): injected entry startTimestamp=147773 (147.773s) for target 149464
(149.464s). Last keyframe before target ≈ 145.6s (GOP 10.4s) — BEHIND the injected entry. Walk:
cluster@147.773 (no keyframe ≤ target) → next cluster starts >149.464 → break → bestCluster=null
→ **null** in 342ms (2-3 cluster reads, all disk-cached). Round-5's hover evidence had the answer
cluster 36.8s behind target (4018.639 vs 4055.461) — several GOPs of margin, so the forward walk
always crossed a keyframe. This file's clusters span only ~1-2s, so the round-4 in-buffer advance
lands the injection arbitrarily close to the target — inside the keyframe shadow.

Consequences:
- Pre-round-6 behavior for this seek would have been a slow SUCCESS (linear walk 58.5s→149.5s,
  ~19MB, mostly disk-cached) — Fix A turned it into a fast FATAL and a tier downgrade.
- The injected entry is sticky: any later getKeyPacket(≥147.773s+) picks it again (closest wins),
  so retrying the same seek cannot recover without removing cache entries.
- The hover pipeline calls getKeyPacket through CanvasSink after the same style of injection — the
  same shadow failure applies there on this file (user: hover issues to be handled NEXT round).

## Incident 2 (user question): did the first seek fetch from prebuffer/local disk?

**YES — proven.**
- Bisect probe 31338737-33435888: `PREBUFFER HIT: msg 109 ... served from disk cache` (7-t:175).
- Playback reads at seek time (e.g. 39845888-48234495): `PREBUFFER HIT` (7-t:181).
- Post-reroute remux reads: `CACHE-PREFIX: served 0-50331647 from disk cache` (7-t:187+).
Cache state at seek: 0-47MB on disk (prime + refills + warmer + proactive start). Seek target's
true byte = 31,859,439 (bisect-proven 147.773s ↔ 30.4MB) — inside the cached prefix. The green
bar claiming the point was prebuffered was TRUTHFUL, and Fix B's anchor feed worked: probe cluster
(31859439, 147.773s) was emitted to recordByteTimeAnchor, pinning the bar head near its true time.

## Incident 3 (user complaint): "seek at 10min → prebuffer generation point starts ~8min"

No MSE-tier generation ever happened in this run (incident 1 rerouted before iteration), so the
observed "generation point behind seek point" is a REMUX-TIER artifact: after reroute the
transmuxer's anchor table is gone; the green bar maps cached islands byte→time by file-average
slope. Example from this log: remux seek 3826.3s → ffmpeg's container seek reads from byte
636,900,030 (TRUE mapping 3826.3s ↔ 636.9MB — below file average), but file-average rendering
puts that island start at 636.9/1566.65 × 8888 ≈ 3613s — **~3.6min behind the seeked point**
while actual playback aligned +1.4s ahead. On the MSE tier (post-fix) the generation point is the
keyframe at-or-before target — ≤ 1 GOP (~10.4s) behind, plus Fix B anchors keep the bar accurate.

## Fix (round-7): keyframe-shadow-safe bisection + purge-and-retry belt

A. `bisectSeekTarget` bisects for `target − shadow` instead of `target`, where
   shadow = clamp(2 × max harvested keyframe gap, 12s, 35s), default 15s when <2 keyframes
   harvested. The injected entry then sits BEHIND the last keyframe before the target; the
   forward walk (≤ shadow+35s of mostly-cached data) crosses it and getKeyPacket resolves. The
   near-entry short-circuit checks around the shadowed target for the same reason.
B. Retry belt in seekTo (raw cue-less path): if getKeyPacket still returns null (true GOP larger
   than the estimate, or a pre-existing shadow entry from an old injection/hover),
   `removeMkvClusterPositionsInRange(videoTrack, target−35s, target]` purges the poisoned entries
   (including the failed walk's own organic inserts, which would win the closest-entry race
   again), re-bisect for target−35s, re-ask getKeyPacket ONCE, then fall through to the existing
   fatal reroute.

## Verification

- Unit: computeKeyframeShadowSeconds (default/2×gap/clamps), removeMkvClusterPositionsInRange
  (range semantics, count, missing-cache), removal+findClusterCacheEntryNear integration.
- Gates: `npx tsc --noEmit` 0; full vitest green.
- e2e (user): cold start → no hover → far seek on this file → frame within seconds, NO
  "keyframe unresolvable" reroute; buffered bar starts ≤ ~10.4s (1 GOP) behind the seek point;
  seeks into the cached prefix are served from disk (PREBUFFER HIT).
