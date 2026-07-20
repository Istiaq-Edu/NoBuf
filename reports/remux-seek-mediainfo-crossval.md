# Remux-seek "video doesn't play" — cross-validated findings

Scope: why the ffmpeg-driven remux seek (HEVC/EAC3 MKV, ss>0) produces valid TS
that the demuxer consumes but never plays. Every claim below re-derived from
source in this session and marked VERIFIED / FALSIFIED / INCONCLUSIVE. Prior-turn
diagnoses treated as hypotheses, not fact.

## Evidence base
- `12-c.md` (console) + `12-t.md` (Rust terminal), seek to ss=802.6s then ss=1309.2s.
- mpegts.js source under `app/node_modules/mpegts.js/src`.
- `app/src/hooks/useMSEPlayer.ts`, `app/src/lib/faststream/MpegtsChunkLoader.ts`.

---

## VERIFIED claims

**V1 — The pin fix works; the demuxer accepts the ss-stream.**
`12-c.md`: "real probe built demuxer, _dtsBase pinned=true" at both seeks (L142, L239),
probe `{match:true, ts_packet_size:188}`. parseChunks #1..#12 all `sync0x47=true`,
every `consumed=` value non-zero (min 31772). No `consumed=0`, no parse rejection.

**V2 — Data flow is healthy end to end (kills the earlier "stall at 288KB").**
Loader read log climbs continuously to read #620 / 13.8MB (L106). The prior "feed
dies at 288KB" was an artifact of the old parseChunks log cap (#5 then every #25),
NOT a real stall. FALSIFIES my round-1/2 transport-stall diagnosis.

**V3 — `onMediaInfo` never fired.** 0 occurrences of the wrapped `demuxer.onMediaInfo`
line in `12-c.md`, while the setup wrapper demonstrably ran (probe lines present).
The app gates its entire seek-ready path on the MEDIA_INFO event
(`useMSEPlayer.ts` L3009/3123/3187: "for initializing_player (remux), MEDIA_INFO IS
the ready signal"). No MEDIA_INFO ⇒ deferred-play never resolves ⇒ buffered EMPTY.

**V4 — MEDIA_INFO event chain requires `mi.isComplete()`.**
`transmuxing-controller.js`: MEDIA_INFO emitted only from `_reportSegmentMediaInfo`
(L26), called only from `_onMediaInfo` (L355), invoked only by demuxer at
ts-demuxer L1253 / L1944 — both guarded `if (mi.isComplete())`.

**V5 — `isComplete()` needs BOTH tracks when both are present.** `media-info.js`:
returns true only when mimeType!=null AND audioInfoComplete AND videoInfoComplete.
A track counts "complete" only if its `has*=true` branch has codec+params set.
`has_video_`/`has_audio_` are set at **PMT/PES parse time** (ts-demuxer L908/L911),
i.e. BEFORE metadata resolves. So once the PMT advertises both a video and an audio
PID, `isComplete()` cannot return true until BOTH init segments dispatch.

**V6 — The ss-stream PMT advertises both tracks.** `12-t.md` seek ffmpeg output:
`Output #0, mpegts` → `Stream #0:0 Video h264 1920x1080` AND
`Stream #0:1 Audio aac(LC) 48000Hz 5.1` (L6140/6147). Both real, both mpegts.js-
supported. So `has_video_` AND `has_audio_` will both latch true ⇒ both-track gate active.

**V7 — Instrumentation is correctly wired (my wrap is effective).**
`_setupTSDemuxerRemuxer` sets `demuxer.onMediaInfo` (ctrl L323) and, via
`remuxer.bindDataSource(demuxer)` (ctrl L333), `demuxer.onTrackMetadata`
(mp4-remuxer L85). My wrapper runs AFTER originalSetup, so wrapping both post-setup
captures the live bindings. parseChunks guard at ts-demuxer L253 requires
onError+onMediaInfo+onTrackMetadata+onDataAvailable set, all satisfied.

---

## CORRECTED mechanism (supersedes prior turns)

Init/media-segment append is **per-track and independent** — `_onTrackMetadataReceived`
(mp4-remuxer L175) fires `_onInitSegment` the instant EACH track's metadata resolves;
there is NO both-track gate on the append path itself. My earlier phrasing "onMediaInfo
never fires → nothing appends" conflated two gates. The precise chain:

  per-track metadata → onTrackMetadata → remuxer init segment (independent, fine)
  BOTH tracks' metadata → mi.isComplete() → onMediaInfo → MEDIA_INFO event → app seek-ready

The APP specifically waits on MEDIA_INFO (the both-track gate), so if exactly ONE
track's metadata never resolves, the app never becomes seek-ready even though the
other track's init segment was produced. That is the operative failure.

---

## OPEN — the one unproven link (needs 13-c.md)

**Which track fails to resolve?** VERIFIED that the gate needs both; NOT yet verified
which of video/audio never dispatches its metadata. Candidates, each with a distinct fix:
- audio only missing → eac3→aac(LC) init/ADTS framing not reaching demuxer (cf. known
  5.1 PCE issue; AAC in mp2t needs correct ADTS/LOAS or the AudioSpecificConfig path).
- video only missing → h264_qsv SPS/PPS not in-band (needs `-bsf:v h264_mp4toannexb`
  or forced IDR/repeat-headers).
- neither → PMT PID/stream_type mismatch in demuxer.

The added `onTrackMetadata: type=video|audio ...` instrument names it directly in 13-c.md.

## Secondary (VERIFIED, user-observed green-bar loss)
Each seek does a full player recreate (`recreating player from /remux?ss=...`,
2 recreates in 12-c.md), which resets the SourceBuffer and discards prior buffered
ranges — matches the "prebuffer deleted on every seek" report. Inherent to the
recreate-per-seek design; secondary to restoring playback.
