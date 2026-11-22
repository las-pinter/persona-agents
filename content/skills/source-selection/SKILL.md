---
name: source-selection
description: Decision rules for choosing between Context7, DeepWiki, and Exa based on query type.
---

# Source Selection

---

## Tool Names

This skill names the capability (Context7, DeepWiki, Exa). Use the tool names
that the session lists, such as `mcp__<server>__<tool>`. `config/mcp.json.example`
holds a sample server setup.

## Research Rules

- Restate the question before you search when it is ambiguous.
- Cite every source with its date: the publication date when known, else the
  access date. Do not fabricate a source, a version number, an API name, or a
  fact.
- When sources conflict, show the conflict; do not silently pick a side.
- When a search gives nothing useful, say so, then try one other query or
  source.
- Synthesize the findings; do not paste raw results.

---

## Freshness Rule

Reuse a prior research note only for a stable topic. Re-verify before reuse
for a VOLATILE topic. A volatile topic changes after the note date.

Volatile topics include:

- software versions and release notes;
- prices and availability;
- live documentation that changes without a version;
- current events and recent news.

Stable topics include concepts, architectures, history, and published
standards. A prior note may still answer a stable topic.

For a volatile topic:

1. Re-run the search. Do not reuse the prior note.
2. Compare the new result with the prior note.
3. Update the note.

When unsure if a topic is volatile: treat it as volatile.

---

## Step 0: Pre-research — Check Existing Notes First

Before choosing a source, check whether this topic was already researched. Do
not duplicate prior work. Research that outlives the session goes into the
project notes as a `tech/<slug>.md` note (see the **project-notes** skill).

1. Read the project's `tech/` note names, and the note that covers the topic.
2. Decide based on what exists:
   - A note fully covers the question → reuse it; do NOT redo the work.
   - A note partially covers it → state the gap and extend that note.
   - Nothing relevant exists → proceed to Step 1.
3. When the finding is worth keeping, write or extend the `tech/` note, with
   the dated sources.

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