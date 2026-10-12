# Herdr CLI reference

The installed binary is the authority for command syntax. Read this reference
when the short procedure in `SKILL.md` does not give the command form you
need.

## Learn the current CLI

CLI server errors are JSON on stderr with exit status 1. CLI syntax errors
exit with status 2.

Start with `herdr --help`. Then print the relevant command group with no
subcommand:

```bash
herdr agent
herdr pane
herdr workspace
herdr tab
herdr worktree
herdr terminal
herdr notification
herdr integration
herdr session
herdr machine
```

Read the safety rules in `SKILL.md` before you run discovery commands.
Commands such as `herdr workspace create` are valid with defaults and will
execute.

Most control commands return JSON. Read identifiers and state from the
responses instead of predicting them.

## Layout, panes, and agents

Choose the primitive that matches the job:

- Workspace, tab, and pane topology organize terminal locations.
- Pane commands control raw terminals, shells, tests, servers, input, and
  output.
- Agent commands control the recognized coding agent currently occupying a
  pane.

A pane exists whether or not it contains an agent. `agent start` requires an
existing available shell pane and never creates, splits, or moves layout. Use
pane commands for ordinary processes. Use agent commands when Herdr must
validate agent identity or interpret `idle`, `working`, `blocked`, `done`, and
`unknown` lifecycle states.

Agent commands accept either a unique live agent name or the pane ID currently
hosting that agent. They do not accept terminal IDs or bare agent-kind labels.
Names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents. A
name follows the current pane occupant and is cleared when that agent exits,
is released, or is replaced.

`idle` and `done` both mean the agent is ready for input. The CLI/API uses the
server's seen state to distinguish them; explicit focus commands mark the
target seen, while reads do not. Each TUI client tracks viewed completions
independently, so its Done badge can differ from the CLI or another client's
badge. `blocked` means Herdr recognized an approval or question UI. `unknown`
means an agent is present but Herdr cannot classify it confidently; it does
not prove completion.

## IDs and caller context

Public IDs are opaque stable handles:

- workspace: `w1`
- tab: `w1:t1`
- pane: `w1:p1`

Closed tab and pane IDs are not reused. A pane moved into another workspace
receives a new workspace-qualified pane ID. After `pane move`, continue with
`.result.move_result.pane.pane_id` or the live agent name. The old value is
reported as `.result.move_result.previous_pane_id`; only the moved process's
inherited caller context keeps resolving that old ID, so do not use it as a
general agent target.

Herdr injects the caller's context into each managed pane:

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
```

Prefer `--current` when a pane command should target the calling pane. An
omitted `pane split` target uses the calling pane when `HERDR_PANE_ID` is
available, otherwise the focused pane. Other commands may use the UI-focused
pane, which can belong to the user or another client.

Discover live state with:

```bash
herdr workspace list
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
herdr pane current --current
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
herdr agent list
```

Creation responses expose the IDs to use next. `workspace create` returns
`.result.workspace`, `.result.tab`, and `.result.root_pane`. `tab create`
returns `.result.tab` and `.result.root_pane`. `pane split` returns the new
pane as `.result.pane`.

IDs and live agent names are scoped to one server. To control a saved SSH
machine, read `references/remote.md`.

## Start and coordinate an agent

An available shell pane must be at its interactive prompt, with the shell
itself in the foreground and no foreground command, editor, or agent running.
Start a supported agent in that pane with a useful unique name:

```bash
herdr agent start reviewer --kind codex --pane <returned-pane-id>
```

Use the kind requested by the user. Run `herdr agent` to inspect the installed
kind list and options. Pass native agent arguments only after `--`, and only
for kinds that accept them:

```bash
herdr agent start reviewer --kind codex --pane <returned-pane-id> -- <agent-args...>
```

The opencode kind deploys a plain full TUI and takes no agent arguments.
Top-level `opencode` does not accept `--agent` (unrecognized flag), and
`opencode mini --agent ...` is forbidden for agent deployments under herdr.
Select the agent persona inside the TUI after the agent is idle:

```bash
herdr agent start <name> --kind opencode --pane <pane-id>
```

Wait until the TUI is ready and the agent reports idle. Open the agent list
in-TUI by sending the leader key (default `ctrl+x`) followed by `a`
(`agent.list`):

```bash
herdr agent send-keys <name> ctrl+x
herdr agent send-keys <name> a
```

Type the agent-name filter text (for example `<theme>-orchestrator`):

```bash
herdr pane send-text <pane-id> '<theme>-orchestrator'
```

Press enter to confirm the selection (`dialog.select.submit`):

```bash
herdr agent send-keys <name> enter
```

The agent now runs under the selected persona; verify via the status line if
possible.

A successful `agent start` returns only after Herdr detects the expected agent
in the same pane and considers it ready for interactive input. If the agent is
blocked during startup, the command returns `agent_not_ready` immediately but
keeps the name available for `agent read` and `agent send-keys`. Wait until
the agent becomes idle before prompting it. Startup defaults to a 30-second
timeout.

### Prompt and wait

Submit work through the agent surface:

```bash
herdr agent prompt reviewer "Review the current diff and report only actionable findings." --wait --timeout 120000
```

`agent prompt` honors the pane's live bracketed-paste mode and sends text
followed by encoded Enter as one ordered submission. It reports successful
submission only after both have been written; that alone does not prove the
agent started a turn. For Codex on Windows, Herdr sends a paste boundary
before Enter so submission does not depend on prompt size. It rejects an agent
already waiting at an approval or question dialog with `agent_blocked` before
sending any input. Inspect the blocked UI and ask the user before answering
it. For normal agent work, `--wait` is enough: it waits for the first settled
`idle`, `done`, or `blocked` state. Do not repeat those defaults with
`--until`.

With `--wait`, a prompt sent from a non-working state must produce observed
`working` or `blocked` activity. After submission, Herdr waits up to five
seconds for that activity; unrelated `idle`, `done`, or session changes do not
satisfy this gate. It returns `agent_prompt_stalled` if no activity is
observed, or `timeout` if the caller's timeout expires first. The caller
timeout includes submission time. Without a timeout, the settled-state wait is
indefinite after activity is observed. This wait tracks lifecycle state, not
an individual turn; if the agent is already working, completion of the active
turn may satisfy it.

Use `--until` only for a state-specific workflow, such as waiting for an
already-running agent to request input:

```bash
herdr agent wait reviewer --until blocked --timeout 120000
```

Without `--until`, standalone `agent wait` uses the same settled-state defaults
as `agent prompt --wait`.

Use logical keys for interactive agent UI controls:

```bash
herdr agent send-keys reviewer esc
herdr agent send-keys reviewer ctrl+c
```

Herdr validates all keys before writing any bytes. Read the result through the
resolved agent:

```bash
herdr agent get reviewer
herdr agent read reviewer --source recent-unwrapped --lines 120
```

If a wait fails or returns `blocked`, inspect `agent get` and `agent read`
before deciding what input to send. A timeout or stalled response does not
prove the prompt was never delivered; do not blindly submit it again. Use the
pane surface only when raw terminal control is intentional.

## Run an ordinary command

Create a sibling pane with the same geometry rule, preserve the caller's
working directory, and keep user focus unchanged:

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

Read the new pane ID from `.result.pane.pane_id`, then run and inspect the
command:

```bash
herdr pane run <returned-pane-id> "just test"
herdr pane wait-output <returned-pane-id> --match "test result" --timeout 120000
herdr pane read <returned-pane-id> --source recent-unwrapped --lines 120
```

`pane run` atomically sends command text and Enter. `pane wait-output` searches
the selected snapshot immediately, so output that already exists can match.
Use `--match <text>` for a literal substring or `--regex <pattern>` for a Rust
regular expression. Omitting `--timeout` allows an indefinite wait.

Use the read source that matches the task:

- `visible`: the currently rendered viewport.
- `recent`: recent rendered output, including soft wraps.
- `recent-unwrapped`: recent output with soft wraps joined; prefer it for logs
  and transcripts.
- `detection`: the plain-text bottom-buffer snapshot used for agent detection.

Use `--format ansi` when colors and terminal styling are evidence. Otherwise
use text.

`--lines` asks Herdr for more rows from the pane's available screen and host
scrollback. Alternate-screen rows do not enter ordinary host scrollback. For
supported idle agents, Herdr can collect application-owned history and restore
the viewport afterward, but not every application or response can be recovered
this way.

If a larger recent read still does not reveal the completed response, ask the
agent to write it as Markdown in a temporary directory and reply only with the
file path, then read that file on the same machine. Use this only as a
fallback; do not request file output in the initial prompt.
