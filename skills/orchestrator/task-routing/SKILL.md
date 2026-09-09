---
name: task-routing
description: Decision rules for assigning tasks to the correct agent type.
---

# Task Routing

## Routing Decision Tree

Evaluate in sequence. Stop at the first YES.

```
Q1: Does the user explicitly name an agent type?
  → YES: Route to that type. User intent is definitive.
  → NO:  Proceed.

Q2: Does the task require finding or synthesizing information
    not in your context? (exploring code, locating files,
    understanding unfamiliar systems, reviewing dependencies)
  → YES: Route to RESEARCHER
  → NO:  Proceed.
  Do not route to Researcher when the information is already in your context.
  Do not read source files yourself to "quickly check" — dispatch a Researcher.

Q3: Does the task require evaluating existing work against
    quality, correctness, or standards?
  → YES: Route to REVIEWER
  → NO:  Proceed.
  Do not route to Reviewer when there is nothing concrete to review yet.

Q4: Is the task ambiguous, large, or in need of decomposition
    before execution? (includes architectural decisions)
  → YES: Route to PLANNER
  → NO:  Proceed.
  Do not route to Planner when the task is already clearly specified — go straight to Implementer.
  Do not route to Implementer for complex architectural decisions — Planner first.

Q5: Is the task for entertainment, morale, or creative breakthrough?
  → YES: Route to MASCOT
  → NO:  Proceed.

Q6: Does the task require writing or modifying code
    based on clear specifications?
  → YES: Route to IMPLEMENTER (single generic type)
  → NO:  Proceed.

Q7: Does the task require verifying behavior, writing tests,
    or hunting edge cases?
  → YES: Route to TESTER
  → NO:  Handle directly.
  Do not route to Tester before the code exists — Implementer first.
```

**Handle directly:** synthesizing subagent outputs, status checks and context lookups, trivial one-line changes, greetings and conversation, journal operations, questions answerable from your own context.

---

## Priority Summary

| Priority | Agent | Trigger |
|----------|-------|---------|
| 1 | User-named type | Explicit agent request |
| 2 | Researcher | Information needed outside context |
| 3 | Reviewer | Evaluation against standards |
| 4 | Planner | Ambiguity, scale, architectural decisions |
| 5 | Mascot | Entertainment / creative breakthrough |
| 6 | Implementer | Code with clear specs |
| 7 | Tester | Behavior verification / test writing |

---

## Tiebreakers

1. **Explicit user signal overrides all** — profession-specific verbs ("review", "test", "find", "plan") are definitive.
2. **Specificity wins** — the rule with the most conceptual overlap takes priority.
3. **Pipeline order breaks remaining ties** — Researcher > Reviewer > Planner > Implementer > Tester > Mascot.
4. **If still tied** — the task is multi-type. Decompose and dispatch each subtask separately.

---

## Multi-Agent Orchestration Patterns

| Pattern | When | Flow |
|---------|------|------|
| Research → Implement | Learn then build | Researcher → Implementer → Reviewer |
| Locate → Implement → Verify | Modifying unfamiliar code | Researcher → Implementer → Tester |
| Plan → Build → Test | Large feature with no clear path | Planner → Implementer → Tester → Reviewer |
| Parallel independent subtasks | Multiple unrelated subtasks in one request | Parallel dispatch → orchestrator combines results |
| Parallel review + test | Completed code needs both verifications | Reviewer + Tester in parallel → orchestrator reconciles |

---

## Examples

- "Find the best Go rate-limiting library, then implement middleware" → Researcher → Implementer → Reviewer
- "We need a notification system" → Planner → Implementer → Tester → Reviewer
- "What did we work on last session?" → Handle directly (in your own journals)