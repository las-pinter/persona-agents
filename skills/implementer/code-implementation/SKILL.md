---
name: code-implementation
description: >-
  Skill for the implementer agent.
  Generic, language-agnostic code implementation workflow for building features,
  fixing bugs, refactoring, writing tests, and any technical coding task. Use
  this skill whenever implementing code changes across any programming language
  — includes systematic phases for orientation, planning, implementation,
  verification, and delivery with universal code standards and quality gates.
  Covers type safety, error handling, security, performance, naming conventions,
  testing standards, and anti-pattern avoidance. Always load before writing or
  modifying code.
---

# Code Implementation — The Universal Forge

---

## When to Use

Always load this skill before writing or modifying code — whether new features, bug fixes, refactoring, tests, prototypes, or technical chores. If the task involves editing or creating code, this skill applies. If you're doing code review, dependency updates, or pure ops work, skip it.

---

## Implementation Workflow

The workflow has five phases. Do not skip phases — each one exists because skipping it causes real failures in real projects.

### Phase 1: Orient — Understand the Terrain

Before touching a single line, understand what you're working with.

**Read project configs** (package.json, pyproject.toml, Cargo.toml, go.mod, etc.) to identify language, framework, build system, test runner, and linter.

**Read existing convention docs:** CONTRIBUTING.md, CLAUDE.md, README.md, .editorconfig, .env.example.

**Run the build/test commands** (npm test, pytest, cargo test, go test, etc.) to verify the baseline is green.

If the baseline doesn't build or tests don't pass, **stop and report it.** Never build on a broken foundation.

**Trace an existing similar feature** to understand code patterns. Find an analogous implementation and read it end to end — this tells you the conventions, patterns, and style the project expects.

---

### Phase 2: Plan — Think Before Striking

**If requirements are ambiguous, stop and ask for clarification.** Building the wrong thing correctly is still wrong. A minute of clarification saves an hour of rework.

**Read the complete file(s) before editing ANYTHING.** The #1 cause of hallucinated code is editing a file you haven't fully read. Read the entire file, not just the section you think you need to change.

**Identify where changes need to go:**
- Which files will you modify?
- Which functions, classes, or modules?
- Do you need new files?
- Will existing interfaces change?

**For complex work: write a quick plan before implementing.** A plan can be as simple as 3-5 bullet points. The act of writing it forces you to think through the steps.

**Consider edge cases:** null/empty input, unexpected state, dependency failures, concurrency, permissions, resource exhaustion.

**Check if specialized skills exist.** If `python-development` (or similar) is available and the project uses that language, load it for language-specific depth. This skill handles everything else.

---

### Phase 3: Implement — Write With Precision

**Follow existing code patterns and conventions.** The project already has a style. Match it. If the project uses snake_case, don't write camelCase.

**Write clear, readable code — someone else will maintain this.** Future-you will thank present-you for writing obvious code.

**Single responsibility — each function/class does one thing.** If a function name contains "and" ("validateAndSave"), split it.

**Handle errors properly:** fail fast, graceful degradation, meaningful messages. Every function has a contract — enforce it at the boundary.

**Handle ALL states — not just the happy path:**
- ✅ Happy path — everything works as expected
- ❌ Error states — dependencies fail, validation rejects
- ⬜ Empty states — no data, no results, zero items
- ⚠️ Edge cases — boundaries, extreme values, special inputs

**Use the language's type system properly.** No `any`, no loose types. The type checker is your first line of defense — use it.

**Search for existing helpers before writing new code (DRY).** Before writing a utility function, check if the project or a dependency already has one.

**Keep changes minimal — don't refactor unrelated code.** Every unrelated change is a potential regression and adds review friction. If you spot something worth refactoring, make it a separate task.

**Add comments that explain WHY, not WHAT.** The code already says what it does. Comments explain why it does it that way, what tradeoffs were made, or what non-obvious assumptions exist.

**Common implementation patterns by task type:**

| Task Type | Pattern |
|-----------|---------|
| **New feature** | Write tests alongside the feature |
| **Bug fix** | Write a failing test that reproduces the bug FIRST, then fix |
| **Refactor** | Keep tests passing after every change — small, safe steps |

---

### Phase 4: Verify — Prove It Works

Run quality gates in THIS ORDER. Do not skip. Do not reorder.

```
Type Check ──▶ Lint ──▶ Existing Tests ──▶ Build ──▶ New Tests
```

Run type checker, linter, tests, and build — in that order. Fix ALL issues before moving to the next.

#### 1. Type Check (if available)

Run the type checker (tsc, mypy, pyright, cargo check, go build). Zero tolerance for type errors — they're latent bugs.

#### 2. Lint

Run the linter (eslint, ruff, clippy, golangci-lint). Zero warnings. Match the project's exact lint configuration.

#### 3. Existing Tests

Run the **full** test suite. ALL must pass. If a test was already failing before your change, report it — don't ignore it.

#### 4. Build

Verify the project compiles, packages, or bundles successfully. No build = not done.

#### 5. New Tests

Write tests for all new functionality. Then run ALL tests again to confirm nothing broke.

---

### Phase 5: Deliver — Review and Polish

**Review your own code as if you were a reviewer.** Check correctness, edge cases, naming, comments, dead code, logging, and security.

**Check edge cases one more time:** empty/null input, boundary conditions, concurrent access (race conditions, stale data), resource cleanup (file handles, connections, memory).

**Update any docs affected by the change:** README, API docs, inline docs, migration guides, CHANGELOG.

**Leave git commits to the orchestrator.** Your job is to produce working code. The orchestrator handles version control. Focus on making the code correct, tested, and ready to commit.

---

## Universal Code Standards

These apply to EVERY language and EVERY project.

### Type Safety

- Use the language's type system fully. TypeScript types, Python type hints, Rust's ownership model, Go's interfaces — use them properly.
- No `any`, no casts, no `Object` — unless there is literally no alternative and you've commented why.
- Prefer specific types over generic ones. `EmailAddress` over `string`.
- Avoid `null`/`None` when a dedicated type (Option, Maybe, Result) is clearer.
- Use exhaustive pattern matching for enum-like types.

### Error Handling

- **Fail fast** — detect invalid state early, report it clearly. A crash with a good message is better than silent corruption.
- **Don't swallow errors** — empty `catch` blocks and `// ignore` comments are bugs waiting to happen. Handle it, log it, or propagate it.
- **Use idiomatic errors** — Rust's `Result<T,E>`, Go's `if err != nil`, Python's exceptions, TypeScript's discriminated unions.
- **Error messages have context** — what failed, why, what was expected.

### Security — Always, No Exceptions

- **Validate ALL inputs at trust boundaries** — injection attacks start with unvalidated input
- **Parameterize ALL queries** — string concat in SQL/shell = injection
- **Never hardcode secrets** — tokens, passwords, keys in code = breach. Follow least privilege.

### Performance

- **Be aware of algorithmic complexity.** Nested loops over 100K records hurt. O(n log n) is fine; O(n²) on user data is not.
- **Avoid N+1 queries.** Batch related data fetches into single queries.
- **Clean up resources.** Close files, release connections, free memory.
- **Cache where appropriate.** Memoize expensive calls, use connection pooling. Don't cache prematurely — measure first.
- **Profile before optimizing.** If you haven't measured, you're guessing.

### Naming & Readability

- **Names reveal intent** — `calculateInvoiceTotal()` not `calc()`.
- **Booleans read naturally** — `isActive`, `hasPermission`, `canDelete`.
- **No magic numbers/strings** — extract to named constants: `MAX_LOGIN_ATTEMPTS = 5` not `if (attempts >= 5)`.
- **Keep functions under ~40 lines** — longer means too many responsibilities.
- **Keep files under ~300 lines** — longer means consider splitting.
- **Follow language naming conventions** — snake_case for Python, camelCase for TS/JS, PascalCase for classes, etc.

---

## Testing Standards

**Write tests for ALL new functionality.** If you added a function, an endpoint, a component, or a module — it needs a test.

### What to Test

| Scenario | Must Test |
|----------|-----------|
| **Happy path** | Does the expected behavior work? |
| **Failure cases** | What happens when something goes wrong? |
| **Edge cases** | Boundaries, empty input, special values |
| **Error messages** | Are they helpful and accurate? |
| **Permissions** | Are unauthorized actions rejected? |

### Test Naming

Test names describe **behavior**, not implementation:

- ✅ `test_create_order_returns_400_when_inventory_empty`
- ✅ `returns_error_when_email_is_invalid`
- ❌ `test_function_2`

### Test Structure — Arrange-Act-Assert

Every test follows three phases: **Arrange** (set up test data) → **Act** (execute behavior) → **Assert** (verify outcome). One Act per test. Arrange sets up only what's needed for THIS test — no more. Assert verifies the outcome, not internal implementation details.

### For Bug Fixes

Write a test that **reproduces the bug FIRST**, then fix the code. This ensures you understand the bug, can verify the fix, and prevent regression.

---

## Quality Gates — Definition of Done

ALL of these must be true before considering a task complete:

☐ **Acceptance criteria met** — All criteria from the task are satisfied
☐ **Project conventions followed** — Style, patterns, idioms match the codebase
☐ **Type check passes** — Zero type errors
☐ **Lint passes** — Zero warnings, matches project style
☐ **All existing tests pass** — No regressions introduced
☐ **New tests written and passing** — New functionality is tested
☐ **Build succeeds** — Compiles, packages, or bundles cleanly
☐ **Edge cases handled** — Error, empty, loading, boundary conditions
☐ **No hardcoded secrets** — No tokens, passwords, or keys in code
☐ **Documentation updated** — README, API docs, changelog if behavior changed
☐ **Code ready for commit** — Changes are correct, tested, and clean

If any gate fails, **fix it before marking done.** A task with failing gates is not complete.

---

## Anti-Patterns — Avoid These!

| Anti-Pattern | Why It's Bad | Do This Instead |
|---|---|---|
| **Editing without reading** | #1 cause of hallucinated code | Read the full file before editing |
| **Skipping tests for "small" changes** | Small changes cause big regressions | Run the full test suite always |
| **Leaving TODOs/FIXMEs** | Becomes permanent tech debt | Implement it properly or don't add it |
| **Refactoring while adding features** | Two changes = impossible to review | Separate refactors into separate tasks |
| **Copy-pasting without understanding** | Propagates bugs and security issues | Understand before you write |
| **Over-engineering** | YAGNI | Build what's required, no more |
| **Writing clever code** | Clever = unmaintainable | Write clear, obvious code |
| **Changing unrelated files** | Review noise, merge conflicts | Touch only what's needed |
| **Silent error handling** | Empty catch hides bugs | Handle, log, or propagate — never swallow |
| **Mixing concerns in one function** | Hard to test, hard to reason about | Split into focused functions |
| **Hardcoding test data** | Tests break when data changes | Use factories, builders, or fixtures |
| **Ignoring existing patterns** | Creates inconsistency | Match the project's conventions |

---

## Composition — Working With Other Skills

This is a **generic** skill that works for any language. When available, specialized skills provide deeper, language-specific guidance:

| If This Exists | And You Detect | Load It For |
|---|---|---|
| `python-development` | `.py` files | Python patterns, tooling, idioms |
| `typescript-development` | `.ts` / `.tsx` files | TS config, tsconfig patterns |
| `rust-development` | `Cargo.toml` | Rust idioms, ownership patterns |
| `go-development` | `go.mod` | Go conventions, error handling |

**This generic skill is always the right starting point.** Load it first, then load specialized skills on top. The generic skill handles the universal workflow; the specialized skill adds depth for language-specific patterns.

If no specialized skill exists for the language in use, **this skill is sufficient.** Its standards are designed to be universal.

---

## Quick Reference Card

```
1. ORIENT    → Read configs, run baseline, trace similar features
2. PLAN      → Read files, consider edge cases, identify changes
3. IMPLEMENT → Follow patterns, handle all states, comment WHY not WHAT
4. VERIFY    → Type check → Lint → Tests → Build → New Tests
5. DELIVER   → Self-review, update docs, leave commits to orchestrator

GATES: ☐ Acceptance met  ☐ Conventions  ☐ Type check: 0 errors
       ☐ Lint: 0 warnings  ☐ Tests pass  ☐ Build succeeds
       ☐ Edge cases  ☐ No secrets  ☐ Docs updated
```
