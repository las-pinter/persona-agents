# AGENTS.md

Rules for agents working in this repository.

## Release ritual

When a new version is released:

1. Bump the version in `package.json`, line 3 (`"version"`). This file is the
   source of truth for the package version.
2. Tag the release `v<new-version>`. Create the tag before the release, or
   select an already-added tag in the GitHub release form. Pi installs resolve
   by tag, so a release without the tag does not install.
3. Before writing the install notes, run `git diff --name-only <prev-tag> HEAD`.
   Check whether the kiro, opencode, or pi templates (`platforms/kiro/`,
   `platforms/opencode/`, `platforms/pi/`) or the shared professions, personas,
   skills, or commands (`content/`) changed. State the correct install step:
   reinstall (`./install.sh --force`) for changed kiro or opencode templates,
   professions, personas, skills, or commands; `/reload` for pi-only changes. A
   command change (`content/commands/`) needs both a reinstall for kiro and
   opencode and a `/reload` for pi. A change that touches both pi and kiro or
   opencode needs both a reinstall and a `/reload`. A change to
   `content/`, `platforms/claude/`, or `.claude-plugin/` also needs the Claude
   Code update: `claude plugin marketplace update persona-agents`, then
   `claude plugin update persona-agents@persona-agents`, then a restart.

Files that carry a version number but do NOT track the package release:

- `package.json` dependency pins (the `devDependencies` and `overrides`
  blocks) — dependency versions, not the package version. Do not touch them
  on release.
- `package.json` `engines.node` — the minimum Node.js version, not the package
  version. Do not touch it on release.

No other file carries the package version number.

Rules:

- No `README.md` in this repository may contain the package version number. A release
  must never need a README edit.

## Commit rule

Only the orchestrator writes git history. Every commit it makes starts with
the prefix `ai:`. The implementer never commits. It suggests a commit.

The doctrine lives in the permission templates, the live global file
`~/.pi/agent/permissions.json`, and, for Claude Code, the PreToolUse hook
`platforms/claude/scripts/doctrine.ts`. On Claude Code and pi, the orchestrator
runs a plain `git add`, `git commit`, `git pull`, `git merge`, `git rebase`, or
`git tag` with no prompt. On every platform, it gets an ASK verdict for
`git push` and every `gh pr` and `gh release` command. Coverage differs per
platform:

- Claude Code allows a command only when every part of it is a plain history
  command. A command with another part gets no hook decision, so Claude Code
  decides.
- pi allows the six commands also with `git -C <path>`, `--no-pager`, `-p`,
  and a leading `cd x &&`.
- opencode allows only a plain `git add`, `git commit`, `git merge`, and
  `git rebase`. `git pull` and `git tag` ask, because a bare star can expand
  to a planted `--upload-pack` or `-d` file. `git -C` forms ask, because a
  quoted space in the directory can hide a second verb.
- Kiro has no ask tier. An unmatched command that the read-only detector
  calls read-only runs with no prompt. Each of the five templates that set
  `autoAllowReadonly` true denies the detector's write forms with explicit
  globs: fetch, `git remote show`, `git remote update`, and branch forms with
  an argument. A glob cannot tell a branch create from a branch listing, so a
  listing with an argument denies too. Those globs cover the detector's write
  forms only; an unlisted command asks. Those five templates deny the history
  verbs with globs: add, commit, push, pull, merge, rebase, and tag create and
  tag delete.
- On every platform, some forms still ask: tag force-move (a DENY on the five
  Kiro read-only templates; the Kiro orchestrator asks), `git -c` overrides
  and unknown global options, `commit --amend`, `git reset --soft`, upload-pack
  and transport helper URLs, merge strategies, wrapped or substituted forms, and
  brace, bracket, and extglob words. On Claude Code and pi, star and question
  mark words also ask. Tag delete is a DENY on pi, opencode, and Kiro, and
  an ASK on Claude Code.
- Accepted risks: `rebase --exec` and `rebase -i` are allowed. On Claude Code
  and pi, `git -C` to another repository is allowed, and the hooks and config
  of that repository run. On opencode, a bare star or question mark in an
  allowed command can expand to an option name from a planted file.

Every other agent gets a DENY for `git add`, `git commit`, `git push`,
`git pull`, `git merge`, `git rebase`, `git tag`, and every `gh pr` and
`gh release` command. `cp`, `mv`, and `rsync` ASK for the orchestrator and the
implementer, and are denied to the rest. The global file asks for `git push`
and `gh pr` for every agent. It is live and unversioned.