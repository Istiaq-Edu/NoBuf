# TS-HEVC Fallback Fix — Plan & Edge Cases

Audited 2026-07-29 against `dev` working tree. All line numbers = `app/src/hooks/useMSEPlayer.ts` unless noted.

## Problem

A TS file whose video codec MSE can't decode (HEVC on stock WebView2 — no "HEVC Video
Extensions") currently ends on a **broken or hung tier**. mpegts.js demuxes H.265 TS fine
(stream_type 0x24 → hvc1 init segment); the failure happens at
`MediaSource.addSourceBuffer('video/mp4;codecs="hvc1…"')` → `NotSupportedError` →
`ERROR(MediaError, MediaMSEError)`.

### The four broken paths (source-verified)

| # | Path | Today's behavior | Why broken |
|---|------|------------------|-----------|
| P1 | `MediaMSEError`, `video.error` **not** set (the common addSourceBuffer case) — :3110 | Treated as SourceBuffer **quota** → suspend + wait for eviction | No SB exists; eviction never helps → **infinite hang**, no fallback |
| P2 | `MediaMSEError`, `video.error` set — FATAL :3127-3189 | `remuxUrl` (no `hevc_ok`) + `setUseNative(true)` | Native `<video>` can't demux the **MPEG-TS** `/remux` output → black screen |
| P3 | `CodecUnsupported` — :3210-3219 | Destroys player, sets `mpegtsFailedRef`… and **nothing else** | Pre-MEDIA_INFO: waits the full **60s timeout** → then P4. Post-init: silent death |
| P4 | `_initMpegtsPlayer` returned false — :5977-6024 | `remuxUrl` (no `hevc_ok`) + `setUseNative(true)` | Same as P2: native + TS container = broken |

### Fix (one concept)

Recover to the **battle-tested timed_id3 tier**: recreate mpegts.js on
`/remux?…&hevc_ok=<probe>` — ffmpeg transcodes HEVC→H.264 when the runtime can't decode it
(`hevc_ok=false`), or copies 8-bit HEVC when it can. Raw `/stream` bytes for these files ARE
real MPEG-TS, so **byte-forward seeks** (`remuxSourceIsTsRef=true`) are valid — full seek,
prebuffer (proactive reporter), duration override, quota guard all already work on this tier
(e2e-proven 2026-07-28/29).

## Design

### New pure helpers (exported, unit-tested)
- `isAlreadyRemuxUrl(url)` — pathname starts with `/remux/`.
- `isFatalSourceBufferCreationError(info)` — matches `addSourceBuffer` failure shapes:
  `code===9`, `msg` containing `addSourceBuffer` or `NotSupportedError`. WebView2 gives
  `code=0, name=undefined` on DOMExceptions (proven for the quota case, :3111), so the
  **message signature** is the reliable discriminator. `appendBuffer`/quota shapes → false.
- `planRemuxRecovery({streamUrl, alreadyAttempted, currentTime, duration, fileLength})`
  → `{action:'skip'|'init'|'seek', time?}`:
  - `skip` when the failing player was ALREADY on a `/remux` URL (loop guard #1) or a
    recovery was already attempted this load (loop guard #2).
  - `seek` when `currentTime ≥ 8s` AND duration+fileLength known — resume near position via
    `_mpegtsRecreatePlayerForRemuxSeek` (byte-forward, preserves paused state).
  - `init` otherwise — cold start from 0 via the timed_id3 init pattern (cold overlay).

### New impure orchestrator `_recoverToRemuxTier(failedStreamUrl, reason)`
Mirrors the timed_id3 branch (:2622-2669): live `streamUrlRef` re-parse (file-switch
defence), build `/remux` URL **with `hevc_ok=hevcMseSupported()`**, set
`remuxUrlRef`/`needsRemuxSeekRef`/`remuxSeekBaseUrlRef`/`remuxSourceIsTsRef=true`, reset
video element (clears `video.error`), then:
- **seek mode**: `_mpegtsRecreatePlayerForRemuxSeek(clampSeekTime(t, dur), dur)` — reuses
  the proven recreate path (gen counter, pause preservation, align poll).
- **init mode**: shadow-cache reset to remux pathname (len 0, interceptor inert),
  `transmuxerInitInProgressRef=true` (extends the 20s init timeout), `setMseUrl(null)`
  (ERR_FILE_NOT_FOUND guard), cold-start overlay deferred, `_initMpegtsPlayer(remuxUrl…)`;
  re-pause after init if `isPausedRef` (paused means paused).
Returns false on skip/parse-fail/init-fail → caller falls to the old native path (last resort).

### Wiring the four paths
| Path | Change |
|------|--------|
| P1 | FATAL condition becomes `video.error \|\| isFatalSourceBufferCreationError(_errorInfo)` — addSourceBuffer failure is fatal even with `video.error` null |
| P2 | FATAL setTimeout(0) cleanup: try `_recoverToRemuxTier` first; only on false run the existing native fallback |
| P3 | `CodecUnsupported`: re-entry guard; reject the pending MEDIA_INFO wait immediately via `initFailReject` (kills the 60s dead wait → caller path P4 recovers); if init already completed, schedule `_recoverToRemuxTier` directly |
| P4 | After mpegts teardown in `initTransmuxerPlayer`: try `_recoverToRemuxTier(url)`; on false keep existing native fallback |

### Hover thumbnails on the recovered tier
MEDIA_INFO thumbnail branch (:3417): recovered tier joins the MP4-reroute branch →
**server-side `/thumb`** (`remuxThumbConfigRef`). Rationale: the fMP4 mini-MSE pipeline
would emit hvc1 fragments the stock machine can't decode — exactly why we rerouted. `/thumb`
(ffmpeg one-frame decode over Range-seekable `/stream`) works on all machines and on
unbuffered regions (e2e-proven for MP4 reroute).

### New refs
`remuxRecoveryAttemptedRef` (one-shot guard), `remuxRecoveryActiveRef` (thumbnail routing).
Both reset in the player cleanup block alongside `reroutedToRemuxRef`.

## Edge cases handled
- **E1 loop guard**: failure ON the `/remux` tier itself never re-recovers (skip → native last resort).
- **E2 one-shot**: only one recovery per file load; repeated fatals → old behavior.
- **E3 pending vs post-init failure**: pending → reject MEDIA_INFO wait (no 60s hang), caller recovers; post-init → direct recovery from the ERROR closure (setTimeout(0) — mpegts.js promise chains must drain before destroy, :3149).
- **E4 WebView2 unreliable DOMException codes**: message-signature detection, not `code`.
- **E5 file switched mid-handler**: recovery re-parses live `streamUrlRef` (existing FATAL pattern).
- **E6 paused means paused**: seek-mode recreate respects `wasPaused`; init-mode re-pauses after init when `isPausedRef`.
- **E7 stale blob URL**: `setMseUrl(null)` before mpegts init; original blob revoked in P4 path (existing).
- **E8 fatal-abort flag**: `__nobuf_mpegtsFatalAbort`/`mpegtsFailedRef` reset by `_initMpegtsPlayer` (:3056).
- **E9 duration**: recovered player reuses `__nobuf_ptsDuration` when the first attempt's metadata fetch landed; else estimate + `/fmp4/metadata` retry loop (existing).
- **E10 hevc_ok honesty**: 8-bit HEVC copies when decodable, transcodes otherwise; 10-bit/HDR always transcodes + tonemaps (backend :2779-2781, unchanged).
- **E11 double ERROR emission**: `mpegtsFailedRef` re-entry guard extended to the CodecUnsupported branch.
- **E12 mid-recovery user seek**: `needsRemuxSeekRef` is set before init, so seeks route through the remux-seek path; `mpegtsRecreationGenRef` supersedes in-flight recreations (existing mechanism).

## Not changed
- Backend (`server.rs`): `/remux` `hevc_ok` + byte-forward + `/thumb` already exist — zero Rust changes.
- `checkInitTimeout` (:1732): recovery sets `transmuxerInitInProgressRef=true` → timeout extends; no edit needed.
- Native `<video>` error listener (:8415): `transmuxerInitInProgressRef` check already covers the recovery-init window.

## Verification
1. `npx tsc --noEmit` — types.
2. `npx vitest run` — existing 304 + new `TsHevcRecovery.test.ts` (helpers: URL detection, error-shape detection, plan matrix).
3. Execution: generate a local HEVC-in-TS sample (ffmpeg), prove the transcode tier command shape consumes it (H.264+AAC MPEG-TS out).
4. Hand back for `tauri dev` e2e on the real machine (stock = no HEVC extensions here).
