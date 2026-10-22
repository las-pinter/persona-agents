/**
 * Regression harness for the git-write permission doctrine on the pi platform.
 *
 * Loads the shipped pi agent frontmatters and asserts the verdict matrix:
 *   orchestrator                                -> ASK for add/commit/push/pull and `gh pr`/`gh release`
 *   implementer                                 -> DENY for add/commit/push/pull and `gh pr`/`gh release`
 *   researcher/reviewer/tester/planner          -> DENY for push/pull and `gh pr`/`gh release`
 *
 * Also checks the live global file does not keep a push/pull or `gh pr` deny.
 * That check skips when the file is absent, because the file is outside the repo.
 *
 * Run: npm test
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { evaluateCommandRules, type Decision } from "../platforms/pi/extension/command-segments.ts";
import {
	KIRO_SHELL_AGENTS,
	OPENCODE_SHELL_AGENTS,
	PI_SHELL_AGENTS,
	kiroVerdict,
	loadGlobalRuleSets,
	liveGlobalPath,
	opencodeVerdict,
	verdict,
} from "./permission-templates.fixtures.ts";

const WRITE_COMMANDS = [
	"git add agent-stack/foo.ts",
	'git commit -m "test"',
	"git push",
	"git pull",
	"gh pr create --fill",
];

const ANCHORED_COMMANDS = ["git -C /repo push", "cd /repo && git push"];

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
