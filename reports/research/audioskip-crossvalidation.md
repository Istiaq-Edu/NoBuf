# Cross-validation ledger — MKV audio-skip research (all 9 docs)

Method per standing rule: every load-bearing claim re-derived from source/execution
AFTER the docs were written (prior text = hypothesis). Branch dev @ fb18253,
mediabunny 1.45.4 vendored. EXEC = verified by running something; SRC = re-read at
the cited line; LOG = user's production console log (strongest evidence — the bug
fired exactly this way).

## Root-cause chain (solution doc §top)

| # | Claim | Status | Evidence |
|---|---|---|---|
| 1 | Repro file audio starts >0 | VERIFIED EXEC | ffprobe: stream 1 aac hin start_time=0.029 (DEFAULT), stream 2 aac eng start_time=0.000, video h264 start 0.000. Bonus: only the DEFAULT track trips the bug |
| 2 | `getKeyPacket(0)` requires ts ≤ 0 → null for 0.029 start | VERIFIED SRC | media-sink doc contract (edge-A F1.16); matroska binarySearchLessOrEqual + correctBlockFound (edge-A F2.25) |
| 3 | 0 cue points in file | VERIFIED LOG | `MKV cue index: extracted 0 cue points` |
| 4 | null → audioSource.close() → video-only moov | VERIFIED LOG+SRC | init segment 672B single-trak (LOG); skip sites S1 :916-924, S2 :1026-1037, S3 :1455-1476 all `close(); audioSkipped=true` (SRC, grep-confirmed) |
| 5 | 2-codec mime + 1-trak init → Chromium fatal | VERIFIED LOG | `CHUNK_DEMUXER_ERROR_APPEND_FAILED: Initialization segment misses expected aac track` → MediaError 4 |
| 6 | AVC-MKV native fallback = dead player | VERIFIED SRC | remuxUrlRef null on transmuxer tier; useNative renders raw MKV in WebView2 `<video>` |
| 7 | Comment :1453 "init still includes audio" is false | VERIFIED LOG | 672B init proves omission (comment predates mediabunny trackDatas behavior) |

## Layer-1 mechanics (edge-A doc)

| # | Claim | Status | Evidence |
|---|---|---|---|
| 8 | `getPacket ≡ getKeyPacket` for MKV audio (all audio blocks forced key) | VERIFIED SRC | matroska-demuxer.ts:1468-1474 `if audio && codec → isKeyFrame = true` (issue #192 comment). AMENDED during plan prep: TS audio too — mpeg-ts-demuxer.ts:1737-1739 `allPacketsAreKeyPackets(): true` for MpegTsAudioTrackBacking → `createEncodedPacket` types every audio packet 'key' (:1136-1138). The claimed "TS parity" for link 2 does not exist → getPacket link DROPPED from the chain entirely |
| 9 | `audioSink.getNextKeyPacket(videoPacket)` THROWS cross-sink | VERIFIED SRC | :2049-2052/:2115-2118 `packetToClusterLocation.get(packet)` undefined → throw 'Packet was not created from this track.' — original nextAfterVideoKey leg FALSIFIED, redesigned (see plan L1) |
| 10 | `getFirstKeyPacket` bypasses cues by design | VERIFIED SRC | :2004-2010 performClusterLookup(-Infinity) comment "avoid using the cues" |
| 11 | Library's own idiom = `getKeyPacket(t) ?? getFirstKeyPacket()` | VERIFIED SRC | media-sink.ts:526-527 (sample-sink init) |
| 12 | Mid-file lookups return bestCluster (old packet), rarely null; audio-ends-early scans to EOF | VERIFIED SRC | :2377-2380 bestCluster return; :2272-2278 break requires audio trackData in cluster |
| 13 | Laced blocks pre-expanded before packet minting | VERIFIED SRC | :755-864 expandLacedBlocks, per-frame ts distribution, splice |
| 14 | Opus preSkip is container/init-level, not per-packet | VERIFIED SRC | isobmff-boxes.ts:968-998 dOps; codec-data.ts:2174-2186 |
| 15 | packets(startPacket) rejects metadataOnly start w/o option | VERIFIED SRC | media-sink.ts:310-314 TypeError |
| 16 | Every sink call throws InputDisposedError when disposed | VERIFIED SRC | media-sink.ts:162-166 et al; transmuxer expected-error filter :1506-1531 handles |
| 17 | Zero-audio-packets window ≠ null-start only (start ≥ stopTime breaks at iter 1) | VERIFIED SRC | iterateAudioPackets :1611-1621 Fix #7 cut BEFORE add; surfaced signal must be packet COUNT (F5 — plan-changer) |
| 18 | Stale comment for removed from-start audio helper | VERIFIED SRC | :1640-1649 orphaned doc comment above getMseDecision |

## Layer-2 / SB contract (edge-B + standards docs)

| # | Claim | Status | Evidence |
|---|---|---|---|
| 19 | Mime decided at init BEFORE any lookup; SB created :6836 from track inventory | VERIFIED SRC | buildMimeType :516-541; addSourceBuffer :6835-6846; probe must move INTO init (B1a) |
| 20 | `output.getMimeType()` awaits allTracksKnown → deadlock pre-pump | VERIFIED SRC | isobmff-muxer.ts:188,323 await; resolved only at :444/:526/:574 (sample paths/close) |
| 21 | Zero-packet closed track omitted from moov | VERIFIED LOG+SRC | 672B init (LOG); trackDatas.push only on first sample :440/:522/:570 |
| 22 | Chromium enforces declared==emitted; Safari/FF lenient | VERIFIED LOG (Chromium half) | exact fatal string in LOG; Safari/FF claim from standards doc (advisory, not load-bearing — WebView2 IS Chromium) |
| 23 | changeType cannot alter track SET on live SB | VERIFIED SRC (spec+Chromium strings) | standards doc §2; MSE spec step 3.1; corroborated by 'Got unexpected audio track' diagnostics. Not EXEC-verified — treated as hard constraint anyway (conservative) |
| 24 | Video-only refills into 2-trak SB legal but starve buffered intersection | VERIFIED SRC (spec) | standards doc §4; B3 ladder addresses; EXEC check deferred to e2e (D3 watchdog) |
| 25 | fallbackMimes ladder precedent for video-only SB | VERIFIED SRC | :6842 includes avc1-only mime |

## Layer-3 reroute (edge-C doc)

| # | Claim | Status | Evidence |
|---|---|---|---|
| 26 | planRemuxRecovery pure; 'skip' on alreadyAttempted/already-remux; 'seek' ≥8s | VERIFIED SRC | :239-254 read in full |
| 27 | Loop guard depends on shared one-shot ref → MUST reuse _recoverToRemuxTier | VERIFIED SRC | :4437,:4454 remuxRecoveryAttemptedRef; mpegts FATAL passes /stream URL :3652 (G3 blind spot confirmed) |
| 28 | `remuxSourceIsTsRef=true` unconditional in _recoverToRemuxTier — WRONG for MKV | VERIFIED SRC | :4478 vs :3195 (mkv route sets false) vs :7675 (mp4 false); consumed :6179 — D0 catch, plan must parameterize |
| 29 | Cold reroute sets transmuxerInitInProgressRef=true; failure path doesn't clear it | VERIFIED SRC | :4495 set; :4507-4512 failure path clears overlay only — R4/D1 leak confirmed, plan fixes |
| 30 | Video error listener: empty deps → stale state reads; refs required for gating | VERIFIED SRC | :9485-9523 useCallback([], …) |
| 31 | Silent SB fatal path (hasFatalError) never reroutes today | VERIFIED SRC | :2588/:2833 silent return; D3 catch |
| 32 | Teardown order + idioms (chain/dispose/warmer/blob) | VERIFIED SRC | :2231-2359 cleanup, :5991-5995 switch idiom, :2326/:2432 warmer gens |
| 33 | resumeTime capture before src='' (error doesn't zero currentTime) | VERIFIED SRC | :3641-3643 mpegts handler order; :4427 doc |
| 34 | audio_idx namespaces differ (Matroska TrackNumber vs ffprobe idx); server degrades gracefully | VERIFIED SRC | :259-260 tier-native ids; server -map 0:{idx} :3223-3224; validate_audio_idx_override :2534 applied :3043; per-idx cache name :2524 |
| 35 | /remux for AVC-MKV = h264 copy + AAC encode (HEVC-MKV-proven pipeline) | VERIFIED SRC | build_video_codec_args :2270-2275 copy for h264; hevc route e2e-proven (memory) |
| 36 | Subs/thumbs/persistence survive reroute | VERIFIED SRC | per-FILE resets :2034-2060 only on streamUrl change; thumbs own Input :742 (no audio calls in useThumbnailExtractor — grep empty) |

## Regression matrix (edge-D doc)

| # | Claim | Status | Evidence |
|---|---|---|---|
| 37 | Happy path invariant via ?? short-circuit | VERIFIED SRC | chain design; D2 spy test planned |
| 38 | Refill abut/Fix#7/VBR/anchors untouched (video path only consumes seekTo return) | VERIFIED SRC | :1481 video-derived keyframeTimestamp; audio chain can't alter it |
| 39 | Suites pinning adjacent behavior: 26+17+15+36 tests | VERIFIED EXEC | grep -c 'it(' counts; baseline 366/366 vitest, 178/178 cargo (last full run) |
| 40 | planAudioSwitch already emits 'reroute-remux' for mkv+unplayable | VERIFIED SRC+EXEC | AudioTrackSelection.test.ts:87 asserts it; switch path currently REVERTS on that plan :5975-5987 — Layer 3 wires it for the video-only-SB case (B4) |

## Falsified during cross-validation (fixes already folded into docs/plan)

- ~~Option A `getPacket()` fallback~~ — FALSIFIED (#8): MKV audio getPacket ≡ getKeyPacket. Chain keeps getPacket only for TS parity.
- ~~nextAfterVideoKey via audioSink.getNextKeyPacket(videoKeyPacket)~~ — FALSIFIED (#9): cross-sink throw. Redesign: near-zero → getFirstKeyPacket; mid-file → NO first-scan, surface zero-audio window instead (B3 ladder).
- ~~"init segment still includes audio track" comment :1453~~ — FALSIFIED (#7): delete with Layer 1.
- ~~_recoverToRemuxTier reusable as-is~~ — PARTIAL (#28,#29): reusable but needs remuxSourceIsTsRef parameterization + init-flag clear on failure.
- ~~audioSkipped=null-start signal~~ — INCOMPLETE (#17): must count packets added, null-start is a subset.

## INCONCLUSIVE (accepted risks, mitigations in plan)

- #23 changeType track-set prohibition: spec+diagnostic-string derived, not EXEC-tested here. Mitigation: plan never relies on changeType for track-set changes (B1a probe-at-init makes it moot).
- #24 buffered-intersection starvation: spec-derived. Mitigation: D3 zero-audio watchdog fires regardless of the starvation mechanics.
- Safari/FF leniency (#22): irrelevant on WebView2; noted for any future cross-platform port.

**Verdict: research base is sound. 3 falsifications + 2 partials caught and folded. Ready for plan.**
