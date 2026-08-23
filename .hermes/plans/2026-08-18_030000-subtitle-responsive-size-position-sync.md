# Subtitle Responsive Sizing, Positioning, Sync & Online Search — Implementation Plan

> **For Hermes:** implement task-by-task, in order. Phase 1 (§1-§6) first, then Phase 2. Every task ends with a verification command and an expected result.

**Goal:**
- **Phase 1** — make subtitles scale with the letterboxed video picture, never overlap the control bar / settings panel / download overlay, and add three controls to the captions (CC) menu: **size**, **vertical position**, **sync delay**.
- **Phase 2** — add **OpenSubtitles.com** search & download (moviehash + filename fallback) so a file with no usable text track stops being a dead end.

**Architecture:** Phase 1 extracts all geometry into a NEW pure module (`app/src/lib/faststream/subtitles/subtitleLayout.ts`), unit-tested with injected numbers (jsdom returns `0` for all geometry — proven), measures box/controls with exactly **two** ResizeObservers, and passes a memoized `layout` object into `SubtitleOverlay` as props. Sync delay is applied **non-destructively at cue-read time** (`activeCues(cues, t - delay)`), never via the destructive `SubtitleTrack.shift()`. Phase 2 adds Rust-side `ureq` commands (CSP forbids a frontend `fetch`) and feeds results into the sidecar track path that already exists.

**Tech stack:** React 19, TypeScript, Tailwind v4, Tauri 2 / WebView2, vitest 4.1.6 (+ jsdom opt-in per file), `@tauri-apps/plugin-store` for persistence, Rust `ureq` for outbound HTTP.

**Baseline to preserve (measured 2026-08-18):** `npx vitest run` → **76 files / 831 tests pass**; `npx tsc --noEmit` → **0 errors**. Subtitle-scoped subset: 23 files / 236 tests.

---

## 0. Decisions — LOCKED (from the user interview; do not re-litigate)

| # | Decision | Value |
|---|---|---|
| D1 | Size scales with | the **letterboxed video PICTURE height**, not the window |
| D2 | Base size at 100% | **5.0% of picture height** (Chromium `::cue` norm) |
| D3 | Size slider | **50–300%**, step **5%**, default **100%** |
| D4 | Px clamps | **min 20px, max 96px**, applied **after** the multiplier |
| D5 | Default bottom margin | **5.0% of picture height** (SMPTE title-safe) |
| D6 | Position slider | **0–40% of picture height**, step **1%**, **upward only** |
| D7 | Position floor | subtitles may **never** go below the control bar's real content |
| D8 | When controls auto-hide | subtitles **stay put** (bar height stays reserved) — no jumping |
| D9 | Sync slider | **±10s, step 0.05s**; nudge buttons **±0.1s**; reset button |
| D10 | Sync persistence | **per video file** (localStorage LRU, mirroring `persistSubTrack`) |
| D11 | Size/position persistence | **global**, in `settings.json` via `SettingsContext` |
| D12 | Sliders live | **CC popup menu only** (not the settings side panel) |
| D13 | Sliders visible | only when **≥1 subtitle track exists** (no dead UI) |
| D14 | Slider extras | **% readout + double-click-to-reset** on each |
| D15 | Avoid also | **settings panel** (horizontal inset), **download overlay** (lift) |
| D16 | Line width cap | **68% of picture width** (BBC online 16:9), 90% for non-16:9 |
| D17 | jassub/ASS canvas path | **OUT OF SCOPE** — Tauri never uses it; browser build stays as-is |
| D18 | Also fix | ASS `{\an8}` top positioning **and** rotation-aware overlay |
| D19 | Rotation behavior | subs **rotate with the video**, glued to the picture's bottom edge |
| D20 | Rotation vs bar conflict | **rotation wins** at 90/270 (overlap accepted) |
| D21 | `{\an8}` + position slider | top signs get the **mirrored** offset from the top edge |
| D22 | No new keybinds | unless explicitly requested later |

---

## 1. Verified facts this plan is built on

Every item below was confirmed by reading code / spec / executing a probe. **Do not re-derive; do not contradict.**

### 1.1 The four defects being fixed

| # | Defect | Evidence |
|---|---|---|
| F1 | `pb-[6%]` percentage padding resolves against the containing block's **WIDTH** (CSS 2.1 §8.4), so the bottom gap tracks horizontal size: **72px** @1200w, **115.2px** @1920w, **21.6px** @360w. Vertical resize does nothing. | `SubtitleOverlay.tsx:319`; `padding-bottom:6%` present in built CSS |
| F2 | `clamp(16px, 3vw, 34px)` fluid band is only **533.33 → 1133.33px** viewport width. Default window is 1200px ⇒ **pinned at exactly 34px** on every real desktop, identical windowed vs fullscreen vs 4K. | `SubtitleOverlay.tsx:330, 346`; arithmetic executed |
| F3 | Overlay is `inset-0` = the **videobox**, not the picture. Under `object-fit:contain` subtitles float in the letterbox black bar. | `SubtitleOverlay.tsx:319`, `FastStreamPlayer.tsx:2805` |
| F4 | Settings panel is `z-30` over the overlay's `z-20` **and is `position:absolute` on the OUTER box**, so it does not shrink videobox ⇒ no vertical fix can help; subtitles hide **under** the panel. | `FastStreamPlayer.tsx:3189-3192` |

### 1.2 Structural facts

- Outer box: `fixed inset-0 z-50 bg-black flex flex-col select-none` (`:2785-2787`). Fullscreen target (`:1720`).
- videobox: `flex-1 flex items-center justify-center min-h-0 relative cursor-pointer` (`:2805`) — **NO `overflow-hidden`** (verified).
- `<video className="w-full h-full">` (`:2822-2831`) ⇒ its content box **≡ videobox content box**. `objectFit` from `settings.playerVideoFit`; `transform: rotate(Ndeg)` when `rotation` set.
- Controls: `absolute bottom-0 … pt-16 pb-2 px-3` (`:2924-2927`) — a child of the **OUTER box**, sibling of videobox. `pt-16` = **64px**, `pb-2` = **8px** (Tailwind v4 `--spacing:.25rem`, no root font-size override).
- **★ CORRECTION TO EARLIER ASSUMPTION:** `controlsHeight` (`:1637-1640`) uses `entry.contentRect.height`, which per Resize Observer §2.3 + processing steps ("Set this.contentRect to logical this.contentBoxSize … observedBox of `content-box`"; "Set this.contentRect.top to target.padding top") is the **CONTENT BOX** — it **EXCLUDES** `pt-16` AND `pb-2`. So `controlsHeight ≈ offsetHeight − 64 − 8`. **Subtracting 64 again would float subtitles 64px too high.** Verified against the spec text.
- `VideoFit = 'original' | 'contain' | 'fill'` (`SettingsContext.tsx:10`), default `'contain'` (`:82`). **`'cover'` does not exist — write only three branches.** `'original'` maps to CSS `object-fit:none`.
- `videoResolution` `{w,h}` set in `onMeta` (`:1167`); **null before metadata**, and `setVideoResolution` **allocates a new object every call** ⇒ memo deps must use `videoResolution?.w` / `?.h` primitives, never the object.
- jassub canvas is a **SIBLING** of `<video>` via `insertAdjacentElement('afterend')` (`node_modules/jassub/dist/jassub.js:49`), `position:absolute` (`:47`), `pointerEvents:none` (`:48`), `zIndex='20'` forced by `SubtitleOverlay.tsx:223`. Its `_getElementBoundingBox` (`jassub.js:126-139`) implements **`contain` only**, no rotation compensation. ⇒ **CSS on our overlay cannot affect ASS canvas output.** Moot in Tauri (`shouldUseJassub()` = `!isTauri()`, `SubtitleOverlay.tsx:159-161`) — hence D17.
- Download overlay: `bottom: dlOverlayVisible ? (vis && controlsHeight > 0 ? controlsHeight + 12 : 64) : 64` (`:3380-3382`). **Do NOT change `controlsHeight`'s existing semantics** or this shifts by 72px — add a NEW separate state field instead.

### 1.3 Test-surface facts (measured)

- jsdom 29.1.1 probe **executed**: `getBoundingClientRect()` → `{w:0,h:0}`; `offsetHeight`/`clientWidth` → `0`; `video.videoWidth/videoHeight` → `0`; `ResizeObserver` → **`undefined`**. ⇒ **all geometry must be pure-function tested with injected numbers.**
- Same probe: `style.fontSize = 'clamp(16px, 3vw, 34px)'` → **`""`** (CSSOM rejects it) but `style.fontSize = '54px'` → `"54px"`. ⇒ **the px refactor is strictly MORE testable than today's code.**
- Same probe: `style.fontSize='NaNpx'` → `""` and `style.bottom='NaNpx'` → `""`, **silently**. Plus `activeCues(cues, NaN) === []`. ⇒ **an `undefined`/NaN delay prop renders ZERO subtitles with no error.** Every new prop must be optional + `Number.isFinite`-guarded.
- `SubtitleOverlayRevision.test.tsx` has **8 tests** (verified: 8 passed), and **only its 5 rendering tests, out of all 831, would notice if the overlay painted nothing.** All other subtitle tests are vacuous w.r.t. rendering.
- **★ TEST FENCE:** `EarlySubtitleSelection.test.ts:46-47` slices `FastStreamPlayer.tsx` source between `'{sidecarTracks.map((t) => ('` and `'{(msePlayer.embeddedSubTracks.length'` — i.e. **L2544–2549, inside the CC menu**. Its assertions are only `toContain('onClick={() => toggleLoadedSubTrack(t)}')` and `not.toContain('onClick={() => subs.toggleTrack(t)}')`. Plus a **file-global** `expect(source).not.toContain('{subs.tracks.map(')` at `:60`. ⇒ **Place new slider JSX AFTER the Embedded section, adjacent to the "Load subtitle file…" divider (~`:2590`), outside that window.** No test edits needed.
- `{\an8}` is already in the fixture at `SubtitleOverlayRevision.test.tsx:93`, and `:108` asserts `toHaveLength(1)` ⇒ the D18 `{\an8}` work must keep **exactly one** `[data-ass-subtitle]` node per line.
- `SettingsContext.tsx` has **zero** existing test coverage; `@tauri-apps/plugin-store` is unmocked repo-wide.
- Line endings: sources are **CRLF**, but `EarlySubtitleSelection.test.ts` is **LF-only**. Programmatic revert/restore MUST use `newline=""` on both read and write.
- Suite timing: ~5.4s warm, ~33s cold. Same tally.

### 1.4 Industry parameters (all verified by execution against primary sources)

| Fact | Source |
|---|---|
| Chromium `::cue` font = `min(video_h, video_w) × 0.05` off the video **content box**, with an in-source FIXME calling the picture/element mismatch "inconsistent" | `text_track_container.cc:124-130` |
| mpv `--sub-pos=<0-150>`, "% of the screen height", 100 = default, >100 moves down (and "may be cut off — libass restriction") | mpv manual L3948-3953 |
| mpv `--sub-font-size` default **38** @ 720 reference = 5.28% | L4440-4445 |
| mpv `--sub-margin-y` default **34** = 4.7% | L4539-4544 |
| mpv default scales with **WINDOW**; video-relative is opt-in (`--sub-scale-with-window=no`) | L3918-3937 |
| **mpv `--sub-margin-y-offset`: "Additional vertical offset … intended for dynamic margin adjustments at runtime (e.g. by scripts like the OSC to avoid subtitle/UI overlap). For persistent settings, use `--sub-margin-y`."** ⇒ upstream keeps persistent margin and dynamic UI-avoidance as **two additive terms**. **We mirror this.** | L4546-4552 |
| mpv keybind steps: `sub-delay ±0.1`, `sub-pos ±1` | `etc/input.conf:107-108, 136-137` |
| VLC hotkey subtitle-delay step = **50ms** (`int delta = 50`) | `hotkeys.c:393, 402-403` |
| VLC `sub-text-scale` default 100, range **10–500** | `libvlc-module.c:1816` |
| BBC online max subtitle width = **68% of a landscape 16:9 video**; max 2 lines (3 absolute ceiling) | BBC Subtitle Guidelines §3.3, §19.6 |
| Netflix **42 CPL**, max **2 lines** | Netflix English TTSG §I.2, §I.14 |
| FCC §79.103(c)(4) mandates a **50–200%** size range (we deliberately exceed to 300% per D3) | eCFR |
| WCAG large-text threshold 18.66px ⇒ our 20px floor is above it | WCAG 2.2 SC 1.4.3 |
| SMPTE title-safe = 90% of frame ⇒ **5% margin per edge** | Netflix Title Safe / SMPTE RP 218 |

---

## 2. Files to change

| Action | Path |
|---|---|
| **Create** | `app/src/lib/faststream/subtitles/subtitleLayout.ts` — all pure geometry |
| **Create** | `app/src/__tests__/SubtitleLayout.test.ts` — pure unit tests (node env, no jsdom) |
| **Create** | `app/src/__tests__/SubtitleSyncStore.test.ts` — per-file delay LRU (jsdom for localStorage) |
| Modify | `app/src/components/dashboard/SubtitleOverlay.tsx` — consume `layout` props; delay at read time; `{\an8}`; rotation wrapper |
| Modify | `app/src/components/dashboard/FastStreamPlayer.tsx` — videobox ref + 2nd observer, `layout` memo, 3 sliders (placed ~`:2590`), delay state |
| Modify | `app/src/context/SettingsContext.tsx` — 2 new keys (+ types, + defaults) |
| Modify | `app/src/hooks/useMSEPlayer.ts` — add `readPersistedSubDelay`/`persistSubDelay` beside the existing sub-track LRU (`:692-717`) |
| Modify | `app/src/__tests__/SubtitleOverlayRevision.test.tsx` — extend, do not weaken |

**Do NOT touch:** `useSubtitles.ts` (single-active-track is intentional), `SubtitleTrack.shift()` (leave the destructive method alone — just don't call it), the existing `controlsHeight` state's semantics, `EarlySubtitleSelection.test.ts`.

---

## 3. The pure geometry module — exact contract

`app/src/lib/faststream/subtitles/subtitleLayout.ts`

```ts
export type SubFit = 'contain' | 'fill' | 'none';   // 'original' → 'none' at the call site
export interface Rect { x: number; y: number; w: number; h: number }

export const SUB_FONT_RATIO      = 0.05;   // D2 — Chromium ::cue norm
export const SUB_FONT_MIN_PX     = 20;     // D4 — above WCAG 18.66px large-text floor
export const SUB_FONT_MAX_PX     = 96;     // D4 — 2×42ch must still fit 90% of 1080p width
export const SUB_BOTTOM_RATIO    = 0.05;   // D5 — SMPTE title-safe
export const SUB_SCALE_MIN       = 0.5;    // D3
export const SUB_SCALE_MAX       = 3.0;    // D3
export const SUB_OFFSET_MAX_PCT  = 40;     // D6
export const SUB_DELAY_MAX_S     = 10;     // D9
export const SUB_LINE_WIDTH_16_9 = 0.68;   // D16 — BBC online
export const SUB_LINE_WIDTH_OTHER= 0.90;   // D16
export const SUB_SAFE_PX         = 2;      // absorbs 125%/150% DPI rect rounding
export const SUB_MAX_LINES       = 3;      // BBC absolute ceiling

/** Geometric picture rect in videobox-local coords. Assumes object-position 50% 50%.
 *  MAY return negative x/y and w/h > box (object-fit:none oversized) — that is the
 *  true unclipped rect; callers MUST intersect via visiblePictureRect.
 *  ★ MUST sanitize boxW/boxH FIRST: `pictureRect(NaN, NaN, 1920, 1080, 'contain')`
 *  returns all-NaN unless guarded — the `!videoW || !videoH` check does NOT catch a
 *  NaN BOX (verified by probe). Coerce non-finite/negative box dims to 0 on entry. */
export function pictureRect(boxW, boxH, videoW: number|null, videoH: number|null, fit: SubFit): Rect;

/** Intersection of a picture rect with the box — what is actually on screen. */
export function visiblePictureRect(p: Rect, boxW: number, boxH: number): Rect;

/** Axis-aligned rect after rotating p by a multiple of 90° about the BOX CENTRE.
 *  Under object-position 50% 50% the picture centre is rotation-invariant, so
 *  θ∈{90,270} simply SWAPS w/h. */
export function rotatedPictureRect(p: Rect, boxW: number, boxH: number, rot: 0|90|180|270): Rect;

export interface SubLayoutInput {
  boxW: number; boxH: number;
  videoW: number | null; videoH: number | null;
  fit: SubFit;
  rotation: 0|90|180|270;
  controlsContentH: number;   // REAL interactive height (see §1.2 correction)
  dlOverlayH: number;         // 0 when hidden
  panelReserveRight: number;  // 0 when settings panel closed
  fontScale: number;          // 0.5 … 3.0
  offsetPct: number;          // 0 … 40  (% of picture height, upward from the floor)
}
export interface SubLayout {
  fontPx: number;
  bottomPx: number;      // overlay `bottom` (px) — immune to the §F1 width trap
  topPx: number;         // mirrored offset for {\an8} top-anchored cues (D21)
  rightPx: number;       // panel inset (D15/F4)
  maxWidthPx: number;    // D16
  wrapper: Rect;         // unrotated visible picture rect for the rotation wrapper
  rotation: 0|90|180|270;
}
/** Single entry point. MUST be total: every non-finite / zero / negative input
 *  yields a finite, safe result (never NaN — see §1.3). */
export function subtitleLayout(input: SubLayoutInput): SubLayout;
```

**Formula core (mirrors mpv's two additive terms — §1.4):**

```
pv            = visiblePictureRect(pictureRect(...), boxW, boxH)
fontPx        = clamp(MIN_PX, SUB_FONT_RATIO * pv.h * fontScale, MAX_PX)
chromeReserve = controlsContentH + dlOverlayH + SUB_SAFE_PX      ← DYNAMIC term
userMargin    = SUB_BOTTOM_RATIO * pv.h + (offsetPct/100) * pv.h ← PERSISTENT term
preferred     = (boxH - (pv.y + pv.h)) + userMargin              ← from picture bottom
bottomPx      = min( max(preferred, chromeReserve),
                     max(boxH - pv.y - blockH, chromeReserve) )  ← note the inner max
```

**★ The inner `max(..., chromeReserve)` is mandatory — VERIFIED BY BRUTE FORCE, and narrower than first assumed.** A naive `clamp(preferred, min, max)` where `min > max` returns the **smaller** bound, sliding subtitles back under the control bar. Brute-forcing 25k input combinations (box 360-3840 × 500-2160, five aspect ratios, `controlsContentH` 80-300, dlOverlay 0/40, scale 0.5-3, 1-3 lines) found **435 inverting cases**, all sharing:

- `chromeReserve ≥ 242px` — i.e. `controlsContentH ≥ 200px`, which only happens when the chip row **wraps** on a narrow window (edge case E3/6.3)
- `boxH ≤ 600px`

and **zero** inverting cases with a normal unwrapped bar (`controlsContentH ≤ 120`). So the guard protects a real but narrow corner: *short window + wrapped control bar*. It costs one `Math.max`; keep it. The unit test must use an inverting input from that band (e.g. `boxW 360, boxH 500, video 1920×1080, controlsContentH 250, dlOverlayH 40, scale 3, 3 lines` → `upper 234 < chrome 292`), **not** a plausible-looking case that silently doesn't invert.

---

## 4. Edge cases — every one must be handled and tested

| # | Case | Required behavior |
|---|---|---|
| E1 | `videoResolution === null` (pre-metadata), and it **re-fires** mid-playback (MSE recreation on seek, adaptive switches) | `pictureRect` early-returns the full box ⇒ visually identical to today. Layout is **reactive**, not one-shot. |
| E2 | `videoW === 0 && videoH === 0` (audio-only / 0×0 track) | Same early return. **Never** `boxW/0` → `Infinity` → `NaN`. |
| E3 | Box resize: window / fullscreen change both dims; **settings panel changes NEITHER** | Panel handled by `rightPx` from `settingsOpen` + width state — **not** by ResizeObserver. |
| E4 | ResizeObserver feedback loop | Observe **only** videobox + controls (neither depends on subtitle content). Measure block height in `useLayoutEffect` keyed on cue identity, **never** in an observer. |
| E5 | Fractional `getBoundingClientRect` at 125%/150% Windows scaling vs integer `offsetHeight` | Use the **rect/contentRect family everywhere**; never mix in `offsetHeight`. `SUB_SAFE_PX = 2` absorbs drift. |
| E6 | `err` truthy ⇒ **no `<video>` element at all**, and it can flip mid-playback | Observe **videobox** (always exists), never `vidRef.current`. |
| E7 | Tall/narrow window (min 360×500): box 800×1400 + 1920×1080 contain ⇒ picture 800×450 at y=475 | Subs land at `bottom ≈ 497px` **on the picture**, not 427px below it in the black bar. |
| E8 | `object-fit:none` 4K-in-small-window: `p = {x:−960,y:−580,w:3840,h:2160}` | Naive `p.y+p.h` ⇒ `bottom:−580` ⇒ **subtitles off-screen**. `visiblePictureRect` fixes. Symmetric small-video case (640×360 in 1920×1000) ⇒ font from the **360px** picture (~18px), not the 1000px box (~50px). |
| E9 | Clamp inversion: `upper bound < chromeReserve` ⇒ naive `clamp` returns the smaller bound and puts subs **back under the bar** | Inner `max(..., chromeReserve)` — see §3. **VERIFIED BY BRUTE FORCE (435/25k cases):** requires `controlsContentH ≥ 200px` (wrapped chip row) **and** `boxH ≤ 600px`. Never fires with a normal bar (`≤120px`) — the plan's original "1920×300 box, 4:3 video" example was **wrong** (it does not invert: `upper 276 > chrome 92`). Test with `360×500 box, 1920×1080 video, ctrlH 250, dl 40, scale 3, 3 lines` → `upper 234 < chrome 292`. |
| E10 | Many stacked lines overflow the picture top (`flex-col justify-end` overflows the **start** edge; content is lost, unscrollable) | Cap at `SUB_MAX_LINES = 3`, keeping the **last** (most recent). Measure **rendered block height**, not cue count (`max-w` wrapping makes count meaningless). |
| E11 | Zero-size box for one frame during mount (`flex-1 min-h-0`) | Guard `if (!(boxW>0) || !(boxH>0)) return;` **without committing to state** ⇒ last good geometry persists; never cache a 0 that yields `fontSize:0`. |
| E12 | Re-render storms: `time` ~4/s, `vis` on mousemove, `panelDragWidth` per mousemove | **No `getBoundingClientRect`/`getComputedStyle` in the render path.** All geometry in `useMemo`; `getComputedStyle` read once **inside** the observer callback (already post-layout there). |
| E13 | Non-finite props (`NaN`/`undefined`/`Infinity` delay or scale) **and non-finite BOX dims** | `Number.isFinite` guards + defaults. Proven silent-blank risk (§1.3). **★ Probe-verified gap: the `!videoW \|\| !videoH` early return does NOT catch a NaN `boxW`/`boxH`** — `pictureRect(NaN, NaN, 1920, 1080, 'contain')` returns all-NaN. Sanitize box dims on entry (`Number.isFinite(x) && x > 0 ? x : 0`), and assert this exact input in the totality test. |
| E14 | Rotation 90/270: rotated picture is **taller than the box** and clipped ⇒ its geometric bottom is off-screen | Position against `visiblePictureRect(rotatedPictureRect(...))`. Verified example: box 1920×1000 + 1920×1080 contain rot=90 ⇒ geometric bottom at y=1388.89, i.e. **388.89px below the box**. |
| E15 | Rotated wrapper bleeds outside videobox (no `overflow-hidden`) over the filename row (`:3375`) and controls | Add `overflow:hidden` to the **overlay root** (unrotated frame), never the wrapper. |
| E16 | Author-positioned cues (`{\an8}`, WebVTT `line:0`) | Use `topPx` (mirrored). **Never** force-clamp them into the bottom band — that covers the very thing the author moved text to avoid. Bottom clamp applies to **bottom-anchored cues only**. |
| E17 | Sync delay + seek | Delay is read-time only ⇒ survives seeks, re-extraction, and coverage repair with zero interaction. Assert this explicitly. |
| E18 | Delay persisted per file, LRU-capped | Mirror `persistSubTrack` (cap 200, `delete`-then-reinsert for recency). Corrupt/absent JSON ⇒ `0`, never throw. |
| E19 | Epsilon-gated state commit | Return `prev` (identical reference) when all deltas < 0.5px so React bails out of the re-render. |
| E20 | `videoResolution` object identity | Memo deps use `videoResolution?.w`/`?.h` primitives — the object is reallocated every `onMeta`. |

---

## 5. Task list

### Task 1 — pure module skeleton + failing tests (RED)
1. Create `subtitleLayout.ts` with the §3 signatures and constants; bodies `throw new Error('not implemented')`.
2. Create `SubtitleLayout.test.ts` (**node env — no jsdom docblock**) covering: the 7 verified `pictureRect` rows in §1/§4 (contain pillarbox, fill, none oversized, none 4K, tall-narrow, exact-aspect s=1.0, none small-centred), `visiblePictureRect` clipping, `rotatedPictureRect` w/h swap, the E9 inversion, E1/E2/E11/E13 totality (feed `null`, `0`, `NaN`, `Infinity`, negatives — assert **every** output `Number.isFinite`), and the clamps at both ends.
3. Verify: `npx vitest run src/__tests__/SubtitleLayout.test.ts` → **FAIL, "not implemented"**.

### Task 2 — implement the module (GREEN)
1. Implement per §3.
2. Verify: same command → **all pass**. Then `npx tsc --noEmit` → **0 errors**.

### Task 3 — settings keys
1. `SettingsContext.tsx`: add `playerSubtitleFontScale: number` (default `1`) and `playerSubtitleOffsetPct: number` (default `0`) to `Settings` + `defaultSettings`.
2. Sanitize on load (clamp into range) so a corrupt persisted value can't produce NaN.
3. Verify: `npx tsc --noEmit` → 0 errors; `npx vitest run` → **831 pass** (unchanged).

### Task 4 — per-file sync delay store
1. `useMSEPlayer.ts`, beside `:692-717`: `SUB_DELAY_STORE_KEY`, `readPersistedSubDelay(fileKey): number`, `persistSubDelay(fileKey, seconds)`. Same LRU cap-200 + `delete`-then-reinsert pattern. Clamp to ±`SUB_DELAY_MAX_S`; non-finite ⇒ `0`.
2. `SubtitleSyncStore.test.ts` (**jsdom** for localStorage): round-trip, clamping, non-finite ⇒ 0, corrupt JSON ⇒ 0, LRU eviction at 200, recency refresh.
3. Verify: `npx vitest run src/__tests__/SubtitleSyncStore.test.ts` → pass.

### Task 5 — measurement in the player
1. Add `videoBoxRef` to the videobox div (`:2805`).
2. ResizeObserver on `videoBoxRef` → `boxW/boxH`; **new separate** observer/state for the controls' **real content height** (`borderBoxSize.blockSize − paddingTop`, read `getComputedStyle` **inside** the callback). **Leave the existing `controlsHeight` untouched** (download overlay depends on it — §1.2).
3. One `geom` object, one `setGeom`, epsilon-gated per E19.
4. Verify: `npx tsc --noEmit` → 0; `npx vitest run` → 831 pass.

### Task 6 — the `layout` memo
1. `useMemo` calling `subtitleLayout(...)`, deps exactly per E20/E12 (primitives only).
2. Compute `panelReserveRight` from `settingsOpen` + `panelDragWidth ?? settings.playerSettingsWidth`, capped at `0.70 × outerBoxWidth` (the panel's `maxWidth:'70%'` resolves against the **outer** box).
3. Pass `layout` into `<SubtitleOverlay layout={layout} delaySec={subDelay} />`.
4. Verify: `tsc` 0; full suite 831.

### Task 7 — overlay consumes layout (the visible change)
1. Replace the wrapper's `pb-[6%]` + `clamp()` with `style={{ bottom: layout.bottomPx, right: layout.rightPx, overflow:'hidden' }}` and per-cue `fontSize: layout.fontPx`, `maxWidth: layout.maxWidthPx`.
2. Add the rotation wrapper (`position:absolute` on `layout.wrapper`, `transform: rotate(Ndeg)`, `transformOrigin:'50% 50%'`) — **never transform the overlay root**, its `inset-0` defines the coordinate space.
3. All new props **optional** with `Number.isFinite` fallbacks (E13) so the 5 legacy render tests stay green.
4. Verify: `npx vitest run src/__tests__/SubtitleOverlayRevision.test.tsx` → **8 pass**; full suite **831**; `tsc` 0.

### Task 8 — sync delay at read time
1. `activeCues(track.cues, currentTime - delay)` and `activeAssDialogueText(dialogues, currentTime - delay)`.
2. **★ Both call sites.** `SubtitleTrack.ts:57`'s comment claims ASS shifts via jassub `timeOffset` — grep proves **no `timeOffset` usage exists**, and Tauri routes ASS through the DOM path. Missing the ASS branch ships "sync works on SRT, silently does nothing on ASS". Fix the stale comment too.
3. Add tests: delay shifts which cue is active, in **both** VTT and ASS paths; `NaN`/`undefined` delay ⇒ behaves as `0` (**not** blank).
4. Verify: subtitle-scoped 23 files/236 tests; then full 831.

### Task 9 — the three sliders
1. Insert **after** the Embedded section, by the "Load subtitle file…" divider (~`:2590`) — **outside** the `EarlySubtitleSelection` grep window (§1.3).
2. Size: `range` 0.5–3.0 step 0.05, `%` readout, dbl-click → 1.0. Position: 0–40 step 1, `%` readout, dbl-click → 0. Sync: −10…+10 step 0.05, `±0.1s` nudge buttons + reset, `s` readout.
3. Render the whole block only when `subs.tracks.length > 0 || msePlayer.embeddedSubTracks.length > 0` (D13). `e.stopPropagation()` on the menu (existing pattern). **No native `<select>`.** Theme via `--color-nobuf-*` / `accent-nobuf-primary`.
4. Verify: `npx vitest run src/__tests__/EarlySubtitleSelection.test.ts` → **pass** (proves the fence held); full 831; `tsc` 0.

### Task 10 — `{\an8}` top positioning (D18/D21/E16)
1. Detect `{\an7,8,9}` in `parseAssDialogues`/`assTextToPlainText`; tag the dialogue as top-anchored.
2. Render top-anchored cues in a separate top-aligned group using `layout.topPx`; keep **exactly one** `[data-ass-subtitle]` node per line (`SubtitleOverlayRevision.test.tsx:108` asserts `toHaveLength(1)`).
3. Verify: 8 pass in that file; full 831.

### Task 11 — mutation testing (MANDATORY)
Per-invariant, driven from `execute_code` (read-once / mutate / run / restore / assert byte-identical). **Use `newline=""` on read and write** — sources are CRLF but `EarlySubtitleSelection.test.ts` is LF-only (§1.3).

| Mutation | Expected distinct failure |
|---|---|
| `SUB_FONT_RATIO` 0.05 → 0.03 | font-size assertions fail; count ≠ others |
| Drop the `visiblePictureRect` intersection | E8 off-screen + E14 rotation rows fail |
| Drop the inner `max(..., chromeReserve)` | only the E9 inversion test fails |
| Remove the `Number.isFinite` guard | E13 totality tests fail |
| Revert the ASS delay call site only | ASS sync test fails, VTT one passes |
| Remove the w/h swap in `rotatedPictureRect` | only rotation tests fail |
| Restore `pb-[6%]` on the wrapper | overlay style test fails |

Each must produce a **distinct** failure count — identical counts mean an invariant is unpinned. Restore and confirm `git diff --stat` is empty.

### Task 12 — full gate + handoff
1. `npx tsc --noEmit` → 0 errors.
2. `npx vitest run` → **≥831 pass** (baseline preserved + new tests).
3. `cd src-tauri && cargo test --no-default-features` → unchanged (no Rust touched; run to prove it).
4. `git diff` reviewed line by line.
5. **Hand to the user for the live `tauri dev` visual gate** — per the standing rule, visual work is not "done" on green types alone. Ask them to check: resize horizontally *and* vertically, fullscreen, `contain`/`Fill`/`Original`, open the settings panel, run a download, rotate 90/180/270, both sliders at their extremes, and sync on a desync'd file.

---

## 6. Risks & tradeoffs

| Risk | Mitigation |
|---|---|
| 300% size on a short letterboxed picture overflows the top | `SUB_MAX_LINES=3` + `maxWidthPx` wrap + the E10 block-height measurement. Must be exercised at 300% during the visual gate. |
| Browser build (jassub/ASS canvas) stays unstyled | D17 — accepted. Tauri never takes that path (`shouldUseJassub()` = `!isTauri()`). Scope any release note to "DOM path". |
| Rotation at 270° hides subs behind the settings panel (z-30 > z-20) | Same accepted class as D20's bar overlap. Flagged, not fixed. |
| `SettingsContext` has no test coverage and the Tauri store is unmocked | Sanitize-on-load so a corrupt value degrades to the default; don't attempt to mock the store in this change. |
| A future `object-fit:cover` would need a 4th branch | Documented in the module header. `VideoFit` has no `cover` today. |

---

# PHASE 2 — OpenSubtitles.com search & download

> Sequenced AFTER Phase 1 (§5 Tasks 1-12). Same file (`FastStreamPlayer.tsx` CC menu) — running both at once creates a needless merge conflict. Phase 1 improves subtitles we already show; Phase 2 adds a new source.

**Goal:** let the user find and load an external subtitle track from OpenSubtitles.com when the file has no usable text track — the current dead end for bitmap-only (PGS/VobSub) tracks.

**Why this matters (verified):** a bitmap track is greyed out with *"Image-based subtitles — not supported"* (`FastStreamPlayer.tsx:2568`) and the user has **zero** remaining options. Embedded subs interleave across the whole MKV, so there is no cheap subtitle-only fetch — an external sidecar is the only KB/sec path that exists.

**Why it's cheap:** this is a new **source**, not a new renderer. Sidecar loading already works end-to-end (`FastStreamPlayer.tsx:1724-1737`, accepting `.srt,.vtt,.ass,.ssa`). A downloaded track goes straight into the existing `new SubtitleTrack(...)` → `loadText()` → `activateTrack()` path.

## P2.0 Decisions — LOCKED

| # | Decision | Value |
|---|---|---|
| E1 | API key | **User supplies their own** (free signup). No bundled key — zero quota liability, nothing extractable from the binary. |
| E2 | Key UX | Soften the paste as far as the API allows: a **"Get a free key"** button opening the signup page, paste-and-**validate** with live ✓/✗ (one cheap authenticated call), explicit inline error on rejection. *(Note: this concedes the standing "no manual copy-paste" auth preference — OpenSubtitles has no OAuth or device flow for API keys. Verified: unauthenticated calls return `{"message":"You cannot consume this service"}`.)* |
| E3 | UI location | **Separate search panel/modal** — the CC menu has no room for a query box + filters + results list. |
| E4 | Matching | **moviehash from the start, with automatic filename text-search fallback.** |
| E5 | Transport | **Rust `ureq`** — non-negotiable, see P2.1. |
| E6 | Cut from FastStream's 499 LOC | season/episode filters, year filter, 4-way sort × direction, paging bar, sessionStorage query persistence. Add later only if their absence bites. |

## P2.1 Verified constraints

| Fact | Evidence |
|---|---|
| **A frontend `fetch` to the API is impossible.** CSP `connect-src` is `'self' http://localhost:14201 http://localhost:14200 http://nobuf-stream.localhost nobuf-stream:` — `api.opensubtitles.com` is absent, so the request dies in the renderer. | `app/src-tauri/tauri.conf.json:22` |
| **FastStream's transport cannot be ported.** It sets `User-Agent` via `header_commands: [{operation:'set', ...}]` — Chrome `declarativeNetRequest`, which does not exist in WebView2. | `OpenSubtitlesSearch.mjs:306-312`, `:402-408` |
| **The Rust HTTP road is already paved.** `ureq` is a dependency and `lib.rs` already proxies HTTP through it. | `Cargo.toml:50`; `lib.rs:150` |
| **Their API key is hardcoded and shared** (`jolY3ZCVYguxFxl8CkIKl52zpHJT2eTw`), and their own code handles quota exhaustion — i.e. it does run dry. Shipping it would leech a third party's quota. | `OpenSubtitlesSearch.mjs:12`, `:416-423` |
| **Auth is mandatory.** Probed live, unauthenticated: `{"message":"You cannot consume this service"}`. | executed `curl` against `/api/v1/infos/formats` |
| **`moviehash` and `query` are the SAME endpoint, combinable** — *"All parameters can be combined following various logics: searching by a specific external id (imdb, tmdb), a file moviehash, or a simple text query."* ⇒ **deferring moviehash would NOT have been rework**, but including it up front costs little and removes the filename dependency. | OpenSubtitles REST API docs (`/subtitles` endpoint description) |
| **Their query builder is already a filterable dict**, so adding a param is one line, not a restructure. | `OpenSubtitlesSearch.mjs:262-289` |
| Tauri commands live in `src-tauri/src/commands/*.rs`, registered in `generate_handler!` | `lib.rs:415+`; e.g. `commands/fs.rs:306` |
| Backend already does tail range fetches (so the hash's last 64KB is a known pattern, not new work) | `server.rs:2090` FMP4-META tail download |

**Why filename-only search is not enough (the reason E4 includes the hash):** Telegram filenames are frequently `video_2024-01-15_12-34-56.mp4` or forwarded-message noise. Text search on that returns nothing useful. `moviehash` identifies the release from its **bytes**, independent of the name.

## P2.2 The moviehash — spec, cost, and how it gets verified

Algorithm: **`filesize` + the sum of all 64-bit little-endian words of the first 64 KiB + the same over the last 64 KiB**, u64 **wrapping** addition, rendered as 16 lowercase hex digits. Sent with `moviebytesize` alongside.

**Byte cost is near zero on an already-playing file:**
- head 64 KiB — already cached; it's the init segment every playback tier reads first
- tail 64 KiB — the existing tail-fetch path (`server.rs:2090`)

⇒ **UNVERIFIED and must be checked during implementation:** whether the head 64 KiB is *always* resident for **every** tier (MP4 / MKV-transmuxer / TS / remux) or only some. If only some, the hash costs one small extra fetch on the others. Measure before claiming "free".

**Verification strategy (because the canonical vectors are unfetchable — Trac is down and the mirrors 404, so no remembered constant goes in this plan):**
1. **Dual independent implementation.** Implement in Rust; implement the spec *separately* in a throwaway Python script (kept out of the repo, in `$LOCALAPPDATA/Temp`). Run both over the same real local file. **They must agree bit-for-bit.** Two independent implementations agreeing is stronger evidence than a copied test constant.
2. **Live ground truth.** Send the computed hash to the real API with a real key for a well-known film. **A hash match returning correctly-titled results is the only proof that actually matters** — it proves the server recognises our hash, which no local vector can.
3. Freeze the agreed value from (1) as the Rust unit test's expected constant, with a comment recording how it was derived.
4. Edge cases to pin: file smaller than 128 KiB (head and tail overlap — must not double-count or panic), file smaller than 64 KiB, non-multiple-of-8 length, and u64 overflow (assert **wrapping**, not saturating or panicking).

## P2.3 Architecture

```
[CC menu] "Search online…"  →  [Search panel]
                                    │
                    ┌───────────────┴───────────────┐
                    │ 1. cmd_opensubtitles_hash     │  Rust: head+tail 64KiB → u64 hex
                    │ 2. cmd_opensubtitles_search   │  Rust ureq → api.opensubtitles.com
                    │ 3. cmd_opensubtitles_download │  Rust ureq → POST /download → text
                    └───────────────┬───────────────┘
                                    ▼
              new SubtitleTrack(label, lang).loadText(text)   ← EXISTS
                        → subs.addTrack() → subs.activateTrack()
```

**Match strategy (one call path, never a dead end):**
1. Try `moviehash` + `moviebytesize`
2. **0 results → automatically** re-query with `query=<cleaned filename>`
3. Label each result with **why** it matched (exact release vs name match) so the user can judge sync confidence
4. Hash unavailable / errored → skip straight to step 2. The hash is an enhancement, never a prerequisite.

Request `sub_format: 'webvtt'` on download (as FastStream does, `:412`) so the payload lands on the best-tested parse path.

## P2.4 Tasks

### Task P1 — moviehash in Rust (pure, testable, no network)
1. New `src-tauri/src/commands/opensubtitles.rs`; register in `commands/mod.rs` + `generate_handler!` (`lib.rs:415+`).
2. Pure `fn opensubtitles_hash(size: u64, head: &[u8], tail: &[u8]) -> String` — no I/O, so it is directly unit-testable.
3. `#[cfg(test)]` covering the P2.2 edge cases; expected constant derived per P2.2 step 1.
4. Verify: `cd src-tauri && cargo test --no-default-features` → new tests pass, existing count unchanged.

### Task P2 — byte sourcing + `cmd_opensubtitles_hash`
1. Wire head/tail acquisition through the existing cache + tail-fetch paths.
2. **Measure and record** actual bytes fetched per tier (P2.2 open item). Return `Option<String>` — `None` on any failure, never an error that blocks search.
3. Verify: log the byte cost per tier; the fallback path still works with `None`.

### Task P3 — API key storage + validation
1. `SettingsContext.tsx`: `openSubtitlesApiKey: string` (default `''`).
2. `cmd_opensubtitles_validate_key` — one cheap authenticated call; returns ok/reason.
3. UI: "Get a free key" link-button, paste field, live ✓/✗, explicit rejection message.
4. **Never log the key.** Not in `console.log`, not in Rust logs, not in error strings.
5. Verify: `tsc --noEmit` 0; invalid key shows the error, valid key shows ✓.

### Task P4 — search + download commands
1. `cmd_opensubtitles_search(query: Option<String>, moviehash: Option<String>, moviebytesize: Option<u64>, languages: String, page: u32)` → normalized results (id, file_id, release name, language, download count, match kind).
2. `cmd_opensubtitles_download(file_id)` → subtitle **text**.
3. Set a NoBuf `User-Agent` (Rust can, unlike the WebView) and pass `Api-Key`.
4. Handle explicitly: **quota exhausted** (their `:416-423` case), 401 bad key, 429 rate-limited, network down, empty results. Each gets a distinct, actionable message — no silent empty list.
5. Verify: `cargo test --no-default-features`; live search returns results for a known title.

### Task P5 — search panel UI
1. New component, opened from a CC-menu row ("Search online…"), placed **outside** the `EarlySubtitleSelection` grep window (§1.3).
2. Query box **pre-filled from the filename**, language **chip group** (never a native `<select>`), results list = release name + language + download count + match-kind badge, sorted by download count desc.
3. States: idle / searching / results / empty / error / no-key (with a pointer to settings).
4. Theme via `--color-nobuf-*`. Escape + outside-click close (existing `data-tray-root` pattern).
5. Verify: `tsc --noEmit` 0; full suite unchanged.

### Task P6 — wire download → existing track path
1. On result click: `cmd_opensubtitles_download` → `new SubtitleTrack(release, lang)` → `loadText(text)` → `addTrack` → `activateTrack`. Toast on success/failure (existing pattern, `:1732-1735`).
2. **Interaction with Phase 1:** an OpenSubtitles track is a **sidecar**, so it appears in `sidecarTracks` (`:2522`) and the Phase 1 size/position/sync sliders apply to it unchanged. Assert this — a track that renders but can't be styled or synced is a half-feature.
3. Verify: end-to-end in `tauri dev` — search, download, subtitle appears, all three sliders affect it.

### Task P7 — gate + handoff
1. `npx tsc --noEmit` → 0; `npx vitest run` → ≥ Phase 1 tally; `cargo test --no-default-features` → pass.
2. Mutation-test the hash (flip wrapping→saturating; drop the tail sum; swap endianness — each must fail a **distinct** test).
3. `git diff` reviewed line by line.
4. Hand to the user: search with a good filename, search with a garbage filename (proves hash matching), a bitmap-only-subs file (the original dead end), a bad key, and no network.

## P2.5 Risks

| Risk | Mitigation |
|---|---|
| Head 64 KiB not cached on some tier ⇒ hash costs an extra fetch | Measure per tier in Task P2; if costly, gate the hash behind "search" being pressed (never on file open) |
| User has no key ⇒ feature looks broken | Explicit no-key state with a one-click path to signup + settings; never an empty result list |
| Quota exhausted mid-session | Distinct message; their API returns `remaining` (`:416`) — surface it |
| Downloaded track is for a different cut | Match-kind badge sets expectations, and Phase 1's **sync slider is the fix** — the two features compound |
| Key leaking into logs | Explicit rule in Task P3; grep for it before shipping |

---

## 7. Out of scope (backlog — user picks later)

Ranked by value, from the verified FastStream gap matrix:
1. **Circular text-shadow outline** (`SubtitlesSettingsManager.mjs:71-91`) — real outline vs our two stacked blurs; materially better legibility.
2. **Export track as `.srt`** — `cuesToSrt` is **already ported** at `SubtitleUtils.ts:187` with **zero callers**; needs a Tauri save dialog.
3. **Auto-enable best track by preferred language** — `getLanguageMatchLevel` is ~20 lines and dependency-free; today a foreign film shows nothing until the user digs into the menu. Must stay opt-in (it triggers a network extraction here).
4. **Surface `forced` / `sdh` / `isDefault`** badges — parsed at `useMSEPlayer.ts:637-639`, never shown in the menu.
5. **Drag the subtitle to reposition** (`SubtitlesManager.mjs:530-570`) — complements, not replaces, the slider.
6. **Load subtitle from URL** (`loadURL()` exists at `SubtitleTrack.ts:50`, zero callers); **"test subtitle" contrast-tuning mode**; OpenSubtitles **season/episode/year filters + paging** (cut from Phase 2 per E6).

**Explicitly NOT doing** (verified as wrong for this codebase): multiple simultaneous tracks (breaks the single-track ASS path, per-file persistence, and costs a network extraction each); cue text editing (our cue-merge would silently overwrite hand edits); `shiftAfter` single-point resync (destructive, and the merge would half-revert it — revisit only if a real mid-file drift case appears, extending the read-time offset into a piecewise function).
