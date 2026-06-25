# Assessment: Green Bar "Random Fill" — byteToTime VBR Mapping Failure

## Summary

The green prebuffer bar does not line up with the data actually cached on disk because
its byte→time conversion is effectively **linear**, not VBR-accurate. There are two
independent defects, both verified in code:

- **Defect A (dominant):** the shadow-cache range branch bypasses `byteToTime()` and uses
  raw linear math.
- **Defect B:** `byteToTimeTableRef` rarely receives real keyframes, so even the branch
  that *does* call `byteToTime()` falls back to the linear 2-point baseline.
- **Defect C (amplifier):** the estimated duration (2627.9s vs real 2073s) feeds the linear
  math until real duration arrives, maximizing the visible error.

---

## 1. Root Cause

### Defect A — Shadow-cache branch never uses `byteToTime()`

The green bar in `FastStreamPlayer.tsx` merges ranges from two sources:

- **Disk cache** (`status.cached_ranges`) — converted with `byteToTime()` (VBR-aware).
- **Shadow cache** (`sc.entryRanges`, the JS in-memory byte cache that is the *primary*
  range source during MPEGTS playback) — converted with **raw linear math**:

```ts
// app/src/components/dashboard/FastStreamPlayer.tsx ~line 405
const byteDurRatio = durForBar / sc.fileLength;
for (const entry of sc.entryRanges) {
  ranges.push([
    entry.start * byteDurRatio,   // PURE LINEAR — ignores byteToTimeTableRef
    entry.end   * byteDurRatio,
  ]);
}
```

Both branches are then merged into one list. For VBR video the shadow-cache (linear)
segments disagree with the disk-cache (VBR) segments and with reality, so the bar paints
segments in positions that don't match the cached data → "random fill."

### Defect B — `byteToTimeTableRef` is usually stuck at the linear 2-point baseline

```ts
// app/src/hooks/useMSEPlayer.ts:880
const byteToTime = useCallback((bytePos: number): number => {
  const table = byteToTimeTableRef.current;
  if (table.length === 0 || state.current.fileLength <= 0) {
    return (bytePos / state.current.fileLength) * state.current.duration; // linear
  }
  // binary search + linear interpolation between two nearest points
  ...
}, []);
```

The baseline seed `[[0,0],[fileLen,dur]]` is **mathematically identical to linear**. The
table only becomes VBR-accurate from two places:

1. `refreshTsKeyframeIndex()` — but it only updates the table when `keyframes.length > 0`
   (`useMSEPlayer.ts:842`). At cold start the backend returns an empty partial index, and
   the retry interval is **10s** (`useMSEPlayer.ts:5422`).
2. VBR-correction during seeks — adds only the 1-2 points the user actually seeked to.

So in the common case (fresh stream, no seeks) the table stays at the 2-point baseline =
linear for the whole session.

### Defect C — Wrong duration in the linear / baseline math

`durForBar = durRef.current || __nobuf_estimateDuration` (`FastStreamPlayer.tsx:391`). The
estimate (2627.9s vs real 2073s) is used by the shadow-cache linear branch until the real
duration lands, and the baseline seed also uses whatever `state.current.duration` was at
seed time. With the estimate a byte maps ~350s away from truth (the most visually random
case).

**Bottom line:** the green bar is linear-mapped (often with the wrong duration), not
VBR-mapped, because (A) the shadow-cache branch bypasses `byteToTime()` entirely and
(B) `byteToTimeTableRef` rarely receives real keyframes given the empty cold-start backend
response plus the 10s retry.

---

## 2. Evidence (verified in code)

| Claim | Location |
| --- | --- |
| `byteToTime` falls back to exact linear on empty/2-point table | `app/src/hooks/useMSEPlayer.ts:880-895` |
| Empty-keyframe gate (table not updated when backend returns `[]`) | `app/src/hooks/useMSEPlayer.ts:842` |
| 10s retry interval | `app/src/hooks/useMSEPlayer.ts:5421-5422` |
| Backend returns empty partial index at cold start | `app/src-tauri/src/server.rs:3831` ("Data file not ready ... returning empty partial index") |
| Backend can build accurate partial index from cached ranges (`scan_keyframes_chunked`) returning `byte_offset`→`timestamp_s` | `app/src-tauri/src/server.rs:3949-4010` |
| Response carries `partial: bool` | `app/src-tauri/src/server.rs:1341-1345` |
| Disk-cache branch uses `byteToTime()` | `app/src/components/dashboard/FastStreamPlayer.tsx:398` |
| Shadow-cache branch uses raw `entry.start * byteDurRatio` (linear) | `app/src/components/dashboard/FastStreamPlayer.tsx:405-413` |
| Shadow cache exposes `entryRanges` / `fileLength` | `app/src/lib/faststream/StreamShadowCache.ts:89,97` |

Arithmetic confirming magnitude (from the assessment prompt):
byte 917563328 → linear@2073s = 1447.8s vs actual 1485.4s (**37.6s off**);
linear@2627.9s = 1835.2s (**349.8s off**); both wrong, the estimate dramatically so.

---

## 3. Fix

Two surgical changes, no new mechanisms:

1. **Route the shadow-cache branch through `byteToTime()`** so both range sources share the
   same VBR mapping (kills Defect A, the dominant one).
2. **Populate the keyframe index fast and keep refreshing while partial**: retry at 2s
   (not 10s) until the backend returns a non-empty, non-partial index, then back off. The
   backend already builds incremental partial scans, so this is only a polling-cadence
   change (fixes Defect B).

Defect C resolves naturally: once the table holds real keyframe points, `byteToTime`
interpolates between them and no longer depends on the (possibly estimated) duration for
interior positions.

Rejected alternatives:
- "Ask backend to convert bytes→times on every poll" — heavier, redundant; the existing
  `byteToTimeTableRef` + interpolation is correct once it is fed *and* used.
- "Use `tsKeyframeIndexRef` directly in the bar" — same data as `byteToTimeTableRef`; no
  benefit over fixing the two call sites.

---

## 4. Code Changes

### `app/src/components/dashboard/FastStreamPlayer.tsx` (~line 405)

Use `byteToTime` for shadow-cache ranges (and drop the now-unused `byteDurRatio`):

```ts
if (sc && sc.fileLength > 0) {
  for (const entry of sc.entryRanges) {
    ranges.push([
      byteToTime(entry.start),
      byteToTime(entry.end + 1),
    ]);
  }
}
```

### `app/src/hooks/useMSEPlayer.ts`

`fetchMpegtsKeyframeIndex` should surface `partial`, and `refreshTsKeyframeIndex` should
return whether the index is complete:

```ts
// fetchMpegtsKeyframeIndex: return { keyframes, partial }
const refreshTsKeyframeIndex = useCallback(async (): Promise<boolean> => {
  if (!streamUrl) return false;
  const parsed = parseStreamUrl(streamUrl);
  if (!parsed) return false;
  const { keyframes, partial } = await fetchMpegtsKeyframeIndex(
    parsed.baseUrl, parsed.folderId, parsed.messageId, parsed.token);
  if (keyframes.length > 0) {
    tsKeyframeIndexRef.current = keyframes;
    byteTimeSamplesRef.current = keyframes.map(kf => ({ time: kf.timestamp, byte: kf.byteOffset }));
    byteToTimeTableRef.current = keyframes
      .map(kf => [kf.byteOffset, kf.timestamp] as [number, number])
      .sort((a, b) => a[0] - b[0]);
  }
  return !partial && keyframes.length > 0;
}, [parseStreamUrl, streamUrl]);
```

Fast-retry effect (replaces the fixed 10s `setInterval` at ~line 5417):

```ts
useEffect(() => {
  if (!streamUrl) return;
  tsKeyframeIndexRef.current = [];
  byteTimeSamplesRef.current = [];
  let timer: number;
  let cancelled = false;
  const tick = async () => {
    const complete = await refreshTsKeyframeIndex();
    if (cancelled) return;
    timer = window.setTimeout(tick, complete ? 15000 : 2000);
  };
  tick();
  return () => { cancelled = true; clearTimeout(timer); };
}, [streamUrl, refreshTsKeyframeIndex]);
```

---

## 5. Verification Plan

- **Logs:** confirm `/fmp4/keyframes` transitions from `X-Partial: true`/empty to a
  populated body within a few seconds of playback (backend `[FMP4-KF]` lines), and that the
  frontend stops fast-polling (2s → 15s) once `complete`.
- **Behavioral:** open a VBR TS video and let it prebuffer without seeking. The green bar
  should sit exactly under the cached region (right edge tracks the prebuffer head), not
  jump to a random offset. Seek to ~1485s; the green segment edge should align within
  ~1-2s, not ~37s / ~350s off.
- **Cross-check:** temporarily log `byteToTime(s)` vs `s / fileLen * dur` for a cached range
  start. Once keyframes load they should diverge (VBR mapping active) and the `byteToTime`
  value should match the actual scene time.
- **Regression:** MP4/fMP4 (non-TS) path still renders correctly since it already populates
  the table from moov keyframes and now shares the same shadow-cache code path.
