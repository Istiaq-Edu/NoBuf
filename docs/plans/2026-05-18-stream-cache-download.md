# Stream Cache & Smart Download Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Cache video/audio bytes during streaming so that subsequent downloads can reuse cached data instead of re-downloading from Telegram.

**Architecture:** The Rust streaming server intercepts all bytes it proxies from Telegram and writes them to a disk cache (one file per video + a `.meta` sidecar tracking cached byte ranges). When the user downloads, the `cmd_download_file` command checks the cache first — if fully cached, it copies the file; if partially cached, it writes cached ranges first then fills gaps from Telegram; if not cached, it downloads normally. A background caching task can continue downloading after the player is closed.

**Tech Stack:** Rust (Actix-web, tokio, serde), TypeScript (React, Tauri IPC)

---

## Phase 1: Rust Disk Cache Manager

### Task 1: Create `stream_cache.rs` module with cache directory setup

**Objective:** Initialize the cache directory on app startup and define the core cache data structures.

**Files:**
- Create: `app/src-tauri/src/stream_cache.rs`
- Modify: `app/src-tauri/src/lib.rs` (add `pub mod stream_cache;`)

**Step 1: Create the cache module with types and initialization**

```rust
// app/src-tauri/src/stream_cache.rs

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Metadata sidecar for a cached file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheMeta {
    /// Telegram message ID
    pub message_id: i32,
    /// Folder (channel) ID
    pub folder_id: i64,
    /// Total file size in bytes (from Telegram)
    pub total_size: u64,
    /// Filename
    pub filename: String,
    /// Sorted list of (start_byte, end_byte) inclusive ranges that are cached
    pub cached_ranges: Vec<(u64, u64)>,
    /// MIME type
    pub mime_type: String,
}

impl CacheMeta {
    /// Total bytes cached across all ranges
    pub fn cached_bytes(&self) -> u64 {
        self.cached_ranges.iter().map(|(s, e)| e - s + 1).sum()
    }

    /// Percentage of file cached (0-100)
    pub fn cached_percentage(&self) -> u8 {
        if self.total_size == 0 {
            return 100;
        }
        ((self.cached_bytes() as f64 / self.total_size as f64) * 100.0) as u8
    }

    /// Check if the entire file is cached
    pub fn is_complete(&self) -> bool {
        self.cached_bytes() >= self.total_size
    }
}

/// Status returned to frontend
#[derive(Debug, Clone, Serialize)]
pub struct CacheStatus {
    pub message_id: i32,
    pub cached_bytes: u64,
    pub total_bytes: u64,
    pub percentage: u8,
    pub is_complete: bool,
    pub filename: String,
}

/// Manages the disk cache for streamed media
#[derive(Clone)]
pub struct StreamCacheManager {
    cache_dir: PathBuf,
    /// Active background cache tasks: message_id → cancel sender
    active_tasks: Arc<Mutex<Vec<i32>>>,
}

impl StreamCacheManager {
    pub fn new(cache_dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&cache_dir)?;
        Ok(Self {
            cache_dir,
            active_tasks: Arc::new(Mutex::new(Vec::new())),
        })
    }

    /// Path to the data file for a message
    pub fn data_path(&self, message_id: i32) -> PathBuf {
        self.cache_dir.join(format!("{}.dat", message_id))
    }

    /// Path to the meta sidecar for a message
    pub fn meta_path(&self, message_id: i32) -> PathBuf {
        self.cache_dir.join(format!("{}.meta.json", message_id))
    }

    /// Load metadata from disk, returns None if not cached
    pub fn load_meta(&self, message_id: i32) -> Option<CacheMeta> {
        let path = self.meta_path(message_id);
        if !path.exists() {
            return None;
        }
        let data = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&data).ok()
    }

    /// Save metadata to disk
    pub fn save_meta(&self, meta: &CacheMeta) -> std::io::Result<()> {
        let path = self.meta_path(meta.message_id);
        let json = serde_json::to_string_pretty(meta)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(&path, json)
    }

    /// Get cache status for a message
    pub fn get_status(&self, message_id: i32) -> Option<CacheStatus> {
        let meta = self.load_meta(message_id)?;
        Some(CacheStatus {
            message_id,
            cached_bytes: meta.cached_bytes(),
            total_bytes: meta.total_size,
            percentage: meta.cached_percentage(),
            is_complete: meta.is_complete(),
            filename: meta.filename,
        })
    }

    /// Delete cache for a specific message
    pub fn delete_cache(&self, message_id: i32) -> std::io::Result<()> {
        let data = self.data_path(message_id);
        let meta = self.meta_path(message_id);
        if data.exists() { std::fs::remove_file(&data)?; }
        if meta.exists() { std::fs::remove_file(&meta)?; }
        Ok(())
    }

    /// Delete all cache files (called on app exit)
    pub fn clear_all(&self) -> std::io::Result<()> {
        if self.cache_dir.exists() {
            std::fs::remove_dir_all(&self.cache_dir)?;
            std::fs::create_dir_all(&self.cache_dir)?;
        }
        Ok(())
    }

    /// Get the cache directory path
    pub fn cache_dir(&self) -> &PathBuf {
        &self.cache_dir
    }

    /// Track an active background task
    pub async fn track_task(&self, message_id: i32) {
        self.active_tasks.lock().await.push(message_id);
    }

    /// Untrack a background task
    pub async fn untrack_task(&self, message_id: i32) {
        self.active_tasks.lock().await.retain(|&id| id != message_id);
    }

    /// Check if a message has an active background task
    pub async fn has_active_task(&self, message_id: i32) -> bool {
        self.active_tasks.lock().await.contains(&message_id)
    }
}
```

**Step 2: Register the module in lib.rs**

In `app/src-tauri/src/lib.rs`, add after line 3 (`pub mod commands;`):
```rust
pub mod stream_cache;
```

**Step 3: Verify it compiles**

```bash
cd app && cargo check
```

Expected: Compiles without errors.

**Step 4: Commit**

```bash
git add app/src-tauri/src/stream_cache.rs app/src-tauri/src/lib.rs
git commit -m "feat(cache): add StreamCacheManager module with disk cache types"
```

---

### Task 2: Register StreamCacheManager in Tauri state

**Objective:** Make the cache manager available to all Tauri commands and the streaming server.

**Files:**
- Modify: `app/src-tauri/src/lib.rs` (lines ~127-142 in `setup`)

**Step 1: Initialize and manage StreamCacheManager in lib.rs**

In `app/src-tauri/src/lib.rs`, inside the `.setup()` closure, after the existing `app.manage(...)` calls (around line 142), add:

```rust
// Initialize stream cache manager
`let cache_dir = std::env::temp_dir().join("telegram-drive-cache");`
match stream_cache::StreamCacheManager::new(cache_dir) {
    Ok(cache_mgr) => {
        app.manage(cache_mgr.clone());
        // Store for cleanup on exit
        // (we'll use a simple approach: the RunEvent::Exit handler will access it)
        log::info!("Stream cache initialized at {:?}", cache_mgr.cache_dir());
    }
    Err(e) => {
        log::error!("Failed to initialize stream cache: {}", e);
    }
}
```

(No external dependency needed — uses `std::env::temp_dir()` which works cross-platform.)

**Step 2: Add cache cleanup to RunEvent::Exit handler**

In the `RunEvent::Exit` handler (around line 202), add:

```rust
// 4. Clear stream cache
if let Some(cache_mgr) = app_handle.try_state::<stream_cache::StreamCacheManager>() {
    log::info!("Clearing stream cache...");
    if let Err(e) = cache_mgr.clear_all() {
        log::error!("Failed to clear stream cache: {}", e);
    }
}
```

**Step 3: Verify it compiles**

```bash
cd app && cargo check
```

**Step 4: Commit**

```bash
git add app/src-tauri/src/lib.rs
git commit -m "feat(cache): register StreamCacheManager in Tauri state with cleanup on exit"
```

---

### Task 3: Add cache-aware byte writing to the streaming server

**Objective:** Modify the streaming server to write every byte it proxies from Telegram to the disk cache simultaneously.

**Files:**
- Modify: `app/src-tauri/src/server.rs` (the `stream_media` handler, lines 178-290)

**Step 1: Accept StreamCacheManager in server state**

Also make `mime_type_from_media` public (line 140):
```rust
pub fn mime_type_from_media(media: &Media) -> String {
```

Modify `start_streaming_server` (line 292) to accept the cache manager:

```rust
pub async fn start_streaming_server(
    port: u16,
    tg_state: Arc<TelegramState>,
    token: String,
    cache_mgr: Option<stream_cache::StreamCacheManager>,
) -> std::io::Result<actix_web::dev::Server> {
```

Also update `start_server` (line 324) to accept and pass through the cache manager:
```rust
pub async fn start_server(
    tg_state: Arc<TelegramState>,
    port: u16,
    token: String,
    cache_mgr: Option<stream_cache::StreamCacheManager>,
    _api_port: u16,
) -> std::io::Result<actix_web::dev::Server> {
    start_streaming_server(port, tg_state, token, cache_mgr).await
}
```

In `lib.rs` where the server is started (lines 148-161), extract the cache manager from state and pass it:

```rust
let cache_mgr = app.state::<stream_cache::StreamCacheManager>().inner().clone();
// ...
server::start_server(state, STREAM_PORT, token_for_server, Some(cache_mgr), 0).await
```

**Step 2: Create cache-aware streaming wrapper**

In `server.rs`, add a helper function that wraps the Telegram download iterator to tee bytes to a cache file:

```rust
use std::io::{Seek, SeekFrom, Write};

/// Wraps a chunk of bytes, writing them to a cache file at the correct offset
fn write_to_cache(
    cache_file: &mut std::fs::File,
    offset: u64,
    data: &[u8],
) -> std::io::Result<()> {
    cache_file.seek(SeekFrom::Start(offset))?;
    cache_file.write_all(data)?;
    Ok(())
}

/// Update the .meta sidecar with a new cached range
fn update_cache_meta(
    cache_mgr: &stream_cache::StreamCacheManager,
    message_id: i32,
    folder_id: i64,
    total_size: u64,
    filename: &str,
    mime_type: &str,
    new_start: u64,
    new_end: u64,
) {
    let mut meta = cache_mgr.load_meta(message_id).unwrap_or_else(|| {
        stream_cache::CacheMeta {
            message_id,
            folder_id,
            total_size,
            filename: filename.to_string(),
            cached_ranges: Vec::new(),
            mime_type: mime_type.to_string(),
        }
    });
    
    // Add and merge the new range
    meta.cached_ranges.push((new_start, new_end));
    meta.cached_ranges.sort();
    merge_ranges(&mut meta.cached_ranges);
    
    let _ = cache_mgr.save_meta(&meta);
}

/// Merge overlapping/adjacent ranges
fn merge_ranges(ranges: &mut Vec<(u64, u64)>) {
    if ranges.is_empty() {
        return;
    }
    let mut merged = vec![ranges[0]];
    for &(start, end) in &ranges[1..] {
        let last = merged.last_mut().unwrap();
        if start <= last.1 + 1 {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    *ranges = merged;
}
```

**Step 3: Modify the stream_media handler to cache bytes**

In the `stream_media` function (line 178), after resolving the media and before creating the async_stream, add cache setup:

```rust
// Inside stream_media, after resolving media (around line 220):
let cache_mgr_data = data.get_ref().clone(); // need to pass cache_mgr through web::Data

// Check if cache file exists, if not create it
let cache_file = if let Some(ref cache) = *cache_mgr_opt {
    let data_path = cache.data_path(message_id);
    // Open or create the cache file for writing
    match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .open(&data_path)
    {
        Ok(f) => Some((cache.clone(), f)),
        Err(e) => {
            log::warn!("Failed to open cache file: {}", e);
            None
        }
    }
} else {
    None
};
```

Then in the `async_stream::stream!` block (lines 234-273), after yielding each chunk, also write to the cache:

```rust
// Inside the stream! loop, after computing the chunk bytes:
let chunk_bytes = web::Bytes::from(raw_bytes.to_vec());

// Write to cache if available
if let Some((ref cache, ref mut file)) = cache_file {
    let _ = write_to_cache(file, current_offset, &raw_bytes);
    update_cache_meta(
        cache, message_id, folder_id, total_size,
        &filename, &mime_type,
        current_offset, current_offset + raw_bytes.len() as u64 - 1,
    );
}

current_offset += raw_bytes.len() as u64;
yield Ok(chunk_bytes) as Result<web::Bytes, actix_web::Error>;
```

**Step 4: Verify it compiles and test streaming**

```bash
cd app && cargo check
```

Manually test: play a video, check that cache files appear in the cache directory.

**Step 5: Commit**

```bash
git add app/src-tauri/src/server.rs app/src-tauri/src/lib.rs
git commit -m "feat(cache): streaming server writes bytes to disk cache during playback"
```

---

## Phase 2: Cache-Aware Download

### Task 4: Modify `cmd_download_file` to check cache first

**Objective:** When the user downloads a file, check if it's cached (fully or partially) and use cached data to speed up the download.

**Files:**
- Modify: `app/src-tauri/src/commands/fs.rs` (the `cmd_download_file` function, lines 316-409)

**Step 1: Add StreamCacheManager to the command signature**

```rust
#[tauri::command]
pub async fn cmd_download_file(
    message_id: i32,
    save_path: String,
    folder_id: Option<i64>,
    transfer_id: Option<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, TelegramState>,
    bw_state: tauri::State<'_, bandwidth::BandwidthManager>,
    cache_state: tauri::State<'_, stream_cache::StreamCacheManager>,  // NEW
) -> Result<String, String> {
```

**Step 2: Add cache-aware download logic**

Replace the current download loop (lines 364-397) with cache-aware logic:

```rust
// Check cache status
let cache_meta = cache_state.load_meta(message_id);
let cache_path = cache_state.data_path(message_id);

if let Some(ref meta) = cache_meta {
    if meta.is_complete() {
        // FULL CACHE HIT: Copy cache file to save path
        app_handle.emit("download-progress", ProgressPayload {
            id: transfer_id.clone().unwrap_or_default(),
            percent: 100,
            uploaded_bytes: total_size,
            total_bytes: total_size,
            speed_bytes_per_sec: 0,
        }).ok();
        
        std::fs::copy(&cache_path, &save_path)
            .map_err(|e| format!("Failed to copy cached file: {}", e))?;
        
        app_handle.emit("download-progress", ProgressPayload {
            id: transfer_id.clone().unwrap_or_default(),
            percent: 100,
            uploaded_bytes: total_size,
            total_bytes: total_size,
            speed_bytes_per_sec: 0,
        }).ok();
        
        return Ok("Downloaded from cache".to_string());
    }
    
    // PARTIAL CACHE HIT: Use cached data + fill gaps from Telegram
    // (Implementation continues below)
}
```

**Step 3: Implement partial cache download**

For partially cached files, write cached ranges first, then fill gaps:

```rust
// Partial cache: write cached ranges, fill gaps from Telegram
let mut output_file = std::fs::File::create(&save_path)
    .map_err(|e| format!("Failed to create file: {}", e))?;

let meta = meta.unwrap(); // safe because we checked Some above
let mut bytes_written: u64 = 0;

// Write cached ranges
for &(range_start, range_end) in &meta.cached_ranges {
    let range_len = range_end - range_start + 1;
    let mut cache_file = std::fs::File::open(&cache_path)
        .map_err(|e| format!("Failed to open cache: {}", e))?;
    
    // Seek to the right position in both files
    use std::io::{Seek, SeekFrom, Read, Write};
    cache_file.seek(SeekFrom::Start(range_start))?;
    output_file.seek(SeekFrom::Start(range_start))?;
    
    let mut remaining = range_len;
    let mut buf = vec![0u8; 512 * 1024]; // 512KB buffer
    while remaining > 0 {
        let to_read = remaining.min(buf.len() as u64) as usize;
        let n = cache_file.read(&mut buf[..to_read])
            .map_err(|e| format!("Cache read error: {}", e))?;
        if n == 0 { break; }
        output_file.write_all(&buf[..n])
            .map_err(|e| format!("Write error: {}", e))?;
        remaining -= n as u64;
        bytes_written += n as u64;
    }
}

// Identify gaps and download them from Telegram
let gaps = find_gaps(&meta.cached_ranges, total_size);
for (gap_start, gap_end) in gaps {
    // Download this range from Telegram
    let skip_chunks = gap_start / DOWNLOAD_CHUNK_SIZE;
    let skip_bytes = gap_start % DOWNLOAD_CHUNK_SIZE;
    
    let mut iter = client.iter_download(&media)
    `.chunk_size(DOWNLOAD_CHUNK_SIZE as i32)`
    `.skip_chunks(skip_chunks as i32);`
    
    output_file.seek(SeekFrom::Start(gap_start))?;
    let mut offset = gap_start;
    
    while let Some(chunk_result) = iter.next().await {
        // Check cancellation
        if state.cancelled_transfers.read().await.contains(&transfer_id) {
            cleanup_partial_file(&save_path);
            return Err("Download cancelled".into());
        }
        
        let chunk = chunk_result.map_err(|e| format!("Download error: {}", e))?;
        let chunk = if offset == gap_start && skip_bytes > 0 {
            &chunk[skip_bytes as usize..]
        } else {
            &chunk
        };
        
        let to_write = chunk.len().min((gap_end - offset + 1) as usize);
        output_file.write_all(&chunk[..to_write])
            .map_err(|e| format!("Write error: {}", e))?;
        
        offset += to_write as u64;
        bytes_written += to_write as u64;
        
        // Emit progress
        // ... (same progress logic as current implementation)
        
        if offset > gap_end { break; }
    }
    
    // Also write the downloaded gap to cache
    // (write the gap bytes to cache file and update meta)
    update_cache_meta(&cache_state, message_id, folder_id.unwrap_or(0), 
                       total_size, &filename, &mime_type, gap_start, gap_end);
}

return Ok("Downloaded with cache assist".to_string());
```

**Step 4: Add helper function `find_gaps` (in `commands/utils.rs` for shared access)**

```rust
/// Find byte ranges that are NOT covered by cached_ranges
fn find_gaps(cached_ranges: &[(u64, u64)], total_size: u64) -> Vec<(u64, u64)> {
    if cached_ranges.is_empty() {
        return vec![(0, total_size - 1)];
    }
    
    let mut gaps = Vec::new();
    let mut expected_start = 0u64;
    
    for &(start, end) in cached_ranges {
        if start > expected_start {
            gaps.push((expected_start, start - 1));
        }
        expected_start = end + 1;
    }
    
    if expected_start < total_size {
        gaps.push((expected_start, total_size - 1));
    }
    
    gaps
}
```

**Step 5: Verify and commit**

```bash
cd app && cargo check
git add app/src-tauri/src/commands/fs.rs
git commit -m "feat(cache): cmd_download_file checks cache first, uses cached ranges"
```

---

## Phase 3: Background Cache Tasks

### Task 5: Add background cache continuation command

**Objective:** Allow the frontend to trigger continued caching after the player is closed.

**Files:**
- Modify: `app/src-tauri/src/commands/mod.rs` (add new command)
- Modify: `app/src-tauri/src/commands/streaming.rs` (add background cache command)
- Modify: `app/src-tauri/src/lib.rs` (register new command)

**Step 1: Add `cmd_start_background_cache` command**

In `app/src-tauri/src/commands/streaming.rs`:

```rust
use tokio::sync::oneshot;

/// Starts a background task that continues downloading a video to cache
#[tauri::command]
pub async fn cmd_start_background_cache(
    message_id: i32,
    folder_id: i64,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, TelegramState>,
    cache_state: tauri::State<'_, stream_cache::StreamCacheManager>,
) -> Result<bool, String> {
    // Don't start if already running
    if cache_state.has_active_task(message_id).await {
        return Ok(false);
    }
    
    // Don't start if already complete
    if let Some(meta) = cache_state.load_meta(message_id) {
        if meta.is_complete() {
            return Ok(false);
        }
    }
    
    let client = { state.client.lock().await.clone() }
        .ok_or("Not connected")?;
    
    let cache_mgr = cache_state.inner().clone();
    let tg_state = state.inner().clone();
    let handle = app_handle.clone();
    
    cache_mgr.track_task(message_id).await;
    
    tokio::spawn(async move {
        let result = background_cache_download(
            message_id, folder_id, client, tg_state, cache_mgr.clone(), handle,
        ).await;
        
        cache_mgr.untrack_task(message_id).await;
        
        if let Err(e) = result {
            log::error!("Background cache failed for {}: {}", message_id, e);
        }
    });
    
    Ok(true)
}

/// Stops a background cache task
#[tauri::command]
pub async fn cmd_stop_background_cache(
    message_id: i32,
    cache_state: tauri::State<'_, stream_cache::StreamCacheManager>,
    // We need a way to signal cancellation — add a cancel map
) -> Result<bool, String> {
    // Signal cancellation through the cancelled_transfers mechanism
    // The background task checks this cooperatively
    Ok(true)
}
```

**Step 2: Implement `background_cache_download`**

```rust
async fn background_cache_download(
    message_id: i32,
    folder_id: i64,
    client: grammers_client::Client,
    state: Arc<TelegramState>,
    cache_mgr: stream_cache::StreamCacheManager,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;
    let messages = client.get_messages_by_id(&peer, &[message_id]).await
        .map_err(|e| format!("Failed to fetch message: {}", e))?;
    let message = messages.into_iter().next().ok_or("Message not found")?;
    
    let media = message.media().ok_or("No media")?;
    let total_size = match &media {
        grammers_client::types::Media::Document(d) => d.size() as u64,
        _ => return Err("Not a document".into()),
    };
    
    // Check what's already cached
    let existing_meta = cache_mgr.load_meta(message_id);
    let gaps = if let Some(ref meta) = existing_meta {
        find_gaps(&meta.cached_ranges, total_size)
    } else {
        vec![(0, total_size - 1)]
    };
    
    if gaps.is_empty() {
        return Ok(()); // Already fully cached
    }
    
    // Download gaps to cache file
    let cache_path = cache_mgr.data_path(message_id);
    let mut cache_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&cache_path)
        .map_err(|e| format!("Failed to open cache file: {}", e))?;
    
    let chunk_size: u64 = 512 * 1024;
    let filename = match &media {
    Media::Document(d) => d.name().to_string(),
    _ => "unknown".to_string(),
};
    let mime_type = crate::server::mime_type_from_media(&media);
    
    for (gap_start, gap_end) in gaps {
        let skip_chunks = gap_start / chunk_size;
        let skip_bytes = gap_start % chunk_size;
        
        let mut iter = client.iter_download(&media)
            .chunk_size(chunk_size as u32)
            .offset(skip_chunks * chunk_size);
        
        let mut offset = gap_start;
        
        while let Some(chunk_result) = iter.next().await {
            // Check cancellation
            if state.cancelled_transfers.read().await.contains(
                &format!("bg-cache-{}", message_id)
            ) {
                return Ok(());
            }
            
            let chunk = chunk_result.map_err(|e| format!("Download error: {}", e))?;
            let chunk = if offset == gap_start && skip_bytes > 0 {
                &chunk[skip_bytes as usize..]
            } else {
                &chunk
            };
            
            let to_write = chunk.len().min((gap_end - offset + 1) as usize);
            use std::io::{Seek, SeekFrom, Write};
            cache_file.seek(SeekFrom::Start(offset))?;
            cache_file.write_all(&chunk[..to_write])
                .map_err(|e| format!("Write error: {}", e))?;
            
            offset += to_write as u64;
            
            // Update meta
            update_cache_meta(
                &cache_mgr, message_id, folder_id, total_size,
                &filename, &mime_type, gap_start, offset - 1,
            );
            
            if offset > gap_end { break; }
        }
    }
    
    Ok(())
}
```

**Step 3: Register new commands in lib.rs**

Add to the `invoke_handler` list (around line 196):
```rust
commands::cmd_start_background_cache,
commands::cmd_stop_background_cache,
```

**Step 4: Verify and commit**

```bash
cd app && cargo check
git add app/src-tauri/src/commands/streaming.rs app/src-tauri/src/commands/mod.rs app/src-tauri/src/lib.rs
git commit -m "feat(cache): add background cache continuation commands"
```

---

### Task 6: Add `cmd_get_cache_status` command

**Objective:** Allow the frontend to query cache status for a specific file.

**Files:**
- Modify: `app/src-tauri/src/commands/streaming.rs`

**Step 1: Add the command**

```rust
/// Get cache status for a specific message
#[tauri::command]
pub async fn cmd_get_cache_status(
    message_id: i32,
    cache_state: tauri::State<'_, stream_cache::StreamCacheManager>,
) -> Result<Option<stream_cache::CacheStatus>, String> {
    Ok(cache_state.get_status(message_id))
}
```

**Step 2: Register in lib.rs**

Add to invoke_handler:
```rust
commands::cmd_get_cache_status,
```

**Step 3: Verify and commit**

```bash
cd app && cargo check
git add app/src-tauri/src/commands/streaming.rs app/src-tauri/src/lib.rs
git commit -m "feat(cache): add cmd_get_cache_status command"
```

---

## Phase 4: Frontend — Player Close Dialog

### Task 7: Add "Continue in background?" dialog on player close

**Objective:** When the user closes the video player, show a dialog asking whether to continue caching in the background.

**Files:**
- Modify: `app/src/components/dashboard/FastStreamPlayer.tsx` (onClose handling)
- Modify: `app/src/components/dashboard/MediaPlayer.tsx` (pass `activeFolderId` to FastStreamPlayer)
- Modify: `app/src/types.ts` (add `cacheInfo` field to `DownloadItem`)

**Step 0: Update types and props**

In `app/src/types.ts`, add to `DownloadItem` interface:
```typescript
cacheInfo?: string; // "From cache ✓" or "Using cache (67%)"
```

In `MediaPlayer.tsx`, pass `activeFolderId` to FastStreamPlayer:
```tsx
<FastStreamPlayer streamUrl={streamUrl} file={file} onClose={onClose} 
    onNext={onNext} onPrev={onPrev} activeFolderId={activeFolderId} />
```

In `FastStreamPlayer.tsx`, add `activeFolderId` to props interface:
```typescript
interface FastStreamPlayerProps {
    file: TelegramFile;
    streamUrl: string;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    activeFolderId: number | null;
}
```

**Step 1: Add close confirmation to FastStreamPlayer**

In `FastStreamPlayer.tsx`, add a close handler that shows a confirmation:

```tsx
import { useConfirm } from '../../context/ConfirmContext';

// Inside the component:
const { confirm } = useConfirm();

const handleClose = useCallback(async () => {
    // Check if there's cached data
    try {
        const cacheStatus = await invoke<any>('cmd_get_cache_status', { 
            messageId: file.id 
        });
        
        if (cacheStatus && cacheStatus.percentage > 0 && !cacheStatus.is_complete) {
            const choice = await confirm({
                title: 'Video partially cached',
                message: `${cacheStatus.percentage}% of this video is cached locally. Continue downloading in the background for faster access later?`,
                confirmText: 'Continue in Background',
                cancelText: 'Close & Discard Cache',
            });
            
            if (choice) {
                // Start background cache task
                await invoke('cmd_start_background_cache', {
                    messageId: file.id,
                    folderId: activeFolderId,
                });
                toast.success('Video caching in background');
            } else {
                // Delete cache for this video
                // (handled by the Rust side, or add a cmd_delete_cache command)
            }
        }
    } catch (e) {
        // Ignore errors, just close
    }
    
    onClose();
}, [file.id, activeFolderId, confirm, onClose]);
```

**Step 2: Wire the close handler**

Replace the existing `onClose` prop usage in FastStreamPlayer with `handleClose`.

**Step 3: Verify and commit**

```bash
cd app && npm run build
git add app/src/components/dashboard/FastStreamPlayer.tsx
git commit -m "feat(cache): show background caching dialog on player close"
```

---

## Phase 5: Frontend — Download Queue Cache Indicator

### Task 8: Show cache status in download queue

**Objective:** When a download starts, show whether it's using cached data.

**Files:**
- Modify: `app/src/hooks/useFileDownload.ts`

**Step 1: Check cache status when queuing a download**

In `useFileDownload.ts`, before invoking `cmd_download_file`, check cache status:

```typescript
const queueDownload = useCallback(async (messageId: number, filename: string, folderId: number | null) => {
    const id = crypto.randomUUID();
    
    // Check cache status
    let cacheInfo: string | null = null;
    try {
        const cacheStatus = await invoke<any>('cmd_get_cache_status', { messageId });
        if (cacheStatus) {
            if (cacheStatus.is_complete) {
                cacheInfo = 'From cache ✓';
            } else if (cacheStatus.percentage > 0) {
                cacheInfo = `Using cache (${cacheStatus.percentage}%)`;
            }
        }
    } catch {
        // No cache, proceed normally
    }
    
    setDownloadQueue(prev => [...prev, {
        id,
        messageId,
        filename,
        folderId,
        status: 'pending',
        // Add cacheInfo to the item
    }]);
    
    // ... rest of the logic
}, []);
```

**Step 2: Display cache info in DownloadQueue component**

In `app/src/components/dashboard/DownloadQueue.tsx`, show the cache indicator:

```tsx
{item.cacheInfo && (
    <span className="text-xs text-blue-400">{item.cacheInfo}</span>
)}
```

**Step 3: Verify and commit**

```bash
cd app && npm run build
git add app/src/hooks/useFileDownload.ts app/src/components/dashboard/DownloadQueue.tsx
git commit -m "feat(cache): show cache status in download queue"
```

---

## Phase 6: Edge Cases & Cleanup

### Task 9: Add `cmd_delete_cache` command for single-file cache cleanup

**Objective:** Allow the frontend to delete cache for a specific video (used when user chooses "Close & Discard Cache").

**Files:**
- Modify: `app/src-tauri/src/commands/streaming.rs`

**Step 1: Add the command**

```rust
#[tauri::command]
pub async fn cmd_delete_cache(
    message_id: i32,
    cache_state: tauri::State<'_, stream_cache::StreamCacheManager>,
) -> Result<bool, String> {
    cache_state.delete_cache(message_id)
        .map_err(|e| format!("Failed to delete cache: {}", e))?;
    Ok(true)
}
```

**Step 2: Register and commit**

```bash
cd app && cargo check
# Add to invoke_handler in lib.rs
git add app/src-tauri/src/commands/streaming.rs app/src-tauri/src/lib.rs
git commit -m "feat(cache): add cmd_delete_cache for single-file cleanup"
```

---

### Task 10: Handle concurrent streams of the same video

**Objective:** Prevent cache corruption when the same video is streamed multiple times.

**Step 1: In `stream_media` handler, use file locking**

Use `fs2` crate or `std::fs::File` locking to prevent concurrent writes to the same cache file:

```rust
// Before writing to cache, try to acquire an exclusive lock
#[cfg(unix)]
use std::os::unix::fs::FileExt;
#[cfg(windows)]
use std::os::windows::fs::FileExt;

// Use a per-message-id mutex in the cache manager
// Add to StreamCacheManager:
// file_locks: Arc<Mutex<HashMap<i32, Arc<Mutex<()>>>>>
```

Alternatively, use a simpler approach: each stream checks if a cache file is already being written to (by checking if the .meta file has an `active_writer` flag). If so, the second stream skips caching.

**Step 2: Verify and commit**

```bash
git add app/src-tauri/src/stream_cache.rs app/src-tauri/src/server.rs
git commit -m "feat(cache): handle concurrent streams with file locking"
```

---

### Task 11: Handle seek in cached streams

**Objective:** When the user seeks in a cached video, the server should serve cached data for already-downloaded ranges.

**Step 1: In `stream_media`, check cache before creating Telegram iterator**

```rust
// In stream_media handler, before creating iter_download:
if let Some(ref cache) = cache_mgr_opt {
    if let Some(meta) = cache.load_meta(message_id) {
        // Check if the requested range is fully cached
        let requested_range = (start_byte, end_byte);
        if is_range_cached(&meta.cached_ranges, requested_range) {
            // Serve from cache file directly
            let cache_path = cache.data_path(message_id);
            let cached_data = std::fs::read(&cache_path)
                .map_err(|e| format!("Cache read error: {}", e))?;
            let slice = &cached_data[start_byte as usize..=end_byte as usize];
            return HttpResponse::PartialContent()
                .insert_header(("Content-Range", format!("bytes {}-{}/{}", start_byte, end_byte, total_size)))
                .insert_header(("Content-Length", slice.len()))
                .insert_header(("Content-Type", mime_type))
                .body(slice.to_vec());
        }
    }
}
```

**Step 2: Verify and commit**

```bash
git add app/src-tauri/src/server.rs
git commit -m "feat(cache): serve from cache on seek for already-cached ranges"
```

---

## Summary of New Files and Modified Files

### New Files:
| File | Purpose |
|------|---------|
| `app/src-tauri/src/stream_cache.rs` | Disk cache manager, types, range tracking |

### Modified Files (Rust):
| File | Changes |
|------|---------|
| `app/src-tauri/src/lib.rs` | Register cache module, manage StreamCacheManager, cleanup on exit, register new commands |
| `app/src-tauri/src/server.rs` | Cache-aware streaming (tee bytes to disk), serve from cache on seek |
| `app/src-tauri/src/commands/fs.rs` | Cache-aware download (check cache first, fill gaps) |
| `app/src-tauri/src/commands/streaming.rs` | New commands: `cmd_get_cache_status`, `cmd_start_background_cache`, `cmd_stop_background_cache`, `cmd_delete_cache` |
| `app/src-tauri/src/commands/mod.rs` | Export new commands |

### Modified Files (Frontend):
| File | Changes |
|------|---------|
| `app/src/components/dashboard/FastStreamPlayer.tsx` | Close dialog for background caching |
| `app/src/hooks/useFileDownload.ts` | Check cache status on download |
| `app/src/components/dashboard/DownloadQueue.tsx` | Show cache indicator |

---

## Verification Checklist

- [ ] Cache directory is created on app startup
- [ ] Streaming a video creates `.dat` and `.meta.json` files
- [ ] Cache file grows as video is streamed
- [ ] Closing player shows "Continue in background?" dialog
- [ ] Background caching continues after player close
- [ ] Download of fully cached video is instant (file copy)
- [ ] Download of partially cached video uses cached ranges + fills gaps
- [ ] Download of uncached video works normally (no regression)
- [ ] Cache is cleared on app exit
- [ ] No cache corruption on concurrent streams
- [ ] Seek serves from cache when available
- [ ] Download queue shows "From cache" indicator
