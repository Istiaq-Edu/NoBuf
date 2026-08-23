# MKV Audio-Skip Fatal — Consolidated Solution (synthesis of 4 research angles)

**Bug:** cue-less AVC-MKV (`Inception…HDHub4u.mkv`) → `audioSink.getKeyPacket(0) = null`
→ transmuxer closes audio source → mediabunny emits a **video-only 672-byte init
segment** while the SourceBuffer declared `codecs="avc1.640029, mp4a.40.5"` →
Chromium/WebView2: `CHUNK_DEMUXER_ERROR_APPEND_FAILED: Initialization segment misses
expected aac track` → MediaError 4 → `useNative` on raw MKV = **dead player**.

**Root causes (two, stacked):**
1. **Lookup bug (trigger):** the default Hindi AAC track starts at **0.029s**
   (ffprobe-verified). mediabunny's MKV `getKeyPacket(0)` needs a block with
   `ts <= 0` → null. `isKeyFrame` is NOT the problem (mediabunny forces it true for
   all audio blocks — bundle :9956-9959), so plain `getPacket(0)` ALSO fails.
   The library's own sanctioned idiom is `getKeyPacket(t) ?? getFirstKeyPacket()`
   (bundle :21772); `getFirstKeyPacket` bypasses cues by design and returns the
   0.029s packet. [mediabunny doc §1-3]
2. **Contract bug (the actual fatal):** closing a zero-packet source drops the trak
   from the moov (isobmff-muxer trackDatas lazy-create), while the SB mime still
   promises 2 codecs. Chromium enforces declared==emitted on EVERY init segment
   (strict_codec_expectations_, sbs.cc:760-769); the transmuxer comment claiming the
   audio trak survives close() is **factually wrong for v1.45.4**. Safari/Firefox
   would tolerate it — Chromium-only explosion. [standards doc §2-3, mediabunny §5]

**Non-negotiable engine laws** [standards doc]:
- changeType can NEVER add/remove a track type (spec §5.5.7 step 3.1 + Chromium
  "Got unexpected audio track"). Restoring audio later = full MediaSource rebuild.
- A 2-trak init with no audio DATA doesn't error but stalls playback (buffered =
  per-track intersection). Declaring audio and starving it is not an option either.

## The fix — three layers, minimal-delta first

### Layer 1 — fix the lookup (root cause, kills ~all real-world cases)
FINAL CHAIN (amended by edge research + plan prep — see crossvalidation #8/#9/#17):
in `MediabunnyTransmuxer.seekTo` (:1455-1476) and the 2 sibling skip sites
(:915-923, :1025-1036), replace the single `getKeyPacket(kf)` attempt with:
```
audioStartPacket = await audioSink.getKeyPacket(kf, {verifyKeyPackets:false})
  ?? (kf <= NEAR_START_AUDIO_FALLBACK_S               // near-start windows only:
        ? await audioSink.getFirstKeyPacket()          //   cue-bypassing scan (library's own idiom)
        : null)                                        // mid-file: no scan — zero-audio window signal
```
- `getPacket` link DROPPED: every audio packet is typed 'key' on BOTH containers
  (matroska-demuxer.ts:1468-1474 forces isKeyFrame for non-video; mpeg-ts-
  demuxer.ts:1737-1739 allPacketsAreKeyPackets()=true for audio) → identical result.
- `nextAudioAfterVideoKey` leg DROPPED: cross-sink getNextKeyPacket throws
  ('Packet was not created from this track', edge-A F1.18). Mid-file null means
  the audio track starts AFTER the seek point — surfaced as the zero-audio-window
  signal (F5: count packets added, null-start is a subset), handled by Layer 2/3.
- Supersession checked between links (F6); generation-stale lookups bail to null.
- Audio-delay case resolved: packet at 0.029s starts the muxer legally ("first packet
  must be key" — always true for audio). Timestamp offset already handled by the
  existing keyframeTimestamp math.

### Layer 2 — never emit a lying init segment (correctness guard)
If audio is STILL unresolvable (truly broken track):
- **Declare what we emit**: on audioSkipped, build the SB/`changeType` mime from the
  ACTUAL emitted track set (mpegts.js does exactly this; `output.getMimeType()` is
  the ready-made source) → video-only SB plays legally instead of code-4 fatal.
- Surface `audioSkipped` from seekTo (today a local var — codebase doc §4g) and show
  the existing "no audio" affordance; a silent tier-1 is acceptable only as a
  deliberate, visible state — and only when tier 2 is also unavailable.

### Layer 3 — post-init fatal reroute (safety net, replaces the dead end)
SB-fatal / video-error code 4 on AVC-MKV currently → `useNative` on raw MKV =
black screen (WebView2 has no MKV demuxer). Reroute instead to the proven tier-2:
`/remux?audio_idx=N` (ffmpeg: video copy + AAC re-encode — cue-less-proof, reads
linearly on stdin) → mpegts.js, resuming at playhead. All pieces exist (HEVC-MKV
route :3184-3224 + `_recoverToRemuxTier` :4430 + `withAudioIdx` :378); this is a
recombination, not new machinery. One-shot guard per file, same as remux recovery.
[fallbacks doc §1-3, codebase doc §4c]

## Why not the alternatives

| Rejected | Why |
|---|---|
| Silent-AAC injection (hls.js/mux.js pattern) | Gold standard for LIVE streams, but needs codec-correct silent frames per codec/rate/layout — prior art covers AAC only; our MKVs carry AC3/EAC3/DTS/Opus too. Layer 1 makes the gap it papers over vanish for files whose audio exists; broken-audio files belong on tier 2. Revisit only if Layer 1+3 telemetry shows residual skips. |
| Full MediaSource rebuild w/ re-probe | Right shape per Shaka, but here a rebuild re-runs the same failing lookup — fixes nothing Layer 1 doesn't, at 10× the code. |
| `getPacket`-only fallback (my first sketch) | Insufficient: fails the audio-delay case exactly like getKeyPacket (needs `ts<=0` too). Research falsified my own Option A as originally proposed. |
| Upstream mediabunny patch | The behavior matches its documented contract; vendoring a fork for this is overkill when the caller-side fallback chain is the library's own idiom. |

## Test plan
- **Vitest (pure):** extract the fallback-chain decision into a testable helper
  (`planAudioStart` shape, like planAudioSwitch/planRemuxRecovery precedents):
  null-key→packet, null-both→firstKey (near-zero only), mid-file→nextAfterVideo,
  all-null→skip+mime-consistency decision.
- **Rust:** none needed (no server change; /remux already tested).
- **e2e (user):** the Inception MKV — expect `[Transmuxer] audio start: fallback
  getFirstKeyPacket → 0.029s` in console, audio playing, no code-4. Then a seek to
  ~60min (mid-file fallback), and audio-track switch (regression: :5957 rebuild path).

## Research docs (all on disk, cross-validated)
- reports/research/audioskip-codebase.md (311 ln — every code path + reusable recovery inventory)
- reports/research/audioskip-mediabunny.md (112 ln — library semantics, re-verified after subagent loss)
- reports/research/audioskip-standards.md (112 ln — MSE spec + 4 engines + 4 production players)
- reports/research/audioskip-fallbacks.md (62 ln — tier costs, /remux capability proof)
