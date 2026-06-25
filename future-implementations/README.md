# Future Implementations — NoBuf Video Player

This folder contains research and technical specifications for upcoming features.

## Documents

| Document | Topic | Status |
|----------|-------|--------|
| [ts-support-research.md](./ts-support-research.md) | MPEG-TS (.ts) file support via MSE transmuxing | 📋 Research complete |
| [mkv-support-research.md](./mkv-support-research.md) | Matroska/MKV (.mkv) file support via MSE remuxing | 📋 Research complete |
| [mse-library-comparison.md](./mse-library-comparison.md) | Comparison of all MSE media libraries (mux.js, mpegts.js, hls.js, ffmpeg.wasm, etc.) | 📋 Research complete |
| [faststream-architecture-analysis.md](./faststream-architecture-analysis.md) | Deep analysis of FastStream's multi-format player architecture | 📋 Research complete |

## Quick Summary

### .ts Support
- **Problem:** mp4box.js can't parse MPEG-TS (no `ftyp` box)
- **Solution:** Use **mux.js** to transmux TS → fMP4, then feed to existing MSE SourceBuffer pipeline
- **Effort:** ~550 LOC, +30KB bundle (lazy-loaded)
- **Priority:** P0 — high impact, low effort
- **FastStream validation:** FastStream's hls.js uses the same TS demuxer internally — proven at massive scale

### .mkv Support
- **Problem:** mp4box.js can't parse EBML/Matroska, and MSE doesn't accept MKV containers
- **Solution:** Reuse FastStream's **JsWebm** (3,554-line production-tested EBML parser) + extend for H.264/AAC codec private data
- **For VP8/VP9/Opus MKV:** JsWebm → WebM segments → MSE (simplest path)
- **For H.264/AAC MKV:** JsWebm + mp4box.js → fMP4 segments → MSE
- **For H.265/AC-3/DTS:** Backend transcoding via Tauri/Rust
- **Priority:** P1-P2

### FastStream Architecture Insights
- **Plugin-based player system** — each format gets its own player module (lazy-loaded)
- **URL-extension-based detection** — simple, fast (we should add magic byte detection as improvement)
- **AbstractDemuxer pattern** — clean interface for format-specific demuxers (adopt this)
- **JsWebm is a goldmine** — full Matroska parser already in production, can be extended for MKV
- **WebM is NOT MSE-accelerated in FastStream** — missed opportunity, we should do this
- **Our SourceBufferWrapper is MORE robust** — Bug #4 fatal error detection, Bug #16 QuotaExceeded handling, seek buffer reset

### Key Insight
Our custom MSE buffer management (eviction, VBR lookup table, range reporting, Telegram integration) is a competitive advantage. We should use **transmuxer libraries** (mux.js, JsWebm) that produce fMP4/WebM segments, NOT full player libraries (mpegts.js, hls.js) that would replace our pipeline.
