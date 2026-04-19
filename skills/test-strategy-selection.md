---
name: test-strategy-selection
description: Choose the right type of tests before writing any — unit, integration, or e2e — based on risk and context.
---

# Skill: Test Strategy Selection

## When to Use
Before writing any tests, choose the right type first.

## Test Types

| Type | What it tests | When to use |
|---|---|---|
| Unit | Single function/class in isolation | Core logic, pure functions, edge cases |
| Integration | Multiple components working together | Service boundaries, DB interactions, API calls |
| End-to-end | Full user flow through the system | Critical user journeys, regression safety nets |

## Risk-Based Selection

Focus testing effort where failure is most costly or most likely:
- New/changed code → unit + integration
- Critical user paths → e2e
- External integrations → integration with mocks + contract tests
- Performance-sensitive code → benchmark tests

## Output
State your strategy explicitly before writing tests

## Rules

- Don't write e2e tests for things unit tests can cover — they're slow and brittle
- Mock external dependencies in unit tests; use real ones in integration tests
- If unsure, start with unit tests and add integration tests where units pass but the system still breaks
