# COMPREHENSIVE CODEBASE ASSESSMENT: PROACTIVE PREBUFFER PIPELINE

## 1. EXECUTIVE SUMMARY

The prebuffer system is **broken by design** in `proactive_prebuffer_download` and the frontend/backend reporting contract. The intended architecture is:

> `/stream` handles the first ~40 s of playback, then hands off to `PROACTIVE`, which has already cached 40 s ahead.

In reality:

1. `PROACTIVE` receives the **un-stepped-back** byte (`RAW_BYTE_OFFSET`), but it also computes a 40 s-ahead offset **on top of that raw byte** — which is already behind the target playhead by the 2 MB step-back. For a backward seek it uses `start_byte` that can be **behind the playhead**, then adds 40 s worth of bytes from the file-average bitrate. The result is not "40 s ahead of the user's playhead"; it is a number that depends on where the raw byte landed, often inside or behind `/stream`'s bootstrap window.
2. The `jumped` / `skip_all_gaps` mechanism is **self-defeating**. `jumped` is reset to `false` before the inner loop, the 5 s interruptible yield only runs if `jumped` is still `true` (it isn't), and the 2 s sleep happens after the decision to skip gaps. So after a seek, `PROACTIVE` either downloads the same gap immediately or skips the first gap and re-evaluates with no real yield, producing a "double prebuffer".
3. `/stream` is **not blocked from falling back to Telegram** while `PROACTIVE` starts. The cold-start guard in `cmd_report_playback_position` **defers `PROACTIVE` until `/stream` has already written cache metadata**, which means `PROACTIVE` cannot pre-cache before the first seek; it only joins after `/stream` has done the first bootstrap download. The whole point of a 40 s-ahead prebuffer is to avoid this bootstrap.
4. The progress bar is **synthesized from two different, unsynchronized data sources** (`cmd_get_cache_status` and `StreamShadowCache`) with a "clamp to currentTime - 5 s" filter that drops ranges behind the playhead. The VBR `byteToTimeTableRef` is populated only from successful align-poll jumps, which are themselves rate-limited by the same semaphore and fallbacks.
5. `/stream` rarely gets `PREBUFFER HIT`s because the fallback timeout is **3 s**, but `PROACTIVE` is blocked by the cold-start guard and can take 10+ s to start; meanwhile `/stream` has already downloaded the bootstrap itself and broken the intended handoff.

In short: the code has the *shape* of the intended architecture, but the byte arithmetic, the yield logic, and the `/stream` cold-start guard all invert the intended sequence.

---

## 2. ROOT CAUSE ANALYSIS

### Bug 1 — `proactive_start_byte` is calculated from the wrong base and wrong bitrate
**Severity:** Critical  
**File:** `app/src-tauri/src/commands/streaming.rs`, lines 813-851 and 3357 in `useMSEPlayer.ts`

**Evidence:**

```rust
// streaming.rs:813-826
if latest_current_byte > start_byte {
    start_byte = latest_current_byte;
} else if latest_current_byte + 10 * 1024 * 1024 < start_byte {
    start_byte = latest_current_byte;
    jumped = true;
}

// streaming.rs:842-851
let proactive_start_byte = if let Some(&(_, dur, _, _)) = ... {
    if dur > 0.0 {
        let ahead_bytes = (40.0 / dur * total_size as f64) as u64;
        start_byte.saturating_add(ahead_bytes)
    } else { start_byte }
} else { start_byte };
```

The frontend reports:

```ts
// useMSEPlayer.ts:3357
byteOffset: RAW_BYTE_OFFSET, // Report the un-stepped-back byte to PROACTIVE
```

`RAW_BYTE_OFFSET` is already the *seek target byte* (not the playhead). For a non-keyframe seek, it is the **linear estimate**, which may be far behind the actual video keyframe (the user's visible playhead). The backend then adds 40 s of file-average bitrate bytes on top of that already-late byte. If the file is VBR and the local bitrate is lower than the average, the 40 s offset will be too small and land inside `/stream`'s bootstrap window.

**Why it breaks the design:** The design requires `PROACTIVE` to start 40 s ahead of the *actual playhead* after the seek completes. The code starts 40 s ahead of the *pre-stepped-back, possibly linear-estimate byte*, which can be behind the playhead.

**Suggested fix:** Report `ALIGNED_BYTE_OFFSET` or the *actual keyframe byte* after the align-poll resolves, not `RAW_BYTE_OFFSET`. Then calculate `proactive_start_byte` as `actual_playhead_byte + bitrate * 40s`, where `bitrate` is the **local** bitrate around the seek region (e.g. from the byte-to-time table or the last measured chunk speed), not the global average.

---

### Bug 2 — `jumped` / `skip_all_gaps` yield logic is effectively disabled
**Severity:** Critical  
**File:** `app/src-tauri/src/commands/streaming.rs`, lines 786-897, 919-953

**Evidence:**

```rust
// 786-788
let mut jumped = false;
let mut last_target_byte: Option<u64> = None;

// 877-884
let mut skip_all_gaps = jumped;   // jumped is false here
jumped = false;                   // reset immediately
if skip_all_gaps {
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
}

// 919-953
if jumped {   // inside the inner loop, but jumped was reset to false
    let yield_start = ...;
    loop { ... }
}
```

The only place `jumped` becomes `true` is in the inner-loop target check (lines 1004-1021) and the backward-seek branch (line 825). But in the backward branch it is reset to `false` on line 878 **before** the gap loop. The 5 s yield inside the gap loop only runs when `jumped` is `true`, so it almost never runs. The 2 s sleep only runs when `skip_all_gaps` is `true`, which requires `jumped` to be `true` at the top of the outer loop — but after the backward branch it is already false.

**Why it breaks the design:** The intended 2 s / 5 s yield after a seek is meant to let `/stream` download the bootstrap chunk without competing for the Telegram semaphore. Because the flag is reset too early, `PROACTIVE` either starts downloading immediately or skips the first gap without yielding, causing the "double prebuffer" and `FLOOD_PREMIUM_WAIT`.

**Suggested fix:** Move the `jumped` reset to the **end** of the outer loop iteration, not the beginning. Set `skip_all_gaps = true` and keep `jumped = true` until the inner loop finishes the post-seek yield. Do not reset `jumped` before the yield.

---

### Bug 3 — Cold-start guard in `cmd_report_playback_position` prevents `PROACTIVE` from starting before `/stream`
**Severity:** Critical  
**File:** `app/src-tauri/src/commands/streaming.rs`, lines 558-575

**Evidence:**

```rust
if let Some(meta) = cache_state.load_meta(message_id) {
    if meta.cached_ranges.is_empty() {
        log::info!("[PROACTIVE] msg {}: cache meta exists but no ranges yet — /stream bootstrap still running, deferring proactive", message_id);
        return Ok(false);
    }
} else {
    log::info!("[PROACTIVE] msg {}: no cache meta — /stream bootstrap not started yet, deferring proactive", message_id);
    return Ok(false);
}
```

`PROACTIVE` is only allowed to start **after** `/stream` has already created a `.meta.json` and written at least one cached range. On the very first seek / play, this means `/stream` must bootstrap from Telegram first, then `PROACTIVE` starts. The whole point of 40 s ahead is to start before the bootstrap finishes.

**Why it breaks the design:** The design says `/stream` handles the first 40 s and `PROACTIVE` handles the rest. The code forces `/stream` to do the first bootstrap chunk *before `PROACTIVE` can run at all*, so `PROACTIVE` is always late and `/stream` has already started its own Telegram download.

**Suggested fix:** Remove the cold-start guard or allow `PROACTIVE` to start immediately when `byteOffset` is provided (i.e. on a seek), provided no other `PROACTIVE` task is running. The guard can remain for the initial load when no byte offset is known, but not for explicit seek reports.

---

### Bug 4 — `/stream` fallback timeout is too short and prefers Telegram over waiting
**Severity:** High  
**File:** `app/src-tauri/src/server.rs`, lines 912-1048

**Evidence:**

```rust
const POLL_INTERVAL_MS: u64 = 100;
const FALLBACK_TIMEOUT_MS: u64 = 3000;

// 927-968
let skip_poll = ... || {
    // if meta is none, cached_ranges empty, or cached_run < 5MB -> use Telegram bootstrap
};

// 1038-1042
if !has_active_download && wait_elapsed_ms >= 5000 {
    log::warn!("[STREAM-CACHE-WAIT] msg {}: no proactive prebuffer running and 5s elapsed, falling back to Telegram", message_id);
    break;
}

// 1045-1048
if wait_elapsed_ms >= FALLBACK_TIMEOUT_MS {
    log::warn!("[STREAM-CACHE-WAIT] msg {}: 10s timeout waiting for cache at offset {}, falling back to Telegram", message_id, read_offset);
    break;
}
```

The constants are contradictory: `FALLBACK_TIMEOUT_MS` is 3000, but the log says 10 s. The 5 s "no active download" check triggers before `FALLBACK_TIMEOUT_MS`. Because `PROACTIVE` is not registered in `active_downloads` (it uses `proactive_tasks`), `active_download_count` is usually 0, so `/stream` falls back to Telegram after 5 s.

**Why it breaks the design:** `/stream` gives up waiting for `PROACTIVE` before `PROACTIVE` can even start (cold-start guard) and download its first 1 MB flush. The intended "PREBUFFER HIT" path is rarely reached.

**Suggested fix:** Increase the poll timeout to at least 30 s (the code comment says 30 s but the constant is 3 s). Count `proactive_tasks` as active downloads. Do not fall back to Telegram unless the user explicitly seeks to an uncached region and no proactive task is running.

---

### Bug 5 — Frontend reports `RAW_BYTE_OFFSET` to `PROACTIVE`, but `/stream` uses `ALIGNED_BYTE_OFFSET`
**Severity:** High  
**File:** `app/src/hooks/useMSEPlayer.ts`, lines 2849-2871 and 3357

**Evidence:**

```ts
const RAW_BYTE_OFFSET = seekByteFromIndex >= 0 ? seekByteFromIndex : ...;
const stepBackBytes = ...;
const ALIGNED_BYTE_OFFSET = Math.max(0, Math.floor(RAW_BYTE_OFFSET / TS_PACKET_SIZE) * TS_PACKET_SIZE - stepBackBytes);
const byteOffset = ALIGNED_BYTE_OFFSET;
ioctl.seek(byteOffset);
...
byteOffset: RAW_BYTE_OFFSET, // reported to PROACTIVE
```

`/stream` is told to seek to `ALIGNED_BYTE_OFFSET` (2 MB or 1880 bytes behind the target). `PROACTIVE` is told the target is `RAW_BYTE_OFFSET`. But `PROACTIVE` then adds another 40 s-ahead offset. If the intended 40 s offset is measured from the actual playhead, `PROACTIVE` should use the *aligned* byte (or the actual playhead byte), not the raw one, because `/stream` will already be downloading from `ALIGNED_BYTE_OFFSET`.

**Why it breaks the design:** The two paths use different base bytes, so their windows overlap unpredictably. The comment says "PROACTIVE should prebuffer from the actual seek target, not behind it", but the actual target is what the user sees, and that is the keyframe byte after alignment, not the raw linear estimate.

**Suggested fix:** Report `ALIGNED_BYTE_OFFSET` or the post-alignment byte to `PROACTIVE`, or better, track the *actual* byte the user is playing from after the align-poll resolves and report that.

---

### Bug 6 — `PROACTIVE` does not actually maintain a rolling window
**Severity:** High  
**File:** `app/src-tauri/src/commands/streaming.rs`, lines 842-858

**Evidence:**

```rust
let computed_max_ahead_byte = total_size;
let ahead_gaps: Vec<(u64, u64)> = find_gaps(&current_ranges, total_size)
    .into_iter()
    .filter(|(gap_start, gap_end)| *gap_end >= proactive_start_byte && *gap_start < max_ahead_byte)
    .map(|(gap_start, gap_end)| (gap_start.max(proactive_start_byte), gap_end.min(max_ahead_byte)))
    .collect();
```

`PROACTIVE` downloads from `proactive_start_byte` to EOF. It does not maintain a **rolling window** of fixed size; it downloads everything ahead of the playhead. This is intentional per comments, but it means `PROACTIVE` competes with `/stream` for every gap from the start to the end, not just the 40 s-ahead region.

**Why it breaks the design:** The design describes a rolling buffer where `PROACTIVE` stays 40 s ahead. Downloading everything ahead means `PROACTIVE` and `/stream` are chasing the same data until the file is fully cached, and the rate limiter is saturated.

**Suggested fix:** Cap the download window to a fixed size (e.g. 60-90 s of video) and re-evaluate only when the playhead advances. Do not download from `proactive_start_byte` all the way to EOF unless the user is in background-cache mode.

---

### Bug 7 — `byteToTimeTableRef` is only populated on align-poll jumps, so the green bar is linear for most of the file
**Severity:** High  
**File:** `app/src/hooks/useMSEPlayer.ts`, lines 873-889, 3107-3124, 3320-3325

**Evidence:**

```ts
const byteToTime = useCallback((bytePos: number): number => {
    const table = byteToTimeTableRef.current;
    if (table.length === 0 || state.current.fileLength <= 0) {
        return (bytePos / state.current.fileLength) * state.current.duration;
    }
    ...
}, []);
```

The table is only updated in the `checkPipeline` / `alignInterval` branches when `vbrCorrectionDepth > 0` and a jump happens. Before any VBR correction, the table is empty, so `byteToTime` is linear. For a VBR TS file, the green bar is drawn at the wrong time position.

**Why it breaks the design:** The green bar should represent the disk cache in actual video time. Linear mapping is wrong for VBR, so the bar appears behind or ahead of the real playhead.

**Suggested fix:** Populate `byteToTimeTableRef` from the backend `/fmp4/keyframes` endpoint whenever it returns data, not just from frontend jumps. The backend already has the authoritative byte-time keyframe index.

---

### Bug 8 — Green bar clamp filter drops ranges behind the playhead incorrectly
**Severity:** Medium  
**File:** `app/src/components/dashboard/FastStreamPlayer.tsx`, lines 400-409

**Evidence:**

```ts
for (const [s, e] of status.cached_ranges as [number, number][]) {
    const rangeStartTime = byteToTime(s);
    const rangeEndTime = byteToTime(e + 1);
    if (rangeEndTime < currentPlaybackTime - 5) continue;
    const clampedStart = Math.max(rangeStartTime, currentPlaybackTime - 5);
    ranges.push([clampedStart, rangeEndTime]);
}
```

A range that straddles `currentPlaybackTime - 5` has its start clamped to that point. This means the green bar is artificially shifted to start at the playhead. The disk cache may actually begin earlier (e.g. the bootstrap `/stream` downloaded from 0 to 15 MB), but the UI discards everything more than 5 s behind.

**Why it breaks the design:** It hides the real cache state and makes the bar appear/disappear when the playhead crosses a range. This is why the green bar "flashes and disappears".

**Suggested fix:** Do not clamp or hide ranges behind the playhead. Show the full disk cache state. The green bar is "what is cached on disk", not "what is ahead of the playhead".

---

### Bug 9 — `__nobuf_userSeekInProgress` is cleared too early, then re-set by VBR corrections
**Severity:** Medium  
**File:** `app/src/hooks/useMSEPlayer.ts`, lines 2675-2682, 3204-3221, 3375-3376

**Evidence:**

```ts
// 2682: set at start of seek
(window as any).__nobuf_userSeekInProgress = true;

// 3204-3206: VBR correction re-seeks while still in the alignInterval
clearInterval(alignInterval);
seekKeyframeAdjusted = true;
_mpegtsUnbufferedSeek(timeSeconds, duration, correctedByte, vbrCorrectionDepth);

// 3375-3376: cleared only when the current generation completes
if (mpegtsUnbufferedSeekGenerationRef.current === seekGen) {
    (window as any).__nobuf_userSeekInProgress = false;
}
```

A VBR correction re-enters `_mpegtsUnbufferedSeek`, increments the generation, and sets the flag again. But the flag is cleared by the *previous* generation's `finally` block before the new seek completes, because the generation counter has changed. Between the old `finally` and the new seek's first line, the flag is briefly `false`. The 500 ms poll in `FastStreamPlayer` can fire during that window and update the green bar, causing a flash.

**Why it breaks the design:** The flag is supposed to suppress UI updates during the entire seek + VBR correction chain. Because generations are nested and the flag is per-generation, the suppression leaks.

**Suggested fix:** Use a counter (e.g. `__nobuf_seekInProgressCount`) that is incremented at the start of every seek and decremented in `finally`, so nested VBR corrections keep the suppression active until the entire chain finishes.

---

### Bug 10 — `pendingRanges` / `reportRangesToBackend` uses `video/mp4` MIME type and 2 s debounce
**Severity:** Low  
**File:** `app/src/hooks/useMSEPlayer.ts`, lines 891-917

**Evidence:**

```ts
invoke('cmd_report_cached_ranges', {
    messageId: file.id,
    folderId: activeFolderId,
    totalSize: state.current.fileLength,
    filename: file.name,
    mimeType: 'video/mp4',
    ranges,
}).catch(() => {});
```

The MIME type is hardcoded to `video/mp4` even for TS files. This is not directly related to the prebuffer, but it pollutes the `CacheMeta` sidecar and can confuse `/fmp4` endpoints.

**Why it breaks the design:** `CacheMeta` should reflect the actual file type. A wrong MIME type makes the cache meta unreliable.

**Suggested fix:** Use the actual file MIME type.

---

## 3. PIPELINE TRACE: A TYPICAL SEEK

1. **User seeks to `T = 707 s`** in a 2073 s VBR TS file.
2. **Frontend `_mpegtsUnbufferedSeek`**:
   - Linear estimate: `RAW_BYTE_OFFSET ≈ (707/2073) * filesize`.
   - `ALIGNED_BYTE_OFFSET = RAW_BYTE_OFFSET - 2 MB`.
   - `ioctl.seek(ALIGNED_BYTE_OFFSET)`.
   - Reports `byteOffset: RAW_BYTE_OFFSET` to backend.
3. **Backend `/stream`** receives a range request starting at `ALIGNED_BYTE_OFFSET`.
   - Fast path check: no cache → MISS.
   - Cold-start check: no meta or empty cached_ranges → `skip_poll = true`.
   - Falls back to Telegram and downloads the first ~12.5 MB chunk, writing it to `.dat`.
   - Meta flush every 1 MB (2 chunks).
4. **Backend `PROACTIVE`**:
   - `cmd_report_playback_position` is called by frontend.
   - Cold-start guard: meta exists but no cached ranges yet → returns `false`.
   - Later, after `/stream` has written a range, `cmd_report_playback_position` passes the guard.
   - It reads `latest_current_byte = RAW_BYTE_OFFSET`.
   - `start_byte` is set to `RAW_BYTE_OFFSET`.
   - `proactive_start_byte = RAW_BYTE_OFFSET + (40/2073 * filesize)`.
   - For a VBR file, 40 s of average bitrate is often much smaller than 40 s of local bitrate, so `proactive_start_byte` may be only a few MB ahead of `RAW_BYTE_OFFSET`, inside `/stream`'s first 12.5 MB chunk.
   - `jumped` is set to `true` only if `latest_current_byte + 10 MB < start_byte` (backward seek). For most forward seeks, `jumped = false`.
   - `skip_all_gaps = false` → inner loop starts downloading immediately.
   - Because `/stream` is also downloading, both compete for the same Telegram semaphore. `FLOOD_PREMIUM_WAIT` is triggered.
5. **Frontend `/stream` response**:
   - First chunk arrives at `ALIGNED_BYTE_OFFSET` (linear estimate). TSDemuxer resyncs.
   - The align poll detects that the audio buffer is 20 s ahead of target (VBR correction).
   - It calls `_mpegtsUnbufferedSeek(time, duration, correctedByte)` again.
   - The flag flips, `clearDownloadedRanges` runs, green bar clears.
6. **VBR correction second pass**:
   - New `RAW_BYTE_OFFSET` is the corrected byte.
   - `/stream` seeks again.
   - `PROACTIVE` now sees a new `latest_current_byte` and updates `start_byte`, but because of the 5 s yield bug and `jumped` reset, it may still download immediately or skip without real yield.
7. **Green bar**:
   - `byteToTime` is linear until the VBR correction caches a keyframe.
   - The clamp filter discards ranges more than 5 s behind the playhead.
   - The bar flashes on first bootstrap, disappears during VBR correction, and reappears at the wrong time position.

**Result:** The user sees a "double prebuffer", long delays, and a flashing green bar.

---

## 4. EDGE CASE ANALYSIS

| Edge case | What happens | Why |
|---|---|---|
| Cold-start play (no meta) | `PROACTIVE` is deferred until `/stream` writes meta. | Cold-start guard. |
| First seek to a VBR region | `PROACTIVE` start byte is linear estimate + average bitrate 40 s. | Wrong base byte and wrong bitrate. |
| Backward seek > 10 MB | `jumped` set to `true`, but reset before yield. | 2 s sleep may run once, then no 5 s yield. |
| Rapid repeated seeks | `cmd_report_playback_position` returns `false` because `has_proactive_task` is true. | Proactive task keeps running but with stale/updated target. |
| `/stream` 3 s fallback | `/stream` downloads from Telegram before PROACTIVE can flush 1 MB. | Timeout too short. |
| PROACTIVE EOF window | Downloads everything from `proactive_start_byte` to EOF. | No rolling window size. |
| Green bar during VBR correction | Flag flips between generations; bar updates mid-correction. | Per-generation flag instead of counter. |
| TS files with sparse keyframe index | `byteToTime` falls back to linear for most bytes. | Table only populated on jumps. |

---

## 5. RECOMMENDATIONS (PRIORITIZED)

1. **Fix the byte-reporting contract.**
   - Frontend should report the **actual aligned / resolved keyframe byte** to `cmd_report_playback_position`, not `RAW_BYTE_OFFSET`.
   - Backend should use that byte as the playhead, not add another 40 s offset on top of a raw estimate.

2. **Fix the yield / jumped logic.**
   - Keep `jumped = true` through the first post-seek outer loop iteration.
   - Run the 5 s interruptible yield **before** any gap download after a seek.
   - Run the 2 s sleep at the start of the outer loop, not after deciding to skip gaps.

3. **Remove or relax the cold-start guard.**
   - Allow `PROACTIVE` to start immediately on an explicit seek report.
   - Only defer when the frontend has no byte offset and the file is truly cold.

4. **Make `/stream` wait for `PROACTIVE`.**
   - Set `FALLBACK_TIMEOUT_MS` to 30 s (or make it adaptive).
   - Count `proactive_tasks` as active downloads.
   - Do not fall back to Telegram unless the user explicitly seeks to an uncached region and no proactive task is running.

5. **Cap `PROACTIVE` to a rolling window.**
   - Download only a fixed amount ahead (e.g. 60-90 s) and slide as the playhead moves.
   - Use EOF-mode only for background cache.

6. **Fix the green bar data model.**
   - Populate `byteToTimeTableRef` from backend `/fmp4/keyframes`.
   - Remove the `currentPlaybackTime - 5` clamp.
   - Use a nested seek-in-progress counter instead of a boolean.

7. **Fix the MIME type in `cmd_report_cached_ranges`.**

8. **After implementing, verify with a controlled test:**
   - Seek to a known VBR time.
   - Confirm `/stream` logs `CACHE-POLL` before any `STREAM-FALLBACK`.
   - Confirm `PROACTIVE` logs `SEQUENTIAL download gap` starting at least 40 s ahead of the *actual* playhead byte.
   - Confirm `PREBUFFER HIT` appears for ranges beyond the 40 s mark.

---

**Summary:** The system is not "broken in one place"; it is a cascade of interacting defects. The most important fixes are (1) the wrong byte reported to PROACTIVE, (2) the disabled yield logic, (3) the cold-start guard that prevents PROACTIVE from starting early, and (4) the `/stream` fallback timeout that gives up before PROACTIVE can deliver. Fix those four and the remaining issues become solvable UI polish.
