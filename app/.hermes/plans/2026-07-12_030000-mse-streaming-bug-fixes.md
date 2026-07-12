# MSE Streaming Subsystem — Bug Fix Implementation Plan

> **For Hermes:** Planning artifact only. No code was changed producing this document. Each fix below is TDD-where-possible with exact paths + copy-pasteable code. Implement in the ordered phases.

**Goal:** Eliminate the reproducible `PIPELINE_ERROR_DECODE` at ~51s during MKV transmux playback, plus the cluster of verified correctness/robustness bugs it exposed across the frontend MSE pipeline and the Rust streaming server.

**Architecture:** MKV files are transmuxed to fMP4 in-browser (`MediabunnyTransmuxer`), fed through a queued `SourceBufferWrapper` into MSE, with bytes served by an Actix-web server (port 14201) that downloads ranges from Telegram and lets HTTP range requests subscribe to in-flight downloads.

**Tech Stack:** TypeScript + React (frontend), `mediabunny` (transmux), MSE; Rust + Actix-web + `grammers` (backend).

---

## Root-Cause Summary (verified against source)

The 51.44s decode crash is **GOP overlap**. Every refill calls `transmuxer.seekTo(bufferEnd, …)`, which finds the keyframe **at or before** the buffer end and re-emits the **entire GOP** from that keyframe forward (`iterateVideoPackets`/`iterateAudioPackets`, `MediabunnyTransmuxer.ts:1437-1522`, have **no lower-bound trim**). MSE coded-frame replacement then splices a freshly-transmuxed GOP over already-buffered frames; at the seam a P-frame ends up referencing a replaced/misaligned reference frame → decode death.

Contrast: `sequentialContinue` (`:975-1023`) **does** carry a lower-bound skip (`packet.timestamp < skipBeforeTime - 0.5` at `:984,:1008`) — but the refill `seekTo` path does not.

**Rejected alternative:** "concurrent `read()` corruption in TauriStreamSource." `mediabunny`'s `CustomSource.read` is awaited serially by the demuxer; refills are sequential `seekTo` calls, not overlapping `read()`s. Not the cause.

**Retracted earlier claim:** Rust "prebuffer off-by-one." The arithmetic is correct inclusive math; the real defect is the coverage check (Fix 6) + a misleading WARN log.

---

## Online cross-validation (authoritative sources)

Every load-bearing claim in this plan was checked against primary sources, not just the codebase. Results:

**A. MSE coded-frame processing / random-access-point requirement — CONFIRMED (strong).**
Chromium's actual implementation, `media/filters/frame_processor.cc` (`FrameProcessor::ProcessFrame`, step 10.1), reads verbatim:
> "If the need random access point flag on track buffer equals true … If the coded frame is not a random access point, then drop the coded frame and jump to the top of the loop."
This is the exact spec behavior (W3C MSE §coded-frame-processing) that makes **Strategy A correct and the naive "skip past the keyframe" approach fatal**: an append that begins on a non-keyframe is silently dropped, stranding dependent P-frames → decode error. My plan's "CRITICAL DESIGN NOTE" is validated by the reference implementation.

**B. Root cause corroborated by a Chromium media engineer (crbug 41200537).**
That thread is nearly our exact symptom — decode error minutes into MSE playback with `remove()`/append cycling. Chromium's `wolenetz@` diagnosis (comment #40):
> "(B) Per MSE spec, if the removal range includes a decode dependency, then all dependents are also removed. (C) … a mismarked stream that has had partial GOPs removed might feed a non-keyframe to the decoder without having first fed the required decode dependencies … causing decoder stall (or decode error from (C))."
And critically (comment #27):
> "what is the interval between key-frames? If very large, this could be why GC eviction is failing and giving QuotaExceededError … a GOP that contains the current playback position will not be GC'ed."
This independently confirms **both** our bugs: the GOP-overlap decode death (Fix #1) **and** why eviction fails with large GOPs (Fix #4). Our file's GOPs are ~7-10s — squarely in the "large GOP" regime the engineer flags.

**C. NEW corroborated constraint → adds a refinement to Fix #4 / eviction.**
Chromium engineers (crbug 41200537 #40, workaround 2) warn that `remove(start, currentTime)` is unsafe because Chrome **conflates DTS for PTS in the `remove()` API** (crbug 373039), and removing too close to `currentTime` can evict the GOP being fed to the decoder → the *same* decode error we're fixing. Their guidance: leave **≥ keyframe_interval × 2** between the remove-end and `currentTime`.
→ **Action:** our `evictOldBuffer` uses `BUFFER_KEEP_BEHIND = 30` (`useMSEPlayer.ts:533`). 30s ≥ 2× our ~10s GOP, so we are **safe by luck**, not by design. Fix #4's implementation must add a comment pinning `BUFFER_KEEP_BEHIND ≥ 2 × maxGOP` and assert it, so a future tuning of that constant can't silently reintroduce the decode crash.

**D. `timestampOffset` mutation constraint — CONFIRMED, and it hardens Fix #4/#5.**
W3C MSE + WebKit `SourceBuffer.cpp` + Chromium WPT (`mediasource-append-buffer.html`: "set timestampOffset throws … when updating attribute is true"): `timestampOffset` may only be set while `updating === false`. Our `SourceBufferWrapper.setTimestampOffset` already guards on `updating` (`:220`), but this confirms the Fix #4 rewrite **must** preserve the "wait for idle" guard (it does) and must not set the offset mid-append.

**E. `stco` → `co64` 4GiB promotion — CONFIRMED (Fix #10).**
Apple ISOBMFF docs: `co64` "is used in place of the original chunk offset atom" when 64-bit offsets are needed; libgpac exposes `gf_isom_force_64bit_chunk_offset`. Confirms a faststart that shifts 32-bit `stco` offsets past `u32::MAX` MUST promote to `co64` (or bail) rather than `wrapping_add`. Fix #10 stands.

**F. HTTP Range inclusivity — CONFIRMED (retraction upheld).**
RFC 7233 / RFC 9110: byte ranges are inclusive on both ends; `Content-Range` reflects the inclusive first-byte/last-byte. This upholds my retraction of the "off-by-one" — the coordinator's `end - start + 1` math is correct; Fix #6 (coverage check) is the real defect.

**Net effect on the plan:** No fix is invalidated. One refinement added (item C → Fix #4 must assert `BUFFER_KEEP_BEHIND ≥ 2×maxGOP`). Confidence in Fix #1 (decode crash) and Fix #4 (eviction) raised from "high" to "confirmed against the reference MSE implementation and a Chromium media engineer's diagnosis of the identical symptom."

---

## CRITICAL DESIGN NOTE for the decode fix (read before Phase 1)

The naive fix — "skip every packet before `bufferEnd`" — is **WRONG** and will make decoding worse. If the keyframe is at 44s and we skip everything before the 51s buffer end, the first appended packet is a P-frame with no keyframe → instant `PIPELINE_ERROR_DECODE`. A decodable append **must begin at a keyframe**.

Therefore there are two valid strategies. The plan implements **Strategy A** (abut, preferred) and keeps **Strategy B** documented as fallback.

- **Strategy A — Abutting refill (no overlap):** Seek the refill to the **first keyframe at or after the current buffered end**, not before it. Consecutive refills then join at a keyframe boundary with zero re-transmuxed overlap → no coded-frame replacement at all. Requires a "keyframe at/after time" lookup (the transmuxer already parses 419 cue points, so this is available).
- **Strategy B — Overlap but exact replacement (fallback):** Keep seeking to the keyframe at/before buffer end, but guarantee byte-exact frame replacement by NOT re-adjusting timestamps differently between runs. This is fragile across independent transmux passes and is only a fallback if Strategy A regresses cold-seek latency.

**Open question to resolve during Phase 1 Task 1.0 (spike):** Does seeking to the *next* keyframe (Strategy A) ever leave a 1-frame gap between the old buffer end and the new keyframe (i.e., buffered end lands mid-GOP)? If the old refill stopped exactly at a GOP boundary, there is no gap; if it stopped mid-GOP (because `maxDuration` cut it), there is. Task 1.0 measures this before committing to A.

---

## Phase 0 — Safety net (do first)

### Task 0.1: Capture a deterministic repro fixture

**Objective:** Make the 51s crash reproducible without Telegram, so fixes are verifiable.

**Files:**
- Create: `app/src/lib/faststream/players/__tests__/fixtures/README.md`

**Steps:**
1. During a live `tauri dev` MKV playback, save the browser console log (already have one) and note: file duration 3548.09s, GOP ~7-10s, crash at video ts 51441000 (51.44s), refill seams at 24.96 → kf 23.15, 40.10 → kf 33.16, 50.17 → kf 43.17.
2. Record these as the regression oracle in the README (the fix must produce refills that do not re-emit any timestamp already present in `sb.buffered`).
3. Commit.

```bash
git add app/src/lib/faststream/players/__tests__/fixtures/README.md
git commit -m "test: document 51s decode repro oracle for refill overlap"
```

---

## Phase 1 — Fix #1: decode crash (abutting refill)

### Task 1.0: Spike — add instrumentation to confirm the seam (no behavior change)

**Objective:** Prove the overlap empirically and measure whether buffer-end lands mid-GOP.

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts` around `executeStreamingRefill` (`:1681-1700`)

**Step 1: Add a one-line diagnostic before the seek**

```ts
// TEMP spike (Task 1.0): log the seam to confirm overlap vs abut
const _bufEnd = getBufferedAheadSeconds() + video.currentTime;
console.log(`[MSE][spike] refill seek target=${refillPosition.toFixed(3)} bufEnd=${_bufEnd.toFixed(3)}`);
```

**Step 2:** Run `tauri dev`, play the MKV, confirm each refill's resolved keyframe (from the transmuxer log `Seek to X: keyframe at Y`) is < `bufEnd` (overlap) and by how much.

**Step 3:** Decide A vs B based on the gap measurement. Record the decision inline in the plan file (edit this section) before proceeding.

**Step 4:** Remove the spike line, commit nothing (spike is throwaway).

### Task 1.1: Add `findNearestKeyframeAtOrAfter` to the transmuxer

**Objective:** Support Strategy A — seek to the keyframe at/after a time.

**Files:**
- Modify: `app/src/lib/faststream/players/MediabunnyTransmuxer.ts` (near `findNearestKeyframe`, search for its definition)
- Test: `app/src/lib/faststream/players/__tests__/MediabunnyTransmuxer.keyframe.test.ts`

**Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
// Import the pure keyframe-index helper (extract if currently private).
import { nearestKeyframeAtOrAfter } from '../MediabunnyTransmuxer';

describe('nearestKeyframeAtOrAfter', () => {
  const kf = [0, 7.0, 14.2, 23.15, 33.16, 43.17, 50.2, 55.71];
  it('returns the first keyframe >= t', () => {
    expect(nearestKeyframeAtOrAfter(kf, 40.10)).toBe(43.17);
  });
  it('returns t exactly when t is a keyframe', () => {
    expect(nearestKeyframeAtOrAfter(kf, 43.17)).toBe(43.17);
  });
  it('returns null when past the last keyframe', () => {
    expect(nearestKeyframeAtOrAfter(kf, 999)).toBeNull();
  });
});
```

**Step 2: Run to verify failure**

Run: `cd app && npx vitest run src/lib/faststream/players/__tests__/MediabunnyTransmuxer.keyframe.test.ts`
Expected: FAIL — `nearestKeyframeAtOrAfter is not a function`.

**Step 3: Implement (pure, exported)**

```ts
/** First keyframe timestamp >= t (binary search on the sorted cue index).
 *  Returns null if t is past the last keyframe. Mirrors findNearestKeyframe
 *  (at-or-before) but rounds the other direction for abutting refills. */
export function nearestKeyframeAtOrAfter(kfs: number[], t: number): number | null {
  let lo = 0, hi = kfs.length - 1, ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid] >= t) { ans = kfs[mid]; hi = mid - 1; }
    else { lo = mid + 1; }
  }
  return ans;
}
```

**Step 4: Run to verify pass**

Run: `cd app && npx vitest run src/lib/faststream/players/__tests__/MediabunnyTransmuxer.keyframe.test.ts`
Expected: PASS (3 passed).

**Step 5: Commit**

```bash
git add app/src/lib/faststream/players/MediabunnyTransmuxer.ts app/src/lib/faststream/players/__tests__/MediabunnyTransmuxer.keyframe.test.ts
git commit -m "feat(transmux): add nearestKeyframeAtOrAfter for abutting refills"
```

### Task 1.2: Route refill seeks to the next keyframe (abut)

**Objective:** Make `executeStreamingRefill` seek to the keyframe at/after buffer end.

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts:1681-1700`

**Step 1:** Replace the `refillPosition` computation so it snaps forward to the next keyframe when a cue index is available:

```ts
const ahead = getBufferedAheadSeconds();
const rawRefillPosition = video.currentTime + ahead;
// Strategy A: abut at a keyframe boundary — seek to the first keyframe AT OR
// AFTER the buffer end so the refill produces only NEW frames beyond what MSE
// already holds. Eliminates the GOP overlap that caused coded-frame-replacement
// to splice a misaligned P-frame → PIPELINE_ERROR_DECODE at ~51s.
const kfs = transmuxer.getKeyframeTimestamps?.() ?? null;
const nextKf = kfs ? nearestKeyframeAtOrAfter(kfs, rawRefillPosition) : null;
const refillPosition = nextKf ?? rawRefillPosition;
```

**Step 2:** Ensure the discontinuity append path (`:1798-1826`) no longer overwrites — because `keyframeTimestamp` now equals a boundary at/after buffer end, `setTimestampOffset` places new frames strictly after existing buffer. Add an assertion log:

```ts
console.log(`[MSE] Abutting refill: rawEnd=${rawRefillPosition.toFixed(2)}s → seekKf=${refillPosition.toFixed(2)}s (overlap eliminated)`);
```

**Step 3:** Manual verify via `tauri dev`: play MKV past 60s. Expected: no `PIPELINE_ERROR_DECODE`; transmuxer `Seek to X: keyframe at Y` shows Y ≥ prior buffer end each refill.

**Step 4: Commit**

```bash
git add app/src/hooks/useMSEPlayer.ts
git commit -m "fix(mse): abut refills at next keyframe to kill GOP-overlap decode crash (#1)"
```

### Task 1.3: Handle the mid-GOP gap edge case (only if Task 1.0 found a gap)

**Objective:** If buffer-end lands mid-GOP, abutting to the *next* keyframe leaves a small gap MSE won't play across.

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts` refill append path

**Approach:** Cap the *previous* refill's `maxDuration` so it always ends on a keyframe boundary (stop emitting at the last full GOP), guaranteeing the next refill's keyframe abuts exactly. Concretely: when iterating, remember the last keyframe seen and stop there rather than mid-GOP.

**Note:** Leave unimplemented if Task 1.0 shows refills already stop on GOP boundaries (likely, since `maxDuration` is generous and GOPs are ~7-10s). Document the finding.

---

## Phase 2 — Frontend buffer/quota robustness (same subsystem)

### Task 2.1: Fix #4 — `setTimestampOffset` must not silently drop queued appends

**Objective:** Stop discarding queued `remove()`/`append()` ops when the offset changes.

**Files:**
- Modify: `app/src/lib/faststream/players/SourceBufferWrapper.ts:198-232`

**Root cause:** Lines 201-202 do `this.queue = []` before applying the offset, so `evictOldBuffer()`'s `remove()` ops enqueued immediately prior (`useMSEPlayer.ts:1799-1802`) are thrown away → eviction never runs on the refill path → unbounded growth → QuotaExceeded.

**Fix:** Drain (await queue empty) before applying the offset instead of clearing it:

```ts
setTimestampOffset(offset: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const apply = () => {
      try {
        this.sourceBuffer.timestampOffset = offset;
      } catch (e: any) {
        if (e instanceof DOMException && e.name === 'InvalidStateError' &&
            e.message?.includes('removed from the parent media source')) {
          this.fatalError = true;
          this.queue = [];
          console.error('[SourceBuffer] SB removed from parent MediaSource — fatal');
        } else {
          console.error('[SourceBuffer] Failed to set timestampOffset:', e);
        }
      }
      resolve();
    };
    // Drain pending ops first (do NOT discard them), then set the offset when idle.
    const whenIdle = () => {
      if (this.fatalError) { resolve(); return; }
      if (this.queue.length === 0 && !this.processing && !this.sourceBuffer.updating) {
        apply();
      } else {
        this.sourceBuffer.addEventListener('updateend', () => setTimeout(whenIdle, 0), { once: true });
      }
    };
    whenIdle();
  });
}
```

**Caveat to verify:** The seek path (`useMSEPlayer.ts:6362-6385`) *intends* the reset+clear behavior (it buffers into `seekBufferRef` and sets offset before appending). Confirm `resetForSeek()` (which still clears) is what the seek path calls — it is — so this change only affects the refill/eviction path. Add a targeted test.

**Test:** `app/src/lib/faststream/players/__tests__/SourceBufferWrapper.offset.test.ts` with a mocked SourceBuffer asserting queued `remove` ops survive a `setTimestampOffset`.

**Commit:**
```bash
git commit -am "fix(mse): drain queue instead of dropping it on setTimestampOffset (#4)"
```

### Task 2.2: Fix #5 — `waitForQueueDrain` must not hang on QuotaExceededError

**Objective:** Unblock awaiters when the queue stalls on quota.

**Files:**
- Modify: `app/src/lib/faststream/players/SourceBufferWrapper.ts:287-308` (and the quota branch `:175-180`)

**Fix:** Resolve `waitForQueueDrain` when `quotaExceeded` is set (mirrors the `fatalError` early-out):

```ts
const checkAndResolve = () => {
  if (this.fatalError || this.quotaExceeded) { resolve(); return; }
  if (this.queue.length === 0 && !this.processing) { resolve(); return; }
  this.sourceBuffer.addEventListener('updateend', () => setTimeout(checkAndResolve, 0), { once: true });
};
```

**Commit:**
```bash
git commit -am "fix(mse): resolve waitForQueueDrain on quota stall to avoid deadlock (#5)"
```

### Task 2.3: Fix #8 — implement `checkFatalError` (currently a no-op)

**Objective:** Make the SourceBuffer `error` event actually mark fatal state.

**Files:**
- Modify: `app/src/lib/faststream/players/SourceBufferWrapper.ts:42-46,121-129`

**Fix:** In the `error` listener, read the owning media element's error if reachable; otherwise set a soft flag that the next failed append confirms. Minimal safe version:

```ts
private checkFatalError(): void {
  // The SB 'error' event fires on append/decode failure. We cannot read
  // HTMLMediaElement.error from here, but we can stop trusting the buffer:
  // flip processing off and let the next processQueue catch confirm fatal.
  // If a decode error already occurred, further appends are futile.
  this.quotaExceeded = false; // not quota; a real error
  // Do not hard-fatal (could be transient), but surface it:
  console.warn('[SourceBuffer] error event observed — next failed op will mark fatal');
}
```

**Note:** Keep conservative — do NOT set `fatalError=true` unconditionally (risks false positives). The value is the log + not masking. Reassess if runtime shows the error event reliably precedes irrecoverable state.

**Commit:**
```bash
git commit -am "fix(mse): surface SourceBuffer error event instead of silent no-op (#8)"
```

### Task 2.4: Fix #7 — cut video & audio at the same boundary (A/V desync)

**Objective:** Stop video and audio truncating at different absolute times per refill.

**Files:**
- Modify: `app/src/lib/faststream/players/MediabunnyTransmuxer.ts:1461,1508`

**Fix:** Cut both tracks at a shared boundary. Pass the video's last-emitted keyframe/packet time as the audio cutoff, or cut both at `maxDuration` measured from the shared `keyframeTimestamp` AND round the audio cut down to the nearest video packet boundary. Simplest robust approach: after video iteration decides its final emitted timestamp `videoEndTs`, cut audio at `min(maxDuration, videoEndTs)`.

**Verification:** Play 2+ minutes; confirm no growing A/V lip-sync drift.

**Commit:**
```bash
git commit -am "fix(transmux): align A/V truncation boundary across refills (#7)"
```

---

## Phase 3 — Rust server correctness (highest long-term risk)

### Task 3.1: Fix #2 — folder-agnostic cache key serves the WRONG file

**Objective:** Never serve channel A's bytes for channel B's `message_id`.

**Files:**
- Modify: `app/src-tauri/src/server.rs:397-402` (`media_cache` lookup), `:398-401`
- Modify: `app/src-tauri/src/stream_cache.rs:313` (`data_path`/`meta_path` keys)

**Root cause:** Telegram `message_id` is unique only within a peer. `media_cache` is keyed by `message_id: i32` and the HIT at `:399` returns before `folder_id` is even resolved; on-disk `{message_id}.dat` collides too.

**Fix:** Key everything by `(folder_id, message_id)`.
1. Change `media_cache` key type to `(i64, i32)` (folder, msg). Resolve `folder_id` **before** the cache lookup (move the `folder_id` parse above the `media_cache` block).
2. Change `data_path`/`meta_path` to `{folder_id}_{message_id}.dat` / `.meta.json`.
3. Update all call sites of `data_path`/`meta_path`/`media_cache` (search: `data_path(`, `meta_path(`, `media_cache`).

**Migration note:** Existing `{message_id}.dat` files become orphaned — the startup-cleanup already wipes stream-cache on launch, so no migration needed, but confirm `clear_all_robust` still matches the new names.

**Test:** Unit test `data_path` includes folder; integration — request same msg id under two folder ids resolves distinct cache files.

**Commit:**
```bash
git commit -am "fix(server): key stream cache by (folder_id, message_id) — stop cross-channel wrong-file (#2)"
```

### Task 3.2: Fix #6 — coverage check must compare `end_byte`, not just `start_byte`

**Objective:** Stop subscribing to a download that cannot cover the request's end.

**Files:**
- Modify: `app/src-tauri/src/stream_cache.rs:554-568` (`find_covering_download`), `:582-613` (`find_best_covering_download`)

**Root cause:** Both check only `dl.start_byte <= start_byte && dl.end_byte >= start_byte`; `_end_byte` is unused. A request `8388608-16777215` subscribes to a download ending at `14680063`, then the subscriber loop hits the "ended before covering full range" branch and the client must re-request the tail — the log churn you saw.

**Fix:** Require the download to cover our end too, OR explicitly accept partial coverage and fix the response semantics. Preferred: prefer a fully-covering download; fall back to partial only when none exists.

```rust
// in both functions, tighten the predicate:
if dl.start_byte <= start_byte && dl.end_byte >= _end_byte {
    // full coverage — best candidate
}
```
Rename `_end_byte` → `end_byte` (now used). If no full-cover download exists, return `None` so the caller starts a fresh download for the whole range rather than subscribing to a short one.

**Also (Fix #6-log):** The WARN at `server.rs:783-788` says "ended before covering full range" for the *normal* 8 MiB chunk handoff. Downgrade to `debug!` or reword to "chunk boundary reached, continuing" so it stops looking like an error.

**Also (Fix #6b — underflow):** `server.rs:784` computes `read_offset - 1` inside `if bytes_remaining > 0`; guard `read_offset == 0` to avoid u64 underflow panic/`u64::MAX` in log.

**Commit:**
```bash
git commit -am "fix(server): require end-byte coverage before subscribing; de-noise handoff log (#6)"
```

### Task 3.3: Fix #6c — sparse `.dat` read as real data ("Data file not ready" forever)

**Objective:** Stop treating zero-filled sparse-file gaps as valid bytes.

**Files:**
- Modify: `app/src-tauri/src/server.rs:4055-4108` (keyframe index), `detect_ts_packet_size` `:23-39`, `extract_stream_info` reads

**Root cause:** `.dat` is written with `seek(offset)+write` → sparse file with zero gaps. The keyframe/stream-info paths read bytes `0..N` unconditionally without checking `meta.cached_ranges`, so byte 0 being an un-downloaded `0x00` makes detection fail permanently even when MB are cached elsewhere.

**Fix:** Before reading byte range `[a,b]` for detection, verify `meta.cached_ranges` actually covers `[a,b]`; if not, return the "not ready" partial (correct) instead of reading sparse zeros and misclassifying.

**Commit:**
```bash
git commit -am "fix(server): gate detection reads on cached_ranges, not sparse zeros (#6c)"
```

### Task 3.4: Fix #9 — `parse_range_header` zero-guard

**Objective:** No u64 underflow panic on size-0 media.

**Files:**
- Modify: `app/src-tauri/src/server.rs:365-368`

**Fix:**
```rust
if total_size == 0 {
    return None; // or 416 upstream — no satisfiable range for empty media
}
let end = end.unwrap_or(total_size - 1).min(total_size - 1);
```

**Commit:**
```bash
git commit -am "fix(server): guard parse_range_header against zero-size media (#9)"
```

### Task 3.5: Fix #10 — faststart `stco` 32-bit overflow

**Objective:** Promote to `co64` (or detect overflow) when shifted offsets cross 4 GiB.

**Files:**
- Modify: `app/src-tauri/src/faststart.rs:212-218` (`patch_stco_table`)

**Fix:** If any `old_offset.checked_add(adjustment)` exceeds `u32::MAX`, the box must be rewritten as `co64`. Minimum viable: detect the overflow and bail out of faststart (serve un-faststarted) rather than silently wrapping.

```rust
let new_offset = match old_offset.checked_add(adjustment_u32) {
    Some(v) => v,
    None => return Err(FaststartError::StcoOverflowNeedsCo64),
};
```

**Commit:**
```bash
git commit -am "fix(faststart): detect stco 32-bit overflow instead of wrapping (#10)"
```

---

## Files likely to change

| File | Fixes |
|------|-------|
| `app/src/lib/faststream/players/MediabunnyTransmuxer.ts` | #1 (kf-at-after), #7 (A/V cut) |
| `app/src/hooks/useMSEPlayer.ts` | #1 (refill routing) |
| `app/src/lib/faststream/players/SourceBufferWrapper.ts` | #4, #5, #8 |
| `app/src-tauri/src/server.rs` | #2, #6, #6b, #6c, #9 |
| `app/src-tauri/src/stream_cache.rs` | #2, #6 |
| `app/src-tauri/src/faststart.rs` | #10 |

## Validation

- **Frontend unit:** `cd app && npx vitest run src/lib/faststream/players/__tests__/`
- **Type check:** `cd app && npx tsc --noEmit` (must stay exit 0)
- **Rust:** `cd app/src-tauri && cargo test` and `cargo build --no-default-features`
- **Manual E2E (the real oracle):** `npm run tauri dev`, play the 1.76GB MKV past 90s — no `PIPELINE_ERROR_DECODE`, no runaway "Buffer ahead exceeds hard cap" spam, no A/V drift.

## Risks / tradeoffs / open questions

1. **Strategy A gap risk (Task 1.0/1.3):** if refills stop mid-GOP, abutting to next keyframe leaves a gap. Mitigation: stop prior refill on a GOP boundary. **Must resolve in the spike before committing 1.2.**
2. **Fix #2 cache re-key** touches many call sites; a missed one = compile error (safe) or a stale lookup (must grep exhaustively).
3. **Fix #4** could regress the user-seek path if that path secretly depended on the queue-clear. Confirmed it uses `resetForSeek` (still clears) — but add the targeted test to lock it.
4. **Fix #8** intentionally conservative (no hard-fatal) to avoid false-positive native fallbacks.
5. **Not covered here:** `FastStreamPlayer.tsx` full pass; bug #11 (ArrayBuffer ownership in append queue) — needs tracing transmuxer output allocation to confirm before touching.

## Suggested execution order

Phase 0 → Phase 1 (1.0 spike gates 1.2) → Phase 2 → Phase 3. Phases 1–2 land the crash fix + buffer robustness (one subsystem, fast feedback). Phase 3 is independent and can be a separate PR.
