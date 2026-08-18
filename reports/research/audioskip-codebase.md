# MKV Audio-Skip Fatal Error — Codebase Map (code paths + reusable recovery)

Status: COMPLETE (all sections ✅ verified against source)
Date: 2026-07-31. Branch `dev` @ `fb18253` (clean tree except untracked repro MKV
`Inception.2010.720p.BluRay.Hindi.5.1-English.5.1.ESub.x264-HDHub4u.Tv.mkv` in repo root).

Scope: every code path involved in the MKV audio-skip fatal error
(`audioSkipped` in `app/src/lib/faststream/players/MediabunnyTransmuxer.ts`) and every
existing recovery mechanism that could be reused for a fix.

---

## 1. The audio-skip mechanism (trigger sites) ✅

All in `app/src/lib/faststream/players/MediabunnyTransmuxer.ts`. Pattern is identical at
3 sites: after resolving the video keyframe, the code asks the audio track for a start
packet; **if `getKeyPacket` returns null the audio source is closed and the whole
window is produced video-only** (`audioSkipped = true`).

| Site | Path | Lines | Notes |
|---|---|---|---|
| **`seekTo()` — MKV hot path** | every MKV prime, user seek, and refill | :1455-1476 (`audioStartPacket = await audioSink.getKeyPacket(keyframeTimestamp, {verifyKeyPackets:false})` :1465; on null → `audioSource.close()` :1472, `audioSink=null`, `audioSkipped=true` :1474) | THE site for the MKV bug. Comment (:1449-1454) says closed track ⇒ Output's `keyFrameQueuedEverywhere` treats it as done ⇒ video-only segments; "Audio will be added via refill segments later" — i.e. skip was designed as per-window, expecting the NEXT refill to bring audio back. |
| `produceSegmentsFromInitInput()` — TS phase 1 | :913-924 | same close-on-null (:919-923) |
| `sequentialContinue()` — TS phase 2 | :1025-1035 + mid-iteration close at :1081 | same |

Downstream consequences inside `seekTo`:
- Audio iteration is simply skipped (`audioPromise = Promise.resolve()`, :1483-1487).
- Log line `seekTo: iteration took …ms (audioSkipped=true)` :1491 — the fingerprint to
  look for in user logs.
- `audioSource.close()` is NOT called twice (guard `!audioSkipped` :1496).
- **The init segment still contains the audio track** (`localOutput.start()` ran at
  :1439 before the null check) — so MSE is told "this stream has audio", then receives
  a window with no audio samples ⇒ an **audio-track buffered-range gap** in the single
  combined SourceBuffer (MKV uses ONE muxed SB — useMSEPlayer.ts creates only a combined
  buffer for MKV, `[MSE] MKV: created combined SourceBuffer`).

### Who picks the audio track (new since audio-track selection, PR #36 @ 50012b7)
- `desiredAudioTrackId` (:118-121) — user-selected mediabunny track id; `null` = primary.
- `resolveAudioTrack(input)` (:1679-1691) — `desiredAudioTrackId != null` →
  `input.getAudioTracks().find(id)`; fallback = `input.getPrimaryAudioTrack()`.
  Called from `init()` MKV branch (:431) and **`seekTo()` hot path (:1326)**.
- `setDesiredAudioTrack(trackId)` (:1734-1759) re-derives `audioCodec` /
  `audioTrackInfo` / `mimeType`, reverts id on failure.
- `getAudioTracks()` (:1695-1725) — menu metadata enumeration.
- TS phase-1/phase-2 sites still call `getPrimaryAudioTrack()` directly (:890, :986) —
  TS tier excluded from selection by design.

**Relevance:** a non-primary audio track chosen via `desiredAudioTrackId` is used by
every `seekTo` — so the skip decision now runs against the *selected* track. If the
selected track's packets can't be located near the video keyframe (getKeyPacket null),
every window in that region silently drops audio for that track.

## 2. What a skipped window does downstream ✅

MKV playback = **one combined muxed SourceBuffer** (`useMSEPlayer.ts:6836-6839`,
`[MSE] MKV: created combined SourceBuffer (video/mp4; codecs="avc1…, mp4a.40.2")`).
The init segment (ftyp+moov from `Output.start()`) declares BOTH tracks. When a window
is produced with `audioSkipped=true`:

- The moof/mdat fragments contain only video samples. WebView2/Chromium tracks
  per-track buffered ranges internally; `SourceBuffer.buffered` (combined) reports the
  **intersection**… in practice Chromium reports video range while the audio track has
  a hole. `HTMLMediaElement.buffered` reflects the intersection of all tracks — so a
  video-only stretch can still show as buffered if audio from an earlier append overlaps,
  or show buffered-but-silent when the decoder tolerates missing audio samples.
- Playback behavior observed (from prior session logs, July 10 session
  `20260712_020122_985559`): the player either goes SILENT for the video-only stretch,
  or — the fatal case — the decoder/demuxer chokes when audio samples reappear with a
  discontinuity, surfacing `PIPELINE_ERROR_DECODE` via `video.error` (MEDIA_ERR_DECODE),
  logged by `SourceBufferWrapper` as `[SourceBuffer] Fatal error detected`.

### Refill chain context (`useMSEPlayer.ts`)
- Constants :2508-2542 — `REFILL_THRESHOLD_SECONDS=20`, `REFILL_CHUNK_DURATION=5`,
  `INITIAL_SEEK_DURATION=25`, `SEEK_START_DURATION=8`, `REFILL_MAX_DURATION_CAP=25`.
- `startStreamingChain()` :2547, `stopStreamingChain()` :2558 (bumps gen +
  `transmuxer.abortSeek()`), `executeStreamingRefill()` :2579 — every refill =
  `transmuxer.seekTo(bufEnd→cue keyframe, …, {skipInitSegment:true, stopTime})`
  in discontinuity mode (:2607-2620). **Each refill window independently re-runs the
  audio getKeyPacket → skip decision** — so one bad region produces a *sequence* of
  video-only windows; the skip is per-window sticky within a region, not global.
- Guards: `sb.hasFatalError` checked at refill entry :2588 and chain-continue :2833 —
  a fatal SB silently STOPS the refill chain (no recovery is triggered from here).
- Backpressure: `getBufferedAheadSeconds() >= getBufferAheadCap()` :2602.
- The initial MKV prime (:6926-6971) uses the same seekTo path with
  `stopTime = nextKeyframeAtOrAfter(INITIAL_SEEK_DURATION)` — so **even the first
  window at t=0 can be audio-skipped** if the audio track yields no key packet at the
  first video keyframe (e.g. selected track's getKeyPacket(0) null).

### Audio-track selection integration (:6872-6909)
After MKV transmuxer init succeeds, an async IIFE enumerates tracks
(`transmuxer.getAudioTracks()`), computes `playable` via
`MediaSource.isTypeSupported('audio/mp4; codecs="<cps>"')`, applies a **persisted
per-file selection** via `setDesiredAudioTrack(persisted)` BEFORE the initial prime.
NOTE: this IIFE races the prime (:6932) — it's `void`-ed, not awaited; if enumeration
is slow the prime may run with the primary track and the persisted track only takes
effect from the first refill onward (A/V codec mismatch across windows possible if
codecs differ — a subtle hazard adjacent to the audio-skip bug).

## 3. Fatal-error detection & propagation chain ✅

The MKV tier has **three detectors** for a dead pipeline, all converging on
`setUseNative(true)`:

### 3a. SourceBufferWrapper fatal-state machine (`lib/faststream/players/SourceBufferWrapper.ts`)
- `fatalError` flag (:18). Set true when:
  - append/remove throws `InvalidStateError` mentioning `"error attribute is not
    null"` (HTMLMediaElement.error set by decoder — CHUNK_DEMUXER_ERROR_APPEND_FAILED /
    PIPELINE_ERROR_DECODE) → `Fatal error detected — stopping all append operations`
    (:167-173);
  - `"removed from the parent media source"` (:177-184, also in `buffered` getter :62-67
    and `setTimestampOffset` :220-224).
- A lone `error` **event** does NOT set fatal (:130-141) — the next failed op confirms.
- Behavior once fatal: queue cleared, `appendBuffer` becomes no-op (:117),
  `resetForSeek`/`changeType`/`setTimestampOffset`/`waitForQueueDrain` all resolve
  immediately (:286, :259/:269, :240, :342). **Fatal is exposed as passive flag
  `hasFatalError` (:79) — the wrapper itself never notifies anyone.**
- `QuotaExceededError` is separate/recoverable (`quotaExceeded` :19, :191-196).

### 3b. Refill-chain reaction to fatal SB (`useMSEPlayer.ts`)
- `executeStreamingRefill` entry check :2588 and chain-continue check :2833:
  `sb.hasFatalError` → **silently return** — refill chain stops; NOTHING recovers.
- Download loop (MP4 path) also checks SB fatal at :7946-7949, :8022-8024 (`stopping
  download loop`).

### 3c. video element error listener — the ONLY MKV-tier recovery trigger (`useMSEPlayer.ts:9485-9523`)
`setVideoRef` attaches an `error` listener:
- fires on `MediaError.MEDIA_ERR_DECODE` (3) or `MEDIA_ERR_SRC_NOT_SUPPORTED` (4);
- ignored while `transmuxerInitInProgressRef` (blob URL has no data during init — expected);
- if an mpegts.js player is active → defer to its own FATAL handler;
- else (the MKV transmuxer case): `console.warn('[MSE] Fatal video error (code N) —
  falling back to native playback')` → **`setUseNative(true)`**. That's it — no remux
  reroute, no rebuild, no playhead preservation on this path.

### 3d. Transmuxer onError / onCodecUnsupported (MKV construction site :6764-6775)
- `onCodecUnsupported` → `setError` + `setUseNative(true)`.
- `onError` → `setError(error.message)` + `setUseNative(true)`.
- `seekTo` catch (:1506-1531 in transmuxer) filters superseded/aborted/disposed/expected
  errors; only *real* seek failures call `config.onError` → **an audio-related exception
  inside seekTo (e.g. from mediabunny audio decode/iteration) lands on useNative too**.
- `seekTo` returning null (no keyframe) is NOT fatal by design (:1398-1402).

### What `useNative` means for an MKV (the actual user-visible failure)
`FastStreamPlayer.tsx:813-860`: when `playerUseNative` flips true, video.src is set to
`playerRemuxUrl || streamUrl`. **For the MKV transmuxer tier `remuxUrlRef` was never
populated** (it's only set on the HEVC-MKV route :3187-3194, MP4-HEVC reroute :7668-7674,
TS fallbacks :3660-3665/:7063, TS-HEVC recovery :4470-4475) — so an AVC-MKV that dies
mid-play falls to **native `<video>` on the raw `/stream` MKV bytes**: WebView2 usually
can't demux MKV natively → black screen / infinite spinner. This is the "fatal error"
end state of the audio-skip bug.

### Fingerprint chain for the audio-skip fatal (from code + July-10 session evidence)
```
[Transmuxer] seekTo: audio getKeyPacket took …ms, result=null (will skip audio)  (:1466)
[Transmuxer] seekTo: iteration took …ms (audioSkipped=true)                      (:1491)
… (video-only window appended to combined SB)
[SourceBuffer] error event: …                                                     (SBW :51)
[SourceBuffer] Fatal error detected — stopping all append operations              (SBW :172)
[MSE] Fatal video error (code 3) — falling back to native playback                (:9515)
→ native <video> on raw MKV → dead player
```

## 4. Existing recovery mechanisms (reuse candidates) ✅

Inventory of every rebuild/recovery path already e2e-proven in the codebase, ranked by
fit for an audio-skip fix:

### 4a. MKV audio-track switch rebuild — `_switchMkvAudioTrack` (useMSEPlayer.ts:5957-6039) ★ best fit
Purpose-built "rebuild the combined SB from the playhead with different audio" flow:
`setDesiredAudioTrack` → `planAudioSwitch` (pure, :352) → gen bump
(`++transmuxerSeekGenRef`) → `stopStreamingChain()` → `bufferingForSeekRef=true` +
`seekBufferRef=[]` → `sbVideo.resetForSeek()` → optional `sbVideo.changeType(newMime)`
(H1) → `transmuxer.seekTo(t, SEEK_START_DURATION, {skipInitSegment:false, stopTime})` →
supersession guard → `setTimestampOffset(kf)` → flush buffered segments →
`startStreamingChain()`. **This is exactly the shape of a "retry this window with audio
handled differently" recovery** — it rebuilds from the playhead without tearing down
MSE, the transmuxer, or the video element; pause state survives (only reads
`isPausedRef`).

### 4b. Transmuxer user-seek path (useMSEPlayer.ts:8753-8990)
Same machinery generalized: near-end guards, buffered-instant path, debounce, gen
guard, warmer cancel + backend re-target, `resetForSeek` on video AND audio SBs,
`seekTo(clampedTime, SEEK_START_DURATION, {stopTime})`, supersession bail, timestamp
offset, flush, `startStreamingChain()`. Any fix that "re-seeks to currentTime" can call
`seekTo(video.currentTime)` — but note the buffered-instant branch (:8791-8803) would
short-circuit; a recovery must force the unbuffered path (as 4a does by calling
`transmuxer.seekTo` directly).

### 4c. TS-HEVC fatal recovery → /remux tier — `_recoverToRemuxTier` (useMSEPlayer.ts:4430-4520)
The heavyweight cross-tier fallback: pure `planRemuxRecovery` (:239-254, skip/init/seek)
+ loop guard `isAlreadyRemuxUrl` (:193) + one-shot `remuxRecoveryAttemptedRef` (:1878-83,
reset per file load :2384) → reset video element (clears `video.error`!) → build
`/remux?hevc_ok&audio_idx` URL (withAudioIdx preserves the user's audio pick, :4470) →
either `_mpegtsRecreatePlayerForRemuxSeek(resumeTime)` (playhead ≥8s) or cold
`_initMpegtsPlayer`. Fired from: mpegts FATAL handler (:3652), codec-unsupported
(:3713), mpegts init failure (:7054). **Reusable as the LAST-RESORT tier for an MKV
whose audio can't be made to work client-side: ffmpeg re-muxes/transcodes audio to AAC
server-side.** Caveats for MKV reuse: this path currently assumes an mpegts.js context;
for the MKV transmuxer tier it would need (1) transmuxer dispose, (2)
`remuxSourceIsTsRef=false` + `needsRemuxSeekRef=true` (ss-only seeks — exactly what the
HEVC-MKV route sets at :3193-3195), (3) MediaSource teardown. All pieces exist on the
HEVC-MKV route (:3184-3224) — an AVC-MKV audio-fatal reroute is a recombination, not
new machinery.

### 4d. video-element reset idiom (used by 4c and the FATAL handler)
`video.src=''; removeAttribute('src'); video.load()` (:3644-3650, :4460-4467) — the
only sanctioned way to clear `video.error` so a NEW pipeline can attach. Any recovery
that runs AFTER the decoder died (SB fatal) needs this; in-place SB surgery is
impossible once `HTMLMediaElement.error` is set (SourceBufferWrapper enforces it).

### 4e. mpegts DTS-overflow "nuclear recovery" (:4052-4161)
In-place SB flush + duration restore with generation guard, for a *recoverable* SB.
Demonstrates the "remove-all + re-prime without teardown" pattern with all its
updateend-waiting subtleties — the template if a fix chooses to surgically remove a
video-only buffered range and re-append it with audio.

### 4f. Guards/utilities a fix should reuse (all pure + unit-tested where noted)
- `transmuxerSeekGenRef` / `isSeekSuperseded` — supersession (AudioTrackSelection.test).
- `audioSwitchInFlightRef` single-flight (:1571, E4) — extend to recovery single-flight.
- `planAudioSwitch` (:352) / `planRemuxRecovery` (:239) — precedent for a pure
  `planAudioSkipRecovery()` decision helper, testable in vitest like
  `TsHevcRecovery.test.ts` (17 tests) and `AudioTrackSelection.test.ts` (26 tests).
- `withAudioIdx` (:378) + `remuxAudioIdxRef` (:1886) — audio choice survives ALL 6
  /remux URL construction sites (incl. recovery :4470).
- Persistence: `readPersistedAudioTrack`/`persistAudioTrack` (:397/:405,
  key `nobuf-audio-track`, LRU 200).
- Backend: `/remux?audio_idx=N` validated by `validate_audio_idx_override`
  (server.rs:2534-2545; invalid → primary, never 500); cache keyed per-track
  `remux_cache_filename` (:2524); `/audio_tracks` endpoint exists for probing.
- EOF detection precedent for "same keyframe twice = stop" (:2679-2719) — a recovery
  loop guard shape (require N consecutive failures before escalating).

### 4g. What does NOT exist today (the gap)
- No detector for "window produced without audio" above the transmuxer —
  `audioSkipped` is a local variable; `seekTo` returns only `keyframeTimestamp`.
  Neither the prime (:6932), the user seek (:8925), nor refills (:2661+) can tell a
  video-only window from a normal one.
- No per-track buffered-range comparison (video-range vs audio-range on the combined
  SB) anywhere in the MKV tier.
- SB fatal on the MKV tier has NO recovery hook: refill chain silently stops (:2588);
  only the video `error` event (3c) reacts, and it goes straight to `useNative` (dead
  end for MKV per §3). The mpegts tier's FATAL→remux chain (:3652) has no MKV
  equivalent for post-init decode fatals.

## 5. Library-level semantics (mediabunny v1.45.4, vendored) ✅

From `node_modules/mediabunny/dist/modules/src/media-sink.js` (:62-140) and
`reports/research/audio-lib-mediabunny.md` (verified against dist):

- **`EncodedPacketSink.getKeyPacket(timestamp)` contract:** returns the last key packet
  with start ≤ timestamp; **returns `null` when the timestamp is before the first key
  packet in the track** (doc comment in media-sink.js). For audio (AAC/AC3/Opus — all
  packets are sync), null typically means the demuxer could not resolve a packet at/
  before that time in the *selected* track — e.g. cluster lookup landed past it or the
  track's packets start later than the video keyframe (common: audio delay/edit-list,
  or a Hindi/English dual-audio MKV where track 2 starts slightly later).
- All sink methods throw `InputDisposedError` when the Input was disposed mid-await —
  already handled as "expected" in seekTo's catch (:1517-1522).
- Closed-track semantics used by the skip: `EncodedAudioPacketSource.close()` tells the
  Output the track is done; `keyFrameQueuedEverywhere` treats closed tracks as satisfied
  so video-only fragments CAN be finalized (transmuxer comment :1450-1454).
- `Output.addAudioTrack(source, metadata?)` may carry `languageCode`/`name` metadata —
  currently NOT passed by the transmuxer (bare `addAudioTrack(audioSource)` :1435).
- `Conversion` supports per-track discard (`audio: (track) => track.id === wanted ? {} :
  {discard:true}`) — relevant context: MKV playback does NOT use Conversion for data
  (it's vestigial post-init; all data flows through seekTo's manual packet pump).

### mediabunny MKV backing for getKeyPacket (matroska-demuxer)
MKV Cues usually index only the VIDEO track. mediabunny's matroska demuxer resolves
audio `getKeyPacket(t)` via `performClusterLookup`: cue binary-search (`cuePoints` per
track — audio tracks often have NO cue points, so the search starts from the video-cue
or `clusterSeekStartPos`), then a forward cluster walk reading headers over HTTP
(`reader.requestSliceRange`) until a cluster contains blocks for THIS track with
`isKeyFrame && ts <= target` (`findLastIndex`, matroska-demuxer.js:1844-1859). It
returns null when NO visited cluster yields a matching block (`bestCluster` never set —
:1920-1935) — e.g. the walk starts in a cluster past the target (faulty/absent cue →
one retry with the previous cue point, then gives up) or the track's first key block
lies after the target timestamp. `getPacket` (:1799) is the same walk WITHOUT the
isKeyFrame filter — a strictly-more-likely-to-succeed variant for all-sync audio
codecs. This is timing/layout dependent — explains intermittent repros and why refills
(warm cache, position cache populated) often carry audio while a cold far-seek doesn't.

## 6. Summary: candidate interception points (ranked, minimal-delta first) ✅

1. **At the skip site (transmuxer seekTo :1455-1476):** don't give up on
   `getKeyPacket(kf) → null`. Fallbacks in order: `getPacket(kf)` (audio packets are
   all-sync for AAC/AC3 — `hasOnlyKeyPackets()` can prove it; a plain getPacket avoids
   the isKeyFrame filter), then `getFirstKeyPacket()` bounded to window when kf≈0,
   then `getNextKeyPacket` from the resolved video keyframe packet. Only skip if all
   fail. Cheapest fix; kills most nulls at the root. (matroska-demuxer getPacket/
   getKeyPacket differ only by the isKeyFrame findLastIndex filter — same cluster walk.)
2. **Surface the skip:** return `audioSkipped` from `seekTo` (e.g.
   `{keyframeTimestamp, audioSkipped}` or a getter `wasAudioSkippedLastSeek()`), so
   prime/seek/refill call sites KNOW. Zero behavior change; enables 3-5.
3. **Retry-once at the driver (refill/seek/prime):** on audioSkipped, re-run the window
   once via the 4a rebuild shape (`skipInitSegment:false`) after the disk warmer/
   prefetch has warmed the region, with an EOF-style consecutive-counter guard
   (§4f) to prevent loops. Reuses 4a wholesale.
4. **Pre-fatal watchdog:** compare audio-vs-video buffered coverage after each window
   (needs per-track ranges — only obtainable via `video.buffered` vs SB.buffered on a
   combined SB, or by tracking appended audio timestamps in the transmuxer callbacks);
   on divergence > threshold, trigger 4a rebuild BEFORE the decoder hits the hole.
5. **Last resort — cross-tier:** on SB-fatal/video-error for an AVC-MKV (post-init),
   reroute to `/remux?audio_idx` via a 4c-shaped `_recoverToRemuxTier` MKV variant
   (dispose transmuxer + `remuxSourceIsTsRef=false` + resume at playhead), instead of
   today's dead `useNative` on raw MKV. ffmpeg guarantees playable AAC audio.

**No fix is implemented yet** — this document is the code-path map only. Interception
points above are candidates for the fix plan, not shipped changes.

---
*Report complete. All line numbers verified against `dev` @ `fb18253` working tree.*
