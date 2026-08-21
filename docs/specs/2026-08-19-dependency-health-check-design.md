# External Dependency Health Check — Design Spec

**Date:** 2026-08-19
**Status:** Draft — awaiting user approval
**Branch:** `dev` (v0.6.0)

---

## 1. Problem

Three distinct user-visible defects, all rooted in how NoBuf handles the binaries it does *not* bundle:

1. **Black console windows flash** during playback, seeking, subtitle loading, and hover-scrub. On Windows a GUI-subsystem process that spawns a console-subsystem child gets a new console window per spawn unless `CREATE_NO_WINDOW` is set. **No spawn site in the codebase sets it.**
2. **No component verification.** The app checks only that `ffmpeg.exe` *exists*. A build missing a required encoder/filter/muxer passes today's check and then fails at use-time. As the app adopts new ffmpeg features, an older binary silently breaks a feature with no diagnosis.
3. **Silent failure.** `App.tsx:35` invokes `cmd_ensure_ffmpeg` fire-and-forget; failure lands in `.catch(console.warn)` at `App.tsx:38`. No toast, no banner, no state. The app looks healthy until the user opens a video.

Scope per interview: **every external runtime dependency we don't bundle** — not ffmpeg alone.

---

## 2. Verified Findings

Every claim below was established by execution or by reading source at a cited line. Claims I could not prove are marked **UNPROVEN** and are not designed against.

### 2.1 Console-window bug

| Fact | Evidence | Verdict |
|---|---|---|
| Release builds are GUI-subsystem (no console attached) | `app/src-tauri/src/main.rs:2` `windows_subsystem = "windows"` | VERIFIED |
| Zero spawn sites suppress the console window | repo-wide grep `CREATE_NO_WINDOW\|creation_flags\|CommandExt\|0x08000000` over `app/src-tauri/src` → **0 hits** | VERIFIED |
| 17 spawn sites total; **16 need the fix** | 15 unconditional (ffmpeg/ffprobe) + `network.rs:52` (Windows `ipconfig`); `network.rs:143` is macOS-gated and inert on Windows | VERIFIED |
| `ffmpeg-sidecar` already solves this but is bypassed | `ffmpeg-sidecar-2.5.1/src/command.rs:776` calls `creation_flags(self, 0x08000000)`; NoBuf spawns via raw `std`/`tokio` Command instead | VERIFIED |

**Hot paths that flash repeatedly:** `/thumb` (`server.rs:7592`) fires **per hover-scrub tick** — each tick spawns a redundant `-version` probe *plus* the real ffmpeg = **2 console flashes per tick**. `/subtitles/.../font/{att_idx}` (`server.rs:7491`) fires once per font attachment.

### 2.2 Redundant probe spawns (a second, larger bug found during the audit)

`ffmpeg_util.rs:37` and `:80` call `is_in_path()` unconditionally as Tier 1. `is_in_path` (`:272-280`) spawns a real `<bin> -version` subprocess. **`ffmpeg_util.rs` contains zero memoization primitives** (`grep -cE "OnceLock|LazyLock|lazy_static|static [A-Z]"` → **0**), so every one of ~16 call sites pays a throwaway process.

Counted for one flow — *open an MKV with 2 embedded subtitle tracks + 3 fonts, then seek once*:

| Step | Route (scope proof) | Probes |
|---|---|---|
| Player init | `#[get("/subtitles/{f}/{m}/list")]` `server.rs:6926` → request-scope | 1 |
| Audio track map | `#[get("/audio_tracks/{f}/{m}")]` `server.rs:6353` | 1 |
| Track select | `#[get(".../track/{stream_idx}")]` `server.rs:7049` → `ensure_ffmpeg` `:7141` | 1 |
| Font fetch × 3 | `#[get(".../font/{att_idx}")]` `server.rs:7491` → `ensure_ffmpeg` `:7535` | 3 |
| Hover thumb | `#[get("/thumb/{f}/{m}")]` `server.rs:7592` → `ensure_ffmpeg` `:7666` | 1 |
| Post-seek subtitle repair | same route `:7049` | 1 |
| Background promotion | `promote_complete_subtitles` `server.rs:6493` → `:6504` + `:6539` | 2 |
| **TOTAL** | | **10** |

Floor 4 (no fonts/thumb/promotion). **Ceiling unbounded** — a 30-tick scrub adds ~30 probes / 60 flashes. All 10 are pure waste: the boolean cannot change within a session.

### 2.3 Component detection — the critical false-pass

**`ffmpeg -h encoder=X` returns exit code 0 even when X does not exist.** Measured on the essentials 9.0.1 build:

```
$ ffmpeg -hide_banner -h encoder=libsvtav1
Codec 'libsvtav1' is not recognized by FFmpeg.
Exiting with exit code 0
```

`libsvtav1` and `frei0r` are genuinely absent from that build (`-encoders | grep -c` → 0), yet both "pass" a naive exit-code check. **A naive checker would be worthless.** Same exit-0 behaviour for `filter=`, `muxer=`, `decoder=`.

**Correct method:** parse bulk dumps with an exact-name match:
```bash
ffmpeg -hide_banner -encoders   # then awk '$2==name'
ffmpeg -hide_banner -filters
ffmpeg -hide_banner -muxers
```
Verified to correctly report `libsvtav1 ABSENT` while `libx264/h264_qsv/h264_nvenc/h264_amf/aac PRESENT`.

**Measured cost** (10-run averages, ~100 MB static exe):

| Operation | Cost |
|---|---|
| Process startup floor (`-version`) | 28 ms |
| One `-h encoder=X` (cold) / (warm) | 29 ms / 12 ms |
| Bulk dumps, warm, per dump | 11-16 ms each |
| **All 6 bulk dumps (every component)** | **~74 ms** |
| ~20 individual `-h` queries | ~241 ms |

Bulk parsing is both **correct and ~3.3× faster**. The one-by-one alternative is not merely slower — it is unusable (§2.3 false pass). Decision: **bulk dumps**.

Per-dump warm figures: `-encoders` 11.6, `-decoders` 11.9, `-filters` 15.8, `-muxers` 12.2, `-demuxers` 11.5, `-devices` 10.8 ms.

### 2.4 Hardware encoders: compiled-in ≠ working

All four h264 encoders are present in the binary, but on this machine only two initialize:

| Encoder | Exit | Time | stderr |
|---|---|---|---|
| `h264_qsv` | 0 | 480 ms | — |
| `h264_nvenc` | 127 | 41 ms | `Cannot load nvcuda.dll` |
| `h264_amf` | 171 | 46 ms | `DLL amfrt64.dll failed to open` |
| `libx264` | 0 | 54 ms | — (software floor) |

Proves a real init probe is mandatory; presence parsing alone would wrongly advertise nvenc/amf. Total for all three HW probes: **~621 ms** — acceptable as a background startup task, not on a blocking path.

### 2.5 Dump-parsing traps (found while reviewing this spec)

Three defects in my own first draft, caught by execution against the essentials build:

| # | Trap | Evidence | Consequence if unfixed |
|---|---|---|---|
| **V1** | Substring matching | `grep -c h264` on `-encoders` → **8** hits; `$2=="h264"` → **0** | `contains()` would report a missing `h264` encoder as present |
| **V2** | `-dump_attachment` is not in any dump, and a synthetic probe misuses it | `-dump_attachment:0` against a `lavfi` input errors *"cannot be applied to output url"* | Attempting a synthetic capability probe yields a meaningless result; must check the `-h full` option table instead (line 116 of that output) |
| **V3** | **`lavfi` is a device, not a demuxer** | `-demuxers \| $2=="lavfi"` → **NOT-FOUND**; `-devices \| $2=="lavfi"` → **FOUND** | My original "3 bulk dumps" plan would have **false-failed every healthy build**, blocking playback for everyone |

V3 is the serious one: it would have made the health check reject working ffmpeg installs. Draft said 3 dumps; correct answer is 5 (+`-devices`).

Also confirmed benign: the `srt` name collides across a muxer (SubRip), a protocol (SRT), and a subtitle codec, but `-muxers` `$2=="srt"` resolves unambiguously to `E srt SubRip subtitle`. Same for `ass` → `E ass SSA (SubStation Alpha) subtitle`. No disambiguation needed.

### 2.6 Exit codes are only trustworthy on the runtime path

| Invocation | Exit | Verdict |
|---|---|---|
| `-h encoder=libx264` (present) | 0 | — |
| `-h encoder=libsvtav1` (**absent**) | **0** | **False pass — unusable for detection** |
| `-h filter=frei0r` (**absent**) | **0** | **False pass** |
| Unrecognized option | non-zero | Trustworthy |
| Init probe `libx264` / `h264_qsv` (work) | 0 | Trustworthy |
| Init probe `h264_nvenc` / `h264_amf` (fail here) | non-zero | Trustworthy |
| `ffprobe` on a nonexistent file | 1 | Trustworthy |

Measured via direct `subprocess` calls with no shell pipeline (an earlier shell reading was distorted by piping through `head`, which masked the code — a reminder to measure exit codes without pipes). Windows reports these failures as large unsigned values, so the implementation must use `status.success()`, exactly as `server.rs:2736` already does, rather than comparing numbers.

### 2.10 Manifest completeness — components missed by the first draft

My first manifest was seeded from the `/remux` path only. A systematic sweep of **every** codec/format/filter argument string across `server.rs` and `commands/sprite.rs` (regex over `-c:v`/`-c:a`/`-f`/`-vf`/`-af`/`-vcodec` literals plus filtergraph tokens) found **9 real requirements that were omitted**, all verified present on both local builds:

| Component | Kind | Use site | Consequence of omission |
|---|---|---|---|
| `aformat` | Filter | `AAC_LAYOUT_FILTER` `server.rs:443` — on **every** remux/transcode | Audio filtergraph dies; unchecked |
| `mjpeg` | **Encoder + Muxer** | `/thumb` `server.rs:7686` (`-f mjpeg`); sprite `-vcodec mjpeg` | Hover thumbnails silently never appear |
| `scale` | Filter | `/thumb` `server.rs:7676`; sprite `vf_filter` | Thumbnails/sprites fail |
| `fps`, `pad`, `tile` | Filter | sprite `vf_filter` `sprite.rs:104-107` | Sprite sheet fails |
| `image2pipe` | Muxer | sprite `-f image2pipe` `sprite.rs:116` | Sprite sheet fails |
| `color` | Filter | the lavfi source in the encoder probe (`color=black:s=64x64`) `server.rs:2730` | **The HW capability probe itself** cannot run |

`color` is the subtle one: without it the encoder probe at `server.rs:2727` cannot construct its test input, so the entire hardware-encoder ladder silently degrades to `libx264` — a performance regression with no diagnostic.

**Classification correction:** `mjpeg` is required in **two** dumps (`-encoders` for `-vcodec mjpeg`, `-muxers` for `-f mjpeg`). A single-kind entry would have half-checked it.

**False-requirement rejected:** `copy` appears as `-c:v copy` throughout but is a keyword, not a component (`$2=="copy"` absent from `-encoders` on both builds). Listing it would have failed the check on every healthy install — the same class of bug as V3.

**Process lesson:** the manifest must be derived by sweeping *all* spawn sites, not the primary path. §7.1 adds a guard test that greps the source for codec/format/filter literals and asserts every one is represented in the manifest, so a future feature that adds a component fails the test rather than shipping unverified. This directly serves the original concern — "new updates that use new ffmpeg components".

### 2.7 Pinned, checksum-verified downloads

| Source | Pinnable | Checksum | Resume | Status |
|---|---|---|---|---|
| gyan.dev `packages/ffmpeg-9.0.1-essentials_build.zip` | **Yes** | **Yes** — `.sha256` sidecar | **Yes** — `206` + `Accept-Ranges: bytes` | VERIFIED |
| BtbN `autobuild-YYYY-MM-DD-HH-MM` tags | **Yes** (immutable) | **Yes** — `checksums.sha256` asset | Yes (GitHub CDN) | VERIFIED |
| osxexperts `ffmpeg9arm.zip` | No (unversioned URL) | No sidecar → **we self-pin** | Yes (`206`) | VERIFIED |

**The checksum chain works end-to-end:** the published sidecar `fec81ae0…da2e9` matched the SHA-256 of the archive actually downloaded, byte-for-byte. Exact size 111,253,802 bytes.

**Real sizes — the code comment is wrong.** `ffmpeg_util.rs:152` claims "~45MB zip". Measured: **106 MB zip → 98 MB `ffmpeg.exe` + 98 MB `ffprobe.exe` ≈ 196 MB installed**, ~302 MB peak during extraction.

### 2.8 Platform/arch matrix

| Platform + arch | Source | Native arch | Verdict |
|---|---|---|---|
| Windows x86_64 | gyan.dev pinned + `.sha256` | ✔ | **OK** |
| Windows arm64 | BtbN `winarm64-gpl` | ✔ | OK |
| Linux x86_64 / arm64 | BtbN `linux64-gpl` / `linuxarm64-gpl` (`302` verified) | ✔ | **OK** — preferred over johnvansickle (stale: `Last-Modified 2024-08-24`) |
| macOS x86_64 | evermeet.cx 9.0.1 (`info/ffmpeg/release` JSON) | ✔ Mach-O `0x01000007` | OK |
| macOS **arm64** | **osxexperts `ffmpeg9arm.zip` + `ffprobe9arm.zip`** | ✔ Mach-O `0x0100000c` = ARM64 | **OK — gap closed** |

This mattered: `release.yml:99-101` ships an `aarch64-apple-darwin` build, and evermeet is x86_64-only. Without osxexperts, Apple Silicon users would need Rosetta.

### 2.9 Other external dependencies

| Dependency | Status | Action |
|---|---|---|
| **WebView2 Runtime** (Windows) | App cannot launch without it, so an in-app check can never fire. Tauri 2 **already** defaults to `DownloadBootstrapper { silent: true }` (`tauri-utils-2.9.2/src/config.rs:1000`) — installer bootstraps it at install time | **No change needed.** Your chosen installer fix is already the default; report version in panel only |
| **WebKitGTK 4.1 / GTK3 / libsoup3** (Linux) | External distro packages | Report-only |
| **HEVC Video Extension** | Optional; transcode fallback already covers it | **Excluded** per your decision |
| jassub WASM, pdf.js worker, mpegts/mp4box/mediabunny | **Bundled** by Vite (`?url`/`?worker&url`), emitted into `dist/assets/` | Not external — no check |
| `sqlite`(bundled) / `rar` / `sevenz-rust2` / `zip` | Statically linked or pure Rust | No runtime dep |
| `ureq` + `native-tls` | `native-tls` feature is enabled but **never constructed** (zero `TlsConnector`/`tls_connector` call sites) → rustls+webpki-roots is what runs. On Linux `openssl-sys` is non-vendored (`cc`/`pkg-config`/`vcpkg` deps only) so it still *links* system OpenSSL at build time | Report-only on Linux |
| **VCRUNTIME140.dll / VCRUNTIME140_1.dll** | Debug binary imports both; `STATIC_VCRUNTIME` set **nowhere** in repo or CI. tauri-cli *may* inject it | **UNPROVEN — must test a real installer on a clean VM.** If absent, app won't launch on fresh Windows. Highest-severity open risk |

**Correction to an earlier assumption of mine:** I initially flagged `ifconfig` as a Linux portability bug. **Wrong** — `network.rs:143` is `#[cfg(target_os = "macos")]` (`:140`); Linux reads `/sys/class/net` (`:112`) and needs no external binary. Independently confirmed. No bug.

---

## 3. Locked Decisions

From 24 interview questions across 5 rounds.

| # | Decision |
|---|---|
| D1 | Kill all console windows (16 of 17 sites; 1 is macOS-only) |
| D2 | Verify ffmpeg **components**, not just presence; plus all other non-bundled deps |
| D3 | Run check on **first install + after every app update + manual "Re-check"** in Settings |
| D4 | **PATH ffmpeg wins if it passes every component check** (zero download); else fall to our pinned build |
| D5 | **Pin exact version + checksum**; bump deliberately per release |
| D6 | **Non-blocking banner** with progress; app stays usable during download |
| D7 | Download **resumable + cancellable, survives app restart** |
| D8 | Failure → clear error + **Retry**; app usable for non-video features |
| D9 | **All three platforms** get a working fetch |
| D10 | WebView2 handled at installer level (already default); HEVC excluded |
| D11 | GPU probes: startup background, cached to disk |
| D12 | Degradation: **per-feature** disable + panel summary |
| D13 | Missing ffprobe = **hard fail**, keep previous working install as fallback |
| D14 | Component manifest in **Rust source**, surfaced in the panel |
| D15 | Repair installs to **versioned folder + atomic switch**; old deleted next launch |
| D16 | Concurrency: in-process async lock + on-disk lockfile |
| D17 | Pre-check free disk space before download |
| D18 | Detect AV/SmartScreen quarantine explicitly |
| D19 | UI lives in a new **"Dependencies" section in Settings** |
| D20 | Update detection: compare stored vs current app version |
| D21 | GPL ffmpeg downloaded at runtime is fine; keep `libx264` |
| D22 | Tests: pure-fn units + integration against real binaries + fault injection |

---

## 4. Architecture

### 4.1 Module layout

New Rust modules under `app/src-tauri/src/`:

| Module | Responsibility |
|---|---|
| `no_window.rs` | `CREATE_NO_WINDOW` suppression trait (D1) |
| `deps/manifest.rs` | Required-component manifest + per-feature mapping (D14, D12) |
| `deps/probe.rs` | Bulk-dump parsing, HW init probes, ffprobe check (D2, D11) |
| `deps/fetch.rs` | Per-platform source table, resumable download, checksum verify (D5, D7, D9) |
| `deps/install.rs` | Versioned-folder install, atomic switch, cleanup, lockfile (D15, D16) |
| `deps/state.rs` | Cached health report, version-change detection (D3, D20) |

`ffmpeg_util.rs` keeps its public API (`ensure_ffmpeg`/`ensure_ffprobe`) so the ~16 existing call sites need **no edits** — it gains memoization and delegates resolution to `deps/`.

### 4.2 Console-window fix (D1)

`std::process::Command` and `tokio::process::Command` expose `creation_flags` differently — one is a trait method, the other inherent — so no single generic covers both. A local trait with two impls is the minimal correct shape (verified against `tokio-1.53.1/src/process/mod.rs:669-679`, where `cfg_windows!` expands to `#[cfg(any(all(doc, docsrs), windows))]`, and `ffmpeg-sidecar-2.5.1/src/command.rs:776` for the std path):

```rust
// app/src-tauri/src/no_window.rs
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the console window for a spawned child on Windows. No-op elsewhere.
pub trait NoWindow { fn no_window(&mut self) -> &mut Self; }

impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(self, CREATE_NO_WINDOW);
        self
    }
}

impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);   // inherent on Windows
        self
    }
}
```

Applied to all **16** sites: `ffmpeg_util.rs:273`; `server.rs:2727, 3436, 3727, 3783, 3917, 4220, 6505, 6540, 6867, 7347, 7549, 7679`; `sprite.rs:39, 108`; `network.rs:52`. (`network.rs:143` is macOS-only — skipped; 17 sites exist in total.)

**Cross-platform safety:** the trait compiles on all targets; only the body is `cfg`-gated, so Linux/macOS get an inlined no-op.

### 4.3 Probe-spawn memoization (fixes §2.2)

**Cache successes only.** `OnceLock<Result<..>>` would be a regression, not a fix — see the flaw analysis below.

```rust
use std::sync::{OnceLock, RwLock};

// Cached resolved paths. A missing entry means "not resolved yet" — never "failed".
static FFMPEG_PATH:  RwLock<Option<PathBuf>> = RwLock::new(None);
static FFPROBE_PATH: RwLock<Option<PathBuf>> = RwLock::new(None);
```

Semantics:
1. **Hit** → return the cached `PathBuf` with no subprocess.
2. **Miss** → run the existing 4-tier resolution (one `-version` probe), and store the path **only on success**.
3. **Failure** → store nothing, return `Err`. The next call retries.
4. **After a successful repair/install** → `reset_resolved()` clears both entries so the new binary is picked up without an app restart.

**Why not `OnceLock<Result<..>>` (the flaw in my first draft):**

| t | Event | With `OnceLock<Result>` | With cache-success-only |
|---|---|---|---|
| 0 | `App.tsx:35` starts the 106 MB download | — | — |
| 1 | User opens a video → `ensure_ffprobe()` → binary not yet present | `Err` is **cached permanently** | `Err` returned, nothing cached |
| 60 | Download completes, binary on disk | Every ffmpeg feature **stays broken for the whole session** | — |
| 61 | Next request | Still `Err` | Re-probes, **succeeds** |

Caching the negative would have been **worse than the current code**, which re-probes every call and therefore self-heals once the download lands. This interacts directly with D6 (non-blocking download — the app is *expected* to be usable while ffmpeg is still missing), so the poisoning window is the normal first-run path, not a rare edge.

**Blocking-call analysis (audited, deliberate):** `is_in_path()` uses blocking `std::process::Command` and is reached from ~10 actix `async` route handlers and from `async fn promote_complete_subtitles` (`server.rs:6504`), so each miss blocks an actix worker thread for ~28 ms. Memoization removes essentially all of these (10+ per video open → 1 per process). The first call still blocks once for ~28 ms, which is accepted: converting the API to async would change all ~16 call sites and violate the surgical-change constraint. Recorded as a conscious trade-off, not an oversight.

**Interaction guard (not isolation):** memoization and the console fix must be tested *together* — a cached path that skips `no_window()` on the real spawn would still flash. Test asserts a bound: N video-open cycles ⇒ **exactly 1** resolution probe total, and every real spawn carries the flag. A separate test asserts the self-heal path: fail once, then succeed, and confirm the success is cached and served.

### 4.4 Component manifest (D14, D12)

Rust source, versioned with the app, surfaced read-only in the panel:

```rust
pub struct Requirement {
    pub name:    &'static str,   // exact name as it appears in the bulk dump
    pub kind:    Kind,           // Encoder | Decoder | Filter | Muxer
    pub feature: Feature,        // which app feature dies without it
    pub tier:    Tier,           // Required | Optional
}
```

Seeded from the actual call sites in `server.rs`:

| Feature | Requires | Kind → dump | Tier |
|---|---|---|---|
| Core remux/stream | `mpegts`, `mp4`, `null` | Muxer → `-muxers` | Required |
| Core remux/stream | `aac` | Encoder → `-encoders` | Required |
| Core remux/stream | `aresample`, `asetpts`, `format`, **`aformat`** | Filter → `-filters` | Required |
| Software transcode floor | `libx264` | Encoder → `-encoders` | Required |
| HW accel (per-encoder) | `h264_qsv`, `h264_nvenc`, `h264_amf` | Encoder → `-encoders` **+ init probe** | Optional |
| HW decode | `hevc_qsv` | Decoder → `-decoders` **+ init probe** | Optional |
| HDR tonemapping | `zscale`, `tonemap` | Filter → `-filters` | Optional |
| QSV scaling | `vpp_qsv` | Filter → `-filters` | Optional |
| Subtitle extraction | `srt`, `ass` | Muxer → `-muxers` | Required |
| Subtitle/font source | `matroska,webm` | Demuxer → `-demuxers` (split on `,`) | Required |
| Font extraction | `-dump_attachment` | **Option table** → `-h full` (not a dump) | Required |
| **Hover thumbnails** (`/thumb`) | **`mjpeg`** | **Encoder + Muxer → both dumps** | Required |
| **Hover thumbnails** (`/thumb`) | **`scale`** | Filter → `-filters` | Required |
| **Sprite sheets** (`cmd_generate_sprite_sheet`) | **`image2pipe`** | Muxer → `-muxers` | Optional |
| **Sprite sheets** | **`fps`, `pad`, `tile`, `scale`** | Filter → `-filters` | Optional |
| Encoder capability probe | `lavfi` | **Device → `-devices`** (NOT `-demuxers` — V3) | Required |
| Encoder capability probe | **`color`** (lavfi source used by the probe) | Filter → `-filters` | Required |
| Stream/duration probe | ffprobe `-show_streams -print_format json` | **Real invocation** (not a dump) | Required |

**`copy` is NOT a component.** `-c:v copy` is a stream-copy keyword; `$2=="copy"` is absent from `-encoders` on both builds (verified). The manifest must never list it, or the check would fail on every healthy build.

**All 9 late-found components verified present on both local builds** (`aformat`, `scale`, `fps`, `tile`, `pad`, `color`, `mjpeg` as encoder *and* muxer, `image2pipe`). They were missed in the first draft because I seeded the manifest from the remux path only and did not sweep `/thumb` and `sprite.rs`. See §2.10.

**A missing Required component fails the check. A missing Optional one disables exactly that feature** (D12) and is listed in the panel with the reason.

### 4.5 Detection method (D2 — must avoid the §2.3 false pass)

Component presence is resolved from **bulk dumps only**, matched on the **exact name in column 2**, against the dump matching that component's *kind*:

| Kind | Dump | Verified example |
|---|---|---|
| Encoder | `-encoders` | `libx264`, `aac`, `h264_qsv`, `h264_nvenc`, `h264_amf` all OK |
| Decoder | `-decoders` | `hevc_qsv`, `hevc`, `h264` all OK |
| Filter | `-filters` | `zscale`, `tonemap`, `format`, `aresample`, `asetpts`, `vpp_qsv` all OK |
| Muxer | `-muxers` | `mpegts`, `mp4`, `ass`, `srt`, `null` all OK |
| Demuxer | `-demuxers` | `matroska,webm` (needed for MKV subs/attachments) |
| **Device** | **`-devices`** | **`lavfi`** — see V3 below |

```
5 bulk dumps: -encoders, -decoders, -filters, -muxers, -demuxers  (+ -devices for lavfi)
→ exact match on column 2 per line
→ NEVER `-h encoder=X` (returns exit 0 for absent components — §2.3)
```

**Parser rules, each derived by execution (§2.5):**
- Column 2 is the component name in **both** the 1-flag-column `-encoders` format (`V....D a64multi`) and the 2-flag-column `-filters` format (`.S zscale`, `TS aap`). A `$2 == name` match is correct for both.
- **Never `contains()`**: `grep -c h264` on `-encoders` yields **8** rows; `$2 == "h264"` yields **0**. A substring match would pass a build with no `h264` encoder at all.
- **Kind must match the dump**: `hevc` is PRESENT in `-decoders` but MISSING from `-encoders` on the same build. Querying the wrong dump produces a false pass.
- `matroska,webm` is a single comma-joined dump entry — the demuxer matcher must split on `,` before comparing.

**Verification that is NOT name lookup** (cannot be answered by a dump):

| Check | Method | Why not a dump |
|---|---|---|
| `-dump_attachment` | Presence in `-h full` option table (**V2**) | Input-only option; a synthetic invocation is a usage error, not a capability signal |
| ffprobe JSON writer | `ffprobe -v quiet -print_format json -show_streams <real file>` | Writer availability is not enumerated in any dump |
| HW encoder usability | Real init probe (§2.4) | Compiled-in ≠ working |

**Exit-code semantics — measured, no shell pipeline distortion (§2.6):**

| Path | Exit | Safe to trust? |
|---|---|---|
| `-h encoder=<absent>` | **0** | **NO — false pass.** Never used |
| Unrecognized option | non-zero | Yes |
| Init probe, working encoder (`libx264`, `h264_qsv`) | 0 | Yes |
| Init probe, broken encoder (`h264_nvenc`, `h264_amf`) | non-zero | Yes |
| ffprobe on missing file | 1 | Yes |

Init probes judge success with `status.success()` — matching the existing, correct implementation at `server.rs:2736` — never by parsing a numeric code (Windows returns large unsigned values such as 4294967295 for these failures).

**HW init probes (D11)** run in a background task after the presence pass, cached to disk keyed by `(gpu_id, driver_version, ffmpeg_version)` so later launches are instant and a driver update re-probes automatically. Probe command is exactly the one already in `server.rs:2727` (production args stay a superset). ~621 ms measured, off the critical path.

### 4.6 Resolution order (D4 — resolves the round-1/round-2 contradiction)

```
Tier 1  System PATH ffmpeg  → run FULL component check
          ├─ passes → USE IT (zero download, no 196 MB on disk)
          └─ fails  → record which components failed, continue
Tier 2  Next to executable (sidecar)         → component check
Tier 3  Our pinned build in AppData (versioned dir) → component check
Tier 4  Download pinned build → verify checksum → verify components → install
```

Tier 1 wins **only** on a full pass; otherwise we fall through to our known-good pinned build. The panel always shows which tier is active and, when PATH was rejected, exactly which components it lacked.

### 4.7 Pinned sources (D5, D9)

Compile-time table, one entry per platform+arch, each with URL + expected SHA-256:

| Target | URL pattern | Checksum origin |
|---|---|---|
| `windows/x86_64` | gyan.dev `packages/ffmpeg-<VER>-essentials_build.zip` | published `.sha256` sidecar |
| `windows/aarch64` | BtbN `<tag>/ffmpeg-<n>-winarm64-gpl.zip` | `checksums.sha256` asset |
| `linux/x86_64`, `linux/aarch64` | BtbN `<tag>/…-linux{64,arm64}-gpl.tar.xz` | `checksums.sha256` asset |
| `macos/x86_64` | evermeet.cx `ffmpeg-<VER>.zip` + `ffprobe-<VER>.zip` | self-pinned |
| `macos/aarch64` | osxexperts `ffmpeg9arm.zip` + `ffprobe9arm.zip` | **self-pinned** (no sidecar) |

Target selected via `std::env::consts::OS` / `ARCH`. **A target with no entry reports "unsupported platform — install ffmpeg manually" rather than silently doing nothing** (today's Linux/macOS behaviour).

`.tar.xz` (Linux) extraction: `tar` + `xz2` are **already in `Cargo.lock`** (`tar 0.4.46`, `xz2 0.1.7`, transitively via `zip`), and `lzma-sys` vendors + `cc`-compiles its own source — no new external dependency and no cross-compilation risk.

### 4.8 Download + install pipeline (D6, D7, D8, D13, D15, D16, D17, D18)

```
0. acquire lock: in-process Mutex + on-disk .lock carrying {pid, started_at}   (D16)
   • stale-lock recovery: if the pid is dead OR started_at is older than a
     bounded age, the lock is reclaimed. Otherwise a crash mid-download would
     block every future download permanently.  (R4)
1. pre-check free space >= 350 MB                                             (D17, R3)
2. resume-aware GET: Range: bytes=<partial>-  ->  <archive>.part              (D7)
   • verified: 206 Partial Content + Accept-Ranges: bytes
   • cancellable; .part survives app restart
3. verify SHA-256 of the completed .part                                      (D5)
   • mismatch -> DELETE the .part, retry once from byte 0, then report.
     Never resume a .part that already failed verification.                    (R5)
4. extract to  ffmpeg/<version>.incomplete/
5. verify BOTH binaries present + run the full component check (§4.5)
   • ffprobe missing -> HARD FAIL, previous install left untouched            (D13)
   • (unix) chmod +x before probing
6. publish: remove_dir_all(ffmpeg/<version>) if it exists, rename
   <version>.incomplete -> <version>, then rewrite the ACTIVE pointer         (R1, R2)
7. reset the resolved-path cache (§4.3) so the new binary is served at once
8. mark the previous version dir for deletion on next launch                  (D15)
```

**R1 — plain rename is NOT atomic on Windows (verified).** `std::fs::rename` fails with *"Cannot create a file when that file already exists"* when the destination directory exists — confirmed by execution, unlike POSIX rename-over semantics. A leftover `ffmpeg/<version>/` from an earlier aborted attempt would therefore break publication. The target is removed first, and the *directory swap is not the commit point*.

**R2 — the ACTIVE pointer is the real commit.** A single small file `ffmpeg/ACTIVE` holds the active version string. It is written with the **temp → `sync_all` → rename** pattern already proven in this codebase at `commands/utils.rs:295-305`. Resolution reads ACTIVE; a half-extracted directory is never referenced because ACTIVE still names the old version until the new one has passed every check. Missing/unparseable ACTIVE falls back to tier scanning.

**R3 — disk-space check needs an explicit choice.** `commands/fs.rs:573` documents a deliberate decision to avoid the `sysinfo` crate. Options: (a) `GetDiskFreeSpaceExW` via the already-present `windows-sys` chain, per-platform; (b) add `sysinfo`; (c) skip the pre-check and surface a clear ENOSPC error. **Recommendation: (a)** on Windows plus a clear ENOSPC message elsewhere — no new dependency, honours the existing convention. Flagged as an open decision in §10.

**R4 — stale lockfile recovery is mandatory.** Without it, one crash during a 106 MB download permanently disables installation. PID liveness is detectable on Windows (verified via `tasklist`), and the timestamp bounds the case where a PID has been recycled.

**R5 — corrupt `.part` must never be resumed.** If the upstream artifact is re-cut under the same URL, resumed bytes concatenate into garbage that can never hash correctly; resuming again would loop forever. One clean retry from zero, then a reported failure.

**Why versioned dirs (D15):** Windows locks a running `.exe`, so overwriting `ffmpeg.exe` during active playback fails with a sharing violation. Installing beside the old one and switching the ACTIVE pointer means repair works mid-playback; the old directory is removed next launch when nothing holds it.

**Quarantine/AV detection (D18):** if a binary exists but fails to execute with a permission/not-found error immediately after install, report "antivirus or SmartScreen may have blocked this" with the exact path rather than a generic failure.

**macOS extra steps:** `chmod +x` is required, and a `com.apple.quarantine` xattr may need clearing. Flagged in §7.7 as a Phase-B item to verify on real hardware — not assumed.

### 4.9 Progress reporting — reuse the existing channel

The app already has a mature push-based progress channel; no new mechanism:

- Backend emits via `app_handle.emit(...)` with `ProgressPayload { id, percent, uploaded_bytes, total_bytes, speed_bytes_per_sec }` (`commands/fs.rs:217-223`, emitted e.g. `fs.rs:383`).
- Frontend consumes with `listen<ProgressPayload>('…')` (pattern at `hooks/useFileDownload.ts:41`).

New event `ffmpeg-progress` reuses that exact payload shape, so `DownloadQueue`-style formatting and speed display work unchanged.

### 4.10 Frontend (D6, D19)

| File | Change |
|---|---|
| `hooks/useDependencyCheck.ts` *(new)* | Mirrors `useUpdateCheck.ts` shape: `{checking, healthy, missing[], downloading, progress, error}` + `recheck()`/`install()`/`cancel()`; `listen('ffmpeg-progress')` effect |
| `components/DependencyBanner.tsx` *(new)* | Non-blocking top banner modelled on `UpdateBanner.tsx` (76 lines) — same `AnimatePresence` + `motion.div`, same `w-32 h-2 bg-white/30` progress track, warning-tone gradient |
| `components/dashboard/SettingsPage.tsx` | **Add one `settings-card` "Dependencies" section**, matching the existing VPN Status card at `:805-834` (`settings-card` / `settings-icon-box` / `settings-card-title` / `settings-card-desc`, secondary button style from `:825`) |
| `App.tsx:35-38` | Replace fire-and-forget `invoke("cmd_ensure_ffmpeg").catch(console.warn)` with the hook, so failures surface instead of vanishing |

**UI constraints honoured:** no native `<select>`; CSS columns not grid; chips active = full colour + white text, inactive = transparent + gray border; `--color-nobuf-*` tokens only; collapsible detail lists use **conditional rendering**, never `max-height` transitions. Changes are additive — no existing component is restyled, relocated, or redesigned.

---

## 5. Phasing

Two phases (my call on the delegated question). Rationale: Phase A fixes what the user actually sees today and is independently shippable; Phase B is the largest chunk and carries the only hardware-dependent unknowns.

### Phase A — Windows, visible defects (ship first)

| Item | Why in A |
|---|---|
| `no_window.rs` + 16 call sites | Kills the console flashing (the reported symptom) |
| `ensure_*` memoization | Removes 10 wasted processes per video open; unbounded on scrub |
| Component manifest + bulk-dump probe | The actual health check |
| Windows pinned source + checksum + resumable download | Already fully verified end-to-end |
| Versioned install, atomic switch, lockfile, disk pre-check | Correct install semantics |
| Banner + Settings "Dependencies" section | Makes silent failure visible |
| HW init probes, cached | Correct encoder advertisement |

Phase A is complete and useful on its own: a Windows user gets no console windows, a real health check, and honest errors.

### Phase B — Linux + macOS fetch

| Item | Risk |
|---|---|
| BtbN linux64/linuxarm64 `.tar.xz` fetch + extract | Low — `tar`/`xz2` already vendored in `Cargo.lock` |
| evermeet x86_64 + osxexperts arm64 fetch | Medium — separate ffmpeg/ffprobe archives per arch |
| `chmod +x` + quarantine xattr handling | **Must be validated on real macOS hardware** |
| Linux/macOS report-only rows (WebKitGTK, OpenSSL) | Low |

Phase A does not regress Linux/macOS: they behave exactly as today (system ffmpeg or an honest "unsupported platform" message) until B lands.

---

## 6. Edge Cases

Each row is a real failure mode with a defined behaviour. No "probably fine".

| # | Case | Behaviour |
|---|---|---|
| E1 | No internet / DNS failure | Banner: clear error + **Retry**; app fully usable for non-video features (D8) |
| E2 | Source host down or 404 (version pulled) | Same as E1, message names the source |
| E3 | Corporate proxy / TLS interception | Surfaced as a transport error with the host name |
| E4 | **Checksum mismatch** | Delete download, never install, report integrity failure + Retry (D5) |
| E5 | Download interrupted mid-transfer | `.part` retained; next attempt resumes via `Range` (D7, `206` verified) |
| E6 | App closed during download | `.part` survives restart; resumes (D7) |
| E7 | User cancels | Cancellation token aborts; `.part` kept for later resume |
| E8 | **Two callers request download at once** | In-process mutex + on-disk lockfile ⇒ exactly one download (D16) |
| E9 | Second app instance | On-disk lockfile prevents duplicate 106 MB fetch (D16) |
| E10 | Disk full / insufficient space | Pre-checked ≥ 350 MB; refuse with the required figure (D17) |
| E11 | **ffprobe missing from archive** | HARD FAIL; previous working install retained (D13) — fixes today's bug at `ffmpeg_util.rs:250` where this returns success |
| E12 | Archive layout differs (nested dir) | Extract by filename match, not by fixed path (matches current `:216` behaviour) |
| E13 | **Repair clicked during active playback** | Versioned dir + atomic switch; running `.exe` never overwritten (D15) |
| E14 | Old version dir locked at cleanup | Deletion deferred to next launch; never fatal (D15) |
| E15 | **AV/SmartScreen quarantines the binary** | Specific "antivirus may have blocked this" message with path (D18) |
| E16 | PATH ffmpeg present but missing components | Fall through to pinned build; panel lists exactly which components failed (D4) |
| E17 | PATH ffmpeg passes fully | Use it, download nothing (D4) |
| E18 | Optional component missing (e.g. `zscale`) | Disable only HDR tonemapping; core playback unaffected (D12) |
| E19 | HW encoder compiled-in but fails init | Ladder falls to next encoder, then `libx264`; panel shows real capability (§2.4) |
| E20 | GPU driver updated after a cached probe | Probe cache keyed on driver version ⇒ automatic re-probe (D11) |
| E21 | App updated | Stored-vs-current version mismatch triggers re-check (D3, D20) |
| E22 | Pinned ffmpeg version bumped in a release | Treated as a new install; old dir deleted after new one verifies (D15) |
| E23 | Unsupported platform/arch | Honest "install ffmpeg manually" message instead of silent no-op |
| E24 | Corrupt/truncated archive that still hashes? | Impossible — SHA-256 gate precedes extraction (E4) |
| E25 | Manifest gains a component in a future release | Version-change re-check catches it; existing binary re-verified (D3, D14) — **this is the original concern** |
| E26 | **Component looked up in the wrong dump** | Manifest binds each entry to its kind→dump pair; `hevc` (decoder-only) can never be checked against `-encoders` (§2.5 V1/kind trap) |
| E27 | **`lavfi` checked as a demuxer** | Would false-fail every healthy build. Bound to `-devices` (§2.5 V3) with a regression test |
| E28 | Bulk dump format differs between ffmpeg majors (8.x vs 9.x) | Parser reads column 2 and is verified against **both** local builds (8.1.1 full, 9.0.1 essentials); a future major that changes the format fails loudly on the required-component check rather than silently |
| E29 | Comma-joined demuxer names (`matroska,webm`) | Matcher splits on `,` before comparing (§2.5) |
| E30 | Exit code compared numerically instead of `status.success()` | Windows returns large unsigned codes (e.g. 4294967295) for init failures; spec mandates `status.success()` (§2.6) |
| E31 | ffmpeg present but **ffprobe is a different version** (mixed PATH install) | Both binaries' `-version` recorded; mismatch surfaced in the panel as an advisory (they are released as a matched pair) |
| E32 | Health check itself spawns console windows | The check runs through the same `no_window()` path as production spawns; §7.4 asserts every spawn carries the flag |
| E33 | **Resolution fails while the download is still running** (normal first-run) | Only successes are cached, so the next call re-probes and self-heals once the binary lands (§4.3). Caching the `Err` would have broken the whole session |
| E34 | **Leftover `ffmpeg/<version>/` from an aborted attempt** | Target removed before rename — plain rename fails on Windows when the target exists (**verified**: `FileExistsError`), so R1 pre-clean is mandatory |
| E35 | Crash/power loss mid-publish | ACTIVE pointer still names the old version, so a half-extracted dir is never used (R2); it is cleaned on next launch |
| E36 | **Crash mid-download leaves a stale lockfile** | Lock carries `{pid, started_at}`; a dead PID or an over-age timestamp reclaims it. Without this, one crash permanently disables installation (R4) |
| E37 | **Upstream artifact re-cut under the same URL** while a `.part` exists | Resumed bytes can never hash correctly; `.part` is discarded and retried once from zero rather than resumed forever (R5) |
| E38 | Missing/corrupt ACTIVE pointer | Falls back to tier scanning; never a hard failure (R2) |
| E39 | `mjpeg` present as muxer but absent as encoder (or vice versa) | Checked in **both** dumps as two manifest entries (§2.10) |
| E40 | `color` filter missing | The HW encoder probe cannot build its lavfi source, so the ladder silently degrades to `libx264`. Now a Required manifest entry (§2.10) |

---

## 7. Test Plan (D22)

Three layers. Isolation alone proves nothing about interaction, so cycles are tested together with asserted bounds.

### 7.1 Pure-function unit tests (Rust)

Bound to the **shipped exported functions** — no test-local reimplementations (those are vacuous).

- Bulk-dump parser: exact-name match; **must report `libsvtav1` ABSENT from a real essentials dump** (the §2.3 false-pass regression test) and `libx264`/`h264_qsv` PRESENT.
- Parser rejects substring/prefix false positives (`$2=="h264"` → 0 hits where `contains("h264")` → 8; §2.5 V1).
- **Kind binding**: `hevc` resolves PRESENT against `-decoders` and MISSING against `-encoders` — asserts a manifest entry can never be checked against the wrong dump (E26).
- **`lavfi` regression test**: found in `-devices`, absent from `-demuxers` — guards the false-fail-everything bug (§2.5 V3, E27).
- Comma-joined demuxer entry `matroska,webm` matches the requirement `matroska` after splitting (E29).
- Parser verified against **both** local builds (8.1.1 full 1-flag-column and 9.0.1 essentials) to cover format drift (E28).
- Manifest → feature mapping: missing Optional disables exactly one feature; missing Required fails the check.
- Platform/arch → source-table selection for all six targets; unsupported target returns the explicit error.
- Version-change detection: equal versions skip, differing versions re-check.
- Resume offset arithmetic: `.part` size → correct `Range` header start byte.

### 7.2 Integration tests against real binaries

Run against both local builds (full 8.1.1 on PATH, essentials 9.0.1) — presence must be *derived by execution*, never hardcoded:

- Full component check passes on both builds (both were verified to contain every required component).
- HW init probe correctly reports nvenc/amf as **non-functional on this machine** while qsv/libx264 succeed (§2.4) — asserts real capability, not compiled-in presence.
- ffprobe `-show_streams -print_format json` returns parseable JSON.
- `-dump_attachment` bounded invocation succeeds.

### 7.3 Fault-injection tests

| Injected fault | Asserted outcome |
|---|---|
| Truncated archive | Checksum mismatch → no install, previous install intact |
| Wrong checksum in table | Refuses install |
| Archive with `ffmpeg` but **no `ffprobe`** | Hard fail; previous install still active (E11) |
| Archive with an *older* ffmpeg lacking a required component | Install rejected after component verification |
| Simulated mid-download abort | `.part` resumes to a byte-identical, checksum-valid file |
| **`.part` that fails checksum** | Discarded and retried from zero **once**; never resumed again (E37, R5) |
| Two concurrent install requests | Exactly one download performed (E8) |
| **Lockfile with a dead PID** | Reclaimed; install proceeds (E36, R4) |
| **Lockfile with a live PID** | Second caller waits/declines; no duplicate download |
| **Pre-existing `ffmpeg/<version>/` at publish time** | Removed then renamed — asserts the R1 Windows `FileExistsError` path (E34) |
| Publish interrupted before ACTIVE is rewritten | Old version still resolves; no partial adoption (E35) |
| Corrupt/absent ACTIVE pointer | Falls back to tier scan (E38) |
| Locked target directory | Deferred cleanup, no crash (E14) |

### 7.3b Manifest-completeness guard (prevents the §2.10 class of bug)

A test greps `server.rs` + `commands/sprite.rs` for every `-c:v`/`-c:a`/`-c:s`/`-f`/`-vf`/`-af`/`-vcodec` string literal and every filtergraph token, then asserts each extracted name is either (a) present in the manifest, or (b) on an explicit allow-list of non-components (`copy`, and pixel-format/option values). **A future feature that introduces a new ffmpeg component fails this test** instead of shipping unverified — the direct answer to "new updates that use new ffmpeg components".

### 7.4 Interaction bound (memoization × console suppression)

Not two green isolated paths. One test drives **N video-open cycles** and asserts:
1. Resolution probes spawned across all N cycles == **1** (memoization holds).
2. Every spawned command carries `CREATE_NO_WINDOW` on Windows (suppression not bypassed by the cached path).

### 7.5 Mutation testing (mandatory)

For every fix: revert it, confirm the tests **fail**, then restore byte-identically (respecting each file's existing LF/CRLF). Specifically:
- Remove `no_window()` from one spawn site ⇒ suppression test must fail.
- Remove the `OnceLock` ⇒ probe-count bound must fail.
- Swap exact-match for `contains()` in the parser ⇒ false-positive test must fail.
- Downgrade ffprobe hard-fail to a warning ⇒ E11 test must fail.

### 7.6 Gates

`npx tsc --noEmit` · `npx vitest run` · `cargo test --no-default-features`

**Note:** CI currently runs only `npm ci`, `npx tsc --noEmit`, and `npm test` (`.github/workflows/test.yml:35-43`) — **there is no `cargo test` step**. This feature is Rust-heavy, so its tests would not run in CI as configured. Recommend adding a `cargo test` step; flagged as a decision, not silently assumed.

### 7.7 Manual verification (cannot be automated)

1. **Release build on a clean Windows VM** — confirm zero console windows during: video open, seek, hover-scrub across the timeline, subtitle track switch, font load. This is the actual acceptance test for the reported symptom.
2. **VCRUNTIME140 (§2.9, UNPROVEN)** — install a real MSI/NSIS on a VM with no VC++ redist and confirm the app launches. If it fails, `STATIC_VCRUNTIME=true` must be set in the release workflow. **No in-app check can ever cover this** — the process dies before our code runs.
3. **macOS Gatekeeper (Phase B)** — verify a downloaded, `chmod +x`'d ffmpeg actually executes on real hardware, both Intel and Apple Silicon.

---

## 8. Out of Scope

- HEVC Video Extension detection/prompting (D10 — transcode fallback already covers it).
- Bundling ffmpeg into the installer (runtime download keeps NoBuf's licensing clean; D21).
- WebView2 install-mode changes — **already** Tauri's default (§2.9); no config change would alter behaviour.
- Refactoring the ~16 `ensure_*` call sites: the public API is preserved deliberately, so no call site changes.
- Any change to playback, seeking, or subtitle logic. This feature adds verification and visibility only.

---

## 9. Acceptance Criteria

1. No console window appears during any ffmpeg/ffprobe/ipconfig operation in a release build (§7.7.1).
2. A single video-open flow spawns **exactly one** path-resolution probe, not 10 (§7.4).
3. A build missing a required component is **detected before use**, not at failure time, and the panel names the component.
4. A PATH ffmpeg that passes every check is used with **zero** download (D4/E17).
5. Downloads are pinned, checksum-verified, resumable across restarts, and cancellable (D5/D7).
6. Missing ffprobe never reports success (E11).
7. Repair during active playback succeeds without a sharing violation (E13).
8. Every failure path shows a user-visible message with a Retry affordance — no silent `console.warn` (E1-E3).
9. All gates green, every fix mutation-tested (§7.5).

---

## 10. Open Decisions

Two items I will not decide silently.

| # | Decision | Options | My recommendation |
|---|---|---|---|
| O1 | **Disk-space pre-check mechanism** (R3). `commands/fs.rs:573` records a deliberate choice to avoid the `sysinfo` crate, so D17 has no free implementation. | (a) `GetDiskFreeSpaceExW` on Windows via the existing `windows-sys` chain + clear ENOSPC elsewhere; (b) add `sysinfo`; (c) drop the pre-check, report ENOSPC only | **(a)** — no new dependency, honours the existing convention, and Windows is the Phase-A target |
| O2 | **`cargo test` in CI.** `.github/workflows/test.yml:35-43` runs only `npm ci`, `tsc --noEmit`, `npm test`. This feature is Rust-heavy, so none of its tests would run in CI. | (a) add a `cargo test` step; (b) leave CI as-is and rely on local gates | **(a)** — otherwise the fault-injection and manifest-guard tests never run automatically |

Both are additive; neither blocks starting Phase A.

---

## 11. Review Log

Corrections made during adversarial self-review, each caught by execution rather than reasoning:

| Finding | Class | Would have caused |
|---|---|---|
| V3 `lavfi` is a device, not a demuxer | **Blocker** | Health check false-fails **every** healthy install -> playback blocked for all users |
| 4.3 `OnceLock<Result>` caches failures | **Blocker** | First-run download completes but every ffmpeg feature stays broken for the session - worse than the current code |
| R1 `rename` fails when target exists on Windows | **Blocker** | Install cannot publish after any aborted attempt |
| 2.10 nine components missing from the manifest | **Major** | Thumbnails/sprites/HW-probe break unchecked; the `color` omission silently degrades all HW encoding |
| R4 no stale-lock recovery | **Major** | One crash permanently disables installation |
| R5 corrupt `.part` resumed forever | **Major** | Infinite retry loop on a re-cut upstream artifact |
| V1 substring matching | Correctness | `contains("h264")` -> 8 false hits vs 0 exact |
| V2 `-dump_attachment` probed synthetically | Correctness | Usage error mistaken for a capability verdict |
| Wrong-dump kind binding | Correctness | `hevc` false-passes as an encoder |
| `copy` treated as a component | Correctness | Check fails on every healthy build |
| Timing inflated (87 ms / 6.7x) | Honesty | Real: **74 ms / 3.3x** |
| Site count 17 -> **16 of 17** | Accuracy | Overstated scope |

Twelve defects, three of them blockers that would have shipped a feature worse than the bug it fixes.
