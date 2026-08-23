# Impl Review — vault × dev upload-drop MERGE-SEAM & INTERACTION (adversarial)

- **Reviewer:** fresh-eyes subagent (wrote neither side)
- **Scope:** merge commit `b324cfc` ("merge: origin/dev into feature/vault-hide-channels") on `feature/vault-hide-channels`; dev side = 31-commit drag-drop overhaul (stream-direct uploads, `/upload-drop` actix routes, sequential queue, zombie-retry purge, QR 2FA).
- **Method:** read-only audit + `rg`/grep; findings appended live. Severity labels; `checked: OK` where a suspicion was tested and did NOT hold.
- **Status:** IN PROGRESS — skeleton written before any verification; sections fill in below.

## Checklist

1. [x] Drop handler ordering post-merge — **PASS**
2. [x] Upload availability probes (/upload-drop HEAD/POST param surface) — **PASS** (+1 INFO note)
3. [x] Registration completeness — **PASS**
4. [x] Search filter survival in fs.rs — **PASS** (grep + cargo test)
5. [x] Sequential queue × vault toast — **PASS**, no shared state
6. [x] Zombie-retry purge × vault — **PASS**, in-flight assumption intact

## 1. Drop handler ordering post-merge

**Merge mechanics.** HEAD `b324cfc` = merge(vault-tip `b429f8a`, dev-tip `b43f457`). Six files differ from BOTH parents (hand-resolved): `build.rs`, `capabilities/default.json`, `commands/fs.rs`, `commands/mod.rs`, `lib.rs`, `Dashboard.tsx`. For Dashboard.tsx, `git diff b429f8a..b324cfc` shows exactly dev's +8 lines (`cancelledStagingRef` init @262-264 area, suppression check @662-665, cancel hook @965); the entire document-level drag/drop effect is byte-identical to the pre-merge vault version (verified by sed-extracting `b429f8a:Dashboard.tsx` lines 700-720 vs merged 707-717).

**Merged state of the rejection path** (all `app/src/components/Dashboard.tsx`):
- Capture listeners registered once at mount, deps `[]`: `dragover/dragleave/drop` with `true` — lines **742-744**. Dev added NO listener registrations to Dashboard.tsx; repo-wide `rg "addEventListener\('(drop|dragover|dragleave|dragenter)"` finds only 3 sites total (Dashboard 742-744, FastStreamPlayer 1624-1625, SidebarItem 92-94) — none new in this merge.
- External-file discriminator `isExternal` (types has `Files`, lacks both internal MIMEs): lines **677-681**.
- Drop handler order inside `onDrop`: `preventDefault()`+`stopPropagation()` (707-708) → **vault hit-test** `(e.target)?.closest('[data-vault-dropzone]')` → `toast.error('Only channels can be hidden')` + `return` (**713-717**) → connected/canUp guards (731-738) → folder detect (722-729) → `stage(...)` (**740**). Rejection sits BEFORE any staging work, exactly as pre-merge.

**Competing capture listeners — could any preempt?**
- `SidebarItem.tsx:92-94`: capture `drop` exists only while `isOver===true` (guard line 82), and folder items deliberately never set `isOver` for external Files drags (`isExternalFilesDrag` exclusion, lines 140-143, 178). Even if armed, its `clear` only calls `setIsOver(false)` — no preventDefault/stopPropagation. Harmless. **checked: OK**
- `FastStreamPlayer.tsx:1624-1625` (pre-existing, untouched by this merge): `prevent` calls `e.preventDefault()` only — never stopPropagation/stopImmediatePropagation — so it cannot swallow or reorder Dashboard's handler; listeners on the same node/phase all run. Its own React `onDrop`s are internal chip-drags guarded by `dragKind === 'chip'`. **checked: OK**

**Literal event-path walk — external FILE dropped exactly on the vault sidebar item:**
1. `dragover` capture (Dashboard) marks overlay active, sets copy/none effect (682-688).
2. On release, document-capture `drop` runs BEFORE any target/bubble-phase React synthetic handler (synthetic events are bubble-phase; capture precedes them regardless of registration time).
3. `isExternal` true → 707-708 kill default + propagation → 713 hit-test: `e.target` is a descendant of the SidebarItem `<button>` carrying `data-vault-dropzone` (set whenever `onVaultDropFolder` is passed — `SidebarItem.tsx:157`) → match → **user sees `Only channels can be hidden`** → return.
4. Nothing reaches `dropCtxRef.current.stage`; therefore nothing enters dev's sequential gate / stream-direct queue. `rg "dataTransfer.files|webkitGetAsEntry"` confirms Dashboard.tsx:730 is the ONLY production consumer of dropped OS files — there is no second ingestion path for `Files` drops anywhere in `app/src`.

**Verdict on item 1:** merge did not alter registration order, added no capture listeners, no earlier-return bypasses the vault rejection; the rejected drop cannot stage or upload via any dev-added path.

## 2. Upload availability probes & route param surface

**Route registrations** (`app/src-tauri/src/server.rs`, configure block):
- `/upload-drop` registered **method-agnostically** via `web::to(...)` — server.rs:**7832-7838**; unconditional (OnceLock deps, upload_drop.rs:19-42).
- `/__whoami` — server.rs:**7817-7826**.

**Parameter enumeration, per route:**

| Route | Params | Auth | Behavior |
|---|---|---|---|
| `ANY /upload-drop` | query: `token` (upload_drop.rs:121-127), `name` (:129-132, non-empty), `size` (:133-139, `0 < s ≤ 4_294_967_295`), optional `display_name` (:140), optional `folder_id: Option<i64>` (:141), optional `tid` (:142); body = raw file bytes | `token` must equal `StreamTokenData.token`, else **401** | non-POST → **405** (:116-118). Ingest-only: streams body → grammers `upload_stream` → `send_message` to peer from `folder_id` (:217-256). Integrity gate :242-246; bandwidth cap :144-149 |
| `ANY /__whoami` | none | **none** | returns `"pid={std::process::id()} boot={unix_secs}"` — loopback identity probe for impostor-process detection |
| `cmd_probe_upload_route(port: u16)` — Tauri cmd (streaming.rs:**607-627**) | single `port` | n/a (in-process) | Rust HEADs its own `http://127.0.0.1:{port}/upload-drop` + GETs `/__whoami`, returns status text + caller PID |

**Could any probe/upload endpoint SERVE or LIST vaulted folder content by id outside the GUI?**
- `/upload-drop`: direction is strictly client→Telegram. Zero read/list paths — it cannot enumerate, fetch, or stream back anything. `checked: OK`
- `/__whoami`: constant PID/boot string; no ids, no storage access. `checked: OK`
- `cmd_probe_upload_route`: takes a port number, performs two loopback probes, returns status text. No id/folder/token parameter exists. `checked: OK`

**Informational note (boundary-class, matches prior REST-API finding):** `/upload-drop` resolves ANY `folder_id` through `resolve_peer` (upload_drop.rs:247-249) with no hidden/vault filter — so a local process holding the session token could POST bytes INTO a vault-hidden channel by numeric id. This is ingest (write), not serving/listing, and is the same trust class as the pre-existing `cmd_upload_file(folder_id)` Tauri surface behind the same loopback+token boundary; the vault feature is GUI concealment, not an ACL. Not introduced by the merge; recorded for completeness. Severity: INFO.

## 3. Registration completeness

**The 11 vault commands** (`commands/vault.rs`: get_state @299, hide @305, unhide @340, verify @358, set_passcode @372, change_passcode @394, lock @407, reset @414, wipe_ids @436, prune @448, set_entry_visible @465):

| Surface | Evidence | Result |
|---|---|---|
| `build.rs` AppManifest list | lines **90-100**, contiguous block | all 11 present ✓ |
| `capabilities/default.json` permissions | 11 × `allow-cmd-vault-*`; matching autogenerated permission TOMLs exist for all 11 (`permissions/autogenerated/cmd_vault_*.toml`) | all 11 present ✓ |
| `lib.rs` `generate_handler![...]` | lines **552-562**, `commands::cmd_vault_*` | all 11 registered ✓ |

**Displacement/duplication check (mechanical set-diff, both directions):**
- `build.rs` extracts **96** `cmd_*` entries; `lib.rs` handler list extracts **96**; sets are **identical** — zero missing either way, zero duplicates on either side.
- Dev's merge delta to these files was exactly **+1 line each**: `"cmd_probe_upload_route"` into build.rs (~line 40) and `"allow-cmd-probe-upload-route"` into default.json (~line 29); `cmd_probe_upload_route` also at lib.rs:**508**. No vault entry moved, renamed, or vanished.
- Pre-existing hygiene note (NOT merge-introduced): `"allow-cmd-open-telegram-auth"` appears twice in default.json — verified identical duplication exists in both parents `b429f8a` and `b43f457`. Severity: INFO/trivial.

**Verdict on item 3:** checked: OK — 11/11 in all three surfaces; dev additions additive only.

## 4. Search filter survival in fs.rs (hand-merged file)

**Direct grep of merged `app/src-tauri/src/commands/fs.rs`:**
- Vault import: line **10** — `use crate::commands::vault;`
- `hidden_ids_if_locked` call: line **1511** — `let hidden = vault::hidden_ids_if_locked(&app, vault::is_unlocked_public(&app));`
- Guard #1: line **1546**, Guard #2: line **1576** — both `if !vault::search_result_keeps(&hidden, folder_id) {`

**Cargo test evidence (actually executed on the merged tree):** `cargo test --lib vault::` → **15 passed; 0 failed; finished in 12.11s**, including:
- `commands::vault::tests::search_call_site_wraps_both_push_sites_in_fs_source ... ok` — this test (`vault.rs:642-651`) embeds fs.rs at COMPILE time via `include_str!("fs.rs")` and asserts `src.matches("if !vault::search_result_keeps(&hidden, folder_id) {").count() == 2`. Because it reads the merged bytes, a passing run is direct proof the merge did not lose either guard.
- Also green: `wipe_ids_command_body_does_not_touch_passcode_fields`, `reset_is_still_allowed_to_clear_passcode`, `hide_unhide_idempotent_and_cross_kind_isolated`, etc.

**What dev actually changed in fs.rs** (diff `b429f8a..b324cfc`): doc-comment lines above `cmd_stage_dropped_file` (@325) and `fn effective_document_name` → `pub fn` (@455-458, needed by upload_drop.rs:214). Both edits are ~1150+ lines away from the search section (1500s). No interaction. **checked: OK**

## 5. Sequential queue × vault toast — shared-state trace

**The two paths:**
- *Drop-upload path:* document capture drop (Dashboard.tsx:740) → `stageAndQueue` (useFileUpload.ts:**340-381**) → `streamDroppedFiles` (useDropStreamUpload.ts:64-191) → module-level gate: `MAX_PARALLEL_DROPS=1`, `activeDrops`, `pendingDrops[]`, `cancelledBeforeStart`, `liveDrops`, `activeXhrs` (useDropStreamUpload.ts:200-303). Rows update via `nobuf-drop-done` matched by **exact id** (useFileUpload.ts:126 `i.id === id`).
- *Vault path:* SidebarItem internal reorder-MIME drop (SidebarItem.tsx:211-214) → Sidebar.tsx:**268-269** → `handleHideInVault` (Dashboard.tsx:**76-98**) → `vault.hide()` invoke + `toast.success('Hidden in Vault')`.

**Shared mutable refs examined:**
- `dropCtxRef` — written ONLY by the render mirror (Dashboard.tsx:653-658); read only by external-file drop handling. Vault path never touches it. `checked: OK`
- `stagingItems` / `cancelledStagingRef` — staging rows exist ONLY on the legacy fallback path (`stageDroppedFiles`); stream-direct never calls `updateStagingProgress`. Vault path never writes them. `checked: OK`
- `uploadQueue`/`queueMirrorRef` — vault hide performs no queue read/write/filter (grep of handleHideInVault body + VaultContext.tsx for queue/cancel/upload: zero hits). `checked: OK`
- Gate state (`pendingDrops` etc.) — module-scoped to useDropStreamUpload; entry points are `enqueueStart`/`cancelDropStream`/`retryDropStream`, called only from stageAndQueue/cancelAll/cancelItem/retryItem. None reachable from any vault handler. `checked: OK`

**Scenario walk (files dropped on current folder, then channel dragged onto vault item):** the channel drag carries FOLDER_REORDER_MIME → Dashboard capture handler's `isExternal` is false → returns at :705 without touching anything; SidebarItem handles it synchronously. The in-flight FIFO uploads keep their `folderId` captured at enqueue time (baked into each QueueItem at useFileUpload.ts:357 → useDropStreamUpload.ts:183), so even if the hidden channel was being VIEWED (view flips to Saved Messages per D14, Dashboard.tsx:92-95), queued/in-flight items are NOT re-targeted or cancelled. Worst-case "misattribution" is two independent sonner toasts appearing near-simultaneously — cosmetic, not state corruption.

**Verdict on item 5:** no shared queue/state between paths; no misattribution possible. checked: OK

## 6. Zombie-retry purge × vault

**What dev's purge actually is** (commit `3b035f3`, P1): inside `retryDropStream` only (useDropStreamUpload.ts:**315-325**) — before re-enqueueing, it splices EVERY stale occurrence of that item's OWN id out of `pendingDrops` and deletes its `cancelledBeforeStart` marker. Strict `=== item.id` equality; it cannot purge another transfer's gate entry. Sole caller: `retryItem` (useFileUpload.ts:327). It keys on drop-stream row ids (`drop-*`), not staging rows or folder visibility.

**Does hiding a channel cancel its transfers?**
- Server-side cancellation set `cancelled_transfers` has exactly ONE writer: `cmd_cancel_transfer` (fs.rs:**290** insert; upload_drop.rs:201/230 and fs.rs:548/563/714 are self-removals). NO vault command appears among writers. `/upload-drop` consults only this set (upload_drop.rs:200, 228) → a hidden-folder in-flight upload runs to completion. **Spec assumption intact.**
- `cmd_vault_hide` body (vault.rs:**305-338**): acquires VaultLock, pushes id into store lists, saves. Zero transfer/queue/event side effects that could filter queues.
- Frontend cancellation paths: `cancelDropStream` invoked ONLY from `cancelAll` (useFileUpload.ts:282-283) and `cancelItem` (:302) — both explicit user actions. Grep found no UI-invisibility-triggered cancellation anywhere (no listener reacts to vault state by pruning uploadQueue; persistence keeps all `pending` rows regardless of folder visibility). **checked: OK**
- No purge keyed on "folder became invisible" exists — the purge is id-scoped retry hygiene, orthogonal to vault.

**Verdict on item 6:** dev's changes preserve the in-flight-transfers-keep-running assumption; no new cancellation path triggered by UI invisibility. checked: OK

---

## Verdict: **Approve**

Zero blocking findings across all six adversarial probes. Two informational notes, neither introduced as a defect by the merge:
1. (INFO) `/upload-drop` accepts arbitrary `folder_id` with no hidden/vault filter behind loopback+session-token auth — same trust class as pre-existing `cmd_upload_file`; vault is GUI concealment, not an ACL.
2. (INFO/trivial) Duplicate `"allow-cmd-open-telegram-auth"` permission in capabilities/default.json — verified present identically in BOTH parents; pre-existing, untouched by merge.

### What I verified vs assumed
**Verified with tool output:** merge parentage & hand-resolved file set (`git diff-tree --cc`); byte-level comparison of the merged drop-handler block vs pre-merge vault tip; repo-wide enumeration of ALL drag/drop listeners (3 sites) and ALL `dataTransfer.files` consumers (1 site); full param surface of `/upload-drop`, `/__whoami`, `cmd_probe_upload_route` read line-by-line; mechanical set-diff build.rs(96) ↔ lib.rs(96) ↔ default.json incl. dupe detection against both parents; direct grep + actual `cargo test --lib vault::` run (15/15 pass) on the merged tree; full source read of the sequential gate, cancel/retry wiring, `cmd_vault_hide`, and every writer of `cancelled_transfers`.
**Assumed (stated explicitly):** I did not runtime-exercise drag-drop in the webview or send real HTTP traffic to `/upload-drop` (static analysis + tests only); I assumed WebView2 delivers OS drops as described in the code comments (consistent across both sides' docs and tests); I did not audit the QR-2FA/auth.rs changes beyond registration parity (out of mandate).
