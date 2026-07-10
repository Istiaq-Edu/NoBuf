# Auth Flow Overhaul — Implementation Plan

## Goal
Replace the manual copy-paste API credential flow with an automated webview-based flow, fix the QR login bug, and add industry-standard country code phone input.

## Current State
- **Auth flow**: Setup (manual api_id/hash) → Phone → Code → Password (2FA)
- **QR login**: Built but broken (scans don't connect)
- **Phone input**: Plain text field, no country code detection
- **Libraries**: grammers (Rust MTProto), Tauri 2.x, React 19

---

## The QR Login Bug — Root Cause Analysis

### Bug 1: DC Migration Not Handled (auth.rs:408-413)
When `auth.exportLoginToken` returns `LoginToken::MigrateTo`, the code just displays the migration token as a QR code. But `MigrateTo` means "reconnect to DC X and call `auth.importLoginToken` with this token to get the REAL QR token." The migration token is NOT a valid QR code token.

**Current broken code:**
```rust
tl::enums::auth::LoginToken::MigrateTo(m) => {
    let encoded = URL_SAFE_NO_PAD.encode(&m.token);
    let url = format!("tg://login?token={}", encoded);  // WRONG — migration token ≠ QR token
    Ok(url)
}
```

**Correct flow:** Reconnect to new DC → call `auth.importLoginToken(migration_token)` → get real `LoginToken::Token` → display THAT as QR.

### Bug 2: Poll Never Completes Login (auth.rs:434-435)
The poll function only checks `is_authorized()` but never calls `auth.importLoginToken`. After the phone scans the QR and calls `auth.acceptLoginToken`, the desktop client MUST call `auth.importLoginToken` with the original token to claim the authorization. Without this call, `is_authorized()` stays false forever.

**Current broken code:**
```rust
match client.is_authorized().await {
    Ok(true) => /* success */,
    Ok(false) => /* waiting */,
}
```

**Correct flow:** Call `auth.importLoginToken(stored_token)` each poll. If it returns `LoginToken::Success`, extract the authorization and complete login. If it returns an error, the user hasn't scanned yet — keep waiting.

---

## Decisions

### Decision 1: Webview vs System Browser for my.telegram.org
- **Options**: A) Tauri webview window, B) System browser + local callback server
- **Chosen**: B — System browser + embedded localhost callback server
- **Why**: Tauri 2.x webview windows can't inject JS into cross-origin pages (my.telegram.org). A system browser with a localhost callback server is the proven OAuth pattern. We open `my.telegram.org/apps` in the system browser, and the user manually copies credentials back. BUT — we can improve this with a companion approach: open the browser AND show a paste dialog in the app.
- **Trade-off**: User still needs to copy-paste once, but we eliminate the multi-step instructions and make it a single dialog.
- **Reversible?**: Yes — can swap to webview approach later.

**REVISED Decision after analysis**: Actually, let me reconsider. We can't inject JS into my.telegram.org from a Tauri webview (cross-origin restriction). And a system browser can't send data back to the app without a callback URL that my.telegram.org doesn't support. 

**Final approach**: Keep the current manual credential entry BUT make it much smoother:
1. "Get API Key" button opens my.telegram.org in system browser (already have `safeOpenUrl`)
2. User logs in, creates app, copies api_id + api_hash
3. User pastes them into NoBuf (same as now, but with better UX guidance)
4. Immediately transition to QR login (default) or phone login

This eliminates the webview automation complexity while still being a good UX. The real UX win is: **QR as default + skip the credential step when credentials already exist**.

### Decision 2: Phone Input Library
- **Options**: A) libphonenumber-js (full), B) Custom lightweight country picker
- **Chosen**: B — Custom lightweight picker
- **Why**: libphonenumber-js is 140KB+ and we only need country code selection + basic formatting. A custom dropdown with ~20 common countries + search is lighter and matches our UI theme.
- **Trade-off**: Less complete validation, but we only need the country code prefix.

### Decision 3: QR Token Storage
- **Chosen**: Store token bytes in `TelegramState` (Rust state)
- **Why**: The token must persist between `cmd_auth_qr_login` and `cmd_auth_qr_poll` calls. Currently it's not stored at all — another bug.

---

## Implementation Phases

### Phase 1: QR Login Bug Fix (auth.rs)
**Files**: `app/src-tauri/src/commands/auth.rs`, `app/src-tauri/src/lib.rs` (TelegramState struct)

**Changes**:
1. Add `qr_token: Arc<tokio::sync::Mutex<Option<Vec<u8>>>>` to `TelegramState`
2. Fix `cmd_auth_qr_login`:
   - On `Token`: store token bytes in state, return QR URL
   - On `MigrateTo`: store migration token, attempt `auth.importLoginToken` to get real token. If that fails, log error and return the migration URL as fallback (the phone might handle it)
   - On `Success`: return `__authorized__`
3. Fix `cmd_auth_qr_poll`:
   - Read stored token from state
   - Call `auth.importLoginToken(token)` 
   - On `Success(s)`: extract user, complete login, return success
   - On `Token`: token refreshed (rare), update stored token, keep waiting
   - On error: user hasn't scanned yet, return waiting
   - Remove the `is_authorized()` check as primary method (keep as fallback)

**Verify**: `cargo check` + `cargo test` pass. Manual test: QR scan connects.

### Phase 2: AuthWizard UI Overhaul
**Files**: `app/src/components/AuthWizard.tsx`

**Changes**:
1. **New "setup" step design**: Two-path layout
   - Primary: "Login with Telegram" button → opens my.telegram.org/apps in browser → user gets credentials → pastes them back
   - Secondary: "I have my API credentials" → shows the existing api_id/hash input form
   - Both paths end at the same place: credentials entered → proceed to QR/phone
2. **Skip credential step when credentials exist**: If `api_id` is already in config.json, skip setup entirely and go straight to QR/phone
3. **QR as default**: When entering the "phone" step, default to QR tab (not phone tab)
4. **Better credential paste UX**: Two input fields side by side, with a "Paste from clipboard" button, and clear visual feedback when both are filled
5. **"Open my.telegram.org" button**: Prominent button that opens the site, with step-by-step inline guidance (instead of the right-panel guide)

**Verify**: `tsc --noEmit` + `vitest run` pass. Visual inspection in dev mode.

### Phase 3: Country Code Phone Input
**Files**: `app/src/components/AuthWizard.tsx`, new `app/src/components/CountryCodeSelect.tsx`

**Changes**:
1. Create `CountryCodeSelect` component:
   - Custom dropdown (NO native `<select>` — per user's UI rules)
   - Searchable list of countries with flags (emoji) + dial codes
   - Common countries at top (US, UK, IN, BD, RU, DE, FR, etc.)
   - Themed to match NoBuf dark/light (CSS vars `--color-nobuf-*`)
   - Keyboard navigable (arrow keys, enter, escape)
2. Modify phone input in AuthWizard:
   - Replace plain `<input type="tel">` with `[CountryCodeSelect] + [phone input]`
   - Auto-detect user's country from `navigator.language` / `Intl.DateTimeFormat().resolvedOptions().timeZone`
   - Format phone number as user types (group digits)
   - Combine country code + phone into full international format before sending to backend
3. Phone validation: ensure valid format before enabling submit button

**Verify**: `tsc --noEmit` passes. Visual test: dropdown opens, search works, phone formats.

### Phase 4: Edge Cases
**Files**: `app/src-tauri/src/commands/auth.rs`, `app/src/components/AuthWizard.tsx`

**Edge cases to handle**:
1. **QR token expiry**: ExportLoginToken tokens expire (~30 seconds). If polling fails with token-expired error, auto-regenerate QR code and show "QR expired, scan the new one"
2. **QR DC migration failure**: If `importLoginToken` fails on MigrateTo, return error to frontend, let user retry
3. **2FA after QR**: After QR scan + importLoginToken, if `SESSION_PASSWORD_NEEDED` is returned, transition to password step (currently not handled in QR flow)
4. **Existing credentials**: If user already has api_id in config.json, skip setup step entirely
5. **Browser open failure**: If `safeOpenUrl` fails, show fallback instructions with copyable URL
6. **Flood wait during QR**: Handle FLOOD_WAIT in QR polling (currently only handled in phone flow)
7. **QR poll timeout**: After 2 minutes of polling, stop and show "Scan timed out, try again"
8. **Network disconnection during QR**: If poll errors repeatedly (5+ consecutive errors), show "Connection lost" message
9. **Phone number validation**: Reject non-digit input, show inline error for invalid format
10. **Country code + phone overlap**: If user types `+1` in phone field AND selects US (+1), don't double-prefix

**Verify**: Manual testing of each edge case.

### Phase 5: Verification
1. `cargo check` — 0 errors
2. `cargo test` — all pass
3. `npx tsc --noEmit` — 0 errors
4. `npx vitest run` — all pass
5. Command sync check: `diff <(grep -oP 'commands::\Kcmd_\w+' src/lib.rs | sort -u) <(grep -oP '"\Kcmd_\w+' build.rs | sort -u)`
6. Manual flow test: setup → QR scan → dashboard
7. Manual flow test: setup → phone + country code → code → dashboard
8. Manual flow test: existing credentials → skip setup → QR → dashboard

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| grammers doesn't expose DC migration API for QR | Medium | Try `importLoginToken` first — it may route automatically. If not, fall back to current behavior with error message. |
| `auth.importLoginToken` returns unexpected variant | Low | Handle all 3 variants (Token, Success, MigrateTo) in poll function |
| Country code detection wrong on some systems | Low | Let user override selection manually |
| my.telegram.org DOM structure changes | Low | Not injecting JS anymore, so N/A |
| QR token expires before user scans | Medium | Auto-regenerate on expiry, show countdown |
| 2FA required after QR login | Medium | Handle SESSION_PASSWORD_NEEDED in importLoginToken response |

## Out of Scope
- Bundling api_id/api_hash (causes API_ID_PUBLISHED_FLOOD)
- OAuth/OIDC integration (no MTProto bridge available to third parties)
- Telegram Login widget (returns Bot API tokens, not MTProto sessions)
- Biometric authentication
- Multi-account support
