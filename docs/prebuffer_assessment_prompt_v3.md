# THIRD COMPREHENSIVE ASSESSMENT: GREEN BAR "RANDOM FILL" — byteToTime VBR MAPPING FAILURE

## CONTEXT
This is the third assessment. Previous fixes addressed:
- skip_all_gaps removed (double prebuffer cycle eliminated)
- 40s ahead offset (proactive_start_byte)
- Cold-start guard relaxed for explicit seeks
- 45s merge bridge in green bar rendering
- byteToTimeTableRef populated from backend keyframes

## THE USER'S COMPLAINT
"the prebuffer on the UI video bar is just a random fill"

The user says the green prebuffer bar does NOT correspond to actual cached data on disk. It appears to be filling random areas of the progress bar, not matching where data is actually cached.

## ROOT CAUSE HYPOTHESIS
The green bar uses `byteToTime()` to convert backend byte ranges (from `cmd_get_cache_status`) to time positions for rendering. `byteToTime()` uses `byteToTimeTableRef` for VBR-accurate interpolation.

The backend `/fmp4/keyframes` endpoint returns EMPTY at startup because the data file isn't ready yet (log: "Data file not ready for msg 3 — returning empty partial index"). The frontend fetches keyframes once at init, gets empty, and the 10-second retry interval (`setInterval(() => refreshTsKeyframeIndex(), 10000)`) may or may not succeed depending on when the backend finishes building the keyframe index.

With an empty keyframe table, `byteToTime()` falls back to the baseline seed: `(0, 0)` and `(fileLength, duration)`. This is **exactly the same as linear mapping** — `byte / fileLength * duration`. For VBR video, this is WRONG and produces the "random fill" effect the user sees.

## WHAT TO ANALYZE

### 1. The keyframe fetch lifecycle
File: `app/src/hooks/useMSEPlayer.ts`
- `refreshTsKeyframeIndex` (line ~837): Fetches from `/fmp4/keyframes` endpoint
- Called at init (line ~5421) and every 10s via setInterval (line ~5422)
- If the backend returns empty (data file not ready), the keyframes array is empty
- The `if (keyframes.length > 0)` check at line 842 means empty results DON'T update the table
- The table stays at baseline `(0,0), (fileLength, duration)` — linear mapping

**Questions:**
- Does the 10s retry actually succeed? Check the backend logs for when `/fmp4/keyframes` starts returning data.
- How long does it take for the backend to build the keyframe index? (Look for "FMP4-KF" logs showing keyframe discovery)
- Is the keyframe index built from the disk cache data, or does it require a separate scan?

### 2. The backend keyframe index
File: `app/src-tauri/src/server.rs`
- `fmp4_keyframes` endpoint (line ~3783)
- `Fmp4KeyframeCacheData` — cached keyframe results
- The keyframe index is built by scanning the TS data file for keyframe PES packets
- This requires the data file to exist and have enough data scanned

**Questions:**
- When does the keyframe index become available? (After first /stream download? After PROACTIVE downloads enough?)
- Does the keyframe index cover the FULL file, or only the cached portions?
- If it only covers cached portions, `byteToTime()` will have gaps — interpolation between sparse points may still be wrong.

### 3. The byteToTime function
File: `app/src/hooks/useMSEPlayer.ts`
- `byteToTime` (line ~873): Uses `byteToTimeTableRef` for interpolation
- If table is empty or has only 2 points: falls back to linear
- Binary search between two nearest calibration points
- Linear interpolation between those points

**Questions:**
- With only `(0,0)` and `(fileLength, duration)`, is the interpolation EXACTLY linear?
- How many keyframes does the backend typically return? (Check if the keyframe cache log shows "Cache HIT" with a large JSON)
- If the backend returns 50-100 keyframes, does `byteToTime()` interpolate correctly between them?

### 4. The green bar rendering
File: `app/src/components/dashboard/FastStreamPlayer.tsx`
- `cachedTimeRanges` populated from `cmd_get_cache_status` polling (every 500ms)
- Each byte range `[s, e]` converted via `byteToTime(s)` and `byteToTime(e+1)`
- Ranges merged with 45s bridge tolerance
- Rendered as green bars on the progress bar

**Questions:**
- Is `byteToTime` being called with the correct byte values from `cmd_get_cache_status`?
- Are the byte values from the backend correct (matching what's actually on disk)?
- Could the `byteToTime` function be returning NaN or Infinity for any inputs?
- Is the duration used by `byteToTime` correct (2073s, not the estimated 2627.9s)?

### 5. The estimated vs real duration issue
- The app starts with estimated duration 2627.9s (from 4Mbps assumption)
- Real duration 2073.0s arrives from metadata ~5s later
- The baseline seed uses `state.current.duration` which may be 2627.9s initially
- The re-seed at "Got real duration" updates to 2073.0s
- But if keyframes arrive AFTER the re-seed, they overwrite the table with accurate data
- If keyframes NEVER arrive (backend returns empty), the table stays at `(0,0), (fileLength, 2627.9)` or `(0,0), (fileLength, 2073.0)`

**Questions:**
- Is the estimated duration (2627.9s) causing the green bar to render at wrong positions?
- `byteToTime(917563328)` with duration 2627.9 = 917563328/1313957192*2627.9 = 1835.2s
- `byteToTime(917563328)` with duration 2073.0 = 917563328/1313957192*2073.0 = 1447.8s
- Actual VBR time at byte 917563328 = 1485.4s (from logs)
- With 2073s: 1447.8s vs actual 1485.4s → 37.6s off → green bar in wrong position
- With 2627.9s: 1835.2s vs actual 1485.4s → 349.8s off → green bar WAY off

## SPECIFIC QUESTIONS TO ANSWER

1. **Why is the green bar a "random fill"?**
   - Is it because `byteToTimeTableRef` never gets populated with real keyframes?
   - Is it because the baseline seed uses the wrong duration?
   - Is it because `byteToTime()` is called with wrong byte values?

2. **When does the backend keyframe index become available?**
   - Does it require the disk cache data file to exist?
   - Does it require PROACTIVE to download enough data?
   - How long does it take from app start to keyframe availability?

3. **Does the 10s retry interval for `refreshTsKeyframeIndex` actually work?**
   - Does it keep retrying until it gets data?
   - Or does it give up after the first empty response?

4. **What is the correct fix?**
   - Should the frontend retry more aggressively (every 2s instead of 10s)?
   - Should the backend build the keyframe index from the TS file metadata, not the cached data?
   - Should `byteToTime` use a different approach entirely (e.g., ask the backend to convert bytes to times)?
   - Should the green bar use the VBR-corrected keyframe cache (`tsKeyframeIndexRef`) directly instead of `byteToTimeTableRef`?

5. **Is there a simpler approach?**
   - The frontend already has `tsKeyframeIndexRef` which stores `{ timestamp, byteOffset }` entries
   - Could the green bar rendering use `tsKeyframeIndexRef` directly to map bytes to times?
   - Could we build a `byteToTime` function that uses `tsKeyframeIndexRef` (which is populated from the same backend fetch)?

## OUTPUT FORMAT
1. **Root Cause**: Why the green bar is a "random fill" — exact code path and failure point
2. **Evidence**: Log evidence showing the keyframe fetch failing or returning empty
3. **Fix**: The proper, verified, validated solution (not a workaround/patch)
4. **Code Changes**: Specific file/line changes needed
5. **Verification Plan**: How to verify the fix works (what logs to check, what behavior to expect)
