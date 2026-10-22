/**
 * Permission regression harness for the git rebase and release doctrines.
 *
 * Covers the rebase ask entry, the rebase matrices, and the `gh release`
 * gate on every stack.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { evaluateCommandRules } from "../platforms/pi/extension/command-segments.ts";
import {
	KIRO_SHELL_AGENTS,
	OPENCODE_SHELL_AGENTS,
	PI_SHELL_AGENTS,
	hasKiroDeny,
	hasOpenCodeRule,
	kiroVerdict,
	loadAgentRules,
	opencodeVerdict,
	ruleSetMatches,
	verdict,
} from "./permission-templates.fixtures.ts";

// ---------------------------------------------------------------------------
// Git rebase doctrine: a rebase rewrites history, so the orchestrator asks
// (pi by an explicit rule; opencode and kiro by their shell defaults) and
// every non-orchestrator denies, matching the `git merge` doctrine. The pi
// ask rule entry itself is asserted, not just the engine default.
// ---------------------------------------------------------------------------

const REBASE_COMMANDS = [
	"git rebase",
	"git rebase -i",
	"git rebase --interactive",
	"git rebase --continue",
	"git rebase --abort",
	"git rebase --skip",
	"git rebase --onto main topic",
	"git rebase --autosquash main",
	"git rebase --root",
	"git rebase --exec 'true'",
	"git -C /tmp rebase main",
	"cd /repo && git rebase main",
	"env git rebase main",
];

// Commands the mirrored non-orchestrator deny rules cover on kiro and opencode.
// The mirror copies the merge block and adds the `git -C` family both commands
// carry, so the directory-flag form cannot slip past the deny.
const REBASE_GATED_COMMANDS = [
	"git rebase origin/main",
	"git -C /repo rebase main",
	"git -C /repo rebase",
	"cd /repo && git rebase origin/main",
];

// Separator-prefixed `-C` forms must not slip past the deny, mirroring the
// merge separator matrix.
const REBASE_SEPARATOR_COMMANDS = ["x;git -C /repo rebase", "foo&&git -C /repo rebase", "x|git -C /repo rebase"];

// The rebase `-C` rule family each stack must carry. The shared entries exist
// on both stacks; the bare start-anchored form is kiro-only.
const REBASE_C_RULES_SHARED = [
	"git -C * rebase *",
	"* git -C * rebase",
	"* git -C * rebase *",
	"*git -C * rebase *",
	"*git -C * rebase",
];
const REBASE_C_RULES_KIRO_ONLY = ["git -C * rebase"];

// The rebase mirror of the merge substitution/trailing-separator matrix.
const REBASE_SUBSTITUTION_COMMANDS = [
	"echo $(git rebase -i)",
	"echo `git rebase -i`",
	"echo $(git -C /repo rebase)",
	"echo `git -C /repo rebase`",
];

const REBASE_TRAILING_SEPARATOR_COMMANDS = [
	"git rebase; git status",
	"git -C /repo rebase; git status",
	"git rebase;git status",
	"git -C /repo rebase;git status",
];

const REBASE_SUBSTITUTION_RULES_SHARED = [
	"*$(git rebase*",
	"*`git rebase*",
	"*$(git -C * rebase*",
	"*`git -C * rebase*",
	"*git rebase;*",
	"*git -C * rebase;*",
];

// Compound separators must never turn a rebase into a silent allow.
const COMPOUND_REBASE_COMMANDS = [
	"git rebase -i; git push",
	"git rebase -i | cat",
	"echo $(git rebase -i)",
	"echo `git rebase -i`",
];

/** True when an ask rule can match `command` for bash, as the engine compiles it. */


describe("git rebase permission doctrine", () => {
	test("pi orchestrator: the rebase ask rule entry exists and is not an allow", () => {
		const { mode, ruleSets } = loadAgentRules("orchestrator");
		assert.equal(mode, "deny-by-default");
		assert.ok(
			ruleSetMatches(ruleSets.agentAsk, "git rebase main"),
			"the orchestrator ask list must carry an explicit git rebase rule",
		);
		assert.ok(
			!ruleSetMatches(ruleSets.agentAllow, "git rebase main"),
			"git rebase must not sit on the orchestrator allow list",
		);
	});

	test("pi orchestrator: bare rebase and every flag variant ask", () => {
		for (const command of REBASE_COMMANDS) assert.equal(verdict("orchestrator", command), "ask", command);
	});

	test("pi orchestrator: --exec asks from the agent rebase rule", () => {
		const { mode, ruleSets } = loadAgentRules("orchestrator");
		const decision = evaluateCommandRules(
			"git rebase --exec 'true'",
			true,
			ruleSets,
			mode,
			"bash",
			"orchestrator",
		);
		assert.equal(decision.kind, "ask");
		if (decision.kind === "ask") {
			assert.equal(decision.source, "agent");
			assert.equal(decision.rule.reason, "git rebase requires user approval");
		}
	});

	test("pi non-orchestrators: git rebase defaults to deny", () => {
		for (const agent of ["implementer", ...PI_SHELL_AGENTS]) {
			for (const command of REBASE_GATED_COMMANDS) {
				assert.equal(verdict(agent, command), "default", `${agent}: ${command}`);
			}
		}
	});

	test("opencode orchestrator: git rebase asks", () => {
		for (const command of REBASE_GATED_COMMANDS) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("opencode non-orchestrators: git rebase denies", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of REBASE_GATED_COMMANDS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro orchestrator: git rebase defaults to ask", () => {
		for (const command of REBASE_GATED_COMMANDS) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("kiro non-orchestrators: git rebase denies", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of REBASE_GATED_COMMANDS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	for (const command of COMPOUND_REBASE_COMMANDS) {
		test(`pi orchestrator: compound form never allows: ${command}`, () => {
			const kind = verdict("orchestrator", command);
			assert.notEqual(kind, "allow", command);
			assert.ok(kind === "ask" || kind === "deny", `${command}: ${kind}`);
		});
	}

	test("opencode non-orchestrators: separator-prefixed -C rebase denies", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of REBASE_SEPARATOR_COMMANDS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro non-orchestrators: separator-prefixed -C rebase denies", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of REBASE_SEPARATOR_COMMANDS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode non-orchestrators: every rebase -C rule shape exists", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const resource of REBASE_C_RULES_SHARED) {
				assert.ok(hasOpenCodeRule(agent, resource, "deny"), `${agent}: missing {shell, ${resource}, deny}`);
			}
		}
	});

	test("kiro non-orchestrators: every rebase -C rule shape exists", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const pattern of [...REBASE_C_RULES_SHARED, ...REBASE_C_RULES_KIRO_ONLY]) {
				assert.ok(hasKiroDeny(agent, pattern), `${agent}: missing deny ${pattern}`);
			}
		}
	});

	test("opencode/kiro non-orchestrators: space-free -C rebase rule exists on both stacks", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			assert.ok(hasOpenCodeRule(agent, "*git -C * rebase", "deny"), `${agent}: missing {shell, *git -C * rebase, deny}`);
		}
		for (const agent of KIRO_SHELL_AGENTS) {
			assert.ok(hasKiroDeny(agent, "*git -C * rebase"), `${agent}: missing deny *git -C * rebase`);
		}
	});

	test("opencode non-orchestrators: rebase substitution and trailing-separator deny", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of [...REBASE_SUBSTITUTION_COMMANDS, ...REBASE_TRAILING_SEPARATOR_COMMANDS]) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro non-orchestrators: rebase substitution and trailing-separator deny", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of [...REBASE_SUBSTITUTION_COMMANDS, ...REBASE_TRAILING_SEPARATOR_COMMANDS]) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode orchestrator: rebase substitution and trailing-separator ask", () => {
		for (const command of [...REBASE_SUBSTITUTION_COMMANDS, ...REBASE_TRAILING_SEPARATOR_COMMANDS]) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("kiro orchestrator: rebase substitution and trailing-separator ask", () => {
		for (const command of [...REBASE_SUBSTITUTION_COMMANDS, ...REBASE_TRAILING_SEPARATOR_COMMANDS]) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("opencode non-orchestrators: every rebase substitution/trailing rule shape exists", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const resource of REBASE_SUBSTITUTION_RULES_SHARED) {
				assert.ok(hasOpenCodeRule(agent, resource, "deny"), `${agent}: missing {shell, ${resource}, deny}`);
			}
		}
	});

	test("kiro non-orchestrators: every rebase substitution/trailing rule shape exists", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const pattern of REBASE_SUBSTITUTION_RULES_SHARED) {
				assert.ok(hasKiroDeny(agent, pattern), `${agent}: missing deny ${pattern}`);
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
