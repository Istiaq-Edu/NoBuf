---
name: systemmatic-debug
description: Systematic debugging — root cause analysis, hypothesis-driven investigation, binary search isolation, and verification
user-invocable: true
---

## Systematic Debugging

Fix bugs methodically instead of guessing. Every bug has a cause — find it before fixing it.

### The Debug Process

**Step 1: Reproduce**
- Can you trigger the bug reliably? If not, find the trigger
- What are the exact steps?
- What's the expected vs actual behavior?
- Capture the error message, stack trace, or symptom

**Step 2: Gather evidence**
- Read the error message carefully — it usually tells you what's wrong
- Check the logs (browser console, Rust stdout, network tab)
- What changed recently? (git log, recent commits)
- Does it happen always, sometimes, or under specific conditions?

**Step 3: Form hypotheses**
- List possible causes (aim for 2-3)
- Order by likelihood
- For each: "If this is the cause, what else would be true?"

**Step 4: Test hypotheses**
- **Binary search**: Comment out half the code — does bug persist? Narrow down
- **Minimal reproduction**: Strip away everything until the bug disappears, then add back
- **Isolate variables**: Change one thing at a time
- **Add logging**: Insert strategic logs to see actual values at runtime

**Step 5: Verify root cause**
- You found the cause when: removing it fixes the bug AND adding it back reproduces it
- Don't stop at correlation — prove causation

**Step 6: Fix and verify**
- Write the minimal fix that addresses root cause
- Verify the original bug is gone
- Verify you didn't break anything else
- Check for similar bugs in related code

### Debug Techniques

**Binary search isolation**:
```
Does bug exist with entire feature? YES
Comment out half → still YES
Comment out half again → NO
Bug is in the commented-out half → narrow further
```

**Rubber duck**: Explain the problem out loud (or to an agent). The act of explaining often reveals the answer.

**Working backwards**: Start from the error/symptom and trace back to the cause.

**Bisection**: Use `git bisect` to find which commit introduced the bug.

### Common Bug Categories

| Category | Symptoms | First Check |
|----------|----------|-------------|
| **Async race** | Intermittent, timing-dependent | State updates in callbacks, useEffect cleanup |
| **Type mismatch** | "undefined is not a function" | API response shape vs expected type |
| **State stale** | Old value in closure | useRef for sync checks, dependency array |
| **Memory leak** | Slow over time | Missing cleanup, event listener leak |
| **Null/undefined** | Cannot read property X | Missing optional chaining, default values |
| **Off-by-one** | Wrong count, missing item | Array bounds, <= vs < |

### Debug Output Format
```
## Symptom
[What's happening, error message]

## Evidence
- [Log output, observed behavior]
- [What works, what doesn't]

## Hypotheses
1. [Most likely cause] — Test: [how to verify]
2. [Alternative cause] — Test: [how to verify]

## Root Cause
[Confirmed cause with evidence]

## Fix
[Minimal change that fixes it]

## Verification
- [ ] Bug is gone
- [ ] No regressions
- [ ] Similar bugs checked
```

### Rules
- **Never fix what you don't understand** — A fix without understanding root cause is a time bomb
- **One change at a time** — If you change 3 things and the bug disappears, which change fixed it?
- **Read the error** — 80% of bugs tell you exactly what's wrong in the error message
- **Check the obvious first** — Typos, wrong variable, missing import, stale build
