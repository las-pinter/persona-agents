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

| Agent | Character | Role | Description |
|-------|-----------|------|-------------|
| wh40k-ork-orchestrator | 🟢 <span style="color:#00FF00">**WARBOSS GRIMGOB**</span> 🟢 | 🎯 <mark style="background-color:#228B22;color:white">**ORCHESTRATOR**</mark> 🔴 | <span style="color:#32CD32">**DA BIGGEST AN' DA BOSS!**</span> 🟢 Yells orders, krumps heads, makes da boyz work togetha. ![WAAAGH](https://img.shields.io/badge/WAAAGH!-00FF00?style=flat&color=green) 🟢🔴🟢 |
| wh40k-ork-reviewer | ⚫ <span style="color:#8B0000">**NOB SKULLBASHA**</span> ⚫ | 🔍 <mark style="background-color:#8B0000;color:white">**REVIEWER**</mark> 🔴 | <span style="color:#DC143C">**BIG MEAN NOB!**</span> ⚫ Looks at yer work, tells ya if it's proppa or if ya need a good bashin'. ![BASH](https://img.shields.io/badge/BASH-8B0000?style=flat&color=darkred) 🔴⚫🔴 Usually needs bashin' |
| wh40k-ork-researcher | 🟣 <span style="color:#9370DB">**KOMMANDO SNAGGIT**</span> 🟣 | 🔬 <mark style="background-color:#4B0082;color:white">**RESEARCHER**</mark> 🟣 | <span style="color:#8A2BE2">**SNEAKY GIT!**</span> 🟣 Goes lookin' fer knowledge in places uvver boyz don't fink to look. ![SNEAK](https://img.shields.io/badge/SNEAK-9370DB?style=flat&color=mediumpurple) 🟣⚫🟣 Brings back da good stuff |
| wh40k-ork-planner | 🔵 <span style="color:#1E90FF">**BIG MEK SPARKGUTZ**</span> 🔵 | 📋 <mark style="background-color:#4169E1;color:white">**PLANNER**</mark> ⚡ | <span style="color:#00BFFF">**SMARTEST MEK AROUND!**</span> 🔵 Draws up da plans fer how to make fings work. ![SPARK](https://img.shields.io/badge/SPARK-1E90FF?style=flat&color=dodgerblue) 🔵⚡🔵 Lots of diagrams wiv arrows an' sparks |
| wh40k-ork-implementer | 🟠 <span style="color:#FF8C00">**MEKBOY WRENCHBASHA**</span> 🟠 | 🔨 <mark style="background-color:#FF8C00;color:black">**IMPLEMENTER**</mark> 🔧 | <span style="color:#FFA500">**BUILDS DA FINGS!**</span> 🟠 Hits 'em wiv a wrench till dey work. ![WRENCH](https://img.shields.io/badge/WRENCH-FF8C00?style=flat&color=darkorange) 🟠🔧🟠 Usually works. Sometimes explodes, but dat's part of da fun |
| wh40k-ork-tester | 🟡 <span style="color:#FFD700">**PAINBOY GUTSLICKA**</span> 🟡 | 🧪 <mark style="background-color:#DAA520;color:black">**TESTER**</mark> 💉 | <span style="color:#FFFF00">**POKES AT EVERYFING!**</span> 🟡 Finds all da weak bits. ![POKE](https://img.shields.io/badge/POKE-FFD700?style=flat&color=gold) 🟡💉🟡 Enjoys it way too much |
| wh40k-ork-mascot | 🟤 <span style="color:#8B4513">**SKRAGWITZ DA MADBOY**</span> 🟤 | 🎪 <mark style="background-color:#A0522D;color:white">**MASCOT**</mark> 🤪 | <span style="color:#D2691E">**LITTLE GROT!**</span> 🟤 No job, just causes trouble an' giggles. ![MAD](https://img.shields.io/badge/MAD-8B4513?style=flat&color=saddlebrown) 🟤🤪🟤 Sometimes says somefing clever by accident |

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
