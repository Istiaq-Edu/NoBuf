# MSE Media Library Comparison — NoBuf Video Player

> **Research Date:** May 2026
> **Purpose:** Comprehensive comparison of JavaScript/TypeScript libraries for browser-based video demuxing, remuxing, and MSE playback
> **Context:** NoBuf uses mp4box.js (`^0.5.2`) for MP4 parsing and fMP4 segment generation. We need to evaluate libraries for extending support to .ts and .mkv files.

---

## Current Architecture

```
useMSEPlayer.ts
  │
  ├── mp4box.js (parse MP4, generate fMP4 segments)
  │     └── onReady → extract tracks, codec info
  │     └── onSegment → feed to SourceBuffer
  │
  ├── SourceBufferWrapper (queue append/remove ops)
  │     └── Bug #4 fatal error detection
  │     └── Bug #16 quota exceeded handling
  │
  ├── Custom buffer management
  │     └── evictOldBuffer(), progressive chunk sizes
  │     └── VBR byte-to-time lookup table (200 points)
  │     └── Backend range reporting
  │
  └── DirectVideoPlayer (native <video> fallback)
```

---

## Library Comparison Table

### 1. Transmuxers / Demuxers

| Library | npm Package | GitHub Stars | Last Commit | Bundle Size (gzip) | License | Input Formats | Output Formats | WebWorker | TypeScript |
|---------|------------|-------------|-------------|--------------------|---------|----|----|----|----|
| **mp4box.js** | `mp4box` | ~1,400 | Active (2025) | ~40KB | BSD-3 | ISO BMFF (MP4) | fMP4 segments | ✅ | ⚠️ types only |
| **mux.js** | `mux.js` | ~1,800 | Active (2025) | ~30KB | Apache-2.0 | MPEG-TS | fMP4 segments | ✅ | ✅ |
| **mpegts.js** | `mpegts.js` | ~7,500 | Active (2025) | ~70KB | Apache-2.0 | TS, FLV | MSE playback | ✅ | ⚠️ types |
| **hls.js** | `hls.js` | ~14,500 | Active (2025) | ~100KB | Apache-2.0 | HLS (M3U8+TS/fMP4) | MSE playback | ✅ | ✅ |
| **flv.js** | `flv.js` | ~17,000 | Maintenance (2024) | ~60KB | Apache-2.0 | FLV | MSE playback | ✅ | ❌ |
| **dash.js** | `dash.js` | ~1,200 | Active (2025) | ~120KB | BSD-3 | DASH (MPD+fMP4) | MSE playback | ✅ | ⚠️ types |
| **Shaka Player** | `shaka-player` | ~7,500 | Active (2025) | ~150KB | Apache-2.0 | DASH, HLS, MSS | MSE playback | ✅ | ✅ |
| **ffmpeg.wasm** | `@ffmpeg/ffmpeg` | ~13,500 | Active (2025) | **~30MB** | GPL/LGPL | Everything | Everything | ✅ | ✅ |
| **ebml.js** | `ebml` | ~200 | Intermittent | ~15KB | MIT | EBML/MKV | Parsed events | ❌ | ❌ |
| **jassub** | `jassub` | ~200 | Active (2025) | ~300KB | MIT | ASS/SSA subtitles | Canvas overlay | ✅ | ❌ |

### 2. MSE Players (Full-Stack)

| Library | Can Use as Transmuxer Only? | Buffer Management | Seek Support | Custom SourceBuffer Control |
|---------|---------------------------|-------------------|-------------|---------------------------|
| **mp4box.js** | ✅ (our current use) | ❌ (we do it) | ✅ via seek() | ✅ (we own SourceBuffer) |
| **mux.js** | ✅ (produces fMP4 segments) | ❌ (caller's job) | ❌ (caller manages) | ✅ (we own SourceBuffer) |
| **mpegts.js** | ⚠️ (wants to own everything) | ✅ built-in | ✅ built-in | ❌ (it owns MSE) |
| **hls.js** | ❌ (full HLS player) | ✅ built-in | ✅ built-in | ❌ (it owns MSE) |
| **Shaka Player** | ❌ (full player) | ✅ built-in | ✅ built-in | ❌ (it owns MSE) |

---

## Detailed Library Analysis

### mp4box.js (Current)
- **npm:** `mp4box@^0.5.2`
- **GitHub:** [gpac/mp4box.js](https://github.com/gpac/mp4box.js)
- **What it does:** Parses ISO BMFF (MP4) files, generates fMP4 init and media segments
- **Our usage:** Parse moov atom → get track info → setSegmentOptions → onSegment callback → feed to SourceBuffer
- **Strengths:** Precise control over segmentation, VBR seek table (200 calibration points), works perfectly with our custom buffer management
- **Weaknesses:** Only supports ISO BMFF — cannot parse TS, MKV, FLV, or any other container
- **Verdict:** ✅ Keep for MP4 files. Not useful for TS/MKV.

### mux.js (RECOMMENDED for TS)
- **npm:** `mux.js`
- **GitHub:** [videojs/mux.js](https://github.com/videojs/mux.js)
- **Weekly downloads:** ~200K+
- **What it does:** Standalone TS → fMP4 transmuxer. This is the same transmuxer extracted from hls.js.
- **Key API:**
  ```ts
  import { Transmuxer } from 'mux.js';
  const transmuxer = new Transmuxer({ keepOriginalTimestamps: true });
  transmuxer.on('data', (segment) => {
    // segment.initSegment — fMP4 init (ftyp + moov)
    // segment.data — fMP4 media (moof + mdat)
  });
  transmuxer.push(tsBytes);  // Feed TS data
  transmuxer.flush();         // Produce output segment
  ```
- **Codec support:**
  - ✅ H.264/AVC (full support)
  - ✅ H.265/HEVC (added in v6+)
  - ✅ AAC (ADTS and LATM)
  - ✅ MP3
  - ❌ AC-3, DTS, MPEG-2 video
- **Why it fits our architecture perfectly:**
  - It ONLY produces fMP4 segments — doesn't try to own the MSE pipeline
  - We keep our SourceBufferWrapper, evictOldBuffer(), VBR table, range reporting
  - We just swap `mp4box.onSegment` → `transmuxer.on('data', ...)` for TS files
  - WebWorker compatible
- **Pitfalls:**
  - After a seek, must create a new Transmuxer instance or call `.flush()` with reset state
  - H.265 support is newer — test with real-world MKV→TS content
  - Does NOT handle container-level seeking (must be done externally)
- **Bundle impact:** +30KB gzipped (lazy-loaded only when TS detected)

### mpegts.js (Powerful but Invasive)
- **npm:** `mpegts.js`
- **GitHub:** [xqq/mpegts.js](https://github.com/xqq/mpegts.js)
- **Weekly downloads:** ~30K+
- **What it does:** Full MPEG-TS/FLV player with built-in TS demuxer, fMP4 remuxer, MSE controller, buffer manager, and seek engine
- **Key API:**
  ```ts
  import mpegts from 'mpegts.js';
  const player = mpegts.createPlayer({
    type: 'mse',
    isLive: false,
    url: 'http://...',
  });
  player.attachMediaElement(videoElement);
  player.load();
  player.play();
  ```
- **Codec support:**
  - ✅ H.264/AVC
  - ✅ H.265/HEVC
  - ✅ MPEG-2 video (transcoded or handled specially)
  - ✅ AAC (ADTS + LATM)
  - ✅ MP3
  - ✅ AC-3 (partial, via MSE passthrough where supported)
- **Why it's powerful:** Everything is built-in — demux, remux, buffer management, seek, HTTP loader with Range support
- **Why it DOESN'T fit our architecture:**
  - It wants to own the `<video>` element and MSE pipeline
  - Our `useMSEPlayer.ts` has 1200+ lines of custom buffer management that would be REPLACED, not augmented
  - mpegts.js's buffer manager doesn't know about our Telegram backend, range reporting, or VBR table
  - Would require either: (a) replacing our entire MSE layer, or (b) extracting just the demuxer (not designed for this)
- **Verdict:** ❌ Not recommended for integration. Consider only if we want to REPLACE our MSE pipeline entirely.

### hls.js (Overkill for Our Use Case)
- **npm:** `hls.js`
- **GitHub:** [video-dev/hls.js](https://github.com/video-dev/hls.js)
- **Weekly downloads:** ~2M+
- **What it does:** Full HLS player — fetches M3U8 manifests, manages quality levels, handles TS/fMP4 segments
- **Relevance:** Uses mux.js internally for TS transmuxing. The TS demuxer is not independently usable.
- **Verdict:** ❌ Use mux.js directly instead.

### Shaka Player (Google's Universal Player)
- **npm:** `shaka-player`
- **GitHub:** [google/shaka-player](https://github.com/google/shaka-player)
- **Weekly downloads:** ~150K+
- **What it does:** Universal streaming player — DASH, HLS, MSS. Has its own TS demuxer, MP4 parser, and buffer management.
- **Relevance:** Could theoretically be used as a library, but it's designed as a complete player.
- **Verdict:** ❌ Too heavy and too opinionated for our use case.

### ffmpeg.wasm (Nuclear Option)
- **npm:** `@ffmpeg/ffmpeg`
- **GitHub:** [ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
- **Bundle size:** ~30MB core wasm (this is the dealbreaker)
- **What it does:** Full FFmpeg compiled to WebAssembly — can transcode any format to any format
- **Use cases for NoBuf:**
  - Backend fallback for rare codecs (MPEG-2 video, AC-3 audio)
  - Converting unsupported MKV content to MP4
  - Not suitable for real-time streaming due to size and performance
- **Recent improvements:** Multi-threaded support, SharedArrayBuffer, SIMD
- **Verdict:** ⚠️ Consider for Tauri backend only (use Rust ffmpeg bindings instead)

### ebml.js (MKV Parser)
- **npm:** `ebml`
- **Multiple forks** — no single canonical version
- **What it does:** Parses EBML streams (Matroska's binary format)
- **Strengths:** Small, simple API, event-based parsing
- **Weaknesses:**
  - Parser only — does NOT produce fMP4 or WebM
  - Not streaming-optimized (designed for Node.js streams)
  - No TypeScript types
  - Multiple incompatible forks
- **Use case for NoBuf:** Parse MKV headers to extract track info and CuePoints
- **Verdict:** ⚠️ Useful as a building block, but needs a remuxer on top

### jassub (ASS Subtitle Renderer)
- **npm:** `jassub`
- **GitHub:** [ThaUnknown/jassub](https://github.com/ThaUnknown/jassub)
- **What it does:** Renders ASS/SSA subtitles on a canvas overlay using libass compiled to WASM
- **Why relevant:** MKV files often have embedded ASS subtitles that need complex rendering (styled text, positioning, animation)
- **Bundle size:** ~300KB wasm
- **Verdict:** ✅ Use for subtitle rendering when we add MKV support

---

## Browser MSE Codec Support Matrix

What `MediaSource.isTypeSupported()` returns for various codec strings:

### Video Codecs in `video/mp4`
| Codec String | Chrome | Firefox | Safari | Edge |
|-------------|--------|---------|--------|------|
| `avc1.42E01E` (H.264 Baseline) | ✅ | ✅ | ✅ | ✅ |
| `avc1.4D401E` (H.264 Main) | ✅ | ✅ | ✅ | ✅ |
| `avc1.640028` (H.264 High) | ✅ | ✅ | ✅ | ✅ |
| `hev1.1.6.L93.B0` (H.265 Main) | ⚠️¹ | ❌ | ✅ | ⚠️¹ |
| `vp8` | ❌² | ❌² | ❌ | ❌² |
| `vp9` | ❌² | ❌² | ❌ | ❌² |
| `av01.0.08M.08` (AV1) | ✅ | ✅ | ✅³ | ✅ |

¹ Hardware-dependent, may require OS codec pack
² VP8/VP9/AV1 in MP4 container — use `video/webm` instead
³ Safari 17+ on macOS Sonoma+

### Video Codecs in `video/webm`
| Codec String | Chrome | Firefox | Safari | Edge |
|-------------|--------|---------|--------|------|
| `vp8` | ✅ | ✅ | ❌ | ✅ |
| `vp9` | ✅ | ✅ | ❌ | ✅ |
| `vp9.2` (HDR) | ✅ | ✅ | ❌ | ✅ |
| `av01.0.08M.08` (AV1) | ✅ | ✅ | ✅⁴ | ✅ |

⁴ Safari 17+ on supported hardware

### Audio Codecs in `audio/mp4`
| Codec String | Chrome | Firefox | Safari | Edge |
|-------------|--------|---------|--------|------|
| `mp4a.40.2` (AAC-LC) | ✅ | ✅ | ✅ | ✅ |
| `mp4a.40.5` (HE-AAC) | ✅ | ✅ | ✅ | ✅ |
| `mp4a.40.34` (MP3) | ✅ | ✅ | ✅ | ✅ |
| `ac-3` (Dolby Digital) | ❌ | ❌ | ✅ | ❌ |
| `ec-3` (Dolby Digital Plus) | ❌ | ❌ | ✅ | ❌ |
| `flac` | ✅ | ❌ | ✅ | ✅ |

### Audio Codecs in `audio/webm`
| Codec String | Chrome | Firefox | Safari | Edge |
|-------------|--------|---------|--------|------|
| `opus` | ✅ | ✅ | ❌ | ✅ |
| `vorbis` | ✅ | ✅ | ❌ | ✅ |

---

## WebCodecs API — The Future Alternative

The WebCodecs API provides direct access to hardware decoders without MSE container restrictions:

```ts
// Can decode any codec the hardware supports, regardless of container
const decoder = new VideoDecoder({ output: onFrame, error: onError });
decoder.configure({
  codec: 'hev1.1.6.L93.B0', // H.265 — works even in Chrome!
  codedWidth: 1920,
  codedHeight: 1080,
});
```

### Current State (2026):
- **Chrome 94+:** Full support including H.265 hardware decode
- **Edge 94+:** Same as Chrome
- **Firefox 130+:** Basic support, H.265 behind flag
- **Safari 16.4+:** Supported

### Why We Shouldn't Use It Yet:
1. **No audio integration** — must use Web Audio API separately
2. **No A/V sync** — must build custom synchronization
3. **No seeking** — must build custom buffer management
4. **Rendering** — must draw frames to canvas (no native video element)
5. **Complexity** — 10x the code of an MSE-based approach

### When to Revisit:
- When H.265 MSE support is still absent in Chrome/Firefox and users demand it
- When we need frame-level control (thumbnails, frame-accurate editing)
- When the project matures and we have bandwidth for a custom player engine

---

## Tauri/Rust Backend Options

Since NoBuf is a Tauri app, we can leverage Rust for media processing:

### Rust Crates

| Crate | Purpose | Maturity | Size |
|-------|---------|----------|------|
| `mp4` | Read/write MP4/fMP4 | Good | Small |
| `matroska` | Read MKV/EBML | Good | Small |
| `ffmpeg-next` | FFmpeg bindings | Excellent | Requires FFmpeg |
| `gstreamer` | Full pipeline | Excellent | Heavy |
| `bytes` | Buffer management | Excellent | Tiny |
| `tokio` | Async runtime | Excellent | Medium |

### Recommended Rust Architecture

```
┌─────────────────────────────────────────────┐
│              Tauri Backend                   │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ MP4      │  │ TS       │  │ MKV      │  │
│  │ Handler  │  │ Handler  │  │ Handler  │  │
│  │ (passthru│  │ (mux.js  │  │ (matroska│  │
│  │  or mp4  │  │  compat  │  │  crate + │  │
│  │  crate)  │  │  output) │  │  mp4     │  │
│  │          │  │          │  │  crate)  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │        │
│       └──────────────┼──────────────┘        │
│                      ▼                       │
│              ┌──────────────┐                │
│              │ fMP4 Stream  │                │
│              │ (chunks via  │                │
│              │  Tauri IPC)  │                │
│              └──────────────┘                │
└─────────────────────────────────────────────┘
         │ Tauri invoke / streaming
         ▼
┌─────────────────────────────────────────────┐
│              Frontend (React)                │
│                                              │
│  useMSEPlayer.ts                             │
│  ├── SourceBufferWrapper                     │
│  ├── evictOldBuffer()                        │
│  ├── VBR lookup table                        │
│  └── Backend range reporting                 │
└─────────────────────────────────────────────┘
```

---

## Recommendation Summary

### For .ts Support:
| Approach | Library | Effort | Fit |
|----------|---------|--------|-----|
| **⭐ Recommended** | mux.js | Low | Excellent — drops into our pipeline |
| Alternative | mpegts.js | High | Poor — replaces our pipeline |
| Nuclear | ffmpeg.wasm | Very High | Poor — 30MB bundle |

**Action:** `pnpm add mux.js` and implement a `TSMSEPlayer` class alongside `MP4Player`.

### For .mkv Support:
| Approach | Library | Effort | Fit |
|----------|---------|--------|-----|
| **⭐ Phase 1: VP9→WebM** | ebml.js + custom | Medium | Good for VP9/Opus MKVs |
| **Phase 2: H.264→fMP4** | ebml.js + mux.js | Medium-High | Good for H.264/AAC MKVs |
| **Phase 3: Server-side** | Rust matroska + mp4 | Medium | Excellent — full codec support |

**Action:** Start with browser-side for VP9/Opus content, then add Rust backend for comprehensive codec support.

### Bundle Size Budget
| Library | Size | Loaded When |
|---------|------|------------|
| mp4box.js | ~40KB gz | Always (current) |
| mux.js | ~30KB gz | TS file detected (lazy) |
| ebml.js | ~15KB gz | MKV file detected (lazy) |
| jassub | ~300KB gz | Subtitle rendering needed (lazy) |
| **Total new** | **~45KB** | **on-demand** |

---

## Implementation Priority Matrix

| Feature | User Impact | Effort | Priority |
|---------|-----------|--------|---------|
| TS → fMP4 via mux.js | High (many .ts files exist) | Low | **P0** |
| MKV VP9/Opus → WebM | High (anime, web video) | Medium | **P1** |
| MKV H.264/AAC → fMP4 | High (most MKV content) | Medium | **P1** |
| Backend MKV demuxing (Rust) | Medium (better codec support) | Medium-High | **P2** |
| H.265 support (backend transcode) | Medium (4K content) | Medium | **P2** |
| Subtitle rendering (jassub) | Medium (anime fans) | Low | **P2** |
| AC-3/DTS audio (backend transcode) | Low (niche content) | Medium | **P3** |
| WebCodecs API path | Low (future-proofing) | Very High | **P4** |

---

## References

- [mp4box.js GitHub](https://github.com/gpac/mp4box.js)
- [mux.js GitHub](https://github.com/videojs/mux.js)
- [mpegts.js GitHub](https://github.com/xqq/mpegts.js)
- [hls.js GitHub](https://github.com/video-dev/hls.js)
- [Shaka Player GitHub](https://github.com/google/shaka-player)
- [ffmpeg.wasm GitHub](https://github.com/ffmpegwasm/ffmpeg.wasm)
- [ebml.js npm](https://www.npmjs.com/package/ebml)
- [jassub GitHub](https://github.com/ThaUnknown/jassub)
- [MDN: MediaSource Extensions](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource)
- [MDN: WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
- [Caniuse: MSE codec support](https://caniuse.com/mdn-api_mediasource_istypesupported)
- [Caniuse: HEVC in MSE](https://caniuse.com/mdn-api_mediasource_istypesupported_hevc)
