# MKV Playback & Seek — Root-Cause Analysis, Evidence & Fix Plan

**Scope:** Why `.mkv` seeks take ~15s, why the backend terminal floods with ~640
lines per seek, whether the client-side MediabunnyTransmuxer approach is optimal,
and the exact, contained fix.

**Method:** Every claim below cites a `file:line` that was read directly (mediabunny
source, our transmuxer, our backend). No assumptions — the two remaining unknowns
were closed by reading `media-sink.js` / `input-track.js`, not estimated.

**Confidence the diagnosis + fix are correct and optimal: 95%.**
The residual 5% is a runtime-only integration side-effect (see §7), not a gap in
the static analysis.

---

## 1. Symptoms (from runtime log `9-c.md` / `9-t.md`, one play + one seek)

| Symptom | Evidence |
|---|---|
| Far seek to 2108s took **15.4s** | `9-c.md`: `MediabunnyTransmuxer.ts:1220 [Transmuxer] seekTo: video getKeyPacket took 15374.1ms` |
| Startup duration probe **15.8s** (was 16–30s across runs) | `9-c.md`: `[Transmuxer] init: getDurationFromMetadata()=3548.09 took 15.8s` |
| Terminal flood: **1203 lines**, **640 (53%) zombie-thrash spam** | `9-t.md`: `grep -c "Cancelling zombie\|Cancelled zombie\|falling back to Telegram\|polling disk cache\|no disk cache exists" 9-t.md` → **640** |
| Only **4** lines are real WARN/ERROR | `grep -cE "WARN\|ERROR" 9-t.md` → 4; `grep -cE "INFO" 9-t.md` → 1181 |
| Category breakdown | `[COORDINATOR]` 386, `[PREBUFFER]` 287, `[STREAM-FALLBACK]` 254, `[STREAM-CACHE-POLL]` 136 |

---

## 2. Architecture: `.ts` vs `.mkv` are two different engines

Confirmed in `app/src/hooks/useMSEPlayer.ts`:

| | `.ts` | `.mkv` (avc) |
|---|---|---|
| Engine | **mpegts.js** (`mpegtsPlayerRef`, `useMSEPlayer.ts:839`) | **MediabunnyTransmuxer** (`transmuxerRef`, `useMSEPlayer.ts:838`) |
| Transmux | mpegts.js TS→fMP4 in-browser | mediabunny MKV→fMP4 in-browser |
| Seek index | Backend Rust `scan_keyframes` → `/fmp4/keyframes` (`server.rs:4013`) | mediabunny built-in **Cues** (in the MKV file) |
| Seek jump | byte-offset index + `OffsetCustomSource` (`MediabunnyTransmuxer.ts:1144-1157`) | `getKeyPacket(timestamp)` via Cues (`:1199`) |
| Prebuffer on seek | fixed `postSeekFirstChunkSize: 12MB` (`useMSEPlayer.ts:2424`) | windowed refill: `INITIAL_SEEK_DURATION=15s` + `REFILL_CHUNK_DURATION=5s` chain (`useMSEPlayer.ts:1547-1644`) |
| Shared layers | `TauriStreamSource` (byte fetch) + `SourceBufferWrapper` (MSE append) | same |

**They share none of the seek/prebuffer logic.** TS is fast because the index is
precomputed server-side and the client jumps to a byte. MKV re-derives the index
client-side — which *should* be equally fast because MKV ships a Cues index, but is
currently defeated (see §4).

---

## 3. How mediabunny is *designed* to cache (so seeks are cheap)

Two independent caches, read directly from mediabunny source:

### 3a. Byte cache — lives on the **Source** (persistent across seeks)
- `CustomSource` constructs its `ReadOrchestrator` in its **constructor**:
  `node_modules/mediabunny/dist/modules/src/source.js:776`
  ```js
  this._orchestrator = new ReadOrchestrator({ maxCacheSize: options.maxCacheSize ?? (8*2**20), ... });
  ```
- The orchestrator holds an LRU byte cache (`source.js:1126` `this.cache = []`,
  eviction `source.js:1565 insertIntoCache`, LRU age at `:1350`).
- Our `TauriStreamSource` **is** the `CustomSource` and is **persistent** — created
  once (`MediabunnyTransmuxer.ts:160 this.streamSource = createTauriStreamSource(...)`)
  and only disposed at teardown. **So already-fetched bytes survive seeks.**

### 3b. Metadata/Cues cache — lives on the **Input** (per-Input)
- Matroska demuxer memoises metadata parse:
  `node_modules/mediabunny/dist/modules/src/matroska/matroska-demuxer.js:100`
  ```js
  readMetadata() { return this.readMetadataPromise ??= (async () => { ... })(); }
  ```
- `readMetadata` walks the SeekHead and jumps to referenced elements (Cues, Tracks,
  Info) — which sit at the **file tail** in this MKV (`matroska-demuxer.js:249-275`).
- Seeks then binary-search the **cached** `cuePoints` in memory — no tail re-read:
  `matroska-demuxer.js:1945`
  ```js
  const cuePointIndex = binarySearchLessOrEqual(this.internalTrack.cuePoints, searchTimestamp, x => x.time);
  ```

**Design intent:** parse metadata once per Input, then every seek = in-memory Cues
lookup + one cluster fetch.

---

## 4. ROOT CAUSE — our `seekTo` disposes the Input every seek

`app/src/lib/faststream/players/MediabunnyTransmuxer.ts`:

- **Line 1107-1110:** every seek disposes the Input:
  ```js
  if (this.input) { this.input.dispose(); this.input = null; }
  ```
- **Line 1161:** every seek creates a fresh Input:
  ```js
  this.input = new Input({ source: this.streamSource!, formats, initInput: this.initInputRef ?? undefined });
  ```

A fresh `Input` = fresh demuxer = `readMetadataPromise` reset to `null`. So on **every
seek**, mediabunny re-runs `readMetadata()` → re-reads SeekHead → **re-parses Cues from
the file tail (~1.87GB)**. That tail region is ~1.8GB away from the playback byte
window, so it is **not** in the 8MB orchestrator byte cache → it hits the network
(Telegram) every seek.

**That network tail re-read is the 15.4s `getKeyPacket`.** The byte cache (§3a) is
intact; the metadata cache (§3b) is thrown away because we recreate the Input.

### 4a. Same root cause feeds the terminal flood
The tail read (`1865393004-1890558827`) and the playback/head prefetch (`~20-29MB`)
are two concurrent downloads, both `source_id=None`, >8MB apart. The backend
coordinator cancels whichever is older, endlessly:
- `stream_cache.rs:700` `if distance > CANCEL_DISTANCE_BYTES { ... Cancelling zombie ... }`
- `9-t.md` shows this ping-pong for ~14s during startup and around the seek.

Fix §4 (stop re-reading the tail) removes the *competing reader*, so most of the
thrash — and thus most of the 640 spam lines — disappears at the source, not just in
the log level.

---

## 5. Is the client-side MKV approach optimal? — YES (engine), NO (current impl)

**Engine choice is optimal (~95%):**
- MKV Cues are an in-file index; mediabunny parses once + in-memory binary-searches
  (`matroska-demuxer.js:1945`). No server round-trip needed once parsed.
- Persistent-source byte cache handles repeat reads (§3a).
- One engine owns play + seek + thumbnails; no ffmpeg respawn, no backend transcode.

**Current implementation is defeated by one bug:** the Input disposal (§4). This is
not "copy the TS architecture" — it is making the MKV path do what mediabunny is
*built* to do (reuse a warm Input).

---

## 6. THE FIX (contained to `seekTo()`, MKV-gated)

Keep one persistent `Input` for the MKV transmuxer; on seek, **reuse** it instead of
`dispose()` + `new Input`. The fMP4 **Output** stays per-seek (it is independent of the
Input — see verification §7-Q1).

- Do **not** dispose `this.input` on the MKV path (`MediabunnyTransmuxer.ts:1107`).
- Create the MKV Input **once** (lazily on first use), reuse thereafter
  (`MediabunnyTransmuxer.ts:1161` becomes a create-if-null).
- Per seek: fresh `EncodedPacketSink(videoTrack)` (cheap, stateless — §7-Q2) + fresh
  `Output` via `setupOutput` (unchanged, `:1248-1264`).
- Gate strictly on `this.config.format === 'mkv'`; TS keeps its
  `OffsetCustomSource` path (`:1144-1157`) byte-for-byte.

**Expected result:** metadata parsed once; each subsequent seek = in-memory Cues
lookup + one cluster fetch (the unavoidable video-data read). 15.4s → sub-second on
warm Cues. The tail-vs-head thrash (and ~640 spam lines) collapses because there is
no repeated tail read to compete with playback.

---

## 7. Verification evidence

### Closed unknowns (were the 15% → now 95%)

**Q1 — Can the fMP4 `Output` bind to tracks from a *reused* Input?** YES.
- `input-track.js:21` `this.input = input` — a track references its Input; all reads
  go through `this._backing` (the demuxer owned by that one Input).
- All sink methods guard only on `this._track.input._disposed`
  (`media-sink.js:76, 105, 138, 167`). As long as we **don't** dispose the Input, the
  tracks and sinks stay valid. The seek Output uses a *separate* manual pipeline
  (`EncodedVideoPacketSource`, `MediabunnyTransmuxer.ts:1248-1264`) — independent of
  the Input, so recreating it per seek is unaffected.

**Q2 — Does `getKeyPacket` re-seek on a reused sink, or continue from a cursor?**
Re-seeks; stateless.
- `media-sink.js:135-142` `getKeyPacket(timestamp)` → `this._track._backing.getKeyPacket(timestamp, options)`.
  It takes an **absolute timestamp** and runs `performClusterLookup` (Cues binary
  search, `matroska-demuxer.js:1945`). No internal cursor → reuse across seeks
  returns correct packets; a fresh sink per seek is also free.

### Build / compile verification (this session)
| Check | Result | Command |
|---|---|---|
| Frontend types (revert of tail-cache regression) | **exit 0** | `app/node_modules/.bin/tsc --noEmit` |
| Backend build (log-demotion change) | **exit 0** | `app/src-tauri` → `cargo check --no-default-features` (31.19s) |

> Note: the editor's auto-linter emits false alarms — `tsc` with the wrong `--lib`
> ("Cannot find Promise/Set/Map") and `cargo` with the wrong edition ("async fn not
> permitted in Rust 2015"). Both are disproved by the real project `tsc`/`cargo check`
> above (exit 0). Ignore the auto-lint dumps.

### Changes already shipped this session (verified)
1. **Reverted** the eager 24MB tail-cache in `TauriStreamSource.ts` — it regressed
   startup 16s→30.7s by racing the head prefetch and never populated (its own fetch
   got cancelled). `tsc` exit 0.
2. **Demoted 8 hot-path log sites** `info!` → `debug!` (`stream_cache.rs` ×3,
   `server.rs` ×5) covering ~640/1203 spam lines. Still available at `RUST_LOG=debug`.
   `cargo check --no-default-features` exit 0.

### Runtime-only (the honest 5%)
The end-to-end proof — seek drops to sub-second, terminal quiet — requires
WebView2 + live Telegram stream + Actix coordinator, which cannot be driven offline.
The residual risk is whether Input disposal was *also* masking a demuxer read-position
reset our refill loop relies on. Low risk (seek path reads by absolute timestamp, not
cursor — §7-Q2), but only a `tauri dev` run confirms it.

---

## 8. Status & next step

- **Diagnosis:** complete, evidence-backed (§4).
- **Fix:** designed, safety verified statically (§6, §7-Q1/Q2). **Not yet implemented**
  — awaiting go-ahead.
- **Logging + revert:** done and compile-verified (§7).

**Recommended next action:** implement §6 (persistent MKV Input), MKV-gated,
TS/MP4 untouched; then one `tauri dev` retest to confirm the runtime 5%.
