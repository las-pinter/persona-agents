# agent-stack — the persona-agents pi extension

One extension, one entry: `extension.ts`. Internally modular:

| Module | Responsibility |
|---|---|
| `extension.ts` | Entry point: wires gate, commands, subagent tool, session hooks |
| `resolver.ts` | Discovers agents + personas from user (`~/.pi/agent`), project (`.pi/`), and this package (`agents/`, `personas/`) |
| `permissions.ts` | Tool-call gate: global `permissions.json` (hard deny/ask) + active agent's frontmatter `permissions:` (deny → ask → allow → mode default) |
| `command-segments.ts` | Pure (no pi imports) shell splitter + rule-decision core used by `permissions.ts`; testable under plain Node |
| `state.ts` | Active agent/persona state; reads session defaults from `~/.pi/agent/settings.json` and `PI_DEFAULT_*` env (never writes) |
| `commands.ts` | `/agents [name|off] [-persona id\|off]`, `/persona`, `/skills` slash commands |
| `subagent.ts` | Spawn-based subagent tool (single / parallel / chain), ported from the legacy extension |
| `inspector.ts` | Subagent run archive + `/runs` + full-screen `/inspect` |
| `depth.ts` | Pure nesting-depth helpers: 3-level cap (0, 1, 2), env parse, parent `--tools` strip, run-id allocation |
| `tree-log.ts` | Shared append-only NDJSON tree log: byte cap, tolerant reader, root-only rotation |
| `tree-model.ts` | Pure fold of tree-log records into a `TreeNode` forest (links, orphans, stale marks) |
| `sidebar-render.ts` | Pure five-panel renderers (AGENTS, SESSION, WORKSPACE, MCP, TODOS) |
| `sidebar-data.ts` | Impure snapshot collector: subscribes once to pi events, owns the polls and the TPS window |
| `sidebar.ts` | Right-column compositor (clean-room) and the `/sidebar` toggle config |
| `tree-ui.ts` | Sidebar glue: binds compositor, data, commands, and lifecycle; reads the git branch |
| `todo-tool.ts` | `todo` tool: session-entry state, registration, and the `persona-agents/todos/v1` event |

## Install

```bash
# development: local path, no copy (the repo stays the source of truth)
pi install ~/persona-agents

# distribution — PIN the newest release tag (unpinned git clones the default
# branch, so pinning matters):
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
  d'être would be unusable. `deny` lists keep the hard blocks (push/pull for
  non-orchestrators,
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
  A leading `cd X` before any separator folds the segment to `cd X && …`, so a
  `cd X || sudo true` line is rewritten to `cd X && sudo true` for allow
  matching. The fold is lossy for allow only: the raw pre-fold segments stay in
  the deny and ask probes, so an anchored deny such as `^sudo\b` still blocks
  `cd X || sudo true`.
- Compound commands are enforced per segment: `echo hi && id`, `a; b`, and pipe
  chains are split on unquoted control operators and **every** segment must be
  allowed. The `cd X && …` fold above is what keeps the git regexes valid. A
  disallowed segment blocks the whole command. Heredocs (`<<`, `<<<`), ANSI-C
  quoting (`$'...'`), unbalanced quotes, and dangling operators fail closed. See
  `agent-stack/command-segments.ts`.
  `$(...)`/backtick/process-substitution inner commands are added as their own
  segments, so `echo $(id)` blocks. Arithmetic bodies are recursed into too:
  `echo $(( $(id) + 0 ))` still blocks, and single quotes do not hide the
  substitution there (`echo $(( '$(id)' ))` blocks too) — bash treats the
  arithmetic body as an expansion context. The whole command is still tested
  against deny rules, so compound denies such as `curl … | sh` keep working.
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

Deny patterns differ between the stacks:

- pi: the deny fields are **regex**. The engine compiles a pattern
  case-insensitively and unanchored, so the shell-string rules use a
  start-of-segment anchor: `^eval\b` and
  `^(?:/bin/)?(?:bash|sh|dash|zsh)\s+-c\b`. The engine splits compound commands
  and tests every segment and the raw pre-fold segments. Therefore
  `cd /x && eval y` still hits the `eval y` segment.
- opencode and kiro: the deny fields are **globs** (anchored). They match the
  exact prefix forms `bash -c *`, `sh -c *`, `dash -c *`, `zsh -c *`, and
  `*eval*`. A glob cannot express a word boundary or flexible whitespace. A
  command that misses these globs falls to the default of the stack (ask). It
  does not become a silent allow.

An `ask` rule is a manual override for calls the allow list does not cover (e.g.
`sudo`/`rm -rf` in the orchestrator or planner templates). Deny rules always win;
headless runs (subagent children, `-p`, `--mode json`) have no UI, so `ask` there is a
hard block.

An `ask` prompt offers three choices: **Deny**, **Allow once**, and **Always allow
this rule (session)**. Deny blocks the call ("Denied by user"). Allow once grants
exactly that single call, including a rule whose pattern spans a separator. Always
allow remembers the `agent|tool|rule` for the rest of the session — **in-memory only,
nothing is persisted to disk** (a persistent always-allow list is a future decision).
The ask prompt is a highlighted panel in TUI mode and a plain selector otherwise. It
shows the full command and highlights the blocked part (the plain fallback marks it
with brackets), shows the rule's human `reason` as "Why:", and never the raw regex.
For a compound command, a segment always-allow also approves exactly the matching
segment and re-evaluates the remaining segments; it never grants a different segment
(an unallowed remaining segment blocks the whole command). The whole-command ask probe
runs FIRST on the first evaluation pass, before the per-segment asks, so a rule whose
pattern spans a separator is always shown once — even when a per-segment ask would
match first or a session-allowed segment exists. The panel notes that the rule spans
the whole command and highlights nothing. A spanning allow-once runs the call once. A
spanning always-allow runs the current call and remembers the rule, approving no
segment; later calls skip the spanning ask, but they still must pass the allow checks,
so deny-by-default can still block them.

**Git writes now ask**: the orchestrator's `git add`, `git commit`, `git push`,
`git pull`, and every `gh pr` and `gh release` command moved to its `ask` list — each one prompts
allow/deny in the main session instead of running silently. The implementer gets a
hard DENY for the same commands. It may only SUGGEST a commit. Since a write is an
`ask` rule and ask is a hard block without a UI, **headless orchestrator runs
(delegated/`-p`/`--mode json`) cannot commit**. The global file
`~/.pi/agent/permissions.json` is live and unversioned; it carries a global ask for
push/pull and `gh pr` as a safety net.

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

## Nested subagents and the live sidebar

The extension caps agent nesting at 3 levels: 0 (the root), 1, and 2. A level-2
agent cannot spawn.

The primary control is the parent `--tools` strip. When a child would be at the
cap, the parent removes `subagent` from the child's `--tools` list. pi locks the
tool set at process start, so the child never receives the tool.
`PI_AGENT_DEPTH` carries the depth, and the child self-guard refuses a stale
spawn.

The cap is NOT a security boundary. All pi processes have the same OS privilege.
A child with an allowed interpreter can run `pi -ne …` with a forged
`PI_AGENT_DEPTH`. That bypasses every in-process guard. Only OS isolation — a
separate user, a container, or a sandbox — is a true boundary. OS isolation is
OUT OF SCOPE for this feature. The `--tools` strip stops the normal path only.

The sidebar owns the right column. It paints FIVE panels:

1. AGENTS — the live agent tree.
2. SESSION — model, thinking level, context use, cost, and tokens per second.
3. WORKSPACE — cwd, git branch, and the changed-file count.
4. MCP — configured servers and an inferred connection dot.
5. TODOS — the `todo` tool's list.

The tree is the only cross-process panel. Every other panel shows the root
process's data. `pi.events` is process-local, so a child's session, MCP, and todo
data is not visible to the root sidebar.

The tree comes from a shared append-only NDJSON log. The root creates the log in
`os.tmpdir()`, unique per root. The root compacts the log when it grows past the
cap. Each spawned process appends the records of its own children.

MCP fidelity is reduced. The built-in `pi.getMcpServers()` returns config only,
with no live connection state. The panel infers `connected` from the tool names
in `getAllTools()` (`mcp__<server>__<tool>`).

### The `todo` tool

pi has no built-in todo tool, so the extension ships one. Actions: `list`,
`add` (text), `toggle` (id), `remove` (id), `clear`. State lives in session
entries, with an in-memory cache. Each change publishes the
`persona-agents/todos/v1` event for the TODOS panel.

These agents may call `todo`: orchestrator, planner, implementer, tester,
researcher, reviewer. Mascot and overseer are excluded. Each allowed agent lists
`todo` in `tools:` and has a `{ tool: todo, match: "." }` allow rule.

### Commands

- `/sidebar [on|off]` — show or hide the right column. A bare `/sidebar` toggles.
- `/agents-tree` — open the live tree overlay. Up/down selects a node.
- `/agent-inspect [runId|last]` — open one node's detail.

The sidebar has no keyboard focus, so node details use these overlays.

### Turn `pi-sidebar-tui` off

The extension ships its own compositor. Turn the third-party `pi-sidebar-tui`
package OFF, or the two sidebars collide. Do not edit the operator's settings
from this repo. Use one of these operator steps:

1. Run `/sidebar-tui off` in pi. This persists to
   `~/.pi/agent/sidebar-tui.json`.
2. Remove `"npm:pi-sidebar-tui"` from the `packages` array in
   `~/.pi/agent/settings.json`.

`pi-sidebar-tui` is a package, not a built-in. `pi config` does not list it under
Built-in.

### Clean room

The compositor is a clean-room re-implementation of the technique: narrow
`terminal.columns`, wrap `tui.doRender`, and paint a right column. No upstream
code was copied. The upstream package declares the MIT license, but its npm
tarball ships no `LICENSE` file.

## Editable agent-notes zones

Per the kiro/opencode templates' `edit`/`external_directory` allows, each profession may
freely edit its own `~/agent-notes` zones (the gate allows them; everything else stays
denied-by-default):

| Agent | Zones (edit + write) |
|---|---|
| orchestrator | `agent-notes/orchestrator/**`, `agent-notes/project-notes/**` |
| planner | `agent-notes/project-notes/**` |
| overseer | `agent-notes/overseer/**` |
| researcher | `agent-notes/researcher/**` |
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