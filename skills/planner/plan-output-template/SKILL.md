---
name: plan-output-template
description: >-
  Skill for the planner agent.
  Standard template for producing a final plan ready to hand off to a developer.
  Provides plan type templates, quality gates, and validation scripts.
  Do NOT hand off raw, unvalidated plans — always run plan-validate.sh first.
---

# Plan Output Template

## Plan Types

### Feature Plan

```markdown
# YYYY-MM-DD - <Feature Name>

## Objective
What problem does this feature solve? Why does it matter? (2-3 sentences)

## Tasks

### Task 1: <Name> (<complexity>)
**Dependencies:** None / Task X
**Acceptance:** <verifiable condition>
**Details:** <implementation notes>

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

```markdown
# YYYY-MM-DD - Bugfix: <Bug Description>

## Bug Description
What's broken? How do we reproduce it? What's the expected behavior?

## Root Cause
<what's causing the bug — only if already identified>

## Tasks

### Task 1: Reproduce (<complexity>)
**Dependencies:** None
**Acceptance:** Can consistently reproduce in a dev environment
**Details:** <steps, environment setup>

### Task 2: Implement Fix (<complexity>)
**Dependencies:** Task 1
**Acceptance:** Bug no longer reproduces; existing tests still pass
**Details:** <approach, files to change>

### Task 3: Add Regression Tests (<complexity>)
**Dependencies:** Task 2
**Acceptance:** Test covers the bug scenario; all tests pass in CI
**Details:** <test strategy>

## Risks & Blockers
- <anything that could complicate the fix>

## Open Questions
- [ ] <question> — owner: <name>
```

### Refactor Plan

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
**Details:** <refactoring approach>

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
**Acceptance:** Integration metrics visible; alerts configured
**Details:** <metrics, alert thresholds>

## Risks & Blockers
- <external API changes, rate limits, auth changes>

## Open Questions
- [ ] <question> — owner: <name>
```

### Multi-Phase Plan

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

## Quality Gate Checklist

Every plan must pass all of these before handoff:

- [ ] **Title** — Clear, descriptive level-1 heading
- [ ] **Date** — Filename prefix matches creation date (`YYYY-MM-DD-`)
- [ ] **Objective** — Answers WHAT, WHY, and success criteria
- [ ] **Tasks** — Each task is independently completable
- [ ] **Acceptance Criteria** — Every task has a verifiable condition (not "works correctly")
- [ ] **Complexity Estimates** — Every task has `small` / `medium` / `large`
- [ ] **Dependencies** — Mapped correctly; no circular dependencies
- [ ] **Risks** — At least one risk identified, or explicitly "None identified"
- [ ] **High-Impact Risks** — Flagged for human review

### Acceptance Criteria Reference

| ❌ Weak | ✅ Strong |
|---------|-----------|
| "Works correctly" | "Login returns 200 with JWT for valid credentials" |
| "UI looks good" | "Submit button is 48px tall; errors appear in red below inputs" |
| "Fast enough" | "API responds within 200ms at p95 under 100 concurrent requests" |
| "Handles errors" | "Returns 400 with `{error: string}` for invalid input; 429 for rate limiting" |

### Quality Gate Failures

| Issue | Action |
|-------|--------|
| Missing acceptance criteria | Return to planner — task is not verifiable |
| Missing complexity estimate | Return to planner — cannot estimate effort |
| Circular dependencies | Return to planner — restructure tasks |
| Unresolved high-impact open questions | Resolve before handoff or get explicit approval |