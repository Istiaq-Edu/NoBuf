// MKV cluster bisection engine — shared by the thumbnail pipeline (far hover)
// and MediabunnyTransmuxer.seekTo (cue-less far SEEK, round-6).
//
// Round-3 Fix C introduced bisect-inject-capture for cue-less MKV far hovers
// (reports/research/round3-solution.md); round-4 added interpolation probing +
// in-buffer last-cluster advance; round-5 fixed the bracket-step spin and added
// the walkable-gap stop. Round-6 (reports/research/round6-log-forensics.md)
// extracted the engine here because the PLAYER seek path needed it too: a
// cue-less MKV seek outside the harvested index fell into mediabunny's raw
// getKeyPacket linear cluster walk — 6-t showed 83.9MB in 43s (1.95MB/s) with
// ~800MB left to walk for a 2819.9s target ≈ 7 minutes of frozen player. The
// user killed the app. Bisection bounds that to ~3-6 ranged probes + a ≤16MB
// residual walk.
//
// All reach-in helpers (readMkvTimestampFactor & co.) are guarded: shape drift
// in the vendored demuxer ⇒ null/false ⇒ callers degrade to the previous
// unbounded-walk/skip behavior, never throw.

const MKV_CLUSTER_ID = 0x1f43b675;
/** Stop bisecting once best + next-above bracket ≤ this gap — the residue is
 *  one cluster's interior; the subsequent walk reads those bytes anyway
 *  (5-t: 16 probes wasted on a 12.58MB monster-cluster interior). */
const BISECT_WALKABLE_GAP_BYTES = 16 * 1024 * 1024;

/** Round-7 keyframe shadow: getKeyPacket's forward-only walk fails when the
 *  closest cache entry ≤ target sits AFTER the last keyframe before the target
 *  (up to one GOP wide). Bisect for target − shadow so the injected entry lands
 *  behind that keyframe. Clamps: floor 12s (partial-index GOP bound used across
 *  the player), cap 35s (max cluster span; keeps the residual walk bounded). */
export const SEEK_SHADOW_DEFAULT_S = 15;
export const SEEK_SHADOW_MIN_S = 12;
export const SEEK_SHADOW_MAX_S = 35;
/** EBML IDs legal as Cluster children (vendored demuxer's handled set):
 *  Timestamp, CRC-32, SilentTracks, Position, PrevSize, SimpleBlock, BlockGroup. */
const MKV_CLUSTER_CHILD_IDS = new Set([0xe7, 0xbf, 0x5854, 0xa7, 0xab, 0xa3, 0xa0]);

/** Parse an EBML vint at `pos`: returns value + width, or null. `keepMarker`
 *  keeps the length-descriptor bit (element IDs are stored WITH the marker). */
function readVint(buf: Uint8Array, pos: number, keepMarker: boolean): { value: number; width: number } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (first === 0) return null;
  let width = 1;
  for (let mask = 0x80; !(first & mask); mask >>= 1) width++;
  if (width > 8 || pos + width > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> width);
  for (let i = 1; i < width; i++) value = value * 256 + buf[pos + i];
  return { value, width };
}

/** True when the size vint at `pos` is the EBML unknown-size marker (all
 *  value bits set, any width — e.g. 0xFF, 0x01FF..FF). */
function isUnknownSize(buf: Uint8Array, pos: number): boolean {
  const v = readVint(buf, pos, false);
  if (!v) return false;
  const first = buf[pos];
  const valueBitsFirst = first & (0xff >> v.width);
  if (valueBitsFirst !== (0xff >> v.width)) return false;
  for (let i = 1; i < v.width; i++) if (buf[pos + i] !== 0xff) return false;
  return true;
}

/** Sync-scan a fetched window for a VALIDATED MKV Cluster and read its 0xE7
 *  Timestamp. Validation (verify-c H-C1e): plausible size vint (or unknown-size
 *  marker), child-walk with only legal Cluster-child IDs until 0xE7 (CRC-32 is
 *  commonly first — R11), ticks within [loTicks-slack, hiTicks+slack]. False
 *  positives continue the scan. Returns ABSOLUTE file position of the ID's
 *  first byte (the demuxer parses the header at exactly that byte). */
export function scanForMkvClusterInWindow(
  buf: Uint8Array,
  windowFileOffset: number,
  loTicks: number,
  hiTicks: number,
  slackTicks: number,
): { elementStartPos: number; timestampTicks: number } | null {
  const MAX_DEFINED_SIZE = 256 * 1024 * 1024; // clusters beyond 256MB are implausible
  outer:
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0 !== MKV_CLUSTER_ID) continue;
    const sizePos = i + 4;
    const size = readVint(buf, sizePos, false);
    if (!size) continue;
    if (!isUnknownSize(buf, sizePos) && size.value > MAX_DEFINED_SIZE) continue;
    // Child-walk from data start until we hit Timestamp (0xE7) or run out.
    let p = sizePos + size.width;
    for (let child = 0; child < 8 && p < buf.length; child++) {
      const id = readVint(buf, p, true);
      if (!id || !MKV_CLUSTER_CHILD_IDS.has(id.value)) continue outer;
      const childSize = readVint(buf, p + id.width, false);
      if (!childSize) continue outer;
      const dataPos = p + id.width + childSize.width;
      if (id.value === 0xe7) {
        if (dataPos + childSize.value > buf.length || childSize.value === 0 || childSize.value > 8) continue outer;
        let ticks = 0;
        for (let b = 0; b < childSize.value; b++) ticks = ticks * 256 + buf[dataPos + b];
        if (ticks < loTicks - slackTicks || ticks > hiTicks + slackTicks) continue outer;
        return { elementStartPos: windowFileOffset + i, timestampTicks: ticks };
      }
      p = dataPos + childSize.value; // skip this child (CRC-32 etc.)
    }
  }
  return null;
}

/** Round-4 (4-c:463 — 30MB/33.9s): LAST validated cluster ≤ targetTicks in the
 *  window. One fetched window often spans several clusters — advancing to the
 *  last one in-buffer replaces the terminal creep the round-4 log showed (6
 *  overlapping 2MB re-fetches over an already-downloaded 1.5MB bracket). Same
 *  validation as scanForMkvClusterInWindow ([0, target], zero slack). */
export function scanForLastMkvClusterAtOrBefore(
  buf: Uint8Array,
  windowFileOffset: number,
  targetTicks: number,
): { elementStartPos: number; timestampTicks: number } | null {
  let best: { elementStartPos: number; timestampTicks: number } | null = null;
  let searchFrom = 0;
  for (;;) {
    const sub = searchFrom === 0 ? buf : buf.subarray(searchFrom);
    const hit = scanForMkvClusterInWindow(sub, windowFileOffset + searchFrom, 0, targetTicks, 0);
    if (!hit) return best;
    best = hit;
    const next = hit.elementStartPos - windowFileOffset + 1;
    if (next <= searchFrom || next >= buf.length) return best;
    searchFrom = next;
  }
}

/** Round-4: interpolation probe picker. MKV byte↔time is near-linear (measured
 *  35.87% duration ↔ 35.06% file byte in the round-4 log), so interpolating
 *  inside the [lo,hi] bracket using its known tick endpoints collapses ~17
 *  blind halvings into ~2-4 probes. Fraction clamped to [0.02, 0.98] so a bad
 *  endpoint can never pin the probe to the bracket edge; falls back to the
 *  midpoint when either endpoint tick is unknown or degenerate. */
export function pickBisectProbe(
  loByte: number,
  hiByte: number,
  loTicks: number | null,
  hiTicks: number | null,
  targetTicks: number,
): number {
  const mid = loByte + Math.floor((hiByte - loByte) / 2);
  if (loTicks === null || hiTicks === null || !(hiTicks > loTicks)) return mid;
  let frac = (targetTicks - loTicks) / (hiTicks - loTicks);
  frac = Math.min(0.98, Math.max(0.02, frac));
  const probe = loByte + Math.floor((hiByte - loByte) * frac);
  return Math.min(hiByte - 1, Math.max(loByte + 1, probe));
}

export interface BisectBracket {
  lo: number;
  hi: number;
  loTicks: number | null;
  hiTicks: number | null;
}

/** Round-5 spin fix (5-t:301-330 — 16 identical re-fetches): pure bracket step.
 *  'below' = the window's LAST ≤-target cluster (advance lo past it);
 *  'above' = the window held clusters but all above target — the window proved
 *  no ≤-target cluster exists in [mid, windowEnd], so hi shrinks to MID. The
 *  round-4 code set hi = found-cluster byte, but that byte is ≥ mid by
 *  construction (found inside the window), so the bracket never shrank and the
 *  interpolated probe repeated forever. Ticks tighten the interpolation only. */
export function stepBisectBracket(
  br: BisectBracket,
  mid: number,
  outcome: { kind: 'below' | 'above'; byte: number; ticks: number },
): void {
  if (outcome.kind === 'below') {
    br.lo = outcome.byte + 1;
    br.loTicks = outcome.ticks;
  } else {
    br.hi = Math.max(br.lo + 1, mid);
    br.hiTicks = outcome.ticks;
  }
}

/** Round-5 terminal rule: when the best ≤-target cluster and the next
 *  above-target cluster bracket a gap ≤ walkableGapBytes, the answer is FINAL
 *  (the gap is one cluster's interior — no more cluster starts can exist in
 *  it) and further probing only re-downloads bytes the subsequent walk reads
 *  anyway. Round-5 numbers: best@703792419 next@716375330 → 12.58MB gap; the
 *  16 extra probes bought nothing. */
export function bisectShouldStop(
  bestByte: number | null,
  nextAboveByte: number | null,
  walkableGapBytes: number,
): boolean {
  if (bestByte === null || nextAboveByte === null) return false;
  return nextAboveByte - bestByte <= walkableGapBytes;
}

/** timestampFactor (ticks per second) from the segment — guarded reach-in. */
export function readMkvTimestampFactor(videoTrack: unknown): number | null {
  try {
    const f = (videoTrack as any)?._backing?.internalTrack?.segment?.timestampFactor;
    return typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : null;
  } catch { return null; }
}

/** First-cluster byte (bisection lo-bound; skips the header region and pins
 *  segment membership — verify-c residual 7). Guarded reach-in. */
export function readMkvClusterSeekStart(videoTrack: unknown): number | null {
  try {
    const seg = (videoTrack as any)?._backing?.internalTrack?.segment;
    const v = seg?.clusterSeekStartPos ?? seg?.dataStartPos;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  } catch { return null; }
}

/** Insert a synthetic entry into the demuxer's clusterPositionCache — sorted
 *  splice by startTimestamp + neighbor dedup by elementStartPos, mirroring the
 *  vendored organic insert (matroska-demuxer readCluster). false = shape drift
 *  (caller degrades to skip). */
export function injectMkvClusterPosition(
  videoTrack: unknown,
  entry: { elementStartPos: number; startTimestamp: number },
): boolean {
  try {
    const cache = (videoTrack as any)?._backing?.internalTrack?.clusterPositionCache;
    if (!Array.isArray(cache)) return false;
    // binarySearchLessOrEqual by startTimestamp (last index with value <= key).
    let lo = 0, hi = cache.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cache[mid].startTimestamp <= entry.startTimestamp) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx >= 0 && cache[idx].elementStartPos === entry.elementStartPos) return true; // dup
    cache.splice(idx + 1, 0, { elementStartPos: entry.elementStartPos, startTimestamp: entry.startTimestamp });
    return true;
  } catch { return false; }
}

/** R10 consult-before-bisect: an existing cache entry (organic OR injected)
 *  with startTimestamp ∈ [targetTicks - windowTicks, targetTicks] already
 *  bounds getKeyPacket's walk — skip the bisection entirely. */
export function findClusterCacheEntryNear(
  videoTrack: unknown,
  targetTicks: number,
  windowTicks: number,
): { elementStartPos: number; startTimestamp: number } | null {
  try {
    const cache = (videoTrack as any)?._backing?.internalTrack?.clusterPositionCache;
    if (!Array.isArray(cache) || cache.length === 0) return null;
    let lo = 0, hi = cache.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cache[mid].startTimestamp <= targetTicks) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx < 0) return null;
    const e = cache[idx];
    return targetTicks - e.startTimestamp <= windowTicks
      ? { elementStartPos: e.elementStartPos, startTimestamp: e.startTimestamp }
      : null;
  } catch { return null; }
}

/** Round-6 Fix B: snapshot the demuxer's ORGANIC clusterPositionCache — every
 *  cluster the walk/iteration has parsed is an exact (byte, ticks) pair, the
 *  densest ground-truth byte↔time source available (refills add ~1 cluster per
 *  GOP as playback progresses). Guarded reach-in; null = shape drift. */
export function readMkvClusterPositions(
  videoTrack: unknown,
): { elementStartPos: number; startTimestamp: number }[] | null {
  try {
    const cache = (videoTrack as any)?._backing?.internalTrack?.clusterPositionCache;
    if (!Array.isArray(cache)) return null;
    const out: { elementStartPos: number; startTimestamp: number }[] = [];
    for (const e of cache) {
      const b = e?.elementStartPos, t = e?.startTimestamp;
      if (typeof b === 'number' && Number.isFinite(b) && b >= 0 &&
          typeof t === 'number' && Number.isFinite(t) && t >= 0) {
        out.push({ elementStartPos: b, startTimestamp: t });
      }
    }
    return out;
  } catch { return null; }
}

/** Round-7: adaptive keyframe-shadow width from the harvested keyframe index —
 *  2 × the max consecutive gap (the shadow can't exceed one GOP; 2× absorbs
 *  harvest sparsity), clamped [SEEK_SHADOW_MIN_S, SEEK_SHADOW_MAX_S]. Fewer
 *  than 2 keyframes → SEEK_SHADOW_DEFAULT_S. `keyframeTimestamps` sorted asc. */
export function computeKeyframeShadowSeconds(keyframeTimestamps: number[]): number {
  if (keyframeTimestamps.length < 2) return SEEK_SHADOW_DEFAULT_S;
  let maxGap = 0;
  for (let i = 1; i < keyframeTimestamps.length; i++) {
    const gap = keyframeTimestamps[i] - keyframeTimestamps[i - 1];
    if (gap > maxGap) maxGap = gap;
  }
  return Math.min(SEEK_SHADOW_MAX_S, Math.max(SEEK_SHADOW_MIN_S, 2 * maxGap));
}

/** Round-7 shadow purge: evict every clusterPositionCache entry with
 *  startTimestamp in (fromTicks, toTicks]. A stale entry inside the keyframe
 *  shadow wins performClusterLookup's closest-≤-target race no matter what we
 *  inject behind it — and a FAILED walk's own organic inserts re-poison the
 *  window, so the purge must cover the whole range, not just our entry.
 *  Returns the number of entries removed; 0 on shape drift. */
export function removeMkvClusterPositionsInRange(
  videoTrack: unknown,
  fromTicks: number,
  toTicks: number,
): number {
  try {
    const cache = (videoTrack as any)?._backing?.internalTrack?.clusterPositionCache;
    if (!Array.isArray(cache)) return 0;
    let removed = 0;
    for (let i = cache.length - 1; i >= 0; i--) {
      const t = cache[i]?.startTimestamp;
      if (typeof t === 'number' && t > fromTicks && t <= toTicks) {
        cache.splice(i, 1);
        removed++;
      }
    }
    return removed;
  } catch { return 0; }
}

export interface MkvBisectSearchOpts {
  /** Full probe URL including any source_id param (probes are plain ranged
   *  fetches; a dedicated source_id keeps the backend download coordinator
   *  from cross-cancelling playback/thumbnail downloads). */
  probeUrl: string;
  fileSize: number;
  /** Bisection lo-bound: first-cluster byte (readMkvClusterSeekStart) or 0. */
  startLo: number;
  targetTicks: number;
  /** Ticks at EOF (duration × factor) or null → midpoint bisection fallback. */
  hiTicks: number | null;
  /** Checked between probes; false aborts the search (returns null). */
  shouldContinue?: () => boolean;
  /** Fired for EVERY validated cluster read (exact byte↔ticks pairs) — feeds
   *  the green-bar byte↔time table (round-5 D3 / round-6 fix B). */
  onClusterFound?: (byteOffset: number, ticks: number) => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface MkvBisectSearchResult {
  entry: { elementStartPos: number; startTimestamp: number };
  bytesFetched: number;
  probes: number;
}

/** Locate the LAST cluster with timestamp ≤ targetTicks via interpolation-
 *  guided byte bisection over ranged HTTP probes. This is the round-3/4/5
 *  hover-pipeline loop extracted verbatim (round-6) so the player seek path
 *  can share it. Never throws; null = failed/aborted (callers degrade to the
 *  unbounded-walk/skip behavior they had before). */
export async function bisectMkvClusterSearch(opts: MkvBisectSearchOpts): Promise<MkvBisectSearchResult | null> {
  const {
    probeUrl, fileSize, startLo, targetTicks, hiTicks,
    shouldContinue = () => true,
    onClusterFound,
    fetchImpl = fetch,
  } = opts;
  try {
    if (!(fileSize > startLo)) return null;
    let best: { elementStartPos: number; timestampTicks: number } | null = null;
    let nextAbove: number | null = null; // earliest known above-target cluster byte
    let window = 2 * 1024 * 1024; // 2MB start, geometric grow on no-find (cap 8MB)
    let bytesFetched = 0;
    let probes = 0;
    const br: BisectBracket = { lo: startLo, hi: fileSize, loTicks: 0, hiTicks };

    for (let iter = 0; iter < 18 && br.hi - br.lo > 64 * 1024 && shouldContinue(); iter++) {
      if (bisectShouldStop(best?.elementStartPos ?? null, nextAbove, BISECT_WALKABLE_GAP_BYTES)) break;
      const mid = pickBisectProbe(br.lo, br.hi, br.loTicks, br.hiTicks, targetTicks);
      const fetchEnd = Math.min(mid + window - 1, fileSize - 1);
      const resp = await fetchImpl(probeUrl, { headers: { Range: `bytes=${mid}-${fetchEnd}` } });
      if (!resp.ok && resp.status !== 206) return null;
      const buf = new Uint8Array(await resp.arrayBuffer());
      bytesFetched += buf.length;
      probes++;
      // LAST validated cluster ≤ target in this window. Zero high-side slack:
      // the injected entry must satisfy ts ≤ target or binarySearchLessOrEqual
      // never selects it (verify-c risk 2).
      const hit = scanForLastMkvClusterAtOrBefore(buf, mid, targetTicks);
      if (!hit) {
        // Distinguish "cluster present but ABOVE target" from "no cluster at all".
        const any = scanForMkvClusterInWindow(buf, mid, 0, Number.MAX_SAFE_INTEGER, 0);
        if (!any) {
          if (window < 8 * 1024 * 1024) { window *= 2; continue; } // grow, re-probe same bracket
          return null;
        }
        onClusterFound?.(any.elementStartPos, any.timestampTicks);
        nextAbove = nextAbove === null ? any.elementStartPos : Math.min(nextAbove, any.elementStartPos);
        stepBisectBracket(br, mid, { kind: 'above', byte: any.elementStartPos, ticks: any.timestampTicks });
        continue;
      }
      best = hit;
      onClusterFound?.(hit.elementStartPos, hit.timestampTicks);
      // If the same window also holds a cluster ABOVE the target, the answer
      // is bracketed within ONE window — record it and let the stop rule end
      // the search (best is final: no later ≤-target cluster can exist).
      const above = scanForMkvClusterInWindow(
        buf.subarray(hit.elementStartPos - mid + 1), hit.elementStartPos + 1,
        targetTicks + 1, Number.MAX_SAFE_INTEGER, 0,
      );
      if (above) {
        onClusterFound?.(above.elementStartPos, above.timestampTicks);
        nextAbove = nextAbove === null ? above.elementStartPos : Math.min(nextAbove, above.elementStartPos);
        break;
      }
      if (hit.elementStartPos + 1 >= br.hi) break;
      stepBisectBracket(br, mid, { kind: 'below', byte: hit.elementStartPos, ticks: hit.timestampTicks });
    }

    if (!best || !shouldContinue()) return null;
    return {
      entry: { elementStartPos: best.elementStartPos, startTimestamp: best.timestampTicks },
      bytesFetched,
      probes,
    };
  } catch {
    return null;
  }
}
