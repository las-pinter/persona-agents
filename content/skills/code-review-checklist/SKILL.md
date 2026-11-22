---
name: code-review-checklist
description: Structured checklist for reviewing code changes — severity taxonomy, methodology, domain-specific checks, and anti-patterns.
---

# Code Review Checklist

## Review Methodology (6 Steps)

1. **Scope** — Read the PR title and description. Check which files and areas changed.
2. **High-level pass** — Does the overall approach make sense? Simpler alternative? Respects architecture?
3. **Deep dive** — Read every changed line. Logic correct? Edge cases handled? Tests verify the right behavior?
4. **Cross-cutting pass** — Security, performance, observability across the whole change.
5. **Craft comments** — One concern per comment; explain WHY; reference exact lines; offer alternatives; use "we" or "this line"; acknowledge good code. Assign severity.
6. **Follow up** — Verify blocker fixes were applied; approve when all blockers resolved.

---

## Two Axes

Every finding carries one axis:

- **Standards** — the repository's documented rules and this checklist.
- **Spec** — what the task and the decisions file asked for.

Report the axes separately and never rerank one against the other: code can
follow every standard and do the wrong thing, or do exactly what was asked and
break the conventions. The severity map and the verdict still apply across
both.

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

## Severity-to-Verdict Map

The highest issue severity sets the verdict. This map is the only
severity-to-verdict authority. The reviewer agent and the companion both use it.

| Highest severity found | Verdict |
|------------------------|---------|
| Any `BLOCKER` | Reject |
| Any `CRITICAL` | Request Changes |
| Any `IMPORTANT` | Request Changes, or Approve with notes |
| Only `SUGGESTION` or `NIT` | Approve |

---

## Fix Batching

One review round yields one fix batch. Apply the batch once.

Round one reports every finding in one verdict. That verdict starts one fix
batch.

A batch gets a re-review (the **review** skill again) in every case except the
diff-only confirm below. Only one re-review follows a batch. A further review round runs only
after a failed test or a failed live probe. A design objection that no test
covers goes to the owner for a decision.

A fix batch gets a diff-only confirm, not a re-review, when all of these are
true:

- Every finding in the batch is NIT or SUGGESTION.
- The batch changes only tests, comments, or names. It changes no logic, no
  config, and no rule text in a profession or skill file.
- For each test the batch changes, a new break-fail-restore result line exists
  (**code-implementation**, Phase 4). With no such line, the batch gets a
  re-review.
- The batch diff is at most about 50 changed lines. A bigger batch gets a
  re-review.
- The quality gate (**code-implementation**, Phase 4) passes on the batch.

The companion reads its own batch diff once more and confirms.

---

## Verification Evidence

The review runs the suite once in each review round. A passing suite is its
own evidence, and CI reruns the same suite. A red run is a failure to report
or a flake to fix. A red run is never a reason to re-run until green.

A permission fix or a configuration fix is not closed until one live command
runs through the real engine. A test over a mirror or a copy of the engine
does not close the fix.

The evidence has three items: the command, the verdict it returned, and the
session-notes line that records it.

The command forms live in the project's `tech/` notes (see the
**project-notes** skill).

---

## Smell Baseline

A fixed set of design smells that applies even when a repository documents
nothing. Two rules bind it:

- A documented repository standard always wins. Where it endorses something a
  smell would flag, suppress the smell.
- Each smell is a labelled judgement call ("possible Feature Envy"), never a
  hard violation. Skip anything tooling already enforces.

| Smell | What it looks like | The fix |
|---|---|---|
| Mysterious name | A function, variable, or type whose name does not say what it does or holds. | Rename it; if no honest name comes, the design is unclear. |
| Duplicated code | The same logic shape appears in more than one hunk or file. | Extract the shared shape once and call it from both. |
| Feature envy | A method reaches into another object's data more than its own. | Move the method onto the data it envies. |
| Data clumps | The same few fields or parameters keep travelling together. | Bundle them into one type and pass that. |
| Primitive obsession | A primitive or string stands in for a domain concept. | Give the concept its own small type. |
| Repeated switches | The same switch or if-cascade on one type recurs. | One map both sites share, or polymorphism. |
| Shotgun surgery | One logical change forces scattered edits across many files. | Gather what changes together into one module. |
| Divergent change | One file is edited for several unrelated reasons. | Split it so each module changes for one reason. |
| Speculative generality | Abstraction, parameters, or hooks for needs the task does not have. | Delete it; inline until a real need shows. |
| Message chains | Long `a.b().c().d()` navigation the caller should not depend on. | Hide the walk behind one method on the first object. |
| Middle man | A class or function that mostly just delegates onward. | Cut it; call the real target. |
| Refused bequest | A subclass ignores or overrides most of what it inherits. | Drop the inheritance; use composition. |

---

## The Checklist

> Many standards below are defined in the code-implementation skill; here they are verified from the review side.

### 1. PR Overview
- [ ] Description explains **what** and **why** (not just how)
- [ ] All changes logically belong in this PR
- [ ] Matches the requested change or issue
- [ ] README, docs, or API specs updated if behavior changed
- [ ] Load and follow the **persona-free-documents** skill when reviewing documents and code comments; flag every violation it names

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
- [ ] File length follows the **file-length-policy** skill.

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
- [ ] Comments are short and say why; a long comment block signals a design problem.
- [ ] No outdated comments or commented-out code
- [ ] Comments and docs follow the **persona-free-documents** skill.
- [ ] TODOs describe the missing work and name an owner; no ticket reference

### 11. Style & Consistency
- [ ] Follows team style guide and project conventions
- [ ] Style nits prefixed `NIT:`

### 12. Observability & Operations
- [ ] New features covered by logging, metrics, or structured events
- [ ] Log levels appropriate: ERROR for failures, WARN for anomalies, INFO for notable events
- [ ] No PII or secrets logged

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

These bands measure the diff of one pull request, not the length of one file;
file length belongs to the **file-length-policy** skill.

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
| Bikeshedding on trivial issues | Label nits, move on |
| 50+ comments without prioritization | Use severity labels; distinguish blockers from nits |
| Criticizing test style over missing coverage | Fix coverage gaps first |