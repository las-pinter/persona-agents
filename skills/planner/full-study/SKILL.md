---
name: full-study
description: Turn a ready quick study into a full technical study with tasks, risks, and acceptance criteria.
---

# Full Study

## Purpose

Turn a ready quick study into a full technical study. The full study holds the
design, the interfaces, the tasks, the risks, the test plan, and the quality
gate. It is the second stage of the planner study lifecycle.

## When to Load

Load this skill only after the quick study is accepted. Load the
**study-questions** skill with it. The two skills work as one unit.

## Workflow

1. Read `quick-study.md` for the same feature folder.
2. Resolve every open question. Ask the user about each blocking unknown.
3. Write the full study into the same feature folder.
4. Update `status.md`: set the stage to `full`, add a History row, and update
   the date.
5. Update the study row in `studies/index.md`.

## Storage

Write the study to
`<USER_HOME>/agent-notes/project-notes/<project>/studies/YYYY-MM-DD-<slug>/full-study.md`.
The folder name does not change between stages. See the **project-notes** skill
for the folder layout.

## Owned Document: `full-study.md`

```markdown
# YYYY-MM-DD - <Feature> - Full Study

## Summary
## Technical Context
## Design Overview
## Data Model & Key Entities
## Interfaces & Contracts
## Functional Requirements
## Non-Functional Requirements
## Task Breakdown
## Risks & Dependencies
## Test & Verification Strategy
## Rollout & Migration
## Deferred & Out of Scope
## Quality Gate Checklist
## Questions & Answers
```

## Task Breakdown

The `## Task Breakdown` section holds one table. Columns:

`| # | Task | Depends On | Complexity | Acceptance |`

- **Depends On** names earlier task numbers, or `—` for none.
- **Acceptance** is a verifiable condition, not "works correctly".
- Every task is independently completable.

### Complexity Scale

- **Small** — under 1 hour, one file or function, no cross-cutting concerns.
- **Medium** — half a day, a few files or cross-module work.
- **Large** — multiple days, cross-cutting changes, or large unknowns.
- Mark a task `unknown` when you cannot estimate it with confidence.

### Task-Splitting Patterns

| Work Type | Split Pattern |
|-----------|---------------|
| Feature | One task per user-facing action, end to end. |
| Bugfix | Reproduce, find the cause, fix, add a regression test. |
| Refactor | One task per module. Keep the system working at each step. |
| Integration | Split by contract boundary: connect, handle errors, then monitor. |

Stop splitting a task when it is estimable, verifiable, independent, has one
responsibility, and has no unknowns. If a task has unknowns, add a small
investigation task before it.

### Acceptance Criteria

| Weak | Strong |
|------|--------|
| "Works correctly" | "Login returns 200 and a JWT for valid credentials" |
| "Fast enough" | "The API answers within 200 ms at p95" |
| "Handles errors" | "Invalid input returns 400 with `{error: string}`" |

## Risks & Dependencies

The `## Risks & Dependencies` section holds a risk register table:

`| Risk | Type | Score | Impact | Mitigation |`

- **Type:** internal, external, implicit, or operational.
- **Score:** likelihood times impact. Likelihood is Rare, Unlikely, Possible,
  Likely, or Almost Certain. Impact is Negligible, Minor, Moderate, Major, or
  Critical. The product gives Low, Medium, High, or Critical.
- **Mitigation:** state what, when, and who. "Hope it works" is not a
  mitigation.

Required action by score:

- **Critical** — blocks the study until mitigated. Flag for user review.
- **High** — needs a mitigation plan. Flag for user review.
- **Medium** — needs a mitigation or an accepted risk.
- **Low** — note it and move on.

For three or more tasks, name the **critical path**: the longest dependency
chain. A delay on that chain delays the study. Mark it.

## Size Limit

Keep `full-study.md` to 500 lines or fewer. If it grows past the limit, split
the feature into two study folders.

## Quality Gate Checklist

A full study is done only when every line is true:

- [ ] The title and date are set.
- [ ] The summary states the problem, the users, and the success measures.
- [ ] Every task has an acceptance condition and a complexity estimate.
- [ ] Dependencies are mapped with no circular chain.
- [ ] At least one risk is listed, or "None identified".
- [ ] Every High or Critical risk has a mitigation.
- [ ] The critical path is named when the study has three or more tasks.
- [ ] No blocking question stays open under `## Questions & Answers`.

## Rules

- One folder holds both study stages. Do not rename the folder.
- Put every question and answer at the bottom under `## Questions & Answers`.
- Do not write a task that hides an unknown. Add an investigation task.
- Do not edit another study's files. The planner owns the `studies/` tree.

## Related Skills

- **study-questions** (`skills/planner/study-questions/`) — Owns the Q&A
  format and the clarification marker. Load with this skill.
- **quick-study** (`skills/planner/quick-study/`) — The first stage. Its
  document is the input to this skill.
- **project-notes** (`skills/common/project-notes/`) — Owns the study tree,
  `status.md`, and `studies/index.md` formats.
