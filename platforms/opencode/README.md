# OpenCode templates and plugins

This file describes the OpenCode frontmatters and plugins, for maintainers.
[CONTRIBUTING.md](../../CONTRIBUTING.md) covers how to add a profession.

## Frontmatter templates

A template is `platforms/opencode/frontmatters/{profession}.yaml`. It is YAML
with `{{...}}` placeholders.

The head of `orchestrator.yaml` (shortened) shows the pattern. The default
rule comes first, then the exceptions:

```yaml
description: "{{AGENT_DESCRIPTION}}"
mode: primary
permissions:
  - action: "*"
    resource: "*"
    effect: ask
  - action: external_directory
    resource: "*"
    effect: ask
  - action: external_directory
    resource: "~/agent-notes/orchestrator/*"
    effect: allow
  # ... more external_directory, edit, shell, and subagent rules
```

Permissions are an ordered array of `{ action, resource, effect }` entries.
The last matching rule wins. A call with no matching rule asks. Put the broad
default first and the specific exceptions after it.
The effect is `allow`, `ask`, or `deny`. Known actions are `read`, `glob`,
`grep`, `edit`, `shell`, `subagent`, `skill`, `execute`,
`external_directory`, `question`, `webfetch`, `websearch`, `context7`,
`deepwiki`, `exa`, and `*`. The V2 schema renamed `bash` to `shell`, `task`
to `subagent`, `write` to `edit`, and `code` to `execute`. It dropped
`todowrite`.

## Permission mapping (Kiro to OpenCode)

| Kiro concept | OpenCode equivalent |
|---|---|
| `allowedTools: ["read", "glob", ...]` | `{ action: read, resource: "*", effect: allow }`, `{ action: glob, resource: "*", effect: allow }` |
| `toolsSettings.shell.allowedCommands[]` | `{ action: shell, resource: "command*", effect: allow }` |
| `toolsSettings.shell.deniedCommands[]` | `{ action: shell, resource: "command*", effect: deny }` |
| `toolsSettings.subagent.trustedAgents[]` | `{ action: subagent, resource: "pattern", effect: allow }` |
| `toolsSettings.edit.allowedPaths[]` | `{ action: edit, resource: "path", effect: allow }` |
| `tools: ["*"]` | `{ action: "*", resource: "*", effect: ask }` |

Use the most specific resource pattern, for example `"git status *"` and not
`"git*"`.

## Stub comment

An agent file holds a single-line HTML comment, not the persona text:

```
<!-- persona-agents:{theme}-{profession}:{personaFile} -->
```

Examples: `<!-- persona-agents:goblin-orchestrator:bossnik-chief.md -->` and
`<!-- persona-agents:wh40kOrk-planner:sparkgutz-bigmek.md -->`.

`plugins/persona-agents.js` registers the OpenCode v2
`ctx.session.hook("context", ...)` hook. Before each model dispatch it scans
the system prompt parts for stub markers. For each stub it parses the marker
(`parseAgentFromStubComment`), loads `profession.md` and the persona file from
disk (`loadSinglePrompt`), and replaces the stub fully. The parse rules:

1. Take the text between `<!--` and `-->`.
2. Remove the `persona-agents:` prefix.
3. Split on the last `:`. The right side is `personaFile`. The left side is
   the agent name.
4. Split the agent name on the first `-`. The right side is `profession`. The
   left side is `theme`.

The parser is data-driven, so a new theme or profession needs no plugin
change. The plugin resolves resource paths from its own location, so it works
without the repository after install.

## Plugins

Both plugins are plain JavaScript with Node built-ins only. `install.sh`
copies them as-is to `~/.config/opencode/plugins/`. They need no build step,
`node_modules`, or `@opencode/plugin`.

- `plugins/persona-agents.js` swaps stub markers for prompt text.
- `plugins/permission-auditor.js` is read-only. It appends every permission
  evaluation, ask prompt, and user reply to
  `~/.local/share/opencode/permission-audit.jsonl`, one JSON object per line.
  It never changes a permission decision.

## Commands

`install.sh` copies each file in `content/commands/` to
`~/.config/opencode/commands/`. The file sets no `agent` key, so the current
agent runs the command.

## Retired professions

The installer never deletes files. When a profession is retired, its agent
files stay in `~/.kiro/agents/` and `~/.config/opencode/agents/`. Its
profession file and templates stay in the installed config tree. Remove them
by hand. Release notes state the removal.
