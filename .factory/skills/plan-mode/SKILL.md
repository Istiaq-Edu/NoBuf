---
name: plan-mode
description: Structured planning — architecture decisions, trade-off analysis, phased implementation with clear milestones
user-invocable: true
---

## Planning Mode

Transform requirements into actionable implementation plans with clear decisions and phases.

### Planning Process

**Phase 1: Understand**
- What is the goal? (user story, acceptance criteria)
- What already exists that's relevant?
- What are the constraints? (time, tech, dependencies)

**Phase 2: Explore options**
- List 2-3 viable approaches
- For each: pros, cons, effort, risk
- Which approach has the best effort/risk ratio?

**Phase 3: Design the solution**
- What components/modules are involved?
- How do they communicate? (API, events, state)
- What changes in existing code?

**Phase 4: Break into phases**
- Each phase should be independently valuable
- Each phase should be testable in isolation
- Order by: foundation first, then features, then polish

**Phase 5: Identify risks**
- What could go wrong at each phase?
- What's the fallback if approach X fails?
- What needs spike/prototype first?

### Decision Framework

For each significant decision, document:

```
### Decision: [What we're deciding]
- **Options**: A, B, C
- **Chosen**: B
- **Why**: [Concrete reasons]
- **Trade-off**: [What we give up by choosing B]
- **Reversible?**: Yes/No (how hard to change later)
```

### Plan Output Format
```
## Goal
[What we're building and why]

## Current State
[Relevant existing code/architecture]

## Decisions
### Decision 1: [Topic]
- Options: ...
- Chosen: ...
- Why: ...

## Implementation Phases

### Phase 1: [Name] (Foundation)
- What: [Specific changes]
- Files: [List of files to modify/create]
- Test: [How to verify it works]
- Depends on: [Nothing / Phase X]

### Phase 2: [Name] (Feature)
- ...

## Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| ... | High/Med/Low | ... |

## Out of Scope
- [Things we explicitly won't do]
```

### Planning Rules
- **No plan survives contact with reality** — Keep phases small and adaptable
- **Spike first** — If unsure about an approach, prototype it before committing
- **Explicit trade-offs** — Every decision has a cost; name it
- **Reversible decisions are cheap** — Don't overthink things you can easily change
- **Irreversible decisions deserve analysis** — Architecture choices, data model, external APIs
