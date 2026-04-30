---
name: plan-tracking
description: Track plan completion status and mark plans as done with relevant metadata
---

# Plan Tracking

## When to Use

- After completing work that was based on a planner's plan
- When reviewing existing plans to check completion status
- During journal writing to document plan completion

Orchestrators should track which plans have been executed and mark them as complete with relevant metadata (commits, who did the work, results).

## Plan File Naming Convention

Plans are stored in `{user_home}/agent-notes/planner/plans/` with the format:
- **Active plans:** `YYYY-MM-DD-plan-name.md`
- **Completed plans:** `YYYY-MM-DD-plan-name-DONE.md`
- **Blocked plans:** `YYYY-MM-DD-plan-name-BLOCKED.md`
- **Abandoned plans:** `YYYY-MM-DD-plan-name-ABANDONED.md`

## Marking Plans as Complete

When a plan has been fully executed:

### Step 1: Rename the Plan File

Add `-DONE` suffix before the `.md` extension:
```bash
mv ~/agent-notes/planner/plans/YYYY-MM-DD-plan-name.md \
   ~/agent-notes/planner/plans/YYYY-MM-DD-plan-name-DONE.md
```

### Step 2: Add Completion Metadata

Append a completion section to the end of the plan file:

```markdown

---

## ✅ PLAN COMPLETED

**Completion Date:** YYYY-MM-DD  
**Completed By:** [Agent name and role]  
**Commit ID(s):** 
- abc1234 - "Commit message"
- def5678 - "Another commit message" (if multiple)

**What Was Done:**
- Brief summary of what was implemented
- Key decisions made during execution
- Any deviations from the original plan

**Result:** Final outcome and verification that plan objectives were met
```

### Step 3: Reference in Journal

When writing your daily journal, mention the completed plan:
- "Plan at `{user_home}/agent-notes/planner/plans/YYYY-MM-DD-plan-name-DONE.md` was executed successfully!"
- Include the commit IDs (if there is any) and results

## Checking Plan Status

To see which plans are active vs completed:

```bash
# List all active plans
ls ~/agent-notes/planner/plans/*[^DONE].md

# List all completed plans
ls ~/agent-notes/planner/plans/*-DONE.md

# List all blocked plans
ls ~/agent-notes/planner/plans/*-BLOCKED.md

# List all abandoned plans
ls ~/agent-notes/planner/plans/*-ABANDONED.md
```

## Partial Completion

If a plan is only partially completed:
- Keep the original filename (no `-DONE` suffix)
- Add a `## ⚠️ PARTIAL COMPLETION` section instead
- Document what was done and what remains
- Update the plan with remaining tasks

## Plan Abandonment

If a plan is no longer relevant or was superseded:
- Rename with `-ABANDONED.md` suffix
- Add a section explaining why it was abandoned
- Reference any replacement plans if applicable

## Notes

- Always include commit IDs when marking plans complete, if the there are any (for traceability)
- If multiple agents worked on a plan, credit all of them
- Keep the original plan content intact (append completion metadata, don't modify)
- Completion metadata helps future orchestrators understand what was done and why
