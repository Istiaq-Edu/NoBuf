# Backend research: /remux audio plumbing (audio_idx override)

Audited directly from `app/src-tauri/src/server.rs` @ working tree (dev, post TS-HEVC-recovery), 2026-07-29.

## 1. Current audio track resolution

- `StreamProbeResult` struct — server.rs:2462-2472. Carries ONE `audio_stream_idx: i32`
  (default **1**, historical fallback when ffprobe fails entirely — :2476-2481).
- `parse_probe_json()` — :2499-2549. Iterates ffprobe `-show_streams` JSON and keeps the
  **FIRST** real audio stream: `codec_type=="audio" && !found_audio && channels > 0 &&
  codec_name != "id3"` (:2525). Skips Telegram's sparse timed-ID3 track.
  **Language tags are NOT captured** (`tags:language` never read); **only one stream kept**
  — the full `streams` array is discarded after the scan.
- Probe execution: `run_stream_probe()` :2555+; called by the /remux handler at :2698
  (fast 5MB/5s budget) with a guarded full re-probe (50MB/50s) at :2714 only when
  video/audio missing. Merge logic :2719-2733.
- Unpack into handler locals at :2742-2743 (`let audio_stream_idx: i32 = probe.audio_stream_idx`).
  Everything downstream consumes this ONE variable.

## 2. /remux handler + query params

- Handler `remux_ts_to_mp4` — `#[get("/remux/{folder_id}/{message_id}")]` :2601-2609.
  Query type: `web::Query<StreamQuery>`.
- `StreamQuery` — :319-367 (serde Deserialize). Existing fields: `token`, `cached_only`,
  `duration`, `source_id`, `max_bytes`, `ss` (ffmpeg -ss seek), `start_byte` (byte-forward
  remux seek), `hevc_ok` (client HEVC capability hint).
- **Injection point for `audio_idx: Option<i32>`**: add field to StreamQuery; override at
  the unpack site (:2742-2743) AFTER probing:
  `if let Some(req_idx) = query.audio_idx { validate; audio_stream_idx = req_idx }`.
  Validation must confirm req_idx is a real audio stream → requires the probe to keep ALL
  audio streams (see §5). On invalid → keep probe primary + `log::warn!` (never 500).

## 3. Every ffmpeg site consuming audio_stream_idx

| Site | Lines | Map | Propagates automatically? |
|---|---|---|---|
| Strategy A: cached file → disk remux | :2847-2881 (`-map 0:{audio_stream_idx}` :2870) | yes | ✅ consumes the handler local |
| Strategy B: uncached streaming fMP4 | ~:3051 (same `-map` pair) | yes | ✅ same local |
| Background disk remux job | ~:3272 (`bg_aud_idx = audio_stream_idx`) | yes | ✅ copies the local |
| Test arg builders (pure fns) | :5789-5807 (`build_strategy_a_args`), :5811-5833 (`build_background_remux_args`) | yes | take `audio_stream_idx` param — extend tests with override cases |

Single-variable flow confirmed: overriding at :2742 covers ALL invocation sites.
No implicit-default ffmpeg mapping (every site uses explicit `-map`).

## 4. CRITICAL: remux disk-cache collision

- Cache path — :2617-2624:
  `remux_dir.join(format!("{}_{}.mp4", folder_id_str, message_id))` + `.mp4.tmp` sibling.
  **NOT keyed by audio track.** Phase-1 serve-from-cache (:2627-2634) would serve track-A
  output for a track-B request → silent wrong audio.
- Also stateful: `data.probed_durations` (:2763) is per-message — duration doesn't change
  with track, OK.
- **Required change**: key BOTH `remux_path` and `remux_tmp` by the EFFECTIVE audio idx,
  e.g. `format!("{}_{}_a{}.mp4", folder, msg, effective_audio_idx)`.
  Pitfall: the effective idx is known only AFTER the probe, but the Phase-1 cache check
  (:2627) runs BEFORE the probe. Options: (a) move cache check after probe when
  `audio_idx` param present (adds probe latency to warm hits — acceptable: only for
  non-default tracks), or (b) when `audio_idx` is present use it directly in the key
  (validated later); default requests (no param) keep the legacy un-suffixed key so
  existing caches stay valid. **(b) recommended**: zero cost for the default path,
  legacy cache files remain hits.
- Cleanup: any cache-eviction/size logic that globs `{}_{}.mp4` must also match the new
  suffixed names (grep remux_dir usages during impl).

## 5. Track listing (for the UI menu)

- No existing endpoint exposes ffprobe streams to the client (checked handlers; /fmp4/metadata
  returns duration only).
- The /remux probe already fetches full `-show_streams` JSON and throws away everything but
  the first audio stream. Two-part design:
  1. Extend `StreamProbeResult` with `audio_streams: Vec<AudioStreamInfo { index, codec,
     channels, channel_layout, language, title, is_default }>` — populate in the same
     parse_probe_json pass (read `tags.language`, `tags.title`, `disposition.default`).
  2. New endpoint `GET /tracks/{folder}/{msg}?token=` running the same fast-probe
     (5MB/5s, reuse `run_stream_probe`) and returning the audio_streams JSON. Client calls
     it lazily when the menu opens (or at player init for menu visibility).
  Cache probe results in a `HashMap<i32, Vec<AudioStreamInfo>>` beside `probed_durations`
  to avoid re-probing on every menu open.

## 6. Edge cases (backend)

- `audio_idx` out of range / not audio / the id3 stream → keep probe primary, warn log.
- Zero real audio streams (found_audio=false): today falls back to idx default 1 (:2756);
  with an explicit audio_idx the same guard applies — never 500.
- `-sn` stays (subtitles remain excluded from remux output — future-work §1 is separate).
- The AAC PCE layout filter (:2737-2741, AAC_LAYOUT_FILTER at encode sites) applies to ANY
  selected track — non-default tracks can also have 5.1(side) layouts. No change needed;
  just don't bypass the filter.
- hevc_ok + audio_idx interact only via URL construction on the client; backend treats
  them independently.
