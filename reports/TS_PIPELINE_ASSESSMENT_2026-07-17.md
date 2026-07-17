# TS (MPEG-TS) Pipeline Assessment — NoBuf (Telegram-Drive)
## CROSS-VALIDATED — 2026-07-17

**Method:** Every claim re-derived from source and verified by execution (grep/sed). 
mpegts.js API verified against official docs (github.com/xqq/mpegts.js).
Every finding tagged VERIFIED / FALSIFIED / INCONCLUSIVE with file:line evidence.

> **Cross-validation note:** The initial assessment had 3 "CRITICAL" findings. 
> Cross-validation **FALSIFIED Finding #3's original claim** — the timed_id3 detection 
> IS broken, but it does NOT break playback (the /stream path handles rewriting correctly).
> Finding #1's impact was **narrowed** — it only affects fallback /remux paths, not primary playback.
> Finding #2 remains fully VERIFIED.

---

## Pipeline Architecture (VERIFIED)

### Active TS Playback Path
```
FormatDetector.ts:26-36  →  format='ts' (0x47 sync at offsets 0/188/376)
         ↓
useMSEPlayer.ts:2259    →  format === 'ts'
         ↓
GET /fmp4/metadata       →  checks has_timed_id3  ← ALWAYS FALSE (see Finding #3)
         ↓
initTransmuxerPlayer (useMSEPlayer.ts:2350)
         ↓
_initMpegtsPlayer (useMSEPlayer.ts:2524)
         ↓
mpegts.js createPlayer({type:'mpegts'}) reads raw /stream bytes
         ↓
/stream handler (server.rs:557) serves TS with PMT rewriting (rewrite_ts_stream_in_buf)
```

### Fallback Paths (only triggered on failure)
- mpegts.js FATAL error → `/remux` → native `<video>` (useMSEPlayer.ts:2800-2806)
- initTransmuxerPlayer failure → `/remux` → native `<video>` (useMSEPlayer.ts:5133-5139)

### Dead Code (VERIFIED — never reachable)
| Component | Evidence | Impact |
|-----------|----------|--------|
| MuxJsTsTransmuxer | `grep "new MuxJsTsTransmuxer" src/` → 0 matches | 874 lines dead |
| fMP4 seek path (useMSEPlayer.ts:6531) | See Finding #5 — unreachable | Dead code |
| HLS manifest code (hls/manifest.rs) | No `/hls/` routes in server.rs; no `/hls/` calls in frontend | ~2900 lines dead |

---

## FINDINGS (Cross-Validated)

### 🟡 Finding #1: /remux primary commands hardcode `-map 0:a:0`, ignoring ffprobe indices

**VERIFIED** — `server.rs:2165, 2270` (hardcoded) vs `server.rs:2380-2381` (uses indices)

**Evidence:**
```
server.rs:2165  "-map", "0:v:0", "-map", "0:a:0",          ← Strategy A (cached)
server.rs:2270  "-map", "0:v:0", "-map", "0:a:0",          ← Strategy B (piped)
server.rs:2380  "-map", &format!("0:{}", bg_vid_idx),        ← Background remux (CORRECT)
server.rs:2381  "-map", &format!("0:{}", bg_aud_idx),       ← Background remux (CORRECT)
```

`video_stream_idx`/`audio_stream_idx` assigned at `:2114/:2119`, used ONLY at `:2367/:2368` (background remux clone).

**IMPACT REVISED (narrower than initial claim):**
- The /remux endpoint is ONLY reached via fallback paths (mpegts.js FATAL error, or initTransmuxerPlayer failure) — NOT via the timed_id3 detection path (which is dead, see Finding #3).
- When /remux IS reached AND the TS file has an id3 metadata stream (stream_type 0x15) classified as audio by ffmpeg, `0:a:0` may select the id3 stream instead of the real audio → AAC muxing error.
- ffprobe at `:2118` explicitly skips id3: `codec_name != "id3"` — proving ffmpeg classifies these as audio type.
- BUT: whether `0:a:0` selects the id3 stream depends on stream ordering (is id3 the first audio stream?). **INCONCLUSIVE** without actual file inspection.

**Classification:** Real code discrepancy / latent bug. Only affects /remux fallback, not primary playback.

---

### 🔴 Finding #2: Background remux outputs MP4 but serving code labels it `video/mp2t`

**VERIFIED** — `server.rs:2386-2387` vs `server.rs:2043`

**Evidence:**
```rust
// server.rs:2033 — SAME path for all strategies
let remux_path = remux_dir.join(format!("{}_{}.mp4", folder_id_str, message_id));

// server.rs:2037-2043 — serves cached file ALWAYS as video/mp2t
if remux_path.exists() {
    return serve_local_file(&req, &remux_path, file_size, "video/mp2t");
}

// server.rs:2168 — Strategy A outputs MPEG-TS  → video/mp2t is CORRECT
"-f", "mpegts", "-mpegts_flags", "resend_headers",

// server.rs:2287 — Strategy B piped outputs MPEG-TS  → correct for stream
"-f", "mpegts", "-mpegts_flags", "resend_headers",

// server.rs:2386-2387 — Background remux outputs MP4  → video/mp2t is WRONG
"-f", "mp4", "-movflags", "+faststart",
```

`bg_remux_path = remux_path.clone()` (`server.rs:2366`) — confirms same path.

**Impact:** On second playback of a file that went through Strategy B:
1. First play: Strategy B (piped MPEG-TS to mpegts.js) + background remux (MP4 cache at remux_path)
2. Second play: `remux_path.exists()` = true → serves MP4 file as `video/mp2t`
3. mpegts.js parses raw bytes looking for 0x47 sync bytes — MP4 starts with `ftyp` box (0x00...) → sync mismatch → `MEDIA_FORMAT_ERROR`

**Note:** The background remux also uses `-c:a copy -bsf:a aac_adtstoasc` (server.rs:2384-2385) while primary uses `-c:a aac -b:a 192k` — different audio encoding AND different container format.

---

### 🟢 Finding #3 (REVISED): timed_id3 detection (`has_timed_id3`) is broken — but playback works anyway

**ORIGINAL CLAIM:** FALSIFIED. Initial assessment claimed this could cause decode crashes. Cross-validation proves it cannot.

**VERIFIED FACTS:**
1. `has_timed_id3` (`server.rs:3987`): `!cache_mgr.get_stripped_pids(message_id).is_empty()`
2. `cache_stripped_pids` is called in EXACTLY ONE place: `hls/manifest.rs:2148` (inside `ensure_init_prefix`)
3. `ensure_init_prefix` (WITH-rewrite) is called from: `hls/manifest.rs:656, :1084, :1120` — ALL in the HLS path
4. `server.rs` only calls `ensure_init_prefix_NO_REWRITE` (`server.rs:101`) — does NOT populate stripped_pids
5. Frontend NEVER calls `/hls/` endpoints: `grep -rn "/hls/" src/` → 0 matches
6. Backend has NO `/hls/` routes registered: `grep "/hls/" server.rs` → 0 matches

**Conclusion:** `stripped_pids` is NEVER populated → `has_timed_id3` ALWAYS returns `false` → frontend NEVER routes to /remux via the timed_id3 detection path.

**BUT playback still works** because the /stream path handles timed_id3 correctly via `rewrite_ts_stream_in_buf` → `rewrite_pmt_stream_types` (`hls/manifest.rs:1598`):

- `REWRITE_STREAM_TYPES = [(0x15, 0x11)]` (`hls/manifest.rs:48`)
- **Case A** (file has real audio 0x0F + 0x15 metadata): 0x15 entry STRIPPED from PMT, PID nulled (0x1FFF) → mpegts.js sees only real audio ✅
- **Case B** (file has ONLY 0x15, no other audio): 0x15 REWRITTEN to 0x11 → mpegts.js uses `parseLOASAACPayload` (`ts-demuxer.ts:624-625`) ✅

mpegts.js stream_type support VERIFIED:
- `kADTSAAC = 0x0F` (`pat-pmt-pes.ts:16`) → `parseADTSAACPayload` (`ts-demuxer.ts:621`)
- `kLOASAAC = 0x11` (`pat-pmt-pes.ts:17`) → `parseLOASAACPayload` (`ts-demuxer.ts:624`)
- `kMetadata = 0x15` (`pat-pmt-pes.ts:20`) → kMetadata case (`ts-demuxer.ts:633`) — drops audio

**BUT:** `rewrite_ts_stream_in_buf` does NOT call `cache_stripped_pids` after rewriting (server.rs:216-220 only logs, doesn't cache). This is WHY stripped_pids is never populated from the /stream path.

**Net impact:** The broken `has_timed_id3` detection does NOT break playback. It just means the /remux fallback for timed_id3 files is dead — but /stream handles those files correctly anyway. The /remux path is only reached via mpegts.js failure fallbacks.

---

### 🟢 Finding #4: MediaDataSource.duration unit mismatch (seconds vs ms) — NO-OP for TS

**VERIFIED as no-op.** mpegts.js docs say duration is in milliseconds. Code passes seconds (`useMSEPlayer.ts:2644, 2655`).

**BUT:** `transmuxing-controller.js:289-292` sets `this._demuxer.overridedDuration = mds.duration`. The `overridedDuration` setter exists ONLY on `FlvDemuxer` (`flv-demuxer.js:238`), NOT on `TSDemuxer` (`grep "overridedDuration" ts-demuxer.ts` → 0 matches). TSDemuxer calculates duration from PTS.

**Impact:** NONE for TS. Latent bug if FLV path is ever added.

---

### 🟡 Finding #5: MuxJsTsTransmuxer + fMP4 seek path are dead code

**VERIFIED.**

**MuxJsTsTransmuxer:** Imported at `useMSEPlayer.ts:8`, ref typed at `:957`, but `grep -rn "new MuxJsTsTransmuxer" src/` → 0 matches. Marked `@deprecated` (`MuxJsTsTransmuxer.ts:212`).

**fMP4 seek path** (`useMSEPlayer.ts:6531`): `if (formatRef.current === 'ts' && fmp4PipelineActiveRef.current && !transmuxerRef.current)` — UNREACHABLE because:
1. `seekTo` exits at `:6343` if `useNative=true`
2. If mpegts.js succeeded: `mpegtsPlayerRef.current` is set (`:2687`) → seek returns at `:6522` (inside the mpegtsPlayerRef block) before reaching `:6531`
3. If mpegts.js failed: `useNative=true` (`:5139` or `:2806`) → seek returns at `:6343`
4. `fmp4PipelineActiveRef=true` is set at `:3030` (after MEDIA_INFO), which is AFTER `mpegtsPlayerRef` is set at `:2687`

No code path can reach `:6531` with `fmp4PipelineActiveRef=true` AND `mpegtsPlayerRef=null` AND `useNative=false`.

---

### 🟡 Finding #6: /fmp4/metadata downloads tail synchronously + `.unwrap()` panic risk

**VERIFIED** — `server.rs:3776`

```rust
let _permit = data.download_semaphore.acquire().await.unwrap();
```

If the semaphore is closed, `.unwrap()` panics. The tail download (512KB from Telegram) blocks the metadata response. Frontend awaits metadata at `useMSEPlayer.ts:2290` for timed_id3 detection — but since has_timed_id3 is always false (Finding #3), this await is wasted latency.

---

### 🟢 Finding #7: /stream Content-Type from Telegram API

**VERIFIED** — `server.rs:521-529, 571`. `mime_type_from_media` returns `d.mime_type()` from Telegram. mpegts.js ignores Content-Type (parses raw bytes), so no impact on mpegts.js. Native `<video>` fallback could be affected.

---

### 🟢 Finding #8: Duration estimate uses fixed 4 Mbps bitrate

**VERIFIED** — `useMSEPlayer.ts:2642`. `ESTIMATED_BITRATE = 4_000_000`. Overestimates duration for low-bitrate files, underestimates for high-bitrate. Updated from /fmp4/metadata when it returns (`:2918`).

---

### 🟢 Finding #9: FetchStreamLoader.abort() patch is dead code for TS

**VERIFIED** — `useMSEPlayer.ts:2561-2572` patches `FetchStreamLoader.prototype.abort`, but `customLoader: ChunkedFetchLoader` is active (verified: `io-controller.js:240-241`). ChunkedFetchLoader has its own `abort()` (`MpegtsChunkLoader.ts:105`). The patch on FetchStreamLoader is harmless dead code.

---

### 🟢 Finding #10: mpegts.js API fully compatible

**VERIFIED** against [official docs](https://github.com/xqq/mpegts.js/blob/master/docs/api.md). All config options valid. Version 1.8.0. `customLoader` is undocumented but real (`config.js:60`, `io-controller.js:240-241`).

---

## HONEST ASSESSMENT: What's Actually Breaking TS Playback?

**The bugs found are real but do NOT explain primary TS playback failure.**

Based on code analysis:
- **Primary TS path** (`/stream` → mpegts.js) should work for most TS files. The PMT rewriting in `rewrite_ts_stream_in_buf` + `rewrite_pmt_stream_types` correctly handles both timed_id3 and LOAS-AAC cases.
- **Finding #2** (MP4 served as MPEG-TS) only affects SECOND playback of files that went through /remux Strategy B. First playback works.
- **Finding #1** (hardcoded -map) only affects /remux fallback, which is rarely triggered.
- **Finding #3** (broken timed_id3 detection) doesn't break anything — /stream handles it.

**What I CANNOT determine from code alone:**
1. Whether `rewrite_ts_stream_in_buf` actually fires correctly on every /stream chunk — it depends on `init_prefix` being available (`server.rs:94-114`). If init_prefix extraction fails, raw TS is served without rewriting → mpegts.js sees 0x15 → drops audio. Need runtime logs to verify.
2. Whether `ensure_init_prefix_no_rewrite` (`server.rs:101`) succeeds on real Telegram TS files — depends on `detect_ts_packet_size` succeeding.
3. Whether there's a race condition between the first /stream request and init_prefix creation.
4. Whether the actual failure is a specific codec/container variant not covered by the rewrite logic.

**To definitively diagnose the failure, I need:**
- Runtime console logs from a failed TS playback (look for `[MPEGTS]`, `[STREAM-TS]`, `sync_byte`, `PIPELINE_ERROR_DECODE`)
- The specific TS file characteristics (codec, stream_type layout, whether it has timed_id3)
- Whether the failure is "no video", "no audio", "crash", or "won't start"

---

## Recommended Fixes (Priority Order)

### Fix 1 (Finding #2): Align background remux format with serving code
```rust
// server.rs:2386-2387 — REPLACE:
"-f", "mp4", "-movflags", "+faststart",
// WITH:
"-f", "mpegts", "-mpegts_flags", "resend_headers",
```
This ensures the cached file is MPEG-TS (matching Strategy A and the `video/mp2t` Content-Type).

### Fix 2 (Finding #1): Use ffprobe indices in primary remux commands
```rust
// server.rs:2165 and :2270 — REPLACE hardcoded "0:v:0", "0:a:0":
"-map", &format!("0:{}", video_stream_idx),
"-map", &format!("0:{}", audio_stream_idx),
```

### Fix 3 (Finding #6): Replace `.unwrap()` on semaphore acquire
```rust
// server.rs:3776 — REPLACE:
let _permit = data.download_semaphore.acquire().await.unwrap();
// WITH:
let _permit = match data.download_semaphore.acquire().await {
    Ok(p) => p,
    Err(_) => return HttpResponse::InternalServerError().body("Download semaphore closed"),
};
```

### Fix 4 (Finding #3, optional): Cache stripped_pids from /stream path
In `rewrite_ts_stream_in_buf`, after `rewrite_pmt_stream_types` returns stripped PIDs, call `cache_mgr.cache_stripped_pids(message_id, stripped_inline)`. This would make `has_timed_id3` work, enabling the /remux fallback. But since /stream handles timed_id3 correctly, this is LOW priority.

---

## Verification Evidence

- mpegts.js API: https://github.com/xqq/mpegts.js/blob/master/docs/api.md
- mpegts.js source: `node_modules/mpegts.js/src/io/io-controller.js:240-241` (customLoader), `node_modules/mpegts.js/src/core/transmuxing-controller.js:289-292` (overridedDuration)
- `overridedDuration` only on FlvDemuxer: `node_modules/mpegts.js/src/demux/flv-demuxer.js:238`; `grep "overridedDuration" ts-demuxer.ts` → 0
- StreamType enum: `node_modules/mpegts.js/src/demux/pat-pmt-pes.ts:12-20` (kADTSAAC=0x0F, kLOASAAC=0x11, kMetadata=0x15)
- MuxJsTsTransmuxer dead: `grep -rn "new MuxJsTsTransmuxer" src/` → 0 matches
- HLS dead: `grep -rn "/hls/" src/` → 0 matches; `grep "/hls/" server.rs` → 0 matches
- All line numbers current as of commit `57f279f` (HEAD)
