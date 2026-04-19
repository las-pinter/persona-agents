---
name: regression-identification
description: Identify which existing tests are relevant to a change and what new tests are needed to cover gaps.
---

# Skill: Regression Identification

## When to Use
When a change is made to existing code, identify which tests are relevant and what new tests are needed.

## Procedure

1. **Identify changed units** — which functions, classes, or modules were modified?
2. **Trace dependents** — what calls or imports the changed code? Those are regression candidates
3. **Check existing tests** — do current tests cover the changed behavior? Run them
4. **Identify gaps** — what changed behavior is NOT covered by existing tests?
5. **Write new tests** — cover the gaps before marking the change complete. For deciding what type of tests to write, load `test-strategy-selection.md`

## Change Impact Heuristics

| Change type | Regression risk | Action |
|---|---|---|
| Bug fix | Medium — fix may break adjacent behavior | Test the fix + test neighbors |
| Refactor (no behavior change) | Low — but verify | Run existing tests; add if missing |
| New feature | Low for existing code | Test new paths; check integration points |
| Interface/API change | High | Test all callers; update contract tests |
| Performance optimization | Medium | Verify correctness is preserved |
| Dependency upgrade | High | Run full test suite; check breaking changes |

## Rules

- Never mark a change done without running the relevant existing tests
- A passing test suite is necessary but not sufficient, check for missing coverage too
