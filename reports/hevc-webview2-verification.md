# HEVC in WebView2 — Empirical Verification Report

Date: 2026-07-28 · Machine: Windows 10/11, Intel Iris Xe (driver 32.0.101.7088), WebView2 Runtime 138.0.3351.83, **no** HEVC Store extension installed.

## Method

Launched the actual built app (`app/src-tauri/target/debug/app.exe`) with:

```
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--enable-features=PlatformHEVCDecoderSupport --remote-debugging-port=9223'
```

Verified via `Win32_Process` that the browser process command line contained
`--enable-features=PlatformHEVCDecoderSupport` (it did — Tauri/WebView2 accepted the env var).
Then evaluated capability probes inside the real page (`http://localhost:1420/`, secure context) via CDP `Runtime.evaluate`.

## Results

| Probe | Result |
|---|---|
| `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')` (Main) | **false** |
| `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.4.L120.90"')` (Main10) | **false** |
| `hev1` variants (Main / Main10) | **false** |
| `canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"')` | `""` |
| `navigator.mediaCapabilities.decodingInfo` (media-source, Main10 1080p) | **false** |
| `VideoDecoder.isConfigSupported({codec:'hvc1.1.6.L120.90', hardwareAcceleration:'prefer-hardware'})` | **false** |
| `VideoDecoder.isConfigSupported` Main10 hvc1/hev1 | **false** |
| Control: `avc1.640028` via MSE | **true** (probe valid) |
| Control: WebCodecs available at all | yes (`VideoDecoder` is a function in secure context) |

Note: `VideoDecoder` is `undefined` on non-secure contexts (`chrome-error://` page during app boot) — probes must run on `http://localhost` (treated as secure).

## Conclusions

1. **WebView2 follows Edge's media stack, not Chrome's.** Chrome uses `D3D11VideoDecoder`/D3D11VA directly (no OS codec needed, default since 107 — per [StaZhu/enable-chromium-hevc-hardware-decoding](https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding): "Chrome uses D3D11VideoDecoder to call D3D11VA (no need to install anything)… Edge uses VDAVideoDecoder to call MFT (need to install HEVC Video Extension)"). Our GPU supports HEVC Main10 HW decode, yet everything reports unsupported → WebView2 gates HEVC on the **Media Foundation HEVC MFT**, i.e. the "HEVC Video Extensions" Store app.
2. **`--enable-features=PlatformHEVCDecoderSupport` does NOT unlock HEVC in WebView2 138.** Empirically confirmed — flag applied, still false across MSE, canPlayType, MediaCapabilities and WebCodecs.
3. **WebCodecs is NOT an escape hatch in WebView2.** `VideoDecoder` HEVC support is gated by the same platform check → a MP4Box.js→VideoDecoder→canvas tier would still fail on machines without the extension.
4. **Free OEM extension ("HEVC Video Extensions from Device Manufacturer", 9n4wgh0z6vhq) is delisted.** `winget search --id 9n4wgh0z6vhq -s msstore` → no package (also the paid ID 9nmzlz57r3t7 is not winget-searchable). Reddit/tenforums confirm the free listing was closed (2020) and is only obtainable via unofficial archived appx packages — not something an app should automate.
5. **Related WebView2Feedback issues**: [#4285](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4285) (open, 2024) — HEVC blank screen on Win Pro/Workstation *even with* the extension, works on Home; confirms HEVC-in-WebView2 is extension-dependent and flaky per-SKU. No newer HEVC issues found via issue search (`HEVC`, `hvc1`, `isTypeSupported`).

## Implications for NoBuf

- Platform/native HEVC via MSE: only works if the user has the (paid) Store extension → can be **detected** at runtime (`isTypeSupported`) and used opportunistically, but cannot be the baseline.
- WebCodecs HEVC tier: dead on arrival on extension-less machines (same gate).
- **The only universal free path is native decode outside the webview** → ffmpeg (transcode HEVC→H.264, or decode-only pipelines). ffmpeg is already integrated in the app (`ffmpeg_util.rs`, system PATH).
- Optional nicety: if `isTypeSupported('hvc1…')` is true at runtime (user has extension), skip transcoding and play HEVC directly through the existing MP4Box.js MSE path — zero extra cost.

## Sources / evidence

- Live CDP probes (this machine, this app) — see `reports/cdp_hevc_probe.py`.
- https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding (fetched 2026-07-28)
- https://github.com/MicrosoftEdge/WebView2Feedback/issues/4285 (GitHub API, open, labeled bug)
- GitHub issue search `repo:MicrosoftEdge/WebView2Feedback HEVC / hvc1 / isTypeSupported`
- winget msstore queries for 9n4wgh0z6vhq / 9nmzlz57r3t7 (2026-07-28)
