---
name: synthesis-template
description: Structured process and output format for combining multiple subagent results into a single coherent response.
---

# Skill: Synthesis Template

## When to Use
When combining results from two or more subagents into a final response.

## Process (in order)

1. **Collect** — wait for all subagent results before synthesizing
2. **Triage** — identify conflicts, gaps, and redundancies across results
3. **Resolve** — for conflicts, prefer the more specific/recent source; flag unresolved conflicts explicitly
4. **Compose** — write the unified response using the output format below

## Output Format

```
## Summary
[1–3 sentence answer to the original request. State what was found. No hedging.]

## Findings
[Content from subagents, organized by topic — not by which agent produced it.
 Merge overlapping content. Do not repeat the same point from multiple agents.]

## Conflicts / Gaps
[Only include if present. List contradictions between subagent results, or areas
 where no agent returned useful information.]

## Sources
[- [Label](url) — one line per source]
```

## Rules
- **Organize by topic, not by agent** — the user does not care which subagent found what
- **Eliminate redundancy** — if two agents found the same thing, say it once
- **Surface conflicts explicitly** — do not silently pick one result and discard another
- **If a subagent returned nothing useful**, note the gap — do not pad the Findings section
