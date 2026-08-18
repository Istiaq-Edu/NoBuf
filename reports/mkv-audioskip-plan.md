# MKV Audio-Skip Fatal — Implementation Plan (3 layers)

> **For agentic workers:** execute task-by-task, in order. Every step is checkboxed.
> Run the verify command of each step before moving on. **NEVER `git add`/`git commit`
> — the user commits manually.** Do not touch code outside the quoted regions.

**Goal:** Fix the MKV audio-skip fatal (cue-less AVC-MKV with audio starting >0s →
video-only init segment under a 2-codec SourceBuffer → Chromium
`CHUNK_DEMUXER_ERROR_APPEND_FAILED` → MediaError 4 → dead `useNative` on raw MKV),
without regressing the TS transmuxer path, abutting refills, VBR anchors, or audio-track
switching.

**Architecture:** Three independent layers. **L1** fixes the audio-start lookup with the
library's own fallback idiom (kills ~all real-world cases). **L2** makes init honest:
probe audio at init and declare only the tracks that will actually be emitted (SB born
consistent — no lying init segments). **L3** replaces the dead `useNative` end state with
a reroute to the proven `/remux → mpegts.js` tier (ffmpeg video-copy + AAC re-encode),
resuming at the playhead, covering every post-init fatal (video error 3/4, silent SB
fatal, transmuxer onError, zero-audio starvation, audio-switch onto a video-only SB).

**Tech stack:** TypeScript (React hook + transmuxer class), mediabunny 1.45.4 (vendored),
MSE/WebView2, vitest. No Rust/server changes.

**Research base (all on disk, 40-claim cross-validation ledger complete):**
`reports/mkv-audioskip-solution.md` (final spec),
`reports/research/audioskip-crossvalidation.md` (ledger),
`reports/research/audioskip-edge-a-layer1.md`, `audioskip-edges-sbcontract.md`,
`audioskip-edges-reroute.md`, `audioskip-edges-regression.md`.

**Baseline gates (captured 2026-08-01/02, BEFORE any change):**
- `cd app && npx tsc --noEmit` → clean
- `cd app && npx vitest run` → **366/366** (22 files)
- `cd app/src-tauri && cargo test --no-default-features` → **178/178**

**Line numbers** valid as of branch `Embedded-subtitle-extraction` @ fb18253 + untracked
docs, 2026-08-02, pre-modification. Tasks are ordered so earlier edits don't shift later
anchors in the SAME file except where noted (patch by unique string, not line).

---

## File map (what changes where)

| File | Changes |
|---|---|
| `app/src/lib/faststream/players/MediabunnyTransmuxer.ts` | L1: `NEAR_START_AUDIO_FALLBACK_S` const, `resolveAudioStartPacket()` helper, install at S1 :916 / S2 :1026 / S3 :1455, rewrite falsified S3 comment :1449-1454, delete orphaned comment :1640-1644. L2: probe-at-init in the MKV `init()` branch (:431). L3-support: `windowAudioPacketsAdded`/`lastWindowAudioStarved` + `wasLastWindowAudioStarved()` getter. |
| `app/src/hooks/useMSEPlayer.ts` | L2: `sbHasAudio` arg on `planAudioSwitch` (:352), `mkvSbHasAudioRef`, pre-prime persisted-track guard + changeType (:6898-6905). L3: parameterize `_recoverToRemuxTier` (:4430, D0), `_recoverMkvToRemuxTier` orchestrator + `recoverMkvRerouteRef`, wire video-error listener (:9505-9517), transmuxer `onError` (:6770), refill-chain D3 hooks (:2588, :2833) + zero-audio watchdog (+ seek-time counter reset :8900), `mapAudioTrackToRemuxIdx` + reroute branch in `_switchMkvAudioTrack` (:5980), ref resets in both cleanups. |
| `app/src/__tests__/AudioStartChain.test.ts` | NEW — L1 chain unit tests (instance pattern from `snapToCueKeyframe.test.ts`). |
| `app/src/__tests__/AudioTrackSelection.test.ts` | EXTEND — `planAudioSwitch` B4 matrix + `mapAudioTrackToRemuxIdx`. |
| `app/src/__tests__/MkvFatalReroute.test.ts` | NEW — `shouldTriggerZeroAudioReroute` matrix. |

**No server change. No new UI** (menu + reroute covers the "no audio" case; inventing UI
is out of scope per user rules).

---

## Task 1 — Layer 1: the audio-start fallback chain (transmuxer helper) [TDD]

**Files:**
- Modify: `app/src/lib/faststream/players/MediabunnyTransmuxer.ts`
- Create: `app/src/__tests__/AudioStartChain.test.ts`

The FINAL chain (amended by edge research; crossvalidation #8/#9/#17):

```
getKeyPacket(kf, {verifyKeyPackets:false})
  ?? (kf <= NEAR_START_AUDIO_FALLBACK_S ? getFirstKeyPacket() : null)
```

- `getPacket` link DROPPED — every audio packet is typed `'key'` on BOTH containers
  (matroska-demuxer.ts:1468-1474; mpeg-ts-demuxer.ts:1737-1739 + :1136-1138) → identical
  result to link 1.
- `nextAudioAfterVideoKey` leg DROPPED — cross-sink `getNextKeyPacket(videoPacket)`
  throws `'Packet was not created from this track.'` (matroska-demuxer.ts:2049-2052).
- Mid-file null = zero-audio-window signal (handled by L2/L3), NOT a scan — a
  `getFirstKeyPacket` at mid-file would make `iterateAudioPackets` iterate every cluster
  from byte ~0 over HTTP (D9).
- Supersession checked between links (F6): a user seek bumping `seekGeneration` mid-chain
  bails to null instead of burning a scan.

- [ ] **Step 1.1 — Write the failing test.** Create `app/src/__tests__/AudioStartChain.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { MediabunnyTransmuxer } from '../lib/faststream/players/MediabunnyTransmuxer';

// Mock Tauri invoke so the module's diagLog() imports cleanly in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * resolveAudioStartPacket backs Layer 1 of the MKV audio-skip fix
 * (reports/mkv-audioskip-solution.md §Layer 1).
 *
 * Chain: getKeyPacket(kf) ?? (kf <= NEAR_START ? getFirstKeyPacket() : null).
 * The repro (Inception MKV): default AAC track starts at 0.029s, file has 0 cue
 * points → getKeyPacket(0) is null (needs ts <= 0) → the old code closed the
 * audio source → video-only moov under a 2-codec mime → Chromium code-4 fatal.
 * getFirstKeyPacket bypasses cues by design and returns the 0.029s packet.
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
  });
}

function makeSink(keyPacketResult: unknown, firstKeyResult: unknown) {
  return {
    getKeyPacket: vi.fn().mockResolvedValue(keyPacketResult),
    getFirstKeyPacket: vi.fn().mockResolvedValue(firstKeyResult),
  };
}

describe('resolveAudioStartPacket (Layer-1 chain)', () => {
  it('link 1 hit → returns it unmodified, never calls getFirstKeyPacket (D2 happy path)', async () => {
    const t = makeTransmuxer() as any;
    const pkt = { timestamp: 12.3 };
    const sink = makeSink(pkt, null);
    const out = await t.resolveAudioStartPacket(sink, 12.3, t.seekGeneration);
    expect(out).toBe(pkt);
    expect(sink.getKeyPacket).toHaveBeenCalledWith(12.3, { verifyKeyPackets: false });
    expect(sink.getFirstKeyPacket).not.toHaveBeenCalled();
  });

  it('link 1 null + near-start → getFirstKeyPacket result (the repro: audio at 0.029s)', async () => {
    const t = makeTransmuxer() as any;
    const first = { timestamp: 0.029 };
    const sink = makeSink(null, first);
    const out = await t.resolveAudioStartPacket(sink, 0, t.seekGeneration);
    expect(out).toBe(first);
    expect(sink.getFirstKeyPacket).toHaveBeenCalledTimes(1);
  });

  it('link 1 null + mid-file → null WITHOUT a from-start scan (D9 cost guard)', async () => {
    const t = makeTransmuxer() as any;
    const sink = makeSink(null, { timestamp: 0.029 });
    const out = await t.resolveAudioStartPacket(sink, 3600, t.seekGeneration);
    expect(out).toBeNull();
    expect(sink.getFirstKeyPacket).not.toHaveBeenCalled();
  });

  it('near-start boundary is inclusive (kf === NEAR_START falls back; just above does not)', async () => {
    const t = makeTransmuxer() as any;
    const first = { timestamp: 0.5 };
    expect(await t.resolveAudioStartPacket(makeSink(null, first), 10, t.seekGeneration)).toBe(first);
    expect(await t.resolveAudioStartPacket(makeSink(null, first), 10.01, t.seekGeneration)).toBeNull();
  });

  it('supersession between links → null, second link never runs (F6)', async () => {
    const t = makeTransmuxer() as any;
    const sink = {
      getKeyPacket: vi.fn().mockImplementation(async () => {
        t.seekGeneration++; // a newer seek arrives while link 1 awaits
        return null;
      }),
      getFirstKeyPacket: vi.fn().mockResolvedValue({ timestamp: 0.029 }),
    };
    // Caller contract: pass the generation captured BEFORE link 1. Argument is
    // evaluated before the call, so this is the pre-bump value; the mock bumps
    // the live generation during link 1 → the post-link check sees a mismatch.
    const out = await t.resolveAudioStartPacket(sink, 0, t.seekGeneration);
    expect(out).toBeNull();
    expect(sink.getFirstKeyPacket).not.toHaveBeenCalled();
  });

  it('disposed between links → null (InputDisposedError window shrunk, F1)', async () => {
    const t = makeTransmuxer() as any;
    const sink = {
      getKeyPacket: vi.fn().mockImplementation(async () => { t.disposed = true; return null; }),
      getFirstKeyPacket: vi.fn().mockResolvedValue({ timestamp: 0.029 }),
    };
    const out = await t.resolveAudioStartPacket(sink, 0, t.seekGeneration);
    expect(out).toBeNull();
    expect(sink.getFirstKeyPacket).not.toHaveBeenCalled();
  });

  it('fallback returning null stays null (truly audio-less window)', async () => {
    const t = makeTransmuxer() as any;
    const out = await t.resolveAudioStartPacket(makeSink(null, null), 0, t.seekGeneration);
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 1.2 — Run it, expect FAIL** (method does not exist yet):

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app && npx vitest run src/__tests__/AudioStartChain.test.ts
```
Expected: FAIL — `t.resolveAudioStartPacket is not a function`.

- [ ] **Step 1.3 — Implement.** In `MediabunnyTransmuxer.ts`:

(a) Module constant — insert directly ABOVE `export interface TransmuxerConfig {` (:46):

```ts
// Layer-1 audio-start fallback window (reports/mkv-audioskip-solution.md §Layer 1).
// getFirstKeyPacket scans from segment start by DESIGN (bypasses cues) — cheap only
// when the window itself is near the head (bytes already in the seed/cold-start
// prefetch, and the subsequent audio iteration covers ≤ this many seconds). For
// mid-file windows the fallback must NOT run: iterating audio from the file's first
// packet to a far window would stream every cluster in between over HTTP (edge-A D9).
const NEAR_START_AUDIO_FALLBACK_S = 10;
```

(b) Private helper — insert directly ABOVE `private async iterateAudioPackets(` (:1594):

```ts
  /**
   * Resolve the audio packet a transmux window starts from (Layer 1 of the
   * audio-skip fix — reports/mkv-audioskip-solution.md).
   *
   * Chain: getKeyPacket(kf) ?? (near-start ? getFirstKeyPacket() : null).
   *  - getKeyPacket(t) returns the last packet with ts <= t → NULL when the
   *    audio track starts after t (e.g. default track starting at 0.029s with
   *    kf=0 — the Inception repro). All audio packets are typed 'key' on both
   *    MKV and TS, so a getPacket() link would return the identical result
   *    (crossvalidation #8) — omitted.
   *  - getFirstKeyPacket() bypasses cues and scans from segment start — the
   *    library's own fallback idiom (media-sink.ts:526-527). Gated to
   *    near-start windows; a mid-file null is surfaced as a zero-audio window
   *    (Layer 2/3 handle it) instead of an unbounded from-start iteration.
   *  - Generation/disposal checked between links: a superseding seek must not
   *    pay for a fallback scan it will discard (edge-A F6).
   */
  private async resolveAudioStartPacket(
    audioSink: EncodedPacketSink,
    keyframeTimestamp: number,
    generation: number,
  ): Promise<EncodedPacket | null> {
    const direct = await audioSink.getKeyPacket(keyframeTimestamp, { verifyKeyPackets: false });
    if (direct) return direct;
    if (this.disposed || generation !== this.seekGeneration) return null;
    if (keyframeTimestamp > NEAR_START_AUDIO_FALLBACK_S) return null;
    const first = await audioSink.getFirstKeyPacket();
    if (this.disposed || generation !== this.seekGeneration) return null;
    if (first) {
      diagLog(`[Transmuxer] audio start: fallback getFirstKeyPacket → ${first.timestamp.toFixed(3)}s (kf=${keyframeTimestamp.toFixed(3)}s)`);
    }
    return first;
  }
```

  Imports: `EncodedPacketSink` and `EncodedPacket` are already imported (used throughout
  the file) — no import changes.

- [ ] **Step 1.4 — Run the new test, expect PASS:**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app && npx vitest run src/__tests__/AudioStartChain.test.ts
```
Expected: 7/7 PASS.

- [ ] **Step 1.5 — Type check:** `cd /d/DEVELOPMENT/Telegram-Drive/app && npx tsc --noEmit` → clean.
  (Ignore the editor/patch-tool single-file lint — only `npx tsc --noEmit` is authoritative.)

---

## Task 2 — Layer 1: install the chain at S1/S2/S3 + comment hygiene

**Files:** Modify `app/src/lib/faststream/players/MediabunnyTransmuxer.ts` (4 regions).

- [ ] **Step 2.1 — S1 `produceSegmentsFromInitInput` (:916-924).** Replace:

```ts
    if (audioTrack && audioSource) {
      audioSink = new EncodedPacketSink(audioTrack);
      audioStartPacket = await audioSink.getKeyPacket(keyframeTimestamp, { verifyKeyPackets: false });
      if (!audioStartPacket) {
        audioSource.close();
        audioSink = null;
        audioSkipped = true;
      }
    }
```

with:

```ts
    if (audioTrack && audioSource) {
      audioSink = new EncodedPacketSink(audioTrack);
      audioStartPacket = await this.resolveAudioStartPacket(audioSink, keyframeTimestamp, generation);
      if (!audioStartPacket) {
        audioSource.close();
        audioSink = null;
        audioSkipped = true;
      }
    }
```

  (S1 has `generation` in scope — captured at :887.)

- [ ] **Step 2.2 — S2 `sequentialContinue` (:1026-1037).** Replace (note the diagLog pair
  wrapping the lookup):

```ts
    if (audioTrack && audioSource) {
      audioSink = new EncodedPacketSink(audioTrack);
      diagLog(`[Transmuxer] seqContinue: calling audioSink.getKeyPacket at t=${performance.now().toFixed(0)}ms`);
      const t7 = performance.now();
      audioStartPacket = await audioSink.getKeyPacket(keyframeTimestamp, { verifyKeyPackets: false });
      diagLog(`[Transmuxer] seqContinue: audioSink.getKeyPacket took ${((performance.now() - t7)/1000).toFixed(2)}s`);
      if (!audioStartPacket) {
        audioSource.close();
        audioSink = null;
        audioSkipped = true;
      }
    }
```

with:

```ts
    if (audioTrack && audioSource) {
      audioSink = new EncodedPacketSink(audioTrack);
      diagLog(`[Transmuxer] seqContinue: resolving audio start at t=${performance.now().toFixed(0)}ms`);
      const t7 = performance.now();
      audioStartPacket = await this.resolveAudioStartPacket(audioSink, keyframeTimestamp, generation);
      diagLog(`[Transmuxer] seqContinue: audio start resolve took ${((performance.now() - t7)/1000).toFixed(2)}s`);
      if (!audioStartPacket) {
        audioSource.close();
        audioSink = null;
        audioSkipped = true;
      }
    }
```

  (S2 `generation` captured at :966.)

- [ ] **Step 2.3 — S3 `seekTo` (:1449-1476).** Replace the falsified comment AND the
  lookup together (the comment at :1450-1454 claims "The init segment still includes the
  audio track definition" — PROVEN FALSE by the 672-byte single-trak init in the repro
  log; crossvalidation #7):

```ts
      // Find audio starting point nearest to keyframeTimestamp
      // If getKeyPacket fails (audio track has no Cue points), close audioSource
      // immediately — the Output treats closed tracks as "done" (keyFrameQueuedEverywhere
      // returns true for closed tracks), so segments can be produced with video-only data.
      // The init segment still includes the audio track definition (start() ran before
      // closing audioSource). Audio will be added via refill segments later.
      let audioStartPacket: EncodedPacket | null = null;
      let audioSink: EncodedPacketSink | null = null;
      let audioSkipped = false;
      if (audioTrack && audioSource) {
        const audioKeyStart = performance.now();
        audioSink = new EncodedPacketSink(audioTrack);
        // Use verifyKeyPackets: false when keyframe index is available —
        // same optimization as video getKeyPacket. Audio keyframes are less
        // critical than video (all audio packets are independently decodable
        // for AAC/Opus), so verification is even less necessary.
        audioStartPacket = await audioSink.getKeyPacket(keyframeTimestamp, { verifyKeyPackets: false });
        console.log(`[Transmuxer] seekTo: audio getKeyPacket took ${performance.now() - audioKeyStart}ms, result=${audioStartPacket ? 'found' : 'null (will skip audio)'}`);

        if (!audioStartPacket) {
          // No audio keyframe found near seek position — close audio source immediately.
          // This allows the Output to produce video-only segments without waiting for
          // audio data that would require iterating from file start (extremely slow).
          audioSource.close();
          audioSink = null;
          audioSkipped = true;
        }
      }
```

with:

```ts
      // Find the audio starting point for this window via the Layer-1 fallback
      // chain (getKeyPacket ?? near-start getFirstKeyPacket — see
      // resolveAudioStartPacket). When the chain still returns null (mid-file
      // zero-audio window, or a truly broken track), close the audio source so
      // the Output can produce video-only MEDIA segments — the Output treats
      // closed tracks as "done" (keyFrameQueuedEverywhere returns true for
      // closed tracks). NOTE: a zero-packet closed track is OMITTED from the
      // moov (mediabunny lazy-creates trackDatas on first sample) — a full
      // (non-skipInitSegment) window that skips audio under a 2-codec
      // SourceBuffer mime is a Chromium code-4 fatal. Layer 2 (probe-at-init)
      // prevents that for the init window; Layer 3 reroutes if it ever fires.
      let audioStartPacket: EncodedPacket | null = null;
      let audioSink: EncodedPacketSink | null = null;
      let audioSkipped = false;
      if (audioTrack && audioSource) {
        const audioKeyStart = performance.now();
        audioSink = new EncodedPacketSink(audioTrack);
        audioStartPacket = await this.resolveAudioStartPacket(audioSink, keyframeTimestamp, currentGeneration);
        console.log(`[Transmuxer] seekTo: audio start resolve took ${performance.now() - audioKeyStart}ms, result=${audioStartPacket ? 'found' : 'null (will skip audio)'}`);

        if (!audioStartPacket) {
          audioSource.close();
          audioSink = null;
          audioSkipped = true;
        }
      }
```

  (S3's captured generation variable is `currentGeneration` — verified in the seekTo
  catch block :1514.)

- [ ] **Step 2.4 — Delete the orphaned comment (:1640-1644, F7).** The doc comment
  "Iterate audio packets from the beginning (no key packet found near keyframe)…" sits
  above `getMseDecision()` and describes a helper (`iterateAudioPacketsFromStart`) that
  no longer exists. Replace:

```ts
  /**
   * Iterate audio packets from the beginning (no key packet found near keyframe).
   * Skips packets before keyframeTimestamp and clamps adjusted timestamps
   * to non-negative for the same reason as iterateAudioPackets.
   */
  getMseDecision(): MseCodecDecision {
```

with:

```ts
  getMseDecision(): MseCodecDecision {
```

- [ ] **Step 2.5 — Gates:**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app && npx tsc --noEmit && npx vitest run
```
Expected: tsc clean; **373/373** (366 baseline + 7 new). The existing suites pin the
happy path (D2): link 1 short-circuits, so cue-indexed seeks/refills return the identical
packet as before.

---

## Task 3 — Layer 2: probe-at-init (declare what you emit) + starvation counter

**Files:** Modify `app/src/lib/faststream/players/MediabunnyTransmuxer.ts` (3 regions).

Why: mime is decided at `init()` BEFORE any lookup runs (buildMimeType :516-541 →
`addSourceBuffer` useMSEPlayer:6836 → first lookup only at the prime seekTo). If the
default track can't resolve a start packet even via the chain, the SB must be born
video-only (`output.getMimeType()` is a deadlock pre-pump — B2 — so probe, don't await).

- [ ] **Step 3.1 — Add fields.** Below `private desiredAudioTrackId: number | null = null;` (:121), add:

```ts
  // Layer 3 support (audio-skip fix): audio packets actually emitted by the
  // current seekTo window. A 2-track window that emits ZERO audio packets
  // starves the SourceBuffer's buffered intersection (stall with no error
  // event) — the refill chain watches this via wasLastWindowAudioStarved().
  private windowAudioPacketsAdded = 0;
  private lastWindowAudioStarved = false;
```

  (No separate "unresolvable" flag: the probe communicates by nulling `audioTrack` —
  every downstream site keys off `audioCodec`/`audioTrackInfo`, and the hook reads
  `result.audioTrack`. A write-only flag would be dead code.)

- [ ] **Step 3.2 — Probe in the MKV init branch.** At :429-432, replace:

```ts
      const t3 = performance.now();
      diagLog(`[Transmuxer] init: calling resolveAudioTrack()`);
      const audioTrack = await this.resolveAudioTrack(this.input);
      diagLog(`[Transmuxer] init: resolveAudioTrack()=${audioTrack ? 'found' : 'null'} took ${((performance.now() - t3)/1000).toFixed(1)}s`);
```

with:

```ts
      const t3 = performance.now();
      diagLog(`[Transmuxer] init: calling resolveAudioTrack()`);
      let audioTrack = await this.resolveAudioTrack(this.input);
      diagLog(`[Transmuxer] init: resolveAudioTrack()=${audioTrack ? 'found' : 'null'} took ${((performance.now() - t3)/1000).toFixed(1)}s`);

      // Layer 2 (audio-skip fix): probe the audio START before declaring the
      // mime. The SourceBuffer is created from init()'s track inventory, but
      // whether audio can actually be EMITTED is only known after a start
      // lookup — for a cue-less MKV whose audio starts >0s the legacy lookup
      // returned null, audio was silently skipped, and the init segment
      // omitted the promised aac trak → Chromium code-4 fatal. Probe with the
      // same Layer-1 chain the windows use (head bytes are seed-cached, so
      // this costs one in-memory cluster read); if even the chain fails,
      // declare video-only NOW — every downstream site keys off audioCodec,
      // so the mime, setupOutput's addAudioTrack, and the window pumps all
      // stay consistent automatically.
      if (audioTrack) {
        const probeSink = new EncodedPacketSink(audioTrack);
        const probe = await this.resolveAudioStartPacket(probeSink, 0, this.seekGeneration);
        if (!probe) {
          diagLog('[Transmuxer] init: audio start UNRESOLVABLE (even via fallback chain) — declaring VIDEO-ONLY output');
          audioTrack = null;
        }
      }
```

  Downstream flow (verified, no further edits needed): `audioTrack = null` ⇒
  `this.audioCodec = null` (:435) ⇒ `buildMimeType` emits `video/mp4; codecs="<video>"`
  (:528) ⇒ `audioTrackInfo = null` (:465) ⇒ init result's `audioTrack: null` ⇒ S3's
  `audioSource` is null (:1430 `this.audioCodec ? … : null`) ⇒ `addAudioTrack` skipped
  (:1434) ⇒ no audio lookup ever runs. The TS init branch (:305-360) is NOT probed:
  its S1/S2 sites get the Layer-1 chain (near-start fallback), TS audio virtually always
  starts at/before the first video keyframe, and Layer 3 still catches the residue.

- [ ] **Step 3.3 — Starvation counter.** Three micro-edits:

  (a) In `seekTo`, directly after `this.seekGeneration++;` (:1234), add:

```ts
    // Layer-3 starvation watchdog: reset the per-window audio emission counter.
    this.windowAudioPacketsAdded = 0;
```

  (b) In `iterateAudioPackets`, inside the add path (:1631-1636), replace:

```ts
      if (isFirst) {
        await audioSource.add(adjusted, audioMeta);
        isFirst = false;
      } else {
        await audioSource.add(adjusted);
      }
```

with:

```ts
      if (isFirst) {
        await audioSource.add(adjusted, audioMeta);
        isFirst = false;
      } else {
        await audioSource.add(adjusted);
      }
      // NOTE (reviewer advisory): a superseded window's in-flight add() can
      // complete after a new seekTo reset this counter, leaking ≤1 stale
      // increment into the new window — delays the watchdog by one window at
      // worst, never a false fire (the flag write below is generation-gated).
      this.windowAudioPacketsAdded++;
```

  (c) In `seekTo`, directly after the iteration completes — after the line
  `console.log(`[Transmuxer] seekTo: iteration took ${performance.now() - iterStartTime}ms (audioSkipped=${audioSkipped})`);` (:1491) — add:

```ts
      // Zero-audio window signal (edge-A F5): a 2-track window is "starved"
      // when the output intended audio but ZERO audio packets were emitted —
      // either the start packet was null (audioSkipped) OR the resolved start
      // was already >= stopTime and the loop cut on iteration 1. The refill
      // chain converts consecutive starved windows into a Layer-3 reroute.
      // Generation-gated like finalize below: a superseded seek's write is
      // garbage (its reader bails on the chain-generation check anyway).
      if (currentGeneration === this.seekGeneration) {
        this.lastWindowAudioStarved =
          audioTrack !== null && this.audioCodec !== null && this.windowAudioPacketsAdded === 0;
      }
```

  (d) Public getter — insert directly ABOVE `getMseDecision(): MseCodecDecision {` (post-Task-2 text):

```ts
  /** True when the LAST seekTo window intended audio but emitted zero audio
   *  packets (zero-audio window — buffered-intersection starvation risk). */
  wasLastWindowAudioStarved(): boolean {
    return this.lastWindowAudioStarved;
  }
```

- [ ] **Step 3.4 — Gates:**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app && npx tsc --noEmit && npx vitest run
```
Expected: tsc clean, 373/373 (probe changes no test-covered signature; S1/S2/S3 behavior
for resolvable audio is unchanged by the `??` short-circuit).

---

## Task 4 — Layer 2: `planAudioSwitch` B4 guard (`sbHasAudio`) [TDD]

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts` (:352-370)
- Modify: `app/src/__tests__/AudioTrackSelection.test.ts`

Why: on a SB born video-only, switching INTO any audio track is a 1→2-trak track-set
change — illegal in every engine (MSE spec §changeType step 3.1; Chromium "Got
unexpected audio track"). `changeType` would succeed and the fatal would fire LATER at
the next init-segment append. The plan function must route such switches to
`'reroute-remux'`.

- [ ] **Step 4.1 — Write the failing tests.** In `AudioTrackSelection.test.ts`, append inside `describe('planAudioSwitch', …)`:

```ts
  it('video-only SB (Layer-2 birth) → ANY mkv switch reroutes via remux (B4)', () => {
    expect(planAudioSwitch({ tier: 'mkv', targetPlayable: true, sbHasAudio: false }))
      .toBe('reroute-remux');
    // even when mimes match and MSE supports the codec — the SB track SET is pinned
    expect(planAudioSwitch({
      tier: 'mkv', targetPlayable: true, sbHasAudio: false,
      currentMime: 'video/mp4; codecs="avc1.64001f"',
      newMime: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
      isTypeSupportedFn: () => true,
    })).toBe('reroute-remux');
  });
  it('sbHasAudio undefined/true → existing behavior unchanged (26-test matrix intact)', () => {
    expect(planAudioSwitch({ tier: 'mkv', targetPlayable: true, sbHasAudio: true }))
      .toBe('rebuild');
  });
```

- [ ] **Step 4.2 — Run, expect FAIL** (unknown arg is ignored → 'rebuild' for the first case):

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app && npx vitest run src/__tests__/AudioTrackSelection.test.ts
```

- [ ] **Step 4.3 — Implement.** In `useMSEPlayer.ts` `planAudioSwitch` (:352), add the arg
  and the guard as the FIRST tier-agnostic rule after the tier short-circuits:

```ts
export function planAudioSwitch(args: {
  tier: 'remux' | 'mkv' | 'mp4' | 'ts';
  targetPlayable: boolean;
  /** Combined-SB tiers only: current SB mime and the mime the new track needs. */
  currentMime?: string | null;
  newMime?: string | null;
  isTypeSupportedFn?: (mime: string) => boolean;
  /** Combined-SB tiers: false when the SourceBuffer was created WITHOUT an audio
   *  track (Layer-2 video-only birth). MSE pins the track set at the first init
   *  segment — adding audio later is illegal in every engine (B4), so any switch
   *  on such a SB must reroute via /remux?audio_idx. Omit on tiers with separate
   *  per-track SourceBuffers (mp4) or server-side switching (remux). */
  sbHasAudio?: boolean;
}): 'rebuild' | 'rebuild-changetype' | 'reroute-remux' | 'reject' {
  if (args.tier === 'ts') return 'reject'; // mpegts.js: no selection (scope cut)
  if (args.tier === 'remux') return 'rebuild'; // ffmpeg re-encodes → always AAC
  if (args.sbHasAudio === false) return 'reroute-remux'; // B4: track set is pinned
  if (!args.targetPlayable) return 'reroute-remux';
  if (args.currentMime && args.newMime && args.currentMime !== args.newMime) {
    const supported = args.isTypeSupportedFn
      ? args.isTypeSupportedFn(args.newMime)
      : (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(args.newMime));
    return supported ? 'rebuild-changetype' : 'reroute-remux';
  }
  return 'rebuild';
}
```

- [ ] **Step 4.4 — Run, expect PASS + full suite green:**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app && npx vitest run
```
Expected: 375/375 (+2). All 26 pre-existing AudioTrackSelection tests unchanged
(`sbHasAudio` undefined → guard skipped).

---

## Task 5 — Layer 3 prep: `mapAudioTrackToRemuxIdx` (id-namespace bridge) [TDD]

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts` (new exported pure fn, place directly after `withAudioIdx` :391)
- Modify: `app/src/__tests__/AudioTrackSelection.test.ts`

Why: track ids are tier-native (§5) — MKV menu ids are Matroska TrackNumbers
(mediabunny `track.id`), `/remux?audio_idx=` expects the ffprobe ABSOLUTE stream index.
Sending a raw MKV id degrades gracefully server-side (validate_audio_idx_override →
default track) but silently loses the user's choice. Map by POSITION among audio tracks
(MKV enumeration order ↔ ffprobe audio-stream order — both are container order).

- [ ] **Step 5.1 — Failing tests.** Append to `AudioTrackSelection.test.ts` (top-level):

```ts
describe('mapAudioTrackToRemuxIdx', () => {
  const mkv = [track({ id: 2 }), track({ id: 3 }), track({ id: 5 })]; // Matroska TrackNumbers
  const ff = [{ id: 1 }, { id: 2 }, { id: 4 }];                       // ffprobe absolute indices

  it('maps by position among audio tracks (MKV order ↔ ffprobe order)', () => {
    expect(mapAudioTrackToRemuxIdx(mkv, 2, ff)).toBe(1);
    expect(mapAudioTrackToRemuxIdx(mkv, 3, ff)).toBe(2);
    expect(mapAudioTrackToRemuxIdx(mkv, 5, ff)).toBe(4);
  });
  it('unknown MKV id → null (server falls back to default track)', () => {
    expect(mapAudioTrackToRemuxIdx(mkv, 99, ff)).toBeNull();
  });
  it('ffprobe list shorter than position → null (never sends a fabricated idx)', () => {
    expect(mapAudioTrackToRemuxIdx(mkv, 5, [{ id: 1 }])).toBeNull();
  });
  it('empty inputs → null', () => {
    expect(mapAudioTrackToRemuxIdx([], 1, ff)).toBeNull();
    expect(mapAudioTrackToRemuxIdx(mkv, 2, [])).toBeNull();
  });
});
```

  Add `mapAudioTrackToRemuxIdx` to the test file's import list from `'../hooks/useMSEPlayer'`.

- [ ] **Step 5.2 — Run, expect FAIL** (not exported).

- [ ] **Step 5.3 — Implement.** After `withAudioIdx` (:391) in `useMSEPlayer.ts`:

```ts
/**
 * Bridge the MKV tier's track-id namespace to the /remux tier's (§5 of the
 * reroute edge doc): MKV menu ids are Matroska TrackNumbers (mediabunny
 * track.id); /remux?audio_idx expects the ffprobe ABSOLUTE stream index.
 * Both lists enumerate audio tracks in container order, so map by POSITION.
 * Returns null when the mapping is unknowable — the server then falls back to
 * the default track (validated, never breaks playback). Pure + exported.
 */
export function mapAudioTrackToRemuxIdx(
  mkvTracks: AudioTrackInfo[],
  mkvTrackId: number,
  ffprobeTracks: { id: number }[],
): number | null {
  const pos = mkvTracks.findIndex(t => t.id === mkvTrackId);
  if (pos < 0) return null;
  return ffprobeTracks[pos]?.id ?? null;
}
```

- [ ] **Step 5.4 — Run, expect PASS:** `npx vitest run src/__tests__/AudioTrackSelection.test.ts` → all green (379 total after this task).

---

## Task 6 — Layer 3: parameterize `_recoverToRemuxTier` (D0 fix + flag hygiene)

**Files:** Modify `app/src/hooks/useMSEPlayer.ts` (:4430-4520).

Why (D0 — CRITICAL): `_recoverToRemuxTier` hardcodes `remuxSourceIsTsRef.current = true`
(:4478) — correct for TS sources (raw /stream bytes ARE MPEG-TS → byte-forward seeks
valid), WRONG for MKV (init-time MKV remux route sets `false` :3195 — "Matroska: ss-only
seeks"). If Layer 3 reused it as-is, a post-reroute user seek would treat Matroska bytes
as TS → garbage. Also #29: the cold-path failure branch leaves
`transmuxerInitInProgressRef` set (relies on `_initMpegtsPlayer`'s internal clears at
:4271/:4410 — add a defensive clear so future error events are never swallowed forever).

- [ ] **Step 6.1 — Signature + ref.** Replace (:4430-4434):

```ts
  const _recoverToRemuxTier = async (
    failedUrl: string,
    reason: string,
    resumeTime?: number,
  ): Promise<boolean> => {
```

with:

```ts
  const _recoverToRemuxTier = async (
    failedUrl: string,
    reason: string,
    resumeTime?: number,
    /** Whether the FILE's raw /stream bytes are real MPEG-TS (byte-forward
     *  start_byte remux seeks valid — TS tier). MKV/MP4 callers MUST pass
     *  false: their /stream bytes are Matroska/ISOBMFF, so post-recovery seeks
     *  must stay on ss-only /remux recreation (D0 in the regression doc). */
    sourceIsTs: boolean = true,
  ): Promise<boolean> => {
```

- [ ] **Step 6.2 — Consume it.** Replace (:4476-4478):

```ts
    // The raw /stream bytes of a TS file ARE real MPEG-TS → byte-forward
    // (start_byte) seeks are valid, exactly like timed_id3 (NOT like MKV/MP4).
    remuxSourceIsTsRef.current = true;
```

with:

```ts
    // TS sources: raw /stream bytes ARE real MPEG-TS → byte-forward
    // (start_byte) seeks are valid, exactly like timed_id3. MKV/MP4 sources
    // pass sourceIsTs=false: Matroska/ISOBMFF bytes would feed the TS demuxer
    // garbage, so seeks stay on the ss-only /remux recreate path (D0).
    remuxSourceIsTsRef.current = sourceIsTs;
```

- [ ] **Step 6.3 — Failure-path flag clear (#29).** In the cold-start failure branch (:4507-4512), replace:

```ts
    if (!ok) {
      diagLog(`[MPEGTS] Remux recovery (${reason}): recovered init FAILED — native last resort`);
      remuxRecoveryActiveRef.current = false;
      setIsColdStartBuffering(false);
      setColdStartPhase('none');
      return false;
    }
```

with:

```ts
    if (!ok) {
      diagLog(`[MPEGTS] Remux recovery (${reason}): recovered init FAILED — native last resort`);
      remuxRecoveryActiveRef.current = false;
      // Defensive: _initMpegtsPlayer clears this on its own failure paths
      // (:4271 success / :4410 catch), but if it ever returns false without
      // clearing, a stale true would swallow ALL future fatal video errors
      // (the error listener ignores errors while "init in progress").
      transmuxerInitInProgressRef.current = false;
      setIsColdStartBuffering(false);
      setColdStartPhase('none');
      return false;
    }
```

- [ ] **Step 6.4 — Existing callers unchanged** (default `true` preserves behavior):
  verify by grep. CORRECTION (found during implementation): there are THREE existing
  call sites, not two — mpegts FATAL handler, mpegts codec-unsupported handler, and the
  mpegts-init failure path. All are TS-tier and pass ≤3 args, so the default keeps them
  byte-identical:

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app/src && grep -n '_recoverToRemuxTier(' hooks/useMSEPlayer.ts
```
Expected: definition + exactly 3 call sites (all TS-tier, no 4th arg) — plus the new MKV
caller added in Task 7.

- [ ] **Step 6.5 — Gates:** `npx tsc --noEmit && npx vitest run` → clean, 379/379
  (TsHevcRecovery's 17 tests pin `planRemuxRecovery`, untouched).

---

## Task 7 — Layer 3: `_recoverMkvToRemuxTier` orchestrator + watchdog helper [TDD]

**Files:**
- Modify: `app/src/hooks/useMSEPlayer.ts`
- Create: `app/src/__tests__/MkvFatalReroute.test.ts`

- [ ] **Step 7.1 — Failing test for the pure watchdog rule.** Create `MkvFatalReroute.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { shouldTriggerZeroAudioReroute } from '../hooks/useMSEPlayer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Zero-audio starvation watchdog (Layer 3, B3/F5): a 2-track SourceBuffer whose
 * refill windows repeatedly emit ZERO audio packets stops growing `buffered`
 * (per-track intersection) and stalls playback with a healthy-looking pipeline
 * and NO error event. After 3 consecutive starved windows we treat it as fatal
 * and reroute to /remux. A video-only SB (Layer-2 birth) expects no audio —
 * the watchdog must stay silent there.
 */
describe('shouldTriggerZeroAudioReroute', () => {
  it('fires at 3 consecutive starved windows on an audio-declaring SB', () => {
    expect(shouldTriggerZeroAudioReroute(3, true)).toBe(true);
    expect(shouldTriggerZeroAudioReroute(4, true)).toBe(true);
  });
  it('stays silent below the threshold', () => {
    expect(shouldTriggerZeroAudioReroute(0, true)).toBe(false);
    expect(shouldTriggerZeroAudioReroute(1, true)).toBe(false);
    expect(shouldTriggerZeroAudioReroute(2, true)).toBe(false);
  });
  it('NEVER fires on a video-only SB (no audio was promised)', () => {
    expect(shouldTriggerZeroAudioReroute(3, false)).toBe(false);
    expect(shouldTriggerZeroAudioReroute(99, false)).toBe(false);
  });
});
```

- [ ] **Step 7.2 — Run, expect FAIL** (not exported).

- [ ] **Step 7.3 — Implement the pure helper.** In `useMSEPlayer.ts`, directly after
  `isSeekSuperseded` (:590), add:

```ts
/**
 * Zero-audio starvation watchdog rule (Layer 3 of the MKV audio-skip fix).
 * `consecutiveStarvedWindows` counts refill windows that intended audio but
 * emitted zero audio packets (transmuxer.wasLastWindowAudioStarved). On a
 * SourceBuffer that declared audio, 3 in a row means buffered (the per-track
 * intersection) has stopped growing — an invisible stall; reroute to /remux.
 * Pure + exported for testing.
 */
export function shouldTriggerZeroAudioReroute(
  consecutiveStarvedWindows: number,
  sbHasAudio: boolean,
): boolean {
  return sbHasAudio && consecutiveStarvedWindows >= 3;
}
```

- [ ] **Step 7.4 — Refs.** Next to `const mkvWarmerGenRef = useRef(0);` (:1753), add:

```ts
  // ── Layer-3 MKV fatal reroute state ──
  // Re-entrancy latch: a reroute is in flight (R1 — double-fatal from the same
  // dying pipeline must not start two recoveries).
  const mkvRerouteInFlightRef = useRef(false);
  // Whether the MKV combined SB was created WITH an audio track (Layer-2 birth
  // decision). Gates the starvation watchdog and the B4 switch guard.
  const mkvSbHasAudioRef = useRef(true);
  // Consecutive refill windows that intended audio but emitted zero packets.
  const zeroAudioWindowsRef = useRef(0);
  // Latest-instance mirror of _recoverMkvToRemuxTier: the video-error listener
  // is registered ONCE with [] deps (its closure is frozen at mount), so it —
  // and every other long-lived closure — must call through this ref.
  const recoverMkvRerouteRef = useRef<((reason: string) => Promise<boolean>) | null>(null);
```

- [ ] **Step 7.5 — Orchestrator.** Directly BELOW the end of `_recoverToRemuxTier`
  (after its closing `};` at :4520), add:

```ts
  /**
   * Layer-3 reroute for the MKV MediabunnyTransmuxer tier (audio-skip fix):
   * on a post-init fatal (video error 3/4, silent SB fatal, transmuxer
   * onError, zero-audio starvation, audio-switch onto a video-only SB), tear
   * down the dying transmuxer pipeline and hand the file to the PROVEN
   * /remux → mpegts.js tier (ffmpeg: video copy + AAC re-encode — cue-less
   * proof, reads linearly), resuming near the playhead. Replaces the old dead
   * end (useNative on raw MKV = black screen — WebView2 has no MKV demuxer).
   *
   * Teardown ORDER matters (§3 of the reroute edge doc): stop producers →
   * dispose transmuxer → detach OUR MediaSource blob (FastStreamPlayer
   * re-applies v.src = mseUrl on every render while it is non-null) → then
   * _recoverToRemuxTier (shared one-shot guard, G3 — a remux-tier fatal after
   * this reroute lands on 'skip' → native, never a loop).
   */
  const _recoverMkvToRemuxTier = async (reason: string): Promise<boolean> => {
    if (mkvRerouteInFlightRef.current) return false; // R1 re-entrancy latch
    if (cancelledRef.current) return false;
    const transmuxer = transmuxerRef.current;
    if (!transmuxer || formatRef.current !== 'mkv') return false;
    mkvRerouteInFlightRef.current = true;
    try {
      // 1. Capture the resume position BEFORE any teardown — video.error does
      //    NOT zero currentTime, but src='' does (§4).
      const video = videoRef.current;
      const resumeT = video?.currentTime ?? 0;
      diagLog(`[MSE] MKV fatal (${reason}) — rerouting to /remux tier from t=${resumeT.toFixed(1)}s`);

      // 2. Stop the dying pipeline (idioms from cleanup :2286-2327 and the
      //    audio-switch rebuild :5991-5995).
      stopStreamingChain();
      refillInProgressRef.current = false;
      burstBufferRef.current = [];
      seekBufferRef.current = [];
      bufferingForSeekRef.current = false;
      zeroAudioWindowsRef.current = 0;
      mkvWarmerGenRef.current++;          // in-flight warmer loop bails at next gen check
      mkvWarmerActiveRef.current = false;
      try { transmuxer.dispose(); } catch (_) {} // aborts in-flight seekTo (expected-error filtered)
      transmuxerRef.current = null;
      setIsTransmuxerActive(false);
      state.current.videoSourceBuffer?.destroy();
      state.current.audioSourceBuffer?.destroy();
      state.current.videoSourceBuffer = null;
      state.current.audioSourceBuffer = null;
      state.current.initialized = false;  // also blocks the MKV seek path (R2)

      // 3. Detach OUR MediaSource blob BEFORE mpegts.js takes the element:
      //    clear mseUrl first (stops FastStreamPlayer re-applying it), then
      //    revoke (idiom :2328-2334).
      const staleBlob = blobUrlRef.current;
      setMseUrl(null);
      if (staleBlob) {
        try { URL.revokeObjectURL(staleBlob); } catch (_) {}
        blobUrlRef.current = null;
      }

      // 4. Shared recovery: one-shot guard + element reset + cold-vs-seek
      //    decision (planRemuxRecovery: <8s → cold 'init' — the repro fatal
      //    fires at t≈0; ≥8s → 'seek' resume). sourceIsTs=false — Matroska
      //    bytes are NOT MPEG-TS (D0).
      const ok = await _recoverToRemuxTier(streamUrlRef.current ?? '', reason, resumeT, false);
      if (!ok) {
        diagLog(`[MSE] MKV reroute failed (${reason}) — native last resort`);
        setUseNative(true);
      }
      return ok;
    } finally {
      mkvRerouteInFlightRef.current = false;
    }
  };
  // Latest-instance mirror for frozen closures (video-error listener, refill
  // chain callbacks registered in earlier renders).
  recoverMkvRerouteRef.current = _recoverMkvToRemuxTier;
```

- [ ] **Step 7.6 — Ref hygiene in cleanups.** (a) In the per-file cleanup, after
  `setIsTransmuxerActive(false);` (:2299), add:

```ts
      mkvRerouteInFlightRef.current = false;
      mkvSbHasAudioRef.current = true;
      zeroAudioWindowsRef.current = 0;
```

  (b) In the unmount/full cleanup, after the matching `setIsTransmuxerActive(false);`
  (:2408), add the same 3 lines.

- [ ] **Step 7.7 — Gates:** `npx tsc --noEmit && npx vitest run` → clean; 382/382
  (+3 from Step 7.1). NOTE: `_recoverMkvToRemuxTier` exists but nothing calls it yet —
  behavior is still baseline. Task 8 wires the triggers.

---

## Task 8 — Layer 3: wire every detection point (D1-D4, B4, watchdog)

**Files:** Modify `app/src/hooks/useMSEPlayer.ts` (6 regions).

- [ ] **Step 8.1 — Video-error listener (D1/D2, stale-closure trap).** In `setVideoRef`
  (:9505-9517), replace:

```ts
          if (!cancelledRef.current && !useNative) {
            // Fall back to native for MP4/MSE errors AND mpegts.js fatal errors.
            // For mpegts.js, the FATAL handler in the ERROR event already destroyed
            // the player and set mpegtsPlayerRef.current = null. Falling back to
            // native playback uses the /remux/ endpoint to convert TS→MP4 server-side.
            if (mpegtsPlayerRef.current) {
              // mpegts.js player still active — the FATAL handler hasn't run yet.
              // This is a non-fatal error during mpegts.js playback (e.g., quota).
              // Let mpegts.js handle it internally (suspend/resume).
            } else {
              console.warn('[MSE] Fatal video error (code', err.code, ') — falling back to native playback');
              setUseNative(true);
            }
          }
```

with:

```ts
          if (!cancelledRef.current && !useNative) {
            // Fall back to native for MP4/MSE errors AND mpegts.js fatal errors.
            // For mpegts.js, the FATAL handler in the ERROR event already destroyed
            // the player and set mpegtsPlayerRef.current = null. Falling back to
            // native playback uses the /remux/ endpoint to convert TS→MP4 server-side.
            if (mpegtsPlayerRef.current) {
              // mpegts.js player still active — the FATAL handler hasn't run yet.
              // This is a non-fatal error during mpegts.js playback (e.g., quota).
              // Let mpegts.js handle it internally (suspend/resume).
            } else if (transmuxerRef.current && formatRef.current === 'mkv'
                       && !mkvRerouteInFlightRef.current) {
              // Layer-3 D1/D2 (audio-skip fix): post-init decode(3)/src(4) fatal
              // on the MKV transmuxer tier — e.g. CHUNK_DEMUXER_ERROR_APPEND_FAILED
              // "Initialization segment misses expected aac track". useNative on a
              // raw MKV is a dead player (WebView2 has no MKV demuxer); reroute to
              // /remux instead. This closure is frozen at mount ([] deps — `useNative`
              // above is the stale initial false forever), so ALL decisions here read
              // refs and the call goes through the latest-instance ref.
              console.warn('[MSE] Fatal video error (code', err.code, ') on MKV transmuxer tier — rerouting to /remux');
              void recoverMkvRerouteRef.current?.(`video error code ${err.code}`);
            } else if (mkvRerouteInFlightRef.current) {
              // R1: a reroute is ALREADY tearing this element down — the dying
              // pipeline can fire a second error (code 3 then 4) after
              // transmuxerRef was nulled. Falling through to setUseNative here
              // would stomp the in-flight recovery. Swallow it.
              console.warn('[MSE] Video error (code', err.code, ') during MKV reroute — ignoring (recovery owns the element)');
            } else {
              console.warn('[MSE] Fatal video error (code', err.code, ') — falling back to native playback');
              setUseNative(true);
            }
          }
```

  Residual accepted race (documented, matches the pre-existing mpegts-tier shape §9 R1):
  the SEEK-resume flavor of `_recoverToRemuxTier` dispatches
  `_mpegtsRecreatePlayerForRemuxSeek` without awaiting it, so `mkvRerouteInFlightRef`
  clears while the recreate still runs; an error in that sub-window lands on native via
  the one-shot — bounded, no loop. The repro's fatal (t≈0) always takes the fully-covered
  COLD path.

- [ ] **Step 8.2 — Transmuxer `onError` (D4).** In the MKV construction site (:6770-6775), replace:

```ts
      onError: (error: Error) => {
        if (cancelledRef.current) return;
        diagLog(`[MSE] MKV transmuxer ERROR: ${error.message}`);
        setError(error.message);
        setUseNative(true);
      },
```

with:

```ts
      onError: (error: Error) => {
        if (cancelledRef.current) return;
        diagLog(`[MSE] MKV transmuxer ERROR: ${error.message}`);
        // Layer-3 D4 (audio-skip fix): post-init transmuxer fatal (non-superseded
        // seekTo failure) fires while the video element may still be healthy —
        // reroute to /remux instead of the dead native path. During init
        // (initialized=false) keep the old behavior: init failure has its own
        // fall-through to the /remux branch in the format dispatcher.
        if (state.current.initialized && transmuxerRef.current
            && formatRef.current === 'mkv' && !mkvRerouteInFlightRef.current) {
          void recoverMkvRerouteRef.current?.(`transmuxer error: ${error.message}`);
          return;
        }
        setError(error.message);
        setUseNative(true);
      },
```

  (`onCodecUnsupported` is NOT wired: verified it only fires during `init()` —
  :444/:452/:485 — where the existing fall-through to /remux already handles it.)

- [ ] **Step 8.3 — SB-creation bookkeeping (Layer-2 output).** After
  `transmuxerRef.current = transmuxer;` / before `setIsTransmuxerActive(true);` (:6868-6869), add:

```ts
    // Layer 2: remember whether the SB was born WITH audio — gates the
    // starvation watchdog (video-only SB expects zero audio) and the B4
    // audio-switch guard (1→2-trak changes are illegal; must reroute).
    mkvSbHasAudioRef.current = !!result.audioTrack;
    zeroAudioWindowsRef.current = 0;
```

- [ ] **Step 8.4 — Pre-prime persisted-track guard (Layer-2 companion).** In the track-menu
  block, replace (:6901-6905):

```ts
        if (persisted != null && chosen && chosen.id === persisted && list.length > 1) {
          // Apply the persisted non-primary selection at init (before prime).
          const mime = await (transmuxer as any).setDesiredAudioTrack?.(persisted);
          if (!mime) diagLog('[AUDIO] mkv: persisted track failed to apply — primary used');
        }
```

with:

```ts
        // Layer-2 guards: (a) never resurrect audio on a SB born video-only —
        // selecting a track later goes through the switch path → B4 → reroute;
        // (b) if the persisted track's codec differs from the SB's declared
        // mime, changeType BEFORE the prime emits its init segment (legal
        // pre-first-append) or the init would contradict the declaration
        // (same fatal class this fix removes).
        if (persisted != null && chosen && chosen.id === persisted && list.length > 1
            && result.audioTrack) {
          const mime = await (transmuxer as any).setDesiredAudioTrack?.(persisted);
          if (!mime) {
            diagLog('[AUDIO] mkv: persisted track failed to apply — primary used');
          } else if (mime !== result.mimeType) {
            try {
              await state.current.videoSourceBuffer?.changeType(mime);
              diagLog(`[AUDIO] mkv: pre-prime changeType(${mime}) applied (persisted track codec differs)`);
            } catch (e: any) {
              diagLog(`[AUDIO] mkv: pre-prime changeType failed (${e?.message}) — reverting to primary track`);
              await (transmuxer as any).setDesiredAudioTrack?.(null);
            }
          }
        }
```

  KNOWN PRE-EXISTING RACE (do NOT widen scope): this whole menu block is
  fire-and-forget (`void (async () => …)()`) while the prime seekTo starts right after
  it — the persisted-track application can lose the race and land mid/after-prime. That
  race exists today (same-codec persisted tracks are benign; different-codec ones were
  ALREADY fatal via mime mismatch). The changeType added here fixes the different-codec
  case whenever the block wins the race and cannot make the lost-race case worse (it
  only fires when `mime !== result.mimeType`, which is broken today anyway). Awaiting
  the block before the prime is a separate change — out of scope.

- [ ] **Step 8.5 — Refill-chain D3 hooks + watchdog.** Three edits in `executeStreamingRefill`:

  (a) Entry check (:2588-2591) — split the fatal case out. Replace:

```ts
      if (!video || !transmuxer || !sb || video.ended || sb.hasFatalError) {
        refillInProgressRef.current = false;
        return;
      }
```

with:

```ts
      if (!video || !transmuxer || !sb || video.ended) {
        refillInProgressRef.current = false;
        return;
      }
      if (sb.hasFatalError) {
        // Layer-3 D3 (audio-skip fix): silent SourceBuffer fatal — some fatal
        // sequences (InvalidStateError on append, remove-during-eviction races)
        // kill the SB WITHOUT a video error event; today this returned silently
        // and playback stalled forever. Reroute MKV to /remux.
        if (formatRef.current === 'mkv' && transmuxerRef.current && !mkvRerouteInFlightRef.current) {
          diagLog('[MSE] SourceBuffer fatal detected in refill chain — rerouting MKV to /remux');
          void recoverMkvRerouteRef.current?.('silent SourceBuffer fatal');
        }
        refillInProgressRef.current = false;
        return;
      }
```

  (b) Zero-audio watchdog — inserted AFTER the stale-generation bail (a superseded
  refill's window must not count) — i.e. directly after the line
  `bufferingForSeekRef.current = false;` that follows the
  `if (chainGeneration !== streamingChainGenRef.current) { … return; }` block below the
  refill's seekTo (:2671-2677). Insert:

```ts
      // Layer-3 zero-audio starvation watchdog (B3/F5): count consecutive
      // windows that intended audio but emitted none; 3 in a row on an
      // audio-declaring SB = buffered intersection frozen → invisible stall.
      // ORDER IS LOAD-BEARING: starved=3 and noProgress=2 can land on the SAME
      // refill — this block must run BEFORE the isConfirmedEOF check below so
      // the reroute wins over endOfStream for a mid-file hole. Do not reorder.
      // NEAR-EOF SUPPRESSION: audio tracks commonly end slightly before video;
      // windows inside the last 30s legitimately emit zero audio and the
      // existing noProgress→endOfStream machinery (:2716-2754) must win there —
      // a reroute at true EOF would restart the file on tier 2 pointlessly.
      const durForHoleGuard = state.current.duration;
      const nearEofHole = durForHoleGuard > 0 && Number.isFinite(durForHoleGuard)
        && refillPosition >= durForHoleGuard - 30;
      if (keyframeTimestamp !== null && !nearEofHole
          && formatRef.current === 'mkv' && mkvSbHasAudioRef.current) {
        if ((transmuxer as MediabunnyTransmuxer).wasLastWindowAudioStarved()) {
          zeroAudioWindowsRef.current++;
          diagLog(`[MSE] MKV refill window emitted ZERO audio packets (${zeroAudioWindowsRef.current} consecutive)`);
        } else {
          zeroAudioWindowsRef.current = 0;
        }
        if (shouldTriggerZeroAudioReroute(zeroAudioWindowsRef.current, mkvSbHasAudioRef.current)
            && !mkvRerouteInFlightRef.current) {
          diagLog('[MSE] MKV zero-audio starvation confirmed — rerouting to /remux');
          void recoverMkvRerouteRef.current?.('zero-audio starvation');
          refillInProgressRef.current = false;
          return;
        }
      }
```

  (Type note — VERIFIED: `transmuxerRef` is the union
  `useRef<MediabunnyTransmuxer | MuxJsTsTransmuxer | null>` (:1690) and
  `MediabunnyTransmuxer` is imported as a value (:7). `wasLastWindowAudioStarved` exists
  only on MediabunnyTransmuxer; the `formatRef.current === 'mkv'` gate guarantees the
  instance is one, so the cast is sound. Keep the cast exactly as written — do NOT call
  it uncast on the union or tsc fails.)

  (c) Chain-continue check (:2833) — a fatal here silently STOPS rescheduling, so the
  entry-check reroute would never run. In the `finally` block, replace:

```ts
      const video = videoRef.current;
      const transmuxer = transmuxerRef.current;
      const sb = state.current.videoSourceBuffer;
      if (video && transmuxer && sb && !video.ended && !sb.hasFatalError && !isCompleteRef.current) {
```

with:

```ts
      const video = videoRef.current;
      const transmuxer = transmuxerRef.current;
      const sb = state.current.videoSourceBuffer;
      const sbFatal = !!sb?.hasFatalError;
      if (sbFatal && formatRef.current === 'mkv' && transmuxer && !mkvRerouteInFlightRef.current) {
        // Layer-3 D3: fatal discovered at chain-continue — without this the
        // chain stops rescheduling and the entry-check regains control never.
        diagLog('[MSE] SourceBuffer fatal at refill chain-continue — rerouting MKV to /remux');
        void recoverMkvRerouteRef.current?.('silent SourceBuffer fatal');
      }
      if (video && transmuxer && sb && !video.ended && !sbFatal && !isCompleteRef.current) {
```

  (d) User-seek counter reset — consecutive-starved counting must not span seek
  positions (3 starved windows at two different playheads are not one continuous hole).
  In the transmuxer seek execute, after the line pair (:8898-8900):

```ts
        // Stop streaming chain — new seek will start its own chain after completion
        stopStreamingChain();
        refillInProgressRef.current = false;
```

  add:

```ts
        zeroAudioWindowsRef.current = 0; // starvation watchdog: new position, fresh count
```

  (The comment line makes this site unique — the audio-switch rebuild :5991 has the same
  two calls without it.)

- [ ] **Step 8.6 — B4 reroute branch in `_switchMkvAudioTrack`.** Replace (:5974-5987):

```ts
    const plan = planAudioSwitch({
      tier: 'mkv',
      targetPlayable: track.playable,
      currentMime,
      newMime,
    });
    if (plan === 'reroute-remux' || plan === 'reject') {
      // MSE can't play the new codec in-place. Revert the transmuxer selection;
      // the reroute path (playing this file via /remux?audio_idx) is a phase-2
      // enhancement — for now surface failure so the UI reverts (E7/E8).
      diagLog(`[AUDIO] mkv switch: plan=${plan} (mime ${newMime} unsupported) — reverting`);
      await transmuxer.setDesiredAudioTrack(null);
      return false;
    }
```

with:

```ts
    const plan = planAudioSwitch({
      tier: 'mkv',
      targetPlayable: track.playable,
      currentMime,
      newMime,
      sbHasAudio: mkvSbHasAudioRef.current,
    });
    if (plan === 'reroute-remux') {
      // The combined SB cannot reach this track in-place — unsupported codec,
      // or the SB was born video-only (a 1→2-trak change is illegal in MSE,
      // B4). Reroute the WHOLE file to /remux?audio_idx=N: ffmpeg re-encodes
      // any track to AAC, so the user gets working audio on tier 2. Map the
      // MKV track id (Matroska TrackNumber) to the ffprobe stream index by
      // position; null (mapping unknown) degrades to the server default track.
      diagLog(`[AUDIO] mkv switch: plan=reroute-remux → switching via /remux tier (track ${trackId})`);
      const parsed = streamUrlRef.current ? parseStreamUrl(streamUrlRef.current) : null;
      let mappedIdx: number | null = null;
      if (parsed) {
        try {
          const resp = await fetch(`${parsed.baseUrl}/audio_tracks/${parsed.folderId}/${parsed.messageId}?token=${encodeURIComponent(parsed.token)}`);
          if (resp.ok) {
            const json = await resp.json();
            const ff = (Array.isArray(json?.tracks) ? json.tracks : []).map((s: any) => ({ id: s.index }));
            mappedIdx = mapAudioTrackToRemuxIdx(audioTracks, trackId, ff);
          }
        } catch (_) { /* mapping fetch failed — server default track */ }
      }
      remuxAudioIdxRef.current = mappedIdx;
      const ok = (await recoverMkvRerouteRef.current?.(`audio switch to track ${trackId}`)) ?? false;
      if (!ok) {
        // Revert the transmuxer's desired-track selection. LATENT (reviewer
        // advisory): on a video-only-birth SB this re-derives audioCodec to the
        // primary track (non-null) — harmless today because every reroute
        // failure ends in teardown + setUseNative, but if reroute-failure ever
        // becomes recoverable in-place, skip this revert when
        // mkvSbHasAudioRef.current === false.
        await transmuxer.setDesiredAudioTrack(null);
      }
      return ok;
    }
    if (plan === 'reject') {
      diagLog(`[AUDIO] mkv switch: plan=reject — reverting`);
      await transmuxer.setDesiredAudioTrack(null);
      return false;
    }
```

  Post-reroute continuity (verified, no extra code): `_loadRemuxAudioTracks` fires from
  the MEDIA_INFO handler because `remuxRecoveryActiveRef.current` is true (:3928-3930),
  repopulates the menu in the ffprobe namespace, and sets the active id from
  `remuxAudioIdxRef` (:5911-5916). The wrapper persists the MKV-namespace id per file
  (:6120-6124) — consistent, since the same file re-enters through the MKV tier on next
  load. `audioTracks` (state) is in scope inside the hook body.

- [ ] **Step 8.7 — Gates:**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app && npx tsc --noEmit && npx vitest run
```
Expected: tsc clean, 382/382.

---

## Task 9 — Full gates + manual e2e handoff

- [ ] **Step 9.1 — Full local gates:**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app && npx tsc --noEmit && npx vitest run
cd /d/DEVELOPMENT/Telegram-Drive/app/src-tauri && cargo test --no-default-features
```
Expected: tsc clean; vitest **382/382** (366 baseline + 7 chain + 2 B4 + 4 map + 3
watchdog); cargo **178/178** (no Rust change — any diff means an accidental edit).

- [ ] **Step 9.2 — Static sweep (no leftovers):**

```bash
cd /d/DEVELOPMENT/Telegram-Drive/app/src && grep -rn 'iterateAudioPacketsFromStart' . ; grep -n 'remuxSourceIsTsRef.current = true' hooks/useMSEPlayer.ts
```
Expected: first grep empty; second matches EXACTLY ONE line — :3086 (the timed_id3 TS
init path, where `true` is correct: that tier's /stream bytes ARE MPEG-TS). The line
inside `_recoverToRemuxTier` (:4478 pre-edit) must now read `= sourceIsTs`.

- [ ] **Step 9.3 — Hand to user for `tauri dev` e2e with the Inception MKV** (agent must
  NOT claim done before this). Expected observations:

| # | Scenario | Expectation |
|---|---|---|
| 1 | Cold open Inception MKV | Console: `[Transmuxer] audio start: fallback getFirstKeyPacket → 0.029s`. Audio PLAYS (Hindi default). NO `CHUNK_DEMUXER_ERROR_APPEND_FAILED`, no code-4, no useNative. |
| 2 | Seek ~60min | Seek completes with audio (mid-file link 1 succeeds via cluster walk). No starvation logs. |
| 3 | Audio-track switch Hindi↔English | Existing rebuild path works (`[AUDIO] mkv switch → track N complete`). 26-test suite behavior unchanged. |
| 4 | Known-good MKV (with cues) + a TS file | Zero behavior change (link-1 short-circuit). Abutting refills quiet (no PIPELINE_ERROR_DECODE at ~51s). |
| 5 | (If reproducible) force a post-init fatal | `[MSE] … rerouting to /remux` → playback resumes on mpegts.js near playhead; seeks use `/remux?ss=` (ss-only — verify NO byte-forward `start_byte` seeks: D0). |

- [ ] **Step 9.4 — DO NOT COMMIT.** Leave everything in the working tree; the user
  commits manually after e2e passes.

---

## Cross-validation ledger (plan-level — every signature opened at source during plan prep)

| # | Claim the plan relies on | Verified at |
|---|---|---|
| 1 | S1/S2/S3 skip sites shape exactly as quoted | MediabunnyTransmuxer.ts:916-923, :1026-1037, :1449-1476 (read 2026-08-02) |
| 2 | S1 gen var `generation` (:887), S2 `generation` (:966), S3 `currentGeneration` (declared :1269, used :1481/:1514) | same file, read |
| 3 | `EncodedPacketSink`/`EncodedPacket` already imported in transmuxer | imports :15-34 + usage at :904/:917 |
| 4 | `getKeyPacket(t, {verifyKeyPackets})`, `getFirstKeyPacket()` exist w/ null-on-before-start semantics | node_modules/mediabunny/src/media-sink.ts :172-196, :224-257 |
| 5 | Fallback idiom `getKeyPacket ?? getFirstKeyPacket` is the library's own | media-sink.ts:526-527 |
| 6 | All audio packets typed 'key' on MKV AND TS (getPacket link dead) | matroska-demuxer.ts:1468-1474; mpeg-ts-demuxer.ts:1136-1138, :1737-1739 |
| 7 | Cross-sink getNextKeyPacket throws | matroska-demuxer.ts:2049-2052, :2115-2118 |
| 8 | init() MKV branch: `const audioTrack` at :431 (→ `let`), codec derivation :434-448, buildMimeType video-only leg :528 | read |
| 9 | S3 audioSource gated on `this.audioCodec` (:1430) + addAudioTrack gated (:1434); S1 :897/:900, S2 :1007/:1010 | read |
| 10 | `iterateAudioPackets` add-path shape :1631-1636; stopTime cut BEFORE add :1621-1625 (F5) | read |
| 11 | Orphaned comment above getMseDecision :1640-1644 | read |
| 12 | `_recoverToRemuxTier` full body :4430-4520 incl. hardcoded `remuxSourceIsTsRef.current = true` :4478, failure branch :4507-4512 | read |
| 13 | `_initMpegtsPlayer` clears init flag on success :4271 and catch :4410 | read |
| 14 | MKV init route sets `remuxSourceIsTsRef.current = false` :3195 (the D0 contrast) | read |
| 15 | Video-error listener frozen closure `useCallback([], …)` :9485-9523; branch shape :9505-9517 | read |
| 16 | MKV onError construction site :6770-6775; onCodecUnsupported only fired from init (:444/:452/:485) | read + grep |
| 17 | Refill entry check :2588-2591; chain-continue condition w/ `!sb.hasFatalError` (:2833 region) | read |
| 18 | Refill seekTo anchor :2659; stale-gen bail :2671-2674; `bufferingForSeekRef.current = false` :2677 (watchdog anchor) | read |
| 19 | `_switchMkvAudioTrack` plan/revert region :5974-5987; `audioTracks` state in scope (used by `switchAudioTrack` :6099) | read |
| 20 | Track-menu pre-prime block :6876-6909, guard line :6901; `result` in closure scope | read |
| 21 | `SourceBufferWrapper.changeType` exists and is queued/awaitable | SourceBufferWrapper.ts:257 (grep) + used at :5999 |
| 22 | SB creation + `transmuxerRef.current = transmuxer` anchor :6836-6869 | read |
| 23 | Cleanup reset anchors: per-file `setIsTransmuxerActive(false)` :2299, full :2408; warmer idiom :2326-2327; blob revoke idiom :2328-2334 | read |
| 24 | `_loadRemuxAudioTracks` gate on `remuxRecoveryActiveRef` :3928-3930; active-id from `remuxAudioIdxRef` :5911-5916; `/audio_tracks` returns `tracks[].index` | read |
| 25 | `planRemuxRecovery` 'skip'/'seek'(≥8s)/'init' logic :239-254; `clampSeekTime` exists :50 | read |
| 26 | New helpers (`resolveAudioStartPacket`, `mapAudioTrackToRemuxIdx`, `shouldTriggerZeroAudioReroute`, `_recoverMkvToRemuxTier`, refs) are GREENFIELD — zero matches repo-wide | grep 2026-08-02 |
| 27 | Vitest baseline 366/366 (22 files), cargo 178/178, tsc clean | executed 2026-08-01 |
| 28 | Instance-based private-method test pattern precedent | `__tests__/snapToCueKeyframe.test.ts` (constructs MediabunnyTransmuxer, injects privates via `as any`) |
| 29 | `/remux` server side needs NO change (audio_idx validation :2534, per-idx cache :2524, h264 `-c:v copy` :2270-2275) | server.rs (read during research phase) |

**Runtime-only unknowns (spike items, not "verified"):** actual Chromium behavior of the
starvation watchdog threshold (3 windows ≈ 15s of hole — tunable), and the reroute UX on
a real mid-playback fatal — both exercised only in the user's e2e (Step 9.3 #5).

## Risk notes / rollback

- Each task compiles + passes gates independently; revert = drop the working-tree diff
  (nothing committed).
- L1 is a strict superset of current behavior (`??` short-circuit) — the only new code
  path runs where today's code ALREADY fails (null start → skip).
- L2 changes the SB birth ONLY when the probe fails — i.e. files that today die with
  code-4. Worst case: a probe false-negative births video-only where audio was possible;
  the menu → B4 → reroute still delivers audio via tier 2.
- L3 consumes the shared one-shot (`remuxRecoveryAttemptedRef`) — a second fatal after a
  reroute lands on 'skip' → native (bounded, no loop — G3).
- Watchdog misfire risk is bounded by the 3-consecutive-windows rule + `mkvSbHasAudioRef`
  gate + one-shot guard.
