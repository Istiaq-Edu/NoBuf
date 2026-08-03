# Round-8 fix plan — audio-switch E3 conflation + shadow-estimator saturation

Forensics: reports/research/round8-log-forensics.md. Round-7 shadow fix CONFIRMED (2 far seeks,
0 reroutes). This round fixes the two defects found in 8-x; the I2 optimization (cluster
registry) is presented to the user as a go/no-go with tradeoffs — NOT implemented here.

## Fix 1 (I1): audio-switch E3 guard conflates refills with seeks

`switchAudioTrack` rejects on `isColdStartBuffering || bufferingForSeekRef.current` — but
REFILLS set `bufferingForSeekRef` around their whole seekTo (segment routing), and on cue-less
MKV post-far-seek each refill holds it 3-5s while chaining near-immediately → the flag is up
most of wall time → switches silently rejected + dropdown reverts (8-c:412, 15:22:44 mid-refill
iteration 5030ms). A switch during a refill is structurally identical to a user seek during a
refill — proven safe 3× in this very log (seekGen bump + stopStreamingChain condemn the refill;
its stale-generation guards skip every ref write — rounds 1-3 machinery).

**Change** (grep anchor `switch rejected: cold start / seek in progress (E3)`): replace the
condition with a pure, tested helper:

```ts
// AudioSwitchGuard (pure): block only genuinely unsafe windows —
//  cold start, a USER seek in flight, or non-refill buffering (initial prime,
//  MP4 seek paths). A refill holding bufferingForSeek does NOT block: the
//  rebuild condemns it exactly like a user seek does (stale-gen guards).
export function shouldRejectAudioSwitch(
  isColdStart: boolean, userSeekInFlight: boolean,
  bufferingForSeek: boolean, refillInProgress: boolean,
): string | null   // reject reason, or null = allow
```

Call: `shouldRejectAudioSwitch(isColdStartBuffering, transmuxerSeekInProgressRef.current,
bufferingForSeekRef.current, refillInProgressRef.current)`. Semantics: cold start → 'cold
start'; userSeekInFlight → 'user seek in progress'; bufferingForSeek && !refillInProgress →
'buffer priming'; else allow. `transmuxerSeekInProgressRef` is set/cleared only by the user-seek
execute paths (:9265/:9497/:9507/:9530) — never by refills (verified; the :1759 "DEPRECATED"
comment is stale, usage is live in the mkv seek path).

Ordering note (verified): refills set `refillInProgressRef=true` (:2709) BEFORE
`bufferingForSeekRef=true` (:2797) and clear in the reverse order (:2820 → finally :3035+), so
there is no window where refill-owned bufferingForSeek is observable with refillInProgress
false. E4 single-flight still guards the switch's own rebuild window.

## Fix 2 (I3): keyframe-shadow estimator saturates after any far seek

`computeKeyframeShadowSeconds` uses 2× the MAX consecutive harvested gap. Far seeks insert jump
gaps into the harvest (…155.6s → 3317.94s = 3162s), so after ANY far seek every file computes
shadow=35s forever — the estimator measures seek jumps, not GOPs. Wrong on short-GOP files
(needless 35s walks ≈ 6-10MB per seek); right on this file only by accident.

**Change** (in `computeKeyframeShadowSeconds`): ignore gaps > `SEEK_SHADOW_GAP_EVIDENCE_MAX_S =
60` (a real GOP is bounded by the 35s cluster-span cap; 60s+ gaps are seek artifacts). If no
gap survives the filter → `SEEK_SHADOW_DEFAULT_S`. Belt (round-7) unchanged — it already covers
an underestimating shadow.

## Touch points (grep anchors)

1. `app/src/lib/faststream/utils/MkvClusterBisect.ts`
   - const `SEEK_SHADOW_GAP_EVIDENCE_MAX_S` near the other SEEK_SHADOW consts.
   - gap filter inside the `for` loop of `computeKeyframeShadowSeconds` + doc line.
2. `app/src/hooks/useMSEPlayer.ts`
   - ADD exported pure `shouldRejectAudioSwitch` next to the other exported pure helpers
     (anchor: `export function clampSeekTime`).
   - REPLACE the E3 condition in `switchAudioTrack` (anchor above) with the helper call; log
     the returned reason.
3. Tests: `app/src/__tests__/MkvClusterBisect.test.ts` (extend shadow describe);
   NEW `app/src/__tests__/AudioSwitchGuard.test.ts` (tauri mock pattern from
   RefillBackoff.test.ts).

## Tests (TDD — fail first)

- shadow gap filter: `[0, 20.812, 31.24, 41.625, 3317.94]` → 35 (jump excluded, 20.812 kept);
  `[0, 5, 10, 15, 3000]` → 12 (was 35 — the saturation bug pinned); `[0, 3000]` → 15 (no
  evidence survives); `[0, 50]` → 35 (50s gap ≤ 60 kept as evidence, 2×50 clamps).
- shouldRejectAudioSwitch: cold start → reason; user seek → reason; refill-owned buffering
  (buffering=true, refill=true) → **null** (the 8-c:412 case); prime (buffering=true,
  refill=false) → reason; idle → null; user seek during refill → reason.

## Edge-case matrix

| Case | Behavior |
|---|---|
| Switch mid-refill (8-c:412) | ALLOWED — rebuild condemns refill (rounds 1-3 stale-gen guards, log-proven for seeks) |
| Switch during user seek | rejected (as today) |
| Switch during cold start / initial prime | rejected (as today) |
| Switch while another switch in flight | rejected by E4 (unchanged) |
| MP4/remux tiers | unchanged semantics — their seek paths set bufferingForSeek without refillInProgress → 'buffer priming' blocks as today |
| Shadow on this file post-far-seek | 35s (unchanged: 0→20.812 artifact gap survives → clamp) |
| Shadow on 5s-GOP file post-far-seek | 12s (was 35s — fixed) |
| GOP > 35s pathological | unchanged (belt → reroute, documented bound) |

## NOT this round (user go/no-go): I2 cluster-discovery registry

Hover and playback pipelines each bisect their own demuxer cache; discoveries don't cross.
Design sketch (for the decision): module-level registry in MkvClusterBisect.ts keyed by base
stream URL (immutable file content → entries never stale), engine publishes validated clusters,
both pipelines consult before bisecting; seek reuse behind `target − shadow/2` with the belt as
safety net; hover consumes seek discoveries symmetrically. Expected: hover→click far seek
~9.4s → ~3-4s; repeat-region seeks skip re-probing. Cost: ~120 LOC + module state + tests.

## Gates

tsc 0 → vitest green → commit → hermes-verify → delete 8-c.md/8-t.md.
