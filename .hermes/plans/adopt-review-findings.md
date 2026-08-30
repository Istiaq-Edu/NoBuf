# Fresh-Eyes Review Findings — feat/adopt-owned-channels (29b2c64, 250852e, 2add3f3)

> **FIXED in 531cdef** — all P0/P1/P2/P3 actionable findings fixed; F6 risk-accepted, F21/F22 latent. Gates: cargo 445/445 (2 new tests), tsc clean, vitest 1191/1191.

All findings PARENT-VERIFIED from source unless noted. Sources: my fresh-eyes pass (F1-F6),
3 parallel subagent reviewers (Rust, Frontend, Telegram-API), cross-validated.

## P0 — ship-blockers

### F7. DEADLOCK in cmd_scan_folders for every user with zero adoption records
fs.rs:2044-2076. `drop(peer_cache)` sits INSIDE `if !adopted_records.is_empty()`.
With an empty adoptions table (every user until first adoption; also when load errors
via unwrap_or_default), the write guard is alive at `state.peer_cache.read().await.len()`
(fs.rs:2076) — same tokio RwLock, same task → read blocks forever.
Subagent REPRODUCED it with a standalone tokio program (read() blocked >2s).
Impact: startup auto-sync hangs, `isSyncing` stuck, and every other peer_cache reader
(streaming, previews, resolve_peer fast path) deadlocks app-wide.
Note the trap: testers WITH adoptions take the drop() path and never see it.
Fix: drop unconditionally before the merge block (or capture len into a local first).
VERIFIED (source + executable repro).

## P1 — feature-breaking

### F1. cmd_rename_folder NEVER treats folders as adopted — [NB] appended to adopted titles
fs.rs:66-89: both match arms hardcode `is_adopted: false`; function has no AppHandle —
cannot check adoption records. Renaming an adopted folder runs the [NB]-append branch.
Violates decision #5, QA row 3. Fix: add AppHandle, load records, set flag. VERIFIED.

### F8. Transient Telegram errors permanently delete valid adoption records
adopted_folders.rs:112 — `Err(_) => None` collapses FLOOD_WAIT/network blips into None;
scan merge (fs.rs:2066-71) treats None as dead channel and deletes the row. One FLOOD_WAIT
during scan destroys the adoption AND propagates the loss via next NB-PUB upload.
Plan calls for auto-unadopt on lost rights/CHANNEL_PRIVATE only. Fix: match InvokeError —
auto-unadopt only on channel-gone errors (CHANNEL_PRIVATE, CHANNEL_ID_INVALID); transient
errors → keep record, skip this scan. VERIFIED.

### F2. Delete-channel-permanently invoked with access_hash = 0
Sidebar.tsx wiring passes 0; TelegramFolder carries no hash. cmd_delete_channel_permanently
uses the parameter → API rejection. Fix backend-side: look up the adoption record by
channel_id and prefer the STORED hash. VERIFIED.

### F9 (frontend-N1). Unadopting the ACTIVE folder leaves a fully functional ghost view
useTelegramConnection.ts:390-394 resets activeFolderId but activeView lives in Dashboard —
its sync effect (Dashboard.tsx:258-266) immediately snaps activeFolderId BACK to the removed
folder's id and re-persists it. Worse: cmd_unadopt_channel never cleans the peer cache
(adopted_folders.rs:273-280, no State param) → ghost view keeps listing AND uploading.
Fix: handlers wrap in Dashboard to navigate to 'saved' when removing the active folder
(handleRemovePublicChannel at Dashboard.tsx:817-819 shows the pattern); backend drops the
cache entry on unadopt. VERIFIED.

### F3. Adopted channel with [NB] in title → duplicate found_folders entry
fs.rs:2023-2030 pushes as regular folder (is_adopted:false), fs.rs:2055 pushes again
(is_adopted:true); applySyncResult keeps the FIRST → menu gating lost.
Fix: in the merge, skip records whose fetched title contains "[nb]" (they're regular
folders via title scan). VERIFIED. ALSO: sync reconcile re-creates the row cross-device
(public_channels.rs:1239-1255 has no [NB]-title exclusion) — same fix needed there
(sync-N5). VERIFIED.

### F10 (both-sides N1). Unadopt never propagates across devices
public_channels.rs:1232-1265 — adopted reconcile only UPSERTS, no delete loop (channels
block at :1223-1230 has one). Unadopt on A → B keeps the folder forever. Comment claims
"same last-writer-wins semantics" — false. Also the `!remote_adopted.is_empty()` guard
must move for the fix (empty remote list = legit unadopted-everything case).
Fix: mirror the delete loop; run it unconditionally. Contradicts plan decision 11 + QA 13. VERIFIED.

## P2 — should fix

### F4. cmd_adopt_channel double-fetches the channel (adopted_folders.rs:217+223)
Redundant network round-trip. Fix: single fetch. VERIFIED.

### F11. seed_peer_cache hardcodes broadcast=true (adopted_folders.rs:265, fs.rs:2058)
Adopted megagroups seeded as Peer::Channel(broadcast=true) instead of Peer::Group.
Wire format verified benign (PeerRef→InputPeerChannel carries only id+hash) — sends work.
Residual: rename's Peer::Group arm (fs.rs:74) is dead for seeded megagroups; cached flags lie.
Fix: fetch_channel_fresh returns broadcast; thread it through. VERIFIED (benign today).

### F12. Adoption merge overwrites richer dialog-derived cache entries → Copy Link broken
fs.rs:2058 seed (username:None) clobbers fs.rs:2019's full dialog peer →
cmd_get_channel_username returns None → no Copy Link for adopted channel with @username.
Fix: seed only when absent, or carry username from fetch. VERIFIED.

### F13. Reconcile inserts into a table its connection never creates (latent)
public_channels.rs:1247 — INSERT INTO adopted_folders on conn from get_connection()
(creates only public_channels/nb_pub_settings). Fresh profile → prepare fails → command
errors AFTER channels reconcile, BEFORE set_setting(nb_pub_message_id) → re-download.
Fix: use adopted_get_connection for the adopted block. VERIFIED.

### F14 (frontend-N2). Adopted channel re-addable as public channel → duplicate sidebar entry
cmd_list_joined_channels checks only public_channels + [NB] title; adopted channels have
neither → show as "+ Add" in Browse; modal's handleAdopt never updates joinedChannels →
same session reproducible. Fix: mark adopted ids as is_nb_folder (or refuse in
cmd_add_joined_channel). VERIFIED.

### F15 (frontend-N3). Startup re-scan runs unconditionally — 2× full dialog walk per launch
useTelegramConnection.ts:93-101. FLOOD_WAIT exposure the plan said to avoid. Fix: diff
cmd_get_adopted_folders (registered, currently unused — dead code otherwise) before/after
sync; rescan only when the set grew. VERIFIED.

### F16. Old build running cmd_update_nb_pub_sync silently wipes remote adopted array
Old builds serialize plain array, overwrite the wrapper message. Bounded: new builds'
legacy arm yields adopted=empty and the empty-guard means no local deletions; next new-build
mutation re-uploads the wrapper. Loss window: fresh installs during mixed-fleet period.
Fix: in the legacy-parse arm, if local adopted non-empty → log + fire re-upload. VERIFIED.

### F17 (minor, from Rust reviewer). cmd_adopt_channel early-return skips peer-cache seeding
adopted_folders.rs:254-257: failed prepare on the best-effort public_channels DELETE returns
early, skipping seed_peer_cache → archived channel unresolvable until next scan.
Fix: don't early-return; skip the delete. VERIFIED.

## P3 — polish / latent

- F5: rename peer-cache update skips Peer::Group (fs.rs:110) — stale cached title. VERIFIED.
- F6: archive pagination offset_date=0 — may repeat/skip pages; seen-guard dedupes. RISK-ACCEPTED.
- F18 (sync-N7): evaluate_for_adoption returns username:None → modal shows no @username
  for owned channels. Fix: thread username from channel_info_from_chat. VERIFIED.
- F19 (frontend-N4): rescan uses stale closure (`folders`) → duplicate sync toast +
  rescan removals not vault-pruned. Fix: diff against result.current. VERIFIED.
- F20 (frontend-N5): failed owned-scan silently hides "Your Channels" section (console.warn
  only). Fix: error/empty state. VERIFIED.
- F21 (frontend-N6, latent): SidebarItem optional-prop pairing unguarded — isAdopted without
  handlers = no removal affordance. Current wiring safe. Latent.
- F22 (frontend-N7): side effect inside setFolders updater (store.set in updater) — StrictMode
  double-write harmless; unawaited chain may reject unhandled. Pre-existing pattern.
- F23 (rust-minor): cmd_delete_folder adopted guard fails OPEN on DB error. VERIFIED.
- F24 (sync-N6, falsified premise): cross-device access_hash IS valid (same account) —
  NB-PUB is same-account multi-device. No bug; degraded cases skip+log correctly. VERIFIED-OK.
- F25 (sync-N8): is_admin_post creator semantics — VERIFIED CORRECT per grammers synthetic rights.

## Fix order (planned)
1. F7 (deadlock — one line) + F23 (fail-closed guard) + F17 (early-return) — scan/adopt safety
2. F1 (rename adopted) + F8 (error classification) + F2 (stored-hash delete) + F11/F12 (seed correctness)
3. F3 (double-push, BOTH sites) + F10 (sync delete loop) + F13 (table-create conn) + F16 (legacy re-assert)
4. F9 (ghost view) + F14 (re-add dup) + F15 (conditional rescan) + F4 (double fetch)
5. F5, F18, F19, F20 polish; F6, F21, F22 risk-accepted/latent
