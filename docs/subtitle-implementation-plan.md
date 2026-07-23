# Subtitle Support — Assessment & A-to-Z Implementation Plan

**Target project:** NoBuf (Telegram-Drive) — `D:\DEVELOPMENT\Telegram-Drive`
**Reference project:** FastStream extension — `D:\DEVELOPMENT\_ref_faststream` (v1.3.77, commit `d5fe931`)
**Author:** Hermes · verified against source + primary web docs. No assumptions — every claim below was read from code or confirmed online, and is tagged accordingly.

---

## 0. TL;DR (read this first)

- FastStream has a **complete, mature subtitle UI/parse/render/style/sync/search layer** (~4,000 LOC) — but it is **container-agnostic**: it operates on already-extracted subtitle *cues/text*, and it does **NOT demux embedded subtitle streams out of MKV/MP4 binaries**. `[VERIFIED — exhaustive grep of the whole player tree returned zero embedded-container subtitle extraction; all tracks enter via sidecar URL/file, OpenSubtitles API, or YouTube caption tracks.]`
- Your app already ships a stub, `app/src/lib/faststream/subtitles/SubtitleRenderer.ts`, that is **orphaned (nothing imports it) and hollow** (`renderSubtitles()` ignores its args, `updateSubtitles()` is never called). Its design assumes **mediabunny can read subtitle tracks — which is false.** `[VERIFIED — mediabunny docs: "Subtitle tracks are currently not supported for reading."]`
- Therefore the work splits into **two independent halves**:
  1. **Rendering/UX layer** — portable from FastStream, container-agnostic, works for every format. This is the big, reusable win.
  2. **Embedded-subtitle extraction layer** — NOT available from FastStream or mediabunny; must be built (JS `matroska-subtitles` for MKV, or a Rust demuxer). This is the hard, format-specific part.
- **Recommended first milestone:** ship the rendering layer + sidecar (`.srt`/`.ass`/`.vtt`) file loading + OpenSubtitles search. That delivers 80% of user value with zero dependency on risky binary demuxing. Embedded MKV extraction is a fast-follow; embedded MP4/TS and bitmap (PGS/VobSub) are explicitly out of scope for v1.

---

## 1. What FastStream actually supports (verified feature inventory)

Every item below was read from `_ref_faststream/chrome/player/...`.

### 1.1 Subtitle **sources** (how tracks get in)
| Source | File | Verified mechanism |
|---|---|---|
| **Sidecar file upload** (`.srt`, `.vtt`) | `SubtitlesManager.mjs` L207–221 | hidden `<input type=file accept=".vtt,.srt">` → `track.loadText()` |
| **Sidecar URL** (page-scraped `.vtt`/`.srt`/subtitle m3u8) | `main.mjs` L186–213 (`loadSubtitles`) + `background.mjs` L996–1071 | fetched over HTTP, language auto-detected via `chrome.i18n.detectLanguage` |
| **OpenSubtitles.com REST API** | `OpenSubtitlesSearch.mjs` | search `GET /api/v1/subtitles`, download `POST /api/v1/download` w/ `Api-Key` |
| **YouTube caption tracks** | `players/yt/YTPlayer.mjs` L245–253 | builds `SubtitleTrack` from YT timedtext |
| **Embedded MKV/MP4/WebM subtitle streams** | — | **NOT SUPPORTED.** `[VERIFIED — no code path extracts subtitle blocks from container binaries]` |

> Architectural truth `[VERIFIED]`: even "HLS/DASH subtitles" in FastStream arrive as **sidecar URLs scraped off the page**, then fetched and parsed as text. The bundled `hls.mjs`/`dash.mjs` subtitle-track code is library-internal and is **not** the path that feeds `SubtitlesManager`. The only two places a `SubtitleTrack` is constructed from real data are `main.mjs` (sidecar) and `YTPlayer.mjs` (YouTube).

### 1.2 Subtitle **formats** parsed
- **SRT** → converted to WebVTT via `SubtitleUtils.srt2webvtt()` `[VERIFIED — SubtitleUtils.mjs L51]`
- **WebVTT** → parsed directly by bundled `WebVTT.Parser` (`modules/vtt.mjs`, 1961 LOC — vendored vtt.js) `[VERIFIED]`
- **XML/TTML-ish** (YouTube `<text start dur>`) → `SubtitleUtils.xml2vtt()` `[VERIFIED — L73]`
- **SSA/ASS** → `SubtitleTrack.loadText()` only branches on `<?xml` / `WEBVTT` / else-SRT. **ASS is fed through `srt2webvtt`, which does NOT understand ASS.** So FastStream's ASS handling is effectively "best effort / broken for real ASS." `[VERIFIED — SubtitleTrack.mjs L41–50: no ASS branch]` It has **no libass/jassub** — styling/positioning tags in ASS are lost.
- **Bitmap subs (PGS/VobSub/DVDSub)** → not handled anywhere. `[VERIFIED]`

### 1.3 Rendering engine (`SubtitlesManager.renderSubtitles()` L614–714)
- Custom DOM overlay (NOT native `<track>`). Builds `.subtitle-track` divs inside `.fluid_subtitles_container`. `[VERIFIED]`
- **Binary search** over sorted cues by `currentTime` for O(log n) active-cue lookup. `[VERIFIED — L647]`
- **Multiple simultaneous active tracks** (e.g. dual-language). `activeTracks[]` is an array. `[VERIFIED — L616]`
- Cue → DOM via `WebVTT.convertCueToDOMTree` with per-cue DOM caching (`cue.dom`). `[VERIFIED — L667]`
- **Draggable vertical position** per track (mouse-drag adjusts `margin-bottom`), with `checkTrackBounds()` keeping subs inside the video. `[VERIFIED — L518–600]`
- **Test-subtitle mode** (renders a sample cue + B/W gradient bg to preview styling). `[VERIFIED — L193–204, L690]`

### 1.4 Styling (`SubtitlesSettingsManager.mjs` + `DefaultSubtitlesSettings.mjs`)
Verified configurable settings, persisted to storage as `subtitlesSettings`:
`fontFamily`, `fontWeight`, `fontSize` (`3vw` default), `color`, `background`, `outlineColor`, `outlineWidth`, `defaultLanguage`, `bottomMargin`. `[VERIFIED — DefaultSubtitlesSettings.mjs L1–11]`
- Outline is faked with a **perimeter `text-shadow` ring** algorithm (no native text-stroke). `[VERIFIED — applyOutline() L71–91]`
- Color pickers use the vendored `Coloris` module. `[VERIFIED]`

### 1.5 Sync / timing (`SubtitleSyncer.mjs`, 276 LOC)
- **Global shift** of all cues by a delta (`SubtitleTrack.shift()`), bound to keyboard. `[VERIFIED — KeybindManager.mjs L171/175: ±0.2s]`
- **Shift-from-cue-onward** (`shiftAfter()`) for fixing drift mid-file. `[VERIFIED — SubtitleTrack.mjs L27]`
- **Interactive timeline editor**: grab/drag cues, resize cue end-edge (`subEditMode`). `[VERIFIED — SubtitleSyncer.mjs L39–60]`

### 1.6 Export / misc
- **Cues → SRT export** (`SubtitleUtils.cuesToSrt()`). `[VERIFIED — L132]`
- **Auto-enable best track** by language match + "auto" label de-prioritization (`loadTrackAndActivateBest`). `[VERIFIED — SubtitlesManager.mjs L39–66]`
- **Toggle subtitles** on/off remembering last-active set. `[VERIFIED — L103–118]`
- Keybind `C` toggles subtitles. `[VERIFIED — DefaultKeybinds.mjs L34]`
- Track de-dup via `SubtitleTrack.equals()`. `[VERIFIED — L76]`

---

## 2. What NoBuf has today (verified current state)

| Piece | State | Evidence |
|---|---|---|
| `SubtitleRenderer.ts` (163 LOC) | **Orphaned + hollow stub** | Nothing imports it; `renderSubtitles(_trackIndex,_input)` ignores args; `updateSubtitles()` never called |
| `jassub@^2.5.1` | Installed, **unused** | in `package.json` + `node_modules/jassub` present |
| `mediabunny@^1.45.4` | Installed, used for MKV video/audio transmux | `MediabunnyTransmuxer.ts` |
| `matroska-subtitles` | **Not installed** | absent from `package.json` and `node_modules` |
| MKV transmux path | Pulls **only** `getPrimaryVideoTrack()`/`getPrimaryAudioTrack()` | `MediabunnyTransmuxer.ts` L292/297 — subtitle tracks skipped |
| Player control bar | Chip-based, drag-customizable | `FastStreamPlayer.tsx` L1424 `ALL_CHIPS` |
| Settings store | Tauri `plugin-store`, typed `Settings` interface | `SettingsContext` |
| Rust local server | Full HTTP **Range** support | `server.rs` L348 `parse_range_header`, L517 `Accept-Ranges` |

**Critical correction to the stub's premise** `[VERIFIED]`: `SubtitleRenderer.ts` claims it will "use Mediabunny's Input to find subtitle tracks, then matroska-subtitles for extraction." Mediabunny **cannot read subtitle tracks at all** — so the detection half is dead on arrival. `input.getTracks()` does return entries with `type:'subtitle'` and exposes `getLanguageCode()`/`getName()`/`getDisposition()`, so it can *enumerate that a subtitle track exists* — but there is **no API to read its packets/cues**. Extraction must come from elsewhere.

---

## 3. Verified external facts (primary sources)

1. **mediabunny cannot read subtitle cues.** `[VERIFIED — https://mediabunny.dev/guide/reading-media-files : "Subtitle tracks are currently not supported for reading." Only getVideo/AudioTracks + generic track metadata (type, language, name, disposition) exist.]`
2. **`matroska-subtitles` (npm, v3.3.2, last publish 2021)** — streaming MKV parser, browser-capable via CDN build. Emits `tracks` (with `.ass` header in CodecPrivate) then `subtitle` events `{text, time(ms), duration(ms)}`. Supports **`.srt`, `.ssa`, `.ass` text subs + embedded font extraction** via `file` event. Has a `SubtitleStream` class for **seek/random-access**. **No PGS/VobSub (bitmap).** `[VERIFIED — https://www.npmjs.com/package/matroska-subtitles]`
3. **Alternative: `@cryguy/mkv-subtitle-extractor`** (npm, active 2026) — extracts MKV subtitle tracks + fonts **via HTTP Range requests by URL**, works in browser. Directly compatible with NoBuf's Range-capable Rust server. `[VERIFIED — https://www.npmjs.com/package/@cryguy/mkv-subtitle-extractor]`
4. **PGS/VobSub are image subtitles** — require OCR (e.g. Subtitle Edit) to become text; cannot be converted by demuxers alone. `[VERIFIED — mkvtoolnix + matroska.org/technical/subtitles.html]`
5. **OpenSubtitles REST API** — `api.opensubtitles.com/api/v1`, `Api-Key` header; free consumers limited to **5 downloads/subtitle-file per day**, search is unlimited. `[VERIFIED — opensubtitles.stoplight.io getting-started]`
6. **jassub** — WASM libass renderer; needs the `.wasm` + a default font (or embedded fonts) bundled/served. This is the correct engine for **real ASS/SSA** styling that FastStream lacks.

### 3.1 Re-verification corrections (2nd pass — bugs caught before coding)
These correct earlier claims that would have caused runtime crashes or a wasted build cycle. `[RE-VERIFIED against installed source]`

- **⚠️ jassub API — the old stub used a NON-EXISTENT method.** The orphaned `SubtitleRenderer.ts` calls `this.jassubInstance.setContent(content)`. **`JASSUB` has no `setContent` method.** `[VERIFIED — node_modules/jassub@2.5.1 dist/jassub.d.ts]` The real API:
  - Construct: `new JASSUB({ video, subContent | subUrl, workerUrl, wasmUrl, modernWasmUrl, fonts?, availableFonts?, defaultFont? })`. Options are a discriminated union — pass exactly one of `{video}|{canvas}` AND one of `{subContent}|{subUrl}`.
  - Update track content at runtime: **`instance.setTrack(content)`** (delegates to `instance.renderer.setTrack(...)`, async IPC — await it), or `setTrackByUrl(url)`, or `freeTrack()`. NOT `setContent`.
  - Time nudge for sync: **`instance.timeOffset`** (number, seconds) — jassub's native shift; use it for ASS tracks instead of re-shifting cue times.
  - `default.woff2` ships in `dist/` as the built-in default font; `dist/wasm/jassub-worker.wasm` (non-SIMD) + `jassub-worker-modern.wasm` (SIMD) + `dist/worker/` must all be served/bundled. **Do NOT copy the stub's jassub usage — rewrite against this API.**

- **⚠️ Render path is NOT native-`<track>`-compatible — it hard-depends on the vendored `vtt.mjs`.** The Phase 1.2/2.2 waffle ("use browser `VTTCue` + a light parser") is risky. FastStream's chain is `new WebVTT.Parser(window, WebVTT.StringDecoder())` → cues → `WebVTT.convertCueToDOMTree(window, cue.text)`. `[VERIFIED — SubtitleTrack.mjs L52–53, SubtitlesManager.mjs L668]` All of `WebVTT.Parser`, `StringDecoder`, `convertCueToDOMTree`, and the extended `VTTCue` live inside vendored `modules/vtt.mjs` (1961 LOC), NOT the browser. `[VERIFIED — vtt.mjs L1413/1427/1490/1722]` Native `VTTCue.getCueAsHTML()` does NOT reproduce the same styled DOM (convertCueToDOMTree applies the `convertSubtitleFormatting` alignment + `<b>/<i>/<u>` handling). **Decision (fixes Phase 1.2): vendor `vtt.mjs` as-is; do NOT reimplement with native APIs** — that would silently drop styling/positioning. Biggest correctness trap in the plan.

- **Reference line numbers re-confirmed:** `SubtitleUtils` statics at L10/51/73/94/113/132/149/200; `loadText` branch L41–47; `cuesToSrt` L132. `[VERIFIED — exact grep]`
- **NoBuf anchors re-confirmed:** `ALL_CHIPS` at `FastStreamPlayer.tsx:1424` (chips: skipBack, skipFwd, loop, pip, speed, download, settings, pin, fullscreen, TRAY). A `captions` chip must be added in THREE places (ALL_CHIPS + `defaultBarLayout` in SettingsContext + `chipButton` registry) per the player-UI skill's 3-place rule. `server.rs` Range at L350/517. `[VERIFIED]`
- **jassub installed = 2.5.1** (matches `^2.5.1`); assets present in `node_modules/jassub/dist/{wasm,worker,default.woff2}`. `[VERIFIED]`

---

## 4. Format support matrix — what NoBuf CAN vs CANNOT do

| Format | Source | Feasible in NoBuf? | Engine |
|---|---|---|---|
| Sidecar `.srt` | file/URL | ✅ v1 | port `srt2webvtt` |
| Sidecar `.vtt` | file/URL | ✅ v1 | vtt parser |
| Sidecar `.ass`/`.ssa` | file/URL | ✅ v1 (styled) | **jassub** |
| OpenSubtitles download | API | ✅ v1 | REST + parser |
| **Embedded MKV** srt/ssa/ass | container | ✅ v2 | `matroska-subtitles` / `@cryguy/...` |
| Embedded MKV fonts (for ASS) | container | ✅ v2 | same lib `file` event → jassub |
| Embedded MP4 `tx3g`/`mov_text` | container | ⚠️ v3 (needs mp4box track extract) | mp4box.js |
| Embedded TS teletext/DVB | container | ❌ out of scope | — |
| **PGS / VobSub (bitmap)** | container | ❌ out of scope (needs OCR/burn-in) | — |

---

## 5. A-to-Z TODO — phased, verification-gated

> Discipline (per project rules): baselines before each phase (`cargo build --no-default-features`, `npx tsc --noEmit`), re-run after, **zero new errors**. UI changes are **surgical** — no restyle/relocate of unnamed components, **no native `<select>`** (use chip groups), theme tokens `--color-nobuf-*` only. Do NOT declare visual work "done" on green types — hand back for hands-on `tauri dev` check.

### PHASE 0 — Decision & scaffolding
- [ ] **0.1** Confirm scope with user: v1 = rendering + sidecar + OpenSubtitles; v2 = embedded MKV; MP4/bitmap deferred. *(needs user sign-off before building)*
- [ ] **0.2** Decide extraction lib for v2: `matroska-subtitles` (stream/pipe, mature) vs `@cryguy/mkv-subtitle-extractor` (Range-by-URL, fits Rust server). **Recommendation: `@cryguy/...`** — it fetches by URL over Range, matching NoBuf's existing `Accept-Ranges` server; avoids piping the whole MKV through JS.
- [ ] **0.3** Capture baselines: `npx tsc --noEmit` and `cargo build --no-default-features` — record clean state.
- [ ] **0.4** Delete or gut the misleading `SubtitleRenderer.ts` stub (its mediabunny premise is false). Replace with the real module structure below.

### PHASE 1 — Core parse/model layer (portable, no UI)
- [ ] **1.1** Port `SubtitleUtils` → `app/src/lib/faststream/subtitles/SubtitleUtils.ts`: `srt2webvtt`, `xml2vtt`, `vttTimeFormat`, `srtTimeFormat`, `cuesToSrt`, `translateXMLEntities`, `convertSubtitleFormatting`. *(pure functions, unit-testable)*
- [ ] **1.2** Port `SubtitleTrack` → `SubtitleTrack.ts`: `loadText`, `loadURL`, `shift`, `shiftAfter`, `equals`, cues[]/regions[]. Use a WebVTT parser (either vendor FastStream's `vtt.mjs` or use browser `VTTCue` + a light parser).
- [ ] **1.3** Add ASS/SSA detection branch that FastStream **lacks** (route real ASS to jassub, not `srt2webvtt`).
- [ ] **1.4** Unit tests: SRT→VTT, XML→VTT, cue sort, `equals` dedup, shift math. **RED→GREEN.**

### PHASE 2 — Rendering + track manager (React, container-agnostic)
- [ ] **2.1** `useSubtitles` hook (React port of `SubtitlesManager` state): `tracks`, `activeTracks`, add/activate/deactivate/remove/toggle/clear.
- [ ] **2.2** Overlay component `<SubtitleOverlay>`: binary-search active cues by `currentTime` (reuse existing player time source — must use the **real MSE presentation time**, honoring NoBuf's VBR/seek-offset handling, not raw container ts), render cue DOM, multi-track stacking, opacity toggling.
- [ ] **2.3** Draggable vertical position + `checkTrackBounds` (keep inside video). Respect fullscreen.
- [ ] **2.4** Wire to player lifecycle: clear tracks on source change; re-render on `timeupdate`/seek.
- [ ] **2.5** jassub integration path for ASS: lazy-load WASM, mount canvas over `<video>`, feed `subContent` + fonts. Bundle the `.wasm` + default font as Tauri assets (verify they load under the Tauri asset protocol — WebView2 gotcha).

### PHASE 3 — Sidecar loading UI (v1 user-facing)
- [ ] **3.1** "Load subtitle file" action (hidden file input `accept=".srt,.vtt,.ass,.ssa"`), parse → add track → activate.
- [ ] **3.2** **Subtitle control-bar chip** (`CC`) added to `ALL_CHIPS` in `FastStreamPlayer.tsx` — draggable like existing chips; opens a track menu. Menu = chip/toggle group (NEVER `<select>`).
- [ ] **3.3** Track menu: list tracks, active toggles, "off", "load file", per-track language/label.
- [ ] **3.4** Keyboard: `C` toggle (match FastStream), `G`/`H` shift ±0.2s (optional).

### PHASE 4 — Styling settings (persisted)
- [ ] **4.1** Extend `Settings` interface + `defaultSettings` in `SettingsContext` with a `subtitleStyle` object: `fontFamily, fontWeight, fontSize, color, background, outlineColor, outlineWidth, bottomMargin, defaultLanguage`. Persist via existing Tauri store.
- [ ] **4.2** Settings panel section (chip/segmented controls + color pickers; no native select). Live "test subtitle" preview like FastStream.
- [ ] **4.3** Apply styles to overlay incl. the perimeter-`text-shadow` outline algorithm (port `applyOutline`).

### PHASE 5 — Sync tools
- [ ] **5.1** Global shift control (buttons + keybind) → `SubtitleTrack.shift`.
- [ ] **5.2** (Optional) shift-from-cue-onward + timeline editor — defer unless requested; it's the heaviest UI in FastStream (276 LOC syncer).
- [ ] **5.3** Cues→SRT export ("save subtitles").

### PHASE 6 — OpenSubtitles search (v1 stretch / v2)
- [ ] **6.1** Port `OpenSubtitlesSearch` search+download against `api.opensubtitles.com/api/v1`. **Get NoBuf's own API key** (do not reuse FastStream's embedded key — it's rate-limited/attributable to them). *(needs user: register app for key)*
- [ ] **6.2** Search UI (query, type movie/episode, season/ep, language, sort). Handle the **5/day download quota** + quota-reset messaging.
- [ ] **6.3** Wire `mediaInfoSet` equivalent (filename/hash) to prefill search from the Telegram file name.

### PHASE 7 — Embedded MKV extraction (v2, the hard part)
- [ ] **7.1** Add chosen lib (`@cryguy/mkv-subtitle-extractor` recommended). Confirm it runs in WebView2 (test bundling + Range fetch against the local Rust `/stream/` URL).
- [ ] **7.2** On MKV load, enumerate embedded subtitle tracks (mediabunny `getTracks()` gives you *that they exist* + language/name; the extractor gives you the *cues*). Cross-check indices between the two.
- [ ] **7.3** Extract cues lazily/streamed; feed into `SubtitleTrack` (`.ass` header → jassub; srt/ssa → parser). Extract embedded fonts (`file` event) → jassub font list.
- [ ] **7.4** Surface embedded tracks in the same `CC` menu, labeled with language + "embedded".
- [ ] **7.5** Handle seek: re-extract or use `SubtitleStream` random-access so subs don't desync after a seek in a partially-downloaded MKV. **This is the riskiest bit** — coordinate with NoBuf's prebuffer/seek engine; keep diagnostic logging until user confirms.

### PHASE 8 — Verification & polish
- [ ] **8.1** Test matrix: sidecar srt/vtt/ass; embedded-MKV srt/ass; multi-track; dual active; styling persistence; shift; seek-after-load; fullscreen; OpenSubtitles download+quota.
- [ ] **8.2** `npx tsc --noEmit` + `cargo build --no-default-features` clean; unit tests green.
- [ ] **8.3** Hand to user for hands-on `tauri dev` visual pass (don't self-certify visual work).
- [ ] **8.4** Clean up any temp test logs; do not commit them.

---

## 6. Explicit non-goals for v1 (verified constraints, not laziness)
- **PGS / VobSub bitmap subs** — need OCR or burn-in; no pure-JS text path exists. `[VERIFIED]`
- **Embedded TS teletext/DVB** — niche, heavy.
- **Embedded MP4 `tx3g`** — deferred to v3 (mp4box.js can parse the `tx3g` sample entry — `mp4box.mjs` L3947 defines it — but wiring MP4 text-track sample extraction is separate work). `[VERIFIED — box parser exists; extraction-to-cues not wired]`
- **FastStream's interactive timeline cue-editor** — high effort, low demand; port only if user asks.

## 7. Key risks / watch-items
- **jassub in WebView2/Tauri**: WASM + font asset loading under the asset protocol is a known class of gotcha — verify early (Phase 2.5), don't leave to the end.
- **Seek desync for embedded MKV** on partially-buffered files — must integrate with existing seek/prebuffer engine; instrument before declaring correct.
- **OpenSubtitles key + quota** — get NoBuf's own key; surface quota UX.
- **Do not trust the old stub's mediabunny assumption** — it's factually wrong; extraction needs a dedicated lib/Rust.
