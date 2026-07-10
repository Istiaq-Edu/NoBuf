# External File Drag-and-Drop Upload — Design Spec

**Date:** 2026-07-10
**Feature:** Drag files from Windows Explorer into NoBuf to upload them to Telegram
**Status:** Design locked (95% confidence, source-grounded)

---

## 1. Goal

Let the user drag one or more files from Windows Explorer (or any OS file source)
into the NoBuf window to upload them to the currently-open folder — replacing the
current behavior where external drops are intercepted and rejected with a
"Use the Upload button" message (`ExternalDropBlocker`).

**In scope:** external *file* upload via drag-drop.
**Out of scope:** dragging files OUT of the app (export/download), folder upload
via drop, recreating folder structure, drag-into-player.

---

## 2. Key Constraint & Chosen Approach (the crux)

### 2.1 Why we do NOT re-enable Tauri's native drag-drop handler

The obvious approach — remove `.disable_drag_drop_handler()` (`app/src-tauri/src/lib.rs:388`)
so OS drops deliver real filesystem paths — was **rejected** based on
project-specific evidence:

- Git commit `0e03121` ("v0.5.0") changelog states verbatim:
  *"Disabled Tauri native drag-drop for reliable DOM events"* and
  *"Fixed cursor behavior during internal drags."*
- Code comments in `app/src/hooks/useFileDrop.ts` and
  `app/src/contexts/DropZoneContext.tsx` confirm:
  *"With dragDropEnabled: false, we have full control over DOM drag events."*
- `ExternalDropBlocker` exists specifically as the workaround for having
  disabled the native handler.

**Conclusion:** enabling the native handler demonstrably degraded the existing
internal DOM drag-and-drop (file→folder moves, folder reorder, player chip
reorder) in this exact codebase. Re-enabling it re-opens that regression. The
only way to verify current (Tauri 2.11.2) behavior is a runtime WebView2
hand-test, which historically failed. We do not gamble on it.

### 2.2 Chosen approach: Path B — DOM `File` objects + temp-file staging

- Keep `.disable_drag_drop_handler()` **ON** (native handler stays off). Zero
  change to existing internal drag-and-drop.
- External drops arrive as standard DOM `drop` events; `e.dataTransfer.files`
  yields browser `File` objects (in-memory blobs, **no** real path — expected
  with the native handler disabled).
- Stream each `File`'s bytes in chunks to a **new** Rust command
  `cmd_stage_dropped_file`, which writes a temp file and returns its path.
- Queue that temp path through the **existing** `cmd_upload_file` pipeline —
  reusing progress events, cancellation, and bandwidth tracking unchanged.
- Delete the temp file after upload completes (success or failure).

This mirrors an **existing, shipped pattern**: `cmd_zip_folder`
(`app/src-tauri/src/commands/archive.rs:282`) already writes a temp file to
`std::env::temp_dir()`, returns the path, and queues it through
`cmd_upload_file` (see `useFileUpload.ts` `handleFolderUpload`).

---

## 3. Behavior Specification

### 3.1 Happy path

1. User drags file(s) from Explorer over the NoBuf window.
2. On `dragenter`/`dragover`, if the drag is an **external file drop** (see §3.4
   discrimination), show the full-screen `DragDropOverlay` in its **accept**
   state: *"Drop files to upload to {current folder name}"*.
3. On `drop`:
   - Read `e.dataTransfer.files` → array of `File` objects.
   - Validate the drop (§3.3). If the whole drop is rejected, show a toast and stop.
   - For each valid `File`: stream bytes chunked to `cmd_stage_dropped_file`
     → receive temp path → push a `QueueItem { path: tempPath, folderId:
     activeFolderId, status: 'pending' }` into `uploadQueue`.
   - Existing queue processor uploads them one-by-one via `cmd_upload_file`.
4. Toast: *"Queued N file(s) for upload"* (mirrors picker path wording).
5. After each upload finishes, its temp file is deleted.

Destination is always `activeFolderId` (the folder currently being viewed).
Drop position within the window does **not** affect targeting.

### 3.2 Multiple files

All dropped files are queued into the existing `uploadQueue` and processed
sequentially, one at a time — identical to multi-select in the file picker.
No per-drop count limit.

### 3.3 Validation & rejections (all explicit — no silent magic)

Rejections surfaced as `sonner` toasts unless noted. Rejection reasons known
only *after* drop use toasts (the overlay is already gone by then).

| Case | Behavior |
|---|---|
| **Any folder in the drop** | Reject the **entire** drop (all-or-nothing). Toast: *"Folders aren't supported — drop files only."* User re-drags just the files. |
| **Viewing a public channel** | Reject. Overlay shows **reject** (red) state during drag: *"Can't upload to a public channel — switch to Saved Messages or a folder."* Drop is a no-op. |
| **Oversized file** (> Premium-aware limit, §4.2) | Reject those files before queueing. Toast: *"{name} exceeds the {2/4} GB limit."* |
| **0-byte file** | Reject (Telegram can't upload empty files). Toast: *"{name} is empty and can't be uploaded."* |
| **Unreadable path** (metadata fails: disconnected USB/network, permission denied) | Reject that file. Toast: *"Couldn't read {name}."* |
| **Symlink to a valid file** | Allowed — resolved naturally (`std::fs::metadata` follows symlinks). |
| **Windows `.lnk` shortcut** | Uploaded as-is (it's just a small file). Not resolved to its target. |
| **Hidden/system files** (`.DS_Store`, `Thumbs.db`, `desktop.ini`) | Allowed — only present if the user explicitly dragged them. No filtering. |

**Folder detection note:** with the native handler off, a dropped *directory*
surfaces as a `File`-like entry. The exact WebView2 signal (typically
`file.type === ''` combined with an unreadable/zero body, or a
`DataTransferItem` with `webkitGetAsEntry().isDirectory === true`) must be
**confirmed during the spike (§6, Phase 0)** and the reliable signal used. Do
not assume a single heuristic without verifying it in WebView2.

### 3.4 External-drop vs internal-drag discrimination

Both external drops and internal drags now arrive as DOM events on the same
document. Discriminate by `dataTransfer.types` — the method the codebase already
uses:

- **External file drop** → `types` includes `'Files'`.
- **Internal file→folder move** → `types` includes `'application/x-telegram-file-id'`
  (`FileCard.tsx:96`).
- **Internal folder reorder** → `types` includes `'application/x-nobuf-folder-reorder'`
  (`SidebarItem.tsx:97`).

**Rule:** treat a drag as an external upload **iff** `types` includes `'Files'`
**AND** does NOT include either custom MIME type. This guarantees:
- The upload overlay never appears while dragging a file onto a folder.
- An internal reorder is never misread as an upload.

`ExternalDropBlocker.tsx:19` already keys on `types.includes('Files')`, so this
is consistent with existing code.

### 3.5 Visual feedback surfaces

- **Overlay** (`DragDropOverlay`) — live pre-drop feedback during drag:
  - **Accept state** (current folder can receive uploads): existing design —
    dimmed backdrop, bouncing `UploadCloud` icon, `nobuf-primary` glow border,
    "Drop files to upload to **{folder}**".
  - **Reject state** (public channel view): same shell, red/error accent, a
    "no-entry"/blocked icon, "Can't upload here" + reason. One visual language,
    two states.
- **Toasts** (`sonner`) — post-drop results and rejections known only after drop.
- **`ExternalDropBlocker` is removed** (its rejection role is absorbed by the
  overlay reject-state + toasts).

---

## 4. Backend (Rust) Changes

### 4.1 New command: `cmd_stage_dropped_file`

Location: `app/src-tauri/src/commands/fs.rs` (alongside `cmd_upload_file`).

Responsibility: receive dropped-file bytes from the frontend in chunks, append
them to a temp file, return the temp file's absolute path. Chunked so we never
hold a whole (up to 4 GB) file in memory.

Design:
- Temp dir: `std::env::temp_dir().join("nobuf_dropped")` (mirrors
  `nobuf_zip` in `cmd_zip_folder`). `create_dir_all` on first use.
- Filename: sanitized original name; collision-safe (e.g. prefix with a short
  random id like the queue item id) to avoid clobbering concurrent drops of
  same-named files.
- Two viable chunk protocols (decide in implementation plan; both avoid OOM):
  - (a) Frontend calls `cmd_stage_dropped_file` once per chunk with
    `{ uploadId, chunkIndex, isLast, bytes }`; Rust opens/appends/closes.
  - (b) Frontend passes the whole `Uint8Array` for small files, chunks only
    above a threshold. Simpler but riskier for huge files — prefer (a).
- Returns: `Result<String, String>` = temp path or error.
- Security: write only inside `nobuf_dropped`; never accept an arbitrary output
  path from the frontend.

### 4.2 Premium-aware size limit helpers

Location: a shared util (e.g. `app/src-tauri/src/commands/utils.rs`, where
`get_me()` is already used at line 53).

Verified grammers pattern (source: `generated_types.rs:57654`
`pub premium: bool`; `grammers-client .../peer/user.rs`; `chats.rs:405`
`get_me`):

```rust
use grammers_tl_types as tl;

pub async fn is_premium(client: &grammers_client::Client) -> Result<bool, String> {
    let me = client.get_me().await.map_err(|e| e.to_string())?;
    Ok(match &me.raw {
        tl::enums::User::User(u) => u.premium,
        tl::enums::User::Empty(_) => false,
    })
}

pub async fn upload_limit_bytes(client: &grammers_client::Client) -> Result<u64, String> {
    // Documentation-based limits (Telegram enforces server-side; grammers has no cap).
    Ok(if is_premium(client).await? { 4_000_000_000 } else { 2_000_000_000 })
}
```

Notes:
- grammers exposes **no** `premium()` accessor method — the flag is read from
  the raw TL struct via the public `.raw` field (verified).
- NoBuf already calls `get_me()` and accesses `.raw` (utils.rs:53, utils.rs:38),
  so this follows an existing pattern.
- Values `2_000_000_000` / `4_000_000_000` are documentation-based, not
  source-verified (no constant exists in grammers). Telegram enforces the true
  limit server-side and returns an RPC error if exceeded — our check is a
  courtesy pre-validation.

### 4.3 Unify size validation across all upload paths

Current inconsistency found: `cmd_zip_folder` (`archive.rs:339`) hardcodes
`2 * 1024 * 1024 * 1024` (2 GiB), is Premium-blind, and uses binary GiB instead
of the documented decimal `2_000_000_000`. `cmd_upload_file` has no size check.

Per the "apply the check everywhere consistently" decision, route **all three**
upload entry points through `upload_limit_bytes()`:
- drop path (new),
- file-picker path (`cmd_upload_file` / `handleManualUpload`),
- folder-zip path (`cmd_zip_folder` — replace the hardcoded GiB check).

Remote-URL path (`cmd_upload_from_url`) is **excluded** — size is unknown until
download completes.

---

## 5. Frontend (TypeScript/React) Changes

- **`useFileUpload.ts`**: add `handleDroppedFiles(files: File[])` that validates
  (§3.3), streams valid files via `cmd_stage_dropped_file`, and enqueues temp
  paths as `QueueItem`s. Reuses the existing `uploadQueue`/`processItem` flow
  verbatim.
- **`Dashboard.tsx`**: wire document-level (or main-area) `dragenter`/`dragover`/
  `dragleave`/`drop` handlers that (a) run the §3.4 discrimination, (b) toggle
  the overlay accept/reject state, (c) call `handleDroppedFiles` on a valid drop.
  Reuse existing `internalDragRef` guards so internal drags are untouched.
- **`DragDropOverlay.tsx`**: add a `variant: 'accept' | 'reject'` prop and the
  target folder name; render the reject (red) state for public-channel view.
- **`ExternalDropBlocker.tsx`**: **delete**. Remove its mount in `Dashboard.tsx`.
- **Size check** must also gate the existing picker path
  (`handleManualUpload`) — surface the Premium-aware limit before enqueueing.
  (Since the limit is Rust-side/async, either fetch it once on mount via a small
  `cmd_upload_limit` command and cache it, or validate inside the staging/upload
  command and reject there. Decide in the implementation plan; prefer a single
  cached `cmd_upload_limit` value for instant client-side UX.)

---

## 6. Implementation Phases (high level — detailed plan follows in writing-plans)

- **Phase 0 — Spike (required):** confirm in `tauri dev` (WebView2) that
  (a) `e.dataTransfer.files` delivers usable `File` objects on external drop with
  the native handler still disabled, and (b) the reliable folder-vs-file signal.
  This is a runtime check only the user can perform.
- **Phase 1 — Backend:** `cmd_stage_dropped_file`, `is_premium`/
  `upload_limit_bytes`, optional `cmd_upload_limit`; unify size checks. Register
  new commands in `lib.rs` invoke_handler + `capabilities/default.json` if
  required; `cargo build --no-default-features`.
- **Phase 2 — Frontend:** `handleDroppedFiles`, Dashboard drop wiring,
  `DragDropOverlay` variants, remove `ExternalDropBlocker`. `tsc --noEmit`.
- **Phase 3 — Consistency:** apply size gate to picker + zip paths.
- **Phase 4 — Hand-back QA:** user validates in `tauri dev` (see §7).

---

## 7. Verification Plan

**Automated (agent runs):**
- `cd app && npx tsc --noEmit` — zero new errors, before and after.
- `cd app/src-tauri && cargo build --no-default-features` — clean build
  (NOT `cargo check`; `tauri dev` uses `cargo run --no-default-features`).

**Runtime (user hand-tests in `tauri dev` — WebView2 behavior the agent cannot
drive):**
1. Drag a single file from Explorer → overlay shows → drop → uploads to current
   folder → temp file cleaned up.
2. Drag multiple files → all queued, processed one-by-one.
3. Drag a folder → whole drop rejected with toast.
4. Drag files + a folder together → whole drop rejected.
5. Drop while viewing a public channel → overlay shows red reject state, drop is
   no-op.
6. Drop an oversized file (or lower the limit temporarily to test) → rejected
   with the correct 2/4 GB message per account tier.
7. Drop a 0-byte file → rejected.
8. **Regression (critical):** internal file→folder move, folder reorder, and
   player control-bar chip drag ALL still work unbroken.
9. Dragging a file onto a folder does NOT flash the upload overlay.

Do not declare done on green types alone — hand back for hands-on confirmation
of items 1–9.

---

## 8. Source-Grounding Ledger (no assumptions)

| Claim | Verified in |
|---|---|
| Native handler disabled; re-enabling broke internal D&D here | `lib.rs:388`; git `0e03121`; `useFileDrop.ts`, `DropZoneContext.tsx` comments |
| External drops carry `'Files'` in `dataTransfer.types` | `ExternalDropBlocker.tsx:19` |
| Internal drags carry custom MIME types | `FileCard.tsx:96`, `SidebarItem.tsx:97` |
| `cmd_upload_file` is path-based with progress/cancel/bandwidth | `fs.rs:294–372` |
| Temp-file→`cmd_upload_file` pattern already shipped | `archive.rs:282–346`, `useFileUpload.ts:140–163` |
| `QueueItem` carries `path`; queue processes sequentially | `useFileUpload.ts:80–95, 126` |
| Premium flag readable via `get_me().raw` → `u.premium` | `generated_types.rs:57654`; grammers `peer/user.rs`, `chats.rs:405` |
| NoBuf already uses `get_me()` and `.raw` | `commands/utils.rs:53, 38` |
| Existing hardcoded 2 GiB Premium-blind check to unify | `archive.rs:339` |
| Tauri 2.11.2 / `@tauri-apps/api ~2.11.0` | `Cargo.lock`, `package.json` |

**Unverified / must confirm at runtime (Phase 0 spike):**
- Exact WebView2 folder-vs-file drop signal.
- That `File` objects are delivered on external drop with native handler off
  (strongly implied by the codebase comments, but a runtime fact).
