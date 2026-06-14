---
name: test-case-structure
description: >-
  Skill for the tester agent.
  Language-agnostic structure, naming conventions, and rules for writing clear,
  maintainable test cases. Load BEFORE writing or reviewing any test code.
---

# Test Case Structure

## Universal Principles

1. **Describe behavior, not implementation.** Test names say WHAT the code does, not HOW.
2. **Every test name answers three questions:** What context/input? What action? What outcome?
3. **Readability over convention.** If a longer name is clearer, use it.

### Good vs Bad Names

❌ Implementation-focused: `callsDatabaseQuery`, `loopsThroughArray`, `verifyServiceIsCalled`

✅ Behavior-focused: `returnsUserWhenIdExists`, `rejectsPaymentWhenBalanceInsufficient`, `returnsEmptyListWhenNoResultsFound`

---

## Naming Patterns

### Pattern 1: Given-When-Then
Best for: complex scenarios with multiple preconditions.
```
// JS:   it('returns error when cart is empty')
# Python: test_given_empty_cart_when_checkout_then_raises_error
```

### Pattern 2: Condition-Outcome
Best for: simple, single-condition scenarios.
```
// JS:   it('rejects payment when balance insufficient')
# Python: test_insufficient_balance_rejects_payment
```

### Pattern 3: Nested Context (recommended for complex flows)
Eliminates redundancy by grouping related scenarios:
```
describe('Payment Processing')
  describe('when credit card is valid')
    it('completes transaction successfully')
    it('sends confirmation email')
  describe('when credit card is expired')
    it('rejects the transaction')
    it('returns descriptive error message')
```

### What to Avoid
- Fluff words: "correctly", "properly", "valid" (unless exact scenario name)
- Redundant prefixes: "test" (unless framework requires it)
- Implementation details in names: exception types, method names
- Multiple scenarios in one test — split them
- Magic values: `test_returns_42` → `test_returns_max_items_per_page`

---

## Test Structure

### Arrange-Act-Assert (AAA)

```
// Arrange — set up test data and preconditions
// Act     — execute the behavior under test
// Assert  — verify the outcome
```

Rules:
- **One Act per test** — multiple actions make failure diagnosis ambiguous
- **Arrange sets up only what's needed** for THIS test
- **Assert verifies the outcome**, not intermediate state
- Separate phases with blank lines or comments for readability

### Given-When-Then (GWT)

Semantically identical to AAA, framed for behavior:

| AAA | GWT |
|-----|-----|
| Arrange | Given |
| Act | When |
| Assert | Then |

Use **AAA** for developer-facing unit tests. Use **GWT** for stakeholder-facing acceptance tests.

---

## Test Data Management

| Pattern | Best For | Key Rule |
|---------|----------|----------|
| **Fixtures** | Reference data; read-only tests | Only for data tests READ but never MODIFY |
| **Factories** | Each test creates its own data | Defaults must be valid with no overrides |
| **Builders** | Complex objects with many optional fields | Immutable pattern prevents shared state |

### Golden Rules
- Each test creates its own data — never depend on data from other tests
- Override only what matters for the specific test scenario
- Use unique values for unique-constrained fields (timestamp/UUID suffix)
- Clean up between tests — transaction rollback is ideal
- Never use production data in tests — use Faker for synthetic data

### Anti-Patterns
- ❌ Hardcoded IDs (`id = 1`) — break when database resets
- ❌ Shared global seed files — invisible dependencies between tests
- ❌ Over-seeding in `beforeEach` — every test becomes slow and unclear

---

## Assertion Patterns

1. Assert the exact desired behavior — not more (brittle), not less (misses regressions)
2. One assertion per logical concept; multiple asserts OK when verifying different aspects of the SAME behavior
3. Assert requirements, not implementation — test should survive refactoring
4. Use the most specific assertion available
5. Use soft assertions / `assertAll` to report ALL failures, not just the first

---

## Parameterized Testing

Use when: same logic across multiple input/output pairs; edge case coverage; combinatorial scenarios.

| Framework | Simple Cases | Complex Cases |
|-----------|-------------|---------------|
| pytest | `@pytest.mark.parametrize("input,expected", [(1,2)])` | `pytest.param(1, 2, id="case_name")` |
| JUnit 5 | `@CsvSource({"1,2", "3,4"})` | `@MethodSource("dataProvider")` |
| Jest | `it.each([[1, 2], [3, 4]])` | `it.each` with template literals |

Pitfalls:
- ❌ Logic in test body to handle different parameter sets differently (if/switch on parameter)
- ❌ Arrays of different lengths — zip silently drops cases
- ❌ Data extracted far from the test body — hurts readability

---

## Test Doubles

| Type | Purpose | Verifies |
|------|---------|----------|
| **Dummy** | Fills parameter lists; never called | Nothing |
| **Fake** | Working but simplified implementation | State after interaction |
| **Stub** | Returns canned answers | Indirect inputs |
| **Spy** | Records calls for later verification | Indirect outputs |
| **Mock** | Pre-programmed expectations | Behavior (was it called correctly?) |

**Use doubles for:** external systems, slow dependencies, non-deterministic services.
**Do NOT use doubles for:** value objects, simple domain logic, immutable data.

**Prefer order:** Fakes → Stubs/Spies → Mocks. Use mocks only when the interaction contract matters.

Over-mocking couples tests to implementation — the #1 anti-pattern in test doubles.

---

## Language Conventions

| Language | Naming | Structure |
|----------|--------|-----------|
| Python | `test_behavior_when_context` | AAA with blank-line separation |
| JS/TS | `it('behavior when context')` | `describe`/`it` blocks |
| Java | `@DisplayName("behavior")` + method | JUnit 5 with `assertAll` |
| Go | `TestBehaviorWhenContext(t *testing.T)` | Table-driven tests |

---

## Flaky Test Prevention

| Cause | Frequency | Fix |
|-------|-----------|-----|
| Async wait issues | ~45% | Replace `sleep()` with condition-based waits + explicit timeouts |
| Shared state pollution | Common | Each test creates its own data; transaction rollback |
| Test order dependencies | Common | Randomize test order; each test self-contained |
| Non-deterministic data | Common | Fixed seeds; mock time/random |

**Never use `sleep()`.** All waits must be condition-based with explicit timeouts.

### Quarantine Protocol for Flaky Tests
1. Move to a non-blocking quarantine suite
2. Assign owner + two-week deadline to fix
3. If not fixed in deadline: delete it — an untrusted test is a liability