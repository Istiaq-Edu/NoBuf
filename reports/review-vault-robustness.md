# Vault Design Spec — Robustness & Implementability Review

**Spec under review:** `docs/specs/2026-08-22-vault-design.md` (132 lines)
**Reviewer:** adversarial fresh-eyes subagent (did not author spec)
**Date:** 2026-08-22 · Branch `feature/vault-hide-channels`
**Method:** every claim checked against repo source; file:line evidence throughout.

---

## Findings

### 1. ATOMICITY — temp+rename claim vs `api_settings.rs` reality
STATUS: PENDING

### 2. DEP FOOTPRINT — pbkdf2/hex/subtle vs existing-deps KDF
STATUS: PENDING

### 3. SERDE EVOLUTION — old vault.json loads after app update?
STATUS: PENDING

### 4. COMMAND SURFACE BLOAT — 10 commands vs leaner set
STATUS: PENDING

### 5. ERROR TAXONOMY — string errors vs existing typed-error pattern
STATUS: PENDING

### 6. TEST HOOKS — headless unit tests under `--no-default-features`
STATUS: PENDING

### 7. i64 ID SPACES — folder ids vs public channel ids collision/confusion
STATUS: PENDING

---

## Verdict
PENDING

## What I verified vs assumed
PENDING
