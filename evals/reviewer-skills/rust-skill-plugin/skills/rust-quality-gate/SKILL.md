---
name: rust-quality-gate
description: Rust quality gate for reviewing Rust changes. Covers panic paths such as unwrap and indexing, ownership, and error handling.
---

# Rust quality gate

When you review Rust code:

- Flag `unwrap`, `expect`, and indexing that can panic on input the program
  does not control.
- Flag error handling that turns a failure into a silent default.
- Prefer `Result` with `?` and a typed error at API boundaries.
