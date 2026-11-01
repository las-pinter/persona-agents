# Adding content

This section covers themes, professions, personas, and skills. A theme is a
cast of characters. A profession sets the role rules. A persona sets the
voice. A skill holds a workflow. The platform-neutral sources live under
`content/`.

## Adding a theme

A theme needs one `content/agents.json` entry and one persona file for each of
the 7 professions: orchestrator, planner, implementer, reviewer, tester,
researcher, and mascot.

1. Add a top-level key for the theme to `content/agents.json`. Give it all 7
   professions. Each profession entry holds `personaFile`, `description`, and
   `welcomeMessage`.
2. Create 7 distinct persona files in `content/personas/<theme>/`. Follow the
   persona format below.
3. Add the theme to the Claude Code theme picker. Append it to
   `userConfig.theme.options` in `.claude-plugin/plugin.json`.
4. Check the output with `./install.sh --dry-run --force --theme <theme>`.

The installer then writes 7 agents for Kiro and 7 agents for OpenCode, named
`<theme>-orchestrator`, `<theme>-planner`, and so on.

## Adding a profession

A profession defines what an agent does. A new profession becomes available in
every theme.

1. Create `content/professions/<name>.md`. The required sections appear in this
   order:

   ```markdown
   # <Profession>

   First paragraph: role summary.
   ## Startup          (optional; comes first when present)
   ## Core Behavior
   - The first rule: profession rules win over persona instructions on
     matters of function.
   ## <Role Sections>  (optional)
   ## When to Defer
   ## Failure Modes (never do these)
   ## Output Format
   ## Skills
   ```

   `## When to Defer` names the cases where the profession escalates and does
   not act. `## Startup` lists the skills to load before any user input. When a
   profession has a `## Startup` section, its `alwaysLoad` list in the pi
   frontmatter must match it. `tests/doc-lint.test.ts` enforces that parity for
   the orchestrator only. The suite also resolves every skill name that a
   profession or a template names.

   A role section normally sits between `## Core Behavior` and
   `## When to Defer`. A profession that does no tool work, such as
   `content/professions/mascot.md`, may omit most sections. A trailing section
   may sit before or after `## Skills`.

   Two professions place their own sections:

   - The orchestrator puts `## TODO Lists`, `## Journal Management`,
     `## Project Notes`, and `## Context Discipline (CRITICAL)` after
     `## When to Defer`.
   - The researcher puts `## Research Documentation` between `## Output Format`
     and `## Skills`.

2. Create the Kiro template, `platforms/kiro/templates/<name>.json`. Copy an
   existing template. Set the tools, the allowed and denied commands, the
   subagent trust list, and the edit paths. Never list a gated history or
   release command in a role template `allowedCommands`. The orchestrator
   template is the one exception, for a plain `git add` and a plain
   `git commit`. `platforms/kiro/README.md` gives the reason and the template
   format.
3. Create the OpenCode frontmatter,
   `platforms/opencode/frontmatters/<name>.yaml`. Map the Kiro permissions with
   the table in `platforms/opencode/README.md`.
4. Create the pi frontmatter, `platforms/pi/frontmatters/<name>.yaml`. Copy an
   existing one for `name`, `description`, `tools`, `skills`, `alwaysLoad`,
   `permissions`, and `permissionClass`. The `permissionClass` value must match
   the role class map `ROLE_CLASS` in
   `platforms/pi/extension/permission-table.ts`. A profession without a pi
   frontmatter is not a pi agent.
5. Create the Claude Code agent file, `platforms/claude/agents/<name>.md`. Use
   frontmatter only: `name`, `description`, and optional `tools` or
   `disallowedTools`. Leave the body empty. Add the path to `agents` in
   `.claude-plugin/plugin.json`.
6. Add the profession to every theme in `content/agents.json`. Each entry needs
   a persona file, a description, and a welcome message. Create the persona
   files.
7. Optional: add skills. Follow the skill steps below.
8. Check the output with
   `./install.sh --dry-run --force --profession <name>`.

`install.sh` never deletes installed files. A retired profession leaves its
agent files in `~/.kiro/agents/` and `~/.config/opencode/agents/`. It also
leaves the installed profession file and the installed skill copies under
`~/.kiro/` and `~/.config/opencode/`. Its template stays in
`platforms/<target>/`. Remove the files by hand.

## Adding or changing a persona

A persona file sets how an agent talks and acts. Put it at
`content/personas/<theme>/<name>.md`. The shape is:

```markdown
# <Name> the <Title> Persona

You are <Name>, the <Title>. [Who they are and their role in the theme.]

## Personality

- [Trait 1]

## Speech Style

- [How they open, deliver information, and react to mistakes and praise]

## Rules

- Always stay in character as <Name>, the <Title>.
- [Behavior rule]
- Use your own themed subagents. Dispatch `<theme>-*` agents. Use cross-theme
  agents only when the user asks.

## Notes (optional)

Lore or backstory only.
```

The rules that apply:

- The first line is `# <Name> the <Title> Persona`, an ATX header.
- The required sections are `## Personality`, `## Speech Style`, and
  `## Rules`. `## Notes` is optional.
- The last rule names the themed subagent pattern: `goblin-*`, `wh40k-*`,
  `wh40kOrk-*`, `pub-*`, `caveman-*`, `cyberpunk-*`, `catcrew-*`, or
  `fantasy-*`.
- Do not write journal protocols in a persona. The orchestrator
  `journal-management` skill owns them.
- Match the voice to the theme.

To test a persona change, generate the agent. The OpenCode file must hold one
stub comment. The Kiro `resources` list must name your persona file:

```bash
./install.sh --force --theme goblin --profession orchestrator
grep '<!-- persona-agents:' ~/.config/opencode/agents/goblin-orchestrator.md
jq '.resources' ~/.kiro/agents/goblin-orchestrator.json
```

## Adding a skill

A skill is a workflow document that an agent loads at run time.

1. Create `content/skills/<profession>/<skill-name>/SKILL.md`. Each skill
   folder holds exactly one `SKILL.md`. The `name:` in its frontmatter must
   equal the folder name. State what the skill is for, when to load it, and the
   steps. Put scripts and templates in the same folder, or in a `scripts/` or
   `templates/` subfolder.
2. A skill that several professions need goes in `content/skills/common/`. A
   pi agent loads such a skill at startup through `alwaysLoad:` in
   `platforms/pi/frontmatters/*.yaml`. Pi warns when a pattern there resolves
   to no skill.
3. Add the skill folder to `skills` in `.claude-plugin/plugin.json`. A skill
   for one other platform only goes into `EXCLUDED_SKILLS` in
   `tests/claude-plugin.test.ts`, with the reason.
4. Check the copy with
   `./install.sh --dry-run --force --profession <profession>`.

A Kiro role template loads the skills of its profession through
`skill://~/.kiro/skills/{{PROFESSION}}/*/SKILL.md`, so a skill in an existing
profession needs no template change. The mascot template has no skill
resource.
