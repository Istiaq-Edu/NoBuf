import { describe, it, expect, vi } from 'vitest';
import { computeSeekReportByte, SEEK_BYTE_BACKOFF } from '../hooks/useMSEPlayer';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

/**
 * Round-9 Fix 1a (I-2): PROACTIVE anchored at the frontend linear estimate —
 * reported byte = seekTime x avgBitrate - 2MiB, byte-exact on 3/3 events in 9-t,
 * while the bisect had already located the TRUE cluster byte (seek #2:
 * injected 738,217,347 vs reported 753,127,152 → 14.2MiB anchor error → the
 * post-bisect walk paid it all at Telegram rate). The fix re-reports the
 * bisected cluster byte at seek completion through the same backoff helper.
 *
 * computeSeekReportByte is the pure core: backoff (download must start at or
 * before mediabunny's first real read — EBML header bytes precede the cluster
 * byte, and find_best_covering_download needs download.start <= read.start)
 * plus the 0 clamp.
 */
describe('computeSeekReportByte (round-9 I-2)', () => {
  it('backs off the bisected cluster byte by SEEK_BYTE_BACKOFF (2MiB)', () => {
    // Seek #2's real injected cluster byte from 9-c.
    expect(computeSeekReportByte(738_217_347)).toBe(738_217_347 - 2 * 1024 * 1024);
  });

  it('exports the 2MiB backoff constant', () => {
    expect(SEEK_BYTE_BACKOFF).toBe(2 * 1024 * 1024);
  });

  it('clamps to 0 when the byte is smaller than the backoff (near file start)', () => {
    expect(computeSeekReportByte(1_000_000)).toBe(0);
    expect(computeSeekReportByte(0)).toBe(0);
  });

  it('floors fractional input (linear estimates are float math)', () => {
    expect(computeSeekReportByte(753_127_152.7)).toBe(753_127_152 - 2 * 1024 * 1024);
  });

  it('honors a custom backoff argument', () => {
    expect(computeSeekReportByte(10 * 1024 * 1024, 1024)).toBe(10 * 1024 * 1024 - 1024);
  });
});
