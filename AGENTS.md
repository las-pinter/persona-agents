# AGENTS.md

Rules for agents working in this repository.

## Release ritual

When a new version is released:

1. Bump the version in `package.json`, line 3 (`"version"`). This file is the
   source of truth for the package version.
2. Tag the release `v<new-version>`. Create the tag before the release, or
   select an already-added tag in the GitHub release form. Pi installs resolve
   by tag, so a release without the tag does not install.
3. Before writing the install notes, run `git diff --name-only <prev-tag> HEAD`.
   Check whether the kiro, opencode, or pi templates (`platforms/kiro/`,
   `platforms/opencode/`, `platforms/pi/`) or the shared professions, personas,
   skills, or commands (`content/`) changed. State the correct install step:
   reinstall (`./install.sh --force`) for changed kiro or opencode templates,
   professions, personas, skills, or commands; `/reload` for pi-only changes. A
   command change (`content/commands/`) needs both a reinstall for kiro and
   opencode and a `/reload` for pi. A change that touches both pi and kiro or
   opencode needs both a reinstall and a `/reload`. A change to
   `content/`, `platforms/claude/`, or `.claude-plugin/` also needs the Claude
   Code update: `claude plugin marketplace update persona-agents`, then
   `claude plugin update persona-agents@persona-agents`, then a restart.

Files that carry a version number but do NOT track the package release:

- `package.json` dependency pins (the `devDependencies` and `overrides`
  blocks) — dependency versions, not the package version. Do not touch them
  on release.
- `package.json` `engines.node` — the minimum Node.js version, not the package
  version. Do not touch it on release.

No other file carries the package version number.

Rules:

- No `README.md` in this repository may contain the package version number. A release
  must never need a README edit.

## Commit rule

Only the orchestrator writes git history. Every commit it makes starts with
the prefix `ai:`. The implementer never commits. It suggests a commit.

The doctrine lives in the permission templates, the live global file
`~/.pi/agent/permissions.json`, and, for Claude Code, the PreToolUse hook
`platforms/claude/scripts/doctrine.ts`. On Claude Code and pi, the orchestrator
runs a plain `git add`, `git commit`, `git pull`, `git merge`, `git rebase`, or
`git tag` with no prompt. On every platform, it gets an ASK verdict for
`git push` and every `gh pr`, `gh run`, and `gh release` command, with one
exception on pi: a `gh` global option before the subcommand falls to
deny-by-default, because no ask entry names that form. Coverage differs per
platform:

- Claude Code allows a command only when every part of it is a plain history
  command or the orchestrator's journal script call from its installed skill
  path. The journal allow is cancelled by a leading `cd`, a wrapper, or any
  ungated part beside it. It is also cancelled by a substitution that runs an
  ungated command, or by a redirect that writes a file. A redirect to
  `/dev/null` and an fd duplicate such as `2>&1` keep it. Two journal calls
  still allow. An allow beside an ungated part gets no hook decision, so Claude
  Code decides. An ask or deny part keeps its own verdict.
- pi allows the six commands also with `git -C <path>`, `--no-pager`, `-p`,
  and a leading `cd x &&`. The gate derives the skill script folder from the
  loaded skill, so the journal script call needs no template entry.
- opencode allows only a plain `git add`, `git commit`, `git merge`, and
  `git rebase`. `git pull` and `git tag` ask, because a bare star can expand
  to a planted `--upload-pack` or `-d` file. `git -C` forms ask, because a
  quoted space in the directory can hide a second verb. Two allow entries
  cover the two date forms, `date +%Y%m%dT%H%M%S%N` and
  `date -u +%Y-%m-%dT%H:%M:%SZ`. One allow entry covers the journal script
  call, six asks cover a separator after it, and one ask covers the call with
  `--home`.
- Kiro has no ask tier. It has three verdicts: an allow entry runs with no
  prompt, a deny entry blocks the command, and an unmatched command asks. All
  six shell templates set `autoAllowReadonly` false, so no read-only detector
  can allow a command. The deny fence covers branch and tag on the five role
  templates. It names these branch create forms: a bare name, a boolean
  listing option followed by a name, a listing option value followed by a
  second token, and the branch write flags. It names every tag create flag
  shape, and tag delete and force. Each entry covers the bare command and
  these wrappers: `;`, `&&`, `|`, `$(`, a backtick, `git -C <path>`, and a
  leading space. A Kiro command pattern is an anchored regex, so an entry can
  name a write form and leave a listing to the allow list. The cost is one
  regex body per form: a new write shape that no entry names asks, a branch
  listing with a second token after the listing value denies, and a tag
  listing with a pattern argument asks. The orchestrator leaves those forms to
  ask, because its allow list does not carry them. The five role templates
  also deny the history verbs with explicit entries: add, commit, push, pull,
  merge, and rebase. The orchestrator allows the journal script call and the
  two date forms, and denies that call when it carries `--home`.
- On every platform, some forms still ask: tag force-move (a DENY on the five
  Kiro role templates; the Kiro orchestrator asks), `git -c` overrides
  and unknown global options, `commit --amend`, `git reset --soft`, upload-pack
  and transport helper URLs, merge strategies, wrapped or substituted forms, and
  brace, bracket, and extglob words. On Claude Code and pi, star and question
  mark words also ask. Tag delete is a DENY on pi, opencode, and Kiro, and
  an ASK on Claude Code.
- Accepted risks: `rebase --exec` and `rebase -i` are allowed. On pi, the
  orchestrator may run the three verification scripts, and the test script
  covers test files it can write, so a self-graded run is possible; CI reruns
  the same suite, and the install step is the barrier. On Claude Code
  and pi, `git -C` to another repository is allowed, and the hooks and config
  of that repository run. On opencode, a bare star or question mark in an
  allowed command can expand to an option name from a planted file. On Claude
  Code, a gh global option that takes a separate value and is not `-R` or
  `--repo` defeats the option skip. The value is read as the subcommand, so the
  gate fires on the value or not at all. gh has no other global option at the
  time of writing. `gh workflow run` and `gh api` carry no gate entry on any
  platform by owner choice, so the platform default decides them. On opencode,
  the `gh run` glob also denies a plain read that merely quotes the string.
  The opencode role templates carry three `gh run` deny forms (plain, repo
  flag, joined repo flag) in four entries, because the repo flag has a short
  word and a long word. On Kiro, the journal allow uses the tilde form; Kiro
  expands the tilde for home, and one live probe has not yet confirmed the
  command pattern form, so an expanded path asks. On Kiro, the journal deny
  and the opencode journal ask match the text `--home` anywhere in the line,
  so a legitimate line that carries that text asks or is denied. A journal
  call with `--home` asks on opencode and is denied on Kiro, but pi and Claude
  allow it. The script path check limits that call to the installed script.
  The session stamp check and the `replace` digest check limit what it writes.
  The opencode separator asks are journal scoped and rely on last-match-wins.

Every other agent gets a DENY for `git add`, `git commit`, `git push`,
`git pull`, `git merge`, `git rebase`, `git tag`, and every `gh pr`,
`gh run`, and `gh release` command, with one exception: `gh run` is an ASK on
Kiro, where no role template carries the entry. The opencode role templates
carry a `gh run` deny fence, and the Claude Code publish gate denies it. On
pi, the implementer template names `gh run` with a deny entry, and the other pi
role templates reach DENY through the deny-by-default mode. `cp`, `mv`, and
`rsync` ASK for the orchestrator and the implementer, and are denied to the
rest. The global file asks for `git push` and `gh pr` for every agent. It is
live and unversioned.

## Adding content

This section covers themes, professions, personas, and skills. A theme is a
cast of characters. A profession sets the role rules. A persona sets the
voice. A skill holds a workflow. The platform-neutral sources live under
`content/`.

### Adding a theme

A theme needs one `content/agents.json` entry and one persona file for each of
the 7 professions: orchestrator, planner, implementer, reviewer, tester,
researcher, and mascot.

1. Add a top-level key for the theme to `content/agents.json`. Give it all 7
   professions. Each profession entry holds `personaFile`, `description`, and
   `welcomeMessage`.
2. Create 7 distinct persona files in `content/personas/<theme>/`. Follow the
   persona format below.
3. Add the theme to the Claude Code theme picker. Append it to
   `userConfig.theme.options` in `.claude-plugin/plugin.json`.
4. Check the output with `./install.sh --dry-run --force --theme <theme>`.

The installer then writes 7 agents for Kiro and 7 agents for OpenCode, named
`<theme>-orchestrator`, `<theme>-planner`, and so on.

### Adding a profession

A profession defines what an agent does. A new profession becomes available in
every theme.

1. Create `content/professions/<name>.md`. The required sections appear in this
   order:

   ```markdown
   # <Profession>

   First paragraph: role summary.
   ## Startup          (optional; comes first when present)
   ## Core Behavior
   - The first rule: profession rules win over persona instructions on
     matters of function.
   ## <Role Sections>  (optional)
   ## When to Defer
   ## Failure Modes (never do these)
   ## Output Format
   ## Skills
   ```

   `## When to Defer` names the cases where the profession escalates and does
   not act. `## Startup` lists the skills to load before any user input. When a
   profession has a `## Startup` section, its `alwaysLoad` list in the pi
   frontmatter must match it. `tests/doc-lint.test.ts` enforces that parity for
   the orchestrator only. The suite also resolves every skill name that a
   profession or a template names.

   A role section normally sits between `## Core Behavior` and
   `## When to Defer`. A profession that does no tool work, such as
   `content/professions/mascot.md`, may omit most sections. A trailing section
   may sit before or after `## Skills`.

   Two professions place their own sections:

   - The orchestrator puts `## TODO Lists`, `## Journal Management`,
     `## Project Notes`, and `## Context Discipline (CRITICAL)` after
     `## When to Defer`.
   - The researcher puts `## Research Documentation` between `## Output Format`
     and `## Skills`.

2. Create the Kiro template, `platforms/kiro/templates/<name>.json`. Copy an
   existing template. Set the tools, the allowed and denied commands, the
   subagent trust list, and the edit paths. Never list a gated history or
   release command in `allowedCommands`. See `platforms/kiro/README.md`.
3. Create the OpenCode frontmatter,
   `platforms/opencode/frontmatters/<name>.yaml`. Map the Kiro permissions with
   the table in `platforms/opencode/README.md`.
4. Create the pi frontmatter, `platforms/pi/frontmatters/<name>.yaml`. Copy an
   existing one for `name`, `description`, `tools`, `skills`, `alwaysLoad`, and
   `permissions`. A profession without a pi frontmatter is not a pi agent.
5. Create the Claude Code agent file, `platforms/claude/agents/<name>.md`. Use
   frontmatter only: `name`, `description`, and optional `tools` or
   `disallowedTools`. Leave the body empty. Add the path to `agents` in
   `.claude-plugin/plugin.json`.
6. Add the profession to every theme in `content/agents.json`. Each entry needs
   a persona file, a description, and a welcome message. Create the persona
   files.
7. Optional: add skills. Follow the skill steps below.
8. Check the output with
   `./install.sh --dry-run --force --profession <name>`.

`install.sh` never deletes installed files. A retired profession leaves its
agent files in `~/.kiro/agents/` and `~/.config/opencode/agents/`. It also
leaves the installed profession file and the installed skill copies under
`~/.kiro/` and `~/.config/opencode/`. Its template stays in
`platforms/<target>/`. Remove the files by hand.

### Adding or changing a persona

A persona file sets how an agent talks and acts. Put it at
`content/personas/<theme>/<name>.md`. The shape is:

```markdown
# <Name> the <Title> Persona

You are <Name>, the <Title>. [Who they are and their role in the theme.]

## Personality

- [Trait 1]

## Speech Style

- [How they open, deliver information, and react to mistakes and praise]

## Rules

- Always stay in character as <Name>, the <Title>.
- [Behavior rule]
- Use your own themed subagents. Dispatch `<theme>-*` agents. Use cross-theme
  agents only when the user asks.

## Notes (optional)

Lore or backstory only.
```

The rules that apply:

- The first line is `# <Name> the <Title> Persona`, an ATX header.
- The required sections are `## Personality`, `## Speech Style`, and
  `## Rules`. `## Notes` is optional.
- The last rule names the themed subagent pattern: `goblin-*`, `wh40k-*`,
  `wh40kOrk-*`, `pub-*`, `caveman-*`, `cyberpunk-*`, `catcrew-*`, or
  `fantasy-*`.
- Do not write journal protocols in a persona. The orchestrator
  `journal-management` skill owns them.
- Match the voice to the theme.

To test a persona change, generate the agent. The OpenCode file must hold one
stub comment. The Kiro `resources` list must name your persona file:

```bash
./install.sh --force --theme goblin --profession orchestrator
grep '<!-- persona-agents:' ~/.config/opencode/agents/goblin-orchestrator.md
jq '.resources' ~/.kiro/agents/goblin-orchestrator.json
```

### Adding a skill

A skill is a workflow document that an agent loads at run time.

1. Create `content/skills/<profession>/<skill-name>/SKILL.md`. Each skill
   folder holds exactly one `SKILL.md`. The `name:` in its frontmatter must
   equal the folder name. State what the skill is for, when to load it, and the
   steps. Put scripts and templates in the same folder, or in a `scripts/` or
   `templates/` subfolder.
2. A skill that several professions need goes in `content/skills/common/`. A
   pi agent loads such a skill at startup through `alwaysLoad:` in
   `platforms/pi/frontmatters/*.yaml`. Pi warns when a pattern there resolves
   to no skill.
3. Add the skill folder to `skills` in `.claude-plugin/plugin.json`. A skill
   for one other platform only goes into `EXCLUDED_SKILLS` in
   `tests/claude-plugin.test.ts`, with the reason.
4. Check the copy with
   `./install.sh --dry-run --force --profession <profession>`.

A Kiro role template loads the skills of its profession through
`skill://~/.kiro/skills/{{PROFESSION}}/*/SKILL.md`, so a skill in an existing
profession needs no template change. The mascot template has no skill
resource.

## Tests

Test the code this repository runs: the pi extension and gate, the Claude
hooks, `install.sh`, and the skill scripts. Do not add a test that only reads
another platform's settings, plugin manifest, or agent file, and do not write
a test that restates doctrine prose. A local imitation of another platform's
rule engine proves nothing about that platform.
