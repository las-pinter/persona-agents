---
name: project-notes
description: Shared, persona-free project notes and planner studies for repositories agents work on. The orchestrator and the planner write them. Outside a retro, only they read `agent-notes/project-notes/`.
---

# Project Notes

## Overview

Plain, persona-free records about repositories agents work on. The notes hold
architecture, conventions, lessons learned, and planner studies. No flair.
Every line must earn its place.

Only the orchestrator and the planner write `agent-notes/project-notes/`, and
outside a retro only they read it. The retro skill reads those notes in every
profession.

## Persona-Free Documents

Load and follow the **persona-free-documents** skill for every study, note, journal, report, release note, and code comment.

## Storage

```
<USER_HOME>/agent-notes/
├── project-notes/
│   └── <project>/
│       ├── summary.md                 (orchestrator, max 30 lines)
│       ├── features/<slug>.md         (orchestrator, max 300 lines)
│       ├── bugs/<slug>.md             (orchestrator, max 300 lines)
│       ├── tech/<slug>.md             (orchestrator, max 300 lines)
│       ├── rules/<slug>.md            (orchestrator, one rule per file)
│       └── studies/
│           ├── index.md               (planner)
│           ├── legacy_studies/        (orchestrator)
│           └── YYYY-MM-DD-<slug>/
│               ├── study.md           (planner, max 500 lines)
│               ├── status.md          (planner)
│               ├── <side-doc>.md      (planner, max 300 lines each)
│               └── reverse_engineering/  (planner)
└── researcher/
    ├── index.md                       (researcher)
    └── reports/
        └── YYYY-MM-DD-<topic>.md      (researcher)
```

**Folder paths:** A bare name such as `rules/` or `summary.md` means that path
inside the project folder, `<USER_HOME>/agent-notes/project-notes/<project>/`.
Take the path from the `## Storage` block. Do not search the repository for a
path.

**Folder naming:** One folder per repository, named with the repository name
only (no owner prefix). Collision risk: two repositories with the same name
share one folder. When a repository has no remote, use its local directory
name. If two repositories still collide, add a short owner or path suffix to
one folder name.
**File naming:** Note files use plain slugs, with no date prefix (for example,
`regexp-tool-permissions.md`). Researcher report files use
`YYYY-MM-DD-<topic>.md`. Study folders use `YYYY-MM-DD-<slug>`.
**Home directory:** `<USER_HOME>` is the folder that holds `agent-notes`. Follow
the **journal-management-generic** skill for the exact rule and the fallback.

## Ownership Split

| Path | Owner | When to write |
|------|-------|---------------|
| `summary.md` | orchestrator | On significant discovery or user correction. |
| `features/`, `bugs/`, `tech/` | orchestrator | On significant discovery or user correction. |
| `rules/` | orchestrator | On rule create, update, or retire. The planner does not write it. |
| `studies/index.md` | planner | On study creation and on every stage change. |
| `studies/legacy_studies/` | orchestrator | When archiving an old study. |
| `<study>/study.md` | planner | While the study is active. |
| `<study>/status.md` | planner | On study creation and on every stage change. |
| `<study>/<side-doc>.md` | planner | When detail must move out of the study. |

The subfolder rule is doctrine, not a gate rule. Do not write another owner's
subfolder.

**READ rule.** The read order lives in **Read order** under `## Rules Folder`. A
task read happens only when the task names the note.

The two startup reads are the project `rules/` folder and `summary.md`. No
other note is a startup read. Archived studies live in
`studies/legacy_studies/`. Read one only when the task names it. Never migrate
one back.

## Rules Folder

`rules/` holds short general rules for one project. One rule per file, plain
markdown. The folder is the list. There is no index and no manifest.

The `## Storage` block holds the `rules/` path.

File shape:

```markdown
# <rule title>

- **Date:** YYYY-MM-DD
- **Importance:** high | normal | low

<one to three lines of rule text>
```

- **high:** the rule prevents broken work or lost data.
- **normal:** the rule keeps the work consistent.
- **low:** optional guidance that improves a note and breaks nothing if ignored.

**Budget:** at most 8 files and 200 lines in total. When the folder is full,
retire one rule or merge two rules in the same edit. Then write the new rule.

**Read order.** It has 5 steps:

1. Read the always-load skills.
2. Read the project `rules/` folder in full, in file-name order.
3. Read `summary.md` in full.
4. Read `studies/index.md` and one `status.md` only when the task names a study.
5. Read every other note only when a task names it.

**Mid-session duty.** The orchestrator writes, updates, or retires a rule in the
session that finds it. It records the reason in one journal line.

**Startup guard.** Run it after the folder read and before the first dispatch.
Count the files. Count the total lines. Re-read each rule against the current
tree. Write one journal line per breach, with the file name, the measured
value, and the limit. The guard is a procedure: no repository test can read a
user note tree.

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
- `summary.md`: maximum 30 lines (hard ceiling).
- Feature, bug, and tech notes: maximum 300 lines each (hard ceiling). Split the
  topic when a note cannot fit.
- `study.md`: maximum 500 lines (hard ceiling). Split the study before it
  exceeds the cap.
- Each side document: maximum 300 lines (hard ceiling). Split the topic before
  it exceeds the cap.
- Omit a section when it has nothing notable.

## Study Lifecycle (planner-owned, manual)

No script writes these files. The planner writes them with the `write` and
`edit` tools. The orchestrator reads them and never edits them.

### `status.md` format (one per study folder)

```markdown
# <Study Title> — Status

- **Stage:** full | done | blocked | abandoned
- **Updated:** YYYY-MM-DD
- **Owner:** planner
- **Next action:** <one line>
- **Blocked by:** <none | short reason>
- **Side documents:** <list, or none>

## History

| Date | Stage | Note |
|------|-------|------|
| YYYY-MM-DD | full | folder created |
| YYYY-MM-DD | done | user accepted the study |
```

Rules:

1. Create `status.md` in the same action that creates the study folder. A new
   study starts at `full`.
2. Move the stage `full` → `done`. The stage `blocked` or `abandoned` may
   replace the current stage at any time. A study is `done` only on the user's
   explicit acceptance.
3. Append one History row on every stage change.
4. Update the `Updated` field on every `status.md` write.
5. List each side document in the `Side documents` field.
6. Create `status.md` only for new studies. Do not backfill the archived plans.

### `studies/index.md` format (one per project)

Location: `studies/index.md` inside the project folder.

```markdown
# Studies — <project>

| Study | Stage | Updated | Path |
|-------|-------|---------|------|
| <title> | full | YYYY-MM-DD | `studies/YYYY-MM-DD-<slug>/` |
```

Rules:

1. Add one row when the planner creates a study folder.
2. Update the row's `Stage` and `Updated` whenever the planner writes
   `status.md`.
3. Put the newest study on top. Use no script.

### Legacy studies

- Archived studies live in `studies/legacy_studies/`.
- The orchestrator moves an old study folder there.
- Read an archived study only when a task names it.
- Never migrate an archived study back.

## Note Lifecycle

**READ** — follow the **READ rule** under `## Ownership Split`.

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

- **study** — Owns `study.md` and the side documents.
- **interview** — Owns the frontier rounds and the
  decisions record.
- **source-selection** — Owns the researcher report root
  `agent-notes/researcher/reports/`.
