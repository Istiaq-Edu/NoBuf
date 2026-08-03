# Round-3 verification A — audio-switch stutter fixes (H-A1a–d, H-A2a–c)

Verified 2026-08-03 against branch `Embedded-subtitle-extraction`, live tree.
Files: `app/src/hooks/useMSEPlayer.ts` (10150 lines), `app/src/lib/faststream/players/MediabunnyTransmuxer.ts` (1980 lines), `app/src/lib/faststream/players/SourceBufferWrapper.ts` (364 lines). All line numbers are CURRENT (no drift from the round-3 brief).

---

## H-A1a — resetForSeek is SB-local; safe to call after transmux — VERIFIED

`SourceBufferWrapper.resetForSeek()` (SourceBufferWrapper.ts:282-302) + `_removeAllAndFinish` (:304-328):

```ts
resetForSeek(): Promise<void> {
    ...
    // Clear pending operations
    this.queue = [];            // :292 — wrapper's OWN append/remove queue only
    this.processing = false;    // :293
    if (this.sourceBuffer.updating) {
      this.sourceBuffer.addEventListener('updateend', () => this._removeAllAndFinish(resolve), { once: true });
      try { this.sourceBuffer.abort(); } catch (_) {}   // :297
    } else { this._removeAllAndFinish(resolve); }       // :299 — remove(start(0), end(len-1))
```

- **Does NOT touch `seekBufferRef`** — that is a React ref in useMSEPlayer.ts:1817; the wrapper has no reference to any player state. Segments pending in `seekBufferRef` after a completed transmux survive a subsequent `resetForSeek()` intact; they only enter the wrapper queue via the append loop at useMSEPlayer.ts:6403-6405.
- **Does NOT touch transmuxer state** — the wrapper imports nothing from the transmuxer; grep for `SourceBuffer` in MediabunnyTransmuxer.ts hits comments only (:3, :9, :142, :291, :466) — the transmuxer emits via callbacks, never reads SB state.
- **timestampOffset**: untouched. Doc comment :280-281: "Does NOT set timestampOffset because mp4box produces absolute timestamps." The old offset persists through the flush; the switch path re-sets it at :6400.
- **Pending appendBuffer queue**: DISCARDED (`this.queue = []` :292) + `abort()` on in-flight op (:297). In the proposed reorder the appends happen after resetForSeek, so nothing of the new track is lost; anything of the OLD track still queued is intentionally dropped.

## H-A1b — changeType wrapper guards `updating`; current order is flush→changeType→append — VERIFIED

`changeType()` (SourceBufferWrapper.ts:257-278):

```ts
changeType(mimeType: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.fatalError) { resolve(); return; }
      const apply = () => { try { this.sourceBuffer.changeType(mimeType); resolve(); } catch (e) { reject(e); } };
      const whenIdle = () => {
        if (this.fatalError) { resolve(); return; }
        if (this.queue.length === 0 && !this.processing && !this.sourceBuffer.updating) { apply(); }  // :270
        else { this.sourceBuffer.addEventListener('updateend', () => setTimeout(whenIdle, 0), { once: true }); }
      };
      whenIdle();
    });
}
```

- Preconditions: waits for wrapper queue empty + `!processing` + `!sourceBuffer.updating` (:270). Doc comment :255-256: "Waits for idle (changeType throws InvalidStateError while updating)."
- **No buffered-ranges check** — consistent with the MSE spec (changeType legal regardless of buffered data as long as not updating). So calling it with data still buffered (as the reorder implies during failure paths) is wrapper-supported.
- Current caller order (useMSEPlayer.ts): `resetForSeek()` :6360 → `changeType(newMime)` :6363 (only when `plan === 'rebuild-changetype'` :6361) → `seekTo` :6376 → `setTimestampOffset` :6400 → append loop :6403-6405. Confirmed flush→changeType→(transmux)→append today.

## H-A1c — ordering dependencies for the reorder — VERIFIED (constraints enumerated)

Everything between `stopStreamingChain()` (:6354) and `startStreamingChain()` (:6407):

| Line | Op | Reorder constraint |
|---|---|---|
| :6353 | `seekGen = ++transmuxerSeekGenRef.current` | **MUST stay before seekTo** — the supersession check (:6381) compares this captured gen after the await; capturing late would miss a user seek issued during the transmux. |
| :6354 | `stopStreamingChain()` | **MUST stay before seekTo.** It bumps `streamingChainGenRef`, sets `refillInProgressRef=false`, and calls `transmuxer.abortSeek()` (:2687) which sets `seekAbortFlag=true` (MediabunnyTransmuxer.ts:1837-1838). If it ran after seekTo it would condemn the switch's own iteration. seekTo clears the flag on entry (:1305→:1357). |
| :6355-6357 | `refillInProgressRef=false`, `nullRefillCountRef=0`, `burstBufferRef=[]` | Free — no seekTo interaction. (`burstBufferRef` is deprecated mux.js-only, :1824.) |
| :6358-6359 | `bufferingForSeekRef=true`, `seekBufferRef=[]` | **MUST stay before seekTo** — segment routing into `seekBufferRef` depends on the flag inside `onInitSegment`/`onMediaSegment` (:7081, :7091). |
| :6360 | `await sbVideo.resetForSeek()` | **MOVES after seekTo** — and should move after the supersession (:6381) AND null-keyframe (:6386) checks, so a superseded/failed switch never flushes (see H-A1d). |
| :6361-6371 | `changeType` block | **MOVES with resetForSeek**, and MUST stay before the append loop: changeType's `whenIdle` waits for queue-empty, and the new track's init segment would append-error against the old mime (:251-256). |
| :6375-6379 | `stopTime` + `await transmuxer.seekTo(...)` | Moves to the front (after :6359). **seekTo reads NO SB state** — MediabunnyTransmuxer.ts:1301-1640 touches only streamSource/input/sinks/output; zero SourceBuffer references. |
| :6380 | `bufferingForSeekRef=false` | Stays immediately after seekTo (same as today). |
| :6381-6385 | supersession check + `seekBufferRef=[]` | **MUST stay immediately after seekTo**, and now gains value: bail BEFORE the (moved) flush → old buffer intact. |
| :6386-6397 | null-keyframe escalation | Stays after supersession check; now runs before any flush (H-A1d bonus). |
| :6399 | `seekOffsetRef.current = keyframeTimestamp` | Stays before appends — refills (:2798 via buffered-end math) and the non-buffering append progress path (:7105) read it. `resetForSeek` does NOT read it (wrapper has no player refs). |
| :6400 | `await sbVideo.setTimestampOffset(...)` | **MUST precede the append loop.** The wrapper applies the offset only when the queue has drained (Fix #4, SourceBufferWrapper.ts:232-247); appending first would land the new segments under the OLD offset. Comment :7079-7080 documents the same invariant for seek. |
| :6401-6405 | flush `seekBufferRef` → `appendBuffer` | Stays last before chain start. |
| :6407 | `startStreamingChain()` | Stays last. |

Hidden-dependency sweep: seekTo internally calls `abortInFlight()`/`resetSupersession()` on the stream source and cancels the prior conversion (MediabunnyTransmuxer.ts:1305-1334) — transmuxer/source-side only, no SB coupling. `mkvSbHasAudioRef` is read only at :6323 (before this region) and written at init/cleanup (:7253, :2406, :2525). No step between :6354 and :6407 reads SB.buffered.

**Proposed order is feasible**: :6353-6359 unchanged → seekTo (:6375-6379) → :6380 → supersession (:6381) → null check (:6386) → `resetForSeek` → `changeType` → :6399 → :6400 → append loop → `startStreamingChain`.

## H-A1d — flush is on the happy path only; escalation currently runs post-flush — VERIFIED (with one caveat)

- `reroute-remux` (:6325-6345) returns at :6344; `reject` (:6346-6350) returns at :6349 — **both before the :6360 flush**. Never flush.
- Null-keyframe escalation (:6386-6397) runs **after** the flush today; the code says so itself (:6388-6390): *"A bare revert leaves a DEAD player: the SB was flushed (resetForSeek above) and the chain stopped"*. It escalates via `recoverMkvRerouteRef` (:6396). Reorder bonus confirmed: with seekTo first, a null resolution escalates with the old buffer still intact and playing.
- **Caveat — changeType failure (:6365-6370)**: this path ALSO runs after the flush today, and unlike the null path it does NOT escalate — it sets `bufferingForSeekRef=false`, reverts the track, `return false` → flushed SB + stopped chain + nothing restarts (pre-existing latent dead-player). The reorder as proposed (flush→changeType still adjacent, both after seekTo) does NOT fix this path — changeType failure would still strike post-flush. Plan should either escalate on changeType failure like :6394-6396 or attempt changeType pre-flush (MSE-legal per H-A1b).
- `recoverMkvRerouteRef` → `_recoverMkvToRemuxTier` (:4776-4844) assumes nothing about SB buffered state: captures `resumeT = video.currentTime` (:4786) BEFORE teardown, then `videoSourceBuffer?.destroy()` (:4810, → `abort()`, SourceBufferWrapper.ts:361-363), nulls refs, detaches the blob. An un-flushed SB at reroute time is harmless (arguably better — currentTime capture sits on live data).

## H-A2a — switch and refill share the same helpers; seekTo's cue-less resolution reads the harvested index — VERIFIED

- Switch stopTime :6375 `transmuxer.nextKeyframeAtOrAfter?.(t + SEEK_START_DURATION)`; refill :2770 `transmuxer.snapToCueKeyframe(rawRefillPosition)` and :2785 `transmuxer.nextKeyframeAtOrAfter(refillPosition + REFILL_CHUNK_DURATION) ?? Infinity`. Same two methods (MediabunnyTransmuxer.ts:257-266, :302-320) on the same instance — a harvested fallback inside them serves both automatically. Note it ALSO serves the initial prime (:7334) and the user-seek path (:9329) — same methods, so cue-less user seeks/primes gain finite stopTimes too (cue-indexed MKV unaffected: `mkvCueIndex.length !== 0` short-circuits before any fallback).
- seekTo cue-less resolution (MediabunnyTransmuxer.ts:1428-1462): MKV tries `nearestCueKeyframeAtOrBefore(seekTime)` (:1440, cue index); when null (cue-less) falls to `cachedKeyframeTs = this.findNearestKeyframe(seekTime)` (:1442-1443), which reads `keyframeTimestamps` (:853-856). Hit → `useCachedIndex = true` (:1445) → `getKeyPacket(seekTargetTs, { verifyKeyPackets: false })` (:1461) with the `usedIndex=true` log (:1482). That is the round-1 harvested path, confirmed live.

## H-A2b (load-bearing) — keyframeTimestamps IS maintained sorted + deduped — VERIFIED

Every write site in MediabunnyTransmuxer.ts:

| Line | Write | Sorted? |
|---|---|---|
| :708 | `this.keyframeTimestamps = result.keyframes.map(kf => kf.timestamp)` — TS byte-offset scanner (whole-array assign) | Yes — scanner emits in byte order = ascending PTS (range log :727 prints first..last). |
| :784 | `this.keyframeTimestamps = timestamps` — mediabunny metadataOnly scan; built by `getFirstKeyPacket` → `getNextKeyPacket` loop (:775-782) | Yes — appended in forward-iteration order. |
| :818 | `ts.splice(lo, 0, timestamp)` inside `addKeyframeTimestamp` (:798-820) | **Sorted insert**: binary search for insertion point (:804-812), neighbor-dedup within 0.01s (:816-817), `splice(lo, 0, ...)`. Gated by `if (this.keyframeIndexBuilt) return` (:799). |
| :1960 | `this.keyframeTimestamps = []` — dispose | n/a |

`addKeyframeTimestamp` callers: :1517 (each seek's resolved keyframe) and :1678 (cue-less MKV harvest, gate at :1667-1669: `format==='mkv' && !keyframeIndexBuilt && mkvCueIndex.length===0`). **Backward seeks after playing ahead insert in-place at the binary-search position — order is preserved.** The proposed fallback's binary search is valid as-is; no sort-on-read needed. (`findNearestKeyframe` :857-866 and the harvest watermark logic :883-885 already binary-search the same array on the same assumption.)

## H-A2c — TS regression impossible in live wiring — VERIFIED (no regression)

- Yes, `keyframeTimestamps` is populated for TS inside the class (:708 scanner; :784 fallback scan) — **but the class never runs for TS in the live player.**
- The ONLY `new MediabunnyTransmuxer` site is useMSEPlayer.ts:7066 inside `_initMkvTransmuxerPlayer`, with `format: 'mkv'` hardcoded (:7067). Reached only from the MKV-avc branch of the format dispatcher (:3392-3399: "mkv (avc) — using client-side MediabunnyTransmuxer").
- TS routing: dispatcher `format === 'ts'` branch (:3262) → `initTransmuxerPlayer(url, ...)` (:3368) → :7406-7421: guards `format !== 'ts'` → native, else `_initMpegtsPlayer` — **mpegts.js**, which owns its own MediaSource/SourceBuffers and never enters the refill chain. `startStreamingChain()` call sites are all MKV-tier: :6407 (switch), :7374 (MKV init prime), :9444 (MKV user seek). Therefore **only MKV(avc) reaches :2770/:2785** with this transmuxer.
- `MuxJsTsTransmuxer` appears in the ref union type (:1775) but has **no instantiation site** in live code (grep: import + type only); its own stubs return `null`/identity anyway (MuxJsTsTransmuxer.ts:829, :832). The `[MSE-TS-FMP4]` seek path (:9055 region) is a backend-fmp4 byte-offset fetcher that never calls `nextKeyframeAtOrAfter`.
- Stale-comment warning: FastStreamPlayer.tsx:251-258 claims "TS files now use the MSE transmuxer (MediabunnyTransmuxer)" — contradicted by :7406-7421. Do not trust that comment when reasoning about routing.
- Residual (theoretical): if MediabunnyTransmuxer were ever wired for TS, `mkvCueIndex` stays empty and `keyframeTimestamps` is fully populated → the fallback would activate there. The proposed `REFILL_MAX_DURATION_CAP` clamp (cap = 25, :2662) mitigates; a `format === 'mkv'` guard in the fallback would eliminate it. Today: no path.

---

## Current line anchors (live tree, 2026-08-03)

| Landmark | File:Line |
|---|---|
| `_switchMkvAudioTrack` body | useMSEPlayer.ts:6284-6410 |
| plan dispatch: reroute-remux / reject | :6325-6345 / :6346-6350 |
| seekGen capture / stopStreamingChain | :6353 / :6354 |
| state resets (refill/null/burst/bufSeek/seekBuf) | :6355-6359 |
| resetForSeek (switch) | :6360 |
| changeType call / failure path | :6363 / :6365-6370 |
| switch stopTime / seekTo | :6375 / :6376-6379 |
| bufferingForSeek=false / supersession check | :6380 / :6381-6385 |
| null-keyframe escalation | :6386-6397 |
| seekOffset commit / setTimestampOffset / append loop | :6399 / :6400 / :6401-6405 |
| startStreamingChain (switch) | :6407 |
| refill: snapToCueKeyframe / stopTime / seekTo | :2770 / :2785 / :2798 |
| initial prime stopTime / user-seek stopTime | :7334 / :9329 |
| stopStreamingChain impl (abortSeek) | :2682-2689 |
| `_recoverMkvToRemuxTier` | :4776-4844 |
| MKV→Mediabunny routing / only instantiation | :3392-3399 / :7066-7067 |
| TS→mpegts.js routing | :3262, :3368, :7406-7421 |
| `nextKeyframeAtOrAfter` / `snapToCueKeyframe` | MediabunnyTransmuxer.ts:257-266 / :302-320 |
| `nearestCueKeyframeAtOrBefore` / `findNearestKeyframe` | :275-286 / :853-895 |
| `addKeyframeTimestamp` (sorted insert) | :798-820 |
| keyframeTimestamps writes | :708, :784, :818, :1960 |
| harvest gate / harvest insert | :1667-1669 / :1677-1680 |
| seekTo cue-less resolution (usedIndex path) | :1428-1462 |
| seekTo entry (abort/gen/reuse-Input) | :1301-1363 |
| `resetForSeek` / `_removeAllAndFinish` | SourceBufferWrapper.ts:282-302 / :304-328 |
| `changeType` wrapper | SourceBufferWrapper.ts:257-278 |
| `setTimestampOffset` (drain-then-apply) | SourceBufferWrapper.ts:214-249 |
