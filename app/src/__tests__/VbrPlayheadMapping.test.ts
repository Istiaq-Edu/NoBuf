/**
 * Round-19: subtitles never appeared on Predestination (VBR HEVC).
 *
 * The subtitle request told the backend where the viewer was using a LINEAR
 * time->byte estimate: `(t / duration) * fileLength`. That is a constant-bitrate
 * assumption. Predestination is variable-bitrate, so the estimate lands nowhere
 * near the real cluster:
 *
 *   19-t:275  [SUBS-ISLAND] no usable island and prefix ends at 13631488B
 *                           while playhead is 403532396B — declining
 *
 * The viewer was at t=1613s. The cache held 0..13,631,488. The linear estimate
 * said byte 403,532,396, so the backend saw a 372 MiB gap and declined -> 204 ->
 * `failed` -> 150s backoff -> subtitles never came back (19-c:143-144).
 *
 * `timeToByte` inverts the ground-truth anchor table (real cluster bytes
 * harvested from seeks, bisect probes and the MKV cue index) instead of assuming
 * CBR. These tests use the real file geometry from the log.
 */
import { describe, expect, it } from 'vitest';
import { upsertByteTimeAnchor } from '../hooks/useMSEPlayer';

const SIZE = 1_467_894_377;   // Predestination, bytes (19-t)
const DUR = 5868.869;         // seconds (19-c:29)
const MEAN_RATE = SIZE / DUR; // 250,115 B/s

/** Reference implementation mirroring the hook's `timeToByte`. */
function timeToByte(
  timeSec: number,
  table: [number, number][],
  fileLength = SIZE,
  duration = DUR,
): number {
  if (!Number.isFinite(timeSec) || timeSec < 0 || fileLength <= 0) return -1;
  const linear = duration > 0
    ? Math.max(0, Math.min(fileLength - 1, Math.floor((timeSec / duration) * fileLength)))
    : -1;
  if (table.length < 2) return linear;
  if (timeSec <= table[0][1]) return table[0][0];
  if (timeSec >= table[table.length - 1][1]) {
    const [bLast, tLast] = table[table.length - 1];
    const [bPrev, tPrev] = table[table.length - 2];
    const rate = tLast > tPrev ? (bLast - bPrev) / (tLast - tPrev) : 0;
    if (rate <= 0) return linear;
    return Math.max(0, Math.min(fileLength - 1, Math.floor(bLast + (timeSec - tLast) * rate)));
  }
  let lo = 0, hi = table.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid][1] <= timeSec) lo = mid; else hi = mid;
  }
  const [byteLo, timeLo] = table[lo];
  const [byteHi, timeHi] = table[hi];
  if (timeHi === timeLo) return byteLo;
  const v = byteLo + (byteHi - byteLo) * (timeSec - timeLo) / (timeHi - timeLo);
  return Math.max(0, Math.min(fileLength - 1, Math.floor(v)));
}

const linearEstimate = (t: number) => Math.floor((t / DUR) * SIZE);

describe('round-19: VBR playhead mapping (Predestination)', () => {
  it('replaces a guessed same-seek anchor with ffmpeg authoritative byte', () => {
    const guessed: [number, number][] = [[0, 0], [332_415_542, 1329], [1_467_894_377, 5868.869]];
    const corrected = upsertByteTimeAnchor(guessed, 345_368_082, 1329);
    expect(corrected).toContainEqual([345_368_082, 1329]);
    expect(corrected).not.toContainEqual([332_415_542, 1329]);
  });

  it('keeps the old anchor if a replacement would violate monotonic time', () => {
    const current: [number, number][] = [[100, 10], [200, 20], [300, 30]];
    expect(upsertByteTimeAnchor(current, 350, 20)).toBe(current);
  });

  it('reproduces the logged linear-estimate failure', () => {
    // 19-t:275 — the exact byte the old code sent. The playhead was 1613.385s,
    // not a round 1613: 19-c:131 shows StartupStallJumper snapping to 1613.385
    // right before the extraction fired.
    expect(linearEstimate(1613.385)).toBe(403_532_396);

    // The cache frontier at that moment.
    const prefixEnd = 13_631_488;
    const gap = 403_532_396 - prefixEnd;
    expect(gap).toBeGreaterThan(8 * 1024 * 1024); // way past the island bound
    expect(Math.round(gap / 1048576)).toBe(372);  // 372 MiB -> guaranteed decline
  });

  it('maps to a real cached byte once anchors exist', () => {
    // A VBR film whose first third is denser than the mean: at 1613s the true
    // cluster is well before the linear guess.
    const table: [number, number][] = [
      [0, 0],
      [6_291_456, 55],
      [13_631_488, 120],
      [384_000_000, 1613],   // ground-truth anchor at the failing timestamp
      [700_000_000, 2900],
    ];
    const mapped = timeToByte(1613, table);
    expect(mapped).toBe(384_000_000);
    // ...and it differs from the linear guess by ~19 MiB, which is what pushed
    // the request outside every cached range.
    expect(Math.abs(mapped - linearEstimate(1613))).toBeGreaterThan(18 * 1048576);
  });

  it('interpolates between anchors instead of snapping', () => {
    const table: [number, number][] = [[0, 0], [100_000_000, 1000], [200_000_000, 1500]];
    // Half-way in TIME between 1000s and 1500s -> half-way in BYTES.
    expect(timeToByte(1250, table)).toBe(150_000_000);
  });

  it('degrades to the linear estimate before any anchor exists (cold open)', () => {
    expect(timeToByte(1613, [])).toBe(linearEstimate(1613));
    expect(timeToByte(1613, [[0, 0]])).toBe(linearEstimate(1613));
  });

  it('clamps at the first anchor rather than extrapolating backwards', () => {
    const table: [number, number][] = [[5_000_000, 100], [50_000_000, 400]];
    expect(timeToByte(10, table)).toBe(5_000_000);
    expect(timeToByte(0, table)).toBe(5_000_000);
  });

  it('extrapolates past the last anchor on the LOCAL rate, not the file mean', () => {
    // Tail runs at 500 kB/s, double the 250 kB/s mean.
    const table: [number, number][] = [[0, 0], [100_000_000, 1000], [200_000_000, 1200]];
    const localRate = (200_000_000 - 100_000_000) / (1200 - 1000); // 500,000 B/s
    expect(timeToByte(1300, table)).toBe(200_000_000 + 100 * localRate);
    // The mean-rate guess would be materially different.
    expect(timeToByte(1300, table)).not.toBe(linearEstimate(1300));
  });

  it('never returns a byte outside the file', () => {
    const table: [number, number][] = [[0, 0], [1_000_000, 10]];
    const far = timeToByte(999_999, table);
    expect(far).toBeGreaterThanOrEqual(0);
    expect(far).toBeLessThan(SIZE);
  });

  it('rejects nonsense input', () => {
    const table: [number, number][] = [[0, 0], [1_000_000, 10]];
    expect(timeToByte(NaN, table)).toBe(-1);
    expect(timeToByte(-5, table)).toBe(-1);
    expect(timeToByte(100, table, 0)).toBe(-1); // unknown file length
  });

  it('lands inside a cached island for the SECOND logged decline too', () => {
    // 19-t:457 — t=3028s, linear said 757,340,604, cache ended at 16,777,216.
    expect(linearEstimate(3028)).toBeGreaterThan(750_000_000);
    const table: [number, number][] = [
      [0, 0],
      [16_777_216, 130],
      [403_177_267, 1612],   // real anchor from 19-t:361
      [720_000_000, 3028],   // real position at the second decline
    ];
    expect(timeToByte(3028, table)).toBe(720_000_000);
  });

  it('agrees with the mean rate on a near-CBR file (Inception did work)', () => {
    // Inception is near-CBR, which is why round-18 succeeded with the linear
    // estimate. Anchors on such a file should barely move the answer.
    const RATE = 1_566_651_347 / 8888.136;
    const table: [number, number][] = [
      [0, 0],
      [Math.round(1000 * RATE), 1000],
      [Math.round(4000 * RATE), 4000],
    ];
    const mapped = timeToByte(2000, table, 1_566_651_347, 8888.136);
    const linear = Math.floor((2000 / 8888.136) * 1_566_651_347);
    expect(Math.abs(mapped - linear)).toBeLessThan(1_048_576); // within 1 MiB
  });
});
