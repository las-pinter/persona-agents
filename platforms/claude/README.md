# Claude Code plugin internals

This file describes how the plugin is built, for maintainers. The root
[README.md](../../README.md) covers install and use.

## Layout

The repo root is the plugin (`.claude-plugin/plugin.json`) and its own
marketplace (`.claude-plugin/marketplace.json`). The plugin copies no content.

- **Agents** (`platforms/claude/agents/`):
  - `companion.md` holds frontmatter only. The body stays empty on purpose: a
    body replaces the Claude Code system prompt when the agent runs as the main
    session. The instructions come from the context hook instead.
  - `reviewer.md` is a subagent wrapper: its body points at
    `content/professions/reviewer.md`, the one home for the reviewer rules and
    output format, and it has no Edit, Write, NotebookEdit, or Agent tool. The
    `review` skill (`content/skills/review/`, `context: fork`,
    `agent: persona-agents:reviewer`) starts it in the foreground.
- **Skills** load in place from `content/skills/<name>/`. `plugin.json` lists
  each skill folder; `tests/doc-lint.test.ts` keeps the list and the folders
  equal.
- **Settings snippet**: `platforms/claude/settings/recommended.json`, merged
  into the user `settings.json` by `install.sh`. A plugin cannot ship
  permission rules or env vars, so the snippet carries them: the compaction
  threshold, `~/agent-notes` access, and the publish asks.

## Hooks

`platforms/claude/hooks/hooks.json` wires every hook. Each script acts only
for its agent type and gives no output otherwise, so a plain `claude` session
is unchanged.

| Event | Script | Job |
|-------|--------|-----|
| SessionStart (all) | `context.mjs profession`, `context.mjs persona`, `context.mjs session` | The companion profession, the theme persona, and the session id, also after a compaction and on resume. Separate hooks, because Claude Code caps each hook string at 10,000 characters. |
| SessionStart (startup, clear) | `startup.mjs` | The read list: project rules and summary, the last three journal days, open session notes, unfinished studies. Paths only. |
| PreCompact | `compact.mjs pre` | Reads the transcript for the invoked skills (a `Skill` tool call or a typed `/persona-agents:<skill>` command) and the reference documents; finds the active session notes file by the session id on its `Sessions` line, then the last file written under `sessions/`, then the only open notes file; saves a reload manifest; prints the summary instructions; warns once when a non-empty transcript yields no tool calls. |
| PostCompact | `compact.mjs post` | Keeps the summary for the journal writer, appends a metrics line with the scan counts, and logs the compaction in the session notes. |
| SessionStart (compact) | `compact.mjs reload` | Sends the reload list. The profession requires the companion to work through it. |
| SessionEnd | `journal-end.mjs hook` | When the session has no journal entry, starts a detached writer (a small headless model run with no tools) and returns at once. |
| PreToolUse (Bash) | `doctrine.ts` | The commit doctrine (see below). |

State that is not a note lives in `$CLAUDE_PLUGIN_DATA/compact/`: the reload
manifests, the compaction summaries, and `metrics.ndjson` (one line per
compaction, with the transcript scan counts, for tuning the threshold).

`compact.mjs`, `startup.mjs`, and `journal-end.mjs` import the shared session
notes parser at `platforms/shared/notes/notes.ts`, so their hook entries pass
`--experimental-strip-types`; the minimum supported Node, 22.6, needs it.

The hooks that read the notes tree take a `--home=<path>` argument, and the
journal writer a `--claude=<path>` argument. These are test seams. They are
arguments, not env vars, because a project `settings.json` env block can set
an env var for every hook.

## Notes paths

`notes-paths.mjs` names the project after the folder that holds the
repository's shared git directory (`git rev-parse --git-common-dir`), so every
worktree of a repository shares one notes folder. Outside a repository the
project is `common`. The notes folder is
`<home>/agent-notes/project-notes/<project>/`.

`journal.mjs` gives a session its entry path,
`journal/<YYYY-MM-DD>/<HHMM>-<session>.md`, and reuses the session's entry from
today or yesterday. The `wrap-up` skill calls it with the session id from the
`${CLAUDE_SESSION_ID}` substitution.

## Doctrine

`doctrine.ts` adds what settings rules cannot express. `AGENTS.md` owns the
rule; `tests/claude-doctrine.test.ts` holds the matrix.

- The companion: any git command is allowed when every other part of the
  command is inert. The inert parts are a `cd` into the session working
  directory or an additional working directory (read from
  `permissions.additionalDirectories` in the managed, user, and project
  settings, because the hook input carries only `cwd`), a plain read-only git
  command (`status`, `diff`, `log`, `show`, and the other local read verbs;
  `grep`, `cat-file`, `reflog`, `help`, `remote show`, a diff helper, or a
  runtime-shaped word stays out), a project formatter (`cargo fmt`, `rustfmt`,
  `ruff format`, `black`, `prettier --write`, `gofmt -w`), a `grep`, `head`,
  `tail`, `wc`, `sort`, or `uniq` filter that reads a pipe with no file
  argument, and a quoted heredoc or single-quoted here-string that only feeds
  `git commit -F -`. A push, a
  `gh pr` / `run` / `release` write, a git config override, an upload-pack or
  transport helper URL, a merge strategy, a git verb that runs another program,
  writes config, or reaches a remote, and any wrapped or runtime-shaped
  command ask; a substitution and an output redirect to a file on a history
  command are runtime-shaped. A `tee`, an output redirect on any other
  command, or a `cd` elsewhere removes the allowance, so Claude Code's own
  flow decides.
- Every other plugin agent (the reviewer) is denied all of those, and every
  shell write the hook can see: file-changing commands, git and gh writes, and
  output redirects to a file.
- It splits a command with the shell parser (`shell-parse.ts`,
  `shell-grammar.ts`) and unwraps `cd x &&`, `sudo`, `env`, `xargs`, and
  `bash -c` payloads. An unreadable command that names a gated program fails
  closed.
- A hook deny wins over a user allow rule. A hook allow never overrides an ask
  or deny from settings or another hook.

## Theme option

`plugin-options.mjs` reads the `theme` option live at each hook run, so a
`/config` change needs no restart (a new session or `/clear` picks it up). The
order: the managed settings (`managed-settings.json` and the
`managed-settings.d` drop-ins, where the last drop-in in alphabetical order that
sets the theme wins), then your user `settings.json`, then the value Claude
Code gave at start, then `goblin`.

Limits:

- The hooks do not read MDM policies (macOS plist, Windows registry) or
  server-managed settings. A theme set only there comes from the start-time
  value, so it needs a restart.
- The hooks ignore a `CLAUDE_CONFIG_DIR` or `HOME` that is inside the project
  the agent works in. A project in your home folder, or above it, does not
  count. If the system cannot find your home folder (a user with no passwd
  entry), the hooks skip your `settings.json` instead.
- An install from another marketplace name reads a different settings key, so
  it gets the start-time value or `goblin`.
