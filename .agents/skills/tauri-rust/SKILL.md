---
name: tauri-rust
description: Tauri 2.x development patterns — Rust commands, IPC, state, plugins, and WebView2 integration
user-invocable: true
---

## Tauri 2.x Development Guide

You are an expert in Tauri 2.x desktop app development with Rust backends and React/TypeScript frontends.

### Architecture
- **Frontend**: React/TypeScript in WebView2 (Chromium-based)
- **Backend**: Rust with `tauri` crate, commands invoked via IPC
- **Communication**: `@tauri-apps/api` invoke() ↔ `#[tauri::command]`

### Rust Commands
```rust
#[tauri::command]
async fn my_command(state: State<'_, AppState>) -> Result<String, String> {
    // Always return Result — errors become JS exceptions
    Ok("result".to_string())
}
```
- Use `State<'_, T>` for shared state (register via `.manage()`)
- Use `async` for I/O-bound operations
- Return `Result<T, String>` — errors surface as promise rejections

### Frontend Invocation
```typescript
import { invoke } from '@tauri-apps/api/core';
const result = await invoke<string>('my_command', { arg1: 'value' });
```

### Tauri Plugins Used
- `@tauri-apps/plugin-dialog` — file picker, message boxes
- `@tauri-apps/plugin-process` — restart, exit
- `@tauri-apps/plugin-shell` — open URLs, run commands
- `@tauri-apps/plugin-store` — persistent key-value storage
- `@tauri-apps/plugin-updater` — auto-update mechanism

### Tauri Events (bidirectional)
```typescript
// Listen from Rust
import { listen } from '@tauri-apps/api/event';
const unlisten = await listen('event-name', (e) => { /* handle */ });

// Emit from Rust
app.emit("event-name", payload)?;
```

### Common Patterns
- **File operations**: Use Tauri's `fs` plugin or Rust-side file I/O, never Node.js `fs`
- **Dialogs**: Always use `@tauri-apps/plugin-dialog`, not browser `alert/confirm`
- **Window access**: `import { getCurrentWindow } from '@tauri-apps/api/window'`
- **WebView2 features**: MSE, Web Audio, IndexedDB, Workers all supported natively

### Pitfalls
- Don't use `node:` imports — there's no Node.js runtime
- `localStorage` works but `@tauri-apps/plugin-store` is more reliable for persistence
- Rust panics crash the app — use `Result` everywhere
- Large payloads via IPC have limits — stream data instead of sending bulk

### Build & Dev
```bash
cd app/
npm run dev          # Start Vite dev server
npm run tauri dev    # Start Tauri dev (Rust + frontend)
npm run tauri build  # Production build
```
