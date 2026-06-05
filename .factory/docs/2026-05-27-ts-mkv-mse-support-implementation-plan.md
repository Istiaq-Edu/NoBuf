## Implementation Plan: .ts + .mkv MSE Support with Popular Codecs

### Architecture Overview

**Core Decision**: Create separate format-specific player modules (`TSPlayer`, `MKVPlayer`) that the existing `useMSEPlayer` hook delegates to based on format detection. This keeps the ~1900-line MP4 logic untouched and makes each format handler independent.

```
useMSEPlayer.ts (format router + shared MSE infrastructure)
  │
  ├── detectFormat(firstChunk) → 'mp4' | 'ts' | 'mkv' | 'unknown'
  │
  ├── MP4 path (existing code, unchanged)
  │     └── mp4box.js → fMP4 → SourceBuffer
  │
  ├── TS path (new TSPlayer module)
  │     └── mux.js (lazy-loaded) → fMP4 → SourceBuffer
  │
  ├── MKV path (new MKVPlayer module)
  │     ├── H.264+AAC: EBML parser → fMP4 muxer → SourceBuffer
  │     └── VP9+Opus: EBML parser → WebM muxer → SourceBuffer
  │
  └── Unknown: DirectVideoPlayer (native fallback)
```

### Files to Create/Modify

#### New Files

1. **`app/src/lib/faststream/utils/FormatDetector.ts`** (~60 LOC)
   - `detectFormat(buffer: ArrayBuffer, filename?: string): FormatType`
   - Checks magic bytes: ftyp→mp4, 0x47 sync→ts, EBML 0x1A45DFA3→mkv
   - Also checks file extension as secondary signal
   - Returns `'mp4' | 'ts' | 'mkv' | 'unknown'`

2. **`app/src/lib/faststream/players/TSPlayer.ts`** (~400 LOC)
   - Uses mux.js Transmuxer (lazy-loaded via dynamic import)
   - `initTSMSE(url, mediaSource, firstChunk)` — creates transmuxer, feeds first chunk
   - TS-specific download loop — feeds chunks to transmuxer.push() + flush()
   - Transmuxer.on('data') → appends fMP4 init/media segments to SourceBuffer
   - TS seek: ratio estimation + progressive PTS↔byte mapping
   - Duration detection: probe first+last chunks for PTS values
   - Shares SourceBufferWrapper, evictOldBuffer, backpressure logic from hook

3. **`app/src/lib/faststream/players/MKVPlayer.ts`** (~500 LOC)
   - Custom minimal EBML parser (extracts: track info, codec IDs, CodecPrivate, Cues, duration)
   - H.264+AAC path: extract NALUs from SimpleBlocks → build fMP4 init segment (avcC from CodecPrivate) + media segments → SourceBuffer
   - VP9+Opus path: extract frames → build WebM init segment + Cluster segments → SourceBuffer
   - MKV seek using Cues element (time → byte offset mapping)
   - Subtitle extraction: parse subtitle tracks → convert SRT to WebVTT, ASS/SSA via jassub
   - Unsupported codecs: try native playback, fallback to error+download

4. **`app/src/lib/faststream/mux/fMP4Muxer.ts`** (~200 LOC)
   - Builds fMP4 init segments from codec parameters (avcC, esds)
   - Builds fMP4 media segments (moof + mdat) from frame data + timestamps
   - Used by both TSPlayer (after mux.js transmuxing) and MKVPlayer (H.264+AAC path)
   - Actually: TSPlayer uses mux.js which already produces fMP4 segments, so this is primarily for MKVPlayer

5. **`app/src/lib/faststream/mux/WebMMuxer.ts`** (~150 LOC)
   - Builds WebM init segments (EBML header + Segment Info + Tracks)
   - Builds WebM Cluster segments from frame data
   - Used by MKVPlayer for VP9+Opus/Vorbis content

6. **`app/src/lib/faststream/ebml/EBMLParser.ts`** (~300 LOC)
   - Minimal EBML parser: reads variable-length integers, element IDs, element sizes
   - Parses: EBML Header, Segment Info (duration, timecode scale), Tracks (codec ID, codec private, track type), Cues (time + track positions), Cluster (timecode + SimpleBlock/BlockGroup)
   - Streaming-friendly: can parse progressively as data arrives
   - Does NOT try to parse entire file — only extracts metadata and frame data we need

7. **`app/src/lib/faststream/subtitles/SubtitleRenderer.ts`** (~100 LOC)
   - Extracts SRT/ASS/SSA tracks from MKV via EBMLParser
   - SRT: convert to WebVTT, attach via `<track>` element
   - ASS/SSA: render via jassub (lazy-loaded, ~300KB WASM)

#### Modified Files

8. **`app/src/hooks/useMSEPlayer.ts`** (~100 LOC changes)
   - Add format detection at the beginning of `initMP4Box` (rename to `initPlayer`)
   - Route to appropriate handler: MP4→existing code, TS→TSPlayer, MKV→MKVPlayer, unknown→native
   - Expose shared MSE infrastructure: SourceBufferWrapper creation, evictOldBuffer, backpressure, download loop template, range reporting
   - Add TS/MKV-specific state to MSEState interface
   - The MP4-specific code (~1800 lines) stays untouched — only the initialization routing changes

9. **`app/src/lib/faststream/enums/PlayerModes.ts`** (~5 LOC)
   - Add `ACCELERATED_TS: 'accelerated_ts'` and `ACCELERATED_MKV: 'accelerated_mkv'`

10. **`app/src/utils.ts`** (~0 LOC changes)
    - `.ts` and `.mkv` are already in VIDEO_EXTENSIONS — no changes needed

### New Dependencies

11. **`app/package.json`** — add:
    - `mux.js` (for TS→fMP4 transmuxing, ~30KB gz, lazy-loaded)
    - `jassub` (for ASS/SSA subtitle rendering, ~300KB, lazy-loaded)
    - No ebml.js — we write our own minimal parser

### Codec Handling Strategy

| Input | Codec | MSE Path | Fallback |
|-------|-------|----------|----------|
| TS + H.264+AAC | avc1+mp4a | mux.js → fMP4 → MSE ✅ | N/A |
| TS + H.264+MP3 | avc1+mp3 | mux.js → fMP4 → MSE ✅ | N/A |
| TS + H.265 | hevc | mux.js → fMP4 → MSE ⚠️ (Safari) | Native playback |
| TS + AC-3/DTS | ac-3/dts | mux.js drops audio | Native playback, error if native fails |
| MKV + H.264+AAC | V_MPEG4/ISO/AVC + A_AAC | fMP4Muxer → MSE ✅ | N/A |
| MKV + VP9+Opus | V_VP9 + A_OPUS | WebMMuxer → MSE ✅ | N/A |
| MKV + VP8+Vorbis | V_VP8 + A_VORBIS | WebMMuxer → MSE ✅ | N/A |
| MKV + H.265 | V_MPEG/H265 | No MSE support | Native playback, error if native fails |
| MKV + AC-3/DTS | A_AC3/A_DTS | No MSE support | Native playback, error if native fails |

### Seek Strategy

- **MP4**: mp4box.seek() (exact byte offset) — unchanged
- **TS**: Ratio estimation `(time/duration)*fileLength` initially, scan forward for 0x47 sync bytes, recreate Transmuxer, build PTS↔byte table progressively
- **MKV**: Cues element (built-in seek index: time → Cluster byte offset), parse Cues during initialization

### Duration Detection

- **MP4**: moov.mvhd — unchanged
- **TS**: Probe first 512KB + last 512KB, extract PTS from first/last PES packets
- **MKV**: Segment.Info.Duration element (explicitly stored in most MKV files)

### Loading Strategy

- **mux.js**: Lazy-loaded via `import('mux.js')` only when TS format detected
- **jassub**: Lazy-loaded via `import('jassub')` only when MKV with ASS subtitles detected
- **EBMLParser**: Bundled (custom code, ~300 LOC, no external dependency)
- **fMP4Muxer/WebMMuxer**: Bundled (custom code, ~350 LOC total, no external dependency)

### Implementation Order

1. **FormatDetector + routing in useMSEPlayer** — foundation for everything
2. **TSPlayer** — simpler, validates the architecture pattern
3. **EBMLParser** — foundation for MKV
4. **fMP4Muxer + WebMMuxer** — output format builders
5. **MKVPlayer** — the most complex piece
6. **SubtitleRenderer** — ASS/SSA via jassub
7. **Testing + edge case handling** — unsupported codecs, error messages

### Edge Cases to Handle

- Audio-only TS files (radio streams)
- MKV files with multiple video/audio tracks (select first video + first audio)
- MKV attachments (fonts for ASS subtitles)
- Variable framerate MKV files
- TS PTS wraparound (33-bit counter)
- MKV without Cues element (fall back to ratio estimation for seeking)
- False positive TS detection (TypeScript .ts files won't have 0x47 sync bytes)
- Interlaced H.264 content in TS
- Very large MKV files (10GB+) — stream-parse, never load entirely

### Estimated Total: ~1,700 LOC new code + ~100 LOC modifications