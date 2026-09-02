# Changelog

All notable changes to NoBuf will be documented in this file.

## [1.6.0] - 2026-08-30

### Documentation

- Update CHANGELOG.md for v1.0.0
- Update CHANGELOG.md for v1.0.0
- Update CHANGELOG.md for v1.0.0
- Update CHANGELOG.md for v1.1.0
- Update CHANGELOG.md for v1.1.0
- Update CHANGELOG.md for v1.1.0
- Update CHANGELOG.md for v1.3.0
- Update CHANGELOG.md for v1.3.1
- Update CHANGELOG.md for v1.3.1
- Update CHANGELOG.md for v1.4.0
- Update CHANGELOG.md for v1.4.5
- Update CHANGELOG.md for v1.4.6
- Update CHANGELOG.md for v1.4.7
- Update CHANGELOG.md for v1.5.0

## [1.4.5] - 2026-08-28

### Bug Fixes

- **split-upload:** Themed confirm dialog for job delete — window.confirm hits raw WebView2 defaults
- **split-upload:** Live interrupted-row updates + honest discard copy (QA round 1 findings)
- **split-upload:** Synthesize part rows from totalParts for jobs started mid-session
- **split-upload:** Keep transfer rows live and cancellable
- **split-upload:** Repair aggregate progress retry and clearing
- **split-upload:** Reconcile live progress and retry state
- **uploads:** Confirm cancel and make retry single-click
- **uploads:** Release queue after retry invalidation
- **uploads:** Serialize split groups with normal uploads
- **uploads:** Preserve FIFO and cancel queued transfers
- **dashboard:** Key every AnimatePresence child
- **uploads:** Harden split pipeline against races and mislabeled names
- **uploads:** Surface pipeline errors, bound bookkeeping, reap hung ffmpeg
- **uploads:** Harden URL temp cleanup, panic recovery, dedupe, and size gates
- **uploads:** Supervisor Err-guard, premium-aware URL gates, supervised retry
- **uploads:** Actually wire premium-aware limit into URL gates; drop dead mut

### Documentation

- **plan:** Record Phase E shipped (5aeb115); E2E fake-cap run left as manual QA
- **plan:** Sketch resumable-transfers branch — locked decisions, three legs, reuse map
- **plan:** Parts-first uploads — progressive listing, grouped transfer rows, chain removal (17 locked interview decisions + 3 investigation evidence bases)
- **plan:** Parts-first — fold in deep-review corrections (Play-via-MediaPlayer not URL construction, exact 5-file chain deletion surface incl. tail-stall watchdog, retry-backoff cancel slicing, react-query prefix semantics, caller census, virtualization notes)
- **plan:** Fold adversarial validation into parts-first plan (F1-F8)

### Features

- **split-upload:** Phase E — resume/discard actions on interrupted jobs + startup resume notice
- **split-upload:** Phase A — per-part backend truth, retry, tid lifecycle, documents-changed
- **split-upload:** Phase B — grouped per-part rows in Transfers panel
- **parts-first:** Phase C — chain removal; every part plays solo from 0:00
- **parts-first:** Phase D — documents-changed listener refreshes folder listing progressively
- **split-upload:** Add scoped delete flow
- **uploads:** Add retry and delete actions

### Testing

- **split-upload:** Split_owns_tid predicate + truth table — mutation-killed F1 regression guard

## [1.4.0] - 2026-08-25

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
- Use orhun/git-cliff-action instead of manual binary download
- Use taiki-e/install-action to install git-cliff into PATH
- Include Copilot-style commits in changelog and reduce noise
- Fetch full git history for git-cliff changelog generation
- Skip DMG bundling on macOS to avoid intermittent hdiutil failure
- Rewrite changelog generation using orhun/git-cliff-action@v4
- Use --strip instead of --strip-header for git-cliff v2.13.1
- Force-create local tag and remove hardcoded highlights
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
- Mock navigator for CI — sanitizeFilename tests pass in Node
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
- Fix seek deadlock from stale buffer islands
- Fix playback issues: seek dispatch, stale guard, landing time, and zombie cancel
- **faststream:** Coverage-derived prebuffer resume, VBR seek mapping, subtitle repair
- Fix subtitle sync, stream recovery, and login persistence
- Fix cold-start overlay timing and remux producer handoff
- Fix QR login polling and status feedback
- Fix QR login stuck on "Waiting for scan" (stale QR + DC-migrated 2FA)  Two root causes produced the same symptom; both verified against live logs.  Root cause 1 — displayed QR went stale: Telegram QR tokens expire in ~30s and cmd_auth_qr_poll rotates them correctly, but the rotated URL never reached the UI. The panel kept rendering the original tg://login URL, so any scan more than ~30s after open hit an expired token that can never complete, and every error path mapped to "waiting".  Root cause 2 — 2FA failed silently after DC migration: When token acceptance returns via loginTokenMigrateTo, SESSION_PASSWORD_NEEDED is raised on the TARGET DC, but handle_2fa called account.GetPassword via plain client.invoke() pinned to the home DC. That call failed, the error reached the frontend as a swallowed IPC rejection, and polling continued — re-consuming the accepted token until AUTH_TOKEN_EXPIRED while the UI sat on "Waiting for scan...".  Fixes: - Extract qr_login_url(); add cmd_auth_qr_current serving the current token URL - Poll handler re-renders the QR whenever the token rotates (functional setState) - handle_2fa() takes the reporting dc_id and fetches password info via   invoke_in_dc when the requirement came from a migrated call - Add qr_2fa_pending latch: once 2FA starts, polls return the password step   without re-probing exportLoginToken; reset on fresh QR login and logout - Poll errors are never swallowed: console.error plus amber inline status   (FLOOD_WAIT / transport failures now visible instead of an endless spinner) - Probe logs each cycle: "QR poll probe: token received (rotated=..., len=...)"  Tests: - qr_login_url_tests: encoder behavior + include_str! structural guards pinning   the probe's token-store line and all four sides of the 2FA latch - QrPollTokenSync.test.ts: rotation sync, branch order, non-silent catch - All new guards mutation-proven RED on removal, restored byte-identical  Also drops the unused `Requirement` import in deps/probe.rs (build warning).  Gates: cargo test 364/364 · vitest 1081/1081 · tsc --noEmit clean · 0 warnings
- Fix QR 2FA on migrated DCs: cross-DC verify, retries, instant scan feedback
- Fix release workflow crash on commit messages containing backticks
- Fix drag-drop upload: temp-file leak, Telegram filename corruption, overlay strand
- Fix double-cancel on staging rows: suppress late progress callbacks
- Fix queued-drop cancel: gate-FIFO items no longer resurrect after cancel
- Fix CI unhandled rejections: emitDone() instead of window.dispatchEvent
- **vault:** Impl-review fixes — stable context identity, native confirm swap
- **vault:** Show real channel names in vault view, not raw IDs
- **vault:** First-hide queue — rapid hides before passcode exists all land
- **vault:** Re-sync lock state on Dashboard mount — stale unlock across account switch
- **vault:** Cold vault entry offers passcode creation, not unlock
- **vault:** Whole row opens the hidden item, not just Open button
- **vault:** Get_state carries hidden IDs while locked — concealment needs the map
- **vault:** Back-stack review fixes A-D
- **vault:** Sync review fixes S1+S2 — owner binding + edit-one-message
- **vault-sync:** Seed-push on empty pull + apply pulled state to UI immediately
- **vault-sync:** Pull response reflects real runtime unlock flag
- **vault-sync:** Finding E verified-fixed (runtime unlock flag in pull response); R2 dual-blob steady state documented
- **vault-sync:** Pull_sync always re-pushes — one-way sync stalled propagation
- **vault-sync:** Rev-clock recency (F1) + message-id adoption (F2) + best-effort post-pull push (F3)
- **split-upload:** Record Telegram message ids per part; sweep only terminal-job temps; normalize stale running jobs at startup
- **split-upload:** Hash-based unique job ids (base64-truncate collided on dir prefix); record Telegram message ids per part; fail loudly on job-row insert errors; reject sub-margin caps; startup normalization for stale jobs
- **split-upload:** Delete drop-staged temp copies on modal-close/job-done/job-discard (interrupted jobs keep them for resume)
- **split-upload:** Backdrop click no longer closes split modal (explicit X/Cancel/Done/Escape only); Esc guarded during prepare/start; fake cap now covers frontend upload-limit checks
- **split-upload:** Reject sub-minute-average plans before snapping (QA-cap pathological case, user-repro 6127s/70MB)
- **split-upload:** Oversize drops while a split is already active now reject loudly instead of vanishing; drop dead pending-choice state
- **split-upload:** Atomic pipeline claim + queue survives restart; un-nest dead test
- **split-upload:** Multi-angle review sweep fixes (queue/lifecycle/security)
- **split-upload:** Poll cmd_upload_limit until first success

### Documentation

- Fix screenshot paths and rename for clarity
- Rename and add media playback screenshots
- Expand prerequisites with detailed dependencies and build instructions
- Update CHANGELOG.md for v0.3.2
- Update CHANGELOG.md for v0.4.0
- Update CHANGELOG.md for v0.4.1
- Update CHANGELOG.md for v0.4.2
- Update CHANGELOG.md for v0.4.3
- Update CHANGELOG.md for v0.4.6
- Update CHANGELOG.md for v0.4.7
- Update CHANGELOG.md for v0.5.0
- Update CHANGELOG.md for v0.6.0
- Update CHANGELOG.md for v0.7.0
- Add design spec + implementation plan for public channel browsing
- Verification, validation & optimization plan for public channel feature
- Update CHANGELOG.md for v0.9.0
- Vault feature design spec (hide channels/folders behind passcode)
- Vault spec rev 2 after adversarial design review (16 findings triaged, 7 Required fixed)
- Fold late frontend-reviewer observation into consolidated report (R17 FYI)
- Cross-validation review of vault spec — 14 claims adjudicated, 6 amendments applied (rev 3)
- Adjudicate late state-consistency review into spec rev 4 (public-channel pruning, logout vault wipe, D14 handler duties)
- Spec rev 5 — live global search found at impl start; backend-side vault filter specified
- Archive remaining reviewer skeletons (frontend/robustness domains, flake-orphaned)
- Consolidated impl-review report (3 domains, 2 fixes, verdict Approve)
- Record F3 (first-hide race) in consolidated report
- Record F4 (stale unlock across account switch) in consolidated report
- Spec rev 6 — locked get_state ID-withholding was a design error, corrected
- **split-upload:** Validated plan for >2GB lossless split-and-upload
- **plan:** Record Phase D D0 spike decision (Strategy 1 — fresh MediaSource per part)

### Enhancements

- Update workflow: Remove macOS Intel, add ARM64 target with signing support
- Change GitHub workflows to manual dispatch
- Update release.yml
- Update release.yml

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
- Introduce NoBuf green theme & settings UI
- Add localhost plugin & programmatic frontend window
- Add folder sync/rename/delete reconciliation, update deps, and rename branding to NoBuf
- Add background continuation, folder reorder, MSE fixes
- Add localhost plugin and streaming robustness
- Add faststart MP4 streaming and CI tweaks
- Add nobuf-stream protocol proxy and deps
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
- Upstream feature parity — 23 features from v1.9.5
- Add About page and bump version to 0.6.0
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
- Add dependency health check, kill console-window flashes, cache ffmpeg resolution
- **vault:** Backend store — PBKDF2 passcode, 10 Tauri commands, search leak filter
- **vault:** Phases 2+3 — frontend state, sidebar entry, hide flows
- **vault:** Phase 4 — vault view, lock screen, reconciliation pruning
- **vault:** Phase 5 — settings, hotkey, logout wipe, edge-case sweep
- **vault:** Back button — view history stack with TopBar arrow
- **vault:** Cross-device sync via Saved Messages (spec §7)
- **split-upload:** Lossless >2GB split engine with resumable jobs
- **split-upload:** Phase A backend split core
- **split-upload:** Split screen UI (filmstrip + draggable cut handles) wired into oversize-video upload flow
- **split-upload:** Oversize videos dropped via drag-and-drop now enter the split screen (staged to temp, then same prepare/modal/job chain)
- **split-upload:** Fast raw-binary /stage-drop route for drop->split staging (base64 IPC stager kept as fallback); sanitize_staged_name extracted as shared helper
- **split-upload:** Drop-time warning about temp copy + highlighted Upload-button alternative; transfers panel auto-opens during split processing
- **split-upload:** Decision-first oversize drop — choice modal before any temp copy, with highlighted zero-copy picker lane
- **split-upload:** Startup sweep reclaims crash-orphaned drop-staged files older than 48h
- **split-upload:** Confirm-before-close on active split modal (X/Cancel/Esc route through a Discard? overlay when plan/prepare/start is live)
- **split-upload:** Authoritative single-pipeline gate in cmd_start_split_job — second job during an active upload now fails loudly instead of competing
- **split-upload:** Job queue — extra big files line up as 'queued' and auto-start in order; live split rows with phase indicators in Transfers panel
- **split-upload:** Phase D slice 1 — chain model + virtual timeline (pure, tested)
- **split-upload:** Phase D slice 2 — chained part playback (Strategy 1)
- **split-upload:** Phase D slice 3 — chain HUD (part k/N badge)
- **split-upload:** Phase D slice 4 — grid collapse of split chains
- **split-upload:** Phase D slice 5 — gap rule UX
- **split-upload:** Phase D slice 6 — real-world chain naming (double-nested)
- **split-upload:** Phase D slice 7 — chain tail-stall watchdog

### Miscellaneous Tasks

- Release 0.3.0: Multi-move, Preview Fixes
- Remove error html files and add to gitignore
- Add v1.0.1 DMG and update Cargo.lock
- Add automated release workflow with signing
- Bump version to 1.1.10 and fix media streaming port conflict and peer cache performance
- Release v1.3.1
- Release v1.3.2
- Bump Tauri dependency versions
- Remove log file from git, add to gitignore
- **vault-sync:** Clear 3 compiler warnings (vestigial import, dead struct, dead hex helper)
- **split-upload:** Tidy integration test source-hash gate
- **split-upload:** Dev-only QA seam to bypass native file picker in split flow
- **split-upload:** Extend dev QA seam with job list/resume/cancel/discard controls
- Ignore app/tmp (split QA fixtures) — no media files in git
- Ignore app/.npm-cache (package-manager cache, purged from history)

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
- Support MSI numeric versioning; add README tip
- Generate changelogs in release workflow
- Register Tauri commands and add permissions
- Normalize screenshot filenames and replace assets
- Modernize README: v0.4.1 badge, updated screenshots, new features (exit options, video player settings)
- Use videoStreamUrl for thumbnail extraction
- Enable PNA CORS and prefer HTTP base_url
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
- Expose current QR login token for UI sync
- Normalize fs.rs line endings to LF
- Wire cmd_discard_staged_upload: delete partial staging bytes on mid-stream failure
- Deep-verification round: 6 defects found by 5-reviewer panel, all fixed
- Harden verification-round fixes: mutation battery + release-order guard
- Pre-flight staging free-space check for dropped files
- Four drag-drop refinements: staging cancel, name-length cap, per-folder dedupe, toast capping
- Stream-direct drop uploads: eliminate the staging/preparing phase
- Deep-review round (5 reviewers): 7 defects fixed + test debt repaid
- Observability for /upload-drop: log start, auth rejections, failures
- Silence two compiler warnings in upload_drop.rs (unused mut, unused start)
- Surface stream-direct fallback reason to the user instead of silent staging
- Server-bind readiness signal + two-step probe classifier + drop fixes
- Deep-review round 3: zombie-port hardening, gate-routed retry, mutation-proof tests
- Diagnose the 404-on-/upload-drop session: registration logging + findings
- Unconditional /upload-drop registration: kill the last silent-404 vector
- Normalize route check to 127.0.0.1 + log both probe statuses
- Rust-side self-probe settles webview-vs-server 404 split
- Register cmd_probe_upload_route in build.rs allowlist + capabilities
- PID-stamped /__whoami endpoint: definitive impostor-process discriminator
- ROOT CAUSE: actix HEAD-vs-POST matching 404'd every availability probe
- Silence private_interfaces warning on upload_drop_handler
- Sequential drop uploads: one stream at a time, matching original system
- Doc comment: record the real HEAD-vs-POST root cause on the handler
- Review doc addendum: stream-direct arc, root cause, defect ledger
- Terminal-state logging for drop uploads: SUCCESS and user-abort lines
- Final sweep round: P1 zombie-retry fix, send-failure honesty, doc updates
- Final-sweep fixes: zombie-retry purge + ALREADY_STORED no-duplicate-retry
- Origin/dev into feature/vault-hide-channels (drag-drop upload overhaul, QR 2FA fixes)
- Cleanups
- Merge remote-tracking branch 'origin/dev' into feature/large-video-split-upload

### Performance

- Improve MSE player robustness and logging
- Improve prebuffering, cache meta handling & logs
- Refine FastStreamPlayer controls and download UI
- Improve video UI and MSE tail-fetch logic
- Improve stream protocol and proxy handling
- Improve MSE eviction, DTS & resume recovery
- Improve TS streaming, resume & cold-start
- Improve streaming seek behavior and chunk size
- Improve streaming rate-limiting and seek behavior
- Improve proactive prebuffering and playback UI
- **streaming:** Give /stream priority over keyframe search, raise rate limiter to 300ms
- Improve TS remux seek & cold-start UX
- Improve MPEG-TS seek/recreation and UI seek handling
- Optimize keyframe search & memoize duration lookups
- Improve keyframe logging and thumbnail seeking
- Improve subtitle scheduling and proactive reporting

### Refactor

- Rename project from Telegram Drive to nobuff
- Rename project branding to NoBuf
- Replace auto-hide delay with pin button toggle
- Replace speed meter with backend cumulative counter
- Replace #[post] codegen Resource with plain cfg.route registration

### Removed

- Remove debug logging from player & MSE hook
- Delete Reference-FastSyream-repo
- Remove trace-27 seek-search byte-accounting probe (confirmed)
- Drop-time connected gate + staging progress UI
- Drop unused imports after unconditional route registration

### Security

- PDF viewer, remove file cap, code cleanup
- Security audit: 44 fixes across critical/high/medium/low + TS playback fixes

### Testing

- **vault:** Mutation-test hardening — wiring guard for search filter call sites
- **vault:** Frontend logic tests + mutation verification
- **vault:** Phase 4/5 review — prune-diff extraction + wipe-contract guard
- **vault:** UI-state matrix — locked screen branches on hasPasscode

<!-- generated by git-cliff -->
