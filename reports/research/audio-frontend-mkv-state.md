# MKV Mediabunny Tier — Audio Track Selection: Current State

Scope: `app/src/lib/faststream/players/MediabunnyTransmuxer.ts` (transmuxer) + `app/src/hooks/useMSEPlayer.ts` (driver/UI surface). Question: where is audio picked today, what would a track switch reuse, and where would `audioTracks`/`switchAudioTrack` surface?

---

## 1. How audio is picked today: `getPrimaryAudioTrack()` — 4 call sites, zero choice

All four sites call mediabunny's `input.getPrimaryAudioTrack()` — i.e. **the first/default audio track**. There is no track enumeration (`getAudioTracks()` is never called), no languageCode/trackId parameter anywhere, no persisted selection state.

| Site | Path | What consumes the returned track |
|---|---|---|
| `MediabunnyTransmuxer.ts:331` | `init()`, TS branch (probe on in-memory `initInput` seed) | Codec probe only: `getCodec()` (:335), `getCodecParameterString()` (:338) → `decideMseCodec` (:340), `buildMimeType` (:348), and `this.audioTrackInfo` metadata `{codec, sampleRate, channels, language, codecParameterString}` (:365-372). No Output yet. |
| `MediabunnyTransmuxer.ts:427` | `init()`, **MKV branch** (on the persistent `this.input`, :391) | Same probe → `mseDecision`/`mimeType` (:436-450), `audioTrackInfo` (:461-468). Then `setupOutput()` (:470) and `Conversion.init({input, output})` (:474) — **the Conversion is track-agnostic**: it takes the whole Input and internally converts its primary tracks. Note: for MKV playback this Conversion is effectively vestigial — the driver never calls the unbounded `startTransmuxing()`/`Conversion.execute()` (see useMSEPlayer.ts:6118-6128 comment); all data production runs through `seekTo()`'s manual packet-copy path. |
| `MediabunnyTransmuxer.ts:886` | `produceSegmentsFromInitInput()` (TS phase 1) | Manual copy pipeline: `new EncodedAudioPacketSource(this.audioCodec)` (:893), `output.addAudioTrack(audioSource)` (:896), `EncodedPacketSink(audioTrack)` (:913), `audioSink.getKeyPacket(keyframeTimestamp, {verifyKeyPackets:false})` (:914), then `iterateAudioPackets(...)` (:930-934). |
| `MediabunnyTransmuxer.ts:982` | `sequentialContinue()` (TS phase 2) | Identical pipeline: audioSource (:1003), `addAudioTrack` (:1006), sink + `getKeyPacket` (:1023-1027), iterate. |

**Fifth (undocumented in task but the one that matters for MKV):** `MediabunnyTransmuxer.ts:1321` inside `seekTo()` — `const audioTrack = await this.input.getPrimaryAudioTrack();`. This is the hot path every MKV prime/seek/refill runs. Consumption (:1424-1482):
- `new EncodedAudioPacketSource(this.audioCodec)` (:1425) — codec captured at init
- `localOutput.addAudioTrack(audioSource)` (:1430) — **no option object**; the video counterpart is likewise `addVideoTrack(videoSource)` bare (:1428)
- `audioTrack.getDecoderConfig()` → `audioMeta` (:1440-1442)
- `audioSink.getKeyPacket(keyframeTimestamp, {verifyKeyPackets:false})` (:1460); on null → `audioSource.close()`, audio skipped for this window (:1463-1470)
- `iterateAudioPackets(audioSink, audioStartPacket, ..., keyframeTimestamp, generation, maxDuration, stopTime)` (:1478-1482), run concurrently with video (:1485)

**Injection point for a switchable design:** replace `this.input.getPrimaryAudioTrack()` at :1321 (and :427 for init-time metadata) with a resolver like `getAudioTrackById(this.desiredAudioTrackId)` over `input.getAudioTracks()`. Everything downstream is already generic — sink, packet source, `addAudioTrack`, iterate — as long as `this.audioCodec`/`audioTrackInfo` are re-derived from the newly chosen track (codec may differ across tracks, which changes `mimeType` → new init segment required; `setupOutput` regenerates init segments per seek generation already at :539-605, `skipInitSegment=false` path emits ftyp+moov via `onFtyp`/`onMoov` :545-558).

## 2. Rebuild machinery a track switch would reuse

**Entry point: `MediabunnyTransmuxer.seekTo(seekTime, maxDuration, {skipInitSegment, stopTime})` (:1215).** A track switch is exactly "seek to playhead with a different audio track":

Transmuxer side (:1215-1500): set `seekAbortFlag` (:1219) → abort in-flight HTTP (:1227) → bump `seekGeneration` (:1230, all Output callbacks are generation-guarded :546/551/560/565) → cancel `Conversion` (:1233-1240) → **MKV keeps its persistent Input** (`reuseMkvInput`, :1249 — cached SeekHead/Cues survive, so a switch pays no metadata re-parse) → clear output state (:1256-1260) → resolve keyframe via cue index `nearestCueKeyframeAtOrBefore` (:1345) + `getKeyPacket` (:1369) → `setupOutput(gen, skipInit)` (:1419) → fresh packet sources + `addVideoTrack`/`addAudioTrack` (:1424-1431) → `output.start()` (:1434) → concurrent video/audio iteration (:1475-1485) → `finalize()` (:1494).

Driver side (useMSEPlayer.ts) — the buffer flush + refill chain wrapped around `seekTo`:
- **User seek** (`seekTo` callback :7537, transmuxer branch :7927): bump `transmuxerSeekGenRef` (:8008), `bufferingForSeekRef=true` + `seekBufferRef=[]` (:8083-8084), `resetForSeek()` on video (and audio, if present) SourceBuffers (:8086-8089) — **this is the buffer flush**, then `transmuxer.seekTo(clampedTime, SEEK_START_DURATION, {stopTime})` (:8098), supersession guard (:8110), `setTimestampOffset(keyframeTimestamp)` (:8118-8121), flush buffered segments, then hand off to the refill chain.
- **Refill chain**: `startStreamingChain()` (:2180-2188) → `executeStreamingRefill()` (:2211) loops: backpressure cap (:2234), refill from buffer end snapped to cue keyframe (:2263), keyframe-abutting `stopTime` via `nextKeyframeAtOrAfter` (:2278), `transmuxer.seekTo(refillPosition, maxDuration, {skipInitSegment:true, stopTime})` (:2291), chains itself (:2478/2491). `stopStreamingChain()` (:2190) bumps chain gen + `transmuxer.abortSeek()`.
- **Initial MKV prime** reuses the same shape: bounded `transmuxer.seekTo(0, INITIAL_SEEK_DURATION, {stopTime: primeStop})` (:6137) then chain.

**A `switchAudioTrack(id)` implementation =** set desired track on the transmuxer → `stopStreamingChain()` → SourceBuffer `resetForSeek()` flush → `transmuxer.seekTo(video.currentTime, SEEK_START_DURATION, {skipInitSegment:false})` (init segment must NOT be skipped — new audio codec/track config needs a fresh ftyp+moov) → `setTimestampOffset` → flush → `startStreamingChain()`. All pieces exist; only the track override plumbing is new.

## 3. Where the transmuxer is constructed in useMSEPlayer

- `transmuxerRef = useRef<MediabunnyTransmuxer | MuxJsTsTransmuxer | null>(null)` (:1367); assigned at :6112.
- MKV construction: `_initMkvTransmuxerPlayer()` (:5933) — `new MediabunnyTransmuxer({format:'mkv', sourceConfig:{url, fileSize, maxCacheSize:32MiB, prefetchProfile:'network', seedData, sourceId:'playback'}, onInitSegment, onMediaSegment, onDurationKnown, onProgressUpdate, onCodecUnsupported, onError})` (:5939-6020). `init()` awaited at :6036; single **combined** (muxed A+V) SourceBuffer created from `result.mimeType` (:6080-6083) — note MKV has no separate `audioSourceBuffer`; audio rides in the same fMP4 segments. Constructed once per file; disposed at :1923/:1990 on teardown, never re-constructed for seeks (seeks reuse the instance via `seekTo`).

## 4. Hook return-object surface (where audioTracks/switchAudioTrack slots in)

The hook's UI contract is the single `return {...}` at **useMSEPlayer.ts:8798-8855**: `mseUrl, remuxUrl, error, useNative, unsupportedCodec, prefetchedBytes, totalBytes, isPrefetching, isPaused, isComplete, pausePrefetch, resumePrefetch, seekTo, suppressLoadingSpinnerRef, setVideoRef, downloadedTimeRanges, byteToTime, recordByteTimeAnchor, getMp4Box, getFileLength, getMoovBuffer, getFirstChunk, getInitSegments, getVideoTrackInfo, getMP4BoxClass, isTransmuxer, getFormat, getKnownDuration, isTransmuxerActive, getKeyframeTimestamps, getKeyframeByteOffsets, getTsHeaderData, getTransmuxerSourceConfig, isFmp4Stream, getFmp4Config, getRemuxThumbConfig, isColdStartBuffering, coldStartProgress, coldStartPhase, detectedFormat, keyframeIndexReady, thumbnailDataReady, moovBufferReady, getShadowCache, mpegtsDuration`.

**No audio-track surface exists today.** The only `audioTracks` in the file is internal MP4Box demuxer state (`state.current.audioTracks: MP4BoxTrack[]`, :1217/:1467/:1737, populated from mp4box `info.audioTracks` at :6938-6940 and hard-picked `[0]` at :6982-6987) — never exposed. A switchable design would add to the return object: `audioTracks` (state array of `{id, language, codec, channels}` — for MKV sourced from a new `transmuxer.getAudioTracks()` over mediabunny's `input.getAudioTracks()`), `activeAudioIdx` (state), and `switchAudioTrack(idx)` (a `useCallback` performing the §2 rebuild), sitting naturally next to `seekTo`/`getVideoTrackInfo` (:8812/:8823).

## 5. Pause survival across rebuilds ("paused means paused")

`isPausedRef` (:1249 — `useRef(false)`, "so seekTo can check without React state delay") is set true only by `pausePrefetch()` (:8550) and false only by `resumePrefetch()` (:8589) — never touched by any seek/rebuild path, so pause state survives player recreation, transmuxer seeks, and refill chains untouched. Rebuild paths *consult* it rather than mutate it: `decideTsSeekAction(isPausedRef.current, …)` gates seeks to buffered/cache-only while paused with a `blocked-paused` outcome that records the target and defers the fetch to resume (:7616, :7641-7649); post-seek proactive-prebuffer restarts are gated on `!isPausedRef.current` (:5771, :3992, :8501), so "the seek reposition report is gated on !isPausedRef" (:7474-7475) and only the explicit resume button restarts Telegram downloads.
