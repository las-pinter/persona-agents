---
name: plan-output-template
description: >-
  Skill for the planner agent.
  Standard template for producing a final plan ready to hand off to a developer
  or executor. Use this skill whenever a planner finalizes a plan, produces
  output for handoff, or needs to validate that a plan meets quality standards
  before dispatching tasks. This skill provides multiple plan type templates,
  quality gates, automation scripts for validation, and seamless integration
  with the plan-tracking lifecycle system. Do NOT hand off raw, unvalidated
  plans — always run through at least one quality gate check first.
---

# Plan Output Template — Complete Plan Production System

A plan is only as good as its output. This skill gives you everything you need
to produce plans that implementers can actually execute: battle-tested
templates, quality gates, validation scripts, and smooth handoff to the
plan-tracking system.

---

## Quick Start

```bash
# Validate a plan before handoff
plan-validate.sh path/to/plan.md

# Render a plan for different audiences
plan-render.sh path/to/plan.md                     # Default full plan
plan-render.sh path/to/plan.md --summary            # Condensed overview
plan-render.sh path/to/plan.md --handoff            # Implementer view
```

Always validate before handoff. Always integrate with plan-tracking.

---

## Plan Lifecycle Integration

This skill works hand-in-hand with the **plan-tracking** skill. Plans flow
through a defined lifecycle:

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  PLANNER    │────▶│ PLAN OUTPUT  │────▶│  PLAN TRACKING   │
│ (decomposes │     │ (this skill) │     │ (track lifecycle)│
│  tasks)     │     │ validate &   │     │ list/mark/verify │
│             │     │ render       │     │ report           │
└─────────────┘     └──────────────┘     └──────────────────┘
                           │
                           ▼
                   ┌──────────────┐
                   │IMPLEMENTER   │
                   │(executes     │
                   │ tasks)       │
                   └──────────────┘
```

### Integration Points

1. **Plan creation** — Use this skill to produce the final plan output
2. **Plan validation** — Run `plan-validate.sh` before handoff
3. **Plan handoff** — Pass validated plan to plan-tracking system
4. **Plan tracking** — Use `plan-mark.sh` from plan-tracking to track status
5. **Plan completion** — Reference the plan in journals with `plan-report.sh --journal`

The filename convention must match plan-tracking expectations:
`YYYY-MM-DD-<plan-name>.md` (date prefix = creation date).

---

## Plan Types

Different types of work need slightly different plan structures. Choose the
right template for the job.

### Feature Plan

Use when adding new functionality. Focuses on what the user/system can do
that it couldn't before.

```markdown
# YYYY-MM-DD - <Feature Name>

## Objective
What problem does this feature solve? Why does it matter? (2-3 sentences)

## Tasks

### Task 1: <Name> (<complexity>)
**Dependencies:** None / Task X
**Acceptance:** <verifiable condition — how will we know it's done?>
**Details:** <implementation notes, key design decisions>

### Task 2: <Name> (<complexity>)
**Dependencies:** Task 1
**Acceptance:** <verifiable condition>
**Details:** <implementation notes>

## Risks & Blockers

| Risk | Type | Score | Impact | Mitigation |
|------|------|-------|--------|------------|
| ... | internal/external/implicit | Likely × Major = High | high/med/low | ... |

## Open Questions
- [ ] <question> — owner: <name>
```

### Bugfix Plan

Use when fixing a defect. Focuses on reproduction, root cause, and
verification of the fix.

```markdown
# YYYY-MM-DD - Bugfix: <Bug Description>

## Bug Description
What's broken? How do we reproduce it? What's the expected behavior?

## Root Cause
<what's causing the bug — only if already identified>

## Tasks

### Task 1: Reproduce <complexity>
**Dependencies:** None
**Acceptance:** Can consistently reproduce the bug in a dev environment
**Details:** <steps to reproduce, environment setup>

### Task 2: Implement Fix <complexity>
**Dependencies:** Task 1
**Acceptance:** Bug no longer reproduces; existing tests still pass
**Details:** <approach, files to change>

### Task 3: Add Regression Tests <complexity>
**Dependencies:** Task 2
**Acceptance:** Test covers the bug scenario; all tests pass in CI
**Details:** <test strategy — unit, integration, e2e>

## Risks & Blockers
- <anything that could complicate the fix>

## Open Questions
- [ ] <question> — owner: <name>
```

### Refactor Plan

Use when improving existing code without changing external behavior. Focuses
on preserving behavior while improving structure.

```markdown
# YYYY-MM-DD - Refactor: <Target>

## Objective
What's being refactored and why? What improvements are expected?

## Behavior Preservation
What must NOT change? How will we verify behavior is preserved?

## Tasks

### Task 1: <Name> (<complexity>)
**Dependencies:** None / Task X
**Acceptance:** <verifiable condition — behavior preserved>
**Details:** <refactoring approach, patterns to use>

### Task 2: Update Tests (<complexity>)
**Dependencies:** Task 1
**Acceptance:** All existing tests pass; new coverage added where needed
**Details:** <test changes needed>

## Risks & Blockers
- <anything that could introduce regressions>

## Open Questions
- [ ] <question> — owner: <name>
```

### Integration Plan

Use when integrating with external systems or APIs. Focuses on contracts,
error handling, and fallback behavior.

```markdown
# YYYY-MM-DD - Integration: <External System>

## Objective
What system are we integrating with? What does success look like?

## Integration Contract
- **API Version:** <version>
- **Authentication:** <method>
- **Rate Limits:** <limits>
- **Data Format:** <format>

## Tasks

### Task 1: <Name> (<complexity>)
**Dependencies:** None / Task X
**Acceptance:** <verifiable condition>
**Details:** <implementation notes>

### Task 2: Error Handling & Fallbacks (<complexity>)
**Dependencies:** Task 1
**Acceptance:** Timeouts, rate limits, and error responses handled gracefully
**Details:** <retry strategy, fallback behavior>

### Task 3: Monitoring & Alerting (<complexity>)
**Dependencies:** Task 1
**Acceptance:** Integration metrics visible in dashboards; alerts configured
**Details:** <metrics to track, alert thresholds>

## Risks & Blockers
- <external API changes, rate limits, auth changes>

## Open Questions
- [ ] <question> — owner: <name>
```

### Multi-Phase Plan

Use for large efforts that span multiple phases or releases. Each phase is
independently deliverable.

```markdown
# YYYY-MM-DD - <Campaign Name>

## Objective
What's the overall goal? Why multiple phases?

## Phase 1: <Name> (Target: <date>)

### Tasks
| # | Task | Depends On | Complexity | Acceptance |
|---|------|------------|------------|------------|
| 1 | ... | — | small | ... |
| 2 | ... | #1 | medium | ... |

### Phase 1 Risks
- <risks specific to this phase>

## Phase 2: <Name> (Target: <date>)

### Tasks
| # | Task | Depends On | Complexity | Acceptance |
|---|------|------------|------------|------------|
| 1 | ... | — | medium | ... |
| 2 | ... | #1 | large | ... |

### Phase 2 Risks
- <risks specific to this phase>

## Cross-Phase Risks
- <risks that span multiple phases>

## Open Questions
- [ ] <question> — owner: <name>
```

---

## Template Section Guidance

Each section of a plan has a specific purpose. Here's how to write each one well.

### Objective

The objective must answer three questions:
1. **What** are we building or changing?
2. **Why** does it matter? (What problem does it solve?)
3. **How** will we know it's done? (Success criteria)

Good: "Add OAuth2 authentication using Google and GitHub providers so users can
log in without creating yet another username/password. Success: users can
authenticate via either provider and access their existing account."

Bad: "Implement authentication." (Too vague — what kind? For whom? How?)

### Tasks

Every task must be:

- **Independently completable** — Can this task be done without waiting for
  work outside this plan? If not, it needs a dependency or should be split.
- **Verifiably done** — The acceptance criteria must be testable. "Works
  correctly" is not acceptance criteria. "Login form validates email format
  and shows error message for invalid input" is.
- **Estimated** — Use complexity labels: small (< 2h), medium (2-8h), large
  (> 8h). Large tasks should be decomposed further.

**Dependencies:**
- Use task numbers from the plan (e.g., `Task 1`, `Task 3`)
- "None" means the task has no internal dependencies (may still have external
  ones — list those in Risks)
- Circular dependencies are NOT allowed. If Task A depends on B and B depends
  on A, the tasks need to be restructured.

### Risks & Dependencies

Use the table format consistently:

| Risk/Dependency | Type | Score | Impact | Mitigation |
|-----------------|------|-------|--------|------------|
| Third-party API rate limits | external | Likely × Major = High | high | Implement queuing + retry logic |

**Type:** internal (within this plan), external (outside this plan),
implicit (shared resources, timing)

**Impact:** high (blocks completion), medium (slows down), low (minor)
High-impact risks must be flagged for human review.

**Mitigation:** What will we do if this risk materializes? "Hope it works" is
not a mitigation.

### Open Questions

Track unresolved items that could affect the plan:

- Every question should have an **owner** assigned — someone responsible for
  answering it
- Questions with high impact on task ordering or design should be resolved
  BEFORE the plan is handed off
- Do NOT hand off a plan with unresolved high-impact open questions

---

## Quality Gates

Before a plan is handed off to an implementer, it must pass these quality
gates. These are the MINIMUM standard — a plan that fails any gate should be
sent back to the planner for revision.

### Minimum Viable Plan Checklist

- [ ] **Title** — Clear, descriptive title as level-1 heading
- [ ] **Date** — Date prefix in filename matches creation date (YYYY-MM-DD-)
- [ ] **Objective** — Answers WHAT, WHY, and success criteria
- [ ] **Tasks** — Each task is independently completable
- [ ] **Acceptance Criteria** — Every task has a verifiable acceptance
  criterion (NOT "works correctly" or "done properly")
- [ ] **Complexity Estimates** — Every task has a complexity label
  (small/medium/large)
- [ ] **Dependencies** — Mapped correctly; no circular dependencies
- [ ] **Risks** — At least one risk identified, or explicitly "None identified"
- [ ] **High-Impact Risks** — Flagged for human review

### Quality Gate Failures

| Issue | Action |
|-------|--------|
| Missing acceptance criteria | Return to planner — task is not verifiable |
| Missing complexity estimate | Return to planner — cannot estimate effort |
| Circular dependencies | Return to planner — restructure tasks |
| Unresolved high-impact open questions | Resolve before handoff, or get explicit approval |
| Vague objective | Ask planner for clarification — "what does done look like?" |

### Acceptance Criteria Writing Guide

Acceptance criteria must be OBJECTIVELY VERIFIABLE. Someone reading them
should be able to say "yes, that's done" or "no, it's not" without
interpretation.

| ❌ Weak | ✅ Strong |
|---------|-----------|
| "Works correctly" | "Login succeeds with valid credentials and returns a 200 response with a JWT token" |
| "UI looks good" | "Form fields are centered, submit button is 48px tall, error messages appear in red below input fields" |
| "Fast enough" | "API responds within 200ms for p95 under 100 concurrent requests" |
| "Handles errors" | "Returns 400 with error message in `{error: string}` format for invalid input, 429 for rate limiting" |

---

## Automation Scripts

The skill ships with scripts to validate and render plans. Always use them.

### plan-validate.sh — Validate Plan Structure & Quality

Validates a plan file against the template format and quality gates.

```
plan-validate.sh <plan.md>                   # Full validation
plan-validate.sh <plan.md> --format detailed  # Show detailed results
plan-validate.sh <plan.md> --quiet            # Exit code only (no output)
plan-validate.sh --dir <path>                 # Validate all plans in a dir
plan-validate.sh --help                       # Show help
```

Returns exit code 0 if all checks pass, 1 if any check fails. Use in
automation pipelines to gate plan handoffs.

### plan-render.sh — Render Plan for Different Audiences

Renders a plan in different output formats depending on who needs to see it.

```
plan-render.sh <plan.md>                      # Full plan (default)
plan-render.sh <plan.md> --summary            # Condensed overview
plan-render.sh <plan.md> --handoff            # Implementer-focused view
plan-render.sh <plan.md> --tracking           # Plan-tracking integration format
plan-render.sh --help                         # Show help
```

**Output format selection:**
- `default` for orchestrators (full plan)
- `--summary` for Big Boss (one-line per task + risks + open questions)
- `--handoff` for implementers (tasks by dependency order)
- `--tracking` for plan-tracking import

---

## Examples

### Good Example: Feature Plan

```markdown
# 2026-05-10 - Password Reset Flow

## Objective
Add a password reset flow so users can recover their accounts without
contacting support. Success: users receive a reset email, click a
time-limited link, set a new password, and can log in with it.

## Tasks

### Task 1: Reset Request Endpoint (small)
**Dependencies:** None
**Acceptance:** POST /api/auth/reset-request accepts email, validates it
exists, sends reset email (or returns generic message to prevent email
enumeration)
**Details:** Generate a cryptographically secure token, store hash in DB
with 1-hour expiry

### Task 2: Reset Password Endpoint (small)
**Dependencies:** Task 1
**Acceptance:** POST /api/auth/reset with valid token + new password
updates password and invalidates token; invalid/expired token returns 401
**Details:** Validate token hash, check expiry, hash new password, update DB

### Task 3: Email Integration (medium)
**Dependencies:** Task 1
**Acceptance:** Reset email is sent via configured email provider with
correct link, subject line, and branding
**Details:** Use existing email service; template in /templates/emails/

## Risks & Blockers
| Risk | Type | Score | Impact | Mitigation |
|------|------|-------|--------|------------|
| Email provider rate limits | external | Likely × Moderate = High | medium | Queue emails, retry on failure |
| Token replay attacks | implicit | Possible × Critical = Critical | high | One-time use tokens, invalidate after use |

## Open Questions
- [ ] Should we rate-limit reset requests per email? — owner: Big Boss
```

### Bad Example: What NOT to Do

```markdown
# Plan: Fix stuff

## Goal
Make it work better

## Tasks
| # | Task | Depends On | Complexity | Acceptance Criteria |
|---|------|------------|------------|---------------------|
| 1 | Fix the thing | — | ? | works correctly |
| 2 | Do other stuff | #1 | ? | done properly |

## Risks
None

## Open Questions
None
```

**Why it's bad:**
Every element violates the guidance above — meaningless title, no real objective, unverifiable acceptance criteria, missing estimates, no risks identified, and empty open questions. Nothing here is actionable.

---

## Error Handling

| Situation | Action |
|-----------|--------|
| Plan file not found by script | Provide the full path or use `--dir` |
| Validation fails | Read the specific failures, fix, re-validate |
| Missing required section | Add the section OR explicitly state why it's not needed |
| Plan references external systems | Verify the contracts are documented in the plan |
| Unsure which template to use | Default to Feature Plan — it covers most cases |
| Plan is very large (>10 tasks) | Consider splitting into multiple plans or using Multi-Phase template |


