---
name: code-implementation
description: >-
  Skill for the implementer agent.
  Language-agnostic code implementation workflow for features, bugs, refactors,
  and tests. Load before writing or modifying any code.
---

# Code Implementation

## Quick Reference

```
1. ORIENT    → Read configs, run baseline, trace a similar feature
2. PLAN      → Read full files, consider edge cases, identify changes
3. IMPLEMENT → Follow patterns, handle all states, comment WHY not WHAT
4. VERIFY    → Type check → Lint → Tests → Build → New Tests (in order)
5. DELIVER   → Self-review, update docs, leave commits to orchestrator

GATES: ☐ Acceptance met  ☐ Conventions  ☐ Type check: 0 errors
       ☐ Lint: 0 warnings  ☐ Tests pass  ☐ Build succeeds
       ☐ Edge cases  ☐ No secrets  ☐ Docs updated
```

---

## Phase 1: Orient

Before touching a single line:

- Read project configs (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) — identify language, framework, test runner, linter.
- Read convention docs: `CONTRIBUTING.md`, `CLAUDE.md`, `README.md`, `.editorconfig`.
- Run the baseline build/test command and confirm it's green. If baseline is broken, **stop and report it** — never build on a broken foundation.
- Trace an existing similar feature end-to-end to understand the patterns and conventions expected.

---

## Phase 2: Plan

- If requirements are ambiguous, **stop and ask**. Building the wrong thing correctly is still wrong.
- **Read the complete file before editing anything.** The #1 cause of hallucinated code is editing a file you haven't fully read.
- Identify: which files change, which functions/classes, whether new files are needed, whether interfaces change.
- Consider edge cases: null/empty input, unexpected state, dependency failures, concurrency, permissions, resource exhaustion.
- For complex work, write a 3-5 bullet plan before implementing.

---

## Phase 3: Implement

- Follow existing code patterns and conventions — match the project's style, not your preference.
- Handle ALL states, not just the happy path: success, error, empty, and edge cases.
- Single responsibility — if a function name contains "and", split it.
- Handle errors properly: fail fast, meaningful messages, enforce contracts at boundaries.
- Use the language's type system fully. No `any`, no loose types.
- Search for existing helpers before writing new code (DRY).
- Make minimal changes — do not refactor unrelated code in the same change.
- Comment WHY, not WHAT. The code already says what it does.

**By task type:**

| Task Type | Pattern |
|-----------|---------|
| New feature | Write tests alongside the feature |
| Bug fix | Write a failing test that reproduces the bug FIRST, then fix |
| Refactor | Keep tests passing after every change — small, safe steps |

---

## Phase 4: Verify

Run in this order. Fix all issues before advancing to the next step:

```
Type Check → Lint → Existing Tests → Build → New Tests
```

1. **Type check** — zero tolerance for type errors (tsc, mypy, cargo check)
2. **Lint** — zero warnings, matching the project's exact config
3. **Existing tests** — full suite must pass; if a test was failing before your change, report it
4. **Build** — project must compile, package, or bundle successfully
5. **New tests** — write tests for all new functionality; run full suite again

---

## Phase 5: Deliver

- Review your own code as if you were a reviewer: correctness, edge cases, naming, comments, dead code, security.
- Update docs affected by the change: README, API docs, inline docs, changelog.
- Leave commits to the orchestrator.

---

## Universal Code Standards

### Type Safety
- Use the type system fully. No `any`, no casts without justification.
- Prefer specific types over generic: `EmailAddress` over `string`.
- Use exhaustive pattern matching for enum-like types.

### Error Handling
- Fail fast — detect invalid state early, report clearly.
- Never swallow errors (no empty `catch`/`except` blocks).
- Use idiomatic error types for the language (Rust `Result`, Go `if err != nil`, etc.).
- Error messages include context: what failed, why, what was expected.

### Security
- Validate ALL inputs at trust boundaries.
- Parameterize ALL queries — no string concatenation in SQL or shell.
- Never hardcode secrets.

### Performance
- Be aware of algorithmic complexity. O(n²) over user data is a bug.
- Avoid N+1 queries. Batch related data fetches.
- Clean up resources: close files, release connections.
- Profile before optimizing — if you haven't measured, you're guessing.

### Naming
- Names reveal intent: `calculateInvoiceTotal()` not `calc()`.
- Booleans read naturally: `isActive`, `hasPermission`, `canDelete`.
- No magic numbers — extract to named constants.
- Functions under ~40 lines; files under ~300 lines.

---

## Testing Standards

Write tests for ALL new functionality. Every test follows Arrange → Act → Assert (one Act per test).

| Scenario | Test |
|----------|------|
| Happy path | Does expected behavior work? |
| Failure cases | What happens when something goes wrong? |
| Edge cases | Boundaries, empty input, special values |
| Error messages | Helpful and accurate? |
| Permissions | Unauthorized actions rejected? |

Test names describe **behavior**, not implementation: `test_create_order_returns_400_when_inventory_empty` ✅, `test_function_2` ❌.

---

## Anti-Patterns

| Anti-Pattern | Do This Instead |
|---|---|
| Editing without reading the full file | Read first, always |
| Skipping tests for "small" changes | Run the full suite always |
| Leaving TODOs/FIXMEs | Implement properly or create a tracked task |
| Refactoring while adding features | Separate tasks |
| Writing clever code | Write clear, obvious code |
| Changing unrelated files | Touch only what's needed |
| Silent error handling | Handle, log, or propagate — never swallow |
| Mixing concerns in one function | Split into focused functions |

---

## Specialized Skills

This skill is generic and always sufficient. If a language-specific skill exists (`python-development`, `typescript-development`, etc.) and matches the project, load it additionally for language-specific depth.