# Adding content

This page covers themes, personas, and skills. A theme is one character: the
companion persona. A persona sets the voice. A skill holds a workflow. The
sources live under `content/`.

## Adding a theme

A theme needs one `content/agents.json` entry and one persona file.

1. Add a top-level key for the theme to `content/agents.json`, with one
   `companion` entry: `personaFile`, `description`, and `welcomeMessage`.
2. Create the persona file in `content/personas/<theme>/`. Follow the persona
   format below.
3. Add the theme to the theme picker: append it to `userConfig.theme.options`
   in `.claude-plugin/plugin.json`.
4. Run `npm test`. `tests/doc-lint.test.ts` checks the registry and the persona
   file; `tests/claude-plugin.test.ts` checks that the persona part stays under
   the 10,000-character hook cap.

The Pi adapter needs no step: it reads `content/agents.json` and the persona
file at run time and takes its theme list from the registry. Kiro CLI copies
the content into its payload, so run `./install.sh --kiro` to pick up a new
theme.

## Adding or changing a persona

A persona file sets how the companion talks. Put it at
`content/personas/<theme>/<name>.md`. The shape is:

```markdown
# <Name> the <Title> Persona

You are <Name>, the <Title>. [Who they are, and why they do the work themselves.]

## Personality

- [Trait 1]

## Speech Style

- [How they open, deliver information, and react to mistakes and praise]

## Rules

- Always stay in character as <Name>, the <Title>.
- [Behavior rule]
- [The hands-on rule: plan, build, test, report; change the plan first when
  the facts change — in the theme's voice.]
```

The rules that apply:

- The first line is an ATX H1 that ends in `Persona`, usually
  `# <Name> the <Title> Persona`.
- The required sections are `## Personality`, `## Speech Style`, and
  `## Rules`, in that order. Any other section (such as `## Notes`) holds
  voice or lore only.
- `tests/doc-lint.test.ts` checks the header and the required sections.
- The persona sets the chat voice only. Do not put work rules, session-log rules,
  or delegation in a persona; the profession and the skills own the work.
- Match the voice to the theme.

To try a persona:

- Claude Code: set the theme in `/config` and start
  `claude --agent persona-agents:companion`; add `--plugin-dir <clone>` to try
  a change from a clone.
- Pi: `pi --agent persona-agents:companion --persona <theme>`, or
  `/persona <theme>` in a running session.
- Kiro CLI: `./install.sh --kiro --theme <theme>`, then
  `kiro-cli --agent pa-companion`.

## Adding a skill

A skill is a workflow document that the companion loads at run time.

1. Create `content/skills/<skill-name>/SKILL.md`. The `name:` in its
   frontmatter must equal the folder name. State what the skill is for, when
   to load it, and the steps. Put scripts in a `scripts/` subfolder, or in
   `platforms/shared/` when more than one adapter runs them.
2. Keep the text harness-neutral. Claude Code substitutes
   `${CLAUDE_SKILL_DIR}` and `${CLAUDE_SESSION_ID}`; Pi substitutes nothing;
   the Kiro installer substitutes `{{PERSONA_AGENTS_KIRO_SKILL_DIR}}` and
   `{{PERSONA_AGENTS_KIRO_ROOT}}`. When a step differs per harness, add a
   `## Platform branch` section that keys on the `Running in <harness>` line
   of the system context, and put the Kiro procedure in `references/kiro.md`
   (see `review`, `retro`, and `wrap-up`). A skill that must run in a separate
   context on Claude Code sets `context: fork` and an `agent`.
3. Add the skill folder to `skills` in `.claude-plugin/plugin.json`.
4. When the companion should know the skill, name it in the `## Skills` list of
   `content/professions/companion.md`, and in the working method where it
   applies.
5. Run `npm test`. `tests/doc-lint.test.ts` checks the folder name, the
   manifest list, and the profession's skill names.
