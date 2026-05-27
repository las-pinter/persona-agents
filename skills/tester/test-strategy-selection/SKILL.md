---
name: test-strategy-selection
description: >-
  Skill for the tester agent.
  Choose the right type of tests before writing any — unit, integration,
  contract, e2e, or static — based on risk, context, and ROI. Use before
  writing any tests to determine the appropriate testing strategy. Covers
  modern test shapes (pyramid, trophy, honeycomb), risk-based decision
  frameworks, CI/CD integration, cost/benefit analysis by test type, and
  codebase context guidance. NOT optional when planning test approach.
---

# Test Strategy Selection

## When to Use

- **Always** before writing tests — choose the right type first
- When deciding how to test a new feature, change, or system
- When evaluating existing test coverage gaps
- When a test type isn't giving you the expected ROI
- When defining the testing approach for a new project or service

---

## Modern Test Landscape

### Test Types Defined

| Type | What It Tests | Speed | Confidence | Cost |
|------|--------------|-------|-----------|------|
| **Static analysis** | Types, lint, formatting, dead code | ⚡ Instant | Low | $0 |
| **Unit** | Single function/class in isolation | ⚡ ms | Low–Medium | $ |
| **Integration** | Multiple components working together | 🐢 seconds | High | $$ |
| **Contract** | Service boundary compatibility | 🐢 seconds | Medium–High | $$ |
| **End-to-end** | Full user flow through the system | 🐌 minutes | Highest | $$$$ |

### The Shapes of Testing (Which Shape Fits Your Context)

| Shape | Ratio | Best For |
|-------|-------|----------|
| **🏛️ Pyramid** (Cohn) | 70% Unit / 20% Integration / 10% E2E | Monoliths, logic-heavy apps, traditional web apps |
| **🏆 Trophy** (Dodds) | Static + Unit + fat Integration + thin E2E | Component-driven frontends, React/Vue apps |
| **🍯 Honeycomb** (Spotify) | Many Integration + Contract, few Unit + E2E | Microservices, network-heavy architectures |
| **💎 Diamond / Skyscraper** | Heavy Integration/Service, narrow Unit + E2E | Cloud-native, API-heavy applications |

**Core insight from Martin Fowler:** The shape debate is mostly semantic. What matters is that tests are fast, reliable, and catch meaningful failures. Focus on that instead.

**From Emily Bache (2026) — Test Desiderata 2.0:**
Beyond shapes, aim for four properties:
1. **Fast** — tests run quickly
2. **Cheap** — low cost to write and maintain
3. **Predictive** — catches bugs that matter
4. **Supporting** — enables refactoring and design changes

---

## The "Push Down" Principle

> **Write tests at the lowest level that gives you the confidence you need.**

```
     Is a unit test enough?
     /                  \
    YES                  NO
     |                   |
  Write unit         Is an integration test enough?
  test                    /              \
                       YES                NO
                        |                  |
                    Write              Write E2E
                    integration         test
                    test
```

- If a **unit test** will catch the bug → write a unit test (don't write integration/E2E)
- If an **integration test** will catch it → write an integration test (don't write E2E)
- If only an **E2E test** covers the real risk → write an E2E test (don't rely on lower levels)
- Unnecessary elevation adds cost and fragility without adding confidence

---

## Decision Framework: Which Test Type When?

### By Question and Scope

| Question You're Asking | Test Type | When to Use |
|------------------------|-----------|-------------|
| "Does this **function** do what I expect?" | **Unit** | Behavior within a single function/module |
| "Do these **components work together**?" | **Integration** | Real DB, queue, or cache interactions |
| "Is my **API contract** still compatible?" | **Contract** | Behavior at the boundary of two services |
| "Can a **user actually do this thing**?" | **E2E** | Full system flow or critical user journey |
| "Is my code **well-typed** and lint-free?" | **Static** | Every commit — zero runtime cost |
| "Is this **performance-sensitive** path fast enough?" | **Benchmark** | Performance-critical code paths |
| "Is the **migration reversible**?" | **Integration** | Migration forward + rollback verification |

---

## Risk-Based Decision Framework

Score each feature or change area on two dimensions:

### Step 1: Rate the Risk

| Dimension | 1 (Low) | 2 (Medium) | 3 (High) | 4 (Critical) |
|-----------|---------|------------|----------|--------------|
| **Business Impact** | Cosmetic, rarely used | Minor feature, internal tool | Core feature, revenue-impacting | Safety-critical, financial, PII |
| **Failure Probability** | Stable code, no changes | Occasional changes, tested area | High churn, complex logic | New code, external dependencies, concurrency |

### Step 2: Calculate Risk Score

> **Risk Score = Business Impact × Failure Probability**

| Score | Category | Testing Requirement |
|-------|----------|-------------------|
| **1-4** | 🟢 Low | Minimal — smoke tests, unit only |
| **5-6** | 🟡 Medium | Standard — unit + integration |
| **7-9** | 🟠 High | Thorough — unit + integration + contract |
| **10-16** | 🔴 Critical | Extensive — unit + integration + contract + E2E |

### Step 3: Allocate Effort

| Category | Effort | Examples |
|----------|--------|---------|
| 🔴 Critical | 40% of test budget | Payment processing, authentication, data integrity |
| 🟠 High | 30% | Search, recommendations, user management |
| 🟡 Medium | 20% | Profile pages, notifications, reporting |
| 🟢 Low | 10% | Admin panels, internal tools, logging |

---

## Cost/Benefit Analysis

| Dimension | Unit | Integration | Contract | E2E |
|-----------|------|-------------|----------|-----|
| Execution speed | ⚡ ms | 🐢 seconds | 🐢 seconds | 🐌 minutes |
| Write cost | $ Low | $$ Medium | $$ Medium | $$$$ High |
| Maintenance cost | $ Low | $$ Medium | $ Low | $$$$ High |
| Debugging signal | ✅ Precise | ✅ Good | ✅ Good | ❌ Noisy |
| Flakiness | 🟢 Very low | 🟢 Low | 🟢 Very low | 🔴 High |
| Catches | Logic bugs | Interface/DB bugs | API incompatibility | System wiring issues |

### Key Economic Insights

- **Unit tests** are ~100× cheaper to write and ~100× faster to run than E2E tests (Mike Cohn)
- **Integration tests** give the best ROI for most modern applications (Google Testing Blog; Cohn)

---

## Strategy by Codebase Context

### Greenfield (New Project)
- Start with **70/20/10 pyramid** as default
- Invest in test infrastructure early (Testcontainers, CI pipeline, test sharding)
- Establish contract tests from day one if microservices are planned

### Legacy Code (Untested, High Debt)
1. **Write a test before every bug fix** — regression safety net
2. **Write a test before every refactor** — characterization tests capture current behavior
3. **Write integration tests first** — they give more value per test than unit tests when boundaries are unclear

### Monolith
- Classic pyramid works well — heavy unit tests, integration tests for module boundaries
- ⚠️ Danger: E2E tests can balloon because they're "easy" to write — **resist this**
- Modular monolith: treat internal module boundaries with contract-test rigor

### Microservices
- **Pyramid focus flips**: Unit + Contract tests dominate; E2E is minimized
- **Contract testing is the linchpin** — verifies API compatibility without deploying both services
- Use **consumer-driven contracts** (Pact) to detect breaking changes pre-deployment

### Hybrid (Monolith → Microservices Migration)
- Use the **Strangler Pattern**: extract services incrementally
- Contract testing protects new microservice boundaries
- Integration tests verify sync between old monolith and extracted services

---

## CI/CD Integration

### Test Selection by Trigger

| Trigger | Tests to Run |
|---------|-------------|
| Every commit (branch) | Lint, unit, type check |
| Pull request open/update | + Integration, impact-analyzed regression |
| Merge to main | + Contract, component tests |
| Deploy to staging | + E2E (critical paths) |
| Deploy to production | + Smoke tests |

### Quality Gates

- **Hard gates** 🚫: Pipeline fails — test failures, critical security vulns, build errors
- **Soft gates** ⚠️: Warning logged — coverage drops, medium-severity findings
- Reserve hard gates for issues that directly impact production safety

---

## Coverage Targets (by Test Type)

Use these as signals, not goals:

| Code Type | Coverage Target | Test Level |
|-----------|----------------|------------|
| Business logic modules | 90%+ branch coverage | Unit |
| API handlers | 80%+ line coverage | Unit + Integration |
| Utility/pure functions | 95%+ | Unit |
| UI components (critical) | 60%+ | Integration (component tests) |

### Speed Budgets

| Layer | Max Total Time | Per-Test Budget |
|-------|---------------|-----------------|
| Unit tests | < 30 sec | < 10ms |
| Integration tests | < 3 min | 50-500ms |
| E2E tests | < 10 min | 2-30s |

---

## Rules

1. **Push down** — write tests at the lowest level that gives confidence
2. **Don't write E2E tests for things unit tests can cover** — they're slow and brittle
3. **Mock external dependencies in unit tests**; use real ones in integration tests
4. **Contract tests over E2E for service boundaries** — cheaper, faster, less flaky
5. **Integration tests are the default for most modern apps** — best confidence per dollar
6. **Revisit the strategy quarterly** — as the codebase evolves, the optimal balance shifts
7. **Coverage is a signal, NOT a goal** — 100% coverage with no assertions is "code tourism"
