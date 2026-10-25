---
name: file-length-policy
description: Shared file-length law for every coding agent and repository — the tiers, the exemptions, and the counting rule.
---

# File Length Policy

This skill owns the file-length law. Every coding agent follows the law in
every repository. The law covers a source file and a test file.

## The Tiers

| Lines | Action |
|-------|--------|
| 0 to 300 | No action. |
| 301 to 500 | Note the length. Consider a split when the file holds more than one responsibility. |
| 501 to 1000 | The reviewer asks for a cohesion check. Split the file when it mixes responsibilities. |
| over 1000 | A split is required. |

## The Cohesion Exception

A file over 1000 lines may stay whole when cohesion clearly justifies it.
Record the reason in one sentence in the review or the commit message.
An undocumented exception does not count.

## The Counting Rule

Use the plain line count. This is the same measure as `wc -l`.
Blank lines count. Comment lines count. Do not subtract them.

## Exemptions

These files do not follow the tiers:

- Generated files.
- Vendored code.
- Data-list files, such as a permission list or a tool list.

## Scope

- The law covers source files and test files.
- The law applies in every repository an agent works on.
- The law covers a new file and an existing file.

## The Split

1. Find the responsibilities in the file.
2. Group the lines by responsibility.
3. Move one group to a new file.
4. Keep the public behavior the same.
5. Run the tests after each move.

## Related Skills

- **code-implementation** — the implementation workflow.
- **test-case-structure** — the test file structure.
- **code-review-checklist** — the review checklist.
