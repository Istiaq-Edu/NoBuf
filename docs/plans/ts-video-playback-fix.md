# TS Video Playback Fix — Implementation Plan

## Problem Statement

.ts video files play with stuttering, frame distortion, wrong duration, broken seeking, and constant loading. .mp4 files play perfectly. The root cause: the frontend uses `MuxJsTsTransmuxer` which transmuxes TS→fMP4 client-side in JavaScript — this is fundamentally wrong for monolithic TS files streamed via byte-range requests.

## Root Cause Analysis

The `MuxJsTsTransmuxer` (mux.js) is designed for **HLS segmented TS** where each segment is a small, independent file. Telegram Drive streams **monolithic TS files** via byte-range HTTP requests. This mismatch causes:

1. **Chrome appendBuffer blocking (10-24s per segment during playback)** — mux.js produces segments that must be appended to SourceBuffer while Chrome's decode pipeline is active, causing extreme latency. The workaround is a "burst buffer" that pauses the video, resets SourceBuffer, re-appends everything, then resumes — visible as stuttering.

2. **GOP cache clearing → P-frame drops** — mux.js's GOP fusion prepends cached video GOPs (not audio), creating A/V offset. The fix is clearing the cache after each flush, but this drops ~0.07-0.33s of P-frames per flush → frame distortion.

3. **`keepOriginalTimestamps:false` normalization gymnastics** — mux.js normalizes timestamps starting near 0, requiring `setTimestampOffset(keyframeTimestamp)` on every seek. Any timing error = A/V desync.

4. **Broken seeking** — mux.js must scan the entire file to find keyframes (8-12s via `getKeyPacket`). The `TSByteOffsetScanner` helps but adds its own HTTP overhead.

5. **Wrong duration** — TS has no duration metadata. mux.js estimates from file size/bitrate, or from partial PTS scans — frequently wrong.

6. **Combined SourceBuffer mode=sequence** — Required to avoid 10-21s append freezes in `segments` mode, but `sequence` mode relies on Chrome auto-sequencing frames, which is fragile.

## The Fix: Use Server-Side TS→fMP4 (Already Built!)

**Critical discovery: The Rust backend already has fully functional TS→fMP4 transmuxing endpoints:**

- `GET /fmp4/init/{folder_id}/{message_id}?token=...` → Returns fMP4 init segment (ftyp+moov)
- `GET /fmp4/segment/{folder_id}/{message_id}?token=...&byte_offset=...&duration=5` → Returns fMP4 media segment (moof+mdat)

These endpoints use the existing `ts_demux.rs` (complete TS demuxer) and `fmp4.rs` (complete fMP4 builder). They're already registered in the Actix server at startup.

**The fix: Route TS files through these backend endpoints instead of mux.js, then feed the resulting fMP4 segments through the SAME mp4box.js pipeline that .mp4 files use.**

## Architecture

### Current (Broken) TS Path:
```
TS file → byte-range fetch → MuxJsTsTransmuxer (JS) → fMP4 segments
  → burst buffer → pause video → reset SourceBuffer → re-append → resume
  → stutter, frame drops, broken seek, wrong duration
```

### New (Fixed) TS Path:
```
TS file → /fmp4/init/ → fMP4 init segment → MSE SourceBuffer (same as MP4)
TS file → /fmp4/segment/ → fMP4 media segments → appendBuffer directly
  → Same progressive download loop as MP4 → smooth playback, fast seek
```

### MP4 Path (Unchanged):
```
MP4 file → byte-range fetch → mp4box.js → MSE SourceBuffer → smooth playback ✓
```

---

## Validation Results (Codebase Confirmed)

All plan claims were validated against the actual codebase by 4 parallel sub-agents. Results:

| # | Claim | Verdict | Key Lines |
|---|-------|---------|-----------|
| `initTransmuxerPlayer()` exists | ✅ Real | L1179 (def), L1100 (call) |
| Branches on `format === 'ts'` | ✅ Real | L1075 (outer), L1183 (inner) |
| `burstBufferRef`, `drainInProgressRef`, `drainTimerRef`, `startBurstDrainLoop()` | ✅ All real | L288-290 (refs), L1381 (drain loop) |
| `SEEK_DEBOUNCE_MS_TS = 2000` | ✅ Real | L252 (def), L2861 (use) |
| `transmuxerSeekInProgressRef` | ✅ Real | L261 (def), 8 usage sites |
| MP4 uses mp4box.js | ✅ Real | L998-1007 (`initMP4Box`) |
| MP4 progressive download loop | ✅ Real | `fetchMoreDataForwardScan` L2184, `downloadLoop` L2563 |
| `state.current.duration` | ✅ Real | L196 (interface), 42+ usage sites |
| `byteToTimeTableRef` | ✅ Real | L354 (def), L1364+L2364 (populated) |
| Stream URL parseable | ✅ Real | MediaPlayer.tsx L31-33: `{base}/stream/{folder_id}/{msg_id}?token={token}` |
| `extract_stream_info` signature | ✅ Real | ts_demux.rs L162; but **hardcoded TS_PACKET_SIZE=188 breaks M2TS** |
| `TsDemuxer::take_frames()` | ✅ Real | ts_demux.rs L494; returns `Vec<PesFrame>` |
| `build_media_segment` signature | ✅ Exact match | fmp4.rs L106; `(&[PesFrame], u32, u32, u32, u32)` |
| `Fmp4Query` has `time`, `byte_offset`, `duration` | ✅ All present | server.rs L1624-1630 |
| CORS exposes all X-headers | ✅ Correct | server.rs L2103 |
| fmp4_segment already has 503/Retry-After | ✅ Already implemented | L1876-1904 |
| `detect_ts_packet_size` handles M2TS in server.rs | ✅ But NOT propagated to demuxer | server.rs L25; ts_demux.rs L3 hardcodes 188 |
| Thumbnails differ between TS and MP4 | ✅ Confirmed | MP4: mini MSE+mp4box; TS: WebCodecs+mediabunny+OffsetCustomSource |
| FastStreamPlayer receives `isTransmuxer` | ✅ Used at L838 | For thumbnail gating; no other TS-specific logic |
| `useThumbnailExtractor` is 1503 lines | ✅ Confirmed | Separate pipelines for MP4 vs TS/MKV |

**Critical discovery**: M2TS bug confirmed — `ts_demux.rs` hardcodes 188-byte stride, `server.rs` detects 192 but never passes it to demuxer.

---

## Implementation Plan

### Phase 1: Backend Improvements (Rust)

The existing endpoints work but need enhancements for production quality.

#### 1.1 Add keyframe index endpoint

**File**: `app/src-tauri/src/server.rs`

**Add**: `GET /fmp4/keyframes/{folder_id}/{message_id}?token=...`

Returns JSON array of keyframe entries: `[{timestamp_s, byte_offset}, ...]`

This replaces the frontend `TSByteOffsetScanner` — the backend can scan the cached file much faster (local disk vs HTTP byte-range requests through WebView2 bridge).

**Why**: Seeking requires knowing where keyframes are. Currently the frontend scans via HTTP byte-range requests (slow). Backend scanning from local cache is 10-50x faster.

**Implementation**:
- Reuse `TSByteOffsetScanner` logic but run it on the cached file data directly (no HTTP)
- Cache the result per message_id in a HashMap (like Fmp4InitCache)
- Return `{"keyframes": [...], "duration": ..., "video_pid": ..., "audio_pid": ...}`

**Verification**: `curl http://localhost:PORT/fmp4/keyframes/home/MSGID?token=TOKEN` returns JSON with keyframe array.

#### 1.2 Improve fmp4_segment seeking with keyframe alignment

**File**: `app/src-tauri/src/server.rs`, function `fmp4_segment`

**Modify**: When `time` query parameter is provided, use the keyframe index to find the nearest keyframe BEFORE the requested time, then start demuxing from that keyframe's byte offset.

Currently the segment endpoint uses a crude `byte_offset = time * bitrate` estimate. With keyframe index, it can seek precisely to the nearest keyframe byte offset.

**Implementation**:
- Accept `time` query param (seconds)
- If keyframe index is available, binary search for nearest keyframe ≤ requested time
- Set `read_start` to keyframe's byte_offset (minus overlap for PAT/PMT context)
- Return `X-Segment-Start-Time` header with the actual keyframe timestamp (so frontend knows the true start position for `setTimestampOffset`)

**Verification**: Request segment with `time=60` → response header shows `X-Segment-Start-Time: 58.123` (nearest keyframe before 60s).

#### 1.3 Add duration endpoint

**File**: `app/src-tauri/src/server.rs`

**Add**: `GET /fmp4/metadata/{folder_id}/{message_id}?token=...`

Returns JSON: `{"duration_s": ..., "video_codec": "avc"|"hevc", "width": ..., "height": ..., "mime_type": ..., "total_size": ...}`

Duration comes from:
1. Telegram metadata (DocumentAttributeVideo.duration) — most reliable
2. PTS tail scan (read last 4MB, find max PTS) — fallback
3. File size / estimated bitrate — last resort

**Why**: The frontend needs accurate duration for the progress bar, prebuffer calculations, and seek UI. Currently duration is guessed from file size/bitrate → frequently wrong.

**Verification**: `curl` returns accurate duration matching the actual video length.

#### 1.4 Fix M2TS handling — CRITICAL BUG CONFIRMED

**Files**: `app/src-tauri/src/ts_demux.rs` + `app/src-tauri/src/server.rs`

**Issue (CONFIRMED by validation)**: `ts_demux.rs` hardcodes `TS_PACKET_SIZE = 188` (line 3). `extract_stream_info()` (line 162) iterates with `step_by(TS_PACKET_SIZE)` — this **cannot handle M2TS** (192-byte packets). When fed raw M2TS data, the 188-byte stride will land on wrong offsets, miss sync bytes, and return `None`. Meanwhile, `server.rs`'s `detect_ts_packet_size()` (line 25) **does detect M2TS** correctly, but **never passes that information to the demuxer**. This disconnect means M2TS files will silently fail at both the `/fmp4/init` and `/fmp4/segment` endpoints.

**Fix — Option A (strip prefix in server.rs before calling demuxer)**: This is simpler and doesn't require modifying the demuxer. In `fmp4_init` and `fmp4_segment`, after reading `ts_buf` from cache, if `is_m2ts`, strip the 4-byte BDAV prefix from every 192-byte packet to produce standard 188-byte TS data, then feed that to `extract_stream_info` and `TsDemuxer`.

**Fix — Option B (parameterize ts_demux.rs)**: Add a `packet_size` field to `TsDemuxer`, replace all `TS_PACKET_SIZE` references with `self.packet_size`, and adjust PES parsing to skip the 4-byte prefix when `packet_size == 192`. More robust but more invasive.

**Recommended: Option A** — stripping in server.rs is isolated, low-risk, and doesn't touch the working demuxer. The `hls/manifest.rs` module already does similar M2TS prefix stripping (it passes `ts_packet_size` to segment layout calculations).

**Implementation (Option A)**:
```rust
fn strip_m2ts_prefix(data: &[u8], is_m2ts: bool) -> Vec<u8> {
    if !is_m2ts { return data.to_vec(); }
    let mut out = Vec::with_capacity(data.len() / 192 * 188);
    let mut offset = 0;
    while offset + 192 <= data.len() {
        if data[offset + 4] == 0x47 {  // Verify sync byte after prefix
            out.extend_from_slice(&data[offset + 4..offset + 192]);
        }
        offset += 192;
    }
    out
}
```
Call before `extract_stream_info()` and `TsDemuxer::feed()` in both endpoints.

**Verification**: Test with an M2TS file → `/fmp4/init` returns valid init segment, `/fmp4/segment` returns valid fMP4.

#### 1.5 Handle PTS discontinuities in segment building

**File**: `app/src-tauri/src/fmp4.rs`, function `build_media_segment`

**Issue**: TS streams can have PTS discontinuities (timestamp jumps). Current code calculates DTS directly from PTS — discontinuities cause negative durations or huge gaps in fMP4 trun boxes.

**Fix**: Add discontinuity detection in `build_media_segment`:
- If PTS delta between consecutive frames > 5s (clock rate * 5), it's a discontinuity
- Split into separate media segments at discontinuity boundaries
- Or adjust DTS to maintain continuity (subtract the gap)

**Verification**: Test with a TS file containing PTS jumps → no negative durations in trun.

---

### Phase 2: Frontend Changes (TypeScript)

#### 2.1 Add TS→fMP4 pipeline in useMSEPlayer.ts

**File**: `app/src/hooks/useMSEPlayer.ts`

**Modify**: When `format === 'ts'`, instead of creating `MuxJsTsTransmuxer`, use the backend fMP4 endpoints with the MP4 download loop.

**Implementation**:

In `initTransmuxerPlayer()`, when `format === 'ts'`:

```typescript
// NEW PATH: Server-side TS→fMP4 transmuxing
if (format === 'ts') {
  await initTsFmp4Pipeline(url, mediaSource, blobUrl, firstChunkData);
  return;
}
```

New function `initTsFmp4Pipeline()`:

1. **Fetch init segment**: `GET /fmp4/init/{folder_id}/{message_id}?token=...`
   - Parse response headers: `X-Mime-Type`, `X-Video-Codec`, `X-Audio-Codec`
   - Create MSE SourceBuffer with the mime type
   - Append init segment to SourceBuffer

2. **Fetch metadata**: `GET /fmp4/metadata/{folder_id}/{message_id}?token=...`
   - Set `state.current.duration` from response
   - Set `state.current.bitrate` from `fileSize / duration`

3. **Fetch keyframe index**: `GET /fmp4/keyframes/{folder_id}/{message_id}?token=...`
   - Build `byteToTimeTableRef` from keyframe entries
   - Set `keyframeIndexReady = true`

4. **Start progressive download loop** (reuse existing MP4 download loop pattern):
   - Fetch segments sequentially: `GET /fmp4/segment/...?byte_offset=OFFSET&duration=5`
   - Append each segment's fMP4 data directly to SourceBuffer (no burst buffer!)
   - Track byte ranges for green buffer bar
   - Report ranges to cache backend
   - Handle backpressure (stop when >30s buffered ahead)
   - Evict old buffer when >20MB

5. **Seeking**: Use keyframe index for instant seek:
   - Binary search keyframes for nearest ≤ seekTime
   - Request segment from that keyframe's byte_offset
   - Clear SourceBuffer, set timestampOffset, append new segment
   - Resume progressive download from `X-Next-Byte-Offset`

**Why**: This makes TS files use the exact same MSE pipeline as MP4 files — no mux.js, no burst buffer, no GOP cache, no timestamp normalization.

**Verification**: Play a .ts file → smooth playback, no stutter, correct duration, working seek.

#### 2.2 Construct fMP4 endpoint URLs

**File**: `app/src/hooks/useMSEPlayer.ts` or `app/src/components/dashboard/MediaPlayer.tsx`

**Issue**: The fMP4 endpoints need `folder_id` and `message_id` in the URL path. The `useMSEPlayer` hook currently receives `streamUrl` (e.g., `http://localhost:PORT/stream/home/123?token=abc`).

**Fix**: Parse the streamUrl to extract `folder_id`, `message_id`, and `token`. Construct fMP4 URLs:
- Init: `${baseUrl}/fmp4/init/${folder_id}/${message_id}?token=${token}`
- Segment: `${baseUrl}/fmp4/segment/${folder_id}/${message_id}?token=${token}&byte_offset=...&duration=5`
- Keyframes: `${baseUrl}/fmp4/keyframes/${folder_id}/${message_id}?token=${token}`
- Metadata: `${baseUrl}/fmp4/metadata/${folder_id}/${message_id}?token=${token}`

Or pass these as separate props to `useMSEPlayer`.

**Verification**: URLs correctly resolve to backend endpoints.

#### 2.3 Handle HEVC (H.265) TS files

**File**: `app/src/hooks/useMSEPlayer.ts`

**Issue**: HEVC is not supported by MSE in Chrome/WebView2. The backend will still build fMP4 init segments with `hvc1` codec, but `MediaSource.isTypeSupported()` will return false.

**Fix**:
- After fetching init segment, check `X-Video-Codec` header
- If `hvc1` or HEVC detected, fall back to native `<video>` playback (same as current behavior)
- AVC files proceed through MSE path

**Verification**: HEVC .ts file falls back to native, AVC .ts file plays through MSE.

#### 2.4 Thumbnail extraction for TS via fMP4 endpoint

**File**: `app/src/hooks/useThumbnailExtractor.ts`

**Modify**: When format is TS and backend fMP4 pipeline is active, request a single-frame segment from the backend:
- `GET /fmp4/segment/...?time=DESIRED_TIME&duration=0.5`
- Build a mini MSE pipeline (same as current MP4 thumbnail approach) with the returned init + segment data
- Render to canvas

**Why**: The current approach uses `MediabunnyTransmuxer` for TS thumbnails, which is slow and complex. Backend single-frame segments are instant.

**Verification**: Hover over seek bar → thumbnails appear for TS files.

#### 2.5 Update FastStreamPlayer.tsx for TS path

**File**: `app/src/components/dashboard/FastStreamPlayer.tsx`

**Modify**: Remove/comment out references to `isTransmuxer`/`isTransmuxerActive` that are specific to mux.js. When the new TS pipeline uses the MP4 path, these become unnecessary.

**Verification**: No console errors about missing transmuxer properties.

---

### Phase 3: Code Removal / Deprecation

#### 3.1 Deprecate MuxJsTsTransmuxer

**File**: `app/src/lib/faststream/players/MuxJsTsTransmuxer.ts`

**Action**: Mark as deprecated. Add `@deprecated` JSDoc comment. Do NOT delete yet — keep as fallback if backend fMP4 fails.

In `useMSEPlayer.ts`, add fallback:
```typescript
if (format === 'ts') {
  try {
    await initTsFmp4Pipeline(url, mediaSource, blobUrl, firstChunkData);
    return;
  } catch (e) {
    diagLog(`[MSE] TS→fMP4 pipeline failed, falling back to mux.js: ${e}`);
    // Fall through to existing mux.js path
  }
}
```

**Why**: Don't burn bridges until the new path is proven in production.

#### 3.2 Remove burst buffer / drain loop (after validation)

**Files**: `app/src/hooks/useMSEPlayer.ts`

**Action**: After confirming TS→fMP4 pipeline works, remove:
- `burstBufferRef` and related refs
- `drainInProgressRef`, `drainTimerRef`
- `startBurstDrainLoop()` function
- All `shouldDrain` / pause-video-reset-SourceBuffer-resume logic

These are only needed by the mux.js path. The fMP4 path appends segments directly (Chrome appends fMP4 segments in 0-2ms, not 10-24s).

#### 3.3 Remove TS-specific seek debounce overrides

**File**: `app/src/hooks/useMSEPlayer.ts`

**Action**: Remove `SEEK_DEBOUNCE_MS_TS = 2000` and `transmuxerSeekInProgressRef`. The fMP4 pipeline uses the same 500ms debounce as MP4.

#### 3.4 Remove TSByteOffsetScanner frontend usage (after backend keyframes endpoint works)

**File**: `app/src/lib/faststream/utils/TSByteOffsetScanner.ts`

**Action**: Keep the file but stop using it from `useMSEPlayer.ts`. The backend `/fmp4/keyframes/` endpoint replaces it. Could later delete or keep for non-Tauri builds.

---

### Phase 4: Edge Cases & Error Handling

| Edge Case | Handling |
|-----------|----------|
| **Corrupt TS data** | Backend `extract_stream_info()` returns None → 500 → frontend falls back to mux.js → if that also fails → native playback |
| **M2TS (192-byte packets)** | Backend detects packet size, strips 4-byte prefix before demuxing |
| **PTS discontinuities** | Backend splits segments at discontinuity boundaries; frontend handles gaps in SourceBuffer |
| **HEVC codec** | Backend returns `hvc1` codec string; frontend detects via `X-Video-Codec` header and falls back to native |
| **Partial cache (503)** | Backend waits for download progress (already implemented with `find_best_covering_download`), returns 503 with Retry-After if timeout |
| **Duration unknown** | Use Telegram metadata → PTS tail scan → bitrate estimate (in that priority order) |
| **Audio-only TS** | Backend produces fMP4 with audio track only; MSE handles `audio/mp4` SourceBuffer |
| **Very large files (>4GB)** | Backend reads in chunks (already implemented); no full-file scan needed |
| **Seek beyond cached data** | Backend triggers targeted download (already implemented); frontend shows loading spinner |
| **Multiple rapid seeks** | Frontend debounce (500ms, same as MP4); backend aborts stale demuxer runs |
| **WebView2 MSE codec check** | `MediaSource.isTypeSupported(mimeType)` check before creating SourceBuffer; fall back to native if unsupported |

---

### Phase 5: Testing & Verification Strategy

#### 5.1 Backend Tests

1. **Unit test**: Feed known TS data to `TsDemuxer` → verify `PesFrame` output (timestamps, keyframe flags, codec config)
2. **Unit test**: Feed `PesFrame`s to `build_media_segment` → verify valid fMP4 moof+mdat structure
3. **Integration test**: `GET /fmp4/init/...` → verify Content-Type, X-Mime-Type headers, valid init segment
4. **Integration test**: `GET /fmp4/segment/...?byte_offset=0&duration=5` → verify fMP4 segment starts at keyframe, correct duration
5. **Integration test**: `GET /fmp4/keyframes/...` → verify keyframe array is sorted, timestamps reasonable
6. **Integration test**: Seek with `?time=60` → verify segment starts at nearest keyframe ≤ 60s

#### 5.2 Frontend Tests

1. **Playback test**: Open a .ts file → video plays without stutter for 60+ seconds
2. **Seek test**: Click seek bar at 50% → video jumps to position within 2s
3. **Duration test**: .ts file shows correct duration in progress bar
4. **Thumbnail test**: Hover over seek bar → thumbnails appear
5. **Prebuffer test**: Green buffer bar fills ahead during playback
6. **Cache dialog test**: Close video mid-playback → dialog appears with cache options
7. **HEVC test**: Open HEVC .ts file → falls back to native playback gracefully
8. **Regression test**: Open .mp4, .mkv, .webm files → still play correctly

#### 5.3 Manual Verification Checklist

- [ ] .ts file plays smoothly (no visible stutter for 5+ minutes)
- [ ] Seeking is responsive (<2s for cached, <5s for uncached)
- [ ] Duration is accurate (±2s of actual video length)
- [ ] Audio/video are in sync throughout playback
- [ ] No frame distortion or visual artifacts
- [ ] Green buffer bar shows correct progress
- [ ] Thumbnails appear on seek bar hover
- [ ] Cache dialog works on close
- [ ] Playback speed controls work
- [ ] Fullscreen works
- [ ] PiP works
- [ ] Subtitle rendering works (jassub)
- [ ] Download overlay works
- [ ] MP4/MKV/WebM still play correctly

---

### Phase 6: Implementation Order

**Step 1** (Backend, ~2h): Add `/fmp4/metadata/` and `/fmp4/keyframes/` endpoints
**Step 2** (Backend, ~2h): Improve `/fmp4/segment/` with keyframe-aligned seeking + M2TS handling
**Step 3** (Frontend, ~4h): Add `initTsFmp4Pipeline()` in `useMSEPlayer.ts` with progressive download
**Step 4** (Frontend, ~2h): Wire up seeking via keyframe index
**Step 5** (Frontend, ~2h): Wire up thumbnail extraction via backend segments
**Step 6** (Testing, ~2h): Full verification with real .ts files
**Step 7** (Cleanup, ~1h): Deprecate mux.js path, remove burst buffer code

**Total estimated effort: ~15 hours**

---

### Phase 7: Risk Mitigation

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Backend fMP4 segments invalid for Chrome MSE | Low | High | Test with Chrome's `mediaSource.isTypeSupported()` before appending; validate segments with mp4box.js |
| Backend transmuxing too slow for real-time playback | Low | Medium | Backend reads from local cache (not Telegram API) → should be <100ms per segment; if slow, pre-transmux and cache fMP4 segments |
| PTS discontinuities cause fMP4 decode errors | Medium | High | Split segments at discontinuities; add `tfdt` base_time adjustments; test with known-discontinuity TS files |
| fmp4.rs has bugs (e.g., wrong CTS calculation, moof size mismatch) | Medium | High | Validate generated fMP4 with `ffprobe` and Chrome's MSE; add checksum verification |
| Keyframe scan too slow for first playback | Low | Medium | Use Telegram's DocumentAttributeVideo.duration for manifest; keyframe scan runs async in background |
| HEVC files can't use MSE path | High | Low | Fall back to native `<video>` for HEVC (same as current behavior) |
| M2TS files not handled | Medium | Medium | Detect and strip 4-byte prefix in backend (already handled in HLS path, mirror for fMP4 path) |
| Breaking existing MP4/MKV/WebM playback | Low | High | Changes only affect `format === 'ts'` code path; add integration tests for all formats |
