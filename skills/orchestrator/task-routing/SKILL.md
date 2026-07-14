---
name: task-routing
description: >-
  Skill for the orchestrator agent.
  Decision rules for assigning tasks to the correct specialist agent type.
  Consult before every subagent dispatch. Load at startup.
---

# Task Routing

## Routing Decision Tree

Evaluate in sequence. Stop at the first YES.

```
Q1: Does the user explicitly name an agent type?
    ("review this", "find info about X", "test this", "plan this")
  → YES: Route to that type. User intent is definitive.
  → NO:  Proceed.

Q2: Does the task require finding or synthesizing information
    not in your context? (Includes: exploring code, locating files,
    understanding unfamiliar systems, reviewing dependencies.)
  → YES: Route to RESEARCHER
  → NO:  Proceed.

Q3: Does the task require evaluating existing work against
    quality, correctness, or standards?
  → YES: Route to REVIEWER
  → NO:  Proceed.

Q4: Is the task ambiguous, large, or does it need decomposition
    before execution? (Includes architectural decisions.)
  → YES: Route to PLANNER
  → NO:  Proceed.

Q5: Is the task for entertainment, morale, or creative breakthrough?
  → YES: Route to MASCOT
  → NO:  Proceed.

Q6: Does the task require writing or modifying code
    based on clear specifications?
  → YES: Proceed to Q6a.
  → NO:  Proceed.

Q6a: Does the task specifically mention Python or React?
  → Python ("write a Python script", "create a Python module",
            "build a CLI in Python", etc.)
    → YES: Route to IMPLEMENTER-PYTHON
  → React ("build a React component", "create a React hook",
           "add a React page", etc.)
    → YES: Route to IMPLEMENTER-REACT
  → No specific language mentioned:
    → Route to generic IMPLEMENTER

Q7: Does the task require verifying behavior, writing tests,
    or hunting edge cases?
  → YES: Route to TESTER
  → NO:  Handle directly (see table below).
```

### Priority Summary

| Priority | Agent | Trigger |
|----------|-------|---------|
| 1 | User-named type | Explicit agent request |
| 2 | Researcher | Information needed outside context |
| 3 | Reviewer | Evaluation against standards |
| 4 | Planner | Ambiguity, scale, architectural decisions |
| 5 | Mascot | Entertainment / creative breakthrough |
| 6a | Implementer-Python | Python code with clear specs |
| 6b | Implementer-React | React code with clear specs |
| 6c | Implementer (generic) | Code with clear specs (no language match) |
| 7 | Tester | Behavior verification / test writing |

---

## Tiebreaker Rules

1. **Explicit user signal overrides all** — profession-specific verbs ("review", "test", "find", "plan") are definitive.
2. **Specificity wins** — the rule with the most conceptual overlap takes priority.
3. **Pipeline order breaks remaining ties** — Researcher > Reviewer > Planner > Implementer > Tester > Mascot.
4. **If still tied** — the task is multi-type. Decompose and dispatch each subtask separately.

---

## Multi-Agent Orchestration Patterns

### Pattern 1: Research → Implement
When: Task requires learning then building.
```
Researcher → Implementer → Reviewer
```

### Pattern 2: Locate → Implement → Verify
When: Modifying unfamiliar code.
```
Researcher → Implementer → Tester
```

### Pattern 3: Plan → Build → Test
When: Large feature with no clear path.
```
Planner → Implementer → Tester → Reviewer
```

### Pattern 4: Parallel Independent Subtasks
When: Multiple unrelated subtasks in one request.
```
[Parallel] Subtask A → appropriate agent
           Subtask B → appropriate agent
[Synthesis] Orchestrator combines results
```

### Pattern 5: Parallel Review + Test
When: Completed code needs quality and behavioral verification simultaneously.
```
[Parallel] Reviewer + Tester
[Synthesis] Orchestrator reconciles findings
```

---

## Route or Handle Directly?

| Task Type | Action |
|-----------|--------|
| Synthesizing subagent outputs | Handle directly |
| Status checks, context lookups | Handle directly |
| Trivial one-line changes | Handle directly |
| Greetings, conversation | Handle directly |
| Journal operations | Handle directly |
| Non-trivial file write or edit | Route to appropriate Implementer (Python/React/Generic) |
| Research outside current context | Route to Researcher |
| Codebase exploration | Route to Researcher |
| Evaluation of correctness/quality | Route to Reviewer |
| Task decomposition | Route to Planner |
| Testing/verification | Route to Tester |

---

## Routing Examples

**Research-heavy feature:**
"Find the best Go rate-limiting library that supports Redis, then implement middleware for our API."
→ Researcher → Implementer → Reviewer
Why: Research first (not in context), implement second, review third.

**Ambiguous request:**
"We need a notification system."
→ Planner → Implementer → Tester → Reviewer
Why: Completely ambiguous — needs decomposition first.

**Codebase exploration:**
"I want to add a new NPC type to the game."
→ Researcher (locate existing NPC patterns) → Planner (design) → Implementer (build)
Why: Never read source files yourself. The researcher summarizes; you decide based on that.

**Python-specific task:**
"Write a Python script that parses CSV files and loads them into the database."
→ IMPLEMENTER-PYTHON
Why: Task explicitly mentions Python — route to the Python specialist.

**React-specific task:**
"Create a React component for the user settings form with validation."
→ IMPLEMENTER-REACT
Why: Task explicitly mentions React — route to the React specialist.

**Generic code task:**
"Refactor the authentication middleware to use async/await."
→ IMPLEMENTER
Why: No language specified — use the generic implementer.

**Direct handling:**
"What did we work on last session?"
→ Handle directly
Why: Retrievable from your own journals.

---

## Anti-Patterns

- Do not route to **Reviewer** when there is nothing concrete to review yet
- Do not route to **Implementer** for complex architectural decisions — use Planner first
- Do not route to generic **Implementer** when the task is clearly Python or React specific — use IMPLEMENTER-PYTHON or IMPLEMENTER-REACT
- Do not route to **Researcher** when the information is already in your context
- Do not route to **Tester** before the code exists — Implementer first
- Do not route to **Planner** when the task is already clearly specified — go straight to Implementer
- Do not read source files yourself to "quickly check" something — dispatch a Researcher
- Do not glob and then read matched files — find the map, let the Researcher dig