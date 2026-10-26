---
name: study
description: Write and maintain one study document from settled interview decisions.
---

# Study

## Purpose

Write one study per feature. The study holds the goal, the settled decisions,
the tasks, the risks, and the acceptance criteria. It is the only planner study
document.

## When to Load

Load this skill after the **interview** skill settles the decisions. Load the
two skills as one unit. The study is the record of the interview.

## Persona-Free Documents

Load and follow the **persona-free-documents** skill for every study, note, journal, report, release note, and code comment.

## One Document

- One study folder per feature: `studies/YYYY-MM-DD-<slug>/`.
- One study document: `studies/YYYY-MM-DD-<slug>/study.md`.
- There is no quick stage. The **project-notes** skill owns the `status.md`
  stage rules.
- Use the `date` command for the date. Use a plain kebab-case slug with no date
  inside it.

## Storage

Write the study to
`<USER_HOME>/agent-notes/project-notes/<project>/studies/YYYY-MM-DD-<slug>/study.md`.
`<USER_HOME>` is the folder that holds `agent-notes`. Follow the
**journal-management-generic** skill for the exact rule and the fallback. See
the **project-notes** skill for the folder layout.

## Document Skeleton

```markdown
# YYYY-MM-DD - <Feature> - Study

## Goal
## Scope and Non-Goals
## Decisions
## Tasks
## Risks
## Acceptance Criteria
## Open Items
## Side Documents
```

### Decisions

The `## Decisions` section holds the interview record. One entry per question:

- the question;
- the user's answer;
- the decision;
- the date.

Keep the question numbers stable. Do not delete a deferred question.

### Tasks

The `## Tasks` section holds one table. Columns:

`| # | Task | Depends On | Complexity | Acceptance |`

- **Depends On** names earlier task numbers, or `—` for none.
- **Acceptance** is a verifiable condition, not "works correctly".
- Every task is independently completable.

### Complexity Scale

Score a task by two axes: size and unknowns.

- **Size** — the files or areas the task touches:
  - **Small** — one file or one function.
  - **Medium** — a few files in one area.
  - **Large** — many files, or more than one area.
- **Unknowns** — what is not known yet:
  - **None** — every step is clear.
  - **Low** — one question with an obvious answer.
  - **Medium** — a few questions or an unverified assumption.
  - **High** — a blocking unknown. Add an investigation task first.

Write the estimate as `size / unknowns`, for example `Medium / Low`. When you
cannot estimate either axis with confidence, mark the task `unknown`.

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

### Risks

The `## Risks` section holds a risk register table:

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

## Side Documents

- The planner may add clearly named `.md` files beside `study.md`.
- A `reverse_engineering/` subfolder holds code inspection or
  reverse-engineering results.
- List every side document in `status.md`.
- Reference every side document from `study.md`.
- Do not copy the study into a side document. Move detail out and link it.

## Caps, Status, and Index

Follow the **project-notes** skill: it owns the caps, the `status.md` rules, and
the `studies/index.md` format.

## Quality Gate

A study is done only when every line is true:

- [ ] The title and date are set.
- [ ] The goal states the problem, the users, and the success measures.
- [ ] Every task has an acceptance condition and a complexity estimate.
- [ ] Dependencies are mapped with no circular chain.
- [ ] At least one risk is listed, or "None identified".
- [ ] Every High or Critical risk has a mitigation.
- [ ] The critical path is named when the study has three or more tasks.
- [ ] No `[NEEDS CLARIFICATION]` marker remains.
- [ ] A developer can start work with no follow-up questions.
- [ ] The document contains no persona or theme language.

## Rules

- One folder, one document. Do not make a second folder for the same feature.
- Do not write a task that hides an unknown. Add an investigation task.
- Do not edit another study's files. The planner owns the `studies/` tree.
- Do not write a side document that repeats the study.

## Related Skills

- **interview** — Owns the frontier rounds and the
  decisions record. Load with this skill.
- **project-notes** — Shared, persona-free project
  context. Load with this skill.
