---
name: plan-tracking
description: >-
  Skill for the orchestrator agent.
  Complete plan lifecycle management — track, verify, and report on plans from
  creation through completion. Use whenever creating plans, marking them done,
  checking active vs completed status, or verifying plan integrity.
  Do NOT manage plans manually; always use the scripts documented here.
---

# Plan Tracking

## Plan Lifecycle

```
                     ┌──────────────┐
                     │   CREATED    │
                     └──────┬───────┘
                            │
                     ┌──────▼───────┐
                     │   ACTIVE     │
                     └──────┬───────┘
                            │
              ┌─────────────┼────────────┐
              │             │            │
       ┌──────▼──────┐ ┌────▼────┐ ┌─────▼─────┐
       │   DONE      │ │ BLOCKED │ │ ABANDONED │
       └─────────────┘ └─────────┘ └───────────┘
```

### Lifecycle Rules

1. Every plan starts **active** (`YYYY-MM-DD-<name>.md`) in `<USER_HOME>/agent-notes/planner/plans/`
2. Active plans transition to exactly one terminal state by appending `-DONE.md`, `-BLOCKED.md`, or `-ABANDONED.md`
3. Terminal states are **final** — do not resume a done plan; create a new one
4. All transitions must include metadata explaining the why
5. The date prefix MUST match the **creation date**, not the completion date

---

## Scripts

### plan-list.sh — List Plans by Status

```
plan-list.sh                    # All plans grouped by status
plan-list.sh --status active    # Only active plans
plan-list.sh --status done
plan-list.sh --status blocked
plan-list.sh --status abandoned
plan-list.sh --format detailed  # Show descriptions and metadata
```

### plan-mark.sh — Transition Plan Status

```bash
# Mark done
plan-mark.sh <plan.md> --status done \
  --commits "abc1234 - Fixed the thing | def5678 - Added tests" \
  --by "Agent Name" \
  --results "What was accomplished"

# Mark blocked
plan-mark.sh <plan.md> --status blocked \
  --reason "Waiting on API credentials from third party"

# Mark abandoned
plan-mark.sh <plan.md> --status abandoned \
  --reason "Requirements changed, superseded by new plan"
```

Always prefer this script over manual renaming — it ensures consistent metadata.

### plan-verify.sh — Check Plan Integrity

```
plan-verify.sh              # Check all plans
plan-verify.sh <plan.md>    # Check one plan
plan-verify.sh --fix        # Auto-fix common issues
```

Checks: file exists, has markdown heading, date prefix present, status suffix consistent, commit references exist in git history.

Run `plan-verify.sh --fix` periodically to catch and repair issues.

### plan-report.sh — Generate Status Report

```
plan-report.sh                     # Full report to stdout
plan-report.sh --output report.md  # Write to file
plan-report.sh --journal           # Journal-friendly format (paste into daily journal)
```

---

## Marking Plans Complete

Mark **done** only when ALL of these are true:
1. All tasks in the plan have been executed
2. A reviewer has confirmed the work
3. Commit IDs are known (if code was written)
4. The user has seen and acknowledged the results

### Completion Metadata (appended by plan-mark.sh)

```markdown
---

## ✅ PLAN COMPLETED

**Completion Date:** YYYY-MM-DD
**Completed By:** [Agent name and role]
**Commit ID(s):**
- abc1234 - "Commit message"

**What Was Done:**
- Brief summary of what was implemented

**Result:** Final outcome and verification that objectives were met
```

---

## Partial Completion

If some tasks are done and some remain — do NOT rename the file. Append instead:

```markdown
---

## ⚠️ Partial Progress (YYYY-MM-DD)

**Completed:**
- [x] Task 1: Done (commit abc1234)

**Remaining:**
- [ ] Task 2: In progress
- [ ] Task 3: Not started

**Reason:** <why it's not finished>
```

---

## Plan Blocking & Abandonment

```bash
plan-mark.sh <plan.md> --status blocked \
  --reason "Waiting on third-party API keys"
```

Blocked plans append:

```markdown
## 🔒 PLAN BLOCKED

**Date Blocked:** YYYY-MM-DD
**Reason:** <what's blocking>
**Blocking Dependencies:** <specific, actionable items needed to unblock>
```

**Good reasons to abandon:** requirements changed fundamentally; problem solved another way; superseded by a newer plan.
**Do not abandon:** because it was hard (use blocked); because you ran out of time (use partial).

---

## Verification Issues Reference

| Issue | Severity | Fix |
|-------|----------|-----|
| Empty plan file | ERROR | Delete or fill in content |
| Missing date prefix | WARNING | Rename file |
| DONE without completion date | WARNING | Run with `--fix` |
| DONE without commit IDs | WARNING | Add commit references |
| BLOCKED without reason | WARNING | Add blocking reason |
| ABANDONED without reason | WARNING | Add abandonment reason |
| Commit ref not in git | WARNING | Verify commit hash |

---

## Plan Review Workflow

1. **Implementer** completes the work
2. **Reviewer** confirms the work
3. **Orchestrator** runs `plan-verify.sh`
4. **Orchestrator** runs `plan-mark.sh --status done`
5. **Orchestrator** references the completed plan in the daily journal

---

## Script Reference

| Script | Purpose | Key Flags |
|--------|---------|-----------|
| `plan-list.sh` | List plans by status | `--status`, `--format`, `--dir` |
| `plan-mark.sh` | Transition plan status | `--status`, `--commits`, `--by`, `--results`, `--reason`, `--dry-run` |
| `plan-verify.sh` | Check plan integrity | `--dir`, `--fix` |
| `plan-report.sh` | Generate status report | `--output`, `--journal` |