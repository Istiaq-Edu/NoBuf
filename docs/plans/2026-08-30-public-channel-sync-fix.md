# Public Channel Sync Fix — Implementation Plan

**Date:** 2026-08-30
**Branch:** `feat/sync-public-channels`
**Status:** Approved by user (scope B, conflict policy A, live QA A)

---

## 1. Problem (user report, terminology decoded)

User's words: "public channels" = channels added via the Add-Channel feature (invite link
`t.me/+hash` or username `t.me/name`). "Private channels" = own `[NB]` storage folders.
Report: channels added on device A never appear on device B of the same Telegram account.
`[NB]` folders sync fine (title-based folder scan); public channels do not.

Intended design (docs/specs/2026-06-28-public-channel-browsing-design.md, Decision 3/7):
added channels upload as JSON to a hidden `[NB-PUB]` channel and reconcile on startup.
Membership is account-level — same account on another device IS a member, so a synced
`access_hash` works there directly. The design was right; the implementation is broken.

## 2. Root cause — two bugs, one dangerous coupling

### Bug B (download is dead on every device)
`cmd_sync_public_channels` — `app/src-tauri/src/commands/public_channels.rs:1037-1041`:

```rust
let messages = match result {
    grammers_tl_types::enums::messages::Messages::Messages(m) => m.messages,
    grammers_tl_types::enums::messages::Messages::Slice(m) => m.messages,
    _ => Vec::new(),   // ← ChannelMessages dropped
};
```

GetHistory against a channel answers `Messages::ChannelMessages`. The match drops it →
`messages.is_empty()` → early return `cmd_get_public_channels(app)` (local list). Sync
download silently no-ops on every device, forever. The identical bug was fixed for
`cmd_get_public_channel_files` in commit 60abbf6 ("handle ChannelMessages variant") —
the sync path never got the same arm.

Evidence upload works: local DB `nb_pub_message_id = 7`, `[NB-PUB]` channel id
4353118443 exists. Only download is broken.

### Bug A (upload never fires after add)
`AddChannelModal.tsx` invokes `cmd_join_channel_by_link` / `cmd_add_joined_channel`
directly at 3 call sites (link-join line ~51, preview-add line ~71, browse-add line ~102).
The `joinByLink` / `addJoined` mutations in `usePublicChannels.ts` — the only code that
calls `cmd_update_nb_pub_sync` on add — are **dead code**: no component uses them.
So adds never upload. (Removal DOES upload — `removeChannel` mutation is wired.)

### The coupling (why Bug B must not ship alone)
After an add, the modal's `onAdded` → Dashboard `onPublicChannelsChanged` →
`syncFromRemote.mutate()` — a **download-reconcile**. Once Bug B is fixed, that
reconcile compares just-added local rows against a stale remote (missing the new
channel, because Bug A) and **deletes the just-added channel**. Today Bug B is the
only thing accidentally preventing this. Both bugs + the add-flow must be fixed
together.

### Same-class bug (in scope, user-approved)
`fs.rs` search (cmd_search_files region, lines 1890-1920): `if let Messages::Messages /
else if Messages::Slice` — no `ChannelMessages` arm → search inside channels returns
empty. Same fix class.

## 3. User-confirmed decisions

| Decision | Choice |
|---|---|
| Scope | Fix sync bundle AND fs.rs search variant bug |
| Conflict policy | Last-write-wins (June-28 Decision), edge documented, no merge protection |
| Verification | Full live QA on real account incl. join+remove throwaway channel round-trip |

## 4. Implementation phases

### Phase 1 — Backend: sync download fix
File: `public_channels.rs` (+ shared helper in `commands/utils.rs`)
1. Shared helper in `commands/utils.rs` (natural home; both public_channels.rs and
   fs.rs need it): `pub(crate) fn messages_from_history(result: &messages::Messages) -> Vec<Message>`
   with all three arms (`Messages`, `Slice`, `ChannelMessages`).
2. Use it in `cmd_sync_public_channels` (replaces the 2-arm match at :1037).
3. JSON parse failure: log + fall back to local list instead of hard error
   (matches the function's existing fallback pattern; corrupt remote JSON must not
   brick the app).
4. Robustness — upload ordering in `cmd_update_nb_pub_sync`: send new message FIRST,
   then delete old. Crash-window failure mode flips from "sync data lost remotely"
   to "duplicate message", which self-heals (sync reads newest, limit=1).
5. Edge — [NB-PUB] archived by user: `get_nb_pub_access_hash` scans only the main
   dialog list (`folder_id: None` in grammers dialogs.rs: verified). Persist
   `nb_pub_access_hash` in `nb_pub_settings` whenever obtained; check settings
   before scanning. Manual archive no longer breaks sync.
6. Edge — user deletes [NB-PUB] (edge 13): on CHANNEL_PRIVATE / CHANNEL_INVALID
   during sync-download, clear `nb_pub_channel_id` + `nb_pub_message_id` settings
   and fall back to local. Next upload lazily recreates the channel.
7. Unit tests: `messages_from_history` with constructed TL values (reuse the
   `test_channel`-style constructor approach) — must include a `ChannelMessages`
   case. Mutation-verified RED.

**Verify:** `cargo test` in src-tauri; manual: temporarily break arm → test RED.

### Phase 2 — Backend: fs.rs search variant fix
File: `fs.rs` (~1885-1945)
1. Extract the two duplicated `if let / else if let` bodies into one
   `let messages = ...` match with all three arms, single loop body after it.
   (The current code duplicates a 30-line body twice; a third copy is unacceptable —
   collapse to one.)
2. Unit test for the extraction helper with a `ChannelMessages` input.

**Verify:** `cargo test`; `npx tsc --noEmit` still clean.

### Phase 3 — Frontend: upload-on-add wiring
Files: `AddChannelModal.tsx`, `Dashboard.tsx`, `usePublicChannels.ts`
1. `AddChannelModal`: after each successful add (all 3 invoke sites), fire
   `invoke('cmd_update_nb_pub_sync')` with the standard catch pattern
   (console.warn + toast 'Sync update failed — changes are local only.').
   Extract a tiny `uploadSync()` helper inside the modal to avoid triplication.
2. `Dashboard.tsx`: `onPublicChannelsChanged` currently → `syncFromRemote.mutate()`
   (download — WRONG after add). Change to query invalidation only:
   `queryClient.invalidateQueries({ queryKey: ['publicChannels'] })`.
3. Orphan cleanup: `syncFromRemote` becomes unused → remove from the hook's return
   and Dashboard destructure (the mutation object; keep `cmd_sync_public_channels`
   backend — startup auto-sync in `useTelegramConnection.ts` uses it directly).
4. Structural test (pattern: `AuthCredentialPersistence.test.ts`): source-scan
   `AddChannelModal.tsx` asserting every successful `cmd_join_channel_by_link` /
   `cmd_add_joined_channel` site is followed by an `cmd_update_nb_pub_sync` call —
   fails on any bare add. Mutation-verified RED (remove one upload call → RED).

**Verify:** `npx vitest run` + `npx tsc --noEmit`.

### Phase 4 — Full gates + live QA
1. Gates: `cargo test --no-default-features` (src-tauri), `npx tsc --noEmit`,
   `npx vitest run` (app). All green before QA.
2. Live QA on this machine (real account, session present):
   - a. Add throwaway public channel via link → verify row in SQLite +
        fresh JSON in [NB-PUB] (message id advances), is_member=1.
   - b. Delete local rows for it (+ existing channel stays), restart app →
        startup auto-sync restores BOTH from [NB-PUB] → download path proven.
   - c. Remove the throwaway channel (keep subscription) → verify it vanishes from
        [NB-PUB] JSON and does not reappear after restart → remove-upload proven.
   - d. Search inside a channel returns results (fs.rs fix proven).
3. Report results as do-this/expect-that table.

## 5. Edge cases inventory

| # | Edge | Handling |
|---|---|---|
| 1 | ChannelMessages dropped in sync | Fixed (Phase 1) |
| 2 | Add without upload | Fixed (Phase 3) |
| 3 | Download-after-add deletes new channel | Fixed (Phase 3: invalidate-only) |
| 4 | Remove while offline → stale remote re-adds | ACCEPTED last-write-wins; documented here |
| 5 | Corrupt/foreign JSON in [NB-PUB] | Log + fallback to local (Phase 1.3) |
| 6 | [NB-PUB] manually archived | Persisted access_hash (Phase 1.5) |
| 7 | Crash mid-upload | Send-then-delete ordering; duplicates self-heal (Phase 1.4) |
| 8 | Old sync JSON missing is_member | Non-issue: field present since first NB-PUB commit (5b0aeb5) — verified |
| 9 | Device B can't find [NB-PUB] (not archived scenario; fresh device, channel in main list) | Existing dialog scan works; [NB-PUB] is created (not invite-joined) so never auto-archived |
| 10 | Account switch on same machine | Out of scope; sync errors are non-fatal (startup try/catch) and vault logout hygiene already wipes hidden-ID lists |
| 11 | Same channel added on two devices simultaneously | Last write wins; both devices converge to newest JSON |
| 12 | Channel deleted/kicked between syncs | Existing NOT_A_MEMBER path (cmd_get_public_channel_files:652) already handles; unchanged |
| 13 | User deletes [NB-PUB] channel manually | NEW edge: stale `nb_pub_channel_id` + `nb_pub_message_id` in settings → both sync paths fail forever. Fix (Phase 1.7): on CHANNEL_PRIVATE / CHANNEL_INVALID from GetHistory/access-hash lookup, clear both settings; next upload lazily recreates [NB-PUB] |
| 14 | First-run wipe on other devices | EXPECTED behavior after fix: local-only rows (never uploaded due to Bug A) missing from remote are deleted by first reconcile. Recoverable: channels remain joined on Telegram, re-add via Browse. QA step (b) probes remote contents. Ships as documented behavior |
| 15 | Crash between send-new and delete-old | Orphan old message left in [NB-PUB]. Harmless: download reads newest (limit=1); next upload deletes by tracked id. Accepted |

## 6. Out of scope
- Bidirectional merge / offline mutation queue (explicitly declined, decision A)
- Any UI redesign of the sidebar/modal (surgical only — repo rule)
- Account-switch NB-PUB separation
- Changes to [NB] folder scanning
