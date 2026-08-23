/**
 * Download-speed meter — pure math, no React.
 *
 * Source of truth: the Rust backend's per-message cumulative counter
 * `session_downloaded_bytes` (StreamCacheManager), incremented ONLY at
 * iter_download chunk arrivals — i.e. bytes that physically arrived from
 * Telegram this session. Disk-cache HITs never touch it, so this meter
 * cannot count local reads (dash.js cache-exclusion principle).
 *
 * The frontend polls that counter (existing 500ms cmd_get_cache_status poll)
 * and computes a windowed rate as a cumulative diff:
 *
 *     speed = (bytes_last − bytes_first) / (t_last − t_first)
 *
 * over a 3s sliding window. This is exact under polling jitter and has none
 * of the per-interval-delta pathologies the old implementation had
 * (systematic N/(N−1) inflation: +10% steady state, +100% first reading).
 *
 * Honesty guarantees:
 *  - hard 0 after SPEED_STALL_MS without counter growth (network stall must
 *    read "—", not a frozen last-good speed)
 *  - reset guard: counter drop (cache deleted / session restart) clears the
 *    window instead of producing negative garbage
 *  - noise floor: sub-500 B/s readings render as 0 to avoid flicker
 *
 * Window/params informed by hls.js (fast EWMA half-life 3s), dash.js (3s),
 * Shaka (2s) — see .hermes/plans/2026-07-28_speed-meter-backend-counter.md.
 */

export interface SpeedSample {
  /** Sample timestamp, ms (Date.now()) */
  t: number;
  /** Cumulative Telegram bytes downloaded at that instant */
  bytes: number;
}

/** Sliding window span, ms */
export const SPEED_WINDOW_MS = 3000;
/** Counter unchanged for this long → report 0, ms */
export const SPEED_STALL_MS = 3000;
/** Require at least this much time coverage before reporting, ms */
export const SPEED_MIN_DT_MS = 900;
/** Readings below this render as 0 (bytes/sec) */
export const SPEED_NOISE_FLOOR_BPS = 500;

/**
 * Append a cumulative-counter sample and maintain the window invariants:
 * reset guard (counter went backwards → clear) and window trim.
 * Mutates `samples` in place (callers hold it in a ref).
 */
export function pushSample(samples: SpeedSample[], t: number, bytes: number): void {
  if (samples.length > 0 && bytes < samples[samples.length - 1].bytes) {
    // Counter reset (cache deleted mid-session / backend restart):
    // start a fresh series instead of computing a negative rate.
    samples.length = 0;
  }
  samples.push({ t, bytes });
  while (samples.length > 0 && samples[0].t < t - SPEED_WINDOW_MS) {
    samples.shift();
  }
}

/**
 * Windowed download speed in bytes/sec from cumulative samples.
 * Returns 0 when: <2 samples, window coverage below SPEED_MIN_DT_MS,
 * no counter growth for SPEED_STALL_MS, or result under the noise floor.
 */
export function computeWindowSpeed(samples: SpeedSample[], nowMs: number): number {
  if (samples.length < 2) return 0;

  // Find the most recent instant the counter actually grew.
  let lastGrowth = -1;
  for (let i = samples.length - 1; i >= 1; i--) {
    if (samples[i].bytes > samples[i - 1].bytes) {
      lastGrowth = samples[i].t;
      break;
    }
  }
  if (lastGrowth < 0 || nowMs - lastGrowth > SPEED_STALL_MS) return 0;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const dtMs = last.t - first.t;
  if (dtMs < SPEED_MIN_DT_MS) return 0;

  const bps = ((last.bytes - first.bytes) / dtMs) * 1000;
  return bps < SPEED_NOISE_FLOOR_BPS ? 0 : bps;
}

/**
 * Value the control-bar meter renders. "paused means paused": when the user
 * paused prefetch, show nothing regardless of residual in-flight bytes.
 * Returns 0 → caller renders the "—" placeholder.
 */
export function speedMeterValue(speedBps: number, prefetchPaused: boolean): number {
  if (prefetchPaused) return 0;
  return speedBps > 0 ? speedBps : 0;
}

/** Human-readable bytes/sec (binary units, one decimal above B/s). */
export function formatSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}
