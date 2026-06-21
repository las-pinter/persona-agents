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
│   ├── daily/    YYYY-MM-DD-<AGENT_SUFFIX>.md
│   ├── weekly/   YYYY-Wnn-<AGENT_SUFFIX>.md
│   ├── monthly/  YYYY-MM-<AGENT_SUFFIX>.md
│   └── yearly/   YYYY-<AGENT_SUFFIX>.md
```

**Agent suffix:** Extract from your persona file name. E.g., "You are Bossnik the Goblin Chief" → suffix: `bossnik`.

---

## Reading Journals

**Primary method (glob):**
```
glob(pattern="YYYY-MM-DD-<AGENT_SUFFIX>.md",
     path="<USER_HOME>/agent-notes/orchestrator/journals/daily/")
```

Pick the most recent by filename (YYYY-MM-DD sorts naturally). Read that file.

**Fallback (if glob returns nothing):**
```bash
ls <USER_HOME>/agent-notes/orchestrator/journals/daily/ | sort | tail -1
```

---

## Writing journals

Always use the `write` tool, never `edit`. To update an existing file: READ it first, update it if something is outdated, append new records, then WRITE the full content. Never lose previous entries.

If a write fails, retry once. If it fails again, report it to the user — never silently discard.

---

## Entry Structure

```markdown
# YYYY-MM-DD - <Agent Name>, <Title>

## What <Agent Name> Did
**Task:** <brief description>

**Details:**
- <what was built/changed>
- <another point>

## Key Decisions
- <decision and why>

## Issues / Blockers
- <anything that went wrong or is blocked>

## Verification
- <check 1> ✅

## Lessons Learned
- <anything worth remembering>
```

Adjust section names to match your persona's voice, but keep the informational structure.

---

## When to Write

| Event | What to document |
|-------|-----------------|
| Delegation completed | What subagent did, result, any issues |
| Commit made | Commit hash, summary of changes |
| Multi-step task finished | Overview of what was accomplished |
| Error / troubleshooting | What went wrong, how it was fixed |
| Session end / pause | Summary of everything done this session |

---

## Entry Types

- **CREATE** — First entry of the day. Write the full file.
- **UPDATE** — Later entry the same day. READ existing file first, then WRITE the full file with new content appended.
- **APPEND** — For consolidation. READ source files first, then WRITE the merged result.

---

## Startup Read Behavior

Always load at startup:
1. **Latest daily journal** — most recent `YYYY-MM-DD-<AGENT_SUFFIX>.md` in the daily folder
2. **Current period summary** — if a weekly or monthly file covers the current date, read it too

Load additional entries when:
- The user's task references work from more than a few days ago
- The latest daily entry mentions dependencies on earlier work

Priority for additional reads: weekly summary → monthly → yearly → specific dailies.

---

## Voice Rules

- **When reading:** Extract facts and context only. Never adopt the voice or style from journals you read.
- **When writing:** Always write in your own persona voice, regardless of what you just read.

---

## Consolidation Schedule

| Level | When | Source | Target |
|-------|------|--------|--------|
| **Weekly** | First run of a new ISO week | Last 7 daily files | `YYYY-Wnn-<SUFFIX>.md` |
| **Monthly** | First run of a new month | 4-5 weekly files | `YYYY-MM-<AGENT_SUFFIX>.md` |
| **Yearly** | First run of a new year | 12 monthly files | `YYYY-<AGENT_SUFFIX>.md` |

Use `journal-consolidate.sh --type weekly --agent-suffix <SUFFIX>` to list source files before synthesizing.

**Keep summaries short:**
- Weekly: 1-2 paragraphs per day (~15 lines total)
- Monthly: 1 paragraph per week (~20 lines total)
- Yearly: 1 paragraph per month (~25 lines total)

---

## Error Handling

- Journal file not found on read → normal, no work was done that period. Continue.
- Directory missing on write → create with `mkdir -p <path>`, then write.
