use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
}

impl StreamCacheManager {
    pub fn new(cache_dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&cache_dir)?;
        Ok(Self {
            cache_dir,
            active_tasks: Arc::new(Mutex::new(Vec::new())),
            meta_locks: Arc::new(Mutex::new(HashMap::new())),
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

    /// Save metadata to disk atomically.
    /// On POSIX: write to temp file, then rename (atomically replaces target).
    /// On Windows: rename fails if target exists, so we overwrite in place
    /// (truncate + write) — the file never disappears, preventing load_meta
    /// from returning None during the write gap. The per-message lock ensures
    /// no concurrent reads observe the truncated state.
    pub fn save_meta(&self, meta: &CacheMeta) -> std::io::Result<()> {
        let path = self.meta_path(meta.message_id);
        let json = serde_json::to_string_pretty(meta)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let tmp_path = path.with_extension("tmp");
        std::fs::write(&tmp_path, &json)?;
        match std::fs::rename(&tmp_path, &path) {
            Ok(()) => Ok(()),
            Err(_) => {
                // On Windows, rename fails if target exists.
                // Overwrite in place: truncate + write. The file always exists
                // (never removed), so load_meta never sees a missing file.
                // The per-message lock serializes access during the overwrite.
                let mut file = std::fs::File::create(&path)?;
                use std::io::Write;
                file.write_all(json.as_bytes())?;
                file.sync_all()?;
                // Close the file handle before removing temp (drop happens at end of scope)
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
