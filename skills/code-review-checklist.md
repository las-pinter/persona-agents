---
name: code-review-checklist
description: Language-agnostic multi-pass checklist for thorough code reviews covering correctness, security, design, and maintainability.
---

# Skill: Code Review Checklist

Run passes in order. Stop and flag if Pass 1 fails — do not proceed to deeper passes on fundamentally broken code.

## Pass 1 — Intent
- [ ] Do I understand what this change does and *why*?
- [ ] Does the approach make sense at a high level?
- [ ] Is the scope appropriate — not too large, not solving the wrong problem?

## Pass 2 — Correctness
- [ ] Logic is sound; no obvious bugs or missed edge cases
- [ ] Null/undefined/empty inputs are handled
- [ ] Boundary conditions are covered (off-by-one, empty collections, max values)
- [ ] Error cases are handled and surfaced — not silently swallowed
- [ ] Concurrent access / race conditions considered where relevant
- [ ] Resource cleanup: no leaked handles, connections, or memory

## Pass 3 — Security
- [ ] All external input is validated and sanitized before use
- [ ] No secrets, credentials, or PII hardcoded or logged
- [ ] Authentication and authorization enforced on protected paths
- [ ] No direct string concatenation into queries, commands, or HTML
- [ ] Dependencies introduced are not flagged for vulnerabilities

## Pass 4 — Design
- [ ] Change is in the right place (correct layer, module, file)
- [ ] Follows existing patterns — deviations are intentional and explained
- [ ] No unnecessary abstraction or missing abstraction
- [ ] No N+1 queries, unbounded loops over external calls, or missing pagination

## Pass 5 — Maintainability
- [ ] Names communicate intent without needing comments
- [ ] Comments explain *why*, not *what*
- [ ] No dead code, commented-out blocks, or untracked TODOs
- [ ] Test coverage exists for new behavior; tests are meaningful

## Pass 6 — Operational Readiness (production-bound changes only)
- [ ] Failure modes are defined
- [ ] External calls have timeouts and retry/backoff
- [ ] New behavior is observable (loggable/traceable/measurable)
- [ ] No breaking changes to public interfaces without a migration path

## Comment Labels
Use these on all review comments so authors know what requires action:
- `blocking:` — must fix before merge
- `significant:` — should fix; meaningful quality concern
- `minor:` — small improvement; fix if easy
- `suggestion:` — optional; author's call

See `shared-vocabulary.md` for severity definitions.
