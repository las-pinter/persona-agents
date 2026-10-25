# Kiro templates

This file describes the Kiro agent templates, for maintainers.
[CONTRIBUTING.md](../../CONTRIBUTING.md) covers how to add a profession.

## Template format

A template is `platforms/kiro/templates/{profession}.json`. It is plain JSON
with `{{...}}` placeholders that `install.sh` fills at install time.

```json
{
  "name": "{{THEME}}-orchestrator",
  "description": "{{AGENT_DESCRIPTION}}",
  "prompt": "file://~/.kiro/professions/orchestrator.md",
  "resources": [
    "file://~/.kiro/personas/{{THEME}}/{{PERSONA_FILE}}",
    "skill://~/.kiro/skills/{{PROFESSION}}/*/SKILL.md",
    "skill://~/.kiro/skills/common/project-notes/SKILL.md",
    "skill://~/.kiro/skills/common/simplified-technical-english/SKILL.md"
  ],
  "welcomeMessage": "{{WELCOME_MESSAGE}}",
  "tools": [ ... ],
  "allowedTools": [ ... ],
  "toolsSettings": { ... }
}
```

Each template hardcodes its own profession in the agent name and the prompt
path. `{{PROFESSION}}` is still used in the `resources` array. Only the theme
and the agent metadata come from placeholders. `toolsSettings` holds
`allowedCommands`, `deniedCommands`, the subagent trust list, and the `edit`
path permissions.

`platforms/kiro/cli.json.example` is an example Kiro CLI config. `install.sh`
copies it to `~/.kiro/settings/cli.json` when that file is missing.

## Ask by omission

Kiro has no `ask` tier. An available tool or command that is neither allowed
nor denied prompts the user. One more verdict exists: the read-only detector
can allow a command with no prompt. For that reason each of the five templates
that set `autoAllowReadonly` true carries explicit denies for the write forms
the detector allows: fetch, `git remote show`, `git remote update`, and branch
forms with an argument. A branch glob cannot tell a create from a listing, so
a listing with an argument denies too. The repo doctrine otherwise holds by
omission:

- A gated history or release command stays out of `allowedCommands`, so Kiro
  asks. `AGENTS.md` names these commands. A gated command in
  `allowedCommands` is a bug. A tag command that creates or moves a tag stays
  unlisted. The orchestrator list allows only the list forms: the bare tag
  command, `-l`, and `--list`.
- A destructive command stays in `deniedCommands`, so Kiro denies it. The
  verdict comes from `AGENTS.md`.
- A tool that is absent from `allowedTools` stays available, so it defaults to
  ask. The reviewer and the planner omit `code` for this reason.

This mechanism is for Kiro only. `AGENTS.md` owns the doctrine for all
platforms.

## Commands

`install.sh` copies each file in `content/commands/` to `~/.kiro/prompts/`
without the frontmatter, because Kiro documents no frontmatter for file
prompts. Kiro runs a file prompt as `/<name>`. A file with an unclosed
frontmatter block installs unchanged, with a warning.
