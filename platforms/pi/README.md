# Pi adapter internals

This file describes how the Pi side is built, for maintainers. The root
[README.md](../../README.md) covers install and use.

The Pi adapter ships the same agent as the Claude plugin, from the same
`content/` tree: one companion that plans, implements, tests, reviews, and
commits with the owner, in the voice of a persona theme. The Claude adapter
(`platforms/claude/`) puts the shared content behind hooks; this one puts it
behind one Pi extension. Nothing in `content/` knows which harness runs it.

## Layout

- **Extension** (`platforms/pi/extensions/index.ts`): the wiring only. It
  registers `--agent` and `--persona`, then connects four events and two
  commands to the pure modules below. All logic lives in the shared modules
  and the Pi-only scripts.
- **Scripts** (`platforms/pi/scripts/`): the Pi-only modules, pure TypeScript
  with no Pi imports, so `node:test` can exercise every decision without
  starting a Pi process.
  - `profile.ts` — the agent ids, their tools, and what they may do.
  - `context.ts` — the Pi platform note over the shared prompt builder.
  - `policy.ts` — the permission gate: floors, rules, grants, doctrine.
  - `commands.ts` — the `/permissions` argument grammar.
  - `paths.ts` — the package paths; `journal-writer.ts` — the detached writer.
- **Shared modules** (`platforms/shared/`): the logic every adapter uses.
  - `shell/` — the shell lexer, the nested construct grammar, and the gate
    classification. The Claude doctrine hook and the Pi gate both import it, so
    one parser owns every safety decision.
  - `notes/` — the notes tree, the startup read list, the journal paths, and
    the journal safety-net material.
  - `compaction/` — the reload manifest.
  - `review/` — the change, the brief, the verdict, and the commit gate.
  - `retro/` — the session facts and the retro instruction.
  - `context/` — the prompt sections built from `content/`; each adapter adds
    its platform note.
- **Types** (`platforms/pi/types/pi-api.d.ts`): a mirror of the Pi extension
  API this package uses, so a renamed event fails `npm run typecheck` instead
  of failing silently in a session. Pi supplies the real module at runtime.

## Entry point

```bash
pi install <source>            # npm or git; package.json carries the pi block
pi --agent persona-agents:companion
```

`package.json` has no separate manifest: the `pi` block points at the extension
and at `content/skills`, which Pi advertises and loads on demand.

`--agent persona-agents:<name>` resolves at session start. An id in the
namespace that names no profile refuses the session and lists the known
agents. A session without the flag gets no sections, no gate, and no commands:
a plain Pi session is unchanged.

The profile decides the tools: the companion adds `read`, `bash`, `edit`,
`write`, `grep`, `find`, `ls` to the user's selection; the reviewer drops
`edit` and `write` and keeps `bash` for the one test run it reports. Tools the
user enabled (MCP, other extensions) stay enabled.

## Events

| Event | Job |
| --- | --- |
| `session_start` | Resolve the profile, the theme, and the notes folder; set the tools; load the policy; show the footer. A bad theme or an unreadable policy refuses the agent and says why. |
| `before_agent_start` | Set the `profession`, `persona`, and `platform` prompt sections (Pi diffs them, so the cached prefix survives), and send the read list as one message on the first run and after a compaction. |
| `tool_call` | The gate. Allow, ask with `ctx.ui.select`, or block. A deny from the hook wins; there is no second permission system under it. An allowed `git commit` of an unreviewed, non-trivial change asks first. |
| `session_before_compact` | Build the reload manifest from the branch and save it, then let Pi summarize with the manifest's focus. |
| `session_compact` | Record the compaction, and send the reload list at once: steered mid-run, stored when idle. |
| `session_shutdown` | On `quit`, start the detached journal writer when the session has no entry. |

The read list is paths and short facts, never contents: the companion reads
the files itself. `notes.ts` builds it from the project rules, the summary,
the last three journal days, the open session notes, and the unfinished
studies.

## Review

The reviewer is a separate Pi process with its own context, so it judges the
code without the author's reasoning.

- **`agents/reviewer.md`** holds the prompt body byte-for-byte as the Claude
  agent file (`tests/pi-package.test.ts` fails when they drift) plus Pi
  frontmatter: `tools: read, grep, find, ls, bash`. Bash stays because the
  reviewer runs the test suite once; there is no Edit or Write tool at all.
- **`scripts/review.ts`** is pure: it reads a diff and a status into a
  `Change`, names it with a 16-character hash (`reviewKey`), parses the
  verdict, and decides the gate.
- The review starts from a **three-field brief**, never a checklist: `Scope`
  (a ref, a range, or paths), `Task` (one line: goal and study task id), and
  `Decisions` (the file that holds the owner decisions, or `none`).
  `normalizeScope` cuts the scope at the first label (`Check:`), the first line
  break, or the first option token (`--all`), and returns what it cut, so the
  author hears what went nowhere. A scope that is plain prose survives that cut;
  the reviewer then says the scope does not resolve and reviews what it can.
  The reviewer is told the brief is the author's view, not its checklist.
- **`Task` and `Decisions` are filled when the author leaves them out**: the
  decisions file is the single study at stage `in-progress` in
  `studies/index.md` (two in progress names `none` and both titles, never a
  guess), and the task is that study's `<title> - <Next action>`, else the
  commit subjects of the scope cut to one line.
- The **`review` tool** takes `scope`, `task`, and `decisions`; the `/review`
  command takes a bare scope or `scope=` / `task=` / `decisions=` labels, and a
  quoted value may hold a label of its own. Both spawn
  `pi --extension <this file> -p --no-session --agent persona-agents:reviewer
  --tools read,grep,find,ls,bash --append-system-prompt <body> <task>`. Passing
  `--extension` means the reviewer profile and the policy apply even when the
  package is not installed; the tool list is a second, structural guarantee.
- The child gets **600 seconds** (`REVIEWER_TIMEOUT_MS`). A killed child, a
  non-zero exit, or a clean exit with no text is reported as a failure line
  (`reviewerFailure`), so a silent child can never arrive as an empty review.
- The verdict is read from the reviewer's `## Verdict` line and **stored against
  the key of the exact change** (a session entry, restored on reload), so a
  review covers what it reviewed and nothing else. An untracked file edited
  after its review changes the key. A review with a named ref, range, or path
  scope names no key: it did not see the whole working tree, so it does not
  unlock a commit.

**The commit gate.** When the companion runs a `git commit` that policy allows,
the extension reads the change and asks unless the change is trivial (at most
two files and forty changed lines) or an `Approve` covers that exact key. The
dialog offers: run the review now, commit anyway, stop asking for this session,
or cancel. The gate never blocks a commit on its own tooling: if git fails, the
commit proceeds.

## Compaction

A summary is lossy; the files are not. Before Pi compacts, the companion
records what must survive, and after the summary lands it says what to read
again:

1. **`session_before_compact`** builds a manifest from Pi's structured branch
   entries — never by scraping a transcript: the skills the session read or
   named (`…/skills/<name>/SKILL.md`, `/skill:<name>`), the session notes file
   it wrote last, and the documents to reload (project rules and summary, the
   notes it read, the linked study, the pinned paths).
2. The same call adds a **focus to Pi's own summarizer**: keep the current
   task, the plan step, and the open decisions, and name the session notes path
   verbatim. Pi's `session_before_compact` cannot append instructions, so the
   extension calls the exported
   `compact(preparation, model, apiKey, headers, instructions, signal)` instead
   of the default path. A missing model, missing auth, or any failure falls
   back to Pi's default summary — the reload list still recovers the plan from
   the files.
3. **`session_compact`** sends the reload list immediately: `deliverAs:
   "steer"` when a turn is running, a stored message when the session is idle.
   The list is ordered (session notes, skills, documents) and ends with "do not
   re-read working source files".

The manifest follows the branch: it is built from the entries that are actually
in context, so `/tree` navigation and `/fork` cannot point the reload at
another branch's plan. The profession, persona, and platform note are prompt
sections rebuilt every run, so they are never part of what compaction replaces.

## Journal

A session that ends without a wrap-up still leaves an entry.

- **The good path** is the `wrap-up` skill: `journal` with `action: "path"`
  gives this session's entry path (today's or yesterday's entry if one exists,
  else a new one), then `action: "write"` saves the whole entry. The tool writes
  the standard format; nothing else in the plugin touches the journal tree.
- **The safety net** runs on `session_shutdown` with reason `quit`, and only for
  the companion. If the session has no entry and has material, it writes a
  payload to `<pi agent dir>/persona-agents/journal-<session>.json` and detaches
  `node --experimental-strip-types platforms/pi/scripts/journal-writer.ts`. The
  writer runs one headless Pi request (`-p -nt --no-session`, no tools), and
  writes the entry only when it still does not exist. The material is capped:
  8k characters of session notes, 20k of compaction summaries, 20k of the
  conversation after the last compaction. A failure is silent by design.
- A `/new`, `/resume`, or `/reload` does not trigger the writer: those end a
  runtime, not a session.

## Retro

`/retro` is print-only. It reads the facts rather than the model's memory: the
decisions log for this session (`verdict`, `source`, `reason` per tool call),
the tool calls and changed files from the branch entries, the compactions, the
stored review verdicts, and the journal entry when one exists. `scripts/retro.ts`
does the counting and the caps; the command sends the facts plus the instruction
to write nothing durable.

## Permissions

Pi has no permission engine, so this gate is the whole policy. Layers, first
hit wins:

1. **Floor** — compiled in, no file can loosen it:
   - credential and secret paths, on the path tools and on the words of a
     shell command (`.env.example` and the other templates are not secrets);
   - destructive commands matched at command position, so a commit message
     that mentions `shutdown` is not a dangerous command: `mkfs`,
     `dd of=/dev/`, a fork bomb, `shutdown`, `chmod 777`;
   - a remote script piped to a shell (`curl … | sh`);
   - any write to the gate's own machinery — git hooks, Pi settings, the
     extension folder, and the policy files — through a file tool or a shell
     redirect.
2. **Rules** — your files, project before user, file order, first match:
   - `<pi agent dir>/persona-agents/policy.json`
   - `<repo>/.pi/persona-agents/policy.json` (only when the project is trusted)
3. **Session grants** — the rules added from an ask with "Always this
   session".
4. **Doctrine** — the built-in default for the profile: the companion runs
   plain git history, asks on a publish, and writes inside the project and the
   notes; the reviewer is read-only.

A shell redirect is a write: `> out.log` inside the project is allowed, `>
~/.bashrc` is denied, and a redirect into a gate file is denied by the floor.

A rule is `{ tool, match, verdict, reason? }`, where `match` is a regular
expression source tested against:

- `bash` — every segment as parsed, then the segment with its wrappers
  stripped, so `^git push` fires on `cd api && sudo git push`;
- path tools — the path arguments, `~` expanded;
- other tools — the JSON of the input.

A bad policy file is refused, not ignored: while it does not parse, the gate
denies every call and names the file and the entry. Use `/permissions` to list
the effective rules with their scope and line, `check` to explain one command,
and `allow|ask|deny` to append a rule.

Every ask and deny, and every allow when `PERSONA_AGENTS_DEBUG=1`, appends one
JSON line to `<pi agent dir>/persona-agents/decisions.ndjson`. A log write
failure never blocks a tool call.

There is no UI in print, JSON, or RPC mode, so an ask becomes a deny there.

## Environment

| Variable | Meaning |
| --- | --- |
| `PERSONA_AGENTS_THEME` | The persona theme, when `--persona` is absent. |
| `PERSONA_AGENTS_DEBUG=1` | Log allowed decisions too. |
| `PI_CODING_AGENT_DIR` | The Pi agent dir: policy file, decisions log. `PI_CODING_AGENT` is pi's own `"true"` marker and is never a path. |
| `PI_SESSION_ID` | The session id recorded with each decision and journal line. |

## Testing

`npm test` runs `tests/pi-*.test.ts` under plain Node with type stripping.
The suite never starts a Pi process and never reads the owner's real notes
folder: every module takes its home, notes folder, and policy files as
arguments, and each test builds them in a temp dir. `tests/pi-package.test.ts`
keeps the `pi` manifest equal to what the package ships and asserts that
`platforms/shared/shell` holds the only copy of the parser.
