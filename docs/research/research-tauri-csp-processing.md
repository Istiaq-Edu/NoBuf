# Research: Tauri CSP Processing Pipeline Analysis

**Date**: 2026-05-27
**Context**: WebView2 blocks `http://nobuf-stream.localhost` and `http://localhost:14201` as media sources despite apparently correct sources in `tauri.conf.json`. This research investigates whether Tauri's internal CSP processing (parsing → modification → serialization) corrupts, removes, or modifies `media-src` sources.

---

## Executive Summary

**Tauri's CSP processing pipeline preserves all `media-src` sources correctly. No corruption, removal, or modification occurs.**

The root cause of the blocking issue is NOT a Tauri CSP processing bug. It is a **CSP configuration issue** combined with potential WebView2-specific behavior:

1. `nobuf-stream:*` is interpreted by browsers as a **host-source** (hostname="nobuf-stream", wildcard port), NOT as a scheme-source for `nobuf-stream://` URLs. Per the W3C CSP3 spec, custom protocol schemes must be specified as scheme-sources (e.g., `nobuf-stream:`), not host-sources.

2. `'self'` does NOT match `http://localhost:14201` because the ports differ (page origin is `http://localhost:14200`, resource is `http://localhost:14201`).

3. `http://localhost:*` SHOULD match `http://localhost:14201` per the CSP3 spec. If WebView2 blocks it, further investigation is needed to determine whether the CSP header actually reaches the browser correctly.

4. `http://nobuf-stream.localhost` SHOULD match `http://nobuf-stream.localhost` URLs. If WebView2 blocks it, the issue is likely in the header delivery or WebView2's CSP implementation.

---

## 1. Tauri CSP Pipeline — Step by Step

### 1.1 Configuration Input

Our CSP in `tauri.conf.json` (line 22):

```
"csp": "default-src 'self' http://localhost:* nobuf-stream:* http://nobuf-stream.localhost; connect-src 'self' http://localhost:*; media-src 'self' blob: http://localhost:* nobuf-stream:* http://nobuf-stream.localhost; img-src 'self' data: blob: asset: https://asset.localhost; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:;"
```

This is stored as `Csp::Policy(String)` via serde deserialization with `#[serde(untagged)]`.

### 1.2 Type Definitions (tauri-utils-2.9.2/src/config.rs)

```rust
// Lines 2383-2533
#[derive(Debug, PartialEq, Eq, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Csp {
    Policy(String),
    DirectiveMap(HashMap<String, CspDirectiveSources>),
}

#[derive(Debug, PartialEq, Eq, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum CspDirectiveSources {
    Inline(String),
    List(Vec<String>),
}
```

**Key**: `#[serde(untagged)]` means serde tries to deserialize as `DirectiveMap` first (HashMap), then falls back to `Policy(String)`. Since our CSP is a plain string, it deserializes as `Csp::Policy(String)`.

### 1.3 Parsing: `From<Csp> for HashMap<String, CspDirectiveSources>`

When `set_csp()` needs to modify the CSP, it converts `Csp::Policy(String)` into a HashMap via this `From` impl:

```rust
impl From<Csp> for HashMap<String, CspDirectiveSources> {
    fn from(csp: Csp) -> Self {
        match csp {
            Csp::Policy(policy) => {
                let mut map = HashMap::new();
                for directive in policy.split(';') {
                    let mut tokens = directive.trim().split(' ');
                    if let Some(directive) = tokens.next() {
                        let sources = tokens.map(|s| s.to_string()).collect::<Vec<String>>();
                        map.insert(directive.to_string(), CspDirectiveSources::List(sources));
                    }
                }
                map
            }
            Csp::DirectiveMap(map) => map,
        }
    }
}
```

**Tracing our CSP through this parser:**

Input: `"default-src 'self' http://localhost:* nobuf-stream:* http://nobuf-stream.localhost; connect-src 'self' http://localhost:*; media-src 'self' blob: http://localhost:* nobuf-stream:* http://nobuf-stream.localhost; img-src 'self' data: blob: asset: https://asset.localhost; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:;"`

Split on `;`:
1. `"default-src 'self' http://localhost:* nobuf-stream:* http://nobuf-stream.localhost"` → directive="default-src", sources=['self', 'http://localhost:*', 'nobuf-stream:*', 'http://nobuf-stream.localhost']
2. `" connect-src 'self' http://localhost:*"` → directive="connect-src", sources=['self', 'http://localhost:*']
3. `" media-src 'self' blob: http://localhost:* nobuf-stream:* http://nobuf-stream.localhost"` → directive="media-src", sources=['self', 'blob:', 'http://localhost:*', 'nobuf-stream:*', 'http://nobuf-stream.localhost']
4. `" img-src 'self' data: blob: asset: https://asset.localhost"` → directive="img-src", sources=['self', 'data:', 'blob:', 'asset:', 'https://asset.localhost']
5. `" style-src 'self' 'unsafe-inline'"` → directive="style-src", sources=['self', 'unsafe-inline']
6. `" script-src 'self'"` → directive="script-src", sources=['self']
7. `" worker-src 'self' blob:"` → directive="worker-src", sources=['self', 'blob:']
8. `""` (from trailing `;`) → directive="", sources=[] ← **trailing semicolon creates empty directive**

**Result**: All sources are preserved. `media-src` contains exactly ['self', 'blob:', 'http://localhost:*', 'nobuf-stream:*', 'http://nobuf-stream.localhost'].

**Minor issue**: The trailing `;` creates an empty directive entry with key `""`. This is harmless but adds garbage to the serialized output.

### 1.4 Modification: `set_csp()` Function (tauri-2.10.2/src/manager/mod.rs)

The `set_csp()` function modifies the CSP HashMap by:

1. **Nonce replacement** (`replace_csp_nonce`): Generates random nonces, replaces `{{nonce}}` or `%NONCE%` tokens in the HTML with actual nonce values, and adds `'nonce-<value>'` to `script-src` and `style-src` ONLY.

2. **Hash injection**: If `dangerous_disable_asset_csp_modification` is not set, adds SHA256/SHA384/SHA512 hashes of inline scripts/styles to `script-src` and `style-src` ONLY.

**Critical finding**: `set_csp()` ONLY modifies `script-src` and `style-src`. It does NOT touch `media-src`, `default-src`, `connect-src`, `img-src`, `worker-src`, or any other directive. The nonce/hash injection logic explicitly targets only script and style directives.

**For our CSP**: Our CSP has NO nonce tokens (`{{nonce}}` or `%NONCE%`) in the config, and our HTML may or may not have inline scripts/styles. Regardless, `media-src` sources are NEVER modified.

### 1.5 Serialization: `Display for Csp` (Csp::DirectiveMap → String)

After modification, the CSP is converted back to a string:

```rust
impl Display for Csp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Csp::Policy(s) => f.write_str(s),
            Csp::DirectiveMap(map) => {
                for (directive, sources) in map {
                    let sources: Vec<String> = sources.clone().into();
                    write!(f, "{directive} {}", sources.join(" "))?;
                }
                Ok(())
            }
        }
    }
}
```

**Key issue**: The `Display` impl iterates over a `HashMap`, which has **no guaranteed ordering**. Directives may appear in any order in the serialized string. However, CSP directive ordering is NOT significant per the W3C spec — browsers parse directives by name, not by position.

**`CspDirectiveSources → Vec<String>` conversion**:
```rust
impl From<CspDirectiveSources> for Vec<String> {
    fn from(sources: CspDirectiveSources) -> Self {
        match sources {
            CspDirectiveSources::Inline(source) => source.split(' ').map(|s| s.to_string()).collect(),
            CspDirectiveSources::List(l) => l,
        }
    }
}
```

For our case (all `List` variant), sources are just the Vec directly. No splitting or re-joining needed.

**Serialized output for `media-src`**: `'self' blob: http://localhost:* nobuf-stream:* http://nobuf-stream.localhost` — EXACTLY as parsed. No corruption, no loss, no modification.

### 1.6 Header Delivery: CSP → HTTP Response Header

The serialized CSP string is stored in `asset.csp_header: Option<String>`.

For the **localhost plugin** path (production mode):
- `tauri-plugin-localhost-2.3.2/src/lib.rs` sets the CSP header:
  ```rust
  if let Some(csp) = asset.csp_header {
      response.headers.insert("Content-Security-Policy".into(), csp);
  }
  ```
- This uses tiny_http's `Header::from_bytes()` to create the header.
- The header is set ONLY for responses where `asset.csp_header` is not None.

For the **custom protocol** path (development mode):
- `tauri-2.10.2/src/protocol/tauri.rs` sets the CSP header:
  ```rust
  builder.header("Content-Security-Policy", csp)
  ```
- Uses `http::Response::builder()` which is more robust.

### 1.7 Complete Pipeline Summary

| Step | Operation | media-src Impact |
|------|-----------|-----------------|
| 1. serde deserialize | String → `Csp::Policy(String)` | None (preserved as-is) |
| 2. `From<Csp> for HashMap` | Split on `;`, then split each directive on ` ` | All sources preserved in Vec |
| 3. `set_csp()` nonce replacement | Add nonce to script-src, style-src only | **NOT modified** |
| 4. `set_csp()` hash injection | Add hashes to script-src, style-src only | **NOT modified** |
| 5. `Display for Csp` (serialize) | Join sources with spaces, iterate HashMap | Sources joined correctly, ordering varies |
| 6. HTTP header | Set `Content-Security-Policy` header | Full string delivered |

**Verdict**: Tauri's CSP pipeline preserves `media-src` sources correctly at every step. No corruption, removal, or modification occurs.

---

## 2. Minor Issues Found

### 2.1 Trailing Semicolon Creates Empty Directive

The CSP string ends with `;`:
```
worker-src 'self' blob:;
```

After splitting on `;`, the last element is an empty string `""`. This creates a HashMap entry with key `""` and empty sources. When serialized back, it produces an empty directive like ` ""` at the end.

**Impact**: Harmless. Browsers ignore directives with empty names per the W3C CSP spec (the spec requires `directive-name = 1*( ALPHA / DIGIT / "-" )`, so an empty name is invalid and skipped).

**Fix**: Remove the trailing `;` from the CSP string in `tauri.conf.json`. This is cosmetic, not functional.

### 2.2 HashMap Iteration Order

The `Display for Csp` impl iterates over `HashMap` entries, which have no guaranteed ordering. This means the serialized CSP string may have directives in any order (e.g., `media-src` could appear before or after `default-src`).

**Impact**: **No functional impact.** CSP directive ordering is NOT significant per the W3C spec. Browsers parse each directive by its name, regardless of position in the string. However, the output string is less readable for debugging.

### 2.3 Directive Value Serialization Format

When `Display for Csp` serializes a directive, it uses:
```rust
write!(f, "{directive} {}", sources.join(" "))
```

This produces `directive-name source1 source2 source3` with a single space between the directive name and the first source, and spaces between sources. There is NO semicolon between directives — they're just concatenated with spaces between them.

Wait — actually looking more carefully:
```rust
for (directive, sources) in map {
    let sources: Vec<String> = sources.clone().into();
    write!(f, "{directive} {}", sources.join(" "))?;
}
```

There is NO `;` separator between directives in the `for` loop! Each directive is written as `directive sources`, but there's no `;` between them. This means the serialized CSP would look like:

```
default-src 'self' http://localhost:* nobuf-stream:* http://nobuf-stream.localhostmedia-src 'self' blob: http://localhost:* nobuf-stream:* http://nobuf-stream.localhostconnect-src 'self' http://localhost:*
```

**Wait — this is a CRITICAL bug if true!** Without `;` separators, the browser would parse the entire string as a single directive. Let me re-examine...

Actually, looking at the Rust `write!` macro, it writes to the formatter `f`. The `?` after `write!` propagates errors but doesn't add separators. Let me look at this more carefully.

```rust
Csp::DirectiveMap(map) => {
    for (directive, sources) in map {
        let sources: Vec<String> = sources.clone().into();
        write!(f, "{directive} {}", sources.join(" "))?;
    }
    Ok(())
}
```

There is NO separator between iterations of the loop! The output would be:
```
default-src 'self' http://localhost:* ...worker-src 'self' blob:
```

All directives concatenated without `;` separators. The browser would parse the entire string as one directive: `default-src` with value `'self' http://localhost:* ...worker-src 'self' blob:`.

**This IS a critical serialization bug in Tauri's CSP Display implementation!** However, let me verify this by looking at the actual output...

Actually, wait. I need to re-read the code more carefully. The `write!` macro uses the formatter, and `fmt::Formatter` has a `pad` method. Let me check if there's any separator logic I'm missing.

Hmm, actually let me look at this differently. The `Display` trait is used by `to_string()`. The `fmt` method writes directly to the formatter. There's no implicit separator between `write!` calls. So if the loop does:
```rust
write!(f, "default-src {}", "source1 source2")?;  // writes "default-src source1 source2"
write!(f, "media-src {}", "source3 source4")?;     // writes "media-src source3 source4"
```

The result would be `"default-src source1 source2media-src source3 source4"` — no separator!

**This IS a bug in the Display implementation!** But wait — does this actually matter in practice? Let me check how the CSP is actually used.

Looking at `set_csp()`:
```rust
let mut csp_map = set_csp(&mut asset, &self.assets, &asset_path, self, csp);
csp_header.replace(Csp::DirectiveMap(csp_map).to_string());
```

So `Csp::DirectiveMap(csp_map).to_string()` calls the `Display` impl. If the `Display` impl is buggy (no `;` separators), the CSP header would be malformed.

But wait — let me reconsider. Maybe I'm wrong about the code. Let me re-read the actual Display implementation more carefully from the source file.

Actually, I need to go back and read the exact code. My summary from the previous session may have been imprecise. Let me verify this now.
