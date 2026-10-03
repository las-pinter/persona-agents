# agent-stack — the persona-agents pi extension

One extension, one entry: `extension.ts`. Internally modular:

| Module | Responsibility |
|---|---|
| `extension.ts` | Entry point: wires gate, commands, subagent tool, session hooks |
| `resolver.ts` | Discovers agents + personas from user (`~/.pi/agent`), project (`.pi/`), and this package (`agents/`, `personas/`) |
| `permissions.ts` | Tool-call gate: global `permissions.json` (hard deny/ask) + active agent's frontmatter `permissions:` (deny → ask → allow → mode default) |
| `state.ts` | Active agent/persona state; reads session defaults from `~/.pi/agent/settings.json` and `PI_DEFAULT_*` env (never writes) |
| `commands.ts` | `/agents [name|off] [-persona id\|off]`, `/persona`, `/skills` slash commands |
| `subagent.ts` | Spawn-based subagent tool (single / parallel / chain), ported from the legacy extension |
| `inspector.ts` | Subagent run archive + `/runs` + full-screen `/inspect` |

## Install

```bash
# development: local path, no copy (the repo stays the source of truth)
pi install ~/persona-agents

# distribution — PIN the newest release tag (current package version: 2.2.0;
# unpinned git clones the default branch, so pinning matters):
pi install git:github.com/las-pinter/persona-agents@<newest-release-tag>
```

Check the GitHub Releases/tags page for the **newest tag** and bump on
releases — don't hardcode one version. Manage the package with `pi list` /
`pi remove <source>`, reconcile a clone after a new tag with
`pi update --extensions`, and install only **one** source per package (a local
path and a git clone of the same repo both register the extension, which pi
reports as duplicate-tools/commands/flags conflicts).

## Agent files

Agents are **modular**, mirroring the opencode split:

- frontmatter (pi schema) → `agent-templates/pi/frontmatters/<name>.yaml`
- body → `professions/<name>.md` (single source of truth, shared with kiro/opencode)

The resolver composes them at load time (`parseFrontmatter` wraps the bare YAML,
so no extra YAML dependency is needed). No generated files, no drift: edit the
profession, add a template for a new profession, and it appears in `/agents`
immediately. All 8 professions ship pi templates; a profession without a
frontmatter template is simply not exposed as a pi agent.

The pi templates were translated from `agent-templates/opencode/frontmatters`
(shared permission intent, pi-native schema). Translation notes:

- opencode `action/resource/effect` triples become `tool/match(es)` pi regexes;
  like-commands are combined into single tidy regexes (e.g. all read-only git
  variants, the python/jest/tsc toolchain, the read-only viewers).
- opencode's default `ask` for core actions (e.g. `edit` for implementer/tester)
  becomes `allow`: headless subagents block on confirm prompts, so their raison
  d'être would be unusable. `deny` lists keep the hard blocks (push/pull,
  `find -exec/-execdir/-delete/-ok/-okdir/-fls/-fprint(0|f)`, `curl|sh`,
  `xargs → rm|sh|bash|zsh|mv|cp` (first non-option token after xargs options),
  `rm -r/-f/-rf/-fr`, `sudo`, mkfs/dd).
- The bash redirection deny is narrowed: real file-writing redirections (`>`, `>>`,
  `tee`) with whitespace or a command separator before the redirect are denied —
  including the space-form `> /dev/null` idiom (fail-closed); fd-touching forms (`2>`,
  `2>&1`) and glued `>` inside code/strings are allowed, and glued redirects
  (`cmd>file`) are an accepted residual gap. The gate only denies bare-token
  forms — absolute paths (`/bin/rm`), backslash obfuscation (`te\e`), fd `1>`
  redirects, and `$(...)`-splices of keywords are known residual evasions
  (inherent flat-regex limitation; full hardening deferred).
- The `cd X && …` / `git -C X …` forms (pi permits the first token only) are
  folded into the git regexes so delegates don't get stuck on command prefixes.
- opencode `skill` rules become `skills:` binding patterns per profession.
  opencode research actions (`websearch`, `context7`, `deepwiki`, `exa`) are
  MCP/extension tools — out of scope for the regex gate, so they are not listed:
  **MCP and namespaced tools (`mcp__…`, `server.tool`) are never gated** (see
  `permissions.ts`). They are research/read-only services or extension
  namespaces, and spawned subagents are already confined to their `tools:`
  loadout via `--tools`. In the main session the gate constrains
  bash/read/edit/write/… calls; MCP access is controlled by tool *availability*
  (`--tools`, `--no-tools`), not by per-agent rules.

Template fields (YAML):

| Field | Type | Meaning |
|---|---|---|
| `name` | string | required — invoked as `/agents <name>` or `agent: "name"` |
| `description` | string | required — shown in listings |
| `spawnable` | boolean | optional — `false` marks the agent as **not dispatchable as a subagent**: the `subagent` tool rejects it (alias or direct name) before spawning. Defaults to `true`. Use the **unquoted boolean** (`spawnable: false`); the resolver also treats a quoted `"false"` string as disabled, but the boolean is the documented form. The `orchestrator` and `overseer` templates ship `spawnable: false` |
| `tools` | string[] | tool-name allowlist for subagent spawns (`--tools`) |
| `model` | string | optional `provider/model` override for subagent spawns |
| `persona` | string | default persona reference: `theme/name`, `name`, or `theme` |
| `skills` | string[] | glob bindings to skills under `skills/` (package, user, project). `"orchestrator/*"` loads every skill in the orchestrator group; matched `SKILL.md` bodies are injected into the agent prompt |
| `alwaysLoad` | string[] | skills **guaranteed** injected into the prompt at startup as `## Mandatory skill: <id>` blocks. A pattern that resolves to no skill, or a body/budget overrun, logs `console.warn` and leaves a visible marker in the prompt (`MISSING skill for alwaysLoad entry: …` / `>> SKILL TRUNCATED: …`) — never silent. Overlap with `skills:` is deduped (alwaysLoad wins) |
| `resources` | string[] | file globs relative to the session cwd (`!` = exclude). Small files are inlined (≤4 KiB), larger ones listed as paths (≤32 KiB total, ≤8 dir depth, skips `.git`/`node_modules`/…) |
| `permissions` | object | see below |

Note: `description` is required; `name` defaults to the template filename.

`permissions:` (frontmatter) — rules evaluated per tool call:

```yaml
permissions:
  mode: deny-by-default            # or allow-unless-matched (Pi default)
  allow:
    - { tool: bash, match: "^curl\\b.*" }
  ask:
    - { tool: bash, match: "\\brm\\s+-[rf]{1,2}\\b" }
  deny:
    - { tool: bash, match: "curl\\b.*\\|\\s*(ba)?sh\\b" }
```

Order: global `permissions.json` deny → agent deny → global ask → agent ask → agent allow
→ mode default.

An `ask` rule that the user **approves in the TUI grants that single call** — it is a
manual override for calls the allow list does not cover (e.g. `sudo`/`rm -rf` in the
orchestrator or planner templates). Deny rules always win; headless runs (subagent
children, `-p`, `--mode json`) have no UI, so `ask` there is a hard block.

The ask prompt offers **three options: Deny / Allow / Always allow (session)**. "Always
allow (session)" grants the call *and* remembers the `agent|tool|rule` for the rest of the
session — **in-memory only, nothing is persisted to disk** (a persistent always-allow list
is a future decision).

**Delegated commits now ask**: the orchestrator's `git add`/`git commit` moved from its
`allow` list to its `ask` list — a commit prompts allow/deny in the main session instead
of running silently (`git push`/`pull` stay hard-denied). Since a commit is an `ask` rule
and ask is a hard block without a UI, **headless orchestrator runs (delegated/`-p`/
`--mode json`) cannot commit**.

Gate scope: only `bash`/`powershell` (command), `read`/`grep`/`find`/`ls`/`edit`/`write`
(path/pattern), and other plain tools (JSON args) are probed. `mcp__…` and namespaced
tools are never gated (translation note above).

## Skills and resources

An agent's frontmatter `alwaysLoad:` and `skills:` are resolved at `before_agent_start`
and injected into that agent's system prompt (`alwaysLoad` first, then `skills`, then
resources, then persona on top): `alwaysLoad` carries the guaranteed-once contract
(missing/oversized skills warn loudly; a skill in both lists is injected once by the
shared dedup set). `discoverSkills()` understands both this repo's
`skills/<group>/<name>/SKILL.md` layout and pi's `skills/<name>/SKILL.md`;
`/skills [agent]` lists what would load.

## Inspecting subagent runs

Every completed subagent tool run is archived (bounded to the last 12).

- `/runs` — list archived runs (`last  mode ✓✓✗ agents…`)
- `/inspect [last|N]` — open a run in a **full-screen overlay** (like opencode's dedicated
  agent views): task list, per-task tool calls, final output, usage, and errors.
  Keys: `↑/↓` + `PgUp/PgDn` scroll · `Tab`/`←/→` switch task · `q`/`Esc` close.

## Editable agent-notes zones

Per the kiro/opencode templates' `edit`/`external_directory` allows, each profession may
freely edit its own `~/agent-notes` zones (the gate allows them; everything else stays
denied-by-default):

| Agent | Zones (edit + write) |
|---|---|
| orchestrator | `agent-notes/orchestrator/**`, `agent-notes/planner/plans/**` |
| planner | `agent-notes/planner/**` |
| overseer | `agent-notes/overseer/**` |
| researcher | `agent-notes/researcher/**`, `agent-notes/orchestrator/projects/**` |
| implementer / tester | workspace files (edit/write everywhere) |
| reviewer / mascot | none (read-only) |

## Personas and themes

Personas are `personas/<theme>/<name>.md` — **legacy files work as-is** (plain markdown,
no frontmatter): name = filename, theme = folder, description = first heading. The persona
body is appended after the agent prompt on each run; personas never grant permissions.

**Theme ↔ profession mapping**: `agents.json` connects themes and professions to personas
(`{"goblin": {"orchestrator": {"personaFile": "bossnik-chief.md", …}}}`). A persona
reference is resolved in this order:

1. explicit `theme/name`
2. bare persona name
3. **theme name** → `agents.json[theme][agent]` → the persona for that profession
4. fallback: first persona in the theme

So `/agents orchestrator -persona goblin`, `pi --agent orchestrator --persona goblin`, or
`"defaultPersona": "goblin"` all pick `goblin/bossnik-chief` for the orchestrator (and
`goblin/grumbak-advisor` when the same theme is applied to a reviewer). With no `-persona`,
the `defaultPersona` setting (or `PI_DEFAULT_PERSONA` env) is loaded — a plain theme value
is now valid there too.

**Subagent theme inheritance**: when the orchestrator delegates, the caller's theme
(carried by its active persona) is applied to every spawned agent that has no persona of
its own — a goblin orchestrator spawns goblin reviewers, researchers, etc. (as mapped in
`agents.json`); agents with an explicit `persona:` in their frontmatter keep their own.

**`theme-profession` aliases**: pi agent names also accept the kiro/opencode composite
form (`goblin-mascot` = the `mascot` agent with the goblin persona, mapped through
`agents.json`). Allowed wherever an agent name is accepted: the `subagent` tool (`agent`,
`tasks[].agent`, `chain[].agent`), `/agents`, and the `--agent` flag.

## Main agent at startup

Start pi already in character:

```bash
pi --agent orchestrator --persona goblin/bossnik-chief
```

`--agent` / `--persona` are **extension-registered CLI flags** (no core changes),
resolved in the order flag > settings > env. Alternatives:

- Persist `"defaultAgent": "orchestrator"` and `"defaultPersona"` in
  `~/.pi/agent/settings.json` (or `PI_DEFAULT_AGENT` / `PI_DEFAULT_PERSONA` env).
- `/agents orchestrator -persona goblin/bossnik-chief` activates for this session only
  (in-memory); persistence is by hand-editing `~/.pi/agent/settings.json`.

## Scope

- `discoverAgents(cwd, scope)` — `user` (agent dir + package), `project` (nearest `.pi/agents`),
  `both` (merged; project wins name collisions).
- Subagent spawns use `pi --mode json -p --no-session --agent <name> --persona <id|off>`
  (plus `--tools`, `--model`, `--thinking`). The child activates exactly that agent and
  persona via the flags, so **global `defaultAgent`/`defaultPersona` can never leak into a
  subagent** — "off" explicitly clears them. The child's own `before_agent_start` injects
  the profession body + persona (no temp prompt file), and because the child has a real
  active agent, its frontmatter permissions are enforced by the gate there too.
- **Spawned subagents are isolated from herdr control**: `buildChildEnv()` in `subagent.ts`
  removes `HERDR_ENV` from the child env, so herdr access does not inherit. The
  per-template deny rules block direct calls. A subagent with code execution (an
  interpreter or a script) can still set `HERDR_ENV` and call the binary by absolute
  path — a documented residual. herdr's own access check is the final boundary. The
  overseer main session is launched via the pi CLI and never passes through this spawn
  site, so it is unaffected.
- **Guard limits (honest)**: the per-template herdr rules block command-position `herdr`
  (bare, absolute path, and behind `env`/`time`/`nice`/…/`sudo`/`VAR=…` prefixes),
  `$( … )` and backtick command substitution, and shell `-c` payloads
  (`bash -c '…herdr…'`, `sh -c`, `bash <path>/herdr`). They do **not** catch
  interpreter/encoder paths (`python3 -c '…herdr…'`, `perl -e`, `base64 -d | sh`),
  absolute-path calls from agents whose interpreters are allowed, or backslash-split
  binary names (`te\e` class): those are documented residuals of a flat-regex gate.
  For spawned subagents the `HERDR_ENV` strip covers these residuals too — unless the
  subagent sets `HERDR_ENV` itself.