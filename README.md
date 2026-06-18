# persona-agents 🎭

> **"Your AI agents, but make it fun."**

Tired of AI agents with all the personality of a loading spinner? Same.
`persona-agents` is a collection of personified agents for
[Kiro CLI](https://kiro.dev) and [OpenCode](https://opencode.sh) — each one
with its own voice, quirks, and attitude — because AI-assisted development
shouldn't feel like filing taxes.
Swap out the bland, drop in a character, and actually enjoy the thing helping
you build.

*A goblin horde and a WH40K warband for your codebase. You're welcome.*

> ⚠️ **Work in Progress** — This repo is actively evolving. Agents, personas,
> and skills will change, grow, and occasionally break things. You have been
> warned.

---

[![License](https://img.shields.io/github/license/las-pinter/persona-agents)](LICENSE)

> **Warning:** Review `install.sh` before running. Files will be written to
> `~/.kiro/` (Kiro) and/or `~/.config/opencode/` (OpenCode) depending on
> `--target`.

## Prerequisites

- **`jq`** — required for agent generation (JSON processing)
- **Node.js** (v18+) and **npm** — required for building the OpenCode plugin

**Ubuntu/Debian:**

```bash
sudo apt-get install jq
```

**macOS:**

```bash
brew install jq
```

Node.js and npm are available from [nodejs.org](https://nodejs.org/) or your
package manager of choice.

## Install

```bash
git clone https://github.com/las-pinter/persona-agents.git ~/persona-agents
chmod +x ~/persona-agents/install.sh
~/persona-agents/install.sh
```

By default `install.sh` installs to **both** `~/.kiro/` (Kiro) and
`~/.config/opencode/` (OpenCode). Use `--target` to install to only one:

```bash
# Install only for Kiro
~/persona-agents/install.sh --target kiro

# Install only for OpenCode
~/persona-agents/install.sh --target opencode
```

You can also filter by theme or profession:

```bash
~/persona-agents/install.sh --theme wh40k --profession orchestrator
```

> 💡 Use `--dry-run` to preview what would be installed without touching your config:
> ```bash
> ~/persona-agents/install.sh --dry-run
> ~/persona-agents/install.sh --dry-run --target opencode --theme goblin
> ```

### How It Works

This project runs **two systems** from the same source of truth.

#### 1. Static Template Generation (Kiro)

The original system — a template-based agent generator:

- **`agents.json`** is the source of truth — it defines which themes exist,
  which professions each theme has, and the persona mappings, descriptions,
  and welcome messages for each agent.
- **Templates** (`agent-templates/kiro/*.json` and
  `agent-templates/opencode/frontmatters/*.yaml`) define platform-specific
  configurations — tool permissions, model settings, and agent structure.
- **Personas** (`personas/{theme}/*.md`) provide character voice, personality,
  and speech patterns.
- **Professions** (`professions/*.md`) define role behavior rules, delegation
  patterns, and failure modes.
- **Skills** (`skills/{profession}/*/SKILL.md`) provide specialized workflow
  instructions for each profession.

The installer reads `agents.json`, combines the appropriate template with the
persona and profession for each theme/profession pair, substitutes variable
placeholders (`{{THEME}}`, `{{AGENT_DESCRIPTION}}`, `{{PERSONA_FILE}}`,
`{{WELCOME_MESSAGE}}`, `{{PROFESSION}}`), and outputs platform-specific agent
files to the target directory.

#### 2. Runtime Plugin Injection (OpenCode)

A TypeScript/Node.js plugin for OpenCode that replaces the old
static-merge approach:

- **TypeScript source** in `src/` compiles to `dist/` via `tsc` + esbuild.
- **Entry point:** `src/index.ts` exports an OpenCode `Plugin` via named export
  `server`.
- **Hook:** Implements `experimental.chat.system.transform` (see
  `src/system-transform.ts`).
- **Stub comments:** Generated `.md` agent files contain only YAML frontmatter
  plus a single HTML comment stub:
  `<!-- persona-agents:{theme}-{profession}:{personaFile} -->`
- **On-demand loading:** At runtime the plugin scans system prompt entries for
  stub markers and replaces them with the `profession.md + persona.md` content
  loaded from disk (`src/agent-registry.ts`).
- **Structured logging:** Uses `client.app.log()` via the `Logger` interface
  (`src/types.ts`) — no more `console.log`/`console.error`.
- **No dedup logic:** The old dedup was removed; the stub is fully replaced on
  every match, and if the system prompt is reconstructed fresh each call the
  replacement runs again harmlessly.
- **Installer builds the plugin:** `install.sh` runs
  `npm install && npm run build` and copies `dist/plugin-bundled.js` into
  `~/.config/opencode/plugins/persona-agents.js`.

## Repository Structure

```
persona-agents/
├── agents.json                 # Source of truth: themes → professions → personas
├── agent-templates/
│   ├── kiro/                   # Kiro JSON templates per profession
│   └── opencode/
│       └── frontmatters/       # OpenCode YAML frontmatter per profession
├── personas/{theme}/           # Character personality files
├── professions/                # Role behavior definitions
├── skills/{profession}/       # Skill documents by profession
├── src/                        # TypeScript plugin source
│   ├── index.ts                # Plugin entry point — exports `server`
│   ├── system-transform.ts     # system.transform hook implementation
│   ├── agent-registry.ts       # Stub parsing + on-demand prompt loading
│   └── types.ts                # AgentIdentity, Logger interfaces
├── dist/                       # Compiled plugin output
│   ├── plugin-bundled.js       # Self-contained bundle for OpenCode
│   ├── index.js                # Compiled entry point
│   └── ...                     # Declaration files, source maps
├── node_modules/               # npm dependencies (gitignored)
├── settings/                   # Example config files
├── install.sh                  # The installer — generates agents + builds plugin
├── package.json                # Node.js package definition
├── package-lock.json           # Dependency lockfile
├── tsconfig.json               # TypeScript configuration (rootDir: src, outDir: dist)
├── .editorconfig               # Editor formatting rules
├── .github/                    # GitHub Actions workflows
│   └── workflows/
│       └── ci.yml              # CI pipeline (jq validation, shellcheck)
├── .gitignore                  # Git ignore rules (dist/, node_modules/)
├── .mdlrc                      # Markdown lint configuration
├── CONTRIBUTING.md             # Contribution guide
├── README.md                   # You are here
└── LICENSE                     # MIT License
```

## What Gets Installed

### Kiro (`--target kiro`)

| Repo path | Installed to | Notes |
|-----------|-------------|-------|
| `agents.json` + `agent-templates/kiro/{profession}.json` | `~/.kiro/agents/{theme}-{profession}.json` | Agents generated from kiro templates with variable substitution |
| `personas/{theme}/*.md` | `~/.kiro/personas/{theme}/` | Persona definitions organized by theme |
| `professions/*.md` | `~/.kiro/professions/` | Profession/role definitions |
| `skills/{profession}/*.md` | `~/.kiro/skills/{profession}/` | Skill documents organized by profession |
| `settings/kiro-cli.json.example` | `~/.kiro/settings/cli.json` | Only if file doesn't exist |
| `settings/mcp.json.example` | `~/.kiro/settings/mcp.json` | Only if file doesn't exist |

### OpenCode (`--target opencode`)

| Repo path | Installed to | Notes |
|-----------|-------------|-------|
| `agents.json` + `agent-templates/opencode/frontmatters/{profession}.yaml` | `~/.config/opencode/agents/{theme}-{profession}.md` | Markdown files with YAML frontmatter + a **stub comment** (`<!-- persona-agents:... -->`). Persona content is injected at runtime by the plugin |
| `personas/{theme}/*.md` | `~/.config/opencode/personas/{theme}/` | Persona definitions organized by theme |
| `professions/*.md` | `~/.config/opencode/professions/` | Profession/role definitions |
| `skills/{profession}/*.md` | `~/.config/opencode/skills/{profession}/` | Skill documents organized by profession |
| `settings/mcp.json.example` | `~/.config/opencode/opencode.json` (`mcp` key) | Merged into existing config (transformed) |
| `src/` → `dist/plugin-bundled.js` | `~/.config/opencode/plugins/persona-agents.js` | Self-contained plugin bundle (auto-discovered by OpenCode) |

## Plugin Architecture

The OpenCode plugin uses a **stub comment → runtime injection** pattern:

```
install.sh generates:
  ~/.config/opencode/agents/goblin-orchestrator.md
    → YAML frontmatter (config)
    → <!-- persona-agents:goblin-orchestrator:bossnik-chief.md -->

AT RUNTIME:
  1. OpenCode loads the plugin from ~/.config/opencode/plugins/persona-agents.js
  2. Plugin registers the experimental.chat.system.transform hook
  3. On each LLM call, the hook scans all system prompt entries
  4. When it finds <!-- persona-agents:{theme}-{profession}:{personaFile} -->
     it calls parseAgentFromStubComment() → loadSinglePrompt()
  5. loadSinglePrompt reads profession.md + persona.md from disk
  6. The stub comment is FULLY REPLACED with the concatenated content
  7. If files are missing, the stub stays visible as a misconfiguration signal
```

Key design decisions:

- **On-demand loading:** No prompt pre-loading at startup. Only loaded when the
  transform hook encounters a stub.
- **No dedup needed:** The stub is fully replaced on first match. If the system
  prompt is reconstructed fresh each call, the replacement runs again
  harmlessly.
- **Self-contained:** The plugin resolves resource paths (`personas/`,
  `professions/`) relative to its own location in
  `~/.config/opencode/plugins/`, so it works without the original repo.
- **Structured logging:** All logging goes through `client.app.log()` with
  service name `persona-agents` — never `console.log`.

## Customizing

Edit files directly in `~/.kiro/` (Kiro) or `~/.config/opencode/` (OpenCode)
depending on your target. Running `install.sh` without `--force` will never
overwrite your changes.

For OpenCode, you can edit the generated agent markdown files in
`~/.config/opencode/agents/` to tweak individual agent configurations,
permissions, and behavior. You can also edit `~/.config/opencode/opencode.json`
directly for global settings and MCP server configuration.

For Kiro, edit the JSON agent files in `~/.kiro/agents/` to adjust tool
permissions, prompt paths, and other settings.

### Keeping Up to Date

Pull the latest changes and re-run the installer:

```bash
cd ~/persona-agents && git pull && ./install.sh --force
```

Settings files (`~/.kiro/settings/`, MCP config) are never touched without
`--force`, so your customizations stay safe during updates.

---

All agents below work with **both Kiro CLI and OpenCode**. When you install
with `install.sh` (default: both targets), each agent is generated in the
format appropriate for your target CLI.

## The Goblin Horde

| Agent | Character | Role | Description |
| --- | --- | --- | --- |
| goblin-orchestrator | **Bossnik** | 🎯 Orchestrator | Fierce, loyal, delegates tasks to the horde |
| goblin-reviewer | **Grumbak** | 🔍 Reviewer | Old, cynical, nitpicks everything but always valid |
| goblin-planner | **Trakk** | 📋 Planner | Obsessive, breaks down tasks, asks questions until ambiguity is dead |
| goblin-researcher | **Skribnik** | 🔬 Researcher | Ink-stained bookworm, knows Context7/DeepWiki/Exa |
| goblin-implementer | **Grubnik** | 🔨 Implementer | Practical tinkerer, builds things, makes them work |
| goblin-tester | **Frettnik** | 🧪 Tester | Paranoid, trusts nothing, finds every edge case |
| goblin-mascot | **Gibz** | 🎪 Mascot | Chaos goblin. No tools, no profession, just stupid gibberish and accidental genius |

## The WH40K Warband

| Agent | Character | Role | Description |
| --- | --- | --- | --- |
| wh40k-orchestrator | **Magos Omicron-Delta-9-Archaeon** | 🎯 Orchestrator | Technoarchaeologist. Sarcastic, hyper-precise (0.6666...%), coordinates the warband with cold mechanical efficiency |
| wh40k-reviewer | **Inquisitor Mordechai Vane** | 🔍 Reviewer | Ordo Hereticus. 290 years old. Delivers verdicts, not opinions. Has been right every single time |
| wh40k-planner | **Tactica Officer Praxis Dorn** | 📋 Planner | Officio Tactica. Veteran of eleven campaigns. Exhaustive plans, zero ambiguity tolerated |
| wh40k-researcher | **Astropath Serevah Null** | 🔬 Researcher | Astropath Transcendent. Blind, cryptic, dives into the Warp for knowledge. Always accurate |
| wh40k-implementer | **Servitor Kappa-Seven** | 🔨 Implementer | Lobotomized code-servitor. Executes implementation directives with mechanical precision |
| wh40k-tester | **Witch Hunter Cassia Vael** | 🧪 Tester | Ordo Hereticus. Paranoid, assumes everything is heretical, finds every edge case |
| wh40k-mascot | **Ogryn Brok** | 🎪 Mascot | Very big. Very strong. Very loyal. No tools, no profession. Just Brok, trying very hard |

## The WH40K Ork Warband

> ⚔️ **DA WARBOSS SEZ:** Dis 'ere's da Ork warband! Green iz best, brutal iz
> betta, an' WAAAGH! iz da only way!

| Agent | Character | Role | Description |
| --- | --- | --- | --- |
| wh40kOrk-orchestrator | 🟢 **WARBOSS GRIMGOB** | 🎯 Orchestrator | **DA BIGGEST AN' DA BOSS!** Yells orders, krumps heads, makes da boyz work togetha |
| wh40kOrk-reviewer | ⚫ **NOB SKULLBASHA** | 🔍 Reviewer | **BIG MEAN NOB!** Looks at yer work, tells ya if it's proppa or if ya need a good bashin' |
| wh40kOrk-researcher | 🟣 **KOMMANDO SNAGGIT** | 🔬 Researcher | **SNEAKY GIT!** Goes lookin' fer knowledge in places uvver boyz don't fink to look |
| wh40kOrk-planner | 🔵 **BIG MEK SPARKGUTZ** | 📋 Planner | **SMARTEST MEK AROUND!** Draws up da plans. Lots of diagrams wiv arrows an' sparks |
| wh40kOrk-implementer | 🟠 **MEKBOY WRENCHBASHA** | 🔨 Implementer | **BUILDS DA FINGS!** Hits 'em wiv a wrench till dey work. Sometimes explodes, but dat's part of da fun |
| wh40kOrk-tester | 🟡 **PAINBOY GUTSLICKA** | 🧪 Tester | **POKES AT EVERYFING!** Finds all da weak bits. Enjoys it way too much |
| wh40kOrk-mascot | 🟤 **SKRAGWITZ DA GIGGLIN'** | 🎪 Mascot | **LITTLE GROT!** No job, just causes trouble an' giggles. Sometimes says somefing clever by accident |

---

## Contributing

Want to add a new warband, a new profession, or fix something? See
[CONTRIBUTING.md](CONTRIBUTING.md) for how the system works and how to get your
PR merged.
