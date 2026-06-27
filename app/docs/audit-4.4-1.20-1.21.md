# NoBuf Security Audit — Sections 4.4, 1.20, 1.21

**Auditor:** Hermes Agent (automated)
**Date:** 2026-06-27
**Scope:** docs/ directory (design specs & plans), all Rust & TypeScript source files for data privacy analysis, build artifact security (vite.config.ts, tsconfig.json, Cargo.toml, tauri.conf.json, debug assertions, source maps, hardcoded credentials)
**Method:** Static source analysis. Every finding cites exact file:line. No assumptions.

---

## 4.4 — Design Specs Review

### Documents Reviewed (6 files)

| File | Topic | Status |
|---|---|---|
| `docs/superpowers/specs/2026-06-13-cold-start-overlay-design.md` | Cold-start "No Buffer optimization" overlay | Approved |
| `docs/superpowers/plans/2026-06-13-cold-start-overlay.md` | Implementation plan for cold-start overlay | Draft (checkboxes unchecked) |
| `docs/superpowers/specs/2026-06-14-180s-60s-buffer-design.md` | 180s ahead / 60s behind in-memory buffer policy | Draft |
| `docs/superpowers/plans/2026-06-14-180s-60s-buffer-plan.md` | Implementation plan for 180s/60s buffer | Draft (checkboxes unchecked) |
| `docs/specs/2026-06-08-proactive-disk-prebuffer-design.md` | Proactive disk prebuffer design | Spec only (no plan) |
| `docs/security-audit-1.7-1.22.md` | Prior security audit (sections 1.7–1.22) | Complete |

---

### Finding 4.4.1: MEDIUM — Cold-start overlay spec has no timeout cancellation of the background download

**File:** `docs/superpowers/specs/2026-06-13-cold-start-overlay-design.md:31` (hard timeout spec), `docs/superpowers/plans/2026-06-13-cold-start-overlay.md:136-143` (implementation)

**Severity:** Medium

**Details:**
The design spec (line 31) defines a hard timeout of 10 seconds: "Never leave the user waiting indefinitely." The plan (lines 136-143) implements the timeout correctly — when `timedOut` is true, `setIsColdStartBuffering(false)` fires and `resolve(true)` continues to attach the player with whatever buffer exists.

However, the spec (line 63) says: "User closes preview while buffering: cancel the proactive prebuffer and clean up the overlay." The plan (lines 247-253) implements a Cancel button that calls `onCancel` → `handleClose`.

**The gap:** When the **hard timeout** fires (not a user cancel), the spec says to "hide the overlay and attach the player with available buffer" (line 64) but does NOT say to cancel the background proactive prebuffer download. The plan implementation (lines 136-143) also does not cancel the download on timeout — it only clears the interval and resolves. The background download continues consuming bandwidth after the overlay disappears.

**Security relevance:** On metered connections or in environments where bandwidth usage is monitored, a runaway background download triggered by a cold-start timeout that the user didn't explicitly cancel could be considered unwanted network activity. The spec's edge case section (lines 62-66) only mentions cancellation for user-initiated close, not for timeout.

**PoC:** Open a TS video with an empty cache on a slow network. The overlay appears. After 10 seconds, the timeout fires, the overlay disappears, and playback starts with minimal buffer. The proactive prebuffer download continues in the background, consuming bandwidth for the entire file without user awareness.

**Fix:** In the timeout branch of `waitForColdStartBuffer` (plan lines 136-143), after `resolve(true)`, add a call to cancel the proactive prebuffer for this `msg_id` (e.g., `invoke('cmd_cancel_proactive_prebuffer', { msg_id })`) if one was started.

**Blast radius:** Unwanted bandwidth consumption after timeout. No data exfiltration — downloads go to local disk cache from Telegram.

**Regression test plan:** Trigger a cold-start timeout on a slow network. Verify the proactive prebuffer download stops after the timeout fires (monitor `cmd_get_cache_status` to confirm no further progress).

**Fix safety class:** Safe (adds cleanup logic, no behavior change for the normal path).

---

### Finding 4.4.2: MEDIUM — 180s/60s buffer spec disables mpegts.js native cleanup, moving all memory management to custom code

**File:** `docs/superpowers/specs/2026-06-14-180s-60s-buffer-design.md:61` (`autoCleanupSourceBuffer: false`), `docs/superpowers/plans/2026-06-14-180s-60s-buffer-plan.md:43` (implementation)

**Severity:** Medium

**Details:**
The spec (line 62) specifies `autoCleanupSourceBuffer: false` to disable mpegts.js's built-in SourceBuffer cleanup. The plan (line 43) implements this. All behind-window eviction (keeping 60s behind the playhead) is moved to the custom `sourceBufferQuotaGuard`.

The spec itself acknowledges this risk (line 153): "Disabling mpegts.js `autoCleanupSourceBuffer` puts all behind-window eviction responsibility on the custom quota guard. A bug could leak memory or trigger browser quota errors."

**Security relevance:** If the custom quota guard has a bug (e.g., a race condition between the guard interval and a seek), the SourceBuffer could accumulate unbounded data. This is a Denial of Service vector — a long video playback session could exhaust browser memory and crash the WebView2 renderer.

The spec's high-bitrate fallback (lines 68-74) shrinks the behind window from 60→30→15 seconds, but this only applies when `QuotaExceededError` is caught. If the error is a different type (e.g., `InvalidStateError` from a race), the fallback won't trigger.

**PoC:** Play a high-bitrate TS video (e.g., 50 Mbps) for 30+ minutes. If the quota guard has a timing bug that misses eviction cycles, the SourceBuffer accumulates ~180s × 50 Mbps = ~1.1 GB per cycle. Browser MSE implementations typically have a 250-300 MB ceiling.

**Fix:**
1. Add a hard byte-count ceiling in the quota guard independent of the time-based eviction. If `SourceBuffer.buffered` total exceeds a threshold (e.g., 300 MB), force-evict regardless of the time window.
2. Catch all error types from `SourceBuffer.remove()`, not just `QuotaExceededError`.
3. Add a monitoring log that warns when the buffer exceeds 200 MB.

**Blast radius:** OOM crash of the WebView2 renderer. No data exfiltration. Recovery requires app restart.

**Regression test plan:** Play a 50+ Mbps TS video for 30 minutes. Monitor `SourceBuffer.buffered` total byte count via `performance.memory` (if available) or by computing `buffered.end() - buffered.start()` × bitrate. Verify it stays under 300 MB.

**Fix safety class:** Requires testing (adds safety ceiling to eviction logic; must not interfere with normal playback).

---

### Finding 4.4.3: LOW — Proactive disk prebuffer spec assumes CBR for byte-position calculation, acknowledges <2% error but no validation

**File:** `docs/specs/2026-06-08-proactive-disk-prebuffer-design.md:96-102`

**Severity:** Low

**Details:**
The spec (lines 96-102) states: "TS files are typically CBR (constant bitrate), so `current_byte = (current_time_s / duration_s) * file_size`. This is an approximation. Error is typically <2% for CBR TS files."

The 180s/60s buffer design (line 82) and plan (lines 362-376) introduce VBR-aware byte-time index (`byteTimeSamplesRef`) for seeks, but the proactive prebuffer spec still relies on the CBR approximation for its `cmd_report_playback_position` calculation (line 42: `current_byte = (current_time_s / duration_s) * file_size`).

**Security relevance:** For VBR TS files (e.g., variable-quality streams), the CBR approximation could cause the proactive prebuffer to download the wrong byte range, wasting bandwidth and disk space on data the player doesn't need. This is not a security vulnerability but a performance/correctness issue that the spec's "assumption about Telegram API" (that TS files are CBR) may not hold for all user-uploaded content.

**PoC:** Upload a VBR TS file with highly variable bitrate (e.g., action movie with quiet scenes). The proactive prebuffer calculates byte positions using CBR, causing it to download ranges that don't align with the actual media time positions, resulting in cache misses when the player seeks.

**Fix:** When the VBR byte-time index (`byteTimeSamplesRef`) is available from the frontend, pass it to `cmd_report_playback_position` and use `findByteForTime` instead of the linear CBR formula.

**Blast radius:** Wasted bandwidth and disk cache for VBR files. No security impact.

**Regression test plan:** Play a known VBR TS file. Verify the proactive prebuffer downloads ranges that align with the actual media time positions by checking `cmd_get_cache_status` against the player's current position.

**Fix safety class:** Enhancement (performance improvement, not a security fix).

---

### Finding 4.4.4: LOW — 180s/60s buffer plan references line numbers that will drift, creating implementation risk

**File:** `docs/superpowers/plans/2026-06-14-180s-60s-buffer-plan.md:27` (`useMSEPlayer.ts:1864-1875`), `:29` (`:2497-2514`), `:90` (`:3130-3137`), `:168` (`:3350-3400+`), `:273` (`:2743, 2858, 3628, 3688, 3756`)

**Severity:** Low (maintenance risk)

**Details:**
The implementation plan references exact line numbers in `useMSEPlayer.ts` (e.g., "Replace the config block (lines 1864-1875)"). If any code is added or removed between plan creation and implementation, these line numbers will be wrong, and an automated agent following the plan could patch the wrong location.

**Security relevance:** An agent patching the wrong lines could introduce a buffer policy bug (e.g., setting `autoCleanupSourceBuffer: false` in the wrong place, or replacing the wrong `MAX_SERVE_AHEAD_SECONDS` constant) that leads to the memory issues described in Finding 4.4.2.

**Fix:** Replace line-number references with function/variable name anchors and surrounding code context. The plan already uses some context (e.g., "Replace the config block"), which is better, but the line numbers should be removed or marked as approximate.

**Blast radius:** Implementation error leading to buffer policy bugs.

**Regression test plan:** N/A (process improvement).

**Fix safety class:** Safe (documentation change).

---

### Finding 4.4.5: Informational — Prior security audit (1.7–1.22) is stored in docs/ directory with HIGH findings still open

**File:** `docs/security-audit-1.7-1.22.md` (entire file)

**Severity:** Informational (process observation)

**Details:**
The prior audit document (840 lines) documents 2 HIGH and 14 MEDIUM findings. The document has no "Status: Fixed" annotations next to any finding. The findings are:

- **1.12.1 (HIGH):** SSRF in `cmd_upload_from_url` — no URL validation (fs.rs:409-622)
- **1.17.1 (HIGH):** SQL injection pattern in `folder_groups.rs` (format! with string interpolation)
- **1.8.2 (MEDIUM):** `cmd_get_cache_total_size` missing from capabilities
- **1.9.1 (MEDIUM):** ffmpeg auto-download from internet at runtime
- **1.13.1-1.13.3 (MEDIUM):** PII/token leakage in logs

**Security relevance:** The SSRF finding (1.12.1) is particularly relevant because the docs/specs directory shows the proactive prebuffer design (`docs/specs/2026-06-08-proactive-disk-prebuffer-design.md:29-44`) which adds `cmd_report_playback_position` — a new IPC command that takes `msg_id`, `folder_id`, and `current_time_s` parameters. While these are typed (i32, i64, f64) and don't introduce new injection vectors, the design spec does not mention security review of the new command.

**Fix:** Track audit findings in an issue tracker with status tracking. Review new IPC commands against the audit findings before implementation.

**Fix safety class:** Process improvement.

---

### Finding 4.4.6: Informational — Design specs assume Telegram API behavior that may change (open-ended Range requests)

**File:** `docs/superpowers/specs/2026-06-14-180s-60s-buffer-design.md:42` (mpegts.js Range requests), `docs/specs/2026-06-08-proactive-disk-prebuffer-design.md:15-18` (data flow diagram)

**Severity:** Informational

**Details:**
The 180s/60s buffer spec (line 42) states: "mpegts.js uses open-ended `Range: bytes=X-` requests, which are never fully served from the 30 MB JS shadow-cache hit cap. The 'instant from disk' path therefore relies on the backend `/stream` endpoint reading from its disk cache."

This is an assumption about mpegts.js's HTTP client behavior. If a future version of mpegts.js changes its Range request format (e.g., to bounded `Range: bytes=X-Y`), the shadow-cache hit logic and the "instant from disk" seek path would need to be re-evaluated.

The proactive prebuffer spec (lines 15-18) assumes the `/stream` endpoint's `CACHE-PREFIX` behavior (serve cached bytes first, then download remaining from Telegram). If Telegram's API changes download chunk sizes or rate limits, the `CACHE-PREFIX` optimization may not work as designed.

**Security relevance:** If mpegts.js changes to bounded Range requests, the shadow cache may serve partial data, causing playback corruption that could be mistaken for a security issue. No direct security impact.

**Fix:** Pin the mpegts.js version (package.json:31 currently uses `^1.8.0` — consider pinning to `1.8.0` exact). Add a test that verifies the Range request format.

**Fix safety class:** Safe (dependency pinning).

---

### Finding 4.4.7: LOW — Both implementation plans have unchecked task checkboxes, indicating features may not be fully implemented

**File:** `docs/superpowers/plans/2026-06-13-cold-start-overlay.md` (all checkboxes `- [ ]`), `docs/superpowers/plans/2026-06-14-180s-60s-buffer-plan.md` (all checkboxes `- [ ]`)

**Severity:** Low

**Details:**
Both implementation plans use `- [ ]` (unchecked) for all tasks. This means either:
1. The features are not yet implemented, or
2. The features were implemented but the plans were not updated.

The 180s/60s buffer plan (line 526) mentions "10 pre-existing warnings" in `cargo check`, and the plan references specific line numbers in `useMSEPlayer.ts` (a 5000+ line file), suggesting the codebase is mature and these features may have been partially or fully implemented.

**Security relevance:** If the cold-start overlay is not implemented, the user experience degradation described in the spec (line 9: "video frame flashes for a second, then stalls") is the current behavior. This is not a security issue but indicates the design's buffer management goals are not yet achieved.

**Fix:** Update the plan documents to reflect actual implementation status. If features are not implemented, track them as open work items.

**Fix safety class:** Safe (documentation update).

---

## 1.20 — Data Privacy & Telemetry

### Finding 1.20.1: Informational (Positive) — No telemetry, analytics, crash reporting, or tracking SDK found in any source file

**File:** N/A (comprehensive search of all source files)

**Severity:** Informational (positive finding)

**Details:**
A comprehensive search was conducted across all source files:

**TypeScript/React (src/):**
- Searched for: `analytics`, `telemetry`, `tracking` (as telemetry SDK), `posthog`, `amplitude`, `mixpanel`, `google.analytics`, `gtag`, `googletagmanager`, `sentry`, `crashlytics`, `bugsnag`, `datadog`, `crash.report`, `error.report`, `logrocket`, `raygun`, `hotjar`, `segment`
- **Result: ZERO matches** for any telemetry or analytics SDK import or usage.
- The word "tracking" appears only in CSS class names (`tracking-wide`, `tracking-tight`, `tracking-wider`) and in code comments about download speed tracking (`useMSEPlayer.ts:711: "download speed tracking for TS"`). None are telemetry.

**Rust (src-tauri/src/):**
- Searched for: `analytics`, `telemetry`, `tracking` (as telemetry), `sentry`, `crash.report`, `bugsnag`, `datadog`, `posthog`, `amplitude`, `mixpanel`
- **Result: ZERO matches** for any telemetry SDK.
- The word "tracking" appears only in test function names (`test_incremental_chunk_tracking_*` in `stream_cache.rs:1273, 1308`) and a comment about progress tracking (`fs.rs:322: "Create progress-tracking reader"`). None are telemetry.

**package.json dependencies:**
- Searched for: `sentry`, `bugsnag`, `crashalytics`, `posthog`, `amplitude`, `mixpanel`, `hotjar`, `segment`, `datadog`, `logrocket`, `raygun`
- **Result: ZERO matches.** No telemetry or analytics packages in dependencies.

**Cargo.toml dependencies:**
- Searched for: `sentry`, `bugsnag`, `crashalytics`, `posthog`, `amplitude`, `mixpanel`, `datadog`
- **Result: ZERO matches.** No telemetry crates.

**Auto-updater privacy:**
- The auto-updater (`tauri-plugin-updater`) fetches from `https://github.com/Istiaq-Edu/nobuf/releases/latest/download/latest.json` (tauri.conf.json:6). This is a standard Tauri update check — it sends only the current app version and platform info in the request headers. No usage data, telemetry, or tracking is sent.
- The updater does NOT send: user IP (beyond what GitHub's CDN sees), phone number, session data, file lists, or any usage statistics.

**All network endpoints found:**

| Endpoint | Source | Purpose | Privacy concern |
|---|---|---|---|
| `https://github.com/Istiaq-Edu/nobuf/releases/latest/download/latest.json` | tauri.conf.json:6 | App update check | None (standard update protocol) |
| `https://my.telegram.org` | AuthWizard.tsx:46, 79 | User instruction link (opens in browser) | None (user-initiated, external browser) |
| `https://t.me/{channel}/{id}` | FileExplorer.tsx:136, copyLink.test.ts:7 | Copy share link | None (link generation, no data sent) |
| `https://unpkg.com/mp4box@0.5.2/dist/mp4box.all.js` | MP4Player.ts:120 | CDN fallback for mp4box library | **See Finding 1.20.2** |
| `http://127.0.0.1:14201/*` | lib.rs:136, streaming.rs:61 | Internal streaming server | None (localhost) |
| `http://localhost:14200/*` | lib.rs:368 | Localhost plugin (production) | None (localhost) |
| `http://localhost:1420/*` | lib.rs:370, tauri.conf.json:16 | Vite dev server | None (localhost, dev only) |
| User-provided URLs | fs.rs:424 (`ureq::get(&url)`) | Remote upload feature | **See prior audit 1.12.1 (SSRF)** |
| Telegram API (via grammers) | Cargo.toml:23-26 | Core app functionality | Inherent to app purpose |
| ffmpeg-sidecar download | sprite.rs:59 | ffmpeg binary download | **See prior audit 1.9.1** |

**Fix:** None required. This is a privacy-positive finding. The app does not collect, transmit, or share any usage data, analytics, or crash reports.

**Fix safety class:** N/A.

---

### Finding 1.20.2: MEDIUM — MP4Player.ts loads mp4box from unpkg.com CDN as a fallback, bypassing CSP and integrity checks

**File:** `src/lib/faststream/players/MP4Player.ts:120`

**Severity:** Medium

**Details:**
```typescript
// MP4Player.ts:106-125
private async loadMP4Box(): Promise<any> {
  // Try to load mp4box from global scope
  if (typeof (window as any).MP4Box !== 'undefined') {
    return (window as any).MP4Box;
  }

  // Dynamic import
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
}
```

When the bundled `mp4box` import fails, the code dynamically creates a `<script>` element pointing to `https://unpkg.com/mp4box@0.5.2/dist/mp4box.all.js` and appends it to `document.head`.

**Privacy concern:** This makes an outbound HTTP request to `unpkg.com` (a public CDN), which:
1. Reveals the user's IP address to unpkg.com's servers
2. Reveals that the user is running NoBuf (via User-Agent or referer headers)
3. Downloads and executes JavaScript from a third-party source without integrity verification (no SRI hash)

**CSP bypass:** The CSP in `tauri.conf.json:22` specifies `script-src 'self'`, which should block external script loading. However, this CDN fallback is in a `catch` block that only runs when the bundled import fails. In practice, the bundled import should always succeed in production builds (Vite bundles `mp4box` from `package.json:30: "mp4box": "^0.5.2"`). The CDN fallback would only trigger if the bundle is corrupted or missing — which itself would indicate a build or tampering issue.

**However:** If the CSP correctly blocks this script, the `script.onerror` callback fires and the promise rejects, causing MP4 playback to fail silently. The user gets no error message about why MP4 playback failed. This is a reliability issue, not a privacy issue — but it means the CDN fallback is dead code that can never work in production (CSP blocks it) yet creates a false sense of robustness.

**PoC:**
1. In a development environment (where CSP may be relaxed), cause the `mp4box` import to fail (e.g., delete `node_modules/mp4box`).
2. Open an MP4 file in the player.
3. The app fetches `https://unpkg.com/mp4box@0.5.2/dist/mp4box.all.js`, exposing the user's IP to unpkg.com.
4. If unpkg.com is compromised or MITM'd, arbitrary JavaScript executes in the WebView2 renderer.

**Fix:**
1. Remove the CDN fallback entirely — it's dead code in production (CSP blocks it) and a privacy/security risk in development.
2. If a fallback is needed, bundle a second copy or use a Tauri resource file.
3. If the import fails, show a user-facing error: "MP4 playback library failed to load."

```typescript
// Replace the catch block with:
} catch (e) {
  console.error('MP4Box failed to load from bundle:', e);
  throw new Error('MP4 playback library unavailable');
}
```

**Blast radius:** In production: CSP blocks the script, MP4 playback fails silently. In development: user IP exposed to unpkg.com, potential code execution if unpkg.com is compromised.

**Regression test plan:**
1. In production build, verify MP4 playback works (bundled import succeeds).
2. In production build, verify no network requests to unpkg.com (check DevTools Network tab or network monitor).
3. After removing CDN fallback, verify MP4 playback still works normally.

**Fix safety class:** Safe (removes dead code that's already blocked by CSP in production; improves error messaging).

---

### Finding 1.20.3: LOW — No crash reporting mechanism means crashes are silently lost

**File:** N/A (no crash reporting found in any source file)

**Severity:** Low (informational)

**Details:**
No crash reporting SDK (Sentry, Bugsnag, Crashlytics, etc.) was found in either the Rust or TypeScript codebase. When the app crashes (Rust panic or JavaScript uncaught error), the crash information is:
- In Rust: written to stderr (captured by `env_logger` at INFO level)
- In TypeScript: written to the browser console (visible only in DevTools)

No crash data is transmitted anywhere. This is privacy-positive but means the developer has no visibility into crash rates or patterns in production.

**Fix:** If crash reporting is desired, add an opt-in crash reporter that sends minimal crash data (stack trace, app version, OS) to a self-hosted endpoint. Ensure it's opt-in and documented in a privacy policy.

**Fix safety class:** N/A (design decision).

---

## 1.21 — Build Artifact Security

### Finding 1.21.1: MEDIUM — No `[profile.release]` section in Cargo.toml — debug symbols, strip, and optimization are at Rust defaults

**File:** `src-tauri/Cargo.toml` (entire file, 57 lines — no `[profile.release]` section found)

**Severity:** Medium

**Details:**
The Cargo.toml file is 57 lines long and contains only `[package]`, `[lib]`, `[build-dependencies]`, and `[dependencies]` sections. There is **no `[profile.release]` section**.

A targeted search for `strip`, `debug.*=.*false`, `opt-level`, `lto`, and `panic.*=.*abort` in Cargo.toml returned **zero matches**, confirming no release profile customization.

**Rust default release profile behavior:**
- `opt-level = 3` (optimization on — good)
- `debug = false` (no debug info — good, but see below)
- `strip = "none"` (symbols NOT stripped by default in Rust < 1.77; in newer Rust, `strip` defaults to `"none"` unless explicitly set)
- `lto = false` (no link-time optimization — larger binary, less optimized)
- `panic = "unwind"` (panics unwind the stack — larger binary, captures more state)
- `codegen-units = 16` (default, less optimized for size/speed)

**Security relevance:**
1. **Debug symbols:** Without explicit `strip = true`, the release binary may contain symbol names (function names, variable names) that reveal internal code structure. While Rust's `debug = false` in release mode removes debug info (DWARF/PDB), the symbol table may still contain function names depending on the platform and linker. An attacker reverse-engineering the binary can learn the names of security-sensitive functions (e.g., `generate_stream_token`, `validate_token`, `check_auth`).

2. **No LTO:** Without LTO, the binary is larger and potentially less optimized, but this is a performance issue, not a security issue.

3. **Panic = unwind:** With `panic = "unwind"`, panic handlers capture stack traces. In production, `panic = "abort"` is more secure because it immediately terminates without exposing stack state.

**PoC:**
```bash
cd src-tauri && cargo build --release
# On Linux:
nm target/release/app_lib | grep -i "token\|auth\|secret\|password"
# On Windows:
dumpbin /symbols target/release/app_lib.dll | findstr /i "token auth secret password"
```
If function names like `generate_stream_token` or `check_auth` are visible, the symbol table is not stripped.

**Fix:** Add a `[profile.release]` section to Cargo.toml:
```toml
[profile.release]
strip = true        # Strip symbols from binary
lto = true           # Link-time optimization (smaller, faster binary)
panic = "abort"      # Abort on panic instead of unwinding (smaller, more secure)
codegen-units = 1    # Better optimization at the cost of compile time
```

**Blast radius:** Reverse engineering of internal function names. No direct exploit, but aids an attacker in understanding the binary's security-relevant code paths.

**Regression test plan:**
1. After adding the profile, run `cargo build --release`.
2. Verify the binary size decreases.
3. Run `nm target/release/app_lib | grep generate_stream_token` — should return nothing.
4. Verify the app still functions correctly (run all integration tests, verify streaming, auth, and file operations).
5. Verify panics now abort instead of unwinding (test with a deliberate panic in a test build).

**Fix safety class:** Requires testing (`panic = "abort"` changes panic behavior; `lto = true` and `codegen-units = 1` significantly increase compile time; `strip = true` may affect crash debugging).

---

### Finding 1.21.2: MEDIUM — Vite build does NOT disable source maps — default Vite 7 behavior may generate them

**File:** `vite.config.ts` (entire file, 35 lines — no `build.sourcemap` setting)

**Severity:** Medium

**Details:**
The `vite.config.ts` file contains no `build` configuration section at all:
```typescript
// vite.config.ts (complete file)
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    fs: { deny: ["**/src-tauri/target/**"] },
  },
  optimizeDeps: { entries: ["index.html"] },
}));
```

A targeted search for `sourcemap`, `source.map`, `source-map`, `sourceMap` in `vite.config.ts` returned **zero matches**.

**Vite 7 default behavior:** By default, Vite does NOT generate source maps in production builds (`build.sourcemap` defaults to `false`). However, this default can be overridden by:
1. An environment variable
2. A plugin (e.g., `@vitejs/plugin-react` may request source maps for HMR)
3. A future Vite version changing the default

The `package.json:8` build script is `"build": "tsc && vite build"`. The `tsc` command runs the TypeScript compiler with `tsconfig.json:14: "noEmit": true`, so `tsc` only type-checks and does NOT emit JavaScript files or source maps. The actual bundling is done by `vite build`.

**Current state:** Based on Vite 7's default, source maps are likely NOT generated in production. But because this is an implicit default rather than an explicit `build.sourcemap: false`, it's fragile — a Vite upgrade or plugin change could silently start generating source maps that expose original TypeScript source code in the production bundle.

**Security relevance:** If source maps are generated, they would be placed in the `dist/` directory alongside the production bundle. The `tauri.conf.json:18` specifies `"frontendDist": "../dist"`. Tauri bundles this directory into the app. If source maps are included:
1. An attacker extracting the app's resources can read the original TypeScript source code
2. Internal variable names, comments, and logic are exposed
3. Security-relevant code paths (e.g., token validation, API key handling) are easier to reverse-engineer

**PoC:**
```bash
cd /d/DEVELOPMENT/Telegram-Drive/app
npm run build
ls -la dist/ | grep -i "map\|sourcemap"
# If any .map files are found, source maps are being generated
```

**Fix:** Explicitly disable source maps in `vite.config.ts`:
```typescript
export default defineConfig(async () => ({
  plugins: [react()],
  // ... existing config ...
  build: {
    sourcemap: false,  // Explicitly disable source maps in production
  },
}));
```

**Blast radius:** If source maps are currently not generated (Vite default), this is a no-op hardening. If they ARE generated (due to a plugin or env var), this prevents source code leakage.

**Regression test plan:**
1. After adding `build.sourcemap: false`, run `npm run build`.
2. Verify no `.map` files exist in `dist/`.
3. Verify the production build still works (run the app, verify all features).
4. Verify stack traces in production still show useful information (file names, line numbers from the bundled code).

**Fix safety class:** Safe (explicitly sets a value that matches the default; no behavior change expected).

---

### Finding 1.21.3: LOW — `#[cfg(debug_assertions)]` blocks in lib.rs are correctly gated but expose dev-mode configuration

**File:** `src-tauri/src/lib.rs:36` (`#[cfg(not(debug_assertions))]`), `:221-225` (debug/release builder split), `:367-370` (debug/release window URL split)

**Severity:** Low (informational — configuration is correct)

**Details:**
Six `#[cfg(debug_assertions)]` / `#[cfg(not(debug_assertions))]` blocks were found:

1. **`main.rs:2`** — `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
   - Correct: hides the console window in release builds on Windows.

2. **`lib.rs:36-37`** — `#[cfg(not(debug_assertions))] const LOCALHOST_PLUGIN_PORT: u16 = 14200;`
   - Correct: the localhost plugin port is only defined in release builds.

3. **`lib.rs:221-225`** — Release builds add `tauri_plugin_localhost`, debug builds don't.
   - Correct: dev mode uses Vite's dev server on port 1420.

4. **`lib.rs:367-370`** — Release builds use `http://localhost:14200`, debug builds use `http://localhost:1420`.
   - Correct: different URLs for dev vs production.

5. **No `#[cfg(debug_assertions)]` blocks found in any TypeScript source files** — TypeScript does not have this concept, and the search confirmed zero matches.

**Security relevance:** The debug/release split is correctly implemented. In debug mode, the app runs from Vite's dev server (port 1420) without the localhost plugin. In release mode, it runs from the localhost plugin (port 14200) which makes it same-origin with the streaming server (port 14201).

**One observation:** In debug builds, the app does NOT use the localhost plugin, meaning the frontend is served from `http://localhost:1420` (Vite dev server). The streaming server is on `http://localhost:14201`. These are different ports, so WebView2's cross-origin checks apply. This is expected in development (HMR requires Vite's dev server) but means debug builds have a different security posture than release builds (cross-origin vs same-origin). Any security testing should be done in release mode.

**Fix:** None required. The configuration is correct.

**Fix safety class:** N/A.

---

### Finding 1.21.4: LOW — Hardcoded test credentials in api_settings.rs unit tests

**File:** `src-tauri/src/commands/api_settings.rs:75, 76, 81`

**Severity:** Low

**Details:**
```rust
// api_settings.rs:73-89 (inside #[cfg(test)] mod tests)
#[test]
fn test_verify_key_correct() {
    let hash = hash_key("my-secret-key-123");   // line 75
    assert!(verify_key("my-secret-key-123", &hash));  // line 76
}

#[test]
fn test_verify_key_wrong() {
    let hash = hash_key("my-secret-key-123");   // line 81
    assert!(!verify_key("wrong-key", &hash));   // line 82
}

#[test]
fn test_verify_key_empty() {
    let hash = hash_key("");                     // line 87
    assert!(verify_key("", &hash));              // line 88
    assert!(!verify_key("a", &hash));            // line 89
}
```

The string `"my-secret-key-123"` is used as a test API key. This is inside `#[cfg(test)]` so it's only compiled in test builds, not in release binaries. The key is not a real credential — it's a test fixture.

**Security relevance:**
- The test key is only compiled in `cargo test` builds, not in `cargo build --release`. It cannot be extracted from production binaries.
- The key `"my-secret-key-123"` is not a real API key for any external service.
- No real Telegram API credentials, session tokens, or production secrets were found in any source file.

**Additional search results:** A broad search for `api_key`, `apikey`, `api_secret`, `password`, `secret`, `token`, `credential`, `test_password`, `admin123`, `12345`, `test_token`, `dummy` across all `.rs` files found:
- `api_settings.rs:75,76,81` — test key `"my-secret-key-123"` (analyzed above)
- `auth.rs:209-210, 262-264, 299-300, 311-313, 329-341` — `login_token`, `password_token` — these are runtime Telegram auth tokens stored in `Arc<Mutex<Option<...>>>`, not hardcoded. They're populated at runtime from Telegram's API.
- `lib.rs:39-43` — `generate_stream_token()` — generates a random 32-char hex token at runtime using `rand::thread_rng()`. Not hardcoded.
- `lib.rs:239-240` — `login_token: Arc::new(Mutex::new(None))`, `password_token: Arc::new(Mutex::new(None))` — initialized to None, populated at runtime.
- `faststart.rs:471, 480, 523, 527, 554, 563, 598, 602` — `token_data` and `token` — runtime streaming tokens passed as query parameters.
- `build.rs:7, 36` — `"cmd_auth_check_password"`, `"cmd_regenerate_api_key"` — command name strings, not credentials.

**Conclusion:** No real hardcoded credentials were found. The test fixture `"my-secret-key-123"` is benign (test-only, not a real key, compiled only in test builds).

**Fix:** None required. For best practice, consider using a clearly-fake test key like `"test-key-not-real-do-not-use"` to make it unambiguous.

**Blast radius:** None. Test-only code, not in production binary.

**Regression test plan:** N/A.

**Fix safety class:** N/A (cosmetic best practice).

---

### Finding 1.21.5: LOW — Production build serves frontend from `http://localhost:14200` which is accessible to all local processes

**File:** `src-tauri/src/lib.rs:37` (`LOCALHOST_PLUGIN_PORT: u16 = 14200`), `:368` (window URL), `src-tauri/capabilities/default.json:7` (`"urls": ["http://localhost:1420/*", "http://localhost:14200/*"]`)

**Severity:** Low

**Details:**
In production builds, the app uses `tauri-plugin-localhost` to serve the frontend from `http://localhost:14200`. This port is accessible from any process on the local machine.

The `tauri-plugin-localhost` crate by default binds to `localhost` (which on most systems resolves to `127.0.0.1`), not `0.0.0.0`. However, on some systems `localhost` can resolve to `::1` (IPv6 loopback) or even to the machine's network IP if `/etc/hosts` is misconfigured.

The capabilities file (`default.json:7`) allows IPC calls from `http://localhost:14200/*`. This means any web page loaded at that URL could potentially invoke Tauri IPC commands.

**Security relevance:**
- An attacker running a process on the same machine could navigate to `http://localhost:14200` in a browser and view the app's frontend HTML/JS.
- However, Tauri v2's capability system restricts IPC to the `main` window created by the Tauri runtime. A browser tab is NOT a Tauri window, so IPC calls from a browser tab should be rejected.
- The frontend code at `http://localhost:14200` is not secret (it's the same code bundled in the app), but exposing it allows an attacker to study the frontend's IPC call patterns.

**Note:** The prior audit (Finding 1.11.2) already covered this for the localhost plugin. This finding confirms the configuration is unchanged and adds the context that `tauri-plugin-localhost` v2 (Cargo.toml:49: `tauri-plugin-localhost = "2"`) should bind to `127.0.0.1` only, but this should be verified at runtime.

**PoC:**
1. Start the app in production mode.
2. Open a browser and navigate to `http://localhost:14200`.
3. The app's frontend HTML loads. Verify whether IPC calls (e.g., `window.__TAURI_INTERNALS__.invoke(...)`) succeed or fail.

**Fix:**
1. Verify that `tauri-plugin-localhost` binds to `127.0.0.1` explicitly, not `0.0.0.0`.
2. Consider adding a check at startup that verifies the port is not externally accessible (e.g., attempt to connect from a different process).
3. If the port must be open, consider adding a random token to the URL path that the plugin validates.

**Blast radius:** Low — frontend code is visible to local processes, but IPC is window-scoped. An attacker can study the frontend but cannot invoke commands from a browser.

**Regression test plan:**
1. Start the app in production mode.
2. From a different terminal, run `curl http://localhost:14200` — verify the HTML is served.
3. From a browser, open `http://localhost:14200` and attempt `window.__TAURI_INTERNALS__.invoke('cmd_get_stream_config')` — verify it fails.
4. From a different machine on the same network, attempt `curl http://<machine-ip>:14200` — verify it's refused (bound to localhost only).

**Fix safety class:** Safe (verification/configuration change; no functional impact).

---

### Finding 1.21.6: LOW — `tsconfig.json` does not set `noEmit` to `false` for production — but this is correct because Vite handles emission

**File:** `tsconfig.json:14` (`"noEmit": true`), `package.json:8` (`"build": "tsc && vite build"`)

**Severity:** Low (informational — configuration is correct)

**Details:**
The build script is `"tsc && vite build"`:
1. `tsc` runs TypeScript type-checking with `"noEmit": true` — it only checks types, does NOT produce JavaScript output or source maps.
2. `vite build` runs Vite's production build, which bundles and minifies the TypeScript/React code.

This is the standard Tauri+Vite build pattern. `tsc` is used purely as a type-checker gate (if there are type errors, the build fails before Vite runs). Vite handles all actual compilation, bundling, and minification.

**Security relevance:** Because `tsc` has `noEmit: true`, it cannot leak source maps or intermediate files. The only output is from Vite, which (per Finding 1.21.2) should not generate source maps by default.

**Fix:** None required. The configuration is correct.

**Fix safety class:** N/A.

---

### Finding 1.21.7: Informational — `build.rs` uses `.unwrap()` which panics on build failure

**File:** `src-tauri/build.rs:66`

**Severity:** Low (build-time, not runtime)

**Details:**
```rust
// build.rs:66
}).  .unwrap();
```
(Note: the double-dot appears to be a formatting artifact in the source.)

The `tauri_build::try_build(...).unwrap()` will panic if the build fails. This is the standard Tauri `build.rs` pattern — it's not a security issue but means build errors are not gracefully handled.

**Fix:** Use `expect("Failed to build Tauri application")` for better error messages:
```rust
}).expect("Failed to build Tauri application");
```

**Fix safety class:** Safe (cosmetic improvement).

---

### Finding 1.21.8: Informational — No SBOM or dependency vulnerability scanning in CI

**File:** N/A (no CI/CD configuration found in repository)

**Severity:** Low

**Details:**
No CI/CD configuration files were found in the repository (no `.github/workflows/`, no `.gitlab-ci.yml`, no `Jenkinsfile`). There is no automated:
- `cargo audit` (Rust dependency vulnerability scanning)
- `npm audit` (Node.js dependency vulnerability scanning)
- SBOM generation (`cargo cyclonedx`, `npm sbom`)
- License compliance scanning

**Security relevance:** Without automated vulnerability scanning, known CVEs in dependencies may go undetected. The `rar 0.4.0` crate (Cargo.toml:56) was already flagged as unmaintained in the prior audit (Finding 1.10.3).

**Fix:**
1. Add a GitHub Actions workflow that runs `cargo audit` and `npm audit` on every push and PR.
2. Generate SBOM with `cargo cyclonedx` and `npm sbom`.
3. Fail the build on high-severity vulnerabilities.

**Fix safety class:** Enhancement (process improvement).

---

## Summary of Findings by Severity

| Severity | Count | Findings |
|---|---|---|
| **MEDIUM** | 5 | 4.4.1 (cold-start timeout doesn't cancel download), 4.4.2 (unbounded SourceBuffer risk), 1.20.2 (CDN fallback bypasses CSP), 1.21.1 (no `[profile.release]` — symbols not stripped), 1.21.2 (source maps not explicitly disabled) |
| **LOW** | 8 | 4.4.3 (CBR assumption for VBR files), 4.4.4 (plan line-number drift), 4.4.7 (unchecked plan checkboxes), 1.20.3 (no crash reporting), 1.21.3 (debug_assertions — correct), 1.21.4 (test credentials — benign), 1.21.5 (localhost port accessible), 1.21.6 (tsconfig noEmit — correct) |
| **Informational** | 5 | 4.4.5 (prior audit findings open), 4.4.6 (Telegram API assumptions), 1.20.1 (no telemetry — positive), 1.21.7 (build.rs unwrap), 1.21.8 (no CI/SBOM) |

## Priority Fix Order

1. **1.21.1** — Add `[profile.release]` with `strip = true` to Cargo.toml (prevents reverse engineering)
2. **1.21.2** — Explicitly set `build.sourcemap: false` in vite.config.ts (prevents source code leakage)
3. **1.20.2** — Remove unpkg.com CDN fallback in MP4Player.ts (privacy + security)
4. **4.4.2** — Add hard byte-count ceiling to SourceBuffer quota guard (prevents OOM)
5. **4.4.1** — Cancel proactive prebuffer on cold-start timeout (prevents unwanted bandwidth)
6. **1.21.5** — Verify localhost plugin binds to 127.0.0.1 only (local access hardening)
7. **4.4.3** — Use VBR byte-time index for proactive prebuffer (correctness)
8. **1.21.8** — Add `cargo audit` and `npm audit` to CI (vulnerability detection)

---

*End of audit — sections 4.4, 1.20, 1.21.*
