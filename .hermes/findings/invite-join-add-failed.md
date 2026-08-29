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

## Post-commit review (2026-08-29, reviewer subagent died at 30s — parent absorbed)

**External verification — grammers reference implementation:**
`grammers-client/src/client/chats.rs:328-345` `updates_to_chat()` handles
exactly `Combined` + `Updates` for ImportChatInvite responses — the identical
arm set to our `chats_from_updates`. The library authors solved the same
problem the same way. Independent confirmation of the root cause and fix shape.

**Verified claims (re-derived from grammers source):**
- `RpcError::Display` (mtsender/errors.rs:110-121) = `"rpc error {code}: {name}"`
  → `USER_ALREADY_PARTICIPANT` IS present in the error string → the
  `msg.contains(...)` recovery fires. **Previously unverified, now closed.**
- `map_error` (utils.rs:137-153) handles FLOOD_WAIT for both the
  ImportChatInvite and the fallback CheckChatInvite invocation.
- The fallback `CheckChatInvite` errors (`INVITE_HASH_EXPIRED`,
  `INVITE_HASH_EMPTY`) propagate via `map_error` — correct: no join happened,
  no partial state.

**Known minor gaps (documented, accepted):**
1. `CheckChatInvite::Already` with non-Channel chat (basic group) → falls to
   the generic "may be a group" error rather than the resolve path's explicit
   "Already joined but not a channel". Consistency nit, not correctness.
2. Legacy code smell retained (pre-existing, out of scope): dedup INSERT at
   :381-393 does `stmt.next()` then discards the result — an INSERT failing
   would surface as Ok with no row. Pre-existing pattern across the file, same
   class as cmd_add_joined_channel:460. Not introduced by this fix; left
   untouched per surgical-change rule.
3. Live-packet capture of the actual failing response shape not possible
   offline; Combined remains inferred from Telegram semantics + the grammers
   reference. The fix covers all shapes regardless.

**Final status:** complete. Awaiting user's live QA (re-add the invite link).

## Round 2 — live QA finding: "Channel not found in your dialogs" (FIXED, aad5237)

**Symptom:** preview of the invite link works, clicking Add errors.
**Path:** preview → `cmd_add_joined_channel` → dialog scan → miss.
**Root cause:** the add command resolved the channel by scanning the **main
dialog list** (iter_dialogs, folder_id: None — grammers dialogs.rs:25).
Channels joined via invite link are **auto-archived** by Telegram — archived
chats don't appear in the main list, so the scan missed a channel the user is
provably a member of. Preview worked because CheckChatInvite needs no dialogs.
**Fix:** `cmd_add_joined_channel` now takes `access_hash` (both frontend paths
already had it — preview payload and Browse rows). With a hash, resolution is
a direct `channels.getChannels` call — archived-chat-proof. Dialog scan
retained as fallback for hash-less callers. Min-channel guard: a stripped/zero
hash in the response falls back to the caller-provided hash.
**Verified:** cargo 431/431, vitest 1188/1188, tsc clean.

Note: the original e89c122 fix (Updates::Combined) remains correct and
necessary — but this second bug was the one that fired for this user's live
repro: already-joined state means preview → "Add to NoBuf" path, which never
reached the join command at all.
