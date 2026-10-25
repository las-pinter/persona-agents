---
name: interview
description: Grill the user in frontier rounds until every decision is settled.
---

# Interview

## Purpose

Grill the user before any study is written. The interview turns a vague
request into a settled set of decisions. It is the only stage before the study.

## Persona-Free Documents

Load and follow the **persona-free-documents** skill for every study, note, journal, report, release note, and code comment.

## The Design Tree

Model the request as a tree of decisions.

- The root is the goal.
- Each decision branches into the decisions that depend on it.
- A decision cannot be asked until its parent decisions are settled.
- The frontier is the set of decisions whose prerequisites are all settled.

## Frontier Rounds

1. Compute the frontier of the design tree.
2. Pose the whole frontier in one relay block. Number each question.
3. Put the recommendation on its own line under the question. Word the
   question so the answer "yes" accepts the recommendation.
4. Never put two dependent questions in the same round.
5. End the run with the relay block. Continue only when the orchestrator
   re-dispatches the planner with the answers.
6. Settle the answers into the study. Recompute the frontier.
7. Repeat until the frontier is empty.

## Facts vs Decisions

- A fact is findable. Finding facts is the planner's job. Dispatch a subagent,
  or read the codebase.
- A decision belongs to the user. Surface it in a question round.
- Never ask the user for a fact the planner can find.
- Never answer the planner's own decision question.

## Findings

- Run one researcher sweep before the first round.
- Run a look-up during the interview when a question demands one.
- Do not ask the user for anything a look-up can settle.

## Recording

After each round, write into the study document:

- each question and its answer;
- each decision;
- each open item.

The study document is the living record. See the **study** skill.

## The Relay Contract

The planner runs as a stateless subagent. It has no user access. It cannot ask
the user, and it must never wait for input.

Each turn, the planner does these steps in order:

1. Update the study on disk.
2. End its reply with exactly one relay block.

When a question stays open, end with:

```
## QUESTION ROUND <n>
1. <question>
   Recommendation: <the recommended answer>
2. ...
```

When no question stays open, end with:

```
## INTERVIEW COMPLETE
All decisions are settled. The study at <path> is ready for acceptance.
```

The orchestrator reads the block, asks the user, and re-dispatches the planner
with the study path and the answers. The planner re-reads the study from disk
at the start of every run. The disk file is its memory.

## Handling "I don't know"

- Treat "I don't know" as a real answer. Do not guess.
- Offer 2 to 3 bounded options with trade-offs.
- If the answer stays unknown, flag an open gap with a named owner, or propose
  a small prototype.

## Vagueness and Contradictions

- Push a vague word to a number, date, owner, or metric. Vague words include
  "fast", "many", "robust", and "done".
- When a new answer conflicts with an earlier one, stop and ask which holds.

## Done

The interview ends when the frontier is empty. The planner then ends the run
with `## INTERVIEW COMPLETE`.

Study acceptance is a separate, later step. The **project-notes** skill owns the
`status.md` stage rules.

## Self-Check

- Every question has a recommendation.
- No round holds two dependent questions.
- No open decision is left for the developer to make.
- The document contains no persona or theme language.

## Related Skills

- **study** — Owns the study document.
- **project-notes** — Owns the caps,
  the `status.md` rules, and the `studies/index.md` format.
