/**
 * The gate verdict cases for the permission rule table.
 *
 * Every case here runs a probe through the compiled rows for one class or role;
 * the table shape, the compiler refusals, and the parity ledger stay in
 * permission-table.test.ts.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { GIT_DIFF_FAMILY, GIT_READ, RULE_ROWS } from "./permissions.table.ts";
import {
	CLASS_ORDER,
	LADDER,
	PATH_VALUE,
	ROLE_NOTES,
	TAIL,
	compileClass,
	compileRole,
	compileTable,
	isPathValue,
	roleZone,
	rowsForRole,
	rulesForRow,
	type Role,
	type RoleClass,
} from "./permission-table.ts";
import { FENCED, NARROWED } from "./permission-table.parity.ts";
import {
	ANCHORED_HISTORY, ASK_EXCEPTIONS, ASK_RUNNER, allowMatches, askMatches,
	BRANCH_LIST, BRANCH_WRITE, CD_FOLD_BLOCKED, CHAIN_ALLOW, COMMIT_MSG_ALLOW,
	COMMIT_WORD_ALLOW, CONFIG_KEY_ASK, COPY_SYNC, denyMatches, DIR_SLOT_ALLOW,
	DIR_SLOT_ASK, DIR_SLOT_READER_ASK, FETCH_REFSPEC, FIND_WRITE, FIXTURE_ROOT,
	FORCE_STRATEGY_ALLOW, FORCE_STRATEGY_ASK, FUNCTION_DEF, gateVerdict,
	GLOBAL_DENY_BASH, GLOBAL_OPT_ALLOW, GLOBAL_OPT_ASK, grant, LONG_OPT_ASK,
	matches, MKDIR_ALLOW, NON_PATH_PROBES, NOTES_REMOVE_FILE, ORCH_SCRIPTS, OVER_ASK, PATH_PROBES,
	PLAIN_ASK_FREE, PLAIN_HISTORY, READER_ALLOWED, READER_BLOCKED, RELEASE_ASK,
	RELEASE_VERBS, REMOVE_NAMED, REMOVE_RECURSIVE, ROLES, rowMatches, rowReason,
	sampleFor, shippedDecision, shippedVerdict, SLOT_ALLOW_ROWS, slotProbe,
	SOFT_RESET_ASK, SOFT_UNALLOWED,
	STILL_ASK, TAG_DELETE, TAG_DELETE_FLAGS, verdictOf, WORKER_ROW_TAIL,
	WORKER_VERIFY_PROBES, WRAPPED_DEFAULT, WRITE_ABS_ASK, WRITE_ABS_OUTSIDE,
	WRITE_HOME, WRITE_NOTES_ABS, WRITE_PARENT, WRITE_RELATIVE, WRITE_TMP,
	WRITE_TMP_RELATIVE, WRITE_TOOLS, WRONG_NPM,
} from "./permission-table.test-helpers.ts";

// --- zones ------------------------------------------------------------------

test("a role writes only its own notes zone, never a sibling zone", () => {
	const planner = compileRole(RULE_ROWS, "planner");
	const reviewer = compileRole(RULE_ROWS, "reviewer");
	const mascot = compileRole(RULE_ROWS, "mascot");
	assert.equal(allowMatches(planner, "write", `${FIXTURE_ROOT}/agent-notes/planner/note.md`), true);
	assert.equal(allowMatches(planner, "write", `${FIXTURE_ROOT}/agent-notes/project-notes/x/note.md`), true);
	assert.equal(allowMatches(reviewer, "write", `${FIXTURE_ROOT}/agent-notes/planner/note.md`), false);
	assert.equal(allowMatches(reviewer, "write", `${FIXTURE_ROOT}/agent-notes/reviewer/note.md`), true);
	assert.equal(allowMatches(planner, "write", `${FIXTURE_ROOT}/agent-notes/researcher/x.md`), false);
	assert.equal(allowMatches(mascot, "write", `${FIXTURE_ROOT}/agent-notes/researcher/x.md`), false);
	assert.equal(allowMatches(mascot, "edit", "note.md"), false);
});

test("a class compile binds no notes zone, so a reader cannot cross into another role's notes", () => {
	const reader = compileClass(RULE_ROWS, "reader");
	for (const target of [
		`${FIXTURE_ROOT}/agent-notes/planner/note.md`,
		`${FIXTURE_ROOT}/agent-notes/reviewer/note.md`,
		`${FIXTURE_ROOT}/agent-notes/researcher/x.md`,
	]) {
		assert.equal(allowMatches(reader, "write", target), false, `the reader class allowed ${target}`);
	}
	// Only a role compile binds a zone, and that zone is the role's own.
	assert.equal(allowMatches(compileRole(RULE_ROWS, "reviewer"), "write", `${FIXTURE_ROOT}/agent-notes/reviewer/x.md`), true);
	assert.equal(allowMatches(compileRole(RULE_ROWS, "planner"), "write", `${FIXTURE_ROOT}/agent-notes/reviewer/x.md`), false);
});

test("no compiled class pattern holds two roles' notes zones", () => {
	for (const cls of CLASS_ORDER) {
		const sets = compileClass(RULE_ROWS, cls);
		for (const rule of [...sets.agentAllow, ...sets.agentDeny]) {
			const zones = ROLES.filter((role) => (ROLE_NOTES[role] ?? []).some((zone) => rule.match.includes(zone)));
			assert.ok(zones.length <= 1, `a class rule names the zones of ${zones.join(", ")}: ${rule.match}`);
		}
	}
});

test("a parent segment, a home path, and a foreign absolute path ask", () => {
	const orchestrator = compileRole(RULE_ROWS, "orchestrator");
	const worker = compileRole(RULE_ROWS, "implementer");
	for (const sets of [orchestrator, worker]) {
		assert.equal(allowMatches(sets, "write", "agent-notes/../../.bashrc"), false);
		assert.equal(askMatches(sets, "write", "agent-notes/../../.bashrc"), true);
		assert.equal(askMatches(sets, "write", "~/notes.txt"), true);
		assert.equal(askMatches(sets, "write", "/etc/passwd"), true);
	}
	assert.equal(allowMatches(orchestrator, "write", "src/main.rs"), true);
	assert.equal(allowMatches(orchestrator, "write", "/tmp/scratch.txt"), true);
	assert.equal(askMatches(worker, "write", `${FIXTURE_ROOT}/agent-notes/planner/x.md`), true);
	assert.equal(allowMatches(worker, "write", `${FIXTURE_ROOT}/agent-notes/implementer/x.md`), true);
});

// --- the reader toolchain ---------------------------------------------------

test("a reader role with no verify row runs no test or build runner", () => {
	for (const role of ["planner", "researcher", "mascot"] as Role[]) {
		const sets = compileRole(RULE_ROWS, role);
		for (const probe of READER_BLOCKED) {
			assert.equal(allowMatches(sets, "bash", probe), false, `${role} runs ${probe}`);
		}
		for (const probe of READER_ALLOWED) {
			assert.equal(allowMatches(sets, "bash", probe), true, `${role} lost the probe ${probe}`);
		}
	}
	// The reviewer holds the three verification scripts and no other blocked probe.
	const reviewer = compileRole(RULE_ROWS, "reviewer");
	for (const probe of READER_BLOCKED) {
		assert.equal(allowMatches(reviewer, "bash", probe), ORCH_SCRIPTS.includes(probe), `reviewer: ${probe}`);
	}
	for (const probe of READER_ALLOWED) {
		assert.equal(allowMatches(reviewer, "bash", probe), true, `reviewer lost the probe ${probe}`);
	}
});

// --- the protections the table must keep ------------------------------------

test("history verbs are plain for the orchestrator and denied for the others", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	const reader = compileClass(RULE_ROWS, "reader");
	const worker = compileClass(RULE_ROWS, "worker");
	for (const verb of ["add", "commit", "pull", "merge", "rebase", "tag"]) {
		for (const probe of [`git ${verb}`, `git -C /x ${verb}`, `git --no-pager ${verb}`, `git -p ${verb}`, `cd /x && git ${verb}`]) {
			assert.equal(denyMatches(orchestrator, "bash", probe), false, probe);
			assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
			assert.equal(allowMatches(reader, "bash", probe), false, probe);
			assert.equal(allowMatches(worker, "bash", probe), false, probe);
			assert.equal(askMatches(reader, "bash", probe), false, probe);
			assert.equal(denyMatches(reader, "bash", probe), true, probe);
			assert.equal(denyMatches(worker, "bash", probe), true, probe);
		}
	}
});

test("the five plain history forms never ask", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const verb of ["add", "commit", "pull", "merge", "rebase", "tag"]) {
		for (const probe of [`git ${verb}`, `git -C /x ${verb}`, `git --no-pager ${verb}`, `git -p ${verb}`, `cd /x && git ${verb}`]) {
			assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
			assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
		}
	}
	// The config-value form is the one `-c` shape that asks.
	assert.equal(askMatches(orchestrator, "bash", "git -c core.hooksPath=/x commit"), true);
	assert.equal(askMatches(orchestrator, "bash", "git -C /x commit -m done"), false);
});

test("the full force and strategy ladders are bound to their own verbs", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of FORCE_STRATEGY_ALLOW) {
		assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
	// A gated form still matches the plain history allow row; the ask wins by
	// precedence, so only the ask is asserted here.
	for (const probe of FORCE_STRATEGY_ASK) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("a quoted commit message never reaches the exception scan", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of COMMIT_MSG_ALLOW) {
		assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("an unlisted global option with a separate value word asks", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of GLOBAL_OPT_ASK) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
	}
	for (const probe of GLOBAL_OPT_ALLOW) {
		assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("a -C value shaped like a config key asks instead of riding the path slot", () => {
	// Before the fix the plain history row took any `-C` value, so it allowed
	// every form below. A config key in the value runs code on the next command.
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of CONFIG_KEY_ASK) {
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
	}
	// A worker and a reader keep their own verdict: the history deny row.
	for (const [name, sets] of [
		["worker", compileClass(RULE_ROWS, "worker")],
		["reader", compileClass(RULE_ROWS, "reader")],
	] as const) {
		for (const probe of CONFIG_KEY_ASK) {
			assert.equal(allowMatches(sets, "bash", probe), false, `${name}: ${probe}`);
			assert.equal(denyMatches(sets, "bash", probe), true, `${name}: ${probe}`);
		}
	}
});

test("the branch listing forms allow and a branch write form never allows", () => {
	for (const cls of CLASS_ORDER) {
		const sets = compileClass(RULE_ROWS, cls);
		for (const probe of BRANCH_LIST) {
			assert.equal(allowMatches(sets, "bash", probe), true, `${cls}: ${probe}`);
		}
		for (const probe of BRANCH_WRITE) {
			assert.equal(allowMatches(sets, "bash", probe), false, `${cls}: ${probe}`);
			assert.equal(askMatches(sets, "bash", probe), false, `${cls}: ${probe}`);
		}
	}
});

test("every read verb that accepts a write flag is also fenced", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const verb of GIT_DIFF_FAMILY) {
		for (const cls of CLASS_ORDER) {
			assert.equal(denyMatches(classes[cls], "bash", `git ${verb} --textconv f`), true, `${cls}: git ${verb} --textconv`);
			assert.equal(denyMatches(classes[cls], "bash", `git ${verb} --textc f`), true, `${cls}: git ${verb} --textc`);
		}
	}
	// Every verb the read row allows from the family is in the fence list.
	const fence = new Set(GIT_DIFF_FAMILY);
	for (const verb of GIT_READ) {
		if (GIT_DIFF_FAMILY.includes(verb)) assert.ok(fence.has(verb), verb);
	}
	assert.ok(GIT_READ.includes("annotate") && fence.has("annotate"));
	const row = RULE_ROWS.find((item) => item.id === "git.read.write-flag");
	assert.deepEqual([...(row?.sub ?? [])].sort(), [...GIT_DIFF_FAMILY].sort());
	// A read verb without the flag still runs.
	assert.equal(denyMatches(classes.reader, "bash", "git annotate f"), false);
});

test("each option ladder has one home and the tails compose it", () => {
	const tailFor: Record<string, string | null | undefined> = {
		amend: TAIL.amend,
		force: TAIL.force,
		strategy: TAIL.strategy,
		delete: TAIL.delete,
		"upload-pack": TAIL["upload-pack"],
		inplace: TAIL.inplace,
		"rg-pre": TAIL["rg-exec"],
		"rg-zip": TAIL["rg-exec"],
		clock: TAIL.clock,
		"diff-output": TAIL["diff-write"],
		"diff-ext": TAIL["diff-write"],
		"diff-textconv": TAIL["diff-write"],
		"diff-filters": TAIL["diff-write"],
	};
	for (const [name, ladder] of Object.entries(LADDER)) {
		if (name === "branch-list") {
			const branch = compileClass(RULE_ROWS, "reader").agentAllow.find((rule) => rule.match.includes("branch"));
			assert.ok(branch !== undefined && branch.match.includes(ladder), "branch-list is not composed");
			continue;
		}
		const tail = tailFor[name];
		assert.ok(tail !== null && tail !== undefined && tail.includes(ladder), `${name} is not composed from its ladder`);
	}
	// No row spells a ladder: the shipped data file holds no ladder text.
	const table = readFileSync(new URL("../permissions.table.json", import.meta.url), "utf8");
	const rows = (JSON.parse(table) as { rows?: unknown[] }).rows;
	assert.ok(table.length > 0, "the guard must read the shipped data file, not an empty file");
	assert.ok(Array.isArray(rows) && rows.length > 0, "the shipped data file must hold rows");
	for (const [name, ladder] of Object.entries(LADDER)) {
		assert.equal(table.includes(ladder), false, `the table spells the ${name} ladder`);
	}
});

test("the verification row ends at the script word", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of ORCH_SCRIPTS) {
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
	for (const probe of ["npm test --watch", "npm test extra", "npm run lint --fix"]) {
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
	}
	// The cargo verification rows keep a trailing argument.
	assert.equal(allowMatches(orchestrator, "bash", "cargo nextest --all"), true);
});

test("the tester allows npm test, npm run typecheck, and tsc --noEmit", () => {
	const tester = compileRole(RULE_ROWS, "tester");
	for (const probe of WORKER_VERIFY_PROBES) {
		assert.equal(allowMatches(tester, "bash", probe), true, `the tester cannot run ${probe}`);
	}
});

test("the implementer allows npm test, npm run typecheck, and tsc --noEmit", () => {
	const implementer = compileRole(RULE_ROWS, "implementer");
	for (const probe of WORKER_VERIFY_PROBES) {
		assert.equal(allowMatches(implementer, "bash", probe), true, `the implementer cannot run ${probe}`);
	}
});

test("a verification or build command does not carry the cd fold", () => {
	for (const probe of CD_FOLD_BLOCKED) {
		for (const role of ["orchestrator", "implementer", "tester", "reviewer"] as Role[]) {
			assert.equal(allowMatches(compileRole(RULE_ROWS, role), "bash", probe), false, `${role}: ${probe}`);
		}
	}
	// The git fold stays: doctrine allows a leading `cd x &&` for the six verbs.
	assert.equal(allowMatches(compileClass(RULE_ROWS, "orchestrator"), "bash", "cd /fixture && git status"), true);
});

test("a reader role with no verify row still denies npm test", () => {
	for (const role of ["planner", "researcher", "mascot"] as Role[]) {
		for (const probe of ["npm test", "npm run typecheck", "npm run build", "tsc", "tsc --noEmit", "pytest"]) {
			assert.equal(allowMatches(compileRole(RULE_ROWS, role), "bash", probe), false, `${role} runs ${probe}`);
		}
	}
	// The reviewer holds the three scripts and still denies the other forms.
	const reviewer = compileRole(RULE_ROWS, "reviewer");
	for (const probe of ["npm run build", "tsc", "tsc --noEmit", "pytest"]) {
		assert.equal(allowMatches(reviewer, "bash", probe), false, `reviewer runs ${probe}`);
	}
});

test("a trailing flag on npm test is judged by the orchestrator row rule, not the worker row", () => {
	// Both rows carry the bare flag class, so both end at the script word.
	assert.equal(rowMatches("shell.verify", "npm test"), true, "the orchestrator row lost npm test");
	assert.equal(rowMatches("shell.verify.worker", "npm test"), true, "the worker row lost npm test");
	assert.equal(rowMatches("shell.verify.reader", "npm test"), true, "the reviewer row lost npm test");
	for (const probe of ["npm test --watch", "npm test extra"]) {
		assert.equal(rowMatches("shell.verify", probe), false, `the orchestrator row covers ${probe}`);
		assert.equal(rowMatches("shell.verify.worker", probe), false, `the worker row covers ${probe}`);
		assert.equal(rowMatches("shell.verify.reader", probe), false, `the reviewer row covers ${probe}`);
	}
	// The worker row keeps the bare forms the retired lists carried.
	for (const probe of WORKER_ROW_TAIL) {
		assert.equal(rowMatches("shell.verify.worker", probe), true, probe);
	}
	// A package script name is free text, so the script row takes any word.
	for (const probe of ["npm run typecheck", "npm run build"]) {
		assert.equal(rowMatches("shell.verify.script", probe), true, probe);
	}
});

test("a soft reset, a prefix option, and a wrapper prefix on a history verb ask", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of SOFT_RESET_ASK) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
	}
});

test("the plain history forms never ask and always allow", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of PLAIN_ASK_FREE) {
		assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("the git directory option takes a path, never a config key", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const path of DIR_SLOT_ALLOW) {
		for (const probe of [`git -C ${path} status`, `git -C ${path} commit`]) {
			assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
			assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
			assert.equal(verdictOf(orchestrator, "bash", probe), "allow", probe);
		}
	}
	// A value that fails the path grammar asks for the orchestrator.
	for (const probe of DIR_SLOT_ASK) {
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
		assert.equal(verdictOf(orchestrator, "bash", probe), "ask", probe);
	}
	// A reader holds no ask row for the form, so the deny-by-default default
	// blocks it, including the quoted spelling.
	for (const probe of DIR_SLOT_READER_ASK) {
		for (const role of ["planner", "reviewer", "researcher", "mascot"] as Role[]) {
			assert.equal(allowMatches(compileRole(RULE_ROWS, role), "bash", probe), false, `${role}: ${probe}`);
			assert.equal(gateVerdict(role, "bash", probe), "deny", `${role}: ${probe}`);
		}
	}
});

test("the path grammar accepts a path and rejects every other value", () => {
	for (const value of PATH_PROBES) assert.equal(isPathValue(value), true, value);
	for (const value of NON_PATH_PROBES) assert.equal(isPathValue(value), false, value);
	// One piece of text serves the slot and the test, so the two cannot drift.
	assert.ok(PATH_VALUE.length > 0);
});

test("no allow row that takes the git directory-option slot accepts a non-path value", () => {
	assert.ok(SLOT_ALLOW_ROWS.length > 0, "no allow row takes the slot");
	for (const row of SLOT_ALLOW_ROWS) {
		const rules = rulesForRow(row);
		assert.equal(matches(rules, "bash", slotProbe(row, "/x")), true, `${row.id} lost the path form`);
		for (const value of PATH_PROBES) {
			assert.equal(matches(rules, "bash", slotProbe(row, value)), true, `${row.id} lost the path ${value}`);
		}
		for (const value of NON_PATH_PROBES) {
			assert.equal(matches(rules, "bash", slotProbe(row, value)), false, `${row.id} accepted the non-path value ${value}`);
		}
	}
});

test("a commit message word never asks", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of COMMIT_WORD_ALLOW) {
		assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
	}
	// The release ask still reaches the verb itself.
	for (const probe of RELEASE_ASK) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("a soft reset, a prefix option, and a wrapper stay unallowed for the others", () => {
	const reader = compileClass(RULE_ROWS, "reader");
	const worker = compileClass(RULE_ROWS, "worker");
	for (const probe of SOFT_UNALLOWED) {
		assert.equal(allowMatches(reader, "bash", probe), false, `${probe} is allowed for the reader`);
		assert.equal(allowMatches(worker, "bash", probe), false, `${probe} is allowed for the worker`);
	}
});

test("a plain fetch asks for a worker and denies for a reader, and a refspec denies for both", () => {
	assert.equal(gateVerdict("implementer", "bash", "git fetch"), "ask");
	assert.equal(gateVerdict("tester", "bash", "git fetch"), "ask");
	for (const role of ["planner", "reviewer", "researcher"] as Role[]) {
		assert.equal(gateVerdict(role, "bash", "git fetch"), "deny", role);
	}
	for (const role of ["implementer", "planner", "reviewer", "researcher"] as Role[]) {
		for (const probe of FETCH_REFSPEC) {
			// The deny row wins over a fetch ask row, so the verdict is a deny.
			assert.equal(gateVerdict(role, "bash", probe), "deny", `${role}: ${probe}`);
		}
	}
});

test("the orchestrator keeps mkdir, sort, and uniq, and no other class gains them", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of MKDIR_ALLOW) {
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
	for (const cls of ["reader", "worker"] as RoleClass[]) {
		for (const probe of MKDIR_ALLOW.filter((item) => !item.startsWith("cd "))) {
			assert.equal(allowMatches(compileClass(RULE_ROWS, cls), "bash", probe), false, `${cls}: ${probe}`);
		}
	}
});

test("a long-option abbreviation on a history verb asks", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of LONG_OPT_ASK) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("a tag delete denies at every abbreviation", () => {
	for (const flag of TAG_DELETE_FLAGS) {
		for (const probe of [`git tag ${flag} v1`, `git -C /x tag ${flag} v1`]) {
			for (const cls of CLASS_ORDER) {
				const sets = compileClass(RULE_ROWS, cls);
				assert.equal(denyMatches(sets, "bash", probe), true, `${cls}: ${probe}`);
				// The plain history allow row also matches the form, and the deny wins by
				// precedence, so the engine verdict is the assertion that counts.
				assert.equal(verdictOf(sets, "bash", probe), "deny", `${cls}: ${probe}`);
			}
		}
	}
});

test("release verbs ask for the orchestrator and deny for the others", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	const reader = compileClass(RULE_ROWS, "reader");
	const worker = compileClass(RULE_ROWS, "worker");
	for (const probe of RELEASE_VERBS) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(denyMatches(reader, "bash", probe), true, probe);
		assert.equal(denyMatches(worker, "bash", probe), true, probe);
	}
});

test("copy, move, and sync ask for the orchestrator and the implementer, and deny for the rest", () => {
	for (const probe of COPY_SYNC) {
		assert.equal(gateVerdict("orchestrator", "bash", probe), "ask", probe);
		assert.equal(gateVerdict("implementer", "bash", probe), "ask", probe);
		for (const role of ["tester", "planner", "reviewer", "researcher", "mascot"] as Role[]) {
			assert.equal(gateVerdict(role, "bash", probe), "deny", `${role}: ${probe}`);
		}
	}
});

test("a named file removal asks for the orchestrator and the implementer, and denies for the rest", () => {
	for (const probe of REMOVE_NAMED) {
		assert.equal(gateVerdict("orchestrator", "bash", probe), "ask", probe);
		assert.equal(gateVerdict("implementer", "bash", probe), "ask", probe);
		// The engine path reaches the same ask verdict.
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
		assert.equal(shippedVerdict("implementer", "bash", probe), "ask", probe);
		for (const role of ["tester", "planner", "reviewer", "researcher", "mascot"] as Role[]) {
			assert.equal(gateVerdict(role, "bash", probe), "deny", `${role}: ${probe}`);
		}
	}
});

test("a recursive removal denies for every class and never asks", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const cls of CLASS_ORDER) {
		for (const probe of REMOVE_RECURSIVE) {
			assert.equal(denyMatches(classes[cls], "bash", probe), true, `${cls}: ${probe}`);
			assert.equal(verdictOf(classes[cls], "bash", probe), "deny", `${cls}: ${probe}`);
			assert.equal(askMatches(classes[cls], "bash", probe), false, `${cls} asks for ${probe}`);
			assert.equal(shippedVerdict("orchestrator", "bash", probe), "deny", probe);
		}
	}
});

test("a flagless removal on a notes path asks for the orchestrator and the implementer", () => {
	// The `named` flag class guards against a recursive option, so the removal
	// ask row owns the plain and the named forms on any path.
	for (const probe of [`rm ${NOTES_REMOVE_FILE}`, `rm -f ${NOTES_REMOVE_FILE}`]) {
		assert.equal(rowMatches("file.remove.ask", probe), true, probe);
		for (const role of ["orchestrator", "implementer"] as Role[]) {
			assert.equal(gateVerdict(role, "bash", probe), "ask", `${role}: ${probe}`);
			assert.equal(shippedVerdict(role, "bash", probe), "ask", `${role}: ${probe}`);
		}
	}
});

test("a removal ask names a plain reason and never a pattern", () => {
	const patternChars = ["\\", "(", ")", "[", "]", "{", "}", "|", "*", "+", "?", "^", "$"];
	for (const id of ["file.remove.ask", "git.remove.ask"]) {
		const reason = rowReason(id);
		assert.ok(reason.length > 0 && !reason.includes("\n"), id);
		assert.equal(patternChars.some((char) => reason.includes(char)), false, `${id}: ${reason}`);
	}
});

test("a row with roles applies only to the professions it names", () => {
	const scoped = RULE_ROWS.filter((row) => row.roles !== undefined);
	assert.ok(scoped.length > 0, "no row carries roles");
	for (const row of scoped) {
		const named = row.roles ?? [];
		const tool = row.tool.trim().split(/\s+/)[0];
		const sample = sampleFor(row);
		const selected = ROLES.filter((role) => rowsForRole(RULE_ROWS, role).includes(row));
		// The named professions are exactly the ones that select the row.
		assert.deepEqual([...selected].sort(), [...named].sort(), `${row.id} scope`);
		for (const role of ROLES) {
			const verdict = gateVerdict(role, tool, sample);
			if (named.includes(role)) {
				assert.equal(verdict, row.verdict, `${row.id} names ${role}`);
				continue;
			}
			// An unnamed profession never reaches this row: it denies, or another
			// row that the profession does select produces the verdict.
			if (verdict === "deny") continue;
			const other = rowsForRole(RULE_ROWS, role).some(
				(candidate) =>
					candidate !== row &&
					candidate.verdict === verdict &&
					rulesForRow(candidate, roleZone(role)).some((rule) => new RegExp(rule.match, "i").test(sample)),
			);
			assert.ok(other, `${row.id} reaches ${role} through its roles scope`);
		}
	}
});

test("the mandatory global protections hold for every class", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const cls of CLASS_ORDER) {
		const sets = classes[cls];
		for (const probe of GLOBAL_DENY_BASH) {
			assert.equal(denyMatches(sets, "bash", probe), true, `${cls}: ${probe}`);
		}
		assert.equal(denyMatches(sets, "read", `${FIXTURE_ROOT}/.env`), true);
		assert.equal(denyMatches(sets, "read", `${FIXTURE_ROOT}/.ssh/id_rsa`), true);
		assert.equal(askMatches(sets, "bash", "rm -rf build"), false, `${cls} asks for rm -rf`);
		assert.equal(askMatches(sets, "bash", "npx create-app"), true);
		assert.equal(askMatches(sets, "bash", "pip install x"), true);
	}
	// sudo stays an ask for the orchestrator and becomes a deny elsewhere.
	assert.equal(askMatches(classes.orchestrator, "bash", "sudo id"), true);
	assert.equal(denyMatches(classes.orchestrator, "bash", "sudo id"), false);
	assert.equal(denyMatches(classes.reader, "bash", "sudo id"), true);
	assert.equal(denyMatches(classes.worker, "bash", "sudo id"), true);
});

test("find write options deny for every class", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const cls of CLASS_ORDER) {
		for (const probe of FIND_WRITE) {
			assert.equal(denyMatches(classes[cls], "bash", probe), true, `${cls}: ${probe}`);
		}
		assert.equal(denyMatches(classes[cls], "bash", "find . -name x -type f"), false);
	}
});

test("a plain dd copy runs and a device write denies", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const cls of CLASS_ORDER) {
		assert.equal(denyMatches(classes[cls], "bash", "dd if=a of=/tmp/b"), false, `${cls} denied a plain copy`);
		assert.equal(denyMatches(classes[cls], "bash", "dd if=/dev/sda of=/dev/sdb"), true);
		assert.equal(denyMatches(classes[cls], "bash", "dd if=x of=/dev/sda"), true);
		assert.equal(denyMatches(classes[cls], "bash", "mkfs /dev/sda"), true);
	}
});

test("a shell function definition denies for every class", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const cls of CLASS_ORDER) {
		for (const probe of FUNCTION_DEF) {
			assert.equal(denyMatches(classes[cls], "bash", probe), true, `${cls}: ${probe}`);
		}
	}
});

// --- the fence rows ---------------------------------------------------------

test("a fenced form never rides an allow", () => {
	for (const gap of FENCED) {
		assert.ok(gap.reason.length > 0 && !gap.reason.includes("\n"), `${gap.form} needs a one-line reason`);
		for (const cls of CLASS_ORDER) {
			const decision = verdictOf(compileClass(RULE_ROWS, cls), "bash", gap.sample);
			assert.ok(decision !== "allow" && decision !== "none", `${gap.form} rides an allow in ${cls}: ${gap.sample}`);
		}
	}
});

test("a redirect to a file denies for every class", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const cls of CLASS_ORDER) {
		assert.equal(verdictOf(classes[cls], "bash", `cat notes.txt > ${FIXTURE_ROOT}/escape.txt`), "deny");
		assert.equal(verdictOf(classes[cls], "bash", "echo x >> src/main.ts"), "deny");
		assert.equal(verdictOf(classes[cls], "bash", "cat x | tee out.txt"), "deny");
		// An fd duplicate is not a write.
		assert.equal(denyMatches(classes[cls], "bash", "cat x 2>&1"), false);
	}
});

test("a narrowed form stays blocked until a fence row lands", () => {
	for (const gap of NARROWED) {
		assert.ok(gap.reason.length > 0 && !gap.reason.includes("\n"), `${gap.form} needs a one-line reason`);
		for (const cls of gap.classes ?? CLASS_ORDER) {
			const sets = compileClass(RULE_ROWS, cls);
			assert.equal(allowMatches(sets, "bash", gap.sample), false, `${gap.form} is allowed in ${cls}`);
		}
	}
});

// --- history verdicts -------------------------------------------------------

test("a plain history form allows for the orchestrator", () => {
	for (const probe of PLAIN_HISTORY) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "allow", probe);
	}
});

test("the git -C, pager-flag, and cd-fold forms of a plain history command allow", () => {
	for (const probe of ANCHORED_HISTORY) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "allow", probe);
	}
});

test("a chain of plain history commands allows", () => {
	for (const probe of CHAIN_ALLOW) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "allow", probe);
	}
});

test("a chain with a blocked npm form does not allow", () => {
	assert.equal(shippedVerdict("orchestrator", "bash", "git add . && npm test"), "allow");
	assert.equal(shippedVerdict("orchestrator", "bash", "git add . && npm test -- --watch"), "default");
});

test("a tag force-move asks", () => {
	for (const probe of ASK_EXCEPTIONS["tag force-move"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a commit --amend form asks", () => {
	for (const probe of ASK_EXCEPTIONS["commit --amend"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a quoted separator before an exception asks", () => {
	for (const probe of ASK_EXCEPTIONS["quoted separator before an exception"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a git -c override asks", () => {
	for (const probe of ASK_EXCEPTIONS["git -c override"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a brace expansion in a history command asks", () => {
	for (const probe of ASK_EXCEPTIONS["brace expansion"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a glob word in a history command asks", () => {
	for (const probe of ASK_EXCEPTIONS.glob) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a transport helper URL asks", () => {
	for (const probe of ASK_EXCEPTIONS["transport helper URL"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("an upload-pack option asks", () => {
	for (const probe of ASK_EXCEPTIONS["upload-pack"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a merge strategy asks", () => {
	for (const probe of ASK_EXCEPTIONS["merge strategy"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("an unknown git global option asks", () => {
	for (const probe of ASK_EXCEPTIONS["unknown global option"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a runtime-shaped history word asks", () => {
	for (const probe of ASK_EXCEPTIONS["runtime-shaped"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a wrapped history command asks", () => {
	for (const probe of ASK_EXCEPTIONS.wrapped) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("push, gh pr, gh run, gh release, and reset --soft ask", () => {
	for (const probe of STILL_ASK) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
	for (const probe of ["gh issue list", "gh runner list", "gh -R owner/repo run list"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "default", probe);
	}
});

test("a quoted glob, brace, or option word over-asks", () => {
	for (const probe of OVER_ASK) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	}
});

test("a tag delete denies", () => {
	for (const probe of TAG_DELETE) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "deny", probe);
	}
});

test("the bash -c and sh -c payloads fall to the mode default", () => {
	// The table holds no `bash -c` deny row, so the mode default blocks both forms.
	for (const probe of ["bash -c 'git commit -m x'", "sh -c 'git add .'"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "default", probe);
	}
	for (const probe of WRAPPED_DEFAULT) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "default", probe);
	}
});

// --- session grants ---------------------------------------------------------

const EXCEPTION_REASON = rowReason("git.history.exception");
const DIR_ASK_REASON = rowReason("git.dir-option.ask");

test("one exception row covers a pull strategy and an upload-pack, so one grant allows", () => {
	const probe = "git pull -s ours --upload-pack=evil /r";
	assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	// Shipped difference: one exception row covers both forms, so one grant clears both.
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(EXCEPTION_REASON)), "allow", probe);
});

test("one exception row covers a brace and an upload-pack, so one grant allows", () => {
	const probe = "git pull {x,} --upload-pack=evil /r";
	assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	// Shipped difference: the brace and the upload-pack sit in the same ask row.
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(EXCEPTION_REASON)), "allow", probe);
});

test("one exception row covers an amend and a glob, so one grant allows", () => {
	const probe = "git commit --amend *";
	assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	// Shipped difference: the amend and the glob sit in the same ask row.
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(EXCEPTION_REASON)), "allow", probe);
});

test("a session grant on one of two matching asks still asks", () => {
	const probe = "git -C core.hooksPath commit --amend";
	assert.equal(shippedVerdict("orchestrator", "bash", probe), "ask", probe);
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(DIR_ASK_REASON)), "ask", probe);
});

test("a session grant on every matching ask allows", () => {
	const probe = "git -C core.hooksPath commit --amend";
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(DIR_ASK_REASON, EXCEPTION_REASON)), "allow", probe);
});

test("the first ask that still blocks names its reason, and the next grant allows", () => {
	// Two orchestrator ask rows meet here: the dir-option ask and the exception ask.
	const probe = "git -C core.hooksPath commit --amend";
	const first = shippedDecision("orchestrator", "bash", probe, grant(DIR_ASK_REASON));
	assert.equal(first.kind, "ask", probe);
	if (first.kind !== "ask") return;
	assert.equal(first.rule.reason, EXCEPTION_REASON);
	assert.equal(shippedVerdict("orchestrator", "bash", probe, grant(DIR_ASK_REASON, first.rule.reason ?? "")), "allow", probe);
});

// --- non-orchestrator history -----------------------------------------------

test("a non-orchestrator never allows a plain history form", () => {
	for (const role of ["implementer", "tester", "planner", "reviewer", "researcher"] as Role[]) {
		for (const probe of [...PLAIN_HISTORY, ...ANCHORED_HISTORY]) {
			assert.equal(shippedVerdict(role, "bash", probe), "deny", `${role}: ${probe}`);
		}
	}
});

test("the implementer denies gh run through a named row", () => {
	assert.equal(shippedVerdict("implementer", "bash", "gh run list"), "deny");
});

test("every non-orchestrator class denies gh run", () => {
	for (const role of ["planner", "reviewer", "researcher", "mascot", "implementer", "tester"] as Role[]) {
		assert.equal(shippedVerdict(role, "bash", "gh run list"), "deny", role);
	}
});

// --- verification verdicts --------------------------------------------------

test("each named verification script allows for the orchestrator", () => {
	for (const probe of ORCH_SCRIPTS) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "allow", probe);
	}
});

test("no other npm form and no sibling runner allows for the orchestrator", () => {
	for (const probe of WRONG_NPM) {
		assert.notEqual(shippedVerdict("orchestrator", "bash", probe), "allow", probe);
	}
});

test("an ask row names npm publish and npx, and every other wrong npm form falls to the mode default", () => {
	// Shipped difference: the global ask rows name npm publish and npx, so those ask.
	for (const probe of WRONG_NPM) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), ASK_RUNNER.has(probe) ? "ask" : "default", probe);
	}
});

test("a leading cd does not allow a verification script, with either separator", () => {
	for (const probe of ["cd x && npm test", "cd x ; npm test", "cd x && npm run lint", "cd x && npm run typecheck"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "default", probe);
		assert.equal(shippedVerdict("reviewer", "bash", probe), "default", probe);
	}
});

test("a redirect or append tail on a verification script denies", () => {
	for (const probe of ["npm test > out.txt", "npm test > /tmp/x", "npm test >> out.txt"]) {
		assert.equal(shippedVerdict("orchestrator", "bash", probe), "deny", probe);
	}
});

test("a tee tail on a verification script denies", () => {
	assert.equal(shippedVerdict("orchestrator", "bash", "npm test | tee x"), "deny");
});

test("a push separator tail on a verification script asks", () => {
	assert.equal(shippedVerdict("orchestrator", "bash", "npm test && git push"), "ask");
});

test("a named-file delete tail on a verification script asks", () => {
	// The removal ask row owns a plain `rm`, so the tail asks instead of falling
	// to the mode default.
	assert.equal(shippedVerdict("orchestrator", "bash", "npm test ; rm x"), "ask");
});

test("a push substitution tail on a verification script asks", () => {
	assert.equal(shippedVerdict("orchestrator", "bash", "npm test $(git push)"), "ask");
});

test("a verification script allows alone and not with an fd duplicate", () => {
	assert.equal(shippedVerdict("orchestrator", "bash", "npm test"), "allow");
	assert.equal(shippedVerdict("orchestrator", "bash", "npm test 2>&1"), "default");
});

test("the planner falls to the mode default on npm test and the run scripts", () => {
	for (const probe of ORCH_SCRIPTS) {
		assert.equal(shippedVerdict("planner", "bash", probe), "default", probe);
	}
});

test("the implementer, the tester, and the reviewer allow the verification scripts and the other reader roles do not", () => {
	for (const role of ["implementer", "tester", "reviewer"] as Role[]) {
		for (const probe of ORCH_SCRIPTS) {
			assert.equal(shippedVerdict(role, "bash", probe), "allow", `${role}: ${probe}`);
		}
	}
	// Shipped difference: the reviewer row narrows to that profession, so a
	// sibling reader role with no row falls to the mode default.
	for (const role of ["planner", "researcher", "mascot"] as Role[]) {
		for (const probe of ORCH_SCRIPTS) {
			assert.equal(shippedVerdict(role, "bash", probe), "default", `${role}: ${probe}`);
		}
	}
});

test("the reviewer never allows a wrong npm form", () => {
	for (const probe of WRONG_NPM) {
		if (ORCH_SCRIPTS.includes(probe)) continue;
		const verdict = shippedVerdict("reviewer", "bash", probe);
		if (ASK_RUNNER.has(probe)) {
			assert.equal(verdict, "ask", probe);
			continue;
		}
		assert.ok(verdict === "deny" || verdict === "default", `${probe} returned ${verdict}`);
	}
	// The reviewer keeps the three verification scripts.
	for (const probe of ORCH_SCRIPTS) {
		assert.equal(shippedVerdict("reviewer", "bash", probe), "allow", probe);
	}
});

// --- write-zone verdicts ----------------------------------------------------

test("a relative repository path allows a write", () => {
	for (const tool of WRITE_TOOLS) {
		for (const target of WRITE_RELATIVE) {
			assert.equal(shippedVerdict("orchestrator", tool, target), "allow", `${tool} ${target}`);
		}
	}
});

test("an absolute repository path asks, and a path-ask exclusion falls to the mode default", () => {
	for (const tool of WRITE_TOOLS) {
		for (const [target, expected] of WRITE_ABS_ASK) {
			assert.equal(shippedVerdict("orchestrator", tool, target), expected, `${tool} ${target}`);
		}
	}
	// Shipped difference: the path-ask exclusion is a substring test, so the last path reaches no row.
});

test("an absolute agent-notes path allows a write", () => {
	for (const tool of WRITE_TOOLS) {
		for (const target of WRITE_NOTES_ABS) {
			assert.equal(shippedVerdict("orchestrator", tool, target), "allow", `${tool} ${target}`);
		}
	}
});

test("the /tmp zone allows a write", () => {
	for (const tool of WRITE_TOOLS) {
		for (const target of WRITE_TMP) {
			assert.equal(shippedVerdict("orchestrator", tool, target), "allow", `${tool} ${target}`);
		}
	}
});

test("a relative tmp path allows through the relative-path row", () => {
	for (const tool of WRITE_TOOLS) {
		for (const target of WRITE_TMP_RELATIVE) {
			assert.equal(shippedVerdict("orchestrator", tool, target), "allow", `${tool} ${target}`);
		}
	}
});

test("a parent segment asks for a write", () => {
	for (const tool of WRITE_TOOLS) {
		for (const target of WRITE_PARENT) {
			assert.equal(shippedVerdict("orchestrator", tool, target), "ask", `${tool} ${target}`);
		}
	}
});

test("a home-relative path asks for a write", () => {
	for (const tool of WRITE_TOOLS) {
		for (const target of WRITE_HOME) {
			assert.equal(shippedVerdict("orchestrator", tool, target), "ask", `${tool} ${target}`);
		}
	}
});

test("an absolute path outside every zone asks, and a trailing tmp word falls to the mode default", () => {
	for (const tool of WRITE_TOOLS) {
		for (const [target, expected] of WRITE_ABS_OUTSIDE) {
			assert.equal(shippedVerdict("orchestrator", tool, target), expected, `${tool} ${target}`);
		}
	}
	// Shipped difference: the tmp exclusion is a substring test, so the last two paths reach no row.
});

test("a non-orchestrator write zone stays narrow", () => {
	assert.equal(shippedVerdict("planner", "edit", "agent-notes/project-notes/repo/study.md"), "allow");
	assert.equal(shippedVerdict("planner", "write", "agent-notes/project-notes/repo/study.md"), "allow");
	assert.equal(shippedVerdict("planner", "edit", "/home/dev/agent-notes/project-notes/repo/study.md"), "allow");
	assert.equal(shippedVerdict("planner", "edit", "agent-notes/orchestrator/j.md"), "default");
	assert.equal(shippedVerdict("planner", "write", "agent-notes/researcher/x.md"), "default");
	assert.equal(shippedVerdict("researcher", "edit", "agent-notes/researcher/a.md"), "allow");
	assert.equal(shippedVerdict("researcher", "write", "/home/dev/agent-notes/researcher/a.md"), "allow");
	assert.equal(shippedVerdict("researcher", "edit", "agent-notes/project-notes/a.md"), "default");
	assert.equal(shippedVerdict("researcher", "write", "agent-notes/orchestrator/a.md"), "default");
	assert.equal(shippedVerdict("planner", "edit", "src/a.ts"), "default");
	assert.equal(shippedVerdict("researcher", "write", "content/professions/orchestrator.md"), "default");
});
