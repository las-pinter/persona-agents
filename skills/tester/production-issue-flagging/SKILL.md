---
name: production-issue-flagging
description: Format for reporting production-code issues found while testing.
---

# Production Issue Flagging

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