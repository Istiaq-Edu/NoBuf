# SECOND ASSESSMENT REPORT: PROACTIVE PREBUFFER "2 SPAWN POINTS"

Date: 2026-06-22
Scope: green-bar disk-cache indicator showing two segments per seek / initial start.

Files inspected:
- `app/src/components/dashboard/FastStreamPlayer.tsx` (green bar render + poll loop)
- `app/src/hooks/useMSEPlayer.ts` (`byteToTime`, `byteToTimeTableRef`)
- `app/src-tauri/src/stream_cache.rs` (`CacheMeta`, `cmd_get_cache_status`, `merge_ranges`)
- `app/src-tauri/src/server.rs` (`/stream` range writes)
- `app/src-tauri/src/commands/streaming.rs` (`cmd_report_playback_position`, `proactive_prebuffer_download`, 40s offset)

---

## 1. ROOT CAUSE

The "2 spawn points" are **not** two PROACTIVE downloads. The backend is correct: there is exactly one `/stream` download and one PROACTIVE download. The two green segments are produced **on the frontend**, and there are two distinct (compounding) reasons:

### Cause A (primary): the 40s offset creates a real, visible gap

`proactive_prebuffer_download` starts PROACTIVE at:

```
proactive_start_byte = start_byte + (40s / duration * total_size)
```

`/stream` downloads sequentially forward from `start_byte` (the playhead). PROACTIVE downloads from `start_byte + ~40s`. Until `/stream` sequentially fills the 40-second window between them, the disk cache contains **two disjoint ranges**:

```
[playhead .. /stream_progress]   ........gap........   [playhead+40s .. proactive_progress]
```

Both ranges are written to the same `CacheMeta.cached_ranges`. `cmd_get_cache_status` returns both. The green-bar renderer in `FastStreamPlayer.tsx` (lines ~1323-1347) merges ranges only when they are within `0.01s` of each other:

```ts
if (merged.length === 0 || r[0] > merged[merged.length - 1][1] + 0.01) {
  merged.push([r[0], r[1]]);            // 40s gap → NEW segment
} else { ... }
```

A ~40s gap is far larger than `0.01s`, so the two ranges render as **two green segments**. This is exactly "2 spawn points, even on initial start": on launch `/stream` bootstraps from byte 0, PROACTIVE starts ~25MB ahead, and the green bar shows `0-X` and `~40s-Y` as two bars until `/stream` catches up.

This is a direct, expected consequence of the 40s-ahead offset that was added in the previous round of fixes (item 6).

### Cause B (secondary, position error): VBR linear fallback misplaces `/stream`'s segment

`byteToTime` (useMSEPlayer.ts:873) falls back to **linear** mapping whenever `byteToTimeTableRef.current` is empty:

```ts
if (table.length === 0 || state.current.fileLength <= 0) {
  return (bytePos / state.current.fileLength) * state.current.duration; // LINEAR
}
```

- For **MP4**, the table is built once (200 mp4box calibration points, line ~4205-4218), so MP4 is usually fine after init.
- For **TS**, the table is populated **lazily** from VBR-corrected keyframes (3 sites: ~3107, ~3138, ~3320). On the **first** seek into a fresh region the table has no nearby entry, so the linear fallback runs. As the prompt's arithmetic shows, this can map `/stream`'s byte to a time ~30s *behind* the true playhead. The result is a green segment that appears *behind* the seeked point — a second, misplaced "spawn point."

So the user can see two segments because of the gap (Cause A) and/or because one segment is rendered at the wrong time (Cause B).

### On the questions

- **Q1 (intended?)**: No. Showing the raw two-range disk state is technically accurate but is what the user is complaining about. One prebuffer indicator is the desired UX.
- **Q2 (distinguish /stream vs PROACTIVE ranges)**: Not currently possible. `CacheMeta.cached_ranges` is a flat `Vec<(u64,u64)>` with no source tag; both writers merge into it via `merge_ranges`. Tagging (option c) or a separate cache file (option b) are real refactors and are not needed to fix the visual.
- **Q5 (suppress during active /stream)**: Not the root cause. Suppression is already gated by `__nobuf_userSeekInProgress`; after the seek completes both ranges are legitimately present. Hiding `/stream`'s active range would make the bar lie about cached data.

---

## 2. FIX OPTIONS

**Option 1 — Visually bridge sub-window gaps (frontend only).**
In the green-bar merge, bridge gaps up to slightly more than the 40s offset (e.g. 45s). The transient `/stream`→PROACTIVE gap collapses into one bar; genuinely large uncached regions (minutes) still render separately. ~2 lines. No backend change. Does not alter actual download behavior.

**Option 2 — Remove the 40s offset (backend).**
Set `proactive_start_byte = start_byte` so PROACTIVE is contiguous with `/stream` → one merged range → one bar. Simple, but reintroduces the overlap/rate-limiter competition that the 40s offset was specifically added to prevent (prompt item 6). Regression risk. Not recommended.

**Option 3 — Tag ranges by source / separate cache file (backend, major).**
Add a `source` field to ranges or a second cache file, then render only PROACTIVE's ranges. Solves Q2 cleanly but is a real refactor touching `CacheMeta`, both writers, and `cmd_get_cache_status`. Overkill for a visual issue.

Independently, to address Cause B: **seed `byteToTimeTableRef` with baseline points `(0, 0)` and `(fileLength, duration)`** so `byteToTime` is monotonic and roughly correct even before keyframes/calibration arrive, eliminating the "behind the playhead" misplacement on first seek (Q4 option b).

---

## 3. RECOMMENDED FIX

**Option 1 + the baseline-table seed.** This is the simplest change that gives the user one prebuffer indicator without a refactor and without changing download behavior:

1. Bridge gaps smaller than the proactive offset window in the green-bar merge (collapses the transient 40s gap into one bar, keeps honest reporting for large gaps).
2. Seed `byteToTimeTableRef` with `(0,0)` and `(fileLength,duration)` so the linear-fallback misplacement (Cause B) never renders a segment behind the playhead on the first seek.

No `CacheMeta` changes, no backend download-logic changes, no regression to the 40s offset that fixed the earlier overlap bug.

---

## 4. CODE CHANGES

### 4.1 Bridge sub-window gaps in the green bar

`app/src/components/dashboard/FastStreamPlayer.tsx`, green-bar render (~line 1323-1347).

Replace the fixed `+ 0.01` tolerance with a bridge threshold tied to the proactive offset window (~45s), using the bar's duration as a clamp so short videos don't over-merge:

```ts
{cachedTimeRanges.length > 0 && dur > 0 && (() => {
  // Bridge the transient /stream→PROACTIVE gap (40s offset) into a single
  // visual segment. Genuine large uncached regions still render separately.
  const BRIDGE_S = Math.min(45, dur * 0.1);
  const sorted = [...cachedTimeRanges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of sorted) {
    if (merged.length === 0 || r[0] > merged[merged.length - 1][1] + BRIDGE_S) {
      merged.push([r[0], r[1]]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
    }
  }
  return merged.map(([ts, te], i) => {
    const leftPct = (ts / dur) * 100;
    const widthPct = ((te - ts) / dur) * 100;
    return (
      <div
        key={`cache-${i}`}
        className="absolute bottom-0 h-[3px] bg-green-400/70 rounded-full z-20"
        style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.2)}%` }}
      />
    );
  });
})()}
```

(Only the merge tolerance changes; the rest is the existing block.)

### 4.2 Seed the VBR table with baseline calibration points

`app/src/hooks/useMSEPlayer.ts`. For TS the table starts empty until keyframes arrive. Seed it once when `fileLength` and `duration` are known (near where bitrate is computed / `fileLength` is set), so `byteToTime` interpolates between real endpoints instead of linear-from-zero:

```ts
if (state.current.fileLength > 0 && state.current.duration > 0
    && byteToTimeTableRef.current.length === 0) {
  byteToTimeTableRef.current = [
    [0, 0],
    [state.current.fileLength, state.current.duration],
  ];
}
```

The existing lazy keyframe inserts (~3107, ~3138, ~3320) and the MP4 200-point build (~4218) then refine this table; the two baseline anchors only guarantee a sane monotonic mapping before any refinement, preventing the "segment behind the playhead" artifact on the first seek.

### 4.3 (Optional, not required) backend

No backend change is needed. Keep the 40s `proactive_start_byte` offset as-is; it is doing its job and the gap it creates is now bridged visually.

---

## SUMMARY

The user is seeing two green segments because (A) the 40s PROACTIVE offset leaves a real, transient gap between `/stream`'s sequential fill and PROACTIVE's region, which the green-bar merge (0.01s tolerance) renders as two bars, and (B) on first TS seeks the empty VBR table makes `byteToTime` fall back to linear, placing `/stream`'s segment behind the playhead. The minimal fix is frontend-only: bridge sub-40s gaps in the green-bar merge and seed `byteToTimeTableRef` with `(0,0)`/`(fileLength,duration)` baseline anchors. No `CacheMeta` refactor and no change to the download logic.
