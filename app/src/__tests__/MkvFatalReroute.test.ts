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
