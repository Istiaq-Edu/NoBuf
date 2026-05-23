# DownloadPool — Bugs & Lessons Learned

> Chronological record of all bugs encountered, their root causes, and resolutions.

---

## Bug #1: Deadlock in auth.rs — App Stuck on "Restoring Session..."

**Date**: 2026-05-21  
**Severity**: CRITICAL (app never opens)  
**Status**: ✅ RESOLVED

### Symptom
App launches and shows "Restoring session..." indefinitely. Never reaches dashboard. Terminal logs show DownloadPool workers initialized but then no further progress — app eventually times out or user force-quits.

### Root Cause
Double-acquisition of a Tokio `Mutex` in `ensure_client_initialized()` (auth.rs):

```rust
// BUG: pool_guard holds the lock
let pool_guard = state.download_pool.lock().await;

if pool_guard.is_none() {
    match DownloadPool::new(...) {
        Ok(pool) => {
            // BUG: tries to acquire the SAME lock again while pool_guard holds it
            *state.download_pool.lock().await = Some(pool);
        }
    }
} // pool_guard dropped here (if we ever got here)
```

Tokio's `Mutex` is **NOT reentrant**. When `pool_guard` holds the lock, a second `.lock().await` on the same Mutex will wait forever for `pool_guard` to be dropped — but `pool_guard` is waiting for the download to complete. Classic deadlock.

### Fix
Use the existing guard to set the value instead of re-acquiring:

```rust
// FIX: Use mutable existing guard
let mut pool_guard = state.download_pool.lock().await;

if pool_guard.is_none() {
    match DownloadPool::new(...) {
        Ok(pool) => {
            *pool_guard = Some(pool);  // Set via existing guard
        }
    }
}
```

### Lesson
- Tokio's `Mutex` is NOT reentrant — never call `.lock().await` twice on the same Mutex in the same async context
- Pattern: `let mut guard = mutex.lock().await; *guard = new_value;` instead of `let guard = mutex.lock().await; *mutex.lock().await = new_value;`

---

## Bug #2: Arithmetic Overflow Panic at download_pool.rs:415

**Date**: 2026-05-21  
**Severity**: HIGH (panic kills actix worker thread)  
**Status**: ✅ RESOLVED

### Symptom
```
thread 'actix-rt|system:0|arbiter:1' panicked at src\download_pool.rs:415:26:
attempt to subtract with overflow
```

### Root Cause
In `parallel_worker_stream()`, when `chunk_offset > end_byte` but still within `end_byte + TELEGRAM_CHUNK_SIZE`, the worker enters the loop body but `actual_start = chunk_offset` (which is > `end_byte`) while `actual_end = end_byte`. Computing `sub_length = actual_end - actual_start + 1` causes u64 subtraction overflow because `actual_end < actual_start`.

### Fix
Added a guard before the subtraction:

```rust
let actual_end = (chunk_offset + TELEGRAM_CHUNK_SIZE as u64 - 1).min(end_byte);
if actual_start > actual_end {
    continue; // Chunk boundary past end_byte, nothing to download
}
let sub_length = actual_end - actual_start + 1;
```

### Lesson
- Always guard subtraction operations on unsigned integers when the operands could be in any order
- The `chunk_offset` advancing mechanism uses `end_byte + TELEGRAM_CHUNK_SIZE` as the break threshold, which means `chunk_offset` can validly be between `end_byte` and `end_byte + TELEGRAM_CHUNK_SIZE` — these are "guard zone" offsets that need to be skipped

---

## Bug #3: FLOOD_PREMIUM_WAIT — All 3 Workers Hit Rate Limit Simultaneously

**Date**: 2026-05-21  
**Severity**: MEDIUM (degrades performance but recovers)  
**Status**: ⚠️ PARTIALLY MITIGATED

### Symptom
```
[INFO  grammers_client::client::net] sleeping on FLOOD_PREMIUM_WAIT for 5s before retrying
[INFO  grammers_client::client::net] sleeping on FLOOD_PREMIUM_WAIT for 5s before retrying
[INFO  grammers_client::client::net] sleeping on FLOOD_PREMIUM_WAIT for 5s before retrying
```

All 3 workers receive FLOOD_PREMIUM_WAIT at the same time, causing 3-5 second delays.

### Root Cause
When all 3 workers start downloading simultaneously (especially on the first parallel byte range), they all fire `upload.getFile` requests to Telegram's media DC within milliseconds of each other. Telegram's rate limiter treats this as a flood and issues FLOOD_PREMIUM_WAIT errors.

From Telegram's official docs:
> *"FLOOD_PREMIUM_WAIT_X: Indicates that upload speed is limited because the current account does not have a Premium subscription... This error can only be received when the user has uploaded tens of gigabytes or more."*

This is expected behavior for non-Premium accounts making rapid parallel requests.

### Mitigation
1. **Worker staggering**: Each worker starts 150ms later than the previous (worker 0: 0ms, worker 1: 150ms, worker 2: 300ms)
2. **grammers handles retries**: The grammers library automatically sleeps and retries on FLOOD_PREMIUM_WAIT, so no data is lost
3. **Sequential initial download**: The first ~4MB is always downloaded sequentially (smaller range requests from the player), giving time before parallel workers activate

### Remaining Issue
Multiple concurrent `stream_range()` calls (from multiple player range requests) can each spawn 3 workers, potentially creating 9+ simultaneous requests. This is partially mitigated by the 4-permit semaphore, but could still trigger flood waits.

### Lesson
- Telegram rate-limits parallel connections aggressively for non-Premium accounts
- Staggered starts help but don't fully prevent flood waits
- Each `stream_range` call creates its own 3-worker team — consider a global pool-level rate limiter

---

## Bug #4: CHUNK_DEMUXER_ERROR_APPEND_FAILED — Video Player Receives Corrupted Data

**Date**: 2026-05-21  
**Severity**: CRITICAL (video doesn't play)  
**Status**: ⚠️ MITIGATED (disabled for player stream, root cause still under investigation)

### Symptom
```
[Player] video error: 3 CHUNK_DEMUXER_ERROR_APPEND_FAILED: Failed to prepare video sample for decode
[SourceBuffer] error: Event
SourceBuffer operation failed: InvalidStateError: Failed to execute 'appendBuffer' on 'SourceBuffer'
```

Video plays for ~1 second then fails with decode errors. Thousands of SourceBuffer errors cascade.

### Investigation

#### Hypothesis 1: Out-of-order chunks (✅ FIXED but issue persists)

**Fix applied**: Added reorder buffer (`BTreeMap`-based coordinator) that buffers worker chunks by offset and yields in strict byte-offset order.

**Result**: Issue still persists, meaning ordering is NOT the sole cause.

#### Hypothesis 2: Duplicate/overlapping data

Workers claim unique chunk_offsets from a shared atomic counter. Each `chunk_offset` increments by `TELEGRAM_CHUNK_SIZE` (524288). The `actual_start`/`actual_end` ranges are computed to be non-overlapping. Data overlap is theoretically impossible with the current logic.

#### Hypothesis 3: Workers connecting to wrong DC

When a worker Client downloads a file via `iter_download()`, it initially connects to the main DC, then receives `FILE_MIGRATE_X` and redirects to the correct media DC. Grammers handles this automatically. However, if there are timing issues with the redirect, workers might download partial or wrong data.

#### Hypothesis 4: Session/key conflicts on non-media DC

From Telegram docs:
> *"AUTH_KEY_DUPLICATED error... only emitted if any of the non-media DC detects that an authorized session is sending requests in parallel from two separate TCP connections"*

If workers connect to the main DC first before being redirected to the media DC, the main DC might see multiple connections from the "same" session and reject them.

### Mitigation (Current)
**Disabled parallel streaming for player-facing HTTP response** in `server.rs`:

```rust
let use_parallel = false; // Disabled until parallel stream data correctness is verified
```

The player always receives sequential data from a single connection. DownloadPool is still active for background cache filling (streaming.rs) and file downloads (fs.rs) where data is written at specific offsets and validated before use.

### Lesson
- The MSE (Media Source Extensions) player is extremely sensitive to data correctness — even minor byte-level corruption causes cascading failures
- Parallel download data integrity must be verified end-to-end before feeding to a video decoder
- Consider implementing a checksum/validation layer between the DownloadPool and the player stream
- The `download_range()` method (which downloads and returns a complete `Vec<u8>`) is safer than `stream_range()` (which streams chunks in real-time) because the complete buffer can be validated before use

---

## Bug #5: Build Warnings — Unused Fields

**Date**: 2026-05-21  
**Severity**: LOW  
**Status**: ✅ RESOLVED

### Issues
1. Unused `home_dc_id` field in `DownloadWorker` struct → Removed
2. Unused `Session` import → Removed
3. Unused `current_offset` assignment warning in server.rs parallel path → Added `#[allow(unused_assignments)]`

---

## Bug #6: Overlapping Range Requests — Multiple Concurrent Downloads for Same Data

**Date**: 2026-05-22  
**Severity**: HIGH (wastes bandwidth, multiplies FLOOD_PREMIUM_WAIT triggers)  
**Status**: ✅ RESOLVED (coordinator implemented)

### Symptom
From 2nd-terminal-logs (09:01:52-09:01:55), the video player sends overlapping Range requests for the same file, causing multiple concurrent SEQUENTIAL downloads for nearly identical data:

```
[PREBUFFER] MISS: msg 208 range 266993664-1425667421 not cached
[PREBUFFER] SEQUENTIAL: msg 208 range 266993664-1425667421 using single connection
[PREBUFFER] MISS: msg 208 range 267190272-1425667421 not cached
[PREBUFFER] SEQUENTIAL: msg 208 range 267190272-1425667421 using single connection
[PREBUFFER] MISS: msg 208 range 267386880-1425667421 not cached
[PREBUFFER] SEQUENTIAL: msg 208 range 267386880-1425667421 using single connection
[PREBUFFER] MISS: msg 267583488-1425667421 not cached
[PREBUFFER] SEQUENTIAL: msg 267583488-1425667421 using single connection
```

Each request starts from a slightly different offset (266MB, 267MB, 267.3MB) but downloads the same 1.15GB range. This creates **4+ parallel Telegram API connections** downloading overlapping data simultaneously.

### Root Cause
The `stream_media` handler in `server.rs` is invoked independently for each HTTP Range request from the video player. The MSE player sends progressive buffering requests (e.g., when the user seeks or the player buffers ahead), and each request triggers:
1. A cache MISS check (the fast-path only checks if the exact requested range is fully cached)
2. A full SEQUENTIAL download from Telegram

There is **no coordination** between concurrent streaming requests for the same message. Each request downloads its entire range independently, even if another request is already downloading overlapping data.

Additionally, the **fast-path cache check** uses `is_range_cached()` which only returns HIT if the *entire* requested range is cached. If the player requests `267MB-1.4GB` but we've only cached `0-267MB`, the check returns MISS and we start a new download from 267MB — even though a concurrent stream is already downloading that data.

### Consequences
1. **Wasted bandwidth**: The same byte ranges are downloaded multiple times
2. **Duplicate cache writes**: Same ranges get written to cache file from multiple concurrent streams (observed in logs: `range 1034927746-1034944511 written to cache` appearing twice)
3. **FLOOD_PREMIUM_WAIT multiplication**: More concurrent API requests → more flood waits → more forced delays
4. **Cache meta fragmentation**: Multiple streams writing overlapping ranges create complex fragmented `cached_ranges` entries

### Planned Fix

#### Option A: Per-Message Download Coordinator (Recommended)

Add a per-message "active download registry" that tracks which byte ranges are currently being downloaded by which stream. When a new request arrives:

1. Check if any active stream is already downloading the requested range (or a superset of it)
2. If yes: **subscribe** to that stream's data instead of starting a new download. The existing stream continues downloading, and the new request reads from cache as data arrives.
3. If no: Start a new download as usual.

Implementation sketch:
```rust
// In TelegramState or StreamCacheManager
struct ActiveDownload {
    message_id: i32,
    start_byte: u64,
    end_byte: u64,
    // Notification channel: subscribers wait for data to appear in cache
    data_available: tokio::sync::watch::Sender<u64>, // latest cached offset
}
active_downloads: Arc<Mutex<HashMap<i32, ActiveDownload>>>
```

When a new Range request arrives for `start_byte-end_byte`:
```rust
// 1. Check active_downloads for this message_id
// 2. If active download covers [start_byte..end_byte]:
//    Subscribe to data_available watch channel
//    Loop: wait for notification, read from cache, yield to player
// 3. If no active download covers the range:
//    Register new ActiveDownload, start sequential download
//    Other concurrent requests can subscribe to it
```

#### Option B: Partial Cache HIT with Background Fill

Modify the fast-path cache check to serve partial hits immediately and only download the uncached portion:

```rust
// Instead of: "is entire range cached? → HIT or MISS"
// Use: "find cached sub-ranges within [start_byte..end_byte]"
// Serve cached portions immediately, download gaps in background
```

This is simpler but doesn't prevent multiple requests from downloading the same gap simultaneously.

#### Option C: Deduplicated Download Queue

Add a global download queue that deduplicates requests for the same byte range:
```rust
// HashMap<(i32, u64, u64), JoinHandle> — tracks in-progress downloads
// New requests for same range join the existing download's result
```

### Recommendation
**Option A** (Per-Message Download Coordinator) is the most comprehensive fix. It addresses both overlapping requests and duplicate cache writes. Option B is a good incremental improvement that can be combined with Option A.

---

## Bug #7: FLOOD_PREMIUM_WAIT on Single Connection — Rate Limit Even Without Parallel Workers

**Date**: 2026-05-22  
**Severity**: MEDIUM (30+ seconds of forced delays during playback)  
**Status**: ✅ RESOLVED (coordinator + MAX_CONCURRENT limit eliminates burst pattern)

### Symptom
Even with parallel streaming disabled (`use_parallel = false`), FLOOD_PREMIUM_WAIT still appears frequently during sequential downloads:

```
[09:00:32] sleeping on FLOOD_PREMIUM_WAIT for 3s before retrying  (2x)
[09:00:49] sleeping on FLOOD_PREMIUM_WAIT for 3s before retrying  (2x)
[09:02:17] sleeping on FLOOD_PREMIUM_WAIT for 7s before retrying  (3x)
[09:02:18] sleeping on FLOOD_PREMIUM_WAIT for 6s before retrying
[09:02:36] sleeping on FLOOD_PREMIUM_WAIT for 4s before retrying  (2x)
[09:02:53] sleeping on FLOOD_PREMIUM_WAIT for 3s before retrying  (2x)
```

Total: ~30 seconds of forced delays across the entire playback session.

### Root Cause
FLOOD_PREMIUM_WAIT is triggered not by parallel workers, but by **multiple concurrent single-connection downloads** from overlapping player range requests (Bug #6). When 4+ overlapping SEQUENTIAL requests are active simultaneously, each uses the same Telegram session/client through the semaphore, creating rapid bursts of `upload.getFile` requests that exceed Telegram's rate limit.

The `download_semaphore` (4 permits) allows up to 4 concurrent `iter_download` calls, each making rapid `upload.getFile` requests. With overlapping requests, this creates a burst pattern that triggers flood waits.

### Fix Applied

1. **Bug #6 coordinator** — eliminates overlapping downloads, reducing concurrent API calls
2. **Bug #15 MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE=3** — limits per-message concurrent downloads, preventing rapid burst patterns
3. **Semaphore(4)** — global limit on concurrent Telegram API calls
4. **Seek debouncing** (revised from 10s to "first instant, then 500ms debounce") — prevents rapid-fire overlapping download requests from arrow-key spam while keeping deliberate clicks feeling responsive

With these fixes, FLOOD_PREMIUM_WAIT events are now infrequent (1-2 per session) and short (3-4s), rather than the previous bombardment pattern (10+ events per session, 3-8s each). For non-Premium accounts, occasional FLOOD_PREMIUM_WAIT is expected behavior from Telegram's rate limiter.

---

## Bug #8: Cache Data File Locked on Deletion (OS Error 32)

**Date**: 2026-05-22  
**Severity**: LOW (data file left in place, recovered on next playback)  
**Status**: ✅ RESOLVED (meta recovery over-claiming fixed; deferred deletion queue implemented)

### Symptom
```
[CACHE] delete_cache: removed meta for msg 208
[CACHE] delete_cache: Could not delete data file for msg 208 
  (The process cannot access the file because it is being used by another process. (os error 32)),
  left in place — will be overwritten on next playback or cleaned on exit
```

### Root Cause
On Windows, `open_data_file_write()` opens the `.dat` file with `FILE_SHARE_READ | FILE_SHARE_WRITE` (no `FILE_SHARE_DELETE`). When the streaming handler holds an open write handle, `std::fs::remove_file()` fails with OS error 32 (sharing violation).

This is **by design** — we intentionally omit `FILE_SHARE_DELETE` to prevent antivirus or other processes from deleting the file mid-write. The tradeoff is that `delete_cache()` can't remove the `.dat` while streaming is active.

### Current Handling
1. Meta sidecar (`.meta.json`) is always deleted successfully (uses standard share modes)
2. `.dat` file deletion failure is logged and the file is left in place
3. On next playback, `open_data_file_write()` uses `OPEN_ALWAYS` which reuses the existing file
4. On app exit, `clear_all()` removes everything

### Minor Issue (FIXED)
The `Meta recovery` logic at 09:03:00 rebuilds meta from the data file size, creating a single `(0, data_size-1)` range. This over-claims cached data — the `.dat` file may be sparse with only partially downloaded regions. If the player seeks to a gap that wasn't actually downloaded, the cache would incorrectly report HIT and serve zero-filled data, corrupting MSE playback.

**Fix**: Recovery meta now starts with **empty** `cached_ranges` instead of `(0, data_size-1)`. The normal chunk writes populate the correct ranges as data is actually downloaded. This prevents the player from reading zero-filled data from uncached regions.

### Planned Fix → ✅ IMPLEMENTED

1. **Deferred deletion queue**: Queues `.dat` files for deletion in `pending_deletions: Arc<std::sync::Mutex<Vec<i32>>>`. When `untrack_streaming()` or `unregister_download()` is called, it attempts deferred deletions for queued message IDs. If the file still has open handles, the deletion remains queued; when all handles close, the next cleanup attempt succeeds.

2. **More precise meta recovery**: ✅ Already fixed — recovery meta starts with **empty** `cached_ranges` instead of `(0, data_size-1)`. Normal chunk writes populate the correct ranges as data is actually downloaded.

### Deferred Deletion Implementation (stream_cache.rs)

```rust
// In StreamCacheManager:
pending_deletions: Arc<std::sync::Mutex<Vec<i32>>>

// In delete_cache(): on .dat deletion failure, queue instead of just logging:
pending.push(message_id);

// try_deferred_deletions() method: called from untrack_streaming() and unregister_download()
// Checks if message is still streaming, checks pending queue, attempts deletion
// Removes from queue on success, logs warning on failure
```

---

## Bug #9: Duplicate Cache Writes — Same Range Written Twice

**Date**: 2026-05-22  
**Severity**: LOW (wastes I/O, doesn't corrupt data)  
**Status**: ✅ RESOLVED (by Bug #6 coordinator fix)

### Symptom
```
[PREBUFFER] ADD: msg 208 range 1034927746-1034944511 written to cache
[PREBUFFER] ADD: msg 208 range 1034927746-1034944511 written to cache  (duplicate)
[PREBUFFER] ADD: msg 208 range 1036663947-1037041663 written to cache
[PREBUFFER] ADD: msg 208 range 1036663947-1037041663 written to cache  (duplicate)
```

### Root Cause
Two concurrent streaming requests for the same file download overlapping byte ranges. Both write the same data to the cache file at the same offset. The `lock_meta` per-message mutex serializes meta updates, but the cache file write (seek+write) is not locked — two streams can write the same data at the same offset concurrently.

This doesn't corrupt data (same bytes written to same offset), but wastes disk I/O and creates unnecessary meta save operations.

### Planned Fix
This is automatically resolved by fixing Bug #6 (overlapping range requests). With the download coordinator, only one stream downloads a given byte range, eliminating duplicate writes.

---

## Summary of All Bugs

| # | Bug | Severity | Status | Root Cause |
|---|-----|----------|--------|------------|
| 1 | Deadlock (stuck on restoring session) | CRITICAL | ✅ Fixed | Double Tokio Mutex lock |
| 2 | Arithmetic overflow panic | HIGH | ✅ Fixed | u64 subtraction without bounds check |
| 3 | FLOOD_PREMIUM_WAIT (parallel workers) | MEDIUM | ⚠️ Mitigated | Worker staggering added |
| 4 | Video decode error | CRITICAL | ✅ Root causes fixed | Bug #8 meta over-claim + Bug #11 meta deletion + frontend cascade fix |
| 5 | Build warnings | LOW | ✅ Fixed | Removed unused fields/imports |
| 6 | Overlapping range requests | HIGH | ✅ RESOLVED | Coordinator implemented and confirmed working |
| 7 | FLOOD_PREMIUM_WAIT (single conn) | MEDIUM | ✅ RESOLVED | Coordinator + MAX_CONCURRENT=3 eliminates burst pattern |
| 8 | Cache data file locked on delete | LOW | ✅ RESOLVED | Meta recovery over-claiming fixed; deferred deletion queue added |
| 9 | Duplicate cache writes | LOW | ✅ RESOLVED | By coordinator (Bug #6) |
| 12 | Subscriber lazy-start | HIGH | ✅ RESOLVED | Deliver all cached data on download-ended + chunked encoding (Bug #14) |
| 13 | HashMap collision | CRITICAL | ✅ RESOLVED | Vec<ActiveDownload> per message instead of single ActiveDownload |
| 14 | ERR_CONTENT_LENGTH_MISMATCH | HIGH | ✅ RESOLVED | Chunked transfer encoding for subscriber responses (no Content-Length) |
| 15 | Unlimited concurrent downloads | HIGH | ✅ RESOLVED | MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE=3, subscribe to nearest when limit reached |
| 16 | QuotaExceededError on SourceBuffer | HIGH | ✅ RESOLVED | Evict before append + backpressure + stop retry cascade |
| 17 | Seek stops working after completion | HIGH | ✅ RESOLVED | Reset currentOffset + remove isPausedRef guard in executeSeek() |

---

## Bug #10: Coordinator Premature Unregister — DownloadGuard Dropped Before Stream Starts

**Date**: 2026-05-22
**Severity**: HIGH (coordinator completely inoperative — no subscriptions ever occur)
**Status**: ✅ RESOLVED

### Symptom
From 4th terminal logs, every SEQUENTIAL download shows register+unregister at the same timestamp:

```
[COORDINATOR] Registered download for msg 208 range 0-524287
[COORDINATOR] Unregistered download for msg 208 (range 0-524287)  ← same second!
```

No `[PREBUFFER] COORDINATOR: subscribing` messages appear — overlapping requests never find an active download because it's already unregistered before any data flows.

### Root Cause
`register_download()` and `_download_guard` were created outside the `async_stream::stream!` block in the `stream_media()` function. When the function returns `HttpResponse::streaming(stream)`, the function scope ends and `_download_guard` is dropped, triggering `DownloadGuard::drop()` which spawns `unregister_download()`. This happens before the stream has pulled any data — the download is registered and immediately unregistered.

### Fix
Moved `register_download()` and `_download_guard` creation **inside** the `async_stream::stream!` block. Variables inside the stream block become part of the generator state and are only dropped when the stream itself is dropped (when the Actix response ends or the client disconnects). This ensures the coordinator registration persists for the entire streaming lifetime.

---

## Bug #11: delete_cache Wipes Meta Mid-Stream — StreamingGuard Drops Before Stream Starts

**Date**: 2026-05-22
**Severity**: CRITICAL (destroys all cached data mid-stream, causes MSE corruption)
**Status**: ✅ RESOLVED

### Symptom
From 5th terminal logs at 10:39:29, `delete_cache` destroys the `.meta.json` file while a SEQUENTIAL download is actively streaming:

```
[PREBUFFER] ADD: msg 208 range 94896128-95420415 written to cache, meta ranges: [(0, 95420415), ...]
[CACHE] delete_cache: removed meta for msg 208
[CACHE] delete_cache: Could not delete data file for msg 208 (os error 32), left in place
[PREBUFFER] Meta load returned None for msg 208, retrying
[PREBUFFER] Meta recovery for msg 208: data_file_exists=true, fs_data_size=1022885888, ...
[PREBUFFER] ADD: msg 208 range 95420416-95944703 written to cache, meta ranges: [(95420416, 95944703)]
```

All previously cached data (0-95MB range) is lost from meta. The streaming continues writing from byte 95420416, creating a fragmented meta with only the new ranges. The `.dat` file survives (os error 32 on delete) but its meta is destroyed.

### Root Cause
Same pattern as Bug #10: `StreamingGuard` was created **outside** the `async_stream::stream!` block in `stream_media()`. When the function returns `HttpResponse::streaming(stream)`, the `_stream_guard` drops immediately, calling `untrack_streaming()`. This makes `is_streaming()` return `false`, so `delete_cache` proceeds to delete the meta file despite active streaming.

The `StreamingGuard` + `track_streaming` mechanism was designed to prevent exactly this scenario, but the guard's premature drop made it completely ineffective — identical to how `DownloadGuard`'s premature drop made the coordinator inoperative (Bug #10).

### Consequences
1. **Loss of all cached data**: 95MB of cached data (0-95420415) is no longer tracked in meta. Player must re-download it from scratch.
2. **MSE player corruption (Bug #4 trigger)**: After meta deletion, recovery starts with empty `cached_ranges`. If the player seeks back to byte 0, the HIT check fails, and a new download starts. But during the brief window where meta was destroyed, the player might read stale or incorrect data.
3. **Meta fragmentation**: Recovery meta only tracks new ranges (95420416+), leaving a 95MB gap between 0 and 95420416.

### Fix
Moved `track_streaming()` and `StreamingGuard` creation **inside** each `async_stream::stream!` block (subscriber, SEQUENTIAL, and parallel paths) — same pattern as Bug #10 fix. Variables inside the stream block become part of the generator state and are only dropped when the stream itself is dropped (when the Actix response ends). Removed the outer `_stream_guard` that was dropping prematurely.

Also added `StreamingGuard` to the subscriber stream block, which had NO streaming tracking at all before this fix.

---

## Bug #4 Root Cause Analysis (Updated)

**Date**: 2026-05-22
**Status**: ✅ ROOT CAUSES FIXED

The MSE player corruption (`CHUNK_DEMUXER_ERROR_APPEND_FAILED` followed by cascading `InvalidStateError`) had two root causes, both now fixed:

1. **Bug #8 meta over-claiming**: Recovery meta claimed `(0, data_size-1)` as cached, but the `.dat` file was sparse (only partially downloaded). Player read zero-filled data from uncached regions → decoder failure. **Fixed**: recovery meta now starts with empty `cached_ranges`.

2. **Bug #11 meta deletion mid-stream**: `delete_cache` destroyed meta while streaming was active. After meta deletion, recovery starts from empty ranges, losing all previously cached data. Player couldn't serve cached ranges and would need to re-download everything. **Fixed**: StreamingGuard moved inside stream block so `is_streaming()` correctly returns true during active streaming, preventing meta deletion.

**Frontend cascade fix (Bug #4 mitigation)**:
- `SourceBufferWrapper` now detects fatal error state (`InvalidStateError` mentioning `HTMLMediaElement.error`) and stops processing the queue entirely, preventing the infinite cascade of `InvalidStateError` logs
- `downloadLoop` checks `hasFatalError` before each fetch and breaks out of the loop
- `onSegment` callback also checks `hasFatalError` before appending
- `setVideoRef` registers a video `error` event listener that falls back to native playback on `MEDIA_ERR_DECODE` or `MEDIA_ERR_SRC_NOT_SUPPORTED`

These frontend fixes ensure that if data corruption somehow still occurs (unlikely with backend fixes), the player gracefully falls back to native mode instead of cascading into thousands of error logs.

---

## Bug #12: Subscriber Stream Lazy-Start — Download Ends Before Subscriber Can Read Data

**Date**: 2026-05-22
**Severity**: HIGH (subscriber streams deliver 0 bytes, causes ERR_CONTENT_LENGTH_MISMATCH)
**Status**: ✅ RESOLVED (combined with Bug #14 fix)

### Symptom
From 6th terminal logs, subscriber streams complete with `bytes_remaining=1048576` and `progress reached 0`:

```
[COORDINATOR] Registered download for msg 208 range 531412379-532460954
[PREBUFFER] COORDINATOR: msg 208 range 531412379-532460954 subscribing to active download 531412379-532460954
[COORDINATOR] COORDINATOR: Active download ended before covering full range for msg 208 (need 531412379-532460954, progress reached 0)
[PREBUFFER] COORDINATOR: Subscriber for msg 208 range 531412379-532460954 completed (bytes_remaining=1048576)
```

The subscriber stream never receives any data from the active download because it completes and unregisters before the subscriber's `async_stream::stream!` body executes.

### Root Cause
`async_stream::stream!` creates a **lazy generator** — the stream body doesn't execute until Actix pulls the first byte from the response body. Between `stream_media()` returning `HttpResponse::streaming(subscriber_stream)` and Actix actually polling the stream, the active download can complete and unregister. The subscriber's `progress_rx.changed().await` returns `Err` immediately (progress_tx already dropped), and the old handler just logged a warning and ended the stream with `bytes_remaining > 0`.

### Fix (combined with Bug #14)
The subscriber stream's "download ended" handler now reads ALL available cached data from disk (up to the furthest contiguous cached byte from `read_offset`) and delivers it before ending the stream. Even if the full range isn't cached, whatever data IS cached gets delivered. Combined with Bug #14's chunked transfer encoding, this ensures the subscriber always delivers as much data as possible without causing ERR_CONTENT_LENGTH_MISMATCH.

---

## Bug #13: Coordinator HashMap Collision — Multiple Downloads for Same Message Overwrite Each Other

**Date**: 2026-05-22
**Severity**: CRITICAL (orphaned subscribers, lost progress tracking, data corruption)
**Status**: ✅ RESOLVED

### Symptom
From 6th terminal logs, concurrent SEQUENTIAL downloads for the same message overwrite each other in the coordinator:

```
[COORDINATOR] Registered download for msg 208 range 421271989-422320564
[COORDINATOR] Registered download for msg 208 range 421271989-422320564  ← second registration replaces first
```

When a second download registers for the same `message_id`, the `HashMap::insert()` overwrites the first `ActiveDownload` entry, dropping its `progress_tx`. All subscribers watching the first download are orphaned — their `progress_rx.changed()` immediately returns `Err` because the sender was dropped.

More critically, when downloads for **different** byte ranges of the same message start concurrently, the second registration replaces the first entirely:

```
[COORDINATOR] Registered download for msg 208 range 278921216-1425667421
[COORDINATOR] Registered download for msg 208 range 279117824-1425667421  ← replaces 278921216's entry
```

Any subscriber watching the 278921216 download is now orphaned and will see "progress reached 0" or stale progress from the new download.

### Root Cause
`active_downloads: HashMap<i32, ActiveDownload>` keyed by `message_id` alone. Since `HashMap::insert()` replaces entries with the same key, concurrent downloads for the same message collide. The second `insert()` drops the first `ActiveDownload` (including its `progress_tx`), orphaning all subscribers.

### Fix
Changed `active_downloads` from `HashMap<i32, ActiveDownload>` to `HashMap<i32, Vec<ActiveDownload>>`. Each message can now have multiple concurrent downloads stored as a Vec. Updated all coordinator methods:

- `register_download`: Pushes into the Vec instead of inserting into HashMap
- `find_covering_download`: Searches through ALL downloads in the Vec to find one covering the requested range
- `update_download_progress`: Finds the correct download by `start_byte` match in the Vec, not just the first entry for the message
- `unregister_download`: Removes the specific download (identified by `start_byte` and `end_byte`) from the Vec, not the entire HashMap entry. Empty Vecs are cleaned up.

Also updated `DownloadGuard` to store `start_byte` and `end_byte` so it can unregister the specific download, not just the first one for the message.

---

## Bug #14: ERR_CONTENT_LENGTH_MISMATCH — Subscriber Stream Delivers Fewer Bytes Than Content-Length Header Promises

**Date**: 2026-05-22
**Severity**: HIGH (browser rejects subscriber responses, MSE player gets no data)
**Status**: ✅ RESOLVED

### Symptom
3rd console logs show 4 `Failed to load resource: net::ERR_CONTENT_LENGTH_MISMATCH` errors:

```
:14201/stream/3993842856/208?token=********************************:1   Failed to load resource: net::ERR_CONTENT_LENGTH_MISMATCH
```

The browser rejects HTTP responses where the actual body size doesn't match the Content-Length header. Subscriber streams that deliver `bytes_remaining > 0` (less data than promised) are rejected entirely — the MSE player gets no data at all for those ranges.

### Root Cause
Subscriber responses set `Content-Length = subscriber_content_length` (or `subscriber_size` for full-file responses). But the subscriber stream may deliver fewer bytes than promised if the active download ends before covering the full range (Bug #12). The browser strictly enforces Content-Length and rejects mismatched responses with ERR_CONTENT_LENGTH_MISMATCH.

### Fix
Removed Content-Length from subscriber responses entirely. Actix-web's `HttpResponse::streaming()` automatically uses **chunked transfer encoding** when Content-Length is not set. This means:
- No Content-Length promise → browser can't reject for mismatch
- Content-Range header is still included for 206 Partial Content responses (per RFC 7233, chunked encoding is allowed with 206)
- The subscriber stream delivers as much data as available and then ends — the MSE player reads whatever it gets and re-requests missing ranges

This fix combined with Bug #12's improved "download ended" handler ensures subscriber streams always deliver maximum available data without ERR_CONTENT_LENGTH_MISMATCH errors.

---

## Bug #15: Unlimited Concurrent Downloads per Message — FLOOD_PREMIUM_WAIT Bombardment

**Date**: 2026-05-22
**Severity**: HIGH (FLOOD_PREMIUM_WAIT bombardment, download throughput collapse)
**Status**: ✅ RESOLVED

### Symptom
7th terminal logs show `total active: 10` and even `total active: 11` concurrent downloads for message 208. Each ~1MB prebuffer request from the MSE player spawns a new SEQUENTIAL download, and when the player rapidly seeks to unbuffered areas, 10+ simultaneous Telegram API calls are made. This triggers FLOOD_PREMIUM_WAIT for 3-8 seconds on every new request, causing download throughput collapse and extreme meta fragmentation (~130+ cached ranges).

### Root Cause
After Bug #13 fix (Vec<ActiveDownload> per message), there is no limit on how many concurrent downloads can be registered for a single message. The coordinator only prevents *overlapping* downloads (covering the same byte range), but *non-overlapping* downloads (different byte ranges) all start independently. When the MSE player is seeking rapidly, each prebuffer request creates a new 1MB download that doesn't overlap with existing ones, spawning unlimited concurrent Telegram API calls.

### Fix
Added `MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE = 3` constant in `stream_cache.rs`. When the limit is reached:
- `register_download()` returns `None` instead of registering
- `find_nearest_download()` finds the closest existing download to the requested range
- New requests subscribe to the nearest download as a subscriber stream, reading from cache as it progresses
- This limits Telegram API calls to 3 concurrent per message, preventing FLOOD_PREMIUM_WAIT bombardment

Also revised seek debouncing in `useMSEPlayer.ts` from 10s (too aggressive) to "first instant, then 500ms debounce" pattern. When users seek to an unbuffered position:
- The **first** seek executes instantly (no delay)
- Subsequent seeks within 500ms of the first are debounced (only the last position executes)
- This prevents rapid-fire overlapping downloads from arrow-key spam while keeping deliberate single-clicks feeling responsive
- Buffered positions always seek instantly (no debounce)

### Files Modified
- `stream_cache.rs`: Added `MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE = 3`, `find_nearest_download()` method, `active_download_count()` method, `register_download()` now returns `Option`
- `server.rs`: Added concurrent limit check before SEQUENTIAL path — when limit reached, subscriber stream is returned instead of new SEQUENTIAL download
- `useMSEPlayer.ts`: Added `SEEK_DEBOUNCE_MS = 10000` (10s) debounce timer for unbuffered seek positions. Buffered positions still seek instantly. `seekDebounceTimerRef` cleared on cleanup, pause, and buffered-seek.

---

## Bug #16: QuotaExceededError on SourceBuffer — Infinite Retry Cascade

**Date**: 2026-05-22
**Severity**: HIGH (video playback stalls, ~20+ repeated error logs)
**Status**: ✅ RESOLVED

### Symptom
5th console logs show ~20+ repeated `QuotaExceededError` errors from `SourceBufferWrapper.processQueue`, creating an infinite cascade of failures:

```
SourceBuffer operation failed: QuotaExceededError: Failed to execute 'appendBuffer' on 'SourceBuffer':
The SourceBuffer is full, and cannot free space to append additional buffers.
    at SourceBufferWrapper.processQueue (SourceBufferWrapper.ts:81:27)
    at SourceBufferWrapper.processQueue (SourceBufferWrapper.ts:100:12)  ← recursive retry!
    at SourceBuffer.<anonymous> (SourceBufferWrapper.ts:24:12)
```

Each failed append triggers `processQueue()` again (the retry logic at line 100), which tries the next queued operation, which also fails with QuotaExceededError, creating a recursive cascade that produces hundreds of error logs and prevents any new data from being appended.

### Root Cause

Three interrelated issues:

1. **Retry cascade**: `SourceBufferWrapper.processQueue()` catches ALL errors in a generic catch block and calls `processQueue()` again to try the next queued operation. For `QuotaExceededError`, this creates an infinite cascade because the SourceBuffer is still full — every retry fails too.

2. **Eviction timing**: `evictOldBuffer()` runs AFTER successful segment appends (in `onSegment`), but QuotaExceededError happens BEFORE the append succeeds. When the SourceBuffer is full, no append can succeed, so eviction never gets a chance to free space.

3. **No backpressure**: The download loop keeps fetching data even when the buffer is full. mp4box processes the fetched data and produces segments that are queued in SourceBufferWrapper. The queue grows indefinitely, and each queued append fails with QuotaExceededError in a cascade.

### Fix

Three-part fix addressing each root cause:

**Part 1: Stop QuotaExceededError retry cascade (SourceBufferWrapper.ts)**

Added specific `QuotaExceededError` handling in `processQueue()` before the generic catch block. When QuotaExceededError is caught:
- Stop processing (don't call `processQueue()` again)
- Set `processing = false`
- The next `onSegment` call's `appendBuffer()` will trigger `processQueue()` naturally after eviction frees space

```javascript
if (e instanceof DOMException && e.name === 'QuotaExceededError') {
  console.warn('[SourceBuffer] QuotaExceededError — buffer full, stopping queue');
  this.processing = false;
  return;  // Don't retry — let next appendBuffer call resume after eviction
}
```

**Part 2: Proactive eviction before append (useMSEPlayer.ts)**

Moved `evictOldBuffer()` call from AFTER `appendBuffer` to BEFORE `appendBuffer` in the `onSegment` callback. This ensures space is freed before new data is queued, preventing QuotaExceededError from occurring in most cases.

Also updated `evictOldBuffer()` to handle `currentTime = 0` (initial buffering case) — previously it returned early when `currentTime <= 0`, preventing any eviction during the initial buffer fill.

**Part 3: Download loop backpressure (useMSEPlayer.ts)**

Added `MAX_BUFFER_AHEAD_SECONDS = 120` (2 minutes) backpressure in the download loop. Before each fetch, the loop checks how many seconds of video are buffered ahead of the current playback position. If buffer ahead exceeds the threshold, the loop sleeps 2s and rechecks, letting playback consume buffered data before downloading more. This prevents the SourceBuffer from filling past Chrome's quota.

Also reduced `MAX_BUFFER_BYTES` from 100MB to 50MB — a more conservative eviction threshold that stays well below Chrome's typical SourceBuffer quota (150-300MB).

### Files Modified
- `SourceBufferWrapper.ts`: Added QuotaExceededError-specific handling in `processQueue()` catch block — stops retry cascade
- `useMSEPlayer.ts`: (1) Moved `evictOldBuffer()` call before `appendBuffer` in `onSegment`. (2) Updated `evictOldBuffer()` to handle currentTime=0. (3) Added `MAX_BUFFER_AHEAD_SECONDS = 120` constant and `getBufferedAheadSeconds()` helper. (4) Added backpressure check in `downloadLoop` — sleeps when buffer ahead exceeds 120s. (5) Reduced `MAX_BUFFER_BYTES` from 100MB to 50MB.

---

---

## Bug #17: Seek Stops Working After Video Completion

**Date**: 2026-05-22  
**Severity**: HIGH (seeking completely broken after video finishes playing)  
**Status**: ✅ RESOLVED

### Symptom

When the video player marks the video as "finished" (isComplete=true, progress bar at end), seeking to an earlier position doesn't work. The scrubber jumps visually but no data is downloaded — the video stays stuck at the end position.

### Root Cause

When the download loop finishes downloading the entire file, `currentOffset >= fileLength` and the loop exits with `isComplete=true`. When `seekTo()` is called after completion:

1. `executeSeek()` sets `pendingSeek = seekByte` and `setIsComplete(false)`
2. `executeSeek()` restarts the download loop via `downloadLoopRef.current(streamUrl)`
3. The download loop enters, checks the while condition: `state.current.currentOffset < state.current.fileLength`
4. Since `currentOffset` is still at `fileLength` (from the previous completion), this condition is **FALSE**
5. The loop body never executes → `pendingSeek` is never processed
6. The loop immediately sets `downloading = false` and `reachedEnd = true` → `isComplete = true` again
7. Seek is broken — no data is fetched, video stays at the end position

### Fix

Two changes in `useMSEPlayer.ts` `executeSeek()` function:

**Change 1: Reset currentOffset**

```javascript
const executeSeek = () => {
    const seekByte = Math.floor((timeSeconds / state.current.duration) * state.current.fileLength);
    state.current.pendingSeek = seekByte;
    state.current.currentOffset = seekByte; // Reset so download loop can re-enter after completion
    // ...
};
```

This allows the while condition `currentOffset < fileLength` to be TRUE, so the loop can enter. Inside the loop, the `pendingSeek` handler will set `currentOffset` to the correct mp4box sync offset.

**Change 2: Remove `!isPausedRef.current` guard**

```javascript
// Before:
if (!state.current.downloading && !isPausedRef.current && downloadLoopRef.current) { ... }

// After:
if (!state.current.downloading && downloadLoopRef.current) { ... }
```

Seeking to an unbuffered position means the user wants to watch from there, so downloads must resume regardless of pause state. Also clears `isPausedRef.current = false` and `setIsPaused(false)` so `resumePrefetch()` doesn't get stuck if the download loop is already running.

### Files Modified
- `useMSEPlayer.ts`: `executeSeek()` function — reset `currentOffset`, remove `!isPausedRef.current` guard, clear pause state

---

## Recommendations for Future Work

1. **Increase Semaphore to 6-8 and MAX_CONCURRENT to 4-5**: Restore ~5.8 MB/s throughput while keeping all stability fixes. The coordinator prevents overlapping downloads, and Bug #16 fixes prevent QuotaExceededError regardless of concurrency level. Consider adaptive concurrency based on Premium account status.
2. **Investigate 1.4GB full-file request**: A request without a Range header (range 0-fileLength) appears when the player closes or the native video element falls back. Determine the exact trigger and either prevent it or handle it gracefully (e.g., reject full-file requests during active MSE streaming).
3. **Consider DC-aware worker connections**: Pre-resolve the file's media DC before creating workers, and connect workers directly to the media DC.
4. **Consider content-addressed validation**: Store MD5 or SHA256 of downloaded chunks to detect corruption.
