# Kiro CLI adapter internals

This file describes how the Kiro side is built, for maintainers. The root
[README.md](../../README.md) covers install and use.

The adapter ships the same agent as the Claude plugin, from the same
`content/` tree: one companion that plans, implements, tests, reviews, and
commits with the owner, in the voice of a persona theme. It targets
kiro-cli 3.4.0 or newer (the V3 engine) and is tested on 3.5.0. Unlike the
Claude and Pi adapters, the Kiro adapter is a **self-contained payload**: the
installer copies `content/`, `platforms/shared/`, and `platforms/kiro/` into
`$KIRO_HOME/persona-agents/`, so a moved or deleted clone does not break a
running install.

## Install and update

```bash
./install.sh --kiro --dry-run   # preview
./install.sh --kiro             # install
./install.sh                    # both adapters
```

Flags:

- `--claude` / `--kiro` restrict the run; with neither, both are installed.
  When `kiro-cli` is absent the Kiro step is skipped with a message, unless
  `--kiro` was named.
- `--theme <name>` writes the persona theme. When the flag is absent the
  installer keeps the theme already in `config.json`, or writes `goblin` on a
  first install.
- `--dry-run` prints the plan and writes nothing.
- `--force` backs up and replaces a skill folder the installer does not own.
- `--kiro-home=<dir>` overrides `$KIRO_HOME`; `--kiro-cli=<path>` overrides the
  command the version check runs.

The installer (`install.ts`) writes:

- `<kiro home>/persona-agents/` — the payload: `content/`, `platforms/shared/`,
  `platforms/kiro/`, and `config.json` (`{ "theme": "<name>" }`). `state/` is
  never removed.
- `<kiro home>/skills/<name>/` — the skills, with
  `{{PERSONA_AGENTS_KIRO_SKILL_DIR}}` and `{{PERSONA_AGENTS_KIRO_ROOT}}`
  substituted for the installed paths.
- `<kiro home>/agents/pa-companion.json`, `pa-reviewer.json`,
  `pa-writer.json`.
- Nothing else. `chat.defaultAgent` is read to warn about a name that no file
  and no built-in provides; it is never rewritten.

A skill folder is replaced only when it carries the marker
`.persona-agents.json`. The installer stops before any write when a folder
lacks the marker; `--force` renames it to `<name>.bak-<timestamp>` and replaces
it.
A version below 3.4.0 is refused before any write.

Update with `git pull` and `./install.sh --kiro`. A file whose text the
installer would change is backed up as `<file>.bak-<timestamp>`; a file that
already matches is left alone, so an unchanged run writes no backup. Start the
companion with:

```bash
kiro-cli --agent pa-companion
```

## Layout

- **Installer** (`platforms/kiro/install.ts`): the payload copy, the skill
  install, the three rendered agent configs, the version check, and the CLI.
- **Scripts** (`platforms/kiro/scripts/`): pure TypeScript with Node built-ins
  only, so `node:test` can exercise them without starting Kiro.
  - `paths.ts` — the Kiro home and the payload paths.
  - `context.ts` — the SessionStart text: platform note, persona, profession,
    session id, read list.
  - `session-store.ts` — the V3 `messages.jsonl` reader and the neutral entry
    mapping.
  - `journal.ts` — this session's journal path.
  - `change.ts`, `review.ts`, `review-record.ts`, `state.ts` — the review brief,
    the change key, the verdict record, and the commit gate store.
  - `gate.ts` — the doctrine decision in two hook shapes.
  - `compact.ts` — the pre-compaction manifest and the post-compaction reload.
  - `journal-end.ts` — the SessionEnd safety net and its detached writer.
  - `retro.ts` — the session facts.
- **Agents**: the `pa-reviewer` prompt is the shared
  `content/professions/reviewer.md`, read from the payload at install time,
  plus a Kiro note (skills have no namespace; the checklist skill is
  `code-review-checklist`). The reviewer selects the skills that name the
  languages in scope and lists them under `## Skills loaded`, as the shared
  prompt says.
- **Shared modules** (`platforms/shared/`): the logic every adapter uses —
  shell classification, notes, compaction manifest, review, retro facts, and
  the prompt sections. See [platforms/pi/README.md](../pi/README.md#layout)
  for the module list.
- **Skill branches** (`content/skills/{review,retro,wrap-up}/references/kiro.md`):
  the Kiro procedure for the three skills whose `## Platform branch` section
  sends Kiro elsewhere. The installer substitutes the payload paths.

The payload keeps the repository layout so the relative imports between
`platforms/kiro/` and `platforms/shared/` resolve unchanged.

## The three agents

- **`pa-companion`** — the main session. The prompt is
  `content/professions/companion.md`, inlined into the config because Kiro
  rejects an absolute `file://` prompt; tools `read`, `write`, `shell`, `web`,
  `subagent/pa-reviewer`; resources are the installed `skill://` files. No
  model is pinned: the owner's session model is used.
- **`pa-reviewer`** — read-only, separate context. Tools `read`, `web`,
  `shell`; no file-write tool. Its `permissions.rules` deny every `fs_write`,
  and a PreToolUse hook blocks shell writes the gate can see and every command
  that writes history or publishes (commit, tag, push). Reading git history is
  allowed. A `python` or `node` heredoc body runs as code the gate does not
  read, as `python -c` already did.
- **`pa-writer`** — the journal writer. Tools `[]`; no permissions. It writes
  the entry text from the material the SessionEnd net gives it.

## Hooks

All hooks are inline in the agent profile; no global hook runs for another Kiro
session.

| Agent | Trigger | Job |
| --- | --- | --- |
| companion | `SessionStart` | `context.ts session`: the platform note and the theme persona (the profession is the agent prompt). |
| companion | `SessionStart` | `context.ts startup`: the session id and the read list. |
| companion | `PermissionRequest` | `gate.ts permission`: allow a git command or a reviewed/trivial commit; return no decision otherwise, so Kiro shows its own prompt. A chain of git work and inert parts (a session cd, a read, a formatter, a pipe filter, a quoted commit heredoc) is allowed; a cd outside the session asks, and the commit review still runs inside a chain. |
| companion | `Stop` | `review-record.ts`: scan the V3 store for a `sub_agent_complete` from `pa-reviewer` and store its verdict against the change key. |
| companion | `PreCompact` | `compact.ts pre`: store the manifest and print guidance for the summarizer. |
| companion | `PostCompact` | `compact.ts post`: store the summary and print the ordered reload list. |
| companion | `SessionEnd` | `journal-end.ts hook`: detach the journal writer when the session has no entry. |
| reviewer | `PreToolUse` | `gate.ts pretool`: deny a shell write, history command, or publish command. Reads pass. |

Kiro passes the event as JSON on stdin with `session_id`, `hook_event_name`,
and `cwd`; a tool event adds `tool_name` and `tool_input`, and
`PermissionRequest` adds `permission`. `SessionEnd` adds `reason` (`shutdown`
on interactive teardown).

```json
{"session_id":"sess_<uuid>","hook_event_name":"SessionStart","cwd":"/repo"}
{"session_id":"sess_<uuid>","hook_event_name":"PreToolUse","cwd":"/repo","tool_name":"execute_bash","tool_input":{"command":"git status"}}
{"session_id":"sess_<uuid>","hook_event_name":"PermissionRequest","cwd":"/repo","tool_name":"execute_bash","tool_input":{"command":"git push"},"permission":{"capability":"shell","command":"git push"}}
{"session_id":"sess_<uuid>","hook_event_name":"SessionEnd","cwd":"/repo","reason":"shutdown"}
```

Hooks live in the payload and are called with `--kiro-home=<home>`; the scripts
also take `--home=` (the notes home, for tests) and `--cwd=` in tests.

## Review

Kiro skills cannot fork into a sub-agent the way a Claude skill can. The Kiro
branch of the shared `review` skill therefore runs `review.ts` to build the
three-field brief (`Scope`, `Task`, `Decisions`) and the change key, then
passes the brief to the `pa-reviewer` sub-agent. With no scope the brief is the
uncommitted change, and only that scoped review carries a key: a named ref,
range, or path list does not see the whole working tree, so it cannot unlock a
commit.

The verdict is recorded from the session store, not from a PostToolUse hook: a
sub-agent run is written as `sub_agent_start` / `sub_agent_complete` with
`subSessionId`, `subAgentName`, `prompt`, `response`, and `status`. The `Stop`
hook runs after the turn and reads the `Change key:` line (16 lowercase hex
characters) in the prompt, or the full brief from the tool result before the
run when the model passed only part of it, and stores one record per key and
sub-session with the `## Verdict` line. The record exists from the next turn
on, so a commit later in the session sees it.

## The commit gate

`PermissionRequest` runs only when the native policy would prompt. The gate
reads the same change key the review saw:

- any git command — allow;
- a commit of a trivial change (at most two files and forty changed lines) or of
  a change with a stored `Approve` — allow;
- an unreviewed or rejected commit, a mixed command, a push, a `gh pr` /
  `release` / `run` write, a config override — no decision, so Kiro asks
  natively. A `gh` read action (`view`, `list` / `ls`, `status`, `diff`, `checks`,
  `search`) passes.

Kiro's unmatched default is `ask`; that is the mechanism the gate relies on.
The native permission rules never give the companion a blanket shell allow.

## Compaction

`PreCompact` stores a manifest — the session notes, the skills the session
used, and the documents to reload — and prints guidance for Kiro's summarizer.
`PostCompact` appends the summary to
`<state>/compact/<session>.summaries.md` and prints the ordered reload list,
which Kiro adds to the conversation. The list ends with a `load_resource` line
for a used skill and says not to re-read working source files.

## Journal

The good path is the `wrap-up` skill:
`node --experimental-strip-types --no-warnings <payload>/platforms/kiro/scripts/journal.ts
path --session=<id>` names this session's entry, and `fs_write` writes it.
Each session has its own file.

The safety net runs on `SessionEnd` for an interactive exit. When the session
has no entry and has material, it writes a payload and detaches
`journal-end.ts write`; that process runs
`kiro-cli chat --agent pa-writer --no-interactive --model claude-haiku-4.5
<prompt>` and writes the entry only when it still does not exist. A
`--no-interactive` or scripted session gets no SessionEnd, so it gets no entry:
run the wrap-up there. A failed writer is silent by design.

## Retro

`/retro` is print-only. The Kiro branch of the shared skill runs
`node --experimental-strip-types --no-warnings <payload>/platforms/kiro/scripts/retro.ts
--session=<id>`, which reads the V3 store and the adapter state: tool calls,
files changed, denied calls, compactions, stored review verdicts, permission
decisions, credit split, context usage, sub-agent runs, hook invocations, the
journal entry, and the model. It writes no files and prints the instruction
plus a `## Session facts` table.

## Permissions

Kiro has a native permission engine, so the adapter adds rules rather than a
second policy layer. Capabilities are `fs_read`, `fs_write`, `shell`, `skill`,
and `subagent`; an unmatched call is `ask`.

- The companion may read the project, `~/agent-notes`, and the payload; it may
  write the project and `~/agent-notes`; it may load any installed skill and
  spawn `pa-reviewer`; it may run the read-only git commands, the test
  commands, and a node script (the adapter scripts include the review brief,
  the retro facts, and the journal path) without a prompt.
- Both agents deny secret paths: `**/.env`, `**/.env.*`, `**/.ssh/**`,
  `**/.aws/**`, `**/*.pem`, `**/id_rsa*`, `**/.netrc`.
- The companion may not write the payload, the `pa-*` agent files, the skill
  folders, or `$KIRO_HOME/settings/`.
- The reviewer denies every `fs_write` and keeps shell for the one test run it
  reports; the PreToolUse gate blocks shell writes the rules cannot see.

The decision log is `<state>/decisions.ndjson`; review records are
`<state>/reviews.json`. State lives in `$KIRO_HOME/persona-agents/state/` and
survives an update. Edit `permissions.rules` in the installed agent file to
tune the rules; a new session picks the change up.

## Gaps

- **Global, unnamespaced skills.** Kiro skill names have no plugin prefix and
  global skills are visible to every Kiro session. The installer avoids
  surprises with its marker and its refusal to overwrite an unowned folder, and
  the reviewer prompt names the checklist skill without a prefix.
- **The secret deny list covers templates.** `**/.env.*` also denies
  `.env.example` and `.env.sample`. Have the owner copy the template into the
  project or loosen the rule when the companion needs to read one.
- **SessionEnd is interactive only.** A headless run gets no automatic journal
  entry; use the wrap-up skill.
- **No PostToolUse for a sub-agent run.** Verdicts are recorded by scanning the
  session store on `Stop`.
- **The V3 session store is undocumented.** The reader locates
  `sessions/*/sess_<id>/messages.jsonl`, ignores unknown payloads, and fails
  soft. The retro and journal lose their source if the layout changes.
- **Kiro skills cannot fork.** The review skill starts `pa-reviewer` as a
  sub-agent instead of a fork.
- **`chat.defaultAgent` is not changed.** A default that names no agent is
  warned about, not fixed.
- **Native rules replace the Pi floor.** There is no per-project policy file
  and no session grant. The owner edits the agent's permission rules to tune
  them.

## Testing

`npm test` runs `tests/kiro-*.test.ts` under plain Node with type stripping.
The suite never starts a Kiro process and never reads the owner's real notes
folder: every script takes `--home=`, `--kiro-home=`, and where needed
`--cwd=` or `--content=`, and each test builds them in a temp dir. The
installer tests install into a temp `KIRO_HOME` and use a fake `kiro-cli` for
the version check.
