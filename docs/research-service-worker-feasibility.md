# Service Worker Feasibility Research: Proxying Video Streaming (Range Requests) in WebView2/Tauri

## Executive Summary

**Verdict: NOT RECOMMENDED — too risky, too fragile, and a known Chromium/WebView2 regression history that makes this approach brittle.**

Service Workers in WebView2 can intercept `<video>` src requests and theoretically proxy them to another localhost port, making video streaming same-origin for CSP `'self'`. However, the approach carries significant risk due to:

1. **A P0 Chromium regression (Jan 2025) that broke video playback through Service Workers with 206 Partial Content** — this was fixed, but demonstrates the fragility of the SW+video+Range combination
2. **An unresolved WebView2-specific bug (#5070) where video playback broke through Service Workers in WebView2 runtime 132**
3. **Service Worker first-load problem** — requests before SW activation bypass the proxy entirely
4. **Latency overhead** on every Range request (seek, initial load, buffering)
5. **The current project's `tauri-plugin-localhost` + custom protocol approach already works and is simpler**

---

## 1. WebView2 Service Worker Support

### Status: Supported (since Edge/Chromium inherits the implementation)

**Evidence:**

- **WebView2Feedback Issue #362** (Aug 2020): "Does WebView2 fully support service workers?" — Microsoft confirmed that WebView2 inherits Chromium's Service Worker implementation since it's based on the Edge rendering engine.
- **WebView2 SDK API**: Microsoft added `CoreWebView2ServiceWorker`, `CoreWebView2ServiceWorkerRegistration`, and `CoreWebView2ServiceWorkerManager` APIs in the WebView2 SDK (experimental in 1.0.1018-prerelease, now in stable releases). These provide native management of Service Workers from the Rust/C++ side.
- **WebView2Announcements #127** (Feb 2026): WebView2 introduced `AreWebViewScriptApisEnabledForServiceWorkers` setting to control JavaScript API exposure within Service Worker scripts.
- **WebView2Feedback Issue #1757** (Sep 2021): Confirmed Service Worker Cache API is supported in WebView2.

**Key limitation:**
- **WebView2Feedback Issue #1114**: `WebResourceRequested` event is NOT raised for Service Worker fetch events. This means if you rely on WebView2's native `WebResourceRequested` API for request interception, Service Worker-handled requests bypass it. This is not a blocker for our use case (we'd intercept within the SW itself), but it's a documented inconsistency.

**Conclusion:** Service Workers work in WebView2. They inherit Chromium's full implementation. The `tauri-plugin-localhost` serving from `http://localhost:14200` provides an HTTP origin, which is required for Service Worker registration (custom protocols like `tauri://localhost` do NOT support Service Workers).

---

## 2. Service Workers Intercepting `<video>` src Requests

### Status: YES, Service Workers can intercept media element requests

**Evidence:**

- **MDN**: The `fetch` event in ServiceWorkerGlobalScope fires for ALL network requests made by controlled pages, including `<video>` and `<audio>` src requests.
- **Chrome Workbox documentation** (serving-cached-audio-and-video): Explicitly discusses Service Workers handling `<video>` and `<audio>` requests. The documentation states:
  - You MUST set `crossorigin` attribute on `<video>` even for same-origin URLs when using SW
  - You should use `workbox-range-requests` for proper Range request handling
  - Media assets should be pre-cached; runtime caching of partial 206 responses won't work

**Important nuance:**
- The `request.destination` property will be `"video"` or `"audio"` for media element requests, allowing the SW to filter them
- Chromium's media pipeline internally makes Range requests when seeking; these are normal HTTP requests that the SW fetch event sees

**Conclusion:** Yes, Service Workers intercept `<video>` src requests including Range requests made during seeks.

---

## 3. Service Worker Streaming / Range Request Handling

### Status: NOW WORKS in Chromium 87+, but with HISTORY OF REGRESSIONS

**Evidence:**

#### a) Range header preservation (Chromium 87+)
- **web.dev article** (Oct 2020, "Handle range requests in a service worker"): Historically, Chromium would silently DROP the `Range:` header when a request passed through a Service Worker's `fetch()` call. This was fixed in **Chrome/Edge 87** via [WHATWG Fetch spec change](https://github.com/whatwg/fetch/pull/560). Now `fetch(event.request)` properly preserves the `Range:` header, and the server can respond with `206 Partial Content`.
- **Safari** also fixed this behavior (WebKit r252047).
- **Firefox** had not fixed this as of 2020, but has since caught up.

#### b) P0 Regression: Broken video playback through SW + 206 Partial Content (Jan 2025)
- **Chromium Bug #390581541** (P0, Verified Fixed): Starting in Chrome 132, video playback through Service Workers returning `206 Partial Content` was **completely broken**. This affected Telegram Web, WhatsApp, and other apps using Service Workers for video streaming.
- **Root cause**: A change in `SecurityOrigin::AreSameOrigin` comparison caused null origins (from Service Worker responses) to be treated as different origins, blocking the media pipeline from accepting the data.
- **Fix**: Merged to M132 (132.0.6834.163), M133, and M134. Fixed by Jan 24, 2025.
- **Key quote from Chromium engineer**: "Not that I'm aware of, using a service worker is just broken." (when asked about workaround during the regression window)
- **Impact**: This regression lasted ~2 weeks in stable Chrome. WebView2 runtime 132 also had this bug.

#### c) WebView2-specific bug #5070 (Jan 2025)
- **WebView2Feedback #5070**: "[Bug]: Broken video, audio playback through Service Worker and `206 Partial Content` response in Webview2 runtime version 132.0.2957.127"
- A WinUI3 app with Service Workers for offline functionality experienced broken video playback.
- This appears to be the same Chromium regression (#390581541) affecting WebView2.
- The fix was shipped in WebView2 runtime 132.0.6834.163+.

#### d) Workbox range-requests module
- **Workbox `workbox-range-requests`**: Properly handles serving partial content from Cache API. Requires pre-caching the full video file, then slicing it for Range requests.
- For our PROXY use case (not caching), we'd just forward the request to `localhost:14201` and return the 206 response directly — no need for Workbox.

#### e) w3c/ServiceWorker Issue #1044: "Wasted bandwidth when proxying media"
- When a Service Worker proxies media, the browser's media pipeline may make additional requests that the SW doesn't need to intercept. There's a potential for wasted bandwidth where the SW fetches the full resource even though only a range was requested.
- This is mitigated by the Chromium 87+ fix that preserves Range headers.

**Conclusion:** Range request forwarding through Service Workers now works correctly in modern Chromium/WebView2. However, the Jan 2025 P0 regression proves this combination is fragile and can break with future Chromium updates. Any production use would need a fallback strategy.

---

## 4. Service Worker Registration in Tauri/WebView2

### How it would work:

#### Step 1: tauri-plugin-localhost serves from `http://localhost:14200`
The app already uses `tauri-plugin-localhost` (port 14200 in production, 1420 in dev). This provides an HTTP origin, which is **required** for Service Worker registration.

**Critical fact:** Service Workers CANNOT be registered from custom protocols (like `tauri://localhost` or `https://tauri.localhost`). They require a proper HTTP/HTTPS origin. This is confirmed by:
- **StackOverflow #79036569**: "Failed to register a ServiceWorker for scope ('https://tauri.localhost/') — An unknown error occurred when fetching the script." Service Workers fail on the custom Tauri protocol.
- **Solution confirmed**: Use `tauri-plugin-localhost` to serve from `http://localhost:PORT`, enabling SW registration.

Our app already does this! ✅

#### Step 2: CSP `worker-src` directive
The current CSP already includes `worker-src 'self' blob:;`. Since `'self'` matches `http://localhost:14200`, Service Worker scripts served from the same origin are allowed. No CSP changes needed. ✅

#### Step 3: Register the Service Worker in frontend code
```javascript
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/stream-proxy-sw.js', { scope: '/' })
    .then(reg => console.log('SW registered:', reg.scope))
    .catch(err => console.error('SW registration failed:', err));
}
```

The SW script (`stream-proxy-sw.js`) must be served from `http://localhost:14200/stream-proxy-sw.js` — i.e., it must be in the frontend dist assets.

#### Step 4: Service Worker proxy logic
```javascript
// stream-proxy-sw.js
const STREAM_PORT = 14201;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only intercept /stream/ routes
  if (url.pathname.startsWith('/stream/')) {
    // Rewrite URL to the Actix streaming server
    const proxyUrl = `http://localhost:${STREAM_PORT}${url.pathname}${url.search}`;

    // Forward the request with all headers (including Range)
    const proxyRequest = new Request(proxyUrl, {
      method: event.request.method,
      headers: event.request.headers,
      body: event.request.body,
      mode: 'cors',
    });

    event.respondWith(fetch(proxyRequest));
    return;
  }

  // Let other requests pass through normally
});
```

---

## 5. Existing Tauri Projects Using Service Workers

**Evidence:**
- **StackOverflow #79036569**: Developer successfully integrated Service Workers in Tauri by using `tauri-plugin-localhost`. Using vite-pwa and nuxt on top. This confirms the approach works.
- **VSCode issue #247035** (Apr 2025): VSCode extensions using WebView panels encountered "Failed to register service worker" errors, showing that Service Worker support in embedded WebView2 contexts can be tricky.
- No widely-known Tauri example projects specifically using Service Workers for media proxying were found. The use case is novel.

**Conclusion:** Service Workers in Tauri are proven to work when using `tauri-plugin-localhost`. The media proxy use case is less common but technically feasible.

---

## 6. Potential Drawbacks and Mitigation

### 6.1 Latency overhead from Service Worker proxy

**Problem:** Every Range request (initial load, seek, buffering) passes through the Service Worker → `fetch()` to localhost:14201 → response back. This adds:
- Service Worker dispatch overhead (~1-5ms per request)
- Potential for additional event loop delays when the SW thread is busy

**Mitigation:**
- The SW dispatch is fast in Chromium (sub-millisecond for simple passthrough)
- Both SW and Actix server are on localhost, so network latency is negligible
- For local-only streaming, this overhead is unlikely to be perceptible

**Assessment:** Low risk for local streaming, but adds unnecessary complexity vs. direct same-origin serving.

### 6.2 Service Worker lifecycle issues

**Problem:**
- **First load problem:** Service Workers don't intercept requests on the first page load until they activate. The first navigation to `http://localhost:14200` will bypass the SW entirely, meaning `/stream/` requests will fail (they'd go to the frontend dev server/plugin, not Actix).
- **Update problem:** When the SW script changes, there's a complex lifecycle: install → wait → activate. The old SW continues serving until the new one activates and `self.clients.claim()` is called.
- **SkipWaiting needed:** Must call `self.skipWaiting()` in install event and `self.clients.claim()` in activate event to minimize the first-load gap.

**Mitigation:**
- Use `clients.claim()` to take control immediately on activation
- Show a "loading" screen on first visit, register SW, then reload
- Or: register SW on a splash/index page, then navigate to the main app

**Assessment:** The first-load problem is a real UX issue. Video streaming would fail until the SW activates.

### 6.3 Regression risk (Chromium/WebView2 updates)

**Problem:** The Jan 2025 P0 regression proves that Service Worker + video + 206 Partial Content is a fragile combination. Any future Chromium change could break it again.

**Mitigation:**
- WebView2 runtime is auto-updated on users' machines — you can't pin a version
- Need a fallback: if video fails through SW, fall back to direct cross-origin URL (which is what the current custom protocol approach already does)
- This fallback would need to be implemented at the app level, adding complexity

**Assessment:** HIGH RISK. The regression history shows this is not a stable path.

### 6.4 Edge cases

- **Offline behavior:** SW could cache video responses, but partial 206 responses can't be cached at runtime (only full 200 responses). Pre-caching large video files is impractical.
- **Multiple video elements:** Concurrent video requests all go through the single SW thread. The SW thread handles events sequentially but `fetch()` is async, so this shouldn't be a bottleneck.
- **Service Worker death/restart:** If the SW process crashes, all video streaming stops until it restarts. Chromium restarts SWs automatically, but there's a brief gap.
- **CORS considerations:** The SW makes cross-port requests (14200 → 14201). The Actix server must return CORS headers (`Access-Control-Allow-Origin: http://localhost:14200`) for the SW's `fetch()` to succeed. This adds server-side complexity.

**Assessment:** Moderate risk for CORS, low risk for concurrency/restart.

### 6.5 Does Service Worker add latency to video seek/Range requests?

**Direct measurement:** No published benchmarks exist for SW proxy overhead on Range requests specifically. Theoretical analysis:
- SW event dispatch: ~0.5-2ms
- `fetch()` call overhead: ~0.5ms
- Local network round-trip (localhost): ~0.1ms
- **Total additional latency: ~1-3ms per request**

For video seeks, the browser typically makes 1-2 Range requests. An additional 3ms is imperceptible to users. However, during rapid seeking (dragging the seek bar), multiple requests in rapid succession could see cumulative delay.

**Assessment:** Negligible for normal usage, but unnecessary when a simpler approach exists.

---

## 7. Alternative Approaches (for comparison)

### Current approach: Custom protocol + localhost
The app currently uses:
- `tauri-plugin-localhost` on port 14200 for frontend
- Actix streaming server on port 14201 with `/stream/` routes
- Custom protocol `nobuf-stream://localhost` (mapped to `http://nobuf-stream.localhost` on Windows) for CSP `media-src`
- CSP allows `media-src 'self' blob: http://localhost:* nobuf-stream:* http://nobuf-stream.localhost`

**Pros:** Works today, no SW complexity, no first-load problem, no regression risk.
**Cons:** Requires a custom protocol registration, CSP must include the custom scheme explicitly.

### Service Worker approach
**Pros:** Pure same-origin (`http://localhost:14200/stream/...`), CSP can be stricter (`'self'` only).
**Cons:** First-load problem, regression risk, CORS headers needed on Actix, SW lifecycle complexity.

### Reverse proxy in Actix (serve both frontend AND streams on port 14200)
**Pros:** Pure same-origin, no SW, no first-load problem, no custom protocol.
**Cons:** Requires Actix to also serve frontend static assets, or a more complex proxy configuration. The `tauri-plugin-localhost` would be replaced entirely.

### WebView2 `WebResourceRequested` API intercept
**Pros:** No SW needed, intercept at the native level.
**Cons:** Does NOT work for Service Worker requests (Issue #1114), and more importantly, does NOT intercept media pipeline requests made by `<video>` elements (these bypass the `WebResourceRequested` API entirely — they go through Chromium's internal media pipeline, not through the WebView2 request interception layer).

---

## 8. Final Verdict

### **NOT RECOMMENDED**

**Reasons:**

1. **Regression history is alarming**: The Jan 2025 P0 Chromium regression that completely broke video playback through Service Workers with 206 responses proves this combination is fragile. Since WebView2 auto-updates, any future regression would break the app for all users with no way to pin the runtime version.

2. **First-load problem is a UX issue**: Video streaming would fail on the first page load until the SW activates. This requires either a loading splash screen + reload or accepting that the first video request goes direct (cross-origin), which defeats the CSP `'self'` goal.

3. **Current approach already works**: The custom protocol (`nobuf-stream://localhost`) + `tauri-plugin-localhost` approach is simpler, has no SW lifecycle issues, no regression risk, and no first-load problem. The CSP already includes the custom scheme in `media-src`.

4. **Added complexity for minimal benefit**: The Service Worker approach adds CORS headers on Actix, SW script management, SW lifecycle handling, fallback strategies, and regression monitoring — all to make video URLs be `http://localhost:14200/stream/...` instead of `http://nobuf-stream.localhost/stream/...`. The CSP benefit is marginal since the current CSP already restricts media sources appropriately.

5. **If CSP simplification is the goal**: A better alternative would be to run Actix on the same port as `tauri-plugin-localhost` (14200) and serve `/stream/` routes directly, achieving true same-origin without Service Workers.

**If you still want to proceed with Service Workers despite these risks:**

The implementation steps are:
1. Create `stream-proxy-sw.js` in frontend assets
2. Register SW on page load with `clients.claim()`
3. Handle first-load with a splash screen + reload pattern
4. Add CORS headers to Actix streaming server
5. Add fallback: detect video error, retry with direct cross-origin URL
6. Monitor WebView2 runtime versions for regressions
7. Keep CSP `worker-src 'self'` (already present)

But this approach is fundamentally fragile and the team should consider the Actix reverse proxy alternative or stick with the current custom protocol approach.

---

## Sources

- [Chromium Bug #390581541](https://issues.chromium.org/issues/390581541) — P0 regression: broken video through SW + 206
- [WebView2Feedback #5070](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5070) — Broken video in WebView2 runtime 132
- [WebView2Feedback #362](https://github.com/MicrosoftEdge/WebView2Feedback/issues/362) — Does WebView2 support SW?
- [WebView2Feedback #1114](https://github.com/MicrosoftEdge/WebView2Feedback/issues/1114) — WebResourceRequested not raised for SW fetch
- [WebView2Feedback #1757](https://github.com/MicrosoftEdge/WebView2Feedback/issues/1757) — SW Cache support
- [WebView2 CoreWebView2ServiceWorker API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2experimentalserviceworker) — Native SW management API
- [web.dev: Handle range requests in a service worker](https://web.dev/articles/sw-range-requests)
- [Workbox: Serving cached audio and video](https://developer.chrome.com/docs/workbox/serving-cached-audio-and-video)
- [Mux: Service workers are underrated](https://www.mux.com/blog/service-workers-are-underrated) — Media proxy use case
- [Justin Ribeiro: SW + 206 Partial Response](https://justinribeiro.com/chronicle/2026/02/04/service-worker-video-files-and-the-206-partial-response)
- [w3c/ServiceWorker #1044](https://github.com/w3c/ServiceWorker/issues/1044) — Wasted bandwidth when proxying media
- [StackOverflow #79036569](https://stackoverflow.com/questions/79036569) — SW registration in Tauri
- [Tauri localhost plugin](https://v2.tauri.app/plugin/localhost/)
- [CSP worker-src directive (MDN)](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src)
