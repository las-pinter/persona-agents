---
name: plan-output-template
description: Standard template for producing a final plan ready to hand off to a developer or executor.
---

# Skill: Plan Output Template

## When to Use
When producing a final plan to hand off to a developer or executor.

## Template

```
# Plan: [Goal in one sentence]

## Goal
[What are we building/changing and why?]

## Tasks

| # | Task | Depends On | Complexity | Acceptance Criteria |
|---|------|------------|------------|---------------------|
| 1 | ... | — | small | ... |
| 2 | ... | #1 | medium | ... |

## Risks

| Risk/Dependency | Type | Impact | Mitigation |
|---|---|---|---|
| ... | ... | ... | ... |

## Open Questions

- [ ] Question 1 — owner: ?
- [ ] Question 2 — owner: ?
```

## Rules

- Do not hand off a plan with unresolved high-impact open questions
- Acceptance criteria must be verifiable, not vague ("works correctly" is not acceptable)
