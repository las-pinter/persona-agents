# Contributing to persona-agents

Thank you for helping. You can add a theme, a profession, a persona, a skill,
or a fix. This guide shows how to set up, change the sources, test, and open a
pull request.

## Table of Contents

- [How It Works](#how-it-works)
- [Repository Structure](#repository-structure)
- [Development Setup](#development-setup)
- [Adding a New Theme](#adding-a-new-theme)
- [Adding a New Profession](#adding-a-new-profession)
- [Adding or Modifying Personas](#adding-or-modifying-personas)
- [Adding Skills](#adding-skills)
- [Adding Commands](#adding-commands)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Style Guide](#style-guide)
- [Versioning and Release](#versioning-and-release)
- [License](#license)

## How It Works

Four targets run from the same sources: Kiro, OpenCode, pi, and Claude Code.
`content/agents.json` maps each theme and profession to a persona file, a
description, and a welcome message. A persona gives the voice, a profession
gives the role rules, and a skill gives a workflow. A platform template gives
the permissions and tools of one target.

| Target | Template | How it works |
|--------|----------|--------------|
| Kiro | `platforms/kiro/templates/{profession}.json` | `install.sh` fills the placeholders and writes `~/.kiro/agents/{theme}-{profession}.json`. It copies the personas, professions, and skills. |
| OpenCode | `platforms/opencode/frontmatters/{profession}.yaml` | `install.sh` writes `~/.config/opencode/agents/{theme}-{profession}.md`: frontmatter and a stub comment. A plugin replaces the stub with the profession and persona text at run time. |
| pi | `platforms/pi/frontmatters/{profession}.yaml` | An extension package. It joins the frontmatter, the profession, and the persona at load time. `install.sh` writes no pi files. |
| Claude Code | `platforms/claude/agents/{profession}.md` | A plugin. Hooks send the profession and the persona as context. The agent files hold frontmatter only. |

Kiro and OpenCode templates use five placeholders, which `install.sh` fills:

| Placeholder | Source | Example |
|-------------|--------|---------|
| `{{THEME}}` | Top-level key in `agents.json` | `goblin` |
| `{{AGENT_DESCRIPTION}}` | `description` in `agents.json` | `"Fierce, loyal, delegates tasks to the horde"` |
| `{{PERSONA_FILE}}` | `personaFile` in `agents.json` | `bossnik-chief.md` |
| `{{WELCOME_MESSAGE}}` | `welcomeMessage` in `agents.json` | `"Greetings my Lord!"` |
| `{{PROFESSION}}` | Second-level key in `agents.json` | `orchestrator` |

A template does not need all five. Pi frontmatters and Claude Code agent files
use no placeholders.

The OpenCode stub comment has this form:
`<!-- persona-agents:{theme}-{profession}:{personaFile} -->`. The plugin reads
it at run time, so a new theme or profession needs no plugin change. The parse
rules are in `platforms/opencode/README.md`.

Platform details are in `platforms/kiro/README.md` (templates and the Kiro
permission model), `platforms/opencode/README.md` (frontmatter, stub format,
plugins), `platforms/pi/README.md`, and `platforms/claude/README.md` (hooks
and options).

`install.sh` never deletes files. When you retire a profession, remove its old
installed files by hand.

## Repository Structure

Platform-neutral sources live in `content/`. Files for one target live in
`platforms/<target>/`. An install mirrors `content/`, so the `skills/...`
paths inside professions and skills work in the repo and after install.

| Path | Purpose |
|------|---------|
| `content/agents.json` | Themes, professions, and persona mapping |
| `content/personas/{theme}/` | Persona files, one folder per theme |
| `content/professions/` | Role rules, one file per profession |
| `content/skills/{profession}/` | Skills, plus `common/` for shared skills |
| `content/commands/` | Slash commands shared by pi, Kiro, and OpenCode |
| `platforms/kiro/` | Kiro JSON templates |
| `platforms/opencode/` | OpenCode frontmatters and plugins |
| `platforms/pi/` | Pi extension, frontmatters, and tests |
| `platforms/claude/` | Claude Code agents, hooks, and scripts |
| `.claude-plugin/` | Claude Code plugin and marketplace manifests |
| `config/` | Example MCP server config |
| `tests/` | Cross-platform tests: permissions, `install.sh`, doc lint, prompts |
| `install.sh` | The installer for Kiro and OpenCode |
| `AGENTS.md` | Agent rules: release ritual and commit doctrine |

## Development Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/las-pinter/persona-agents.git
   ```

2. Install the tools. You need `jq`, Node.js 22 or later (the tests use
   `--experimental-strip-types`), and `shellcheck`. Then install the npm
   packages:

   ```bash
   npm install
   ```

3. Run the checks in [Testing](#testing).

There is no build step. `install.sh` writes agent files to `~/.kiro/` and
`~/.config/opencode/`. Use `--dry-run` to preview without writing.

## Adding a New Theme

A theme is a cast of characters. It needs an `agents.json` entry and one
persona file for each of the 7 professions.

1. Add the theme to `content/agents.json`. Add a new top-level key with all 7
   professions (orchestrator, planner, implementer, reviewer, tester,
   researcher, mascot):

   ```json
   {
     "mytheme": {
       "orchestrator": {
         "personaFile": "captain-example.md",
         "description": "The charismatic captain who coordinates the crew.",
         "welcomeMessage": "Alright team, what's the mission?"
       },
       "planner": { ... }
     }
   }
   ```

2. Create 7 distinct persona files in `content/personas/mytheme/`. Follow the
   [persona format](#adding-or-modifying-personas).

3. Add the theme to the Claude Code theme picker. Append it to
   `userConfig.theme.options` in `.claude-plugin/plugin.json`.

4. Check the output:

   ```bash
   ./install.sh --dry-run --force --theme mytheme
   ```

The installer then writes 7 agents for each of Kiro and OpenCode, named
`mytheme-orchestrator`, `mytheme-planner`, and so on.

## Adding a New Profession

A profession defines what an agent does. A new profession becomes available in
every theme.

1. Create the profession file, `content/professions/{name}.md`. Use this
   structure:

   ```markdown
   # {Profession}

   First paragraph: role summary.
   ## Startup          (optional; comes first when present)
   ## Core Behavior
   - The first rule: profession rules win over persona instructions on
     matters of function.
   ## <Role Sections>  (optional)
   ## When to Defer
   - Cases where this profession escalates and does not act.
   ## Failure Modes (never do these)
   ## Output Format
   ## Skills
   ```

   The required sections appear in the order shown. `## Startup` lists the
   skills to load before any user input. The `alwaysLoad` list in the pi
   frontmatter must match it. A role section normally sits between
   `## Core Behavior` and `## When to Defer`. A profession that does no tool
   work, such as `mascot.md`, may omit most sections.
   The orchestrator puts `## TODO Lists`, `## Journal Management`,
   `## Project Notes`, and `## Context Discipline (CRITICAL)` after
   `## When to Defer`. A trailing section may sit before or after `## Skills`.
   The researcher puts `## Research Documentation` between `## Output Format`
   and `## Skills`. `tests/doc-lint.test.ts` checks the skill references and
   the Startup list.

2. Create the Kiro template, `platforms/kiro/templates/{name}.json`. Copy an
   existing template. Set the tools, the allowed and denied commands, the
   subagent trust list, and the edit paths for the new role. Never list a
   gated history or release command in `allowedCommands` (see
   `platforms/kiro/README.md`).

3. Create the OpenCode frontmatter, `platforms/opencode/frontmatters/{name}.yaml`.
   Map the Kiro permissions with the table in `platforms/opencode/README.md`.

4. Create the pi frontmatter, `platforms/pi/frontmatters/{name}.yaml`. Copy an
   existing one for `name`, `description`, `tools`, `skills`, `alwaysLoad`, and
   `permissions`. A profession without a pi frontmatter is not a pi agent.

5. Create the Claude Code agent file, `platforms/claude/agents/{name}.md`. Use
   frontmatter only (`name`, `description`, and optional `tools` or
   `disallowedTools`). Leave the body empty. Add the path to `agents` in
   `.claude-plugin/plugin.json`.

6. Add the profession to every theme in `content/agents.json`. Each entry needs
   a persona file, a description, and a welcome message. Create the persona
   files.

7. Optional: add skills (see [Adding Skills](#adding-skills)).
8. Check the output with `./install.sh --dry-run --force --profession {name}`.

## Adding or Modifying Personas

A persona file sets how an agent talks and acts. Put it at
`content/personas/{theme}/{name}.md`.

```markdown
# {Name} the {Title} Persona

You are {Name}, the {Title}. [Who they are and their role in the theme.]

## Personality

- [Trait 1]
- [Trait 2]

## Speech Style

- [How they open, deliver information, and react to mistakes and praise]

## Rules

- Always stay in character as {Name}, the {Title}.
- [Behavior rule]
- Use your own themed subagents. Dispatch `{theme}-*` agents (name a few).
  Use cross-theme agents only when the user asks.

## Notes (optional)

Lore or backstory only.
```

### Key rules

- The first line is `# {Name} the {Title} Persona` (an ATX header).
- The required sections are `## Personality`, `## Speech Style`, and
  `## Rules`. `## Notes` is optional.
- The last rule names the themed subagent pattern: `goblin-*`, `wh40k-*`,
  `wh40kOrk-*`, `pub-*`, `caveman-*`, `cyberpunk-*`, `catcrew-*`, or
  `fantasy-*`.
- Do not write journal protocols in a persona. The orchestrator
  `journal-management` skill owns them.
- Match the voice to the theme.

### Testing persona changes

Generate the agent. The OpenCode file must hold one stub comment. The Kiro
`resources` list must name your persona file:

```bash
./install.sh --force --theme goblin --profession orchestrator
grep '<!-- persona-agents:' ~/.config/opencode/agents/goblin-orchestrator.md
jq '.resources' ~/.kiro/agents/goblin-orchestrator.json
```

## Adding Skills

A skill is a workflow document that an agent loads at run time.

1. Create `content/skills/{profession}/{skill-name}/SKILL.md`. Each skill
   folder holds exactly one `SKILL.md`. The `name:` in its frontmatter must
   equal the folder name. State what the skill is for,
   when to load it, and the steps. Put scripts and templates in the same
   folder, or in a `scripts/` or `templates/` subfolder.
2. A skill that several professions need goes in `content/skills/common/`. A
   pi agent loads such a skill at startup through `alwaysLoad:` in
   `platforms/pi/frontmatters/*.yaml`. Pi warns when a pattern there resolves
   to no skill.
3. Add the skill folder to `skills` in `.claude-plugin/plugin.json`. A skill
   for one other platform only goes into `EXCLUDED_SKILLS` in
   `tests/claude-plugin.test.ts`, with the reason.
4. Check the copy with
   `./install.sh --dry-run --force --profession {profession}`. A Kiro template
   loads the skills of its profession through
   `skill://~/.kiro/skills/{{PROFESSION}}/*/SKILL.md`, so a skill in an
   existing profession needs no template change.

## Adding Commands

A command is a markdown file in `content/commands/`. The file name is the
command name: `retro.md` becomes `/retro` on pi, Kiro, and OpenCode. The
`description` frontmatter shows in command completion.

1. Write `content/commands/{name}.md`. The command adds no code. It loads a
   repo skill, and the skill holds the procedure.
2. Write the skill. For the pattern, read `content/commands/retro.md` and
   `content/skills/common/retro/SKILL.md`. The retro skill also shows the
   per-platform reference files (`references/{platform}.md`).
   `tests/prompt-templates.test.ts` checks that each one exists.
3. Claude Code takes no command file. A plugin skill is a slash command there,
   so the skill name gives `/persona-agents:{name}`.

A command change needs `./install.sh --force` for Kiro and OpenCode, and
`/reload` for pi. The platform documents list how each target installs
commands.

## Testing

This section is the single source for the checks. Run all of them before a
pull request.

```bash
npm run typecheck
npm test
npm run lint
bash -n install.sh
node --check platforms/opencode/plugins/persona-agents.js
node --check platforms/opencode/plugins/permission-auditor.js
```

- `npm run typecheck` runs `tsc --noEmit`.
- `npm test` runs the pi extension tests and the tests in `tests/`.
- `npm run lint` runs `shellcheck install.sh`. CI runs the same check.
- `bash -n` and `node --check` check syntax without a build.

CI (`.github/workflows/ci.yml`) also checks that every JSON file is valid
(`jq empty`) and that `install.sh` is executable.

### Preview and generate

Preview without writing to your config. Use `--target`, `--theme`, and
`--profession` to limit the output. When the preview is correct, run it for
real with `--force`:

```bash
./install.sh --dry-run --target opencode --theme wh40k --profession implementer
./install.sh --force --theme goblin --profession orchestrator --target opencode
```

### Check the generated output

- Each target has 56 agents (8 themes and 7 professions):
  `ls ~/.kiro/agents/ | wc -l` and `ls ~/.config/opencode/agents/ | wc -l`.
- Kiro files are valid JSON: `jq . ~/.kiro/agents/*.json > /dev/null`.
- OpenCode files have valid YAML frontmatter and exactly one stub comment.
- No `{{` placeholder remains in `~/.kiro/agents/` or
  `~/.config/opencode/agents/` (except text in markdown content).
- The plugin exists: `~/.config/opencode/plugins/persona-agents.js`.

## Pull Request Process

1. Fork the repository. Create a branch with a prefix: `feat/`, `fix/`,
   `refactor/`, or `docs/`.
2. Make your change. Follow the [Style Guide](#style-guide). Run the checks in
   [Testing](#testing).
3. Commit with the form `type: description`. The type is `feat`, `fix`,
   `refactor`, `docs`, `style`, `test`, or `chore`.
4. Push the branch and open a pull request. State what changed, why, how to
   test it, and any related issue.
5. Answer review feedback.

AI agents follow a stricter rule. See the "Commit rule" section of
`AGENTS.md`.

### PR checklist

- [ ] All checks in [Testing](#testing) pass.
- [ ] `./install.sh --dry-run --force` completes with no error.
- [ ] No `{{...}}` placeholder remains in the generated output.
- [ ] Persona and profession files follow the formats in this guide.
- [ ] Templates grant no more permission than the role needs.
- [ ] A new theme covers all 7 professions, and a new profession is in every
      theme in `agents.json`.

## Style Guide

### Markdown

- Write in Simplified Technical English: short, active sentences, one term per
  meaning.
- `.editorconfig` sets the editor formatting rules.
- Use ATX headers. The first line of a file is one `#` header.
- Wrap lines at 80 to 100 characters.
- Use fenced code blocks with a language tag, and `-` for unordered lists.
- Use relative paths for links inside the repository.

### Bash (`install.sh` and scripts)

- Follow the [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html).
- Start each script with `set -euo pipefail`. Use `[[ ]]`, `$(...)`, and
  `local`. Quote all variable expansions. Use `snake_case` names.
- Send errors to stderr: `echo "error: ..." >&2`.

### JSON and YAML

- JSON: 2-space indent, double quotes, no trailing commas. `jq` checks it.
- YAML: 2-space indent, no tabs, the `.yaml` extension. Quote a string only
  when it holds special characters.

## Versioning and Release

`AGENTS.md` owns the release ritual, the version rules, and the install notes.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) — same as the rest of the project.
