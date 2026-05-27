---
name: source-selection
description: >-
  Skill for the researcher agent.
  Decision rules for choosing between Context7, DeepWiki, and Exa based on query
  type. Use BEFORE every research action to select the appropriate source — do
  NOT skip this skill and guess which source to use. This skill provides a
  systematic query classification system, multi-source orchestration patterns,
  source quality heuristics, and fallback chains. Consult it whenever you need
  to research any topic: library APIs, repository internals, web searches,
  comparisons, current information, or debugging. If you're about to open a
  browser or search tool without consulting this skill first, STOP and read it.
---

# Source Selection — Systematic Source Intelligence

A researcher is only as good as their sources. Using the wrong source wastes
queries, returns stale results, or misses critical context. This skill gives
you a repeatable methodology to match every query to its optimal source.

---

## Methodology Overview

```
1. CLASSIFY   → What type of query is this? (API? Architecture? Current info?)
2. MATCH      → Pick the primary source from the decision tree
3. EXECUTE    → Query the source with optimal parameters
4. EVALUATE   → Did the source return useful results? Use quality heuristics.
5. CHAIN      → If results are insufficient, follow the orchestration pattern
6. VERIFY     → Cross-reference critical findings across 2+ sources
```

---

## Step 1: Query Classification

Not all queries are the same. Classify your query FIRST, then pick the source.

### Query Type Taxonomy

| Type | Description | Examples | Optimal Source |
|------|-------------|----------|----------------|
| **API Reference** | Exact API usage, parameters, return types, configuration | "How to use `useEffect` in React 18" | **Context7** (version-pinned) |
| **Repo Architecture** | How a project is structured, its internals, design decisions | "How does Next.js handle route groups internally?" | **DeepWiki** |
| **Current Information** | News, recent releases, trends, live data | "What's new in Next.js 16?" | **Exa** (with date filter) |
| **Best Practices** | Community conventions, tutorials, patterns | "Best practices for error handling in Go" | **Exa** |
| **Comparison** | Side-by-side evaluation of options | "Redis vs Memcached for caching" | **Exa** (then verify with Context7) |
| **Debugging** | Troubleshooting specific errors or behaviors | "NextAuth getServerSession returning null" | **Exa** (issue threads, then DeepWiki for source) |
| **Concept Explanation** | Understanding a high-level concept or theory | "What is the actor model?" | **Exa** (articles, then Context7 for language-specific impl) |
| **Verification** | Confirming a fact or approach is correct | "Is `Math.random()` cryptographically secure?" | **Cross-reference: Context7 (docs) + Exa (discussions)** |
| **Unknown Territory** | No clear idea where to start | "How do I add authentication to my app?" | **Exa first** (overviews), **then** Context7 (specific lib docs) |

### Classification Quick-Check

If you're unsure which type, ask:
- Am I looking for **how to use** something? → API Reference
- Am I looking for **how it works** internally? → Repo Architecture
- Am I looking for **what people say** about it? → Best Practices / Current Info
- Am I looking for **why something broke**? → Debugging
- Am I looking for **what's best**? → Comparison
- Am I looking for **what this thing even is**? → Concept Explanation / Unknown Territory

---

## Step 2: Source Decision Tree

```
Q1: Is this about a SPECIFIC library/framework's API, config, or usage?
  → YES: Does Context7 have a library ID for it?
      → YES → Use Context7 (resolve ID first, then query)
      → NO  → Is it on GitHub with docs?
          → YES → Try DeepWiki (repo structure + docs)
          → NO  → Use Exa
  → NO:  Proceed to Q2.

Q2: Is this about a SPECIFIC GitHub repository's architecture or internals?
  → YES: Use DeepWiki
  → NO:  Proceed to Q3.

Q3: Does this require CURRENT information (news, releases, trends)?
  → YES: Use Exa with date filters
  → NO:  Proceed to Q4.

Q4: Does this need community knowledge (best practices, tutorials, comparisons)?
  → YES: Use Exa
  → NO:  Proceed to Q5.

Q5: Is this a concept explanation or unknown territory?
  → YES: Start with Exa for overview, then drill into specific tools via Context7
  → NO:  Proceed to Q6.

Q6: Is this verification (confirming something is correct)?
  → YES: Cross-reference 2+ sources (Context7 + Exa, or DeepWiki + Exa)
  → NO:  Proceed to default.

DEFAULT: Start with Exa (broadest coverage), then narrow with
         Context7 or DeepWiki if more specific sources needed.
```

---

## Step 3: Source-Specific Execution

### Context7 — Best For: API Reference, Version-Specific Docs, Code Examples

**Always resolve a library ID first:**
```
context7_resolve(libraryName="Next.js", query="...")
→ Use the resolved /org/project ID for the actual query
→ Pin to a version if the user specifies one: /vercel/next.js/v14.3.0
```

**Optimal queries:**
- Be SPECIFIC: "How to set up middleware with matcher config in Next.js 14"
- Include context: "Usage with TypeScript and App Router"
- Don't ask for overviews you could get from a README

**Quality heuristics:**
| Signal | Good Result | Weak Result |
|--------|------------|-------------|
| Code snippets | ✅ 3+ relevant snippets with context | ❌ No code, or code from 3 versions ago |
| Version match | ✅ Exactly the version asked about | ❌ Wrong version or no version specified |
| Coverage | ✅ Multiple relevant results | ❌ Only 1-2 tangentially related results |

**When Context7 results are weak:** Try DeepWiki (repo docs may have more).

### DeepWiki — Best For: Repo Architecture, Internal Design, Source Structure

**Pick the right repo:**
- Use the exact owner/repo format: `vercel/next.js`, `facebook/react`
- For monorepos, specify the relevant package if DeepWiki supports it

**Optimal queries:**
- Structural: "How does the routing system work?"
- Relationship: "How do pages and layouts relate to each other?"
- Internals: "How is the bundling pipeline structured?"

**Quality heuristics:**
| Signal | Good Result | Weak Result |
|--------|------------|-------------|
| Architecture detail | ✅ Clear component relationships | ❌ Vague "see the code" responses |
| File references | ✅ Points to specific files/directories | ❌ No concrete references |
| Readability | ✅ Well-organized explanation | ❌ Wall of text, no structure |

**When DeepWiki results are weak:** Try Exa for blog posts or tutorials about the repo.

### Exa — Best For: Current Info, Best Practices, Tutorials, Comparisons

**Always use natural language queries:**
- Describe the ideal page, not keywords
  ✅ "blog post comparing React Server Components vs Client Components performance 2025"
  ❌ "React Server Components vs Client Components"

**Date filtering for current info:**
- The current year is 2026. Use `after:2025` or `after:2026` for recent content.
- For evergreen topics (concepts, fundamentals), date filtering is less critical.

**Quality heuristics:**
| Signal | Good Result | Weak Result |
|--------|------------|-------------|
| Recency | ✅ Published within last 12 months | ❌ Published 3+ years ago for a fast-moving topic |
| Authority | ✅ Official docs, well-known blogs, high-quality tutorials | ❌ Random forum post with no citations |
| Depth | ✅ Covers the topic thoroughly | ❌ Clickbait headline, shallow content |

**When Exa results are weak:** Try fetching the full page content with `exa_web_fetch_exa`
for a result that looked promising in highlights.

---

## Step 4: Multi-Source Orchestration Patterns

Some queries need multiple sources. Here are the proven patterns in compact form:

| Pattern | Flow | When |
|---------|------|------|
| API + Practice | Context7 → Exa | Library usage + real-world examples |
| Architecture + API | DeepWiki → Context7 | Understand system, then API details |
| Overview → Deep Dive | Exa → Context7/DeepWiki | Unknown territory, learn then drill |
| Debugging | Exa → DeepWiki → Context7 | Error found → trace source → verify fix |
| Critical Verification | Context7 + Exa (parallel) | Cross-reference critical claims |
| Unknown Territory | Exa → [C7/DW] → Exa | Start broad, go deep, validate |

---

## Step 5: Fallback Chain

When your primary source fails, follow this chain:

```
1st choice:  Optimal source (from decision tree)
  ↓ (if results are poor)
2nd choice:  Next best source (from orchestration patterns)
  ↓ (if still poor)
3rd choice:  Broadest source (Exa by default)
  ↓ (if still poor)
4th choice:  Web fetch (exa_web_fetch_exa) on specific promising URLs
  ↓ (if still poor)
Report back: "Unable to find satisfactory results for this query"
```

---

## Examples

### Good Example

**Query:** "What's the proper way to use Next.js 14 Server Actions with form validation?"

**Classification:** API Reference + Best Practices (mixed)

**Source selection:**

1. **Context7** → Resolve `/vercel/next.js` → Query for "Server Actions with form validation"
   - Result: API reference for `useActionState`, `"use server"` directive, form handling
   - Quality: Good — version-pinned, includes code snippets

2. **Exa** (chained) → Search "Next.js Server Actions form validation best practices 2025"
   - Result: Blog posts with real patterns, error handling approaches, loading states
   - Quality: Good — recent, from authoritative dev blogs

**Result:** Complete picture — official API + real-world practice.

### Bad Example — What NOT to Do

**Query:** "How does Prisma connection pooling work?"

**Wrong approach:**
```
❌ Exa search: "Prisma connection pooling"
   - Gets blog posts, maybe outdated, no official API reference
```

**Correct approach:**
```
✅ Context7: Resolve /prisma/prisma → Query "connection pooling configuration"
   - Gets official docs, API signatures, version-specific behavior
✅ Then Exa: "Prisma connection pooling best practices production 2025"
   - Gets real-world deployment patterns
```

**Why the wrong approach fails:** Exa for API reference misses version-specific
behavior, may return outdated patterns, and doesn't have the authoritative
source. Context7 should always be first for library-specific questions.



## Integration With the Researcher Workflow

Classify → Select source → Execute → Evaluate → Chain if needed → Return results with source attribution.

---

## Rules & Guidelines

1. **Classify before you search** — A 2-second classification saves a wasted query.
2. **Resolve Context7 library IDs** — Every time. Unresolved queries are significantly less precise.
3. **Date filters on Exa for current topics** — The default search may return 3-year-old results.
4. **Prefer Context7 over web search for library questions** — Always. It's faster and more accurate.
5. **Note your sources** — Tell the orchestrator what you used and why.
