# Reviewer evals

A `claude plugin eval` suite for the reviewer's behavior. It is not part of
`npm test`; run it when the reviewer rules change.

## The case

`reviewer-skills/` checks that the reviewer loads a skill matching the change
and names it:

- `scaffold.sh` builds a small Rust crate with one uncommitted change.
- `prompt.md` runs the `review` skill on that change.
- The graders require a `## Skills loaded` section naming a Rust skill, the
  `Skill` call for that skill in the trace, the panic that change introduces,
  and a `## Verdict`.

Without a shell the reviewer reads the changed file rather than a git diff, so
the case covers skill selection and the finding, not the diff-reading flow.

`rust-skill-plugin/` is a one-skill plugin (`rust-quality-gate`). The eval
sandbox has a fresh `HOME`, so it cannot see the owner's installed skills; the
case ships its own so the run is self-contained.

`case.yaml` lists `plugins: ["../..", "rust-skill-plugin"]`: the first loads
the plugin under test into the eval child (it is not loaded by itself), and the
second adds the fixture skill plugin.

## Run it

```sh
claude plugin eval . --case reviewer-skills --scaffold --runs 1 \
  --ablation none --no-publish --trust-plugin
```

- `--scaffold` is required: without it the Rust change is never created.
- One run keeps the cost down. The case is a behavioral smoke test, not a
  benchmark.
- `--trust-plugin` answers the first-run trust prompt; it is for a suite this
  repository authored.
- The run has no shell unless the machine has a sandbox backend (bubblewrap
  and `socat`). The eval refuses a Bash grant it cannot confine. Without one
  the reviewer reads the change without a git diff and cannot run `cargo
  test`. To give it a shell, install the backend, add `Bash` to the case's
  `prompt.md` `allowed_tools`, and pass `--allow-tools Bash`.

## Failing check

The case fails when the reviewer does not name a matching skill. To see it
fail, remove the skill-loading rule from `content/professions/reviewer.md`, the
reviewer's one home for its rules; `skills-loaded`, `skills-section`, and
`skill-called` turn red while `verdict` stays green.
