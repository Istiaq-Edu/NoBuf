# Research: Same-Origin Actix Server (Serve Frontend + Streaming on One Port)

## Executive Summary

**Verdict: NOT RECOMMENDED — hybrid approach preferred**

Serving frontend static files from the Actix streaming server would achieve same-origin URLs and simplify CSP, but it carries significant drawbacks: losing Tauri's CSP nonce/hash injection (a critical security feature), losing Tauri's asset resolver, and adding substantial complexity for MIME types, caching, compression, and dev-mode compatibility. The current architecture with `tauri-plugin-localhost` + `nobuf-stream://` custom protocol is well-designed and already solves the cross-origin problem effectively.

A **hybrid approach** (keep localhost plugin, add reverse-proxy middleware to Actix for `/stream/` requests) is theoretically possible but also not recommended — it adds complexity without meaningful benefit since the `nobuf-stream://` protocol already works.

---

## 1. Current Architecture

### Port Layout
| Component | Port | Purpose |
|-----------|------|---------|
| Vite dev server | 1420 | Frontend in dev mode (`http://localhost:1420`) |
| `tauri-plugin-localhost` | 14200 | Frontend in production (`http://localhost:14200`) |
| Actix streaming server | 14201 | Media streaming (`http://localhost:14201`) |

### How It Works Today
- **Production**: `tauri-plugin-localhost` serves the `../dist` directory on port 14200. The WebView window loads `http://localhost:14200`. The streaming server runs on 14201. Since both are on `localhost`, they are "same-origin enough" for most operations, but cross-port media loading (`<video src="http://localhost:14201/...">`) fails WebView2's `IsSafeToLoadURL` check.
- **Custom protocol**: `nobuf-stream://` is registered as an asynchronous URI scheme protocol that proxies all requests to the Actix server on 127.0.0.1:14201. On Windows, WebView2 maps this to `http://nobuf-stream.localhost`, which works for `<video>` src attributes.
- **CSP**: The current CSP policy includes `http://localhost:*`, `nobuf-stream:*`, `http://nobuf-stream.localhost` to allow media loading from both the localhost plugin and the custom protocol.
- **Dev mode**: Vite serves on 1420, no localhost plugin needed. `cmd_get_stream_info` returns `base_url: "http://localhost:14201"` for fetch-based streaming and `video_base_url: "http://nobuf-stream.localhost"` (Windows) or `"nobuf-stream://localhost"` (macOS/Linux) for `<video>` src.

### Key Files
| File | Role |
|------|------|
| `lib.rs` | Sets up localhost plugin (prod only), Actix server startup, `nobuf-stream://` protocol, window URL |
| `server.rs` | Actix streaming routes (`/stream/{folder_id}/{message_id}`), HEAD endpoint, start_server() |
| `hls/manifest.rs` | HLS endpoints (hardcodes port 14201 in URLs — needs fixing regardless) |
| `faststart.rs` | FastStart moov-reordering endpoints |
| `api_routes.rs` | Separate API server (user-configurable port, separate Actix instance) |
| `commands/streaming.rs` | `StreamConfig`, `cmd_get_stream_info`, returns token + URLs to frontend |
| `tauri.conf.json` | CSP policy, build config (devUrl, frontendDist) |
| `Cargo.toml` | Dependencies: `actix-web = "4"`, `actix-cors = "0.7"`, `tauri-plugin-localhost = "2"` |

---

## 2. Proposed Same-Origin Architecture

### Concept
- Remove `tauri-plugin-localhost`
- Move Actix server to port 14200
- Add `actix-files` to serve the frontend `../dist` directory from Actix
- All routes (frontend + streaming) on one port → same-origin → CSP `'self'` passes

### Route Layout
```
http://localhost:14200/
  ├── /                    → frontend index.html (SPA fallback)
  ├── /assets/*            → frontend static assets (JS, CSS, images)
  ├── /stream/{fid}/{mid}  → streaming endpoint (existing)
  ├── /hls/*               → HLS endpoints (existing)
  ├── /faststart/*         → FastStart endpoints (existing)
  └── /* (fallback)        → frontend SPA fallback (index.html)
```

---

## 3. Actix Static File Serving Research

### Can actix-web serve static files?
**Yes.** The `actix-files` crate provides:

- **`Files::new("/static", "./dir")`** — serves a directory of files at a URL prefix
- **`NamedFile`** — serves individual files with configurable headers (ETag, Last-Modified, Content-Disposition)
- **SPA fallback** — `Files::default_handler()` can redirect unmatched paths to `index.html`
- **MIME types** — automatically detected from file extensions via the `mime` crate
- **Caching** — ETag and Last-Modified headers built-in, configurable via `use_etag()` and `use_last_modified()`
- **Compression** — works with Actix's `Compress` middleware for on-the-fly gzip/br encoding

### Required Crate
```toml
actix-files = "0.6"  # Not currently in Cargo.toml — must add
```

### Example Configuration
```rust
use actix_files as fs;
use actix_web::{App, HttpServer};

App::new()
    // Streaming routes FIRST (higher priority)
    .service(stream_media)
    .service(stream_media_head)
    .configure(hls::configure_hls)
    .configure(crate::faststart::configure_faststart)
    // Static files LAST (catch-all for frontend)
    .service(
        fs::Files::new("/", "../dist")
            .index_file("index.html")
            .default_handler(fs::NamedFile::open("../dist/index.html").unwrap())
    )
```

### Important Routing Consideration
Actix routes are matched in registration order. Custom routes (`/stream/`, `/hls/`) must be registered **before** the static file catch-all, otherwise `fs::Files` would intercept streaming requests as "file not found" and return 404.

---

## 4. Implementation Plan (Step-by-Step)

### Step 1: Add `actix-files` dependency
**File: `Cargo.toml`**
```toml
actix-files = "0.6"
```
Remove `tauri-plugin-localhost = "2"` from dependencies.

### Step 2: Modify `lib.rs`
- Remove the `#[cfg(not(debug_assertions))]` localhost plugin block
- Change `STREAM_PORT` from 14201 to 14200
- Remove `LOCALHOST_PLUGIN_PORT` constant
- Remove `.plugin(tauri_plugin_localhost::Builder::new(LOCALHOST_PLUGIN_PORT).build())`
- In production, window URL becomes `http://localhost:14200` (same port as Actix)
- In dev mode, window URL stays `http://localhost:1420` (Vite dev server)
- Remove `.register_asynchronous_uri_scheme_protocol("nobuf-stream", ...)` — no longer needed since everything is same-origin
- Remove `handle_nobuf_stream_protocol` function
- Remove `ureq` dependency (used only for nobuf-stream proxy)

### Step 3: Modify `server.rs` — Add static file serving
```rust
use actix_files as fs;

pub async fn start_streaming_server(
    port: u16,
    tg_state: Arc<TelegramState>,
    token: String,
    cache_mgr: Option<StreamCacheManager>,
    frontend_dir: Option<String>,  // NEW: path to dist directory
) -> std::io::Result<actix_web::dev::Server> {
    // ...
    let server = HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header();

        let app = App::new()
            .wrap(cors)
            .app_data(token_data.clone())
            .app_data(tg_data.clone())
            .app_data(cache_data.clone())
            // Streaming routes FIRST
            .service(stream_media)
            .service(stream_media_head)
            .configure(hls::configure_hls)
            .configure(crate::faststart::configure_faststart);

        // In production: serve frontend static files as fallback
        #[cfg(not(debug_assertions))]
        {
            let dir = frontend_dir.clone().unwrap_or("../dist".to_string());
            app.service(
                fs::Files::new("/", &dir)
                    .index_file("index.html")
                    .default_handler(fs::NamedFile::open(format!("{}/index.html", dir)).unwrap())
            )
        }

        #[cfg(debug_assertions)]
        { app }
    })
    .bind(("127.0.0.1", port))?
    .run();

    Ok(server)
}
```

### Step 4: Modify `commands/streaming.rs`
- `cmd_get_stream_info` no longer needs `video_base_url` (no custom protocol)
- `base_url` becomes same-origin: just relative paths like `/stream/{fid}/{mid}`
- Or keep `base_url` as `http://localhost:14200` for backward compat
- Remove Windows-specific `http://nobuf-stream.localhost` logic

### Step 5: Modify frontend components
- `MediaPlayer.tsx`, `FastStreamPlayer.tsx`, `PdfViewer.tsx`:
  - Remove `video_base_url` usage
  - Use same-origin URLs: `/stream/{fid}/{mid}?token={token}`
  - Remove Blob URL fallback (no more URL safety check errors)
  - Remove `nobuf-stream://` references

### Step 6: Modify `tauri.conf.json` CSP
**Current CSP:**
```
default-src 'self' http://localhost:* nobuf-stream:* http://nobuf-stream.localhost;
connect-src 'self' http://localhost:*;
media-src 'self' blob: http://localhost:* nobuf-stream:* http://nobuf-stream.localhost;
img-src 'self' data: blob: asset: https://asset.localhost;
style-src 'self' 'unsafe-inline';
script-src 'self';
worker-src 'self' blob:;
```

**Simplified CSP (same-origin):**
```
default-src 'self';
connect-src 'self';
media-src 'self' blob:;
img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline';
script-src 'self';
worker-src 'self' blob:;
```

Everything is same-origin, so `'self'` covers all URLs. No `http://localhost:*` needed, no `nobuf-stream:*` needed.

### Step 7: Fix `hls/manifest.rs` hardcoded port
Currently hardcodes `14201`:
```rust
let hls_base_url = format!("http://localhost:{}/hls/{}/{}", 14201, folder_id_str, message_id);
let stream_url = format!("http://localhost:{}/stream/{}/{}", 14201, folder_id_str, message_id);
```
Change to use `STREAM_PORT` constant or pass port dynamically. With same-origin, these can become relative URLs:
```rust
let hls_base_url = format!("/hls/{}/{}", folder_id_str, message_id);
let stream_url = format!("/stream/{}/{}", folder_id_str, message_id);
```

### Step 8: Handle dev mode
In dev mode (`cfg(debug_assertions)`), Actix does NOT serve frontend files — Vite dev server on 1420 does. The frontend fetches streaming data from `http://localhost:14200` (cross-origin in dev). This requires:
- Actix CORS middleware must allow `http://localhost:1420` origin in dev mode
- CSP in dev mode must still include `http://localhost:*`
- Frontend must use absolute URL `http://localhost:14200/stream/...` in dev mode
- Or: run Actix on 14201 in dev mode (no port change) and keep existing behavior

---

## 5. Drawbacks and Mitigations

### 5.1: Losing Tauri's CSP Nonce/Hash Injection ⚠️ CRITICAL

**Problem**: Tauri v2 automatically injects CSP nonces and script hashes into HTML responses at compile time:
- Script hashes: Tauri parses all frontend JS files and adds their SHA-256 hashes to `script-src`
- Style hashes: Same for CSS files
- This prevents XSS attacks — only the app's own scripts/styles can execute

When serving from Actix instead of Tauri's asset resolver, **this injection is completely lost**. The HTML file is served raw from disk with only the CSP from `tauri.conf.json` (which uses `script-src 'self'` — any script from the same origin can execute).

**Mitigation options**:
1. **Keep `'self'` for script-src** — weaker than hash-based CSP. Any file served from the same origin (including the streaming server's error responses if they contain HTML) could potentially execute scripts. In practice, the streaming server only returns binary data (video chunks) or plain text error messages, so this risk is minimal.
2. **Manual nonce injection** — Generate a nonce in Rust, inject it into the HTML file before serving, and add `script-src 'self' 'nonce-{VALUE}'` to the CSP header. This requires:
   - Reading and modifying HTML on every request (or caching the modified version)
   - Setting CSP headers on every Actix response
   - The nonce must be injected into every `<script>` tag and `<link>` tag
3. **Static hash-based CSP** — Compute hashes at build time and hardcode them in the CSP header. Requires a build step to hash all JS/CSS files.

**Assessment**: Mitigation option 1 (`'self'`) is acceptable for this app since:
- The app is a desktop app, not a web app exposed to the internet
- The streaming server only returns binary data, not HTML
- The only scripts that could execute are the app's own frontend JS
- The risk of script injection via the streaming server is negligible

However, this IS a downgrade from Tauri's hash-based CSP. For a security-conscious app, this matters.

### 5.2: Losing Tauri's Asset Resolver Features

**Problem**: Tauri's asset resolver provides:
- Custom protocol handler (`https://tauri.localhost` or `asset://`)
- CSP nonce/hash injection (see above)
- Proper MIME type detection for all asset types
- Efficient caching headers
- Integration with Tauri's IPC (invoke commands work via the custom protocol)

When serving from Actix, the WebView loads from `http://localhost:14200` — **Tauri's invoke IPC still works** because Tauri injects its IPC layer into the WebView regardless of the URL scheme. The IPC is not tied to the asset resolver.

**Mitigation**: No special mitigation needed for IPC — it still works. MIME types and caching are handled by `actix-files`.

### 5.3: Manual MIME Types, Caching, Compression

**Problem**: `actix-files` handles MIME types (via `mime` crate) and basic caching (ETag, Last-Modified). However:
- Tauri's asset resolver has deeper integration with the WebView
- `actix-files` doesn't do on-the-fly compression (needs `Compress` middleware)
- `actix-files` doesn't serve pre-compressed `.gz`/`.br` files automatically

**Mitigation**:
- Add `actix-web::middleware::Compress::default()` middleware for on-the-fly compression
- This is a minor concern — the frontend assets are small and loaded once at startup
- Streaming responses (video chunks) should NOT be compressed (they're already compressed video codecs)

**Risk**: Adding `Compress` middleware globally would also compress streaming responses, which is wasteful for video data. Solution: apply Compress only to static file routes, not streaming routes.

### 5.4: Security — Streaming Server Directly Accessible from Browser

**Problem**: Currently, the streaming server on 14201 is only accessible to the WebView via the `nobuf-stream://` custom protocol (which is only registered for the app's WebView). With same-origin on 14200, any browser on the machine can access `http://localhost:14200/stream/...` directly.

**Mitigation**:
- The streaming token already provides authentication — requests without the correct token get 403 Forbidden
- This is actually the same security posture as the current architecture: `http://localhost:14201` is also accessible from any browser on the machine (the port is bound to 127.0.0.1)
- The `nobuf-stream://` protocol doesn't add security — it's just a proxy to the same 14201 server
- **No change in security posture** — the token-based auth is the real security boundary

### 5.5: Development Mode Compatibility ⚠️ SIGNIFICANT

**Problem**: In dev mode, Vite serves on 1420, not from the Actix server. If Actix moves to 14200:
- Frontend on `http://localhost:1420` (Vite)
- Streaming on `http://localhost:14200` (Actix)
- Cross-origin requests in dev mode → need CORS headers on Actix for `localhost:1420`
- CSP in dev mode still needs `http://localhost:*`

**Current dev mode**: Frontend on 1420, streaming on 14201. Cross-origin, but CORS middleware already allows all origins. Same situation, just different port number.

**Mitigation**: No additional work needed — Actix CORS already allows any origin. The dev-mode CSP still needs `http://localhost:*`. The frontend just needs to know the correct streaming port.

**Alternatively**: Keep Actix on 14201 in dev mode (no port change) and only change to 14200 in production. But this means different URLs in dev vs prod, requiring conditional logic in the frontend.

### 5.6: Tauri Plugin Ecosystem Compatibility

**Problem**: Some Tauri plugins may expect the app to be loaded from Tauri's asset resolver (custom protocol). For example:
- `tauri-plugin-opener` — works regardless of URL scheme
- `tauri-plugin-shell` — works regardless of URL scheme
- `tauri-plugin-dialog` — works regardless of URL scheme
- `tauri-plugin-store` — works regardless of URL scheme

**Mitigation**: All commonly used plugins work with `http://localhost` URLs. No issues expected. The Tauri IPC layer (`invoke`) works independently of the URL scheme.

### 5.7: Frontend Build Output Path

**Problem**: `actix-files::Files::new("/", "../dist")` uses a relative path. The Actix server runs from the `src-tauri` directory (where the Rust binary is), so `../dist` resolves correctly. But:
- The path must be verified at runtime
- In dev mode, `../dist` may not exist or may be stale (Vite serves from memory)

**Mitigation**: Only use `actix-files` in production (`#[cfg(not(debug_assertions)]`). In dev mode, don't serve static files from Actix at all.

---

## 6. Hybrid Approach: Reverse Proxy via Actix

### Concept
Keep `tauri-plugin-localhost` on 14200 for frontend, but make Actix also bind to 14200 and proxy `/stream/` requests to itself. Wait — this doesn't make sense. Let me reframe:

**Alternative concept**: Keep the localhost plugin on 14200, but add Actix middleware that:
1. Serves streaming routes on 14200 (same port as localhost plugin)
2. Frontend requests hit the localhost plugin (Tauri's asset resolver)
3. Streaming requests hit Actix routes on the same port

**Problem**: This is impossible. `tauri-plugin-localhost` and Actix cannot both bind to the same port. They are separate HTTP servers.

**Alternative concept**: Make Actix bind to 14200, remove the localhost plugin, and have Actix serve both frontend and streaming. This is exactly the "same-origin approach" described above, with all its drawbacks.

**Alternative concept**: Reverse proxy — Actix binds to 14200 as a reverse proxy. Frontend requests are proxied to Tauri's asset resolver (which would need to be on a different internal port). Streaming requests are handled directly by Actix. But Tauri's asset resolver is internal to the WebView — it doesn't run as a separate HTTP server that can be proxied to.

**Alternative concept**: Use actix-web as a reverse proxy for dev mode. In dev mode, Vite runs on 1420. Actix could proxy `/` requests to Vite (for HMR) and handle `/stream/` requests directly. But this adds complexity for HMR WebSocket proxying, and dev mode already works fine.

**Assessment**: The hybrid approach doesn't offer meaningful benefits over the current architecture. The `nobuf-stream://` custom protocol already solves the cross-origin problem effectively. Adding reverse proxy logic adds complexity without solving any new problem.

---

## 7. CSP Changes Needed

### If Same-Origin Approach Is Adopted

**Production CSP** (simplified):
```
default-src 'self';
connect-src 'self';
media-src 'self' blob:;
img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline';
script-src 'self';
worker-src 'self' blob:;
```

**Dev mode CSP** (still needs localhost):
```
default-src 'self' http://localhost:*;
connect-src 'self' http://localhost:*;
media-src 'self' blob: http://localhost:*;
img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline';
script-src 'self';
worker-src 'self' blob:;
```

The CSP would need to be conditional (dev vs prod). Currently, a single CSP is used for both modes. Tauri allows CSP to differ between dev and prod via the `devPath` vs `distDir` configuration, but the CSP in `tauri.conf.json` applies to both.

### If Current Architecture Is Kept
No CSP changes needed — the current CSP already works.

---

## 8. Dev Mode Compatibility

### Same-Origin Approach in Dev Mode
- Vite serves frontend on `http://localhost:1420`
- Actix serves streaming on `http://localhost:14200`
- Cross-origin: fetch() from frontend to Actix works (CORS already enabled)
- `<video src="http://localhost:14200/...">` works in dev (same-origin not needed since WebView2 URL safety checks are relaxed in dev mode)
- CSP needs `http://localhost:*` in dev

### Frontend URL Logic
The frontend must detect dev vs prod mode and use different URL construction:
```typescript
// Dev mode: absolute URL with port
const streamUrl = `http://localhost:${port}/stream/${folderId}/${fileId}?token=${token}`;

// Prod mode: relative URL (same-origin)
const streamUrl = `/stream/${folderId}/${fileId}?token=${token}`;
```

Or just always use absolute URLs (`http://localhost:${port}/...`) for simplicity, since both work in both modes.

---

## 9. Complexity Comparison

| Aspect | Current Architecture | Same-Origin Approach |
|--------|---------------------|---------------------|
| **Ports** | 3 (1420/14200/14201) | 2 (1420 dev, 14200 prod) |
| **CSP** | Complex (localhost:* + nobuf-stream:*) | Simpler (just 'self' in prod) |
| **Security** | CSP nonce/hash injection by Tauri | `'self'` only (weaker CSP) |
| **Custom protocol** | `nobuf-stream://` + ureq proxy | Not needed |
| **Dependencies** | tauri-plugin-localhost, ureq | actix-files (new) |
| **Dev/prod consistency** | Different URL schemes (Windows vs macOS) | Same scheme (HTTP) everywhere |
| **Streaming URL safety** | Requires custom protocol workaround | Same-origin, no workaround needed |
| **MIME types** | Tauri handles automatically | actix-files handles (mime crate) |
| **Caching** | Tauri handles automatically | actix-files + Compress middleware |
| **Code complexity** | Moderate (custom protocol, ureq proxy) | Moderate (static file serving, conditional dev/prod) |
| **Blob URL fallback** | Needed for WebView2 safety check errors | Not needed |

---

## 10. Final Verdict

### NOT RECOMMENDED

The same-origin approach **solves one problem** (cross-origin media loading) but **creates several new problems**:

1. **Losing Tauri's CSP nonce/hash injection** is the most significant drawback. While `'self'` CSP is acceptable for a desktop app, it's a downgrade from hash-based CSP that prevents any injected scripts from executing.

2. **Dev mode complexity** — Different URL patterns for dev vs prod, conditional CSP, conditional static file serving.

3. **No meaningful simplification** — We'd remove `tauri-plugin-localhost` and `ureq` but add `actix-files` and more conditional logic. Net complexity is similar.

4. **The current architecture already works** — The `nobuf-stream://` custom protocol successfully bypasses WebView2's URL safety checks. The Blob URL fallback handles edge cases. The CORS middleware handles cross-origin fetch() requests.

5. **The hybrid approach (reverse proxy) adds complexity without benefit** — The `nobuf-stream://` protocol already serves the same purpose more cleanly.

### What Should Be Done Instead

1. **Fix the hardcoded port in `hls/manifest.rs`** — Replace `14201` with the `STREAM_PORT` constant or pass the port dynamically. This is a bug regardless of architecture.

2. **Consider removing the `nobuf-stream://` protocol's ureq dependency** — The protocol buffers the entire response body in memory (via ureq), which is wasteful for large video files. A streaming proxy approach or a different HTTP client could improve this. But this is a separate optimization task.

3. **Keep the current architecture** — It's well-designed and works correctly across dev/prod and Windows/macOS/Linux.

### If Same-Origin Is Still Desired

The implementation is feasible and the steps are clearly defined above. The main trade-off is accepting `'self'` CSP instead of Tauri's hash-based CSP. For a desktop app (not exposed to the internet), this is an acceptable trade-off. But the effort-to-benefit ratio is low — the current architecture already works.
