---
name: react-quality-gates
description: Quality gates for React and frontend code — typecheck, lint, tests, build, structure, config.
---

# React Quality Gates

Every React implementation must pass these gates before delivery. Run them in
this exact order — fix all issues in one gate before advancing to the next.

```
1. Type Check → 2. Lint → 3. Tests → 4. Build Verification
```

> **Note:** Common React best-practice skills (Vercel React best practices,
> web-design-guidelines, frontend-design, shadcn) are optional context. They
> run alongside this gate; they do not replace it.

## 1. Type Check — MUST HAVE

- `tsc --noEmit` (or the project's configured checker, for example `vue-tsc`) — zero errors required.
- No `any`; no casts without a written reason. The type system must carry the shape.
- Respect the project's `tsconfig.json` — never override it.

## 2. Lint — MUST HAVE

- `eslint .` — zero warnings (respect the project's `eslint.config.*` or `.eslintrc.*`).
- `prettier --check .` when the project formats with Prettier.
- Respect the project's lint and format config — never override it.

## 3. Tests — MUST HAVE

- Run the project's runner (`npm test`, `vitest`, `jest`, or `pnpm test`).
- Coverage threshold of **80%+** when the runner reports coverage.
- Write tests for all new functionality: happy path, failure cases, edge cases, error messages.
- Test naming follows the **test-case-structure** skill.

## 4. Build Verification — MUST HAVE

- `npm run build` (or the project's configured build) — the app must build cleanly.
- No `package.json` → flag to orchestrator; do not create it unrequested.

## Structure & Accessibility — RECOMMENDED

- Follow existing component patterns — one responsibility per component.
- Respect hooks rules: no conditional hooks, no hooks in loops, correct dependency arrays.
- Use semantic HTML and keep the UI accessible (WCAG).

## Config Discovery — IMPORTANT

- Read `package.json`, `tsconfig.json`, the ESLint config, and the test config first.
- Respect the project's existing tool configs — never override them.
- Missing config files are normal; do not create them unrequested.
