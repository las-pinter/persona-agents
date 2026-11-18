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
2. Ask the whole frontier in one round with the question tool. Number each
   question.
3. Put the recommendation first among the options, marked as recommended.
   Word the question so accepting the recommendation is one choice.
4. Never put two dependent questions in the same round.
5. Settle the answers into the study on disk before the next round.
   Recompute the frontier.
6. Repeat until the frontier is empty.

## Facts vs Decisions

- A fact is findable. Find it yourself: read the codebase, or search.
- A decision belongs to the user. Surface it in a question round.
- Never ask the user for a fact you can find.
- Never answer your own decision question.
- For an architectural decision with no obvious answer, give 2 to 3 options
  with trade-offs; do not pick one alone.

## Findings

- Run one look-up sweep of the code and the project notes before the first round.
- Run a look-up during the interview when a question demands one.
- Do not ask the user for anything a look-up can settle.

## Recording

After each round, write into the study document:

- each question and its answer;
- each decision;
- each open item.

The study document is the living record. See the **study** skill.

## Memory

The study on disk is the record of the interview. Context can be compacted
between rounds, so write each round into the study before you ask the next one,
and re-read the study when the context no longer holds it.

## Handling "I don't know"

- Treat "I don't know" as a real answer. Do not guess.
- Offer 2 to 3 bounded options with trade-offs.
- If the answer stays unknown, flag an open gap with a named owner, or propose
  a small prototype.

## Vagueness and Contradictions

- Push a vague word to a number, date, owner, or metric. Vague words include
  "fast", "many", "robust", and "done".
- When a new answer conflicts with an earlier one, stop and ask which holds.

## End of the Interview

The interview ends when the frontier is empty. Then present the study to the
owner for acceptance. Acceptance is a separate step: do not implement before
the owner accepts the study. The **project-notes** skill owns the
`status.md` stage rules and the reopen.

## Self-Check

- Every question has a recommendation.
- No round holds two dependent questions.
- No open decision is left for the developer to make.
- The document contains no persona or theme language.

## Related Skills

- **study** — Owns the study document.
- **project-notes** — Owns the caps,
  the `status.md` rules, and the `studies/index.md` format.
