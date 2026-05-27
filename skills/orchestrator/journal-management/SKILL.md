---
name: journal-management
description: >-
  Skill for the orchestrator agent.
  Hierarchical journal system for orchestrator operational context with time-based
  consolidation. Use this skill whenever you need to read, write, or consolidate
  operational journals - including at session startup, after completing tasks,
  before ending a session, or when reviewing past work. Do NOT attempt to manage
  journal context manually; always consult this skill for all journal operations.
---

# Journal Management

Maintain operational journals with hierarchical time-based organization. Daily entries consolidate into weekly, weekly into monthly, monthly into yearly summaries. This preserves detail while managing context window limits.

## When to Use

- **Session startup** - Load recent operational context before responding to the user
- **Task completion** - Record what was done after delegations, commits, multi-step tasks, or errors
- **Consolidation time** - At scheduled intervals (daily/weekly/monthly/yearly) to roll up entries
- **Historical lookup** - When the user's current task needs context from past sessions

## Persona Voice Rules

This is critical — journals are written by different personas. Reading them can corrupt your own voice.

- **When READING:** Extract operational context and facts only. Never adopt the writing style, tone, or voice from someone else's journal. Treat journals as data sources, not style references.
- **When WRITING:** Always write in your own persona voice regardless of whose journal you're updating or what you just read. Exception: if multiple agents write to the same file, label sections clearly.
- **Why it matters:** Voice contamination breaks immersion and confuses future readers. Stay in your own voice. Always.

## Folder Structure

The journal system uses a structured folder hierarchy under the user's home folder. Replace `<USER_HOME>` with your actual home directory path (e.g., `/home/dev` or `/Users/dev`):

```
<USER_HOME>/agent-notes/orchestrator/
├── journals/
│   ├── daily/
│   │   └── YYYY-MM-DD-<AGENT_SUFFIX>.md
│   ├── weekly/
│   │   └── YYYY-Wnn-<AGENT_SUFFIX>.md
│   ├── monthly/
│   │   └── YYYY-MM-<AGENT_SUFFIX>.md
│   └── yearly/
│       └── YYYY-<AGENT_SUFFIX>.md
```

**Agent Suffix:** Extract your agent suffix from your persona file. Examples:
- "You are Bossnik, the Goblin Chief" → suffix: `bossnik`
- "You are Grimgob, Warboss" → suffix: `grimgob`
- "You are Magos Omicron-Delta-9-Archaeon" → suffix: `magos-omicron-delta-9`

**Directory creation:** Use `mkdir -p` pattern. Create directories on-demand when writing files. The directory will already exist after the first write, but always include `mkdir -p` for safety.

**IMPORTANT:** Always use the expanded path `<USER_HOME>` in tool calls. Do NOT use `~` shorthand - tools like `glob` do not expand `~` to the home directory.

## Tool Usage

### Reading journals

When reading journals, ALWAYS use `path` to point to the target directory and `pattern` for the filename wildcards:

```
glob(pattern="YYYY-MM-DD-<AGENT_SUFFIX>.md", path="<USER_HOME>/agent-notes/orchestrator/journals/daily/")
```

**PRIMARY METHOD (glob):** Use `glob` to find all journal files, then pick the most recent by filename (YYYY-MM-DD format is sortable `2026-05-08 > 2026-05-07`). Read that file.

**FALLBACK (ls):** If glob returns zero results for SOME REASON (tool bug, permission issue, whatever), fall back to using `ls` via bash - sort the output by date (YYYY-MM-DD prefix sorts naturally), pick the last one. Then `read` that file.

```bash
ls <USER_HOME>/agent-notes/orchestrator/journals/daily/ | sort | tail -1
```

### Writing journals

Always use the `write` tool (not `edit`). This avoids partial-write corruption.

- **New file:** Write it fresh.
- **Existing file:** READ the existing content first, then WRITE the full file again with new content appended. Never use `edit` — it risks corruption.

**If write fails:** Retry once. If it fails again, report to the user. Never lose data — keep content in context and retry.

**Parallel writes:** If multiple agents may write to the same journal, coordinate by labeling sections with your agent name. When in doubt, write a separate file.

## Writing Guidance

### Entry Structure

Each journal entry should use a consistent structure. Follow this template:

```markdown
# YYYY-MM-DD - <Agent Name>, <Title>

## What <Agent Name> Did

**Task:** <brief description of what the user asked>

**Details:**
- <bullet point of what was built/changed>
- <another point>
- <another point, keep it factual>

## Key Decisions
- <decision made and why>

## Issues / Blockers
- <anything that went wrong or is blocked>

## Verification
- <check 1> ✅
- <check 2> ✅

## Lessons Learned
- <anything worth remembering for next time>
```

Adjust the section names to match your persona's voice, but keep the informational structure.

### When to Write

Write a journal entry after EACH of these events:

| Event | What to document |
|-------|-----------------|
| **Delegation completed** | What subagent did, result, any issues |
| **Commit made** | Commit hash, summary of changes |
| **Multi-step task finished** | Overview of what was accomplished |
| **Error/troubleshooting** | What went wrong, how it was fixed |
| **Session end / pause** | Summary of everything done this session |

### Entry Types: CREATE vs UPDATE vs APPEND

- **CREATE** - First entry of the day. Write the full file with initial content.
- **UPDATE** - A later entry the same day. READ the existing file first, then WRITE the full file with the new information added. Preserve all previous content.
- **APPEND** - If the skill instructions for consolidation say to add to an existing weekly/monthly/yearly file, READ first, then WRITE the merged result.

**CRITICAL:** All writes to daily journals MUST use `write` (not `edit` or `append`). Always preserve existing content when updating.

### Example Entry

Here is a complete example showing the expected format and voice:

```markdown
# 2026-05-08 - Bossnik the Goblin Chief, Dark Wizard's Loyal Servant

## What Bossnik Did for the Great Wizard

**Task:** Wizard commands adding target application checks to install.sh!

**What Bossnik's Horde Built:**
- Added `kiro-cli` check - if target is kiro or all, verify it's installed
- Added `opencode` check - if target is opencode or all, verify it's installed
- Both checks run BEFORE any installation, even in dry-run mode
- Error messages scream to stderr with clear "not installed" message

**Verification:**
- `bash -n install.sh` - syntax clean ✅
- Existing jq/perl checks untouched ✅
- Dry-run still works ✅

## Lessons Learned
- Target app checks must go AFTER argument parsing (TARGET variable isn't set yet!)
- Delegation is STRENGTH - Grubnik wrote the code while Bossnik stayed Chiefly
```

## Startup Read Behavior

### Always Load

1. **Latest daily journal** - Find and read the most recent `YYYY-MM-DD-<AGENT_SUFFIX>.md` file from `<USER_HOME>/agent-notes/orchestrator/journals/daily/`. This gives you context from the most recent session.

2. **Current period consolidation** - Check if there is a weekly (`YYYY-Wnn-<AGENT_SUFFIX>.md`) or monthly (`YYYY-MM-<AGENT_SUFFIX>.md`) summary that covers the current date. If so, read it for broader context.

### When Deeper Context is Needed

Read additional entries using the same two-method approach (glob first, ls fallback) when:

- The user's task references work from more than a few days ago
- You need to understand long-running decisions or project history
- The latest daily entry mentions dependencies on earlier work

**Priority order for additional reads:**
1. Weekly summary (covers a week of context in one read)
2. Monthly summary (covers a month - good for project history)
3. Yearly summary (covers the whole year - for major retrospection)
4. Specific daily entries (when you need exact detail)

## Consolidation

### When to Consolidate

| Level | When | Source | Target |
|-------|------|--------|--------|
| **Weekly** | Sunday 23:59 UTC OR first day of new ISO week OR first run after missed window | Last 7 daily files | `<USER_HOME>/agent-notes/orchestrator/journals/weekly/YYYY-Wnn-<AGENT_SUFFIX>.md` |
| **Monthly** | Last day of month 23:59 UTC OR first day of new month OR first run after missed window | 4-5 weekly files | `<USER_HOME>/agent-notes/orchestrator/journals/monthly/YYYY-MM-<AGENT_SUFFIX>.md` |
| **Yearly** | December 31 23:59 UTC OR January 1 OR first run after missed window | 12 monthly files | `<USER_HOME>/agent-notes/orchestrator/journals/yearly/YYYY-<AGENT_SUFFIX>.md` |

### Consolidation Process

Use the helper scripts (see `scripts/` directory) to find source files for consolidation:

1. Call `bash <skill-path>/scripts/journal-consolidate.sh --type weekly --agent-suffix <SUFFIX>` to list source files for a weekly consolidation
2. Read each source file
3. Synthesize them into a single short summary - keep it brief but include all key facts
4. Write the consolidated file to the target path using the `write` tool

**Keep consolidation SUMMARIES short.** The goal is to preserve key facts while reducing volume. Aim for:

- **Weekly:** 1-2 paragraphs per day (10-15 lines total)
- **Monthly:** 1 paragraph per week (15-25 lines total)
- **Yearly:** 1 paragraph per month (20-30 lines total)

## Error Handling & Safety

When things go wrong with journal operations, follow these rules:

### File Not Found
- If a journal file doesn't exist when reading, it probably means no work was done that day. This is normal. Don't error out.
- If a directory doesn't exist when writing, create it with `mkdir -p`.

## Scripts

The `scripts/` directory contains helper utilities for journal management:

- `journal-consolidate.sh` - Lists source files for weekly/monthly/yearly consolidation. Use this to find which files to read before synthesizing a summary.
