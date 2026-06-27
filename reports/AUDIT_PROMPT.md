# NoBuf Full-Codebase Audit Prompt

You are a senior security + stability + performance auditor. Your job is to audit the **entire NoBuf codebase** — a Tauri 2.x desktop app (Rust backend + React 19 / TypeScript frontend) that uses Telegram channels as cloud storage with an embedded Actix-Web HTTP API server, video streaming/transmuxing pipeline, archive extraction, and auto-update mechanism.

Produce a structured, prioritized report. Do not write filler. Every finding must include: file path, line number(s), severity (Critical / High / Medium / Low / Info), a concrete proof-of-concept or reasoning, a recommended fix with code snippet, AND a functional-safety assessment (see Section 8). If something is fine, say "PASS" and move on — do not pad.

---

## 0. Codebase Map (for orientation)

```
Frontend (src/)
├── components/dashboard/    — UI: FileExplorer, SettingsPage, MediaPlayer, ArchiveViewer, etc.
├── lib/faststream/          — Custom streaming engine: MSE player, fMP4/HLS/TS transmuxers, download manager, FragmentStore (IndexedDB)
├── hooks/                   — useFileUpload, useFileDownload, useMSEPlayer, useNetworkStatus, etc.
├── context/                 — SettingsContext, ThemeContext, CacheSessionContext, ConfirmContext
├── contexts/                — DropZoneContext (drag-drop state management)
├── theme/                   — Theme engine + presets
├── __tests__/               — Vitest unit tests
└── types.ts, utils.ts       — Shared types and utilities

Backend (src-tauri/src/)
├── server.rs                — Embedded Actix-Web streaming server (4400 lines) — streaming, HLS, fMP4, cache, TS rewriting
├── api_routes.rs            — REST API endpoints (/api/v1/*) with X-API-Key auth (port 8550)
├── commands/                — Tauri IPC commands: auth, fs, network, streaming, archive, api_settings, folder_groups, etc.
├── hls/                     — HLS manifest generation
├── stream_cache.rs          — Disk-backed stream cache manager
├── download_pool.rs         — Concurrent download pool with semaphore
├── ts_demux.rs              — MPEG-TS demuxer
├── fmp4.rs                  — fMP4 fragment builder
├── faststart.rs             — MP4 faststart (moov relocation)
├── bandwidth.rs             — Bandwidth monitoring
├── models.rs                — Data models / structs
├── lib.rs                   — App entry, state setup, plugin registration, custom protocol proxy, shutdown handler (544 lines)
└── main.rs                  — Binary entry point

Config & Build
├── tauri.conf.json          — CSP, updater config, bundle settings
├── capabilities/default.json — Tauri permission scope (fs, shell, updater, all IPC commands)
├── build.rs                 — Tauri build script with command manifest (auto-generates permission TOML)
├── vite.config.ts           — Vite bundler config (build optimization, dev server, plugins)
├── tsconfig.json            — TypeScript compiler config (strict mode, paths)
└── Cargo.toml / package.json — Dependencies

Docs
└── docs/                    — Design specs (cold-start overlay, proactive prebuffer, 180s/60s buffer plan)
```

**Tech stack**: Tauri 2.x, Rust (grammers Telegram client, actix-web, tokio, sqlite, zip, rar, sevenz-rust2, ffmpeg-sidecar, ureq), React 19, TanStack Query, Tailwind 4, Vite 7, mpegts.js, mp4box, mediabunny, mux.js, pdfjs-dist, jassub.

---

## 1. SECURITY AUDIT

### 1.1 Embedded HTTP API Server (api_routes.rs)

The app embeds an Actix-Web server that listens on a configurable port (default 8550) and serves files from Telegram storage via REST endpoints. (The streaming server on port 14201 is covered separately in Section 1.1b.)

- **Authentication**: The API uses `X-API-Key` header validated against a SHA256 hash with `constant_time_eq`. Audit:
  - Is the key generation cryptographically random? What's the entropy? (check `regenerate-api-key` command)
  - Is the hash the ONLY protection? Is there rate limiting / brute-force protection on the auth check?
  - Can the key be extracted from memory, logs, or error messages?
  - Is the key hash stored in plaintext JSON (`api_settings.json`)? Is the file permissioned correctly?
  - Does the API server bind to `0.0.0.0` or `127.0.0.1`? If `0.0.0.0`, the Telegram files are exposed to the LAN/internet. Check the bind address in the server startup code.

- **CORS** (already known: `actix-cors` 0.7 with `draft-private-network-access` feature, configured as `allow_any_origin()` + `allow_any_method()` + `allow_any_header()` in lib.rs line 95-98):
  - The API server binds to 127.0.0.1 but CORS is fully open. Any website running in the user's browser can send fetch requests to the API. Verify this is the case and flag as a finding.
  - Can a malicious website exfiltrate all file listings, download files, or trigger uploads via the API?
  - Is the `Private-Network-Access` header properly enforced by the `draft-private-network-access` feature, or is it just added as a response header without actual preflight handling?
  - Note: the `draft-private-network-access` feature is a draft spec — check if actix-cors 0.7 actually enforces it or just adds the header.

- **Endpoints**: Enumerate every route in `api_routes.rs` and `server.rs`. For each:
  - Is auth required? (health endpoint is public — is anything else accidentally public?)
  - Path traversal: do any endpoints accept file paths, message IDs, or indices that could escape bounds?
  - SSRF: does `upload-from-url` fetch arbitrary URLs? Can it be used to scan internal networks (127.0.0.1, 192.168.x.x, metadata endpoints)?
  - Information disclosure: do error messages leak internal paths, Telegram API IDs, session data?
  - DoS resistance: Are there connection limits, request size limits, or rate limiting on any endpoint? Can an attacker exhaust memory by requesting many concurrent range requests?

- **Range header parsing** (`parse_range_header` in api_routes.rs):
  - Can a malformed Range header cause panic, integer overflow, or excessive allocation?
  - Can `start > end` or `total_size - 1` underflow if `total_size == 0`?

### 1.1b Streaming Server Auth & Security (server.rs, lib.rs)

The streaming server runs on port 14201 and serves actual file content from Telegram. It is SEPARATE from the API server and uses a different auth mechanism.

- **Token auth**: `generate_stream_token()` in lib.rs creates a 32-char hex token (16 bytes / 128 bits). Audit:
  - How is this token validated on incoming requests to the streaming server? Is it compared in constant time?
  - Is the token transmitted in plaintext over HTTP (not HTTPS)? Can a local packet sniffer capture it?
  - Is the token regenerated on each app launch? If so, does that break persistent URLs?
  - Can the token be extracted from the frontend JS context (e.g., via `cmd_get_stream_info`)? Does that matter?

- **Custom protocol proxy** (`handle_nobuf_stream_protocol` in lib.rs):
  - The proxy reads the FULL response body into a `Vec::new()` (line 172). For large videos, this can cause OOM. Is there a size limit?
  - The `path_and_query` from the custom protocol request is directly concatenated into the target URL (line 136). Can this be manipulated to access unintended paths on the streaming server?
  - The proxy has a 120-second timeout (line 147). Can an attacker cause resource exhaustion by sending many slow requests?
  - Are all response headers properly forwarded, or could sensitive internal headers leak to the webview?

- **Streaming server bind address**: Does the streaming server bind to 127.0.0.1 or 0.0.0.0? If 0.0.0.0, anyone on the LAN can access all files.

### 1.2 Tauri Permission Surface (capabilities/default.json)

- Audit every permission in `default.json`. The file grants:
  - `fs:allow-appdata-read-recursive` + `fs:allow-appdata-write-recursive` — full appdata R/W
  - `shell:allow-open` — can open arbitrary URLs/files in external apps
  - `updater:default` — auto-update
  - 60+ custom IPC command permissions
- Are any permissions over-scoped? Could a compromised webview execute arbitrary file writes or shell commands?
- Is `shell:allow-open` constrained to specific URLs/protocols, or can it open any URI scheme (file://, smb://, etc.)?

### 1.3 Content Security Policy (tauri.conf.json)

The CSP is:
```
default-src 'self' http://localhost:* nobuf-stream:* http://nobuf-stream.localhost;
connect-src 'self' http://localhost:*;
media-src 'self' blob: http://localhost:* nobuf-stream:* http://nobuf-stream.localhost;
img-src 'self' data: blob: asset: https://asset.localhost;
style-src 'self' 'unsafe-inline';
script-src 'self'; worker-src 'self' blob:;
```
- `connect-src 'self' http://localhost:*` — any localhost port. Can the webview exfiltrate data to any local service?
- `style-src 'unsafe-inline'` — acceptable for Tailwind, but does it enable any CSS-based attacks?
- Is `http://localhost:*` too broad? Could a malicious local process receive data?
- Are there any `blob:` or `data:` URIs that could be abused for XSS payloads?

### 1.4 Telegram Session & Credential Security (commands/auth.rs)

- The Telegram session is stored as a SQLite file (`telegram.session`) in app_data_dir.
  - Is the session file encrypted at rest? (grammers uses plain SQLite — this is likely unencrypted)
  - Can another process on the machine read it and hijack the Telegram account?
  - Is the session file cleaned up on logout? Are WAL/SHM files also removed?
- API ID/Hash: How are the Telegram API credentials stored? Are they hardcoded or user-provided?
  - If hardcoded, they're a shared secret that can be revoked by Telegram — check for abuse potential.
- The auth flow (QR login, phone+password): Is the 2FA password ever logged, stored in plaintext, or sent over IPC in a way that could be intercepted?

### 1.5 File Handling — Archive Extraction (commands/archive.rs)

- Supports zip, rar, 7z extraction. Audit:
  - **Zip slip / path traversal**: Does extraction validate that entries stay within the target directory? Check for `../` in entry names.
  - **Zip bombs**: Is there a decompression ratio limit? Max extracted size limit? Max file count limit?
  - **Symlink attacks**: Does the extractor follow symlinks that point outside the target dir?
  - **Resource exhaustion**: Can a malformed archive cause infinite loops, OOM, or disk fill?

### 1.6 File Handling — Upload from URL (commands/fs.rs or utils.rs)

- `cmd_upload_from_url`: Does it validate the URL scheme? Can it fetch `file://`, `ftp://`, or internal IPs?
  - SSRF: Can an attacker (via the API server) make the app fetch from `http://169.254.169.254/` (cloud metadata) or `http://127.0.0.1:port/` (local services)?
  - Is there a redirect-following limit? Can a redirect go to an internal address?
  - Is the fetched content size-limited before upload to Telegram?

### 1.7 Auto-Update Security (tauri.conf.json, updater plugin)

- The updater pulls from `https://github.com/Istiaq-Edu/nobuf/releases/latest/download/latest.json`
  - Is the pubkey verification actually enforced? Can a MITM or compromised CDN serve a malicious update?
  - Is the `latest.json` endpoint over HTTPS? Is certificate pinning used?
  - Can the update URL be overridden via env vars or config injection?
  - Does the updater verify the signature BEFORE writing files, or after?
  - **Update rollback**: What happens if an update fails mid-installation? Is there a rollback mechanism? Can a partial update brick the app?
  - **Update frequency**: How often does the app check for updates? Can the check be disabled? Does it happen on every launch?
  - **Update notification**: Is the user prompted before an update is applied, or is it silent?

### 1.8 IPC Command Surface (all commands/*.rs)

- Enumerate every `#[tauri::command]` function. For each:
  - Input validation: Are all parameters validated (types, lengths, ranges)?
  - Can a malicious webview invoke commands with crafted arguments to cause panics, path traversal, or resource exhaustion?
  - Are there commands that spawn processes (ffmpeg-sidecar), and are their arguments sanitized?
  - `cmd_log` — can it be used to write arbitrary content to logs that might be parsed by other tools?

### 1.9 Process Spawning — ffmpeg-sidecar

- How is ffmpeg invoked? Are file paths passed as arguments without sanitization?
- Can a malicious filename (e.g., `--output=malicious`) inject ffmpeg flags?
- Is the ffmpeg binary path configurable? Could an attacker swap the binary?

### 1.10 Dependency Audit

- **Rust (Cargo.toml)**: Check for known CVEs in all crates. Pay attention to:
  - `grammers-*` (git dependency pinned to rev `d07f96f` — is this a reviewed commit?)
  - `actix-web`, `sqlite` (bundled), `zip`, `rar`, `sevenz-rust2`, `ureq`, `base64`
  - Is `base64 = "0.21"` outdated? (0.22 is current)
- **NPM (package.json)**: Check for known vulnerabilities:
  - `pdfjs-dist`, `mpegts.js`, `mp4box`, `mediabunny`, `mux.js`, `jassub`
  - Run `npm audit` and report all findings
- Are there any dependencies pulled from git/CDN without integrity checks?

### 1.11 Custom Protocol & Production Localhost Security (lib.rs)

- **`nobuf-stream://` custom protocol**: Registered via `register_asynchronous_uri_scheme_protocol`. Audit:
  - Can a malicious web page construct `nobuf-stream://` URLs to access arbitrary streaming server paths?
  - Is the protocol handler vulnerable to SSRF via crafted URL paths?
  - Does the proxy validate the upstream response before forwarding to the webview?
- **`tauri-plugin-localhost` (production)**: In release builds, the frontend is served from `http://localhost:14200`. Audit:
  - Can other local processes access the frontend assets at localhost:14200?
  - Is there a risk of DNS rebinding attacks against the localhost plugin?
  - Does the localhost plugin expose any debug endpoints or source maps in production?

### 1.12 File Upload Validation (commands/fs.rs)

- Does `cmd_upload_file` validate file types, extensions, or MIME types before uploading to Telegram?
- Can a user upload executable files, scripts, or other potentially dangerous content?
- Is the filename sanitized before upload? Can a filename contain path separators, null bytes, or unicode tricks?
- `cmd_zip_folder` (folder compression + upload): Is the zip file sanitized? Can it include files outside the selected folder via symlinks?
- `cmd_upload_from_url`: Beyond SSRF (covered in 1.6), does it validate the Content-Type of the fetched URL? Can it download and upload malicious content?

### 1.13 Logging & Information Disclosure (all Rust files)

- **Log file location**: Where do `log::info!` / `log::warn!` / `log::error!` outputs go? To a file? To stderr?
- **Sensitive data in logs**: Search all log statements for:
  - Telegram session paths (`session_path_str`)
  - API key hashes or plaintext keys
  - File names from user storage
  - Telegram API IDs
  - Phone numbers or 2FA passwords
  - Stream tokens
- **`cmd_log`**: This command accepts arbitrary strings from the frontend and writes them to logs. Can it be used to inject false log entries or overwrite real logs?
- Can log files be read by other users on the system?

### 1.14 Third-Party Library Sandboxing (frontend)

- **pdfjs-dist**: PDF.js has known XSS vectors via malicious PDFs. Audit:
  - Is the PDF viewer rendered in a sandboxed context? Does it have access to the Tauri IPC bridge?
  - Can a malicious PDF execute JavaScript in the webview context?
  - Is `pdfjs-dist` configured with `disableWorker` or proper worker sandboxing?
- **jassub (WASM subtitle renderer)**: Subtitle files (.srt, .ass, .vtt) are parsed by a WASM renderer. Audit:
  - Can a malicious subtitle file exploit the WASM parser?
  - Does JASSUB have access to the DOM or Tauri APIs?
  - Are subtitle files validated before being passed to the renderer?
- **mpegts.js / mp4box / mediabunny**: These parse binary media formats. Can a malformed media file exploit parser vulnerabilities?

### 1.15 Cross-Platform Security (network.rs, platform-specific code)

- The VPN detection has `#[cfg(target_os = "windows")]`, Linux, and macOS branches. Audit:
  - Does the Linux branch (`/sys/class/net` for tun/tap/wg/ppp) cover all VPN types?
  - Does the macOS branch (`ifconfig -l` for utun/tun/wg/ppp) work correctly?
  - Are there platform-specific security gaps (e.g., Linux file permissions on session files)?
- `ffmpeg-sidecar`: Does it download ffmpeg binaries? If so, is the download verified (checksum, signature)?

### 1.16 Telegram ToS & Abuse Compliance

- NoBuf uses Telegram channels as cloud storage. Audit:
  - Does this usage pattern violate Telegram's Terms of Service? (automated file storage in channels)
  - Could Telegram ban the user's account for automated API usage at scale?
  - Are there rate-limiting protections in place to avoid triggering Telegram's anti-abuse systems?
  - Is the API ID used by the app associated with a registered Telegram application?

### 1.17 SQLite Injection (folder_groups.rs, models.rs, auth.rs)

- The app uses `sqlite = "0.37"` (bundled) for folder grouping AND grammers session storage. Audit:
  - Are ALL SQLite queries parameterized? Search for string interpolation or format!() in SQL statements.
  - Folder names and group names are user-controlled — can they contain SQL injection payloads (`'; DROP TABLE--`)?
  - The session database (grammers) — is it created with proper permissions? Can another process inject data?
  - Are there any raw `conn.execute()` calls with concatenated strings instead of `?` placeholders?

### 1.18 Windows-Specific Attack Surfaces

- NoBuf runs on Windows with Tauri/WebView2. Audit Windows-specific risks:
  - **UNC path injection**: Can file paths contain `\\?\` or `\\server\share` UNC prefixes to access network resources?
  - **Case-insensitive path traversal**: On Windows, `..` and `..` are equivalent. Does path validation account for this?
  - **Alternate data streams**: Can a filename contain `:` to create ADS (e.g., `file.txt:malicious`)?
  - **NTFS junction points / symlinks**: Can archive extraction create junctions that redirect writes?
  - **File locking**: Windows locks files differently than Unix. Can locked files cause deadlock or data corruption?
  - **ACLs**: Are sensitive files (session, API settings) secured with Windows ACLs, or readable by all users?

### 1.19 Configuration File Integrity (api_settings.json, network_settings.json)

- The app persists settings as JSON files in app_data_dir. Audit:
  - **Concurrent writes**: Can two parts of the app write to the same config file simultaneously? Is there file locking?
  - **Malformed JSON**: What happens if a config file is corrupted or manually edited with invalid JSON? Does the app crash or gracefully fall back to defaults?
  - **TOCTOU**: Is there a time-of-check-to-time-of-use race between reading and applying config values?
  - **Config injection**: Can an attacker with write access to app_data_dir inject malicious config values (e.g., change the API port to expose it externally, change the updater URL)?
  - **Atomic writes**: Are config writes atomic (write-to-temp-then-rename), or can a crash mid-write leave a truncated file?

### 1.20 Data Privacy & Telemetry

- Does the app phone home or send any data to external servers beyond Telegram?
  - Check for any HTTP calls to non-Telegram endpoints (analytics, crash reporting, usage tracking).
  - Does the auto-updater send usage data or unique identifiers?
  - Are file names, file contents, or user metadata ever sent to any server other than Telegram?
  - Does the app collect any telemetry about user behavior, file types, or usage patterns?
  - Check for any hidden network calls in the frontend (fetch/XMLHttpRequest to external URLs).

### 1.21 Build Artifact Security

- What ships in the production binary? Audit:
  - Are debug symbols included in release builds? Can they leak function names or internal structure?
  - Are source maps generated in `npm run build`? Do they ship in the Tauri bundle?
  - Is the Rust binary compiled with `strip = true` in the release profile?
  - Are there any `#[cfg(debug_assertions)]` blocks that should NOT ship in production?
  - Does the production binary contain hardcoded test credentials, API keys, or development URLs?
  - Is the `tauri-plugin-localhost` port (14200) accessible in production builds by other local processes?

### 1.22 Upstream Divergence & Missing Security Patches

NoBuf is a fork of `caamer20/Telegram-Drive`. The `upstream-release-audit` skill contains a verified gap analysis (v1.0.0–v1.9.5). Audit:

- Load `upstream-release-audit` skill and read `references/nobuf-vs-telegram-drive-gaps.md` for the verified gap list.
- Has upstream released any security fixes post-divergence that NoBuf has NOT adopted?
- Has upstream fixed any of the bugs identified in this audit (CORS, session handling, archive extraction) in a way that NoBuf could adopt?
- Are there upstream architectural changes (e.g., different auth mechanism, different CSP, different session storage) that improve security?
- Does upstream have any features that REDUCE risk (e.g., file type validation, rate limiting) that NoBuf is missing?
- Check upstream's latest release notes for any security advisories or CVE mentions.
- **Establish divergence point**: Use `git tag -l | sort -V` to find the latest upstream tag in our repo. Only upstream releases AFTER that tag are candidates for adoption.

---

## 2. STABILITY & RELIABILITY AUDIT

### 2.1 Panic Safety (all Rust files)

- Search for `.unwrap()`, `.expect()`, and raw array indexing `[i]` across all `.rs` files.
  - Which of these are on user-controlled input (file paths, message IDs, API responses)?
  - Which are on network responses (Telegram API, HTTP fetch)?
  - Which are in async contexts where a panic kills a task but not the app?
- Are there any `unwrap()` calls on locks (`.lock().unwrap()`) that could deadlock or poison?
- `parse_range_header`: `total_size - 1` when `total_size == 0` → underflow panic.
- **Duplicate command registration**: `cmd_rename_folder` and `cmd_start_auto_sync` are registered TWICE in `generate_handler![]` (lib.rs lines 402/422 and 403/423). Does this cause a runtime conflict, a compile warning, or silent behavior change?
- **Command sync mismatch**: `cmd_get_cache_total_size` is in `lib.rs` invoke_handler but NOT in `build.rs` commands array. Does this cause a build failure or runtime permission error? Run the sync verification script from the `tauri-rust` skill to find ALL mismatches.

### 2.2 Concurrency & Lock Discipline

- `TelegramState` holds multiple `Mutex`/`RwLock` fields. Audit:
  - Is there a consistent lock ordering? Can two tasks deadlock by acquiring locks in opposite order?
  - Are any locks held across `.await` points? (tokio Mutex is okay, std Mutex across await is NOT)
  - The runner shutdown in `auth.rs` uses `std::sync::Mutex` for `runner_shutdown` — is this held across an await?
- `download_pool.rs`: How does the semaphore handle cancellation? Can a cancelled download leak semaphore permits?
- `stream_cache.rs`: Concurrent file access — are there race conditions between cache reads and writes?
- **Concurrent file operations**: What happens when:
  - A file is being streamed while the user deletes it from Telegram?
  - Two downloads of the same file are initiated simultaneously?
  - A file is being uploaded while a preview is requested?
  - The user navigates away from a folder while its files are still loading?
  - Background caching and foreground streaming request the same file range simultaneously?

### 2.3 Resource Leaks

- **File handles**: Are all `std::fs::File` / `tokio::fs::File` properly closed on error paths? Check for early returns that skip cleanup.
- **Temp files**: Does archive extraction, faststart, or sprite-sheet generation clean up temp files on failure?
- **Memory**: Does the streaming pipeline (`server.rs`, 4400 lines) bound its in-memory buffers? Can a large video cause OOM?
- **Tokio tasks**: Can the download pool or prebuffer system spawn unbounded tasks?
- **Disk**: Does the stream cache have a size limit / eviction policy? Can it fill the disk?

### 2.3b Shutdown Ordering & Graceful Degradation (lib.rs RunEvent::Exit)

- The app has an 8-step shutdown sequence in `RunEvent::Exit` (lib.rs lines 452-543). Audit:
  - Step 1: Runner shutdown (oneshot send) — what if the runner is already dead?
  - Step 2: Actix streaming server stop + 2-second sleep — is 2s enough? Is the sleep blocking the exit?
  - Step 3: API server stop — can it hang indefinitely?
  - Step 4-7: Cache cleanup (stream-cache, remux, thumbnails, previews) — what if files are locked?
  - Step 8: Partial download cleanup — drains `partial_downloads` Vec. Is this Vec populated correctly?
  - Can the user force-quit (Alt+F4 / Task Manager) before cleanup completes? What state is left behind?
  - Is the shutdown sequence idempotent? Can it run twice if Exit is fired twice?

### 2.3c Drag-and-Drop Security (custom handler)

- The app calls `disable_drag_drop_handler()` on the window (lib.rs line 376) and implements its own drag-drop. Audit:
  - Does the custom drag-drop handler validate file types, sizes, or paths?
  - Can a dropped file trigger automatic upload without user confirmation?
  - Can a malicious file path (with `..` or unicode tricks) escape the intended upload directory?
  - Is the drop zone properly isolated from the webview's default file handling?

### 2.3d IndexedDB & Fragment Store Stability (lib/FragmentStore.ts, context/CacheSessionContext.tsx)

- NoBuf uses IndexedDB for video fragment caching (offline storage). Audit:
  - **Storage limits**: Does the app check `navigator.storage.estimate()` before writing? Can IndexedDB fill the disk?
  - **Transaction handling**: Are all IndexedDB transactions properly committed/aborted on error? Can a failed transaction leave the store in a corrupted state?
  - **Concurrent access**: Can two streaming sessions write to the same fragment store simultaneously? Are there race conditions?
  - **Eviction**: Can the browser evict IndexedDB data mid-stream? Does the app request `navigator.storage.persist()`?
  - **Schema migration**: What happens if the IndexedDB schema changes between app versions? Is `onupgradeneeded` handled?
  - **Fragment merging**: Is the fragment merging logic correct? Can corrupted fragments cause incorrect merges?
  - **Security**: Can a malicious web page access the IndexedDB store? Is it scoped to the app origin?
  - **Memory pressure**: Does the hybrid memory+IndexedDB pattern have a bounded memory footprint, or can it grow unbounded?

### 2.4 Error Handling & Recovery

- Are errors from Telegram API calls retried? With backoff? Or do they propagate as user-facing errors?
- What happens when the Telegram session is invalidated (e.g., logged out from another device)? Does the app detect this and re-prompt auth, or does it hang?
- Network disconnection mid-stream: Does the player recover or freeze?
- What happens if the app data directory is not writable? Is there a graceful degradation path?

### 2.5 Frontend Stability

- Error boundaries: Is there a top-level `ErrorBoundary`? Does it catch all render errors, or just some?
- State management: Can rapid folder switching, concurrent uploads, or streaming start/stop cause race conditions in TanStack Query caches?
- Memory leaks: Are all event listeners, WebSocket connections, MSE SourceBuffers, and object URLs cleaned up on unmount?
- What happens when the Tauri backend command returns an error string? Is it always handled, or can it crash the UI?

### 2.6 Test Coverage

- Current tests: `sanitizeFilename.test.ts`, `copyLink.test.ts`, `naturalSort.test.ts`, `TsResumeUtils.test.ts`, `CacheSessionContext.test.ts`, `useGridColumns.test.ts`
- What's NOT tested? (Hint: almost everything — streaming, auth, file ops, archive, API server, network detection)
- Are there integration tests for the streaming pipeline?
- Are there Rust unit tests beyond `api_settings.rs`?

---

## 3. PERFORMANCE & OPTIMIZATION AUDIT

### 3.1 Streaming Pipeline (server.rs, lib/faststream/)

- The streaming server is 4400 lines in a single file. Audit:
  - How many times is a video chunk copied between memory and disk? Can the copy count be reduced?
  - Is `rewrite_ts_stream_in_buf` called on every chunk? Can it be cached/avoided for subsequent chunks?
  - Is the fMP4 segment builder allocating new buffers per segment, or reusing a pool?
  - Are there unnecessary `clone()` calls on large buffers?
- Download pool: Is the concurrency level configurable? What's the optimal value for different file sizes?
- Prebuffering: Is the prebuffer size adaptive based on bandwidth, or fixed?

### 3.2 Frontend Rendering

- `FileExplorer` + `FileListItem`: With 10,000+ files, does the virtualization work correctly? Are there off-screen renders?
- Are React components memoized where needed? Check `React.memo`, `useMemo`, `useCallback` usage.
- Are TanStack Query keys structured to avoid unnecessary refetches?
- Is the theme engine causing full re-renders on color change? CSS variables should prevent this — verify.
- Bundle size: Run `vite build` and report the chunk sizes. Are any dependencies too large? Should code-splitting be added for PDF viewer, archive viewer, etc.?

### 3.3 Disk I/O

- Stream cache: Is the cache using sequential writes or random writes? Are reads cached by the OS?
- SQLite: Is WAL mode enabled for the session database? Are there synchronous writes that could be batched?
- Archive extraction: Is it streaming to disk, or buffering entire files in memory first?

### 3.4 Network

- Telegram DC selection: Is the closest DC always used, or is there a fallback strategy?
- Chunk size: Is 512KB optimal? Should it be adaptive based on latency/bandwidth?
- Are HTTP/2 or connection pooling used for the API server? (Actix-Web defaults)
- Is gzip/brotli enabled for API responses?

### 3.5 Rust Compilation

- Are release builds using LTO and `opt-level`? Check `Cargo.toml` for `[profile.release]` settings.
- Are there any `clone()` calls on `Arc` that could be avoided?
- Is `serde_json` used in hot paths where `serde_json::from_slice` would avoid a string allocation?

---

## 4. CODE QUALITY & MAINTAINABILITY

### 4.1 Architecture

- `server.rs` is 4400 lines. Should it be split into modules (HLS, fMP4, cache, TS rewriting, range serving)?
- `commands/fs.rs` is 1454 lines. Should file ops be split by concern (upload, download, metadata, folders)?
- Is there a clear boundary between Tauri IPC commands and the HTTP API server, or is logic duplicated?
- Are there shared utilities between `api_routes.rs` and `commands/*.rs` that should be extracted?

### 4.2 Error Types

- Is `String` used as the error type everywhere? Should a proper error enum (thiserror) be introduced?
- Are error messages user-friendly, or do they leak Rust internals?
- Are there any `unwrap_or_default()` calls that silently swallow real errors?

### 4.3 Frontend Code Quality

- Are there `any` types that should be properly typed? Check for `as any` casts.
- Are Tauri `invoke` calls type-safe, or are command names stringly-typed?
- Is there consistent error handling, or do some components silently fail?
- Are there magic numbers that should be named constants?

### 4.4 Documentation

- Are public Rust functions documented with `///`?
- Are complex algorithms (TS rewriting, fMP4 segment building, range merging) documented?
- Is there a README or architecture doc for new contributors?
- Are TODO/FIXME/HACK comments tracked? List all of them.
- **Design specs review**: The `docs/` directory contains design specs for cold-start overlay, proactive prebuffer, and buffer timing. Review these for:
  - Security-relevant design decisions that were made but not implemented
  - Assumptions about Telegram API behavior that may have changed
  - Performance claims that should be validated against actual behavior
  - Any documented known issues that are still open

---

## 5. CONFIGURATION & DEPLOYMENT

### 5.1 Build Configuration

- Is the Vite config optimized for production? (minification, tree-shaking, source maps in prod?)
- Is TypeScript strict mode enabled? Check `tsconfig.json`.
- Are there any debug-only features that ship in production builds?

### 5.2 Tauri Configuration

- Is `createUpdaterArtifacts: true` correct? Does it cause unnecessary build time?
- Bundle targets: `"all"` — is this needed, or should it be platform-specific?
- Is the app identifier (`com.istiaq.nobuf`) consistent across all config files?

### 5.3 Environment

- Are there hardcoded API keys, test credentials, or development URLs in the source?
- Is `localhost:1420` (dev server) referenced in production config?
- Are there any `console.log` statements that should be stripped in production?

---

## 6. ACCESSIBILITY & UX EDGE CASES

- Are all interactive elements keyboard-accessible? (Tab navigation, Enter/Space activation)
- Do modals trap focus and restore it on close?
- Are file operations (delete, move) confirmed with dialogs that can't be dismissed by accident?
- What happens on very small windows? Does the layout break or scroll?
- Are loading states shown for all async operations?
- Are error states shown to the user, or do they fail silently?

---

## 7. RELEVANT SKILLS TO LOAD BEFORE AUDITING (MANDATORY)

This codebase has purpose-built Hermes skills that encode proven workflows, known pitfalls, verified APIs, and tested patterns. The auditor MUST load each skill below with `skill_view(name)` BEFORE auditing the corresponding section. These skills contain knowledge that would take multiple debugging sessions to rediscover — skipping them means missing known bugs and repeating past mistakes.

### Skill Mapping Table

| Audit Section | Skill Name | Why It's Needed | What It Provides |
|---|---|---|---|
| 1.1-1.3 Security (API, Tauri, CSP) | `qa-app` | Contains 30 test flows for NoBuf including REST API auth tests, CORS, API key verification, and all endpoint coverage | Exact curl commands for testing auth bypass, invalid keys, range requests, 404 handling, 503 states |
| 1.4 Telegram Session Security | `tauri-rust` | Documents session file handling, SQLite session recovery, and the 4-step IPC command registration process | Verified patterns for session corruption recovery, IPC surface audit checklist, command sync verification script |
| 1.5 Archive Extraction | `tauri-rust` | Contains verified crate APIs for `rar 0.4`, `sevenz-rust2 0.7`, `zip 2` — the actual working APIs, not docs assumptions | Correct method signatures, return types, and known API differences that caused 16+ compilation errors |
| 1.5 Archive Extraction | `qa-app` Flow 19 | Step-by-step archive viewer test: ZIP, RAR, 7z browse + extract + error cases | GUI verification that archive viewing works end-to-end |
| 1.8 IPC Command Surface | `tauri-rust` | Documents the 4-step command registration (define → invoke_handler → build.rs → capabilities) and the bidirectional sync check | The `verify-command-sync.sh` script that catches missing/mismatched commands between lib.rs, build.rs, and capabilities |
| 2.1-2.2 Stability (Panics, Locks) | `systematic-debugging` | 4-phase root cause methodology: understand before fixing, trace data flow, no guessing | Structured approach to identify if a panic is symptom or root cause, when to question architecture |
| 2.2 Concurrency | `video-streaming` | Documents FLOOD_PREMIUM_WAIT semaphore pattern — ALL download loops need semaphore+yield or they trigger server-side throttling | The exact semaphore acquire + yield_now pattern that prevents FLOOD_WAIT on 13MB+ files |
| 2.3 Resource Leaks | `tauri-rust` | References `windows-cache-cleanup.md` — three-layer defense for temp/cache cleanup on Windows, `remove_dir_all()` failure modes | Per-file retry pattern, startup orphan cleanup, all cache paths that need cleaning |
| 2.5 Frontend Stability | `react-performance` | React 19 patterns: StrictMode double-init cleanup, MSE SourceBuffer lifecycle, ref-vs-state decisions, TanStack Query config | The exact cleanup checklist for media/streaming useEffects (7 items including player.destroy, blob URL revoke, rAF cancel) |
| 2.5 Frontend Stability | `debug-tauri` | WebView2 MSE/MediaSource lifecycle diagnostics — mpegts.js timeouts, blob URL failures, MediaSource swap issues | Session-tested diagnostic checklist for streaming failures in WebView2 |
| 3.1 Streaming Pipeline | `video-streaming` | Full MSE/HLS streaming architecture: fMP4 thumbnail pipeline, TS transmuxing, prebuffer logic, keyframe-at timeout, linear fallback | Known pitfalls: thumbnailDataReady must be set for TS, proactive prebuffer DISABLED for TS, 5s timeout + linear byte_offset fallback |
| 3.2 Frontend Rendering | `react-performance` | Virtual list config (TanStack Virtual overscan 5-10), useMemo/useCallback patterns, staleTime/gcTime for TanStack Query, refetchOnWindowFocus:false for desktop | Exact patterns to check: inline style objects causing re-renders, useEffect with object deps causing infinite loops |
| 3.5 Rust Compilation | `codebase-inspection` | pygount-based LOC analysis for baseline code metrics | Language breakdown, code-vs-comment ratios, file counts — establishes quantitative baseline |
| 4.1-4.3 Code Quality | `simplify-code` | 3-reviewer parallel cleanup pattern: code reuse, code quality, efficiency — each with confidence/risk tiers | Structured approach: SAFE (auto-apply) vs CAREFUL (verify) vs RISKY (flag for review) classification |
| 4.1-4.3 Code Quality | `requesting-code-review` | Pre-commit verification pipeline: static security scan (secrets, injection, eval, SQL, deserialization), baseline tests, independent reviewer | The exact grep patterns for detecting hardcoded secrets, shell injection, eval/exec, unsafe deserialization, SQL injection in the diff |
| 1.1b Streaming Server | `video-streaming` | Streaming architecture, token auth, proxy patterns, FLOOD_WAIT | The streaming server token pattern, proxy timeout issues, buffer management |
| 1.1b Streaming Server | `telegram-grammers` | Download iterator API, file size gotchas, rate limiting patterns | The exact iter_download loop pattern, d.size() returns 0, skip_chunks for range access |
| 1.1b Streaming Server | `debug-tauri` | WebView2 custom protocol handler diagnostics | nobuf-stream:// proxy behavior, body buffering issues |
| 1.11 Custom Protocol | `debug-tauri` | Tauri custom URI scheme registration and proxy patterns | How custom protocols interact with WebView2 security model |
| 1.12 File Upload | `qa-app` Flow 9 + Flow 27 | Upload drag-drop and folder zip upload test flows | GUI verification that upload validation works |
| 1.13 Logging | `tauri-rust` | Documents what gets logged, env_logger setup, RUST_LOG | Log level configuration, sensitive data in log statements |
| 1.14 Library Sandboxing | `debug-tauri` | WebView2 security model, worker sandboxing, blob URL handling | How WebView2 isolates workers and handles blob: URLs |
| 1.15 Cross-Platform | `tauri-rust` | Platform-specific patterns, VPN detection across OS, ffmpeg-sidecar | Verified cross-platform code patterns, ffmpeg binary management |
| 2.3b Shutdown Ordering | `tauri-rust` | References windows-cache-cleanup.md with startup orphan cleanup and exit cleanup | The 8-step shutdown sequence, file lock handling, cache cleanup order |
| 2.3c Drag-and-Drop | `qa-app` Flow 9 | Upload flow includes drag-drop test | Verifies drag-drop works correctly and doesn't auto-upload without confirmation |
| 1.16 Telegram ToS | `tauri-rust` | Documents grammers client usage patterns, API ID handling, rate-limiting with FLOOD_WAIT | How the app interacts with Telegram API, known throttle patterns, account ban risk factors |
| 1.16 Telegram ToS | `telegram-grammers` | Documents FLOOD_PREMIUM_WAIT at ACCOUNT level, rate limiting architecture, session expiry handling | Account-level rate limiting, AuthKeyError handling, session expiry patterns |
| 1.17 SQLite Injection | `tauri-rust` | Documents sqlite 0.37 API (Statement::iter, Row indexing, Value enum) and verified query patterns | Correct parameterized query patterns, known API pitfalls that caused 4 compilation rounds |
| 1.18 Windows-Specific | `tauri-rust` | Windows-specific patterns: cache cleanup, file locking, ipconfig parsing, WebView2 quirks | remove_dir_all failure modes, FILE_SHARE_DELETE, ERROR_SHARING_VIOLATION handling |
| 1.19 Config Integrity | `tauri-rust` | Documents how api_settings.json and network_settings.json are loaded/saved | Settings load/save patterns, default fallback, file path resolution |
| 1.20 Data Privacy | `qa-app` | 30 test flows verify no unexpected network calls during normal operation | API endpoint inventory, exact curl commands to verify only Telegram + API server traffic |
| 1.21 Build Artifacts | `codebase-inspection` | LOC and file analysis can identify debug artifacts in production | File composition analysis, generated file detection |
| All security sections | `upstream-release-audit` | NoBuf is a fork of caamer20/Telegram-Drive — this skill has a verified gap analysis (nobuf-vs-telegram-drive-gaps.md) and upstream source verification (upstream-source-verification.md) documenting 12+ features and security fixes from upstream v1.0.0-v1.9.5 | Known upstream security patches and bug fixes that NoBuf may be missing — check if upstream has released security fixes post-divergence that haven't been adopted |
| 1.22 Upstream Divergence | `upstream-release-audit` | Directly maps to the upstream divergence audit section — has verified gap analysis and source verification references | The exact divergence point, 12+ feature gaps with verification evidence, upstream security state comparison |
| 2.3d IndexedDB | `indexeddb-offline` | IndexedDB patterns for offline-first storage — fragment caching, transaction handling, storage limits, eviction | FragmentStore pattern, hybrid memory+IndexedDB, storage management, common pitfalls (version changes, transaction scope, large blobs) |
| 3.1 Streaming Pipeline | `webview2-media` | THE definitive reference for video/audio playback in WebView2 — codec support, MSE bugs, HEVC licensing, GPU decode, TS→fMP4 pipeline | 16 specific TS→fMP4 pipeline bugs with fixes, MSE appendBuffer stall workarounds, SourceBuffer gap behavior, HEVC blank-screen issue, mpegts.js integration patterns |
| 3.1 Streaming Pipeline | `media-transmuxing` | THE definitive reference for the TS→fMP4 Rust backend pipeline — 51 specific pitfalls, 11 reference files, verified production patterns | Actix per-worker cache trap, TsStreamInfo caching, stateful demuxer cache, PTS gaps, SourceBuffer timestamp continuity, keyframe scan state across chunks, fMP4 segment size, mfhd sequence_number, overlap frame filtering, FFmpeg remux gotchas |
| 2.5 Frontend Stability | `webview2-media` | WebView2 MSE known bugs that affect stability — appendBuffer stalls, decoder stalls at gaps, window sizing breaks video | Bug list with status (open/closed), workarounds, and recommended mitigations for streaming stability |
| 4.1 Architecture | `codebase-architecture-research` | Systematic approach to understanding codebase internals by reading source code — tracing pipelines, identifying abstractions | Method for tracing data flow through the streaming pipeline, mapping component graphs, cross-referencing with search |
| All sections | `karpathy-guideline` | NoBuf-specific coding/auditing rules: no assumptions (>95% confidence), read full files before asking, trace to root cause, verify at runtime, never claim done without verification, deliver reports as HTML | 25 session-learned rules including FLOOD_PREMIUM_WAIT root cause, dead code path discovery, stale closure patterns, overlay/playback coupling, dual code path pitfalls, concurrency flag timing |
| 8.1-8.6 Fix Implementation | `subagent-driven-development` | 2-stage review process for implementing audit fixes: spec compliance review + code quality review per fix | Fresh subagent per fix, two-stage review, prevents context pollution, catches issues before they compound |
| 2.1-2.5 Stability | `systematic-debug` | NoBuf-specific debugging skill with TS/MSE/mpegts.js seek debugging references, UI-vs-backend state machine debugging, workflow preferences from sessions 100-110 | Worked examples of tracing data flow through the streaming pipeline, overlay-vs-playback decoupling, sparse keyframe index handling |
| 8.2 Regression Test Plan | `test-driven-development` | Defines the RED-GREEN-REFACTOR cycle that should govern how regression tests are written for every fix | Test-first methodology: write failing test → verify it fails → write minimal fix → verify it passes → refactor. Ensures regression tests actually test the right thing |
| 2.2 Concurrency | `telegram-grammers` | CRITICAL: rate limiter must be Mutex<u64> NOT AtomicU64 (races with 2 semaphore permits), DownloadPool bypass warning, 3-layer retry with exponential backoff | The exact semaphore + rate limiter + retry architecture that prevents FLOOD_WAIT across all download paths |
| 2.4 Error Handling | `telegram-grammers` | 3-layer retry pattern for FLOOD_WAIT: setup (3 retries, 5s→10s→20s), parallel (5 retries, 2s→4s→8s→16s→32s), sequential (5 retries, recreate iterator after each error) | The exact retry+backoff pattern that makes long-running Telegram download tasks resilient |
| 3.1 Streaming Pipeline | `telegram-grammers` | iter_download chunk iterator API, skip_chunks for range access, MAX_CHUNK_SIZE=512KB hard limit, file size extraction from raw TL types | The verified download loop pattern, d.size() returns 0 gotcha, chunk size constraints |
| 8.1-8.6 Functional Safety | `qa` + `qa-app` | 30 test flows covering EVERY user flow in the app: auth, file ops, streaming, archive, folders, settings, themes, network, API | The actual test steps that verify each feature works — these become the regression test plan for every finding |
| 8.1-8.6 Functional Safety | `tauri-rust` | Known UI pitfalls that caused user frustration: collapsed sidebar alignment, group chip design, CSS grid failure in Tauri, scrollbar shrink-0, native select prohibition | The exact patterns that MUST be preserved — any fix that violates these will break the UI the user explicitly approved |
| All sections | `skillspector` | Static security scanner (68 patterns, 17 categories) that can scan the entire codebase for vulnerabilities | Risk score 0-100, SAFE/CAUTION/DO NOT INSTALL recommendation, SARIF output for CI integration |
| All security sections | `anthropic-cybersecurity-skills` | 817 professional security playbooks across 29 domains (SSRF, path traversal, zip bombs, CORS exploitation, API security, session hijacking, supply chain) | Search for specific attack patterns matching NoBuf's architecture: `python scripts/search_skills.py /tmp/Anthropic-Cybersecurity-Skills "SSRF"` or `"path traversal"` or `"CORS"` or `"API security"` — each result is a structured workflow with real commands mapped to MITRE ATT&CK / NIST CSF |
| 6. Accessibility | `dogfood` | Browser-based exploratory QA with screenshots, console error detection, and structured bug reporting | Systematic 5-phase QA workflow: plan → explore → collect evidence → categorize → report. Useful for accessibility edge cases and visual regression |

### How to Use Skills During the Audit

1. BEFORE starting each audit section, load the mapped skill(s) with `skill_view(name)`.
2. Read the skill's pitfalls, known issues, and verified patterns.
3. Cross-reference the skill's knowledge against the code you're auditing.
4. When writing a fix recommendation, check if the skill already documents the correct pattern — use it.
5. When writing a regression test plan (Section 8.2), check if `qa-app` already has a test flow for that feature — reference it directly.
6. When classifying fix safety (Section 8.3), check if `tauri-rust` documents the pattern as a known pitfall — if so, the fix is likely MEDIUM or HIGH risk because downstream code depends on the existing behavior.
7. Run `skillspector scan ./src-tauri/src/ --no-llm` and `skillspector scan ./src/ --no-llm` for automated security pattern detection as a complement to manual review.
8. Run the command sync verification script from `tauri-rust` (`scripts/verify-command-sync.sh`) to catch any IPC commands that are registered in one place but missing from another.
9. For specific security attack patterns, clone and search the cybersecurity skills library: `git clone --depth 1 https://github.com/mukul975/Anthropic-Cybersecurity-Skills.git /tmp/Anthropic-Cybersecurity-Skills` then `python scripts/search_skills.py /tmp/Anthropic-Cybersecurity-Skills "SSRF"` (or "path traversal", "CORS", "API security", "session hijacking", "supply chain"). Load matching playbooks for professional attack workflows mapped to MITRE ATT&CK.
10. For accessibility and visual edge cases, use the `dogfood` skill's 5-phase browser QA workflow to navigate the app, capture screenshots, detect console errors, and produce structured bug reports.
11. For upstream divergence analysis, load `upstream-release-audit` skill and read `references/nobuf-vs-telegram-drive-gaps.md` — check if upstream has released security fixes that NoBuf hasn't adopted.
12. When writing regression tests (Section 8.2), follow the `test-driven-development` skill's RED-GREEN-REFACTOR cycle: write the failing test first, verify it fails, write the minimal fix, verify it passes. Tests written after the fix prove nothing.
13. Load `karpathy-guideline` BEFORE starting the audit — it contains NoBuf-specific rules that govern the entire audit process: no assumptions (>95% confidence), read full files before assessing, trace to root cause, verify at runtime, never claim done without verification, and deliver the final report as a self-contained HTML file.
14. For the TS→fMP4 backend pipeline (server.rs, ts_demux.rs, fmp4.rs), load `media-transmuxing` — it has 51 specific pitfalls including the Actix per-worker cache trap, TsStreamInfo caching, stateful demuxer cache, and overlap frame filtering. These are the most common production bugs in NoBuf's streaming backend.

### Skill-Provided Baseline Knowledge

The following are ALREADY KNOWN issues/patterns documented in skills — the auditor should verify they're still handled correctly, not discover them from scratch:

- **FLOOD_PREMIUM_WAIT**: All `iter_download` loops need `download_semaphore.acquire().await` + `tokio::task::yield_now().await` per chunk. Check every download loop in `fs.rs`, `archive.rs`, `streaming.rs`, `server.rs`.
- **Session corruption recovery**: `auth.rs` deletes and recreates `telegram.session` + WAL/SHM files on corruption. Verify this path still works.
- **Runner lifecycle**: Old runner must be shut down before spawning a new one to prevent stack overflow. Verify `runner_shutdown` oneshot + 100ms sleep pattern.
- **Command 4-step registration**: Every `#[tauri::command]` must be in: (1) function definition, (2) `lib.rs` invoke_handler, (3) `build.rs` commands array, (4) `capabilities/default.json` permissions. Run the sync check.
- **VPN detection**: Must check media state (IP assigned vs "Media disconnected"), not just adapter name. CloudflareWARP = VPN. NordVPN adapter persists even when disconnected.
- **CSS grid fails in Tauri**: Use CSS columns (masonry) instead. Check Settings page.
- **Native `<select>` prohibited**: Styled toggle buttons only. Check all settings controls.
- **Sidebar collapsed alignment**: All elements left-aligned `px-4`, `w-8 h-8` — NOT centered. User explicitly rejected centering.
- **Group chip design**: Active = full color + white text. Inactive = transparent + gray border + colored dot only. No border-2, scale-105, or colored boxShadow.
- **TS streaming pitfalls**: `thumbnailDataReady` must be set for TS. Proactive prebuffer DISABLED for TS. Keyframe-at fetch needs 5s timeout + linear fallback.
- **MSE cleanup checklist**: 7 items — clearTimeout/Interval, removeEventListener (via refs), cancelAnimationFrame, player.detachMediaElement→unload→destroy, fetch interceptor uninstall, cancelledRef, revoke blob URLs.
- **Duplicate command registration**: `cmd_rename_folder` and `cmd_start_auto_sync` are registered TWICE in `generate_handler![]` (lib.rs lines 402/422 and 403/423). Verify whether this causes runtime conflicts or is silently ignored by Tauri.
- **Command sync mismatch**: `cmd_get_cache_total_size` is in `lib.rs` invoke_handler but NOT in `build.rs` commands array. This may cause a build panic after `cargo clean`. Run the sync verification script to find ALL mismatches.
- **CORS fully open**: The API server uses `allow_any_origin()` + `allow_any_method()` + `allow_any_header()`. Combined with 127.0.0.1 binding, any local website can access the API. This is a known state — the auditor should assess exploitability and recommend a fix, not discover it from scratch.
- **Custom protocol proxy OOM risk**: `handle_nobuf_stream_protocol` in lib.rs reads the FULL response body into a `Vec::new()` with no size limit. For large videos served via non-Range GET, this can cause OOM. Verify if this path is reachable and whether Chromium always sends Range requests in practice.
- **Rate limiter MUST be Mutex<u64> NOT AtomicU64**: With 2 semaphore permits, two callers can check/update the timestamp simultaneously (race condition). The Mutex makes the check-sleep-store sequence atomic. Verify `TelegramState.rate_limiter` is `tokio::sync::Mutex<u64>`.
- **DownloadPool bypass**: DownloadPool has 3 workers with separate TCP connections that DON'T go through `download_semaphore`. Using DownloadPool for streaming/keyframe operations causes 3+ concurrent Telegram requests = FLOOD_WAIT. Verify `download_and_cache_range` uses the MAIN CLIENT with `acquire().await`, NOT DownloadPool.
- **3-layer retry with exponential backoff**: grammers' `iter_download` returns `Err(InvocationError)` on FLOOD_WAIT. If the caller uses `?`, the ENTIRE download task dies permanently. Verify all long-running download tasks have retry+backoff: setup (3 retries, 5s→10s→20s), parallel (5 retries, 2s→4s→8s→16s→32s), sequential (5 retries, recreate iterator after each error).
- **`d.size()` returns 0**: grammers' Document.size() often returns 0. File size must be extracted from raw TL types (`grammers_tl_types::enums::Message` → `msg.media` → extract from TL structure). Verify all file size extraction uses raw TL, not `d.size()`.
- **`.offset()` does NOT exist**: grammers uses `skip_chunks(n)` for range access, not `.offset()`. Verify no code uses a non-existent `.offset()` method.
- **FMP4-META tail download**: The tail download (last 512KB) is CRITICAL for PTS duration. Without it, duration stays at 4Mbps estimate, causing ALL linear byte estimates to be 27% too high and seeks to land 262s off target. Verify the tail download uses blocking `acquire().await`.
- **Proactive yield after seek**: When a seek fires, proactive and `/stream` share the rate limiter 50/50. Fix: proactive sleeps 5s after detecting a playhead jump. CRITICAL: gate the yield with a `jumped: bool` flag — without it, the yield fires on initial startup and sequential gap completion, crippling prebuffer speed.
- **Background keyframe timer debounce**: Without `clearTimeout(bgKeyframeTimerRef.current)`, each seek sets its own 5s timer → 6 concurrent backend searches → 7 consumers sharing the rate limiter. Verify the timer is cleared before setting a new one.
- **Upstream divergence**: NoBuf forked from caamer20/Telegram-Drive. The `upstream-release-audit` skill has a verified gap analysis at `references/nobuf-vs-telegram-drive-gaps.md` covering 12+ features from upstream v1.0.0-v1.9.5. Check if any upstream security fixes or bug fixes post-divergence have NOT been adopted.
- **Upstream known security state**: Upstream had timing-unsafe API key comparison (fixed in NoBuf with constant_time_eq), missing filename sanitization (NOT in upstream Rust either), and offset_id pagination issues. The `upstream-source-verification.md` reference has verified source-level details for 12 features.
- **IndexedDB fragment store**: NoBuf uses IndexedDB via `FragmentStore.ts` for video fragment caching. Verify: `navigator.storage.persist()` is called, transactions handle errors, schema migration via `onupgradeneeded` is present, and storage limits are checked before writing.
- **WebView2 MSE appendBuffer stalls**: WebView2 shares the Chromium GPU process with the host app, amplifying ChunkDemuxer lock contention. Keep `maxBufferLength` ≤ 30s, use fMP4 (not TS) where possible, split segments ≤ 16MB, call `remove()` proactively before appending.
- **WebView2 SourceBuffer gaps**: If consecutive fMP4 segments have timestamp discontinuities (even 0.5s gaps), the video decoder stalls at the gap boundary. Verify all segment timestamps are continuous — no overlap frames, no PTS gaps.
- **WebView2 HEVC blank-screen**: HEVC/H.265 can show blank screen (audio OK, no video) on Windows Pro/Enterprise even with HEVC Video Extensions installed (bug #4285). Verify if NoBuf has HEVC fallback to H.264.
- **mpegts.js autoCleanupSourceBuffer**: NEVER modify `autoCleanupMaxBackwardDuration` at runtime — mpegts.js computes `removeEnd = currentTime - value` which is NEGATIVE when `ct < value`, causing `sb.remove(0, -239)` crash on every append.
- **Actix per-worker cache trap (CRITICAL)**: `HttpServer::new(move || { ... })` runs its closure once per worker thread. Any `web::Data::new(...)` created INSIDE the closure is per-worker — NOT shared. If `fmp4_init` on Worker A populates a cache, `fmp4_segment` on Worker B finds an empty cache → 500 error. ALL shared caches (Fmp4StreamInfoCache, Fmp4InitCache, Fmp4MetadataCache, Fmp4KeyframeCache) MUST be created OUTSIDE the `HttpServer::new` closure in `start_streaming_server()`.
- **TsStreamInfo caching (CRITICAL)**: `extract_stream_info()` only works on data starting at byte 0 (where PAT/PMT exist). Mid-stream reads have no PAT/PMT → returns None → 500 error on every segment after the first. Verify `Fmp4StreamInfoCache` is populated in `fmp4_init` and looked up in `fmp4_segment`.
- **Stateful demuxer cache for sequential playback**: The TsDemuxer must preserve `pes_buffers` across HTTP requests for sequential playback. `take_frames()` only — NEVER call `flush()` on cached demuxers (destroys PES assembly state). Only cache for `align=none` sequential playback, never for seeks/thumbnails.
- **Keyframe scan state across chunks**: `scan_keyframes()` creates fresh `pes_buffers` per invocation — PES packets spanning chunk boundaries are lost. Verify `KeyframeScanState` struct with persistent `pes_buffers` is used for chunked scanning.
- **fMP4 segment overlap frame filtering**: Overlap region (256KB before start_offset) captures P-frames from previous segment. Including them produces duplicate PTS → Chrome MSE creates gaps → decoder stalls. Verify frames are filtered: `frames.filter(|f| f.pts >= kf_pts)`.
- **FFmpeg remux gotchas**: (1) ID3 tag streams crash the MP4 muxer — use `-map 0:v:0 -map 0:a:0` not `-map 0:a`. (2) ADTS AAC bitstream filter is mandatory: `-bsf:a aac_adtstoasc`. (3) Use `+faststart` not `empty_moov` for VOD. (4) `probesize` must match between ffprobe and ffmpeg.

---

## 8. FUNCTIONAL SAFETY & NON-REGRESSION (MANDATORY FOR EVERY FINDING)

Every finding in this report MUST include a functional-safety assessment. A fix that breaks the app is worse than the bug it fixes. This section defines the required analysis — the auditor must fill it in per-finding, not skip it.

### 8.1 Blast Radius Analysis (per finding)

For every recommended fix, the auditor must answer:

1. **Affected components**: Which files, modules, and features does this fix touch? Trace the dependency graph — does the change ripple into other modules via shared state, IPC commands, API endpoints, or event emitters?
2. **Affected user flows**: Which end-user workflows depend on this code path? Enumerate them:
   - File upload (drag-drop, URL upload, folder upload)
   - File download (single, batch, resume)
   - Video streaming (MSE/fMP4, HLS, direct play, TS transmuxing)
   - Archive viewing (zip, rar, 7z — browse + extract)
   - Folder management (create, rename, delete, move, grouping)
   - Authentication (QR login, phone+password, logout, session recovery)
   - API server (all REST endpoints, key auth, CORS)
   - Settings (network, API, theme, cache management)
   - Auto-update (check, download, verify, install, restart)
   - Cache (stream cache, background caching, cache cleanup)
3. **Break risk**: Can the fix change behavior that downstream code or users rely on? Specifically:
   - Does it change the type, shape, or timing of data returned by a command/endpoint?
   - Does it add a new error case that callers don't handle?
   - Does it remove or rename a function, field, or event that the frontend listens for?
   - Does it change lock semantics (adding/removing locks, changing lock scope)?
   - Does it alter the CSP, capability permissions, or IPC surface in a way that could break existing features?
   - Does it change file paths, env vars, or config keys that existing installations depend on?

### 8.2 Regression Test Plan (per finding)

For every fix, the auditor must provide:

1. **Existing tests to run**: Which of the current Vitest/Rust tests cover this code path? List them. If none exist, say "NO EXISTING COVERAGE — high regression risk."
2. **New tests to write**: What test(s) should be added BEFORE applying the fix to lock in current behavior? Provide the test structure:
   ```
   Test name: <descriptive name>
   File: <where to add it>
   Setup: <preconditions, mocks, fixtures>
   Steps: <exact actions>
   Expected: <assertion — what must still work after the fix>
   ```
3. **Manual verification steps**: Step-by-step manual test that a developer can run to confirm the feature still works after the fix:
   ```
   1. <action>
   2. <expected result>
   ...
   ```
4. **Rollback plan**: If the fix causes a regression in production, what's the fastest way to revert? Is it a single-file revert, or does it require coordinated changes?

### 8.3 Fix Safety Classification (per finding)

Classify every fix into one of:

- **SAFE (drop-in)**: Change is isolated, no downstream dependencies, no behavior change for valid inputs. Can be applied without test changes.
- **LOW RISK (additive)**: Adds validation, error handling, or guards without changing the happy path. Existing tests should still pass. Run existing tests to confirm.
- **MEDIUM RISK (behavioral)**: Changes return types, error messages, lock scope, or event timing. Existing tests may need updates. Requires manual verification of affected user flows.
- **HIGH RISK (architectural)**: Changes IPC surface, CSP, capabilities, session handling, or streaming pipeline internals. Requires full regression test of all affected flows + new test coverage before merge.

The auditor must state the classification and justify it with the blast radius analysis from 8.1.

### 8.4 Feature Interaction Matrix

After all findings are documented, the auditor must produce a matrix showing which findings' fixes could interact with each other:

```
Finding A  →  Finding B   : INTERACTION (applying both could conflict because...)
Finding A  →  Finding C   : INDEPENDENT (no shared code path)
Finding B  →  Finding C   : INTERACTION (both modify server.rs lock discipline — apply sequentially, test between)
```

This prevents situations where two individually-correct fixes combine to break a feature.

### 8.5 Pre-Fix Baseline Checklist

Before ANY fix is applied, the auditor must verify the baseline:

- [ ] `npm run test` passes (Vitest)
- [ ] `cargo test` passes (Rust)
- [ ] `cargo build --release` compiles
- [ ] `npm run build` compiles (TypeScript + Vite)
- [ ] App launches and connects to Telegram
- [ ] A file can be uploaded and downloaded
- [ ] A video can be streamed end-to-end
- [ ] An archive can be browsed and extracted
- [ ] The API server starts and serves a file with API key auth

If any baseline check fails BEFORE fixes, document it as a pre-existing issue (not a regression).

### 8.6 Post-Fix Verification Checklist

After ALL recommended fixes are applied, the same checklist must pass:

- [ ] All baseline checks from 8.5 still pass
- [ ] All new tests from 8.2 pass
- [ ] No new compiler/lint warnings introduced
- [ ] No new `console.error` / panic messages in normal operation
- [ ] Streaming playback works for: MP4 (faststart), TS (transmuxed), HLS
- [ ] Archive extraction works for: .zip, .rar, .7z
- [ ] API server: auth rejects invalid key, accepts valid key, serves files
- [ ] Settings changes persist across restart
- [ ] Theme switching works without re-render glitches
- [ ] Folder create/rename/delete/move works
- [ ] Auto-update check runs without error

---

## OUTPUT FORMAT

Structure your report as:

```
# NoBuf Codebase Audit Report

## Executive Summary
[2-3 sentences: overall health, critical findings count, top 3 risks]

## Critical Findings
[Each finding: ID, title, file:line, description, PoC, fix, blast radius, regression test plan, fix safety class]

## High Findings
[Each finding: same fields as Critical]

## Medium Findings
[Each finding: same fields as Critical]

## Low / Info Findings
[Each finding: same fields as Critical]

## Performance Opportunities
[Ranked by impact, each with break-risk assessment]

## Feature Interaction Matrix
[From Section 8.4 — which fixes interact, which are independent]

## Pre-Fix Baseline Results
[Results of Section 8.5 checklist — pass/fail per item, pre-existing issues noted]

## Post-Fix Verification Checklist
[Section 8.6 — to be filled after fixes are applied]

## Recommendations
[Top 10 actions, ranked by priority, each tagged with its fix safety class]
```

Rules:
- Read every file. Do not skip files because they look unimportant.
- Cite exact file paths and line numbers.
- If you cannot determine something from the code, say "REQUIRES RUNTIME VERIFICATION" and explain what to test.
- Do not suggest generic fixes ("add rate limiting"). Show exactly where and how.
- Prioritize by real-world exploitability, not by theoretical severity.
- Include a dependency CVE check (run `cargo audit` and `npm audit` if available).
- MANDATORY: Every finding MUST include all Section 8 fields (blast radius, regression test plan, fix safety class). A finding without a functional-safety assessment is incomplete and must be rejected.
- MANDATORY: The Feature Interaction Matrix must be filled. Do not skip it — fixes that combine to break features are the #1 regression risk.
- MANDATORY: Pre-Fix Baseline Checklist must be run and results recorded before any fix recommendations are finalized. If the baseline fails, those are pre-existing bugs, not regressions.
- MANDATORY: NO ASSUMPTIONS. NO GUESSING. If you do not know something with certainty, you MUST research it — read the code, trace the data flow, run the test, load the skill, search the docs — until you are above 95% confident in your finding. A finding based on an assumption is not a finding, it is a guess. Guesses waste the user's time and erode trust. If after thorough research you still cannot reach 95% confidence, explicitly state: "CONFIDENCE: BELOW THRESHOLD — [what I found] / [what I could not verify] / [what would need to be tested]". Never present a guess as a finding. Never present an assumption as a fact. Every claim must trace to either: (a) a specific line of code you read, (b) a tool output you ran, (c) a skill document you loaded, or (d) a test result you observed. If it traces to none of these, it is an assumption — research it or remove it.
