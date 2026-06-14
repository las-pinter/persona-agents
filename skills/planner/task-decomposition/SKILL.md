---
name: task-decomposition
description: >-
  Skill for the planner agent.
  Break down a feature or requirement into independently completable, estimated,
  dependency-mapped tasks. Use whenever decomposing ambiguous or large work into
  executable units. Load FIRST for any planning work.
---

# Task Decomposition

## Decomposition Decision Tree

### Q1: What type of work is this?

```
NEW FEATURE?   → Decompose by user-facing actions (vertical slices).
                 Each task delivers a complete, testable capability.

BUGFIX?        → Decompose as: reproduce → root cause → fix → regression test.

REFACTOR?      → Decompose by component/module with behavior preserved at each step.

INTEGRATION?   → Decompose by contract: connect → error handling → monitoring.

OTHER?         → Decompose by layer: UI → API → data → infra.
```

### Q2: How do I split?

```
RULE 1 (vertical slicing): Can the work be split by user-facing actions?
  → YES: Each action = one task. Prefer this over horizontal splitting.

RULE 2 (layer separation): Spans multiple architectural layers?
  → YES: One task per layer. Mark dependencies explicitly.

RULE 3 (independent concern): Can you identify sub-concerns?
  → YES: One task per concern.
  → NO:  May already be atomic. Check stopping conditions.
```

### Q3: Is this task atomic? (Stopping Conditions)

Stop decomposing when ALL of these are true:

| Condition | Check |
|-----------|-------|
| **Estimable** | Can assign small / medium / large |
| **Verifiable** | Can describe a test that proves it's done |
| **Independent** | No hidden dependency on unplanned work |
| **Single responsibility** | No "and" in the task description |
| **No unknowns** | All key decisions are understood |

If uncertain about a task, add a pre-work investigation task rather than assuming.

---

## Decomposition Patterns

### Feature (vertical slices)

Split by user-facing action, end-to-end. Each action delivers value independently.

```
Feature: Password Reset Flow
├── Task 1: POST /api/auth/reset-request endpoint (small)
├── Task 2: POST /api/auth/reset endpoint with token validation (small, depends on Task 1)
├── Task 3: Send reset email (medium, depends on Task 1)
└── Task 4: Frontend reset-password form (small, depends on Task 2)
```

Dependency pattern: Task 1 ← Task 2 ← Task 4 (Task 3 parallel to Task 1)

### Bugfix (reproduce → root cause → fix → guard)

Never start with "fix" — understand first.

```
Bugfix: Checkout crashes with coupon code "SAVE50"
├── Task 1: Reproduce consistently in dev environment (small)
├── Task 2: Identify root cause (small, depends on Task 1)
├── Task 3: Implement fix (small, depends on Task 2)
└── Task 4: Add regression test (small, depends on Task 3)
```

Dependency pattern: sequential.

### Refactor (component by component)

Keep the system shippable at each step.

```
Refactor: Migrate Express routes to Fastify
├── Task 1: Set up Fastify alongside Express with shared middleware (medium)
├── Task 2: Migrate /users routes (small, depends on Task 1)
├── Task 3: Migrate /products routes (small, depends on Task 1)
├── Task 4: Migrate /orders routes (small, depends on Task 1)
└── Task 5: Remove Express and clean up dependencies (small, depends on Tasks 2-4)
```

Dependency pattern: Tasks 2, 3, 4 are parallel; Task 5 depends on all three.

### Integration (contract layers)

Split by interface boundary.

```
Integration: Stripe Payment Provider
├── Task 1: Implement payment-intent creation endpoint (medium)
├── Task 2: Implement webhook handler for payment events (medium, depends on Task 1)
├── Task 3: Error handling, retries, fallback flows (small, depends on Tasks 1-2)
└── Task 4: Monitoring metrics, logging, alerting (small, depends on Tasks 1-2)
```

---

## Anti-Patterns

| Anti-pattern | Looks like | Instead |
|-------------|-----------|---------|
| **The monolith** | "Implement X" (large, no details) | Split into user-facing actions |
| **The layer cake** | DB → API → UI for every feature | Vertical slices — full stack per action |
| **Hidden research** | "Investigate and implement" in one task | Separate investigation from execution |
| **Silent unknown** | No open questions | Surface all unknowns explicitly |
| **Deep nesting** | Tasks with subtasks of subtasks | Max one level of nesting (N.N format) |