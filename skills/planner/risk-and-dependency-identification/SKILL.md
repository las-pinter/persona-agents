---
name: risk-and-dependency-identification
description: >-
  Skill for the planner agent.
  Identify risks, blockers, and dependencies in a plan before finalizing it.
  Use after task-decomposition, before plan-output-template. Do NOT skip this
  before finalizing any non-trivial plan.
---

# Risk and Dependency Identification

## Methodology

```
1. ANALYZE   → For each task, identify risks AND dependencies
2. SCORE     → Rate each risk by likelihood × impact
3. MITIGATE  → Assign mitigations for all Medium+ risks
4. FLAG      → Mark High/Critical risks for human review
5. MAP CHAIN → Map dependency chains and find the critical path
```

---

## Step 1: Risk Identification

For every task, check each risk category:

| Category | What to Look For |
|----------|-----------------|
| **Technical** | Architecture, performance, security, compatibility |
| **Schedule** | Estimates, sequencing, bottlenecks, deadlines |
| **Resource** | People, tooling, access, knowledge gaps |
| **External** | Third-party APIs, vendors, dependencies, regulatory |
| **Integration** | Contract mismatches, data format changes, versioning |
| **Operational** | Deployment, monitoring, rollback, incident response |
| **Hidden/Implicit** | Unvalidated assumptions, single points of failure |

Prompting questions per task:
- Is this something the team has done before, or new territory?
- Does this task touch shared code, data, or infrastructure?
- Does this task need something outside the team's control?
- If this task fails or is delayed, what's the blast radius?
- Does someone need to learn something new to complete this?

---

## Step 2: Dependency Identification

| Type | Description |
|------|-------------|
| **Internal** | Other tasks within this plan |
| **External** | Teams, services, or systems outside the plan |
| **Implicit** | Shared resources or timing conflicts |
| **Transitive** | Dependencies of dependencies (A→B→C means A depends on C) |
| **Informational** | A decision or spec that must exist first |
| **Environmental** | Infrastructure, access, or tooling needed |

### Critical Path

For plans with 3+ tasks, map the dependency chain and find the longest path:

```
Task A ──→ Task B ──→ Task D ──→ Task E  (critical path = A → B → D → E)
    └──→ Task C ──┘
```

Any delay on the critical path delays the entire plan. Flag it explicitly.

**Implicit dependency check** — ask for each pair of tasks:
- Do they modify the same files, schemas, or configs?
- Do they share a resource (database, environment, API key)?
- Do they have contradictory requirements?

---

## Step 3: Risk Scoring (Likelihood × Impact)

### Likelihood

| Level | Chance |
|-------|--------|
| Rare | <10% |
| Unlikely | 10-30% |
| Possible | 30-60% |
| Likely | 60-90% |
| Almost Certain | >90% |

### Impact

| Level | Definition |
|-------|-----------|
| Negligible | Cosmetic, fixable in minutes |
| Minor | 1-2 day delay, workaround exists |
| Moderate | ~1 week delay, partial rework |
| Major | Multi-week delay, architecture change |
| Critical | Blocks completion, data loss, security incident |

### Score Matrix

| Likelihood ↓ Impact → | Negligible | Minor | Moderate | Major | Critical |
|----------------------|-----------|-------|----------|-------|----------|
| Almost Certain | Medium | High | **Critical** | **Critical** | **Critical** |
| Likely | Low | Medium | High | **Critical** | **Critical** |
| Possible | Low | Medium | High | High | **Critical** |
| Unlikely | Low | Low | Medium | Medium | High |
| Rare | Low | Low | Low | Medium | High |

**Required actions by score:**
- **Critical** → Must flag for human review. Blocking if unmitigated.
- **High** → Must have a mitigation plan. Flag for human review.
- **Medium** → Should have a mitigation or explicit acceptance.
- **Low** → Note and move on.

---

## Step 4: Mitigation Strategies

| Strategy | When | Example |
|----------|------|---------|
| **AVOID** | Can eliminate the risk entirely | Use proven tech instead of experimental |
| **MITIGATE** | Reduce likelihood or impact | Add retry logic, implement monitoring |
| **TRANSFER** | Someone else handles it better | Use managed service instead of self-hosting |
| **ACCEPT** | Mitigation cost exceeds risk | Document and move on (Low risks) |
| **CONTINGENCY** | Need a plan B on trigger | "If API X is down >10 min, switch to batch processing" |

A good mitigation answers: **What exactly, when, and who?**
"Hope it works" is not a mitigation.

---

## Output Format: Risk Register

```markdown
## Risks & Blockers

| Risk/Dependency | Type | Score (L×I) | Impact | Mitigation |
|----------------|------|-------------|--------|------------|
| Third-party API rate limits | external | Likely × Moderate = High | API calls fail under load | Queue + retry with exponential backoff |
| Tasks 1 and 2 modify same DB schema | implicit | Possible × Major = High | Merge conflicts | Sequence: Task 1 completes schema before Task 2 starts |

CRITICAL PATH: Task 1 → Task 3 → Task 4
⚠ Any delay on this chain pushes the plan. Task 2 is off the critical path — safe to de-prioritize.
```

---

## Human Review Triggers

Flag for human review when ANY of these are true:
- Critical risks exist (unmitigated)
- High risks without a concrete mitigation
- Circular dependencies (impossible to schedule)
- Unknown likelihood or impact on a significant risk
- Critical path exceeds 80% of total schedule
- Plan depends on an unconfirmed external commitment