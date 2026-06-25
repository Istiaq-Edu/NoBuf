# COMPREHENSIVE CODEBASE ASSESSMENT: PROACTIVE PREBUFFER PIPELINE

## CONTEXT
You are assessing a Tauri (Rust + React/TypeScript) desktop application called "Telegram-Drive" that streams video files directly from the Telegram API using mpegts.js on the frontend and actix-web on the backend. The application has a "PROACTIVE prebuffer" system that is currently malfunctioning. The developer has requested a root-cause analysis from a third-party AI (you) to identify why the implementation does not match the intended design.

## THE INTENDED DESIGN (THE "APPROACH")
The system has two concurrent download paths for video playback:
1. `/stream` handler (backend `server.rs`): Downloads video data from the Telegram API on-demand for the mpegts.js player (the "shadow buffer"). It downloads in ~12.5MB chunks sequentially from the seeked position.
2. `PROACTIVE` prebuffer (backend `commands/streaming.rs`): A background task that downloads data from the Telegram API directly to a disk cache, ahead of the playhead, so that `/stream` can eventually serve data from the local disk cache instead of hitting the Telegram API.

**THE INTENDED FLOW UPON SEEK:**
When a user seeks to time `T` in a video:
1. The frontend calculates a byte offset for `T` and calls `IOController.seek(byte)`, which triggers a `/stream` request to the backend.
2. The frontend reports the seeked byte to the `PROACTIVE` prebuffer system via a `cmd_report_playback_position` command.
3. `PROACTIVE` should start downloading from approximately `T + 40 seconds` (ahead of the playhead) to the end of the file (EOF).
4. `/stream` handles the first ~40 seconds of playback (downloading from Telegram directly for the player).
5. After ~40 seconds of playback, `/stream`'s read position reaches the region that `PROACTIVE` has already cached to disk.
6. `/stream` should find the data in the disk cache (a "PREBUFFER HIT") and serve it from local disk instead of Telegram.
7. From this point onward, `/stream` reads from disk and `PROACTIVE` continues downloading ahead, maintaining a rolling buffer.

**THE DEVELOPER'S SPECIFIC COMPLAINT:**
The developer states that this approach is "not working". The prebuffer is either:
- Starting at the wrong position (behind the playhead).
- Competing with `/stream` for the same bytes (causing a "double prebuffer").
- Suffering from long delays before `PROACTIVE` actually starts downloading after a seek.
- The green progress bar (representing the disk cache) is flashing, disappearing, or appearing at the wrong position.
- The shadow buffer (`/stream`) is not getting data from the local disk cache (no "PREBUFFER HIT"s) and keeps fetching from Telegram directly.

## YOUR TASK
Perform a deep-dive root-cause analysis of the codebase to identify WHY the intended design is not being achieved. You must:
1. **Trace the full seek pipeline** from the frontend (`useMSEPlayer.ts`) to the backend (`server.rs` and `commands/streaming.rs`).
2. **Identify all bugs, logic errors, and design flaws** that prevent the `PROACTIVE` prebuffer from starting 40 seconds ahead of the seeked point and maintaining a rolling disk cache.
3. **Analyze the byte-position reporting** between the frontend and backend.
4. **Analyze the gap evaluation logic** in `PROACTIVE` (how it decides where to start downloading).
5. **Analyze the yield/sleep mechanisms** in `PROACTIVE` (how it avoids competing with `/stream`).
6. **Analyze the VBR (Variable Bitrate) correction pipeline** and how it interacts with `PROACTIVE`.
7. **Analyze the disk cache read/write logic** in `/stream` (`STREAM-CACHE-POLL`, `STREAM-CACHE-WAIT`, `STREAM-FALLBACK`).
8. **Analyze the frontend progress bar rendering** (`FastStreamPlayer.tsx`) and why it might show incorrect positions.

## KEY FILES TO ANALYZE

### Backend (Rust)
1. `D:/DEVELOPMENT/Telegram-Drive/app/src-tauri/src/commands/streaming.rs`
   - Function: `cmd_report_playback_position` (receives seeked byte from frontend)
   - Function: `proactive_prebuffer_download` (the main PROACTIVE loop)
   - Variables to trace: `start_byte`, `proactive_start_byte`, `ahead_gaps`, `jumped`, `skip_all_gaps`, `last_target_byte`
   - Look for: How `start_byte` is set, how the 40s ahead offset is calculated, how `jumped` and `skip_all_gaps` interact, the 5s yield loop, the 2s sleep, the backward seek detection logic.

2. `D:/DEVELOPMENT/Telegram-Drive/app/src-tauri/src/server.rs`
   - Function: `stream_media` (the `/stream` endpoint handler)
   - Variables to trace: `STREAM-CACHE-POLL`, `STREAM-CACHE-WAIT`, `STREAM-FALLBACK`, `FALLBACK_TIMEOUT_MS`, `pending_ranges` (meta flush batching)
   - Look for: How `/stream` checks the disk cache, how long it waits for PROACTIVE, how it falls back to Telegram, how fast it flushes cached_ranges to the meta file.

3. `D:/DEVELOPMENT/Telegram-Drive/app/src-tauri/src/stream_cache.rs`
   - Struct: `ActiveDownload`, `CacheMeta`, `cached_ranges`
   - Function: `find_gaps` (returns uncached byte ranges)
   - Look for: How cached ranges are stored and retrieved, how `find_gaps` works, zombie download cancellation.

### Frontend (TypeScript/React)
4. `D:/DEVELOPMENT/Telegram-Drive/app/src/hooks/useMSEPlayer.ts`
   - Function: `_mpegtsUnbufferedSeek` (the seek execution)
   - Variables to trace: `RAW_BYTE_OFFSET`, `ALIGNED_BYTE_OFFSET`, `byteOffset`, `vbrCorrectionDepth`, `seekKeyframeAdjusted`
   - Look for: What byte is reported to PROACTIVE via `cmd_report_playback_position` (is it `RAW_BYTE_OFFSET` or `ALIGNED_BYTE_OFFSET`?), how VBR correction changes the reported byte, how `__nobuf_userSeekInProgress` flag is set/cleared.

5. `D:/DEVELOPMENT/Telegram-Drive/app/src/components/dashboard/FastStreamPlayer.tsx`
   - Variables to trace: `cachedTimeRanges`, `bufferedRanges`, `downloadedTimeRanges`, `byteToTime`
   - Look for: How the green progress bar is rendered, what data source it uses, how `byteToTime` converts byte positions to time positions (is it linear or VBR-corrected?), how `__nobuf_userSeekInProgress` suppresses updates during seek.

## SPECIFIC QUESTIONS TO ANSWER

1. **Why does PROACTIVE not start exactly 40s ahead of the seeked point?**
   - Trace the exact calculation of `proactive_start_byte` in `streaming.rs`.
   - Is the `start_byte` correct? Does it receive the `RAW_BYTE_OFFSET` or the stepped-back `ALIGNED_BYTE_OFFSET` from the frontend?
   - Does the 40s offset calculation use the correct duration and file size?

2. **Why does PROACTIVE download at the same time as /stream (double prebuffer)?**
   - Trace the `jumped` flag lifecycle. When is it set to `true`? When is it reset to `false`?
   - Trace the `skip_all_gaps` logic. Does it actually skip all gaps, or does the outer loop iterate immediately and download anyway?
   - Is the 2s sleep effective? Does it run at the right time?

3. **Why does the green progress bar flash and disappear?**
   - Trace the `__nobuf_userSeekInProgress` flag. When is it set? When is it cleared?
   - Are all progress bar update systems (cachedTimeRanges, bufferedRanges, downloadedTimeRanges) suppressed during seek?
   - Is `clearDownloadedRanges` called during seek? Does it bypass the suppression?

4. **Why does the green bar show behind the playhead after seek?**
   - How does `byteToTime()` convert bytes to time? Is it linear or VBR-corrected?
   - Is `byteToTimeTableRef` populated for TS files? Or is it empty, causing a linear fallback that's wrong for VBR?
   - Are VBR-corrected keyframes added to `byteToTimeTableRef`?
   - Does the clamp filter (`rangeEndTime < currentPlaybackTime - 5`) work for straddling ranges?

5. **Why does /stream not get PREBUFFER HITs from the disk cache?**
   - How does `/stream` check the disk cache? (`STREAM-CACHE-POLL`)
   - How long does it wait for PROACTIVE? (`STREAM-CACHE-WAIT`, `FALLBACK_TIMEOUT_MS`)
   - How fast are cached_ranges flushed to the meta file? Is the flush batching (2 chunks = 1MB) fast enough?
   - Does PROACTIVE actually write to the disk cache before /stream reads?

6. **Why are there long delays (15-16 seconds) before PROACTIVE starts downloading?**
   - Trace the yield mechanism. How many yields happen per seek?
   - Does each VBR correction trigger a separate 5s yield + 2s sleep?
   - Is the `last_target_byte` guard effective at preventing infinite loops?

## OUTPUT FORMAT
Provide a structured report with:
1. **Executive Summary**: High-level description of why the prebuffer system is broken.
2. **Root Cause Analysis**: For each bug found, provide:
   - Bug name and severity (Critical/High/Medium/Low)
   - File and line number(s)
   - Root cause description
   - Evidence from the code (code snippets)
   - Why it breaks the intended design
   - Suggested fix (code-level)
3. **Pipeline Trace**: Step-by-step trace of a seek operation, showing where each component fails.
4. **Edge Case Analysis**: List of edge cases that are not handled correctly.
5. **Recommendations**: Prioritized list of fixes.
