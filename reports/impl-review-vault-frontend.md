# Impl Review: Vault Frontend State (adversarial, fresh eyes)

Reviewer: frontend-state subagent (did NOT write this code). Post-merge, branch `feature/vault-hide-channels`.
Scope: `app/src/context/VaultContext.tsx`, `app/src/components/Dashboard.tsx` vault wiring, `app/src/hooks/useTelegramConnection.ts` prune block, `app/src/__tests__/VaultContext.test.ts`.
Method: falsify-or-prove each claim with file:line evidence. Severity: Critical / Required / Consider / Nit / FYI / checked: OK.

## Findings

### 1. Set identity churn (unmemoized context value)
PENDING

### 2. Effect dep correctness
PENDING

### 3. Restore gate false positive
PENDING

### 4. Double refresh on hide
PENDING

### 5. Cache nuke on lock
PENDING

### 6. Hide flow race
PENDING

### 7. Hotkey scope
PENDING

### 8. Test binding
PROVEN OK. `__tests__/VaultContext.test.ts:2` imports `{ filterHidden, isVaultedSelection, diffRemovedPublicIds, type VaultState }` from `../context/VaultContext`. All four are genuinely exported from shipped code: `filterHidden` VaultContext.tsx:49, `isVaultedSelection` :56, `diffRemovedPublicIds` :70, `interface VaultState` :6. Zero local re-declarations in the test file — every assertion exercises the shipped function objects.
- **Nit** (`VaultContext.test.ts:75-93, 129-148`): the last two describe blocks ("VaultState contract", "logout wipe contract") assert only locally-constructed data literals; they call no shipped code, so they cannot regress and provide no binding coverage. Harmless documentation-as-test, but a reader may wrongly credit them as executable contract checks.
- checked: OK (binding claim holds).

## Verdict
PENDING

## What I verified vs assumed
PENDING
