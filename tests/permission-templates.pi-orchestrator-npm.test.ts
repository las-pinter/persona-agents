/**
 * Permission regression harness for the pi orchestrator verification scripts.
 *
 * Owner decision: the orchestrator holds the tools its platform grants, so it
 * can verify its own work. Three npm scripts allow without a prompt:
 * `npm test`, `npm run typecheck`, and `npm run lint`. Each script is named on
 * its own in the template. A bare `npm`, a wildcard `npm run *`, a sibling
 * script, `npm install`, `npm publish`, `npx`, and `node` stay blocked.
 *
 * The allow rule carries no `cd` prefix, so the three scripts run in the
 * session working directory only. `cd x && npm test` runs the package.json of
 * another directory, and the gate folds `cd x ; npm test` into the same form,
 * so both forms fall to the default verdict.
 *
 * The gate allows a command only when every segment matches an allow rule, and
 * a deny rule beats an allow rule. So four tails cannot ride on a script:
 *
 *   - a redirect tail (`> out.txt`, `> /tmp/x`, `>> out.txt`) denies;
 *   - a pipe into `tee` denies;
 *   - a separator tail reaches its own segment, where the `git push` ask rule
 *     or the named-file delete ask rule wins over the allow;
 *   - a substitution tail reaches its own segment, where the `git push` ask
 *     rule wins over the allow.
 *
 * Another profession keeps its current verdict on `npm test`: the implementer,
 * the reviewer, and the tester already allowed it, while the planner never did.
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { verdict } from "./permission-templates.fixtures.ts";

/** The three scripts the orchestrator runs to verify its own work. */
const ALLOWED = ["npm test", "npm run typecheck", "npm run lint"];

/**
 * Every other npm form, and the sibling runners. Each form carries one word
 * more or one wrapper more than an allowed form, so the anchored rule misses.
 */
const DEFAULT: string[] = [
	"npm",
	"npm --version",
	"npm install",
	"npm install left-pad",
	"npm ci",
	"npm publish",
	"npm run",
	"npm run *",
	"npm run build",
	"npm run test",
	"npm run start",
	"npm test --",
	"npm test -- --watch",
	"npm testx",
	"npm run typecheckx",
	'npm "test"',
	"npm\\ test",
	"command npm test",
	"env npm test",
	"/usr/bin/npm test",
	"cd x && npm test",
	"cd x ; npm test",
	"npx jest",
	"npx tsc",
	"node index.js",
];

/** Each guarded tail and the entry that keeps its verdict. */
const GUARDED_TAILS: { command: string; kind: "deny" | "ask"; guard: string }[] = [
	{ command: "npm test > out.txt", kind: "deny", guard: "redirect deny" },
	{ command: "npm test > /tmp/x", kind: "deny", guard: "redirect deny" },
	{ command: "npm test >> out.txt", kind: "deny", guard: "redirect deny" },
	{ command: "npm test | tee x", kind: "deny", guard: "tee deny" },
	{ command: "npm test && git push", kind: "ask", guard: "push ask" },
	{ command: "npm test ; rm x", kind: "ask", guard: "named-file delete ask" },
	{ command: "npm test $(git push)", kind: "ask", guard: "push ask in a substitution" },
];

describe("pi orchestrator: the three verification scripts allow", () => {
	test("each named script allows", () => {
		for (const command of ALLOWED) assert.equal(verdict("orchestrator", command), "allow", command);
	});

	test("no other npm form, and no sibling runner, allows", () => {
		for (const command of DEFAULT) assert.notEqual(verdict("orchestrator", command), "allow", command);
	});

	test("each wrong form falls to the default verdict", () => {
		for (const command of DEFAULT) assert.equal(verdict("orchestrator", command), "default", command);
	});
});

describe("pi orchestrator: the three scripts run in the session working directory only", () => {
	// The allow rule carries no `cd` prefix. A leading `cd` would run any
	// package.json anywhere, and the gate folds `cd x ; npm test` into the same
	// `cd x && npm test` form, so both separators must miss the allow.
	test("a leading cd does not allow, with either separator", () => {
		const forms = [
			"cd x && npm test",
			"cd x ; npm test",
			"cd x && npm run lint",
			"cd x && npm run typecheck",
		];
		for (const command of forms) assert.equal(verdict("orchestrator", command), "default", command);
	});
});

describe("pi orchestrator: a redirect, separator, or substitution tail does not allow", () => {
	for (const { command, kind, guard } of GUARDED_TAILS) {
		test(`${guard} holds: ${command}`, () => {
			assert.equal(verdict("orchestrator", command), kind, command);
		});
	}

	test("the guarded tails allow alone, and only alone", () => {
		// The allow rule does not reach past the script word, so the tail is the
		// only reason each command above leaves the allow verdict.
		assert.equal(verdict("orchestrator", "npm test"), "allow");
		assert.equal(verdict("orchestrator", "npm test 2>&1"), "default");
	});
});

describe("pi: another profession keeps its verdict on npm test", () => {
	test("planner: npm test still falls to deny-by-default", () => {
		assert.equal(verdict("planner", "npm test"), "default");
	});

	test("planner: the run scripts still fall to deny-by-default", () => {
		for (const command of ["npm run typecheck", "npm run lint"]) {
			assert.equal(verdict("planner", command), "default", command);
		}
	});

	test("implementer, reviewer, and tester: npm test and the run scripts still allow", () => {
		for (const agent of ["implementer", "reviewer", "tester"]) {
			for (const command of ALLOWED) {
				assert.equal(verdict(agent, command), "allow", `${agent}: ${command}`);
			}
		}
	});

	test("reviewer: the blocked forms stay blocked", () => {
		for (const command of ["npm", "npm run *", "npm run build", "npm publish"]) {
			assert.notEqual(verdict("reviewer", command), "allow", command);
		}
	});
});
