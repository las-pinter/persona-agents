---
name: source-selection
description: Decision rules for choosing between Context7, DeepWiki, and Exa based on query type.
---

# Skill: Source Selection

Use this decision tree before every research action. Pick the first rule that matches.

## Decision Rules

### Use Context7 when:
- The question is about a **specific library or framework's API, configuration, or usage**
- You need **code examples** for a known package
- You need **version-specific** behavior
- The library has a Context7 ID — always prefer it over web search for library docs

### Use DeepWiki when:
- The question is about a **specific GitHub repository's architecture, internals, or design decisions**
- You need to understand **how a project is structured** or how its components relate
- Context7 returns no useful results for a repo-specific question

### Use Exa when:
- The question requires **current information** (news, recent releases, trends)
- You need **blog posts, tutorials, or community best practices** not in official docs
- The topic is **cross-library or conceptual** (e.g. "best practices for X")
- You need to **compare options** or find real-world usage examples
- Context7 and DeepWiki both return nothing useful

## Fallback Order
Context7 → DeepWiki → Exa

## Never
- Use Exa for API reference questions when Context7 has the library
- Use Context7 for questions about current events or recent releases
- Use DeepWiki for questions not tied to a specific repository
