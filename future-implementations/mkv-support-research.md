# Matroska/MKV (.mkv) Support in NoBuf MSE Player

> **Research Date:** May 2026
> **Status:** Future Implementation
> **Relevant Files:** `app/src/hooks/useMSEPlayer.ts`, `app/src/lib/faststream/players/DirectVideoPlayer.ts`

---

## 1. Why .mkv Files Don't Work with the Current Pipeline

Same issue as .ts — the `ftyp` box check in `useMSEPlayer.ts` (lines 486–492) rejects MKV files. MKV files start with the **EBML header** (`0x1A45DFA3`), not an `ftyp` box.

Additionally, even if we detected MKV, **MSE cannot accept Matroska containers directly**:
- `MediaSource.isTypeSupported('video/x-matroska; codecs="avc1.42E01E"')` → **`false`**
- `MediaSource.isTypeSupported('video/webm; codecs="vp8.0"')` → **`true`** (WebM only)

MKV must be **remuxed** to either fMP4 or WebM before MSE playback.

---

## 2. MKV/Matroska Format Fundamentals

### 2.1 EBML Structure
Matroska uses **EBML** (Extensible Binary Meta Language), a binary XML-like format:

```
EBML Header (0x1A45DFA3)
├── EBMLVersion
├── DocType: "matroska" or "webm"
└── DocTypeVersion

Segment (0x18538067)
├── SeekHead (index of top-level elements)
├── Info (0x1549A966)
│   ├── TimecodeScale (nanoseconds per tick)
│   └── Duration (in TimecodeScale units)
├── Tracks (0x1654AE6B)
│   └── TrackEntry (one per track)
│       ├── TrackNumber
│       ├── TrackType (1=video, 2=audio, 0x11=subtitle)
│       ├── CodecID (e.g., "V_MPEG4/ISO/AVC", "A_AAC")
│       └── CodecPrivate (contains codec init data)
├── Cluster (0x1F43B675) [repeated]
│   ├── Timecode
│   └── SimpleBlock / BlockGroup
│       └── Block (raw codec data)
└── Cues (0x1C53BB6B) — seek index
    └── CuePoint
        ├── CueTime
        └── CueTrackPositions (byte offset in file)
```

### 2.2 Common Codecs in .mkv Files
| Codec | CodecID | MSE Support |
|-------|---------|-------------|
| H.264/AVC | `V_MPEG4/ISO/AVC` | ✅ (in fMP4) |
| H.265/HEVC | `V_MPEG/H265` or `V_MPEG4/ISO/HEVC` | ⚠️ Safari only |
| VP8 | `V_VP8` | ✅ (in WebM) |
| VP9 | `V_VP9` | ✅ (in WebM) |
| AV1 | `V_AV1` | ✅ (in WebM, Chrome/Edge/Firefox) |
| AAC | `A_AAC` | ✅ (in fMP4) |
| Opus | `A_OPUS` | ✅ (in WebM) |
| Vorbis | `A_VORBIS` | ✅ (in WebM) |
| FLAC | `A_FLAC` | ⚠️ Limited (Chrome only, in fMP4) |
| AC-3 | `A_AC3` | ❌ No MSE support |
| DTS | `A_DTS` | ❌ No MSE support |
| SRT subtitles | `S_TEXT/UTF8` | ❌ Not in MSE |
| ASS/SSA subtitles | `S_TEXT/ASS` | ❌ Not in MSE |
| PGS subtitles | `S_HDMV/PGS` | ❌ Not in MSE |

### 2.3 MKV vs WebM
WebM is a **strict subset** of Matroska:
- WebM = Matroska container + only VP8/VP9/AV1 video + only Vorbis/Opus audio
- MKV = Matroska container + any codec (H.264, H.265, AAC, FLAC, AC-3, etc.)
- MSE supports `video/webm` natively for VP8/VP9/AV1 + Vorbis/Opus

**Key insight:** If an MKV file contains only WebM-compatible codecs, we can remux to WebM (simpler) instead of fMP4.

---

## 3. Remuxing Strategies

### Strategy A: MKV → fMP4 (for H.264/AAC content)
```
MKV (EBML) → Demuxer extracts H.264 NALUs + AAC frames → fMP4 remuxer → MSE
```
- Use mux.js or mp4box.js to produce fMP4 segments
- Works for H.264 + AAC (most common MKV content)
- Codec strings: `video/mp4; codecs="avc1.42E01E"` + `audio/mp4; codecs="mp4a.40.2"`

### Strategy B: MKV → WebM (for VP8/VP9/AV1 content)
```
MKV (EBML) → Demuxer extracts VP8/VP9/Opus/Vorbis → WebM muxer → MSE
```
- MSE supports WebM natively, so less remuxing work needed
- Codec strings: `video/webm; codecs="vp9"` + `audio/webm; codecs="opus"`
- **Problem:** Few libraries do MKV→WebM remuxing. Simpler approach: since the codec data is already in the right format, just repackage the Clusters into WebM-compatible segments.

### Strategy C: Hybrid — detect codec, choose output format
```
if (codec is VP8/VP9/AV1 + Opus/Vorbis) → remux to WebM
else if (codec is H.264/H.265 + AAC) → remux to fMP4
else → fallback to native playback or backend transcoding
```

---

## 4. Available Libraries

### 4.1 ebml.js — EBML Parser

| Property | Value |
|----------|-------|
| **npm** | `ebml` |
| **GitHub** | [nicekiwi/ebml](https://github.com/nicekiwi/ebml) / various forks |
| **Stars** | ~200+ (across forks) |
| **Last Update** | Intermittent |
| **Bundle Size** | ~15KB min |
| **License** | MIT |

**What it does:** Parses EBML streams (Matroska's underlying format). Can read MKV headers, track info, and cluster data.

**Limitations:**
- Parser only — does NOT produce fMP4 or WebM output
- Must be combined with a remuxer (mp4box.js or custom WebM writer)
- No built-in seeking support
- Not streaming-optimized

**Use case:** Parse MKV headers to extract codec info, track metadata, and CuePoints for seeking.

### 4.2 matroska-subtitles — Subtitle Extraction

| Property | Value |
|----------|-------|
| **npm** | `matroska-subtitles` |
| **GitHub** | [nicholasgasior/matroska-subtitles](https://github.com/nicholasgasior/matroska-subtitles) (and forks) |
| **Stars** | ~50+ |
| **Bundle Size** | ~10KB |
| **License** | MIT |

**What it does:** Extracts subtitle tracks from MKV files. Produces SRT/ASS/WebVTT from embedded subtitles.

**Use case:** Extract ASS/SSA subtitles for overlay rendering (since MSE can't handle subtitles natively).

### 4.3 @aspect-build/mkv-demuxer or similar

No widely adopted, production-ready standalone MKV demuxer exists in the npm ecosystem that produces fMP4 segments. This is a **significant gap** in the JavaScript media tooling landscape.

### 4.4 ffmpeg.wasm — Full Transcoding

| Property | Value |
|----------|-------|
| **npm** | `@ffmpeg/ffmpeg` |
| **GitHub** | [ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) |
| **Stars** | ~13,500+ |
| **Bundle Size** | ~30MB core wasm |

**MKV support:** Full. Can read any MKV and convert to MP4/WebM.

**Verdict:** Too heavy for real-time streaming. Better as a backend tool.

### 4.5 Custom Solution — ebml.js + mp4box.js

The most practical browser-side approach:

1. **ebml.js** parses MKV → extracts elementary streams (H.264 NALUs, AAC frames)
2. **mp4box.js** takes elementary streams → produces fMP4 init + media segments
3. Feed fMP4 segments to existing MSE SourceBuffer pipeline

This is essentially building a custom MKV→fMP4 transmuxer by combining two existing parsers.

---

## 5. The H.265/HEVC Problem

H.265 is very common in MKV files (anime, 4K content), but MSE support is extremely limited:

| Browser | H.265 in MSE | Notes |
|---------|-------------|-------|
| Safari 11+ | ✅ | Full support |
| Chrome 107+ | ⚠️ | Behind flag `--enable-features=PlatformHEVCEncoderSupport` |
| Chrome 120+ | ⚠️ | Hardware decode only, limited profiles |
| Edge | ⚠️ | Similar to Chrome, Windows HEVC extension needed |
| Firefox | ❌ | No support planned |

**Practical impact:** Most H.265 MKV files will NOT play via MSE on Chrome/Firefox. Options:
1. **Fallback to native playback** (DirectVideoPlayer) — the browser may still play via `<video>` if the codec is system-installed
2. **Backend transcoding** (Tauri/Rust + ffmpeg) — transcode H.265 → H.264 before sending to frontend
3. **WebCodecs API** — decode H.265 frames in JS, render to canvas (experimental, complex)

---

## 6. WebCodecs API — An Alternative Path

The WebCodecs API (available in Chrome 94+, Edge 94+, Firefox 130+) provides direct access to hardware video decoders:

```ts
const decoder = new VideoDecoder({
  output: (frame) => {
    // Render to canvas or feed to custom player
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(frame, 0, 0);
    frame.close();
  },
  error: (e) => console.error(e),
});

decoder.configure({
  codec: 'hev1.1.6.L93.B0',
  codedWidth: 1920,
  codedHeight: 1080,
  hardwareAcceleration: 'prefer-hardware',
});

// Feed H.265 NAL units from MKV demuxer
decoder.decode(new EncodedVideoChunk({
  type: 'key',
  timestamp: 0,
  data: h265FrameData,
}));
```

**Pros:**
- Can decode H.265 on platforms where MSE doesn't support it
- Direct access to hardware decoders
- No container format restrictions

**Cons:**
- Must build custom A/V sync logic
- No audio playback integration (need separate AudioDecoder + Web Audio API)
- Much more complex than MSE
- Seeking requires building your own buffer management
- Not supported in all browsers yet

**Recommendation:** WebCodecs is a future option for H.265 content, but the engineering effort is 5-10x that of a mux.js-based MSE approach. Consider it for Phase 3+.

---

## 7. Integration Architecture for NoBuf

### 7.1 Detection Phase

```ts
function detectMkvFormat(buffer: ArrayBuffer): boolean {
  const view = new Uint8Array(buffer);
  // EBML magic bytes: 0x1A 0x45 0xDA 0xA3
  return view[0] === 0x1A && view[1] === 0x45 &&
         view[2] === 0xDA && view[3] === 0xA3;
}
```

### 7.2 MKV Demuxer Architecture

```ts
class MKVDemuxer {
  private ebmlParser: EBMLParser;
  private tracks: TrackInfo[] = [];
  private cues: CuePoint[] = [];

  async parseHeader(data: ArrayBuffer): Promise<MKVMetadata> {
    // Parse EBML header + Segment Info + Tracks
    // Return: duration, track list (codec, resolution, etc.)
  }

  async extractCodecPrivate(trackIndex: number): Promise<ArrayBuffer> {
    // For H.264: SPS/PPS from CodecPrivate
    // For AAC: AudioSpecificConfig from CodecPrivate
    // For VP9: CodecPrivate contains VP9 codec config
  }

  async readCluster(data: ArrayBuffer): Promise<ClusterData> {
    // Parse Cluster element, extract SimpleBlocks
    // Return: array of { trackId, timestamp, data }
  }

  seekToTime(time: number): number {
    // Use Cues to find byte offset for given time
    // Return: file byte offset to start reading from
  }
}
```

### 7.3 MKV → fMP4 Remuxing Pipeline

```
MKV File
  │
  ▼
[EBML Parser] ── Extract: Track info, CodecPrivate, Cluster SimpleBlocks
  │
  ├── Video: H.264 NALUs ──┐
  │                         ▼
  │                   [mp4box.js] ── Generate fMP4 segments
  │                         │
  │                         ▼
  ├── Audio: AAC frames ── [mp4box.js] ── Generate fMP4 segments
  │                         │
  │                         ▼
  │                   [MSE SourceBuffer] ── Playback
  │
  └── Subtitles: ASS/SRT ── [WebVTT Renderer] ── Overlay
```

### 7.4 MKV → WebM Pipeline (for VP8/VP9/AV1 content)

For WebM-compatible codecs, the approach is simpler because MSE supports WebM natively:

```ts
// For VP9 + Opus MKV files:
const mimeType = 'video/webm; codecs="vp9,opus"';
if (MediaSource.isTypeSupported(mimeType)) {
  // Repackage MKV Cluster data into WebM segments
  // This is essentially: read Blocks from MKV Clusters,
  // write them as WebM Cluster elements with correct timestamps
  // Append raw WebM segment bytes to MSE SourceBuffer
}
```

This requires a custom WebM segment writer (or using a library like `webm-mux` if one exists).

---

## 8. Server-Side Demuxing via Tauri Backend

Since NoBuf is a Tauri app, we can leverage Rust for MKV processing:

### Rust Crates for MKV

| Crate | Purpose | Maturity |
|-------|---------|----------|
| `matroska` | MKV/EBML parser | Good |
| `mp4` | MP4/fMP4 writer | Good |
| `ffmpeg-next` | Full FFmpeg bindings | Excellent (requires FFmpeg) |
| `gstreamer` | Full pipeline | Excellent (heavy) |
| `nom` | Parser combinator (build custom) | Excellent |

### Proposed Architecture

```
Frontend (React)                    Backend (Tauri/Rust)
┌─────────────────┐                ┌──────────────────────┐
│ MSE Player      │ ◄── fMP4 ──── │ MKV Demuxer (Rust)   │
│ SourceBuffer    │   chunks       │   ├── matroska crate  │
│ .appendBuffer() │                │   ├── mp4 crate       │
│                 │                │   └── ffmpeg (optional│
└─────────────────┘                │       for transcoding)│
                                   └──────────────────────┘
```

**Flow:**
1. Frontend detects MKV → tells backend "play this as MKV"
2. Backend opens the MKV file (local or streaming from Telegram)
3. Backend parses MKV headers, extracts track info
4. Backend sends track info to frontend (codec, resolution, duration)
5. Frontend creates MSE SourceBuffers with correct codec strings
6. On seek: frontend requests data from `time X`, backend uses Cues to find the right Cluster, reads data, remuxes to fMP4, sends chunks
7. Frontend appends fMP4 chunks to SourceBuffer

**Pros:**
- Handles ALL codecs (backend can transcode AC-3→AAC, H.265→H.264)
- Better error recovery
- Can pre-buffer aggressively without browser CPU overhead
- Leverages existing Rust download pipeline

**Cons:**
- IPC overhead for each chunk (Tauri invoke)
- More complex backend code
- Harder to debug

### Rust Implementation Sketch

```rust
use matroska::Matroska;
use mp4::{Mp4, Track as Mp4Track};

#[tauri::command]
async fn get_mkv_info(path: String) -> Result<MkvInfo, String> {
    let mkv = Matroska::open(&path).map_err(|e| e.to_string())?;
    Ok(MkvInfo {
        duration: mkv.info.duration,
        tracks: mkv.tracks.iter().map(|t| TrackInfo {
            codec: t.codec_id.clone(),
            // ...
        }).collect(),
    })
}

#[tauri::command]
async fn get_mkv_segment(
    path: String,
    time_seconds: f64,
) -> Result<Vec<u8>, String> {
    // Use Cues to find byte offset
    // Read Cluster data
    // Remux to fMP4
    // Return fMP4 bytes
}
```

---

## 9. Performance Considerations

| Factor | Browser-Side | Server-Side (Tauri) |
|--------|-------------|-------------------|
| **MKV parsing** | ~2-5% CPU | Zero browser CPU |
| **fMP4 remuxing** | ~5-10% CPU | Zero browser CPU |
| **Memory** | 10-50MB (depending on buffer) | Managed by Rust allocator |
| **Latency** | Low (direct) | +1-5ms IPC overhead |
| **Large files (10GB+)** | Memory pressure | Rust handles efficiently |
| **Seek speed** | Depends on Cues parsing | Fast (Rust file I/O) |

### Large File Handling

MKV files can be very large (10-100GB for 4K content). Key considerations:
- **Never load entire file into memory** — stream-parse EBML elements
- **Use Cues for seeking** — MKV files store a seek index (Cues element) that maps time → byte offset
- **Evict SourceBuffer aggressively** — the existing `evictOldBuffer()` logic in `useMSEPlayer.ts` handles this

---

## 10. Subtitle Handling

MKV files often contain embedded subtitles (SRT, ASS/SSA, PGS). MSE cannot display subtitles — they must be rendered as overlays.

### Options:
1. **Extract and convert to WebVTT** — use `matroska-subtitles` npm package
2. **Render ASS/SSA with JavaScript** — use `libass-wasm` (ASS renderer compiled to WASM, ~300KB)
3. **Use Tauri backend** — extract subtitles in Rust, send as WebVTT to frontend
4. **Use HTML track element** — `<track kind="subtitles" src="...">` with WebVTT

### ASS/SSA Subtitle Rendering

libass-wasm (jassub on npm) can render complex ASS subtitles:
- Font styling, positioning, animation
- Karaoke effects
- Better than simple WebVTT rendering

**npm:** `jassub` (formerly `jsass`)
**Bundle size:** ~300KB wasm

---

## 11. Edge Cases

### 11.1 Ordered Chapters
MKV supports "ordered chapters" where segments from different files are combined into a playlist. This is common in anime (separate OP/ED files).

**Impact:** The player must detect ordered chapters and load external segment files.
**Mitigation:** Initially fall back to native playback for ordered chapter files.

### 11.2 CodecPrivate Format
The codec-specific initialization data stored in MKV's CodecPrivate element is NOT the same format as what mp4box.js expects:
- **H.264**: CodecPrivate contains AVCC format (length-prefixed NALUs) — same as MP4, compatible
- **VP9**: CodecPrivate contains VP9 codec config — must be parsed
- **AAC**: CodecPrivate may contain AudioSpecificConfig — compatible with fMP4
- **Opus**: CodecPrivate contains OpusHead — must be converted for WebM

### 11.3 Attachments
MKV files can contain attachments (fonts, images, cover art). Fonts are important for ASS subtitle rendering — if the MKV references custom fonts, they must be extracted and loaded.

### 11.4 Variable Framerate
Some MKV files use variable framerate (VFR). The remuxer must preserve the original timestamps, not assume constant framerate.

---

## 12. Recommended Implementation Plan

### Phase 1: Basic MKV Detection + Fallback (Week 1)
1. Add EBML magic byte detection
2. Parse MKV header to extract track info (codec, resolution)
3. If H.264 + AAC: attempt browser-side remux
4. If VP8/VP9/AV1 + Opus/Vorbis: attempt WebM remux
5. Everything else: fall back to native playback (DirectVideoPlayer)
6. Log unsupported codecs for future prioritization

### Phase 2: Browser-Side MKV → fMP4 (Weeks 2-3)
1. Add `ebml` npm package for EBML parsing
2. Implement Cluster/SimpleBlock extraction
3. Build MKV→fMP4 transmuxer using ebml + mp4box.js
4. Implement seek support using Cues element
5. Integrate with existing MSE pipeline

### Phase 3: Backend Demuxing (Weeks 4-5)
1. Implement Rust MKV parser using `matroska` crate
2. Add Tauri commands for MKV metadata and segment retrieval
3. Build Rust fMP4 remuxer
4. Add IPC-based streaming protocol
5. Support H.265 → H.264 transcoding via ffmpeg bindings

### Phase 4: Polish (Week 6+)
1. Subtitle extraction and rendering (jassub/libass-wasm)
2. Chapter navigation
3. Audio track selection
4. Attachment handling (cover art, fonts)
5. Ordered chapter support

---

## 13. File Size Estimate

| Component | Browser-Side | Server-Side (Tauri) |
|-----------|-------------|-------------------|
| MKV detection | ~15 LOC | ~15 LOC |
| EBML parser integration | ~200 LOC | Rust `matroska` crate |
| Track info extraction | ~80 LOC | ~50 LOC Rust |
| fMP4 remuxing | ~300 LOC | ~200 LOC Rust |
| Seek support | ~150 LOC | ~100 LOC Rust |
| Subtitle extraction | ~100 LOC | ~80 LOC Rust |
| **Total** | **~845 LOC + ebml** | **~445 LOC Rust** |
| **New deps** | ebml (~15KB) | matroska + mp4 crates |

---

## 14. Comparison: Browser-Side vs Server-Side MKV Support

| Criterion | Browser (JS) | Server (Rust/Tauri) |
|-----------|-------------|-------------------|
| **Implementation effort** | Medium-High | Medium |
| **Codec coverage** | Limited (H.264, VP8/9) | Full (all codecs) |
| **H.265 support** | ❌ No MSE support | ✅ Transcode to H.264 |
| **AC-3/DTS audio** | ❌ Can't play | ✅ Transcode to AAC |
| **CPU impact on UI** | Moderate | None |
| **Latency** | Lower | +1-5ms IPC |
| **Memory management** | Browser GC | Rust allocator (better) |
| **Debugging** | Browser DevTools | Rust tooling |
| **Subtitle support** | jassub (WASM) | Rust extraction |

**Recommendation:** Start with browser-side for quick wins (VP9/Opus WebM, H.264/AAC fMP4), then move to server-side for comprehensive codec support.

---

## References

- [Matroska Specification](https://www.matroska.org/technical/elements.html)
- [EBML Specification](https://github.com/nicholasgasior/matroska-subtitles)
- [MDN: MediaSource.isTypeSupported()](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/isTypeSupported_static)
- [MDN: WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
- [Chrome HEVC support](https://chromestatus.com/feature/5765424957947904)
- [jassub (ASS renderer)](https://github.com/nicholasgasior/matroska-subtitles)
- [Rust matroska crate](https://crates.io/crates/matroska)
- [Rust mp4 crate](https://crates.io/crates/mp4)
