---
name: video-streaming
description: MSE/HLS video streaming, byte-range requests, buffer management, and media playback patterns
user-invocable: true
---

## Video Streaming Guide

Expert guidance for building video streaming with Media Source Extensions (MSE), HLS, and byte-range requests.

### Architecture Overview
```
Client → /stream/{id} (byte-range) → Tauri Command → Telegram API → chunks → MSE/SourceBuffer
```

### Media Source Extensions (MSE)
```typescript
const mediaSource = new MediaSource();
video.src = URL.createObjectURL(mediaSource);
mediaSource.addEventListener('sourceopen', () => {
    const sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
    // Append chunks to sourceBuffer
});
```

### Byte-Range Requests
- Use HTTP Range headers: `Range: bytes=start-end`
- Server responds with `206 Partial Content`
- Each chunk must be a valid MP4 segment (moov + mdat or mdat fragments)

### Buffer Management
- **Forward-first buffering** — prefetch upcoming segments, not re-fetching past ones
- **Fragment store** — cache downloaded fragments in IndexedDB, merge when adjacent
- **Buffer on same progress bar** — show buffered ranges on the seek bar (white/gray overlay)
- **Seek detection** — time-jump >2s indicates seek; byte-position thresholds fail during normal playback

### HLS Segments
- Must use the main `/stream/` endpoint with byte-range headers
- Don't create separate endpoints per segment
- Segment duration: 2-6 seconds typical
- Each segment needs correct timestamp alignment

### mp4box.js Usage
- Parse MP4 metadata (tracks, duration, codec info)
- Generate initialization segments
- Fragment MP4 for MSE consumption

### Performance Tips
- `requestAnimationFrame` for UI updates tied to playback
- Don't update React state on every `timeupdate` event — throttle to 1Hz
- Use `SourceBuffer.appendBuffer()` in chunks, not one giant buffer
- `SourceBuffer.remove()` old buffered ranges to prevent memory bloat

### Common Issues
- **"Failed to execute 'appendBuffer'"** — SourceBuffer still updating; wait for `updateend` event
- **Codec mismatch** — Ensure init segment codec string matches `addSourceBuffer()` MIME
- **Black screen but audio plays** — Codec string wrong or missing video track in init segment
- **Seek fails** — Need a keyframe (sync sample) at seek target; fragmented MP4 fixes this

### Debug Checklist
- [ ] Check `MediaSource.readyState` is "open"
- [ ] Verify `SourceBuffer.updating` is false before appending
- [ ] Confirm chunk is valid MP4 fragment (not raw H.264)
- [ ] Check codec string matches: `video/mp4; codecs="..."`
- [ ] Monitor `video.buffered` ranges for gaps
