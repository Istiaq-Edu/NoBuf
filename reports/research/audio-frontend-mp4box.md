# NoBuf MP4 MSE Tier — Audio Track Selection, Segmentation & Switch Feasibility

Scope: `app/src/hooks/useMSEPlayer.ts` (8,877 lines), MP4/mp4box.js tier only (not MKV/TS transmuxer tiers). All line refs are to that file unless noted.

## 1. Track discovery & selection (`onReady` → `onMP4BoxReady`)

- `initMP4Box` wires `mp4box.onReady = (info) => onMP4BoxReady(info, url, mediaSource, mp4box, blobUrl)` at **:2553-2556**.
- `onMP4BoxReady` (**:6907**) guards against duplicate `onReady` firings via `state.current.initialized` (**:6913-6916**) — mp4box can re-fire after `flush()`, and Chrome's 2-SourceBuffer quota would otherwise be exhausted.
- Track extraction (**:6927-6945**): every `info.audioTracks` entry is copied into `state.current.audioTracks`, but only `{ id, codec, duration, timescale }` (**:6939-6944**). ALL audio tracks are stored — the list is multi-track-aware.
- **Selection is hardcoded to the first track**: `audioTrackId = state.current.audioTracks[0].id` (**:6982**) and `audioCodec = state.current.audioTracks[0].codec` (**:6987**). No language/name/default-flag logic exists.
- **Metadata gap**: the `MP4BoxTrack` interface (**:887-894**) declares only `id, codec, width?, height?, duration, timescale`. It does **not** capture `language`, `name`, `kind`, or `audio.channel_count`/`sample_rate`, even though mp4box.js's `onReady` info object provides them (`track.language`, `track.name`, `track.audio.channel_count` in mp4box's `getInfo()`). A track-picker UI would need the interface + the copy loop at :6938-6945 extended — the raw data is already in the `info` object at zero extra cost.
- `state.audioTracks` state shape: type decl **:1217**, initial value **:1467**, reset on teardown **:1737**.

## 2. Audio SourceBuffer creation & segment routing

- Audio SB is created **upfront** in `onMP4BoxReady` (not lazily in `onSegment` — see rationale comment **:6970-6978**): mime `audio/mp4; codecs="${audioCodec}"`, gated by `MediaSource.isTypeSupported` (**:7042-7043**), `mediaSource.addSourceBuffer(mimeType)` at **:7046**, wrapped in `SourceBufferWrapper` (**:7047**). On `QuotaExceededError` playback degrades to video-only (**:7049-7054**); unsupported audio codec also degrades to video-only (**:7055-7057**). (Video SB created the same way at **:6994**.)
- Segmentation setup (**:7073-7078**): `mp4box.setSegmentOptions(videoTrackId, {type:'video'}, {nbSamples:25})` (:7074) and `mp4box.setSegmentOptions(audioTrackId, {type:'audio'}, {nbSamples:25})` (:7077) — 25 samples ≈ 0.8 s so first segment flushes inside the first 512 KB chunk.
- `mp4box.initializeSegmentation()` at **:7081** returns per-track init segments; they are **cached** in `initSegmentsRef` (**:7084-7087**, cloned) and appended to the matching SB by comparing `seg.id` to `videoTrackId`/`audioTrackId` (**:7088-7098**).
- Segment routing: `mp4box.onSegment` (**:7113-7138**) routes by `trackId === videoTrackId` / `trackId === audioTrackId` (**:7129-7130**) and appends to the respective `SourceBufferWrapper`. **Note: these are the local closure variables captured in `onMP4BoxReady`, not `state.current.audioTrackId`** — mutating state alone would not re-route segments.
- Because moov-at-end files often store all audio after all video, `prefetchAudioData(url, mp4box, audioTrackId)` (**:6769-6837**, invoked **:7175**) reads the selected track's sample table via `getTrackSamplesInfo` (:6773), computes its byte extent (:6779-6782), and range-fetches it in 2 MB chunks into `mp4box.appendBuffer` with correct `fileStart` (:6820-6823). The fetched extent is recorded in the single-slot `audioPrefetchedRangeRef` (:6797) so the main `downloadLoop` skips it (**:7321-7327**). This mechanism is single-track by construction.

## 3. Seek re-segmentation path

Seeks are handled inside `downloadLoop`'s `pendingSeek` branch (**:7244-7318**):

1. `resetForSeek()` on both video and audio `SourceBufferWrapper`s (**:7253-7258**) — clears buffered media.
2. `clearDownloadedRanges()` (**:7261**).
3. `state.current.mp4box!.seek(seekTime, true)` **then** `mp4box.flush()` (**:7265-7266**) — seek repositions the sample cursor to the nearest sync sample while the sample table is intact; `seek` returns `{offset}` used as the new `currentOffset` (**:7269-7290**).
4. Cached init segments are re-appended per track (**:7304-7314**) so new media segments decode.
5. `prefetchAudioData` re-runs for the (same) audio track (**:7316-7318**).

Crucially, the seek path **never** calls `unsetSegmentOptions`, `releaseUsedSamples`, or `resetSampleTables` — grep confirms zero call sites in useMSEPlayer.ts; those APIs exist only inside the vendored library (`app/node_modules/mp4box/dist/mp4box.all.js` :6675 `unsetSegmentOptions` — a simple `fragmentedTracks.splice` — and :7143 `releaseUsedSamples`, which mp4box invokes internally to discard consumed samples). Fragmentation options are set **once** at init and survive every seek; only the cursor, buffers, and init segments are recycled.

## 4. Verdict: mid-playback audio-track switch

**In-place switching via `unsetSegmentOptions(oldId)` + `setSegmentOptions(newId)` is theoretically expressible but practically fragile; a full player re-init from the current playhead (same UX cost as an unbuffered seek) is the realistic robust path.** Reasons:

- `initializeSegmentation()` is a one-shot setup API: mp4box.js builds the fragmented output moov from the `fragmentedTracks` list at that moment. Calling `setSegmentOptions` for a new track mid-stream gives it no init segment unless `initializeSegmentation()` is re-run, which regenerates state for *all* fragmented tracks and is not exercised anywhere as a mid-stream operation (:7081 is its only call site).
- mp4box has already **discarded consumed samples** of the file via internal `releaseUsedSamples` (dist :7143), and the new track's media bytes were likely never fetched — `prefetchAudioData`/`audioPrefetchedRangeRef` (:6797) track exactly one range for one track, and `downloadLoop`'s skip logic (:7324) assumes it.
- `onSegment` routing and init-segment re-append compare against the **closure-captured** `audioTrackId` (:7130) and `state.current.audioTrackId` (:7310) respectively; a switch would have to rebind both, plus handle codec changes on the audio SB (`SourceBuffer.changeType` or remove/re-add — colliding with the Chrome 2-SB quota guard at :6909-6916).
- By contrast, the codebase already has a complete, battle-tested "rebuild from time T" story: teardown resets `state.current` (:1737 zeroes `audioTracks` etc.), `loopGeneration` invalidates the old loop (:7187), and the seek path proves buffers+init-segments can be rebuilt in ~one round trip. A switch implemented as *teardown → re-init with `preferredAudioTrackId` overriding the `[0]` pick at :6982 → seek to saved `currentTime`* touches ~3 lines of selection logic plus a plumbed-through preference, versus re-plumbing mp4box's fragmentation lifecycle.

**Recommended mechanism**: store `preferredAudioTrackId` in a ref; on switch, capture `video.currentTime`, run the existing cancel/cleanup path, re-run `initMP4Box`, have :6982/:6987 select `audioTracks.find(t => t.id === preferred) ?? audioTracks[0]`, then issue the normal pendingSeek to the captured time. Extend `MP4BoxTrack` (:887) with `language?/name?/audio?{channel_count,sample_rate}` and copy them at :6938-6945 to label the picker.
