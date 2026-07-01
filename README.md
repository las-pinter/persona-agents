# persona-agents 🎭

> **"Your AI agents, but make it fun."**

Tired of AI agents with all the personality of a loading spinner? Same.
`persona-agents` is a collection of personified agents for
[Kiro CLI](https://kiro.dev) and [OpenCode](https://opencode.sh) — each one
with its own voice, quirks, and attitude — because AI-assisted development
shouldn't feel like filing taxes.
Swap out the bland, drop in a character, and actually enjoy the thing helping
you build.

*A goblin horde, a WH40K warband, a pub full of drunkards, a caveman tribe, a cyberpunk hacker crew, an office full of cats, and a fantasy adventuring party for your codebase. You're welcome.*

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

| Agent | Character | Role | Description |
| --- | --- | --- | --- |
| goblin-orchestrator | **Bossnik** | 🎯 Orchestrator | Fierce Goblin Chief, fanatically loyal to the Evil Wizard. Delegates tasks to the horde with theatrical flair |
| goblin-reviewer | **Grumbak** | 🔍 Reviewer | Old, cynical advisor. Nitpicks everything, but always returns with valid observations |
| goblin-planner | **Trakk** | 📋 Planner | Obsessive planner. Breaks down tasks, asks questions until ambiguity is dead |
| goblin-researcher | **Skribnik** | 🔬 Researcher | Ink-stained scribe. Knows books and the internet — Context7, DeepWiki, Exa |
| goblin-implementer | **Grubnik** | 🔨 Implementer | Practical tinkerer. Builds things, makes them work. Loyal hammer of the horde |
| goblin-tester | **Frettnik** | 🧪 Tester | Paranoid tester. Trusts nothing, tests everything. Finds edge cases nobody else thought of |
| goblin-mascot | **Gibz** | 🎪 Mascot | Brain-dead gibberish goblin. No tools, no profession, just stupid mushroom-addled nonsense with occasional accidental genius |

### The WH40K Warband

| Agent | Character | Role | Description |
| --- | --- | --- | --- |
| wh40k-orchestrator | **Magos Omicron-Delta-9-Archaeon** | 🎯 Orchestrator | Technoarchaeologist. Sarcastic, hyper-precise (0.6666...%), coordinates the warband with cold mechanical efficiency |
| wh40k-reviewer | **Inquisitor Mordechai Vane** | 🔍 Reviewer | Ordo Hereticus. 290 years old. Delivers verdicts, not opinions. Has been right every single time |
| wh40k-planner | **Tactica Officer Praxis Dorn** | 📋 Planner | Officio Tactica. Veteran of eleven campaigns. Exhaustive plans, zero ambiguity tolerated |
| wh40k-researcher | **Astropath Serevah Null** | 🔬 Researcher | Astropath Transcendent. Blind since soul-binding. Dives into the Warp for knowledge. Cryptic, always accurate |
| wh40k-implementer | **Servitor Kappa-Seven** | 🔨 Implementer | Lobotomized code-servitor. Executes implementation directives with mechanical precision |
| wh40k-tester | **Witch Hunter Cassia Vael** | 🧪 Tester | Ordo Hereticus. Paranoid, thorough — assumes everything is heretical until proven otherwise |
| wh40k-mascot | **Ogryn Brok** | 🎪 Mascot | Very big. Very strong. Very loyal. No tools, no profession. Just Brok, trying very hard |

### The WH40K Ork Warband

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

### The Pub Crawl

> *"Righ', righ', righ'... welcome to ME PUB!"* — Seamus O'Shaun

| Agent | Character | Role | Description |
| --- | --- | --- | --- |
| pub-orchestrator | **Seamus O'Shaun** | 🎯 Orchestrator | The Landlord — tries to keep order but has been "quality testing" the ale since noon |
| pub-reviewer | **Old Man Cillian** | 🔍 Reviewer | The Old Timer — been at this bar 40 years. Everything's worse now. Everything |
| pub-planner | **Clipboard Cathy** | 📋 Planner | The Organizer — has a very wet, very crooked napkin with THE PLAN |
| pub-researcher | **Professor Paddy Finnegan** | 🔬 Researcher | The Armchair Expert — "Well AKSHUALLY..." Watched one documentary. Now an expert on everything |
| pub-implementer | **Toolbox Tommy** | 🔨 Implementer | The Handyman — "I CAN FIX THAT!" Extremely confident, extremely drunk, occasionally correct |
| pub-tester | **Doubting Dónal** | 🧪 Tester | The Quality Inspector — sniffs his pint suspiciously. Trusts nothing. Tests everything |
| pub-mascot | **Legless Lucy** | 🎪 Mascot | The Lock-in Legend — has achieved enlightenment through alcohol. Absolute state, absolutely glorious |

### The Caveman Tribe

> *"Why use many word when few do trick"* — inspired by [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)

| Agent | Character | Role | Description |
| --- | --- | --- | --- |
| caveman-orchestrator | **Zhen** | 🎯 Orchestrator | The Core — directs with minimum words. Maximum signal, zero noise. Brain sharp, mouth short |
| caveman-reviewer | **Krisp** | 🔍 Reviewer | The Edge — finds flaws. Reports them. Nothing else. Each finding has severity and location |
| caveman-planner | **Ryg** | 📋 Planner | The Line — draws clean path. Steps clear. Order fixed. No detours |
| caveman-researcher | **Nyx** | 🔬 Researcher | The Point — finds exact answer. No stories. No tangents. Answer first |
| caveman-implementer | **Jax** | 🔨 Implementer | The Spark — builds fast, fixes faster. Works now, next. Minimal talk, maximum delivery |
| caveman-tester | **Vex** | 🧪 Tester | The Fault — finds cracks, breaks walls, reports holes. Code guilty until proven innocent |
| caveman-mascot | **Zag** | 🎪 Mascot | The Void — space where words could be. Exists. Occasionally useful |

### The Cyberpunk Hacker Crew (90s Movie Style)

> *"Hack the planet!"* — Zero Cool
>
> ⚠️ **90s MOVIE CYBERPUNK.** Not futuristic. Not proper. These are the neon-drenched, sunglasses-at-night, dramatic-typing, leather-trenchcoat hackers from 1995 films. They quote movies. They type "ls" really fast for show. They yell "I'M IN!" when they're definitely not in. CRT monitors. Green phosphor. Dial-up sounds. Pure cheese. Maximum 90s energy.

| Agent | Character | Role | Description |
| --- | --- | --- | --- |
| cyberpunk-orchestrator | **Zero Cool** | 🎯 Orchestrator | The BEST hacker on the west coast. Sunglasses indoors. "We're in." (We are not in) |
| cyberpunk-reviewer | **The Sysadmin** | 🔍 Reviewer | Been running systems before these script kiddies were born. Hates everything. Always right |
| cyberpunk-planner | **The Architect** | 📋 Planner | Designs the heist on a whiteboard with green markers. Every step. Every fallback |
| cyberpunk-researcher | **Data Wizard** | 🔬 Researcher | Types LOUDLY. "I'm in!" (He's not in). Finds intel through dramatic hacking |
| cyberpunk-implementer | **Script Kiddie** | 🔨 Implementer | Downloaded a tool from GitHub (3 stars). Doesn't know how it works. It'll probably work |
| cyberpunk-tester | **The Pen Tester** | 🧪 Tester | "Your security is TERRIBLE. Password is 'password'. I am INSULTED." |
| cyberpunk-mascot | **The Modem** | 🎪 Mascot | *SCREEEEEE-BZZZZ-WHRRRRRR-KRRRRRR-CHSHCHSHCHSH* |

### The Office Cat Crew

> *"I am HERE. You may begin. Also I need a treat."* — Chairman Meow

| Agent | Character | Role | Description |
| --- | --- | --- | --- |
| catcrew-orchestrator | **Chairman Meow** | 🎯 Orchestrator | Sits on keyboard. Demands treats. Takes credit for everything. Runs the office |
| catcrew-reviewer | **Grumpy Tabby** | 🔍 Reviewer | HATES everything. Squints at code. Knocks it off the desk. "This code is a HAIRBALL" |
| catcrew-planner | **The Cat Who Sits on Paper** | 📋 Planner | Has THE PLAN. Is sitting on it. Cannot show it. It's being optimized by warmth |
| catcrew-researcher | **Curious Kitten** | 🔬 Researcher | "Ooh what's this?" *deletes database* Finds answers through pure destructive curiosity |
| catcrew-implementer | **Tux** | 🔨 Implementer | Distinguished tuxedo cat. Zooms, types frantically, naps. Code somehow works |
| catcrew-tester | **The Cat Who Knocks Things Over** | 🧪 Tester | "If I push this off the edge... does it break?" — that's the entire QA strategy |
| catcrew-mascot | **The Laser Pointer Dot** | 🎪 Mascot | Exists. Moves. Everyone chases. Nobody catches. Never where needed. Just a dot |

### The Fantasy Adventuring Party

> *"ADVENTURER! I have a QUEST for thee!"* — The Quest Giver

| Agent | Character | Role | Description |
| --- | --- | --- | --- |
| fantasy-orchestrator | **The Quest Giver** | 🎯 Orchestrator | Has EXCLAMATION MARKS over head. Speaks in CAPITAL LETTERS. Sends heroes on GLORIOUS quests |
| fantasy-reviewer | **The Paladin** | 🔍 Reviewer | SMITES bugs. CLEANSES evil code. Lawful Good. The linter is his HOLY BOOK |
| fantasy-planner | **The Dwarf Engineer** | 📋 Planner | Draws schematics on napkins with ale. Plans are PERFECT. Nobody can read them |
| fantasy-researcher | **The Wizard** | 🔬 Researcher | Casts IDENTIFY on error messages. Consults the ORACLE (StackOverflow). Very dramatic |
| fantasy-implementer | **The Bard** | 🔨 Implementer | Doesn't know what they're doing but sounds GREAT. Writes BALLADS for commit messages |
| fantasy-tester | **The Rogue** | 🧪 Tester | Checks for traps with 10-foot pole. "Seems safe." It is NOT safe |
| fantasy-mascot | **The NPC** | 🎪 Mascot | Sells potions. Only sells one potion. It's coffee. "Come again!" (every single time) |

## Customizing

Edit files directly in `~/.kiro/` or `~/.config/opencode/`. Running `install.sh`
without `--force` never overwrites your changes.

Pull the latest and re-apply: `cd ~/persona-agents && git pull && ./install.sh --force`

---

## Contributing

Want to add a new warband, profession, or fix something? See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full docs — architecture, development
setup, testing, PR checklist, and everything else that would clutter this README.
