# Claude Code plugin options

This file describes how the Claude Code plugin reads its options, for admins
and maintainers. The root [README.md](../../README.md) covers install and use.

The hook design is in the section "Plugin and hook design" below.

## Option lookup

The `subagent_model` option reads only the managed and user `settings.json`
files, not the start-time value, so a project env block cannot set it. An
install from another marketplace name always gets `sonnet`, because the hook
looks for the `persona-agents@persona-agents` key.

The `theme` option: the hook reads it each time an agent starts. The order is: the managed
settings (`managed-settings.json` and the `managed-settings.d` drop-ins, where
a drop-in wins over `managed-settings.json`, and the last drop-in in
alphabetical order that sets the theme wins), then your
`settings.json`, then the theme that Claude Code gave at start, then `goblin`.
The `subagent_model` option uses the same order, but with no start-time value.

## Option values

The `subagent_model` option takes four values: `sonnet` (the default),
`opus`, `haiku`, and `inherit`. The value `inherit` leaves the model choice to
Claude Code. If `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, Claude Code ignores
the `subagent_model` option. The orchestrator keeps your session model.

Set an option in `/config` (**Persona theme**, **Subagent model**) or in your
user `settings.json`. A project `settings.json` cannot set the subagent model.

## Limits

These limits apply to the `theme` and `subagent_model` options.

- The hooks do not read MDM policies (macOS plist, Windows registry) or
  server-managed settings. A theme set only there comes from the start-time
  value, so it needs a restart. A `subagent_model` set only there is never
  applied, and the hook uses `sonnet`.
- The hooks ignore a `CLAUDE_CONFIG_DIR` or `HOME` that is inside the project
  the agent works in. A project in your home folder, or above it, does not
  count. Your settings then come from `.claude` in your home folder. This can
  also change which theme you get. If the system cannot find your home folder
  (a user with no passwd entry), the home-folder exception does not apply, and
  the hooks skip your `settings.json` instead.
- The hook does not apply the Claude Code first-wins choice among managed
  sources. A theme in a managed file can show even when Claude Code uses a
  remote or MDM source.
- If the theme comes only from MDM or server-managed settings, a theme in your
  `settings.json` wins over it.

## Plugin and hook design

The repo root is the plugin (`.claude-plugin/plugin.json`) and its own
marketplace (`.claude-plugin/marketplace.json`). The plugin copies no content.

- **Agents** (`platforms/claude/agents/{profession}.md`) hold frontmatter only:
  `name`, `description`, and tool limits. The body stays empty on purpose. A
  non-empty body would replace the Claude Code system prompt when the agent
  runs as the main session, and it would copy the profession text.
- **Context** comes from one script, `platforms/claude/scripts/context.mjs`.
  It runs as two hooks on `SessionStart` (the main session, started with
  `claude --agent persona-agents:orchestrator`) and on `SubagentStart` (an
  agent that the orchestrator dispatches). The `profession` hook sends
  `content/professions/{profession}.md` unchanged. The `persona` hook sends a
  short Claude Code note and the persona that `content/agents.json` picks for
  the `theme` option (`/config`, **Persona theme**).
- **Two hooks, not one,** because Claude Code caps each hook string at 10,000
  characters and shows only a 2,000-character preview of a longer string.
  `tests/claude-plugin.test.ts` fails if a profession, or a theme persona with
  its note, reaches the cap.
- **Subagent model** comes from `platforms/claude/scripts/subagent-model.mjs`.
  It runs as a `PreToolUse` hook on `Agent` and `Task`. It sets the model of a
  `persona-agents:` subagent, except the orchestrator, from the `subagent_model`
  option. A value outside `sonnet`, `opus`, `haiku`, and `inherit` gives the
  default, `sonnet`. The hook gives no permission decision and never blocks a
  call.
- **Option read** is `platforms/claude/scripts/plugin-options.mjs`. Both the
  `theme` hook and the model hook call it at run time, so a `/config` change
  needs no restart.
- **Skills** load in place from `content/skills/`. `plugin.json` lists each
  skill folder. A skill for another platform only is left out of the list and
  named in `EXCLUDED_SKILLS` in `tests/claude-plugin.test.ts`, with the reason.
- **Doctrine** is one `PreToolUse` hook,
  `platforms/claude/scripts/doctrine.ts`, keyed on the calling agent.
  `tests/claude-doctrine.test.ts` holds the matrix. `AGENTS.md` owns the
  history and release rules. The hook also does this:
  - It allows a plain history command only when every part of the command is
    such a command. A command with another part gets no hook decision.
  - An edit outside the `agent-notes/` zone of an agent asks for the
    orchestrator, and denies the planner, researcher, reviewer, and mascot.
  - A hook deny wins over a user allow rule.
  - It reuses the shell parser of the pi gate. It unwraps `cd x &&`,
    `sudo`, `env`, and `xargs` prefixes and `bash -c` payloads. An unreadable
    command that names a gated program fails closed.
  - It leaves sessions without a persona-agents agent alone.
