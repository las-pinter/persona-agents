/**
 * The gate source cases for the permission rule table.
 *
 * The file holds how the gate source binds a resolved agent to its class and to
 * its rows.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { compileClass, compileRole } from "./permission-table-groups.ts";
import type { Role } from "./permission-class.ts";
import { RULE_ROWS } from "./permissions.table.ts";
import { compileGateSource } from "./permissions.ts";
import type { AgentConfig } from "./resolver.ts";
import {
	FIXTURE_ROOT,
	allowMatches,
	gateVerdict,
	rowReason,
	sourceDecision,
	verdictOf,
} from "./permission-table.test-helpers.ts";

// --- the gate source --------------------------------------------------------

/** A minimal resolved agent for the gate-source cases. */
function agentFor(options: Partial<AgentConfig> & Pick<AgentConfig, "name">): AgentConfig {
	return {
		description: "gate source case",
		systemPrompt: "",
		source: "user",
		filePath: `${FIXTURE_ROOT}/${options.name}.md`,
		...options,
	};
}

test("the gate source binds a shipped profession whose class matches", () => {
	const resolved = compileGateSource()(
		agentFor({ name: "planner", permissionClass: "reader", source: "package" }),
	);
	assert.equal(resolved.mode, "deny-by-default");
	assert.deepEqual(resolved.ruleSets, compileRole(RULE_ROWS, "planner"));
	assert.equal(allowMatches(resolved.ruleSets, "edit", `${FIXTURE_ROOT}/agent-notes/planner/x.md`), true);
});

test("the gate source binds a custom agent name to its class", () => {
	const resolved = compileGateSource()(agentFor({ name: "my-helper", permissionClass: "reader" }));
	assert.equal(resolved.mode, "deny-by-default");
	assert.deepEqual(resolved.ruleSets, compileClass(RULE_ROWS, "reader"));
});

test("an unnamed reader-class agent gets the mode default for the verification scripts", () => {
	const resolved = compileGateSource()(agentFor({ name: "my-helper", permissionClass: "reader" }));
	assert.equal(resolved.mode, "deny-by-default");
	// No row matches, so deny-by-default turns the call into a deny.
	for (const probe of ["npm test", "npm run typecheck", "npm run lint"]) {
		assert.equal(
			verdictOf(resolved.ruleSets, "bash", probe),
			"none",
			`${probe} matched a row for an unnamed reader agent`,
		);
	}
});

/** The three ask rows that widen to an unnamed worker-class agent. */
const UNNAMED_WORKER_ASK = ["cp a b", "mv a b", "rsync -a a b", "rm a.txt", "git rm a.txt"];

test("an unnamed worker-class agent asks for cp, mv, rsync, rm, and git rm", () => {
	const resolved = compileGateSource()(agentFor({ name: "my-helper", permissionClass: "worker" }));
	assert.equal(resolved.mode, "deny-by-default");
	for (const probe of UNNAMED_WORKER_ASK) {
		assert.equal(verdictOf(resolved.ruleSets, "bash", probe), "ask", probe);
	}
	// The widening stops at these three rows: a recursive removal denies, and the
	// class rows an unnamed worker already holds still allow.
	assert.equal(verdictOf(resolved.ruleSets, "bash", "rm -rf build"), "deny");
	assert.equal(verdictOf(resolved.ruleSets, "bash", "cargo build"), "allow");
});

test("the shipped gate source asks an unnamed worker-class agent for cp through the engine", () => {
	const agent = agentFor({ name: "my-helper", permissionClass: "worker", source: "package" });
	const resolved = compileGateSource()(agent);
	const decision = sourceDecision(resolved, "bash", "cp a b", agent.name);
	assert.equal(decision.kind, "ask", "the engine reached no ask for cp a b");
	if (decision.kind !== "ask") return;
	assert.equal(decision.source, "agent");
	assert.equal(decision.rule.reason, rowReason("file.move.ask"));
});

test("the named roles keep their verdict for the three ask rows", () => {
	for (const probe of UNNAMED_WORKER_ASK) {
		assert.equal(gateVerdict("implementer", "bash", probe), "ask", probe);
		for (const role of ["tester", "reviewer"] as Role[]) {
			assert.equal(gateVerdict(role, "bash", probe), "deny", `${role}: ${probe}`);
		}
	}
});

test("the reviewer asks for npx and a package publish", () => {
	// Both rows are global asks, and an ask outranks the reviewer verification allow.
	assert.equal(gateVerdict("reviewer", "bash", "npx create-app"), "ask");
	assert.equal(gateVerdict("reviewer", "bash", "npm publish"), "ask");
});

test("the gate source binds a mismatched class to the named class", () => {
	const resolved = compileGateSource()(
		agentFor({ name: "planner", permissionClass: "worker", source: "package" }),
	);
	assert.equal(resolved.mode, "deny-by-default");
	assert.deepEqual(resolved.ruleSets, compileClass(RULE_ROWS, "worker"));
});

test("the gate source loads a missing class as reader", () => {
	const resolved = compileGateSource()(agentFor({ name: "my-helper" }));
	assert.equal(resolved.mode, "deny-by-default");
	assert.deepEqual(resolved.ruleSets, compileClass(RULE_ROWS, "reader"));
});

test("the gate source keeps only the global rows with no active agent", () => {
	const resolved = compileGateSource()(null);
	assert.equal(resolved.mode, "allow-unless-matched");
	assert.deepEqual(resolved.ruleSets.globalDeny, compileClass(RULE_ROWS, "reader").globalDeny);
	assert.deepEqual(resolved.ruleSets.globalAsk, compileClass(RULE_ROWS, "reader").globalAsk);
	assert.deepEqual(resolved.ruleSets.agentDeny, []);
	assert.deepEqual(resolved.ruleSets.agentAsk, []);
	assert.deepEqual(resolved.ruleSets.agentAllow, []);
});

test("a user file named planner with no class gets the reader fence and no planner notes zone", () => {
	const resolved = compileGateSource()(agentFor({ name: "planner", source: "user" }));
	assert.equal(resolved.mode, "deny-by-default");
	assert.deepEqual(resolved.ruleSets, compileClass(RULE_ROWS, "reader"));
	assert.equal(allowMatches(resolved.ruleSets, "edit", `${FIXTURE_ROOT}/agent-notes/planner/x.md`), false);
});
