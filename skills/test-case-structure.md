---
name: test-case-structure
description: Standard structure, naming conventions, and rules for writing clear, maintainable test cases.
---

# Skill: Test Case Structure

## When to Use
When writing any test case — unit, integration, or e2e.

## Structure: Given / When / Then

```
Given [precondition — the state of the world before the action]
When  [action — what the code does]
Then  [expected outcome — what should be true after]
```

## Naming Convention

Test names must describe behavior, not implementation:

- ✅ `returns_empty_list_when_no_items_match`
- ✅ `throws_validation_error_when_email_is_missing`
- ❌ `test_function_1`
- ❌ `test_getUserById_works`

Format: `[expected behavior]_when_[condition]` or `[method]_[scenario]_[expected result]`

## Structure Rules

- One logical assertion focus per test
- Set up all preconditions explicitly — no hidden shared state
- Clean up after tests that modify shared state
- Do not test multiple behaviors in one test — split them

## Example

```
// Given a user repository with one active user
// When querying by a non-existent ID
// Then it returns null, not an error
test('returns_null_when_user_id_does_not_exist', () => {
  const repo = new UserRepository([activeUser]);
  const result = repo.findById('nonexistent-id');
  expect(result).toBeNull();
});
```
