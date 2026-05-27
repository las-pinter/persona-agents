---
name: plan-tracking
description: >-
  Skill for the orchestrator agent.
  Complete plan lifecycle management system — track, verify, and report on plans
  from creation through completion. Use this skill whenever an orchestrator or
  planner creates plans, marks them done, needs to check which plans are active
  vs completed, writes journals referencing plan work, or needs to verify plan
  integrity. This is the CENTRAL system for all plan tracking — always use it
  when tracking progress, generating plan reports, or verifying that completed
  work matches plan commitments. Do NOT manage plans manually; always use the
  scripts and workflows documented here.
---

# Plan Tracking — Complete Plan Lifecycle Management

Orchestrators **must** track which plans have been created, are in progress, are
blocked, or are completed. This skill provides a complete system with automation
scripts, verification checks, and journal integration.

The core idea: every plan follows a lifecycle. It starts as an **active** plan,
then transitions to one of three terminal states: **done** (completed
successfully), **blocked** (stuck on a dependency), or **abandoned** (no longer
relevant). The scripts in `scripts/` automate every transition.

---

## Quick Start

```bash
# See what plans exist and their status
plan-list.sh

# Verify a plan has proper structure and valid commit refs
plan-verify.sh

# Mark a plan as done
plan-mark.sh path/to/plan.md --status done --commits "abc1234 - Fixed the thing"

# Generate a full status report
plan-report.sh
```

---

## Plan Lifecycle

```
                     ┌──────────────┐
                     │   CREATED    │
                     │  (new plan)  │
                     └──────┬───────┘
                            │
                     ┌──────▼───────┐
                     │   ACTIVE     │
                     │ (in progress)│
                     └──────┬───────┘
                            │
              ┌─────────────┼────────────┐
              │             │            │
       ┌──────▼──────┐ ┌────▼────┐ ┌─────▼─────┐
       │   DONE      │ │ BLOCKED │ │ ABANDONED │
       │  completed  │ │  stuck  │ │ no longer │
       │             │ │         │ │ relevant  │
       └─────────────┘ └─────────┘ └───────────┘
```

### Lifecycle Rules

1. Every plan starts **active** (filename: `YYYY-MM-DD-<name>.md`) and lives in `<USER_HOME>/agent-notes/planner/plans/`
2. Active plans transition to exactly **one** terminal state, appending the suffix: `-DONE.md`, `-BLOCKED.md`, or `-ABANDONED.md`
3. Terminal states are **final** — a done plan should not be resumed (create a new plan)
4. Blocked plans may later be moved to abandoned if the blocker is permanent
5. All transitions must include metadata explaining the **why**
6. The date prefix MUST match the date the plan was **created**, not the date it was completed. This ensures stable filenames and chronological sorting.


---

## Automation Scripts

The skill ships with four scripts in `scripts/`. Learn them, use them,
**love them**.

### plan-list.sh — List Plans by Status

```
plan-list.sh                    # All plans grouped by status
plan-list.sh --status active    # Only active plans
plan-list.sh --status done      # Only completed plans
plan-list.sh --status blocked   # Only blocked plans
plan-list.sh --status abandoned # Only abandoned plans
plan-list.sh --format detailed  # Show descriptions and metadata
```

Use this when you need a quick overview before reporting to the user, writing a
journal entry, or deciding what to work on next.

### plan-mark.sh — Mark a Plan with a Status

```
# Mark done
plan-mark.sh <plan.md> --status done \
  --commits "abc1234 - Added login | def5678 - Added tests" \
  --by "Mekboy Wrenchbasha" \
  --results "Full authentication flow implemented and tested"

# Mark blocked
plan-mark.sh <plan.md> --status blocked \
  --reason "Waiting on API credentials from third party"

# Mark abandoned
plan-mark.sh <plan.md> --status abandoned \
  --reason "Requirements changed, superseded by new auth plan"
```

This script **automatically** renames the file and appends structured metadata.
Always prefer this over manual renaming — it ensures consistency.

### plan-verify.sh — Verify Plan Integrity

```
plan-verify.sh                                 # Check all plans
plan-verify.sh <plan-file>                      # Check one plan
plan-verify.sh --fix                            # Auto-fix common issues
```

This checks:
- File exists and is non-empty
- Has a proper markdown heading
- Filename has a date prefix
- Status suffix is consistent with content
- Commit references actually exist in git history

**Always run `plan-verify.sh --fix` periodically** to catch and repair issues
before they compound.

### plan-report.sh — Generate a Status Report

```
plan-report.sh                     # Full report to stdout
plan-report.sh --output report.md  # Write to file
plan-report.sh --journal           # Journal-friendly format
```

The journal format is designed to be pasted directly into daily journal entries.
Use this when writing your end-of-day journal to document plan progress.

---

## Creating Good Plans

Plans should be written by a planner agent (see `task-routing` for planner
selection). When a plan arrives, the orchestrator MUST verify:

### Plan Template

When a planner produces a plan, verify it follows this structure:

```markdown
# YYYY-MM-DD - <Plan Title>

## Objective
What problem does this solve? Why does it matter?

## Tasks
### Task 1: <Name> (Xh)
**Dependencies:** None / Task X
**Acceptance:** <how to verify>
**Details:** <implementation notes>

### Task 2: <Name> (Xh)
**Dependencies:** Task 1
**Acceptance:** <how to verify>
**Details:** <implementation notes>

## Risks & Blockers
- <anything that could slow this down>

## Notes
- <additional context>
```

### Plan Quality Gates

Every plan must pass these checks:

- **Title** — Clear, descriptive level-1 heading
- **Date** — Date prefix in filename matches creation date
- **Objective** — What problem does this plan solve? (1-2 sentences)
- **Tasks** — Broken into independently completable units with estimates
- **Dependencies** — What must happen before each task can start
- **Acceptance criteria** — How will we know each task is done?
- **Risks** — What could go wrong? (see risk-and-dependency-identification skill)

Do NOT accept a plan if:
- Tasks lack clear acceptance criteria
- Estimates are missing or obviously wrong (e.g., "build whole app: 1h")
- Dependencies are missing or circular
- The plan references files, repos, or systems that don't exist
- No risk assessment was done

When a plan fails quality gates, send it back to the planner with specific
feedback using the `task-routing` skill to select the right planner type.

---

## Marking Plans Complete

### When to Mark Complete

Mark a plan as **done** when ALL of these are true:
1. All tasks in the plan have been executed
2. A reviewer has confirmed the work (use `task-routing` to dispatch a reviewer)
3. Commit IDs are known (if code was written)
4. The user (Big Boss) has seen and acknowledged the results

### When NOT to Mark Complete

- **Partial work** — Use "Partial Completion" (see below) instead
- **User hasn't reviewed yet** — Wait for confirmation
- **Reviewer found issues** — Fix issues first, then mark done

### Completion Metadata

When marking a plan complete with `plan-mark.sh`, the script appends:

```markdown
---

## ✅ PLAN COMPLETED

**Completion Date:** YYYY-MM-DD
**Completed By:** [Agent name and role]
**Commit ID(s):**
- abc1234 - "Commit message"
- def5678 - "Another commit message"

**What Was Done:**
- Brief summary of what was implemented
- Key decisions made during execution

**Result:** Final outcome and verification that objectives were met
```

If doing this manually, use the exact same format. Consistency matters — future
orchestrators will read these.

---

## Partial Completion

If a plan is only partially done (some tasks finished, some remaining):

- **DO NOT** rename the file (keep it active)
- **DO** append a section at the bottom:

```markdown
---

## ⚠️ Partial Progress (YYYY-MM-DD)

**Completed:**
- [x] Task 1: Done (commit abc1234)

**Remaining:**
- [ ] Task 2: In progress
- [ ] Task 3: Not started

**Reason for partial status:** <why it's not finished>
```

This keeps the plan visible in the active list while documenting progress.

---

## Plan Blocking

When a plan is blocked by an external dependency:

```bash
plan-mark.sh <plan.md> --status blocked \
  --reason "Waiting on third-party API keys" \
  --by "Orchestrator Name"
```

The script appends:

```markdown
---

## 🔒 PLAN BLOCKED

**Date Blocked:** YYYY-MM-DD
**Identified By:** [Agent name]

**Reason:**
Waiting on third-party API keys to proceed with integration.

**Blocking Dependencies:**
- (List what's needed to unblock)
```

Update the blocking dependencies with specific, actionable items so another
agent or the user can unblock the plan.

---

## Plan Abandonment

When a plan is no longer relevant:

```bash
plan-mark.sh <plan.md> --status abandoned \
  --reason "Requirements changed, replaced by plan X" \
  --by "Orchestrator Name"
```

**Good reasons to abandon:**
- Requirements changed fundamentally
- The problem was solved another way
- The plan was superseded by a newer, better plan
- The priority shifted and the plan is no longer needed

**Bad reasons (don't abandon, use partial instead):**
- "It was too hard" — mark as blocked, not abandoned
- "Ran out of time" — mark as partial, not abandoned
- "Forgot about it" — check if still relevant first

---

## Plan Verification

**Always verify plans periodically.** The `plan-verify.sh` script catches:

| Issue | Severity | Fix |
|-------|----------|-----|
| Empty plan file | ERROR | Delete or fill in content |
| Missing date prefix | WARNING | Rename file |
| DONE without completion date | WARNING | Run with `--fix` |
| DONE without commit IDs | WARNING | Add commit references |
| BLOCKED without reason | WARNING | Add blocking reason |
| ABANDONED without reason | WARNING | Add abandonment reason |
| Commit ref not in git | WARNING | Verify commit hash is correct |
| Missing heading | WARNING | Add a title |

Run `plan-verify.sh --fix` regularly to auto-correct missing metadata.

---

## Journal Integration

When writing daily journals, always reference plan status:

### Did you complete a plan today?

```markdown
- **Plan completed:** `YYYY-MM-DD-plan-name-DONE.md` was executed successfully!
  - Commit(s): abc1234, def5678
  - What was done: <brief summary>
```

### Did you make progress on a plan?

```markdown
- **Plan progress:** `YYYY-MM-DD-plan-name.md` — Task 2 completed, Task 3 in progress
```

### Need a quick plan summary for your journal?

```bash
plan-report.sh --journal
```

This outputs a ready-to-paste status block for your daily journal entry.

---

## Plan Review Workflow

When an implementer finishes work based on a plan, follow this sequence:

1. **Implementer** does the work (dispatched via `task-routing`)
2. **Reviewer** checks the work (dispatched via `task-routing`)
3. **Orchestrator** runs `plan-verify.sh` on the plan
4. **Orchestrator** marks the plan complete with `plan-mark.sh --status done`
5. **Orchestrator** references the completed plan in the daily journal
6. **Orchestrator** optionally generates a report with `plan-report.sh`

This ensures nothing is marked done until verified.

---

## Error Handling

| Situation | Action |
|-----------|--------|
| Plan file not found by script | Provide the full path or use `--dir` |
| Plan already has a status suffix | Don't re-mark — check current status first |
| Script fails / permission error | Check file permissions, retry |
| plan-verify finds bad commit refs | Verify the commit hash is correct — typos happen |
| Directory doesn't exist | Create it with `mkdir -p <USER_HOME>/agent-notes/planner/plans` |
| Unsure what a plan covers | Read the plan file before marking it |

When in doubt, **read the plan file first**. The scripts are helpers, not
replacements for understanding the context.

---

## Plan File Cleanup

Periodically (weekly or monthly), review the plan directory for:

1. **Old active plans** — Are they still relevant? Block or abandon them if not.
2. **Incomplete metadata** — Run `plan-verify.sh --fix` to catch and repair.
3. **Duplicate plans** — If two plans cover the same goal, consolidate or abandon one.
4. **Stale blocked plans** — Check if blockers have been resolved; unblock or abandon.

A clean plan directory makes everyone's job easier.

---

## Script Reference

Located at: `<skill-base>/scripts/`

| Script | Purpose | Key Flags |
|--------|---------|-----------|
| `plan-list.sh` | List plans by status | `--status`, `--format`, `--dir` |
| `plan-mark.sh` | Change plan status | `--status`, `--commits`, `--by`, `--results`, `--reason`, `--dry-run` |
| `plan-verify.sh` | Check plan integrity | `--dir`, `--fix` |
| `plan-report.sh` | Generate status report | `--output`, `--journal` |

All scripts support `--help` for detailed usage.

---

## Summary — Core Rules

1. **Every plan gets tracked** — no orphan plans floating around
2. **Use the scripts** — they ensure consistency across all plans
3. **Verify before marking done** — always run `plan-verify.sh` first
4. **Always include metadata** — commit IDs, who did it, what was done, when
5. **Reference plans in journals** — future orchestrators need the context
6. **Keep the directory clean** — run `plan-report.sh` and `plan-verify.sh --fix` regularly
7. **When in doubt, read the plan file** — the plan itself has the full context
