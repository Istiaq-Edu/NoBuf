# Security Review — Vault Design (docs/specs/2026-08-22-vault-design.md)

**Reviewer:** Adversarial security pass, fresh eyes (did not author spec)
**Date:** 2026-08-22 · **Branch:** feature/vault-hide-channels
**Stance under attack:** "soft security at the app-UI level" (spec line 11)

---

## Q1 — Local REST/streaming API bypass of the vault filter

### Finding 1 — Required: Both localhost servers serve vaulted folders/channels with zero vault awareness; spec never says so

**Verdict on the question: YES — every content endpoint serves by `folder_id`/channel id and NONE consults the vault filter or vault state.**

Exact routes and their auth:

| Route | Serves | Auth | Evidence |
|---|---|---|---|
| `GET /api/v1/files?folder_id=<id>` | Full file listing (name, size, mime, date) of ANY folder incl. vaulted | `X-API-Key` header vs salted-hash key (`check_auth`, api_routes.rs:37-53) | api_routes.rs:125-190 |
| `GET /api/v1/files/{message_id}?folder_id=<id>` | File metadata | same | api_routes.rs:197-246 |
| `GET /api/v1/files/{message_id}/download` | Full bytes, Range-capable | same | api_routes.rs:298-433 |
| `HEAD /api/v1/files/{message_id}/download` | Size/mime probe | same | api_routes.rs:249-296 |
| `GET /stream/{folder}/{msg}?token=…` (+ HEAD, remux, hover-thumb, audio/subs tracks, fMP4 init/seg/meta/kf, faststart, HLS manifest/segments) | Media bytes of ANY message incl. vaulted channels | per-launch random 32-hex-char stream token, constant-time compared (`constant_time_eq`) | server.rs:887-903 (gate), :7797-7832 (registration); lib.rs:43-47,220 (token gen); hls/manifest.rs:430-434; faststart.rs:492,575 |

Server binding: both loopback-only — `127.0.0.1` (server.rs:7855; lib.rs:112). REST server additionally off unless enabled in settings (lib.rs:75) and returns `401 NO_KEY_CONFIGURED` when no key exists (api_routes.rs:38-41). CORS is origin-pinned to the two app origins + `nobuf-stream.localhost` on both servers (lib.rs:100-103; server.rs:7798-7802), so a random *web page* in the user's browser cannot read JSON responses cross-origin; the stream token also keeps `<video>` drive-bys out.

**Severity: Required (spec gap), not Critical — honest rating given the stated threat model.** A same-machine attacker who can run `curl` is inside the app's trust boundary: they can already read `%APPDATA%` (Telegram session, caches) without any of this. Within that model nothing here *escalates* to content they couldn't otherwise reach. BUT the spec's framing — "hidden items disappear from all normal UI" (line 9), "The passcode gates what NoBuf *reveals*" (line 11) — is false at the HTTP layer, and the spec never acknowledges it. Anyone implementing or testing against this spec would reasonably believe the passcode bounds disclosure. Two concrete aggravators:

1. The REST file listing is a *directory dump*: one unauthenticated-in-spirit request (`curl -H "X-API-Key: …" "http://127.0.0.1:<port>/api/v1/files?folder_id=-100…"`) enumerates every filename in a vaulted `[NB]` folder — exactly the "what does this person hide" disclosure the feature exists to prevent.
2. If the user has ever enabled the REST API, the key is long-lived (persisted hash, api_settings.rs pattern); the vault adds zero friction to that path.

**Required fix (documentation-level, matches D2 scope):** add an explicit paragraph to §1/§5 stating: *"The localhost REST/streaming servers do not know about the vault. Any process on the machine with the API key or stream token can list/download/stream vaulted content by id. The vault gates the GUI only."* Optionally Consider: have `configure_api`/`resolve_media_from_path` return 404 for vaulted ids while locked — cheap (~one mutex-guarded set lookup) and makes the claim true end-to-end; but it is genuinely optional under D2.

---

## Q2 — On-disk leakage of hidden channel/folder NAMES

### Finding 2 — FYI/Consider: Hidden names persist in at least two plaintext stores the spec never mentions

Checked each surface:

| Surface | Leaks names? | Evidence |
|---|---|---|
| Tauri store plugin file | **YES** | Folders are persisted as full `TelegramFolder[]` objects — `{id, name, parent_id}` (types.ts:11-15) — into store `config.json` (fallback `settings.json`) in app-data: load at useTelegramConnection.ts:25-43, reorder persist at :279-285. Vaulted folder names sit there in cleartext forever, regardless of vault state. |
| Public channels SQLite DB | **YES** | `nobuf_groups.db` table `public_channels(name TEXT NOT NULL, username…)` (public_channels.rs:16-27, db_path() :12-13). Vaulted public channel names/usernames readable from the DB file. |
| Peer cache | No | In-memory only: `Arc<RwLock<HashMap<i64, Peer>>>`, no disk serialization found (commands/mod.rs:29; commands/utils.rs:21-36). |
| Stream cache metadata | File NAMES only (not channel names), keyed by message_id | `.meta.json` sidecars hold `{message_id, folder_id, filename,…}` — no channel/folder title (stream_cache.rs:229-247, :516). |
| Sprite/thumbnail caches | No | Generated per-message via ffmpeg against stream URLs; artifacts keyed by message id, no titles (commands/sprite.rs:76,191,224). |
| Backend logs | No channel titles found | grepped all `log::*` lines mentioning title/channel/folder name across src-tauri — only ids and filenames are logged (e.g. server.rs:936,5564,7597). No tauri-plugin-log file sink configured (absent from lib.rs/Cargo.toml), so log exposure ≈ console-only anyway. |
| Window title / document.title | No | No runtime `setTitle`/dynamic `document.title` writes found in app/src. |

**Severity: FYI for the design itself, but Consider adding one sentence to §4.3:** "Vaulted items remain in existing local stores (store plugin `folders` array, `nobuf_groups.db`) in plaintext." This is consistent with D2 soft-security (the same attacker can read Telegram's own session files), but the spec currently implies hidden = unrevealed, and a future contributor "fixing" leaks should know these two sinks exist. If the team wants the *count* honest but names gone, that's out of scope here — just say it aloud.

---

## Q3 — PBKDF2 parameter adequacy for the stated soft-security model

**Measured on this machine (Python 3.11 `hashlib.pbkdf2_hmac`, OpenSSL backend — representative of a Rust/`ring`-class implementation within ~1.5×):**

| Iterations | ms/hash (single core) | hashes/sec/core | 4-digit exhaust (10⁴) | 6-digit (10⁶) | 8-digit (10⁸) | 12-digit (10¹²) |
|---|---|---|---|---|---|---|
| 100k (spec) | 23.9 | 42 | **4 min** single-core / <1 min on 8 cores | 6.6 h / 0.8 h | 27.6 d / 3.5 d | ~750 yr / ~95 yr |
| 600k (OWASP-style) | 143.9 | 7 | **24 min** / 3 min | 40 h / 5 h | 166 d / 21 d | ~4500 yr / ~570 yr |

(600k = exactly **6.03×** slower; unlock latency cost = +120 ms per attempt, imperceptible behind an existing modal.)

### Finding 3a — Consider: 100k iters is *adequate* for D2 but leaves the most realistic passcodes trivially offline-crackable; 600k costs nothing

The threat that actually matters is **vault.json alone**: attacker copies one JSON file, no Telegram session, no API access. Against that file, passcodes of 4–6 digits fall in minutes-to-hours at 100k; even at 600k, 4-digit codes still fall in under 25 minutes on one core. The spec's own framing makes this acceptable — D2 says soft/recoverable, and §1 says the gate is about what NoBuf reveals, not content protection. So: **not Required.** But since `vault_verify` is rate-limit-free by design (D8) and vault.json is a single copyable file, bumping to 600k is nearly free UX-wise and buys a real 6× against the only offline attack that exists. Recommend: store `iterations` in the file (spec already does, line 59), use 600k, verify-once-per-unlock so the latency lands once.

### Finding 3b — Nit: salt length unspecified in spec

Spec says "random hex" (line 58). Pin it: ≥16 random bytes (32 hex chars) from `rand::thread_rng()`/`OsRng`. A 4-byte salt would make rainbow-table precomputation across many victims cheap. One-line spec fix.

---

## Q4 — vault_verify timing sidechannel

### Finding 4 — Consider: use the already-vendored `constant_time_eq`; timing is not a realistic remote exploit here

Is a string-compare timing oracle exploitable? Honestly: **no, not remotely.** Two independent reasons:

1. **The comparison isn't the bottleneck.** `vault_verify` computes PBKDF2 first; PBKDF2 runtime dominates and varies with nothing secret-relevant. Any residual jitter (async runtime scheduling, actix/Tauri IPC marshalling across processes) is orders of magnitude above nanosecond-scale byte-compare differences.
2. **No lockout / no rate limit (D8)** means an attacker who can measure timings can also just… try more passcodes outright, which is strictly faster than extracting bits via statistics.

The only semi-plausible local angle: a co-resident process doing high-resolution cache-timing on the same core. That attacker is again inside the trust boundary (see Q1 severity logic) and could read vault.json directly.

**Recommendation (sized to the threat):** do NOT add the `subtle` crate — `constant_time_eq = "0.3"` is already a direct dependency (Cargo.toml:53) and is the codebase's established idiom: `verify_key` uses exactly this pattern (api_settings.rs:88-91), and every stream endpoint token check does too (server.rs:896). Spec should name it explicitly in §4.1: *"compare computed vs stored hash with `constant_time_eq::constant_time_eq`, same as `verify_key`."* Replace the vague "constant-time-ish" wording (spec line 77). Also worth stating: because both inputs are fixed-length SHA-256 hex digests, early-exit leakage would leak at most "how many leading hex chars match", which is information-free about the passcode itself — constant-time compare here is hygiene, not armor. That's fine; say so.

---

## Q5 — Reset flow abuse

### Finding 5 — checked: OK, with one Consider for explicitness

The spec **does** specify both halves of the question:

- **Confirm dialog:** yes — D8 (spec line 38): `"Reset Vault" link → one confirm → passcode cleared`; command contract repeats it (`vault_reset … One-time destructive action`, line 81).
- **Placement:** the Reset link lives on the lock screen itself (line 92: *"If locked → lock screen modal (passcode input, Reset link)"*), reachable with no passcode — which is the point of D8/recovery-always (line 11).
- **Scope honesty:** edge-case table states both lists are cleared and entry visibility survives (line 108); test plan asserts reset wipes everything (line 122).

**Consider (one sentence, not Required):** the spec never spells out the corollary that the passcode therefore provides **zero protection against anyone with physical/keyboard access** — a roommate or shoulder-surfer unhides everything in three clicks with no secret. That is the deliberate price of D2 recoverability, but §1 currently reads like the passcode *conceals*, when for the at-keyboard adversary it merely delays. Add to §1: *"Because reset must always work without the passcode, the vault offers no protection against a person with access to the unlocked desktop."* Cheap words now prevent a future "security bug" report.

---

## Q6 — Count badge (D15) and any WORSE non-opted-in leaks

### Finding 6 — Required: startup restores `activeFolderId` from disk and the file pane will render a vaulted folder's contents with NO filter anywhere in the spec's design

This is a genuine leak the user did not opt into, and the spec's "load-bearing" filter rule (§4.2, line 90) does **not** cover it:

1. On every launch, the connection hook restores `activeFolderId` from the store plugin **unconditionally**: `const savedActiveFolderId = await _store.get<number|null>('activeFolderId'); if (savedActiveFolderId !== undefined) setActiveFolderId(savedActiveFolderId);` (useTelegramConnection.ts:38). If the app was closed inside a vaulted folder, that id is now a hidden id.
2. The main file list is keyed on **`activeFolderId`, not `activeView`**: `queryKey: ['files', activeFolderId], queryFn: invoke('cmd_get_files', { folderId: activeFolderId })` (Dashboard.tsx:157-158).
3. In a non-public view the rendered list IS that result: `const allFiles = isPublicView ? pubChannelFiles : nbFiles;` (Dashboard.tsx:166), passed straight to `<FileExplorer files={displayedFiles}>` (Dashboard.tsx:773-775).

Net effect: reopen the app after hiding folder X while X was open → **X's entire file listing renders at startup**, before any unlock, with no vault interaction at all. The spec's §4.2 rule filters the `folders`/`publicChannels` arrays for Sidebar/pickers — it says nothing about the persisted-selection restore path, so an implementer following the spec to the letter ships this bug. (Same shape applies to a restored public-channel view, though `activeView.type==='public'` re-rendering a hidden channel is partially mitigated by the D14-style jump only being specified for hide-time, not restore-time.)

**Required spec fix:** add an edge case to §4.3 — *"Startup restore of `activeFolderId`/`activeView`: VaultContext must load before/independent of restore; if the persisted selection references a vaulted item, reset to Saved Messages and clear the persisted value (locked OR unlocked)."*

### Finding 6b — checked: OK on the remaining surfaces

- Count badge (D15): counts only, IDs/names never returned while locked (spec line 73 explicitly gates IDs) — matches the user's opt-in.
- Pickers: D13 (line 114) covers Move/Forward.
- No global search exists to leak through (spec line 25; verified — no search-over-everything code path found).
- In-flight transfers keep showing after hide — documented deliberately as "not a leak fix" (line 107), so opted-in by spec.
- Reorder persistence writes the full array including hidden names — pre-existing sink, already flagged in Finding 2, unchanged by the vault.
- D10 drop-while-locked toast reveals nothing about contents — OK.

---

## Verdict: **Request changes**

Two Required items, both cheap:

1. **Finding 1** — document (or optionally enforce at the handlers) that the localhost REST/streaming servers bypass the vault entirely; today the spec's central claim ("the passcode gates what NoBuf reveals") is false at the HTTP layer and nobody reading §1–§5 would know.
2. **Finding 6** — add the startup-restore edge case to §4.3; without it, the flagship implementation follows the letter of the spec and still renders a hidden folder's contents at launch.

Recommended-but-not-blocking: 600k iterations (Finding 3a), salt length pinned (3b), name `constant_time_eq` instead of "constant-time-ish" (4), one-sentence reset-tradeoff acknowledgment (5), plaintext-store note (2).

## What I verified vs assumed

**Verified (read/benched/grepped, file:line above):**
- Every REST route + its auth path (api_routes.rs read in full); streaming/fMP4/HLS/faststart/subtitles/thumb endpoints all funnel through the single token gate (server.rs:887-903 and call sites :1012–7620; hls/manifest.rs:430-434; faststart.rs:492,575).
- Both servers bind 127.0.0.1 (server.rs:7855; lib.rs:112); REST server off-by-default (lib.rs:75); CORS origin allowlists (lib.rs:100-103; server.rs:7798-7802); stream token = 16 random bytes hex per launch, constant-time compared (lib.rs:43-47,220; server.rs:896).
- Peer cache is memory-only; stream-cache `.meta.json` fields enumerated (stream_cache.rs:229-247,516); sprite pipeline carries no titles; no log lines print channel/folder titles; no tauri-plugin-log file sink configured; no dynamic window/document titles.
- Store plugin persists full named folder objects (types.ts:11-15; useTelegramConnection.ts:25-43,279-285); SQLite schema stores channel names/usernames (public_channels.rs:16-27).
- PBKDF2 timings measured on THIS machine (23.9 ms @100k, 143.9 ms @600k, ratio 6.03×); all brute-force figures derive from those measurements.
- `constant_time_eq = "0.3"` already a dependency and is the established compare idiom (Cargo.toml:53; api_settings.rs:88-91).
- Startup restore → file-pane data flow traced end-to-end (useTelegramConnection.ts:38 → Dashboard.tsx:157-158,166,773).

**Assumed:**
- Python/OpenSSL PBKDF2 ≈ the Rust implementation's speed (within ~1.5×); conclusions are insensitive to that factor.
- GPU-cracking context (hashcat-class rigs ~10–100× a CPU core) quoted as standard estimates, not benchmarked here — strengthens, doesn't weaken, the analysis.
- Threat-model interpretation taken from the spec's own D2/"user-confirmed" stance; severity ratings are calibrated against that stance, not against a hard-security bar.
- That the intended vault behavior for HTTP servers is out of scope (hence documentation-level Required fix); if the team disagrees, Finding 1's optional enforcement becomes the Required fix instead.

