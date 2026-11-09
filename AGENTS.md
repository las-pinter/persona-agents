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
`git tag` with no prompt. On Kiro it runs a plain `git add` and a plain
`git commit` with no prompt. On every platform, it gets an ASK verdict for
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
  regex body per form. A new write shape that no entry names asks. A branch
  listing with a second token after the listing value denies. A tag listing
  with a pattern argument asks. The orchestrator asks on these three forms: an
  unnamed branch write shape, a second-token branch listing, and a pattern tag
  listing. The five role templates also deny the history verbs with explicit
  entries: add, commit, push, pull, merge, and rebase. The orchestrator allows
  the journal script call and the two date forms. It also allows a plain
  `git add` and a plain `git commit`. It denies the journal script call when it
  carries `--home`.
- On every platform, some forms still ask. The forms are: tag force-move,
  `git -c` overrides, unknown global options, `commit --amend`,
  `git reset --soft`, upload-pack URLs, and transport helper URLs. The forms
  also include merge strategies, wrapped forms, substituted forms, and brace,
  bracket, and extglob words. On Kiro, a `git add` or `git commit` line asks
  in these shapes. The shapes are a separator, a substitution, a redirect, a
  leading space, a `cd <path> &&` prefix, and the `-C` git option. A wrapper
  prefix that no deny entry names, such as `env`, `command`, `nohup`, or
  `timeout`, asks. An eval wrapper and an interpreter run with the command
  flag both deny. A tag force-move is a DENY on the five Kiro role templates,
  and the Kiro orchestrator asks. `commit --amend` is a DENY on the Kiro
  orchestrator. Its deny entry starts at the commit verb, so only a line that
  starts with that form denies. An amend line can carry a leading space, a
  `cd` prefix, the `-C` option, or a wrapper before the verb. It can also
  carry a separator, a substitution, or a redirect before the verb. Such a
  line matches no deny entry, so it asks. An eval wrapper or an interpreter
  run with the command flag still denies. On Claude Code and pi, star and
  question mark words also ask. Tag delete is a DENY on pi, opencode, and
  Kiro, and an ASK on Claude Code.
- Accepted risks: `rebase --exec` and `rebase -i` are allowed. On pi, the
  orchestrator may run the three verification scripts, and the test script
  covers test files it can write, so a self-graded run is possible. The reviewer
  may run them too, and a passing suite is its own evidence; CI reruns the same
  suite, and the install step is the barrier. On Claude Code
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
  The token decides which lock a `release` call may remove. `hold` takes no
  token.
  The opencode separator asks are journal scoped and rely on last-match-wins.
  On pi, a root ask and a queued child ask share one panel slot, so only one
  panel is live on the terminal. The second ask waits, first in first out. A
  waiting ask is bounded by its own deadline. The root prompt carries no
  deadline, so it waits. A child request still ends at its own deadline.

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

On pi, a child ask is queued, not denied, and the owner's answer becomes the
child's verdict. `platforms/pi/README.md` owns the queue mechanics, the deadline
count, and the no-surface case.

## Adding content

It is rare to add a theme, a profession, a persona, or a skill. The steps
live in `docs/adding-content.md` and are read when a task names one of them.

## Tests

Test the code this repository runs: the pi extension and gate, the Claude
hooks, `install.sh`, and the skill scripts. Do not add a test that only reads
another platform's settings, plugin manifest, or agent file, and do not write
a test that restates doctrine prose. A local imitation of another platform's
rule engine proves nothing about that platform.
