# JS-side embedded-subtitle extraction — library evaluation

2026-07-31. Absorbed by controller after two subagent failures (HTTP 405).
Evidence from npm registry JSON, unpkg-fetched sources, and LOCAL node_modules
reads. Tags: [VERIFIED src=…].

## 1. matroska-subtitles (npm 3.3.2)

- Last publish **2021-09-20**; deps `ebml-stream`, `pako`,
  **`readable-stream`** [VERIFIED src=registry.npmjs.org/matroska-subtitles].
- Node-stream API (`SubtitleParser`/`SubtitleStream` are Transform streams) —
  under Vite/WebView2 it needs Node stream/Buffer polyfills
  (`readable-stream` pulls `process`/`buffer` shims). Events: `tracks`
  (includes ASS header from CodecPrivate), `subtitle` ({text,time,duration}),
  `file` (attachments). `SubtitleStream` supports resuming mid-file on a new
  byte offset but needs the header parsed first.
- Verdict: viable but stale (4.5 y), stream-polyfill friction, MKV-only,
  and it wants the BYTES pushed through it (we'd hand-manage Range reads).

## 2. @cryguy/mkv-subtitle-extractor (npm 1.0.1)

- Published **2026-01-31**, zero deps, dual ESM/CJS, TypeScript types
  [VERIFIED src=registry.npmjs.org + unpkg dist/index.d.ts].
- API: `extractSubtitles(url, options) → Promise<TrackResult[]>` where
  TrackResult = `{type:'srt'|'ass'|'ssa'|'vtt', metadata:{trackNumber,
  language, trackName}, output:{subtitle:Uint8Array, fonts:FontFile[]|null}}`.
  Options: languages filter, custom fetch/headers, concurrency,
  allowFullDownload. Throws typed `RangeNotSupportedError`/`MkvParseError`.
- Mechanism [VERIFIED src=unpkg dist/index.js, read in full]: EBML header →
  SeekHead → Tracks; then **if the Cues index contains entries for the
  subtitle tracks**, it computes each block's absolute position
  (CueClusterPosition + CueRelativePosition), batches nearby targets
  (gap-threshold heuristic), and Range-reads ONLY those slices — the "~97%
  savings" case. **If Cues lack subtitle entries (common: many muxers cue
  video only) → linear cluster scan of the whole segment.** Fonts: reads
  Attachments element, returns them as Uint8Arrays. Assembles complete
  SRT/ASS text (header from CodecPrivate + blocks sorted by time).
- Quality: genuinely well-built (unknown-size cluster handling, relative-pos
  fallback, batch heuristics, typed errors, verbose logging).

## 3. Others

- `jswebm`/generic EBML parsers: demuxer building blocks, no subtitle
  assembly/fonts — would mean reimplementing #2. Not worth it. [INFERRED]

## 4. MP4 side: mp4box.js (local 0.5.2)

- `getInfo()` classifies tracks via sample-entry: `movie.subtitleTracks[]`
  with `codec` (e.g. `tx3g`), `language` (elng/mdhd) — same track shape as
  audio/video [VERIFIED-LOCAL app/node_modules/mp4box/src/isofile.js:328-386].
- No built-in cue/text assembler for tx3g (only `vttC` sample-entry parsing
  exists under src/parsing; no wvtt-sample→cue helper). Extraction would be
  `setExtractionOptions(trackId)` + `onSamples` → parse each sample manually:
  tx3g sample = 2-byte BE text length + UTF-8 bytes (+ optional style boxes)
  [VERIFIED src=3GPP TS 26.245 §5.17 sample format; consistent with ffmpeg's
  movtextdec]. Doable but bespoke; ffmpeg does it for free (mov_text→srt
  verified in subs-ffmpeg-extraction.md E5/E18).

## 5. jassub font intake (local 2.5.1)

[VERIFIED-LOCAL app/node_modules/jassub/dist/jassub.d.ts:21-23 + README]
- `fonts?: Array<string | Uint8Array>` — URLs or raw bytes, preloaded ASAP,
  non-blocking.
- `availableFonts?: Record<string, Uint8Array | string>` — lazy,
  case-insensitive family-name map (loads only when the script references).
- `defaultFont?: string`; late addition via
  `await instance.renderer.addFonts([...])` (README L168; can cause FOUT).
- README: "Supports … embedded fonts"; by default uses embedded + constructor
  + local fonts only (no network unless `queryFonts:'localandremote'`).
- Fit: backend dumps MKV font attachments → serve via HTTP → pass URL array
  as `fonts` (or `availableFonts` keyed by family if we parse names — start
  with `fonts`, simpler).

## 6. Verdict table (evidence, controller decides)

| Criterion | Backend ffmpeg endpoint | @cryguy JS lib | matroska-subtitles |
|---|---|---|---|
| Containers | MKV+MP4+anything ffmpeg reads | MKV only | MKV only |
| ASS fidelity | full header+styles (E6) | full (CodecPrivate) | full |
| Fonts | `-dump_attachment` → serve (E12) | Uint8Arrays in-page | `file` event |
| Uncached file over /stream | ONE sequential read → **contiguous cache warm** (fits prebuffer model) | scattered Range reads; vs Telegram chunking each hit pulls a whole MTProto chunk → most of the file anyway, fragmented cache; linear-scan fallback when Cues lack sub entries | same, plus we manage reads |
| Cached file | local path, 0.15 s (P7) | still HTTP + JS parse | same |
| Charset repair | `-sub_charenc` retry (E9c) | none (raw bytes) | none |
| Bitmap subs | listed, cleanly refused | absent silently | absent |
| Deps/bundle | zero JS | +42 KB, zero deps, 2026-fresh | stale, needs stream polyfills |
| Effort here | LOW — mirrors shipped /audio_tracks + /thumb patterns | medium (new client path + cache coordination) | high |

Key structural point: NoBuf's cache/downloader is optimized for contiguous
sequential ranges (prefix cache, prebuffer, FLOOD-safety). The JS lib's
scattered-read advantage inverts into a liability against Telegram-chunked
downloads, and its MKV-only scope leaves MP4 mov_text uncovered. The backend
already has the exact endpoint patterns (probe memoization, input-source
resolution, per-message serialization) shipped and tested for audio tracks.
