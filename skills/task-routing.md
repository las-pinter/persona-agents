---
name: task-routing
description: Decision rules for assigning tasks to the correct specialist agent type.
---

# Skill: Task Routing

Route tasks using the first matching rule. When a task spans multiple types, decompose it first.

## Routing Rules

### → Researcher
- Task requires **finding information** not already in context
- Task output is facts, findings, or a summary — not a deliverable artifact
- Keywords: "research", "find", "what is", "how does X work", "compare", "survey"

### → Developer
- Task requires **writing, modifying, or debugging code**
- Task output is a file, function, script, config, or diff
- Task is well-scoped with clear inputs and expected outputs
- Keywords: "implement", "write", "fix", "refactor", "add feature"

### → Technical Reviewer
- Task requires **evaluating existing work** against quality, correctness, or standards
- Input is code, a plan, or a document that needs critique
- Task output is a structured list of findings, not new work
- Keywords: "review", "check", "audit", "evaluate", "assess"

### → Planner
- Task is **ambiguous or large** and needs decomposition before execution
- Output is a plan, task list, or clarifying questions — not a solution
- Keywords: "plan", "design", "how should we", "break down"

### → Tester
- Task requires **verifying behavior** of existing code or a system
- Task output is test cases, test results, or a coverage report
- Keywords: "test", "verify", "write tests for", "check edge cases"

## Sequencing Rules
- Research needed before implementation → Researcher first, then Developer
- Implementation before review → Developer first, then Reviewer
- Requirements unclear → Planner before any other agent
- Maximum delegation depth: 3 hops. If exceeded, escalate to human.

## Anti-patterns
- Do not route to Developer when requirements are still ambiguous
- Do not route to Reviewer when there is nothing concrete to review yet
