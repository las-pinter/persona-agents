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

The gate decides a path by the shape of the path string, never by the working
directory.

A repository-relative path with no parent segment allows a write for a worker
and for the orchestrator.

Two other forms allow, and both come from a table row. An absolute path at or
under `/tmp` with no parent segment allows for a worker and for the
orchestrator. An absolute `agent-notes` path with no parent segment allows for
the orchestrator, and allows a worker profession inside its own notes zone.

Another path asks for a worker or the orchestrator, unless its string skips the
ask row. A path with a parent segment asks before any skip. Two shapes skip it,
and both need an absolute path with no parent segment. The first is an absolute
path whose string holds a segment that ends in `tmp`. The second is an absolute
path whose string holds a segment that ends in `agent-notes`. It covers the
orchestrator and a worker in its own notes zone. A skipped path gets no ask: it
allows inside a zone, and otherwise falls to the mode default. That default
denies. The pi README names the two shapes. The gate denies a reader outside its
own notes zone. A session with no active agent and no run record keeps only the
global rows and allows.

The pi permission table and its README own the zones and the path forms.
