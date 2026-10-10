# AGENTS.md

Rules for agents working in this repository.

## Release ritual

When a new version is released:

1. Bump the version in `package.json`, line 3 (`"version"`). This file is the
   source of truth for the package version.
2. Tag the release `v<new-version>`. Create the tag before the release, or
   select an already-added tag in the GitHub release form. Pi installs resolve
   by tag, so a release without the tag does not install.

Files that carry a version number but do NOT track the package release:

- `plugins/herdr/overseer-herald/herdr-plugin.toml`, line 3
  (`version = "0.1.0"`) — the herdr plugin has its own independent version.
  Bump it only when the plugin itself changes, never on a package release.
- `package.json` dependency pins (lines 26–32) — dependency versions, not the
  package version. Do not touch them on release.

No other file carries the package version number.

Rules:

- No `README.md` in this repository may contain a version number. A release
  must never need a README edit.

## Commit rule

Only the orchestrator writes git history. Every commit it makes starts with
the prefix `ai:`. The implementer never commits. It suggests a commit.

The doctrine lives in the permission templates and the live global file
`~/.pi/agent/permissions.json`. The orchestrator gets an ASK verdict for
`git add`, `git commit`, `git push`, `git pull`, `git merge`, `git tag`, and
every `gh pr` command. Every other agent gets a DENY for these. `cp`, `mv`,
and `rsync` also ASK for the orchestrator and the implementer, and are denied
to the rest. The global file change is live and unversioned.