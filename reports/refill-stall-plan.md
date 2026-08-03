# Cue-less MKV Refill Stall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **HARD RULE: NO `git add` / `git commit` ANYWHERE.** The user commits manually. Tasks end at gate verification, never at a commit.
> **Line numbers drift as tasks land.** Every task gives a grep anchor — re-run it before editing; do not trust absolute line numbers blindly after Task 2.

**Goal:** Fix the cue-less MKV streaming stall (3,413 consecutive null-keyframe refills at 130Hz) plus its 3 sibling bugs (user-seek strand, track-switch dead player, EOF null-loop), with layered defense: harvest (root) + breaker (belt) + backoff (suspenders) + guards.

**Architecture:** (A) harvest keyframe timestamps from the iteration pump into the transmuxer's partial index + contiguous watermark so refills resolve from memory, dodging mediabunny's broken position-cache walk; (B) pure-function null-refill classifier → `endOfStream` near duration / ffmpeg-remux reroute mid-file; (C) 1000ms null-failure backoff. Design doc: `reports/refill-stall-solution.md` (all research + review under `reports/research/`).

**Tech stack:** TypeScript (React hook + transmuxer class), vitest, mediabunny 1.45.4 (vendored, NOT edited).

**Baseline (verified 2026-08-02):** `npx tsc --noEmit` exit 0 · `npx vitest run` 24 files, **382/382** · cargo 178/178 (no Rust in this plan — cargo checked once at the end for safety).

**Files touched (2 source + 4 test):**
- Modify: `app/src/lib/faststream/players/MediabunnyTransmuxer.ts` (harvest, watermark, dedup)
- Modify: `app/src/hooks/useMSEPlayer.ts` (pure fns, breaker, backoff, guards, resets)
- Create: `app/src/__tests__/RefillBackoff.test.ts`, `NullRefillBreaker.test.ts`, `HarvestedKeyframeIndex.test.ts`, `CuelessMkvFixture.test.ts`

---

## Cross-validation ledger (all claims resolved against source 2026-08-02)

| # | Claim | Verified result | Source | Fixed? |
|---|---|---|---|---|
| 1 | `estimatedKeyframeInterval` + `duration` + `refillPosition` in scope at the null branch | Yes — declared :2798-2806/:2702, before the :2862/:2900 if/else | useMSEPlayer.ts:2780-2900 | n/a |
| 2 | `_recoverMkvToRemuxTier` bumps chain gen synchronously before first await | Yes — stopStreamingChain :4672; first await :4703 | useMSEPlayer.ts:4657-4703 | n/a |
| 3 | finally rechain gated on `!isCompleteRef.current` and stale gen | Yes — :2918, :2941 | useMSEPlayer.ts:2914-2969 | n/a |
| 4 | `isPausedRef` is PREFETCH pause only, never video-element pause | Yes — written only by pausePrefetch/resumePrefetch | useMSEPlayer.ts:9635/:9674 region | n/a |
| 5 | Track-switch mapping fetch exists inline in reroute-remux branch | Yes — :6184-6196, uses `mapAudioTrackToRemuxIdx` (:408) | useMSEPlayer.ts | n/a |
| 6 | User-seek null branch restarts nothing | Yes — :9319-9323; startStreamingChain only in success :9297 | useMSEPlayer.ts | n/a |
| 7 | `hasEverCompletedRef` has ZERO reset sites | Yes — decl :1640; set-true :2822/:8366/:8528 only | useMSEPlayer.ts | Task 4 |
| 8 | Harvest insertion point pre-clone, pre-stop-check | Yes — gen check :1597-1600, stop :1614-1618, clone :1620 | MediabunnyTransmuxer.ts:1584-1633 | n/a |
| 9 | `addKeyframeTimestamp` O(n) `ts.some` dedup | Yes — :786 | MediabunnyTransmuxer.ts:781-800 | Task 6 |
| 10 | Test constructor pattern (minimal config + `as any` injection) | Yes — snapToCueKeyframe.test.ts:25-37 | app/src/__tests__ | n/a |
| 11 | Fixture APIs: `Output/Input/MkvOutputFormat({appendOnly})/BufferTarget/BufferSource/EncodedVideoPacketSource/EncodedPacket(data,type,timestamp,duration)/EncodedPacketSink/MATROSKA` all exported | Yes | mediabunny/src/index.ts:51-269, packet.ts ctor, target.ts:122-124, source.ts:424-436, media-source.ts:188-219, output.ts:597/762/867 | n/a |
| 12 | **Fixture geometry: clusters only break on keyframes OR at 32,767ms overflow** — a 10.4s-GOP fixture would put every keyframe at a cluster start and NOT reproduce the bug | Yes — `MAX_CLUSTER_TIMESTAMP_MS = 2**15−1` :74, shouldCreateNewCluster :1137-1148 | matroska-muxer.ts | Task 10 uses GOP=40s |
| 13 | finalize() writes trailing Cues unconditionally even with appendOnly; SeekHead skipped when appendOnly | Yes — cues write :1329-1330 region; maybeCreateSeekHead early-return | matroska-muxer.ts | Task 10 truncates at `1C 53 BB 6B` |
| 14 | vp8 is a valid mediabunny VideoCodec for EncodedVideoPacketSource | Yes — codec.ts:40 | mediabunny/src/codec.ts | n/a |

Runtime-only unknown (spike, not blocking): whether jsdom/node runs the mediabunny **muxer** cleanly for the fixture (Task 10 is timeboxed with an explicit skip path; the unit suites carry the coverage either way).

---

## Edge-case → task map

| Edge | Handled by | Test |
|---|---|---|
| Refill null loop mid-file (the bug) | T7 harvest (root), T4 breaker (belt), T2 backoff | T6/T7 unit, T3 unit, T10 fixture, e2e §1-3 |
| EOF null loop (cue-less endOfStream unreachable) | T4 `'eof'` verdict (N≥2, one-GOP threshold) | T3 unit (boundary cases), e2e §7 |
| GOP > 12s cue-less file | T6 watermark (bypasses 12s rule inside iterated spans) | T6 unit #4 |
| User seek into GOP shadow → stranded player | T8 G1 immediate reroute | code review + e2e §4 |
| Track switch mid-GOP → dead player + wrong tier-2 track | T9 G2 reroute + TrackNumber→ffprobe-idx mapping | code review + e2e §5 |
| Paused user force-played by cold reroute plan | T5 `wasPausedAtReroute` | e2e §6 |
| Stale/leaked breaker counts (StrictMode, file switch, seek spam, replay) | T4 reset sites 1-8 (structural: increment downstream of :2742 gen check) | T3 unit + code review |
| Double reroute (breaker × zero-audio × SB-fatal) | existing `mkvRerouteInFlightRef` latch; T4 mirrors the :2771 gate | code review (verified Adj 6) |
| 130Hz spin burning CPU | T2 flat 1000ms backoff | T1 unit |
| Cue-indexed MKV / TS / MP4 regression | harvest gated on `mkvCueIndex.length===0`; flag never set on resolving refills; classifier no-ops for non-mkv | T6 unit #5-6, T1/T3 unit, full vitest baseline |
| Eviction / warmer / replay / NaN-ahead | verified SAFE, no code (solution doc §2) | baseline suites |
| Paused + ahead≥cap blind spot (nulls not attempted until drain) | documented, accepted (30s runway at count start) | — |

---

### Task 0: Pre-flight

- [ ] **Step 0.1:** `cd /d/DEVELOPMENT/Telegram-Drive/app && npx tsc --noEmit && npx vitest run 2>&1 | grep -E 'Test Files|Tests '`
  Expected: tsc silent exit 0; `Tests  382 passed (382)`. If not — STOP, report, do not proceed on a dirty baseline.
- [ ] **Step 0.2:** Confirm anchors unmoved: `grep -n 'Streaming refill failed' src/hooks/useMSEPlayer.ts` → expect ~:2903. `grep -n 'const startStreamingChain' src/hooks/useMSEPlayer.ts` → expect ~:2606.

---

### Task 1: C — `computeRefillChainDelay` pure function (TDD)

**Files:** Create `app/src/__tests__/RefillBackoff.test.ts` · Modify `app/src/hooks/useMSEPlayer.ts` (export only, after `shouldTriggerZeroAudioReroute` — grep anchor: `export function shouldTriggerZeroAudioReroute`, ends ~:630)

- [ ] **Step 1.1: Write the failing test** — create `app/src/__tests__/RefillBackoff.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { computeRefillChainDelay } from '../hooks/useMSEPlayer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Null-failure backoff (fix C, refill-stall stack): a refill whose seekTo
 * returned null must NOT rechain at 0ms — on cue-less MKV the null is
 * deterministic (frozen demuxer position cache, zero I/O per retry; 3,413
 * observed retries at ~130Hz were arithmetic-guaranteed pointless). Flat
 * 1000ms turns the spin into ≤1Hz while the breaker (fix B) counts to its
 * verdict in ~4s. Healthy refills keep the shipped delay formula BYTE-FOR-BYTE
 * (regression pin below) so cue-indexed/TS chains are provably untouched.
 */
describe('computeRefillChainDelay', () => {
  it('returns 1000ms after a null refill regardless of buffer state', () => {
    expect(computeRefillChainDelay(true, 0.1, 20)).toBe(1000);
    expect(computeRefillChainDelay(true, 15, 20)).toBe(1000);
    expect(computeRefillChainDelay(true, 25, 20)).toBe(1000);
  });

  it('keeps 0ms immediate rechain below threshold on healthy refills', () => {
    expect(computeRefillChainDelay(false, 5, 20)).toBe(0);
    expect(computeRefillChainDelay(false, 19.9, 20)).toBe(0);
  });

  it('pins the shipped adaptive formula for healthy refills at/above threshold', () => {
    // min(5000, max(2000, floor((ahead-20)*200)))
    expect(computeRefillChainDelay(false, 20, 20)).toBe(2000);   // floor(0)→2000 clamp
    expect(computeRefillChainDelay(false, 25, 20)).toBe(2000);   // 1000→2000 clamp
    expect(computeRefillChainDelay(false, 32.5, 20)).toBe(2500); // formula region
    expect(computeRefillChainDelay(false, 40, 20)).toBe(4000);
    expect(computeRefillChainDelay(false, 60, 20)).toBe(5000);   // 8000→5000 cap
  });
});
```

- [ ] **Step 1.2: Run to verify it fails**
  Run: `cd /d/DEVELOPMENT/Telegram-Drive/app && npx vitest run src/__tests__/RefillBackoff.test.ts`
  Expected: FAIL — `computeRefillChainDelay` is not exported.
- [ ] **Step 1.3: Implement** — in `useMSEPlayer.ts`, insert AFTER the closing brace of `shouldTriggerZeroAudioReroute` (~:630):

```ts
/**
 * Refill chain-continue delay (fix C of the cue-less MKV refill-stall stack —
 * reports/refill-stall-solution.md). A null refill (seekTo could not resolve a
 * keyframe) retries at a flat 1000ms: on cue-less MKV the null is DETERMINISTIC
 * (mediabunny's position-cache walk is a pure function of frozen state — 3,413
 * observed 130Hz retries changed nothing), so fast retries are pointless; 1s
 * keeps the breaker's time-to-verdict ~4s while killing the spin. Healthy
 * refills keep the original expression byte-for-byte (cue-indexed/TS unchanged).
 * Pure + exported for testing.
 */
export function computeRefillChainDelay(
  lastRefillWasNull: boolean,
  ahead: number,
  threshold: number,
): number {
  if (lastRefillWasNull) return 1000;
  return ahead < threshold ? 0 : Math.min(5000, Math.max(2000, Math.floor((ahead - threshold) * 200)));
}
```

- [ ] **Step 1.4: Run to verify it passes**
  Run: `npx vitest run src/__tests__/RefillBackoff.test.ts` — Expected: 3 passed.
- [ ] **Step 1.5: Gate** — `npx tsc --noEmit` → exit 0.

---

### Task 2: C — wire the null flag + delay swap

**Files:** Modify `app/src/hooks/useMSEPlayer.ts` (3 edits)

- [ ] **Step 2.1: Declare the flag ref.** Grep anchor: `const consecutiveNoProgressRef = useRef(0);` (~:1818). Insert AFTER it (**flag only — `noUnusedLocals` is ON in this project (verified by tsc failure 2026-08-02): an inert `nullRefillCountRef` fails `tsc --noEmit` with TS6133, so the counter ref is declared in Task 4 where it's first read**):

```ts
  // Cue-less MKV refill-stall stack (reports/refill-stall-solution.md):
  // last-refill-was-null flag (backoff, fix C). Set ONLY in the refill null
  // branch downstream of the chain-generation stale check; cleared at every
  // refill entry. (The breaker counter, fix B, lands alongside its wiring.)
  const lastRefillNullRef = useRef(false);
```

- [ ] **Step 2.2: Clear the flag at try-entry.** Grep anchor: `const chainGeneration = streamingChainGenRef.current;` (~:2641). The next line is `try {`. Insert immediately after `try {`:

```ts
      // Backoff flag reflects THIS refill only; cleared before the entry
      // guards so guard-skipped cycles (buffer full etc.) take normal delays.
      lastRefillNullRef.current = false;
```

- [ ] **Step 2.3: Set flag in the null branch + swap the delay expression.** Grep anchor: `console.warn('[MSE] Streaming refill failed');` (~:2903). Add AFTER that line:

```ts
        lastRefillNullRef.current = true;
```

Then grep anchor: `const delay = ahead < REFILL_THRESHOLD_SECONDS ? 0 :` (~:2958) and replace the full expression line with:

```ts
          // Fix C: null refills back off to 1000ms (see computeRefillChainDelay).
          // MUST stay inside this generation-gated setTimeout wrapper (G5) —
          // do not relocate the reschedule outside the gen check below.
          const delay = computeRefillChainDelay(lastRefillNullRef.current, ahead, REFILL_THRESHOLD_SECONDS);
```

- [ ] **Step 2.4: Gates** — `npx tsc --noEmit` exit 0 · `npx vitest run` → **385 passed** (382 + 3).

---

### Task 3: B — `classifyNullRefill` pure function (TDD)

**Files:** Create `app/src/__tests__/NullRefillBreaker.test.ts` · Modify `app/src/hooks/useMSEPlayer.ts`

- [ ] **Step 3.1: Write the failing test:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { classifyNullRefill } from '../hooks/useMSEPlayer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Null-refill circuit breaker (fix B): classifies consecutive seekTo-null
 * refills. Near the file end (within one GOP, floor 5s) a null means the last
 * keyframe is behind us and fully transmuxed → 'eof' at N≥2 (mirrors the
 * shipped indexed-EOF precedent: nearEOF + noProgress≥1 = 2 observations).
 * Mid-file → 'reroute' to the ffmpeg tier at N≥5. The 30s fixed threshold was
 * REJECTED in review (could truncate ~3 GOPs of tail); threshold is dynamic:
 * max(estimatedKeyframeInterval, 5), computed at the call site.
 */
describe('classifyNullRefill', () => {
  const DUR = 8888.1;
  const GOP = 10.4;

  it('mid-file: continue below 5, reroute at 5+', () => {
    for (let n = 1; n <= 4; n++) {
      expect(classifyNullRefill(n, 25.02, DUR, true, GOP)).toBe('continue');
    }
    expect(classifyNullRefill(5, 25.02, DUR, true, GOP)).toBe('reroute');
    expect(classifyNullRefill(6, 25.02, DUR, true, GOP)).toBe('reroute');
  });

  it('near-EOF: continue at 1, eof at 2+ (never reroute)', () => {
    const pos = DUR - 3; // inside the final GOP
    expect(classifyNullRefill(1, pos, DUR, true, GOP)).toBe('continue');
    expect(classifyNullRefill(2, pos, DUR, true, GOP)).toBe('eof');
    expect(classifyNullRefill(7, pos, DUR, true, GOP)).toBe('eof');
  });

  it('near-EOF boundary sits exactly at duration - threshold', () => {
    expect(classifyNullRefill(2, DUR - GOP, DUR, true, GOP)).toBe('eof');       // on the line
    expect(classifyNullRefill(2, DUR - GOP - 0.01, DUR, true, GOP)).toBe('continue'); // just outside, N<5
    expect(classifyNullRefill(5, DUR - GOP - 0.01, DUR, true, GOP)).toBe('reroute');  // just outside, N≥5
  });

  it('unknown/degenerate duration can never declare eof', () => {
    expect(classifyNullRefill(9, 100, 0, true, GOP)).toBe('reroute');
    expect(classifyNullRefill(9, 100, Infinity, true, GOP)).toBe('reroute');
    expect(classifyNullRefill(9, 100, NaN, true, GOP)).toBe('reroute');
  });

  it('non-MKV never classifies (TS/MP4 hygiene, N5)', () => {
    expect(classifyNullRefill(99, 25.02, DUR, false, GOP)).toBe('continue');
  });
});
```

- [ ] **Step 3.2: Run to verify FAIL** — `npx vitest run src/__tests__/NullRefillBreaker.test.ts` → not exported.
- [ ] **Step 3.3: Implement** — insert after `computeRefillChainDelay` in useMSEPlayer.ts:

```ts
/**
 * Null-refill circuit breaker verdict (fix B of the cue-less MKV refill-stall
 * stack). A cue-less getKeyPacket(bufEnd) null is deterministic (frozen
 * position cache — vendored matroska-demuxer.ts:2233-2260 lacks the cue path's
 * lied-to-us retry), so counting is evidence-gathering for transients only.
 * Near duration end (within nearEofThresholdS = max(estimated GOP, 5), passed
 * by the caller) the last keyframe is behind us and fully transmuxed → 'eof'
 * at 2 observations (mirrors the indexed nearEOF+noProgress≥1 precedent).
 * Mid-file → 'reroute' to the ffmpeg /remux tier at 5. Unknown duration can
 * never declare eof (a guessed endOfStream would truncate mid-file playback).
 * Pure + exported for testing.
 */
export function classifyNullRefill(
  consecutiveNullRefills: number,
  refillPosition: number,
  duration: number,
  isMkv: boolean,
  nearEofThresholdS: number,
): 'continue' | 'eof' | 'reroute' {
  if (!isMkv) return 'continue';
  const nearEof = duration > 0 && Number.isFinite(duration)
    && refillPosition >= duration - nearEofThresholdS;
  if (nearEof) return consecutiveNullRefills >= 2 ? 'eof' : 'continue';
  return consecutiveNullRefills >= 5 ? 'reroute' : 'continue';
}
```

- [ ] **Step 3.4: Run to verify PASS** — 5 passed.
- [ ] **Step 3.5: Gates** — `npx tsc --noEmit` exit 0 · `npx vitest run` → **390 passed**.

---

### Task 4: B — wire the breaker (null branch, success reset, 8 reset sites, `hasEverCompletedRef` fix)

**Files:** Modify `app/src/hooks/useMSEPlayer.ts` (10 small edits). All grep anchors below; re-grep each — earlier tasks shifted lines.

- [ ] **Step 4.0: Declare the breaker counter.** Anchor: `const lastRefillNullRef = useRef(false);` (declared in Task 2). Insert BEFORE it:

```ts
  // Consecutive seekTo-null refills (breaker counter, fix B). Incremented
  // ONLY in the refill null branch (downstream of the chain-generation stale
  // check, so dead chains can never count); reset at sites 1-8 (see plan).
  const nullRefillCountRef = useRef(0);
```

(Declared here, not Task 2 — `noUnusedLocals` rejects an unread ref.)

- [ ] **Step 4.1: Null-branch classification.** Anchor: `lastRefillNullRef.current = true;` (added in Task 2, inside the `else` after `console.warn('[MSE] Streaming refill failed')`). REPLACE the whole else-block body (from `// Refill failed — discard buffered segments` through the warn + flag lines) with:

```ts
        // Refill failed — discard buffered segments
        seekBufferRef.current = [];
        console.warn('[MSE] Streaming refill failed');
        lastRefillNullRef.current = true;

        // Null-refill circuit breaker (fix B, reports/refill-stall-solution.md).
        // Runs ONLY downstream of the chain-generation stale check (:2742-class
        // guard above) — a dead chain's late null can never count. `duration`,
        // `estimatedKeyframeInterval` and `refillPosition` are the same values
        // the adjacent EOF machinery uses (one clock).
        if (formatRef.current === 'mkv') {
          nullRefillCountRef.current++;
          const verdict = classifyNullRefill(
            nullRefillCountRef.current,
            refillPosition,
            duration,
            true,
            Math.max(estimatedKeyframeInterval, 5),
          );
          if (verdict === 'eof') {
            // Cue-less EOF: the indexed EOF path above is unreachable on null
            // (it requires a resolved keyframe — a null even resets its
            // counter), so without this branch the chain null-loops at file
            // end forever: video.ended never fires, no replay overlay.
            // Reduced completion — NO segment flush (seekBuffer was just
            // discarded; the failed seekTo produced nothing).
            console.log(`[MSE] EOF via null-refill classification: pos=${refillPosition.toFixed(1)}s dur=${duration.toFixed(1)}s (${nullRefillCountRef.current} consecutive nulls)`);
            hasEverCompletedRef.current = true; // near-end seek guard parity with the indexed path
            const msEof = state.current.mediaSource;
            if (msEof && msEof.readyState === 'open') {
              try { msEof.endOfStream(); console.log('[MSE] endOfStream called at EOF (null-refill)'); } catch (e2) { console.warn('[MSE] endOfStream failed:', e2); }
            }
            setIsComplete(true);
            isCompleteRef.current = true; // finally's rechain is gated on this
            refillInProgressRef.current = false;
            return;
          }
          if (verdict === 'reroute' && !mkvRerouteInFlightRef.current) {
            // Deterministic mid-file null → the ffmpeg /remux tier (reads
            // linearly, cue-less-proof). The reroute latches
            // mkvRerouteInFlightRef AND bumps the chain generation
            // synchronously before its first await, so the finally block's
            // stale-gen check kills the rechain — no double-fire, no orphan
            // setTimeout (verified, review Adj 6).
            diagLog(`[MSE] MKV refill cannot advance (${nullRefillCountRef.current} consecutive null keyframes at ${refillPosition.toFixed(1)}s) — rerouting to /remux`);
            void recoverMkvRerouteRef.current?.('refill cannot advance (null keyframe)');
            refillInProgressRef.current = false;
            return;
          }
        }
```

- [ ] **Step 4.2: Success reset.** Anchor: `lastRefillKeyframeRef.current = keyframeTimestamp;` (~:2859, inside `if (keyframeTimestamp !== null)`). Add after it:

```ts
        nullRefillCountRef.current = 0; // breaker: a healthy refill ends the null streak
```

- [ ] **Step 4.3: Reset site 1 — startStreamingChain (LOAD-BEARING: covers post-seek/post-switch/replay/StrictMode).** Anchor: `consecutiveNoProgressRef.current = 0;` inside `startStreamingChain` (~:2611). Add after it:

```ts
    // Breaker/backoff reset (canonical site — every chain (re)start begins
    // with a clean slate; the other reset sites are belts):
    nullRefillCountRef.current = 0;
    lastRefillNullRef.current = false;
```

- [ ] **Step 4.4: Reset sites 6+7 — per-file cleanup + unmount twin.** Anchor 1: `zeroAudioWindowsRef.current = 0;` at ~:2355 (per-file cleanup block that also sets `mkvRerouteInFlightRef.current = false`). Add after it:

```ts
      nullRefillCountRef.current = 0;
      lastRefillNullRef.current = false;
      // Pre-existing latent bug (review L6): hasEverCompletedRef was NEVER
      // reset per-file — a completed previous file leaks its 'ended' state
      // into the near-end seek guard of the NEXT file. Load-bearing now that
      // the 'eof' verdict writes it.
      hasEverCompletedRef.current = false;
```

  Anchor 2: the twin `zeroAudioWindowsRef.current = 0;` at ~:2467 (unmount cleanup). Add after it:

```ts
    nullRefillCountRef.current = 0;
    lastRefillNullRef.current = false;
```

- [ ] **Step 4.5: Reset site 3 — user seek.** Anchor: `zeroAudioWindowsRef.current = 0; // starvation watchdog: new position, fresh count` (~:9158). Add after it:

```ts
        nullRefillCountRef.current = 0; // breaker: new position, fresh count
```

- [ ] **Step 4.6: Reset site 4 — track switch.** Anchor: `stopStreamingChain();` inside `_switchMkvAudioTrack` (~:6217; the next line is `refillInProgressRef.current = false;`). Add after that next line:

```ts
    nullRefillCountRef.current = 0; // breaker: rebuild = fresh chain
```

- [ ] **Step 4.7: Reset site 5 — reroute producer-stop.** Anchor: `zeroAudioWindowsRef.current = 0;` inside `_recoverMkvToRemuxTier` (~:4677). Add after it:

```ts
      nullRefillCountRef.current = 0;
```

- [ ] **Step 4.8: Reset site 8 — transmuxer init.** Anchor: `zeroAudioWindowsRef.current = 0;` at ~:7109 (MKV transmuxer init path). Add after it:

```ts
    nullRefillCountRef.current = 0;
```

- [ ] **Step 4.9: Gates** — `npx tsc --noEmit` exit 0 · `npx vitest run` → 390 passed (no count change; wiring only).
- [ ] **Step 4.10: Control-flow self-check (read, no edit):** re-read the modified null branch and confirm: (a) both early returns set `refillInProgressRef.current = false`; (b) the eof branch does NOT flush seekBuffer; (c) the reroute call is `void`-fired, not awaited (matches the :2774 zero-audio idiom).

---

### Task 5: B — L3 pause guard ('paused means paused' through reroutes)

**Files:** Modify `app/src/hooks/useMSEPlayer.ts` (`_recoverMkvToRemuxTier`)

- [ ] **Step 5.1:** Anchor: `const resumeT = video?.currentTime ?? 0;` (~:4667). Add after it:

```ts
      // 'Paused means paused' (L3): capture BEFORE teardown — src='' and the
      // teardown pause make video.paused read true unconditionally later. The
      // cold recovery plan (<8s) force-plays at MEDIA_INFO and its re-pause
      // check reads only the PREFETCH pause ref (isPausedRef is written solely
      // by pausePrefetch/resumePrefetch), so a user who paused the VIDEO
      // ELEMENT would be force-unpaused by the reroute without this.
      const wasPausedAtReroute = (video?.paused ?? false) || isPausedRef.current;
```

- [ ] **Step 5.2:** Anchor: `const ok = await _recoverToRemuxTier(streamUrlRef.current ?? '', reason, resumeT, false);` (~:4703). Add AFTER it (before the `if (!ok)` block):

```ts
      if (ok && wasPausedAtReroute) {
        // Do NOT widen the tier-shared re-pause check inside the recovery
        // path itself — this guard is MKV-reroute-scoped by design.
        try { videoRef.current?.pause(); } catch { /* detached element */ }
      }
```

- [ ] **Step 5.3: Gates** — `npx tsc --noEmit` exit 0 · `npx vitest run` → 390 passed.

---

### Task 6: A — index plumbing: O(log n) dedup, watermark, `findNearestKeyframe` trust, dispose reset (TDD)

**Files:** Create `app/src/__tests__/HarvestedKeyframeIndex.test.ts` · Modify `app/src/lib/faststream/players/MediabunnyTransmuxer.ts`

- [ ] **Step 6.1: Write the failing tests** (watermark + dedup + trust rule; the iteration-harvest test arrives in Task 7 in this same file):

```ts
import { describe, it, expect, vi } from 'vitest';
import { MediabunnyTransmuxer } from '../lib/faststream/players/MediabunnyTransmuxer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Cue-less MKV keyframe harvest (fix A, reports/refill-stall-solution.md).
 * mediabunny's getKeyPacket cannot find a keyframe BEHIND its position-cache
 * walk start, so cue-less refills at bufEnd null forever. The harvest feeds
 * every iterated keyframe into the partial index; the contiguous watermark
 * [harvestSpanStart, harvestSpanEnd] lets findNearestKeyframe trust the index
 * at ANY distance inside fully-iterated spans (GOP>12s files included), while
 * the 12s sparse rule stays byte-identical outside.
 */
function makeTransmuxer(): MediabunnyTransmuxer {
  return new MediabunnyTransmuxer({
    format: 'mkv',
    sourceConfig: { url: 'http://x', fileSize: 1 },
    onInitSegment: () => {},
    onMediaSegment: () => {},
    onDurationKnown: () => {},
    onCodecUnsupported: () => {},
    onError: () => {},
  } as any);
}

describe('addKeyframeTimestamp dedup (O(log n) neighbor check)', () => {
  it('dedups ±0.01s twins and keeps the array sorted under out-of-order inserts', () => {
    const t = makeTransmuxer() as any;
    t.addKeyframeTimestamp(20.81);
    t.addKeyframeTimestamp(20.815);  // within 0.01 → dropped
    t.addKeyframeTimestamp(20.805);  // within 0.01 → dropped
    t.addKeyframeTimestamp(0);
    t.addKeyframeTimestamp(10.4);
    t.addKeyframeTimestamp(10.4);    // exact dup → dropped
    expect(t.getKeyframeTimestamps()).toEqual([0, 10.4, 20.81]);
  });
});

describe('harvest watermark (noteIterated)', () => {
  it('merges abutting/overlapping windows into one span', () => {
    const t = makeTransmuxer() as any;
    t.noteIterated(0); t.noteIterated(0.2); t.noteIterated(0.4);
    expect(t.harvestSpanStart).toBe(0);
    expect(t.harvestSpanEnd).toBeCloseTo(0.4, 9);
    t.noteIterated(0.6); // within 0.25 tolerance → extend
    expect(t.harvestSpanEnd).toBeCloseTo(0.6, 9);
  });

  it('resets the span on a disjoint HIGHER window (far forward seek)', () => {
    const t = makeTransmuxer() as any;
    t.noteIterated(0); t.noteIterated(5);
    t.noteIterated(100); // gap ≫ 0.25 → new span
    expect(t.harvestSpanStart).toBe(100);
    expect(t.harvestSpanEnd).toBe(100);
  });

  it('never over-claims on a disjoint LOWER window (backward seek)', () => {
    const t = makeTransmuxer() as any;
    t.noteIterated(100); t.noteIterated(100.2);
    t.noteIterated(50); // merge branch, no extension — span unchanged
    expect(t.harvestSpanStart).toBe(100);
    expect(t.harvestSpanEnd).toBeCloseTo(100.2, 9);
  });
});

describe('findNearestKeyframe watermark trust', () => {
  it('trusts any distance inside the span; 12s rule intact outside', () => {
    const t = makeTransmuxer() as any;
    t.keyframeTimestamps = [0, 20];
    t.keyframeIndexPartial = true;
    t.harvestSpanStart = 0; t.harvestSpanEnd = 45;
    expect(t.findNearestKeyframe(45)).toBe(20);   // 25s gap — trusted inside span
    expect(t.findNearestKeyframe(45.2)).toBe(20); // inside the +0.25 tolerance lip
    t.harvestSpanStart = -1; t.harvestSpanEnd = -1;
    expect(t.findNearestKeyframe(45)).toBeNull(); // sparse rule restored
    expect(t.findNearestKeyframe(25)).toBeNull(); // 25-20=5 ≤ 12 BUT... 
  });
});
```

  **STOP — fix the last assert before saving:** `findNearestKeyframe(25)` with index `[0,20]` and no span: gap 25−20=5 ≤ 12 → returns 20 (sparse rule allows it). The correct final asserts are:

```ts
    expect(t.findNearestKeyframe(25)).toBe(20);   // ≤12s gap allowed outside span (unchanged rule)
    expect(t.findNearestKeyframe(33)).toBeNull(); // 13s gap rejected outside span (unchanged rule)
```

  Use these two lines instead of the broken one. (Kept in-plan deliberately: workers must not "fix" tests by weakening asserts — derive the expectation from the rule, then write it.)

- [ ] **Step 6.2: Run to verify FAIL** — `npx vitest run src/__tests__/HarvestedKeyframeIndex.test.ts`
  Expected: dedup test may PASS already (old `ts.some` also dedups); watermark tests FAIL (`noteIterated` is not a function); trust test FAIL on the in-span asserts.
- [ ] **Step 6.3: Implement in MediabunnyTransmuxer.ts** — four edits:

  (a) Fields. Anchor: `private mkvCueIndex: { time: number; byteOffset: number }[] = [];` (~:177). Add after it:

```ts
  // Cue-less MKV harvest watermark (fix A, reports/refill-stall-solution.md):
  // ONE contiguous span [start, end] of fully-iterated packet timestamps.
  // Inside it, every keyframe is guaranteed present in keyframeTimestamps, so
  // findNearestKeyframe may trust the index at any distance. -1 = empty.
  private harvestSpanStart = -1;
  private harvestSpanEnd = -1;
```

  (b) `noteIterated`. Anchor: closing brace of `addKeyframeTimestamp` (~:800). Add after it:

```ts
  /** Watermark update (cue-less MKV harvest). Consecutive refill windows
   *  OVERLAP by construction on cue-less files (the next window re-resolves
   *  the PRIOR keyframe behind the mid-GOP maxDuration cut), so the merge
   *  branch runs with negative gap; the 0.25s tolerance additionally bridges
   *  float jitter on exact-abut geometries. A disjoint HIGHER window (far
   *  forward seek) RESETS the span (single-span model — the refill chain only
   *  queries the current playback region; GOP>12s coverage behind a far seek
   *  degrades to the G1/B guards, disclosed in the design). A disjoint LOWER
   *  window merges without extending — the span can under-claim, NEVER
   *  over-claim (span facts are monotone: once fully iterated, always true). */
  private noteIterated(ts: number): void {
    if (this.harvestSpanEnd >= 0 && ts <= this.harvestSpanEnd + 0.25) {
      if (ts > this.harvestSpanEnd) this.harvestSpanEnd = ts;
    } else if (ts > this.harvestSpanEnd) {
      // First-ever window or disjoint-higher reset. (`ts > end` is always
      // true here for non-negative timestamps; the guard only rejects
      // degenerate negatives.)
      this.harvestSpanStart = ts;
      this.harvestSpanEnd = ts;
    }
  }
```

  (c) Dedup swap. In `addKeyframeTimestamp` (anchor `private addKeyframeTimestamp(timestamp: number): void {` ~:781), DELETE the two lines:

```ts
    // Skip if already present (within 0.01s tolerance)
    if (ts.some(t => Math.abs(t - timestamp) < 0.01)) return;
```

  and insert between the binary-search loop's closing brace and the `ts.splice(lo, 0, timestamp);` line:

```ts
    // Dedup via neighbor check — O(log n) total, replacing the old O(n)
    // ts.some() scan (the harvest path calls this per keyframe; ~3k keyframes
    // on a 9h file would make the linear scan ~5M compares over the file).
    if ((lo < ts.length && Math.abs(ts[lo] - timestamp) < 0.01)
     || (lo > 0 && Math.abs(ts[lo - 1] - timestamp) < 0.01)) return;
```

  (d) Trust rule. In `findNearestKeyframe`, anchor the existing sparse-rule block (~:837):

```ts
      if (!this.keyframeIndexBuilt && seekTime - ts[lo] > 12) {
        return null; // Sparse coverage — don't seek to a distant stale keyframe
      }
```

  Replace with:

```ts
      // Inside the harvest watermark the index provably contains EVERY
      // keyframe of the span, so the nearest indexed keyframe IS the true
      // nearest — trust it at any distance (a GOP>12s cue-less file would
      // otherwise still null). Outside the span the 12s rule is unchanged.
      const inWatermark = this.harvestSpanEnd >= 0
        && seekTime >= this.harvestSpanStart && seekTime <= this.harvestSpanEnd + 0.25;
      if (!this.keyframeIndexBuilt && !inWatermark && seekTime - ts[lo] > 12) {
        return null; // Sparse coverage — don't seek to a distant stale keyframe
      }
```

  (e) Dispose reset. Anchor: `this.keyframeIndexPartial = false;` inside `dispose()` (~:1880). Add after it:

```ts
    this.harvestSpanStart = -1;
    this.harvestSpanEnd = -1;
```

- [ ] **Step 6.4: Run to verify PASS** — `npx vitest run src/__tests__/HarvestedKeyframeIndex.test.ts` → all pass.
- [ ] **Step 6.5: Gates** — `npx tsc --noEmit` exit 0 · `npx vitest run` → **395 passed** (390 + 5).

---

### Task 7: A — the harvest itself in `iterateVideoPackets` (TDD)

**Files:** Modify `app/src/__tests__/HarvestedKeyframeIndex.test.ts` (append) · Modify `MediabunnyTransmuxer.ts`

- [ ] **Step 7.1: Append the failing iteration tests** to HarvestedKeyframeIndex.test.ts:

```ts
/** Drive the REAL iterateVideoPackets with a scripted sink (AudioStartChain
 *  mock pattern). Packets carry ORIGINAL absolute timestamps; the pump clones
 *  them rebased for muxing — harvest must record the pre-clone values. */
function fakePacket(timestamp: number, type: 'key' | 'delta') {
  return {
    timestamp,
    type,
    clone: (opts: { timestamp: number }) => ({ timestamp: opts.timestamp, type }),
  };
}

async function driveIteration(t: any, packets: any[], maxDuration: number) {
  const sink = { packets: async function* () { for (const p of packets) yield p; } };
  const source = { add: async () => {}, close: () => {} };
  await t.iterateVideoPackets(
    sink, packets[0], source, { decoderConfig: undefined },
    packets[0].timestamp, t.seekGeneration, maxDuration, false, Infinity,
  );
}

describe('iterateVideoPackets keyframe harvest', () => {
  const PACKETS = [
    fakePacket(0, 'key'), fakePacket(5, 'delta'),
    fakePacket(10.4, 'key'), fakePacket(15, 'delta'),
    fakePacket(20.81, 'key'), fakePacket(25.02, 'delta'),
  ];

  it('harvests ORIGINAL key timestamps, including the cut-triggering packet', async () => {
    const t = makeTransmuxer() as any;
    await driveIteration(t, PACKETS, 17); // cut fires at 20.81 (adjusted 20.81 > 17)
    // 20.81 triggered the maxDuration break but harvest runs BEFORE the stop
    // check — it must be captured (this is what makes the next refill resolve).
    expect(t.getKeyframeTimestamps()).toEqual([0, 10.4, 20.81]);
    expect(t.harvestSpanStart).toBe(0);
    expect(t.harvestSpanEnd).toBeCloseTo(20.81, 9); // watermark reaches the break packet
  });

  it('cue-indexed transmuxer never harvests (byte-identical index for indexed files)', async () => {
    const t = makeTransmuxer() as any;
    t.mkvCueIndex = [{ time: 0, byteOffset: 0 }];
    await driveIteration(t, PACKETS, 17);
    expect(t.getKeyframeTimestamps()).toEqual([]);
    expect(t.harvestSpanEnd).toBe(-1);
  });

  it('keyframeIndexBuilt disables harvest (full scan already authoritative)', async () => {
    const t = makeTransmuxer() as any;
    t.keyframeIndexBuilt = true;
    await driveIteration(t, PACKETS, 17);
    expect(t.harvestSpanEnd).toBe(-1);
  });
});
```

- [ ] **Step 7.2: Run to verify FAIL** — harvest asserts fail (index stays `[]`, span stays -1).
- [ ] **Step 7.3: Implement.** In `iterateVideoPackets` (anchor: `let isFirst = true;` ~:1595), insert BEFORE that line:

```ts
    // Cue-less MKV keyframe harvest (fix A — reports/refill-stall-solution.md):
    // mediabunny's getKeyPacket walk starts at the highest position-cache entry
    // ≤ target and only moves FORWARD (vendored matroska-demuxer.ts:2233-2260;
    // the cache path lacks the cue path's lied-to-us retry), so once a GOP's
    // keyframe cluster falls behind the read frontier, every mid-GOP lookup in
    // the played span returns null — permanently. Harvest every keyframe the
    // pump observes (ORIGINAL pre-clone timestamps) so findNearestKeyframe
    // resolves refills from memory instead of re-searching. Gated: cue-INDEXED
    // files keep a byte-identical index (their seekTo never reaches
    // findNearestKeyframe), and a completed full scan needs no increments.
    const harvest = this.config.format === 'mkv'
      && !this.keyframeIndexBuilt
      && this.mkvCueIndex.length === 0;
```

  Then inside the loop, anchor the generation check block (~:1597-1600):

```ts
      if (this.seekAbortFlag || this.disposed || generation !== this.seekGeneration) {
        videoSource.close();
        return;
      }
```

  Insert AFTER it (before the `adjustedTimestamp` line — the packet must be observed even when the stop-check below breaks on it):

```ts
      if (harvest) {
        if (packet.type === 'key') this.addKeyframeTimestamp(packet.timestamp);
        this.noteIterated(packet.timestamp);
      }
```

- [ ] **Step 7.4: Run to verify PASS** — `npx vitest run src/__tests__/HarvestedKeyframeIndex.test.ts` → 8 passed (5 from Task 6 + 3 new).
- [ ] **Step 7.5: Gates** — `npx tsc --noEmit` exit 0 · `npx vitest run` → **398 passed**. Extra regression scan: `npx vitest run src/__tests__/AudioStartChain.test.ts src/__tests__/AudioTrackSelection.test.ts src/__tests__/snapToCueKeyframe.test.ts src/__tests__/MkvFatalReroute.test.ts` → all green (proves the pump edit broke no audio-chain behavior).

---

### Task 8: G1 — user-seek null guard (stranded-player fix)

**Files:** Modify `app/src/hooks/useMSEPlayer.ts`

- [ ] **Step 8.1:** Anchor (unique): `// Seek failed — discard buffered segments` followed by `seekBufferRef.current = [];` and `transmuxerSeekInProgressRef.current = false; // Seek failed — allow new seeks` (~:9320-9322 — the `.then()` else-branch, NOT the `.catch`). Replace those three lines with:

```ts
            } else {
              // Seek failed — discard buffered segments
              seekBufferRef.current = [];
              transmuxerSeekInProgressRef.current = false; // Seek failed — allow new seeks
              // G1 (cue-less MKV): a user-seek null STRANDS the player today —
              // the chain was stopped at seek entry, only the success branch
              // restarts it, and video.currentTime already sits at the
              // unbuffered target → spinner forever. The null is deterministic
              // (same frozen-cache geometry as the refill bug; post-harvest
              // it is near-unreachable), so retrying converges on the same
              // null: reroute to the ffmpeg tier immediately. resumeT inside
              // the reroute reads video.currentTime = the user's target, so
              // the rerouted session resumes exactly where they clicked.
              if (formatRef.current === 'mkv' && !mkvRerouteInFlightRef.current) {
                diagLog('[MSE] MKV user seek keyframe unresolvable — rerouting to /remux');
                void recoverMkvRerouteRef.current?.('user seek keyframe unresolvable');
              }
            }
```

  (Keep the surrounding `}` structure intact — this replaces the else-block BODY only. Non-MKV formats keep today's behavior exactly.)

- [ ] **Step 8.2: Gates** — `npx tsc --noEmit` exit 0 · `npx vitest run` → 398 passed.

---

### Task 9: G2 — track-switch null guard + TrackNumber→ffprobe-idx mapping helper

**Files:** Modify `app/src/hooks/useMSEPlayer.ts` (`_switchMkvAudioTrack`)

- [ ] **Step 9.1: Extract the mapping helper.** Anchor: `const plan = planAudioSwitch({` inside `_switchMkvAudioTrack` (~:6169). Insert BEFORE that line:

```ts
    // Map the Matroska TrackNumber (trackId) to the ffprobe stream index —
    // remuxAudioIdxRef feeds withAudioIdx → the server's
    // validate_audio_idx_override, which speaks FFPROBE indices. A naive
    // trackId assignment selects the WRONG stream on tier 2 (review Adj 4).
    // null (mapping unavailable) degrades to the server default track.
    const mapTrackToFfprobeIdx = async (): Promise<number | null> => {
      const parsed = streamUrlRef.current ? parseStreamUrl(streamUrlRef.current) : null;
      if (!parsed) return null;
      try {
        const resp = await fetch(`${parsed.baseUrl}/audio_tracks/${parsed.folderId}/${parsed.messageId}?token=${encodeURIComponent(parsed.token)}`);
        if (!resp.ok) return null;
        const json = await resp.json();
        const ff = (Array.isArray(json?.tracks) ? json.tracks : []).map((s: any) => ({ id: s.index }));
        return mapAudioTrackToRemuxIdx(audioTracks, trackId, ff);
      } catch (_) { return null; /* mapping fetch failed — server default track */ }
    };
```

- [ ] **Step 9.2: Deduplicate the reroute-remux plan branch.** Anchor: `diagLog(\`[AUDIO] mkv switch: plan=reroute-remux → switching via /remux tier (track ${trackId})\`);` (~:6183). The lines after it — `const parsed = ...` through `remuxAudioIdxRef.current = mappedIdx;` (the inline fetch+mapping, ~13 lines ending at ~:6196) — REPLACE with:

```ts
      remuxAudioIdxRef.current = await mapTrackToFfprobeIdx();
```

  (Behavior identical — same fetch, same mapping, same null degradation. Keep the `const ok = (await recoverMkvRerouteRef...` line and the revert-on-failure block that follow untouched.)

- [ ] **Step 9.3: Fix the null branch.** Anchor: `diagLog('[AUDIO] mkv switch: seekTo returned null — reverting selection');` (~:6249). Replace the whole null block:

```ts
    if (keyframeTimestamp === null) {
      diagLog('[AUDIO] mkv switch: seekTo returned null — reverting selection');
      await transmuxer.setDesiredAudioTrack(null);
      return false;
    }
```

  with:

```ts
    if (keyframeTimestamp === null) {
      // G2 (cue-less MKV): the rebuild seekTo nulls for the same reason
      // refills do (mid-GOP playhead, keyframe cluster behind the position-
      // cache walk start). A bare revert leaves a DEAD player: the SB was
      // flushed (resetForSeek above) and the chain stopped — nothing restarts
      // either, and re-seeking would null again. Escalate to the ffmpeg tier
      // carrying the user's chosen track. No setDesiredAudioTrack(null)
      // revert — the reroute disposes the transmuxer anyway.
      diagLog(`[AUDIO] mkv switch: seekTo returned null — escalating to /remux tier (track ${trackId})`);
      remuxAudioIdxRef.current = await mapTrackToFfprobeIdx();
      return (await recoverMkvRerouteRef.current?.(`audio switch keyframe unresolvable (track ${trackId})`)) ?? false;
    }
```

- [ ] **Step 9.4: Gates** — `npx tsc --noEmit` exit 0 · `npx vitest run` → 398 passed (incl. AudioTrackSelection.test.ts 32 — proves the plan-branch dedup changed no behavior).

---

### Task 10: Fixture — real cue-less MKV, H1 pinned in-tree (timeboxed 45 min)

**Files:** Create `app/src/__tests__/CuelessMkvFixture.test.ts`

**Geometry note (ledger #12 — load-bearing):** the muxer starts a new cluster ONLY on a keyframe (≥ `minimumClusterDuration`, default 1s) OR at the 32,767ms relative-timestamp overflow. A GOP ≤ 32.7s therefore puts every keyframe at a cluster start and the bug CANNOT reproduce. **GOP must exceed 32.77s** → keyframes at 0 and 40s force a mid-GOP cluster at ~32.8s: cache entries {0, ~32.8, 40}; `getKeyPacket(35)` → walk starts at cluster ~32.8 (deltas only) → next cluster starts 40 > 35 → break → **null**.

- [ ] **Step 10.1: Write the test:**

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  Output, Input, MkvOutputFormat, BufferTarget, BufferSource,
  EncodedVideoPacketSource, EncodedPacket, EncodedPacketSink, MATROSKA,
} from 'mediabunny';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * In-tree pin of the mediabunny cue-less getKeyPacket contract bug (H1,
 * reports/research/refill-stall-verify-h1.md — present through v1.52.2):
 * after linear iteration populates the cluster position cache, a mid-GOP
 * target whose GOP keyframe cluster lies BEHIND the walk start returns null
 * even though a keyframe ≤ target exists. Fix A (harvest) resolves refills to
 * exact harvested timestamps, whose own clusters ARE reachable — asserted
 * here against the same real file. IF A MEDIABUNNY UPGRADE MAKES THE NULL
 * ASSERT FAIL, the upstream bug is fixed and fix A can be retired.
 *
 * Muxer geometry (verified matroska-muxer.ts:74/:1137-1148): clusters break
 * only on keyframes (≥ minimumClusterDuration) or at the 32,767ms overflow —
 * GOP must exceed 32.77s to produce mid-GOP cluster starts. Keyframes at
 * 0/40s → clusters at 0, ~32.8 (mid-GOP, deltas only), 40.
 */
async function buildCuelessMkv(): Promise<Uint8Array> {
  const target = new BufferTarget();
  const output = new Output({ format: new MkvOutputFormat({ appendOnly: true }), target });
  const source = new EncodedVideoPacketSource('vp8');
  output.addVideoTrack(source);
  await output.start();
  let first = true;
  for (let ts = 0; ts < 45; ts += 0.5) {
    const isKey = ts === 0 || ts === 40;
    const packet = new EncodedPacket(new Uint8Array(isKey ? 800 : 200), isKey ? 'key' : 'delta', ts, 0.5);
    if (first) {
      await source.add(packet, { decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 240 } });
      first = false;
    } else {
      await source.add(packet);
    }
  }
  await output.finalize();
  const buf = new Uint8Array(target.buffer!);
  // finalize() writes a trailing Cues element UNCONDITIONALLY even with
  // appendOnly (only the SeekHead + size back-patch are skipped). Truncate at
  // the trailing top-level Cues ID 1C 53 BB 6B — scanning from the END, so
  // payload false-positives (all earlier) are skipped. appendOnly segments
  // have unknown size → a truncated tail is legal, walkable Matroska.
  for (let i = buf.length - 4; i >= 0; i--) {
    if (buf[i] === 0x1c && buf[i + 1] === 0x53 && buf[i + 2] === 0xbb && buf[i + 3] === 0x6b) {
      return buf.subarray(0, i);
    }
  }
  throw new Error('trailing Cues element not found in muxed output');
}

describe('cue-less MKV getKeyPacket (H1 pin + harvest resolution)', () => {
  it('nulls on a mid-GOP target behind the read frontier; exact harvested lookups succeed', async () => {
    const bytes = await buildCuelessMkv();
    const input = new Input({ source: new BufferSource(bytes), formats: [MATROSKA] });
    const track = await input.getPrimaryVideoTrack();
    expect(track).toBeTruthy();
    const sink = new EncodedPacketSink(track!);

    // Simulate the prime: iterate 0→35 (populates the position cache with an
    // entry per read cluster, including the mid-GOP ~32.8s cluster) and
    // harvest keyframes the way fix A does.
    const harvested: number[] = [];
    for await (const p of sink.packets(undefined, undefined, { verifyKeyPackets: false })) {
      if (p.type === 'key') harvested.push(p.timestamp);
      if (p.timestamp >= 35) break;
    }
    expect(harvested).toEqual([0]); // only kf 0 lies in [0,35]

    // H1 REPRO (the refill geometry): target 35 — keyframe 0 ≤ 35 exists, but
    // the walk starts at the cached mid-GOP ~32.8 cluster and only moves
    // forward → null. THE CONTRACT VIOLATION, pinned.
    const nullResult = await sink.getKeyPacket(35, { verifyKeyPackets: false });
    expect(nullResult).toBeNull();

    // Determinism (review L7): even after iterating the WHOLE file (cache
    // fully populated), the same lookup still nulls — retries are pointless,
    // which is why the breaker's N=5 is generous, not risky.
    for await (const p of sink.packets(undefined, undefined, { verifyKeyPackets: false })) {
      if (p.type === 'key' && !harvested.includes(p.timestamp)) harvested.push(p.timestamp);
    }
    expect(harvested).toEqual([0, 40]);
    expect(await sink.getKeyPacket(35, { verifyKeyPackets: false })).toBeNull();

    // HARVEST RESOLUTION (what fix A does instead): exact harvested-timestamp
    // lookups land on the keyframe's own cached cluster — reachable, no walk.
    const kf0 = await sink.getKeyPacket(0, { verifyKeyPackets: false });
    expect(kf0?.timestamp).toBe(0);
    const kf40 = await sink.getKeyPacket(40, { verifyKeyPackets: false });
    expect(kf40?.timestamp).toBe(40);
  });
});
```

- [ ] **Step 10.2: Run** — `npx vitest run src/__tests__/CuelessMkvFixture.test.ts`
  Expected: PASS. **Timebox decision tree:** (a) muxer throws on codec/metadata validation in node → try `codec: 'vp09.00.10.08'` + `'vp9'` source; (b) `getPrimaryVideoTrack()` returns null on the truncated buffer → re-truncate INCLUDING trailing garbage check (dump first 64 bytes hex to diagnose); (c) still failing at 45 min → `it.skip` with a `// SPIKE:` comment explaining the runtime blocker, keep the file, note it in the handoff summary. The unit suites (Tasks 1-7) carry the behavioral coverage regardless — do NOT sink more time.
- [ ] **Step 10.3: Gates** — `npx tsc --noEmit` exit 0 · `npx vitest run` → **399 passed** (or 398 + 1 skipped per the timebox).

---

### Task 11: Full verification + cleanup + e2e handoff

- [ ] **Step 11.1: Full gates, one shot:**
  ```bash
  cd /d/DEVELOPMENT/Telegram-Drive/app && npx tsc --noEmit && npx vitest run 2>&1 | grep -E 'Test Files|Tests '
  cd /d/DEVELOPMENT/Telegram-Drive/app/src-tauri && cargo test --no-default-features 2>&1 | grep -E 'test result'
  ```
  Expected: tsc 0 · vitest ≈ 399 passed, 0 failed · cargo `178 passed` (no Rust was touched — this is the tripwire proving it).
- [ ] **Step 11.2: Diff audit (surgical-change check):** `git diff --stat` → ONLY `useMSEPlayer.ts`, `MediabunnyTransmuxer.ts`, 4 new test files. `git diff` and read every hunk: no vendored-lib edits, no formatting-only hunks, no unrelated lines. Any stray hunk → revert it.
- [ ] **Step 11.3: Behavior tripwires (grep — expected result stated per line):**
  - `grep -n 'setDesiredAudioTrack(null)' app/src/hooks/useMSEPlayer.ts` → the G2 NULL branch must NOT contain it (other call sites unchanged).
  - `grep -c 'nullRefillCountRef.current = 0' app/src/hooks/useMSEPlayer.ts` → expect **8** (sites 1-8).
  - `grep -n 'hasEverCompletedRef.current = false' app/src/hooks/useMSEPlayer.ts` → exactly 1 (per-file cleanup).
- [ ] **Step 11.4: Delete the analyzed test logs** (per project convention — analysis is preserved in `reports/`): `rm /d/DEVELOPMENT/Telegram-Drive/1-c.md /d/DEVELOPMENT/Telegram-Drive/1-t.md`
- [ ] **Step 11.5: HAND BACK TO USER for e2e** (`npm run tauri dev`, the Inception cue-less MKV). Do NOT claim done — backend-invisible phases are never self-certified. Checklist to include in the handoff message:

  1. **Prime unchanged:** `extracted 0 cue points` · `fallback getFirstKeyPacket → 0.029s` · `audioSkipped=false` · SB [0-25.02] · audio audible.
  2. **First refill resolves from the index:** `[Transmuxer] seekTo: using keyframe index — seekTargetTs=20.810s` + `usedIndex=true` · overlap ≈ 4.2s · buffer advances past 37s.
  3. **Steady state:** buffer marches to ~20s-ahead cadence · **ZERO** `No keyframe found at or before` · zero `Streaming refill failed` · no reroute lines · audio SB grows in lockstep.
  4. **Shadow seek:** seek forward +30s → lands (no eternal spinner). Far seek (+1h) → slow but lands (pre-existing walk cost, out of scope).
  5. **Track switch mid-playback:** switches or visibly reroutes to tier 2 with the chosen track — never a dead player.
  6. **Pause discipline:** pause → refills continue silently → stays paused (including if a reroute fires).
  7. **EOF:** seek near the end, let it finish → `ended` fires, replay overlay appears (console shows either the indexed EOF line or `EOF via null-refill classification`) — no null-loop.
  8. Capture fresh `N-c.md` / `N-t.md` logs if ANY checklist line fails.

---

## Self-review record (writing-plans §Self-Review — executed before handoff)

1. **Spec coverage:** every solution-doc §2 element mapped: A→T6/T7, B→T3/T4, C→T1/T2, G1→T8, G2→T9, L1→T4.1 eof branch, L3→T5, L6/resets→T4.3-4.8, fixture→T10, e2e→T11.5. Docs-only amendments (L4 numbers, N7 note) live in the solution doc — no code task needed. ✓
2. **Placeholder scan:** no TBD/TODO/"add error handling"/"similar to task N". The one deliberate trap in T6.1 is explicitly resolved in-plan with the corrected asserts. ✓
3. **Type consistency:** `computeRefillChainDelay(boolean, number, number)` and `classifyNullRefill(number, number, number, boolean, number)` used identically in tests and wiring; refs `nullRefillCountRef`/`lastRefillNullRef` named consistently across Tasks 2/4. ✓
4. **Cross-boundary APIs:** no Tauri/HTTP signature changes. The G2 helper reuses the EXISTING `/audio_tracks` endpoint + `mapAudioTrackToRemuxIdx(audioTracks, trackId, ff)` with unchanged argument shapes (verified :6184-6196). ✓
5. **Helper reality check:** all consumed helpers re-read at source — `mapAudioTrackToRemuxIdx` (:408), `parseStreamUrl` (in scope in the hook), `diagLog`, `state.current.mediaSource/duration`, `recoverMkvRerouteRef.current?.()` returning `Promise<boolean> | undefined` (hence `?? false` in T9.3). Mediabunny fixture APIs verified per ledger #11-14. ✓
6. **Unit sanity:** backoff formula pinned byte-for-byte with worked values (2000/2500/4000/5000); breaker thresholds N=2/N=5 with boundary tests at `duration − max(gop,5)`; fixture GOP arithmetic (32.767s overflow) derived from muxer source, not assumed. ✓

## Execution options

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
**2. Inline** — execute in-session, checkpoint after Tasks 2, 5, 7, 9, 11.
