# MPEG-TS (.ts) Support in NoBuf MSE Player

> **Research Date:** May 2026
> **Status:** Future Implementation
> **Relevant Files:** `app/src/hooks/useMSEPlayer.ts`, `app/src/lib/faststream/players/MP4Player.ts`

---

## 1. Why .ts Files Don't Work with the Current Pipeline

The current MSE pipeline in `useMSEPlayer.ts` (lines 486–492) checks for an `ftyp` box at byte offset 4–7:

```ts
const boxType = String.fromCharCode(
  view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7)
);
if (boxType !== 'ftyp' && boxType !== 'jP  ') {
  setUseNative(true); // Falls back to native <video>
  return;
}
```

MPEG-TS files start with a **sync byte** (`0x47`) at every 188-byte packet boundary — they never contain an `ftyp` box. So **every .ts file currently falls back to native playback**, losing all MSE benefits (chunked streaming, buffer management, seek-to-unbuffered, prefetch).

---

## 2. MPEG-TS Container Format Fundamentals

### 2.1 Structure
- **Packet-based**: fixed 188-byte packets (or 204 bytes with FEC)
- Each packet starts with sync byte `0x47`
- **Packet Identifier (PID)** distinguishes streams (video, audio, PAT, PMT)
- **PAT (Program Association Table)**: PID 0, maps program numbers to PMT PIDs
- **PMT (Program Map Table)**: lists elementary streams and their codecs

### 2.2 Common Codecs in .ts Files
| Codec | Stream Type | Description |
|-------|-----------|-------------|
| H.264/AVC | `0x1B` | Most common, well-supported |
| H.265/HEVC | `0x24` | Growing prevalence, limited MSE support |
| MPEG-2 Video | `0x02` | Legacy broadcast, declining |
| AAC (ADTS) | `0x0F` | Most common audio |
| AAC (LATM) | `0x11` | Alternative AAC framing |
| AC-3 (Dolby Digital) | `0x81` | Surround sound, NOT supported by MSE |
| DTS | `0x82` | Surround sound, NOT supported by MSE |
| MP3 (MPEG-1 Audio) | `0x04` | Legacy audio |
| Teletext/Subtitles | Various | DVB subtitles, teletext |

### 2.3 Why MSE Can't Accept TS Directly
MSE only supports **ISO BMFF** (fragmented MP4) and **WebM** container formats:
- `MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')` → `true`
- `MediaSource.isTypeSupported('video/mp2t; codecs="avc1.42E01E"')` → **`false`** everywhere

The browser's MSE implementation has no TS demuxer. The data must be **transmuxed** from TS to fMP4 before it reaches `SourceBuffer.appendBuffer()`.

---

## 3. The Transmuxing Pipeline

```
┌──────────────┐     ┌───────────────┐     ┌───────────────┐     ┌─────────────┐
│  TS File     │────▶│  TS Demuxer   │────▶│  fMP4 Remuxer │────▶│  MSE        │
│  (188-byte   │     │  Extracts:    │     │  Produces:    │     │ SourceBuffer│
│   packets)   │     │  - PES packets│     │  - init seg   │     │ .append()   │
│              │     │  - elementary │     │  - media segs │     │             │
│              │     │    streams    │     │    (moof+mdat)│     │             │
└──────────────┘     └───────────────┘     └───────────────┘     └─────────────┘
```

### Step-by-step:
1. **Parse TS packets**: Read 188-byte packets, extract PID, continuity counter
2. **Parse PAT/PMT**: Discover program structure and codec types
3. **Extract PES packets**: Reassemble elementary stream data from TS packets
4. **Parse elementary stream headers**: NAL units for H.264, ADTS frames for AAC
5. **Generate fMP4 init segment**: `ftyp` + `moov` with codec parameter sets
6. **Generate fMP4 media segments**: `moof` + `mdat` with sample tables and data
7. **Feed to MSE**: Append init segment first, then media segments sequentially

---

## 4. Available Libraries (Validated)

### 4.1 mux.js (by videojs) — ⭐ RECOMMENDED for transmuxing

| Property | Value |
|----------|-------|
| **npm** | `mux.js` |
| **GitHub** | [videojs/mux.js](https://github.com/videojs/mux.js) |
| **Stars** | ~1,800+ |
| **Last Update** | Actively maintained (2025) |
| **Bundle Size** | ~80KB min, ~30KB gzipped (transmuxer only) |
| **License** | Apache-2.0 |

**What it does:** Standalone TS → fMP4 transmuxer. This is the same transmuxer used internally by hls.js. It takes raw TS bytes and outputs fMP4 segments ready for MSE.

**Key capabilities:**
- H.264/AVC transmuxing ✓
- AAC (ADTS + LATM) transmuxing ✓
- H.265/HEVC transmuxing ✓ (added in recent versions)
- MP3 transmuxing ✓
- Generates proper fMP4 init + media segments
- WebWorker-compatible
- TypeScript types included
- Streaming: can feed data incrementally

**Usage pattern for our pipeline:**
```ts
import { Transmuxer } from 'mux.js';

const transmuxer = new Transmuxer();
transmuxer.on('data', (segment) => {
  // segment.initSegment — fMP4 init segment (ftyp + moov)
  // segment.data — fMP4 media segment (moof + mdat)

  // Feed to our existing SourceBufferWrapper
  if (initSegmentsRef.current.length === 0) {
    sourceBuffer.appendBuffer(segment.initSegment);
    initSegmentsRef.current.push(segment.initSegment);
  }
  sourceBuffer.appendBuffer(segment.data);
});

// Feed TS chunks from our existing Range-request download loop
transmuxer.push(new Uint8Array(tsChunkData));
transmuxer.flush(); // Signal end of data to produce segment
```

**Integration with our architecture:**
- Replace the `mp4box.js` parsing path when TS is detected
- Keep the existing `SourceBufferWrapper` for buffer management
- Keep the existing `evictOldBuffer()` logic
- Use the same chunk download loop (Range requests) but feed to `Transmuxer` instead of `mp4box`
- Seek: flush transmuxer, re-seek download position, feed new chunks

**Pitfalls:**
- The `Transmuxer` expects sequential TS data — after a seek, you must create a new transmuxer instance or call `.flush()` with a new `baseMediaDecodeTime`
- H.265 support is newer and may have edge cases with certain encoder configurations
- AC-3/DTS audio will be silently dropped (mux.js doesn't handle them)

---

### 4.2 mpegts.js (by xqq) — Best for full TS playback

| Property | Value |
|----------|-------|
| **npm** | `mpegts.js` |
| **GitHub** | [xqq/mpegts.js](https://github.com/xqq/mpegts.js) |
| **Stars** | ~7,500+ |
| **Last Update** | Actively maintained (2025) |
| **Bundle Size** | ~200KB min, ~70KB gzipped |
| **License** | Apache-2.0 |

**What it does:** Full-featured MPEG-TS/FLV player built on MSE. Fork of bilibili's flv.js with TS support added. Includes its own TS demuxer and fMP4 remuxer.

**Key capabilities:**
- Complete TS demuxer (PAT/PMT/PES parsing)
- H.264, H.265/HEVC, MPEG-2 video
- AAC (ADTS + LATM), MP3, AC-3 audio
- Built-in MSE controller with buffer management
- WebWorker support for demuxing
- HTTP Range request support (partial loader)
- Seek support with keyframe index

**Why it's powerful:** It handles the entire pipeline — demux, remux, MSE buffer management, seek logic. But it's a complete player, not a standalone transmuxer.

**Why it may not fit our architecture:**
- It wants to own the `<video>` element and MSE pipeline entirely
- Our `useMSEPlayer.ts` has sophisticated buffer management (eviction, VBR lookup table, byte-to-time mapping, backend range reporting) that would conflict with mpegts.js's internal buffer manager
- Would require significant refactoring to integrate as a library rather than a player

**Best use case:** If we wanted to replace the entire MSE pipeline for TS files, mpegts.js would be the most complete solution. But our custom buffer management is a competitive advantage.

---

### 4.3 hls.js — Has TS demuxer but overkill

| Property | Value |
|----------|-------|
| **npm** | `hls.js` |
| **GitHub** | [video-dev/hls.js](https://github.com/video-dev/hls.js) |
| **Stars** | ~14,500+ |
| **Last Update** | Actively maintained (2025) |
| **Bundle Size** | ~300KB min, ~100KB gzipped |
| **License** | Apache-2.0 |

**Relevance:** hls.js uses mux.js internally for TS → fMP4 transmuxing. It's a full HLS player, not suitable as a standalone TS transmuxer.

**Verdict:** Don't use directly. Use `mux.js` instead — it's the transmuxer extracted from hls.js.

---

### 4.4 mp4box.js — Already used, but NO TS support

| Property | Value |
|----------|-------|
| **npm** | `mp4box` |
| **GitHub** | [gpac/mp4box.js](https://github.com/gpac/mp4box.js) |
| **Stars** | ~1,400+ |
| **Status** | Already in our project (`^0.5.2`) |

**TS support:** **None.** mp4box.js is an ISO BMFF (MP4) parser/segmenter. It cannot read MPEG-TS files. It's the wrong tool for this job.

---

### 4.5 ffmpeg.wasm — Nuclear option

| Property | Value |
|----------|-------|
| **npm** | `@ffmpeg/ffmpeg` |
| **GitHub** | [ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) |
| **Stars** | ~13,500+ |
| **Bundle Size** | ~30MB (!!!) core wasm |
| **License** | LGPL/GPL |

**What it does:** Full FFmpeg compiled to WebAssembly. Can transcode anything to anything.

**Pros:**
- Supports ALL codecs (H.264, H.265, MPEG-2, AC-3, DTS, VP9, AV1, etc.)
- Can convert TS → MP4 with any codec combination
- Handles broken/malformed files that other parsers choke on

**Cons:**
- **30MB+ wasm download** — unacceptable for a streaming player
- Very slow — real-time transmuxing of 1080p video is not feasible
- Memory-hungry — loads entire file into WASM memory
- Not streaming-friendly — needs the whole file or large chunks

**Verdict:** Useful as a **backend fallback** for rare codecs, NOT for real-time MSE streaming. Consider for Tauri backend: use Rust's ffmpeg bindings to transcode AC-3/DTS to AAC before sending to frontend.

---

## 5. Codec Support Matrix

| Codec | mux.js | mpegts.js | MSE Browser Support |
|-------|--------|-----------|-------------------|
| H.264/AVC | ✅ | ✅ | ✅ All browsers |
| H.265/HEVC | ✅ (newer) | ✅ | ⚠️ Safari only (Chrome: behind flag) |
| MPEG-2 Video | ❌ | ✅ | ❌ No MSE support |
| AAC (ADTS) | ✅ | ✅ | ✅ All browsers |
| AAC (LATM) | ✅ | ✅ | ✅ All browsers |
| MP3 | ✅ | ✅ | ✅ Most browsers |
| AC-3 (Dolby) | ❌ | ✅ | ❌ No MSE support |
| DTS | ❌ | ❌ | ❌ No MSE support |
| Opus | ❌ | ❌ | ✅ (in WebM only) |

**Critical gap:** AC-3 and DTS audio cannot be fed to MSE at all — no browser supports these codecs in SourceBuffers. Files with AC-3/DTS audio would need server-side transcoding (Tauri/Rust backend) to AAC before MSE playback.

---

## 6. MSE Browser Codec Strings for Transmuxed TS Content

After transmuxing TS to fMP4, the codec strings for `MediaSource.isTypeSupported()` are:

```
// H.264 profiles
'video/mp4; codecs="avc1.42E01E"'        // Baseline, Level 3.0
'video/mp4; codecs="avc1.4D401E"'        // Main, Level 3.0
'video/mp4; codecs="avc1.640028"'        // High, Level 4.0

// H.265/HEVC (Safari only in most cases)
'video/mp4; codecs="hvc1.1.6.L93.B0"'   // HEVC Main

// AAC audio
'audio/mp4; codecs="mp4a.40.2"'          // AAC-LC
'audio/mp4; codecs="mp4a.40.5"'          // HE-AAC

// MP3 audio
'audio/mp4; codecs="mp3"'                // MPEG-1 Audio Layer 3
```

**Note:** The transmuxer (mux.js) automatically determines the correct codec string from the TS stream's codec parameters (SPS/PPS for H.264, AudioSpecificConfig for AAC).

---

## 7. Integration Architecture for NoBuf

### 7.1 Detection Phase (modify `useMSEPlayer.ts`)

Add TS detection before the ftyp check:

```ts
// After fetching first chunk (line ~486)
const isTsFile = detectTsFormat(data);
if (isTsFile) {
  await initTSMSE(url, mediaSource, blobUrl, data);
  return;
}

function detectTsFormat(buffer: ArrayBuffer): boolean {
  const view = new Uint8Array(buffer);
  // Check for TS sync byte (0x47) at offset 0 and at offset 188
  // Multiple checks to avoid false positives
  if (view[0] === 0x47 && view[188] === 0x47 && view[376] === 0x47) {
    return true;
  }
  return false;
}
```

### 7.2 TS MSE Initialization (new function)

```ts
const initTSMSE = async (
  url: string,
  mediaSource: MediaSource,
  blobUrl: string,
  firstChunk: ArrayBuffer
) => {
  const { Transmuxer } = await import('mux.js');

  const transmuxer = new Transmuxer({ keepOriginalTimestamps: true });
  let initSegmentAppended = false;

  transmuxer.on('data', (segment: any) => {
    if (cancelledRef.current) return;

    if (!initSegmentAppended) {
      // Append fMP4 init segment
      const initBuffer = segment.initSegment;
      state.current.videoSourceBuffer?.appendBuffer(initBuffer);
      initSegmentAppended = true;
    }

    // Append fMP4 media segment
    evictOldBuffer();
    state.current.videoSourceBuffer?.appendBuffer(segment.data);
  });

  // Feed the first chunk
  transmuxer.push(new Uint8Array(firstChunk));
  transmuxer.flush();

  // Continue with the download loop, feeding chunks to transmuxer
  // instead of mp4box
  state.current.tsTransmuxer = transmuxer;
  state.current.initialized = true;
  state.current.currentOffset = firstChunk.byteLength;
};
```

### 7.3 Seek Handling

Seeking in TS is different from MP4:
- **MP4**: mp4box has a built-in seek() that gives the exact byte offset for any time
- **TS**: No random access table — must binary-search for sync bytes and PES timestamps

Strategy:
1. Estimate byte position: `seekByte = (seekTime / duration) * fileLength`
2. Seek to nearest sync byte (`0x47`) by scanning forward
3. Create a new `Transmuxer` instance (reset state)
4. Set `baseMediaDecodeTime` to the seek timestamp
5. Feed chunks from the seek position

### 7.4 Duration Detection

TS files don't have a global duration header like MP4's `mvhd` box. Options:
1. **Scan the entire file** — parse PES timestamps from first and last packets (slow)
2. **Estimate from file size** — `duration ≈ fileSize / averageBitrate` (inaccurate)
3. **Parse the last few MB** — fetch the tail, find the last PTS, calculate duration
4. **Use a HEAD + tail probe**: fetch first 512KB + last 512KB, extract PTS values

Recommendation: Option 4 — fast and reasonably accurate for most files.

---

## 8. Performance Considerations

| Factor | Impact | Mitigation |
|--------|--------|-----------|
| **Transmuxing CPU** | ~5-15% CPU for 1080p H.264 | Run in WebWorker |
| **Memory** | ~2-5MB for transmuxer buffers | Flush after each segment |
| **Latency to first frame** | +50-100ms for transmuxing | Minimal — acceptable |
| **Seek latency** | Higher than MP4 (no random access table) | Cache PTS↔byte mappings |
| **Bundle size** | +30-80KB for mux.js | Lazy load only when TS detected |

### WebWorker Integration

mux.js supports WebWorker operation:

```ts
// In a dedicated worker file: ts-transmux-worker.ts
import { Transmuxer } from 'mux.js';

let transmuxer: Transmuxer | null = null;

self.onmessage = (e) => {
  if (e.data.type === 'init') {
    transmuxer = new Transmuxer(e.data.options);
    transmuxer.on('data', (segment) => {
      self.postMessage({
        type: 'segment',
        initSegment: segment.initSegment,
        data: segment.data,
      }, [segment.initSegment, segment.data]); // Transfer ownership
    });
  } else if (e.data.type === 'push') {
    transmuxer?.push(new Uint8Array(e.data.data));
    transmuxer?.flush();
  } else if (e.data.type === 'seek') {
    transmuxer?.destroy();
    transmuxer = new Transmuxer({ ...e.data.options });
    // Re-attach handler
  }
};
```

---

## 9. Edge Cases and Pitfalls

### 9.1 Audio-Only TS
Some .ts files contain only audio (radio streams). mux.js handles this but produces `audio/mp4` init segments instead of `video/mp4`.

### 9.2 Multiple Programs
A single TS file can contain multiple programs (e.g., different channels). The demuxer must select the correct program (usually the first one, or the one with video).

### 9.3 Discontinuities
TS streams can have discontinuity indicators (timestamp resets). The transmuxer must handle PTS wrap-around (33-bit counter, wraps at 2^33).

### 9.4 Interlaced Content
H.264 interlaced content in TS may produce fMP4 segments that some MSE implementations reject. Deinterlacing flags must be preserved in the remuxed output.

### 9.5 Subtitle Streams
DVB subtitles and teletext in TS are NOT supported by MSE. They must be extracted separately and rendered as an overlay (WebVTT or custom renderer).

### 9.6 File Extension Ambiguity
`.ts` is also used for TypeScript files. In our app, we already handle this correctly in `utils.ts` — the `isVideoFile()` function checks the extension. However, TypeScript files won't pass the TS sync byte detection, so no false positives.

---

## 10. Recommended Implementation Plan

### Phase 1: Basic TS Support (mux.js)
1. Add `mux.js` as a dependency: `pnpm add mux.js @types/mux.js`
2. Add TS format detection (sync byte check)
3. Implement `initTSMSE()` using mux.js Transmuxer
4. Hook into existing download loop (feed chunks to transmuxer instead of mp4box)
5. Handle basic playback (play, pause, no seek yet)

### Phase 2: Seek Support
1. Implement PTS↔byte offset mapping (probe first/last chunks)
2. On seek: flush transmuxer, re-download from estimated position
3. Wire up `seekTo()` to the TS pipeline

### Phase 3: Polish
1. WebWorker for transmuxing (off-main-thread)
2. Buffer eviction integration
3. Progress bar / buffer visualization
4. Error handling for unsupported codecs (AC-3, DTS → show message)

### Phase 4: Advanced
1. H.265/HEVC support via mux.js (with browser detection)
2. Subtitle extraction (DVB/teletext → WebVTT overlay)
3. Duration probing from file tail
4. Backend transcoding for AC-3/DTS → AAC (Tauri/Rust ffmpeg)

---

## 11. File Size Estimate for Implementation

| Component | Lines of Code | New Dependencies |
|-----------|--------------|-----------------|
| TS detection | ~20 LOC | None |
| TS MSE init | ~150 LOC | mux.js |
| TS download loop adapter | ~100 LOC | None |
| TS seek support | ~120 LOC | None |
| PTS↔byte mapping | ~80 LOC | None |
| WebWorker wrapper | ~80 LOC | None |
| **Total** | **~550 LOC** | **mux.js (~30KB gz)** |

---

## 12. Alternative: Server-Side Transmuxing (Tauri Backend)

Since NoBuf is a Tauri app, we could transmux TS → fMP4 in the Rust backend using the `mp4` crate or ffmpeg bindings:

**Pros:**
- No browser CPU overhead
- Can handle AC-3/DTS → AAC transcoding
- Can handle MPEG-2 video (not MSE-compatible)
- Better error recovery

**Cons:**
- Adds latency (backend processing before frontend receives data)
- More complex Rust code
- Harder to do progressive/streaming transmuxing

**Rust crates:**
- `mp4` crate: Can write fMP4, but no TS demuxer
- `ffmpeg-next` bindings: Full FFmpeg, but requires FFmpeg installed
- `gstreamer` bindings: Full pipeline, heavy dependency

**Recommendation:** Start with frontend mux.js for the common case (H.264+AAC TS). Add server-side transcoding later for edge cases (AC-3/DTS audio, MPEG-2 video).

---

## References

- [MPEG-TS specification (ISO/IEC 13818-1)](https://www.iso.org/standard/74499.html)
- [mux.js GitHub](https://github.com/videojs/mux.js)
- [mpegts.js GitHub](https://github.com/xqq/mpegts.js)
- [MDN: MediaSource Extensions API](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource)
- [MDN: MediaSource.isTypeSupported()](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/isTypeSupported_static)
