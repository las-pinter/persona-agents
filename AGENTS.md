# AGENTS.md

Rules for agents working in this repository.

## Release ritual

When a new version is released:

1. Bump the version in `package.json`, line 3 (`"version"`). This file is the
   source of truth for the package version.
2. Tag the release `v<new-version>`. Create the tag before the release, or
   select an already-added tag in the GitHub release form.
3. Before writing the install notes, run `git diff --name-only <prev-tag> HEAD`.
   State the correct install steps:
   - A change to `content/`, `platforms/claude/`, `platforms/shared/`, or
     `.claude-plugin/` needs the plugin update: `claude plugin marketplace
     update companion-agents`, then `claude plugin update
     companion-agents@companion-agents`, then a restart.
   - A change to `content/`, `platforms/pi/`, `platforms/shared/`, or the `pi`
     block of `package.json` needs the Pi package update: `pi update
     --extensions`, then a new session so the extension reloads.
   - A change to `content/`, `platforms/kiro/`, or `platforms/shared/` needs
     the Kiro adapter update: `git pull` in the clone, then
     `./install.sh --kiro`. The payload under `$KIRO_HOME/companion-agents/` is a
     copy, so a pull alone leaves the installed adapter on the old code. When
     the clone is gone, re-clone it first; the payload cannot update itself.
   - A change to `platforms/claude/settings/recommended.json` or `install.sh`
     also needs `./install.sh` from an updated clone.

Files that carry a version number but do NOT track the package release:

- `package.json` dependency pins (the `devDependencies` block) — dependency
  versions, not the package version. Do not touch them on release.
- `package.json` `engines.node` — the minimum Node.js version, not the package
  version. Do not touch it on release.

No other file carries the package version number.

Rules:

- No `README.md` in this repository may contain the package version number. A
  release must never need a README edit.

## Commit rule

Only the companion writes git history. Every commit it makes starts with the
prefix `ai:`. The reviewer never commits.

The doctrine lives in three places:

- The settings snippet `platforms/claude/settings/recommended.json`, which
  `install.sh` merges into the user settings: `git push` and the write actions
  of `gh pr`, `gh run`, and `gh release` ask. Their read actions (`view`,
  `list` / `ls`, `status`, `diff`, `checks`, `search`) pass.
- The PreToolUse hook `platforms/claude/scripts/doctrine.ts`, for the
  companion-agents agents. The command classification it uses lives in
  `platforms/shared/shell/` and is shared with the Pi gate
  (`platforms/pi/scripts/policy.ts`) and the Kiro gate, so the adapters cannot
  drift apart. The companion runs any git command with no prompt when every
  other part of the command is inert: a `cd` into the session working
  directory or an additional working directory (the recommended settings list
  the notes folder as one); a plain read-only git command (`status`,
  `diff`, `log`, `show`, and the other local read verbs; `grep`, `cat-file`,
  `reflog`, `help`, `remote show`, a diff helper, or a runtime-shaped word
  stays out); a project formatter
  (`cargo fmt`, `rustfmt`, `ruff format`, `black`, `prettier --write`,
  `gofmt -w`); a `grep`, `head`, `tail`, `wc`, `sort`, or `uniq` filter that
  reads a pipe with no file argument; or a quoted heredoc or single-quoted
  here-string that only feeds `git commit -F -`. A push, a `gh pr` / `run` /
  `release` write, a `git -c` override, an unknown git global option, an upload-pack
  or transport helper URL, a merge strategy, a git verb that runs another
  program, writes config, or reaches a remote, and any wrapped or substituted
  command ask, and so does a history command with an output redirect to a
  file. A `tee`, an output redirect on any other command, or a `cd` outside
  those directories removes the allowance, so Claude Code's own flow decides.
  Every other plugin agent is denied all of these and every shell write the
  hook can see.
- The Kiro gate `platforms/kiro/scripts/gate.ts`, for `ca-companion` and
  `ca-reviewer`. A `PermissionRequest` hook allows a git command and
  a reviewed or trivial commit; anything else returns no decision, so Kiro's
  native prompt asks. A PreToolUse hook denies the reviewer every shell write
  the gate can see and every command that writes history or publishes; reading
  git history is allowed.

`platforms/claude/README.md` and `platforms/kiro/README.md` hold the hook
details.

Accepted risks: `rebase --exec` and `rebase -i` are allowed. `git -C` to
another repository is allowed on Claude Code and Pi, and the hooks and config
of that repository run; the Kiro gate asks for a commit that names another
repository, because it reads the change in the session's directory. The
additional working directories come from the settings files
(`permissions.additionalDirectories`), because a hook input carries only
`cwd`; a repository-controlled `.claude/settings.json` can therefore add a
directory, as it already can for Claude Code's own file access. A formatter
runs the configuration and plugins its arguments name. The Pi companion keeps
its broader local-shell allowance, so the cd rule decides the Claude and Kiro
verdicts. A `python` or `node` heredoc body runs as code that no rule reads as
commands, though the Pi floor still reads its own patterns in it (a secret
word, a gate-file redirect, a remote script piped to a shell): the Pi companion runs it with no prompt, the Pi reviewer denies it, the
Kiro companion is asked, the Kiro reviewer is allowed it, and Claude Code's own
flow decides. The Pi write-place rule resolves a write word as a literal path,
so a `$VAR`, a backtick, or a `~user` word there is not expanded and the rule
cannot place it.
The settings ask list matches `gh pr <action>` prefixes, so a global flag
before the action (`gh pr -R o/r merge 1`) falls outside it; the doctrine hook
still asks for that command for the companion-agents agents, and a plain session
relies on Claude Code's own flow. The hook reads the word after the
sub-command as the action, so a flag there also makes a read ask
(`gh pr -R o/r view 1`); it fails safe.
`gh workflow run` and `gh api` carry no gate entry by owner choice, so Claude
Code's own permission flow decides them. The Kiro companion may run a `node`
script, so a determined companion can write the review store; the gate ignores
a record with no sub-session, but it guards against mistakes, not against the
agent itself.

## Adding content

It is rare to add a theme, a persona, or a skill. The steps live in
`docs/adding-content.md` and are read when a task names one of them.

## Tests

Test the code this repository runs: the Claude Code hooks and scripts,
`install.sh`, and the content tree structure. Do not write a test that
restates doctrine prose. A local imitation of Claude Code's own rule engine
proves nothing about Claude Code. A hook test never starts a real `claude`
process and never reads the owner's real notes folder; use the `--home` and
`--claude` argument seams.
