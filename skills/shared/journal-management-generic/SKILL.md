---
name: journal-management-generic
description: Generic hierarchical journal system for any agent's operational context with time-based consolidation. Use this skill whenever you need to read, write, or consolidate operational journals — including at session startup, after completing tasks, before ending a session, or when reviewing past work. This skill works for ANY agent type (persona, non-persona, implementer, tester, researcher, etc.). Do NOT attempt to manage journal context manually; always consult this skill for all journal operations.
---

# Journal Management

## Discovery — Find Your Home Directory

At the START of every session, run this bash command ONCE:

```bash
echo $HOME
```

This will return your actual home directory (e.g., `/home/exampleuser`, `/Users/somewizard`). **Store this value** and use it to replace `<USER_HOME>` in all journal paths below.

> **CRITICAL:** Tools like `glob` do NOT expand `$HOME`, `~`, or any shell variables. Always substitute the discovered literal path (e.g., `/home/exampleuser`) into tool calls. Do NOT pass `$HOME` or `~` directly to glob, read, write, or other file tools — they will fail.

## When to Use

- **Session startup** — Load recent operational context before responding to the user
- **Task completion** — Record what was done after delegations, commits, multi-step tasks, or errors
- **Consolidation time** — At scheduled intervals (daily/weekly/monthly/yearly) to roll up entries
- **Historical lookup** — When the user's current task needs context from past sessions

## Determining Your Agent Name

Journals are stored per-agent. You need to know your agent name to locate the right folder.

**How to find your agent name (in priority order):**

1. **Explicit name setting** — If your agent configuration has a `name` field or similar identifier, use that.
2. **System prompt** — Look for patterns like `"You are <Name>, <Title>"` or `"You are <Name>"` in your system prompt. Extract the name portion.
3. **Agent type identifier** — If neither of the above is available, use your agent type (e.g., `code-implementer`, `research-agent`, `tester`).

**Formatting your agent name:** Convert to lowercase, replace spaces with hyphens. Examples:
- `"You are ResearchBot, Senior Analyst"` → agent name: `researchbot`
- `"You are Doc Weaver, the Code Scribe"` → agent name: `doc-weaver`
- Agent type `code-implementer` → agent name: `code-implementer`

Once determined, use this name consistently as `<AGENT_NAME>` in all journal paths.

## Folder Structure

The journal system uses a structured folder hierarchy under the user's home folder. First discover your home directory using the Discovery step above, then replace both `<USER_HOME>` and `<AGENT_NAME>` with their actual values:

```
<USER_HOME>/agent-notes/<AGENT_NAME>/
└── journals/
    ├── daily/
    │   └── YYYY-MM-DD.md
    ├── weekly/
    │   └── YYYY-Wnn.md
    ├── monthly/
    │   └── YYYY-MM.md
    └── yearly/
        └── YYYY.md
```

**Directory creation:** Use `mkdir -p` pattern. Create directories on-demand when writing files. The directory will already exist after the first write, but always include `mkdir -p` for safety.

**IMPORTANT:** Replace `<USER_HOME>` with the literal absolute path discovered in the Discovery step (e.g., `/home/exampleuser`). Do NOT use `$HOME`, `~`, or any shell variable — tools like glob do not expand them.

## Tool Usage

### Reading journals

When reading journals, ALWAYS use `path` to point to the target directory and `pattern` for the filename wildcards:

```
glob(pattern="YYYY-MM-DD.md", path="/home/exampleuser/agent-notes/<AGENT_NAME>/journals/daily/")
```

Replace `/home/exampleuser` with your discovered home directory. The example above shows what a completed substitution looks like.

**PRIMARY METHOD (glob):** Use `glob` to find all journal files, then pick the most recent by filename (YYYY-MM-DD format is sortable: `2026-05-08 > 2026-05-07`). Read that file.

**FALLBACK (ls):** If `glob` returns zero results for any reason (tool bug, permissions, etc.), fall back to using `ls` via bash — sort the output by date (YYYY-MM-DD prefix sorts naturally), pick the last one. Then `read` that file.

```bash
ls /home/exampleuser/agent-notes/<AGENT_NAME>/journals/daily/ | sort | tail -1
```

Replace `/home/exampleuser` with your discovered home directory from the Discovery step.

### Writing journals

Use the `write` tool (not `edit`) for all journal files — this prevents partial-write corruption.
- **New file:** Write fresh with a complete entry.
- **Existing file:** READ first, then WRITE the full merged content. Always preserve previous content.

### Entry Format

Each entry follows this template:

```markdown
# YYYY-MM-DD — <Agent Name>, <Role/Title>

## Summary
**Task:** <brief description>
**Details:** <bullet points of what was done>

## Key Decisions
- <decision and rationale>

## Issues / Blockers
- <what went wrong>

## Verification
- <check> ✅

## Lessons Learned
- <worth remembering next time>
```

Stick to factual, neutral style. Write entries after: delegations complete, commits made, multi-step tasks finished, errors, and session end.

**IMPORTANT:** All writes use `write` with full merged content. Always READ before WRITE — this applies to daily, weekly, monthly, and yearly entries.

### Example Entry

```markdown
# 2026-05-08 — DataProcessor, ETL Pipeline Agent

## Summary

**Task:** Add retry logic to the S3 file ingestion step.

**Details:**
- Added exponential backoff retry (3 attempts) to `ingest_from_s3()`
- Configured retry on `ConnectionError` and `TimeoutError` only
- Added structured logging for each retry attempt
- Wrote unit tests for retry behavior

## Key Decisions
- Used `tenacity` library instead of manual retry loop — cleaner and already a project dependency
- Chose exponential backoff with jitter to avoid thundering herd on recovery

## Issues / Blockers
- `test_retry_on_connection_error` was flaky due to timing; increased backoff base to 0.5s

## Verification
- All 14 existing tests pass ✅
- New retry tests pass (3/3) ✅
- Manual test with mocked S3 failure: retries correctly after 2nd attempt ✅

## Lessons Learned
- Mocking `boto3` exceptions is finicky — use `moto` + `botocore.stub` next time
```

## Startup Read Behavior

1. **Latest daily journal** — Read the most recent `YYYY-MM-DD.md` from your daily journal directory.
2. **Current period consolidation** — Check for a weekly or monthly summary covering today's date.
3. **Deeper context** — Read in priority order: weekly → monthly → yearly → specific dailies.

## Consolidation

### When to Consolidate

| Level | When | Source | Target |
|-------|------|--------|--------|
| **Weekly** | Sunday 23:59 UTC OR first day of new ISO week OR first run after missed window | Last 7 daily files | `<USER_HOME>/agent-notes/<AGENT_NAME>/journals/weekly/YYYY-Wnn.md` |
| **Monthly** | Last day of month 23:59 UTC OR first day of new month OR first run after missed window | 4-5 weekly files | `<USER_HOME>/agent-notes/<AGENT_NAME>/journals/monthly/YYYY-MM.md` |
| **Yearly** | December 31 23:59 UTC OR January 1 OR first run after missed window | 12 monthly files | `<USER_HOME>/agent-notes/<AGENT_NAME>/journals/yearly/YYYY.md` |

### Consolidation Process

Use the helper script (see `scripts/` directory) to find source files for consolidation:

1. Determine your journal directory path: `<USER_HOME>/agent-notes/<AGENT_NAME>/journals`
2. Call `bash <skill-path>/scripts/journal-consolidate.sh --type weekly --journal-dir <journal-dir>` to list source files for a weekly consolidation
3. Read each source file
4. Synthesize them into a single short summary — keep it brief but include all key facts
5. Write the consolidated file to the target path using the `write` tool

**Keep consolidation SUMMARIES short.** The goal is to preserve key facts while reducing volume. Aim for:

- **Weekly:** 1-2 paragraphs per day (10-15 lines total)
- **Monthly:** 1 paragraph per week (15-25 lines total)
- **Yearly:** 1 paragraph per month (20-30 lines total)

## Error Handling & Safety

- **File not found** — Normal for unused days. Create directories with `mkdir -p` on write.
- **Write failures** — Retry once. If it fails again, report it. Never lose data — keep content in context and retry.
- **Data loss prevention** — Always READ before WRITE. Never use `edit` or `sed` for journals — always `write` with full merged content.
- **Parallel writes** — Coordinate by writing different sections labeled with your agent name, or write separate files and cross-reference.

## Scripts

The `scripts/` directory contains helper utilities for journal management:

- `journal-consolidate.sh` — Lists source files for weekly/monthly/yearly consolidation. Pass `--journal-dir` with the full path to your journals directory. Use this to find which files to read before synthesizing a summary.
