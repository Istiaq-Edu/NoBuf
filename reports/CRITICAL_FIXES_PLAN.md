# NoBuf Critical Findings — Verified Implementation & Validation Plan

**Date:** 2026-06-27
**Status:** All 7 critical findings verified against source code. API patterns tested and confirmed.

---

## Verification Summary

| # | Finding | Verified | Source Line | API/Test Result |
|---|---------|----------|-------------|-----------------|
| C1 | SQLite injection via format!() | YES | folder_groups.rs:75,84,91,92,100,101,110 | 7 format!() calls confirmed. sqlite 0.37 bind() API tested and working. |
| C2 | SSRF in cmd_upload_from_url | YES | fs.rs:424 — ureq::get(&url) with no validation | No URL scheme check, no IP filter, no redirect limit, filename not sanitized (line 467). |
| C3 | Missing download semaphore in api_routes.rs | YES | api_routes.rs:371 — iter.next().await with no semaphore | All other download paths have semaphore (10 sites confirmed). throttle_api_calls at server.rs:299. |
| C4 | RAR extract_all path traversal | YES | archive.rs:132 — rar::Archive::extract_all() writes files with raw file.name | sanitise_entry_name only applied to display name (line 142), not to files on disk. rar 0.4 crate confirmed at Cargo.toml:56. |
| C5 | shell:allow-open unscoped | YES | capabilities/default.json:11 — no shell scope configured | No scope in tauri.conf.json. shell:allow-open grants OS-level open for any URI. |
| C6 | ffmpeg auto-download without checksum | YES | sprite.rs:59 — ffmpeg_sidecar::download::auto_download() | No checksum, no signature. Binary used directly at sprite.rs:73-76. |
| C7 | unpkg CDN load with no integrity hash | YES | MP4Player.ts:120 — script.src = 'https://unpkg.com/...' | No integrity attribute. Blocked by CSP script-src 'self' in prod but reachable in dev. |

---

## C1: SQLite Injection — Parameterize All Queries

### Files to modify
- `app/src-tauri/src/commands/folder_groups.rs` (lines 75, 84, 91, 92, 100, 101, 110)

### Verified API
```rust
// sqlite 0.37 — tested and confirmed working:
let mut stmt = conn.prepare("INSERT INTO test (name, age) VALUES (?, ?)")?;
stmt.bind((1, "Alice"))?;  // (parameter_index, value)
stmt.bind((2, 30i64))?;
stmt.iter().next();
```

### Implementation

**Line 75 (cmd_create_group — INSERT):**
```rust
// BEFORE:
conn.execute(format!("INSERT INTO groups (name, color_hex, display_order) VALUES ('{}', '{}', {})", name.replace("'", "''"), color_hex.replace("'", "''"), max_order + 1)).map_err(|e| e.to_string())?;

// AFTER:
let mut stmt = conn.prepare("INSERT INTO groups (name, color_hex, display_order) VALUES (?, ?, ?)").map_err(|e| e.to_string())?;
stmt.bind((1, name.as_str())).map_err(|e| e.to_string())?;
stmt.bind((2, color_hex.as_str())).map_err(|e| e.to_string())?;
stmt.bind((3, max_order + 1)).map_err(|e| e.to_string())?;
stmt.iter().next();
```

**Line 84 (cmd_update_group — UPDATE):**
```rust
// BEFORE:
conn.execute(format!("UPDATE groups SET name = '{}', color_hex = '{}' WHERE id = {}", name.replace("'", "''"), color_hex.replace("'", "''"), id)).map_err(|e| e.to_string())?;

// AFTER:
let mut stmt = conn.prepare("UPDATE groups SET name = ?, color_hex = ? WHERE id = ?").map_err(|e| e.to_string())?;
stmt.bind((1, name.as_str())).map_err(|e| e.to_string())?;
stmt.bind((2, color_hex.as_str())).map_err(|e| e.to_string())?;
stmt.bind((3, id)).map_err(|e| e.to_string())?;
stmt.iter().next();
```

**Lines 91-92 (cmd_delete_group — DELETE + UPDATE):**
```rust
// BEFORE:
conn.execute(format!("DELETE FROM groups WHERE id = {}", id)).map_err(|e| e.to_string())?;
conn.execute(format!("UPDATE folder_metadata SET group_id = NULL WHERE group_id = {}", id)).map_err(|e| e.to_string())?;

// AFTER:
let mut stmt = conn.prepare("DELETE FROM groups WHERE id = ?").map_err(|e| e.to_string())?;
stmt.bind((1, id)).map_err(|e| e.to_string())?;
stmt.iter().next();
let mut stmt = conn.prepare("UPDATE folder_metadata SET group_id = NULL WHERE group_id = ?").map_err(|e| e.to_string())?;
stmt.bind((1, id)).map_err(|e| e.to_string())?;
stmt.iter().next();
```

**Lines 100-101 (cmd_assign_folder_to_group — INSERT):**
```rust
// BEFORE (Some(gid)):
conn.execute(format!("INSERT INTO folder_metadata (channel_id, name, display_order, group_id) VALUES ({}, '', 0, {}) ON CONFLICT(channel_id) DO UPDATE SET group_id = {}", channel_id, gid, gid))
// BEFORE (None):
conn.execute(format!("INSERT INTO folder_metadata (channel_id, name, display_order, group_id) VALUES ({}, '', 0, NULL) ON CONFLICT(channel_id) DO UPDATE SET group_id = NULL", channel_id))

// AFTER (Some(gid)):
let mut stmt = conn.prepare("INSERT INTO folder_metadata (channel_id, name, display_order, group_id) VALUES (?, '', 0, ?) ON CONFLICT(channel_id) DO UPDATE SET group_id = ?").map_err(|e| e.to_string())?;
stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
stmt.bind((2, gid)).map_err(|e| e.to_string())?;
stmt.bind((3, gid)).map_err(|e| e.to_string())?;
stmt.iter().next();
// AFTER (None):
let mut stmt = conn.prepare("INSERT INTO folder_metadata (channel_id, name, display_order, group_id) VALUES (?, '', 0, NULL) ON CONFLICT(channel_id) DO UPDATE SET group_id = NULL").map_err(|e| e.to_string())?;
stmt.bind((1, channel_id)).map_err(|e| e.to_string())?;
stmt.iter().next();
```

**Line 110 (cmd_update_group_order — UPDATE):**
```rust
// BEFORE:
conn.execute(format!("UPDATE groups SET display_order = {} WHERE id = {}", order, id)).map_err(|e| e.to_string())?;

// AFTER:
let mut stmt = conn.prepare("UPDATE groups SET display_order = ? WHERE id = ?").map_err(|e| e.to_string())?;
stmt.bind((1, order)).map_err(|e| e.to_string())?;
stmt.bind((2, id)).map_err(|e| e.to_string())?;
stmt.iter().next();
```

### Validation
1. `cargo check` — must compile with 0 errors
2. `cargo test` — 78/78 must still pass (existing tests in api_settings.rs, ts_demux.rs, etc.)
3. Manual: Create group with name `O'Brien` — verify stored correctly
4. Manual: Create group with name `test'; DROP TABLE groups;--` — verify stored literally, table intact
5. Manual: Rename group with single quotes — verify update succeeds
6. Manual: Delete group, verify folder_metadata group_id set to NULL
7. Manual: Assign folder to group, verify group_id set correctly

### Rollback
Revert folder_groups.rs to previous version — single file, git revert.

---

## C2: SSRF — Add URL Validation + Filename Sanitization

### Files to modify
- `app/src-tauri/src/commands/fs.rs` (lines 424, 436-467)

### Implementation

**Add validation functions before cmd_upload_from_url (insert after line 408):**
```rust
use std::net::IpAddr;

fn validate_url(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    match parsed.scheme() {
        "http" | "https" => {},
        _ => return Err("Only HTTP(S) URLs are allowed".to_string()),
    }
    let host = parsed.host_str().ok_or("URL has no host")?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        if ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() {
            return Err("URLs pointing to internal addresses are not allowed".to_string());
        }
    }
    let blocked = ["localhost", "169.254.169.254", "metadata.google.internal"];
    if blocked.contains(&host) {
        return Err("URLs pointing to internal addresses are not allowed".to_string());
    }
    Ok(parsed.to_string())
}

fn sanitise_filename(raw: &str) -> String {
    let cleaned = std::path::Path::new(raw)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let cleaned: String = cleaned.chars()
        .filter(|c| !c.is_control() && *c != '\0' && *c != ':' && *c != '<' && *c != '>' && *c != '"' && *c != '|' && *c != '?' && *c != '*')
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".. { "file".to_string() } else { cleaned }
}
```

**Add `url` crate to Cargo.toml:**
```toml
url = "2"
```

**Modify cmd_upload_from_url (line 424):**
```rust
// BEFORE:
let resp = ureq::get(&url)
    .timeout(std::time::Duration::from_secs(30))
    .call()
    .map_err(|e| format!("HTTP request failed: {}", e))?;

// AFTER:
let url = validate_url(&url)?;
let resp = ureq::get(&url)
    .timeout(std::time::Duration::from_secs(30))
    .call()
    .map_err(|e| format!("HTTP request failed: {}", e))?;
```

**Modify filename extraction (after line 452, before line 467):**
```rust
// Add after filename extraction:
let filename = sanitise_filename(&filename);
```

### Validation
1. `cargo check` — must compile (url crate added)
2. `cargo test` — 78/78 must pass
3. Manual: Upload from valid external URL (https://example.com/test.txt) — should succeed
4. Manual: Upload from http://127.0.0.1:8550/ — should be rejected with "internal addresses" error
5. Manual: Upload from http://169.254.169.254/ — should be rejected
6. Manual: Upload from file:///etc/passwd — should be rejected with "Only HTTP(S)" error
7. Manual: Upload from URL with Content-Disposition containing ../../ — verify file created inside temp dir only

### Rollback
Remove validate_url/sanitise_filename functions and the url crate dependency.

---

## C3: Missing Download Semaphore in api_routes.rs

### Files to modify
- `app/src-tauri/src/api_routes.rs` (lines 363-371)

### Implementation

**The download loop at line 371 needs semaphore + rate limiter. The API endpoints receive `tg_state: web::Data<Arc<TelegramState>>` which has `download_semaphore` and `rate_limiter`.**

```rust
// BEFORE (line 367-371):
let stream = async_stream::stream! {
    let mut bytes_sent: u64 = 0;
    let mut first_chunk = true;
    let mut iter = download_iter;
    while let Some(chunk) = iter.next().await.transpose() {

// AFTER:
let stream = async_stream::stream! {
    let mut bytes_sent: u64 = 0;
    let mut first_chunk = true;
    let mut iter = download_iter;
    loop {
        let chunk_result = {
            let _permit = tg_state.download_semaphore.acquire().await.unwrap();
            crate::server::throttle_api_calls(&tg_state.rate_limiter).await;
            iter.next().await
        };
        let chunk = match chunk_result.transpose() {
            Some(Ok(bytes)) => bytes,
            Some(Err(e)) => { yield Err(actix_web::Error::from(e)); break; }
            None => break,
        };
        tokio::task::yield_now().await;
```

**Also add the import at the top of api_routes.rs:**
```rust
use crate::server::throttle_api_calls;
```

### Validation
1. `cargo check` — must compile
2. `cargo test` — 78/78 must pass
3. Manual: Download a file via REST API while streaming a video — no FLOOD_WAIT
4. Manual: Download via API — verify file downloads correctly

### Rollback
Revert the download loop to the original `while let Some(chunk) = iter.next().await.transpose()` pattern.

---

## C4: RAR Path Traversal — Replace rar Crate

### Files to modify
- `app/src-tauri/Cargo.toml` (line 56: replace `rar = "0.4"` with `unrar = "0.5"`)
- `app/src-tauri/src/commands/archive.rs` (lines 106-153: replace RAR listing code)

### Implementation

**This is the most complex fix. The `unrar` crate provides list-only mode without extraction.**

**Cargo.toml change:**
```toml
# BEFORE:
rar = "0.4"

# AFTER:
unrar = "0.5"
```

**archive.rs RAR branch (replace lines 106-153):**
```rust
ArchiveType::Rar => {
    let temp_dir = std::env::temp_dir().join("nobuf_archive_rar");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let temp_path = temp_dir.join(format!("archive_{}.rar", message_id));

    // Download to temp file (same semaphore pattern as existing)
    let mut file = std::fs::File::create(&temp_path).map_err(|e| e.to_string())?;
    let mut iter = client.iter_download(&media).chunk_size(512 * 1024);
    loop {
        let chunk_result = {
            let _permit = state.download_semaphore.acquire().await.unwrap();
            iter.next().await
        };
        let chunk = match chunk_result {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => return Err(format!("Download error: {}", e)),
        };
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        tokio::task::yield_now().await;
    }
    drop(file);

    // List only — NO extraction. Use unrar crate's list mode.
    let mut entries = Vec::new();
    let archive = unrar::Archive::from_path(&temp_path).map_err(|e| format!("RAR open error: {}", e))?;
    for entry in archive.list().map_err(|e| format!("RAR list error: {}", e))? {
        let entry = entry.map_err(|e| format!("RAR entry error: {}", e))?;
        entries.push(ArchiveEntry {
            filename: sanitise_entry_name(entry.filename.as_str()),
            size: entry.unpacked_size as u64,
            is_dir: entry.is_directory(),
        });
    }

    // Cleanup
    let _ = std::fs::remove_file(&temp_path);
    Ok(entries)
}
```

**Note:** The exact `unrar` crate API needs verification (it uses C FFI to unrar library). The `unrar` crate may require the `libunrar` system library. If unavailable, an alternative is to use `7z` to list RAR files, or use `std::process::Command::new("unrar")` as a fallback.

**CONFIDENCE: BELOW THRESHOLD** — The exact `unrar` crate API (v0.5) for list-only mode has not been verified by compilation. The `rar` 0.4 crate API was verified (extract_all is the only method). The `unrar` crate API needs testing before implementation.

**Alternative approach (if unrar crate is problematic):**
Keep `rar = "0.4"` but add path validation AFTER extract_all:
```rust
// After extract_all, check that no files were written outside extract_dir
for f in &archive.files {
    let extracted_path = extract_dir.join(&f.name);
    let canonical = extracted_path.canonicalize().map_err(|e| e.to_string())?;
    let extract_canonical = extract_dir.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&extract_canonical) {
        let _ = std::fs::remove_dir_all(&extract_dir);
        return Err("Archive contains path traversal entries".to_string());
    }
}
```

### Validation
1. `cargo check` — must compile (may need unrar system library)
2. `cargo test` — 78/78 must pass
3. Manual: View a normal RAR archive — should list contents
4. Manual: View a RAR with path traversal entries (../../etc/passwd) — should either reject or list sanitized names without writing outside extract dir
5. Manual: Verify no files are written to disk during listing (check temp dir after)

### Rollback
Revert Cargo.toml and archive.rs to rar 0.4.

---

## C5: shell:allow-open — Add Shell Scope

### Files to modify
- `app/src-tauri/capabilities/default.json` (line 11)
- `app/src-tauri/tauri.conf.json` (add shell scope)

### Implementation

**Option A (preferred): Remove shell:allow-open and handle URL opening via custom command**

Remove from capabilities/default.json:
```json
// Remove line 11:
"shell:allow-open",
```

Add a custom Tauri command that validates the URL scheme before opening:
```rust
// In commands/utils.rs
#[tauri::command]
pub async fn cmd_open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only HTTP(S) URLs can be opened".to_string());
    }
    tauri_plugin_opener::open(&url, None).map_err(|e| e.to_string())
}
```

**Option B (simpler): Add shell scope to tauri.conf.json**

```json
// In tauri.conf.json, add to plugins:
"shell": {
    "scope": [
        {
            "name": "open-url",
            "cmd": "",
            "url": true
        }
    ]
}
```

**Note:** The exact shell scope format for Tauri v2 needs verification. Tauri v2's shell plugin may use a different scope format than v1.

**CONFIDENCE: BELOW THRESHOLD** — The exact Tauri v2 shell scope format has not been verified. The safest approach is Option A (remove permission, add custom command).

### Validation
1. `cargo check` — must compile
2. Manual: Click "Get API credentials" link in AuthWizard — should open https://my.telegram.org in browser
3. Manual: From DevTools, attempt `shell.open('file:///C:/Windows/System32/cmd.exe')` — should be rejected
4. Manual: From DevTools, attempt `shell.open('smb://evil.com/share')` — should be rejected

### Rollback
Restore shell:allow-open in capabilities/default.json.

---

## C6: ffmpeg Auto-Download — Remove or Add Checksum

### Files to modify
- `app/src-tauri/src/commands/sprite.rs` (lines 57-61)

### Implementation

**Option A (simplest — remove auto-download, require user to install ffmpeg):**
```rust
// BEFORE (lines 57-61):
log::info!("Attempting ffmpeg auto_download...");
if let Err(e) = ffmpeg_sidecar::download::auto_download() {
    log::warn!("ffmpeg auto_download failed: {}", e);
}

// AFTER:
// Auto-download removed for security — user must install ffmpeg manually
log::warn!("ffmpeg not found. Please install ffmpeg and add it to PATH, or place ffmpeg.exe next to the app executable.");
return Err("ffmpeg not found. Install ffmpeg and add it to PATH.".to_string());
```

**Option B (keep auto-download but add SHA-256 verification):**
```rust
// After auto_download, verify checksum
if let Ok(sidecar_path) = ffmpeg_sidecar::paths::sidecar_path() {
    if sidecar_path.exists() {
        let hash = sha256_file(&sidecar_path)?;
        let expected = include_str!("../../ffmpeg_hashes/ffmpeg_sha256.txt");
        if !expected.lines().any(|line| line.trim() == hash) {
            let _ = std::fs::remove_file(&sidecar_path);
            return Err("ffmpeg binary failed integrity check".to_string());
        }
        return Ok(sidecar_path);
    }
}
```

**Recommended:** Option A (remove auto-download). It's the safest and simplest. Users who need sprite sheets can install ffmpeg — it's a common tool.

### Validation
1. `cargo check` — must compile
2. `cargo test` — 78/78 must pass
3. Manual: With ffmpeg installed on PATH — sprite generation should work
4. Manual: Without ffmpeg — should get clear error message, NOT auto-download
5. Manual: Verify no network request is made when ffmpeg is missing

### Rollback
Restore the auto_download call.

---

## C7: unpkg CDN Load — Remove CDN Fallback

### Files to modify
- `app/src/lib/faststream/players/MP4Player.ts` (lines 116-125)

### Implementation

```typescript
// BEFORE (lines 112-125):
try {
    const mod = await import(/* webpackIgnore: true */ 'mp4box');
    return mod.default || mod;
} catch {
    // If import fails, try loading from CDN
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/mp4box@0.5.2/dist/mp4box.all.js';
        script.onload = () => resolve((window as any).MP4Box);
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// AFTER:
try {
    const mod = await import(/* webpackIgnore: true */ 'mp4box');
    return mod.default || mod;
} catch (e) {
    throw new Error('mp4box module not available — ensure it is installed and bundled by Vite');
}
```

### Validation
1. `npx tsc --noEmit` — must compile with 0 errors
2. `npm test` — 96/96 must pass
3. `npm run build` — must build successfully
4. Manual: Play an MP4 video — should work (mp4box is bundled by Vite)
5. Manual: Open DevTools Network tab — verify NO request to unpkg.com
6. Grep: `grep -rn "unpkg\|cdn\|jsdelivr" src/` — should return 0 hits

### Rollback
Restore the CDN fallback code.

---

## Implementation Order (by safety and dependency)

1. **C7** (unpkg CDN) — Safest, 5 minutes, no Rust changes. Do first.
2. **C3** (API semaphore) — Safe, 30 minutes, same pattern as existing code.
3. **C1** (SQLite parameterization) — Safe, 2 hours, API verified.
4. **C2** (SSRF validation) — Cautious, 3 hours, adds url crate dependency.
5. **C6** (ffmpeg auto-download) — Safe, 15 minutes, just remove 4 lines.
6. **C5** (shell:allow-open) — Cautious, 1 hour, needs API verification.
7. **C4** (RAR path traversal) — Complex, 4+ hours, needs crate replacement or validation approach.

## Post-Implementation Validation

After ALL 7 fixes are applied:

1. `npx tsc --noEmit` — 0 errors
2. `npm test` — 96/96 pass
3. `cargo check` — 0 errors
4. `cargo test` — 78/78 pass
5. `npm run build` — succeeds
6. Manual: App launches, connects to Telegram
7. Manual: Upload and download a file
8. Manual: Stream a video (MP4 and TS)
9. Manual: View a ZIP archive (browse + extract)
10. Manual: View a RAR archive (browse only — no extraction)
11. Manual: API server starts, auth works, file downloads
12. Manual: Folder group create/rename/delete with special characters
13. Manual: Remote upload from valid URL
14. Manual: Remote upload from 127.0.0.1 — rejected
15. Manual: External links open in browser (my.telegram.org)
16. Manual: No network request to unpkg.com during MP4 playback
17. Manual: No ffmpeg auto-download when ffmpeg missing
