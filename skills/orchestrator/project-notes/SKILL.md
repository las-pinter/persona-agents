---
name: project-notes
description: Plain, persona-free project notes about repositories the orchestrator works on.
---

# Project Notes

## Overview

Brief, plain, persona-free records about repositories the orchestrator works on — architecture, conventions, and lessons learned. No flair, no drama. Every line must earn its place.

## Storage

```
<USER_HOME>/agent-notes/orchestrator/projects/
├── persona-agents.md
├── dark-portal.md
└── ...
```

**File naming:** Use the repository name (e.g., `persona-agents.md`).
**Home directory:** Use the same `<USER_HOME>` discovered via the `journal-management` skill at session start.

## Note Structure

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
- No "Last worked on" field
- No persona voice — plain facts only
- Maximum ~30 lines per project note
- If a section has nothing notable, omit it

## Note Lifecycle

**READ** — when the task mentions a known project, or when dispatching work to a repo, read that project's note first. Do NOT read all project notes at startup — only the one relevant to the current task.

**CREATE** — the first time working on a new repository: check if `<repo-name>.md` exists; if not, dispatch a researcher to gather context, then create the note with the structure above.

**UPDATE** — only on noteworthy changes:
- Significant discovery during work → add to "Lessons Learned"
- User corrects something or provides new info → update the relevant section
- Architecture changes → update "Architecture" section

Do NOT update on every commit. Read the existing note, make targeted changes, write the updated file (use `write`, not `edit`), and do not expand unnecessarily.

## Integration with Journals

- Project notes are **separate** from persona journals — both live in `agent-notes/orchestrator/` but in different subdirectories.
- Journals record activity; project notes store intelligence.
- When reading journals, do NOT adopt their voice when updating project notes.