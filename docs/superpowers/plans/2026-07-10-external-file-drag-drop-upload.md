# External File Drag-and-Drop Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Load `karpathy-guideline` and `brainstorming` (telegram-drive) before coding.

**Goal:** Let the user drag files from Windows Explorer into NoBuf to upload them to the currently-open folder, replacing the current "use the Upload button" block.

**Architecture:** Keep Tauri's native drag-drop handler DISABLED (re-enabling it broke internal DOM drag-and-drop in this repo — verified via git commit `0e03121`). External drops arrive as DOM events; `e.dataTransfer.files` yields browser `File` objects. Stream each file's bytes chunked to a new Rust command `cmd_stage_dropped_file` (writes a temp file, returns its path), then queue that path through the EXISTING `cmd_upload_file` pipeline — reusing progress/cancel/bandwidth unchanged. This mirrors the shipped `cmd_zip_folder` pattern.

**Tech Stack:** Tauri 2.11.2, `@tauri-apps/api ~2.11.0`, React 19 + TypeScript, Rust (tokio, grammers), `sonner` toasts, `framer-motion`.

**Companion spec:** `docs/specs/2026-07-10-external-file-drag-drop-upload-design.md`

---

## Baselines (verified 2026-07-10, before any change)

| Check | Command | Result |
|---|---|---|
| TypeScript | `cd app && npx tsc --noEmit` | ✅ exit 0 |
| Rust | `cd app/src-tauri && cargo check --no-default-features` | ✅ exit 0 (28.99s) |

> **CRITICAL build note (from user memory):** `tauri dev` runs `cargo run --no-default-features`. Always build/validate with `--no-default-features`. New Tauri commands require registration in THREE places or permission codegen fails: (1) `build.rs` `.commands(&[...])`, (2) `capabilities/default.json` `allow-cmd-*`, (3) `lib.rs` `invoke_handler![...]`. After registering, run `cargo build --no-default-features` (NOT `check`) to regenerate permissions. On Windows the patch tool may not bump mtime — if a build finishes in ~0.3s without "Compiling", run `echo "" >> <file>.rs` to force recompilation.

---

## Verified API signatures (read from source — do NOT guess)

```rust
// commands/mod.rs:14
#[derive(Clone)]
pub struct TelegramState {
    pub client: Arc<Mutex<Option<Client>>>,   // Mutex = tokio::sync::Mutex (.lock().await)
    // ...
}

// commands/fs.rs:216
#[derive(Clone, serde::Serialize)]
struct ProgressPayload { id: String, percent: u8, uploaded_bytes: u64, total_bytes: u64, speed_bytes_per_sec: u64 }

// commands/fs.rs:294 — the pipeline we REUSE, path-based
pub async fn cmd_upload_file(
    path: String, folder_id: Option<i64>, transfer_id: Option<String>,
    app_handle: tauri::AppHandle, state: State<'_, TelegramState>, bw_state: State<'_, BandwidthManager>,
) -> Result<String, String>

// commands/utils.rs:53 — existing get_me() usage pattern
match client.get_me().await { Ok(me) => Ok(Peer::User(me)), Err(e) => Err(e.to_string()) }

// grammers premium flag (generated_types.rs:57654 `pub premium: bool`; enum tl::enums::User)
// me.raw is tl::enums::User { User(u) | Empty(_) }; premium only on the User variant.
```

```typescript
// app/src/types.ts:23 — QueueItem (dropped files enqueue as these; path-based)
export interface QueueItem { id: string; path: string; folderId: number | null; status: 'pending'|'uploading'|'success'|'error'|'cancelled'; error?: string; progress?: number; uploadedBytes?: number; totalBytes?: number; speedBytesPerSec?: number; url?: string; phase?: 'downloading'|'uploading'; }

// Internal-drag MIME types already in use:
//   'application/x-telegram-file-id'      (FileCard.tsx:96)
//   'application/x-nobuf-folder-reorder'  (SidebarItem.tsx:97, const FOLDER_REORDER_MIME)
// External OS file drop → dataTransfer.types includes 'Files' (ExternalDropBlocker.tsx:19)
```

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `app/src-tauri/src/commands/fs.rs` | Modify | Add `cmd_stage_dropped_file` (chunked temp write) + `cmd_upload_limit` (returns tier limit) |
| `app/src-tauri/src/commands/utils.rs` | Modify | Add `is_premium()` + `upload_limit_bytes()` helpers |
| `app/src-tauri/src/commands/archive.rs:337-342` | Modify | Replace hardcoded 2 GiB check with `upload_limit_bytes()` |
| `app/src-tauri/src/commands/mod.rs` | Modify | Re-export new commands if needed |
| `app/src-tauri/build.rs` | Modify | Register `cmd_stage_dropped_file`, `cmd_upload_limit` |
| `app/src-tauri/capabilities/default.json` | Modify | Add `allow-cmd-stage-dropped-file`, `allow-cmd-upload-limit` |
| `app/src-tauri/src/lib.rs` | Modify | Add both to `invoke_handler![...]` |
| `app/src/hooks/useDroppedFileUpload.ts` | Create | Validation + chunked staging + enqueue logic |
| `app/src/hooks/useFileUpload.ts` | Modify | Export a `stageAndQueue(files)` entry that reuses `uploadQueue` |
| `app/src/components/Dashboard.tsx` | Modify | Wire external-drop discrimination + overlay state; call staging |
| `app/src/components/dashboard/DragDropOverlay.tsx` | Modify | Add `variant: 'accept'\|'reject'` + folder name |
| `app/src/components/dashboard/ExternalDropBlocker.tsx` | Delete | Superseded by overlay reject-state + toasts |

---

## Task 1: Backend — `is_premium` + `upload_limit_bytes` helpers

**Files:**
- Modify: `app/src-tauri/src/commands/utils.rs` (append near existing `get_me()` usage ~line 53)

> **CROSS-VALIDATED:** `utils.rs` does NOT currently import `grammers_tl_types` (verified: utils.rs:1-10 only imports `grammers_client::{Client, types::Peer}`). The codebase convention is `use grammers_tl_types as tl;` (fs.rs:4, auth.rs:11). You MUST add that import to utils.rs, then reference `tl::enums::User`.

- [ ] **Step 1: Add the import at the top of `utils.rs`**

```rust
use grammers_tl_types as tl;   // convention used in fs.rs:4, auth.rs:11
```

- [ ] **Step 2: Add the helpers**

```rust
// --- Upload size limit (Premium-aware) ---
// grammers exposes no premium() accessor; read the raw TL flag.
// VERIFIED: `pub premium: bool` at generated_types.rs:57654 (grammers rev d07f96f).
// `me.raw` is `tl::enums::User` with variants `User(u)` | `Empty(_)`; premium only on `User`.
// Telegram enforces the true limit server-side; this is client-side pre-validation only.
pub async fn is_premium(client: &grammers_client::Client) -> Result<bool, String> {
    let me = client.get_me().await.map_err(|e| e.to_string())?;
    Ok(match &me.raw {
        tl::enums::User::User(u) => u.premium,
        tl::enums::User::Empty(_) => false,
    })
}

/// Per-file upload limit in bytes: 4 GB Premium, 2 GB free (documentation-based decimal GB).
pub async fn upload_limit_bytes(client: &grammers_client::Client) -> Result<u64, String> {
    Ok(if is_premium(client).await? { 4_000_000_000 } else { 2_000_000_000 })
}
```

- [ ] **Step 3: Force recompile + build**

```bash
cd app/src-tauri && echo "" >> src/commands/utils.rs && cargo build --no-default-features 2>&1 | tail -8
```
Expected: `Compiling app` then `Finished`, exit 0. If `premium` field error → re-read `generated_types.rs:57637-57666` (the field IS `pub premium: bool` at line 57654 — verified). If `tl` unresolved → confirm the `use grammers_tl_types as tl;` import from Step 1 was added.

- [ ] **Step 3: Commit** (only if user has authorized commits — otherwise leave in working tree)

```bash
git add app/src-tauri/src/commands/utils.rs
git commit -m "feat: add Premium-aware upload size limit helpers"
```

> **Do NOT commit without explicit user permission** (user memory rule). If not authorized, skip Step 3 for every task and leave changes in the working tree.

---

## Task 2: Backend — `cmd_upload_limit` command (frontend reads the tier limit once)

**Files:**
- Modify: `app/src-tauri/src/commands/fs.rs` (add command)
- Modify: `app/src-tauri/build.rs`, `capabilities/default.json`, `lib.rs` (register)

- [ ] **Step 1: Add the command in `fs.rs`**

```rust
/// Returns the current account's per-file upload limit in bytes (Premium-aware).
/// Frontend caches this to pre-validate drops/picks instantly without a round-trip per file.
#[tauri::command]
pub async fn cmd_upload_limit(state: State<'_, TelegramState>) -> Result<u64, String> {
    let client_opt = { state.client.lock().await.clone() };
    match client_opt {
        Some(client) => crate::commands::utils::upload_limit_bytes(&client).await,
        None => Ok(2_000_000_000), // not connected → conservative free-tier default
    }
}
```

> Verify the exact module path to `upload_limit_bytes` (`crate::commands::utils::` vs `super::utils::`) by reading how `fs.rs` already references sibling modules. Match the existing pattern.

- [ ] **Step 2: Register in all THREE codegen sites**

`build.rs` — add to `.commands(&[...])`:
```rust
                "cmd_upload_limit",
                "cmd_stage_dropped_file",
```
`capabilities/default.json` — add to `permissions`:
```json
    "allow-cmd-upload-limit",
    "allow-cmd-stage-dropped-file",
```
`lib.rs` `invoke_handler![...]` — add:
```rust
            commands::cmd_upload_limit,
            commands::cmd_stage_dropped_file,
```
> Registering both new commands now (Task 2 + Task 3) in one pass avoids a second permission-codegen rebuild.

- [ ] **Step 3: Verify** — deferred to end of Task 3 (both commands built together).

---

## Task 3: Backend — `cmd_stage_dropped_file` (chunked temp write)

**Files:**
- Modify: `app/src-tauri/src/commands/fs.rs`

Protocol: frontend calls this once per chunk. `chunk_index == 0` truncates/creates the temp file; subsequent chunks append. Returns the temp path only on the final chunk (`is_last == true`); otherwise returns empty string. Never accepts an output path from the frontend (security). Mirrors `cmd_zip_folder`'s `std::env::temp_dir().join("nobuf_zip")` staging pattern.

- [ ] **Step 1: Implement**

```rust
// NOTE: `std::io::Write` is ALREADY imported at fs.rs:12 (`use std::io::{Read, Seek, SeekFrom, Write};`).
// Do NOT add a duplicate import — `write_all` is in scope.

/// Stage bytes of a dropped browser File into a temp file, chunk by chunk.
/// upload_id: collision-safe id from the frontend (the QueueItem id).
/// file_name: original name (sanitized here); chunk_index 0 truncates, others append.
/// Returns the temp file's absolute path on the final chunk, else "".
#[tauri::command]
pub async fn cmd_stage_dropped_file(
    upload_id: String,
    file_name: String,
    chunk_index: u64,
    is_last: bool,
    bytes: Vec<u8>,
) -> Result<String, String> {
    // Sanitize: strip any path components — keep the bare filename only.
    let safe_name = std::path::Path::new(&file_name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "dropped".to_string());
    let safe_id: String = upload_id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if safe_id.is_empty() { return Err("Invalid upload id".to_string()); }

    let dir = std::env::temp_dir().join("nobuf_dropped");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-{}", safe_id, safe_name));

    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(chunk_index != 0)   // first chunk: overwrite; later: append
        .truncate(chunk_index == 0)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;

    if is_last {
        Ok(path.to_string_lossy().to_string())
    } else {
        Ok(String::new())
    }
}
```

- [ ] **Step 2: Force recompile + build (Windows mtime quirk)**

```bash
cd app/src-tauri && echo "" >> src/commands/fs.rs && cargo build --no-default-features 2>&1 | tail -8
```
Expected: `Compiling app` then `Finished`, exit 0. If it finishes in ~0.3s without "Compiling", the mtime bump didn't take — repeat the `echo`.

- [ ] **Step 3: Validate permission codegen**

Confirm no "command not allowed" / missing-permission errors in the build output. If codegen complains, re-check the three registration sites in Task 2 Step 2.

- [ ] **Step 4: Commit** (if authorized).

---

## Task 4: Backend — unify the folder-zip size check onto the shared helper

**Files:**
- Modify: `app/src-tauri/src/commands/archive.rs:337-342`

Current (Premium-blind, binary GiB):
```rust
    let zip_size = std::fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    if zip_size > 2 * 1024 * 1024 * 1024 {
        let _ = std::fs::remove_file(&zip_path);
        return Err(format!("Compressed folder exceeds Telegram's 2GB limit ({} bytes)", zip_size));
    }
```

- [ ] **Step 1: Replace with the Premium-aware limit**

`cmd_zip_folder` currently takes `state: tauri::State<'_, TelegramState>` (already present, line 284 — was unused). Use it:
```rust
    let zip_size = std::fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    let limit = {
        let client_opt = { state.client.lock().await.clone() };
        match client_opt {
            Some(client) => crate::commands::utils::upload_limit_bytes(&client).await.unwrap_or(2_000_000_000),
            None => 2_000_000_000,
        }
    };
    if zip_size > limit {
        let _ = std::fs::remove_file(&zip_path);
        return Err(format!("Compressed folder exceeds the {} GB upload limit ({} bytes)", limit / 1_000_000_000, zip_size));
    }
```
> Remove the now-obsolete `let _ = state;` line (archive.rs:286) since `state` is now used.

- [ ] **Step 2: Build & verify**

```bash
cd app/src-tauri && echo "" >> src/commands/archive.rs && cargo build --no-default-features 2>&1 | tail -8
```
Expected: `Finished`, exit 0. Warning about unused `state` should be GONE.

- [ ] **Step 3: Commit** (if authorized).

---

## Task 5: Frontend — dropped-file validation + chunked staging hook

**Files:**
- Create: `app/src/hooks/useDroppedFileUpload.ts`
- Modify: `app/src/hooks/useFileUpload.ts` (expose `stageAndQueue`)

Design: a `stageAndQueue(files, activeFolderId, limitBytes)` function that (1) rejects the whole batch if any entry is a folder, (2) filters 0-byte, (3) rejects oversized per `limitBytes`, (4) streams each survivor chunk-by-chunk to `cmd_stage_dropped_file`, (5) pushes the returned temp path into `uploadQueue` as a `QueueItem`. Toasts summarize skips.

- [ ] **Step 1: Add folder detection + staging in a new hook**

```typescript
// app/src/hooks/useDroppedFileUpload.ts
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { QueueItem } from '../types';

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB — never hold the whole file in RAM

/**
 * A dropped entry is a FOLDER when the browser reports type '' AND reading it as a
 * Blob slice throws / yields nothing. WebView2 delivers folders as zero-size File
 * objects with empty type. VERIFY the exact signal in the Phase 0 spike before relying
 * on any single heuristic; this uses the size===0 && type==='' + read-probe combo.
 */
async function looksLikeFolder(file: File): Promise<boolean> {
    if (file.type !== '' ) return false;      // has a MIME type → definitely a file
    if (file.size > 0) return false;           // has bytes → a file
    // size 0 + no type: could be a genuinely empty file OR a folder. Probe:
    try {
        await file.slice(0, 1).arrayBuffer();  // folders throw NotFoundError/SecurityError in WebView2
        return false;                          // read succeeded → empty file, not folder
    } catch {
        return true;                           // read failed → treat as folder
    }
}

async function stageOne(file: File, id: string): Promise<string> {
    const total = file.size;
    let offset = 0;
    let chunkIndex = 0;
    let tempPath = '';
    do {
        const end = Math.min(offset + CHUNK_SIZE, total);
        const buf = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        const isLast = end >= total;
        tempPath = await invoke<string>('cmd_stage_dropped_file', {
            uploadId: id,
            fileName: file.name,
            chunkIndex,
            isLast,
            bytes: Array.from(buf), // Tauri serializes Vec<u8> from a number array
        });
        offset = end;
        chunkIndex += 1;
    } while (offset < total);
    return tempPath;
}

export async function stageDroppedFiles(
    files: File[],
    activeFolderId: number | null,
    limitBytes: number,
): Promise<QueueItem[]> {
    // 1. All-or-nothing folder rejection
    for (const f of files) {
        if (await looksLikeFolder(f)) {
            toast.error("Folders aren't supported — drop files only.");
            return [];
        }
    }
    // 2/3. Filter empty + oversized
    const valid: File[] = [];
    let emptyCount = 0;
    const oversized: string[] = [];
    for (const f of files) {
        if (f.size === 0) { emptyCount += 1; continue; }
        if (f.size > limitBytes) { oversized.push(f.name); continue; }
        valid.push(f);
    }
    if (emptyCount > 0) toast.error(`Skipped ${emptyCount} empty file(s).`);
    if (oversized.length > 0) {
        const gb = Math.round(limitBytes / 1_000_000_000);
        toast.error(`${oversized.length} file(s) exceed the ${gb} GB limit.`);
    }
    if (valid.length === 0) return [];

    // 4/5. Stage each survivor → QueueItem
    const items: QueueItem[] = [];
    for (const f of valid) {
        const id = Math.random().toString(36).substr(2, 9);
        try {
            const tempPath = await stageOne(f, id);
            if (tempPath) items.push({ id, path: tempPath, folderId: activeFolderId, status: 'pending' });
        } catch (e) {
            toast.error(`Couldn't read ${f.name}: ${e}`);
        }
    }
    return items;
}
```

- [ ] **Step 2: Expose a queue entry point in `useFileUpload.ts`**

Add inside `useFileUpload`, before the `return`:
```typescript
    const stageAndQueue = async (files: File[], limitBytes: number) => {
        const { stageDroppedFiles } = await import('./useDroppedFileUpload');
        const items = await stageDroppedFiles(files, activeFolderId, limitBytes);
        if (items.length > 0) {
            setUploadQueue(prev => [...prev, ...items]);
            toast.info(`Queued ${items.length} file(s) for upload`);
        }
    };
```
Add `stageAndQueue` to the returned object (after `handleRemoteUpload`).

- [ ] **Step 3: Validate types**

Run: `cd app && npx tsc --noEmit`
Expected: exit 0, zero new errors.

- [ ] **Step 4: Commit** (if authorized).

---

## Task 6: Frontend — `DragDropOverlay` accept/reject variants

**Files:**
- Modify: `app/src/components/dashboard/DragDropOverlay.tsx`

- [ ] **Step 1: Add props (backward-compatible defaults)**

```typescript
import { motion } from 'framer-motion';
import { UploadCloud, Ban } from 'lucide-react';

interface DragDropOverlayProps {
    variant?: 'accept' | 'reject';
    folderName?: string;
}

export function DragDropOverlay({ variant = 'accept', folderName }: DragDropOverlayProps) {
    const reject = variant === 'reject';
    return (
        <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center pointer-events-none"
        >
            <motion.div
                initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
                className={`glass bg-nobuf-surface border ${reject ? 'border-red-500/50' : 'border-nobuf-primary/50'} text-nobuf-text rounded-2xl p-8 flex flex-col items-center gap-4 shadow-2xl`}
            >
                <div className={`p-4 rounded-full ${reject ? 'bg-red-500/10' : 'bg-nobuf-primary/10'}`}>
                    {reject
                        ? <Ban className="w-12 h-12 text-red-400" />
                        : <UploadCloud className="w-12 h-12 text-nobuf-primary animate-bounce" />}
                </div>
                <div className="text-center">
                    {reject ? (
                        <>
                            <h3 className="text-xl font-bold text-nobuf-text">Can't upload here</h3>
                            <p className="text-nobuf-subtext text-sm mt-1">Switch to Saved Messages or a folder to upload.</p>
                        </>
                    ) : (
                        <>
                            <h3 className="text-xl font-bold text-nobuf-text">Drop files to upload</h3>
                            <p className="text-nobuf-subtext text-sm mt-1">
                                {folderName ? <>Files will be uploaded to <span className="text-nobuf-primary font-medium">{folderName}</span></> : 'Files will be uploaded to the current folder'}
                            </p>
                        </>
                    )}
                </div>
            </motion.div>
        </motion.div>
    );
}
```

- [ ] **Step 2: Validate** — `cd app && npx tsc --noEmit` → exit 0. (Existing usage at Dashboard.tsx:587 passes no props → still compiles via defaults.)

- [ ] **Step 3: Commit** (if authorized).

---

## Task 7: Frontend — Dashboard drop wiring + discrimination + overlay state

**Files:**
- Modify: `app/src/components/Dashboard.tsx`

Root `<div>` at line 529 already has `onDragOver={handleRootDragOver}` / `onDragEnter={handleRootDragEnter}` for internal moves. We ADD external-drop handling WITHOUT disturbing those. Discriminate strictly by `dataTransfer.types`.

- [ ] **Step 1: Add constants + state near the top of the component**

```typescript
const FILE_ID_MIME = 'application/x-telegram-file-id';
const FOLDER_REORDER_MIME = 'application/x-nobuf-folder-reorder';

// True only when the drag is an EXTERNAL OS file drop (not an internal move/reorder).
const isExternalFileDrag = (e: React.DragEvent) => {
    const t = e.dataTransfer.types;
    return t.includes('Files') && !t.includes(FILE_ID_MIME) && !t.includes(FOLDER_REORDER_MIME);
};
```
Add state:
```typescript
const [externalDragActive, setExternalDragActive] = useState(false);
const [uploadLimitBytes, setUploadLimitBytes] = useState(2_000_000_000);
```

- [ ] **Step 2: Fetch the tier limit once on mount**

```typescript
useEffect(() => {
    invoke<number>('cmd_upload_limit').then(setUploadLimitBytes).catch(() => {});
}, []);
```

- [ ] **Step 3: Derive whether the current view accepts uploads**

```typescript
// Public channels are read-only; only saved/folder views accept uploads.
// CROSS-VALIDATED: `isReadOnly` already means exactly this — `const isReadOnly = isPublicView;`
// (Dashboard.tsx:123) and `const isPublicView = activeView.type === 'public';` (Dashboard.tsx:122).
// REUSE it — do NOT introduce a new variable:
const canUploadHere = !isReadOnly;
```

- [ ] **Step 4: Add external drag handlers on the root div**

Extend the existing root-div handlers (do NOT remove internal logic):
```typescript
const handleRootDragOver = (e: React.DragEvent) => {
    if (isExternalFileDrag(e)) {
        e.preventDefault();          // required so drop fires
        e.dataTransfer.dropEffect = canUploadHere ? 'copy' : 'none';
        if (!externalDragActive) setExternalDragActive(true);
        return;
    }
    if (internalDragRef.current) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; }
};

const handleRootDragEnter = (e: React.DragEvent) => {
    if (isExternalFileDrag(e)) { e.preventDefault(); if (!externalDragActive) setExternalDragActive(true); return; }
    if (internalDragRef.current) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; }
};

const handleRootDragLeave = (e: React.DragEvent) => {
    // Only clear when the pointer actually leaves the window bounds.
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
        setExternalDragActive(false);
    }
};

const handleRootDrop = async (e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;   // internal drops handled by their own targets
    e.preventDefault();
    e.stopPropagation();
    setExternalDragActive(false);
    if (!canUploadHere) {
        toast.error("Can't upload to a public channel — switch to Saved Messages or a folder.");
        return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    await stageAndQueue(files, uploadLimitBytes);
};
```
> `internalDragRef`, `stageAndQueue`, `toast` must be in scope. `stageAndQueue` comes from the `useFileUpload(...)` destructure (Dashboard.tsx:172 — add it there). `toast` is imported from `sonner` (already used). Verify all three before finalizing.

- [ ] **Step 5: Wire `onDragLeave` + `onDrop` on the root div**

Root `<div>` (line 529) currently has `onDragOver` / `onDragEnter`. Add:
```tsx
            onDragLeave={handleRootDragLeave}
            onDrop={handleRootDrop}
```

- [ ] **Step 6: Render the external overlay**

Replace the overlay line at Dashboard.tsx:587 region — keep the internal-move overlay, ADD the external one:
```tsx
{isDragging && internalDragFileId === null && <DragDropOverlay key="drag-drop-overlay" />}
{externalDragActive && (
    <DragDropOverlay
        key="external-drop-overlay"
        variant={canUploadHere ? 'accept' : 'reject'}
        folderName={canUploadHere ? currentFolderName : undefined}
    />
)}
```
> `currentFolderName` already exists (Dashboard.tsx:497). Confirm it's defined above this JSX.

- [ ] **Step 7: Add `stageAndQueue` to the `useFileUpload` destructure**

At Dashboard.tsx:172, add `stageAndQueue` to the destructured members from `useFileUpload(...)`.

- [ ] **Step 8: Validate**

Run: `cd app && npx tsc --noEmit`
Expected: exit 0, zero new errors.

- [ ] **Step 9: Commit** (if authorized).

---

## Task 8: Frontend — remove `ExternalDropBlocker`

**Files:**
- Modify: `app/src/components/Dashboard.tsx` (remove mount at line 536 + import)
- Delete: `app/src/components/dashboard/ExternalDropBlocker.tsx`

- [ ] **Step 1: Remove the mount** — delete `<ExternalDropBlocker onUploadClick={handleManualUpload} />` (Dashboard.tsx:536) and its import line.

- [ ] **Step 2: Delete the file**

```bash
rm app/src/components/dashboard/ExternalDropBlocker.tsx
```

- [ ] **Step 3: Confirm zero references (dead-code hygiene)**

Run: `cd app && grep -rn "ExternalDropBlocker" src/ ; npx tsc --noEmit`
Expected: grep returns NOTHING; tsc exit 0.

- [ ] **Step 4: Commit** (if authorized).

---

## Task 9: Frontend — apply the size limit to the file-picker path (consistency)

**Files:**
- Modify: `app/src/hooks/useFileUpload.ts` `handleManualUpload` (~line 121)

The picker currently queues without any size check. Gate it with the same cached limit.

> **CROSS-VALIDATED — original plan was WRONG:** `@tauri-apps/plugin-fs` is **NOT installed** (verified: `app/package.json` has only `@tauri-apps/plugin-dialog`, no `plugin-fs`). So `import { stat } from '@tauri-apps/plugin-fs'` would fail to compile. Use a tiny Rust `cmd_file_size` command instead (also avoids adding a new npm dependency — Karpathy: minimal deps).

- [ ] **Step 1: Add `cmd_file_size` in `fs.rs` and register it**

```rust
/// Returns a local file's size in bytes. Used for client-side pre-validation of picker uploads.
#[tauri::command]
pub async fn cmd_file_size(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(meta.len())
}
```
Register in all THREE codegen sites (same as Task 2 Step 2):
- `build.rs` `.commands(&[...])`: add `"cmd_file_size",`
- `capabilities/default.json` `permissions`: add `"allow-cmd-file-size",`
- `lib.rs` `invoke_handler![...]`: add `commands::cmd_file_size,`

Then force-rebuild: `cd app/src-tauri && echo "" >> src/commands/fs.rs && cargo build --no-default-features 2>&1 | tail -8` → `Finished`, exit 0.

- [ ] **Step 2: Add the cached limit + oversized filter in `useFileUpload.ts`**

Add to `useFileUpload` (top of hook body):
```typescript
    const [limitBytes, setLimitBytes] = useState(2_000_000_000);
    useEffect(() => { invoke<number>('cmd_upload_limit').then(setLimitBytes).catch(() => {}); }, []);
```
In `handleManualUpload`, after resolving `paths` (before mapping to `QueueItem`s), filter oversized via the new Rust command:
```typescript
const kept: string[] = [];
const oversized: string[] = [];
for (const p of paths) {
    try {
        const size = await invoke<number>('cmd_file_size', { path: p });
        if (size > limitBytes) { oversized.push(p.split(/[/\\]/).pop() || p); continue; }
    } catch { /* if stat fails, let the upload flow surface the error */ }
    kept.push(p);
}
if (oversized.length > 0) {
    const gb = Math.round(limitBytes / 1_000_000_000);
    toast.error(`${oversized.length} file(s) exceed the ${gb} GB limit.`);
}
if (kept.length === 0) return;
const newItems: QueueItem[] = kept.map((path: string) => ({
    id: Math.random().toString(36).substr(2, 9),
    path,
    folderId: activeFolderId,
    status: 'pending',
}));  // use `kept` instead of `paths`
```
> `invoke` is already imported in `useFileUpload.ts` (line 2). Reuse it — no new imports.

- [ ] **Step 3: Validate** — `cd app && npx tsc --noEmit` → exit 0.

- [ ] **Step 4: Commit** (if authorized).

---

## Task 10: Full validation gate (automated)

- [ ] **Step 1: TypeScript** — `cd app && npx tsc --noEmit` → exit 0, zero errors.
- [ ] **Step 2: Rust** — `cd app/src-tauri && cargo build --no-default-features 2>&1 | tail -8` → `Finished`, exit 0. (Force recompile with `echo "" >> src/lib.rs` if it short-circuits.)
- [ ] **Step 3: Unit tests** — `cd app && npm test` → all pass (baseline was green; ensure no regressions).
- [ ] **Step 4: Dead-code scan** — `grep -rn "ExternalDropBlocker" app/src/` → zero matches.
- [ ] **Step 5: Call-site audit** — confirm `stageAndQueue` appears in the `useFileUpload` return AND the Dashboard destructure; confirm `cmd_stage_dropped_file` / `cmd_upload_limit` appear in build.rs, capabilities/default.json, AND lib.rs (grep each).

```bash
cd app/src-tauri && for c in cmd_stage_dropped_file cmd_upload_limit cmd_file_size; do echo "== $c =="; grep -c "$c" build.rs; grep -c "${c//_/-}" capabilities/default.json; grep -c "$c" src/lib.rs; done
```
Expected: each count ≥ 1 in all three files.

---

## Task 11: Phase 0 SPIKE + runtime QA (USER hand-tests in `tauri dev`)

> **The agent cannot drive WebView2.** These are hand-tests the user performs. Report automated gates (Task 10) as green, then hand off this checklist. Do NOT declare the feature done on green types/build alone (user rule).

**Phase 0 spike (do FIRST — it validates the two runtime unknowns):**
- [ ] Drag a single file from Explorer → confirm `e.dataTransfer.files` yields a usable `File` (not empty) with the native handler still disabled. If files are empty/unusable → STOP; the DOM approach is invalid on this WebView2 build and the plan must revisit Path A/B.
- [ ] Drag a folder → confirm `looksLikeFolder()` correctly returns true (folder rejected). If the size-0/read-probe heuristic misfires, capture the actual `File.type`/`.size`/read behavior and adjust `looksLikeFolder` before continuing.

**Functional QA:**
- [ ] Single file drop → overlay shows "Drop files to upload to {folder}" → drop → uploads to current folder → temp file in `%TEMP%/nobuf_dropped` is removed after upload.
- [ ] Multiple files → all queued, processed one-by-one.
- [ ] Folder-only drop → whole drop rejected with toast.
- [ ] Files + folder mixed → whole drop rejected.
- [ ] Drop while viewing a public channel → red reject overlay during drag; drop is a no-op with toast.
- [ ] Oversized file (temporarily lower the limit constant to test) → rejected with correct 2/4 GB message.
- [ ] 0-byte file → rejected with toast.
- [ ] Unreadable path (e.g. eject a USB mid-drag if feasible) → that file rejected, others proceed.

**Regression QA (CRITICAL — must all still work):**
- [ ] Internal file → folder move (drag a file card onto a sidebar folder).
- [ ] Folder reorder in the sidebar.
- [ ] Player control-bar chip drag/reorder (FastStreamPlayer ⋯ tray).
- [ ] Dragging a file onto a folder does NOT flash the upload overlay.

**Temp-file cleanup verification:**
- [ ] After a successful upload, confirm the staged temp file is deleted. If `cmd_upload_file` does not delete it (it won't — it only reads), add cleanup: delete the temp file in `processItem`'s `finally` when the item's path is under `nobuf_dropped`, OR add startup orphan cleanup of `%TEMP%/nobuf_dropped` in `lib.rs` (mirrors the existing `nobuf_remux` startup cleanup at lib.rs:304). **Decide during implementation; the plan's default is: add startup cleanup in lib.rs AND best-effort delete after upload success/error in the queue processor.**

---

## Open item flagged for implementer (temp-file lifecycle)

`cmd_upload_file` reads the path but never deletes it (verified: fs.rs:294-372 has no `remove_file`). Dropped temp files therefore accumulate in `%TEMP%/nobuf_dropped`. Two-layer cleanup (both, belt-and-suspenders, matches existing `nobuf_remux`/`nobuf_zip` conventions):
1. **Runtime:** after a dropped item reaches `success`/`error`/`cancelled` in `useFileUpload.processItem`, if `item.path` contains `nobuf_dropped`, call a new `cmd_delete_temp(path)` (or reuse an existing fs delete restricted to the temp dir).
2. **Startup:** in `lib.rs` setup (near line 304), `remove_dir_all(std::env::temp_dir().join("nobuf_dropped"))` to sweep orphans from crashes.

> Note the folder-zip path (`cmd_zip_folder`) has the SAME orphan issue today (`nobuf_zip` is never swept). Adding the startup sweep for both is a clean, low-risk consistency win — include `nobuf_zip` in the startup cleanup too.

---

## Self-review notes (completed by planner)

- **Spec coverage:** every spec §3 rejection has a task (folders→T5, public→T7, oversized→T5/T9, 0-byte→T5, unreadable→T5). Overlay variants→T6. Discrimination→T7. Premium limit→T1/T2. Unify checks→T4/T9. Remove blocker→T8.
- **Signature reality checks:** `cmd_upload_file`, `TelegramState.client` (tokio Mutex), `ProgressPayload`, `QueueItem`, `get_me().raw` premium flag, MIME constants — ALL read from source and cited above.
- **Compiled-language check:** grammers `tl::enums::User { User(u) | Empty(_) }` variant names verified via subagent against `generated_types.rs:57637-57654`. `u.premium` is a real `pub bool` field.
- **Cross-boundary:** new commands registered in build.rs + capabilities + lib.rs (Task 2/3/9); frontend invoke keys (`uploadId`, `fileName`, `chunkIndex`, `isLast`, `bytes`, `path`) are camelCase → Tauri maps to snake_case Rust params automatically (matches existing `cmd_upload_file` `{ path, folderId, transferId }` convention).
- **Unverified-at-runtime (flagged, not assumed):** (a) `File` objects usable on external drop with native handler off; (b) exact folder-detection signal in WebView2. Both gated in Task 11 Phase 0 with explicit fallbacks.

## Cross-validation ledger (2nd pass — every "verify before finalizing" note resolved against source)

| Item | Original plan | Cross-validated result | Source | Plan fixed? |
|---|---|---|---|---|
| grammers `premium` field | generated_types.rs:57654 | ✅ `pub premium: bool` exact | generated_types.rs:57654 | — |
| `tl::enums::User` variants | `User(u)` / `Empty(_)` | ✅ correct | grammers rev d07f96f | — |
| `grammers_tl_types` import in utils.rs | assumed in scope | ❌ NOT imported; convention is `use grammers_tl_types as tl;` | utils.rs:1-10 vs fs.rs:4 | ✅ T1 Step 1 adds import |
| `isReadOnly` meaning | "verify it means public" | ✅ `isReadOnly = isPublicView` = `activeView.type==='public'` | Dashboard.tsx:122-123 | ✅ T7 reuses `!isReadOnly` |
| `toast`, `internalDragRef`, `currentFolderName` | assumed in scope | ✅ all present | Dashboard.tsx:5,110,497 | — |
| `@tauri-apps/plugin-fs` `stat()` (Task 9) | `import { stat }` | ❌ **plugin NOT installed** | package.json (only plugin-dialog) | ✅ T9 rewritten to Rust `cmd_file_size` |
| `npm test` runner | vitest | ✅ `"test": "vitest run"` | package.json:11 | — |
| `cmd_upload_file` reuse / State types | path-based pipeline | ✅ confirmed | fs.rs:294-372 | — |
| `cmd_zip_folder` has unused `state` | for T4 reuse | ✅ `let _ = state;` present, `state: State<TelegramState>` available | archive.rs:284-286 | — |
| Three codegen sites required | build.rs+caps+lib.rs | ✅ confirmed (zip-folder precedent) | build.rs, default.json:67, lib.rs | — |

**Two real defects caught and fixed by cross-validation:** (1) missing `grammers_tl_types` import in utils.rs would not compile; (2) Task 9 referenced an uninstalled npm plugin — replaced with a verified Rust command. No remaining unverified compile-time claims.
