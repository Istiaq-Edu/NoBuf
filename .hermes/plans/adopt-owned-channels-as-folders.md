# Adopt Owned/Administered Channels as NoBuf Folders

Status: PLANNED — all 14 decisions user-confirmed 2026-08-30
Upstream: feature request "private channel with ownerships" (chat)

## Goal

Let the user adopt a Telegram channel they created or administer (post_messages)
as a full NoBuf folder — upload/download/move, Folders sidebar section — without
the [NB] tag being appended to the channel's real title. The original title is
the single truth: renames flow both ways between Telegram and NoBuf.

## Confirmed decisions (interview, 4 rounds)

| # | Decision |
|---|---|
| 1 | Full folder semantics, same as [NB] folders |
| 2 | Explicit adoption only; scan never auto-imports |
| 3 | Eligibility = `creator == true` OR admin with `post_messages` |
| 4 | Broadcast channels + megagroups (owned/administered) adoptable; basic groups excluded |
| 5 | Original title kept, no [NB] appended; single-truth rename both directions |
| 6 | Owned channels already tagged [NB] = regular [NB] folders, never duplicated |
| 6b | [NB-PUB] itself never adoptable |
| 7 | "Remove from NoBuf" = unadopt only; "Delete channel permanently" = separate stronger danger dialog |
| 8 | Lost rights → next scan auto-removes folder, sync summary reports it |
| 8b | Stale access_hash / deleted channel (CHANNEL_PRIVATE on resolve) → auto-unadopt |
| 9 | Adopting a channel that's also a Public Channel removes it from Public Channels |
| 10 | SQLite is source of truth for adoption records; frontend merges scan + adoptions |
| 11 | NB-PUB sync JSON gains `adopted` array {channel_id, access_hash, title}; ownership re-verified per device on receipt |
| 12 | Adoption UI lives in AddChannelModal joined-channels list; archived channels included via archive-folder scan |
| 13 | Ownership flags visible in modal only; sidebar clean |
| 14 | Adopt/unadopt triggers cmd_update_nb_pub_sync, like public-channel mutations |

## Verified code facts (file:line, checked this session — incl. 3-subagent cross-validation)

- `cmd_scan_folders` matches `[NB]` in title case-insens., excludes `[NB-PUB]`,
  REMOVES local folders lacking the tag — fs.rs:1982-1990, 2026-2032
- `cmd_rename_folder` re-appends ` [NB]` when missing — fs.rs:74-78; uses
  `channels::EditTitle` via peer resolution; mock mode returns early (fs.rs:51-58)
- `cmd_delete_folder` deletes the real channel (`channels::DeleteChannel`) — fs.rs:206-208;
  REJECTS non-Channel peers ("Only channels (folders) can be deleted") — fs.rs:203
- Public channels: SQLite table public_channels, `is_private` = `username.is_none()` — public_channels.rs:21-29, 568
- `is_nb_folder` = title contains `[nb]` (case-insens) — public_channels.rs:458
- `cmd_list_joined_channels` iterates dialogs (main list only), skips non-broadcast — public_channels.rs:452-456
- `resolve_peer` fallback = dialog scan (folder_id: None → main list, no archive) — utils.rs:18-59;
  upload (fs.rs:765), download (fs.rs:1271), move (fs.rs:1801-1802) all route through it
- `iter_dialogs()` hardcodes `folder_id: None` — grammers-client/src/client/dialogs.rs:26
- **MEGAGROUP ROUTING: `Peer::from_raw` sends `Chat::Channel{broadcast:false}` to
  `Peer::Group`, broadcast channels to `Peer::Channel`** — grammers peer/mod.rs:43-59.
  Consequence: every `if let Peer::Channel` site is megagroup-blind; adopted megagroups
  resolve as Peer::Group at upload/download time (send works — Peer-generic), and the
  adopt-eligible scan must ALSO match `Peer::Group`.
- `Channel::admin_rights()` helper: creator + `admin_rights: None` → synthetic FULL
  rights incl. `post_messages: true` — grammers peer/channel.rs:177-200.
  Eligibility predicate simplifies to: `admin_rights().map(|r| r.post_messages) == Some(true)`
- `Channel.creator: bool` (generated_types.rs:3722), `admin_rights: Option<ChatAdminRights>`
  (generated_types.rs:3757), `ChatAdminRights.post_messages` (generated_types.rs:7541)
- `channels::EditTitle { channel, title }` works for channels AND megagroups —
  generated_functions.rs:5500 + core.telegram.org/method/channels.editTitle
- `channels::DeleteChannel` works for both too — generated_functions.rs:5256
- `GetDialogs.folder_id: Option<i32>` exists → archive scan = invoke with folder_id=1 — generated_functions.rs:10315
- `channels::GetChannels { id: Vec<InputChannel> }` returns `messages::Chats` (Chats/Slice,
  both with `.chats`) — generated_functions.rs:5649-5663; repo precedent resolve_channel_by_hash public_channels.rs:493-505
- Min-channel objects appear in message contexts, NOT in dialog/GetChannels results —
  official api/min docs; our paths all use full objects
- NB-PUB upload path: serialize PublicChannel vec → temp file → upload_file → send_message — public_channels.rs:972-1008
- NB-PUB download/reconcile: parse JSON → insert missing → delete non-remote — public_channels.rs:1155-1199
- Frontend: folders live in tauri-plugin-store `{id, name, parent_id}` as useState (NOT
  react-query) — useTelegramConnection.ts:232-245; scan applies via applySyncResult :120-161
- **Folder context menu is INLINE in SidebarItem.tsx:302-396** (ContextMenu.tsx is the
  file-grid menu taking TelegramFile); TelegramFolder has NO adoption flag today
- AddChannelModal `browseFetched` latch never resets on close — AddChannelModal.tsx:23, 36-39, 131-136
- Modal refresh path `onAdded → onPublicChannelsChanged` invalidates ONLY
  ['publicChannels'] (Dashboard.tsx:1075, PublicChannelSidebarSection.tsx:95) —
  folders state is in a different tree (useTelegramConnection)
- Sync triggers: usePublicChannels.ts:25,41,57 call cmd_update_nb_pub_sync after mutations
- Auto-sync startup: cmd_start_auto_sync → applySyncResult → showSyncSummary — useTelegramConnection.ts:51-110
- SQLite: no busy_timeout/WAL pragma anywhere in src-tauri (pre-existing; short-lived
  connections per command) — folder_groups.rs:31-37, public_channels.rs:18-35
- `cmd_start_auto_sync` = `cmd_scan_folders` verbatim, NO AppHandle param — fs.rs:103-108;
  `get_connection` is PRIVATE in both public_channels.rs and folder_groups.rs → scan merge
  needs AppHandle added (Tauri auto-injects, no frontend change) + shared/moved helper
- **Startup ordering: auto-sync scan (useTelegramConnection.ts:58) runs BEFORE
  cmd_sync_public_channels (ts:72)** — adoptions pulled from NB-PUB land in SQLite
  AFTER the scan already ran → invisible until next launch/manual sync without a fix
- `cmd_rename_folder` matches ONLY `Peer::Channel` — fs.rs:64-72 ("Only channels
  (folders) can be renamed") — adopted megagroups (Peer::Group) cannot be renamed
  without extending that match; same for cmd_delete_folder fs.rs:195-204
- GetChannels may return a MIN channel with stripped access_hash (documented in-repo
  at public_channels.rs:503-505) — peer-cache seeding must trust the STORED hash,
  constructing the raw Channel manually when the fetched one is stripped
- `admin_rights` is an ENUM wrapper: `ChatAdminRights::Rights(struct)` —
  generated_enums.rs:2812-2814; unwrap pattern required
- Archive scan (GetDialogs folder_id=Some(1)): raw invoke returns 3-variant
  `messages::Dialogs` enum (Dialogs/Slice/NotModified); `Dialog` itself is
  Dialog::Dialog | Dialog::Folder; pagination REQUIRED (100-dialog cap — loop on
  offset_date/offset_id/offset_peer exactly as DialogIter::next does, dialogs.rs:106-119);
  grammers `iter_dialogs()` unusable (request field is pub(crate), iter_buffer.rs:23)
- EditTitle requires `change_info` admin right, NOT post_messages — official method
  docs; DeleteChannel fails CHANNEL_TOO_LARGE for channels >1000 members
- `admin_rights`/`creator` are computed per-requester server-side (official channel
  constructor docs) — post-transfer re-fetch shows creator:false (auto-unadopt sound);
  transferred-away owner who keeps admin+post_messages REMAINS ELIGIBLE (decision #3, by design)
- `ScanResult.removed` is `Vec<i64>` (models.rs:50, types.ts:20) and `showSyncSummary`
  counts only (ts:164-170) — removal REASONS cannot travel the existing shape
- AddChannelModal has its OWN `uploadSync` copy (AddChannelModal.tsx:28-33) — it does
  NOT use usePublicChannels (documented split in PublicChannelSyncUpload.test.ts);
  SidebarItem hover-X delete button (:290-294) also routes to onDelete → cmd_delete_folder

## Design

### Schema (SQLite nobuf_groups.db)

```sql
CREATE TABLE IF NOT EXISTS adopted_folders (
    channel_id   INTEGER PRIMARY KEY,
    access_hash  INTEGER NOT NULL,
    title        TEXT NOT NULL,
    adopted_at   INTEGER NOT NULL
);
```

ALTER path for existing DBs: none needed — new table, not new columns. Safe on
existing installs (CREATE TABLE IF NOT EXISTS).

### Data model changes

models.rs:
- `AdoptedFolder { channel_id, access_hash, title, adopted_at }` (Serialize, Deserialize, Clone, Debug)
- `JoinedChannel` gains `is_creator: bool`, `is_admin_post: bool` (back-compat: TS side optional)
- `FolderMetadata` / TS `TelegramFolder` gain `is_adopted: bool` (default false, serde default) —
  REQUIRED so the sidebar context menu (SidebarItem.tsx inline menu) can gate
  Unadopt vs Delete without a second lookup
- NB-PUB sync payload wrapper struct `NbPubSync { channels: Vec<PublicChannel>, adopted: Vec<AdoptedFolder> }`
  with legacy fallback: parse `Vec<PublicChannel>` when array (old builds' data)

### Backend commands (new)

1. `cmd_adopt_channel(channel_id, access_hash)` — insert adoption record
   (after re-verifying rights via GetChannels), auto-remove from public_channels
   if present, trigger NB-PUB upload in caller (frontend).
2. `cmd_unadopt_channel(channel_id)` — delete adoption record; channel untouched.
3. `cmd_get_adopted_folders()` — list records.
4. `cmd_list_owned_channels()` — adopt-eligible list: main dialog scan +
   archive-folder scan (GetDialogs folder_id=1) + for each channel (broadcast OR
   megagroup — match `Peer::Channel` AND `Peer::Group` since grammers routes
   megagroups to Group): eligibility = `admin_rights().map(|r| r.post_messages) == Some(true)`
   (covers creators via synthetic rights); returns JoinedChannel + flags; excludes
   [NB]-tagged (regular folders), [NB-PUB], already-adopted.
   NOTE: raw `client.invoke(GetDialogs{folder_id:Some(1)})` returns
   `tl::enums::messages::Dialogs` — parse dialogs + chats ourselves (no grammers
   iterator for folders).
5. `cmd_delete_channel_permanently(channel_id, access_hash)` — real
   channels::DeleteChannel; for adopted only; frontend gates behind danger dialog.

### Backend changes (existing)

- `cmd_scan_folders` (fs.rs:1955): GAINS `app: AppHandle` param (Tauri auto-injects,
  no frontend change; needed to read adopted_folders — get_connection is private,
  so share/move the helper). Merge adoption records into `found_folders` BEFORE
  the diff (critical: records appended to `added` but absent from `found_folders`
  land in `removed` too, and applySyncResult's remove-filter runs after add →
  folder vanishes on first sync). Adopted channels are folders even without [NB]
  tag; ownership re-verified (GetChannels, trusting the STORED access_hash when
  the fetch returns a min/stripped object); lost rights or CHANNEL_PRIVATE →
  auto-unadopt + add to `removed` (reason log-only — ScanResult.removed is
  Vec<i64>, no reason field; toast shows counts only).
- `cmd_rename_folder` (fs.rs:44-97): adopted path = EditTitle WITHOUT [NB]
  re-append; EXTEND the peer match to accept `Peer::Group` for adopted megagroups
  (InputChannel construction needs id + access_hash from group.raw for megagroups
  too — Chat::Channel raw type carries both regardless of broadcast flag).
- `cmd_delete_folder` (fs.rs:176): refuse to delete adopted channels (error
  "Use Remove from NoBuf") — unadopt command handles removal.
- `resolve_peer` seeding: adoption records seed peer cache via GetChannels
  (channel_id, access_hash) so upload/download/move to adopted folders work
  even when archived (dialog scan can't see them). Seeded Peer for megagroups
  becomes Peer::Group — rename/delete matches extended accordingly.
- `cmd_update_nb_pub_sync` / `cmd_sync_public_channels` (public_channels.rs):
  upload/reconcile the `adopted` array alongside channels (wrapper struct with
  legacy-array fallback on read). STARTUP FIX: auto-sync currently runs the scan
  BEFORE cmd_sync_public_channels (useTelegramConnection.ts:58 vs ts:72) —
  after NB-PUB sync lands new adoptions in SQLite, re-run the scan (or reorder)
  so adopted folders appear on FIRST launch, not the second.

### Frontend changes

- AddChannelModal: new "Your channels" section (or unified list) fed by
  cmd_list_owned_channels (own state/latch — separate from cmd_list_joined_channels);
  each row: title, @username, badge Owner/Admin, eligibility disabled-state with
  reason. PER-ACTION gating, not row gating: an owned channel already added as a
  Public Channel is Add-disabled but must stay ADOPTABLE (current row-level
  `disabled = already_added || is_nb_folder` at :262 would block both).
  Action "Add as folder" → cmd_adopt_channel (returns FolderMetadata with
  is_adopted=true) → push into folders state DIRECTLY like handleCreateFolder
  (useTelegramConnection.ts:232-245) — onAdded only invalidates ['publicChannels']
  (Dashboard.tsx:1075) and would NOT make the folder appear; new prop wiring
  Dashboard→Sidebar→PublicChannelSidebarSection→Modal OR lift adoption handler
  into useTelegramConnection and pass it down. Adopt reuses the modal's OWN
  uploadSync (AddChannelModal.tsx:28-33 — modal does NOT use usePublicChannels).
  ALSO: reset `browseFetched` latch in handleClose (AddChannelModal.tsx:131-136)
  so eligibility/already-adopted state is fresh each open — pre-existing staleness
  bug that adoption rows would inherit.
- Sidebar: MINIMAL change required (plan previously said "no changes" — wrong):
  folder rows must carry is_adopted to SidebarItem for menu gating; reuse the
  cmd_get_enriched_folders precedent (Sidebar.tsx:88-98 builds folderGroupMap —
  same pattern for an adopted-id set) OR rely on TelegramFolder.is_adopted riding
  the folder objects themselves (preferred — one source of truth from scan output).
- SidebarItem.tsx INLINE folder context menu (:302-396): for adopted folders
  (folder.is_adopted) show "Remove from NoBuf" (unadopt) instead of the current
  Delete; add separate "Delete channel permanently…" danger item (stronger
  confirm: channel name + subscriber count warning). New props onUnadopt /
  onDeletePermanently following the existing onRename/onDelete prop pattern.
  The HOVER-X delete button (:290-294) must ALSO gate on is_adopted (route adopted
  folders to the unadopt flow, not cmd_delete_folder) — otherwise users hit the
  raw "Failed to delete folder: Use Remove from NoBuf" toast dead end.
  Unadopt (from sidebar) fires cmd_update_nb_pub_sync itself — neither
  usePublicChannels nor modal uploadSync covers that call site.
- useTelegramConnection: adoptFolder/unadoptFolder handlers; applySyncResult
  handles adopted-folder additions/removals (is_adopted rides on FolderMetadata
  so store-persisted folders keep the flag across restarts); unadopt handler
  updates store; sync summary counts adopted in the existing toast (counts only —
  no reason field; log-only reasons on the backend). Rename the auto-unadopt
  active-folder toast copy: "removed on Telegram" is wrong for rights-lost removals.
- types.ts: TelegramFolder gains is_adopted?: boolean; JoinedChannel gains
  is_creator, is_admin_post; new AdoptedFolder type.

### Tauri registration

New commands follow the 3-site pattern: commands module, commands/mod.rs, lib.rs
generate_handler, permissions/autogenerated committed.

## Phases

### Phase 1 — Backend core (Rust)
Schema, AdoptedFolder model, adopt/unadopt/list commands, registration.
Test: cargo test (new unit tests for record CRUD against temp DB), manual smoke
via invoke from dev console.
Verify: adoption records persist across restart; adopt/unadopt round-trip.

### Phase 2 — Scan merge + rename/delete semantics
cmd_scan_folders merge (AppHandle param + shared get_connection), ownership
re-verification loop, auto-unadopt on lost rights/CHANNEL_PRIVATE, cmd_rename_folder
adopted branch (no [NB] re-append + Peer::Group match extension), cmd_delete_folder
guard, peer-cache seeding from records (stored-hash fallback for min objects).
FolderMetadata gains is_adopted (serde default false) so scan output flags adopted
folders for the frontend. Merge into found_folders BEFORE the diff (double-count trap).
Test: cargo tests for merge logic (pure functions extracted where possible) —
MUST include: adopted record → appears in added AND NOT in removed (first-sync
trap); megagroup adopted record → folder present; lost-rights record → in removed
+ row deleted.
manual QA: adopt → rename in NoBuf (no [NB] appears), rename in Telegram → sync
updates label; adopt → remove rights in Telegram → sync auto-removes.
Verify: full sync cycle with adopted folder present; no regressions on regular
[NB] folders (existing tests green); vitest suites still pass (TelegramFolder
type gains optional field only).

### Phase 3 — NB-PUB sync of adoptions
NbPubSync wrapper, upload includes adopted, reconcile inserts/deletes adoption
records (ownership re-verified on receipt), legacy-array fallback. STARTUP ORDERING
FIX: after cmd_sync_public_channels lands remote adoptions in SQLite, re-run the
scan (or apply adoptions directly) in the startup chain so folders appear on
first launch (QA 8b).
Test: unit test legacy JSON (plain array) parses via fallback; new JSON
round-trips; reconcile: remote adoption for channel lacking rights locally →
not inserted (or inserted then removed at next scan — decide: insert only if
rights verified; log + skip otherwise).
Verify: two-device flow simulated by re-syncing after manual SQLite edit.

### Phase 3.5 — Adopt-eligible list (backend)
cmd_list_owned_channels: main + archive dialog scans (raw GetDialogs invoke with
manual pagination — 100-dialog cap, loop on offset_date/offset_id/offset_peer;
3-variant Dialogs parsing; Dialog::Folder variant ignored), eligibility flags
(raw Chat::Channel match — covers megagroups that route to Peer::Group; admin_rights
enum unwrap Some(ChatAdminRights::Rights(r)) => r.post_messages; creator → synthetic
full rights), [NB]/[NB-PUB]/already-adopted exclusions.
Test: unit tests for eligibility predicate (creator / admin+post_messages /
plain member / non-channel); manual QA against real account.
Verify: archived owned channels appear; subscriber-only channels don't.

### Phase 4 — Frontend UI
AddChannelModal "Your channels" section (own fetch state + latch) + badges +
per-action gating (Add vs Adopt — row-level disabled blocks adoption of
already-added channels otherwise) + browseFetched latch reset; SidebarItem
inline folder menu: Unadopt / Delete-channel-permanently for is_adopted folders
(+ hover-X delete button gated on is_adopted → routes to unadopt); adopt handler
pushes folder into state directly (handleCreateFolder pattern, new prop wiring
through Dashboard→Sidebar→PublicChannelSidebarSection→Modal or lifted hook);
unadopt fires cmd_update_nb_pub_sync itself (new call site — neither modal
uploadSync nor usePublicChannels covers it); sync-summary toast counts adopted;
active-folder toast copy distinguishes rights-lost removals.
Test: existing vitest suite green; new tests for gating logic (pure helper
exported, per nobuf-vitest-testing conventions).
Verify: full E2E manual QA table (see below).

### Phase 5 — Docs + skill updates
CHANGELOG entry; telegram-grammers skill: creator/admin_rights readout patterns;
nobuf-vitest-testing: new test seams if any.

## Edge cases handled

| Case | Behavior |
|---|---|
| Adopted channel archived in Telegram | Peer cache seeded from adoption record (GetChannels); archive scan includes it in adopt-eligible list |
| Channel deleted on Telegram | Scan resolve fails (CHANNEL_PRIVATE) → auto-unadopt, reported in sync summary |
| Ownership transferred/demoted | Next scan re-verifies rights → auto-remove folder, sync summary reports |
| Rename in NoBuf | Real EditTitle, no [NB] append; label follows real title |
| Rename in Telegram app | Next sync updates sidebar label (single truth) |
| Channel also in Public Channels | Adopt auto-removes from public_channels table |
| Old NoBuf build reads new NB-PUB JSON | Old builds' `from_slice::<Vec<PublicChannel>>` fails on the wrapper → existing fallback keeps the local list (public_channels.rs:1158-1162, verified graceful, no brick) — old builds lose sync until upgraded, acceptable |
| New build reads old NB-PUB JSON | Fallback parses plain array → adopted = empty |
| Megagroup adopted | Allowed; grammers routes it as Peer::Group — adopt-eligible scan matches both Peer kinds; EditTitle/DeleteChannel both work on megagroups |
| [NB]-tagged channel you own | Regular folder via scan; never adoptable (no duplicate) |
| [NB-PUB] | Explicit exclusion by stored channel id + title match (title match already excludes it today) |
| Mock mode (no client) | Adopt/unadopt are DB-only, work in mock mode; list_owned returns empty |
| Sync adoption from device where account lacks rights | Not inserted (rights verified before insert); logged |
| Upload to adopted megagroup | resolve_peer seeded from record; send_message is Peer-generic — works; rename/delete matches extended to Peer::Group |
| post_messages-only admin tries to RENAME adopted channel | EditTitle needs change_info right → CHAT_ADMIN_REQUIRED error from Telegram; surface the error toast honestly (eligibility for ADOPTION stays post_messages — decision #3 — but rename needs more; acceptable, documented) |
| Transferred-away owner who keeps admin+post_messages | Stays eligible by design (decision #3); auto-unadopt only fires when BOTH creator and post rights are gone |
| GetChannels returns min channel (stripped access_hash) | Seeded Peer constructed with the STORED hash from the adoption record (public_channels.rs:503-505 precedent) |
| Delete channel permanently on channel with >1000 members | CHANNEL_TOO_LARGE from Telegram — surface error; suggest deleting from the Telegram app instead |
| Mock mode (no client) | Adopt/unadopt DB CRUD works, but scan mock path (fs.rs:1960-1963) returns empty ScanResult → adopted folders don't surface via scan in mock mode (acceptable: mock is dev-only) |
| Failed NB-PUB upload after adopt | Next sync from another device's newer message drops the local adoption (last-writer-wins, same as channels today); QA row covers it |
| Modal reopen shows stale eligibility | browseFetched latch reset in handleClose (pre-existing staleness fixed as part of adoption rows) |
| Folder appears after adoption without restart | adopt handler pushes FolderMetadata into folders state directly (handleCreateFolder pattern) — NOT via onAdded/publicChannels invalidation |
| CHANNEL_TOO_LARGE on archive scan (channels >1000 members) | GetDialogs folder_id=1 may refuse very large channels; degrade gracefully: those channels still reachable via main dialog list if unarchived, else absent from eligible list (acceptable, logged) |

## Manual QA table (per commit, user-facing)

| # | Do | Expect |
|---|---|---|
| 1 | AddChannelModal → Your channels → adopt owned channel | Folder appears in Folders section, original title, no [NB] |
| 2 | Upload a file to adopted folder | Upload succeeds, file visible in channel in Telegram app |
| 3 | Rename adopted folder in NoBuf | Telegram title changes to new name (no [NB] appended) |
| 4 | Rename channel in Telegram app → sync in NoBuf | Sidebar label updates |
| 5 | Remove from NoBuf (context menu) | Folder gone from sidebar; channel + subscribers intact in Telegram |
| 6 | Delete channel permanently (danger dialog) | Channel actually deleted from Telegram |
| 7 | Adopt channel also added as Public Channel | Public Channels section loses it; Folders gains it |
| 8 | Demote self / transfer ownership in Telegram → sync | Folder auto-removed; sync summary reports removal |
| 8b | Fresh app launch on device B after adopting on device A | Adopted folder visible on FIRST launch (post-NB-PUB-sync re-scan), not the second |
| 9 | Old [NB] folders flow | Unchanged: create/rename/delete/delete-on-scan still work |
| 10 | Adopted channel archived in Telegram → upload/download | Still work (peer cache seeded from adoption record) |
| 11 | Second device: NB-PUB sync brings adoptions | Adopted folders appear; channels you don't own/admin not adopted |
| 12 | [NB-PUB] and [NB]-tagged channels | Never in adopt-eligible list |
| 13 | Adopt on device A with upload failing → sync on device B → back on A | Last-writer-wins: B's list (without the adoption) may drop A's local row — same behavior as channels today; no data loss beyond the adoption record itself |
| 14 | Adopt a megagroup you admin (post rights) | Appears as folder; upload works; rename works; unadopt works |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Archive scan API (GetDialogs folder_id=1) behaves differently than assumed | Med | Phase 3.5 spike FIRST: verify folder_id=1 returns archived dialogs (incl. megagroups + our own channels), with manual pagination + 3-variant Dialogs parsing (Dialogs/Slice; NotModified impossible with hash=0), before building UI on it |
| Owner flags not present on min channel objects in dialog results | High | Dialog results are full objects (verified: grammers PeerMap caches full chats from GetDialogs; api/min docs say min appears in message contexts); adopt action re-verifies via GetChannels anyway |
| Megagroup Peer::Group routing breaks `if let Peer::Channel` assumptions | High | Verified routing (peer/mod.rs:43-59); scan matches both; rename/delete peer matches extended to Peer::Group for adopted records; resolve_peer is Peer-generic |
| Frontend folder refresh after adoption (folders state in different tree) | Med | adopt handler pushes into folders state directly (handleCreateFolder pattern); plan wires it explicitly |
| Startup ordering: scan runs before NB-PUB sync lands adoptions | Med | Post-NB-PUB-sync re-scan in the startup chain (QA row 8b); no reorder of existing calls needed |
| added+removed double-count in applySyncResult | High | Adoption records merged into found_folders BEFORE the diff (spec'd in Backend changes); unit test covers first-sync-after-adopt |
| GetChannels on stale access_hash after channel transfer | Low | CHANNEL_PRIVATE → auto-unadopt (same recovery as NB-PUB stale channel); min/stripped hash → trust STORED hash |
| SQL injection in new queries | Med | Parameterized statements only (house rule, tauri-rust skill) |
| SQLITE_BUSY from a third writer on nobuf_groups.db | Low | Pre-existing pattern (no busy_timeout anywhere); short-lived connections keep the window small; not our fix to make |
| Sync payload growth | Low | adopted array is tiny (ids/hashes/titles) |
| Rename both directions race | Low | Single truth = server title; NoBuf rename calls EditTitle; scan reads back |

## Out of scope

- Ownership info for channels you don't administer (Telegram doesn't expose it)
- Auto-adoption of any kind
- Local display-name overrides (rejected in interview — single truth)
- Basic (non-super) groups adoption
- Moving files between adopted folders and public channels beyond existing move
