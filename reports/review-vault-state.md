# State-Consistency Review — Vault Design Spec (`docs/specs/2026-08-22-vault-design.md`)

**Reviewer:** state-consistency subagent (adversarial, fresh eyes; did not author spec)
**Date:** 2026-08-22 · Branch `feature/vault-hide-channels`
**Method:** every claim traced to live code (`rg` / direct reads). Severity: BLOCKER / MAJOR / MINOR / OK.

---

## Q1. RECONCILIATION RACE — who prunes dead vaulted IDs?

**Severity: MAJOR** — spec names the behavior but not the owner; the two candidate owners have asymmetric failure modes and only one is correct.

**Verified facts**

- `cmd_start_auto_sync` is a thin wrapper over `cmd_scan_folders`: `app/src-tauri/src/commands/fs.rs:102-107`. Diff computed against the `local_folders` array *the frontend passes* (`fs.rs:1604-1607`, param consumed at `1653`); `removed` = local IDs absent from the live `[NB]` scan (`fs.rs:1675-1680`). Backend never sees vault IDs — confirmed: zero references to any vault concept in fs.rs.
- Auto-sync runs **once**, guarded by `autoSyncDone.current` ref: `useTelegramConnection.ts:19,51-52`; manual resync via `cmd_scan_folders` at `useTelegramConnection.ts:176-188`.
- Current ScanResult consumption is entirely frontend-side: `applySyncResult` filters `updated` by `result.removed`, persists to store, redirects active folder — `useTelegramConnection.ts:82-123`.

**Analysis — where pruning belongs: FRONTEND, immediately after each ScanResult.**

The spec's own filtering rule (§4.2) makes this deterministic: `applySyncResult` already computes the new full folder array (`useTelegramConnection.ts:102`); pruning is one extra line — intersect `removed` with `hiddenFolderIds` and call `vaultContext.prune('folder', ids)` before the store write. Same shape for public channels after `cmd_sync_public_channels` returns the reconciled list (`public_channels.rs:862, 1019-1031`) — diff returned list vs `hiddenPublicIds`.

Why NOT backend-reads-vault.json-at-sync-time:

1. Backend can compute `dead ∩ vaulted` but **cannot safely delete**: `vault_unhide` requires unlocked (§4.1), so backend auto-prune would either bypass the lock model (inconsistent semantics) or need a special unauthenticated mutation — which contradicts the locked-state guarantee that IDs are never exposed/mutated without unlock except reset.
2. It splits truth across processes mid-flight: scan returns → frontend applies to store → backend separately mutates vault.json. Two unsynchronized writers on the same logical event; a crash between them yields a vaulted ID that no longer exists anywhere (exactly the state reconciliation was meant to prevent).
3. Testability: spec's Vitest plan (§6) tests frontend filtering; backend-prune adds an untested Rust↔JSON coupling.

What breaks with the other choice: if pruning is left to "next manual sync" only (no auto hook), the D15 count badge shows dead entries until the user manually syncs; if backend does it inside `cmd_scan_folders`, the command's contract (`ScanResult` describes *folders*, knows nothing of vault) gets polluted and every caller inherits vault logic.

**Spec gaps found:** (a) edge-case row (§4.3:102) says "startup reconciliation prunes" but §4 commands list has no `prune` command — add `vault_prune(kind, ids)` (unauthenticated, idempotent, intersection-only so it can never ADD anything); (b) nothing covers public-channel pruning at all — `cmd_sync_public_channels` reconciles SQLite (`DELETE FROM public_channels ... WHERE channel_id NOT IN remote`, `public_channels.rs:1012-1021`) and nobody tells the vault; (c) silent pruning while locked changes the D15 badge count without explanation — acceptable, but say so.

---

## Q2. DUAL PERSISTENCE DESYNC — store `folders` array vs vault.json

**Severity: MINOR** (rule as stated is sufficient; failure window exists but self-heals)

**Complete writer inventory of store key `'folders'`** (all in `useTelegramConnection.ts`; repo-wide `rg` finds no other writer):

| # | Writer | Line | Passes FULL array? | Covered by spec rule? |
|---|---|---|---|---|
| 1 | `applySyncResult` (auto-sync) | :106 | yes — post-add/update/remove `updated` | ⚠️ rule text names only "reorder"; sync is a distinct writer |
| 2 | `handleCreateFolder` | :196-197 | yes — `[...folders, newFolder]` | same caveat |
| 3 | `handleFolderRename` | :214 | yes — `prev.map(...)` | same |
| 4 | `handleFolderDelete` success path | :237-238 | yes — filtered copy | same |
| 5 | `handleFolderDelete` not-found fallback | :261-262 | yes | same |
| 6 | `handleFolderReorder` | :282-283 | yes — exact argument | ✅ explicitly named |
| 7 | logout cleanup | :146,165 | deletes key entirely | n/a |

So the spec's load-bearing rule (§4.2:90 raw arrays used for reorder persistence; §4.3:105 "reorder receives FULL unfiltered array") is **necessary but not sufficient as written**: writers 1–5 equally need the raw array, and they get it *automatically* only because the filtering memo lives at the Dashboard/Sidebar prop boundary, not inside the hook. The spec should extend the rule: "**every** `store.set('folders', …)` call site receives the raw unfiltered array" — otherwise an implementer who filters inside `applySyncResult`'s `updated` (a plausible misreading of "hidden items disappear everywhere") silently drops vaulted folders from disk on every sync.

**Partial-state analysis (hide succeeds, concurrent store save fails):**
Realistic sequence: user hides folder X → `vault_hide` commits to vault.json → user drags another folder → `handleFolderReorder` persists the raw array *including X* (correct). Failure mode requires the store save itself to fail (`await store.set/save` rejects, :282-284) — then memory has X reordered+present-but-hidden-flagged, disk has stale order. Consequences: (a) visibility stays correct because vault.json is authoritative for hiding; (b) order loss only; (c) next successful save heals. No leak path: hiding never depends on the folders key. Inverse failure (`vault_hide` fails after UI optimistically filters) IS a leak-class bug — spec must mandate: filter memo derives ONLY from committed vault.json state (post-await), never from optimistic intent. Not currently stated. Also note pre-existing races out of scope but adjacent: `handleCreateFolder` reads closure `folders` (:194) and `applySyncResult` fire-and-forgets its save (:106) — vault code must not copy those patterns for vault.json writes.

---

## Q3. ACCOUNT SWITCH — does vault.json surviving logout stay consistent?

**Severity: MAJOR** — the survival premise checks out, but the spec's mitigation does **not** hold for public channels as written.

**Verified facts**

- Tauri store **survives logout partially**: `forceLogout` (:139-154) and `handleLogout` (:156-173) delete only `api_id`, `api_hash`, `folders`. `activeFolderId` key survives; `config.json` file survives.
- SQLite public channels table **survives logout entirely**: `nobuf_groups.db` lives in `app_data_dir()` (`public_channels.rs:12-16`); neither `cmd_logout` (`auth.rs:201-256` — clears state, peer cache, session files only) nor `cmd_clean_cache` (`preview.rs:162-190` — previews/thumbnails/stream cache only) touches it.
- Therefore **vault.json surviving is consistent with existing behavior** — spec's implicit premise verified. But the consequence stands: a second Telegram account inherits the first account's hidden-ID lists (and passcode!).
- `is_member` refresh path is **weak**: column exists (`public_channels.rs:28`), is read at :515-523 and :815, but **every write in the codebase hardcodes `is_member=1`** (:327, :462, :1002) — nothing ever sets it to 0. The remote reconcile in `cmd_sync_public_channels` DELETEs non-remote rows outright (:1012-1021) rather than flagging `is_member=0`, and it only runs against the single `[NB-PUB]` sync document (called once at startup, `useTelegramConnection.ts:61`).

**Does "never render, prune on next sync" hold?**

- Private folders: **holds.** Prune-on-sync works (Q1) because `ScanResult.removed` reflects the live account's dialogs. Stale IDs are invisible (not in `folders`) and get pruned. ✔️
- Public channels: **partially broken.** (a) If account B simply hasn't joined those channels, they're still rows in B's local DB (survived logout) → they RENDER normally in B's sidebar, vaulted or not — "never render" is false unless the vault ALSO filters them out of `visiblePublicChannels` (it does per §4.2 memo — so they're invisible AND unpruned, i.e. zombie hidden entries counting toward the badge forever). (b) The prune signal only fires if B runs a `[NB-PUB]` sync whose remote JSON lacks those IDs — plausible but slow and conditional. (c) Worse inversion: if account A vaulted channels that ARE in B's `[NB-PUB]` sync doc, B permanently cannot see or unhide them without unlocking A's passcode — which B doesn't know. D8 Reset is the only escape, and it destroys A's passcode for when A returns. Spec must decide: **clear both vault ID lists on logout** (matches the `folders` precedent at :146 — recommended), or accept cross-account inheritance and document D8 as the recovery. Silent inheritance is the worst option and is what the current text implies.

---

## Q4. UNLOCKED FLAG SEMANTICS — who owns truth?

**Severity: MINOR** (real reload paths exist; outcome is safe today, but the spec leaves ownership ambiguous)

**Reload-without-process-exit paths checked:**

- Dev HMR / Vite full reload (`devUrl http://localhost:1420`, `tauri.conf.json:24`): frontend remounts, Rust process persists → backend `unlocked:true` survives, frontend context resets to locked. Real divergence window.
- WebView2 Ctrl+R / `location.reload()` in debug: same divergence. Production window URL is a localhost plugin port (`lib.rs:409-414`) — reload reachable in dev builds only, but the spec's D4 wording "on app reopen" doesn't cover it.
- Multiwindow: only `main` is built at setup (`lib.rs:415`); the second builder is the external `telegram_auth` helper window (`auth.rs:838,1020`) — no second instance of the React app. Risk theoretical today.

**Why it still resolves safely:** the spec's VaultContext "Loads state once at mount" (§4.2:89) — i.e. calls `cmd_vault_get_state` on mount — so after ANY frontend reload the context re-derives `isUnlocked` from the backend. The failure would require the context to seed from localStorage/persisted state; it must not (worth one explicit sentence). Residual quirk: a hot-reload mid-unlocked-session flips UI to locked while backend stays unlocked — cosmetic, self-corrects on unlock.

**Single source of truth must be: the BACKEND `unlocked` flag.** Frontend `VaultContext.isUnlocked` is a *cache* hydrated from `cmd_vault_get_state` at mount and updated only via command round-trips (`vault_verify/vault_lock/vault_reset` return the new state). Rules to write into the spec: (1) frontend never derives lock state locally (e.g. never infers "hasPasscode===false ⇒ unlocked"); (2) every mutating command response includes fresh `{has_passcode, is_unlocked}` so context and backend can't drift; (3) counts/IDs always come from backend responses, never recomputed frontend-side from cached arrays.

---

## Q5. REACT QUERY CACHE LEAKS after hiding

**Severity: MAJOR** — two concrete serving-stale-content windows plus one startup leak; spec's test plan has no cache-invalidation coverage.

**Verified mechanics**

- Files query: `queryKey: ['files', activeFolderId]`, `Dashboard.tsx:157-163`, enabled when `!!store && !isPublicView`. Default `gcTime` (5 min) applies — module-level client (`App.tsx:19`) means caches survive Dashboard unmount (logout→login) too.
- Hiding the *currently open* folder X: D14 jumps to Saved → `activeFolderId=null` → different key → X's entry goes cold but **stays resident ~5 min**. Leak exposure paths within that window: Move modal targets (`MoveToFolderModal` receives `folders` prop, `Dashboard.tsx:856`), Enter-key navigation into X (`Dashboard.tsx:278`), or any residual reference. Low probability, nonzero; and `['files', X]` will be served instantly from cache with **zero network refetch** if the user re-opens X via picker within gcTime.
- Public channel files: `['publicChannelFiles', channelId, 0]` with explicit `staleTime: 60_000, gcTime: 5min` (`usePublicChannels.ts:83,104-106`). Hide channel X while viewing it → D14 jump → if user navigates BACK to X through any non-filtered surface (picker, notification), cached files render for up to 60s **without any fetch**, and for 5 min without refetch.
- **Does opening the vault view re-fetch? NO.** Vault view renders hidden items as a listing (names/counts); if it offers "open channel/folder normally" (D12 does), opening routes back through `activeFolderId`/`activeView` keys → cache-hit, no invalidation anywhere in the flow. Spec §6 tests mention none of: `queryClient.removeQueries({queryKey:['files',X]})` on hide, invalidation on unhide, or vault-view mount refetch.

**Related startup leak (found during trace):** `initStore` restores `activeFolderId` from disk before first paint of data (`useTelegramConnection.ts:37-38`) → `['files', savedId]` fetches immediately → if the restored folder is vaulted, its contents are rendered until VaultContext finishes loading and the filter memo applies (async gap). Fix belongs in the spec's implementation notes: gate initial folder restoration on vault state loaded (or force `activeFolderId=null` when saved id ∈ hidden list at restore time).

**Required additions:** invalidate/remove `['files', id]` and `['publicChannelFiles', id, 0]` in the hide flow; refetch (or `removeQueries`) on unhide; add both to §6 test plan.

---

## Q6. HIDE-VIEWING-CHANNEL (D14) — stale state after jumping to Saved

**Severity: OK** (core flow sound) + **MINOR** residue items.

**Trace:** `handleSelectFolder` (`Dashboard.tsx:61-67`) is the atomic wrapper; the sync effect (`Dashboard.tsx:69-78`) forces `activeFolderId=null` whenever `activeView.type==='saved'`. So the D14 jump (`setActiveView({type:'saved'})`) cascades correctly even if implemented as the bare `setActiveView` call — the effect repairs `activeFolderId` on the next commit. Note the effect ordering hazard: setting `activeView='saved'` triggers BOTH the effect (null) and any direct `setActiveFolderId(X)` would fight — implementers must route D14 through the same pattern as `handleRemovePublicChannel`, which already does exactly this jump (`Dashboard.tsx:520-522`) and works.

- **TopBar name:** derived, not stored — `currentFolderName` recomputes each render (`Dashboard.tsx:525-529`); after the jump `activeView.type==='public'` is false and `activeFolderId===null` → "Saved Messages". No staleness. For a hidden *folder* (not channel): `folders.find(...)?.name || "Folder"` — folder still exists in raw array, name renders fine during the one-frame transition; after jump it's moot.
- **Query keys:** keyed off `activeFolderId` → become `['files', null]` (Saved). The hidden id's key simply stops being active (see Q5 for residency). No key retains the hidden id.
- MINOR residues the spec should sweep in the D14 handler: (1) `selectedIds` may reference files of the hidden channel — bulk ops then target invisible rows (`selectedIds` cleared on Escape only, `Dashboard.tsx:254-260`); (2) `searchTerm`/`searchResults` persist across the jump (harmless but inconsistent with Escape behavior); (3) `previewFile/playingFile/pdfFile` modals showing content FROM the hidden channel stay open unless the D14 handler closes them — spec's "jump + toast" doesn't mention modal dismissal; add it.

---

## Cross-checks of the spec's §2 fact table (all verified)

- `models.rs:39-53` ScanResult ✔ (struct :43-53) · `fs.rs:101-107` ✔ (wrapper :102-107) · `useTelegramConnection.ts:279-285` reorder ✔ (exact) · `types.ts:96-99` ActiveView ✔ · `public_channels.rs:12-13` db_path ✔ (:12-16) · `api_settings.rs` ConfigLock ✔ (:8) · settings-toggle pattern ✔ (`SettingsPage.tsx:583-587`).

## Verdict: **Request changes**

Blocking-ish items (must land in spec before implementation):
1. Q1: name the prune owner — frontend, after every ScanResult/public-sync result, via an idempotent intersection-only `vault_prune` (works while locked); cover public channels explicitly.
2. Q3: decide account-switch story — recommend clearing vault ID lists (+ deciding passcode fate) on logout to match the existing `folders` deletion precedent; document D8 as the only alternative.
3. Q5: mandate cache invalidation on hide/unhide + fix the startup `activeFolderId` restore leak; add cache tests to §6.
4. Q2: generalize the "FULL unfiltered array" rule to ALL `store.set('folders')` writers; state the no-optimistic-filter rule.
5. Q4: declare backend flag the single source of truth; VaultContext is a hydration cache; forbid localStorage-derived lock state.

## What I verified vs assumed

**Verified (file:line):** ScanResult shape & diff math; auto-sync once-per-launch guard; all seven `folders` writers; logout deleting exactly {api_id, api_hash, folders}; cmd_logout/cmd_clean_cache scope (session files, caches — not nobuf_groups.db, not config.json); `is_member` never written to 0 anywhere; public-channel reconcile DELETEs rather than flags; react-query keys/staleTime/gcTime for both file queries; module-scope QueryClient; handleSelectFolder/sync-effect interplay and the existing remove-channel jump precedent; currentFolderName derivation; single-main-window setup; dev/prod window URLs.

**Assumed (flagged for author):** store-plugin `save()` failures are rare-but-possible (no retry logic exists — treated as best-effort); Ctrl+R reload unreachable for end users in release builds (window chrome has no reload affordance; relied on Tauri defaults); VaultContext will hydrate from backend at mount per §4.2 wording (safe only if it never seeds from persisted storage — spec should say so); PBKDF2 iteration count and constant-time compare details taken from spec text, not audited (out of scope for state consistency).
