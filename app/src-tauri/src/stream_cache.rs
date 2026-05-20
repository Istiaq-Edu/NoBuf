use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Windows FILE_SHARE_DELETE protection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// On Windows, Rust's std::fs::OpenOptions opens files with
// FILE_SHARE_DELETE, allowing ANY process to mark the file for
// deletion while our handle is open. This causes the file to enter
// a "pending delete" state where the directory entry is removed
// (file appears not to exist) but open handles can still read/write.
// When all handles close, the file is permanently deleted, losing
// ALL cached data.
//
// Most likely cause: antivirus scanning the .dat file (containing
// video data) and marking it for deletion.
//
// Fix: open cache .dat files with FILE_SHARE_READ | FILE_SHARE_WRITE
// (no FILE_SHARE_DELETE). This prevents external processes from
// deleting the file. DeleteFile/RemoveFile will fail with
// ERROR_ACCESS_DENIED while our handle is open. Reputable antivirus
// respects this flag and skips files in active use.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[cfg(target_os = "windows")]
mod win32 {
    use std::os::windows::io::FromRawHandle;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    const FILE_SHARE_READ: u32 = 0x00000001;
    const FILE_SHARE_WRITE: u32 = 0x00000002;
    // NOTE: FILE_SHARE_DELETE (0x00000004) is intentionally EXCLUDED
    // to prevent external processes (antivirus, system cleanup) from
    // marking cache files for deletion while streaming is active.
    const OPEN_ALWAYS: u32 = 4;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const GENERIC_READ: u32 = 0x80000000;
    const GENERIC_WRITE: u32 = 0x40000000;
    const INVALID_HANDLE_VALUE: isize = -1;

    extern "system" {
        fn CreateFileW(
            lpFileName: *const u16,
            dwDesiredAccess: u32,
            dwShareMode: u32,
            lpSecurityAttributes: *mut std::ffi::c_void,
            dwCreationDisposition: u32,
            dwFlagsAndAttributes: u32,
            hTemplateFile: *mut std::ffi::c_void,
        ) -> isize;

        fn GetLastError() -> u32;
    }

    /// Open a file for read+write with FILE_SHARE_READ | FILE_SHARE_WRITE
    /// but WITHOUT FILE_SHARE_DELETE. Equivalent to
    /// OpenOptions::new().create(true).write(true).open() but protected
    /// from external deletion on Windows.
    pub fn open_file_no_delete_share(path: &Path) -> std::io::Result<std::fs::File> {
        let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();

        let handle = unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null_mut(),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };

        if handle == INVALID_HANDLE_VALUE {
            let err_code = unsafe { GetLastError() };
            return Err(std::io::Error::from_raw_os_error(err_code as i32));
        }

        // SAFETY: CreateFileW returned a valid, non-INVALID_HANDLE_VALUE handle.
        // We take ownership via from_raw_handle — the File's Drop impl will
        // call CloseHandle when it goes out of scope.
        Ok(unsafe { FromRawHandle::from_raw_handle(handle as *mut std::ffi::c_void) })
    }
}

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
    /// Byte ranges that are cached on disk (for green buffer bar)
    pub cached_ranges: Vec<(u64, u64)>,
}

/// Manages the disk cache for streamed media
#[derive(Clone)]
pub struct StreamCacheManager {
    cache_dir: PathBuf,
    /// Active background cache tasks: message_id
    active_tasks: Arc<Mutex<Vec<i32>>>,
    /// Per-message locks to serialize meta read-modify-write operations
    /// between player reports and download updates (prevents race conditions)
    meta_locks: Arc<Mutex<HashMap<i32, Arc<tokio::sync::Mutex<()>>>>>,
    /// Tracks messages currently being streamed (synchronous, for Drop guards)
    streaming_active: Arc<std::sync::Mutex<Vec<i32>>>,
}

impl StreamCacheManager {
    pub fn new(cache_dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&cache_dir)?;
        Ok(Self {
            cache_dir,
            active_tasks: Arc::new(Mutex::new(Vec::new())),
            meta_locks: Arc::new(Mutex::new(HashMap::new())),
            streaming_active: Arc::new(std::sync::Mutex::new(Vec::new())),
        })
    }

    /// Path to the data file for a message
    pub fn data_path(&self, message_id: i32) -> PathBuf {
        self.cache_dir.join(format!("{}.dat", message_id))
    }

    /// Open the data file for writing, protected from external deletion.
    /// On Windows, this opens with FILE_SHARE_READ | FILE_SHARE_WRITE
    /// (no FILE_SHARE_DELETE) to prevent antivirus/cleanup from marking
    /// the file for deletion while our handle is open. Equivalent to
    /// OpenOptions::new().create(true).write(true).open() on non-Windows.
    pub fn open_data_file_write(&self, message_id: i32) -> std::io::Result<std::fs::File> {
        let path = self.data_path(message_id);
        #[cfg(target_os = "windows")]
        {
            win32::open_file_no_delete_share(&path)
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .open(&path)
        }
    }

    /// Path to the meta sidecar for a message
    pub fn meta_path(&self, message_id: i32) -> PathBuf {
        self.cache_dir.join(format!("{}.meta.json", message_id))
    }

    /// Load metadata from disk, returns None if not cached
    pub fn load_meta(&self, message_id: i32) -> Option<CacheMeta> {
        let path = self.meta_path(message_id);
        if !path.exists() {
            log::debug!("[META] load_meta: {} file does not exist", path.display());
            return None;
        }
        let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if file_size == 0 {
            log::warn!("[META] load_meta: {} exists but is 0 bytes (zero-byte window)", path.display());
            return None;
        }
        let data = match std::fs::read_to_string(&path) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("[META] load_meta: {} read_to_string failed: {} (size={})", path.display(), e, file_size);
                return None;
            }
        };
        match serde_json::from_str(&data) {
            Ok(m) => Some(m),
            Err(e) => {
                log::warn!("[META] load_meta: {} JSON parse failed: {} (size={}, content_len={}, first_80={:?})", 
                    path.display(), e, file_size, data.len(), &data[..data.len().min(80)]);
                None
            }
        }
    }

    /// Save metadata to disk atomically.
    /// Strategy: write to a temp file, sync it to disk, then atomically
    /// rename it over the target. On modern Rust/Windows, rename replaces
    /// the destination (MOVEFILE_REPLACE_EXISTING). On older Rust where
    /// rename fails if destination exists, we fall back to in-place
    /// overwrite (open-for-write without truncate, write, truncate, sync).
    ///
    /// Critical: we sync_all the .tmp file BEFORE renaming. This ensures
    /// the data is committed to disk before the atomic replace, preventing
    /// scenarios where rename succeeds but the file content hasn't reached
    /// stable storage — which could cause load_meta to read incomplete data
    /// on a busy Windows filesystem.
    pub fn save_meta(&self, meta: &CacheMeta) -> std::io::Result<()> {
        let path = self.meta_path(meta.message_id);
        let json = serde_json::to_string_pretty(meta)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let tmp_path = path.with_extension("tmp");

        // Write .tmp with explicit sync to ensure data hits disk before rename
        use std::io::Write;
        {
            let mut tmp_file = std::fs::File::create(&tmp_path)?;
            tmp_file.write_all(json.as_bytes())?;
            tmp_file.sync_all()?; // CRITICAL: commit to disk before rename
        }

        match std::fs::rename(&tmp_path, &path) {
            Ok(()) => {
                log::debug!("[META] save_meta: renamed {} -> {} ({}B)", tmp_path.display(), path.display(), json.len());
                Ok(())
            }
            Err(rename_err) => {
                // Rename failed — log the reason and fall back to in-place overwrite
                log::warn!("[META] save_meta: rename {} -> {} failed: {}, falling back to in-place overwrite ({}B)", 
                    tmp_path.display(), path.display(), rename_err, json.len());
                use std::io::{Seek, SeekFrom};
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&path)?;
                file.seek(SeekFrom::Start(0))?;
                file.write_all(json.as_bytes())?;
                file.set_len(json.len() as u64)?; // Truncate if new content shorter
                file.sync_all()?;
                std::fs::remove_file(&tmp_path).ok();
                Ok(())
            }
        }
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
            filename: meta.filename.clone(),
            cached_ranges: meta.cached_ranges.clone(),
        })
    }

    /// Acquire a per-message lock for serializing read-modify-write
    /// operations on CacheMeta. Prevents race conditions between
    /// player's cmd_report_cached_ranges and download's per-chunk updates.
    pub async fn lock_meta(&self, message_id: i32) -> tokio::sync::OwnedMutexGuard<()> {
        let mut locks = self.meta_locks.lock().await;
        let entry = locks
            .entry(message_id)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())));
        let lock = Arc::clone(entry);
        drop(locks);
        lock.lock_owned().await
    }

    /// Delete cache for a specific message.
    /// Refuses to delete if the message is currently being streamed
    /// (frontend cmd_delete_cache during streaming caused catastrophic
    /// range loss because files enter "pending-delete" state on Windows).
    pub fn delete_cache(&self, message_id: i32) -> std::io::Result<()> {
        if self.is_streaming(message_id) {
            log::warn!("[CACHE] delete_cache: msg {} has active streaming — skipping deletion, cache will be cleaned on exit", message_id);
            return Ok(());
        }
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

    /// Track that a message is currently being streamed (Actix response active).
    /// Synchronous so it can be used in Drop guards.
    pub fn track_streaming(&self, message_id: i32) {
        self.streaming_active.lock().unwrap().push(message_id);
    }

    /// Untrack a streaming message (called when stream ends or client disconnects).
    /// Removes only ONE entry — concurrent streams for the same message_id
    /// (e.g. player seeks spawning a new range request) each track/untrack
    /// independently.
    pub fn untrack_streaming(&self, message_id: i32) {
        if let Ok(mut v) = self.streaming_active.lock() {
            if let Some(pos) = v.iter().position(|&id| id == message_id) {
                v.remove(pos);
            }
        }
    }

    /// Check if a message is currently being streamed by Actix.
    pub fn is_streaming(&self, message_id: i32) -> bool {
        self.streaming_active.lock().map(|v| v.contains(&message_id)).unwrap_or(false)
    }
}

/// Merge overlapping/adjacent ranges (utility function).
/// Sorts by start byte first to handle ranges pushed in any order
/// (e.g., seek ranges that fall between existing ranges).
pub fn merge_ranges(ranges: &mut Vec<(u64, u64)>) {
    if ranges.is_empty() {
        return;
    }
    ranges.sort_by(|a, b| a.0.cmp(&b.0));
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

/// Find byte ranges that are NOT covered by cached_ranges
pub fn find_gaps(cached_ranges: &[(u64, u64)], total_size: u64) -> Vec<(u64, u64)> {
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

/// Check if a byte range is fully covered by the union of cached_ranges.
/// Works by checking that every byte in [range_start, range_end] is covered
/// by at least one cached range. Since ranges are sorted and merged, we can
/// walk through them to verify coverage.
pub fn is_range_cached(cached_ranges: &[(u64, u64)], range_start: u64, range_end: u64) -> bool {
    let mut covered_start = range_start;
    for &(start, end) in cached_ranges {
        if start > covered_start {
            return false; // Gap found
        }
        covered_start = end.max(covered_start) + 1;
        if covered_start > range_end {
            return true; // Fully covered
        }
    }
    covered_start > range_end
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_ranges_empty() {
        let mut ranges = vec![];
        merge_ranges(&mut ranges);
        assert!(ranges.is_empty());
    }

    #[test]
    fn test_merge_ranges_adjacent() {
        let mut ranges = vec![(0, 100), (101, 200)];
        merge_ranges(&mut ranges);
        assert_eq!(ranges, vec![(0, 200)]);
    }

    #[test]
    fn test_merge_ranges_overlapping() {
        let mut ranges = vec![(0, 100), (50, 200)];
        merge_ranges(&mut ranges);
        assert_eq!(ranges, vec![(0, 200)]);
    }

    #[test]
    fn test_merge_ranges_separate() {
        let mut ranges = vec![(0, 100), (200, 300)];
        merge_ranges(&mut ranges);
        assert_eq!(ranges, vec![(0, 100), (200, 300)]);
    }

    /// Bug: seek pushes a range between existing ranges, making the
    /// vector unsorted. Without sorting, merge_ranges incorrectly
    /// merges the seek range into a later range because it only
    /// checks adjacency against the last merged range.
    #[test]
    fn test_merge_ranges_unsorted_seek() {
        // Existing: (0, 35127295), (116927754, 149422079)
        // Seek pushes: (36832312, 37224447)
        let mut ranges = vec![(0, 35127295), (116927754, 149422079), (36832312, 37224447)];
        merge_ranges(&mut ranges);
        // Should produce 3 separate ranges (the seek range is between the two)
        assert_eq!(ranges, vec![(0, 35127295), (36832312, 37224447), (116927754, 149422079)]);
    }

    #[test]
    fn test_find_gaps_empty_cache() {
        let gaps = find_gaps(&[], 1000);
        assert_eq!(gaps, vec![(0, 999)]);
    }

    #[test]
    fn test_find_gaps_partial() {
        let gaps = find_gaps(&[(0, 499)], 1000);
        assert_eq!(gaps, vec![(500, 999)]);
    }

    #[test]
    fn test_find_gaps_middle() {
        let gaps = find_gaps(&[(200, 499)], 1000);
        assert_eq!(gaps, vec![(0, 199), (500, 999)]);
    }

    #[test]
    fn test_find_gaps_complete() {
        let gaps = find_gaps(&[(0, 999)], 1000);
        assert!(gaps.is_empty());
    }

    #[test]
    fn test_cache_meta_percentage() {
        let meta = CacheMeta {
            message_id: 1,
            folder_id: 0,
            total_size: 1000,
            filename: "test.mp4".into(),
            cached_ranges: vec![(0, 499)],
            mime_type: "video/mp4".into(),
        };
        assert_eq!(meta.cached_percentage(), 50);
        assert!(!meta.is_complete());
    }

    #[test]
    fn test_cache_meta_complete() {
        let meta = CacheMeta {
            message_id: 1,
            folder_id: 0,
            total_size: 1000,
            filename: "test.mp4".into(),
            cached_ranges: vec![(0, 999)],
            mime_type: "video/mp4".into(),
        };
        assert_eq!(meta.cached_percentage(), 100);
        assert!(meta.is_complete());
    }

    #[test]
    fn test_is_range_cached_fully_covered() {
        // Single range covers a subrange
        let ranges = vec![(0, 499)];
        assert!(is_range_cached(&ranges, 100, 200));
        assert!(is_range_cached(&ranges, 0, 499));

        // Adjacent ranges merged into one — covers full span
        let merged = vec![(0, 999)];
        assert!(is_range_cached(&merged, 0, 999));

        // Multiple ranges covering full span
        let multi = vec![(0, 100), (101, 499)];
        assert!(is_range_cached(&multi, 0, 499));
        assert!(is_range_cached(&multi, 50, 300));
    }

    #[test]
    fn test_is_range_cached_not_covered() {
        let ranges = vec![(0, 499)];
        assert!(!is_range_cached(&ranges, 500, 999));
    }

    #[test]
    fn test_is_range_cached_partially_covered() {
        let ranges = vec![(0, 499)];
        // Range spans cached and uncached — not fully covered
        assert!(!is_range_cached(&ranges, 400, 600));
    }

    #[test]
    fn test_is_range_cached_multi_range_gap() {
        // Two ranges with a gap in between — request across gap fails
        let ranges = vec![(0, 100), (200, 499)];
        assert!(!is_range_cached(&ranges, 0, 499)); // gap at 101-199
        assert!(is_range_cached(&ranges, 0, 100)); // fully in first range
        assert!(is_range_cached(&ranges, 200, 499)); // fully in second range
    }

    #[test]
    fn test_is_range_cached_empty() {
        assert!(!is_range_cached(&[], 0, 999));
    }

    /// Simulates the per-chunk incremental meta update pattern used in cmd_download_file.
    /// Each chunk of a gap pushes (offset, chunk_end-1), then merge_ranges collapses them.
    /// Before the fix, `gap_start` was used instead of `offset`, causing all chunks to
    /// collapse to ~512KB instead of the full gap size after merge_ranges.
    #[test]
    fn test_incremental_chunk_tracking_fills_full_gap() {
        let gap_size = 134_217_728u64; // ~134MB gap
        let gap_start = 15_728_640u64;
        let chunk_size = 512 * 1024u64; // 512KB

        let mut meta = CacheMeta {
            message_id: 1,
            folder_id: 0,
            total_size: 805_065_869,
            filename: "test.mp4".into(),
            cached_ranges: vec![(0, gap_start - 1)], // data before gap
            mime_type: "video/mp4".into(),
        };

        let mut offset = gap_start;
        while offset <= gap_start + gap_size - 1 {
            let to_write = chunk_size.min(gap_start + gap_size - offset);
            let chunk_end = offset + to_write; // exclusive end
            // THIS is the fix: use `offset` not `gap_start`
            meta.cached_ranges.push((offset, chunk_end - 1));
            merge_ranges(&mut meta.cached_ranges);
            offset += to_write;
        }

        // After all chunks, the entire gap should be covered
        assert!(is_range_cached(&meta.cached_ranges, gap_start, gap_start + gap_size - 1));
        assert_eq!(meta.cached_ranges.len(), 1, "should merge into single range");
        assert_eq!(meta.cached_ranges[0], (0, gap_start + gap_size - 1));
    }

    /// Reproduces the BUG: using `gap_start` instead of `offset` for every chunk.
    /// Surprise: this is BENIGN because `chunk_end` advances correctly (it uses
    /// `offset + to_write`), so despite every range starting at `gap_start`,
    /// `merge_ranges` extends the end correctly each iteration.
    #[test]
    fn test_incremental_chunk_tracking_bug_using_gap_start() {
        let gap_size = 134_217_728u64;
        let gap_start = 15_728_640u64;
        let chunk_size = 512 * 1024u64;

        let mut meta = CacheMeta {
            message_id: 1,
            folder_id: 0,
            total_size: 805_065_869,
            filename: "test.mp4".into(),
            cached_ranges: vec![(0, gap_start - 1)],
            mime_type: "video/mp4".into(),
        };

        let mut offset = gap_start;
        while offset <= gap_start + gap_size - 1 {
            let to_write = chunk_size.min(gap_start + gap_size - offset);
            let chunk_end = offset + to_write;
            // BUG: using gap_start instead of offset — but chunk_end uses offset,
            // so merge_ranges still extends the range correctly.
            meta.cached_ranges.push((gap_start, chunk_end - 1));
            merge_ranges(&mut meta.cached_ranges);
            offset += to_write;
        }

        // Surprisingly, this ALSO works because chunk_end advances with offset
        // and merge_ranges extends the cached range each iteration.
        assert!(is_range_cached(&meta.cached_ranges, gap_start, gap_start + gap_size - 1));
        assert_eq!(meta.cached_ranges.len(), 1);
        assert_eq!(meta.cached_ranges[0], (0, gap_start + gap_size - 1));
    }
}
