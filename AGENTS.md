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
   or skills (`content/`) changed. State the correct install step: reinstall
   (`./install.sh --force`) for changed kiro or opencode templates, professions,
   personas, or skills; `/reload` for pi-only changes. A change that touches both
   pi and kiro or opencode needs both a reinstall and a `/reload`.

Files that carry a version number but do NOT track the package release:

- `package.json` dependency pins (the `devDependencies` and `overrides`
  blocks) — dependency versions, not the package version. Do not touch them
  on release.
- `package.json` `engines.node` — the minimum Node.js version, not the package
  version. Do not touch it on release.

No other file carries the package version number.

Rules:

- No `README.md` in this repository may contain a version number. A release
  must never need a README edit.

## Commit rule

Only the orchestrator writes git history. Every commit it makes starts with
the prefix `ai:`. The implementer never commits. It suggests a commit.

The doctrine lives in the permission templates and the live global file
`~/.pi/agent/permissions.json`. The orchestrator gets an ASK verdict for
`git add`, `git commit`, `git push`, `git pull`, `git merge`, `git rebase`,
`git tag`, and every `gh pr` and `gh release` command. Every other agent gets a
DENY for these. `cp`, `mv`, and `rsync` also ASK for the orchestrator and the
implementer, and are denied to the rest. The global file change is live and
unversioned.