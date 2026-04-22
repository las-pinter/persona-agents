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

```
~/agent-notes/orchestrator/
├── journals/
│   ├── daily/
│   │   └── YYYY-MM-DD.md
│   ├── weekly/
│   │   └── YYYY-Wnn.md
│   ├── monthly/
│   │   └── YYYY-MM.md
│   └── yearly/
│       └── YYYY.md
```

**Creation:** Use `mkdir -p` pattern. Create directories on-demand when writing files.

**CRITICAL:** All writes to daily journals MUST use APPEND mode to prevent data loss!

## Write Timing

### Daily Journal (Active Session)
- **When:** During active session, append as operations complete
- **Target:** `journals/daily/YYYY-MM-DD.md` (current day)
- **Action:** APPEND entries directly to current day's journal file (NEVER overwrite!)

### Weekly
- **When:** Sunday 23:59 UTC OR first day of new ISO week OR first run after missed window
- **Source:** Last 7 (or less if there was a missing summary) daily files from `journals/daily/`
- **Target:** `journals/weekly/YYYY-Wnn.md` (ISO week number)
- **Action:** Synthesize 7 daily summaries into weekly summary, keep it as short as possible

### Monthly
- **When:** Last day of month 23:59 UTC OR first day of new month OR first run after missed window
- **Source:** 4-5 (or less if there was a missing summary) weekly files from `journals/weekly/`
- **Target:** `journals/monthly/YYYY-MM.md`
- **Action:** Synthesize weekly summaries into monthly summary, keep it as short as possible

### Yearly
- **When:** December 31 23:59 UTC OR January 1 OR first run after missed window
- **Source:** 12 (or less if there was a missing summary) monthly files from `journals/monthly/`
- **Target:** `journals/yearly/YYYY.md`
- **Action:** Synthesize monthly summaries into yearly summary, keep it as short as possible

## Startup Read Behavior

### Always Load

1. The latest daily journal from `journals/daily/` (most recent YYYY-MM-DD.md file)
