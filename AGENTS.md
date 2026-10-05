# AGENTS.md

Rules for agents working in this repository.

## Release ritual

When a new version is released:

Bump the version in `package.json`, line 3 (`"version"`). This file is the
source of truth for the package version.

Files that carry a version number but do NOT track the package release:

- `plugins/herdr/overseer-herald/herdr-plugin.toml`, line 3
  (`version = "0.1.0"`) — the herdr plugin has its own independent version.
  Bump it only when the plugin itself changes, never on a package release.
- `package.json` dependency pins (lines 23–29) — dependency versions, not the
  package version. Do not touch them on release.

No other file carries the package version number.

Rules:

- No `README.md` in this repository may contain a version number. A release
  must never need a README edit.

## Commit rule

Every agent commit message must start with the prefix `ai:`.