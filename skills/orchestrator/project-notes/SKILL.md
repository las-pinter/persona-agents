---
name: project-notes
description: >-
  Skill for the orchestrator agent.
  Manages plain, persona-free project notes about repositories.
  Read when working on a known project. Update on significant discoveries or user corrections.
---

# Project Notes

## Overview

Project notes are **brief, plain, persona-free** records about repositories the orchestrator works on. They capture architecture, conventions, and lessons learned — without goblin flair or dramatic flair.

## Storage

```
<USER_HOME>/agent-notes/orchestrator/projects/
├── persona-agents.md
├── dark-portal.md
└── ...
```

**File naming:** Use the repository name (e.g., `persona-agents.md`, `dark-portal.md`).
**Home directory:** Use the same `<USER_HOME>` discovered via the `journal-management` skill at session start.

## Note Structure

Keep notes **as brief as possible**. Every line must earn its place.

```markdown
# <repo-name>

## Overview
- **Purpose:** <one-line description>
- **Repo:** <owner/repo or local path>

## Architecture
- <key directories/files and their purpose>

## Conventions
- <commit style, branch naming, code patterns>

## Lessons Learned
- <discoveries, gotchas, what worked>
```

**Rules:**
- No "Last worked on" field — not needed
- No persona voice — plain facts only
- Maximum ~30 lines per project note
- If a section has nothing notable, omit it

## When to READ

| Trigger | Action |
|---------|--------|
| Task mentions a known project | Read that project's note |
| Dispatching work to a repo | Read the relevant note first |

**Do NOT** read all project notes at startup. Only read the one relevant to the current task.

## When to CREATE

| Trigger | Action |
|---------|--------|
| First time working on a new repository | Create a new project note |

Ask the researcher to gather initial context, then create the note.

## When to UPDATE

| Trigger | Action |
|---------|--------|
| Significant discovery during work | Add to "Lessons Learned" |
| User corrects something or provides new info | Update the relevant section |
| Architecture changes | Update "Architecture" section |

**Do NOT update on every commit.** Only update when something noteworthy happens.

## Integration with Journals

- Project notes are **separate** from persona journals
- Journals tell war stories; project notes store intelligence
- Both are in `agent-notes/orchestrator/` but in different subdirectories
- When reading journals, do NOT adopt their voice when updating project notes

## Creating a New Note

1. Check if `<repo-name>.md` exists in the projects directory
2. If not, dispatch a researcher to gather context about the repository
3. Create the note with the structure above
4. Keep it brief — facts only, no fluff

## Updating an Existing Note

1. Read the existing note
2. Make targeted changes to the relevant section
3. Write the updated file (use `write`, not `edit`)
4. Do NOT expand unnecessarily — keep it brief
