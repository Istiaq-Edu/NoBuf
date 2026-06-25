# SECOND COMPREHENSIVE ASSESSMENT: PROACTIVE PREBUFFER — "2 SPAWN POINTS" ISSUE

## CONTEXT
This is a follow-up assessment. The first assessment found 10 bugs. 4 critical bugs were fixed:
1. Cold-start guard relaxed for explicit seeks (PROACTIVE starts immediately)
2. Byte reporting changed to ALIGNED_BYTE_OFFSET (same base as /stream)
3. /stream fallback timeout increased to 15s
4. Green bar clamp removed (show full disk cache state)
5. skip_all_gaps removed entirely (was causing skip-then-download cycle)
6. 40s ahead offset (proactive_start_byte) added

## CURRENT STATE
After all fixes, the backend logs show:
- PROACTIVE downloads from ~40s ahead of /stream ✅
- No "skipping gap" messages (skip_all_gaps removed) ✅
- No double "SEQUENTIAL download" entries ✅
- Only ONE PROACTIVE download per seek ✅

## THE USER'S COMPLAINT
The user says: "prebuffer generating 2 spawn point every time even on initial start"

After analyzing the backend logs, we found that PROACTIVE IS working correctly — there is only ONE PROACTIVE download, starting 40s ahead. The "2 spawn points" the user sees are:
1. /stream's download (for the player) — writes to disk cache → shows on green bar
2. PROACTIVE's download (for disk cache) — writes to disk cache → shows on green bar

Both write to the SAME disk cache file. `cmd_get_cache_status` returns ALL cached ranges from BOTH downloads. The green bar renders ALL cached ranges, so the user sees TWO green bars at TWO positions:
- One at /stream's position (playhead)
- One at PROACTIVE's position (40s ahead)

## QUESTIONS FOR THE ASSESSMENT

1. **Is this the intended behavior?** Should the green bar show /stream's cached data, or ONLY PROACTIVE's cached data?

2. **How to distinguish /stream's ranges from PROACTIVE's ranges?** Both write to the same `cached_ranges` in `CacheMeta`. There's no field to distinguish which download wrote which range. Options:
   a. Don't show /stream's ranges on the green bar (but how to identify them?)
   b. Use a separate cache file for PROACTIVE (major refactor)
   c. Tag ranges with their source (download type) in CacheMeta
   d. Only show ranges that are AHEAD of /stream's current read position (but /stream's position changes)

3. **Is the "2 spawn points" actually a VBR mapping issue?** The green bar uses `byteToTime()` to convert byte ranges to time positions. If `byteToTimeTableRef` is empty (TS files), it falls back to linear mapping. For VBR video:
   - /stream downloads at byte 998302748 (VBR-corrected for 1608s)
   - `byteToTime(998302748)` = 998302748 / 1313957192 × 2073 = 1574.8s (LINEAR — WRONG!)
   - Actual time at this byte = 1607.0s (from VBR correction)
   - Green bar shows /stream's range at 1574.8s → 33s BEHIND the playhead!
   - This looks like a "spawn point behind the seeked point"
   
4. **How to fix byteToTime for TS files?** The `byteToTimeTableRef` is populated from VBR-corrected keyframes (at 3 locations in useMSEPlayer.ts). But on FIRST seek to a new region, the table is empty → linear fallback → wrong position. Options:
   a. Populate byteToTimeTableRef from backend `/fmp4/keyframes` endpoint on init
   b. Add a calibration point at (0, 0) and (filesize, duration) as baseline
   c. Use the frontend's `tsKeyframeIndexRef` to build the table (it has the same data)

5. **Should the green bar be suppressed during /stream's active download?** The `__nobuf_userSeekInProgress` flag suppresses updates during seek. But after the seek completes, /stream continues downloading — its ranges appear on the green bar immediately. Should /stream's active download ranges be hidden until the seek fully completes?

## KEY FILES (CURRENT STATE)

### streaming.rs (after fixes)
- `cmd_report_playback_position`: Cold-start guard only for `byte_offset.is_none()`
- `proactive_prebuffer_download`: 
  - `proactive_start_byte = start_byte + 40s_bytes`
  - `jumped = false` (reset immediately, no skip_all_gaps)
  - No skip_all_gaps, no 2s sleep
  - 5s yield still in inner loop on jump detection
  - `last_target_byte` guard prevents inner loop backward jump spam

### server.rs (after fixes)
- `FALLBACK_TIMEOUT_MS = 15000` (was 3s, then 10s, now 15s)
- Meta flush every 2 chunks (1MB)
- `/stream` writes to same cache file as PROACTIVE

### useMSEPlayer.ts (after fixes)
- Reports `byteOffset` (ALIGNED_BYTE_OFFSET) to PROACTIVE
- `byteToTimeTableRef` populated from VBR-corrected keyframes at 3 locations
- `__nobuf_userSeekInProgress` suppresses progress bar during seek
- `clearDownloadedRanges` suppressed during seek

### FastStreamPlayer.tsx (after fixes)
- Green bar shows ALL cached ranges (no clamp, no filter)
- `cachedTimeRanges` polled every 500ms from `cmd_get_cache_status`
- `bufferedRanges` polled every 250ms from `v.buffered` (rAF)
- Both suppressed during `__nobuf_userSeekInProgress`

## WHAT TO ANALYZE

1. Read `FastStreamPlayer.tsx` — how the green bar renders `cachedTimeRanges`. Is it showing /stream's ranges as a separate indicator? How would the user perceive "2 spawn points"?

2. Read `useMSEPlayer.ts` — the `byteToTime` function. Is the linear fallback causing /stream's ranges to appear at the wrong position (behind the playhead) for VBR files?

3. Read `stream_cache.rs` — `cmd_get_cache_status` and `CacheMeta`. Can we distinguish /stream's ranges from PROACTIVE's ranges?

4. Read `server.rs` — the `/stream` handler. Does /stream write to `cached_ranges` immediately, or is there a delay? How fast does the green bar pick up /stream's data?

5. Analyze the INITIAL START case: On app launch, /stream bootstraps from byte 0, PROACTIVE starts from byte 20MB. Both write to disk cache. The green bar shows TWO ranges: 0-512KB and 20MB+. Is this what the user means by "2 spawn points on initial start"?

## OUTPUT FORMAT
1. **Root Cause**: Why the user sees "2 spawn points" — is it VBR mapping, /stream ranges showing, or something else?
2. **Fix Options**: 2-3 concrete approaches to make the green bar show only ONE prebuffer indicator
3. **Recommended Fix**: The simplest approach that doesn't require a major refactor
4. **Code Changes**: Specific file/line changes needed
