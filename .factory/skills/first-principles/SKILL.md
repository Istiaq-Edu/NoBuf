---
name: first-principles
description: First principles thinking — decompose problems, challenge assumptions, reason from fundamentals before jumping to solutions
user-invocable: true
---

## First Principles Thinking

Break down complex problems to their fundamental truths before building solutions.

### The Process

**Step 1: Define the real problem**
- What exactly are we trying to achieve?
- Who benefits and what do they actually need?
- What does success look like? (measurable)

**Step 2: Challenge every assumption**
- List all assumptions you're making
- For each: "Is this actually true? What evidence do I have?"
- Which assumptions, if wrong, completely change the approach?

**Step 3: Decompose to fundamentals**
- Break the problem into atomic sub-problems
- What are the irreducible constraints? (physics, API limits, user expectations)
- What is variable vs what is fixed?

**Step 4: Build up from truths**
- Start from the verified fundamentals
- Combine solutions bottom-up
- Reject solutions that require assumptions to be true

**Step 5: Stress-test the solution**
- What's the simplest version that works?
- What breaks it? (edge cases, scale, failure modes)
- What's the minimum I need to prove this works?

### Thinking Tools

**Inversion**: Instead of "how do I succeed?", ask "how would I guarantee failure?" then avoid those things.

**Second-order thinking**: "And then what?" — Solve X, then Y happens, which causes Z. Is Z acceptable?

**Occam's Razor**: When two solutions explain the data equally well, prefer the simpler one.

**Steel-manning**: Argue the strongest case against your solution before committing to it.

### When to Use This Skill
- Starting a new feature with unclear requirements
- Choosing between architectural approaches
- Stuck on a problem and all obvious solutions failed
- Before writing any code on a complex task

### Output Format
```
## Problem Statement
[Clear, measurable goal]

## Assumptions
1. [Assumption] — Verified? Yes/No/Unknown
2. ...

## Fundamental Constraints
- [Things that cannot change]

## Approach
[Solution built from fundamentals]

## Risks
- [What could go wrong]

## Simplest Proof
[Minimum viable way to validate]
```
