# Round-3 cross-validation review — fresh-eyes audit of the A/B/C design

Reviewer: independent subagent, 2026-08-03, zero prior involvement. Inputs: the 6 round-3
docs + live source on branch `Embedded-subtitle-extraction`. Method: every load-bearing
claim re-derived from source (`grep -n`/`sed` — search_files broken in this repo);
verify-b is a reconstruction, so its experiment numbers were plausibility-checked against
the cited source lines rather than re-run.

## Per-doc verdicts

| Doc | Verdict | Notes |
|---|---|---|
| round3-log-forensics.md | SOUND | Retry count is 36 not "~40" (R12); B3 framing overstates unboundedness (R3). |
| round3-rootcause.md | SOUND except H-B1(i) | "server 503s at the frontier" is wrong — see R1. |
| round3-self-verify.md | VERIFIED | H-A2b/H-A1a/B3a all re-confirmed against source. |
| round3-verify-a-audioswitch.md | VERIFIED | Full constraint table re-derived; every anchor exact (see R6/R9 notes). |
| round3-verify-b-subs.md | MOSTLY SOUND, one FALSIFIED claim | H-B1d's "with cached_only appended today ffmpeg would still hang at the frontier then pull Telegram" is falsified by source (R1). Experiment table internally consistent (96/240 = 40% matches uniform interleave; source hooks :6131/:6169/:6187 verified live). |
| round3-verify-c-bisect.md | VERIFIED | Structure :175-187, insert :709-723, lookup :2233-2260, asserts :602/:609 all re-confirmed against vendored 1.45.4. |

## Findings

### R1 — MUST (Fix B): the design never reaches the stream body — initial 503 short-circuits every partial file

Evidence (re-derived, server.rs):
- FAST PATH :692-751 serves only when `is_range_cached(start,end)` covers the FULL range
  (stream_cache.rs:1294-1306 — contiguous full coverage, no prefix notion).
- Immediately after it, TOP-LEVEL and unconditional: `if query.cached_only.unwrap_or(false)`
  :757 → **503 for the whole request** :759-764. The CACHE-PREFIX logic (:1032-1055) and the
  poll loop (:1148) live INSIDE the `async_stream::stream!` body (:1011+), which is only
  reached when the :757 check does NOT fire.

Consequence: with B-1 (`&cached_only=true` at the extract call site) + B-2 (gate poll-wait
:1148-1223 and fallback :1233) as designed, ffmpeg's very first request (`0-EOF`, 3-t:244)
gets an immediate 503 → verify-b's own DENY shape → exit 8, no output → 502 → "Subtitle
extraction failed" toast. **Zero subtitles for every not-fully-cached file.** The two B-2
gate points are correct but insufficient; a third change is REQUIRED.

Doc-chain error being inherited: rootcause H-B1(i) says "server 503s at the frontier"
(there is no per-byte frontier logic in the initial check — it 503s the entire request);
verify-b H-B1c's "(range start not cached)" mischaracterizes the same check (it fires
whenever the range isn't FULLY cached, regardless of the start); verify-b H-B1d's "would
still hang and pull Telegram" describes behavior WITHOUT the param. None of the six docs
states that :753-764 must change; the consolidated design omits it.

Required change (pick one, (a) preferred):
(a) NEW query param for the subs use only (e.g. `cached_prefix=1`), leaving `cached_only`
    semantics byte-identical for its existing senders (TSByteOffsetScanner.ts:992 bulk
    chunks; TauriStreamSource.ts:155 handles the 503 defensively). THREE elements, not two:
    (1) call-site append at :6099 when `!fully_cached`; (2) bypass BOTH the :753-764
    503-return AND the coordinator section that follows it (:768-1005 — subscribe/spawn
    targeted Telegram downloads; a subs read must never spawn one, which is the whole point
    of B); (3) the two body gates (poll-WAIT sleep :1192-1223 skipped, Telegram fallback
    :1233 skipped) so the body ENDS at the frontier. A request whose start has nothing
    cached yields an empty/short body and a close — the CUT/CLEAN shapes verify-b's fixture
    proved salvageable (exit 0) — rather than an untested 503-on-reopen shape.
(b) Or make :753-764 prefix-aware for `cached_only` (503 only when NOTHING is cached at
    start_byte; else enter the gated body). This changes the TS-scanner contract for
    frontier-spanning chunks from immediate-503 to short-body-then-503 — I traced
    OffsetCustomSource's fill loop (TSByteOffsetScanner.ts:1040-1110): it re-fetches the
    remainder, gets the 503 one round-trip later, throws the same error — non-breaking,
    but it puts ffmpeg's mid-extraction reopen at the frontier onto a 503 reply, a shape
    the fixture did NOT test (its CUT reopen got another body-cut, not a 5XX).
Verification to bundle: one fixture re-run of the chosen end-shape (prefix + tail-probe
denied/empty + reopen behavior) confirming exit 0 + prefix cues, since the exit-0 claims
rest on the reconstructed transcript.

### R2 — SHOULD (Fix B): correct the doc record so the implementer doesn't half-trust it

Patch rootcause H-B1(i) and verify-b H-B1c/H-B1d per R1's evidence when (or before) the
plan is written. A future reader applying "the server 503s at the frontier" verbatim will
re-derive the broken design.

### R3 — NOTE (Fix B): B3's "nobody cancels it" is bounded by the existing 120s timeout

`tokio::time::timeout(120s, cmd.output())` (server.rs:6118-6130) fires even though actix
keeps the handler future alive after disconnect (verify-b H-B3a): timeout drops `cmd` →
`kill_on_drop(true)` (:6116) kills ffmpeg → subs /stream drops → StreamingGuard untracks →
deletion unblocks. Round-3's locked-files-to-next-boot happened only because the APP
EXITED at +51s (< 120s). Docs imply an indefinite leak; worst case post-close is ~120s.
Doesn't change the fix (bounded input shrinks it to seconds) — framing only.

### R4 — NOTE (Fix B): stale timeout comments/log in the poll loop

`FALLBACK_TIMEOUT_MS = 15000` (server.rs:1087) but the comment says 30s (:1073, :1220)
and the warn log says "10s timeout" (:1222). verify-b's "5s/30s" inherited the stale
comment (actual: 5s no-active-download check :1214, 15s hard timeout). Fix the log line
while editing this region; no behavior impact on the design.

### R5 — NOTE (Fix B): B-4 details the design should spec explicitly

- Re-extract must REPLACE the cached SubtitleTrack: `toggleEmbeddedSub` returns early for
  `embeddedSubTracksRef.current.get(idx)` hits (FastStreamPlayer.tsx:1519-1524) — the
  partial-track path needs a remove/re-add swap, not a second addTrack.
- 429 flow holds: server serializes per message (subs_inflight :6064-6073, Retry-After 2);
  `fetchEmbeddedSubText` retries once after ≤5s (useMSEPlayer.ts:6155-6160) — fine now
  that extraction is seconds, and double-clicks are gated by embeddedSubLoadingIdxRef.
- Partial-prefix + zero cues in prefix → exit 0, empty output → 204 → "no cues" toast
  (server :6162-6166; frontend treats as empty but doesn't memoize — re-click re-fetches).
  Misleading copy for a partial file; consider "no cues yet" when !fully_cached.
- probe_sub_tracks (:5909) and font (:6248) confirmed UNAFFECTED — the flag rides only the
  extract call site (:6099), matching verify-b H-B1c's caveat. Probe's tail reads keep
  full access.

### R6 — SHOULD (Fix A): consider changeType BEFORE resetForSeek in the reordered path

Re-derived H-A1c constraint table — all MUSTs hold (my independent pass): seekGen :6353
before the await; stopStreamingChain :6354 sets seekAbortFlag via abortSeek
(:2687→MediabunnyTransmuxer.ts:1837-1838) and seekTo clears it on entry (:1305→:1357);
bufferingForSeek/seekBuffer :6358-6359 before seekTo (callbacks check the flag at :7081
and :7091 — exact match); seekTo reads no SB state (grep `SourceBuffer` in
MediabunnyTransmuxer.ts → 10 hits, all comments/log strings); nothing between :6376 and
:6403 reads SB.buffered (verified statement-by-statement; the escalation path's
`video.currentTime` capture at :4786 is not SB state); the append loop uses the CAPTURED
array (:6401-6405), so flipping bufferingForSeek=false at :6380 before appends is safe —
seekTo's emission completed inside the await, and stale producers are gen-gated/cancelled
at seekTo entry (:1327-1334). The design's proposed order is feasible as written.

The SHOULD: the design keeps flush→changeType adjacency (resetForSeek then changeType).
H-A1b proved changeType is legal with buffered data (wrapper only waits for
queue-idle/!updating, SourceBufferWrapper.ts:270; no buffered-ranges precondition). Doing
changeType BEFORE resetForSeek converts its failure mode from "escalate to /remux
post-flush" into "revert in place with the old buffer intact" (setDesiredAudioTrack(null)
+ startStreamingChain resumes the old track seamlessly). Strictly better UX than a
whole-tier reroute for a codec-string hiccup; slightly more code than the design's
minimal escalate. If not taken, the design's escalation (mapTrackToFfprobeIdx +
recoverMkvRerouteRef, mirroring :6391-6396) is acceptable — the MUST-level dead-end from
verify-a's caveat is already addressed.

### R7 — SHOULD (Fix A): gate the harvested fallback on `format === 'mkv'` and run the 3 transmuxer test suites

H-A2c's live-wiring proof re-verified: the ONLY non-test `new MediabunnyTransmuxer` is
useMSEPlayer.ts:7066 with `format: 'mkv'` hardcoded (:7067); TS dispatches to mpegts.js
(:3262/:3368/:7406-7421); MuxJsTsTransmuxer has no instantiation site; the
FastStreamPlayer.tsx:251-258 comment claiming TS uses this transmuxer LIES. So "no format
gate needed" is true for today's wiring. But the class itself is format-agnostic, the TS
scanner populates `keyframeTimestamps` with `keyframeIndexBuilt=true` (:708), and three
test files instantiate the class directly (AudioStartChain, HarvestedKeyframeIndex,
snapToCueKeyframe .test.ts) — a fallback that activates whenever `mkvCueIndex.length===0`
changes the class contract for any non-MKV construction. All three test files pass
`format: 'mkv'` (AudioStartChain.test.ts:22, HarvestedKeyframeIndex.test.ts:19,
snapToCueKeyframe.test.ts:27), so a `this.config.format === 'mkv'` gate in both helpers
costs nothing there, eliminates verify-a's "theoretical residual", and keeps the class
honest if TS wiring ever changes. Note snapToCueKeyframe.test.ts:85-88 ("strict no-op
when cue index empty") still passes either way (its fixture also has empty
keyframeTimestamps) — the fallback needs NEW cases (empty cues + populated harvest →
boundary/clamp/snap), not edits to existing ones. Run all three suites with the change.

### R8 — NOTE (Fix A): transmux window growth with stopTime engaged — bounded, disclose it

When stopTime is set, maxDuration is bypassed entirely for the video cut (verified:
iterateVideoPackets `if (stopTime !== Infinity) {… break } else if (maxDuration…)`,
MediabunnyTransmuxer.ts:1694-1699). Switch window becomes [kf ≤ t, first harvested
boundary > t+8]: with GOP 10.4s worst ≈ kf at t−10.4, boundary at t+18.4 → ~29s of
transmux vs today's 8s — all cache-served in the stutter scenario (the region was just
played), measured 15-50ms/8s today so expect ≤ ~200ms. The helper-level clamp
(boundary ≤ time+25) caps the refill path at refillPosition+5+25=30s. Acceptable;
optionally pass a tighter call-site clamp for the switch (t+8+12). Clamp misfire after a
far seek re-checked: `keyframeTimestamps` is never truncated (only disposed :1960), so a
post-far-seek query in the coverage gap finds the FAR entry → clamp → null → maxDuration
fallback, exactly as intended; `noteIterated`'s single-span reset (:829-846) affects only
findNearestKeyframe's watermark trust, not the fallback array. Sorted+deduped invariant
re-verified at all four write sites (:708/:784/:818/:1960).

### R9 — NOTE (Fix A): playhead may outrun the appended window on a COLD switch (self-healing)

New failure geometry the docs didn't mention: with the old buffer playing through a SLOW
(uncached) transmux, the playhead advances; if it passes the appended window's end
(boundary can be as low as t+8), the post-append state is "data behind playhead" → video
fires 'waiting' (spinner only — FastStreamPlayer.tsx:1064/1090; the zero-audio starvation
watchdog counts refill windows, not wall time :2818-2842, and the chain is stopped, so
nothing else interferes) → startStreamingChain's first refill seeks ~currentTime and
recovers in one cycle, reading the just-flushed (disk-cached) region. Worst case a brief
spinner on cold switches; today's order stalls harder (frozen playhead, zero data) for
the same duration. No action; watch in round 4.

### R10 — SHOULD (Fix C): consult the existing clusterPositionCache before launching a new bisection

The thumbnail pipeline's keyframeTimestamps come only from the TRANSMUXER's harvest
(updateKeyframeTimestamps :744-750) — the thumb-Input's own cluster parses never feed the
skip/index decision. So after bisecting bucket 2062s, hovering 2064s (new 2s bucket,
BUCKET_SIZE=2 :29) re-decides 'skip' and — memoized per bucket — launches a fresh
bisection even though the previous injection already bounds the walk. Before bisecting,
reach into `internalTrack.clusterPositionCache` (guarded, readMkvCuePointCount style) and
skip the bisection when an entry with startTimestamp ∈ [T−~35s, T] exists (both injected
and organic entries qualify); go straight to inject-free getKeyPacket. Bounds repeat cost
in a hover-scrub region to zero network.

### R11 — NOTE (Fix C): spec imprecisions to fix in the plan (all cheap)

- "plain fetch … with source_id=thumbnail (precedent :561-564)": the MP4 precedent's
  `this.streamUrl` carries NO source_id (raw URL; ThumbnailPipeline class). The bisect
  fetch must append `&source_id=thumbnail` (or `thumbnail-bisect`) explicitly — plain
  fetch bypasses TauriStreamSource's URL builder (source-id append lives at
  TauriStreamSource.ts:42-55). Consider `max_bytes` (server.rs:666-675) as a belt on
  window requests.
- Seed the bisection's low bound from `segment.clusterSeekStartPos` (or `dataStartPos`,
  Segment fields :86-88) via the same reach-in — avoids scanning the header region and
  satisfies verify-c residual 7 (segment membership) for free.
- Scanner validation step 3 ("read the 0xE7 value") must child-WALK: CRC-32 (0xBF) is
  commonly the first child; Timestamp may be second. Bounded, but say so.
- Sink/track identity confirmed: `this.videoSink = new EncodedPacketSink(this.videoTrack)`
  (useThumbnailExtractor.ts:849) — injection into `this.videoTrack._backing.internalTrack`
  targets exactly the track the sink queries. Organic re-insert of the same cluster with
  the real (higher) startTimestamp can duplicate an entry when an intervening entry
  defeats the elementStartPos-at-index dedup (:715-718) — harmless (walk lands on the
  same byte); no action.

### R12 — NOTE (forensics): minor count/log corrections

36 `captureAtTime result false` lines in 3-c (not "~40"); retry cadence 200ms+50ms loop
tail ≈ 250ms ✓. CACHE-PREFIX/STREAM-CACHE-WAIT/fallback line anchors verify-b cites are
within ±2 of live (:1148 exact, fallback entry :1233 vs cited :1231). verify-b's actix
harness used 4.14 vs app's pinned 4.13.0 — the tested behavior (handler futures run to
completion post-disconnect) is core dispatcher behavior, not version-gated; accepted.

## Verdicts

| Fix | Verdict | MUSTs |
|---|---|---|
| **A (audio-switch reorder + harvested fallback)** | **SHIP** | none — constraint table independently re-derived and holds; SHOULDs R6 (changeType-before-flush option) and R7 (mkv gate + run 3 test suites); NOTEs R8/R9. |
| **B (bounded subs extraction)** | **SHIP-with-MUSTs** | **R1**: add the third server change — the :753-764 initial-503 short-circuit must not fire for the subs extract request (new `cached_prefix` param preferred, or prefix-aware `cached_only`), else the design ships the DENY shape and extracts nothing; bundle one fixture re-run of the resulting end-shape. R2 doc corrections ride along. |
| **C (bisection + cache injection)** | **SHIP** | none — vendored-source claims all re-verified; SHOULD R10 (consult cache before re-bisecting); NOTEs R11. |

MUST count: **1** (R1, Fix B).
