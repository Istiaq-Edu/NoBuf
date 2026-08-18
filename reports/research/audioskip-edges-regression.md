# EDGE-CASE ANGLE D — regression matrix: what the 3-layer fix must NOT break

> The dispatched angle-D subagent hit max_iterations before writing its doc
> (its 154-line trail shows the full investigation). Absorbed: re-verified every
> fact below directly from source. Branch dev @ fb18253.

## D0. CRITICAL CATCH — `remuxSourceIsTsRef` divergence in `_recoverToRemuxTier`

`_recoverToRemuxTier` sets `remuxSourceIsTsRef.current = true` unconditionally
(useMSEPlayer.ts:4476-4478) — written for the TS tier where raw /stream bytes ARE
MPEG-TS so byte-forward (start_byte) remux seeks are valid. For an MKV source this is
WRONG: the init-time MKV remux route sets `false` (:3195 "Matroska: ss-only seeks"),
and the MP4 route too (:7675). If Layer 3 reuses `_recoverToRemuxTier` as-is, a
post-reroute user seek on an MKV file takes the byte-forward path
(`decideSeekDispatch` consults the ref, :6179) → start_byte offsets into Matroska
bytes treated as TS → garbage. **Layer 3 must parameterize the ref (or set it by
container format after the call): `remuxSourceIsTsRef.current = (format === 'ts')`.**
Regression test: TsHevcRecovery-style unit on the reroute helper asserting the ref
for mkv vs ts sources.

## D1. The 3 audio-skip sites and who runs them

| Site | Line | Runs for | Trigger |
|---|---|---|---|
| S1 `produceSegmentsFromInitInput` | :916-924 | TS phase 1 (in-memory init input) | cold start |
| S2 `sequentialContinue` | :1026-1037 | TS phase 2 (streamSource) | chain continue |
| S3 `seekTo` | :1455-1476 | MKV + TS: prime (t=0), user seeks, refills, audio-switch rebuild | every window |

The chain replaces the lookup at all 3; S3 is the MKV-critical one. TS files (S1/S2)
keep their existing semantics via chain link 1 short-circuit (see D2).

## D2. Happy-path invariance (files with cues + audio starting ≤0)

`getKeyPacket(kf)` succeeds → chain link 1 returns the SAME packet as today; links
2-3 never evaluated (`??` short-circuit). Zero behavioral delta. Regression proof:
existing MKV/TS e2e-verified behaviors (cue-indexed seeks, abutting refills, VBR
correction) all flow through the same return value. Vitest: chain unit test asserts
link-1 result is returned unmodified and later links are not called (spy).

## D3. Abutting-refill machinery (the ~51s MKV decode-crash fix)

Refills call `seekTo(t, dur, {skipInitSegment:true, stopTime})`; stop ON keyframe
boundary; audio cut at the same stopTime (Fix #7, :1611-1621). The chain only changes
WHERE audio STARTS when the legacy lookup returned null — the stop condition is
untouched. F5 (zero-audio-packets window signal) must fire only when 0 packets were
added; a normal refill adds ≥1. No interaction with the cue-index gating.

## D4. VBR seek correction + byte↔time anchors

seekTo's return value (`keyframeTimestamp`, video-derived) is what the correction and
anchor recording consume (:1481 videoSink path; useMSEPlayer records anchors from the
seek result). The audio chain cannot change it. INVARIANT: chain must not touch the
video lookup path.

## D5. Audio-track switch (`_switchMkvAudioTrack`, :5951-6060)

- Switch to a working track: `setDesiredAudioTrack` → rebuild seekTo — chain link 1
  succeeds mid-file via cluster walk (bestCluster) exactly as today.
- Switch to a track unresolvable at the playhead: today silent skip → post-changeType
  init mismatch fatal (same class as the repro). With Layer 1+2: probe fails → B4
  guard routes to reroute-with-audio_idx instead of a doomed changeType. planAudioSwitch
  already has 'reroute-remux' as a plan output (AudioTrackSelection.test.ts:87 asserts
  mkv+unplayable → 'reroute-remux') — extend, don't replace.
- `AudioTrackSelection.test.ts` (26 tests) pins: withAudioIdx URL building,
  planAudioSwitch matrix, pickDefaultAudioTrack, persistence round-trip. The fix must
  keep all 26 green — chain + B4 guard only ADD branches.

## D6. Thumbnail pipeline — fully isolated

`useThumbnailExtractor` builds its OWN `Input` (:742) and never touches audio (no
audio calls in the file; video-only seeks :2055+). Main-transmuxer changes and the
Layer-3 teardown (disposes only `transmuxerRef`) cannot affect it. Post-reroute the
raw /stream URL stays valid for thumbs (verified §8 of reroute doc).

## D7. Existing test suites that pin adjacent behavior (all must stay green)

| Suite | Tests | Pins |
|---|---|---|
| AudioTrackSelection.test.ts | 26 | planAudioSwitch/withAudioIdx/persistence |
| TsHevcRecovery.test.ts | 17 | planRemuxRecovery/isAlreadyRemuxUrl/one-shot |
| HevcRerouteUtils.test.ts | 15 | hevc route decisions |
| RemuxSeekUtils.test.ts | 36 | remux seek URL/byte math (D0 relevant) |
| decideSeekDispatch.test.ts | — | seek dispatch incl. remuxSourceIsTs consult |
| snapToCueKeyframe.test.ts | — | cue snapping (cue-less file: no snap) |
| EmbeddedSubtitles.test.ts | 19 | subs survive tier switch (per-file state) |

Total vitest baseline 366/366 (22 files); Rust 178/178. Gate after each layer.

## D8. Server /remux contract (Layer 3 consumer)

- `-c:v copy` for h264 (:2270-2275) + AAC re-encode → TS: byte-identical pipeline to
  the HEVC-MKV route (e2e-proven).
- `validate_audio_idx_override` (:2534) + per-idx cache filename (:2524) — reroute
  with invalid idx degrades to default track, never 500s.
- No server changes needed for any layer. Rust tests untouched.

## D9. Chain cost regressions to guard

- Cue-less MKV near-zero seek: `getFirstKeyPacket` scans from `clusterSeekStartPos` —
  head bytes are already prefetched (6MB cold-start buffer) → cheap for the repro.
- Mid-file: chain must NOT call getFirstKeyPacket (byte-0 scan on 1.46GB) — the
  mid-file leg is next-audio-AFTER-video-key via `getNextKeyPacket(audioPacketNearKey)`
  or bounded cluster walk; if none, surface zero-audio window (B3 ladder).
- Audio-ends-early file: performClusterLookup scans to EOF before returning bestCluster
  (matroska-demuxer.ts:2270-2278 break never fires without audio trackData) —
  pre-existing cost, chain adds nothing on top (link 1 SUCCEEDS with the old packet).

## D10. Absorption note

Angle-D subagent's trail (task-3.log, 154 lines) covered the same files/greps used
here (AudioTrackSelection/TsHevcRecovery suites, thumbnail extractor, S1/S2/S3 sites,
getMimeType, byte-time anchors) — its investigation is consistent with the above; the
doc itself is mine, every claim re-checked at the cited lines.
