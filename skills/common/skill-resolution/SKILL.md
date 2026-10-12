---
name: skill-resolution
description: Resolve a domain task (Rust, Python, React/frontend) to an installed common skill before the repo skill. Load this before any domain task to decide which skill to follow.
---

# Skill Resolution

Use this skill at the start of a domain task. The skill decides if an
installed common skill replaces a repo skill. A present common skill wins.
The repo skill is the fallback.

## Step 1: Detect the Domain

Apply these rules in order. Stop at the first match.

1. Repo marker: `Cargo.toml` is rust. `pyproject.toml`, `setup.py`, or
   `requirements.txt` is python. `package.json` with a `react` or `next`
   dependency is reactjs.
2. Task text words: rust, python, react, frontend, ui, component, tsx, jsx.
3. No match: do not override. Follow the repo skills.

## Step 2: Test for the Common Skill

The common roots are:

- `$HOME/.agents/skills`
- `$HOME/.pi/agent/skills`

Use the shell for the test. Do not use the file read, glob, or grep tools on
these paths. Run one command per candidate:

```sh
ls "$HOME/.agents/skills/<name>/SKILL.md" "$HOME/.pi/agent/skills/<name>/SKILL.md" 2>/dev/null
```

The candidates come from the domain:

| Domain | Primary | Secondary |
|--------|---------|-----------|
| rust | rust-best-practices | rust-async-patterns |
| python | python-design-patterns | python-testing-patterns |
| reactjs | vercel-react-best-practices | web-design-guidelines, frontend-design, shadcn |

## Step 3: Load the Common Skill

The `ls` command prints each path that exists. Load the printed path.

On opencode, use the shell `cat` command when a read prompts the user:

```sh
cat "$HOME/.agents/skills/<name>/SKILL.md"
```

## Step 4: Apply Precedence

A present primary common skill is loaded, and it replaces the repo domain
skill when one exists. Follow the common skill. Treat the replaced repo skill
body as the fallback. Do not follow it.

Load a secondary common skill alongside the primary only if it is present. A
secondary never replaces a repo skill.

Only one repo skill is replaced: `implementer/rust-implementation`.

## Step 5: Fall Back Safely

No candidate is present: follow the repo skill as today. A missing common
root never fails the task. Do not report an error for the missing root.

## Scope

The skills an agent carries — its domain skill, quality gates, and method
skills — are fixed by the profession's frontmatter or resources. This
resolver only decides if an installed common skill replaces a repo DOMAIN
skill, and it never adds or removes any other skill.
