---
name: shell-discipline
description: Shell and path rules for every command. Do not cd into the repo; use absolute paths and git -C. Load this skill at startup, before any command.
---

# Shell Discipline

These rules apply to every command an agent runs. They prevent a blocked
command and a wrong path.

## Working Directory

- The bash shell starts at the repository root. Do not `cd` into the repository.
- Do not join `cd <repo> &&` to a command. The pi gate folds `cd X` into the git, cargo, rustup, and uv allow rules only. Other commands fail.

## Paths

- Use absolute paths in every command.
- Use `git -C <path>` to run git in another directory.
- Keep the working directory unchanged. The shell is already in the right place.

## Why

The `cd <repo> &&` form fails closed for most segments. The pi gate folds a
leading `cd X` into the git, cargo, rustup, and uv allow rules only. Every other segment
must pass on its own. So `cd <repo> && git status` is allowed. But
`cd <repo> && npm test` is denied. Kiro and opencode match the raw command
string.
