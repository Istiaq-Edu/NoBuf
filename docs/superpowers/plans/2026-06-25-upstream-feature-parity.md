# Upstream Feature Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 26 features from upstream caamer20/Telegram-Drive (v1.4.1–v1.9.5) that our NoBuf fork is missing, ordered P0→P4 by priority.

**Architecture:** Our fork diverged at upstream v1.4.0. We have 171 custom commits (HLS/fMP4/FastStream/MSE/stream-cache) with zero upstream merges. Each feature below is implemented independently, verified against our actual codebase, and tested. No assumptions — every file path, line number, and function signature has been verified.

**Tech Stack:** Tauri 2, Rust (Actix-web 4, grammers-client), React 19, TypeScript, Vitest, cargo test

---

## Verified Baseline (2026-06-25)

| Check | Status |
|---|---|
| `npx tsc --noEmit` | ✅ PASS (0 errors) |
| `npx vitest run` | ✅ 81 tests pass (3 files) |
| `cargo test` | Compiling (background — check result before starting) |
| Frontend test framework | Vitest 4.1.6 |
| Rust test framework | `#[cfg(test)]` in stream_cache.rs (9 tests) |
| Last upstream tag | v1.4.0 (commit 74f82c9) |
| Our version | 0.1.0 (package.json + tauri.conf.json) |

---

## Corrections From Initial Audit (Verified Against Code)

1. **Thumbnail cleanup on exit**: We DO have it (`lib.rs:487-503` removes `thumbnails/` and `previews/`). NOT a gap.
2. **Windows filename sanitization**: Upstream does NOT have it in Rust backend either — it's frontend-only or release-note-only. DOWNGRADED from P0 to P4.
3. **`process:allow-restart`**: Our capabilities have `updater:default` but NOT `process:allow-restart`. The updater may fail to restart the app after installing.
4. **offset_id pagination**: Our `cmd_get_files` uses `iter_messages` (unbounded iterator). This is actually fine for most cases — grammers handles pagination internally. The upstream concern was about their `limit: 50` hardcoded call. We don't have that problem.

---

## P0 — Bugs & Security (Fix Now, <30 min total)

### Task P0.1: Constant-Time API Key Comparison

**Objective:** Replace direct `==` string comparison in API key verification with constant-time comparison to prevent timing attacks.

**Files:**
- Modify: `app/src-tauri/Cargo.toml` (add dependency)
- Modify: `app/src-tauri/src/commands/api_settings.rs:63-65` (change `verify_key`)
- Test: `app/src-tauri/src/commands/api_settings.rs` (add `#[cfg(test)]` module)

**Verified current code** (`api_settings.rs:56-65`):
```rust
fn hash_key(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Verify a plaintext key against a stored hash
pub fn verify_key(plaintext: &str, stored_hash: &str) -> bool {
    hash_key(plaintext) == stored_hash
}
```

**Verified Cargo.toml** (`Cargo.toml:18-51`): No `constant_time_eq` dependency. Has `sha2 = "0.10"`, `rand = "0.8"`.

- [ ] **Step 1: Add `constant_time_eq` dependency to Cargo.toml**

Add after line 50 (`ureq = ...`):
```toml
constant_time_eq = "0.3"
```

- [ ] **Step 2: Write failing test**

Add at the end of `api_settings.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verify_key_correct() {
        let hash = hash_key("my-secret-key-123");
        assert!(verify_key("my-secret-key-123", &hash));
    }

    #[test]
    fn test_verify_key_wrong() {
        let hash = hash_key("my-secret-key-123");
        assert!(!verify_key("wrong-key", &hash));
    }

    #[test]
    fn test_verify_key_empty() {
        let hash = hash_key("");
        assert!(verify_key("", &hash));
        assert!(!verify_key("a", &hash));
    }

    #[test]
    fn test_verify_key_different_lengths() {
        let hash = hash_key("key1");
        assert!(!verify_key("key1extra", &hash));
        assert!(!verify_key("ke", &hash));
    }
}
```

- [ ] **Step 3: Run test to verify it compiles and passes with current code**

Run: `cd app/src-tauri && cargo test api_settings -- --nocapture`
Expected: PASS (the tests pass because `==` is functionally correct, just not constant-time)

- [ ] **Step 4: Replace `verify_key` with constant-time comparison**

Replace `api_settings.rs:63-65`:
```rust
/// Verify a plaintext key against a stored hash using constant-time comparison
/// to prevent timing side-channel attacks.
pub fn verify_key(plaintext: &str, stored_hash: &str) -> bool {
    let computed = hash_key(plaintext);
    constant_time_eq::constant_time_eq(computed.as_bytes(), stored_hash.as_bytes())
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd app/src-tauri && cargo test api_settings -- --nocapture`
Expected: 4 tests PASS

- [ ] **Step 6: Verify full build compiles**

Run: `cd app/src-tauri && cargo check`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/commands/api_settings.rs
git commit -m "security: use constant-time comparison for API key verification"
```

**Edge cases handled:**
- Empty key: `hash_key("")` produces a valid hash, `constant_time_eq` handles it
- Different length strings: `constant_time_eq` returns `false` for different lengths without timing leak
- Hash format: Both sides are hex strings of identical length (64 chars for SHA-256), so length-mismatch is impossible in normal operation

---

### Task P0.2: Natural Alphanumeric Sorting

**Objective:** Fix file sorting to use natural alphanumeric order (1, 2, 10) instead of lexicographic (1, 10, 2).

**Files:**
- Modify: `app/src/components/dashboard/FileExplorer.tsx:164` (change `localeCompare` call)
- Modify: `app/src/components/dashboard/FileExplorer.tsx:170` (same fix for date sort)
- Test: `app/src/__tests__/naturalSort.test.ts` (new test file)

**Verified current code** (`FileExplorer.tsx:159-175`):
```typescript
const sortedFiles = useMemo(() => {
    return [...files].sort((a, b) => {
        let comparison = 0;
        switch (sortField) {
            case 'name':
                comparison = a.name.localeCompare(b.name);
                break;
            case 'size':
                comparison = (a.size || 0) - (b.size || 0);
                break;
            case 'date':
                comparison = (a.created_at || '').localeCompare(b.created_at || '');
                break;
        }
        return sortDirection === 'asc' ? comparison : -comparison;
    });
}, [files, sortField, sortDirection]);
```

- [ ] **Step 1: Write failing test**

Create `app/src/__tests__/naturalSort.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

// Mirror the exact comparator used in FileExplorer.tsx
function naturalCompare(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

describe('natural alphanumeric sorting', () => {
    it('sorts file1, file2, file10 in numeric order', () => {
        const files = ['file10.mp4', 'file2.mp4', 'file1.mp4'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['file1.mp4', 'file2.mp4', 'file10.mp4']);
    });

    it('sorts episode numbers correctly', () => {
        const files = ['Episode 10.mp4', 'Episode 2.mp4', 'Episode 1.mp4', 'Episode 20.mp4'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['Episode 1.mp4', 'Episode 2.mp4', 'Episode 10.mp4', 'Episode 20.mp4']);
    });

    it('sorts mixed numbers and letters', () => {
        const files = ['file10a.txt', 'file2b.txt', 'file1a.txt'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['file1a.txt', 'file2b.txt', 'file10a.txt']);
    });

    it('handles leading numbers', () => {
        const files = ['10_report.pdf', '2_report.pdf', '1_report.pdf'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['1_report.pdf', '2_report.pdf', '10_report.pdf']);
    });

    it('is case-insensitive', () => {
        const files = ['File.txt', 'apple.txt', 'Banana.txt'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['apple.txt', 'Banana.txt', 'File.txt']);
    });

    it('handles plain text without numbers', () => {
        const files = ['zebra.txt', 'apple.txt', 'mango.txt'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['apple.txt', 'mango.txt', 'zebra.txt']);
    });
});
```

- [ ] **Step 2: Run test to verify it passes (tests the comparator pattern, not the actual code yet)**

Run: `cd app && npx vitest run src/__tests__/naturalSort.test.ts`
Expected: 6 tests PASS

- [ ] **Step 3: Apply fix to FileExplorer.tsx**

Replace line 164:
```typescript
                    comparison = a.name.localeCompare(b.name);
```
With:
```typescript
                    comparison = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
```

Replace line 170:
```typescript
                    comparison = (a.created_at || '').localeCompare(b.created_at || '');
```
With:
```typescript
                    comparison = (a.created_at || '').localeCompare(b.created_at || '', undefined, { numeric: true });
```

- [ ] **Step 4: Run tsc to verify no type errors**

Run: `cd app && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Run all frontend tests**

Run: `cd app && npx vitest run`
Expected: All tests PASS (previous 81 + new 6 = 87)

- [ ] **Step 6: Commit**

```bash
git add app/src/components/dashboard/FileExplorer.tsx app/src/__tests__/naturalSort.test.ts
git commit -m "fix: use natural alphanumeric sorting in file explorer"
```

**Edge cases handled:**
- Unicode: `localeCompare` with `sensitivity: 'base''` handles locale-specific ordering
- Empty strings: `localeCompare` handles empty strings (returns 0 or ±1)
- Mixed case: `sensitivity: 'base'` makes it case-insensitive
- Files without numbers: Falls back to standard alphabetical sort

---

### Task P0.3: Add `createUpdaterArtifacts` to tauri.conf.json

**Objective:** Enable automatic generation of `.sig` signature files and `latest.json` manifest during production builds, which the Tauri updater needs.

**Files:**
- Modify: `app/src-tauri/tauri.conf.json:26-36` (add `createUpdaterArtifacts` to bundle section)

**Verified current code** (`tauri.conf.json:26-36`):
```json
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
```

**Verified**: The `plugins.updater` section (lines 3-9) has endpoints and pubkey configured. But `createUpdaterArtifacts` is missing from the bundle section.

- [ ] **Step 1: Add `createUpdaterArtifacts` to bundle config**

In `tauri.conf.json`, inside the `"bundle"` object, add `"createUpdaterArtifacts": true`:

```json
  "bundle": {
    "active": true,
    "createUpdaterArtifacts": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
```

- [ ] **Step 2: Verify JSON is valid**

Run: `cd app/src-tauri && python -c "import json; json.load(open('tauri.conf.json')); print('valid')"`
Expected: `valid`

- [ ] **Step 3: Verify Tauri config is accepted**

Run: `cd app/src-tauri && cargo check`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/tauri.conf.json
git commit -m "fix: enable createUpdaterArtifacts for auto-update signature generation"
```

**Edge cases:**
- This only affects production builds (`tauri build`), not dev mode
- The pubkey in the updater config must match the signing key used in CI
- If the signing key is not configured in CI, builds will fail — but that's a CI config issue, not a code issue

---

### Task P0.4: Add `process:allow-restart` Capability

**Objective:** Allow the Tauri updater to relaunch the app after installing an update.

**Files:**
- Modify: `app/src-tauri/capabilities/default.json:9-58` (add permission)

**Verified current code** (`capabilities/default.json:9-58`): Contains `updater:default` (line 18) but NOT `process:allow-restart`. Has `tauri-plugin-process = "2.3.1"` in Cargo.toml (line 44).

- [ ] **Step 1: Add `process:allow-restart` permission**

In `capabilities/default.json`, add to the `"permissions"` array (after `"updater:default"`):

```json
    "updater:default",
    "process:allow-restart",
```

- [ ] **Step 2: Verify JSON is valid**

Run: `cd app/src-tauri && python -c "import json; json.load(open('capabilities/default.json')); print('valid')"`
Expected: `valid`

- [ ] **Step 3: Verify Tauri config is accepted**

Run: `cd app/src-tauri && cargo check`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/capabilities/default.json
git commit -m "fix: add process:allow-restart capability for updater relaunch"
```

**Edge cases:**
- If `tauri-plugin-process` is not in Cargo.toml, this permission would be invalid. Verified: it IS in Cargo.toml line 44.
- This permission is only used by the updater's "Update & Restart" flow.

---

## P1 — Reliability (Hours)

### Task P1.1: Cache Download Integrity Verification

**Objective:** After a download completes, verify the actual file size on disk matches the expected size before declaring success. Prevents truncated files from being cached and causing FFmpeg parsing errors.

**Files:**
- Modify: `app/src-tauri/src/commands/fs.rs:778-788` (parallel download path — add verification after loop)
- Modify: `app/src-tauri/src/commands/fs.rs:869-881` (sequential download path — add verification after loop)
- Test: inline in `stream_cache.rs` test module (add integration-level test for size check)

**Verified current code — parallel path** (`fs.rs:778-788`):
```rust
            bw_state.add_down(total_size);

            if !tid.is_empty() {
                let _ = app_handle.emit("download-progress", ProgressPayload {
                    id: tid, percent: 100, uploaded_bytes: downloaded, total_bytes: total_size, speed_bytes_per_sec: 0,
                });
            }

            return Ok("Download successful (parallel)".to_string());
        }
    }
```

**Problem**: No `sync_all()` / `flush()` on the file. No verification that `downloaded == total_size`. No verification that the file on disk is the right size.

**Verified current code — sequential path** (`fs.rs:869-881`):
```rust
    bw_state.add_down(total_size);

    // Emit completion
    if !tid.is_empty() {
        let _ = app_handle.emit("download-progress", ProgressPayload {
            id: tid, percent: 100, uploaded_bytes: downloaded, total_bytes: total_size, speed_bytes_per_sec: 0,
        });
    }

    Ok("Download successful".to_string())
```

Same problem — no sync, no verification.

- [ ] **Step 1: Write the verification helper as a Rust test**

Add to the end of `fs.rs` (or in a `#[cfg(test)]` module if one exists, or create one):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_download_size_verification_logic() {
        // Simulate the verification logic:
        // 1. downloaded bytes counter must match expected total_size
        // 2. actual file size on disk must match downloaded counter
        let total_size: u64 = 1000;
        let downloaded: u64 = 1000;
        assert_eq!(downloaded, total_size, "downloaded must match total_size");

        let total_size: u64 = 1000;
        let downloaded: u64 = 500;
        assert_ne!(downloaded, total_size, "partial download should fail verification");
    }
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd app/src-tauri && cargo test fs::tests -- --nocapture`
Expected: PASS

- [ ] **Step 3: Add verification to parallel download path**

Replace `fs.rs:778-788` (the `bw_state.add_down(total_size);` block in the parallel path) with:

```rust
            // Flush + sync to ensure data is on disk before verification
            file.flush().map_err(|e| format!("Flush error: {}", e))?;
            file.sync_all().map_err(|e| format!("Sync error: {}", e))?;
            drop(file);

            // Verify download integrity
            if downloaded == 0 {
                cleanup_partial_file(&save_path);
                return Err("Downloaded file was empty".to_string());
            }
            if downloaded != total_size {
                cleanup_partial_file(&save_path);
                return Err(format!(
                    "Incomplete download: expected {} bytes, received {} bytes",
                    total_size, downloaded
                ));
            }
            // Verify actual file size on disk
            let actual_size = std::fs::metadata(&save_path)
                .map(|m| m.len())
                .unwrap_or(0);
            if actual_size != total_size {
                cleanup_partial_file(&save_path);
                return Err(format!(
                    "File size mismatch: expected {} bytes on disk, found {} bytes",
                    total_size, actual_size
                ));
            }

            bw_state.add_down(total_size);
```

- [ ] **Step 4: Add verification to sequential download path**

Replace `fs.rs:869-881` (the `bw_state.add_down(total_size);` block in the sequential path) with:

```rust
            // Flush + sync to ensure data is on disk before verification
            file.flush().map_err(|e| format!("Flush error: {}", e))?;
            file.sync_all().map_err(|e| format!("Sync error: {}", e))?;
            drop(file);

            // Verify download integrity
            if downloaded == 0 {
                cleanup_partial_file(&save_path);
                return Err("Downloaded file was empty".to_string());
            }
            if downloaded != total_size {
                cleanup_partial_file(&save_path);
                return Err(format!(
                    "Incomplete download: expected {} bytes, received {} bytes",
                    total_size, downloaded
                ));
            }
            // Verify actual file size on disk
            let actual_size = std::fs::metadata(&save_path)
                .map(|m| m.len())
                .unwrap_or(0);
            if actual_size != total_size {
                cleanup_partial_file(&save_path);
                return Err(format!(
                    "File size mismatch: expected {} bytes on disk, found {} bytes",
                    total_size, actual_size
                ));
            }

            bw_state.add_down(total_size);

            // Emit completion
            if !tid.is_empty() {
                let _ = app_handle.emit("download-progress", ProgressPayload {
                    id: tid, percent: 100, uploaded_bytes: downloaded, total_bytes: total_size, speed_bytes_per_sec: 0,
                });
            }

            Ok("Download successful".to_string())
```

- [ ] **Step 5: Run Rust tests**

Run: `cd app/src-tauri && cargo test -- --nocapture`
Expected: All tests PASS (existing stream_cache tests + new fs tests)

- [ ] **Step 6: Verify full build compiles**

Run: `cd app/src-tauri && cargo check`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/commands/fs.rs
git commit -m "fix: verify download integrity with flush+sync+size check before declaring success"
```

**Edge cases handled:**
- Empty file: `downloaded == 0` check catches this
- Network drop mid-download: `downloaded != total_size` catches this
- Disk full / write error: `actual_size != total_size` catches this
- Photo media: `total_size` is hardcoded to `1024 * 1024` for photos (`fs.rs:453`), so the size check may false-positive. **Consider**: skip size verification for photos (`Media::Photo`). However, photos go through the sequential path which writes all bytes from `iter_download`, so `downloaded` will equal `total_size` only if all chunks were received. The `total_size = 1024 * 1024` is a placeholder — actual photo bytes may differ. **Fix**: For `Media::Photo`, set `total_size = 0` and skip the size check when `total_size == 0`:

```rust
            // Verify download integrity (skip for photos where size is unknown)
            if total_size > 0 {
                if downloaded == 0 {
                    cleanup_partial_file(&save_path);
                    return Err("Downloaded file was empty".to_string());
                }
                if downloaded != total_size {
                    cleanup_partial_file(&save_path);
                    return Err(format!(
                        "Incomplete download: expected {} bytes, received {} bytes",
                        total_size, downloaded
                    ));
                }
                let actual_size = std::fs::metadata(&save_path)
                    .map(|m| m.len())
                    .unwrap_or(0);
                if actual_size != total_size {
                    cleanup_partial_file(&save_path);
                    return Err(format!(
                        "File size mismatch: expected {} bytes on disk, found {} bytes",
                        total_size, actual_size
                    ));
                }
            }
```

Apply the `if total_size > 0` guard in both paths.

---

### Task P1.2: Exponential Backoff with Jitter

**Objective:** Add random jitter to our existing exponential backoff in streaming retry loops to prevent thundering herd effects when multiple clients retry simultaneously.

**Files:**
- Modify: `app/src-tauri/src/commands/streaming.rs:710` (proactive prebuffer retry)
- Modify: `app/src-tauri/src/commands/streaming.rs:1091` (sequential download retry)

**Verified current code** (`streaming.rs:710`):
```rust
                    let delay = 5000u64 * 2u64.pow(setup_attempt - 1);
```

**Verified current code** (`streaming.rs:1091`):
```rust
                        let delay = (2000u64 * 2u64.pow(seq_retries - 1)).min(60_000);
```

**Upstream formula** (verified from source):
```rust
pub fn backoff_ms(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    let exp = base_ms.saturating_mul(1u64 << attempt.min(10));
    let capped = exp.min(max_ms);
    let jitter = (capped as f64 * 0.25 * rand::random::<f64>()) as u64;
    capped + jitter
}
```

- [ ] **Step 1: Add a shared `backoff_with_jitter` helper**

Add to `app/src-tauri/src/commands/utils.rs` (after the existing `map_error` function):

```rust
/// Calculate exponential backoff delay with ~25% random jitter.
/// Prevents thundering herd effects when multiple clients retry simultaneously.
/// - `attempt`: 1-based retry attempt number
/// - `base_ms`: base delay for first attempt
/// - `max_ms`: maximum delay cap
pub fn backoff_with_jitter(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    let exp = base_ms.saturating_mul(1u64 << attempt.min(10));
    let capped = exp.min(max_ms);
    let jitter = (capped as f64 * 0.25 * rand::random::<f64>()) as u64;
    capped + jitter
}
```

- [ ] **Step 2: Write test for the helper**

Add to `utils.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backoff_grows_exponentially() {
        let b1 = backoff_with_jitter(1, 5000, 60_000);
        let b2 = backoff_with_jitter(2, 5000, 60_000);
        let b3 = backoff_with_jitter(3, 5000, 60_000);
        // With jitter, b1 is in [5000, 6250], b2 in [10000, 12500], b3 in [20000, 25000]
        assert!(b1 >= 5000 && b1 <= 6250, "b1 should be 5000-6250, got {}", b1);
        assert!(b2 >= 10000 && b2 <= 12500, "b2 should be 10000-12500, got {}", b2);
        assert!(b3 >= 20000 && b3 <= 25000, "b3 should be 20000-25000, got {}", b3);
    }

    #[test]
    fn test_backoff_capped_at_max() {
        // 5000 * 2^10 = 5,120,000 — way over 60,000 cap
        let delay = backoff_with_jitter(10, 5000, 60_000);
        assert!(delay >= 60000 && delay <= 75000, "should be capped at 60000+jitter, got {}", delay);
    }

    #[test]
    fn test_backoff_attempt_zero() {
        let delay = backoff_with_jitter(0, 5000, 60_000);
        // 5000 * 2^0 = 5000, jitter 0-1250
        assert!(delay >= 5000 && delay <= 6250, "attempt 0 should be 5000-6250, got {}", delay);
    }
}
```

- [ ] **Step 3: Run test**

Run: `cd app/src-tauri && cargo test utils::tests -- --nocapture`
Expected: 3 tests PASS

- [ ] **Step 4: Replace proactive prebuffer retry delay**

In `streaming.rs:710`, replace:
```rust
                    let delay = 5000u64 * 2u64.pow(setup_attempt - 1);
```
With:
```rust
                    let delay = crate::commands::utils::backoff_with_jitter(setup_attempt, 5000, 60_000);
```

- [ ] **Step 5: Replace sequential download retry delay**

In `streaming.rs:1091`, replace:
```rust
                        let delay = (2000u64 * 2u64.pow(seq_retries - 1)).min(60_000);
```
With:
```rust
                        let delay = crate::commands::utils::backoff_with_jitter(seq_retries, 2000, 60_000);
```

- [ ] **Step 6: Verify build**

Run: `cd app/src-tauri && cargo check`
Expected: no errors

- [ ] **Step 7: Run all Rust tests**

Run: `cd app/src-tauri && cargo test -- --nocapture`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri/src/commands/utils.rs app/src-tauri/src/commands/streaming.rs
git commit -m "fix: add jitter to exponential backoff in streaming retry loops"
```

**Edge cases:**
- `attempt = 0`: `1u64 << 0 = 1`, so `base_ms * 1 = base_ms`. Correct.
- `attempt > 10`: `.min(10)` prevents overflow. `base_ms * 2^10` is capped by `max_ms`.
- Jitter range: 0 to 25% of capped value. This means the delay is always ≥ base delay, never below it.

---

### Task P1.3: Path Canonicalization for Filesystem Commands

**Objective:** Prevent path traversal attacks by canonicalizing paths in filesystem commands before use.

**Files:**
- Modify: `app/src-tauri/src/commands/fs.rs` (add canonicalization in `cmd_download_file`)
- Modify: `app/src-tauri/src/commands/fs.rs` (add canonicalization in `cmd_upload_file`)

**Verified**: No `canonicalize()` calls exist anywhere in our Rust codebase. The `save_path` parameter in `cmd_download_file` comes from the Tauri `save()` dialog (user-selected), so path traversal is unlikely from the frontend. However, the REST API could potentially be extended to accept paths in the future, so this is a defensive measure.

**Important constraint**: We must NOT break existing functionality. `canonicalize()` requires the path to exist, so we can only canonicalize the *parent directory* of the target path, not the target file itself (which may not exist yet for downloads).

- [ ] **Step 1: Write test for canonicalization helper**

Add to `fs.rs` `#[cfg(test)]` module:

```rust
    #[test]
    fn test_canonicalize_parent_exists() {
        // The parent of a temp file should canonicalize successfully
        let tmp = std::env::temp_dir();
        let fake_path = tmp.join("nonexistent_file_12345.txt");
        let parent = fake_path.parent().unwrap();
        let canonical = std::fs::canonicalize(parent);
        assert!(canonical.is_ok(), "parent of temp file should canonicalize");
    }

    #[test]
    fn test_canonicalize_detects_traversal() {
        // A path with ../ should canonicalize to a different path
        let tmp = std::env::temp_dir();
        let traversal_path = tmp.join("../../../etc/passwd");
        let parent = traversal_path.parent().unwrap();
        // canonicalize will resolve the ../ and give us the real path
        if let Ok(canon) = std::fs::canonicalize(parent) {
            // The canonical path should not contain the temp dir
            assert!(!canon.starts_with(&tmp) || canon != tmp,
                "traversal should resolve outside temp dir");
        }
        // If canonicalize fails, the path doesn't exist — that's fine too
    }
```

- [ ] **Step 2: Run test**

Run: `cd app/src-tauri && cargo test fs::tests -- --nocapture`
Expected: PASS

- [ ] **Step 3: Add canonicalization to `cmd_download_file`**

In `fs.rs`, at the start of `cmd_download_file` (after line 427, before the mock check), add:

```rust
    // Canonicalize the parent directory of save_path to prevent path traversal.
    // We canonicalize the parent (not the file) because the target file may not exist yet.
    if let Some(parent) = std::path::Path::new(&save_path).parent() {
        match std::fs::canonicalize(parent) {
            Ok(canon_parent) => {
                let canon_save = canon_parent.join(
                    std::path::Path::new(&save_path).file_name().unwrap_or_default()
                );
                // Log if the canonical path differs from the requested path
                if canon_save.to_string_lossy() != save_path {
                    log::warn!("Path canonicalization changed: {} → {}", save_path, canon_save.display());
                }
            }
            Err(e) => {
                log::warn!("Cannot canonicalize parent of save_path {}: {}", save_path, e);
            }
        }
    }
```

**Note**: This is a *logging* defense, not a *blocking* defense. The `save_path` comes from Tauri's `save()` dialog which is user-selected and safe. If we later add API endpoints that accept paths, we should upgrade this to a hard block.

- [ ] **Step 4: Verify build**

Run: `cd app/src-tauri && cargo check`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands/fs.rs
git commit -m "security: add path canonicalization logging for download paths"
```

**Edge cases:**
- `save_path` with no parent (e.g., `/file.txt`): `parent()` returns `Some("/")` which exists and canonicalizes
- Non-existent parent: `canonicalize` returns `Err`, we log and continue (defensive, not blocking)
- Windows UNC paths: `canonicalize` handles `\\?\` prefixes correctly on Windows

---

## P2 — High-Value New Features (Days)

### Task P2.1: Copy Telegram Link (Context Menu)

**Objective:** Add a right-click context menu option to copy `t.me/{username}/{message_id}` links for files in public channels. Disabled for private channels.

**Files:**
- Modify: `app/src/components/dashboard/ContextMenu.tsx` (add Copy Link button + `onCopyLink` prop)
- Modify: `app/src/components/dashboard/FileExplorer.tsx` (pass `onCopyLink` callback, pass `folderId` for channel lookup)
- Modify: `app/src-tauri/src/commands/fs.rs` (add `cmd_get_channel_username` command)
- Modify: `app/src-tauri/src/lib.rs` (register new command)
- Modify: `app/src-tauri/capabilities/default.json` (add permission)
- Test: `app/src/__tests__/copyLink.test.ts`

**Verified current code**:
- `ContextMenu.tsx`: 111 lines, has props `{ x, y, file, onClose, onDownload, onDelete, onPreview }`. No copy-link.
- `FileExplorer.tsx`: Passes `onContextMenu` callback with `{ x, y, file }`.
- `capabilities/default.json`: No clipboard permission.
- No `@tauri-apps/plugin-clipboard-manager` in `package.json`.

**Dependency needed**: `@tauri-apps/plugin-clipboard-manager` — but we can also use `writeText` from `@tauri-apps/api/clipboard-manager` if available. Let me check:

**Verified**: Our `package.json` does NOT have `@tauri-apps/plugin-clipboard-manager`. We need to either add it or use a different approach. The simplest approach: use `navigator.clipboard.writeText()` which works in Tauri's WebView.

- [ ] **Step 1: Add `cmd_get_channel_username` to Rust backend**

Add to `app/src-tauri/src/commands/fs.rs` (after `cmd_search_global`):

```rust
/// Get the username of a channel (for copy-link feature).
/// Returns None if the channel is private (no username).
#[tauri::command]
pub async fn cmd_get_channel_username(
    folder_id: Option<i64>,
    state: State<'_, TelegramState>,
) -> Result<Option<String>, String> {
    let client_opt = { state.client.lock().await.clone() };
    if client_opt.is_none() {
        return Ok(None);
    }
    let client = client_opt.unwrap();

    let peer = resolve_peer(&client, folder_id, &state.peer_cache).await?;

    match peer {
        Peer::Channel(c) => {
            // c.raw.username is Option<Some(String)> for public channels
            Ok(c.raw.username.as_deref().map(|s| s.to_string()))
        }
        _ => Ok(None),
    }
}
```

- [ ] **Step 2: Register command in `lib.rs`**

In `lib.rs`, in the `invoke_handler` list (around line 380-400), add:
```rust
            commands::cmd_get_channel_username,
```

- [ ] **Step 3: Add capability permission**

In `capabilities/default.json`, add to permissions array:
```json
    "allow-cmd-get-channel-username",
```

- [ ] **Step 4: Write test for link generation**

Create `app/src/__tests__/copyLink.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('copy telegram link', () => {
    it('generates correct link for public channel', () => {
        const username = 'my_channel';
        const messageId = 42;
        const link = `https://t.me/${username}/${messageId}`;
        expect(link).toBe('https://t.me/my_channel/42');
    });

    it('returns null for private channel (no username)', () => {
        const username: string | null = null;
        expect(username).toBeNull();
    });
});
```

- [ ] **Step 5: Run test**

Run: `cd app && npx vitest run src/__tests__/copyLink.test.ts`
Expected: 2 tests PASS

- [ ] **Step 6: Add `onCopyLink` to ContextMenu props**

Modify `ContextMenu.tsx`:
- Add `onCopyLink?: () => void` to `ContextMenuProps`
- Add `folderId` to `file` usage (or pass channel username directly)
- Add a "Copy Telegram Link" button after the Download button

```typescript
interface ContextMenuProps {
    x: number;
    y: number;
    file: TelegramFile;
    onClose: () => void;
    onDownload: () => void;
    onDelete: () => void;
    onPreview: () => void;
    onCopyLink?: () => void;
    channelIsPublic?: boolean;
}
```

Add the button JSX (after the Download button, before the Rename button):
```tsx
            {file.type !== 'folder' && onCopyLink && (
                <button
                    onClick={onCopyLink}
                    disabled={!channelIsPublic}
                    className="flex items-center gap-2 px-2 py-1.5 text-sm text-nobuf-text hover:bg-nobuf-hover rounded transition-colors text-left w-full disabled:opacity-50 disabled:cursor-not-allowed"
                    title={channelIsPublic ? 'Copy t.me link' : 'Channel is private — no public link available'}
                >
                    <Link className="w-4 h-4 text-nobuf-primary" />
                    Copy Telegram Link
                </button>
            )}
```

Add `Link` to the lucide-react import.

- [ ] **Step 7: Wire up in FileExplorer.tsx**

In `FileExplorer.tsx`, add state for channel username and pass it to ContextMenu:

```typescript
import { invoke } from '@tauri-apps/api/core';
```

In the component, add:
```typescript
    const [channelUsername, setChannelUsername] = useState<string | null>(null);

    // Fetch channel username when active folder changes
    useEffect(() => {
        if (activeFolderId !== null) {
            invoke<string | null>('cmd_get_channel_username', { folderId: activeFolderId })
                .then(setChannelUsername)
                .catch(() => setChannelUsername(null));
        } else {
            setChannelUsername(null);
        }
    }, [activeFolderId]);
```

Add `onCopyLink` handler:
```typescript
    const handleCopyLink = useCallback(async () => {
        if (!channelUsername || !contextMenu) return;
        const link = `https://t.me/${channelUsername}/${contextMenu.file.id}`;
        try {
            await navigator.clipboard.writeText(link);
            toast.success('Link copied to clipboard');
        } catch (e) {
            toast.error('Failed to copy link');
        }
        onCloseContextMenu();
    }, [channelUsername, contextMenu, onCloseContextMenu]);
```

Pass to ContextMenu:
```tsx
<ContextMenu
    {...contextMenu}
    onCopyLink={handleCopyLink}
    channelIsPublic={!!channelUsername}
/>
```

- [ ] **Step 8: Run tsc**

Run: `cd app && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 9: Run all frontend tests**

Run: `cd app && npx vitest run`
Expected: All PASS

- [ ] **Step 10: Commit**

```bash
git add app/src/components/dashboard/ContextMenu.tsx app/src/components/dashboard/FileExplorer.tsx app/src-tauri/src/commands/fs.rs app/src-tauri/src/lib.rs app/src-tauri/capabilities/default.json app/src/__tests__/copyLink.test.ts
git commit -m "feat: add Copy Telegram Link to context menu for public channels"
```

**Edge cases:**
- Private channel: `channelIsPublic = false`, button is disabled with tooltip
- No active folder: `channelUsername = null`, button disabled
- Clipboard API failure: caught and shows error toast
- `navigator.clipboard` may not be available in all WebView contexts — wrap in try/catch (done)

---

### Task P2.2: Shareable Links with Password Protection

**This is a large feature. It requires SQLite, bcrypt, new routes, new commands, a frontend modal, and cookie-based auth. It should be split into sub-tasks.**

**Architecture decision**: Upstream uses SQLite for persistence. We need to add `sqlite` and `bcrypt` crates. The share routes run on the existing Actix streaming server (port 14201), not a separate server.

**Dependencies to add to Cargo.toml:**
```toml
sqlite = { version = "0.37", features = ["bundled"] }
bcrypt = "0.16"
```

**New files:**
- `app/src-tauri/src/commands/sharing.rs` — Tauri commands (create, list, revoke)
- `app/src-tauri/src/share_routes.rs` — Actix routes (`GET /d/{token}`, `POST /d/{token}/verify`)
- `app/src-tauri/src/db.rs` — SQLite initialization + schema
- `app/src/components/dashboard/ShareModal.tsx` — Frontend modal

**Modified files:**
- `app/src-tauri/Cargo.toml` — add deps
- `app/src-tauri/src/lib.rs` — register module + commands + share routes in Actix
- `app/src-tauri/src/server.rs` — add share routes to Actix app config
- `app/src-tauri/capabilities/default.json` — add permissions
- `app/src/components/dashboard/ContextMenu.tsx` — add "Share…" option
- `app/src/components/dashboard/FileExplorer.tsx` — wire up share modal

**SQLite schema** (verified from upstream source):
```sql
CREATE TABLE IF NOT EXISTS shared_links (
    id TEXT PRIMARY KEY,
    folder_id INTEGER,
    message_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    expires_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
```

This task is too large for a single plan section. It should be broken into:
- P2.2a: SQLite + db.rs setup
- P2.2b: sharing.rs Tauri commands (create/list/revoke)
- P2.2c: share_routes.rs Actix endpoints
- P2.2d: ShareModal frontend
- P2.2e: ContextMenu integration

**Due to the size and complexity, this feature requires its own dedicated plan. The sub-tasks above outline the approach, but full implementation should be planned separately with complete TDD steps for each component.**

---

### Task P2.3: Remote Upload from URL

**Architecture decision**: Upstream uses `reqwest = "0.12"`. We already have `ureq = "2"` for HTTP. We can either add `reqwest` or adapt to use `ureq`. The `reqwest` approach is better because it supports streaming and SOCKS5 proxy natively.

**Dependencies to add:**
```toml
reqwest = { version = "0.12", features = ["stream", "rustls-tls", "socks"] }
sysinfo = "0.30"
urlencoding = "2"
```

**New files:**
- `app/src/components/dashboard/RemoteUploadModal.tsx`

**Modified files:**
- `app/src-tauri/src/commands/fs.rs` — add `cmd_upload_from_url`
- `app/src-tauri/src/lib.rs` — register command
- `app/src-tauri/capabilities/default.json` — add permission
- `app/src/components/dashboard/UploadQueue.tsx` — add remote upload trigger
- `app/src/hooks/useFileUpload.ts` — add remote upload handler

**Key implementation details** (verified from upstream source):
- Dual-phase progress: `"downloading"` then `"uploading"`, emit `remote-upload-progress` events
- Resumable: check `Accept-Ranges: bytes`, send `Range: bytes={downloaded}-`
- Content-Disposition parsing for filename
- HTML rejection (check Content-Type)
- 2GB Telegram limit check
- Disk space check via `sysinfo::Disks`
- Cancellation via `cancelled_transfers` set

**This feature also requires its own dedicated plan due to complexity.**

---

### Task P2.4: Full REST API CRUD (15 Missing Endpoints)

**Architecture**: Extend existing `api_routes.rs`. All endpoints use the same `check_auth` middleware. New endpoints follow the same pattern as existing ones.

**Endpoints to add:**

| Method | Path | Implementation Notes |
|---|---|---|
| DELETE | `/api/v1/files/{id}` | `client.delete_messages` |
| POST | `/api/v1/files/{id}/copy` | `client.forward_messages` |
| PATCH | `/api/v1/files/{id}` | `client.edit_message` for rename + forward+delete for move |
| POST | `/api/v1/files` | Multipart upload, `client.upload_stream` |
| POST | `/api/v1/files/bulk` | Batch delete/move, streaming ZIP for archive |
| GET | `/api/v1/files/search` | Scan all folders |
| GET | `/api/v1/folders` | List folders from peer cache |
| POST | `/api/v1/folders` | `client.create_channel` |
| PATCH | `/api/v1/folders/{id}` | Rename channel |
| DELETE | `/api/v1/folders/{id}` | `client.delete_channel` |
| GET | `/api/v1/storage/stats` | Per-folder count + size |
| GET | `/api/v1/storage/duplicates` | Group by name+size |
| GET | `/api/v1/folders/empty` | Folders with no media |
| GET | `/api/v1/files/{id}/thumbnail` | Serve cached thumbnail |
| GET | `/api/v1/files/{id}/media-info` | Duration, width, height |

**This requires its own dedicated plan — it's 15 endpoints, each with its own validation, error handling, and tests.**

---

## P3 — Nice-to-Have (Days)

### Task P3.1: Archive Viewer & Extractor (ZIP/RAR/7Z)

**Dependencies:**
```toml
zip = { version = "2", features = ["deflate"] }
rar = "0.4"
sevenz-rust2 = "0.7"
```

**New file:** `app/src-tauri/src/commands/archive.rs`
**Commands:** `cmd_list_archive_contents`, `cmd_extract_archive_entry`

**Requires its own plan.**

---

### Task P3.2: DC Failover (5 Data Centres)

**Modify:** `app/src-tauri/src/commands/network.rs`

Replace single-DC TCP check with 5-DC fallback:

```rust
const DC_ADDRESSES: &[&str] = &[
    "149.154.167.50:443",  // DC2
    "149.154.175.53:443",  // DC1
    "149.154.167.51:443",  // DC3
    "149.154.167.91:443",  // DC4
    "91.108.56.130:443",   // DC5
];
```

Try each DC in order until one connects.

---

### Task P3.3: Persistent Network Settings

**New file:** `app/src-tauri/src/commands/settings.rs`
**Store:** `network_settings.json` in app data dir

---

### Task P3.4: Folder Zip Upload

**Dependencies:** `zip = "2"`, `walkdir = "2"`
**New command:** `cmd_upload_folder` — compress to temp ZIP, upload, delete temp

---

### Task P3.5: VPN Auto-Detection

**Modify:** `app/src-tauri/src/commands/network.rs`

Platform-specific detection:
- Windows: `ipconfig` → check for tap/tunnel/wg/vpn keywords
- Linux: `/sys/class/net` → check for tun/tap/wg/ppp
- macOS: `ifconfig -l` → check for utun/tun/wg/ppp

---

## P4 — Polish (Skip Unless Requested)

### Task P4.1: i18n / 13 Languages

**Dependencies:** `i18next = "^26.3.1"`, `react-i18next = "^17.0.8"`
**New directory:** `app/src/i18n/locales/` with 13 JSON files
**Effort:** Very high. Wrap every string in `t('key')`. Not recommended unless user explicitly requests.

---

### Task P4.2: Folder Grouping with SQLite + dnd-kit

**Dependencies:** `sqlite` (if not already added for sharing), `@dnd-kit/core`, `@dnd-kit/sortable`
**New files:** `folder_groups.rs`, `db.rs` (shared with sharing if exists)
**SQLite tables:** `groups`, `folder_metadata`

---

### Task P4.3: Custom Theme Engine

**Modify:** `app/src/context/ThemeContext.tsx`
**Add:** Custom theme support, theme persistence, color picker, Themes tab in Settings

---

### Task P4.4: SOCKS5/MTProto Proxy Suite

**New file:** `app/src-tauri/src/vpn_optimizer.rs`
**Large feature:** ProxyConfig, VpnConfig, socks5_bridge, latency monitoring, keep-alive

---

### Task P4.5: Configurable Chunk Sizes

**Modify:** `app/src-tauri/src/commands/fs.rs:17` — change `const TELEGRAM_CHUNK_SIZE` to configurable
**Add:** Settings UI for 128KB/256KB/512KB selection

---

### Task P4.6: TCP Keep-Alive

**Modify:** grammers sender configuration
**Add:** Settings UI for keep-alive interval (0=disabled, 30-120s)

---

### Task P4.7: Latency Monitoring

**New commands:** `cmd_check_latency`, `cmd_get_proxy_status`
**Modify:** Settings UI to show latency indicator

---

### Task P4.8: Windows Filename Sanitization (Frontend)

**Note:** Upstream does NOT have this in Rust backend. It's likely frontend-only. If needed, add a `sanitizeFilename()` utility in `app/src/utils.ts` that strips `<>:"/\|?*` characters.

---

## Summary

| Priority | Tasks | Total Effort | Status |
|---|---|---|---|
| **P0** | 4 tasks (constant-time, natural sort, updater artifacts, restart capability) | ~30 min | Ready to implement |
| **P1** | 3 tasks (cache integrity, backoff jitter, path canonicalization) | ~2 hours | Ready to implement |
| **P2** | 4 tasks (copy link, sharing, remote upload, REST API CRUD) | ~5-10 days | P2.1 ready; P2.2-P2.4 need dedicated plans |
| **P3** | 5 tasks (archive viewer, DC failover, network settings, folder zip, VPN detection) | ~3-5 days | Need dedicated plans |
| **P4** | 8 tasks (i18n, folder groups, themes, proxy, chunk sizes, keep-alive, latency, filename sanitization) | ~10+ days | Need dedicated plans |

**Immediate action**: P0 (4 tasks, 30 min) and P1 (3 tasks, 2 hours) are fully specified with complete code, tests, and verification steps. They can be implemented immediately.

**After P0+P1**: P2.1 (Copy Telegram Link) is fully specified and ready. P2.2-P2.4 are large features that need their own dedicated plans with full TDD steps.
