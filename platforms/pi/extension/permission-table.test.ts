/**
 * Tests for the permission rule table and its compiler shape.
 *
 * The file holds the table shape, the compiler refusals, the parity ledger, and
 * the count assertions; the gate verdict cases live in permission-table.gate.test.ts.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	FLAG_CLASSES,
	ROLE_NOTES,
	TAIL_ONLY_CLASSES,
	compileClass,
	compileRole,
	compileTable,
	countTable,
	rowsForClass,
	rowsForGroup,
	roleZone,
	validateRows,
	type RuleRow,
} from "./permission-table.ts";
import {
	PERMISSION_CLASSES,
	ROLE_CLASS,
	isPermissionClass,
	type PermissionClass,
	type Role,
} from "./permission-class.ts";
import { RULE_ROWS } from "./permissions.table.ts";
import { compileGateSource } from "./permissions.ts";
import type { AgentConfig } from "./resolver.ts";
import {
	DELETIONS,
	FRONTMATTER_ENTRY_COUNT,
	GLOBAL_ENTRY_COUNT,
	LEGACY,
	LEGACY_COUNTS,
	ROW_RATIONALE,
} from "./permission-table.parity.ts";
import {
	ANALYSIS_WRITE_TOOLS,
	FIXTURE_ROOT,
	ROLES,
	RULE_SET_KEYS,
	allowMatches,
	denyMatches,
	gateVerdict,
	rowMatches,
	rowReason,
	ruleCount,
	sourceDecision,
	verdictOf,
} from "./permission-table.test-helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FRONTMATTER_DIR = path.join(repoRoot, "platforms", "pi", "frontmatters");
/**
 * The live global permission file is unversioned, and the install notes tell the
 * owner to clean it, so the test never reads it by default and never hardcodes a
 * home path. Set `PI_TEST_READ_GLOBAL_PERMISSIONS=1` to opt in; the path comes
 * from the home directory call.
 */
const GLOBAL_FILE = process.env.PI_TEST_READ_GLOBAL_PERMISSIONS
	? path.join(homedir(), ".pi", "agent", "permissions.json")
	: null;

type Section = "allow" | "ask" | "deny";
const SECTIONS: readonly Section[] = ["allow", "ask", "deny"];

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

test("the table holds 87 rows: 22 global, 15 reader, 22 worker, 28 orchestrator", () => {
	const counts = countTable(RULE_ROWS);
	assert.equal(counts.total, 87);
	assert.equal(counts.byGroup.global, 22);
	assert.equal(counts.byGroup.reader, 15);
	assert.equal(counts.byGroup.worker, 22);
	assert.equal(counts.byGroup.orchestrator, 28);
});

test("every class resolves to 36, 44, and 50 rows", () => {
	const counts = countTable(RULE_ROWS);
	assert.equal(counts.byClass.reader, 36);
	assert.equal(counts.byClass.worker, 44);
	assert.equal(counts.byClass.orchestrator, 50);
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

test("the 87 rows carry 62 ids: a shared rule is one row per class", () => {
	// One id is one rule. A rule that three classes share is three rows with one
	// id, so the id count is the number of distinct rules, not of rows.
	assert.equal(countTable(RULE_ROWS).uniqueIds, 62);
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
	const pinned: Record<PermissionClass, number> = { reader: 51, worker: 61, orchestrator: 67 };
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

// --- refused rows -----------------------------------------------------------

function bashRow(over: Partial<RuleRow> = {}): RuleRow {
	return {
		id: "probe.row",
		tool: "bash",
		verdict: "deny",
		classes: ["reader"],
		verb: ["echo"],
		arg: "any",
		reason: "probe row",
		...over,
	};
}

function probeRow(over: Partial<RuleRow> = {}): RuleRow {
	return {
		id: "probe.shape",
		tool: "bash",
		verdict: "deny",
		classes: ["reader"],
		probe: "stream-write",
		arg: "any",
		reason: "probe shape",
		...over,
	};
}

test("an unknown field fails the load and names the row", () => {
	const row = { ...bashRow(), pattern: "x" } as unknown as RuleRow;
	assert.throws(() => validateRows([row]), /probe\.row.*unknown field "pattern"/);
});

test("a row that names an unknown profession fails the load and names the row", () => {
	assert.throws(
		() => validateRows([bashRow({ roles: ["captain"] as unknown as Role[] })]),
		/probe\.row.*unknown profession "captain"/,
	);
	assert.throws(
		() => validateRows([bashRow({ classes: ["worker"], roles: ["planner"] })]),
		/probe\.row.*profession "planner" is outside the row's classes/,
	);
});

test("a forbidden regex character fails the load and names the row", () => {
	assert.throws(() => validateRows([bashRow({ verb: ["rm|sh"] })]), /probe\.row.*forbidden regex character/);
	assert.throws(() => validateRows([bashRow({ sub: ["a.*b"] })]), /probe\.row.*forbidden regex character/);
	assert.throws(() => validateRows([bashRow({ verb: ["(cat)"] })]), /probe\.row.*forbidden regex character/);
});

test("a regex character in a verb or a dotted tool name fails the load", () => {
	// A dot is data and the compiler escapes it: `checkout -- .` is a legal sub.
	assert.doesNotThrow(() => validateRows([bashRow({ sub: ["checkout -- ."] })]));
	assert.throws(() => validateRows([bashRow({ verb: ["foo|bar"] })]), /probe\.row.*forbidden regex character/);
	assert.throws(() => validateRows([bashRow({ verb: ["foo.bar*"] })]), /probe\.row.*forbidden regex character/);
	assert.throws(() => validateRows([bashRow({ tool: "bash.x" })]), /probe\.row.*plain lower-case name/);
});

test("an ask row with flags any and no span fails the load", () => {
	assert.throws(
		() => validateRows([bashRow({ verdict: "ask", flags: "any" })]),
		/probe\.row.*must set span/,
	);
	assert.doesNotThrow(() => validateRows([bashRow({ verdict: "ask", flags: "any", span: true })]));
});

test("unnamed must be a boolean on a roles row", () => {
	assert.doesNotThrow(() =>
		validateRows([bashRow({ classes: ["worker"], roles: ["implementer"], unnamed: true })]),
	);
	assert.throws(
		() => validateRows([bashRow({ classes: ["worker"], roles: ["implementer"], unnamed: "yes" as never })]),
		/probe\.row.*unnamed must be a boolean/,
	);
	// A false value widens nothing, so the schema refuses it instead of ignoring it.
	assert.throws(
		() => validateRows([bashRow({ classes: ["worker"], roles: ["implementer"], unnamed: false })]),
		/probe\.row.*omit a false value/,
	);
	// A row with no `roles` already joins the class compile, so unnamed is empty.
	assert.throws(() => validateRows([bashRow({ unnamed: true })]), /probe\.row.*must name roles/);
});

test("a probe row must be a deny row and carries no verb", () => {
	assert.doesNotThrow(() => validateRows([probeRow()]));
	assert.throws(() => validateRows([probeRow({ verdict: "ask" })]), /probe\.shape.*must be a deny row/);
	assert.throws(() => validateRows([probeRow({ verb: ["tee"] })]), /probe\.shape.*carries no verb/);
	assert.throws(() => validateRows([probeRow({ probe: "unknown" as never })]), /probe\.shape.*unknown probe/);
});

test("two rows with one id and two verdicts fail the load and name the row", () => {
	const deny = bashRow();
	const allow = bashRow({ verdict: "allow", classes: ["worker"] });
	assert.throws(() => validateRows([deny, allow]), /probe\.row.*conflicting verdict/);
});

test("two rows with one id and two geometries fail the load and name the row", () => {
	const first = bashRow();
	const second = bashRow({ verb: ["printf"] });
	assert.throws(() => validateRows([first, second]), /probe\.row.*conflicting geometry/);
	const third = bashRow({ reason: "another sentence" });
	assert.throws(() => validateRows([first, third]), /probe\.row.*conflicting geometry/);
});

test("a shared id with the same verdict and geometry is accepted", () => {
	assert.doesNotThrow(() => validateRows([bashRow(), bashRow({ classes: ["orchestrator"] })]));
});

// --- parity ledger ----------------------------------------------------------

function sectionOf(entry: string): string {
	return entry.split("/")[1] ?? "";
}

/**
 * The legacy keys, built from the recorded shape of the frontmatter lists. The
 * live frontmatters are not parsed: they carry no rule list once the class line
 * replaces the `permissions:` block.
 */
function sourceKeys(): string[] {
	const keys: string[] = [];
	let frontmatter = 0;
	for (const role of ROLES) {
		const counts = LEGACY_COUNTS[role];
		assert.ok(counts, `${role} has no recorded legacy count`);
		for (const section of SECTIONS) {
			for (let i = 1; i <= counts[section]; i++) keys.push(`${role}/${section}/${i}`);
			frontmatter += counts[section];
		}
	}
	assert.equal(frontmatter, FRONTMATTER_ENTRY_COUNT);

	// The global file is unversioned. The ledger covers its 17 entries from the
	// recorded shape. The live file is a cross-check only under the opt-in
	// variable, because the recorded shape is the contract.
	const deny = 6;
	const ask = GLOBAL_ENTRY_COUNT - deny;
	for (let i = 1; i <= deny; i++) keys.push(`global/deny/${i}`);
	for (let i = 1; i <= ask; i++) keys.push(`global/ask/${i}`);

	if (GLOBAL_FILE !== null && existsSync(GLOBAL_FILE)) {
		const cfg = JSON.parse(readFileSync(GLOBAL_FILE, "utf8")) as {
			deny?: unknown[];
			ask?: unknown[];
		};
		assert.equal(cfg.deny?.length ?? 0, deny, "the live global deny count moved");
		assert.equal(cfg.ask?.length ?? 0, ask, "the live global ask count moved");
	}
	return keys;
}

test("the recorded legacy counts are the ledger key space", () => {
	const keys = sourceKeys();
	assert.equal(keys.length, GLOBAL_ENTRY_COUNT + FRONTMATTER_ENTRY_COUNT);
	assert.equal(new Set(keys).size, keys.length);
});

test("the parity ledger maps every legacy entry exactly once", () => {
	const keys = sourceKeys();
	const seen = new Map<string, (typeof LEGACY)[number]>();
	for (const record of LEGACY) {
		assert.ok(!seen.has(record.entry), `entry mapped twice: ${record.entry}`);
		seen.set(record.entry, record);
	}
	for (const key of keys) {
		assert.ok(seen.has(key), `unaccounted entry: ${key}`);
	}
	assert.equal(seen.size, keys.length, "the ledger holds an entry the sources do not");
});

test("every ledger target is one row id or one named deletion", () => {
	const rowIds = new Set(RULE_ROWS.map((row) => row.id));
	for (const record of LEGACY) {
		const names = [record.row, record.del].filter((value) => value !== undefined);
		assert.equal(names.length, 1, `${record.entry} must name exactly one row or one deletion`);
		if (record.row !== undefined) {
			assert.ok(rowIds.has(record.row), `${record.entry} names an unknown row ${record.row}`);
		}
		if (record.del !== undefined) {
			assert.ok(record.del in DELETIONS, `${record.entry} names an unknown deletion ${record.del}`);
		}
		for (const split of record.split ?? []) {
			assert.ok(rowIds.has(split), `${record.entry} splits into an unknown row ${split}`);
			assert.notEqual(split, record.row, `${record.entry} splits into its own row ${split}`);
		}
		if (record.note !== undefined) {
			assert.ok(record.note.length > 0 && !record.note.includes("\n"), `${record.entry} note must be one line`);
		}
	}
});

test("a deny entry never resolves to a weaker verdict", () => {
	const rows = new Map<string, RuleRow>();
	for (const row of RULE_ROWS) if (!rows.has(row.id)) rows.set(row.id, row);
	// A deletion keeps the form closed: a fall-through denies, and a narrower
	// allow set denies. The mascot carries no bash tool at all.
	const closed = new Set(["del-unreachable-fence", "del-narrowed-allow", "del-mascot-tool"]);
	for (const record of LEGACY) {
		if (sectionOf(record.entry) !== "deny") continue;
		if (record.row !== undefined) {
			assert.equal(rows.get(record.row)?.verdict, "deny", `${record.entry} maps to the row ${record.row}`);
		} else {
			assert.ok(closed.has(record.del ?? ""), `${record.entry} maps to the deletion ${record.del}`);
		}
	}
});

test("a legacy entry that named push and pull records both rows", () => {
	const splitEntries: readonly [string, Role][] = [
		["implementer/deny/4", "implementer"],
		["tester/deny/4", "tester"],
		["reviewer/deny/4", "reviewer"],
		["researcher/deny/4", "researcher"],
	];
	for (const [entry, role] of splitEntries) {
		const record = LEGACY.find((item) => item.entry === entry);
		assert.ok(record, `${entry} is missing from the ledger`);
		assert.equal(record.row, "release.deny");
		assert.deepEqual(record.split, ["history.deny"]);
		const sets = compileRole(RULE_ROWS, role);
		assert.equal(denyMatches(sets, "bash", "git push"), true, `${role} push`);
		assert.equal(denyMatches(sets, "bash", "git pull"), true, `${role} pull`);
	}
});

test("every deletion carries a one-line reason and is used by an entry", () => {
	const used = new Set<string>();
	for (const record of LEGACY) if (record.del !== undefined) used.add(record.del);
	for (const [id, reason] of Object.entries(DELETIONS)) {
		assert.ok(id.startsWith("del-"), `deletion id ${id} must start with del-`);
		assert.ok(reason.length > 0, `${id} has no reason`);
		assert.ok(!reason.includes("\n"), `${id} has a multi-line reason`);
		assert.ok(used.has(id), `${id} is defined but no entry uses it`);
	}
	for (const id of used) assert.ok(id in DELETIONS, `entry names an unknown deletion ${id}`);
});

test("every row has a source entry or a stated reason", () => {
	const rowIds = new Set(RULE_ROWS.map((row) => row.id));
	const sourced = new Set<string>(Object.keys(ROW_RATIONALE));
	for (const record of LEGACY) {
		if (record.row !== undefined) sourced.add(record.row);
		for (const split of record.split ?? []) sourced.add(split);
	}
	for (const id of rowIds) {
		assert.ok(sourced.has(id), `row ${id} has no source entry and no stated reason`);
	}
	for (const id of sourced) {
		assert.ok(rowIds.has(id), `the ledger names a row the table does not hold: ${id}`);
	}
});

test("every role maps to a class and to a notes zone decision", () => {
	for (const role of ROLES) {
		assert.ok(role in ROLE_CLASS, `${role} has no class`);
		assert.ok(role in ROLE_NOTES, `${role} has no notes zone decision`);
		const sets = compileRole(RULE_ROWS, role);
		assert.deepEqual(Object.keys(sets).sort(), RULE_SET_KEYS);
	}
});

test("the class list and its membership test accept only the three classes", () => {
	assert.deepEqual([...PERMISSION_CLASSES], ["reader", "worker", "orchestrator"]);
	for (const cls of PERMISSION_CLASSES) assert.ok(isPermissionClass(cls), `${cls} is a class`);
	assert.ok(!isPermissionClass("admin"), "an unknown name is not a class");
});

test("a role zone accepts a profession and refuses an unknown role", () => {
	assert.deepEqual(roleZone("planner"), { role: "planner" });
	assert.throws(() => roleZone("ghost" as Role), /unknown role "ghost"/);
});

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

// --- the frontmatter migration ----------------------------------------------

function frontmatterText(role: Role): string {
	return readFileSync(path.join(FRONTMATTER_DIR, `${role}.yaml`), "utf8");
}

/**
 * The rule table is the only pi rule store: no frontmatter carries a rule list,
 * and every frontmatter names the class its profession belongs to. This is the
 * end state the migration must reach, so a rule list cannot come back.
 */
test("no pi frontmatter carries a permissions block, and every role names its class", () => {
	for (const role of ROLES) {
		const text = frontmatterText(role);
		assert.equal(/^permissions:/m.test(text), false, `${role} still carries a permissions block`);
		const line = /^permissionClass:\s*(\S+)\s*$/m.exec(text);
		assert.ok(line !== null, `${role} must carry a permissionClass line`);
		assert.ok(PERMISSION_CLASSES.includes(line[1] as PermissionClass), `${role} names an unknown class ${line[1]}`);
		assert.equal(line[1], ROLE_CLASS[role], `${role} names a class that differs from the role table`);
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
