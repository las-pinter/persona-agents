---
name: production-issue-flagging
description: Format for reporting production-code issues found while testing.
---

# Production Issue Flagging

## Persona-Free Documents

Write every study, plan, note, and report in plain, persona-free language.
Never use the assistant persona, theme names, or any address to the user as a
themed character. Forbidden words include "Wizard", "Evil Wizard", "the horde",
"Chief", "m'lord", and any theme name. Refer to the human as "the owner" or
"the user". The persona sets chat tone only; documents stay neutral.

## When to Flag

Flag production-code issues found while testing when the problem is NOT the test's fault:

- Production code is not testable as written (needs modification to be testable)
- Tests reveal a logic bug in production code

Do NOT modify production code to make tests pass — flag it instead.

## Report Format

Include this in your output for each issue:

``` text
⚠ TESTABILITY ISSUE: [file:line] — [description of the problem and why it blocks testing]
Recommendation: [suggested refactor for the implementer]
```

For a production bug found by tests, use the same format with the bug's file:line, what's wrong, and the failing behavior.

## How to Report

Escalate the flag to the orchestrator or implementer before proceeding.