---
name: implement-clean
description: Clean implementation — incremental changes, verification-first coding, and ship-ready patterns
user-invocable: true
---

## Clean Implementation Guide

Write code that works correctly, is easy to understand, and can be verified.

### Implementation Process

**Step 1: Understand before coding**
- Read the existing code you're modifying
- Understand the current patterns and conventions
- Identify what already exists that you can reuse
- Check memory files for past gotchas in this area

**Step 2: Plan the minimal change**
- What's the smallest change that achieves the goal?
- What files need to change?
- What could break?
- Define: how will I verify this works?

**Step 3: Implement incrementally**
- Make one logical change at a time
- After each change, verify it works (run, test, check)
- Commit checkpoints so you can revert if needed
- Don't refactor unrelated code while implementing a feature

**Step 4: Verify before declaring done**
- Actually run the code — don't assume it works
- Test the happy path
- Test edge cases (empty input, large input, error states)
- Check for regressions in related features
- Use the verification agent for non-trivial changes (3+ files)

**Step 5: Clean up**
- Remove debug logs, commented-out code, TODO comments you resolved
- Ensure no unused imports or variables
- Check naming is clear and consistent

### Code Quality Checklist

Before shipping:
- [ ] Does it work? (actually test it)
- [ ] Is it the simplest solution?
- [ ] Are error cases handled at boundaries?
- [ ] Are async operations gated on data availability?
- [ ] Did you use refs (not state) for sync checks in async loops?
- [ ] Did you guard empty array operations (every/some return true for [])?
- [ ] Would a new team member understand this code?

### Implementation Patterns

**Incremental feature build**:
```
1. Define the interface (types, function signatures)
2. Implement the core logic
3. Wire up to UI/API
4. Handle errors and edge cases
5. Polish (loading states, animations)
```

**When modifying existing code**:
```
1. Read the current implementation fully
2. Identify all callers/consumers
3. Make the minimal change
4. Verify all callers still work
5. Check for similar patterns elsewhere
```

### Anti-patterns to Avoid

| Anti-pattern | Problem | Do Instead |
|-------------|---------|------------|
| Big bang | Write everything, then test | Incremental changes with verification |
| Feature creep | "While I'm here, let me also..." | Separate commits for separate concerns |
| Premature abstraction | Create helper before 3rd use | Inline until pattern is clear |
| Defensive everything | Validate all internal state | Validate at boundaries only |
| Comment-driven code | Explain what, not why | Better naming, self-documenting code |
| Trust the AI output | Copy-paste without reading | Read, understand, then accept |

### Commit Strategy
- One logical change per commit
- Commit message: WHY, not WHAT
- Test before committing (not after)
- If a change is risky, make it on a branch

### When You're Stuck
1. Stop coding — you're in a loop
2. Launch a research agent to investigate
3. Simplify — what's the most minimal version that could work?
4. Check memory files for past solutions to similar problems
5. Ask the user for clarification if requirements are unclear
