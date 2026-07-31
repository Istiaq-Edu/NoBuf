# Frontend Review — Embedded Subtitle Selection (useMSEPlayer +255, FastStreamPlayer +105, SubtitleOverlay +12)

**Reviewed:** hook helpers + state + fetchers, captions-menu Embedded section, jassub fonts pass-through, EmbeddedSubtitles.test.ts (19 tests).
**Process note:** two reviewer passes lost their final verdicts to a provider infra error; investigation trails survived (the `'pub'`-vs-`'home'` fileKey question was mid-analysis). Everything below re-verified against live source.

**Verdict:** **Approve** (2 Required findings — both FIXED in this pass, see below)

## Tests-first
19 tests: label building (title/language/badges/fallbacks), C0 stripping (the 0x07 `{\anN}` mangling, preservation of \n\t\r), normalizeSubList (kinds, invalid-index drops, malformed payloads, default-first ordering), persistence LRU (round-trip, -1 off-marker, corrupt storage, 200-cap eviction, LRU refresh, store separation from audio). Behavior-level, mirrors AudioTrackSelection.test.ts precedent. **Gap (recommended, not demanded):** `fetchEmbeddedSubText` 429-retry/204 paths and the toggle flow are untested (need fetch mocking — house precedent doesn't mock fetch either).

## Findings (severity-ordered)

- **FIXED (was Required) — mid-extraction file switch leaked state** (FastStreamPlayer.tsx toggleEmbeddedSub): an extraction started on file A that resolved after switching to file B would (a) activate A's cues on B via `subs.activateTrack`, (b) persist A's track idx under B's fileKey — wait, no: fileKey was captured at call time (A's), so persist was safe — but activation and the `finally` clearing B's spinner state were real. Fix: `embeddedSubFileGenRef` generation counter bumped in the per-file reset effect; the toggle drops results and skips its `finally` cleanup when the generation moved.
- **FIXED (was Required) — one transient list-fetch failure hid embedded subs all session** (useMSEPlayer.ts loadEmbeddedSubTracks): `embeddedSubsFetchedForRef` was set before the await and never cleared on HTTP-error/exception, so the single-flight marker permanently blocked refetch for that file. Fix: marker cleared on !resp.ok and on catch (only when still owning the fileKey), so the next trigger retries.
- **Checked OK — fileKey consistency (the open question from the lost review):** `nobuf-sub-track` is read/written ONLY in FastStreamPlayer, all 4 sites use `${activeFolderId ?? 'pub'}:${file.id}`. The hook exports the helpers but never calls them with a URL-derived key. MediaPlayer's `'home'` URL fallback is a different namespace (stream URLs, not storage keys) — no dual-key risk. Audio's store (`nobuf-audio-track`) uses a different key shape AND a different storage key — no collision.
- **Checked OK — XSS through extracted cue text:** vtt.mjs `convertCueToDOMTree` builds DOM via `createElement` from a fixed TAG_NAME whitelist (`c v lang b u i tt ruby rt`, vtt.mjs:1130-1197) and `createTextNode` for everything else (:1273); `<script>`/`<img onerror>` in a malicious MKV's cues fail the tag-map lookup and render as inert text. The `dangerouslySetInnerHTML` in SubtitleOverlay receives only this whitelisted tree's serialization. ASS path renders to canvas via jassub WASM — no DOM injection. Same pipeline already accepted sidecar files from disk, so embedded extraction adds no new trust boundary.
- **Checked OK — stale list responses:** live-messageId comparison discards responses for previous files; spinner state only cleared by the owning fetch.
- **Checked OK — auto-reapply semantics:** ref marks per fileKey before reading persistence — intentional once-per-file-visit (a choice made NOW is live in `subs`; reapply is for the NEXT open). On mp4ReinitNonce same-file re-init the hook intentionally does NOT reset the inventory (container-level, still valid) and the applied-ref keying by fileKey means no double-apply. 1.5s timer cleaned up in the effect teardown.
- Consider: `getEmbeddedSubFontUrls()` inline in JSX creates a new array each render, but SubtitleOverlay's jassub effect deps use `assFonts?.join(',')` — string-stable, so jassub does NOT re-instantiate on unrelated renders. Works, but passing `embeddedSubFonts` + building URLs inside the overlay would be cleaner. Not blocking.
- Consider: clicking track B while A extracts is silently ignored (single busy slot). A queued or per-idx busy model would be nicer UX; extraction is seconds-scale and the spinner communicates state. Not blocking.
- Nit: useMSEPlayer.ts is now ~9.7k lines — far past the healthy-file threshold. The subs block is cohesively grouped (helpers at 420-560, fetchers at 5760-5880) and export-clean, so it's a ready-made extraction candidate (`useEmbeddedSubtitles.ts`) next time the file is split. Pre-existing condition; this change didn't create it.

## Dead code
None. All new exports have call sites or tests.

## Verified vs assumed
Verified: every localStorage caller (rg over src), vtt.mjs whitelist + createTextNode path, jassub dep-string dampening, timer cleanup, per-file reset ordering relative to the 1.5s fetch effect, persist-key capture-at-call-time in the toggle. Assumed: WebView2 runtime behavior of jassub font fetching (e2e item); real 429/204 backend responses (covered by backend tests + research docs).

## Post-review gates (after the 2 fixes)
- `npx tsc --noEmit` → clean
- `npx vitest run` → 366/366, 22/22 files
- `cargo test --no-default-features` → 178/178 (backend untouched by fixes)
