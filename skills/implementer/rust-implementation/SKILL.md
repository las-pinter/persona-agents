---
name: rust-implementation
description: Rust build patterns for desktop applications — workspace layout, error handling, async, traits, modules, FFI, resources, testing, and performance.
---

# Rust Implementation

**Common-first:** if `rust-best-practices` is installed at
`~/.agents/skills/rust-best-practices` or `~/.pi/agent/skills/`, follow it
instead of this skill. This skill is the fallback.

Rust-only patterns that sit on top of **code-implementation**. Load both skills for any Rust task.

## Workspace & Crate Layout

- Split large applications into small crates: `app`, `core`, `ui`, `platform`.
- Keep `src/main.rs` thin; put logic in `lib.rs` so tests can call it.
- Pin the toolchain in `rust-toolchain.toml`; keep one MSRV for the workspace.
- Set shared lint and profile config in the workspace root `Cargo.toml`.

## Error Handling

- Use `Result<T, E>` for all fallible work; return `Option<T>` only for absent values.
- Define one error enum per crate with `thiserror`; add context at boundaries.
- Use `anyhow` in binaries and integration tests, not in library APIs.
- No `unwrap`, `expect`, or `panic!` on user input or I/O. Never swallow errors.

## Async vs Threads

- Use `tokio` for I/O-bound work: network, files, timers, and channels.
- Use threads (`std::thread`, `rayon`) for CPU-bound work.
- Do not block inside async tasks; move blocking calls with `spawn_blocking`.
- Prefer message passing over shared mutable state.

## Trait & Ownership Idioms

- Accept `&str` and `&[T]` in arguments; return owned `String` and `Vec<T>` unless borrowing is natural.
- Use `impl Trait` in argument position for generics that appear once.
- Prefer borrowing over cloning; clone only when ownership must move.
- Use newtypes for IDs and units so the type system prevents mixups.

## Module Boundaries & Visibility

- Keep items private by default; expose the smallest public API.
- Re-export the public surface from `lib.rs` with `pub use`.
- Declare modules in one place per crate; avoid deep nested paths.
- Put integration tests in `tests/` so they use only the public API.

## FFI & unsafe Isolation

- Keep all `unsafe` and `extern "C"` code in one module with a safe wrapper.
- Comment every unsafe block with `// SAFETY:` and the exact invariant.
- Convert raw pointers and C strings at the boundary; never leak them inward.
- Prefer a safe crate binding over hand-written FFI when one exists.

## Image Buffers & Resource Lifetimes

- Wrap GPU and OS handles in RAII structs that free on `Drop`.
- Keep buffer dimensions and stride together; check them before every blit.
- Tie buffer lifetime to the surface or texture that owns it.
- Do not hold a reference across an await or a callback that outlives the buffer.

## Testing Seams

- Put pure logic behind traits so tests can inject fakes.
- Use `proptest` for parsers, codecs, and image transforms.
- Keep golden files small; store them under `tests/fixtures/`.
- Gate slow GPU or OS tests behind a feature flag.

## Performance Patterns

- Measure first with `cargo bench` or `criterion`; profile before optimizing.
- Avoid allocation in hot loops; reuse buffers and use `with_capacity`.
- Prefer iterators over index loops, but do not fight the borrow checker for style.
- Check for accidental O(n²) work and N+1 I/O.

## Non-Overlap with code-implementation

This skill does not repeat the language-agnostic workflow. For these headings, load **code-implementation**:

- `## Quick Reference`
- `## Phase 1: Orient` through `## Phase 5: Deliver`
- `## Universal Code Standards`
- `## Testing Standards`
- `## Anti-Patterns`

This skill adds only Rust build patterns. When the two conflict on process, code-implementation wins.
