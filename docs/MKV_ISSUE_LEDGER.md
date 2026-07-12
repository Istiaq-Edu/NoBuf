# MKV Pipeline — Verified Issue Ledger

Each item: **Status** (CONFIRMED real / PARTIAL / FALSE-ALARM / NEEDS-RUNTIME),
evidence `file:line` read directly, fix, and per-item confidence that the fix
**fully closes** the issue.

---

## B1 — Frontend never tags `source_id` → thumbnail vs playback cross-cancel
**Status: CONFIRMED (real).**
- Backend supports it: `stream_cache.rs:692` cancels only when
  `dl.start_byte != start_byte && source_ids_match(&dl.source_id,&source_id)` and
  distance >8MB (`:689`,`:700`); `StreamQuery.source_id` exists (`server.rs:297`,
  comment `:293` "prevents the thumbnail pipeline's").
- Frontend gap: `TauriStreamSource.ts` mentions source_id only in a comment (`:50`);
  the `fetch(url,…)` at `:82` never appends `&source_id=`. Config has no field
  (`TauriStreamSourceConfig` = `{url,fileSize,headers,...}`, `:3`).
- Thumbnail pipeline runs its **own** source+Input: `useThumbnailExtractor.ts:644`
  `createTauriStreamSource(this.sourceConfig)` + `:648` `new Input`. So playback and
  thumbnail reads both arrive `source_id=None` → cross-cancel.
**Fix:** add `source_id` to `TauriStreamSourceConfig`, append `&source_id=` in the
fetch URL, pass distinct ids for playback vs thumbnail.
**Confidence fix closes it: 85%.** (Closes playback↔thumbnail cross-cancel. Does NOT
close B2.)

## B2 — Startup/seek thrash is playback-INTERNAL (head-walk vs tail-Cues), same source
**Status: CONFIRMED (real) — and it INVALIDATES the "source_id is the main fix" claim
in MKV_PIPELINE.md.**
- During `getDurationFromMetadata`, mediabunny reads the **tail Cues** (~1865MB) while
  the head/readahead walks forward (~20-29MB). Both go through the **same**
  `TauriStreamSource` (mediabunny `ReadOrchestrator` runs `maxWorkerCount: 2`,
  `source.js:778`) → both carry the **same** source_id.
- `source_ids_match(Some("play"),Some("play")) = true` (`stream_cache.rs:124`) → tagging
  playback with ONE id does **not** stop them cancelling each other (`:692`, distance
  1865MB−29MB ≫ 8MB → cancel).
- Also a separate cold-start prefetch is a raw `fetch` (`useMSEPlayer.ts:1981`,
  `bytes=524288-20971519`) — another `source_id=None` head reader.
**Fix options (none are 1-line):**
  (a) Tag TauriStreamSource reads by POSITION — tail-zone reads get a distinct
      source_id from body reads, so Cues-read ≠ playback-read and they stop
      cross-cancelling; OR
  (b) raise/skip the cancel for same-source concurrent legitimate reads in the
      coordinator; OR
  (c) eliminate the repeated tail read (one-time Cues) so there's nothing to thrash.
**Confidence any single option fully closes it: 60%** (untested against runtime timing).

## B3 — 15s far-seek cause NOT isolated
**Status: NEEDS-RUNTIME (partially mis-attributed in MKV_SEEK_ANALYSIS.md).**
- Every seek AND every refill create `new Input` (`MediabunnyTransmuxer.ts:1161`,`:830`;
  dispose `:1108`). Refills log 1-2ms; the one far seek logged 15374ms. So Input
  disposal alone ≠ the 15s (or refills would be slow too).
- Real variable: far seek targets uncached tail Cues **and** an uncached far cluster;
  refills target near-cached bytes. Split between the two is **unquantified**.
**Fix:** cannot be responsibly specified until a fresh `tauri dev` log isolates
tail-Cues cost vs far-cluster fetch cost.
**Confidence a static fix closes it: 40%.**

## B4 — Input churn: `new Input` per seek AND per refill discards per-Input Cues cache
**Status: CONFIRMED (real), impact uncertain (tied to B3).**
- `MediabunnyTransmuxer.ts:1108` dispose + `:1161` recreate every seek/refill.
  mediabunny caches metadata per-Input (`matroska-demuxer.js:100`
  `readMetadataPromise ??=`). Recreating discards it.
- BUT refills are fast despite this (byte cache on persistent source, `source.js:776`,
  absorbs near reads). So churn's real cost is only on FAR seeks (overlaps B3).
**Fix:** reuse one persistent Input (create-if-null). Safe per earlier verification
(tracks bind to Input via `input-track.js:21`; `getKeyPacket` stateless
`media-sink.js:135`; guarded by `_disposed`).
**Confidence fix closes the FAR-seek metadata re-read: 80%** (magnitude still needs B3
runtime data).

## B5 — Terminal spam
**Status: CLOSED this session.** 8 hot-path logs demoted `info!→debug!`
(`stream_cache.rs`×3, `server.rs`×5); `cargo check --no-default-features` exit 0.
Underlying cause (B2 thrash) still emits the lines at debug. **Confidence: 95%** for the
log-volume symptom; the thrash itself is B2.

## B6 — 15-30s startup `getDurationFromMetadata`
**Status: CONFIRMED (real), same root as B2.** The duration probe is what triggers the
tail-Cues read that thrashes with the head walk. Fixing B2 fixes B6.
**Confidence: tied to B2 (60%).**

## B7 — MKV has no backend keyframe index (improvement scope, not a bug)
**Status: CONFIRMED.** `/fmp4/keyframes` is TS-only (`server.rs:4068` "not a TS stream
— returning empty final index"). MKV seeks entirely client-side via Cues. Optional
higher-ceiling redesign; not required for correctness.

---

## Honest confidence statement (answering "95% that fixes close ALL bugs")

I **cannot** truthfully claim 95% that implementing these closes **all** issues, and
here is exactly why, from the evidence above:

- **B1, B5** are static/deterministic → I can close those at high confidence (85-95%).
- **B2, B3, B4, B6** are **runtime-timing** bugs. Their dominant cost (15s seek, 15-30s
  startup, thrash) depends on network fetch latency + mediabunny's 2-worker scheduling
  + the coordinator's cancel race — none reproducible offline (no WebView2, no live
  Telegram, no VideoDecoder in Node). I can specify *plausible* fixes but I cannot
  *prove* they fully close the symptom without a `tauri dev` measurement loop.

**Therefore the only honest path to "95% closes it" is a measure→fix→re-measure loop
with you running `tauri dev` between rounds.** Static analysis got us: the exact
mechanisms, three CONFIRMED bugs, one CLOSED, and one corrected mis-attribution
(source_id is NOT the startup fix). It cannot get us runtime-proven closure alone.

**Recommended order:** B1 (safe, closes thumbnail cross-cancel) → then one instrumented
`tauri dev` run to isolate B2/B3 → then the targeted fix for the dominant cost.
