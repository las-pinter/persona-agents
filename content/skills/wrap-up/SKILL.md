---
name: wrap-up
description: Write or rewrite this session's log, and close or update the task notes. Run it before the owner ends the session, when the owner asks to wrap up, or after a large piece of work. Safe to run more than once.
---

## Platform branch

If your system context says `Running in Kiro CLI`, read
`{{PERSONA_AGENTS_KIRO_SKILL_DIR}}/references/kiro.md` for the session-log path and
the write step. Then continue with steps 3 to 5 and the entry format below.

# Wrap-Up

Write this session's log. The session log records what happened; the
project notes hold knowledge; the task notes hold the task.

## Steps

1. Get the entry path for this session. On Pi, call the `session-log` tool with
   `action: "path"`. On Claude Code, run:

   ```sh
   node --experimental-strip-types --no-warnings "${CLAUDE_SKILL_DIR}/../../../platforms/claude/scripts/session-log.mjs" path --session=${CLAUDE_SESSION_ID}
   ```

   The path is this session's existing entry (today or yesterday) or a new
   one. Each session has its own file, so parallel sessions never collide.
2. Write the whole entry to that path — the `session-log` tool with
   `action: "write"` on Pi, the Write tool on Claude Code — in the format
   below. When the file exists, read it first and write the merged entry: a
   second wrap-up replaces the first.
3. Update each task notes file this session worked on: mark the plan
   steps, and set `Status: done` when the task is closed.
4. If the session found a lasting rule or a project fact, update the project
   notes too (**project-notes** skill).
5. Tell the owner the entry path in one line.

## Entry Format

```markdown
# YYYY-MM-DD HH:MM — <short title of the session>

- **Session:** <session id>
- **Task notes:** <paths, or none>

## Done

- <what was done, with commit IDs when there are commits>

## Decisions

- <decision and its reason, or "none">

## Open

- <what is left, the next step, or "none">

## Lessons

- <what to do differently next time, or "none">
```

## Rules

- At most 40 lines. Facts, not narrative.
- Name commits, files, and studies so a later search finds them.
- Do not copy the task notes or the study into the entry; link them.
- When the session ends without a wrap-up, a background writer creates a
  shorter entry from the task notes and the compaction summaries. A
  wrap-up is better: run it when the work is done.
