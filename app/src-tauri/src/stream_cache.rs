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
    /// Byte ranges that are cached on disk (for green buffer bar)
    pub cached_ranges: Vec<(u64, u64)>,
}

/// Manages the disk cache for streamed media
#[derive(Clone)]
pub struct StreamCacheManager {
    cache_dir: PathBuf,
    /// Active background cache tasks: message_id
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
            filename: meta.filename.clone(),
            cached_ranges: meta.cached_ranges.clone(),
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

/// Merge overlapping/adjacent ranges (utility function)
pub fn merge_ranges(ranges: &mut Vec<(u64, u64)>) {
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
}
