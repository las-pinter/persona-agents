---
name: python-quality-gates
description: Quality gates for Python code — type checking, lint, tests, security, build, structure, config.
---

# Python Quality Gates

Every Python implementation must pass these gates before delivery. Run them in this exact order — fix all issues in one gate before advancing to the next.

```
1. Type Check → 2. Lint & Format → 3. Tests & Coverage → 4. Security Scan → 5. Build Verification
```

## 1. Type Check — MUST HAVE

- `mypy --strict` (or the project's `[tool.mypy]` config) — zero errors required.
- If the project uses Pyright or Pyrefly, use the project's configured tool.
- Type hints required on ALL public functions — parameters, return values, and internal helpers.
- No `Any` unless absolutely unavoidable — document why with `# type: ignore[no-any-...]`.

## 2. Lint & Format — MUST HAVE

- `ruff check --fix` — zero warnings (respect `[tool.ruff]` in pyproject.toml).
- `ruff format` — formatting must be clean.
- Default rulesets: `E`, `F`, `I`, `B`, `UP`, `SIM`, `COM` (respect project overrides).
- Replace legacy tools (flake8, black, isort) with Ruff unless the project explicitly uses them.

## 3. Tests & Coverage — MUST HAVE

- `pytest --cov` — all tests pass; coverage threshold of **80%+**.
- Write tests for all new functionality covering: happy path, failure cases, edge cases, error messages.
- Use **Hypothesis** for property-based testing on parsers, serializers, authentication logic, and any input-processing modules.
- For async code, use `pytest-asyncio` with `auto` mode.
- Test names describe behavior: `test_create_order_returns_400_when_inventory_empty` ✅.

## 4. Security Scan — MUST HAVE

- `pip-audit --strict` — no known CVEs in project dependencies.
- `bandit -r` — no SAST findings at MEDIUM severity or higher.
- Never hardcode secrets; validate ALL inputs at trust boundaries; parameterize ALL queries — no string concatenation in SQL or shell.

## 5. Build Verification — MUST HAVE

- `uv build` (or `pip install .` if uv unavailable) — the package must install cleanly.
- No `pyproject.toml` → flag to orchestrator; do not create it unrequested.

## Project Structure — RECOMMENDED

- Default to **`src/` layout** for new packages: `src/my_package/` with tests in `tests/` at project root.
- `pyproject.toml` is the **single source of truth** for all tool configs.
- `__init__.py` declares `__all__` explicitly (public API surface) — no logic in `__init__.py`.

## Documentation — RECOMMENDED

- **Google-style** docstrings (general projects) or **NumPy-style** (scientific/data projects) on all public functions.
- Every docstring includes: what the function does, Args, Returns, Raises (if applicable).
- Use type hints alongside docstrings — the type checker validates them.
- If the project has a `docs/` directory or uses Sphinx/MkDocs, update relevant docs.

## Pre-commit Hooks — RECOMMENDED

- If setting up a new project or the project lacks quality gates, recommend: `ruff check` + `ruff format`, `mypy` (or the project's type checker), `trailing-whitespace`, `end-of-file-fixer`, `check-merge-conflict`, `detect-private-key`.
- If pre-commit hooks already exist in `.pre-commit-config.yaml`, respect them — do not modify unrequested.

## Config Discovery — IMPORTANT

- Always check `pyproject.toml` first for project tool configurations (mypy, ruff, pytest, etc.).
- Respect the project's existing tool configs — never override them with your own opinionated settings.
- If `pyproject.toml` does not exist, check for `setup.cfg` or `tox.ini` for legacy config.