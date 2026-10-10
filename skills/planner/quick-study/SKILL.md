---
name: quick-study
description: Turn a new idea or feature into a high-level quick study with questions and answers.
---

# Quick Study

## Purpose

Turn a new idea or feature into a high-level study. The quick study states the
problem, the users, the wanted result, the scope, and the unknowns. It is the
first stage of the planner study lifecycle.

## When to Load

Load this skill at the start of every new feature or idea. Load the
**study-questions** skill with it. The two skills work as one unit.

## Workflow

1. Read the request and restate it in one or two plain sentences.
2. Dispatch a researcher subagent to gather context. For a goblin theme, use
   `goblin-researcher`.
3. Ask the user many questions. Ask about the problem, the users, the scope,
   and the success measures. Use the **study-questions** skill for the format.
4. Write the quick study to the study folder.
5. Create `status.md` in the same action. Set the stage to `quick`.
6. Add the study row to `studies/index.md`.

## Storage

Write the study to
`<USER_HOME>/agent-notes/project-notes/<project>/studies/YYYY-MM-DD-<slug>/quick-study.md`.
Use the `date` command for the date. Use a plain kebab-case slug. Do not put a
date inside the slug. See the **project-notes** skill for the folder layout.

## Owned Document: `quick-study.md`

```markdown
# YYYY-MM-DD - <Feature> - Quick Study

## Summary
## Problem & Motivation
## Users & Scenarios
## Desired Outcome & Success Criteria
## Scope
### In Scope
### Out of Scope
## Assumptions & Constraints
## Initial Risks & Unknowns
## Related Notes & Studies
## Questions & Answers
```

## Size Limit

Keep `quick-study.md` to 150 lines or fewer. If the study grows past the limit,
move detail into the full study or split the feature.

## Rules

- One folder holds both study stages. Do not make a second folder for the full
  study.
- Put every question and answer at the bottom under `## Questions & Answers`.
- Mark each open question with `[NEEDS CLARIFICATION: ...]`.
- A quick study is done only when no blocking question stays open.
- Do not edit another study's files. The planner owns the `studies/` tree.

## Related Skills

- **study-questions** (`skills/planner/study-questions/`) — Owns the Q&A
  format and the clarification marker. Load with this skill.
- **full-study** (`skills/planner/full-study/`) — The next stage. Load when the
  quick study is accepted.
- **project-notes** (`skills/common/project-notes/`) — Owns the study tree,
  `status.md`, and `studies/index.md` formats.
