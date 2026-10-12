/**
 * Regression harness for the git-write permission doctrine on the pi platform.
 *
 * Loads the shipped pi agent frontmatters and asserts the verdict matrix:
 *   orchestrator                                -> ASK for add/commit/push/pull and `gh pr`/`gh release`
 *   implementer                                 -> DENY for add/commit/push/pull and `gh pr`/`gh release`
 *   researcher/reviewer/tester/planner/overseer -> DENY for push/pull and `gh pr`/`gh release`
 *
 * Also checks the live global file does not keep a push/pull or `gh pr` deny.
 * That check skips when the file is absent, because the file is outside the repo.
 *
 * Run: npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	evaluateCommandRules,
	type Decision,
	type PermissionMode,
	type RawRule,
	type RuleSets,
} from "./command-segments.ts";

const frontmatterDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../agent-templates/pi/frontmatters",
);

interface FrontmatterPermissions {
	mode?: string;
	allow?: RawRule[];
	ask?: RawRule[];
	deny?: RawRule[];
}

/** Read one shipped pi frontmatter and map its rules onto gate `RuleSets`. */
function loadAgentRules(agent: string): { mode: PermissionMode; ruleSets: RuleSets } {
	const content = fs.readFileSync(path.join(frontmatterDir, `${agent}.yaml`), "utf-8");
	const { frontmatter } = parseFrontmatter<{ permissions?: FrontmatterPermissions }>(
		`---\n${content}\n---\n`,
	);
	const perms = frontmatter.permissions ?? {};
	return {
		mode: perms.mode === "deny-by-default" ? "deny-by-default" : "allow-unless-matched",
		ruleSets: {
			globalDeny: [],
			globalAsk: [],
			agentDeny: perms.deny ?? [],
			agentAsk: perms.ask ?? [],
			agentAllow: perms.allow ?? [],
		},
	};
}

/** Verdict kind for one agent + one bash command. */
function verdict(agent: string, command: string): Decision["kind"] {
	const { mode, ruleSets } = loadAgentRules(agent);
	return evaluateCommandRules(command, true, ruleSets, mode, "bash", agent).kind;
}

const WRITE_COMMANDS = [
	"git add agent-stack/foo.ts",
	'git commit -m "test"',
	"git push",
	"git pull",
	"gh pr create --fill",
];

const ANCHORED_COMMANDS = ["git -C /repo push", "cd /repo && git push"];

const OTHER_AGENTS = ["researcher", "reviewer", "tester", "planner", "overseer", "mascot"];
// Mascot has no bash tool. Bash behavior matrices skip it: deny-by-default still
// denies it, but the kind is `default`, not an explicit `deny` rule.
const PI_SHELL_AGENTS = OTHER_AGENTS.filter((agent) => agent !== "mascot");

describe("git-write permission doctrine (pi templates)", () => {
	test("orchestrator: add/commit/push/pull and gh pr all ask", () => {
		for (const command of [...WRITE_COMMANDS, ...ANCHORED_COMMANDS]) {
			assert.equal(verdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: git show still runs", () => {
		assert.equal(verdict("orchestrator", "git show HEAD"), "allow");
	});

	test("implementer: add/commit/push/pull and gh pr all deny", () => {
		for (const command of [...WRITE_COMMANDS, ...ANCHORED_COMMANDS]) {
			assert.equal(verdict("implementer", command), "deny", command);
		}
	});

	test("non-orchestrators: compound npm test && git push denies", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			assert.equal(verdict(agent, "npm test && git push"), "deny", agent);
		}
	});

	for (const agent of PI_SHELL_AGENTS) {
		test(`${agent}: push/pull and gh pr deny`, () => {
			const commands = [
				"git push",
				"git pull",
				"gh pr create --fill",
				"git -C /repo push",
				"git -C /repo pull",
				"cd /repo && git push",
				"cd /repo && git pull",
			];
			for (const command of commands) {
				assert.equal(verdict(agent, command), "deny", command);
			}
		});
	}
});

/** Path of the live global permissions file (the user's file). */
function liveGlobalPath(): string {
	return process.env.PI_PERMISSIONS_FILE ?? path.join(getAgentDir(), "permissions.json");
}

/**
 * Load the live global file into a `RuleSets` with no agent rules, so a verdict
 * reflects the global file alone. Returns null when the file is absent.
 */
function loadGlobalRuleSets(): RuleSets | null {
	if (!fs.existsSync(liveGlobalPath())) return null;
	const cfg = JSON.parse(fs.readFileSync(liveGlobalPath(), "utf-8")) as {
		deny?: RawRule[];
		ask?: RawRule[];
	};
	return {
		globalDeny: cfg.deny ?? [],
		globalAsk: cfg.ask ?? [],
		agentDeny: [],
		agentAsk: [],
		agentAllow: [],
	};
}

test("live global permissions.json drops the git push/pull and gh pr denies", (t) => {
	const ruleSets = loadGlobalRuleSets();
	if (ruleSets === null) {
		t.skip(`${liveGlobalPath()} is absent; the live file is outside the repo`);
		return;
	}
	// Assert behavior, not rule text. A split into one rule per verb keeps the
	// same verdict, so the test must still pass while the behavior is correct.
	const globalVerdict = (command: string): Decision["kind"] =>
		evaluateCommandRules(command, true, ruleSets, "allow-unless-matched", "bash", null).kind;

	// No global git push/pull deny (bare and env-prefixed forms).
	for (const command of ["git push", "git pull", "env git push", "env git pull"]) {
		assert.notEqual(globalVerdict(command), "deny", `global deny must not keep a git push/pull rule: ${command}`);
	}
	// Global ask must cover bare git push/pull.
	for (const command of ["git push", "git pull"]) {
		assert.equal(globalVerdict(command), "ask", `global ask must include git push/pull: ${command}`);
	}
	// No global gh pr deny (bare and env-prefixed forms).
	for (const command of ["gh pr create", "env gh pr create"]) {
		assert.notEqual(globalVerdict(command), "deny", `global deny must not keep a gh pr rule: ${command}`);
	}
	// Global ask must cover gh pr.
	assert.equal(globalVerdict("gh pr create"), "ask", "global ask must include gh pr");
});

// ---------------------------------------------------------------------------
// Cross-platform regression: env-prefix bypass, kiro bare forms, branch gate.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ENV_PREFIXED = [
	"env git push",
	"GIT_DIR=/x git push",
	"time git commit",
	"nohup git push",
	"env gh pr create",
	"env git pull",
	"env git add .",
	"env git -C /repo push",
];

const WRITE_BARE = ["git push", "git pull", "git add .", "git commit -m x", "gh pr create", "git -C /repo push"];

const BRANCH_DESTRUCTIVE = [
	"git branch -D topic",
	"git branch -f topic",
	"git branch -m old new",
	"git branch -M old new",
	"git branch --delete topic",
	"git branch --force topic",
	"git branch --move old new",
	"git branch --copy old new",
	"git branch -d topic",
	"git branch -c old new",
	"git branch -C old new",
	"env git branch -D topic",
	"env git branch -d topic",
	"git branch --de topic",
	"git branch --d topic",
	"git branch --del topic",
	"git branch --dele topic",
	"git branch --delet topic",
	"git branch --for topic",
	"git branch --forc topic",
	"git branch --mov old new",
	"git branch --mo old new",
	"git branch --cop old new",
];

const READ_ONLY_BRANCH = [
	"git branch",
	"git branch -a",
	"git branch -r",
	"git branch --list",
	"git branch --show-current",
	"git branch --format='%(refname)'",
	"git branch --format=%(refname)",
];

const XARGS_WRITES = [
	"xargs git push",
	"xargs git pull",
	"xargs git add .",
	"xargs git commit -m x",
	"xargs gh pr create",
	"xargs git -C /repo push",
];

const SUBSTITUTION_WRITES = [
	"echo $(git push)",
	"echo `git push`",
	"echo $(git commit -m x)",
	"git --git-dir=/x push",
	"git --git-dir=/x add .",
	"git --git-dir=/x commit -m x",
	"git -c foo=bar commit",
	"git -p push",
	"git --no-pager push",
	"git --work-tree=/x push",
	"gh -R owner/repo pr create",
];

const SUDO_FLAG_WRITES = [
	"env -i sudo git push",
	"env sudo -E git push",
	"env sudo -u root git push",
];

describe("pi: env-prefix bypass and branch gate", () => {
	test("orchestrator: env-prefixed writes ask", () => {
		for (const command of ENV_PREFIXED) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("non-orchestrators: env-prefixed writes deny", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of ENV_PREFIXED) assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
		}
	});

	test("orchestrator: destructive branch asks, read-only stays allowed", () => {
		for (const command of BRANCH_DESTRUCTIVE) assert.equal(verdict("orchestrator", command), "ask", command);
		assert.equal(verdict("orchestrator", "git branch -a"), "allow");
		assert.equal(verdict("orchestrator", "git branch"), "allow");
	});

	test("non-orchestrators: destructive branch denies, read-only not denied", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of BRANCH_DESTRUCTIVE) assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			assert.notEqual(verdict(agent, "git branch -a"), "deny", `${agent}: git branch -a`);
		}
	});

	test("planner: sudo-prefixed git push denies", () => {
		assert.equal(verdict("planner", "sudo -E env git push"), "deny");
	});

	test("xargs-wrapped git push is blocked, never ask", () => {
		for (const agent of ["orchestrator", "implementer", ...PI_SHELL_AGENTS]) {
			const kind = verdict(agent, "xargs git push");
			assert.notEqual(kind, "ask", agent);
			assert.notEqual(kind, "allow", agent);
		}
	});

	test("orchestrator: sudo option-flag writes ask", () => {
		for (const command of SUDO_FLAG_WRITES) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("non-orchestrators: sudo option-flag writes deny", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of SUDO_FLAG_WRITES) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

/**
 * Mirror of opencode's `Wildcard.match`: escape regex specials, `*` -> `.*`,
 * `?` -> `.`, and a trailing " .*" becomes optional. Anchored, dotall.
 */
function opencodeGlob(pattern: string, value: string): boolean {
	let body = pattern
		.replaceAll("\\", "/")
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	if (body.endsWith(" .*")) body = `${body.slice(0, -3)}( .*)?`;
	return new RegExp(`^${body}$`, "s").test(value.replaceAll("\\", "/"));
}

interface OpenCodeRule {
	action: string;
	resource: string;
	effect: string;
}

function loadOpenCodeRules(agent: string): OpenCodeRule[] {
	const content = fs.readFileSync(
		path.join(repoRoot, "agent-templates/opencode/frontmatters", `${agent}.yaml`),
		"utf-8",
	);
	const { frontmatter } = parseFrontmatter<{
		permissions?: OpenCodeRule[];
		permission?: { bash?: Record<string, string> };
	}>(`---\n${content}\n---\n`);
	const rules: OpenCodeRule[] = [...(frontmatter.permissions ?? [])];
	for (const [resource, effect] of Object.entries(frontmatter.permission?.bash ?? {})) {
		rules.push({ action: "shell", resource, effect: String(effect) });
	}
	return rules;
}

/** opencode uses findLast: the last matching rule wins; no match is `ask`. */
function opencodeVerdict(agent: string, command: string): string {
	const rules = loadOpenCodeRules(agent);
	for (let idx = rules.length - 1; idx >= 0; idx--) {
		const rule = rules[idx];
		if (opencodeGlob(rule.action, "shell") && opencodeGlob(rule.resource, command)) return rule.effect;
	}
	return "ask";
}

/** opencode last-match verdict for any action/resource pair (e.g. edit paths). */
function opencodeResourceVerdict(agent: string, action: string, resource: string): string {
	const rules = loadOpenCodeRules(agent);
	for (let idx = rules.length - 1; idx >= 0; idx--) {
		const rule = rules[idx];
		if (opencodeGlob(rule.action, action) && opencodeGlob(rule.resource, resource)) return rule.effect;
	}
	return "ask";
}

/** True when the agent's rules carry an exact shell rule (action, resource, effect). */
function hasOpenCodeRule(agent: string, resource: string, effect: string): boolean {
	return loadOpenCodeRules(agent).some(
		(rule) => rule.action === "shell" && rule.resource === resource && rule.effect === effect,
	);
}

/** Mirror of kiro's globset: `*` -> `.*`, `?` -> `.`, anchored, no optional trailing. */
function kiroGlob(pattern: string, value: string): boolean {
	const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${body}$`, "s").test(value);
}

function kiroVerdict(agent: string, command: string): string {
	const cfg = JSON.parse(
		fs.readFileSync(path.join(repoRoot, "agent-templates/kiro", `${agent}.json`), "utf-8"),
	) as { toolsSettings?: { shell?: { allowedCommands?: string[]; deniedCommands?: string[] } } };
	const shell = cfg.toolsSettings?.shell ?? {};
	if ((shell.deniedCommands ?? []).some((pattern) => kiroGlob(pattern, command))) return "deny";
	if ((shell.allowedCommands ?? []).some((pattern) => kiroGlob(pattern, command))) return "allow";
	return "ask";
}

interface KiroAgentConfig {
	tools?: string[];
	allowedTools?: string[];
	toolsSettings?: { shell?: { allowedCommands?: string[]; deniedCommands?: string[] } };
}

function loadKiroConfig(agent: string): KiroAgentConfig {
	return JSON.parse(
		fs.readFileSync(path.join(repoRoot, "agent-templates/kiro", `${agent}.json`), "utf-8"),
	) as KiroAgentConfig;
}

function kiroDeniedCommands(agent: string): string[] {
	return loadKiroConfig(agent).toolsSettings?.shell?.deniedCommands ?? [];
}

/** kiro grants the shell tool only when `tools` or `allowedTools` lists it. */
function kiroHasShellTool(agent: string): boolean {
	const cfg = loadKiroConfig(agent);
	return (cfg.tools ?? []).includes("shell") || (cfg.allowedTools ?? []).includes("shell");
}

/** kiro silently allows only the tools in `allowedTools`; others default to ask. */
function kiroAllowedTools(agent: string): string[] {
	return loadKiroConfig(agent).allowedTools ?? [];
}

/** pi grants a tool only when the frontmatter lists it in `tools`. */
function piHasBashTool(agent: string): boolean {
	const content = fs.readFileSync(path.join(frontmatterDir, `${agent}.yaml`), "utf-8");
	const { frontmatter } = parseFrontmatter<{ tools?: string[] }>(`---\n${content}\n---\n`);
	return (frontmatter.tools ?? []).includes("bash");
}

const OPENCODE_AGENTS = [
	"implementer",
	"researcher",
	"reviewer",
	"tester",
	"planner",
	"overseer",
	"mascot",
];
const KIRO_AGENTS = [...OPENCODE_AGENTS];
// Mascot grants no shell command on opencode (the base `*:*` rule denies) and has
// no shell tool on kiro. Shell behavior matrices run on the shell-capable agents.
const OPENCODE_SHELL_AGENTS = OPENCODE_AGENTS.filter((agent) => agent !== "mascot");
const KIRO_SHELL_AGENTS = KIRO_AGENTS.filter((agent) => agent !== "mascot");

describe("opencode: env-prefix bypass and branch gate", () => {
	test("orchestrator: writes ask", () => {
		for (const command of [...ENV_PREFIXED, ...WRITE_BARE]) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("non-orchestrators: env-prefixed and bare writes deny", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of [...ENV_PREFIXED, ...WRITE_BARE]) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("non-orchestrators: destructive branch denies", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of BRANCH_DESTRUCTIVE) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("orchestrator: destructive branch asks", () => {
		for (const command of BRANCH_DESTRUCTIVE) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("non-orchestrators: read-only branch stays not denied", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of READ_ONLY_BRANCH) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("non-orchestrators: xargs-wrapped writes deny", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of XARGS_WRITES) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("orchestrator: xargs-wrapped writes ask", () => {
		for (const command of XARGS_WRITES) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});
});

describe("kiro: bare forms, env-prefix bypass, and branch gate", () => {
	test("orchestrator: writes default to ask", () => {
		for (const command of [...ENV_PREFIXED, ...WRITE_BARE]) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("non-orchestrators: bare and env-prefixed writes deny", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of [...ENV_PREFIXED, ...WRITE_BARE]) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("non-orchestrators: destructive branch denies", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of BRANCH_DESTRUCTIVE) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("orchestrator: destructive branch asks", () => {
		for (const command of BRANCH_DESTRUCTIVE) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("xargs-wrapped git push denies for non-orchestrators and asks for orchestrator", () => {
		for (const agent of KIRO_SHELL_AGENTS) assert.equal(kiroVerdict(agent, "xargs git push"), "deny", agent);
		assert.equal(kiroVerdict("orchestrator", "xargs git push"), "ask");
	});

	test("non-orchestrators: read-only branch stays not denied", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of READ_ONLY_BRANCH) {
				assert.notEqual(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

describe("opencode: command-substitution and option-form bypass", () => {
	test("orchestrator: substitution and option-form writes ask", () => {
		for (const command of SUBSTITUTION_WRITES) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("non-orchestrators: substitution and option-form writes deny", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of SUBSTITUTION_WRITES) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

describe("kiro: command-substitution and option-form bypass", () => {
	// Kiro has no ask list: an unlisted command falls to its default ask, so the
	// orchestrator's substitution forms ask without an explicit rule.
	test("orchestrator: substitution and option-form writes default to ask", () => {
		for (const command of SUBSTITUTION_WRITES) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("non-orchestrators: substitution and option-form writes deny", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of SUBSTITUTION_WRITES) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Read-only boundary after the tightened catch-alls.
// A substring catch-all like `*gh*pr*` denies `cat high-priority.md`, and
// `*git*push*` denies `git log --all --grep=push`. These read-only commands
// must never be denied on any platform.
// ---------------------------------------------------------------------------

const READ_ONLY_AFTER_CATCHALL = [
	"cat high-priority.md",
	"grep -rn highlight src/projects",
	"git log --all --grep=push",
	"git log --oneline",
];

describe("read-only commands survive the tightened catch-alls", () => {
	test("opencode: read-only commands are not denied", () => {
		for (const agent of ["orchestrator", ...OPENCODE_SHELL_AGENTS]) {
			for (const command of READ_ONLY_AFTER_CATCHALL) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: read-only commands are not denied", () => {
		for (const agent of ["orchestrator", ...KIRO_SHELL_AGENTS]) {
			for (const command of READ_ONLY_AFTER_CATCHALL) {
				assert.notEqual(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro orchestrator: read-only command with an argument is not denied", () => {
		for (const command of ["cat high-priority.md", "echo hello world", "ls -la src"]) {
			assert.notEqual(kiroVerdict("orchestrator", command), "deny", command);
		}
	});

	test("kiro orchestrator: bash -n cannot smuggle a write through the shell", () => {
		assert.equal(kiroVerdict("orchestrator", "bash -n $(git push)"), "ask");
		assert.equal(kiroVerdict("orchestrator", "bash -n script.sh"), "ask");
	});
});

// ---------------------------------------------------------------------------
// Final lockdown: a destructive branch flag anywhere in the branch arguments,
// and a write hidden behind a previously broad allow. Every allow that carried
// arguments was narrowed to its literal base, so `git log && git push` and
// `echo $(git --paginate push)` can no longer ride a broad read-only allow.
// ---------------------------------------------------------------------------

const BRANCH_FLAG_ORDER = [
	"git branch -a -d topic",
	"git branch --all -M old new",
];

const HIDDEN_WRITES = [
	"git log && git push",
	"echo $(git --paginate push)",
];

const READ_ONLY_BRANCH_PLAIN = [
	"git branch",
	"git branch -a",
	"git branch --show-current",
];

describe("branch flag-order bypass and broad-allow writes", () => {
	test("pi: a leading branch flag cannot hide the destructive flag", () => {
		for (const command of BRANCH_FLAG_ORDER) {
			assert.equal(verdict("orchestrator", command), "ask", command);
			for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("pi: plain read-only branch commands are not denied", () => {
		for (const command of READ_ONLY_BRANCH_PLAIN) {
			for (const agent of ["orchestrator", "implementer", ...PI_SHELL_AGENTS]) {
				assert.notEqual(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("pi: writes hidden behind a broad allow ask the orchestrator and deny others", () => {
		for (const command of HIDDEN_WRITES) {
			assert.equal(verdict("orchestrator", command), "ask", command);
			for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode: a leading branch flag cannot hide the destructive flag", () => {
		for (const command of BRANCH_FLAG_ORDER) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
			for (const agent of OPENCODE_SHELL_AGENTS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode: plain read-only branch commands are not denied", () => {
		for (const command of READ_ONLY_BRANCH_PLAIN) {
			for (const agent of ["orchestrator", ...OPENCODE_SHELL_AGENTS]) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode: writes hidden behind a broad allow ask the orchestrator and deny others", () => {
		for (const command of HIDDEN_WRITES) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
			for (const agent of OPENCODE_SHELL_AGENTS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: a leading branch flag cannot hide the destructive flag", () => {
		for (const command of BRANCH_FLAG_ORDER) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
			for (const agent of KIRO_SHELL_AGENTS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: plain read-only branch commands are not denied", () => {
		for (const command of READ_ONLY_BRANCH_PLAIN) {
			for (const agent of ["orchestrator", ...KIRO_SHELL_AGENTS]) {
				assert.notEqual(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: writes hidden behind a broad allow ask the orchestrator and deny others", () => {
		for (const command of HIDDEN_WRITES) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
			for (const agent of KIRO_SHELL_AGENTS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Read-only git subcommands that mutate state: reflog expiry, fetch refspecs,
// and remote config edits. These ride the broad read-only git allow on pi.
// ---------------------------------------------------------------------------

const READONLY_ABUSE = [
	"git reflog expire --expire=now --all",
	"git reflog delete",
	"git reflog drop",
	"git fetch origin +HEAD:refs/heads/x",
	"git remote add x url",
	"git remote remove x",
	"git remote rm x",
	"git remote rename old new",
	"git remote set-url x url",
	"git remote set-branches x y",
	"git remote set-head x y",
	"git remote prune x",
	"env git reflog expire",
];

const READONLY_SAFE = [
	"git reflog",
	"git reflog show",
	"git fetch",
	"git fetch --all",
	"git remote",
	"git remote -v",
	"git remote show",
];

// ---------------------------------------------------------------------------
// `git reset --soft` is a history squash. The rule is orchestrator-only and
// always asks the orchestrator before it runs; everyone else denies by default.
// ---------------------------------------------------------------------------

const RESET_SOFT = ["git reset --soft HEAD~1", "cd /repo && git reset --soft HEAD~1"];

describe("pi: git reset --soft is orchestrator-gated", () => {
	test("orchestrator: git reset --soft asks", () => {
		for (const command of RESET_SOFT) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("non-orchestrators: git reset --soft denies", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			const kind = verdict(agent, "git reset --soft HEAD~1");
			assert.notEqual(kind, "ask", agent);
			assert.notEqual(kind, "allow", agent);
		}
	});
});

describe("pi: mutating read-only git forms are gated", () => {
	test("orchestrator: reflog/fetch/remote mutations ask", () => {
		for (const command of READONLY_ABUSE) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("non-orchestrators: reflog/fetch/remote mutations deny", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of READONLY_ABUSE) assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
		}
	});

	test("all agents: plain read-only reflog/fetch/remote are not denied", () => {
		for (const agent of ["orchestrator", "implementer", ...PI_SHELL_AGENTS]) {
			for (const command of READONLY_SAFE) assert.notEqual(verdict(agent, command), "deny", `${agent}: ${command}`);
		}
	});
});

// ---------------------------------------------------------------------------
// File migrations (cp/mv/rsync) prompt the orchestrator and the implementer on
// every stack, so the user can approve a migration on demand. Every other agent
// stays hard-gated: pi blocks by deny-by-default mode; opencode and kiro carry
// explicit deny rules, so the command never runs silently.
// ---------------------------------------------------------------------------

const FILE_MIGRATION_COMMANDS = [
	"cp src/a.txt dest/b.txt",
	"mv src/a.txt dest/b.txt",
	"rsync -a src/ dest/",
	"cd /repo && cp src/a dest/b",
	"env cp src/a dest/b",
];

const FILE_MIGRATION_TARGETS = ["orchestrator", "implementer"];

describe("file-migration permission doctrine (cp/mv/rsync)", () => {
	const MIGRATION_RESOURCES = ["cp *", "mv *", "rsync *"];

	test("pi orchestrator and implementer: cp/mv/rsync ask", () => {
		for (const agent of ["orchestrator", "implementer"]) {
			for (const command of FILE_MIGRATION_COMMANDS) {
				assert.equal(verdict(agent, command), "ask", `${agent}: ${command}`);
			}
		}
	});

	test("pi other agents: cp/mv/rsync deny by default", () => {
		for (const agent of OTHER_AGENTS) {
			for (const command of FILE_MIGRATION_COMMANDS) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		}
	});

	// opencode: the ask must come from an explicit rule, not the default ask.
	test("opencode orchestrator and implementers: explicit ask rules exist", () => {
		for (const agent of FILE_MIGRATION_TARGETS) {
			for (const resource of MIGRATION_RESOURCES) {
				assert.ok(hasOpenCodeRule(agent, resource, "ask"), `${agent}: missing {shell, ${resource}, ask}`);
			}
		}
	});

	test("opencode orchestrator and implementers: cp/mv/rsync ask", () => {
		for (const agent of FILE_MIGRATION_TARGETS) {
			for (const command of FILE_MIGRATION_COMMANDS) {
				assert.equal(opencodeVerdict(agent, command), "ask", `${agent}: ${command}`);
			}
		}
	});

	test("opencode other agents: explicit deny rules deny cp/mv/rsync", () => {
		for (const agent of OPENCODE_AGENTS.filter((name) => !FILE_MIGRATION_TARGETS.includes(name))) {
			for (const resource of MIGRATION_RESOURCES) {
				assert.ok(hasOpenCodeRule(agent, resource, "deny"), `${agent}: missing {shell, ${resource}, deny}`);
			}
			for (const command of FILE_MIGRATION_COMMANDS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	// kiro: orchestrator/implementer are unlisted, so the platform default asks.
	// Assert no deniedCommands pattern matches them.
	test("kiro orchestrator and implementers: unlisted -> ask, no deny matches", () => {
		for (const agent of FILE_MIGRATION_TARGETS) {
			const denied = kiroDeniedCommands(agent);
			for (const command of FILE_MIGRATION_COMMANDS) {
				assert.ok(!denied.some((pattern) => kiroGlob(pattern, command)), `${agent}: deny matches ${command}`);
				assert.equal(kiroVerdict(agent, command), "ask", `${agent}: ${command}`);
			}
		}
	});

	test("kiro other agents: explicit deniedCommands deny cp/mv/rsync", () => {
		for (const agent of KIRO_AGENTS.filter((name) => !FILE_MIGRATION_TARGETS.includes(name))) {
			if (!kiroHasShellTool(agent)) {
				// Mascot gets no shell at all, so cp/mv/rsync cannot run. That is
				// stronger than a deny entry; assert the tool is absent instead.
				assert.ok(!kiroHasShellTool(agent), `${agent}: a shell-less agent cannot run cp/mv/rsync`);
				continue;
			}
			for (const command of ["cp", "mv", "rsync"]) {
				assert.ok(kiroDeniedCommands(agent).includes(command), `${agent}: missing deniedCommands ${command}`);
			}
			for (const command of FILE_MIGRATION_COMMANDS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("mascot: no shell surface on any stack", () => {
		assert.ok(!piHasBashTool("mascot"), "pi mascot must not have a bash tool");
		assert.ok(!kiroHasShellTool("mascot"), "kiro mascot must not have a shell tool");
		for (const resource of MIGRATION_RESOURCES) {
			assert.ok(hasOpenCodeRule("mascot", resource, "deny"), `opencode mascot must explicitly deny ${resource}`);
		}
	});
});

// ---------------------------------------------------------------------------
// File-migration wrapper boundaries on pi: the `command -v` read-only probe
// must stay allowed, `timeout`/`chrt`-wrapped migrations must still ask, and
// near-miss tokens must never over-match the ask rule.
// ---------------------------------------------------------------------------

const PI_MIGRATION_AGENTS = ["orchestrator", "implementer"];

const COMMAND_VERSION_PROBES = [
	"command -v cp",
	"command -V cp",
	"command -v mv",
	"command -V mv",
	"command -v rsync",
	"command -V rsync",
];

const COMMAND_PREFIXED_MIGRATIONS = ["command cp a b", "command mv a b", "command rsync a b"];

const TIMEOUT_WRAPPED_MIGRATIONS = [
	"timeout 5 cp a b",
	"timeout 5 mv a b",
	"timeout 5 rsync a b",
	"timeout -s TERM 5 cp a b",
	"timeout -s TERM 5 mv a b",
	"timeout -s TERM 5 rsync a b",
	"chrt 5 cp a b",
];

const MIGRATION_NEAR_MISS_ALLOWED = ["grep cp"];

const MIGRATION_NEAR_MISS_DEFAULT = ["scp a b", "cpfoo", "mvn test", "MCP", "mvfoo", "rsyncd"];

describe("pi: cp/mv/rsync wrapper boundaries", () => {
	test("command -v/-V probes stay allowed, never asked", () => {
		for (const agent of PI_MIGRATION_AGENTS) {
			for (const command of COMMAND_VERSION_PROBES) {
				assert.equal(verdict(agent, command), "allow", `${agent}: ${command}`);
			}
		}
	});

	test("command-prefixed migrations fall through to deny-by-default", () => {
		for (const agent of PI_MIGRATION_AGENTS) {
			for (const command of COMMAND_PREFIXED_MIGRATIONS) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		}
	});

	test("timeout/chrt-wrapped migrations still ask", () => {
		for (const agent of PI_MIGRATION_AGENTS) {
			for (const command of TIMEOUT_WRAPPED_MIGRATIONS) {
				assert.equal(verdict(agent, command), "ask", `${agent}: ${command}`);
			}
		}
	});

	test("near-miss tokens never over-match the ask rule", () => {
		for (const agent of PI_MIGRATION_AGENTS) {
			for (const command of MIGRATION_NEAR_MISS_ALLOWED) {
				assert.equal(verdict(agent, command), "allow", `${agent}: ${command}`);
			}
			for (const command of MIGRATION_NEAR_MISS_DEFAULT) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Git tag doctrine: creation asks the orchestrator on pi/opencode and stays
// unlisted (ask) on kiro. Deletion and force deny every agent. Read-only
// listing stays allowed on pi. Every non-orchestrator must not create a tag.
// ---------------------------------------------------------------------------

const TAG_CREATE = ["git tag v3.0.0", "git -C /repo tag v3.0.0", "cd /repo && git tag v3.0.0"];

const TAG_CREATE_WRAPPED = ["env git tag v3.0.0", "echo $(git tag v3.0.0)"];

const TAG_DESTRUCTIVE = [
	"git tag -d v3.0.0",
	"git tag --delete v3.0.0",
	"git tag -f v3.0.0",
	"git tag --force v3.0.0",
];

// Git accepts any unambiguous long-option prefix. `--for` is excluded because
// it collides with `--format`.
const TAG_ABBREVIATED_DESTRUCTIVE = ["git tag --forc v1", "git tag --delet v1"];

// A tag NAME may contain `-d`/`-f`. These are not flags and must never deny.
const TAG_NAME_FALSE_POSITIVES = ["git tag v1.0.0-final", "git tag v2.0.0-delta"];

const TAG_DESTRUCTIVE_WRAPPED = [
	"env git tag -d v3.0.0",
	"env git tag --delete v3.0.0",
	"env git tag -f v3.0.0",
	"env git tag --force v3.0.0",
	"echo $(git tag -d v3.0.0)",
	"echo $(git tag --delete v3.0.0)",
	"echo $(git tag -f v3.0.0)",
	"echo $(git tag --force v3.0.0)",
];

// Destructive flags in a non-first position, including compact forms.
const TAG_DESTRUCTIVE_ANYWHERE = [
	"git tag -a -f v3.0.0 -m x",
	"git tag -m release -f v3.0.0",
	"git tag -af v3.0.0",
	"git tag -df v3.0.0",
	"git tag -a -d v3.0.0 -m x",
];

// Combined separator + `git -C`: the flag follows `tag` inside a wrapper.
const TAG_DESTRUCTIVE_C = [
	"echo $(git -C /repo tag -d v3.0.0)",
	"echo `git -C /repo tag -d v3.0.0`",
	"echo $(git -C /repo tag --delete v3.0.0)",
	"echo `git -C /repo tag --delete v3.0.0`",
	"echo $(git -C /repo tag -f v3.0.0)",
	"echo `git -C /repo tag -f v3.0.0`",
	"echo $(git -C /repo tag --force v3.0.0)",
	"echo `git -C /repo tag --force v3.0.0`",
];

const TAG_DESTRUCTIVE_ALL = [
	...TAG_DESTRUCTIVE,
	...TAG_ABBREVIATED_DESTRUCTIVE,
	...TAG_DESTRUCTIVE_ANYWHERE,
	...TAG_DESTRUCTIVE_WRAPPED,
	...TAG_DESTRUCTIVE_C,
];

const TAG_LISTING = ["git tag", "git tag -l", "git tag --list", "git -C /repo tag -l"];

const TAG_ALL = [...TAG_CREATE, ...TAG_CREATE_WRAPPED, ...TAG_DESTRUCTIVE_ALL];

describe("pi: git tag doctrine", () => {
	test("orchestrator: tag creation asks", () => {
		for (const command of [...TAG_CREATE, ...TAG_CREATE_WRAPPED]) {
			assert.equal(verdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: destructive tag flags in any position deny", () => {
		for (const command of TAG_DESTRUCTIVE_ALL) {
			assert.equal(verdict("orchestrator", command), "deny", command);
		}
	});

	test("orchestrator: tag names containing -d/-f are not denied", () => {
		for (const command of TAG_NAME_FALSE_POSITIVES) {
			assert.equal(verdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: --format is not caught by the --for abbreviation", () => {
		assert.notEqual(verdict("orchestrator", "git tag --format=%(refname) -l"), "deny");
	});

	test("orchestrator: read-only tag listing stays allowed", () => {
		for (const command of TAG_LISTING) {
			assert.equal(verdict("orchestrator", command), "allow", command);
		}
	});

	test("non-orchestrators: tag creation and destructive forms default", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of TAG_ALL) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		}
	});
});

describe("opencode: git tag doctrine", () => {
	test("orchestrator: explicit tag creation ask rules exist", () => {
		for (const resource of [
			"git tag *",
			"* git tag *",
			"*;git tag*",
			"*&&git tag*",
			"*|git tag*",
			"*$(git tag*",
			"git -C * tag *",
		]) {
			assert.ok(hasOpenCodeRule("orchestrator", resource, "ask"), `missing {shell, ${resource}, ask}`);
		}
	});

	test("opencode: git log --grep=tag is not denied", () => {
		for (const agent of ["orchestrator", ...OPENCODE_SHELL_AGENTS]) {
			assert.notEqual(opencodeVerdict(agent, "git log --grep=tag"), "deny", agent);
		}
	});

	test("orchestrator: tag creation asks", () => {
		for (const command of [...TAG_CREATE, ...TAG_CREATE_WRAPPED]) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: destructive tag flags in any position deny", () => {
		for (const command of TAG_DESTRUCTIVE_ALL) {
			assert.equal(opencodeVerdict("orchestrator", command), "deny", command);
		}
	});

	test("orchestrator: tag names containing -d/-f are not denied", () => {
		for (const command of TAG_NAME_FALSE_POSITIVES) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: tag listing is not denied", () => {
		for (const command of TAG_LISTING) {
			assert.notEqual(opencodeVerdict("orchestrator", command), "deny", command);
		}
	});

	test("non-orchestrators: tag creation and destructive forms deny", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of TAG_ALL) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

describe("kiro: git tag doctrine", () => {
	test("orchestrator: tag creation defaults to ask", () => {
		for (const command of [...TAG_CREATE, ...TAG_CREATE_WRAPPED]) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: destructive tag flags in any position deny", () => {
		for (const command of TAG_DESTRUCTIVE_ALL) {
			assert.equal(kiroVerdict("orchestrator", command), "deny", command);
		}
	});

	test("orchestrator: tag names containing -d/-f are not denied", () => {
		for (const command of TAG_NAME_FALSE_POSITIVES) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: tag listing is not denied", () => {
		for (const command of TAG_LISTING) {
			assert.notEqual(kiroVerdict("orchestrator", command), "deny", command);
		}
	});

	test("non-orchestrators: tag creation and destructive forms deny", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of TAG_ALL) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: git log --grep=tag is not denied", () => {
		for (const agent of ["orchestrator", ...KIRO_SHELL_AGENTS]) {
			assert.notEqual(kiroVerdict(agent, "git log --grep=tag"), "deny", agent);
		}
	});
});

// ---------------------------------------------------------------------------
// Accepted trade-off: read-only tag long options are over-denied on
// opencode/kiro. Their globs `*git tag -*d*` and `*git tag -*f*` cannot
// separate the `-d`/`-f` flags from the long options `--merged` and
// `--format=...`, so those read-only forms match the destructive deny rule.
// The user chose fail-safe over-deny: a false deny is safer than a missed
// force/delete. pi uses a real regex with word boundaries, so it stays precise
// and returns `ask` for `--format`.
// ---------------------------------------------------------------------------

const TAG_READONLY_OVERDENIED = [
	"git tag --format=%(refname) -l",
	"git tag --merged",
];

describe("opencode/kiro: accepted over-deny for read-only tag long options", () => {
	test("opencode orchestrator: read-only tag long options deny (accepted over-deny)", () => {
		for (const command of TAG_READONLY_OVERDENIED) {
			assert.equal(opencodeVerdict("orchestrator", command), "deny", command);
		}
	});

	test("kiro orchestrator: read-only tag long options deny (accepted over-deny)", () => {
		for (const command of TAG_READONLY_OVERDENIED) {
			assert.equal(kiroVerdict("orchestrator", command), "deny", command);
		}
	});

	test("pi orchestrator: --format is not over-denied; word boundaries keep it at ask", () => {
		assert.equal(verdict("orchestrator", "git tag --format=%(refname) -l"), "ask");
	});
});

// ---------------------------------------------------------------------------
// Git merge doctrine: a merge writes history, so it asks the orchestrator on
// pi/opencode and stays unlisted (ask) on kiro. Every non-orchestrator must not
// merge: pi blocks by deny-by-default mode; opencode and kiro carry explicit
// deny rules.
// ---------------------------------------------------------------------------

const MERGE_COMMANDS = ["git merge origin/main", "cd /repo && git merge origin/main"];

// A boundary slip in the merge rules could turn the read-only `git merge-base`
// into an ask (opencode, where the last match wins) or a deny (kiro).
const MERGE_BASE_COMMAND = "git merge-base origin/dev origin/main";
const MERGE_BASE_COMMANDS = [MERGE_BASE_COMMAND, "git -C /repo merge-base origin/dev origin/main"];
// `git merge-file`/`git merge-tree` share the `merge` token but are not
// merge-base. They must not fall into the merge ask or the merge deny.
const MERGE_NEAR_MISS_COMMANDS = ["git merge-file a b c", "git merge-tree base head"];

describe("git merge permission doctrine", () => {
	test("pi orchestrator: git merge asks", () => {
		for (const command of MERGE_COMMANDS) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("pi non-orchestrators: git merge defaults to deny", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of MERGE_COMMANDS) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		}
	});

	test("opencode orchestrator: git merge asks", () => {
		for (const command of MERGE_COMMANDS) assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
	});

	test("opencode non-orchestrators: git merge denies", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of MERGE_COMMANDS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro orchestrator: git merge defaults to ask", () => {
		for (const command of MERGE_COMMANDS) assert.equal(kiroVerdict("orchestrator", command), "ask", command);
	});

	test("kiro non-orchestrators: git merge denies", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of MERGE_COMMANDS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("pi orchestrator: git merge-base is allow", () => {
		assert.equal(verdict("orchestrator", MERGE_BASE_COMMAND), "allow");
	});

	test("pi orchestrator: merge near misses are not ask and not allow", () => {
		for (const command of MERGE_NEAR_MISS_COMMANDS) {
			const kind = verdict("orchestrator", command);
			assert.notEqual(kind, "ask", command);
			assert.notEqual(kind, "allow", command);
		}
	});

	test("opencode orchestrator: git merge-base stays allow (not ask, not deny)", () => {
		for (const command of MERGE_BASE_COMMANDS) {
			assert.equal(opencodeVerdict("orchestrator", command), "allow", command);
		}
		assert.ok(
			hasOpenCodeRule("orchestrator", "git -C * merge-base *", "allow"),
			"missing {shell, git -C * merge-base *, allow}",
		);
	});

	test("opencode orchestrator: merge near misses stay ask (not allow, not deny)", () => {
		for (const command of MERGE_NEAR_MISS_COMMANDS) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("kiro orchestrator: git merge-base and near misses are not denied", () => {
		for (const command of [...MERGE_BASE_COMMANDS, ...MERGE_NEAR_MISS_COMMANDS]) {
			assert.notEqual(kiroVerdict("orchestrator", command), "deny", command);
		}
	});

	test("opencode non-orchestrators: git merge-base is not denied", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of MERGE_BASE_COMMANDS) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro non-orchestrators: git merge-base is not denied", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of MERGE_BASE_COMMANDS) {
				assert.notEqual(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// GitHub release doctrine: `gh release` publishes a release, a GitHub write.
// It asks the orchestrator on every stack (pi/opencode by an explicit rule,
// kiro via the unlisted default) and denies every non-orchestrator, matching
// the `gh pr` doctrine.
// ---------------------------------------------------------------------------

const RELEASE_COMMANDS = [
	"gh release create v3.0.0 --title v3.0.0",
	"env gh release create x",
	"cd /repo && gh release create v3.0.0 --title v3.0.0",
	"cd /repo&&gh release create v3.0.0",
];

describe("github release permission doctrine", () => {
	test("pi orchestrator: gh release asks", () => {
		for (const command of RELEASE_COMMANDS) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("pi non-orchestrators: gh release denies", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of RELEASE_COMMANDS) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode orchestrator: gh release asks", () => {
		for (const command of RELEASE_COMMANDS) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("opencode non-orchestrators: gh release denies", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of RELEASE_COMMANDS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro orchestrator: gh release defaults to ask", () => {
		for (const command of RELEASE_COMMANDS) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("kiro non-orchestrators: gh release denies", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of RELEASE_COMMANDS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Rust toolchain permission doctrine.
// Each stack and agent must carry the intended allow entries, must never allow
// install/publish/rustup/config overrides, and must hold the fmt/build boundary.
// The existence checks are load-bearing: a missing rule fails here instead of
// passing on an engine default.
// ---------------------------------------------------------------------------

const RUST_AGENTS = ["implementer", "tester", "reviewer", "researcher"] as const;
type RustAgent = (typeof RUST_AGENTS)[number];

// Commands that must never be allowed on any stack. The --config form uses the
// prefix position: the pi allow anchor requires a cargo subcommand directly.
const RUST_FORBIDDEN_NEVER_ALLOWED = [
	"cargo install cargo-edit",
	"cargo publish",
	"rustup install stable",
	"rustup update",
	"cargo --config net.offline=true check",
];

// opencode shell resources that must exist verbatim, per agent.
const OPENCODE_RUST_ALLOWS: Record<RustAgent, string[]> = {
	implementer: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata *",
		"cargo tree *",
		"cargo locate-project *",
		"cargo check *",
		"cargo clippy *",
		"cargo fmt *",
		"cargo doc *",
		"cargo build *",
		"cargo test *",
		"cargo nextest *",
		"cargo bench *",
		"cargo run *",
	],
	tester: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata *",
		"cargo tree *",
		"cargo locate-project *",
		"cargo check *",
		"cargo clippy *",
		"cargo fmt --check *",
		"cargo doc *",
		"cargo build *",
		"cargo test *",
		"cargo nextest *",
		"cargo bench *",
	],
	reviewer: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata *",
		"cargo tree *",
		"cargo locate-project *",
		"cargo check *",
		"cargo clippy *",
		"cargo fmt --check *",
		"cargo doc *",
		"cargo test *",
		"cargo nextest *",
	],
	researcher: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata *",
		"cargo tree *",
		"cargo locate-project *",
	],
};

// kiro allowedCommands strings that must exist verbatim, per agent.
const KIRO_RUST_ALLOWS: Record<RustAgent, string[]> = {
	implementer: [
		"cargo --version",
		"cargo metadata",
		"cargo metadata *",
		"cargo tree",
		"cargo tree *",
		"cargo locate-project",
		"cargo locate-project *",
		"cargo check",
		"cargo check *",
		"cargo clippy",
		"cargo clippy *",
		"cargo fmt",
		"cargo fmt *",
		"cargo doc",
		"cargo doc *",
		"cargo build",
		"cargo build *",
		"cargo test",
		"cargo test *",
		"cargo nextest",
		"cargo nextest *",
		"cargo bench",
		"cargo bench *",
		"cargo run",
		"cargo run *",
		"rustc --version",
		"rustup show",
	],
	tester: [
		"cargo --version",
		"cargo metadata",
		"cargo metadata *",
		"cargo tree",
		"cargo tree *",
		"cargo locate-project",
		"cargo locate-project *",
		"cargo check",
		"cargo check *",
		"cargo clippy",
		"cargo clippy *",
		"cargo fmt --check",
		"cargo fmt --check *",
		"cargo doc",
		"cargo doc *",
		"cargo build",
		"cargo build *",
		"cargo test",
		"cargo test *",
		"cargo nextest",
		"cargo nextest *",
		"cargo bench",
		"cargo bench *",
		"rustc --version",
		"rustup show",
	],
	reviewer: [
		"cargo --version",
		"cargo metadata",
		"cargo metadata *",
		"cargo tree",
		"cargo tree *",
		"cargo locate-project",
		"cargo locate-project *",
		"cargo check",
		"cargo check *",
		"cargo clippy",
		"cargo clippy *",
		"cargo fmt --check",
		"cargo fmt --check *",
		"cargo doc",
		"cargo doc *",
		"cargo test",
		"cargo test *",
		"cargo nextest",
		"cargo nextest *",
		"rustc --version",
		"rustup show",
	],
	researcher: [
		"cargo --version",
		"cargo metadata",
		"cargo metadata *",
		"cargo tree",
		"cargo tree *",
		"cargo locate-project",
		"cargo locate-project *",
		"rustc --version",
		"rustup show",
	],
};

// pi commands that must return `allow`, per agent. The pi frontmatter is
// deny-by-default, so a missing rule yields `default`, not `allow`.
const PI_RUST_ALLOWS: Record<RustAgent, string[]> = {
	implementer: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata",
		"cargo tree",
		"cargo locate-project",
		"cargo check",
		"cargo clippy",
		"cargo fmt --check",
		"cargo doc",
		"cargo build",
		"cargo test",
		"cargo nextest",
		"cargo bench",
		"cargo run",
		"cd /repo && cargo test",
	],
	tester: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata",
		"cargo tree",
		"cargo locate-project",
		"cargo check",
		"cargo clippy",
		"cargo fmt --check",
		"cargo doc",
		"cargo build",
		"cargo test",
		"cargo nextest",
		"cargo bench",
	],
	reviewer: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata",
		"cargo tree",
		"cargo locate-project",
		"cargo check",
		"cargo clippy",
		"cargo fmt --check",
		"cargo doc",
		"cargo test",
		"cargo nextest",
	],
	researcher: [
		"rustc --version",
		"cargo --version",
		"rustup show",
		"cargo metadata",
		"cargo tree",
		"cargo locate-project",
	],
};

// Engine residual: pi normalizes quotes and backslash escapes in its deny
// probes, so an obfuscated `--config` is still caught there. opencode and kiro
// are external engines that match literal text only; they deny the literal
// `--config` form, but an obfuscated `--config` is an ACCEPTED RESIDUAL there.

describe("rust toolchain permission doctrine", () => {
	test("pi: each agent allows its Rust read/build/test set", () => {
		for (const agent of RUST_AGENTS) {
			for (const command of PI_RUST_ALLOWS[agent]) {
				assert.equal(verdict(agent, command), "allow", `pi ${agent}: ${command}`);
			}
		}
	});

	test("pi: each agent never allows install/publish/rustup/config", () => {
		for (const agent of RUST_AGENTS) {
			for (const command of RUST_FORBIDDEN_NEVER_ALLOWED) {
				assert.notEqual(verdict(agent, command), "allow", `pi ${agent}: ${command}`);
			}
		}
	});

	test("pi implementer: cargo add/remove/update ask the user", () => {
		for (const command of ["cargo add serde", "cargo remove serde", "cargo update serde", "cargo upgrade serde"]) {
			assert.equal(verdict("implementer", command), "ask", command);
		}
	});

	// A prefix or a flag before the subcommand escapes the anchored allow rule.
	// The config override must hit the deny rule; the rest fall to deny-by-default.
	test("pi implementer: config overrides and unanchored cargo forms never allow", () => {
		const cases: Array<{ command: string; kind: Decision["kind"] }> = [
			{ command: "cargo check --config net.offline=true", kind: "deny" },
			{ command: "cargo --config net.offline=true check", kind: "deny" },
			{ command: "cargo build --config net.offline=false", kind: "deny" },
			{ command: "cargo +nightly build", kind: "default" },
			{ command: "/usr/bin/cargo build", kind: "default" },
			{ command: "FOO=1 cargo build", kind: "default" },
		];
		for (const { command, kind } of cases) {
			assert.equal(verdict("implementer", command), kind, `pi implementer: ${command}`);
		}
	});

	// FINDING 1 regression: a quote or a backslash escape must not smuggle a
	// config override past the deny bridge. `"a;b"` hides a separator;
	// `--co"nfig"` splits the flag token; `--co\nfig` escapes the `n`.
	test("pi: quoted, split, and backslash-escaped flags cannot allow a config override", () => {
		const commands = [
			'cargo build --features "a;b" --config net.offline=true',
			'cargo build --co"nfig" x',
			"cargo build --co\\nfig x",
		];
		for (const agent of RUST_AGENTS) {
			for (const command of commands) {
				assert.equal(verdict(agent, command), "deny", `pi ${agent}: ${command}`);
			}
		}
	});

	test("opencode: each agent carries the explicit Rust allow entries", () => {
		for (const agent of RUST_AGENTS) {
			for (const resource of OPENCODE_RUST_ALLOWS[agent]) {
				assert.ok(
					hasOpenCodeRule(agent, resource, "allow"),
					`opencode ${agent}: missing {shell, ${resource}, allow}`,
				);
			}
		}
	});

	test("opencode: the implementer carries both Rust skill allows", () => {
		const rules = loadOpenCodeRules("implementer");
		for (const skill of ["rust-quality-gates", "rust-implementation"]) {
			assert.ok(
				rules.some((rule) => rule.action === "skill" && rule.resource === skill && rule.effect === "allow"),
				`missing {skill, ${skill}, allow}`,
			);
		}
	});

	test("opencode: each agent behaves with its Rust allow set", () => {
		for (const agent of RUST_AGENTS) {
			for (const resource of OPENCODE_RUST_ALLOWS[agent]) {
				const command = resource.replace(/ \*$/, "");
				assert.equal(opencodeVerdict(agent, command), "allow", `opencode ${agent}: ${command}`);
			}
		}
	});

	test("opencode: each agent denies install/publish/rustup/config", () => {
		for (const agent of RUST_AGENTS) {
			for (const command of RUST_FORBIDDEN_NEVER_ALLOWED) {
				assert.equal(opencodeVerdict(agent, command), "deny", `opencode ${agent}: ${command}`);
			}
		}
	});

	test("opencode: each agent denies CARGO_HOME overrides", () => {
		for (const agent of RUST_AGENTS) {
			assert.ok(
				hasOpenCodeRule(agent, "*CARGO_HOME*", "deny"),
				`opencode ${agent}: missing {shell, *CARGO_HOME*, deny}`,
			);
			assert.equal(opencodeVerdict(agent, "CARGO_HOME=/tmp cargo build"), "deny", `opencode ${agent}: CARGO_HOME`);
		}
	});

	test("opencode: rustup show stays allowed and the mutating forms deny", () => {
		for (const agent of RUST_AGENTS) {
			assert.equal(opencodeVerdict(agent, "rustup show"), "allow", `opencode ${agent}: rustup show`);
			for (const command of [
				"rustup run stable cargo build",
				"rustup target add wasm32-unknown-unknown",
				"rustup override set nightly",
				"rustup set profile minimal",
				"rustup which cargo",
			]) {
				assert.equal(opencodeVerdict(agent, command), "deny", `opencode ${agent}: ${command}`);
			}
		}
	});

	test("kiro: each agent carries the explicit Rust allow strings", () => {
		for (const agent of RUST_AGENTS) {
			const allowed = loadKiroConfig(agent).toolsSettings?.shell?.allowedCommands ?? [];
			for (const command of KIRO_RUST_ALLOWS[agent]) {
				assert.ok(allowed.includes(command), `kiro ${agent}: missing allowedCommands ${command}`);
				// Existence alone is not enough: a deny glob must not shadow the allow.
				// A trailing " *" is the wildcard form, so the bare command is the probe.
				const probe = command.replace(/ \*$/, "");
				assert.equal(kiroVerdict(agent, probe), "allow", `kiro ${agent}: ${probe}`);
			}
		}
	});

	test("kiro: rustup show stays allowed and the mutating forms deny", () => {
		for (const agent of RUST_AGENTS) {
			assert.equal(kiroVerdict(agent, "rustup show"), "allow", `kiro ${agent}: rustup show`);
			for (const command of [
				"rustup",
				"rustup install stable",
				"rustup run stable cargo build",
				"rustup target add wasm32-unknown-unknown",
				"rustup override set nightly",
				"rustup set profile minimal",
				"rustup which cargo",
			]) {
				assert.equal(kiroVerdict(agent, command), "deny", `kiro ${agent}: ${command}`);
			}
		}
	});

	test("kiro: each agent denies install/publish/rustup/config", () => {
		for (const agent of RUST_AGENTS) {
			for (const command of RUST_FORBIDDEN_NEVER_ALLOWED) {
				assert.equal(kiroVerdict(agent, command), "deny", `kiro ${agent}: ${command}`);
			}
		}
	});

	test("boundary: reviewer allows cargo fmt --check but not cargo fmt", () => {
		assert.equal(verdict("reviewer", "cargo fmt --check"), "allow", "pi reviewer fmt --check");
		assert.notEqual(verdict("reviewer", "cargo fmt"), "allow", "pi reviewer fmt");
		assert.ok(hasOpenCodeRule("reviewer", "cargo fmt --check *", "allow"), "opencode reviewer fmt --check allow");
		assert.equal(opencodeVerdict("reviewer", "cargo fmt --check"), "allow", "opencode reviewer fmt --check");
		assert.notEqual(opencodeVerdict("reviewer", "cargo fmt"), "allow", "opencode reviewer fmt");
		assert.equal(kiroVerdict("reviewer", "cargo fmt --check"), "allow", "kiro reviewer fmt --check");
		assert.notEqual(kiroVerdict("reviewer", "cargo fmt"), "allow", "kiro reviewer fmt");
	});

	test("boundary: tester allows cargo build, reviewer denies it", () => {
		assert.equal(verdict("tester", "cargo build"), "allow", "pi tester build");
		assert.notEqual(verdict("reviewer", "cargo build"), "allow", "pi reviewer build");
		assert.equal(opencodeVerdict("tester", "cargo build"), "allow", "opencode tester build");
		assert.equal(opencodeVerdict("reviewer", "cargo build"), "deny", "opencode reviewer build");
		assert.equal(kiroVerdict("tester", "cargo build"), "allow", "kiro tester build");
		assert.equal(kiroVerdict("reviewer", "cargo build"), "deny", "kiro reviewer build");
	});
});

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

// T25 REVERT (owner decision). The ` *` wildcard allows are gone. On stacks that
// match the raw command string (kiro, opencode), an argument-bearing herdr call
// does not match any allow, so it falls to the platform default: ask. This is
// the fail-safe. The bare forms stay allowed.
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

// T26: `uv pip list` is read-only inventory the quality-gate skill does not
// order, so the implementer allow drops it on every stack.
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

	test("all stacks: uv pip list is not allowed (T26)", () => {
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
