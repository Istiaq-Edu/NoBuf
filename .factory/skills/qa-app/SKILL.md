---
name: qa-app
description: >
  QA tests for the nobuff desktop app. Covers REST API endpoints (CI-compatible
  via curl) and GUI flows (local desktop only). The app is a Tauri v2 desktop application
  with a React frontend and Rust backend using the Telegram API via grammers.
---

# QA: nobuff App

## App Overview

- **Type:** Tauri v2 desktop application
- **Frontend:** React 19 + TypeScript + TailwindCSS 4 (dev server at `http://localhost:1420`)
- **Backend:** Rust with grammers (Telegram client), actix-web (media streaming on :14201, REST API on :8550)
- **Auth:** Telegram API (phone + code + optional 2FA) with SQLite session persistence
- **Build:** `cd app && npm install && npm run tauri dev`

## Testing Target

### CI Mode (REST API only)

Since this is a desktop app that requires a graphical display, GUI tests cannot run in CI. Only REST API tests are available.

**Prerequisites for CI:**
1. Build the app: `cd app && npm install && npm run tauri build`
2. Start the app binary (requires display — use xvfb on Linux)
3. Enable the REST API in Settings (or pre-configure via `api_settings.json`)
4. Generate an API key

**REST API base URL:** `http://localhost:8550` (default port, configurable)

**Auth header:** `X-API-Key: <api-key>`

### Local Mode (Full GUI + REST API)

**Start the app:**
```bash
cd app
npm install
npm run tauri dev
```

The app window opens. The frontend is also accessible at `http://localhost:1420` but requires the Tauri backend to function.

---

## Test Flow Menu

The orchestrator selects flows based on git diff. Each flow is labeled with:
- **ci:** whether it can run in CI (`true` = REST API, `false` = GUI only)
- **area:** which code area triggers it (`frontend`, `backend`, `both`)

---

### Flow 1: REST API — Health Check

**ci:** true | **area:** backend

Verify the REST API server is running and responds.

```bash
curl -s http://localhost:8550/api/v1/health
```

**Expected:** JSON response with `{"status":"ok","version":"X.Y.Z"}`. Status code 200.

**Negative test:**
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8550/api/v1/health
```
Should return 200.

---

### Flow 2: REST API — Authentication Required

**ci:** true | **area:** backend

Verify that API endpoints require authentication.

```bash
# Without API key — should fail
curl -s -o /dev/null -w "%{http_code}" http://localhost:8550/api/v1/files
```

**Expected:** 401 Unauthorized with JSON error body `{"error":{"code":"UNAUTHORIZED","message":"Missing X-API-Key header"}}`.

```bash
# With invalid API key — should fail
curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: invalid-key" http://localhost:8550/api/v1/files
```

**Expected:** 401 Unauthorized with `{"error":{"code":"UNAUTHORIZED","message":"Invalid API key"}}`.

---

### Flow 3: REST API — List Files

**ci:** true | **area:** backend

Verify file listing via the REST API.

```bash
# List files in Saved Messages (folder_id omitted = root)
curl -s -H "X-API-Key: $QA_API_KEY" http://localhost:8550/api/v1/files | python -m json.tool
```

**Expected:** JSON response with `{"files": [...], "page": 1, "limit": 50, "total": N}`.

**With search:**
```bash
curl -s -H "X-API-Key: $QA_API_KEY" "http://localhost:8550/api/v1/files?search=test"
```

**With pagination:**
```bash
curl -s -H "X-API-Key: $QA_API_KEY" "http://localhost:8550/api/v1/files?page=2&limit=10"
```

---

### Flow 4: REST API — Get File Metadata

**ci:** true | **area:** backend

Verify fetching metadata for a specific file.

```bash
# Get file by message_id (replace 123 with actual ID from list)
curl -s -H "X-API-Key: $QA_API_KEY" http://localhost:8550/api/v1/files/123
```

**Expected:** JSON with `{"id": 123, "folder_id": ..., "name": "...", "size": ..., "mime_type": "...", "created_at": "..."}`.

**Negative test — nonexistent file:**
```bash
curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: $QA_API_KEY" http://localhost:8550/api/v1/files/999999999
```
**Expected:** 404 Not Found.

---

### Flow 5: REST API — Download File

**ci:** true | **area:** backend

Verify file download via the REST API.

```bash
# Download file (replace 123 with actual ID)
curl -s -o /tmp/test-download -H "X-API-Key: $QA_API_KEY" \
  -w "HTTP %{http_code}, Size: %{size_download} bytes" \
  http://localhost:8550/api/v1/files/123/download
```

**Expected:** HTTP 200, file downloaded. Verify file size matches metadata.

**HEAD request for metadata:**
```bash
curl -s -I -H "X-API-Key: $QA_API_KEY" http://localhost:8550/api/v1/files/123/download
```
**Expected:** HTTP 200 with `Content-Length` and `Content-Type` headers.

**Range request (partial download):**
```bash
curl -s -o /tmp/test-range -H "X-API-Key: $QA_API_KEY" \
  -H "Range: bytes=0-1023" \
  -w "HTTP %{http_code}, Size: %{size_download} bytes" \
  http://localhost:8550/api/v1/files/123/download
```
**Expected:** HTTP 206 Partial Content, 1024 bytes.

---

### Flow 6: Authentication — Phone Login (GUI)

**ci:** false | **area:** both

**Requires:** A real display. Cannot run in CI.

1. Launch the app (`npm run tauri dev`)
2. Verify the auth wizard appears with "Setup" step
3. Enter API ID and API Hash, click Continue
4. Enter phone number in international format, click Continue
5. Enter the verification code received on Telegram
6. If 2FA is enabled, enter the password
7. Verify the Dashboard appears with Saved Messages loaded

**Success criteria:** Dashboard shows files/folders from Saved Messages. Sidebar shows folder list. Top bar shows "nobuff" with connection status.

**Negative test — invalid phone:**
Enter an invalid phone number. Verify error message appears.

**Negative test — wrong code:**
Enter an incorrect verification code. Verify error message appears.

---

### Flow 7: QR Code Login (GUI)

**ci:** false | **area:** both

1. On the auth wizard, switch to QR code login mode
2. Verify a QR code is displayed
3. Verify the app polls for authorization (check console logs for "QR login" messages)
4. (Manual: scan QR with Telegram mobile app)
5. Wait for the session to become authorized
6. Verify the Dashboard appears

**Success criteria:** After scanning QR code on phone, the app transitions to Dashboard.

---

### Flow 8: File Browsing (GUI)

**ci:** false | **area:** both

1. After authentication, verify the Dashboard is loaded
2. Verify files are displayed in the current view mode (grid or list)
3. Click on a folder in the sidebar to navigate into it
4. Verify the file explorer updates to show that folder's contents
5. Use the search bar to search for a file by name
6. Verify search results appear and match the query
7. Clear the search and verify all files reappear

**Success criteria:** Files and folders are displayed correctly. Navigation works. Search filters results.

**Negative test — empty folder:**
Navigate to an empty folder. Verify the empty state message is shown.

---

### Flow 9: File Upload (GUI)

**ci:** false | **area:** both

1. Click the upload button or drag a file onto the window
2. Select a test file (e.g., `app/test_upload.txt`)
3. Verify the file appears in the upload queue with "pending" or "uploading" status
4. Wait for the upload to complete
5. Verify the file appears in the file explorer
6. Verify the upload queue shows "success" status

**Success criteria:** File uploaded successfully and visible in the file list.

**Negative test — cancel upload:**
Start an upload and cancel it mid-way. Verify the queue shows "cancelled" and the file does not appear.

---

### Flow 10: File Download (GUI)

**ci:** false | **area:** both

1. Select a file in the file explorer
2. Click download (or use context menu)
3. Verify the file appears in the download queue
4. Wait for the download to complete
5. Verify the downloaded file exists on disk

**Success criteria:** File downloaded successfully and matches original.

---

### Flow 11: Media Preview (GUI)

**ci:** false | **area:** frontend

1. Click on an image file in the file explorer
2. Verify the PreviewModal opens showing the image
3. Close the preview
4. Click on a PDF file
5. Verify the PdfViewer opens with the document rendered
6. Click on a video/audio file
7. Verify the MediaPlayer opens and playback starts

**Success criteria:** Media files preview correctly. Images render, PDFs are readable, video/audio plays.

---

### Flow 12: Folder Management (GUI)

**ci:** false | **area:** both

1. Click "New Folder" or the create folder button
2. Enter a folder name and confirm
3. Verify the new folder appears in the sidebar
4. Navigate into the new folder — verify it's empty
5. Delete the folder
6. Verify it disappears from the sidebar

**Success criteria:** Folders can be created and deleted.

**Cleanup:** Delete any test folders created during testing via `cmd_delete_folder`.

---

### Flow 13: Settings (GUI)

**ci:** false | **area:** frontend

1. Open the Settings modal
2. Toggle view mode between grid and list — verify the file explorer updates
3. Change concurrent upload/download limits
4. Toggle the REST API on/off
5. Change the REST API port
6. Generate an API key — verify it's displayed once
7. Copy the API key — verify copy confirmation

**Success criteria:** Settings changes are applied immediately. API key generation works.

---

### Flow 14: Theme Toggle (GUI)

**ci:** false | **area:** frontend

1. Verify the current theme (dark or light)
2. Click the theme toggle button
3. Verify the theme switches (all UI elements update)
4. Click again to switch back
5. Verify the theme persists after app restart

**Success criteria:** Theme toggles correctly and persists.

---

### Flow 15: REST API — No Connection State

**ci:** true | **area:** backend

Verify API behavior when Telegram client is not connected.

If the app starts but hasn't connected to Telegram yet:
```bash
curl -s -H "X-API-Key: $QA_API_KEY" http://localhost:8550/api/v1/files
```

**Expected:** 503 Service Unavailable with `{"error":{"code":"NOT_CONNECTED","message":"Telegram client is not connected"}}`.

---

## Known Failure Modes

1. **REST API not enabled by default.** The REST API is disabled in Settings. QA must either enable it via the GUI (local) or pre-configure `api_settings.json` with `{"enabled": true, "port": 8550, "key_hash": "..."}` before running CI tests.

2. **Tauri app requires display.** GUI tests cannot run in headless CI. On Linux CI runners, use `xvfb-run` to provide a virtual display if GUI tests are needed.

3. **Telegram rate limiting (FLOOD_WAIT).** Rapid file listing or download requests may trigger Telegram rate limits. The app shows a countdown timer. If QA hits this, wait and retry.

4. **Session file corruption.** The `telegram.session` SQLite file can become corrupted. The app handles this by deleting and recreating the session. If auth fails unexpectedly, check the session file.

5. **Build time on first run.** The initial `npm run tauri dev` compiles 300+ Rust crates and takes 5-15 minutes. Subsequent runs are faster. Pre-build in CI to avoid timeout.

6. **Port conflicts.** The media streaming server uses port 14201. The REST API defaults to 8550. Ensure these ports are free before starting the app. Use `cmd_update_api_settings` to change the REST API port if needed.

7. **2FA password required.** Some Telegram accounts have two-factor authentication enabled. The auth flow will prompt for a password after the verification code. If the test account has 2FA, the password must be provided.

---

## Authentication Method

This app uses **Telegram API** authentication (not OAuth, SAML, or email/password):

1. User provides `api_id` and `api_hash` (from my.telegram.org)
2. User enters phone number
3. Telegram sends a verification code
4. User enters the code
5. If 2FA is enabled, user enters password
6. Session is persisted as `telegram.session` (SQLite)

**For CI testing:** Pre-authenticate once locally to generate the session file, then use that session in CI (it persists across app restarts). Alternatively, use the REST API which piggybacks on the existing session.

**Environment variables for CI:**
- `TELEGRAM_API_ID` — Telegram API ID
- `TELEGRAM_API_HASH` — Telegram API hash
- `QA_API_KEY` — REST API key for authenticated requests
