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
├── <project>/
│   ├── summary.md          — short summary, the most important things (STRICT max ~30 lines)
│   ├── features/           — one note per feature
│   │   └── <plain-slug>.md (e.g. regexp-tool-permissions.md)
│   ├── bugs/               — one note per bug currently being worked on
│   │   └── <plain-slug>.md
│   └── tech/               — technical details / reverse-engineering documents
│       └── <plain-slug>.md
```

**Folder naming:** One folder per repository/project; folder name = repository name.
**File naming:** Plain slugs only — no date prefixes (e.g., `regexp-tool-permissions.md`, `opencode-permission-engine.md`).
**Home directory:** Use the same `<USER_HOME>` discovered via the `journal-management` skill at session start.

## Note Structure

Each project has a `summary.md`:

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
- Maximum ~30 lines per `summary.md` (STRICT)
- Feature, bug, and tech notes: maximum 300 lines each (hard ceiling). If a note cannot fit in 300 lines, SPLIT the topic into multiple notes or restructure it — never grow past the ceiling.
- If a section has nothing notable, omit it

## Note Lifecycle

**READ** — when a task mentions a known project, read that project's `summary.md` first, plus any relevant feature/bug/tech notes for the task at hand. Do NOT read all project notes at startup — only the ones relevant to the current task.

**CREATE** — the first time working on a new repository: check if the project folder exists; if not, dispatch a researcher to gather context, then create the project folder and `summary.md`; create subfolders (`features/`, `bugs/`, `tech/`) only as needed.

**UPDATE** — only on noteworthy changes:
- Significant discovery during work → add to "Lessons Learned" or create a `tech/` note
- User corrects something or provides new info → update the relevant section
- Architecture changes → update "Architecture" section

Do NOT update on every commit. Read the existing note, make targeted changes, write the updated file (use `write`, not `edit`), and do not expand unnecessarily.

**Bug/feature completion** — bug notes live in `bugs/` only while the bug is actively worked on. When resolved, remove the note (history lives in the journals). Once a feature is shipped/completed, its note may be removed or consolidated.

## Integration with Journals

- Project notes are **separate** from persona journals — both live in `agent-notes/orchestrator/` but in different subdirectories.
- Journals record activity; project notes store intelligence.
- When reading journals, do NOT adopt their voice when updating project notes.
