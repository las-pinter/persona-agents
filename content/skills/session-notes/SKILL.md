---
name: session-notes
description: The working file for one task - goal, plan with step status, decisions, pinned documents, and a log. Create it when a task needs more than a few steps; update it whenever the plan changes. Compaction recovery and the journal read it.
---

# Session Notes

## Purpose

The session notes file is the source of truth for the task you are working on.
Your context is a cache of it: compaction can drop the context at any time, but
the file stays. Write the plan here, keep it current, and you can always pick
the work up again.

## When to Create One

- Create one when a task needs more than a few steps, or when it will outlive
  the session.
- A study-backed task gets one too. It links the study, and the plan is the
  study's task table plus the steps of the current task.
- A small, one-step change needs none.

One file per task, not per Claude Code session. A task that spans several
sessions keeps one file. Several tasks in one session get one file each.

## Location

`<project notes folder>/sessions/<YYYY-MM-DD>-<slug>.md`. The session start
text names the project notes folder. Use the `date` command for the date and a
plain kebab-case slug.

## Format

```markdown
# <task title>

- **Started:** YYYY-MM-DD
- **Status:** open | done
- **Study:** <path to study.md, or none>
- **Sessions:** <session id>, <session id>

## Goal

<one to three lines>

## Plan

- [x] <done step>
- [ ] <open step>  ← current

## Decisions

- YYYY-MM-DD — <decision and its reason>

## Pinned

- <absolute path of a document to reload after compaction>

## Log

- YYYY-MM-DD HH:MM — <short line>
```

## Rules

- **Name the session.** Write the session id from the session start text on
  the `Sessions` line when you create the file. When a new session picks the
  task up, append its id to that line first, before any other edit. The id is
  how the file is found after a compaction.
- **Update the plan first.** When the facts change the plan, edit `## Plan`
  before you continue the work. Mark the current step.
- **Record decisions** the owner makes, with the date.
- **Pin** a document that the task needs throughout: a spec, an API reference,
  a design note. Do not pin source files you are changing; you re-read those
  when you need them. Project rules, the summary, the study, and this file are
  reloaded anyway and need no pin.
- **Log** only what a later reader needs: a blocker, a rule change, a
  compaction line. Some adapters write the compaction line from a hook; when
  none appears after a compaction, write it yourself.
- Set `Status: done` when the task closes. An open file shows up at the next
  session start.
- Keep the file under 200 lines. Move detail into the study or a project note.

## Related Skills

- **project-notes** — the project folder and its notes.
- **study** — the plan of a study-backed task.
