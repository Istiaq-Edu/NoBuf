# Changelog

All notable changes to NoBuf will be documented in this file.

## [Unreleased]

### Features

- Add localhost plugin and streaming robustness

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

- Fix seek-to-end edge cases, add parallel download pool, improve MSE buffer management

### Enhancements

- Update package.json
- Update FastStreamPlayer.tsx
- Update FastStreamPlayer.tsx
- Update TopBar.tsx

### Features

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

- Bump Tauri dependency versions

### Other

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

## [1.4.0] - 2026-05-13

### Miscellaneous Tasks

- Release v1.3.2

## [1.3.1] - 2026-05-09

### Miscellaneous Tasks

- Release v1.3.1

## [1.1.10] - 2026-05-03

### Miscellaneous Tasks

- Bump version to 1.1.10 and fix media streaming port conflict and peer cache performance

## [1.1.9] - 2026-05-03

### Bug Fixes

- Resolve PDF streaming port conflict and bump version to v1.1.9

### Documentation

- Expand prerequisites with detailed dependencies and build instructions

## [1.1.8] - 2026-05-01

### Bug Fixes

- Fix file grid selection

### Features

- Add donation modal to login screen

## [1.1.6] - 2026-04-29

### Bug Fixes

- Graceful Ctrl+C shutdown + bump to v1.1.6

## [1.1.5] - 2026-04-28

### Bug Fixes

- Repair AppImage patch CI step + bump to v1.1.5

## [1.1.4] - 2026-04-28

### Bug Fixes

- AppImage EGL patch step + bump to v1.1.4

## [1.1.3] - 2026-04-27

### Bug Fixes

- Resolve EGL_BAD_ALLOC crash on Arch Linux AppImage

## [1.1.1] - 2026-04-05

### Other

- Hotfix v1.1.1: Fix sidebar folder list overflow

## [1.0.5] - 2026-03-27

### Features

- Implement media preview navigation and caching in Dashboard and PreviewModal (#6)

## [1.0.4] - 2026-03-10

### Bug Fixes

- Add missing 2FA password form in AuthWizard (#2)

### Documentation

- Fix screenshot paths and rename for clarity
- Rename and add media playback screenshots

## [1.0.2] - 2026-02-08

### Miscellaneous Tasks

- Add v1.0.1 DMG and update Cargo.lock
- Add automated release workflow with signing

## [1.0.1] - 2026-02-07

### Miscellaneous Tasks

- Remove error html files and add to gitignore

## [0.5.0] - 2026-02-01

### Bug Fixes

- Fix workflow: Remove explicit ARM target, macos-latest is ARM natively

### Enhancements

- Update workflow: Remove macOS Intel, add ARM64 target with signing support

### Other

- Disable Apple signing for unsigned builds

## [0.4.0] - 2026-01-30

### Features

- V0.4.0 release - Flood Wait Protection, Keyboard Shortcuts, and macOS Binary

## [0.3.0] - 2026-01-28

### Features

- Create FUNDING.yml

### Miscellaneous Tasks

- Release 0.3.0: Multi-move, Preview Fixes

### Other

- Add x86_64 Mac Support (macos-13 runner) & Set Deployment Target to 10.13

## [app-v0.2.0] - 2026-01-25
## [0.4.1] - 2026-05-26

### Documentation

- Update CHANGELOG.md for v0.4.0

### Bug Fixes

- Fix Tauri identifier and Linux dependencies
- Fix tauri script for Windows compatibility

### Features

- Add project README

### Other

- Initial commit of Telegram Drive

<!-- generated by git-cliff -->
