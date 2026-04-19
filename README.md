# kiro-agents 🧌

> **"Your AI agents, but make it fun."**

Tired of AI agents with all the personality of a loading spinner? Same.  
`kiro-agents` is a collection of personified [Kiro CLI](https://kiro.dev) agents — each one with its own voice, quirks, and attitude — because AI-assisted development shouldn't feel like filing taxes.  
Swap out the bland, drop in a character, and actually enjoy the thing helping you build.

*A goblin horde for your codebase. You're welcome.*

> ⚠️ **Work in Progress** — This repo is actively evolving. Agents, personas, and skills will change, grow, and occasionally break things. You have been warned.

---

![License](https://img.shields.io/github/license/las-pinter/kiro-agents)

> **Warning:** Review `install.sh` before running. Files will be written to `~/.kiro/`.

## Install

```bash
git clone https://github.com/you/kiro-agents.git ~/kiro-agents
chmod +x ~/kiro-agents/install.sh
~/kiro-agents/install.sh
```

## Update

```bash
cd ~/kiro-agents && ./update.sh
```

This pulls the latest changes and reinstalls agents, personas, professions, and skills (backing up any existing files). Your `~/.kiro/settings/` files are never touched by updates.

## What Gets Installed

| Repo path | Installed to | Notes |
|-----------|-------------|-------|
| `agents/*.json` | `~/.kiro/agents/` | Agent configurations |
| `personas/*.md` | `~/.kiro/personas/` | Persona definitions |
| `professions/*.md` | `~/.kiro/professions/` | Profession/role definitions |
| `skills/*.md` | `~/.kiro/skills/` | Skill documents |
| `settings/cli.json.example` | `~/.kiro/settings/cli.json` | Only if file doesn't exist |
| `settings/mcp.json.example` | `~/.kiro/settings/mcp.json` | Only if file doesn't exist |

## Structure

```
kiro-agents/
├── agents/          # Agent JSON configs (name, prompt, tools, resources)
├── personas/        # Persona markdown files (personality, speech style)
├── professions/     # Profession markdown files (role behavior, skills)
├── skills/          # Skill documents (loaded on demand by agents)
├── settings/
│   ├── cli.json.example    # Kiro CLI settings template
│   └── mcp.json.example    # MCP server config template
├── install.sh       # Install/reinstall to ~/.kiro/
└── update.sh        # git pull + reinstall
```

## Customizing

Edit files directly in `~/.kiro/`. Running `install.sh` without `--force` will never overwrite your changes. Running `update.sh` (which uses `--force`) will back up your files before overwriting.

## Adding Your Own Agents

1. Create a persona in `~/.kiro/personas/my-persona.md`
2. Create an agent config in `~/.kiro/agents/my-agent.json`
3. Reference professions and skills via `file://~/.kiro/professions/...` in the agent's `resources` array
