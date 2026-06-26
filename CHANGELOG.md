# Changelog

All notable changes to NoBuf will be documented in this file.

## [0.6.0] - 2026-06-26

### Bug Fixes

- Mock navigator for CI — sanitizeFilename tests pass in Node

### Features

- Upstream feature parity — 23 features from v1.9.5

## [0.5.0] - 2026-06-24

### Bug Fixes

- Restore mux.js behavior & HLS TS/playlist fixes
- Eviction resume must not jump ahead of eviction cut point; reduce TS-SYNC-ALIGN spam
- Cold-start overlay actually fills shadow cache instead of bailing out
- VBR byte-to-time mapping for eviction resume, cut lazyLoad spam, harden findByteForTime
- Cap in-memory buffer ahead at QUOTA_KEEP_AHEAD to stop white bar fluctuation
- Stop suppressing lazyLoad when interceptor pacing is active; use VBR-aware local bitrate
- Stop progressive resume from fighting lazyLoad at the buffer ceiling
- Suppress premature lazyLoad suspends based on real SourceBuffer, not internal endDTS
- Remove broken local-bitrate pacing and use global average bitrate
- Serialize TS unbuffered seek flush with pending MSE operations
- Keep disk cache contiguous on VBR lazyLoad resume to stop white-bar fragmentation
- **tests:** Export findTimeForByte and remove stale JSDoc block
- Pass playbackRate to cmd_report_playback_position, integrate VBR samples in computeResumeByte, and update stale buffer-window comments
- **cold-start:** Keep overlay visible until real 10s buffer is ready
- **streaming:** Cold-start one-shot fetch, continuous prebuffer, serve-limit enforcement, seek/eviction-resume stability
- **cold-start:** Overlay stays until real SourceBuffer has runway, not just 5MB
- **cold-start:** Initialize mpegts.js in parallel with cold-start so 5MB downloads straight into the video stream

### Documentation

- Update CHANGELOG.md for v0.4.7
- Update CHANGELOG.md for v0.5.0

### Enhancements

- Update useMSEPlayer.ts
- Update useMSEPlayer.ts
- Update useMSEPlayer.ts
- Update streaming.rs
- Update FastStreamPlayer.tsx
- Update useMSEPlayer.ts
- Update server.rs
- Update package.json

### Features

- Add responsive UI and mobile sidebar behavior
- Add agent skills, TS/MKV plans and faststream updates
- Add proactive disk prebuffer and MSE fixes
- Add cold-start No Buffer optimization overlay design spec
- Add implementation plan for cold-start overlay
- Add cachedRunFrom helper for cold-start progress
- Cold-start buffer gate and state in useMSEPlayer
- Render cold-start optimization overlay in FastStreamPlayer
- Smooth 300ms fade-out for cold-start overlay
- **buffer:** Quota guard enforces 180s ahead / 60s behind window
- **buffer:** High-bitrate fallback shrinks behind window while keeping 180s ahead
- **buffer:** Raise all resume-path serve limits from 150s to 180s
- **buffer:** Disk-cached seek fills 180s ahead instantly with VBR-aware byte offset
- Add API throttling and fMP4 keyframe endpoint

### Other

- PTS duration, buffering & mpegts fixes
- Make /stream cache-only; enhance prebuffer
- 180s ahead / 60s behind in-memory buffer policy
- 180s/60s buffer policy implementation steps
- Revert "fix(cold-start): keep overlay visible until real 10s buffer is ready"
- Add no-rewrite init-prefix and stream fixes
- Yield proactive prebuffer and gate cold-start playback
- Use byteOffset for VBR-aware seeking/reporting
- Handle backward seeks and cancel zombie downloads
- Serialize downloads, add media cache & source_id

### Performance

- Improve MSE eviction, DTS & resume recovery
- Improve TS streaming, resume & cold-start
- Improve streaming seek behavior and chunk size
- Improve streaming rate-limiting and seek behavior
- Improve proactive prebuffering and playback UI

## [0.4.7] - 2026-05-27

### Documentation

- Update CHANGELOG.md for v0.4.6

### Other

- Enable PNA CORS and prefer HTTP base_url

## [0.4.6] - 2026-05-26

### Bug Fixes

- Force-create local tag and remove hardcoded highlights

### Performance

- Improve stream protocol and proxy handling

## [0.4.5] - 2026-05-26

### Other

- Use videoStreamUrl for thumbnail extraction

## [0.4.4] - 2026-05-26

### Bug Fixes

- Use --strip instead of --strip-header for git-cliff v2.13.1

### Documentation

- Update CHANGELOG.md for v0.4.3

### Enhancements

- Update release.yml

### Features

- Add nobuf-stream protocol proxy and deps

### Other

- Modernize README: v0.4.1 badge, updated screenshots, new features (exit options, video player settings)

## [0.4.3] - 2026-05-26

### Bug Fixes

- Fetch full git history for git-cliff changelog generation
- Skip DMG bundling on macOS to avoid intermittent hdiutil failure
- Rewrite changelog generation using orhun/git-cliff-action@v4

### Documentation

- Update CHANGELOG.md for v0.4.2

### Other

- Register Tauri commands and add permissions
- Normalize screenshot filenames and replace assets

## [0.4.2] - 2026-05-26

### Documentation

- Update CHANGELOG.md for v0.4.1

## [0.4.1] - 2026-05-26

### Documentation

- Update CHANGELOG.md for v0.4.0

## [0.4.0] - 2026-05-26

### Bug Fixes

- Include Copilot-style commits in changelog and reduce noise

### Documentation

- Update CHANGELOG.md for v0.3.2

### Enhancements

- Update default.json

### Features

- Add localhost plugin and streaming robustness
- Add faststart MP4 streaming and CI tweaks

## [0.3.2] - 2026-05-24

### Bug Fixes

- Use taiki-e/install-action to install git-cliff into PATH

### Features

- Add background continuation, folder reorder, MSE fixes

### Performance

- Improve video UI and MSE tail-fetch logic

## [0.3.1] - 2026-05-24

### Bug Fixes

- Use orhun/git-cliff-action instead of manual binary download

### Features

- Add folder sync/rename/delete reconciliation, update deps, and rename branding to NoBuf

### Other

- Generate changelogs in release workflow

## [0.2.1-beta] - 2026-05-24

### Enhancements

- Update release.yml

### Features

- Add localhost plugin & programmatic frontend window

### Other

- Support MSI numeric versioning; add README tip

## [0.2.0-beta] - 2026-05-23

### Enhancements

- Change GitHub workflows to manual dispatch

### Features

- Introduce NoBuf green theme & settings UI

### Refactor

- Rename project branding to NoBuf

## [0.1.0-beta] - 2026-05-23

### Bug Fixes

- Fix Tauri identifier and Linux dependencies
- Fix tauri script for Windows compatibility
- Fix workflow: Remove explicit ARM target, macos-latest is ARM natively
- Add missing 2FA password form in AuthWizard (#2)
- Resolve EGL_BAD_ALLOC crash on Arch Linux AppImage
- AppImage EGL patch step + bump to v1.1.4
- Repair AppImage patch CI step + bump to v1.1.5
- Graceful Ctrl+C shutdown + bump to v1.1.6
- Fix file grid selection
- Resolve PDF streaming port conflict and bump version to v1.1.9
- Fix seek-to-end edge cases, add parallel download pool, improve MSE buffer management

### Documentation

- Fix screenshot paths and rename for clarity
- Rename and add media playback screenshots
- Expand prerequisites with detailed dependencies and build instructions

### Enhancements

- Update workflow: Remove macOS Intel, add ARM64 target with signing support
- Update package.json
- Update FastStreamPlayer.tsx
- Update FastStreamPlayer.tsx
- Update TopBar.tsx

### Features

- Add project README
- Create FUNDING.yml
- V0.4.0 release - Flood Wait Protection, Keyboard Shortcuts, and macOS Binary
- Implement media preview navigation and caching in Dashboard and PreviewModal (#6)
- Add donation modal to login screen
- Add FastStream player integration with HLS support
- Add MSE player, fragment store, skills, CORS
- Add sprite-sheet generation & hover thumbnails
- Add LRU thumbnail sections and prefetching
- **cache:** Add StreamCacheManager module with disk cache types and tests
- **cache:** Register StreamCacheManager in Tauri state with cleanup on exit
- **cache:** Streaming server writes bytes to disk cache during playback
- **cache:** Cmd_download_file checks cache first, uses cached ranges
- **cache:** Add background cache, status, and delete commands
- Add skills and streaming/download improvements
- Add QA skill and CI workflow for Telegram-Drive
- Add video player settings & skip feedback
- Add cache session and VideoCacheDialog
- Add bandwidth throttling and UI controls
- Add DownloadPool & progressive chunking docs
- Add CI release inputs & logo/assets

### Miscellaneous Tasks

- Release 0.3.0: Multi-move, Preview Fixes
- Remove error html files and add to gitignore
- Add v1.0.1 DMG and update Cargo.lock
- Add automated release workflow with signing
- Bump version to 1.1.10 and fix media streaming port conflict and peer cache performance
- Release v1.3.1
- Release v1.3.2
- Bump Tauri dependency versions

### Other

- Initial commit of Telegram Drive
- Add x86_64 Mac Support (macos-13 runner) & Set Deployment Target to 10.13
- Disable Apple signing for unsigned builds
- Hotfix v1.1.1: Fix sidebar folder list overflow
- Refactor thumbnail extractor; remove aborts
- Refactor progress bar UI and thumbnail extractor
- Make thumbnail extractor buffer-aware and robust
- Show thumbnail coverage & simplify extractor
- Display downloaded buffer ranges in player
- Write downloads to disk cache & show cached ranges
- UI improvements: list view checkboxes, sticky sort bars, cleanup
- Serialize cache meta and update cache per-chunk
- Serialize Telegram downloads with semaphore
- Prevent meta corruption during cache writes
- Prevent cache deletion; improve meta recovery
- Accurate VBR byte→time mapping and buffer UI
- Refactor thumbnail hover & extractor logic
- Pin @tauri-apps/cli to ~2.10.0
- Honor pause state for prefetch and seeks
- UI improvements: settings search, keyboard shortcuts, transfer panel, layout toggle persistence, upload/download cleanup
- Prevent duplicate downloads and handle cache UI
- Return deletion status for stream cache
- Increase cache deletion retries and delays
- Rewrite README with banner, docs, and images

### Performance

- Improve MSE player robustness and logging
- Improve prebuffering, cache meta handling & logs
- Refine FastStreamPlayer controls and download UI

### Refactor

- Rename project from Telegram Drive to nobuff

### Removed

- Remove debug logging from player & MSE hook
- Delete Reference-FastSyream-repo

<!-- generated by git-cliff -->
