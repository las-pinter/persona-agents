---
name: study-questions
description: Own the question discipline and the questions-and-answers format for both study stages.
---

# Study Questions

## Purpose

Own the question discipline for both study stages. Own the Q&A section format
and the clarification marker. Load this skill with **quick-study** and
**full-study**.

## When to Ask

Ask the user when an unknown blocks a decision. Do not ask about facts you can
find yourself. Do not assume an answer.

- Ask early. A question asked before design is cheaper than a rewrite after.
- Batch related questions in one message. Do not send many small questions.
- Ask one clear question at a time inside the batch.
- Restate the answer in your own words when the answer is complex.

## Q&A Block Format

Both study documents end with this block:

```markdown
## Questions & Answers

### Q1: <question>
- **Asked:** YYYY-MM-DD
- **Status:** answered | open | deferred
- **Answer:** <the user's answer>
- **Impact:** <what this answer changes>

[NEEDS CLARIFICATION: <question>]
```

## Rules

- Number each question in order: Q1, Q2, and so on. Keep the numbers stable.
- **Status** is one of `answered`, `open`, or `deferred`.
- **Impact** states what the answer changes. Write it for every answered
  question.
- Never invent an answer. Leave the answer empty until the user replies.
- **Never assume an answer.** Surface it as a question instead.
- Mark every open question with `[NEEDS CLARIFICATION: ...]`. Put the marker
  on the same line as the short question.
- An open question blocks the full-study handoff. The user may **defer** it.
  A deferred question does not block the handoff. Record the reason.
- Keep a deferred question visible. Do not delete it when the study closes.

## Related Skills

- **quick-study** (`skills/planner/quick-study/`) — The first study stage.
- **full-study** (`skills/planner/full-study/`) — The second study stage.
