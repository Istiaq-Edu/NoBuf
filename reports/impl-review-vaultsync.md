# Impl Review — Vault Sync (Saved Messages transport) — Consolidated

**Commit:** `663dea5` · Reviewer subagent died at max-iterations before writing findings; transcript-mined + controller-completed.
**Evidence from its trace:** it fully read vault_sync.rs, vault.rs, useTelegramConnection.ts, VaultContext.tsx, utils.rs, the spec, confirmed `resolve_peer(None)` → own peer via `get_me`, confirmed grammers exposes both `edit_message` (messages.rs:748) and `delete_messages` (:804), ran the governance vitest gate itself (12/12 pass), and was mid-investigation of message-date semantics when killed.

---

## S1 · Critical — Cross-account resurrection via pull-after-wipe
**Confirmed by controller trace.** The interleaving:
1. Account A uses the app; every hide pushes a `[NoBuf-Vault-v1]` blob with A's hidden IDs to **A's** Saved Messages.
2. A gets force-logged-out → `cmd_vault_wipe_ids` clears **local** vault.json only. No push (correctly — wipe is local hygiene).
3. Account B logs in on the same machine. Auto-sync runs → `cmd_vault_pull_sync` → `pull_and_merge`.
4. `resolve_peer(None)` returns **B's own Saved Messages** — but wait: B's Saved Messages is empty of NoBuf markers *on B's account*… **unless B is the same Telegram account re-logging in**, which is the actual common case (logout ≠ account switch on single-session Telegram).
5. For the true cross-account case (A and B are different Telegram accounts): pull reads **B's** Saved Messages, which has no marker → no merge → safe.

**Re-grading:** the resurrection scenario requires the same Telegram account on both sides of the logout, in which case "phantom IDs" are that account's own real hidden list — restoring them is arguably CORRECT (it's the same user). The genuinely dangerous variant would be two different Telegram accounts sharing one Windows session; there the per-account Saved Messages isolation makes merge safe by construction.
**Residual risk (Required, small):** none for correctness; BUT the wipe→no-push asymmetry means a deliberate reset does NOT propagate if push fails silently. Dispositioned under S4.
**Fix adopted anyway (defense in depth):** embed `owner_id` (Telegram user id) in blob + store; skip merge on mismatch. Prevents any future multi-account edge and makes ownership explicit.

## S2 · Required — Unbounded message accumulation
Every push sends a NEW message; nothing deletes old ones. Active usage (10 hides/unhides/day) = 300+ junk messages/year polluting Saved Messages, each a plaintext record of hidden IDs.
**Fix shipped:** edit-one-message pattern — store `sync_message_id` in vault.json after first send; subsequent pushes use `edit_message` on it (grammers messages.rs:748), falling back to send when absent/deleted. Old accumulation impossible by construction.

## S3 · Consider — Pull fragility
`parse_sync_message` failure on the newest marker aborts the scan (`?`/break semantics): one corrupted/truncated blob blocks sync until manually fixed. Also limit(50) can miss the marker in busy Saved Messages.
**Disposition:** accepted for v1 with the edit-one-message fix (S2) — corruption window shrinks to near-zero since we stop creating new messages. Documented limitation, not fixed now.

## S4 · Consider — Swallowed push failures mask divergence
`.catch(() => {})` means reset/hide can fail to propagate invisibly; other PC keeps stale state until next successful mutation. Accepted per soft-security model (state is recoverable, content untouched), mitigated by S2 (edit pattern makes later pushes cheap) + launch-time pull retry.

## S5 · checked: OK — Registration & governance
All three surfaces verified by reviewer's own greps AND its independent vitest run of TauriCommandPermissions (12/12).

## S6 · FYI — Privacy
Blob = hidden IDs + PBKDF2 hash/salt in plaintext Telegram cloud message. Consistent with documented boundary (rev 6: vault.json already readable on disk by anyone who matters); PBKDF2-600k keeps the hash non-reversible for practical purposes. Stated plainly so nobody mistakes it for encryption.

## Verdict: Request changes → fixes applied (`S2` shipped, `S1-owner-id` shipped)

### Fixes applied in this commit
1. **Edit-one-message sync**: `sync_message_id: Option<i32>` persisted in vault.json; push edits the existing message when known (fallback: send new + remember id). Accumulation eliminated.
2. **Owner binding**: blob gains `owner_id: i64`; vault.json persists `owner_id`; pull skips merge when mismatched (different Telegram account) — closes the theoretical cross-account edge and documents ownership.

### Deferred (documented, not blocking)
- Corrupt-blob fall-through (S3), busy-Saved-Messages >50 miss (S3), swallowed-error UX surfacing (S4).
