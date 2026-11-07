---
name: shell-discipline
description: Shell and path rules for every command and file tool. Do not cd into the repo. Use absolute command paths, repository-relative file-tool paths with no parent segment, and git -C <path>. Load this skill at startup, before any command.
---

# Shell Discipline

These rules apply to every shell command and every file tool call an agent
runs. The gated file tools are `read`, `grep`, `find`, `ls`, `edit`, and
`write`. The rules prevent a blocked command and a wrong path.

## Working Directory

- The bash shell starts at the repository root. Do not `cd` into the repository.
- Do not join `cd <repo> &&` to a command.

## Paths

- Use an absolute path in every shell command.
- A role that owns the repository uses a repository-relative path with no
  parent segment for the `edit` and `write` tools. A reader writes only under
  its own `agent-notes` folder.
- The `read`, `grep`, `find`, and `ls` tools take any path. The `read` tool
  denies a secret file, such as an environment file or a key file.
- Use `git -C <path>` to run git in another directory. Give that path in full.
- Keep the working directory unchanged. The shell is already in the right place.

## Why

The gate denies most commands that follow a `cd`. It allows a leading
`cd X &&` only when the rule under it permits the fold. The gate withholds the
fold from a build or a test command. So `cd <repo> && git status` is allowed,
and `cd <repo> && npm test` is denied. Kiro and opencode match the raw command
string.

## Path Forms on pi

The gate decides a path by its shape, not by the working directory. For a
worker and the orchestrator, a repository-relative path with no parent segment
allows a write. Any other path asks for a worker or the orchestrator. The gate
denies that path for a reader. For a judged agent, a path that reaches no rule
falls to the mode default, which denies. A session with no active agent and no
run record keeps only the global rows and allows. The pi permission table and its README
own the zones and the path forms.
