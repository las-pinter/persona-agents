---
name: task-decomposition
description: >-
  Skill for the planner agent.
  Break down a feature or requirement into independently completable, estimated,
  dependency-mapped tasks. Use this skill whenever a planner needs to decompose
  ambiguous or large work into executable units. Follow the decision tree for
  granularity guidance, use decomposition patterns for different work types,
  and apply stopping conditions to know when a task is small enough.
---

# Task Decomposition

## When to Use

- When breaking down a feature, epic, bugfix, or refactor into executable tasks
- Before producing a formal plan (use with plan-output-template for formatting)
- After receiving a requirement that is too large to implement in one step

---

## Decomposition Decision Tree

### Q1: What type of work is this?

```
Is this a NEW FEATURE?
  → YES: Decompose by user-facing actions (vertical slices).
         Each task delivers a complete, testable capability.
  → NO:  Proceed below.

Is this a BUGFIX?
  → YES: Decompose by reproduce → root cause → fix → verify → regress.
  → NO:  Proceed below.

Is this a REFACTOR?
  → YES: Decompose by component/module with behavior preservation at each step.
  → NO:  Proceed below.

Is this an INTEGRATION?
  → YES: Decompose by contract: connect → error handling → monitoring.
  → NO:  Generic task — decompose by layer (UI → API → data → infra).
```

### Q2: How do I split?

```
RULE 1 (vertical slicing): Can the work be split by user-facing actions?
  → YES: Each action = one task. Prefer this over horizontal splitting.

RULE 2 (layer separation): Spans multiple architectural layers?
  → YES: One task per layer. Mark dependencies explicitly.

RULE 3 (independent concern): Can you identify sub-concerns?
  → YES: Split by concern. Each concern = one task.
  → NO:  May already be atomic. Check stopping conditions.
```

### Q3: Is this task atomic? (Stopping Conditions)

A task is sufficiently decomposed when ALL conditions are met:

| Condition | Check | How to verify |
|-----------|-------|---------------|
| **Estimable** | Can assign small/medium/large | If you can't estimate, decompose further |
| **Verifiable** | Can write a test that proves it's done | If you can't describe the test, the task is too vague |
| **Independent** | No hidden dependencies on unplanned work | If it requires something not in the plan, surface it |
| **Single responsibility** | No "and" in the task description | If the description has "and", split it |
| **No unknowns** | All key decisions are understood | If uncertain, add a pre-work investigation task |

**Stop decomposing when:**
- The task is small and verifiable
- Further splitting would create tasks too coupled to build independently
- You have at most one level of subtasks (no deep nesting beyond N.N format)

---

## Decomposition Patterns

### Feature (vertical slices)

Split by user-facing action, end-to-end. Each action delivers value independently.

```
Feature: Password Reset Flow
├── Task 1: Add "Forgot Password?" link + request-reset endpoint
├── Task 2: Add reset-password endpoint with token validation
├── Task 3: Add email-sending for reset links
└── Task 4: Add frontend reset-password form
```

**Dependency pattern:** Task 1 ← Task 2 ← Task 4 (Task 3 parallel to Task 1)

### Bugfix (reproduce → root cause → fix → guard)

Split by investigation phase. Never start with "fix" — understand first.

```
Bugfix: Checkout crashes with coupon code "SAVE50"
├── Task 1: Reproduce the bug consistently in dev environment
├── Task 2: Identify root cause
├── Task 3: Implement the fix
└── Task 4: Add regression test for the coupon code path
```

**Dependency pattern:** Sequential. Each task depends on the previous.

### Refactor (component by component)

Split by module. Keep the system shippable at each step.

```
Refactor: Migrate Express routes to Fastify
├── Task 1: Set up Fastify alongside Express with shared middleware
├── Task 2: Migrate /users routes
├── Task 3: Migrate /products routes
├── Task 4: Migrate /orders routes
└── Task 5: Remove Express and cleanup dependencies
```

**Dependency pattern:** Task 1 ← 2,3,4 ← 5. Migration tasks are parallel.

### Integration (contract layers)

Split by interface boundary: establish connection → handle failure → observe.

```
Integration: Stripe Payment Provider
├── Task 1: Implement payment-intent creation endpoint
├── Task 2: Implement webhook handling for payment events
├── Task 3: Add error handling, retries, and fallback flows
└── Task 4: Add monitoring metrics, logging, and alerting
```

**Dependency pattern:** 1 ← 2, 1 ← 3, 2+3 ← 4

---

## Examples

### Good Decomposition

**Request:** "Add a password reset flow so users can recover their accounts."

See the **plan-output-template** skill for a complete password reset example with tasks, estimates, dependencies, and acceptance criteria. Here's a quick summary of the decomposition pattern:

```
Feature: Password Reset Flow
├── Task 1: POST /api/auth/reset-request (small)
├── Task 2: POST /api/auth/reset (small, depends on Task 1)
├── Task 3: Send reset email (medium, depends on Task 1)
└── Task 4: Reset password form (small, depends on Task 2)
```

**Why it works:**
- Each task is ONE user-facing action (request reset, execute reset, email, form)
- Every task has verifiable acceptance criteria
- Dependencies are explicit and acyclic
- All tasks are small, estimable, independently buildable
- No "and" in any task description

### Bad Decomposition

**Request:** "Fix the app performance."

```
# Plan: Fix performance

## Tasks

### Task 1: Optimize everything (huge — 40h)
**Dependencies:** None
**Acceptance:** App is faster
**Details:** Profile and fix all performance issues

### Task 2: Add tests (medium — 8h)
**Dependencies:** Task 1
**Acceptance:** More tests exist
**Details:** Add tests
```

**Why it fails:**
- Task 1 is a monolith — not estimable, not verifiable, hides all complexity
- "App is faster" is not acceptance criteria
- No root cause investigation task
- Tests are an afterthought, not integrated
- Dependencies are meaningless — what does "optimize everything" even mean?

---

## Integration with Planner Pipeline

Task decomposition is the **first step** in the planner workflow. Follow this sequence:

```
1. DECOMPOSE (this skill)
   → Output: task list with estimates + dependencies + acceptance criteria

2. IDENTIFY RISKS (risk-and-dependency-identification skill)
   → Output: risk table mapped to task IDs

3. FORMAT OUTPUT (plan-output-template skill)
   → Choose the right template (Feature/Bugfix/Refactor/Integration)
   → Validate with: plan-validate.sh <plan.md>

4. TRACK EXECUTION (plan-tracking skill)
   → Plans tracked in ~/agent-notes/planner/plans/
   → Status managed via: plan-mark.sh, plan-list.sh, plan-verify.sh
```

Each skill in the pipeline produces structured output consumed by the next.
Do not skip steps — a plan without risk identification is incomplete.

---

## Rules

1. **Surface unknowns, don't bury them** — If a task has unresolved questions,
   list them. Don't assume they'll sort themselves out during implementation.
2. **Max one level of nesting** — Tasks can have subtasks, but subtasks of
   subtasks indicate over-engineering. Flatten into a single level.

---

## Anti-patterns

| Anti-pattern | Looks like | Instead do |
|-------------|-----------|------------|
| **The monolith** | One task: "Implement X" (large, no details) | Split into user-facing actions |
| **The layer cake** | "DB" → "API" → "UI" for every feature | Vertical slices — full stack per action |
| **The hidden research** | "Investigate and implement" in one task | Separate investigation from execution |
| **The silent unknown** | No open questions section | Surface all unknowns explicitly |
