---
name: journal-management-generic
description: Generic hierarchical journal system for any agent's operational context with time-based consolidation. Use this skill whenever you need to read, write, or consolidate operational journals — including at session startup, after completing tasks, before ending a session, or when reviewing past work. This skill works for ANY agent type (persona, non-persona, implementer, tester, researcher, etc.). Do NOT attempt to manage journal context manually; always consult this skill for all journal operations.
---

# Journal Management

## Persona-Free Documents

Load and follow the **persona-free-documents** skill for every study, note, journal, report, release note, and code comment.

## Discovery — Find Your Home Directory

`<USER_HOME>` is the home folder of the user. Take the absolute path that the
platform gives for this skill file. Go up one folder at a time. Stop at the
first folder that holds a folder named agent-notes. That folder is the user
home folder. The notes root is the agent-notes folder inside it.

Do not run a filesystem search to find the home path. Test each parent folder
with a literal path. When your profession journal skill names a startup script,
run that script instead. The script owns the walk. It never takes the working
directory as the home folder.

If the platform reports no absolute path, ask the user once.

The first parent folder that holds an agent-notes folder wins. A stray
agent-notes folder above the skill folder therefore captures the root. Do not
create one.

**Fallback:** if the walk reaches the filesystem root, or the skill file sits
outside the home folder, ask the user once for the home folder. Do not take the
working directory as the home folder.

> **CRITICAL:** Tools like `glob` do not expand a home variable, a tilde, or any
> shell variable. Put the literal path into every tool call.

## Determining `<AGENT_TYPE>`

Journals live under `<USER_HOME>/agent-notes/<AGENT_TYPE>/`, so every theme's
agent of the same profession shares one stable operational memory.

This skill is agent-agnostic and lives in the shared `common/` skills folder.
The profession journal skill gives `<AGENT_TYPE>`; a profession with no
journal skill uses its own profession name.

**How to resolve `<AGENT_TYPE>` (in priority order):**

1. **Profession / agent type (preferred, always used in this repo)** — the
   profession this skill ships with, set once per deployment.
2. **NEVER resolve it from a persona name** — a system prompt opening like
   "You are <PersonaName> the <RoleTitle>..." is theme flavor only. Personas
   are decoration; the profession's operational memory must be stable across
   themes.

Format the value as lowercase hyphenated words. Use the same value every session
so the journal history stays in one place.

## Folder Structure

```
<USER_HOME>/agent-notes/<AGENT_TYPE>/
├── journals/
│   ├── daily/     YYYY-MM-DD.md                   (only dailies not yet consolidated)
│   ├── archive/
│   │   └── daily/ YYYY-MM-DD.md                   (dailies already consolidated)
│   ├── weekly/    YYYY-Wnn.md
│   ├── monthly/   YYYY-MM.md
│   └── yearly/    YYYY.md
```

Journal filenames are plain — no agent suffix. The profession lives in the
directory path.

The `journals/` folder also holds `.journal-write.lock`. The script creates
that file. The script removes it on release. The script keeps the last broken
record in `.journal-write.prev`.

---

## Reading Journals

**Primary method (glob):**
```
glob(pattern="YYYY-MM-DD.md",
     path="<USER_HOME>/agent-notes/<AGENT_TYPE>/journals/daily/")
```

Pick the most recent by filename (YYYY-MM-DD sorts naturally). Read that file.
The glob and the startup read use `journals/daily/` only. Never glob
`journals/archive/daily/` for the latest daily.

**Fallback (if glob returns nothing):**
Run the ls command on the daily directory. The listing sorts by name. Read the
last line.

---

## Writing Journals

> **LIMIT — 100 lines.** The limit applies to every journal level: daily,
> weekly, monthly, yearly.
> The limit is a report gate. It is not a trim order.
> No script prints a line count. Judge the size of the file from your own read.
> Report an over-limit file to the owner, with its path and your own count.
> The weekly consolidation brings the content under the limit. The merged text
> must fit before the write.
> Never trim a daily file by hand.

For the correct current date use the `date` bash command.

Keep your own text short: about 10 lines is a target, not a hard limit. Use one
line per fact.

Keep another session's lines. The **Merge rule** owns the fold.

### Write procedure

Journal files under agent-notes may be written by MORE THAN ONE session. One
lock covers the whole agent folder, so hold one level at a time.

The lock turns stale 600 seconds after `hold`. The `deadline` line from `hold`
names that moment. Finish the write before the deadline. A lost lock lets
another session write and release, and your later write then destroys that
text. A second `hold` with the same agent and session refreshes the lock and
keeps the token. Re-hold when the merge runs long.

`<SESSION>` is the session name. Make it once at the start of the session with
`date +%Y%m%dT%H%M%S%N`. The name must be unique to the session. A host whose
`date` command prints a literal letter instead of nanoseconds must add the
process id to the name.

1. Run `hold`. This is one complete call:
   `bash SKILL_DIR/scripts/journal-write.sh hold --agent <AGENT_TYPE> --session <SESSION>`
2. Read the whole target file.
3. Merge your text into the matching section. Apply the **Merge rule**.
4. Run `release` with the token that `hold` printed:
   `bash SKILL_DIR/scripts/journal-write.sh release --agent <AGENT_TYPE> --session <SESSION> --token <TOKEN>`
5. On exit 5, follow the recovery under **Error Handling**.

The `hold` call comes before your read. The `release` call comes after your
`write`. No step measures the file. The read in step 2 gives the size for the
limit above.

Run the script with bash and the skill folder path as the platform shows it,
unquoted. A platform whose allow entry names a tilde form keeps that tilde.
Put the real value in each placeholder. The command carries no redirect,
no heredoc, and no lock command. The script holds the lock itself.

`<AGENT_TYPE>` must equal the agent type that this skill resolved. `--token` is
required by `release` and not by `hold`.

If `hold` or `release` exits nonzero, follow **Error Handling**.

### Merge rule

- Keep every commit hash, verdict, and open item.
- Fold a repeated fact to one line.
- When two lines conflict, keep both lines and record the conflict under
  `## Issues / Blockers`.
- Write the whole file in one `write` call.
- Hold one level at a time.

---

## Entry Structure

One daily file per day, structured like this:

```markdown
# YYYY-MM-DD

## Work Log
- <task>: <1-line result> (<commit hash if any>)
- <task>: <1-line result>

## Details
- <only for the day's complex task(s), if needed>

## Key Decisions
- <only notable decisions>

## Issues / Blockers
- <only blockers>

## Verification
- <key checks> ✅

## Lessons Learned
- <only what's worth remembering>
```

> Headings below are examples. Omit any with no content; never leave
> placeholder text (like `<only blockers>`) in a written journal.

### Per-project sections

When a day's work spans MORE THAN ONE project/repository, group the Work Log
bullets under `### <project>` subsections — one subsection per project worked
that day. Skip a subsection if a project has nothing to log. The subsection
header carries the project name, so bullets inside it don't need a project
tag.

Example (two projects in one daily file):

```markdown
## Work Log
### persona-agents
- permission audit: tuned 3 rules (commit 40a358b)
- audit log cleared for clean baseline

### tarragon
- cache-filename sanitize: folder + reserved-name guards
```

For the optional sections (Key Decisions, Verification, etc.), use the same
`### <project>` subsections when the file spans multiple projects; otherwise
keep bullets flat and add a `[project]` tag only if a bullet would otherwise
be ambiguous.

Key rules:

1. **One entry per day**, not one entry per task.
2. **Work Log** is the primary section: a compact bullet list, one line per
   task, with a short result and a commit hash if any.
3. All other sections (Details, Key Decisions, Issues / Blockers,
   Verification, Lessons Learned) are **OPTIONAL** — include them ONLY when
   they have real, non-empty content.
4. **Details** is reserved for the day's complex task(s) only — not routine
   work already in the Work Log.
5. Keep section names standard and plain. Do not rename them to match a
   persona voice.
6. **Commit hash:** write the commit hash only after the commit exists. Never
   write a placeholder hash.

---

## When to Write

| Event | What to document |
|-------|-----------------|
| Delegation completed | What subagent did, result, any issues |
| Commit made | Commit hash, summary of changes |
| Multi-step task finished | Overview of what was accomplished |
| Error / troubleshooting | What went wrong, how it was fixed |
| Session end / pause | Summary of everything done this session |
| Multiple tasks in one day | Consolidate all into ONE daily entry's Work Log — not separate entries per task |

---

## Entry Types

One write procedure serves daily, weekly, monthly, and yearly. The level
changes the path and the merge size, not the procedure. A file that does not
exist yet is made by the same single `write` call.

---

## Startup Read Behavior

Always load at startup:
1. **Latest daily journal** — most recent `YYYY-MM-DD.md` in the daily folder
2. **Current period summary** — if a weekly or monthly file covers the current
   date, read it too

Load additional entries when:
- The user's task references work from more than a few days ago
- The latest daily entry mentions dependencies on earlier work

Priority for additional reads: weekly summary → monthly → yearly → specific
dailies → archived dailies (`journals/archive/daily/`). Read an archived daily
only when a task needs old detail that the summaries do not have.

---

## Voice Rules

- **Reading:** Extract facts and context only. Never adopt the voice or style
  of journals you read.
- **Writing:** Plain, neutral, factual language. No persona voice, no drama,
  no storytelling — just what was done, decisions, issues, verification,
  lessons.

---

## Consolidation Schedule

| Level | When | Source | Target |
|-------|------|--------|--------|
| **Weekly** | First run of a new ISO week | Dailies of the previous ISO week | `YYYY-Wnn.md` |
| **Monthly** | First run of a new month | 4-5 weekly files | `YYYY-MM.md` |
| **Yearly** | First run of a new year | 12 monthly files | `YYYY.md` |

First run of a new ISO week: consolidate the dailies of the previous
ISO week into `YYYY-Wnn.md`. Read the source files first. Then write the merged
result with the procedure under `### Write procedure`. After a missed week,
consolidate each closed ISO week that has unconsolidated dailies into its own
weekly file.

**Keep summaries short:**
- Weekly: 1-2 paragraphs per day (~15 lines total)
- Monthly: 1 paragraph per week (~20 lines total)
- Yearly: 1 paragraph per month (~25 lines total)

### Archive consolidated dailies

After a weekly file is written, move its source daily files from
`journals/daily/` into `journals/archive/daily/`. Keep the same file names.
Never delete a daily. After a successful move, the daily folder holds only
dailies not yet consolidated.

- Move a daily only after you write the weekly file, re-read it, and confirm
  it holds every source day.
- Move only the dailies you read and merged into this weekly. Never move a
  daily that the weekly does not cover.
- Never move today's daily or any daily of the current ISO week.
- If you cannot run `mv`, do not move the files. Leave the dailies in place.
  Report them to the owner.
- Do not archive weekly, monthly, or yearly files.

Consolidations (weekly/monthly/yearly) keep the per-project grouping of the
source dailies (e.g. `### <project>` inside each day's summary where sources
had it).

---

## Error Handling

- Journal file not found on read → normal, no work was done that period.
  Continue.
- A missing level folder is not an error. Your `write` call creates it.

| Code | Subcommand | Meaning |
|------|------------|---------|
| 0 | hold, release | success |
| 1 | hold, release | usage error: an unknown subcommand, an unknown flag, a missing value, a repeated flag, a flag that does not apply to the subcommand, a positional argument, or a missing required flag |
| 2 | hold, release | bad input: a value starts with a dash, a value fails its pattern, or no home folder was found |
| 3 | hold, release | IO failure: lock folder create, record read, record write, claim restore |
| 4 | hold | the wait exceeded `--timeout`, a refresh whose create lost the name, or an incomplete record found while acquiring |
| 5 | release | the lock file is gone or holds an incomplete record, or the record does not match your agent, session, and token |

- A nonzero exit prints one line that names the cause and the paths that the
  script knows.
- Two lines are exact and carry no prefix: `held <path> by <session> since
  <UTC ISO>` and `lock lost <path>`.
- On exit 1, 2, or 3 from `hold`, write no journal. Report the failure line.
- On exit 1 or 2 from `release`, the flag value is wrong. Fix the flag value
  and repeat the call with the same token.
- On exit 3 from `release`, the journal is already written. Read the failure
  line. Check the folder path and its permission. Then repeat the call with
  the same token. Do not write the journal again.
- On exit 4, the lock was not taken. Retry `hold` with a larger `--timeout`, up
  to 120 seconds.
- On exit 5, recover in three steps:
  1. Re-read the file.
  2. Merge your text again.
  3. Repeat the write procedure from step 1.
- The line limit above is prose. No write is blocked by a number.
