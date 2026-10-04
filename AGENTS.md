# AGENTS.md

Rules for agents working in this repository.

## Release ritual

When a new version is released:

1. Bump the version in `package.json`, line 3 (`"version"`). This file is the
   source of truth for the package version.
2. Bump the same version in `agent-stack/README.md`, in the install comment
   that names the current package version inside the distribution install
   block.
3. Create a git tag v<new-version>. Pi installs resolve by tag,
   so a release without the tag does not install.

Files that carry a version number but do NOT track the package release:

- `plugins/herdr/overseer-herald/herdr-plugin.toml`, line 3
  (`version = "0.1.0"`) — the herdr plugin has its own independent version.
  Bump it only when the plugin itself changes, never on a package release.
- `package.json` dependency pins (lines 23–29) — dependency versions, not the
  package version. Do not touch them on release.

No other file carries the package version number.

Rules:

- The root `README.md` must never contain a version number. A release must
  never need a README edit.

## Commit rule

Every agent commit message must start with the prefix `ai-`.