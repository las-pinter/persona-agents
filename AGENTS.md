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
   - A change to `content/`, `platforms/claude/`, or `.claude-plugin/` needs
     the plugin update: `claude plugin marketplace update persona-agents`,
     then `claude plugin update persona-agents@persona-agents`, then a restart.
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

The doctrine lives in two places:

- The settings snippet `platforms/claude/settings/recommended.json`, which
  `install.sh` merges into the user settings: `git push`, `gh pr`, `gh run`,
  and `gh release` ask.
- The PreToolUse hook `platforms/claude/scripts/doctrine.ts`, for the
  persona-agents agents. The companion runs a plain `git add`, `git commit`,
  `git pull`, `git merge`, `git rebase`, or `git tag` with no prompt, when
  every part of the command is one of those. A push, a `gh pr` / `run` /
  `release`, a tag delete or force-move, `commit --amend`, a `git -c`
  override, an unknown git global option, an upload-pack or transport helper
  URL, a merge strategy, and any wrapped or substituted history command ask.
  Every other plugin agent is denied all of these and every shell write the
  hook can see.

`platforms/claude/README.md` holds the hook details.

Accepted risks: `rebase --exec` and `rebase -i` are allowed. `git -C` to
another repository is allowed, and the hooks and config of that repository
run. `gh workflow run` and `gh api` carry no gate entry by owner choice, so
Claude Code's own permission flow decides them.

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
