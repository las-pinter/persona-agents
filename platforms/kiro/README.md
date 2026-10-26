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

Kiro has no `ask` tier. It has three verdicts: an allow entry runs with no
prompt, a deny entry blocks the command, and an unmatched command asks. All six
shell templates set `autoAllowReadonly` false, so no read-only detector can
allow a command. The five role templates carry explicit deny entries for the
write forms: fetch, `git remote show` with an argument, `git remote update`,
the branch create forms, the branch write flags, every tag create flag shape,
and tag delete and force.

The branch and tag fence covers a bare name, a boolean listing option followed
by a name, a listing option value followed by a second token, the branch write
flags, the tag create flags, and tag delete and force. Each entry covers the
bare command and these wrappers: `;`, `&&`, `|`, `$(`, a backtick,
`git -C <path>`, and a leading space. `git branch --merged main` is a
listing. `git branch --merged main evil` has a second token, so it denies. A
tag listing with a pattern argument, such as `git tag -l v1`, asks.

A command pattern here is an anchored regex, so an entry can name a write form
and leave a listing to the allow list. An invalid pattern is inert or
deny-all, depending on the engine path. The cost is one regex body per form: a
new write shape that no entry names asks. The repo doctrine holds by the three
tiers:

- A read command a role needs is in `allowedCommands`, so it runs with no
  prompt. The five role templates allow the branch, tag, and remote listings,
  the git read verbs, and the plain system reads. A write that no deny names
  is absent from the allow list, so Kiro asks before it runs.
- A gated history or release command stays out of `allowedCommands`, so Kiro
  asks. `AGENTS.md` names these commands. A gated command in
  `allowedCommands` is a bug. A tag command that creates or moves a tag is
  unlisted on the orchestrator and denied on the five role templates. The
  allow list carries the list forms: the bare tag command, `-l`, `--list`,
  `-v`, `--contains`, `--merged`, and `--points-at`. A tag listing with a
  pattern argument stays out, so it asks.
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
