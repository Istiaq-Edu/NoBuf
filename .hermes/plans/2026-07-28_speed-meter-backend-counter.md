# Speed Meter Rebuild — Implementation Plan (backend cumulative counter)

> **For Hermes:** execute task-by-task; each task ends with a verification gate. No task is "done" without its gate passing.

**Goal:** Replace the five broken frontend speed estimators with one backend-authoritative measure: a per-message cumulative counter of bytes actually downloaded from Telegram, sampled by the existing 500ms poll, windowed 3s, decaying to 0 on stall.

**Architecture:** Rust `StreamCacheManager` gains an in-memory `session_downloaded` counter incremented at every player-path `iter_download` chunk arrival (7 sites). Exposed via existing `cmd_get_cache_status` (`CacheStatus.session_downloaded_bytes`). New pure TS module `speedMeter.ts` computes windowed speed from cumulative samples. All `mseSpeed` plumbing + dead `cmd_report_cached_ranges` IPC removed.

**Design validated:** 13/13 simulation checks (see `speed-meter-crossvalidation.md`) + prior-art brief (hls.js/dash.js/Shaka — dash.js cache-exclusion principle, cumulative-window arithmetic).

**Parameters:** poll 500ms · window 3000ms · min dt 900ms (≥2 samples) · hard 0 after 3000ms without counter growth · noise floor 500 B/s · reset guard (sample < previous → clear history).

---

## Phase R — Rust backend counter

### Task R1: Add counter storage + API to `StreamCacheManager`
**Files:** `app/src-tauri/src/stream_cache.rs`
- Field on struct (~line 283): `session_downloaded: Arc<std::sync::Mutex<HashMap<i32, u64>>>` (std Mutex — callers are sync-capable, no await while held). Init in `new()` (line 351).
- Methods:
  - `pub fn add_downloaded_bytes(&self, message_id: i32, n: u64)` — `*entry.or_insert(0) += n`
  - `pub fn session_downloaded_bytes(&self, message_id: i32) -> u64`
  - clear entry inside `delete_cache` (line 913).
- `CacheStatus` (lines 269–278): add `pub session_downloaded_bytes: u64`.
- `get_status` (lines 573–584): fill the new field. **Cold-start fix:** when `load_meta` returns `None` but counter > 0, return a synthetic `CacheStatus` (zeros + counter) instead of `None` — the remux tier downloads before meta exists.
**Gate:** `cargo build --no-default-features` exit 0. Unit test in `stream_cache.rs` tests mod: add/read/clear counter + synthetic status.

### Task R2: Instrument all 7 player-path chunk-arrival sites
Add `cache_mgr.add_downloaded_bytes(message_id, bytes_in_chunk)` at the exact point a Telegram chunk lands (post-trim, pre/next to cache write). Sites (anchors verified 2026-07-28):
| # | File | Anchor |
|---|---|---|
| 1 | `server.rs` | /stream fallback loop, after `let bytes_in_chunk = final_data.len() as u64;` (~1322) |
| 2 | `server.rs` | `download_and_cache_range` chunk arrival (~1650–1700, `downloaded.extend`) — keyframe window |
| 3 | `server.rs` | fMP4 segment loop `bytes_in_chunk` (~3936) |
| 4 | `server.rs` | fMP4 meta tail loop slice write (~4690–4715) |
| 5 | `commands/streaming.rs` | proactive prebuffer `write_all(&chunk_slice[..to_write])` (~632) → count `to_write` |
| 6 | `commands/streaming.rs` | gap filler `write_all` (~1306) → count `to_write` |
| 7 | `commands/fs.rs` | in-player download: gap-fill `to_write` (~937), fresh-download `bytes_in_chunk` (~1068) |
Each site already holds a `StreamCacheManager` (`cache_mgr` / `cache_state` / `cache`); if one doesn't, thread the handle — do NOT skip the site.
**Gate:** `cargo build --no-default-features` exit 0; `grep -c add_downloaded_bytes` ≥ 8 (7 sites + def). `cargo test` green.

## Phase T — TS speed meter module (TDD)

### Task T1: Write failing tests for `speedMeter.ts`
**Files:** create `app/src/__tests__/speedMeter.test.ts`
Cases (mirror the validated simulation): exact 1.000 MB/s steady (±1 B); no first-sample 2× spike; stall → 0 within 3.5s; flat counter (cached replay) → 0 always; reset guard (counter drops → no negative, recovers); noise floor (<500 B/s → 0); `speedMeterValue` paused → 0; `formatSpeed` units (B/KB/MB boundaries).
**Gate:** `cd app && npx vitest run src/__tests__/speedMeter.test.ts` → FAILS (module missing).

### Task T2: Implement `app/src/lib/faststream/speedMeter.ts`
Pure module, no React: `interface SpeedSample { t: number; bytes: number }`; `pushSample(samples, t, cumulativeBytes)` (reset guard + window trim); `computeWindowSpeed(samples, nowMs): number` (cumulative diff `(last−first)/dt`, min-dt, stall-zero, noise floor); `speedMeterValue(bps, prefetchPaused)`; `formatSpeed(bps)` (moved verbatim from `useMSEPlayer.ts:8511`).
**Gate:** vitest file green; `npx tsc --noEmit` exit 0.

## Phase F — FastStreamPlayer wiring

### Task F1: Feed meter from `session_downloaded_bytes`
**Files:** `app/src/components/dashboard/FastStreamPlayer.tsx` (poll effect lines 497–570)
- Move the `cmd_get_cache_status` invoke ABOVE the seek-settle gate: status is fetched every tick; the gate (`_seekSettling`/`_gateExpired`) now wraps ONLY the ranges→time/green-bar-segment + percent/complete consumers. Speed sampling must never be gated (gating = false stall).
- Replace delta-history logic (lines 545–564 incl. `greenBarSpeedHistoryRef`) with `pushSample`/`computeWindowSpeed` on `status.session_downloaded_bytes`; keep `is_complete → reset` behavior.
- Render sites 2052 & 2282: `speedMeterValue(greenBarSpeed, prefetchPaused)` (2-arg), `formatSpeed` imported from `speedMeter.ts`; drop `mseSpeed` (line 298 mapping + import line 8).
**Gate:** `npx tsc --noEmit` exit 0.

## Phase M — useMSEPlayer removals (net-negative diff, surgical)

### Task M1: Remove mseSpeed plumbing
**Files:** `app/src/hooks/useMSEPlayer.ts` — use Python string replacement per reliable-file-editing (NO patch tool on .ts).
Remove: `[speed, setSpeed]` (1144) + all `setSpeed` sites (1657, 5812, 7073, 8213 resets; 5701 `onSpeedUpdate` wiring line; 7002–7013 downloadLoop history block; STATISTICS_INFO speed block at ~3174–3193); `speedHistory` ref (1346, 1642); `mpegtsSpeedHistoryRef` (1244, 3179); `speed,` from return (8441); `formatSpeed`/`speedMeterValue` exports (8511–8560, now live in speedMeter.ts). Transmuxer-side `onSpeedUpdate` props/emitters are PRE-EXISTING dead code — leave them, note only.
**Gate:** `npx tsc --noEmit` exit 0 (catches every orphaned consumer).

### Task M2: Remove dead `cmd_report_cached_ranges` IPC + suppress plumbing
Same file + `FastStreamPlayer.tsx`. Remove: `reportRangesToBackend` (1484–1509) + `flushRangeReport` (1511–1530) + ref shim (1536–1537, 1778) + call sites (2765, 3199–3208 → the whole mpegts STATISTICS handler dies with M1 since both halves are now gone, 5610, 5616, 6199, 6266, 6433, 6512, 6991, 7065); `pendingRangesRef`/`rangeReportTimer` (1167–1168); `suppressBackendReportsRef` (1351, 1486) + `setSuppressBackendReports` (8326–8327, 8450) + all FSP usages (264, 307, 704, 735, 744, 748, 759, 774, 781). KEEP `trackDownloadedRange` (5578 area — frontend-local, separate consumer). Fix stale comment `stream_cache.rs:588`.
**Gate:** `npx tsc --noEmit` exit 0; `grep -c "cmd_report_cached_ranges" app/src -r` = 0.

### Task M3: Update legacy test file
`app/src/__tests__/SpeedMeterAndThumbTimeout.test.ts`: drop the old 3-arg `speedMeterValue` import/suite (superseded by T1 tests); keep thumbnail-timeout suites untouched.
**Gate:** full `npx vitest run` green.

## Phase V — Full verification & validation

### Task V1: Full-stack gates
`cargo build --no-default-features` + `cargo test` · `npx tsc --noEmit` · `npx vitest run` (all green) · `git diff --stat` review: no CRLF blowups, no unrelated files.

### Task V2: Hand to user for `tauri dev` (COLD restart — Rust changed)
Manual validation checklist (BEFORE/AFTER):
1. Cold start uncached file → meter live within ~1.5s, magnitude ≈ Task Manager network rate (was: 2× spike, +10%).
2. Fully-cached replay → meter shows "—" (was: disk MB/s labelled Telegram).
3. Kill network (WARP toggle) mid-stream → meter drops to "—/0" within ~3.5s (was: frozen forever).
4. Prebuffer pause → "—" persists (unchanged, "paused means paused").
5. TS/remux tier + seek → meter keeps tracking real download (was: frozen post-seek).
6. Speed-limit 256 KB/s → meter reads ≈256 KB/s.

## Risks
- Site #7 (`fs.rs` explicit download) also counts non-playback downloads — intended: meter = "data getting fetched from Telegram".
- Removing the mpegts STATISTICS handler: verify no third consumer inside it before deletion (read the full block first).
- `useMSEPlayer.ts` edits: Python byte-exact replacement only; re-read seams after every splice (eaten-declaration bug).
