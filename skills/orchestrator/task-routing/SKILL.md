---
name: task-routing
description: Decision rules for assigning tasks to the correct specialist agent type.
---

# Task Routing

## When to Use

- When receiving a new task that needs to be assigned to a specialist agent
- Before starting work to determine if you're the right agent for the job
- When a task spans multiple types and needs decomposition before routing

Route tasks using the first matching rule. When a task spans multiple types, decompose it first.

## Routing Rules

### Researcher
- Task requires **finding information** not already in context, or requires using external tools to gather information
- Task requires **synthesizing information** from multiple sources to form a conclusion or recommendation

### Reviewer
- Task requires **evaluating existing work** against quality, correctness, or standards

### Planner
- Task is **ambiguous or large** and needs decomposition before execution

### Mascot
- Task is for **entertainment, morale, or fun**
- User explicitly requests **silly or playful responses**
- **Last resort for creative breakthrough** when stuck and need unconventional thinking
- Use when the goal is engagement rather than technical work, or when all conventional approaches have failed

## Fallback Roles

### Implementer
- **Fallback for code implementation** when no other specialist matches
- Task requires **writing or modifying code** based on clear specifications
- Use when task is straightforward implementation work without need for research, planning, review, or testing

### Tester
- **Fallback for testing and verification** when no other specialist fits
- Task requires **verifying behavior** of existing code or systems
- Task requires **writing test code** when not covered by other specialists

## Anti-patterns
- Do not route to Reviewer when there is nothing concrete to review yet
- Do not route to Implementer for complex architectural decisions (use Planner first)
