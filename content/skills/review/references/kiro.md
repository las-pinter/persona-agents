# Review on Kiro CLI

You are the companion. The review runs in a separate context with the
`pa-reviewer` sub-agent, so it judges the change without your reasoning.

## Steps

1. Build the brief. Run this with the shell tool, from the repository root:

   ```sh
   node --experimental-strip-types --no-warnings {{PERSONA_AGENTS_KIRO_ROOT}}/platforms/kiro/scripts/review.ts "<scope>"
   ```

   Replace `<scope>` with the scope the owner named; when none was named, drop
   the argument: an empty scope is the uncommitted change. Do not pass `HEAD`;
   `git diff HEAD...HEAD` is empty, while the commit gate watches the working
   tree. The argument is a scope only: a ref, a commit range, or paths. The
   script cuts anything that is not a scope, fills the missing `Task` and
   `Decisions` from the project notes, names the change key, and prints the
   reviewer task. It writes its warnings (dropped text, a derived field) to
   stderr; tell the owner those in one line.

   Do not build the brief yourself. Without the script the brief has no change
   key, so the Stop hook cannot record the verdict and the commit will ask. A
   review of a named ref, range, or paths names no key either: it did not see
   the whole uncommitted change, so it does not unlock a commit of it.

2. Start the `pa-reviewer` sub-agent with the printed task verbatim, including
   the final `Change key:` line. Do not add a checklist, your own risk list, or
   your reasoning: the brief says what was done and where, never what to check.
   The companion's tools list allows only this sub-agent.

3. Print the reviewer's text in chat. Its `## Verdict` line is the result: an
   `Approve`, `Request Changes`, or `Reject`, with findings.

4. Fix the findings in one batch. Then run the review again on the new change.
   A re-review is a fresh full review with the same brief; nothing from the
   earlier review is passed to it.

5. The Stop hook records the verdict against the exact change key. A commit of
   that same change can then run without a prompt; an edit changes the key, so
   the commit asks again.

## Rules

- The reviewer is read-only. Its shell cannot write and it has no file-write
  tool.
- A review that asked for changes still lets you commit only with the owner's
  approval; the commit gate asks.
- Never review your own change in place of the sub-agent.
