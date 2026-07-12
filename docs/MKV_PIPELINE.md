# MKV Playback Pipeline — Full Traced Reference (init → end + all features)

**Standard:** every claim cites `file:line` read directly. Anything not verified by
reading is marked **UNVERIFIED**. Line numbers are as of this trace; they drift as the
file changes (re-grep to confirm before editing).

**Files:** `app/src/hooks/useMSEPlayer.ts` (~6600 lines, CRLF),
`app/src/lib/faststream/players/MediabunnyTransmuxer.ts`,
`app/src/lib/faststream/utils/TauriStreamSource.ts`,
`app/src/hooks/useThumbnailExtractor.ts`,
`app/src-tauri/src/server.rs`, `app/src-tauri/src/stream_cache.rs`,
mediabunny at `app/node_modules/mediabunny/dist/modules/src/…`.

---

## Stage 1 — Initialization / Bootstrap

1. **MSE init entry.** `useMSEPlayer.ts:1227` logs `Initializing MSE player`; a
   `new MediaSource()` is created at `:1230`; `sourceopen` is registered once at
   `:1261` (`mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true })`).
2. **Format detection.** On sourceopen, `detectFormat(data, file?.name)` runs at
   `:1956`; the dynamic cold-start threshold is computed right after (`:1961`, logged
   `:1969` `Dynamic cold-start threshold`).
3. **MKV prefetch.** `:1979` logs `${format}: fetching additional prefetch data
   (${data.byteLength} → ${TS_INITIAL_PREFETCH} bytes)` — the 524288→20971520 (20MB)
   header prefetch. This 20MB `data` buffer is reused as the transmuxer **seed**
   (comment `:2119` "`data` is the 20MB header prefetch, reused as the transmuxer seed").
4. **Codec routing** (`:2102-2152`):
   - `webm` → native `<video>` (`:2102-2105`, `setUseNative(true)`).
   - MKV codec detected via `detectMkvVideoCodec(data)` (`:2109`, helper at `:504`).
   - `avc` → **`_initMkvTransmuxerPlayer`** (`:2120-2122`); on failure falls through to
     `/remux` (`:2126`).
   - `hevc` **or** avc-fallback → ffmpeg **`/remux` → mpegts.js** (`:2132-2134`,
     builds `remuxUrl`). Same pipeline as the TS path.
   - (VP8/VP9/AV1 can't be `-c:v copy`'d to TS → native, per comment `:2100-2101`.)
5. **`_initMkvTransmuxerPlayer`** (`:4435`):
   - `new MediabunnyTransmuxer({…})` at `:4441`.
   - `onDurationKnown` callback at `:4486` (seeds byteToTime baseline — see Stage 3 §4).
   - **UNVERIFIED (exact ordering inside 4441-4630):** the precise sequence of
     `init()` → `getDurationFromMetadata` → SourceBuffer creation → initial
     `seekTo(0, INITIAL_SEEK_DURATION)` → `startStreamingChain()` was not line-read in
     this pass; constants `INITIAL_SEEK_DURATION = 15` (`:1555`) confirmed. Re-read
     `useMSEPlayer.ts:4435-4630` to lock the ordering before relying on it.

---

## Stage 2 — Streaming / Refill / Buffer Management

1. **Constants:** `MAX_BUFFER_BYTES = 20*1024*1024` (`:518`),
   `BUFFER_KEEP_BEHIND = 30` (`:519`), `REFILL_CHUNK_DURATION = 5` (`:1547`),
   `INITIAL_SEEK_DURATION = 15` (`:1555`), `REFILL_MAX_DURATION_CAP = 25` (`:1563`).
   Effective cap for public channels: `maxBufferBytes = isPublicChannel ? 80MB :
   MAX_BUFFER_BYTES` (`:732`).
2. **Chain entry:** `startStreamingChain` (`:1568`) calls `executeStreamingRefill`
   (`:1576`).
3. **Refill decision** (`executeStreamingRefill`, `:1600`):
   - Guards on `refillInProgressRef`, video/transmuxer/sb presence, `video.ended`,
     `sb.hasFatalError` (`:1601-1612`).
   - **Discontinuity mode**: `refillPosition = video.currentTime + ahead` where
     `ahead = getBufferedAheadSeconds()` (`:1625-1626`). Rationale in comment
     `:1614-1619` (continuation mode caused buffer shrink; discontinuity guarantees
     net-positive growth).
   - `maxDuration = Math.min(REFILL_CHUNK_DURATION + 12, REFILL_MAX_DURATION_CAP)`
     (`:1631`); `skipInit = true` for refills (`:1636`, comment `:1633-1635`).
   - Sets `bufferingForSeekRef.current = true`, `seekBufferRef.current = []` (`:1639-1640`).
   - Calls `transmuxer.seekTo(refillPosition, maxDuration, { skipInitSegment: skipInit })`
     (`:1644`). Comment `:1642-1643`: "seekTo creates a fresh Input with the persistent
     TauriStreamSource, guaranteeing a clean demuxer state."
   - Generation guard after await: `chainGeneration !== streamingChainGenRef.current`
     → bail (`:1652-1655`).
4. **Buffer-ahead pacing** (`:1822-1838`): if `ahead > MAX_BUFFER_AHEAD` → log
   `Buffer ahead … exceeds hard cap … sleeping 2000ms` (`:1822`) then re-check; else if
   below `REFILL_THRESHOLD_SECONDS` → chain immediately (`:1831`); else sleep `delay`
   (`:1833`). **UNVERIFIED:** exact values of `MAX_BUFFER_AHEAD`, `REFILL_THRESHOLD_SECONDS`,
   `delay` (not line-read this pass — grep in `useMSEPlayer.ts`).
5. **Eviction** (`evictOldBuffer`, `:1849`): removes buffered data older than
   `currentTime - BUFFER_KEEP_BEHIND` (`:1872`), only when over `maxBufferBytes`.
   **Behind-only** (comment `:1846`); no evict-ahead.
6. **Discontinuity refill log:** `:1770` `Discontinuity refill: keyframe=…, flushed N
   segments`.
7. **`onInitSegment` / `onMediaSegment` buffering vs non-buffering branches, append
   queue, `updateend`, backpressure, `resetForSeek`:** **UNVERIFIED in this pass** —
   located refs but did not line-read the callback bodies or `SourceBufferWrapper.ts`.
   Must read `SourceBufferWrapper.ts` + the `onMediaSegment` handler in
   `_initMkvTransmuxerPlayer` before relying on details.

---

## Stage 3 — Seek & Byte↔Time Calibration

1. **Seek dispatch.** `Transmuxer seek unbuffered` logged at
   `useMSEPlayer.ts:6213` (includes `debounce`, `format`, `seekInProgress`).
   `executeTransmuxerSeek` defined at `:6218`, invoked at `:6336`/`:6344`.
   In-progress flag read from `window.__nobuf_userSeekInProgress` (`:5929-5930`).
2. **`MediabunnyTransmuxer.seekTo` flow** (`MediabunnyTransmuxer.ts`):
   - `abortInFlight()` on the source (`:1093`), `seekGeneration++` (`:1096`).
   - **Input disposed** (`:1107-1110`) then **recreated** (`:1161`
     `new Input({ source: this.streamSource!, formats, initInput: this.initInputRef ?? undefined })`).
   - `getKeyPacket` via Cues; `findNearestKeyframe` partial-index tolerance = **12s**
     (see Stage 4 §2). setupOutput + `EncodedVideoPacketSource` produce fMP4
     (`:1248-1264`).
3. **mediabunny Cues caching** (decisive for cost):
   - Metadata parse memoised **per Input**: `matroska-demuxer.js:100`
     `readMetadata() { return this.readMetadataPromise ??= (async () => {…})(); }`.
   - Seek binary-searches cached cuePoints: `matroska-demuxer.js:1945`
     `binarySearchLessOrEqual(this.internalTrack.cuePoints, searchTimestamp, x => x.time)`.
   - Byte cache lives on the **Source** (persistent), not the Input:
     `source.js:776` orchestrator built in `CustomSource` ctor; LRU at `source.js:1350`,
     `insertIntoCache` at `:1565`; default `maxCacheSize` 8MB (`source.js:777`).
4. **Byte↔time calibration (green prebuffer bar):**
   - Table ref `byteToTimeTableRef` (`useMSEPlayer.ts:954`); `byteToTime` (`:1025`);
     `recordByteTimeAnchor` (`:1048`, has a monotonicity guard).
   - Post-seek anchor capture: `getLastSeekAnchor()` read at `:6287`, fed to
     `recordByteTimeAnchor(seekAnchor.byteOffset, seekAnchor.time)` at `:6288`.
   - `TauriStreamSource` captures the **cluster byte** (not the Cues-tail byte) via
     `markSeekResolved()` arming `captureNextReadStart` (see TauriStreamSource.ts;
     verified earlier this session).
   - Baseline seed `[[0,0],[fileLength,duration]]` in `onDurationKnown`
     (`useMSEPlayer.ts:4486`, MKV path — verified earlier this session).

### ⚠ Correction / open question on the 15s far-seek
- The 15.4s came from a **far** seek (`getKeyPacket took 15374ms`, prior log `9-c.md`,
  now deleted). But **refills also create a fresh Input** (`:1161`, `:833`) yet log
  **1-2ms**. Therefore "fresh Input → tail re-parse = 15s on *every* seek" is
  **incomplete**: it cannot be the whole cause, or refills would also be ~15s.
- Verified distinction the code supports: refills seek to `currentTime+ahead` (near
  cached playback bytes), whereas a far seek jumps ~1400s where **both** the tail Cues
  **and** the target cluster are **uncached** (8MB orchestrator cache can't hold a
  1.8GB-away tail during ~40s playback).
- **UNVERIFIED (needs a fresh runtime log):** the exact split between (a) tail Cues
  re-read vs (b) far cluster fetch in the 15s. Do NOT ship a fix claiming to remove the
  15s until a new `tauri dev` log isolates which dominates. The persistent-Input idea is
  still plausible but its magnitude is now unproven.

---

## Stage 4 — Features & Lifecycle (Thumbnails, EOF, Recovery, Teardown)

1. **Thumbnails.** `TransmuxerThumbnailPipeline` in `useThumbnailExtractor.ts:561`.
   Format-gated inputs `this.format === 'mkv' ? [MATROSKA] : …` (`:646`).
   `captureAtTime` at `:388`. Ready log `:698`. It imports mediabunny directly
   (`useThumbnailExtractor.ts:3` `import { Input, EncodedPacketSink, MATROSKA, … }`).
   - **Verified:** the backend explicitly anticipates the thumbnail pipeline as a
     *separate* download source — `server.rs:293` comment "downloads from the SAME
     source_id … prevents the thumbnail pipeline's" (see Stage 5 §3). So the thumbnail
     pipeline issues its **own** reads and, absent source_id tagging, competes with
     playback in the coordinator.
   - **UNVERIFIED:** whether the thumbnail pipeline creates its own `Input` (own reads)
     vs shares the transmuxer's — grep found the import + class but the Input-creation
     site was not line-read this pass. Read `useThumbnailExtractor.ts:630-700`.
2. **EOF detection.** `noProgress` detector lives in `MediabunnyTransmuxer.seekTo`;
   `findNearestKeyframe` partial-index tolerance was tightened **60s → 12s** to stop a
   sparse `[0.09s]` index collapsing every refill to the same keyframe (false EOF).
   **Verified earlier this session**; **UNVERIFIED line numbers** in this pass — grep
   `noProgress` / `findNearestKeyframe` in `MediabunnyTransmuxer.ts`.
3. **Error / stall recovery.** avc transmuxer init failure → `/remux` → mpegts.js
   fallback (`useMSEPlayer.ts:2124-2134`). **UNVERIFIED:** stall/quota-guard/retry
   specifics not line-read this pass.
4. **Pause/resume of the refill loop.** **UNVERIFIED this pass** — refill guards on
   `video.ended`/`hasFatalError` (`:1609`) but the pause-specific gating was not
   line-read. (MEMORY notes a pause-aware cache-forward window exists — confirm in code.)
5. **Teardown.** `stopStreamingChain` logs `Streaming chain stopped`
   (`useMSEPlayer.ts:912` region, per prior logs); `TauriStreamSource.dispose()` logs
   `disposed` (`TauriStreamSource.ts:307`). StrictMode double-mount handled via the
   `once:true` sourceopen + generation guards. **UNVERIFIED:** full teardown ordering
   not line-read this pass.

---

## Stage 5 — Backend Streaming & Download Coordinator

1. **Endpoint.** `#[get("/stream/{folder_id}/{message_id}")] async fn stream_media`
   (`server.rs:513-514`); HEAD variant `:489-490`. Range header parsed (`:565` invalid-
   range warn); `max_bytes` clamp logged `:579`.
2. **Prebuffer/cache flow.** Disk-cache HIT `:619` `[PREBUFFER] HIT … served from disk
   cache`; MISS `:645/:649`; `CACHED_ONLY` 503 at `:658`; coordinator subscribe `:685`;
   cache-poll `:895` `[PREBUFFER] CACHE-POLL`; cache-prefix `:940`; Telegram bootstrap
   fallback via `register_download(..., query.source_id.clone())` at `:1151`.
3. **Download coordinator** (`stream_cache.rs`):
   - `source_ids_match(a, b)` at `:124` — `(None,None)=>true`, `(Some,None)=>false`,
     `(Some,Some)=>a==b` (verified earlier this session).
   - `register_download(msg, start, end, is_continuation, initial_progress, source_id)`
     at `:665`.
   - Zombie cancel: `const CANCEL_DISTANCE_BYTES = 8*1024*1024` (`:689`); cancel fires
     at `:700-701` `Cancelling zombie download … (new request at … from {source_id}, …)`
     **when** two concurrent downloads for the same msg are >8MB apart **and**
     `source_ids_match` is true (both None, or equal Some). Different source_ids do
     **not** cancel each other.
4. **source_id wiring — KEY FINDING (corrects earlier analysis):**
   - Backend is **fully built** for source isolation: `StreamQuery.source_id:
     Option<String>` (`server.rs:297`, comment `:293` "prevents the thumbnail
     pipeline's"), passed into `register_download` (`:1151`). One internal call sets
     `source_id: None` explicitly (`:1830`).
   - **Frontend does NOT send it.** Grep of `src/lib/faststream/` + hooks shows only
     *comments* mentioning `source_id=None` (`MediabunnyTransmuxer.ts:1091`,
     `TauriStreamSource.ts:50`) — **no code appends `&source_id=` to the request URL.**
   - **Consequence:** playback reads and thumbnail reads both arrive as
     `source_id=None`, so the coordinator treats them as the same source and
     cross-cancels them (>8MB apart) — the zombie ping-pong. **The isolation mechanism
     exists and is unused on the client side.** Tagging TauriStreamSource requests with
     a stable `source_id` would stop cross-cancellation with `(Some,None)=>false`.
5. **MKV has NO backend index (confirmed).** `/fmp4/keyframes` endpoint
   (`server.rs:4013-4014`) is TS-only: `:4068` `[FMP4-KF] msg … is not a TS stream …
   returning empty final index`. `scan_keyframes*` are TS demux functions
   (`server.rs:7`, `:1711`, `:2785`, `:4241`). MKV seeking is entirely client-side via
   mediabunny Cues.

---

## Summary of corrections this trace produced (vs. MKV_SEEK_ANALYSIS.md)

1. **`source_id` isolation is already implemented in the backend** and merely **unused
   by the frontend** (Stage 5 §4). Earlier doc implied source_id would be new work — it
   is actually a 1-line client-side tag on the request URL. This is likely the cleanest,
   highest-confidence fix for the zombie thrash + terminal spam.
2. **The 15s far-seek is NOT fully explained by Input disposal alone** (Stage 3
   correction): refills also make fresh Inputs yet are 1-2ms. The distance-to-uncached-
   data factor is real and unquantified. **A fresh runtime log is required** before
   claiming any specific seek fix removes the 15s.

## Verified-vs-unverified ledger
- **Verified by direct read this trace:** all cited `file:line` in Stages 1-5 except
  those explicitly marked UNVERIFIED.
- **UNVERIFIED (must line-read before acting):** `_initMkvTransmuxerPlayer` internal
  ordering (S1§5); refill pacing constants (S2§4); `onMediaSegment`/SourceBufferWrapper
  bodies (S2§7); thumbnail Input-creation site (S4§1); EOF/recovery/pause/teardown
  specifics (S4§2-5).
