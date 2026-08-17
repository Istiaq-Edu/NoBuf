// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { decideRemuxColdStartSeed } from '../hooks/useMSEPlayer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Defect B (22-t.md:76 → :177): the HEVC-MKV remux route drains its cached
 * 6 MiB prefix at 15:44:28, but the proactive producer is only admitted at
 * 15:44:30 and its first sequential chunk lands ~15:44:30.9. For ~2.9s NO
 * Telegram producer exists — /stream is in cached_prefix mode, which is
 * structurally forbidden from falling back (server.rs:1714-1716) and only
 * waits (STREAM-CACHE-WAIT, 22-t.md:195). session_downloaded_bytes freezes,
 * so the 3s sliding window in speedMeter decays to a hard 0 → "speed goes to
 * none, then up again".
 *
 * The eager reporter already exists (startProactivePositionReporter, :269) but
 * sits at :5438, downstream of `await MEDIA_INFO` → `await coldStartDeferred`
 * → `await player.play()`, so it cannot fire until 15:44:30 — after the prefix
 * is already drained. The seed has to be dispatched at the routing seam.
 */
describe('decideRemuxColdStartSeed — producer handoff at the routing seam', () => {
  const seam = {
    fileId: 108,
    fileSize: 1_467_894_377,
    paused: false,
  };

  it('seeds the proactive producer at the routing seam', () => {
    expect(decideRemuxColdStartSeed(seam)).toEqual({
      seed: true,
      byteOffset: 0,
      isPlayerDownloading: false,
    });
  });

  it('reports the player as idle so the backend does not defer the spawn', () => {
    // should_defer_proactive_spawn(is_player_downloading) at streaming.rs:1967
    // returns early on true — an eager seed claiming "downloading" defeats itself.
    expect(decideRemuxColdStartSeed(seam).isPlayerDownloading).toBe(false);
  });

  it('sends an explicit byte offset so the bootstrap defer cannot swallow the seed', () => {
    // streaming.rs:1996-2006: when byte_offset.is_none() and the cache has no
    // ranges yet, the command returns Ok(false) and no producer starts. A
    // null offset here would reproduce the exact gap this fix removes.
    expect(decideRemuxColdStartSeed(seam).byteOffset).toBe(0);
    expect(decideRemuxColdStartSeed(seam).byteOffset).not.toBeNull();
  });

  it('respects "paused means paused" and does not seed a background producer', () => {
    expect(decideRemuxColdStartSeed({ ...seam, paused: true })).toEqual({
      seed: false,
      byteOffset: null,
      isPlayerDownloading: false,
    });
  });

  it('does not seed without a usable file identity or size', () => {
    expect(decideRemuxColdStartSeed({ ...seam, fileId: undefined }).seed).toBe(false);
    expect(decideRemuxColdStartSeed({ ...seam, fileSize: 0 }).seed).toBe(false);
  });

  /**
   * Bounded no-gap lifecycle: the seed and the periodic reporter share
   * ownership, so the invariant is "some producer is admitted before the
   * cached prefix drains", asserted across the real timeline — not "the
   * scheduler fires", which is already true at HEAD and proves nothing.
   */
  it('admits a producer before the cached prefix drains', () => {
    // Seconds relative to 22-t.md 15:44:20 (click).
    const PREFIX_DRAINED_AT = 8;   // :76 prefetch complete 15:44:28
    const MEDIA_INFO_AT = 10;      // :149 pipeline initialized 15:44:30

    const seedAt = 8;              // routing seam, :78 15:44:28
    const periodicAt = MEDIA_INFO_AT;

    const decision = decideRemuxColdStartSeed(seam);
    expect(decision.seed).toBe(true);

    // The periodic owner alone leaves a real gap; the seed must close it.
    expect(periodicAt).toBeGreaterThan(PREFIX_DRAINED_AT);
    expect(seedAt).toBeLessThanOrEqual(PREFIX_DRAINED_AT);
  });
});

describe('the eager seed is wired into the shipped MKV remux route', () => {
  const source = readFileSync(`${process.cwd()}/src/hooks/useMSEPlayer.ts`, 'utf8');

  it('dispatches the seed at the MKV→remux seam, before the player is created', () => {
    const routeIdx = source.indexOf("diagLog(`[MSE] mkv (${mkvCodec}) — routing to ffmpeg remux");
    const initIdx = source.indexOf('await _initMpegtsPlayer(remuxUrl', routeIdx);
    const seedIdx = source.indexOf('decideRemuxColdStartSeed({', routeIdx);

    expect(routeIdx).toBeGreaterThan(0);
    expect(seedIdx).toBeGreaterThan(routeIdx);
    // Must run before mpegts.js init, which is where the awaits begin.
    expect(seedIdx).toBeLessThan(initIdx);
  });

  it('passes the decision through to cmd_report_playback_position', () => {
    // Scope to the CALL SITE, not the helper definition above it.
    const routeIdx = source.indexOf("diagLog(`[MSE] mkv (${mkvCodec}) — routing to ffmpeg remux");
    const seedIdx = source.indexOf('decideRemuxColdStartSeed({', routeIdx);
    const block = source.slice(seedIdx, source.indexOf('await _initMpegtsPlayer(remuxUrl', seedIdx));
    expect(block).toContain("invoke('cmd_report_playback_position'");
    expect(block).toContain('byteOffset: seed.byteOffset');
    expect(block).toContain('isPlayerDownloading: seed.isPlayerDownloading');
    // Tauri requires every declared key present — a missing playbackRate makes
    // the whole invoke throw ("missing required key playbackRate").
    expect(block).toContain('playbackRate:');
  });

  it('keeps the periodic reporter as the ongoing lifecycle owner', () => {
    expect(source).toContain('const proactiveInterval = startProactivePositionReporter({');
  });
});
