# DownloadPool — Architecture & Data Flow

> Detailed technical architecture of the parallel download pool implementation.

---

## File Structure

```
app/src-tauri/src/
├── download_pool.rs          # NEW: DownloadPool, DownloadWorker, worker streams
├── server.rs                 # MODIFIED: Prebuffer integration (parallel stream disabled)
├── commands/
│   ├── auth.rs               # MODIFIED: Init/cleanup DownloadPool
│   ├── fs.rs                 # MODIFIED: Parallel file downloads
│   ├── streaming.rs          # MODIFIED: Parallel background cache filling
│   └── mod.rs                # MODIFIED: Module registration
└── lib.rs                    # MODIFIED: State field + semaphore
```

---

## download_pool.rs — Core Module

### Constants

```rust
const WORKER_COUNT: usize = 3;
const TELEGRAM_CHUNK_SIZE: usize = 524_288; // 512 KB
```

### Structs

#### `StreamChunk`
```rust
pub struct StreamChunk {
    pub offset: u64,       // Byte offset of this chunk in the original file
    pub data: Vec<u8>,     // Raw bytes of this chunk
}
```

#### `DownloadWorker`
```rust
struct DownloadWorker {
    client: Client,        // Independent grammers Client instance
    session: Arc<SqliteSession>,  // Session file copy for this worker
    _temp_dir: TempDir,    // Temp dir holding session copy (auto-cleanup)
}
```

#### `DownloadPool`
```rust
pub struct DownloadPool {
    workers: Vec<DownloadWorker>,  // 3 workers
}
```

### Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `new()` | `(session_path, api_id) -> Result<Self>` | Creates 3 workers, each with session copy and TCP connection |
| `download_range()` | `(media, start, end) -> Result<Vec<u8>>` | Splits range into 3 sub-ranges, downloads in parallel, merges |
| `download_sub_range()` | `(media, start, end) -> Result<Vec<u8>>` | Single-worker fallback (uses worker 0) |
| `stream_range()` | `(media, start, end, total_size, semaphore) -> UnboundedReceiver` | Parallel stream with reorder buffer (returns channel receiver) |
| `cleanup_session_files()` | `(main_session_path)` | Deletes worker session files on logout |
| `worker_count()` | `()` -> usize` | Returns 3 |

### Initialization Flow (`DownloadPool::new`)

```
1. Copy main session file to temp dir (3 times, one per worker)
2. Open SqliteSession on each copy
3. Create SenderPool with session + api_id
4. Create grammers Client from SenderPool
5. Spawn tokio task for each runner (network loop)
6. Store Client in DownloadWorker
7. Return DownloadPool with 3 workers
```

### Data Flow: `download_range()` (active, used in streaming.rs)

```
caller: streaming.rs
  └─ pool.download_range(&media, start, end)
       ├─ Split [start..end] into 3 equal sub-ranges
       ├─ For each sub-range: tokio::spawn download_sub_range_iter()
       ├─ All 3 download in parallel via separate TCP connections
       ├─ Await all futures with join_all
       ├─ Merge results in order (sub-range 0, 1, 2 concatenated)
       └─ Return merged Vec<u8>
```

### Data Flow: `stream_range()` (disabled for player-facing; active in fs.rs)

```
caller: server.rs (disabled) / fs.rs (active)
  └─ pool.stream_range(&media, start, end, total_size, semaphore)
       ├─ Create unbounded_channel (tx, rx) for output
       ├─ Create raw_channel (raw_tx, raw_rx) for worker chunks
       ├─ Spawn 3 parallel_worker_stream tasks (staggered 150ms)
       │    ├─ Each worker claims chunk_offset from shared Atomic counter
       │    ├─ Downloads chunk via iter_download (skip_chunks)
       │    └─ Sends (offset, data) → raw_tx
       ├─ Drop raw_tx (so workers finish → raw_rx closes)
       ├─ Spawn REORDER COORDINATOR task:
       │    ├─ BTreeMap<offset, data> buffer
       │    ├─ Receives chunks from raw_rx (out-of-order)
       │    ├─ Inserts into BTreeMap keyed by offset
       │    ├─ Yields consecutive chunks → output_tx in order
       │    │   (starts from start_byte, increments by data.len())
       │    └─ On raw_rx close: flush remaining buffer
       ├─ Drop output_tx (so coordinator finish → rx closes)
       └─ Return rx to caller
```

### Worker Stream: `parallel_worker_stream()`

```
loop:
  1. Acquire semaphore permit (max 3 concurrent across pool)
  2. Lock next_offset Mutex, read current offset, increment by 512KB
  3. If chunk_offset > end_byte + 512KB → break (all chunks claimed)
  4. Compute actual_start = chunk_offset.max(start_byte)
  5. Compute actual_end = (chunk_offset + 512KB - 1).min(end_byte)
  6. GUARD: if actual_start > actual_end → continue
  7. sub_length = actual_end - actual_start + 1
  8. if sub_length == 0 → continue
  9. Create iter_download with skip_chunks
 10. Loop over iter chunks → send StreamChunk { offset, data } to channel
 11. Handle partial chunks, truncation, remaining bytes
```

### Sequential Fallback: `sequential_stream()`

Used when content_length <= TELEGRAM_CHUNK_SIZE * 2 (≤ 1MB). Downloads entire range via single iter_download call, yielding chunks in natural order.

---

## server.rs — Prebuffer Integration (DISABLED)

### Location: `handle_stream_with_cache` function (~line 330)

```rust
// Currently disabled:
let use_parallel = false; // Disabled until parallel stream correctness verified
let _pool_guard = { data.download_pool.lock().await.clone() };

if use_parallel {
    // Parallel path: pool.stream_range() → rx → yield chunks
    // Includes: reorder buffer, cache writing, meta updates
} else {
    // Sequential path: direct iter_download → yield chunks
}
```

### Why Sequential (Not Parallel)

The parallel stream path uses `stream_range()` which feeds chunks through a reorder buffer. Despite the reorder buffer ensuring in-order delivery, the MSE video player receives `CHUNK_DEMUXER_ERROR_APPEND_FAILED` when parallel data is streamed. The root cause was actually backend bugs (#8 meta over-claiming + #11 meta deletion mid-stream + frontend cascade), all now fixed. However, the **sequential approach is the correct permanent choice** for MSE player-facing HTTP responses because:

1. The MSE player requires strict in-order byte delivery — sequential guarantees this by design
2. The coordinator already prevents overlapping downloads, so sequential doesn't waste bandwidth
3. Sequential + coordinator provides stable ~3-4 MB/s throughput without FLOOD_WAIT bombardment
4. Parallel is still active for background gap-filling and file downloads where data is validated before use

### Cache Integration

In both paths:
- Downloaded data is written to a disk cache file (`StreamCacheManager`)
- Meta ranges are updated for future cache hits
- Cache file offsets are now set from `StreamChunk.offset` directly

---

## auth.rs — Lifecycle

### Initialization (in `ensure_client_initialized`)

```rust
// After main client initialization:
let mut pool_guard = state.download_pool.lock().await;
if pool_guard.is_none() {
    match DownloadPool::new(&session_path_str, api_id) {
        Ok(pool) => {
            log::info!("DownloadPool initialized with 3 workers");
            *pool_guard = Some(pool);  // ← Sets existing guard, NO re-lock
        }
        Err(e) => log::warn!("Failed to initialize DownloadPool: {}", e),
    }
}
```

**Critical**: Using `*pool_guard = Some(pool)` instead of `*state.download_pool.lock().await = Some(pool)`. The latter would deadlock because Tokio's Mutex is NOT reentrant.

### Cleanup (in `cmd_logout`)

```rust
if let Some(pool) = state.download_pool.lock().await.take() {
    pool.cleanup_session_files(&session_path);
    log::info!("DownloadPool session files cleaned up");
}
```

---

## lib.rs — State Changes

### TelegramState additions

```rust
pub struct TelegramState {
    // ... existing fields ...
    pub download_pool: Arc<tokio::sync::Mutex<Option<DownloadPool>>>,  // NEW
    pub download_semaphore: Arc<tokio::sync::Semaphore>,  // Changed from 1 → 4
}
```

### Semaphore rationale

- Main client: 1 permit (for sequential downloads and API queries)
- DownloadPool workers: 3 permits (one per worker)
- Total: 4 permits

The current Semaphore(4) limits total concurrent Telegram API calls to 4, giving ~3-4 MB/s average throughput. This is not the maximum achievable throughput (~5.8 MB/s observed before bug fixes), but it provides stable bandwidth without FLOOD_WAIT bombardment. Increasing to Semaphore(6-8) would restore ~5.8 MB/s while keeping all stability fixes active.

---

## streaming.rs — Background Cache Filling

### Integration point: Gap-filling function

```rust
// For gaps > 1MB with DownloadPool available:
if gap_size > 1024 * 1024 {
    if let Some(pool_guard) = state.download_pool.lock().await.as_ref() {
        let data = pool_guard.download_range(&media, gap_start, gap_end).await?;
        // Write data to cache at gap_start offset
        continue;  // Skip sequential path
    }
}
// Fallback: sequential download for small gaps or no pool
```

---

## fs.rs — File Downloads

### Integration point: Fresh file download

```rust
// For files > 1MB with DownloadPool available:
if total_size > 1024 * 1024 {
    if let Some(pool_guard) = state.download_pool.lock().await.as_ref() {
        // Use pool.stream_range() for parallel streaming download
        // Cancel-safe, progress reporting, cache writing, throttling
    }
}
// Fallback: sequential iter_download for small files
```

---

## Reorder Buffer (Key Design Element)

### Problem

3 workers download chunks concurrently. Chunks arrive at the output channel in completion order, NOT byte-offset order. The MSE video player requires strict sequential byte streams.

### Solution

A **coordinator task** sits between workers and the output channel:

1. Workers send `(offset, data)` → `raw_tx`/`raw_rx` (internal channel)
2. Coordinator receives from `raw_rx`, inserts into `BTreeMap<u64, Vec<u8>>`
3. Coordinator yields from `BTreeMap` starting from `next_yield = start_byte`
4. For each yield: remove entry at `next_yield`, send to `output_tx`, advance `next_yield` by `data.len()`
5. Repeat until `BTreeMap[next_yield]` is missing (waits for next chunk)
6. On `raw_rx` close (all workers done), flush remaining entries from `BTreeMap`

### Edge Cases Handled

- **Gaps**: If a chunk at offset X hasn't arrived, coordinator blocks until it does
- **Shutdown**: If output `tx` is dropped (client disconnect), coordinator returns immediately
- **Remaining chunks**: Final flush loop yields any buffered chunks after workers finish
- **Empty chunks**: `sub_length == 0` check prevents sending zero-length chunks

---

## Current Architecture Limitations

### No Download Coordination Between Concurrent Range Requests

The `stream_media` handler in `server.rs` is invoked independently for each HTTP Range request. When the video player sends overlapping Range requests (e.g., bytes=266MB-1.4GB, bytes=267MB-1.4GB, bytes=267.3MB-1.4GB), each triggers a full SEQUENTIAL download from Telegram with no coordination. This causes:

1. **Duplicate downloads**: Same byte ranges fetched multiple times
2. **Duplicate cache writes**: Same data written to cache from concurrent streams
3. **FLOOD_PREMIUM_WAIT multiplication**: Rapid API request bursts trigger rate limits
4. **Complex meta fragmentation**: Overlapping ranges create fragmented `cached_ranges`

### Implemented Fix: Per-Message Download Coordinator (Bug #6)

The coordinator has been implemented in `stream_cache.rs` (ActiveDownload registry) and `server.rs` (subscription logic). Key components:

```rust
// In StreamCacheManager (stream_cache.rs)
pub struct ActiveDownload {
    pub start_byte: u64,
    pub end_byte: u64,
    pub progress_tx: watch::Sender<u64>,  // broadcasts last byte cached
}
active_downloads: Arc<Mutex<HashMap<i32, Vec<ActiveDownload>>>  // Bug #13 fix: Vec allows multiple concurrent downloads per message
```

When a new Range request arrives:
1. Check `active_downloads` via `find_covering_download()` for an existing download covering the requested range (searches through ALL downloads in the Vec for the message)
2. If found: **subscribe** — create a subscriber stream that reads from cache as data arrives (via `progress_rx: watch::Receiver<u64>`)
3. If not found: register new `ActiveDownload` via `register_download()` (pushes into Vec), start SEQUENTIAL download, broadcast progress after each chunk via `update_download_progress(message_id, start_byte, last_cached_byte)` (finds correct download by start_byte match)
4. Drop-guard (`DownloadGuard`) unregisters the **specific** download (by `start_byte` and `end_byte`) when the Actix response ends, preserving other concurrent downloads for the same message

The subscriber stream reads chunks from the cache file as the active download's progress channel indicates data availability. This eliminates duplicate Telegram API calls for overlapping ranges, reduces meta fragmentation, and prevents FLOOD_PREMIUM_WAIT multiplication.

### Subscriber Stream Responses (Bug #14 fix)

Subscriber responses use **chunked transfer encoding** (no Content-Length header). This eliminates ERR_CONTENT_LENGTH_MISMATCH errors because the browser can't reject a response for delivering fewer bytes than promised — there's no Content-Length promise. The subscriber stream delivers as much data as available from cache and then ends. The MSE player reads whatever it gets and re-requests missing ranges through the download loop.

When the active download ends before covering the subscriber's full range, the subscriber stream:
1. Reads ALL available cached data from disk (up to the furthest contiguous cached byte from `read_offset`)
2. Delivers it via the chunked stream
3. Logs a warning with the uncovered range
4. Ends the stream — the MSE player will re-request the missing bytes

### Coordinator Multi-Download Support (Bug #13 fix)

Previously `active_downloads: HashMap<i32, ActiveDownload>` keyed only by `message_id`, causing concurrent downloads for the same message to overwrite each other. The second `HashMap::insert()` drops the first download's `progress_tx`, orphaning all subscribers watching the first download.

Changed to `HashMap<i32, Vec<ActiveDownload>>`:
- `register_download`: Pushes new download into Vec
- `find_covering_download`: Searches through ALL downloads in Vec for one covering the requested range
- `update_download_progress`: Finds the correct download by `start_byte` match, not just the first entry
- `unregister_download`: Removes the specific download (by `start_byte` + `end_byte`) from Vec, preserving other concurrent downloads. Empty Vecs are cleaned up.
- `DownloadGuard`: Now stores `start_byte` and `end_byte` so it can unregister the specific download

### Cache File Deletion on Windows

The `.dat` data file is opened with `FILE_SHARE_READ | FILE_SHARE_WRITE` (no `FILE_SHARE_DELETE`). When streaming holds a write handle, `std::fs::remove_file()` fails with OS error 32. Current workaround: leave `.dat` in place, delete `.meta.json` sidecar, and rely on next playback to overwrite or app exit to clean up.

### Meta Recovery Over-Claiming (Bug #8 fix)

When meta is lost and recovery is needed, the previous code assumed `(0, data_size-1)` was fully cached, which over-claimed data that was actually sparse/missing. This caused the player to read zero-filled data from uncached regions, corrupting MSE playback. The fix: recovery meta now starts with **empty** `cached_ranges`, letting normal chunk writes populate the correct ranges.

### StreamingGuard (Bug #11 fix)

`StreamingGuard` and `track_streaming` must live **inside** `async_stream::stream!` blocks (subscriber, SEQUENTIAL, and parallel paths), not in the outer `stream_media()` function scope. When the function returns `HttpResponse::streaming(stream)`, any guards in the outer scope are dropped immediately, causing `untrack_streaming()` to fire before any data flows. This makes `is_streaming()` return `false`, allowing `delete_cache` to destroy the meta file mid-stream — identical pattern to Bug #10's DownloadGuard premature drop.

**Implemented fix**: Deferred deletion queue that attempts `.dat` deletion after all handles are closed (when `untrack_streaming` or `unregister_download` is called). The `pending_deletions: Arc<std::sync::Mutex<Vec<i32>>>` queue in `StreamCacheManager` stores message IDs whose `.dat` files couldn't be deleted due to open handles. `try_deferred_deletions()` is called from `untrack_streaming()` and `unregister_download()` — it checks if the message is still streaming, checks the pending queue, and attempts deletion. On success, the message ID is removed from the queue; on failure, it stays queued for the next attempt.

### Concurrent Download Limit (Bug #15 fix)

`MAX_CONCURRENT_DOWNLOADS_PER_MESSAGE = 3` prevents unlimited SEQUENTIAL downloads per message. Without this limit, rapid-seeking MSE players spawn 10+ concurrent 1MB downloads, triggering FLOOD_PREMIUM_WAIT bombardment from Telegram's API.

When the limit is reached:
- `register_download()` returns `None` — the new request can't start a new SEQUENTIAL download
- `find_nearest_download()` finds the closest existing download to the requested byte range
- New requests subscribe to the nearest download as a subscriber stream, reading from cache as it progresses
- This limits Telegram API calls to 3 per message, reducing FLOOD_PREMIUM_WAIT events

### Seek Debouncing (Frontend)

In `useMSEPlayer.ts`, unbuffered seek positions use a "first instant, then 500ms debounce" pattern (`SEEK_DEBOUNCE_MS = 500`). The **first** seek to an unbuffered position executes instantly for responsive feel. Subsequent rapid seeks within 500ms are debounced — only the LAST position in the rapid-fire window actually executes. This prevents overlapping download requests from arrow-key spam while keeping deliberate clicks feeling instant. Buffered positions always seek instantly (no debounce).

### Seek After Completion (Bug #17 fix)

When the video finishes playing, `currentOffset >= fileLength` and the download loop exits. The `seekTo()` function now resets `currentOffset = seekByte` in `executeSeek()` so the download loop can re-enter after completion. Without this reset, the while condition `currentOffset < fileLength` prevents the loop from entering, and `pendingSeek` is never processed. Also removed the `!isPausedRef.current` guard so seeking always restarts downloads regardless of pause state.

### SourceBuffer Quota Management (Bug #16 fix)

Chrome's MSE SourceBuffer has an internal quota (~150-300MB depending on platform). When buffer exceeds this quota, `appendBuffer` throws `QuotaExceededError`. Three fixes prevent this:

1. **Retry cascade prevention**: `SourceBufferWrapper.processQueue()` catches `QuotaExceededError` specifically and stops processing (instead of blindly retrying, which created an infinite cascade of ~20+ repeated errors). The next `onSegment` + `evictOldBuffer()` + `appendBuffer()` naturally resumes processing after space is freed.

2. **Proactive eviction**: `evictOldBuffer()` runs BEFORE each `appendBuffer` call (not after). This frees space before new data is appended, preventing QuotaExceededError from occurring. `MAX_BUFFER_BYTES` reduced from 100MB to 50MB for more conservative eviction.

3. **Download loop backpressure**: `MAX_BUFFER_AHEAD_SECONDS = 120` — when more than 2 minutes of video is buffered ahead of current playback, the download loop sleeps 2s per iteration, letting playback consume data before downloading more. This prevents the SourceBuffer from filling past Chrome's quota regardless of the quota's exact size.
