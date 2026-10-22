/**
 * Permission regression harness for the tool-surface gates.
 *
 * Covers the MCP coverage guard, the uv and cargo quality gates, and the
 * opencode edit and kiro code splits.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	frontmatterDir,
	kiroAllowedTools,
	kiroVerdict,
	loadKiroConfig,
	opencodeResourceVerdict,
	opencodeVerdict,
	repoRoot,
	verdict,
} from "./permission-templates.fixtures.ts";

// ---------------------------------------------------------------------------
// MCP tool coverage guard for the pi researcher.
//
// pi drops every MCP tool that no `--tools` entry matches as soon as ONE
// `mcp__` entry is present. A new server or a typo then fails silently: the
// tool simply disappears. Assert each server in the committed MCP example has
// a covering entry in the researcher template. The committed
// `config/mcp.json.example` is the repo's only committed server list; the
// live `~/.pi/agent/mcp.json` is separate and user-managed, so a server added
// only to the live config is not seen by this guard.
// ---------------------------------------------------------------------------

/** Configured MCP server names from the committed example config. */
function configuredMcpServers(): string[] {
	const raw = fs.readFileSync(path.join(repoRoot, "config", "mcp.json.example"), "utf-8");
	const cfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
	return Object.keys(cfg.mcpServers ?? {});
}

/** The pi `tools:` allowlist of one agent template. */
function piToolList(agent: string): string[] {
	const content = fs.readFileSync(path.join(frontmatterDir, `${agent}.yaml`), "utf-8");
	const { frontmatter } = parseFrontmatter<{ tools?: string[] }>(`---\n${content}\n---\n`);
	return frontmatter.tools ?? [];
}

describe("pi researcher: every configured MCP server is covered by a tool entry", () => {
	test("each mcp.json.example server matches an mcp__<server>__ glob or exact tool", () => {
		const servers = configuredMcpServers();
		assert.ok(servers.length > 0, "the committed MCP example must list at least one server");
		const tools = piToolList("researcher");
		for (const server of servers) {
			const prefix = `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__`;
			const covered =
				tools.includes(`${prefix}*`) ||
				tools.some((tool) => tool.startsWith(prefix) && tool.length > prefix.length);
			assert.ok(covered, `researcher tools must cover MCP server "${server}": add ${prefix}* or an exact tool`);
		}
	});
});

// ---------------------------------------------------------------------------
// Implementer quality-gate tool gates (IMPORTANT regression). The `uv` allow is
// narrowed to the gate subcommands; the mutating forms ask. The scanners stay.
// ---------------------------------------------------------------------------

const UV_GATE_ALLOWED = [
	"uv build",
	"uv build --wheel",
	"uv run pytest",
	"uv run pytest --cov",
	"uv run ruff",
	"uv run ruff check --fix",
	"uv run mypy",
	"uv run mypy --strict",
	"uv run bandit -r .",
	"uv run pip-audit --strict",
];

// `uv pip list` is read-only inventory that the quality-gate skill does not
// order, so no stack allows it.
const UV_PIP_LIST = ["uv pip list", "uv pip list --format json"];

// `uv run` is not a blank check: only the quality-gate tools pass.
const UV_RUN_NON_GATE = ["uv run python -c 'print(1)'", "uv run some-script", "uv run pytest-hack"];

// Read-only sync forms are allowed on pi and opencode; kiro asks by omission.
const UV_SYNC_READONLY = ["uv sync --frozen", "uv sync --offline", "uv sync --frozen --all-extras"];

const UV_MUTATIONS = [
	"uv add requests",
	"uv remove requests",
	"uv sync",
	"uv sync --all-extras",
	"uv lock",
	"uv publish",
	"cd /repo && uv add requests",
];

const CARGO_MUTATIONS = ["cargo audit fix", "cargo deny init", "cd /repo && cargo audit fix"];

const CARGO_SCANNER_ALLOWED = ["cargo audit", "cargo deny check", "cargo llvm-cov", "cargo geiger"];

describe("implementer quality-gate tools: uv and cargo gates", () => {
	test("pi: uv gate subcommands allow; mutations ask", () => {
		for (const command of UV_GATE_ALLOWED) assert.equal(verdict("implementer", command), "allow", command);
		for (const command of UV_MUTATIONS) assert.equal(verdict("implementer", command), "ask", command);
	});

	test("pi: cargo scanners allow; cargo mutations ask", () => {
		for (const command of CARGO_SCANNER_ALLOWED) assert.equal(verdict("implementer", command), "allow", command);
		for (const command of CARGO_MUTATIONS) assert.equal(verdict("implementer", command), "ask", command);
	});

	test("opencode: uv gate subcommands allow; mutations ask", () => {
		for (const command of UV_GATE_ALLOWED) assert.equal(opencodeVerdict("implementer", command), "allow", command);
		for (const command of UV_MUTATIONS) assert.equal(opencodeVerdict("implementer", command), "ask", command);
	});

	test("opencode: cargo scanners allow; cargo mutations ask", () => {
		for (const command of CARGO_SCANNER_ALLOWED) {
			assert.equal(opencodeVerdict("implementer", command), "allow", command);
		}
		for (const command of CARGO_MUTATIONS) assert.equal(opencodeVerdict("implementer", command), "ask", command);
	});

	test("kiro: uv gate subcommands allow; mutations default to ask", () => {
		for (const command of UV_GATE_ALLOWED) assert.equal(kiroVerdict("implementer", command), "allow", command);
		for (const command of UV_MUTATIONS) assert.equal(kiroVerdict("implementer", command), "ask", command);
		for (const command of UV_SYNC_READONLY) assert.equal(kiroVerdict("implementer", command), "ask", command);
	});

	test("all stacks: non-gate `uv run` does not allow", () => {
		for (const command of UV_RUN_NON_GATE) {
			assert.notEqual(verdict("implementer", command), "allow", `pi: ${command}`);
			assert.notEqual(opencodeVerdict("implementer", command), "allow", `opencode: ${command}`);
			assert.notEqual(kiroVerdict("implementer", command), "allow", `kiro: ${command}`);
		}
	});

	test("all stacks: uv pip list is not allowed", () => {
		for (const command of UV_PIP_LIST) {
			assert.notEqual(verdict("implementer", command), "allow", `pi: ${command}`);
			assert.notEqual(opencodeVerdict("implementer", command), "allow", `opencode: ${command}`);
			assert.notEqual(kiroVerdict("implementer", command), "allow", `kiro: ${command}`);
		}
	});

	test("pi/opencode: read-only uv sync forms allow; other sync forms ask", () => {
		for (const command of UV_SYNC_READONLY) {
			assert.equal(verdict("implementer", command), "allow", `pi: ${command}`);
			assert.equal(opencodeVerdict("implementer", command), "allow", `opencode: ${command}`);
		}
		for (const command of ["uv sync", "uv sync --all-extras"]) {
			assert.equal(verdict("implementer", command), "ask", `pi: ${command}`);
			assert.equal(opencodeVerdict("implementer", command), "ask", `opencode: ${command}`);
		}
	});

	test("pi: the uv allow carries the leading `cd` fold like the cargo allow", () => {
		for (const command of ["cd /repo && uv build", "cd /repo && uv run pytest", "cd /repo && uv sync --frozen"]) {
			assert.equal(verdict("implementer", command), "allow", command);
		}
	});

	test("kiro: cargo scanners allow; cargo mutations default to ask", () => {
		for (const command of CARGO_SCANNER_ALLOWED) assert.equal(kiroVerdict("implementer", command), "allow", command);
		for (const command of CARGO_MUTATIONS) assert.equal(kiroVerdict("implementer", command), "ask", command);
	});
});

// ---------------------------------------------------------------------------
// OpenCode edit tree split (IMPORTANT regression): each writer edits only its
// own agent-notes tree; every other path denies.
// ---------------------------------------------------------------------------

describe("opencode: edit allow/deny split", () => {
	test("orchestrator: agent-notes editable, elsewhere deny", () => {
		assert.equal(opencodeResourceVerdict("orchestrator", "edit", "~/agent-notes/orchestrator/journal.md"), "allow");
		assert.equal(opencodeResourceVerdict("orchestrator", "edit", "~/agent-notes/project-notes/foo.md"), "allow");
		assert.equal(opencodeResourceVerdict("orchestrator", "edit", "~/agent-notes/researcher/reports/x.md"), "deny");
		assert.equal(opencodeResourceVerdict("orchestrator", "edit", "src/main.ts"), "deny");
	});

	test("researcher: own agent-notes editable, elsewhere deny", () => {
		assert.equal(opencodeResourceVerdict("researcher", "edit", "~/agent-notes/researcher/x.md"), "allow");
		assert.equal(opencodeResourceVerdict("researcher", "edit", "~/agent-notes/orchestrator/x.md"), "deny");
		assert.equal(opencodeResourceVerdict("researcher", "edit", "src/main.ts"), "deny");
	});
});

// ---------------------------------------------------------------------------
// Kiro `code` allow/ask split (IMPORTANT regression): `code` stays in `tools`
// for reviewer and planner so ask-by-omission applies; it must not be in
// `allowedTools`. Tester and implementer keep the silent allow.
// ---------------------------------------------------------------------------

describe("kiro: code allow/ask split", () => {
	test("reviewer and planner: code is available but not silently allowed", () => {
		for (const agent of ["reviewer", "planner"]) {
			assert.ok((loadKiroConfig(agent).tools ?? []).includes("code"), `${agent}: code must stay available`);
			assert.ok(!kiroAllowedTools(agent).includes("code"), `${agent}: code must not be in allowedTools`);
		}
	});

	test("tester and implementer: code is allowed", () => {
		for (const agent of ["tester", "implementer"]) {
			assert.ok(kiroAllowedTools(agent).includes("code"), `${agent}: code must be in allowedTools`);
		}
	});
});
