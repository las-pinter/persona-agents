---
name: journal-management
description: Hierarchical journal system for orchestrator operational memory with time-based consolidation.
---

# Journal Management

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

## Write Timing

### Working Memory
- **When:** During active session, append as operations complete
- **Target:** `journals/working/current.md`

### Daily
- **When:** 00:00 UTC OR session shutdown (if >6 hours since last consolidation) OR first run after missed window
- **Source:** `journals/working/current.md`
- **Target:** `journals/daily/YYYY-MM-DD.md`
- **Action:** Consolidate working memory, daily file, clear working memory after successful write

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

### Always Load (in order)

1. The latest summary in `journals/daily/` if there is any
2. The summary in `journals/working/current.md` if there is any
