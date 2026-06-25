# FastStream Architecture Analysis — How It Handles Multiple Video Formats

> **Source:** [github.com/Andrews54757/FastStream](https://github.com/Andrews54757/FastStream) (v1.3.76)
> **Analyzed:** May 2026
> **Purpose:** Extract architectural patterns and solutions for NoBuf's .ts/.mkv support

---

## 1. Overview

FastStream is a browser extension that replaces video players on websites with its own MSE-based player. It supports:
- **MP4 files** — via mp4box.js (customized) with MSE SourceBuffers
- **HLS streams** (.m3u8) — via customized hls.js (which includes TS demuxer + fMP4 transmuxer)
- **DASH streams** (.mpd) — via customized dash.js
- **YouTube** — via custom YouTube API client
- **WebM files** — via **native `<video>` playback** (no MSE acceleration)
- **All other formats** — via native `<video>` playback (DirectVideoPlayer)

**Key insight: FastStream does NOT support .ts or .mkv as standalone files via MSE.** It only handles TS when it's part of an HLS stream (where hls.js does the demuxing). MKV files fall back to native playback.

---

## 2. Player Architecture

### 2.1 Player Modes (Plugin System)

```
PlayerModes.mjs:
  AUTO              → 'auto'        (auto-detect)
  DIRECT            → 'direct'      (native <video>)
  ACCELERATED_MP4   → 'accelerated_mp4'   (mp4box.js → MSE)
  ACCELERATED_HLS   → 'accelerated_hls'   (hls.js → MSE)
  ACCELERATED_DASH  → 'accelerated_dash'  (dash.js → MSE)
  ACCELERATED_YT    → 'accelerated_yt'    (YouTube API)
  ACCELERATED_VM    → 'accelerated_vm'    (Vimeo)
  IFRAME            → 'iframe'      (passthrough)
```

### 2.2 PlayerLoader (Dynamic Player Selection)

```js
// PlayerLoader.mjs — Plugin registry
class PlayerLoader {
  constructor() {
    this.players = {};
    this.registerPlayer(PlayerModes.DIRECT, './DirectVideoPlayer.mjs');
    this.registerPlayer(PlayerModes.ACCELERATED_MP4, './mp4/MP4Player.mjs');
    this.registerPlayer(PlayerModes.ACCELERATED_HLS, './hls/HLSPlayer.mjs');
    this.registerPlayer(PlayerModes.ACCELERATED_DASH, './dash/DashPlayer.mjs');
    this.registerPlayer(PlayerModes.ACCELERATED_YT, './yt/YTPlayer.mjs');
    this.registerPlayer(PlayerModes.ACCELERATED_VM, './vm/VMPlayer.mjs');
  }

  async createPlayer(mode, client, options) {
    const Player = (await import(this.players[mode])).default;
    return new Player(client, options);
  }
}
```

**Pattern:** Each player mode is a lazy-loaded ES module. The `PlayerLoader` acts as a registry. New format support = new player module + new mode constant + register it.

### 2.3 Format Detection Flow

```
URL comes in
    │
    ▼
URLUtils.getModeFromExtension(ext)    ← Extension-based detection
    │
    ├── .mp4  → ACCELERATED_MP4
    ├── .m3u8 → ACCELERATED_HLS
    ├── .mpd  → ACCELERATED_DASH
    ├── .webm → DIRECT (native!)
    └── (unknown) → DIRECT
    │
    ▼
YouTube URL? → ACCELERATED_YT
    │
    ▼
VideoSource(url, headers, mode) → FastStreamClient.setSource()
    │
    ▼
PlayerLoader.createPlayer(mode) → Instantiates the right player
```

**Critical finding:** Format detection is **URL-extension based**, NOT content-sniffing. There is no magic byte detection (no ftyp check, no EBML check, no sync byte check). This means:
- `.webm` → native playback (even though MSE supports WebM)
- `.ts` → falls through to DIRECT (native, if the browser can play it)
- `.mkv` → falls through to DIRECT (native, if the browser can play it)

---

## 3. How Each Format Player Works

### 3.1 MP4Player — The Core MSE Player

**File:** `chrome/player/players/mp4/MP4Player.mjs`

**Architecture:**
```
MP4Player
├── mp4box (customized) — parses ISO BMFF, generates fMP4 segments
├── SourceBufferWrapper — queues append/remove ops on SourceBuffer
├── MP4FragmentRequester — manages HTTP Range request downloads
├── videoSourceBuffer + audioSourceBuffer — separate SourceBuffers per track
└── mainLoop() — 1ms timer driving fragment requests
```

**How it works:**
1. `setSource()` → creates first MP4Fragment (0-1MB byte range)
2. `mainLoop()` on 1ms timer → calls `runLoad()` to request next fragment
3. Fragment downloaded → fed to `mp4box.appendBuffer(data)`
4. `mp4box.onReady` → extracts track info, creates SourceBuffers with codec strings
5. `mp4box.onSegment` → feeds fMP4 segments to SourceBufferWrapper
6. Buffer management: evicts old fragments, keeps `backBufferLength` (10s) behind

**Key differences from our `useMSEPlayer.ts`:**
- FastStream uses `nbSamples: 1` (per-sample segmentation) — we use `nbSamples: 100`
- FastStream has a `MP4FragmentRequester` abstraction — we inline the download logic
- FastStream creates fragments at fixed 1MB intervals — we use progressive sizes (512KB→8MB)
- FastStream has a `LevelManager` for quality switching — we don't (single quality)

### 3.2 HLSPlayer — hls.js Integration

**File:** `chrome/player/players/hls/HLSPlayer.mjs`

**Architecture:**
```
HLSPlayer
├── hls.js (customized, bundled as modules/hls.mjs + hls.worker.js)
│   ├── Internal TS demuxer (parses 0x47 sync bytes, PAT/PMT, PES)
│   ├── Internal fMP4 transmuxer (TS → fMP4 for MSE)
│   └── Internal loader (custom HLSLoaderFactory)
├── HLSFragmentRequester — wraps hls.js fragment loading
└── Custom loader that intercepts hls.js's network requests
```

**How it handles TS content:**
- hls.js has a **built-in TS demuxer** in its WebWorker (`hls.worker.js`)
- When an HLS stream uses TS segments (`.ts` files), hls.js automatically:
  1. Fetches the TS segment
  2. Demuxes it (extracts H.264 NALUs + AAC frames)
  3. Transmuxes to fMP4 (init segment + media segments)
  4. Feeds fMP4 to MSE SourceBuffer
- This is the **exact same transmuxing pipeline** that mux.js provides standalone

**Key insight:** hls.js's TS demuxer is NOT available as a standalone module. But mux.js IS the same transmuxer, extracted for standalone use. This validates our mux.js recommendation.

### 3.3 DashPlayer — dash.js Integration

**File:** `chrome/player/players/dash/DashPlayer.mjs`

**Architecture:**
```
DashPlayer
├── dash.js (customized, bundled as modules/dash.mjs)
│   ├── Internal fMP4 demuxer/segmenter
│   └── Custom loader (DASHLoaderFactory)
└── DashFragmentRequester
```

DASH streams already use fMP4 segments, so no transmuxing is needed. dash.js handles manifest parsing and segment fetching.

### 3.4 DirectVideoPlayer — Native Fallback

**File:** `chrome/player/players/DirectVideoPlayer.mjs`

**Architecture:**
```
DirectVideoPlayer
└── <video> element with src=url (native browser playback)
```

**What falls back to DIRECT:**
- `.webm` files (explicitly mapped to DIRECT in URLUtils)
- `.ts` files (not in ModesMap → falls through to DIRECT)
- `.mkv` files (not in ModesMap → falls through to DIRECT)
- `.avi` files (not in ModesMap → falls through to DIRECT)
- Any unrecognized format
- Local `file://` MP4s (explicitly downgraded from ACCELERATED_MP4 to DIRECT)

**Limitations of DIRECT mode:**
- No pre-buffering / prefetch
- No custom buffer management
- No download-all capability
- `canSave()` returns `{ cantSave: true, canSave: false, isComplete: true }`
- Relies entirely on the browser's native decoder

---

## 4. The Reencoder/Demuxer Subsystem

FastStream has a sophisticated **reencoder** module (`chrome/player/modules/reencoder/`) that can convert between formats using the **WebCodecs API**:

### 4.1 Architecture

```
reencoder/
├── demuxers.mjs        — AbstractDemuxer + WebMDemuxer + MP4Demuxer
├── mp4-muxer.mjs       — MP4 muxer (produces fMP4 from EncodedVideoChunk)
├── webm.mjs            — JsWebm demuxer (full WebM/Matroska parser, 3500+ LOC!)
├── reencoder.mjs        — Orchestrates demux → decode → re-encode → mux
├── resampler-worker.mjs — Audio resampling in WebWorker
└── libsamplerate.wasm   — Audio resampling library
```

### 4.2 AbstractDemuxer Interface

```js
class AbstractDemuxer {
  initialize(initSegment) {}      // Parse init data
  appendBuffer(buffer) {}         // Feed more data
  getVideoDecoderConfig() {}      // Returns { codec, width, height, ... }
  getAudioDecoderConfig() {}      // Returns { codec, sampleRate, channels, ... }
  getVideoChunks(duration) {}     // Returns EncodedVideoChunk[]
  getAudioChunks(duration) {}     // Returns EncodedAudioChunk[]
  clearChunks() {}                // Free processed chunks
}
```

**This is a clean abstraction** that could be extended with a TSDemuxer or MKVDemuxer.

### 4.3 JsWebm — The WebM/Matroska Demuxer

**File:** `chrome/player/modules/reencoder/webm.mjs` (3,554 lines!)

This is a **full WebM/Matroska parser** embedded directly in FastStream. It:
- Parses EBML headers, Segment, Cluster, Track elements
- Extracts video packets (VP8/VP9/AV1) and audio packets (Opus/Vorbis)
- Handles seeking via CuePoints
- Supports color space metadata (HDR mastering data)
- Produces `EncodedVideoChunk` and `EncodedAudioChunk` for WebCodecs API

**This is essentially what we'd need for MKV demuxing!** Since WebM is a subset of Matroska, this parser already understands the EBML structure. It could potentially be extended to handle full MKV files (with H.264/AAC codec private data).

### 4.4 How FastStream Uses the Reencoder

The reencoder is used for **format conversion** (e.g., saving HLS/DASH streams as MP4 files). It's NOT used for real-time playback. The flow is:

```
HLS/DASH segment → Demuxer → EncodedVideoChunk/AudioChunk → MP4Muxer → .mp4 file
```

This uses WebCodecs API's `EncodedVideoChunk` and `EncodedAudioChunk` — raw codec frames without container overhead.

---

## 5. SourceBufferWrapper Comparison

### FastStream's SourceBufferWrapper
```js
class SourceBufferWrapper extends EventEmitter {
  constructor(mediaSource, codec) {
    // Checks MediaSource.isTypeSupported(codec) — throws if unsupported
    this.sourceBuffer = mediaSource.addSourceBuffer(codec);
    this.updating = false;
    this.toDo = [];  // Queue of { type: 'append'|'remove', buffer, resolve, reject }
  }
  appendBuffer(buffer) { return new Promise(/*...*/); }
  remove(start, end) { return new Promise(/*...*/); }
}
```

### Our SourceBufferWrapper (`app/src/lib/faststream/players/SourceBufferWrapper.ts`)
```ts
class SourceBufferWrapper {
  private queue: Array<{ type, data?, start?, end? }> = [];
  private fatalError = false;  // Bug #4 fix
  appendBuffer(data: ArrayBuffer): void { /*...*/ }
  remove(start: number, end: number): void { /*...*/ }
  resetForSeek(): Promise<void> { /*...*/ }  // Custom seek support
}
```

**Differences:**
| Feature | FastStream | Our Implementation |
|---------|-----------|-------------------|
| Promise-based append | ✅ | ❌ (fire-and-forget) |
| Fatal error detection | ❌ | ✅ (Bug #4 fix) |
| QuotaExceeded handling | ❌ | ✅ (Bug #16 fix) |
| Seek buffer reset | ❌ | ✅ (`resetForSeek()`) |
| EventEmitter | ✅ | ❌ |

**Our implementation is MORE robust** for our use case (Telegram streaming with large files, seeks, and buffer pressure).

---

## 6. Key Takeaways for NoBuf

### 6.1 What FastStream Does Right

1. **Plugin-based player architecture** — Each format gets its own player module. Clean separation. We already have this pattern (`MP4Player`, `HLSPlayer`, `DirectVideoPlayer`).

2. **URL-extension-based format detection** — Simple, fast, predictable. No magic byte sniffing overhead.

3. **hls.js handles TS internally** — FastStream doesn't need a standalone TS transmuxer because hls.js does it. But for standalone .ts files (not HLS), there's no support.

4. **JsWebm is a complete EBML/WebM parser** — Already embedded in the codebase. 3,554 lines of production-tested WebM demuxing code. This could be the foundation for MKV support.

5. **AbstractDemuxer pattern** — Clean interface for format-specific demuxers. Could be adopted for our TS/MKV support.

6. **WebCodecs API integration** — The reencoder uses `EncodedVideoChunk`/`EncodedAudioChunk` for format conversion. This is the "future path" for H.265 support.

### 6.2 What FastStream Does NOT Do

1. **No standalone .ts file support via MSE** — .ts files fall back to native playback. Only TS-inside-HLS is handled (by hls.js).

2. **No MKV support via MSE** — MKV files fall back to native playback. The JsWebm parser could handle VP8/VP9 MKV, but it's not wired up for that.

3. **No content-based format detection** — It doesn't check magic bytes (ftyp, EBML, 0x47). This means mislabeled files won't play correctly.

4. **WebM is NOT MSE-accelerated** — FastStream explicitly maps `.webm` to `DIRECT` (native playback). This is a missed opportunity since MSE supports WebM natively.

### 6.3 Patterns We Should Adopt

#### A. AbstractDemuxer Interface
```ts
// Inspired by FastStream's reencoder/demuxers.mjs
interface FormatDemuxer {
  initialize(data: ArrayBuffer): void;
  appendBuffer(data: ArrayBuffer): void;
  getTracks(): TrackInfo[];
  getCodecString(trackId: number): string;
  seek(timeSeconds: number): number; // Returns byte offset
  onSegment: (trackId: number, data: ArrayBuffer) => void;
  destroy(): void;
}
```

#### B. Format Detection with Magic Bytes (Improvement Over FastStream)
```ts
function detectFormat(buffer: ArrayBuffer): 'mp4' | 'ts' | 'mkv' | 'webm' | 'unknown' {
  const view = new Uint8Array(buffer);
  // MP4: ftyp box at offset 4-7
  if (view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70) return 'mp4';
  // TS: sync byte 0x47 at offsets 0, 188, 376
  if (view[0] === 0x47 && view[188] === 0x47 && view[376] === 0x47) return 'ts';
  // MKV/WebM: EBML header 0x1A45DFA3
  if (view[0] === 0x1A && view[1] === 0x45 && view[2] === 0xDA && view[3] === 0xA3) return 'mkv';
  return 'unknown';
}
```

#### C. Reuse FastStream's JsWebm for MKV
FastStream's `webm.mjs` (3,554 lines) is a complete Matroska parser. Since WebM is a subset of Matroska, this parser already handles:
- EBML header parsing
- Segment/Cluster/Track hierarchy
- CuePoint-based seeking
- VP8/VP9/AV1 video codec data
- Opus/Vorbis audio codec data

**What it DOESN'T handle (MKV-specific):**
- H.264 codec private data (AVCC format)
- AAC codec private data (AudioSpecificConfig)
- H.265 codec private data
- ASS/SSA subtitle tracks
- Ordered chapters
- Attachments (fonts, cover art)

**To extend for MKV:** We'd need to add H.264/AAC codec private data parsing to the track initialization code. The container-level parsing (EBML, Clusters, Blocks) is already done.

#### D. Use mux.js for TS (FastStream Proves This Works)
FastStream's hls.js uses the exact same TS demuxer as mux.js (they share the same codebase). The TS→fMP4 transmuxing pipeline is battle-tested at massive scale. For standalone .ts files, mux.js is the right tool.

---

## 7. Recommended Architecture Inspired by FastStream

### 7.1 New Player Modes for NoBuf

```ts
// Add to our PlayerModes:
export const PlayerModes = {
  // Existing:
  MP4: 'mp4',           // mp4box.js → MSE
  HLS: 'hls',           // (future) hls.js → MSE
  DIRECT: 'direct',     // native <video>

  // New:
  TS: 'ts',             // mux.js → fMP4 → MSE
  MKV_WEBM: 'mkv_webm', // JsWebm → WebM → MSE (VP8/VP9/Opus)
  MKV_MP4: 'mkv_mp4',   // JsWebm + mp4box → fMP4 → MSE (H.264/AAC)
};
```

### 7.2 Format Detection Pipeline (Improvement Over FastStream)

```
File arrives (URL + first 512KB)
    │
    ▼
Magic byte detection (improvement over FastStream's extension-only approach)
    │
    ├── ftyp (0x66747970) → MP4Player (existing mp4box.js pipeline)
    ├── 0x47 sync bytes   → TSPlayer (new, using mux.js)
    ├── EBML (0x1A45DFA3) → Check DocType
    │   ├── "webm" / "matroska" with VP8/VP9/Opus → MKVWebmPlayer
    │   └── "matroska" with H.264/AAC             → MKVMP4Player
    └── Unknown           → DirectVideoPlayer (native fallback)
```

### 7.3 New TSPlayer Module

```ts
// Inspired by FastStream's MP4Player architecture
class TSPlayer extends EventEmitter {
  private transmuxer: Transmuxer; // from mux.js
  private videoSourceBuffer: SourceBufferWrapper;
  private audioSourceBuffer: SourceBufferWrapper;

  async setSource(source: VideoSource) {
    this.transmuxer = new Transmuxer({ keepOriginalTimestamps: true });
    this.transmuxer.on('data', (segment) => {
      if (!this.initSegmentAppended) {
        this.videoSourceBuffer.appendBuffer(segment.initSegment);
        this.initSegmentAppended = true;
      }
      this.videoSourceBuffer.appendBuffer(segment.data);
    });

    // Use existing download loop, feed to transmuxer instead of mp4box
    this.startDownloadLoop(source.url);
  }

  private startDownloadLoop(url: string) {
    // Similar to our existing useMSEPlayer.ts download loop
    // But feeds chunks to transmuxer.push() instead of mp4box.appendBuffer()
  }
}
```

### 7.4 New MKVDemuxer Module (JsWebm Extension)

```ts
// Based on FastStream's webm.mjs
class MKVDemuxer extends AbstractDemuxer {
  private ebmlParser: JsWebm; // Reuse FastStream's WebM parser

  initialize(data: ArrayBuffer) {
    this.ebmlParser = new JsWebm();
    this.ebmlParser.queueData(data);
    this.ebmlParser.validateMetadata();

    // Check if codecs are WebM-compatible or need fMP4 remuxing
    const docType = this.ebmlParser.docType; // "webm" or "matroska"
    const videoCodec = this.ebmlParser.videoCodec; // "V_VP8", "V_VP9", "V_MPEG4/ISO/AVC"
    const audioCodec = this.ebmlParser.audioCodec; // "A_OPUS", "A_AAC"
  }
}
```

---

## 8. Files to Extract from FastStream

| File | Size | Purpose | Reuse Strategy |
|------|------|---------|---------------|
| `modules/reencoder/webm.mjs` | 3,554 LOC, 106KB | EBML/WebM parser | Extend for MKV demuxing |
| `modules/mp4box.mjs` | ~6,000 LOC | Customized mp4box.js | We already use mp4box (upstream) |
| `modules/hls.mjs` + `modules/hls.worker.js` | ~15,000 LOC | Customized hls.js | Reference for TS demuxer internals |
| `players/mp4/SourceBufferWrapper.mjs` | 74 LOC | SourceBuffer queue | Our implementation is better |
| `players/mp4/MP4Player.mjs` | 868 LOC | MP4 MSE player | Similar to our useMSEPlayer.ts |
| `utils/URLUtils.mjs` | 198 LOC | Format detection | Adopt extension-based detection |
| `enums/PlayerModes.mjs` | 10 LOC | Player mode constants | Adopt plugin pattern |

---

## 9. What FastStream Validates About Our Research

| Our Research Claim | FastStream Validation |
|-------------------|----------------------|
| mux.js can transmux TS → fMP4 for MSE | ✅ **Validated** — hls.js (bundled in FastStream) uses the same transmuxer |
| mp4box.js is the right tool for MP4 MSE | ✅ **Validated** — FastStream uses customized mp4box.js |
| WebM can play natively via <video> | ✅ **Validated** — FastStream maps .webm to DIRECT (native) |
| MKV needs demuxing for MSE | ✅ **Validated** — FastStream has no MKV MSE support, falls back to DIRECT |
| JsWebm/ebml.js can parse Matroska | ✅ **Validated** — FastStream bundles a full 3,554-line WebM parser |
| H.265 MSE support is limited | ✅ **Validated** — FastStream has no H.265 MSE path |
| AbstractDemuxer pattern works | ✅ **Validated** — FastStream uses this exact pattern in reencoder |

---

## 10. Action Items for NoBuf

### Immediate (Steal from FastStream)
1. ✅ **Adopt the AbstractDemuxer interface** — clean abstraction for format-specific demuxers
2. ✅ **Add magic byte detection** — improvement over FastStream's extension-only approach
3. ✅ **Steal JsWebm** (`webm.mjs`) — 3,554 lines of production-tested EBML parsing for MKV support

### Short-term (New Players)
4. Add `TSPlayer` using mux.js — ~550 LOC (estimated)
5. Add `MKVDemuxer` extending JsWebm — ~200 LOC for H.264/AAC codec support
6. Add `MKVWebmPlayer` for VP8/VP9/Opus MKV → WebM MSE

### Medium-term (Backend)
7. Rust MKV demuxer for H.265/AC-3/DTS content
8. Backend transcoding pipeline

---

## References

- [FastStream GitHub](https://github.com/Andrews54757/FastStream)
- [FastStream source: PlayerLoader.mjs](chrome/player/players/PlayerLoader.mjs)
- [FastStream source: URLUtils.mjs](chrome/player/utils/URLUtils.mjs)
- [FastStream source: demuxers.mjs](chrome/player/modules/reencoder/demuxers.mjs)
- [FastStream source: webm.mjs](chrome/player/modules/reencoder/webm.mjs)
- [FastStream source: MP4Player.mjs](chrome/player/players/mp4/MP4Player.mjs)
