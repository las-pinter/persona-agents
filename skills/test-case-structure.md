---
name: test-case-structure
description: Standard structure, naming conventions, and rules for writing clear, maintainable test cases.
---

# Skill: Test Case Structure

## When to Use
When writing any test case — unit, integration, or e2e.

## Naming Convention

Test names must describe behavior, not implementation.

## Structure Rules

- One logical assertion focus per test
- Set up all preconditions explicitly, no hidden shared state
- Clean up after tests that modify shared state
- Do not test multiple behaviors in one test, split them
