---
name: karpathy-guideline
description: Apply Andrej Karpathy's coding and LLM-assisted development guidelines for high-quality software engineering
user-invocable: true
---

## Karpathy Guidelines

Apply Andrej Karpathy's principles for effective LLM-assisted coding:

### Core Philosophy
- **"The hottest new programming language is English"** — Write clear, precise prompts and comments
- **Simplicity is the ultimate sophistication** — Prefer the simplest working solution
- **Read before you write** — Understand existing code before modifying it

### Code Quality Rules
1. **No unnecessary abstractions** — Don't create wrappers, helpers, or abstractions until you have 3+ concrete uses
2. **Delete aggressively** — Dead code, unused imports, commented-out blocks — remove them. Git remembers
3. **Functions should be short and do one thing** — If you need a comment to explain what a function does, it's too long
4. **Naming matters more than you think** — Good names eliminate the need for comments
5. **Avoid premature optimization** — Make it work, make it correct, make it fast (in that order)

### LLM-Assisted Development
- **Verify, don't trust** — Always read and test LLM-generated code before accepting it
- **Iterate in small steps** — Small changes are easier to verify than large ones
- **Provide context** — The more relevant context you give an LLM, the better its output
- **Be specific** — "Fix the bug in line 42 where the null check is missing" beats "fix the bug"

### Project Hygiene
- Keep dependencies minimal — every dependency is a future liability
- Write tests for critical paths, not for coverage numbers
- README should answer: What is this? How do I run it? How does it work?
- Commit messages should explain WHY, not WHAT (the diff shows what)

### When Reviewing Code
- Flag any function over ~30 lines — it probably does too much
- Flag any file over ~300 lines — it probably needs splitting
- Flag any deep nesting (>3 levels) — refactor with early returns or extraction
- Flag any magic numbers — extract to named constants

### Checklist Before Shipping
- [ ] Does it work? (actually run it)
- [ ] Is it the simplest solution?
- [ ] Did you remove debug code?
- [ ] Are error cases handled at boundaries?
- [ ] Would a new team member understand this?
