---
name: review
description: Independent review of the current change by a read-only reviewer in a separate context. Use before committing a non-trivial change, or when the owner asks for a review. Optional argument - the scope, such as a base ref (main), a commit range, or paths.
argument-hint: "[base-ref | commit-range | paths]"
context: fork
agent: persona-agents:reviewer
background: false
---

Review a change in this repository.

Scope: $ARGUMENTS

Find the change:

- When the scope above is empty: review the uncommitted changes
  (`git diff HEAD` plus untracked files from `git status --short`). When the
  tree is clean, review the last commit (`git show HEAD`).
- When the scope is a ref such as `main`: review `git diff <ref>...HEAD` plus
  any uncommitted changes.
- When the scope is a commit range or paths: review exactly that.

Then:

1. Read the project rules in the repository (`AGENTS.md`, `CLAUDE.md`) when
   they exist, and follow their review and test rules.
2. If the change belongs to a study, the commit messages or the diff name it;
   read its acceptance criteria and check the change against them.
3. Review with the `persona-agents:code-review-checklist` skill.
4. Return the review in the output format of your agent instructions.
