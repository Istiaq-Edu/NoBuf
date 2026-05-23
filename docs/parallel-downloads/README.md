# Parallel Download Pool — Implementation Summary

> **Branch**: `BandwidthLimiter`  
> **Date**: May 2026  
> **Status**: Deployed (active for background cache filling + file downloads; sequential for player-facing streaming)

---

## Overview

This project implements a **DownloadPool** — a pool of 3 independent Telegram Client instances, each with its own TCP connection — to break through the ~5.7 MB/s single-connection bandwidth ceiling during video streaming from Telegram.

The implementation follows **Telegram's official recommendation** for parallel downloads: the MTProto protocol explicitly supports multiple simultaneous TCP connections within a session, and the "Uploading and Downloading Files" API documentation states:

> *"To further increase performance, multiple parallel call queues (i.e. a tunable number Y of queues) linked to separate TCP connections to the datacenters can be used to upload multiple chunks in parallel."*

And from the Client-Side Optimization page:

> *"It makes sense to download files over several connections (optimally to have a pool)."*

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Telegram-Drive App                 │
│  ┌───────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │ Frontend   │  │ Actix HTTP   │  │ Background    │  │
│  │ (React)    │  │ Server       │  │ Cache Filler  │  │
│  └─────┬─────┘  └──────┬──────┘  └───────┬───────┘  │
│        │               │                  │          │
│        │     ┌─────────┴─────────┐        │          │
│        │     │    Prebuffer      │        │          │
│        │     │  (server.rs)      │        │          │
│        │     └─────────┬─────────┘        │          │
│        │               │ (disabled for    │          │
│        │               │  player stream)  │          │
│        │     ┌─────────┴─────────┐        │          │
│        │     │  DownloadPool      │◄───────┘          │
│        │     │  (download_pool.   │                   │
│        │     │   rs)              │                   │
│        │     └───┬───┬───┬───────┘                   │
│        │         │   │   │                            │
│        │    ┌────┴─┐ ┌┴───┴┐ ┌───────┐               │
│        │    │ Wkr0 │ │Wkr1 │ │ Wkr2  │               │
│        │    │Client│ │Clnt │ │Client │               │
│        │    │ TCP  │ │TCP  │ │TCP    │               │
│        │    └──┬───┘ └──┬──┘ └───┬───┘               │
│        │       │        │        │                    │
│        │       │   Telegram DC    │                    │
│        │       │   (Media Files)  │                    │
└────────────────┴────────┴────────┴────────────────────┘
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| **DownloadPool** | `src/download_pool.rs` | Manages 3 worker threads, each with independent Client & TCP |
| **DownloadWorker** | `src/download_pool.rs` | Single worker with Client, session file, and runner |
| **Server Integration** | `src/server.rs` | Prebuffer: serves HTTP range requests to video player |
| **Streaming Integration** | `src/commands/streaming.rs` | Background: fills cache gaps in parallel |
| **Auth Integration** | `src/commands/auth.rs` | Initializes and cleans up DownloadPool |
| **State** | `src/lib.rs` | `download_pool: Mutex<Option<DownloadPool>>` in TelegramState |
| **Module** | `src/commands/mod.rs` | Registers DownloadPool module |

### How It Works

1. **Initialization** (`auth.rs`): When the Telegram client connects, 3 separate Client instances are created, each with its own session file copy (`telegram.session-download-worker-N`). Each Client connects to Telegram independently.

2. **Download Methods**:
   - `download_range()` — Downloads entire byte range by splitting into 3 sub-ranges, one per worker, then merging results (used for background cache filling)
   - `stream_range()` — Streams byte range using shared offset-counter and reorder buffer (currently disabled for player-facing stream)
   - `download_sub_range()` — Single-worker fallback download

3. **Parallel Streaming** (disabled): Workers claim chunks from a shared atomic offset counter. A reorder buffer (`BTreeMap<u64, Vec<u8>>`) collects out-of-order chunks and yields them in ascending byte-offset order.

4. **Semaphore**: A `tokio::sync::Semaphore` with 4 permits limits concurrent downloads across the pool. The Semaphore serializes all Telegram API calls (streaming, file downloads, background gap-filling) into 4 concurrent slots. This prevents FLOOD_WAIT bombardment but also limits throughput to ~3-4 MB/s. A future optimization could increase this to 6-8 permits for Premium accounts where Telegram's rate limits are more lenient.

---

## Files Modified

| File | Changes |
|------|---------|
| `src/download_pool.rs` | **NEW FILE** — DownloadPool, DownloadWorker, parallel_worker_stream, sequential_stream, reorder coordinator |
| `src/server.rs` | Added parallel streaming path (disabled), `StreamChunk` import and usage |
| `src/commands/auth.rs` | DownloadPool init in `ensure_client_initialized()`, cleanup on logout |
| `src/lib.rs` | Added `download_pool` field to TelegramState, expanded semaphore from 1→4 |
| `src/commands/mod.rs` | Registered `download_pool` module |
| `src/commands/fs.rs` | Parallel download path for file downloads >1MB |
| `src/commands/streaming.rs` | Parallel gap-filling for background cache gaps >1MB |

---

## Deployment Status

| Integration | Status | Why |
|-------------|--------|-----|
| DownloadPool initialization | ✅ Active | 3 workers initializing correctly |
| Background cache gap filling | ✅ Active | `streaming.rs` uses `pool.download_range()` |
| File downloads (fs.rs) | ✅ Active | `fs.rs` uses `pool.stream_range()` for fresh downloads |
| Player-facing HTTP stream | ✅ Sequential | MSE player requires in-order data; parallel caused CHUNK_DEMUXER_ERROR. Coordinator + sequential is the correct permanent choice. |

---

## Known Runtime Issues

All previously identified runtime issues have been **resolved**. The overlapping range requests (root cause of other issues) is fixed by the per-message download coordinator (Bug #6). Remaining behavior:

| Issue | Severity | Impact | Status |
|-------|----------|--------|--------|
| FLOOD_PREMIUM_WAIT for non-Premium accounts | LOW | ~3-4s delays, expected behavior | Expected (Telegram rate limit) |
| 1.4GB full-file request on player close | LOW | Cleanup artifact, no data corruption | Under investigation (native video fallback) |

**Resolved issues**: Bug #6 (overlapping requests), Bug #8 (meta over-claiming + deferred deletion), Bug #10-16 (all fixed), seek-after-completion (Bug #17), QuotaExceededError cascade.

---

## Bandwidth Utilization

| Metric | Before Optimizations | After Optimizations | Potential (Semaphore(8)) |
|--------|---------------------|--------------------|--------------------------|
| Concurrent API calls | Unlimited (10-15+) | 4 (Semaphore) | 8 |
| Per-message downloads | Unlimited | 3 (MAX_CONCURRENT) | 5 |
| Average throughput | ~5.8 MB/s (unstable) | ~3-4 MB/s (stable) | ~5-6 MB/s (stable) |
| FLOOD_PREMIUM_WAIT | Bombardment (3-8s × many) | Occasional (3-4s × 1-2) | Occasional (3-4s × 1-2) |
| QuotaExceededError | Frequent | None | None |
| Data duplication | Severe | None | None |

The current Semaphore(4) + MAX_CONCURRENT(3) configuration is conservative — prioritizing stability over raw throughput. To restore ~5.8 MB/s throughput while keeping all bug fixes, increase Semaphore to 8 and MAX_CONCURRENT to 5. The coordinator prevents overlapping downloads, and Bug #16 fixes prevent QuotaExceededError regardless of concurrency level.

---

## See Also

- [Architecture Details](./download-pool-architecture.md) — Deep dive into code structure and data flow
- [Bugs & Lessons Learned](./download-pool-bugs-and-lessons.md) — All bugs encountered and their resolution
- [Telegram TOS Compliance](./telegram-tos-compliance.md) — Analysis of API compliance and usage limits
