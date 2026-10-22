---
name: task-routing
description: Decision rules for assigning tasks to the correct agent type.
---

# Task Routing

## Routing Decision Tree

This tree is the single authority for every dispatch. Evaluate in sequence.
Stop at the first YES.

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

Q5: Does the task require writing or modifying code
    based on clear specifications?
  → YES: Route to IMPLEMENTER (single generic type; the language specialists are retired)
  → NO:  Proceed.
  Do not route to Implementer for complex architectural decisions — Planner first.

Q6: Does the task require verifying behavior, writing tests,
    or hunting edge cases?
  → YES: Route to TESTER
  → NO:  Proceed.
  Do not route to Tester before the code exists — Implementer first.

Q7: Is the task for entertainment, morale, or creative breakthrough?
  → YES: Route to MASCOT (lowest dispatch priority)
  → NO:  Handle directly.
```

**Handle directly (orchestrator direct duties):** reads of your own notes,
journals, skills, and persona; git reads; journal and note writes; status and
synthesis; trivial one-line edits; greetings and conversation; questions
answerable from your own context.

---

## Tiebreakers (exact ties only)

The tree decides every dispatch. Use a tiebreaker only when one task matches
two branches equally and the tree order does not resolve the tie.

1. **Specificity wins** — the branch with the most conceptual overlap.
2. **Pipeline order breaks the remaining tie** — Researcher > Reviewer >
   Planner > Implementer > Tester > Mascot.
3. **Still tied** — the task is multi-type. Decompose it and dispatch each
   part separately.

---

## Parallelization

Dispatch in parallel ONLY independent read-only research tasks (researchers).
Never run two implementers at the same time. Never run the reviewer and the
tester at the same time — run them one after the other.

---

## Dispatch Brief

- Name the reference source line in every implementer brief before the first draft.
- Quote that exact line in the brief, within the metacharacter limit below.
- Require absolute paths and `git -C` in every code-touching brief.
- Forbid `cd` into the repo in every code-touching brief.
- Before dispatch, check the brief and every command in it for shell metacharacters.
  On pi, the gate denies a greater-than sign that writes a file; other engines
  may ask. The gate denies a heredoc, which is a doubled less-than sign. A
  dollar sign can fail closed as an unresolved expansion. A backtick and a
  parenthesized process form run an inner command; the gate checks that command
  as its own segment. A tilde and a single less-than sign are literal and
  trigger no guard. Do not quote an exact line that carries one of these
  characters. Give the file name, the line number, and a plain-word description
  of the entry instead.

---

## Examples

The patterns below are examples. They do not change the tree.

| Pattern | When | Flow |
|---------|------|------|
| Research → Implement | Learn then build | Researcher → Implementer → Reviewer |
| Locate → Implement → Verify | Modifying unfamiliar code | Researcher → Implementer → Tester |
| Plan → Build → Test | Large feature with no clear path | Planner → Implementer → Tester → Reviewer |
| Parallel research | Multiple unrelated read-only investigations in one request | Researchers in parallel → orchestrator combines results |
| Review → Test | Completed code needs both verifications | Reviewer first → wait → Tester → orchestrator reconciles |

- "Find the best Go rate-limiting library, then implement middleware" → Researcher → Implementer → Reviewer
- "We need a notification system" → Planner → Implementer → Tester → Reviewer
- "What did we work on last session?" → Handle directly (in your own journals)
- "Write a limerick about the failed build" → Mascot
