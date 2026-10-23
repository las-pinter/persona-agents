# Claude Code plugin options

This file describes how the Claude Code plugin reads its options, for admins
and maintainers. The root [README.md](../../README.md) covers install and use.

For the hook design, see [CONTRIBUTING.md](../../CONTRIBUTING.md), sections
"4. Claude Code Plugin" and "Runtime Context Pipeline (Claude Code)".

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
