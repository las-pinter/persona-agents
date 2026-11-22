#!/usr/bin/env bash
# Materialize a small Rust repository with one uncommitted change to review.
# Runs with cwd = the eval run workspace; the fixtures sit beside this case.
set -euo pipefail

case_dir="$(cd "$(dirname "$0")" && pwd)"

git init -q .
cp "$case_dir/../fixtures/rust-config/Cargo.toml" .
mkdir -p src
cp "$case_dir/../fixtures/rust-config/src/lib.rs" src/lib.rs
git add -A
git -c user.name="review eval" -c user.email="review-eval@localhost" commit -qm "base"

cp "$case_dir/../fixtures/rust-config-change/src/lib.rs" src/lib.rs
