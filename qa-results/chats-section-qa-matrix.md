# Chats Section — Manual QA Matrix (Phase 2 complete)

Branch: `feat/normal-chats-section` (base dbafe50). Builds: cargo check 0/0, cargo test 466/466, tsc clean, vitest 1200/1200.

**Status: PENDING MANUAL RUN** — requires a live Telegram session. Execute against `npm run tauri dev`.

| # | Do | Expect | Result |
|---|---|---|---|
| 1 | Open '+' in Chats header | Picker lists eligible dialogs only (no channels/self/[NB]/adopted/forbidden; already-added disabled) | ☐ |
| 2 | Search picker | Live filter | ☐ |
| 3 | Add a DM | Row appears; toast; picker row disabled on reopen | ☐ |
| 4 | Open a chat | FileExplorer grid from history; pagination; empty chat → empty state | ☐ |
| 5 | Upload button in chat view | Uploads to chat (message lands in the Telegram chat; transfer row shows filename) | ☐ |
| 6 | Drag an OS file into the app while in a chat view | Streams direct to the chat (NOT Saved Messages) | ☐ |
| 7 | Delete a file in chat view | Telegram-native: own message deletes; others' where allowed; refusal = error toast | ☐ |
| 8 | Stream a video from a chat | Player works (folderId seam mirrors chat id) | ☐ |
| 9 | Remove chat (hover-X) | Unlist only; Telegram chat untouched | ☐ |
| 10 | Drag chat to Vault | Hidden; VaultView lists it; unhide restores; locked global search conceals its files | ☐ |
| 11 | Assign chat to colored group (ChatItem context menu) | Group dot ring; chip filter shows it under that group; deleting the group clears the assignment | ☐ |
| 12 | Drag-reorder chats | Order persists across restart | ☐ |
| 13 | Open dead chat (deleted account / left group) | Auto-remove + toast; navigate home | ☐ |
| 14 | Move file chat→folder | Forward+delete; file appears in folder; on delete-refusal file remains in source with "Delete original failed" toast | ☐ |
| 15 | Move file folder→chat and chat→chat (drag onto ChatItem) | File lands in target | ☐ |
| 16 | Forward from public channel to chat / from chat to chat (Forward modal) | File lands in target | ☐ |
| 17 | Drop oversize video in chat view | Split flow works (folder_id = chatId end-to-end); discard-job delete-parts works | ☐ |
| 18 | Collapse sidebar (rail) | Chats '+' renders centered; items render as letter avatars | ☐ |
| 19 | Restart app | Chats, order, group assignments, vault state persist; archived chat still opens; app open in a chat view restores THAT view (not a ghost "Folder" view) | ☐ |
| 20 | Global search while vault locked | No results leak from vaulted chats | ☐ |
| 21 | Sign out → sign in as another account | No revived chat uploads; chat list empty for the new account | ☐ |
| 22 | Section placement | Chats section between Private Channels and Public Channels with dividers | ☐ |
| 23 | Never added any chat | Chats section still visible: header + '+' + "No chats added." | ☐ |
| 24 | Restart while inside an ARCHIVED chat, immediately try a download | Either resolves (auto-sync landed) or clean "Folder/Chat N not found" error that self-heals after sync | ☐ |

## Dev-only verification notes (no Telegram session needed)

- Verified by tests: picker filters (16 Rust tests incl. [NB]-basic-group + User::Empty + packed-PeerId guard), resolve_chat_peer constructions, CHAT_GONE/stale-hash maps, archive pagination regression guard (source-scan), vault 3-tuple + blob roundtrip + merge union, order-merge rule (6 vitest), vault chat filter (3 vitest).
- Verified by compile/type gates: 3-site registration of all 7 commands (generic TauriCommandPermissions sweep), serde contract shapes, mirrored-id wiring completeness.
- Known runtime-only risks (from the three Phase-1 reviews, all mitigated): archived-chat seam ops before first auto-sync (MINOR-1, clean error + self-heal); GetHistory on real basic groups (same request shape as channels — no channel-only flags set).
