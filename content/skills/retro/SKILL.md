---
name: retro
description: Print-only blameless retrospective of the current companion session - the AAR spine, a 15-dimension sweep, and routed actions. Run it with /persona-agents:retro.
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

Run this skill when the owner types `/persona-agents:retro` or asks for a
session retrospective. Run it yourself, in this session; do not hand it to a
subagent.

## Session Facts

| Item | Value |
|------|-------|
| Session id | `${CLAUDE_SESSION_ID}` |
| Transcript | `~/.claude/projects/<cwd-slug>/${CLAUDE_SESSION_ID}.jsonl`. The slug is the working directory with each character that is not a letter or a digit changed to `-` (`/home/dev/project` → `-home-dev-project`). Subagent transcripts (the review runs) are in `~/.claude/projects/<cwd-slug>/${CLAUDE_SESSION_ID}/subagents/*.jsonl`. |
| Transcript format | JSON Lines. Each line is one message or event. Tool results hold the permission denials. Each assistant message holds a `message.usage` object. A `system` line with `subtype: "compact_boundary"` marks a compaction and carries `compactMetadata` (`trigger`, `preTokens`, `postTokens`). |
| Permission rules | The `permissions` block of `~/.claude/settings.json`, `.claude/settings.json`, and `.claude/settings.local.json`, and the persona-agents PreToolUse hook (`platforms/claude/scripts/doctrine.ts` in the plugin folder). |
| Permission audit log | None. The hook writes `doctrine.log` in the plugin data folder only when `PERSONA_AGENTS_DEBUG` is set. Use it as evidence only if it exists. |
| Cost source | The `message.usage` fields: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`, in the session and subagent transcripts. They give token counts, not money. Report the totals. |

## Review Scope

Review these sources only:

- The current session.
- The session notes files this session worked on.
- The project journal entries of the three most recent days.
- The project `summary.md`.
- The project `rules/` folder.

Do not scan earlier sessions. For a repeated-mistake check, use the journal
entries named above and the git history in reach.

## Write Model (Print Only)

This retro writes no durable artifact:

- No report file and no `retro/` folder.
- No new skill and no skill edit.
- No journal entry.
- No permission rule.

Do not edit files, start a review, or commit. The retro reports and proposes
in chat only.

## Step 1: Collect Evidence

Collect evidence from these sources:

| Source | Location | Holds |
|--------|----------|-------|
| Session context | Live context | Messages, tool calls, denials, user turns |
| Session transcript | See Session Facts | Tool calls, timestamps, usage, compactions |
| Session notes | `<project notes>/sessions/` | Plan, decisions, pins, compaction log lines |
| Journal | `<project notes>/journal/<day>/` | Earlier sessions: work, decisions, open items |
| Project notes | `<project notes>/` | `summary.md`, `rules/`, studies |
| Git history | Repo working tree | `git log`, `git diff`, `git status` |
| Permission rules | See Session Facts | Current allow, ask, and deny rules |
| Tool histogram | Session transcript | Tool calls by name, denials by reason, review runs |

The session start text names the project notes folder. The permissions,
tooling, and plan dimensions use those counts.

The repeated-mistake check reads the journal files named in Review Scope.

For a large transcript file, read only the fields you need. Do not load the
whole file into context.

## Step 2: Sweep the 15 Dimensions

Sweep every dimension below. Ask the listed question for each one. Keep the
sweep internal. Print only a dimension with evidence.

| # | Dimension | Question |
|---|-----------|----------|
| 1 | Outcome and goals | Did the session reach the stated goal, and what was left undone? |
| 2 | Permissions and security | Which actions were denied or needed approval, and which rule caused it? |
| 3 | Tooling and workflow | Which tool calls repeated, failed, or used a workaround? |
| 4 | Prompt and steering quality | Which user instruction was ambiguous or caused a wrong turn? |
| 5 | Context management | What context was missing, stale, or too large? |
| 6 | Cost and latency | What did the session cost, and which turn or review run dominated? |
| 7 | Error handling and recovery | Which error was handled well, and which recovery was slow? |
| 8 | Testing and verification | Was the change verified by an external signal, or only by the agent? |
| 9 | Communication and reporting | Was the final report clear, complete, and free of false claims? |
| 10 | Plans and estimates | Did the plan match the work, and where did it diverge? |
| 11 | Knowledge and skill gaps | What did the agent not know that it needed? |
| 12 | Repeated mistakes | Which mistake appeared before in journals or git history? |
| 13 | Update-surface routing | For each lesson, which surface should change? |
| 14 | Plan upkeep | Did the session notes or the study change before the work changed, or after? |
| 15 | Compaction and recovery | Did a compaction lose something the reload did not bring back? |

### Cost Data

Use the token totals from the Cost source in Session Facts. When the
transcript cannot be read, skip dimension 6 and say so in the output.

## Step 3: Print Findings

Print 3 to 5 findings, never more than 5. Print only a dimension with
external evidence. Drop a dimension with no evidence. If fewer than 3
dimensions have evidence, print the ones that do. Never invent a finding to
reach 3.

A finding must still be open at session end. A finding whose fix landed in
this session is not a finding.

Each finding has exactly these parts, in this order:

- An observation.
- ONE external evidence item.
- One Starfish lens: **Less of** or **More of**.
- An impact: high, normal, or low.
- One update surface.
- The plausible causes.

For a finding, high changes the next session, normal refines a practice, and
low is optional polish.

### Evidence Anchor

Every finding cites one external evidence item. Use a git diff, a test result,
a permission denial, or a session cost record. A journal entry or a
transcript count is also evidence.

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
| notes | A project note, a rule, or a journal entry: a stored fact, decision, or lesson. |
| prompt | A user instruction or a steering message. |
| permission | A permission rule. |
| tool/workflow | A tool call or a workflow step. |
| test | A test case or a check. |
| process | A team or repo process. |

Use one surface per finding. A skill is only for a reusable procedure. Do not
route every lesson to a skill.

### Permissions Evidence Limit

The permissions dimension uses transcript denials, the settings files, and the
hook rules. State this limit when the dimension prints. Do not claim a
permission audit log.

After the findings, print the dimension numbers that had no external evidence,
or print `none`. This line is the blind-spot report.

## Step 4: Print Actions

Print 1 to 3 actions. Each action has one owner and one next step.

### Rules Folder Check

The retro checks the project `rules/` folder for a rule the session created,
one it updated, and one it retired. It prints each rule action it finds, with
the rule file name. A printed rule action counts inside the Step 4 list of 1
to 3 actions. It does not add a second list.

The folder holds at most 8 files and 200 lines in total. At 8 files or 200
lines, the printed action names the rule to retire or the two rules to merge.
The same edit makes that change.

When the session caused a lesson that no rule holds, the retro proposes the
missing rule action as an action. The owner is the companion, in a later turn
after the owner agrees.

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
   Impact: <high, normal, or low>
   Surface: <one surface>
   Plausible causes: ...

Blind spots: <the dimension numbers with no external evidence, or "none">

Actions (1-3):
1. Owner: ... - Next step: ...

Cost: <the token totals, or "transcript not readable">
```
