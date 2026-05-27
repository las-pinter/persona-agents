---
name: regression-identification
description: >-
  Skill for the tester agent.
  Identify which existing tests are relevant to code changes and what new tests
  are needed to cover gaps. Use this skill whenever code changes are made —
  during PR review, before committing, or when planning test coverage. Includes
  dependency tracing methodology, change impact analysis, test gap analysis
  patterns, and a tiered regression strategy. NOT optional for any code change
  work — always load when tests or coverage are discussed.
---

# Regression Identification

## When to Use

- **Always** when code is changed — before marking any change complete
- When reviewing a PR to determine if test coverage is adequate
- When planning test coverage for a new feature or fix
- When debugging a production issue to determine what's missing
- When refactoring to ensure existing behavior is preserved

---

## Core Methodology (5-Step Process)

### Step 1: Identify Changed Units
Start by mapping exactly what changed:
- **Functions/methods** — which were modified, added, or removed?
- **Classes/modules** — which files were touched?
- **Interfaces/contracts** — did signatures, return types, or error codes change?
- **Data schemas** — did DB migrations, API payloads, or configs change?

Use `git diff` to identify the exact set of changes. Categorize each change:
- `[ADD]` — New code added
- `[MOD]` — Existing code modified
- `[DEL]` — Code removed
- `[REF]` — Code restructured (behavior unchanged)
- `[CFG]` — Configuration/environment changes

### Step 2: Trace Dependents (Forward & Reverse)
Map the impact radius of each change:

**Direct dependents** — things that directly call or import the changed code:
- Check imports and call sites
- Check test files that import the changed module
- Check integration points (event handlers, API consumers, DI bindings)

**Transitive dependents** — things that depend on direct dependents:
- Walk the dependency graph outward (direct → transitive → distant)
- Stop when the chain is 5+ modules deep (diminishing returns)
- Flag high-radius changes (>3 modules) as high-risk

**Dependency mapping techniques:**

| Technique | How | Best For |
|-----------|-----|----------|
| **Static grep/search** | Search for imports/references across the codebase | Quick assessment, small-medium projects |
| **Build graph traversal** | Use build system deps (Bazel, Gradle, cargo) | Large projects with defined module boundaries |
| **Dynamic call tracing** | Run coverage tools on existing tests | Precise mapping at method level |
| **Test-to-code mapping** | Pre-computed map of which tests cover which files | CI integration, large teams |

**Rule of thumb:** For every file changed, trace at minimum:
1. Direct callers/importers
2. Test files for the changed module
3. Test files for callers of the changed module

### Step 3: Check Existing Test Coverage
For each changed unit, determine if existing tests cover it:

**Coverage check matrix:**

| Scenario | Check |
|----------|-------|
| Changed function | Does a test call this function with relevant inputs? |
| New function | Is there a new test for it? |
| Changed behavior | Do existing tests assert the OLD behavior that changed? |
| Removed code | Were there tests for the removed functionality? |
| Error paths | Are error handling changes tested? |

**Run the relevant existing tests** and verify:
- ✅ All previously passing tests still pass
- ✅ No tests were broken by the change
- ⚠️ Any test that needed updating to match new behavior was updated

### Step 4: Identify Gaps
Overlay the change map against the test coverage map:

**Common gap patterns:**

| Pattern | What's Missing | Risk |
|---------|---------------|------|
| New code, no tests | Untested new functionality | 🔴 High |
| Behavior changed, tests unchanged | Tests pass for wrong reasons | 🔴 High |
| Bug fixed, no regression test | Same bug can reappear | 🟠 Medium |
| Refactored code, coverage dropped | Previously tested paths untested | 🟠 Medium |
| Integration point changed, no integration test | Interface mismatch | 🔴 High |
| Dependency upgraded, no integration test | Breaking change undetected | 🟠 Medium |

**Prioritize gaps by:**
1. **Business criticality** — does this affect core user flows or revenue?
2. **Change complexity** — how many paths were modified?
3. **Defect probability** — is this a high-churn area with past bugs?
4. **Test proximity** — is a test at the right level possible?

### Step 5: Write New Tests
Cover gaps by writing tests at the most efficient level:

| Gap Type | Best Test Level | Why |
|----------|----------------|-----|
| New logic path | Unit test | Fast, precise, isolated |
| Changed behavior | Unit + Integration | Verifies behavior AND integration |
| Bug fix | Unit test (reproduces bug) | Prevents regression |
| API change | Contract test | Catches consumer/provider mismatch |

**Write the test that would have caught the bug before it was introduced.**

---

## Change Impact Heuristics

| Change Type | Regression Risk | What to Test |
|-------------|----------------|-------------|
| Bug fix | 🟠 Medium — fix may break adjacent behavior | Test the fix + test neighbors + add regression test |
| Refactor (no behavior change) | 🟢 Low — but verify | Run existing tests; add characterization tests if missing |
| New feature | 🟢 Low for existing code | Test new paths; verify integration points unchanged |
| Interface/API change | 🔴 High | Test all callers; update contract tests; verify backward compat |
| Dependency upgrade | 🔴 High | Run full suite; check changelog for breaking changes |
| Data schema migration | 🔴 Very High | Test migration forward + rollback; verify data integrity |

---

## The Tiered Regression Strategy

Not all changes need the same depth of regression testing. Use this tiered approach:

| Tier | Trigger | Scope | Time Budget |
|------|---------|-------|-------------|
| **Tier 1: Smoke** | Every commit | 20-30 critical tests (login, core flows) | < 2 min |
| **Tier 2: Selective** | Every PR/merge | Impact-analyzed tests from Steps 1-3 | < 15 min |
| **Tier 3: Complete** | Merge to main | Full test suite | Nightly |
| **Tier 4: Full E2E** | Pre-release | End-to-end + manual exploration | Before release |

**For individual changes (this skill's focus):** Apply Tier 2 — selective, impact-analyzed regression.

---

## Test Suite Maintenance Cadence

For test suite maintenance cadence, see the test-strategy-selection skill.

---

## Rules

1. **Never mark a change done without running the relevant existing tests** — a passing suite is necessary but not sufficient
2. **Turn every production bug into a regression test** — the fix isn't complete until a test would catch it
3. **For refactors: test coverage should increase or stay the same** — never decrease
4. **For external dependency changes: always run the full integration test suite** — breaking changes are common
5. **Trace transitive dependencies, not just direct ones** — a utility change can break distant consumers
6. **One test type is not enough** — combine unit + integration for changed behavior; add E2E for critical paths
