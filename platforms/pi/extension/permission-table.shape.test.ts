/**
 * The compiled shape of the permission rule table.
 *
 * The file holds the row counts, the compiler shape, the class vocabulary home,
 * and the engine import.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { FLAG_CLASSES, TAIL_ONLY_CLASSES } from "./permission-table.ts";
import {
	compileClass,
	compileTable,
	countTable,
	rowsForClass,
	rowsForGroup,
} from "./permission-table-groups.ts";
import { PERMISSION_CLASSES, type PermissionClass } from "./permission-class.ts";
import { RULE_ROWS } from "./permissions.table.ts";
import {
	ANALYSIS_WRITE_TOOLS,
	ROLES,
	RULE_SET_KEYS,
	allowMatches,
	gateVerdict,
	rowMatches,
	ruleCount,
	verdictOf,
} from "./permission-table.test-helpers.ts";

/** The ten read-only analysis tools the table allows by name, for every class. */
const ANALYSIS_TOOLS = [
	"lens_diagnostics",
	"module_report",
	"project_report",
	"read_symbol",
	"read_enclosing",
	"symbol_search",
	"effective_config",
	"ast_grep_search",
	"ast_grep_outline",
	"pi_lens_activate_tools",
];

// --- row counts -------------------------------------------------------------

test("the table holds 88 rows: 22 global, 15 reader, 22 worker, 29 orchestrator", () => {
	const counts = countTable(RULE_ROWS);
	assert.equal(counts.total, 88);
	assert.equal(counts.byGroup.global, 22);
	assert.equal(counts.byGroup.reader, 15);
	assert.equal(counts.byGroup.worker, 22);
	assert.equal(counts.byGroup.orchestrator, 29);
});

test("every class resolves to 36, 44, and 51 rows", () => {
	const counts = countTable(RULE_ROWS);
	assert.equal(counts.byClass.reader, 36);
	assert.equal(counts.byClass.worker, 44);
	assert.equal(counts.byClass.orchestrator, 51);
	// One filter decides a class row set: the three ask rows widen to an unnamed
	// worker, so the worker class holds every worker-group row.
	assert.deepEqual(
		rowsForClass(RULE_ROWS, "worker"),
		[...rowsForGroup(RULE_ROWS, "global"), ...rowsForGroup(RULE_ROWS, "worker")],
	);
	// The reader class still drops its one `roles` row, the reviewer allow.
	const dropped = [...rowsForGroup(RULE_ROWS, "global"), ...rowsForGroup(RULE_ROWS, "reader")].filter(
		(row) => !rowsForClass(RULE_ROWS, "reader").includes(row),
	);
	assert.deepEqual(dropped.map((row) => row.id), ["shell.verify.reader"]);
});

test("only the three ask rows widen to an unnamed agent", () => {
	const widened = RULE_ROWS.filter((row) => row.unnamed === true).map((row) => row.id);
	assert.deepEqual(widened, ["file.move.ask", "file.remove.ask", "git.remove.ask"]);
});

test("the 88 rows carry 63 ids: a shared rule is one row per class", () => {
	// One id is one rule. A rule that three classes share is three rows with one
	// id, so the id count is the number of distinct rules, not of rows.
	assert.equal(countTable(RULE_ROWS).uniqueIds, 63);
	const shared = new Map<string, number>();
	for (const row of RULE_ROWS) shared.set(row.id, (shared.get(row.id) ?? 0) + 1);
	assert.equal(shared.get("read.any"), 3);
	assert.equal(shared.get("shell.read"), 3);
	assert.equal(shared.get("git.read"), 3);
	assert.equal(shared.get("git.branch"), 3);
	assert.equal(shared.get("todo"), 3);
	assert.equal(shared.get("write.own-notes"), 2);
	assert.equal(shared.get("shell.sudo.deny"), 2);
	assert.equal(shared.get("git.fetch.ask"), 1);
	assert.equal(shared.get("git.fetch.deny"), 2);
	assert.equal(shared.get("file.remove.ask"), 2);
	assert.equal(shared.get("git.remove.ask"), 2);
});

test("every row reaches a class set and every flag class is used", () => {
	const { classes } = compileTable(RULE_ROWS);
	// One rule per tool name a row lists. These counts are pinned literals, so a
	// fault in the `rowsForClass` filter cannot agree with itself here.
	const pinned: Record<PermissionClass, number> = { reader: 51, worker: 61, orchestrator: 68 };
	for (const cls of PERMISSION_CLASSES) {
		assert.equal(ruleCount(classes[cls]), pinned[cls], cls);
	}
	const used = new Set<string>(RULE_ROWS.map((row) => row.flags ?? "none"));
	for (const flags of FLAG_CLASSES) {
		assert.ok(used.has(flags) || TAIL_ONLY_CLASSES.includes(flags), `flag class ${flags} is unreachable`);
	}
});

// --- compiled shape ---------------------------------------------------------

test("the compiler produces the five rule sets the engine consumes", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const cls of PERMISSION_CLASSES) {
		const sets = classes[cls];
		assert.deepEqual(Object.keys(sets).sort(), RULE_SET_KEYS);
		assert.ok(ruleCount(sets) > 0);
		for (const rules of Object.values(sets)) {
			for (const rule of rules) {
				assert.equal(typeof rule.tool, "string");
				assert.equal(typeof rule.match, "string");
				assert.ok(rule.match.length > 0);
				assert.equal(typeof rule.reason, "string");
				// Every pattern must compile under the engine's flags.
				assert.doesNotThrow(() => new RegExp(rule.match, "i"));
			}
		}
	}
});

test("every row carries a one-line reason and never a pattern", () => {
	for (const row of RULE_ROWS) {
		assert.ok(row.reason.length > 0);
		assert.ok(!row.reason.includes("\n"));
		assert.ok(!row.reason.includes("\\"));
	}
});

test("a class-only allow row does not leak into another class", () => {
	const { classes } = compileTable(RULE_ROWS);
	assert.equal(allowMatches(classes.worker, "bash", "cargo build"), true);
	assert.equal(allowMatches(classes.reader, "bash", "cargo build"), false);
	assert.equal(allowMatches(classes.orchestrator, "bash", "cargo build"), false);
	assert.equal(allowMatches(classes.orchestrator, "bash", "cargo nextest"), true);
	assert.equal(allowMatches(classes.reader, "write", "src/main.rs"), false);
	assert.equal(allowMatches(classes.orchestrator, "write", "src/main.rs"), true);
});

test("the tree update row names one verb and both flags, and nothing else", () => {
	const row = RULE_ROWS.find((item) => item.id === "git.history.read-tree-reset");
	assert.ok(row !== undefined, "the tree update row is missing");
	assert.deepEqual(row.classes, ["orchestrator"]);
	assert.equal(row.verdict, "allow");
	assert.deepEqual(row.verb, ["git"]);
	for (const probe of ["git read-tree --reset -u HEAD", "git read-tree -u --reset HEAD"]) {
		assert.equal(rowMatches("git.history.read-tree-reset", probe), true, probe);
	}
	// The row names one verb, so a bare form, a single flag, and every other
	// tree verb stay outside it.
	for (const probe of [
		"git read-tree",
		"git read-tree --reset HEAD",
		"git read-tree -u HEAD",
		"git reset --soft HEAD~1",
		"git checkout main",
		"git restore .",
		"git stash",
	]) {
		assert.equal(rowMatches("git.history.read-tree-reset", probe), false, probe);
	}
});

test("the ten analysis tools allow for every class and the write tools stay denied", () => {
	for (const cls of PERMISSION_CLASSES) {
		const sets = compileClass(RULE_ROWS, cls);
		for (const tool of ANALYSIS_TOOLS) {
			assert.equal(verdictOf(sets, tool, "{}"), "allow", `${cls}: ${tool}`);
		}
		for (const tool of ANALYSIS_WRITE_TOOLS) {
			assert.equal(allowMatches(sets, tool, "{}"), false, `${cls}: ${tool} must not allow`);
			// No row names the tool, so deny-by-default closes it for every role.
			assert.equal(verdictOf(sets, tool, "{}"), "none", `${cls}: ${tool} must carry no rule`);
		}
	}
	for (const role of ROLES) {
		for (const tool of ANALYSIS_TOOLS) {
			assert.equal(gateVerdict(role, tool, "{}"), "allow", `${role}: ${tool}`);
		}
		for (const tool of ANALYSIS_WRITE_TOOLS) {
			assert.equal(gateVerdict(role, tool, "{}"), "deny", `${role}: ${tool}`);
		}
	}
});

// --- one home for the class vocabulary --------------------------------------

/**
 * `permission-class.ts` is the only module that declares the class union and the
 * class list. A second declaration lets two modules disagree about one class.
 */
test("only permission-class.ts declares the class union or the class list", () => {
	const dir = new URL(".", import.meta.url);
	const typeAlias = /(?:export\s+)?type\s+\w+\s*=\s*([^;]*);/g;
	const list = /(?:export\s+)?const\s+PERMISSION_CLASSES\b/;
	const found: string[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".ts") || name === "permission-class.ts") continue;
		const text = readFileSync(new URL(name, dir), "utf8");
		const union = [...text.matchAll(typeAlias)].some((match) =>
			PERMISSION_CLASSES.every((cls) => (match[1] as string).includes(`"${cls}"`)),
		);
		if (union || list.test(text)) found.push(name);
	}
	assert.deepEqual(found, [], `a second class declaration lives in ${found.join(", ")}`);
});

// --- the engine files are untouched -----------------------------------------

test("the compiler imports the engine types only, never a value from them", () => {
	const source = readFileSync(new URL("./permission-table.ts", import.meta.url), "utf8");
	const imports = source.split("\n").filter((line) => line.startsWith("import ") && line.includes("command-segments.ts"));
	assert.equal(imports.length, 1);
	assert.ok(imports[0].startsWith("import type "), "the compiler must import types only");
});
