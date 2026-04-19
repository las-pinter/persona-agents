---
name: code-review-checklist
description: Structured checklist for reviewing code changes thoroughly and consistently.
---

# Skill: Code Review Checklist

Use this checklist when reviewing code. Not every item applies to every PR — focus on what's relevant.

## 1. PR Overview (First Pass)

- Does the PR description clearly explain what and why?
- Do all changes logically belong in this PR (no unrelated changes)?
- Is the scope appropriate — small enough to review thoroughly?
- Does it match the linked ticket/issue/spec?
- Are README, docs, or API specs updated if behavior changed?

## 2. Design & Architecture

- Does the overall design make sense? Do the pieces interact correctly?
- Does it follow existing architectural patterns in the codebase?
- Does it belong here, or should it be a library/shared module?
- Does it make future changes easier or harder?

## 3. Correctness & Functionality

- Does the code do what the developer intended?
- Are edge cases handled?
- Are there potential race conditions, deadlocks, or concurrency issues?
- Does it handle failure modes gracefully (errors, timeouts, partial failures)?

## 4. Complexity

- Is any function/class more complex than it needs to be?
- Does each function/class do one thing (Single Responsibility Principle)?
- Can a new developer understand this code quickly?
- Is there over-engineering or speculative generality (YAGNI)?

## 5. Security

- Are all user inputs validated and sanitized?
- Is authentication/authorization enforced correctly?
- Is sensitive data (PII, credentials, tokens) handled safely — not logged, not exposed?
- Are there SQL injection, XSS, or other injection risks?

## 6. Tests

- Are tests included in the same PR as the code?
- Do tests cover the happy path, failure cases, and edge cases?
- Will tests actually fail when the code is broken?
- Are tests readable and do they reflect real-world scenarios?

## 7. Error Handling & Resilience

- Are errors caught and handled explicitly (not swallowed silently)?
- Are error messages meaningful and actionable?
- Do optional features degrade gracefully without breaking core flows?

## 8. Performance

- Are there unnecessary database calls, N+1 queries, or redundant network requests?
- Is caching used appropriately?
- Are there obvious algorithmic inefficiencies?
- Focus on the 20% of optimizations that produce 80% of results — don't over-optimize.

## 9. Naming & Readability

- Are variable, function, and class names descriptive and unambiguous?
- Is the code self-explanatory, or does it require excessive comments to understand?

## 10. Comments & Documentation

- Do comments explain why, not what?
- Are there outdated comments or TODOs that can be removed?
- Is public API / module-level documentation present and accurate?

## 11. Style & Consistency

- Does the code follow the team's style guide and conventions?
- Is formatting consistent with the surrounding codebase?
- Style-only nits should be prefixed with "Nit:" and never block a PR alone.

## 12. Observability & Operations

- Are new features covered by logging, metrics, or alerts?
- Are log statements at appropriate levels (not logging PII)?

## Reviewer Conduct

- Read every changed line — don't skim.
- Look at changes in the context of the whole file/system, not just the diff.
- Raise out-of-scope issues as separate tasks; don't block the PR for them.
- Prefer asking questions over making demands.
- Prefix nitpicks with "Nit:". Use "we"/"this line" instead of "you".
- Acknowledge good work — not just problems.

## PR Type Variations

- **Feature PRs**: full checklist + migration reversibility + monitoring additions
- **Bug fix PRs**: verify root cause is addressed, not just symptoms; regression test added
- **Refactor PRs**: behavior must be unchanged; test coverage should increase or stay same
- **Dependency updates**: check changelog for breaking changes and security advisories
