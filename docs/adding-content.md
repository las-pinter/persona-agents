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

- The first line is `# <Name> the <Title> Persona`, an ATX header.
- The required sections are `## Personality`, `## Speech Style`, and
  `## Rules`. `## Notes` (lore only) is optional.
- The persona sets the chat voice only. Do not put work rules, journal rules,
  or delegation in a persona; the profession and the skills own the work.
- Match the voice to the theme.

To try a persona, set the theme in `/config` and start
`claude --agent persona-agents:companion`. To try a change from a clone, add
`--plugin-dir <clone>`.

## Adding a skill

A skill is a workflow document that the companion loads at run time.

1. Create `content/skills/<skill-name>/SKILL.md`. The `name:` in its
   frontmatter must equal the folder name. State what the skill is for, when
   to load it, and the steps. Put scripts in a `scripts/` subfolder, or in
   `platforms/claude/scripts/` when a hook shares them.
2. A skill can use `${CLAUDE_SKILL_DIR}` (its own folder) and
   `${CLAUDE_SESSION_ID}` (the session id) in its text. A skill that must run
   in a separate context sets `context: fork` and an `agent`.
3. Add the skill folder to `skills` in `.claude-plugin/plugin.json`.
4. When the companion should know the skill, name it in the `## Skills` list of
   `content/professions/companion.md`, and in the working method where it
   applies.
5. Run `npm test`. `tests/doc-lint.test.ts` checks the folder name, the
   manifest list, and the profession's skill names.
