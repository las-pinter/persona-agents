---
name: journal-management
description: Hierarchical journal system with time-based consolidation.
---

# Journal Management

## Discovery — Find Your Home Directory

At the START of every session, run this bash command ONCE:

```bash
echo $HOME
```

Store the returned value and use it to replace `<USER_HOME>` in all paths below.

> **CRITICAL:** Tools like `glob` do NOT expand `$HOME`, `~`, or any shell variables. Always substitute the discovered literal path (e.g., `/home/exampleuser`) into tool calls.

## Folder Structure

```
<USER_HOME>/agent-notes/orchestrator/
├── journals/
│   ├── daily/    YYYY-MM-DD.md
│   ├── weekly/   YYYY-Wnn.md
│   ├── monthly/  YYYY-MM.md
│   └── yearly/   YYYY.md
```

Journal filenames are plain — no agent suffix.

---

## Reading Journals

**Primary method (glob):**
```
glob(pattern="YYYY-MM-DD.md",
     path="<USER_HOME>/agent-notes/orchestrator/journals/daily/")
```

Pick the most recent by filename (YYYY-MM-DD sorts naturally). Read that file.

**Fallback (if glob returns nothing):**
```bash
ls <USER_HOME>/agent-notes/orchestrator/journals/daily/ | sort | tail -1
```

---

## Writing Journals

> **HARD LIMIT — 100 lines maximum.** Applies to ALL journal levels: daily, weekly, monthly, yearly.
> If new information cannot fit, compress existing content (tighten wording, merge redundant points, drop non-essential detail) rather than exceeding the limit.

For the correct current date use the `date` bash command.

### Merge-aware updates (shared journal cave)

Journal files under agent-notes may be written by MORE THAN ONE session (e.g. several
orchestrator sessions sharing one home directory). A naive read-then-write clobbers the
other sessions' entries. Follow these rules on EVERY update:

1. Re-read the file IMMEDIATELY before writing. Never write from an earlier read or from
   memory — the file may have changed since you first loaded it.
2. Never rebuild the file from memory. The content you write must be the current on-disk
   content plus your own additions.
3. Preserve verbatim every section/subsection you did not author, including other
   projects' `### <project>` sections and any unknown content. Add or update only your
   own project's section. When two sessions share the same project subsection, treat
   your additions as append-only and always write from the current disk content.
4. If the file was heavily rewritten or consolidated since your read, write from the
   latest recoverable state and note the discrepancy in your entry.
5. If a write fails, retry once with a fresh re-read; if it fails again, report it —
   never silently discard.
6. Re-read-before-write narrows but cannot fully eliminate a simultaneous write by
   two sessions; if that happens the later write wins silently. Check for lost
   sections before finishing a session.

Always use the `write` tool, never `edit`. Follow the merge-aware rules above when updating; do not skip the merged re-read.

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

> Headings below are examples. Omit any with no content; never leave placeholder text (like `<only blockers>`) in a written journal.

### Per-project sections

When a day's work spans MORE THAN ONE project/repository, group the Work Log bullets
under `### <project>` subsections — one subsection per project worked that day. Skip a
subsection if a project has nothing to log. The subsection header carries the project
name, so bullets inside it don't need a project tag.

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
`### <project>` subsections when the file spans multiple projects; otherwise keep bullets
flat and add a `[project]` tag only if a bullet would otherwise be ambiguous.

Key rules:

1. **One entry per day**, not one entry per task.
2. **Work Log** is the primary section: a compact bullet list, one line per task, with a short result and a commit hash if any.
3. All other sections (Details, Key Decisions, Issues / Blockers, Verification, Lessons Learned) are **OPTIONAL** — include them ONLY when they have real, non-empty content.
4. **Details** is reserved for the day's complex task(s) only — not routine work already in the Work Log.
5. Keep section names standard and plain. Do not rename them to match a persona voice.

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

- **CREATE** — First entry of the day. Write the full file.
- **UPDATE** — Later work the same day. Read existing, update, write full file (see Writing).
- **APPEND** — For consolidation. Read source files first, then write the merged result.

---

## Startup Read Behavior

Always load at startup:
1. **Latest daily journal** — most recent `YYYY-MM-DD.md` in the daily folder
2. **Current period summary** — if a weekly or monthly file covers the current date, read it too

Load additional entries when:
- The user's task references work from more than a few days ago
- The latest daily entry mentions dependencies on earlier work

Priority for additional reads: weekly summary → monthly → yearly → specific dailies.

---

## Voice Rules

- **Reading:** Extract facts and context only. Never adopt the voice or style of journals you read.
- **Writing:** Plain, neutral, factual language. No persona voice, no drama, no storytelling — just what was done, decisions, issues, verification, lessons.

---

## Consolidation Schedule

| Level | When | Source | Target |
|-------|------|--------|--------|
| **Weekly** | First run of a new ISO week | Last 7 daily files | `YYYY-Wnn.md` |
| **Monthly** | First run of a new month | 4-5 weekly files | `YYYY-MM.md` |
| **Yearly** | First run of a new year | 12 monthly files | `YYYY.md` |

First run of a new ISO week: consolidate the last 7 daily files into `YYYY-Wnn.md` (read source files first, then write the merged result).

**Keep summaries short:**
- Weekly: 1-2 paragraphs per day (~15 lines total)
- Monthly: 1 paragraph per week (~20 lines total)
- Yearly: 1 paragraph per month (~25 lines total)

Consolidations (weekly/monthly/yearly) keep the per-project grouping of the source dailies (e.g. `### <project>` inside each day's summary where sources had it).

---

## Error Handling

- Journal file not found on read → normal, no work was done that period. Continue.
- Directory missing on write → create with `mkdir -p <path>`, then write.