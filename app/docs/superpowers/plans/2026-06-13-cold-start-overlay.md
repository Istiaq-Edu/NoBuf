# Cold-start "No Buffer optimization" overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cold-start pre-buffering overlay for TS video previews that appears only when the shadow cache is empty, shows real progress while the backend fills memory, and fades into smooth playback once a minimum buffer threshold is reached.

**Architecture:** The overlay is driven by a new `useMSEPlayer` state (`isColdStartBuffering`, `coldStartProgress`). `useMSEPlayer` detects a cold start before attaching the mpegts.js player and polls the shadow cache until the byte/time threshold or a hard timeout is met. `FastStreamPlayer` renders the overlay and hides the video element until the player signals it is ready.

**Tech Stack:** React + TypeScript, Tailwind CSS, mpegts.js, existing `StreamShadowCache` / proactive prebuffer.

---

### File structure

| File | Responsibility |
|---|---|
| `src/hooks/useMSEPlayer.ts` | Detect cold start, expose `isColdStartBuffering` + `coldStartProgress`, gate the mpegts.js player attachment until threshold or timeout. |
| `src/components/dashboard/FastStreamPlayer.tsx` | Render overlay while `isColdStartBuffering` is true; hide video element until buffer is ready; wire close/cancel. |
| `src/lib/faststream/StreamShadowCache.ts` | Provide `cachedRunFrom(start: number)` helper to report contiguous cached bytes for progress calculations. |
| CSS via Tailwind in `FastStreamPlayer.tsx` | Overlay layout, animation, progress bar. |

---

### Task 1: Add shadow-cache progress helper

**Files:**
- Modify: `src/lib/faststream/StreamShadowCache.ts`
- Test: `npm run test` (existing tests should still pass)

- [ ] **Step 1: Add `cachedRunFrom` method**

Add to `StreamShadowCache` class:

```typescript
  /**
   * Return the contiguous cached byte range that starts at or before `from`.
   * Used by the cold-start overlay to report real progress.
   */
  cachedRunFrom(from: number): { start: number; end: number } | null {
    for (const entry of this.entries) {
      if (entry.start <= from && entry.end >= from) {
        return { start: entry.start, end: entry.end };
      }
      if (entry.start > from) break;
    }
    return null;
  }
```

- [ ] **Step 2: Run tests**

Run: `npm run test`  
Expected: existing tests pass (no new tests needed for this pure helper).

- [ ] **Step 3: Commit**

```bash
git add src/lib/faststream/StreamShadowCache.ts
git commit -m "feat: add cachedRunFrom helper for cold-start progress"
```

---

### Task 2: Add cold-start state and gate to `useMSEPlayer.ts`

**Files:**
- Modify: `src/hooks/useMSEPlayer.ts`
- Test: build + manual cold-start playback

- [ ] **Step 1: Add constants and state near the top of the hook**

After the existing refs/state block, add:

```typescript
const MIN_COLD_START_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB
const MIN_COLD_START_BUFFER_SECONDS = 10;            // fallback: 10 s of playback
const COLD_START_TIMEOUT_MS = 10000;                  // never wait longer than 10 s
```

And React state:

```typescript
  const [isColdStartBuffering, setIsColdStartBuffering] = useState(false);
  const [coldStartProgress, setColdStartProgress] = useState<{ bytes: number; targetBytes: number }>({
    bytes: 0,
    targetBytes: MIN_COLD_START_BUFFER_BYTES,
  });
```

- [ ] **Step 2: Expose the new values in the return object**

At the end of the hook, include:

```typescript
    isColdStartBuffering,
    coldStartProgress,
```

- [ ] **Step 3: Implement cold-start detection and wait helper**

Add a helper inside `useMSEPlayer`:

```typescript
  const waitForColdStartBuffer = useCallback(async (format: DetectedFormat): Promise<boolean> => {
    if (format !== 'ts') return false;
    const cache = shadowCacheRef.current;
    const fileLength = state.current.fileLength;
    if (!cache || fileLength <= 0) return false;

    // Check if cache already has enough contiguous data from byte 0
    const run = cache.cachedRunFrom(0);
    if (run && run.end >= MIN_COLD_START_BUFFER_BYTES - 1) {
      return false; // warm enough — skip overlay
    }

    setIsColdStartBuffering(true);
    const startTime = Date.now();
    let resolved = false;

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const now = Date.now();
        const elapsed = now - startTime;
        const currentRun = cache.cachedRunFrom(0);
        const bytes = currentRun ? currentRun.end + 1 : 0;
        const bufferedTime = bytes > 0 && fileLength > 0
          ? (bytes / fileLength) * (mpegtsDurationRef.current || state.current.duration || 1)
          : 0;

        setColdStartProgress({ bytes, targetBytes: MIN_COLD_START_BUFFER_BYTES });

        const byteReady = bytes >= MIN_COLD_START_BUFFER_BYTES;
        const timeReady = bufferedTime >= MIN_COLD_START_BUFFER_SECONDS;
        const timedOut = elapsed >= COLD_START_TIMEOUT_MS;

        if (byteReady || timeReady || timedOut) {
          clearInterval(timer);
          if (!resolved) {
            resolved = true;
            setIsColdStartBuffering(false);
            resolve(true);
          }
        }
      }, 250);
    });
  }, []);
```

- [ ] **Step 4: Gate the mpegts.js player attachment**

In the TS initialization path inside `initTransmuxerPlayer`, before calling `player.attachMediaElement(videoEl)` and `player.load()`, call:

```typescript
const didColdStartWait = await waitForColdStartBuffer(format);
if (didColdStartWait) {
  diagLog('[MPEGTS] Cold-start buffer threshold met (or timeout) — attaching player');
}
```

This ensures the mpegts.js player is not attached until the overlay window has either filled enough buffer or timed out.

- [ ] **Step 5: Build check**

Run: `npm run build`  
Expected: passes with no new TS errors.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useMSEPlayer.ts
git commit -m "feat: add cold-start buffer gate and progress state"
```

---

### Task 3: Render overlay in `FastStreamPlayer.tsx`

**Files:**
- Modify: `src/components/dashboard/FastStreamPlayer.tsx`
- Test: build + manual cold-start playback

- [ ] **Step 1: Destructure new fields from `msePlayer`**

In the `player` object, add:

```typescript
    isColdStartBuffering: msePlayer.isColdStartBuffering,
    coldStartProgress: msePlayer.coldStartProgress,
```

And destructure near the top:

```typescript
  const {
    // ... existing fields
    isColdStartBuffering,
    coldStartProgress,
  } = player;
```

- [ ] **Step 2: Prevent video src assignment during cold start**

In the `useEffect` that assigns `v.src`, wrap the `v.src` and `v.autoplay = true` lines so that when `isColdStartBuffering` is true, the video element remains without a src and autoplay is false. The mpegts.js player will attach only after the gate passes.

Add at the top of the effect:

```typescript
    if (isColdStartBuffering) {
      // Cold-start overlay is active; keep video element clean until buffer is ready
      return;
    }
```

- [ ] **Step 3: Add the overlay component inside the player container**

Before the `<video>` element, conditionally render the overlay. Replace the existing spinner block with a more purposeful overlay when cold start is active.

Add a new component near the top of `FastStreamPlayer` (before the main component or inside it):

```typescript
function ColdStartOverlay({
  progress,
  onCancel,
}: {
  progress: { bytes: number; targetBytes: number };
  onCancel: () => void;
}) {
  const pct = Math.min(100, (progress.bytes / progress.targetBytes) * 100);
  const mb = (progress.bytes / (1024 * 1024)).toFixed(1);
  const targetMb = (progress.targetBytes / (1024 * 1024)).toFixed(0);

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/90 text-white transition-opacity duration-300">
      <div className="w-16 h-16 mb-6 relative">
        <div className="absolute inset-0 rounded-full border-4 border-white/10" />
        <div className="absolute inset-0 rounded-full border-4 border-t-nobuf-primary border-r-transparent border-b-transparent border-l-transparent animate-spin" />
      </div>
      <h2 className="text-xl font-semibold mb-2">Optimizing video for No Buffer playback</h2>
      <p className="text-sm text-white/70 mb-6">Pre-buffering {targetMb} MB for instant playback</p>
      <div className="w-64 h-1.5 bg-white/10 rounded-full overflow-hidden mb-2">
        <div
          className="h-full bg-nobuf-primary rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-white/50">{mb} / {targetMb} MB</p>
      <button
        onClick={onCancel}
        className="mt-8 px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}
```

Then render it inside the main container:

```tsx
{isColdStartBuffering && (
  <ColdStartOverlay
    progress={coldStartProgress}
    onCancel={handleClose}
  />
)}
```

- [ ] **Step 4: Hide the generic spinner during cold start**

Change the existing spinner block so it does not appear when `isColdStartBuffering` is true:

```tsx
{load && !err && !isColdStartBuffering && (
  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
    <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
  </div>
)}
```

- [ ] **Step 5: Build and visual check**

Run: `npm run build`  
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/FastStreamPlayer.tsx
git commit -m "feat: render cold-start No Buffer optimization overlay"
```

---

### Task 4: Integration and runtime verification

**Files:**
- All modified files above
- Test: manual runtime smoke test

- [ ] **Step 1: Full build**

Run:

```bash
npm run build
cargo check
```

Expected: both pass.

- [ ] **Step 2: Manual cold-start test**

1. Clear the stream cache (or open a video never played before).
2. Click a TS video.
3. Expected: overlay appears immediately with animated spinner and progress bar.
4. After 1–10 seconds, overlay fades and video starts playing smoothly.
5. Expected: no single-frame flash, no generic spinner, no immediate stall.

- [ ] **Step 3: Warm-cache test**

1. Close the preview and reopen the same video (or use a video with existing disk cache).
2. Expected: overlay does **not** appear; playback starts immediately.

- [ ] **Step 4: Cancel test**

1. Click a TS video, wait for overlay, then click Cancel.
2. Expected: preview closes and proactive prebuffer is cancelled.

- [ ] **Step 5: Commit final verification log**

If tests pass:

```bash
git log --oneline -5
```

Capture output and add to the task summary.

---

## Plan self-review

- **Spec coverage:** Trigger condition, buffer thresholds, UI, data flow, edge cases, and files to modify are all mapped to tasks above.
- **Placeholder scan:** No TBD/TODO/incomplete sections; code snippets are concrete and use existing file names and variable names from the codebase.
- **Type consistency:** `isColdStartBuffering` is `boolean`, `coldStartProgress` is `{ bytes: number; targetBytes: number }` throughout.
- **Scope:** Focused on the overlay and gate; does not touch backend download algorithms or unrelated UI.
