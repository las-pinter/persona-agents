---
name: risk-and-dependency-identification
description: >-
  Skill for the planner agent.
  Identify risks, blockers, and dependencies in a plan before finalizing it. Use
  after task decomposition, before finalizing a plan. This skill provides a
  systematic methodology for surfacing hidden risks, mapping dependency chains,
  scoring threats by likelihood and impact, and recommending mitigations. Use it
  whenever a planner asks "what could go wrong?", reviews task dependencies, or
  needs to validate a plan's risk posture before handoff. Do NOT skip this skill
  before finalizing any non-trivial plan — even plans that seem simple often
  hide implicit dependencies or overlooked risks.
---

# Risk and Dependency Identification — Systematic Threat Assessment

A plan without risk analysis is not a plan — it's a wish. This skill gives you
a repeatable methodology to surface what could go wrong, how bad it would be,
and what to do about it. Use it after task decomposition and before plan
finalization.

---

## Methodology Overview

Follow this sequence every time:

```
1. DECOMPOSE   → Break the plan into individual tasks
2. ANALYZE     → For each task, identify risks AND dependencies
3. SCORE       → Rate each risk by likelihood × impact
4. MITIGATE    → Assign mitigations for all medium+ risks
5. FLAG        → Mark high/critical risks for human review
6. MAP CHAINS  → Map dependency chains and find the critical path
```

---

## Step 1: Risk Identification — What Could Go Wrong?

For EVERY task in the plan, systematically check each risk category.

### Risk Categories

| Category | What to Look For | Example Questions |
|----------|-----------------|-------------------|
| **Technical** | Architecture, performance, tech debt, security, compatibility | Is the approach proven? Are there performance constraints? Any security implications? |
| **Schedule** | Estimates, sequencing, bottlenecks, deadlines | Are estimates realistic? Is this on the critical path? What if it slips? |
| **Resource** | People, tooling, budget, access, knowledge | Does the right person exist? Do we need special access? Is there a knowledge gap? |
| **External** | Third-party APIs, vendors, open-source deps, regulatory | Does this depend on an external system? What if the API changes? Any legal/regulatory concerns? |
| **Integration** | Contract mismatches, data format changes, API versioning | Are the integration points well-defined? What if formats change? |
| **Operational** | Deployment, monitoring, rollback, incident response | How do we deploy this? Can we roll back? What happens when it breaks at 3 AM? |
| **Hidden/Implicit** | Assumptions that haven't been validated | What are we assuming that isn't true? What's the single point of failure? |

### Prompting Questions (per task)

If you're stuck, run through these:

- **Novelty:** Is this something the team has done before, or is it new territory?
- **Complexity:** Does this task hide sub-tasks? Is it estimated as "large"?
- **Coupling:** Does this task touch shared code, data, or infrastructure?
- **External reliance:** Does this task need something outside the team's control?
- **Timing:** Is there a hard deadline? A dependency chain that leaves no buffer?
- **Failure mode:** If this task fails or is delayed, what's the blast radius?
- **Knowledge gap:** Does someone need to learn something new to complete this?

---

## Step 2: Dependency Identification — What Must Happen First?

For EVERY task, identify what it truly depends on — not just the obvious things.

### Dependency Types

| Type | Description | Example |
|------|-------------|---------|
| **Internal** | Other tasks within this plan | Task B needs Task A's API to be ready |
| **External** | Teams, services, or systems outside the plan | Needs database migration from Platform Team |
| **Implicit** | Shared resources or timing constraints | Two tasks modify the same schema — merge conflicts |
| **Transitive** | Dependencies of dependencies | A→B→C means A truly depends on C too |
| **Informational** | A decision or spec that must exist first | Need UX mockup before building the form |
| **Environmental** | Infrastructure, access, or tooling needed | Need staging environment deployed first |

### Dependency Chain Mapping

For plans with 3+ tasks, draw the dependency chain and find the **critical path**:

```
Task A ──→ Task B ──→ Task D ──→ Task E  (critical path = A → B → D → E)
    └──→ Task C ──┘
```

The longest chain of dependencies is your **critical path** — any delay on this
path directly delays the entire plan. Flag it.

### Transitive Dependency Check

If Task A depends on Task B, and Task B depends on Task C, then Task A
**truly** depends on Task C. Surface transitive dependencies explicitly —
they're the ones most often missed.

### Implicit Dependency Detection

Ask these questions to surface hidden dependencies:

- Do any two tasks modify the same files, schemas, or configurations?
- Do any tasks share a resource (database, environment, API key)?
- Could task ordering cause conflicts?
- Is there a shared service that both tasks depend on?
- Do tasks have contradictory requirements (e.g., one needs stability, another needs upgrades)?

---

## Step 3: Risk Scoring — How Bad Is It?

Score every identified risk using the **Likelihood × Impact** matrix.

### Likelihood Scale

| Level | Definition | Guide |
|-------|-----------|-------|
| **Rare** | <10% chance | Would require unusual circumstances |
| **Unlikely** | 10-30% chance | Possible but not expected |
| **Possible** | 30-60% chance | Could happen in normal conditions |
| **Likely** | 60-90% chance | Expected under normal conditions |
| **Almost Certain** | >90% chance | Will happen unless actively prevented |

### Impact Scale

| Level | Definition | Example |
|-------|-----------|---------|
| **Negligible** | Minimal effect, no delay | Cosmetic issue, fixable in minutes |
| **Minor** | Small delay or extra effort | 1-2 day delay, workaround exists |
| **Moderate** | Notable delay or rework | 1-week delay, partial rework needed |
| **Major** | Significant delay or scope change | Multi-week delay, architecture change |
| **Critical** | Blocks completion or causes failure | Plan cannot complete, data loss, security incident |

### Risk Score Matrix

| Likelihood ↓ Impact → | Negligible | Minor | Moderate | Major | Critical |
|----------------------|-----------|-------|----------|-------|----------|
| **Almost Certain** | Medium | High | **Critical** | **Critical** | **Critical** |
| **Likely** | Low | Medium | High | **Critical** | **Critical** |
| **Possible** | Low | Medium | High | High | **Critical** |
| **Unlikely** | Low | Low | Medium | Medium | High |
| **Rare** | Low | Low | Low | Medium | High |

**Action by score:**
- **Critical** → MUST flag for human review. Blocking if unmitigated.
- **High** → MUST have a mitigation plan. Flag for human review.
- **Medium** → Should have a mitigation plan or explicit acceptance.
- **Low** → Note and move on. Acceptable without action.

---

## Step 4: Mitigation Strategies — What Do We Do About It?

For every Medium+ risk, assign a mitigation from one of five strategies:

| Strategy | When to Use | Example |
|----------|------------|---------|
| **AVOID** | When you can eliminate the risk entirely | Choose a different, proven technology instead of an experimental one |
| **MITIGATE** | When you can reduce likelihood or impact | Add monitoring, implement retry logic, build fallback paths |
| **TRANSFER** | When someone else can handle it better | Use a managed service instead of self-hosting; get insurance |
| **ACCEPT** | When the cost of mitigation exceeds the risk | Low-impact, unlikely risks — document and move on |
| **CONTINGENCY** | When you need a plan B if the risk materializes | "If API X goes down, fall back to batch processing" — only activated on trigger |

### Writing Good Mitigations

A good mitigation answers: **What exactly will we do, when, and who will do it?**

| ❌ Weak | ✅ Strong |
|---------|-----------|
| "Will monitor it" | "Add uptime monitoring with PagerDuty alert if latency exceeds 500ms for 5 minutes — owned by SRE team" |
| "Will test it" | "Add integration tests for the fallback path before deploying to production" |
| "Have a backup plan" | "If the vendor API is down for >10 minutes, switch to cached responses and notify users via status page" |
| "Hope it works" | (Never acceptable. Not a mitigation.) |

---

## Step 5: Output Format — The Risk Register

Consolidate everything into a risk register table.

### Standard Risk Register

| Risk/Dependency | Type | Score (L×I) | Impact | Mitigation |
|----------------|------|-------------|--------|------------|
| Third-party API rate limits | external | Likely × Moderate = **High** | API calls fail under load | Implement queuing + retry with exponential backoff |
| Task 2 shares DB schema with Task 1 | implicit | Possible × Major = **High** | Merge conflicts, data corruption | Sequence tasks: Task 1 completes schema changes before Task 2 starts |
| Team unfamiliar with GraphQL | technical | Likely × Minor = **Medium** | Slow implementation, poor design | Schedule 2-day GraphQL workshop before implementation starts |

### Critical Path Annotation

For plans with dependency chains, add a critical path section:

```
CRITICAL PATH: Task A → Task B → Task D → Task E (4 tasks, estimated 10 days)
  ⚠ Any delay on this chain pushes the entire plan. Consider:
  - Adding buffer to Task B (highest complexity on critical path)
  - Parallelizing Task C (off the critical path — safe to de-prioritize)
```

---

## Step 6: Human Review Triggers

Flag the plan for human review when ANY of these are true:

- **Critical risks exist** — Score is Critical per the matrix
- **Unmitigated High risks** — High score without a concrete mitigation
- **Circular dependencies** — Task A → B → A (impossible to schedule)
- **Missing information** — "Unknown" likelihood or impact on a significant risk
- **Critical path is too long** — Critical path exceeds 80% of total schedule
- **External blocker** — Plan depends on an unconfirmed external commitment

---

## Examples

### Good Example

Given a plan to add a payment processing feature:

```
Tasks:
1. Integrate Stripe API (medium)
2. Build checkout UI (medium, depends on Task 1)
3. Set up webhook handler (small, depends on Task 1)
4. Add refund flow (small, depends on Task 3)
```

**Risk analysis output:**

| Risk/Dependency | Type | Score | Impact | Mitigation |
|----------------|------|-------|--------|------------|
| Stripe API rate limits or breaking changes | external | Possible × Major = **High** | Payments fail, revenue loss | Use Stripe's idempotency keys; monitor API changelog; pin API version |
| Task 3 (webhooks) must handle duplicates | technical | Likely × Moderate = **High** | Duplicate charge events cause double-processing | Make webhook handler idempotent — check event ID before processing |
| PCI compliance | external | Unlikely × Critical = **High** | Legal liability, fines | Use Stripe Elements (card data never touches our server); document compliance approach |
| Poor test coverage for payment flows | operational | Possible × Moderate = **High** | Bugs reach production | Mandate integration tests for all payment flows; add sandbox testing |
| Checkout UI depends on Stripe API | transitive | — | Medium | Task 2 (UI) truly depends on both Task 1 AND Stripe — if Stripe has an outage, UI is blocked |

```
CRITICAL PATH: Task 1 → Task 3 → Task 4 (3 tasks)
  ⚠ Task 4 (refunds) blocked until webhooks work. Consider parallelizing.
```

### Bad Example — What NOT to Do

```markdown
## Risks
| Risk | Type | Impact | Mitigation |
|------|------|--------|------------|
| API might go down | external | high | Will monitor it |
| Tasks might have conflicts | internal | medium | Will be careful |
```

**Why it's bad:**
- Vague risk descriptions — "API might go down" doesn't say which API or why
- No likelihood assessment — "high impact" without probability means nothing
- Mitigations are not actionable — "Will monitor it" is not a plan
- Missing critical risks — payment processing without PCI compliance or idempotency?
- No dependency analysis — transitive dependencies not surfaced
- No critical path identified

---

## Integration with Plan Output Template

When this skill produces output, format it for copy-paste into:
- Feature Plan → `Risks & Blockers` table
- Bugfix / Refactor / Integration Plan → `Risks & Blockers` section
- Multi-Phase Plan → Phase-specific + cross-phase risks

---

## Rules & Guidelines

1. **Flag for human review** — Critical risks, circular deps, and unmitigated
   High risks must be reviewed before the plan is handed off.
2. **"Hope" is not a mitigation** — Every mitigation must describe an action,
   not a wish.
3. **Update risks when the plan changes** — A new task can introduce new risks
   and invalidate old ones.
