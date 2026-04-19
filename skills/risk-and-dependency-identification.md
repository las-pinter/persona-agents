---
name: risk-and-dependency-identification
description: Identify risks, blockers, and dependencies in a plan before finalizing it.
---

# Skill: Risk and Dependency Identification

## When to Use
After task decomposition, before finalizing a plan.

## Risk Identification

For each task, ask:
- What could go wrong?
- Does this depend on an external system, API, or team?
- Is this in unfamiliar territory (new tech, unclear requirements)?
- What happens if this task is delayed or fails?

## Dependency Identification

- **Internal dependencies** — tasks within this plan that must complete first
- **External dependencies** — other teams, services, or systems outside this plan
- **Implicit dependencies** — shared resources, environments, or data that could cause conflicts

## Output Format

| Risk/Dependency | Type | Impact | Mitigation |
|---|---|---|---|
| Description | internal / external / implicit | high / medium / low | What to do about it |

Flag any high-impact risks for human review before proceeding.
