# HEVC Codebase Research: Video Playback Tiers in Telegram-Drive

**Generated from source reading — all citations are file:line references.**

---

## 1. Playback Tier Overview

The app has **five playback tiers**, all orchestrated by `useMSEPlayer.ts` and rendered by `FastStreamPlayer.tsx`. The tier is selected during `initMP4Box()` after format detection from the first 512 KB of bytes.

```
streamUrl (localhost:14201/stream/{folderId}/{messageId}?token=…)
    │
    ▼
initMP4Box() — detectFormat(data, file.name)
    │
    ├─ format === 'mp4'   → Tier 1: MP4Box.js + MSE SourceBuffer
    ├─ format === 'ts'    → Tier 2a: mpegts.js (fMP4 pipeline) OR
    │                       Tier 2b: /remux → mpegts.js  (timed_id3 TS)
    ├─ format === 'mkv'
    │   ├─ codec === 'avc'  → Tier 3a: MediabunnyTransmuxer (client-side fMP4)
    │   ├─ codec === 'hevc' → Tier 3b: /remux → mpegts.js
    │   └─ codec other      → Tier 4: native <video>
    ├─ format === 'webm'  → Tier 4: native <video>
    └─ format === 'unknown' → Tier 4: native <video>
```

---

## 2. Tier 1 — MP4 via MP4Box.js + MSE

**File:** `app/src/hooks/useMSEPlayer.ts`

### Trigger condition
- `detectFormat()` returns `'mp4'` (useMSEPlayer.ts:2441–2443)
- Falls through to `// MP4 format — proceed with MP4Box.js` (useMSEPlayer.ts:2692–2693)

### Byte flow
1. HEAD `localhost:14201/stream/{folderId}/{messageId}` → get `Content-Length` (useMSEPlayer.ts:2398–2405)
2. Range `bytes=0-524287` (512 KB first chunk) (useMSEPlayer.ts:2408–2411)
3. If moov not in first chunk → `fetchMoovFromTail()` fetches moov from file tail (useMSEPlayer.ts:2757)
4. Subsequent sequential Range requests via `downloadLoop` (FRAGMENT_SIZES: 512 KB → 1 MB → 2 MB → 4 MB → 8 MB) (useMSEPlayer.ts:816–822)

### Playback mechanism
- `MediaSource` blob URL set as `video.src` (useMSEPlayer.ts:1604–1610, FastStreamPlayer.tsx:858–862)
- Separate video and audio `SourceBuffer` created via `MediaSource.addSourceBuffer()` (useMSEPlayer.ts:6513–6568)
- `mp4box.setSegmentOptions(trackId, …, { nbSamples: 25 })` → 25-sample segments (~0.8 s) (useMSEPlayer.ts:6584–6589)

### HEVC in MP4 (the failing case)
At `onMP4BoxReady` (useMSEPlayer.ts:6430), after mp4box parses the moov:

```typescript
// useMSEPlayer.ts:6509–6544
const videoCodec = state.current.videoTracks[0].codec; // e.g. "hvc1.1.6.L120.90"
const mimeType = `video/mp4; codecs="${videoCodec}"`;
if (MediaSource.isTypeSupported(mimeType)) {
  // create SourceBuffer — succeeds for H.264
} else {
  // MSE doesn't support this codec
  const canPlay = videoRef.current?.canPlayType(mimeType) ?? '';
  console.warn(`[MSE] Video codec NOT supported by MSE: ${mimeType}`);  // line 6523
  if (canPlay === 'probably' || canPlay === 'maybe') {
    setUseNative(true);   // fall back to native <video>
  } else {
    // Neither MSE nor native supports it
    const isHevc = videoCodec.startsWith('hvc1') || videoCodec.startsWith('hev1');
    const msg = `This video uses HEVC (H.265) codec which is not supported…` +
      ' On Windows, install "HEVC Video Extensions" from the Microsoft Store…';
    setUnsupportedCodec(msg);
    setError(msg);        // line 6543 — hard error, NO fallback to /remux
    return;
  }
}
```

**Critical finding:** For an MP4 container with HEVC video (`hvc1.*`), the code path is:
1. `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')` → `false` on WebView2 without HEVC extension
2. `canPlayType(…)` → `''` (empty = cannot play)
3. **Hard error** — `setUnsupportedCodec()` + `setError()` — **no /remux fallback is attempted**

The `/remux` tier is **never triggered for MP4-container HEVC**. It is only triggered for MKV-container HEVC and timed_id3 TS files.

### `MediaSource.isTypeSupported` call sites
- useMSEPlayer.ts:6515 — `video/mp4; codecs="${videoCodec}"` (video track)
- useMSEPlayer.ts:6554 — `audio/mp4; codecs="${audioCodec}"` (audio track)

### `canPlayType` call sites
- useMSEPlayer.ts:6522 — `videoRef.current?.canPlayType(mimeType)` — only called when MSE rejects the codec

### Prebuffer / cold-start
- `computeColdStartThreshold()` computes 2–30 MB based on bitrate (useMSEPlayer.ts:911–943)
- Cold-start overlay shown until first chunk lands (useMSEPlayer.ts:2697–2699)
- Proactive prebuffer (`cmd_report_playback_position`) runs on 10 s interval (useMSEPlayer.ts:1243–1244)
- Sliding window: 30 s behind, 180 s forward target, 60 s minimum (useMSEPlayer.ts:571–573)

---

## 3. Tier 2a — MPEG-TS via mpegts.js (fMP4 pipeline)

**File:** `app/src/hooks/useMSEPlayer.ts`

### Trigger condition
- `detectFormat()` returns `'ts'` (useMSEPlayer.ts:2499)
- Backend `/fmp4/metadata` does **not** report `has_timed_id3: true` (useMSEPlayer.ts:2531)

### Byte flow
1. Fetch `/fmp4/metadata/{folderId}/{messageId}?token=…&file_size=…` (useMSEPlayer.ts:2513)
2. mpegts.js reads from `localhost:14201/stream/{folderId}/{messageId}` via HTTP Range requests
3. Shadow cache (`StreamShadowCache`, 300 MB) intercepts reads (useMSEPlayer.ts:2583–2587)
4. Cold-start gate: waits for `dynamicThreshold` bytes (2–30 MB) before allowing play (useMSEPlayer.ts:2599–2604)

### Playback mechanism
- mpegts.js creates its own `MediaSource` and calls `attachMediaElement(video)` internally
- `setMseUrl(null)` before init so FastStreamPlayer doesn't overwrite `video.src` (useMSEPlayer.ts:2597)
- `_initMpegtsPlayer()` called (useMSEPlayer.ts:2603)
- Seeking: byte-offset keyframe seeking via `TSByteOffsetScanner` + `/fmp4/keyframe-at/` endpoint

### HEVC in TS
- mpegts.js demuxes TS natively; HEVC in TS (`hvc1.2` / Main10) is **rejected by MSE** even with HEVC extension
- This is why timed_id3 TS with HEVC routes to /remux (see Tier 2b)

---

## 4. Tier 2b — timed_id3 TS via /remux → mpegts.js

**File:** `app/src/hooks/useMSEPlayer.ts:2531–2576`

### Trigger condition
- `detectFormat()` returns `'ts'`
- `/fmp4/metadata` returns `has_timed_id3: true` (useMSEPlayer.ts:2531)

### Byte flow
1. Frontend builds `remuxUrl = ${baseUrl}/remux/${folderId}/${messageId}?token=…` (useMSEPlayer.ts:2533)
2. Sets `needsRemuxSeekRef.current = true` (useMSEPlayer.ts:2547) — seeks go through `/remux?ss=` or `?start_byte=`
3. mpegts.js reads from `/remux/…` instead of `/stream/…`

### Playback mechanism
- Same mpegts.js MSE path as Tier 2a, but input URL is `/remux/` not `/stream/`
- `setMseUrl(null)` (useMSEPlayer.ts:2564)
- Seeking: byte-forward (`start_byte=`) preferred over `-ss` for uncached data (useMSEPlayer.ts:2536–2548, `buildRemuxSeekUrl()` at useMSEPlayer.ts:64–88)

---

## 5. Tier 3a — MKV H.264 via MediabunnyTransmuxer (client-side fMP4)

**File:** `app/src/hooks/useMSEPlayer.ts:2632–2638`

### Trigger condition
- `detectFormat()` returns `'mkv'`
- `detectMkvVideoCodec(data)` returns `'avc'` (useMSEPlayer.ts:2632)

### Byte flow
- 6 MB initial prefetch (`MKV_INITIAL_PREFETCH`) (useMSEPlayer.ts:848)
- `_initMkvTransmuxerPlayer()` uses `MediabunnyTransmuxer` (client-side Matroska demuxer)
- Subsequent data via `TauriStreamSource` (cached Range requests to `/stream/`)
- MKV disk warmer: sequential 0→EOF walk over `/stream/` to fill green bar (useMSEPlayer.ts:1292–1297)

### Playback mechanism
- `MediaSource` blob URL, `SourceBuffer` fed by transmuxer segments
- Seeking: `transmuxer.seekTo(time, duration)` → keyframe-accurate

### HEVC in MKV (H.264 path)
- Not applicable — this path is only for `avc` codec

---

## 6. Tier 3b — MKV HEVC via /remux → mpegts.js

**File:** `app/src/hooks/useMSEPlayer.ts:2641–2681`

### Trigger condition
- `detectFormat()` returns `'mkv'`
- `detectMkvVideoCodec(data)` returns `'hevc'` (useMSEPlayer.ts:2644)
- OR `'avc'` transmuxer init failed (useMSEPlayer.ts:2638–2639)

### Byte flow
1. Frontend builds `remuxUrl = ${baseUrl}/remux/${folderId}/${messageId}?token=…` (useMSEPlayer.ts:2645)
2. Sets `needsRemuxSeekRef.current = true` (useMSEPlayer.ts:2651) — raw `/stream/` is Matroska, not TS
3. mpegts.js reads from `/remux/` endpoint
4. Seeks use `/remux?ss=<time>` (ffmpeg frame-accurate seek) — byte-forward NOT used for MKV (useMSEPlayer.ts:2648–2652)

### Playback mechanism
- Same mpegts.js MSE path
- `setMseUrl(null)` (useMSEPlayer.ts:2668)
- Cold-start overlay shown during ffprobe + ffmpeg startup (useMSEPlayer.ts:2676–2678)

---

## 7. Tier 4 — Native `<video>`

**File:** `app/src/hooks/useMSEPlayer.ts`, `app/src/components/dashboard/FastStreamPlayer.tsx`

### Trigger conditions
- `format === 'webm'` (useMSEPlayer.ts:2614–2617) — VP8/VP9/Opus plays natively in WebView2
- `format === 'unknown'` (useMSEPlayer.ts:2456–2459)
- MKV with VP8/VP9/AV1 or undetectable codec (useMSEPlayer.ts:2684–2688)
- MSE init timeout (20 s, extendable to 120 s) (useMSEPlayer.ts:1642–1665)
- mp4box.onError fires (useMSEPlayer.ts:2393)
- MP4 HEVC where `canPlayType` returns `'probably'` or `'maybe'` (useMSEPlayer.ts:6525–6529)

### Byte flow
- `video.src = playerRemuxUrl || streamUrl` (FastStreamPlayer.tsx:803, 835)
- Browser makes its own Range requests to `/stream/` or `/remux/`

### Playback mechanism
- `v.src = nativeUrl; v.autoplay = true;` (FastStreamPlayer.tsx:835–837)
- No MSE, no SourceBuffer — browser native decoder

### Prebuffer
- Does **not** use the MSE prebuffer/cold-start system
- No shadow cache, no proactive prebuffer for native path

---

## 8. The /remux Rust Endpoint

**File:** `app/src-tauri/src/server.rs:2548–3150`

### Route
```
GET /remux/{folder_id}/{message_id}?token=…[&ss=<secs>][&start_byte=<offset>][&hevc_ok=<bool>]
```
(server.rs:2548)

### ffprobe usage
- `ensure_ffprobe()` → 4-tier resolution: PATH → exe_dir → ffmpeg-sidecar → AppData (ffmpeg_util.rs:78–122)
- Fast probe: 5 MB / 5 s budget (server.rs:2640–2641)
- Full probe fallback if video or audio not found: 50 MB / 50 s (server.rs:2642–2643)
- Frame-level HDR probe when `needs_transcode` (server.rs:2738–2762)

### HEVC transcode decision (server.rs:2713–2731)
```rust
let is_10bit_plus = video_pix_fmt.contains("10le") || video_pix_fmt.contains("12le") …;
let hevc_ok = query.hevc_ok.unwrap_or(false);
let needs_transcode = match video_codec_name.as_str() {
    "h264"          => false,                          // always copy
    "hevc" | "h265" => is_10bit_plus || !hevc_ok,     // 10-bit always; 8-bit only if runtime can't decode
    ""              => false,                          // probe failed → copy
    _               => true,                           // unknown → transcode
};
```

**For 10-bit HEVC (hvc1.1.6.L120.90 = Main 10-bit):** `is_10bit_plus = true` → `needs_transcode = true` always.

### Video encoder selection (server.rs:2362–2402, `build_video_encoder_args`)
```
needs_transcode = false  →  -c:v copy
needs_transcode = true:
  QSV available + hevc input  →  -hwaccel qsv -hwaccel_output_format qsv -c:v hevc_qsv
                                  -vf vpp_qsv=format=nv12 -c:v h264_qsv -global_quality 23
  QSV available + other       →  -vf format=nv12 -c:v h264_qsv -global_quality 23
  QSV unavailable             →  -c:v libx264 -preset veryfast -pix_fmt yuv420p
```

### Full ffmpeg command (Strategy B — streaming, not cached) (server.rs:2940–3031)
```
ffmpeg -hide_banner -loglevel warning
  [-ss <seek_secs>]                    # Mode B only (cached/MKV seeks)
  [QSV pre-input args]
  -fflags +genpts+discardcorrupt
  -avoid_negative_ts make_zero
  -i <input_source | pipe:0>           # pipe:0 for byte-forward Mode A
  -map 0:<video_stream_idx>
  -map 0:<audio_stream_idx>
  -sn
  [-c:v copy | -c:v h264_qsv … | -c:v libx264 …]
  -c:a aac -b:a 192k -af <audio_filter>
  [-copyts -start_at_zero]             # when seeking
  [-output_ts_offset <ss_secs>]        # byte-forward only
  -max_interleave_delta 0
  -f mpegts -mpegts_flags resend_headers
  -                                    # stdout pipe
```

**Output container: MPEG-TS** (`-f mpegts`), NOT MP4. Content-Type: `video/mp2t`.

### Strategy A vs B (server.rs:2769–2882 vs 2882–3150)
- **Strategy A (cached):** File fully cached → remux to disk as `.mp4.tmp` → rename → serve with byte-range. Waits for ffmpeg to complete. Output: `video/mp2t` served from disk.
- **Strategy B (streaming):** File NOT cached → stream piped MPEG-TS immediately. `moov` has `duration=0` (live). Background disk remux starts in parallel for next play.

### Seek support
- **`?ss=<secs>`** (Mode B): `-ss` before `-i` — frame-accurate, works on cached/seekable input
- **`?start_byte=<offset>&ss=<secs>`** (Mode A): byte-forward stdin feeder — no ffmpeg `-ss`, reads sequentially from TS-aligned offset. Used for uncached timed_id3 TS (server.rs:2921–2933, 3063–3143)
- MKV seeks always use `?ss=` (Mode B) — byte-forward not applicable to Matroska

### Stream-cache / prebuffer interaction
- `/remux` reads from `/stream/` internally when not cached (server.rs:2610–2612)
- `/stream/` uses the full stream-cache/coordinator system
- The shadow cache (`StreamShadowCache`) is reset for the remux URL key (useMSEPlayer.ts:2555–2556, 2657–2658)
- Proactive prebuffer is **disabled** for TS/remux paths (useMSEPlayer.ts:2864–2882)

---

## 9. ffmpeg Discovery (ffmpeg_util.rs)

**File:** `app/src-tauri/src/ffmpeg_util.rs:35–70`

4-tier resolution for both `ffmpeg` and `ffprobe`:
1. System PATH — `ffmpeg -version` probe (ffmpeg_util.rs:37–40)
2. Executable directory (sidecar pattern) (ffmpeg_util.rs:43–46)
3. `ffmpeg-sidecar` crate's cached download path (ffmpeg_util.rs:49–54)
4. `%APPDATA%\com.istiaq.nobuf\ffmpeg\` (downloaded on first launch from gyan.dev) (ffmpeg_util.rs:57–60)

`ffprobe_from_ffmpeg()` derives ffprobe path from ffmpeg path — same directory for sidecar, bare name for PATH (ffmpeg_util.rs:298–308).

---

## 10. Frontend Tier Router

**File:** `app/src/hooks/useMSEPlayer.ts`, `app/src/components/dashboard/FastStreamPlayer.tsx`

### How the tier is decided BEFORE bytes arrive
The router does **not** use filename extension alone. Decision sequence:

1. **Format detection** from first 512 KB bytes + filename: `detectFormat(data, file.name)` (useMSEPlayer.ts:2441) — reads magic bytes
2. **MKV codec detection**: `detectMkvVideoCodec(data)` using mediabunny's Matroska demuxer on the 6 MB prefetch (useMSEPlayer.ts:2621, 866–876)
3. **Backend metadata**: `/fmp4/metadata/` for TS `has_timed_id3` flag (useMSEPlayer.ts:2513–2526)
4. **No X-Video-Codec header** — codec is detected client-side from bytes, not from a backend header

### FastStreamPlayer tier dispatch (FastStreamPlayer.tsx:797–875)
```typescript
if (playerUseNative) {
  // Tier 4: native <video>
  v.src = playerRemuxUrl || streamUrl;   // line 803, 835
} else {
  // MSE tiers (1, 2a, 2b, 3a, 3b)
  if (playerMseUrl) {
    v.src = playerMseUrl;                // line 861 — MP4Box blob URL
  } else {
    // mpegts.js mode — it sets video.src internally
  }
}
```

`playerRemuxUrl` is set by `useMSEPlayer` when routing to `/remux/` (useMSEPlayer.ts:1397–1398, 2535, 2647).
`playerUseNative` is set by `setUseNative(true)` calls.

---

## 11. Prebuffer / Cold-Start Logic

**File:** `app/src/hooks/useMSEPlayer.ts`

- `computeColdStartThreshold()` (useMSEPlayer.ts:911–943): 2–30 MB based on bitrate estimate
- `MIN_COLD_START_BUFFER_BYTES = alignChunkSize(5 MB)` fallback (useMSEPlayer.ts:894)
- `COLD_START_TIMEOUT_MS = 10000` (useMSEPlayer.ts:895)
- Cold-start applies to: MP4 (useMSEPlayer.ts:2697), TS (useMSEPlayer.ts:2599–2601), MKV/remux (useMSEPlayer.ts:2676–2678)
- **Does NOT apply to native `<video>` tier** — no cold-start gate, no shadow cache
- Sliding window eviction: 30 s behind, 180 s forward (useMSEPlayer.ts:571–573)
- `MAX_BUFFER_AHEAD_SECONDS = 30` for network data; `MAX_BUFFER_AHEAD_LOCAL_SECONDS = 120` for cached data (useMSEPlayer.ts:882–889)

---

## 12. All `MediaSource.isTypeSupported` / `canPlayType` Call Sites

| Location | String tested | Purpose |
|---|---|---|
| useMSEPlayer.ts:6515 | `video/mp4; codecs="${videoCodec}"` | Gate before creating video SourceBuffer |
| useMSEPlayer.ts:6522 | `video/mp4; codecs="${videoCodec}"` | canPlayType fallback when MSE rejects |
| useMSEPlayer.ts:6554 | `audio/mp4; codecs="${audioCodec}"` | Gate before creating audio SourceBuffer |

No other `isTypeSupported` or `canPlayType` calls found in the codebase.

---

## 13. Root Cause: Why HEVC MP4 Fails

The file `hvc1.1.6.L120.90` (10-bit x265, non-faststart MP4) fails because:

1. **Container: MP4** → routes to Tier 1 (MP4Box.js + MSE)
2. **moov at end** → `fetchMoovFromTail()` fetches it successfully
3. **Codec: `hvc1.1.6.L120.90`** → `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')` returns `false` on WebView2 without HEVC Video Extensions
4. **`canPlayType`** also returns `''` (cannot play)
5. **Hard error** at useMSEPlayer.ts:6541–6543: `setUnsupportedCodec(msg)` + `setError(msg)` + `return`
6. **No /remux fallback** — the `/remux` tier is only wired for MKV-HEVC and timed_id3 TS, not MP4-HEVC

**The fix** would require adding a `/remux` fallback branch at useMSEPlayer.ts:6530–6544 for the MP4-HEVC case, similar to the MKV-HEVC path at useMSEPlayer.ts:2644–2681.

---

*Report generated by source reading of D:\DEVELOPMENT\Telegram-Drive. All line numbers verified against actual file content.*
