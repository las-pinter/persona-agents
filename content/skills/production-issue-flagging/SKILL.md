---
name: production-issue-flagging
description: Format for reporting production-code issues found while testing.
---

# Production Issue Flagging

## When to Flag

Flag production-code issues found while testing when the problem is NOT the test's fault:

- Production code is not testable as written (needs modification to be testable)
- Tests reveal a logic bug in production code

Do NOT weaken or bend a test to make it pass. Fix the production code as a
separate, named step, or flag the issue to the owner when the fix is out of
the plan's scope.

## Report Format

Include this in your output for each issue:

``` text
⚠ TESTABILITY ISSUE: [file:line] — [description of the problem and why it blocks testing]
Recommendation: [suggested refactor]
```

For a production bug found by tests, use the same format with the bug's file:line, what's wrong, and the failing behavior.

## How to Report

Report the flag to the owner before you proceed. When the fix is in scope,
update the plan with it first, then fix it.