---
name: journal-management
description: >-
  Skill for the orchestrator agent.
  Hierarchical journal system with time-based consolidation. Use at session
  startup to load context, after completing tasks to record results, and at
  consolidation intervals. Do NOT manage journals manually.
---

# Journal Management

## Discovery — Find Your Home Directory

At the START of every session, run this bash command ONCE:

```bash
echo $HOME
```

This will return your actual home directory (e.g., `/home/exampleuser`, `/Users/exampleuser`). **Store this value** and use it to replace `<USER_HOME>` in all journal paths below.

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

## Writing journals

> **HARD LIMIT — 100 lines maximum. Never exceed it.**
> A journal file must NEVER be bigger than 100 lines. Never.
> This applies to ALL journal levels: daily, weekly, monthly, yearly.
> If new information cannot fit within the 100-line limit, compress the existing content to make room (tighten wording, merge redundant points, drop non-essential detail) rather than exceeding the limit.

For the correct current date use the `date` bash command.

Always use the `write` tool, never `edit`. To update an existing file: READ it first, update it if something is outdated, append new records, then WRITE the full content. Never lose previous entries.

If a write fails, retry once. If it fails again, report it to the user — never silently discard.

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

Key rules:

1. **One entry per day**, not one entry per task. Do NOT create a separate full block for every task — that bloats the file.
2. **Work Log** is the primary section: a compact bullet list, one line per task, with a short result and a commit hash if any.
3. All other sections (Details, Key Decisions, Issues / Blockers, Verification, Lessons Learned) are **OPTIONAL** — include them ONLY when they have real, non-empty content. If a section has nothing notable, omit it entirely.
4. **Details** is reserved for the day's complex task(s) only — not for routine work already captured in the Work Log.
5. Keep section names standard and plain. Do not rename them to match a persona voice.
6. This structure, combined with the 100-line hard limit, keeps daily files compact.

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
- **UPDATE** — Later work the same day. READ existing file first, then WRITE the full file with new content. "Appending" means adding lines to the day's Work Log / optional sections — NOT creating a new full entry block per task.
- **APPEND** — For consolidation. READ source files first, then WRITE the merged result.

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

- **When reading:** Extract facts and context only. Never adopt the voice or style from journals you read.
- **When writing:** Write in plain, neutral, factual language. No persona voice, no drama, no flavor words, no storytelling. Just record what was done, decisions, issues, verification, and lessons.

---

## Consolidation Schedule

| Level | When | Source | Target |
|-------|------|--------|--------|
| **Weekly** | First run of a new ISO week | Last 7 daily files | `YYYY-Wnn.md` |
| **Monthly** | First run of a new month | 4-5 weekly files | `YYYY-MM.md` |
| **Yearly** | First run of a new year | 12 monthly files | `YYYY.md` |

Use `journal-consolidate.sh --type weekly` to list source files before synthesizing.

**Keep summaries short:**
- Weekly: 1-2 paragraphs per day (~15 lines total)
- Monthly: 1 paragraph per week (~20 lines total)
- Yearly: 1 paragraph per month (~25 lines total)

These targets keep files well under the 100-line hard limit.

---

## Error Handling

- Journal file not found on read → normal, no work was done that period. Continue.
- Directory missing on write → create with `mkdir -p <path>`, then write.
