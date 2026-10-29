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
│   ├── incoming/  <YYYYmmddTHHMMSSnnnnnnnnn>.md   (blocks not yet written)
│   ├── archive/
│   │   └── daily/ YYYY-MM-DD.md                   (dailies already consolidated)
│   ├── weekly/    YYYY-Wnn.md
│   ├── monthly/   YYYY-MM.md
│   └── yearly/    YYYY.md
```

Journal filenames are plain — no agent suffix. The profession lives in the
directory path.

The `journals/` folder also holds `.journal-write.lock`. The script makes that
file. The script never removes it. The script removes a block after the write,
on exit 0. A failed removal prints a warning. A failure before the removal
keeps the block. A failure after the removal exits nonzero with no block. The
exit-4 fallback leaves its block in place. When the attempt ends, the session
names the block path in its report. No other step removes a block.

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
> An `append` or a `replace` that prints `gate over` is reported to the owner.
> Report the line count and the file path. Never trim a daily file by hand.
> The weekly consolidation brings the content under the limit. The merged text
> must fit before the `replace` call.
> A session may compress its own block before it appends. Keep another author's
> text verbatim when you append.
> `replace` serves the weekly, monthly, and yearly files only. It never serves
> a daily.

For the correct current date use the `date` bash command.

### Append through the write script (shared journal cave)

Journal files under agent-notes may be written by MORE THAN ONE session (e.g.
several sessions of the same profession sharing one home directory). A rewrite
clobbers the other sessions' entries. Follow these rules on EVERY update:

1. Every journal text write goes through `scripts/journal-write.sh` in this
   skill folder, except two. A block file under `incoming/` is the first: the
   `write` tool makes it. The rule 6 fallback is the second. The archive move
   writes no text. Run the script with bash and the skill folder path as the
   platform shows it, unquoted. A platform whose allow entry names a tilde form
   keeps that tilde. This is one complete call:
   `bash SKILL_DIR/scripts/journal-write.sh append --agent orchestrator --section persona-agents --block BLOCK_DIR/20261028T214012123456789.md`
   Every command example marks a placeholder in one of two ways: an upper-case
   word such as `SKILL_DIR`, or an angle-bracket word such as `<AGENT_TYPE>`.
   Replace each placeholder with the real value. The command carries no
   redirect, no heredoc, and no lock command. The script holds the lock
   itself.
2. Write your own block first with the `write` tool. Put it in the `incoming/`
   folder that the folder tree names. Take the file name and the session stamp
   from Block file format. Put only your own text in the block.
3. Run `append --agent <AGENT_TYPE> --section <project> --block <absolute block
   path>`. The script waits for the lock. The script adds your block to today's
   daily.
4. Never use the `write` or the `edit` tool on a journal file at any level. One
   bounded exception is the `append` exit-4 fallback on an existing target.
   Rule 6 holds the only copy of that fallback. The `write` tool creates one
   file in a journal folder: a block under `incoming/`.
5. Never copy another author's text into an append block. A consolidation block
   is the exception: it carries the merged text of every source file. The
   script never rewrites a section it did not receive.
6. If `append` exits 4, the script could not write the target. The error line
   names the cause. Four causes come before the lock is taken: the lock folder
   create, the lock file open, the block record read, and the block record
   count. On any of them, stop. Do not edit the journal. Report the failure
   and the block path.
   Every other cause follows a taken lock. Run the exit-4 fallback only when
   the target exists. Re-read the target. Add your block with a targeted
   `edit`. Put the discrepancy note at the end of your own text in the target.
   Leave the block file in place. Name its path in your report. If the target
   does not exist, do not edit. Report the failure. Write no journal file.
7. If `append` exits 5, the lock wait was too short. Retry the same call with a
   larger `--timeout`. The largest value is 120 seconds. Never edit the journal
   on exit 5. Never change the block text between the calls. If a retry at 120
   seconds also exits 5, stop. Report the block path. Do not edit the journal.
8. Exits 1, 2, and 3 do not permit a fallback. Exit 1 is a usage error. Exit 2
   is bad input. Fix the call. Run the same block file again. Exit 3 means an
   `--expect` mismatch. Use the recovery in `CONSOLIDATE`. If the script is
   absent, write no journal at all and report a stale install.

### Block file format

- Folder: `<USER_HOME>/agent-notes/<AGENT_TYPE>/journals/incoming/`.
- Name: the output of `date +%Y%m%dT%H%M%S%N`, plus `.md`.
- Line 1 holds the session stamp. Its shape is exactly:
  `<!-- session: <UTC date>T<UTC time>Z <AGENT_TYPE> <session> -->`.
- This is one complete stamp:
  `<!-- session: 2026-10-28T21:40:12Z orchestrator 20261028T214012123456789 -->`.
- The UTC time comes from `date -u +%Y-%m-%dT%H:%M:%SZ`.
- `<AGENT_TYPE>` must equal the `--agent` value. Its shape is
  `[a-z][a-z0-9-]*`.
- `<session>` holds 1 to 64 characters from `[A-Za-z0-9._-]`. The block file
  name without `.md` is a valid session name.
- Line 2 is empty or absent. Line 3 and later hold the block text.
- The script validates line 1. The script keeps line 1 in the journal.
- At most 200 lines, stamp included. Split a longer `append` block into two
  `append` calls. Never split a `replace` block. Shorten the merge instead.

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

- **CREATE** — `append` on an absent or empty file. The script writes the
  `# <today>` header, then the block, under the lock. An append with a section
  also writes the `## Work Log` heading and the `### <project>` heading. A
  CREATE that exits 4 and leaves no target follows rule 6.
- **APPEND** — `append`. Later work the same day, or work from another session.
  The script adds the block under its `### <project>` subsection.
- **CONSOLIDATE** — the merge serves a weekly, monthly, or yearly file.
  `replace` never serves a daily. Do these three steps:
  1. Run `check --agent <AGENT_TYPE> --level <level> --name <period> --show`.
     The body and the digest come from that one read.
  2. Merge the body. Write the merged text to a new block under `incoming/`
     with the `write` tool. Use the Block file format.
  3. Run `replace --agent <AGENT_TYPE> --level <level> --name <period>
     --block <absolute block path> --expect <digest>`.
  Required flags are `--agent`, `--level`, `--block`, and `--expect`.
  Optional flags are `--name`, `--home`, and `--timeout`. The script defaults a
  missing `--name` to the current period. A missing required flag exits 1. A
  `--level daily` exits 2. An `--expect` mismatch exits 3. Run `check` again.
  Redo the merge.

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
ISO week into `YYYY-Wnn.md`. Read the source files first. Then send the merged
result through the write script's `replace` subcommand. After a missed week,
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
- Directory missing on write → the write script creates the target folder.
- **Write script, exit 1** — usage error. Target unchanged.
- **Write script, exit 2** — bad input. The causes are:
  - the agent name: it fails `[a-z][a-z0-9-]*`;
  - the section name: it fails its pattern;
  - the timeout: it is outside 1 to 120 seconds;
  - the level: it is not a known level;
  - the level: it is `daily` on `replace`;
  - the name: it does not match the level;
  - `--expect`: it is neither `new` nor a digest;
  - `--home`: it is not an absolute path;
  - `--home`: it does not resolve;
  - `--home`: it holds no `agent-notes` folder;
  - the home folder: none is found;
  - the block path: it is not absolute;
  - the block path: it does not resolve;
  - the block path: it is outside the `incoming/` folder;
  - the block name: it does not end in `.md`;
  - the block: it is not a regular file;
  - the block: it is not readable;
  - the block: it is longer than 200 records;
  - block record 1: it is not a session stamp;
  - block record 1: it names another agent;
  - block record 2: it holds text;
  - the target: it holds a carriage return.
  Target unchanged, block kept.
- **Write script, exit 3** — `--expect` mismatch. The causes are: a target
  that changed since the `check` read, `--expect new` on a present target, and
  `--expect <digest>` on an absent target. Target unchanged, block kept. Run
  `check` again. Redo the merge.
- **Write script, exit 4** — an IO failure. The causes are:
  - the lock folder create;
  - the lock file open;
  - the block record read;
  - the block record count;
  - the block read;
  - the target read;
  - the target record count;
  - the target folder create;
  - the temp file create;
  - the temp file write;
  - the temp record count;
  - the chmod;
  - the rename;
  - the digest.
  Target unchanged, block kept. On `append`, rule 6 of the write section
  applies. On `replace`, fix the IO cause. Run `check` again. Redo the merge.
  Never edit a `replace` target by hand. These four causes come before the
  lock: the lock folder create, the lock file open, the block record read, and
  the block record count.
- **Write script, exit 5** — lock wait exceeded `--timeout`. Target unchanged,
  block kept. Rule 7 of the write section applies.
- **Write script, any nonzero exit** — one stderr line names each path the
  script knows. An early failure knows no target. Nothing is silent.
