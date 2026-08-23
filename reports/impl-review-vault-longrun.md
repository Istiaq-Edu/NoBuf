# Impl Review — Vault Long-Run & Bottlenecks (Adversarial)

- **Branch**: `feature/vault-hide-channels` @ b324cfc (post-merge)
- **Reviewer role**: Long-run / bottleneck adversary (fresh eyes)
- **Scope**: `app/src-tauri/src/commands/vault.rs`, `app/src/context/VaultContext.tsx`, `Dashboard.tsx` vault effects + hotkey listener lifecycle, `VaultView.tsx`, `VaultPasscodeModal.tsx`, sidebar drag listeners, growth bounds, dead-end UX journeys.
- **Method**: read-only code inspection; terminal rg/grep; estimates labeled as such.
- **Status**: IN PROGRESS — sections appended as verified.

Severity scale: **P0** ship-blocker · **P1** major · **P2** minor · **P3** nit · **checked: OK**

---

## 1. KDF starvation (pbkdf2 600k on async runtime)

PENDING

## 2. Listener lifecycle (Dashboard hotkey, SidebarItem drag, PublicChannelItem)

PENDING

## 3. Render churn (VaultContext value identity, bandwidth tick amplification)

PENDING

## 4. window.confirm in WebView2 vs ConfirmContext pattern

PENDING

## 5. State desync long-run (sleep/resume/reconnect, forceLogout→wipe_ids trace)

PENDING

## 6. Growth bounds (vault.json, query-cache lock/unlock loop, toast/history accumulation)

PENDING

## 7. Dead-end UX audit (a–d journeys)

PENDING

---

## Final Verdict

PENDING

## What I verified vs assumed

PENDING
