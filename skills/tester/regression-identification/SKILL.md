---
name: regression-identification
description: >-
  Skill for the tester agent.
  Identify which existing tests are relevant to code changes and what new tests
  are needed to cover gaps. Load WHENEVER code changes are made — during PR
  review, before committing, or when planning test coverage.
---

# Regression Identification

## Core Methodology (5 Steps)

### Step 1: Identify Changed Units

Map exactly what changed using `git diff`. Categorize each change:
- `[ADD]` — New code added
- `[MOD]` — Existing code modified
- `[DEL]` — Code removed
- `[REF]` — Code restructured (behavior unchanged)
- `[CFG]` — Configuration/environment changes

Track: which functions/methods were touched, which files, whether interfaces/contracts changed, whether data schemas changed.

### Step 2: Trace Dependents

For every changed file, trace at minimum:
1. Direct callers/importers
2. Test files for the changed module
3. Test files for callers of the changed module

**Dependency mapping techniques:**

| Technique | How | Best For |
|-----------|-----|---------|
| Static grep/search | Search for imports/references | Quick, small-medium projects |
| Build graph traversal | Use build system deps | Large projects |
| Dynamic call tracing | Run coverage tools on existing tests | Precise method-level mapping |

Flag changes with radius > 3 modules as high-risk. Stop tracing at 5+ modules deep (diminishing returns).

### Step 3: Check Existing Coverage

For each changed unit:

| Scenario | Check |
|----------|-------|
| Changed function | Does a test call this with relevant inputs? |
| New function | Is there a new test? |
| Changed behavior | Do tests assert the OLD behavior that changed? |
| Removed code | Were there tests for the removed functionality? |
| Error paths | Are error handling changes tested? |

Run the relevant existing tests and confirm: all previously passing tests still pass, and any test updated for new behavior is correct.

### Step 4: Identify Gaps

| Pattern | What's Missing | Risk |
|---------|---------------|------|
| New code, no tests | Untested new functionality | 🔴 High |
| Behavior changed, tests unchanged | Tests pass for wrong reasons | 🔴 High |
| Bug fixed, no regression test | Same bug can reappear | 🟠 Medium |
| Refactored code, coverage dropped | Previously tested paths untested | 🟠 Medium |
| Integration point changed, no integration test | Interface mismatch | 🔴 High |
| Dependency upgraded, no integration test | Breaking change undetected | 🟠 Medium |

**Prioritize gaps by:** business criticality → change complexity → defect probability → test proximity.

### Step 5: Write New Tests

| Gap Type | Best Level | Why |
|----------|-----------|-----|
| New logic path | Unit | Fast, precise, isolated |
| Changed behavior | Unit + Integration | Verifies behavior AND integration |
| Bug fix | Unit (reproduces the bug) | Prevents regression |
| API change | Contract | Catches consumer/provider mismatch |

Write the test that would have caught the bug before it was introduced.

---

## Change Impact Heuristics

| Change Type | Regression Risk | What to Test |
|-------------|----------------|-------------|
| Bug fix | 🟠 Medium | Fix + adjacent behavior + regression test |
| Refactor (no behavior change) | 🟢 Low | Run existing; add characterization tests if missing |
| New feature | 🟢 Low for existing | New paths; verify integration points unchanged |
| Interface/API change | 🔴 High | All callers; contract tests; backward compat |
| Dependency upgrade | 🔴 High | Full suite; check changelog for breaking changes |
| Data schema migration | 🔴 Very High | Migration forward + rollback; data integrity |

---

## Tiered Regression Strategy

| Tier | Trigger | Scope | Budget |
|------|---------|-------|--------|
| **Tier 1: Smoke** | Every commit | 20-30 critical tests | < 2 min |
| **Tier 2: Selective** | Every PR/merge | Impact-analyzed tests from Steps 1-3 | < 15 min |
| **Tier 3: Complete** | Merge to main | Full test suite | Nightly |
| **Tier 4: Full E2E** | Pre-release | E2E + manual exploration | Before release |

For individual changes, apply **Tier 2** — selective, impact-analyzed regression.

---

## Core Rules

1. Never mark a change done without running the relevant existing tests
2. Turn every production bug into a regression test — the fix isn't complete without it
3. Refactors: test coverage must increase or stay the same, never decrease
4. Dependency changes: always run the full integration test suite
5. Trace transitive dependencies, not just direct ones