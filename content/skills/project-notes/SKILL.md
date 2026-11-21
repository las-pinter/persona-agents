---
name: project-notes
description: Persona-free project notes, rules, and studies for each repository, under `agent-notes/project-notes/<project>/`. Read the rules and summary at session start; write on a significant discovery or an owner correction.
---

# Project Notes

## Overview

Plain, persona-free records about repositories agents work on. The notes hold
architecture, conventions, lessons learned, rules, and studies. No flair.
Every line must earn its place. The companion reads and writes them.

## Storage

```
<USER_HOME>/agent-notes/
├── project-notes/
│   └── <project>/
│       ├── summary.md
│       ├── glossary.md
│       ├── features/<slug>.md
│       ├── bugs/<slug>.md
│       ├── tech/<slug>.md
│       ├── releases/<version>.md      (one note per release)
│       ├── audit/<slug>.md            (one note per audit)
│       ├── rules/<slug>.md            (one rule per file)
│       └── studies/
│           ├── index.md
│           ├── legacy_studies/
│           └── YYYY-MM-DD-<slug>/
│               ├── study.md
│               ├── status.md
│               ├── <side-doc>.md
│               └── reverse_engineering/
```

**Folder paths:** A bare name such as `rules/` or `summary.md` means that path
inside the project folder, `<USER_HOME>/agent-notes/project-notes/<project>/`.
Take the path from the `## Storage` block. Do not search the repository for a
path.

**Folder naming:** One folder per repository. `<project>` is the name of the
folder that holds the repository's shared git directory, so every worktree of a
repository maps to one project. Outside a git repository, `<project>` is
`common`. The session start text names the resolved folder; do not derive it
by hand. Two repositories with the same folder name share one project folder.
**File naming:** Note files use plain slugs, with no date prefix (for example,
`regexp-tool-permissions.md`). An audit note uses the same plain slug.
A release note file uses `<version>.md`. Study folders use `YYYY-MM-DD-<slug>`.
**Home directory:** `<USER_HOME>` is the owner's home folder; the notes root is
`<USER_HOME>/agent-notes`.

## When to Write

| Path | When to write |
|------|---------------|
| `summary.md` | On significant discovery or owner correction. |
| `glossary.md` | On a term the owner corrects, or when the code contradicts the name. |
| `features/`, `bugs/`, `tech/` | On significant discovery or owner correction. |
| `releases/` | On each release, one note per version. |
| `audit/` | On each audit, one note per audit. |
| `rules/` | On rule create, update, or retire. |
| `studies/index.md` | On study creation and on every stage change. |
| `studies/legacy_studies/` | When archiving an old study. |
| `<study>/study.md` | On study creation, on every interview round, and when a decision changes. |
| `<study>/status.md` | On study creation, on every stage change, and when a task closes. |
| `<study>/<side-doc>.md` | When detail must move out of the study. |

**READ rule.** The read order lives in **Read order** under `## Rules Folder`. A
task read happens only when the task names the note. The one exception is
`glossary.md`: read it before naming a domain term, even when no task names it.

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
5. Read every other note only when a task names it, except `glossary.md` (see
   the READ rule).

**Mid-session duty.** Write, update, or retire a rule in the session that finds
it. Record the reason in the session notes.

**Startup guard.** Run it after the folder read and before the first task.
Count the rules files. Count their total lines. Re-read each rule against the
current tree. Report each breach to the owner, with the measured value and
the limit. The guard is a procedure: no repository test can read the notes tree in
the home folder.

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
- `summary.md`: maximum 50 lines (hard ceiling).
- Feature, bug, and tech notes: maximum 300 lines each (hard ceiling). Split the
  topic when a note cannot fit.
- Release and audit notes: maximum 300 lines each (hard ceiling). Split the
  topic when a note cannot fit.
- `study.md`: maximum 500 lines (hard ceiling). Split the study before it
  exceeds the cap.
- Each side document: maximum 300 lines (hard ceiling). Split the topic before
  it exceeds the cap.
- Omit a section when it has nothing notable.

## Glossary

`glossary.md` holds the project's vocabulary for agents: the terms the code and
the owner use, and the words an agent got wrong. It sits at the project root,
beside `summary.md`.

```markdown
# Glossary — <project>

| Term | Meaning | Code home | Not this |
|---|---|---|---|
| <term> | <one line> | <file or skill, or none> | <wrong synonyms the agent used> |
```

Rules:

- Write an entry when the owner corrects a term, or when the code contradicts
  the name. Those are the two times the agent demonstrably got it wrong.
- One line per meaning. A term that needs a paragraph belongs in `tech/`, not
  here.
- No implementation details, no decisions (a study owns those), no persona
  voice.
- `Not this` names the wrong synonyms the agent has actually used; that column
  is what changes its habits.
- Maximum 100 lines (hard ceiling). A glossary never splits across files.
- Read it before naming things in the code or in a note, and when reviewing a
  change that uses domain terms. It is not a startup read.

## Study Lifecycle

No script writes these files. Write them with the file tools.

A study has five stages: `draft`, `ready`, `in-progress`, `done`, and
`abandoned`. The stage names what the study is doing, not what the document
contains.

- **draft** — the study is still being written or revised, and the owner has
  not accepted it.
- **ready** — the owner accepted the study, and the decisions are settled. The
  tasks are to be worked.
- **in-progress** — the tasks of the study are being worked.
- **done** — every task is closed, and the work the study describes is
  complete.
- **abandoned** — the owner stopped the study. It may replace any stage at any
  time.

`blocked` is not a stage. Blocking lives in the `Blocked by` field, which is
independent of the stage. A study can be `ready` and blocked at the same time.

### `status.md` format (one per study folder)

```markdown
# <Study Title> — Status

- **Stage:** draft | ready | in-progress | done | abandoned
- **Updated:** YYYY-MM-DD
- **Next action:** <one line>
- **Blocked by:** <none | short reason>
- **Side documents:** <list, or none>

## History

| Date | Stage | Note |
|------|-------|------|
| YYYY-MM-DD | draft | folder created |
| YYYY-MM-DD | ready | owner accepted the study |
| YYYY-MM-DD | in-progress | first task started |
```

Rules:

1. Create `status.md` in the same action that creates the study folder. A new
   study starts at `draft`.
2. Move the stage in order: `draft` → `ready` → `in-progress` → `done`. The
   owner's acceptance moves it from `draft` to `ready`. The start of the next
   open task moves it from `ready` to `in-progress`. On a reopened study, that
   is the next open task that starts after the reopen. The close of the last
   task moves it from `in-progress` to `done`. The stage `abandoned` may replace any stage at any time.
3. Reopen a `done` or `abandoned` study to `ready` when the owner orders more
   work on it. This is the only edge into a closed stage's past, and it lands
   on `ready` alone. The normal order then carries the study forward. The
   reopen writes one History row that quotes the owner's reason. It also
   rewrites the `Next action` field.
4. Append one History row on every stage change.
5. Update the `Updated` field on every `status.md` write.
6. List each side document in the `Side documents` field.
7. Create `status.md` only for new studies. Do not backfill the archived plans.

### `studies/index.md` format (one per project)

Location: `studies/index.md` inside the project folder.

```markdown
# Studies — <project>

| Study | Stage | Updated | Path |
|-------|-------|---------|------|
| <title> | draft | YYYY-MM-DD | `studies/YYYY-MM-DD-<slug>/` |
```

Rules:

1. Add one row when you create a study folder.
2. Update the row's `Stage` and `Updated` whenever you write
   `status.md`.
3. Put the newest study on top. Use no script.

### Legacy studies

- Archived studies live in `studies/legacy_studies/`.
- Move an old study folder there when the owner asks.
- Read an archived study only when a task names it.
- Never migrate an archived study back.

## Note Lifecycle

**READ** — follow the **READ rule** under `## Ownership Split`.

**CREATE** — the first time working on a new repository: check if the project
folder exists. If not, read the repository to gather context, then create the
project folder and `summary.md`. Create subfolders only as needed.

**UPDATE** — only on noteworthy changes:

- Significant discovery during work → add to "Lessons Learned" or create a
  `tech/` note.
- Owner corrects something or gives new info → update the relevant section.
- Architecture changes → update the "Architecture" section.

Do not update on every commit. Read the note, make targeted changes, write the
file with `write`, and do not expand it unnecessarily.

**Bug and feature completion** — a bug note lives in `bugs/` only while the bug
is open. When the bug is resolved, remove the note; the journals hold the
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
- **source-selection** — Owns the research rules; lasting findings go to `tech/`.
