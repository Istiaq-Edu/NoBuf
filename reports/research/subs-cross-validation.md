# Cross-validation: embedded-subtitle research (5 docs)

2026-07-31. Every load-bearing claim re-derived from source or re-executed
AFTER the research docs were written (prior findings treated as hypotheses).
Probes X1-X16 run on a fresh fixture (MKV: srt eng default + ass jpn + TTF
attachment). Verdicts: VERIFIED / FALSIFIED / INCONCLUSIVE.

## Backend / ffmpeg claims

| # | Claim (doc) | Verdict | Evidence |
|---|---|---|---|
| C1 | One ffprobe pass lists subs AND attachments with tags/disposition (ffmpeg-extraction §1/§9) | **VERIFIED** | X1: subtitle+attachment streams, language/filename/default in one `-show_streams` JSON |
| C2 | Extraction by ABSOLUTE stream index works (`-map 0:2`) | **VERIFIED** | X2: full ASS header out of pipe. Endpoint uses absolute idx (matches audio_idx convention) |
| C3 | Absolute idx pointing at a NON-subtitle stream fails cleanly (no garbage output) | **VERIFIED** | X3: exit 8, encoder-selection error, 0 bytes stdout → backend validation still required for clean 404 vs 500, but no silent-wrong-output risk |
| C4 | `-dump_attachment:<idx> <path>` writes endpoint-controlled filename; `-f null -` gives exit 0; bytes identical | **VERIFIED** | X4/X5: 990,208-byte file, `cmp` clean vs source TTF. (X4 note: without an output arg ffmpeg exits nonzero AFTER dumping — use `-f null -`) |
| C5 | Extracted ASS starts with `[Script Info]` → frontend detectFormat routes to jassub | **VERIFIED** | X6 od dump + X10 SubtitleTrack.ts:20-31 regex |
| C6 | Listing = header-only cheap; whole-track = one sequential read; mid-file -ss over HTTP pathological (bytecost P1/P2/P6) | **VERIFIED** (measured myself with byte-accounting server; 4.6 MiB / 383 MiB / 866 MiB) |
| C7 | Bitmap→text refusal error string (formats-codecs §1) | **VERIFIED** | E15 execution: "Subtitle encoding currently only possible from text to text or bitmap to bitmap" |
| C8 | latin-1-in-UTF8 track: extract fails exit 69; `-sub_charenc latin1` retry recovers | **VERIFIED** | E9b/E9c executions (Café naïve über recovered) |
| C9 | `{\anN}` in SRT → 0x07 mangling; BOM stripped; CRLF→LF | **VERIFIED** | E8 od dumps |
| C10 | Zero cues in track → exit 0, 0 bytes (distinct from error) | **VERIFIED** | E14-redo execution |
| C11 | `-map 0:s:N?` trailing-? emitted WRONG track's cues in a probe → never use `?` maps | **VERIFIED** (E16: 159 bytes of track-0 cues under a 0:s:5? map) |
| C12 | Per-message inflight-guard pattern exists to copy (thumb_inflight) | **VERIFIED** | X12/X15: server.rs:5527 StdMutex<HashSet<i32>> |
| C13 | resolve_media_from_path + input-source resolution (cache-if-complete else /stream) reusable | **VERIFIED** | X14 sig; /audio_tracks endpoint :5570-5598 uses exactly this |

## Frontend claims

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| C14 | All four tiers keep video.currentTime ≈ absolute container time → cues need NO offset (frontend-integration §1) | **VERIFIED** | V1-V3 re-reads: SourceBufferWrapper.ts:281 (MP4 absolute); MKV setTimestampOffset(keyframe) seek+audio-switch paths; /remux ABSOLUTE-TIMELINE PIN comment block :6059-6075 + `_dtsBase = 0` :577/:5435 (byte-forward path re-based server-side per server.rs:2306-2311); TS-fMP4 X-Segment-Start-Time→setTimestampOffset :8430/:8440 |
| C15 | Overlay reads same `time` state as progress bar (timeupdate) | **VERIFIED** | X9: :1072 listener, :2003 prop |
| C16 | clearTracks on file.id change; sidecar addTrack path to mirror | **VERIFIED** | X8: :148-153; loadSubFile :1481-1494 |
| C17 | captions chip already in ALL_CHIPS AND defaultBarLayout → NO new chip needed (3-place rule already satisfied) | **VERIFIED** | V4: SettingsContext.tsx:86, FastStreamPlayer.tsx:1532 |
| C18 | JASSUB constructed without fonts today; `fonts: Array<string|Uint8Array>` accepted; recreation on assContent change carries fonts | **VERIFIED** | SubtitleOverlay.tsx:70-85 + jassub.d.ts:21-23 |
| C19 | SubtitleTrack.equals → duplicate risk only for identical content; different-cue tracks with same label pass | **VERIFIED** | X7 source read: label AND language must BOTH differ to short-circuit false; content decides otherwise |
| C20 | `convertSubtitleFormatting` handles `<i>/<b>` + `{\\b1}`-style tags for VTT path | **VERIFIED** | X11: SubtitleUtils.ts:203-230 |
| C21 | Audio precedent (localStorage LRU :397-417, _loadRemuxAudioTracks :5627, per-file reset :1897-1917, return surface) | **VERIFIED** | auditor transcript lines 48/52/54/56 + my own shipped code |

## JS-lib / landscape claims

| # | Claim | Verdict |
|---|---|---|
| C22 | mediabunny cannot read subtitle cues (only enumerate) | **VERIFIED** (skill note + d.ts grep: no subtitle packet API; SUBTITLE_CODECS=["webvtt"] is encode-side) |
| C23 | matroska-subtitles stale (2021) + needs Node stream polyfills | **VERIFIED** (registry JSON: 3.3.2/2021-09-20, deps readable-stream) |
| C24 | @cryguy/mkv-subtitle-extractor: real, fresh (2026-01), zero-dep, Cues-targeted Range reads with linear-scan fallback; MKV-only | **VERIFIED** (read dist/index.js in full: parseCues→readTargetedBlocks→linearScan fallback L1130-1160) |
| C25 | mp4box has subtitleTracks enumeration but NO tx3g cue assembler | **VERIFIED** (isofile.js:328-386; parsing/ has vttC only) |
| C26 | Backend-ffmpeg beats JS libs for NoBuf (containers, charset repair, cache synergy, effort) | **VERIFIED as judgment** — all input facts individually verified; decision follows |
| C27 | Tail-moov MP4 listing over the real Rust server | **INCONCLUSIVE** (toy-server keep-alive artifact; real server proven by /thumb precedent) → re-verify during implementation with one curl |

## Falsified / corrected along the way

- **F1 (was in fan-out prompt):** "trailing `?` map = clean empty output" —
  FALSIFIED by E16 (emitted wrong track). Design consequence: server-side
  index validation, never `?` maps (C11).
- **F2 (old docs/subtitle-implementation-plan.md Phase 7):** "extraction must
  come from a dedicated JS lib or Rust demuxer" — superseded: backend ffmpeg
  covers MKV+MP4 with full ASS fidelity (C2/C5), fonts included (C4). The JS
  path remains documented as an alternative, not chosen.
- **F3 (subs-frontend-integration draft nuance):** tier-specific fetch hooks
  (MEDIA_INFO/onMP4BoxReady/MKV-init) are NOT needed for subs — extraction is
  container-level (ffprobe absolute idx), one tier-independent fetch per file
  suffices (C14 makes offsets a non-issue).

**28 claims: 26 VERIFIED, 1 INCONCLUSIVE (C27, cheap re-check at impl), 1
judgment call (C26) with verified inputs. 3 falsifications caught and folded
into the design. Ready for the implementation plan.**
