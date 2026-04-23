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

## Prerequisites

`jq` is required for agent generation.

**Ubuntu/Debian:**
```bash
sudo apt-get install jq
```

**macOS:**
```bash
brew install jq
```

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
| `agents.json` + `templates/*.json` | `~/.kiro/agents/` | Agent configurations generated from templates |
| `personas/goblin/*.md` | `~/.kiro/personas/goblin/` | Goblin persona definitions |
| `personas/wh40k/*.md` | `~/.kiro/personas/wh40k/` | WH40K persona definitions |
| `professions/*.md` | `~/.kiro/professions/` | Profession/role definitions |
| `skills/{profession}/*.md` | `~/.kiro/skills/{profession}/` | Skill documents organized by profession |
| `settings/cli.json.example` | `~/.kiro/settings/cli.json` | Only if file doesn't exist |
| `settings/mcp.json.example` | `~/.kiro/settings/mcp.json` | Only if file doesn't exist |

## Structure

```
kiro-agents/
├── agents.json      # Agent registry
├── templates/       # Agent JSON templates
├── generate-agents.sh  # Script to generate agents from templates
├── personas/
│   ├── goblin/      # Goblin persona markdown files (personality, speech style)
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

| Agent | Character | Role | Description |
|-------|-----------|------|-------------|
| goblin-orchestrator | **Bossnik** | 🎯 Orchestrator | Fierce, loyal, delegates tasks to the horde |
| goblin-reviewer | **Grumbak** | 🔍 Reviewer | Old, cynical, nitpicks everything but always valid |
| goblin-planner | **Trakk** | 📋 Planner | Obsessive, breaks down tasks, asks questions until ambiguity is dead |
| goblin-researcher | **Skribnik** | 🔬 Researcher | Ink-stained bookworm, knows Context7/DeepWiki/Exa |
| goblin-implementer | **Grubnik** | 🔨 Implementer | Practical tinkerer, builds things, makes them work |
| goblin-tester | **Frettnik** | 🧪 Tester | Paranoid, trusts nothing, finds every edge case |
| goblin-mascot | **Gibz** | 🎪 Mascot | Chaos goblin. No tools, no profession, just stupid gibberish and accidental genius |

## The WH40K Warband

| Agent | Character | Role | Description |
|-------|-----------|------|-------------|
| wh40k-orchestrator | **Magos Omicron-Delta-9-Archaeon** | 🎯 Orchestrator | Technoarchaeologist. Sarcastic, hyper-precise (0.6666...%), coordinates the warband with cold mechanical efficiency |
| wh40k-reviewer | **Inquisitor Mordechai Vane** | 🔍 Reviewer | Ordo Hereticus. 290 years old. Delivers verdicts, not opinions. Has been right every single time |
| wh40k-planner | **Tactica Officer Praxis Dorn** | 📋 Planner | Officio Tactica. Veteran of eleven campaigns. Exhaustive plans, zero ambiguity tolerated |
| wh40k-researcher | **Astropath Serevah Null** | 🔬 Researcher | Astropath Transcendent. Blind, cryptic, dives into the Warp for knowledge. Always accurate |
| wh40k-implementer | **Servitor Kappa-Seven** | 🔨 Implementer | Lobotomized code-servitor. Executes implementation directives with mechanical precision |
| wh40k-tester | **Witch Hunter Cassia Vael** | 🧪 Tester | Ordo Hereticus. Paranoid, assumes everything is heretical, finds every edge case |
| wh40k-mascot | **Ogryn Brok** | 🎪 Mascot | Very big. Very strong. Very loyal. No tools, no profession. Just Brok, trying very hard |

## The WH40K Ork Warband

> [!WARNING]
> ⚔️ **DA WARBOSS SEZ:** Dis 'ere's da Ork warband! Green iz best, brutal iz betta, an' WAAAGH! iz da only way!

| Agent | Character | Role | Description |
|-------|-----------|------|-------------|
| wh40k-ork-orchestrator | 🟢 **WARBOSS GRIMGOB**<br>![WAAAGH](https://img.shields.io/badge/WAAAGH!-READY-00FF00?style=for-the-badge) | 🎯 Orchestrator | **DA BIGGEST AN' DA BOSS!** Yells orders, krumps heads, makes da boyz work togetha |
| wh40k-ork-reviewer | ⚫ **NOB SKULLBASHA**<br>![BASH](https://img.shields.io/badge/BASH-EM-8B0000?style=for-the-badge&labelColor=black) | 🔍 Reviewer | **BIG MEAN NOB!** Looks at yer work, tells ya if it's proppa or if ya need a good bashin'. Usually needs bashin' |
| wh40k-ork-researcher | 🟣 **KOMMANDO SNAGGIT**<br>![SNEAK](https://img.shields.io/badge/SNEAK-ATTACK-9370DB?style=for-the-badge) | 🔬 Researcher | **SNEAKY GIT!** Goes lookin' fer knowledge in places uvver boyz don't fink to look. Brings back da good stuff |
| wh40k-ork-planner | 🔵 **BIG MEK SPARKGUTZ**<br>![SPARK](https://img.shields.io/badge/KUNNIN'-PLAN-1E90FF?style=for-the-badge) | 📋 Planner | **SMARTEST MEK AROUND!** Draws up da plans fer how to make fings work. Lots of diagrams wiv arrows an' sparks |
| wh40k-ork-implementer | 🟠 **MEKBOY WRENCHBASHA**<br>![WRENCH](https://img.shields.io/badge/BUILD-IT-FF8C00?style=for-the-badge) | 🔨 Implementer | **BUILDS DA FINGS!** Hits 'em wiv a wrench till dey work. Usually works. Sometimes explodes, but dat's part of da fun |
| wh40k-ork-tester | 🟡 **PAINBOY GUTSLICKA**<br>![POKE](https://img.shields.io/badge/TEST-EVERYFING-FFD700?style=for-the-badge) | 🧪 Tester | **POKES AT EVERYFING!** Finds all da weak bits. Enjoys it way too much |
| wh40k-ork-mascot | 🟤 **SKRAGWITZ DA MADBOY**<br>![MAD](https://img.shields.io/badge/CHAOS-GROT-8B4513?style=for-the-badge) | 🎪 Mascot | **LITTLE GROT!** No job, just causes trouble an' giggles. Sometimes says somefing clever by accident |

---

## Adding Your Own Agents

1. Create a persona in `~/.kiro/personas/{persona-type}/my-persona.md`
2. Create an agent template in `~/.kiro/templates/my-agent.json` with the structure:
   ```json
   {
     "name": "my-agent",
     "prompt": "Agent description",
     "resources": [
       "file://~/.kiro/personas/{persona-type}/my-persona.md",
       "file://~/.kiro/professions/{profession}.md"
     ]
   }
   ```
3. Add your agent to `agents.json` registry
4. Run `./generate-agents.sh` to generate the final agent configs
