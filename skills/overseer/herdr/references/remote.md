# Herdr remote-machine reference

Read this reference when the user asks to control an agent on a saved SSH
machine. IDs and live agent names are scoped to one server. Two saved SSH
machines can both have `w1:p1` or an agent named `reviewer`. Selecting a
machine in the TUI does not retarget commands running in your pane: without
`--machine`, they still use the inherited session and socket context.

To control a saved SSH machine, use the same global prefix for discovery and
every later command:

```bash
herdr --machine <label-or-id> agent list
herdr --machine <label-or-id> pane list
herdr --machine <label-or-id> agent prompt <remote-agent-name> "Reply with your current status." --wait --timeout 120000
```

The selector must be an enabled saved profile ID or a unique, case-sensitive
label, not an arbitrary SSH hostname. Commands use that profile's remote
session without an open TUI. Do not combine `--machine` with `--session` or
`--remote`. Discover IDs on that machine; inherited local IDs and `--current`
do not identify remote panes.

Both installations must support machine API forwarding, and the remote server
must already be running and API-compatible. Forwarding never installs, starts,
or restarts a server and never falls back to Local. Local configuration,
session management, installation commands, and interactive attachment are not
forwarded. Remote worktree paths must be absolute, `~`, or start with `~/`;
plugin link paths must be absolute. A connection failure does not prove a
mutation was not applied: inspect remote state before retrying.

`herdr machine list` lists saved connection profiles, not a cross-machine pane
inventory; add `--json` for scripts. Only add, remove, enable, or disable
profiles when the user asks. Removing a profile disconnects the client but
does not stop remote sessions. Adding a machine uses the remote default
session unless `--remote-session` is explicitly supplied. Setup asks before
stopping an incompatible server and defaults to No; do not approve replacement
without the user's consent. Experimental handoff is not part of `machine add`.
