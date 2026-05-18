---
name: telegram-grammers
description: Telegram API with grammers library — download iterators, raw TL types, file size gotchas, and streaming patterns
user-invocable: true
---

## Telegram Grammers Library Guide

Expert guidance for using the `grammers` Rust library to interact with Telegram's API.

### Core Libraries
- `grammers-client` — Main client, auth, file operations
- `grammers-session` — Session persistence
- `grammers-tl-types` — Raw Telegram type definitions

### Download Iterator API (CRITICAL)
grammers uses a **chunk-based iterator**, NOT offset-based range downloads:

```rust
// CORRECT — use chunk_size + skip_chunks for range access
let iter = client.iter_download(message.media())
    .chunk_size(64 * 1024)  // 64KB chunks
    .skip_chunks(start_chunk);  // Skip to position

// WRONG — there is no .offset() method
// let iter = client.iter_download(media).offset(1024); // DOES NOT EXIST
```

### File Size Gotcha
```rust
// WRONG — d.size() often returns 0
let size = d.size();  // May be 0!

// CORRECT — use raw TL types
use grammers_tl_types::enums::Message;
if let Message::Message(msg) = &message {
    if let Some(media) = &msg.media {
        // Extract size from raw TL structure
    }
}
```

### Media Access Patterns
```rust
// Get media from message
let media = message.media();  // Option<Media>

// Download to file
client.download_media(&message, path).await?;

// Stream download (chunk iterator)
let mut iter = client.iter_download(message.media());
while let Some(chunk) = iter.next().await? {
    // Process chunk bytes
}
```

### Session Management
```rust
// Persist session to file
let session = Session::load_file("session.session").await
    .unwrap_or(Session::new());

let client = Client::connect(Config {
    session,
    api_id,
    api_hash: api_hash.to_string(),
    ..Default::default()
}).await?;
```

### Streaming Architecture
```
1. Client requests file by message_id
2. Rust: iter_download with chunk_size + skip_chunks
3. Stream chunks via Tauri command to frontend
4. Frontend: append to MSE SourceBuffer
```

### Common Pitfalls
- **No `.offset()` method** — Use `skip_chunks(n)` to jump to position
- **`d.size()` returns 0** — Always use raw TL types for file size
- **Rate limiting** — Telegram throttles large downloads; add delays between chunks
- **Session expiry** — Handle `AuthKeyError` and re-auth
- **Media types** — Check `Document`, `Photo`, `Video` variants before downloading

### Debug Tips
- Log the raw TL type to understand the structure
- Use `grammers_session::ChatMap` for resolving peer IDs
- Test with small files first (photos) before videos
