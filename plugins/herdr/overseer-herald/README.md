# Overseer Herald (overseer.herald)

A **zero-configuration** herdr plugin that watches every agent pane and
reports meaningful status changes to your overseer — no config file, no
environment variables to set.

## What it does

On every `pane.agent_status_changed` event (delivered by herdr in
`HERDR_PLUGIN_EVENT_JSON`) it:

1. Watches **all** agent panes automatically. A pane is in scope whenever it
   has an `agent` or `display_agent`; the herald never needs to be told which
   panes to watch, and nothing is hardcoded.
2. Tracks the last-seen status per pane (`agent-state.tsv`) — herdr events do
   not carry the previous status, so the herald remembers it.
3. On a *meaningful transition* (`->blocked`, or `idle`/`done` from
   `working`) it takes three actions, in order:
   - appends a line to `events.log`,
   - shows a desktop notification,
   - pushes a one-line report to the overseer using herdr's native
     `herdr agent prompt` command (best-effort).

## Zero configuration

There is nothing to configure:

- no config file (no `herald.conf`),
- no operator environment variables,
- no hardcoded pane, agent, session, or theme ids.

The plugin watches every agent pane automatically and discovers its overseer
by naming convention (below).

## Finding the overseer (naming convention)

The overseer is never configured. On each meaningful event the herald runs
`herdr agent list` and uses the **first** agent (in array order) whose `name`
contains `overseer` (case-insensitive). It records that agent's `name` and
`pane_id` and pushes reports to that name.

- The overseer's **own** pane is the self-loop guard: its transitions only
  get an `events.log` line — no notification, no push — so the overseer is
  never interrupted by its own status changes.
- If no overseer-named agent exists (or discovery fails), the push is skipped
  entirely; logging and notifications still fire.

## Linking

This repo's `install.sh` installs the plugin automatically: it copies the
plugin to a stable location (`~/.local/share/herdr/plugins/overseer-herald`)
and registers it with `herdr plugin link`, enabled by default.

Do not link from a live repo or worktree path — stale links break when a
worktree is pruned; install.sh re-points them on every run. A manual dev link
is possible, but the next install re-points it. Plugin files refresh only with
--force; the registry re-point happens on every run.

## State directory

State lives in `$HERDR_PLUGIN_STATE_DIR` (injected by herdr for this plugin):

- `agent-state.tsv` — internal per-pane previous-status tracking
  (`pane_id<TAB>agent<TAB>display_agent<TAB>last_status`), rewritten
  atomically (temp file + `mv -f`) so concurrent events never tear it.
- `events.log` — append-only log of meaningful events:
  `<ISO UTC>, <pane_id>, <agent>, <old>-><new>`.

If `$HERDR_PLUGIN_STATE_DIR` is unset the herald prints one warning and exits;
it never writes anywhere else.

## Caveats

- Always exits 0 — it can never crash herdr, even on malformed input.
- No git commands; no writes outside the state directory.
- Notifications and the push are best-effort: on failure a single warning
  line goes to stderr and the script continues. A blocked overseer rejects
  pushes before input — those are ignored too.
- Timestamps are UTC (`date -u +%Y-%m-%dT%H:%M:%SZ`).