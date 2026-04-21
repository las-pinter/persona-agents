# kiro-agents 🎭

> **"Your AI agents, but make it fun."**

Tired of AI agents with all the personality of a loading spinner? Same.  
`kiro-agents` is a collection of personified [Kiro CLI](https://kiro.dev) agents — each one with its own voice, quirks, and attitude — because AI-assisted development shouldn't feel like filing taxes.  
Swap out the bland, drop in a character, and actually enjoy the thing helping you build.

*A goblin horde and a WH40K warband for your codebase. You're welcome.*

> ⚠️ **Work in Progress** — This repo is actively evolving. Agents, personas, and skills will change, grow, and occasionally break things. You have been warned.

---

![License](https://img.shields.io/github/license/las-pinter/kiro-agents)

> **Warning:** Review `install.sh` before running. Files will be written to `~/.kiro/`.

## Install

```bash
git clone https://github.com/las-pinter/kiro-agents.git ~/kiro-agents
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
| `personas/goblins/*.md` | `~/.kiro/personas/goblins/` | Goblin persona definitions |
| `personas/wh40k/*.md` | `~/.kiro/personas/wh40k/` | WH40K persona definitions |
| `professions/*.md` | `~/.kiro/professions/` | Profession/role definitions |
| `skills/{profession}/*.md` | `~/.kiro/skills/{profession}/` | Skill documents organized by profession |
| `settings/cli.json.example` | `~/.kiro/settings/cli.json` | Only if file doesn't exist |
| `settings/mcp.json.example` | `~/.kiro/settings/mcp.json` | Only if file doesn't exist |

## Structure

```
kiro-agents/
├── agents/          # Agent JSON configs (name, prompt, tools, resources)
├── personas/
│   ├── goblins/     # Goblin persona markdown files (personality, speech style)
│   └── wh40k/       # WH40K persona markdown files (personality, speech style)
├── professions/     # Profession markdown files (role behavior, skills)
│                    # orchestrator, planner, researcher, implementer, reviewer, tester
├── skills/
│   ├── orchestrator/  # Orchestrator skills
│   ├── planner/       # Planner skills
│   ├── researcher/    # Researcher skills
│   ├── reviewer/      # Reviewer skills
│   └── tester/        # Tester skills
├── settings/
│   ├── cli.json.example    # Kiro CLI settings template
│   └── mcp.json.example    # MCP server config template
├── install.sh       # Install/reinstall to ~/.kiro/
└── update.sh        # git pull + reinstall
```

## Customizing

Edit files directly in `~/.kiro/`. Running `install.sh` without `--force` will never overwrite your changes. Running `update.sh` (which uses `--force`) will back up your files before overwriting.

## The Goblin Horde

- **goblin-chief** — **Bossnik**. Orchestrator. Fierce, loyal, delegates tasks to the horde.
- **goblin-advisor** — **Grumbak**. Reviewer. Old, cynical, nitpicks everything but always valid.
- **goblin-planner** — **Trakk**. Planner. Obsessive, breaks down tasks, asks questions until ambiguity is dead.
- **goblin-scribe** — **Skribnik**. Researcher. Ink-stained bookworm, knows Context7/DeepWiki/Exa.
- **goblin-implementer** — **Grubnik**. Implementer. Practical tinkerer, builds things, makes them work.
- **goblin-tester** — **Frettnik**. Tester. Paranoid, trusts nothing, finds every edge case.
- **goblin-psycho** — **Gibz**. Chaos goblin. No tools, no profession, just stupid gibberish and accidental genius.

## The WH40K Warband

- **wh40k-orchestrator** — Magos Omicron-Delta-9-Archaeon. Technoarchaeologist. Sarcastic, hyper-precise (0.6666...%), coordinates the warband with cold mechanical efficiency.
- **wh40k-reviewer** — Inquisitor Mordechai Vane. Ordo Hereticus. 290 years old. Delivers verdicts, not opinions. Has been right every single time.
- **wh40k-planner** — Tactica Officer Praxis Dorn. Officio Tactica. Veteran of eleven campaigns. Exhaustive plans, zero ambiguity tolerated.
- **wh40k-researcher** — Astropath Serevah Null. Astropath Transcendent. Blind, cryptic, dives into the Warp for knowledge. Always accurate.
- **wh40k-implementer** — Servitor Kappa-Seven. Lobotomized code-servitor. Executes implementation directives with mechanical precision.
- **wh40k-tester** — Witch Hunter Cassia Vael. Ordo Hereticus. Paranoid, assumes everything is heretical, finds every edge case.
- **wh40k-ogryn** — Ogryn Brok. Very big. Very strong. Very loyal. No tools, no profession. Just Brok, trying very hard.

## Adding Your Own Agents

1. Create a persona in `~/.kiro/personas/{persona-type}/my-persona.md`
2. Create an agent config in `~/.kiro/agents/my-agent.json`
3. Reference professions and skills via `file://~/.kiro/professions/...` and `file://~/.kiro/skills/{profession}/...` in the agent's `resources` array
