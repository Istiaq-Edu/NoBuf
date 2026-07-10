# Player UX batch — plan

Scope: `app/src/components/dashboard/FastStreamPlayer.tsx` (+ maybe a new `PipPlayer.tsx`).
Type gate: `npx tsc --noEmit` from `app/`. Runtime verified by user in `tauri dev` (agent can't drive WebView2).
Baseline: run `tsc --noEmit` BEFORE any change → must be exit 0. Re-run AFTER each task.

---

## 1. Lower the ⋯ popover a bit
- **Where:** line ~1722, tray popover `className` has `bottom-full ... mb-2`.
- **Change:** reduce the upward offset so the box sits lower — `mb-2` → `mb-1`, or add a small positive `translate-y`. Keep it above the bar (not overlapping chips).
- **Edge cases:** must not clip behind the control bar gradient; must still open on both left/right tray placement (`traySide`); drag-reopen unaffected.
- **Verify:** tsc green; user confirms popover sits lower and still fully visible.

## 2. Thin-line mini bar when controls hidden
- **Where:** miniBar block line ~1838. Currently renders a speed/pause pill (`greenBarSpeed` span + prefetch pause button) ABOVE a 2px red progress line.
- **Interpretation (confirm):** reduce to just a thin progress line — drop the pill + pause button so only the `h-[2px]` (or `h-[1.5px]`) line shows.
- **Edge cases:** must still reflect `pct`; must not steal pointer events (already `pointer-events-none`); must appear only when `miniBarVisible && !err && dur > 0`; fade transition preserved.
- **Verify:** tsc green; user confirms hidden-controls state shows only a thin line.

## 3. Download %: only during active download + blink/color
- **Where:** download chip line ~1608-1612. Currently `{cachePercent > 0 && ...}` shows cache % ALWAYS; icon already has `animate-subtle-pulse` gated on `dlOverlayVisible && !dlOverlay?.completed`.
- **Interpretation (confirm):** the "%" should show only while an active download is in progress (`dlOverlay?.active === true`), not persistent cache %. Icon should switch to an accent color + blink while active, revert to white when idle/complete.
- **Change:** gate the percentage span on `dlOverlay?.active`; add color+blink class to the svg while `dlOverlay?.active`; on complete show ✓ briefly then revert (or per current dlOverlay.completed handling).
- **Edge cases:** rapid start/stop; download error mid-way (no stuck blink); completed state; cache-only (no active download) shows no %; blink must stop when `dlOverlay` clears.
- **Verify:** tsc green; user confirms % + blink only during active download.

## 4. Remove Loop + PiP rows from settings menu
- **Where:** Loop row line ~2158-2160; PiP row line ~2209-2211.
- **Change:** delete both `<SettingRow>` blocks. KEEP the `loop`/`pip` state + effects — the control-bar chips still use them.
- **Edge cases:** don't remove skip-forward/backward rows (same section as Loop); don't orphan `Switch` import if now unused (check); Display section must not render empty/awkward after PiP row removed.
- **Verify:** tsc green (no unused-var errors); user confirms rows gone, chips still work.

## 5. PiP player fixes — DECISION REQUIRED
### 5a. Fix icon-stays-colored after closing PiP (both approaches)
- **Bug:** closing PiP via the window's X doesn't flip `pip` state → chip stays `text-nobuf-primary`.
- **Fix:** add `enterpictureinpicture`/`leavepictureinpicture` listeners on the video el that `setPip(true/false)`. Idempotent with the existing `[pip]` effect (guard to avoid loops).
- **Edge cases:** effect-driven enter vs user-driven exit must not ping-pong; unmount cleanup; PiP unsupported path already toasts + resets.

### 5b + 5c: remove settings icon from PiP + add volume controller
- **These require Document Picture-in-Picture** (render our own controls). Native element-PiP chrome is not ours to edit.
- **Option A — Document PiP (full control):** new `PipPlayer` mounts our video + a minimal control row (play/pause, volume slider, close) into a `documentPictureInPicture` window. Removes the "settings icon" (we simply don't render one) and adds a proper volume control. More code; WebView2 Document-PiP support must be verified first.
- **Option B — stay native + Media Session:** we can wire play/pause/seek via `navigator.mediaSession`, but CANNOT add a volume slider or remove the settings button (browser chrome). 5b/5c only partially achievable.
- **Recommendation:** Option A if WebView2 supports Document PiP; else keep native + do 5a only and drop 5b/5c as not feasible.

---

## Global validation
- `tsc --noEmit` exit 0 before + after every task (zero new errors).
- No debug logs left in.
- Surgical edits only — no restyling unmentioned components (user rule).
- Hand back to user for `tauri dev` confirmation on each visual item.
