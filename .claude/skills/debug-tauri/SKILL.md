---
name: debug-tauri
description: Debugging Tauri apps — DevTools, Rust panics, IPC logging, and common development workflow issues
user-invocable: true
---

## Tauri Debugging Guide

Expert debugging techniques for Tauri 2.x desktop applications.

### Opening DevTools
- **Right-click → Inspect** in the app window (WebView2 DevTools)
- **Console tab** for frontend JavaScript logs
- **Network tab** for IPC calls and HTTP requests

### Frontend Debugging
```typescript
// Console logging works normally
console.log('Debug:', data);
console.table(arrayData);

// Tauri-specific: log IPC calls
import { invoke } from '@tauri-apps/api/core';
console.log('Invoking command:', commandName, args);
```

### Rust Backend Debugging
```rust
// Use tracing or env_logger for Rust-side logging
use log::{info, warn, error};

#[tauri::command]
async fn my_command() -> Result<String, String> {
    info!("Command called with args");
    // ...
    Ok("done".to_string())
}
```

Set `RUST_LOG=debug` environment variable to see Rust logs.

### IPC Call Debugging
- Check **Network tab** in DevTools for IPC requests
- Verify command name matches `#[tauri::command]` function name exactly
- Check argument types match between TS invoke and Rust command signature
- Rust panics show as unhandled promise rejections in JS console

### Common Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| `invoke is not a function` | Wrong import | Use `@tauri-apps/api/core` |
| Command not found | Not registered | Add to `.invoke_handler(tauri::generate_handler![...])` |
| Type mismatch | TS/Rust type divergence | Use `serde` derives, check JSON shape |
| Blank white screen | Build error | Check `npm run build` output |
| Rust panic | Missing `Result` | Wrap in `Ok/Err`, add error handling |
| Permission denied | Tauri allowlist | Check `tauri.conf.json` permissions |

### Tauri Config (`tauri.conf.json`)
```json
{
  "build": { "devUrl": "http://localhost:1420" },
  "app": { "security": { "csp": null } },
  "plugins": {}
}
```
- `devUrl` — Vite dev server URL for development
- `csp` — Content Security Policy (null = permissive for dev)
- Check `plugins` section for required permissions

### Development Workflow
```bash
# From app/ directory
npm run dev         # Terminal 1: Vite dev server (hot reload)
npm run tauri dev   # Terminal 2: Tauri with Rust backend

# Rust code changes → Tauri auto-rebuilds
# Frontend code changes → Vite hot-reloads
```

### Performance Profiling
- **Frontend**: DevTools Performance tab, React DevTools Profiler
- **Rust**: `cargo flamegraph` for backend profiling
- **Memory**: DevTools Memory tab for JS heap; `valgrind` for Rust
