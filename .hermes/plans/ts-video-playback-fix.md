# TS Video Playback Fix — LuluStream.ts crash + wrong-remux-URL bug

**File:** `2 Hot TS Share BBC COMPLETE SCENE.ts` (msg 5, 1.18 GB) played fine.
**File:** `LuluStream.ts` (msg 2, 1.14 GB, 5471s) crashed with `MEDIA_ERR_DECODE` at ~100s.
**Logs:** `1-c.md` (2235 lines, console), `1-t.md` (218 lines, Rust).

---

## Evidence (verified)

### ffprobe on `D:\DEVELOPMENT\Telegram-Drive\LuluStream.ts`
```
program 1, pmt_pid=0x0FFF, pcr_pid=0x100, nb_streams=3
  stream 0  h264   PID 0x100  codec_tag=0x001b
  stream 1  aac    PID 0x101  codec_tag=0x000f  ← ADTS, 44.1kHz, mp4a.40.2
  stream 2  data   PID 0x102  codec_tag=0x20334449  ← "ID3 " timed metadata
```

The audio is **plain ADTS AAC**. There is NO LATM in this file. The third stream is
timed ID3 metadata (`stream_type=0x15` in PMT — confirmed by both `id=0x102` and
`codec_tag="ID3 "`).

### ffprobe packet timing on stream 1 (real audio)
```
pts_time=0.101000, 0.124222, 0.147444, 0.170667, ...  diff=0.023222s steady
```
Source pacing is exact: `1024 / 44100 = 0.023220s` per AAC frame. No drift at the
bytes-on-disk level. The drift in playback is introduced downstream, not by the file.

### Console drift pattern (mpegts.js `[TSDemuxer] AAC: Detected pts overlapped`)
| Occurrence | expected (ms) | actual (ms) | drift (ms) |
|------------|---------------|-------------|------------|
| 1 | 797.6 | 820.8 | **+23.2** |
| 2 | 1517.4 | 1540.6 | +23.2 |
| 5 | 3676.9 | 3700.1 | +23.2 |
| mid | 50000 | 50209 | **+209** |
| last (#140) | 100457.6 | 100945.2 | **+487.6** |

Drift = exactly one AAC frame per overlap event (23.22ms = 1024/44100).
Total drift accumulates linearly until ~487ms → browser decoder rejects `appendBuffer`
→ `HTMLMediaElement.error code=3 (MEDIA_ERR_DECODE)` → FATAL handler fires →
`[MPEGTS] FATAL: falling back to ffmpeg remux`.

### Wrong-URL FATAL fallback (console line 39, while playing msg 2)
```
useMSEPlayer.ts:12 [MSE] Using ffmpeg remux fallback:
  http://localhost:14201/remux/3574767635/5?token=...  ← /5 instead of /2
```

### Source verified (all line numbers from `app/src/hooks/useMSEPlayer.ts`)
- Line 1017: `cancelledRef.current = false` — reset on every effect run (StrictMode-unsafe).
- Line 1075: `initMP4Box(streamUrl, ...)` — `streamUrl` captured in closure.
- Line 2359: `setTimeout(reject, 10000)` — inner MEDIA_INFO timeout, hard-coded 10s.
- Line 3744: `parseStreamUrl(url)` — `url` is closure capture from prior file.
- Line 3776: `parseStreamUrl(url)` — same closure, builds the wrong /remux URL.
- Line 2177: FATAL handler builds remux from `parsed` (passed to `_initMpegtsPlayer`,
  so this one is correct by the time FATAL fires).
- grep `streamUrlRef` → 0 hits (no ref exists).

### Source verified (`app/src-tauri/src/hls/manifest.rs` + `server.rs`)
```
manifest.rs:48   const REWRITE_STREAM_TYPES: &[(u8, u8)] = &[(0x15, 0x11)];
manifest.rs:1300 rewrite_pmt_stream_types(buf, ...)  // HLS segment path
manifest.rs:1956 rewrite_pmt_stream_types(...)       // HLS init-prefix path (with PID rewrite)
manifest.rs:2017 rewrite_pmt_stream_types(...)       // init-prefix no-rewrite path (mpegts.js)
server.rs:186    rewrite_pmt_stream_types(buf, ...)  // /stream live TS path
```
All four call sites apply the SAME unconditional 0x15→0x11 rewrite from the const at
line 48. No descriptor inspection. No PID-class check. The stale comments at
manifest.rs:1299 and :1955 still say "0x15→0x0F" — that's documentation rot; the
const has been 0x11 since the comment at server.rs:101-105 documented the switch.

---

## Root causes

### RC1 — Wrong remux URL on initial 10s timeout (HIGH, frontend, deterministic)
Two pipelines exist for fallback:
- **A.** Inner 10s `MEDIA_INFO` timeout at line 2359 throws → `_initMpegtsPlayer`
  returns `false` → falls through to line 3776's fallback which calls
  `parseStreamUrl(url)`. The `url` here is the closure-captured parameter from the
  PRIOR `initTransmuxerPlayer` invocation (msg 5), so the rebuilt remux URL points
  at `/remux/.../5` even though we're playing msg 2. **This is what console line 39
  shows.**
- **B.** FATAL handler at line 2177. This one uses `parsed` passed into
  `_initMpegtsPlayer` from line 3747, so by the time FATAL fires, `parsed` is
  correct (msg 2). The decoder crash at ~100s into msg 2 hits this path and
  produces a correct `/remux/.../2` URL.

The trigger that exposes RC1 is React StrictMode's double-effect-mount in dev:
mount #1 starts msg 5, cleanup fires (`cancelledRef = true`), mount #2 starts with
fresh `streamUrl = msg 2` but `cancelledRef` is reset to `false` (line 1017) and
the closure inside `onSourceOpen` still holds `streamUrl = msg 5` from the
freshly-running effect. Then a separate file switch (player closed → user clicks
msg 2) reuses the same effect identity and the stale captures from the first
init persist into the failure path.

**Smoking gun:** no `streamUrlRef` exists. There is no live reference that the
fallback path could read to get "the URL we actually want to play right now."

### RC2 — Phantom audio stream from blanket PMT rewrite (CRITICAL, backend)
The backend's `rewrite_pmt_stream_types` uses `REWRITE_STREAM_TYPES = &[(0x15, 0x11)]`
unconditionally. For `LuluStream.ts`:
1. PMT declares PID 0x101 as 0x0F (ADTS AAC) — real audio.
2. PMT declares PID 0x102 as 0x15 (timed ID3 metadata).
3. Backend rewrites 0x15→0x11 on PID 0x102 → mpegts.js sees PID 0x102 as
   `kLOASAAC` (LATM-AAC).
4. mpegts.js attempts to parse ID3 metadata PES payloads as LATM AAC frames.
5. ID3 metadata packets exist in PES form on this PID with PTS values aligned to
   the video timeline. Parsing them as audio creates phantom AAC frames with
   timestamps that interleave with the real audio track on PID 0x101.
6. mpegts.js's internal "expected next sample timestamp" counter (used for
   `parseADTSAACPayload` continuity checks on the real audio stream) gets pushed
   back by one AAC-frame worth (1024/44100 = 23.22ms) every time a phantom frame
   slots into the timeline.
7. Drift accumulates linearly. At ~487ms cumulative drift, the browser decoder
   rejects the next `appendBuffer` call → `MEDIA_ERR_DECODE` → FATAL fallback.

The PTS-overlap warning fires from `parseADTSAACPayload` (ts-demuxer.ts:1315),
which is the real audio path. That's consistent: the phantom LOAS stream
poisons the shared "next expected PTS" tracker that the ADTS parser reads.

Note the existing 0x15→0x11 was itself a fix for a *different* file class (genuine
LATM audio at 0x15). That fix is still needed for those files — the bug is that
the rewrite is unconditional. Removing the rewrite entirely would regress those
files. Removing it only for ID3-marked streams fixes both classes.

### RC3 — Inner 10s timeout vs outer 20-60s timeout (MEDIUM, frontend)
Outer MSE init timeout (line 1085-1109) extends from 20s up to 60s if
`transmuxerInitInProgressRef.current === true`. But the inner `MEDIA_INFO` wait
at line 2358-2367 hard-codes a 10s timeout that throws unconditionally.

When the network is contended or the first chunk lands slowly, `MEDIA_INFO` can
take 11-15s on the first mount even when nothing is actually wrong. The 10s
fires → `_initMpegtsPlayer` returns `false` → the buggy line-3776 fallback
runs with a stale closure. Console line 37-39 shows exactly this sequence.

### RC4 — `2.dat` locked on cleanup (LOW, cosmetic)
Rust log lines 213-217: the proactive downloader's retry timer (2321ms backoff)
outlives the cache-cleanup retry window (1s). File stays locked, log says
"will be cleaned on next startup" — and startup cleanup at line 20-21 confirms
it works. Self-healing, not user-visible.

---

## Phase 1 — Stale-closure / wrong-URL fix (FRONTEND, can ship independently)

**Files:** `app/src/hooks/useMSEPlayer.ts`

### 1.1 Add a generation counter and a live URL ref
Near the top of the hook (around line 1000, before the main `useEffect`):
```typescript
const effectGenerationRef = useRef(0);
const streamUrlRef = useRef<string | null>(null);
```

### 1.2 Bump generation on every effect run + record URL
At line 1015-1018, replace:
```typescript
prevUrlRef.current = streamUrl;
cancelledRef.current = false;
transmuxerInitInProgressRef.current = false;
```
with:
```typescript
prevUrlRef.current = streamUrl;
cancelledRef.current = false;
transmuxerInitInProgressRef.current = false;
effectGenerationRef.current += 1;
const myGeneration = effectGenerationRef.current;
streamUrlRef.current = streamUrl;
```

### 1.3 Guard `onSourceOpen` with generation + identity
At line 1072, replace:
```typescript
const onSourceOpen = () => {
  if (cancelledRef.current) return;
  diagLog('[MSE] sourceopen event fired — starting format detection and player init');
  initMP4Box(streamUrl, mediaSource, blobUrl!);
};
```
with:
```typescript
const onSourceOpen = () => {
  if (cancelledRef.current) return;
  if (myGeneration !== effectGenerationRef.current) {
    diagLog('[MSE] sourceopen for stale generation — ignoring');
    return;
  }
  if (state.current.mediaSource !== mediaSource) {
    diagLog('[MSE] sourceopen for stale mediaSource — ignoring');
    return;
  }
  diagLog('[MSE] sourceopen event fired — starting format detection and player init');
  initMP4Box(streamUrl, mediaSource, blobUrl!);
};
```

### 1.4 Rebuild fallback URLs from the live ref, not the closure
At line 3776 (non-FATAL fallback):
```typescript
const liveUrl = streamUrlRef.current ?? url;
const parsedFallback = parseStreamUrl(liveUrl);
```
At line 2177 (FATAL handler) — defence-in-depth, even though current path is
correct:
```typescript
const liveUrl = streamUrlRef.current ?? `${parsed.baseUrl}/stream/${parsed.folderId}/${parsed.messageId}?token=${parsed.token}`;
const parsedLive = parseStreamUrl(liveUrl) ?? parsed;
const remuxUrl = `${parsedLive.baseUrl}/remux/${parsedLive.folderId}/${parsedLive.messageId}?token=${encodeURIComponent(parsedLive.token)}`;
```

### 1.5 Verify cleanup invalidates the generation
The existing cleanup at line 1115-1148 already sets `cancelledRef = true`. The
generation counter naturally invalidates stale callbacks because the next effect
run bumps the counter past whatever the stale callback captured. No change
needed in cleanup beyond what's already there.

---

## Phase 2 — Descriptor-aware PMT rewrite (BACKEND, fixes the crash)

**Files:** `app/src-tauri/src/hls/manifest.rs`, `app/src-tauri/src/server.rs`

### 2.1 Centralize the conditional logic inside `rewrite_pmt_stream_types`
Find the function (search `pub fn rewrite_pmt_stream_types` — it's referenced
at manifest.rs:1300, 1623, 1956, 2017 and server.rs:186 so callers need not
change).

The function iterates over the PMT ES-info loop. For each entry, it currently
checks `stream_type ∈ REWRITE_STREAM_TYPES.iter().map(|(from,_)| from)` and
rewrites if matched. Add two skip conditions BEFORE the rewrite:

**Skip condition A — ID3 registration descriptor.**
For each 0x15 entry, parse its ES-info descriptor loop. ES-info starts at
`entry_offset + 5` and has length `(((buf[entry_offset+3] & 0x0F) << 8) | buf[entry_offset+4])`.
Walk descriptors as `[tag, length, ...]`. If a descriptor with `tag == 0x05`
(registration_descriptor) has the first 4 bytes of its value equal to
`b"ID3 "` (`0x49 0x44 0x33 0x20`), skip the rewrite for this entry.

**Skip condition B — sibling ADTS AAC present.**
Before entering the ES loop, scan the same PMT once and record whether any
entry has `stream_type == 0x0F` (kADTSAAC). If yes, files with mixed 0x0F + 0x15
are almost certainly ADTS-audio + ID3-metadata layouts (the LuluStream.ts case).
Skip the 0x15→0x11 rewrite for all 0x15 entries in this PMT.

Both conditions combined: skip if (descriptor says ID3) OR (sibling ADTS exists).
Apply rewrite only when neither condition holds — preserving the original fix
for genuine LATM-at-0x15 files which have no 0x0F sibling and no ID3 marker.

### 2.2 Recompute CRC32 conditionally
The current code recomputes CRC after the rewrite call. If `rewritten == 0`,
the CRC is unchanged so recomputation is a no-op (same bytes in, same bytes
out). Verify this by adding an `if rewritten > 0` guard around the CRC32 write
at all four call sites to skip the work when no bytes changed.

### 2.3 Fix stale comments
- manifest.rs:1299 — change `(0x15→0x0F)` to `(0x15→0x11, conditional)`
- manifest.rs:1955 — same fix
- manifest.rs:43-47 — update docstring to describe the conditional logic

### 2.4 Add a log line when rewrite is skipped
```rust
log::info!("[STREAM-TS] Skipped rewrite of stream_type 0x15 on PID 0x{:04X}: ID3 metadata or sibling ADTS present", pid);
```
This makes it diagnosable when the new conditional fires.

---

## Phase 3 — Frontend safety nets

### 3.1 Bump inner MEDIA_INFO timeout (one-liner)
Line 2359: change `10000` to `20000`. Also update the comment at line 2353-2355
that incorrectly cites "0x15→0x0F" — it's been 0x15→0x11 since the
server.rs:101-105 comment block.

### 3.2 PTS drift watcher
Even with the backend fix shipped, defensive measure for future PMT-weird files.
In `_initMpegtsPlayer`, hook the logger output for `pts overlapped` warnings.
mpegts.js exposes `MpegtsPlayer.LoggingControl` and a logger event bus. Parse the
expected/actual values out of the message, accumulate `(actual - expected)`,
and if cumulative drift exceeds **200ms across 5 consecutive overlaps**
(debounce against transient network jitter), trigger the FATAL→remux path
preemptively before the decoder crashes:
```typescript
const driftThresholdMs = 200;
const consecutiveOverlapsRequired = 5;
let consecutiveOverlaps = 0;
let cumulativeDrift = 0;
// (hook the warn logger, parse "expected: X ms, PES pts: Y ms")
// On match: cumulativeDrift += (actual - expected); consecutiveOverlaps += 1
// If both thresholds exceeded → call the FATAL fallback path directly.
```

### 3.3 Move `LuluStream.ts` out of project root
1.1 GB file at the repo root will get picked up by git status. Either add to
`.gitignore` or move to `.hermes/test-fixtures/`. **Ask user first.**

---

## Phase 4 — RC4 cache-lock cleanup (cosmetic, optional)

Extend `clear_all_robust` retry window from 1s to 5s, and signal the proactive
download abort before invoking cache cleanup so the 2.3s retry doesn't outlive
cleanup. Self-healing already works; this just removes the warning line.

---

## Test cases

| # | Scenario | Expected after fix |
|---|----------|--------------------|
| 1 | Open msg 5 (BBC), play 2 min, close. Open msg 2 (Lulu), play 2 min. | Both play to completion. No `[MPEGTS] FATAL`. |
| 2 | Open msg 2 (Lulu) cold, play 5 min straight. | No PTS overlap warnings. No remux fallback. |
| 3 | Rapidly switch msg 5 → msg 2 → msg 5 → msg 2 (5 cycles). | Each play starts cleanly. Any remux fallback URL matches the currently-playing msg id. |
| 4 | Open msg 2 on a throttled network (>10s to first MEDIA_INFO). | No false "10s timeout" → no fallback. Inner timeout is 20s. |
| 5 | Open an MP4 file (regression). | Still plays via mp4box pipeline, no change. |
| 6 | Open a TS file with no audio track. | Plays video only, no rewrite-related errors. |
| 7 | Open a TS file with genuine AAC-LATM at stream_type 0x15 (no 0x0F sibling, no ID3 descriptor). | Backend still rewrites 0x15→0x11 — LATM audio plays correctly. |
| 8 | Open a TS file with AC3 audio (codec mpegts.js can't handle). | Falls through to /remux with the correct msg id (not a stale closure). |
| 9 | Seek backward in msg 2 to 5s, then forward to 4500s. | No drift accumulation, no decoder crash. |
| 10 | StrictMode double-mount in dev: open msg 2. | Only one mpegts.js player ends up active. Cleanup of first mount doesn't break second mount. |
| 11 | Close player mid-PROACTIVE download. | Cache cleans up without "still locked" warning (RC4 fix only). |
| 12 | Verify backend log: opening msg 2 should emit `[STREAM-TS] Skipped rewrite of stream_type 0x15 on PID 0x0102: ID3 metadata or sibling ADTS present`. |
| 13 | Verify no PTS-overlap warnings appear in the console for msg 2 playback after the backend fix. |
| 14 | Trigger the drift watcher artificially (mock a synthetic file with phantom drift). Verify preemptive remux switch at >200ms cumulative + 5 consecutive overlaps. |

---

## Implementation order

1. **Phase 1** (frontend stale-closure) — deterministic, independent of audio
   work. Ship first. Test with #1, #3, #10.
2. **Phase 3.1** (10s → 20s) — one-liner. Ship with Phase 1. Test with #4.
3. **Phase 2** (backend conditional rewrite) — fixes the real crash. Ship
   second. Test with #2, #7, #12, #13.
4. **Phase 3.2** (drift watcher) — defensive net. Ship third. Test with #14.
5. **Phase 4** (cache cleanup) — last, cosmetic.
6. **Phase 3.3** (move LuluStream.ts) — ask user before doing anything.

---

## Risks / pitfalls

- **Removing the 0x15→0x11 rewrite entirely would regress genuine LATM files.**
  The conditional skip in Phase 2.1 must preserve the original behavior when
  neither skip condition holds.
- **Two skip conditions are needed, not one.** Some LATM files may lack a
  registration descriptor; condition B (sibling ADTS) is the safety net.
- **Don't dismiss `cancelledRef = false` reset as "needed for re-init".** The
  reset is needed; it's the lack of a generation counter alongside it that
  breaks. Phase 1 keeps the reset and adds the counter — both are required.
- **The drift watcher must debounce.** A single overlap from a network hiccup
  shouldn't trigger pipeline teardown. Use the 5-consecutive + 200ms threshold.
- **Re-test with the BBC file (msg 5).** It probably has the same 3-stream
  layout (H.264 + ADTS + ID3). The log shows it played fine for 3504s — meaning
  either its ID3 descriptors are slightly different OR it just happened to not
  trigger the decoder crash within that 60s window the user watched. The
  backend fix should also help msg 5; verify no regression.
- **`/remux` for 1+ GB files must support Range.** Both RC1 and RC2 ultimately
  fall back to `/remux`. Confirm it handles seek requests on a 1GB file before
  relying on it.
- **StrictMode is dev-only**, but the underlying stale-closure bug is real in
  production too — any rapid file switch can expose it. Don't dismiss as
  dev-only.
