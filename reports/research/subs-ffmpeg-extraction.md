# ffmpeg/ffprobe embedded-subtitle extraction — execution-verified findings

2026-07-31. All tests run locally (ffmpeg/ffprobe from WinGet PATH) on generated
fixtures. Tags: [VERIFIED-EXEC] = ran here with output shown/summarized.
Companion doc: `subs-execution-bytecost.md` (HTTP Range byte costs).

Fixture: `fix.mkv` = testsrc2 70s H.264 + 3 sub tracks (0:s:0 subrip eng
"English" default; 0:s:1 ass jpn "Japanese" forced; 0:s:2 webvtt untagged) +
`fix.mp4` (mov_text eng).

## 1. ffprobe listing fields [VERIFIED-EXEC]

`ffprobe -v error -print_format json -show_streams -select_streams s INPUT`

MKV subtitle streams expose: `index` (absolute), `codec_name`
(subrip/ass/webvtt), `codec_type:"subtitle"`, `tags.language` ("eng"),
`tags.title` ("English"), `disposition.default/forced/hearing_impaired`
(0/1 ints), plus noise tags (ENCODER, DURATION). MP4 mov_text: `tags.language`,
`tags.handler_name` ("SubtitleHandler"), and the title arrives as **`tags.name`**
(NOT `tags.title`) — read both keys.

- `-select_streams s` filters to subs only; absolute `index` values are
  preserved (1,2,3 in a file whose video is 0).
- Listing works on a truncated 100MB prefix of a 383MB file (bytecost doc P11)
  and with a 5MB probe budget — sub tracks are declared in the MKV Track
  header / MP4 moov. [VERIFIED-EXEC]
- Attachments (fonts) are `codec_type:"attachment"` streams, selector `t`:
  `codec_name:"ttf"`, `tags.filename`, `tags.mimetype`. [VERIFIED-EXEC E12]

## 2. Error paths [VERIFIED-EXEC]

| Case | Behavior |
|---|---|
| `-map 0:s:5` (doesn't exist) | exit 127 (MSYS; raw code nonzero), stderr `Stream map '' matches no streams.` — NO output produced |
| `-map 0:s` on file with no subs | same error, same message |
| `-map '0:s:5?'` (trailing ?) | **unreliable** — in one test it emitted another track's cues instead of nothing. Do NOT use `?` maps; validate the index against ffprobe results server-side (same as audio_idx validation) |
| Track exists, zero cues in range | exit 0, **0 bytes output** — clean empty result (E14) |
| Corrupt/truncated container tail | extraction of cues present in the valid prefix still works; exit 0 with `File ended prematurely` warning (bytecost P8) |

## 3. Text→text conversion matrix [VERIFIED-EXEC E5]

Sources subrip/ass/webvtt (MKV) and mov_text (MP4) × targets `-f srt`,
`-f ass`, `-f webvtt`: **all 12 combinations exit 0**. SSA v4.00 source muxes
into MKV as codec `ass` and extracts with `-c:s copy -f ass` preserving
`ScriptType: v4.00` (E17). Bitmap→text is impossible:
`Subtitle encoding currently only possible from text to text or bitmap to
bitmap` [VERIFIED-EXEC E15 — real ffmpeg error string]. So PGS
(hdmv_pgs_subtitle) / dvd_subtitle / dvb_subtitle tracks must be **listed but
marked non-extractable** (or omitted with a reason).

## 4. ASS fidelity [VERIFIED-EXEC E6/E9]

`-map 0:s:N -c:s copy -f ass pipe:1` reconstructs a COMPLETE .ass script:
`[Script Info]` (PlayResX/Y preserved), full `[V4+ Styles]` (custom styles
byte-preserved: `Style: Signs,Impact,30…`), `[Events]` with Format line.
Override tags `{\pos(320,50)}`, `{\fad(200,200)\c&H00FF00&}`, commas inside
text, zero-duration Dialogue lines — all preserved. Header comes from codec
extradata (MKV CodecPrivate), so no manual synthesis is needed; output is
directly jassub-feedable.

ASS→SRT transcode (`-f srt`): styles collapse to `<font face size color>` +
`<b>`; positioning becomes a leading `{\an8}`-style tag glued into the text
(E7). Conclusion: **never downconvert ASS for rendering — extract ASS as ASS**
(we have jassub); ass→srt is only a last-resort fallback.

## 5. Charset [VERIFIED-EXEC E9]

- Latin-1 SRT **muxed as-is** with `-c:s copy` produces an MKV whose track
  extraction FAILS (exit 69, `Invalid UTF-8 in decoded subtitles text; maybe
  missing -sub_charenc option`). With `-c:s srt` (transcode) the mux itself
  errors the same way.
- `-sub_charenc latin1` placed BEFORE `-i` fixes BOTH mux and extraction —
  and critically, **it works on the broken MKV at extraction time**: E9c
  extracted `Café naïve über` correctly from an MKV containing latin-1 bytes
  in an S_TEXT/UTF8 track.
- Endpoint policy: on extraction failure with the `Invalid UTF-8` stderr
  signature, retry once with `-sub_charenc latin1` (covers the dominant
  legacy-encoding case); otherwise surface the error.

## 6. BOM / CRLF / tag quirks [VERIFIED-EXEC E8/E13]

- UTF-8 BOM in source .srt: **stripped** by the mux+extract round trip; output
  starts with `1\n`. CRLFs normalize to LF.
- HTML-ish tags in SRT (`<i>`, `<b>`) survive extraction verbatim — the
  existing frontend `convertSubtitleFormatting` handles them.
- **★ QUIRK:** literal `{\anN}` brace tags inside SRT text come back with the
  backslash-a swallowed into a 0x07 (BEL) control byte: `{<0x07>n8}`. The
  frontend loader must strip C0 control chars (except \n\t) from extracted
  cue text; the position tag itself is lost (acceptable — it was an ASS-ism
  inside SRT).
- Out-of-order + overlapping cues in the source: matroska muxing reorders by
  time; extraction emits them time-sorted; >3h timestamps fine (`03:10:15,000`)
  (E10). Zero-start zero-duration cue survives (E13).

## 7. Multi-track single run [VERIFIED-EXEC E11]

`ffmpeg -i in.mkv -map 0:s:0 -f srt out0.srt -map 0:s:1 -c:s copy -f ass
out1.ass` works — one process, two outputs, per-output `-map`/`-c`. For the
endpoint, per-track on-demand extraction is still simpler (cache per track);
the single-run form is useful for a warm-all pass on fully-cached files.

## 8. stdout hygiene [VERIFIED-EXEC]

`-f srt pipe:1` / `-f ass pipe:1` with `-hide_banner -loglevel error -nostdin`:
stdout carries ONLY the subtitle text (banner/progress go to stderr). SRT of a
240-cue track ≈ 17.7 KB — response size is negligible.

## 9. Font attachments [VERIFIED-EXEC E12]

- Listing: `-select_streams t` → `codec_type:"attachment"` with
  `tags.filename` + `tags.mimetype` (`application/x-truetype-font` for .ttf).
- Dumping: `-dump_attachment:t "" -i in.mkv` writes each attachment to CWD
  under its `filename` tag (verified 1,045,960-byte arial.ttf). It is an INPUT
  option writing FILES only (no pipe) — endpoint should dump into a per-message
  cache dir and serve the files from there. Note: `-dump_attachment` requires
  reading as far as the attachment element (usually in the header, cheap).

## 10. Endpoint-shaping conclusions

1. List once per file (memoize like `/audio_tracks`); include disposition +
   codec so the UI can pre-select default/forced and grey out bitmap tracks.
2. Extract per track on demand: text codecs → `srt` for subrip/webvtt/mov_text
   sources, **ass (codec copy) for ass/ssa** sources. Never `?` maps — validate
   index server-side.
3. Retry-once with `-sub_charenc latin1` on the `Invalid UTF-8` signature.
4. Empty output (0 bytes, exit 0) is a legitimate "no cues yet/at all" result —
   distinguish from failure.
5. Fonts: dump attachments to cache dir; serve alongside the ASS text.
6. Frontend: strip C0 control bytes from extracted text before parsing.
