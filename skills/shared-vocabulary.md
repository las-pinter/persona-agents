---
name: shared-vocabulary
description: Canonical definitions for severity levels, complexity sizes, and definition of done used consistently across all agents.
---

# Skill: Shared Vocabulary

All agents use these definitions. When in doubt, use the most conservative classification.

---

## Severity Levels

### blocking
Must be resolved before the work can proceed or be accepted.
- Examples: security vulnerability, data loss risk, logic error that breaks core behavior
- Action: work stops; must fix before re-review

### significant
Materially affects quality, correctness, or maintainability but does not block immediate function.
- Examples: missing error handling on a non-critical path, test coverage gap on important behavior
- Action: should be fixed in this cycle; requires follow-up if deferred

### minor
Improves the work but has low impact if left as-is.
- Examples: naming that could be clearer, a slightly misleading comment
- Action: fix if the cost is low; acceptable to defer

### suggestion
An optional idea the author may or may not act on.
- Examples: alternative approach worth considering, a future refactor opportunity
- Action: no expectation of action; author decides

---

## Complexity Sizes

### small
- Scope: single function, component, or config change
- Estimated effort: < 2 hours
- Risk: low; easy to reason about and revert

### medium
- Scope: multiple functions or a single module/feature
- Estimated effort: 2–8 hours
- Risk: moderate; requires understanding of surrounding context

### large
- Scope: cross-module, cross-service, or architectural change
- Estimated effort: > 8 hours (likely multi-day)
- Risk: high; decompose into smaller tasks before starting if possible

---

## Definition of Done

A task is **done** when all of the following are true:

1. **Acceptance criteria met** — the task does what it was asked to do, verifiably
2. **No blocking or significant findings open** — all blocking issues resolved; significant issues resolved or explicitly deferred with a ticket
3. **Tests pass** — existing tests green; new behavior has coverage if tests were requested
4. **Reviewer accepted** — at least one review pass completed with no unresolved blocking findings
5. **Output is deliverable** — the artifact is in its final location, not a draft or WIP

A task is **not done** if:
- It works "most of the time"
- It has open blocking findings marked "will fix later"
- The output exists but has not been reviewed
