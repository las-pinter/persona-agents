# persona-agents — the pi extension

One extension, one entry: `extension/extension.ts`. Internally modular (every
module below lives in `extension/`, except the shipped table data file):

| Module | Responsibility |
|---|---|
| `extension.ts` | Entry point: wires gate, commands, subagent tool, session hooks |
| `resolver.ts` | Discovers agents + personas from user (`~/.pi/agent`), project (`.pi/`), and this package. Package agents are `platforms/pi/frontmatters/<profession>.yaml` composed with `content/professions/<profession>.md`; `platforms/pi/agents/` is an optional override folder |
| `permissions.ts` | Tool-call gate: compiles the rule table once, appends the live `permissions.json` overlay, and resolves the class from the active agent (deny → ask → allow → default) |
| `../permissions.table.json` | The shipped default rows: data only, one row per rule and per class |
| `permission-config.ts` | The layer loader: shipped default, user override, global overlay, layer stamp, fail-closed fence |
| `permissions.table.ts` | A typed test view of the default rows; the gate never imports it |
| `permission-table.ts` | The compiler: row to one anchored pattern, then the five rule sets the engine reads |
| `permission-prompt.ts` | Ask prompt model and renderer: highlighted panel in TUI mode, plain selector otherwise |
| `command-segments.ts` | Pure (no pi imports) shell splitter + rule-decision core used by `permissions.ts`; testable under plain Node |
| `state.ts` | Active agent/persona state; reads session defaults from `~/.pi/agent/settings.json` and `PI_DEFAULT_*` env (never writes) |
| `commands.ts` | `/agents [name|off] [-persona id\|off]`, `/persona`, `/skills` slash commands |
| `subagent.ts` | Spawn-based subagent tool (single / parallel / chain), ported from the legacy extension |
| `subagent-schema.ts` | TypeBox schema for the `subagent` tool arguments |
| `subagent-run.ts` | Spawns one `pi` child per run and parses its JSON stdout lines |
| `subagent-result.ts` | Result types with the output, usage, and truncation helpers |
| `subagent-render.ts` | Tool call and result renderers for single, parallel, and chain runs |
| `subagent-thinking.ts` | Per-run thinking timing and the thinking indicator lines |
| `subagent-tree.ts` | Writes each child run's start, update, and end records to the tree log |
| `inspector.ts` | Subagent run archive + `/runs` + full-screen `/inspect` |
| `depth.ts` | Pure nesting-depth helpers: 3-level cap (0, 1, 2), env parse, parent `--tools` strip, run-id allocation |
| `tree-log.ts` | Shared append-only NDJSON tree log: byte cap, tolerant reader, root-only rotation |
| `tree-model.ts` | Pure fold of tree-log records into a `TreeNode` forest (links, orphans, stale marks) |
| `sidebar-render.ts` | Pure five-panel renderers (AGENTS, SESSION, WORKSPACE, MCP, TODOS) |
| `mcp-usage.ts` | Pure MCP usage helpers: per-server counts, child counter, session tally |
| `sidebar-data.ts` | Impure snapshot collector: subscribes once to pi events, owns the polls and the TPS window |
| `sidebar.ts` | Right-column compositor (clean-room) and the `/sidebar` toggle config |
| `tree-ui.ts` | Sidebar glue: binds compositor, data, commands, and lifecycle; reads the git branch |
| `todo-tool.ts` | `todo` tool: session-entry state, registration, and the `persona-agents/todos/v1` event |
| `status-text.ts` | Dims footer status text in TUI mode, with a plain-text fallback |
| `duration.ts` | Shared display formatting for durations and token counts |

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
`pi remove <source>`, and reconcile a clone after a new tag with
`pi update --extensions`. Install only **one** source per package. Remove the
other source with `pi remove <source>` before you install this one. A local
path and a git clone of the same repo both register the extension, and pi
reports the duplicate as tools/commands/flags conflicts.

## Agent files

Agents are **modular**, mirroring the opencode split:

- frontmatter (pi schema) → `platforms/pi/frontmatters/<name>.yaml`
- body → `content/professions/<name>.md` (single source of truth, shared with kiro/opencode)

The resolver composes them at load time (`parseFrontmatter` wraps the bare YAML,
so no extra YAML dependency is needed). No generated files, no drift: edit the
profession, add a template for a new profession, and it appears in `/agents`
immediately. All 7 professions ship pi templates; a profession without a
frontmatter template is simply not exposed as a pi agent.

The pi templates were translated from `platforms/opencode/frontmatters`
(shared permission intent, pi-native schema). The opencode `action/resource/effect`
triples informed the pi rule rows; the rows live in `permissions.table.json` and the
compiler writes the pattern. Translation notes:

- opencode `action/resource/effect` triples became pi rule rows: one row per
  rule and class, with like-commands combined in one verb list (e.g. all read-only
  git variants, the python/tsc toolchain, the read-only viewers). The row
  carries words, not a regex; `permission-table.ts` compiles the pattern.
- opencode's default `ask` for core actions (e.g. `edit` for implementer/tester)
  becomes `allow`: headless subagents block on confirm prompts, so their raison
  d'être would be unusable. `deny` rows keep the hard blocks (push/pull for
  non-orchestrators,
  `find -exec/-execdir/-delete/-ok/-okdir/-fls/-fprint(0|f)`, `curl|sh`,
  `rm -r/-R/-rf/-fr/--recursive`, `sudo`, mkfs/dd).
- The bash redirection deny tests the operator itself: any `>` or `>>` is a
  write and denies, whatever character precedes it. The only allowed form is
  file-descriptor duplication, a `>` followed by an ampersand and one digit at
  the end of the command or before a separator (`2>&1`, `>&2`). The `tee` form
  also denies. A digit-leading target (`>1file`) is a write, not a duplication.
  A `>` inside a quoted literal over-denies; the fail-closed choice is kept.
- The `cd X && …` / `git -C X …` forms (pi permits the first token only) are
  folded into the allow regexes so delegates don't get stuck on command
  prefixes. The verification and build rows carry no fold, so a moved test or
  build command falls to the mode default. The `-C` value must be a path: a
  value with a quote, a backslash, no slash and no `.git` ending, or an equals
  sign and no leading `/`, `./`, `../`, or `~` is not a path, and the form asks
  for the orchestrator because the engine matches `-c` and `-C` alike. A
  leading `cd X` before any separator folds the segment to `cd X && …`, so a
  `cd X || sudo true` line is rewritten to `cd X && sudo true` for allow
  matching. The fold is lossy for allow only:
  the raw pre-fold segments stay in the deny and ask probes, so an anchored
  deny such as `^sudo\b` still blocks `cd X || sudo true`.
- Compound commands are enforced per segment: `echo hi && id`, `a; b`, and pipe
  chains are split on unquoted control operators and **every** segment must be
  allowed. The `cd X && …` fold above is what keeps the git regexes valid. A
  disallowed segment blocks the whole command. Heredocs (`<<`, `<<<`), ANSI-C
  quoting (`$'...'`), unbalanced quotes, and dangling operators fail closed. See
  `extension/command-segments.ts`.
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
| `spawnable` | boolean | optional — `false` marks the agent as **not dispatchable as a subagent**: the `subagent` tool rejects it (alias or direct name) before spawning. Defaults to `true`. Use the **unquoted boolean** (`spawnable: false`); the resolver also treats a quoted `"false"` string as disabled, but the boolean is the documented form. The `orchestrator` template ships `spawnable: false` |
| `tools` | string[] | tool-name allowlist for subagent spawns (`--tools`) |
| `model` | string | optional `provider/model` override for subagent spawns |
| `persona` | string | default persona reference: `theme/name`, `name`, or `theme` |
| `skills` | string[] | glob bindings to skills under `content/skills/` (package), `~/.pi/agent/skills/` (user), and `.pi/skills/` (project). `"orchestrator/*"` matches every skill in the orchestrator group; each matched skill is injected as an on-demand index entry (name, description, path) and the agent reads the `SKILL.md` when the task matches |
| `alwaysLoad` | string[] | skills **guaranteed** injected into the prompt at startup as `## Mandatory skill: <id>` blocks. The whole body is always injected, whatever its size and whatever the running total: an over-threshold body or an over-budget total writes no warning; the measured total, cap, and budget go to the debug log when it is enabled. A pattern that resolves to no skill logs `console.warn` and leaves `MISSING skill for alwaysLoad entry: …` in the prompt — never silent. Overlap with `skills:` is deduped (alwaysLoad wins) |
| `resources` | string[] | file globs relative to the session cwd (`!` = exclude). Small files are inlined (≤4 KiB), larger ones listed as paths (≤32 KiB total, ≤8 dir depth, skips `.git`/`node_modules`/…) |
| `permissionClass` | string | permission fence class: `reader`, `worker`, or `orchestrator`. A template this repository ships must name one. A user or project agent file may omit it, and a blank value counts as omitted: it loads as `reader`. A user or project file that names a class above `reader` is clamped to `reader` with one warning that names the file. An unknown value throws, and discovery then logs one line while the permission gate still installs |

Note: `description` is required; `name` defaults to the template filename.

## Permission model

No rule list lives in an agent file. `permissionClass` names the class, and the
gate reads one compiled table:

| File | Role |
|---|---|
| `permissions.table.json` | the shipped default rows: data only, one row per rule and per class |
| `permission-config.ts` | the layer loader: default, override, overlay; row-id patch; layer stamp |
| `permission-table.ts` | the compiler: row to one anchored pattern, five rule sets |
| `permissions.ts` | loads the three layers once at factory time and gates each tool call |
| `command-segments.ts` | the parse and decision core, unchanged |

- **Three classes.** `reader` is the planner, the reviewer, the researcher, and
the mascot. `worker` is the implementer and the tester. `orchestrator` is the
orchestrator. The gate takes the role from the resolved agent name and requires
its `permissionClass` to match that role. A name that is not a shipped profession,
or a class that disagrees with the role map, gets its class rule set with no notes
write zone. A user or project file always gets its class rule set and never a
profession's notes zone, even when its name matches a profession.
- **A row is data in three layers.** The shipped default
`platforms/pi/permissions.table.json` is the source of truth: `{ "version": 1,
"rows": [...] }`, one row per rule and per class. A user override at
`~/.pi/agent/permissions.table.json` has the shape `{ "version": 1, "patch":
[...] }` and patches rows by row id: it changes a verdict, disables a row, or
supplies a complete row (a new id adds one row). A complete row for an existing
id must keep that id's class list. One short entry:

  ```json
  { "version": 1, "patch": [ { "id": "release.ask", "verdict": "deny" } ] }
  ```

  The global `permissions.json` stays the third layer and keeps its shape. Every
compiled row records its layer: `default`, `override`, or `overlay`.
`PI_PERMISSIONS_TABLE` and `PI_PERMISSIONS_TABLE_OVERRIDE` set the two table
paths for a test.
- **A row carries no pattern.** A row carries an id, a tool, a verdict, its
classes, plain geometry words, and a one-line reason. The compiler writes every
wrapper, `cd` fold, git option slot, option ladder, path zone, and probe shape,
so one ladder has one home.
- **No project-level table.** The default path resolves from the extension file,
and the override and overlay paths resolve from the home agent folder. The loader
never reads a table from the working directory or a repository path. A configured
table or override path must be absolute, and its real path is checked, so a
relative path and a symlink into a repository are refused. The refusal logs one
line and the shipped default stays in force.
- **A broken layer fails closed.** A parse error, a schema error, an unknown row
id, or an unknown field logs one line that names the file and the row id. The
gate then carries a deny-all fence, so no tool call runs until the file is fixed.
A malformed `permissions.json` behaves the same way.
- **Precedence.** global deny → class deny → a spanning ask (global row first,
then class row) → a per-segment ask (global row first, then class row) → class
allow → the `deny-by-default` default. Deny wins over ask, ask wins over allow,
and every segment of a compound command must pass.
- **Write zones** come from the resolved role: the session cwd, the role's
`agent-notes` folders, and `/tmp` allow; a parent segment, a home path, and any
other absolute path ask. See `## Editable write zones`.
- **The overlay is optional.** The live file `~/.pi/agent/permissions.json` is
unversioned local policy. Its `deny` and `ask` rows are appended after the table's
global rows at factory time. The table already carries the 17 entries that file
used to hold.
- `/reload` re-runs the factory, so an edited table, override, or overlay is read
again.

### Table doctrine

- **Row groups.** The shipped file holds 85 rows: 22 global, 14 reader, 22
  worker, and 27 orchestrator. A class resolves to 36 reader, 44 worker, or 49
  orchestrator rows.
- **Fences.** A deny row that names an option requires that option, so the bare
  command stays untouched. `find` denies on `-exec`, `-fls`, and the `-fprint`
  forms. `git tag` denies a short or long delete form at every abbreviation.
  `rg` denies the preprocessor and decompressor options, and `date` denies `-s`.
  The git diff family denies `--output`, `--ext-diff`, `--textconv`, and
  `--filters` at every unique abbreviation. The family names `annotate`, so the
  verb a read row allows is fenced too. A stream write (`>` and `tee`) denies for
  every class, because it leaves the write zone. `git fetch` denies a
  colon-shaped refspec for a reader or a worker, and a plain `git fetch` asks for
  a worker only. `dd` denies only with a device write, so a plain copy runs.
  `git branch` is one read row with a listing-only tail: a branch write form falls
  outside the tail and reaches deny-by-default, so no class can create, move, or
  delete a branch through the read row.
- **File removal.** A single named `rm` asks for the orchestrator and the
  implementer. It is denied to every other class. The `-f`, `--force`, and
  multi-name forms ask the same way. A recursive form (`-r`, `-rf`, `-fr`,
  `--recursive`) stays a hard deny for every class. `git rm` carries the same
  rule.
- **Deliberately omitted commands.** The shared read rows omit `xxd`, `printf`,
  `sha256sum`, `mktemp`, `test`, `mdl`, and a `.venv/bin/<tool>` wrapper, so
  deny-by-default blocks them. They also omit `git remote`, `git reflog`,
  `git config`, `git grep`, `git cat-file`, `git ls-remote`, `git fetch`,
  `git hash-object`, and `git fsck`. A build or test runner is not a read-only
  probe: the reader toolchain row names version and metadata probes only, so no
  reader class runs a test.
- **Recorded narrowings.** `printf`, `sha256sum`, `test`, and `mdl` reach a
  worker in the legacy frontmatter only. The three write-shaped read verbs
  `mkdir`, `sort`, and `uniq` ride the orchestrator's own journal row only.

An `ask` row prompts with three choices: **Allow once**, **Always allow this rule
(session)**, and **Deny**. Deny blocks the call ("Denied by user"). Allow once grants
exactly that single call, including a rule whose pattern spans a separator. Always
allow remembers the `agent|tool|rule` for the rest of the session — **in-memory only,
nothing is persisted to disk** (a persistent always-allow list is a future decision).
The ask prompt is a highlighted panel in TUI mode and a plain selector otherwise. It
shows the full command and highlights the blocked part (the plain fallback marks it
with brackets), shows the rule's human `reason` as "Why:", and never a pattern.
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

A run with no UI (`-p`, `--mode json`) has no surface to draw a prompt on, so an
ask there fails closed with no prompt. A child ask does not fail closed while
its root is live. The child enqueues the request in `child-ask.ts`, and the root
renders the shared prompt on the surface its own gate captured, so the owner's
answer becomes the child's verdict. One child request is on screen at a time,
and its title names the child and the waiting count. The root's own inline ask
is separate, so it can mount beside a child prompt. `AGENTS.md` records the
accepted risk that the two panels stack. The deadline counts from arrival, so a
request that waits behind another prompt can still time out. A stranded request
leaves the queue and blocks with a reason that names the 120 second deadline. A
root with no captured surface renders nothing, so its child blocks at once.
`AGENTS.md` owns the doctrine.

The table is a pi mechanism. Kiro and opencode keep their glob rule files, so a
rule that misses a glob there falls to that stack's default (ask). On pi a form
that no row names falls to `deny-by-default`, so it blocks. A session with no
active agent runs under `allow-unless-matched` with only the global rows.

**Git writes**: `AGENTS.md` owns the history doctrine, the forms that still
ask, and the accepted-risk list. The pi mapping allows the six history
commands also with `git -C <path>`, `--no-pager`, `-p`, and a leading
`cd x &&`.

**Headless orchestrator runs (delegated/`-p`/`--mode json`) can run a plain
commit**, but a commit in an exception form still blocks, for example a message
with a question mark or a bracket. Headless runs cannot push, open a pull
request, or release.

Gate scope: only `bash`/`powershell` (command), `read`/`grep`/`find`/`ls`/`edit`/`write`
(path/pattern), and other plain tools (JSON args) are probed. `mcp__…` and namespaced
tools are never gated (translation note above).

## Skills and resources

An agent's frontmatter `alwaysLoad:` and `skills:` are resolved at `before_agent_start`
and injected into that agent's system prompt (`alwaysLoad` first, then the skill index,
then resources, then persona on top). `alwaysLoad` carries the guaranteed full-body
contract: the skill body is always injected whole, missing skills warn loudly, and a
skill in both lists is injected once by the shared dedup set (`alwaysLoad` wins). A body
over the injection budgets is still injected whole, and nothing is cut. `skills:` injects
an on-demand index instead — one entry per matched skill with its name, description, and
path, plus a line telling the agent to read the file when the task matches. No skill body
loads until the agent reads the file. `discoverSkills()` understands both this repo's
`content/skills/<group>/<name>/SKILL.md` layout and pi's `skills/<name>/SKILL.md`;
`/skills [agent]` lists the matched skills.

### Skill injection budgets

Two settings measure when the mandatory skills get large. They are size markers only:
they never cut, drop, or warn. Each value is a byte count. The measure is UTF-8 bytes, so
a multi-byte character counts as its encoded size. A body over a limit is injected whole,
and the measured sizes go to the debug log only. Set a key in
`~/.pi/agent/settings.json` or in a project `.pi/settings.json`, then run `/reload`. A
project `.pi/settings.json` is read only when the project is trusted:

```json
{
  "skillInjectionBudgetBytes": 24576,
  "skillBodyCapBytes": 12288
}
```

| Setting | Default | Meaning |
|---|---|---|
| `skillInjectionBudgetBytes` | `24576` (24 KB) | Total bytes of mandatory skill bodies in one prompt. The bodies still inject whole. The debug log records the running total, the cap, and this budget when it is enabled. Nothing is cut and no warning is logged. |
| `skillBodyCapBytes` | `12288` (12 KB) | Per-skill size marker. A body over this limit is injected whole. The debug log records the running total, this cap, and the budget when it is enabled. Nothing is cut and no warning is logged. |

The cost does not end at startup. An over-budget skill is injected on every prompt for
the whole session, so every turn pays for it. The only way to remove the cost is to
shrink the skill.

A missing key, a wrong type, a negative number, or a non-finite number falls back to the
default. Both values are read on every `before_agent_start`, so `/reload` picks up a
change.

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
4. MCP — configured servers, an inferred connection dot, a per-server `xN`
   use count, and a `total xN` line.
5. TODOS — the `todo` tool's list.

The tree and the MCP counts are cross-process. The SESSION, WORKSPACE, and
TODOS panels show the root process's data only. `pi.events` is process-local,
so a child's session and todo data is not visible to the root sidebar. The
root counts its own MCP tool starts and folds each child's counts through the
tree log into one session tally.

The tree comes from a shared append-only NDJSON log. The root creates the log in
`os.tmpdir()`, unique per root. The root compacts the log when it grows past the
cap. Each spawned process appends the records of its own children.

MCP fidelity is reduced. The built-in `pi.getMcpServers()` returns config only,
with no live connection state. The panel infers `connected` from the tool names
in `getAllTools()` (`mcp__<server>__<tool>`). The count for one server is its
MCP tool starts: the root's own starts plus every child's, folded from the tree
log. A repeated call id counts once. The total sums every server that has a
count, including the rows beyond the visible cap.

### The `todo` tool

pi has no built-in todo tool, so the extension ships one. Actions: `list`,
`add` (text), `toggle` (id), `remove` (id), `clear`. State lives in session
entries, with an in-memory cache. Each change publishes the
`persona-agents/todos/v1` event for the TODOS panel.

These agents may call `todo`: orchestrator, planner, implementer, tester,
researcher, reviewer. Mascot is excluded. Each allowed agent lists
`todo` in `tools:` and has a `{ tool: todo, match: "." }` allow rule.

### Commands

- `/sidebar [on|off|width <n>]` — show or hide the right column, or set its width (10 to 120). A bare `/sidebar` toggles.
- `/agents-tree` — open the live tree overlay. Up/down selects a node.
- `/agent-inspect [runId|last]` — open one node's detail.
- `/retro` — print-only blameless session retrospective; run `/reload` after install. The command name for each platform is in [content/skills/common/retro/SKILL.md](../../content/skills/common/retro/SKILL.md).

The retro skill sets `disable-model-invocation: true`, so only the user starts
it. The pi agents list `common/retro` in `skills:`. The extension puts a skill
with that key in a separate "User-invoked skills" list, not in the on-demand
index. The agent has the path for the command but does not load the skill on a
task match. A command file in `content/commands/` ships through the
`pi.prompts` key in `package.json`. Run `/reload` after a change.

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

## Editable write zones

Each profession's write zone comes from the table rows for its role, not from a
list in its agent file:

| Agent | Zones (edit + write) |
|---|---|
| orchestrator | the session working directory, any `agent-notes/**` path, and `/tmp/**`; any other path asks |
| planner | `agent-notes/planner/**` and `agent-notes/project-notes/**` |
| researcher | `agent-notes/researcher/**` |
| reviewer | `agent-notes/reviewer/**` |
| implementer | the session working directory, `agent-notes/implementer/**`, and `/tmp/**` |
| tester | the session working directory, `agent-notes/tester/**`, and `/tmp/**` |
| mascot | none (read-only) |

Any other path asks for the worker and the orchestrator, and a reader denies
it. On pi the engine cannot resolve a path against the working directory, so
the rows name the path forms directly. A
relative path with no parent segment allows: it is the repository under the
session working directory. A
path with a parent segment asks, a home-relative (`~`) path asks, and any other
absolute path asks. Two exceptions allow. The first is an absolute path that
holds an `agent-notes` segment and no parent segment, because the notes tree
sits outside the working directory. The second is `/tmp` and every path under
it that carries no parent segment, for the `edit` tool and the `write` tool.
Residual for the first: that
exception cannot be anchored to one home folder, so any absolute path with an
`agent-notes` segment allows. Residual for the second: the gate compares the
raw path string. It does not resolve a symbolic link, and it does not read the
link target. A planted link under `/tmp` can reach any path. The owner accepted
this risk.

## Personas and themes

Personas are `content/personas/<theme>/<name>.md` — **legacy files work as-is** (plain markdown,
no frontmatter): name = filename, theme = folder, description = first heading. The persona
body is appended after the agent prompt on each run; personas never grant permissions.

**Theme ↔ profession mapping**: `content/agents.json` connects themes and professions to personas
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
  active agent, the gate applies that agent's class rule set there too.
