---
name: query-construction
description: Practical techniques for writing effective queries for Context7, DeepWiki, and Exa to maximize retrieval quality.
---

# Skill: Query Construction

## Context7

Queries should be:
- **Specific and technical**: "how to configure retry logic in axios" not "axios help"
- **Action-oriented**: start with what you want to *do*, not what you want to *know*
- **One concept per query**: split compound questions into separate calls

✅ `"streaming response with fetch API abort controller"`
❌ `"fetch API stuff"`

## DeepWiki

Queries should be:
- **Phrased as questions**: "How does the authentication middleware work?"
- **Reference internal concepts**: use terms from the repo (class names, module names)
- **Scoped to architecture or behavior**, not usage

✅ `"How does the task queue handle retries and dead-letter jobs?"`
❌ `"show me queue code"`

## Exa

Queries should describe the **ideal document**, not keywords:
- **Describe the document you want**: "blog post comparing X and Y for production use"
- **Include context and recency**: "2024 guide to deploying FastAPI on Kubernetes"
- **Specify format**: "tutorial", "benchmark", "case study", "checklist"

✅ `"practical guide to rate limiting strategies in distributed APIs with code examples"`
❌ `"rate limiting API"`

## Universal Tips
- If a query returns poor results, **rephrase with more context** before switching tools
- Richer descriptions outperform terse keywords in all three tools
- If unsure which tool to use, load `source-selection.md` first
