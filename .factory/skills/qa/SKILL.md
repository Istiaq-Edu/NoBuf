---
name: qa
description: >
  Run QA tests for NoBuf. Analyzes git diff to determine affected areas,
  runs configured test flows with curl (REST API) and GUI (manual), and generates
  diff-targeted reports. REST API tests can run in CI; GUI flows require local desktop.
  Use when testing PRs, releases, or smoke testing environments.
---

# QA Orchestrator for NoBuf

**SCOPE: This skill performs manual/functional QA only — verifying that the application actually works by interacting with it as a real user would. Do NOT run or report on CI checks, linting, ESLint, typecheck, unit tests, or any static analysis. Those are handled by separate workflows.**

## Step 1: Load Configuration

Read `.factory/skills/qa/config.yaml` for environment URLs, credentials, personas, and app definitions.

## Step 2: Determine Target Environment

Use the `local` environment from config. This is a desktop app — the only environment is a local dev build.

**Running in CI vs Local:**
- **CI mode (env CI=true):** Only REST API tests can run (HTTP endpoints on port 8550). GUI tests are automatically skipped. The workflow must first start the app, enable the REST API, and configure an API key.
- **Local mode:** Full GUI testing is possible by launching the Tauri app. Use `npm run tauri dev` to start.

## Step 3: Analyze Git Diff

Run `git diff` to determine what changed. Map changed files to apps using the path_patterns in config.yaml.

For this project there is a single app (`app`) with two code areas:
- **Frontend** (`app/src/**`, `app/package.json`, `app/vite.config.ts`, etc.)
- **Backend** (`app/src-tauri/src/**`, `app/src-tauri/Cargo.toml`)

Files that don't match (e.g., `.factory/skills/**`, `docs/**`, `.github/**`, `README.md`, `CHANGELOG.md`) are NOT associated with any app. Do NOT run app test flows for them.

If NO app is affected by the diff, report as INCONCLUSIVE: "No app code changed — QA not applicable for this diff."

## Step 4: Pre-flight Checks

Run pre-flight checks ONLY if the app is affected by the diff.

**CI mode pre-flight checks:**
1. Verify REST API is reachable (health check: `curl http://localhost:8550/api/v1/health`)
2. Verify API key is configured (check env var `QA_API_KEY`)
3. If API is not reachable, report as BLOCKED with instructions

**Local mode pre-flight checks:**
1. Verify `npm run tauri dev` starts successfully
2. Verify the app window appears

If a pre-flight check fails, report it as BLOCKED with the specific error and remediation steps — but still proceed with other testable areas.

## Step 5: Execute Diff-Relevant Flows Only

For app code changes, read `.factory/skills/qa-app/SKILL.md`. It contains a MENU of available test flows.

1. Read the diff carefully and identify which flows are relevant
2. Run those flows PLUS any adjacent integration flows
3. Do NOT run completely unrelated flows
4. If no existing flow covers the change, write a NEW ad-hoc test
5. Do NOT run unit tests, lint, typecheck, or any automated test suite

**CI mode constraint:** In CI, only run flows marked as `ci: true`. These are REST API flows. GUI flows are marked `ci: false` and are skipped.

## Step 6: Evidence Capture

After each significant test step, capture evidence.

**For REST API tests (curl):**
- Capture the request and response as text evidence
- Embed the output directly in the report as fenced code blocks with descriptive labels

**For GUI tests (local only):**
- Take screenshots using the OS screenshot tool
- Describe what the user sees at each step

Evidence quality rules:
- Focus on the RELEVANT content
- Label each piece of evidence clearly
- NEVER embed broken image links

## Step 7: Test Quality Gate

TEST QUALITY REQUIREMENTS:
1. CHANGE-SPECIFIC FIRST. At least half your tests should be testing the new/changed feature.
2. INTEGRATION TESTS ARE VALID.
3. NO UNRELATED FLOWS.
4. NO AUTOMATED TEST SUITES.
5. NEGATIVE TESTS. Include at least 1 error-handling or boundary test.
6. INTERACTIVE TESTING. Test by actually interacting with the app.
7. INCONCLUSIVE IF UNSURE.

## Step 8: Handle Failures

**Never silently skip a flow.** If a flow cannot complete, report it as BLOCKED with what was tried and how the user can fix it. Then continue to the next flow — never abort the entire run for a single failure.

## Step 9: Generate Report

Generate the report at `./qa-results/report.md` using `.factory/skills/qa/REPORT-TEMPLATE.md`.

Key rules:
- Start with `## QA Report` heading followed by the test results table
- Result column MUST use emojis: :white_check_mark: PASS, :x: FAIL, :no_entry: BLOCKED, :warning: FLAKY, :grey_question: INCONCLUSIVE
- Keep it CONCISE
- Do NOT report setup steps as test rows
- Put ALL evidence in a single collapsed `<details>` block
- For curl evidence: embed output as labeled fenced code blocks

## Step 10: Suggest Skill Updates (Failure Learning)

After generating the report, check if any BLOCKED or FAIL results revealed a **testing environment insight** that would help future QA runs succeed.

**Good suggestions** (environment/workflow knowledge):
- "REST API requires enabling in Settings before testing — add pre-flight check"
- "The dev server port changed from X to Y"
- "A new API endpoint was added without documentation"

**Bad suggestions** (skill bugs, not environment insights — do NOT suggest these):
- "Selector doesn't exist" — that's a skill bug
- "Button text changed" — that's expected from the PR diff

Format as a table with severity levels and collapsible fix prompts. Only include if genuinely new insights were discovered.

Do NOT suggest updates for failures already covered in Known Failure Modes.
