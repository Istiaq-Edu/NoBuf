# Alternative Streaming Approaches for WebView2/Tauri

> Research on alternative approaches for streaming video in WebView2/Tauri that bypass
> the CSP/media-src "Media load rejected by URL safety check" issue, while maintaining
> full streaming capability (Range requests, progressive playback, seeking).

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current Architecture](#2-current-architecture)
3. [Approach 1: WebCodecs API](#3-approach-1-webcodecs-api)
4. [Approach 2: MSE Codec Fallback](#4-approach-2-mse-codec-fallback)
5. [Approach 3: WebView2 WebResourceRequested](#5-approach-3-webview2-webresourcerequested)
6. [Approach 4: Chromium AllowMediaFromSource / CSP Matching](#6-approach-4-chromium-allowmediafromsource--csp-matching)
7. [Approach 5: Direct http://localhost:14201](#7-approach-5-direct-httplocalhost14201)
8. [Approach 6: Creative Solutions](#8-approach-6-creative-solutions)
9. [Comparison Matrix](#9-comparison-matrix)
10. [Recommended Approach](#10-recommended-approach)
11. [References](#11-references)

---

## 1. Problem Statement

### The Core Issue

When a `<video>` element's `src` is set to a URL handled by the custom `nobuf-stream://` protocol (which maps to `http://nobuf-stream.localhost` on Windows via wry's `.localhost` workaround), Chromium's WebView2 rejects the media load with:

> **"Media load rejected by URL safety check"**

This is NOT a CSP violation — it's a separate Chromium security check (`IsSafeToLoadURL` / `AllowMediaFromSource`) that blocks certain URL schemes from being used as media sources. Even though the CSP `media-src` directive includes `nobuf-stream:* http://nobuf-stream.localhost`, the URL safety check operates independently of CSP and rejects the custom scheme URL.

### Current Workarounds and Their Limitations

1. **MSE (Media Source Extensions) player** — Works because MSE is governed by `connect-src` (not `media-src`), and fetch/XHR requests go through a different security path. However, MSE in standard Edge/Chromium does **not** support HEVC/H.265 codec, only H.264/AAC.

2. **Blob URL fallback** — Works because `blob:` URLs inherit the origin of the creating context (same-origin), bypassing the URL safety check. However, the Blob URL approach in `FastStreamPlayer.tsx` **downloads the entire file** before playback begins, eliminating progressive streaming, Range requests, and seeking.

### Requirements for a Solution

- **Progressive playback**: Start playing before the entire file is downloaded
- **Range request support**: The player must be able to request specific byte ranges for seeking
- **Seeking**: Users must be able to seek to any position in the video
- **HEVC/H.265 support**: Must work with HEVC content (Telegram-Drive's common use case)
- **WebView2 compatibility**: Must work in Microsoft Edge WebView2 (Chromium-based)

---

## 2. Current Architecture

### Streaming Server

- **Rust Actix server** on `127.0.0.1:14201` with full Range request support, progressive streaming, cache-first serving, and `ContinuationGuard` for background caching
- CSP configuration in `tauri.conf.json`: `"media-src 'self' blob: http://localhost:* nobuf-stream:* http://nobuf-stream.localhost"`

### Custom Protocol Handler

- `nobuf-stream://` registered via `register_asynchronous_uri_scheme_protocol` in `lib.rs`
- `handle_nobuf_stream_protocol` proxies requests to Actix server on `127.0.0.1:14201` using **ureq** (synchronous HTTP client)
- **Critical limitation**: The ureq-based proxy **buffers the entire response** before sending it to WebView2 — this means Range requests from the `<video>` element are not properly forwarded, and progressive streaming through the custom protocol is effectively broken

### Platform URL Mapping

- **Windows (WebView2)**: Custom scheme `nobuf-stream://` → wry maps to `http://nobuf-stream.localhost` using WebView2's virtual hostname mapping
- **macOS/Linux**: `nobuf-stream://localhost` (native custom scheme)

### Frontend Player (`FastStreamPlayer.tsx`)

- MSE player using Blob URL (governed by `connect-src`, bypasses safety check)
- Native `<video>` fallback using custom protocol URL (fails due to URL safety check)
- Blob URL fallback that downloads entire file (no progressive streaming)

---

## 3. Approach 1: WebCodecs API

### Overview

The WebCodecs API (`VideoDecoder`, `VideoEncoder`, `AudioDecoder`, `AudioEncoder`) provides low-level access to hardware-accelerated video/audio codecs from JavaScript. It allows decoding individual frames without going through the `<video>` element, bypassing media-src CSP and URL safety checks entirely.

### How It Would Work

1. Fetch video data using `fetch()` (governed by `connect-src`, which works in current CSP)
2. Parse the MP4 container in JavaScript (using `mp4box.js` or similar)
3. Extract individual coded frames (access units) from the container
4. Decode each frame using `VideoDecoder`
5. Render decoded frames to a `<canvas>` using `VideoFrame` + `canvas.getContext('2d').drawImage()`
6. Synchronize audio separately using `AudioDecoder` + Web Audio API

### HEVC/H.265 Support

**Critical limitation**: WebCodecs HEVC support depends on the browser's codec availability:

- **Standard Edge/Chromium**: HEVC hardware decoding requires either:
  - OS-level HEVC codec installed (Windows 10/11 may have it via hardware acceleration)
  - Custom Chromium build with HEVC patches (StaZhu/enable-chromium-hevc-hardware-decoding)
  - Commercial HEVC license (Microsoft includes HEVC support in Windows via hardware, but software decode requires paid codec extension)

- **WebView2**: Uses the system's Edge Chromium runtime. HEVC support status:
  - If the system has the "HEVC Video Extensions" installed from Microsoft Store ($0.99 or free from device manufacturer), hardware HEVC decoding works
  - Without the extension, HEVC is NOT supported in WebCodecs
  - `VideoDecoder.isConfigSupported({codec: 'hev1.1.6.L120.90', ...})` returns `{supported: false}` on systems without HEVC codec

- **H.264/AVC**: Fully supported in WebCodecs on all Chromium/Edge installations (Main and High profiles)

### Progressive Streaming & Seeking

WebCodecs itself is a frame-level API — it doesn't inherently support Range requests or progressive streaming. To implement seeking:

1. You must parse the MP4 container to build a sample-to-byte-offset mapping
2. Use `fetch()` with Range headers to request data from the seek position
3. Feed the downloaded access units to `VideoDecoder`
4. Handle keyframe alignment (must seek to nearest keyframe before the target position)

This is **complex but feasible** — essentially reimplementing what the `<video>` element does internally.

### Pros

- **Bypasses media-src CSP and URL safety check entirely** — uses `connect-src` (which already works)
- **Full control over decoding pipeline** — can choose codec, handle errors, control buffering
- **Hardware-accelerated decoding** when codec is available on the system
- **Progressive playback possible** with custom fetch + container parsing
- **Seeking possible** with MP4 sample table parsing + Range request fetching

### Cons

- **HEVC codec availability is unreliable** — depends on system extension, not guaranteed
- **Extremely complex to implement** — must reimplement MP4 demuxing, frame timing, audio sync, seeking logic
- **No native video controls** — must build custom player UI (play/pause, seek bar, volume, fullscreen)
- **Audio synchronization is difficult** — must separately decode audio and synchronize with video frames
- **Canvas rendering overhead** — rendering every frame to canvas is less efficient than native `<video>` rendering
- **Subtitle support** must be reimplemented manually
- **Performance risk** — JavaScript-based demuxing and frame scheduling may struggle with high-bitrate 4K HEVC content

### Feasibility Rating: ⚠️ Medium — Works for H.264, unreliable for HEVC, very complex

---

## 4. Approach 2: MSE Codec Fallback

### Overview

Media Source Extensions (MSE) allow JavaScript to construct media streams for the `<video>` element from individual segments. MSE is governed by `connect-src` in CSP (not `media-src`), and the `MediaSource` object is created in JavaScript (same-origin), so the URL safety check doesn't apply.

### How It Currently Works

`FastStreamPlayer.tsx` already uses MSE as the primary player:
1. Create `MediaSource` object
2. Attach to `<video>` via `video.src = URL.createObjectURL(mediaSource)`
3. Fetch video data using `fetch()` with Range headers
4. Append fetched segments to `SourceBuffer` via `sourceBuffer.appendBuffer(data)`
5. MSE handles decoding and rendering

### HEVC/H.265 MSE Support

**Critical limitation**: MSE does NOT support HEVC in standard Chromium/Edge:

- `MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L120.90"')` returns `false`
- `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')` returns `false`
- This is a hard limitation — Chromium's MSE implementation does not include HEVC demuxing/decoding even when the system has HEVC hardware support
- The `<video>` element CAN play HEVC directly (if system codec is available), but MSE explicitly does not support it

- **H.264/AVC MSE**: Fully supported. `MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001F"')` returns `true`

### Possible Enhancement: Hybrid MSE + Native `<video>`

A hybrid approach could work:
1. **For H.264 content**: Use MSE player (already works, governed by `connect-src`)
2. **For HEVC content**: Fall back to native `<video>` element with a URL that passes the URL safety check

The challenge is making HEVC native playback work — this requires solving the URL safety check problem (see Approach 5 and Recommended Approach).

### Progressive Streaming & Seeking

MSE inherently supports progressive streaming and seeking:
- Fetch segments progressively via `fetch()` with Range headers
- Append to `SourceBuffer` as they arrive
- Seeking: remove existing buffer ranges, fetch new segments from seek position, append

This works well for H.264 content. For HEVC, MSE simply cannot handle it.

### Pros

- **Already implemented and working** for H.264 content
- **Bypasses media-src CSP and URL safety check** — uses `connect-src`
- **Progressive streaming with Range requests** — fetch segments as needed
- **Seeking support** — remove + append buffer ranges
- **Native `<video>` controls** — MSE uses the standard video element

### Cons

- **HEVC/H.265 NOT supported** in MSE — hard limitation in standard Chromium/Edge
- **SourceBuffer append timing** must be carefully managed to avoid `QuotaExceededError`
- **Codec detection overhead** — must probe codec before deciding MSE vs. native
- **For HEVC, requires separate fallback** — must solve the URL safety check issue independently

### Feasibility Rating: ✅ High for H.264 — Already working; ❌ No for HEVC — MSE limitation

---

## 5. Approach 3: WebView2 WebResourceRequested

### Overview

WebView2 provides the `WebResourceRequested` event (via `AddWebResourceRequestedFilter`) that allows intercepting, modifying, or overriding HTTP requests before they reach the network. This could potentially:
1. Add CORS headers to streaming responses
2. Modify CSP headers on the page
3. Override responses entirely

### Tauri Integration

Tauri v2 provides `on_web_resource_request` handler (mapped to WebView2's `WebResourceRequested`):
- Can intercept requests matching specified URL filters
- Can modify request headers
- Can override responses entirely (provide custom response body + headers)

### Critical Limitation: Unsupported for Virtual Hostname URLs

**WebView2 documentation explicitly states** that `WebResourceRequested` does NOT work for:
- **Virtual hostname mapped URLs** (e.g., `http://nobuf-stream.localhost`)
- **Custom protocol `.localhost` URLs** (these are internally mapped via `SetVirtualHostNameToFolderMapping`)

The wry library uses WebView2's `SetVirtualHostNameToFolderMapping` to map custom scheme `.localhost` URLs. This means `http://nobuf-stream.localhost` URLs CANNOT be intercepted via `WebResourceRequested`.

### What CAN Be Intercepted

`WebResourceRequested` CAN intercept:
- **Regular HTTP/HTTPS URLs** — including `http://localhost:14201/stream/...`
- **`https://` URLs** to external servers
- This means we COULD intercept `http://localhost:14201` requests and modify their response headers

### Potential Use: Adding CORS Headers to Actix Responses

Even though `WebResourceRequested` can't intercept the `.localhost` virtual hostname, it could intercept `http://localhost:14201` directly:
1. Set filter for `http://localhost:14201/*`
2. When a request is intercepted, add CORS headers (`Access-Control-Allow-Origin: http://localhost:14200`)
3. Pass the request through to the Actix server

However, **CSP is set at the page level** (in the HTML meta tag or HTTP response headers for the page itself). Modifying CORS headers on the streaming server responses does NOT change the page's CSP policy. The `media-src` directive is evaluated against the page's CSP, not per-response headers.

### Potential Use: Modifying Page CSP

`WebResourceRequested` could intercept the initial page load (`http://localhost:14200/`) and modify the CSP header in the response. This could:
- Add `http://localhost:14201` explicitly to `media-src`
- Remove or modify restrictive CSP directives

**However**, Tauri's CSP is set in `tauri.conf.json` and injected via the Tauri runtime — it may not be modifiable via `WebResourceRequested` because the page content itself comes from the `tauri://` protocol (also a virtual hostname mapping).

### Pros

- **Can intercept regular HTTP URLs** like `http://localhost:14201`
- **Can add CORS headers** to streaming responses
- **Can modify response headers** for non-virtual-hostname URLs

### Cons

- **Cannot intercept `.localhost` virtual hostname URLs** — explicitly unsupported by WebView2
- **Cannot modify CSP for the page itself** — page content comes from virtual hostname (`tauri://localhost`)
- **CSP is page-level, not per-response** — modifying streaming server headers doesn't change CSP
- **Limited to specific headers** in Tauri's `on_web_resource_request` API — only CORS/COEP/COOP headers, not arbitrary CSP modifications

### Feasibility Rating: ❌ Low — Cannot solve the URL safety check or CSP issue for virtual hostname URLs

---

## 6. Approach 4: Chromium AllowMediaFromSource / CSP Matching

### Overview

Chromium's media loading pipeline has TWO separate security checks:

1. **CSP check** (`AllowMediaFromSource`): Checks the URL against the page's `media-src` CSP directive
2. **URL safety check** (`IsSafeToLoadURL`): A separate check that validates the URL scheme is "safe" for media loading

Even if CSP allows a URL in `media-src`, the URL safety check can still reject it. This is the root cause of our issue.

### CSP Matching Rules

Per the CSP specification (W3C):

- **`http://localhost:*`** matches any port on localhost: `http://localhost:14201`, `http://localhost:14200`, etc.
- **`http://localhost:14201`** (exact port) matches only that specific port
- **`http://localhost`** (no port) matches only the default port (80)
- **Wildcard `*` in host** (`http://*:14201`) matches any host on port 14201 — but NOT `localhost` specifically (localhost requires explicit mention or `*` without port restriction)

The current CSP `media-src 'self' blob: http://localhost:* nobuf-stream:* http://nobuf-stream.localhost` should match `http://localhost:14201` per CSP spec rules. If CSP matching is the issue, adding `http://localhost:14201` explicitly would be a safe fix.

### The URL Safety Check Problem

The URL safety check (`IsSafeToLoadURL`) is NOT governed by CSP. It's a Chromium-specific internal check that:

- **Allows**: `http://`, `https://`, `data:`, `blob:`, `file://` (with restrictions)
- **Blocks**: Custom/non-standard URL schemes that Chromium doesn't recognize as "safe" for media

For custom protocol `.localhost` URLs (`http://nobuf-stream.localhost`):
- These are mapped via WebView2's `SetVirtualHostNameToFolderMapping`
- Chromium's URL safety check may not recognize virtual hostname-mapped URLs as "safe" for media loading
- Even though the URL appears as `http://nobuf-stream.localhost` (an `http://` scheme URL), the internal routing goes through the custom protocol handler, which may cause the safety check to fail

### Potential Fix: Change URL Form

If the URL safety check is specifically blocking virtual-hostname-mapped URLs, using a **direct HTTP URL** (`http://localhost:14201/stream/...`) might pass the check because:
- It's a standard `http://` URL to a real server
- `localhost` is a well-known "safe" host in Chromium's security model
- The CSP `http://localhost:*` would match it

This is essentially Approach 5 (Direct localhost URL).

### Potential Fix: Modify Chromium Behavior

Since WebView2 uses the system's Edge Chromium runtime, we cannot modify Chromium's source code. However:

- **WebView2 environment options**: `--disable-web-security` flag can be set via WebView2 environment options, but this disables ALL security checks (CORS, CSP, etc.) — too dangerous for production
- **Custom WebView2 runtime**: Building a custom WebView2 runtime with modified `IsSafeToLoadURL` is theoretically possible but impractical (requires maintaining a custom Chromium build)

### Pros

- **Understanding the root cause** helps identify the right solution
- **CSP matching is correct** — `http://localhost:*` should match port 14201
- **URL safety check is the actual blocker** — CSP alone cannot solve this

### Cons

- **Cannot modify Chromium's URL safety check** without custom build
- **Cannot bypass URL safety check via CSP** — it's a separate check
- **The `.localhost` virtual hostname mapping** appears to trigger the URL safety check failure

### Feasibility Rating: 📊 Diagnostic — Understanding the problem is essential, but this approach alone doesn't solve it

---

## 7. Approach 5: Direct http://localhost:14201

### Overview

Instead of using the custom `nobuf-stream://` protocol (which maps to `http://nobuf-stream.localhost` and triggers the URL safety check), set the `<video>` src directly to `http://localhost:14201/stream/{token}/{message_id}/{filename}`.

### Why This Might Work

1. **Standard HTTP URL**: `http://localhost:14201` is a regular HTTP URL — Chromium's URL safety check should allow it (localhost is a "safe" host)
2. **CSP matching**: The current CSP `http://localhost:*` should match `http://localhost:14201` per CSP spec
3. **Same-network origin**: The app runs from `http://localhost:14200` — both are on localhost, though different ports make them cross-origin
4. **Actix server supports Range requests**: The server on port 14201 already handles Range requests, progressive streaming, and seeking correctly

### Cross-Origin Considerations

Since `http://localhost:14200` (app) and `http://localhost:14201` (streaming server) are different origins (different ports), the `<video>` element making requests to port 14201 is cross-origin. For the `<video>` element to work:

- **CORS headers**: The Actix server on port 14201 must include `Access-Control-Allow-Origin: http://localhost:14200` (or `*`) in its responses
- **Range request CORS**: For seeking to work with cross-origin Range requests, the server must also handle `Access-Control-Expose-Headers: Content-Range, Accept-Ranges` and `Access-Control-Allow-Headers: Range`
- **CSP media-src**: Must include `http://localhost:14201` (or `http://localhost:*` which is already present)

### CSP Port Matching: http://localhost:* vs Exact Port

Per CSP specification:

- **`http://localhost:*`** matches any port on localhost — this is a valid CSP host-source expression
- **However**, some older Chromium versions had bugs with wildcard port matching on localhost
- **Safer approach**: Add `http://localhost:14201` explicitly to `media-src` in addition to the wildcard

### Current Limitations

The custom protocol handler currently uses **ureq** (synchronous HTTP client) to proxy requests, which **buffers the entire response**. This means even if we fix the URL safety check, the custom protocol won't support progressive streaming.

But with direct `http://localhost:14201`, there's NO proxy — the `<video>` element connects directly to Actix, which:
- Properly handles Range requests
- Returns 206 Partial Content with Content-Range headers
- Supports progressive streaming (sends data as it downloads from Telegram)
- Supports seeking (new Range request on each seek)

### Security Considerations

- **Port 14201 is accessible to any localhost application** — other apps on the machine could access the streaming server
- **Token-based authentication** already protects the streaming endpoints (`/stream/{token}/...`)
- **CORS headers** should be restrictive: only allow `http://localhost:14200` origin, not `*`

### Implementation Changes Required

1. **Modify CSP**: Add `http://localhost:14201` explicitly to `media-src` in `tauri.conf.json`:
   ```json
   "media-src 'self' blob: http://localhost:* http://localhost:14201 nobuf-stream:* http://nobuf-stream.localhost"
   ```

2. **Add CORS headers** to Actix streaming server responses:
   ```
   Access-Control-Allow-Origin: http://localhost:14200
   Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length
   Access-Control-Allow-Headers: Range
   ```

3. **Modify frontend**: For native `<video>` fallback, use `http://localhost:14201/stream/...` instead of `http://nobuf-stream.localhost/stream/...`:
   ```typescript
   // Instead of:
   const videoUrl = `${videoStreamUrl}/stream/${token}/${messageId}/${filename}`;
   // Use:
   const videoUrl = `http://localhost:${STREAM_PORT}/stream/${token}/${messageId}/${filename}`;
   ```

4. **Handle CORS preflight**: For cross-origin Range requests, Chromium may send an OPTIONS preflight request. The Actix server must respond to OPTIONS with appropriate CORS headers.

5. **CSP connect-src**: Also add `http://localhost:14201` to `connect-src` if using `fetch()` for MSE player (currently the MSE player uses the custom protocol URL for fetch, which also should be changed).

### Pros

- **Should bypass URL safety check** — standard HTTP URL to localhost
- **No proxy buffering** — direct connection to Actix server, proper Range request handling
- **Progressive streaming** — Actix sends data progressively from Telegram upstream
- **Seeking** — Range requests work directly, no ureq buffering
- **HEVC support** — native `<video>` element with system codec (if available)
- **Minimal code changes** — primarily CSP config + CORS headers + frontend URL change
- **No custom protocol dependency** — removes the broken ureq-based proxy entirely

### Cons

- **Cross-origin** — requires CORS headers on streaming server
- **Security exposure** — port 14201 is accessible to all localhost apps (mitigated by token auth)
- **CORS preflight overhead** — OPTIONS requests add latency for cross-origin Range requests
- **Port dependency** — hardcoded port 14201; must be configurable if port changes
- **May need testing** — CSP wildcard port matching on localhost may have edge cases in some Chromium versions

### Feasibility Rating: ✅ High — Most promising approach, minimal changes, solves root cause

---

## 8. Approach 6: Creative Solutions

### 6a: srcObject / MediaStream

**Overview**: Use `navigator.mediaDevices.getUserMedia()` or create a `MediaStream` from fetched data and set `video.srcObject = mediaStream`.

**Problem**: `MediaStream` is designed for **live/real-time streams** (camera, microphone, WebRTC). It does NOT support:
- **Seeking**: No `currentTime` control beyond play/pause
- **playbackRate**: Cannot change playback speed
- **Duration**: Unknown — stream is "live"
- **Buffering**: No buffer management — frames arrive and are displayed or dropped

**Conclusion**: ❌ Not suitable for file-based progressive video playback with seeking.

### 6b: WebTransport

**Overview**: Use WebTransport API (QUIC-based) to stream video frames from the Rust backend.

**Problem**: WebTransport is designed for **low-latency real-time communication** (game streaming, video conferencing). It:
- Provides unordered, unreliable datagram delivery OR ordered, reliable stream delivery
- Does NOT provide HTTP Range request semantics
- Does NOT support seeking to a specific byte offset in a file
- Would require reimplementing the entire media pipeline in JavaScript

**Conclusion**: ❌ Not suitable for progressive file-based video playback with seeking.

### 6c: iframe Same-Origin

**Overview**: Create an iframe that loads a page from `http://localhost:14201`, which contains the `<video>` element. Since the iframe's page is same-origin with the streaming server, the video loads directly.

**Problem**: The iframe page at `http://localhost:14201` would need to:
- Serve its own HTML with appropriate CSP (no restrictive `media-src`)
- Handle the video playback within the iframe context
- Communicate play/pause/seek commands back to the parent window via `postMessage`

**Additional issues**:
- **Same CSP restrictions apply** — the parent page's CSP can restrict iframe content with `frame-src`
- **Cross-origin iframe** (14200 parent, 14201 iframe) — communication only via `postMessage`
- **Complex UI coordination** — video controls in iframe must sync with parent UI
- **Fullscreen** — iframe fullscreen requires `allowfullscreen` attribute and may not work reliably in WebView2
- **Responsive sizing** — iframe must be resized to match parent layout

**Conclusion**: ⚠️ Possible but adds significant complexity. Same-origin iframe would need its own CSP-free page, and cross-origin communication is cumbersome. Not recommended as primary approach.

### 6d: Service Worker Intercept

**Overview**: Register a Service Worker that intercepts `<video>` network requests and provides responses from the streaming server, creating synthetic `Response` objects.

**Problem**:
- **WebView2 supports Service Workers** (Chromium-based)
- Service Workers CAN intercept `fetch()` events
- **However**, `<video>` element media requests are NOT `fetch()` events — they go through Chromium's media pipeline, which is NOT interceptable by Service Workers
- Service Workers cannot intercept `<video>` src requests

**Conclusion**: ❌ Service Workers cannot intercept `<video>` media pipeline requests.

### 6e: ReadableStream + Video Element

**Overview**: Create a `ReadableStream` from fetched video data and pipe it to the `<video>` element.

**Problem**:
- The `<video>` element does NOT accept `ReadableStream` as input
- There's no standard API for piping a `ReadableStream` to a `<video>` element
- MSE is the closest equivalent (append data to `SourceBuffer`), which already works for H.264

**Conclusion**: ❌ Not a viable approach — no API support for piping streams to `<video>`.

### 6f: Custom Chromium Build / WebView2 Runtime Override

**Overview**: Build a custom Chromium or WebView2 runtime that modifies `IsSafeToLoadURL` to accept custom protocol URLs.

**Problem**:
- Requires maintaining a custom Chromium build (massive effort, ~40GB build)
- WebView2 uses the system Edge runtime — overriding it requires redistributing a custom runtime
- Security implications of modifying URL safety checks
- Update burden — every Edge update requires rebuilding

**Conclusion**: ❌ Impractical for a desktop application distributed to end users.

### 6g: Progressive Blob URL (Enhanced Blob Approach)

**Overview**: Instead of downloading the entire file before creating a Blob URL, progressively build a Blob from streamed data and update the `<video>` src as new data arrives.

**Problem**:
- **Blob URLs are immutable once created** — you cannot append data to an existing Blob
- Creating a new Blob URL each time more data arrives would require `video.src = URL.createObjectURL(newBlob)` which resets playback
- No seeking to un-downloaded portions (Blob must contain the full byte range)
- No Range request support (Blob is served from memory, not from a server)

**Alternative: Progressive Blob with MSE**: For H.264, this is essentially what MSE already does (fetch chunks → append to SourceBuffer). For HEVC, MSE doesn't support the codec.

**Conclusion**: ❌ Blob URLs are not suitable for progressive streaming with seeking.

---

## 9. Comparison Matrix

| Approach | HEVC Support | Progressive Streaming | Seeking | WebView2 Compat | Complexity | Feasibility |
|----------|-------------|----------------------|---------|-----------------|------------|-------------|
| **1. WebCodecs** | ⚠️ Unreliable (system codec) | ✅ Custom fetch+decode | ✅ With MP4 parsing | ✅ Available | 🔴 Very High | ⚠️ Medium |
| **2. MSE (existing)** | ❌ Not supported | ✅ Already working | ✅ Already working | ✅ Works | 🟢 Low (done) | ✅ High (H.264) |
| **3. WebResourceRequested** | — | — | — | ❌ Can't intercept .localhost | 🟡 Medium | ❌ Low |
| **4. CSP/URL Safety Fix** | — Diagnostic — | — | — | — | 🟢 Understanding | 📊 Diagnostic |
| **5. Direct localhost:14201** | ✅ Native codec | ✅ Direct to Actix | ✅ Range requests | ✅ Standard HTTP | 🟢 Low-Medium | ✅ **HIGH** |
| **6a. srcObject** | ❌ No seeking | ❌ Live only | ❌ None | ✅ Works | 🟢 Low | ❌ No |
| **6b. WebTransport** | ❌ Reimpl needed | ❌ Real-time only | ❌ No Range | ✅ Available | 🔴 Very High | ❌ No |
| **6c. iframe** | ✅ Possible | ✅ Possible | ⚠️ Complex | ⚠️ iframe issues | 🟡 High | ⚠️ Low |
| **6d. Service Worker** | — | — | — | ❌ Can't intercept video | 🟢 Low | ❌ No |
| **6e. ReadableStream** | — | — | — | ❌ No API | 🟢 Low | ❌ No |
| **6f. Custom Chromium** | ✅ Full | ✅ Full | ✅ Full | ✅ Custom build | 🔴 Extreme | ❌ No |
| **6g. Progressive Blob** | ❌ Immutable | ❌ Must download all | ❌ Limited | ✅ Works | 🟡 Medium | ❌ No |

---

## 10. Recommended Approach

### Primary Recommendation: Direct http://localhost:14201 (Approach 5)

**This is the most promising solution** — it addresses the root cause (URL safety check blocking custom protocol `.localhost` URLs) by using a standard HTTP URL that Chromium's safety check should accept.

### Implementation Plan

#### Step 1: Add CORS Middleware to Actix Streaming Server

Add CORS headers to all streaming server responses in `server.rs`:

```rust
// In the streaming server configuration
App::new()
    .wrap(
        actix_cors::Cors::default()
            .allowed_origin("http://localhost:14200")
            .allowed_origin("http://localhost:14201")  // for same-origin requests
            .allowed_methods(vec!["GET", "HEAD", "OPTIONS"])
            .allowed_headers(vec!["Range", "Accept-Ranges"])
            .expose_headers(vec!["Content-Range", "Accept-Ranges", "Content-Length"])
            .max_age(3600)
    )
```

#### Step 2: Update CSP in tauri.conf.json

Add `http://localhost:14201` explicitly to `media-src` and `connect-src`:

```json
{
  "security": {
    "csp": {
      "media-src": "'self' blob: http://localhost:* http://localhost:14201 nobuf-stream:* http://nobuf-stream.localhost",
      "connect-src": "'self' http://localhost:* http://localhost:14201 nobuf-stream:* http://nobuf-stream.localhost ipc: http://ipc.localhost"
    }
  }
}
```

#### Step 3: Update Frontend StreamConfig

In `commands/streaming.rs`, modify `cmd_get_stream_info` to return a direct HTTP URL for native `<video>` playback:

```rust
// For native <video> fallback (bypasses URL safety check)
pub fn video_native_url(&self) -> String {
    format!("http://localhost:{}", self.stream_port)
}

// Keep the custom protocol URL for MSE fetch (still works via connect-src)
pub fn video_base_url(&self) -> String {
    if cfg!(target_os = "windows") {
        "http://nobuf-stream.localhost".to_string()
    } else {
        "nobuf-stream://localhost".to_string()
    }
}
```

#### Step 4: Update FastStreamPlayer.tsx

Use the direct HTTP URL for native `<video>` fallback:

```typescript
// Native <video> fallback — use direct localhost URL
const nativeVideoUrl = `http://localhost:${streamPort}/stream/${token}/${messageId}/${filename}`;

// MSE fetch — can use either custom protocol or direct localhost
// (direct localhost is preferred for consistency)
const mseFetchUrl = `http://localhost:${streamPort}/stream/${token}/${messageId}/${filename}`;
```

#### Step 5: Handle Development Mode

In development mode, the Tauri dev server runs on a different port (typically 1420). Update CORS and CSP to handle both:

```json
"media-src": "'self' blob: http://localhost:* http://localhost:14201 http://localhost:1420"
```

#### Step 6: Test URL Safety Check Bypass

Test that `http://localhost:14201/stream/...` passes Chromium's URL safety check:
1. Create a `<video>` element with `src="http://localhost:14201/stream/..."` 
2. Verify the video loads without "Media load rejected by URL safety check" error
3. Verify Range requests work (seeking, progressive playback)
4. Verify CORS headers are present in streaming responses

### Secondary Recommendation: Enhanced MSE with Codec-Aware Fallback

For robustness, implement a codec-aware player selection strategy:

```typescript
async function selectPlayerStrategy(codec: string): PlayerStrategy {
  // 1. Check if MSE supports this codec
  if (MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`)) {
    return 'mse';  // MSE for H.264 and other supported codecs
  }
  
  // 2. Check if native <video> can play this codec
  const video = document.createElement('video');
  const canPlay = video.canPlayType(`video/mp4; codecs="${codec}"`);
  if (canPlay === 'probably' || canPlay === 'maybe') {
    return 'native-direct';  // Native <video> with direct localhost URL
  }
  
  // 3. Fall back to MSE with transcoding hint or blob download
  return 'mse-transcode';  // Last resort
}
```

### HEVC Handling Strategy

For HEVC content specifically:

1. **Primary**: Try native `<video>` with `http://localhost:14201` URL — if the system has HEVC codec support, this will work with full progressive streaming and seeking
2. **Fallback**: If HEVC native playback fails, fall back to MSE blob download (current behavior — downloads entire file but at least plays)
3. **Future enhancement**: Consider server-side transcoding of HEVC → H.264 for MSE playback (adds latency but enables progressive streaming for HEVC on systems without the codec)

### Why Not Other Approaches

- **WebCodecs**: Too complex, HEVC support unreliable, reimplements too much of the media pipeline
- **WebResourceRequested**: Can't intercept the URLs that matter (`.localhost` virtual hostname)
- **srcObject/WebTransport/iframe**: Fundamentally wrong tool for the job (live streaming, not file-based progressive playback)
- **Custom Chromium build**: Impractical for distributed application

---

## 11. References

### Chromium / WebView2
- [Chromium html_media_element.cc](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/core/html/html_media_element.cc) — Contains `AllowMediaFromSource` and `IsSafeToLoadURL` checks
- [Microsoft WebView2 WebResourceRequested](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_15) — Official API documentation, notes virtual hostname limitation
- [Microsoft WebView2 Working with Local Content](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content) — Virtual hostname mapping and custom protocol documentation
- [Tauri HTTP Headers Documentation](https://v2.tauri.app/reference/config/#httpheaders) — Limited to CORS/COEP/COOP headers

### WebCodecs
- [WebCodecs API Specification](https://w3c.github.io/webcodecs/) — W3C working draft
- [StaZhu/enable-chromium-hevc-hardware-decoding](https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding) — HEVC support in Chromium, hardware/software decoding requirements
- [StaZhu DeepWiki](https://deepwiki.com/StaZhu/enable-chromium-hevc-hardware-decoding) — Comprehensive overview of HEVC support requirements, codec availability, WebCodecs integration

### MSE / Media Source Extensions
- [W3C Media Source Extensions](https://www.w3.org/TR/media-source/) — Official specification
- [Chromium MSE codec support](https://source.chromium.org/chromium/chromium/src/+/main:media/capabilities/webrtc_video_metrics_db.cc) — Supported codecs list
- [MDN MediaSource.isTypeSupported()](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/isTypeSupported) — Codec detection API

### CSP
- [W3C Content Security Policy Level 3](https://www.w3.org/TR/CSP3/) — Host-source matching rules, port wildcard specification
- [csplite.com CSP Rules](https://csplite.com/csp4/) — Detailed host-source matching rules with port number wildcards
- [MDN Content-Security-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy) — CSP directive reference

### Tauri / wry
- [wry Custom Protocols DeepWiki](https://deepwiki.com/tauri-apps/wry/4.1-custom-protocols) — Custom protocol implementation details, WebView2 `AddWebResourceRequestedFilter` usage
- [wry Media Streaming DeepWiki](https://deepwiki.com/tauri-apps/wry/5.5-media-streaming) — Range request support in custom protocols
- [Tauri v2 Configuration](https://v2.tauri.app/reference/config/) — CSP and security configuration

### Project Internal Research
- [Smart Download Strategy](./smart-download-strategy.md) — Download coordination, deduplication, seek handling
- [WebView2 URL Safety](./webview2-url-safety.md) — Existing research on the URL safety check issue
- [Browser Video Range Request Research](../../browser-video-range-request-research.md) — Chromium Range request behavior analysis
