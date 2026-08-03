# Round-3 self-verification (parent session, parallel with deleg_31e0877c)

## H-A2b — keyframeTimestamps sorted+deduped: VERIFIED
`addKeyframeTimestamp` (MediabunnyTransmuxer.ts:798-820): binary-search insertion point,
neighbor-dedup at 0.01s tolerance, `ts.splice(lo, 0, timestamp)` — **sorted insertion by
construction**, any arrival order. Bulk assigns :708 (TS scanner) and :784 (mediabunny full
scan) are sequential-walk results — sorted by construction. ⇒ the harvested fallback in
`nextKeyframeAtOrAfter`/`snapToCueKeyframe` can binary-search `keyframeTimestamps` safely.
Bonus confirmation: `noteIterated` doc comment (:822-831) explicitly states "Consecutive
refill windows OVERLAP by construction on cue-less files (the next window re-resolves the
PRIOR keyframe behind the mid-GOP maxDuration cut)" — the Issue-A2 mechanism is already
documented in the harvest code as a known geometry.

## H-A1a — resetForSeek safe after transmux: VERIFIED
`resetForSeek()` (SourceBufferWrapper.ts:282-302): touches ONLY wrapper-internal state —
`this.queue = []`, `this.processing = false`, `sourceBuffer.abort()` if updating, then
remove-all via `_removeAllAndFinish` (:304+). It never reads or writes `seekBufferRef`,
transmuxer state, or `timestampOffset` ("Does NOT set timestampOffset", :281). ⇒ reordering
to seekTo-first leaves resetForSeek semantics unchanged; segments parked in seekBufferRef
survive. Wrapper queue-clear is safe at that point (chain already stopped).

## B3-frontend — no abort wiring: VERIFIED
`fetchEmbeddedSubText` (useMSEPlayer.ts:6146+): plain `fetch(endpoint)`, **no AbortController,
no signal** (the AbortController hits at :1705/:5065/:8564 belong to other fetch paths).
Caller `toggleEmbeddedSub` (FastStreamPlayer.tsx:1516-1553): generation guard
`embeddedSubFileGenRef` DISCARDS a stale result but never cancels the request; nothing ties
the fetch to player teardown. ⇒ H-B3 frontend half confirmed; server half (actix drop →
kill_on_drop) with subagent V-B.

## Constants (for plan)
REFILL_CHUNK_DURATION=5 (useMSEPlayer.ts:2635), SEEK_START_DURATION=8 (:2654),
REFILL_MAX_DURATION_CAP=25 (:2662).
