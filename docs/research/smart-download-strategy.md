# Smart Download Coordination Strategy for Telegram-Drive

> Comprehensive research-based strategy document for HTTP video streaming
> with byte-range requests over a slow upstream (Telegram API).

---

## Table of Contents

1. [Download Deduplication](#1-download-deduplication)
2. [Seek Handling](#2-seek-handling)
3. [Two-Point Download Strategy (Non-Faststarted MP4)](#3-two-point-download-strategy)
4. [Continuation/Caching Strategy](#4-continuationcaching-strategy)
5. [Concurrent Download Limits](#5-concurrent-download-limits)
6. [Progress-Based Subscription](#6-progress-based-subscription)
7. [Recommended Configuration](#7-recommended-configuration)
8. [References](#8-references)

---

## 1. Download Deduplication

### Problem
When a video player makes overlapping byte-range requests (e.g., `bytes=633MB-1.4GB` then `bytes=634MB-1.4GB`), the server must avoid spawning duplicate upstream downloads for overlapping ranges.

### How CDNs and Video Servers Handle This

#### NGINX (Default Behavior)
NGINX's **default behavior** upon receiving a range request is to **strip the Range header and fetch the entire file** from upstream, then serve the requested subset. This is the worst-case strategy for slow upstreams — the client must wait while the entire file downloads before receiving even a single byte for a moov atom request at the end of the file.

**NGINX Slice Module** (`ngx_http_slice_module`) is the recommended improvement:
- Divides the file into fixed-size slices (e.g., 1MB each)
- Each slice becomes a separate cache entry
- Overlapping range requests hit the same slice cache entries
- **Key advantage**: Only one upstream request per slice — deduplication is implicit via the cache
- **Key limitation**: Slice size must be chosen carefully (too small = too many cache entries; too large = wasted upstream bandwidth on partial requests)
- **Documentation**: `slice 1m;` in nginx config; the module ensures "only one caching request per slice" goes upstream

#### NGINX Proxy Module (`ngx_http_proxy_module`)
- `proxy_cache_max_range_offset`: Keeps the Range header for requests below this offset, but doesn't cache the response. Above this offset, strips the Range header and does a full fill. This is a compromise — useful for preventing the worst-case (moov atom at end of file) but doesn't handle general deduplication.

#### AWS CloudFront
- **Rounding**: CloudFront may internally expand the Range header to request a larger range than the client requested ("To optimize performance")
- **Fill Mode**: Full fill — if the cache doesn't have the range, fetches from origin
- **Matching**: Full — once cached, any range request within the cached data is served from cache
- **No explicit deduplication**: Each range request is served independently; overlapping requests each trigger separate origin fetches unless the data is already cached

#### Fastly (Segmented Caching)
- **Rounding**: Fixed-size blocks (configurable `segmented_caching.block_size`, typically 1–8MB)
- **Matching**: Full — block-aligned segments stored once, any range within cached blocks served from cache
- **Fill Mode**: Partial — only missing segments are fetched from origin
- **Key advantage**: Most sophisticated deduplication via block-aligned segmentation
- **On ETag mismatch**: Returns "Flapping origin entity" error — aborts partial fill and falls back to full fill

#### Google Cloud CDN
- **Rounding**: Fixed chunks (2MB-16B each — presumably 16 bytes of inline metadata)
- **Matching**: Full
- **Fill Mode**: Partial (multiple sequential requests of ~2MB each)
- **First request**: Not cached; subsequent requests are cached only if origin supports Range requests with strong ETag
- **On ETag mismatch**: Full fill fallback

#### Kevin Cox's Analysis ("The Impossibility of Perfectly Caching HTTP Range Requests")
This is the definitive analysis of range request caching strategies:

| Proxy | Rounding | Matching | Fill |
|-------|----------|----------|------|
| Amazon CloudFront | Yes | Full | Full |
| Cloudflare | Entire File | - | - |
| Fastly | Fixed Chunks | Full | Partial |
| Google Cloud CDN | Fixed Chunks | Full | Partial |
| NGINX default | Entire File | - | - |
| NGINX http_proxy_module | Fixed Chunks | Full | Partial |
| NGINX proxy_pass Range | None | Exact | - |

**Key insight**: "Full matching is clearly superior as it avoids unnecessary origin fetch and avoids wasting cache capacity on duplicate data."

### Recommended Strategy for Telegram-Drive

**Hybrid approach combining slice-based caching with coordinator deduplication:**

1. **Active Download Coordinator** (already implemented in `stream_cache.rs`):
   - Maintain a registry of `ActiveDownload` entries keyed by message_id
   - Each entry tracks the byte range being downloaded and a `watch::Channel` for progress broadcasting
   - When a new range request arrives, check if an active download covers (or will reach) the requested range
   - If covered → subscribe to the existing download's progress channel
   - If not covered → start a new download and register it

2. **Slice-Based Cache Layer**:
   - Cache downloaded data in fixed-size slices (1MB, matching Telegram's chunk size)
   - Each slice is stored once; overlapping requests share the same slice data
   - This naturally deduplicates: `bytes=633MB-634MB` and `bytes=633.5MB-634.5MB` share slices covering `633MB-635MB`

3. **Priority for Urgent Requests**:
   - Urgent requests (moov atom, seek position) should NOT wait for a sequential download to reach their offset
   - These should start a new targeted download (see §2 and §3)

---

## 2. Seek Handling

### Problem
When a video player seeks, it abandons the old download position and requests data from the new position. The server must decide what to do with the old download.

### How Players Handle Seeking

#### Browser HTML5 `<video>` Element
When seeking, the browser:
1. **Aborts the current network request** (the ongoing HTTP byte-range download)
2. **Issues a new range request** starting from the seek position
3. The server sees: old connection closed + new connection opened with different range

#### hls.js
- On seek: `stream-controller` aborts the current fragment loader via `xhr.abort()`
- Starts loading fragments from the new position
- Buffer controller manages which segments to load based on `BufferInfo` and target buffer length
- Issue #3576: "Fragment loader aborts load of current fragment" — abort is standard behavior
- Issue #6054: "Frag doesn't abort when seeking frequently" — shows abort is expected but sometimes buggy

#### Shaka Player (StreamingEngine)
- On seek: cancels all pending segment downloads for the current position
- Starts downloading from the new seek position
- Uses `AbortController` to cancel in-progress fetches
- Priority: seek requests are treated as urgent — immediately scheduled

### Server-Side Seek Handling Strategies

#### Strategy A: Cancel Immediately (Responsive)
- **Pro**: Immediate bandwidth release for the new position; responsive to user intent
- **Con**: Wastes already-downloaded data that could be cached; if user seeks back, must re-download
- **Best for**: Bandwidth-constrained upstreams where responsiveness is critical

#### Strategy B: Continue in Background (Cache Completeness)
- **Pro**: Builds complete cache; subsequent seeks benefit from cached data
- **Con**: Competes for bandwidth with the new seek download; may slow the seek response
- **Best for**: Fast upstreams with abundant bandwidth; popular files likely to be watched multiple times

#### Strategy C: Hybrid — Cancel Old but Keep Cache (Recommended)
- **Cancel the upstream download** (stop requesting new data from Telegram)
- **Keep all already-downloaded data** in the cache
- **Start a new targeted download** for the seek position
- This is what the Telegram-Drive `ContinuationGuard` already implements:
  - When the Actix response ends (client disconnect/seek), the guard spawns a background task
  - The background task continues downloading from the last position sent to the client
  - This fills the cache for future use

### Recommended Configuration

| Upstream Speed | Seek Strategy | Background Continuation | Priority |
|----------------|---------------|------------------------|----------|
| Slow (< 5 MB/s) | Cancel old + start new | **Stop** background — bandwidth too precious | Seek request is highest priority |
| Medium (5–20 MB/s) | Cancel old + start new | **Conditional** — continue only if >50% already cached | Seek request is high priority |
| Fast (> 20 MB/s) | Cancel old + start new | **Always** continue background | Seek request gets normal priority |

**For Telegram-Drive (slow upstream, ~3–6 MB/s)**: Use Strategy C with **limited background continuation**:
- Cancel the old upstream download immediately
- Start a new download from the seek position
- Background continuation: **only continue downloading if the file is > 75% cached** — this ensures popular files get fully cached but prevents wasting bandwidth on files users quickly abandon

---

## 3. Two-Point Download Strategy (Non-Faststarted MP4)

### Problem
For non-faststarted MP4 files, the `moov` atom (containing all metadata: track info, sample tables, index) is at the **end** of the file. The browser `<video>` element needs both:
1. **Beginning of file** (ftyp + moov-free + initial mdat samples) for first-frame decode
2. **End of file** (moov atom) for metadata to know where samples are

Without the moov atom, the player cannot decode anything — it can't find which byte ranges contain video frames.

### Known Approaches

#### Approach A: Download from Both Ends Simultaneously
- Start two parallel downloads: one from byte 0 forward, one from (file_size - moov_size) backward
- **Pro**: Moov arrives quickly (small, typically 100KB–5MB)
- **Con**: Two concurrent Telegram connections for same file; may trigger flood limits
- **Time to first frame**: ~moov_download_time + first_chunk_download_time (parallel)

#### Approach B: Download Moov First, Then Front-to-Back
- First download the moov atom (known size from Content-Length / file metadata)
- Then start front-to-back download
- **Pro**: Moov arrives fastest; player can begin decoding immediately when first data arrives
- **Con**: Must know moov size before starting (requires initial metadata request)
- **Time to first frame**: ~moov_download_time + first_chunk_download_time (sequential)

#### Approach C: Download Front First, Then Moov, Then Continue Front
- Download first ~1MB (ftyp + initial data)
- Then download moov atom from end
- Then continue front-to-back
- **Pro**: Some data is already available when moov arrives; can start decoding immediately
- **Con**: Player still can't play the first data until moov arrives (so first 1MB download is "wasted" latency)
- **Time to first frame**: ~1MB_download_time + moov_download_time + small_gap

### Analysis: Minimizing Time-to-First-Frame

The player needs **both** moov + first video samples to render a frame. The optimal order depends on what we know:

**If we know the moov size** (from previous caching, metadata, or a quick probe):
- **Approach B** (moov first) is optimal: download moov in parallel with the first chunk
- Time = max(moov_download_time, first_chunk_download_time)

**If we don't know the moov size** (first-time access):
- **Approach C** (front first, then moov) with a **very small initial chunk** (just ftyp, ~32 bytes) is wasteful because the player can't use it
- Better: **Approach A** (both ends simultaneously) — start from byte 0 AND from a probe at the end
- Probe strategy: request the last 1MB of the file; parse it to find the moov atom; then download the exact moov range

### Real-World Implementations

#### NGINX MP4 Module (`ngx_http_mp4_module`)
- Handles `?start=T` requests for pseudo-streaming
- **Requires the moov atom at the beginning** (faststarted files)
- For non-faststarted files: downloads the entire file to find moov → terrible for slow upstreams
- This is why Kevin Cox documented the problem: "the client tries to download the small table of contents at the end of a large video file and ends up waiting while NGINX downloads the entire video"

#### Kaltura nginx-vod-module (Remote Mode)
- In remote mode, the module fetches the MP4 from an upstream URL
- **Two-phase approach**: First fetches just enough to parse the moov atom, then selectively downloads sample data for the requested segment
- Uses range requests to the upstream to minimize data transfer
- Issue #314: "Too much Range-requests to origin" — even this optimized approach can generate excessive range requests

#### Shaka Player / hls.js
- These are HLS/DASH players — they don't face the moov problem directly because segment files are small and independent
- For MP4 initialization segments, they download the entire init segment first (which contains moov)
- **Key insight**: HLS/DASH solved the moov problem by **structuring the content differently** (init segment + media segments)

### Recommended Strategy for Telegram-Drive

**Smart two-point download with moov-first priority:**

1. **Phase 1 — Probe moov** (if moov size unknown):
   - Download last 1MB of file (`offset = file_size - 1MB, limit = 1MB`)
   - Parse to locate moov atom boundaries
   - If moov is larger than 1MB, download additional chunks from the end until moov is complete
   - This typically takes 1–2 Telegram API calls (512KB each)

2. **Phase 2 — Parallel download** (moov + first data):
   - Download the exact moov range from end of file (parallel with front download)
   - Download from byte 0 forward for initial video data
   - Both downloads run concurrently on separate DownloadPool workers

3. **Phase 3 — Front-to-back continuation**:
   - Once moov + first frames are delivered, continue front-to-back
   - Already-downloaded moov data is cached for future accesses

**Implementation notes:**
- Telegram's `upload.getFile` API requires offset to be aligned to 1MB chunks: `offset / (1024 * 1024) == (offset + limit - 1) / (1024 * 1024)`
- The moov probe must align to these boundaries
- The DownloadPool already has 3 workers — use worker 0 for front-to-back, worker 1 for moov, worker 2 for seek/background

---

## 4. Continuation/Caching Strategy

### Problem
After the HTTP response ends (client disconnect, seeks away, or video finishes), should the server continue downloading the rest of the file to populate the cache?

### Tradeoffs

| Aspect | Continue (Pro) | Stop (Con of continuing) |
|--------|----------------|--------------------------|
| Subsequent requests | Hit cache immediately | Must re-download from Telegram |
| Bandwidth efficiency | Wastes bandwidth if user closes video | Saves bandwidth for other users/files |
| Cache completeness | Full cache = instant future access | Partial cache = faster for cached ranges only |
| Flood limits | Continued downloads consume API quota | Quota freed for other operations |
| Multi-user benefit | Other users benefit from full cache | Only current user benefits |

### How Existing Systems Handle This

#### NGINX `proxy_cache_background_update`
- When cached content becomes stale, NGINX can update the cache in the background while serving stale content
- **Does NOT continue filling** after a client disconnect — only updates stale content
- The slice module explicitly notes: "does not work as expected in subrequests such as background cache update"

#### VLC Prefetch Module (`modules/stream_filter/prefetch.c`)
- VLC prefetches data while playing: reads ahead of the current playback position
- Prefetch stops when playback stops (user closes video, pauses, or seeks)
- **No background continuation** — purely playback-driven prefetch

#### CloudFront
- After serving a range request, CloudFront caches the fetched data
- **No background continuation** — only caches what was actually requested
- For full-fill mode: the entire file is cached (because the full file was fetched), but this was a side-effect of the full-fill strategy, not intentional continuation

#### Fastly Segmented Caching
- Only fetches segments that are actually requested
- **No background continuation** — each segment is fetched only when needed

### Academic Research

**Proxy Caching for Media Streaming** (Liu et al., 2004):
- **Prefix caching**: Cache the initial portion (prefix) of every video — ensures fast startup
- **Segment caching**: Divide video into segments; cache popular segments based on access frequency
- **Dynamic caching**: Cache segments as they are requested; evict unpopular ones
- Key insight: "A trivial extension [of web caching] to streaming media would cache the entire object... However, this may be highly inefficient because a client may only watch a small portion"

**Scalable Proxy Caching Under Storage Constraints** (Rejaie et al., 2002):
- **Progressive caching**: Start with prefix, gradually cache more as video is watched
- **Selective caching**: Only cache segments likely to be accessed again
- Key tradeoff: storage constraint means you can't cache everything; need intelligent selection

### Recommended Strategy for Telegram-Drive

**Adaptive continuation with decision heuristic:**

```
Should we continue downloading after client disconnects?

Decision factors:
1. Cache completeness:  what % of the file is already cached?
2. Access history:      how many times has this file been accessed?
3. File popularity:     is this a frequently-watched file?
4. Available bandwidth: is the DownloadPool under heavy load?
5. File size:           small files (<10MB) → always continue; large files → conditional
```

**Concrete rules:**

| Cache Completeness | Action |
|--------------------|--------|
| < 25% cached | **Stop** — likely abandoned, don't waste bandwidth |
| 25–75% cached | **Conditional** — continue only if file has been accessed ≥ 2 times |
| > 75% cached | **Continue** — almost done, finish the cache |
| 100% cached | **No action needed** |

**Additional rules:**
- **Small files (< 10MB)**: Always continue — the bandwidth cost is minimal
- **Background continuation priority**: Lower than active streaming; use DownloadPool worker 2 (the "background" worker)
- **Rate limit**: Background continuation uses a slower rate limit to avoid competing with active streaming
- **Flood limit protection**: If a `FLOOD_WAIT` error is received during background continuation, stop immediately — don't retry

This is already partially implemented via `ContinuationGuard` in `server.rs`, which spawns a background task when the Actix response ends. The improvement would be adding the **decision heuristic** above to determine whether continuation is worthwhile.

---

## 5. Concurrent Download Limits

### Problem
How many simultaneous Telegram API downloads should run per video file? More downloads = faster access but risks flood limits.

### Telegram API Constraints

From Telegram's official documentation (`core.telegram.org/api/files`):

1. **Chunk alignment**: Each `upload.getFile` request must stay within a single 1MB chunk boundary: `offset / (1024 * 1024) == (offset + limit - 1) / (1024 * 1024)`
2. **Maximum chunk size**: 512KB per API call (hard cap)
3. **DC separation**: File downloads must go to the appropriate DC; large queries should use separate connections
4. **Flood limits**: Telegram enforces per-DC and per-account flood limits. `FLOOD_PREMIUM_WAIT_X` errors indicate rate limiting. Premium accounts get higher limits.
5. **Parallel connections**: Telegram officially recommends "several connections (optimally to have a pool)" for file downloads

From the `telebackup` project (high-speed Telegram downloader):
- Uses **multi-connection parallel downloading** with checkpoint resume and cross-DC support
- Achieves significantly higher throughput with parallel connections

From Telegram Desktop issue #24700:
- Download speed is limited to ~10 MB/s even for premium accounts
- This suggests Telegram throttles per-DC, not per-connection

### Tradeoffs

| Concurrent Downloads | Pros | Cons |
|---------------------|------|------|
| 1 (front-to-back only) | Simplest; no flood risk; lowest overhead | Moov atom slow for non-faststarted files; seek latency high |
| 2 (front + moov/seek) | Fast moov access; responsive seeks; moderate flood risk | Needs coordinator to avoid overlap; two connections per file |
| 3 (front + moov + background) | Full caching potential; fast seeks; good responsiveness | Higher flood risk; more complex coordination; 3 connections per file |
| 4+ | Maximum parallelism for large files | Flood limit danger; diminishing returns (Telegram throttles per-DC) |

### Real-World Benchmarks

From the Telegram-Drive implementation:
- **Before optimizations**: 10–15+ concurrent downloads → unstable 5.8 MB/s with frequent FLOOD_WAIT errors
- **After Semaphore(4) + MAX_CONCURRENT=3**: Stable 3–4 MB/s with occasional FLOOD_WAIT
- **With Semaphore(8) + MAX_CONCURRENT=5**: Expected 5–6 MB/s stable

### Recommended Configuration

**Per-file limit: 2 concurrent downloads**

| Worker | Purpose | Priority |
|--------|---------|----------|
| Worker 0 | Front-to-back (sequential playback) | HIGH — active streaming |
| Worker 1 | Targeted (moov atom / seek position) | URGENT — time-critical |
| Worker 2 | Background continuation | LOW — cache filling |

**Rules:**
1. **Only 2 active (non-background) downloads per file at any time**:
   - Front-to-back + one targeted download
   - Background downloads use worker 2 only when workers 0/1 are idle

2. **Global semaphore**: Limit total concurrent Telegram API calls across all files
   - Recommended: `Semaphore(8)` — 8 total concurrent downloads across all active streams
   - This prevents flood limits while allowing 2–3 files to stream simultaneously

3. **Priority queue**: When the semaphore is full, new requests are queued by priority:
   - URGENT: moov atom requests (must download immediately)
   - HIGH: seek position requests (user is waiting)
   - MEDIUM: sequential playback (front-to-back continuation)
   - LOW: background cache filling (can wait)

4. **Flood limit response**: On `FLOOD_WAIT_X`:
   - Wait X seconds before retrying
   - Reduce semaphore permits by 1 for X seconds (temporary throttle)
   - If 3+ FLOOD_WAIT errors in 60 seconds → reduce global concurrency by 50% for 5 minutes

---

## 6. Progress-Based Subscription

### Problem
When a new range request arrives and an active sequential download will eventually reach that offset, should the request:
- **Subscribe** to the active download (wait for it to reach the offset)?
- **Start a new download** (immediate but wastes bandwidth for overlapping data)?

### Key Considerations

#### Wait Time Estimation

```
estimated_wait = (requested_offset - current_download_position) / download_speed

Example:
- Download position: 100MB
- Requested offset: 150MB
- Download speed: 5 MB/s
- Estimated wait: 50MB / 5 MB/s = 10 seconds
```

#### Decision Threshold

| Estimated Wait | Action | Reason |
|---------------|--------|--------|
| < 2 seconds | **Subscribe** | Data arrives soon; no bandwidth waste |
| 2–5 seconds | **Subscribe if URGENT data already close** | Small overlap acceptable |
| > 5 seconds | **Start new targeted download** | User experience too degraded; start fresh |
| Moov atom request | **Always start new download** | Cannot wait — player needs moov to function |

#### Subscription Mechanics

The Telegram-Drive `ActiveDownload` coordinator already implements this:

```
struct ActiveDownload {
    start_byte: u64,
    end_byte: u64,
    progress: watch::Sender<u64>,  // broadcasts last byte received
}
```

When a new request arrives:
1. Check `active_downloads` for this message_id
2. Find any download whose range covers or will reach the requested offset
3. Calculate estimated wait time
4. If wait < threshold → create a `watch::Receiver` and poll until offset is reached, then serve from cache
5. If wait > threshold → start a new targeted download on a free worker

#### Subscriber Data Delivery

Two approaches for delivering data to subscribers:

**Approach A: Read from cache file** (current implementation):
- Active download writes bytes to cache file as they arrive
- Subscriber reads from cache file at their needed offset once progress reaches that offset
- **Pro**: Simple; no memory overhead; works with disk cache
- **Con**: Disk I/O for subscriber reads (minor latency)

**Approach B: Pipe/broadcast from active download stream** (memory-based):
- Active download broadcasts chunks to all subscribers via channels
- Subscribers filter for their relevant offset range
- **Pro**: Zero disk latency for subscriber reads
- **Con**: Memory overhead; complex channel management; doesn't work well with large files

**Recommended**: Approach A (read from cache) — simpler, already implemented, disk I/O is negligible compared to Telegram download latency.

### Priority Considerations

Subscribers should be able to **upgrade** their subscription to a targeted download if the wait becomes too long:

1. Subscribe initially (wait < threshold)
2. If progress stalls (download speed drops) → re-estimate wait time
3. If new estimate > threshold → unsubscribe and start targeted download
4. This prevents subscribers from being stuck waiting for a slow download

### Edge Cases

- **Download completes before subscriber's offset**: Data is in cache → serve immediately from cache (fast path)
- **Download is cancelled (seek away)**: Unsubscribe → start new download for the new position
- **Multiple subscribers for same offset**: All share the same `watch::Receiver` — no duplication
- **Subscriber disconnects**: Simply drop the `watch::Receiver` — no cleanup needed

---

## 7. Recommended Configuration

### Summary Table

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Download deduplication | ActiveDownload coordinator + slice cache | Prevents overlapping requests; shares data via cache |
| Seek handling | Cancel old + start new targeted download | Responsive; keeps already-downloaded cache data |
| Background continuation | Conditional (only if >75% cached or accessed ≥2×) | Balances bandwidth efficiency with cache completeness |
| Two-point download | Moov-first parallel with front-to-back | Minimizes time-to-first-frame for non-faststarted MP4s |
| Concurrent downloads per file | 2 active (front + targeted) + 1 background | Responsive without flood risk |
| Global semaphore | 8 concurrent API calls | Stable throughput (~5–6 MB/s) without FLOOD_WAIT |
| Subscription wait threshold | 5 seconds | Beyond this, start new download |
| Moov atom priority | Always start new download (never subscribe) | Player cannot function without moov |
| Slice/chunk size | 1MB (aligned to Telegram 1MB chunk boundary) | Natural alignment with API constraints |
| Background continuation rate | Same speed, lower priority | Don't slow active streaming |
| Flood limit response | Wait + temporary throttle (reduce permits by 1 for X sec) | Graceful degradation |

### Priority Order for New Requests

```
1. URGENT  — Moov atom requests (player can't function without this)
2. HIGH    — Seek position requests (user is actively waiting)
3. MEDIUM  — Sequential playback continuation (front-to-back)
4. LOW     — Background cache filling (optimization, not critical)
```

### Implementation Priority for Telegram-Drive

1. **Keep existing coordinator** (ActiveDownload in stream_cache.rs) — already works well
2. **Add moov-first download logic** — new feature for non-faststarted MP4s
3. **Add subscription wait-time estimation** — enhance existing coordinator
4. **Add continuation decision heuristic** — enhance existing ContinuationGuard
5. **Add priority-aware semaphore** — enhance existing Semaphore with priority queue

---

## 8. References

### CDNs & Proxy Implementations
- [Kevin Cox — "The Impossibility of Perfectly Caching HTTP Range Requests"](https://kevincox.ca/2021/06/04/http-range-caching/) — Definitive analysis of range request caching strategies with CDN comparison table
- [NGINX — "Smart and Efficient Byte-Range Caching"](https://blog.nginx.org/blog/smart-efficient-byte-range-caching-nginx) — NGINX slice module documentation and best practices
- [NGINX `ngx_http_slice_module`](https://nginx.org/en/docs/http/ngx_http_slice_module.html) — Official module documentation
- [NGINX `ngx_http_mp4_module`](https://nginx.org/en/docs/http/ngx_http_mp4_module.html) — MP4 pseudo-streaming module
- [AWS CloudFront — Range GETs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RangeGETs.html) — CloudFront's range request handling
- [Fastly — Segmented Caching](https://www.fastly.com/documentation/guides/full-site-delivery/caching/segmented-caching/) — Block-aligned caching with partial fill
- [Kaltura nginx-vod-module](https://github.com/kaltura/nginx-vod-module) — MP4 repackager with remote mode range requests
- [Alibaba nginx-http-slice](https://github.com/alibaba/nginx-http-slice) — Reverse byte-range slicing module

### Player Implementations
- [hls.js — stream-controller](https://github.com/video-dev/hls.js/blob/master/src/controller/stream-controller.ts) — Fragment loading with seek abort
- [Shaka Player — StreamingEngine](https://shaka-player-demo.appspot.com/docs/api/shaka.media.StreamingEngine.html) — Segment download management with seek handling
- [VLC prefetch module](https://github.com/videolan/vlc/blob/master/modules/stream_filter/prefetch.c) — Read-ahead prefetch during playback

### Telegram API
- [Telegram — Uploading and Downloading Files](https://core.telegram.org/api/files) — File transfer API with chunk alignment rules
- [Telegram — upload.getFile](https://core.telegram.org/method/upload.getFile) — File download API method
- [telebackup](https://github.com/xwc9527/telebackup) — High-speed parallel Telegram downloader
- [grammers](https://github.com/Lonami/grammers) — Rust Telegram client library used by Telegram-Drive

### Academic Papers
- Liu et al. (2004) — "Proxy Caching for Media Streaming over the Internet" — [PDF](https://www2.cs.sfu.ca/~jcliu/Papers/SurveyStreamingCaching.pdf)
- Rejaie et al. (2002) — "Scalable Proxy Caching of Video Under Storage Constraints" — [IEEE JSAC](https://dl.acm.org/doi/abs/10.1109/JSAC.2002.802061)
- Wu et al. (2001) — "Intelligent Prefetching at a Proxy Server" — [ResearchGate](https://www.researchgate.net/publication/3850702)

### Service Worker / Web
- [web.dev — Handle Range Requests in a Service Worker](https://web.dev/articles/sw-range-requests) — Workbox range request handling
- [Chrome — Serving Cached Audio and Video](https://developer.chrome.com/docs/workbox/serving-cached-audio-and-video) — Service worker video caching challenges
- [MDN — HTTP Range Requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests) — Range request specification
