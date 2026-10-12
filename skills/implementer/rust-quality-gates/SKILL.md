---
name: rust-quality-gates
description: Quality gates for Rust code — compile check, lint, format, tests, security, build, structure, config.
---

# Rust Quality Gates

Every Rust implementation must pass these gates before delivery. Run them in this exact order — fix all issues in one gate before advancing to the next.

```
1. Compile Check → 2. Lint & Format → 3. Tests & Coverage → 4. Security Scan → 5. Build Verification
```

## 1. Compile Check — MUST HAVE

- `cargo check --workspace --all-targets --all-features` — zero errors required.
- `cargo check --locked` — the lockfile must be current and used.
- Record `rustc --version` and `cargo --version` for the build.

## 2. Lint & Format — MUST HAVE

- `cargo fmt --check` — formatting must be clean.
- `cargo clippy --all-targets --all-features -- -D warnings` — zero warnings.
- Respect the project's `rustfmt.toml` and `clippy.toml` — never override them.

## 3. Tests & Coverage — MUST HAVE

- `cargo nextest run --all-features` — all tests pass (fall back to `cargo test`).
- `cargo test --doc` — doctests pass.
- `cargo llvm-cov nextest --fail-under-lines 80` — coverage threshold of **80%+**.
- Write tests for all new functionality covering: happy path, failure cases, edge cases, error messages.
- Use **proptest** for property-based testing on parsers, serializers, and any input-processing module.
- Test names describe behavior: `create_order_returns_400_when_inventory_empty` ✅.

## 4. Security Scan — MUST HAVE

- `cargo deny check` — advisories, bans, licenses, and sources are clean. The
  `advisories` check uses the same RustSec database as `cargo audit`, so a
  separate `cargo audit` run is not needed.
- `cargo geiger` — report the unsafe count; justify every new unsafe block.
- Never hardcode secrets; validate ALL inputs at trust boundaries; no string-built shell or SQL.

## 5. Build Verification — MUST HAVE

- `cargo build --workspace --release --locked` — the workspace must build cleanly.
- No `Cargo.toml` → flag to orchestrator; do not create it unrequested.

## Project Structure — RECOMMENDED

- Use a workspace root `Cargo.toml` with a `[workspace]` table for multi-crate projects.
- `src/lib.rs` holds the logic; `src/main.rs` stays thin and calls the library.
- Tests go in `tests/`, benchmarks in `benches/`, runnable samples in `examples/`.

## Documentation — RECOMMENDED

- `cargo doc --workspace --no-deps` — the docs must build with no warnings.
- Add `#![warn(missing_docs)]` and `#![deny(rustdoc::broken_intra_doc_links)]` on public crates.
- Document public items with `///` doc comments. Include examples where useful.

## Pre-commit Hooks — RECOMMENDED

- If the project lacks quality gates, recommend `cargo fmt`, `cargo clippy`, and `cargo nextest`, plus `check-merge-conflict` and `detect-private-key`.
- If `.pre-commit-config.yaml` exists, respect it — do not modify unrequested.

## Config Discovery — IMPORTANT

- Read `Cargo.toml`, `rust-toolchain.toml`, `rustfmt.toml`, `clippy.toml`, `deny.toml`, and `.cargo/config.toml` first.
- Respect the project's existing tool configs — never override them with your own opinionated settings.
- Missing config files are normal; do not create them unrequested.

## MSRV Policy — RECOMMENDED

- The `rust-version` key in `Cargo.toml` is the source of truth for the minimum supported Rust version.
- Verify the build with the pinned toolchain from `rust-toolchain.toml`.
- Do not raise the MSRV without approval.

## Unsafe Policy — RECOMMENDED

- Prefer `#![forbid(unsafe_code)]` on new crates.
- Where `unsafe` is needed, isolate it in one module and comment every block with `// SAFETY:`.
- Use `#![deny(unsafe_op_in_unsafe_fn)]` so each caller states the safety contract.

## Dependency & Feature Hygiene — RECOMMENDED

- Keep the dependency set minimal; add a crate only when the standard library cannot do the job.
- Default features off unless needed; explain every enabled feature flag.
- No duplicate major versions in the tree — check with `cargo tree --duplicates`.
