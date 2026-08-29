# Bug assessment: channel says "joined" but is not added to NoBuf

- **Branch:** fix/invite-join-add-failed
- **Reported:** 2026-08-28
- **Link:** t.me/+JVFkVGMNwTdhY2Nh (invite-style `+hash` link to a public channel)
- **Status:** IN PROGRESS

## Symptom
1. User adds the channel to NoBuf via the invite link.
2. UI reports "joined" — and the join is real: Telegram app shows the channel as joined.
3. The channel never appears in NoBuf's added list.

Join succeeds server-side. The **add** step (whatever persists the channel into NoBuf) fails or never runs.

## Unknowns
- Where the UI gets "joined" from (join command success? add command success?)
- What "add" persists (DB row, in-memory list, config?)
- Whether the add flow expects a @username-resolvable peer and chokes on a `+hash` invite peer

## Hypotheses
| ID | Hypothesis | Status |
|----|------------|--------|
| H1 | Join (importChatInvite) succeeds; add-to-drive step fails silently (error swallowed / not awaited) | unverified |
| H2 | Joined chat isn't carried into the add flow (peer resolution/normalization fails after join) | unverified |
| H3 | UI toast "joined" fires on join success even when add fails (error surfacing gap) | unverified |
| H4 | Invite-hash peer vs username mismatch breaks the add path | unverified |

## Plan
- [ ] P1 Locate join + add code paths (Rust commands, TS callers) → file:line
- [ ] P2 Trace data flow join→add; find the break; check error handling
- [ ] P3 Evidence from logs / repro
- [ ] P4 Root cause, fix, tests (revert→RED, restore byte-identical)

## Findings log
(every claim lands here with file:line — no chat-only findings)

## Verdict
pending
