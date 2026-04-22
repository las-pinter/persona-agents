---
name: test-case-structure
description: Language-agnostic structure, naming conventions, and rules for writing clear, maintainable test cases.
---

# Test Case Structure

## When to Use
When writing any test case — unit, integration, or e2e — in any programming language.

## Universal Principles

### 1. Describe Behavior, Not Implementation

Test names describe WHAT the code does, not HOW it does it.

**Behavior** = observable outcome meaningful to users/domain experts
**Implementation** = internal mechanics, method calls, data structures

❌ Bad (implementation-focused):
- `callsDatabaseQuery`
- `loopsThrough_array`
- `test_uses_cache_first`

✅ Good (behavior-focused):
- `returnsUserWhenIdExists`
- `returns_empty_list_when_no_results_found`
- `ReturnsNotFoundForMissingResource`

### 2. Three Essential Components

Every test name should answer:
- **Context**: What state/input/scenario?
- **Action**: What behavior is triggered?
- **Outcome**: What should happen?

### 3. Readability Over Convention

Test names are documentation. Prioritize clarity over brevity or rigid patterns.

## Naming Patterns

These patterns work in any language. Adapt syntax to your language conventions.

### Pattern 1: Given-When-Then
```
// JavaScript/TypeScript
it('returns error when cart is empty')

# Python
test_given_empty_cart_when_checkout_then_raises_error

// Java
givenEmptyCart_whenCheckout_thenRaisesError()

// C#
GivenEmptyCart_WhenCheckout_ThenRaisesError()

// Rust
fn empty_cart_checkout_raises_error()
```

### Pattern 2: Condition-Outcome
```
// JavaScript
it('rejects payment when balance insufficient')

# Python
test_insufficient_balance_rejects_payment

// Java
insufficientBalance_rejectsPayment()

// C#
InsufficientBalance_RejectsPayment()

// Go
TestInsufficientBalanceRejectsPayment
```

### Pattern 3: Behavior Description
```
// JavaScript
describe('User Login', () => {
  it('succeeds with valid credentials')
})

# Python
test_login_succeeds_with_valid_credentials

// Java
@DisplayName("Login succeeds with valid credentials")
loginSucceedsWithValidCredentials()

// C#
Login_ValidCredentials_Succeeds()

// Rust
fn login_succeeds_with_valid_credentials()
```

## What to Avoid

- Fluff words: "Correctly", "Properly", "Valid"
- Redundant prefixes: "Test" (unless framework requires)
- Implementation details: exception types, method names
- Testing multiple scenarios in one test
- Magic values without context

## Structure Rules

- **One behavior per test** — split multiple assertions into separate tests
- **Explicit setup** — no hidden shared state
- **Clean teardown** — restore state after modifications
- **Clear phases** — Arrange/Act/Assert or Given/When/Then

### Good Structure (Pseudocode)

```
test: calculate_total_with_discount
  // Arrange
  cart = createCart(items: [item1, item2])
  discount = 0.1
  
  // Act
  total = cart.calculateTotal(discount)
  
  // Assert
  expect(total).equals(90.0)
```

### Bad Structure (Multiple Behaviors)

```
test: cart_operations
  cart.addItem(item1)
  expect(cart.count).equals(1)      // Testing add
  cart.removeItem(item1)
  expect(cart.count).equals(0)      // Testing remove
  total = cart.calculateTotal()
  expect(total).equals(0)           // Testing calculate
```

Split into three separate tests:
- `addingItemIncreasesCount`
- `removingItemDecreasesCount`
- `emptyCartTotalIsZero`

## Language-Specific Adaptations

Follow your language's conventions for syntax while maintaining universal principles:

- **Python**: `test_behavior_with_context_produces_outcome`
- **JavaScript/TypeScript**: `it('behavior with context produces outcome')`
- **Java**: `behaviorWithContext_producesOutcome()` or `@DisplayName("...")`
- **C#**: `Behavior_Context_Outcome()`
- **Go**: `TestBehaviorWithContextProducesOutcome`
- **Rust**: `fn behavior_with_context_produces_outcome()`

The structure is universal. The syntax adapts.
