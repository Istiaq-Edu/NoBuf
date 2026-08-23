# Impl Review — Back-navigation Stack & Vault Cold-Entry UX (adversarial, fresh eyes)

- **Reviewer**: back-stack & vault UX subagent (did NOT write the code under review)
- **Commit**: `663dea5` (feature/vault-hide-channels), clean tree
- **Scope**: Dashboard.tsx view-history block + TopBar ArrowLeft; VaultView.tsx HiddenRow row-click + cold-entry creation mode; VaultViewStates.test.tsx
- **Method**: falsify-or-prove each claim with file:line; read-only except this report
- **Correction to brief**: project is React **^19.1.0** (`app/package.json:35`), not React 18 — batching semantics below use React ≥18 rules (identical for this analysis)

---

## 1. STALE-REF RACES — checked: OK (for real users); theoretical same-tick hazard unreachable

**Code**: `Dashboard.tsx:62-86`. `navigateTo` reads `activeViewRef.current` (L67); the mirror updates in a passive effect post-render (L64). `goBack` (L77-86) reads ONLY `pastViewsRef` — never the mirror.

**goBack twice fast**: refs mutate synchronously. Click 1 pops entry T1 (`L80-81`), click 2 — even before re-render — sees the already-shrunk array and pops T2. Correct target each time; `setCanGoBack` called twice within batching, final value correct. The stale mirror is irrelevant because `goBack` doesn't read it. ✅

**navigateTo immediately after goBack, same tick**: `prev = activeViewRef.current` would still be the PRE-goBack view V0, so if `next ≠ V0`, V0 gets pushed instead of the popped-to target T → next Back lands on V0 skipping T (wrong history entry). **However**, every current `navigateTo` call site originates from discrete DOM events (clicks), and React ≥18 flushes pending passive effects before dispatching the next discrete event. So by the time a second *real* event handler runs, the mirror is fresh. No programmatic goBack→navigateTo same-tick sequence exists in the codebase (grep: all navigateTo sites are JSX handlers — Dashboard.tsx:221,223,912,915,957,958). Likelihood for double-click users: negligible; single navs: zero exposure. ✅

**The one reachable duplication path** is same-tick double invocation from a *single* click — see Finding A (HiddenRow Open button bubbling).

## 2. BYPASS AUDIT — 1 misclassification + consistency gap

Complete enumeration of `setActiveView` in Dashboard.tsx (rg verified, 7 sites):

| Site | Form | Classification | Assessment |
|---|---|---|---|
| L56 initial `useState({type:'saved'})` | state init | n/a | ✅ nothing precedes it |
| L125 D14 hide-viewing jump | raw setter | bypass | ✅ defensible correction |
| L187 restore-gate reset | raw setter | bypass | ✅ correction before any nav |
| **L199 Ctrl+Shift+V hotkey** | **raw functional setter** | **bypass** | ⚠️ **Finding B** |
| L211 D3 entry-hidden effect | raw setter | bypass | ✅ forced exit, view destroyed |
| L683 removePublicChannel jump | raw setter | bypass | ✅ view target destroyed |
| **L1036 SettingsPage onOpenVault** | **raw setter** (+`setShowSettings(false)`) | **bypass** | ⚠️ **Finding C — misclassified** |

Wired `navigateTo` sites confirmed: handleSelectFolder L221/223, Sidebar onSelectPublicChannel L912, Sidebar onOpenVault L915, VaultView onOpenFolder L957, VaultView onOpenPublicChannel L958.

**Finding B (Low–Medium) — hotkey vault entry has no history entry.** `Dashboard.tsx:199` uses the raw functional setter. Journey: saved → folderA (`stack:[saved]`) → Ctrl+Shift+V → vault (nothing pushed) → Back pops **saved**, skipping folderA the user came from. With folderA→folderB→hotkey, Back lands on A — wrong-by-one vs "return to where I was". Note `navigateTo`'s own dedupe (L68-70: same type `'vault'` → no push) already provides the idempotence the functional guard at L199 hand-rolls; switching the hotkey to `navigateTo({type:'vault'})` is strictly better and one line. Real-world likelihood: high for keyboard users (hotkey is a first-class D11 entry point).

**Finding C (Low–Medium) — SettingsPage `onOpenVault` bypasses history.** `Dashboard.tsx:1036`: `onOpenVault={() => { setShowSettings(false); setActiveView({ type: 'vault' }); }}` — inconsistent with the identical Sidebar entry point (L915 uses `navigateTo`). Same consequence as B: Back skips the vault view entirely (or worse, if the stack holds older entries, Back jumps past both settings-era state and vault). If opening-vault-from-settings is judged "overlay dismissal, not navigation", it needs a comment saying so; today it just looks like the wired-site list was intended to include it and wasn't finished.

**D14 journey graded** (bypass as designed): saved → publicC (`stack:[saved]`) → hide C while viewing → raw jump to saved → Back pops saved → `setActiveView(saved)` on an already-saved view = **visible dead Back click** (button shown, nothing happens). Minor wart inherent to bypass-not-pop; grade Low. The dangerous variant of "Back after hiding" is Finding D below.

## 3. FOLDER-PAIR DESYNC — checked: OK (no NEW desync); pre-existing quirks noted

`goBack` (`Dashboard.tsx:83-84`): restores `folderId` for `{type:'folder'}`, nulls for non-public, skips for public — matching the comment. But the pre-existing sync-effect (`Dashboard.tsx:229-237`, introduced in `f1743bc` "sync activeFolderId when viewing public channels", **predates this branch**) assigns `activeFolderId = channelId` whenever `activeView.type === 'public'` renders. So after Back-to-public, `activeFolderId` is **not stale** — it becomes the channelId by design.

Consumer audit:
- Files query `Dashboard.tsx:318-326`: `queryKey:['files', activeFolderId]`, `enabled: !!store && !isPublicView && vault.ready` — disabled in public views ⇒ no stray fetch while viewing a channel. Upload gating `canUploadHere/isReadOnly` derives from `activeView.type` only (L281-303), never from `activeFolderId` ⇒ wrong-upload-target concern does not materialize via goBack.
- Residual pre-existing quirk (not introduced by this branch): navigating public → vault leaves `activeFolderId = channelId` with the nbFiles query now ENABLED (vault is neither public nor gated otherwise) ⇒ one stray `cmd_get_files(channelId)` invoke; likewise drag-drop accepts uploads while in Vault view targeting whatever `activeFolderId` lingers (`useFileUpload(activeFolderId, …)` L362, `canUploadHere=true` L303). Out of scope for this review; recommend a follow-up ticket.

## 4. STACK BOUNDEDNESS — checked: OK

Single push site `Dashboard.tsx:72` with inline `.slice(-50)`; single pop site L81; init L62. rg confirms no other writers. Dedupe check L68-74 prevents pushes when type+id unchanged (re-clicking the same sidebar item cannot grow the stack). Memory: ≤50 small objects; `canGoBack` boolean flips only (L73/L82). Trivial. ✅

## 5. ROW-CLICK SEMANTICS — Finding A (Low) + a11y Nit

**Finding A — Open button double-fires `onOpen` → duplicate history entry → dead Back click.** `VaultView.tsx:180-192`: row `<div onClick={onOpen}>` wraps a nested Open `<button onClick={onOpen}>` (L187-188). One click runs the button handler, the event bubbles to the div handler — both fire **synchronously in one task**, so `activeViewRef` hasn't flushed between them: `navigateTo` sees the same stale prev twice, `changed=true` twice, pushes the vault view **twice** (L72). Result stack `[vault, vault]`: first Back correctly returns to vault, second Back pops into vault again = no-op click with the button still visible. Unhide is protected (`e.stopPropagation()` at L194 — verified ✅); Open needs the same, or drop the div-level onClick. This is the only same-tick duplication reachable by a real user (§1).

**A11y (Nit)**: row is a plain `<div onClick>` — no `role`, no `tabIndex`, no `onKeyDown`; Enter/Space do nothing on the row itself and it's not in tab order (`VaultView.tsx:180-184`). Mitigated: the nested Open `<button>` is focusable and performs the identical action, so keyboard users aren't locked out. Project precedent is button-based rows — `SidebarItem.tsx:152-158` uses `<button draggable … onClick={onClick}>` as the whole row. Recommend aligning (row-as-button + stopPropagation'd nested controls), or at minimum `role="button" tabIndex={0}` + Enter/Space handling.

## 6. COLD-ENTRY MATRIX — checked: OK (literals exact; matrix coherent)

Test assertions vs render literals (`VaultView.tsx`):
- `'Create Vault passcode'` — test L89 ⇔ render L64 exact ✅
- `'Create & Unlock'` — test L90 ⇔ render L87 exact ✅
- Reset link absent in creation mode — test L92 ⇔ conditional render L89-96 ✅
- Bare `'Unlock'` node absent — test L95 custom matcher ⇔ single text node `'Create & Unlock'` ✅
- `'Vault is locked'` / `'Unlock'` / `/Forgot passcode\? Reset Vault/i` — test L108-110 ⇔ L64/L87/L94 exact ✅

Matrix enumeration (locked screen early-return `VaultView.tsx:29-100`):

| hasPasscode | totalCount | Heading | Subtitle | Coherent? |
|---|---|---|---|---|
| true | >0 | Vault is locked | "N hidden item/items" (L67) | ✅ |
| true | 0 | Vault is locked | "Nothing hidden yet" (L67) | ✅ (what test 2 renders) |
| false | 0 | Create Vault passcode | creation copy (L68) | ✅ tested |
| false | >0 | Create Vault passcode | creation copy | unreachable by design |

Cell 4 reachability: `hasPasscode` and `totalCount` come from ONE atomic `cmd_vault_get_state` payload (`VaultContext.tsx:104,203,207`), and hides are server-gated on passcode existence (D16), so counts>0 without passcode requires a backend invariant break. If it ever rendered, degradation is graceful: first-time set_passcode while locked still works (VaultView.tsx:39-43), and synced items appear after create+unlock. No third locked-screen state exists (the component early-returns before any unlocked content). **Nit**: neither test asserts the subtitle strings (L66-68) or placeholder (L74) — the matrix lock covers headings/buttons only.

## 7. TEST ROBUSTNESS — checked: OK for current suite; two latent nits

- `vi.hoisted` storage + mock factory reading `h.current` lazily at `useVault()` call time (`test:54-60`) — always current. ✅
- Order coupling: none today. `makeVault(false)` → `makeVault(true)` sequencing spreads `...h.current`, carrying Set **references** forward, but no test ever replaces or mutates `hiddenFolderIds`/`hiddenPublicIds` (both stay the empty hoisted Sets; `unhide`/`hide` mocks don't touch them). `afterEach(cleanup)` prevents DOM bleed across RTL renders (test:75-77). ✅
- Latent nit 1: `beforeEach` resets only `hasPasscode/isUnlocked/totalCount` (test:72-74). If a future test sets `h.current.hiddenFolderIds = new Set([...])`, it leaks into every later test via the spread. Cheap hardening: reset both Sets in `makeVault`/`beforeEach`.
- Latent nit 2: ConfirmContext is mocked twice under two specifier spellings that resolve to the same module (`'../context/ConfirmContext'` test:62 and `'../components/dashboard/../../context/ConfirmContext'` test:67) with identical bodies — dead weight; keep one.

## Additional finding

**Finding D (Medium) — goBack does not re-validate stack entries against vault visibility.** Stack entries outlive the visibility of the views they reference. Journey: open folder5 (`stack:[…, {type:'folder',folderId:5}]`) → navigate away → hide folder5 via sidebar context menu (not currently viewed ⇒ no D14 jump; hide succeeds silently) → press Back. `goBack` (`Dashboard.tsx:83-85`) blindly restores `folderId=5` + view; the restore-gate (L176-190) only guards mount-time restore (`restoredIdRef` is long-null), and the sync-effect happily follows. Result: FileExplorer renders a **hidden folder's contents**, orphaned from a sidebar that no longer lists it. Identical path resurrects hidden public channels (Back to `{type:'public',channelId:C}`) and removed channels (name falls back to "Public Channel", `Dashboard.tsx:690`). This matters because the back-stack feature *creates* the return path the rest of the branch works to close (restore-gate, D3, D14 all enforce "never land on a vaulted item"). User-self-inflicted and recoverable, hence Medium not High. Suggested fix: validate the popped target against `filterHidden`/`vault.hidden*Ids` in `goBack` and skip-to-saved when concealed.

---

## Verdict: **Request changes**

Small, well-scoped fixes: (A) `stopPropagation` on HiddenRow's Open button or drop the div-level onClick; (B/C) route the Ctrl+Shift+V hotkey and SettingsPage `onOpenVault` through `navigateTo`; (D) validate popped targets against vault visibility in `goBack`.

**What I verified** (file:line, read from working tree @ 663dea5): all 7 `setActiveView` call sites enumerated and classified; goBack/navigateTo ref semantics incl. React ≥19 discrete-event effect flushing; single push/pop paths for `pastViewsRef` with enforced `.slice(-50)`; files-query `enabled` condition and upload gating deriving from `activeView.type`; provenance of the activeFolderId sync-effect (`f1743bc`, pre-branch); HiddenRow DOM structure incl. verified `stopPropagation` on Unhide and its absence on Open; every asserted string matched byte-for-byte against VaultView.tsx literals; full VaultViewStates.test.tsx hoisting/reset/Set-sharing mechanics; SidebarItem button-row precedent.

**What I assumed** (not executed): runtime behavior claims about React's flush-passive-effects-before-discrete-events guarantee are based on documented React ≥18 scheduler semantics, not reproduced in a running app; cell 4 unreachability rests on the backend enforcing passcode-before-hide (spec D16) — I did not audit Rust-side enforcement; the stray `cmd_get_files(channelId)` in vault view was traced statically, not observed at runtime; no tests were run (read-only review).
