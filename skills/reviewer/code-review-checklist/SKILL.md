---
name: code-review-checklist
description: >-
  Skill for the reviewer agent.
  Structured, methodology-driven checklist for reviewing code changes with
  depth and consistency. Whenever you need to review a pull request, assess
  code quality, evaluate implementation work, or conduct a code audit — for
  any language, framework, or project — use this skill to guide your review.
  This is NOT optional for reviews: always load this skill when reviewing code.
  Includes severity taxonomy, comment crafting guide, anti-patterns,
  domain-specific checklists, and PR size strategies.
---

# Code Review Checklist

## When to Use

- **Always** when reviewing a pull request or code changes before merge
- When evaluating existing code for quality, correctness, or standards compliance
- When conducting a thorough assessment of implementation work
- When mentoring junior developers through code reviews

Not every item applies to every PR — focus on what's relevant, but always run
through the methodology first.

---

## Before You Begin: Review Mindset

A great review is **collaborative, not adversarial**. Your goal is to catch bugs,
improve quality, and share knowledge — not to prove superiority.

- **Curiosity over criticism:** Ask "what if X happens?" instead of "this is wrong"
- **Specific over vague:** Point to exact lines and explain the *why*
- **Balanced feedback:** Acknowledge good solutions, not just problems

---

## The Review Methodology (6 Steps)

### Step 1: Scope the Change
Before reading a single line of diff, understand the context:
- Read the PR title, description, and linked ticket
- Check what files were changed (not just count — which *areas*)

### Step 2: High-Level Pass — Design & Structure
Read the overall shape of the change:
- Does the approach make sense? Is there a simpler way?
- Does it respect existing architectural boundaries?

### Step 3: Deep Dive — Correctness & Logic
Read every changed line carefully:
- Does the logic handle the happy path AND edge cases?
- Do the tests actually verify the right behavior?

### Step 4: Cross-Cutting Pass — Security, Ops, Performance
Check concerns that span the whole change:
- Security: injection, auth, data exposure, secret handling
- Performance: N+1 queries, unnecessary work, resource leaks

### Step 5: Craft & Organize Comments
Group related feedback, assign severity, and write clearly (see Comment Crafting below).

### Step 6: Follow Up
After the author responds:
- Verify blocker/critical fixes were applied correctly
- Approve when all blockers are resolved

---

## Issue Severity Taxonomy

Label every issue with its severity so the author knows what to prioritize:

| Severity | Label | Meaning |
|----------|-------|---------|
| 🔴 Blocker | `BLOCKER` | Must fix before merge. Bug, security hole, or spec violation. |
| 🟠 Critical | `CRITICAL` | Should fix before merge. Likely causes bugs in production. |
| 🟡 Important | `IMPORTANT` | Should fix, doesn't block merge. May cause future issues. |
| 🔵 Suggestion | `SUGGESTION` | Nice to have. Improves code quality or maintainability. |
| ⚪ Nitpick | `NIT` | Style preference only. Never blocks a PR. |

**Rule:** Start each review comment with the severity label so the author can triage at a glance.

---

## The Full Checklist

### 1. PR Overview (Scoping)

- [ ] PR description clearly explains **what** and **why** (not just how)
- [ ] All changes logically belong in this PR (no unrelated formatting changes)
- [ ] Scope is appropriate — small enough to review thoroughly
- [ ] Matches the linked ticket/issue/spec (no scope creep)
- [ ] README, docs, API specs, or ADRs updated if behavior changed

### 2. Design & Architecture

- [ ] Overall design makes sense for the problem
- [ ] Follows existing architectural patterns in the codebase (or diverges with good reason)
- [ ] Abstractions are justified — not premature, not missing
- [ ] Makes future changes easier, not harder
- [ ] Belongs in this location vs. a shared module/library

**Watch for:** Leaking data-layer concerns into presentation code; mixing responsibilities in a single module; over-abstracting a one-use case.

### 3. Correctness & Functionality

- [ ] Code does what the developer intended (read the tests to understand intent)
- [ ] Edge cases handled: empty/null/zero values, boundary conditions, invalid input
- [ ] Concurrency: race conditions, deadlocks, data races, atomicity
- [ ] State mutations are safe and predictable
- [ ] Failure modes handled: errors, timeouts, partial failures, network blips
- [ ] Idempotency where expected (retries won't cause double-processing)

**Good:** "Handles empty result set on line 89 with an early return."
**Needs work:** "Assumes API always returns at least one result — crashes on empty response."

### 4. Complexity

- [ ] Each function/class does **one thing** (Single Responsibility Principle)
- [ ] No function is doing more than it needs to — decompose if necessary
- [ ] A new developer could understand this code within a minute or two
- [ ] No over-engineering (YAGNI — speculative generality removed)
- [ ] Cyclomatic complexity is reasonable — deep nesting extracted into helpers

**Watch for:** Functions over 40-50 lines; classes over 300 lines; conditionals nested 4+ deep; the "one more field" class that keeps growing.

### 5. Security

- [ ] All user/input data validated and sanitized at trust boundaries
- [ ] Authentication and authorization enforced on every protected path
- [ ] Sensitive data (PII, credentials, tokens, secrets) handled safely:
  - Not logged or exposed in error messages
  - Not sent to client unless necessary
  - Encrypted at rest and in transit
- [ ] No injection vulnerabilities: SQL, NoSQL, XSS, command injection, SSRF, path traversal
- [ ] Dependencies checked for known vulnerabilities (if applicable)

**Always check:** New API endpoints — is auth required? New DB queries — parameterized? New file handling — path sanitized? New URLs fetched — SSRF risk?

### 6. Tests

- [ ] Tests included in the same PR as the code
- [ ] Happy path covered
- [ ] Failure cases and edge cases covered (not just "everything works" tests)
- [ ] Tests actually fail when corresponding code breaks (no false passes)
- [ ] Tests are readable and reflect real-world scenarios (not implementation-obsessed)
- [ ] Test names describe the scenario, not the function:
  - **Good:** `test_create_order_returns_400_when_inventory_empty`
  - **Avoid:** `test_create_order_2`

**Watch for:** Tests that never call the code they claim to test; snapshot tests nobody reads; tests that pass for wrong reasons (empty assertions, loose mocks).

### 7. Error Handling & Resilience

- [ ] Errors caught and handled explicitly — not swallowed (bare `except`/`catch`)
- [ ] Error messages meaningful and actionable (include context, not just "error")
- [ ] Feature degradation is graceful — optional features fail without breaking core flows
- [ ] Timeouts set for all external calls (HTTP, DB, file I/O)
- [ ] Retry logic with backoff where appropriate, bounded to avoid cascading failures
- [ ] Cleanup/release of resources in all paths (success AND error)

**Good:** `"Failed to process payment for order #{order_id}: insufficient funds"`
**Needs work:** `"Error processing order"`

### 8. Performance

- [ ] No unnecessary database calls, N+1 queries, or redundant network requests
- [ ] Caching used appropriately — not too much, not too little
- [ ] No obvious algorithmic inefficiencies (nested loops over large datasets)
- [ ] Resource cleanup: open files, DB connections, network sockets, streams
- [ ] Batch operations where individual calls would be expensive

**Rule:** Focus on the 20% of optimizations that produce 80% of results. Don't block for micro-optimizations unless in a hot path.

### 9. Naming & Readability

- [ ] Variable, function, and class names are descriptive and unambiguous
- [ ] Abbreviations are well-known or unnecessary
- [ ] Boolean names read naturally: `isActive`, `hasPermission`, `canDelete`
- [ ] Code is self-explanatory — doesn't need excessive comments to understand
- [ ] Magic numbers/strings extracted to named constants

### 10. Comments & Documentation

- [ ] Comments explain **why**, not **what** (the code already says what)
- [ ] No outdated comments or commented-out code — remove them
- [ ] TODOs linked to tickets or have owners, not just floating promises
- [ ] Public API / module-level documentation present and accurate
- [ ] Complex algorithms or business rules documented with rationale

### 11. Style & Consistency

- [ ] Follows team's style guide and conventions (language idioms, project patterns)
- [ ] Formatting consistent with surrounding codebase
- [ ] No style-only nits that block a PR — always prefix with `NIT:`
- [ ] Prefer consistency over personal preference: if the file uses one style, match it

**Note:** If no team style guide exists, default to language community conventions (PEP 8 for Python, StandardJS for JS, gofmt for Go, etc.).

### 12. Observability & Operations

- [ ] New features covered by logging, metrics, or structured events
- [ ] Log statements at appropriate levels: `ERROR` for failures, `WARN` for anomalies, `INFO` for notable events
- [ ] No PII or secrets logged (emails, IPs unless anonymized, tokens, passwords)
- [ ] Error tracking (Sentry, DataDog, etc.) captures new failure modes
- [ ] Metrics or tracing added for performance-critical paths
- [ ] Feature flags or gradual rollout considered for risky changes

---

## Comment Crafting Guide

### Comment Structure Template

Format: `<SEVERITY_LABEL> <topic> in <file>:<line>` — explain **Why** and offer a **Suggestion**.

### Comment Types with Examples

- **Asking a question:** `QUESTION: Should we handle null user? (line 45)` — API docs say it's optional.
- **Pointing out a problem:** `CRITICAL: Missing input validation in createUser() (line 23)` — NoSQL injection risk.

### Key Rules

1. **One concern per comment** — don't bury multiple issues in one thread
2. **Explain the WHY** — "this is wrong" is useless; "this is wrong because..." is valuable
3. **Be specific** — reference exact lines, not just files
4. **Offer alternatives** — "consider using X instead" is better than "don't use X"
5. **Use "we" or "this line"** — not "you". Keeps feedback impersonal and collaborative
6. **Praise good code** — "Nice use of early return here" goes a long way

---

## Review Anti-Patterns

| Anti-Pattern | Why It's Bad | Do This Instead |
|---|---|---|
| **Rubber-stamping** | Approving without actual review | Read every changed line. If PR is too large, ask to split it |
| **Bikeshedding** | Spending disproportionate time on trivial issues | Label nits clearly. Don't let a whitespace debate block a PR |
| **Reviewing too late** | Catching design issues after implementation | Review design docs before code is written |
| **Explosive reviews** | Dumping 50+ comments without prioritization | Use severity labels, distinguish blockers from nits |
| **Nitpicking tests** | Criticizing test style while ignoring missing coverage | Focus coverage gaps first, style second |

---

## Domain-Specific Considerations

### Web / Frontend
- **Accessibility:** Keyboard navigation, screen reader support, color contrast
- **Bundle size:** New dependencies justified? Code-splitting used?
- **State management:** Proper cleanup on unmount? Race conditions in async effects?

### API / Backend
- **API contract:** Does the response match what clients expect? Versioning?
- **Validation:** Request body validated at the boundary?
- **Idempotency:** POST/PUT endpoints handle duplicate requests safely?

### Data / Migrations
- **Irreversible operations:** `DROP`, destructive `ALTER` — reversible?
- **Rollback plan:** Can the migration be rolled back cleanly?
- **Data integrity:** Constraints, validation, orphaned records handled?

### Infrastructure / Config
- **Secrets management:** Hardcoded credentials? Environment variables properly used?
- **Least privilege:** Service roles, IAM policies, network rules too permissive?
- **Dependency changes:** Base image updates, package version bumps tested?

---

## PR Size Strategies

| Size | Lines Changed | Approach |
|------|--------------|----------|
| 🟢 Small | < 200 | Full thorough review using entire checklist |
| 🟡 Medium | 200-500 | Focus deep review on changed files, quick scan on related files |
| 🟠 Large | 500-1000 | Ask to split. If can't split, review by commit/feature boundary |
| 🔴 Excessive | > 1000 | Request PR be broken into smaller logical PRs before reviewing |

---

## Post-Review & Follow-Up

After submitting your review:
1. **Watch for responses** — engage in discussion threads, especially on blockers
2. **Verify fixes** — re-check that blocker/critical concerns were addressed
3. **Know when to re-review** — if the author pushes significant changes, do a second pass

---

## Reviewer Conduct (Core Rules)

- **Read every changed line** — don't skim, don't skip files
- **Review in context** — understand how the diff fits into the whole file/system
- **Ask questions, don't make demands** — "Should we handle the null case?" not "Add null handling"
- **Acknowledge good work** — at least one positive comment per review
- **Be respectful** — the code isn't the person. Critique the code, not the author

---

## PR Type Variations

- **Feature PRs:** Full checklist + migration reversibility + monitoring additions + feature flag check
- **Bug fix PRs:** Verify root cause addressed (not just symptoms); regression test added; similar patterns checked elsewhere
- **Refactor PRs:** Behavior must be unchanged (no hidden fixes); test coverage should increase or stay same
- **Dependency updates:** Changelog reviewed for breaking changes; security advisories checked; test suite passes with new version
