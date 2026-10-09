/**
 * Regression harness for the git-write permission doctrine on the pi platform.
 *
 * Loads the shipped pi agent frontmatters and asserts the verdict matrix:
 *   orchestrator                                -> ASK for add/commit/push/pull and `gh pr`
 *   implementer                                 -> DENY for add/commit/push/pull and `gh pr`
 *   researcher/reviewer/tester/planner/overseer -> DENY for push/pull and `gh pr`
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

const OTHER_AGENTS = ["researcher", "reviewer", "tester", "planner", "overseer"];

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
		for (const agent of ["implementer", ...OTHER_AGENTS]) {
			assert.equal(verdict(agent, "npm test && git push"), "deny", agent);
		}
	});

	for (const agent of OTHER_AGENTS) {
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
		for (const agent of ["implementer", ...OTHER_AGENTS]) {
			for (const command of ENV_PREFIXED) assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
		}
	});

	test("orchestrator: destructive branch asks, read-only stays allowed", () => {
		for (const command of BRANCH_DESTRUCTIVE) assert.equal(verdict("orchestrator", command), "ask", command);
		assert.equal(verdict("orchestrator", "git branch -a"), "allow");
		assert.equal(verdict("orchestrator", "git branch"), "allow");
	});

	test("non-orchestrators: destructive branch denies, read-only not denied", () => {
		for (const agent of ["implementer", ...OTHER_AGENTS]) {
			for (const command of BRANCH_DESTRUCTIVE) assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			assert.notEqual(verdict(agent, "git branch -a"), "deny", `${agent}: git branch -a`);
		}
	});

	test("planner: sudo-prefixed git push denies", () => {
		assert.equal(verdict("planner", "sudo -E env git push"), "deny");
	});

	test("xargs-wrapped git push is blocked, never ask", () => {
		for (const agent of ["orchestrator", "implementer", ...OTHER_AGENTS]) {
			const kind = verdict(agent, "xargs git push");
			assert.notEqual(kind, "ask", agent);
			assert.notEqual(kind, "allow", agent);
		}
	});

	test("orchestrator: sudo option-flag writes ask", () => {
		for (const command of SUDO_FLAG_WRITES) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("non-orchestrators: sudo option-flag writes deny", () => {
		for (const agent of ["implementer", ...OTHER_AGENTS]) {
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

const OPENCODE_AGENTS = [
	"implementer",
	"implementer-python",
	"implementer-react",
	"researcher",
	"reviewer",
	"tester",
	"planner",
	"overseer",
];
const KIRO_AGENTS = [...OPENCODE_AGENTS];

describe("opencode: env-prefix bypass and branch gate", () => {
	test("orchestrator: writes ask", () => {
		for (const command of [...ENV_PREFIXED, ...WRITE_BARE]) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("non-orchestrators: env-prefixed and bare writes deny", () => {
		for (const agent of OPENCODE_AGENTS) {
			for (const command of [...ENV_PREFIXED, ...WRITE_BARE]) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("non-orchestrators: destructive branch denies", () => {
		for (const agent of OPENCODE_AGENTS) {
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
		for (const agent of OPENCODE_AGENTS) {
			for (const command of READ_ONLY_BRANCH) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("non-orchestrators: xargs-wrapped writes deny", () => {
		for (const agent of OPENCODE_AGENTS) {
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
		for (const agent of KIRO_AGENTS) {
			for (const command of [...ENV_PREFIXED, ...WRITE_BARE]) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("non-orchestrators: destructive branch denies", () => {
		for (const agent of KIRO_AGENTS) {
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
		for (const agent of KIRO_AGENTS) assert.equal(kiroVerdict(agent, "xargs git push"), "deny", agent);
		assert.equal(kiroVerdict("orchestrator", "xargs git push"), "ask");
	});

	test("non-orchestrators: read-only branch stays not denied", () => {
		for (const agent of KIRO_AGENTS) {
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
		for (const agent of OPENCODE_AGENTS) {
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
		for (const agent of KIRO_AGENTS) {
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
		for (const agent of ["orchestrator", ...OPENCODE_AGENTS]) {
			for (const command of READ_ONLY_AFTER_CATCHALL) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: read-only commands are not denied", () => {
		for (const agent of ["orchestrator", ...KIRO_AGENTS]) {
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
			for (const agent of ["implementer", ...OTHER_AGENTS]) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("pi: plain read-only branch commands are not denied", () => {
		for (const command of READ_ONLY_BRANCH_PLAIN) {
			for (const agent of ["orchestrator", "implementer", ...OTHER_AGENTS]) {
				assert.notEqual(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("pi: writes hidden behind a broad allow ask the orchestrator and deny others", () => {
		for (const command of HIDDEN_WRITES) {
			assert.equal(verdict("orchestrator", command), "ask", command);
			for (const agent of ["implementer", ...OTHER_AGENTS]) {
				assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode: a leading branch flag cannot hide the destructive flag", () => {
		for (const command of BRANCH_FLAG_ORDER) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
			for (const agent of OPENCODE_AGENTS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode: plain read-only branch commands are not denied", () => {
		for (const command of READ_ONLY_BRANCH_PLAIN) {
			for (const agent of ["orchestrator", ...OPENCODE_AGENTS]) {
				assert.notEqual(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode: writes hidden behind a broad allow ask the orchestrator and deny others", () => {
		for (const command of HIDDEN_WRITES) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
			for (const agent of OPENCODE_AGENTS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: a leading branch flag cannot hide the destructive flag", () => {
		for (const command of BRANCH_FLAG_ORDER) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
			for (const agent of KIRO_AGENTS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: plain read-only branch commands are not denied", () => {
		for (const command of READ_ONLY_BRANCH_PLAIN) {
			for (const agent of ["orchestrator", ...KIRO_AGENTS]) {
				assert.notEqual(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro: writes hidden behind a broad allow ask the orchestrator and deny others", () => {
		for (const command of HIDDEN_WRITES) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
			for (const agent of KIRO_AGENTS) {
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
		for (const agent of ["implementer", ...OTHER_AGENTS]) {
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
		for (const agent of ["implementer", ...OTHER_AGENTS]) {
			for (const command of READONLY_ABUSE) assert.equal(verdict(agent, command), "deny", `${agent}: ${command}`);
		}
	});

	test("all agents: plain read-only reflog/fetch/remote are not denied", () => {
		for (const agent of ["orchestrator", "implementer", ...OTHER_AGENTS]) {
			for (const command of READONLY_SAFE) assert.notEqual(verdict(agent, command), "deny", `${agent}: ${command}`);
		}
	});
});
