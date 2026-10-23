/**
 * Permission regression harness for the git tag and merge doctrines.
 *
 * Covers tag create, force, and delete, the accepted over-denies, and the
 * merge, merge-base, and substitution matrices on every stack.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
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
// Git tag doctrine: a plain tag creation allows the pi orchestrator; a wrapped
// creation and a force-move ask it. Creation and force-move ask the opencode
// orchestrator and stay unlisted (ask) on kiro. Deletion denies every agent. Read-only
// listing stays allowed on pi. Every non-orchestrator must not create a tag.
// ---------------------------------------------------------------------------

const TAG_CREATE = [
	"git tag v3.0.0",
	"git -C /repo tag v3.0.0",
	"cd /repo && git tag v3.0.0",
	"git tag -am \"v3.0.0 release\" v3.0.0",
	"git tag -a v1 -m x",
];

const TAG_CREATE_WRAPPED = ["env git tag v3.0.0", "echo $(git tag v3.0.0)"];

// Tag deletion denies every agent. A short cluster that contains `d` anywhere
// is a delete, so DELETE wins over a force flag in the same cluster.
const TAG_DELETE = [
	"git tag -d v3.0.0",
	"git tag --delete v3.0.0",
	"git tag --delet v1",
	"git tag -df v3.0.0",
	"git tag -fd v3.0.0",
	"git tag -fad v3.0.0",
	"git tag -a -d v3.0.0 -m x",
];

const TAG_DELETE_WRAPPED = [
	"env git tag -d v3.0.0",
	"env git tag --delete v3.0.0",
	"echo $(git tag -d v3.0.0)",
	"echo $(git tag --delete v3.0.0)",
];

const TAG_DELETE_C = [
	"echo $(git -C /repo tag -d v3.0.0)",
	"echo `git -C /repo tag -d v3.0.0`",
	"echo $(git -C /repo tag --delete v3.0.0)",
	"echo `git -C /repo tag --delete v3.0.0`",
];

const TAG_DELETE_ALL = [...TAG_DELETE, ...TAG_DELETE_WRAPPED, ...TAG_DELETE_C];

// Tag force-move asks the orchestrator on all three stacks. A short cluster
// with force but no `d` is a force form. Git accepts any unambiguous long
// option prefix, so `--forc` is force.
const TAG_FORCE = [
	"git tag -f v3.0.0",
	"git tag --force v3.0.0",
	"git tag --forc v1",
	"git tag --for v1",
	"git tag -af v3.0.0",
	"git tag -fa v3.0.0",
	"git tag -a -f v3.0.0 -m x",
	"git tag -m release -f v3.0.0",
];

const TAG_FORCE_WRAPPED = [
	"env git tag -f v3.0.0",
	"env git tag --force v3.0.0",
	"echo $(git tag -f v3.0.0)",
	"echo $(git tag --force v3.0.0)",
];

const TAG_FORCE_C = [
	"echo $(git -C /repo tag -f v3.0.0)",
	"echo `git -C /repo tag -f v3.0.0`",
	"echo $(git -C /repo tag --force v3.0.0)",
	"echo `git -C /repo tag --force v3.0.0`",
];

const TAG_FORCE_ALL = [...TAG_FORCE, ...TAG_FORCE_WRAPPED, ...TAG_FORCE_C];

// A tag NAME may contain `-d`/`-f`. These are not flags and must never deny.
const TAG_NAME_FALSE_POSITIVES = ["git tag v1.0.0-final", "git tag v2.0.0-delta"];

const TAG_LISTING = ["git tag", "git tag -l", "git tag --list", "git -C /repo tag -l"];

const TAG_ALL = [...TAG_CREATE, ...TAG_CREATE_WRAPPED, ...TAG_DELETE_ALL, ...TAG_FORCE_ALL];

describe("pi: git tag doctrine", () => {
	test("orchestrator: plain tag creation allows", () => {
		for (const command of TAG_CREATE) {
			assert.equal(verdict("orchestrator", command), "allow", command);
		}
	});

	test("orchestrator: wrapped tag creation asks", () => {
		for (const command of TAG_CREATE_WRAPPED) {
			assert.equal(verdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: the tag force ask rule entry exists and beats the plain allow", () => {
		const { mode, ruleSets } = loadAgentRules("orchestrator");
		assert.equal(mode, "deny-by-default");
		assert.ok(
			ruleSetMatches(ruleSets.agentAsk, "git tag -f v3.0.0"),
			"the orchestrator ask list must carry an explicit git tag rule that covers force",
		);
		assert.ok(
			!ruleSetMatches(ruleSets.agentAsk, "git tag v3.0.0"),
			"the tag force ask rule must not match a plain tag creation",
		);
		// The plain history allow also matches the force form; the ask runs first.
		assert.equal(verdict("orchestrator", "git tag -f v3.0.0"), "ask");
	});

	test("orchestrator: tag force-move asks in any position", () => {
		for (const command of TAG_FORCE_ALL) {
			assert.equal(verdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: tag delete denies in any position", () => {
		for (const command of TAG_DELETE_ALL) {
			assert.equal(verdict("orchestrator", command), "deny", command);
		}
	});

	test("orchestrator: tag names containing -d/-f are not denied and not asked", () => {
		for (const command of TAG_NAME_FALSE_POSITIVES) {
			assert.equal(verdict("orchestrator", command), "allow", command);
		}
	});

	test("orchestrator: --format is not caught by the --for abbreviation", () => {
		assert.equal(verdict("orchestrator", "git tag --format=%(refname) -l"), "allow");
	});

	test("orchestrator: --merged is not caught by the delete flag rule", () => {
		assert.equal(verdict("orchestrator", "git tag --merged"), "allow");
	});

	test("orchestrator: read-only tag listing stays allowed", () => {
		for (const command of TAG_LISTING) {
			assert.equal(verdict("orchestrator", command), "allow", command);
		}
	});

	test("non-orchestrators: tag creation, force, and delete forms default", () => {
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

	test("orchestrator: explicit tag delete deny rules exist", () => {
		for (const resource of [
			"git tag -d*",
			"git tag --delete*",
			"git tag * -d*",
			"git tag * --delete*",
			"*git tag -*d*",
			"git -C * tag -d*",
			"git -C * tag --delete*",
		]) {
			assert.ok(hasOpenCodeRule("orchestrator", resource, "deny"), `missing {shell, ${resource}, deny}`);
		}
	});

	test("orchestrator: tag creation asks", () => {
		for (const command of [...TAG_CREATE, ...TAG_CREATE_WRAPPED]) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: tag force-move asks in any position", () => {
		for (const command of TAG_FORCE_ALL) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: tag delete denies in any position", () => {
		for (const command of TAG_DELETE_ALL) {
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

	test("non-orchestrators: tag creation, force, and delete forms deny", () => {
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

	test("orchestrator: explicit tag delete deny entries exist", () => {
		for (const pattern of [
			"git tag -d*",
			"git tag --delete*",
			"git tag * -d*",
			"git tag * --delete*",
			"*git tag -*d*",
			"git -C * tag -d*",
			"git -C * tag --delete*",
		]) {
			assert.ok(hasKiroDeny("orchestrator", pattern), `missing deniedCommands ${pattern}`);
		}
	});

	test("orchestrator: tag force-move asks in any position", () => {
		for (const command of TAG_FORCE_ALL) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("orchestrator: tag delete denies in any position", () => {
		for (const command of TAG_DELETE_ALL) {
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

	test("non-orchestrators: tag creation, force, and delete forms deny", () => {
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
// Accepted trade-off: the delete space-free glob `*git tag -*d*` cannot tell
// the `-d` flag from a read-only long option that contains `d`, so `--merged`
// is over-denied on opencode/kiro. The user chose fail-safe over-deny. pi uses
// a real regex with word boundaries, so it stays precise and allows it (a
// plain tag command allows for the pi orchestrator). Removing the force
// space-free glob un-denied `--format=...`; it asks on opencode and kiro and
// allows on pi.
// ---------------------------------------------------------------------------

const TAG_READONLY_DELETE_OVERDENIED = ["git tag --merged"];
const TAG_READONLY_FORMAT = "git tag --format=%(refname) -l";

describe("opencode/kiro: accepted over-deny for read-only tag long options", () => {
	test("opencode orchestrator: --merged denies (accepted delete over-deny)", () => {
		for (const command of TAG_READONLY_DELETE_OVERDENIED) {
			assert.equal(opencodeVerdict("orchestrator", command), "deny", command);
		}
	});

	test("kiro orchestrator: --merged denies (accepted delete over-deny)", () => {
		for (const command of TAG_READONLY_DELETE_OVERDENIED) {
			assert.equal(kiroVerdict("orchestrator", command), "deny", command);
		}
	});

	test("orchestrators: --format allows on pi and asks on opencode and kiro", () => {
		assert.equal(verdict("orchestrator", TAG_READONLY_FORMAT), "allow");
		assert.equal(opencodeVerdict("orchestrator", TAG_READONLY_FORMAT), "ask");
		assert.equal(kiroVerdict("orchestrator", TAG_READONLY_FORMAT), "ask");
	});
});

// ---------------------------------------------------------------------------
// Git merge doctrine: a plain merge allows the pi orchestrator (owner choice);
// a merge asks the opencode orchestrator and stays unlisted (ask) on kiro. Every non-orchestrator must not
// merge: pi blocks by deny-by-default mode; opencode and kiro carry explicit
// deny rules.
// ---------------------------------------------------------------------------

const MERGE_COMMANDS = [
	"git merge origin/main",
	"git -C /repo merge main",
	"git -C /repo merge",
	"cd /repo && git merge origin/main",
];

// Separator-prefixed `-C` forms must not slip past the deny. On kiro the
// `*git -C * merge` rule ends at the verb and covers the space-free form; the
// opencode family carries the same space-free rule.
const MERGE_SEPARATOR_COMMANDS = ["x;git -C /repo merge", "foo&&git -C /repo merge", "x|git -C /repo merge"];

// The `-C` rule family each stack must carry. The shared entries exist on both
// stacks; the bare start-anchored form is kiro-only. A missing entry fails the
// presence test below, so one rule cannot hide behind another.
const MERGE_C_RULES_SHARED = [
	"git -C * merge *",
	"* git -C * merge",
	"* git -C * merge *",
	"*git -C * merge *",
	"*git -C * merge",
];
const MERGE_C_RULES_KIRO_ONLY = ["git -C * merge"];

// Command-substitution and backtick forms mirror the tag family guard
// (`*$(git tag*`, `*`git tag*`). Without these, `echo $(git -C /repo merge)`
// falls through to ask on kiro/opencode. The trailing-separator rules keep a
// bare verb followed by `;` denied while the literal `merge;` boundary leaves
// the read-only `git merge-base` untouched.
const MERGE_SUBSTITUTION_COMMANDS = [
	"echo $(git merge main)",
	"echo `git merge main`",
	"echo $(git -C /repo merge)",
	"echo `git -C /repo merge`",
];

const MERGE_TRAILING_SEPARATOR_COMMANDS = [
	"git merge; git status",
	"git -C /repo merge; git status",
	"git merge;git status",
	"git -C /repo merge;git status",
];

const MERGE_SUBSTITUTION_RULES_SHARED = [
	"*$(git merge*",
	"*`git merge*",
	"*$(git -C * merge*",
	"*`git -C * merge*",
	"*git merge;*",
	"*git -C * merge;*",
];

// A boundary slip in the merge rules could turn the read-only `git merge-base`
// into an ask (opencode, where the last match wins) or a deny (kiro).
const MERGE_BASE_COMMAND = "git merge-base origin/dev origin/main";
const MERGE_BASE_COMMANDS = [MERGE_BASE_COMMAND, "git -C /repo merge-base origin/dev origin/main"];
// `git merge-file`/`git merge-tree` share the `merge` token but are not
// merge-base. They must not fall into the merge ask or the merge deny.
const MERGE_NEAR_MISS_COMMANDS = ["git merge-file a b c", "git merge-tree base head"];

describe("git merge permission doctrine", () => {
	test("pi orchestrator: plain git merge allows", () => {
		for (const command of MERGE_COMMANDS) assert.equal(verdict("orchestrator", command), "allow", command);
	});

	test("pi orchestrator: wrapped git merge asks", () => {
		for (const command of MERGE_SUBSTITUTION_COMMANDS) {
			assert.equal(verdict("orchestrator", command), "ask", command);
		}
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

	test("opencode orchestrator: git merge-base asks (the free-argument allow is gone)", () => {
		for (const command of MERGE_BASE_COMMANDS) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
		assert.ok(
			!hasOpenCodeRule("orchestrator", "git -C * merge-base *", "allow"),
			"the free-argument git -C * merge-base * allow must be gone",
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

	test("opencode non-orchestrators: separator-prefixed -C merge denies", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of MERGE_SEPARATOR_COMMANDS) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro non-orchestrators: separator-prefixed -C merge denies", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of MERGE_SEPARATOR_COMMANDS) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode non-orchestrators: every merge -C rule shape exists", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const resource of MERGE_C_RULES_SHARED) {
				assert.ok(hasOpenCodeRule(agent, resource, "deny"), `${agent}: missing {shell, ${resource}, deny}`);
			}
		}
	});

	test("kiro non-orchestrators: every merge -C rule shape exists", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const pattern of [...MERGE_C_RULES_SHARED, ...MERGE_C_RULES_KIRO_ONLY]) {
				assert.ok(hasKiroDeny(agent, pattern), `${agent}: missing deny ${pattern}`);
			}
		}
	});

	test("opencode/kiro non-orchestrators: space-free -C merge rule exists on both stacks", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			assert.ok(hasOpenCodeRule(agent, "*git -C * merge", "deny"), `${agent}: missing {shell, *git -C * merge, deny}`);
		}
		for (const agent of KIRO_SHELL_AGENTS) {
			assert.ok(hasKiroDeny(agent, "*git -C * merge"), `${agent}: missing deny *git -C * merge`);
		}
	});

	test("opencode non-orchestrators: merge substitution and trailing-separator deny", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of [...MERGE_SUBSTITUTION_COMMANDS, ...MERGE_TRAILING_SEPARATOR_COMMANDS]) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro non-orchestrators: merge substitution and trailing-separator deny", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of [...MERGE_SUBSTITUTION_COMMANDS, ...MERGE_TRAILING_SEPARATOR_COMMANDS]) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("opencode orchestrator: merge substitution and trailing-separator ask", () => {
		for (const command of [...MERGE_SUBSTITUTION_COMMANDS, ...MERGE_TRAILING_SEPARATOR_COMMANDS]) {
			assert.equal(opencodeVerdict("orchestrator", command), "ask", command);
		}
	});

	test("kiro orchestrator: merge substitution and trailing-separator ask", () => {
		for (const command of [...MERGE_SUBSTITUTION_COMMANDS, ...MERGE_TRAILING_SEPARATOR_COMMANDS]) {
			assert.equal(kiroVerdict("orchestrator", command), "ask", command);
		}
	});

	test("opencode non-orchestrators: every merge substitution/trailing rule shape exists", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const resource of MERGE_SUBSTITUTION_RULES_SHARED) {
				assert.ok(hasOpenCodeRule(agent, resource, "deny"), `${agent}: missing {shell, ${resource}, deny}`);
			}
		}
	});

	test("kiro non-orchestrators: every merge substitution/trailing rule shape exists", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const pattern of MERGE_SUBSTITUTION_RULES_SHARED) {
				assert.ok(hasKiroDeny(agent, pattern), `${agent}: missing deny ${pattern}`);
			}
		}
	});

	test("opencode/kiro non-orchestrators: git -C /repo merge-base main is not denied", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			assert.notEqual(opencodeVerdict(agent, "git -C /repo merge-base main"), "deny", agent);
		}
		for (const agent of KIRO_SHELL_AGENTS) {
			assert.notEqual(kiroVerdict(agent, "git -C /repo merge-base main"), "deny", agent);
		}
	});
});

// ---------------------------------------------------------------------------
// Accepted trade-off: the space-free `-C` merge rule cannot separate the verb
// from a later argument. A read-only `git -C /repo log --grep merge` ends in
// the `merge` token, so `*git -C * merge` (kiro) and the trailing-optional
// `*git -C * merge *` (opencode) both deny it. Same fail-safe over-deny as the
// tag long options: a false deny is safer than a missed merge. pi uses a real
// regex with word boundaries and stays precise.
// ---------------------------------------------------------------------------

const MERGE_READONLY_OVERDENIED = ["git -C /repo log --grep merge"];

describe("opencode/kiro: accepted over-deny for a read-only argument ending in merge", () => {
	test("opencode non-orchestrators: read-only --grep merge denies (accepted over-deny)", () => {
		for (const agent of OPENCODE_SHELL_AGENTS) {
			for (const command of MERGE_READONLY_OVERDENIED) {
				assert.equal(opencodeVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});

	test("kiro non-orchestrators: read-only --grep merge denies (accepted over-deny)", () => {
		for (const agent of KIRO_SHELL_AGENTS) {
			for (const command of MERGE_READONLY_OVERDENIED) {
				assert.equal(kiroVerdict(agent, command), "deny", `${agent}: ${command}`);
			}
		}
	});
});
