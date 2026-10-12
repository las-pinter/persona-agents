---
name: herdr
description: "Control Herdr, a terminal multiplexer for coding agents. The overseer reads this skill at startup. Other agents use it only when the user explicitly mentions Herdr or asks to use Herdr to inspect or control panes, tabs, workspaces, commands, or another agent. Do not use it merely because a task could benefit from a background terminal, delegation, or parallel work. Requires HERDR_ENV=1."
---

# Herdr

Herdr organizes terminals into workspaces, tabs, and panes. It recognizes
coding agents running inside panes and exposes the current session through the
`herdr` CLI.

Use this skill only when the user mentions Herdr or asks to control panes,
tabs, workspaces, commands, or another agent. Do not use it for background work.

## Gate: confirm the Herdr environment

Before any control command, verify that this agent runs inside a Herdr-managed
pane:

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, say that you are not running inside Herdr and stop. Do not
inspect or control the focused Herdr session from outside Herdr. When the check
passes, the `herdr` binary in `PATH` talks to the current session. Use it to
inspect, create layout, start agents and commands, read output, and wait for
state changes.

## Safety rules

- Use `--no-focus` for background work unless the user asked to switch context.
- Use `--current`, an explicit pane ID, or a unique agent name. Do not rely on
  another client's focused pane.
- Parse IDs from JSON responses. Do not derive them from sidebar order or
  examples.
- Do not close workspaces, tabs, panes, or sessions you did not create unless
  the user explicitly asked. `workspace close --group` closes the primary
  workspace and its linked worktree workspaces; never add it merely to bypass
  `workspace_group_close_required`.
- Use `--trust-repository` only after the user has verified the repository. It
  is not a routine retry for a failed worktree command.
- Client and server versions can differ after an update. Check `herdr status`
  before relying on new server features. A missing method is not permission to
  stop or upgrade a server.
- Never run `herdr server stop` from an active session unless the user intends
  to stop the server and its pane processes.
- Never kill the main Herdr process. Use named test sessions for experiments.
- Do not run bare `herdr` for discovery; it launches or attaches the TUI. Do
  not probe a mutating nested command by omitting arguments.

## Core procedure

Discover live IDs from JSON responses (`herdr workspace list`, `herdr pane
list`, `herdr agent list`). Read the pane ID from `.result.pane.pane_id`.

### 1. Self-name for herald discovery

The `overseer.herald` plugin matches the first live agent whose name contains
`overseer` (case-insensitive). An unnamed session still gets events logged but
cannot receive prompt pushes. After the agent is idle, verify the name and
rename when needed:

```bash
herdr agent get "$HERDR_PANE_ID"
herdr agent rename "$HERDR_PANE_ID" overseer
```

Rename only when the agent is idle; rename is blocked while startup is
pending. If `overseer` is already live, use an `overseer-*` variant such as
`overseer-01`; herald still matches it.

### 2. Open a sibling pane

Default to a sibling pane in the current tab and cwd. Do not create a
workspace, tab, worktree, or different cwd unless the user asks. Honor a
requested direction; otherwise split a wide pane right and a tall pane down.

```bash
herdr pane layout --pane "$HERDR_PANE_ID"
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

### 3. Start and prompt an agent

Start a supported agent in an available shell pane with a useful unique name:

```bash
herdr agent start <name> --kind <kind> --pane <pane-id>
herdr agent prompt <name> "Review the current diff and report only actionable findings." --wait --timeout 120000
```

Wait until the agent reports `idle` before prompting it. Read the result:

```bash
herdr agent get <name>
herdr agent read <name> --source recent-unwrapped --lines 120
```

If a wait fails or returns `blocked`, inspect `agent get` and `agent read`
before sending input. A timeout does not prove the prompt was not delivered.

### 4. Run an ordinary command

```bash
herdr pane run <pane-id> "just test"
herdr pane wait-output <pane-id> --match "test result" --timeout 120000
herdr pane read <pane-id> --source recent-unwrapped --lines 120
```

## References

Read the reference that matches the job. On a stack that does not auto-attach a
reference, read it with the shell: `cat references/<file>.md`.

- `references/cli.md` — command syntax, IDs, caller context, layout and agent
  lifecycle, output sources.
- `references/remote.md` — controlling a saved SSH machine with `--machine`.
- `references/pi-launch.md` — launching and binding a pi agent.
