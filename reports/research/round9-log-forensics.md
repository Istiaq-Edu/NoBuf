# Round-9 Log Forensics — BLIND sweep (9-c.md 698 lines / 9-t.md 398 lines, session 2026-08-03 16:13–16:17)

File: Inception 720p MKV, 1,566,651,347 B, 8888.136 s, cue-less, avg bitrate = 1,566,651,347/8888.136 = **176,265 B/s**. GOP ≈ 10.4 s.
Fresh cache session (STARTUP-CLEANUP removed prior stream-cache, t:20–22).

## A. Round-8 fix verification — both fixes CONFIRMED in e2e

| R8 fix | Verdict | Evidence |
|---|---|---|
| I1 audio-switch E3 conflation | **FIXED** | c:191 `setDesiredAudioTrack(3)` at 16:14:14 mid-playback → c:197 in-flight refill seek (3341.50s, c:186) correctly condemned (`Seek canceled/disposed`) → c:212 `[AUDIO] mkv switch → track 3 complete at kf=3324.49s (paused=false)`. Grep-verified: 0 hits for `rejected`/`E3` in both logs. Wall time **< 1 s** (t:182 switch start and t:186 complete both stamped 16:14:14; sub-second value not measurable from these logs). |
| I3 shadow saturation | **FIXED** | `shadow=20.9s` on all three bisect seeks (c:154, c:296, c:669). 2 × 10.45 s GOP = 20.9 ✓ — no longer pinned at SEEK_SHADOW_MAX_S=35.0. Gap filter working. |
| R7 regression check | **CLEAN** | 0 remux reroutes, 0 `No keyframe found`, every seekTo resolved a keyframe. |

## B. Issues found (blind enumeration): **7**

### I-1 (MAJOR, perf) Cold far-seek click→frame = 13.0–15.2 s
- Seek 3318.1s: `SEEK-TO-PLAY: 15222ms` (c:178). Bisect 3 probes/6.0MB/7.3s (c:154); getKeyPacket incl. bisect 14,939.8ms (c:155).
- Seek 4284.6s: `SEEK-TO-PLAY: 13026ms` (c:690). Bisect 2 probes/4.0MB/2.6s (c:669); getKeyPacket 12,834.2ms (c:670).
- Control: warm seek 3686.8s = **465ms** (c:317), walk region all disk-HIT, getKeyPacket 280.8ms (c:297) → pipeline is network-bound, not CPU-bound.
- Decomposition (arithmetic):
  - #1: injected cluster 561,093,427 @ ticks 3,275,731 (3275.73s); kf found 3317.94s → forward walk spans 42.2s ≈ 42.2×176,265 ≈ **7.4 MB** serial Telegram fetch.
  - #2: injected 738,217,347 @ 4183.30s; kf 4283.613s → walk **100.3s ≈ 17.7 MB**. Stop happened because bracket gap 753,127,152 − 738,217,347 = 14,909,805 B = **14.2 MiB ≤ 16 MiB stop-gap** → the ≤16MiB stop bound directly permits ~95s walks (16 MiB ≈ 95.2s at avg bitrate).
- Amplifier: the walk region gets **no proactive coverage** (see I-2), so every byte of it is fetched by the walk itself at cold-start Telegram speed (~1.4–1.7 MB/s observed).

### I-2 (MAJOR, backend correctness) PROACTIVE anchors at the frontend's linear byte ESTIMATE (−2 MiB), never the bisect-injected cluster byte — 3/3 occurrences, mechanism verified byte-exact
- **Mechanism (verified by arithmetic, 3/3 within 1 byte):** reported byte = `seekTime × (fileSize/duration) − 2 MiB`. 3318.10s → est 584,859,751 − 2,097,152 = 582,762,599.7 vs reported 582,762,599 (Δ+0.7); 3686.78s → Δ+0.6; 4284.64s → Δ+0.0. Source: `SEEK_BYTE_BACKOFF = 2 * 1024 * 1024` + `cmd_report_playback_position({byteOffset})` at useMSEPlayer.ts:9362–9364. It lands inside seek-bisect probe #1's range only because probe #1 seeds from the same linear estimate — the report is never updated after `injectMkvClusterPosition` resolves the true cluster byte.
- 16:13:50 (t:158): playhead byte 582,762,599 → proactive SEQUENTIAL gap starts right there (t:159); actual post-seek read start **560,988,160** (t:163). → ~21.8 MB (walk + first buffer) below the window; playback bootstrapped it serially (t:164–181 CACHE-POLL bootstraps).
- 16:16:21 (t:365): re-eval anchors at 753,127,152; injected cluster = 738,217,347 → **anchor error = 14.2 MiB** (= the bracket gap). Proactive gap start 760,177,680 = anchor + 7,050,528 B, which is **exactly 40s × avg bitrate** — the designed re-eval lookahead (streaming.rs:1107/1120 "40s ahead offset"). So of the 22.0 MB between injected byte and window start, ~14.2 MiB is anchor error (fixable), ~7.05 MB is by-design lookahead. The 738–760M walk region fell to playback bootstrap (t:372–375).
- 16:15:00 (t:268): same pattern, anchor 647,747,016 = est(3686.78s) − 2 MiB; harmless here only because hovers had already disk-cached the walk region.
- Fix direction: report the injected cluster byte the moment the bisect resolves (before the walk starts) so PROACTIVE covers the walk region — the single highest-leverage cut into I-1. Side effect fixed too: bogus "playhead jumped" re-evaluations triggered by the estimate. Open question for r3: whether the 40s lookahead should also shrink right after a cold seek (walk region is exactly where /stream needs help).
- Note: this is the R8-deferred open item, now with hard evidence ×3 and the exact source-level mechanism.

### I-3 (FUNCTIONAL BUG, Windows) Cache discard + shutdown leave locked files every session
- 16:16:36 (t:380–383): user chose cache-dialog-discard → `delete_cache: Could not delete data file for msg 109 (os error 32 — in use), queued for deferred deletion after handles close` — but the queue never fires before exit.
- 16:17:11–12 (t:394–397): shutdown clear: `109.dat` still os-32 locked; `remux\subs` **Access denied (os error 5)**; "2 files still locked after retry — will be cleaned on next startup".
- Chronic: THIS session's startup (t:20–21) removed the previous session's orphaned stream-cache — i.e. every session leaks, every next session cleans. Frontend released its side (TauriStreamSource disposed ×2, c:696/698) 34+ s before exit, so the holder is backend-side (candidates for r2: parked cache-poll pollers, PROACTIVE loop's File, warmer reader, subs remux dir handle).
- Impact: "discard" silently doesn't free ~600 MB until next launch; os-5 on a directory suggests a second, distinct holder in the subs remux path.

### I-4 (MINOR, waste) Audio-switch performs redundant transmux + duplicate appends; seek flush doesn't clear stale queued appends
- Switch at 3326s ran TWO rebuild passes (seekTo 3326.60 c:196–204, then chain-restart refill seekTo 3326.71 c:211–218) plus a follow-up `Discontinuity refill: keyframe=3324.49s, flushed 5 segments` (c:227).
- Byte-identical duplicate appends prove double work: #22/#28 = 213,832B, #23/#29 = 312,767B, #24/#30 = 96,397B — the second trio lands with **zero SB growth** (SB stays [3324.49–3343.80], c:228–230). ≈ 623 KB re-transmuxed/re-appended.
- Stale queue hygiene: `updateend #9: 4768ms, 1429B, SB=<empty>` (c:152) and `#20: 8574ms, 775B, SB=<empty>` (c:205) — tiny pre-flush appends survive the seek/switch flush and land seconds later into an emptied SourceBuffer (harmless only because the next init segment resets the parser).

### I-5 (MINOR, waste/UX) Embedded-subs re-extraction with zero progress possible
- Track 3 extracted `647 chars (srt, partial)` at 16:14:29 (t:220) AND identically at 16:14:55 (t:258) — same 647 B. Each run spawns ffmpeg and re-streams the same 33.5 MB cached prefix (t:197–219 and t:236–257; frontier fixed at 33,554,432 because playback jumped to 561M+ and the head region never grows).
- No "cache-frontier grew since last attempt" gate → any retry is guaranteed byte-identical. User-visible: subs cover only ~first 2.5 min of the film.

### I-6 (MINOR, UX/log) Hover captureAtTime poll spam + cold-hover latency
- Grep-counted polls per hover target: 6018.4s → **48** calls (bisect 12.1 s, 8 MB, c:438); 4942.3s → **37** (bisect 9.1 s); 3945.9s → **20**; 4175.0s → **12**. Warm targets resolve in 2 calls (3796.4s, 3507.4s — bisect 0.1 s). Totals: **115** `result false` vs 6 `result true` lines this session.
- Poll loop has no bisect-aware backoff; each miss logs 2 lines → 230+ noise lines. bisectMemo held (exactly one bisect per bucket ✓) — spam and latency are cold-network artifacts, but the retry loop should await the in-flight bisect instead of polling.

### I-7 (COSMETIC) Log hygiene
- `[Player] MSE URL is null (mpegts.js mode)` printed twice on the MKV/transmuxer path (c:6, c:12) — mislabel.
- `MKV has no Cues` warn drags a 60-line React commit stack into the console (c:50–113).
- **67** `Buffer ahead … exceeds cap 30s` lines/session (grep-exact); buffer oscillates 17→45 s (soft cap + one ~20 s refill chunk overshoot — by design, but noisy).

## C. Non-issues checked and cleared
- Double MSE init + double dispose = React dev StrictMode double-effect (c:4–13, c:692–698) — benign.
- MTProto `bad salt` / salt re-send (t:40–43) — auto-recovered, benign.
- `[FMP4-KF] Data file not ready` ×2 (t:65–66) — pre-cache-init, returns empty index, benign.
- Warmer re-anchors to seek region correctly (t:175 onward); coordinator dedups warmer/proactive/playback overlaps via subscriptions.
- I2-registry (R8 deferred, hover/playback split caches): no direct double-pay occurred this session — seek #2's probe even scored a disk HIT off a prior hover's bytes (t:367–368). Registry sharing would have saved ~1 probe. Still open, still deferred.

## D. Priority recommendation
1. **I-2 + I-1 coupled** (report injected cluster byte → proactive covers the walk; optionally revisit 16MB stop-gap): directly attacks the 13–15 s cold seeks.
2. **I-3** file-handle lifecycle on delete/exit (functional bug, Windows-specific).
3. I-4, I-5, I-6, I-7 as cheap hygiene follow-ups.
