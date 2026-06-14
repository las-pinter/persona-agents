---
name: source-selection
description: >-
  Skill for the researcher agent.
  Decision rules for choosing between Context7, DeepWiki, and Exa based on
  query type. Load BEFORE every research action — do NOT guess which source to
  use without consulting this skill.
---

# Source Selection

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

Always resolve a library ID first:
```
context7_resolve(libraryName="Next.js", query="...")
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
- ✅ "blog post comparing React Server Components vs Client Components performance 2025"
- ❌ "React Server Components vs Client Components"

Use date filters for current topics: `after:2025` or `after:2026`.

**Quality signals:** Published within 12 months (for fast-moving topics), authoritative source, covers the topic in depth. If weak → fetch the full page with `exa_web_fetch_exa` on a promising URL.

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
4th: exa_web_fetch_exa on specific promising URLs
  ↓ (still poor)
Report: "Unable to find satisfactory results — here's what was tried"
```

---

## Key Rules

1. Classify before you search — a 2-second classification saves a wasted query.
2. Always resolve Context7 library IDs before querying.
3. Use date filters on Exa for current or fast-moving topics.
4. Prefer Context7 over web search for library-specific questions — faster and more accurate.
5. Note which sources you used in your output.