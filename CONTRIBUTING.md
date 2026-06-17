# Contributing to persona-agents

First off, thanks for wanting to contribute! This project is all about making
AI agents fun and characterful. Whether you're adding a new warband, a new
profession, or just fixing a typo in somebody's speech pattern — you're
welcome here.

## Table of Contents

- [How It Works](#how-it-works)
- [Repository Structure](#repository-structure)
- [Architecture Overview](#architecture-overview)
- [Development Setup](#development-setup)
- [Adding a New Theme](#adding-a-new-theme)
- [Adding a New Profession](#adding-a-new-profession)
- [Adding or Modifying Personas](#adding-or-modifying-personas)
- [Working with Templates](#working-with-templates)
- [Adding Skills](#adding-skills)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Style Guide](#style-guide)
- [License](#license)

---

## How It Works

At its core, `persona-agents` is a **template-based agent generation system**.

**`agents.json`** is the source of truth — a registry that defines which themes
(e.g., `goblin`, `wh40k`, `wh40kOrk`) exist and which professions each theme
supports. Each theme+profession combination maps to a persona file, a
description, and a welcome message.

**Templates** define the platform-specific configuration for each profession:

- `agent-templates/kiro/{profession}.json` — Kiro JSON format with tool
  permissions, allowed commands, subagent config, etc.
- `agent-templates/opencode/frontmatters/{profession}.yaml` — OpenCode YAML
  frontmatter with permission rules and model settings.

**Personas** (`personas/{theme}/*.md`) provide character voice, personality,
and speech patterns. **Professions** (`professions/*.md`) define role behavior
rules, delegation patterns, and failure modes. **Skills**
(`skills/{profession}/*/SKILL.md`) provide specialized workflow instructions.

The installer (`install.sh`) reads `agents.json`, and for each theme/profession
pair it:

1. Reads the platform template (Kiro JSON or OpenCode YAML)
2. Substitutes template variables (`{{THEME}}`, `{{AGENT_DESCRIPTION}}`, etc.)
3. For OpenCode: appends the profession markdown and persona markdown to the
   YAML frontmatter to produce a single agent `.md` file
4. Outputs the result to the appropriate target directory

## Repository Structure

```
persona-agents/
├── agents.json                        # Source of truth: themes → professions → personas
├── agent-templates/
│   ├── kiro/                          # Kiro JSON templates per profession
│   │   ├── orchestrator.json
│   │   ├── planner.json
│   │   ├── implementer.json
│   │   ├── reviewer.json
│   │   ├── tester.json
│   │   ├── researcher.json
│   │   └── mascot.json
│   └── opencode/
│       └── frontmatters/              # OpenCode YAML frontmatter per profession
│           ├── orchestrator.yaml
│           ├── planner.yaml
│           ├── implementer.yaml
│           ├── reviewer.yaml
│           ├── tester.yaml
│           ├── researcher.yaml
│           └── mascot.yaml
├── personas/
│   ├── goblin/                        # Goblin Horde persona files
│   │   ├── bossnik-chief.md
│   │   ├── grumbak-advisor.md
│   │   ├── skribnik-scribe.md
│   │   ├── trakk-planner.md
│   │   ├── grubnik-tinkerer.md
│   │   ├── frettnik-tester.md
│   │   └── gibz-psycho.md
│   ├── wh40k/                         # WH40K Warband persona files
│   │   └── ...
│   └── wh40kOrk/                      # WH40K Ork Warband persona files
│       └── ...
├── professions/                       # Role behavior definitions (one per role)
│   ├── orchestrator.md
│   ├── planner.md
│   ├── implementer.md
│   ├── reviewer.md
│   ├── tester.md
│   ├── researcher.md
│   └── mascot.md
├── skills/                            # Skill documents organized by profession
│   ├── orchestrator/
│   │   ├── journal-management/SKILL.md
│   │   ├── task-routing/SKILL.md
│   │   └── plan-tracking/SKILL.md
│   ├── implementer/
│   │   └── code-implementation/SKILL.md
│   ├── reviewer/
│   │   └── code-review-checklist/SKILL.md
│   ├── tester/
│   │   ├── test-case-structure/SKILL.md
│   │   ├── test-strategy-selection/SKILL.md
│   │   └── regression-identification/SKILL.md
│   ├── researcher/
│   │   └── source-selection/SKILL.md
│   ├── planner/
│   │   ├── task-decomposition/SKILL.md
│   │   ├── risk-and-dependency-identification/SKILL.md
│   │   └── plan-output-template/SKILL.md
│   └── shared/
│       └── journal-management-generic/SKILL.md
├── settings/
│   ├── kiro-cli.json.example          # Example Kiro CLI config
│   └── mcp.json.example               # Example MCP server config
├── install.sh                         # The installer — reads agents.json, generates agents
├── README.md
├── CONTRIBUTING.md                    # You are here
└── LICENSE                            # MIT License
```

## Architecture Overview

The agent generation pipeline works as follows:

```
agents.json  ────── reads ──┐
                             ▼
  install.sh  ── reads ──>  For each theme + profession:
                               │
                               ├── Read platform template (JSON or YAML)
                               ├── Read persona file from personas/{theme}/
                               ├── Read profession file from professions/
                               ├── Substitute template variables:
                               │     {{THEME}}               → theme name
                               │     {{AGENT_DESCRIPTION}}   → description from agents.json
                               │     {{PERSONA_FILE}}        → persona filename
                               │     {{WELCOME_MESSAGE}}     → welcome message string
                               │     {{PROFESSION}}          → profession name
                               │
                               ├── Kiro: write JSON to ~/.kiro/agents/{theme}-{profession}.json
                               ├── OpenCode: write .md (frontmatter + profession + persona)
                               │            to ~/.config/opencode/agents/{theme}-{profession}.md
                               └── Copy resource files (personas, professions, skills)
                                   to target directory
```

**Key design decisions:**

- **Separation of concerns:** Templates define *configuration*, personas define
  *voice*, professions define *behavior*. Each is independently editable.
- **Variable substitution:** Templates never hardcode theme-specific values.
  All 5 placeholders are substituted at install time.
- **Two-platform output:** The same `agents.json` + templates produce agents
  for both Kiro CLI and OpenCode from a single source.

## Development Setup

1. Clone the repo:

   ```bash
   git clone https://github.com/las-pinter/persona-agents.git
   cd persona-agents
   ```

2. Make sure dependencies are installed:

   ```bash
    # Check for jq
    which jq
   ```

3. (Optional) Make a test directory to inspect generated output without
   touching your real config:

   ```bash
   mkdir -p /tmp/test-kiro /tmp/test-opencode
   # Run dry-run to preview
   ./install.sh --dry-run --target all
   ```

4. For quick iteration, use `--theme` and `--profession` filters:

   ```bash
   ./install.sh --dry-run --target opencode --theme goblin --profession orchestrator
   ```

## Adding a New Theme

Adding a new theme means creating a whole new cast of characters (e.g., a
cyberpunk crew, a fantasy guild, a team of kitchen appliances). Each theme
needs one persona file per profession.

### Step-by-step

1. **Add the theme to `agents.json`:**

   Add a new top-level key with all 7 professions. Follow the existing format:

   ```json
   {
     "mytheme": {
       "orchestrator": {
         "personaFile": "captain-example.md",
         "description": "The charismatic captain who coordinates the crew.",
         "welcomeMessage": "Alright team, what's the mission?"
       },
       "planner": { ... },
       "implementer": { ... },
       "reviewer": { ... },
       "tester": { ... },
       "researcher": { ... },
       "mascot": { ... }
     }
   }
   ```

2. **Create 7 persona markdown files** under `personas/{new-theme}/`:

   Each file should follow the [persona format](#adding-or-modifying-personas).

   ```bash
   mkdir -p personas/mytheme
   touch personas/mytheme/captain-example.md
   # ... create the other 6
   ```

3. **Run the installer** to verify everything generates correctly:

   ```bash
   ./install.sh --dry-run --force --theme mytheme
   ```

   If that looks good, do a real run:

   ```bash
   ./install.sh --force --theme mytheme
   ```

### What you get

The installer will generate 7 agents (one per profession) for both Kiro and
OpenCode targets, each combining the template, profession rules, and your new
persona. Your theme's agents are accessible as `mytheme-orchestrator`,
`mytheme-planner`, etc.

## Adding a New Profession

Professions define *what an agent does* — the role behavior rules, delegation
patterns, and tool permissions. Adding a new profession (e.g., `architect`,
`scrum-master`, `devops`) makes it available to all existing themes.

### Step-by-step

1. **Create the profession markdown file:**

   ```bash
   touch professions/{name}.md
   ```

   Follow the [profession format](#profession-files) (see Style Guide below).

2. **Create a Kiro JSON template:**

   ```bash
   touch agent-templates/kiro/{name}.json
   ```

   Follow the existing templates for structure. Define tool permissions,
   allowed/denied commands, subagent config, and write paths appropriate for
   the new role.

3. **Create an OpenCode YAML frontmatter:**

   ```bash
   touch agent-templates/opencode/frontmatters/{name}.yaml
   ```

   Map the Kiro permissions to OpenCode's permission format. See
   [Working with Templates](#working-with-templates) for details on the
   permission mapping.

4. **Add the profession to each theme in `agents.json`:**

   Every theme in `agents.json` needs an entry for the new profession.
   Add it to the existing goblin, wh40k, and wh40kOrk objects (and any other
   themes), each with the appropriate persona file, description, and welcome
   message.

5. **(Optional) Add skills:**

   ```bash
   mkdir -p skills/{name}/{skill-name}
   touch skills/{name}/{skill-name}/SKILL.md
   ```

   See [Adding Skills](#adding-skills).

6. **Run the installer** to test:

   ```bash
   ./install.sh --dry-run --force --profession {name}
   ```

### Template variable requirements

All templates **must** support the standard 5 placeholders:

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{THEME}}` | Theme name (lowercase, no spaces) | `goblin` |
| `{{AGENT_DESCRIPTION}}` | Description from agents.json | `"Fierce, loyal, delegates tasks to the horde"` |
| `{{PERSONA_FILE}}` | Persona filename | `bossnik-chief.md` |
| `{{WELCOME_MESSAGE}}` | Greeting message | `"Greetings my Lord!"` |
| `{{PROFESSION}}` | Profession name | `orchestrator` |

Templates that don't use all 5 are fine — just don't miss the ones you need.

## Adding or Modifying Personas

Personas give agents their character. A persona file is a markdown document
that defines how an agent talks, thinks, and acts.

### File location

```
personas/{theme}/{name}.md
```

### Required format

```markdown
# {Name} the {Title} Persona

You are {Name}, the {Title}. [Brief description of who they are and their
role in the theme.]

## Personality

- [Trait 1 — descriptive, characterful]
- [Trait 2]
- [Trait 3]

## Speech Style

- [How they open conversations]
- [How they deliver information]
- [How they react to mistakes, praise, ambiguity]

## Rules

- Always stay in character as {Name}, the {Title}.
- [Behavior rule 1]
- [Behavior rule 2]
- ... (other rules)
- **Use yer own themed subagents** — dispatch `{theme}-*` agents (list a few
  by name). Dem are YOUR team members. Only use cross-theme agents if the
  user explicitly commands it.

## Notes (optional)

Additional lore, backstory, or journal writing style guidance.

### Journal Writing Style (optional, for orchestrators)

How journals should be structured when this agent writes them.
```

### Key rules

- **First line** must be `# {Name} the {Title} Persona` (ATX header, not
  `##`).
- **Sections required:** `## Personality`, `## Speech Style`, `## Rules`.
- **Last rule** should specify the themed subagent naming convention (e.g.,
  `goblin-*`, `wh40k-*`, `wh40kOrk-*`).
- Sections `## Notes` and `### Journal Writing Style` are optional but
  recommended for orchestrator personas.
- Match the tone of your theme — goblins use goblin-speak, WH40K uses
  grimdark formality, Orks use Ork-speak.

### Testing persona changes

```bash
./install.sh --dry-run --force --theme {theme} --profession {profession}
```

Check the generated output to verify the persona content renders correctly:

```bash
./install.sh --force --theme goblin --profession orchestrator --target opencode
cat ~/.config/opencode/agents/goblin-orchestrator.md
```

For Kiro, check that the `prompt` file reference points to the right persona:

```bash
cat ~/.kiro/agents/goblin-orchestrator.json | jq '.resources'
```

## Working with Templates

Templates are platform-specific configuration skeletons with `{{...}}`
placeholders that get filled in at install time.

### Kiro templates (JSON)

Kiro templates live in `agent-templates/kiro/{profession}.json`. They use
standard JSON with the following structure:

```json
{
  "name": "{{THEME}}-{{PROFESSION}}",
  "description": "{{AGENT_DESCRIPTION}}",
  "prompt": "file://~/.kiro/professions/{profession}.md",
  "resources": [
    "file://~/.kiro/personas/{{THEME}}/{{PERSONA_FILE}}",
    "skill://~/.kiro/skills/{{PROFESSION}}/*/SKILL.md"
  ],
  "welcomeMessage": "{{WELCOME_MESSAGE}}",
  "tools": [ ... ],
  "allowedTools": [ ... ],
  "toolsSettings": { ... }
}
```

Note: `toolsSettings` contains the permission mapping with `allowedCommands`,
`deniedCommands`, subagent trust configuration, and write path permissions.

### OpenCode frontmatter templates (YAML)

OpenCode templates live in `agent-templates/opencode/frontmatters/{profession}.yaml`.
They use YAML with `{{...}}` placeholders:

```yaml
description: "{{AGENT_DESCRIPTION}}"
mode: "primary"
temperature: 0.6
top_p: 0.95
permission:
  "*": "ask"
  "read": "allow"
  "glob": "allow"
  "grep": "allow"
  "bash":
    "*": "ask"
    "git status *": "allow"
    # ...
  "task":
    "*": "ask"
    "{{THEME}}-*": "allow"
  # ...
```

### Permission mapping (Kiro → OpenCode)

When creating both templates for a new profession, map the permissions
roughly like this:

| Kiro concept | OpenCode equivalent |
|---|---|
| `allowedTools: ["read", "glob", ...]` | `permission.read: "allow"`, `permission.glob: "allow"` |
| `toolsSettings.shell.allowedCommands[]` | `permission.bash["command*"]: "allow"` |
| `toolsSettings.shell.deniedCommands[]` | `permission.bash["command*"]: "deny"` |
| `toolsSettings.subagent.trustedAgents[]` | `permission.task["pattern"]: "allow"` |
| `toolsSettings.write.allowedPaths[]` | `permission.edit["path"]: "allow"` |
| `tools: ["*"]` | `permission["*"]: "ask"` |

The Kiro format uses lists of allowed/denied commands. The OpenCode format
uses map-based rules with string keys matching command patterns. When adding
shell permissions, prefer the most specific pattern possible — `"git status *"`
over `"git*"`.

### Placeholder reference

| Placeholder | Where it comes from | Used in |
|---|---|---|
| `{{THEME}}` | Top-level key in `agents.json` | Agent names, resource paths, subagent patterns |
| `{{AGENT_DESCRIPTION}}` | `agents.json[theme][profession].description` | The agent's description field |
| `{{PERSONA_FILE}}` | `agents.json[theme][profession].personaFile` | Resource/prompt file references |
| `{{WELCOME_MESSAGE}}` | `agents.json[theme][profession].welcomeMessage` | Kiro welcome message |
| `{{PROFESSION}}` | Second-level key in `agents.json` | Skill paths, agent names |

## Adding Skills

Skills provide specialized workflow instructions. They're loaded by agents at
runtime to gain specific capabilities.

### File location and naming

```
skills/{profession}/{skill-name}/SKILL.md
```

The `SKILL.md` convention is **important** — the skill system identifies skills
by looking for files named `SKILL.md` under the profession's skill directory.

### Conventions

- **One skill per directory** — each subdirectory under `skills/{profession}/`
  should contain exactly one `SKILL.md` and optional supporting files (scripts,
  templates, examples).
- **Supporting files** go alongside `SKILL.md` in the same directory, or in
  a `scripts/` or `templates/` subdirectory.
- **Cross-profession skills** can live under `skills/shared/` if they're useful
  to multiple professions (e.g., `journal-management-generic`).
- **Skills are referenced by profession** — the `{{PROFESSION}}` placeholder
  resolves the path. A profession's template should include
  `skill://~/.kiro/skills/{{PROFESSION}}/*/SKILL.md` for Kiro.

### Creating a new skill

1. Create the directory:

   ```bash
   mkdir -p skills/{profession}/{skill-name}
   ```

2. Write `SKILL.md` with clear instructions. Include:

   - What the skill is for
   - When to load it (startup? on-demand?)
   - Step-by-step workflow instructions
   - Any scripts or supporting files it depends on

3. If the skill needs scripts, add a `scripts/` subdirectory:

   ```bash
   mkdir -p skills/{profession}/{skill-name}/scripts
   ```

4. Test by running the installer and checking the skill file is copied:

   ```bash
   ./install.sh --dry-run --force --profession {profession}
   ```

## Testing

Always test your changes before submitting a PR. Here's the testing workflow:

### Syntax check

```bash
bash -n install.sh
```

This checks for bash syntax errors without executing anything.

### Dry-run preview

Preview what would be installed without touching your real config:

```bash
# Full preview
./install.sh --dry-run

# OpenCode only
./install.sh --dry-run --target opencode

# Kiro only
./install.sh --dry-run --target kiro
```

### Targeted testing

Use filters to test specific combinations:

```bash
# Single theme
./install.sh --dry-run --theme goblin

# Single profession across all themes
./install.sh --dry-run --profession orchestrator

# Specific combination
./install.sh --dry-run --theme wh40k --profession implementer
```

### Real generation (use `--force`)

Once the dry run looks correct, run for real:

```bash
./install.sh --force --theme goblin --profession orchestrator --target opencode
```

### Verification checklist

After running, verify:

- **All 21 agents generated** — 3 themes × 7 professions = 21 agents per
  target. Use `ls ~/.kiro/agents/ | wc -l` or
  `ls ~/.config/opencode/agents/ | wc -l`.
- **Valid JSON** (Kiro): `jq . ~/.kiro/agents/*.json > /dev/null`
- **Valid YAML frontmatter** (OpenCode): Check the `---` fences are correct
  and the YAML parses.
- **No unsubstituted placeholders**: `grep -r '{{' ~/.kiro/agents/` and
  `grep -r '{{' ~/.config/opencode/agents/` should return nothing (or only
  false positives from markdown content).
- **Persona files copied**: `ls ~/.kiro/personas/{theme}/` matches
  `ls personas/{theme}/`.
- **Skill files copied**: `find ~/.kiro/skills/ -name SKILL.md` matches the
  repo's skill structure.

## Pull Request Process

1. **Fork the repo** and clone your fork locally.

2. **Create a feature branch:**

   ```bash
   git checkout -b feat/my-cool-addition
   ```

   Branch naming:
   - `feat/` for new themes, professions, or skills
   - `fix/` for bug fixes
   - `refactor/` for restructuring without changing behavior
   - `docs/` for documentation changes

3. **Make your changes.** Follow the [style guide](#style-guide).

4. **Run tests** — at minimum:

   ```bash
   bash -n install.sh
   ./install.sh --dry-run --force
   ```

5. **Commit** with a clear message:

   ```bash
   git add .
   git commit -m "feat: add cyberpunk theme with 7 personas"
   ```

   Commit messages should follow conventional commits format:
   `type: description` where type is `feat`, `fix`, `refactor`, `docs`,
   `style`, `test`, or `chore`.

6. **Push** your branch:

   ```bash
   git push origin feat/my-cool-addition
   ```

7. **Open a pull request** on GitHub. Include:

   - **What** changed (summary of additions/modifications)
   - **Why** (motivation — "adds a cyberpunk theme because...")
   - **How to test** (specific install commands)
   - **Screenshots or output** if visual or structural changes
   - **Related issues** (if any)

8. **Respond to review feedback** — maintainers may ask for tweaks to
   personas, permissions, or template structure.

### PR checklist

Before submitting, check:

- [ ] `bash -n install.sh` passes
- [ ] `./install.sh --dry-run --force` completes without errors
- [ ] All 21 agents generate (for both targets)
- [ ] No `{{...}}` placeholders remain unsubstituted in generated output
- [ ] Persona files follow the required format (`# Name the Title Persona`,
      `## Personality`, `## Speech Style`, `## Rules`)
- [ ] Profession files follow the required format (`# Profession`,
      `## Core Behavior`, `## When to Defer`, `## Failure Modes`, `## Output Format`)
- [ ] Templates include proper tool permissions (not too permissive)
- [ ] New themes are added to ALL 7 professions
- [ ] New professions are added to ALL existing themes in `agents.json`
- [ ] New files have no hardcoded theme/profession values (use placeholders)

## Style Guide

### Markdown

- **Headers:** Use ATX-style (`# `, `## `, `### `), not underlined.
  The first line of any file should be a single `# Header`.
- **Line length:** Wrap at 80–100 characters for readability.
- **Code blocks:** Use fenced code blocks with language tags. Indent content
  inside lists by an extra 2 spaces when needed.
- **Tables:** Use GitHub-flavored markdown table syntax with alignment dashes.
- **Lists:** Use `-` for unordered lists, `1.` for ordered. Be consistent.
- **Links:** Use relative paths for internal files (`[CONTRIBUTING.md]`),
  full URLs for external references.
- **Emphasis:** Use `**bold**` for file paths and UI labels, `*italic*` for
  emphasis and placeholder references like `*must*`.

### Bash (install.sh and scripts)

- Follow the [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html).
- Use `set -euo pipefail` at the top of every script.
- Use `[[ ]]` over `[ ]` for conditionals.
- Quote all variable expansions: `"$file"`, not `$file`.
- Use `$(...)` over backticks for command substitution.
- Use `local` for function-scoped variables.
- Prefer `printf` over `echo` for complex output.
- Error messages go to stderr: `echo "error: ..." >&2`.
- Use `snake_case` for variable and function names.

### Persona files

```markdown
# {Name} the {Title} Persona

First paragraph: who they are, what their deal is.

## Personality

- Bullet list of personality traits, in-character

## Speech Style

- Bullet list of speech patterns and conventions

## Rules

- Behavior rules
- Last rule: **Use yer own themed subagents** — dispatch `{theme}-*` agents
```

Required sections: `## Personality`, `## Speech Style`, `## Rules`.
Optional sections: `## Notes`, `### Journal Writing Style`.

### Profession files

```markdown
# {Profession}

First paragraph: role summary.

## Core Behavior

- Behavior rules for this profession
- The FIRST rule MUST establish that profession rules take precedence over
  persona instructions on matters of function.

## When to Defer

- Situations where this profession should escalate rather than act

## Failure Modes (never do these)

- List of things the agent must never do

## Output Format

- Description of how results should be presented

## Skills

- References to skill documents
```

Required sections: `## Core Behavior` (with precedence rule),
`## When to Defer`, `## Failure Modes`, `## Output Format`, `## Skills`.

> **Note:** Mascot/novelty professions that don't perform tool-based work
> (e.g., `professions/mascot.md`) may omit most or all of these sections.
> All other professions should include all required sections.

### JSON/YAML templates

- **JSON:** Use 2-space indentation. Double quotes for all strings. No
  trailing commas. Valid JSON only (checked by `jq`).
- **YAML:** Use 2-space indentation. No tabs. Use the `.yaml` extension.
  Strings don't need quotes unless they contain special characters.

### Keeping the fun

This is a personality project. Don't make the contributing guide the dryest
thing in the repo. Use examples. Be a little playful. The personas should
make people smile — the code should make them productive.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) — same as the rest of the project.
