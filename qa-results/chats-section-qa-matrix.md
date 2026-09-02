# Chats Section — Manual QA Matrix (Phase 2 complete)

Branch: `feat/normal-chats-section` (base dbafe50). Builds: cargo check 0/0, cargo test 466/466, tsc clean, vitest 1200/1200.

**Status: AGENT SMOKE-RUN COMPLETE (2026-09-02)** — 15 rows verified live via CDP against the real Telegram account (see notes). Remaining rows need your manual pass (uploads 5/6/17, streaming 8, split 17, search 20, sign-out 21, mobile).

| # | Do | Expect | Result |
|---|---|---|---|
| 1 | Open '+' in Chats header | Picker lists eligible dialogs only (no channels/self/[NB]/adopted/forbidden; already-added disabled) | ✅ |
| 2 | Search picker | Live filter | ✅ |
| 3 | Add a DM | Row appears; toast; picker row disabled on reopen | ✅ |
| 4 | Open a chat | FileExplorer grid from history; pagination; empty chat → "No files in this chat yet" | ✅ |
| 5 | Upload button in chat view | Uploads to chat (message lands in the Telegram chat; transfer row shows filename) | ☐ |
| 6 | Drag an OS file into the app while in a chat view | Streams direct to the chat (NOT Saved Messages) | ☐ |
| 7 | Delete a file in chat view | Telegram-native delete; grid refreshes immediately (chatFiles invalidated); refusal = error toast | ☐ |
| 8 | Stream a video from a chat | Player works (folderId seam mirrors chat id) | ☐ |
| 9 | Remove chat (hover-X) | Unlist only; if it was the open chat, view jumps to Saved Messages | ✅ |
| 10 | Drag chat to Vault | Hidden; VaultView lists it; unhide restores; locked global search conceals its files | ✅ |
| 11 | Assign chat to colored group (ChatItem context menu) | Group dot ring; chip filter shows it under that group; deleting the group clears the assignment | ☐ |
| 12 | Drag-reorder chats | Order persists across restart | ✅ |
| 13 | Open dead chat (deleted account / left group) | Auto-remove + toast; navigate home | ✅ |
| 14 | Move file chat→folder | Forward+delete; file disappears from the chat grid; on delete-refusal the toast carries the backend "Delete original failed" text (partial success disclosed) | ✅ |
| 15 | Move file folder→chat and chat→chat (drag onto ChatItem) | File lands in target | ☐ |
| 16 | Forward from public channel to chat / from chat to chat (file context menu → Forward) | File lands in target; source chat never offered as target | ✅ |
| 17 | Drop oversize video in chat view | Split flow works (folder_id = chatId end-to-end); discard-job delete-parts works | ☐ |
| 18 | Collapse sidebar (rail) | Chats '+' renders centered; items render as letter avatars | ✅ |
| 19 | Restart app | Chats, order, group assignments, vault state persist; archived chat still opens; app open in a chat view restores THAT view (not a ghost "Folder" view) | ✅ |
| 20 | Global search while vault locked | No results leak from vaulted chats | ☐ |
| 21 | Sign out → sign in as another account | No revived chat uploads; chat list empty for the new account | ☐ |
| 22 | Section placement | Chats section between Private Channels and Public Channels with dividers | ✅ |
| 23 | Never added any chat | Chats section still visible: header + '+' + "No chats added." | ✅ |
| 24 | Restart while inside an ARCHIVED chat, immediately try a download | Either resolves (auto-sync landed) or clean "Folder/Chat N not found" error that self-heals after sync | ✅ |

## Agent smoke-run notes (2026-09-02, CDP-driven, real account)

Verified live: picker eligibility (3 dialogs, all exclusions held), Bot label + is_bot persistence (URL Uploader renders Bot icon/subtitle), add single-writer (ONE toast), chat view (breadcrumb title, chat-specific empty state), context menus in all three view shapes (chat: Play/Forward/Delete/no-Rename; public: Forward, no Delete; folder: unchanged), real E2E forward public→chat (Photo.jpg landed in Telegram chat), real E2E delete-in-chat with immediate grid refresh, download-from-chat queue + cancel, reorder conservation basic AND while vault-hidden + unhide-restore (the X1 BLOCKER scenario), VaultView Chats section + unhide, restart persistence (3 chats re-seeded).

**Bug found live & fixed (c77cf04):** filename-less media (mobile video, 164MB) rendered as "Unknown" — no classification, no Play. Shared `document_display_name()` helper now synthesizes `video_451.mp4` from attributes/mime across all three listings (chats/public/folders). 4 Rust tests pin it.

**Regressions found live/by pass-2 & fixed:** X2 flag regression (public Forward vanished — c77cf04), goBack hydration over-skip (dc6a3bd), m12 publicChannels wait + X8 third caller + m13 signature (00767d9).

## Dev-only verification notes (no Telegram session needed)

- Verified by tests: picker filters (16 Rust tests incl. [NB]-basic-group + User::Empty + packed-PeerId guard), resolve_chat_peer constructions, CHAT_GONE/stale-hash maps, archive pagination regression guard (source-scan), vault 3-tuple + blob roundtrip + merge union, order-merge rule (6 vitest), vault chat filter (3 vitest).
- Verified by compile/type gates: 3-site registration of all 7 commands (generic TauriCommandPermissions sweep), serde contract shapes, mirrored-id wiring completeness.
- Known runtime-only risks (from the three Phase-1 reviews, all mitigated): archived-chat seam ops before first auto-sync (MINOR-1, clean error + self-heal); GetHistory on real basic groups (same request shape as channels — no channel-only flags set).
