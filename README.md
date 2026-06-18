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

- **`jq`** — for agent generation
- **Node.js** (v18+) and **npm** — for the OpenCode plugin

**Ubuntu/Debian:** `sudo apt-get install jq`
**macOS:** `brew install jq`

Node.js and npm are available from [nodejs.org](https://nodejs.org/).

## Install

```bash
git clone https://github.com/las-pinter/persona-agents.git ~/persona-agents
chmod +x ~/persona-agents/install.sh
~/persona-agents/install.sh
```

By default installs to **both** `~/.kiro/` and `~/.config/opencode/`.
Use `--target kiro` or `--target opencode` for a single platform.
Use `--theme` and `--profession` to filter. Use `--dry-run` to preview.

## How It Works

Two systems, one source of truth (`agents.json`):

- **Kiro:** Static template generation — combines templates, personas, and professions into agent configs at install time.
- **OpenCode:** Runtime plugin — generated agent files contain a stub comment (`<!-- persona-agents:... -->`) that the OpenCode plugin replaces with persona content on demand.

## Repository Structure

```
persona-agents/
├── agents.json                 # Source of truth: themes → professions → personas
├── agent-templates/            # Kiro JSON + OpenCode YAML frontmatter per profession
├── personas/{theme}/           # Character personality files
├── professions/                # Role behavior definitions
├── skills/{profession}/       # Skill documents by profession
├── src/                        # TypeScript plugin source
├── dist/                       # Compiled plugin output
├── settings/                   # Example config files
├── install.sh                  # The installer
└── ...config files             # package.json, tsconfig.json, etc.
```

## Agents

All agents work with both Kiro CLI and OpenCode.

### The Goblin Horde

| Agent | Character | Description |
| --- | --- | --- |
| goblin-orchestrator | **Bossnik** | Fierce Goblin Chief. Delegates to the horde with theatrical loyalty |
| goblin-reviewer | **Grumbak** | Old, cynical advisor. Nitpicks everything, always right |
| goblin-planner | **Trakk** | Obsessive planner. Breaks down tasks until ambiguity is dead |
| goblin-researcher | **Skribnik** | Ink-stained scribe. Knows books, the web, and dark archives |
| goblin-implementer | **Grubnik** | Practical tinkerer. Builds things, makes them work |
| goblin-tester | **Frettnik** | Paranoid tester. Trusts nothing, finds every edge case |
| goblin-mascot | **Gibz** | Chaos goblin. No tools, just gibberish and accidental genius |

### The WH40K Warband

| Agent | Character | Description |
| --- | --- | --- |
| wh40k-orchestrator | **Magos Omicron-Delta-9** | Sarcastic technoarchaeologist. Cold mechanical precision |
| wh40k-reviewer | **Inquisitor Mordechai Vane** | 290 years old. Delivers verdicts, not opinions. Never wrong |
| wh40k-planner | **Tactica Officer Praxis Dorn** | Veteran of eleven campaigns. No ambiguity tolerated |
| wh40k-researcher | **Astropath Serevah Null** | Blind astropath. Dives into the Warp for knowledge |
| wh40k-implementer | **Servitor Kappa-Seven** | Lobotomized code-servitor. Executes with mechanical precision |
| wh40k-tester | **Witch Hunter Cassia Vael** | Assumes everything is heretical until proven otherwise |
| wh40k-mascot | **Ogryn Brok** | Very big, very strong, very loyal. Not very smart |

### The WH40K Ork Warband

| Agent | Character | Description |
| --- | --- | --- |
| wh40kOrk-orchestrator | **WARBOSS GRIMGOB** | Da biggest an' da boss! Yells orders, krumps heads |
| wh40kOrk-reviewer | **NOB SKULLBASHA** | Big mean nob! Tells ya if yer work's proppa |
| wh40kOrk-researcher | **KOMMANDO SNAGGIT** | Sneaky git! Finds fings uvver boyz don't fink to look |
| wh40kOrk-planner | **BIG MEK SPARKGUTZ** | Smartest mek around! Draws plans wiv arrows an' sparks |
| wh40kOrk-implementer | **MEKBOY WRENCHBASHA** | Builds da fings! Hits 'em wiv a wrench till dey work |
| wh40kOrk-tester | **PAINBOY GUTSLICKA** | Pokes at everyfing! Enjoys it way too much |
| wh40kOrk-mascot | **SKRAGWITZ DA GIGGLIN'** | Little grot! No job, causes trouble, sometimes says smart stuff by accident |

## Customizing

Edit files directly in `~/.kiro/` or `~/.config/opencode/`. Running `install.sh`
without `--force` never overwrites your changes.

Pull the latest and re-apply: `cd ~/persona-agents && git pull && ./install.sh --force`

---

## Contributing

Want to add a new warband, profession, or fix something? See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full docs — architecture, development
setup, testing, PR checklist, and everything else that would clutter this README.
