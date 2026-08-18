# Embedded Subtitle Extraction — Implementation Plan

2026-07-31. Fix #1 from `future-work-overview.md` (the last remaining media
gap). Grounded in 5 research docs + `subs-cross-validation.md` (26/28 claims
VERIFIED by execution/source; falsifications F1-F3 folded in). Supersedes the
extraction phases of the older `docs/subtitle-implementation-plan.md` (its
render-layer phases 1-4 shipped long ago; its Phase-7 JS-lib premise is
superseded by F2).

## 0. Decision (from verified evidence)

**Backend ffmpeg extraction, absolute-stream-index API, whole-track policy,
per-track disk cache.** Not the JS-lib path: MKV-only, no charset repair,
scattered Range reads fight the contiguous cache/prebuffer model (C24/C26),
while the backend reuses shipped, tested patterns (/audio_tracks probe +
memoize, /thumb inflight-guard, cache-if-complete input resolution) and covers
MKV **and** MP4 with byte-faithful ASS + fonts (C2/C4/C5).

Frontend consequence of C14 (all four tiers keep `video.currentTime` ≈
absolute container time): extracted cues need **no per-tier offset work at
all** — one container-agnostic fetch per file, feed text into the existing
`SubtitleTrack`/`useSubtitles`/`SubtitleOverlay` stack unchanged.

## 1. Backend (server.rs) — three endpoints + own pure parser

Route shapes (distinct static prefixes — actix would otherwise try to parse
`"list"` into an i32 path param and 400/404 depending on registration order):
- `GET /subtitles/{folder_id}/{message_id}/list`
- `GET /subtitles/{folder_id}/{message_id}/track/{stream_idx}`
- `GET /subtitles/{folder_id}/{message_id}/font/{att_idx}`

Probe parsing: a NEW pure fn `parse_subtitle_probe_json(&str) ->
SubProbeResult { tracks: Vec<SubTrackInfo>, fonts: Vec<FontAttachmentInfo> }`
— does NOT touch `StreamProbeResult`/`parse_probe_json` (zero blast radius on
/remux). The endpoint spawns its own ffprobe with the same arg shape as
`run_stream_probe` (server.rs:2643-2650).

### 1.1 `GET /subtitles/{folder_id}/{message_id}/list?token=`
- `resolve_media_from_path` → memo check (`sub_tracks_json: HashMap<i32,String>`
  on TelegramState, same shape as `audio_tracks_json` commands/mod.rs:88) →
  input source = fully-cached file path else local `/stream` URL with
  `source_id=subs` (download-coordinator isolation, same reason as
  `source_id=tracks` in /audio_tracks :5581-5584) → ONE ffprobe
  `-show_streams -print_format json` (5 MB budget; no `-select_streams` —
  we want subs AND attachments in one pass, C1).
- Response JSON:
  ```json
  { "tracks": [ { "idx": 2, "codec": "subrip", "kind": "text",
      "lang": "eng", "title": "English", "default": true, "forced": false,
      "hearing_impaired": false } ],
    "fonts": [ { "idx": 5, "filename": "arial.ttf",
      "mimetype": "application/x-truetype-font" } ] }
  ```
  `kind`: `"text"` for subrip/ass/ssa/webvtt/mov_text, `"bitmap"` for
  hdmv_pgs_subtitle/dvd_subtitle/dvb_subtitle, `"unsupported"` otherwise.
  Bitmap tracks are listed (UI greys them out with a reason) — C7.
- Memoize only non-empty inventories (audio precedent). Files with zero
  subtitle streams memoize as `{"tracks":[],"fonts":[]}` — cheap, avoids
  re-probing on every open. (Deviation from audio: empty IS memoized here,
  because "no subs" is the common permanent case; audio skipped empty-memo
  only for the partial-probe race, which the 5 MB header probe doesn't hit
  for stream declarations — C6/P11.)

### 1.2 `GET /subtitles/{folder_id}/{message_id}/track/{stream_idx}?token=`
- Validate `stream_idx` against the (memoized) probe: must be a TEXT subtitle
  stream — else 404 `{"error":"not a text subtitle stream"}` (F1/C11: never
  `?` maps, never trust client idx).
- Disk cache first: `{remux_dir}/subs/{folder}_{msg}_s{idx}.{ass|srt}` —
  serve if present (extraction is deterministic; cache never invalidates).
- Inflight guard per message via a `subs_inflight()` StdMutex<HashSet<i32>>
  twin of thumb_inflight (server.rs:5527) + Drop guard (:5674-5680);
  concurrent duplicate request → 429 + Retry-After (client treats as "still
  loading"). Keyed by message_id only (not (msg,idx)): serializing per FILE is
  correct — two tracks of the same file extracting concurrently would both
  read the whole file over /stream (wasteful) or contend on cache locks.
- Extraction command (whole-track, C6 policy):
  - ass/ssa source: `ffmpeg -nostdin -loglevel error -i INPUT -map 0:{idx}
    -c:s copy -f ass FILE.tmp` (full header fidelity, C5/E6).
  - subrip/webvtt/mov_text source: `… -map 0:{idx} -f srt FILE.tmp`.
  - INPUT = fully-cached file path (fast: 0.15 s, P7) else `/stream` URL with
    `source_id=subs` (sequential read = cache warm; acceptable, C6). 120 s
    hard timeout via `tokio::time::timeout` + `kill_on_drop(true)` (thumb
    pattern server.rs:5732/5735). Extraction writes to `FILE.tmp` then
    atomic-renames to the cache name on success (remux .tmp convention).
- Error handling:
  - exit != 0 AND stderr contains `Invalid UTF-8` → retry once with
    `-sub_charenc latin1` before `-i` (C8). Retry success → cache + serve.
  - other failure → 502 with stderr tail logged; tmp deleted.
  - exit 0 with 0-byte output → 204 No Content (C10: legitimate empty track;
    client shows "no cues"). NOT cached (a partially-cached file may yield
    cues later; re-extract on next request).
  - `File ended prematurely` warning with cues present (partial cache, P8):
    serve BUT mark `X-Subs-Partial: 1` and don't cache to disk — client may
    refetch later (e.g. next file open) for the full set.
- Response: `text/plain; charset=utf-8` body = subtitle text; header
  `X-Subs-Format: ass|srt`.
- **CORS:** add `X-Subs-Format` + `X-Subs-Partial` to the `expose_headers`
  list (server.rs:5828) — the WebView origin (localhost:1420 /
  nobuf-stream.localhost) is cross-origin to 127.0.0.1:PORT, so un-exposed
  custom headers are invisible to frontend JS (same reason
  X-Segment-Start-Time is in that list).
- Register all three services next to `audio_tracks_list` (server.rs:5840).

### 1.3 `GET /subtitles/{folder_id}/{message_id}/font/{att_idx}?token=`
- Validate att_idx is an attachment stream with a font mimetype/extension
  (ttf/otf/woff — C4 matrix in formats doc §4).
- Cache: `{remux_dir}/subs/{folder}_{msg}_f{idx}.bin`; extraction:
  `ffmpeg -nostdin -dump_attachment:{idx} FILE.tmp -i INPUT -f null -`
  (endpoint-controlled filename + clean exit 0 — X4/X5). Serve with the
  probed mimetype; `font/ttf` fallback.

### 1.4 Rust tests (pure, no ffmpeg spawn)
- probe JSON → track/font classification (text/bitmap/unsupported, tags,
  dispositions; mov_text `tags.name` → title fallback — E2).
- stream_idx validation (text ok / bitmap 404 / video 404 / absent 404).
- cache filename builder.
- extraction arg builders (ass-copy vs srt-transcode vs charenc-retry vs
  font-dump shapes).

## 2. Frontend

Cross-validation ledger (hard facts an implementer needs, re-read from source
during plan review):

| Anchor | Verified | Source |
|---|---|---|
| `_loadRemuxAudioTracks` template incl. `parseStreamUrl` + stale-guard | ✓ | useMSEPlayer.ts:5627-5660 |
| audio state trio + per-file reset block | ✓ | useMSEPlayer.ts:1441-1443, 1897-1917 |
| LRU helpers (`readPersistedAudioTrack`/`persistAudioTrack`) | ✓ | useMSEPlayer.ts:397-417 |
| `useSubtitles` API: `addTrack` returns existing-or-new; `activateTrack`; `toggleTrack`; `clearTracks` | ✓ | useSubtitles.ts:31-52, 75-80 |
| `SubtitleTrack(label, language)` + `loadText` + detectFormat (BOM-tolerant ASS regex) | ✓ | SubtitleTrack.ts:20-31, 45-48, 77-114 |
| captions menu render + "Load subtitle file…" row | ✓ | FastStreamPlayer.tsx:1746-1764 |
| `subs.clearTracks()` on file.id change | ✓ | FastStreamPlayer.tsx:148-153 |
| JASSUB constructor site (no fonts today) | ✓ | SubtitleOverlay.tsx:73-79 |
| jassub `fonts?: Array<string\|Uint8Array>` | ✓ | node_modules/jassub/dist/jassub.d.ts:21 |
| toast via sonner | ✓ | FastStreamPlayer.tsx:5 |

### 2.1 Types + fetch (useMSEPlayer.ts, mirroring audio precedent C21)
- `EmbeddedSubTrack { idx, label, language, codec, kind, isDefault, forced,
  sdh }`; label via a `buildSubTrackLabel` twin of `buildAudioTrackLabel`
  (title → language → codec → position; badges: `forced`, `SDH`) — C21.
- State: `embeddedSubTracks`, `embeddedSubsLoading` (+ a fetched-guard ref).
- `_loadEmbeddedSubTracks()`: fetch `/subtitles/.../list`, stale-guard by
  messageId (audio :5627 template), normalize, setState. Trigger: ONE
  tier-independent call from the per-file block in the main init effect
  (:1897-1917 region) — F3. Reset in the same per-file block.
- Return surface: `embeddedSubTracks`, `embeddedSubsLoading`,
  `fetchEmbeddedSubText(idx)` (fetch + C0-strip, below).

### 2.2 Text intake (C9 quirk)
- `fetchEmbeddedSubText`: GET extraction endpoint; on 200 strip C0 control
  bytes except \n\t (the 0x07 `{\an8}` mangling — E8) BEFORE
  `track.loadText(text)`; 204 → toast "Track has no cues"; 429 → brief retry
  (extraction inflight); 5xx → toast error.
- ASS text (X-Subs-Format: ass) flows through the EXISTING detectFormat
  (starts with `[Script Info]` — C5/X6) → isASS → jassub. No new parse code.

### 2.3 Fonts → jassub (C18)
- When list.fonts is non-empty AND an ASS embedded track is activated, pass
  `fonts: [fontUrls...]` into the JASSUB constructor in SubtitleOverlay
  (props: `assFonts?: string[]`). Instance already recreates on assContent
  change (:70-85) — fonts ride along. Sidecar ASS: prop absent, behavior
  unchanged (surgical).

### 2.4 Captions menu (FastStreamPlayer.tsx :1746 — NO new chip, C17)
- Between the track list and "Load subtitle file…": an "Embedded" section
  listing `embeddedSubTracks` — rows show label + badges; bitmap rows
  disabled with "(image-based — unsupported)". Click: if not yet loaded →
  `fetchEmbeddedSubText` → `SubtitleTrack(label, lang)` + `loadText` +
  `subs.activateTrack(subs.addTrack(track))`, remembering the mapping
  idx→track so a second click toggles instead of re-fetching (dedup safety
  independent of `equals` — C19). Loading row shows a spinner state;
  failures toast (sonner).
- Per-file persistence: `nobuf_sub_tracks` localStorage LRU (audio :397-417
  twin), storing selected embedded idx or 'off'. On track-list load, if the
  persisted idx exists and subtitles were on for this file → auto-fetch +
  activate. NEVER auto-enable without a persisted choice (formats doc §8
  recommendation: subs stay off until the user acts).

### 2.5 Vitest
- `buildSubTrackLabel` (title/lang/codec/position + forced/SDH badges).
- C0-strip function (0x07 case from E8; preserves \n\t).
- list-normalization (kind classification incl. bitmap; mov_text name/title).
- persistence LRU round-trip + cap.
- planEmbeddedFetch-style guard (already-loaded → toggle, loading → noop).

## 3. Edge-case matrix

| # | Case | Handling | Layer |
|---|---|---|---|
| E1 | No subtitle streams | list → `tracks:[]`, menu shows no Embedded section | backend memo + UI |
| E2 | Bitmap subs (PGS/VobSub/DVB) | listed `kind:"bitmap"`, greyed row, never extractable (C7) | both |
| E3 | Invalid/forged stream_idx | 404 via probe validation (F1/C11) | backend |
| E4 | Track with zero cues | 204, toast, not cached (C10) | both |
| E5 | Partially-cached file | extraction from prefix works (P8); `X-Subs-Partial: 1`, no disk cache, refetch next open | backend |
| E6 | Uncached file | /stream input = sequential full read = cache warm (C6); UI shows loading row until done | backend |
| E7 | latin-1 mislabeled UTF-8 | exit-69 + signature → one `-sub_charenc latin1` retry (C8) | backend |
| E8 | `{\anN}` 0x07 mangling / other C0 bytes | strip before loadText (C9) | frontend |
| E9 | UTF-8 BOM / CRLF | ffmpeg strips/normalizes (E8); detectFormat tolerates BOM anyway | ffmpeg |
| E10 | ASS styles/positioning/karaoke | ass-copy extraction is byte-faithful (E6); jassub renders | backend+jassub |
| E11 | ASS referencing attachment fonts | fonts listed + served; jassub `fonts:[urls]` (C4/C18); missing font → libass default fallback | both |
| E12 | SSA (v4.00) source | same ass-copy path; ScriptType preserved (E17); detectFormat 'ssa' → jassub | both |
| E13 | mov_text MP4 | `-f srt` transcode; title from `tags.name` (E2/E18) | backend |
| E14 | Multiple text tracks incl. dual-language | independent fetch/activate per row; VTT tracks stack, ASS first-wins (existing overlay contract) | frontend |
| E15 | Concurrent extract requests (double-click, two windows) | per-message inflight set → 429 + Retry-After; client retries briefly (C12) | backend |
| E16 | Seeks/tier switches/audio switches after activation | cues absolute + currentTime absolute on all tiers (C14) → nothing to do | — |
| E17 | File switch mid-fetch | messageId stale-guard drops response (audio C21 pattern); clearTracks on file.id (C16) | frontend |
| E18 | Sidecar + embedded coexistence | separate menu sections; idx→track map prevents duplicate embedded adds; equals() handles content dupes (C19) | frontend |
| E19 | Huge tracks (movie-length ASS w/ typesetting) | text is KB-MB scale; extraction whole-track once, disk-cached (C6) | backend |
| E20 | ffmpeg missing | ensure_ffprobe/ensure_ffmpeg error → 500 w/ message (existing pattern) | backend |
| E21 | >3 h timestamps / overlaps / zero-duration / out-of-order | ffmpeg emits sorted (E10); parser sorts on flush; overlay walks overlaps (C20 stack) | existing |
| E22 | Tail-moov MP4 listing over /stream (C27 INCONCLUSIVE) | one curl re-check during impl; /thumb precedent says fine | impl gate |

## 4. Sequencing

1. **Backend**: probe classification + list endpoint + extraction endpoint +
   font endpoint + tests (self-contained; cargo-testable; curl-verifiable
   against a dev server with a real MKV — closes E22/C27).
2. **Frontend helpers**: label builder, C0-strip, normalizer + vitest.
3. **Hook wiring**: fetch/state/persistence in useMSEPlayer.
4. **UI**: captions-menu Embedded section + fonts prop on SubtitleOverlay.
5. **Gates**: `cargo test --no-default-features` / `npx tsc --noEmit` /
   `npx vitest run` — zero regressions; then hand to user for `tauri dev`
   e2e with a real dual-sub MKV (upload as FILE, not compressed video).

## 5. Non-goals (unchanged from research)

- Bitmap subtitle OCR/burn-in (PGS/VobSub/DVB) — listed-greyed only.
- TS teletext / CEA-608/708 — out of scope (formats §6).
- OpenSubtitles search, sync editor — separate features, untouched.
- Auto-enable heuristics (forced-track logic) — deferred; persistence-based
  re-enable only.
