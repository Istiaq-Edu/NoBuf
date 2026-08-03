# Round-7 fix plan — keyframe-shadow-safe player bisection

## Problem (from round7-log-forensics.md, all claims source-verified)

Round-6 Fix A injects the cluster at-or-before the SEEK TIME. mediabunny's
`performClusterLookup` picks the closest `clusterPositionCache` entry ≤ target and walks FORWARD
only, breaking at the first cluster starting past the target. When the injected (or any organic)
entry lands AFTER the last keyframe before the target ("keyframe shadow" — up to one GOP wide),
`getKeyPacket` finds no keyframe and returns null → `[Transmuxer] No keyframe found` → user-seek
fatal → /remux reroute (7-c:185-204). Verified immune: index path (`useCachedIndex` targets exact
keyframe times; a keyframe's own cluster always starts ≤ its ts), audio (every block is key).
Poison is sticky: closest-≤-target always re-picks the shadow entry, and the failed walk's own
organic inserts re-poison even after removing the injected one — purge must cover the whole
window, not just our entry.

## Fix

**A. Shadow-offset bisection** (`MediabunnyTransmuxer.bisectSeekTarget`): bisect for
`seekTime − shadow` instead of `seekTime`, where `shadow = computeKeyframeShadowSeconds(
this.keyframeTimestamps)` = 2 × max consecutive harvested-keyframe gap, clamped [12s, 35s];
default 15s when < 2 keyframes harvested. Optional `forceShadowSeconds` param overrides (belt).
The injected entry then sits behind the last pre-target keyframe, so the forward walk crosses it.

**B. Preemptive shadow purge** (same function, BEFORE the near-entry short-circuit):
`removeMkvClusterPositionsInRange(videoTrack, shadowedTicks, targetTicks)` — evicts every cache
entry in `(shadowedTicks, targetTicks]` (injected AND organic; walk re-inserts them). Without
this, a stale entry inside the shadow wins the closest-≤-target race no matter what we inject.
Near-entry short-circuit then checks around the SHADOWED target
(`findClusterCacheEntryNear(videoTrack, shadowedTicks, windowTicks)`).

**C. One-retry belt** (`seekTo` raw path, inside the existing `if (!keyPacket)` handling, gated
`format==='mkv' && mkvCueIndex.length===0 && seekTime >= 1.0` and adaptive-shadow < max): re-run
`bisectSeekTarget(videoTrack, seekTime, currentGeneration, SEEK_SHADOW_MAX_S)` (its internal
purge now covers the full 35s window), abandon-check, one more
`getKeyPacket(seekTime, { verifyKeyPackets: true })`. Still null (GOP > 35s — pathological) →
existing warn + null → reroute unchanged. Belt trigger recomputes
`computeKeyframeShadowSeconds(this.keyframeTimestamps)` — deterministic (a failed walk resolves
no keyframe, so the harvest is unchanged); skip the retry when the first attempt already used
max shadow. NOTE on this Inception file the sparse harvest (0/20.812/31.24/41.625) gives
2×20.812→clamp 35s already — the belt exists for files whose adaptive shadow underestimates.

Non-goals this round: hover pipeline (same shadow bug exists in `_bisectAndInject` — user deferred
hover to next round; shared-engine internals untouched so hover behavior is byte-identical),
remux-tier green-bar mapping (incident 3 — only reachable after a reroute; primary fix removes
the reroute).

## Touch points (grep anchors — no line numbers)

1. `app/src/lib/faststream/utils/MkvClusterBisect.ts`
   - ADD consts `SEEK_SHADOW_DEFAULT_S / SEEK_SHADOW_MIN_S / SEEK_SHADOW_MAX_S` near
     `BISECT_WALKABLE_GAP_BYTES`.
   - ADD `export function computeKeyframeShadowSeconds(` after `readMkvClusterPositions`.
   - ADD `export function removeMkvClusterPositionsInRange(` (guarded reach-in, splice, returns
     count) after it.
2. `app/src/lib/faststream/players/MediabunnyTransmuxer.ts`
   - Import the three consts + two helpers (anchor: `} from '../utils/MkvClusterBisect';`).
   - `private async bisectSeekTarget(` — add `forceShadowSeconds?: number`; compute
     shadow/shadowedTicks; purge; near-entry at shadowedTicks (anchor:
     `findClusterCacheEntryNear(videoTrack, targetTicks, windowTicks)`); bisect
     `targetTicks:` → shadowedTicks (log gains `shadow=`); keep near-start guard
     (anchor: `if (targetTicks <= windowTicks) return;`).
   - `seekTo` belt: anchor `console.warn(\`[Transmuxer] No keyframe found at or before` — insert
     retry BEFORE it (restructure the `if (!keyPacket)` block).
3. `app/src/__tests__/MkvClusterBisect.test.ts` — new describes (see tests).

## Tests (TDD — write first, must fail)

- `computeKeyframeShadowSeconds`: `[]`→15, `[10]`→15, `[0,20.812,31.24,41.625]`→35 (2×20.812
  clamped), `[0,5,10,15]`→12 (clamp min), `[0,10.4,20.8]`→20.8 (≈, float).
- `removeMkvClusterPositionsInRange`: removes `(from, to]` (from exclusive, to inclusive —
  boundary entries asserted), returns count, preserves order/outside entries, 0 on missing/non-
  array cache.
- Integration: cache `[100000, 147773, 149100]`, purge `(114464, 149464]` → 2 removed, 100000
  kept; `findClusterCacheEntryNear(track, 114464, 35000)` → 100000 entry.

## Edge-case matrix

| Case | Behavior |
|---|---|
| Index-path seeks (refills, snapped user seeks) | Untouched — bisect only runs in the no-index else-branch |
| Prime seek 0 / target ≤ 35s | Near-start guard returns before shadow logic (unchanged) |
| Re-seek same spot after success | Purge drops (shadowed, target] organics; near-entry ≤ shadowed hit → no probes; walk re-covers ≤ 70s of cached data |
| Adaptive shadow underestimates GOP | Belt forces 35s once; GOP > 35s → reroute (as today, documented) |
| Supersession mid-bisect/mid-retry | Existing `shouldAbandonResolvedSeek` checks after each await |
| Audio-switch rebuild (raw path) | Same shadow fix applies — removes its G2 null source too |
| Hover pipeline | Byte-identical behavior (no shared-engine semantics changed) |
| tsconfig noUnusedLocals | New imports all used in same edit; helpers exported + tested |

## Gates

`npx tsc --noEmit` = 0 → full `npx vitest run` green → commit → hermes-verify re-attest → delete
7-c.md/7-t.md.
