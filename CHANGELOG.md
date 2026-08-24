# Changelog

All notable changes to NoBuf will be documented in this file.

## [1.3.1] - 2026-08-24

### Documentation

- Update CHANGELOG.md for v1.3.0
- Update CHANGELOG.md for v1.3.1

## [1.1.0] - 2026-08-22

### Bug Fixes

- Fix QR login polling and status feedback
- Fix QR login stuck on "Waiting for scan" (stale QR + DC-migrated 2FA)  Two root causes produced the same symptom; both verified against live logs.  Root cause 1 — displayed QR went stale: Telegram QR tokens expire in ~30s and cmd_auth_qr_poll rotates them correctly, but the rotated URL never reached the UI. The panel kept rendering the original tg://login URL, so any scan more than ~30s after open hit an expired token that can never complete, and every error path mapped to "waiting".  Root cause 2 — 2FA failed silently after DC migration: When token acceptance returns via loginTokenMigrateTo, SESSION_PASSWORD_NEEDED is raised on the TARGET DC, but handle_2fa called account.GetPassword via plain client.invoke() pinned to the home DC. That call failed, the error reached the frontend as a swallowed IPC rejection, and polling continued — re-consuming the accepted token until AUTH_TOKEN_EXPIRED while the UI sat on "Waiting for scan...".  Fixes: - Extract qr_login_url(); add cmd_auth_qr_current serving the current token URL - Poll handler re-renders the QR whenever the token rotates (functional setState) - handle_2fa() takes the reporting dc_id and fetches password info via   invoke_in_dc when the requirement came from a migrated call - Add qr_2fa_pending latch: once 2FA starts, polls return the password step   without re-probing exportLoginToken; reset on fresh QR login and logout - Poll errors are never swallowed: console.error plus amber inline status   (FLOOD_WAIT / transport failures now visible instead of an endless spinner) - Probe logs each cycle: "QR poll probe: token received (rotated=..., len=...)"  Tests: - qr_login_url_tests: encoder behavior + include_str! structural guards pinning   the probe's token-store line and all four sides of the 2FA latch - QrPollTokenSync.test.ts: rotation sync, branch order, non-silent catch - All new guards mutation-proven RED on removal, restored byte-identical  Also drops the unused `Requirement` import in deps/probe.rs (build warning).  Gates: cargo test 364/364 · vitest 1081/1081 · tsc --noEmit clean · 0 warnings
- Fix QR 2FA on migrated DCs: cross-DC verify, retries, instant scan feedback
- Fix release workflow crash on commit messages containing backticks

### Features

- Add dependency health check, kill console-window flashes, cache ffmpeg resolution

### Other

- Expose current QR login token for UI sync

## [1.0.0] - 2026-08-19

### Bug Fixes

- Fix seek deadlock from stale buffer islands
- Fix playback issues: seek dispatch, stale guard, landing time, and zombie cancel
- **faststream:** Coverage-derived prebuffer resume, VBR seek mapping, subtitle repair
- Fix subtitle sync, stream recovery, and login persistence
- Fix cold-start overlay timing and remux producer handoff

### Documentation

- Update CHANGELOG.md for v1.0.0
- Update CHANGELOG.md for v1.0.0
- Update CHANGELOG.md for v1.0.0
- Update CHANGELOG.md for v1.1.0
- Update CHANGELOG.md for v1.1.0
- Update CHANGELOG.md for v1.1.0

### Features

- Add subtitle support with sidecar loading & jassub ASS rendering
- Add ffmpeg resolution module with on-demand download
- Create TS_PIPELINE_ASSESSMENT_2026-07-17.md
- Create TS_PIPELINE_CROSSVALIDATION_FINAL_2026-07-17.md
- Implement universal transcode tier for HEVC MKV
- Add byte-accounting probe for seek operations
- Add seek-to-play probe and SBW op-timing fix
- Add byte-forward remux seeks (start_byte)
- Add proactive keyframe index for instant hover thumbnails
- Add MP4‑HEVC /remux reroute + server thumbnails
- Add TS-HEVC remux recovery & tests
- Add per-file audio track selection across all playback tiers
- Add embedded subtitle extraction & selection (SRT/ASS + fonts)
- Add decideMkvCaptureStrategy helper for cue-less MKV thumbnail guard
- Add shouldAbandonResolvedSeek predicate for post-resolve seek belt
- Add rounds 1-3 test suites + forensics/plan/solution reports (previously untracked)
- Add thumbnail bisect single-flight and CORS headers
- Add authoritative remux-seek anchors & subtitle fixes
- Create review-mkv-subtitle-regression.md
- Create review-current-subtitle-retry.md
- Add subtitle sizing/position/sync controls and OpenSubtitles search

### Other

- Refresh README; fix /remux MPEG-TS mismatch
- Apply 2MB seek-backoff to reported byte
- Interrupt in-flight seeks; warmer yield
- Avoid stale thumbnail writes; add support matrix
- Make seek supersession sticky + post-resolve belt (kills zombie getKeyPacket walks)
- Guard cue-less MKV thumbnail captures (index-or-skip, no native scans)
- Audio-switch B4 reroute mapping + sbHasAudio planning (pre-round-3 in-flight work)
- Cue-less MKV: fall back to harvested keyframe index for refill/switch boundaries
- Audio switch: transmux before flush + in-place changeType revert (kills switch stutter window)
- Cached_prefix bounded extraction — body ends at cache frontier (16min→seconds)
- Surface partial extractions and re-extract on re-select
- MKV cluster scan/injection helpers for cue-less bisection (pure, tested)
- Cue-less MKV far-hover: cluster bisection + position-cache injection (bounded, memoized)
- Round-4 log fixes: cached_prefix=true (serde bool 400) + interpolation bisect w/ in-buffer advance
- Kill bisect probe spin + phantom green bar on transmuxer seeks
- Player-side cluster bisection on cue-less far seeks + green-bar anchor densification
- Keyframe-shadow-safe seek bisection (fix round-6 fatal reroute)
- Audio-switch E3 refill conflation + shadow-estimator saturation
- PROACTIVE true-byte anchoring + unstarve, 4MiB bisect stop-gap, Windows lock release, switch drain, subs frontier gate, hover await
- Proactive prebuffer, durable subtitle promotion
- Make subtitle state session-only
- Increase subtitle line widths; remove panelReserve
- Normalize EOL-sensitive test assertions

### Performance

- Optimize keyframe search & memoize duration lookups
- Improve keyframe logging and thumbnail seeking
- Improve subtitle scheduling and proactive reporting

### Refactor

- Replace speed meter with backend cumulative counter

### Removed

- Remove trace-27 seek-search byte-accounting probe (confirmed)

## [0.9.0] - 2026-07-12

### Bug Fixes

- Fix QR login and add automated Telegram auth
- P0 — Tauri permissions for 10 new commands, parameterized SQL, upload_file error mapping
- P1+P2 — Rename hide for public channels, get_setting logging, sync retry with backoff, error toasts on sync failure, unused imports cleanup, loading spinner
- Already_joined always false for ResolveUsername — JoinChannel is idempotent
- Link parsing for trailing slashes/permalinks, Search+FilterDocument for file listing, type field in frontend
- Revert to GetHistory (proven pattern), handle ChannelMessages variant, add diagnostic logging, fix has_more logic
- Sync activeFolderId when viewing public channels — enables download/preview/stream
- Return partial:false for non-TS files (MP4) so frontend stops polling and uses linear playback
- 4 root causes from log analysis — MP4 keyframe polling, zombie download death spiral, GetHistory refetch spam, FLOOD_PREMIUM_WAIT cascade
- StaleTime on publicChannels list query + NOT_A_MEMBER handling in loadMore
- Memoize onLoadMore with useCallback to stop IntersectionObserver refetch loop, stop FMP4-KF polling when complete
- Revert max-h transition to conditional rendering — restores scrollbar and clickability
- HandleSelectFolder wrapper updates activeView + activeFolderId atomically — fixes private folders not opening from public channel view
- Show channel icons when sidebar is collapsed — render regardless of section expand state
- Align public channel icons in collapsed sidebar — centered 32px boxes, conditional avatar size, divider, px-2 nav padding
- **streaming:** Suppress thumbnail seeks, wait for fMP4 downloads, reduce FLOOD_PREMIUM_WAIT
- **seek:** Set seek flag before debounce; raise rate limiter to 250ms
- **seek:** Use separate timestamp for thumbnail suppression to avoid debounce deadlock
- **seek:** Cover align-poll phase in thumbnail suppression
- Stale 15s log messages, raise prebuffer backward-jump threshold to 50MB
- **ts-playback:** Timed_id3 TS files now play via ffmpeg mpegts remux + mpegts.js
- **player:** Dynamic cold-start overlay + fix video.src race on reopen
- Reduce audio drift and mute mpegts warnings
- Ffmpeg remux fixes; ignore stale VBR gaps
- Delay seek target clear during VBR alignment
- Double thumbnail size and fix MPEGTS pause/resume logic
- MKV MSE decode crash + streaming robustness (Fixes #1-#10)

### Documentation

- Add design spec + implementation plan for public channel browsing
- Verification, validation & optimization plan for public channel feature
- Update CHANGELOG.md for v0.9.0

### Features

- Add PublicChannel, ChannelPreview, JoinedChannel, ActiveView types
- Add public_channels module skeleton + models
- Add usePublicChannels + usePublicChannelFiles hooks
- Add cmd_resolve_channel_link for channel preview
- Add cmd_join_channel_by_link for joining + DB insert
- Add AddChannelModal with Paste Link + Browse Joined tabs
- Add PublicChannelSidebarSection + PublicChannelItem
- Add cmd_list_joined_channels, cmd_add_joined_channel, cmd_get_public_channels
- Add cmd_get_public_channel_files, cmd_remove_public_channel, cmd_forward_to_folder
- Wire up ActiveView state + public channel sidebar section
- Add [NB-PUB] sync system + scan exclusion
- Read-only banner + infinite scroll for public channel files
- Not-a-member state + FLOOD_WAIT audit on all API calls
- Forward-to-folder modal + context menu + remove flow with leave prompt
- Larger streaming buffers for public channels — 20MB cold start, 120s prefetch, 80MB max buffer
- Collapsible Private and Public Channels sections in sidebar with chevron toggles
- Collapsible sidebar sections with smooth transitions, improved AddChannelModal UI/UX, avatar circles, count badges, icon buttons
- **ts:** Re-enable proactive prebuffer with /stream priority
- Add VBR correction for video seeking
- Add controls pinning & improve buffer display
- Add pause/resume prefetch controls and UI tweaks
- Create PrefetchPause.test.ts
- Player UX: control bar, settings & drag chips
- External file drag-drop upload from Explorer

### Miscellaneous Tasks

- Remove log file from git, add to gitignore

### Performance

- **streaming:** Give /stream priority over keyframe search, raise rate limiter to 300ms
- Improve TS remux seek & cold-start UX
- Improve MPEG-TS seek/recreation and UI seek handling

### Refactor

- Replace auto-hide delay with pin button toggle

### Security

- Security audit: 44 fixes across critical/high/medium/low + TS playback fixes

## [0.7.0] - 2026-06-26

### Documentation

- Update CHANGELOG.md for v0.7.0

### Features

- Add About page and bump version to 0.6.0

## [0.6.0] - 2026-06-26

### Bug Fixes

- Mock navigator for CI — sanitizeFilename tests pass in Node

### Documentation

- Update CHANGELOG.md for v0.6.0

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

### Security

- PDF viewer, remove file cap, code cleanup

<!-- generated by git-cliff -->
