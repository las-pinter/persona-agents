/**
 * Permission regression harness for the tool-surface gates.
 *
 * Covers the MCP coverage guard, the herdr allow and plugin gates, the uv and
 * cargo quality gates, and the opencode edit and kiro code splits.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	frontmatterDir,
	hasOpenCodeRule,
	kiroAllowedTools,
	kiroDeniedCommands,
	kiroVerdict,
	loadKiroConfig,
	loadOpenCodeRules,
	opencodeGlob,
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
// `settings/mcp.json.example` is the repo's only committed server list; the
// live `~/.pi/agent/mcp.json` is separate and user-managed, so a server added
// only to the live config is not seen by this guard.
// ---------------------------------------------------------------------------

/** Configured MCP server names from the committed example config. */
function configuredMcpServers(): string[] {
	const raw = fs.readFileSync(path.join(repoRoot, "settings", "mcp.json.example"), "utf-8");
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
// OpenCode herdr allow anchoring (BLOCKER regression). The allow must start the
// command. A leading `*` let `mv x .../herdr` match the allow and override the
// earlier cp/mv ask.
// ---------------------------------------------------------------------------

const HERDR_PATH_BYPASS = ["mv x /home/dev/.local/bin/herdr", "cp x y/.local/bin/herdr"];

// The ` *` wildcard allows are gone; on raw-match stacks an argument-bearing
// herdr call matches no allow and falls to the platform default ask.
const HERDR_BARE_COMMANDS = [
	"herdr agent rename",
	"herdr pane split",
	"herdr pane send-keys",
	"herdr agent send-keys",
	"herdr pane send-text",
	"herdr agent start",
	"herdr agent prompt",
];

const HERDR_ARG_COMMANDS = [
	"herdr agent rename w1:p1 overseer",
	"herdr pane split --current --direction right --cwd /repo --no-focus",
	"herdr pane send-keys w1:p1 ctrl+x",
	"herdr agent send-keys reviewer enter",
	"herdr pane send-text w1:p1 theme-orchestrator",
	"herdr agent start reviewer --kind codex --pane w1:p1",
	"herdr agent prompt reviewer Review the diff --wait --timeout 120000",
];

// The commands that must stay gated after the wildcard allows are removed.
const HERDR_STILL_DENY = ["herdr server stop", "herdr server stop now", "herdr --machine test agent list"];
const HERDR_STILL_ASK = ["herdr pane run scripts/test.sh", "herdr pane close w1:p1"];

// kiro and opencode match the RAW command string. With the wildcard allows gone,
// a compound that starts with an argument form cannot ride an allow. The crude
// embedded denies are gone too, so quoted prompt text is not denied.
const HERDR_COMPOUND_BYPASS = [
	"herdr agent rename w1:p1 overseer; rm foo",
	"herdr agent rename w1:p1 overseer; herdr server stop",
	"herdr agent rename w1:p1 overseer; herdr server stop --force",
	"herdr agent rename w1:p1 overseer; herdr plugin install x",
	"herdr agent rename w1:p1 overseer && herdr --machine prod agent list",
];
const HERDR_COMPOUND_PLAIN = "herdr agent rename w1:p1 overseer";

describe("opencode overseer: bare herdr forms allow; argument forms ask", () => {
	test("bare herdr forms have explicit allow rules", () => {
		for (const resource of HERDR_BARE_COMMANDS) {
			assert.ok(hasOpenCodeRule("overseer", resource, "allow"), `missing {shell, ${resource}, allow}`);
		}
	});

	test("bare herdr forms allow", () => {
		for (const command of HERDR_BARE_COMMANDS) {
			assert.equal(opencodeVerdict("overseer", command), "allow", command);
		}
	});

	test("argument herdr forms ask (no wildcard allow)", () => {
		for (const command of HERDR_ARG_COMMANDS) {
			assert.notEqual(opencodeVerdict("overseer", command), "allow", command);
			assert.equal(opencodeVerdict("overseer", command), "ask", command);
		}
	});

	test("pane run and pane close stay ask", () => {
		for (const command of HERDR_STILL_ASK) {
			assert.notEqual(opencodeVerdict("overseer", command), "allow", command);
			assert.equal(opencodeVerdict("overseer", command), "ask", command);
		}
	});

	test("server stop and --machine stay deny", () => {
		for (const command of HERDR_STILL_DENY) {
			assert.equal(opencodeVerdict("overseer", command), "deny", command);
		}
	});
});

describe("kiro overseer: bare herdr forms allow; argument forms ask", () => {
	function kiroAllowedCommands(agent: string): string[] {
		return loadKiroConfig(agent).toolsSettings?.shell?.allowedCommands ?? [];
	}

	test("bare herdr forms are in allowedCommands", () => {
		const allowed = kiroAllowedCommands("overseer");
		for (const resource of HERDR_BARE_COMMANDS) {
			assert.ok(allowed.includes(resource), `missing allowedCommands ${resource}`);
		}
	});

	test("bare herdr forms allow", () => {
		for (const command of HERDR_BARE_COMMANDS) {
			assert.equal(kiroVerdict("overseer", command), "allow", command);
		}
	});

	test("argument herdr forms ask (no wildcard allow)", () => {
		for (const command of HERDR_ARG_COMMANDS) {
			assert.notEqual(kiroVerdict("overseer", command), "allow", command);
			assert.equal(kiroVerdict("overseer", command), "ask", command);
		}
	});

	test("pane run and pane close stay ask", () => {
		for (const command of HERDR_STILL_ASK) {
			assert.notEqual(kiroVerdict("overseer", command), "allow", command);
			assert.equal(kiroVerdict("overseer", command), "ask", command);
		}
	});

	test("server stop and --machine stay deny", () => {
		for (const command of HERDR_STILL_DENY) {
			assert.equal(kiroVerdict("overseer", command), "deny", command);
		}
	});
});

describe("opencode/kiro overseer: argument and compound herdr forms fail safe to ask", () => {
	test("opencode: rename and send-keys arguments ask", () => {
		assert.equal(opencodeVerdict("overseer", "herdr agent rename w1:p1 overseer"), "ask");
		assert.equal(opencodeVerdict("overseer", "herdr pane send-keys w1:p1 ctrl+x"), "ask");
	});

	test("kiro: rename and send-keys arguments ask", () => {
		assert.equal(kiroVerdict("overseer", "herdr agent rename w1:p1 overseer"), "ask");
		assert.equal(kiroVerdict("overseer", "herdr pane send-keys w1:p1 ctrl+x"), "ask");
	});

	test("opencode and kiro: the exact bare rename still allows", () => {
		assert.equal(opencodeVerdict("overseer", "herdr agent rename"), "allow");
		assert.equal(kiroVerdict("overseer", "herdr agent rename"), "allow");
	});

	test("opencode and kiro: a compound after an argument rename cannot ride an allow", () => {
		for (const command of HERDR_COMPOUND_BYPASS) {
			assert.notEqual(opencodeVerdict("overseer", command), "allow", command);
			assert.equal(opencodeVerdict("overseer", command), "ask", command);
			assert.notEqual(kiroVerdict("overseer", command), "allow", command);
			assert.equal(kiroVerdict("overseer", command), "ask", command);
		}
	});

	test("opencode and kiro: quoted prompt text is not denied", () => {
		const command = 'herdr agent prompt reviewer "explain the plugin system"';
		assert.notEqual(opencodeVerdict("overseer", command), "deny", command);
		assert.notEqual(kiroVerdict("overseer", command), "deny", command);
	});

	test("pi: argument forms still allow; the same compounds deny", () => {
		for (const command of HERDR_COMPOUND_BYPASS.slice(1)) {
			assert.equal(verdict("overseer", command), "deny", command);
		}
		// Every segment of a compound must match an allow. `herdr agent rename`
		// allows, but `rm foo` matches no allow. The deny-by-default gate therefore
		// blocks the whole compound with `default`, not an explicit `deny`.
		assert.equal(
			verdict("overseer", "herdr agent rename w1:p1 overseer; rm foo"),
			"default",
			"a compound with an unallowed segment must block",
		);
		assert.equal(verdict("overseer", HERDR_COMPOUND_PLAIN), "allow");
	});
});

// ---------------------------------------------------------------------------
// `herdr plugin` is a privileged surface. pi denies it through its compound +
// server/plugin/--machine regex. kiro and opencode carry an anchored deny, so
// the rule starts the command: a compound cannot ride it, and the rule never
// matches the word "plugin" inside quoted prompt text.
// ---------------------------------------------------------------------------

const HERDR_PLUGIN_BARE = "herdr plugin";
const HERDR_PLUGIN_DENIED = "herdr plugin install x";
const HERDR_PLUGIN_PROMPT = 'herdr agent prompt reviewer "explain the plugin system"';

describe("overseer: herdr plugin is denied on every stack", () => {
	test("pi: bare and argument forms deny (existing regex parity)", () => {
		assert.equal(verdict("overseer", HERDR_PLUGIN_BARE), "deny");
		assert.equal(verdict("overseer", HERDR_PLUGIN_DENIED), "deny");
	});

	test("opencode: anchored deny rule exists and wins", () => {
		assert.ok(hasOpenCodeRule("overseer", "herdr plugin *", "deny"), "missing {shell, herdr plugin *, deny}");
		assert.equal(opencodeVerdict("overseer", HERDR_PLUGIN_BARE), "deny");
		assert.equal(opencodeVerdict("overseer", HERDR_PLUGIN_DENIED), "deny");
		assert.notEqual(opencodeVerdict("overseer", HERDR_PLUGIN_PROMPT), "deny");
	});

	test("kiro: anchored deny rules exist and win", () => {
		const denied = kiroDeniedCommands("overseer");
		for (const resource of ["herdr plugin", "herdr plugin *"]) {
			assert.ok(denied.includes(resource), `missing deniedCommands ${resource}`);
		}
		assert.equal(kiroVerdict("overseer", HERDR_PLUGIN_BARE), "deny");
		assert.equal(kiroVerdict("overseer", HERDR_PLUGIN_DENIED), "deny");
		assert.notEqual(kiroVerdict("overseer", HERDR_PLUGIN_PROMPT), "deny");
	});
});

// ---------------------------------------------------------------------------
// The pi herdr deny probe is quote-aware, so a denied word inside quoted
// argument text does not match; the real commands still deny.
// ---------------------------------------------------------------------------

// Each of the three denied keywords appears only as quoted prompt argument text.
const HERDR_QUOTED_PROMPTS = [
	'herdr agent prompt reviewer "explain the plugin system"',
	"herdr agent prompt reviewer 'stop the server now'",
	'herdr agent prompt reviewer "--machine is just the flag name"',
];

const HERDR_REAL_DENY = ["herdr plugin install x", "herdr server stop", "herdr --machine test agent list"];

const HERDR_COMPOUND_DENY = [
	"herdr agent prompt reviewer ok; herdr server stop",
	"herdr agent prompt reviewer ok && herdr plugin install x",
	"herdr agent prompt reviewer ok; herdr --machine prod agent list",
];

describe("pi overseer: the herdr deny is quote-aware", () => {
	test("quoted argument text is not denied", () => {
		for (const command of HERDR_QUOTED_PROMPTS) {
			assert.equal(verdict("overseer", command), "allow", command);
		}
	});

	test("the real plugin, server, and machine commands are denied", () => {
		for (const command of HERDR_REAL_DENY) {
			assert.equal(verdict("overseer", command), "deny", command);
		}
	});

	test("a compound with a denied tail is denied", () => {
		for (const command of HERDR_COMPOUND_DENY) {
			assert.equal(verdict("overseer", command), "deny", command);
		}
	});

	// Trade-off guard: `noDequote` skips the dequoted probe for this rule, so a
	// quote-obfuscated subcommand is no longer an explicit deny. Deny-by-default
	// still blocks it because it matches no allow. Assert it is never allowed.
	// Pin the residual kind on one case, so it is not trusted to this comment.
	test("a quote-obfuscated subcommand is still blocked, never allowed", () => {
		assert.notEqual(verdict("overseer", 'herdr "plugin" install x'), "allow");
		assert.equal(verdict("overseer", 'herdr "plugin" install x'), "default");
		assert.notEqual(verdict("overseer", "herdr serv'er' stop"), "allow");
		assert.notEqual(verdict("overseer", 'herdr "--machine" prod agent list'), "allow");
	});
});

describe("opencode: herdr allow is anchored at the command start", () => {
	test("orchestrator: cp/mv to the herdr path no longer matches an allow", () => {
		for (const command of HERDR_PATH_BYPASS) {
			assert.notEqual(opencodeVerdict("orchestrator", command), "allow", command);
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("researcher: no herdr allow rule matches a cp/mv to that path", () => {
		const herdrAllows = loadOpenCodeRules("researcher").filter(
			(rule) => rule.action === "shell" && rule.effect === "allow" && rule.resource.includes("herdr"),
		);
		assert.ok(herdrAllows.length > 0, "researcher must keep its herdr allow rules");
		for (const command of HERDR_PATH_BYPASS) {
			for (const rule of herdrAllows) {
				assert.ok(!opencodeGlob(rule.resource, command), `allow ${rule.resource} must not match ${command}`);
			}
		}
	});

	test("orchestrator: anchored bare rules exist and the unanchored rule is gone", () => {
		for (const resource of ["herdr", "HERDR_ENV=1 herdr agent list", "HERDR_ENV=1 herdr plugin list"]) {
			assert.ok(hasOpenCodeRule("orchestrator", resource, "allow"), `missing {shell, ${resource}, allow}`);
		}
		assert.ok(!hasOpenCodeRule("orchestrator", "*/.local/bin/herdr", "allow"));
		assert.equal(opencodeVerdict("orchestrator", "herdr"), "allow");
	});

	test("researcher: anchored bare rules exist and the unanchored rule is gone", () => {
		for (const resource of ["herdr", "herdr --help", "herdr --version", "herdr api schema"]) {
			assert.ok(hasOpenCodeRule("researcher", resource, "allow"), `missing {shell, ${resource}, allow}`);
		}
		assert.ok(!hasOpenCodeRule("researcher", "*/.local/bin/herdr", "allow"));
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
