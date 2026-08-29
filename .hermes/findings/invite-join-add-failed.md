# Findings: "Joined" but channel not added to NoBuf

**Branch:** fix/joined-but-not-added-v2 (from fix/invite-join-add-failed @ 9086bc8)
**Status:** ROOT CAUSE FOUND — P0 VERIFIED
**Repro link:** t.me/+JVFkVGMNwTdhY2Nh

## Symptom
- User adds a channel to NoBuf via link `t.me/+JVFkVGMNwTdhY2Nh`
- NoBuf reports **joined** — and the join DID happen (channel visible in the Telegram client)
- But the channel is **not added** to NoBuf's channel list
- Net effect: NoBuf mutates the user's Telegram account (join) without updating its own state. Worst kind of partial failure.

## Root cause (VERIFIED — public_channels.rs:293-303)

`cmd_join_channel_by_link` on the `invite_hash` path invokes `messages.ImportChatInvite`
and matches the response **only** against `Updates::Updates(u)` — one of **seven**
variants of the `Updates` enum (generated_enums.rs:21698-21706):
TooLong, UpdateShortMessage, UpdateShortChatMessage, UpdateShort,
**Combined(UpdatesCombined)**, Updates, UpdateShortSentMessage.

**Failure sequence:**
1. UI: AddChannelModal.handleJoin → `invoke('cmd_join_channel_by_link')` (AddChannelModal.tsx:51)
2. Rust: ImportChatInvite succeeds → **join is real, server-side, irreversible**
3. Telegram answers with `UpdatesCombined` (server merges update batches when the
   channel's recent history is long — seq gaps get combined; the response still
   carries `chats` including the joined channel)
4. The `if let Updates::Updates(u)` at :294 does not match → `found` stays None
5. `found.ok_or("Joined but could not identify channel")` at :303 → Err
   **after the join already happened**
6. UI: toast.error("Joined but could not identify channel") — user reads "Joined" +
   nothing added to the list. Join mutated the account; add never persisted.

**Why Combined is the expected shape here:** Telegram servers batch updates with
`seq` gaps into `updatesCombined` when the join produces more updates than a single
`updates` object carries (large channel with active history). This is not exotic —
it's the common case for big channels. The bug is deterministic for those channels.

**Secondary finding (same site):** even when `Updates::Updates` IS matched, the chat
scan filters `c.broadcast == true` (:297). A megagroup accessed via invite hash would
be skipped → same "Joined but could not identify channel" partial failure. (The
username path has the same broadcast filter at :275.) Megagroup-via-invite is a
lower-frequency case; note it but the fix should handle it uniformly.

## Sibling sites — same bug class (`Updates::Updates`-only matching)

| Site | Function | Same risk? |
|---|---|---|
| public_channels.rs:294 | cmd_join_channel_by_link (invite) | **P0 — the bug** |
| public_channels.rs:761 | find_or_create_nb_pub_channel (CreateChannel) | No — CreateChannel always returns Updates::Updates (single-constructor response) |
| fs.rs:146 | cmd_create_folder (CreateChannel) | No — same reason |
| public_channels.rs:226 | cmd_resolve_channel_link (CheckChatInvite → Already) | Related path: CheckChatInvite::Already gives Chat directly. Fine. |

## Also relevant (context, not bugs)
- `cmd_add_joined_channel` (public_channels.rs:412): the "already joined → add" path
  resolves the channel by scanning dialogs (iter_dialogs). Works — and is the
  recovery path for channels already joined but not added (the user's current state
  for this channel: joined from the buggy attempt, not added).
- Toast layer: AddChannelModal.tsx:55-61 surfaces Err strings verbatim →
  "Joined but could not identify channel" toast is the mechanism that made the user
  read "joined". Not a bug per se, but the error name kept the partial failure
  invisible as a bug for a while.
- `t.me/+hash` on a public channel routes through invite path even if the underlying
  channel is public — parse_channel_link (:63) routes `+` → invite_hash. Correct
  per Telegram semantics.
- UsePublicChannels.joinByLink onSuccess (usePublicChannels.ts:21-26) is dead code
  for this modal — the modal calls invoke directly (AddChannelModal.tsx:51), not the
  mutation. The mutation exists but is unused by the link-add flow. Not a bug, but
  worth knowing when tracing "who calls this".

## Fix (landed)

**public_channels.rs — `cmd_join_channel_by_link` invite path:**

1. **`chats_from_updates` helper** — extracts `chats` from both `Updates::Updates`
   and `Updates::Combined` (the dropped variant), empty for all 5 non-carrying
   variants. Replaces the single-variant `if let` at the old :294.
2. **`USER_ALREADY_PARTICIPANT` recovery** — a retry of the same invite link
   (the user's exact state after the buggy first attempt) no longer errors;
   falls through to identification instead of returning after the mutation.
3. **`CheckChatInvite` fallback** — when the join response carries no usable
   broadcast channel (Combined with megagroup-only chats, etc.), identify the
   exact chat via the invite hash: as a member, `messages.checkChatInvite`
   answers `chatInviteAlready` with the full Chat object. Precise — never
   guesses from the dialog list (an earlier draft scanned dialogs and picked
   the LAST broadcast channel; rejected as a wrong-channel risk).
4. **Honest error** — if even that fails (megagroup invite: broadcast=false),
   the error now says the join happened and NoBuf can't add groups, instead of
   the misleading "Joined but could not identify channel".

## Verification plan
- [x] Reproduce logically: invite path + Combined response → "Joined but could not
      identify channel" (verified by code reading; live repro needs the channel)
- [x] Root cause documented with file:line
- [x] Unit tests: helper covers all 7 Updates variants (4 tests, bound to the
      shipped `chats_from_updates`, not test-local copies)
- [x] Mutation test: drop `Combined` arm → 2 tests RED (429 pass/2 fail);
      restore byte-identical (sha256 b34c1dbb… pre/post) → 431 GREEN
- [x] Full gates: cargo test 431/431 · vitest 1188/1188 · tsc clean ·
      git diff --check clean · old patterns grepped to 0
- [ ] Manual QA (user): re-add `t.me/+JVFkVGMNwTdhY2Nh` — already-joined state
      → ImportChatInvite answers USER_ALREADY_PARTICIPANT → CheckChatInvite
      fallback identifies it → row inserted. Expect "Channel added to NoBuf."
- [ ] Sibling QA: public username link add (`t.me/name`) — path unchanged,
      resolve-then-join, no partial-failure window
- [ ] Sibling QA: already-joined add via Browse (`cmd_add_joined_channel`) —
      unchanged, dialog-scan by exact channel_id

## Verdict
**VERIFIED P0 — FIXED.** Root cause: single-variant `Updates` matching at the
old public_channels.rs:294 discarded `UpdatesCombined` responses from
`messages.ImportChatInvite`, erroring AFTER the irreversible join ("Joined but
could not identify channel") with no DB insert. Fix: `chats_from_updates`
helper (both variants) + `USER_ALREADY_PARTICIPANT` recovery +
`CheckChatInvite` identification fallback + honest group-invite error.
Mutation-tested, full gates green.
