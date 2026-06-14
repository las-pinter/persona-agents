---
name: test-strategy-selection
description: >-
  Skill for the tester agent.
  Choose the right type of tests — unit, integration, contract, e2e, static —
  based on risk, context, and ROI. Load BEFORE planning any test approach.
---

# Test Strategy Selection

## Test Types

| Type | What It Tests | Speed | Confidence | Cost |
|------|--------------|-------|-----------|------|
| **Static analysis** | Types, lint, dead code | ⚡ Instant | Low | $0 |
| **Unit** | Single function/class in isolation | ⚡ ms | Low–Medium | $ |
| **Integration** | Multiple components working together | 🐢 seconds | High | $$ |
| **Contract** | Service boundary compatibility | 🐢 seconds | Medium–High | $$ |
| **End-to-end** | Full user flow through the system | 🐌 minutes | Highest | $$$$ |

---

## The Push-Down Principle

> Write tests at the **lowest level** that gives you the confidence you need.

```
Is a unit test enough?
  YES → Write unit test
  NO  → Is an integration test enough?
          YES → Write integration test
          NO  → Write E2E test
```

Unnecessary elevation adds cost and fragility without adding confidence.

---

## Decision Framework: Which Test Type When?

| Question | Test Type |
|----------|-----------|
| "Does this **function** do what I expect?" | Unit |
| "Do these **components work together**?" | Integration |
| "Is my **API contract** still compatible?" | Contract |
| "Can a **user actually do this thing**?" | E2E |
| "Is my code **well-typed** and lint-free?" | Static |
| "Is this **performance-sensitive** path fast enough?" | Benchmark |
| "Is the **migration reversible**?" | Integration |

---

## Risk-Based Framework

### Step 1: Rate the Risk

| Dimension | 1 (Low) | 2 (Medium) | 3 (High) | 4 (Critical) |
|-----------|---------|------------|----------|--------------| 
| **Business Impact** | Cosmetic, rarely used | Minor feature | Core feature, revenue-impacting | Safety-critical, financial, PII |
| **Failure Probability** | Stable, tested | Occasional changes | High churn, complex logic | New code, external deps, concurrency |

### Step 2: Score = Business Impact × Failure Probability

| Score | Testing Requirement |
|-------|---------------------|
| 1-4 | Minimal — smoke tests, unit only |
| 5-6 | Standard — unit + integration |
| 7-9 | Thorough — unit + integration + contract |
| 10-16 | Extensive — unit + integration + contract + E2E |

### Step 3: Allocate Effort

| Category | Budget | Examples |
|----------|--------|---------|
| 🔴 Critical (10-16) | 40% | Payment, auth, data integrity |
| 🟠 High (7-9) | 30% | Search, user management |
| 🟡 Medium (5-6) | 20% | Profiles, notifications |
| 🟢 Low (1-4) | 10% | Admin panels, logging |

---

## Cost/Benefit Reference

| Dimension | Unit | Integration | Contract | E2E |
|-----------|------|-------------|----------|-----|
| Execution speed | ⚡ ms | 🐢 seconds | 🐢 seconds | 🐌 minutes |
| Write cost | $ | $$ | $$ | $$$$ |
| Maintenance cost | $ | $$ | $ | $$$$ |
| Debugging signal | ✅ Precise | ✅ Good | ✅ Good | ❌ Noisy |
| Flakiness | 🟢 Very low | 🟢 Low | 🟢 Very low | 🔴 High |

---

## Test Shapes

| Shape | Ratio | Best For |
|-------|-------|----------|
| **Pyramid** | 70% Unit / 20% Integration / 10% E2E | Monoliths, logic-heavy apps |
| **Trophy** | Static + Unit + fat Integration + thin E2E | Component-driven frontends |
| **Honeycomb** | Many Integration + Contract, few Unit + E2E | Microservices |

The shape debate is mostly semantic. What matters: tests are fast, reliable, and catch meaningful failures.

---

## Strategy by Codebase Context

**Greenfield:** Start with pyramid (70/20/10). Invest in test infrastructure early — Testcontainers, CI pipeline, sharding.

**Legacy (untested):** Write a test before every bug fix; write a test before every refactor; start with integration tests — they give more value when boundaries are unclear.

**Monolith:** Classic pyramid. Resist the temptation to write E2E tests because they're "easy."

**Microservices:** Contract testing is the linchpin. Unit + Contract dominate; minimize E2E.

---

## CI/CD Integration

| Trigger | Tests to Run |
|---------|-------------|
| Every commit (branch) | Lint, unit, type check |
| Pull request open/update | + Integration, impact-analyzed regression |
| Merge to main | + Contract, component tests |
| Deploy to staging | + E2E (critical paths) |
| Deploy to production | + Smoke tests |

**Hard gates** (pipeline fails): test failures, critical security vulns, build errors.
**Soft gates** (warning only): coverage drops, medium-severity findings.

---

## Coverage Targets

Use as signals, not goals:

| Code Type | Target | Test Level |
|-----------|--------|------------|
| Business logic | 90%+ branch | Unit |
| API handlers | 80%+ line | Unit + Integration |
| Utility/pure functions | 95%+ | Unit |
| Critical UI components | 60%+ | Integration |

**Speed budgets:**
- Unit: < 30s total, < 10ms per test
- Integration: < 3min total, 50-500ms per test
- E2E: < 10min total, 2-30s per test

---

## Core Rules

1. Push down — write at the lowest level that gives confidence
2. Don't write E2E tests for things unit tests can cover
3. Mock external deps in unit tests; use real ones in integration tests
4. Contract tests over E2E for service boundaries — cheaper, faster, less flaky
5. Coverage is a signal, not a goal — 100% with no assertions is worthless