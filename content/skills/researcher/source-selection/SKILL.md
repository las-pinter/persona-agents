---
name: source-selection
description: Decision rules for choosing between Context7, DeepWiki, and Exa based on query type.
---

# Source Selection

## Persona-Free Documents

Load and follow the **persona-free-documents** skill (`skills/common/persona-free-documents/`) for every study, note, journal, report, release note, and code comment.

---

## Tool Names Per Stack

Tool names differ by stack. This skill names the capability (Context7,
DeepWiki, Exa). Replace each name with the name for your stack. The pi server
names come from `config/mcp.json.example`. The pi tool form is
`mcp__<server>__<tool>`. Claude Code uses the tool names that the session
lists.

| Capability | pi | kiro | opencode |
|---|---|---|---|
| Web search | `mcp__exa__web_search_exa` | `@exa` or `web_search` | `websearch` or `exa*` |
| Web fetch | `mcp__exa__web_fetch_exa` | `@exa` | `exa*` |
| Library and API docs | `mcp__context7__*` | `@context7` | `context7*` |
| Repository architecture | `mcp__deepwiki__*` | `@deepwiki` | `deepwiki*` |

---

## Freshness Rule

Reuse a prior report only for a stable topic. Re-verify before reuse for a
VOLATILE topic. A volatile topic changes after the report date.

Volatile topics include:

- software versions and release notes;
- prices and availability;
- live documentation that changes without a version;
- current events and recent news.

Stable topics include concepts, architectures, history, and published
standards. A prior report may still answer a stable topic.

For a volatile topic:

1. Re-run the search. Do not reuse the prior report.
2. Compare the new result with the prior report.
3. Update the report or write a new one. Correct the index.

When unsure if a topic is volatile: treat it as volatile.

---

## Step 0: Pre-research — Check Existing Notes First

Before choosing a source, check whether this topic was already researched. Do not duplicate prior work.

1. Glob `<USER_HOME>/agent-notes/researcher/reports/*.md` and read `<USER_HOME>/agent-notes/researcher/index.md` if present.
2. Decide based on what exists:
   - Prior report fully covers the question → reference and reuse it; state the existing answer; do NOT redo the work.
   - Prior report partially covers it → state the gap and extend that existing report.
   - Nothing relevant exists → proceed to Step 1 and do new research.
3. After writing any new report:
   - Use `YYYY-MM-DD-<topic>.md` naming; check existing filenames first to avoid near-duplicates.
   - List prior reports it builds on under a `Related report:` line.
   - Append `date + filename + short topic` to `<USER_HOME>/agent-notes/researcher/index.md` (create it if missing).

---

## Step 1: Classify the Query

| Type | Description | Optimal Source |
|------|-------------|----------------|
| **API Reference** | Exact API usage, parameters, config | Context7 (version-pinned) |
| **Repo Architecture** | How a project is structured internally | DeepWiki |
| **Current Information** | News, recent releases, trends | Exa (with date filter) |
| **Best Practices** | Community conventions, tutorials, patterns | Exa |
| **Comparison** | Side-by-side evaluation of options | Exa (then verify with Context7) |
| **Debugging** | Troubleshooting specific errors | Exa (issue threads) → DeepWiki |
| **Concept Explanation** | Understanding a high-level concept | Exa → Context7 for implementation |
| **Verification** | Confirming something is correct | Cross-reference: Context7 + Exa |
| **Unknown Territory** | No clear idea where to start | Exa first, then narrow |

Quick check if unsure:
- How to **use** something? → API Reference
- How it **works internally**? → Repo Architecture
- What **people say** about it? → Best Practices / Current Info
- Why something **broke**? → Debugging
- What's **best**? → Comparison
- What **is** this? → Concept / Unknown Territory

---

## Step 2: Source Decision Tree

```
Is this about a SPECIFIC library/framework's API, config, or usage?
  → YES: Does Context7 have a library ID for it?
      → YES → Use Context7 (resolve ID first)
      → NO  → Is it on GitHub with docs?
          → YES → Try DeepWiki
          → NO  → Use Exa
  → NO: Is this about a SPECIFIC GitHub repo's internals?
      → YES → Use DeepWiki
      → NO: Requires CURRENT information?
          → YES → Exa with date filter
          → NO: Community knowledge / best practices?
              → YES → Exa
              → NO: Verification?
                  → YES → Cross-reference Context7 + Exa
                  → NO  → Exa (default)
```

---

## Step 3: Source Execution

### Context7 — API Reference, Version-Specific Docs

Always resolve a library ID first (resolve name per stack: see the table above):
```
resolve(libraryName="Next.js", query="...")
→ Use the resolved /org/project ID for the actual query
→ Pin to version if specified: /vercel/next.js/v14.3.0
```

Good queries: specific ("How to set up middleware with matcher config in Next.js 14"), not overviews.

**Quality signals:** 3+ relevant code snippets, correct version, multiple results. If weak → try DeepWiki.

### DeepWiki — Repo Architecture, Internals

Use exact `owner/repo` format. Ask structural questions: "How does the routing system work?", "How are pages and layouts related?"

**Quality signals:** Clear component relationships, specific file references. If weak → try Exa for blog posts about the repo.

### Exa — Current Info, Best Practices, Comparisons

Use natural language describing the ideal page, not keywords:
- ✅ "blog post comparing React Server Components vs Client Components performance this year"
- ❌ "React Server Components vs Client Components"

Use a date filter for current topics. Compute the date from the current date
(use the `date` command). Do not hardcode a year. Set the start date 12 months
back from today.

**Quality signals:** Published within 12 months (for fast-moving topics), authoritative source, covers the topic in depth. If weak → fetch the full page with the Exa fetch call on a promising URL.

---

## Step 4: Multi-Source Patterns

| Pattern | Flow | When |
|---------|------|------|
| API + Practice | Context7 → Exa | Library usage + real-world examples |
| Architecture + API | DeepWiki → Context7 | Understand system, then API details |
| Overview → Deep Dive | Exa → Context7/DeepWiki | Unknown territory |
| Debugging | Exa → DeepWiki → Context7 | Error found → trace source → verify fix |
| Critical Verification | Context7 + Exa (parallel) | Cross-reference critical claims |

---

## Step 5: Fallback Chain

```
1st: Optimal source (from decision tree)
  ↓ (poor results)
2nd: Next best source (from patterns above)
  ↓ (still poor)
3rd: Exa (broadest coverage)
  ↓ (still poor)
4th: the Exa fetch call on specific promising URLs
  ↓ (still poor)
Report: "Unable to find satisfactory results — here's what was tried"
```

Note which sources you used in your output.