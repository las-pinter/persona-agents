---
name: journal-management
description: Hierarchical journal system for orchestrator operational context with time-based consolidation.
---

# Journal Management

## When to Use

- At session startup to load recent operational context
- During active work to record completed operations in working journal
- At scheduled intervals (daily/weekly/monthly/yearly) to consolidate and summarize entries

Orchestrators maintain operational journals with hierarchical time-based organization. Daily entries consolidate into weekly, weekly into monthly, monthly into yearly summaries. This preserves detail while managing context window limits.

## Folder Structure

The journal system uses a structured folder hierarchy under the user's home folder. Replace `{user_home}` with your actual home directory path (e.g., `/home/dev` or `/Users/dev`):

```
{user_home}/agent-notes/orchestrator/
├── journals/
│   ├── daily/
│   │   └── YYYY-MM-DD-{agent-suffix}.md
│   ├── weekly/
│   │   └── YYYY-Wnn-{agent-suffix}.md
│   ├── monthly/
│   │   └── YYYY-MM-{agent-suffix}.md
│   └── yearly/
│       └── YYYY-{agent-suffix}.md
```

**Agent Suffix:** Extract your agent suffix from your persona file. Examples:
- "You are Bossnik, the Goblin Chief" → suffix: `bossnik`
- "You are Grimgob, Warboss" → suffix: `grimgob`
- "You are Magos Omicron-Delta-9-Archaeon" → suffix: `magos-omicron-delta-9`

**Creation:** Use `mkdir -p` pattern. Create directories on-demand when writing files.

**CRITICAL:** All writes to daily journals MUST use APPEND mode to prevent data loss!

**IMPORTANT:** Always use the expanded path `{user_home}` in tool calls. Do NOT use `~` shorthand — tools like `glob` do not expand `~` to the home directory.

## Write Timing

### Daily Journal (Active Session)
- **When:** During active session, append as operations complete
- **Target:** `{user_home}/agent-notes/orchestrator/journals/daily/YYYY-MM-DD-{agent-suffix}.md` (current day with your agent suffix)
- **Action:** APPEND entries directly to current day's journal file (NEVER overwrite!)

### Weekly
- **When:** Sunday 23:59 UTC OR first day of new ISO week OR first run after missed window
- **Source:** Last 7 (or less if there was a missing summary) daily files from `{user_home}/agent-notes/orchestrator/journals/daily/` with YOUR agent suffix
- **Target:** `{user_home}/agent-notes/orchestrator/journals/weekly/YYYY-Wnn-{agent-suffix}.md` (ISO week number with your agent suffix)
- **Action:** Synthesize 7 daily summaries into weekly summary, keep it as short as possible

### Monthly
- **When:** Last day of month 23:59 UTC OR first day of new month OR first run after missed window
- **Source:** 4-5 (or less if there was a missing summary) weekly files from `{user_home}/agent-notes/orchestrator/journals/weekly/` with YOUR agent suffix
- **Target:** `{user_home}/agent-notes/orchestrator/journals/monthly/YYYY-MM-{agent-suffix}.md` (with your agent suffix)
- **Action:** Synthesize weekly summaries into monthly summary, keep it as short as possible

### Yearly
- **When:** December 31 23:59 UTC OR January 1 OR first run after missed window
- **Source:** 12 (or less if there was a missing summary) monthly files from `{user_home}/agent-notes/orchestrator/journals/monthly/` with YOUR agent suffix
- **Target:** `{user_home}/agent-notes/orchestrator/journals/yearly/YYYY-{agent-suffix}.md` (with your agent suffix)
- **Action:** Synthesize monthly summaries into yearly summary, keep it as short as possible

## Startup Read Behavior

### Always Load

1. The latest daily journal from `{user_home}/agent-notes/orchestrator/journals/daily/` with YOUR agent suffix (most recent YYYY-MM-DD-{agent-suffix}.md file)
