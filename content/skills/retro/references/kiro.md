# Retro on Kiro CLI

## Facts

The session id is in your system context, on the line `Session id: <id>`.
Run this with the shell tool, from the repository root:

```sh
node --experimental-strip-types --no-warnings {{COMPANION_AGENTS_KIRO_ROOT}}/platforms/kiro/scripts/retro.ts --session=<id>
```

It prints the retro instruction and the session facts: tool calls, changed
files, denials and asks from the permission decisions log, independent
reviews, compactions, hook calls, credits, context usage, the session log
path, and the model. It writes nothing.

## Which parts of the skill apply

Use the shared retrospective below, with these Kiro rules:

- Use the printed facts as the evidence. The **Session Facts** table in the
  shared skill is Claude Code's; it does not apply here.
- The permissions dimension reads the decisions log
  (`<kiro home>/companion-agents/state/decisions.ndjson`). The facts line is
  the evidence. Do not claim a permission audit log beyond it.
- Cost is reported in credits, not money. Report the credits line.
- Compactions come from the adapter's metrics file. The facts line counts
  them.
- The review dimension reads the recorded reviewer runs and the stored
  verdicts. A review that was never recorded is not evidence.
- Write nothing durable: no report file, no session log, no notes, no
  permission rule, no commit.

## Output

Print the AAR, the findings (3 to 5), the blind-spot line, and the actions in
the shared skill's **Output Shape**. A finding still needs one external
evidence item and one update surface.
