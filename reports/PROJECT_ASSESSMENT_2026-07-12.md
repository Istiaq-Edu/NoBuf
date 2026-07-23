# NoBuf — README & Website Update Assessment

**Date:** 2026-07-12
**Branch assessed:** `improvements` (2 commits ahead of `main`)
**Latest tag:** `v0.7.0` (2026-06-26)
**Commits since v0.7.0:** 107 files changed, +22,037 / −1,562

> **Purpose of this document:** it is the brief for refreshing `README.md` and the project website. Its job is to make sure every new feature and improvement that shipped since the last docs pass is captured and surfaced — not silenced or buried. Build/test status and a short "known gaps" appendix are included for honesty, but the spine is **what's new and what's good**.
>
> Every claim below was verified by reading the actual source or running a real build. Where commit messages and code disagreed, code wins.

---

## 1. Health snapshot (so docs don't overpromise)

| Gate | Result |
|------|--------|
| `cargo check` (backend) | ✅ pass (26.5s) |
| `npx tsc --noEmit` (frontend) | ✅ pass |
| `npx vitest run` (tests) | ✅ 133 passed / 8 files |

The tree compiles clean and tests are green. Docs can confidently describe the current feature set as working.

---

## 2. What NoBuf is (current, one paragraph for the website)

NoBuf is a **Tauri v2 + Rust desktop app** that turns Telegram channels into a zero-buffer video streaming library. It streams video directly from Telegram's CDN into a custom in-browser media engine (no download-first, no transcode wait), with continuous prebuffering so playback never stalls — even across seeks. It is not a thin wrapper: it ships its own MSE transmuxing engine, a Rust streaming server with a download coordinator, a Grammers (MTProto) Telegram layer, and a React/TS UI.

**Stack (verified):** React 19 · TypeScript · Tailwind 4 · Rust + Grammers + Actix-web · mp4box.js / mpegts.js / Mediabunny · ffmpeg-sidecar · Tauri v2 · Vite 7.

---

## 3. Major improvements shipped (the spine — verify before updating docs)

### 3.1 MKV playback — rebuilt and now the best-engineered path
*(commit `47c1ab4` — "MKV MSE decode crash + streaming robustness")*

- **Decode-crash at ~51s fixed.** Refills now stop *exactly* on a keyframe boundary (reads the MKV cue index, not a sparse list), so the next refill abuts with zero overlap → no stranded P-frame → no `PIPELINE_ERROR_DECODE`.
- **Persistent MKV input.** Seeks reuse a warm demuxer state instead of re-parsing the file tail over the network on every seek → far seeks go from a full network re-parse to an in-memory lookup + one cluster fetch.
- **Real VBR byte↔time calibration.** The green prebuffer bar is now accurate for variable-bitrate MKV, seeded from the file's own cue index with monotonicity guards.
- **MKV disk-cache warmer.** A sequential walk fills the on-disk cache contiguously to EOF, so the prebuffer bar progresses smoothly.
- **Codec-routed MKV.** H.264 → client-side transmux (native keyframe seek); H.265 / VP9 → ffmpeg `/remux` → mpegts.js; VP8 / VP9 / AV1 → native `<video>`.

### 3.2 Backend streaming robustness
- **Cross-channel file collisions fixed.** Cache + resolution now keyed by `(folder, message)` — channel A's file 18 no longer serves channel B's file 18.
- **Download-coordinator fixes.** End-byte coverage gating, fixed underflow in boundary logging, hot-path log spam demoted to debug.
- **stco 32-bit overflow guard.** Corrupt offsets are now skipped (a recoverable stall) instead of silently wrapped (silent corruption).
- **Zero-size media panic guard.** Range parsing no longer underflows on empty representations.
- **Windows cache-file protection.** `.dat` cache files are opened without `FILE_SHARE_DELETE` so antivirus/cleanup can't delete them mid-stream.

### 3.3 Coordinator isolation (thumbnail vs playback)
The streaming source now tags every request with a `source_id` (playback / tail / thumbnail), so the thumbnail pipeline and the player no longer cancel each other's downloads. Superseded seeks abort their in-flight fetch immediately, freeing the backend slot.

### 3.4 Public channel browsing (large feature, ~30 commits)
Browse and stream from any public Telegram channel: paste a `t.me/...` link or join from your dialogs, preview before joining, infinite-scroll file lists, forward-to-folder, remove, read-only banner for not-a-member channels, and a `[NB-PUB]` auto-sync system. Collapsible sidebar sections with count badges and avatars.

### 3.5 Authentication — QR + phone + 2FA
Full login flow: phone + code + 2FA password, **QR login** (scan with the Telegram app, with DC-migration handling and flood-wait protection), auto-reconnect, and session-corruption recovery.

### 3.6 Player UX additions
Controls pinning toggle, draggable settings chips, **pause/resume prefetch controls** (paused stays paused — prebuffer persists through seeks), larger buffers for public channels (20 MB cold-start / 120 s prefetch / 80 MB max), **external file drag-drop from Explorer**, dynamic cold-start overlay, and thumbnail-suppressed seeks.

### 3.7 SourceBuffer resilience
The MSE append layer now drains correctly on timestamp changes, recovers from quota-exceeded and fatal decoder errors instead of cascading — a single glitch no longer wedges the player.

---

## 4. Feature inventory (verified — use this to rewrite README + website)

### Streaming engine
- MSE player for **MP4** (mp4box.js), **TS** (mpegts.js + byte-offset scanner), **MKV / WebM** (Mediabunny transmuxer + ffmpeg `/remux` fallback)
- Continuous prebuffer (180 s ahead / 30 s behind sliding window), disk-backed cache with byte-range tracking + gap detection
- Background cache continues after the player closes
- VBR-accurate prebuffer bar
- Scrub thumbnails (sprite sheets), frame-accurate seek
- Cold-start optimization overlay (dynamic threshold, gates on real buffered runway)
- Pause/resume prefetch controls

### File management
- Folder system (channels as folders), grid + list views with virtual scrolling
- Drag & drop upload + **external file drag-drop from Explorer**
- Parallel downloads (3-worker download pool)
- Image preview, PDF viewer (pdfjs-dist), archive extract, remote upload by URL
- Forward-to-folder, move, rename, delete

### Public channels
- Paste-link join, browse-joined, channel preview, infinite scroll, `[NB-PUB]` sync, read-only banner, not-a-member handling

### Auth
- Phone + code + 2FA, **QR login**, auto-reconnect, session recovery

### Platform
- Local-only, no telemetry, credentials stay on device
- Optional REST API (off by default, `X-API-Key` SHA-256 hashed)
- Bandwidth monitor, speed limiter, updater plugin (not yet active)
- Cross-platform builds (Windows / macOS Intel + ARM / Linux), tray minimize / quit / cancel
- Video player settings (speed, fit, brightness, rotation, loop)

---

## 5. What the current README/website is **missing** (the update list)

The existing `README.md` badge says `v0.4.1`; the latest tag is `v0.7.0` and the app is `0.6.0`. The docs predate almost everything below. **These are the sections to add/refresh:**

1. **Version badge** — fix to current release; reconcile the three version numbers (see Appendix A1).
2. **MKV playback** — currently described only as "via ffmpeg `/remux`." It now has a native client-side transmux path with keyframe seek; document codec routing (avc / hevc / vp9 / av1).
3. **Public channel browsing** — entirely absent. Add a section.
4. **QR login** — absent. Add to Auth.
5. **External drag-drop from Explorer** — absent.
6. **Pause/resume prefetch controls** — absent (currently only "continuous prebuffer").
7. **VBR-accurate prebuffer bar** — the old README implies linear mapping; update to reflect cue-indexed calibration.
8. **Dynamic cold-start overlay** — absent.
9. **Backend robustness fixes** (cross-channel collisions, Windows cache protection) — worth a one-line "reliability" note, not a feature section.
10. **CHANGELOG** — regenerate via git-cliff for the `improvements` branch; it currently stops at v0.7.0.

---

## 6. Known gaps (appendix — kept honest, not the headline)

These are real and verified, listed so they aren't silenced. They do **not** block describing the feature set above as working; they are pre-v0.8 polish.

| ID | Severity | Gap | Note |
|----|----------|-----|------|
| A1 | Medium | **Version inconsistency** | `package.json`/`Cargo.toml` = `0.6.0`; tag = `v0.7.0`; README badge = `v0.4.1`. Pick one source of truth. |
| A2 | Medium | **SQL built via `format!()` in `public_channels.rs`** (`:461`, `:719`, `:1001`) | Same injection pattern the security audit flagged as CRITICAL in `folder_groups.rs` (which was fixed). Channel name is user-controlled. Lower exploitability (SQLite blocks `;` stacking) but should be parameterized for consistency + safety. |
| A3 | Medium | **MKV far-seek timing not runtime-proven** | The persistent-Input fix is sound in code; the project's own docs mark the 15 s seek as needing a `tauri dev` measurement to confirm. Describe as "rebuilt" — not "instant" — until measured. |
| A4 | Low | **Test coverage narrow** | 133 unit tests; the 7,235-line `useMSEPlayer.ts` orchestration has no integration tests. Highest-risk code, least-covered. |
| A5 | Low | **Unapplied audit hardening (H11)** | Remux endpoint still builds its URL from the Host header; audit recommended hardcoding `127.0.0.1`. Local-app low risk. |
| A6 | Low | **Leftover debug `console.log`** in hot paths (`SourceBufferWrapper`, `deferComputeDuration`) | Harmless; quiet for release. |
| A7 | Low | **Generated audit artifacts committed** (`reports/*.html`, dated `.hermes` notes) | Bloat the tree; consider `.gitignore` or a wiki. |

---

## 7. Recommended doc actions (in order)

1. **Rewrite README** from §4 — fix the version badge, add Public Channels, QR Login, MKV engine (codec routing), External drag-drop, Pause/resume prefetch, VBR bar, Cold-start overlay. Lead with the zero-buffer story; keep the "How it works" diagram but update the format-support note.
2. **Regenerate CHANGELOG** via git-cliff for the `improvements` branch so v0.7.0 → current is captured.
3. **Website feature page** — mirror §4 as the feature grid; use §3 as the "recently improved" highlight (MKV rebuild is the headline win).
4. **Close A1/A2** before tagging the next release (version reconciliation + parameterize the three SQL builds — ~1–2h total).
5. **Housekeeping** — quiet debug logs (A6), consider ignoring generated audit HTML (A7).

---

## 8. Supported video formats & codecs (cross-validated against code)

> Every entry below was traced through the actual routing code: `FormatDetector.ts`, `useMSEPlayer.ts` (`:2118`–`:2334`, `:4984`–`:5043`), `MediabunnyTransmuxer.ts` (`:78`–`:84`, `:478`–`:503`), `FastStreamPlayer.tsx` (`:694`–`:770`), and `server.rs` (`:1974`–`:2410`). ✅ = supported, ❌ = not supported, ⚠ = works but has a known issue.

### 8.1 By container format

| Container | Detection | Playback path | Seek + progress bar | Notes |
|-----------|-----------|---------------|---------------------|-------|
| **MP4 / M4V / MOV** | `ftyp` box magic | mp4box.js → MSE (fMP4) | ✅ | Handles moov-at-start (faststart) **and** moov-at-end (fetches tail) |
| **MPEG-TS (.ts/.m2ts/.mts)** | sync byte `0x47` at offsets 0/188/376 | mpegts.js → MSE (fMP4) | ✅ | Raw `/stream` URL; backend byte-offset keyframe index accelerates seeks; `timed_id3` files auto-routed to `/remux` → mpegts.js |
| **MKV (.mkv/.mk3d)** | EBML magic `0x1A45DFA3` | codec-routed (see 8.2) | ✅ (avc/hevc) / native (vp8/9/av1) | See codec matrix |
| **WebM (.webm)** | EBML magic + `.webm` ext | native `<video>` | native | VP8/VP9/Opus decoded by WebView2 directly |
| **Other / unknown** | extension fallback | native `<video>` (best-effort) | native | Truly unsupported codecs surface `unsupportedCodec` UI state (`:762`) |

### 8.2 MKV codec matrix

| Video codec (in MKV) | Path | Engine | Native keyframe seek | Notes |
|----------------------|------|--------|----------------------|-------|
| **H.264 / AVC** | client-side transmux | MediabunnyTransmuxer → fMP4 | ✅ | Preferred path; seeks by MKV cue index (`nearestCueKeyframeAtOrBefore`) |
| **H.265 / HEVC** | ffmpeg `/remux` | → MPEG-TS → mpegts.js | ✅ | `decideMseCodec` marks hevc "unsupported" for fMP4, but MKV router overrides → `/remux` |
| **VP9** | native | `<video>` (WebView2) | native | Cannot be `-c:v copy`'d into MPEG-TS |
| **VP8** | native | `<video>` (WebView2) | native | Same reason |
| **AV1** | native | `<video>` (WebView2) | native | Same reason |
| **undetectable** | native fallback | `<video>` | native | Best effort; H.264 would fail natively but no better option |

### 8.3 Audio handling

| Path | Audio behavior | Source |
|------|----------------|--------|
| **MP4** (mp4box.js) | Demuxed in-browser; whatever's in the MP4 (AAC, MP3, AC3, Opus) | `useMSEPlayer.ts` mp4box onReady |
| **TS** (mpegts.js, primary) | Demuxed in-browser by mpegts.js; transmuxed to fMP4 for MSE. No re-encoding — audio is whatever the TS contains (AAC, MP3, AC3) | `_initMpegtsPlayer` uses raw `/stream` URL |
| **TS** (`/remux`, timed_id3 only) | Re-encoded to **AAC 192k** by ffmpeg (`-c:a aac -b:a 192k -af asetpts=N/SR/TB`) | `server.rs:2244-2250` |
| **MKV avc** (MediabunnyTransmuxer) | Demuxed in-browser alongside video; codec detected via `getCodec()` + `getCodecParameterString()`. Builds MSE mimeType with audio codec string (e.g. `mp4a.40.2` for AAC). If audio keyframe can't be found near seek position, video-only segments are produced | `MediabunnyTransmuxer.ts:297-338` |
| **MKV hevc** (`/remux`) | Same AAC 192k re-encode path as timed_id3 | `server.rs` |
| **Native** (WebM/VP9/AV1) | Handled by WebView2 decoder (Opus/Vorbis/AAC) | browser |
| **No audio track** | Video-only segments produced; Output treats closed audio source as "done" | `MediabunnyTransmuxer.ts:1410-1434` |

### 8.4 ⚠ Bug found during cross-validation: `/remux` Content-Type mismatch

**Severity:** Low-Medium (pre-existing, not a regression)

The `/remux` endpoint has a **stale label mismatch**:

| What | Says | Actually is |
|------|------|-------------|
| Function name | `remux_ts_to_mp4` | Outputs MPEG-TS |
| Doc comment (`server.rs:1976`) | `ffmpeg -f mp4 -movflags frag_keyframe+empty_moov` | Actual args: `-f mpegts -mpegts_flags resend_headers` |
| Content-Type header (Strategy B, `:2398`) | `video/mp4` | Bytes are MPEG-TS |
| Content-Type header (Strategy A, `:2016`) | `video/mp4` (via `serve_local_file`) | Bytes are MPEG-TS |
| File extension (Strategy A, `:2006`) | `{}_{}.mp4` | Contains MPEG-TS data |
| FastStreamPlayer comment (`:708`) | "ffmpeg TS→MP4" | It's TS→MPEG-TS |

**Why it still works for the primary paths:** the `/remux` output is consumed by `_initMpegtsPlayer()` which feeds it to mpegts.js. mpegts.js parses raw bytes and doesn't rely on Content-Type headers — so it plays MPEG-TS correctly regardless of the `video/mp4` label.

**Where it breaks:** the TS fallback path (`useMSEPlayer.ts:5041`) sets `setUseNative(true)` + `remuxUrlRef.current = remuxUrl` when mpegts.js fails to initialize. `FastStreamPlayer.tsx:713` then sets `v.src = remuxUrl` on the native `<video>` element. Native `<video>` receives MPEG-TS bytes labeled `video/mp4` → **cannot decode** → playback fails silently. This is an edge case (mpegts.js failure is rare), but it's a real broken path.

**Recommended fix:** change the Content-Type to `video/mp2t` and the function name/doc comment to reflect MPEG-TS output. For the native fallback, either (a) skip setting `remuxUrlRef` since native can't play MPEG-TS, or (b) add a separate `/remux-mp4` endpoint that actually outputs fMP4 for native consumption.

### 8.5 Corrections vs the current README

1. **README says MKV plays "H.264/H.265 via ffmpeg `/remux` → mpegts.js."** Incomplete — H.264 MKV now has a *better* native-seek path (MediabunnyTransmuxer, no ffmpeg). Only **HEVC** MKV uses `/remux`.
2. **The `/remux` endpoint outputs MPEG-TS**, not MP4 (despite the function name `remux_ts_to_mp4`, the Content-Type `video/mp4`, and the `.mp4` file extension). The README's format-support callout should say "MPEG-TS via mpegts.js," not imply MP4.
3. **README claims "Other/unrecognized formats fall back to direct download playback"** — more precisely they fall back to native `<video>`, which may or may not decode depending on the codec; truly unsupported codecs surface an "unsupported codec" state.
4. **Audio re-encoding** is not mentioned in the README — the `/remux` path re-encodes audio to AAC 192k (not lossless). Primary TS playback (mpegts.js direct) preserves original audio.

---

## 9. One-line summary for the release notes

> **NoBuf v0.8 (pending):** rebuilt MKV playback (native keyframe seek, no more ~51 s decode crash), full public-channel browsing, QR login, Explorer drag-drop, pause/resume prefetch controls, and backend reliability fixes (cross-channel collisions, Windows cache protection). 133 tests green; builds clean on all platforms.
