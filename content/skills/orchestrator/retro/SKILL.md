---
name: retro
description: Print-only blameless retrospective of the current pi session with the AAR spine, a 14-dimension sweep, and routed actions.
---

# Retro

## Purpose

Review the current pi session and print the result in chat. Write nothing
durable.

The spine is the After Action Review (AAR). It has four parts:

1. What was supposed to happen.
2. What actually happened.
3. What was right and what was wrong.
4. What to do differently next time.

The framing is blameless. Name the system, not the agent. A cause is a
condition to change, not a person to blame.

## When to Run

Run this skill when the user types `/retro`, or when the user asks for a
session retrospective.

## Review Scope

Review these sources only:

- The current pi session.
- The latest orchestrator journal entry.
- The project `summary.md`.

Do not scan earlier sessions. For a repeated-mistake check, use the latest
journal entry and the git history in reach.

## Write Model (Print Only)

This retro writes no durable artifact:

- No report file and no `retro/` folder.
- No new skill and no skill edit.
- No journal entry.
- No permission rule.

Do not dispatch an implementer, a reviewer, or a commit. The retro reports and
proposes in chat only.

## Step 1: Collect Evidence

Collect evidence from these sources:

| Source | Location | Holds |
|--------|----------|-------|
| Session context | Live context | Messages, tool calls, denials, user turns |
| Session file | `~/.pi/agent/sessions/<cwd-slug>/*.jsonl` | Per-message `usage` (cost, totalTokens), tool calls, timestamps |
| Journals | `~/agent-notes/<agent-type>/journals/daily/` | Work log, decisions, issues, lessons |
| Project notes | `~/agent-notes/project-notes/<project>/` | `summary.md`, studies |
| Git history | Repo working tree | `git log`, `git diff`, `git status` |
| Permission config | `~/.pi/agent/permissions.json` | Current allow/ask/deny rules |
| Usage cache | `~/.pi/agent/cache/opencode-go-usage.json` | Account quota, not per-session |

For a large session file, read the `usage` fields only. Do not load the whole
file into context.

## Step 2: Sweep the 14 Dimensions

Sweep every dimension below. Ask the listed question for each one. Keep the
sweep internal. Print only a dimension with evidence.

| # | Dimension | Question |
|---|-----------|----------|
| 1 | Outcome and goals | Did the session reach the stated goal, and what was left undone? |
| 2 | Permissions and security | Which actions were denied or needed approval, and which rule caused it? |
| 3 | Tooling and workflow | Which tool calls repeated, failed, or used a workaround? |
| 4 | Prompt and steering quality | Which user instruction was ambiguous or caused a wrong turn? |
| 5 | Context management | What context was missing, stale, or too large? |
| 6 | Cost and latency | What did the session cost, and which turn or subagent dominated? |
| 7 | Error handling and recovery | Which error was handled well, and which recovery was slow? |
| 8 | Testing and verification | Was the change verified by an external signal, or only by the agent? |
| 9 | Communication and reporting | Was the final report clear, complete, and free of false claims? |
| 10 | Plans and estimates | Did the plan match the work, and where did it diverge? |
| 11 | Knowledge and skill gaps | What did the agent not know that it needed? |
| 12 | Repeated mistakes | Which mistake appeared before in journals or git history? |
| 13 | Update-surface routing | For each lesson, which surface should change? |
| 14 | Delegation and routing | Which task went to the wrong agent type, and why? |

## Step 3: Print Findings

Print 3 to 5 findings, never more than 5. Print only a dimension with
external evidence. Drop a dimension with no evidence. If fewer than 3
dimensions have evidence, print the ones that do. Never invent a finding to
reach 3.

Each finding has exactly these parts:

- An observation.
- ONE external evidence item.
- One Starfish lens: **Less of** or **More of**.
- One update surface.

### Evidence Anchor

Every finding cites one external evidence item. Use a git diff, a test result,
a permission denial, a session cost record, or a journal entry.

Never anchor a finding to the agent's own self-grade. A self-grade is not
evidence.

### Plausible Causes

List the plausible causes for a failure. A failure can have more than one valid
cause. Do not claim one decisive cause or one decisive step.

### Starfish Lens

Use only the two lenses **Less of** and **More of**. Do not add Keep, Stop, or
Start labels.

### Update Surface

Route each finding to one surface from this set:

| Surface | Holds |
|---------|-------|
| skill | A reusable procedure. |
| memory/journal | A stored fact, decision, or lesson. |
| prompt | A user instruction or a steering message. |
| permission | A permission rule. |
| tool/workflow | A tool call or a workflow step. |
| test | A test case or a check. |
| process | A team or repo process. |

Use one surface per finding. A skill is only for a reusable procedure. Do not
route every lesson to a skill.

### Permissions Evidence Limit

The permissions dimension uses transcript denials and
`~/.pi/agent/permissions.json`. State this limit when the dimension prints.

pi has no durable permission audit log. Do not claim one. An audit log exists
for OpenCode only, and it does not record pi decisions.

## Step 4: Print Actions

Print 1 to 3 actions. Each action has one owner and one next step.

## Output Shape

Print the AAR sections, then the findings, then the actions.

```text
## Retro

### What was supposed to happen
...

### What actually happened
...

### What was right and wrong
...

### What to do differently

Findings (3-5):
1. Observation ...
   Evidence: <one external item>
   Lens: More of ...
   Surface: <one surface>
   Plausible causes: ...

Actions (1-3):
1. Owner: ... - Next step: ...
```

## Never Do

- Never write a durable artifact.
- Never anchor a finding to a self-grade.
- Never claim one decisive cause.
- Never claim a durable pi permission audit log.
- Never print a finding without external evidence.
- Never route a finding to more than one surface.
- Never dispatch an implementer, reviewer, or commit.
- Never run a cross-session scan.
