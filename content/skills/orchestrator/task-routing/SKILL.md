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

## Context Growth

A round is one review cycle: findings go to the implementer, and the result
goes back to the reviewer. Each review that returns findings counts as one
round. A diff-only confirm by the orchestrator is not a round. The fix-batch
rule in **code-review-checklist** says when it applies.

**Resume is a platform capability.** Use it when the platform offers it, and
name no engine here. Resume only two roles: the implementer and the reviewer.
Every other role always starts fresh.

- When the platform can resume: reuse the same implementer and reviewer for up
to 2 rounds. They keep useful context.
- When the platform cannot resume: start a fresh agent of the same type for
each round. A third round is a sign that the first brief was underspecified.
Fix the brief, not the round count.
- A resumed round gets the delta only: the new findings and the changed files.
  Do not resend the whole brief.
- Every fresh agent gets a short brief: the goal, the current state (the files
  and the last commit or the uncommitted diff), the decisions already made, and
  the open findings. Do not paste earlier transcripts.
- Write large command output to a flat file under `/tmp`. Pass the path, not
  the content.
- The reuse limit in this section governs subagent reuse. The limit on review
  rounds lives in **code-review-checklist** under `## Fix Batching`.

---

## Dispatch Brief

- Name the reference source line in every implementer brief before the first draft.
- Quote that exact line in the brief, within the metacharacter limit below.
- In every code-touching brief, give a file tool inside the repository a
  repository-relative path that carries no parent segment. Only that form
  allows on every engine. Give a git call the `git -C` option and an absolute
  path.
- A file-tool path inside the repository that is absolute, or that holds a
  parent segment, asks on pi. An ask from a subagent can time out. The pi
  package README owns the path forms of the pi gate.
- Before dispatch, read the brief once. Replace every file-tool path inside the
  repository that is absolute or that holds a parent segment with a
  repository-relative path that carries no parent segment.
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
- State the verdict the work must reach and the checks that prove it, before the
  implementer starts. The map from severity to verdict lives in the
  **code-review-checklist** skill. Point at that map. Do not copy a row of it.
  When the brief adds a check, name the file or command the check uses.
- A dispatch brief names the sources to read (mockup, spec, file and line, or the brief file). It
  does not state design facts from memory.
- A brief is one concern that ends in one commit. A brief covers one code area and carries at
  most 5 acceptance checks. A brief that needs a sixth check or a second code
  area is two briefs.
- A diff that goes past about 150 changed lines, tests excluded, is a sign to
  split the brief. The orchestrator reads `git diff --stat` on the hand-back
  and decides.
- When a planner brief file exists, point the dispatch to its path. Do not paste
  its text.

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
