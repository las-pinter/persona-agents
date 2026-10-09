---
name: commit-hygiene
description: Final quality gate on completed work — review the commit chain, verify the tree, and squash workarounds before push.
---

# Commit Hygiene

## Purpose

A task can have many fix-ups. The history then holds workarounds,
dead ends, and commits that undo each other. Review the whole chain before
the work is done.

## When to Run

1. A task or plan completes, before the next task starts.
2. Before any push or pull request.
3. After any long fix-up chain.

## Checks

### 1. Commit-History Hygiene

List the commits since the task base.

```bash
git log --oneline <base>..HEAD
```

Classify each commit:

| Class | Meaning |
|-------|---------|
| value | Adds intended work |
| fix-up | Fixes a previous commit |
| undo | Reverts a previous commit |
| dead end | Tries a path that is later dropped |
| contradiction | Changes what another commit states |

Flag every fix-up, undo, dead end, and contradiction.

### 2. Net Diff

The final tree is what ships. Read the net change.

```bash
git diff <base>..HEAD
```

Confirm the net change is intended. Confirm no workaround scaffolding stays.

### 3. Final Tree Verification

Run the tests and the typecheck on the final tree. All must pass.
Re-run both after any squash.

### 4. Plan and Docs State

Confirm the plan is marked done with the commit IDs. Confirm the project
notes and the journal record the work.

### 5. Clean Tree

Run `git status`. The tree must be clean. Confirm no stray file, debug
print, or temp artifact remains.

## Squash

Fold a fix-up into the commit it fixes. Drop a dead end by squashing it
away; the net diff stays. Do not keep a commit that only fixes the
previous commit.

1. Propose the smallest coherent grouping and the final commit count.
2. Ask the user to approve the grouping.
3. Confirm the base is not pushed (`git branch -r --contains <base>`). Stop if it is.
4. Run `git reset --soft <base>`. Re-commit in the target grouping.
   Prefix every new commit with `ai:`.
   Unstage as needed with `git add <path>` or `git commit <path>` (ASK-gated). Do not use a mixed `git reset`.
   This step is ASK-gated.
5. Re-run the tests and the typecheck.

## Rules

- One concern per commit.
- Every commit starts with the prefix `ai:`.
- Never rewrite pushed history.
- Never push before this check passes.
- Only the orchestrator commits and squashes.

## Report Format

```
Base: <base-sha>
HEAD: <head-sha>
Commits: <count>

Chain:
  <sha> <subject>  [value]
  <sha> <subject>  [fix-up -> <target>]
  <sha> <subject>  [dead end -> drop]

Target: <count> commits
Grouping:
  <target-1>: <sha>, <sha>
  <target-2>: <sha>

Verification:
  tests:     pass | fail
  typecheck: pass | fail

Verdict: READY | SQUASH NEEDED
```
