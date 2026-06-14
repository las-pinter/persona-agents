---
name: code-review-checklist
description: >-
  Skill for the reviewer agent.
  Structured checklist for reviewing code changes with depth and consistency.
  Includes severity taxonomy, comment guide, anti-patterns, and domain-specific
  checklists. Load BEFORE starting any code review.
---

# Code Review Checklist

## Review Methodology (6 Steps)

1. **Scope** — Read PR title, description, linked ticket. Check which files and areas changed.
2. **High-level pass** — Does the overall approach make sense? Simpler alternative? Respects architecture?
3. **Deep dive** — Read every changed line. Logic correct? Edge cases handled? Tests verify the right behavior?
4. **Cross-cutting pass** — Security, performance, observability across the whole change.
5. **Craft comments** — Group related feedback, assign severity, write clearly.
6. **Follow up** — Verify blocker fixes were applied; approve when all blockers resolved.

---

## Severity Taxonomy

Label every issue so the author can triage at a glance:

| Severity | Label | Meaning |
|----------|-------|---------|
| 🔴 | `BLOCKER` | Must fix before merge. Bug, security hole, or spec violation. |
| 🟠 | `CRITICAL` | Should fix before merge. Likely causes production bugs. |
| 🟡 | `IMPORTANT` | Should fix, doesn't block merge. May cause future issues. |
| 🔵 | `SUGGESTION` | Nice to have. Quality or maintainability improvement. |
| ⚪ | `NIT` | Style preference only. Never blocks a PR. |

---

## The Checklist

### 1. PR Overview
- [ ] Description explains **what** and **why** (not just how)
- [ ] All changes logically belong in this PR
- [ ] Matches the linked ticket/issue/spec
- [ ] README, docs, or API specs updated if behavior changed

### 2. Design & Architecture
- [ ] Overall approach makes sense for the problem
- [ ] Follows existing architectural patterns (or diverges with good reason)
- [ ] Abstractions are justified — not premature, not missing
- [ ] Makes future changes easier, not harder

### 3. Correctness & Functionality
- [ ] Code does what the developer intended
- [ ] Edge cases: empty/null/zero, boundary conditions, invalid input
- [ ] Concurrency: race conditions, deadlocks, atomicity
- [ ] Failure modes: errors, timeouts, partial failures
- [ ] Idempotency where expected (retries won't cause double-processing)

### 4. Complexity
- [ ] Each function/class does one thing (no "and" in function names)
- [ ] A new developer could understand this within a minute
- [ ] No over-engineering (YAGNI)
- [ ] Cyclomatic complexity reasonable — deep nesting extracted into helpers

### 5. Security
- [ ] All user/input data validated and sanitized at trust boundaries
- [ ] Auth enforced on every protected path
- [ ] Sensitive data not logged, not exposed in errors, encrypted at rest/transit
- [ ] No injection vulnerabilities: SQL, NoSQL, XSS, command injection, SSRF, path traversal
- [ ] Dependencies checked for known vulnerabilities (if applicable)

### 6. Tests
- [ ] Tests included in the same PR
- [ ] Happy path and failure/edge cases covered
- [ ] Tests actually fail when corresponding code breaks
- [ ] Test names describe the scenario, not the function

### 7. Error Handling & Resilience
- [ ] Errors handled explicitly — not swallowed (no bare `except`/`catch`)
- [ ] Error messages meaningful: include context, not just "error"
- [ ] Timeouts set for all external calls
- [ ] Resources cleaned up in all paths (success AND error)

### 8. Performance
- [ ] No N+1 queries or redundant network requests
- [ ] No obvious algorithmic inefficiencies
- [ ] Resources properly released

### 9. Naming & Readability
- [ ] Variable, function, class names are descriptive and unambiguous
- [ ] Booleans read naturally: `isActive`, `hasPermission`, `canDelete`
- [ ] Magic numbers/strings extracted to named constants

### 10. Comments & Documentation
- [ ] Comments explain **why**, not **what**
- [ ] No outdated comments or commented-out code
- [ ] TODOs linked to tickets or have owners

### 11. Style & Consistency
- [ ] Follows team style guide and project conventions
- [ ] Style nits always prefixed `NIT:` — never block a PR for style

### 12. Observability & Operations
- [ ] New features covered by logging, metrics, or structured events
- [ ] Log levels appropriate: ERROR for failures, WARN for anomalies, INFO for notable events
- [ ] No PII or secrets logged

---

## Comment Crafting

- **One concern per comment** — don't bury multiple issues in one thread
- **Explain WHY** — "this is wrong because..." is valuable; "this is wrong" is not
- **Be specific** — reference exact lines, not just files
- **Offer alternatives** — "consider using X instead" beats "don't use X"
- **Use "we" or "this line"** — keeps feedback impersonal
- **Acknowledge good code** — at least one positive comment per review

---

## Domain-Specific Checks

### Web / Frontend
- Accessibility: keyboard navigation, screen reader support, color contrast
- Bundle size: new dependencies justified? Code-splitting used?
- State management: cleanup on unmount? Race conditions in async effects?

### API / Backend
- API contract matches what clients expect; versioning handled
- Request body validated at the boundary
- POST/PUT endpoints handle duplicate requests safely (idempotency)

### Data / Migrations
- `DROP` or destructive `ALTER` statements — reversible?
- Rollback plan exists and is documented
- Data integrity: constraints, orphaned records handled

### Infrastructure / Config
- No hardcoded credentials; environment variables used properly
- Service roles and IAM policies follow least privilege
- Dependency/image version changes tested

---

## PR Size Strategy

| Size | Lines | Approach |
|------|-------|----------|
| 🟢 Small | < 200 | Full review using entire checklist |
| 🟡 Medium | 200-500 | Deep review on changed files; quick scan on related files |
| 🟠 Large | 500-1000 | Ask to split. If can't, review by commit or feature boundary |
| 🔴 Excessive | > 1000 | Request smaller PRs before reviewing |

---

## Anti-Patterns

| Anti-Pattern | Do This Instead |
|---|---|
| Rubber-stamping | Read every changed line |
| Bikeshedding on trivial issues | Label nits; never let style block a PR |
| 50+ comments without prioritization | Use severity labels; distinguish blockers from nits |
| Criticizing test style over missing coverage | Fix coverage gaps first |