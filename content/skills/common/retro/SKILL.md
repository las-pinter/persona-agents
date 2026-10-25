---
name: retro
description: Print-only blameless retrospective of the current session with the AAR spine, a 14-dimension sweep, and routed actions. Runs on pi, kiro, OpenCode, and Claude Code.
disable-model-invocation: true
---

# Retro

## Purpose

Review the current session and print the result in chat. Write nothing
durable.

The spine is the After Action Review (AAR). It has four parts:

1. What was supposed to happen.
2. What actually happened.
3. What was right and what was wrong.
4. What to do differently next time.

The framing is blameless. Name the system, not the agent. A cause is a
condition to change, not a person to blame.

## When to Run

Run this skill when the user starts the retro command, or when the user asks
for a session retrospective. The command name depends on the platform:

| Platform | Command |
|----------|---------|
| pi | `/retro` |
| kiro | `/retro` |
| OpenCode | `/retro` |
| Claude Code | `/persona-agents:retro` |

The agent that the user talks to runs the retro. Do not hand it to a
subagent.

## Step 0: Find the Platform

Find the platform that runs this session. Check the signals in order. The
first signal that matches wins:

| Signal | Platform |
|--------|----------|
| This `SKILL.md` is under `~/.kiro/skills/` | kiro |
| This `SKILL.md` is under `~/.config/opencode/skills/` | OpenCode |
| The user typed `/persona-agents:retro`, or this `SKILL.md` is under `~/.claude/plugins/` | Claude Code |
| This `SKILL.md` is under a pi package, or in a skills tree that is not another platform root | pi |

If no signal matches, ask the user which platform runs the session.

Then read the one reference file for that platform. The file is in the
`references/` folder next to this `SKILL.md`:

| Platform | Reference file |
|----------|----------------|
| pi | `references/pi.md` |
| kiro | `references/kiro.md` |
| OpenCode | `references/opencode.md` |
| Claude Code | `references/claude.md` |

Do not read the reference files of the other platforms. The reference file
gives the session transcript, the permission rules, the audit log status, and
the cost source.

## Review Scope

Review these sources only:

- The current session.
- The latest journal entry of the agent that runs the retro, if that agent
  keeps a journal.
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
| Session transcript | See the platform reference file | Tool calls, timestamps, and usage where the platform records it |
| Journals | `~/agent-notes/<agent-type>/journals/daily/` | Work log, decisions, issues, lessons |
| Project notes | `~/agent-notes/project-notes/<project>/` | `summary.md`, studies |
| Git history | Repo working tree | `git log`, `git diff`, `git status` |
| Permission rules | See the platform reference file | Current allow, ask, and deny rules |
| Permission audit log | See the platform reference file | Recorded permission decisions, only where the platform has a log |

For a large transcript file, read only the fields you need. Do not load the
whole file into context.

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

### Cost Data

Use cost data if the platform records it. The platform reference file names
the cost source. If the platform has no cost source, skip dimension 6. Then
state in the output that the platform records no cost data for the session.

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

The permissions dimension uses the evidence that the platform reference file
names. State this limit when the dimension prints.

Claim a permission audit log only when the platform reference file says the
platform has one. An audit log of one platform does not record the decisions
of a different platform.

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

Cost: <the session cost or the token totals, or "no cost data on this platform">
```
