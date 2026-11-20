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
     update persona-agents`, then `claude plugin update
     persona-agents@persona-agents`, then a restart.
   - A change to `content/`, `platforms/pi/`, `platforms/shared/`, or the `pi`
     block of `package.json` needs the Pi package update: `pi update
     --extensions`, then a new session so the extension reloads.
   - A change to `content/`, `platforms/kiro/`, or `platforms/shared/` needs
     the Kiro adapter update: `git pull` in the clone, then
     `./install.sh --kiro`. The payload under `$KIRO_HOME/persona-agents/` is a
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
  `install.sh` merges into the user settings: `git push`, `gh pr`, `gh run`,
  and `gh release` ask.
- The PreToolUse hook `platforms/claude/scripts/doctrine.ts`, for the
  persona-agents agents. The command classification it uses lives in
  `platforms/shared/shell/` and is shared with the Pi gate
  (`platforms/pi/scripts/policy.ts`) and the Kiro gate, so the adapters cannot
  drift apart. The companion runs any git command with no prompt when every
  part of the command is git work. A push, a `gh pr` / `run` / `release`, a
  `git -c` override, an unknown git global option, an upload-pack or transport
  helper URL, a merge strategy, and any wrapped or substituted command ask.
  Every other plugin agent is denied all of these and every shell write the
  hook can see.
- The Kiro gate `platforms/kiro/scripts/gate.ts`, for `pa-companion` and
  `pa-reviewer`. A `PermissionRequest` hook allows a plain history command and
  a reviewed or trivial commit; anything else returns no decision, so Kiro's
  native prompt asks. A PreToolUse hook denies the reviewer every shell write
  and every command that writes history or publishes; reading git history is
  allowed.

`platforms/claude/README.md` and `platforms/kiro/README.md` hold the hook
details.

Accepted risks: `rebase --exec` and `rebase -i` are allowed. `git -C` to
another repository is allowed on Claude Code and Pi, and the hooks and config
of that repository run; the Kiro gate asks for a commit that names another
repository, because it reads the change in the session's directory. `gh
workflow run` and `gh api` carry no gate entry by owner choice, so Claude
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
