# Round-3 log forensics — 3-c.md / 3-t.md (2026-08-02 18:46–18:49)

File: same Inception MKV, 1.46GB (1,566,651,347B) / 8888.136s, **0 cues** (c.31), GOP ≈ 10.4s.
Session: play 0→~240s, user seek 139.5s, **4 audio switches**, select embedded subtitle,
2 far hovers (2062.6s / 1873.3s), close player ~18:48:39, app exit 18:49:13.

## Round-2 fixes: CONFIRMED WORKING in these logs

- Sticky condemn / belt: no zombie walks anywhere; the one user seek (139.5s) completed in
  **393ms click→frame** (c.144). No `Streaming refill failed`, no stale-walk mega-fetches.
- Cue-less thumbnail guard: far hover triggered `native-scan captures disabled` (c.78) and
  `capture skipped` (c.396) — **zero** `source_id=thumbnail` walks in 3-t (the 103s/184MB scan
  from round 2 is gone). Warn-once worked (single warn line).
- Harvest/refills: every refill resolves from index in 0.1–1ms (`usedIndex=true` throughout).

## ISSUE A — audio-switch stutter (user-visible, 4/4 switches)

Switch timeline (all 4 identical in shape; #1 shown):
- c.176 `setDesiredAudioTrack(3)` at t≈147.1s; c.177 stopStreamingChain (`_switchMkvAudioTrack`).
- c.181-188: rebuild seekTo(147.10) → kf **142.809** (4.29s behind playhead), skipInit=false,
  init segment 1128B (c.187), iteration 11.5ms, total 14.7ms.
- The rebuild does `resetForSeek()` (FLUSH of [136.14–179.61s] ≈ 32s buffered) BEFORE seekTo —
  so from flush until the buffered append + queue drain, the playhead (~147.1) has NO data.
- c.189-193 chain restart; c.194-202 refill #1: seekTo(147.14) → kf **142.809 AGAIN** —
  re-transmuxes the exact 4.3s just appended and **replaces coded frames at/just ahead of the
  playhead** (SB [142.81-159.70] c.203).
- VERIFIED 4/4: switch-kf == first-refill-kf every time: 142.809 (c.184/198), 155.572
  (c.244/258), 178.261 (c.308/322), 179.638 (c.357/371).

Two stutter mechanisms, both structural (not network — all 4 switches were fully cache-served):
1. **Flush-before-transmux**: SB is flushed BEFORE the (fast, 15-50ms) rebuild transmux runs,
   then init append + segment appends + drain — the no-data window at the playhead is the whole
   sequence. The transmux could run FIRST into seekBufferRef (bufferingForSeek routing already
   exists) with the old buffer still playing, then flush+append in one short step.
2. **Post-switch overlap replacement**: cue-less `nextKeyframeAtOrAfter`/`snapToCueKeyframe`
   consult ONLY `mkvCueIndex` (empty) → switch seekTo gets no stopTime (stops mid-GOP) → refill
   seeks bufEnd (mid-GOP) → resolves the SAME keyframe behind → zero-overlap abutting (round-1
   fix #1) never engages on cue-less files. During steady playback the replaced range sits 20-40s
   ahead (invisible); right after a switch it is 0-4s from the playhead → decoder hiccup.
   The harvested keyframe index (round-1) COVERS the replayed region — it can supply the same
   boundaries the cue index would (with a distance clamp: harvest can be gappy across
   far-seek discontinuities, so a boundary > pos+maxDuration must fall back to maxDuration).

Also inherent (cannot remove): one audio-decoder re-init per switch (new ftyp+moov via
changeType path) — but with 1+2 fixed the visible window shrinks to flush+append (~tens of ms).

## ISSUE B — embedded subtitle never appears after selection

- Selection at 18:48:22 (t.243-244: ffmpeg spawn + `source_id=subs` request `0-1566651346`).
- Cache frontier at that moment: **144,703,487B** (t.249 CACHE-PREFIX serves 5831–144703487,
  "remainder from poll") ≈ 144.7MB of 1566.7MB.
- ffmpeg's demux read crawls behind the PROACTIVE fill at Telegram speed: STREAM-CACHE-WAIT
  lines t.258-284 show ~1.05MB per ~500-600ms. At app exit (18:49:13) the subs stream was at
  offset **215,482,368** (t.305 fallback error on shutdown).
- Arithmetic: 215.5−144.7 = 70.8MB in 51s = **1.39MB/s** → remaining 1351MB ≈ **16.2 minutes**.
  SRT packets are interleaved across the whole container → full-file demux is required for a
  COMPLETE extraction. The extract HTTP request never resolved → **no `[SUBS] track extracted`
  log ever fired** (frontend fetch at useMSEPlayer :6163-6170 logs on completion/error only) →
  UI showed nothing. User closed the player; extraction kept streaming (nobody cancelled it):
  t.285-295 six `cmd_delete_cache` attempts fail with `active streaming — skipping deletion`,
  and the locked `109.dat` + `remux\subs` files survive to next-startup cleanup (t.308-311).
- NOTE: `X-Subs-Partial` header handling EXISTS in the frontend (:6170) — a partial/progressive
  server mechanism is at least partially designed; why the server still streams to EOF (no
  cached-only bound, no windowing) needs the Rust-side read.

Three sub-problems: (B1) extraction is unbounded full-file at Telegram speed — needs a
bounded/progressive strategy (e.g. extract cached prefix now → partial cues + grow later);
(B2) zero UI feedback while extracting (no pending state, no partial delivery); (B3) extraction
is not cancelled on player close and blocks cache deletion.

## ISSUE C — far-hover thumbnail: guard works, but the user wants the PREVIEW

- Hovers at 2062.6s and 1873.3s vs harvested index frontier ≈ 240s → miss by ~27 min → 'skip'
  → `captureAtTime result false` ~40× (c.396-485; processLoop retries every ~250ms — busy-wait
  spam but no network).
- Round-2's "tooltip degrades to time-only" trade is REJECTED by the user: far hovers must show
  a real frame. Constraint stands: NO unbounded linear scans.
- Candidate that satisfies both: **cue-less MKV cluster bisection**. MKV clusters carry absolute
  timestamps; even without Cues, a byte-bisection over the file (sync-scan for the Cluster ID
  0x1F43B675 within a fetched window → read its Timestamp) converges in ~10-15 bounded ranged
  reads (few MB total) to the cluster containing T. Then hand the result to mediabunny by
  injecting a synthetic `clusterPositionCache` entry (the demuxer starts its walk at the highest
  cache entry ≤ target — same mechanism the harvest research mapped) → getKeyPacket(T) walks ≤1-2
  clusters instead of 600MB. Precedents: TSByteOffsetScanner (byte-offset seeking for TS),
  guarded internals reach-in (cuePoints), VBR anchor table for the initial byte estimate.
  ffmpeg-side alternatives are dead ends: /thumb-style `-ss` on a cue-less MKV linear-scans in
  ffmpeg's demuxer too (seek_frame_generic without index), off-coordinator.
- Also worth fixing while there: the processLoop 'skip' retry spam (result=false → retry loop
  every 250ms for the same bucket) — a skipped bucket should be remembered (until index/anchors
  change) instead of hammered.

## Residuals noted, no action this round

- c.119: one 3615ms updateend during the 139.5s seek's resetForSeek drain (append blocked behind
  remove) — did not affect seek-to-play (393ms); watch in round 4.
- PROACTIVE to-EOF (t.177-179, 1447MB) — pre-existing bandwidth contender (helps issue B, hurts
  first minutes); separate discussion.
- Startup: double `[FFMPEG] Ready` + double MSE init (React StrictMode double-mount) — known dev
  artifact.
