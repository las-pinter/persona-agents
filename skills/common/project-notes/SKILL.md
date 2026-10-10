---
name: project-notes
description: Shared, persona-free project notes and planner studies for repositories agents work on. Every agent reads them.
---

# Project Notes

## Overview

Plain, persona-free records about repositories agents work on. The notes hold
architecture, conventions, lessons learned, and planner studies. No flair.
Every line must earn its place.

**Every agent reads `agent-notes`.** Only the orchestrator and the planner
write the shared notes.

## Storage

```
<USER_HOME>/agent-notes/
├── project-notes/
│   └── <project>/
│       ├── summary.md                 (orchestrator, max ~30 lines)
│       ├── features/<slug>.md         (orchestrator, max 300 lines)
│       ├── bugs/<slug>.md             (orchestrator, max 300 lines)
│       ├── tech/<slug>.md             (orchestrator, max 300 lines)
│       └── studies/
│           ├── index.md               (planner)
│           └── YYYY-MM-DD-<slug>/
│               ├── quick-study.md     (planner, max 150 lines)
│               ├── full-study.md      (planner, max 500 lines)
│               └── status.md          (planner)
└── researcher/
    ├── index.md                       (researcher)
    └── reports/
        └── YYYY-MM-DD-<topic>.md      (researcher)
```

**Folder naming:** One folder per repository. The folder name is the repository
name.
**File naming:** Note files use plain slugs, with no date prefix (for example,
`regexp-tool-permissions.md`). Researcher report files use
`YYYY-MM-DD-<topic>.md`. Study folders use `YYYY-MM-DD-<slug>`.
**Home directory:** Use the same `<USER_HOME>` found by the
`journal-management` skill at session start.

## Ownership Split

| Path | Owner | When to write |
|------|-------|---------------|
| `summary.md` | orchestrator | On significant discovery or user correction. |
| `features/`, `bugs/`, `tech/` | orchestrator | On significant discovery or user correction. |
| `studies/index.md` | planner | On study creation and on every stage change. |
| `<study>/status.md` | planner | On study creation and on every stage change. |
| `<study>/quick-study.md` | planner | While the feature is a quick study. |
| `<study>/full-study.md` | planner | After the quick study is accepted. |

The subfolder rule is doctrine, not a gate rule. Do not write another owner's
subfolder.

**READ rule.** Read `<project>/studies/index.md` first. Then read `status.md`
for the named study. Read a study folder only when the task names it. Do not
read all project notes at startup.

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

Rules:

- No "Last worked on" field.
- No persona voice. Plain facts only.
- `summary.md`: maximum ~30 lines (STRICT).
- Feature, bug, and tech notes: maximum 300 lines each (hard ceiling). Split the
  topic when a note cannot fit.
- Omit a section when it has nothing notable.

## Study Lifecycle (planner-owned, manual)

No script writes these files. The planner writes them with the `write` and
`edit` tools. The orchestrator reads them and never edits them.

### `status.md` format (one per study folder)

```markdown
# <Study Title> — Status

- **Stage:** quick | full | done | blocked | abandoned
- **Updated:** YYYY-MM-DD
- **Owner:** planner
- **Next action:** <one line>
- **Blocked by:** <none | short reason>

## History

| Date | Stage | Note |
|------|-------|------|
| YYYY-MM-DD | quick | folder created |
| YYYY-MM-DD | full | quick study accepted |
```

Rules:

1. Create `status.md` in the same action that creates the study folder.
2. Move the stage `quick` → `full` → `done`. The stage `blocked` or
   `abandoned` may replace the current stage at any time.
3. Append one History row on every stage change.
4. Update the `Updated` field on every `status.md` write.
5. Create `status.md` only for new studies. Do not backfill the archived plans.

### `studies/index.md` format (one per project)

Location: `~/agent-notes/project-notes/<project>/studies/index.md`.

```markdown
# Studies — <project>

| Study | Stage | Updated | Path |
|-------|-------|---------|------|
| <title> | quick | YYYY-MM-DD | `studies/YYYY-MM-DD-<slug>/` |
```

Rules:

1. Add one row when the planner creates a study folder.
2. Update the row's `Stage` and `Updated` whenever the planner writes
   `status.md`.
3. Put the newest study on top. Use no script.

## Note Lifecycle

**READ** — when a task names a project, read that project's `summary.md` first,
then read only the notes for the task at hand.

**CREATE** — the first time working on a new repository: check if the project
folder exists. If not, dispatch a researcher to gather context, then create the
project folder and `summary.md`. Create subfolders only as needed.

**UPDATE** — only on noteworthy changes:

- Significant discovery during work → add to "Lessons Learned" or create a
  `tech/` note.
- User corrects something or gives new info → update the relevant section.
- Architecture changes → update the "Architecture" section.

Do not update on every commit. Read the note, make targeted changes, write the
file with `write`, and do not expand it unnecessarily.

**Bug and feature completion** — a bug note lives in `bugs/` only while the bug
is active. When the bug is resolved, remove the note; the journals hold the
history. When a feature ships, its note may be removed or consolidated.

## Integration with Journals

- Project notes are **separate** from persona journals. Both live under
  `agent-notes/`, in different subdirectories.
- Journals record activity. Project notes store intelligence.
- When reading journals, do NOT adopt their voice when writing project notes.

## Related Skills

- **quick-study** (`skills/planner/quick-study/`) — Owns `quick-study.md`.
- **full-study** (`skills/planner/full-study/`) — Owns `full-study.md`.
- **study-questions** (`skills/planner/study-questions/`) — Owns the Q&A format.
- **source-selection** (`skills/researcher/source-selection/`) — Owns the
  researcher report root `agent-notes/researcher/reports/`.
