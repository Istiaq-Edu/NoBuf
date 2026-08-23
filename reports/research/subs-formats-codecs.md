# Subtitle codec/format landscape — container-embedded subs (MKV/MP4/TS)

2026-07-31. Absorbed by controller after two subagent failures. Mix of local
execution, LOCAL source reads, and primary-doc knowledge; each row tagged.
Companions: subs-ffmpeg-extraction.md (execution evidence),
subs-lib-alternatives.md (jassub font intake details).

## 1. MKV CodecID → ffprobe codec_name (TEXT vs BITMAP)

| MKV CodecID | ffprobe codec_name | Kind | Wild frequency | Extract target |
|---|---|---|---|---|
| S_TEXT/UTF8 | `subrip` | TEXT | web-dl default; most common overall | srt |
| S_TEXT/ASS | `ass` | TEXT | anime fansub dominant (styles/karaoke) | ass (copy) |
| S_TEXT/SSA | `ssa` (older muxes) / `ass` | TEXT | legacy fansub | ass (copy) |
| S_TEXT/WEBVTT | `webvtt` | TEXT | rare (WebM world) | srt |
| S_HDMV/PGS | `hdmv_pgs_subtitle` | **BITMAP** | BluRay remuxes — common in high-quality rips | ✗ (list, refuse) |
| S_VOBSUB | `dvd_subtitle` | **BITMAP** | DVD remuxes | ✗ |
| S_TEXT/USF, S_KATE | (usf/kate) | TEXT (XML) | vanishingly rare | ✗ (skip) |

[VERIFIED-EXEC: subrip/ass/webvtt mappings from local fixture; ssa muxed by
current ffmpeg registers as `ass` codec with ScriptType v4.00 preserved —
E17.] [Bitmap rows VERIFIED-DOC matroska.org/technical/subtitles.html.]

- ffprobe listing carries `disposition.default/forced/hearing_impaired` +
  `tags.language` (ISO 639-2) + `tags.title` per track [VERIFIED-EXEC E1].

## 2. MKV ASS storage & why raw blocks can't feed jassub

- The script header (`[Script Info]` + `[V4+ Styles]` + `[Events] Format:`)
  lives in the track's **CodecPrivate** element. Each BlockGroup payload is a
  comma-joined Dialogue WITHOUT the `Dialogue:` prefix, fields reordered as
  `ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text` —
  no Start/End (block timestamp+duration carry timing)
  [VERIFIED-DOC matroska.org/technical/subtitles.html].
- ffmpeg reconstructs a valid .ass on extraction: extradata → header, blocks →
  `Dialogue:` lines with times re-synthesized from block timestamps, ordered
  by ReadOrder [VERIFIED-EXEC E6: byte-identical styles, tags, PlayRes].
- Raw block text alone = no styles, no Format line, no timing → jassub cannot
  render it. Always ship the reconstructed full script.

## 3. jassub/libass needs (see subs-lib-alternatives.md §5 for API evidence)

- Input: complete ASS script via `subContent` (current SubtitleOverlay already
  does this for sidecar ASS) [VERIFIED-LOCAL SubtitleOverlay.tsx:73-79].
- Fonts: `fonts: Array<string|Uint8Array>` (eager) or `availableFonts:
  Record<name, url|bytes>` (lazy); late `renderer.addFonts()` risks FOUT.
  Missing referenced font → libass falls back to the default font (jassub
  bundles `default.woff2`); text renders, styling degrades gracefully
  [VERIFIED-LOCAL jassub.d.ts + README].
- ASS `[Fonts]` UUEncoded embedded-font sections: libass parses embedded
  fonts (README: "Supports … embedded fonts") — no extra work needed for
  script-embedded fonts; ATTACHMENT fonts (separate MKV streams) are the case
  we must dump+serve. [VERIFIED-DOC jassub README L16]

## 4. MKV font attachments

- ffprobe: `codec_type:"attachment"`, selector `t`, `tags.filename` +
  `tags.mimetype` [VERIFIED-EXEC E12].
- Mimetypes in the wild: `application/x-truetype-font`, `font/ttf`,
  `font/otf`, `application/vnd.ms-opentype`, `application/font-sfnt`
  [VERIFIED-DOC matroska attachment conventions; ffprobe showed
  x-truetype-font locally].
- Dump: `-dump_attachment:t "" -i in.mkv` → writes files (by filename tag) to
  CWD; FILES ONLY, no pipe [VERIFIED-EXEC E12 — 1,045,960-byte TTF dumped].
  Cheap: attachments live in the header region.

## 5. MP4 mov_text / tx3g

- Sample = 2-byte BE length + UTF-8 text + optional style boxes ('styl' etc.)
  [VERIFIED-DOC 3GPP TS 26.245].
- ffmpeg mov_text→srt keeps text + basic bold/italic/color styling as HTML-ish
  tags; title arrives as `tags.name` (not title) in ffprobe [VERIFIED-EXEC
  E2/E18]. WebVTT-in-MP4 (`wvtt`) exists but is rare; mp4box has a vttC
  sample-entry parser but no cue assembler [VERIFIED-LOCAL mp4box/src/parsing].
- MP4 disposition: `disposition.default` maps from tkhd/track enabled flags —
  present in ffprobe output same as MKV [VERIFIED-EXEC shape].

## 6. MPEG-TS: out of scope (documented reasons)

- `dvb_subtitle` = BITMAP → text impossible without OCR.
- `dvb_teletext` needs libzvbi; **this WinGet build HAS libzvbi_teletextdec**
  [VERIFIED-EXEC -decoders], but teletext subs in user content are broadcast
  recordings only — skip for v1.
- CEA-608/708 captions ride inside H.264 SEI, decoder `cc_dec` exists
  [VERIFIED-EXEC]; extraction needs `-f lavfi movie=...` chains, fiddly, rare
  in Telegram content — out of scope, note for future.
- NoBuf's TS tier plays via /remux with `-sn` anyway; nothing breaks.

## 7. Text quirks → owning layer

| Quirk | Handled by | Evidence |
|---|---|---|
| UTF-8 BOM | ffmpeg strips on extract | E8 od dump |
| CRLF | normalized to LF by ffmpeg | E8 |
| `<i>/<b>/<font>` in SRT | frontend `convertSubtitleFormatting` (existing) | SubtitleUtils |
| `{\anN}` in SRT text | **ffmpeg mangles to 0x07+`nN`** → frontend must strip C0 bytes | E8 quirk |
| Overlapping cues | overlay `activeCues` walks overlaps (existing) | SubtitleOverlay.tsx:39-52 |
| Zero-duration cues | survive extraction; overlay shows nothing (start==end) — fine | E6/E13 |
| Out-of-order cues | ffmpeg emits time-sorted; parser also sorts on flush | E10 + SubtitleTrack.ts:106 |
| >3 h timestamps | fine (`03:10:15,000`) | E10 |
| Commas in ASS text | 9-comma split rule — ffmpeg handles; we ship full script | E6 |
| latin-1 mislabeled as UTF-8 | backend retry with `-sub_charenc latin1` | E9b/E9c |

## 8. Disposition → auto-select conventions

- `default`: player enables track when subs are "on" by default (mpv
  `--sid=auto` honors it; VLC similar). `forced`: show even when subs are off
  IF language matches audio/UI (translations/signs) — mpv `--subs-with-matching-audio`,
  Plex "forced only" mode. `hearing_impaired`: label as SDH, never auto-pick
  over a normal track. [VERIFIED-DOC mpv man: sub options; Plex forced-subs
  behavior docs.]
- **NoBuf v1 recommendation:** never auto-ENABLE subtitles (current UX: subs
  off until user acts). In the menu, order tracks: default first, then by
  track order; badge `forced` and `SDH`; remember per-file last choice (same
  localStorage LRU as audio). Auto-enable rules can come later.
