# Layer-2 edge cases — SB contract / "declare what you emit" (absorbed angle B)

> The dispatched angle-B subagent completed its 29-min investigation but died before
> writing anything (provider infra error; its goal's write-as-you-go rule was ignored).
> This doc was researched directly from source instead. Claims cite file:line.

## B1. WHERE the mime decision happens — the chicken-and-egg is real but solvable

Order today (useMSEPlayer.ts `_initMkvTransmuxerPlayer`):
1. `transmuxer.init()` → resolves tracks, `buildMimeType(videoCodecString, audioCodecString, ...)` from the INPUT FILE's track inventory (MediabunnyTransmuxer.ts:516-541) → `result.mimeType`
2. `mediaSource.addSourceBuffer(result.mimeType)` at useMSEPlayer.ts:6836 — **before any seekTo/audio lookup runs**
3. initial-prime `seekTo(0)` → audio lookup happens HERE (:1455-1476) → too late: SB already declared 2 codecs

⇒ Layer 2 cannot be "pick the right mime at addSourceBuffer time" without moving the
audio-start probe INTO init. Two legal designs:

- **(a) Probe-at-init (chosen):** during `init()` after `resolveAudioTrack()`
  (:431), run the Layer-1 fallback chain ONCE for t=0 (cheap: head is prefetched
  by the 6MB cold-start buffer). If even the chain fails → `audioCodec = null`,
  `buildMimeType` naturally emits video-only mime (:528 `if (videoPart) return
  'video/mp4; codecs="videoPart"'`) AND `addAudioTrack` is skipped in setupOutput
  (:1434 `if (audioSource)` — condition on audioCodec). Init-time decision, no
  changeType needed, SB born consistent. The probed start packet ALSO seeds seekTo's
  first window (no double lookup).
- (b) `SourceBufferWrapper.changeType(videoOnlyMime)` (:257-262, exists and queued)
  BEFORE the first init-segment append. Legal per Chromium (PENDING_PARSER_RECONFIG
  arms on changeType before first append; expected-codec list re-armed). Rejected as
  primary: leaves a window where refill code believes audio exists, and the
  audio-track switcher would changeType BACK (B4).

## B2. `output.getMimeType()` await semantics — deadlock risk CONFIRMED, avoid

isobmff-muxer.js:153 `getMimeType()` awaits `allTracksKnown`, which resolves when
every open track has ≥1 sample OR is closed. Calling it BEFORE pumping packets =
awaiting forever (nothing pumps until seekTo runs). **Do not use it for the SB mime
decision** — it's only safe as a post-hoc consistency assert AFTER the first window.
Probe-at-init (B1a) avoids the trap entirely.

## B3. First-window-has-audio but window-N doesn't (mid-file starvation)

Distinct from the init fatal: SB is 2-trak, refill window N resolves no audio start
(cluster-lookup null mid-file) → video-only MEDIA segments append fine (Chromium:
DEBUG log only) but `SourceBuffer.buffered` = per-track INTERSECTION → the buffered
range stops growing at the audio hole → refill chain sees no progress → playback
stalls at the hole with a healthy-looking pipeline.
- Detection: after each refill append completes, compare expected window end
  (`stopTime`) vs actual `sb.buffered.end` growth; OR surface `audioSkipped` from the
  window pump (codebase doc §4g) — the cheap and deterministic signal.
- Response ladder: retry window once from the NEXT cluster (Layer-1 mid-file
  fallback), then Layer-3 reroute. NEVER silently continue (infinite stall).

## B4. Audio-track switcher × video-only SB — must force reroute, not changeType

`_switchMkvAudioTrack` (:5951-6010) plans `rebuild-changetype`: changeType to the new
audio's mime + rebuild from playhead. On a SB born VIDEO-ONLY, switching INTO a
working audio track means 1-trak → 2-trak = **illegal in every engine** (standards
doc §2: "Got unexpected audio track"; spec step 3.1 pins the track set at first init
segment). changeType succeeds (it only re-arms codec expectations) and the fatal
comes LATER at the next init-segment append — a delayed, confusing failure.
⇒ Rule: if SB was created video-only, an audio-track switch REQUIRES full MediaSource
teardown + re-init (the mp4ReinitNonce path already rebuilds everything) or Layer-3
reroute with `?audio_idx`. Guard in planAudioSwitch: `sbTrackSet === 'video-only' →
plan 'reinit'`, never 'rebuild-changetype'.

## B5. Video-only SB — duration/buffered/UI semantics

- buffered intersection degenerates to the video track alone — progress bar and
  refill window math (video-driven already) unaffected.
- `video.duration` comes from `mediaSource.duration` (set from metadata :6790s) —
  unaffected by missing audio trak.
- UI: audio menu would still list the file's tracks from `/audio_tracks` probe →
  selecting one hits B4's guard → reroute with audio_idx (user gets working audio via
  tier 2 — correct outcome, not an error).
- Volume/mute controls act on a track-less element: no-op, no exception. Show the
  existing "no audio" affordance keyed off the surfaced audioSkipped state.

## B6. WebView2-specific notes

- `SourceBuffer.changeType` supported (Chromium engine; SBW already uses it :257).
- The fallbackMimes ladder at :6842 includes `'video/mp4; codecs="avc1.42E01E"'` —
  precedent that a video-only SB is an accepted degraded mode at CREATION time
  already; Layer 2 extends the same doctrine to the audio-unresolvable case.

## B7. Interactions checklist (for the plan's verification column)

| Interaction | Verdict |
|---|---|
| skipInitSegment refills (`onFtyp/onMoov` gated, :544-560) | video-only refills emit no init segment — consistent |
| thumbnail pipeline (separate Input/Output) | independent; unaffected by main SB track set |
| embedded subs (container probe) | independent of audio track set |
| mp4ReinitNonce re-init | re-runs init → re-probes audio → SB reborn with correct trak set (self-healing) |
| persisted audio-track choice on a file whose chosen track is broken | probe-at-init tries THAT track; if unresolvable → B4 rule → reroute w/ audio_idx keeps the choice server-side |
