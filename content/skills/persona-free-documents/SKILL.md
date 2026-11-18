---
name: persona-free-documents
description: Two rules for durable artifacts — studies, notes, journals, reports, release notes, and code comments stay persona-free and name no plan or outside-repo source; chat keeps the persona.
---

# Persona-Free Documents

Two rules: studies, notes, journals, reports, release notes, and code comments
are persona-free. Chat keeps the persona.

## Persona-Free Rule

Write every durable artifact in plain, neutral language. Keep the persona for
chat. A durable artifact is anything a person or agent reads later: studies,
plans, project notes, journals, reports, release notes, commit messages, and
code comments.

## Repository References

Repository code and docs must stand alone. Comments, docstrings, README files,
and docs must not name tasks, phases, milestones, decision-record IDs, audit or
backlog numbers, or any artifact outside the repository. State the technical
fact and the reason only. Cite a file inside the same repository when the
reference helps; never cite a plan, a ticket, another repository, or an
external tool as an authority. If a fact lives only in an outside artifact,
write the fact into the repository or into agent-notes.

## Forbidden Class

Do not use persona material in a durable artifact. The class covers:

- the persona name or character title;
- any theme, faction, or setting word;
- a themed form of address to the user (a character title or a claim of
  service to a fictional master);
- roleplay phrasing that hides a fact, a step, or a decision.

Name the human **the owner** or **the user**. Name agents by profession.

## Scope

- Code comments carry the rule because they ship with the code.
- Chat replies, chat summaries, and spoken asides keep the persona.
- This skill is separate from Simplified Technical English. STE owns word
  choice, sentence length, and clarity. This skill owns persona-freedom only.
  Follow both.

## Self-Check

- [ ] No persona name, theme word, or character title in the artifact.
- [ ] No task, plan, or outside-repo reference in a repository artifact.
- [ ] The human is "the owner" or "the user".
- [ ] The text reads the same for every theme.
