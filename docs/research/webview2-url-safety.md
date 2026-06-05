# WebView2 URL Safety Checks: `IsSafeToLoadURL`, Localhost, Custom Schemes & CSP

## Context

A Tauri v2 desktop app (NoBuf/Telegram-Drive) encounters **"Media load rejected by URL safety check"** errors in WebView2 when attempting to load video content from:
- `http://nobuf-stream.localhost/stream/...` (wry/tauri custom scheme mapped via `.localhost` subdomain)
- `http://localhost:14201/stream/...` (streaming server on a different port)

The page serving the `<video>` element is hosted at `http://localhost:14200`. The cross-origin nature of these requests (different port or different subdomain) triggers WebView2's URL safety checks, which block the media load.

This document compiles research into the exact mechanisms behind this error, related bugs and issues across WebView2, Chromium, and Tauri, and potential solutions.

---

## 1. What Is `IsSafeToLoadURL`?

### Chromium's media URL safety check

The error message "Media load rejected by URL safety check" originates from Chromium's media pipeline, specifically from the `IsSafeToLoadURL()` function (or its equivalent in the Blink rendering engine). This function is called before Chromium initiates a network request for media content (video, audio) and acts as a **gatekeeper** that decides whether the URL is "safe" to fetch.

The check evaluates several conditions:

1. **Mixed content restrictions**: If the page is in a secure context (HTTPS, or `.localhost` which Chromium treats as secure), loading media from a less-secure origin (plain HTTP to a different origin) may be blocked.
2. **Local Network Access (LNA) / Private Network Access (PNA) restrictions**: Cross-origin requests from a public (or treated-as-public) origin to a private/local network origin are blocked unless the target grants explicit permission via CORS preflight (`Access-Control-Allow-Private-Network: true`).
3. **CSP (Content Security Policy) enforcement**: If the page's CSP `media-src` directive does not permit the target origin, the load is rejected.
4. **Custom scheme handling**: URLs with non-standard schemes (e.g., `tauri://`, `wry://`, or `.localhost` subdomains) may be treated as opaque origins, which makes CSP and CORS checks more restrictive.

### Where the check lives in Chromium

The URL safety check for media loads is implemented in Blink's `MediaLoadRequest` class (previously `HTMLMediaElement`). The relevant logic:

- In Blink: `third_party/blink/renderer/core/html/media_load_request.cc` — the `IsSafeToLoadURL()` method checks mixed content, CSP, and LNA/PNA policies before allowing a `<video>` or `<audio>` element to fetch its source.
- In the network stack: `services/network/private_network_access_check.cc` — implements the PNA/LNA preflight check that determines whether a cross-origin request to a private/local IP is allowed.
- The error is surfaced in DevTools console as: `Media load rejected by URL safety check.` with a reference to the specific check that failed.

### How WebView2 differs from standalone Chrome

WebView2 is based on the same Chromium engine as Microsoft Edge, so all Chromium-originated security checks (mixed content, CSP, LNA/PNA) apply. However, WebView2 has some additional considerations:

- WebView2 **does not have a full browser UI or settings interface** for users to configure security policies — relying instead on the embedding application to set policies via `ICoreWebView2Settings` or enterprise policies.
- WebView2 **may enforce stricter defaults** for some checks, particularly around local/private network access, because it's designed as an embedded component where the host app is expected to handle security.
- WebView2 **does not expose all Chromium flags** directly — many internal Chromium flags (e.g., `--disable-features=PrivateNetworkAccessRespectPreflightResults`) cannot be easily passed through WebView2's API.

---

## 2. Local Network Access (LNA) / Private Network Access (PNA) — The Primary Suspect

### Overview of LNA/PNA

**Private Network Access (PNA)** (renamed to **Local Network Access (LNA)** in some Chromium docs) is a Chromium security feature that restricts web pages from accessing private/local network resources. The feature is being rolled out progressively in Chromium and, by extension, in WebView2.

**Key concept**: When a web page served from a "public" origin (or an origin treated as public) tries to make a request to a "private" or "local" origin, Chromium requires:
1. A **CORS preflight request** to the target origin
2. The target must respond with the header `Access-Control-Allow-Private-Network: true`
3. If the preflight fails or the header is missing, the request is **blocked**

### Origin classification in Chromium

Chromium classifies origins into three tiers based on their IP address:

| Tier | Examples | Description |
|------|----------|-------------|
| **Public** | Public internet IPs, `127.0.0.1` (in some contexts) | Any origin reachable from the internet |
| **Private** | `192.168.x.x`, `10.x.x.x`, `172.16-31.x.x` | RFC 1918 private IPs |
| **Local** | `127.0.0.1`, `localhost`, `[::1]` | Loopback / localhost addresses |

**Critical nuance**: `localhost` and `127.0.0.1` are classified as **local** tier, which is MORE restricted than private. A request from a "local" origin to another "local" origin on a **different port** is treated as a cross-origin request that may require PNA/LNA preflight checks.

### How this affects the Tauri app

In the NoBuf/Telegram-Drive app:
- The page is served from `http://localhost:14200` — classified as **local** tier
- The video stream is at `http://localhost:14201/stream/...` — also **local** tier, but on a **different port**, making it a **cross-origin** request
- The video stream at `http://nobuf-stream.localhost/stream/...` — `.localhost` is treated as a **secure context** by Chromium, and this subdomain is likely classified differently from `localhost:14200`

The LNA/PNA check sees these as cross-origin requests from one local origin to another local origin (or to an origin that may be classified differently), and **blocks the media load** if the appropriate CORS/PNA headers are not present or if the preflight fails.

### WebView2 LNA rollout announcement

**WebView2Announcements Issue #126** (February 2026): Microsoft announced that Chromium's Local Network Access restrictions are being rolled out in WebView2. This is a **breaking change** for apps that make cross-origin requests to local/private network resources.

Key points from the announcement:
- The feature restricts web content from accessing private/local network resources
- Requests from less-secure contexts to more-secure contexts are blocked
- CORS preflight with `Access-Control-Allow-Private-Network: true` is required for cross-origin local network access
- The rollout is progressive (starting in WebView2 Runtime v123+ and becoming stricter in later versions)

### WebView2Feedback #5456 — PNA blocking in v143

**WebView2Feedback Issue #5456**: Users reported that WebView2 v143.0.3650.66 **breaks requests from local origins to internal network APIs** due to the new PNA/LNA restrictions. This issue confirms that the LNA rollout is actively breaking real applications.

Affected scenarios:
- Local web apps accessing backend APIs on different ports
- WebView2 apps embedded in desktop software communicating with local services
- Tauri/Electron-style apps using localhost for IPC or asset serving

---

## 3. Custom Scheme Issues

### The `.localhost` TLD and secure context

Chromium treats the `.localhost` TLD as a **secure context** (similar to HTTPS). This is defined in the W3C spec: [Secure Contexts](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy).

**Implications for the Tauri app**:
- `http://nobuf-stream.localhost` is treated as a secure context (even though it's HTTP, not HTTPS)
- `http://localhost:14200` is also treated as a secure context
- However, they are **different origins** (different hostnames), so cross-origin checks still apply
- Loading media from `http://nobuf-stream.localhost` into a page at `http://localhost:14200` triggers both **CORS** and **LNA/PNA** checks
- If the page at `localhost:14200` has CSP `media-src` that doesn't include `http://nobuf-stream.localhost`, the load is also blocked by CSP

### WebView2Feedback #2850 — Custom schemes should avoid CSP

**WebView2Feedback Issue #2850**: Feature request for custom URL schemes to bypass CSP checks. Currently, custom schemes (like `tauri://` or `wry://`) are subject to CSP enforcement, which means the page's CSP must explicitly allow these schemes in `media-src`, `img-src`, etc. This creates friction for apps that use custom schemes for internal asset loading.

Status: Open, not yet implemented.

### WebView2Feedback #4379 — CSP blocking custom protocol calls (Tauri)

**WebView2Feedback Issue #4379**: CSP rules are blocking custom protocol calls in Tauri apps. When a Tauri app uses a custom scheme (e.g., `tauri://`) for IPC or asset loading, the CSP on the page may block these requests unless the scheme is explicitly allowed.

The issue highlights that WebView2's CSP enforcement on custom schemes is overly restrictive for embedded app scenarios where the custom scheme is a trusted, app-controlled mechanism.

### WebView2Feedback #4362 — WebResourceRequested not called from CSS with custom URI scheme

**WebView2Feedback Issue #4362**: The `WebResourceRequested` event (used by Tauri's wry layer to intercept custom scheme requests) is **not fired for CSS, font, and some media subresource requests** when the Origin header is `null` (which happens with custom/opaque schemes). This means:
- Custom scheme handlers cannot intercept and serve CSS/font resources
- Media loads via custom schemes may also bypass the handler
- The `null` origin from opaque schemes causes Chromium to skip the WebResourceRequested filter for certain resource types

This is particularly relevant because it means that even if the Tauri app registers a handler for `nobuf-stream.localhost`, some resource types (CSS fonts, potentially video segments) may not be intercepted by the handler, falling through to Chromium's default URL safety checks instead.

---

## 4. Tauri-Specific Issues

### Tauri #3725 — Video/audio loading as asset doesn't work

**Tauri Issue #3725**: Documents the problem of loading video/audio as assets in Tauri apps. The issue tracks the failure of `<video>` and `<audio>` elements to load content served through Tauri's custom scheme or asset protocol.

Key findings from this issue:
- Video/audio assets loaded via Tauri's asset protocol (`asset://` or `.localhost` mapped scheme) fail in WebView2
- The failure manifests as the "Media load rejected by URL safety check" error
- The issue is specific to WebView2 on Windows (Tauri uses WebView2 on Windows, WebKitGTK on Linux, and WKWebView on macOS)
- Workarounds discussed include using localhost HTTP servers instead of custom schemes, or using blob URLs

### Tauri's wry layer and `.localhost` mapping

Tauri's wry library (which wraps WebView2 on Windows) uses `.localhost` subdomain virtual host mapping to serve assets:
- `SetVirtualHostNameToFolderMapping` maps `http://<appname>.localhost/` to a local folder
- This provides a secure context for the app's UI
- However, when streaming video from a different `.localhost` subdomain or a different port, the cross-origin + LNA/PNA checks block the load

---

## 5. CSP Enforcement in WebView2

### How CSP affects media loading

When a page has a Content Security Policy, the `media-src` directive controls which origins can serve video and audio content. If the CSP does not include the target origin, the media load is rejected — and this rejection is surfaced as "Media load rejected by URL safety check."

Common CSP scenarios that block media:
1. `media-src 'self'` — only allows media from the same origin; blocks `localhost:14201` and `nobuf-stream.localhost`
2. `media-src 'self' http://localhost:*` — should allow any localhost port, but may not cover `.localhost` subdomains
3. Missing `media-src` directive — falls back to `default-src`, which may be restrictive

### Recommended CSP for the Tauri app

To allow video streaming from both origins, the CSP `media-src` directive should include:
```
media-src 'self' http://localhost:14201 http://nobuf-stream.localhost blob: data:;
```

Or more broadly:
```
media-src 'self' http://localhost:* http://*.localhost blob: data:;
```

Note: `http://localhost:*` wildcard port syntax may not be supported by all CSP parsers. Check CSP spec for exact wildcard rules.

---

## 6. Opt-Out and Mitigation Mechanisms

### Enterprise policy: `LocalNetworkAccessRestrictionsTemporaryOptOut`

**Microsoft Edge enterprise policy**: `LocalNetworkAccessRestrictionsTemporaryOptOut` allows applications to **opt out of LNA/PNA restrictions temporarily**. This policy can be set via:
- Registry key (for WebView2 embedded apps)
- Edge policy configuration

For WebView2 apps, the policy can be configured via registry:
```
HKLM\SOFTWARE\Policies\Microsoft\Edge\LocalNetworkAccessRestrictionsTemporaryOptOut = 1
```

or per-app:
```
HKLM\SOFTWARE\Policies\Microsoft\Edge\WebView2\<app-name>\LocalNetworkAccessRestrictionsTemporaryOptOut = 1
```

**Important caveats**:
- This is a **temporary** opt-out — Microsoft has indicated it will be removed in future versions
- It only works for enterprise-managed environments; consumer machines cannot set this policy
- It's not a viable long-term solution for distributed desktop apps

### Chromium flag: `--disable-features=PrivateNetworkAccessRespectPreflightResults`

This Chromium command-line flag disables PNA preflight enforcement. However:
- WebView2 **does not provide a direct API** to pass Chromium flags
- Some flags can be set via `ICoreWebView2EnvironmentOptions::AdditionalBrowserArguments`, but this is not guaranteed to work for all flags
- The flag may also be removed as LNA/PNA becomes fully enforced

### Proper CORS/PNA headers on the streaming server

The most robust long-term solution is to ensure the streaming server at `localhost:14201` and the `nobuf-stream.localhost` handler both respond with proper CORS and PNA headers:

For CORS:
```
Access-Control-Allow-Origin: http://localhost:14200
```

For PNA/LNA (on preflight OPTIONS responses):
```
Access-Control-Allow-Private-Network: true
Access-Control-Allow-Origin: http://localhost:14200
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Range
```

The streaming server must handle OPTIONS preflight requests and return these headers. This is the **recommended long-term fix** per Chromium's LNA specification.

### Same-origin streaming via blob URLs or MSE

An alternative approach that avoids cross-origin checks entirely:

1. **Blob URLs**: Fetch the video data via JavaScript (using fetch or XMLHttpRequest), create a Blob, then set the `<video>` src to a blob URL. Since blob URLs inherit the origin of the creating context, they are same-origin and bypass cross-origin checks.

   ```javascript
   const response = await fetch('http://localhost:14201/stream/...');
   const blob = await response.blob();
   videoElement.src = URL.createObjectURL(blob);
   ```

   **Limitation**: The entire video must be downloaded before playback begins. No range request seeking is possible with blob URLs.

2. **Media Source Extensions (MSE)**: Use MSE to feed video data chunk-by-chash to the `<video>` element. This avoids the cross-origin URL safety check because the data is provided programmatically, not fetched by the `<video>` element directly.

   **Limitation**: MSE requires specific codec support (fMP4 fragmented format, not regular MP4). Implementation complexity is higher.

3. **Proxy through the same origin**: Serve the video stream through the same port as the page (`localhost:14200`). Since both the page and the video are same-origin, no cross-origin checks apply. The server at `localhost:14200` can proxy requests to the actual streaming backend.

   ```javascript
   // Instead of:
   videoElement.src = 'http://localhost:14201/stream/...';
   // Use:
   videoElement.src = 'http://localhost:14200/proxy/stream/...';
   ```

   This is the **simplest and most reliable** workaround for the immediate problem.

### `SetVirtualHostNameToFolderMapping` for static assets

For static video files (not live streams), WebView2's `SetVirtualHostNameToFolderMapping` API can map a virtual hostname to a local folder, allowing the `<video>` element to load from a `.localhost` origin that shares the same security context as the page. However, this doesn't work for dynamic streaming endpoints.

---

## 7. Proposed Fix Strategy for NoBuf/Telegram-Drive

### Immediate fix (Phase 1): Same-origin proxy

The simplest and most reliable immediate fix is to **proxy the video stream through the same origin** as the page. Since the page is served from `http://localhost:14200`, add a `/stream/` route to that server that proxies requests to the streaming backend (whether it's on port 14201 or uses the `nobuf-stream.localhost` scheme).

This eliminates the cross-origin URL safety check entirely, because both the page and the video URL share the same origin (`http://localhost:14200`).

**Implementation**:
- Add a `/stream/:video_id` endpoint to the Tauri app's localhost:14200 server
- This endpoint proxies the request to the actual streaming backend
- Range request headers (`Range`) are forwarded to the backend
- Range response headers (`Content-Range`, `Accept-Ranges`, `206 status`) are forwarded back to the client
- The `<video>` element src becomes `http://localhost:14200/stream/:video_id`

### Medium-term fix (Phase 2): CORS + PNA headers

Add proper CORS and PNA headers to the streaming server, so that cross-origin media loads from the page origin are permitted:

1. Handle OPTIONS preflight requests with:
   - `Access-Control-Allow-Origin: http://localhost:14200`
   - `Access-Control-Allow-Private-Network: true`
   - `Access-Control-Allow-Methods: GET, OPTIONS`
   - `Access-Control-Allow-Headers: Range`

2. Handle GET requests with:
   - `Access-Control-Allow-Origin: http://localhost:14200`
   - Proper range request support (206, Content-Range, Accept-Ranges)

3. Update the page's CSP to include:
   - `media-src 'self' http://localhost:14201 http://nobuf-stream.localhost;`

### Long-term consideration (Phase 3): Monitor LNA rollout

The LNA/PNA restrictions are being progressively tightened in Chromium/WebView2. Monitor:
- WebView2Announcements for updates to the LNA rollout schedule
- WebView2Feedback #5456 for continued reports of PNA blocking
- Chromium's intent-to-ship announcements for PNA/LNA

If the `LocalNetworkAccessRestrictionsTemporaryOptOut` policy becomes unavailable (as Microsoft has indicated it's temporary), the same-origin proxy or proper CORS/PNA headers will be the only viable solutions.

---

## 8. Summary Table

| Issue | Source | Impact on NoBuf/Telegram-Drive |
|-------|--------|-------------------------------|
| **LNA/PNA restrictions** | Chromium → WebView2 | **Primary cause**: cross-origin localhost requests blocked by URL safety check |
| **LNA breaking change announcement** | WebView2Announcements #126 | Confirms rollout in WebView2; breaking for local network apps |
| **PNA blocking in v143** | WebView2Feedback #5456 | Confirms real apps are broken by LNA enforcement |
| **Custom scheme CSP enforcement** | WebView2Feedback #2850, #4379 | Custom schemes subject to CSP; may need explicit `media-src` allowance |
| **WebResourceRequested not fired** | WebView2Feedback #4362 | Custom scheme handler may not intercept media subresources |
| **Video/audio asset loading failure** | Tauri #3725 | Documents the exact problem in Tauri apps |
| **`.localhost` secure context** | W3C Secure Contexts spec | `.localhost` is secure, but cross-origin with `localhost:14200` |
| **LNA opt-out policy** | Edge enterprise policies | Temporary opt-out available; not viable for consumer apps |

---

## 9. Sources

1. WebView2Announcements Issue #126 — "Local Network Access (LNA) breaking change in WebView2"
2. WebView2Feedback Issue #5456 — "WebView2 v143 breaks requests from local origins to internal network APIs"
3. WebView2Feedback Issue #2850 — "Custom schemes should avoid CSP"
4. WebView2Feedback Issue #4379 — "CSP rules blocking custom protocol calls (Tauri)"
5. WebView2Feedback Issue #4362 — "WebResourceRequested not called from CSS with custom URI scheme"
6. WebView2Feedback Issue #2679 — "Local media in video tag fails to load"
7. WebView2Feedback Issue #456 — "Not allowed to load local resource"
8. Tauri Issue #3725 — "Loading a video/audio as an asset does not work"
9. Microsoft Edge Policy Documentation — `LocalNetworkAccessRestrictionsTemporaryOptOut`
10. W3C Secure Contexts Specification — `.localhost` TLD treatment
11. Chromium Private Network Access specification — PNA preflight mechanism
12. Chromium Intent-to-Ship: Private Network Access — rollout timeline
