# Proactive Disk Prebuffer Design

## Goal
Download the entire video to disk cache proactively while the user watches, so that:
1. The green (prebuffer) bar always moves forward
2. When lazyLoad resumes, data is served from disk cache (no Telegram latency)
3. The white (SourceBuffer) bar still pauses when SourceBuffer quota fills — this is unavoidable

## Architecture

### Data Flow

```
Player → HTTP fetch → /stream endpoint
                            │
                            ├─ [HIT] Full range cached → serve from .dat (instant)
                            ├─ [CACHE-PREFIX] Partial cache → serve cached bytes first
                            └─ [SEQUENTIAL] No cache → download from Telegram

Proactive Prebuffer Worker (Rust background task)
  ├─ Triggered by: cmd_report_playback_position (every 10s from frontend)
  ├─ Calculates: current_byte → file_end
  ├─ Checks: stream_cache for gaps
  └─ Downloads: missing ranges → .dat → CacheMeta updated
```

### Components

#### 1. New Tauri Command: `cmd_report_playback_position`

```rust
#[tauri::command]
async fn cmd_report_playback_position(
    msg_id: i32,
    folder_id: i64,
    current_time_s: f64,
    state: State<'_, AppState>,
) -> Result<(), String>
```

- Looks up `file_size` and `duration_s` from existing metadata (fmp4 metadata or stream query)
- Calculates `current_byte = (current_time_s / duration_s) * file_size` (CBR approximation)
- Checks `stream_cache.is_range_cached(current_byte, file_end)` for gaps
- If gaps exist and no proactive download is running for this msg_id, spawns one
- If a proactive download already exists, updates its start position if the playhead advanced past it

#### 2. Proactive Prebuffer Task (Rust background task)

- Registered with coordinator as `is_continuation: true`
- Downloads from `start_byte` to `file_end`, filling cache gaps
- Skips already-cached chunks (checks `is_range_cached` per chunk)
- Throttled: lower priority than player-facing downloads (yields to them)
- Writes to `.dat` file + updates `CacheMeta` (same as ContinuationGuard)
- Auto-cancels when:
  - Player switches to a different file
  - Player stops playback
  - 3600s timeout
  - Entire file is cached

#### 3. Frontend: Position Reporting (in useMSEPlayer.ts quota guard)

- Every 10 seconds, calls `invoke('cmd_report_playback_position', { msg_id, current_time_s, folder_id })`
- Runs in the same 100ms quota guard interval
- Only reports when player is actively playing (not paused/stopped)
- Tracks last report time to avoid excessive calls

#### 4. Frontend: Green Bar (in FastStreamPlayer.tsx)

- Poll `cmd_get_cache_status(msg_id)` every 5 seconds during playback
- Display cache fill percentage as green bar behind white bar
- Already partially implemented — just needs more frequent polling

## What Changes vs What Stays Same

| Component | Change? | Notes |
|---|---|---|
| `/stream` endpoint | No | Already does CACHE-PREFIX from disk |
| `stream_cache.rs` | No | Already stores/downloads arbitrary ranges |
| `ContinuationGuard` | No | Still fills gaps on disconnect |
| `download_pool.rs` | No | Already supports streaming downloads |
| `cmd_report_playback_position` | **New** | ~50 lines Rust |
| Proactive prebuffer task | **New** | ~100 lines Rust |
| Frontend position reporting | **New** | ~20 lines in quota guard |
| Green bar polling | **Change** | More frequent cache status polling |

## Edge Cases

- **Seek to uncached position**: `/stream` downloads from Telegram (same as now), proactive task adjusts its start position
- **Network loss**: Proactive task pauses, resumes when network returns
- **Player stops**: Proactive task cancels
- **Multiple files**: Each msg_id gets its own proactive task, old one cancels when new file starts
- **SourceBuffer quota full**: White bar pauses, but green bar keeps moving (disk download continues)
- **File already fully cached**: Proactive task detects no gaps, exits immediately

## Byte Position Approximation

TS files are typically CBR (constant bitrate), so:
```
current_byte = (current_time_s / duration_s) * file_size
```

This is an approximation. Error is typically <2% for CBR TS files. When mpegts.js fetches from that byte position, it aligns to the nearest TS packet boundary (188-byte aligned), so small errors are self-correcting.

## Priority Model

| Priority | Source | Behavior |
|---|---|---|
| 1 (highest) | Player-facing `/stream` request | Immediate download, no throttle |
| 2 | ContinuationGuard (after disconnect) | Background, yields to priority 1 |
| 3 (lowest) | Proactive prebuffer task | Throttled, yields to priority 1 and 2 |

The proactive task checks `active_download_count(msg_id)` before downloading each chunk. If a player-facing download appears, the proactive task pauses until it finishes.

## Implementation Plan

1. Add `cmd_report_playback_position` to `commands/streaming.rs`
2. Add `start_proactive_prebuffer()` function to `server.rs` (reuses ContinuationGuard pattern)
3. Add `cancel_proactive_prebuffer(msg_id)` function to `server.rs`
4. Wire position reporting into quota guard in `useMSEPlayer.ts`
5. Increase green bar polling frequency in `FastStreamPlayer.tsx`
6. Test: verify disk cache fills continuously during playback, green bar always moves
