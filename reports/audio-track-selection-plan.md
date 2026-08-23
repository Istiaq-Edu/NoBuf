# Audio Track Selection — Implementation Plan

2026-07-29. Fix #2 from `future-work-overview.md`. Grounded in 7 research docs +
`audio-cross-validation.md` (28/28 claims VERIFIED; hazards H1-H3, open items I1-I3).
Scope cut per overview: **/remux + MKV + MP4 tiers ship; TS tier excluded** (mpegts.js
binds the first audio PID, no selection API — ts-demuxer.ts:779, VERIFIED L1e).

---

## 0. Design principle (from cross-validated research)

**Every tier switches by REBUILD-FROM-PLAYHEAD through its existing seek machinery.**
In-place SourceBuffer swapping is spec-fragile (MSE init-segment track-count/ID rules,
P3), wins nothing here (audio is muxed in every tier — re-demux from playhead is
unavoidable), and shaka itself ships a RELOAD fallback for exactly this case. Rebuild
cost ≈ one unbuffered seek (~1-3s), reusing pause-preservation, generation guards, and
buffer-flush logic that is already e2e-proven.

## 1. Shared surface (frontend)

New types + state in `useMSEPlayer.ts`:

```ts
export interface AudioTrackInfo {
  id: number;          // tier-native id: ffprobe stream index | mediabunny track.id | mp4box track.id
  label: string;       // "Japanese — AAC 5.1" | name | "Track 2"
  language: string;    // ISO 639-2 or 'und'
  codec: string;
  channels: number;
  isDefault: boolean;
  playable: boolean;   // H3: false → switching routes via /remux or is disabled
}
```

Hook return object (:8798) gains: `audioTracks: AudioTrackInfo[]`,
`activeAudioTrackId: number | null`, `switchAudioTrack(id: number): Promise<boolean>`
(returns false on failure → UI reverts selection + toast).

Pure decision helpers (exported for vitest, pattern = TsHevcRecovery.test.ts):
- `buildAudioTrackLabel(lang, name, codec, channels)` — label rules, 'und'/dup handling.
- `pickDefaultAudioTrack(tracks, persistedId?)` — persisted > disposition.default >
  first playable.
- `planAudioSwitch({tier, currentMime, newTrackCodec, isTypeSupportedFn})` →
  `'rebuild' | 'rebuild-changetype' | 'reroute-remux' | 'reject'` (H1/H3 logic).

Persistence: localStorage key `nobuf-audio-track` = LRU JSON map
`{"<folderId>:<messageId>": <trackId>}` cap 200 (U2: no per-file store exists; follows
`nobuf-*` naming). Read in `pickDefaultAudioTrack`; write on successful switch.

## 2. Backend (server.rs)

1. `StreamQuery` += `audio_idx: Option<i32>` (:319-367).
2. `parse_probe_json` (:2499): collect ALL audio streams into
   `audio_streams: Vec<AudioStreamInfo{index, codec, channels, channel_layout, language,
   title, is_default}>` (read `tags.language`, `tags.title`, `disposition.default`) while
   keeping the existing primary-pick fields byte-identical.
3. Override point (:2742-2743): if `query.audio_idx` is Some AND present in
   `probe.audio_streams` → use it; else keep primary + `log::warn!` (never 500) (B4:
   one local covers all ffmpeg sites: :2870, :3051, :3272).
4. **Cache keying (B3+H2, validate-first)**: when `audio_idx` param present, move the
   Phase-1 cached-remux check AFTER the probe and key by the VALIDATED effective idx:
   `{folder}_{msg}_a{idx}.mp4` (+ `.tmp`). No param → legacy key + legacy pre-probe fast
   path unchanged (zero regression for default plays; existing caches stay valid).
5. New endpoint `GET /audio_tracks/{folder}/{msg}?token=` → JSON
   `{tracks: [AudioStreamInfo...], primary_idx}` via `run_stream_probe` (fast budget);
   result memoized in `HashMap<i32, ...>` beside `probed_durations`.
6. Rust tests: parse_probe_json multi-audio fixtures (language/disposition extraction,
   id3 skip), override validation (in-range/out-of-range/non-audio), cache-key
   construction, arg builders with overridden idx.

## 3. Per-tier switch (frontend)

### /remux tier (timed_id3, MKV-HEVC, MP4-HEVC reroute, TS-HEVC recovery)
- Track list: fetch `/audio_tracks` when menu opens (lazy) or on player init.
- Switch: append `&audio_idx=N` to the remux base URL → existing
  `_mpegtsRecreatePlayerForRemuxSeek(currentTime, dur)` (gen counter, pause
  preservation, align poll built in).
- **All 6 /remux URL construction sites** (:2701, :2819, :3292, :4095, :6268, :6873)
  build from a new `remuxAudioIdxRef` so seeks/recovery/reroute NEVER silently revert
  the chosen track. Centralize: tiny helper `withAudioIdx(url)` applied at each site.
- I3 e2e check: switching a file whose old-track remux is disk-cached must miss that
  cache (guaranteed by validate-first keying).

### MKV tier (MediabunnyTransmuxer)
- Track list: new `transmuxer.getAudioTracks()` → `input.getAudioTracks()` + metadata
  (getLanguageCode/getName/getDisposition/getNumberOfChannels, L1c) + `canDecode()`/
  `decideMseCodec` → `playable` (H3). I1: log timing; Input is persistent (K2) so this
  is metadata-only.
- Switch: set `desiredAudioTrackId` on transmuxer → resolver replaces
  `getPrimaryAudioTrack()` at :1321 AND :427 (+ :331/:886/:982 for TS-seed parity,
  though TS tier is excluded from UI) with `getAudioTrackById(desired) ?? primary` →
  re-derive `audioCodec`/`audioTrackInfo`/`mimeType` → driver runs the §K-verified
  chain: `stopStreamingChain()` → `resetForSeek()` flush → `seekTo(video.currentTime,
  SEEK_START_DURATION, {skipInitSegment:false})` → `setTimestampOffset` →
  `startStreamingChain()`.
- **H1 (combined SB codec change)**: before appending the new init segment, if the new
  combined mimeType ≠ SB's current type → `sb.changeType(newMime)` (Chrome 70+/WebView2
  OK, P4). If `MediaSource.isTypeSupported(newMime)` fails → `planAudioSwitch` returns
  `'reroute-remux'` (file plays via /remux with audio_idx, ffmpeg→AAC) — never a dead SB.

### MP4 tier (mp4box)
- Track list: extend `MP4BoxTrack` (:887) + copy loop (:6938) with
  `language/name/audio{channel_count,sample_rate}` (M3 — data already in info, zero cost).
- Switch (M6/L3: fresh instance — global seek() rewinds all traks, in-place is fragile):
  capture `video.currentTime` → teardown mp4box state (existing cleanup path,
  loopGeneration bump) → re-init from cached moov (`getMoovBuffer`, I2) with
  `preferredAudioTrackId` overriding the `[0]` pick at :6982/:6987 → normal pendingSeek
  to captured time (re-appends init segments :7304, re-runs prefetchAudioData for the
  NEW track's byte extent).
- Audio SB codec change across instances: SB is re-created in re-init path; if
  isTypeSupported fails → `'reroute-remux'`.

### TS tier
- Menu hidden (tracks list = the single PMT-bound track). The /remux-recovery variant of
  a TS file IS switchable (it's the /remux tier).

## 4. UI (FastStreamPlayer.tsx — clone of captions chip, U1)

- New `case 'audio'` in `chipButton` registry (:1734), inserted adjacent to `captions`
  in the default layout (check persisted-layout migration so existing users see it).
- Trigger: speaker icon, `p-1.5 hover:bg-white/10 rounded transition-colors`,
  `text-nobuf-primary` when non-default track active else `text-white`.
- Popup: exact captions classes (`absolute bottom-full right-0 mb-2 bg-black/95 border
  border-white/10 rounded-lg ... z-50 shadow-2xl py-1`); conditional rendering; items
  active `text-nobuf-primary bg-nobuf-primary/10 font-semibold` / inactive `text-white`;
  unplayable tracks: disabled style + "(via remux)" subtext when reroute is offered.
- **Chip hidden entirely when `audioTracks.length <= 1`** (no dead UI).
- During switch: reuse the SEEK buffering indicator (not cold-start overlay); menu closes
  on selection; `toast.error('Audio switch failed — reverted')` on failure.
- Switching NEVER unpauses (`isPausedRef` untouched by rebuild paths, K6). While paused:
  switch is allowed; refill defers exactly like blocked-paused seeks (:7641).

## 5. Edge-case matrix

| # | Case | Handling |
|---|---|---|
| E1 | Single/zero audio track | Menu hidden; switchAudioTrack no-ops |
| E2 | Switch while paused | Rebuild runs, playback stays paused (K6); fetch deferral per blocked-paused rules |
| E3 | Switch during pending seek/cold start | `switchAudioTrack` rejects while `bufferingForSeekRef`/cold-start active (single-flight guard ref); UI keeps old selection |
| E4 | Rapid double-switch | Generation guard (transmuxerSeekGenRef / mpegts gen / loopGeneration) — second call supersedes; single-flight ref serializes |
| E5 | audio_idx out of range / non-audio / id3 | Backend keeps primary + warns; frontend list only offers probed streams so UI can't produce it |
| E6 | Remux disk-cache collision old/new track | Validate-first keying `{folder}_{msg}_a{idx}.mp4` (H2) |
| E7 | New track codec unsupported by MSE | planAudioSwitch → changeType (same container) or reroute-remux; never dead player (H1/H3) |
| E8 | Switch fails mid-rebuild (network/decode) | switchAudioTrack returns false → revert activeAudioTrackId, toast; player re-inits previous track via same path; if that also fails, existing fatal-recovery chain owns it |
| E9 | Untagged languages / duplicate labels | 'und' → "Track N"; dup labels get codec/channel suffix (buildAudioTrackLabel, unit-tested) |
| E10 | Persisted choice for deleted/changed file | pickDefaultAudioTrack falls back to disposition/first when persisted id absent from list |
| E11 | TS-HEVC recovery rebuilds /remux URL | recovery + all 6 URL sites read remuxAudioIdxRef → choice survives recreation |
| E12 | File switch mid-menu-open | track list keyed by messageId; stale fetch discarded (compare against streamUrlRef) |
| E13 | moov-at-end MP4, new track bytes never fetched | fresh-instance path re-runs prefetchAudioData for new track extent (M5 machinery) |
| E14 | Background disk remux (old track) in flight during switch | bg job keyed to old cache path finishes harmlessly; new request spawns its own keyed job (B4) |

## 6. Test plan

- **Vitest (pure helpers)**: buildAudioTrackLabel (E9 cases), pickDefaultAudioTrack
  (persisted/default/fallback, E10), planAudioSwitch (H1/H3 matrix, E7),
  withAudioIdx URL builder (all forms: with/without existing params, idempotence, E11).
- **Rust**: multi-audio parse_probe_json fixtures; override validation (E5); cache-key
  fn (E6); arg builders with override.
- **ffmpeg execution check**: generate dual-audio fixtures (jpn+eng AAC/AC3, MKV+MP4+TS)
  and run the exact override command shapes; verify stream mapping via ffprobe of output.
- **Gates**: `npx tsc --noEmit` = 0; `npx vitest run` all green (321 + new);
  `cargo build` + `cargo test` green.
- **Manual e2e (user, tauri dev)**: dual-audio MKV switch (both directions, paused +
  playing), dual-audio MP4, HEVC file on /remux tier switch, persistence across reopen,
  I2/I3 checks.

## 7. Sequencing

1. Backend: probe extension + audio_idx + keying + endpoint + tests → cargo green.
2. Pure helpers + vitest → green.
3. /remux tier switch (smallest frontend delta, proven recreate path).
4. MKV tier (resolver + H1 changeType).
5. MP4 tier (fresh-instance re-init, I2).
6. UI chip + persistence.
7. Full gates + fixture execution checks → hand to user for tauri dev e2e.
